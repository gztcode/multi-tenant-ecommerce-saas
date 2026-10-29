-- 阶段 5h-2：真正打款（出款执行 + 补差调账）
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出（见 5h-1 的同款说明）。
-- 做法：手写 → psql 应用 → `prisma migrate resolve --applied` 登记。
--
-- ⚠️ 每条语句都写成幂等的（IF NOT EXISTS / IF EXISTS）——
--    本文件分几次补齐（Task 1 已建 statementId 索引，Task 2 补其余），
--    每次补完都要重新应用整个文件。

-- ---------- 枚举 ----------

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayoutKind') THEN
    CREATE TYPE "PayoutKind" AS ENUM ('NORMAL', 'SUPPLEMENT');
  END IF;
END
$$;

-- ---------- payouts 的新列 ----------

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "kind" "PayoutKind" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "payoutChannel" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "payoutTxnId" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "processingAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "snapshotAccountName" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "snapshotBankName" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "snapshotAccountNo" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "stuckLoggedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settlement_statements" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);

-- ---------- 索引 ----------

-- ⚠️ 5h-1 的验收记录 §六 L32：P6 闸按 statementId 查出款单，量大时全表扫
CREATE INDEX IF NOT EXISTS "payouts_statementId_idx" ON "payouts"("statementId");

-- 执行侧：worker 按状态捞单
CREATE INDEX IF NOT EXISTS "payouts_status_createdAt_idx" ON "payouts"("status", "createdAt");

-- ⚠️ **部分唯一索引必须重建**（设计文档 §5.2）：
-- 5h-1 的版本是 (tenantId, periodStart)，挡住补差单；
-- 现在改成三元组 (tenantId, periodStart, kind)，
-- 且排除列表要加上 FAILED —— 否则一旦出款失败，该期永远无法再申请。
--
-- ⚠️ **不用 CONCURRENTLY**：它不能在事务块里跑，而本仓库的迁移要能走
--    `prisma migrate deploy`（测试库的 `deploy-test-db.mjs` 与 e2e 的
--    `setup-e2e.ts` 都跑它）—— deploy 把每个迁移包在一个事务里，
--    带 CONCURRENTLY 会直接报 `cannot run inside a transaction block`。
--    本仓库既有的部分唯一索引（`payments_provider_txn_uniq` 等）也是这个写法。
--
-- ⚠️ **先查重复**：新约束比旧约束宽（多了 kind 这一维），
--    旧数据必然满足 —— 但还是查一遍，别赌。
SELECT "tenantId", "periodStart", kind, COUNT(*)
FROM payouts
WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')
GROUP BY 1,2,3 HAVING COUNT(*) > 1;

DROP INDEX IF EXISTS "payouts_tenantId_active_period_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_tenantId_period_kind_active_uniq"
  ON "payouts" ("tenantId", "periodStart", kind)
  WHERE status NOT IN ('REJECTED','CANCELLED','FAILED');
