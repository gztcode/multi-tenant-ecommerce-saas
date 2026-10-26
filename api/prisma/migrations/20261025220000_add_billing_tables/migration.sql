-- 阶段 5b：平台计费（套餐、订阅、账单、支付方式）+ 支付单泛化
--
-- ⚠️ 本文件**不是** `prisma migrate diff` 的原样输出。diff 会把阶段 2/5a 的
-- **手写部分唯一索引**当成漂移输出成 DROP INDEX（这个坑项目里已经踩过两次）。
-- 下面那些被剔除的 DROP INDEX（coupon_claims_coupon_customer_uniq /
-- payments_provider_txn_uniq / products_name_trgm / products_slug_trgm）都是
-- 手写索引，diff 不认识它们，删了会直接导致后续 migrate deploy 失败。

-- ---------- 枚举 ----------

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('ORDER', 'SUBSCRIPTION');

-- ---------- TenantStatus 收敛 ----------
--
-- 试用状态改由 Subscription.status 表达，租户状态收敛成「有没有被平台停用」
-- 这一件事：枚举只剩 ACTIVE / SUSPENDED。
--
-- ⚠️ **不能只删枚举标签**：PostgreSQL **从来没有** `ALTER TYPE ... DROP VALUE`
-- 这个语法（查过 9.5 到 19 的官方文档，只有 ADD VALUE 与 RENAME VALUE）。
-- 唯一能去掉枚举值的办法是**重建这个类型**。
--
-- ⚠️ **也不能用 RENAME VALUE 'TRIAL' TO 'ACTIVE'**：ACTIVE 标签已经存在
-- （枚举本来就是 TRIAL / ACTIVE / SUSPENDED），会报
-- `enum label "ACTIVE" already exists`。
--
-- 所以走「重建类型」四步，顺序不能换：
--   1. 摘默认值：默认值引用了 'TRIAL'，不摘的话后面的类型转换会被默认值卡住
--   2. 搬数据：所有 TRIAL 的租户变成 ACTIVE（试用状态已由 Subscription 表达），
--      必须在新类型转换**之前**搬——新类型里没有 'TRIAL' 这个值了
--   3. 建新类型 + 改列类型 + 删旧类型 + 改名
--   4. 装回默认值：新的默认值是 'ACTIVE'
ALTER TABLE "tenants" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "tenants" SET "status" = 'ACTIVE' WHERE "status" = 'TRIAL';
CREATE TYPE "TenantStatus_new" AS ENUM ('ACTIVE', 'SUSPENDED');
ALTER TABLE "tenants" ALTER COLUMN "status" TYPE "TenantStatus_new" USING ("status"::text::"TenantStatus_new");
DROP TYPE "TenantStatus";
ALTER TYPE "TenantStatus_new" RENAME TO "TenantStatus";
ALTER TABLE "tenants" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- ---------- 新列 ----------

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "commissionAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "commissionRate" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "kind" "PaymentKind" NOT NULL DEFAULT 'ORDER',
ALTER COLUMN "orderId" DROP NOT NULL;

-- ---------- 新表 ----------

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "periodDays" INTEGER NOT NULL DEFAULT 30,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "commissionBps" INTEGER NOT NULL DEFAULT 0,
    "maxProducts" INTEGER,
    "maxSkus" INTEGER,
    "maxStores" INTEGER DEFAULT 1,
    "features" JSONB NOT NULL DEFAULT '{}',
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "pendingPlanId" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- ---------- 索引 ----------

-- CreateIndex
CREATE INDEX "plans_status_sortOrder_idx" ON "plans"("status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "subscriptions_tenantId_status_idx" ON "subscriptions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_status_idx" ON "invoices"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_number_key" ON "invoices"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_subscriptionId_periodStart_key" ON "invoices"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "payment_methods_tenantId_idx" ON "payment_methods"("tenantId");

-- ---------- 支付单的唯一索引：改成部分唯一索引 ----------
--
-- ⚠️ orderId 变可空后，PostgreSQL 的 NULL **不参与唯一判定** ——
-- 多个 NULL 互不冲突 → 「同一个账单同一渠道只能有一笔支付单」这条保证没了。
--
-- Prisma 表达不了部分唯一索引，所以 schema 里**不声明** @@unique([orderId, channel])，
-- 这两条索引**完全由本迁移手写**。
DROP INDEX IF EXISTS "payments_orderId_channel_key";
CREATE UNIQUE INDEX "payments_order_channel_uniq"
  ON "payments" ("orderId","channel") WHERE "orderId" IS NOT NULL;
CREATE UNIQUE INDEX "payments_invoice_channel_uniq"
  ON "payments" ("invoiceId","channel") WHERE "invoiceId" IS NOT NULL;

-- ---------- 外键 ----------

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
