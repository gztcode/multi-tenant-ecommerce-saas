import { PayoutKind, PayoutStatus, SettlementStatus } from '@prisma/client';

import { formatPeriodLabel } from './settlement';

/**
 * 账目口径的纯函数（阶段 5i）。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文。
 * 与 `settlement.ts`（结算单）同款理由 ——
 * **计钱的每一条分支都要能被完整断言**，而不是只能靠 e2e 跑出来。
 *
 * ⚠️ **全程整数域**：金额一律整数分（不换算成元）。
 *
 * ⚠️ **全程 UTC**：周期标识统一走 `formatPeriodLabel`，
 * 避免各处自己算月份导致漂移。
 */

/**
 * 出款单的类型。
 *
 * ⚠️ **直接复用 Prisma 的 `PayoutKind` 枚举**，不自己写一份字符串联合 ——
 *    自己写的话，Prisma 那边加了第三种类型，这里不会跟着变
 *    → 类型检查形同虚设。
 */
export type LedgerPayoutKind = PayoutKind;

/** 报表口径的平台收入 */
export interface ReportAmounts {
  /** 抽佣收入（整数分）。恒 >= 0 */
  commissionRevenue: number;
  /**
   * 退款冲回（整数分）。恒 >= 0。
   *
   * ⚠️ **与流水口径的符号相反**：
   * 流水里 `REVERSAL.amount` 是**负数**，
   * 而报表口径的 `netRevenue = 订阅 + 抽佣 − 冲回` 要的是**正数**。
   * 拿流水的数直接填报表 → 冲回被减两次。
   */
  reversal: number;
}

/**
 * 把流水的两个合计换算成报表口径。
 *
 * ⚠️ **符号不变体要抛错**：调用方传错符号时（抽佣传负、冲回传正），
 * 报表不会报错，只会**静默算错**（净收入的构成项被反向抵扣）。
 * 在这里炸掉，比在月底对账时发现差额便宜得多。
 *
 * @param commissionSum 抽佣合计（流水口径：`COMMISSION.amount` 之和，正数）
 * @param reversalSum 冲回合计（流水口径：`REVERSAL.amount` 之和，负数）
 */
export function toReportAmounts(
  commissionSum: number,
  reversalSum: number,
): ReportAmounts {
  if (commissionSum < 0) {
    throw new Error(
      `抽佣合计的符号异常：期望非负（流水里抽佣恒为正），收到 ${commissionSum}`,
    );
  }
  if (reversalSum > 0) {
    throw new Error(
      `冲回合计的符号异常：期望非正（流水里冲回恒为负），收到 ${reversalSum}`,
    );
  }
  // ⚠️ **取负才是报表口径**：报表的 `netRevenue` 是「减冲回」，
  //    冲回必须是正数才减得掉；流水的冲回是负数，直接用会让净额多减一遍。
  //
  // ⚠️ **`-0` 要归一成 `0`**：`-reversalSum` 在冲回为 0 时得到 `-0`，
  //    它会一路进到报表 JSON 里（序列化成 `-0`），也让
  //    `Object.is(x, 0)` 这类断言莫名失败。账目金额不该出现负零。
  const reversal = reversalSum === 0 ? 0 : -reversalSum;
  return { commissionRevenue: commissionSum, reversal };
}

/** 一笔货款流水（只需要金额与发生时间） */
export interface ReceiptLike {
  /** 带符号：货款为正、货款冲回为负 */
  amount: number;
  /** 流水发生时间（UTC） */
  occurredAt: Date;
}

/** 一期的货款合计 */
export interface ReceiptPeriodAmount {
  /** 货款净额（整数分）。**可以是负数**（该期只有冲回） */
  amount: number;
  /** 流水笔数 */
  count: number;
}

/**
 * 把货款流水按自然月（UTC）分组。
 *
 * ⚠️ **分组用 `formatPeriodLabel`**：周期标识只由一处算，
 * 否则「报表按 `occurredAt` 的月份、对账单按 `periodStart` 的月份」
 * 会因为时区差一天而错位一期。
 *
 * ⚠️ **`amount` 是带符号求和**：货款冲回是负数，
 * 同一期的净额可能是负数 —— 那是合法结果（商家该期被冲回了钱），
 * 不是错误，不该在这里被截断成 0。
 */
export function groupReceiptsByPeriod(
  receipts: ReceiptLike[],
): Map<string, ReceiptPeriodAmount> {
  const grouped = new Map<string, ReceiptPeriodAmount>();
  for (const receipt of receipts) {
    const label = formatPeriodLabel(receipt.occurredAt);
    const bucket = grouped.get(label);
    if (bucket) {
      bucket.amount += receipt.amount;
      bucket.count += 1;
    } else {
      grouped.set(label, { amount: receipt.amount, count: 1 });
    }
  }
  return grouped;
}

/** 一张出款单（只需要状态、净额与类型） */
export interface PayoutLike {
  status: PayoutStatus;
  /** 应结金额（整数分） */
  netAmount: number;
  kind: LedgerPayoutKind;
}

/** 出款金额的两个分桶 */
export interface PayoutAmountSplit {
  /** 已打出去的钱（`PAID`） */
  paid: number;
  /** 在途的钱（已申请 / 已审批 / 打款中） */
  inFlight: number;
}

/**
 * 在途的出款单状态（已申请 / 已审批 / 打款中）。
 *
 * ⚠️ **「在途」口径只有这一处** —— 别的地方要判断「这单还在途吗」，
 *    一律用这个常量，**不要自己再列一遍状态**：
 *    - `splitPayoutAmounts`（在途金额的分桶）
 *    - `MerchantStatementService.loadReceiptEntries`（货款明细的「出款中」标记）
 *
 *    自己再列一遍 → 出款状态机将来加一个在途状态，两处只改一处 →
 *    对账单的「在途金额」与明细的「出款中」对不上，商家看到两个数打架。
 *
 * ⚠️ **不含 `PAID`** —— `PAID` 的单钱已经打出去，不是在途。
 *    也不含 `REJECTED` / `CANCELLED` / `FAILED` —— 那三种都没打钱。
 */
export const IN_FLIGHT_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  PayoutStatus.REQUESTED,
  PayoutStatus.APPROVED,
  PayoutStatus.PROCESSING,
];

/**
 * 把出款单按「打没打出去」分桶。
 *
 * ⚠️ **`REJECTED` / `CANCELLED` / `FAILED` 两个桶都不进**：
 * 这三种状态**都没有打钱**。
 * 其中 `FAILED` 尤其要注意 —— 失败会释放明细占用，商家可以重新申请，
 * 那笔钱**仍属于「待出款」**，不该被算成「已出款」，
 * 也不该凭空消失（消失会让商家看到「待出款 0 元」，以为已经结清）。
 */
export function splitPayoutAmounts(payouts: PayoutLike[]): PayoutAmountSplit {
  let paid = 0;
  let inFlight = 0;
  for (const payout of payouts) {
    if (payout.status === PayoutStatus.PAID) {
      paid += payout.netAmount;
    } else if (IN_FLIGHT_PAYOUT_STATUSES.includes(payout.status)) {
      inFlight += payout.netAmount;
    }
    // ⚠️ **`REJECTED` / `CANCELLED` / `FAILED` 什么都不加**：
    //    都没打钱，加进哪个桶都是错的。
  }
  return { paid, inFlight };
}

/** 判定「这一期能不能申请出款」的入参 */
export interface ApplicableInput {
  /** 周期是否已结束（UTC 自然月已过完） */
  periodEnded: boolean;
  /** 货款净额（整数分，带符号） */
  receiptAmount: number;
  /** 货款笔数 */
  receiptCount: number;
  /** 佣金净额（整数分，带符号）。`null` = 没有已确认的结算单 */
  commissionAmount: number | null;
  /** 结算单状态。`null` = 没有结算单 */
  statementStatus: SettlementStatus | null;
  /**
   * 有没有活跃的正常单。
   *
   * ⚠️ **活跃 = 不在 `REJECTED` / `CANCELLED` / `FAILED` 里 —— 含 `PAID`**：
   * `PAID` 的正常单**占着索引位**，也算「已有单」。
   */
  hasActiveNormal: boolean;
  /** 有没有活跃的补差单 */
  hasActiveSupplement: boolean;
  /** 正常单是否已 `PAID`（这一期已经结清过一次） */
  normalPaid: boolean;
  /** 未纳入已出款范围的货款（补差金额）。`null` = 没有 */
  supplementAmount: number | null;
}

/** 判定结果 */
export interface ApplicableResult {
  /** 能申请的出款类型。`null` = 不能申请 */
  kind: LedgerPayoutKind | null;
  /** 不能申请的原因。`null` = 能申请 */
  reason: string | null;
}

/**
 * 判定这一期能不能申请出款，以及该走哪条路径。
 *
 * ⚠️ **判定要照 `PayoutService.apply` 的闸门，不是列表页的筛选条件**：
 * 列表页的筛选是「有没有单可看」，这里的判定是「点了申请会不会被拒」。
 * 两者口径不同，商家看到「可申请」却拿回报错，就是这里写错了。
 *
 * ⚠️ **补差路径必须在正常路径之前**：
 * 正常单已 `PAID` 时它**也是活跃单**（活跃含 `PAID`），
 * 若先判正常路径「已有出款申请在处理中」→ 补差入口永远不可达，
 * 商家在申请页看到「可申请补差」，点了却拿回那张已出款的旧单，
 * 补差单从未被创建，钱永远没打。
 */
export function deriveApplicableKind(input: ApplicableInput): ApplicableResult {
  if (!input.periodEnded) {
    // ⚠️ **周期内的流水还会变**（回填随时可能补进来），
    //    此时的数字不是凭证。
    return { kind: null, reason: '该周期尚未结束' };
  }
  if (input.receiptCount === 0 || input.receiptAmount <= 0) {
    return { kind: null, reason: '该期没有货款入账' };
  }
  if (input.commissionAmount === null || input.statementStatus === null) {
    return { kind: null, reason: '该期的结算单尚未生成' };
  }
  if (
    input.statementStatus !== SettlementStatus.CONFIRMED &&
    input.statementStatus !== SettlementStatus.PAID
  ) {
    // ⚠️ **`DRAFT` 任何路径都不可出款**：金额还没冻结。
    return { kind: null, reason: '该期的结算单尚未确认' };
  }

  // ⚠️ **补差路径优先**（见函数注释）。
  if (input.normalPaid) {
    if (input.hasActiveSupplement) {
      return { kind: null, reason: '该期已有补差出款单在处理中' };
    }
    if (!input.supplementAmount || input.supplementAmount <= 0) {
      // ⚠️ **没有待补的钱**：这一期已经结清，商家不能再申请。
      return { kind: null, reason: '该期货款已全部结清' };
    }
    return { kind: 'SUPPLEMENT', reason: null };
  }

  // ⚠️ **正常路径**：有活跃正常单（含 `PAID`）就不能再申请。
  if (input.hasActiveNormal) {
    return { kind: null, reason: '该期已有出款申请在处理中' };
  }
  if (input.statementStatus === SettlementStatus.PAID) {
    // ⚠️ **结算单已 `PAID` 说明正常单已打款**：
    //    正常路径会被 `assertStatementConfirmed` 拒（`PAID` 不放宽给正常单）。
    return { kind: null, reason: '该期已结算完成' };
  }
  return { kind: 'NORMAL', reason: null };
}
