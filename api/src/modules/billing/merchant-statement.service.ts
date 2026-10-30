import { Injectable, NotFoundException } from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';

import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { deriveApplicableKind, IN_FLIGHT_PAYOUT_STATUSES } from './ledger';
import { LedgerService, type PeriodAmounts } from './ledger.service';
import { formatPeriodLabel, resolveMonthlyPeriod } from './settlement';

/**
 * 商家侧对账单的服务层（阶段 5i）。
 *
 * ⚠️ **对账单是「商家自己看的一期一期的账」** —— 与「可申请出款的周期列表」
 *    不是一回事：
 *    - 出款页的列表**只列能申请出款的期**（不能申请的直接跳过）；
 *    - 对账单**要列出所有有货款的期**，包括「结算单还没生成」「结算单还没确认」
 *      「当月还没结束」的期。
 *    ⚠️ **理由**：商家看到「我这期有货款，但结算单还没确认」才不用打电话问客服；
 *      若对账单也只列能出款的期，商家只能靠客服才知道钱卡在哪一步。
 *
 * ⚠️ **金额口径全部来自 `LedgerService.aggregatePeriods`** ——
 *    出款页与对账单**共用同一份聚合**，两处口径漂了账就错了。
 *    本服务只做「聚合结果 → 商家视角」的换算，不自己算钱。
 */

/** 一期对账单的视图（商家侧） */
export interface StatementPeriodView {
  /** 周期标识（`YYYY-MM`） */
  period: string;
  /** 该期结算单 id；null = 没有结算单 */
  statementId: string | null;
  /** 该期结算单状态；null = 没有结算单 */
  statementStatus: SettlementStatus | null;
  /** 货款净额（实时，带符号） */
  receiptAmount: number;
  /** 货款笔数 */
  receiptCount: number;
  /** 佣金净额（**带符号**，取结算单的 `netAmount`）；null = 没有结算单 */
  commissionAmount: number | null;
  /** 抽佣流水笔数（结算单纳入的） */
  commissionEntryCount: number;
  /** 货款净额 − 佣金净额；null = 佣金未知 */
  payableAmount: number | null;
  /** 已出款 */
  paidAmount: number;
  /** 在途 */
  inFlightAmount: number;
  /** max(0, 应结 − 已出款 − 在途)；null = 应结未知 */
  pendingAmount: number | null;
  /** max(0, 已出款 − 应结) */
  overpaidAmount: number;
  /** 能申请的出款类型；null = 不能申请 */
  applicableKind: 'NORMAL' | 'SUPPLEMENT' | null;
  /** 不能申请的原因；null = 能申请 */
  blockedReason: string | null;
}

/**
 * 货款流水对应的出款状态。
 *
 * ⚠️ **`null` = 未被任何出款单纳入**（还能申请出款）；
 *    `'IN_FLIGHT'` = 被在途出款单纳入（申请了，钱还没打）；
 *    `'PAID'` = 被已打款的出款单纳入（钱已到账）。
 */
export type ReceiptPayoutStatus = 'IN_FLIGHT' | 'PAID';

/** 一期对账单的详情 */
export interface StatementPeriodDetail extends StatementPeriodView {
  /** 抽佣明细（结算单纳入的流水） */
  commissionEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 计佣基数 */
    baseAmount: number;
    /** 费率（基点，10000 = 100%） */
    rateBps: number;
    /** 佣金金额（**带符号**：抽佣正、冲回负） */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
  }>;
  /** 货款明细（实时） */
  receiptEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 带符号 */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
    /**
     * 出款状态：null = 未被出款单纳入；IN_FLIGHT = 在途；PAID = 已出款。
     *
     * ⚠️ **不是 boolean** —— 「被出款单占用」不等于「钱已到账」，
     *    在途的单要单独标成「出款中」，否则商家会以为钱已经打过来了。
     */
    payoutStatus: ReceiptPayoutStatus | null;
  }>;
}

/**
 * 一批货款流水（只要发生时间就够算周期了）。
 *
 * ⚠️ **列表页只 select `occurredAt`** —— 金额一律由 `LedgerService` 聚合，
 *    这里不重复求和（两处求和 → 两处口径）。
 */
interface ReceiptPeriodRow {
  occurredAt: Date;
}

@Injectable()
export class MerchantStatementService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * 列出该商家**所有有货款的期**（倒序）。
   *
   * ⚠️ **包括不能申请出款的期、包括当月（未结束的期）** ——
   *    商家需要看到「我这期有货款，但结算单还没确认」，
   *    否则只能打电话问客服。当月的期 `applicableKind` 恒为 `null`
   *    （`deriveApplicableKind` 判「周期未结束」）。
   */
  async list(): Promise<StatementPeriodView[]> {
    const tenantId = this.requireTenantId();
    const now = await this.prisma.databaseNow();

    // ⚠️ **先查「有哪些期」** —— 期数是从流水里推出来的，
    //    而不是从结算单推出来的（没结算单的期也要出现在对账单里）。
    const receipts = (await this.prisma.merchantReceipt.findMany({
      where: {},
      select: { occurredAt: true },
    })) as ReceiptPeriodRow[];

    const labels = this.collectPeriodLabels(receipts);
    if (labels.length === 0) {
      return [];
    }

    const periods = labels.map((label) => resolveMonthlyPeriod(label));
    const amounts = await this.ledger.aggregatePeriods(tenantId, periods);

    return labels.map((label) => this.toView(label, amounts.get(label), now));
  }

  /**
   * 一期的对账单详情（汇总 + 两段明细）。
   *
   * @param period 周期标识（`YYYY-MM`）
   */
  async detail(period: string): Promise<StatementPeriodDetail> {
    const tenantId = this.requireTenantId();
    const resolved = resolveMonthlyPeriod(period);
    const now = await this.prisma.databaseNow();

    const amounts = await this.ledger.aggregatePeriods(tenantId, [resolved]);
    const summary = amounts.get(resolved.label);
    if (!summary) {
      // ⚠️ **理论上到不了这里**（`aggregatePeriods` 一定会给这一期一个条目），
      //    但「查不到就 404」比「拿着 undefined 往下算」安全。
      throw new NotFoundException(`找不到 ${resolved.label} 的对账单数据`);
    }

    const view = this.toView(resolved.label, summary, now);

    // ⚠️ **DRAFT 的结算单不展示明细** —— 未确认的结算单**不是凭证**，
    //    确认时可能被重算 → 现在展示出来的数字明天就变了。
    //    汇总仍照给（商家能看到「这期有结算单但还没确认」）。
    //    ⚠️ **返回 `null` 而不是 `[]`** —— `null` 表示「这一期压根没有可展示的
    //    抽佣明细」，与「展示了 0 条明细」是**两回事**：
    //    前者不该参与下面的 S2 自检（没有明细可加总），
    //    后者必须参与（结算单纳入了 0 笔佣金，净额理应也是 0）。
    const commissionEntries =
      summary.statementStatus === SettlementStatus.DRAFT
        ? null
        : await this.loadCommissionEntries(summary);

    const receiptEntries = await this.loadReceiptEntries(resolved);

    // ---- 护栏 S2 / S3：明细与汇总必须对得上 ----
    // ⚠️ **为什么在这里炸**：明细与汇总来自**两处不同的查询** →
    //    不一致说明其中一边算错了 →
    //    **宁可这个接口 500，也不要让商家把明细加总发现与页面上的佣金净额差 1 分**
    //    然后来投诉。差 1 分的分歧一旦出现，商家的信任就没了。
    //
    // ⚠️ **S2 只在「展示了明细」时才做** —— DRAFT 期刻意不展示明细，
    //    此时拿「0 条」去和佣金净额对账必然不等 → 那不是算错，是**还没算**。
    if (commissionEntries !== null) {
      const commissionSum = commissionEntries.reduce(
        (sum, e) => sum + e.amount,
        0,
      );
      if (commissionSum !== (summary.commissionAmount ?? 0)) {
        throw new Error(
          `抽佣明细加总 ${commissionSum} 与佣金净额 ${summary.commissionAmount} 不一致`,
        );
      }
    }
    const receiptSum = receiptEntries.reduce((sum, e) => sum + e.amount, 0);
    if (receiptSum !== summary.receiptAmount) {
      throw new Error(
        `货款明细加总 ${receiptSum} 与货款净额 ${summary.receiptAmount} 不一致`,
      );
    }

    return {
      ...view,
      commissionEntries: commissionEntries ?? [],
      receiptEntries,
    };
  }

  /**
   * 取当前租户 id。
   *
   * ⚠️ **商家侧不手写 `tenantId` 条件**（靠租户作用域扩展自动附加），
   *    但**按期聚合必须显式传 `tenantId`** —— `aggregatePeriods` 可能被平台作用域
   *    调用（那里扩展不附加过滤），少了它就是跨租户取数。
   */
  private requireTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('缺少租户上下文');
    }
    return context.tenantId;
  }

  /**
   * 从流水里推出所有有货款的期（倒序）。
   *
   * ⚠️ **倒序用 `localeCompare`** —— 与 `PayoutService.availablePeriods` 同款，
   *    商家看到的最新一期永远在最上面。
   */
  private collectPeriodLabels(receipts: ReceiptPeriodRow[]): string[] {
    const labels = new Set<string>();
    for (const receipt of receipts) {
      labels.add(formatPeriodLabel(receipt.occurredAt));
    }
    return [...labels].sort((a, b) => b.localeCompare(a));
  }

  /**
   * 聚合结果 → 商家视角的一期。
   *
   * ⚠️ **`periodEnded` 按「这个月过完了没有」判**（`period.to <= now`）：
   *    当月还没结束 → `deriveApplicableKind` 直接给「该周期尚未结束」，
   *    数字不是凭证，不能拿去申请出款。
   */
  private toView(
    period: string,
    amounts: PeriodAmounts | undefined,
    now: Date,
  ): StatementPeriodView {
    if (!amounts) {
      throw new NotFoundException(`找不到 ${period} 的对账单数据`);
    }

    // ⚠️ **佣金未知时，应结与待出款都是 `null`** ——
    //    「佣金是 0」与「佣金还没算」是两回事：没有结算单说明佣金压根没算过，
    //    填 0 会让「该期还没结算」被误读成「该期不用扣佣」。
    const payableAmount =
      amounts.commissionAmount === null
        ? null
        : amounts.receiptAmount - amounts.commissionAmount;

    // ⚠️ **待出款不出现负数**：已出款超过应结时，`pending` 恒为 0，
    //    多出来的部分单列在 `overpaidAmount` 里。
    const pendingAmount =
      payableAmount === null
        ? null
        : Math.max(
            0,
            payableAmount - amounts.paidAmount - amounts.inFlightAmount,
          );

    const overpaidAmount =
      payableAmount === null
        ? 0
        : Math.max(0, amounts.paidAmount - payableAmount);

    // ⚠️ **周期是否结束按「这个月过完了没有」判** ——
    //    当月的流水还会变（回填随时可能补进来），此时的数字不是凭证。
    const periodEnded =
      resolveMonthlyPeriod(period).to.getTime() <= now.getTime();

    const applicable = deriveApplicableKind({
      periodEnded,
      receiptAmount: amounts.receiptAmount,
      receiptCount: amounts.receiptCount,
      commissionAmount: amounts.commissionAmount,
      statementStatus: amounts.statementStatus,
      hasActiveNormal: amounts.hasActiveNormal,
      hasActiveSupplement: amounts.hasActiveSupplement,
      normalPaid: amounts.normalPaid,
      supplementAmount: amounts.supplementAmount,
    });

    return {
      period,
      statementId: amounts.statementId,
      statementStatus: amounts.statementStatus,
      receiptAmount: amounts.receiptAmount,
      receiptCount: amounts.receiptCount,
      commissionAmount: amounts.commissionAmount,
      commissionEntryCount: amounts.commissionEntryCount,
      payableAmount,
      paidAmount: amounts.paidAmount,
      inFlightAmount: amounts.inFlightAmount,
      pendingAmount,
      overpaidAmount,
      applicableKind: applicable.kind,
      blockedReason: applicable.reason,
    };
  }

  /**
   * 抽佣明细（结算单纳入的流水）。
   *
   * ⚠️ **`settlement_statement_entries` 没有 `tenantId`、不在租户作用域白名单里**
   *    → 扩展**不会**给它附加任何过滤 → 直接查就是全局事实。
   *    这里的做法是「先查该租户该期的结算单，再用它的 id 去关联」
   *    → **归属天然安全**（那个 id 本来就是该租户的）。
   *
   * ⚠️ **没有结算单 → 没有明细**（佣金都不知道，明细更无从谈起）。
   */
  private async loadCommissionEntries(
    amounts: PeriodAmounts,
  ): Promise<StatementPeriodDetail['commissionEntries']> {
    if (!amounts.statementId) {
      return [];
    }

    // ⚠️ **先查该租户该期的结算单** —— 它是 `settlement_statement_entries`
    //    的归属凭证（那张表本身不带 tenantId）。
    const statement = await this.prisma.settlementStatement.findFirst({
      where: { id: amounts.statementId },
      select: { id: true },
    });
    if (!statement) {
      return [];
    }

    const links = await this.prisma.settlementStatementEntry.findMany({
      where: { statementId: statement.id },
      select: { entryId: true },
    });
    if (links.length === 0) {
      return [];
    }

    const entries = await this.prisma.commissionEntry.findMany({
      where: { id: { in: links.map((link) => link.entryId) } },
      select: {
        id: true,
        orderNo: true,
        type: true,
        baseAmount: true,
        rateBps: true,
        amount: true,
        occurredAt: true,
      },
    });

    // ⚠️ **按发生时间倒序** —— 商家看明细时最关心最近的一笔。
    return [...entries]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .map((entry) => ({
        entryId: entry.id,
        orderNo: entry.orderNo,
        type: String(entry.type),
        baseAmount: entry.baseAmount,
        rateBps: entry.rateBps,
        amount: entry.amount,
        occurredAt: entry.occurredAt.toISOString(),
      }));
  }

  /**
   * 货款明细（该期全部货款流水，实时）。
   *
   * ⚠️ **标出哪些已被出款单出过** —— 商家最常问的两件事：
   *    「哪笔钱还没给我」与「哪笔已经给了」。
   *
   * ⚠️ **三态而不是布尔** —— 「被出款单占用」≠「钱已到账」：
   *    在途的单（申请了但钱还没打）标「出款中」，
   *    否则商家看到「已出款」却没收到钱就会来投诉。
   *
   * ⚠️ **`payout_entries` 同样没有 `tenantId`、不在白名单**
   *    → 先查该租户该期的出款单（select `id` 与 `status`），再用 id 列表关联。
   */
  private async loadReceiptEntries(period: {
    from: Date;
    to: Date;
  }): Promise<StatementPeriodDetail['receiptEntries']> {
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { occurredAt: { gte: period.from, lt: period.to } },
      select: {
        id: true,
        orderNo: true,
        type: true,
        amount: true,
        occurredAt: true,
      },
    });

    // ⚠️ **先查该租户该期的出款单** —— 它们是 `payout_entries` 的归属凭证。
    const payouts = await this.prisma.payout.findMany({
      where: { periodStart: period.from },
      select: { id: true, status: true },
    });

    const statusByEntryId = new Map<string, ReceiptPayoutStatus>();
    if (payouts.length > 0) {
      const statusByPayoutId = new Map(
        payouts.map((payout) => [payout.id, payout.status]),
      );
      const links = await this.prisma.payoutEntry.findMany({
        where: { payoutId: { in: payouts.map((p) => p.id) } },
        select: { entryId: true, payoutId: true },
      });
      for (const link of links) {
        const payoutStatus = statusByPayoutId.get(link.payoutId);
        // ⚠️ **理论上到不了这里**：`links` 是按 `payouts` 的 id 列表查出来的
        //    → 每条 link 的 `payoutId` 必然能在 `payouts` 里找到。
        //    查不到就跳过（当「未出款」），别让它顺着往下走。
        if (payoutStatus === undefined) {
          continue;
        }
        if (payoutStatus === PayoutStatus.PAID) {
          statusByEntryId.set(link.entryId, 'PAID');
        } else if (IN_FLIGHT_PAYOUT_STATUSES.includes(payoutStatus)) {
          // ⚠️ **`PAID` 优先** —— 这是一段**当前不可达的防御**：
          //    `payout_entries.entryId` 是**全局唯一索引**
          //    （`schema.prisma` 的 `@unique`、迁移里的
          //    `CREATE UNIQUE INDEX "payout_entries_entryId_key"`）
          //    → 同一笔流水**不可能**被两张出款单纳入。
          //    全部写入路径（申请 / 审批 / 撤回 / 拒绝 / 打款失败）都是
          //    先 `deleteMany` 再 `createMany`，也产生不了重复。
          //    **只有将来这个唯一索引被去掉**时，这段逻辑才会生效；
          //    那时「钱已到账」比「在途」更贴近事实。
          if (statusByEntryId.get(link.entryId) !== 'PAID') {
            statusByEntryId.set(link.entryId, 'IN_FLIGHT');
          }
        }
        // ⚠️ **`REJECTED` / `CANCELLED` / `FAILED` 不记录**（当「未出款」）——
        //    这三种状态的 `payout_entries` 行**一律不存在**：
        //    拒绝（`payout.service.ts`）、撤回（同文件）、
        //    打款失败（`payout-execution.service.ts`）三条释放路径
        //    都是**物理删除** `payout_entries` 行。
        //    → **这里永远走不到**，是纯防御。
      }
    }

    return [...receipts]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .map((receipt) => ({
        entryId: receipt.id,
        orderNo: receipt.orderNo,
        type: String(receipt.type),
        amount: receipt.amount,
        occurredAt: receipt.occurredAt.toISOString(),
        payoutStatus: statusByEntryId.get(receipt.id) ?? null,
      }));
  }
}
