import { auth } from '@/auth';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  // 注意：平台超管后台不带 x-tenant-subdomain——中心域名没有「当前店铺」，
  // 超管令牌本身就是跨租户的（tenantId 为 null）。

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });

  if (!response.ok) {
    // 错误响应体是 { code, message, details?, traceId }；网络层出错或后端返回了
    // 非 JSON（例如反向代理的 502 HTML）时不能让它盖掉真正的错误，兜底成空对象。
    const payload = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      details?: unknown;
    };
    throw new ApiError(
      response.status,
      payload.code ?? 'UNKNOWN',
      payload.message ?? '请求失败',
      payload.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  // ⚠️ **空响应体当成 null**：后端在没有数据时返回 200 + 空 body
  // （NestJS 的 handler 返回 null 就是这样），`response.json()` 碰到空 body
  // 会抛「Unexpected end of JSON input」—— 真实情况是「没有数据」，
  // 界面上却显示成「加载失败」。
  const text = await response.text();
  if (text.trim() === '') return null as T;
  return JSON.parse(text) as T;
}

/** 带登录态调用后端 */
export async function apiFetchAuthed<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await auth();
  return apiFetch<T>(path, {
    ...options,
    token: session?.accessToken,
  });
}