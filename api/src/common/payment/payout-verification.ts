/**
 * 出款核实的契约（阶段 5m）。
 *
 * ⚠️ **纯契约，不 import 任何模块** —— 仿 `common/queue/queue.constants.ts` 的先例。
 *    跨模块契约放 `common/` 是本仓的既定做法。
 *
 * ⚠️ **为什么需要它**：`billing` 模块的 `PayoutService.unstick` 要做「渠道核实闸」
 *    （防止重复打款），但 **billing 绝对不能 import payment**（模块环）。
 *    → 契约下沉到 `common/`，实现放能拿到渠道表的地方，billing 按 token 注入。
 */

/** 核实的对象（一张出款单） */
export interface PayoutVerificationTarget {
  /** 出款单 id */
  id: string;
  /** 出款单号（= 传给渠道的 `referenceNo`，**所有调过渠道的单都有**） */
  payoutNo: string;
  /** 渠道交易号（⚠️ `PAID` 的单才有；`PROCESSING` 的单没有） */
  payoutTxnId: string | null;
  /**
   * 这张单**实际要走的出款渠道**（阶段 6a）。
   *
   * ⚠️ **必须与打款 worker 取同一个渠道** —— 两处不一致 =
   *    「钱打到 A、核实查 B」→ B 说没打 → 放行解卡 → **重复打款**。
   * ⚠️ **`null` 的存量单**（阶段 5m 之前还没写 `payoutChannel`）→ 核实服务回落平台默认渠道。
   */
  payoutChannel: string | null;
}

/** 核实的结论 */
export interface PayoutVerificationVerdict {
  /** `PAID` = 渠道说钱打了；`FAILED` = 渠道说没打；`UNKNOWN` = 问不出结论 */
  verdict: 'PAID' | 'FAILED' | 'UNKNOWN';
  /** 结论来源 */
  source: 'REALTIME' | 'RECONCILIATION' | 'NONE';
  /** 渠道交易号（渠道说了才给） */
  providerTxnId?: string;
  /** 渠道侧金额（分） */
  amount?: number;
  /** 渠道侧打款时刻 */
  paidAt?: Date;
}

/** 核实能力（billing 按 token 注入这个接口） */
export interface PayoutVerification {
  verify(target: PayoutVerificationTarget): Promise<PayoutVerificationVerdict>;
}

/** 注入令牌 */
export const PAYOUT_VERIFICATION = Symbol('PAYOUT_VERIFICATION');
