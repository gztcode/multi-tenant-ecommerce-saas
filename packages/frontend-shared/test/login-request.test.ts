/**
 * `createLoginRequest`：管理端 NextAuth `authorize()` 的登录请求构造。
 *
 * ⚠️ 必须覆盖式带 `x-forwarded-for`（XFF 最右一项）；取不到不发头，
 *    但不影响登录请求本身发出。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoginRequest } from '../src/login-request';

const BASE_URL = 'http://localhost:3000/api/v1';

function stubFetch() {
  const mock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function firstCall(mock: ReturnType<typeof stubFetch>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

function inboundRequest(xff: string): Request {
  return new Request('https://admin.example.com/api/auth/callback/credentials', {
    headers: { 'x-forwarded-for': xff },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLoginRequest', () => {
  it('clientIp 有值 → 覆盖式写入 x-forwarded-for', async () => {
    const fetchMock = stubFetch();
    const login = createLoginRequest({
      apiBaseUrl: BASE_URL,
      clientIp: () => '203.0.113.7',
    });

    await login({ email: 'a@b.c', password: 'x', scope: 'MERCHANT' });

    const { url, init, headers } = firstCall(fetchMock);
    expect(url).toBe(`${BASE_URL}/auth/login`);
    expect(init.method).toBe('POST');
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers).not.toHaveProperty('cookie');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@b.c',
      password: 'x',
      scope: 'MERCHANT',
    });
  });

  it('把入站请求原样交给 clientIp 取值函数', async () => {
    const fetchMock = stubFetch();
    const request = inboundRequest('198.51.100.1, 203.0.113.7');
    const login = createLoginRequest({
      apiBaseUrl: BASE_URL,
      clientIp: (incoming) => incoming?.headers.get('x-forwarded-for') ?? null,
    });

    await login({}, request);

    expect(firstCall(fetchMock).headers['x-forwarded-for']).toBe(
      '198.51.100.1, 203.0.113.7',
    );
  });

  it('clientIp 返回 null → 不发这个头', async () => {
    const fetchMock = stubFetch();
    const login = createLoginRequest({
      apiBaseUrl: BASE_URL,
      clientIp: () => null,
    });

    await login({});
    expect(firstCall(fetchMock).headers).not.toHaveProperty('x-forwarded-for');
  });

  it('clientIp 抛错 → 吞掉异常，照常登录且不发头', async () => {
    const fetchMock = stubFetch();
    const login = createLoginRequest({
      apiBaseUrl: BASE_URL,
      clientIp: () => {
        throw new Error('取不到入站头');
      },
    });

    await expect(login({})).resolves.toBeInstanceOf(Response);
    expect(firstCall(fetchMock).headers).not.toHaveProperty('x-forwarded-for');
  });

  it('不传 clientIp → 不带任何额外头', async () => {
    const fetchMock = stubFetch();
    const login = createLoginRequest({ apiBaseUrl: BASE_URL });

    await login({ email: 'a@b.c' });

    expect(firstCall(fetchMock).headers).toEqual({
      'content-type': 'application/json',
    });
  });
});
