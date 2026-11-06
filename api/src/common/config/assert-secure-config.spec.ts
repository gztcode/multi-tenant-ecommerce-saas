import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSecureConfig } from './assert-secure-config';
import { isDevOnlyChannel } from '../channel/channel-config';

/**
 * ⚠️ **生产基线需要一条「生产可用」的渠道，但今天还没有**：
 *    `fake` / `sandbox` / `fake-payout` **全部**在 `DEV_ONLY_CHANNELS` 里
 *    （单一事实来源：`common/channel/channel-config.ts`），
 *    也就是**现在还没有任何渠道能在生产启用**。
 *
 *    所以这里把 `isDevOnlyChannel` 打成桩：默认「谁都不算 devOnly」，
 *    相当于「接入真实渠道之后的形态」；要验 devOnly 守卫的用例再显式点名。
 *    不打这个桩的话，「生产环境配了合法渠道 → 启动通过」这条根本没法测：
 *    每条生产用例都会先撞上 devOnly 那条断言。
 */
jest.mock('../channel/channel-config', () => ({
  __esModule: true,
  ...jest.requireActual<typeof import('../channel/channel-config')>(
    '../channel/channel-config',
  ),
  isDevOnlyChannel: jest.fn(() => false),
}));

/** 把点名的那些渠道桩成「仅限非生产环境使用」；其余渠道在生产可用 */
function stubDevOnlyChannels(...channels: string[]): void {
  jest
    .mocked(isDevOnlyChannel)
    .mockImplementation((_kind, channel) => channels.includes(channel));
}

/** compose 文件路径（与 `placeholder-secrets.spec.ts` 同一份） */
const COMPOSE_PATH = join(__dirname, '../../../../infra/docker-compose.yml');

/**
 * 从 compose 里取某个变量的默认值。
 *
 * ⚠️ **这里不写死 compose 的默认 Redis 密码**：写死的话，
 *    将来谁改了 compose 默认值而守卫没跟上，这个用例还会继续绿
 *    （测的还是旧值）—— 现取才能在漂移时立刻红。
 */
function composeDefault(key: string): string {
  const content = readFileSync(COMPOSE_PATH, 'utf8');
  const line = content.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  if (!line) throw new Error(`compose 里找不到 ${key}`);

  const raw = line[1].trim();
  // 兼容 `${VAR:-默认值}`；占位符替换工具偶尔会把 `:-` 显示成 `:`，
  // 这里一并接受（提取出来的仍必须是真实默认值）。
  const withDefault = raw.match(/^\$\{[^:}]+:-?([^}]+)\}$/);
  if (withDefault) return withDefault[1];
  if (raw.startsWith('${')) {
    throw new Error(`${key} 没有默认值，守卫覆盖不到`);
  }
  return raw;
}

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
    // ⚠️ **生产基线必须配渠道**（审计 P2-A1）：一个渠道都不配时启动校验放行，
    //    故障会被推迟到第一笔交易才暴露。基线里配一个**已部署实现**的渠道，
    //    「不配渠道」由下面的专用用例单独验。
    //    （`sandbox` 是真实渠道实现；它当前仅限非生产 —— 由上面的桩放开。）
    process.env.PAYMENT_ENABLED_CHANNELS = 'sandbox';
    process.env.PAYOUT_ENABLED_CHANNELS = 'sandbox';
    // 默认「没有渠道是 devOnly」= 假设真实渠道已接入（见文件头说明）。
    stubDevOnlyChannels();
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
    stubDevOnlyChannels('fake');

    expect(() => assertSecureConfig()).toThrow(
      /PAYMENT_ENABLED_CHANNELS.*fake/,
    );
  });

  it('生产环境 + PAYOUT_ENABLED_CHANNELS=sandbox → 抛错并点名变量与渠道', () => {
    // ⚠️ 支付渠道要留在「生产可用」的那一边，否则会先撞上支付那条断言。
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
    process.env.PAYOUT_ENABLED_CHANNELS = 'sandbox';
    stubDevOnlyChannels('sandbox');

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

  it('生产环境一个渠道都不配 → 拒绝启动（审计 P2-A1）', () => {
    delete process.env.PAYMENT_ENABLED_CHANNELS;
    delete process.env.PAYOUT_ENABLED_CHANNELS;

    expect(() => assertSecureConfig()).toThrow(/PAYMENT_ENABLED_CHANNELS/);
  });

  it('生产环境只配支付渠道、没配出款渠道 → 拒绝启动（审计 P2-A1）', () => {
    delete process.env.PAYOUT_ENABLED_CHANNELS;

    expect(() => assertSecureConfig()).toThrow(/PAYOUT_ENABLED_CHANNELS/);
  });

  it('生产环境 + REDIS_URL 用 compose 默认密码 → 拒绝启动（审计 P0-5）', () => {
    process.env.REDIS_URL = `redis://:${composeDefault(
      'REDIS_PASSWORD',
    )}@redis:6379`;

    expect(() => assertSecureConfig()).toThrow(/Redis/);
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
