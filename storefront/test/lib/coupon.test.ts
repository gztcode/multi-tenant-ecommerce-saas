/**
 * 券的前端纯函数：优惠拆分、剩余张数、可用判定、持有状态、预览拆分。
 *
 * 断言要**具体**：每条都给出确切的期望值，而不是「返回了一个对象」。
 * 这里断言的每一个数字都是**整数分**——前端一旦出现浮点，
 * 「原价 100 元减 30 元」就会显示成 69.999999999 这种东西。
 */
import { describe, expect, it } from 'vitest';

import {
  couponRemaining,
  couponUsable,
  discountBreakdown,
  myCouponState,
  previewBreakdown,
  type CouponPreview,
  type MyCoupon,
  type PreviewCoupon,
} from '@/lib/coupon';

/** 构造一张预览里的候选券 */
function previewCoupon(overrides: Partial<PreviewCoupon> = {}): PreviewCoupon {
  return {
    id: 'c-1',
    code: 'CODE-1',
    name: '满 100 减 10',
    type: 'FIXED',
    value: 1000,
    minAmount: 10000,
    discountAmount: 1000,
    payableAmount: 9000,
    ...overrides,
  };
}

/** 构造一张我持有的券 */
function myCoupon(overrides: Partial<MyCoupon> = {}): MyCoupon {
  return {
    id: 'c-1',
    code: 'CODE-1',
    name: '满 100 减 10',
    description: null,
    type: 'FIXED',
    value: 1000,
    minAmount: 10000,
    totalLimit: 100,
    claimedCount: 10,
    scope: 'SHOP',
    status: 'ACTIVE',
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: '2026-12-31T00:00:00.000Z',
    used: false,
    claimedQuantity: 1,
    ...overrides,
  };
}

/** 构造一份优惠预览 */
function preview(overrides: Partial<CouponPreview> = {}): CouponPreview {
  return {
    originalAmount: 10000,
    promotionDiscountAmount: 0,
    promotionName: null,
    coupons: [],
    bestCouponId: null,
    bestCouponDiscountAmount: 0,
    payableAmount: 10000,
    ...overrides,
  };
}

describe('discountBreakdown：四行金额的拆分', () => {
  it('原价 10000、活动减 2000、券减 1000 → 合计 3000、实付 7000', () => {
    const result = discountBreakdown({
      originalAmount: 10000,
      promotionDiscountAmount: 2000,
      couponDiscountAmount: 1000,
    });

    expect(result.originalAmount).toBe(10000);
    expect(result.promotionDiscountAmount).toBe(2000);
    expect(result.couponDiscountAmount).toBe(1000);
    expect(result.totalDiscount).toBe(3000);
    expect(result.payableAmount).toBe(7000);
  });

  it('没有任何优惠时：合计 0、实付 = 原价', () => {
    const result = discountBreakdown({
      originalAmount: 10000,
      promotionDiscountAmount: 0,
      couponDiscountAmount: 0,
    });

    expect(result.totalDiscount).toBe(0);
    expect(result.payableAmount).toBe(10000);
  });

  it('优惠额超过原价时截断到原价，实付恒 >= 0', () => {
    const result = discountBreakdown({
      originalAmount: 300,
      promotionDiscountAmount: 0,
      couponDiscountAmount: 1000,
    });

    expect(result.payableAmount).toBe(0);
    expect(result.payableAmount).toBeGreaterThanOrEqual(0);
    // ⚠️ 合计也不能超过原价——否则「原价 300、优惠 1000」在页面上
    // 会显示成「共省 1000 元」，比原价还多。
    expect(result.totalDiscount).toBe(300);
  });

  it('活动减与券减合计超过原价时一起截断，实付仍是 0', () => {
    const result = discountBreakdown({
      originalAmount: 500,
      promotionDiscountAmount: 400,
      couponDiscountAmount: 400,
    });

    expect(result.payableAmount).toBe(0);
    expect(result.totalDiscount).toBe(500);
  });

  it('全程整数：结果里不出现浮点', () => {
    const result = discountBreakdown({
      originalAmount: 3333,
      promotionDiscountAmount: 1111,
      couponDiscountAmount: 1111,
    });

    expect(Number.isInteger(result.originalAmount)).toBe(true);
    expect(Number.isInteger(result.promotionDiscountAmount)).toBe(true);
    expect(Number.isInteger(result.couponDiscountAmount)).toBe(true);
    expect(Number.isInteger(result.totalDiscount)).toBe(true);
    expect(Number.isInteger(result.payableAmount)).toBe(true);
    expect(result.payableAmount).toBe(1111);
  });
});

describe('couponRemaining：剩余可领张数', () => {
  it('不限量（totalLimit 为 null）→ null', () => {
    expect(
      couponRemaining({ totalLimit: null, claimedCount: 37 }),
    ).toBeNull();
  });

  it('限量且未领完 → 剩余张数', () => {
    expect(
      couponRemaining({ totalLimit: 100, claimedCount: 30 }),
    ).toBe(70);
  });

  it('刚好领完 → 0', () => {
    expect(
      couponRemaining({ totalLimit: 100, claimedCount: 100 }),
    ).toBe(0);
  });

  it('领超了 → 0 而不是负数', () => {
    expect(
      couponRemaining({ totalLimit: 100, claimedCount: 120 }),
    ).toBe(0);
  });
});

describe('couponUsable：这张券现在能不能用', () => {
  it('减免额大于 0 → 可用', () => {
    expect(
      couponUsable(previewCoupon({ discountAmount: 1000 })),
    ).toBe(true);
  });

  it('减免额为 0（门槛不满足）→ 不可用', () => {
    expect(
      couponUsable(previewCoupon({ discountAmount: 0 })),
    ).toBe(false);
  });

  it('门槛未满但减免额为 0 → 不可用（判据是减免额，不是前端自己比门槛）', () => {
    // 原价 5000 < 门槛 10000，后端算出的减免额是 0
    const coupon = previewCoupon({
      minAmount: 10000,
      discountAmount: 0,
      payableAmount: 5000,
    });

    expect(couponUsable(coupon)).toBe(false);
  });
});

describe('myCouponState：我持有的券的状态', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');

  it('有效期内且没用过 → AVAILABLE', () => {
    expect(myCouponState(myCoupon(), now)).toBe('AVAILABLE');
  });

  it('用户核销过 → USED_UP', () => {
    expect(myCouponState(myCoupon({ used: true }), now)).toBe('USED_UP');
  });

  it('券被下架（status 不是 ACTIVE）→ EXPIRED', () => {
    expect(
      myCouponState(myCoupon({ status: 'DISABLED' }), now),
    ).toBe('EXPIRED');
  });

  it('过了有效期 → EXPIRED', () => {
    expect(
      myCouponState(
        myCoupon({ endsAt: '2026-06-01T00:00:00.000Z' }),
        now,
      ),
    ).toBe('EXPIRED');
  });

  it('now 正好等于 endsAt → EXPIRED（有效期窗口左闭右开）', () => {
    expect(
      myCouponState(
        myCoupon({ endsAt: now.toISOString() }),
        now,
      ),
    ).toBe('EXPIRED');
  });

  it('now 比 endsAt 早一刻 → AVAILABLE', () => {
    const endsAt = new Date('2026-06-15T00:00:00.000Z');
    expect(
      myCouponState(
        myCoupon({ endsAt: endsAt.toISOString() }),
        new Date(endsAt.getTime() - 1),
      ),
    ).toBe('AVAILABLE');
  });
});

describe('previewBreakdown：预览 + 用户选的券 → 四行金额', () => {
  it('选了具体券 → 用那张券的减免额', () => {
    const result = previewBreakdown(
      preview({
        originalAmount: 10000,
        promotionDiscountAmount: 2000,
        coupons: [
          previewCoupon({ id: 'c-1', discountAmount: 1000 }),
          previewCoupon({ id: 'c-2', discountAmount: 3000 }),
        ],
        bestCouponId: 'c-2',
        bestCouponDiscountAmount: 3000,
      }),
      'c-1',
    );

    expect(result.couponDiscountAmount).toBe(1000);
    expect(result.promotionDiscountAmount).toBe(2000);
    expect(result.totalDiscount).toBe(3000);
    expect(result.payableAmount).toBe(7000);
  });

  it('没选券 → 用自动取最优的减免额（不是「不用券」）', () => {
    const result = previewBreakdown(
      preview({
        originalAmount: 10000,
        coupons: [previewCoupon({ id: 'c-2', discountAmount: 3000 })],
        bestCouponId: 'c-2',
        bestCouponDiscountAmount: 3000,
        payableAmount: 7000,
      }),
      null,
    );

    expect(result.couponDiscountAmount).toBe(3000);
    expect(result.totalDiscount).toBe(3000);
    expect(result.payableAmount).toBe(7000);
  });

  it('没选券时传空串 → 同样走自动取最优', () => {
    const result = previewBreakdown(
      preview({
        originalAmount: 10000,
        bestCouponId: 'c-2',
        bestCouponDiscountAmount: 3000,
      }),
      '',
    );

    expect(result.couponDiscountAmount).toBe(3000);
  });

  it('选了一个不存在的券 id → 券减免 0（不猜）', () => {
    const result = previewBreakdown(
      preview({
        originalAmount: 10000,
        coupons: [previewCoupon({ id: 'c-1', discountAmount: 1000 })],
        bestCouponId: 'c-1',
        bestCouponDiscountAmount: 1000,
      }),
      'c-not-exist',
    );

    expect(result.couponDiscountAmount).toBe(0);
    expect(result.payableAmount).toBe(10000);
  });

  it('券减超过原价时实付仍 >= 0', () => {
    const result = previewBreakdown(
      preview({
        originalAmount: 300,
        coupons: [previewCoupon({ id: 'c-1', discountAmount: 1000 })],
        bestCouponId: 'c-1',
        bestCouponDiscountAmount: 1000,
      }),
      'c-1',
    );

    expect(result.payableAmount).toBe(0);
    expect(result.payableAmount).toBeGreaterThanOrEqual(0);
    expect(result.totalDiscount).toBe(300);
  });
});
