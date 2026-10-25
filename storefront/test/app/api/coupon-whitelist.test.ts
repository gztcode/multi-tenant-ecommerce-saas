/**
 * 护栏 1 / 2 / M1 / M2：券相关中转路由的**请求体白名单**。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：**面额与门槛绝不能从客户端来**（护栏 M1 / M2）。
 *   客户端传 `discountAmount: 10000`、服务端照单全收，
 *   就是一张可以 100 元商品减 100 元的券。所以断言必须是
 *   「后端收到的 body 就正好是那几个键」，而不是「某个字段不在」——
 *   「全都丢掉」的实现也能通过后者。
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

import { POST as claimCoupon } from '@/app/api/coupons/claim/route';
import { POST as placeOrder } from '@/app/api/orders/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);
const cookiesMock = vi.mocked(cookies);
const headersMock = vi.mocked(headers);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ couponId: 'c-1', quantity: 1 } as never);
  // 中转路由要读请求头（解析店铺子域名）与 cookie
  headersMock.mockResolvedValue(
    new Headers({ 'x-tenant-subdomain': 'demo' }) as never,
  );
  cookiesMock.mockResolvedValue({
    get: () => undefined,
  } as never);
});

describe('护栏 2：领券请求体白名单重建', () => {
  it('只把 couponId 发给后端', async () => {
    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { couponId: 'c-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/coupons/claim', {
      method: 'POST',
      body: { couponId: 'c-1' },
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });

  it('金额字段不进后端请求体（body 的键恰好只有 couponId）', async () => {
    await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', {
        couponId: 'c-1',
        discountAmount: 10000,
        value: 10000,
        minAmount: 1,
        payableAmount: 0,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['couponId']);
    expect(body).toEqual({ couponId: 'c-1' });
  });

  it('tenantId / customerId / scope 不进后端请求体', async () => {
    await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', {
        couponId: 'c-1',
        tenantId: 'other-tenant',
        customerId: 'someone-else',
        scope: 'PLATFORM',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['couponId']);
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('customerId');
    expect(body).not.toHaveProperty('scope');
  });

  it('couponId 与 code 都传时只发 couponId', async () => {
    await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', {
        couponId: 'c-1',
        code: 'CODE-1',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['couponId']);
    expect(body).toEqual({ couponId: 'c-1' });
  });

  it('只传 code 时只发 code', async () => {
    await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { code: 'CODE-1' }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['code']);
    expect(body).toEqual({ code: 'CODE-1' });
  });
});

describe('护栏 3：领券的畸形请求一律 400，且不调后端', () => {
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`领券收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await claimCoupon(
        postRequest('http://localhost/api/coupons/claim', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('couponId 与 code 都没给 → 400，且不调后端', async () => {
    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { quantity: 2 }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('couponId 不是字符串 → 400，且不调后端', async () => {
    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { couponId: 123 }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('couponId 是空串 → 400，且不调后端', async () => {
    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { couponId: '' }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('护栏 1：未登录不领券', () => {
  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { couponId: 'c-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('护栏 M2：下单请求体里的 couponId 与金额字段', () => {
  it('couponId 会进后端请求体', async () => {
    await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
        couponId: 'c-1',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body.couponId).toBe('c-1');
    expect(Object.keys(body).sort()).toEqual([
      'addressId',
      'couponId',
      'items',
    ]);
  });

  it('couponId 与金额字段同时传时，只有 couponId 进 body', async () => {
    await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
        couponId: 'c-1',
        discountAmount: 10000,
        couponValue: 10000,
        couponMinAmount: 1,
        promotionDiscountAmount: 10000,
        value: 10000,
        minAmount: 1,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'addressId',
      'couponId',
      'items',
    ]);
    expect(body.couponId).toBe('c-1');
  });

  it('没传 couponId 时请求体里没有 couponId 这个键', async () => {
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

  it('couponId 不是非空字符串 → 400，且不调后端', async () => {
    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
        couponId: 123,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('couponId 是空串 → 400，且不调后端', async () => {
    const response = await placeOrder(
      postRequest('http://localhost/api/orders', {
        addressId: 'addr-1',
        items: [{ skuId: 'sku-a', quantity: 1 }],
        couponId: '',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
