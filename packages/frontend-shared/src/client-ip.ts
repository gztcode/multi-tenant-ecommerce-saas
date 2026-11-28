/**
 * 从入站 `x-forwarded-for` 里挑出**真实客户端 IP**，供三端 BFF 转发给后端。
 *
 * 为什么需要：后端 `/auth/login` 按来源 IP 做防爆破计数，而 api 前面隔着
 * 网关与 BFF（`trust proxy = 1`，取 XFF **最右**一项）。BFF 不转发时，
 * 后端看到的永远是 BFF 容器 IP —— 所有用户共用一个计数桶，攻击者试错
 * 30 次就能让全平台 15 分钟登不进来。
 */

/**
 * IP 的**形状**校验：只允许十六进制数字、点、冒号。
 *
 * ⚠️ 这是白名单而不是「是不是合法 IP」：目的是**挡掉能进 HTTP 头的字符**
 *    （换行、逗号、空格等），顺带挡掉明显不是 IP 的垃圾值。
 *    宽松一点没关系——拿不到可信 IP 时宁可不发头，
 *    误判成「合法」的最坏后果也只是多一个计数桶。
 */
export const IP_SHAPE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * 取 XFF 的**最右**一项。
 *
 * 网关（`infra/nginx/templates/prod.conf.template`）用
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`，
 * 也就是把真实对端**追加到右端**、客户端自带的伪造值留在左端。
 * 所以最右一项才是可信来源。
 *
 * ⚠️ **只取最右**：取最左等于把限流的钥匙交给客户端——换个
 *    `x-forwarded-for` 就能绕过防爆破。转发时也只能发这一项，
 *    不能把整串拼上去（否则客户端伪造的值又成了 BFF 出站头的最右项）。
 *
 * 取不到 / 形状不合法 → `null`，调用方应**不发**这个头。
 * 不塞假 IP：假 IP 会被当成一个真实来源，白白多出一个计数桶，
 * 而且看起来「有防护」，实际按桶隔离错了。
 */
export function pickClientIp(xff: string | null | undefined): string | null {
  if (!xff) return null;

  const candidate = xff
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();

  if (!candidate || !IP_SHAPE.test(candidate)) return null;

  return candidate;
}

/**
 * 从**入站请求对象**里取真实客户端 IP（XFF 最右一项）。
 *
 * 为什么用 `Request` 而不是 `next/headers` 的 `headers()`：NextAuth 的
 * `authorize(credentials, request)` 已经把手头这个 `Request` 递过来了，
 * 而管理端后台的 `auth.ts` 会被客户端组件（`signIn` / `signOut`）连同
 * 依赖图一起打进浏览器包 —— 一旦里面静态 import 了 `next/headers`，
 * `next build` 会直接报「Client Component 不能用 next/headers」。
 * 读 `request.headers` 没有这个问题，且行为完全一致。
 *
 * `request` 为空（某些非请求作用域调用）或取头抛错 → `null`（= 不发这个头）。
 */
export function clientIpFromRequest(request?: Request | null): string | null {
  try {
    return pickClientIp(request?.headers?.get('x-forwarded-for') ?? null);
  } catch {
    return null;
  }
}
