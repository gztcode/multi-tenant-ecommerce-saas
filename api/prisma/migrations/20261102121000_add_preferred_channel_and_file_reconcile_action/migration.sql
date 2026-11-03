-- 阶段 6a 迁移 B：商家默认出款渠道 + CSV 人工确认的留痕动作
--
-- ⚠️ `ALTER TYPE ... ADD VALUE` 与新值的**使用**不能放在同一个事务里
--    （Prisma 把每个迁移文件包在一个事务里，新枚举值在本事务内不可见）。
--    本文件只加值，不在同一文件内消费它 —— 消费方是后续的应用代码。

ALTER TABLE "merchant_payout_accounts" ADD COLUMN "preferredChannel" TEXT;

ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'RECONCILE_TO_PAID_BY_FILE';
