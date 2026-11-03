-- 阶段 6c 迁移 C：退款异步化
--
-- ⚠️ `ALTER TYPE ... ADD VALUE` 与新枚举值的**使用**不能放在同一个事务里
--    （Prisma 把每个迁移文件包在一个事务里，新值在本事务内不可见）。
--    本文件只加值，不在同一文件内消费它 —— 消费方是后续的应用代码。
--
-- ⚠️ `refundTxnId` 是 `queryRefund` 的唯一键：没有它，渠道回调丢了这张单
--    会永远停在 `REFUNDING`。
-- ⚠️ `refundAttemptCount` 用 NOT NULL DEFAULT 0：存量行不需要回填，
--    也不会因为 NULL 让「+1」变成 NULL。

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDING';

ALTER TABLE "payments" ADD COLUMN "refundTxnId" TEXT;
ALTER TABLE "payments" ADD COLUMN "refundRequestedAt" TIMESTAMP(3);
ALTER TABLE "payments" ADD COLUMN "refundFailureReason" TEXT;
ALTER TABLE "payments" ADD COLUMN "refundAttemptCount" INTEGER NOT NULL DEFAULT 0;
