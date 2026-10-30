-- 阶段 5j：收款账户与出款单快照的字段加密。
--
-- ⚠️ **本迁移不做数据加密** —— 密文要用应用层的密钥算，
--    SQL 层做不了 AES-GCM（需要随机 iv 与认证标签）。
--    数据加密由 `npm run migrate:payout-encryption` 负责（Task 3）。
--
-- ⚠️ **改名而不是删列**：老代码读旧列名会立刻报「列不存在」，
--    不会静默读错 —— 停机窗口内不会出现「新旧代码同时跑」的危险状态。

ALTER TABLE "merchant_payout_accounts"
  RENAME COLUMN "accountNo" TO "accountNoCipher";

ALTER TABLE "merchant_payout_accounts"
  ADD COLUMN "maskedAccountNo" TEXT NOT NULL DEFAULT '';

ALTER TABLE "merchant_payout_accounts"
  ADD COLUMN "encryptionVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "payouts"
  RENAME COLUMN "snapshotAccountNo" TO "snapshotAccountNoCipher";

ALTER TABLE "payouts"
  ADD COLUMN "snapshotMaskedAccountNo" TEXT;

ALTER TABLE "payouts"
  ADD COLUMN "snapshotEncryptionVersion" INTEGER NOT NULL DEFAULT 0;
