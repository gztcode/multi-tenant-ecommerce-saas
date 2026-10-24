import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  NormalizedWebhookEvent,
  PaymentProvider,
  QueryPaymentResult,
  RefundResult,
} from './payment-provider.interface';

/** 假网关的渠道名 */
export const FAKE_CHANNEL = 'fake';

/** 假网关的服务提供方名 */
export const FAKE_PROVIDER = 'fake';

/** 假网关回调的签名请求头 */
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/**
 * 假支付网关是否启用。
 *
 * ⚠️ **默认关闭**（不设就是关）。这不是便利开关，是**安全边界**——
 * 假网关的支付页面无需登录，知道 paymentId 就能把订单付掉。
 */
export function isFakePaymentEnabled(): boolean {
  return process.env.FAKE_PAYMENT_ENABLED === 'true';
}

/**
 * 取假网关的共享密钥。
 *
 * ⚠️ 没配密钥时**不能**用空串当默认值——空串会让「验签」形同虚设
 * （任何人都能用空签名通过）。所以这里返回 null，由调用方拒绝。
 */
export function fakePaymentSecret(): string | null {
  const secret = process.env.FAKE_PAYMENT_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

/**
 * 本地假支付网关（阶段 3 Task 5）。
 *
 * ## 它不是「临时的假实现」
 *
 * 它是一个**能跑通全链路的真渠道**：
 * - 有自己的支付页面（`GET /api/v1/pay/fake/:paymentId`）
 * - 有自己的回调格式与验签方式（HMAC-SHA256 签整个原始 body）
 * - 回调走的是**同一个** webhook 消费逻辑
 *
 * 所以阶段 3 的验收（幂等、金额核对、状态机）测的是**真的在跑**的那条路，
 * 不是一条专用给测试的旁路。
 *
 * ## 为什么它直接调 webhook 处理逻辑而不是发 HTTP 请求
 *
 * 「服务调自己」会引入自我依赖，在容器编排里还要处理网络地址问题。
 * 直接调用同一段处理逻辑，既真实（幂等与状态机都被走到）又不脆弱。
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  readonly channel = FAKE_CHANNEL;
  readonly provider = FAKE_PROVIDER;

  /**
   * 发起支付。
   *
   * ⚠️ 开关没开时直接抛错——不是「返回一个假 URL」，
   * 那样调用方会以为支付成功了。
   */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!isFakePaymentEnabled()) {
      throw new ServiceUnavailableException('本地假支付网关未启用');
    }
    return Promise.resolve({
      // ⚠️ 用 paymentId 本身当渠道交易号：假网关的「支付单」与「渠道交易」
      // 是一一对应的，省掉一层映射。
      providerTxnId: input.orderId,
      payload: {
        // 支付页面 URL。**不带 host**——前端拿到的相对路径自己拼域名，
        // 免得后端猜错了对外地址。
        payUrl: `/api/v1/pay/fake/${input.orderId}`,
        orderNo: input.orderNo,
        amount: input.amount,
        subject: input.subject,
      },
      // 与订单的支付超时窗口对齐（15 分钟，设计 §九）。
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  }

  queryPayment(providerTxnId: string): Promise<QueryPaymentResult> {
    // 假网关没有「主动查询」的能力：支付状态由回调推动。
    // 返回 PENDING 而不是抛错，让调用方知道「还没收到结果」而不是「查不了」。
    return Promise.resolve({ status: providerTxnId ? 'PENDING' : 'UNKNOWN' });
  }

  refund(
    paymentId: string,
    amount: number,
    reason: string,
  ): Promise<RefundResult> {
    if (!isFakePaymentEnabled()) {
      throw new ServiceUnavailableException('本地假支付网关未启用');
    }
    // 假网关的退款是「立即成功」的：本地环境没有真的资金通道。
    // ⚠️ 参数照收不用——真实渠道要用它们（退款单号、金额、原因），
    // 这里记一笔免得 IDE 报「未使用」。
    void paymentId;
    void amount;
    void reason;
    return Promise.resolve({ status: 'REFUNDED' });
  }

  /**
   * 解析渠道回调：验签 + 归一化。
   *
   * ⚠️ **验签是这一步的第一件事**，而且失败时**抛异常**——
   * 调用方（webhook controller）据此返回 401 且**一个字都不写进数据库**。
   *
   * ⚠️ 签名覆盖的是**原始 body 字节**，不是解析后的字段：
   * 真实渠道也是对原始字节签名。若先解析再验签，攻击者可以改字段后
   * 重新算一个自洽的签名——那样就根本没有验签了。
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedWebhookEvent {
    const secret = fakePaymentSecret();
    if (!secret) {
      throw new ServiceUnavailableException('本地假支付网关未配置共享密钥');
    }

    const provided = headers[FAKE_SIGNATURE_HEADER];
    const signature = Array.isArray(provided) ? provided[0] : provided;
    if (!signature) {
      throw new UnauthorizedException('缺少支付回调签名');
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    // ⚠️ 用 timingSafeEqual 比而不是 `===`：
    // `===` 会在第一个不同的字节处短路，理论上给攻击者一个「逐字节猜」的时间差信号。
    if (!constantTimeEquals(signature, expected)) {
      throw new UnauthorizedException('支付回调签名不正确');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('支付回调内容不是合法的 JSON');
    }

    const eventId = readString(payload, 'eventId');
    const providerTxnId = readString(payload, 'providerTxnId');
    const orderNo = readString(payload, 'orderNo');
    const amount = readNumber(payload, 'amount');
    const success = payload.success === true;

    if (!eventId || !providerTxnId || !orderNo) {
      throw new BadRequestException('支付回调缺少必要字段');
    }
    if (amount === null || !Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException('支付回调的金额不合法');
    }

    return {
      provider: this.provider,
      channel: this.channel,
      eventId,
      providerTxnId,
      orderNo,
      amount,
      success,
    };
  }
}

/**
 * 常量时间比较两个 hex 字符串。
 *
 * ⚠️ 长度不等时**不能**直接返回 false 再走 timingSafeEqual——
 * 那条 API 要求两个 buffer 等长。先比长度（长度本身不是秘密），
 * 再走常量时间比较内容。
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === 'number' ? value : null;
}
