import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PayoutStatus, SettlementStatus, type Payout } from '@prisma/client';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { clampPagination } from '../../common/http/pagination';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { formatPeriodLabel, resolveMonthlyPeriod } from './settlement';

interface Paging {
  page?: number;
  pageSize?: number;
}

/**
 * 出款单的服务层（阶段 5h-1）。
 *
 * ⚠️ **金额三件套站在「商家应收」角度**：`commissionAmount` 是**正数**
 * （平台抽了多少，与结算单的 `netAmount` 同号），
 * `netAmount = receiptAmount − commissionAmount` 是应结给商家的钱。
 * ⚠️ **别把结算单那套「冲回是负数」的符号搬过来** —— 这一类已坑过两次。
 *
 * ⚠️ **商家侧与平台侧的鉴权路径完全不同**：商家侧靠租户作用域扩展
 * 自动过滤（`payouts` 在白名单里），平台侧要显式 `platformScope()`。
 */

/** 出款单的对外形状（租户视角） */
export interface PayoutView {
  id: string;
  payoutNo: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  /** 货款净额（正数） */
  receiptAmount: number;
  /** 佣金净额（正数 = 平台抽了多少） */
  commissionAmount: number;
  /** 应结给商家的金额 */
  netAmount: number;
  entryCount: number;
  status: PayoutStatus;
  /** 申请时的预估金额（与 `netAmount` 可能不同 —— 审批时会重算） */
  requestedAmount: number;
  statementId: string | null;
  requestedBy: string;
  approvedBy: string | null;
  rejectedReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** 出款单明细的一行 */
export interface PayoutEntryView {
  entryId: string;
  orderNo: string;
  type: string;
  amount: number;
  occurredAt: string;
}

/** 出款单详情（含明细） */
export interface PayoutDetailView extends PayoutView {
  entries: PayoutEntryView[];
}

/** 平台视角：多商家名与子域名 */
export interface PlatformPayoutView extends PayoutView {
  tenantId: string;
  tenantName: string;
  subdomain: string;
}

/** 可申请周期的预览（商家端「申请出款」页用） */
export interface AvailablePeriodView {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  /** 该期结算单的状态；null = 该期没有结算单（零额抽佣） */
  statementStatus: SettlementStatus | null;
  /** 该期是否已有活跃出款单 */
  alreadyApplied: boolean;
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 商家申请出款（指定自然月）。
   *
   * ⚠️ **幂等检查放最前**：该期已有活跃出款单 → **原样返回它**
   * （不报错、不重算金额 —— 金额已锁定）。
   * 商家重复提交是网络重试或手滑，报错会让商家以为申请失败。
   */
  async apply(input: { period: string }): Promise<PayoutView> {
    const period = resolveMonthlyPeriod(input.period);
    const context = getTenantContext();
    const tenantId = context.tenantId;
    const userId = context.userId;

    if (!tenantId || !userId) {
      throw new BadRequestException('缺少租户或用户上下文');
    }

    // ⚠️ **幂等分支在最前**：先查「该期有没有活跃单」。
    // 查的时候**必须带上状态条件** —— REJECTED / CANCELLED 的单不占位，
    // 商家要能重新申请（部分唯一索引也是这个条件）。
    // ⚠️ **不手写 tenantId**：靠租户作用域扩展自动附加。
    const existing = await this.findActivePayout(period.from);
    if (existing) {
      return this.toView(existing);
    }

    // ⚠️ **周期必须已结束**：周期内的流水还会变（回填随时可能补进来），
    // 此时的数字不是凭证。与结算单的 D7 同一理由。
    const now = await this.prisma.databaseNow();
    if (period.to.getTime() > now.getTime()) {
      throw new BadRequestException(
        `周期 ${period.label} 尚未结束，不能申请出款`,
      );
    }

    // ⚠️ **收款账户必须先填**：没有账户就不知道钱打给谁。
    // ⚠️ **不手写 tenantId**：商家侧靠租户作用域扩展自动附加。
    const account = await this.prisma.merchantPayoutAccount.findFirst({
      where: {},
    });
    if (!account) {
      throw new BadRequestException('请先在「出款」页设置收款账户');
    }

    const amounts = await this.computeAmounts(tenantId, period);

    // ⚠️ **结算单必须已确认**（护栏 P3）：不能拿一张草稿单当佣金依据。
    this.assertStatementConfirmed(amounts, period.label);

    if (amounts.entryCount === 0) {
      throw new BadRequestException(
        `该期（${period.label}）没有货款流水，无法申请出款`,
      );
    }
    if (amounts.netAmount <= 0) {
      throw new BadRequestException(
        `该期（${period.label}）没有应结金额（货款净额 ${amounts.receiptAmount} 分、` +
          `佣金 ${amounts.commissionAmount} 分），无法申请出款`,
      );
    }

    const payoutNo = generatePayoutNo(now);
    let created: Payout;
    try {
      created = await this.prisma.$transaction(
        async (tx) => {
          const payout = await tx.payout.create({
            data: {
              tenantId,
              payoutNo,
              periodStart: period.from,
              periodEnd: period.to,
              statementId: amounts.statementId,
              receiptAmount: amounts.receiptAmount,
              commissionAmount: amounts.commissionAmount,
              netAmount: amounts.netAmount,
              entryCount: amounts.entryCount,
              status: PayoutStatus.REQUESTED,
              requestedAmount: amounts.netAmount,
              requestedBy: userId,
            },
          });
          // ⚠️ **申请时就固定纳入的流水**（设计 D7）：
          // 审批期间又来一笔流水时，出款范围不悄悄变化。
          await tx.payoutEntry.createMany({
            data: amounts.entryIds.map((entryId) => ({
              payoutId: payout.id,
              entryId,
            })),
          });
          return payout;
        },
        { maxWait: 10_000, timeout: 10_000 },
      );
    } catch (error) {
      // ⚠️ **并发申请会撞唯一索引**：`payouts` 的「同一商家同一周期一张活跃单」
      // 是**部分唯一索引**（`WHERE status NOT IN ('REJECTED','CANCELLED')`）——
      // **Prisma 的 schema 层感知不到它**（`@@unique` 表达不了 WHERE 子句，
      // 它只存在于迁移 SQL 里）。两个并发申请会**同时**通过上面的前置查，
      // 然后其中一个撞索引 → P2002。
      //
      // ⚠️ **不能把 P2002 当错误抛出去**：对商家来说「你已经申请过了」
      // 不是失败。→ 重新查一次，拿到对方刚建的那张，幂等返回。
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const raced = await this.findActivePayout(period.from);
      if (!raced) {
        // ⚠️ **撞的不是活跃周期那条索引**（例如 `payoutNo` 撞了）
        //    → 原样抛出，**不伪装成「重复申请」**。
        throw error;
      }
      return this.toView(raced);
    }

    this.logger.log(
      `出款申请已创建：${payoutNo}（${period.label}，${amounts.netAmount} 分）`,
    );
    return this.toView(created);
  }

  /**
   * 商家撤回申请（仅 `REQUESTED` 可撤）。
   *
   * ⚠️ **条件更新**（where 带 status）：与平台审批并发时，
   * 两个更新只有一个能成功，另一个拿到 409。
   */
  async cancel(payoutId: string): Promise<PayoutView> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new BadRequestException('缺少租户上下文');
    }

    // ⚠️ **先查后判**：查不到就是不存在或不是本租户的 → 404。
    // ⚠️ **别把「不是我的」说成「不存在」** —— 那是信息泄露（能区分
    // 「单号不存在」与「单号存在但不是你的」）。
    const payout = await this.prisma.payout.findFirst({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('出款单不存在');
    }

    const now = await this.prisma.databaseNow();
    const updated = await this.prisma.$transaction(async (tx) => {
      const affected = await tx.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.REQUESTED },
        data: { status: PayoutStatus.CANCELLED, cancelledAt: now },
      });
      if (affected.count === 0) {
        throw new ConflictException(
          `出款单当前是「${payout.status}」状态，不能撤回`,
        );
      }
      // ⚠️ **释放明细占用**（护栏 P2 的另一半）：
      //    `payout_entries.entryId` 是**全局唯一索引** —— 撤回的这张单
      //    若还占着那些流水，商家重新申请同一周期时 `createMany` 会撞索引
      //    → P2002 → 500。撤回的单没打钱，那些流水本就该放回去。
      await tx.payoutEntry.deleteMany({ where: { payoutId } });
      return tx.payout.findFirst({ where: { id: payoutId } });
    });

    if (!updated) {
      throw new NotFoundException('出款单不存在');
    }
    return this.toView(updated);
  }

  /**
   * 平台审批：**通过**（重算并锁定金额）。
   *
   * ⚠️ **重算金额**（护栏 P5）：不采信申请时的预估 —— 从申请到审批之间，
   * 流水可能补进来了、结算单可能被重算了。锁定的是**审批那一刻**的值。
   */
  async approve(payoutId: string): Promise<PlatformPayoutView> {
    const context = getTenantContext();
    const userId = context.userId;
    if (!userId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️ **重算**：用的是与申请时完全相同的两条数据源。
      const period = { from: payout.periodStart, to: payout.periodEnd };
      const amounts = await this.computeAmounts(payout.tenantId, period);

      // ⚠️ **结算单必须已确认**（护栏 P3）：审批那一刻它要是已经不是
      //    CONFIRMED 了（被取消确认过、或被重算回草稿），
      //    锁定的佣金就是拿草稿单算的 → 账不对。
      //
      //    ⚠️ **在 5h-1 内这条检查其实走不到**：结算单要从 CONFIRMED
      //    回到 DRAFT 只有「取消确认」一条路，而 5g 的 `recalculate` 只接受
      //    DRAFT 的单 → 必须先取消确认；而取消确认被护栏 P6 挡着
      //    （这张单已被出款单引用）→ 回不到 DRAFT。
      //    **保留它是防御性的**：P6 的语义若变化（5h-2 允许某些状态取消确认），
      //    这道检查立刻生效，而那时没人会记得它曾经存在。
      this.assertStatementConfirmed(
        amounts,
        formatPeriodLabel(payout.periodStart),
      );

      // ⚠️ **重算后必须仍是正的应结金额**（与 `apply` 同款的两道闸）：
      //    申请与审批之间流水可能变了（订单退款冲回、回填补进一笔）。
      //    冲回占优时净额会变成 0 甚至负数 —— 锁进 APPROVED 的单，
      //    5h-2 的出款流程会**按这个数打款**。
      //    ⚠️ **平台打款给商家一个负数**是「平台倒欠商家」，
      //    那是调账的事，不该由出款这条路走。
      if (amounts.entryCount === 0) {
        throw new ConflictException(
          `该期（${formatPeriodLabel(payout.periodStart)}）已无货款流水，不能审批出款`,
        );
      }
      if (amounts.netAmount <= 0) {
        throw new ConflictException(
          `该期（${formatPeriodLabel(payout.periodStart)}）重算后的应结金额已非正数` +
            `（货款净额 ${amounts.receiptAmount} 分、佣金 ${amounts.commissionAmount} 分），不能审批出款`,
        );
      }

      const now = await this.prisma.databaseNow();
      const affected = await this.prisma.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.REQUESTED },
        data: {
          status: PayoutStatus.APPROVED,
          approvedBy: userId,
          approvedAt: now,
          // ⚠️ **锁定的是重算后的值**：`requestedAmount` 保留申请时的预估，
          // 两者的差异由审批人自己判断（不设阈值、不强制填原因）。
          receiptAmount: amounts.receiptAmount,
          commissionAmount: amounts.commissionAmount,
          netAmount: amounts.netAmount,
          entryCount: amounts.entryCount,
          statementId: amounts.statementId,
        },
      });
      if (affected.count === 0) {
        throw new ConflictException('出款单已被审批或状态已变，不能重复审批');
      }

      const updated = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }
      return this.toPlatformView(updated);
    });
  }

  /**
   * 平台审批：**拒绝**（必须给原因）。
   *
   * ⚠️ **原因必填**：没有原因的拒绝对商家毫无意义 —— 商家不知道该改什么，
   * 只能打电话问客服。
   */
  async reject(payoutId: string, reason: string): Promise<PlatformPayoutView> {
    const trimmed = reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('拒绝出款必须填写原因');
    }

    const context = getTenantContext();
    const userId = context.userId;
    if (!userId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **先查存在性再判状态**：与 `approve` 对齐。
      //    只靠 `updateMany` 的 `affected.count === 0` 的话，
      //    「单号写错了」与「单子已处理」是同一个 409 —— 排查时无法区分。
      const existing = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!existing) {
        throw new NotFoundException('出款单不存在');
      }

      const now = await this.prisma.databaseNow();
      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.REQUESTED },
          data: {
            status: PayoutStatus.REJECTED,
            approvedBy: userId,
            // ⚠️ **审批时间与审批人同填**：填了人却没填时间，
            //    视图里会出现「审批人 admin-a / 审批时间 null」的矛盾组合。
            approvedAt: now,
            rejectedReason: trimmed,
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单已被处理或状态已变，不能重复审批');
        }
        // ⚠️ **释放明细占用**：被拒的单没打钱，它占着的货款流水
        //    该放回去让商家重新申请（否则撞 `payout_entries` 的唯一索引 → 500）。
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        return tx.payout.findFirst({ where: { id: payoutId } });
      });

      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }
      return this.toPlatformView(updated);
    });
  }

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

  /** 平台的出款单详情（含明细与商家名） */
  async detailForPlatform(
    payoutId: string,
  ): Promise<PlatformPayoutView & { entries: PayoutEntryView[] }> {
    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      const entries = await this.entriesOf(payout);
      return { ...(await this.toPlatformView(payout)), entries };
    });
  }

  /**
   * 商家可申请的周期列表（**金额由后端算**，商家据此选周期）。
   *
   * ⚠️ **只列出真正能申请的周期**：周期已结束 + 有货款流水 + 应结 > 0。
   * 列出一堆不能申请的周期，商家挨个试才知道哪个能申请。
   */
  async availablePeriods(): Promise<AvailablePeriodView[]> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new BadRequestException('缺少租户上下文');
    }

    const now = await this.prisma.databaseNow();

    // ⚠️ **只查已结束的周期**：`occurredAt < now` 的月份才可能已结束。
    // ⚠️ **不手写 tenantId**：商家侧靠租户作用域扩展自动附加。
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { occurredAt: { lt: now } },
      orderBy: { occurredAt: 'desc' },
    });

    // ⚠️ **按月分组**：流水是逐笔的，周期是月的。
    //    这里只要**周期清单**（金额由 `computeAmounts` 重新算，
    //    不复用这里的求和 —— 两处口径漂了账就错了）。
    const periodLabels = new Set<string>();
    for (const receipt of receipts) {
      periodLabels.add(formatPeriodLabel(receipt.occurredAt));
    }

    const periods = [...periodLabels].sort((a, b) => b.localeCompare(a));

    const views: AvailablePeriodView[] = [];
    for (const period of periods) {
      const resolved = resolveMonthlyPeriod(period);
      if (resolved.to.getTime() > now.getTime()) {
        continue;
      }
      const amounts = await this.computeAmounts(tenantId, resolved);
      if (amounts.entryCount === 0 || amounts.netAmount <= 0) {
        continue;
      }
      const applied = await this.prisma.payout.findFirst({
        where: {
          periodStart: resolved.from,
          status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED] },
        },
        select: { id: true },
      });
      views.push({
        period,
        receiptAmount: amounts.receiptAmount,
        commissionAmount: amounts.commissionAmount,
        netAmount: amounts.netAmount,
        entryCount: amounts.entryCount,
        statementStatus: amounts.statementStatus,
        alreadyApplied: !!applied,
      });
    }
    return views;
  }

  /**
   * 结算单必须是已 `CONFIRMED` 的状态（护栏 P3）。
   *
   * ⚠️ **只在「申请」与「审批」这两个动作上校验**，不在取数的地方校验：
   * 「可申请周期」列表要照常显示未确认的周期（带 `statementStatus`），
   * 在那里抛异常会把整个列表打成 409。
   */
  private assertStatementConfirmed(
    amounts: { statementStatus: SettlementStatus | null },
    periodLabel: string,
  ): void {
    if (
      amounts.statementStatus !== null &&
      amounts.statementStatus !== SettlementStatus.CONFIRMED
    ) {
      throw new ConflictException(
        `该期（${periodLabel}）的结算单尚未确认，不能申请出款`,
      );
    }
  }

  /**
   * 算某一期的应结金额。
   *
   * ⚠️ **两侧口径**：
   * - 货款净额 = 该期 `merchant_receipts` 的金额之和
   * - 佣金净额 = 该期**已 CONFIRMED** 的结算单的 `netAmount`（没有结算单 → 0）
   *
   * ⚠️ **佣金取结算单的 `netAmount`，不是重新聚合抽佣流水** ——
   * 结算单是**已确认的凭证**，以它为准；重新聚合会与结算单的冻结值对不上。
   *
   * ⚠️ **这里必须显式带 `tenantId`**：本方法**同时**被商家侧（`apply`）
   *    与平台侧（`approve`，跑在 `platformScope()` 下）调用 ——
   *    平台作用域下扩展**不附加** tenantId 条件，不带就会跨租户取数。
   *    商家侧带着它是冗余的（同值，扩展会覆盖成同一个），但不能省。
   */
  private async computeAmounts(
    tenantId: string,
    period: { from: Date; to: Date },
  ): Promise<{
    receiptAmount: number;
    commissionAmount: number;
    netAmount: number;
    entryCount: number;
    entryIds: string[];
    statementId: string | null;
    statementStatus: SettlementStatus | null;
  }> {
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: {
        tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });

    const receiptAmount = receipts.reduce((sum, r) => sum + r.amount, 0);

    // ⚠️ **这里只取数，不抛异常**：结算单有没有确认，由调用方按场景判断。
    //    「可申请周期」列表（`availablePeriods`）要**照常返回**未确认的周期
    //    （它得显示 `statementStatus` 告诉商家「这期还没确认」）——
    //    在这里抛会把整个列表接口打成 409，商家连别的周期都看不到。
    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart: period.from },
    });

    const commissionAmount = statement ? statement.netAmount : 0;

    return {
      receiptAmount,
      commissionAmount,
      netAmount: receiptAmount - commissionAmount,
      entryCount: receipts.length,
      entryIds: receipts.map((r) => r.id),
      statementId: statement?.id ?? null,
      statementStatus: statement?.status ?? null,
    };
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
   * 查该期有没有活跃出款单（幂等检查用）。
   *
   * ⚠️ **只在商家侧（租户作用域）调用** —— 所以**不手写 tenantId**，
   *    靠扩展自动附加。
   */
  private async findActivePayout(periodStart: Date): Promise<Payout | null> {
    return this.prisma.payout.findFirst({
      where: {
        periodStart,
        status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED] },
      },
    });
  }

  /** 单据 → 对外字段（租户视角） */
  private toView(payout: Payout): PayoutView {
    return {
      id: payout.id,
      payoutNo: payout.payoutNo,
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
      createdAt: payout.createdAt.toISOString(),
    };
  }

  /** 单据 → 对外字段（平台视角，多商家名） */
  private async toPlatformView(payout: Payout): Promise<PlatformPayoutView> {
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
    };
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

/**
 * 生成出款单号。
 *
 * ⚠️ **服务端生成**：出款单号不是秘密（它出现在对账单里），
 * 但**不能由客户端指定** —— 否则「A 单号对应 B 商家的账」就可能发生。
 *
 * ⚠️ **秒级时间戳 + 4 位随机数**：同一秒内生成 10000 张才会撞一次
 * （与 5g 的 `generateStatementNo` 同款）。
 */
function generatePayoutNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `PAY${stamp}${random}`;
}
