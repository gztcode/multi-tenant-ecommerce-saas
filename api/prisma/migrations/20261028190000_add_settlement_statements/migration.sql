-- 阶段 5g：结算单
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出。
-- 该命令在本项目会先提示「需要重置 public schema」（历史迁移文件在应用后
-- 被改过，与 _prisma_migrations 里的校验和不一致），而项目明令禁用
-- `prisma migrate reset`（阶段 2 已因此踩坑）。做法照 5c / 5e 的先例：
-- `prisma migrate diff` 生成 → 手工裁剪 → psql 应用 → migrate resolve 登记。
--
-- ⚠️ diff 会把阶段 2/5a 的**手写部分唯一索引**当成漂移输出成 DROP INDEX
-- （这个坑项目里已经踩过两次）。本次变更**只有一条 CREATE TYPE、两张新表、
-- 六个索引、两条外键**：没有 DROP TABLE、没有数据删除、没有改动既有表。
--
-- ⚠️ 索引清单（数得出来，别照抄上面的数字）：
--   settlement_statements_statementNo_key          UNIQUE (statementNo)
--   settlement_statements_tenantId_periodStart_key UNIQUE (tenantId, periodStart)
--   settlement_statements_periodStart_idx           (periodStart)
--   settlement_statements_status_idx                (status)
--   settlement_statement_entries_entryId_key        UNIQUE (entryId)
--   settlement_statement_entries_statementId_idx    (statementId)

-- ---------- 枚举 ----------

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PAID');

-- ---------- 新表 ----------

-- CreateTable
CREATE TABLE "settlement_statements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "statementNo" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "grossAmount" INTEGER NOT NULL,
    "reversalAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_statements_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **tenantId 是纯标量，没有外键**：与 `orders.tenantId`、`commission_entries.tenantId`
-- 同款做法。「跨租户挂载」由 service 层显式校验，而不是靠外键悄悄放行。

-- ---------- 索引 ----------

-- CreateIndex
CREATE UNIQUE INDEX "settlement_statements_statementNo_key" ON "settlement_statements"("statementNo");

-- ⚠️ **同一商家同一周期只能有一张单**（护栏 S3 的数据层兜底）
-- CreateIndex
CREATE UNIQUE INDEX "settlement_statements_tenantId_periodStart_key" ON "settlement_statements"("tenantId", "periodStart");

-- CreateIndex
CREATE INDEX "settlement_statements_periodStart_idx" ON "settlement_statements"("periodStart");

-- CreateIndex
CREATE INDEX "settlement_statements_status_idx" ON "settlement_statements"("status");

-- CreateTable
CREATE TABLE "settlement_statement_entries" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_statement_entries_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **entryId 全局唯一** → 一笔流水只能被一期结算（护栏 S4 的数据层兜底）。
-- 刻意**不**用 (statementId, entryId) 复合唯一 —— 那只保证「同一张单里不重复」，
-- 会放过「同一笔流水被两张单各结一次」。
-- CreateIndex
CREATE UNIQUE INDEX "settlement_statement_entries_entryId_key" ON "settlement_statement_entries"("entryId");

-- CreateIndex
CREATE INDEX "settlement_statement_entries_statementId_idx" ON "settlement_statement_entries"("statementId");

-- ---------- 外键 ----------

-- ⚠️ **statementId 用 Cascade**：明细行是单据的从属数据。
-- 单据本身**没有删除端点**（凭证不该被删），所以这个语义实际不触发。
-- AddForeignKey
ALTER TABLE "settlement_statement_entries" ADD CONSTRAINT "settlement_statement_entries_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "settlement_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠️ **entryId 用 Restrict**：已被结算单纳入的流水是账目的一部分，不允许被物理删除
-- AddForeignKey
ALTER TABLE "settlement_statement_entries" ADD CONSTRAINT "settlement_statement_entries_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
