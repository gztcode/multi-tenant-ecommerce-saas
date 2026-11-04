/**
 * 三端共用的后端 API 客户端工厂（storefront / merchant-admin / platform-admin）。
 *
 * 实现体以 storefront 版为超集搬运：
 * - `request()` 分层（序列化在 try 外 / 网络错误收敛成 ApiError / 错误体解析兜底）
 * - 204 与空响应体的处理（空 body 当 null，不抛 JSON 解析错）
 * - 子域名头与 cookie 转发（storefront 专用能力，其余端显式传 false 不发）
 *
 * 各端的 `API_BASE_URL` 环境变量解析、NextAuth 的 `auth()` 都留在本端薄壳里，
 * 通过 `createApiClient` 的参数注入。
 */

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
export function localizeApiMessage(status: number, message: string): string {
  if (status === 401 && message === 'Unauthorized') {
    return '登录已过期，请重新登录';
  }
  return message;
}

/** 调后端的公共选项 */
export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  token?: string;
  /** 请求级子域名，覆盖工厂的 tenantSubdomain 缺省（storefront 按请求解析） */
  subdomain?: string;
  /**
   * 转发给后端的 Cookie 头。游客购物车靠它把 cart_token 送过去。
   * 仅当工厂的 forwardCookie 为 true 时才会真正发出。
   */
  cookie?: string;
}

/** apiFetchAuthed 的选项（在 ApiFetchOptions 上放开校验钩子） */
export interface ApiFetchAuthedOptions {
  method?: string;
  body?: unknown;
  validate?: (data: unknown) => unknown;
}

export interface SharedApiClientOptions {
  /** 例：/api/v1（三端各自的环境变量解析保持在本端壳里） */
  baseUrl: string;
  /** storefront 按请求传 subdomain（这里留 null）；merchant/platform 明确不发 */
  tenantSubdomain?: string | null;
  /**
   * 是否转发 Cookie 头。
   *
   * ⚠️ **必填**：漏配会静默降级成「不转发」，游客购物车因此丢车。
   *    三端显式传 `true`（storefront）/ `false`（两个后台）。
   */
  forwardCookie: boolean;
  /**
   * 本端 NextAuth 的 `auth()`，供 apiFetchAuthed 取 accessToken。
   * 必须由本端注入：共享包不依赖任何一端的 `@/auth`。
   */
  auth: () => Promise<{ accessToken?: string } | null>;
}

export interface SharedApiClient {
  ApiError: typeof ApiError;
  localizeApiMessage: typeof localizeApiMessage;
  apiFetch: <T>(
    path: string,
    options?: ApiFetchOptions & { validate?: (data: unknown) => T },
  ) => Promise<T>;
  apiFetchAuthed: <T>(
    path: string,
    options?: ApiFetchAuthedOptions,
  ) => Promise<T>;
  apiFetchWithSetCookie: <T>(
    path: string,
    options?: ApiFetchOptions,
  ) => Promise<{ data: T; setCookie: string | null }>;
  /**
   * 后端的**绝对地址**。
   *
   * ⚠️ **要拼的是 origin 而不是整个 base**：后端给的相对路径（如 payUrl）
   * 自带 `/api/v1` 前缀，再拼一遍就成了 `/api/v1/api/v1/...`。
   */
  apiAbsoluteUrl: (path: string) => string;
}

export function createApiClient(
  options: SharedApiClientOptions,
): SharedApiClient {
  const { baseUrl } = options;

  async function request(
    path: string,
    req: ApiFetchOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (req.token) {
      headers.authorization = `Bearer ${req.token}`;
    }
    const subdomain = req.subdomain ?? options.tenantSubdomain ?? undefined;
    if (subdomain) {
      headers['x-tenant-subdomain'] = subdomain;
    }
    if (options.forwardCookie && req.cookie) {
      headers.cookie = req.cookie;
    }

    // ⚠️ **序列化放在 `try` 外面**：body 含循环引用时 `JSON.stringify` 抛
    //    `TypeError`——那是「请求体构造失败」（调用方的 bug，400 级别），
    //    不是网络错误。若放在 `try` 里会被 catch 抓走，误报成
    //    `NETWORK_ERROR`(503)，把用户引向「检查网络」，还污染监控里
    //    「后端不可用」的信号。
    //    body 为 undefined 时保持 undefined，不能序列化成字符串 "undefined"。
    const body =
      req.body === undefined ? undefined : JSON.stringify(req.body);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: req.method ?? 'GET',
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

  /** 解析成功响应体：204 → undefined，空 body → null，其余 JSON.parse */
  async function parseBody<T>(response: Response): Promise<T> {
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

  async function apiFetch<T>(
    path: string,
    req: ApiFetchOptions & { validate?: (data: unknown) => T } = {},
  ): Promise<T> {
    const response = await request(path, req);
    const parsed = await parseBody<unknown>(response);

    if (!req.validate) return parsed as T;

    // validate 钩子在 JSON.parse 之后调用：校验失败收敛成 ApiError，
    // 让调用方走既有的错误展示路径（message 前缀「响应结构不符」）。
    try {
      return req.validate(parsed);
    } catch (cause) {
      throw new ApiError(
        response.status,
        'RESPONSE_SHAPE',
        `响应结构不符：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async function apiFetchAuthed<T>(
    path: string,
    req: ApiFetchAuthedOptions = {},
  ): Promise<T> {
    const session = await options.auth();
    // ⚠️ **没有令牌就显式 401**，不要发匿名请求：
    //    匿名请求会被后端按「游客」处理，写操作落到错误的身份上，
    //    而且界面拿到的是 403/404 这类误导性错误。
    // ⚠️ `UNAUTHENTICATED` 是**客户端本地错误码**（后端没有这个 code，
    //    后端 401 是 `UNAUTHORIZED`）；不要拿它去匹配后端错误码。
    if (!session?.accessToken) {
      throw new ApiError(401, 'UNAUTHENTICATED', '未登录或登录已过期');
    }
    return apiFetch<T>(path, {
      ...req,
      validate: req.validate as ((data: unknown) => T) | undefined,
      token: session.accessToken,
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
  async function apiFetchWithSetCookie<T>(
    path: string,
    req: ApiFetchOptions = {},
  ): Promise<{ data: T; setCookie: string | null }> {
    const response = await request(path, req);

    const setCookie = response.headers.get('set-cookie');
    const data = await parseBody<T>(response);
    return { data, setCookie };
  }

  function apiAbsoluteUrl(path: string): string {
    const origin = new URL(baseUrl).origin;
    return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
  }

  return {
    ApiError,
    localizeApiMessage,
    apiFetch,
    apiFetchAuthed,
    apiFetchWithSetCookie,
    apiAbsoluteUrl,
  };
}
