/**
 * 平台超管后台的计费展示纯函数。
 *
 * ⚠️ **这些函数必须留在 `src/lib/billing.ts`（而不是 `.tsx`）**：
 * vitest 只收 test 目录下的 .test.ts，塞在组件里就没法单独测。
 *
 * 测的是「同一份数据在不同状态下显示成什么字」——
 * 超管看到「在售」还是「已下架」、费率是「5%」还是「5.00%」，
 * 是产品文案的一部分，不是实现细节。
 */
import { describe, expect, it } from 'vitest';

import {
  describePlanStatus,
  describeSubscriptionStatus,
  formatCommissionRate,
  formatDateTime,
  formatFeatureFlags,
  formatPeriodDays,
  formatPriceLabel,
  formatQuota,
  formatRevenueLabel,
  percentToBps,
  toIsoRange,
  type Plan,
  type PlatformSubscription,
} from '@/lib/billing';

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    code: 'PRO',
    name: '专业版',
    description: null,
    price: 9900,
    periodDays: 30,
    trialDays: 14,
    commissionBps: 500,
    maxProducts: 100,
    maxSkus: 500,
    maxStores: 1,
    features: {},
    status: 'ACTIVE',
    sortOrder: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function subscription(
  overrides: Partial<PlatformSubscription> = {},
): PlatformSubscription {
  return {
    id: 'sub-1',
    tenantId: 'tenant-1',
    tenantName: '示例商家',
    tenantSubdomain: 'demo',
    planId: 'plan-1',
    planName: '专业版',
    pendingPlanId: null,
    pendingPlanName: null,
    status: 'ACTIVE',
    commissionBps: 500,
    startedAt: '2026-10-01T00:00:00.000Z',
    trialEndsAt: null,
    currentPeriodStart: '2026-10-01T00:00:00.000Z',
    currentPeriodEnd: '2026-10-31T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe('describePlanStatus：套餐状态文案', () => {
  it('在售', () => {
    expect(describePlanStatus(plan({ status: 'ACTIVE' }).status)).toBe('在售');
  });

  it('已下架', () => {
    expect(describePlanStatus(plan({ status: 'DISABLED' }).status)).toBe(
      '已下架',
    );
  });

  it('未知状态不猜，回落到「未知状态」', () => {
    // ⚠️ **不能猜成「在售」**：猜错了超管会以为一个已下架的套餐还在卖。
    expect(describePlanStatus(plan({ status: 'WEIRD' as Plan['status'] }).status)).toBe(
      '未知状态',
    );
  });
});

describe('describeSubscriptionStatus：订阅状态文案', () => {
  it('试用中', () => {
    expect(
      describeSubscriptionStatus(subscription({ status: 'TRIAL' }).status),
    ).toBe('试用中');
  });

  it('生效中', () => {
    expect(
      describeSubscriptionStatus(subscription({ status: 'ACTIVE' }).status),
    ).toBe('生效中');
  });

  it('已到期', () => {
    expect(
      describeSubscriptionStatus(subscription({ status: 'EXPIRED' }).status),
    ).toBe('已到期');
  });

  it('已取消', () => {
    expect(
      describeSubscriptionStatus(subscription({ status: 'CANCELLED' }).status),
    ).toBe('已取消');
  });

  it('未知状态不猜，回落到「未知状态」', () => {
    expect(
      describeSubscriptionStatus(
        subscription({ status: 'WEIRD' as PlatformSubscription['status'] })
          .status,
      ),
    ).toBe('未知状态');
  });
});

describe('formatPriceLabel：金额展示', () => {
  it('9900 分 → ¥99.00', () => {
    expect(formatPriceLabel(9900)).toBe('¥99.00');
  });

  it('⚠️ 0 元显示成「¥0.00」而不是「—」（免费套餐是真的 0 元）', () => {
    expect(formatPriceLabel(0)).toBe('¥0.00');
  });

  it('null → 「—」（缺数据）', () => {
    expect(formatPriceLabel(null)).toBe('—');
  });

  it('undefined → 「—」', () => {
    expect(formatPriceLabel(undefined)).toBe('—');
  });
});

describe('formatQuota：额度展示', () => {
  it('null → 「不限」', () => {
    expect(formatQuota(null)).toBe('不限');
  });

  it('⚠️ 0 → 「0」而不是「不限」（一个都不许 ≠ 不限）', () => {
    expect(formatQuota(0)).toBe('0');
  });

  it('12 → 「12」', () => {
    expect(formatQuota(12)).toBe('12');
  });

  it('undefined → 「不限」', () => {
    expect(formatQuota(undefined)).toBe('不限');
  });
});

describe('formatCommissionRate：抽佣率展示', () => {
  it('500 基点 → 5%', () => {
    expect(formatCommissionRate(500)).toBe('5%');
  });

  it('0 基点 → 0%', () => {
    expect(formatCommissionRate(0)).toBe('0%');
  });

  it('⚠️ 1250 基点 → 12.5%（不是「12.50%」）', () => {
    expect(formatCommissionRate(1250)).toBe('12.5%');
  });

  it('1000 基点 → 10%（不是「10.00%」）', () => {
    expect(formatCommissionRate(1000)).toBe('10%');
  });
});

describe('formatPeriodDays：订阅周期展示', () => {
  it('30 天', () => {
    expect(formatPeriodDays(30)).toBe('30 天');
  });

  it('365 天', () => {
    expect(formatPeriodDays(365)).toBe('365 天');
  });
});

describe('formatDateTime：时间展示', () => {
  it('合法 ISO 串 → 非空的本地时间字符串', () => {
    const label = formatDateTime('2026-10-01T08:30:00.000Z');

    expect(label).toBeTruthy();
    expect(label).not.toBe('Invalid Date');
  });

  it('⚠️ 非法字符串 → 原样回显（不让整张表格崩掉）', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('null → 「—」', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('formatFeatureFlags：功能开关展示', () => {
  it('已知的开关显示中文名', () => {
    expect(formatFeatureFlags({ marketing: true })).toContain('营销工具');
  });

  it('空对象 → 「无」', () => {
    expect(formatFeatureFlags({})).toBe('无');
  });

  it('⚠️ 未知的功能键也要显示出来（不能静默丢掉）', () => {
    const label = formatFeatureFlags({ marketing: true, secretFeature: true });

    expect(label).toContain('营销工具');
    expect(label).toContain('secretFeature');
  });

  it('关掉的开关不显示（缺省视为 false）', () => {
    expect(formatFeatureFlags({ marketing: false })).toBe('无');
  });
});

describe('formatRevenueLabel：收入展示', () => {
  it('与 formatPriceLabel 同款（复用同一个换算）', () => {
    expect(formatRevenueLabel(9900)).toBe('¥99.00');
    expect(formatRevenueLabel(0)).toBe('¥0.00');
    expect(formatRevenueLabel(null)).toBe('—');
  });
});

describe('percentToBps：抽佣比例 → 基点', () => {
  it('5% → 500 基点', () => {
    expect(percentToBps('5')).toBe(500);
  });

  it('5.5% → 550 基点', () => {
    expect(percentToBps('5.5')).toBe(550);
  });

  it('12.5% → 1250 基点', () => {
    expect(percentToBps('12.5')).toBe(1250);
  });

  it('0% → 0 基点', () => {
    expect(percentToBps('0')).toBe(0);
  });

  it('⚠️ 两位小数要取整（5.55 * 100 的真值是 555.0000000000001）', () => {
    expect(percentToBps('5.55')).toBe(555);
  });

  it('⚠️ 三位小数 → null（不做「尽量解析」）', () => {
    expect(percentToBps('5.555')).toBeNull();
  });

  it('⚠️ 负数 → null', () => {
    expect(percentToBps('-1')).toBeNull();
  });

  it('⚠️ 非数字 → null', () => {
    expect(percentToBps('abc')).toBeNull();
  });

  it('⚠️ 科学计数法 → null（parseFloat 会解析成 1000）', () => {
    expect(percentToBps('1e3')).toBeNull();
  });

  it('⚠️ 空串 → null', () => {
    expect(percentToBps('')).toBeNull();
  });

  it('⚠️ 带尾巴的串 → null（parseFloat 会解析出 5.5）', () => {
    expect(percentToBps('5.5abc')).toBeNull();
  });
});

describe('toIsoRange：自然日 → 带时区的 ISO 区间', () => {
  it('1 月 1 日到 1 月 31 日 → 终点是 2 月 1 日零点（区间右开）', () => {
    const range = toIsoRange('2026-01-01', '2026-01-31');

    expect(range).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
  });

  it('⚠️ 同一天合法（区间是一整天）', () => {
    const range = toIsoRange('2026-01-01', '2026-01-01');

    expect(range).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    });
  });

  it('跨月跨年 → 终点是次年 1 月 6 日零点', () => {
    const range = toIsoRange('2026-12-15', '2027-01-05');

    expect(range).toEqual({
      from: '2026-12-15T00:00:00.000Z',
      to: '2027-01-06T00:00:00.000Z',
    });
  });

  it('闰日 2 月 29 日 → 终点是 3 月 1 日零点', () => {
    const range = toIsoRange('2028-02-28', '2028-02-29');

    expect(range).toEqual({
      from: '2028-02-28T00:00:00.000Z',
      to: '2028-03-01T00:00:00.000Z',
    });
  });

  it('⚠️ 不存在的日期（2026-02-30）→ 报错', () => {
    // `Date.UTC(2026, 1, 30)` 会把它静默滚成 3 月 2 日 —— 必须回查。
    const range = toIsoRange('2026-02-30', '2026-03-01');

    expect('error' in range).toBe(true);
  });

  it('⚠️ 非闰年的 2 月 29 日（2026-02-29）→ 报错', () => {
    const range = toIsoRange('2026-02-29', '2026-03-01');

    expect('error' in range).toBe(true);
  });

  it('⚠️ 格式不对（2026-1-1）→ 报错', () => {
    const range = toIsoRange('2026-1-1', '2026-01-02');

    expect('error' in range).toBe(true);
  });

  it('结束日期早于开始日期 → 报错', () => {
    const range = toIsoRange('2026-02-01', '2026-01-01');

    expect('error' in range).toBe(true);
  });

  it('结束日期格式不对 → 报错', () => {
    const range = toIsoRange('2026-01-01', '2026-1-2');

    expect('error' in range).toBe(true);
  });
});
