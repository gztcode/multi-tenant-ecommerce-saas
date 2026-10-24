/**
 * 护栏 2：下单中转路由的**请求体白名单**——未知字段必须被丢弃。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：**价格字段绝不能从客户端来**（护栏 8）。
 *   客户端传 `unitPrice: 1`、服务端照单全收，就是一个可以 1 分钱买走
 *   100 元商品的漏洞。所以断言必须是「后端收到的 body 就正好是那几个键」，
 *   而不是「某个字段不在」——「全都丢掉」的实现也能通过后者。
 *
 * 断言要具体：这里断言 apiFetch 收到的**完整 body**。
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
    apiFetch: vi.fn(),
  };
});

import { auth } from '@/auth';
import { cookies, headers } from 'next/headers';
import { apiFetch } from '@/lib/api-client';

import { POST as placeOrder } from '@/app/api/orders/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);
const cookiesMock = vi.mocked(cookies);
const headersMock = vi.mocked(headers);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ orderNo: 'ORDER-1' } as never);
  // 中转路由要读请求头（解析店铺子域名）与 cookie（转发 cart_token）
  headersMock.mockResolvedValue(
    new Headers({ 'x-tenant-subdomain': 'demo' }) as never,
  );
  cookiesMock.mockResolvedValue({
    get: () => undefined,
  } as never);
});

describe('护栏 2：下单请求体白名单重建', () => {
  it('只把 addressId / items / idempotencyKey / remark 发给后端', async () => {
    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 2 }],
        idempotencyKey: 'key-1',
        remark: '工作日送货',
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders', {
      method: 'POST',
      body: {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 2 }],
        idempotencyKey: 'key-1',
        remark: '工作日送货',
      },
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });

  it('价格字段不进后端请求体', async () => {
    await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 2, unitPrice: 1, price: 1 }],
        totalAmount: 1,
        amount: 1,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('totalAmount');
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('unitPrice');
    expect(body).not.toHaveProperty('price');

    const items = body.items as Array<Record<string, unknown>>;
    expect(Object.keys(items[0]).sort()).toEqual(['quantity', 'skuId']);
  });

  it('条目里的 id / productId 不进后端请求体', async () => {
    await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [
          { id: 'cart-item-1', skuId: 'sku-a', quantity: 1, productId: 'p-1' },
        ],
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    expect(Object.keys(items[0]).sort()).toEqual(['quantity', 'skuId']);
  });

  it('不带 remark 时请求体里没有 remark 这个键', async () => {
    await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    expect(Object.keys(options?.body as object).sort()).toEqual([
      'addressId',
      'items',
    ]);
  });

  it('tenantId / customerId / orderNo 不进后端请求体', async () => {
    await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
        tenantId: 'other-tenant',
        customerId: 'someone-else',
        orderNo: 'ORDER-999',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('customerId');
    expect(body).not.toHaveProperty('orderNo');
  });
});

describe('护栏 3：畸形请求体一律 400', () => {
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`下单收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await placeOrder(
        postRequest('http://localhost/api/orders', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('缺 addressId → 400，且不调后端', async () => {
    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        items: [{ skuId: 'sku-a', quantity: 1 }],
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('items 为空数组 → 400，且不调后端', async () => {
    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [],
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('items 里有数量非法的条目 → 400，且不调后端', async () => {
    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 0 }],
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('护栏 1：未登录不下单', () => {
  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
