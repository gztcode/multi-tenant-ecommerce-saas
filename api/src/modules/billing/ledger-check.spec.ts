import { OrderStatus } from '@prisma/client';

import { checkLedger, type LedgerCheckInput } from './ledger-check';

/**
 * 账目流水自检的判定逻辑（纯函数，**不连数据库**）。
 *
 * ⚠️ **这份用例守护的是「防线不能变成噪音」**：
 * 自检脚本的判定规则一旦与两个 `backfill()` 对不上，就会把
 * **本来就不该有流水行**的订单报成缺口 → 脚本永远 exit 1 →
 * 运维从此不再看这个脚本，防线名存实亡。
 *
 * ⚠️ **零额订单是最容易踩的坑**：
 * `shouldBackfillCommission` / `shouldBackfillReversal` 在 `commissionAmount === 0`
 * 时提前 return → 零佣金订单**根本不会被要求有流水行**。
 */

/** 造一个默认「一切正常」的订单 */
function makeOrder(
  overrides: Partial<LedgerCheckInput['orders'][number]> = {},
): LedgerCheckInput['orders'][number] {
  return {
    id: 'order-1',
    orderNo: 'NO-1',
    paidAt: new Date('2026-01-01T00:00:00Z'),
    refundedAt: null,
    status: OrderStatus.PAID,
    commissionAmount: 500,
    totalAmount: 10000,
    ...overrides,
  };
}

/** 造一份默认「全部流水都在」的入参 */
function makeInput(
  overrides: Partial<LedgerCheckInput> = {},
): LedgerCheckInput {
  const orders = overrides.orders ?? [makeOrder()];
  return {
    orders,
    commissionEntryOrderIds: ['order-1'],
    reversalEntryOrderIds: [],
    receiptOrderIds: ['order-1'],
    reversalReceiptOrderIds: [],
    ...overrides,
  };
}

describe('checkLedger：账目流水自检的判定', () => {
  it('⚠️ 零佣金订单不算缺口（有货款、无抽佣是正常的）', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ commissionAmount: 0 })],
        commissionEntryOrderIds: [],
        receiptOrderIds: ['order-1'],
      }),
    );

    expect(result.commissionMissing).toEqual([]);
    expect(result.receiptMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 零佣金的已退款订单不算「缺冲回」', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({
            commissionAmount: 0,
            status: OrderStatus.REFUNDED,
            refundedAt: new Date('2026-01-02T00:00:00Z'),
          }),
        ],
        commissionEntryOrderIds: [],
        reversalEntryOrderIds: [],
        receiptOrderIds: ['order-1'],
      }),
    );

    expect(result.reversalMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('非零佣金的已支付订单缺抽佣流水 → 报缺口', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ commissionAmount: 500 })],
        commissionEntryOrderIds: [],
      }),
    );

    // 报的是**订单号**，不是订单 id（运维要照着订单号去查）
    expect(result.commissionMissing).toEqual(['NO-1']);
    expect(result.hasGap).toBe(true);
  });

  it('有抽佣流水 → 不报缺口', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ commissionAmount: 500 })],
        commissionEntryOrderIds: ['order-1'],
      }),
    );

    expect(result.commissionMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 已退款但无退款时间 → 归到「无归期退款」，**不算缺口**', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({
            status: OrderStatus.REFUNDED,
            refundedAt: null,
          }),
        ],
        commissionEntryOrderIds: ['order-1'],
        reversalEntryOrderIds: [],
      }),
    );

    expect(result.undatedRefundCount).toBe(1);
    expect(result.reversalMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('缺货款流水 → 报缺口', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ totalAmount: 10000 })],
        receiptOrderIds: [],
      }),
    );

    expect(result.receiptMissing).toEqual(['NO-1']);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 货款额为 0 的订单不算「缺货款流水」', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ totalAmount: 0 })],
        receiptOrderIds: [],
      }),
    );

    expect(result.receiptMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 没付过钱的订单（paidAt 为空）完全跳过', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ paidAt: null })],
        commissionEntryOrderIds: [],
        receiptOrderIds: [],
      }),
    );

    expect(result.commissionMissing).toEqual([]);
    expect(result.receiptMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 已退款且有退款时间但缺冲回流水 → 报缺口', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({
            status: OrderStatus.REFUNDED,
            refundedAt: new Date('2026-01-02T00:00:00Z'),
          }),
        ],
        commissionEntryOrderIds: ['order-1'],
        reversalEntryOrderIds: [],
      }),
    );

    expect(result.reversalMissing).toEqual(['NO-1']);
    expect(result.undatedRefundCount).toBe(0);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 已退款且有退款时间、有冲回流水 → 不报缺口', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({
            status: OrderStatus.REFUNDED,
            refundedAt: new Date('2026-01-02T00:00:00Z'),
          }),
        ],
        commissionEntryOrderIds: ['order-1'],
        reversalEntryOrderIds: ['order-1'],
      }),
    );

    expect(result.reversalMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 非 REFUNDED 状态（SHIPPED 等）不要求冲回流水', () => {
    // ⚠️ `SHIPPED` 的订单也付过钱 → 需要抽佣与货款流水，但**没有冲回**
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ status: OrderStatus.SHIPPED })],
        commissionEntryOrderIds: ['order-1'],
        receiptOrderIds: ['order-1'],
        reversalEntryOrderIds: [],
      }),
    );

    expect(result.reversalMissing).toEqual([]);
    expect(result.undatedRefundCount).toBe(0);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 多个缺口都要被记下来（不是只记第一个）', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({ id: 'o1', orderNo: 'NO-1' }),
          makeOrder({ id: 'o2', orderNo: 'NO-2' }),
          makeOrder({ id: 'o3', orderNo: 'NO-3' }),
        ],
        commissionEntryOrderIds: [],
        receiptOrderIds: [],
      }),
    );

    expect(result.commissionMissing).toEqual(['NO-1', 'NO-2', 'NO-3']);
    expect(result.receiptMissing).toEqual(['NO-1', 'NO-2', 'NO-3']);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 一单可以同时缺抽佣与货款（两个数组各记一条）', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder()],
        commissionEntryOrderIds: [],
        receiptOrderIds: [],
      }),
    );

    expect(result.commissionMissing).toEqual(['NO-1']);
    expect(result.receiptMissing).toEqual(['NO-1']);
    expect(result.reversalMissing).toEqual([]);
    expect(result.hasGap).toBe(true);
  });

  it('空订单列表 → 无缺口', () => {
    const result = checkLedger(makeInput({ orders: [] }));

    expect(result.commissionMissing).toEqual([]);
    expect(result.reversalMissing).toEqual([]);
    expect(result.receiptMissing).toEqual([]);
    expect(result.undatedRefundCount).toBe(0);
    expect(result.hasGap).toBe(false);
  });
});
