/**
 * 商家侧对账单的展示类型与文案（阶段 5i）。
 *
 * ⚠️ **与后端 `api/src/modules/billing/merchant-statement.service.ts`
 *    的 `StatementPeriodView` / `StatementPeriodDetail` 一一对应** ——
 *    改了一边要改另一边。
 *
 * ⚠️ **金额一律整数分**（全局约定），界面上用「元」，
 * 转换只在展示层做（见 `lib/money.ts`）。
 *
 * ⚠️ **这里的佣金是「带符号」的**：正数 = 平台抽了，负数 = 平台退了。
 *    这与出款单那套「佣金恒为正数」的约定**不同**（那边是单张出款单，
 *    这边是一整期）—— 前端**不要自己加负号**。
 */

// ⚠️ **时间格式化复用 `lib/billing.ts` 的 `formatDateTime`**：
//    两份实现迟早漂（时区格式会不一样）。
import { formatDateTime } from '@/lib/billing';
import { centsToYuan } from '@/lib/money';

/**
 * 结算单的状态。
 *
 * ⚠️ **与后端 Prisma 的 `SettlementStatus` 逐字一致**。
 */
export type StatementStatus = 'DRAFT' | 'CONFIRMED' | 'PAID';

/**
 * 结算单状态的中文文案。
 *
 * ⚠️ **`PAID` 译成「已结算」而不是「已出款」** ——
 *    结算单说的是「这一期的佣金定了」，出款单说的是「钱打给你了」。
 *    两个都译成「已出款」会让商家以为是一回事，
 *    看到「已出款」却没收到钱时就会来投诉。
 */
export const STATEMENT_STATUS_LABEL: Record<StatementStatus, string> = {
  DRAFT: '待确认',
  CONFIRMED: '已确认',
  PAID: '已结算',
};

/**
 * 结算单状态 → 中文文案。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 *    显示一个笼统的兜底文案，好过把裸枚举糊到界面上。
 *    但**不能猜成「待确认」**—— 猜错了商家会以为这一期还没结算。
 *
 * ⚠️ **`null` → 「待确认」**：没有结算单说明这一期压根还没生成，
 *    对商家来说就是「还没定下来」。
 */
export function describeStatementStatus(
  status: StatementStatus | string | null | undefined,
): string {
  if (status === null || status === undefined) return '待确认';
  return STATEMENT_STATUS_LABEL[status as StatementStatus] ?? '未知状态';
}

/**
 * 整数分 → 「¥12.34」形式的金额展示串。
 *
 * ⚠️ **这里不自己造换算**：直接用 `lib/money.ts` 的 `centsToYuan`
 *    （那边是「元 ↔ 分」的单一出处）。
 *
 * ⚠️ **负数原样显示**（`-¥5.00` 形式）：佣金冲回就是负数，
 *    前端**不要自己加负号** —— 符号已经是数据的一部分。
 */
export function formatCents(cents: number): string {
  return `¥${centsToYuan(cents)}`;
}

/**
 * 费率（基点）→ 百分数字符串。
 *
 * ⚠️ **基点的定义是 10000 = 100%** → 除以 100 得到百分数。
 *    `500` → `5%`，`750` → `7.5%`。
 *
 * ⚠️ **保留一位小数**：费率未必是整数基点（7.5% = 750），
 *    四舍五入到整数会把 7.5% 显示成 8% —— 商家一看就知道平台乱扣。
 *    整数基点时 `toFixed(1)` 会多出 `.0`，所以要先把 `.0` 去掉。
 */
export function formatRateBps(rateBps: number): string {
  const percent = rateBps / 100;
  const text = percent.toFixed(1);
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}%`;
}

/**
 * 抽佣流水的类型。
 *
 * ⚠️ **必须与后端 Prisma 的 `CommissionEntryType` 逐字一致**。
 */
export type CommissionEntryType = 'COMMISSION' | 'REVERSAL';

/** 抽佣流水的类型 → 中文文案 */
export const COMMISSION_ENTRY_TYPE_LABEL: Record<CommissionEntryType, string> = {
  COMMISSION: '抽佣',
  REVERSAL: '抽佣冲回',
};

/**
 * 抽佣流水类型 → 中文文案。
 *
 * ⚠️ **未知类型回落到「未知类型」（不原样回显）**：后端将来加第三种类型
 *    而前端没跟上时，界面上会出现一个商家看不懂的裸枚举。
 */
export function describeCommissionEntryType(type: string): string {
  return COMMISSION_ENTRY_TYPE_LABEL[type as CommissionEntryType] ?? '未知类型';
}

/**
 * 货款流水的类型。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReceiptType` 逐字一致**。
 */
export type ReceiptType = 'SALE' | 'SALE_REVERSAL';

/** 货款流水的类型 → 中文文案 */
export const RECEIPT_TYPE_LABEL: Record<ReceiptType, string> = {
  SALE: '货款入账',
  SALE_REVERSAL: '货款冲回',
};

/**
 * 货款流水类型 → 中文文案。
 *
 * ⚠️ **未知类型回落到「未知类型」（不原样回显）**：同上。
 */
export function describeReceiptType(type: string): string {
  return RECEIPT_TYPE_LABEL[type as ReceiptType] ?? '未知类型';
}

/**
 * 货款流水的出款状态。
 *
 * ⚠️ **必须与后端 `ReceiptPayoutStatus` 逐字一致**。
 */
export type ReceiptPayoutStatus = 'IN_FLIGHT' | 'PAID';

/**
 * 货款流水的出款状态 → 中文文案。
 *
 * ⚠️ **「出款中」与「已出款」是两回事**：
 *    在途的单（申请了但钱还没打）标「出款中」，
 *    只有 `PAID` 的单才标「已出款」——
 *    否则商家看到「已出款」却没收到钱就会来投诉。
 *
 * ⚠️ **未知状态回落到「未知状态」**（不原样回显裸枚举）。
 */
export function describeReceiptPayoutStatus(
  status: ReceiptPayoutStatus | string | null | undefined,
): string {
  if (status === null || status === undefined) return '未出款';
  if (status === 'IN_FLIGHT') return '出款中';
  if (status === 'PAID') return '已出款';
  return '未知状态';
}

/**
 * 缺笔提示的文案。
 *
 * ⚠️ **只陈述事实，不替平台判断谁该补钱** ——
 *    缺 `COMMISSION` 是平台少收，缺 `REVERSAL` 是商家少拿，
 *    方向取决于缺失流水的类型与正负，平台自己也要判断。
 *    所以商家端只说「缺 N 笔，佣金以结算单为准」。
 *
 * @returns 有缺笔时返回提示文案；不缺笔时返回 `null`（不显示）
 */
export function describeMissingEntries(count: number): string | null {
  if (count <= 0) return null;
  return `本期结算单缺 ${count} 笔抽佣流水，佣金以结算单为准`;
}

/**
 * 这一期能申请的出款类型。
 *
 * ⚠️ **与后端 `deriveApplicableKind` 的返回一致**：
 *    `null` = 不能申请（原因看 `blockedReason`）。
 */
export type ApplicableKind = 'NORMAL' | 'SUPPLEMENT';

/**
 * 一期对账单（列表页的一行）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 *    就是第二套口径，迟早漂。
 */
export interface StatementPeriod {
  /** 周期标识（`YYYY-MM`） */
  period: string;
  /** 该期结算单 id；null = 没有结算单 */
  statementId: string | null;
  /** 该期结算单状态；null = 没有结算单 */
  statementStatus: StatementStatus | null;
  /** 货款净额（整数分，带符号） */
  receiptAmount: number;
  /** 货款笔数 */
  receiptCount: number;
  /** 佣金净额（整数分，**带符号**：正数 = 平台抽了，负数 = 平台退了）；null = 没有结算单 */
  commissionAmount: number | null;
  /** 抽佣流水笔数 */
  commissionEntryCount: number;
  /** 应结金额（整数分）；null = 佣金未知 */
  payableAmount: number | null;
  /** 已出款（整数分） */
  paidAmount: number;
  /** 在途（整数分） */
  inFlightAmount: number;
  /** 待出款（整数分）；null = 应结未知 */
  pendingAmount: number | null;
  /** 已超付（整数分，> 0 = 平台多付了） */
  overpaidAmount: number;
  /** 能申请的出款类型；null = 不能申请 */
  applicableKind: ApplicableKind | null;
  /** 不能申请的原因；null = 能申请 */
  blockedReason: string | null;
  /**
   * 这一期结算单缺了多少笔抽佣流水（阶段 5j）。
   *
   * ⚠️ **没有结算单的期恒为 0**：「这一期还没结算」与「结算单缺笔」
   *    是两回事 —— 后者才需要提示商家。
   */
  missingEntryCount: number;
}

/** 一期对账单的详情（含两段明细） */
export interface StatementPeriodDetail extends StatementPeriod {
  /** 抽佣明细（结算单纳入的流水） */
  commissionEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 计佣基数（整数分） */
    baseAmount: number;
    /** 费率（基点，10000 = 100%） */
    rateBps: number;
    /** 佣金金额（整数分，**带符号**：抽佣正、冲回负） */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
  }>;
  /** 货款明细（实时） */
  receiptEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 金额（整数分，带符号） */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
    /**
     * 出款状态：null = 未被出款单纳入；IN_FLIGHT = 在途；PAID = 已出款。
     *
     * ⚠️ **不是 boolean** —— 「被出款单占用」不等于「钱已到账」，
     *    在途的单要单独标成「出款中」，否则商家会以为钱已经打过来了。
     */
    payoutStatus: ReceiptPayoutStatus | null;
  }>;
}

export { formatDateTime };
