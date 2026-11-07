# AGENTS.md

多租户电商 SaaS 单仓：NestJS API + 三个 Next.js 15 应用 + Docker/Nginx。
三个前端从阶段 7c 起共用 `packages/frontend-shared`（`@ecom/frontend-shared`），
但**不是 npm workspaces**——各端仍各自 `npm install`。
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
- **`packages/frontend-shared` 是 `file:` 依赖**（三端 package.json 里 `"file:../packages/frontend-shared"`）：
  它的依赖要**单独 `npm install`**——npm 的 `file:` 链接不会把被链接包自身的依赖装进端的
  `node_modules`，不装就会在构建/测试时报 `zod` / `react` 解析不到。CI 三个前端 job 都有这一步。
  三端各有一份薄壳 `src/lib/*.ts` 只做 `export * from '@ecom/frontend-shared/...'`，
  **逻辑改动写共享包，不要写薄壳**。
- 本机标准端口被占用，固定使用：PostgreSQL **15432**、Redis **16380**、MinIO **19000**（控制台 19001）。
- `tools/push-via-api.mjs`：本机 `github.com:443` 常不可达，`git push` 超时时改用
  `GH_TOKEN=$(gh auth token) node tools/push-via-api.mjs <本地分支> <远端分支>`。
  ⚠️ **但中文分支名（如 `gzt/电商项目`）会让它失败** —— 脚本用
  `gh api --method POST ... --input -` 传 body，`gh` 的参数编码对中文分支名出错
  （报 422 / 打印字节数组）。**带中文分支名时改用 `tools/push-via-api-curl.mjs`**
  （curl 直连 API，JSON body 与 URL 都按 UTF-8 原样传）。
  ⚠️ **父提交必须是远端已存在的 SHA** —— 本地 `main` 往往比 `origin/main` 多几个
  提交，用本地 SHA 当父会报 422 `Parent SHA does not exist`。用
  `BASE_COMMIT=$(gh api repos/<repo>/commits/main --jq .sha)`。

## 先读什么

- `docs/superpowers/specs/*-design.md` + `docs/superpowers/plans/*.md` 才是真实设计与计划；
  最近一次已完成的是 **阶段 9「历史技术债清理」**（2026-11-04，
  设计见 `docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md`，
  验收见 `docs/superpowers/plans/2026-11-04-plan-09-acceptance.md`）。
  新阶段按「design → plan（勾选式 Task）→ 代码 → acceptance 记录」推进。
- **每个 plan 开头的 §0「全局约定 / 动手前必须知道」优先于直觉**，里面有失败注入、定向 lint、迁移手写等纪律。
- `README.md` 已随阶段 9 收尾更新（进度、测试条数、共享包说明、技术债）；但**数字会随提交漂移**，
  以 `git log`、最新 plan/acceptance、`package.json`、`vitest.config.ts` 为准。

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

# 共享包（三个前端都依赖它，必须先装它自己的依赖）
cd packages/frontend-shared && npm install

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
  **拒绝启动**。⚠️ 但**开关关着也起不来**：compose 自带 production 姿态 + 占位密钥/默认 DB 密码，
  阶段 9 的凭据校验同样拒绝 → 用假网关联调只能走本机 `npm run start:dev`（见 README「全栈容器」）。
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
  session 里的 accessToken 调后端，并**重建请求体白名单**（未知字段丢弃，批量 ids 上限 200），不要把 body 原样透传。
- 客户端组件不能调 `auth()` / `apiFetchAuthed`（只能在服务端请求作用域调用）；客户端用 `signIn` / `signOut`。
- **金额一律整数分**（`merchant_receipts.amount` 带符号，退款为负，求和不要取绝对值）；只在展示层用
  `lib/money.ts` 的 `centsToYuan` / `yuanToCents` 换算。`yuanToCents` 只接受最多两位小数，非法输入返回 `null`。
- **落库时刻用 `prisma.databaseNow()`，不要用 `new Date()`**；唯一例外是假网关进程内的 `executedAt`。
- 订单状态流转必须用**条件更新**（把 `from` 状态放进 `updateMany.where`，按受影响行数判定赢家）；
  改状态与动库存必须**同一个事务**。库存流水三种：`RESERVE` / `RELEASE` / `DEDUCT`（支付成功不动库存）。
- **事务回调内不许借第二条连接**（阶段 10）：`$transaction(async (tx) => ...)` 会**独占一条连接**
  直到回调返回，回调内（含**经方法转调**）再用 `this.prisma` 就得**再借一条** → 连接池小时
  （GitHub 2 核 runner 上 Prisma 默认池 = CPU×2+1 = 5）并发写路径互相等死，
  先报 `P2024`，外层事务随后超时报 `P2028`。
  改法：方法接受**可选客户端参数**（`client: PrismaTransaction | TenantPrismaService = this.prisma`），
  事务内显式传 `tx`；事务外的既有调用点不用改。
  ⚠️ **Prisma 6 的租户扩展会应用到事务客户端** —— `tx` 上照样按上下文解析作用域，
  平台作用域（`tenantContext.run(platformScope(), ...)`）在 tx 上同样生效，
  所以「平台券查询必须留在事务外」是**错的**（`coupon.service.ts` 的 `findClaimableCoupon` 早就在用 tx 查平台券）。
  护栏：`api/src/common/db/tx-boundary-scanner.spec.ts` 扫全仓，新增违规即 CI 红；
  `cd api && npm run scan:tx-boundary` 看当前清单。豁免必须写明理由（`tx-boundary-exemptions.ts`），
  锚点用「文件 + 方法名 + 表达式」，**不用行号**（会漂移）。
- 文案、注释、测试名、commit message 一律**简体中文**；commit 用中文 conventional commits
  （`feat(api): ...` / `fix(front): ...`）。计划约定在当前分支 `gzt/电商项目` 直接提交，docs 改动单独 commit。

## 新渠道准入

- **任何新渠道（支付或出款）必须先通过共享契约套件**：`api/test/channel-contract/` 下的
  `runPaymentProviderContract` / `runPayoutProviderContract`。在 spec 里对新实现再调一次即可，
  `fake` / `fake-payout` / `sandbox` 就是样板；契约不过 = 不允许接入。
- 契约测试走**默认 `npm test`**（jest 的 `roots` 含 `src` 与 `test/channel-contract`），不归 e2e 配置管。
- **不要改 provider 来迁就契约**：契约要能抓出真实缺陷。确实不适用的单条用 `it.skip` 并写明原因
  （例如支付「退款金额与支付金额不一致 → 拒绝」在渠道层不适用：`refund` 不带原支付金额）。
- 异步用例在同步渠道上必须 `it.skip` 并注明「能力声明为同步，`submit` / `refund` 即终态」——
  支付用 `supportsAsyncRefund`、出款用 `supportsAsync` 开关控制，不要删用例。
- 失败注入（明确拒付 / 处理中 / 结果未知）由各渠道的 spec 提供钩子：支付 `fake` 用
  `armRefundScenario`、`sandbox` 用 mock 服务的 `setRefundScenario`；出款 `fake` 用 `armScenario`、
  `sandbox` 用 `setScenario`。

## 渠道配置与默认渠道（阶段 6）

- **渠道名单只有一处事实来源**：`api/src/common/channel/channel-config.ts` 的
  `DEV_DEFAULT_CHANNELS`（非生产默认值）与 `DEV_ONLY_CHANNELS`（仅非生产的渠道）。
  启动校验（`assert-secure-config`）、注册表、`PlatformSettingService` 都读它 —— **别在别处再抄一份**。
- **支付与出款的假网关渠道名不同**：支付是 `fake`，出款是 `fake-payout`。两个独立实现、
  两个独立开关（`FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED`），写成一个名字会让人以为开一个就开了两个。
- **`sandbox` 只在开发环境可见**：生产环境不要写进 `PAYMENT_ENABLED_CHANNELS` / `PAYOUT_ENABLED_CHANNELS`
  （`assertSecureConfig` 直接拒绝启动），`list()` 也不会返回它。
- **默认出款渠道解析**：单子上已有的 `payoutChannel`（重试不换渠道）→ 商家 `preferredChannel`
  → 平台默认渠道（`platform_settings` 的 `payout.platformDefaultChannel`，超管后台 `/settings`）
  → 都没有则 **fail-closed**（不回落 env、不猜）。商家配了就**不再读平台默认值**。
  `PAYOUT_PLATFORM_DEFAULT_CHANNEL` 只是 DB 没有这行时的兜底。
- ⚠️ **渠道在「审批时」锁定**（不是执行时）：`PayoutService.approve()` 解析渠道并写进
  `payouts.payoutChannel`（与状态改 `APPROVED` 同一个 `updateMany`）。
  审批之后改商家偏好或平台默认，**已审批的单一律走审批时锁定的渠道**；
  渠道已停用 / 平台未配置 → **409 且不审批**（不产出打不出钱的单）。
  执行路径（`claimForExecution`）只在**存量单**（`payoutChannel` 为 null）时才兜底解析。
- ⚠️ **手动对账是异步入队**：`POST /platform/payout-reconciliations` 只建任务行并投
  `'reconcile-run'` job，主体在 `PayoutWorker` 里跑（`executeReconciliation`）。
  **接口立刻返回「已入队」，`diffCount` 恒为 0** —— 差异数要等跑完，在任务详情里看。
  理由：总预算可达 630 秒，同步执行会被网关 60 秒超时砍掉，而后台还在跑 →
  运营以为失败、连点几次。定时对账（`'reconcile'` job）**直接执行**，不再二次入队。
- **假出款网关的剧本接口语义**：`POST /api/v1/pay/fake-payout/fail-next` 的 `times` 是
  **渠道明确拒付**（`definitive: true`，可安全重试，用完重试预算后落 `FAILED` +
  `failedBeforePayout = true`）；**结果未知**用 `unknownTimes`（`definitive: false`，
  一次就落 `FAILED`、**绝不自动重试**）。写错这一个字段会造出「重复打款」或「永远不重试」两种假数据。
- **异步契约的语义边界**：`PROCESSING` 既不是成功也不是失败；`definitive: false` 的失败
  一律只告警、不自动重试（重复打款/退款的风险优先）。退款只有渠道确认成功才落 `REFUNDED`。
- **CSV 来源的 A 类差异不自动改成 `PAID`**（设计上就是人工闸）：落 `PENDING` 人工项，
  批量确认按 `IDS`（≤200）/ `FILTER`（游标分批，每批 ≤200）逐条复核，允许部分成功。
  改这个闸之前先读 `payout-reconciliation-resolver.service.ts` 顶部注释。

## 数据库迁移

- **`prisma migrate dev` 在本仓不可用**：多个历史迁移 checksum 不符，会要求 `migrate reset`（清库）。
  一律**手写 `migration.sql`**，用 `npx prisma migrate diff` 核对，再 `npx prisma migrate deploy`。
- 已落库的迁移**不要改**（checksum 会变）；要补东西就新增迁移文件。`20261022071848_add_sku_stock_version`
  在全新库上整条跳过是**故意的**，不要「修」它。
- 已应用旧版迁移的库若报 `migration have been modified`，在 `api/` 下执行
  `npm run db:fix-legacy-checksum`；**只在真报这个错时执行**，执行前先备份。
- 改完 `schema.prisma` 要 `npx prisma generate`；开发库跑 `npm run prisma:deploy`，种子 `npm run prisma:seed`。
- 商品搜索依赖 `pg_trgm`；托管数据库（RDS/Cloud SQL）上应用用户通常无权 `CREATE EXTENSION`，部署前让 DBA 先装。

## lint 与验证纪律

- **api lint 已归零**（阶段 8c），但全量 lint 仍耗时；日常只对改动文件跑
  `npx eslint <file>`，要求零错误。CI 的 api job 跑全量 lint 作为门禁。
- **三个前端 lint 已进 CI**（阶段 9），本地提交前建议跑 `npm run lint`。
- **失败注入必须独占**：故意改坏源码验证测试时，不要同时跑任何其他测试（会互相污染，产生假回归）。
- 三个前端共用 `packages/frontend-shared`（`file:` 依赖，**不是 npm workspaces**，各端仍各自 `npm install`）。
  未迁进共享包的同名文件靠「写一份 → `cp` → `diff`」保持一致：`components/ui/button.tsx` 三份逐字节相同。
  `lib/jwt-callback.ts` 三端各只有一句 `export *`（薄壳），逻辑**单源在共享包**，不要按老办法手工同步。
  但三份 `lib/api-client.ts` **结构不同，不要强行统一**，只保证语义一致。
- 前端测试断言要具体：401 要同时断言没调后端；400 要断言错误文案；白名单要 `toEqual` 完整 body，
  不能只断言「不含某字段」。`vi.mock` 的路径必须与被测文件的 import 完全一致（`@/auth`、`@/lib/api-client`）。
