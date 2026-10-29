import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import {
  PayoutExecuteResult,
  PayoutProvider,
} from './payout-provider.interface';
import { PAYOUT_PROVIDERS } from './payment.constants';

/** 出款队列任务的数据 */
export interface PayoutJob {
  /** 出款单 id */
  payoutId: string;
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
    @Inject(PAYOUT_PROVIDERS)
    private readonly providers: Map<string, PayoutProvider>,
  ) {
    super();
  }

  async process(job: Job<PayoutJob>): Promise<void> {
    if (job.name === 'scan') {
      await this.runScan();
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
   * 2. **两道闸**：金额 ≤ 0 / 账户快照缺失 → 落 `FAILED`（护栏 X4、§5.1c）
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

    // ---- STEP 1.5：两道「打之前」的闸 ----
    // ⚠️ **都不调渠道**：不满足条件就不该打钱。
    const gateFailure = this.checkGates(claim);
    if (gateFailure) {
      await this.execution.markFailed(payoutId, {
        reason: gateFailure,
        failedAt: await this.prisma.databaseNow(),
      });
      return;
    }

    // ---- STEP 2：调渠道 ----
    // ⚠️ **本阶段只有一个出款渠道**（假网关），所以直接取第一个。
    //    ⚠️ **将来接真渠道时这里要改成按 `payouts.payoutChannel` 取** ——
    //    取「第一个」的话，加了第二家之后所有出款都会打到第一家。
    const provider = this.firstProvider();
    if (!provider) {
      await this.execution.markFailed(payoutId, {
        reason: '没有可用的出款渠道',
        failedAt: await this.prisma.databaseNow(),
      });
      return;
    }

    let result: PayoutExecuteResult;
    try {
      result = await provider.execute({
        referenceId: payoutId,
        referenceNo: claim.payoutNo,
        amount: claim.netAmount,
        account: claim.account!,
        attempt: claim.attemptCount,
      });
    } catch (error) {
      // ⚠️ **渠道抛异常 = 这次打款失败**，走重试路径
      //    （不能让它冒到 BullMQ —— `attempts: 1` 时它会进 failed 集合，
      //    而且我们自己的重试逻辑就永远不会跑）
      result = {
        providerTxnId: '',
        status: 'FAILED',
        amount: claim.netAmount,
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
   * @returns 失败原因（`null` = 闸都过了，可以打款）
   */
  private checkGates(claim: {
    netAmount: number;
    account: { accountNo: string } | null;
  }): string | null {
    if (claim.netAmount <= 0) {
      return `出款金额非法：${claim.netAmount} 分`;
    }
    if (!claim.account) {
      return '收款账户快照缺失';
    }
    return null;
  }

  /**
   * 打款之后的三条路。
   *
   * ⚠️ **X3 金额核对**：渠道返回的金额必须等于请求金额，
   *    不等就是**渠道打错了**（打 100 块、账上记 1000 块）→ 落 `FAILED`。
   *
   * @param channel 本次实际调用的渠道名（**由调用方传进来**，
   *                不在这里重新取 —— 两次取可能取到不同的渠道）
   */
  private async settle(
    payoutId: string,
    attemptCount: number,
    result: PayoutExecuteResult,
    requestedAmount: number,
    channel: string,
  ): Promise<void> {
    const now = await this.prisma.databaseNow();

    if (result.status !== 'SUCCESS') {
      const reason = result.failureReason ?? '渠道返回失败';
      await this.handleFailure(payoutId, attemptCount, reason, now);
      return;
    }

    if (result.amount !== requestedAmount) {
      await this.execution.markFailed(payoutId, {
        reason: `渠道金额核对不通过（请求 ${requestedAmount} 分，渠道返回 ${result.amount} 分）`,
        failedAt: now,
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
   * 失败后的两条路（护栏 X7）。
   *
   * - 未超上限 → 退回 `APPROVED`，**延迟后重新入队**
   * - 达到上限 → 落 `FAILED`（并释放明细占用）
   */
  private async handleFailure(
    payoutId: string,
    attemptCount: number,
    reason: string,
    now: Date,
  ): Promise<void> {
    if (attemptCount >= PAYOUT_MAX_ATTEMPTS) {
      await this.execution.markFailed(payoutId, { reason, failedAt: now });
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

  /** 取第一个已注册的渠道（假网关只有一家） */
  private firstProvider(): PayoutProvider | undefined {
    for (const provider of this.providers.values()) {
      return provider;
    }
    return undefined;
  }
}
