-- 修历史迁移的 checksum。
--
-- 背景：`20261022071848_add_sku_stock_version` 被改写过（让它在**全新库**上
-- 整条跳过——它 ALTER 的 "skus" 表是后面那条迁移才建的）。
--
-- 于是**已经跑过旧版它的库**在 `prisma migrate deploy` 时会报：
--   The following migration have been modified since it was applied
-- 而**全新库不需要做任何事**（那条迁移本来就没跑过，不存在 checksum）。
--
-- 用法：把 DATABASE_URL 指到你的库，然后
--   cd api
--   npx prisma db execute --schema prisma/schema.prisma \
--     --file prisma/fix-legacy-migration-checksum.sql
--
-- ⚠️ 只在**真的报过上面那个错**的库上执行。
-- 重复执行是安全的（WHERE 里带了 checksum 的旧值判断）。
UPDATE "_prisma_migrations"
SET checksum = 'b596fa3d442751184049144418cea4cea422814b23c8f97b9e283759b3f0d835'
WHERE migration_name = '20261022071848_add_sku_stock_version'
  AND checksum <> 'b596fa3d442751184049144418cea4cea422814b23c8f97b9e283759b3f0d835';
