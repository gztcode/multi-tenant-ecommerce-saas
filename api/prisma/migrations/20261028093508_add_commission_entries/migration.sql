-- 阶段 5e：抽佣流水明细
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出。
-- 该命令在本项目会先提示「需要重置 public schema」（因为历史迁移文件
-- 在应用后被改过，与 _prisma_migrations 里的校验和不一致），
-- 而项目明令禁用 `prisma migrate reset`（阶段 2 已因此踩坑）。
-- 这里的 SQL 由 `prisma migrate diff --from-migrations ... --to-schema-datamodel`
-- 生成后**手工裁剪**而成。
--
-- ⚠️ diff 会把阶段 2/5a 的**手写部分唯一索引**当成漂移输出成 DROP INDEX
-- （这个坑项目里已经踩过两次）。下面那些被剔除的 DROP INDEX
-- （coupon_claims_coupon_customer_uniq / payments_provider_txn_uniq /
-- products_name_trgm / products_slug_trgm）都是手写索引，diff 不认识它们，
-- 删了会直接导致后续 migrate deploy 失败。
--
-- ⚠️ 本次变更**只有一条 CREATE TYPE、一张新表、三个索引、一条外键**：
-- 没有 DROP TABLE、没有数据删除、没有改动既有表。
--
-- 为什么要有这张表：阶段 5b 的决策是「抽佣不建独立表，存成订单上的两个快照字段」，
-- 遗留写的是「报表 SQL 要跨订单聚合；将来做结算单时再抽一层」。
-- 本阶段把那层抽出来了 —— 不是因为分叉点变多了，而是
-- **「按商家 × 区间出结算单」需要「这一笔属于哪个商家的哪一次成交」**，
-- 从订单聚合算不出来。

-- ---------- 枚举 ----------

-- CreateEnum
CREATE TYPE "CommissionEntryType" AS ENUM ('COMMISSION', 'REVERSAL');

-- ---------- 新表 ----------

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "type" "CommissionEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "baseAmount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **金额带符号**：COMMISSION > 0（抽佣），REVERSAL < 0（冲回）。
-- 单列求和即净额。
--
-- ⚠️ **tenantId 是纯标量，没有外键**：与 `orders.tenantId` 同款做法。
-- 「跨租户挂载」由 service 层显式校验，而不是靠外键悄悄放行。

-- ---------- 索引 ----------

-- ⚠️ 一单一抽佣、一单一冲回 → 幂等的兜底
-- CreateIndex
CREATE UNIQUE INDEX "commission_entries_orderId_type_key" ON "commission_entries"("orderId", "type");

-- ⚠️ 这两个索引覆盖两种主要查询：
-- ① 「某个商家在某区间内的流水」（平台结算单）
-- ② 「全平台在某区间内的流水」（平台收入报表将来切过来时用）
-- CreateIndex
CREATE INDEX "commission_entries_tenantId_occurredAt_idx" ON "commission_entries"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "commission_entries_occurredAt_idx" ON "commission_entries"("occurredAt");

-- ---------- 外键 ----------

-- ⚠️ **外键 Restrict**：流水是审计凭证，有流水的订单不允许被物理删除
-- （与 `inventory_movements` 同款理由）。
-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
