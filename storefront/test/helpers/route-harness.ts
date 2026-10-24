/**
 * 中转路由测试的公共脚手架。
 *
 * Route Handler 就是普通导出函数，可以直接 import 并调用：
 * 传一个 `new Request(url, { method, body })`，拿返回的 `Response`。
 * 不需要起服务器，也不需要 jsdom。
 */

/**
 * 登录态。
 *
 * ⚠️ 这里**不引用 `@/auth` 的类型**：那会把 `auth` 的返回类型一路带进来，
 * 而 `auth` 的类型里混着 Next 的中间件类型，断言时类型对不上
 * （`Property 'accessToken' does not exist on type 'NextMiddleware'`）。
 *
 * accessToken 是我们断言后端收到 token 的唯一依据，所以这里手写一个
 * 结构相同的对象（`as never` 交给 mock 去断言）。
 */
export const TEST_SESSION = {
  accessToken: 'test-token',
  role: 'CUSTOMER',
  tenantId: 'tenant-1',
  user: { email: 'buyer@example.com' },
};

/** 构造一个 POST 请求。body 传原始字符串以便构造非法 JSON。 */
export function postRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** 构造一个 GET 请求。 */
export function getRequest(url: string): Request {
  return new Request(url, { method: 'GET' });
}
