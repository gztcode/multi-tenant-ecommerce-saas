/**
 * 账目流水自检的**判定逻辑**（阶段 5i，纯函数）。
 *
 * ⚠️ **为什么从脚本里拆出来**：脚本 `scripts/check-ledger.ts` 要 import
 *    整个 Nest 应用图（`AppModule`），单测 import 它就得能解析
 *    `@nestjs/jwt` 等 ESM 包 → 单测跑不起来。
 *    把判定逻辑拆成纯函数住在 `src/` 下（照 `settlement.ts` 的惯例）→
 *    单测只 import 这个文件，脚本 import 它 + `AppModule`。
 *
 * ⚠️ **判定口径必须与两个 `backfill()` 逐字一致**：
 *    `shouldBackfillCommission` / `shouldBackfillReversal`
 *    （`commission.service.ts`）与 `shouldBackfillReceipt` /
 *    `shouldBackfillReceiptReversal`（`receipt.service.ts`）
 *    共同定义了「哪些订单**应该有**流水行」。判定规则与它们对不上，
 *    脚本就会把**本来就不该有流水行**的订单报成缺口 → 防线变成噪音
 *    （永远 exit 1）。
 *
 * ⚠️ **全程整数域**：金额一律整数分。
 *
 * ⚠️ **支付单维度**（2026-11-05 审计 P0-3 / P1-3）：
 *    「钱收了但订单没接住」（渠道回调到达时订单已超时关闭 / 已被取消 /
 *    已被另一渠道先付掉）与「同一订单两个渠道各收一笔」这两种资损，
 *    **只查订单与流水表是查不出来的** —— 前者订单压根没有流水行，
 *    后者两笔支付单都是 `SUCCESS`、看起来一切正常。
 *    → 必须额外读 `payments` 表，把「钱收在哪、收了多少、订单是什么状态」
 *    一起摆出来。
 */
import { OrderStatus, PaymentStatus } from '@prisma/client';

import { isSettled } from '../order/order-status';

/**
 * 支付单自检的输入（订单支付单与订阅支付单都在内）。
 *
 * ⚠️ **金额一律整数分**：库里存的就是分，换算成元只发生在展示层。
 */
export interface LedgerPaymentInput {
  /** 支付单 id */
  id: string;
  /** 所属订单 id；**订阅支付单为 null** */
  orderId: string | null;
  /** 所属订单号；**订阅支付单为 null** */
  orderNo: string | null;
  /** 所属订单状态；**订阅支付单为 null** */
  orderStatus: OrderStatus | null;
  /** 支付渠道（渠道名，不是渠道背后的服务提供方） */
  channel: string;
  /** 金额（整数分） */
  amount: number;
  /** 支付单状态 */
  status: PaymentStatus;
}

/**
 * 自检的输入（全部是「已经查出来的扁平数据」，不涉及数据库）。
 *
 * ⚠️ **刻意做成纯数据的入参**：`checkLedger()` 不碰数据库 → 能直接单测，
 * 不必为了测判定逻辑去连开发库（判定规则错一步，防线就变成噪音）。
 */
export interface LedgerCheckInput {
  /** 已支付过的订单（`paidAt` 非空） */
  orders: Array<{
    id: string;
    orderNo: string;
    paidAt: Date | null;
    refundedAt: Date | null;
    status: OrderStatus;
    commissionAmount: number;
    totalAmount: number;
  }>;
  /** 已有 COMMISSION 流水的订单 id */
  commissionEntryOrderIds: string[];
  /** 已有 REVERSAL 流水的订单 id */
  reversalEntryOrderIds: string[];
  /** 已有 SALE 货款流水的订单 id */
  receiptOrderIds: string[];
  /**
   * 已有 `SALE_REVERSAL` 货款流水的订单 id。
   *
   * ⚠️ **这一份以前声明了却从未被读取**（审计 P2-A4）→ 货款冲回缺失查不出来。
   */
  reversalReceiptOrderIds: string[];
  /**
   * 支付单（订单支付单与订阅支付单都在内）。
   *
   * ⚠️ **订单状态直接挂在支付单上**（而不是另给一张「订单 id → 状态」的表）：
   * 判定「钱收了订单没接住」时每条判定都同时要看支付单和它的订单，
   * 挂在一起最省事；订阅支付单的三个订单字段一律为 null。
   */
  payments: LedgerPaymentInput[];
}

/**
 * 一条支付单维度的差异明细。
 *
 * ⚠️ **带齐明细而不是只给计数**：运维看到「差异 N 条」却不知道是哪几单、
 * 收了多少钱、走的是哪个渠道，等于没报。
 */
export interface LedgerPaymentIssue {
  /** 支付单 id */
  paymentId: string;
  /** 所属订单号；订阅支付单为 null */
  orderNo: string | null;
  /** 所属订单状态；订阅支付单为 null */
  orderStatus: OrderStatus | null;
  /** 支付渠道 */
  channel: string;
  /** 金额（整数分） */
  amount: number;
  /** 支付单状态 */
  paymentStatus: PaymentStatus;
}

/** 自检的结果 */
export interface LedgerCheckResult {
  /** 缺抽佣流水的**订单号** */
  commissionMissing: string[];
  /** 缺抽佣冲回流水的**订单号** */
  reversalMissing: string[];
  /** 缺货款流水的**订单号** */
  receiptMissing: string[];
  /**
   * 缺**货款冲回**流水的**订单号**（审计 P2-A4）。
   *
   * ⚠️ **这条检查以前从来没有**：`reversalReceiptOrderIds` 声明了、
   *   脚本也传进来了，但全文件从未被读取 → 「已退款却缺 `SALE_REVERSAL`」
   *   的订单会被报成「✅ 流水完整」exit 0。
   *   后果：出款时 `receiptAmount` = `merchant_receipts` 求和，
   *   退款冲回缺失 → 只算到 +10000 没有 -10000 → 商家按未退款全额申请出款。
   */
  receiptReversalMissing: string[];
  /**
   * 已退款但没有退款时间的订单数（**抽佣侧**冲回永远无法归期，**不算缺口**）。
   *
   * ⚠️ **只数抽佣侧**：零佣金订单本来就没有抽佣冲回可写，
   *   把它算进来是噪音（与 `backfill` 的 `skippedUndatedRefund` 口径一致）。
   */
  undatedRefundCount: number;
  /**
   * 已退款但没有退款时间的订单数（**货款侧**冲回永远无法归期，**不算缺口**）。
   *
   * ⚠️ **与抽佣侧分开数**：两侧的零额规则不同
   *   （抽佣看 `commissionAmount`、货款看 `totalAmount`），
   *   「零佣金但有货款」的订单只算货款侧。
   */
  undatedReceiptReversalCount: number;
  /**
   * **钱收了但订单没接住**的支付单（审计 P0-3）。
   *
   * ⚠️ 这些单子**不是数据坏了，是钱收了货没发**：订单已超时关闭 / 已被取消 /
   * 还在待支付 / 已退款，渠道回调却确认了收款。订单侧没有流水行，
   * 商家在系统内也退不掉 → 平台账上多出一笔收不到的钱。
   */
  orphanSuccessPayments: LedgerPaymentIssue[];
  /**
   * **重复收款**的支付单（审计 P1-3）。
   *
   * ⚠️ 同一个订单被两个渠道各收了一笔（`payments` 的唯一索引是
   * 「订单 + 渠道」，换渠道即可建第二行）。退款入口是单笔语义 → 只能退掉一笔。
   */
  duplicateSuccessPayments: LedgerPaymentIssue[];
  /**
   * **已收款待退款**的支付单。
   *
   * ⚠️ 渠道已确认收款，但这笔钱没有结算进订单 → 必须退回给用户。
   */
  needsRefundPayments: LedgerPaymentIssue[];
  /** 有缺口吗（四个 missing 数组与三个支付单数组任意一个非空） */
  hasGap: boolean;
}

/**
 * 判断历史订单的流水补齐了没有。
 *
 * ⚠️ **判定顺序与 `backfill()` 逐字对应**，每一步的「豁免条件」都来自那两个
 * `shouldBackfill*` 函数的早退分支：
 *
 * 1. `!paidAt` → 跳过（没付过钱 → 没有流水）
 * 2. `totalAmount !== 0` 且不在 `receiptOrderIds` → 记 `receiptMissing`
 * 3. `commissionAmount !== 0` 且不在 `commissionEntryOrderIds` → 记 `commissionMissing`
 * 4. 不是 `REFUNDED` → 结束这一单
 * 5. `refundedAt` 为空 → 抽佣侧 `undatedRefundCount++`、
 *    货款侧 `undatedReceiptReversalCount++`，结束这一单（**都不是缺口**）
 * 6. `commissionAmount !== 0` 且不在 `reversalEntryOrderIds` → 记 `reversalMissing`
 * 7. `totalAmount !== 0` 且不在 `reversalReceiptOrderIds` → 记 `receiptReversalMissing`
 *
 * ⚠️ **零额必须排除，而且两侧规则不同**：`shouldBackfillCommission` 与
 * `shouldBackfillReversal` 都在 `commissionAmount === 0` 时提前 return →
 * 零佣金订单**根本不会被要求有抽佣流水行**。漏掉这条 → 所有零佣金商家
 * 都被报成缺口 → 脚本永远 exit 1 → 防线变成噪音。
 * 同理，货款额为 0 的订单**不写 SALE 行**（`shouldBackfillReceipt`）。
 * ⚠️ **第 6 步用 `commissionAmount`、第 7 步用 `totalAmount`** ——
 * 货款侧的 `shouldBackfillReceiptReversal` 按 `totalAmount` 判零额，
 * 照抄成 `commissionAmount` 会把「零佣金但有货款」的正常订单误报成缺口。
 *
 * ⚠️ **「已支付」的判据是 `paidAt` 非空，不是 `status === PAID`**：
 * `SHIPPED` 的订单也付过钱。按 status 统计会报出假缺口。
 *
 * ⚠️ **「已退款但没有退款时间」不是缺口**：冲回永远无法归期
 * （阶段 5f 的已知边界，`Order.refundedAt` 是 5b 才加的字段）→
 * 单独计数并报出来，但**不导致非 0 退出码**。
 *
 * ⚠️ **支付单维度的三条检查在 `checkPayments()` 里**（审计 P0-3 / P1-3）：
 * 「钱收了但订单没接住」「同一订单重复收款」「已收款待退款」。
 * 它们与上面的流水缺口是**两回事**：上面查的是「该有的流水行有没有」，
 * 这里查的是「钱收在哪、收了几笔、订单有没有接住」。
 * 前者靠 `paidAt` 非空的订单取数 → **压根看不到**钱收了货没发的单子。
 */
export function checkLedger(input: LedgerCheckInput): LedgerCheckResult {
  const commissionSet = new Set(input.commissionEntryOrderIds);
  const reversalSet = new Set(input.reversalEntryOrderIds);
  const receiptSet = new Set(input.receiptOrderIds);
  // ⚠️ **这一份以前声明了却从未被读取**（审计 P2-A4）→ 货款冲回缺失查不出来
  const reversalReceiptSet = new Set(input.reversalReceiptOrderIds);

  const commissionMissing: string[] = [];
  const reversalMissing: string[] = [];
  const receiptMissing: string[] = [];
  const receiptReversalMissing: string[] = [];
  let undatedRefundCount = 0;
  let undatedReceiptReversalCount = 0;

  for (const order of input.orders) {
    // ① 没付过钱 → 没有流水
    if (!order.paidAt) {
      continue;
    }

    // ② 货款流水：零额不记
    if (order.totalAmount !== 0 && !receiptSet.has(order.id)) {
      receiptMissing.push(order.orderNo);
    }

    // ③ 抽佣流水：零额不记
    if (order.commissionAmount !== 0 && !commissionSet.has(order.id)) {
      commissionMissing.push(order.orderNo);
    }

    // ④ 没退款 → 结束
    if (order.status !== OrderStatus.REFUNDED) {
      continue;
    }

    // ⑤ 已退款但无退款时间 → 冲回无法归期，**不是缺口**（两侧分开计数）
    //    ⚠️ **两侧的零额规则不同**：抽佣侧零佣金 → 本来就没有抽佣冲回可写；
    //    货款侧零货款 → 本来就没有货款冲回可写。混在一起数就是噪音。
    if (!order.refundedAt) {
      if (order.commissionAmount !== 0) {
        undatedRefundCount += 1;
      }
      if (order.totalAmount !== 0) {
        undatedReceiptReversalCount += 1;
      }
      continue;
    }

    // ⑥ 抽佣冲回流水：零额不记
    if (order.commissionAmount !== 0 && !reversalSet.has(order.id)) {
      reversalMissing.push(order.orderNo);
    }

    // ⑦ 货款冲回流水：零额不记
    //    ⚠️ **谓词用 `totalAmount` 不是 `commissionAmount`** ——
    //    货款侧 `shouldBackfillReceiptReversal` 按 `totalAmount` 判零额。
    //    照抄成 `commissionAmount` → 「零佣金但有货款」的正常订单被误报成缺口
    //    → 脚本永远 exit 1 → 防线变成噪音。
    if (order.totalAmount !== 0 && !reversalReceiptSet.has(order.id)) {
      receiptReversalMissing.push(order.orderNo);
    }
  }

  const paymentIssues = checkPayments(input.payments);

  return {
    commissionMissing,
    reversalMissing,
    receiptMissing,
    receiptReversalMissing,
    undatedRefundCount,
    undatedReceiptReversalCount,
    ...paymentIssues,
    hasGap:
      commissionMissing.length > 0 ||
      reversalMissing.length > 0 ||
      receiptMissing.length > 0 ||
      receiptReversalMissing.length > 0 ||
      paymentIssues.orphanSuccessPayments.length > 0 ||
      paymentIssues.duplicateSuccessPayments.length > 0 ||
      paymentIssues.needsRefundPayments.length > 0,
  };
}

/**
 * 支付单维度的三条检查（审计 P0-3 / P1-3）。
 *
 * ⚠️ **为什么订单状态挂在支付单上**：判定「钱收了订单没接住」时，
 * 每一笔支付单都要同时看自己与它的订单 → 挂在支付单上最省事。
 *
 * ⚠️ **订阅支付单（`orderId` 为 null）不参与订单维度的判定**：
 * 订阅的钱不进订单流水，也没有「订单没接住」这回事。
 * 但它同样可能是「已收款待退款」→ `needsRefundPayments` 收它。
 */
function checkPayments(payments: LedgerPaymentInput[]): {
  orphanSuccessPayments: LedgerPaymentIssue[];
  duplicateSuccessPayments: LedgerPaymentIssue[];
  needsRefundPayments: LedgerPaymentIssue[];
} {
  const orphanSuccessPayments: LedgerPaymentIssue[] = [];
  const duplicateSuccessPayments: LedgerPaymentIssue[] = [];
  const needsRefundPayments: LedgerPaymentIssue[] = [];

  // ① 同一订单的成功支付单笔数（用来判重复收款）
  const successCountByOrderId = new Map<string, number>();
  for (const payment of payments) {
    if (payment.status !== PaymentStatus.SUCCESS || payment.orderId === null) {
      continue;
    }
    successCountByOrderId.set(
      payment.orderId,
      (successCountByOrderId.get(payment.orderId) ?? 0) + 1,
    );
  }

  for (const payment of payments) {
    const issue: LedgerPaymentIssue = {
      paymentId: payment.id,
      orderNo: payment.orderNo,
      orderStatus: payment.orderStatus,
      channel: payment.channel,
      amount: payment.amount,
      paymentStatus: payment.status,
    };

    // ② 已收款待退款（订单支付单与订阅支付单都算）
    if (payment.status === PaymentStatus.NEEDS_REFUND) {
      needsRefundPayments.push(issue);
      continue;
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      continue;
    }

    // ③ 订阅支付单不参与订单维度的两条判定
    if (payment.orderId === null) {
      continue;
    }

    // ④ 钱收了但订单没接住（订单不在「已结算」状态里）
    //    ⚠️ 订单状态查不到（null）也算没接住 —— 查不到就不敢当它接住了。
    if (payment.orderStatus === null || !isSettled(payment.orderStatus)) {
      orphanSuccessPayments.push(issue);
    }

    // ⑤ 重复收款：同一订单有 ≥2 笔成功支付单
    //    ⚠️ **同一订单的全部成功支付单都要报出来**（不能只报第二笔）——
    //    运维要看到「这单被收了几次、分别走的哪个渠道」。
    if ((successCountByOrderId.get(payment.orderId) ?? 0) >= 2) {
      duplicateSuccessPayments.push(issue);
    }
  }

  return {
    orphanSuccessPayments,
    duplicateSuccessPayments,
    needsRefundPayments,
  };
}
