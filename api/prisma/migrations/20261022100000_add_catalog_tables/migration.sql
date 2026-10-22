-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "SkuStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'ORPHANED');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('INITIAL', 'ADJUST_IN', 'ADJUST_OUT', 'CHECK', 'RESERVE', 'RELEASE', 'DEDUCT');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "minPrice" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_specs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_spec_values" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "specId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "mediaId" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "product_spec_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT,
    "price" INTEGER NOT NULL,
    "comparePrice" INTEGER,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "status" "SkuStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_spec_values" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,

    CONSTRAINT "sku_spec_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_medias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_medias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stockBefore" INTEGER NOT NULL,
    "stockAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "operatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_tenantId_parentId_idx" ON "categories"("tenantId", "parentId");

-- CreateIndex
CREATE INDEX "products_tenantId_status_idx" ON "products"("tenantId", "status");

-- CreateIndex
CREATE INDEX "products_tenantId_categoryId_idx" ON "products"("tenantId", "categoryId");

-- CreateIndex
CREATE INDEX "product_specs_tenantId_productId_idx" ON "product_specs"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "product_spec_values_tenantId_specId_idx" ON "product_spec_values"("tenantId", "specId");

-- CreateIndex
CREATE INDEX "skus_tenantId_productId_idx" ON "skus"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "sku_spec_values_tenantId_skuId_idx" ON "sku_spec_values"("tenantId", "skuId");

-- CreateIndex
CREATE UNIQUE INDEX "sku_spec_values_skuId_valueId_key" ON "sku_spec_values"("skuId", "valueId");

-- CreateIndex
CREATE INDEX "media_tenantId_status_idx" ON "media"("tenantId", "status");

-- CreateIndex
CREATE INDEX "product_medias_tenantId_productId_idx" ON "product_medias"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_medias_productId_mediaId_key" ON "product_medias"("productId", "mediaId");

-- CreateIndex
CREATE INDEX "inventory_movements_tenantId_skuId_createdAt_idx" ON "inventory_movements"("tenantId", "skuId", "createdAt");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_specs" ADD CONSTRAINT "product_specs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_specs" ADD CONSTRAINT "product_specs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_spec_values" ADD CONSTRAINT "product_spec_values_specId_fkey" FOREIGN KEY ("specId") REFERENCES "product_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_spec_values" ADD CONSTRAINT "product_spec_values_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_spec_values" ADD CONSTRAINT "product_spec_values_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_spec_values" ADD CONSTRAINT "sku_spec_values_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_spec_values" ADD CONSTRAINT "sku_spec_values_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "product_spec_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_spec_values" ADD CONSTRAINT "sku_spec_values_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_medias" ADD CONSTRAINT "product_medias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_medias" ADD CONSTRAINT "product_medias_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_medias" ADD CONSTRAINT "product_medias_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 部分唯一索引：软删除后 slug/code 不再占用唯一性。
--
-- 不能用 @@unique 表达：带 deletedAt 的复合唯一无效（PostgreSQL 的 NULL
-- 不参与唯一性判定），只能靠带 WHERE 条件的部分唯一索引。
--
-- 表名带双引号，与 Prisma 生成的迁移保持一致（阶段 1 的迁移就是这么写的）。
CREATE UNIQUE INDEX "categories_tenant_slug_uniq"
  ON "categories" ("tenantId", "slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "products_tenant_slug_uniq"
  ON "products" ("tenantId", "slug") WHERE "deletedAt" IS NULL;

-- 规格维度与规格值同样走软删除，普通 @@unique 会让「删掉「颜色」再加一个同名」
-- 直接被数据库拒绝。
CREATE UNIQUE INDEX "product_specs_product_name_uniq"
  ON "product_specs" ("productId", "name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "product_spec_values_spec_value_uniq"
  ON "product_spec_values" ("specId", "value") WHERE "deletedAt" IS NULL;

-- 商家编码大小写不敏感：填 T-Shirt 与 t-shirt 算同一个编码。
-- 与阶段 1 的 users_email_ci_key 同样的处理方式。
-- code 可空，NULL 不参与唯一性判定，所以额外排除 NULL。
CREATE UNIQUE INDEX "skus_tenant_code_uniq"
  ON "skus" (LOWER("code"), "tenantId")
  WHERE "deletedAt" IS NULL AND "code" IS NOT NULL;

-- 商品名称的模糊搜索索引。
-- pg_trgm 的 GIN 索引 Prisma schema 表达不了（@@index 只支持 B-tree），手写。
-- pg_trgm：商品名称的模糊搜索。GIN 索引 Prisma schema 表达不了（@@index
-- 只支持 B-tree），所以扩展与索引都要手写。
--
-- ⚠️ 创建扩展需要超级用户或数据库所有者权限。托管数据库（RDS / Cloud SQL）
-- 上应用用户往往不是 owner，这条会 permission denied 而让整个部署失败。
-- 本项目 compose 已把它提前到建库阶段（infra/postgres/init-extensions.sql，
-- 以超级用户执行）；真实部署需要 DBA 先手工装好 pg_trgm。
-- 这条语句是 IF NOT EXISTS 的幂等语句，已装的环境不会重复执行。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_name_trgm" ON "products" USING GIN ("name" gin_trgm_ops);

-- 公开列表按状态 + 时间筛选排序
CREATE INDEX "products_tenant_status_published_idx"
  ON "products" ("tenantId", "status", "publishedAt" DESC)
  WHERE "deletedAt" IS NULL;

