/**
 * 管理端登录请求：转发真实客户端 IP，避免后端按 IP 限流按 BFF 合并计数。
 *
 * ⚠️ 取值逻辑在 `@ecom/frontend-shared/client-ip`，请求构造在
 *    `@ecom/frontend-shared/login-request` —— 与 storefront 同一套，
 *    不要在这里另写一份。`auth.ts` 的 `authorize()` 只调这个函数，
 *    所以本文件也是「authorize 发出的 fetch 带什么头」的测试入口。
 *
 * ⚠️ 客户端 IP 从 NextAuth 递进来的 `Request` 上读（**不用** `next/headers`）：
 *    本文件的依赖图会随 `auth.ts` 被打进浏览器包，`next/headers` 出现在
 *    Client Component 的依赖图里会让 `next build` 直接失败。
 */
import { clientIpFromRequest } from '@ecom/frontend-shared/client-ip';
import { createLoginRequest } from '@ecom/frontend-shared/login-request';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

export const requestLogin = createLoginRequest({
  apiBaseUrl: API_BASE_URL,
  clientIp: clientIpFromRequest,
});
