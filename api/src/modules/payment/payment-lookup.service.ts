import { requireTenantId } from '../../common/tenant/require-tenant';
import {
  platformScope,
  runForTenant,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PaymentProvider } from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { ReadableOrder } from './payment-types';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Payment, PaymentKind } from '@prisma/client';

/**
 * PaymentLookupService —— 自 PaymentService（原 2600+ 行巨石）按职责拆出的部分（阶段 11）。
 *
 * 拆分是**纯机械搬移**：方法体与注释原样保留，只把跨组调用
 * （providerOf / find* / currentTenantId）改写为经 `this.lookup`（PaymentLookupService）。
 * 行为校验靠既有 959 条单测与 663 条 e2e；事务纪律靠 tx-boundary-scanner 的
 * 跨服务调用解析（this.svc.method 走类型解析，见 scanner 文档「形态 B」）。
 */
@Injectable()
export class PaymentLookupService {
  private readonly logger = new Logger(PaymentLookupService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  /** 当前租户 ID */
  currentTenantId(): string {
    return requireTenantId();
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
  async findOrderAcrossTenants(orderNo: string): Promise<{
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
  async findInvoiceAcrossTenants(invoiceNumber: string): Promise<{
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
  async findInvoiceAcrossTenantsById(invoiceId: string | null): Promise<{
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
  async findOrderAcrossTenantsById(orderId: string | null): Promise<{
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
  async findOrderByNo(orderNo: string): Promise<ReadableOrder | null> {
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
  async findOrder(where: {
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
  async findPaymentByOrderAndChannel(
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
