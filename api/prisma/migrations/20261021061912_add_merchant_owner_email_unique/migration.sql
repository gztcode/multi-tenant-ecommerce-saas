-- 店主账号的邮箱全局唯一：一个自然人在平台上只有一个店主身份，
-- 要经营第二家店应当用 MERCHANT_STAFF 身份。
--
-- 为什么必须是部分唯一索引而不是复合唯一约束：
--   MERCHANT_OWNER 天然带 tenantId，用 @@unique([tenantId, email]) 只能约束租户内唯一，
--   挡不住「同一个邮箱在 A 店、B 店各开一个店主」。而登录是跨租户按邮箱查账号，
--   候选多于一个时落点不确定。
--
-- 为什么不能用普通唯一索引：
--   那会把 CUSTOMER / MERCHANT_STAFF 的邮箱也拉进来变成全局唯一，
--   而它们按设计只需要租户内唯一（users_email_ci_key 已经覆盖）。
--
-- 排序键选 LOWER(email) 与既有的 users_email_ci_key、users_platform_admin_email_key
-- 保持一致：写入侧统一小写化，但历史数据与外部导入不保证，读侧必须大小写不敏感。
CREATE UNIQUE INDEX "users_merchant_owner_email_key"
  ON "users" (LOWER("email"))
  WHERE "role" = 'MERCHANT_OWNER';