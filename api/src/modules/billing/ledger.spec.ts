import { PayoutStatus, SettlementStatus } from '@prisma/client';

import {
  ApplicableInput,
  deriveApplicableKind,
  groupReceiptsByPeriod,
  splitPayoutAmounts,
  toReportAmounts,
} from './ledger';

/**
 * 账目口径的纯函数（阶段 5i）。
 *
 * ⚠️ **断言要具体**：断言每个分支的确切结果与确切文案，
 * 不是「返回了一个布尔值」。
 * 这些文案后续会被失败注入与 e2e 直接引用，
 * 改字等于改契约。
 */
describe('报表口径的金额换算', () => {
  it('只有抽佣 → 抽佣收入为正，冲回为 0', () => {
    const amounts = toReportAmounts(1000, 0);
    expect(amounts.commissionRevenue).toBe(1000);
    expect(amounts.reversal).toBe(0);
  });

  it('⚠️ 冲回取负 → 报表口径的冲回是正数', () => {
    // ⚠️ **流水口径的冲回是负数**，报表口径要求正数（净收入要减它）
    const amounts = toReportAmounts(1000, -300);
    expect(amounts.commissionRevenue).toBe(1000);
    expect(amounts.reversal).toBe(300);
  });

  it('净收入 = 抽佣 − 冲回（用换算后的数直接减）', () => {
    const amounts = toReportAmounts(1000, -300);
    expect(amounts.commissionRevenue - amounts.reversal).toBe(700);
  });

  it('空账期 → 两个数都是 0', () => {
    const amounts = toReportAmounts(0, 0);
    expect(amounts.commissionRevenue).toBe(0);
    expect(amounts.reversal).toBe(0);
  });

  it('⚠️ 抽佣合计为负 → 抛错（文案含「符号」，且带实际的数）', () => {
    expect(() => toReportAmounts(-100, 0)).toThrow(/符号/);
    expect(() => toReportAmounts(-100, 0)).toThrow(/-100/);
  });

  it('⚠️ 冲回合计为正 → 抛错（文案含「符号」，且带实际的数）', () => {
    expect(() => toReportAmounts(100, 300)).toThrow(/符号/);
    expect(() => toReportAmounts(100, 300)).toThrow(/300/);
  });
});

describe('货款流水按自然月分组', () => {
  it('空数组 → 空 Map', () => {
    expect(groupReceiptsByPeriod([]).size).toBe(0);
  });

  it('同一期 → 金额求和、笔数累加', () => {
    const grouped = groupReceiptsByPeriod([
      { amount: 1000, occurredAt: new Date('2026-10-01T00:00:00.000Z') },
      { amount: 500, occurredAt: new Date('2026-10-20T00:00:00.000Z') },
    ]);
    expect(grouped.get('2026-10')).toEqual({ amount: 1500, count: 2 });
  });

  it('不同期 → 分到不同的桶', () => {
    const grouped = groupReceiptsByPeriod([
      { amount: 1000, occurredAt: new Date('2026-10-01T00:00:00.000Z') },
      { amount: 700, occurredAt: new Date('2026-11-01T00:00:00.000Z') },
    ]);
    expect(grouped.get('2026-10')).toEqual({ amount: 1000, count: 1 });
    expect(grouped.get('2026-11')).toEqual({ amount: 700, count: 1 });
    expect(grouped.size).toBe(2);
  });

  it('⚠️ 货款冲回是负数 → 同期的净额可以是负数（不截断成 0）', () => {
    const grouped = groupReceiptsByPeriod([
      { amount: 1000, occurredAt: new Date('2026-10-01T00:00:00.000Z') },
      { amount: -1500, occurredAt: new Date('2026-10-15T00:00:00.000Z') },
    ]);
    expect(grouped.get('2026-10')).toEqual({ amount: -500, count: 2 });
  });

  it('⚠️ 分组按 UTC 自然月（月末最后一天的 UTC 时间仍属本月）', () => {
    const grouped = groupReceiptsByPeriod([
      { amount: 100, occurredAt: new Date('2026-10-31T23:59:59.999Z') },
    ]);
    expect(grouped.get('2026-10')).toEqual({ amount: 100, count: 1 });
    expect(grouped.get('2026-11')).toBeUndefined();
  });

  it('⚠️ 次月 1 日 00:00:00Z 归下一期（左闭右开）', () => {
    const grouped = groupReceiptsByPeriod([
      { amount: 100, occurredAt: new Date('2026-11-01T00:00:00.000Z') },
    ]);
    expect(grouped.get('2026-11')).toEqual({ amount: 100, count: 1 });
    expect(grouped.get('2026-10')).toBeUndefined();
  });
});

describe('出款金额的分桶', () => {
  it('空数组 → 两个都是 0', () => {
    expect(splitPayoutAmounts([])).toEqual({ paid: 0, inFlight: 0 });
  });

  it('PAID → 累加到已出款', () => {
    const split = splitPayoutAmounts([
      {
        status: PayoutStatus.PAID,
        netAmount: 1000,
        kind: 'NORMAL',
      },
    ]);
    expect(split).toEqual({ paid: 1000, inFlight: 0 });
  });

  it.each([
    PayoutStatus.REQUESTED,
    PayoutStatus.APPROVED,
    PayoutStatus.PROCESSING,
  ])('%s → 累加到在途', (status) => {
    const split = splitPayoutAmounts([
      { status, netAmount: 800, kind: 'NORMAL' },
    ]);
    expect(split).toEqual({ paid: 0, inFlight: 800 });
  });

  it.each([PayoutStatus.REJECTED, PayoutStatus.CANCELLED, PayoutStatus.FAILED])(
    '%s → 两个桶都不算（都没打钱）',
    (status) => {
      const split = splitPayoutAmounts([
        { status, netAmount: 800, kind: 'NORMAL' },
      ]);
      expect(split).toEqual({ paid: 0, inFlight: 0 });
    },
  );

  it('⚠️ FAILED 的钱不消失（商家可重新申请 → 仍属于待出款）', () => {
    // ⚠️ **不是「已出款」**：没打钱；也不是「凭空消失」：
    //    失败会释放明细占用，商家能重新申请，那笔钱仍在途。
    const split = splitPayoutAmounts([
      { status: PayoutStatus.FAILED, netAmount: 800, kind: 'NORMAL' },
      { status: PayoutStatus.REQUESTED, netAmount: 800, kind: 'NORMAL' },
    ]);
    expect(split.paid).toBe(0);
    expect(split.inFlight).toBe(800);
  });

  it('多张单混合 → 分别累加', () => {
    const split = splitPayoutAmounts([
      { status: PayoutStatus.PAID, netAmount: 1000, kind: 'NORMAL' },
      { status: PayoutStatus.APPROVED, netAmount: 300, kind: 'NORMAL' },
      { status: PayoutStatus.PROCESSING, netAmount: 200, kind: 'SUPPLEMENT' },
      { status: PayoutStatus.REJECTED, netAmount: 999, kind: 'NORMAL' },
    ]);
    expect(split).toEqual({ paid: 1000, inFlight: 500 });
  });
});

describe('能不能申请出款的判定', () => {
  /** 一个「一切正常、可以申请正常单」的基线 */
  const base: ApplicableInput = {
    periodEnded: true,
    receiptAmount: 10000,
    receiptCount: 3,
    commissionAmount: 1000,
    statementStatus: SettlementStatus.CONFIRMED,
    hasActiveNormal: false,
    hasActiveSupplement: false,
    normalPaid: false,
    supplementAmount: null,
  };

  it('基线 → 走正常单', () => {
    expect(deriveApplicableKind(base)).toEqual({
      kind: 'NORMAL',
      reason: null,
    });
  });

  it('⚠️ 周期未结束 → 不可申请', () => {
    const result = deriveApplicableKind({ ...base, periodEnded: false });
    expect(result).toEqual({ kind: null, reason: '该周期尚未结束' });
  });

  it('⚠️ 货款笔数为 0 → 不可申请', () => {
    const result = deriveApplicableKind({
      ...base,
      receiptCount: 0,
      receiptAmount: 0,
    });
    expect(result).toEqual({ kind: null, reason: '该期没有货款入账' });
  });

  it('⚠️ 货款净额非正 → 不可申请', () => {
    const result = deriveApplicableKind({ ...base, receiptAmount: 0 });
    expect(result).toEqual({ kind: null, reason: '该期没有货款入账' });
  });

  it('⚠️ 没有结算单 → 不可申请', () => {
    const result = deriveApplicableKind({
      ...base,
      commissionAmount: null,
      statementStatus: null,
    });
    expect(result).toEqual({ kind: null, reason: '该期的结算单尚未生成' });
  });

  it('⚠️ 结算单是 DRAFT → 不可申请', () => {
    const result = deriveApplicableKind({
      ...base,
      statementStatus: SettlementStatus.DRAFT,
    });
    expect(result).toEqual({ kind: null, reason: '该期的结算单尚未确认' });
  });

  it('⚠️ 正常单已 PAID 且有补差金额 → 走补差单', () => {
    const result = deriveApplicableKind({
      ...base,
      normalPaid: true,
      hasActiveNormal: true,
      statementStatus: SettlementStatus.PAID,
      supplementAmount: 2500,
    });
    expect(result).toEqual({ kind: 'SUPPLEMENT', reason: null });
  });

  it('⚠️ 正常单已 PAID 但有活跃补差单 → 不可申请', () => {
    const result = deriveApplicableKind({
      ...base,
      normalPaid: true,
      hasActiveNormal: true,
      hasActiveSupplement: true,
      statementStatus: SettlementStatus.PAID,
      supplementAmount: 2500,
    });
    expect(result).toEqual({
      kind: null,
      reason: '该期已有补差出款单在处理中',
    });
  });

  it('⚠️ 正常单已 PAID 且没有待补的钱 → 已结清', () => {
    const result = deriveApplicableKind({
      ...base,
      normalPaid: true,
      hasActiveNormal: true,
      statementStatus: SettlementStatus.PAID,
      supplementAmount: 0,
    });
    expect(result).toEqual({ kind: null, reason: '该期货款已全部结清' });
  });

  it('⚠️ 正常单已 PAID 且补差金额为 null → 已结清', () => {
    const result = deriveApplicableKind({
      ...base,
      normalPaid: true,
      hasActiveNormal: true,
      statementStatus: SettlementStatus.PAID,
      supplementAmount: null,
    });
    expect(result).toEqual({ kind: null, reason: '该期货款已全部结清' });
  });

  it('⚠️ 有活跃正常单（未 PAID）→ 不可申请', () => {
    const result = deriveApplicableKind({
      ...base,
      hasActiveNormal: true,
    });
    expect(result).toEqual({ kind: null, reason: '该期已有出款申请在处理中' });
  });

  it('⚠️ 结算单已 PAID 且无正常单 → 已结算完成', () => {
    const result = deriveApplicableKind({
      ...base,
      statementStatus: SettlementStatus.PAID,
    });
    expect(result).toEqual({ kind: null, reason: '该期已结算完成' });
  });

  it('⚠️ 判定顺序：补差路径优先于正常路径', () => {
    // ⚠️ **正常单已 PAID 时它也是活跃单**（活跃含 `PAID`）——
    //    若先判正常路径，就会永远返回「已有出款申请在处理中」，
    //    补差入口就废了。
    const result = deriveApplicableKind({
      ...base,
      normalPaid: true,
      hasActiveNormal: true,
      statementStatus: SettlementStatus.PAID,
      supplementAmount: 2500,
    });
    expect(result.kind).toBe('SUPPLEMENT');
  });

  it('⚠️ 判定顺序：周期未结束优先于一切', () => {
    const result = deriveApplicableKind({
      ...base,
      periodEnded: false,
      receiptCount: 0,
      commissionAmount: null,
      statementStatus: null,
    });
    expect(result.reason).toBe('该周期尚未结束');
  });

  it('⚠️ 判定顺序：没有货款优先于没有结算单', () => {
    const result = deriveApplicableKind({
      ...base,
      receiptCount: 0,
      receiptAmount: 0,
      commissionAmount: null,
      statementStatus: null,
    });
    expect(result.reason).toBe('该期没有货款入账');
  });

  it('⚠️ 判定顺序：没有结算单优先于结算单未确认', () => {
    const result = deriveApplicableKind({
      ...base,
      commissionAmount: null,
      statementStatus: SettlementStatus.DRAFT,
    });
    expect(result.reason).toBe('该期的结算单尚未生成');
  });
});
