import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CommissionEntryType, OrderStatus } from '@prisma/client';

import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';

/**
 * 记一笔抽佣或冲回所需要的订单快照。
 *
 * ⚠️ **刻意只列必需字段**：调用方（payment 模块）拿到的是完整的订单行，
 * 这里只取用得上的那几个 —— 类型越宽，调用方越容易传错字段。
 */
export interface CommissionOrderSnapshot {
  id: string;
  tenantId: string;
  orderNo: string;
  /** 实付（整数分）= 计佣基数 */
  totalAmount: number;
  /** 抽佣费率快照（基点） */
  commissionRate: number;
  /** 抽佣额快照（整数分） */
  commissionAmount: number;
}

/** 一行抽佣流水的写入内容 */
interface CommissionEntryData {
  tenantId: string;
  orderId: string;
  orderNo: string;
  type: CommissionEntryType;
  amount: number;
  rateBps: number;
  baseAmount: number;
  occurredAt: Date;
}

/** 回填的结果计数 */
export interface BackfillResult {
  /** 新建的抽佣流水行数 */
  commissionCreated: number;
  /** 新建的冲回流水行数 */
  reversalCreated: number;
  /** 因抽佣额为 0（免费套餐）而跳过的订单数 */
  skippedZeroAmount: number;
  /** 因已退款但 `refundedAt` 为空（5b 之前退的款）而跳过的订单数 */
  skippedUndatedRefund: number;
}

/** 抽佣台账：按商家汇总 + 逐笔明细 */
export interface CommissionLedger {
  /** 区间起点（ISO 8601） */
  from: string;
  /** 区间终点（ISO 8601，不含） */
  to: string;
  /** 按商家汇总 */
  byMerchant: Array<{
    tenantId: string;
    tenantName: string;
    subdomain: string;
    /** 净抽佣（整数分，可负） */
    netAmount: number;
    /** 区间内的流水笔数 */
    entryCount: number;
    /** 其中冲回的笔数 */
    reversalCount: number;
  }>;
  /** 逐笔流水明细 */
  entries: Array<{
    id: string;
    tenantId: string;
    orderNo: string;
    type: 'COMMISSION' | 'REVERSAL';
    /** 带符号：抽佣为正、冲回为负 */
    amount: number;
    /** 费率（基点） */
    rateBps: number;
    /** 计佣基数（整数分） */
    baseAmount: number;
    /** 业务发生时间（ISO 8601） */
    occurredAt: string;
  }>;
}

/**
 * 一条历史订单要不要回填抽佣流水。
 *
 * ⚠️ **抽成纯函数是为了能单测**：回填的规则与「报表怎么过滤」必须**逐字对应**，
 * 否则流水表与报表的数字对不上（对账 e2e 会红）。
 *
 * @param paidAt 支付时间。null = 从没付过钱
 * @param commissionAmount 抽佣额快照（整数分）
 */
export function shouldBackfillCommission(
  paidAt: Date | null,
  commissionAmount: number,
): boolean {
  // ⚠️ **没付过钱 → 没有抽佣**（与报表只看 paidAt 一致）
  if (!paidAt) {
    return false;
  }
  // ⚠️ **零额不记**（免费套餐的费率是 0）—— 表里全是 0 没意义
  if (commissionAmount === 0) {
    return false;
  }
  return true;
}

/**
 * 一条历史订单要不要回填冲回流水。
 *
 * ⚠️ **`refundedAt` 为 null 的已退款订单一律跳过** ——
 * 5b 之前退的款没记时间（`Order.refundedAt` 是 5b 加的），**冲回无法归期**。
 * 现状报表同样跳过它们（`refundedAt: {gte, lt}` 对 null 不匹配）→ **两个口径一致** ✅
 *
 * @param refunded 订单是否已退款
 * @param refundedAt 退款时间。null = 5b 之前退的款
 * @param commissionAmount 抽佣额快照（整数分）
 */
export function shouldBackfillReversal(
  refunded: boolean,
  refundedAt: Date | null,
  commissionAmount: number,
): boolean {
  if (!refunded) {
    return false;
  }
  if (!refundedAt) {
    return false;
  }
  if (commissionAmount === 0) {
    return false;
  }
  return true;
}

/**
 * 抽佣流水的写入与查询（阶段 5e）。
 *
 * ⚠️ **一笔抽佣一行、一笔冲回一行**，金额带符号：
 * COMMISSION > 0（抽佣）、REVERSAL < 0（冲回）。单列求和即净额。
 *
 * ⚠️ **为什么要有这张表**：5b 的决策是「抽佣不建独立表，存成订单上的两个快照字段」，
 * 遗留写的是「报表 SQL 要跨订单聚合；将来做结算单时再抽一层」。
 * 本阶段把那层抽出来了 —— 不是因为分叉点变多了，而是
 * **「按商家 × 区间出结算单」需要「这一笔属于哪个商家的哪一次成交」**，
 * 从订单聚合算不出来。
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 记一笔抽佣（支付成功时）。
   *
   * ⚠️ **幂等**：同一笔订单的抽佣行只有一条 ——
   * ① 订单的状态条件更新（`status = PENDING_PAYMENT`）已经挡住了重复投递；
   * ② `@@unique([orderId, type])` 再兜一层；
   * ③ 这里用「先查后插」而不是 `upsert`（见 `insertEntryInTx` 的注释）。
   *
   * ⚠️ **零额不记**：费率是 0（免费套餐）的订单不产生流水行 ——
   * 否则表里全是 0，聚合时白扫一遍。
   *
   * @param occurredAt 支付时间（用**数据库的时钟**，与订单的 `paidAt` 同源）
   */
  async recordCommissionInTx(
    tx: PrismaTransaction,
    order: CommissionOrderSnapshot,
    occurredAt: Date,
  ): Promise<void> {
    if (order.commissionAmount === 0) {
      return;
    }

    await this.insertEntryInTx(tx, {
      tenantId: order.tenantId,
      orderId: order.id,
      orderNo: order.orderNo,
      type: CommissionEntryType.COMMISSION,
      amount: order.commissionAmount,
      rateBps: order.commissionRate,
      baseAmount: order.totalAmount,
      occurredAt,
    });
  }

  /**
   * 记一笔冲回（退款成功时）。
   *
   * ⚠️ **金额取负**：冲回是「平台要还回去的钱」，与抽佣行反向，
   * 单列求和即净额。
   *
   * ⚠️ **幂等与抽佣行同款**：靠 `@@unique([orderId, type])` + 「先查后插」。
   *
   * @param occurredAt 退款时间（用**数据库的时钟**，与订单的 `refundedAt` 同源）
   */
  async recordReversalInTx(
    tx: PrismaTransaction,
    order: CommissionOrderSnapshot,
    occurredAt: Date,
  ): Promise<void> {
    if (order.commissionAmount === 0) {
      return;
    }

    await this.insertEntryInTx(tx, {
      tenantId: order.tenantId,
      orderId: order.id,
      orderNo: order.orderNo,
      type: CommissionEntryType.REVERSAL,
      // ⚠️ **金额取负**：与抽佣行反向，单列求和即净额。
      amount: -order.commissionAmount,
      rateBps: order.commissionRate,
      baseAmount: order.totalAmount,
      occurredAt,
    });
  }

  /**
   * 幂等地插一行抽佣流水（**先查后插**，不用 `upsert`）。
   *
   * ⚠️ **为什么不能用 `upsert`**：`CommissionEntry` 登记在
   * `TENANT_SCOPED_MODELS` 白名单里（阶段 1 的租户扩展对租户作用域模型
   * **直接拒绝** `upsert` —— 它的 where 只接受唯一字段，无法附加 tenantId 条件，
   * 会造成跨租户越权）。扩展给的建议就是「findFirst 判断后分别 create 或
   * updateMany」，这里照做。
   *
   * ⚠️ **已存在就原样保留**（不覆盖金额与时间）：那行是第一次记下的事实。
   *
   * ⚠️ **`findFirst` 在租户作用域下自动带 tenantId 条件**：
   * 别的租户的同名行查不到 → 不会误判成「已存在」而漏记。
   *
   * @returns true = 新插了一行；false = 已存在，没动
   */
  private async insertEntryInTx(
    tx: PrismaTransaction,
    data: CommissionEntryData,
  ): Promise<boolean> {
    const existing = await tx.commissionEntry.findFirst({
      where: { orderId: data.orderId, type: data.type },
      select: { id: true },
    });
    if (existing) {
      return false;
    }

    await tx.commissionEntry.create({ data });
    return true;
  }

  /**
   * 幂等地插一行抽佣流水（**回填用**，走 `this.prisma` 而不是事务客户端）。
   *
   * ⚠️ **回填跑在平台作用域下**：平台作用域下扩展**不附加** tenantId 条件，
   * 所以这里的 `findFirst` 必须**自己带上 `tenantId`** —— 不带的话，
   * 别的租户的同名行会被误判成「已存在」而漏记（跨租户的数据错误）。
   *
   * ⚠️ **不能用 `upsert`**：与 `insertEntryInTx` 同款理由 ——
   * 租户扩展对白名单内的模型一律拒绝 `upsert`（**平台作用域下也拒绝**）。
   */
  private async insertEntry(data: CommissionEntryData): Promise<boolean> {
    const existing = await this.prisma.commissionEntry.findFirst({
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

    await this.prisma.commissionEntry.create({ data });
    return true;
  }

  /**
   * 回填历史订单的抽佣流水。
   *
   * ⚠️ **必须跑在平台作用域下** —— 抽佣流水是**跨租户**的（平台看所有商家）。
   * 不显式声明的话，被商家上下文调用时会**静默只回填一个租户的数据**。
   *
   * ⚠️ **幂等**：逐条「先查后插」（见 `insertEntry`），跑第二遍不会产生第二行。
   *
   * ⚠️ **跳过的要计数**：运维需要看到「有多少历史退款被跳过了」
   * （5b 之前退的款没记时间 → 冲回无法归期）。静默跳过等于账对不上却没人知道。
   *
   * ⚠️ **没有事务**：中途失败会留下部分已写行。幂等的前提下这可接受 ——
   * 重跑一遍就补齐了（每行都是「先查后插」，不会重复）。
   */
  async backfill(): Promise<BackfillResult> {
    const result: BackfillResult = {
      commissionCreated: 0,
      reversalCreated: 0,
      skippedZeroAmount: 0,
      skippedUndatedRefund: 0,
    };

    await tenantContext.run(platformScope(), async () => {
      // ⚠️ **只查 `paidAt` 非空的订单**：没付过钱的订单没有抽佣。
      // Prisma 的 `{ not: null }` 表示「该字段非空」。
      const orders = await this.prisma.order.findMany({
        where: { paidAt: { not: null } },
        select: {
          id: true,
          tenantId: true,
          orderNo: true,
          totalAmount: true,
          commissionRate: true,
          commissionAmount: true,
          paidAt: true,
          refundedAt: true,
          status: true,
        },
      });

      for (const order of orders) {
        const refunded = order.status === OrderStatus.REFUNDED;

        if (!shouldBackfillCommission(order.paidAt, order.commissionAmount)) {
          // ⚠️ **两种跳过要分开计数**：零额（免费套餐）与「没付过钱」
          // 在这里已经被 paidAt 的过滤合并了 —— 只可能剩下零额。
          result.skippedZeroAmount += 1;
          continue;
        }

        const createdCommission = await this.insertEntry({
          tenantId: order.tenantId,
          orderId: order.id,
          orderNo: order.orderNo,
          type: CommissionEntryType.COMMISSION,
          amount: order.commissionAmount,
          rateBps: order.commissionRate,
          baseAmount: order.totalAmount,
          // ⚠️ **归期用 `paidAt`** —— 与平台收入报表的抽佣口径逐字一致。
          occurredAt: order.paidAt as Date,
        });
        if (createdCommission) {
          result.commissionCreated += 1;
        }

        if (!refunded) {
          continue;
        }

        if (
          !shouldBackfillReversal(
            refunded,
            order.refundedAt,
            order.commissionAmount,
          )
        ) {
          // ⚠️ **已退款但 `refundedAt` 为 null**：5b 之前退的款没记时间，
          // 冲回无法归期 → 跳过（与报表口径一致），但**要计数**。
          if (order.commissionAmount !== 0) {
            result.skippedUndatedRefund += 1;
          }
          continue;
        }

        const createdReversal = await this.insertEntry({
          tenantId: order.tenantId,
          orderId: order.id,
          orderNo: order.orderNo,
          type: CommissionEntryType.REVERSAL,
          // ⚠️ **金额取负**：与抽佣行反向，单列求和即净额。
          amount: -order.commissionAmount,
          rateBps: order.commissionRate,
          baseAmount: order.totalAmount,
          // ⚠️ **归期用 `refundedAt`** —— 与报表的冲回归期口径一致。
          occurredAt: order.refundedAt as Date,
        });
        // ⚠️ **只数「真的新建的行」**（与 `commissionCreated` 同款）：
        // 行已存在时 `insertEntry` 返回 false —— 那时**没有新建任何行**，
        // 计数器却照样加一的话，运维跑第二遍回填会看到
        // 「新建冲回流水：N 行」而实际新建了 0 行。
        if (createdReversal) {
          result.reversalCreated += 1;
        }
      }
    });

    this.logger.log(
      `抽佣流水回填完成：抽佣 ${result.commissionCreated} 行、冲回 ${result.reversalCreated} 行，` +
        `跳过零额 ${result.skippedZeroAmount} 单、跳过无归期退款 ${result.skippedUndatedRefund} 单`,
    );

    return result;
  }

  /**
   * 平台的抽佣台账（按商家汇总 + 逐笔明细）。
   *
   * ⚠️ **必须显式走平台作用域**（跨租户聚合）：控制器上的 `@Roles` 管的是
   * 「谁能调」，管不了「service 在什么作用域里查库」。不显式声明的话，
   * 这个方法被商家上下文调用时会**静默只统计一个租户的数据**。
   *
   * ⚠️ **净额由后端算**：前端拿到 `netAmount` 直接展示，绝不自己把明细加总一遍
   * —— 两套口径迟早漂移，账对不上。
   *
   * ⚠️ **当前不分页**：全量返回区间内的明细。订单量增长后响应会无界膨胀
   * → 将来做结算单时得加分页。
   */
  async ledger(input: { from: Date; to: Date }): Promise<CommissionLedger> {
    const { from, to } = input;

    // ⚠️ **区间必须非空**：`from >= to` 的区间算不出任何东西，
    // 与其返回一串 0 让调用方以为「这段时间没抽佣」，不如响亮地报错。
    // （与 `ReportService.summary()` 同款校验 —— 两个端点的输入语义一样，
    // 行为也该一样。）
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('区间非法：from 必须早于 to');
    }

    return tenantContext.run(platformScope(), async () => {
      const entries = await this.prisma.commissionEntry.findMany({
        // ⚠️ **区间左闭右开 `[from, to)`**：与平台收入报表同一套区间语义，
        // 相邻两期不重不漏。
        where: { occurredAt: { gte: from, lt: to } },
        orderBy: { occurredAt: 'desc' },
      });

      // ⚠️ **商家名要单独查**：`CommissionEntry.tenantId` 是纯标量、
      // 没声明 Prisma 关系 → 拿不到商家名。先收集 tenantId 集合再批量查。
      // （`Tenant` **不在** `TENANT_SCOPED_MODELS` 白名单里，任何作用域都能查。）
      const tenantIds = [...new Set(entries.map((e) => e.tenantId))];
      const tenants =
        tenantIds.length > 0
          ? await this.prisma.tenant.findMany({
              where: { id: { in: tenantIds } },
              select: { id: true, name: true, subdomain: true },
            })
          : [];
      const tenantById = new Map(tenants.map((t) => [t.id, t]));

      // ---- 按商家汇总 ----
      const byMerchantMap = new Map<
        string,
        { netAmount: number; entryCount: number; reversalCount: number }
      >();
      for (const entry of entries) {
        const agg = byMerchantMap.get(entry.tenantId) ?? {
          netAmount: 0,
          entryCount: 0,
          reversalCount: 0,
        };
        agg.netAmount += entry.amount;
        agg.entryCount += 1;
        if (entry.type === CommissionEntryType.REVERSAL) {
          agg.reversalCount += 1;
        }
        byMerchantMap.set(entry.tenantId, agg);
      }

      const byMerchant = [...byMerchantMap.entries()]
        .map(([tenantId, agg]) => {
          const tenant = tenantById.get(tenantId);
          return {
            tenantId,
            // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行
            //（「有个商家产生了抽佣但查不到它的信息」是超管必须知道的事实）。
            tenantName: tenant?.name ?? tenantId,
            // ⚠️ **子域名查不到时给「—」**：空串看不出是「商家不存在」还是「数据缺失」。
            subdomain: tenant?.subdomain ?? '—',
            netAmount: agg.netAmount,
            entryCount: agg.entryCount,
            reversalCount: agg.reversalCount,
          };
        })
        // ⚠️ **按净抽佣倒序**：超管先看到贡献最大的商家。
        .sort((a, b) => b.netAmount - a.netAmount);

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        byMerchant,
        entries: entries.map((entry) => ({
          id: entry.id,
          tenantId: entry.tenantId,
          orderNo: entry.orderNo,
          type: entry.type,
          amount: entry.amount,
          rateBps: entry.rateBps,
          baseAmount: entry.baseAmount,
          occurredAt: entry.occurredAt.toISOString(),
        })),
      };
    });
  }
}
