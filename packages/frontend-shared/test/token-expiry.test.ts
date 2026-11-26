/**
 * 访问令牌的过期判断。
 *
 * ⚠️ 这一份判断有两个方向都会出事：
 * - 判早了 → 白白轮换掉一枚好令牌（后端是轮换式的，并发刷新会被当成重放，
 *   把用户**所有设备**踢下线）；
 * - 判晚了 → 每个请求都带过期令牌，界面显示已登录、接口全 401。
 *
 * 所以边界（正好等于、提前量、短寿命令牌）逐个钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  isTokenExpired,
  readJwtExpiry,
  readJwtIssuedAt,
} from '../src/token-expiry';

/** 造一枚只有载荷有意义的 JWT（验签是后端的事，这里只读 exp / iat）。 */
function makeJwt(payload: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const NOW = 1_700_000_000;
/** 两小时寿命的典型访问令牌。 */
function tokenAt(exp: number, iat = exp - 7200): string {
  return makeJwt({ sub: 'user-1', iat, exp });
}

describe('readJwtExpiry', () => {
  it('取出载荷里的 exp', () => {
    expect(readJwtExpiry(makeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000);
  });

  it('base64url 的 - 与 _ 都能正确解码', () => {
    // 这两个载荷的 base64url 里分别含 `-` 和 `_`（标准 base64 的 `+` / `/`）。
    const withDash = 'eyJleHAiOjE3MDAwMDAwMDAsIm4iOiI-ICJ9';
    const withUnderscore = 'eyJleHAiOjE3MDAwMDAwMDAsIm4iOiI_P34ifQ';
    expect(readJwtExpiry(`header.${withDash}.signature`)).toBe(1_700_000_000);
    expect(readJwtExpiry(`header.${withUnderscore}.signature`)).toBe(
      1_700_000_000,
    );
  });

  it('空值 / 段数不对 → null', () => {
    expect(readJwtExpiry(undefined)).toBeNull();
    expect(readJwtExpiry(null)).toBeNull();
    expect(readJwtExpiry('')).toBeNull();
    expect(readJwtExpiry('onlyonepart')).toBeNull();
    expect(readJwtExpiry('a.b')).toBeNull();
    expect(readJwtExpiry('a.b.c.d')).toBeNull();
  });

  it('载荷不是 JSON / 不是对象 / 没有 exp → null', () => {
    const notJson = Buffer.from('not json').toString('base64url');
    expect(readJwtExpiry(`h.${notJson}.s`)).toBeNull();
    expect(readJwtExpiry(makeJwt(123))).toBeNull();
    expect(readJwtExpiry(makeJwt(null))).toBeNull();
    expect(readJwtExpiry(makeJwt({ sub: 'user-1' }))).toBeNull();
  });

  it('exp 不是数字 → null（字符串形式的 exp 也不认）', () => {
    expect(readJwtExpiry(makeJwt({ exp: '1700000000' }))).toBeNull();
    expect(readJwtExpiry(makeJwt({ exp: null }))).toBeNull();
  });
});

describe('readJwtIssuedAt', () => {
  it('取出载荷里的 iat', () => {
    expect(readJwtIssuedAt(makeJwt({ iat: 1_699_999_000 }))).toBe(1_699_999_000);
  });

  it('缺字段 / 非数字 / 令牌读不出来 → null', () => {
    expect(readJwtIssuedAt(makeJwt({ exp: NOW }))).toBeNull();
    expect(readJwtIssuedAt(makeJwt({ iat: '1699999000' }))).toBeNull();
    expect(readJwtIssuedAt('a.b.c')).toBeNull();
    expect(readJwtIssuedAt(undefined)).toBeNull();
  });
});

describe('isTokenExpired', () => {
  it('已过期', () => {
    expect(isTokenExpired(tokenAt(NOW - 1), NOW)).toBe(true);
    expect(isTokenExpired(tokenAt(NOW - 3600), NOW)).toBe(true);
  });

  it('远未过期（提前量之外）', () => {
    expect(isTokenExpired(tokenAt(NOW + 300), NOW)).toBe(false);
    expect(isTokenExpired(tokenAt(NOW + 7200), NOW)).toBe(false);
  });

  it('剩余时间小于提前量 → 提前判过期（避免请求回来时刚好失效）', () => {
    // 寿命 2 小时 → 提前量 = min(60, 720) = 60 秒
    expect(isTokenExpired(tokenAt(NOW + 59), NOW)).toBe(true);
    expect(isTokenExpired(tokenAt(NOW + 60), NOW)).toBe(true);
    expect(isTokenExpired(tokenAt(NOW + 61), NOW)).toBe(false);
  });

  it('⚠️ 边界：exp - 提前量 正好等于 now → 算已过期', () => {
    // 实现是 `exp - leeway <= now`，等号落在「过期」一侧。
    expect(isTokenExpired(tokenAt(NOW + 60), NOW)).toBe(true);
  });

  it('⚠️ 短寿命令牌：提前量收敛到寿命的 1/10，不会永远判过期', () => {
    // 寿命 15 秒 → 提前量 = floor(15/10) = 1 秒，而不是 60 秒
    const justIssued = tokenAt(NOW + 15, NOW);
    expect(isTokenExpired(justIssued, NOW)).toBe(false);
    // 同一枚令牌 14 秒后（只剩 1 秒）就该刷了
    expect(isTokenExpired(justIssued, NOW + 14)).toBe(true);
  });

  it('读不出 iat 时退回「提前量 = 传入值」', () => {
    const noIat = makeJwt({ exp: NOW + 59 });
    expect(isTokenExpired(noIat, NOW)).toBe(true);
    expect(isTokenExpired(makeJwt({ exp: NOW + 61 }), NOW)).toBe(false);
  });

  it('自定义提前量', () => {
    expect(isTokenExpired(tokenAt(NOW), NOW, 0)).toBe(true);
    expect(isTokenExpired(tokenAt(NOW + 1), NOW, 0)).toBe(false);
    expect(isTokenExpired(tokenAt(NOW + 10), NOW, 10)).toBe(true);
  });

  it('⚠️ 时钟偏移：客户端比服务端快 30 秒时，令牌被提前当作过期（早刷比晚刷安全）', () => {
    const exp = NOW + 3600;
    expect(isTokenExpired(tokenAt(exp), NOW + 30)).toBe(false);
    // 客户端时钟再快一些，进入提前量窗口 → 提前刷新
    expect(isTokenExpired(tokenAt(exp), exp - 30)).toBe(true);
  });

  it('令牌读不出来 → false（不凭空触发刷新）', () => {
    expect(isTokenExpired(undefined, NOW)).toBe(false);
    expect(isTokenExpired(null, NOW)).toBe(false);
    expect(isTokenExpired('garbage', NOW)).toBe(false);
    expect(isTokenExpired('a.b.c', NOW)).toBe(false);
  });
});
