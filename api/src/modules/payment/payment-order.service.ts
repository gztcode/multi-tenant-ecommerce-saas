import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { runForTenant } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PaymentLookupService } from './payment-lookup.service';
import { NormalizedWebhookEvent } from './payment-provider.interface';
import {
  CreatedInvoicePayment,
  CreatedPayment,
  InvoiceChargeResult,
} from './payment-types';
import { WebhookEventService } from './payment-webhook.service';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  InvoiceStatus,
  OrderStatus,
  Payment,
  PaymentKind,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

/**
 * OrderPaymentService —— 自 PaymentService（原 2600+ 行巨石）按职责拆出的部分（阶段 11）。
 *
 * 拆分是**纯机械搬移**：方法体与注释原样保留，只把跨组调用
 * （providerOf / find* / currentTenantId）改写为经 `this.lookup`（PaymentLookupService）。
 * 行为校验靠既有 959 条单测与 663 条 e2e；事务纪律靠 tx-boundary-scanner 的
 * 跨服务调用解析（this.svc.method 走类型解析，见 scanner 文档「形态 B」）。
 */
@Injectable()
export class OrderPaymentService {
  private readonly logger = new Logger(OrderPaymentService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly lookup: PaymentLookupService,
    private readonly webhookEvents: WebhookEventService,
  ) {}

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
    const tenantId = this.lookup.currentTenantId();
    const provider = this.lookup.providerOf(channel);

    // ⚠️ **必须校验归属**：订单号不是秘密（它出现在支付回调、商家后台的
    // 搜索框里）。不校验的话，别的消费者拿订单号就能看到金额并替他发起支付。
    const order = await this.lookup.readConsumerOrder(orderNo, customerId);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException('订单当前状态不允许支付');
    }

    // ⚠️ **金额只从订单读**（订单金额本身又是下单时从 SKU 算出来的）
    const amount = order.totalAmount;

    // ---- 已有支付单就复用（幂等）----
    const existing = await this.lookup.findPaymentByOrderAndChannel(
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
        const raced = await this.lookup.findPaymentByOrderAndChannel(
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

    const final = await this.lookup.readPaymentById(payment.id);
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
    const tenantId = this.lookup.currentTenantId();
    const provider = this.lookup.providerOf(channel);

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
    const tenantId = this.lookup.currentTenantId();
    const provider = this.lookup.providerOf(channel);

    // ⚠️ **能力门控必须在建支付单与调用渠道之前**（阶段 6a）：
    // 不支持「已授权扣款」的渠道建不出支付方式，也就扣不了款。
    // 先建支付单再报错会留下一条永远扣不成功的 PENDING 支付单。
    if (!provider.capabilities.authorizedCharge) {
      throw new ConflictException(
        `当前渠道 ${provider.channel} 不支持自动续费扣款`,
      );
    }

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

    if (result.status === 'SUCCESS') {
      // ⚠️ **成功也必须落状态**：不落的话「已有成功扣款」这个事实无法从
      // 本地识别，下一轮扫描会对同一账期重复扣款。
      // 条件更新只把 PENDING/FAILED 推进到 SUCCESS，不覆盖已有的终态；
      // 真正的重复扣款防护靠渠道按 referenceId 的幂等（支付单与
      // providerTxnId 不重置）—— 单副本假设，跨副本并发扫描未加锁。
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
        },
        data: { status: PaymentStatus.SUCCESS },
      });
    } else {
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
    const stored = await this.lookup.readPaymentById(payment.id);
    return {
      paymentId: payment.id,
      providerTxnId: stored.providerTxnId ?? result.providerTxnId,
      status: result.status,
    };
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
    const payment = await this.lookup.readPaymentAcrossTenants(paymentId);
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
    const order = await this.lookup.findOrderAcrossTenantsById(payment.orderId);

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

    const check = await this.webhookEvents.checkWebhookEvent(
      event,
      PaymentKind.ORDER,
    );
    if (!check.accepted || !check.tenantId) {
      return;
    }
    const inserted = await this.webhookEvents.insertEvent(
      event,
      PaymentKind.ORDER,
    );
    if (!inserted) {
      return;
    }
    await this.webhookEvents.applyEvent(event, check.tenantId);
  }
  /**
   * 假网关「确认支付」（**订阅支付**这条路）。
   *
   * ⚠️ 反查账单、比对金额、流转账单与订阅。
   */
  private async confirmInvoicePayment(payment: Payment): Promise<void> {
    const invoice = await this.lookup.findInvoiceAcrossTenantsById(
      payment.invoiceId,
    );

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

    const check = await this.webhookEvents.checkWebhookEvent(
      event,
      PaymentKind.SUBSCRIPTION,
    );
    if (!check.accepted || !check.tenantId) {
      return;
    }
    const inserted = await this.webhookEvents.insertEvent(
      event,
      PaymentKind.SUBSCRIPTION,
    );
    if (!inserted) {
      return;
    }
    await this.webhookEvents.applyEvent(
      event,
      check.tenantId,
      PaymentKind.SUBSCRIPTION,
    );
  }
  /**
   * 假网关「模拟支付失败」：支付单转 FAILED，订单不动。
   */
  async fakeFailPayment(paymentId: string): Promise<void> {
    const payment = await this.lookup.readPaymentAcrossTenants(paymentId);
    // ⚠️ 写操作仍然按**订单所属租户**做——
    // 跨租户读只是用来定位，写必须落在正确的租户作用域里。
    await runForTenant(payment.tenantId, async () => {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
    });
  }
}
