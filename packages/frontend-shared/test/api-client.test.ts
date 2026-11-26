/**
 * 三端共用的后端 API 客户端。
 *
 * ⚠️ 这个文件里最贵的几条约定：
 * - 网络失败要**收敛成 ApiError(503)**（否则界面显示 `TypeError: fetch failed`）；
 * - 空响应体是 `null` 不是「加载失败」，204 是 `undefined`；
 * - 没有令牌时**不发匿名请求**，直接本地 401；
 * - `x-forwarded-for` 是**覆盖式**写入，取不到就**不发**（假 IP 比没有更糟）；
 * - 请求体序列化在 `try` 外（循环引用是调用方 bug，不是网络故障）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createApiClient,
  localizeApiMessage,
  type SharedApiClientOptions,
} from '../src/api-client';

const BASE_URL = 'http://localhost:3000/api/v1';

function makeClient(overrides: Partial<SharedApiClientOptions> = {}) {
  return createApiClient({
    baseUrl: BASE_URL,
    forwardCookie: false,
    auth: async () => null,
    ...overrides,
  });
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 取出第一次 fetch 的 URL 与 init（含 headers 对象） */
function firstCall(mock: ReturnType<typeof stubFetch>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

async function catchApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('预期抛出 ApiError，但请求成功了');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('成功响应', () => {
  it('GET 到 baseUrl + path，默认方法与请求头正确', async () => {
    const mock = stubFetch(async () => jsonResponse({ id: 'order-1' }));

    await expect(makeClient().apiFetch('/orders/order-1')).resolves.toEqual({
      id: 'order-1',
    });

    const { url, init, headers } = firstCall(mock);
    expect(url).toBe(`${BASE_URL}/orders/order-1`);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(headers['content-type']).toBe('application/json');
  });

  it('204 → undefined', async () => {
    stubFetch(async () => new Response(null, { status: 204 }));

    await expect(makeClient().apiFetch('/orders/x')).resolves.toBeUndefined();
  });

  it('⚠️ 空响应体 → null（200 + 空 body 不是错误）', async () => {
    stubFetch(async () => new Response('', { status: 200 }));
    await expect(makeClient().apiFetch('/orders/x')).resolves.toBeNull();

    stubFetch(async () => new Response('  \n\t ', { status: 200 }));
    await expect(makeClient().apiFetch('/orders/x')).resolves.toBeNull();
  });

  it('body 为 undefined 时请求里不带 body（不能序列化成字符串 "undefined"）', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient().apiFetch('/orders', { method: 'POST' });

    expect(firstCall(mock).init.body).toBeUndefined();
  });

  it('对象 body 被序列化成 JSON', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient().apiFetch('/orders', {
      method: 'POST',
      body: { skuId: 'sku-1', quantity: 2 },
    });

    expect(firstCall(mock).init.body).toBe('{"skuId":"sku-1","quantity":2}');
    expect(firstCall(mock).init.method).toBe('POST');
  });

  it('validate 钩子可以转换响应数据', async () => {
    stubFetch(async () => jsonResponse({ items: [1, 2] }));

    const data = await makeClient().apiFetch('/orders', {
      validate: (raw) => (raw as { items: number[] }).items.length,
    });

    expect(data).toBe(2);
  });
});

describe('错误响应', () => {
  it('⚠️ 网络失败收敛成 503 NETWORK_ERROR 的中文文案', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const error = await catchApiError(makeClient().apiFetch('/orders'));

    expect(error.status).toBe(503);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('网络连接失败，请检查网络后重试');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('ApiError');
  });

  it('⚠️ 401 + 后端默认文案 Unauthorized → 翻成中文', async () => {
    stubFetch(async () => jsonResponse({ code: 'UNAUTHORIZED', message: 'Unauthorized' }, 401));

    const error = await catchApiError(makeClient().apiFetch('/orders'));

    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('登录已过期，请重新登录');
  });

  it('后端主动给的中文消息原样透传（不覆盖成通用文案）', async () => {
    stubFetch(async () =>
      jsonResponse({ code: 'UNAUTHORIZED', message: '刷新令牌无效或已过期' }, 401),
    );

    const error = await catchApiError(makeClient().apiFetch('/orders'));

    expect(error.message).toBe('刷新令牌无效或已过期');
  });

  it('非 401 的默认文案不动', () => {
    expect(localizeApiMessage(403, 'Forbidden')).toBe('Forbidden');
    expect(localizeApiMessage(401, 'Unauthorized')).toBe('登录已过期，请重新登录');
  });

  it('业务错误保留状态码、code 与 details', async () => {
    stubFetch(async () =>
      jsonResponse(
        { code: 'INSUFFICIENT_STOCK', message: '库存不足', details: { skuId: 'sku-1' } },
        409,
      ),
    );

    const error = await catchApiError(makeClient().apiFetch('/orders'));

    expect(error.status).toBe(409);
    expect(error.code).toBe('INSUFFICIENT_STOCK');
    expect(error.message).toBe('库存不足');
    expect(error.details).toEqual({ skuId: 'sku-1' });
  });

  it('⚠️ 错误响应体不是 JSON（反向代理的 502 HTML）→ 兜底成 UNKNOWN / 请求失败', async () => {
    stubFetch(
      async () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const error = await catchApiError(makeClient().apiFetch('/orders'));

    expect(error.status).toBe(502);
    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toBe('请求失败');
  });

  it('validate 失败 → ApiError（状态码沿用响应，code = RESPONSE_SHAPE）', async () => {
    stubFetch(async () => jsonResponse({ items: 'not-an-array' }));

    const error = await catchApiError(
      makeClient().apiFetch('/orders', {
        validate: () => {
          throw new Error('items 不是数组');
        },
      }),
    );

    expect(error.status).toBe(200);
    expect(error.code).toBe('RESPONSE_SHAPE');
    expect(error.message).toBe('响应结构不符：items 不是数组');
  });

  it('⚠️ 循环引用的 body 抛 TypeError，而不是被误报成 503 网络错误', async () => {
    const mock = stubFetch(async () => jsonResponse({}));
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      makeClient().apiFetch('/orders', { method: 'POST', body: circular }),
    ).rejects.toBeInstanceOf(TypeError);
    // 请求根本没发出去
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('请求头', () => {
  it('工厂的 tenantSubdomain 作为缺省值发出', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient({ tenantSubdomain: 'shop-a' }).apiFetch('/products');

    expect(firstCall(mock).headers['x-tenant-subdomain']).toBe('shop-a');
  });

  it('请求级 subdomain 覆盖工厂缺省值', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient({ tenantSubdomain: 'shop-a' }).apiFetch('/products', {
      subdomain: 'shop-b',
    });

    expect(firstCall(mock).headers['x-tenant-subdomain']).toBe('shop-b');
  });

  it('没有子域名时（含空串）不发这个头', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient({ tenantSubdomain: null }).apiFetch('/products');
    await makeClient({ tenantSubdomain: '' }).apiFetch('/products');

    for (const call of mock.mock.calls) {
      expect((call[1].headers as Record<string, string>)['x-tenant-subdomain']).toBeUndefined();
    }
  });

  it('forwardCookie 为 true 才转发 cookie', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient({ forwardCookie: true }).apiFetch('/cart', {
      cookie: 'cart_token=abc',
    });
    expect(firstCall(mock).headers.cookie).toBe('cart_token=abc');

    const mock2 = stubFetch(async () => jsonResponse({}));
    await makeClient({ forwardCookie: false }).apiFetch('/cart', {
      cookie: 'cart_token=abc',
    });
    expect(firstCall(mock2).headers.cookie).toBeUndefined();
  });

  it('token 走 Authorization: Bearer', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient().apiFetch('/orders', { token: 'access-1' });

    expect(firstCall(mock).headers.authorization).toBe('Bearer access-1');
  });

  it('clientIp 取到值才发 x-forwarded-for，且是单值覆盖', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient({ clientIp: async () => '203.0.113.7' }).apiFetch('/orders');

    expect(firstCall(mock).headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('⚠️ clientIp 返回 null 或抛错 → 不发这个头（不塞假 IP）', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    await makeClient({ clientIp: async () => null }).apiFetch('/orders');
    await makeClient({
      clientIp: async () => {
        throw new Error('headers() 在客户端组件里不可用');
      },
    }).apiFetch('/orders');

    for (const call of mock.mock.calls) {
      expect((call[1].headers as Record<string, string>)['x-forwarded-for']).toBeUndefined();
    }
  });
});

describe('apiFetchAuthed', () => {
  it('⚠️ 没有会话 → 本地 401 UNAUTHENTICATED，且不发请求', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    const error = await catchApiError(makeClient().apiFetchAuthed('/orders'));

    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.message).toBe('未登录或登录已过期');
    expect(mock).not.toHaveBeenCalled();
  });

  it('会话里的 accessToken 为空串 → 同样本地 401', async () => {
    const mock = stubFetch(async () => jsonResponse({}));

    const error = await catchApiError(
      makeClient({ auth: async () => ({ accessToken: '' }) }).apiFetchAuthed('/orders'),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(mock).not.toHaveBeenCalled();
  });

  it('有令牌时带上 Bearer 并返回数据', async () => {
    const mock = stubFetch(async () => jsonResponse({ id: 'order-1' }));

    await expect(
      makeClient({ auth: async () => ({ accessToken: 'access-1' }) }).apiFetchAuthed(
        '/orders/order-1',
      ),
    ).resolves.toEqual({ id: 'order-1' });

    expect(firstCall(mock).headers.authorization).toBe('Bearer access-1');
  });

  it('令牌与 validate 同时生效', async () => {
    stubFetch(async () => jsonResponse({ total: 3 }));

    const total = await makeClient({
      auth: async () => ({ accessToken: 'access-1' }),
    }).apiFetchAuthed('/orders', {
      method: 'POST',
      body: { page: 1 },
      validate: (raw) => (raw as { total: number }).total,
    });

    expect(total).toBe(3);
  });
});

describe('apiFetchWithSetCookie', () => {
  it('同时返回数据与 Set-Cookie 原文（属性不能被剥掉）', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'cart_token=abc123; Path=/; HttpOnly; SameSite=Lax',
          },
        }),
    );

    const result = await makeClient({ forwardCookie: true }).apiFetchWithSetCookie('/cart');

    expect(result.data).toEqual({ items: [] });
    expect(result.setCookie).toBe('cart_token=abc123; Path=/; HttpOnly; SameSite=Lax');
  });

  it('没有 Set-Cookie 时为 null', async () => {
    stubFetch(async () => jsonResponse({}));

    await expect(makeClient().apiFetchWithSetCookie('/cart')).resolves.toEqual({
      data: {},
      setCookie: null,
    });
  });
});

describe('apiAbsoluteUrl', () => {
  it('⚠️ 拼 origin 而不是 baseUrl（后端给的路径自带 /api/v1）', () => {
    const client = makeClient();

    expect(client.apiAbsoluteUrl('/api/v1/pay/fake/return')).toBe(
      'http://localhost:3000/api/v1/pay/fake/return',
    );
  });

  it('缺前导斜杠时补上', () => {
    expect(makeClient().apiAbsoluteUrl('api/v1/pay')).toBe(
      'http://localhost:3000/api/v1/pay',
    );
  });
});

describe('工厂返回值', () => {
  it('把 ApiError 与 localizeApiMessage 一并暴露给本端薄壳转发', () => {
    const client = makeClient();

    expect(client.ApiError).toBe(ApiError);
    expect(client.localizeApiMessage).toBe(localizeApiMessage);
  });
});
