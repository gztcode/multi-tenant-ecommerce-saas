import { hasService } from './subscription-state';
import type { ServiceState } from './subscription-state';

/**
 * 订阅状态判定的纯函数单测。
 *
 * ⚠️ **这条判定直接决定「能不能接新单」**（护栏 M12，阶段 5b Task 6 的下单拦截
 * 依赖它）—— 判错了，商家会被错误地拒单或错误地放单。
 */

/**
 * 判定的「当前时间」。
 *
 * ⚠️ **刻意取一个远离真实时钟的值**（2019 年）。
 * 如果取贴近真实时钟的值，「判定用的是传进来的 `now`、不是 `Date.now()`」
 * 这条性质**测不出来** —— 真实时钟（2026 年）永远落在所有测试窗口之外，
 * 判定结果会恒为 false，两种实现给不出不同的答案。
 * 取一个真实时钟永远到不了的年份，M15（时间由调用方传入）这条性质
 * 才真正被断言住。
 */
const NOW = new Date('2019-06-15T12:00:00Z');

/** 一个「有服务」的订阅（各分支只改状态与时间） */
function makeState(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    status: 'ACTIVE',
    trialEndsAt: null,
    currentPeriodEnd: new Date('2019-07-15T12:00:00Z'),
    ...overrides,
  };
}

describe('订阅状态判定 hasService', () => {
  describe('试用期（TRIAL）', () => {
    it('试用还没到期：有服务', () => {
      const state = makeState({
        status: 'TRIAL',
        trialEndsAt: new Date('2019-06-16T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(true);
    });

    it('试用已到期：没有服务', () => {
      const state = makeState({
        status: 'TRIAL',
        trialEndsAt: new Date('2019-06-14T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(false);
    });

    it('试用截止为 null：不是试用，没有服务', () => {
      const state = makeState({
        status: 'TRIAL',
        trialEndsAt: null,
      });

      expect(hasService(state, NOW)).toBe(false);
    });

    it('边界：试用截止恰好等于 now → 没有服务（左闭右开，到点即失效）', () => {
      const state = makeState({
        status: 'TRIAL',
        trialEndsAt: NOW,
      });

      expect(hasService(state, NOW)).toBe(false);
    });
  });

  describe('正式期（ACTIVE）', () => {
    it('当前周期还没结束：有服务', () => {
      const state = makeState({
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2019-07-15T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(true);
    });

    it('当前周期已结束：没有服务', () => {
      const state = makeState({
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2019-05-15T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(false);
    });

    it('边界：当前周期结束恰好等于 now → 没有服务（左闭右开，到点即失效）', () => {
      const state = makeState({
        status: 'ACTIVE',
        currentPeriodEnd: NOW,
      });

      expect(hasService(state, NOW)).toBe(false);
    });

    it('试用与正式期看的是两个字段：ACTIVE 时 trialEndsAt 不参与判定', () => {
      // 试用截止在未来，但当前周期已结束 → 没有服务
      const state = makeState({
        status: 'ACTIVE',
        trialEndsAt: new Date('2019-08-01T12:00:00Z'),
        currentPeriodEnd: new Date('2019-05-15T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(false);
    });
  });

  describe('已过期与已取消', () => {
    it('EXPIRED：没有服务（哪怕时间字段还没到）', () => {
      const state = makeState({
        status: 'EXPIRED',
        currentPeriodEnd: new Date('2029-07-15T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(false);
    });

    it('CANCELLED：没有服务（哪怕时间字段还没到）', () => {
      const state = makeState({
        status: 'CANCELLED',
        currentPeriodEnd: new Date('2029-07-15T12:00:00Z'),
      });

      expect(hasService(state, NOW)).toBe(false);
    });
  });

  describe('M15：时间由调用方传入，判定不读自己的时钟', () => {
    it('同一个状态，只改 now 就换判定结果——判定不读 Date.now()', () => {
      // ⚠️ 这条是 M15 的**机械化断言**，也是「判定改读 `Date.now()`」这个变异
      // 唯一的抓手：同一个状态（只换 now）必须给出不同结果。
      //
      // ⚠️ 如果 now 取的是贴近真实时钟的值，这个变异**测不出来** ——
      // 时间窗口覆盖了两种时刻，判定结果一样。所以 NOW 刻意取 2019 年。
      const state = makeState({
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2019-07-15T12:00:00Z'),
      });

      // now 在周期内 → 有服务
      expect(hasService(state, NOW)).toBe(true);

      // 同一个状态，只把 now 挪到周期之后 → 没有服务
      expect(hasService(state, new Date('2026-06-15T12:00:00Z'))).toBe(false);
    });
  });
});
