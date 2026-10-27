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

/** 网络不可达时的用户可见文案。 */
const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

/**
 * 把后端返回的消息翻成用户能看懂的中文。
 *
 * ⚠️ 只翻译后端的**默认文案**（Nest 的 'Unauthorized'），
 * 不动后端主动抛的中文消息（'刷新令牌无效或已过期'）——
 * 那些消息比通用文案更具体，翻译会丢掉信息。
 *
 * ⚠️ **按文案匹配是刻意的**：后端主动抛的中文消息，状态码同样是 401，
 * `AllExceptionsFilter` 按状态码映射出来的 `code` 也是 `UNAUTHORIZED`
 * —— 若改成按 `code` 匹配，那些更具体的中文消息会被覆盖成通用文案，
 * 反而丢信息。
 *
 * ⚠️ **代价：与后端的默认文案硬耦合**。后端把 `UnauthorizedException()`
 * 的默认文案改掉（哪怕只是多个句号），这里的翻译会**静默失效**，
 * 用户直接看到英文。后端改文案时要一并改这里。
 */
function localizeApiMessage(status: number, message: string): string {
  if (status === 401 && message === 'Unauthorized') {
    return '登录已过期，请重新登录';
  }
  return message;
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const response = await request(path, options);

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

  // ⚠️ **序列化放在 `try` 外面**：body 含循环引用时 `JSON.stringify` 抛
  //    `TypeError`——那是「请求体构造失败」（调用方的 bug，400 级别），
  //    不是网络错误。若放在 `try` 里会被 catch 抓走，误报成
  //    `NETWORK_ERROR`(503)，把用户引向「检查网络」，还污染监控里
  //    「后端不可用」的信号。
  //    body 为 undefined 时保持 undefined，不能序列化成字符串 "undefined"。
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      cache: 'no-store',
    });
  } catch {
    // 网络层失败：后端根本没连上，不是业务错误。
    // ⚠️ 收敛成 ApiError 是关键——所有渲染点写的是 `cause.message`，
    //    不收敛的话用户看到的就是原始的 "TypeError: fetch failed"。
    throw new ApiError(503, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
  }

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
      localizeApiMessage(response.status, payload.message ?? '请求失败'),
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

  // ⚠️ 同 apiFetch：空 body 当 null
  const text = await response.text();
  if (text.trim() === '') return { data: null as T, setCookie };
  return { data: JSON.parse(text) as T, setCookie };
}
