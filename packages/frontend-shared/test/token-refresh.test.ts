/**
 * 用刷新令牌换新令牌。
 *
 * ⚠️ 这里最贵的两个约定：
 * 1. **同一枚刷新令牌在途只发一次**——后端是轮换式的，并发两次会被判重放，
 *    吊销该用户**所有设备**的登录（单进程内去重，扩副本要换分布式锁）。
 * 2. **网络失败 ≠ 凭证失效**——401/403 才作废会话，其余（网络异常、5xx、
 *    响应不完整）一律保留旧令牌，下次再试。
 */
import { describe, expect, it, vi } from 'vitest';

import { refreshTokens, shouldInvalidateSession } from '../src/token-refresh';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('refreshTokens：成功路径', () => {
  it('返回新的一对令牌', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
    );

    await expect(refreshTokens('ok-1', fetchImpl)).resolves.toEqual({
      ok: true,
      tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' },
    });
  });

  it('请求打到 /auth/refresh，方法 POST，请求体只带 refreshToken', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ accessToken: 'a', refreshToken: 'b' }),
    );

    await refreshTokens('ok-2', fetchImpl);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url.endsWith('/auth/refresh')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    // ⚠️ 只带刷新令牌：多带字段（比如用户 id）会让「不信任客户端」的后端犯难
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'ok-2' });
  });
});

describe('refreshTokens：在途去重', () => {
  it('同一枚令牌并发三次只发一次请求，结果相同', async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls += 1;
      return jsonResponse({ accessToken: 'a', refreshToken: 'b' });
    });

    const results = await Promise.all([
      refreshTokens('dedupe-1', fetchImpl),
      refreshTokens('dedupe-1', fetchImpl),
      refreshTokens('dedupe-1', fetchImpl),
    ]);

    expect(calls).toBe(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it('刷新结束后释放去重名额（失败也不留死锁）', async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls += 1;
      return new Response('', { status: 500 });
    });

    await refreshTokens('dedupe-2', fetchImpl);
    await refreshTokens('dedupe-2', fetchImpl);

    expect(calls).toBe(2);
  });

  it('不同令牌互不干扰（各自发一次）', async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls += 1;
      return jsonResponse({ accessToken: 'a', refreshToken: 'b' });
    });

    await Promise.all([
      refreshTokens('dedupe-3a', fetchImpl),
      refreshTokens('dedupe-3b', fetchImpl),
    ]);

    expect(calls).toBe(2);
  });
});

describe('refreshTokens：失败分类', () => {
  it('401 / 403 → invalid（凭证真的失效，调用方据此作废会话）', async () => {
    await expect(
      refreshTokens('bad-401', mockFetch(async () => new Response('', { status: 401 }))),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });

    await expect(
      refreshTokens('bad-403', mockFetch(async () => new Response('', { status: 403 }))),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('5xx → network（后端没给出「凭证无效」的结论）', async () => {
    await expect(
      refreshTokens('bad-500', mockFetch(async () => new Response('', { status: 500 }))),
    ).resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('请求抛错（后端没起来 / 断网）→ network', async () => {
    const fetchImpl = mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(refreshTokens('bad-network', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('响应缺 accessToken 或缺 refreshToken → network（不判定凭证失效）', async () => {
    await expect(
      refreshTokens('bad-shape-1', mockFetch(async () => jsonResponse({ accessToken: 'a' }))),
    ).resolves.toEqual({ ok: false, reason: 'network' });

    await expect(
      refreshTokens('bad-shape-2', mockFetch(async () => jsonResponse({ refreshToken: 'b' }))),
    ).resolves.toEqual({ ok: false, reason: 'network' });

    await expect(
      refreshTokens(
        'bad-shape-3',
        mockFetch(async () => jsonResponse({ accessToken: '', refreshToken: 'b' })),
      ),
    ).resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('200 但响应体不是 JSON → network（不能把「响应不完整」变成异常）', async () => {
    // 真实场景：反向代理/维护页/门户劫持会给出 200 + HTML。
    // 若这里抛 SyntaxError，`auth()` 每次读会话都会炸，用户看到 500 页面；
    // 而按本模块的约定，这只该算「这次没刷成」，保留旧令牌下次再试。
    await expect(
      refreshTokens(
        'bad-shape-4',
        mockFetch(
          async () =>
            new Response('<html>维护中</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('200 但响应体是 JSON null → network（不是对象，当作响应不完整）', async () => {
    await expect(
      refreshTokens('bad-shape-5', mockFetch(async () => jsonResponse(null))),
    ).resolves.toEqual({ ok: false, reason: 'network' });
  });
});

describe('shouldInvalidateSession', () => {
  it('只有「凭证失效」才作废会话', () => {
    expect(shouldInvalidateSession({ ok: false, reason: 'invalid' })).toBe(true);
    expect(shouldInvalidateSession({ ok: false, reason: 'network' })).toBe(false);
    expect(
      shouldInvalidateSession({
        ok: true,
        tokens: { accessToken: 'a', refreshToken: 'b' },
      }),
    ).toBe(false);
    expect(shouldInvalidateSession(null)).toBe(false);
  });
});
