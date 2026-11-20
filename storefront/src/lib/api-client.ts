import { headers } from 'next/headers';
import { auth } from '@/auth';
import { createApiClient } from '@ecom/frontend-shared/api-client';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

/**
 * IP 的**形状**校验：只允许十六进制数字、点、冒号。
 *
 * ⚠️ 这是白名单而不是「是不是合法 IP」：目的是**挡掉能进 HTTP 头的字符**
 *    （换行、逗号、空格等），顺带挡掉明显不是 IP 的垃圾值。
 *    宽松一点没关系——拿不到可信 IP 时宁可不发头（见下），
 *    误判成「合法」的最坏后果也只是多一个计数桶。
 */
const IP_SHAPE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * 取**真实客户端 IP**，转给后端做按来源隔离的防爆破计数。
 *
 * ## 取哪个值
 *
 * 网关（`infra/nginx/templates/prod.conf.template`）用
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`，
 * 也就是把真实对端**追加到右端**、客户端自带的伪造值留在左端。
 * 所以入站头的**最右**一项才是真实客户端 IP，**最左**是客户端可控的。
 *
 * ⚠️ **只取最右**：取最左等于把限流的钥匙交给客户端——换个
 *    `x-forwarded-for` 就能绕过防爆破。
 *
 * ## 取不到怎么办
 *
 * 返回 null → 共享包**不发** `x-forwarded-for`。
 * 不塞假 IP：假 IP 会被当成一个真实来源，白白多出一个计数桶，
 * 而且看起来「有防护」，实际按桶隔离错了。
 * 此时后端拿到的来源就是 BFF 容器 IP（等同修复前的粗粒度行为），
 * 不会因为缺头而出错。
 */
async function currentClientIp(): Promise<string | null> {
  // 浏览器端不取：浏览器没有真实 IP，硬塞一个客户端可控的值等于开绕过口。
  if (typeof window !== 'undefined') return null;

  try {
    const inbound = await headers();
    const raw = inbound.get('x-forwarded-for');
    if (!raw) return null;

    const candidate = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (!candidate || !IP_SHAPE.test(candidate)) return null;

    return candidate;
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
