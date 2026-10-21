-- 把租户内邮箱唯一的适用范围收窄到消费者。
--
-- 为什么必须改：users_email_ci_key 原本是 (LOWER(email), tenantId) 唯一、
-- 不含角色，导致同一个店主想在自己开的店里当消费者下单时，插入第二个
-- 同邮箱账号必然撞唯一约束。但按身份模型，邮箱属于「这个人」，而
-- 「以顾客身份下单」是另一个角色、另一个账号，两者并不冲突——
-- 店主在自己的店里购物是完全正常的用法，不该被数据库挡住。
--
-- 改成部分唯一索引后，各角色的唯一性由三条互不重叠的索引分别表达：
--   PLATFORM_ADMIN  → users_platform_admin_email_key（全局，tenantId IS NULL）
--   MERCHANT_OWNER  → users_merchant_owner_email_key（全局）
--   CUSTOMER        → users_customer_email_ci_key（租户内）
--
-- 为什么把 MERCHANT_STAFF 一起纳入这条：它是「某个人在某家店的岗位」，
-- 与消费者同属店铺内的普通账号，同租户同邮箱应当互斥。把 STAFF 排除在外
-- 会凭空放行「店员和顾客用同一个邮箱」这种本就该拒绝的组合。
-- 因此被放行的只有「店员 vs 店主」「店主 vs 自己店的消费者」两类
-- 有意允许的组合。
DROP INDEX "users_email_ci_key";

-- 消费者与店员在租户内邮箱大小写不敏感唯一。
CREATE UNIQUE INDEX "users_customer_email_ci_key"
  ON "users" (LOWER("email"), "tenantId")
  WHERE "role" IN ('CUSTOMER', 'MERCHANT_STAFF');