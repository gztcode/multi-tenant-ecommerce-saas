-- 给 InventoryMovement 加 orderId：流水与订单之间的数据层关联。
--
-- 之前流水与订单之间**只有自由文本的 reason**（形如「订单 <uuid> 预占」），
-- 没有任何数据层关联——要查「某个订单预占了多少」只能去解析 reason 文本。
-- 于是「这些条目确实被预占过」这件事无法在数据层验证：
-- 对一个从未预占过的 SKU 调释放，库存会凭空 +5，而流水与库存的净变化
-- **是自洽的**，对账时看不出问题；重复释放同一个订单还会把库存加回两次。
--
-- 有了这个字段就能按 orderId 汇总出「尚未被冲抵的预占量」，
-- 释放与扣减都拿它当上限校验。
--
-- ⚠️ 可空：阶段 2 的 INITIAL / ADJUST_IN / ADJUST_OUT 流水与订单无关。
-- ⚠️ 加可空列对存量数据是安全的：已有行全部为 NULL。
ALTER TABLE "inventory_movements" ADD COLUMN "orderId" TEXT;

-- 汇总「某个订单对某些 SKU 尚未被冲抵的预占量」要按 orderId 查。
--
-- ⚠️ 索引是**手写**的：Prisma 迁移的 diff 会把「schema 里没有的索引」
-- 当成漂移要删掉。阶段 2 的 products_name_trgm 就这么被误删过一次
-- （见 20261022071848_add_sku_stock_version/migration.sql 的说明）。
-- 好在 schema 里也声明了 @@index([orderId])，两边一致，diff 就不会动它。
CREATE INDEX "inventory_movements_orderId_idx" ON "inventory_movements" ("orderId");
