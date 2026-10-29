import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PayoutExecuteInput,
  PayoutExecuteResult,
  PayoutProvider,
} from './payout-provider.interface';

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
   * 设定接下来 N 次打款的「剧本」。
   *
   * ⚠️ **只允许平台超管调**（见 `fake-payout.controller.ts`）：
   * 这个开关能让「打款失败」→ 攻击者可以让商家出不了款。
   *
   * @param options.failTimes 接下来失败几次（0 = 不失败）
   * @param options.amountOffset 接下来几次返回的金额要加多少
   *   （用来造「渠道返回的金额与请求的不一致」→ 护栏 X3）
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
        new ServiceUnavailableException('本地假出款网关未启用'),
      );
    }

    // ⚠️ **失败也要给渠道交易号**：真实渠道失败时也会返回一个流水号，
    //    运营对账时要靠它去渠道查「这笔到底打没打出去」。
    const providerTxnId = `fake-pay-${randomUUID()}`;

    if (this.failTimes > 0) {
      this.failTimes -= 1;
      return Promise.resolve({
        providerTxnId,
        status: 'FAILED',
        // ⚠️ **失败路径不应用金额偏移，也不消耗它**：
        //    金额偏移是用来造「渠道金额核对不通过」（护栏 X3）的，
        //    那条护栏只对**成功路径**有意义（成功却金额对不上）。
        //    失败路径若也加偏移，就会造出「失败时金额也错 + 之后成功时金额也错」
        //    的组合，把两件事混在一起，测出来的原因会指向错误的护栏。
        amount: input.amount,
        failureReason: `假出款网关模拟的失败（第 ${input.attempt} 次尝试）`,
      });
    }

    return Promise.resolve({
      providerTxnId,
      status: 'SUCCESS',
      // ⚠️ **金额偏移只在这一次生效** —— 用来造「渠道金额核对不通过」
      //    （护栏 X3）。不消耗掉的话，之后每次成功都带偏移。
      amount: input.amount + this.takeAmountOffset(),
    });
  }

  queryPayout(providerTxnId: string): Promise<{ status: string }> {
    // 假网关没有「主动查询」的能力：打款是同步的，状态在 execute 里就定了。
    return Promise.resolve({ status: providerTxnId ? 'SUCCESS' : 'UNKNOWN' });
  }

  /** 取走一次金额偏移（只生效一次） */
  private takeAmountOffset(): number {
    const offset = this.amountOffset;
    this.amountOffset = 0;
    return offset;
  }
}
