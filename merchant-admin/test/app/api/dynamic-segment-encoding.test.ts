/**
 * 护栏：中转路由的动态段必须整体编码成一个后端路径段。
 *
 * Next.js 在把路径参数交给 Route Handler 之前会做一次解码：请求
 * `/api/products/..%2F..%2Fbilling%2Finvoices%2FINV-1` 命中的仍是
 * `products/[id]`，但 `params.id` 已经是 `../../billing/invoices/INV-1`。
 * 如果路由把它裸拼进模板串，BFF 就成了「拿调用者令牌访问任意后端路径」的跳板。
 *
 * 断言的是**实际传给 apiFetch 的完整 path**（不是「包含某字段」），
 * 并额外确认路径里没有裸 `/` 把这段拆成多段。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';

import {
  DELETE as productDelete,
  GET as productGet,
} from '@/app/api/products/[id]/route';
import { PATCH as skuPatch } from '@/app/api/products/[id]/skus/[skuId]/route';

import { TEST_SESSION, getRequest, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 攻击者可控的动态段：解码后带路径穿越 */
const NASTY = '../../billing/invoices/INV-1';

/** 取出 apiFetch 收到的 path */
function sentPath(): string {
  return apiFetchMock.mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'x' } as never);
});

describe('动态段编码：merchant-admin 中转路由', () => {
  it('GET /api/products/[id] 把穿越串编码成单段，不会跳到 /billing', async () => {
    const response = await productGet(
      getRequest('http://localhost/api/products/nasty'),
      { params: Promise.resolve({ id: NASTY }) },
    );

    expect(response.status).toBe(200);
    expect(sentPath()).toBe(
      '/catalog/products/..%2F..%2Fbilling%2Finvoices%2FINV-1',
    );
    // 路径里不能再出现裸 `/billing`——那说明它被当成新的路径段了
    expect(sentPath()).not.toContain('/billing');
    // 固定段 + 恰好一个动态段
    expect(sentPath().split('/')).toHaveLength(4);
  });

  it('DELETE /api/products/[id] 同样编码（同一路由的每个方法都要覆盖）', async () => {
    await productDelete(
      new Request('http://localhost/api/products/nasty', { method: 'DELETE' }),
      { params: Promise.resolve({ id: NASTY }) },
    );

    expect(sentPath()).toBe(
      '/catalog/products/..%2F..%2Fbilling%2Finvoices%2FINV-1',
    );
  });

  it('多动态段路由：每一段单独编码，固定段（skus）不编码', async () => {
    const response = await skuPatch(
      postRequest('http://localhost/api/products/p/skus/s', {
        price: 100,
        stock: 1,
        version: 1,
      }),
      { params: Promise.resolve({ id: '../../catalog/categories', skuId: '../x' }) },
    );

    expect(response.status).toBeLessThan(500);
    expect(sentPath()).toBe(
      '/catalog/products/..%2F..%2Fcatalog%2Fcategories/skus/..%2Fx',
    );
  });

  it('正常 id 原样保留（编码不能误伤合法值）', async () => {
    await productGet(getRequest('http://localhost/api/products/abc-123'), {
      params: Promise.resolve({ id: 'abc-123' }),
    });

    expect(sentPath()).toBe('/catalog/products/abc-123');
  });
});
