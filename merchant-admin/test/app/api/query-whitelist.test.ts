/**
 * 护栏 6：中转路由的**查询参数**白名单——未知 query 参数不得透传给后端。
 *
 * 与护栏 2（请求体白名单）同族，但走的是另一条路：query 串不是 JSON，
 * 是手写重建的。后端的 DTO 校验只管 body，`@Query` 参数没有
 * `forbidNonWhitelisted`，所以透传未知 query 不会被拒——必须靠这一层拦。
 *
 * 为什么值得测：页面上拼错了筛选参数（比如手滑写成 `catagoryId`），
 * 透传的话后端会静默忽略它，页面看起来「筛选没生效」却查不出原因。
 * 白名单重建让「这个页面支持哪些筛选」只有一处定义。
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

import { GET as productsGet } from '@/app/api/products/route';

const mockedAuth = vi.mocked(auth);
const mockedApiFetch = vi.mocked(apiFetch);

/** 取出 apiFetch 被调用时用的那个路径 */
function calledPath(): string {
  const call = mockedApiFetch.mock.calls[0];
  if (!call) throw new Error('apiFetch 一次都没被调用');
  return String(call[0]);
}

describe('中转路由的查询参数白名单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      accessToken: 'test-token',
    } as unknown as Awaited<ReturnType<typeof auth>>);
    mockedApiFetch.mockResolvedValue({ items: [], total: 0 } as never);
  });

  it('未知 query 参数不进后端请求的 URL', async () => {
    const request = new Request(
      'http://localhost/api/products?page=2&catagoryId=typo&evil=1&status=PUBLISHED',
    );

    const response = await productsGet(request);

    expect(response.status).toBe(200);
    const path = calledPath();
    expect(path).not.toContain('catagoryId');
    expect(path).not.toContain('evil');
    // 白名单内的参数必须还在
    expect(path).toContain('page=2');
    expect(path).toContain('status=PUBLISHED');
  });

  it('白名单内的参数被原样保留', async () => {
    const request = new Request(
      'http://localhost/api/products?page=3&pageSize=50&keyword=tee&categoryId=c1&status=DRAFT',
    );

    await productsGet(request);

    const path = calledPath();
    expect(path).toContain('page=3');
    expect(path).toContain('pageSize=50');
    expect(path).toContain('keyword=tee');
    expect(path).toContain('categoryId=c1');
    expect(path).toContain('status=DRAFT');
  });

  it('空值参数被丢弃而不是拼成空串', async () => {
    // keyword= 这种空值传过去没有意义，白名单重建时应当跳过
    const request = new Request(
      'http://localhost/api/products?keyword=&status=PUBLISHED',
    );

    await productsGet(request);

    const path = calledPath();
    expect(path).not.toContain('keyword=');
    expect(path).toContain('status=PUBLISHED');
  });

  it('没有任何参数时 URL 不带问号', async () => {
    const request = new Request('http://localhost/api/products');

    await productsGet(request);

    expect(calledPath()).toBe('/catalog/products');
  });
});
