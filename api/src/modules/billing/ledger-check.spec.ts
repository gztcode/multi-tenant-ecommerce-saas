import { OrderStatus, PaymentStatus } from '@prisma/client';

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
 *
 * ⚠️ **支付单维度（2026-11-05 审计 P0-3 / P1-3）守护的是「防线不能形同虚设」**：
 * 「钱收了但订单没接住」与「同一订单重复收款」这两种资损，
 * 在订单与流水表里**一个都看不出来** —— 不补这三条检查，
 * 脚本会对这种单子报「✅ 流水完整」然后 exit 0。
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

/** 造一笔默认「正常」的支付单（订单已支付、状态 SUCCESS） */
function makePayment(
  overrides: Partial<LedgerCheckInput['payments'][number]> = {},
): LedgerCheckInput['payments'][number] {
  return {
    id: 'pay-1',
    orderId: 'order-1',
    orderNo: 'NO-1',
    orderStatus: OrderStatus.PAID,
    channel: 'fake',
    amount: 10000,
    status: PaymentStatus.SUCCESS,
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
    payments: [],
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

  it('⚠️ 零佣金的已退款订单不算「缺抽佣冲回」', () => {
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
        // ⚠️ 货款侧要单独给（零佣金只豁免抽佣侧，货款侧仍有货款额）
        reversalReceiptOrderIds: ['order-1'],
      }),
    );

    expect(result.reversalMissing).toEqual([]);
    expect(result.receiptReversalMissing).toEqual([]);
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
    // ⚠️ **两侧分开计数**：货款侧有货款额 → 也算「无归期」
    expect(result.undatedReceiptReversalCount).toBe(1);
    expect(result.receiptReversalMissing).toEqual([]);
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
        // ⚠️ 货款侧的冲回单独给（这条用例只盯抽佣侧）
        reversalReceiptOrderIds: ['order-1'],
      }),
    );

    expect(result.reversalMissing).toEqual(['NO-1']);
    expect(result.receiptReversalMissing).toEqual([]);
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
        reversalReceiptOrderIds: ['order-1'],
      }),
    );

    expect(result.reversalMissing).toEqual([]);
    expect(result.receiptReversalMissing).toEqual([]);
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
    expect(result.receiptReversalMissing).toEqual([]);
    expect(result.undatedRefundCount).toBe(0);
    expect(result.undatedReceiptReversalCount).toBe(0);
    expect(result.hasGap).toBe(false);
  });
});

/**
 * 货款冲回检查（2026-11-05 审计 P2-A4）。
 *
 * ⚠️ **这条检查以前从来没有**：`reversalReceiptOrderIds` 声明了、脚本也传进来了，
 *   但全文件从未被读取 → 「已退款却缺 `SALE_REVERSAL`」的订单会被报成
 *   「✅ 流水完整」exit 0。
 *   后果：出款时 `receiptAmount` = `merchant_receipts` 求和，
 *   退款冲回缺失 → 只算到 +10000 没有 -10000 → 商家按未退款全额申请出款。
 *
 * ⚠️ **谓词必须用 `totalAmount` 不是 `commissionAmount`**：
 *   货款侧的 `shouldBackfillReceiptReversal` 按 `totalAmount` 判零额，
 *   抽佣侧才按 `commissionAmount`。照抄成 `commissionAmount` 会把
 *   「零佣金但有货款」的正常订单误报成缺口 → 脚本永远 exit 1 → 防线变成噪音。
 */
describe('checkLedger：货款冲回检查（P2-A4）', () => {
  it('⚠️ 已退款订单缺货款冲回流水 → 报缺口', () => {
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
        receiptOrderIds: ['order-1'],
        reversalReceiptOrderIds: [],
      }),
    );

    expect(result.receiptReversalMissing).toEqual(['NO-1']);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 零佣金但有货款的已退款订单 → **仍然要**货款冲回流水（谓词用 totalAmount）', () => {
    // ⚠️ **这条是本次修复的核心锚点**：
    // 谓词若写成 `commissionAmount`，这条订单会被漏掉 →
    // 商家退了款、货款侧没有冲回 → 出款按未退款全额算 → 平台多付。
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
        reversalReceiptOrderIds: [],
      }),
    );

    expect(result.reversalMissing).toEqual([]);
    expect(result.receiptReversalMissing).toEqual(['NO-1']);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 货款额为 0 的已退款订单 → 不要求货款冲回流水（零额不记）', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({
            totalAmount: 0,
            status: OrderStatus.REFUNDED,
            refundedAt: new Date('2026-01-02T00:00:00Z'),
          }),
        ],
        commissionEntryOrderIds: ['order-1'],
        reversalEntryOrderIds: ['order-1'],
        receiptOrderIds: [],
        reversalReceiptOrderIds: [],
      }),
    );

    expect(result.receiptReversalMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 未退款的订单不要求货款冲回流水', () => {
    const result = checkLedger(
      makeInput({
        orders: [makeOrder({ status: OrderStatus.PAID })],
        receiptOrderIds: ['order-1'],
        reversalReceiptOrderIds: [],
      }),
    );

    expect(result.receiptReversalMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 已退款但无退款时间 → 只计数，不算缺口', () => {
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
        receiptOrderIds: ['order-1'],
        reversalReceiptOrderIds: [],
      }),
    );

    expect(result.receiptReversalMissing).toEqual([]);
    expect(result.undatedReceiptReversalCount).toBe(1);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 零佣金 + 无退款时间 → 货款侧计数、抽佣侧不计数（两侧零额规则不同）', () => {
    const result = checkLedger(
      makeInput({
        orders: [
          makeOrder({
            commissionAmount: 0,
            status: OrderStatus.REFUNDED,
            refundedAt: null,
          }),
        ],
        commissionEntryOrderIds: [],
        reversalEntryOrderIds: [],
        receiptOrderIds: ['order-1'],
        reversalReceiptOrderIds: [],
      }),
    );

    // 抽佣侧零额 → 本来就没有抽佣冲回可写 → 不计数
    expect(result.undatedRefundCount).toBe(0);
    // 货款侧有货款额 → 货款冲回永远无法归期 → 要计数
    expect(result.undatedReceiptReversalCount).toBe(1);
    expect(result.hasGap).toBe(false);
  });
});

/**
 * 支付单维度的三条检查（2026-11-05 审计 P0-3 / P1-3）。
 *
 * ⚠️ **这份用例守护的是「防线不能形同虚设」**：
 * 「钱收了但订单没接住」与「同一订单重复收款」这两种资损，
 * 在订单与流水表里**一个都看不出来** —— 不补这三条检查，
 * 脚本会对这种单子报「✅ 流水完整」然后 exit 0 → 防线名存实亡。
 */
describe('checkLedger：支付单维度的判定', () => {
  it('⚠️ 订单已超时关闭 + 一笔成功支付单 → 报「钱收了但订单没接住」', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            orderStatus: OrderStatus.CLOSED,
            status: PaymentStatus.SUCCESS,
          }),
        ],
      }),
    );

    expect(result.orphanSuccessPayments).toHaveLength(1);
    expect(result.orphanSuccessPayments[0].paymentId).toBe('pay-1');
    expect(result.orphanSuccessPayments[0].orderNo).toBe('NO-1');
    expect(result.orphanSuccessPayments[0].orderStatus).toBe(
      OrderStatus.CLOSED,
    );
    expect(result.orphanSuccessPayments[0].amount).toBe(10000);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 订单已被消费者取消 + 一笔成功支付单 → 也报「钱收了但订单没接住」', () => {
    // ⚠️ **CANCELLED 与 CLOSED 是两条不同的触发路径**
    // （审计对抗验证第 25 条：真实渠道的延迟回调落在「已取消」的订单上，
    //   与超时关闭是同一个失效路径，且触发条件更常见）。
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            orderStatus: OrderStatus.CANCELLED,
            status: PaymentStatus.SUCCESS,
          }),
        ],
      }),
    );

    expect(result.orphanSuccessPayments).toHaveLength(1);
    expect(result.orphanSuccessPayments[0].orderStatus).toBe(
      OrderStatus.CANCELLED,
    );
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 订单已退款 + 一笔成功支付单 → 也报「钱收了但订单没接住」', () => {
    // ⚠️ 已退款的订单钱已经退走了，支付单还停在 SUCCESS 同样是账目对不上
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            orderStatus: OrderStatus.REFUNDED,
            status: PaymentStatus.SUCCESS,
          }),
        ],
      }),
    );

    expect(result.orphanSuccessPayments).toHaveLength(1);
    expect(result.orphanSuccessPayments[0].orderStatus).toBe(
      OrderStatus.REFUNDED,
    );
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 订单还在待支付 + 一笔成功支付单 → 也报「钱收了但订单没接住」', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            orderStatus: OrderStatus.PENDING_PAYMENT,
            status: PaymentStatus.SUCCESS,
          }),
        ],
      }),
    );

    expect(result.orphanSuccessPayments).toHaveLength(1);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 订单已发货 / 已完成 + 一笔成功支付单 → 不报（钱已结算进订单）', () => {
    const shipped = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            orderStatus: OrderStatus.SHIPPED,
            status: PaymentStatus.SUCCESS,
          }),
        ],
      }),
    );
    const completed = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            orderStatus: OrderStatus.COMPLETED,
            status: PaymentStatus.SUCCESS,
          }),
        ],
      }),
    );

    expect(shipped.orphanSuccessPayments).toEqual([]);
    expect(completed.orphanSuccessPayments).toEqual([]);
    expect(shipped.hasGap).toBe(false);
    expect(completed.hasGap).toBe(false);
  });

  it('⚠️ 同一订单两笔成功支付单 → 报「重复收款」，且不报「钱收了但订单没接住」', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({ id: 'pay-1', channel: 'fake' }),
          makePayment({ id: 'pay-2', channel: 'sandbox' }),
        ],
      }),
    );

    // ⚠️ **两笔都要报出来**（不能只报第二笔）——
    // 运维要看到「这单被收了几次、分别走的哪个渠道」。
    expect(result.duplicateSuccessPayments).toHaveLength(2);
    expect(result.duplicateSuccessPayments.map((p) => p.paymentId)).toEqual([
      'pay-1',
      'pay-2',
    ]);
    expect(result.duplicateSuccessPayments.map((p) => p.channel)).toEqual([
      'fake',
      'sandbox',
    ]);
    // 订单是 PAID → 钱已经结算进订单了 → 不算「没接住」
    expect(result.orphanSuccessPayments).toEqual([]);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 不同订单各一笔成功支付单 → 不算重复收款', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({ id: 'pay-1', orderId: 'order-1', orderNo: 'NO-1' }),
          makePayment({ id: 'pay-2', orderId: 'order-2', orderNo: 'NO-2' }),
        ],
      }),
    );

    expect(result.duplicateSuccessPayments).toEqual([]);
    expect(result.orphanSuccessPayments).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 一笔「已收款待退款」支付单 → 报 needsRefundPayments', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            status: PaymentStatus.NEEDS_REFUND,
            orderStatus: OrderStatus.PENDING_PAYMENT,
          }),
        ],
      }),
    );

    expect(result.needsRefundPayments).toHaveLength(1);
    expect(result.needsRefundPayments[0].paymentId).toBe('pay-1');
    expect(result.needsRefundPayments[0].paymentStatus).toBe(
      PaymentStatus.NEEDS_REFUND,
    );
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 订阅支付单（无订单）不参与订单维度的判定，但待退款照样报', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({
            id: 'pay-sub-1',
            orderId: null,
            orderNo: null,
            orderStatus: null,
            status: PaymentStatus.SUCCESS,
          }),
          makePayment({
            id: 'pay-sub-2',
            orderId: null,
            orderNo: null,
            orderStatus: null,
            status: PaymentStatus.NEEDS_REFUND,
          }),
        ],
      }),
    );

    // 订阅支付单没有订单 → 「订单没接住」「重复收款」都不适用
    expect(result.orphanSuccessPayments).toEqual([]);
    expect(result.duplicateSuccessPayments).toEqual([]);
    // 但「已收款待退款」与订单无关 → 照样要报
    expect(result.needsRefundPayments).toHaveLength(1);
    expect(result.needsRefundPayments[0].paymentId).toBe('pay-sub-2');
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 失败 / 挂起 / 已退款的支付单一律不报（不是缺口）', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [
          makePayment({ id: 'p1', status: PaymentStatus.FAILED }),
          makePayment({ id: 'p2', status: PaymentStatus.PENDING }),
          makePayment({ id: 'p3', status: PaymentStatus.CLOSED }),
          makePayment({ id: 'p4', status: PaymentStatus.REFUNDED }),
          makePayment({ id: 'p5', status: PaymentStatus.REFUNDING }),
        ],
      }),
    );

    expect(result.orphanSuccessPayments).toEqual([]);
    expect(result.duplicateSuccessPayments).toEqual([]);
    expect(result.needsRefundPayments).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 查不到订单状态的支付单 → 按「订单没接住」报（不敢当它接住了）', () => {
    const result = checkLedger(
      makeInput({
        orders: [],
        payments: [makePayment({ orderStatus: null })],
      }),
    );

    expect(result.orphanSuccessPayments).toHaveLength(1);
    expect(result.hasGap).toBe(true);
  });

  it('⚠️ 锚点：订单已支付 + 一笔成功支付单 → 三条都不报，也没有缺口', () => {
    // ⚠️ **这条是防「假绿」的锚点**：判定写得太宽（把正常的成功支付单
    // 也报成缺口）会让脚本永远 exit 1 → 运维从此不再看它 → 防线名存实亡。
    const result = checkLedger(
      makeInput({
        payments: [makePayment()],
      }),
    );

    expect(result.orphanSuccessPayments).toEqual([]);
    expect(result.duplicateSuccessPayments).toEqual([]);
    expect(result.needsRefundPayments).toEqual([]);
    expect(result.hasGap).toBe(false);
  });
});
