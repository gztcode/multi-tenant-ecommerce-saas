import { auth } from '@/auth';
import { createApiClient } from '@ecom/frontend-shared/api-client';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

const shared = createApiClient({
  baseUrl: API_BASE_URL,
  // 子域名是**按请求**解析的（server-cart 的 currentSubdomain() 逐请求传
  // options.subdomain），这里没有全局缺省值，明确不发。
  tenantSubdomain: null,
  // 游客购物车靠透传 cart_token cookie（server-cart 的 forwardableCookie()）。
  forwardCookie: true,
  auth,
});

export const ApiError = shared.ApiError;
export const localizeApiMessage = shared.localizeApiMessage;
export const apiFetch = shared.apiFetch;
export const apiFetchAuthed = shared.apiFetchAuthed;
export const apiFetchWithSetCookie = shared.apiFetchWithSetCookie;
export type { ApiFetchOptions } from '@ecom/frontend-shared/api-client';
