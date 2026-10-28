import {
  shouldBackfillCommission,
  shouldBackfillReversal,
} from './commission.service';

/**
 * 回填的判定规则（阶段 5e）。
 *
 * ⚠️ **断言要具体**：断言每个分支的确切判定结果，不是「返回了一个布尔值」。
 * 这两个纯函数是「回填」与「报表过滤」之间的**同一套口径**的载体 ——
 * 两者漂移了，流水表与报表的数字就对不上（对账 e2e 会红）。
 */
describe('回填的判定规则', () => {
  it('没付过钱 → 不回填抽佣', () => {
    expect(shouldBackfillCommission(null, 500)).toBe(false);
  });

  it('付过钱且金额非零 → 回填抽佣', () => {
    expect(
      shouldBackfillCommission(new Date('2026-01-01T00:00:00.000Z'), 500),
    ).toBe(true);
  });

  it('零额 → 不回填抽佣（免费套餐的费率是 0）', () => {
    expect(
      shouldBackfillCommission(new Date('2026-01-01T00:00:00.000Z'), 0),
    ).toBe(false);
  });

  it('没退款 → 不回填冲回', () => {
    expect(
      shouldBackfillReversal(false, new Date('2026-01-02T00:00:00.000Z'), 500),
    ).toBe(false);
  });

  it('已退款但 refundedAt 为 null → 不回填冲回（5b 之前退的款没记时间）', () => {
    expect(shouldBackfillReversal(true, null, 500)).toBe(false);
  });

  it('已退款且有 refundedAt → 回填冲回', () => {
    expect(
      shouldBackfillReversal(true, new Date('2026-01-02T00:00:00.000Z'), 500),
    ).toBe(true);
  });

  it('零额的已退款订单 → 不回填冲回', () => {
    expect(
      shouldBackfillReversal(true, new Date('2026-01-02T00:00:00.000Z'), 0),
    ).toBe(false);
  });
});
