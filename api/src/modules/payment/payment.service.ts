import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { OrderStatus, Payment, PaymentStatus, Prisma } from '@prisma/client';
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
    @Inject(PAYMENT_PROVIDERS)
    private readonly providers: Map<string, PaymentProvider>,
  ) {}

  /** 当前租户 ID */
  private currentTenantId(): string {
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
      orderId: payment.id,
      orderNo: order.orderNo,
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
   * ⚠️ **租户从订单反查**（R14）：webhook 端点没有租户上下文
   * （渠道回调不带子域名），所以必须先按订单号找到订单，
   * 拿到它的 tenantId。**绝不采信请求体里的 tenantId**——
   * 采信了就等于「构造回调指定别的租户」，能跨租户篡改订单。
   */
  async checkWebhookEvent(
    event: NormalizedWebhookEvent,
  ): Promise<WebhookEventCheck> {
    const order = await this.findOrderAcrossTenants(event.orderNo);
    if (!order) {
      this.logger.warn(
        `支付回调找不到订单：${event.orderNo}（事件 ${event.eventId}）`,
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
            orderNo: event.orderNo,
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
   * ⚠️ **jobId 用连字符**而不是冒号：BullMQ v6 拒绝含 `:` 的自定义 id
   * （`Custom Id cannot contain :`）。同一个 eventId 只排一个任务。
   */
  async enqueueWebhookEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
  ): Promise<void> {
    await this.queue.add(
      PAYMENT_WEBHOOK_QUEUE,
      'payment',
      {
        tenantId,
        eventId: event.eventId,
        provider: event.provider,
        channel: event.channel,
        providerTxnId: event.providerTxnId,
        orderNo: event.orderNo,
        amount: event.amount,
        success: event.success,
      },
      `webhook-${event.provider}-${event.eventId}`,
    );
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
    const won = await this.orderService.transitionInTx(
      tx,
      order.id,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
      { paidAt: new Date() },
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
        const won = await this.orderService.transitionInTx(
          tx,
          order.id,
          order.status,
          OrderStatus.REFUNDED,
          {},
        );
        if (!won) {
          throw new ConflictException('订单当前状态不允许退款');
        }
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
   * ⚠️ **直接调处理逻辑，而不是发 HTTP 请求到 webhook 端点**——
   * 「服务调自己」会引入自我依赖（容器编排里还要处理网络地址问题）。
   * 直接调用同一段逻辑，既真实（幂等与状态机都被走到）又不脆弱。
   */
  async fakeConfirmPayment(paymentId: string): Promise<void> {
    const payment = await this.readPaymentAcrossTenants(paymentId);
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
      orderNo: order.orderNo,
      amount: payment.amount,
      success: true,
    };

    const check = await this.checkWebhookEvent(event);
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
   */
  async applyEvent(
    event: NormalizedWebhookEvent,
    tenantId: string,
  ): Promise<void> {
    await runForTenant(tenantId, async () => {
      // ⚠️ 用**返回 null** 的那个变体：查不到订单时**不抛异常**——
      // 抛了会让 BullMQ 把任务判为失败，而重试也不会让它变对
      // （订单确实不在这个租户下）。
      const order = await this.findOrderByNo(event.orderNo);
      if (!order) {
        this.logger.warn(
          `租户 ${tenantId} 下找不到订单 ${event.orderNo}（事件 ${event.eventId}）`,
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
   * 读「支付单 + 它的订单」的摘要（**跨租户**）。
   *
   * ⚠️ 给假网关的支付页面用——页面要显示订单号与金额，
   * 而渠道侧的请求没有租户上下文。
   */
  async readPaymentWithOrder(paymentId: string): Promise<{
    payment: Payment;
    order: { id: string; orderNo: string; totalAmount: number };
  }> {
    const payment = await this.readPaymentAcrossTenants(paymentId);
    const order = await this.findOrderAcrossTenantsById(payment.orderId);
    return {
      payment,
      order: {
        id: order.id,
        orderNo: order.orderNo,
        totalAmount: order.totalAmount,
      },
    };
  }

  /**
   * 按 id 读订单（**跨租户**）。
   *
   * ⚠️ 与 `readPaymentAcrossTenants` 同理：渠道侧场景用。
   */
  private async findOrderAcrossTenantsById(orderId: string): Promise<{
    id: string;
    orderNo: string;
    tenantId: string;
    totalAmount: number;
  }> {
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
