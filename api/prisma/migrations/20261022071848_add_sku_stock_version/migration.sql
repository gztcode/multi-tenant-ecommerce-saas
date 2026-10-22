-- DropIndex
--
-- ⚠️ 这条 DROP 是 `prisma migrate diff` 的**误判**：products_name_trgm 是
-- 计划 2 手写的 pg_trgm GIN 索引，Prisma 的 schema 里没有它，diff 就认为
-- 「这个索引不该存在」要删掉。删了商品搜索会退化成全表扫描。
--
-- 所以这里删完立刻建回来。用 migrate diff 生成迁移时，手写索引都会被
-- 这样误删一次，必须逐个检查。
DROP INDEX "products_name_trgm";

-- 紧跟着建回来
CREATE INDEX "products_name_trgm" ON "products" USING GIN ("name" gin_trgm_ops);

-- AlterTable
ALTER TABLE "skus" ADD COLUMN     "stockVersion" INTEGER NOT NULL DEFAULT 0;

