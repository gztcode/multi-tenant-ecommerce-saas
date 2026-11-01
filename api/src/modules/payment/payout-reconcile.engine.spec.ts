import { PayoutStatus, ReconciliationDiffType } from '@prisma/client';
import { LocalPayoutForReconcile, reconcile } from './payout-reconcile.engine';
import type { ChannelPayoutRecord } from '../../common/payment/payout-provider.interface';

/**
 * 比对引擎的单元测试。
 *
 * ⚠️ **这是「A–F 六类差异」的判据表** —— 每一条判定都必须有一个用例。
 *    判定顺序错一档，对账的结论就全错。
 */

const FROM = new Date('2026-03-01T00:00:00.000Z');
const TO = new Date('2026-03-08T00:00:00.000Z');
const EXPANDED = {
  from: new Date(FROM.getTime() - 15 * 60 * 60 * 1000),
  to: new Date(TO.getTime() + 15 * 60 * 60 * 1000),
};

function local(
  over: Partial<LocalPayoutForReconcile> = {},
): LocalPayoutForReconcile {
  return {
    id: 'payout-1',
    payoutNo: 'PAY1',
    payoutTxnId: null,
    status: PayoutStatus.PROCESSING,
    netAmount: 8500,
    receiptAmount: 8500,
    commissionAmount: 0,
    entryCount: 1,
    paidAt: null,
    processingAt: new Date('2026-03-02T00:00:00.000Z'),
    failedAt: null,
    ...over,
  };
}

function channel(over: Partial<ChannelPayoutRecord> = {}): ChannelPayoutRecord {
  return {
    referenceNo: 'PAY1',
    providerTxnId: 'txn-1',
    amount: 8500,
    status: 'SUCCESS',
    paidAt: new Date('2026-03-02T00:10:00.000Z'),
    ...over,
  };
}

describe('比对引擎', () => {
  it('A 类：渠道 SUCCESS + 本地 PROCESSING', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [channel()],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(
      ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
    );
    expect(result.diffs[0].payoutId).toBe('payout-1');
    expect(result.matchedCount).toBe(0);
  });

  it('B 类：渠道 SUCCESS + 本地 FAILED', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.FAILED,
          processingAt: null,
          failedAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel()],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(
      ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
    );
  });

  it('C 类：渠道 SUCCESS + 本地 PAID + 金额不同', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel({ amount: 9999 })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.AMOUNT_MISMATCH);
    expect(result.diffs[0].channelAmount).toBe(9999);
    expect(result.diffs[0].localAmount).toBe(8500);
  });

  it('C 类：渠道 SUCCESS + 本地 PAID + 渠道金额更小（渠道少打了钱）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel({ amount: 8000 })],
    });

    // ⚠️ **必须覆盖「渠道金额更小」这个方向** —— 上面那条用例给的是「渠道更大」（9999 vs 8500），
    //    只用它的话，把判定从 `!==` 改成 `>`（`9999 > 8500` 仍成立）就不会变红
    //    → 「渠道少打了钱」这个真正要咬住的方向（少打款＝少付商家＝必须被发现）就没有保护。
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.AMOUNT_MISMATCH);
    expect(result.diffs[0].channelAmount).toBe(8000);
    expect(result.diffs[0].localAmount).toBe(8500);
  });

  it('D 类：渠道有、本地没有', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [],
      channelRecords: [channel({ referenceNo: 'PAY-UNKNOWN' })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.CHANNEL_ONLY);
    expect(result.diffs[0].payoutId).toBeNull();
  });

  it('E 类：本地已付 + 渠道查无此笔', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(
      ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
    );
    expect(result.diffs[0].payoutId).toBe('payout-1');
  });

  it('F 类：渠道 FAILED + 本地 PAID（渠道明确拒付）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel({ status: 'FAILED' })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.STATUS_MISMATCH);
  });

  it('⚠️ 匹配一致（渠道 SUCCESS + 本地 PAID + 金额一致）→ 不落差异', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel()],
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(1);
  });

  it('⚠️ 双方都说失败 → 匹配，不是差异', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.FAILED,
          processingAt: null,
          failedAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel({ status: 'FAILED' })],
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(1);
  });

  it('⚠️ 渠道非终态 + 本地 PAID → 不算差异（g 档）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel({ status: 'PROCESSING' })],
    });

    expect(result.diffs).toHaveLength(0);
    // ⚠️ **必须断言 `matchedCount`** —— 只断言 `diffs` 长度的话，
    //    把渠道判定从 `=== 'SUCCESS'` 改成 `!== 'FAILED'` 就会让非终态记录
    //    被算成「已匹配」，`matchedCount` 从 0 变成 1 而用例照样绿
    //    → 对账任务列表上的匹配口径会虚增，运营误以为渠道侧已经对上了。
    expect(result.matchedCount).toBe(0);
  });

  it('⚠️ 一单多流水：先失败后成功 → 取 SUCCESS 那条（权威记录）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [
        channel({
          providerTxnId: 'txn-fail',
          status: 'FAILED',
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
        channel({
          providerTxnId: 'txn-ok',
          status: 'SUCCESS',
          paidAt: new Date('2026-03-02T00:10:00.000Z'),
        }),
      ],
    });

    // ⚠️ **只有一条差异** —— 两条流水归到同一组，取权威记录
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(
      ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
    );
    expect(result.diffs[0].channelTxnId).toBe('txn-ok');
  });

  it('⚠️ 一单多流水：SUCCESS 那条 paidAt 更早 → 仍必须取 SUCCESS（不能被更晚的 FAILED 盖掉）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [
        // 第一次尝试：渠道说成功，但**更早**
        channel({
          providerTxnId: 'txn-ok',
          status: 'SUCCESS',
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
        // 第二次尝试：更晚，但失败了
        channel({
          providerTxnId: 'txn-fail',
          status: 'FAILED',
          paidAt: new Date('2026-03-02T00:20:00.000Z'),
        }),
      ],
    });

    // ⚠️ **必须覆盖「SUCCESS 那条 paidAt 更早」这个方向** ——
    //    上面那条用例里 SUCCESS 恰好是最晚的，「优先 SUCCESS」与「取 paidAt 最晚」结果相同
    //    → 去掉「优先 SUCCESS」也不会变红。
    //    而去掉之后，权威记录会变成更晚的 FAILED → **A 类差异（渠道已打款、本地卡 PROCESSING）
    //    整条消失**（diffs 从 1 条变成 0 条），等于一条资金安全告警凭空消失。
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(
      ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
    );
    expect(result.diffs[0].channelTxnId).toBe('txn-ok');
    expect(result.diffs[0].channelStatus).toBe('SUCCESS');
  });

  it('⚠️ 多条 SUCCESS → 取 paidAt 最晚的那条', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [
        channel({
          providerTxnId: 'txn-old',
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
        channel({
          providerTxnId: 'txn-new',
          paidAt: new Date('2026-03-02T00:30:00.000Z'),
        }),
      ],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].channelTxnId).toBe('txn-new');
  });

  it('⚠️ D 类只认「扩大窗口内」的渠道记录', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [],
      channelRecords: [
        channel({
          referenceNo: 'PAY-OUT-OF-WINDOW',
          // ⚠️ **落在扩大窗口之外** → 忽略（时钟偏移导致的多余记录）
          paidAt: new Date(EXPANDED.to.getTime() + 60_000),
        }),
      ],
    });

    expect(result.diffs).toHaveLength(0);
  });

  it('⚠️ 按 providerTxnId 也能匹配上本地单（渠道账单不回显业务单号）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel({ referenceNo: undefined })],
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(1);
  });

  it('⚠️ 本地不是终态（REQUESTED）→ 不算差异', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.REQUESTED,
          processingAt: null,
          paidAt: null,
          failedAt: null,
        }),
      ],
      channelRecords: [],
    });

    expect(result.diffs).toHaveLength(0);
  });
});

/**
 * ⚠️ **排序确定性** —— 这组用例锁住「结论与输入顺序无关」这条不变量。
 *
 * 背景：`pickAuthoritative` 的兜底规则「组内没有 SUCCESS → 取 `paidAt` 最晚的；
 * 全都没有 `paidAt` 的取数组最后一条」**依赖组内已按 `paidAt` 升序排好**。
 * 渠道侧不承诺输出顺序（CSV 账单甚至可以不配 `paidAt` 列 → 全部记录
 * `paidAt === undefined` → 排序键完全为空 → 权威记录 100% 由数组顺序决定）。
 */
describe('比对引擎：排序确定性', () => {
  it('⚠️ 结论与输入顺序无关（两条都无 paidAt + 金额不同）', () => {
    // 两条渠道记录共享 `referenceNo`、**都没有 `paidAt`**、金额不同
    const txnA = channel({
      providerTxnId: 'txn-a',
      amount: 8500,
      paidAt: undefined,
    });
    const txnB = channel({
      providerTxnId: 'txn-b',
      amount: 9999,
      paidAt: undefined,
    });

    const locals = [
      local({
        status: PayoutStatus.PAID,
        processingAt: null,
        paidAt: new Date('2026-03-02T00:00:00.000Z'),
        payoutTxnId: 'txn-local',
      }),
    ];

    const forward = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: locals,
      channelRecords: [txnA, txnB],
    });

    const reversed = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: locals,
      channelRecords: [txnB, txnA],
    });

    // ⚠️ **断言两次的 `diffs` 完全相同（类型、数量、金额都要断言）** ——
    //    修复前：正序取 txn-b(9999) → C 类金额不符；倒序取 txn-a(8500) → 匹配一致
    //    → 一条金额差 1500 元的 CRITICAL 告警会随账单行序凭空消失。
    expect(reversed.diffs).toEqual(forward.diffs);
    expect(forward.diffs).toHaveLength(1);
    expect(forward.diffs[0].type).toBe(ReconciliationDiffType.AMOUNT_MISMATCH);
    expect(forward.diffs[0].severity).toBe('CRITICAL');
    expect(forward.diffs[0].channelAmount).toBe(9999);
    expect(forward.diffs[0].localAmount).toBe(8500);
    expect(forward.matchedCount).toBe(0);
    expect(reversed.matchedCount).toBe(0);
  });

  it('⚠️ tie-break 确定性（两条 paidAt 完全相同 + 状态金额不同）→ 两次选出同一条', () => {
    const samePaidAt = new Date('2026-03-02T00:00:00.000Z');
    const txnA = channel({
      providerTxnId: 'txn-a',
      amount: 8500,
      status: 'SUCCESS',
      paidAt: samePaidAt,
    });
    const txnB = channel({
      providerTxnId: 'txn-b',
      amount: 9999,
      status: 'SUCCESS',
      paidAt: samePaidAt,
    });

    const locals = [
      local({
        status: PayoutStatus.PAID,
        processingAt: null,
        paidAt: new Date('2026-03-02T00:00:00.000Z'),
        payoutTxnId: 'txn-local',
      }),
    ];

    const forward = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: locals,
      channelRecords: [txnA, txnB],
    });

    const reversed = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: locals,
      channelRecords: [txnB, txnA],
    });

    // ⚠️ **`paidAt` 完全相同时比较结果为 0 → 相对顺序取决于输入顺序** ——
    //    没有 tie-break 的话，权威记录仍会漂（这里取字典序更大的 `txn-b`）。
    expect(reversed.diffs).toEqual(forward.diffs);
    expect(forward.diffs).toHaveLength(1);
    expect(forward.diffs[0].type).toBe(ReconciliationDiffType.AMOUNT_MISMATCH);
    // 两次都必须是同一条权威记录（`txn-b`）
    expect(forward.diffs[0].channelTxnId).toBe('txn-b');
    expect(reversed.diffs[0].channelTxnId).toBe('txn-b');
    expect(forward.diffs[0].channelAmount).toBe(9999);
  });

  it('⚠️ F 类差异携带的金额不随输入顺序翻转', () => {
    const txnA = channel({
      providerTxnId: 'txn-a',
      amount: 8500,
      status: 'FAILED',
      paidAt: undefined,
    });
    const txnB = channel({
      providerTxnId: 'txn-b',
      amount: 9999,
      status: 'FAILED',
      paidAt: undefined,
    });

    const locals = [
      local({
        status: PayoutStatus.PAID,
        processingAt: null,
        paidAt: new Date('2026-03-02T00:00:00.000Z'),
        payoutTxnId: 'txn-local',
      }),
    ];

    const forward = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: locals,
      channelRecords: [txnA, txnB],
    });

    const reversed = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: locals,
      channelRecords: [txnB, txnA],
    });

    expect(reversed.diffs).toEqual(forward.diffs);
    expect(forward.diffs).toHaveLength(1);
    expect(forward.diffs[0].type).toBe(ReconciliationDiffType.STATUS_MISMATCH);
    expect(forward.diffs[0].channelAmount).toBe(9999);
  });
});

/**
 * ⚠️ **分支覆盖补齐** —— 下面这几条分支在实现里写了注释，却**从来没有用例**。
 */
describe('比对引擎：分支覆盖补齐', () => {
  it.each([
    PayoutStatus.APPROVED,
    PayoutStatus.CANCELLED,
    PayoutStatus.REJECTED,
  ])('⚠️ 本地状态 %s + 渠道 SUCCESS → 不算差异（不产生假差异）', (status) => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status,
          processingAt: null,
          paidAt: null,
          failedAt: null,
        }),
      ],
      channelRecords: [channel()],
    });

    // ⚠️ **断言 `matchedCount` 为 0** —— 只断言 `diffs` 长度的话，
    //    把判定从「只认 PAID」放宽成「非 PAID 也算匹配」就不会变红。
    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(0);
  });

  it('⚠️ 本地 PROCESSING + 渠道 FAILED → 不算差异（正常的失败重试流程）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [channel({ status: 'FAILED' })],
    });

    // ⚠️ **实现里专门为这条写了注释**（「渠道说没打成功，本地还在等 → 正常的失败重试
    //    流程」），却一直没有用例 → 有人把 FAILED 的判定放宽成「非 SUCCESS 即差异」
    //    也不会变红 → 本地还在等的单会凭空多出一批 CRITICAL 告警。
    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(0);
  });

  it('⚠️ 渠道有记录、无 paidAt、且匹配不到任何本地单 → 被忽略（不是 D 类）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [],
      channelRecords: [
        channel({
          referenceNo: 'PAY-UNKNOWN',
          paidAt: undefined,
        }),
      ],
    });

    // ⚠️ **实现的实际语义是「忽略」，不是「D 类」** ——
    //    第三步开头就是 `if (!paidAt) continue;`：**没有 `paidAt` 的渠道记录一律跳过**，
    //    因为 D 类的判定依赖「时刻是否落在扩大窗口内」，没有时刻就无从判断。
    //    （CSV 账单不配 `paidAt` 列时全部记录都是这个形状 → 一条差异都不产生。）
    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(0);
  });
});
