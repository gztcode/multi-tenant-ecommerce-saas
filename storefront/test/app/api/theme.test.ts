/**
 * 主题查询中转路由的测试。
 *
 * ⚠️ Route Handler 测试在 **node 环境**跑（不是 jsdom）——
 * 它用的是 Web 标准的 Request / Response，Node 18+ 原生支持。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ `@/auth` 会经 next-auth 间接 import `next/server`，在 Vitest 的 ESM 解析下
// 找不到入口（`next/server` vs `next/server.js`）→ 整个文件收集失败。
// 与既有的 order-whitelist.test.ts 同一处理：mock 掉 auth 与 next/headers。
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock('@/lib/server-cart', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server-cart')>(
    '@/lib/server-cart',
  );
  return {
    ...actual,
    currentSubdomain: vi.fn().mockResolvedValue('demo'),
    fetchBackend: vi.fn(),
  };
});

import { currentSubdomain, fetchBackend } from '@/lib/server-cart';

import { GET as themeGet } from '@/app/api/theme/route';

const subdomainMock = vi.mocked(currentSubdomain);
const fetchBackendMock = vi.mocked(fetchBackend);

beforeEach(() => {
  vi.clearAllMocks();
  subdomainMock.mockResolvedValue('demo');
});

describe('GET /api/theme', () => {
  it('带子域名去后端取主题', async () => {
    fetchBackendMock.mockResolvedValue({
      tokens: { colors: { primary: 'oklch(0.7 0.19 40)' } },
    });

    const response = await themeGet();
    const body = (await response.json()) as { tokens: unknown };

    expect(response.status).toBe(200);
    expect(body.tokens).toEqual({
      colors: { primary: 'oklch(0.7 0.19 40)' },
    });
    // ⚠️ 断言子域名确实带上了——匿名访客靠它定位租户
    expect(fetchBackendMock).toHaveBeenCalledWith('/public/theme', {
      subdomain: 'demo',
    });
  });

  it('响应头显式声明 no-store（主题是最该实时的一类数据）', async () => {
    fetchBackendMock.mockResolvedValue({
      tokens: { colors: { primary: 'oklch(0.7 0.19 40)' } },
    });

    const response = await themeGet();

    // ⚠️ 不写这个头，将来有人给 nginx 加 proxy_cache 就会把主题缓存住
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('后端出错时返回错误状态，不是 200', async () => {
    fetchBackendMock.mockRejectedValue(new Error('后端不可用'));

    const response = await themeGet();

    expect(response.status).not.toBe(200);
  });
});
