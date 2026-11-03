import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  ChannelPayoutRecord,
  PayoutExecuteInput,
  PayoutProvider,
  PayoutQuery,
  PayoutQueryResult,
  PayoutSubmitResult,
} from './payout-provider.interface';
import { CHANNEL_LIST_PAGE_SIZE } from './payout.constants';

/** 沙箱出款渠道名 */
export const SANDBOX_PAYOUT_CHANNEL = 'sandbox';

/** 沙箱出款的服务提供方名 */
export const SANDBOX_PAYOUT_PROVIDER = 'sandbox';

/** 沙箱渠道地址未配置时的统一文案 */
export const SANDBOX_CHANNEL_URL_MISSING_MESSAGE =
  '沙箱渠道未配置 SANDBOX_CHANNEL_URL';

/** 单次 HTTP 调用超时预算（毫秒） */
const SANDBOX_HTTP_TIMEOUT_MS = 3_000;

/** 拉渠道流水时单页的超时预算（毫秒） */
const SANDBOX_LIST_TIMEOUT_MS = 10_000;

/** 沙箱渠道的根地址（去掉末尾斜杠）；未配置返回 `null` */
export function sandboxChannelUrl(): string | null {
  const raw = (process.env.SANDBOX_CHANNEL_URL ?? '').trim();
  return raw.length > 0 ? raw.replace(/\/+$/, '') : null;
}

/** 出款是否声明为异步（`SANDBOX_PAYOUT_ASYNC=true`） */
export function isSandboxPayoutAsync(): boolean {
  return process.env.SANDBOX_PAYOUT_ASYNC === 'true';
}

/** 沙箱渠道是否应被注册：非生产 + 配了地址 */
export function isSandboxPayoutRegistrable(): boolean {
  return process.env.NODE_ENV !== 'production' && sandboxChannelUrl() !== null;
}

/** 渠道侧出款响应（mock 服务的报文格式） */
interface SandboxPayoutResponse {
  referenceNo?: string;
  providerTxnId?: string;
  amount?: number;
  status?: string;
  definitive?: boolean;
  failureReason?: string;
  paidAt?: string;
}

/** 渠道侧分页响应 */
interface SandboxPayoutListResponse {
  items?: SandboxPayoutResponse[];
}

/**
 * 沙箱出款渠道（阶段 6b Task 11）。
 *
 * ## 它走真实 HTTP
 *
 * 所有调用都打到 `SANDBOX_CHANNEL_URL`（测试里是 `test/mock-channel-server.ts`），
 * 用来验证只有真网络才暴露的问题：超时、拒付、处理中、金额不一致。
 *
 * ## 失败语义
 *
 * - HTTP 超时 / 网络错误 / 5xx → **抛异常**，由调用方按 `definitive = false`
 *   处理（钱可能已经打出去，不能自动重试）；
 * - 渠道明确拒付 → `FAILED + definitive = true`，可以安全重试；
 * - 「查无此单」→ `queryPayout` 返回 `UNKNOWN`（**不是** `FAILED`）。
 */
@Injectable()
export class SandboxPayoutProvider implements PayoutProvider {
  readonly channel = SANDBOX_PAYOUT_CHANNEL;
  readonly provider = SANDBOX_PAYOUT_PROVIDER;
  readonly devOnly = true;
  readonly timeoutMs: number;

  /** @param timeoutMs 单次调用超时预算；不传用默认值（测试里可调小） */
  constructor(timeoutMs: number = SANDBOX_HTTP_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * ⚠️ **`asyncPayout` 恒为 true**：契约允许 `submit` 返回 `PROCESSING`，
   *    `SANDBOX_PAYOUT_ASYNC` 只决定 mock 服务默认是否异步，
   *    能力声明要与契约一致，而不是跟着环境变量漂移。
   */
  readonly capabilities = {
    refund: false,
    asyncRefund: false,
    asyncPayout: true,
    queryByReferenceNo: true,
    authorizedCharge: false,
    paymentMethod: false,
  };

  /** 提交打款：`POST /payout` */
  async submit(input: PayoutExecuteInput): Promise<PayoutSubmitResult> {
    const response = await this.request<SandboxPayoutResponse>(
      'POST',
      '/payout',
      {
        referenceId: input.referenceId,
        referenceNo: input.referenceNo,
        amount: input.amount,
        account: input.account,
        attempt: input.attempt,
      },
    );
    return toSubmitResult(response);
  }

  /**
   * 查一笔打款：`GET /payout/:referenceNo`。
   *
   * ⚠️ **只能按 `referenceNo` 查** —— mock 服务按业务单号索引；
   *    只给 `providerTxnId` 时视为查不到，返回 `UNKNOWN`（fail-closed）。
   */
  async queryPayout(query: PayoutQuery): Promise<PayoutQueryResult> {
    if (!query.referenceNo) {
      return { status: 'UNKNOWN' };
    }
    const response = await this.request<SandboxPayoutResponse | null>(
      'GET',
      `/payout/${encodeURIComponent(query.referenceNo)}`,
      undefined,
      { allowNotFound: true },
    );
    if (!response) {
      return { status: 'UNKNOWN' };
    }
    return toQueryResult(response);
  }

  /**
   * 批量拉渠道流水：`GET /payouts`。
   *
   * ⚠️ **契约 A**：mock 服务若没给满一页（或忽略 `pageSize`），这里补拉后续页，
   *    拼满 `pageSize` 再返回 —— 调用方靠「本页不满」判断到底。
   * ⚠️ **契约 B**：`NaN` / `Infinity` 回落默认值，**绝不返回空数组**。
   */
  async listPayouts(query: {
    from: Date;
    to: Date;
    page?: number;
    pageSize?: number;
  }): Promise<ChannelPayoutRecord[]> {
    const paged = query.page !== undefined || query.pageSize !== undefined;
    if (!paged) {
      const response = await this.request<SandboxPayoutListResponse>(
        'GET',
        `/payouts${toQueryString({ from: query.from.toISOString(), to: query.to.toISOString() })}`,
        undefined,
        { timeoutMs: SANDBOX_LIST_TIMEOUT_MS },
      );
      return (response.items ?? []).map(toRecord);
    }

    const page =
      query.page !== undefined && Number.isFinite(query.page)
        ? Math.max(1, query.page)
        : 1;
    const pageSize =
      query.pageSize !== undefined && Number.isFinite(query.pageSize)
        ? Math.max(1, query.pageSize)
        : CHANNEL_LIST_PAGE_SIZE;

    const records: ChannelPayoutRecord[] = [];
    let channelPage = page;
    // ⚠️ 上限只是防死循环；正常最多翻 ceil(pageSize / 渠道单页上限) 次
    for (let round = 0; round < 100 && records.length < pageSize; round++) {
      const response = await this.request<SandboxPayoutListResponse>(
        'GET',
        `/payouts${toQueryString({
          from: query.from.toISOString(),
          to: query.to.toISOString(),
          page: channelPage,
          pageSize,
        })}`,
        undefined,
        { timeoutMs: SANDBOX_LIST_TIMEOUT_MS },
      );
      const items = response.items ?? [];
      if (items.length === 0) {
        break;
      }
      records.push(...items.map(toRecord));
      if (items.length < pageSize) {
        break;
      }
      channelPage += 1;
    }
    return records.slice(0, pageSize);
  }

  /** 发一次 HTTP 请求并解析 JSON；超时 / 网络错误 / 5xx 一律抛异常 */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    options: { allowNotFound?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const base = sandboxChannelUrl();
    if (!base) {
      throw new ServiceUnavailableException(
        SANDBOX_CHANNEL_URL_MISSING_MESSAGE,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // ⚠️ **超时 / 连接断开 = 结果未知** —— 必须抛，而不是编一个 FAILED：
      //    调用方据此落 `definitive = false`，不会自动重试。
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

function toSubmitResult(value: SandboxPayoutResponse): PayoutSubmitResult {
  const status = (value.status ?? '').toUpperCase();
  if (status === 'SUCCESS') {
    return {
      status: 'SUCCESS',
      providerTxnId: value.providerTxnId ?? '',
      amount: value.amount ?? 0,
      paidAt: value.paidAt ? new Date(value.paidAt) : undefined,
    };
  }
  if (status === 'PROCESSING') {
    return {
      status: 'PROCESSING',
      providerTxnId: value.providerTxnId,
      amount: value.amount,
    };
  }
  // ⚠️ **只有渠道明说失败、且 `definitive === true` 才算「确定没打」**；
  //    拿不准的一律当结果未知（调用方不能自动重试）。
  return {
    status: 'FAILED',
    providerTxnId: value.providerTxnId,
    amount: value.amount,
    definitive: value.definitive === true,
    failureReason: value.failureReason,
  };
}

function toQueryResult(value: SandboxPayoutResponse): PayoutQueryResult {
  const status = (value.status ?? '').toUpperCase();
  if (status === 'SUCCESS') {
    return {
      status: 'SUCCESS',
      providerTxnId: value.providerTxnId,
      amount: value.amount,
      paidAt: value.paidAt ? new Date(value.paidAt) : undefined,
    };
  }
  if (status === 'PROCESSING') {
    return {
      status: 'PROCESSING',
      providerTxnId: value.providerTxnId,
      amount: value.amount,
    };
  }
  if (status === 'FAILED') {
    return {
      status: 'FAILED',
      providerTxnId: value.providerTxnId,
      amount: value.amount,
      definitive: value.definitive === true,
      failureReason: value.failureReason,
    };
  }
  // ⚠️ **认不出的渠道状态 ≠ 渠道说没打** —— fail-closed 到 `UNKNOWN`
  return { status: 'UNKNOWN', providerTxnId: value.providerTxnId };
}

function toRecord(value: SandboxPayoutResponse): ChannelPayoutRecord {
  return {
    referenceNo: value.referenceNo,
    providerTxnId: value.providerTxnId ?? '',
    amount: value.amount ?? 0,
    status: value.status ?? '',
    paidAt: value.paidAt ? new Date(value.paidAt) : undefined,
    failureReason: value.failureReason,
  };
}

function toQueryString(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return `?${search.toString()}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // AbortSignal.timeout 触发时是 TimeoutError
    return error.name === 'TimeoutError' ? '请求超时' : error.message;
  }
  return String(error);
}
