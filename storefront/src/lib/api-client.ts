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
  options: ApiFetchOptions = {},
): Promise<T> {
  const response = await request(path, options);

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** 调后端的公共选项 */
export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  token?: string;
  subdomain?: string;
  /** 转发给后端的 Cookie 头。游客购物车靠它把 cart_token 送过去 */
  cookie?: string;
}

/** 发请求并把错误响应转成 ApiError */
async function request(
  path: string,
  options: ApiFetchOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.subdomain) {
    headers['x-tenant-subdomain'] = options.subdomain;
  }
  if (options.cookie) {
    headers.cookie = options.cookie;
  }

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

  return response;
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

/**
 * 调后端并把 `Set-Cookie` 一并带回来。
 *
 * 游客购物车需要这个：后端在第一次访问购物车时生成 `cart_token` 写进
 * `Set-Cookie`（HttpOnly，浏览器拿不到）。storefront 是服务端渲染，
 * 后端种下的 cookie 必须由 storefront **转写**到浏览器自己的 cookie 上，
 * 否则下一次请求（换页、刷新）就没有 cart_token，游客车就「丢了」。
 *
 * ⚠️ 后端返回的 `Set-Cookie` 带了 `HttpOnly` 与 `SameSite` 等属性，
 * 转写时要**原样保留**——丢掉 HttpOnly 会让 JS 能读到 token，
 * 丢掉 SameSite 会让 cookie 的跨站行为变松。
 */
export async function apiFetchWithSetCookie<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<{ data: T; setCookie: string | null }> {
  const response = await request(path, options);

  const setCookie = response.headers.get('set-cookie');

  if (response.status === 204) {
    return { data: undefined as T, setCookie };
  }

  return { data: (await response.json()) as T, setCookie };
}
