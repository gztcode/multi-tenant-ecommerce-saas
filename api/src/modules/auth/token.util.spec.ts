import {
  decryptToken,
  deriveGraceKey,
  encryptToken,
  REFRESH_GRACE_PERIOD_MS,
} from './token.util';

/**
 * 宽限记录里那枚新令牌的加解密（阶段 5c）。
 *
 * ⚠️ **这里测的是「密文在库里不泄露明文」这件事** ——
 * `token.util.ts` 里既有的原则是「数据库里只存 sha256 摘要而不是明文……
 * RefreshToken 表经常被备份与只读分析」。宽限期要返回**同一枚**令牌，
 * 就必须能把明文还原出来——本阶段用密文而不是明文来满足这个要求。
 */
describe('宽限记录的加解密', () => {
  const secret = 'a-test-secret-that-is-long-enough-for-hkdf';
  const key = deriveGraceKey(secret);

  it('加解密往返得到同一个明文', () => {
    const plain = 'the-refresh-token-value';
    expect(decryptToken(encryptToken(plain, key), key)).toBe(plain);
  });

  it('密文里不出现明文', () => {
    const plain = 'the-refresh-token-value';
    const cipher = encryptToken(plain, key);
    expect(cipher).not.toContain(plain);
    expect(Buffer.from(cipher, 'base64url').toString('utf8')).not.toContain(
      plain,
    );
  });

  it('每次加密的密文不同（随机 iv）', () => {
    const plain = 'same-plain';
    expect(encryptToken(plain, key)).not.toBe(encryptToken(plain, key));
  });

  it('用另一个密钥解密失败', () => {
    const cipher = encryptToken('x', key);
    const other = deriveGraceKey('another-secret-long-enough-for-hkdf');
    expect(decryptToken(cipher, other)).toBeNull();
  });

  it('密文被篡改时解密失败（认证标签）', () => {
    const cipher = encryptToken('x', key);
    const raw = Buffer.from(cipher, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    expect(decryptToken(raw.toString('base64url'), key)).toBeNull();
  });

  it('密文格式损坏时返回 null 而不是抛错', () => {
    expect(decryptToken('not-a-valid-cipher', key)).toBeNull();
    expect(decryptToken('', key)).toBeNull();
  });

  it('密文被截断时返回 null（长度守卫）', () => {
    // ⚠️ 与「被篡改」是两条不同的路径：篡改靠 GCM 的认证标签检出，
    // 截断靠解密前的长度守卫拦下。库里存的值被截断是真实可能
    // （备份恢复、字段截断），所以这条路径要有覆盖。
    const cipher = encryptToken('x', key);
    const raw = Buffer.from(cipher, 'base64url');
    expect(decryptToken(raw.subarray(0, 20).toString('base64url'), key)).toBe(
      null,
    );
  });

  it('派生出的密钥是 32 字节，且不同密钥派生结果不同', () => {
    expect(key).toHaveLength(32);
    expect(deriveGraceKey(secret).equals(key)).toBe(true);
    expect(
      deriveGraceKey('another-secret-long-enough-for-hkdf').equals(key),
    ).toBe(false);
  });

  it('宽限期是 60 秒', () => {
    expect(REFRESH_GRACE_PERIOD_MS).toBe(60_000);
  });
});
