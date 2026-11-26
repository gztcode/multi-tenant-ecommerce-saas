# 数据库与迁移

数据模型在 `api/prisma/schema.prisma`；迁移文件在 `api/prisma/migrations/`。
表结构相关的硬性约定在仓库根 [`AGENTS.md`](../AGENTS.md) 有完整说明。

## 数据模型约定

- **金额一律整数分**：`merchant_receipts.amount` 带符号，退款为负，求和不要取绝对值；
  只在展示层用前端 `lib/money.ts` 的 `centsToYuan` / `yuanToCents` 换算。
  `yuanToCents` 只接受最多两位小数，非法输入返回 `null`。
- **落库时刻用 `prisma.databaseNow()`，不要用 `new Date()`**；唯一例外是假网关进程内的
  `executedAt`。
- **新增带 `tenantId` 的模型必须登记到 `api/src/common/tenant/tenant-models.ts`**：
  启动时会扫 schema，漏登记直接启动失败（租户隔离靠 Prisma extension 自动附加条件）。
- **租户作用域模型上 `findUnique` / `findUniqueOrThrow` / `update` / `delete` / `upsert`
  会被拒绝**（唯一条件无法可靠附加 tenantId），改用 `findFirst` / `updateMany` /
  `deleteMany` 等。软删模型（Product / Sku / Category / Media / Address 等）上
  `delete` / `deleteMany` 也会被拒，改用 `updateMany` 写 `deletedAt`；
  禁止用 `updateMany` 把 `deletedAt` 置回 `null` 来复活记录。
- **订单状态流转必须用条件更新**，且改状态与动库存必须**同一个事务**；
  库存流水三种：`RESERVE` / `RELEASE` / `DEDUCT`（支付成功不动库存）。
- **事务回调内不许借第二条连接**（阶段 10）：`$transaction(async (tx) => ...)` 会独占一条
  连接直到回调返回，回调内（含经方法转调）再用 `this.prisma` 就得再借一条 →
  连接池小时并发写路径互相等死，先报 `P2024`，外层事务随后超时报 `P2028`。
  改法：方法接受可选客户端参数
  （`client: PrismaTransaction | TenantPrismaService = this.prisma`），事务内显式传 `tx`。
  护栏：`api/src/common/db/tx-boundary-scanner.spec.ts` 扫全仓，
  `cd api && npm run scan:tx-boundary` 看当前清单；
  设计见[阶段 10 设计](requirements/archive/specs/2026-11-04-plan-10-tx-boundary-design.md)。

## 数据库迁移

```bash
cd api && npm run prisma:deploy
```

⚠️ **`prisma migrate dev` 在本仓不可用**：多个历史迁移 checksum 不符，会要求
`migrate reset`（清库）。一律**手写 `migration.sql`**，用 `npx prisma migrate diff` 核对，
再 `npx prisma migrate deploy`。已落库的迁移**不要改**（checksum 会变）；要补东西就新增
迁移文件。`20261022071848_add_sku_stock_version` 在全新库上整条跳过是**故意的**，
不要「修」它。已应用旧版迁移的库若报 `migration have been modified`，在 `api/` 下执行
`npm run db:fix-legacy-checksum`；**只在真报这个错时执行**，执行前先备份。

改完 `schema.prisma` 要 `npx prisma generate`。

⚠️ **托管数据库上需要 DBA 先装 `pg_trgm` 扩展。** 商品搜索依赖它，
而 `CREATE EXTENSION` 需要超级用户或数据库所有者权限——RDS / Cloud SQL
这类平台上应用用户通常不是 owner，迁移会 `permission denied` 而失败。

本项目的 `docker compose` 不受影响：扩展在 `infra/postgres/init-extensions.sql`
里于建库阶段（超级用户身份）装好。真实部署请让 DBA 先执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 测试库

`ecommerce_test` 不会由 compose 自动创建，新环境先手动建：

```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d postgres \
  -c "CREATE DATABASE ecommerce_test;"
```

否则首次 `npm test` 会在 `migrate deploy` 报 P1003（database does not exist）。
**所有后端测试读 `api/.env` 的 `DATABASE_URL_TEST`**（开发库是 `DATABASE_URL`），
e2e 的 globalSetup 会对它 `migrate deploy` → truncate 所有业务表 → 清
`bull-e2e:*` Redis key → seed。**指错库就是数据灾难。**

## 数据备份与恢复

```bash
cd infra && ./backup.sh    # PostgreSQL 全量 + MinIO 数据卷 + Redis 数据卷 → infra/backups/<时间戳>/
```

定时备份见 `infra/crontab.example`。恢复前先确认目标：

```bash
cd infra
./restore.sh postgres ./backups/<时间戳>/postgres-ecommerce.sql.gz   # 先看计划，不执行
./restore.sh postgres ./backups/<时间戳>/postgres-ecommerce.sql.gz --yes
./restore.sh minio    ./backups/<时间戳>/minio-data.tgz --yes
./restore.sh redis    ./backups/<时间戳>/redis-data.tgz --yes
```

`infra/backups/` 已加入 `.gitignore`。
