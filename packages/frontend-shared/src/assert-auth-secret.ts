/**
 * NextAuth 的 `AUTH_SECRET` 启动守卫（阶段 9）。
 *
 * ⚠️ **为什么放在共享包**：三端 `auth.ts` 是同一套逻辑的三份副本，
 *    守卫各写一份早晚漂移。这里只有一份实现，三端各调一次。
 *
 * ⚠️ **必须在 `auth.ts` 模块顶层调用**：NextAuth 在模块求值时读取 secret，
 *    等到请求进来再检查就晚了——进程已经带着默认密钥跑起来了。
 *
 * ⚠️ **占位值集合必须同时包含**：
 *    1. `infra/docker-compose.yml` 里 `${AUTH_SECRET:-...}` 的默认值；
 *    2. `infra/.env.example` 给开发者复制的显式占位值。
 *    只认其中一类，另一类就能原样进生产。
 */
export const KNOWN_AUTH_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  // infra/docker-compose.yml 的 ${AUTH_SECRET:-...} 默认值（与 compose 逐字相同）
  'local-dev-only-auth-secret-at-least-32-chars',
  // infra/.env.example 的显式占位值
  'change-me-auth-secret-at-least-32-chars',
]);

/** 生产环境禁止空值或已知默认值；非生产环境放行。 */
export function assertAuthSecret(secret: string | undefined): void {
  // ⚠️ `next build` 会设置 NEXT_PHASE=phase-production-build。
  //    构建期没有运行时密钥是正常的（密钥由容器运行时注入），
  //    这里放行；容器启动时仍会执行本函数，生产守卫不受影响。
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (!secret) {
    throw new Error(
      '生产环境必须设置 AUTH_SECRET（可用 `openssl rand -base64 48` 生成）。',
    );
  }

  if (KNOWN_AUTH_SECRET_PLACEHOLDERS.has(secret)) {
    throw new Error(
      '生产环境禁止使用示例/默认的 AUTH_SECRET（含 docker-compose 内置默认值），请换成真实密钥。',
    );
  }
}
