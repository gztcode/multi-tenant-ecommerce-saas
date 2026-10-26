/**
 * `apiFetch` 的响应体解析。
 *
 * ⚠️ **空响应体必须当成 `null`**：后端在没有数据时返回
 * 200 + `Content-Length: 0`（NestJS 的 handler 返回 `null` 就是这样）。
 * 无条件 `response.json()` 碰到空 body 会抛
 * 「Unexpected end of JSON input」—— 真实情况是「没有数据」，
 * 界面上却显示成「加载失败」。
 *
 * ⚠️ **商家第一次进订阅页看到的就是这句**（那时还没订阅），
 * 所以这条不是「边角情况」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// ⚠️ **`@/auth` 必须 mock 掉**：`api-client` import 了它，而 `auth.ts`
// 顶层就调 `NextAuth({...})` → 间接 import `next/server` → 在 node
// 环境下报「Cannot find module 'next/server'」。
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

import { apiFetch } from '@/lib/api-client';

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

/** 让 `global.fetch` 返回一个给定的响应 */
function stubFetch(response: Response): void {
  fetchMock.mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
}

describe('apiFetch：空响应体', () => {
  it('200 + 空 body → 返回 null，不抛异常', async () => {
    stubFetch(new Response('', { status: 200 }));

    const result = await apiFetch('/billing/subscription');

    expect(result).toBeNull();
  });

  it('⚠️ 200 + 只有空白字符的 body → 也当成 null', async () => {
    stubFetch(new Response('   \n  ', { status: 200 }));

    const result = await apiFetch('/billing/subscription');

    expect(result).toBeNull();
  });

  it('200 + 有 JSON body → 照常解析', async () => {
    stubFetch(
      new Response(JSON.stringify({ id: 'sub-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await apiFetch<{ id: string }>('/billing/subscription');

    expect(result).toEqual({ id: 'sub-1' });
  });

  it('204 → 返回 undefined（语义是「无内容」，不是「没有数据」）', async () => {
    stubFetch(new Response(null, { status: 204 }));

    const result = await apiFetch('/billing/subscription');

    expect(result).toBeUndefined();
  });
});
