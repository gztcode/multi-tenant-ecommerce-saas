import { clampPagination } from '../../common/http/pagination';
import { requireTenantId } from '../../common/tenant/require-tenant';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { LedgerService } from './ledger.service';
import {
  AvailablePeriodView,
  Paging,
  PayoutDetailView,
  PayoutEntryView,
  PayoutOperationView,
  PayoutView,
  PlatformPayoutView,
} from './payout-types';
import { formatPeriodLabel, resolveMonthlyPeriod } from './settlement';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Payout, PayoutKind, PayoutStatus } from '@prisma/client';

const MERCHANT_SAFE_FAILURE_REASONS: readonly string[] = [
  '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
  '出款金额异常，本次未打款，请联系平台核对',
  '没有可用的出款渠道',
  '出款单被平台人工标记为失败（钱未打出去），可重新申请或重试',
];
const MERCHANT_GENERIC_NOT_SENT_REASON =
  '出款未成功，本次未打款，请联系平台处理';
/**
 * PayoutQueryService —— 自 PayoutService（原 2000+ 行巨石）按职责拆出的部分（阶段 11）。
 *
 * 拆分是**纯机械搬移**：方法体与注释原样保留，只把跨组调用
 * （toView / toPlatformView）改写为经 `this.query`（PayoutQueryService）。
 * 行为校验靠既有单测与 e2e。
 */
@Injectable()
export class PayoutQueryService {
  private readonly logger = new Logger(PayoutQueryService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * 商家的出款单列表（只读）。
   *
   * ⚠️ **不传 tenantId**：商家侧靠租户作用域扩展自动过滤。
   */
  async listForTenant(
    query: { status?: PayoutStatus; period?: string } & Paging = {},
  ): Promise<{ items: PayoutView[]; total: number }> {
    const { page, pageSize } = clampPagination(query.page, query.pageSize);
    const where = this.buildWhere(query);

    const [items, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.payout.count({ where }),
    ]);

    return { items: items.map((item) => this.toView(item)), total };
  }
  /** 商家的出款单详情（含明细） */
  async detailForTenant(payoutId: string): Promise<PayoutDetailView> {
    const payout = await this.prisma.payout.findFirst({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('出款单不存在');
    }
    const entries = await this.entriesOf(payout);
    return { ...this.toView(payout), entries };
  }
  /** 平台的出款单列表（跨商家） */
  async listForPlatform(
    query: { status?: PayoutStatus; period?: string } & Paging = {},
  ): Promise<{ items: PlatformPayoutView[]; total: number }> {
    return tenantContext.run(platformScope(), async () => {
      const { page, pageSize } = clampPagination(query.page, query.pageSize);
      const where = this.buildWhere(query);

      const [items, total] = await Promise.all([
        this.prisma.payout.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.payout.count({ where }),
      ]);

      return {
        items: await this.toPlatformViews(items),
        total,
      };
    });
  }
  /** 平台的出款单详情（含明细、商家名与操作记录） */
  async detailForPlatform(payoutId: string): Promise<
    PlatformPayoutView & {
      entries: PayoutEntryView[];
      operations: PayoutOperationView[];
    }
  > {
    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      const entries = await this.entriesOf(payout);
      // ⚠️ **操作记录只在详情接口查** —— 放进 `toPlatformView` 会让
      //    **列表页的每一行都多查一次**（N+1）。
      const operations = await this.prisma.payoutOperation.findMany({
        where: { payoutId: payout.id },
        orderBy: { operatedAt: 'desc' },
      });
      // ⚠️ **操作人 id 要转成名字** —— 留痕表只存 id，
      //    光看一串 uuid 谁都认不出是谁操作的，而「谁」正是留痕要回答的第一个问题。
      //    ⚠️ **一次查齐**（不是每条留痕查一次）—— 一张单可能有多条留痕。
      const operatorIds = [...new Set(operations.map((op) => op.operatorId))];
      const operators =
        operatorIds.length > 0
          ? await this.prisma.user.findMany({
              where: { id: { in: operatorIds } },
              select: { id: true, displayName: true },
            })
          : [];
      const operatorNameById = new Map(
        operators.map((operator) => [operator.id, operator.displayName]),
      );
      return {
        ...(await this.toPlatformView(payout)),
        entries,
        // ⚠️ **时间要转成字符串** —— 前端要的是 ISO 8601，不是 `Date`。
        operations: operations.map((operation) => ({
          id: operation.id,
          action: operation.action,
          operatorId: operation.operatorId,
          // ⚠️ **查不到人（账号被删）就回落到 id** —— 留痕不能凭空消失
          operatorName:
            operatorNameById.get(operation.operatorId) ?? operation.operatorId,
          operatedAt: operation.operatedAt.toISOString(),
          reason: operation.reason,
          fromStatus: operation.fromStatus,
          toStatus: operation.toStatus,
        })),
      };
    });
  }
  /**
   * 商家可申请的周期列表（**金额由后端算**，商家据此选周期）。
   *
   * ⚠️ **只列出真正能申请的周期**：周期已结束 + 有货款流水 + 应结 > 0。
   * 列出一堆不能申请的周期，商家挨个试才知道哪个能申请。
   *
   * ⚠️ **阶段 5h-2：按 `kind` 化** —— 一个 `alreadyApplied` 表达不了
   *    「同一期同时有已 `PAID` 的正常单 + 还能再申请一张补差单」的形状。
   *    `alreadyApplied = true` 会让商家以为「这期已经结清了」→
   *    **补差入口就此消失**。
   *
   * ⚠️ **阶段 5i Task 6：批量聚合** —— 原来是「逐期循环调 `computeAmounts`」
   *    （每期 3 次查询：货款 / 结算单 / 出款单）→ 期数一多就线性放大（N+1）。
   *    现在改成「先取周期清单 → `LedgerService.aggregatePeriods` 一次查齐
   *    → 内存里按期取值」，**查询次数与期数无关**。
   *    ⚠️ **口径必须与旧的 `computeAmounts` 逐字一致** —— 两处漂了账就错了。
   */
  async availablePeriods(): Promise<AvailablePeriodView[]> {
    const tenantId = requireTenantId();

    const now = await this.prisma.databaseNow();

    // ⚠️ **DB 端 DISTINCT 归期**：原来把本租户全部流水拉回内存取月份
    //    ——无界查询。复用 7b 的 `merchantReceiptPeriods(tenantId)`，
    //    每月只回一行字符串。
    // ⚠️ 这里**不按 now 过滤**：未结束的周期在下面的 `resolved.to > now`
    //    判断里跳过（保留原有语义）。
    const periodLabels = await this.prisma.merchantReceiptPeriods(tenantId);
    const periods = [...periodLabels].sort((a, b) => b.localeCompare(a));

    // ⚠️ **一次聚合所有期**（固定 6 次查询，与期数无关）——
    //    这是本次改动的全部目的（阶段 5h-2 的遗留 L55）。
    const aggregated = await this.ledger.aggregatePeriods(
      tenantId,
      periods.map((label) => resolveMonthlyPeriod(label)),
    );

    const views: AvailablePeriodView[] = [];
    for (const period of periods) {
      const resolved = resolveMonthlyPeriod(period);
      // ⚠️ **周期未结束的期要跳过** —— 周期内的流水还会变，
      //    此时的数字不是凭证。
      if (resolved.to.getTime() > now.getTime()) {
        continue;
      }

      const amounts = aggregated.get(period);
      if (!amounts) {
        continue;
      }

      // ⚠️ **佣金可能是 `null`**（该期没有结算单）→ 展示成 0。
      // ⚠️ **不要取绝对值** —— 结算单「只有冲回没有抽佣」时净额为**负**，
      //    那是合法的账（平台要退商家钱），取绝对值会把方向搞反。
      const commissionAmount = amounts.commissionAmount ?? 0;
      // ⚠️ **没有结算单时佣金恒为 0** → 净额就是货款全额
      //    （与旧 `computeAmounts` 的 `receiptAmount - commissionAmount` 逐字一致）。
      const netAmount =
        amounts.commissionAmount === null
          ? amounts.receiptAmount
          : amounts.receiptAmount - amounts.commissionAmount;

      // ⚠️ **活跃单按 kind 区分**（索引是三元组，不带 kind 会错位）。
      //    ⚠️ **「活跃」含 `PAID`** —— 已出款的正常单**也是活跃单**
      //    （它占着索引位，也是「这一期已结清、只能走补差」的判据）。
      const appliedKind: PayoutKind | null = amounts.hasActiveSupplement
        ? PayoutKind.SUPPLEMENT
        : amounts.hasActiveNormal
          ? PayoutKind.NORMAL
          : null;

      // ⚠️ **补差入口的判据**：正常单已 `PAID`（这一期已结清过一次）
      //    **且**仍有未被任何单纳入的货款。
      //    ⚠️ **正常单还在飞（REQUESTED / APPROVED / PROCESSING）时不给入口** ——
      //    否则会出现「两张单同时在飞」。
      //    ⚠️⚠️ **已有活跃补差单时也不给入口**（护栏 X8，5h-2 的规则）：
      //    补差单**不允许再叠** —— 即使这一期后来又回填了货款，
      //    也不能在已有补差单在飞时再开一张（那会让商家拿到两张补差单）。
      //    ⚠️ **这是「规格给的映射表」与「5h-2 既有行为」的一处冲突**：
      //    规格表只写了 `normalPaid && supplementAmount > 0`，
      //    那样写会让「已 `PAID` 的正常单 + 活跃补差单」这一期
      //    **凭空多出一个补差入口** → 违反护栏 X8 → 已按 5h-2 的规则修正。
      const supplementAmount =
        !amounts.hasActiveSupplement &&
        amounts.normalPaid &&
        (amounts.supplementAmount ?? 0) > 0
          ? amounts.supplementAmount
          : null;

      // ⚠️ **没有活跃单时按 5h-1 的规则跳过**（含「正常单是
      //    REJECTED / CANCELLED / FAILED」的情况 → 走正常路径重新申请）
      if (!amounts.hasActiveNormal && !amounts.hasActiveSupplement) {
        if (amounts.receiptCount === 0 || netAmount <= 0) {
          continue;
        }
      }

      views.push({
        period,
        receiptAmount: amounts.receiptAmount,
        commissionAmount,
        netAmount,
        entryCount: amounts.receiptCount,
        statementStatus: amounts.statementStatus,
        alreadyApplied: appliedKind !== null,
        appliedKind,
        supplementAvailable: supplementAmount !== null,
        supplementAmount,
      });
    }
    return views;
  }
  /**
   * 出款单的明细（关联的货款流水）。
   *
   * ⚠️ **必须校验归属**（护栏 P9）：`payout_entries` **不在**租户白名单里
   * → 扩展不附加任何过滤 → 这里查到的是全局事实。
   *
   * ⚠️ **两道校验都要有**：
   * ① 调用方先确认 `payout` 是本租户的（商家侧靠租户作用域的
   *    `findFirst` 自动过滤；平台侧是显式查出来的）；
   * ② 这里再查流水时**带上 `payout.tenantId`** ——
   *    脏数据可能把别家的流水关联到这张单上（`payout_entries` 上
   *    没有 tenantId 约束），不带条件就会把别家的订单号显示给商家。
   */
  private async entriesOf(payout: {
    id: string;
    tenantId: string;
  }): Promise<PayoutEntryView[]> {
    const links = await this.prisma.payoutEntry.findMany({
      where: { payoutId: payout.id },
    });
    if (links.length === 0) {
      return [];
    }
    const receipts = await this.prisma.merchantReceipt.findMany({
      // ⚠️ **带上 tenantId**：别家的流水一律查不到 → 不会显示给商家。
      where: {
        tenantId: payout.tenantId,
        id: { in: links.map((link) => link.entryId) },
      },
    });
    const byId = new Map(receipts.map((r) => [r.id, r]));
    // ⚠️ **用 flatMap 而不是 `map` + 类型谓词**：`PayoutEntryView.type`
    //    声明的是 `string`，而 `MerchantReceipt.type` 是 `ReceiptType` 枚举 ——
    //    类型谓词要求「断言的类型可赋给参数类型」，枚举 → string 的方向不成立。
    const entries: PayoutEntryView[] = links.flatMap((link) => {
      const receipt = byId.get(link.entryId);
      if (!receipt) {
        return [];
      }
      return [
        {
          entryId: receipt.id,
          orderNo: receipt.orderNo,
          type: receipt.type,
          amount: receipt.amount,
          occurredAt: receipt.occurredAt.toISOString(),
        },
      ];
    });
    return entries.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
  /**
   * 商家端看到的失败原因（**业务口径**，阶段 5l）。
   *
   * ⚠️ **按「钱打没打出去」分流** —— 这顺带解决了 5k 的遗留 5
   *    （「`FAILED` 承载了两种语义」）：
   * - **确定没打**（`failedBeforePayout = true`）→ 商家能**做点什么**
   *   （更新收款账户后重新申请）；
   * - **可能已打**（`false`）→ 商家只能**去核对**（可能钱已经到账了）。
   *
   * ⚠️ **第二类为什么不能说「是否已到账」** —— 那会让商家以为「可能没到」，
   *    而实际是「可能已经到了，请去查」。
   *
   * ⚠️ **第二类必须换成通用措辞** —— 那批值是**渠道侧的原文**
   *    （「渠道金额核对不通过（请求 9000 分，渠道返回 9001 分）」
   *    「假出款网关模拟的失败（第 3 次尝试）」），带内部术语与数字，
   *    商家看到只会困惑。原文只在平台端的 `failureDetail` 里。
   *
   * ⚠️⚠️ **第一类按白名单透传** —— 「渠道从未被调用」那几处写入的值
   *    **本来就是给商家看的措辞**（见 `MERCHANT_SAFE_FAILURE_REASONS`），
   *    解密失败的根因只进日志、从不进 `failureReason`。
   *    → 在这里统一替换成一句笼统的话反而会**说错原因**
   *    （金额异常的单被告知「收款账号信息异常」→ 商家去改收款账户，
   *    改完再申请还是同样的错 → 白跑一趟）。
   *
   *    但**白名单之外的一律替换成通用措辞** —— `failureReason` 是
   *    调用方传进来的字符串，将来有人往这个桶里写进内部术语时，
   *    商家端不会跟着泄出去（**默认安全**）。
   *
   * ⚠️⚠️ **兜底措辞不能借用白名单里的某一条**（阶段 6b 修正）：
   *    阶段 6b 起，「渠道明确拒付 + 重试预算用完」也会落进
   *    `failedBeforePayout = true`，它的原文是渠道侧措辞（「假出款网关
   *    模拟的失败（第 3 次尝试）」）。以前兜底会回落到白名单第一条
   *    「收款账号信息异常…」—— 那是一句**说错原因**的话：商家会跑去改
   *    收款账户，改完再申请还是同样的错。兜底必须是一句**不含原因**的中性话。
   */
  private merchantFailureReason(payout: Payout): string | null {
    if (!payout.failureReason) return null;
    if (payout.failedBeforePayout) {
      return MERCHANT_SAFE_FAILURE_REASONS.includes(payout.failureReason)
        ? payout.failureReason
        : MERCHANT_GENERIC_NOT_SENT_REASON;
    }
    return '出款未完成，请联系平台确认出款情况';
  }
  /** 单据 → 对外字段（租户视角） */
  toView(payout: Payout): PayoutView {
    return {
      id: payout.id,
      payoutNo: payout.payoutNo,
      kind: payout.kind,
      periodStart: payout.periodStart.toISOString(),
      periodEnd: payout.periodEnd.toISOString(),
      periodLabel: formatPeriodLabel(payout.periodStart),
      receiptAmount: payout.receiptAmount,
      commissionAmount: payout.commissionAmount,
      netAmount: payout.netAmount,
      entryCount: payout.entryCount,
      status: payout.status,
      requestedAmount: payout.requestedAmount,
      statementId: payout.statementId,
      requestedBy: payout.requestedBy,
      approvedBy: payout.approvedBy,
      rejectedReason: payout.rejectedReason,
      requestedAt: payout.requestedAt.toISOString(),
      approvedAt: payout.approvedAt?.toISOString() ?? null,
      cancelledAt: payout.cancelledAt?.toISOString() ?? null,
      payoutChannel: payout.payoutChannel,
      payoutTxnId: payout.payoutTxnId,
      attemptCount: payout.attemptCount,
      // ⚠️ **业务口径，不是原文**（阶段 5l）——
      //    原文可能是渠道的异常（带主机名、请求 id）或内部的解密信息，
      //    商家看到的是**内部术语**。
      //    ⚠️ **默认安全**：共用视图给业务口径 → 新增端点若用 `toView`，
      //    默认就是脱敏的；只有平台端视图额外暴露原文（`failureDetail`）。
      failureReason: this.merchantFailureReason(payout),
      // ⚠️ **「钱确定没打出去」的标记**（阶段 5l）——
      //    平台端的「重试」按钮只对 true 的单出现；
      //    商家端也拿它（前端据此给商家不同的提示）。
      failedBeforePayout: payout.failedBeforePayout,
      processingAt: payout.processingAt?.toISOString() ?? null,
      paidAt: payout.paidAt?.toISOString() ?? null,
      failedAt: payout.failedAt?.toISOString() ?? null,
      snapshotAccountName: payout.snapshotAccountName,
      snapshotBankName: payout.snapshotBankName,
      // ⚠️ **脱敏** —— 快照里的账号是打款的依据（存的是密文），
      //    但**即便解密也绝不能**出现在 API 响应里（护栏 X14）。
      //    这里读的是**预存的掩码串**，不解密。
      maskedSnapshotAccountNo: payout.snapshotMaskedAccountNo ?? null,
      createdAt: payout.createdAt.toISOString(),
    };
  }
  /** 单据 → 对外字段（平台视角，多商家名） */
  async toPlatformView(payout: Payout): Promise<PlatformPayoutView> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: payout.tenantId },
      select: { name: true, subdomain: true },
    });
    return {
      ...this.toView(payout),
      tenantId: payout.tenantId,
      // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行。
      tenantName: tenant?.name ?? payout.tenantId,
      subdomain: tenant?.subdomain ?? '—',
      // ⚠️ **渠道侧的原文**（只有平台端有）—— 超管排查要靠它。
      //    ⚠️ **三条护栏**：只在 FAILED 时返回、长度截断、去换行。
      failureDetail: this.platformFailureDetail(payout),
    };
  }
  /**
   * 平台端看到的失败详情（**渠道侧的原文**，阶段 5l）。
   *
   * ⚠️ **它看不到解密根因** —— 那是 5k 的遗留 4（根因只进日志，
   *    从不进 `failureReason`）。界面上要写清这一点。
   *
   * ⚠️ **三条护栏**：只在 `FAILED` 时返回、长度截断、去掉换行
   *    （原文可能带 `\n` → 直接渲染会破坏界面布局）。
   */
  private platformFailureDetail(payout: Payout): string | null {
    if (payout.status !== PayoutStatus.FAILED) return null;
    const raw = payout.failureReason;
    if (!raw) return null;
    const text = raw.replace(/\r?\n/g, ' ').trim();
    if (!text) return null;
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
  /**
   * 一批单据 → 平台视角（**避免 N+1**）。
   *
   * ⚠️ **一次查回所有商家**，而不是每条单据查一次商家名 ——
   *    `pageSize` 上限 100，逐条查就是 101 次查询。
   *    （与 5g 的 `toViews` 同款做法。）
   */
  private async toPlatformViews(
    payouts: Payout[],
  ): Promise<PlatformPayoutView[]> {
    const tenantIds = [...new Set(payouts.map((p) => p.tenantId))];
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, subdomain: true },
    });
    const byId = new Map(tenants.map((t) => [t.id, t]));

    return payouts.map((payout) => {
      const tenant = byId.get(payout.tenantId);
      return {
        ...this.toView(payout),
        tenantId: payout.tenantId,
        // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行。
        tenantName: tenant?.name ?? payout.tenantId,
        subdomain: tenant?.subdomain ?? '—',
        // ⚠️ **批量版也要给 `failureDetail`** —— 漏了列表页就没有它
        failureDetail: this.platformFailureDetail(payout),
      };
    });
  }
  /** 列表的查询条件（商家侧与平台侧同款） */
  private buildWhere(query: { status?: PayoutStatus; period?: string }): {
    status?: PayoutStatus;
    periodStart?: Date;
  } {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.period
        ? { periodStart: resolveMonthlyPeriod(query.period).from }
        : {}),
    };
  }
}
