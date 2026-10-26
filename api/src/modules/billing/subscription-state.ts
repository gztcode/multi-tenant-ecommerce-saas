/**
 * 订阅状态的判定（纯函数）。
 *
 * ⚠️ **纯函数**：不碰数据库、不读上下文。与阶段 5a 的 `discount-engine.ts`
 * 同款理由 —— 判定「有没有服务」是业务里最常被改坏的一段，
 * 它必须能被单独测。
 */

/** 判定所需的最小形状 */
export interface ServiceState {
  status: string;
  /** 试用截止。null = 不是试用 */
  trialEndsAt: Date | null;
  /** 当前周期结束 */
  currentPeriodEnd: Date;
}

/**
 * 这个租户现在有没有服务（能不能接新单）。
 *
 * ⚠️ **同时看状态与时间**：即使扫任务的 worker 还没跑到，
 * 判定也是对的 —— 不依赖「有没有人来把过期的改成 EXPIRED」。
 *
 * ⚠️ **试用与正式两种口径不同**：试用期看 `trialEndsAt`，
 * 正式期看 `currentPeriodEnd`。
 */
export function hasService(state: ServiceState, now: Date): boolean {
  if (state.status === 'TRIAL') {
    return (
      state.trialEndsAt !== null && state.trialEndsAt.getTime() > now.getTime()
    );
  }
  if (state.status === 'ACTIVE') {
    return state.currentPeriodEnd.getTime() > now.getTime();
  }
  // EXPIRED / CANCELLED —— 没有服务
  return false;
}
