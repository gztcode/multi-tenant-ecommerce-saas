import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWN_PLACEHOLDER_SECRETS,
  isPlaceholderSecret,
} from './placeholder-secrets';
import { assertSecureConfig } from './assert-secure-config';
import { assertPayoutEncryptionKey } from './assert-payout-encryption-key';

/**
 * 守卫必须拦住 **compose 内置的默认密钥**，而不只是 .env.example 的占位符。
 *
 * 根因：原来的守卫做字面等值比较，比较目标与 compose 默认值不是同一个串，
 * 于是「提交进 git 的固定密钥 + NODE_ENV=production」能正常启动。
 *
 * ⚠️ 这个测试直接解析 `infra/docker-compose.yml`：
 *    将来谁改了 compose 默认值却忘了登记到集合，这里立刻红。
 */
const COMPOSE_PATH = join(__dirname, '../../../../infra/docker-compose.yml');
const ENV_EXAMPLE_PATH = join(__dirname, '../../../.env.example');
/** compose 用的那份 env 模板（CORS 变量给 MinIO 容器用） */
const INFRA_ENV_EXAMPLE_PATH = join(
  __dirname,
  '../../../../infra/.env.example',
);

function composeValue(key: string): string {
  const content = readFileSync(COMPOSE_PATH, 'utf8');
  const line = content.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  if (!line) throw new Error(`compose 里找不到 ${key}`);

  const raw = line[1].trim();
  // 兼容 `${VAR:-默认值}`；占位符替换工具偶尔会把 `:-` 显示成 `:`，
  // 这里一并接受（提取出来的仍必须是真实默认值）。
  const withDefault = raw.match(/^\$\{[^:}]+:-?([^}]+)\}$/);
  if (withDefault) return withDefault[1];
  if (raw.startsWith('${')) {
    throw new Error(`${key} 没有默认值，守卫集合无法覆盖`);
  }
  return raw;
}

/** 读 `.env.example` 里某个键的值（去掉两侧引号） */
function envExampleValue(key: string): string {
  const content = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const line = content.match(new RegExp(`^\\s*${key}=(.*)$`, 'm'));
  if (!line) throw new Error(`.env.example 里找不到 ${key}`);

  const raw = line[1].trim();
  const unquoted = raw.replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!unquoted) throw new Error(`${key} 在 .env.example 里是空值`);
  return unquoted;
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('已知占位符密钥集合', () => {
  it('集合覆盖四个来源（.env.example 两个 + compose 两个）', () => {
    expect(KNOWN_PLACEHOLDER_SECRETS.size).toBeGreaterThanOrEqual(4);
  });

  it('.env.example 的 JWT_SECRET 占位符在拒绝集合内', () => {
    expect(isPlaceholderSecret(envExampleValue('JWT_SECRET'))).toBe(true);
  });

  it('.env.example 的 PAYOUT_ACCOUNT_ENCRYPTION_KEY 占位符在拒绝集合内', () => {
    expect(
      isPlaceholderSecret(envExampleValue('PAYOUT_ACCOUNT_ENCRYPTION_KEY')),
    ).toBe(true);
  });

  it('compose 的 JWT_SECRET 默认值在拒绝集合内', () => {
    expect(isPlaceholderSecret(composeValue('JWT_SECRET'))).toBe(true);
  });

  it('compose 的 PAYOUT_ACCOUNT_ENCRYPTION_KEY 默认值在拒绝集合内', () => {
    expect(
      isPlaceholderSecret(composeValue('PAYOUT_ACCOUNT_ENCRYPTION_KEY')),
    ).toBe(true);
  });

  it('真实随机值不在集合内', () => {
    expect(isPlaceholderSecret('a'.repeat(64))).toBe(false);
  });

  it('生产 + compose 默认 JWT_SECRET → assertSecureConfig 拒绝启动', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        JWT_SECRET: composeValue('JWT_SECRET'),
      },
      () => {
        expect(() => assertSecureConfig()).toThrow(/占位符/);
      },
    );
  });

  it('生产 + compose 默认账目密钥 → assertPayoutEncryptionKey 拒绝启动', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        PAYOUT_ACCOUNT_ENCRYPTION_KEY: composeValue(
          'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
        ),
      },
      () => {
        expect(() => assertPayoutEncryptionKey()).toThrow(/占位符/);
      },
    );
  });

  it('开发环境用 compose 默认值不拦截（本机 compose 要能起）', () => {
    withEnv(
      {
        NODE_ENV: 'development',
        JWT_SECRET: composeValue('JWT_SECRET'),
        PAYOUT_ACCOUNT_ENCRYPTION_KEY: composeValue(
          'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
        ),
      },
      () => {
        expect(() => assertSecureConfig()).not.toThrow();
        expect(() => assertPayoutEncryptionKey()).not.toThrow();
      },
    );
  });
});

/**
 * compose 的 MinIO CORS 变量名（审计 P1-4）。
 *
 * ⚠️ **变量名写错 = 白名单完全失效**：MinIO 的真实变量名是
 *    `MINIO_API_CORS_ALLOW_ORIGIN`；写成 `MINIO_CORS_ALLOW_ORIGIN`
 *    会被**静默忽略** → 回落到「反射任意 Origin + `Allow-Credentials: true`」
 *    → 任意站点都能带着用户 cookie 读预签名对象。
 *
 * ⚠️ 当年那句「实测该变量对预检请求生效」正是变量名写错时的假象
 *    （写错时**任何** Origin 都"生效"），所以它反而掩盖了这个 bug。
 *
 * ⚠️ **compose 与 .env.example 要一起改**：只改 compose 的话，
 *    照着 .env.example 配环境的人还是会踩同一个坑。
 */
describe('compose 的 MinIO CORS 变量名', () => {
  it('compose 用的是 MINIO_API_CORS_ALLOW_ORIGIN（不是写错的那个）', () => {
    const content = readFileSync(COMPOSE_PATH, 'utf8');

    expect(content).toContain('MINIO_API_CORS_ALLOW_ORIGIN');
    // 错名一旦回来，这里立刻红
    expect(content).not.toMatch(/^\s*MINIO_CORS_ALLOW_ORIGIN\s*:/m);
  });

  it('.env.example 用的也是 MINIO_API_CORS_ALLOW_ORIGIN', () => {
    // ⚠️ **是 infra 那份**：CORS 变量给 **MinIO 容器**用，
    //    compose 从同目录的 `.env` 读它（api 自己那份不配 CORS）。
    const content = readFileSync(INFRA_ENV_EXAMPLE_PATH, 'utf8');

    expect(content).toMatch(/^MINIO_API_CORS_ALLOW_ORIGIN=/m);
    expect(content).not.toMatch(/^MINIO_CORS_ALLOW_ORIGIN=/m);
  });
});
