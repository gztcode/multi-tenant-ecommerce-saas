import { computeCommission } from './commission';

/**
 * 抽佣计算（纯函数）。
 *
 * ⚠️ **断言要具体**：断言每个字段的**确切数值**，不是「返回了一个对象」。
 * 这里断言的每一个数字都是**整数分** —— 前端/后端一旦出现浮点，
 * 「100 元抽 5%」就会变成 4.999999999。
 */
describe('computeCommission：抽佣计算', () => {
  it('5% 的费率：实付 10000 → 抽佣 500', () => {
    expect(computeCommission({ payableAmount: 10000, rateBps: 500 })).toEqual({
      amount: 500,
    });
  });

  it('费率 0 → 不抽', () => {
    expect(computeCommission({ payableAmount: 10000, rateBps: 0 })).toEqual({
      amount: 0,
    });
  });

  it('实付 0 → 抽佣 0', () => {
    expect(computeCommission({ payableAmount: 0, rateBps: 500 })).toEqual({
      amount: 0,
    });
  });

  it('⚠️ 封顶到实付：面额大的费率不能抽出超过实付的钱（护栏 M6）', () => {
    // 100% 费率抽 300 的单，只能抽 300
    expect(computeCommission({ payableAmount: 300, rateBps: 10000 })).toEqual({
      amount: 300,
    });
  });

  it('⚠️ 费率高于 100% 也封顶到实付', () => {
    expect(computeCommission({ payableAmount: 300, rateBps: 20000 })).toEqual({
      amount: 300,
    });
  });

  it('⚠️ 全程整数：结果一定是整数，且不出现浮点尾数', () => {
    // 999 * 3333 / 10000 = 332.9667 → 取整 333
    const result = computeCommission({ payableAmount: 999, rateBps: 3333 });
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.amount).toBe(333);
  });

  it('⚠️ 抽佣额永远不为负', () => {
    expect(
      computeCommission({ payableAmount: 10000, rateBps: -100 }).amount,
    ).toBe(0);
  });
});
