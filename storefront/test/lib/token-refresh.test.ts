/**
 * 护栏 3 / 4 / 5：merchant-admin 的令牌刷新。
 *
 * 这三条例外——它们守的是**可被利用的漏洞**（设计文档 §5.1 的 L1 / L2 / L18）：
 * - 不刷新 → 商家后台 2 小时后整体不可用，界面却显示「已登录」（L1）
 * - 不去重 → 并发刷新被判重放 → 吊销该用户**所有设备**的登录（L2）
 * - 网络失败也作废会话 → 一次抖动就把商家永久踢出（L18）
 */
import { describe, expect, it, vi } from 'vitest';

import { refreshTokens, shouldInvalidateSession } from '@/lib/token-refresh';

/** 造一个成功的刷新响应 */
function refreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({ accessToken, refreshToken }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('刷新令牌', () => {
  it('成功后返回新的一对令牌', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse('new-access', 'new-refresh'));

    const result = await refreshTokens('old-refresh', fetchImpl);

    expect(result).toEqual({
      ok: true,
      tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' },
    });
  });

  it('请求体只带 refreshToken，不带任何别的东西', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse('new-access', 'new-refresh'));

    await refreshTokens('old-refresh', fetchImpl);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'old-refresh' });
  });

  it('并发调用只发一次请求（护栏 4）', async () => {
    // 后端的刷新是轮换式的，并发的第二次会被判成重放，
    // 连带吊销该用户所有设备上的登录（api/src/modules/auth/auth.service.ts
    // 第 268 行 revokeTokenFamily）。这是本 Task 最要紧的一条。
    //
    // ⚠️ 每次调用都造**新的** Response：同一个 Response 的 body 只能读一次，
    // 复用会让并发用例报「Body is unusable」而掩盖「请求发了几次」这个断言。
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(refreshResponse('new-access', 'new-refresh')),
      );

    const results = await Promise.all([
      refreshTokens('same-refresh', fetchImpl),
      refreshTokens('same-refresh', fetchImpl),
      refreshTokens('same-refresh', fetchImpl),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it('后端明确返回 401 时判定为「凭证失效」（护栏 5）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));

    expect(await refreshTokens('bad-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('后端返回 403 时同样判定为「凭证失效」', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 403 }));

    expect(await refreshTokens('bad-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('网络异常判定为「网络失败」而不是「凭证失效」（护栏 5 / L18）', async () => {
    // ⚠️ 这条是 L18 的核心：一次 200ms 的抖动不该把商家永久踢出登录。
    // 网络失败 → 保留旧令牌 → 下次读会话再试。
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await refreshTokens('old-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('后端 5xx 判定为「网络失败」，不作废会话', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));

    expect(await refreshTokens('old-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('响应里缺 accessToken 时判为「网络失败」，不抛错', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ refreshToken: 'r' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    expect(await refreshTokens('old-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

describe('刷新失败要不要作废会话', () => {
  // ⚠️ 这是 `jwt` 回调里那条分支的判据。`auth.ts` 没法进单元测试
  // （顶层就调 `NextAuth({...})`，import 它会在 Vitest 里报
  // `Cannot find module 'next/server'`），所以把判据抽成纯函数来测。
  it('凭证失效（401/403）→ 作废会话', () => {
    expect(shouldInvalidateSession({ ok: false, reason: 'invalid' })).toBe(true);
  });

  it('网络失败 → 不作废会话，保留旧令牌', () => {
    // L18：一次 200ms 的抖动不该把商家永久踢出登录。
    expect(shouldInvalidateSession({ ok: false, reason: 'network' })).toBe(false);
  });

  it('刷新成功 → 不作废会话', () => {
    expect(
      shouldInvalidateSession({
        ok: true,
        tokens: { accessToken: 'a', refreshToken: 'r' },
      }),
    ).toBe(false);
  });

  it('没有拿到结果（null）→ 不作废会话', () => {
    expect(shouldInvalidateSession(null)).toBe(false);
  });
});
