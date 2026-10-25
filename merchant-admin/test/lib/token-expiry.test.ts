/**
 * 访问令牌过期判断。
 *
 * 为什么值得单独测：过期判断错一个方向，后果都很具体——
 * - 错判「没过期」→ 用户拿着过期令牌继续用，界面上是一句「Unauthorized」，
 *   购物车页还会显示「购物车是空的」（车其实还在库里）。
 * - 错判「已过期」→ 每次请求都去刷新，而刷新是**轮换**式的：
 *   并发的第二次刷新会被后端当成重放，连带把用户其它设备一起踢掉。
 */
import { describe, expect, it } from 'vitest';

import { isTokenExpired, readJwtExpiry } from '@/lib/token-expiry';

/**
 * 造一枚 JWT。
 *
 * 只用 payload 的 `exp` 做断言，所以签名随便填——
 * 这里测的是**读 exp** 的能力，不是验签。
 */
function makeJwt(exp: number, iat?: number): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'u1', exp, ...(iat === undefined ? {} : { iat }) }),
  ).toString('base64');
  return `header.${payload}.signature`;
}

describe('readJwtExpiry：读 JWT 的 exp', () => {
  it('读出 exp（Unix 秒）', () => {
    expect(readJwtExpiry(makeJwt(1_800_000_000))).toBe(1_800_000_000);
  });

  it('base64url 里的 - 与 _ 也能正确还原', () => {
    // 手工构造一段含 base64url 特殊字符的载荷：
    // 真实 JWT 用的是 base64url（- 替 +，_ 替 /），不是标准 base64。
    // 标准 base64 解码器遇到 - 与 _ 会解不出正确字节。
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u1', exp: 1_800_000_001, tag: 'a?b>c~d' }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(payload).toMatch(/[-_]/);

    expect(readJwtExpiry(`header.${payload}.signature`)).toBe(1_800_000_001);
  });

  it('不是 JWT（段数不对）时返回 null', () => {
    expect(readJwtExpiry('not-a-jwt')).toBeNull();
    expect(readJwtExpiry('a.b')).toBeNull();
  });

  it('空令牌与 undefined 返回 null', () => {
    expect(readJwtExpiry('')).toBeNull();
    expect(readJwtExpiry(undefined)).toBeNull();
    expect(readJwtExpiry(null)).toBeNull();
  });

  it('载荷不是合法 JSON 时返回 null', () => {
    expect(readJwtExpiry('header.bm90LWpzb24.c2ln')).toBeNull();
  });

  it('载荷合法但没有 exp 时返回 null', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64');
    expect(readJwtExpiry(`header.${payload}.sig`)).toBeNull();
  });

  it('exp 不是数字时返回 null', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64');
    expect(readJwtExpiry(`header.${payload}.sig`)).toBeNull();
  });
});

describe('isTokenExpired：判断令牌是否过期', () => {
  const now = 1_800_000_000;

  it('早已过期的令牌是过期的', () => {
    expect(isTokenExpired(makeJwt(now - 3600), now)).toBe(true);
  });

  it('还没到期的令牌不是过期的', () => {
    expect(isTokenExpired(makeJwt(now + 3600), now)).toBe(false);
  });

  it('提前量之内就算过期（避免请求发出去时刚好失效）', () => {
    // 2 小时寿命的令牌（真实配置）：还有 30 秒过期，提前量 60 秒 → 判为过期
    expect(isTokenExpired(makeJwt(now + 30, now - 7200), now, 60)).toBe(true);
    // 还有 300 秒过期 → 不算
    expect(isTokenExpired(makeJwt(now + 300, now - 7200), now, 60)).toBe(false);
  });

  it('短寿命令牌不会被提前量判成「永远已过期」', () => {
    // 15 秒寿命、提前量 60 秒：若提前量不收敛，一枚刚签发的令牌
    // 也会被判成已过期 → 每次读会话都刷新 → 刷新是轮换式的，
    // 并发的第二轮会被后端当重放 → 用户的登录被全部作废。
    const justIssued = makeJwt(now + 15, now);
    expect(isTokenExpired(justIssued, now, 60)).toBe(false);
    // 寿命过半之后才算接近过期（15 秒寿命 → 提前量收敛到 1 秒）
    expect(isTokenExpired(makeJwt(now + 14, now), now, 60)).toBe(false);
  });

  it('短寿命令牌真的过了寿命就判为过期', () => {
    expect(isTokenExpired(makeJwt(now - 1, now - 16), now, 60)).toBe(true);
  });

  it('读不出 exp 时当作「没过期」——不凭空触发刷新', () => {
    // 刷新是轮换式的：无缘无故刷新会把并发请求踩成重放
    expect(isTokenExpired(undefined, now)).toBe(false);
    expect(isTokenExpired('', now)).toBe(false);
    expect(isTokenExpired('not-a-jwt', now)).toBe(false);
  });
});
