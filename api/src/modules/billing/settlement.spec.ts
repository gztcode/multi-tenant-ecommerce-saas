import { BadRequestException } from '@nestjs/common';
import { CommissionEntryType } from '@prisma/client';

import {
  formatPeriodLabel,
  resolveMonthlyPeriod,
  summarizeEntries,
} from './settlement';

/**
 * 结算单的纯函数（阶段 5g）。
 *
 * ⚠️ **断言要具体**：断言每个分支的确切结果，不是「返回了一个布尔值」。
 * 周期解析与金额聚合是「结算单」与「收入报表」之间的**同一套口径**的载体 ——
 * 两者漂移了，账就对不上（对账 e2e 会红）。
 */
describe('自然月周期的解析', () => {
  it('2026-10 → [10-01, 11-01)（UTC）', () => {
    const period = resolveMonthlyPeriod('2026-10');
    expect(period.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(period.label).toBe('2026-10');
  });

  it('2026-01 → [01-01, 02-01)', () => {
    const period = resolveMonthlyPeriod('2026-01');
    expect(period.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('⚠️ 2026-12 → 终点跨年到 2027-01-01', () => {
    const period = resolveMonthlyPeriod('2026-12');
    expect(period.from.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('⚠️ 区间是左闭右开：2 月的终点就是 3 月的起点', () => {
    const feb = resolveMonthlyPeriod('2026-02');
    const mar = resolveMonthlyPeriod('2026-03');
    expect(feb.to.getTime()).toBe(mar.from.getTime());
  });

  it.each(['2026-13', '2026-00', '2026-1', '2026-10-01', 'abc', '', '2026-1a'])(
    '非法周期 %s → 抛 BadRequestException',
    (input) => {
      expect(() => resolveMonthlyPeriod(input)).toThrow(BadRequestException);
    },
  );

  it('⚠️ 闰年的 2 月终点是 3 月 1 日（2 月 29 日也在区间内）', () => {
    const period = resolveMonthlyPeriod('2028-02');
    expect(period.from.toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it.each(['0000-01', '0001-01', '0099-12', '0100-01', '9999-12'])(
    '⚠️ 年份 %s 超出范围 → 抛 BadRequestException（Date.UTC 会把 0–99 映射到 1900+年）',
    (input) => {
      expect(() => resolveMonthlyPeriod(input)).toThrow(BadRequestException);
    },
  );

  it.each(['2026-01', '2026-10', '2026-12', '2028-02', '2022-07'])(
    '⚠️ 往返：formatPeriodLabel(resolveMonthlyPeriod(%s).from) === %s',
    (p) => {
      expect(formatPeriodLabel(resolveMonthlyPeriod(p).from)).toBe(p);
    },
  );
});

describe('自然月周期的衔接', () => {
  it.each(
    Array.from(
      { length: 12 },
      (_, i) => `2026-${String(i + 1).padStart(2, '0')}`,
    ),
  )('%s 的区间非空（from < to）', (label) => {
    const period = resolveMonthlyPeriod(label);
    expect(period.to.getTime()).toBeGreaterThan(period.from.getTime());
  });

  it.each(
    Array.from(
      { length: 11 },
      (_, i) => `2026-${String(i + 1).padStart(2, '0')}`,
    ),
  )('%s 的终点就是下个月的起点（相邻两期不重不漏）', (label) => {
    const period = resolveMonthlyPeriod(label);
    const [year, month] = label.split('-').map(Number);
    const next = resolveMonthlyPeriod(
      `${year}-${String(month + 1).padStart(2, '0')}`,
    );
    expect(period.to.getTime()).toBe(next.from.getTime());
  });

  it('⚠️ 12 月的终点是次年 1 月 1 日（年份要进位）', () => {
    const period = resolveMonthlyPeriod('2026-12');
    expect(period.to.toISOString()).toBe(
      new Date(Date.UTC(2027, 0, 1)).toISOString(),
    );
  });
});

describe('结算单金额的聚合', () => {
  it('只有抽佣 → 毛额 = 抽佣，冲回 = 0，净额 = 毛额', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.COMMISSION, amount: 100 },
      { type: CommissionEntryType.COMMISSION, amount: 200 },
    ]);
    expect(amounts.grossAmount).toBe(300);
    expect(amounts.reversalAmount).toBe(0);
    expect(amounts.netAmount).toBe(300);
    expect(amounts.entryCount).toBe(2);
  });

  it('⚠️ 只有冲回 → 净额是负数（不是 0）', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.REVERSAL, amount: -150 },
    ]);
    expect(amounts.grossAmount).toBe(0);
    // ⚠️ **冲回保留负号**：流水的 amount 本身就是负数（5e 的 N2 护栏）
    expect(amounts.reversalAmount).toBe(-150);
    expect(amounts.netAmount).toBe(-150);
    expect(amounts.entryCount).toBe(1);
  });

  it('抽佣 + 冲回 → 净额 = 毛额 + 冲回（冲回是负数，不取负）', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.COMMISSION, amount: 100 },
      { type: CommissionEntryType.REVERSAL, amount: -30 },
    ]);
    expect(amounts.grossAmount).toBe(100);
    expect(amounts.reversalAmount).toBe(-30);
    expect(amounts.netAmount).toBe(70);
    expect(amounts.entryCount).toBe(2);
  });

  it('⚠️ 一抽佣一冲回金额相等 → 净额为 0（不是缺数据）', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.COMMISSION, amount: 100 },
      { type: CommissionEntryType.REVERSAL, amount: -100 },
    ]);
    expect(amounts.netAmount).toBe(0);
    expect(amounts.entryCount).toBe(2);
  });

  it('空 → 三个数都是 0，笔数 0', () => {
    const amounts = summarizeEntries([]);
    expect(amounts.grossAmount).toBe(0);
    expect(amounts.reversalAmount).toBe(0);
    expect(amounts.netAmount).toBe(0);
    expect(amounts.entryCount).toBe(0);
  });

  it('⚠️ 抽佣金额为负 → 抛错（符号写反时立刻炸）', () => {
    expect(() =>
      summarizeEntries([
        { type: CommissionEntryType.COMMISSION, amount: -100 },
      ]),
    ).toThrow();
  });

  it('⚠️ 冲回金额为正 → 抛错（符号写反时立刻炸）', () => {
    expect(() =>
      summarizeEntries([{ type: CommissionEntryType.REVERSAL, amount: 100 }]),
    ).toThrow();
  });
});

describe('周期标识的回写', () => {
  it('从周期起点反推出 YYYY-MM', () => {
    expect(formatPeriodLabel(new Date('2026-10-01T00:00:00.000Z'))).toBe(
      '2026-10',
    );
  });

  it('⚠️ 单月要补零（1 月不是「2026-1」）', () => {
    expect(formatPeriodLabel(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01',
    );
  });

  it('12 月不补零到 13', () => {
    expect(formatPeriodLabel(new Date('2026-12-01T00:00:00.000Z'))).toBe(
      '2026-12',
    );
  });

  it('⚠️ 非法 Date → 抛错（而不是返回 NaN-NaN）', () => {
    expect(() => formatPeriodLabel(new Date('not-a-date'))).toThrow();
  });
});
