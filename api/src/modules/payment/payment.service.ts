import { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { PaymentLookupService } from './payment-lookup.service';
import { OrderPaymentService } from './payment-order.service';
import {
  NormalizedWebhookEvent,
  PaymentProvider,
} from './payment-provider.interface';
import { RefundService } from './payment-refund.service';
import {
  CreatedInvoicePayment,
  CreatedPayment,
  InvoiceChargeResult,
  ReadableOrder,
  RefundOutcome,
  WebhookEventCheck,
} from './payment-types';
import { WebhookEventService } from './payment-webhook.service';
import { Injectable } from '@nestjs/common';
import { Payment, PaymentKind } from '@prisma/client';

export type {
  CreatedInvoicePayment,
  CreatedPayment,
  InvoiceChargeResult,
  ReadableOrder,
  RefundOutcome,
  WebhookEventCheck,
} from './payment-types';

/**
 * PaymentService —— facade（阶段 11 拆分）。
 *
 * 原 2636 行巨石按职责拆为四个服务：
 *
 * | 文件 | 类 | 职责 |
 * |------|------|------|
 * | payment-lookup.service.ts | PaymentLookupService | 跨租户读取、渠道解析 |
 * | payment-order.service.ts | OrderPaymentService | 支付单创建/确认（订单+账单） |
 * | payment-refund.service.ts | RefundService | 退款全链路 + 卡单扫描 |
 * | payment-webhook.service.ts | WebhookEventService | webhook 事件校验/入库/应用 |
 *
 * 本类**不再承载业务逻辑**：
 * - 模块内控制器/worker 的调用点零改动（所有 public 方法原签名委托）；
 * - 对外导出的类型（CreatedPayment 等）原地 re-export，import 路径不变；
 * - 注入方式保持「模块内其他类注入 PaymentService」不变，避免改动 provider 图。
 *
 * ⚠️ 事务纪律：子服务方法如在事务回调中被调用，必须显式接收 `tx` 参数
 *    并只用 `tx` 查库——tx-boundary-scanner 会沿 `this.webhookEvents.xxx`
 *    的跨服务调用链做类型解析（「形态 B」），新增违规 CI 变红。
 */
@Injectable()
export class PaymentService {
  private readonly lookup: PaymentLookupService;
  private readonly orderPayments: OrderPaymentService;
  private readonly refunds: RefundService;
  private readonly webhookEvents: WebhookEventService;

  constructor(
    lookup: PaymentLookupService,
    orderPayments: OrderPaymentService,
    refunds: RefundService,
    webhookEvents: WebhookEventService,
  ) {
    this.lookup = lookup;
    this.orderPayments = orderPayments;
    this.refunds = refunds;
    this.webhookEvents = webhookEvents;
  }

  /** @see lookup#currentTenantId（阶段 11 拆分，逻辑见实现文件） */
  currentTenantId(): string {
    return this.lookup.currentTenantId();
  }
  /** @see orderPayments#createPayment（阶段 11 拆分，逻辑见实现文件） */
  async createPayment(
    orderNo: string,
    channel: string,
    customerId: string | null,
  ): Promise<CreatedPayment> {
    return this.orderPayments.createPayment(orderNo, channel, customerId);
  }
  /** @see orderPayments#createInvoicePayment（阶段 11 拆分，逻辑见实现文件） */
  async createInvoicePayment(
    invoiceNumber: string,
    channel: string,
  ): Promise<CreatedInvoicePayment> {
    return this.orderPayments.createInvoicePayment(invoiceNumber, channel);
  }
  /** @see orderPayments#chargeInvoice（阶段 11 拆分，逻辑见实现文件） */
  async chargeInvoice(
    invoiceNumber: string,
    channel: string,
    paymentMethodToken: string,
  ): Promise<InvoiceChargeResult> {
    return this.orderPayments.chargeInvoice(
      invoiceNumber,
      channel,
      paymentMethodToken,
    );
  }
  /** @see webhookEvents#checkWebhookEvent（阶段 11 拆分，逻辑见实现文件） */
  async checkWebhookEvent(
    event: NormalizedWebhookEvent,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<WebhookEventCheck> {
    return this.webhookEvents.checkWebhookEvent(event, kind);
  }
  /** @see webhookEvents#insertEvent（阶段 11 拆分，逻辑见实现文件） */
  async insertEvent(
    event: NormalizedWebhookEvent,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<boolean> {
    return this.webhookEvents.insertEvent(event, kind);
  }
  /** @see webhookEvents#enqueueWebhookEvent（阶段 11 拆分，逻辑见实现文件） */
  async enqueueWebhookEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
    kind: PaymentKind = PaymentKind.ORDER,
    jobIdSuffix = '',
  ): Promise<void> {
    return this.webhookEvents.enqueueWebhookEvent(
      event,
      tenantId,
      kind,
      jobIdSuffix,
    );
  }
  /** @see webhookEvents#loadRegisteredEvent（阶段 11 拆分，逻辑见实现文件） */
  async loadRegisteredEvent(
    provider: string,
    eventId: string,
  ): Promise<{ event: NormalizedWebhookEvent; kind: PaymentKind } | null> {
    return this.webhookEvents.loadRegisteredEvent(provider, eventId);
  }
  /** @see webhookEvents#applyEventInTx（阶段 11 拆分，逻辑见实现文件） */
  async applyEventInTx(
    tx: PrismaTransaction,
    event: NormalizedWebhookEvent,
    order: {
      id: string;
      orderNo: string;
      totalAmount: number;
      tenantId: string;
      commissionRate: number;
      commissionAmount: number;
      items: Array<{ skuId: string; quantity: number }>;
    },
  ): Promise<void> {
    return this.webhookEvents.applyEventInTx(tx, event, order);
  }
  /** @see webhookEvents#markEventProcessed（阶段 11 拆分，逻辑见实现文件） */
  async markEventProcessed(event: NormalizedWebhookEvent): Promise<void> {
    return this.webhookEvents.markEventProcessed(event);
  }
  /** @see lookup#runInTenant（阶段 11 拆分，逻辑见实现文件） */
  async runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.lookup.runInTenant(tenantId, fn);
  }
  /** @see refunds#refund（阶段 11 拆分，逻辑见实现文件） */
  async refund(orderNo: string, reason: string): Promise<RefundOutcome> {
    return this.refunds.refund(orderNo, reason);
  }
  /** @see refunds#verifyRefundingPayment（阶段 11 拆分，逻辑见实现文件） */
  async verifyRefundingPayment(
    paymentId: string,
    refundTxnId: string | null,
  ): Promise<boolean> {
    return this.refunds.verifyRefundingPayment(paymentId, refundTxnId);
  }
  /** @see refunds#applyRefundEvent（阶段 11 拆分，逻辑见实现文件） */
  async applyRefundEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
  ): Promise<void> {
    return this.refunds.applyRefundEvent(event, tenantId);
  }
  /** @see refunds#scanRefunding（阶段 11 拆分，逻辑见实现文件） */
  // ⚠️ **必须用可选参数直传，不能写 `now = new Date()` 默认值**：
  //    子服务的实现里 `now ?? databaseNow()` 默认取**库时钟**（P2-15 时钟纪律），
  //    facade 若用默认参数先把 `new Date()` 填进去，`??` 永远不会触发 → 库时钟被吞。
  async scanRefunding(now?: Date): Promise<number> {
    return this.refunds.scanRefunding(now);
  }
  /** @see orderPayments#fakeConfirmPayment（阶段 11 拆分，逻辑见实现文件） */
  async fakeConfirmPayment(paymentId: string): Promise<void> {
    return this.orderPayments.fakeConfirmPayment(paymentId);
  }
  /** @see webhookEvents#applyEvent（阶段 11 拆分，逻辑见实现文件） */
  async applyEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<void> {
    return this.webhookEvents.applyEvent(event, tenantId, kind);
  }
  /** @see orderPayments#fakeFailPayment（阶段 11 拆分，逻辑见实现文件） */
  async fakeFailPayment(paymentId: string): Promise<void> {
    return this.orderPayments.fakeFailPayment(paymentId);
  }
  /** @see lookup#readPaymentAcrossTenants（阶段 11 拆分，逻辑见实现文件） */
  async readPaymentAcrossTenants(paymentId: string): Promise<Payment> {
    return this.lookup.readPaymentAcrossTenants(paymentId);
  }
  /** @see lookup#readPaymentWithReference（阶段 11 拆分，逻辑见实现文件） */
  async readPaymentWithReference(paymentId: string): Promise<{
    payment: Payment;
    reference: { id: string; number: string; amount: number };
  }> {
    return this.lookup.readPaymentWithReference(paymentId);
  }
  /** @see lookup#readPaymentById（阶段 11 拆分，逻辑见实现文件） */
  async readPaymentById(paymentId: string): Promise<Payment> {
    return this.lookup.readPaymentById(paymentId);
  }
  /** @see lookup#readOrderByNo（阶段 11 拆分，逻辑见实现文件） */
  async readOrderByNo(orderNo: string): Promise<ReadableOrder> {
    return this.lookup.readOrderByNo(orderNo);
  }
  /** @see lookup#readOrderById（阶段 11 拆分，逻辑见实现文件） */
  async readOrderById(orderId: string): Promise<ReadableOrder> {
    return this.lookup.readOrderById(orderId);
  }
  /** @see lookup#readConsumerOrder（阶段 11 拆分，逻辑见实现文件） */
  async readConsumerOrder(
    orderNo: string,
    customerId: string | null,
  ): Promise<ReadableOrder> {
    return this.lookup.readConsumerOrder(orderNo, customerId);
  }
  /** @see lookup#providerOf（阶段 11 拆分，逻辑见实现文件） */
  providerOf(channel: string): PaymentProvider {
    return this.lookup.providerOf(channel);
  }
  /** @see lookup#listEnabledChannels（阶段 11 拆分，逻辑见实现文件） */
  listEnabledChannels(): string[] {
    return this.lookup.listEnabledChannels();
  }
}
