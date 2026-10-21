-- 删除 Prisma schema 里的 @@unique([tenantId, email]) 对应的数据库索引。
--
-- 为什么必须删：这条约束**不含角色**，比新的三条部分唯一索引都更严格——
-- 同租户内「店主在自己开的店里当消费者下单」这种正常用法也会被它挡在前面，
-- 抛出无法解释给用户的唯一约束冲突。留着它等于让部分索引形同虚设。
--
-- 用 IF EXISTS 保证幂等：开发库上这条索引可能已被手工清理过。
DROP INDEX IF EXISTS "users_tenantId_email_key";
