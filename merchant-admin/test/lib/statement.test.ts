/**
 * 商家侧对账单的展示纯函数。
 *
 * ⚠️ **这些函数必须留在 `src/lib/statement.ts`（而不是 `.tsx`）**：
 *    vitest 只收 test 目录下的 .test.ts，塞在组件里就没法单独测。
 */
import { describe, expect, it } from 'vitest';

import {
  describeCommissionEntryType,
  describeMissingEntries,
  describeReceiptPayoutStatus,
  describeReceiptType,
  describeStatementStatus,
  formatCents,
  formatRateBps,
} from '@/lib/statement';

describe('describeStatementStatus', () => {
  it('已知状态翻成中文', () => {
    expect(describeStatementStatus('DRAFT')).toBe('待确认');
    expect(describeStatementStatus('CONFIRMED')).toBe('已确认');
  });

  it('⚠️ PAID → 「已结算」（不是「已出款」）', () => {
    // ⚠️ **这是最容易搞混的一处**：结算单的 `PAID` 说的是
    //    「这一期的佣金定了」，出款单的 `PAID` 说的是「钱打给你了」。
    //    两个都译成「已出款」→ 商家看到「已出款」却没收到钱就会来投诉。
    expect(describeStatementStatus('PAID')).toBe('已结算');
    expect(describeStatementStatus('PAID')).not.toBe('已出款');
  });

  it('⚠️ 未知状态 → 未知状态（不显示裸枚举）', () => {
    expect(describeStatementStatus('WHATEVER')).toBe('未知状态');
    expect(describeStatementStatus('WHATEVER')).not.toContain('WHATEVER');
  });

  it('⚠️ null → 待确认（没有结算单就是还没定下来）', () => {
    expect(describeStatementStatus(null)).toBe('待确认');
    expect(describeStatementStatus(undefined)).toBe('待确认');
  });
});

describe('formatRateBps', () => {
  it('基点 → 百分数', () => {
    expect(formatRateBps(500)).toBe('5%');
    expect(formatRateBps(1000)).toBe('10%');
    expect(formatRateBps(10000)).toBe('100%');
  });

  it('⚠️ 保留一位小数（750 → 7.5%，不是 8%）', () => {
    // ⚠️ **四舍五入到整数会把 7.5% 显示成 8%** ——
    //    商家一看就知道平台乱扣佣金。
    expect(formatRateBps(750)).toBe('7.5%');
    expect(formatRateBps(750)).not.toBe('8%');
  });

  it('整数基点时不带多余的小数尾巴', () => {
    expect(formatRateBps(500)).not.toBe('5.0%');
  });
});

describe('formatCents', () => {
  it('整数分 → 「¥12.34」', () => {
    expect(formatCents(1234)).toBe('¥12.34');
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(99999)).toBe('¥999.99');
  });

  it('⚠️ 负数原样显示（符号是数据的一部分，不要自己加负号）', () => {
    expect(formatCents(-500)).toBe('¥-5.00');
  });
});

describe('describeCommissionEntryType', () => {
  it('已知类型翻成中文', () => {
    expect(describeCommissionEntryType('COMMISSION')).toBe('抽佣');
    expect(describeCommissionEntryType('REVERSAL')).toBe('抽佣冲回');
  });

  it('⚠️ 未知类型回落到「未知类型」，不显示裸枚举', () => {
    expect(describeCommissionEntryType('FOO')).toBe('未知类型');
    expect(describeCommissionEntryType('FOO')).not.toBe('FOO');
  });
});

describe('describeReceiptType', () => {
  it('已知类型翻成中文', () => {
    expect(describeReceiptType('SALE')).toBe('货款入账');
    expect(describeReceiptType('SALE_REVERSAL')).toBe('货款冲回');
  });

  it('⚠️ 未知类型回落到「未知类型」，不显示裸枚举', () => {
    expect(describeReceiptType('FOO')).toBe('未知类型');
    expect(describeReceiptType('FOO')).not.toBe('FOO');
  });
});

describe('describeReceiptPayoutStatus', () => {
  it('null → 未出款', () => {
    expect(describeReceiptPayoutStatus(null)).toBe('未出款');
    expect(describeReceiptPayoutStatus(undefined)).toBe('未出款');
  });

  it('⚠️ IN_FLIGHT → 出款中（不是「已出款」）', () => {
    // ⚠️ **在途的单钱还没打** —— 显示「已出款」商家就会来投诉。
    expect(describeReceiptPayoutStatus('IN_FLIGHT')).toBe('出款中');
    expect(describeReceiptPayoutStatus('IN_FLIGHT')).not.toBe('已出款');
  });

  it('PAID → 已出款', () => {
    expect(describeReceiptPayoutStatus('PAID')).toBe('已出款');
  });

  it('⚠️ 未知状态 → 未知状态（不显示裸枚举）', () => {
    expect(describeReceiptPayoutStatus('WHATEVER')).toBe('未知状态');
    expect(describeReceiptPayoutStatus('WHATEVER')).not.toContain('WHATEVER');
  });
});

describe('describeMissingEntries', () => {
  it('⚠️ 缺笔 → 给出提示文案', () => {
    expect(describeMissingEntries(2)).toContain('缺 2 笔');
  });

  it('⚠️ 不缺笔 → 不给提示', () => {
    expect(describeMissingEntries(0)).toBeNull();
  });
});
