import { headers } from 'next/headers';
import { auth } from '@/auth';
import { createApiClient } from '@ecom/frontend-shared/api-client';
import { pickClientIp } from '@ecom/frontend-shared/client-ip';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

/**
 * 取**真实客户端 IP**，转给后端做按来源隔离的防爆破计数。
 *
 * 取值规则（只认入站 `x-forwarded-for` 的**最右**一项，取不到返回 null
 * → 共享包**不发**这个头）单源在 `@ecom/frontend-shared/client-ip`，
 * 与两个管理端共用；这里只负责在 Next 请求作用域里读头。
 *
 * ⚠️ **只取最右**：取最左等于把限流的钥匙交给客户端——换个
 *    `x-forwarded-for` 就能绕过防爆破。
 * ⚠️ 取不到时**绝不塞假 IP**：假 IP 会被当成一个真实来源，白白多出一个
 *    计数桶，而且看起来「有防护」，实际按桶隔离错了。
 */
async function currentClientIp(): Promise<string | null> {
  // 浏览器端不取：浏览器没有真实 IP，硬塞一个客户端可控的值等于开绕过口。
  if (typeof window !== 'undefined') return null;

  try {
    const inbound = await headers();
    return pickClientIp(inbound.get('x-forwarded-for'));
  } catch {
    // headers() 在非请求作用域（静态渲染）会抛——取不到就当没有。
    return null;
  }
}

const shared = createApiClient({
  baseUrl: API_BASE_URL,
  // 子域名是**按请求**解析的（server-cart 的 currentSubdomain() 逐请求传
  // options.subdomain），这里没有全局缺省值，明确不发。
  tenantSubdomain: null,
  // 游客购物车靠透传 cart_token cookie（server-cart 的 forwardableCookie()）。
  forwardCookie: true,
  auth,
  // 后端（游客查单的防爆破计数）要按真实来源 IP 隔离，代理头由这里转发。
  clientIp: currentClientIp,
});

export const ApiError = shared.ApiError;
export const localizeApiMessage = shared.localizeApiMessage;
export const apiFetch = shared.apiFetch;
export const apiFetchAuthed = shared.apiFetchAuthed;
export const apiFetchWithSetCookie = shared.apiFetchWithSetCookie;
export type { ApiFetchOptions } from '@ecom/frontend-shared/api-client';
