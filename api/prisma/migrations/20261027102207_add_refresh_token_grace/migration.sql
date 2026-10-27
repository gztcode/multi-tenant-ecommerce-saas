-- 阶段 5c：刷新令牌宽限期（RFC 9700）—— 旧令牌上记下「我轮换出了哪枚新令牌」
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出。
-- 该命令在本项目会先提示「需要重置 public schema」（因为历史迁移文件
-- 在应用后被改过，与 _prisma_migrations 里的校验和不一致），
-- 而项目明令禁用 `prisma migrate reset`（阶段 2 已因此踩坑）。
-- 这里的 SQL 由 `prisma migrate diff --from-migrations ... --to-schema-datamodel`
-- 生成后**手工裁剪**而成。
--
-- ⚠️ diff 会把阶段 2/5a 的**手写部分唯一索引**当成漂移输出成 DROP INDEX
-- （这个坑项目里已经踩过两次）。下面那些被剔除的 DROP INDEX
-- （coupon_claims_coupon_customer_uniq / payments_provider_txn_uniq /
-- products_name_trgm / products_slug_trgm）都是手写索引，diff 不认识它们，
-- 删了会直接导致后续 migrate deploy 失败。
--
-- ⚠️ 本次变更**只有两条 ADD COLUMN**，没有别的语句：
-- 没有 DROP TABLE、没有数据删除、没有新增索引。
--
-- rotatedToToken —— 本枚令牌轮换出的**新令牌的密文**（AES-256-GCM）。
--   ⚠️ 存密文而不是明文：沿用 token.util.ts 里「不存明文」的原则
--   （RefreshToken 表经常被备份与只读分析）。
--   ⚠️ 不加索引：查询只按 tokenHash（已有唯一索引）走，
--   没有按 rotatedToToken 查询的场景。
-- graceExpiresAt —— 宽限截止时刻。轮换时一次定死，不因重放而延长。

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "graceExpiresAt" TIMESTAMP(3),
ADD COLUMN     "rotatedToToken" TEXT;
