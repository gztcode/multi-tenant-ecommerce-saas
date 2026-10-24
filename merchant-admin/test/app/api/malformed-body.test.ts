/**
 * 护栏 3：中转路由拦截数组 / 字符串 / null 请求体 → 400。
 *
 * 为什么要专门测这一条：客户端发来的请求体是不受信任的输入。
 * `typeof [] === 'object'` 为真，所以只判 typeof 会让数组溜进去；
 * `null` 的 typeof 也是 'object'，同理。
 * 中转层必须先把这两类挡掉，否则 `body.ids` 之类的读取会拿到意外的值。
 *
 * 断言要具体：400 **且** 错误文案是那句具体的「请求体必须是 JSON 对象」，
 * 而且 apiFetch 一次都没被调用（不能只是「报了错」——
 * 报错也可能来自别的原因，比如后端返回了 400）。
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
import { POST as productsPost } from '@/app/api/products/route';
import { PATCH as productPatch } from '@/app/api/products/[id]/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

const params = Promise.resolve({ id: 'product-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ ok: true } as never);
});

describe('护栏 3：数组 / 字符串 / null 请求体一律 400', () => {
  // 三种畸形入参：数组、字符串、null
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a', 'b']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`POST /api/products 收到${label}请求体 → 400 且不调后端`, async () => {
      const response = await productsPost(
        postRequest('http://localhost/api/products', payload),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message?: unknown };
      expect(body.message).toBe('请求体必须是 JSON 对象');
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it(`POST /api/products/batch 收到${label}请求体 → 400 且不调后端`, async () => {
      const response = await batchPost(
        postRequest('http://localhost/api/products/batch', payload),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message?: unknown };
      expect(body.message).toBe('请求体必须是 JSON 对象');
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('PATCH /api/products/[id] 收到数组请求体 → 400 且不调后端', async () => {
    const response = await productPatch(
      postRequest('http://localhost/api/products/product-1', ['a']),
      { params },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: unknown };
    expect(body.message).toBe('请求体必须是 JSON 对象');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('PATCH /api/products/[id] 收到字符串请求体 → 400 且不调后端', async () => {
    const response = await productPatch(
      postRequest('http://localhost/api/products/product-1', 'nope'),
      { params },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('PATCH /api/products/[id] 收到 null 请求体 → 400 且不调后端', async () => {
    const response = await productPatch(
      postRequest('http://localhost/api/products/product-1', null),
      { params },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('合法对象请求体不被这条护栏误伤（仍然走到后端）', async () => {
    const response = await productsPost(
      postRequest('http://localhost/api/products', {
        name: 'T恤',
        slug: 't-shirt',
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});
