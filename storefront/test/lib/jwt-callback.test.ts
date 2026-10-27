/**
 * 护栏 G9 / G10 / G11：`jwt` 回调的决策逻辑。
 *
 * ⚠️ **这份逻辑之前零自动化覆盖**（阶段 4 验收记录 §六·5）：
 * 把「过期时刷新」整段删掉，75 条测试全绿。
 *
 * ⚠️ **为什么要抽成独立模块**：`auth.ts` 顶层就调 `NextAuth({...})`，
 * import 它会初始化 next-auth 的整个依赖图（含 `server-only`），
 * 在 Vitest 的 node 环境里直接报 `Cannot find module 'next/server'`。
 *
 * ⚠️ **这个模块不能 import `next-auth` 的任何东西**（连类型也不能）——
 * 所以它自己定义最小类型。
 */
import { describe, expect, it } from 'vitest';

import { makeJwtCallback, makeSessionCallback } from '@/lib/jwt-callback';
import type { JwtToken } from '@/lib/jwt-callback';

/** 造一个已过期的 accessToken（exp 在 1 小时前） */
function expiredAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
      iat: Math.floor(Date.now() / 1000) - 7200,
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** 造一个还没过期的 accessToken */
function validAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('jwt 回调：什么时候刷新（G9 / G10）', () => {
  it('accessToken 过期且能送回 cookie 时刷新，并把新令牌落到 token 上（G9）', async () => {
    // ⚠️ **刷新函数是注入点** —— 不然测试环境里没有后端，
    // fetch 必然失败 → 走 network 分支 → 断言不出「刷新成功了」。
    const jwt = makeJwtCallback(true, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    // 关键断言：新令牌落到了 token 上
    expect(result.accessToken).toBe('fresh-access');
    expect(result.refreshToken).toBe('fresh-refresh');
  });

  it('accessToken 没过期时完全不刷新', async () => {
    const jwt = makeJwtCallback(true, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const token: JwtToken = {
      accessToken: validAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    // 没过期 → 原样返回，一个字段都不动
    expect(result.accessToken).toBe(token.accessToken);
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('送不回去 cookie 时不刷新（G10）', async () => {
    // ⚠️ **这条是阶段 4 提交 8545635 的核心**。
    // 删掉它 → Server Component 里的 `await auth()` 每次都刷新 →
    // 服务端把旧令牌轮换掉、而浏览器永远拿不到新令牌 →
    // 下次读会话拿旧令牌去刷 → 后端判重放 → 吊销全族 →
    // **商家开第二个标签页就被踢下线**。
    const jwt = makeJwtCallback(false, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(token.accessToken);
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('token 里没有 accessToken 或 refreshToken 时原样返回', async () => {
    const jwt = makeJwtCallback(true, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const result = await jwt({ token: { role: 'MERCHANT_OWNER' } });
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
  });
});

describe('jwt 回调：刷新失败怎么办（G11）', () => {
  it('刷新失败且判定为「凭证失效」时作废整个会话（G11）', async () => {
    const jwt = makeJwtCallback(true, async () => ({
      ok: false,
      reason: 'invalid',
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    // 关键断言：两个令牌都被清空 → 中转路由按游客处理，
    // 用户界面上能看出自己掉登录了。
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
  });

  it('刷新失败但只是网络问题时保留旧令牌（G11 / L18）', async () => {
    // ⚠️ **一次 200ms 的抖动不该把商家永久踢出登录**。
    const jwt = makeJwtCallback(true, async () => ({
      ok: false,
      reason: 'network',
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(token.accessToken);
    expect(result.refreshToken).toBe('old-refresh');
  });
});

describe('session 回调', () => {
  it('accessToken 缺失时兜底成空串，不把 undefined 传出去', async () => {
    const session = makeSessionCallback();
    const result = await session({
      session: { accessToken: 'x', role: 'MERCHANT_OWNER', tenantId: 't1' },
      token: { role: 'MERCHANT_OWNER', tenantId: 't1' },
    });

    // ⚠️ 原来写的是 `token.accessToken as string` —— 那只是**类型断言**，
    // 运行时 undefined 会原样传出。中转路由拿到空令牌会当游客处理，
    // 用户界面上看不出自己掉登录了。
    expect(result.accessToken).toBe('');
  });

  it('正常情况下把令牌与角色带出去', async () => {
    const session = makeSessionCallback();
    const result = await session({
      session: { accessToken: 'x', role: 'MERCHANT_OWNER', tenantId: 't1' },
      token: {
        accessToken: 'a1',
        role: 'MERCHANT_OWNER',
        tenantId: 't1',
      },
    });

    expect(result.accessToken).toBe('a1');
    expect(result.role).toBe('MERCHANT_OWNER');
    expect(result.tenantId).toBe('t1');
  });

  it('tenantId 为 null 时保持 null（平台超管）', async () => {
    const session = makeSessionCallback();
    const result = await session({
      session: { accessToken: 'x', role: 'PLATFORM_ADMIN', tenantId: null },
      token: { accessToken: 'a1', role: 'PLATFORM_ADMIN', tenantId: null },
    });

    expect(result.tenantId).toBeNull();
  });
});
