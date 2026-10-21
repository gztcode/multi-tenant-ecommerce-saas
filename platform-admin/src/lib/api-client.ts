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

  return (await response.json()) as T;
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