/**
 * 护栏补测：storefront 写型 BFF 路由（审计 §九「三端 BFF 路由系统扫描」钉子化）。
 *
 * 覆盖的 9 个路由（清单外的已有测试不要重复）：
 * - addresses [POST]：登录必填，body 白名单（receiver/phone/province/city/district/detail/isDefault）
 * - addresses/[id] [PATCH, DELETE]：登录必填，PATCH 白名单同新增，不接受 customerId
 * - cart/items/[id] [PATCH, DELETE]：**游客可用**（无 token 也打到后端），PATCH 只收 quantity
 * - cart/merge [POST]：登录必填，后端 Set-Cookie 清游客车 → 转写
 * - cart [DELETE]：**游客可用**（无 token 也打到后端）
 * - orders/[orderNo]/cancel [POST]：登录必填，body {}
 * - orders/[orderNo]/confirm [POST]：登录必填，body {}
 * - orders/[orderNo]/pay [POST]：登录必填，body {}，payUrl 拼绝对 URL
 * - orders/guest-lookup [POST]：**唯一不要 accessToken 的写型中转**，body 白名单（orderNo/phone）
 *
 * 断言纪律（与既有 order-whitelist / cart-whitelist 一致）：
 * - 未登录 → 401 且不调后端；游客允许的路由改为断言「无 token 也打到后端」。
 * - 已登录 → 打到正确后端路径 + method（+ body）。
 * - 带 body 的路由 → `toEqual` 完整 body（断言「后端收到的 body 正好是白名单那几个键」）。
 *
 * ⚠️ 中转路由分两类：`fetchBackend`（apiFetch）与 `fetchWithCookie`（apiFetchWithSetCookie）。
 *    两个都要 mock——同一个 `@/lib/api-client` 模块的两个导出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    apiFetchWithSetCookie: vi.fn(),
  };
});

import { auth } from '@/auth';
import { cookies, headers } from 'next/headers';
import { apiFetch, apiFetchWithSetCookie } from '@/lib/api-client';

import { POST as createAddress } from '@/app/api/addresses/route';
import {
  PATCH as patchAddress,
  DELETE as deleteAddress,
} from '@/app/api/addresses/[id]/route';
import {
  PATCH as patchCartItem,
  DELETE as deleteCartItem,
} from '@/app/api/cart/items/[id]/route';
import { POST as mergeCart } from '@/app/api/cart/merge/route';
import { DELETE as clearCart } from '@/app/api/cart/route';
import { POST as cancelOrder } from '@/app/api/orders/[orderNo]/cancel/route';
import { POST as confirmOrder } from '@/app/api/orders/[orderNo]/confirm/route';
import { POST as payOrder } from '@/app/api/orders/[orderNo]/pay/route';
import { POST as guestLookup } from '@/app/api/orders/guest-lookup/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);
const apiFetchWithSetCookieMock = vi.mocked(apiFetchWithSetCookie);
const cookiesMock = vi.mocked(cookies);
const headersMock = vi.mocked(headers);

/** 动态段路由的第二参：params 是 Promise（泛型保持与路由签名兼容） */
function routeParams<T extends Record<string, string>>(record: T): {
  params: Promise<T>;
} {
  return { params: Promise.resolve(record) };
}

/** 让 cookies() 返回指定的 cart_token（undefined = 没有游客车） */
function mockCookieToken(value: string | undefined) {
  cookiesMock.mockResolvedValue({
    get: () => (value === undefined ? undefined : { value }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({} as never);
  apiFetchWithSetCookieMock.mockResolvedValue({
    data: {},
    setCookie: null,
  } as never);
  // 中转路由要读请求头（解析店铺子域名）与 cookie（转发 cart_token）
  headersMock.mockResolvedValue(
    new Headers({ 'x-tenant-subdomain': 'demo' }) as never,
  );
  mockCookieToken(undefined);
});

describe('addresses POST：新增地址', () => {
  const validBody = {
    receiver: '张三',
    phone: '13800000000',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    detail: '科技园 1 号',
    isDefault: true,
  };

  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await createAddress(
      postRequest('http://localhost/api/addresses', validBody),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /addresses POST，body 按白名单重建', async () => {
    const response = await createAddress(
      postRequest('http://localhost/api/addresses', validBody),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/addresses', {
      method: 'POST',
      body: validBody,
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });

  it('customerId / tenantId / 未知字段不进后端请求体（白名单重建）', async () => {
    await createAddress(
      postRequest('http://localhost/api/addresses', {
        ...validBody,
        customerId: 'someone-else',
        tenantId: 'other-tenant',
        id: 'addr-999',
        foo: 'bar',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    // ⚠️ 断言「正好是白名单那几个键」，不能只断言「不含某字段」。
    expect(Object.keys(body).sort()).toEqual(
      [
        'city',
        'detail',
        'district',
        'isDefault',
        'phone',
        'province',
        'receiver',
      ].sort(),
    );
    expect(body).not.toHaveProperty('customerId');
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('foo');
  });
});

describe('addresses/[id]：改地址与删地址', () => {
  it('PATCH 未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await patchAddress(
      postRequest('http://localhost/api/addresses/addr-1', {
        detail: '新地址',
      }),
      routeParams({ id: 'addr-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('PATCH 已登录 → 打到 /addresses/addr-1 PATCH，body 白名单重建', async () => {
    const response = await patchAddress(
      postRequest('http://localhost/api/addresses/addr-1', {
        detail: '新地址',
        receiver: '李四',
        customerId: 'someone-else',
        tenantId: 'other-tenant',
        foo: 'bar',
      }),
      routeParams({ id: 'addr-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/addresses/addr-1', {
      method: 'PATCH',
      body: { detail: '新地址', receiver: '李四' },
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });

  it('PATCH 只发未知字段 → 400（没有可改字段），且不调后端', async () => {
    const response = await patchAddress(
      postRequest('http://localhost/api/addresses/addr-1', {
        customerId: 'someone-else',
        foo: 'bar',
      }),
      routeParams({ id: 'addr-1' }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE 未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await deleteAddress(
      new Request('http://localhost/api/addresses/addr-1', {
        method: 'DELETE',
      }),
      routeParams({ id: 'addr-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE 已登录 → 打到 /addresses/addr-1 DELETE，返回 204', async () => {
    const response = await deleteAddress(
      new Request('http://localhost/api/addresses/addr-1', {
        method: 'DELETE',
      }),
      routeParams({ id: 'addr-1' }),
    );

    expect(response.status).toBe(204);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/addresses/addr-1', {
      method: 'DELETE',
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('cart/items/[id]：改数量与删条目（游客可用）', () => {
  it('PATCH 游客（无 token）也能打到后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await patchCartItem(
      postRequest('http://localhost/api/cart/items/item-1', { quantity: 2 }),
      routeParams({ id: 'item-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledTimes(1);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledWith('/cart/items/item-1', {
      method: 'PATCH',
      body: { quantity: 2 },
      subdomain: 'demo',
      token: undefined,
      cookie: undefined,
    });
  });

  it('PATCH 已登录 → 打到 /cart/items/item-1 PATCH，body 恰好只有 quantity', async () => {
    const response = await patchCartItem(
      postRequest('http://localhost/api/cart/items/item-1', {
        quantity: 3,
        unitPrice: 1,
        price: 1,
        skuId: 'sku-a',
        foo: 'bar',
      }),
      routeParams({ id: 'item-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledTimes(1);
    const [, options] = apiFetchWithSetCookieMock.mock.calls[0];
    // ⚠️ body 必须恰好只有 quantity：价格字段绝不能从客户端来。
    expect(options?.body).toEqual({ quantity: 3 });
  });

  it('PATCH 带游客车 cookie → 转发 cart_token', async () => {
    mockCookieToken('guest-token-abc');

    await patchCartItem(
      postRequest('http://localhost/api/cart/items/item-1', { quantity: 1 }),
      routeParams({ id: 'item-1' }),
    );

    const [, options] = apiFetchWithSetCookieMock.mock.calls[0];
    expect(options?.cookie).toBe('cart_token=guest-token-abc');
  });

  it('PATCH quantity 非法 → 400，且不调后端', async () => {
    const response = await patchCartItem(
      postRequest('http://localhost/api/cart/items/item-1', { quantity: 0 }),
      routeParams({ id: 'item-1' }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchWithSetCookieMock).not.toHaveBeenCalled();
  });

  it('DELETE 游客（无 token）也能打到后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await deleteCartItem(
      new Request('http://localhost/api/cart/items/item-1', {
        method: 'DELETE',
      }),
      routeParams({ id: 'item-1' }),
    );

    expect(response.status).toBe(204);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledTimes(1);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledWith('/cart/items/item-1', {
      method: 'DELETE',
      subdomain: 'demo',
      token: undefined,
      cookie: undefined,
    });
  });

  it('DELETE 已登录 → 打到 /cart/items/item-1 DELETE', async () => {
    const response = await deleteCartItem(
      new Request('http://localhost/api/cart/items/item-1', {
        method: 'DELETE',
      }),
      routeParams({ id: 'item-1' }),
    );

    expect(response.status).toBe(204);
    const [, options] = apiFetchWithSetCookieMock.mock.calls[0];
    expect(options?.method).toBe('DELETE');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });
});

describe('cart/merge：合并游客车', () => {
  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await mergeCart();

    expect(response.status).toBe(401);
    expect(apiFetchWithSetCookieMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /cart/merge POST，不带 body', async () => {
    const response = await mergeCart();

    expect(response.status).toBe(200);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledTimes(1);
    expect(apiFetchWithSetCookieMock).toHaveBeenCalledWith('/cart/merge', {
      method: 'POST',
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
      cookie: undefined,
    });
  });

  it('后端 Set-Cookie 清游客车 → 转写进响应头', async () => {
    apiFetchWithSetCookieMock.mockResolvedValue({
      data: {},
      setCookie: 'cart_token=; Max-Age=0; Path=/; HttpOnly',
    } as never);

    const response = await mergeCart();

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('cart_token=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });
});

describe('cart DELETE：清空购物车（游客可用）', () => {
  it('游客（无 token）也能打到后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await clearCart();

    expect(response.status).toBe(204);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/cart', {
      method: 'DELETE',
      subdomain: 'demo',
      token: undefined,
      cookie: undefined,
    });
  });

  it('已登录 → 打到 /cart DELETE', async () => {
    const response = await clearCart();

    expect(response.status).toBe(204);
    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.method).toBe('DELETE');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });
});

describe('orders/[orderNo]/cancel：取消订单', () => {
  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await cancelOrder(
      postRequest('http://localhost/api/orders/ORDER-1/cancel', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /orders/ORDER-1/cancel POST，body 为空对象', async () => {
    const response = await cancelOrder(
      postRequest('http://localhost/api/orders/ORDER-1/cancel', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders/ORDER-1/cancel', {
      method: 'POST',
      body: {},
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('orders/[orderNo]/confirm：确认收货', () => {
  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await confirmOrder(
      postRequest('http://localhost/api/orders/ORDER-1/confirm', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /orders/ORDER-1/confirm POST，body 为空对象', async () => {
    const response = await confirmOrder(
      postRequest('http://localhost/api/orders/ORDER-1/confirm', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders/ORDER-1/confirm', {
      method: 'POST',
      body: {},
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('orders/[orderNo]/pay：发起支付', () => {
  const payment = {
    paymentId: 'pay-1',
    orderNo: 'ORDER-1',
    amount: 100,
    channel: 'fake',
    status: 'PENDING',
    payUrl: '/api/v1/pay/fake/pay-1',
  };

  beforeEach(() => {
    // absolutePayUrl 读 process.env.API_BASE_URL；测试里固定默认值保证可断言。
    process.env.API_BASE_URL = 'http://localhost:3000/api/v1';
  });

  afterEach(() => {
    delete process.env.API_BASE_URL;
  });

  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await payOrder(
      postRequest('http://localhost/api/orders/ORDER-1/pay', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /orders/ORDER-1/pay POST，body 为空对象', async () => {
    apiFetchMock.mockResolvedValue(payment as never);

    const response = await payOrder(
      postRequest('http://localhost/api/orders/ORDER-1/pay', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders/ORDER-1/pay', {
      method: 'POST',
      body: {},
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });

  it('后端相对 payUrl 拼成绝对 URL 再返回', async () => {
    apiFetchMock.mockResolvedValue(payment as never);

    const response = await payOrder(
      postRequest('http://localhost/api/orders/ORDER-1/pay', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    // 不能把后端的 /api/v1 前缀拼两遍：base 以 /api/v1 结尾，payUrl 以 /api/v1 开头。
    expect(payload.payUrl).toBe('http://localhost:3000/api/v1/pay/fake/pay-1');
  });

  it('payUrl 已是绝对地址 → 原样透传', async () => {
    apiFetchMock.mockResolvedValue({
      ...payment,
      payUrl: 'https://pay.example.com/wx/code_url',
    } as never);

    const response = await payOrder(
      postRequest('http://localhost/api/orders/ORDER-1/pay', {}),
      routeParams({ orderNo: 'ORDER-1' }),
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(payload.payUrl).toBe('https://pay.example.com/wx/code_url');
  });
});

describe('orders/guest-lookup：游客查订单（唯一免 accessToken 的写型中转）', () => {
  it('不需要 token 也能打到后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await guestLookup(
      postRequest('http://localhost/api/orders/guest-lookup', {
        orderNo: 'ORDER-1',
        phone: '13800000000',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/orders/guest-lookup', {
      method: 'POST',
      subdomain: 'demo',
      body: { orderNo: 'ORDER-1', phone: '13800000000' },
    });
  });

  it('未知字段不进后端请求体（白名单重建，只有 orderNo / phone）', async () => {
    await guestLookup(
      postRequest('http://localhost/api/orders/guest-lookup', {
        orderNo: 'ORDER-1',
        phone: '13800000000',
        customerId: 'someone-else',
        token: 'a-client-provided-token',
        foo: 'bar',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    // ⚠️ 断言「正好是白名单那两个键」。
    expect(options?.body).toEqual({
      orderNo: 'ORDER-1',
      phone: '13800000000',
    });
  });

  it('缺订单号或手机号 → 400，且不调后端', async () => {
    const response = await guestLookup(
      postRequest('http://localhost/api/orders/guest-lookup', {
        orderNo: 'ORDER-1',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
