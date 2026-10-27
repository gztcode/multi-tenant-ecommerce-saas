import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api-client';

/**
 * api-client 的**错误收口**。
 *
 * ## 为什么收口点只有一个
 *
 * 三个应用的所有请求最终都从 `apiFetch` 出去。收口在这里 →
 * **76 个渲染点零改动**就变成中文。
 * 不收口的话，用户看到的就是原始的 `TypeError: fetch failed`。
 *
 * ## 断言要具体
 *
 * 断言 status / code / message 三样，**不是**只断言「抛了个错」。
 */

// ⚠️ **必须 mock 掉 `@/auth`**：`api-client` 顶层 import 它，而 `auth.ts`
// 顶层就调 `NextAuth({...})` → 会把 next-auth 的整个依赖图拉进来
// （含 `next/server`，在 Vitest 里解析不了 → 直接抛
// "Cannot find module '.../next/server'"，整个测试文件加载失败）。
// 本组用例只关心请求与错误的形状，登录态无关。
vi.mock('@/auth', () => ({
  auth: vi.fn(async () => null),
}));

describe('api-client 的错误收口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('网络不可达 → ApiError(503, NETWORK_ERROR)，message 是中文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    await expect(apiFetch('/public/theme')).rejects.toMatchObject({
      status: 503,
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络后重试',
    });
  });

  it('网络不可达时用户看不到 fetch failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const error = await apiFetch('/public/theme').catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('fetch failed');
  });

  it('401 + 后端默认文案 Unauthorized → 翻成中文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'UNAUTHORIZED', message: 'Unauthorized' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(apiFetch('/me')).rejects.toMatchObject({
      status: 401,
      message: '登录已过期，请重新登录',
    });
  });

  it('401 + 后端给的中文业务消息 → 原样透传（不翻译）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'TOKEN_INVALID',
            message: '刷新令牌无效或已过期',
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(apiFetch('/me')).rejects.toMatchObject({
      status: 401,
      message: '刷新令牌无效或已过期',
    });
  });

  it('空响应体当成 null，不抛 Unexpected end of JSON input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    );

    await expect(apiFetch('/stores/me')).resolves.toBeNull();
  });

  it('只有空白字符的响应体也当成 null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('   \n  ', { status: 200 })),
    );

    await expect(apiFetch('/stores/me')).resolves.toBeNull();
  });

  it('204 返回 undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );

    await expect(apiFetch('/stores/me')).resolves.toBeUndefined();
  });

  it('正常响应原样解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'store-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(apiFetch('/stores/me')).resolves.toEqual({ id: 'store-1' });
  });
});
