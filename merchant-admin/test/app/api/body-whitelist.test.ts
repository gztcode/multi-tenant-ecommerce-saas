/**
 * 护栏 2：中转路由的请求体白名单——未知字段必须被丢弃，不透传给后端。
 *
 * 为什么整体透传是危险的：后端 ValidationPipe 开了 forbidNonWhitelisted，
 * 客户端多传一个字段就会被后端 400，那种 400 在界面上只是一句没头没尾的校验失败。
 * 更根本的问题是：后端 DTO 哪天加了个字段（哪怕只是内部用的），
 * 整体透传就让它静默变成了客户端可写。
 *
 * 所以这里断言 apiFetch 收到的**完整 body**——不是断言「某个字段不在」，
 * 而是断言「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
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

import { POST as categoriesPost } from '@/app/api/categories/route';
import { POST as productsPost } from '@/app/api/products/route';
import { POST as uploadUrlPost } from '@/app/api/media/upload-url/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'created-1' } as never);
});

describe('护栏 2：请求体白名单重建', () => {
  it('POST /api/categories 丢弃未知字段', async () => {
    const response = await categoriesPost(
      postRequest('http://localhost/api/categories', {
        name: '男装',
        slug: 'mens',
        sort: 1,
        // 全部是客户端不该能写的字段：
        id: 'client-supplied-id',
        tenantId: 'other-tenant',
        slug_locked: false,
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // 断言后端收到的**完整 body**——用 toEqual 而不是「不含某字段」，
    // 因为「不含某字段」可以通过「全都丢弃」的实现。
    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/categories', {
      method: 'POST',
      body: { name: '男装', slug: 'mens', parentId: undefined, sort: 1 },
      token: TEST_SESSION.accessToken,
    });
  });

  it('POST /api/categories 丢掉 status 字段（服务端自己管状态）', async () => {
    await categoriesPost(
      postRequest('http://localhost/api/categories', {
        name: '男装',
        slug: 'mens',
        status: 'PUBLISHED',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).not.toHaveProperty('status');
    // parentId 没传就不该出现（路由只在显式传了 null / 字符串时才写它）
    expect(Object.keys(options?.body as object).sort()).toEqual(['name', 'slug']);
  });

  it('POST /api/products 丢弃未知字段，只保留白名单', async () => {
    const response = await productsPost(
      postRequest('http://localhost/api/products', {
        name: 'T恤',
        slug: 't-shirt',
        subtitle: '纯棉',
        categoryId: null,
        attributes: { color: '白' },
        // 这些都不该透传：
        minPrice: 100,
        version: 7,
        tenantId: 'other-tenant',
        id: 'client-supplied-id',
        status: 'PUBLISHED',
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/products', {
      method: 'POST',
      body: {
        name: 'T恤',
        slug: 't-shirt',
        subtitle: '纯棉',
        categoryId: null,
        attributes: { color: '白' },
      },
      token: TEST_SESSION.accessToken,
    });
  });

  it('POST /api/products 的 minPrice 不出现在后端收到的 body 里', async () => {
    await productsPost(
      postRequest('http://localhost/api/products', {
        name: 'T恤',
        slug: 't-shirt',
        minPrice: 100,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).not.toHaveProperty('minPrice');
  });

  it('POST /api/media/upload-url 只发 filename / mime / size', async () => {
    const response = await uploadUrlPost(
      postRequest('http://localhost/api/media/upload-url', {
        filename: 'a.png',
        mime: 'image/png',
        size: 1024,
        // 服务端自己算的字段，客户端不许塞：
        key: 'tenant-1/evil.png',
        status: 'CONFIRMED',
        uploadedBy: 'someone-else',
        tenantId: 'other-tenant',
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith('/media/upload-url', {
      method: 'POST',
      body: { filename: 'a.png', mime: 'image/png', size: 1024 },
      token: TEST_SESSION.accessToken,
    });
  });
});
