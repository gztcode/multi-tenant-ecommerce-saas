import { assertSecureConfig } from './assert-secure-config';

/**
 * 启动时的配置安全断言（护栏 X11 + 阶段 6a 渠道配置校验）。
 *
 * ⚠️ **`process.env` 要在每个用例前后恢复** ——
 *    断言直接读 env，不恢复会污染同文件的后续用例。
 *
 * ⚠️ **每条用例都要先把 `JWT_SECRET` 换成非占位符的值**：
 *    否则会先撞上「JWT_SECRET 是占位符」那条断言，测不到本条。
 *
 * ⚠️ **恢复环境变量用 `delete` 而不是赋 `undefined`** ——
 *    `process.env.X = undefined` 会把变量设成**字符串 `"undefined"`**，
 *    同进程后续代码读到的是「一个叫 undefined 的值」而不是「缺失」。
 */
describe('assertSecureConfig', () => {
  const KEYS = [
    'NODE_ENV',
    'JWT_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
    'MINIO_ROOT_PASSWORD',
    'MINIO_SECRET_KEY',
    'FAKE_PAYMENT_ENABLED',
    'FAKE_PAYOUT_ENABLED',
    'CHANNEL_MODE',
    'PAYMENT_ENABLED_CHANNELS',
    'PAYOUT_ENABLED_CHANNELS',
    'PAYOUT_PLATFORM_DEFAULT_CHANNEL',
  ] as const;

  /** 一份够长、且不是占位符的密钥 */
  const REAL_SECRET = 'a-real-secret-for-this-assertion-only-32ch';

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

    // 基线：先把所有渠道相关变量清空，每个用例只设置自己关心的那几个。
    for (const key of KEYS) {
      delete process.env[key];
    }
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = REAL_SECRET;
    // 生产基线的合法凭据：每个用例只覆盖自己关心的那一项。
    process.env.DATABASE_URL =
      'postgresql://ecommerce:real-db-password@postgres:5432/ecommerce?schema=public';
    process.env.REDIS_URL = 'redis://:real-redis-password@redis:6379';
    process.env.MINIO_ROOT_PASSWORD = 'real-minio-password';
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
    process.env.FAKE_PAYOUT_ENABLED = 'true';

    expect(() => assertSecureConfig()).toThrow(/FAKE_PAYOUT_ENABLED/);
  });

  it('生产环境未启用 FAKE_PAYOUT_ENABLED → 不因这一条抛错', () => {
    expect(() => assertSecureConfig()).not.toThrow();
  });

  it('非生产环境启用 FAKE_PAYOUT_ENABLED → 允许（本地开发要用）', () => {
    process.env.NODE_ENV = 'development';
    process.env.FAKE_PAYOUT_ENABLED = 'true';

    expect(() => assertSecureConfig()).not.toThrow();
  });

  it('生产环境 + CHANNEL_MODE=sandbox → 抛错并点名 CHANNEL_MODE', () => {
    process.env.CHANNEL_MODE = 'sandbox';

    expect(() => assertSecureConfig()).toThrow(/CHANNEL_MODE/);
  });

  it('生产环境 + PAYMENT_ENABLED_CHANNELS=fake → 抛错并点名变量与渠道', () => {
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout';

    expect(() => assertSecureConfig()).toThrow(
      /PAYMENT_ENABLED_CHANNELS.*fake/,
    );
  });

  it('生产环境 + PAYOUT_ENABLED_CHANNELS=sandbox → 抛错并点名变量与渠道', () => {
    process.env.PAYOUT_ENABLED_CHANNELS = 'sandbox';

    expect(() => assertSecureConfig()).toThrow(
      /PAYOUT_ENABLED_CHANNELS.*sandbox/,
    );
  });

  it('PAYOUT_PLATFORM_DEFAULT_CHANNEL=not-registered → 抛错', () => {
    process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = 'not-registered';

    expect(() => assertSecureConfig()).toThrow(
      /PAYOUT_PLATFORM_DEFAULT_CHANNEL.*not-registered/,
    );
  });

  it('非生产环境不设任何渠道变量 → 默认 fake / fake-payout，正常返回', () => {
    process.env.NODE_ENV = 'development';

    expect(() => assertSecureConfig()).not.toThrow();
  });

  it('CHANNEL_MODE 取未知值 → 抛错并列出允许值', () => {
    process.env.CHANNEL_MODE = 'sandBox';

    expect(() => assertSecureConfig()).toThrow(/CHANNEL_MODE.*sandbox/);
  });

  it('生产环境 + DATABASE_URL 使用默认密码 → 拒绝启动', () => {
    process.env.DATABASE_URL =
      'postgresql://ecommerce:ecommerce@postgres:5432/ecommerce?schema=public';

    expect(() => assertSecureConfig()).toThrow(/数据库密码/);
  });

  it('生产环境 + DATABASE_URL 没有密码 → 拒绝启动', () => {
    process.env.DATABASE_URL =
      'postgresql://ecommerce@postgres:5432/ecommerce?schema=public';

    expect(() => assertSecureConfig()).toThrow(/数据库密码/);
  });

  it('生产环境 + REDIS_URL 没有密码 → 拒绝启动', () => {
    process.env.REDIS_URL = 'redis://redis:6379';

    expect(() => assertSecureConfig()).toThrow(/Redis/);
  });

  it('生产环境 + MinIO 使用默认密码 → 拒绝启动', () => {
    process.env.MINIO_ROOT_PASSWORD = 'ecommerce-minio-secret';

    expect(() => assertSecureConfig()).toThrow(/MinIO/);
  });

  it('生产环境 + MinIO 密码为空 → 拒绝启动', () => {
    delete process.env.MINIO_ROOT_PASSWORD;
    delete process.env.MINIO_SECRET_KEY;

    expect(() => assertSecureConfig()).toThrow(/MinIO/);
  });

  it('非生产环境使用全部默认凭据 → 放行（本地开发）', () => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL =
      'postgresql://ecommerce:ecommerce@postgres:5432/ecommerce?schema=public';
    process.env.REDIS_URL = 'redis://redis:6379';
    process.env.MINIO_ROOT_PASSWORD = 'ecommerce-minio-secret';

    expect(() => assertSecureConfig()).not.toThrow();
  });
});
