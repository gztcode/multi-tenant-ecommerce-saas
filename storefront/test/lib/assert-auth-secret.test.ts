/**
 * AUTH_SECRET 启动守卫：生产环境禁止使用空值或示例/默认值。
 *
 * ⚠️ 三端各一份是刻意的：`auth.ts` 本身就是三份副本，
 *    哪一端漏接守卫，都必须有测试当场暴露。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAuthSecret,
  KNOWN_AUTH_SECRET_PLACEHOLDERS,
} from '@ecom/frontend-shared/assert-auth-secret';

// next 的类型声明把 NODE_ENV 标成 readonly，测试里用 vi.stubEnv 覆写。
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertAuthSecret', () => {
  it('生产环境 + 任一已知占位值 → 抛错', () => {
    vi.stubEnv('NODE_ENV', 'production');

    for (const placeholder of KNOWN_AUTH_SECRET_PLACEHOLDERS) {
      expect(() => assertAuthSecret(placeholder)).toThrow(/AUTH_SECRET/);
    }
  });

  it('生产环境 + 空值 → 抛错', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => assertAuthSecret(undefined)).toThrow(/AUTH_SECRET/);
    expect(() => assertAuthSecret('')).toThrow(/AUTH_SECRET/);
  });

  it('生产环境 + 真实值 → 放行', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() =>
      assertAuthSecret('a-real-auth-secret-with-enough-entropy'),
    ).not.toThrow();
  });

  it('非生产环境 + 占位值 → 放行（本地开发）', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(() => assertAuthSecret('change-me-auth-secret-at-least-32-chars')).not.toThrow();
  });

  it('next build 阶段 + 无 secret → 放行（运行时才守卫）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');

    expect(() => assertAuthSecret(undefined)).not.toThrow();
  });
});
