/**
 * 出款相关的类型与文案（阶段 5h-1）。
 *
 * ⚠️ **与后端 `api/src/modules/billing/payout.service.ts` 的类型一一对应** ——
 * 改了一边要改另一边。
 *
 * ⚠️ **金额一律整数分**（全局约定），界面上用「元」，
 * 换算只在展示层做（见 `lib/money.ts`）。
 */

// ⚠️ **时间格式化复用 `lib/billing.ts` 的 `formatDateTime`**：
//    两份实现迟早漂（时区格式会不一样）。
import { formatDateTime } from '@/lib/billing';
import { centsToYuan } from '@/lib/money';

/**
 * 出款单的状态。
 *
 * ⚠️ **必须与后端 Prisma 的 `PayoutStatus` 逐字一致**：
 * 写成 `CANCELED`（一个 L）的话，界面上就是裸枚举。
 */
export type PayoutStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PAID'
  | 'FAILED';

/** 出款单状态的中文文案 */
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  REQUESTED: '待审批',
  APPROVED: '已审批',
  REJECTED: '已拒绝',
  CANCELLED: '已撤回',
  PAID: '已出款',
  FAILED: '出款失败',
};

/**
 * 出款单状态 → 中文文案。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 * 显示笼统的兜底文案好过把裸枚举（`WEIRD`）糊到界面上。
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
 * 出款单的时间线描述（按**状态**挑对应的时间，不是按「哪个字段非空」）。
 *
 * ⚠️ **为什么不能按字段非空**：后端 `reject()` 也填 `approvedAt` 与
 * `approvedBy`（拒绝同样是一次审批动作）。按 `approvedAt` 非空追加
 * 「· 审批时间」的话，被拒的单子会同时显示「已拒绝」与「已审批」——
 * 自相矛盾，超管会以为这单批过了。
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
 * 出款单的一行（商家侧与平台侧共用的字段）。
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
 * 平台视角：多商家名与子域名。
 *
 * ⚠️ **商家名与子域名是后端查好一起返回的**：出款单表上只有 `tenantId`，
 * 没有 Prisma 关系，是后端分别查完再合并的。
 */
export interface PlatformPayoutItem extends PayoutItem {
  tenantId: string;
  tenantName: string;
  subdomain: string;
}

/** 平台视角的详情（含明细） */
export interface PlatformPayoutDetail extends PlatformPayoutItem {
  periodStart: string;
  periodEnd: string;
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
  }>;
}

/** 列表接口的信封 */
export interface PayoutListResult {
  items: PlatformPayoutItem[];
  total: number;
}
