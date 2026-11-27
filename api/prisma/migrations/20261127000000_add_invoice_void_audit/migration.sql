-- 发票作废留痕（补齐 `InvoiceStatus.VOID` 的写路径）。
--
-- 背景：`InvoiceStatus` 早就有 `VOID`，`invoices.voidedAt` 也早就有列，
-- 但全仓零读写 —— 开票之后只能改库才能作废。本次补齐「作废」这个状态流转，
-- 并补两个**纯可空加列**记录「谁作废的、为什么作废」。
--
-- 语义：
--   - 作废**不删行**：`status` 置 `VOID`、写 `voidedAt` / `voidedBy` / `voidReason`，
--     账单号与金额原样保留，列表里仍然查得到（对账要能解释「这个周期为什么没续费」）。
--   - 三列都可空：历史账单本来就没有作废信息，存量行不需要回填。
--
-- 回滚（本迁移只加列，可安全回退）：
--   ALTER TABLE "invoices" DROP COLUMN "voidedBy";
--   ALTER TABLE "invoices" DROP COLUMN "voidReason";
ALTER TABLE "invoices" ADD COLUMN "voidedBy" TEXT;
ALTER TABLE "invoices" ADD COLUMN "voidReason" TEXT;
