import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { OrderService } from './order.service';

/**
 * 超时释放任务的数据。
 *
 * ⚠️ `tenantId` **必须来自可信源**（下单时后端签发），绝不能取自
 * 客户端提交的内容——否则「重建租户上下文」本身就成了越权通道。
 */
export interface OrderTimeoutJob {
  /** 订单所属租户 id */
  tenantId: string;
  orderId: string;
}

/**
 * 支付超时释放服务（阶段 3 Task 6）。
 *
 * 职责：把「超时未支付」的订单关掉，并把预占的库存还回去。
 *
 * ## 三条硬性要求
 *
 * 1. **必须用条件更新**（`status = 'PENDING_PAYMENT'` 放进 where），
 *    靠受影响行数判定谁赢了。
 * 2. **条件更新与释放预占必须在同一个事务里**。
 * 3. **必须判订单自己的 `payExpiresAt`**——队列的 delayed job 不保证准时。
 *
 * 理由见各处的注释。
 */
@Injectable()
export class OrderTimeoutService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly order: OrderService,
  ) {}

  /**
   * 释放一个超时未支付的订单。
   *
   * @returns true = 本次真的关闭了订单并释放了预占；
   *          false = 不用管（已支付 / 已取消 / 还没到支付期限 / 订单不存在）
   */
  async releaseExpiredOrder(orderId: string): Promise<boolean> {
    // ⚠️ **条件更新与释放预占在同一个事务里**。
    //
    // 分成两个事务的话：订单先转成 CLOSED，释放预占再失败
    // （预占量对不上、锁超时）——而超时释放任务看到状态不是
    // PENDING_PAYMENT 也不会再管它，那批库存就**永久卡在预占里**，
    // 再也回不到可售库存。
    //
    // 事务超时设成 10 秒（Prisma 默认只有 5 秒）：行锁等待会占掉这个预算。
    return this.prisma.$transaction(
      async (tx) => this.releaseExpiredOrderInTx(tx, orderId),
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * 在**调用方的事务内**释放一个超时未支付的订单。
   */
  async releaseExpiredOrderInTx(
    tx: PrismaTransaction,
    orderId: string,
  ): Promise<boolean> {
    const now = new Date();

    // ---- 1. 判支付期限 ----
    //
    // ⚠️ **队列的 delayed job 不保证准时**，所以不能依赖它的准时性：
    // 订单自己的 `payExpiresAt` 也要判。提前触发的任务不能把还在
    // 支付窗口内的订单关掉。
    //
    // ⚠️ 这一步**只读一个创建后就不会再变的字段**（`payExpiresAt`），
    // 所以「先读后判」在这里是安全的——并发正确性完全由下面第 2 步的
    // 条件更新保证，与本次读无关。
    const order = await tx.order.findFirst({
      where: { id: orderId },
      select: { payExpiresAt: true },
    });
    if (!order) {
      return false;
    }
    if (order.payExpiresAt && order.payExpiresAt.getTime() > now.getTime()) {
      // 还没到支付期限，什么都不做
      return false;
    }

    // ---- 2. 条件更新订单：PENDING_PAYMENT → CLOSED ----
    //
    // ⚠️ **绝不能「先 findFirst 查状态，再 update」**——两个并发事务
    // （支付回调与超时释放）会都读到同一个旧状态然后都往下走。
    // 必须是条件更新：把状态放进 where 里，靠受影响行数判定谁赢了。
    //
    // 具体的失效场景：支付回调与超时释放并发时，两者都读到
    // `PENDING_PAYMENT` 就会都往下走——结果是**已支付但库存被还回去**
    // （超卖）。两处更新用同一个 `status = 'PENDING_PAYMENT'` 条件，
    // 数据库保证只有一方能赢。
    const won = await this.order.transitionInTx(
      tx,
      orderId,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.CLOSED,
      { closedAt: now },
    );
    if (!won) {
      // 已经支付 / 已取消 / 已被别的任务关掉了——什么都不做
      return false;
    }

    // ---- 3. 赢了才释放预占 ----
    //
    // ⚠️ **顺序不能换**：先释放再改状态的话，释放成功但改状态失败，
    // 库存就还回去了而订单还在 PENDING_PAYMENT——用户能拿一个
    // 「库存已经还回去」的订单去支付，白赚一件。
    await this.order.releaseReservationInTx(tx, orderId);

    return true;
  }
}
