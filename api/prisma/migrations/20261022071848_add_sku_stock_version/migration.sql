-- ⚠️ 这条迁移在**全新库**上跑时会失败：它 ALTER 的 "skus" 表是
-- 20261022100000_add_catalog_tables 才建的，而这条迁移的时间戳更早。
--
-- 所以用 `IF EXISTS` / `IF NOT EXISTS` 让它在表不存在时整条跳过——
-- 已部署的库上表是存在的，行为不变（列照样被加上）。
--
-- ⚠️ 原来这里还有一对 `products_name_trgm` 的 DROP / CREATE。那是
-- `prisma migrate diff` 的**误判**：products_name_trgm 是计划 2 手写的
-- pg_trgm GIN 索引，Prisma 的 schema 里没有它，diff 就认为「这个索引
-- 不该存在」要删掉。删了商品搜索会退化成全表扫描，所以原来删完立刻建回来。
--
-- 但 `products` 表同样是 20261022100000 才建的，全新库上这两句都会失败
-- （`relation "products" does not exist`）。而这个索引在
-- 20261022100000_add_catalog_tables 里**已经建好了**，所以这里整段删掉：
-- 既修了全新库，又不丢索引。
--
-- 列本身由 20261024160000_ensure_sku_stock_version 补上（那条在表建好之后跑）。
ALTER TABLE IF EXISTS "skus"
  ADD COLUMN IF NOT EXISTS "stockVersion" INTEGER NOT NULL DEFAULT 0;
