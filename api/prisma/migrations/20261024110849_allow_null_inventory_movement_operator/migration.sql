-- 放宽 InventoryMovement.operatorId 的非空约束。
--
-- 阶段 2 的库存调整是商家手动操作，operatorId 填店主 id；
-- 阶段 3 的预占（RESERVE）/释放（RELEASE）是**系统行为**，没有人工操作人——
-- 游客下单时连 orders.customerId 都是空的，填不出一个消费者 id。
-- 填 'system' 这类假值会让「谁动了库存」失真，所以宁可留空。
--
-- ⚠️ 放宽约束是安全的：已有的行全部有值，DROP NOT NULL 不影响存量数据。
ALTER TABLE "inventory_movements" ALTER COLUMN "operatorId" DROP NOT NULL;
