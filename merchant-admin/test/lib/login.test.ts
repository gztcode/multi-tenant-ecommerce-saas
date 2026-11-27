/**
 * NextAuth `authorize()` 发出的登录请求。
 *
 * ⚠️ 必须带 `x-forwarded-for`（XFF **最右**一项）：api 的 `/auth/login`
 *    按来源 IP 限流，不带这个头时所有商家登录都来自同一个 BFF 容器，
 *    共用一个 30 次/15 分钟的桶 —— 攻击者试错就能锁死全平台登录。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestLogin } from '@/lib/login';

/** 模拟 NextAuth 递给 `authorize(credentials, request)` 的入站请求 */
function inboundRequest(xff?: string): Request {
  return new Request('https://merchant.example.com/api/auth/callback/credentials', {
    method: 'POST',
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });
}

function stubFetch() {
  const mock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

function firstCall(mock: ReturnType<typeof stubFetch>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authorize 的登录请求', () => {
  it('转发真实客户端 IP：只发 XFF 最右一项（不拼整串）', async () => {
    const fetchMock = stubFetch();

    await requestLogin(
      {
        email: 'merchant@example.com',
        password: 'secret',
        scope: 'MERCHANT',
      },
      inboundRequest('198.51.100.1, 198.51.100.2, 203.0.113.7'),
    );

    const { url, init, headers } = firstCall(fetchMock);
    expect(url).toMatch(/\/auth\/login$/);
    expect(init.method).toBe('POST');
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'merchant@example.com',
      password: 'secret',
      scope: 'MERCHANT',
    });
  });

  it('入站没有 XFF → 不发 x-forwarded-for（也不发空串）', async () => {
    const fetchMock = stubFetch();

    await requestLogin(
      { email: 'a@b.c', password: 'x', scope: 'MERCHANT' },
      inboundRequest(),
    );

    const { headers } = firstCall(fetchMock);
    expect(headers).not.toHaveProperty('x-forwarded-for');
  });

  it('没有入站请求（非请求作用域）→ 仍发登录请求，只是不带该头', async () => {
    const fetchMock = stubFetch();

    const response = await requestLogin({
      email: 'a@b.c',
      password: 'x',
      scope: 'MERCHANT',
    });

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstCall(fetchMock).headers).not.toHaveProperty('x-forwarded-for');
  });

  it('读入站头抛错 → 仍发登录请求，只是不带该头', async () => {
    const fetchMock = stubFetch();
    const brokenRequest = {
      headers: {
        get() {
          throw new Error('headers 不可用');
        },
      },
    } as unknown as Request;

    const response = await requestLogin(
      { email: 'a@b.c', password: 'x', scope: 'MERCHANT' },
      brokenRequest,
    );

    expect(response.ok).toBe(true);
    expect(firstCall(fetchMock).headers).not.toHaveProperty('x-forwarded-for');
  });
});
