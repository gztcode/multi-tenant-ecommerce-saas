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
 */
import { OrderStatus } from '@prisma/client';

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
  /** 已有 SALE_REVERSAL 货款流水的订单 id */
  reversalReceiptOrderIds: string[];
}

/** 自检的结果 */
export interface LedgerCheckResult {
  /** 缺抽佣流水的**订单号** */
  commissionMissing: string[];
  /** 缺冲回流水的**订单号** */
  reversalMissing: string[];
  /** 缺货款流水的**订单号** */
  receiptMissing: string[];
  /** 已退款但没有退款时间的订单数（冲回永远无法归期，**不算缺口**） */
  undatedRefundCount: number;
  /** 有缺口吗（三个 missing 数组任意一个非空） */
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
 * 5. `refundedAt` 为空 → `undatedRefundCount++`，结束这一单（**不是缺口**）
 * 6. `commissionAmount !== 0` 且不在 `reversalEntryOrderIds` → 记 `reversalMissing`
 *
 * ⚠️ **零额必须排除**：`shouldBackfillCommission` 与 `shouldBackfillReversal`
 * 都在 `commissionAmount === 0` 时提前 return → 零佣金订单**根本不会被要求有流水行**。
 * 漏掉这条 → 所有零佣金商家都被报成缺口 → 脚本永远 exit 1 → 防线变成噪音。
 * 同理，货款额为 0 的订单**不写 SALE 行**（`shouldBackfillReceipt`）。
 *
 * ⚠️ **「已支付」的判据是 `paidAt` 非空，不是 `status === PAID`**：
 * `SHIPPED` 的订单也付过钱。按 status 统计会报出假缺口。
 *
 * ⚠️ **「已退款但没有退款时间」不是缺口**：冲回永远无法归期
 * （阶段 5f 的已知边界，`Order.refundedAt` 是 5b 才加的字段）→
 * 单独计数并报出来，但**不导致非 0 退出码**。
 */
export function checkLedger(input: LedgerCheckInput): LedgerCheckResult {
  const commissionSet = new Set(input.commissionEntryOrderIds);
  const reversalSet = new Set(input.reversalEntryOrderIds);
  const receiptSet = new Set(input.receiptOrderIds);

  const commissionMissing: string[] = [];
  const reversalMissing: string[] = [];
  const receiptMissing: string[] = [];
  let undatedRefundCount = 0;

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

    // ⑤ 已退款但无退款时间 → 冲回无法归期，**不是缺口**（单独计数）
    if (!order.refundedAt) {
      undatedRefundCount += 1;
      continue;
    }

    // ⑥ 冲回流水：零额不记
    if (order.commissionAmount !== 0 && !reversalSet.has(order.id)) {
      reversalMissing.push(order.orderNo);
    }
  }

  return {
    commissionMissing,
    reversalMissing,
    receiptMissing,
    undatedRefundCount,
    hasGap:
      commissionMissing.length > 0 ||
      reversalMissing.length > 0 ||
      receiptMissing.length > 0,
  };
}
