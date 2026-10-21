-- DropIndex
DROP INDEX "stores_tenantId_idx";

-- 大小写不敏感的租户内邮箱唯一。
-- Prisma 的 @@unique([tenantId, email]) 是大小写敏感的，且在 tenantId 为 NULL 时
-- 完全不参与唯一性判定，无法表达这两条业务约束，因此用原生 SQL 建表达式唯一索引。
CREATE UNIQUE INDEX "users_email_ci_key" ON "users" (LOWER("email"), "tenantId");

-- 平台超管（tenantId 为 NULL）的邮箱唯一。
-- PostgreSQL 的 NULL 不参与唯一性判定，所以复合唯一约束对平台超管无效，
-- 这里用部分唯一索引单独兜住。
CREATE UNIQUE INDEX "users_platform_admin_email_key"
  ON "users" (LOWER("email"))
  WHERE "tenantId" IS NULL AND "role" = 'PLATFORM_ADMIN';
