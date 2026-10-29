-- 阶段 5h-1：出款（把货款结算给商家）
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出。
-- 该命令在本项目会先提示「需要重置 public schema」（历史迁移文件在应用后
-- 被改过，与 _prisma_migrations 里的校验和不一致），而项目明令禁用
-- `prisma migrate reset`（阶段 2 已因此踩坑）。做法照 5c / 5e / 5g 的先例：
-- 手写 → psql 应用 → `prisma migrate resolve --applied` 登记。
--
-- ⚠️ 本次变更：2 个枚举、4 张新表、12 条索引（8 条 CREATE INDEX + 4 个内联主键）、
-- 4 条外键。没有 DROP TABLE、没有数据删除、没有改动既有表。
--
-- ⚠️ 索引清单（数得出来，别照抄上面的数字）：
--   merchant_receipts_pkey                          PRIMARY KEY
--   merchant_receipts_orderId_type_key              UNIQUE (orderId, type)
--   merchant_receipts_tenantId_occurredAt_idx       (tenantId, occurredAt)
--   merchant_payout_accounts_pkey                   PRIMARY KEY
--   merchant_payout_accounts_tenantId_key           UNIQUE (tenantId)
--   payouts_pkey                                    PRIMARY KEY
--   payouts_payoutNo_key                            UNIQUE (payoutNo)
--   payouts_status_idx                              (status)
--   payouts_tenantId_active_period_uniq             UNIQUE (tenantId, periodStart) WHERE status NOT IN ('REJECTED','CANCELLED')
--   payout_entries_pkey                             PRIMARY KEY
--   payout_entries_entryId_key                      UNIQUE (entryId)
--   payout_entries_payoutId_idx                     (payoutId)

-- ---------- 枚举 ----------

-- CreateEnum
CREATE TYPE "ReceiptType" AS ENUM ('SALE', 'SALE_REVERSAL');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PAID', 'FAILED');

-- ---------- 新表 ----------

-- CreateTable
CREATE TABLE "merchant_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "type" "ReceiptType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_payout_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payoutNo" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "statementId" TEXT,
    "receiptAmount" INTEGER NOT NULL,
    "commissionAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAmount" INTEGER NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "rejectedReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_entries" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_entries_pkey" PRIMARY KEY ("id")
);

-- ---------- 索引 ----------

-- CreateIndex
CREATE UNIQUE INDEX "merchant_receipts_orderId_type_key" ON "merchant_receipts"("orderId", "type");

-- CreateIndex
CREATE INDEX "merchant_receipts_tenantId_occurredAt_idx" ON "merchant_receipts"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payout_accounts_tenantId_key" ON "merchant_payout_accounts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_payoutNo_key" ON "payouts"("payoutNo");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- ⚠️ **部分唯一索引**：同一商家同一周期只能有**一张活跃**出款单。
-- 条件排除 REJECTED / CANCELLED —— 那两种是终态，商家可以**重新申请**同一周期。
-- ⚠️ **为什么不用全量唯一索引**：全量的会让「被拒绝的出款单」永久占住那个周期，
-- 商家再也不能申请 → 那笔钱永远拿不到。
-- ⚠️ **Prisma 的 `@@unique` 表达不了这个语义**（它不认 WHERE 子句），
-- 所以 schema 里**不要**声明它 —— 声明了也不生效，只会让人误以为约束在数据库层。
-- 这与 `payments` 表的三个部分唯一索引是同一套做法。
-- CreateIndex
CREATE UNIQUE INDEX "payouts_tenantId_active_period_uniq" ON "payouts"("tenantId", "periodStart") WHERE "status" NOT IN ('REJECTED', 'CANCELLED');

-- CreateIndex
CREATE UNIQUE INDEX "payout_entries_entryId_key" ON "payout_entries"("entryId");

-- CreateIndex
CREATE INDEX "payout_entries_payoutId_idx" ON "payout_entries"("payoutId");

-- ---------- 外键 ----------

-- ⚠️ **orderId 用 Restrict**：货款流水是账目的一部分，不允许被物理删除。
-- AddForeignKey
ALTER TABLE "merchant_receipts" ADD CONSTRAINT "merchant_receipts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ **statementId 用 Restrict**：结算单是凭证，没有删除端点 → 这个语义实际不触发，
-- 但外键能保证「引用的结算单一定存在」。
-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "settlement_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ **payoutId 用 Cascade**：明细行是出款单的从属数据。
-- AddForeignKey
ALTER TABLE "payout_entries" ADD CONSTRAINT "payout_entries_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠️ **entryId 用 Restrict**：已被出款的货款流水不允许被物理删除。
-- AddForeignKey
ALTER TABLE "payout_entries" ADD CONSTRAINT "payout_entries_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "merchant_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
