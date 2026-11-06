import { isUniqueViolation } from '../../common/errors/unique-constraint';
import {
  BadRequestException,
  ConflictException,
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
  platformScope,
  runForTenant,
  tenantContext,
} from '../../common/tenant/tenant-context';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { transactionOptions } from '../../common/db/transaction-options';
import { QueueService } from '../queue/queue.service';
import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import { OrderService } from '../order/order.service';
import { OrderInventoryService } from '../order/inventory.service';
import { CouponRedemptionService } from '../coupon/coupon-redemption.service';
import { InvoiceService } from '../billing/invoice.service';
import { CommissionService } from '../billing/commission.service';
import { ReceiptService } from '../billing/receipt.service';
import {
  NormalizedWebhookEvent,
  PaymentProvider,
  RefundResult,
} from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { eventFromRow } from './webhook-event-row';
import { requireTenantId } from '../../common/tenant/require-tenant';

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

/** 退款结果对外形态（前端只看 `status`，不解析渠道私有字段） */
export interface RefundOutcome {
  /** `REFUNDED` = 已落账；`REFUNDING` = 已受理、结果待渠道确认 */
  status: 'REFUNDED' | 'REFUNDING';
}

/**
 * 退款**重试预算**（次数）。
 *
 * ⚠️ **只约束 `FAILED + definitive=true` 的可重试分支**：
 *    结果未知的 `REFUNDING` 单不走这条预算（它连重试都没有，只有扫描核实）。
 */
const REFUND_ATTEMPT_LIMIT = 3;

/** 退款扫描判「超时」的默认阈值（毫秒）：10 分钟 */
const REFUND_SCAN_THRESHOLD_MS = 10 * 60 * 1000;

/** 退款扫描的**单轮上限**（张） */
const REFUND_SCAN_LIMIT = 50;
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
    // ⚠️ **货款流水的写入也在 billing 模块**（`payment → billing`，单向，不成环）。
    // 支付成功记一笔货款、退款成功记一笔冲回 —— 两者都必须与订单状态流转同事务。
    private readonly receipt: ReceiptService,
    // ⚠️ **渠道只从注册表取**（阶段 6a）：注册表统一做「已注册 → 已启用 →
    // 生产环境非 devOnly」三道校验，直接读 Map 会绕过「未启用」这层。
    private readonly registry: PaymentProviderRegistry,
  ) {}

  /** 当前租户 ID */
  currentTenantId(): string {
    return requireTenantId();
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
   * ⚠️ **`kind` 由调用方给**（阶段 5f）：补偿扫描要靠事件行上的这一列
   * 知道该反查订单还是反查账单。默认值是 `ORDER`，
   * 既有调用方（阶段 3 的 e2e 直接调本方法）行为不变。
   *
   * @returns true = 应当处理（首次到达，或上次到达时**没处理完**）；
   *          false = 重复投递且已处理过
   */
  async insertEvent(
    event: NormalizedWebhookEvent,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<boolean> {
    try {
      await this.prisma.paymentWebhookEvent.create({
        data: {
          provider: event.provider,
          eventId: event.eventId,
          providerTxnId: event.providerTxnId,
          kind,
          payload: {
            channel: event.channel,
            referenceNo: event.referenceNo,
            amount: event.amount,
            success: event.success,
            // ⚠️ **退款事件必须把类型与受理号一起落下来**（阶段 6c）：
            //    补偿扫描按事件行重建事件时，少了它们会把退款事件
            //    当成支付事件重放——查不到订单 → 静默丢掉。
            eventType: event.eventType ?? 'PAYMENT',
            ...(event.refundTxnId ? { refundTxnId: event.refundTxnId } : {}),
            ...(event.refundStatus ? { refundStatus: event.refundStatus } : {}),
            ...(event.definitive !== undefined
              ? { definitive: event.definitive }
              : {}),
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
   *
   * ⚠️ **`jobIdSuffix` 是补偿扫描用的**（阶段 5f Task 3）：
   * BullMQ 里 **failed job 的 hash 还在** → 用同一个 jobId 重新入队会被
   * **静默忽略**（`addJob` 的 Lua 脚本按 jobId 查存在性）→ 补偿等于没做。
   * 补偿扫描要能重复入队，就必须换个 jobId。
   * 默认空串 → 既有调用点的行为**完全不变**。
   *
   * ⚠️ **入队失败必须抛出去**（阶段 5f 修的丢钱洞）：
   * 此刻只落了**事件行**（`insertEvent` 已在验签之后插好），`Payment` 单与
   * 订单流转**都还没发生**。若把失败吞掉、返回 200，渠道会认为收到了、
   * **不再重投** → 事件行的 `processedAt` 永远是 null → 没人处理 →
   * **用户付了钱，订单永不流转**（库存还永久卡在预占）。
   * 抛出去 → 渠道收到 5xx → **重投**同一个 eventId → `insertEvent` 见
   * `processedAt` 为 null → 返回 true（允许重试）→ 重新入队 → 处理。
   *
   * ⚠️ **与「订单超时释放」的投递语义不同**：那边的失败是**不抛**
   * （订单已建成、用户可正常支付，报失败会诱发重复下单）。
   */
  async enqueueWebhookEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
    kind: PaymentKind = PaymentKind.ORDER,
    jobIdSuffix = '',
  ): Promise<void> {
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
        // ⚠️ 退款事件带上类型与状态，消费端据此走退款状态机
        ...(event.eventType ? { eventType: event.eventType } : {}),
        ...(event.refundTxnId ? { refundTxnId: event.refundTxnId } : {}),
        ...(event.refundStatus ? { refundStatus: event.refundStatus } : {}),
        ...(event.definitive !== undefined
          ? { definitive: event.definitive }
          : {}),
      },
      `webhook-${event.provider}-${event.eventId}${jobIdSuffix}`,
    );
  }

  /**
   * 消费端复核事件行（审计 P0-6 ③）。
   *
   * ⚠️ **为什么消费端要再查一次事件行**：队列里的任务可以被拿到 Redis 写权限的
   *    人随意改写（金额、业务单号、租户都能改）。事件行是**验签端点**落库的 ——
   *    行存在 = 这笔事件确实过了验签入口；行里的字段是当时的原文。
   *    所以这里**用行里的内容重建事件**，不采信任务里的金额 / 业务单号。
   *
   * ⚠️ **只认「还没处理完」的行**（`processedAt` 为 null）：
   *    已经处理过的事件重复投递不再生效（幂等本来靠状态流转的条件更新，
   *    这里提前挡住是更省的一道）。
   *
   * ⚠️ 事件表**不在租户作用域白名单里** —— 查它不需要租户上下文，
   *    也不需要 `platformScope()`。
   *
   * @returns null = 没有这张事件行（或行里的 payload 结构不对）→ 这个任务不生效
   */
  async loadRegisteredEvent(
    provider: string,
    eventId: string,
  ): Promise<{ event: NormalizedWebhookEvent; kind: PaymentKind } | null> {
    const row = await this.prisma.paymentWebhookEvent.findFirst({
      where: { provider, eventId, processedAt: null },
      select: {
        provider: true,
        eventId: true,
        providerTxnId: true,
        kind: true,
        payload: true,
      },
    });
    if (!row) {
      return null;
    }
    const event = eventFromRow(row);
    if (!event) {
      return null;
    }
    return { event, kind: row.kind };
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
    //
    // ⚠️ **时钟走 tx**：交互事务会独占一条连接，
    //    用 `this.prisma.databaseNow()` 会再借一条 → 小连接池上死等（P2024）。
    //
    // ⚠️ **tx 上的 `now()` 是「事务开始时刻」**，与事务外取有 ≤30s 偏差。
    //    `paidAt` 是财务口径字段，这个偏差在容差内，但**必须在此写明**。
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT now() as now
    `;
    const paidAt = nowRows[0].now;
    const won = await this.orderService.transitionInTx(
      tx,
      order.id,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
      { paidAt },
    );
    if (!won) {
      // ⚠️ **按「这笔钱是不是刚收的」分流**（2026-11-05 审计 P0-3 / P1-3）：
      //
      // - `paid.count === 1` → **本次新确认了一笔收款**（钱确实收了），
      //   但订单接不住（已超时关闭 / 已被消费者取消 / 已被另一渠道先付掉）。
      //   → 这笔钱**没有结算进订单**，必须退回去，
      //     否则平台账上凭空多一笔收不掉的钱。
      // - `paid.count === 0` → **重复投递**（同一笔支付的同一个事件又来了一次），
      //   钱早就收过了，这里什么都不用做。
      //
      // ⚠️ **不能抛异常回滚**：抛了整笔事务回滚 → 支付单退回 PENDING →
      //    「钱已经收了」这个事实被抹掉，而事件又会被标记成已处理，
      //    补偿扫描再也救不回来（审计 P0-3 的第 3 条对抗验证）。
      if (paid.count === 1) {
        await this.markUnsettledInTx(tx, order, event);
      } else {
        this.logger.warn(
          `订单 ${order.orderNo} 当前不是 PENDING_PAYMENT，不流转（事件 ${event.eventId}）`,
        );
      }
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

    // ---- 记一笔货款流水（阶段 5h-1）----
    //
    // ⚠️ **必须在同一个事务里，且紧跟在抽佣流水之后**：
    // 两张流水表的口径必须同步 —— 「有货款 ⟺ 有抽佣」是出款计算的前提
    // （唯一的例外是零额抽佣，那是有货款、无抽佣）。
    //
    // ⚠️ **`occurredAt` 用 `paidAt`** —— 与抽佣流水、与平台收入报表的归期口径逐字一致。
    await this.receipt.recordReceiptInTx(tx, order, paidAt);
  }

  /**
   * 钱收了但订单没接住：把支付单落成「已收款待退款」并告警。
   *
   * ⚠️ **为什么要有这个状态**（2026-11-05 审计 P0-3 / P1-3）：
   *    渠道回调确认收款时，订单可能已经不是 `PENDING_PAYMENT`
   *    （超时关闭 / 消费者取消 / 已被另一渠道先付掉）。
   *    这时钱**确实收了**，但它**没有结算进订单**——
   *    订单从没记过抽佣 / 货款流水，也永远等不到「整单退款」把它带走。
   *    → 落成 `NEEDS_REFUND`（已收款待退款），让商家在系统内能把它退掉。
   *
   * ⚠️ **绝不抛异常**：抛了会回滚整笔事务，把「钱已经收了」这个事实抹掉。
   *
   * ⚠️ **不写订单的流水**：这单从没结算过，没有可冲回的东西。
   *
   * ⚠️ **两次查询都走 `tx`**：交互事务独占一条连接，
   *    用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
   */
  private async markUnsettledInTx(
    tx: PrismaTransaction,
    order: { id: string; orderNo: string },
    event: NormalizedWebhookEvent,
  ): Promise<void> {
    // 同一订单同一渠道只有一笔支付单（`payments_order_channel_uniq` 唯一索引），
    // 所以这一条就是刚被置成 SUCCESS 的那笔。
    const unsettled = await tx.payment.findFirst({
      where: {
        orderId: order.id,
        channel: event.channel,
        status: PaymentStatus.SUCCESS,
      },
      select: { id: true },
    });
    if (!unsettled) {
      this.logger.error(
        `支付回调找不到已收款的支付单：订单 ${order.orderNo}` +
          `（渠道 ${event.channel}，事件 ${event.eventId}）`,
      );
      return;
    }

    const current = await tx.order.findFirst({
      where: { id: order.id },
      select: { status: true },
    });
    const orderStatus = current?.status;

    const marked = await tx.payment.updateMany({
      where: { id: unsettled.id, status: PaymentStatus.SUCCESS },
      data: { status: PaymentStatus.NEEDS_REFUND },
    });
    if (marked.count === 0) {
      this.logger.warn(
        `支付单 ${unsettled.id} 没能落成「已收款待退款」（状态已被改动），请人工核查：` +
          `订单 ${order.orderNo}（事件 ${event.eventId}）`,
      );
      return;
    }

    // ⚠️ **告警要能区分两种成因** —— 处置动作不同：
    //    - 订单已关闭 / 已取消 → **迟到扣款**：货不会发，钱必须退
    //    - 订单已被别的渠道付掉 → **重复收款**：货会发，多收的那笔必须退
    const cause =
      orderStatus === OrderStatus.CLOSED ||
      orderStatus === OrderStatus.CANCELLED
        ? '订单已关闭或已取消后才到账（迟到扣款）'
        : '订单已被其它渠道付过款（重复收款）';
    this.logger.error(
      `支付回调已收款但订单无法流转：订单 ${order.orderNo}` +
        `（当前状态 ${orderStatus ?? '未知'}），${cause}；` +
        `支付单 ${unsettled.id} 已标记为「已收款待退款」，` +
        `请走退款通道把这笔钱退回给用户（事件 ${event.eventId}）`,
    );
  }

  /** 标记事件已处理 */
  async markEventProcessed(event: NormalizedWebhookEvent): Promise<void> {
    // ⚠️ **落库时刻用数据库时钟**：该字段没有 `@updatedAt` 兜底，
    // 多副本部署时各机器时钟有偏差，用应用进程时钟会写出不可比的时刻。
    await this.prisma.paymentWebhookEvent.updateMany({
      where: { provider: event.provider, eventId: event.eventId },
      data: { processedAt: await this.prisma.databaseNow() },
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
   *
   * ⚠️ **退的是该订单「所有可退的支付单」**（2026-11-05 审计 P1-3）：
   *    同一个订单可能被两个渠道各收了一笔——`createPayment` 只要求订单还在
   *    `PENDING_PAYMENT`，两个渠道的支付单都能建出来，谁先回调谁结算。
   *    只退其中一笔的话，另一笔会永远卡住（订单已是终态，谁也动不了它）。
   *
   * ⚠️ **订单状态决定「能不能退钱」**（2026-11-05 审计 P0-3）：
   *    - `PAID` / `SHIPPED` → 整单退款（钱退回去，订单也退掉）
   *    - `CLOSED` / `CANCELLED` → **迟到扣款**：钱收了但货不会发，
   *      订单本身是终态、退款也不改它 → **只把钱退回去**。
   *      审计 P0-3 明确要求覆盖 `CANCELLED`（不只是 15 分钟超时），
   *      而且商家原来对这类单**没有任何系统内手段**——这一支就是那个出口。
   */
  async refund(orderNo: string, reason: string): Promise<RefundOutcome> {
    const order = await this.readOrderByNo(orderNo);

    // ⚠️ **候选是该订单所有「可退」的支付单**，不是 `payments[0]`：
    //    `payments[0]` 没有 `orderBy`，取到哪一笔完全不可预测，
    //    另一笔就永远退不掉（审计 P1-3）。
    const payments = await this.prisma.payment.findMany({
      where: {
        orderId: order.id,
        status: { in: [PaymentStatus.SUCCESS, PaymentStatus.NEEDS_REFUND] },
      },
    });
    if (payments.length === 0) {
      // ⚠️ **已经处于 `REFUNDING` 时不要说「没有可退款的支付单」** ——
      //    那是一句会让人以为「可以从别处退」的误导话术。
      const refunding = await this.prisma.payment.findMany({
        where: { orderId: order.id, status: PaymentStatus.REFUNDING },
      });
      if (refunding.length > 0) {
        throw new ConflictException('该订单已在退款中');
      }
      throw new ConflictException('订单没有可退款的支付单');
    }

    if (!this.orderAllowsRefund(order.status)) {
      throw new ConflictException('订单当前状态不允许退款');
    }

    // ---- 逐笔退 ----
    //
    // ⚠️ **一笔失败不打断其余的**：多笔时第一笔退成功、第二笔被渠道拒付，
    //    这时若立刻抛错，商家会以为「什么都没退」——
    //    而钱其实已经退了一部分（订单可能已经转成 `REFUNDED`）。
    const failures: Array<{ channel: string; error: unknown }> = [];
    let refundedCount = 0;
    let pendingCount = 0;
    for (const payment of payments) {
      try {
        const outcome = await this.refundOnePayment(payment, order, reason);
        if (outcome.status === 'REFUNDED') {
          refundedCount += 1;
        } else {
          pendingCount += 1;
        }
      } catch (error) {
        failures.push({ channel: payment.channel, error });
      }
    }

    if (failures.length > 0) {
      this.logger.error(
        `订单 ${order.orderNo} 有 ${failures.length} 笔退款失败：${failures
          .map((item) => `${item.channel}：${readableError(item.error)}`)
          .join('；')}`,
      );
      // ⚠️ **全部失败时抛第一个原始异常**：异常类型与文案都不变
      //    （单笔场景的老行为不能变）。
      if (failures.length === payments.length) {
        throw failures[0].error;
      }
      throw new BadRequestException(
        `部分退款失败（已退 ${refundedCount} 笔）：` +
          failures
            .map((item) => `${item.channel}：${readableError(item.error)}`)
            .join('；'),
      );
    }

    return { status: pendingCount > 0 ? 'REFUNDING' : 'REFUNDED' };
  }

  /**
   * 这个订单状态能不能退款。
   *
   * ⚠️ **`PAID` / `SHIPPED` 是整单退款**（钱退回去，订单也退掉）。
   * ⚠️ **`CLOSED` / `CANCELLED` / `REFUNDED` / `PENDING_PAYMENT` 只退钱**：
   *    这些订单要么从没结算过（钱收了但货不会发 → 迟到扣款），
   *    要么已经被退过（还残留一笔要退掉），
   *    要么钱收了但订单还卡在待支付 —— 一律**不改订单状态、不记冲回**。
   *    审计 P0-3 要求覆盖 `CANCELLED`（不只是 15 分钟超时），
   *    而且商家原来对这类单**没有任何系统内手段**——这一支就是那个出口。
   * ⚠️ **`COMPLETED` 不放行**：已完成的订单要退是「退货退款」，
   *    那是带质检与退货单的另一套流程，不在本阶段。
   */
  private orderAllowsRefund(status: OrderStatus): boolean {
    return (
      status === OrderStatus.PAID ||
      status === OrderStatus.SHIPPED ||
      status === OrderStatus.CLOSED ||
      status === OrderStatus.CANCELLED ||
      status === OrderStatus.REFUNDED ||
      status === OrderStatus.PENDING_PAYMENT
    );
  }

  /**
   * 退**一笔**支付单（抢闸门 → 调渠道 → 落账）。
   *
   * ⚠️ **能力门控必须在调用渠道之前**（阶段 6a）：不支持在线退款的渠道
   * 调下去要么静默失败、要么被渠道当成「退款成功」回一个空结果——
   * 那时本地已经改了状态，外部却一分没退。宁可显式 409。
   * 放在抢闸门之前，连本地状态都不碰。
   */
  private async refundOnePayment(
    payment: { id: string; channel: string; amount: number },
    order: ReadableOrder,
    reason: string,
  ): Promise<RefundOutcome> {
    const provider = this.providerOf(payment.channel);

    if (!provider.capabilities.refund) {
      throw new ConflictException(
        `当前渠道 ${provider.channel} 不支持在线退款`,
      );
    }

    // ⚠️ **先抢闸门，再调渠道**（阶段 6c：闸门是 `SUCCESS → REFUNDING`）。
    //
    // 两个并发的退款请求不能都去调渠道——本地状态只有第一个能改成
    // REFUNDING（条件更新挡住第二个），但**渠道已经被调了两次**。
    // 假网关的退款是 no-op 所以看不出来，接真渠道就是**退两次钱**，
    // 而本地账看着是对的——那是最坏的形态：本地账对得上、外部账对不上。
    //
    // 这一步把「能不能退」变成一次原子的判定：抢到闸门的那个才去调渠道。
    //
    // ⚠️ **`refundAttemptCount < 上限` 也在条件里**：退款失败可以重试，
    //    但不能无限重试——超过预算的单留在 `REFUNDING`（或原状态），
    //    只在扫描里告警，交人工处理。放在条件更新里而不是先读后判，
    //    是为了让预算判定与抢闸门一样是原子的。
    //
    // ⚠️ **`NEEDS_REFUND` 也要能抢闸门**：那是「钱收了但订单没接住」的
    //    支付单（审计 P0-3），它正是商家要退的那一笔。
    const refundRequestedAt = await this.prisma.databaseNow();
    const claimed = await this.prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: [PaymentStatus.SUCCESS, PaymentStatus.NEEDS_REFUND] },
        refundAttemptCount: { lt: REFUND_ATTEMPT_LIMIT },
      },
      data: {
        status: PaymentStatus.REFUNDING,
        refundAttemptCount: { increment: 1 },
        refundRequestedAt,
        // 新一次尝试开始时清掉上一次的失败原因，免得误读成「这次也失败了」
        refundFailureReason: null,
        // ⚠️ **必须清掉上一次的退款受理号**（阶段 6 审查结论）：
        //    上一次的受理号对应的是**上一次**的渠道退款单，这一次还没拿到。
        //    留着它，扫描 / 迟到回调会把「上一次已拒付」的结论当成
        //    「这一次」的结论 → 把闸门放回 SUCCESS → 商家再点一次就是**重复退款**。
        refundTxnId: null,
      },
    });
    if (claimed.count === 0) {
      throw await this.refundClaimConflict(payment.id);
    }

    // ⚠️ **先调渠道退款**，渠道确认成功才改本地状态。
    // 反过来的话，渠道退款失败时本地已经标成 REFUNDED，
    // 钱没退出去但账面显示退了——对账全乱。
    //
    // `payment.id` 是**渠道侧的幂等单号**（真渠道都支持）：
    // 即便闸门被绕过、渠道被调了两次，也只会退一次钱。
    let result: RefundResult;
    try {
      result = await provider.refund(payment.id, payment.amount, reason);
    } catch (error) {
      // ⚠️ **抛异常 = 结果未知**（网络超时 / 网关错误），不是「渠道拒付」。
      //    这时**不能回退闸门**——渠道可能已经受理了，回退后商家再退一次
      //    就是重复退款。保持 REFUNDING，写可读原因，交给扫描 / 回调核实。
      const readable = readableError(error);
      await this.markRefundPending(payment.id, readable);
      this.logger.warn(
        `渠道退款调用异常，保持 REFUNDING 待核查：支付单 ${payment.id}（${readable}）`,
      );
      return { status: 'REFUNDING' };
    }

    if (result.status === 'SUCCESS') {
      return this.confirmRefundSuccess(order, payment.id, result.refundTxnId);
    }

    if (result.status === 'PROCESSING') {
      // ⚠️ **`PROCESSING` 不是成功**：只写受理号，状态保持 REFUNDING。
      //    前端拿到 `REFUNDING` 就知道「钱还没退到」。
      await this.attachRefundTxnId(payment.id, result.refundTxnId);
      return { status: 'REFUNDING' };
    }

    // ---- FAILED ----
    const failureReason = result.failureReason ?? '渠道拒绝了本次退款';
    if (result.definitive) {
      // ⚠️ **渠道明确说没退出去** → 放回闸门，允许商家重试。
      //    重试预算由上面条件更新里的 `refundAttemptCount` 兜底。
      await this.releaseRefundClaim(payment.id, failureReason);
      throw new BadRequestException('渠道拒绝了本次退款');
    }
    // ⚠️ **结果未知**（definitive=false）→ 保持 REFUNDING，交给扫描核实；
    //    绝不自动重试——重试可能变成重复退款。
    await this.markRefundPending(payment.id, failureReason, result.refundTxnId);
    this.logger.warn(
      `渠道退款结果未知，保持 REFUNDING 待核查：支付单 ${payment.id}（${failureReason}）`,
    );
    return { status: 'REFUNDING' };
  }

  /**
   * 抢闸门失败时给出**准确**的中文原因。
   *
   * ⚠️ **必须区分「并发」与「超预算」**：并发时提示「已在退款中」，
   *    超预算时要让商家知道该找人工，而不是反复点。
   */
  private async refundClaimConflict(
    paymentId: string,
  ): Promise<ConflictException> {
    const rows = await this.prisma.payment.findMany({
      where: { id: paymentId },
      select: { status: true, refundAttemptCount: true },
    });
    const current = rows[0];
    if (!current || current.status === PaymentStatus.REFUNDING) {
      return new ConflictException('该订单已在退款中');
    }
    if (
      (current.status === PaymentStatus.SUCCESS ||
        current.status === PaymentStatus.NEEDS_REFUND) &&
      current.refundAttemptCount >= REFUND_ATTEMPT_LIMIT
    ) {
      // ⚠️ **超预算不加告警去重列**（本阶段约定）：只记日志，扫描每轮最多一次。
      this.logger.error(
        `支付单 ${paymentId} 退款重试已达上限（${REFUND_ATTEMPT_LIMIT} 次），需人工核查`,
      );
      return new ConflictException(
        `退款重试次数已达上限（${REFUND_ATTEMPT_LIMIT} 次），请联系平台人工处理`,
      );
    }
    return new ConflictException('订单当前状态不允许退款');
  }

  /**
   * 渠道确认退款成功：落 `REFUNDED` 并执行冲回事务。
   *
   * ⚠️ **`REFUNDED` 只能由渠道确认成功触发**：
   *    发起路径的 `SUCCESS`、回调的 `SUCCESS`、扫描的 `SUCCESS` 都收敛到这里。
   */
  private async confirmRefundSuccess(
    order: ReadableOrder,
    paymentId: string,
    refundTxnId?: string,
  ): Promise<RefundOutcome> {
    // ⚠️ **退款时间用数据库的时钟**（护栏 M15，与本仓库其它地方一致）：
    // 多副本部署时各机器的时钟有偏差，边界时刻会摇摆。
    const refundedAt = await this.prisma.databaseNow();
    await this.prisma.$transaction(async (tx) => {
      await this.applyRefundInTx(tx, paymentId, order, refundedAt, refundTxnId);
    }, transactionOptions());
    return { status: 'REFUNDED' };
  }

  /**
   * 在**调用方的事务内**执行退款落账：支付单 `REFUNDING → REFUNDED`、
   * 订单转 `REFUNDED`、记抽佣冲回与货款冲回。
   *
   * ⚠️ **支付单的条件更新是第一道幂等闸**：重复回调 / 重复扫描时
   *    `count === 0`，直接跳过，不会记第二笔冲回流水。
   *
   * ⚠️ **不碰库存、不记 RELEASE 流水**——货已发出。
   *
   * ⚠️ **这里不重算优惠是有意的，不是漏了**（M13）：
   * 退款额读的是 `order.totalAmount`，而它就是下单时算出的**实付额**
   * （已含券与活动的减免）。所以退款额天然等于实付额，
   * 不会多退也不会少退。
   *
   * **为什么不重算**：券的规则将来可能改，改了就对不上历史账（M12）。
   * 历史订单存的是**快照**（原价 / 活动减免 / 券减免各字段），
   * 退款读快照而不是重算——这正是 M12 的兑现点。
   *
   * @returns true = 本次完成落账；false = 支付单已不在 `REFUNDING`（已处理过）
   */
  private async applyRefundInTx(
    tx: PrismaTransaction,
    paymentId: string,
    order: ReadableOrder,
    refundedAt: Date,
    refundTxnId?: string,
  ): Promise<boolean> {
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.REFUNDING },
      data: {
        status: PaymentStatus.REFUNDED,
        refundFailureReason: null,
        ...(refundTxnId ? { refundTxnId } : {}),
      },
    });
    if (claimed.count === 0) {
      // 已经处理过（重复回调 / 重复扫描）→ 不再记第二笔冲回
      this.logger.warn(
        `支付单 ${paymentId} 不在 REFUNDING，跳过退款落账（可能已处理）`,
      );
      return false;
    }

    // ⚠️ **订单级动作按「订单当前状态」决定**（2026-11-05 审计 P0-3 / P1-3）：
    //
    // - `PAID` / `SHIPPED` → 这单结算过订单 → 订单转 `REFUNDED` + 记冲回流水
    // - `CLOSED` / `CANCELLED` → **这单从没结算过**（钱收了但订单已关闭 / 已取消）
    //   → **只退钱**：不改订单状态、不记冲回
    //   （那单从没记过抽佣 / 货款流水，没有可冲回的东西；
    //     而 `CLOSED` / `CANCELLED` 是终态，订单转移表也不允许转）
    // - `REFUNDED` → 已经被退过（多渠道的第二笔就是这样）→ 跳过，不重复冲回
    //
    // ⚠️ **这里读的是事务内的当前状态，不是退款发起时的快照** ——
    //    多笔退款时第一笔已经把订单转成 `REFUNDED`，第二笔必须看到它，
    //    否则第二笔会重复记一遍冲回流水（或者直接卡死）。
    const current = await tx.order.findFirst({
      where: { id: order.id },
      select: { status: true },
    });
    const orderStatus = current?.status;
    if (
      orderStatus !== OrderStatus.PAID &&
      orderStatus !== OrderStatus.SHIPPED
    ) {
      this.logger.warn(
        `支付单 ${paymentId} 退款落账，但订单 ${order.orderNo} 当前状态是 ` +
          `${orderStatus ?? '未知'}：不改订单状态、不记冲回` +
          `（该订单没有可冲回的流水）`,
      );
      return true;
    }

    // 订单转 REFUNDED（条件更新，走 order 模块的转移表校验）
    //
    // ⚠️ **顺手记下退款时间**（阶段 5b Task 1 加的 `Order.refundedAt`）：
    // 报表的「退款冲回」要按**退款发生的期间**归期，
    // 不是按订单支付的期间 —— 阶段 3 的退款没记这个时间，
    // 补上之前冲回那一栏永远是 0。
    const won = await this.orderService.transitionInTx(
      tx,
      order.id,
      orderStatus,
      OrderStatus.REFUNDED,
      { refundedAt },
    );
    if (!won) {
      // ⚠️ **不能抛异常**：抛了整笔事务回滚 → 支付单退回 `REFUNDING` →
      //    这笔退款**永远卡死**（审计 P1-3：多渠道的第二笔就是这样卡住的）。
      //    条件更新抢不到 = 订单已经不是那个状态了 = 另一笔退款已经退过这单
      //    → 跳过订单级动作（不重复记冲回）；
      //    但**支付单已经是 `REFUNDED`**——渠道确认过钱确实退了，
      //    这个事实不能被抹掉（抹掉会让商家再点一次退款 → 重复退款）。
      this.logger.warn(
        `订单 ${order.orderNo} 状态已被改动，跳过订单级冲回：支付单 ${paymentId}`,
      );
      return true;
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

    // ---- 记一笔货款冲回流水（阶段 5h-1）----
    //
    // ⚠️ **金额取负**（`recordReceiptReversalInTx` 内部处理）——
    // 与货款行反向，单列求和即净额。
    //
    // ⚠️ **必须在同一个事务里**：订单转 REFUNDED 与「商家该收的钱被冲回了」
    // 同生共死。分成两个事务的话，退款成功而货款冲回没记上 → 商家多拿钱。
    await this.receipt.recordReceiptReversalInTx(tx, order, refundedAt);
    return true;
  }

  /**
   * 把渠道给的**退款受理号**写到支付单上（仅 `REFUNDING` 时写）。
   *
   * ⚠️ 这是 `queryRefund` 的唯一键：没有它，渠道回调一旦丢失，
   *    这张单会永远停在 `REFUNDING`。
   */
  private async attachRefundTxnId(
    paymentId: string,
    refundTxnId?: string,
  ): Promise<void> {
    if (!refundTxnId) {
      return;
    }
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.REFUNDING },
      data: { refundTxnId },
    });
  }

  /**
   * 结果未知时保持 `REFUNDING`，写受理号（有就写）与可读原因。
   *
   * ⚠️ **失败原因只作诊断**：`REFUNDING` 表示「已受理、结果未知」，
   *    绝不因为写了原因就当成失败。
   */
  private async markRefundPending(
    paymentId: string,
    failureReason: string,
    refundTxnId?: string,
  ): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.REFUNDING },
      data: {
        refundFailureReason: failureReason,
        ...(refundTxnId ? { refundTxnId } : {}),
      },
    });
  }

  /**
   * 渠道**明确拒付**时，把「退款闸门」还回去（`REFUNDING → SUCCESS`）。
   *
   * 闸门是支付单的状态 `SUCCESS → REFUNDING`。渠道明确说没退出去却留着
   * REFUNDING 的话，这笔退款就永远做不了（条件更新再也抢不到闸门），
   * 商家只能干瞪眼。
   *
   * ⚠️ **只在 `definitive === true` 时调用**：结果未知时回退 = 允许重复退款。
   */
  private async releaseRefundClaim(
    paymentId: string,
    failureReason?: string,
  ): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.REFUNDING },
      data: {
        status: PaymentStatus.SUCCESS,
        refundFailureReason: failureReason ?? '渠道拒绝了本次退款',
        // ⚠️ **受理号一并清掉**：已明确拒付，那个受理号不会再变成成功。
        //    留着它，下一次退款尝试若在拿到新受理号之前就异常，
        //    扫描会拿旧受理号去问，把「上一次的结论」当成本次的结论。
        refundTxnId: null,
      },
    });
  }

  /**
   * 向渠道核实**一张** `REFUNDING` 支付单的退款结果（阶段 6c 扫描用）。
   *
   * ⚠️ **没有 `refundTxnId` 就只告警、不调渠道**：渠道没给受理号，
   *    我们连「问哪一单」都说不出来。盲目拿支付单 id 去查会把
   *    「查无此单」的 `UNKNOWN` 当成结论。
   *
   * @returns true = 已经问了渠道；false = 跳过了（无受理号）
   */
  async verifyRefundingPayment(
    paymentId: string,
    refundTxnId: string | null,
  ): Promise<boolean> {
    if (!refundTxnId) {
      this.logger.error(
        `REFUNDING 的支付单 ${paymentId} 没有退款受理号（refundTxnId），` +
          `无法向渠道核实，请人工核查`,
      );
      return false;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, status: PaymentStatus.REFUNDING },
      select: {
        id: true,
        orderId: true,
        amount: true,
        status: true,
        channel: true,
        refundTxnId: true,
      },
    });
    if (!payment) {
      // 已经被回调先落账了 —— 正常并发，跳过
      return true;
    }
    // ⚠️ 订单要在**当前租户上下文**里读（调用方负责重建），
    //    冲回流水需要订单快照里的费率与金额。
    //    订阅支付单没有订单，退款扫描只处理订单支付（订阅退款不在本阶段）。
    const order = payment.orderId
      ? await this.findOrder({ id: payment.orderId })
      : null;
    if (!order) {
      this.logger.error(
        `REFUNDING 的支付单 ${paymentId} 找不到订单，无法核实退款，请人工核查`,
      );
      return false;
    }
    const provider = this.providerOf(payment.channel);
    let query: Awaited<ReturnType<PaymentProvider['queryRefund']>>;
    try {
      query = await provider.queryRefund(refundTxnId);
    } catch (error) {
      this.logger.error(
        `查询退款结果异常：支付单 ${paymentId}（${readableError(error)}）`,
      );
      return true;
    }
    await this.settleRefundResult(paymentId, order, {
      ...query,
      // ⚠️ 渠道的查询结果缺 `refundTxnId` 时不要把它覆盖成空 ——
      //    受理号已经落库，保留库里那一个。
      refundTxnId: query.refundTxnId ?? payment.refundTxnId ?? undefined,
    });
    return true;
  }

  // ============================================================
  // 退款事件与退款扫描（阶段 6c）
  // ============================================================

  /**
   * 应用一个**已落库的退款事件**（回调或补偿扫描走同一条路）。
   *
   * ⚠️ **租户上下文必须先重建**：本方法是被队列消费端调用的，
   * 而 `AsyncLocalStorage` 的上下文不跟着走（见 `runInTenant` 的注释）。
   *
   * ⚠️ **按 `refundTxnId` 反查支付单**：退款事件不带支付交易号，
   * 只有渠道给的退款受理号（没有就退化为订单号）能定位这笔退款。
   */
  async applyRefundEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
  ): Promise<void> {
    const type = event.eventType ?? 'PAYMENT';
    if (type !== 'REFUND') {
      return;
    }
    await runForTenant(tenantId, async () => {
      await this.applyRefundEventInTenant(event, tenantId);
    });
    await this.markEventProcessed(event);
  }

  /** 在当前租户上下文里落一个退款事件的业务流转 */
  private async applyRefundEventInTenant(
    event: NormalizedWebhookEvent,
    tenantId: string,
  ): Promise<void> {
    if (event.refundStatus !== 'SUCCESS' && event.refundStatus !== 'FAILED') {
      // ⚠️ `PROCESSING` 只记日志、不动状态：受理 ≠ 成功
      this.logger.warn(
        `退款事件结果未定（${event.refundStatus ?? '未知'}），保持原状态等待下一条：事件 ${event.eventId}`,
      );
      return;
    }

    const payment = await this.findRefundablePayment(event);
    if (!payment) {
      this.logger.warn(
        `退款事件找不到 REFUNDING 的支付单：订单 ${event.referenceNo}（事件 ${event.eventId}）`,
      );
      return;
    }

    const order = payment.orderId
      ? await this.findOrder({ id: payment.orderId })
      : null;
    if (!order) {
      this.logger.error(
        `退款事件找不到订单：租户 ${tenantId}，支付单 ${payment.id}（事件 ${event.eventId}）`,
      );
      return;
    }

    // ⚠️ **金额核对**：退款金额必须等于当初实付的金额。
    //    不核对的话，一条伪造的回调就能把一笔「没付够的订单」标成已退款。
    if (event.amount !== payment.amount) {
      this.logger.error(
        `退款回调金额不符，拒绝流转：支付单 ${payment.id} ` +
          `应付 ${payment.amount}，收到 ${event.amount}（事件 ${event.eventId}）`,
      );
      return;
    }

    if (event.refundStatus === 'FAILED') {
      // ⚠️ **必须看 `event.refundStatus`，不能只看 `event.success`**：
      //    `success` 是支付事件的语义（`refundStatus === 'SUCCESS'`），
      //    而「拒付」到底是确定还是未知，只有 `definitive` 说得清。
      const definitive = this.refundDefinitive(event);
      if (definitive) {
        // 渠道明确说没退出去 → 回退 SUCCESS，允许商家重试
        await this.releaseRefundClaim(payment.id, '渠道回调明确拒付');
        this.logger.warn(
          `退款回调明确拒付，回退为 SUCCESS 可重试：支付单 ${payment.id}（事件 ${event.eventId}）`,
        );
        return;
      }
      // 结果未知 → 保持 REFUNDING，交给扫描核实
      this.logger.warn(
        `退款回调结果未知，保持 REFUNDING：支付单 ${payment.id}（事件 ${event.eventId}）`,
      );
      return;
    }

    // `SUCCESS` → 落 REFUNDED + 冲回（条件更新在事务里幂等）
    //
    // ⚠️ **时钟在事务外取**：它表达的是「事件发生时刻」的语义，
    //    放在事务内会多借一条连接（小连接池上死等，P2024）。
    const now = await this.prisma.databaseNow();
    await this.prisma.$transaction(async (tx) => {
      await this.applyRefundInTx(tx, payment.id, order, now, event.refundTxnId);
    }, transactionOptions());
  }

  /**
   * 退款事件对应的支付单（必须是 `REFUNDING` 的）。
   *
   * ⚠️ **只认 `REFUNDING`**：已经 `REFUNDED` 的重复回调由 `insertEvent`
   *    的幂等挡住；已经 `SUCCESS`（渠道回调说拒付）的再来一条 SUCCESS
   *    也不能把它冲回——那等于「一次拒付、一次成功」的账对不上。
   */
  private async findRefundablePayment(event: NormalizedWebhookEvent): Promise<{
    id: string;
    orderId: string | null;
    amount: number;
    status: PaymentStatus;
  } | null> {
    const select = {
      id: true,
      orderId: true,
      amount: true,
      status: true,
      refundTxnId: true,
    } as const;

    const findByOrderNo = () =>
      this.prisma.payment.findFirst({
        where: {
          order: {
            is: {
              tenantId: this.currentTenantId(),
              orderNo: event.referenceNo,
            },
          },
          status: PaymentStatus.REFUNDING,
        },
        select,
      });

    if (event.refundTxnId !== undefined && event.refundTxnId !== '') {
      const byTxnId = await this.prisma.payment.findFirst({
        where: {
          refundTxnId: event.refundTxnId,
          status: PaymentStatus.REFUNDING,
        },
        select,
      });
      if (byTxnId) {
        return byTxnId;
      }

      // ⚠️ **受理号查不到时，成功的退款事件还要按订单号再找一次**
      //    （阶段 6 审查结论）：渠道可能在**异步受理时**才生成受理号
      //    （`refund()` 超时 / 只回了「已受理」），本地库里的 `refundTxnId`
      //    还是 null，这条合法的成功回调就会因为「按受理号查不到单」
      //    被永久吞掉 —— 钱退了，本地永远停在 REFUNDING。
      //
      // ⚠️ **只对 `SUCCESS` 回落**：成功是既成事实，补记 `REFUNDED` 是安全的；
      //    `FAILED` 无法证明属于哪一次尝试，回落可能把**正在进行的**闸门误放掉。
      if (event.refundStatus !== 'SUCCESS') {
        return null;
      }
      const byOrder = await findByOrderNo();
      if (!byOrder) {
        return null;
      }
      if (byOrder.refundTxnId) {
        // ⚠️ **库里已有受理号但与事件不一致** → 这是上一次尝试的迟到事件，
        //    绝不据此改动这一次的状态。
        this.logger.warn(
          `退款事件的受理号与支付单不一致，忽略：支付单 ${byOrder.id} ` +
            `（库里 ${byOrder.refundTxnId}，事件 ${event.refundTxnId}）`,
        );
        return null;
      }
      return byOrder;
    }

    return findByOrderNo();
  }

  /** 把渠道退款结果（`queryRefund` / 回调）统一落到状态机 */
  private async settleRefundResult(
    paymentId: string,
    order: ReadableOrder,
    result: {
      status: 'SUCCESS' | 'PROCESSING' | 'FAILED' | 'UNKNOWN';
      refundTxnId?: string;
      amount?: number;
      definitive?: boolean;
      failureReason?: string;
    },
  ): Promise<void> {
    if (result.status === 'SUCCESS') {
      // ⚠️ **金额核对**：渠道说「退了这么多」必须与实付额一致。
      //    查到的金额偏大 → 多退了钱；偏小 → 少退了钱。两种都要人工查。
      if (result.amount !== undefined && result.amount !== order.totalAmount) {
        this.logger.error(
          `查询退款结果金额不符，拒绝落账：支付单 ${paymentId} ` +
            `应退 ${order.totalAmount}，渠道报 ${result.amount}`,
        );
        return;
      }
      await this.confirmRefundSuccess(order, paymentId, result.refundTxnId);
      return;
    }
    if (result.status === 'PROCESSING' || result.status === 'UNKNOWN') {
      this.logger.warn(
        `退款仍未定（${result.status}），保持 REFUNDING：支付单 ${paymentId}`,
      );
      return;
    }
    // FAILED
    if (result.definitive) {
      await this.releaseRefundClaim(paymentId, result.failureReason);
      this.logger.warn(
        `渠道查询确认退款被拒付，回退 SUCCESS 可重试：支付单 ${paymentId}`,
      );
      return;
    }
    await this.markRefundPending(
      paymentId,
      result.failureReason ?? '渠道退款结果未知',
      result.refundTxnId,
    );
    this.logger.warn(
      `渠道查询退款结果未知，保持 REFUNDING 待核查：支付单 ${paymentId}`,
    );
  }

  /**
   * 从退款事件里读出 `definitive`。
   *
   * ⚠️ **缺省按未知（`false`）处理**：拿不到明确声明时，宁可保持 REFUNDING，
   *    也不要当成「渠道明确拒付」而允许重试。
   */
  private refundDefinitive(event: NormalizedWebhookEvent): boolean {
    return event.definitive === true;
  }

  /**
   * 扫超时的 `REFUNDING` 支付单，向渠道核实退款结果（阶段 6c）。
   *
   * ⚠️ **形态照 `PayoutScanScheduler`**：周期任务只投 job，真正的活由
   *    `RefundScanScheduler` 的消费端做——周期任务里没有事务，
   *    进程挂了也只会丢这一轮，不会留下半截状态。
   *
   * @returns 本轮处理了多少张（上限 `REFUND_SCAN_LIMIT`）
   */
  async scanRefunding(now = new Date()): Promise<number> {
    // ⚠️ **阈值 10 分钟**：发起退款的 `refundRequestedAt` 早于它才算超时。
    //    短于一个支付回调的正常到达时间会把「还在路上」的退款误报。
    const thresholdMs = Number(
      process.env.REFUND_STUCK_THRESHOLD_MS ?? REFUND_SCAN_THRESHOLD_MS,
    );
    const since = new Date(now.getTime() - thresholdMs);

    const stuck = await tenantContext.run(platformScope(), async () =>
      this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.REFUNDING,
          refundRequestedAt: { lt: since },
        },
        orderBy: { refundRequestedAt: 'asc' },
        // ⚠️ **单轮上限 50**：不退化成全表扫描；剩下的下一轮再来。
        take: REFUND_SCAN_LIMIT,
        select: {
          id: true,
          tenantId: true,
          orderId: true,
          refundTxnId: true,
        },
      }),
    );

    if (stuck.length === 0) {
      return 0;
    }
    if (stuck.length >= REFUND_SCAN_LIMIT) {
      // ⚠️ **每轮最多一次**的汇总告警（本阶段不加去重列）
      this.logger.warn(
        `退款扫描本轮已达上限（${REFUND_SCAN_LIMIT} 张），可能仍有积压`,
      );
    }

    let handled = 0;
    for (const row of stuck) {
      // ⚠️ **没有订单的支付单（订阅）不在本阶段退款范围内**，只告警
      if (!row.orderId) {
        this.logger.warn(
          `REFUNDING 的支付单 ${row.id} 不是订单支付，跳过退款核实`,
        );
        continue;
      }
      try {
        // ⚠️ **按支付单自己的租户重建上下文**（扫描是跨租户的）
        await runForTenant(row.tenantId, async () => {
          const queried = await this.verifyRefundingPayment(
            row.id,
            row.refundTxnId,
          );
          if (queried) {
            handled += 1;
          }
        });
      } catch (error) {
        // ⚠️ 单张失败不拖垮整轮：记日志，下一轮再来
        this.logger.error(
          `退款扫描处理支付单 ${row.id} 失败：${readableError(error)}`,
        );
      }
    }
    return handled;
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
    const inserted = await this.insertEvent(event, PaymentKind.ORDER);
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
    const inserted = await this.insertEvent(event, PaymentKind.SUBSCRIPTION);
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

      // ⚠️ **金额必须与订单一致**（审计 P0-6 ②）：
      //    消费端**不信事件里的金额** —— 队列里的任务可以被拿到 Redis 写权限的
      //    人改写，金额就是最值钱的那一栏。这里从订单反查应付金额，
      //    `order.totalAmount` 已经在手里，**零额外查询**。
      //
      //    ⚠️ 这一层是**兜底**：验签端点（`checkWebhookEvent`）已经核过一次，
      //    但端点与消费端之间隔着一个可写的队列，消费端必须自己再核一遍。
      if (event.amount !== order.totalAmount) {
        this.logger.error(
          `支付回调金额不符，拒绝流转：订单 ${order.orderNo} ` +
            `应付 ${order.totalAmount}，实付 ${event.amount}（事件 ${event.eventId}）`,
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

      await this.prisma.$transaction(async (tx) => {
        await this.applyEventInTx(tx, event, order);
      }, transactionOptions());
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
    let updated: { count: number };
    try {
      updated = await this.prisma.payment.updateMany({
        where: {
          orderId: order.id,
          channel: event.channel,
          // ⚠️ **必须带 provider**：预检查按 (provider, providerTxnId) 判冲突，
          //    写入却不带 provider 的话，另一个渠道的同号交易会把
          //    「这次绑定」当成成功，实际写错了行 / 一行都没写。
          provider: event.provider,
          status: PaymentStatus.PENDING,
        },
        data: { providerTxnId: event.providerTxnId },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // ⚠️ 并发撞唯一索引：不在业务事务里，重查一次判断是否真冲突。
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
      } else {
        this.logger.warn(
          `渠道交易 ${event.providerTxnId} 绑定时撞唯一索引但查不到冲突方，` +
            `拒绝流转订单 ${order.orderNo}（事件 ${event.eventId}）`,
        );
      }
      // ⚠️ 无论哪种情况都不返回 true —— 静默成功会让订单在缺少
      //    providerTxnId 的情况下继续流转，后续对账只能靠金额猜。
      return false;
    }

    if (updated.count === 0) {
      // 订单不处于 PENDING 或渠道不匹配 —— 这笔绑定没有落地。
      this.logger.warn(
        `渠道交易 ${event.providerTxnId} 未写入支付单（订单 ${order.orderNo}` +
          ` 不处于待支付或渠道不匹配，事件 ${event.eventId}）`,
      );
      return false;
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

  /**
   * 按渠道名取 provider。
   *
   * ⚠️ **统一走注册表**（阶段 6a）：未注册 / 未启用 / 生产 devOnly 由注册表
   * 抛中文 409。直接读 Map 的话，「未启用」的渠道照样能被调起来。
   */
  providerOf(channel: string): PaymentProvider {
    return this.registry.get(channel);
  }

  /**
   * **已启用**的支付渠道名（消费端用它挑默认渠道）。
   *
   * ⚠️ **只给「已启用」的**（审计 P2-A1）：原来这里给的是**全部已注册**的渠道
   *    （含未启用），生产环境一个渠道都没配时，调用方拿到的第一个渠道
   *    照样会被注册表以「未启用」拒掉 —— 用户看到的是「支付渠道 fake 未启用」，
   *    而不是「没有可用的支付渠道」，排障方向被带偏。
   *
   * ⚠️ 非生产环境**包含 devOnly 渠道**（`fake` 等）—— 注册表在非生产时放行它们；
   *    生产环境则自动排除（注册表那里同理）。
   */
  listEnabledChannels(): string[] {
    return this.registry.list({ includeDevOnly: true }).map((d) => d.channel);
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
 * 把异常压成**可读的中文原因**，写进 `refundFailureReason`。
 *
 * ⚠️ **绝不原样落 `String(error)`**：那会把堆栈、连接串、请求头里的密钥
 *    一起写进库，日志里也看得见。这里只取安全字段。
 */
function readableError(error: unknown): string {
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
