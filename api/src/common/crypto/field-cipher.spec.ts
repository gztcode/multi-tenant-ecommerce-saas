import { deriveGraceKey } from '../../modules/auth/token.util';
import { decryptField, deriveFieldKey, encryptField } from './field-cipher';

describe('字段加密工具', () => {
  const secret = 'a'.repeat(48);

  it('加密后能解回原文', () => {
    const key = deriveFieldKey(secret);
    const cipher = encryptField('6225880000001234', key);
    expect(decryptField(cipher, key)).toBe('6225880000001234');
  });

  it('⚠️ 同一明文两次加密的密文不同（随机 iv）', () => {
    const key = deriveFieldKey(secret);
    expect(encryptField('x', key)).not.toBe(encryptField('x', key));
  });

  it('⚠️ 密文被篡改 → 解密抛错（绝不返回 null）', () => {
    const key = deriveFieldKey(secret);
    const cipher = encryptField('hello', key);
    const raw = Buffer.from(cipher, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptField(raw.toString('base64url'), key)).toThrow();
  });

  it('⚠️ 密钥不对 → 解密抛错', () => {
    const cipher = encryptField('hello', deriveFieldKey(secret));
    expect(() =>
      decryptField(cipher, deriveFieldKey('b'.repeat(48))),
    ).toThrow();
  });

  it('⚠️ 密文长度不足 → 抛错', () => {
    expect(() => decryptField('AAAA', deriveFieldKey(secret))).toThrow();
  });

  it('⚠️ 不同 secret 派生出的密钥不同（密钥隔离）', () => {
    const key = deriveFieldKey(secret);
    const cipher = encryptField('hello', key);
    // 用别的 secret 派生 → 必须解不开
    expect(() =>
      decryptField(cipher, deriveFieldKey('c'.repeat(48))),
    ).toThrow();
  });

  /**
   * ⚠️ **info 隔离 —— 这条用例测的是「用途隔离」，不是「密钥不同」**。
   *
   * HKDF 的 info 参与密钥派生：同样的 secret + 同样的 salt，
   * 换一个 info 就换一把完全不同的密钥。所以「info 不同 ⇒ 解不开」
   * 只有在**比较对象是另一个用途派生出来的密钥**时才成立。
   *
   * ⚠️ **为什么拿 `deriveGraceKey` 作对照**：
   * `token.util.ts` 的宽限记录与这里的账目字段都用同一把源密钥
   * （`JWT_SECRET` / 账目密钥）、同一个 salt 派生，**唯一的隔离手段就是 info**。
   * 两处 info 一旦写成一样，两边的密钥就变成同一把，
   * 宽限记录的密文能冒充账目密文（反之亦然）—— 这正是
   * `field-cipher.ts` 里那条注释警告的事。
   *
   * ⚠️ **对照物取自生产代码而非在测试里重写一遍 HKDF**：
   * 重写就得把 salt 和 info 都抄一份进测试，两边一漂移这条用例就失效了；
   * 直接用 `deriveGraceKey` 比，才能真的守住「两处 info 不相同」这条约束。
   */
  it('⚠️ 账目密钥与宽限密钥互相解不开（info 隔离，跨用途防冒充）', () => {
    const fieldKey = deriveFieldKey(secret);
    const graceKey = deriveGraceKey(secret);

    // 同一个 secret、同一个 salt，只靠 info 区分用途 → 密钥必须不同
    expect(fieldKey.equals(graceKey)).toBe(false);

    // 密文也不能互相解开
    const fieldCipher = encryptField('hello', fieldKey);
    expect(() => decryptField(fieldCipher, graceKey)).toThrow();
  });
});
