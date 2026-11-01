import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ChannelPayoutRecord,
  PayoutExecuteInput,
  PayoutExecuteResult,
  PayoutProvider,
  PayoutQuery,
} from './payout-provider.interface';
import { FAKE_PAYOUT_UNAVAILABLE_MESSAGE } from './payout.constants';

/** 假出款网关的渠道名 */
export const FAKE_PAYOUT_CHANNEL = 'fake-payout';

/** 假出款网关的服务提供方名 */
export const FAKE_PAYOUT_PROVIDER = 'fake-payout';

/**
 * 假出款网关是否启用。
 *
 * ⚠️ **与 `FAKE_PAYMENT_ENABLED` 是两个独立的开关** ——
 * 用同一个的话，开着假支付网关就等于同时开着假出款网关，
 * 两个环境的启停会互相牵连。
 *
 * ⚠️ **默认关闭**。这不是便利开关，是**安全边界**：
 * 假出款网关能让「打款失败」，商家会以为平台不给钱。
 */
export function isFakePayoutEnabled(): boolean {
  return process.env.FAKE_PAYOUT_ENABLED === 'true';
}

/** 假网关记下的一次打款尝试 */
interface FakePayoutAttempt {
  /** 渠道交易号 */
  providerTxnId: string;
  /** 业务单号（= 我们的 `payoutNo`） */
  referenceNo: string;
  /** 金额（分） */
  amount: number;
  /** 渠道侧状态 */
  status: string;
  /** 失败原因 */
  failureReason?: string;
  /** ⚠️ **打款时刻** —— `listPayouts(from, to)` 的时间窗靠它过滤 */
  executedAt: Date;
}

/**
 * 本地假出款网关（阶段 5h-2）。
 *
 * ## 它怎么「模拟失败」
 *
 * ⚠️ **用一个进程内的计数器**：连续 N 次打款返回失败，N 用完就恢复正常。
 *
 * 为什么不用「按金额」「按账号」这类隐式约定：那类约定在 e2e 里很难读懂，
 * 也不容易断言「到底失败了几次」。计数器是显式的、可断言的。
 *
 * ⚠️ **进程内状态**：e2e 里 api 与 worker 在**同一个进程** → 状态共享 ✅。
 * 生产环境多进程部署时它不可靠 —— 但假网关本来就只在本地开发用
 * （生产环境 `assertSecureConfig` 会拒绝启动）。
 *
 * ## 阶段 5m 的变化：它必须「说真话」
 *
 * ⚠️ **原来的 `queryPayout` 恒返回 `SUCCESS`** —— 拿它当核实闸的话，
 * 每一张单都会被判定为「渠道说已打款」→ 解卡重打功能全废。
 * → 现在改为**存每次 `execute` 的真实结果**，按 `referenceNo` 与 `providerTxnId`
 * **两个键都建索引**（`PROCESSING` 的单只有 `payoutNo`，没有交易号）。
 *
 * ⚠️ **记录只增不减，没有上限** —— 假网关只在本地开发与 e2e 用
 *    （生产环境 `assertSecureConfig` 会拒绝启动），量级可控；
 *    真渠道接入时这个类会被换掉，流水在渠道侧、不在进程内。
 */
@Injectable()
export class FakePayoutProvider implements PayoutProvider {
  readonly channel = FAKE_PAYOUT_CHANNEL;
  readonly provider = FAKE_PAYOUT_PROVIDER;

  /** 接下来还要失败几次 */
  private failTimes = 0;
  /** 接下来几次返回的金额要偏移多少（用来造「渠道金额核对不通过」） */
  private amountOffset = 0;

  /**
   * 每笔出款**实际发给渠道的请求**（按 `referenceId` 存）。
   *
   * ⚠️ **为什么需要它**：护栏 X2b 说「打款要用审批时的账户快照」。
   *    只断言 API 响应里的 `maskedSnapshotAccountNo` **验不了这一层** ——
   *    那个字段读的是**库里存的快照**，而「传给渠道的 account」是另一份数据。
   *    worker 若传了实时账户，钱会打到错的账户，而快照字段纹丝不动 →
   *    断言照样通过 → **护栏没有牙齿**。
   *    记录下真实发出去的请求，才能断言「渠道收到的就是快照」。
   *
   * ⚠️ **按 `referenceId` 存，不存「最后一次」**：e2e 里 worker 在同一进程跑，
   *    别的单子也在打款 → 「最后一次」会被别的单覆盖。
   */
  private readonly received = new Map<string, PayoutExecuteInput>();

  /**
   * 每次打款尝试的**真实结果**（阶段 5m）。
   *
   * ⚠️ **按 `referenceNo` 建索引**：解卡核实闸的对象是 `PROCESSING` 的单，
   *    它**没有 `payoutTxnId`** —— 只按交易号查会查不到。
   */
  private readonly attemptsByReferenceNo = new Map<
    string,
    FakePayoutAttempt[]
  >();

  /** 同上，按渠道交易号建索引（`PAID` 的单只有交易号） */
  private readonly attemptsByTxnId = new Map<string, FakePayoutAttempt>();

  /**
   * 设定接下来 N 次打款的「剧本」。
   *
   * ⚠️ **只允许平台超管调**（见 `fake-payout.controller.ts`）：
   * 这个开关能让「打款失败」→ 攻击者可以让商家出不了款。
   *
   * @param options.failTimes 接下来失败几次（0 = 不失败）
   * @param options.amountOffset 接下来几次返回的金额要加多少
   *    （用来造「渠道返回的金额与请求的不一致」→ 护栏 X3）
   */
  armScenario(options: { failTimes?: number; amountOffset?: number }): void {
    // ⚠️ **必须自己兜底非有限数**：入参来自 HTTP body（见 `fake-payout.controller.ts`），
    //    而那里用的是**内联 TS 类型** → Nest 的 ValidationPipe 对
    //    `metatype === Object` 会**跳过校验** → `{"times":"abc"}` 能原样进来。
    //    `Math.floor('abc')` → `NaN` → `Math.max(0, NaN)` → `NaN` →
    //    `this.failTimes > 0` 恒为 false → **假网关永远成功**，
    //    失败剧本被静默吞掉（测试看起来「通过」，实际什么都没造出来）。
    //    `NaN` / `Infinity` 一律当作 0。
    this.failTimes = this.toFiniteCount(options.failTimes);
    this.amountOffset = this.toFiniteCount(options.amountOffset);
  }

  /** 把入参规整成「非负整数」，非有限数（NaN / Infinity）当作 0 */
  private toFiniteCount(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  }

  /** 当前还要失败几次（测试与诊断用） */
  remainingFailures(): number {
    return this.failTimes;
  }

  /**
   * 取某笔出款**实际发给渠道的请求**（测试与诊断用）。
   *
   * @param referenceId 出款单 id
   * @returns 传给渠道的请求；没打过就是 `undefined`
   */
  receivedRequest(referenceId: string): PayoutExecuteInput | undefined {
    return this.received.get(referenceId);
  }

  execute(input: PayoutExecuteInput): Promise<PayoutExecuteResult> {
    // ⚠️ **先记录再分支** —— 失败的那次也要留下记录：
    //    「渠道收到了什么」与「渠道成功没有」是两件事。
    this.received.set(input.referenceId, input);
    if (!isFakePayoutEnabled()) {
      // ⚠️ **返回 rejected promise 而不是同步抛错**：这个方法是**异步**的
      //    （`Promise<PayoutExecuteResult>`），调用方会用 `await` 接它。
      //    同步抛错与 rejected promise 在 `await` 下的表现一样，
      //    但同步抛错会让「`execute(...)` 这行本身就可能炸」——
      //    调用方若写成 `provider.execute(x).catch(...)` 就漏掉了。
      return Promise.reject(
        new ServiceUnavailableException(FAKE_PAYOUT_UNAVAILABLE_MESSAGE),
      );
    }

    // ⚠️ **失败也要给渠道交易号**：真实渠道失败时也会返回一个流水号，
    //    运营对账时要靠它去渠道查「这笔到底打没打出去」。
    const providerTxnId = `fake-pay-${randomUUID()}`;

    if (this.failTimes > 0) {
      this.failTimes -= 1;
      const failureReason = `假出款网关模拟的失败（第 ${input.attempt} 次尝试）`;
      // ⚠️ **失败路径不应用金额偏移，也不消耗它**：
      //    金额偏移是用来造「渠道金额核对不通过」（护栏 X3）的，
      //    那条护栏只对**成功路径**有意义（成功却金额对不上）。
      //    失败路径若也加偏移，就会造出「失败时金额也错 + 之后成功时金额也错」
      //    的组合，把两件事混在一起，测出来的原因会指向错误的护栏。
      this.recordAttempt({
        providerTxnId,
        referenceNo: input.referenceNo,
        amount: input.amount,
        status: 'FAILED',
        failureReason,
      });
      return Promise.resolve({
        providerTxnId,
        status: 'FAILED',
        amount: input.amount,
        failureReason,
      });
    }

    const amount = input.amount + this.takeAmountOffset();
    this.recordAttempt({
      providerTxnId,
      referenceNo: input.referenceNo,
      amount,
      status: 'SUCCESS',
    });
    return Promise.resolve({
      providerTxnId,
      status: 'SUCCESS',
      // ⚠️ **金额偏移只在这一次生效** —— 用来造「渠道金额核对不通过」
      //    （护栏 X3）。不消耗掉的话，之后每次成功都带偏移。
      amount,
    });
  }

  /**
   * 查一笔打款的状态。
   *
   * ⚠️ **按真实记录回答**（阶段 5m）—— 恒返回 `SUCCESS` 会让解卡核实闸
   * 永远放行 → 解卡重打功能全废。
   *
   * ⚠️ **网关未启用时也返回 `UNKNOWN`** —— 与「查不到」同义，
   *    下游都当「问不出结论」fail-closed 处理（核实服务会降级查对账结果）。
   *    ⚠️ **与 `listPayouts` 故意不对称**：那边的空数组会被当成
   *    「渠道说这一笔没有」→ 所有本地已付单全变成 E 类 → 那里必须抛错。
   */
  queryPayout(
    query: PayoutQuery,
  ): Promise<{ status: string; amount?: number; paidAt?: Date }> {
    const attempt = this.findAttempt(query);
    if (!attempt) {
      // ⚠️ **查不到 ≠ 渠道说没打** —— 只能回 `UNKNOWN`，
      //    让调用方进入下一层核实（fail-closed）。
      return Promise.resolve({ status: 'UNKNOWN' });
    }
    return Promise.resolve({
      status: attempt.status,
      amount: attempt.amount,
      paidAt: attempt.executedAt,
    });
  }

  /**
   * 批量查渠道侧的出款流水（阶段 5m）。
   *
   * ⚠️ **时间窗是左闭右开** `[from, to)`。
   * ⚠️ **失败的那次尝试也在结果里** —— 否则「第一次失败第二次成功」
   *    在渠道侧只剩一条 SUCCESS，对账就测不出重试场景。
   */
  listPayouts(query: { from: Date; to: Date }): Promise<ChannelPayoutRecord[]> {
    if (!isFakePayoutEnabled()) {
      // ⚠️ **抛错而不是返回空数组** —— 返回空数组会被当成
      //    「渠道说这一笔没有」→ 所有本地已付单全变成 E 类。
      return Promise.reject(
        new ServiceUnavailableException(FAKE_PAYOUT_UNAVAILABLE_MESSAGE),
      );
    }
    const records: ChannelPayoutRecord[] = [];
    for (const attempts of this.attemptsByReferenceNo.values()) {
      for (const attempt of attempts) {
        if (
          attempt.executedAt.getTime() >= query.from.getTime() &&
          attempt.executedAt.getTime() < query.to.getTime()
        ) {
          records.push({
            referenceNo: attempt.referenceNo,
            providerTxnId: attempt.providerTxnId,
            amount: attempt.amount,
            status: attempt.status,
            paidAt: attempt.executedAt,
            failureReason: attempt.failureReason,
          });
        }
      }
    }
    return Promise.resolve(records);
  }

  /** 记下一次打款尝试（两个索引都建） */
  private recordAttempt(attempt: Omit<FakePayoutAttempt, 'executedAt'>): void {
    // ⚠️ **打款时刻在这里盖戳** —— 它是「这次尝试发生的那一刻」，
    //    属于记录动作本身，不该由调用方传（传了就有「传错时刻」的机会）。
    const record: FakePayoutAttempt = { ...attempt, executedAt: new Date() };
    const list = this.attemptsByReferenceNo.get(record.referenceNo) ?? [];
    list.push(record);
    this.attemptsByReferenceNo.set(record.referenceNo, list);
    this.attemptsByTxnId.set(record.providerTxnId, record);
  }

  /** 按 `providerTxnId` 或 `referenceNo` 找到对应的尝试记录 */
  private findAttempt(query: PayoutQuery): FakePayoutAttempt | undefined {
    if (query.providerTxnId) {
      const byTxn = this.attemptsByTxnId.get(query.providerTxnId);
      if (byTxn) {
        return byTxn;
      }
    }
    if (query.referenceNo) {
      const list = this.attemptsByReferenceNo.get(query.referenceNo);
      // ⚠️ **取最后一条** —— 同一单可能有多次尝试（重试），
      //    最后一次才是当前状态。
      return list && list.length > 0 ? list[list.length - 1] : undefined;
    }
    return undefined;
  }

  /** 取走一次金额偏移（只生效一次） */
  private takeAmountOffset(): number {
    const offset = this.amountOffset;
    this.amountOffset = 0;
    return offset;
  }
}
