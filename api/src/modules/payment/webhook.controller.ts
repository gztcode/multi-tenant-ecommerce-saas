import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Skip } from '../../common/decorators/skip.decorator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { PaymentProvider } from './payment-provider.interface';
import { PAYMENT_PROVIDERS } from './payment.constants';

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
@Controller('webhooks/payment')
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
    @Inject(PAYMENT_PROVIDERS)
    private readonly providers: Map<string, PaymentProvider>,
  ) {}

  @Post(':channel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '渠道回调（验签后入队）' })
  async handle(
    @Param('channel') channel: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const provider = this.providers.get(channel);
    if (!provider) {
      throw new NotFoundException('未知的支付渠道');
    }

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

    // ---- 2. 金额核对 + 从订单反查租户（R13 / R14）----
    //
    // ⚠️ **不核对就流转，等于「付 1 分钱买 100 元商品」**。
    // ⚠️ **租户从订单反查**，绝不采信请求体里的 tenantId。
    const checked = await this.paymentService.checkWebhookEvent(event);
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
    const inserted = await this.paymentService.insertEvent(event);
    if (!inserted) {
      return { received: true, processed: false };
    }

    // ---- 4. 投递到 payment-webhook 队列异步消费 ----
    await this.paymentService.enqueueWebhookEvent(event, checked.tenantId);

    return { received: true, processed: true };
  }
}
