import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, currentToken, currentSubdomain } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  currentToken: vi.fn(async () => 'tok'),
  currentSubdomain: vi.fn(async () => 'demo'),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch }));
vi.mock('@/lib/server-cart', () => ({ currentToken, currentSubdomain }));
// ⚠️ **必须 mock 掉 `@/auth`**：`shop-api` 顶层 import 它，而 `auth.ts`
// 顶层就调 `NextAuth({...})` → next-auth 的依赖图会拉进 `next/server`，
// 在 Vitest 里解析不了，整个测试文件加载失败。本用例与登录态无关。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

import { fetchAvailableCoupons } from '@/lib/shop-api';

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
});

describe('可领取的券', () => {
  it('取第一页的满上限，而不是默认 20', async () => {
    await fetchAvailableCoupons();
    expect(apiFetch).toHaveBeenCalledWith('/coupons/available?pageSize=100', {
      subdomain: 'demo',
      token: 'tok',
    });
  });
});
