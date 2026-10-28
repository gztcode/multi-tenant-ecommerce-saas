import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InvoiceStatus,
  OrderStatus,
  Payment,
  PaymentKind,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  runForTenant,
  tenantContext,
} from '../../common/tenant/tenant-context';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { QueueService } from '../queue/queue.service';
import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import { OrderService } from '../order/order.service';
import { OrderInventoryService } from '../order/inventory.service';
import { CouponRedemptionService } from '../coupon/coupon-redemption.service';
import { InvoiceService } from '../billing/invoice.service';
import { CommissionService } from '../billing/commission.service';
import {
  NormalizedWebhookEvent,
  PaymentProvider,
} from './payment-provider.interface';
import { PAYMENT_PROVIDERS } from './payment.constants';

/** 发起支付的结果 */
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

/**
 * 订阅支付单创建后的返回（与订单侧的 `CreatedPayment` 分开）。
 *
 * ⚠️ **刻意不复用 `CreatedPayment`**：那个结构里的 `orderNo` 是订单专用字段，
 * 而账单的对外凭证叫 `number`（账单号）。塞进 `orderNo` 是命名漂移，
 * 而且那个结构里既没有 `kind` 也没有 `invoiceNumber`——调用方分不清
 * 拿到的是订单号还是账单号。
 *
 * ⚠️ 订单侧的 `CreatedPayment` **不动**：中转路由与 storefront 的前端都在用它，
 * 改它会波及阶段 3 已验收的链路。
 */
export interface CreatedInvoicePayment {
  paymentId: string;
  /** 跳支付页的地址 */
  payUrl: string;
  /** 应付金额（整数分） */
  amount: number;
  /** 账单号（对外凭证） */
  invoiceNumber: string;
}

/**
 * 自动续费扣款的结果。
 *
 * ⚠️ **调用方必须判 `status === 'SUCCESS'`，其余一律当失败路径处理**——
 * `status` 是**开放字符串**（各渠道的枚举不同，可能是 'PENDING' /
 * 'FAILED' / 'REQUIRE_ACTION'）。把它当成功落库，等于把「还没扣到钱」
 * 的账单标记成已付。
 *
 * ⚠️ **带 `paymentId`**：Task 5 要建支付单、落 `providerTxnId`、回写 `payments` 行，
 * 调用方拿不到 `paymentId` 就无法把「扣款成功」与「支付单落库失败」这种
 * 中间态表达出来。
 */
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

/**
 * webhook 事件的核对结果。
 *
 * `accepted` = 金额对得上、订单找得到，可以往下走。
 */
export interface WebhookEventCheck {
  accepted: boolean;
  /** 订单所属租户（**从订单反查**，不是从请求体里采信） */
  tenantId: string | null;
  orderId: string | null;
}

/**
 * 支付服务（阶段 3 Task 5）。
 *
 * ## 模块依赖方向：`payment` → `order`（单向）
 *
 * 本服务要流转订单（`PENDING_PAYMENT` → `PAID`、`PAID/SHIPPED` → `REFUNDED`），
 * 所以依赖 order 模块；order 模块**不**依赖 payment 模块——
 * 下单只锁 SKU、只算金额，发起支付是「建支付单 + 调 createPayment」，
 * 那是 payment 模块的活。方向反了会形成循环依赖。
 *
 * ## 三处要害
 *
 * 1. **验签通过才落库**（R1）：见 `webhook.controller.ts`。
 * 2. **金额先核对再流转**（R13）：见 `checkWebhookEvent`。
 * 3. **租户从订单反查**，绝不采信请求体里的 tenantId（R14）：
 *    见 `checkWebhookEvent`。
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly orderService: OrderService,
    private readonly inventory: OrderInventoryService,
    private readonly queue: QueueService,
    private readonly couponRedemption: CouponRedemptionService,
    // ⚠️ **`payment → billing` 是单向依赖** —— 与依赖图一致（不是环）。
    // 账单付清要延长订阅期，那件事由 billing 的 `InvoiceService` 做。
    private readonly billingInvoices: InvoiceService,
    // ⚠️ **抽佣流水的写入也在 billing 模块**（`payment → billing`，单向，不成环）。
    // 支付成功记一笔抽佣、退款成功记一笔冲回 —— 两者都必须与订单状态流转同事务。
    private readonly commission: CommissionService,
    @Inject(PAYMENT_PROVIDERS)
    private readonly providers: Map<string, PaymentProvider>,
  ) {}

  /** 当前租户 ID */
  currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  // ============================================================
  // 发起支付
  // ============================================================

  /**
   * 发起支付：建支付单 + 调渠道。
   *
   * ⚠️ **金额只从订单读**，请求体不接受任何金额字段。
   * 不核对的话，「付 1 分钱买 100 元商品」就是畅通的。
   *
   * ⚠️ **同一个订单同一渠道只能有一笔支付单**——`payments` 表的
   * `(orderId, channel)` 唯一索引兜底。重复发起时**返回已有的那笔**，
   * 而不是报错：用户点两次「去支付」是常事。
   */
  async createPayment(
    orderNo: string,
    channel: string,
    customerId: string | null,
  ): Promise<CreatedPayment> {
    const tenantId = this.currentTenantId();
    const provider = this.providerOf(channel);

    // ⚠️ **必须校验归属**：订单号不是秘密（它出现在支付回调、商家后台的
    // 搜索框里）。不校验的话，别的消费者拿订单号就能看到金额并替他发起支付。
    const order = await this.readConsumerOrder(orderNo, customerId);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException('订单当前状态不允许支付');
    }

    // ⚠️ **金额只从订单读**（订单金额本身又是下单时从 SKU 算出来的）
    const amount = order.totalAmount;

    // ---- 已有支付单就复用（幂等）----
    const existing = await this.findPaymentByOrderAndChannel(
      order.id,
      provider.channel,
    );
    if (existing) {
      return this.toCreatedPayment(existing, order.orderNo);
    }

    // ---- 建支付单 ----
    //
    // ⚠️ **先建支付单再调渠道**：渠道要拿到支付单 id 才能生成支付页面。
    // 调渠道失败时支付单留在 PENDING —— 那是「未支付」的正确语义，
    // 用户可以重新发起（唯一索引保证还是那一笔）。
    let payment: Payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          tenantId,
          orderId: order.id,
          channel: provider.channel,
          provider: provider.provider,
          status: PaymentStatus.PENDING,
          amount,
        },
      });
    } catch (error) {
      // ⚠️ 并发发起时另一个请求已经建了同一笔 → 查出来返回它。
      //
      // ⚠️ P2002 必须在**事务外**处理：唯一约束冲突让 PostgreSQL 事务进入
      // aborted 状态。这里本来就在事务外，重查也在 catch 里做。
      if (isUniqueViolation(error)) {
        const raced = await this.findPaymentByOrderAndChannel(
          order.id,
          provider.channel,
        );
        if (raced) {
          return this.toCreatedPayment(raced, order.orderNo);
        }
      }
      throw error;
    }

    const subject = order.items[0]?.productName ?? `订单 ${order.orderNo}`;
    const result = await provider.createPayment({
      referenceId: payment.id,
      referenceNo: order.orderNo,
      amount,
      subject,
    });

    // ⚠️ `providerTxnId` 走**条件更新**（where 带 providerTxnId: null）：
    // 并发回调可能已经把它写上了，那时不要覆盖。
    await this.prisma.payment.updateMany({
      where: { id: payment.id, providerTxnId: null },
      data: {
        providerTxnId: result.providerTxnId,
        rawResponse: result.payload as Prisma.InputJsonValue,
      },
    });

    const final = await this.readPaymentById(payment.id);
    return this.toCreatedPayment(final, order.orderNo);
  }

  /** 支付页面 URL：从渠道返回的 payload 里取 */
  private payUrlOf(payment: Payment): string {
    const raw = payment.rawResponse;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const url = (raw as Record<string, unknown>).payUrl;
      if (typeof url === 'string') {
        return url;
      }
    }
    // 渠道没给页面 URL 时按约定拼一个
    return `/api/v1/pay/fake/${payment.id}`;
  }

  private toCreatedPayment(payment: Payment, orderNo: string): CreatedPayment {
    return {
      paymentId: payment.id,
      orderNo,
      amount: payment.amount,
      channel: payment.channel,
      provider: payment.provider,
      status: payment.status,
      providerTxnId: payment.providerTxnId,
      payUrl: this.payUrlOf(payment),
      rawResponse: payment.rawResponse,
    };
  }

  // ============================================================
  // 订阅付款（阶段 5b Task 2 只留骨架，Task 5 补业务逻辑）
  // ============================================================

  /**
   * 建订阅的支付单并调渠道（**手动续费**走这条：跳页面付款）。
   *
   * ⚠️ **金额只从账单读**，请求体不接受任何金额字段。
   * ⚠️ **归属校验**：账单号不是秘密（它出现在渠道页面与对账单里），
   * 所以必须校验账单属于当前租户。
   *
   * ⚠️ **返回的是 `CreatedInvoicePayment` 而不是 `CreatedPayment`**：
   * 后者的 `orderNo` 是订单专用字段，账单号只能塞进 `invoiceNumber`。
   */
  async createInvoicePayment(
    invoiceNumber: string,
    channel: string,
  ): Promise<CreatedInvoicePayment> {
    const tenantId = this.currentTenantId();
    const provider = this.providerOf(channel);

    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId, number: invoiceNumber },
    });
    if (!invoice) {
      throw new NotFoundException('账单不存在');
    }
    // ⚠️ **`FAILED` 的账单也要允许支付**。
    //
    // `FAILED` 的语义是「上一次支付尝试失败了」——自动扣款失败时
    // 续费扫描会把它置成 FAILED，等商家手动补付。
    // 只放行 `OPEN` 的话，商家会永远付不了款：点「去支付」一直 409，
    // 订阅也永远不过期（钱交不出去、服务也开不了）。
    if (
      invoice.status !== InvoiceStatus.OPEN &&
      invoice.status !== InvoiceStatus.FAILED
    ) {
      throw new ConflictException('账单当前状态不允许支付');
    }

    // ⚠️ **同一个账单同一渠道只有一笔支付单** ——
    // `payments_invoice_channel_uniq` 兜底。已有的一笔：
    // - SUCCESS → 真的付过了 → 抛冲突
    // - PENDING / FAILED → 上一轮没成功 → **复用**它重试
    const { payment } = await this.obtainInvoicePayment(
      invoice.id,
      channel,
      provider.provider,
      invoice.amount,
      tenantId,
    );

    // ⚠️ **复用时要重新调渠道拿 payUrl** —— 旧的支付页面可能已经过期
    // （假网关的支付页 15 分钟失效）。
    const result = await provider.createPayment({
      referenceId: payment.id,
      referenceNo: invoice.number,
      amount: invoice.amount,
      subject: `订阅账单 ${invoice.number}`,
    });

    // ⚠️ **`providerTxnId` 不重置** —— 它是**渠道侧的幂等单号**
    // （假网关用 `payment.id` 当渠道交易号），同一个 id 重试
    // 不会被渠道扣两次。复用支付单时它已经有了，
    // 所以这里的条件更新（`providerTxnId: null`）不命中 → 保持原值。
    //
    // ⚠️ `rawResponse` **无条件刷新**（含复用场景）：旧的 payUrl 可能已过期，
    // 渠道给的新 payload 才是当前有效的那个。
    await this.prisma.payment.updateMany({
      where: { id: payment.id, providerTxnId: null },
      data: {
        providerTxnId: result.providerTxnId,
        rawResponse: result.payload as Prisma.InputJsonValue,
      },
    });
    await this.prisma.payment.updateMany({
      where: { id: payment.id },
      data: {
        rawResponse: result.payload as Prisma.InputJsonValue,
      },
    });

    return {
      paymentId: payment.id,
      payUrl: this.payUrlFromPayload(result.payload),
      amount: invoice.amount,
      invoiceNumber: invoice.number,
    };
  }

  /**
   * 拿到（必要时复用）某个账单在某渠道上的支付单。
   *
   * ## 三种情况
   *
   * | 已有的支付单 | 含义 | 动作 |
   * |---|---|---|
   * | 没有 | 从没付过 | 建一笔（`kind = SUBSCRIPTION`，status 默认 PENDING） |
   * | `SUCCESS` | **真的付过了** | 抛冲突（「该账单已支付」） |
   * | `PENDING` / `FAILED` | **上一轮没成功** | 复用它（重置为 PENDING） |
   *
   * ⚠️ **为什么不能把「已有支付单」等同于「已扣款」**：
   * 自动扣款失败时支付单会被留在 `PENDING`（渠道返回非 SUCCESS）。
   * 如果这里一律抛冲突，那次扫描之后**这个订阅在该渠道上永久无法再自动扣款**
   * —— 商家既不能自动续费，也只能拿到一个「该账单已有支付单」的 409。
   *
   * ⚠️ **复用而不是新建**：`(invoiceId, channel)` 上有唯一索引
   * （`payments_invoice_channel_uniq`），新建会撞。
   *
   * ⚠️ **`providerTxnId` 不重置**：它是**渠道侧的幂等单号**
   * （假网关用 `payment.id` 当渠道交易号），**同一个 id 重试不会被渠道扣两次**。
   * 置 null 反而会让渠道以为是一笔新交易 —— 那就是重复扣款。
   */
  private async obtainInvoicePayment(
    invoiceId: string,
    channel: string,
    providerName: string,
    amount: number,
    tenantId: string,
  ): Promise<{ payment: Payment; reused: boolean }> {
    const existing = await this.prisma.payment.findFirst({
      where: { invoiceId, channel },
    });

    if (!existing) {
      const payment = await this.prisma.payment.create({
        data: {
          tenantId,
          kind: PaymentKind.SUBSCRIPTION,
          invoiceId,
          channel,
          provider: providerName,
          amount,
        },
      });
      return { payment, reused: false };
    }

    if (existing.status === PaymentStatus.SUCCESS) {
      // ⚠️ **真的付过了** —— 不重复收钱
      throw new ConflictException('该账单已支付');
    }

    // ⚠️ **上一轮没成功**（PENDING / FAILED / REFUNDED / CLOSED）→ 复用
    await this.prisma.payment.updateMany({
      where: { id: existing.id },
      data: {
        status: PaymentStatus.PENDING,
        amount,
        updatedAt: new Date(),
      },
    });
    return {
      payment: { ...existing, status: PaymentStatus.PENDING },
      reused: true,
    };
  }

  /**
   * 从渠道返回的 payload 里取支付页面 URL。
   *
   * ⚠️ **只接受字符串**：payload 是渠道给的开放字典，`payUrl` 可能是
   * 数字或对象，直接 `String()` 会得到「[object Object]」这种没意义的地址。
   */
  private payUrlFromPayload(payload: Record<string, unknown>): string {
    const url = payload.payUrl;
    return typeof url === 'string' ? url : '';
  }

  /**
   * 自动续费的扣款（**已授权的支付方式直接扣**，不跳页面）。
   *
   * ⚠️ **幂等靠 `payments` 的 `(invoiceId, channel)` 唯一索引**：
   * 建支付单时撞了就不再扣第二次。
   *
   * ⚠️ **但「已有支付单」≠「已扣款」**：上一轮扣款失败时支付单会停在
   * `PENDING` / `FAILED`，那一次**没扣到钱**，所以**可以复用重试**。
   * 只有支付单已经是 `SUCCESS` 时才是「真付过了」，才抛冲突。
   *
   * ⚠️ **调用方必须判 `status === 'SUCCESS'`**——`status` 是开放字符串，
   * `'PENDING'` 不是成功。其余一律当失败路径处理。
   */
  async chargeInvoice(
    invoiceNumber: string,
    channel: string,
    paymentMethodToken: string,
  ): Promise<InvoiceChargeResult> {
    const tenantId = this.currentTenantId();
    const provider = this.providerOf(channel);

    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId, number: invoiceNumber },
    });
    if (!invoice) {
      throw new NotFoundException('账单不存在');
    }
    // ⚠️ **`FAILED` 的账单也允许再扣**：`FAILED` 的语义是
    // 「上一次支付尝试失败了」，重试是它的正常后续流程。
    // 只放行 `OPEN` 的话，商家自动扣款失败一次之后，
    // 这张账单**永远无法再自动续费**。
    if (
      invoice.status !== InvoiceStatus.OPEN &&
      invoice.status !== InvoiceStatus.FAILED
    ) {
      throw new ConflictException('账单当前状态不允许支付');
    }

    // ⚠️ **拿到（必要时复用）支付单**：
    // - 没有 → 建一笔
    // - 已 SUCCESS → 真付过了 → 抛冲突
    // - PENDING / FAILED → 上一轮没成功 → 复用重试
    const { payment } = await this.obtainInvoicePayment(
      invoice.id,
      channel,
      provider.provider,
      invoice.amount,
      tenantId,
    );

    const result = await provider.chargeAuthorized({
      referenceId: payment.id,
      referenceNo: invoice.number,
      amount: invoice.amount,
      subject: `订阅账单 ${invoice.number}`,
      paymentMethodToken,
    });

    // ⚠️ **`providerTxnId` 不重置** —— 它是**渠道侧的幂等单号**
    // （假网关用 `payment.id` 当渠道交易号），同一个 id 重试
    // 不会被渠道扣两次。复用支付单时它已经有了 → 条件更新不命中。
    await this.prisma.payment.updateMany({
      where: { id: payment.id, providerTxnId: null },
      data: { providerTxnId: result.providerTxnId },
    });

    if (result.status !== 'SUCCESS') {
      // ⚠️ **扣款没成功 → 支付单置 FAILED**。
      //
      // 不落这个状态的话，支付单永远停在 `PENDING`：
      // - 状态上看不出来「扣款失败了」
      // - 下次扫描复用它时无从判断上一轮到底扣没扣成功
      await this.prisma.payment.updateMany({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
    }

    // ⚠️ **返回库里真正存着的那个渠道交易号**。
    //
    // 复用支付单时，库里那个是**上一轮**的（条件更新不命中 → 保持原值），
    // 而渠道这次给的是新的。两者不一致时，**以库里的为准** ——
    // 那是渠道侧已经认识的那个幂等单号。
    const stored = await this.readPaymentById(payment.id);
    return {
      paymentId: payment.id,
      providerTxnId: stored.providerTxnId ?? result.providerTxnId,
      status: result.status,
    };
  }

  // ============================================================
  // webhook 事件的处理
  // ============================================================

  /**
   * 核对一个**已验签**的 webhook 事件：找订单 + 比对金额。
   *
   * ⚠️ **调用方必须已经验过签**。这个方法不验签——验签发生在
   * `provider.parseWebhook` 里，而**验签必须先于落库**（R1）。
   *
   * ## 顺序不能换（设计 §6.3）
   *
   * ```
   * webhook 到达 → 验签 → 查订单 → 比对金额
   *    ├─ 金额不等 → 拒绝，告警，人工介入
   *    └─ 金额相等 → 进幂等流程
   * ```
   *
   * ⚠️ **租户从业务单反查**（R14）：webhook 端点没有租户上下文
   * （渠道回调不带子域名），所以必须先按业务单号找到订单（或账单），
   * 拿到它的 tenantId。**绝不采信请求体里的 tenantId**——
   * 采信了就等于「构造回调指定别的租户」，能跨租户篡改订单。
   *
   * ⚠️ **kind 决定反查哪张单** —— 由 webhook 的**端点**决定，
   * 渠道适配器不需要猜「这笔是什么」。
   */
  async checkWebhookEvent(
    event: NormalizedWebhookEvent,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<WebhookEventCheck> {
    if (kind === PaymentKind.SUBSCRIPTION) {
      // ⚠️ **订阅分支**：反查账单（`referenceNo` 是账单号）、比对账单金额。
      const invoice = await this.findInvoiceAcrossTenants(event.referenceNo);
      if (!invoice) {
        this.logger.warn(
          `订阅回调找不到账单：${event.referenceNo}（事件 ${event.eventId}）`,
        );
        return { accepted: false, tenantId: null, orderId: null };
      }
      // ⚠️ **金额先核对**（护栏 M10）。不核对就流转，等于
      // 「付 1 分钱续一年的费」。
      if (event.amount !== invoice.amount) {
        this.logger.error(
          `订阅回调金额不符，拒绝流转：账单 ${invoice.number} ` +
            `应付 ${invoice.amount}，实付 ${event.amount}（事件 ${event.eventId}）`,
        );
        return { accepted: false, tenantId: invoice.tenantId, orderId: null };
      }
      return { accepted: true, tenantId: invoice.tenantId, orderId: null };
    }

    const order = await this.findOrderAcrossTenants(event.referenceNo);
    if (!order) {
      this.logger.warn(
        `支付回调找不到订单：${event.referenceNo}（事件 ${event.eventId}）`,
      );
      return { accepted: false, tenantId: null, orderId: null };
    }

    // ⚠️ **金额先核对**（R13）。不核对就流转，等于「付 1 分钱买 100 元商品」。
    if (event.amount !== order.totalAmount) {
      this.logger.error(
        `支付回调金额不符，拒绝流转：订单 ${order.orderNo} ` +
          `应付 ${order.totalAmount}，实付 ${event.amount}（事件 ${event.eventId}）`,
      );
      return { accepted: false, tenantId: order.tenantId, orderId: order.id };
    }

    return { accepted: true, tenantId: order.tenantId, orderId: order.id };
  }

  /**
   * 幂等落库：插入事件行。
   *
   * ⚠️ **必须在事务外调用**——P2002 让 PostgreSQL 事务进入 aborted 状态，
   * 在事务里 catch 之后继续查会报 `current transaction is aborted`。
   *
   * ⚠️ **必须在验签之后调用**——这是 R1 的兑现点：
   * 攻击者抢先用 eventId 占位的话，真实回调会被当成重复事件忽略，
   * 钱付了订单永不流转。
   *
   * @returns true = 应当处理（首次到达，或上次到达时**没处理完**）；
   *          false = 重复投递且已处理过
   */
  async insertEvent(event: NormalizedWebhookEvent): Promise<boolean> {
    try {
      await this.prisma.paymentWebhookEvent.create({
        data: {
          provider: event.provider,
          eventId: event.eventId,
          providerTxnId: event.providerTxnId,
          payload: {
            channel: event.channel,
            referenceNo: event.referenceNo,
            amount: event.amount,
            success: event.success,
          } as Prisma.InputJsonValue,
        },
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // ⚠️ **冲突时要看 `processedAt`，不能一律当「重复投递」跳过。**
      //
      // 事件行是唯一的幂等闸：首次到达时插进去，业务处理完再打上
      // `processedAt`。如果处理中途失败（死锁、瞬时故障、进程崩溃），
      // 事件行已经在库里而 `processedAt` 仍是 null——
      // 这时渠道重投同一个 eventId，若一律跳过，**这笔支付就永远丢了**
      // （没人会去扫这张表找未处理的事件）。
      //
      // 所以：`processedAt` 为 null = 上次没处理完 → **允许重新处理**。
      const existing = await this.prisma.paymentWebhookEvent.findFirst({
        where: { provider: event.provider, eventId: event.eventId },
        select: { processedAt: true },
      });
      if (existing && existing.processedAt === null) {
        this.logger.warn(
          `事件 ${event.eventId} 上次未处理完（processedAt 为空），允许重试`,
        );
        return true;
      }
      // 已处理过 → 真正的重复投递 → 什么都不做
      return false;
    }
  }

  /**
   * 投递 webhook 事件到队列。
   *
   * ⚠️ 任务里的 `tenantId` **来自订单反查**（见 `checkWebhookEvent`），
   * 绝不能取自客户端提交的内容——否则「重建上下文」本身就成了越权通道。
   *
   * ⚠️ **`kind` 必须一路带进队列**：消费端（`applyEvent`）要靠它决定
   * 反查哪张业务单（订单 / 账单）。少了它，订阅回调会被**无条件**当成订单回调
   * 去反查订单——查不到就静默丢掉，那笔续费的钱就没了。
   *
   * ⚠️ **jobId 用连字符**而不是冒号：BullMQ v6 拒绝含 `:` 的自定义 id
   * （`Custom Id cannot contain :`）。同一个 eventId 只排一个任务。
   */
  async enqueueWebhookEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<void> {
    try {
      await this.queue.add(
        PAYMENT_WEBHOOK_QUEUE,
        'payment',
        {
          tenantId,
          kind,
          eventId: event.eventId,
          provider: event.provider,
          channel: event.channel,
          providerTxnId: event.providerTxnId,
          referenceNo: event.referenceNo,
          amount: event.amount,
          success: event.success,
        },
        `webhook-${event.provider}-${event.eventId}`,
      );
    } catch (cause) {
      // ⚠️ 支付已入库。报失败会诱导用户重复支付。
      //    通知丢失的补偿机制不在本阶段范围（见设计文档 L1）。
      this.logger.error(
        `支付通知投递失败：provider=${event.provider} eventId=${event.eventId}`,
        cause,
      );
    }
  }

  /**
   * 在**调用方的事务内**应用一个已落库的支付事件。
   *
   * ⚠️ 「订单转 PAID」与「记 DEDUCT 流水」必须同生共死——
   * 分成两个事务的话，流水记失败时订单已经是 PAID 而流水没记，
   * 账目出现缺口，而且没法自动补。
   */
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
    if (!event.success) {
      // ---- 失败分支：支付单转 FAILED，订单不动 ----
      await tx.payment.updateMany({
        where: {
          orderId: order.id,
          channel: event.channel,
          status: PaymentStatus.PENDING,
        },
        data: { status: PaymentStatus.FAILED },
      });
      return;
    }

    // ---- 支付单置 SUCCESS（条件更新）----
    //
    // ⚠️ 条件更新（where 带 status）而不是「先查后改」：
    // 已 SUCCESS 的支付单收到 SUCCESS 事件时**什么都不做**，
    // 并发投递时也不会重复处理。
    //
    // ⚠️ **这里不再写 `providerTxnId`**——它由 `attachProviderTxnId`
    // 在业务事务**之外**写好了。理由见那个方法的注释：唯一约束冲突
    // 会让 PostgreSQL 事务进入 aborted 状态，事务内撞了整笔业务
    // （订单流转 + DEDUCT 流水）会一起回滚，而队列默认不重试、
    // webhook 早已返回 200 —— 结果是「用户付了钱、订单永远卡在
    // PENDING_PAYMENT、库存永远被预占」。
    const paid = await tx.payment.updateMany({
      where: {
        orderId: order.id,
        channel: event.channel,
        status: PaymentStatus.PENDING,
      },
      data: {
        status: PaymentStatus.SUCCESS,
      },
    });

    if (paid.count === 0) {
      const existing = await tx.payment.findMany({
        where: { orderId: order.id, channel: event.channel },
      });
      if (existing.length === 0) {
        this.logger.warn(
          `支付回调找不到支付单：订单 ${order.orderNo}（事件 ${event.eventId}）`,
        );
        return;
      }
      if (existing[0].status !== PaymentStatus.SUCCESS) {
        // 支付单是 FAILED / REFUNDED / CLOSED —— 订单不能跟着转。
        this.logger.warn(
          `支付单状态为 ${existing[0].status}，不流转订单：` +
            `订单 ${order.orderNo}（事件 ${event.eventId}）`,
        );
        return;
      }
      // 已经是 SUCCESS（重复投递）→ 继续往下走，
      // 让订单的转移与流水走一遍幂等路径（条件更新会挡住重复）。
    }

    // ---- 订单 PENDING_PAYMENT → PAID（**条件更新**，R5）----
    //
    // ⚠️ **条件更新是 R5 的支付侧**：支付回调与超时释放都用
    // `status = 'PENDING_PAYMENT'` 的条件更新，数据库保证只有一方能赢。
    // 少了这一侧，超时释放与支付并发时仍会超卖。
    //
    // ⚠️ **支付时间用数据库的时钟**（护栏 M15，与退款路径、账单路径一致）：
    // 报表把 `Order.paidAt` 与 `Order.refundedAt` 聚到了一起，
    // 两个时间字段的时钟口径必须一致 —— 一个用应用时钟、一个用数据库时钟，
    // 多副本部署时各机器时钟有偏差，边界时刻会漏计或错计。
    const paidAt = await this.prisma.databaseNow();
    const won = await this.orderService.transitionInTx(
      tx,
      order.id,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
      { paidAt },
    );
    if (!won) {
      // 订单已经不是 PENDING_PAYMENT（已支付 / 已超时关闭 / 已取消）。
      // 事件仍然记下了（幂等表已插入），但订单不再流转。
      this.logger.warn(
        `订单 ${order.orderNo} 当前不是 PENDING_PAYMENT，不流转（事件 ${event.eventId}）`,
      );
      return;
    }

    // ---- 赢了才记 DEDUCT 流水（quantity=-qty，**库存不变**）----
    //
    // ⚠️ 预占时库存已经扣过了，这里只是把「预占」转成「已售」。
    // 所以 quantity = -qty 但 stockBefore == stockAfter（设计 §5.2）。
    await this.inventory.deductInTx(
      tx,
      order.id,
      order.items.map((item) => ({
        skuId: item.skuId,
        quantity: item.quantity,
      })),
    );

    // ---- **确认券的核销**（设计文档 §5.3）----
    //
    // ⚠️ **必须在同一个事务里**：订单转 PAID 与券的核销确认同生共死。
    // 分成两个事务的话，订单已支付而券还停在 RESERVED——
    // 券的额度被占着，用户看到「我的券」里它还在却用不了。
    //
    // ⚠️ **与取消路径互斥**：支付成功后订单不再是 PENDING_PAYMENT，
    // 取消路径的条件更新会拦住它。两条路径都靠「核销状态的条件更新」
    // 保证只生效一次。
    await this.couponRedemption.markUsedInTx(tx, order.id);

    // ---- 记一笔抽佣流水（阶段 5e）----
    //
    // ⚠️ **必须在同一个事务里**：订单转 PAID 与「这笔单赚到了抽佣」同生共死。
    // 分成两个事务的话，订单已支付而抽佣没记上 → 平台少收钱、账对不上。
    //
    // ⚠️ **`occurredAt` 用 `paidAt`** —— 与平台收入报表的归期口径逐字一致
    // （报表按 `Order.paidAt` 聚合抽佣）。
    //
    // ⚠️ **重复投递不会写第二行**：订单的状态条件更新在上面已经挡住了
    // （`won` 为 false 时就 return 了），这里压根走不到。
    await this.commission.recordCommissionInTx(tx, order, paidAt);
  }

  /** 标记事件已处理 */
  async markEventProcessed(event: NormalizedWebhookEvent): Promise<void> {
    await this.prisma.paymentWebhookEvent.updateMany({
      where: { provider: event.provider, eventId: event.eventId },
      data: { processedAt: new Date() },
    });
  }

  /**
   * 按订单号查订单（**跨租户**）。
   *
   * ⚠️ webhook 端点**没有租户上下文**——渠道回调不带子域名。
   * 所以这一步必须绕开租户作用域查询：查不到就是「订单不存在」。
   *
   * ⚠️ 找到订单**只用来反查租户**，之后的一切操作都在那个租户的上下文里，
   * 而且**只按订单 id 操作**——绝不采信请求体里的 tenantId（R14）。
   */
  private async findOrderAcrossTenants(orderNo: string): Promise<{
    id: string;
    orderNo: string;
    tenantId: string;
    totalAmount: number;
    items: Array<{ skuId: string; quantity: number }>;
  } | null> {
    // ⚠️ 用 `platformScope()`：显式的跨租户读取必须收敛到可审计的少数几处。
    return tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.order.findMany({
        where: { orderNo },
        include: { items: true },
      });
      const order = rows[0];
      if (!order) {
        return null;
      }
      return {
        id: order.id,
        orderNo: order.orderNo,
        tenantId: order.tenantId,
        totalAmount: order.totalAmount,
        items: order.items.map((item) => ({
          skuId: item.skuId,
          quantity: item.quantity,
        })),
      };
    });
  }

  /**
   * 按账单号查账单（**跨租户**）。
   *
   * ⚠️ webhook 端点**没有租户上下文**——渠道回调不带子域名。
   * 所以订阅回调必须先按账单号找到账单，拿到它的 tenantId。
   * **绝不采信请求体里的 tenantId**（R14）。
   */
  private async findInvoiceAcrossTenants(invoiceNumber: string): Promise<{
    id: string;
    number: string;
    tenantId: string;
    amount: number;
  } | null> {
    // ⚠️ 用 `platformScope()`：显式的跨租户读取必须收敛到可审计的少数几处。
    return tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.invoice.findMany({
        where: { number: invoiceNumber },
      });
      const invoice = rows[0];
      if (!invoice) {
        return null;
      }
      return {
        id: invoice.id,
        number: invoice.number,
        tenantId: invoice.tenantId,
        amount: invoice.amount,
      };
    });
  }

  /**
   * 在指定租户的上下文里执行一段逻辑。
   *
   * ⚠️ 队列消费是**跨进程边界**的，AsyncLocalStorage 的上下文不跟着走，
   * 所以这里显式重建（见 `common/tenant/tenant-context.ts` 的注释）。
   */
  async runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runForTenant(tenantId, fn);
  }

  // ============================================================
  // 退款
  // ============================================================

  /**
   * 整单退款。
   *
   * ⚠️ **退款不回补库存**——货已经发出去了，退的是钱不是库存。
   * 「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
   * 这个取舍要在商家后台的文案里说明。
   */
  async refund(orderNo: string, reason: string): Promise<void> {
    const order = await this.readOrderByNo(orderNo);
    if (
      order.status !== OrderStatus.PAID &&
      order.status !== OrderStatus.SHIPPED
    ) {
      throw new ConflictException('订单当前状态不允许退款');
    }

    // 支付单：该订单的**已成功**的那笔
    const payments = await this.prisma.payment.findMany({
      where: { orderId: order.id, status: PaymentStatus.SUCCESS },
    });
    const payment = payments[0];
    if (!payment) {
      throw new ConflictException('订单没有可退款的支付单');
    }

    const provider = this.providerOf(payment.channel);

    // ⚠️ **先抢闸门，再调渠道**。
    //
    // 两个并发的退款请求不能都去调渠道——本地状态只有第一个能改成
    // REFUNDED（条件更新挡住第二个），但**渠道已经被调了两次**。
    // 假网关的退款是 no-op 所以看不出来，接真渠道就是**退两次钱**，
    // 而本地账看着是对的——那是最坏的形态：本地账对得上、外部账对不上。
    //
    // 这一步把「能不能退」变成一次原子的判定：抢到闸门的那个才去调渠道。
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.SUCCESS },
      data: { status: PaymentStatus.REFUNDED },
    });
    if (claimed.count === 0) {
      throw new ConflictException('该订单已在退款中');
    }

    // ⚠️ **先调渠道退款**，成功了才改本地状态。
    // 反过来的话，渠道退款失败时本地已经标成 REFUNDED，
    // 钱没退出去但账面显示退了——对账全乱。
    //
    // `payment.id` 是**渠道侧的幂等单号**（真渠道都支持）：
    // 即便闸门被绕过、渠道被调了两次，也只会退一次钱。
    let result;
    try {
      result = await provider.refund(payment.id, payment.amount, reason);
    } catch (error) {
      // 渠道调用失败 → **把闸门还回去**，让商家能重试
      await this.releaseRefundClaim(payment.id);
      throw error;
    }
    if (result.status !== 'REFUNDED' && result.status !== 'SUCCESS') {
      await this.releaseRefundClaim(payment.id);
      throw new BadRequestException('渠道拒绝了本次退款');
    }

    // ⚠️ **退款时间用数据库的时钟**（护栏 M15，与本仓库其它地方一致）：
    // 多副本部署时各机器的时钟有偏差，边界时刻会摇摆。
    const refundedAt = await this.prisma.databaseNow();

    await this.prisma.$transaction(
      async (tx) => {
        // 订单转 REFUNDED（条件更新，走 order 模块的转移表校验）
        //
        // ⚠️ **不碰库存、不记 RELEASE 流水**——货已发出。
        //
        // ⚠️ **这里不重算优惠是有意的，不是漏了**（M13）：
        // 退款额读的是 `order.totalAmount`，而它就是下单时算出的**实付额**
        // （已含券与活动的减免）。所以退款额天然等于实付额，
        // 不会多退也不会少退。
        //
        // **为什么不重算**：券的规则将来可能改，改了就对不上历史账（M12）。
        // 历史订单存的是**快照**（原价 / 活动减免 / 券减免各字段），
        // 退款读快照而不是重算——这正是 M12 的兑现点。
        //
        // ⚠️ **顺手记下退款时间**（阶段 5b Task 1 加的 `Order.refundedAt`）：
        // 报表的「退款冲回」要按**退款发生的期间**归期，
        // 不是按订单支付的期间 —— 阶段 3 的退款没记这个时间，
        // 补上之前冲回那一栏永远是 0。
        const won = await this.orderService.transitionInTx(
          tx,
          order.id,
          order.status,
          OrderStatus.REFUNDED,
          { refundedAt },
        );
        if (!won) {
          throw new ConflictException('订单当前状态不允许退款');
        }

        // ---- 记一笔冲回流水（阶段 5e）----
        //
        // ⚠️ **金额取负**（`recordReversalInTx` 内部处理）——
        // 冲回是「平台要还回去的钱」，与抽佣行反向，单列求和即净额。
        //
        // ⚠️ **`occurredAt` 用 `refundedAt`** —— 与报表的冲回归期口径一致。
        //
        // ⚠️ **必须在同一个事务里**：订单转 REFUNDED 与「平台还回去了一笔抽佣」
        // 同生共死。分成两个事务的话，退款成功而冲回没记上 → 平台多收钱。
        await this.commission.recordReversalInTx(tx, order, refundedAt);
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * 渠道退款失败时，把「退款闸门」还回去。
   *
   * 闸门是支付单的状态 `SUCCESS → REFUNDED`。渠道没退成功却留着
   * REFUNDED 的话，这笔退款就永远做不了（条件更新再也抢不到闸门），
   * 商家只能干瞪眼。
   */
  private async releaseRefundClaim(paymentId: string): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.REFUNDED },
      data: { status: PaymentStatus.SUCCESS },
    });
  }

  // ============================================================
  // 假网关的内部操作
  // ============================================================

  /**
   * 假网关「确认支付」：置支付单 SUCCESS 并**主动调用同一段 webhook 处理逻辑**。
   *
   * ⚠️ **按 `kind` 分流**：订单支付走订单那条路，订阅支付走订阅那条路
   * （Task 5 补）。
   */
  async fakeConfirmPayment(paymentId: string): Promise<void> {
    const payment = await this.readPaymentAcrossTenants(paymentId);
    if (payment.kind === PaymentKind.SUBSCRIPTION) {
      await this.confirmInvoicePayment(payment);
      return;
    }
    await this.confirmOrderPayment(payment);
  }

  /**
   * 假网关「确认支付」（**订单支付**这条路）。
   *
   * ⚠️ **直接调处理逻辑，而不是发 HTTP 请求到 webhook 端点**——
   * 「服务调自己」会引入自我依赖（容器编排里还要处理网络地址问题）。
   * 直接调用同一段逻辑，既真实（幂等与状态机都被走到）又不脆弱。
   */
  private async confirmOrderPayment(payment: Payment): Promise<void> {
    const order = await this.findOrderAcrossTenantsById(payment.orderId);

    // ⚠️ 走的是**与 webhook 端点完全相同**的那条路：
    // 验签后的核对 → 幂等落库 → 业务流转。
    // 区别只是这里省掉了「验签」——事件是自己发的，不必自己签。
    const event: NormalizedWebhookEvent = {
      provider: payment.provider,
      channel: payment.channel,
      // ⚠️ 事件 id 用支付单 id 派生：同一次支付重复点「确认支付」
      // 落进幂等表的还是同一行。
      eventId: `fake-${payment.id}`,
      providerTxnId: payment.providerTxnId ?? payment.id,
      referenceNo: order.orderNo,
      amount: payment.amount,
      success: true,
    };

    const check = await this.checkWebhookEvent(event, PaymentKind.ORDER);
    if (!check.accepted || !check.tenantId) {
      return;
    }
    const inserted = await this.insertEvent(event);
    if (!inserted) {
      return;
    }
    await this.applyEvent(event, check.tenantId);
  }

  /**
   * 假网关「确认支付」（**订阅支付**这条路）。
   *
   * ⚠️ 反查账单、比对金额、流转账单与订阅。
   */
  private async confirmInvoicePayment(payment: Payment): Promise<void> {
    const invoice = await this.findInvoiceAcrossTenantsById(payment.invoiceId);

    // ⚠️ 走的是**与 webhook 端点完全相同**的那条路：
    // 验签后的核对 → 幂等落库 → 业务流转。
    // 区别只是这里省掉了「验签」——事件是自己发的，不必自己签。
    const event: NormalizedWebhookEvent = {
      provider: payment.provider,
      channel: payment.channel,
      eventId: `fake-${payment.id}`,
      providerTxnId: payment.providerTxnId ?? payment.id,
      referenceNo: invoice.number,
      amount: payment.amount,
      success: true,
    };

    const check = await this.checkWebhookEvent(event, PaymentKind.SUBSCRIPTION);
    if (!check.accepted || !check.tenantId) {
      return;
    }
    const inserted = await this.insertEvent(event);
    if (!inserted) {
      return;
    }
    await this.applyEvent(event, check.tenantId, PaymentKind.SUBSCRIPTION);
  }

  /**
   * 应用一个已落库的支付事件（幂等落库之后的那段业务流转）。
   *
   * ⚠️ **订单转 PAID 与记 DEDUCT 流水在同一个事务里**。
   *
   * ⚠️ `tenantId` 是**调用方给的**——队列消费者传的是任务里的那个
   * （由 webhook 端点从订单反查后签发，可信源）。
   *
   * ⚠️ 订单的查询**在这个租户的作用域内**做（租户扩展自动附加
   * `tenantId` 条件）：租户不对就查不到订单，什么都不做。
   * 这正是 R14 的兑现点——采信了别的租户，订单就**转不动**。
   *
   * ## `kind` 决定反查哪张业务单
   *
   * ⚠️ **不能省**：`referenceNo` 在订单路径是订单号、在订阅路径是账单号。
   * 少了 `kind` 就只能反查订单——订阅回调会**静默失败**（查不到订单 → 记告警 →
   * 正常返回 → 事件被标成已处理 → 这笔续费的钱永远不流转）。
   *
   * ⚠️ **默认值是 `ORDER`**：既有调用方（阶段 3 的 e2e 直接调本方法）
   * 只传两个参数，行为必须与之前**完全一致**。
   */
  async applyEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<void> {
    // ⚠️ **按 kind 分流**：订阅那条路先走，订单那条路的逻辑一字不改。
    if (kind === PaymentKind.SUBSCRIPTION) {
      await runForTenant(tenantId, async () => {
        await this.applySubscriptionEvent(event, tenantId, kind);
      });
      await this.markEventProcessed(event);
      return;
    }

    await runForTenant(tenantId, async () => {
      // ⚠️ 用**返回 null** 的那个变体：查不到订单时**不抛异常**——
      // 抛了会让 BullMQ 把任务判为失败，而重试也不会让它变对
      // （订单确实不在这个租户下）。
      const order = await this.findOrderByNo(event.referenceNo);
      if (!order) {
        this.logger.warn(
          `租户 ${tenantId} 下找不到订单 ${event.referenceNo}（事件 ${event.eventId}）`,
        );
        return;
      }

      // ⚠️ **先把渠道交易号写进支付单，且在业务事务之外**。
      //
      // `(provider, providerTxnId)` 唯一索引是幂等的第二道防线
      // （R2：同一笔渠道交易不能落成两条支付单）。但它冲突时抛的 P2002
      // **不能发生在业务事务里**——唯一约束冲突会让 PostgreSQL 事务进入
      // aborted 状态，订单流转与 DEDUCT 流水会一起回滚；而队列默认
      // 不重试、webhook 早已返回 200，渠道也不会再投 ——
      // 结果是「用户付了钱、订单永远卡在 PENDING_PAYMENT、
      // 库存永远被预占」。
      //
      // 放到事务外，冲突就只是一个**业务结果**：「这笔渠道交易已经
      // 落到别的支付单上了」，拒绝流转 + 告警，正常返回。
      const attached = await this.attachProviderTxnId(order, event);
      if (!attached) {
        return;
      }

      await this.prisma.$transaction(
        async (tx) => {
          await this.applyEventInTx(tx, event, order);
        },
        { maxWait: 10_000, timeout: 10_000 },
      );
    });
    await this.markEventProcessed(event);
  }

  /**
   * 处理订阅付款的业务流转（幂等落库之后的那段）。
   *
   * ⚠️ **金额必须与账单一致**（护栏 M10）：不一致就拒绝 ——
   * 付了 A 金额、开通了 B 金额的套餐，是最典型的资金漏洞。
   * ⚠️ **租户从账单反查**（不采信请求体里的 tenantId，阶段 3 的 R14）。
   */
  private async applySubscriptionEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
    kind: PaymentKind,
  ): Promise<void> {
    // ⚠️ `kind` 只用于把「这条是订阅回调」写进日志——
    // 分流已经在 `applyEvent` 里做过了。
    this.logger.debug(
      `处理订阅付款事件（${kind}）：${event.referenceNo}（事件 ${event.eventId}）`,
    );

    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId, number: event.referenceNo },
    });
    if (!invoice) {
      this.logger.warn(
        `订阅回调找不到账单：${event.referenceNo}（事件 ${event.eventId}）`,
      );
      return;
    }
    // ⚠️ **金额核对**（护栏 M10）
    if (invoice.amount !== event.amount) {
      this.logger.error(
        `订阅回调金额不符：账单 ${invoice.amount}，事件 ${event.amount}`,
      );
      return;
    }
    if (!event.success) {
      await this.prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.OPEN },
        data: { status: InvoiceStatus.FAILED },
      });
      return;
    }
    // ⚠️ **付清 → 延长周期**（条件更新，重复回调不会延长两次）
    await this.billingInvoices.markInvoicePaid(invoice.id);
  }

  /**
   * 把渠道给的交易号写进支付单。
   *
   * @returns true = 可以继续流转订单；
   *          false = 这笔渠道交易已被**别的**支付单占用，拒绝流转
   */
  private async attachProviderTxnId(
    order: { id: string; orderNo: string },
    event: NormalizedWebhookEvent,
  ): Promise<boolean> {
    if (!event.providerTxnId) {
      return true;
    }

    // 1. 同一笔渠道交易是否已被**别的**支付单占用？
    //
    // ⚠️ 用 `NOT: { orderId }` 而不是比较 paymentId：同一订单同一渠道
    // 只有一笔支付单，冲突的必然是**另一个订单**的支付单。
    const conflicting = await this.prisma.payment.findFirst({
      where: {
        provider: event.provider,
        providerTxnId: event.providerTxnId,
        NOT: { orderId: order.id },
      },
    });
    if (conflicting) {
      this.logger.error(
        `渠道交易 ${event.providerTxnId} 已落到另一个订单的支付单上，` +
          `拒绝流转订单 ${order.orderNo}（事件 ${event.eventId}）`,
      );
      return false;
    }

    // 2. 写进支付单（**覆盖建单时写的占位值**）
    //
    // ⚠️ 这里**必须覆盖**：建单时写的那个不是渠道的真交易号
    // （假网关写的是 payment.id 这个本地 id），webhook 带来的才是。
    // 不覆盖的话，索引里存的就是占位值——
    // `(provider, providerTxnId)` 就拦不住「同一笔渠道交易重放到另一个订单」。
    //
    // 覆盖之所以安全，是因为上面已经查过冲突了：这一笔渠道交易
    // 没有落到别的订单上。
    try {
      await this.prisma.payment.updateMany({
        where: {
          orderId: order.id,
          channel: event.channel,
          status: PaymentStatus.PENDING,
        },
        data: { providerTxnId: event.providerTxnId },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // ⚠️ 并发撞唯一索引：这里**不在业务事务里**，所以事务没有被
      // abort，重查一次就能判断到底冲不冲突。
      const stillConflicting = await this.prisma.payment.findFirst({
        where: {
          provider: event.provider,
          providerTxnId: event.providerTxnId,
          NOT: { orderId: order.id },
        },
      });
      if (stillConflicting) {
        this.logger.error(
          `渠道交易 ${event.providerTxnId} 已落到另一个订单的支付单上，` +
            `拒绝流转订单 ${order.orderNo}（事件 ${event.eventId}）`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * 假网关「模拟支付失败」：支付单转 FAILED，订单不动。
   */
  async fakeFailPayment(paymentId: string): Promise<void> {
    const payment = await this.readPaymentAcrossTenants(paymentId);
    // ⚠️ 写操作仍然按**订单所属租户**做——
    // 跨租户读只是用来定位，写必须落在正确的租户作用域里。
    await runForTenant(payment.tenantId, async () => {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
    });
  }

  /**
   * 按 id 读支付单（**跨租户**）。
   *
   * ⚠️ 只给「渠道侧」的场景用（假网关的支付页面）。
   * 渠道回调不带子域名，没有租户上下文——这里显式走 `platformScope()`。
   *
   * ⚠️ **只用来定位**：拿到 tenantId 之后的写操作必须在那个租户的上下文里做。
   */
  async readPaymentAcrossTenants(paymentId: string): Promise<Payment> {
    const payment = await tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.payment.findMany({
        where: { id: paymentId },
      });
      return rows[0] ?? null;
    });
    if (!payment) {
      throw new NotFoundException('支付单不存在');
    }
    return payment;
  }

  /**
   * 读支付单与它引用的业务单（**跨租户**）。
   *
   * ⚠️ 渠道侧场景用（渠道的请求不带子域名，租户由支付单自己带）。
   * ⚠️ **按 `kind` 分支**：订单支付读订单，订阅支付读账单。
   */
  async readPaymentWithReference(paymentId: string): Promise<{
    payment: Payment;
    reference: { id: string; number: string; amount: number };
  }> {
    const payment = await this.readPaymentAcrossTenants(paymentId);

    if (payment.kind === PaymentKind.SUBSCRIPTION) {
      const invoice = await this.findInvoiceAcrossTenantsById(
        payment.invoiceId,
      );
      return {
        payment,
        reference: {
          id: invoice.id,
          number: invoice.number,
          amount: invoice.amount,
        },
      };
    }

    const order = await this.findOrderAcrossTenantsById(payment.orderId);
    return {
      payment,
      reference: {
        id: order.id,
        number: order.orderNo,
        amount: order.totalAmount,
      },
    };
  }

  /**
   * 按 id 读账单（**跨租户**）。
   *
   * ⚠️ 与 `readPaymentAcrossTenants` 同理：渠道侧场景用
   * （假网关的支付页面、假网关的「确认支付」）。
   *
   * ⚠️ **`invoiceId` 可空**（`payments.invoiceId` 在阶段 5b 变成可空——
   * 订单支付单没有账单）。传 null 表示「这笔支付单不指向账单」，
   * 直接当「账单不存在」处理。
   */
  private async findInvoiceAcrossTenantsById(
    invoiceId: string | null,
  ): Promise<{
    id: string;
    number: string;
    tenantId: string;
    amount: number;
  }> {
    if (!invoiceId) {
      throw new NotFoundException('账单不存在');
    }
    const invoice = await tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.invoice.findMany({
        where: { id: invoiceId },
      });
      return rows[0] ?? null;
    });
    if (!invoice) {
      throw new NotFoundException('账单不存在');
    }
    return {
      id: invoice.id,
      number: invoice.number,
      tenantId: invoice.tenantId,
      amount: invoice.amount,
    };
  }

  /**
   * 按 id 读订单（**跨租户**）。
   *
   * ⚠️ 与 `readPaymentAcrossTenants` 同理：渠道侧场景用。
   *
   * ⚠️ `orderId` **可空**（`payments.orderId` 在阶段 5b 变成可空——
   * 订阅支付单没有订单）。传 null 表示「这笔支付单不指向订单」，
   * 直接当「订单不存在」处理。
   */
  private async findOrderAcrossTenantsById(orderId: string | null): Promise<{
    id: string;
    orderNo: string;
    tenantId: string;
    totalAmount: number;
  }> {
    if (!orderId) {
      throw new NotFoundException('订单不存在');
    }
    const order = await tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.order.findMany({
        where: { id: orderId },
      });
      return rows[0] ?? null;
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return {
      id: order.id,
      orderNo: order.orderNo,
      tenantId: order.tenantId,
      totalAmount: order.totalAmount,
    };
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 读支付单（租户作用域） */
  async readPaymentById(paymentId: string): Promise<Payment> {
    const rows = await this.prisma.payment.findMany({
      where: { id: paymentId },
    });
    const payment = rows[0];
    if (!payment) {
      throw new NotFoundException('支付单不存在');
    }
    return payment;
  }

  /** 读订单（租户作用域） */
  async readOrderByNo(orderNo: string): Promise<ReadableOrder> {
    const order = await this.findOrderByNo(orderNo);
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /**
   * 找订单（租户作用域，查不到返回 null）。
   *
   * ⚠️ 租户扩展会自动附加 `tenantId` 条件——所以**租户不对就查不到**。
   * 这正是 R14 的兑现点：采信了请求体里的别的租户，订单就转不动。
   */
  private async findOrderByNo(orderNo: string): Promise<ReadableOrder | null> {
    return this.findOrder({ orderNo });
  }

  /** 读订单（按 id，租户作用域） */
  async readOrderById(orderId: string): Promise<ReadableOrder> {
    const order = await this.findOrder({ id: orderId });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /**
   * 读消费者的订单（含订单项）。
   *
   * ⚠️ 必须带 `customerId` 条件：不然换个消费者拿订单号就能看别人的订单
   * （订单号会出现在支付回调、商家后台搜索框里，不是秘密）。
   */
  async readConsumerOrder(
    orderNo: string,
    customerId: string | null,
  ): Promise<ReadableOrder> {
    if (!customerId) {
      throw new UnauthorizedException('支付操作需要登录');
    }
    const order = await this.findOrder({ orderNo, customerId });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /**
   * 按条件找订单（租户作用域，查不到返回 null）。
   *
   * ⚠️ 三种读法（按订单号 / 按 id / 按订单号 + 归属）都走这里——
   * 免得「多写一遍 where」时漏掉某个字段。
   */
  private async findOrder(where: {
    orderNo?: string;
    id?: string;
    customerId?: string;
  }): Promise<ReadableOrder | null> {
    const rows = await this.prisma.order.findMany({
      where,
      include: { items: true },
    });
    const order = rows[0];
    if (!order) {
      return null;
    }
    return {
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      totalAmount: order.totalAmount,
      tenantId: order.tenantId,
      commissionRate: order.commissionRate,
      commissionAmount: order.commissionAmount,
      items: order.items.map((item) => ({
        skuId: item.skuId,
        quantity: item.quantity,
        productName: item.productName,
      })),
    };
  }

  /** 找某订单某渠道的支付单 */
  private async findPaymentByOrderAndChannel(
    orderId: string,
    channel: string,
  ): Promise<Payment | null> {
    const rows = await this.prisma.payment.findMany({
      where: { orderId, channel },
    });
    return rows[0] ?? null;
  }

  // ============================================================
  // 渠道
  // ============================================================

  /** 按渠道名取 provider */
  providerOf(channel: string): PaymentProvider {
    const provider = this.providers.get(channel);
    if (!provider) {
      throw new NotFoundException('未知的支付渠道');
    }
    return provider;
  }

  /** 全部已注册的渠道 */
  listChannels(): string[] {
    return [...this.providers.keys()];
  }
}

/** 读出来的订单摘要 */
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

/**
 * 是不是 Prisma 的唯一约束冲突（P2002）。
 *
 * 用 `error.code === 'P2002'` 而不是 `instanceof PrismaClientKnownRequestError`：
 * `@prisma/client` 在 CJS/ESM 混载或多处 require 时会得到不同的模块实例，
 * instanceof 于是恒为 false（与 common/errors/unique-constraint.ts 同一理由）。
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
