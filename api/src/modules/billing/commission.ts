/**
 * 平台抽佣的计算。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文。
 * 与阶段 5a 的 `discount-engine.ts` 同款理由 ——
 * 计钱的每一条分支都要能被完整断言。
 *
 * ⚠️ **全程整数域**：费率用基点（万分之），抽佣额用整数分。
 * 绝不出现 `amount * rate / 100` 这种浮点除法。
 */

/** 抽佣的结果 */
export interface CommissionResult {
  /** 抽佣额（整数分）。恒 >= 0，且 <= 计佣基数 */
  amount: number;
}

/**
 * 算抽佣。
 *
 * @param payableAmount 计佣基数：订单**实付**（整数分，已含优惠）
 * @param rateBps 费率（基点，万分之一）。500 = 5%
 */
export function computeCommission(input: {
  payableAmount: number;
  rateBps: number;
}): CommissionResult {
  // ⚠️ `payableAmount * rateBps` 的量级：10^8 × 10^4 = 10^12，
  // 远小于 2^53，整数安全。`Math.round` 收敛舍入误差。
  const raw = Math.round((input.payableAmount * input.rateBps) / 10000);
  // ⚠️ **封顶到实付**（护栏 M6）：抽佣不能超过商家的实收，
  // 否则高折扣时平台倒贴钱。下限 0。
  return { amount: Math.max(0, Math.min(raw, input.payableAmount)) };
}
