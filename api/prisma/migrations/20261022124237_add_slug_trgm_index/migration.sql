-- slug 也参与公开商品搜索，但此前只有 name 建了 pg_trgm 的 GIN 索引。
--
-- 公开列表的搜索条件是 `name ILIKE ... OR slug ILIKE ...`——OR 的任一分支
-- 走不了索引，整个查询就退化成顺序扫描。`products_tenant_slug_uniq` 是
-- B-tree 的部分唯一索引，对前后通配的 ILIKE 无效。
--
-- 手写这个迁移而不是用 `prisma migrate dev` 生成：那样生成的话，
-- 同一次 diff 会顺带把 products_name_trgm 当成漂移删掉（Prisma 的 schema
-- 里没有手写索引）。
CREATE INDEX "products_slug_trgm" ON "products" USING GIN ("slug" gin_trgm_ops);
