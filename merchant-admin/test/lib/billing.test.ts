/**
 * 计费模块的展示纯函数。
 *
 * ⚠️ **这些函数必须留在 `src/lib/billing.ts`（而不是 `.tsx`）**：
 * vitest 只收 test 目录下的 .test.ts，塞在组件里就没法单独测。
 *
 * 测的是「同一份数据在不同状态下显示成什么字」——
 * 商家看到「试中」还是「试用中」、账单是「待支付」还是「未支付」，
 * 是产品文案的一部分，不是实现细节。
 */
import { describe, expect, it } from 'vitest';

import {
  describeInvoiceStatus,
  describeSubscriptionStatus,
  formatCommissionRate,
  formatQuota,
  formatPriceLabel,
  type Invoice,
  type Subscription,
} from '@/lib/billing';

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    tenantId: 'tenant-1',
    planId: 'plan-1',
    pendingPlanId: null,
    status: 'ACTIVE',
    startedAt: '2026-10-01T00:00:00.000Z',
    trialEndsAt: null,
    currentPeriodStart: '2026-10-01T00:00:00.000Z',
    currentPeriodEnd: '2026-10-31T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    tenantId: 'tenant-1',
    subscriptionId: 'sub-1',
    planId: 'plan-1',
    number: 'INV-2026-001',
    amount: 9900,
    status: 'OPEN',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-10-31T00:00:00.000Z',
    dueAt: '2026-10-31T00:00:00.000Z',
    paidAt: null,
    voidedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('describeSubscriptionStatus：订阅状态文案', () => {
  it('未订阅（null）', () => {
    expect(describeSubscriptionStatus(null)).toBe('未订阅');
  });

  it('试用中', () => {
    expect(describeSubscriptionStatus(subscription({ status: 'TRIAL' }))).toBe(
      '试用中',
    );
  });

  it('生效中', () => {
    expect(describeSubscriptionStatus(subscription({ status: 'ACTIVE' }))).toBe(
      '生效中',
    );
  });

  it('已到期', () => {
    expect(describeSubscriptionStatus(subscription({ status: 'EXPIRED' }))).toBe(
      '已到期',
    );
  });

  it('已取消', () => {
    expect(describeSubscriptionStatus(subscription({ status: 'CANCELLED' }))).toBe(
      '已取消',
    );
  });

  it('未知状态不猜，回落到「未知状态」', () => {
    expect(
      describeSubscriptionStatus(
        subscription({ status: 'WEIRD' as Subscription['status'] }),
      ),
    ).toBe('未知状态');
  });
});

describe('describeInvoiceStatus：账单状态文案', () => {
  it('待支付', () => {
    expect(describeInvoiceStatus(invoice({ status: 'OPEN' }))).toBe('待支付');
  });

  it('已支付', () => {
    expect(describeInvoiceStatus(invoice({ status: 'PAID' }))).toBe('已支付');
  });

  it('支付失败', () => {
    expect(describeInvoiceStatus(invoice({ status: 'FAILED' }))).toBe('支付失败');
  });

  it('已作废', () => {
    expect(describeInvoiceStatus(invoice({ status: 'VOID' }))).toBe('已作废');
  });

  it('未知状态不猜，回落到「未知状态」', () => {
    expect(
      describeInvoiceStatus(invoice({ status: 'WEIRD' as Invoice['status'] })),
    ).toBe('未知状态');
  });
});

describe('枚举漂移：后端的真实值必须显示中文', () => {
  // ⚠️ **这些用例锁的是「前端枚举与后端 Prisma 一致」**。
  // 之前前端写成了 `CANCELED` / `VOIDED`，而后端真实值是
  // `CANCELLED` / `VOID` —— 结果是这两个状态在页面上原样显示英文枚举。
  it('订阅状态 CANCELLED → 已取消', () => {
    expect(describeSubscriptionStatus(subscription({ status: 'CANCELLED' }))).toBe(
      '已取消',
    );
  });

  it('账单状态 VOID → 已作废', () => {
    expect(describeInvoiceStatus(invoice({ status: 'VOID' }))).toBe('已作废');
  });
});

describe('未知枚举：兜底文案不崩、不显示 undefined', () => {
  it('未知的订阅状态回落到「未知状态」，而不是 undefined 或裸枚举', () => {
    const result = describeSubscriptionStatus(
      subscription({ status: 'SOMETHING_NEW' as Subscription['status'] }),
    );

    expect(result).toBeTruthy();
    expect(result).not.toContain('undefined');
    expect(result).not.toBe('SOMETHING_NEW');
  });

  it('未知的账单状态回落到「未知状态」，而不是 undefined 或裸枚举', () => {
    const result = describeInvoiceStatus(
      invoice({ status: 'SOMETHING_NEW' as Invoice['status'] }),
    );

    expect(result).toBeTruthy();
    expect(result).not.toContain('undefined');
    expect(result).not.toBe('SOMETHING_NEW');
  });
});

describe('formatPriceLabel：金额展示（整数分 → 元）', () => {
  it('带 ¥ 与两位小数', () => {
    expect(formatPriceLabel(9900)).toBe('¥99.00');
  });

  it('0 元显示成 ¥0.00（不是「—」）', () => {
    // ⚠️ 免费套餐与「拿不到价格」是两回事：前者是真的 0 元，后者是缺数据。
    expect(formatPriceLabel(0)).toBe('¥0.00');
  });

  it('null 显示成「—」', () => {
    expect(formatPriceLabel(null)).toBe('—');
  });

  it('一位分也精确显示', () => {
    expect(formatPriceLabel(1)).toBe('¥0.01');
  });
});

describe('formatQuota：额度展示', () => {
  it('null 显示「不限」', () => {
    expect(formatQuota(null)).toBe('不限');
  });

  it('有上限显示数字', () => {
    expect(formatQuota(10)).toBe('10');
    expect(formatQuota(0)).toBe('0');
  });
});

describe('formatCommissionRate：抽佣率展示', () => {
  it('基点 → 百分比', () => {
    expect(formatCommissionRate(500)).toBe('5%');
    expect(formatCommissionRate(250)).toBe('2.5%');
    expect(formatCommissionRate(0)).toBe('0%');
  });

  it('不需要的百分位不显示尾巴', () => {
    expect(formatCommissionRate(1234)).toBe('12.34%');
  });
});
