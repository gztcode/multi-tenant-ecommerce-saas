/**
 * 管理端 NextAuth `authorize()` 用的登录请求。
 *
 * ⚠️ 抽成工厂是为了**可测**：`auth.ts` 顶层就调 `NextAuth({...})`，
 *    import 它会初始化 next-auth 的整个依赖图（含 `server-only`），
 *    测试里很难只测「登录请求带了什么头」。
 *
 * ⚠️ **必须转发真实客户端 IP**（`x-forwarded-for`）：后端 `/auth/login`
 *    按来源 IP 做防爆破计数，不转发时所有商家/平台员工登录都来自同一个
 *    BFF 容器 → 共用一个 30 次/15 分钟的桶，攻击者试错就能锁死登录。
 *    取值规则与 storefront 一致（见 `client-ip.ts`）：只发 XFF **最右**一项，
 *    取不到就**不发**这个头（假 IP 比没有更糟）。
 */

export interface LoginRequestOptions {
  /** 后端地址，含 `/api/v1` 前缀 */
  apiBaseUrl: string;
  /** 从入站请求取真实客户端 IP；返回 null 时不发 `x-forwarded-for` */
  clientIp?: (request?: Request | null) => string | null;
  /** 仅测试用；默认用全局 fetch（调用时解析，便于测试替换） */
  fetchImpl?: typeof fetch;
}

/**
 * `request` 就是 NextAuth 交给 `authorize(credentials, request)` 的那个入站请求。
 */
export type LoginRequest = (
  payload: Record<string, unknown>,
  request?: Request | null,
) => Promise<Response>;

export function createLoginRequest(
  options: LoginRequestOptions,
): LoginRequest {
  return async function requestLogin(payload, request) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    // ⚠️ **覆盖式**设置，不能追加：后端只信任一跳，取 XFF 最右一项；
    //    追加的话客户端伪造的值会留在右端，限流随之失效。
    if (options.clientIp) {
      let clientIp: string | null = null;
      try {
        clientIp = options.clientIp(request);
      } catch {
        // 取 IP 失败不能拖垮登录：退化成「不带这个头」。
        clientIp = null;
      }
      if (clientIp) {
        headers['x-forwarded-for'] = clientIp;
      }
    }

    const doFetch = options.fetchImpl ?? fetch;
    return doFetch(`${options.apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  };
}
