/**
 * 登出时吊销后端刷新令牌。
 *
 * ⚠️ 这里最重要的两条约定：
 * 1. **登出必须打后端 `/auth/logout`**——NextAuth 的 `signOut()` 只清 cookie，
 *    不吊销的话刷新令牌还能用 30 天。
 * 2. **吊销失败绝不阻断登出**——网络异常 / 5xx 只记日志，函数不抛。
 */
import { describe, expect, it, vi } from 'vitest';

import { makeSignOutEvent, revokeBackendSession } from '../src/sign-out';

const API_BASE_URL = 'http://api.test/api/v1';

const TOKEN = { accessToken: 'test-access-token', refreshToken: 'test-refresh-token' };

function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('revokeBackendSession：成功路径', () => {
  it('POST /auth/logout，带 Bearer 访问令牌，请求体只带 refreshToken', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));

    await expect(
      revokeBackendSession(TOKEN, { apiBaseUrl: API_BASE_URL, fetchImpl }),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/auth/logout`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer test-access-token',
    });
    // 白名单式断言完整 body：多传字段就等于把前端变成了后端的透传通道。
    expect(JSON.parse(init.body as string)).toEqual({
      refreshToken: 'test-refresh-token',
    });
  });

  it('带上超时信号，后端卡住时不会把登出一起卡住', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));

    await revokeBackendSession(TOKEN, {
      apiBaseUrl: API_BASE_URL,
      fetchImpl,
      timeoutMs: 50,
    });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('revokeBackendSession：失败不抛', () => {
  it('后端返回 500 时返回 false 并记日志，不抛异常', async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch(
      async () => new Response('boom', { status: 500 }),
    );

    await expect(
      revokeBackendSession(TOKEN, {
        apiBaseUrl: API_BASE_URL,
        fetchImpl,
        onError,
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('网络异常（fetch 直接 reject）时返回 false 并记日志，不抛异常', async () => {
    const onError = vi.fn();
    const fetchImpl = mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(
      revokeBackendSession(TOKEN, {
        apiBaseUrl: API_BASE_URL,
        fetchImpl,
        onError,
      }),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('没有刷新令牌时不发请求直接返回 false', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));

    await expect(
      revokeBackendSession(
        { accessToken: 'test-access-token' },
        { apiBaseUrl: API_BASE_URL, fetchImpl },
      ),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('没有访问令牌时不发请求直接返回 false（/auth/logout 需要身份）', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));

    await expect(
      revokeBackendSession(
        { refreshToken: 'test-refresh-token' },
        { apiBaseUrl: API_BASE_URL, fetchImpl },
      ),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('token 为 null 时安全跳过', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));

    await expect(
      revokeBackendSession(null, { apiBaseUrl: API_BASE_URL, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('makeSignOutEvent', () => {
  it('把 JWT 里的令牌传给后端', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));
    const signOutEvent = makeSignOutEvent({
      apiBaseUrl: API_BASE_URL,
      fetchImpl,
    });

    await expect(
      signOutEvent({ token: { ...TOKEN, sub: 'user-1' } }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('吊销失败时 Promise 仍然 resolve（不能出现「登不出去」）', async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error('backend down');
    });
    const signOutEvent = makeSignOutEvent({
      apiBaseUrl: API_BASE_URL,
      fetchImpl,
      onError: () => undefined,
    });

    await expect(signOutEvent({ token: TOKEN })).resolves.toBeUndefined();
  });

  it('onError 自己抛异常也不会漏出去', async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error('backend down');
    });
    const signOutEvent = makeSignOutEvent({
      apiBaseUrl: API_BASE_URL,
      fetchImpl,
      onError: () => {
        throw new Error('logger exploded');
      },
    });

    await expect(signOutEvent({ token: TOKEN })).resolves.toBeUndefined();
  });

  it('没有 token（会话本就无效）时什么都不做', async () => {
    const fetchImpl = mockFetch(async () => new Response(null, { status: 204 }));
    const signOutEvent = makeSignOutEvent({
      apiBaseUrl: API_BASE_URL,
      fetchImpl,
    });

    await expect(signOutEvent({})).resolves.toBeUndefined();
    await expect(signOutEvent({ token: null })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
