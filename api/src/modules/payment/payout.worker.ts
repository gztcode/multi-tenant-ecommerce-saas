import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { RedisLockService } from '../../common/lock/redis-lock.service';
import { QueueService } from '../queue/queue.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import { PayoutSubmitResult } from '../../common/payment/payout-provider.interface';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import { PayoutReconciliationService } from './payout-reconciliation.service';

/** 出款队列任务的数据 */
export interface PayoutJob {
  /** 出款单 id（`'execute'` job） */
  payoutId: string;
  /** 渠道名（`'reconcile'` job） */
  channel?: string;
  /**
   * 对账任务 id（`'reconcile-run'` job，阶段 6 审查修复）。
   *
   * ⚠️ **与 `channel` 分开** —— `'reconcile'` 是「定时对账的触发」
   *    （跑昨天那个窗口），`'reconcile-run'` 是「执行某笔已建好的对账任务」
   *    （手动触发时入队的就是它）。
   */
  reconciliationId?: string;
}

/**
 * 失败重试的上限（含首次）。
 *
 * ⚠️ **固定 3 次，不做成环境变量** —— 它是**业务规则**（设计 D1），
 *    不是部署参数。e2e 就按 3 次验。
 */
export const PAYOUT_MAX_ATTEMPTS = 3;

/**
 * 重试退避的基数（毫秒）。
 *
 * ⚠️ **实际退避 = 基数 × 尝试次数**（本次失败是第几次就等几倍）。
 * 默认 30 秒 → 第 1 次失败等 30s、第 2 次失败等 60s。
 *
 * ⚠️ **没有 90s 那一次**：第 3 次失败时 `attemptCount >= PAYOUT_MAX_ATTEMPTS`
 *    → 直接落 `FAILED`，**不再重试** → 没有第 4 次执行。
 *    所以实际只有 30s / 60s 两段退避。
 *
 * ⚠️ **不用指数退避**：出款的失败通常是渠道临时不可用，分钟级重试够了；
 *    指数退避会让第 3 次拖到 2 小时后，商家看到「已审批」两小时没动静会打电话。
 *
 * ⚠️ **做成环境变量是因为 e2e 要跑得快**：
 *    e2e 里设成 100ms → 三次重试总共 600ms 内跑完；
 *    用默认的 30 秒的话，e2e 要等 3 分钟。
 *
 * ⚠️ **每次调用时读环境变量**（不在模块加载时缓存）——
 *    e2e 会在进程起来之后才设这个变量，缓存了就读不到。
 */
export function payoutRetryDelayMs(attempt: number): number {
  const base = Number(process.env.PAYOUT_RETRY_BASE_DELAY_MS ?? '30000');
  return base * attempt;
}

/**
 * 出款队列的消费端。
 *
 * ## 两个 job name
 *
 * - `execute`：执行一笔出款（审批后入队）
 * - `scan`：周期性扫描（卡死告警 + `APPROVED` 救援）
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 幂等靠「状态流转的条件更新」（`APPROVED → PROCESSING`），
 * 重复执行只有一个赢（护栏 X1）。
 *
 * ⚠️ **必须用平台作用域**：`payouts` 在租户白名单里，
 * 而队列消费是跨进程边界的 —— `AsyncLocalStorage` 的上下文不跟着走。
 * `PayoutExecutionService` 的每个方法内部都自己 `run(platformScope(), ...)`。
 */
@Processor(PAYOUT_QUEUE)
@Injectable()
export class PayoutWorker extends WorkerHost {
  private readonly logger = new Logger(PayoutWorker.name);

  constructor(
    private readonly execution: PayoutExecutionService,
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
    // ⚠️ **阶段 6a：按 `claim.channel` 取渠道** —— 不再「取第一个」。
    //    注册表来自 `@Global()` 的 `PayoutProvidersModule`。
    private readonly registry: PayoutProviderRegistry,
    // ⚠️ **加在末尾且可选** —— `payout-worker.spec.ts` 用位置参数构造 worker，
    //    必填的话那个 spec 的 20 处构造都要补参数（超出本 Task 的改动范围）。
    //    可选 → 现有用例一行不用改。
    private readonly reconciliation?: PayoutReconciliationService,
    // 阶段 11：跨副本互斥锁（同上可选，spec 兼容）
    private readonly lock?: RedisLockService,
  ) {
    super();
  }

  async process(job: Job<PayoutJob>): Promise<void> {
    if (job.name === 'scan') {
      await this.runScan();
      return;
    }
    if (job.name === 'reconcile') {
      // ⚠️ **定时对账**（阶段 5m）
      await this.runReconcile(job.data.channel);
      return;
    }
    if (job.name === 'reconcile-run') {
      // ⚠️ **执行一笔已入队的对账任务**（阶段 6 审查修复）——
      //    手动触发的对账不再同步跑（会被 Nginx 60 秒超时砍掉）。
      await this.runReconcileTask(job.data.reconciliationId, job.data.channel);
      return;
    }
    if (job.name !== 'execute') {
      return;
    }
    await this.runExecute(job.data.payoutId);
  }

  /**
   * 执行一笔出款。
   *
   * ## 三步
   *
   * 1. **抢单**：`APPROVED → PROCESSING`（护栏 X1）
   * 2. **打之前的闸**：解密失败 / 金额 ≤ 0 / 账户快照缺失 → 落 `FAILED`
   *    （护栏 X4、§5.1c；解密失败是阶段 5k 加的第三条）
   * 3. **调渠道** → 落终态（`PAID` / 退回 `APPROVED` / 落 `FAILED`）
   */
  private async runExecute(payoutId: string): Promise<void> {
    const now = await this.prisma.databaseNow();

    // ---- STEP 1：抢单 ----
    const claim = await this.execution.claimForExecution(payoutId, now);
    if (!claim) {
      // ⚠️ **静默返回**（护栏 X1）：抢不到可能是另一路 worker 抢先了，
      //    也可能是已被人工处理。**不重试、不落 FAILED** ——
      //    抛错会让 BullMQ 把它记成失败 job，排查时全是假故障。
      this.logger.log(`出款 ${payoutId} 抢不到（状态已变），跳过`);
      return;
    }

    // ---- STEP 1.5：打款前的闸 ----
    //
    // ⚠️ **解密失败必须在 `checkGates` 之前判** —— 否则 `account` 为 null
    //    会让 `checkGates` 报「收款账户快照缺失」，把真实原因盖掉。
    //
    // ⚠️ **落 FAILED 是安全的**：解密发生在**调渠道之前** → 渠道从未被调用
    //    → **确定没打钱**。这与「卡在 PROCESSING」（钱可能已打出去）语义相反，
    //    不能套用同一套处置（设计 §二·2.2）。
    if (claim.accountError) {
      // ⚠️ **根因只进日志** —— `decryptVersioned` 的消息里有「密钥不匹配」
      //    「密文已被篡改」「版本 0」这类内部术语，商家看到会恐慌
      //    （界面口径见设计 §二·2.4）。
      this.logger.error(
        `出款 ${payoutId} 的收款账号快照不可用：${claim.accountError}`,
      );
      await this.execution.markFailed(payoutId, {
        // ⚠️ **文案要自证「没打钱」**
        reason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道从未被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
      return;
    }

    // ⚠️ **渠道解析失败必须在 `checkGates` 之前判**（阶段 6a）——
    //    否则会被「账户缺失」之类的闸把真实原因盖掉。
    //
    // ⚠️ **为什么是「落 FAILED」而不是「抛异常」**：抢单事务已经提交
    //    （单子在 `PROCESSING`），抛出去既不会回滚成 `APPROVED`，
    //    还不会有人调用 `markFailed` → 单子卡在 `PROCESSING`，只能人工介入。
    //    而渠道**从未被调用** → 钱确定没打出去 → 落 FAILED 且可安全重试。
    if (claim.channelError) {
      this.logger.warn(
        `出款 ${payoutId} 无法确定出款渠道：${claim.channelError}`,
      );
      await this.execution.markFailed(payoutId, {
        reason: claim.channelError,
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道从未被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
      return;
    }

    // ⚠️ **都不调渠道**：不满足条件就不该打钱。
    const gateFailure = this.checkGates(claim);
    if (gateFailure) {
      await this.execution.markFailed(payoutId, {
        reason: gateFailure,
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道从未被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
      return;
    }

    // ---- STEP 2：调渠道 ----
    //
    // ⚠️ **按抢单时解析好的渠道取实现**（阶段 6a）—— 不再「取第一个」：
    //    注册两家之后，「取第一个」会让所有出款都打到第一家，
    //    而核实服务按 `payoutChannel` 查 → 两处不一致 = 重复打款。
    if (!claim.channel) {
      // ⚠️ **正常路径不该走到这里**（`channelError` 会先拦住）——
      //    只有代码 bug 才会「抢到单却既没渠道也没错误」→ 留痕才好排查。
      this.logger.warn(
        `出款 ${payoutId} 没有可用的出款渠道（抢单结果既无 channel 也无 channelError）`,
      );
      await this.execution.markFailed(payoutId, {
        reason: '没有可用的出款渠道',
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道压根没被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
      return;
    }

    let provider;
    try {
      provider = this.registry.get(claim.channel);
    } catch (error) {
      // ⚠️ **审批后渠道被停用 / 未注册**（运营改了配置）——
      //    渠道从未被调用，钱确定没打出去 → 落 FAILED 可重试，
      //    绝不能抛出去把单子留在 `PROCESSING`、钱没打也没人重试。
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `出款 ${payoutId} 取不到渠道 ${claim.channel}：${reason}`,
      );
      await this.execution.markFailed(payoutId, {
        reason,
        failedAt: await this.prisma.databaseNow(),
        failedBeforePayout: true,
      });
      return;
    }

    // ⚠️ **先记下渠道名，再调渠道** —— 见 `PayoutExecutionService.recordChannel`
    //    的说明：卡在 `PROCESSING` 的单必须能定位到渠道。
    //
    // ⚠️ **catch 留在 worker 侧** —— 「落库失败要不要阻断打款」是**调用方**
    //    的决策。DB 抖动时放弃打款 = 钱永远打不出去（兜底扫描只告警、
    //    绝不重试）→ 商家永远收不到钱。→ 记 warn 后继续打款。
    try {
      await this.execution.recordChannel(payoutId, provider.channel);
    } catch (error) {
      this.logger.warn(
        `出款 ${payoutId} 记录出款渠道失败（渠道 ${provider.channel}）：` +
          `${error instanceof Error ? error.message : String(error)} —— 继续打款`,
      );
    }

    let result: PayoutSubmitResult;
    try {
      result = await provider.submit({
        referenceId: payoutId,
        referenceNo: claim.payoutNo,
        amount: claim.netAmount,
        account: claim.account!,
        attempt: claim.attemptCount,
      });
    } catch (error) {
      // ⚠️ **渠道抛异常 = 结果未知**（阶段 6b）—— 超时 / 网络中断时钱**可能**
      //    已经打出去 → `definitive: false` → 不自动重试，只能人工核对。
      //    不能让它冒到 BullMQ —— `attempts: 1` 时它会进 failed 集合，
      //    而且我们自己的重试逻辑就永远不会跑。
      result = {
        providerTxnId: undefined,
        status: 'FAILED',
        amount: claim.netAmount,
        definitive: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }

    // ---- STEP 3：落终态 ----
    // ⚠️ **渠道要从这里一路带下去** —— 不能在 `settle` 里再取一次：
    //    两次取是两次独立的「取第一个注册渠道」，将来注册了第二家之后
    //    可能取到不同的渠道 → `payouts.payoutChannel` 写错渠道名。
    await this.settle(
      payoutId,
      claim.attemptCount,
      result,
      claim.netAmount,
      provider.channel,
    );
  }

  /**
   * 打款之前的两道闸。
   *
   * ⚠️ **理由一律用业务口径** —— 界面上的文案给商家看，
   *    内部术语（「快照缺失」「出款金额非法：-1 分」）商家看不懂，
   *    还会以为自己理解错了。
   *
   * @returns 失败原因（`null` = 闸都过了，可以打款）
   */
  private checkGates(claim: {
    netAmount: number;
    account: { accountNo: string } | null;
  }): string | null {
    if (claim.netAmount <= 0) {
      // ⚠️ **不暴露内部金额数字** —— 只说「异常」
      return '出款金额异常，本次未打款，请联系平台核对';
    }
    if (!claim.account) {
      return '收款账号信息异常，本次未打款，请更新收款账户后重新申请';
    }
    return null;
  }

  /**
   * 打款之后的三条路。
   *
   * ⚠️ **X3 金额核对**：渠道返回的金额必须等于请求金额，
   *    不等就是**渠道打错了**（打 100 块、账上记 1000 块）→ 落 `FAILED`，
   *    `failedBeforePayout: false`（钱可能已按错误金额打出）、**不自动重试**。
   *
   * ## 阶段 6b：按 `submit` 的三种状态分流（设计 §6.2）
   *
   * - `SUCCESS` → `markPaid`
   * - `FAILED` + `definitive: true` → `failedBeforePayout: true`，进现有重试预算
   * - `FAILED` + `definitive: false` → `failedBeforePayout: false`，**不自动重试**
   * - `PROCESSING` → **保持 `PROCESSING`**，不落失败、不投重试 job，
   *   交给 `scanStuck` 轮询
   * - `submit` 抛异常 → 落 `FAILED`、`failedBeforePayout: false`、**不自动重试**
   *
   * @param channel 本次实际调用的渠道名（**由调用方传进来**，
   *                不在这里重新取 —— 两次取可能取到不同的渠道）
   */
  private async settle(
    payoutId: string,
    attemptCount: number,
    result: PayoutSubmitResult,
    requestedAmount: number,
    channel: string,
  ): Promise<void> {
    const now = await this.prisma.databaseNow();

    if (result.status === 'PROCESSING') {
      // ⚠️ **`PROCESSING` 不是失败**（阶段 6b，设计 §6.2）——
      //    异步渠道第一次只返回 `PROCESSING`（钱可能已打出去）。
      //    → **保持 `PROCESSING`**，不落 `FAILED`、不投重试 job，
      //      交给 `scanStuck` 轮询渠道。

      // ⚠️ **不在这里写 `processingAt`** —— `claimForExecution` 抢单时
      //    已经与状态改 `PROCESSING` 写进同一个 `updateMany` 了。
      //    重复写只会覆盖成更晚的时刻，把「卡住多久」的判据弄歪。

      // ⚠️ **`payoutChannel` 也不在这里写** —— 调渠道之前已经调过
      //    `recordChannel`（按 `status: PROCESSING` 守卫），这里再写是重复动作。

      // ⚠️ **必须有日志** —— 否则运营看到一张单停在 `PROCESSING`，
      //    无从判断是渠道慢、还是 worker 漏了就走了。
      this.logger.warn(
        `出款 ${payoutId} 的渠道返回 PROCESSING（交易号 ${result.providerTxnId ?? '无'}），` +
          `保持 PROCESSING，交给 scanStuck 轮询结果`,
      );
      return;
    }

    if (result.status === 'FAILED') {
      // ⚠️ **`definitive` 决定能不能自动重试**（阶段 6b，设计 §6.2）：
      //    - `true`：渠道明确说没打 → 钱确定没出去 → 进现有重试预算；
      //    - `false`：结果未知 → 钱可能已经打出去 → 落了就不能自动重试。
      if (result.definitive) {
        await this.handleFailure(
          payoutId,
          attemptCount,
          result.failureReason ?? '渠道返回失败',
          now,
          result.providerTxnId,
        );
        return;
      }
      const reason = `${result.failureReason ?? '渠道返回失败'}（结果未知，需人工核对）`;
      await this.settleUnknownFailure(
        payoutId,
        reason,
        now,
        result.providerTxnId,
      );
      return;
    }

    if (result.amount !== requestedAmount) {
      await this.execution.markFailed(payoutId, {
        reason: `渠道金额核对不通过（请求 ${requestedAmount} 分，渠道返回 ${result.amount} 分）`,
        failedAt: now,
        // ⚠️ **渠道已经调过了** → 钱**可能**已经打出去 → 不能重试
        failedBeforePayout: false,
        // ⚠️ **新增**（阶段 5m）：渠道调过了 → 交易号要存
        providerTxnId: result.providerTxnId,
      });
      return;
    }

    await this.execution.markPaid(payoutId, {
      providerTxnId: result.providerTxnId,
      channel,
      paidAt: now,
    });
  }

  /**
   * 「结果未知」的失败：直接落 `FAILED`，**不进重试预算**。
   *
   * ⚠️ **为什么不能走 `handleFailure`**：那条路在未达上限时会退回 `APPROVED`
   *    并延迟重投 —— 对「钱可能已经打出去」的单，这等于确定性重复打款。
   *    这里一律 `failedBeforePayout: false`，只能走人工核对。
   */
  private async settleUnknownFailure(
    payoutId: string,
    reason: string,
    now: Date,
    providerTxnId: string | undefined,
  ): Promise<void> {
    await this.execution.markFailed(payoutId, {
      reason,
      failedAt: now,
      // ⚠️ **渠道已经调过了** → 钱**可能**已经打出去 → 不能重试
      failedBeforePayout: false,
      // ⚠️ **有交易号就带上** —— 「实时核实」对 FAILED 的单靠它
      providerTxnId,
    });
  }

  /**
   * **确定失败**后的两条路（护栏 X7）。
   *
   * ⚠️ **只处理 `definitive: true` 的失败** —— 结果未知的失败由
   *    `settleUnknownFailure` 直接落库，**不走这里**（不能自动重试）。
   *    渠道抛异常也按「结果未知」走 `settleUnknownFailure`（阶段 6b）。
   *
   * - 未超上限 → 退回 `APPROVED`，**延迟后重新入队**
   * - 达到上限 → 落 `FAILED`（并释放明细占用），
   *   `failedBeforePayout: true` —— 渠道明确说没打，钱确定没出去
   *
   * ⚠️ **重试预算只对 `definitive: true` 生效**（阶段 6b，设计 §6.2）。
   */
  private async handleFailure(
    payoutId: string,
    attemptCount: number,
    reason: string,
    now: Date,
    providerTxnId: string | undefined,
  ): Promise<void> {
    if (attemptCount >= PAYOUT_MAX_ATTEMPTS) {
      await this.execution.markFailed(payoutId, {
        reason,
        failedAt: now,
        // ⚠️ **`definitive: true` = 渠道明确说没打** → 钱确定没出去
        //    → 可人工重试（平台端的「重试」按钮只对 true 的单出现）。
        //    ⚠️ 这里**不能**写 false —— 那会让一张确定没打钱的单只能人工处理。
        failedBeforePayout: true,
        // ⚠️ **新增**（阶段 5m）：渠道失败时也会给交易号 → 存下来才能核实
        providerTxnId,
      });
      return;
    }

    const currentAttempt = await this.execution.scheduleRetry(payoutId, {
      now,
      reason,
    });
    if (currentAttempt === null) {
      return;
    }

    // ⚠️⚠️ **jobId 必须带「下一次」的轮次** —— 5f 的教训：
    //    BullMQ 里 failed job 的 hash 还在，用**同一个 jobId** 重新入队
    //    会被**静默忽略**（不报错、不入队 → 重试从未发生）。
    //
    //    ⚠️ **`scheduleRetry` 返回的是「本次」的 attemptCount**（= 1），
    //    而首次入队用的 jobId 已经是 `payout-{id}-1` → **两者完全相同**
    //    → 重试 job 被静默丢弃 → 单子永远停在 `APPROVED`。
    //    → **jobId 要用「下一次执行是第几次」**：`currentAttempt + 1`。
    const nextAttempt = currentAttempt + 1;

    // ⚠️ **退避时长仍然用「本次」的次数** —— 第一次失败等 1×基数、
    //    第二次失败等 2×基数（不要跟着 jobId 一起加 1）。
    const delay = payoutRetryDelayMs(currentAttempt);
    await this.queues.addWithOptions(
      PAYOUT_QUEUE,
      'execute',
      { payoutId },
      `payout-${payoutId}-${nextAttempt}`,
      // ⚠️ **removeOnComplete** —— BullMQ 默认把完成的 job 留在
      //    `completed` 集合里 → 队列一直涨，且**同一个 jobId 永远不能再用**。
      { attempts: 1, delay, removeOnComplete: true },
    );
    this.logger.warn(
      `出款失败，第 ${attemptCount} 次：${reason} —— ${delay / 1000} 秒后重试`,
    );
  }

  /**
   * 周期扫描：卡死告警 + `APPROVED` 救援。
   *
   * ⚠️ **绝不自动重试 `PROCESSING`**（设计 §九·R3）——
   *    钱可能已经打出去，重试 = 确定性地重复打款。
   */
  private async runScan(): Promise<void> {
    // ⚠️ **跨副本互斥**（阶段 11）：救援扫描虽经队列单消费，但
    //    「先回 APPROVED 再重投」的路径在多副本下可能并发；
    //    抢不到锁 = 另一副本本轮在扫，直接跳过。
    await this.withLockGuard('payout-scan', () => this.doRunScan());
  }

  private async doRunScan(): Promise<void> {
    const now = await this.prisma.databaseNow();
    const rescues = await this.execution.scanStuck(now);
    for (const { id, attemptCount } of rescues) {
      // ⚠️ **jobId 要稳定** —— 用 `attemptCount` 而不是时间戳：
      //    时间戳每次扫描都不同 → 队列里会堆满同一个单的重复 job。
      //    `attemptCount` 在进 PROCESSING 之前不变 → 同一个 jobId
      //    → BullMQ 静默忽略 → 不堆积。
      await this.queues.addWithOptions(
        PAYOUT_QUEUE,
        'execute',
        { payoutId: id },
        `payout-${id}-rescue-${attemptCount}`,
        // ⚠️ **removeOnComplete** —— 同 jobId 的 job 完成后再用会被静默忽略
        { attempts: 1, removeOnComplete: true },
      );
    }
    if (rescues.length > 0) {
      this.logger.warn(`出款救援：${rescues.length} 张 APPROVED 单重新入队`);
    }
  }

  /**
   * 定时对账（阶段 5m）。
   *
   * ⚠️ **失败不抛到 BullMQ** —— 抛出去会让 BullMQ 把它记成失败 job，
   *    而对账服务**自己已经**把任务落成了 `FAILED` 并写了原因。
   */
  /**
   * 执行一笔已入队的对账任务（阶段 6 审查修复）。
   *
   * ⚠️ **失败不重试** —— 对账任务自己的状态机会把失败落进任务行
   *    （`FAILED` + `errorMessage`），运营在任务列表里能看到并重新触发。
   *    BullMQ 自己的重试会让同一个窗口被对好几遍。
   */
  private async runReconcileTask(
    reconciliationId: string | undefined,
    channel: string | undefined,
  ): Promise<void> {
    if (!reconciliationId || !channel) {
      // ⚠️ **不能静默跳过** —— 缺参数只可能是代码 bug，
      //    静默 return 会让这个 bug 永远查不出来，
      //    而且这笔对账永远停在 `RUNNING`（运营以为在跑）。
      this.logger.error(
        `对账任务 job 缺少参数（reconciliationId=${reconciliationId ?? '缺'}，` +
          `channel=${channel ?? '缺'}），跳过`,
      );
      return;
    }
    if (!this.reconciliation) {
      return;
    }
    try {
      await this.reconciliation.executeReconciliation({
        reconciliationId,
        channel,
      });
    } catch (error) {
      // ⚠️ **日志要带上渠道与任务 id** —— 这个窗口没对成，
      //    没人会自动再触发它 → 漏了哪一天必须查得到。
      this.logger.error(
        `渠道对账失败（渠道 ${channel}，任务 ${reconciliationId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async runReconcile(channel: string | undefined): Promise<void> {
    if (!channel) {
      // ⚠️ **不能静默跳过** —— `channel` 缺失只可能是代码 bug
      //    （scheduler 投 job 时一定带 channel），静默 return 会让这个 bug
      //    永远查不出来，而且每天静默丢掉一整轮对账。
      this.logger.warn('定时对账 job 缺少 channel 参数，跳过');
      return;
    }
    if (!this.reconciliation) {
      return;
    }
    // ⚠️ **「同一时间只允许一个对账任务」**（阶段 11 的跨副本互斥）：
    //    队列的 jobSchedulerId 去重管「不重复调度」，管不了「不并发执行」
    //    （手动触发、异常重投都可能撞上）。锁是最后一条防线。
    await this.withLockGuard(`payout-reconcile:${channel}`, () =>
      this.doRunReconcile(channel),
    );
  }

  private async doRunReconcile(channel: string): Promise<void> {
    if (!this.reconciliation) {
      return;
    }
    try {
      await this.reconciliation.runScheduled(channel);
    } catch (error) {
      // ⚠️ **日志要带上渠道** —— 这个窗口今天没对成，没人会自动再触发它
      //    → 漏了哪一天必须查得到。
      this.logger.error(
        `定时渠道对账失败（渠道 ${channel}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 锁的统一包装（阶段 11）：无锁服务（spec 场景）直接执行；
   * 有锁服务时抢不到就跳过本轮（周期任务错过一轮无损失）。
   */
  private async withLockGuard<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<void> {
    if (!this.lock) {
      await fn();
      return;
    }
    const outcome = await this.lock.withLock(key, fn);
    if (!outcome.acquired) {
      this.logger.log(`另一副本持有锁，本轮跳过：${key}`);
    }
  }
}
