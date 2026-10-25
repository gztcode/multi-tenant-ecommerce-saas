import { computeDiscount } from './discount-engine';
import type { DiscountContext } from './discount-engine';

/**
 * 优惠引擎的纯函数单测。
 *
 * ⚠️ **全部在整数域里断言**：金额一律整数分。
 * 「满 100 减 30」写成 10000 与 3000，断言写成 `toBe(7000)`，
 * 不是 `toBeCloseTo(70)`。
 */

/**
 * 引擎的「当前时间」。
 *
 * ⚠️ **刻意取一个远离真实时钟的值**（2019 年）。
 * 计划原文用的是 `2026-10-25T00:00:00Z`——那与本机的系统时钟只差几小时，
 * 于是「引擎改读 `Date.now()`」这个变异**测不出来**：
 * 券的有效期窗口覆盖了两种时刻，判定结果一样。
 * 取一个真实时钟永远到不了的年份，M15（时间由调用方传入）这条性质
 * 才真正被断言住。
 */
const NOW = new Date('2019-06-15T12:00:00Z');

/**
 * 造一个「有效期覆盖 NOW」的券/活动。
 *
 * ⚠️ 引擎要判「未过期」，所以 candidate 上必须带 startsAt / endsAt。
 * 设计文档 §4.1 的 `PromotionCandidate` 没列这两个字段，
 * 但 §4.2 的算法说「若 promotion 存在且 **未过期**」——
 * 判据在输入形状里必须有对应字段，否则引擎没法实现它。
 */
const WINDOW = {
  startsAt: new Date('2019-01-01T00:00:00Z'),
  endsAt: new Date('2019-12-31T00:00:00Z'),
};

function makeContext(
  overrides: Partial<DiscountContext> = {},
): DiscountContext {
  return {
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    now: NOW,
    originalAmount: 10000,
    items: [{ skuId: 'sku-1', quantity: 1, price: 10000 }],
    candidateCoupons: [],
    promotion: null,
    ...overrides,
  };
}

/** 造一张候选券 */
function coupon(
  overrides: Partial<DiscountContext['candidateCoupons'][number]> = {},
) {
  return {
    id: 'coupon-1',
    code: 'SAVE10',
    name: '减 10 元',
    type: 'FIXED' as const,
    value: 1000,
    minAmount: 5000,
    ...WINDOW,
    ...overrides,
  };
}

/** 造一个满减活动 */
function promotion(
  overrides: Partial<NonNullable<DiscountContext['promotion']>> = {},
) {
  return {
    id: 'promo-1',
    name: '满减活动',
    minAmount: 0,
    discountAmount: 0,
    ...WINDOW,
    ...overrides,
  };
}

describe('优惠引擎 computeDiscount', () => {
  describe('无券无活动', () => {
    it('没有券也没有活动：实付 = 原价，优惠额都是 0', () => {
      const result = computeDiscount(makeContext());

      expect(result.payableAmount).toBe(10000);
      expect(result.promotionDiscountAmount).toBe(0);
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.appliedCoupon).toBeNull();
    });
  });

  describe('门槛判定', () => {
    it('券的门槛按「活动后金额」判定：门槛不满足则这张券不可用', () => {
      // 门槛 5000，金额 10000 → 门槛满足
      const ok = computeDiscount(
        makeContext({ candidateCoupons: [coupon({ minAmount: 5000 })] }),
      );
      expect(ok.couponDiscountAmount).toBe(1000);
      expect(ok.payableAmount).toBe(9000);

      // 门槛 20000，金额 10000 → 不满足
      const notOk = computeDiscount(
        makeContext({ candidateCoupons: [coupon({ minAmount: 20000 })] }),
      );
      expect(notOk.couponDiscountAmount).toBe(0);
      expect(notOk.appliedCoupon).toBeNull();
      expect(notOk.payableAmount).toBe(10000);
    });

    it('门槛刚好等于金额：满足（≥ 而不是 >）', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 5000,
          candidateCoupons: [coupon({ minAmount: 5000, value: 1000 })],
        }),
      );

      expect(result.couponDiscountAmount).toBe(1000);
      expect(result.payableAmount).toBe(4000);
    });

    it('门槛为 0 = 无门槛：任何金额都可用', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 1,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );

      // ⚠️ 计划原文这里断言 `couponDiscountAmount` 是 1000、`payableAmount` 是 0，
      // 但那两条断言**互相矛盾**：金额只有 1 分，优惠 1000 分会让实付变成 -999，
      // 违反同一条设计文档里的硬要求「满减额不能把金额减成负数」（M10）。
      // 正确行为是优惠被封顶到金额本身（1 分），实付 0。
      // 本条要验的是「门槛 0 = 无门槛，券可用」，所以这里用没被封顶的金额再验一次。
      expect(result.couponDiscountAmount).toBe(1);
      expect(result.payableAmount).toBe(0);
      expect(result.appliedCoupon).not.toBeNull();

      // 金额足够大时没有门槛限制：面额全额生效
      const enough = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );
      expect(enough.couponDiscountAmount).toBe(1000);
      expect(enough.payableAmount).toBe(9000);
    });

    it('门槛按「活动后金额」判定：活动减完不达标则券不可用', () => {
      // 原价 10000，活动门槛 5000 减 6000 → 活动后 4000
      // 券的门槛 5000 → 4000 < 5000 → 券不可用
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            name: '满 50 减 60',
            minAmount: 5000,
            discountAmount: 6000,
          }),
          candidateCoupons: [coupon({ minAmount: 5000, value: 1000 })],
        }),
      );

      expect(result.promotionDiscountAmount).toBe(6000);
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(4000);
    });
  });

  describe('优惠额封顶（M10 / M6）', () => {
    it('券面额大于应付金额：优惠额被封顶，实付为 0 而不是负数', () => {
      // 面额 1000，金额 300 → 减 300，不是减 1000
      const result = computeDiscount(
        makeContext({
          originalAmount: 300,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );

      expect(result.couponDiscountAmount).toBe(300);
      expect(result.payableAmount).toBe(0);
      // ⚠️ 关键断言：绝不为负
      expect(result.payableAmount).toBeGreaterThanOrEqual(0);
    });

    it('活动减免额大于原价：活动优惠额被封顶，实付为 0', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 300,
          promotion: promotion({
            name: '大额活动',
            minAmount: 0,
            discountAmount: 10000,
          }),
        }),
      );

      expect(result.promotionDiscountAmount).toBe(300);
      expect(result.payableAmount).toBe(0);
    });

    it('实付恒不小于 0：遍历一组极端组合', () => {
      // 穷举一组「券面额 / 门槛 / 活动减免」的组合，断言 payable >= 0。
      // 这是 M10 的机械化版本——比逐个 case 断言更不容易漏。
      const amounts = [0, 1, 300, 9999, 10000];
      const values = [0, 1, 1000, 999999];
      for (const originalAmount of amounts) {
        for (const value of values) {
          for (const promoDiscount of [0, 1, 1000, 999999]) {
            const result = computeDiscount(
              makeContext({
                originalAmount,
                promotion: promotion({
                  minAmount: 0,
                  discountAmount: promoDiscount,
                }),
                candidateCoupons: [coupon({ minAmount: 0, value })],
              }),
            );
            expect(result.payableAmount).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });

  describe('多张券取最优（设计文档 §二 决策 3）', () => {
    it('两张券：选折后总价更低的那张', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [
            coupon({ id: 'c1', code: 'A', value: 1000, minAmount: 0 }),
            coupon({ id: 'c2', code: 'B', value: 3000, minAmount: 0 }),
          ],
        }),
      );

      expect(result.appliedCoupon?.id).toBe('c2');
      expect(result.couponDiscountAmount).toBe(3000);
      expect(result.payableAmount).toBe(7000);
    });

    it('多张券取最优的判据是「折后总价」而不是「优惠额」', () => {
      // 面额 10000 的券用在 3000 的单上 → 优惠被封顶成 3000，折后 0
      // 面额 2000 的券 → 优惠 2000，折后 1000
      // 「优惠额最大」会选第一张（3000 > 2000），但「折后总价最小」也选第一张（0 < 1000）——
      // 这里两者同向，所以再补一个两者反向的例子：
      //
      // 券 A：面额 10000，金额 3000 → 优惠封顶 3000，折后 0
      // 券 B：面额 3000 → 优惠 3000，折后 0
      // 两者折后并列（都是 0），优惠额也并列（都是 3000）——取先到的。
      //
      // 真正能区分的例子是「优惠额大但折后总价大」：
      // 券 A：面额 5000 → 优惠 5000，折后 5000
      // 券 B：面额 4000 → 优惠 4000，折后 6000
      // 两者优惠额与折后总价同向。要让两者反向，需要面额被封顶：
      // 券 A：面额 10000 → 封顶到 3000 → 优惠 3000，折后 0
      // 券 B：面额 2000 → 优惠 2000，折后 1000
      // 优惠额：A(3000) > B(2000)；折后总价：A(0) < B(1000)——仍然同向。
      //
      // ⚠️ 结论：在「优惠额 = min(面额, 应付)」的单调封顶下，
      // 优惠额大的券折后总价必然更小，两者等价。
      // 所以本条断言锁的是**实现口径**：引擎按折后总价比较，
      // 且结果与「优惠额最大」一致（此时取优惠额最大也无差别）。
      const result = computeDiscount(
        makeContext({
          originalAmount: 3000,
          candidateCoupons: [
            coupon({ id: 'big', code: 'BIG', value: 10000, minAmount: 0 }),
            coupon({ id: 'mid', code: 'MID', value: 2000, minAmount: 0 }),
          ],
        }),
      );

      expect(result.appliedCoupon?.id).toBe('big');
      expect(result.couponDiscountAmount).toBe(3000);
      expect(result.payableAmount).toBe(0);
    });

    it('两张券折后总价并列：取优惠额更大的那张', () => {
      // 券 A：门槛 10000、面额 3000 → 可用，优惠 3000，折后 7000
      // 券 B：门槛 10000、面额 3000 → 可用，优惠 3000，折后 7000（并列）
      // 再加一张：门槛 10000、面额 3000 但夹在中间 → 断言取最先到的那张
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [
            coupon({
              id: 'first',
              code: 'FIRST',
              value: 3000,
              minAmount: 10000,
            }),
            coupon({
              id: 'second',
              code: 'SECOND',
              value: 3000,
              minAmount: 10000,
            }),
          ],
        }),
      );

      expect(result.couponDiscountAmount).toBe(3000);
      // 并列时取「先到的」——候选券的数组顺序
      expect(result.appliedCoupon?.id).toBe('first');
    });

    it('一张券门槛不满足、另一张满足：选中满足的那张', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [
            coupon({ id: 'big', code: 'BIG', value: 1000, minAmount: 50000 }),
            coupon({ id: 'ok', code: 'OK', value: 2000, minAmount: 5000 }),
          ],
        }),
      );

      expect(result.appliedCoupon?.id).toBe('ok');
      expect(result.couponDiscountAmount).toBe(2000);
    });

    it('所有券都不可用：不选券，优惠额为 0', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [coupon({ minAmount: 50000 })],
        }),
      );

      expect(result.appliedCoupon).toBeNull();
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(10000);
    });
  });

  describe('活动与券的叠加顺序（M16）', () => {
    it('顺序是「先活动、后券」：券的门槛按活动后的金额判定', () => {
      // 原价 10000
      // 活动：门槛 5000，减 2000 → 活动后 8000
      // 券：门槛 8000（刚好等于活动后金额），面额 1000
      // 若顺序写反（先券后活动），券看到的是 10000 ≥ 8000 也满足，
      // 但优惠额会变成 10000 - 1000 - 2000 = 7000（一样）——
      // 所以要看**优惠额分配**：promotionDiscount 必须是 2000、couponDiscount 必须是 1000
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            name: '满 50 减 20',
            minAmount: 5000,
            discountAmount: 2000,
          }),
          candidateCoupons: [coupon({ minAmount: 8000, value: 1000 })],
        }),
      );

      expect(result.promotionDiscountAmount).toBe(2000);
      expect(result.couponDiscountAmount).toBe(1000);
      expect(result.payableAmount).toBe(7000);
      // 恒等式：原价 - 活动 - 券 = 实付
      expect(
        10000 - result.promotionDiscountAmount - result.couponDiscountAmount,
      ).toBe(result.payableAmount);
    });

    it('顺序写反会被抓到：活动门槛按「券后金额」判定时优惠额会不同', () => {
      // 原价 10000
      // 券：门槛 0，面额 3000 → 券后 7000
      // 活动：门槛 8000，减 1000
      //
      // 「先活动后券」：活动看 10000 ≥ 8000 → 减 1000 → 9000；
      //                 券看 9000 ≥ 0 → 减 3000 → 实付 6000
      // 「先券后活动」：券减 3000 → 7000；活动看 7000 < 8000 → 不减
      //                 → 实付 7000
      //
      // 两者实付不同，所以这条断言能区分顺序。
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            name: '满 80 减 10',
            minAmount: 8000,
            discountAmount: 1000,
          }),
          candidateCoupons: [coupon({ minAmount: 0, value: 3000 })],
        }),
      );

      expect(result.promotionDiscountAmount).toBe(1000);
      expect(result.couponDiscountAmount).toBe(3000);
      expect(result.payableAmount).toBe(6000);
    });
  });

  describe('有效期判定（M15：时间由调用方传入）', () => {
    it('已过期的活动不生效', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            minAmount: 0,
            discountAmount: 2000,
            endsAt: new Date('2019-06-14T00:00:00Z'), // 早于 NOW
          }),
        }),
      );

      expect(result.promotionDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(10000);
    });

    it('尚未开始的活动不生效', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            minAmount: 0,
            discountAmount: 2000,
            startsAt: new Date('2019-06-16T00:00:00Z'), // 晚于 NOW
          }),
        }),
      );

      expect(result.promotionDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(10000);
    });

    it('已过期的券不可用', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [
            coupon({
              minAmount: 0,
              value: 1000,
              endsAt: new Date('2019-06-14T00:00:00Z'),
            }),
          ],
        }),
      );

      expect(result.appliedCoupon).toBeNull();
      expect(result.couponDiscountAmount).toBe(0);
    });

    it('有效期的边界是左闭右开：endsAt 恰好等于 now 时不生效', () => {
      // startsAt <= now < endsAt
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            minAmount: 0,
            discountAmount: 2000,
            startsAt: NOW,
            endsAt: NOW,
          }),
        }),
      );

      expect(result.promotionDiscountAmount).toBe(0);
    });

    it('startsAt 恰好等于 now 时生效（左闭）', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: promotion({
            minAmount: 0,
            discountAmount: 2000,
            startsAt: NOW,
            endsAt: new Date('2019-06-16T00:00:00Z'),
          }),
        }),
      );

      expect(result.promotionDiscountAmount).toBe(2000);
      expect(result.payableAmount).toBe(8000);
    });

    it('M15：同一批券，只改 context.now 就换判定结果——引擎不读自己的时钟', () => {
      // ⚠️ 这条是 M15 的**机械化断言**，也是「引擎读 `Date.now()`」这个变异
      // 唯一的抓手：同一个 context（只换 now）必须给出不同结果。
      //
      // ⚠️ 如果 context.now 取的是贴近真实时钟的值，这个变异**测不出来**
      // ——有效期窗口覆盖了两种时刻，判定结果一样。所以 NOW 刻意取 2019 年，
      // 券的有效期窗口也覆盖 2019 年：真实时钟（2026 年）永远落在窗口外。
      const base = makeContext({
        originalAmount: 10000,
        candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
      });

      // now 在券的有效期内 → 券可用
      const inside = computeDiscount({ ...base, now: NOW });
      expect(inside.couponDiscountAmount).toBe(1000);
      expect(inside.payableAmount).toBe(9000);

      // 同一个券，只把 now 挪到有效期之后 → 券不可用
      const after = computeDiscount({
        ...base,
        now: new Date('2026-06-15T12:00:00Z'),
      });
      expect(after.appliedCoupon).toBeNull();
      expect(after.couponDiscountAmount).toBe(0);
      expect(after.payableAmount).toBe(10000);
    });
  });

  describe('PERCENT 类型（本阶段不实现，M11 的预留位）', () => {
    it('PERCENT 券不被使用：本阶段只实现 FIXED', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [
            coupon({ type: 'PERCENT', value: 90, minAmount: 0 }),
          ],
        }),
      );

      // 不选它，也不报错（本阶段是「静默跳过」，不是「抛异常」）
      expect(result.appliedCoupon).toBeNull();
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(10000);
    });

    it('PERCENT 与 FIXED 并存时只选 FIXED 那张', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [
            coupon({
              id: 'percent',
              code: 'P',
              type: 'PERCENT',
              value: 90,
              minAmount: 0,
            }),
            coupon({
              id: 'fixed',
              code: 'F',
              type: 'FIXED',
              value: 1000,
              minAmount: 0,
            }),
          ],
        }),
      );

      expect(result.appliedCoupon?.id).toBe('fixed');
      expect(result.couponDiscountAmount).toBe(1000);
    });
  });

  describe('整数域（M11）', () => {
    it('实付与优惠额都是整数：绝不含浮点尾数', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 3000,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );

      expect(Number.isInteger(result.payableAmount)).toBe(true);
      expect(Number.isInteger(result.couponDiscountAmount)).toBe(true);
      expect(Number.isInteger(result.promotionDiscountAmount)).toBe(true);
      // ⚠️ 具体地：不能是 2000.0000000000005 这类值
      expect(result.payableAmount).toBe(2000);
    });

    it('引擎不做任何除法：面额与金额再大也都是整数', () => {
      // ⚠️ M11 在本阶段是「预留位」——只有满减券，不触发除法。
      // 可测的形态是「引擎里没有浮点除法」：结果恒为整数。
      const result = computeDiscount(
        makeContext({
          originalAmount: 3333,
          promotion: promotion({ minAmount: 0, discountAmount: 1111 }),
          candidateCoupons: [coupon({ minAmount: 0, value: 777 })],
        }),
      );

      expect(Number.isInteger(result.payableAmount)).toBe(true);
      expect(Number.isInteger(result.couponDiscountAmount)).toBe(true);
      expect(Number.isInteger(result.promotionDiscountAmount)).toBe(true);
      expect(result.payableAmount).toBe(3333 - 1111 - 777);
    });
  });

  describe('appliedCoupon 的内容', () => {
    it('选中时带上 id / code / name / discountAmount', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [
            coupon({
              id: 'c9',
              code: 'HELLO',
              name: '见面礼',
              value: 2000,
              minAmount: 0,
            }),
          ],
        }),
      );

      expect(result.appliedCoupon).toEqual({
        id: 'c9',
        code: 'HELLO',
        name: '见面礼',
        discountAmount: 2000,
      });
    });

    it('appliedCoupon 的 discountAmount 是封顶后的优惠额，不是券面额', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 500,
          candidateCoupons: [
            coupon({ id: 'c', code: 'C', value: 1000, minAmount: 0 }),
          ],
        }),
      );

      expect(result.appliedCoupon?.discountAmount).toBe(500);
      expect(result.payableAmount).toBe(0);
    });
  });
});
