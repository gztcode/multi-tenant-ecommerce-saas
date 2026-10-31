import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PayoutKind,
  PayoutStatus,
  SettlementStatus,
  type Payout,
} from '@prisma/client';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { clampPagination } from '../../common/http/pagination';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { QueueService } from '../queue/queue.service';
import { LedgerService } from './ledger.service';
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
  /** 出款类型：正常 / 补差（阶段 5h-2） */
  kind: PayoutKind;
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
  /** 打款渠道名（`PAID` / `PROCESSING` 时有值） */
  payoutChannel: string | null;
  /** 渠道交易号 */
  payoutTxnId: string | null;
  /** 已尝试次数（含首次） */
  attemptCount: number;
  /**
   * 最近一次失败的原因（**业务口径**，阶段 5l）。
   *
   * ⚠️ **不是原文** —— 原文可能是渠道的异常（带主机名、请求 id）或内部的
   *    解密信息，商家看到的是**内部术语**。
   *    渠道原文只在平台端的 `failureDetail` 里。
   */
  failureReason: string | null;
  /**
   * 「钱确定没打出去」的标记（阶段 5l）。
   *
   * ⚠️ **`true` = 渠道从未被调用 → 可安全重试**；
   *    `false` = 钱**可能已经打出去** → 不能重试，只能人工核对渠道。
   *
   * ⚠️ **不能靠 `failureReason` 的文案推断** —— 文案会被改、会被手工编辑。
   *    判断依据必须是**打款动作有没有发生**。
   */
  failedBeforePayout: boolean;
  /** 开始执行的时刻 */
  processingAt: string | null;
  /** 打款成功时刻 */
  paidAt: string | null;
  /** 失败落终态的时刻 */
  failedAt: string | null;
  /** 收款账户快照（户名） */
  snapshotAccountName: string | null;
  /** 收款账户快照（开户行） */
  snapshotBankName: string | null;
  /**
   * 收款账户快照（**账号脱敏**）。
   *
   * ⚠️ **快照里的账号是密文，但即便解开了也绝不能原样进 API 响应**
   *    （护栏 X14）—— 它是打款的依据，只给脱敏版。
   */
  maskedSnapshotAccountNo: string | null;
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
  /**
   * 渠道侧的失败原文（**只有平台端有**，阶段 5l）。
   *
   * ⚠️ **只在 `FAILED` 时非 null**；长度截断到 500；去掉换行。
   */
  failureDetail: string | null;
}

/**
 * 人工操作留痕的一行（阶段 5l）。
 *
 * ⚠️ **只在平台端详情接口返回** —— 列表接口没有（避免 N+1）。
 */
export interface PayoutOperationView {
  id: string;
  /** `RETRY` / `UNSTUCK_TO_FAILED` / `UNSTUCK_TO_APPROVED` */
  action: string;
  /** 操作人（平台超管的用户 id） */
  operatorId: string;
  /**
   * 操作人的显示名。
   *
   * ⚠️ **查不到人时回落到 `operatorId`** —— 账号被删了也不能让留痕消失。
   */
  operatorName: string;
  /** 操作时刻（ISO 8601） */
  operatedAt: string;
  /** 操作原因（必填 —— 涉及钱的操作不能没有理由） */
  reason: string;
  /** 操作前的状态 */
  fromStatus: string;
  /** 操作后的状态 */
  toStatus: string;
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
  /** 该期是否已有活跃出款单（正常或补差都算） */
  alreadyApplied: boolean;
  /**
   * 该期活跃单的种类；null = 没有活跃单。
   *
   * ⚠️ **商家端靠它区分「点哪个按钮」**（设计 §6.4b）。
   */
  appliedKind: PayoutKind | null;
  /**
   * 该期还能不能申请补差（正常单已 `PAID` 且仍有未纳入流水）。
   *
   * ⚠️ **不能只看 `alreadyApplied` 就禁用按钮** —— 正常单 `PAID` 后
   *    `alreadyApplied = true`，若直接禁用，**补差入口就此消失**。
   */
  supplementAvailable: boolean;
  /** 补差金额（整数分）；`supplementAvailable = false` 时为 null */
  supplementAmount: number | null;
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  /**
   * ⚠️ **注入 `QueueService`**（阶段 5h-2）：审批通过后要把出款单
   *    **异步**投到 `PAYOUT_QUEUE`，由 worker 去调渠道打款。
   *
   * ⚠️ **`billing` import `queue` 是安全的** —— `QueueModule` 是 `@Global()`，
   *    且 `queue.service.ts` 里没有任何渠道代码（不构成 `billing → payment` 的环）。
   *
   * ⚠️ **注入 `LedgerService`**（阶段 5i Task 6）：「可申请周期」列表
   *    原本逐期循环调 `computeAmounts`（每期 3 次查询）→ 期数一多就是 N+1。
   *    `LedgerService.aggregatePeriods` 把「N 期 × 3 次」压成**固定 6 次**。
   */
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * 商家申请出款（指定自然月）。
   *
   * ⚠️ **幂等检查放最前**：该期已有活跃出款单 → **原样返回它**
   * （不报错、不重算金额 —— 金额已锁定）。
   * 商家重复提交是网络重试或手滑，报错会让商家以为申请失败。
   *
   * ⚠️ **阶段 5h-2：按 `kind` 分两条路** —— 正常单（第一次出款）与
   *    补差单（该期已 `PAID` 之后又回填进来的货款）。
   */
  async apply(input: { period: string }): Promise<PayoutView> {
    const period = resolveMonthlyPeriod(input.period);
    const context = getTenantContext();
    const tenantId = context.tenantId;
    const userId = context.userId;

    if (!tenantId || !userId) {
      throw new BadRequestException('缺少租户或用户上下文');
    }

    // ⚠️ **幂等分支在最前**（5h-1 的教训）：
    //    商家重复提交是网络重试，报错会让商家以为申请失败。
    //
    // ⚠️ **正常单与补差单分开查** —— 索引是 `(tenantId, periodStart, kind)`
    //    三元组，同期可以各有一张（设计 §5.2）。
    const existingNormal = await this.findActivePayout(
      period.from,
      PayoutKind.NORMAL,
    );
    // ⚠️⚠️ **必须排除 `PAID`** —— `PAID` 的正常单**也是「活跃单」**
    //    （它占着 `(tenantId, periodStart, kind)` 的索引位，
    //    且 `findActivePayout` 的 `notIn` 与部分唯一索引的 `WHERE` 一致，
    //    都不含 `PAID`）。
    //
    //    若这里把 `PAID` 的单也返回了，后面的「有 `PAID` 的正常单 →
    //    走补差路径」就**永远到不了** → **补差路径不可达**，
    //    商家在申请页看到「可申请补差」，点了却拿回那张已出款的旧单，
    //    补差单从未被创建，钱永远没打。
    //
    // ⚠️ `PAID` 的正常单意味着「这一期已经结清了」——
    //    此后再来申请，只能是**回填之后的补差**。
    if (existingNormal && existingNormal.status !== PayoutStatus.PAID) {
      return this.toView(existingNormal);
    }
    const existingSupplement = await this.findActivePayout(
      period.from,
      PayoutKind.SUPPLEMENT,
    );
    if (existingSupplement) {
      return this.toView(existingSupplement);
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
      // ⚠️ **指引要指向准确的位置** —— 账户设置页在 `/settlements/account`，
      //    「出款」页是申请出款的地方，商家在出款列表页找不到入口。
      throw new BadRequestException('请先在「收款账户」页设置收款账户');
    }
    // ⚠️⚠️ **写路径也要查加密版本**（阶段 5j）：
    //    读路径（`payout-execution.service.ts` 的 `decryptVersioned`）遇到
    //    未迁移的行会抛错 —— 但**写路径漏掉这道闸**的话，
    //    快照里就会装进**明文账号**（`accountNoCipher` 列装的是明文），
    //    等于在新表里第一次出现明文副本，
    //    而且打款时必然抛错 → 出款单卡在 `PROCESSING` 反复重试。
    //    宁可在建单前就拒掉，也不要造出一张注定打不出钱的单。
    if (account.encryptionVersion !== 1) {
      throw new BadRequestException(
        '收款账户尚未完成加密迁移，请先执行 `npm run migrate:payout-encryption`',
      );
    }

    // ⚠️⚠️ **决定走哪条路径**（设计 §6.4）：
    // 「该期有没有已出款的正常单」决定这是**第一次**出款（正常单）
    // 还是**回填之后**的补差（补差单）。
    //
    // ⚠️ **必须是「已 `PAID` 的正常单」而不是「任意正常单」**：
    // `FAILED` 的正常单要走正常路径 —— 重新申请时重算会把回填流水
    // 一起算进去，那才是商家真正要的「这一期总共该给我多少」。
    // 误走补差路径 → 只打回填那部分的钱，**主体那部分永远打不出去**。
    const paidNormal = await this.findPaidNormalPayout(period.from);
    const isSupplement = paidNormal !== null;

    let amounts: {
      receiptAmount: number;
      commissionAmount: number;
      netAmount: number;
      entryCount: number;
      entryIds: string[];
      statementId: string | null;
      statementStatus: SettlementStatus | null;
    };
    let kind: PayoutKind;

    if (isSupplement) {
      kind = PayoutKind.SUPPLEMENT;
      // ⚠️ **补差单的金额逻辑独立实现** —— 不复用 `computeAmounts`
      //    （护栏 X13：复用会让同一笔佣金扣两遍）
      amounts = await this.computeUnclaimedAmounts(tenantId, period);
      if (amounts.netAmount <= 0) {
        throw new BadRequestException(
          `该期（${period.label}）没有可补差的货款，无法申请出款`,
        );
      }
      // ⚠️ **补差单允许结算单是 `PAID`**（它不算佣金，结算单只作追溯凭证）
      this.assertStatementConfirmed(amounts, period.label, { allowPaid: true });
    } else {
      kind = PayoutKind.NORMAL;
      amounts = await this.computeAmounts(tenantId, period);
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
      // ⚠️ **正常单的 P3 不放宽** —— 佣金要拿结算单的 `netAmount`
      this.assertStatementConfirmed(amounts, period.label);
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
              kind,
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
              // ⚠️ **申请时也抄一份账户**（审批时会覆盖成审批那一刻的值）
              snapshotAccountName: account.accountName,
              snapshotBankName: account.bankName,
              // ⚠️ **复制的是账户行里那份密文本身，不是重新加密**：
              //    重新加密会得到不同的密文（随机 iv），
              //    而「快照 = 审批那一刻的那一份」要求复制同一份密文。
              snapshotAccountNoCipher: account.accountNoCipher,
              snapshotMaskedAccountNo: account.maskedAccountNo,
              // ⚠️ **版本号必须跟着密文一起复制** ——
              //    否则会出现「密文是新的、版本号是 0」的错配。
              snapshotEncryptionVersion: account.encryptionVersion,
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
      const raced =
        (await this.findActivePayout(period.from, PayoutKind.NORMAL)) ??
        (await this.findActivePayout(period.from, PayoutKind.SUPPLEMENT));
      if (!raced) {
        // ⚠️ **撞的不是活跃周期那条索引**（例如 `payoutNo` 撞了）
        //    → 原样抛出，**不伪装成「重复申请」**。
        throw error;
      }
      return this.toView(raced);
    }

    this.logger.log(
      `出款申请已创建：${payoutNo}（${period.label}，${amounts.netAmount} 分，` +
        `类型 ${kind}）`,
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
   * 平台审批：**通过**（重算并锁定金额 → 抄账户快照 → 事务后入队）。
   *
   * ⚠️ **重算金额**（护栏 P5）：不采信申请时的预估 —— 从申请到审批之间，
   * 流水可能补进来了、结算单可能被重算了。锁定的是**审批那一刻**的值。
   *
   * ⚠️ **按 `kind` 分支**（阶段 5h-2，护栏 X13）：补差单**绝不能**调
   *    `computeAmounts` —— 那会把整期佣金再扣一遍。
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

      const period = { from: payout.periodStart, to: payout.periodEnd };
      const periodLabel = formatPeriodLabel(payout.periodStart);

      // ⚠️⚠️ **按 kind 分支重算** —— 补差单**绝不能**调 `computeAmounts`：
      //    那会把整期佣金再扣一遍（护栏 X13）。
      const isSupplement = payout.kind === PayoutKind.SUPPLEMENT;
      const amounts = isSupplement
        ? await this.computeSupplementAmounts(payout, period)
        : await this.computeAmounts(payout.tenantId, period);

      // ⚠️ **P3 校验**：补差单允许结算单是 `PAID`（它不算佣金，
      //    结算单只作追溯凭证）；正常单**不放宽**（护栏 P5 / P6 不能失效）。
      this.assertStatementConfirmed(amounts, periodLabel, {
        allowPaid: isSupplement,
      });

      // ⚠️ **重算后必须仍是正的应结金额**（与 `apply` 同款的两道闸）：
      //    申请与审批之间流水可能变了（订单退款冲回、回填补进一笔）。
      //    冲回占优时净额会变成 0 甚至负数 —— 锁进 APPROVED 的单，
      //    5h-2 的出款流程会**按这个数打款**。
      //    ⚠️ **平台打款给商家一个负数**是「平台倒欠商家」，
      //    那是调账的事，不该由出款这条路走。
      if (amounts.entryCount === 0) {
        throw new ConflictException(
          `该期（${periodLabel}）已无货款流水，不能审批出款`,
        );
      }
      if (amounts.netAmount <= 0) {
        throw new ConflictException(
          `该期（${periodLabel}）重算后的应结金额已非正数` +
            `（货款净额 ${amounts.receiptAmount} 分、佣金 ${amounts.commissionAmount} 分），不能审批出款`,
        );
      }

      // ⚠️ **重新查收款账户**（阶段 5h-2）：商家在 `REQUESTED` 期间可能删了账户。
      //    查不到 → 409，**不要**带着空快照往下走 ——
      //    worker 会因为「快照缺失」落 `FAILED`，那等于让商家白等一轮。
      //
      //    ⚠️ **必须显式带 `tenantId`**：`approve` 跑在**平台作用域**下 →
      //    扩展**不附加** tenantId → 不带就是跨租户取数。
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: payout.tenantId },
      });
      if (!account) {
        throw new ConflictException('该商家已删除收款账户，请让其重新申请');
      }
      // ⚠️⚠️ **写路径也要查加密版本**（阶段 5j）—— 与 `apply` 里那道闸同款理由：
      //    未迁移的账户行里装的是**明文**，快照一抄过去就是明文落库，
      //    而打款时必然抛错 → 单卡在 `PROCESSING` 反复重试。
      if (account.encryptionVersion !== 1) {
        throw new ConflictException(
          '该商家的收款账户尚未完成加密迁移，' +
            '请先执行 `npm run migrate:payout-encryption`',
        );
      }

      const now = await this.prisma.databaseNow();
      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
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
            // ⚠️ **补差单的 `statementId` 保持不变**（仍指那张结算单，
            //    只作追溯凭证）；正常单按重算结果更新。
            statementId: isSupplement
              ? payout.statementId
              : amounts.statementId,
            // ⚠️⚠️ **账户快照必须在同一个事务里写** ——
            //    分成「先改状态、再单独写快照」的话，会有
            //    「状态已 APPROVED、job 已入队、快照还没写」的窗口，
            //    worker 拿到的可能是 `apply` 时的旧账户
            //    （正是快照要防的事）。
            snapshotAccountName: account.accountName,
            snapshotBankName: account.bankName,
            // ⚠️ **复制的是账户行里那份密文本身，不是重新加密**：
            //    重新加密会得到不同的密文（随机 iv），
            //    而「快照 = 审批那一刻的那一份」要求复制同一份密文。
            snapshotAccountNoCipher: account.accountNoCipher,
            snapshotMaskedAccountNo: account.maskedAccountNo,
            // ⚠️ **版本号必须跟着密文一起复制** ——
            //    否则会出现「密文是新的、版本号是 0」的错配。
            snapshotEncryptionVersion: account.encryptionVersion,
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单已被审批或状态已变，不能重复审批');
        }

        // ⚠️⚠️ **明细必须与重算结果同步**（同一个事务里）：
        //    审批锁定的范围 = 本单纳入的流水。申请到审批之间流水可能变，
        //    而 `payout_entries` 还停留在申请时的旧集合 →
        //    「重算金额包含的流水」与「明细里占用的流水」不一致 →
        //    `computeUnclaimedAmounts` 认为多出来的那些仍「未纳入」→
        //    商家能再申请一张补差单，**把同一笔流水再打一次钱**。
        //
        // ⚠️ **两种 kind 都要同步** —— 审批锁定的范围就是这张单纳入的流水；
        //    审批**之后**才回填的流水不在锁定范围里，那些才该走补差单打。
        //
        // ⚠️ **`deleteMany` 必须在 `createMany` 之前** ——
        //    `payout_entries.entryId` 是**全局唯一索引**，不先删就插会撞
        //    → P2002 → 500。
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        if (amounts.entryIds.length > 0) {
          await tx.payoutEntry.createMany({
            data: amounts.entryIds.map((entryId) => ({
              payoutId,
              entryId,
            })),
          });
        }

        return tx.payout.findFirst({ where: { id: payoutId } });
      });

      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️⚠️ **入队必须在事务提交之后** —— 在事务里 `queue.add` 的话，
      //    worker 可能在事务提交前就消费到 job → 查不到那张单（还是 REQUESTED）
      //    → 抢不到 → 静默返回 → **这笔出款永远没人打**。
      //
      // ⚠️ **入队失败不抛错**：状态已经是 `APPROVED` 了（事务已提交），
      //    抛错会让审批人以为「审批失败」而重试 → 409 → 更困惑。
      //    正确做法是：记 `failureReason` + 记日志，
      //    由 `scanStuck` 的「`APPROVED` 救援」重新入队（设计 §九·R3）。
      try {
        await this.queues.addWithOptions(
          PAYOUT_QUEUE,
          'execute',
          { payoutId: updated.id },
          `payout-${updated.id}-1`,
          // ⚠️ **attempts 必须是 1** —— BullMQ 自己的重试要关掉，
          //    重试由出款单自己的 `attemptCount` + 退避控制。
          //
          // ⚠️ **`removeOnComplete: true`** —— 否则完成的 job 留在队列里
          //    一直涨，而且**同 jobId 永远不能再用**
          //    （重试要用 `payout-{id}-2` 这类新轮次）。
          { attempts: 1, removeOnComplete: true },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.prisma.payout.updateMany({
          where: { id: updated.id, status: PayoutStatus.APPROVED },
          // ⚠️ **界面口径，不带原始异常消息** —— `reason` 可能是 Redis 的
          //    连接细节（主机名、端口、连接错误）。内部原文只进日志。
          //
          // ⚠️ **文案要说清「会自动重试」** —— 超管看到这句就知道
          //    兜底扫描会救它，不用手工干预。
          data: { failureReason: '打款任务提交失败，系统将自动重试' },
        });
        this.logger.error(
          `出款审批后入队失败：${updated.id} —— ${reason}（将由兜底扫描重新入队）`,
        );
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
   * 平台端人工重试（阶段 5l）。
   *
   * ⚠️ **只允许「确定没打钱」的单重试** —— `failedBeforePayout = true`
   *    意味着渠道**从未被调用**（解密失败 / 打款前的闸 / 没有可用渠道）。
   *    `false` 的单钱**可能已经打出去** → 重试 = **重复打款**。
   *
   * ⚠️ **重试要重新纳入流水 + 重算金额** ——
   *    `markFailed` 落 `FAILED` 时释放了 `payout_entries`，
   *    而那张表**同时是「这张单要打哪些流水」的凭证**。
   *    不重新纳入 → 账实不符（商家能对同期重新申请 → 同一笔打两次）。
   *
   * @param reason 操作原因（必填，会记进 `payout_operations`）
   */
  async retry(payoutId: string, reason: string): Promise<PlatformPayoutView> {
    const trimmed = reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('操作原因不能为空');
    }
    const context = getTenantContext();
    const operatorId = context.userId;
    if (!operatorId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      if (payout.status !== PayoutStatus.FAILED) {
        throw new ConflictException(
          `出款单状态已变（当前是 ${payout.status}），只有失败的出款单能重试`,
        );
      }
      // ⚠️ **硬闸**：钱可能已打出去的单**不能重试**
      if (!payout.failedBeforePayout) {
        throw new ConflictException(
          '该出款单可能已经打款（渠道调过了，只是没成功回包），不能直接重试。' +
            '请先核对渠道是否已到账。',
        );
      }

      const period = { from: payout.periodStart, to: payout.periodEnd };
      const periodLabel = formatPeriodLabel(payout.periodStart);

      // ⚠️⚠️ **活跃单检查不能直接用 `findActivePayout`** ——
      //    那个方法**只在商家侧（租户作用域）调用**（不手写 tenantId，
      //    靠扩展附加）。这里跑在**平台作用域**下 → 扩展不附加 tenantId →
      //    直接用会**跨租户匹配**（所有租户的 periodStart 都是同一天）。
      //    → 自己写，口径必须与部分唯一索引
      //    `payouts_tenantId_period_kind_active_uniq`
      //    （`(tenantId, periodStart, kind)`，
      //    `WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')`）**逐字一致**。
      const other = await this.prisma.payout.findFirst({
        where: {
          tenantId: payout.tenantId,
          periodStart: payout.periodStart,
          // ⚠️ **kind 是索引的一部分，必须带** —— 同期不同 kind 的单不冲突
          kind: payout.kind,
          status: {
            notIn: [
              PayoutStatus.REJECTED,
              PayoutStatus.CANCELLED,
              PayoutStatus.FAILED,
            ],
          },
          // ⚠️ **排除自己**
          id: { not: payout.id },
        },
      });
      if (other) {
        throw new ConflictException(
          `该期（${periodLabel}）已有另一张活跃出款单 ${other.payoutNo}，` +
            '请先处理那张单再重试这张。',
        );
      }

      // ⚠️⚠️ **按 kind 分支重算** —— 补差单**绝不能**调 `computeAmounts`
      //    （那会把整期佣金再扣一遍，护栏 X13）。
      const isSupplement = payout.kind === PayoutKind.SUPPLEMENT;
      const amounts = isSupplement
        ? await this.computeSupplementAmounts(payout, period)
        : await this.computeAmounts(payout.tenantId, period);

      // ⚠️ **金额变了 = 事实变了** —— 该让商家重新申请（走正常审批），
      //    而不是运营替他决定打多少（5h-1 的 P5 是同一个道理）。
      if (amounts.netAmount !== payout.netAmount) {
        throw new ConflictException(
          `该期（${periodLabel}）的金额已变化` +
            `（原锁定 ${payout.netAmount} 分，现在重算是 ${amounts.netAmount} 分），` +
            '不能直接重试。请让商家重新申请。',
        );
      }
      // ⚠️⚠️ **笔数也要一致** —— 只比金额会漏掉「一笔换一笔、总额不变」
      //    的情形（例如 A 单退款冲回 1000 分、B 单回填 1000 分）：
      //    金额一样 → 放行 → 但**纳入的流水集合变了** →
      //    被换掉的那笔流水「没被任何单占用」→ 商家能对它再申请一张补差单
      //    → **同一笔流水打两次钱**。
      //
      //    ⚠️ **`payouts` 表只存了 `entryCount`（笔数），没存纳入的流水 id** ——
      //    所以只能比笔数。笔数与金额同时一致，才认为「纳入范围没变」。
      if (amounts.entryCount !== payout.entryCount) {
        throw new ConflictException(
          `该期（${periodLabel}）的货款流水笔数已变化` +
            `（原锁定 ${payout.entryCount} 笔，现在重算是 ${amounts.entryCount} 笔），` +
            '不能直接重试。请让商家重新申请。',
        );
      }
      if (amounts.entryCount === 0) {
        throw new ConflictException(
          `该期（${periodLabel}）已无货款流水，不能重试出款`,
        );
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          // ⚠️ **必须带状态条件** —— 否则两个超管同时点「重试」会双双「成功」
          where: {
            id: payoutId,
            status: PayoutStatus.FAILED,
            failedBeforePayout: true,
          },
          data: {
            status: PayoutStatus.APPROVED,
            attemptCount: 0,
            failureReason: null,
            failedAt: null,
            failedBeforePayout: false,
            processingAt: null,
            // ⚠️ **approvedAt 不刷新** —— 它的语义是「审批时间」，
            //    刷新它会让平台端显示的审批时间变成假的。
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单状态已变，不能重复重试');
        }

        // ⚠️ **重新纳入明细** —— 与 `approve` 同款：先删后插
        //    （`payout_entries.entryId` 是全局唯一索引，不先删就插会撞 P2002）
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        if (amounts.entryIds.length > 0) {
          await tx.payoutEntry.createMany({
            data: amounts.entryIds.map((entryId) => ({ payoutId, entryId })),
          });
        }

        // ⚠️ **操作留痕** —— 涉及钱的操作必须能追溯
        await tx.payoutOperation.create({
          data: {
            payoutId,
            action: 'RETRY',
            operatorId,
            reason: trimmed,
            fromStatus: PayoutStatus.FAILED,
            toStatus: PayoutStatus.APPROVED,
            attemptCountBefore: payout.attemptCount,
          },
        });

        return tx.payout.findFirst({ where: { id: payoutId } });
      });
      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️ **入队必须在事务提交之后**（与 `approve` 同款）
      await this.enqueueRetry(updated.id);

      return this.toPlatformView(updated);
    });
  }

  /**
   * 人工重试后的入队（阶段 5l）。
   *
   * ⚠️ **jobId 的轮次来自「历史「重新打款」次数 + 1」** ——
   *    **不能用 `attemptCount`**（它刚被重置成 0 了），
   *    也**绝不能复用 jobId**：BullMQ 里 failed job 的 hash 还在，
   *    用同一个 jobId 重新入队会被**静默忽略**（不报错、不入队 → 重试从未发生）。
   *
   * ⚠️⚠️ **要数的是「所有会重新打款的操作」，不能只数 `RETRY`** ——
   *    `unstick → APPROVED`（解卡后重新打款）**也是一次重新打款**。
   *    若只数 `RETRY`，就会出现：
   *    ① `unstick → APPROVED` → jobId `payout-a-retry-1`（`RETRY` 计数为 0）
   *    ② 那个 job 失败了（BullMQ 留着 failed job 的 hash）
   *    ③ 再走一次 `retry` → `RETRY` 计数仍是 0 → jobId **又**是
   *       `payout-a-retry-1` → **被 BullMQ 静默忽略** → 重试从未发生，
   *       钱永远打不出去。
   *    → 两种动作一起数，轮次才真正单调递增。
   *
   * ⚠️ **减 1 是因为「本次操作已经落库了」** —— `enqueueRetry` 在事务
   *    **提交之后**才跑，而留痕行是在同一个事务里写的 →
   *    查出来的计数**含本次**。
   *    减掉它 → 轮次就是「第几次重新打款」（第一次 → `-retry-1`）。
   *    ⚠️ **不减也不会撞 jobId**（计数仍然单调递增），减它只是让
   *    轮次编号符合语义。
   */
  private async enqueueRetry(payoutId: string): Promise<void> {
    const count = await this.prisma.payoutOperation.count({
      where: {
        payoutId,
        // ⚠️ **两种「会重新打款」的动作都算**（理由见上）
        action: { in: ['RETRY', 'UNSTUCK_TO_APPROVED'] },
      },
    });
    // ⚠️ **本次操作已计入** → 减 1 才是「第几次重新打款」
    const done = Math.max(count - 1, 0);
    try {
      await this.queues.addWithOptions(
        PAYOUT_QUEUE,
        'execute',
        { payoutId },
        `payout-${payoutId}-retry-${done + 1}`,
        { attempts: 1, removeOnComplete: true },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.prisma.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.APPROVED },
        // ⚠️ **界面口径** —— 原始异常只进日志
        data: { failureReason: '打款任务提交失败，系统将自动重试' },
      });
      this.logger.error(
        `出款人工重试后入队失败：${payoutId} —— ${reason}（将由兜底扫描重新入队）`,
      );
    }
  }

  /**
   * 平台端解除卡单（阶段 5l）。
   *
   * ⚠️ **卡在 `PROCESSING` 的单钱可能已经打出去**（5h-2 的 R3：绝不自动重试）——
   *    所以「重新打款」这个方向**必须由运营在核对渠道后手动决定**，
   *    且界面要警示 + 必填原因。
   *
   * @param to `FAILED` = 认定没打出去（结束这件事）；`APPROVED` = 重新打款
   */
  async unstick(
    payoutId: string,
    input: { to: 'FAILED' | 'APPROVED'; reason: string },
  ): Promise<PlatformPayoutView> {
    const trimmed = input?.reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('操作原因不能为空');
    }
    const context = getTenantContext();
    const operatorId = context.userId;
    if (!operatorId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      if (payout.status !== PayoutStatus.PROCESSING) {
        throw new ConflictException(
          `出款单状态已变（当前是 ${payout.status}），只有卡在「打款中」的出款单能解卡`,
        );
      }

      // ⚠️ **必须确认它真的卡住了** —— 否则运营一点就把**正在进行的打款**打断了。
      //    阈值与 `scanStuck` 的 `stuckThresholdMs` 一致（10 分钟）。
      const thresholdMs = 10 * 60 * 1000;
      if (
        !payout.processingAt ||
        Date.now() - payout.processingAt.getTime() < thresholdMs
      ) {
        throw new ConflictException(
          '该出款单可能正在打款中（未超过卡住阈值），请稍后再试',
        );
      }

      const toStatus =
        input.to === 'APPROVED' ? PayoutStatus.APPROVED : PayoutStatus.FAILED;

      // ⚠️ **用数据库时钟** —— 与 `markFailed` 同款（worker 传的也是
      //    `await this.prisma.databaseNow()`）。不要用 `new Date()`：
      //    应用时钟与数据库时钟有偏差，判定边界会漂。
      const failedAt = await this.prisma.databaseNow();

      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          // ⚠️ **必须带状态条件**（并发护栏，与 `approve` 同款）
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: toStatus,
            // ⚠️ **processingAt 必须清** —— 不清的话兜底扫描会把它
            //    当成卡住的单反复捞出来
            processingAt: null,
            ...(toStatus === PayoutStatus.FAILED
              ? {
                  failedAt,
                  failureReason:
                    '出款单被平台人工标记为失败（钱未打出去），可重新申请或重试',
                  // ⚠️ **认定「没打出去」→ 转 FAILED 后可重试**
                  failedBeforePayout: true,
                  // ⚠️ **attemptCount 保持不动** —— 保留「这张单卡住时
                  //    试了几次」这个事实，排查时要看
                }
              : {
                  // ⚠️ **重新打款**：明细**绝不能释放**（释放了商家就能
                  //    对同期重新申请 → 同一笔流水打两次）
                  attemptCount: 0,
                  // ⚠️ **approvedAt 不刷新**（语义是「审批时间」）
                }),
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单状态已变，不能重复解卡');
        }

        // ⚠️ **转 FAILED 时要释放明细** —— 与 `markFailed` 同款：
        //    单子结束了，商家可以对该期重新申请
        if (toStatus === PayoutStatus.FAILED) {
          await tx.payoutEntry.deleteMany({ where: { payoutId } });
        }

        await tx.payoutOperation.create({
          data: {
            payoutId,
            action:
              toStatus === PayoutStatus.FAILED
                ? 'UNSTUCK_TO_FAILED'
                : 'UNSTUCK_TO_APPROVED',
            operatorId,
            reason: trimmed,
            fromStatus: PayoutStatus.PROCESSING,
            toStatus,
            attemptCountBefore: payout.attemptCount,
          },
        });

        return tx.payout.findFirst({ where: { id: payoutId } });
      });
      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️ **重新打款要入队**（转 FAILED 不用）
      if (toStatus === PayoutStatus.APPROVED) {
        await this.enqueueRetry(updated.id);
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
      select: { occurredAt: true },
    });

    // ⚠️ **按月分组**：流水是逐笔的，周期是月的。
    //    这里只要**周期清单**（金额由聚合统一算，
    //    不复用这里的求和 —— 两处口径漂了账就错了）。
    const periodLabels = new Set<string>();
    for (const receipt of receipts) {
      periodLabels.add(formatPeriodLabel(receipt.occurredAt));
    }

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
   * 结算单必须是已 `CONFIRMED` 的状态（护栏 P3）。
   *
   * ⚠️ **只在「申请」与「审批」这两个动作上校验**，不在取数的地方校验：
   * 「可申请周期」列表要照常显示未确认的周期（带 `statementStatus`），
   * 在那里抛异常会把整个列表打成 409。
   *
   * ⚠️ **`allowPaid` 只给补差路径开**（阶段 5h-2）：
   * 补差单不算佣金（佣金在结算单里一次性扣完），结算单只作追溯凭证 →
   * 允许它对着已 `PAID` 的结算单。
   *
   * ⚠️ **绝不能改成「PAID 一律放行」** —— 那会让正常单也能对已 `PAID` 的
   * 结算单重新算佣金，5h-1 的 P5（审批重算）与 P6（`PAID` 不可取消确认）
   * 会一起失效。`DRAFT` 状态**任何路径都要 409**。
   */
  private assertStatementConfirmed(
    amounts: { statementStatus: SettlementStatus | null },
    periodLabel: string,
    options: { allowPaid?: boolean } = {},
  ): void {
    const status = amounts.statementStatus;
    if (status === null || status === SettlementStatus.CONFIRMED) {
      return;
    }
    if (options.allowPaid && status === SettlementStatus.PAID) {
      return;
    }
    throw new ConflictException(
      `该期（${periodLabel}）的结算单尚未确认，不能申请出款`,
    );
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
   * 算补差出款单的金额（**不复用 `computeAmounts`** —— 护栏 X13）。
   *
   * ## 为什么不能复用 `computeAmounts`
   *
   * 正常单的佣金取该期结算单的 `netAmount`（整期一次性扣完）。
   * 补差单若也走这条路，佣金会被扣**第二遍** → 极端情况下净额变负。
   *
   * ## ⚠️⚠️ 重算范围必须是「本单口径」
   *
   * 补差单在 `apply` 时已经占用了自己那批流水。若这里用全局口径
   * 「该期未被任何单占用的流水」，**本单纳入的流水会被当成未纳入**
   * → 金额直接归零（护栏 X16）。
   *
   * 正确口径 = 「本单已占用的」 ∪ 「该期未被**其他**单占用的」。
   *
   * @param payout 待审批的补差单（要排除它自己占用的流水）
   */
  private async computeSupplementAmounts(
    payout: { id: string; tenantId: string },
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
        tenantId: payout.tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });

    // ---- ① 本单自己占用的 entryId ----
    const ownLinks = await this.prisma.payoutEntry.findMany({
      where: { payoutId: payout.id },
      select: { entryId: true },
    });
    const ownIds = new Set(ownLinks.map((link) => link.entryId));

    // ---- ② 被**其他**单占用的 entryId ----
    // ⚠️ **`payout_entries` 不在租户白名单里** → 扩展不附加任何过滤，
    //    这里查到的就是全局事实 → **必须显式带 `tenantId` 与 `periodStart`**。
    const otherLinks = await this.prisma.payoutEntry.findMany({
      where: {
        payout: { tenantId: payout.tenantId, periodStart: period.from },
        payoutId: { not: payout.id },
      },
      select: { entryId: true },
    });
    const otherIds = new Set(otherLinks.map((link) => link.entryId));

    // ---- ③ 纳入范围 = 本单已占 ∪ 未被其他单占用的 ----
    const scope = receipts.filter(
      (receipt) => ownIds.has(receipt.id) || !otherIds.has(receipt.id),
    );

    const receiptAmount = scope.reduce(
      (sum, receipt) => sum + receipt.amount,
      0,
    );

    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId: payout.tenantId, periodStart: period.from },
    });

    return {
      receiptAmount,
      // ⚠️ **佣金恒为 0** —— 这一期不再扣佣（设计 §6.4 的不变量：
      //    同一期所有出款单的佣金之和 = 该期结算单的 netAmount）
      commissionAmount: 0,
      netAmount: receiptAmount,
      // ⚠️ **entryCount 按补差那批重算** —— 不是整期的条数
      //    （留着旧值会让商家在详情页看到「31 条」而明细只有 2 条）
      entryCount: scope.length,
      entryIds: scope.map((receipt) => receipt.id),
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
   *
   * ⚠️ **`kind` 是必传参数，不是可选的** —— 5h-2 把部分唯一索引改成了
   *    `(tenantId, periodStart, kind)` 三元组，查询不带 kind 就会出现
   *    「以为只查正常单、实际把补差单也捞进来了」的错位。
   *
   * ⚠️ **`notIn` 必须与索引的 WHERE 是同一个集合**
   *    （REJECTED / CANCELLED / FAILED）—— 否则会出现
   *    「查询认为不活跃、插入却被索引拦下」的错位。
   */
  private async findActivePayout(
    periodStart: Date,
    kind: PayoutKind,
  ): Promise<Payout | null> {
    return this.prisma.payout.findFirst({
      where: {
        periodStart,
        kind,
        status: {
          notIn: [
            PayoutStatus.REJECTED,
            PayoutStatus.CANCELLED,
            PayoutStatus.FAILED,
          ],
        },
      },
    });
  }

  /**
   * 查该期有没有**已出款**的正常单（`status = PAID`）。
   *
   * ⚠️ **这是「走正常路径还是补差路径」的分水岭**（设计 §6.4）。
   *    `PAID` 的正常单意味着「这一期已经结清了」，
   *    之后回填进来的货款只能靠**补差单**再出一次。
   *
   * ⚠️ **绝不能改成「有任意正常单就算」** —— `FAILED` 的正常单要走
   *    正常路径（重新申请时重算会把回填流水一起算进去）。
   */
  private async findPaidNormalPayout(
    periodStart: Date,
  ): Promise<Payout | null> {
    return this.prisma.payout.findFirst({
      where: {
        periodStart,
        kind: PayoutKind.NORMAL,
        status: PayoutStatus.PAID,
      },
    });
  }

  /**
   * 算「该期未被任何单纳入的流水」之和（**全局口径**）。
   *
   * ⚠️ **这里没有「本单」的概念** —— 单还没建，所以用全局口径：
   *    该期全部流水 − 被**所有**单占用的 entryId。
   *
   * ⚠️ **与 `computeSupplementAmounts`（本单口径）是两回事**：
   *    那是 `approve` 时的重算，那时单已经存在、自己占着那批流水。
   *
   * ⚠️ **「已被占用」按 `payout_entries` 的实际行算，不按 `entryCount` 求和** ——
   *    被拒 / 撤回 / 失败的单已经释放了明细，但它们的 `entryCount` 列
   *    **仍是旧数字**（历史快照，没清零）。拿 `entryCount` 求和会把
   *    「已释放的流水」算成「已纳入」。
   */
  private async computeUnclaimedAmounts(
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

    // ⚠️ **`payout_entries` 不在租户白名单里** → 扩展不附加任何过滤
    //    → 这里查到的就是全局事实 → **必须显式带 `tenantId` 与 `periodStart`**
    const links = await this.prisma.payoutEntry.findMany({
      where: { payout: { tenantId, periodStart: period.from } },
      select: { entryId: true },
    });
    const claimed = new Set(links.map((link) => link.entryId));

    const unclaimed = receipts.filter((receipt) => !claimed.has(receipt.id));
    const receiptAmount = unclaimed.reduce(
      (sum, receipt) => sum + receipt.amount,
      0,
    );

    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart: period.from },
    });

    return {
      receiptAmount,
      // ⚠️ **佣金恒为 0** —— 这一期不再扣佣（设计 §6.4）
      commissionAmount: 0,
      netAmount: receiptAmount,
      entryCount: unclaimed.length,
      entryIds: unclaimed.map((receipt) => receipt.id),
      statementId: statement?.id ?? null,
      statementStatus: statement?.status ?? null,
    };
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
   */
  private merchantFailureReason(payout: Payout): string | null {
    if (!payout.failureReason) return null;
    if (payout.failedBeforePayout) {
      return MERCHANT_SAFE_FAILURE_REASONS.includes(payout.failureReason)
        ? payout.failureReason
        : MERCHANT_SAFE_FAILURE_REASONS[0];
    }
    return '出款未完成，请联系平台确认出款情况';
  }

  /** 单据 → 对外字段（租户视角） */
  private toView(payout: Payout): PayoutView {
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

/**
 * 商家端**可以直接看到**的失败措辞白名单（阶段 5l）。
 *
 * ⚠️ **只收「渠道从未被调用」那一桶**（`failedBeforePayout = true`）——
 *    这些值由 worker 在打款前拦截时写入，**本来就是给商家看的措辞**。
 *    `PayoutWorker.checkGates` 与 `PayoutWorker` 的三处写入点
 *    （收款账号信息异常 / 出款金额异常 / 没有可用的出款渠道）
 *    与本清单**逐字一致** —— 改文案时两处要一起改。
 *
 * ⚠️ **「可能已打」那一桶不在这里** —— 那些值是渠道侧的原文
 *    （带主机名、请求 id、金额数字），商家端一律换成通用措辞。
 *
 * ⚠️ **第一条同时是兜底值** —— 白名单外的值（例如将来有人往这个桶里
 *    写进内部术语）会退回它，而不是把原文泄给商家。
 */
const MERCHANT_SAFE_FAILURE_REASONS: readonly string[] = [
  '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
  '出款金额异常，本次未打款，请联系平台核对',
  '没有可用的出款渠道',
  '出款单被平台人工标记为失败（钱未打出去），可重新申请或重试',
];

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
