-- ⚠️ **阶段 5m 实施期审查发现**：补两处缺失的索引
--
-- ① `payout_reconciliation_items` 的去重查询要同时按 (payoutId, type) 或
--    (channelTxnId, type) 过滤 —— D 类（渠道有、本地没有）没有 payoutId，
--    只能按渠道流水号 → 这个键上原本一个索引都没有 → 每次对账都全表扫。
--    这张表按设计只增不删（被标 IGNORED 的项保留，审计要看到「被发现过几次」）。
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_payoutId_type_idx"
  ON "payout_reconciliation_items" ("payoutId", "type");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_channelTxnId_type_idx"
  ON "payout_reconciliation_items" ("channelTxnId", "type");

-- ⚠️ **旧的单列索引被上面的复合索引的前缀覆盖** → 删掉，避免写放大
DROP INDEX IF EXISTS "payout_reconciliation_items_payoutId_idx";

-- ② `payout_operations.reconciliationId` 的索引 —— 这一列存在的唯一理由是
--    「答得出『这次对账纠正了哪几张单』」，查询就是 where: { reconciliationId }。
CREATE INDEX IF NOT EXISTS "payout_operations_reconciliationId_idx"
  ON "payout_operations" ("reconciliationId");
