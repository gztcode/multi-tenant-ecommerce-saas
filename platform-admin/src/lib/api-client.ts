import { auth } from '@/auth';
import { createApiClient } from '@ecom/frontend-shared/api-client';

/**
 * 后端服务地址。
 *
 * ⚠️ **导出来是为了 multipart 转发**（`app/api/billing/reconciliations/import/route.ts`）——
 *    `apiFetch` 硬编码了 `content-type: application/json` 且会
 *    `JSON.stringify(body)`，multipart 必须自己写一条裸 fetch，
 *    而裸 fetch 又需要这个 base URL —— **不能另写一个**（两处漂移）。
 */
export const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

const shared = createApiClient({
  baseUrl: API_BASE_URL,
  // 注意：平台超管后台不带 x-tenant-subdomain——中心域名没有「当前店铺」，
  // 超管令牌本身就是跨租户的（tenantId 为 null）。
  tenantSubdomain: null,
  // 后台没有游客购物车，明确不转发 Cookie。
  forwardCookie: false,
  auth,
});

export const ApiError = shared.ApiError;
export const localizeApiMessage = shared.localizeApiMessage;
export const apiFetch = shared.apiFetch;
export const apiFetchAuthed = shared.apiFetchAuthed;
