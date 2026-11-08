import { normalizeChannel } from '../../common/channel/channel-config';
import { transactionOptions } from '../../common/db/transaction-options';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import { PAYOUT_VERIFICATION } from '../../common/payment/payout-verification';
import type { PayoutVerification } from '../../common/payment/payout-verification';
import { PlatformSettingService } from '../../common/platform-settings/platform-setting.service';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { requireTenantId } from '../../common/tenant/require-tenant';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { QueueService } from '../queue/queue.service';
import { PayoutQueryService } from './payout-query.service';
import {
  generatePayoutNo,
  PayoutView,
  PlatformPayoutView,
} from './payout-types';
import { formatPeriodLabel, resolveMonthlyPeriod } from './settlement';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Payout,
  PayoutKind,
  PayoutStatus,
  SettlementStatus,
} from '@prisma/client';

/**
 * PayoutStateService —— 自 PayoutService（原 2000+ 行巨石）按职责拆出的部分（阶段 11）。
 *
 * 拆分是**纯机械搬移**：方法体与注释原样保留，只把跨组调用
 * （toView / toPlatformView）改写为经 `this.query`（PayoutQueryService）。
 * 行为校验靠既有单测与 e2e。
 */
@Injectable()
export class PayoutStateService {
  private readonly logger = new Logger(PayoutStateService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
    // ⚠️ **注入核实服务**（阶段 5m）—— 解卡重打前要问渠道「这笔打没打」。
    //    按 token 注入（契约在 `common/`）→ **不产生 billing → payment 的模块边**。
    @Inject(PAYOUT_VERIFICATION)
    private readonly verification: PayoutVerification,
    // ⚠️ **阶段 6 审查修复：审批时锁定出款渠道** —— 见 `resolveChannelForApproval`。
    private readonly registry: PayoutProviderRegistry,
    private readonly platformSettings: PlatformSettingService,
    private readonly query: PayoutQueryService,
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
    // ⚠️ **租户缺失统一 403**（与全仓 service 层一致）；用户上下文缺失仍是 400。
    const tenantId = requireTenantId();
    const userId = getTenantContext().userId;

    if (!userId) {
      throw new BadRequestException('缺少用户上下文');
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
      return this.query.toView(existingNormal);
    }
    const existingSupplement = await this.findActivePayout(
      period.from,
      PayoutKind.SUPPLEMENT,
    );
    if (existingSupplement) {
      return this.query.toView(existingSupplement);
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
      await this.assertStatementConfirmed(
        tenantId,
        amounts,
        period,
        period.label,
        { allowPaid: true },
      );
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
      await this.assertStatementConfirmed(
        tenantId,
        amounts,
        period,
        period.label,
      );
    }

    const payoutNo = generatePayoutNo(now);
    let created: Payout;
    try {
      created = await this.prisma.$transaction(async (tx) => {
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
      }, transactionOptions());
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
      return this.query.toView(raced);
    }

    this.logger.log(
      `出款申请已创建：${payoutNo}（${period.label}，${amounts.netAmount} 分，` +
        `类型 ${kind}）`,
    );
    return this.query.toView(created);
  }
  /**
   * 商家撤回申请（仅 `REQUESTED` 可撤）。
   *
   * ⚠️ **条件更新**（where 带 status）：与平台审批并发时，
   * 两个更新只有一个能成功，另一个拿到 409。
   */
  async cancel(payoutId: string): Promise<PayoutView> {
    requireTenantId();

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
    return this.query.toView(updated);
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
  /**
   * 解析这张出款单**审批时**要用的出款渠道（阶段 6 审查修复）。
   *
   * 顺序与执行时完全一致（设计 §4.4）：商家偏好 → 平台默认 → fail-closed。
   *
   * ⚠️ **为什么要在审批时锁定**（而不是等 worker 抢单时再解析）：
   *    原先渠道在 `claimForExecution` 里解析 —— 审批与 worker 抢单之间
   *    若改了平台默认渠道（或商家改了偏好），**同一张已审批的单会走另一家渠道**。
   *    钱打到哪家渠道必须是**审批那一刻就定死**的事：
   *    审批人看到的是 A 渠道的可用性，钱的路径也必须是 A。
   *
   * ⚠️ **商家配了就不再读平台默认** —— 与执行路径同一套规则，
   *    否则「审批时走商家渠道、执行时走平台渠道」会分裂。
   *
   * ⚠️ **解析失败不静默** —— 抛中文 409，审批人当场就知道
   *    「这家商家现在打不出钱」，而不是审批完等 worker 落 FAILED。
   */
  private async resolveChannelForApproval(tenantId: string): Promise<string> {
    // ⚠️ **必须显式带 `tenantId`**：`approve` 跑在**平台作用域**下 →
    //    租户扩展不附加 tenantId → 不带就是跨租户读。
    const account = await this.prisma.merchantPayoutAccount.findFirst({
      where: { tenantId },
      select: { preferredChannel: true },
    });
    const merchantChannel = normalizeChannel(account?.preferredChannel ?? '');

    // ⚠️ **商家配了就不再读平台默认渠道**（与执行路径同款理由）。
    if (merchantChannel.length > 0) {
      return this.registry.resolveForPayout({
        payoutChannel: null,
        merchantChannel,
        platformChannel: null,
      }).channel;
    }

    const platformChannel = (
      await this.platformSettings.getPayoutDefaultChannel()
    ).channel;

    return this.registry.resolveForPayout({
      payoutChannel: null,
      merchantChannel: null,
      platformChannel,
    }).channel;
  }
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
      await this.assertStatementConfirmed(
        payout.tenantId,
        amounts,
        period,
        periodLabel,
        {
          allowPaid: isSupplement,
        },
      );

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

      // ⚠️ **审批时锁定出款渠道**（阶段 6 审查修复）——
      //    解析放在事务**外面**：它要读商家账户与平台设置，可能抛错
      //    （渠道已停用 / 平台未配置）。放事务里会让整个事务回滚，
      //    报错信息被事务异常覆盖，审批人看不到「为什么打不出钱」。
      const payoutChannel = await this.resolveChannelForApproval(
        payout.tenantId,
      );

      const now = await this.prisma.databaseNow();
      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.REQUESTED },
          data: {
            status: PayoutStatus.APPROVED,
            approvedBy: userId,
            approvedAt: now,
            // ⚠️ **渠道在这里定死** —— 审批之后任何配置变更都不再影响这张单。
            //    重试也沿用它（执行路径「单子已有渠道就沿用」）。
            payoutChannel,
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

      return this.query.toPlatformView(updated);
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
      return this.query.toPlatformView(updated);
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

      return this.query.toPlatformView(updated);
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

      // ⚠️⚠️ **解卡重打的前置闸**（阶段 5m，设计 §六·6.3）——
      //    没有这道闸，运营点一下「解卡重打」就是**确定性地重复打款**：
      //    「卡在 PROCESSING」最可能的成因是「请求发出去了、回包丢了」→
      //    钱**可能已经打到商家账上**。
      //
      //    ⚠️ **这道闸罩住整个 `unstick`**（两个分支都会导致重打）：
      //    `to='APPROVED'` 直接重新入队；`to='FAILED'` 设 `failedBeforePayout: true`
      //    → 制造出一张「可安全重试」的单 → 之后能被 `retry` 重打。
      //
      //    ⚠️⚠️ **渠道选取必须与打款 worker 一致** —— 本闸把单子自己的
      //    `payoutChannel` 传下去（阶段 6a），核实服务按它取实现；
      //    打款 worker 也是按同一个 `payoutChannel` 取实现
      //    （见 `modules/payment/payout.worker.ts`）。
      //    **两处必须一起改** —— 若一处改了另一处没改，就会出现
      //    「钱打到 A 渠道、核实查 B 渠道」→
      //    核实从 B 渠道问出「没打」，实际钱已经从 A 渠道打出去了
      //    → **重复打款**。
      const verdict = await this.verification.verify({
        id: payout.id,
        payoutNo: payout.payoutNo,
        payoutTxnId: payout.payoutTxnId,
        // ⚠️ **必须是库里读到的渠道** —— 调用方无权指定（防止核实别的渠道）
        payoutChannel: payout.payoutChannel,
      });
      if (verdict.verdict === 'PAID') {
        // ⚠️ **渠道说钱已经打了** → 绝不能解卡
        //    （本 Task 的偏离说明：这里**不自动纠正**成 PAID ——
        //    纠正逻辑在 payment 模块的 resolver，billing 调不到。
        //    运营下一步是去对账页执行一次对账，A 类会被自动纠正。）
        throw new ConflictException(
          '渠道核实显示这张出款单已经打款成功，不能解卡重打（否则会重复打款）。' +
            '请到「渠道对账」页对账后查看结论。',
        );
      }
      if (verdict.verdict === 'UNKNOWN') {
        // ⚠️ **问不出结论就不放行** ——
        //    「渠道查不到这条」不等于「渠道说没打」。
        throw new ConflictException(
          '无法确认该笔是否已打款，请先执行渠道对账再解卡',
        );
      }
      // verdict === 'FAILED' → 渠道明确说没打 → 允许解卡

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
          // ⚠️ **读 id 与删明细同事务**（阶段 5m）—— 与 `markFailed` 同款理由
          const releasedEntries = await tx.payoutEntry.findMany({
            where: { payoutId },
            select: { entryId: true },
          });
          await tx.payoutEntry.deleteMany({ where: { payoutId } });
          if (releasedEntries.length > 0) {
            await tx.payout.updateMany({
              where: { id: payoutId },
              data: {
                releasedEntryIds: JSON.stringify(
                  releasedEntries.map((e) => e.entryId),
                ),
              },
            });
          }
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

      return this.query.toPlatformView(updated);
    });
  }
  /**
   * 结算单必须是已 `CONFIRMED` 的状态（护栏 P3）。
   *
   * ⚠️ **只在「申请」与「审批」这两个动作上校验**，不在取数的地方校验：
   * 「可申请周期」列表要照常显示未确认的周期（带 `statementStatus`），
   * 在那里抛异常会把整个列表打成 409。
   *
   * ⚠️ **「无结算单」≠「佣金 0」**（审计 P0-4，fail-closed）：
   * 「没有结算单」有两种截然不同的含义，必须用「该期有没有抽佣流水」区分——
   * - **有流水没结算单** → 超管漏跑了结算单（结算单只能超管手动生成，无定时任务）
   *   → **409 拒绝**。若把佣金兜成 0，商家会按货款全额出款，平台白送佣金
   *   （损失 = 佣金率，审批重算还会把这个错值锁进 `APPROVED`，执行层的三道闸
   *   全是内部自洽校验、拦不住）。
   * - **没流水** → 真零佣金（免费套餐费率 0 时 `shouldBackfillCommission` 不记流水，
   *   结算单生成对空流水返回 `empty` → 零佣金商家天然没有结算单）
   *   → **放行**，佣金就是 0。一律 fail-closed 会误伤零佣金商家。
   * ⚠️ **`CommissionEntry` 只用来判断「该不该有佣金」，不用来算佣金数值** ——
   *    数值仍以结算单为准（结算单是已冻结的凭证，重新聚合会对不上，
   *    与 `computeAmounts` 的既有注释同一口径）。
   * ⚠️ **必须显式带 `tenantId`**：`approve` 跑在平台作用域下，扩展不附加租户条件。
   *
   * ⚠️ **`allowPaid` 只给补差路径开**（阶段 5h-2）：
   * 补差单不算佣金（佣金在结算单里一次性扣完），结算单只作追溯凭证 →
   * 允许它对着已 `PAID` 的结算单。
   *
   * ⚠️ **绝不能改成「PAID 一律放行」** —— 那会让正常单也能对已 `PAID` 的
   * 结算单重新算佣金，5h-1 的 P5（审批重算）与 P6（`PAID` 不可取消确认）
   * 会一起失效。`DRAFT` 状态**任何路径都要 409**。
   */
  private async assertStatementConfirmed(
    tenantId: string,
    amounts: { statementStatus: SettlementStatus | null },
    period: { from: Date; to: Date },
    periodLabel: string,
    options: { allowPaid?: boolean } = {},
  ): Promise<void> {
    const status = amounts.statementStatus;
    if (status === null) {
      const entries = await this.prisma.commissionEntry.count({
        where: { tenantId, occurredAt: { gte: period.from, lt: period.to } },
      });
      if (entries > 0) {
        throw new ConflictException(
          `该期（${periodLabel}）的结算单尚未生成，不能申请出款`,
        );
      }
      return;
    }
    if (status === SettlementStatus.CONFIRMED) {
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
}
