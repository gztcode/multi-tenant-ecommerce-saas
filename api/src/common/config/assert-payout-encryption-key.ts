/**
 * 账目加密密钥的启动校验（阶段 5j）。
 *
 * ⚠️ **独立成一个函数，不塞进 `assertSecureConfig()`** ——
 *    那个是 5h-2 已验收的启动校验，牵连它不划算；
 *    而且「账目密钥」与「令牌密钥」的失败理由、排查方式都不同。
 *
 * ⚠️ **规则逐条照抄 `JWT_SECRET`**：
 *    长度不足任何环境都失败；占位符只在 production 失败。
 */
const PLACEHOLDER_KEY =
  'change-me-in-production-payout-key-at-least-32-chars-long';

export function assertPayoutEncryptionKey(): void {
  const secret = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY ?? '';

  if (secret.length < 32) {
    throw new Error(
      `PAYOUT_ACCOUNT_ENCRYPTION_KEY 至少需要 32 个字符，当前只有 ${secret.length} 个。` +
        '请设置一个足够随机的密钥（可用 `openssl rand -base64 48` 生成）。' +
        '⚠️ 这个密钥轮换后，已打款的出款单快照将永久解不开。',
    );
  }

  if (process.env.NODE_ENV === 'production' && secret === PLACEHOLDER_KEY) {
    throw new Error(
      '生产环境禁止使用 .env.example 里的 PAYOUT_ACCOUNT_ENCRYPTION_KEY 占位符，' +
        '请换成真实密钥。',
    );
  }
}
