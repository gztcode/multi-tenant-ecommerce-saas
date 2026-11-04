import { auth } from '@/auth';
import { createApiClient } from '@ecom/frontend-shared/api-client';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

const shared = createApiClient({
  baseUrl: API_BASE_URL,
  // 注意：商家后台不带 x-tenant-subdomain——中心域名没有「当前店铺」，
  // 租户身份完全由 accessToken 里的 tenantId 决定。
  tenantSubdomain: null,
  auth,
});

export const ApiError = shared.ApiError;
export const localizeApiMessage = shared.localizeApiMessage;
export const apiFetch = shared.apiFetch;
export const apiFetchAuthed = shared.apiFetchAuthed;
export const apiAbsoluteUrl = shared.apiAbsoluteUrl;
