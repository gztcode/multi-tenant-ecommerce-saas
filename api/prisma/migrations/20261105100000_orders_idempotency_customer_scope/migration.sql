-- 审计 P0-2（2026-11-05）：下单幂等键必须按消费者归属隔离。
--
-- 旧索引 (tenantId, idempotencyKey) 不含 customerId：消费者 B 用消费者 A
-- 的幂等键下单，会直接命中 A 的订单（快路径与并发重查路径都只按
-- 租户 + 键查），B 拿到 A 的整张订单——收货人、电话、省市区详址。
--
-- 幂等键本来就是「每个消费者各自的」：不同消费者用同一个键各下各的单，
-- 互不干扰。唯一索引随之改成 (tenantId, customerId, idempotencyKey)。
-- ⚠️ 只改代码里的 where 不改索引，会把「泄漏」变成 500：
-- B 的插入仍撞旧索引 → P2002 分支重查（where 已含归属）查不到 → throw。
--
-- 部分唯一索引由迁移手写、不在 schema.prisma 里声明（原样保留这一约定）。
-- 订单唯一写入入口 placeOrder 强制登录（requireCustomerId），
-- 带 idempotencyKey 的行 customerId 恒非空。
DROP INDEX IF EXISTS "orders_tenant_idempotency_uniq";
CREATE UNIQUE INDEX "orders_tenant_idempotency_uniq"
  ON "orders" ("tenantId", "customerId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
