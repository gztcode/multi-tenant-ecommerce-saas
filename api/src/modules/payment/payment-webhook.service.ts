import { transactionOptions } from '../../common/db/transaction-options';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import { runForTenant } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CommissionService } from '../billing/commission.service';
import { InvoiceService } from '../billing/invoice.service';
import { ReceiptService } from '../billing/receipt.service';
import { CouponRedemptionService } from '../coupon/coupon-redemption.service';
import { OrderInventoryService } from '../order/inventory.service';
import { OrderService } from '../order/order.service';
import { QueueService } from '../queue/queue.service';
import { PaymentLookupService } from './payment-lookup.service';
import { NormalizedWebhookEvent } from './payment-provider.interface';
import { WebhookEventCheck } from './payment-types';
import { eventFromRow } from './webhook-event-row';
import { Injectable, Logger } from '@nestjs/common';
import {
  InvoiceStatus,
  OrderStatus,
  PaymentKind,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

/**
 * WebhookEventService —— 自 PaymentService（原 2600+ 行巨石）按职责拆出的部分（阶段 11）。
 *
 * 拆分是**纯机械搬移**：方法体与注释原样保留，只把跨组调用
 * （providerOf / find* / currentTenantId）改写为经 `this.lookup`（PaymentLookupService）。
 * 行为校验靠既有 959 条单测与 663 条 e2e；事务纪律靠 tx-boundary-scanner 的
 * 跨服务调用解析（this.svc.method 走类型解析，见 scanner 文档「形态 B」）。
 */
@Injectable()
export class WebhookEventService {
  private readonly logger = new Logger(WebhookEventService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly lookup: PaymentLookupService,
    private readonly orderService: OrderService,
    private readonly inventory: OrderInventoryService,
    private readonly queue: QueueService,
    private readonly couponRedemption: CouponRedemptionService,
    private readonly billingInvoices: InvoiceService,
    private readonly commission: CommissionService,
    private readonly receipt: ReceiptService,
  ) {}

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
      const invoice = await this.lookup.findInvoiceAcrossTenants(
        event.referenceNo,
      );
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

    const order = await this.lookup.findOrderAcrossTenants(event.referenceNo);
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
      const order = await this.lookup.findOrderByNo(event.referenceNo);
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
}
