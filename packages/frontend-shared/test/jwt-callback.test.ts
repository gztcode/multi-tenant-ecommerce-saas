/**
 * NextAuth 的 `jwt` / `session` 回调。
 *
 * ⚠️ 这里决定的是「会话什么时候还算活着」：
 * - 过早刷新会**轮换**掉一枚好令牌，并发时后端判重放，全设备掉线；
 * - `canDeliverCookie` 为 false 时刷新（Server Component 里的 `auth()`）
 *   等于把旧令牌作废、新令牌却送不回浏览器 → 下次读会话又拿旧令牌 → 重放；
 * - 网络失败就清空令牌 → 一次抖动把商家**永久**踢出登录。
 */
import { describe, expect, it, vi } from 'vitest';

import { makeJwtCallback, makeSessionCallback, type JwtToken } from '../src/jwt-callback';
import type { RefreshResult } from '../src/token-refresh';

function makeJwt(payload: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const EXPIRED_TOKEN = makeJwt({ exp: NOW_SECONDS - 60, iat: NOW_SECONDS - 7_260 });
const FRESH_TOKEN = makeJwt({ exp: NOW_SECONDS + 3_600, iat: NOW_SECONDS });

const AUTH_USER = {
  id: 'user-1',
  email: 'merchant@example.com',
  name: '商家',
  role: 'MERCHANT_OWNER',
  tenantId: 'tenant-1',
  accessToken: FRESH_TOKEN,
  refreshToken: '{{SECRET_4eqqd3hx}}',
};

const REFRESH_OK: RefreshResult = {
  ok: true,
  tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' },
};

describe('jwt 回调：登录', () => {
  it('有 user 时把令牌与身份写进 token', async () => {
    const jwt = makeJwtCallback(false);
    const token: JwtToken = {};

    const result = await jwt({ token, user: AUTH_USER });

    expect(result).toEqual({
      accessToken: FRESH_TOKEN,
      refreshToken: '{{SECRET_4eqqd3hx}}',
      role: 'MERCHANT_OWNER',
      tenantId: 'tenant-1',
    });
  });

  it('登录时不看令牌是否过期（刚发下来的就是好的）', async () => {
    const refresh = vi.fn(async () => REFRESH_OK);
    const jwt = makeJwtCallback(true, refresh);

    await jwt({ token: {}, user: { ...AUTH_USER, accessToken: EXPIRED_TOKEN } });

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('jwt 回调：续期', () => {
  it('缺 accessToken 或 refreshToken → 原样返回，不刷新', async () => {
    const refresh = vi.fn(async () => REFRESH_OK);
    const jwt = makeJwtCallback(true, refresh);

    await expect(jwt({ token: {} })).resolves.toEqual({});
    await expect(jwt({ token: { accessToken: EXPIRED_TOKEN } })).resolves.toEqual({
      accessToken: EXPIRED_TOKEN,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('令牌还没过期 → 原样返回，不刷新', async () => {
    const refresh = vi.fn(async () => REFRESH_OK);
    const jwt = makeJwtCallback(true, refresh);
    const token: JwtToken = { accessToken: FRESH_TOKEN, refreshToken: 'old-refresh' };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(FRESH_TOKEN);
    expect(result.refreshToken).toBe('old-refresh');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('⚠️ 过期但送不回 cookie（Server Component）→ 不刷新', async () => {
    // 刷新会轮换掉旧令牌，而新令牌送不回浏览器 → 下次读会话又拿旧令牌 →
    // 后端判重放 → 吊销该用户所有设备
    const refresh = vi.fn(async () => REFRESH_OK);
    const jwt = makeJwtCallback(false, refresh);
    const token: JwtToken = { accessToken: EXPIRED_TOKEN, refreshToken: 'old-refresh' };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(EXPIRED_TOKEN);
    expect(result.refreshToken).toBe('old-refresh');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('过期且能送 cookie → 刷新并写入新令牌', async () => {
    const refresh = vi.fn(async () => REFRESH_OK);
    const jwt = makeJwtCallback(true, refresh);
    const token: JwtToken = { accessToken: EXPIRED_TOKEN, refreshToken: 'old-refresh' };

    const result = await jwt({ token });

    expect(refresh).toHaveBeenCalledWith('old-refresh');
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
  });

  it('⚠️ 刷新失败但属于网络问题 → 保留旧令牌（一次抖动不能把人踢下线）', async () => {
    const refresh = vi.fn(async (): Promise<RefreshResult | null> => ({
      ok: false,
      reason: 'network',
    }));
    const jwt = makeJwtCallback(true, refresh);
    const token: JwtToken = {
      accessToken: EXPIRED_TOKEN,
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 'tenant-1',
    };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(EXPIRED_TOKEN);
    expect(result.refreshToken).toBe('old-refresh');
    expect(result.role).toBe('MERCHANT_OWNER');
  });

  it('刷新返回 null（没拿到结果）→ 同样保留旧令牌', async () => {
    const jwt = makeJwtCallback(true, async () => null);
    const token: JwtToken = { accessToken: EXPIRED_TOKEN, refreshToken: 'old-refresh' };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(EXPIRED_TOKEN);
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('⚠️ 凭证失效（401/403）→ 清空令牌，让界面回到「请重新登录」', async () => {
    const jwt = makeJwtCallback(true, async () => ({ ok: false, reason: 'invalid' }));
    const token: JwtToken = {
      accessToken: EXPIRED_TOKEN,
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 'tenant-1',
    };

    const result = await jwt({ token });

    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    // 身份字段保留，会话本身还在（只是没有令牌了）
    expect(result.role).toBe('MERCHANT_OWNER');
    expect(result.tenantId).toBe('tenant-1');
  });
});

describe('session 回调', () => {
  it('透出 accessToken / role / tenantId', async () => {
    const session = makeSessionCallback();

    const result = await session({
      session: { accessToken: '', role: '', tenantId: null },
      token: { accessToken: 'access-1', role: 'MERCHANT_OWNER', tenantId: 'tenant-1' },
    });

    expect(result).toEqual({
      accessToken: 'access-1',
      role: 'MERCHANT_OWNER',
      tenantId: 'tenant-1',
    });
  });

  it('⚠️ 令牌被清空后兜底成空串（不能把 undefined 当字符串传出去）', async () => {
    const session = makeSessionCallback();

    const result = await session({
      session: { accessToken: 'access-1', role: 'MERCHANT_OWNER', tenantId: 'tenant-1' },
      token: { role: 'MERCHANT_OWNER', tenantId: 'tenant-1' },
    });

    expect(result.accessToken).toBe('');
  });

  it('tenantId 缺失 → null（平台/超管没有租户）', async () => {
    const session = makeSessionCallback();

    const result = await session({
      session: { accessToken: '', role: '', tenantId: null },
      token: { accessToken: 'a', role: 'PLATFORM_ADMIN' },
    });

    expect(result.tenantId).toBeNull();
  });
});
