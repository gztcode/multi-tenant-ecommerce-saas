-- 审计 P1-5（2026-11-05）：默认支付方式的「唯一」只写在应用代码里，数据库不管。
--
-- 旧状态：`payment_methods` 只有 `@@index([tenantId])`，没有任何约束保证
-- 「同一个租户最多一个 isDefault = true」。于是：
--   1. `create` 的「先清空所有默认、再插入新的默认」两条语句不在一个事务里，
--      中途失败就留下「零个默认」；并发两次 create 会各插一条默认。
--   2. `setDefault` 先清空再设置目标，目标不存在时原来的默认被清掉且没补上。
--   3. `remove` 删掉默认卡后不补默认 → 剩 0 个默认，
--      renewal.service 找不到默认卡就把订阅静默过期。
--
-- 修法：把「同租户最多一个默认」变成**数据库不变式**（部分唯一索引）。
--
-- ⚠️ **加索引前必须先清理存量**：库里已经有「同租户多个默认」的行时，
-- CREATE UNIQUE INDEX 会直接失败。清理规则是「每个租户只保留一个默认」，
-- 保留**最新创建**的那个 —— 与 `create` 的语义一致（新绑的卡成为默认），
-- 也与 `list` 的排序（`createdAt` 倒序）一致。
--
-- ⚠️ **本表没有 deletedAt**：解绑支付方式是**物理删除**
-- （见 `PaymentMethodService.remove`），所以索引条件里**不需要**
-- `AND "deletedAt" IS NULL`（对比 `addresses_tenant_customer_default_uniq`）。
--
-- 部分唯一索引由迁移手写、不在 schema.prisma 里声明（原样保留这一约定：
-- `prisma migrate diff` 不认识条件唯一索引，会把它当漂移输出成 DROP INDEX）。

-- 1. 清理存量：每个租户只留最新创建的那个默认，其余置为非默认。
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "tenantId"
           ORDER BY "createdAt" DESC, "id" DESC
         ) AS rn
  FROM "payment_methods"
  WHERE "isDefault" = true
)
UPDATE "payment_methods" AS pm
SET "isDefault" = false
FROM ranked
WHERE pm."id" = ranked."id" AND ranked.rn > 1;

-- 2. 建立不变式：同一个租户最多一个默认支付方式。
CREATE UNIQUE INDEX "payment_methods_tenant_default_uniq"
  ON "payment_methods" ("tenantId")
  WHERE "isDefault" = true;
