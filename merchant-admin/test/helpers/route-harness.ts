/**
 * 中转路由测试的公共脚手架。
 *
 * Route Handler 就是普通导出函数，可以直接 import 并调用：
 * 传一个 `new Request(url, { method, body })`，拿返回的 `Response`。
 * 不需要起服务器，也不需要 jsdom。
 */

/** 登录态。accessToken 是我们断言 apiFetch 收到 token 的唯一依据。 */
export const TEST_SESSION = {
  accessToken: 'test-token',
  role: 'MERCHANT',
  tenantId: 'tenant-1',
} as const;

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

/** 读出响应的 JSON body */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
