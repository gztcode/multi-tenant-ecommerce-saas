import { transactionOptions } from '../../common/db/transaction-options';
import { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import {
  platformScope,
  runForTenant,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CommissionService } from '../billing/commission.service';
import { ReceiptService } from '../billing/receipt.service';
import { OrderService } from '../order/order.service';
import { PaymentLookupService } from './payment-lookup.service';
import {
  NormalizedWebhookEvent,
  PaymentProvider,
  RefundResult,
} from './payment-provider.interface';
import { readableError, ReadableOrder, RefundOutcome } from './payment-types';
import { WebhookEventService } from './payment-webhook.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';

const REFUND_ATTEMPT_LIMIT = 3;
const REFUND_SCAN_THRESHOLD_MS = 10 * 60 * 1000;
const REFUND_SCAN_LIMIT = 50;
/**
 * RefundService —— 自 PaymentService（原 2600+ 行巨石）按职责拆出的部分（阶段 11）。
 *
 * 拆分是**纯机械搬移**：方法体与注释原样保留，只把跨组调用
 * （providerOf / find* / currentTenantId）改写为经 `this.lookup`（PaymentLookupService）。
 * 行为校验靠既有 959 条单测与 663 条 e2e；事务纪律靠 tx-boundary-scanner 的
 * 跨服务调用解析（this.svc.method 走类型解析，见 scanner 文档「形态 B」）。
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly lookup: PaymentLookupService,
    private readonly webhookEvents: WebhookEventService,
    private readonly orderService: OrderService,
    private readonly commission: CommissionService,
    private readonly receipt: ReceiptService,
  ) {}

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
    const order = await this.lookup.readOrderByNo(orderNo);

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
    const provider = this.lookup.providerOf(payment.channel);

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
      ? await this.lookup.findOrder({ id: payment.orderId })
      : null;
    if (!order) {
      this.logger.error(
        `REFUNDING 的支付单 ${paymentId} 找不到订单，无法核实退款，请人工核查`,
      );
      return false;
    }
    const provider = this.lookup.providerOf(payment.channel);
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
    await this.webhookEvents.markEventProcessed(event);
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
      ? await this.lookup.findOrder({ id: payment.orderId })
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
              tenantId: this.lookup.currentTenantId(),
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
}
