import { Injectable, Logger } from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PayoutCipherService } from './payout-cipher.service';

/** 打款的结果（worker 传给本服务） */
export interface MarkPaidInput {
  /** 渠道交易号 */
  providerTxnId: string;
  /** 打款渠道名 */
  channel: string;
  /** 打款成功的时刻（数据库时钟） */
  paidAt: Date;
}

/** 打款失败的结果 */
export interface MarkFailedInput {
  /** 失败原因（给运营看） */
  reason: string;
  /** 落 FAILED 的时刻（数据库时钟） */
  failedAt: Date;
}

/** 退回 APPROVED 等下一次重试的结果 */
export interface ScheduleRetryInput {
  /** 退回的时刻（数据库时钟） */
  now: Date;
  /** 本次失败的原因（记进 `failureReason`，给运营看） */
  reason: string;
}

/** 「我抢到了这张单」的凭据（worker 拿去调渠道） */
export interface ExecutionClaim {
  /** 递增后的尝试次数（第一次 = 1） */
  attemptCount: number;
  /** 审批锁定的应结金额（整数分）—— worker **用它**，不重算 */
  netAmount: number;
  /** 出款单号（渠道对账单上显示的） */
  payoutNo: string;
  /** 收款账户快照（**不是**实时查的） */
  account: {
    accountName: string;
    bankName: string;
    accountNo: string;
  } | null;
}

/**
 * 出款执行的状态落库服务（阶段 5h-2）。
 *
 * ⚠️ **这是状态落库的唯一入口** —— worker 只调它，不自己写库。
 *    状态机的每一条转换都要带条件更新 + 同事务释放明细，
 *    分散在 worker 里一定会漏掉某一条。
 *
 * ⚠️ **全部跑在平台作用域下**：`payouts` 在租户白名单里，
 *    而队列消费端只知道一个 `payoutId`，不知道租户是谁
 *    （跨进程边界，`AsyncLocalStorage` 的上下文不跟着走）。
 *    平台作用域下扩展**不附加** tenantId 条件 → 查到的是全局事实。
 */
@Injectable()
export class PayoutExecutionService {
  private readonly logger = new Logger(PayoutExecutionService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
  ) {}

  /**
   * 抢单：`APPROVED → PROCESSING`，`attemptCount + 1`。
   *
   * ⚠️ **这是护栏 X1 的落点**：条件更新（`where` 带 `status: APPROVED`）
   *    保证「同一张出款单只有一个 worker 能抢到」。
   *    抢不到就返回 `null`，调用方**静默返回** —— 不重试、不落 `FAILED`
   *    （BullMQ 会把它记成失败 job，排查时全是假故障）。
   *
   * ⚠️ **金额与账户快照在这里一次性读出**：worker 后面只用自己的返回值，
   *    不再查库、不重算（护栏 X2 / X2b）。
   *
   * @param now 进 `PROCESSING` 的时刻（数据库时钟）
   */
  async claimForExecution(
    payoutId: string,
    now: Date,
  ): Promise<ExecutionClaim | null> {
    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **抢单与读回在同一个事务里** —— 分开写的话，
      //    「已改成 PROCESSING 但还没读回金额」这个窗口里，
      //    另一个 worker 读到的可能是旧值。
      return this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.APPROVED },
          data: {
            status: PayoutStatus.PROCESSING,
            processingAt: now,
            attemptCount: { increment: 1 },
          },
        });
        if (affected.count === 0) {
          return null;
        }
        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: {
            attemptCount: true,
            netAmount: true,
            payoutNo: true,
            snapshotAccountName: true,
            snapshotBankName: true,
            snapshotAccountNoCipher: true,
            snapshotMaskedAccountNo: true,
            snapshotEncryptionVersion: true,
          },
        });
        if (!payout) {
          return null;
        }
        return {
          attemptCount: payout.attemptCount,
          netAmount: payout.netAmount,
          payoutNo: payout.payoutNo,
          account: payout.snapshotAccountNoCipher
            ? {
                accountName: payout.snapshotAccountName ?? '',
                bankName: payout.snapshotBankName ?? '',
                // ⚠️ **这里是全仓唯一给渠道明文账号的地方**。
                //    快照的版本号不对（没迁移）→ 直接抛错，
                //    不能拿明文兜底（那等于把加密悄悄关掉）。
                accountNo: this.cipher.decryptVersioned(
                  payout.snapshotAccountNoCipher,
                  payout.snapshotEncryptionVersion,
                  '出款单的收款账号快照',
                ),
              }
            : null,
        };
      });
    });
  }

  /**
   * 打款成功：`PROCESSING → PAID`，并把引用的结算单一并转 `PAID`。
   *
   * ⚠️ **结算单联动在同一个事务里**（设计 §6.5）：
   *    钱已经打出去了，账上没跟上 = 账实不符。
   *
   * ⚠️ **结算单用条件 `status: CONFIRMED`**（不是 `PAID`）：
   *    已 `PAID` 的结算单被另一张单再触发时 `count === 0`，**不报错**（幂等）。
   *
   * ⚠️ **补差单不改结算单状态**（护栏 X6）：
   *    结算单在正常单 `PAID` 时已经转过了。
   */
  async markPaid(payoutId: string, input: MarkPaidInput): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.PAID,
            paidAt: input.paidAt,
            payoutChannel: input.channel,
            payoutTxnId: input.providerTxnId,
            // ⚠️ **失败原因要清掉**：重试成功后之前那次失败的原因不该留着
            failureReason: null,
          },
        });
        if (affected.count === 0) {
          return false;
        }

        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: { kind: true, statementId: true },
        });

        // ⚠️ **只有正常单才联动结算单**（X6）
        if (payout && payout.kind === 'NORMAL' && payout.statementId) {
          await tx.settlementStatement.updateMany({
            where: {
              id: payout.statementId,
              status: SettlementStatus.CONFIRMED,
            },
            // ⚠️ **`paidAt` 与 `status` 同一次 `data` 里写** ——
            //    分开写会出现「status=PAID 但 paidAt=null」的矛盾行
            data: { status: SettlementStatus.PAID, paidAt: input.paidAt },
          });
        }
        return true;
      });

      this.logger.log(`出款已打款：${payoutId}（渠道 ${input.channel}）`);
      return result;
    });
  }

  /**
   * 打款失败（超过重试上限）：`PROCESSING → FAILED` + **释放明细占用**。
   *
   * ⚠️ **释放明细是必须的**：`payout_entries.entryId` 是全局唯一索引。
   * 不释放的话，商家重新申请同一期会撞索引 → P2002 → 500。
   * 这是 5h-1 在「拒绝 / 撤回」上踩过的同一个坑（E5），`FAILED` 是第三条释放路径。
   *
   * ⚠️ **`statementId` 不清**：失败的单仍然引用那张结算单。
   *    P6 闸已经把 `FAILED` 加进排除列表，所以它不挡「取消确认」（设计 §6.4）。
   */
  async markFailed(payoutId: string, input: MarkFailedInput): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.FAILED,
            failedAt: input.failedAt,
            failureReason: input.reason,
          },
        });
        if (affected.count === 0) {
          return false;
        }
        // ⚠️ **与状态更新同一个事务** —— 分开写会出现
        //    「状态已 FAILED、明细还占着」的窗口
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        return true;
      });

      this.logger.warn(
        `出款失败（已达重试上限）：${payoutId} —— ${input.reason}`,
      );
      return result;
    });
  }

  /**
   * 退回 `APPROVED` 等下一次重试。
   *
   * ⚠️ **必须清 `processingAt`**：不清的话，兜底扫描会把这些
   *    「正在等重试」的单当成「卡住的单」重复捞出来（噪声 + 平台端误标红）。
   *
   * ⚠️ **不重置 `attemptCount`**：重置了就不会收敛到 `FAILED`（护栏 X7）。
   *
   * ⚠️ **不刷新 `approvedAt`** —— 它的语义是「审批时间」，刷新它会让
   *    平台端显示的审批时间变成假的。
   *
   * @returns 新的 `attemptCount`（供调用方拼下一次入队的 jobId）；
   *          `null` = **不重试**（状态已被改掉，或读不到行）
   */
  async scheduleRetry(
    payoutId: string,
    input: ScheduleRetryInput,
  ): Promise<number | null> {
    return tenantContext.run(platformScope(), async () => {
      return this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.APPROVED,
            processingAt: null,
            failureReason: input.reason ?? null,
          },
        });
        if (affected.count === 0) {
          return null;
        }
        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: { attemptCount: true },
        });
        // ⚠️ **读不到行就返回 `null`（不重试）**，不能返回 `0` ——
        //    调用方会拿 `0` 算出 `delay = 0` 并入队 `payout-{id}-0`
        //    → **立即重投**（绕过退避），抢跑重试预算。
        if (!payout) {
          return null;
        }
        return payout.attemptCount;
      });
    });
  }

  /**
   * 记「已告警过卡死」—— **只写 `stuckLoggedAt`，不改状态、不入队**。
   *
   * ⚠️ **绝不能在这里重试**：卡在 `PROCESSING` 的单最可能的成因是
   *    「请求发出去了、回包丢了」—— 钱**可能已经打到商家账上**。
   *    退回 `APPROVED` 再入队 = **确定性地重复打款**（设计 §九·R3）。
   *
   * ⚠️ **`stuckLoggedAt` 是「告警去重」，不是「已处理」**：
   *    写了它不代表有人处理了，只代表「已经告警过了」。
   *    「它还在卡」由平台端列表实时标红暴露（前端按 `processingAt` 判定）。
   */
  async markStuckLogged(payoutIds: string[], now: Date): Promise<number> {
    if (payoutIds.length === 0) {
      return 0;
    }
    return tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payout.updateMany({
        where: { id: { in: payoutIds }, status: PayoutStatus.PROCESSING },
        data: { stuckLoggedAt: now },
      });
      return affected.count;
    });
  }

  /**
   * 扫描卡住的出款单。
   *
   * ## 两类「卡住」，处理方式**完全相反**
   *
   * | 状态 | 含义 | 处理 |
   * |------|------|------|
   * | `PROCESSING` | 请求**可能已经打出去了**，只是回包丢了 | **只告警，绝不重试** |
   * | `APPROVED` | **确定还没打**（还没进 `PROCESSING`） | **重新入队**（安全） |
   *
   * ⚠️ **`PROCESSING` 绝不自动重试**（设计 §九·R3）：
   *    卡在 `PROCESSING` 最可能的成因是「请求发出去了、回包丢了」——
   *    钱**可能已经打到商家账上**。退回 `APPROVED` 再入队 =
   *    **确定性地重复打款**。所以只标出来给人看。
   *
   * ⚠️ **`APPROVED` 必须救援**：审批后要入队，入队可能失败（Redis 抖动）。
   *    没有兜底的话，那张单会永远停在 `APPROVED` ——
   *    商家看到「已审批」、平台看到「已审批」，**没有任何一方知道它没打出去**，
   *    流水还被占着（商家重新申请撞 `payout_entries` 唯一索引 → 500）。
   *    `APPROVED` 状态**确定没打出去**（还没进 `PROCESSING`），重新入队是安全的。
   *
   * ⚠️ **但只救「从未被执行过」的单**（`attemptCount = 0`）——
   *    正在退避等待重试的单状态也是 `APPROVED`，捞进来会与重试 job 抢跑。
   *
   * @param now 数据库时钟
   * @param stuckThresholdMs 卡住多久算卡住（默认 10 分钟）
   * @returns 需要重新入队的出款单 id 与其尝试次数（`APPROVED` 且超时的）
   */
  async scanStuck(
    now: Date,
    stuckThresholdMs = 10 * 60 * 1000,
  ): Promise<Array<{ id: string; attemptCount: number }>> {
    return tenantContext.run(platformScope(), async () => {
      const threshold = new Date(now.getTime() - stuckThresholdMs);

      // ---- ① PROCESSING 卡死：只告警，不改状态 ----
      const stuck = await this.prisma.payout.findMany({
        where: {
          status: PayoutStatus.PROCESSING,
          processingAt: { lt: threshold },
          // ⚠️ **只捞还没告警过的** —— 不写 `stuckLoggedAt` 的话，
          //    每 5 分钟就把同一张单捞出来再打一遍日志
          stuckLoggedAt: null,
        },
        select: { id: true, payoutNo: true, attemptCount: true },
      });
      if (stuck.length > 0) {
        await this.markStuckLogged(
          stuck.map((p) => p.id),
          now,
        );
        this.logger.warn(
          `出款卡在 PROCESSING：${stuck.length} 张` +
            `（${stuck.map((p) => p.payoutNo).join('、')}）——` +
            '⚠️ 可能已打款，需人工核对，**不要自动重试**',
        );
      }

      // ---- ② APPROVED 卡死：重新入队 ----
      //
      // ⚠️⚠️ **必须加「从未被执行过」（`attemptCount = 0`）**：
      //    `scheduleRetry` 退回 `APPROVED` 时**不刷新 `approvedAt`** ——
      //    一张两小时前审批的单，在重试退避期内（状态是 `APPROVED`、
      //    `approvedAt` 很旧）会被这里捞出来 → **额外入队一个救援 job**。
      //    救援 jobId（`payout-{id}-rescue-{n}`）与重试 jobId（`payout-{id}-{n}`）
      //    **不同命名空间**，BullMQ 不去重 → 两个 job 抢同一张单 →
      //    本该按 30s / 60s 退避打完的 3 次预算**几秒内被烧完**，
      //    渠道还没恢复就落了 `FAILED`。
      //
      // ⚠️ **`attemptCount = 0` 正好区分两种情况**：
      // - 「审批后入队失败」→ 从未被 worker 抢过 → `0` → **会被救援** ✅
      // - 「正在退避等待重试」→ 已被抢过 → `≥ 1` → **不会被救援** ✅
      // - 「入队成功但 job 被 BullMQ 丢了」→ 也没被抢过 → `0` → **会被救援** ✅
      //
      // ⚠️ **不要改成「刷新 `approvedAt`」** —— `approvedAt` 的语义是
      //    「审批时间」，刷新它会让平台端显示的审批时间变成假的。
      const stuckApproved = await this.prisma.payout.findMany({
        where: {
          status: PayoutStatus.APPROVED,
          approvedAt: { lt: threshold },
          attemptCount: 0,
        },
        select: { id: true, attemptCount: true },
      });
      if (stuckApproved.length > 0) {
        this.logger.warn(
          `出款卡在 APPROVED（审批后入队失败？）：${stuckApproved.length} 张 —— 重新入队`,
        );
      }
      return stuckApproved.map((p) => ({
        id: p.id,
        attemptCount: p.attemptCount,
      }));
    });
  }
}
