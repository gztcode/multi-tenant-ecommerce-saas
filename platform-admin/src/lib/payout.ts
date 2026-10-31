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
 * 收款账户的展示串：`开户行 掩码账号（户名）`。
 *
 * ⚠️ **账号是密文，界面只给掩码**（阶段 5j）：库里存的是密文，
 *    响应里只有预存的掩码串（`maskedSnapshotAccountNo`）——
 *    **完整账号绝不在响应里，前端也不去解密**。
 *
 * ⚠️ **三个字段都可能为 null**（老数据没有快照）：这时返回 `null`，
 *    让调用方**整行不显示** —— 不能渲染出字面量 "null"，
 *    也不该用「—」占位（那一行本来就没有信息）。
 *
 * ⚠️ **只拼已有的部分**：户名可能缺、可能只有掩码串。
 *    用「—」占位缺失的部分会让超管以为「开户行不知道」，
 *    而实际情况是「这张单没有快照」。
 */
export function describePayoutAccount(payout: {
  snapshotBankName?: string | null;
  maskedSnapshotAccountNo?: string | null;
  snapshotAccountName?: string | null;
}): string | null {
  const parts: string[] = [];

  if (payout.snapshotBankName) parts.push(payout.snapshotBankName);
  if (payout.maskedSnapshotAccountNo) {
    parts.push(payout.maskedSnapshotAccountNo);
  }
  if (payout.snapshotAccountName) {
    parts.push(`（${payout.snapshotAccountName}）`);
  }

  // ⚠️ **三个字段全空 → 返回 null**（这张单没有收款账户快照）。
  return parts.length === 0 ? null : parts.join(' ');
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
  /**
   * 收款账户快照（户名）。null = 老数据没有快照
   *
   * ⚠️ **账号本身是密文，界面只给掩码**（见 `maskedSnapshotAccountNo`）。
   */
  snapshotAccountName: string | null;
  /** 收款账户快照（开户行）。null = 老数据没有快照 */
  snapshotBankName: string | null;
  /**
   * 收款账户快照（**账号脱敏**）。null = 老数据没有快照
   *
   * ⚠️ **库里存的是密文，响应里只给预存的掩码串** ——
   *    即便解开也绝不能原样进响应（护栏 X14）。
   *    掩码串是超管核对「钱打给谁」的**唯一**依据。
   */
  maskedSnapshotAccountNo: string | null;
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
  /**
   * 失败详情（**渠道侧的原文**，只有平台端有）。
   *
   * ⚠️ **商家端没有这个字段** —— 商家看到的是业务口径的 `failureReason`。
   * ⚠️ **它看不到解密根因** —— 那是 5k 的遗留 4（根因只进日志）。
   */
  failureDetail: string | null;
  /**
   * 「钱确定没打出去」的标记（阶段 5l）。
   *
   * ⚠️ **只有它为 true 才给「重试」按钮** —— 钱可能已经打出去的单
   *    重试 = **重复打款**。
   */
  failedBeforePayout: boolean;
  /**
   * 人工操作留痕（阶段 5l）。
   *
   * ⚠️ **只有平台端详情接口有** —— 列表接口没有。
   */
  operations: Array<{
    id: string;
    action: string;
    operatorId: string;
    /**
     * 操作人的显示名。
     *
     * ⚠️ **查不到人时后端回落到 `operatorId`** —— 账号被删了留痕也不消失。
     */
    operatorName: string;
    /** ISO 8601 */
    operatedAt: string;
    reason: string;
    fromStatus: string;
    toStatus: string;
  }>;
}

/**
 * 人工操作类型 → 中文文案（阶段 5l）。
 *
 * ⚠️ **未知类型回落到「人工操作」** —— 不显示裸枚举。
 */
export function describePayoutOperation(action: string): string {
  const labels: Record<string, string> = {
    RETRY: '重试出款',
    UNSTUCK_TO_FAILED: '解除卡单（标记为失败）',
    UNSTUCK_TO_APPROVED: '解除卡单（重新打款）',
  };
  return labels[action] ?? '人工操作';
}

/** 列表接口的信封 */
export interface PayoutListResult {
  items: PlatformPayoutItem[];
  total: number;
}
