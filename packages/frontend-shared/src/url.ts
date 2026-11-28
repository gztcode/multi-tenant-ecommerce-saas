/**
 * 后端 URL 里动态路径段的编码。
 *
 * 为什么需要它：BFF 的 Route Handler 用 `/xxx/${id}` 直接拼后端 URL 时，
 * Next.js 已经对路径参数做过一次解码——请求 `/api/products/..%2F..%2Fbilling`
 * 命中的仍是 `products/[id]`，但 `params.id` 里已经是 `../../billing`。
 * 裸拼就成了「拿调用者令牌访问任意后端路径」，绕过 BFF 这一层的路径白名单。
 *
 * 实现只有 `encodeURIComponent` 一层，但**不要**在编码前做
 * `decodeURIComponent`：调用方拿到的值来自 Next 解码后的 params，
 * 再解码一次会让 `%252F` → `%2F` → 客户端可控的 `/` 重新出现；
 * 保持「不认识的 `%` 就编成 `%25`」才是幂等且安全的行为。
 *
 * @param value 动态段原文（Next.js `params` 里的值、或从 `searchParams` 取出后要放进路径的值）
 * @returns 不含 `/`、`?`、`#` 等路径/查询分隔符的单段字符串；空串原样返回
 */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
