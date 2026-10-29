/**
 * 出款相关的展示纯函数。
 *
 * ⚠️ **这些函数必须留在 `src/lib/payout.ts`（而不是 `.tsx`）**：
 * vitest 只收 test 目录下的 .test.ts，塞在组件里就没法单独测。
 *
 * ⚠️ **两个前端的 `lib/payout.ts` 是各自独立的文件**（本项目既有模式），
 *    所以两份测试的内容必须一致 —— 改了一边要改另一边。
 */
import { describe, expect, it } from 'vitest';

import {
  describePayoutEntryType,
  describePayoutStatus,
  describePayoutTimeline,
  formatCents,
} from '@/lib/payout';

describe('describePayoutStatus', () => {
  it('已知状态翻成中文', () => {
    expect(describePayoutStatus('REQUESTED')).toBe('待审批');
    expect(describePayoutStatus('APPROVED')).toBe('已审批');
    expect(describePayoutStatus('REJECTED')).toBe('已拒绝');
    expect(describePayoutStatus('CANCELLED')).toBe('已撤回');
    expect(describePayoutStatus('PAID')).toBe('已出款');
    expect(describePayoutStatus('FAILED')).toBe('出款失败');
  });

  it('⚠️ 未知状态回落到「未知状态」，不显示裸枚举', () => {
    expect(describePayoutStatus('WEIRD')).toBe('未知状态');
  });
});

describe('describePayoutEntryType', () => {
  it('已知类型翻成中文', () => {
    expect(describePayoutEntryType('SALE')).toBe('货款入账');
    expect(describePayoutEntryType('SALE_REVERSAL')).toBe('货款冲回');
  });

  it('⚠️ 未知类型回落到「未知类型」，不显示裸枚举', () => {
    // ⚠️ **规格要求「不显示裸枚举」**：后端将来加第三种 `ReceiptType`
    //    而前端没跟上时，界面上会出现一个商家看不懂的 `FOO`。
    expect(describePayoutEntryType('FOO')).toBe('未知类型');
    expect(describePayoutEntryType('FOO')).not.toBe('FOO');
  });
});

describe('describePayoutTimeline', () => {
  const base = {
    requestedAt: '2026-02-01T00:00:00.000Z',
    approvedAt: '2026-02-05T00:00:00.000Z',
    cancelledAt: '2026-02-06T00:00:00.000Z',
  };

  it('待审批 → 只有申请时间', () => {
    const text = describePayoutTimeline({ ...base, status: 'REQUESTED' });

    expect(text).toContain('申请时间');
    expect(text).not.toContain('审批时间');
    expect(text).not.toContain('拒绝时间');
    expect(text).not.toContain('撤回时间');
  });

  it('已审批 → 有审批时间', () => {
    const text = describePayoutTimeline({ ...base, status: 'APPROVED' });

    expect(text).toContain('审批时间');
  });

  it('⚠️ 已拒绝 → 是「拒绝时间」，且不是「审批时间」', () => {
    // ⚠️ **后端 `reject()` 也填 `approvedAt` 与 `approvedBy`**
    //    （拒绝同样是一次审批动作）—— 按字段非空显示就会出现
    //    「已拒绝 · 已审批」这种自相矛盾的说法。
    const text = describePayoutTimeline({ ...base, status: 'REJECTED' });

    expect(text).toContain('拒绝时间');
    expect(text).not.toContain('审批时间');
  });

  it('已撤回 → 有撤回时间', () => {
    const text = describePayoutTimeline({ ...base, status: 'CANCELLED' });

    expect(text).toContain('撤回时间');
  });

  it('⚠️ 已出款 / 出款失败不追加审批类时间', () => {
    for (const status of ['PAID', 'FAILED']) {
      const text = describePayoutTimeline({ ...base, status });
      expect(text).toContain('申请时间');
      expect(text).not.toContain('审批时间');
      expect(text).not.toContain('拒绝时间');
      expect(text).not.toContain('撤回时间');
    }
  });

  it('时间用 `formatDateTime` 的格式（不是裸 ISO 串）', () => {
    const text = describePayoutTimeline({ ...base, status: 'REQUESTED' });

    // ⚠️ **页面上的时间要能直接读**：`2026-02-01T00:00:00.000Z`
    //    这种裸 ISO 串是给机器看的。
    expect(text).not.toContain('2026-02-01T00:00:00.000Z');
  });
});

describe('formatCents', () => {
  it('整数分 → 「¥12.34」', () => {
    expect(formatCents(1234)).toBe('¥12.34');
  });

  it('⚠️ 输出格式与之前内联的 `(x / 100).toFixed(2)` 完全一致', () => {
    // ⚠️ **格式不能变**：现有测试断言的就是 `¥999.99` 这种。
    expect(formatCents(99999)).toBe('¥999.99');
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(5)).toBe('¥0.05');
    expect(formatCents(-200)).toBe('¥-2.00');
  });
});
