import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';

/**
 * Payment 模块的公共类型（阶段 11 拆分时集中）。
 * 原先散在 payment.service.ts 顶部；facade re-export 它们，
 * 既有 import 路径（'./payment.service'）不变。
 */
export interface CreatedPayment {
  paymentId: string;
  orderNo: string;
  amount: number;
  channel: string;
  provider: string;
  status: PaymentStatus;
  providerTxnId: string | null;
  /** 支付页面 URL（相对路径） */
  payUrl: string;
  /** 渠道返回的原始数据 */
  rawResponse: Prisma.JsonValue;
}
export interface CreatedInvoicePayment {
  paymentId: string;
  /** 跳支付页的地址 */
  payUrl: string;
  /** 应付金额（整数分） */
  amount: number;
  /** 账单号（对外凭证） */
  invoiceNumber: string;
}
export interface InvoiceChargeResult {
  /** 支付单 id（本地） */
  paymentId: string;
  /** 渠道交易号。幂等去重要按它走 */
  providerTxnId: string;
  /**
   * 渠道侧的支付状态。
   * ⚠️ **开放字符串**：只有 `'SUCCESS'` 算成功，其余走失败路径。
   */
  status: string;
}
export interface WebhookEventCheck {
  accepted: boolean;
  /** 订单所属租户（**从订单反查**，不是从请求体里采信） */
  tenantId: string | null;
  orderId: string | null;
}
export interface RefundOutcome {
  /** `REFUNDED` = 已落账；`REFUNDING` = 已受理、结果待渠道确认 */
  status: 'REFUNDED' | 'REFUNDING';
}
export interface ReadableOrder {
  id: string;
  orderNo: string;
  status: OrderStatus;
  totalAmount: number;
  /**
   * 订单所属租户。
   *
   * ⚠️ **记抽佣流水时要用**：流水的 `tenantId` 从订单来，
   * 绝不从请求体或上下文猜。
   */
  tenantId: string;
  /**
   * 抽佣费率快照（基点）。
   *
   * ⚠️ **快照**：套餐费率将来会变，历史订单的抽佣额不能跟着变，
   * 所以流水里存的费率也必须是这一单当时的那一档。
   */
  commissionRate: number;
  /** 抽佣额快照（整数分） */
  commissionAmount: number;
  items: Array<{ skuId: string; quantity: number; productName: string }>;
}
export function readableError(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const text =
    typeof message === 'string' && message !== ''
      ? message
      : '渠道退款调用异常，结果未知';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
