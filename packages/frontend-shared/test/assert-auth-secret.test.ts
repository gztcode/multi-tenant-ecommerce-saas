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

describe('已知缺口', () => {
  it.todo(
    '生产环境是否应拒绝「过短」的 AUTH_SECRET？目前只拦空值与两个已知占位值，' +
      "`AUTH_SECRET=x` 能通过。阶段 9 设计文档（docs/requirements/archive/specs/" +
      '2026-11-04-plan-09-tech-debt-cleanup-design.md）只要求拦默认值/占位值，' +
      'deployment.md 的「至少 32 字符」只针对 JWT_SECRET 与 PAYOUT_ACCOUNT_ENCRYPTION_KEY。' +
      '是否给 AUTH_SECRET 也加长度下限，需要单独决定后再补测试。',
  );
});
