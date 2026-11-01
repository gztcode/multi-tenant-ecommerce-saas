-- ⚠️ **枚举必须先建**（PostgreSQL 的顺序要求：建表时要用到它）
CREATE TYPE "ReconciliationSource" AS ENUM ('API', 'FILE');
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "ReconciliationDiffType" AS ENUM (
  'CHANNEL_PENDING_LOCAL',
  'CHANNEL_SUCCESS_LOCAL_FAILED',
  'AMOUNT_MISMATCH',
  'CHANNEL_ONLY',
  'LOCAL_PAID_CHANNEL_ABSENT',
  'STATUS_MISMATCH'
);
CREATE TYPE "ReconciliationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "ReconciliationResolution" AS ENUM ('PENDING', 'RESOLVED', 'IGNORED');

-- ⚠️ **枚举加值**：两条语句要分开写（一条只能加一个值）；带 IF NOT EXISTS（本仓幂等约定）
-- ⚠️ **PG 16 允许在事务里 ADD VALUE，但新值不能在同一个事务里被使用** ——
--    本迁移 SQL 本身**不**使用这两个新值（只在应用代码里用）→ 单个迁移文件可行 ✅
ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'RECONCILE_TO_PAID';
ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'MANUAL_CONFIRM_PAID';

-- ⚠️ **加列**
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "releasedEntryIds" TEXT;
ALTER TABLE "payout_operations" ADD COLUMN IF NOT EXISTS "reconciliationId" TEXT;

-- ⚠️ **对账任务表**（无 tenantId → 不受租户作用域约束）
CREATE TABLE IF NOT EXISTS "payout_reconciliations" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "source" "ReconciliationSource" NOT NULL,
  "windowFrom" TIMESTAMP(3) NOT NULL,
  "windowTo" TIMESTAMP(3) NOT NULL,
  "fileName" TEXT,
  "columnMapping" TEXT,
  "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
  "triggeredBy" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "channelCount" INTEGER NOT NULL DEFAULT 0,
  "localCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "diffCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payout_reconciliations_channel_windowFrom_idx"
  ON "payout_reconciliations" ("channel", "windowFrom");
CREATE INDEX IF NOT EXISTS "payout_reconciliations_status_idx"
  ON "payout_reconciliations" ("status");

-- ⚠️ **差异明细表**（无 tenantId → 不受租户作用域约束；payoutId 可空 → 无外键）
CREATE TABLE IF NOT EXISTS "payout_reconciliation_items" (
  "id" TEXT NOT NULL,
  "reconciliationId" TEXT NOT NULL,
  "type" "ReconciliationDiffType" NOT NULL,
  "severity" "ReconciliationSeverity" NOT NULL,
  "payoutId" TEXT,
  "channelTxnId" TEXT,
  "channelReferenceNo" TEXT,
  "channelAmount" INTEGER,
  "channelStatus" TEXT,
  "channelPaidAt" TIMESTAMP(3),
  "localAmount" INTEGER,
  "localStatus" "PayoutStatus",
  "resolution" "ReconciliationResolution" NOT NULL DEFAULT 'PENDING',
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_reconciliation_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_reconciliation_items_reconciliationId_fkey"
    FOREIGN KEY ("reconciliationId") REFERENCES "payout_reconciliations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_reconciliationId_idx"
  ON "payout_reconciliation_items" ("reconciliationId");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_resolution_severity_idx"
  ON "payout_reconciliation_items" ("resolution", "severity");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_payoutId_idx"
  ON "payout_reconciliation_items" ("payoutId");
