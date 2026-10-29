import { assertSecureConfig } from './assert-secure-config';

/**
 * 启动时的配置安全断言（护栏 X11）。
 *
 * ⚠️ **`process.env` 要在每个用例前后恢复** ——
 *    断言直接读 env，不恢复会污染同文件的后续用例。
 *
 * ⚠️ **每条用例都要先把 `JWT_SECRET` 换成非占位符的值**：
 *    否则会先撞上「JWT_SECRET 是占位符」那条断言，测不到本条。
 */
describe('assertSecureConfig', () => {
  const KEYS = [
    'NODE_ENV',
    'JWT_SECRET',
    'FAKE_PAYMENT_ENABLED',
    'FAKE_PAYOUT_ENABLED',
  ] as const;

  /** 一份够长、且不是占位符的密钥 */
  const REAL_SECRET = 'a-real-secret-for-this-assertion-only-32ch';

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('生产环境启用 FAKE_PAYOUT_ENABLED → 拒绝启动（护栏 X11）', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = REAL_SECRET;
    process.env.FAKE_PAYOUT_ENABLED = 'true';

    expect(() => assertSecureConfig()).toThrow(/FAKE_PAYOUT_ENABLED/);
  });

  it('生产环境未启用 FAKE_PAYOUT_ENABLED → 不因这一条抛错', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = REAL_SECRET;
    delete process.env.FAKE_PAYOUT_ENABLED;

    expect(() => assertSecureConfig()).not.toThrow();
  });

  it('非生产环境启用 FAKE_PAYOUT_ENABLED → 允许（本地开发要用）', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = REAL_SECRET;
    process.env.FAKE_PAYOUT_ENABLED = 'true';

    expect(() => assertSecureConfig()).not.toThrow();
  });
});
