-- 补上 skus.stockVersion 列。
--
-- 20261022071848_add_sku_stock_version 在**全新库**上会整条跳过（那时
-- "skus" 表还不存在，它在 20261022100000_add_catalog_tables 里才建），
-- 所以由这条在表建好之后把列补上。
--
-- 已部署的库上这个列早就有了，`IF NOT EXISTS` 让它整条跳过。
--
-- ⚠️ 加了 `DEFAULT 0` 而不是 `NOT NULL` 无默认值：PostgreSQL 的
-- `ADD COLUMN ... NOT NULL DEFAULT 0` 会用默认值回填存量行，
-- 大表上是一次全表重写。默认值本身就是 0，语义等价。
ALTER TABLE "skus"
  ADD COLUMN IF NOT EXISTS "stockVersion" INTEGER NOT NULL DEFAULT 0;
