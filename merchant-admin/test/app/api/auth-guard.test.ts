/**
 * 护栏 1：中转路由的认证——未登录必须 401，且**不得**调后端。
 *
 * 为什么要断言「apiFetch 一次都没被调用」：
 * 只断言状态码 401 是不够的。未登录时如果先调后端、再把后端的错误转成 401，
 * 状态码照样是 401，但 accessToken 已经在后端那边露过面了。
 * 所以这里同时断言后端调用次数为 0——这是「未登录不碰后端」的唯一证据。
 *
 * 被测的路由覆盖了不同方法（GET / POST / PATCH / DELETE）
 * 与不同形态的路由（列表、批量、带路径参数）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ vi.mock 的路径必须与被测文件里的 import 路径完全一致。
// 被测文件写 `import { auth } from '@/auth'`，这里就写 '@/auth'。
// 路径不一致 mock 不生效——症状是「测试跑起来但断言的是真实现」。
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// ⚠️ 同样要 mock api-client，否则会真的去 fetch 后端。
// 保留 ApiError 是因为 route-helpers 的 toErrorResponse 会用 instanceof 判断它。
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

import { GET as categoriesGet } from '@/app/api/categories/route';
import { POST as batchPost } from '@/app/api/products/batch/route';
import { GET as productsGet } from '@/app/api/products/route';
import { PATCH as productPatch } from '@/app/api/products/[id]/route';
import { DELETE as productDelete } from '@/app/api/products/[id]/route';

import { getRequest, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的第二个参数（Next.js 15 里 params 是 Promise） */
const params = Promise.resolve({ id: 'product-1' });

beforeEach(() => {
  vi.clearAllMocks();
  // 未登录：auth() 返回 null
  authMock.mockResolvedValue(null as never);
});

describe('护栏 1：未登录的中转路由', () => {
  it('GET /api/categories → 401 且不调后端', async () => {
    const response = await categoriesGet();

    expect(response.status).toBe(401);
    // 关键断言：后端一次都没被碰到
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/products → 401 且不调后端', async () => {
    const response = await productsGet(getRequest('http://localhost/api/products'));

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/products/batch → 401 且不调后端', async () => {
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids: ['a'],
        action: 'PUBLISH',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('PATCH /api/products/[id] → 401 且不调后端', async () => {
    const response = await productPatch(
      postRequest('http://localhost/api/products/product-1', { version: 1 }),
      { params },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE /api/products/[id] → 401 且不调后端', async () => {
    const response = await productDelete(
      new Request('http://localhost/api/products/product-1', { method: 'DELETE' }),
      { params },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录响应体给出可读文案', async () => {
    const response = await categoriesGet();
    const body = (await response.json()) as { message?: unknown };

    expect(body.message).toBe('未登录或登录已过期');
  });
});
