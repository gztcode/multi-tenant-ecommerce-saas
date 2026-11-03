import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Skip } from '../../common/decorators/skip.decorator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentKind } from '@prisma/client';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import {
  NormalizedWebhookEvent,
  PaymentProvider,
} from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';

/**
 * 支付渠道回调。
 *
 * ⚠️ 这个端点**不挂 JWT**（渠道回调没有登录态），**也不挂租户上下文**
 * （渠道回调不带子域名）。所以它必须自己做三件事：
 *
 * 1. **必须验签**，且**验签通过才能落库**（R1 / 护栏 11）。
 * 2. **租户从订单反查**，绝不采信请求体里的 tenantId（R14 / 护栏 14）。
 * 3. **只按订单 id 操作**，不接受任何指向别的租户的参数。
 *
 * ## ⚠️ 为什么顺序必须是「先验签，后落库」
 *
 * 反过来做（先落库再验签）的话，攻击路径是：
 * 攻击者抢先向本端点发一个 `eventId = "X"` 的伪造请求 → 落库占住了
 * `(provider, "X")` → 真实的支付回调随后到达，同一个 eventId 插入冲突 →
 * **被当作重复事件忽略** → 订单永远不流转到 `PAID`，而用户的钱已经付了。
 *
 * 唯一索引只是**第二道防线**，第一道是验签。验签失败 → 直接 401，
 * **一个字都不写进数据库**。
 *
 * ## 为什么处理逻辑入队而不是同步做
 *
 * 渠道回调要求「尽快返回」，而订单流转要加行锁、等事务。
 * 同步做的话，渠道会因为超时而**反复重投**同一笔回调。
 * 入队后端点只做「验签 → 核对金额 → 落事件行 → 投递」，消费端做业务流转。
 *
 * ⚠️ 但**金额核对必须在入队前做**（设计 §6.3）：
 * 金额都不对的事件根本不该进入处理流程。
 */
@ApiTags('payment-webhooks')
@Controller('webhooks')
// ⚠️ **跳过租户上下文拦截器**（`@Skip()`）：渠道回调**不带子域名**，
// 拦截器按子域名解析租户会直接 404。
//
// ⚠️ 跳过之后，本端点**完全不碰租户作用域模型**——
// 租户是从订单反查出来的（R14），反查走的是显式的 `platformScope()`。
// 漏了这个标记的典型症状：webhook 请求全部 404。
@Skip()
export class WebhookController {
  constructor(
    private readonly paymentService: PaymentService,
    // ⚠️ **回调也按注册表路由**（阶段 6a）：安全边界与创建支付时共用同一份
    // 事实。直接读 Map 的话，生产环境里 devOnly 的渠道照样能收到回调。
    private readonly registry: PaymentProviderRegistry,
  ) {}

  /**
   * 订单付款的回调。
   *
   * ⚠️ **与订阅的回调分成两个端点**（而不是一个端点里判断类型）：
   * 分流点由**端点本身**决定 —— 渠道适配器不需要猜「这笔是什么」。
   */
  @Post('payment/:channel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '渠道回调（验签后入队）' })
  async payment(
    @Param('channel') channel: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    return this.handleWebhook(request, channel, PaymentKind.ORDER);
  }

  /**
   * 订阅付款的回调。
   *
   * ⚠️ **与订单的回调分成两个端点**（而不是一个端点里判断类型）：
   * 分流点由**端点本身**决定 —— 渠道适配器不需要猜「这笔是什么」。
   */
  @Post('subscription/:channel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '订阅付款的渠道回调（验签后入队）' })
  async subscription(
    @Param('channel') channel: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    return this.handleWebhook(request, channel, PaymentKind.SUBSCRIPTION);
  }

  /**
   * 按回调 URL 里的渠道名取渠道实现。
   *
   * ⚠️ **注册表的 409 一律转 404**（阶段 6a）：webhook 端点是**公开且无租户**
   * 的，返回 409 等于在告诉调用方「这个渠道名我认识」。404 让「渠道不存在」
   * 与「这个 URL 从来就不存在」不可区分，不给攻击者任何探测面。
   *
   * ⚠️ **必须在验签之前**：未知渠道连签名都没法验（拿不到密钥），
   * 而且 404 意味着**一个字都不写进 `payment_webhook_events`**。
   */
  private resolveProvider(channel: string): PaymentProvider {
    try {
      return this.registry.get(channel);
    } catch (error) {
      if (error instanceof ConflictException) {
        throw new NotFoundException('支付渠道不存在');
      }
      throw error;
    }
  }

  /**
   * 两个端点共用的处理逻辑。
   *
   * ⚠️ **验签必须在落库之前**，失败抛异常 → HTTP 层转 401
   * （阶段 3 的顺序，不能反）。
   *
   * ⚠️ `kind` 决定反查哪张业务单（订单 / 账单），由**端点**传入，
   * 渠道适配器不需要猜「这笔是什么」。
   *
   * ⚠️ **`kind` 必须一路带到队列里**（`enqueueWebhookEvent` → 消费端
   * `applyEvent`）：消费端要靠它决定反查订单还是反查账单。
   */
  private async handleWebhook(
    request: RawBodyRequest<Request>,
    channel: string,
    kind: PaymentKind,
  ) {
    const provider = this.resolveProvider(channel);

    // ⚠️ **原始字节**——签名验的是原始 body，不是解析后的字段。
    // 先解析再验签的话，攻击者能改字段后重新算一个自洽的签名。
    //
    // ⚠️ `req.rawBody` 来自 Nest 的 `rawBody: true` 选项（见 main.ts）：
    // 默认的 JSON body parser 会把请求流消费掉，那时已经拿不到原始字节了。
    const raw = request.rawBody;
    if (!raw) {
      throw new BadRequestException('请求体为空');
    }

    // ---- 1. 验签（失败会抛 401，**一个字都不写进数据库**）----
    const event = provider.parseWebhook(raw, request.headers);

    // ---- 2. 事件类型分流（阶段 6c）：先验签、再判 eventType、最后落库 ----
    //
    // ⚠️ **顺序不能换**：先验签才能相信 `eventType`，先判类型才能在
    //    未知类型进事件表之前 400 —— 落库后再 400 的话，渠道会重投，
    //    而重投的同一个 eventId 又会因为唯一索引被当成「处理过」。
    //
    // ⚠️ **缺省按 `PAYMENT`**：存量渠道适配器还没发这个字段。
    const eventType = event.eventType ?? 'PAYMENT';
    if (eventType !== 'PAYMENT' && eventType !== 'REFUND') {
      throw new BadRequestException('未知的支付回调事件类型');
    }
    if (eventType === 'REFUND') {
      return this.handleRefundWebhook(event, kind);
    }

    // ---- 2. 金额核对 + 从业务单反查租户（R13 / R14）----
    //
    // ⚠️ **不核对就流转，等于「付 1 分钱买 100 元商品」**。
    // ⚠️ **租户从业务单反查**，绝不采信请求体里的 tenantId。
    const checked = await this.paymentService.checkWebhookEvent(event, kind);
    if (!checked.accepted || !checked.tenantId) {
      // 金额不符或订单不存在：只回「收到了」，不流转订单。
      // ⚠️ 回 200 而不是 4xx/5xx：渠道会因非 2xx 而**无限重投**同一个
      // 有问题的回调，而重投也不会让它变对。
      return { received: true, processed: false };
    }

    // ---- 3. 幂等落库（**验签之后**才插入，R1）----
    //
    // ⚠️ 唯一索引 `(provider, eventId)` 冲突 → 重复投递 → 直接返回成功，
    // 不再往下走。
    //
    // ⚠️ **`kind` 一起落库**（阶段 5f）：补偿扫描重新入队「上次没处理完」的
    // 事件时，靠事件行上的这一列决定反查订单还是反查账单。
    const inserted = await this.paymentService.insertEvent(event, kind);
    if (!inserted) {
      return { received: true, processed: false };
    }

    // ---- 4. 投递到 payment-webhook 队列异步消费 ----
    //
    // ⚠️ **`kind` 必须带进队列**：消费端要靠它决定反查订单还是反查账单。
    // 少了它，订阅回调会被当成订单回调而查不到订单——**静默丢掉**。
    await this.paymentService.enqueueWebhookEvent(
      event,
      checked.tenantId,
      kind,
    );

    return { received: true, processed: true };
  }

  /**
   * 退款事件：核对 + 幂等落库 + 入队（阶段 6c）。
   *
   * ⚠️ **与支付事件共用 `payment_webhook_events`**：按 `(provider, eventId)`
   *    去重。同一张表意味着支付与退款的 eventId 不能撞 —— 渠道侧本来就是
   *    不同的事件 id，但假网关用 `fake-<paymentId>` 派生的规则时，
   *    退款事件必须用不同的前缀（见 `fake-payment.provider.ts`）。
   *
   * ⚠️ **金额核对不可省**：退款额必须等于订单实付额。
   */
  private async handleRefundWebhook(
    event: NormalizedWebhookEvent,
    kind: PaymentKind,
  ) {
    // ⚠️ **退款只发生在订单支付上**：订阅退款的落账路径本阶段不做，
    //    收到订阅端点的退款事件要显式拒绝，而不是糊里糊涂走订单路径。
    if (kind !== PaymentKind.ORDER) {
      throw new BadRequestException('订阅支付不支持退款回调');
    }

    const checked = await this.paymentService.checkWebhookEvent(event, kind);
    if (!checked.accepted || !checked.tenantId) {
      // ⚠️ 回 200：金额不符 / 订单不存在时重投也不会变对
      return { received: true, processed: false };
    }

    const inserted = await this.paymentService.insertEvent(event, kind);
    if (!inserted) {
      return { received: true, processed: false };
    }

    await this.paymentService.enqueueWebhookEvent(
      event,
      checked.tenantId,
      kind,
    );
    return { received: true, processed: true };
  }
}
