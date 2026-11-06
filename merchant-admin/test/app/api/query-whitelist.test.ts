/**
 * 护栏 6：中转路由的**查询参数**白名单——未知 query 参数不得透传给后端。
 *
 * 与护栏 2（请求体白名单）同族，但走的是另一条路：query 串不是 JSON，
 * 是手写重建的。已改用查询 DTO 的后端接口开了 `forbidNonWhitelisted`，
 * 透传未知 query 会被判 400，而那种 400 在界面上只会显示一句没头没尾的
 * 校验失败；没走 DTO 的接口则会把未知参数静默忽略。两种都得靠这一层挡。
 *
 * 为什么值得测：页面上拼错了筛选参数（比如手滑写成 `catagoryId`），
 * 透传的话要么 400 要么「筛选没生效」却查不出原因。
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

import { GET as inventoryMovementsGet } from '@/app/api/inventory/movements/route';
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

  it('库存流水只透传 skuId / page / pageSize，未知参数与空值一律丢弃', async () => {
    const request = new Request(
      'http://localhost/api/inventory/movements?skuId=sku-1&page=2&pageSize=20&evil=1&keyword=',
    );

    const response = await inventoryMovementsGet(request);

    expect(response.status).toBe(200);
    expect(calledPath()).toBe('/inventory/movements?skuId=sku-1&page=2&pageSize=20');
  });
});
