-- 审计 P0-7（2026-11-05）：券的核销唯一索引粒度错了。
--
-- 旧索引是 ON ("couponId") WHERE "status" IN ('RESERVED','USED')
-- —— **按券全局唯一**：一张券在同一时刻只能有一条有效核销记录，
-- 不管核销的是谁。于是任意一个消费者下单占用后，
-- 全店所有其他消费者手里的同一张券同时失效：
-- 明明各自都领了（coupon_claims 里各有一行），
-- 结算页却看不到这张券、显式指定则 409「该券已被使用」。
-- 「限 50 张」的券实际只能用 1 张。
--
-- ⚠️ **「一券一实例」不是产品要求，是索引选错了粒度**：
-- totalLimit（总发放份数）、perUserLimit（每用户份数）、
-- coupon_claims.quantity（这个用户领了几份）、
-- 前端「已领 N 张 / 剩余 N 张」——全是**份数**语义。
-- 正确的模型是「一份券给一个用户用一次」，
-- 所以唯一索引必须是 (couponId, customerId)。
--
-- ⚠️ **存量数据必然能直接建**：旧索引下同一张券最多只有一条有效核销记录，
-- 换成 (couponId, customerId) 不会撞任何现存行。
--
-- 部分唯一索引由迁移手写、不在 schema.prisma 里声明（原样保留这一约定）。
DROP INDEX IF EXISTS "coupon_redemptions_coupon_active_uniq";
CREATE UNIQUE INDEX "coupon_redemptions_coupon_active_uniq"
  ON "coupon_redemptions" ("couponId", "customerId")
  WHERE "status" IN ('RESERVED', 'USED');
