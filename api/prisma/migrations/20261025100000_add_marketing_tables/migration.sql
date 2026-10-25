-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('SHOP', 'PLATFORM');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CouponRedemptionStatus" AS ENUM ('RESERVED', 'USED', 'RELEASED');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "couponDiscountAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "couponId" TEXT,
ADD COLUMN     "couponName" TEXT,
ADD COLUMN     "originalAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotionDiscountAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotionId" TEXT;

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "CouponType" NOT NULL DEFAULT 'FIXED',
    "value" INTEGER NOT NULL,
    "minAmount" INTEGER NOT NULL DEFAULT 0,
    "perUserLimit" INTEGER,
    "totalLimit" INTEGER,
    "claimedCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "scope" "CouponScope" NOT NULL DEFAULT 'SHOP',
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "CouponRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "discountAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minAmount" INTEGER NOT NULL DEFAULT 0,
    "discountAmount" INTEGER NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coupons_tenantId_status_idx" ON "coupons"("tenantId", "status");

-- CreateIndex
CREATE INDEX "coupon_claims_tenantId_customerId_idx" ON "coupon_claims"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "coupon_redemptions_tenantId_customerId_idx" ON "coupon_redemptions"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "promotions_tenantId_status_idx" ON "promotions"("tenantId", "status");


-- ---------- 手写的部分唯一索引 ----------
--
-- Prisma 的 @@unique 表达不了「条件唯一」，且 PostgreSQL 的 NULL 不参与唯一性判定。
-- 下面三条索引 Prisma schema 里**刻意没有声明**，全靠迁移手写。
--
-- ⚠️ 它们必须手写：`prisma migrate diff` 不认识条件唯一索引，会把它们当漂移
-- 输出成 DROP INDEX（阶段 2 已经踩过这个坑）。所以本文件里的手写索引
-- 不要靠 diff 重新生成。

-- 券码在租户内唯一，但软删后仍占用 —— 所以用部分唯一索引只约束未删除的
--
-- ⚠️ 为什么不用 `@@unique([tenantId, code])`：软删后 code 仍占用唯一性，
-- 而商家「先下架一张券、再用同一个码发一张新券」是正常操作。
-- 普通的 @@unique 做不到「仅对未删除记录生效」——带 deletedAt 的复合唯一
-- 也无效，因为 PostgreSQL 的 NULL 不参与唯一性判定。
-- 与 categories.slug 的处理完全同款。
CREATE UNIQUE INDEX "coupons_tenant_code_uniq"
  ON "coupons" ("tenantId", "code") WHERE "deletedAt" IS NULL;

-- 一个用户对同一张券只有一行领取汇总（quantity 累加在行内）
--
-- ⚠️ 这条**不是**部分唯一索引：CouponClaim 不软删，行永远存在。
CREATE UNIQUE INDEX "coupon_claims_coupon_customer_uniq"
  ON "coupon_claims" ("couponId", "customerId");

-- **一张券只能被一个订单预占**（M5 的数据层保证）
--
-- ⚠️ 这条是本阶段最关键的索引。设计文档 §3.3 的 `@@unique([couponId, orderId])`
-- 表达的是「同一张券不能被两个订单各核销一次」——但它**拦不住**
-- 「券 A 被订单 1 核销后，又被订单 2 核销」，
-- 因为 couponId 与 orderId 都不同，组合是唯一的。
--
-- 真正要拦的是「**同一张券**在同一时刻只能有一条 RESERVED/USED 的核销」。
-- 那个条件是 status，Prisma 表达不了 → 必须手写部分唯一索引。
--
-- 这样并发下单抢同一张券时：一个成功、一个撞唯一索引 → 转 409「该券已被使用」。
CREATE UNIQUE INDEX "coupon_redemptions_coupon_active_uniq"
  ON "coupon_redemptions" ("couponId")
  WHERE "status" IN ('RESERVED', 'USED');
