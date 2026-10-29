import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, ReceiptType } from '@prisma/client';

import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import type { CommissionOrderSnapshot } from './commission.service';

/**
 * 商家应收货款流水的写入与查询（阶段 5h-1）。
 *
 * ⚠️ **与 `CommissionService` 完全同款**，只是金额基数不同：
 * 抽佣流水记的是「平台抽了多少」（`order.commissionAmount`），
 * 货款流水记的是「商家该收多少」（`order.totalAmount`）。
 *
 * ⚠️ **为什么要有这张表**：出款的应结金额 = 货款净额 − 佣金净额，
 * 两边都要能追溯到具体单据。从订单现算的话，跨期退款时
 * 上期已出款的金额无法回溯修正（口径会漂）。
 */

/** 订单快照（写入货款流水只需要这些字段） */
export type ReceiptOrderSnapshot = Pick<
  CommissionOrderSnapshot,
  'id' | 'tenantId' | 'orderNo' | 'totalAmount'
>;

/**
 * 一条历史订单要不要回填货款流水。
 *
 * ⚠️ **零额判定看 `totalAmount`，不是 `commissionAmount`** ——
 * 抽佣的判定（`shouldBackfillCommission`）看的是抽佣额，
 * 费率 0 的订单**有货款、无抽佣**，货款那一行必须记。
 *
 * @param paidAt 支付时间。null = 没付过钱
 * @param totalAmount 实付（整数分）
 */
export function shouldBackfillReceipt(
  paidAt: Date | null,
  totalAmount: number,
): boolean {
  // ⚠️ **没付过钱 → 没有货款**（与报表只看 paidAt 一致）
  if (!paidAt) {
    return false;
  }
  // ⚠️ **零额不记** —— 表里全是 0 没意义
  if (totalAmount === 0) {
    return false;
  }
  return true;
}

/**
 * 一条历史订单要不要回填货款冲回流水。
 *
 * ⚠️ **`refundedAt` 为 null 的已退款订单一律跳过** ——
 * 5b 之前退的款没记时间，**冲回无法归期**。与抽佣的判定同款口径。
 *
 * @param refunded 订单是否已退款
 * @param refundedAt 退款时间。null = 5b 之前退的款
 * @param totalAmount 实付（整数分）
 */
export function shouldBackfillReceiptReversal(
  refunded: boolean,
  refundedAt: Date | null,
  totalAmount: number,
): boolean {
  if (!refunded) {
    return false;
  }
  if (!refundedAt) {
    return false;
  }
  if (totalAmount === 0) {
    return false;
  }
  return true;
}

/** 一行货款流水的写入内容 */
interface ReceiptEntryData {
  tenantId: string;
  orderId: string;
  orderNo: string;
  type: ReceiptType;
  amount: number;
  occurredAt: Date;
}

/** 回填的结果计数 */
export interface ReceiptBackfillResult {
  /** 新建的货款流水行数 */
  receiptCreated: number;
  /** 新建的货款冲回流水行数 */
  reversalCreated: number;
  /** 因货款额为 0 而跳过的订单数 */
  skippedZeroAmount: number;
  /** 因已退款但 `refundedAt` 为空（5b 之前退的款）而跳过的订单数 */
  skippedUndatedRefund: number;
}

@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 记一笔货款（支付成功时）。
   *
   * ⚠️ **幂等**：靠 `@@unique([orderId, type])` + 「先查后插」。
   *
   * ⚠️ **零额不记**：实付 0 的订单不产生流水行。
   *
   * @param occurredAt 支付时间（用**数据库的时钟**，与订单的 `paidAt` 同源）
   */
  async recordReceiptInTx(
    tx: PrismaTransaction,
    order: ReceiptOrderSnapshot,
    occurredAt: Date,
  ): Promise<void> {
    if (order.totalAmount === 0) {
      return;
    }

    await this.insertEntryInTx(tx, {
      tenantId: order.tenantId,
      orderId: order.id,
      orderNo: order.orderNo,
      type: ReceiptType.SALE,
      amount: order.totalAmount,
      occurredAt,
    });
  }

  /**
   * 记一笔货款冲回（退款成功时）。
   *
   * ⚠️ **金额取负**：与货款行反向，单列求和即净额。
   */
  async recordReceiptReversalInTx(
    tx: PrismaTransaction,
    order: ReceiptOrderSnapshot,
    occurredAt: Date,
  ): Promise<void> {
    if (order.totalAmount === 0) {
      return;
    }

    await this.insertEntryInTx(tx, {
      tenantId: order.tenantId,
      orderId: order.id,
      orderNo: order.orderNo,
      type: ReceiptType.SALE_REVERSAL,
      // ⚠️ **金额取负**：与货款行反向，单列求和即净额。
      amount: -order.totalAmount,
      occurredAt,
    });
  }

  /**
   * 幂等地插一行货款流水（**先查后插**，不用 `upsert`）。
   *
   * ⚠️ **为什么不能用 `upsert`**：`MerchantReceipt` 登记在
   * `TENANT_SCOPED_MODELS` 白名单里（租户扩展对白名单内的模型**直接拒绝**
   * `upsert` —— 它的 where 只接受唯一字段，无法附加 tenantId 条件，
   * 会造成跨租户越权）。与 `CommissionService.insertEntryInTx` 同款理由。
   *
   * ⚠️ **已存在就原样保留**（不覆盖金额与时间）：那行是第一次记下的事实。
   *
   * @returns true = 新插了一行；false = 已存在，没动
   */
  private async insertEntryInTx(
    tx: PrismaTransaction,
    data: ReceiptEntryData,
  ): Promise<boolean> {
    const existing = await tx.merchantReceipt.findFirst({
      where: { orderId: data.orderId, type: data.type },
      select: { id: true },
    });
    if (existing) {
      return false;
    }

    await tx.merchantReceipt.create({ data });
    return true;
  }

  /**
   * 某商家某期的货款流水（左闭右开，与结算单同口径）。
   *
   * ⚠️ **必须显式带 `tenantId`**：`merchant_receipts` 在租户白名单里，
   * 租户作用域下扩展会自动附加 tenantId 条件；但**平台作用域下不附加**，
   * 所以平台侧聚合时这里必须自己带上。
   */
  async receiptsInPeriod(
    tenantId: string,
    period: { from: Date; to: Date },
  ): Promise<
    Array<{
      id: string;
      orderId: string;
      orderNo: string;
      type: ReceiptType;
      amount: number;
      occurredAt: Date;
    }>
  > {
    return this.prisma.merchantReceipt.findMany({
      where: {
        tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /**
   * 回填历史订单的货款流水（平台作用域下跑）。
   *
   * ⚠️ **与抽佣的回填分开跑**：两者的零额判定字段不同
   * （抽佣看 `commissionAmount`、货款看 `totalAmount`），
   * 零额抽佣的订单**有货款、无抽佣** → 货款必须单独回填。
   */
  async backfill(): Promise<ReceiptBackfillResult> {
    const result: ReceiptBackfillResult = {
      receiptCreated: 0,
      reversalCreated: 0,
      skippedZeroAmount: 0,
      skippedUndatedRefund: 0,
    };

    await tenantContext.run(platformScope(), async () => {
      // ⚠️ **只查 `paidAt` 非空的订单**：没付过钱的订单没有货款。
      const orders = await this.prisma.order.findMany({
        where: { paidAt: { not: null } },
        select: {
          id: true,
          tenantId: true,
          orderNo: true,
          totalAmount: true,
          paidAt: true,
          refundedAt: true,
          status: true,
        },
      });

      for (const order of orders) {
        // ⚠️ **用枚举常量而不是字符串**：`OrderStatus.REFUNDED` 才是权威值，
        // 字符串比较在枚举扩容时会静默漏掉。
        const refunded = order.status === OrderStatus.REFUNDED;

        if (!shouldBackfillReceipt(order.paidAt, order.totalAmount)) {
          // ⚠️ **跳过零额要计数**：运维需要看到「有多少历史单没有货款流水」。
          // 静默跳过等于账对不上却没人知道。
          result.skippedZeroAmount += 1;
          continue;
        }

        const created = await this.insertEntry({
          tenantId: order.tenantId,
          orderId: order.id,
          orderNo: order.orderNo,
          type: ReceiptType.SALE,
          amount: order.totalAmount,
          // ⚠️ **归期用 `paidAt`** —— 与抽佣流水的归期口径逐字一致。
          occurredAt: order.paidAt as Date,
        });
        if (created) {
          result.receiptCreated += 1;
        }

        if (!refunded) {
          continue;
        }

        if (
          !shouldBackfillReceiptReversal(
            refunded,
            order.refundedAt,
            order.totalAmount,
          )
        ) {
          // ⚠️ **已退款但 `refundedAt` 为 null**：5b 之前退的款没记时间，
          // 冲回无法归期 → 跳过（与抽佣口径一致），但**要计数**。
          if (order.totalAmount !== 0) {
            result.skippedUndatedRefund += 1;
          }
          continue;
        }

        const createdReversal = await this.insertEntry({
          tenantId: order.tenantId,
          orderId: order.id,
          orderNo: order.orderNo,
          type: ReceiptType.SALE_REVERSAL,
          amount: -order.totalAmount,
          occurredAt: order.refundedAt as Date,
        });
        // ⚠️ **只数「真的新建的行」**：行已存在时没新建任何行，
        // 计数器却照样加一的话，运维跑第二遍回填会看到
        // 「新建冲回流水：N 行」而实际新建了 0 行。
        if (createdReversal) {
          result.reversalCreated += 1;
        }
      }
    });

    this.logger.log(
      `货款流水回填完成：货款 ${result.receiptCreated} 行、冲回 ${result.reversalCreated} 行，` +
        `跳过零额 ${result.skippedZeroAmount} 单、跳过无归期退款 ${result.skippedUndatedRefund} 单`,
    );

    return result;
  }

  /**
   * 幂等地插一行货款流水（**回填用**，走 `this.prisma` 而不是事务客户端）。
   *
   * ⚠️ **回填跑在平台作用域下**：平台作用域下扩展**不附加** tenantId 条件，
   * 所以这里的 `findFirst` 必须**自己带上 `tenantId`** ——
   * 不带的话，别的租户的同名行会被误判成「已存在」而漏记。
   */
  private async insertEntry(data: ReceiptEntryData): Promise<boolean> {
    const existing = await this.prisma.merchantReceipt.findFirst({
      where: {
        tenantId: data.tenantId,
        orderId: data.orderId,
        type: data.type,
      },
      select: { id: true },
    });
    if (existing) {
      return false;
    }

    await this.prisma.merchantReceipt.create({ data });
    return true;
  }
}
