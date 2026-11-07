import { PayoutKind, PayoutStatus, SettlementStatus } from '@prisma/client';

/**
 * Payout 模块的公共类型与共享 helper（阶段 11 拆分时集中）。
 * facade re-export 它们，既有 import 路径（'./payout.service'）不变。
 */
export interface Paging {
  page?: number;
  pageSize?: number;
}
export interface PayoutView {
  id: string;
  payoutNo: string;
  /** 出款类型：正常 / 补差（阶段 5h-2） */
  kind: PayoutKind;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  /** 货款净额（正数） */
  receiptAmount: number;
  /** 佣金净额（正数 = 平台抽了多少） */
  commissionAmount: number;
  /** 应结给商家的金额 */
  netAmount: number;
  entryCount: number;
  status: PayoutStatus;
  /** 申请时的预估金额（与 `netAmount` 可能不同 —— 审批时会重算） */
  requestedAmount: number;
  statementId: string | null;
  requestedBy: string;
  approvedBy: string | null;
  rejectedReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
  /** 打款渠道名（`PAID` / `PROCESSING` 时有值） */
  payoutChannel: string | null;
  /** 渠道交易号 */
  payoutTxnId: string | null;
  /** 已尝试次数（含首次） */
  attemptCount: number;
  /**
   * 最近一次失败的原因（**业务口径**，阶段 5l）。
   *
   * ⚠️ **不是原文** —— 原文可能是渠道的异常（带主机名、请求 id）或内部的
   *    解密信息，商家看到的是**内部术语**。
   *    渠道原文只在平台端的 `failureDetail` 里。
   */
  failureReason: string | null;
  /**
   * 「钱确定没打出去」的标记（阶段 5l）。
   *
   * ⚠️ **`true` = 渠道从未被调用 → 可安全重试**；
   *    `false` = 钱**可能已经打出去** → 不能重试，只能人工核对渠道。
   *
   * ⚠️ **不能靠 `failureReason` 的文案推断** —— 文案会被改、会被手工编辑。
   *    判断依据必须是**打款动作有没有发生**。
   */
  failedBeforePayout: boolean;
  /** 开始执行的时刻 */
  processingAt: string | null;
  /** 打款成功时刻 */
  paidAt: string | null;
  /** 失败落终态的时刻 */
  failedAt: string | null;
  /** 收款账户快照（户名） */
  snapshotAccountName: string | null;
  /** 收款账户快照（开户行） */
  snapshotBankName: string | null;
  /**
   * 收款账户快照（**账号脱敏**）。
   *
   * ⚠️ **快照里的账号是密文，但即便解开了也绝不能原样进 API 响应**
   *    （护栏 X14）—— 它是打款的依据，只给脱敏版。
   */
  maskedSnapshotAccountNo: string | null;
  createdAt: string;
}
export interface PayoutEntryView {
  entryId: string;
  orderNo: string;
  type: string;
  amount: number;
  occurredAt: string;
}
export interface PayoutDetailView extends PayoutView {
  entries: PayoutEntryView[];
}
export interface PlatformPayoutView extends PayoutView {
  tenantId: string;
  tenantName: string;
  subdomain: string;
  /**
   * 渠道侧的失败原文（**只有平台端有**，阶段 5l）。
   *
   * ⚠️ **只在 `FAILED` 时非 null**；长度截断到 500；去掉换行。
   */
  failureDetail: string | null;
}
export interface PayoutOperationView {
  id: string;
  /** `RETRY` / `UNSTUCK_TO_FAILED` / `UNSTUCK_TO_APPROVED` */
  action: string;
  /** 操作人（平台超管的用户 id） */
  operatorId: string;
  /**
   * 操作人的显示名。
   *
   * ⚠️ **查不到人时回落到 `operatorId`** —— 账号被删了也不能让留痕消失。
   */
  operatorName: string;
  /** 操作时刻（ISO 8601） */
  operatedAt: string;
  /** 操作原因（必填 —— 涉及钱的操作不能没有理由） */
  reason: string;
  /** 操作前的状态 */
  fromStatus: string;
  /** 操作后的状态 */
  toStatus: string;
}
export interface AvailablePeriodView {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  /** 该期结算单的状态；null = 该期没有结算单（零额抽佣） */
  statementStatus: SettlementStatus | null;
  /** 该期是否已有活跃出款单（正常或补差都算） */
  alreadyApplied: boolean;
  /**
   * 该期活跃单的种类；null = 没有活跃单。
   *
   * ⚠️ **商家端靠它区分「点哪个按钮」**（设计 §6.4b）。
   */
  appliedKind: PayoutKind | null;
  /**
   * 该期还能不能申请补差（正常单已 `PAID` 且仍有未纳入流水）。
   *
   * ⚠️ **不能只看 `alreadyApplied` 就禁用按钮** —— 正常单 `PAID` 后
   *    `alreadyApplied = true`，若直接禁用，**补差入口就此消失**。
   */
  supplementAvailable: boolean;
  /** 补差金额（整数分）；`supplementAvailable = false` 时为 null */
  supplementAmount: number | null;
}
export function generatePayoutNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `PAY${stamp}${random}`;
}
