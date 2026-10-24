/**
 * 护栏 4：批量接口的 ids 数量上限（> 200 → 400）。
 *
 * 后端 BatchProductsDto 上有 ArrayMaxSize(200)，中转层先挡一次，
 * 好处是错误信息直接指向上限（「ids 最多 200 个」），而不是后端那句
 * 泛泛的校验失败。
 *
 * 断言要具体：400 **且** 文案是「ids 最多 200 个」，且 apiFetch 没被调。
 * 同时测边界：正好 200 个要放行（只测「>200 被拒」的话，
 * 一个「>=200 就拒」的实现也能通过）。
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

import { POST as batchPost } from '@/app/api/products/batch/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 生成 n 个 id */
function makeIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `id-${i}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ affected: 1 } as never);
});

describe('护栏 4：批量 ids 数量上限 200', () => {
  it('201 个 id → 400，文案指向上限，且不调后端', async () => {
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids: makeIds(201),
        action: 'PUBLISH',
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: unknown };
    expect(body.message).toBe('ids 最多 200 个');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('远超上限（1000 个 id）→ 400 且不调后端', async () => {
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids: makeIds(1000),
        action: 'DELETE',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('正好 200 个 id → 放行（边界不能被误伤）', async () => {
    const ids = makeIds(200);
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids,
        action: 'PUBLISH',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    // 后端收到的 ids 原样是那 200 个
    const [, options] = apiFetchMock.mock.calls[0];
    expect((options?.body as { ids: string[] }).ids).toHaveLength(200);
    expect((options?.body as { ids: string[] }).ids).toEqual(ids);
  });

  it('199 个 id → 放行', async () => {
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids: makeIds(199),
        action: 'UNPUBLISH',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('超上限的判断发生在 action 校验之前（超限就返回 400，不看 action）', async () => {
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids: makeIds(201),
        action: 'SET_CATEGORY',
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: unknown };
    expect(body.message).toBe('ids 最多 200 个');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
