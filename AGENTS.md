# AGENTS.md

多租户电商 SaaS 单仓：NestJS API + 三个**互不共享代码**的 Next.js 15 应用 + Docker/Nginx。
本文件只记录「看文件名和框架文档看不出来、但一踩就错」的事。

## 布局与入口

| 目录 | 说明 | 端口 |
|------|------|------|
| `api/` | NestJS 11 + Prisma 6 + PostgreSQL 16；全局前缀 `/api/v1`，Swagger 在 `/api/docs` | 3000 |
| `storefront/` | 消费者店铺前台（按子域名区分店铺） | 3001 |
| `merchant-admin/` | 商家后台（中心域名，无店铺子域名） | 3002 |
| `platform-admin/` | 平台超管后台 | 3003 |
| `infra/` | compose 全栈 + Nginx（:80）；网关按 Host 路由并注入 `X-Tenant-Subdomain` | 80 |

- **根目录没有 `package.json`，也没有 workspaces**。依赖必须在各子目录里分别 `npm install`，lockfile 也是各子目录各一份。
- 本机标准端口被占用，固定使用：PostgreSQL **15432**、Redis **16380**、MinIO **19000**（控制台 19001）。
- 远端 `main` 是 squash 版，与本地完整历史必然分叉，`git push` 会被拒；`tools/push-via-api.mjs` 可绕开
  smart-HTTP（本机 `github.com:443` 也常不可达）：
  `GH_TOKEN=$(gh auth token) node tools/push-via-api.mjs <本地分支> <远端分支>`。
  分支落后远端时按 `CLAUDE.md` 的「fetch → 核对 diff → `reset --soft origin/main` → 重新提交」处理，
  **不要 `git pull`**（会产生无意义的合并）。

## 先读什么

- `docs/superpowers/specs/*-design.md` + `docs/superpowers/plans/*.md` 才是真实设计与计划；
  最近一次已完成的是 **5m 渠道对账**（2026-10-31）。新阶段按「design → plan（勾选式 Task）→ 代码 → acceptance 记录」推进。
- **plan 开头通常有 §0 / 零 的「全局约定 / 动手前必须知道」**（标题不统一，以实际文件为准）
  优先于直觉，里面有失败注入、定向 lint、迁移手写等纪律。
- 进度与测试状态以 `docs/superpowers/plans/` 下最新的 `*-acceptance.md` 和实际配置为准；根 `README.md` 与各子
  README 可能滞后，`package.json` / `vitest.config.ts` 比 README 里的测试描述更可靠。
- 仓库另有 `CLAUDE.md`（Claude Code 版同类指南）；改项目约定、命令或前置条件时两边同步，避免漂移。

## 命令

```bash
# 起后端依赖（本机开发）；e2e 的媒体套件会真实上传，必须带 minio
# --wait 等健康检查通过，避免下一条 CREATE DATABASE 抢在 postgres 就绪前执行
cd infra && docker compose up -d --wait postgres redis minio

# 仅首次：compose 只建开发库，测试库要手动建（已存在会报 already exists，可忽略）
docker exec -i ecommerce-postgres psql -U ecommerce -d postgres \
  -c "CREATE DATABASE ecommerce_test;"

# api（.env 已存在时不要覆盖，里面有本机 DATABASE_URL_TEST 等配置）
cd api && npm install && { [ -f .env ] || cp .env.example .env; }
npm run prisma:deploy && npm run prisma:seed   # 首次
npm run start:dev

# 三个前端各开一个终端（同样只在 .env 不存在时复制）
cd storefront     && npm install && ([ -f .env ] || cp .env.example .env) && npm run dev   # 3001
cd merchant-admin && npm install && ([ -f .env ] || cp .env.example .env) && npm run dev   # 3002
cd platform-admin && npm install && ([ -f .env ] || cp .env.example .env) && npm run dev   # 3003

# 全栈容器
cd infra && docker compose up -d --build
```

### 测试 / 校验

| 目的 | 命令 |
|------|------|
| api 单测（会先把迁移跑到测试库） | `cd api && npm test` |
| api 单测（跳过迁移） | `cd api && npx jest --passWithNoTests` |
| api 单个单测 | `cd api && npx jest src/modules/billing/settlement.service.spec.ts` |
| api e2e 全量 | `cd api && npm run test:e2e` |
| api e2e 覆盖率 | `cd api && npm run test:cov:e2e` |
| api 单个 e2e | `cd api && npx jest --config test/jest-e2e.json --runInBand test/payment.e2e-spec.ts` |
| api 类型检查 | `cd api && npx tsc --noEmit`（**没有 typecheck script**） |
| 前端单测 / 单个用例 | `cd <app> && npm test`；单个用例：`cd <app> && npx vitest run test/lib/api-client.test.ts` |
| 前端类型检查 | `cd <app> && npx tsc --noEmit` |
| 前端构建 / lint | `cd <app> && npm run build` / `npm run lint` |

- 后端用 **Jest 30**（单测 `api/src/**/*.spec.ts`，e2e `api/test/**/*.e2e-spec.ts`）；前端用 **Vitest 3**。不要混用 runner。
- e2e 在进程内 `Test.createTestingModule(AppModule)` 启动，**不需要另起 api 服务**，但需要测试库、Redis 和 MinIO
  可用（媒体 e2e 会真实 PUT 到 `localhost:19000`）。
- e2e **必须串行**（`test:e2e` / `test:cov:e2e` 均已带 `--runInBand`）：所有文件共享同一个测试库和 Redis 队列，
  并行会互相污染。
- `globalSetup` 每轮只清一次库/队列；文件之间不清理。涉及全局数据的 spec 要自己 reset fixture
  （参考 `api/test/payout-fixture.ts` 的 `resetPayoutData()`）。造商家用 `api/test/merchant-fixture.ts` 的 `createMerchant()` / `unique()`。
- 前端测试放在**顶层 `test/`**（`src/` 之外），避免被 `next build` 编译。Route Handler 测试直接 import 并传 `new Request(...)`，
  一般不需要 jsdom；组件测试在文件头用 `// @vitest-environment jsdom` 逐文件切换。
- `vitest.config.ts` 里两处**不要删**：根级 `esbuild: { jsx: 'automatic' }`（否则组件测试报 `React is not defined`），
  以及 `'server-only'` 的空模块 alias（否则 next-auth 在 node 环境 import 就炸）。`globals: false`，RTL 的 cleanup 在 `test/setup.ts` 手动注册。

## 环境与数据安全

- 所有后端测试读 `api/.env` 的 **`DATABASE_URL_TEST`**（开发库是 `DATABASE_URL`）。e2e 的 globalSetup 会对它
  `migrate deploy` → **truncate 所有业务表** → 清 `bull-e2e:*` Redis key → seed。**指错库就是数据灾难。**
- `ecommerce_test` 不会由 compose 自动创建；新环境先执行上面的 `CREATE DATABASE`，否则首次 `npm test`
  会在 `migrate deploy` 报 P1003（database does not exist）。
- e2e 使用 `BULLMQ_PREFIX=bull-e2e` 与开发队列隔离；**不要删 `bull:*`**。历史结论：跑 e2e 不需要停 api 容器。
- 手工验收假支付/假出款网关时，api 必须用 `NODE_ENV=development` 跑。compose 默认 `NODE_ENV=production`；
  在 production 下打开 `FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED` 会被 `assertSecureConfig`
  **拒绝启动**（两个开关默认关闭时，compose 的 api 能正常启动）。
- 假出款网关的渠道流水只存在**进程内存**，重启容器即丢；不要用它造跨重启的验收数据。
- `infra/docker-compose.yml` 里的 `JWT_SECRET` / `AUTH_SECRET` 是明文固定值，仅供本机开发。

## 不可违反的约定

- **租户隔离靠 Prisma extension**（`api/src/common/tenant/`）。新增带 `tenantId` 的模型必须登记到
  `tenant-models.ts`；启动时会扫 schema，漏登记直接启动失败。
- 租户作用域模型上 **`findUnique` / `findUniqueOrThrow` / `update` / `delete` / `upsert` 会被拒绝**
  （唯一条件无法可靠附加 tenantId）。改用 `findFirst` / `updateMany` / `deleteMany` 等。
  软删模型（Product / Sku / Category / Media / Address 等）上 `delete` / `deleteMany` 也会被拒，
  改用 `updateMany` 写 `deletedAt`；禁止用 `updateMany` 把 `deletedAt` 置回 `null` 来复活记录。
- **`tenantContext.run(...)` 的回调必须是 `async` 函数**。Prisma 6 返回 thenable，同步回调会让
  AsyncLocalStorage 在 SQL 执行时丢上下文 → 隔离**静默失效**，不报错。
- 跨租户读一律 `tenantContext.run(platformScope(), ...)`；队列/定时任务没有上下文，必须用 `runForTenant()` 显式重建。
- **`modules/billing` 绝对不能 import `modules/payment`**：会形成 `order → billing → payment → order` 的循环依赖，
  NestJS 启动直接报错。依赖方向只能是 `order → billing`、`payment → billing`；渠道契约放 `common/payment/`（`@Global`）。
- **子域名不是凭证**：匿名请求的租户来自网关注入的 `X-Tenant-Subdomain` 或 Host，客户端可伪造；
  访问控制只能靠认证与 RBAC。商家/平台后台登录**不带** `x-tenant-subdomain`，storefront 带。
  登录 `scope` 必须与入口一致：`MERCHANT` / `CUSTOMER` / `PLATFORM`，写错只会得到「密码错误」。
- **前端不直连后端**：api 没开 CORS。浏览器写操作一律走同源 `app/api/**/route.ts` 中转；中转路由用服务端
  session 里的 accessToken 调后端，并**重建请求体白名单**（未知字段丢弃；如 `products/batch` 的 ids 上限 200），
  不要把 body 原样透传。
- 客户端组件不能调 `auth()` / `apiFetchAuthed`（只能在服务端请求作用域调用）；客户端用 `signIn` / `signOut`。
- **金额一律整数分**（`merchant_receipts.amount` 带符号，退款为负，求和不要取绝对值）；只在展示层用
  `lib/money.ts` 的 `centsToYuan` / `yuanToCents` 换算。`yuanToCents` 只接受最多两位小数，非法输入返回 `null`。
- **新增代码落库时刻用 `prisma.databaseNow()`，不要用 `new Date()`**（假网关进程内的 `executedAt` 除外）。
  `order` / `payment` / `auth` 里仍有 `new Date()` 写库的遗留，不要照抄，也不要顺手改。
- 订单状态流转必须用**条件更新**（把 `from` 状态放进 `updateMany.where`，按受影响行数判定赢家）；
  改状态与动库存必须**同一个事务**。库存流水三种：`RESERVE` / `RELEASE` / `DEDUCT`（支付成功不动库存）。
- 文案、注释、测试名、commit message 一律**简体中文**；commit 用中文 conventional commits
  （`feat(api): ...` / `fix(front): ...`）。计划约定在当前分支 `gzt/电商项目` 直接提交，docs 改动单独 commit；
  开 PR 前注意远端 `main` 是 squash 版，按上文的 `reset --soft origin/main` 流程处理分叉。

## 数据库迁移

- **`prisma migrate dev` 在本仓不可用**：多个历史迁移 checksum 不符，会要求 `migrate reset`（清库）。
  一律**手写 `migration.sql`**，用 `npx prisma migrate diff` 核对，再 `npx prisma migrate deploy`。
- 已落库的迁移**不要改**（checksum 会变）；要补东西就新增迁移文件。`20261022071848_add_sku_stock_version`
  在全新库上整条跳过是**故意的**，不要「修」它。
- 已应用旧版迁移的库若报 `migration have been modified`，按 `api/prisma/fix-legacy-migration-checksum.sql`
  的说明处理；**只在真报这个错时执行**。
- 改完 `schema.prisma` 要 `npx prisma generate`；开发库跑 `npm run prisma:deploy`，种子 `npm run prisma:seed`。
- 商品搜索依赖 `pg_trgm`；托管数据库（RDS/Cloud SQL）上应用用户通常无权 `CREATE EXTENSION`，部署前让 DBA 先装。

## lint 与验证纪律

- **不要把 api 的全量 `npm run lint` 当验收闸**：仓库本来就有 8–9 处既有 prettier 报错
  （`settlement.service.spec.ts`、`payout-worker.spec.ts`、`settlement.e2e-spec.ts` 等）。只对本次改动文件跑
  `npx eslint <file>`，要求**新增文件零错误、不顺手修无关文件**。
- **失败注入必须独占**：故意改坏源码验证测试时，不要同时跑任何其他测试（会互相污染，产生假回归）。
- 三个前端没有共享包。同名文件靠「写一份 → `cp` → `diff`」保持一致：`components/ui/button.tsx` 三份逐字节相同，
  `lib/jwt-callback.ts` 在 storefront / merchant-admin 两份逐字节相同。但三份 `lib/api-client.ts` **结构不同，
  不要强行统一**，只保证语义一致。
- 前端测试断言要具体：401 要同时断言没调后端；400 要断言错误文案；白名单要 `toEqual` 完整 body，
  不能只断言「不含某字段」。`vi.mock` 的路径必须与被测文件的 import 完全一致（`@/auth`、`@/lib/api-client`）。
