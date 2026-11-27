/**
 * `AUTH_SECRET` 生产守卫。
 *
 * ⚠️ 这层守卫是「部署时忘配密钥」与「拿示例密钥上生产」的最后一道闸：
 * 漏了它，NextAuth 就会用一个**公开在仓库里**的密钥签发会话 cookie，
 * 任何人都能自己伪造一张管理员会话。
 */
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertAuthSecret,
  KNOWN_AUTH_SECRET_PLACEHOLDERS,
} from '../src/assert-auth-secret';

const REAL_SECRET = 'Zm9vYmFyYmF6cXV1eC1yZWFsLXNlY3JldC12YWx1ZS0wMTIzNDU2Nzg5';

function readRepoFile(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('生产环境缺密钥', () => {
  it('undefined 与空串都抛错', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertAuthSecret(undefined)).toThrow(/必须设置 AUTH_SECRET/);
    expect(() => assertAuthSecret('')).toThrow(/必须设置 AUTH_SECRET/);
  });
});

describe('生产环境用占位密钥', () => {
  it.each([...KNOWN_AUTH_SECRET_PLACEHOLDERS])('拒绝占位值 %s', (placeholder) => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertAuthSecret(placeholder)).toThrow(/禁止使用示例\/默认的 AUTH_SECRET/);
  });

  it('真实密钥放行', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertAuthSecret(REAL_SECRET)).not.toThrow();
  });
});

describe('非生产环境一律放行', () => {
  it('development 下缺密钥、占位值都不抛', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(() => assertAuthSecret(undefined)).not.toThrow();
    expect(() => assertAuthSecret('')).not.toThrow();
    for (const placeholder of KNOWN_AUTH_SECRET_PLACEHOLDERS) {
      expect(() => assertAuthSecret(placeholder)).not.toThrow();
    }
  });

  it('NODE_ENV 未定义时也不抛', () => {
    vi.stubEnv('NODE_ENV', '');

    expect(() => assertAuthSecret(undefined)).not.toThrow();
  });
});

describe('next build 阶段放行', () => {
  it('NEXT_PHASE=phase-production-build 时不检查（运行时密钥由容器注入）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');

    expect(() => assertAuthSecret(undefined)).not.toThrow();
    expect(() => assertAuthSecret([...KNOWN_AUTH_SECRET_PLACEHOLDERS][0])).not.toThrow();
  });
});

describe('占位值名单与部署文件保持一致', () => {
  it('infra/docker-compose.yml 里的 AUTH_SECRET 默认值在名单里', () => {
    const compose = readRepoFile('../../../infra/docker-compose.yml');
    const defaults = [...compose.matchAll(/AUTH_SECRET: \$\{AUTH_SECRET:-([^}]*)\}/g)].map(
      (match) => match[1].trim(),
    );

    expect(defaults.length).toBeGreaterThan(0);
    for (const value of defaults) {
      // 改了 compose 默认值却忘了同步名单 → 那个默认密钥就能原样进生产
      expect(KNOWN_AUTH_SECRET_PLACEHOLDERS.has(value)).toBe(true);
    }
  });

  it('infra/.env.example 里的 AUTH_SECRET 占位值在名单里', () => {
    const example = readRepoFile('../../../infra/.env.example');
    const match = /^AUTH_SECRET=(.*)$/m.exec(example);

    expect(match).not.toBeNull();
    expect(KNOWN_AUTH_SECRET_PLACEHOLDERS.has(match![1].trim())).toBe(true);
  });
});

describe('生产环境密钥长度下限（32 字符）', () => {
  it('31 字符 → 抛错（边界）', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertAuthSecret('a'.repeat(31))).toThrow(/至少需要 32 个字符/);
  });

  it('32 字符 → 放行（边界）', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertAuthSecret('a'.repeat(32))).not.toThrow();
  });

  it('非生产环境短 secret 放行（本地开发）', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(() => assertAuthSecret('short')).not.toThrow();
  });
});
