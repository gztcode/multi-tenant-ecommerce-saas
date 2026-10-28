import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { COMPENSATION_QUEUE } from '../../common/queue/queue.constants';
import {
  platformScope,
  runForTenant,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { OrderTimeoutService } from '../order/order-timeout.service';
import { QueueService } from '../queue/queue.service';
import { PaymentService } from './payment.service';
import { NormalizedWebhookEvent } from './payment-provider.interface';

/** 补偿扫描的周期（毫秒）。默认 10 分钟 */
const COMPENSATION_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 事件「够老」的门槛（毫秒）。默认 5 分钟。
 *
 * ⚠️ **不能是 0**：刚落库的事件可能正在被消费端处理。
 */
const EVENT_STALE_MS = 5 * 60 * 1000;

/** 单轮最多处理多少条 —— 防一次扫太多把队列打爆 */
const MAX_PER_ROUND = 100;

/**
 * 支付补偿扫描（阶段 5f Task 3）。
 *
 * ## 它兜的是哪两个洞
 *
 * 1. **未处理完的 webhook 事件**：`PaymentService.insertEvent` 的
 *    「`processedAt` 为 null → 允许重试」分支只在**渠道重投**时才有意义。
 *    而渠道的重投有次数与时间窗 —— 超出就不重投了。
 *    平台自己扫一遍才是**最后的兜底**。
 *
 * 2. **丢失的超时释放**：超时释放是靠**队列里的 delayed job** 做的
 *    （下单后投一个 15 分钟后的任务）。投递失败时没人知道 →
 *    订单永远卡在待支付、库存永久卡在预占。
 *
 * ## 扫描在平台作用域下做，写操作回到租户作用域
 *
 * 扫描要跨租户（所有租户的订单与事件），所以跑在 `platformScope()` 下；
 * 真正的写操作（释放订单）要逐条用 `runForTenant` 切回租户作用域 ——
 * `OrderTimeoutService` 查的是租户作用域的 `Order`，没有上下文会抛
 * `TenantScopeError`。
 */
@Injectable()
export class CompensationService implements OnModuleInit {
  private readonly logger = new Logger(CompensationService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queue: QueueService,
    private readonly payments: PaymentService,
    private readonly orderTimeout: OrderTimeoutService,
  ) {}

  /**
   * 注册补偿扫描的周期性任务。
   *
   * ⚠️ **固定 jobSchedulerId**：`payment-compensation`。BullMQ 的作业调度器按它去重，
   * 重复注册是覆盖而不是叠加 —— 否则每次重启应用都会多一个扫描任务。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      COMPENSATION_QUEUE,
      'compensate',
      {},
      COMPENSATION_INTERVAL_MS,
      'payment-compensation',
    );
  }

  /**
   * 把「上次没处理完」的 webhook 事件重新入队。
   *
   * ⚠️ **为什么需要它**：`insertEvent` 的「`processedAt` 为 null → 允许重试」
   * 分支只在**渠道重投**时才有意义（Task 1 保证渠道会重投）。
   * 但渠道的重投有次数与时间窗 —— 超出就不重投了。
   * 平台自己扫一遍才是最后的兜底。
   *
   * ⚠️ **每条独立 try/catch**：一条失败不能带倒整轮扫描。
   *
   * ⚠️ **重投前要重做金额核对**：`checkWebhookEvent` 会重新核对金额，
   * 金额不符的事件**不该**被重投 —— 那正是「付 1 分钱买 100 元商品」
   * 的入口。
   */
  async retryUnprocessedEvents(): Promise<{
    /** 扫到的未处理事件数 */
    scanned: number;
    /** 重新入队的条数 */
    requeued: number;
    /** 核对不通过（金额不符 / 找不到业务单）的条数 */
    rejected: number;
    /** 单条处理抛异常的条数 */
    failed: number;
  }> {
    const now = await this.prisma.databaseNow();
    const staleBefore = new Date(now.getTime() - EVENT_STALE_MS);

    // ⚠️ **轮次标记**：同一事件每轮一个 jobId。
    //
    // BullMQ 里 **failed job 的 hash 还在** → 用同一个 jobId 重新入队会被
    // **静默忽略**（`addJob` 的 Lua 脚本按 jobId 查存在性）→ 补偿等于没做。
    //
    // ⚠️ **每轮换 jobId 会让队列堆积**——但这是可接受的：
    // 消费端幂等兜底（`applyEvent` 的状态流转是条件更新），
    // 且单轮有 `MAX_PER_ROUND` 限量。
    const roundTag = String(now.getTime());

    // ⚠️ **平台作用域下扫** —— 要找所有租户的未处理事件
    //
    // ⚠️ **回调必须是 async 函数**：Prisma 6 的 query 返回 PrismaPromise
    // （thenable 而非原生 Promise），同步回调会让上下文在 SQL 执行时丢失。
    const rows = await tenantContext.run(platformScope(), async () =>
      this.prisma.paymentWebhookEvent.findMany({
        where: { processedAt: null, createdAt: { lt: staleBefore } },
        take: MAX_PER_ROUND,
      }),
    );

    let requeued = 0;
    let rejected = 0;
    let failed = 0;

    for (const row of rows) {
      // ⚠️ **一条失败不能带倒整轮扫描**
      try {
        const event = this.eventFromRow(row);
        if (!event) {
          rejected++;
          continue;
        }

        // ⚠️ **重做核对**（金额 / 业务单是否存在）
        const check = await this.payments.checkWebhookEvent(event, row.kind);
        if (!check.accepted || !check.tenantId) {
          rejected++;
          continue;
        }

        // ⚠️ **jobId 带轮次标记** —— 换个 jobId 才能绕开 failed job 的残留
        await this.payments.enqueueWebhookEvent(
          event,
          check.tenantId,
          row.kind,
          `-comp-${roundTag}`,
        );
        requeued++;
      } catch (error) {
        failed++;
        this.logger.warn(
          `补偿重投事件失败：provider=${row.provider} eventId=${row.eventId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return { scanned: rows.length, requeued, rejected, failed };
  }

  /**
   * 补释放「已过支付期限但订单还卡在待支付」的订单。
   *
   * ⚠️ **为什么需要它**：超时释放是靠**队列里的 delayed job** 做的
   * （下单后投一个 15 分钟后的任务）。投递失败时没人知道 →
   * 订单永远卡在待支付、库存永久卡在预占。
   *
   * ⚠️ **与队列里的 job 重复执行**：幂等靠
   * `releaseExpiredOrderInTx` 里 `transitionInTx(PENDING_PAYMENT → CLOSED)`
   * 的条件更新 —— 两边只有一个赢 ✅
   */
  async releaseStuckOrders(): Promise<{
    /** 扫到的卡住的订单数 */
    scanned: number;
    /** 本次真的释放了的订单数 */
    released: number;
    /** 单条处理抛异常的条数 */
    failed: number;
  }> {
    const now = await this.prisma.databaseNow();

    // ⚠️ **平台作用域下扫** —— 要找所有租户的卡单
    const orders = await tenantContext.run(platformScope(), async () =>
      this.prisma.order.findMany({
        where: {
          status: OrderStatus.PENDING_PAYMENT,
          payExpiresAt: { lt: now },
        },
        take: MAX_PER_ROUND,
      }),
    );

    let released = 0;
    let failed = 0;

    for (const order of orders) {
      try {
        // ⚠️ **必须在该订单的租户上下文里调** ——
        // `releaseExpiredOrder` 查的是租户作用域的 `Order`，
        // 没有上下文会抛 `TenantScopeError`。
        //
        // ⚠️ **租户 id 来自库里**（可信源），不是客户端提交的。
        const done = await runForTenant(order.tenantId, async () =>
          this.orderTimeout.releaseExpiredOrder(order.id),
        );
        if (done) {
          released++;
        }
      } catch (error) {
        failed++;
        this.logger.warn(
          `补偿释放订单失败：订单 ${order.orderNo}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return { scanned: orders.length, released, failed };
  }

  /**
   * 从事件行还原出归一化事件。
   *
   * ⚠️ **payload 的形状由 `insertEvent` 决定**（`channel` / `referenceNo` /
   * `amount` / `success`）。字段缺失或类型不对时返回 null ——
   * 宁可少投一条，也不能把一个**结构不对**的事件投进队列
   * （消费端会拿到 `amount: undefined`，金额核对必然不过，
   * 白白在队列里滚一圈）。
   */
  private eventFromRow(row: {
    provider: string;
    eventId: string;
    providerTxnId: string | null;
    payload: unknown;
  }): NormalizedWebhookEvent | null {
    if (
      typeof row.payload !== 'object' ||
      row.payload === null ||
      Array.isArray(row.payload)
    ) {
      return null;
    }
    const payload = row.payload as Record<string, unknown>;
    const referenceNo = payload.referenceNo;
    const amount = payload.amount;
    const success = payload.success;
    const channel = payload.channel;
    if (
      typeof referenceNo !== 'string' ||
      typeof amount !== 'number' ||
      typeof success !== 'boolean' ||
      typeof channel !== 'string'
    ) {
      return null;
    }
    return {
      provider: row.provider,
      channel,
      eventId: row.eventId,
      // ⚠️ 事件行的 `providerTxnId` 可空，而归一化事件要求字符串
      providerTxnId: row.providerTxnId ?? '',
      referenceNo,
      amount,
      success,
    };
  }
}
