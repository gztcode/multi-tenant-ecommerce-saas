/**
 * 已知的「示例/默认密钥」集合（阶段 8a）。
 *
 * ⚠️ **必须同时包含两类值**：
 * 1. `.env.example` 里给开发者复制的占位符（现有两个守卫各自写死的那两个串）
 * 2. `infra/docker-compose.yml` 里 `${VAR:-默认值}` 的默认值
 *
 * 原实现只与第一类做字面等值比较，但 compose 启动时注入的是第二类
 * ——于是「提交进 git 的固定密钥 + NODE_ENV=production」能正常启动。
 *
 * ⚠️ **不改 compose 的默认值**（设计 §3.2）：`PAYOUT_ACCOUNT_ENCRYPTION_KEY`
 * 一旦改动，既有出款单快照永久解不开。
 * ⚠️ `placeholder-secrets.spec.ts` 会解析 compose 断言默认值都在集合内，
 * 防止将来两边再次漂移。
 *
 * 值为空的字符串不在集合里：长度校验会先把它拦下，这里不重复处理。
 */
export const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  // 1) 原 assert-secure-config.ts 的 PLACEHOLDER_SECRET（.env.example 的 JWT_SECRET）
  'change-me-in-production-at-least-32-chars-long',
  // 2) 原 assert-payout-encryption-key.ts 的 PLACEHOLDER_KEY（.env.example 的账目密钥）
  'change-me-in-production-payout-key-at-least-32-chars-long',
  // 3) infra/docker-compose.yml 的 ${JWT_SECRET:-...} 默认值
  'local-dev-only-jwt-secret-at-least-32-chars-long',
  // 4) infra/docker-compose.yml 的 ${PAYOUT_ACCOUNT_ENCRYPTION_KEY:-...} 默认值
  '-local-dev-only-payout-encryption-key-at-least-32-chars',
]);

/** 该值是否是已知的示例/默认密钥 */
export function isPlaceholderSecret(value: string): boolean {
  return KNOWN_PLACEHOLDER_SECRETS.has(value);
}
