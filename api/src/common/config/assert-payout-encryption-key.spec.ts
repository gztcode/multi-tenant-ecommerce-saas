import { assertPayoutEncryptionKey } from './assert-payout-encryption-key';

describe('账目加密密钥的启动校验', () => {
  const original = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    // ⚠️ **原来这里是直接赋值** —— `original` 是 `undefined` 时，
    //    `process.env.X = undefined` 会把环境变量设成**字符串 `"undefined"`**
    //    （不是删除它）→ 同进程后续的代码读到的是 `"undefined"` 而不是「缺失」，
    //    `?? ''` 兜不住它 → 隐性污染别的测试。
    //    所以「原来没有」就 `delete`。
    if (original === undefined) {
      delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    } else {
      process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = original;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('⚠️ 缺失 → 抛错', () => {
    delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    expect(() => assertPayoutEncryptionKey()).toThrow(
      /PAYOUT_ACCOUNT_ENCRYPTION_KEY/,
    );
  });

  it('⚠️ 长度不足 32 → 抛错（任何环境）', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = 'short';
    process.env.NODE_ENV = 'development';
    expect(() => assertPayoutEncryptionKey()).toThrow(/32/);
  });

  it('⚠️ 生产环境用占位符 → 抛错', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY =
      'change-me-in-production-payout-key-at-least-32-chars-long';
    process.env.NODE_ENV = 'production';
    expect(() => assertPayoutEncryptionKey()).toThrow(/占位符/);
  });

  it('⚠️ 开发环境用占位符 → 放行（与 JWT_SECRET 同款）', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY =
      'change-me-in-production-payout-key-at-least-32-chars-long';
    process.env.NODE_ENV = 'development';
    expect(() => assertPayoutEncryptionKey()).not.toThrow();
  });

  it('长度够且不是占位符 → 放行', () => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = 'k'.repeat(48);
    expect(() => assertPayoutEncryptionKey()).not.toThrow();
  });
});
