import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ChargeAuthorizedInput,
  ChargeAuthorizedResult,
  CreatePaymentInput,
  CreatePaymentResult,
  NormalizedWebhookEvent,
  PaymentProvider,
  QueryPaymentResult,
  RefundQueryResult,
  RefundResult,
} from './payment-provider.interface';
import {
  SANDBOX_CHANNEL_URL_MISSING_MESSAGE,
  sandboxChannelUrl,
} from '../../common/payment/sandbox-payout.provider';

/** 沙箱支付渠道名 */
export const SANDBOX_PAYMENT_CHANNEL = 'sandbox';

/** 沙箱支付的服务提供方名 */
export const SANDBOX_PAYMENT_PROVIDER = 'sandbox';

/** 沙箱回调的签名请求头 */
export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

/** 单次 HTTP 调用超时预算（毫秒） */
const SANDBOX_HTTP_TIMEOUT_MS = 3_000;

/**
 * 取沙箱回调的共享密钥。
 *
 * ⚠️ 没配时返回 `null` 而不是空串 —— 空串会让验签形同虚设。
 */
export function sandboxPaymentSecret(): string | null {
  const secret = process.env.SANDBOX_PAYMENT_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

/** 沙箱支付是否应被注册：非生产 + 配了地址 */
export function isSandboxPaymentRegistrable(): boolean {
  return process.env.NODE_ENV !== 'production' && sandboxChannelUrl() !== null;
}

/** 渠道侧支付响应 */
interface SandboxPayResponse {
  providerTxnId?: string;
  payload?: { url?: string; status?: string } & Record<string, unknown>;
  expiresAt?: string;
  status?: string;
}

/**
 * 沙箱支付渠道（阶段 6b Task 11）。
 *
 * ⚠️ **退款仍是同步契约**（`asyncRefund: false`）—— 异步退款在 6c 才改，
 *    这里只对齐 mock 服务的 `/refund` 骨架。
 */
@Injectable()
export class SandboxPaymentProvider implements PaymentProvider {
  readonly channel = SANDBOX_PAYMENT_CHANNEL;
  readonly provider = SANDBOX_PAYMENT_PROVIDER;
  readonly devOnly = true;
  readonly timeoutMs = SANDBOX_HTTP_TIMEOUT_MS;

  readonly capabilities = {
    refund: true,
    // ⚠️ **声明为异步退款**（阶段 6c）：沙箱可以返回 `PROCESSING`，
    //    调用方必须走「受理 → 查询 / 回调」而不是「调用即成功」。
    asyncRefund: true,
    asyncPayout: false,
    queryByReferenceNo: false,
    authorizedCharge: true,
    paymentMethod: true,
  };

  /** 发起支付：`POST /pay`，返回沙箱支付页面 URL */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const response = await this.request<SandboxPayResponse>('POST', '/pay', {
      referenceId: input.referenceId,
      referenceNo: input.referenceNo,
      amount: input.amount,
      subject: input.subject,
    });
    return {
      providerTxnId: response.providerTxnId ?? input.referenceId,
      payload: response.payload ?? {},
      expiresAt: response.expiresAt
        ? new Date(response.expiresAt)
        : new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  /** 查支付状态：`GET /pay/:paymentId` */
  async queryPayment(providerTxnId: string): Promise<QueryPaymentResult> {
    const response = await this.request<SandboxPayResponse>(
      'GET',
      `/pay/${encodeURIComponent(providerTxnId)}`,
      undefined,
      { allowNotFound: true },
    );
    return { status: response?.status ?? 'UNKNOWN' };
  }

  /** 退款：`POST /refund`（阶段 6c：可能返回 `PROCESSING`） */
  async refund(
    paymentId: string,
    amount: number,
    reason: string,
  ): Promise<RefundResult> {
    const response = await this.request<{
      status?: string;
      refundTxnId?: string;
      definitive?: boolean;
      failureReason?: string;
    }>('POST', '/refund', {
      paymentId,
      amount,
      reason,
    });

    const refundTxnId = response.refundTxnId;
    switch (response.status) {
      case 'SUCCESS':
        return { status: 'SUCCESS', refundTxnId };
      case 'PROCESSING':
        return { status: 'PROCESSING', refundTxnId };
      case 'FAILED':
        return {
          status: 'FAILED',
          // ⚠️ **缺省按「结果未知」** —— 渠道没说「确定没退」，就不能让调用方重试
          definitive: response.definitive === true,
          refundTxnId,
          failureReason: response.failureReason,
        };
      default:
        // ⚠️ 未知状态按「结果未知的失败」处理，绝不是成功
        return {
          status: 'FAILED',
          definitive: false,
          refundTxnId,
          failureReason: `沙箱渠道返回未知退款状态：${response.status ?? '空'}`,
        };
    }
  }

  /**
   * 查退款状态：`GET /refund/:refundTxnId`（阶段 6c）。
   *
   * ⚠️ **查无此单 → `UNKNOWN`** —— 绝不冒充 `FAILED`（那会让运营重试 → 重复退款）。
   */
  async queryRefund(refundTxnId: string): Promise<RefundQueryResult> {
    const response = await this.request<{
      status?: string;
      refundTxnId?: string;
      definitive?: boolean;
      failureReason?: string;
    }>('GET', `/refund/${encodeURIComponent(refundTxnId)}`, undefined, {
      allowNotFound: true,
    });
    if (!response || !response.status) {
      return { status: 'UNKNOWN', refundTxnId };
    }
    switch (response.status) {
      case 'SUCCESS':
      case 'PROCESSING':
        return { status: response.status, refundTxnId };
      case 'FAILED':
        return {
          status: 'FAILED',
          definitive: response.definitive === true,
          refundTxnId,
          failureReason: response.failureReason,
        };
      default:
        return { status: 'UNKNOWN', refundTxnId };
    }
  }

  /** 用已授权的支付方式扣款：`POST /pay`（带 `authorized` 标记） */
  async chargeAuthorized(
    input: ChargeAuthorizedInput,
  ): Promise<ChargeAuthorizedResult> {
    const response = await this.request<SandboxPayResponse>('POST', '/pay', {
      referenceId: input.referenceId,
      referenceNo: input.referenceNo,
      amount: input.amount,
      subject: input.subject,
      authorized: true,
      paymentMethodToken: input.paymentMethodToken,
    });
    return {
      providerTxnId: response.providerTxnId ?? input.referenceId,
      status: response.status ?? response.payload?.status ?? 'FAILED',
    };
  }

  /** 创建已授权支付方式：`POST /payment-method` */
  async createPaymentMethod(input: {
    type: string;
  }): Promise<{ token: string }> {
    const response = await this.request<{ token?: string }>(
      'POST',
      '/payment-method',
      { type: input.type },
    );
    if (!response.token) {
      throw new ServiceUnavailableException('沙箱渠道未返回支付方式凭证');
    }
    return { token: response.token };
  }

  /**
   * 解析渠道回调：HMAC-SHA256 验签 + 归一化。
   *
   * ⚠️ **验签失败必须抛异常** —— webhook controller 据此返回 401，
   *    且保证一个字都不写进数据库。
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedWebhookEvent {
    const secret = sandboxPaymentSecret();
    if (!secret) {
      throw new ServiceUnavailableException(
        '沙箱渠道未配置 SANDBOX_PAYMENT_SECRET',
      );
    }

    const provided = headers[SANDBOX_SIGNATURE_HEADER];
    const signature = Array.isArray(provided) ? provided[0] : provided;
    if (!signature) {
      throw new UnauthorizedException('缺少沙箱回调签名');
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!constantTimeEquals(signature, expected)) {
      throw new UnauthorizedException('沙箱回调签名不正确');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('沙箱回调内容不是合法的 JSON');
    }

    const eventId = readString(payload, 'eventId');
    const providerTxnId = readString(payload, 'providerTxnId');
    const referenceNo = readString(payload, 'referenceNo');
    const amount = payload.amount;

    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException('沙箱回调的金额不合法');
    }

    // ---- 事件类型（阶段 6c）----
    // ⚠️ **缺省按 `PAYMENT`** —— 存量回调不带这个字段，升级期间必须继续可用。
    // ⚠️ `readString` 对「缺字段」与「空串」都返回 `null` —— 两者都按缺省处理。
    const rawEventType = readString(payload, 'eventType');
    const eventType =
      rawEventType === null || rawEventType === 'PAYMENT'
        ? ('PAYMENT' as const)
        : rawEventType === 'REFUND'
          ? ('REFUND' as const)
          : null;
    if (eventType === null) {
      throw new BadRequestException(`未知的沙箱回调事件类型：${rawEventType}`);
    }

    if (eventType === 'REFUND') {
      const refundTxnId = readString(payload, 'refundTxnId');
      const rawRefundStatus = readString(payload, 'refundStatus');
      const refundStatus =
        rawRefundStatus === 'SUCCESS' ||
        rawRefundStatus === 'FAILED' ||
        rawRefundStatus === 'PROCESSING'
          ? rawRefundStatus
          : null;
      if (!eventId || !referenceNo || !refundTxnId || refundStatus === null) {
        throw new BadRequestException('沙箱退款回调缺少必要字段');
      }
      return {
        provider: this.provider,
        channel: this.channel,
        eventId,
        // ⚠️ 退款回调可能不带支付交易号 —— 用空串表示「没有」，不引入可空字段
        providerTxnId: providerTxnId ?? '',
        referenceNo,
        amount,
        success: refundStatus === 'SUCCESS',
        eventType: 'REFUND',
        refundTxnId,
        refundStatus,
      };
    }

    if (!eventId || !providerTxnId || !referenceNo) {
      throw new BadRequestException('沙箱回调缺少必要字段');
    }

    return {
      provider: this.provider,
      channel: this.channel,
      eventId,
      providerTxnId,
      referenceNo,
      amount,
      success: payload.success === true,
      eventType: 'PAYMENT',
    };
  }

  /** 发一次 HTTP 请求并解析 JSON；超时 / 网络错误 / 5xx 一律抛异常 */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    options: { allowNotFound?: boolean } = {},
  ): Promise<T> {
    const base = sandboxChannelUrl();
    if (!base) {
      throw new ServiceUnavailableException(
        SANDBOX_CHANNEL_URL_MISSING_MESSAGE,
      );
    }

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(SANDBOX_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `沙箱渠道调用失败（${method} ${path}）：${describeError(error)}`,
      );
    }

    if (response.status === 404 && options.allowNotFound === true) {
      return null as T;
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `沙箱渠道返回 HTTP ${response.status}（${method} ${path}）`,
      );
    }
    return (await response.json()) as T;
  }
}

/** 常量时间比较两个 hex 字符串（长度不等直接 false） */
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? '请求超时' : error.message;
  }
  return String(error);
}
