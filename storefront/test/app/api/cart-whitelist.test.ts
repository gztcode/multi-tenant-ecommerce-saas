/**
 * 护栏 2：加购中转路由的**请求体白名单**——未知字段必须被丢弃。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：**价格字段绝不能从客户端来**（护栏 8）。
 *   客户端传 `unitPrice: 1`、服务端照单全收，就是一个可以 1 分钱买走
 *   100 元商品的漏洞。所以断言必须是「后端收到的 body 就正好是那几个键」，
 *   而不是「某个字段不在」——「全都丢掉」的实现也能通过后者。
 *
 * ⚠️ 中转路由调的是 `apiFetchWithSetCookie`（不是 `apiFetch`）：
 * 加购要顺带把后端种下的 `cart_token` 写回浏览器，游客的车才不会丢。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetchWithSetCookie: vi.fn(),
  };
});

import { auth } from '@/auth';
import { cookies, headers } from 'next/headers';
import { apiFetchWithSetCookie } from '@/lib/api-client';

import { POST as addCartItem } from '@/app/api/cart/items/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetchWithSetCookie);
const cookiesMock = vi.mocked(cookies);
const headersMock = vi.mocked(headers);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ data: { id: 'cart-1' }, setCookie: null } as never);
  // 中转路由要读请求头（解析店铺子域名）与 cookie（转发 cart_token）
  headersMock.mockResolvedValue(
    new Headers({ 'x-tenant-subdomain': 'demo' }) as never,
  );
  cookiesMock.mockResolvedValue({
    get: () => undefined,
  } as never);
});

describe('护栏 2：加购请求体白名单重建', () => {
  it('只把 skuId / quantity 发给后端', async () => {
    const response = await addCartItem(
      postRequest('http://localhost/api/cart/items', {
        skuId: 'sku-a',
        quantity: 2,
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/cart/items', {
      method: 'POST',
      body: { skuId: 'sku-a', quantity: 2 },
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
      cookie: undefined,
    });
  });

  it('价格字段不进后端请求体', async () => {
    await addCartItem(
      postRequest('http://localhost/api/cart/items', {
        skuId: 'sku-a',
        quantity: 1,
        unitPrice: 1,
        price: 1,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('unitPrice');
    expect(body).not.toHaveProperty('price');
    expect(Object.keys(body).sort()).toEqual(['quantity', 'skuId']);
  });

  it('租户与购物车标识不进后端请求体', async () => {
    await addCartItem(
      postRequest('http://localhost/api/cart/items', {
        skuId: 'sku-a',
        quantity: 1,
        tenantId: 'other-tenant',
        cartId: 'someone-elses-cart',
        customerId: 'someone-else',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('cartId');
    expect(body).not.toHaveProperty('customerId');
    expect(Object.keys(body).sort()).toEqual(['quantity', 'skuId']);
  });
});

describe('护栏 3：畸形加购请求体一律 400', () => {
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`加购收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await addCartItem(
        postRequest('http://localhost/api/cart/items', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('缺 skuId → 400，且不调后端', async () => {
    const response = await addCartItem(
      postRequest('http://localhost/api/cart/items', { quantity: 1 }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('quantity 为 0 → 400，且不调后端', async () => {
    const response = await addCartItem(
      postRequest('http://localhost/api/cart/items', {
        skuId: 'sku-a',
        quantity: 0,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('quantity 不是整数 → 400，且不调后端', async () => {
    const response = await addCartItem(
      postRequest('http://localhost/api/cart/items', {
        skuId: 'sku-a',
        quantity: 1.5,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('quantity 超过上限 99 → 400，且不调后端', async () => {
    const response = await addCartItem(
      postRequest('http://localhost/api/cart/items', {
        skuId: 'sku-a',
        quantity: 100,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
