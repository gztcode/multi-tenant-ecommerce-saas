-- 退货入库（阶段 11d）：新增 RETURN 流水类型。
--
-- 语义：退款**不**自动回补库存（设计取舍，见 README），货真退回来时由商家
-- 手动入库。RETURN 流水带 orderId（InventoryMovement.orderId 已存在），
-- 「该订单该 SKU 已入库多少」用 RETURN 流水的 SUM 做上限校验，
-- 防止重复入库把库存凭空加多。
--
-- ⚠️ ALTER TYPE ADD VALUE 在 PG 12+ 可以在事务里执行
--    （只要不在同一事务里使用新值——本迁移只用不写）。
ALTER TYPE "InventoryMovementType" ADD VALUE 'RETURN' AFTER 'DEDUCT';
