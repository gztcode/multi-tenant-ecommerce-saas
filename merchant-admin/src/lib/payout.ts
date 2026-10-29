/**
 * 出款相关的类型与文案（阶段 5h-1）。
 *
 * ⚠️ **与后端 `api/src/modules/billing/payout.service.ts` 的类型一一对应** ——
 * 改了一边要改另一边。
 *
 * ⚠️ **金额一律整数分**（全局约定），界面上用「元」，
 * 转换只在展示层做（见 `lib/money.ts`）。
 */

// ⚠️ **时间格式化复用 `lib/billing.ts` 的 `formatDateTime`**：
//    两份实现迟早漂（时区格式会不一样）。
import { formatDateTime } from '@/lib/billing';
import { centsToYuan } from '@/lib/money';

/** 出款单的状态 */
export type PayoutStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED';

/** 出款单状态的中文文案 */
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  REQUESTED: '待审批',
  APPROVED: '已审批',
  REJECTED: '已拒绝',
  CANCELLED: '已撤回',
  // ⚠️ **阶段 5h-2 新增** —— 钱正在打出去
  PROCESSING: '打款中',
  PAID: '已出款',
  FAILED: '出款失败',
};

/**
 * 出款单的类型（阶段 5h-2）。
 *
 * ⚠️ **与后端 Prisma 的 `PayoutKind` 逐字一致**。
 */
export type PayoutKind = 'NORMAL' | 'SUPPLEMENT';

/** 出款单类型的中文文案 */
export const PAYOUT_KIND_LABEL: Record<PayoutKind, string> = {
  NORMAL: '正常出款',
  SUPPLEMENT: '补差出款',
};

/**
 * 出款单类型 → 中文文案。
 *
 * ⚠️ **未知类型回落到「正常出款」**：补差是**增量**，回落到「正常」
 *    不会让商家误以为钱要少发；回落到「未知类型」反而让人困惑。
 */
export function describePayoutKind(kind: PayoutKind | string): string {
  return PAYOUT_KIND_LABEL[kind as PayoutKind] ?? PAYOUT_KIND_LABEL.NORMAL;
}

/**
 * 出款单状态 → 中文文案。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 * 显示一个笼统的兜底文案，好过把裸枚举糊到界面上。
 * 但**不能猜成「待审批」**——猜错了商家会以为钱已经在走流程了。
 */
export function describePayoutStatus(status: PayoutStatus | string): string {
  return PAYOUT_STATUS_LABEL[status as PayoutStatus] ?? '未知状态';
}

/**
 * 出款明细的流水类型。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReceiptType` 逐字一致**：
 * 写成 `SALE_REFUND` 之类的话，界面上就是裸枚举。
 */
export type PayoutEntryType = 'SALE' | 'SALE_REVERSAL';

/** 出款明细的流水类型 → 中文文案 */
export const PAYOUT_ENTRY_TYPE_LABEL: Record<PayoutEntryType, string> = {
  SALE: '货款入账',
  SALE_REVERSAL: '货款冲回',
};

/**
 * 出款明细的流水类型 → 中文文案。
 *
 * ⚠️ **未知类型回落到「未知类型」（不原样回显）**：规格要求「不显示裸枚举」——
 *    后端将来加第三种 `ReceiptType` 而前端没跟上时，界面上会出现一个
 *    商家看不懂的 `FOO`。落成一句笼统的兜底文案更合适。
 */
export function describePayoutEntryType(type: string): string {
  return PAYOUT_ENTRY_TYPE_LABEL[type as PayoutEntryType] ?? '未知类型';
}

/**
 * 出款单的时间线描述（按**状态**挑对应的时间，不是按「哪个字段非空」）。
 *
 * ⚠️ **为什么不能按字段非空**：后端 `reject()` 也填 `approvedAt` 与
 * `approvedBy`（拒绝同样是一次审批动作）。按 `approvedAt` 非空追加
 * 「· 审批时间」的话，被拒的单子会同时显示「已拒绝」与「已审批」——
 * 自相矛盾，商家会以为这单批过了。
 *
 * ⚠️ **时间格式复用 `lib/billing.ts` 的 `formatDateTime`**：
 *    两份实现迟早漂（时区格式会不一样）。
 */
export function describePayoutTimeline(payout: {
  status: PayoutStatus | string;
  requestedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
}): string {
  const parts = [`申请时间 ${formatDateTime(payout.requestedAt)}`];

  switch (payout.status) {
    case 'APPROVED':
      parts.push(`审批时间 ${formatDateTime(payout.approvedAt)}`);
      break;
    case 'REJECTED':
      parts.push(`拒绝时间 ${formatDateTime(payout.approvedAt)}`);
      break;
    case 'CANCELLED':
      parts.push(`撤回时间 ${formatDateTime(payout.cancelledAt)}`);
      break;
    default:
      // ⚠️ **待审批 / 已出款 / 出款失败不追加时间**：
      //    这几个状态下没有「审批 / 拒绝 / 撤回」这回事，
      //    硬凑一句只会显示一个空的「—」。
      break;
  }

  return parts.join(' · ');
}

/**
 * 整数分 → 「¥12.34」形式的金额展示串。
 *
 * ⚠️ **这里不自己造换算**：直接用 `lib/money.ts` 的 `centsToYuan`
 * （那边是「元 ↔ 分」的单一出处）。
 *
 * ⚠️ **两份 `lib/payout.ts` 是各自独立的文件**（本项目既有模式），
 *    所以这个函数在两个前端里都要有、内容必须一致。
 */
export function formatCents(cents: number): string {
  return `¥${centsToYuan(cents)}`;
}

/**
 * 出款单的一行。
 *
 * ⚠️ **`receiptAmount` 与 `commissionAmount` 都是正数**：
 * 佣金是「平台抽了多少」，与结算单那套「冲回是负数」的符号约定**不同** ——
 * 这一类已坑过两次。前端不要自己减。
 */
export interface PayoutItem {
  id: string;
  payoutNo: string;
  /** 周期标识（`YYYY-MM`） */
  periodLabel: string;
  /** 货款净额（正数，整数分） */
  receiptAmount: number;
  /** 佣金净额（正数 = 平台抽了多少，整数分） */
  commissionAmount: number;
  /** 应结给商家的金额（整数分） */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
  status: PayoutStatus;
  /** 申请时的预估金额（审批时会重算 → 两者可能不同） */
  requestedAmount: number;
  /** ISO 8601 */
  requestedAt: string;
  /** ISO 8601。null = 未审批 */
  approvedAt: string | null;
  /** ISO 8601。null = 未撤回 */
  cancelledAt: string | null;
  /** 拒绝原因。null = 未拒绝 */
  rejectedReason: string | null;
  /** 出款类型：正常 / 补差 */
  kind: PayoutKind;
  /** 已尝试次数（含首次）。3 = 试满仍失败 */
  attemptCount: number;
  /** 最近一次失败的原因。null = 没有失败过 */
  failureReason: string | null;
  /** 打款渠道名。null = 还没开始打 */
  payoutChannel: string | null;
  /** ISO 8601。null = 未开始执行 */
  processingAt: string | null;
  /** ISO 8601。null = 未打款成功 */
  paidAt: string | null;
  /** ISO 8601。null = 未失败 */
  failedAt: string | null;
}

/** 出款单详情（含明细） */
export interface PayoutDetail extends PayoutItem {
  /** 周期起点（含）。ISO 8601 */
  periodStart: string;
  /** 周期终点（不含）。ISO 8601 */
  periodEnd: string;
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 金额（整数分） */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
  }>;
}

/**
 * 收款账户（账号已脱敏）。
 *
 * ⚠️ **没有 `accountNo` 字段**：后端只给脱敏后的 `maskedAccountNo`，
 * 完整账号压根不该进浏览器 —— 界面上显示一个假的完整账号更危险
 * （商家以为改的是原账号，其实提交的是另一个）。
 */
export interface PayoutAccount {
  accountName: string;
  bankName: string;
  maskedAccountNo: string;
  updatedAt: string;
}

/** 可申请的周期 */
export interface AvailablePeriod {
  /** 周期标识（`YYYY-MM`） */
  period: string;
  /** 货款净额（正数，整数分） */
  receiptAmount: number;
  /** 佣金净额（正数 = 平台抽了多少，整数分） */
  commissionAmount: number;
  /** 应结给商家的金额（整数分） */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
  /** 该期结算单的状态；null = 没有结算单 */
  statementStatus: string | null;
  /** 该期是否已有活跃出款单（正常或补差都算） */
  alreadyApplied: boolean;
  /**
   * 该期活跃单的种类；null = 没有活跃单。
   *
   * ⚠️ **靠它区分「点哪个按钮」**（阶段 5h-2）。
   */
  appliedKind: PayoutKind | null;
  /**
   * 该期还能不能申请补差（正常单出款后仍有未纳入流水）。
   *
   * ⚠️ **不能只看 `alreadyApplied` 就禁用按钮** —— 正常单出款后
   * `alreadyApplied = true`，若直接禁用，**补差入口就此消失**。
   */
  supplementAvailable: boolean;
  /** 补差金额（整数分）；`supplementAvailable = false` 时为 null */
  supplementAmount: number | null;
}
