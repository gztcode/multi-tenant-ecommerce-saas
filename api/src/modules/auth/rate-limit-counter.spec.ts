import { RateLimitCounter, RateLimitRule } from './rate-limit-counter';

const RULE: RateLimitRule = { max: 3, windowMs: 60_000 };
const T0 = new Date('2026-11-27T00:00:00Z').getTime();

describe('RateLimitCounter：进程内固定窗口计数器', () => {
  let now: number;
  let counter: RateLimitCounter;

  beforeEach(() => {
    now = T0;
    // 时钟直接注入，不依赖 jest 假定时器：跨窗口的用例只改这一个变量。
    counter = new RateLimitCounter({ now: () => now });
  });

  it('未达上限前 isLimited 为 false，达到上限后为 true', () => {
    expect(counter.isLimited('k', RULE)).toBe(false);

    counter.record('k', RULE);
    counter.record('k', RULE);
    expect(counter.isLimited('k', RULE)).toBe(false);

    counter.record('k', RULE);
    expect(counter.isLimited('k', RULE)).toBe(true);
  });

  it('窗口内第 N 次触发（record 返回累计次数）', () => {
    expect(counter.record('k', RULE)).toBe(1);
    expect(counter.record('k', RULE)).toBe(2);
    expect(counter.record('k', RULE)).toBe(3);
    expect(counter.record('k', RULE)).toBe(4);
  });

  it('窗口过后自动归零（下次 record 从 1 重新开始）', () => {
    counter.record('k', RULE);
    counter.record('k', RULE);
    counter.record('k', RULE);
    expect(counter.isLimited('k', RULE)).toBe(true);

    now += RULE.windowMs + 1;

    expect(counter.isLimited('k', RULE)).toBe(false);
    expect(counter.record('k', RULE)).toBe(1);
  });

  it('reset 立即清零', () => {
    counter.record('k', RULE);
    counter.record('k', RULE);
    counter.record('k', RULE);

    counter.reset('k');

    expect(counter.isLimited('k', RULE)).toBe(false);
  });

  it('不同 key 互不影响', () => {
    counter.record('a', RULE);
    counter.record('a', RULE);
    counter.record('a', RULE);

    expect(counter.isLimited('a', RULE)).toBe(true);
    expect(counter.isLimited('b', RULE)).toBe(false);
  });

  it('条目数不超过容量：满了先清过期项，再丢最老的一条', () => {
    const bounded = new RateLimitCounter({ now: () => now, capacity: 2 });

    bounded.record('oldest', RULE);
    bounded.record('newer', RULE);
    expect(bounded.size).toBe(2);

    bounded.record('newest', RULE);

    expect(bounded.size).toBe(2);
    // 最老的一条被挤掉：它重新计数时返回 1，而不是 2
    expect(bounded.record('oldest', RULE)).toBe(1);
  });

  it('容量满时先清过期项，不会白丢还活着的条目', () => {
    const bounded = new RateLimitCounter({ now: () => now, capacity: 2 });

    bounded.record('expired', { max: 3, windowMs: 1_000 });
    now += 2_000;
    bounded.record('alive', RULE);

    // 记第三条时容量已满：应先清掉过期的 'expired'，而不是丢掉 'alive'
    bounded.record('fresh', RULE);

    expect(bounded.record('alive', RULE)).toBe(2);
  });
});
