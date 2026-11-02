# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

多租户电商 SaaS 平台：一个实例服务多个商家，每个商家有自己的店铺、商品、订单与客户。
后端 NestJS 11 + Prisma 6 + PostgreSQL 16，三个 Next.js 15 前端（消费者前台 / 商家后台 / 平台超管后台）。

**当前进度：阶段 5m「渠道对账」已完成并验收。**（根 `README.md` 停留在阶段 5c，已过时——以
`docs/superpowers/plans/` 下最新的 `*-acceptance.md` 为准。）

---

## 一、常用命令

### 后端（`api/`）

```bash
npm run start:dev          # 监听 3000
npm run build              # nest build
npm run lint               # eslint "{src,apps,libs,test}/**/*.ts"
npm run format             # prettier --write

npm test                   # 单元测试（先跑 test/deploy-test-db.mjs 应用迁移到测试库）
npm run test:e2e           # 端到端（已是 --runInBand）
npm run test:cov:e2e       # e2e + 覆盖率

npm run prisma:generate    # 生成 Prisma Client
npm run prisma:deploy      # 应用迁移（prisma migrate deploy）
npm run prisma:migrate     # ⚠️ 本仓不可用：历史迁移 checksum 不符会要求 migrate reset；新迁移手写 migration.sql
npm run prisma:seed        # 造超管 + 示例店铺 + 示例账号

npm run backfill:ledger    # 回填抽佣流水（scripts/backfill-commission-entries.ts）
npm run check:ledger       # 校验账目一致性（scripts/check-ledger.ts）
npm run migrate:payout-encryption   # 出款账户密文迁移
```

**跑单个测试文件：**

```bash
# 后端单测（jest rootDir 是 src/）
npx jest src/modules/order/order-status.spec.ts
npx jest -t "canTransition"            # 按用例名过滤

# 后端 e2e
npx jest --config ./test/jest-e2e.json --runInBand test/payout.e2e-spec.ts
npx jest --config ./test/jest-e2e.json --runInBand -t "对账"

# 前端（Vitest）
cd storefront && npx vitest run test/lib/jwt-callback.test.ts
cd platform-admin && npx vitest run test/app/reports-page.test.tsx
```

> ⚠️ **e2e 必须串行**（`--runInBand`）——共享同一个测试库 `ecommerce_test` 与 Redis 队列，并行会互相干扰。
> ⚠️ **跑 e2e 不需要停 api 容器**：队列前缀隔离（`BULLMQ_PREFIX=bull-e2e`）+ 每轮清库已实现。
> ⚠️ 后端有 9 处**既有**的 prettier 报错，三个前端各有 2 处**既有**的 eslint warning
> （都与最近的阶段无关）。跑全量 lint 会让人去「顺手修」无关文件——
> 改动的范围要能追溯到本次需求。

### 前端（`storefront/` `merchant-admin/` `platform-admin/`）

```bash
npm run dev      # 分别在 3001 / 3002 / 3003
npx tsc --noEmit && npm run lint && npm run build
npm test         # vitest run
npm run test:watch
```

三个前端的脚本完全一致，**没有** `typecheck` / `test:coverage` 之类的额外脚本。

### 一键启动

```bash
cd infra && docker compose up -d     # postgres / redis / minio / api / 三个前端 / nginx
```

本机标准端口被其他项目占用，本项目固定用：PostgreSQL **15432**、Redis **16380**、MinIO **19000**。
子域名调试需把 `127.0.0.1 *.platform.test` 写进 `/etc/hosts`。

---

## 二、架构要点

### 2.1 多租户隔离：客户端层强制，不是靠记得传 tenantId

隔离由 Prisma query extension 实现（`api/src/common/tenant/tenant-prisma.service.ts`）。
业务代码**从不**手写 `tenantId` 条件：

- **读**（`findMany` / `findFirst` / `count` / `aggregate` / `groupBy`）：自动合并 `where.tenantId`。
- **写**（`create` / `createMany` / `updateMany`）：自动注入 `data.tenantId`。
- **禁止** `findUnique` / `findUniqueOrThrow` / `update` / `delete` / `upsert`——这些方法只接受唯一字段作
  `where`，无法附加租户条件，是跨租户越权通道。抛 `TenantScopeError`，替代写法见
  `RECOMMENDED_REPLACEMENT`（`findUnique` → `findFirst`，`update` → `updateMany`，…）。
- **关系字段的嵌套写被拒绝**（`data: { tenant: { connect: … } }`），判定基于 `Prisma.dmmf` 的关系字段名，
  因此 Json 字段（如 `themeTokens`）下的任意结构放行。

三张**白名单表**在 `api/src/common/tenant/tenant-models.ts`，改 schema 前必须同步：

| 表 | 作用 | 改错的后果 |
|---|---|---|
| `TENANT_SCOPED_MODELS` | 哪些模型受隔离 | 漏登记 → `assertTenantScopedModelsRegistered()` **启动时硬失败**（`tenantId` 字段的模型漏登记即失败） |
| `SOFT_DELETE_MODELS` | 哪些模型走软删 | 漏登记 → 软删**完全失效**（查得到已删记录，也拦不住物理删除） |
| `UNIQUE_ONLY_OPERATIONS` | 禁止使用的方法 | — |

> ⚠️ **有些模型刻意不在白名单里**（`SettlementStatementEntry` / `PayoutEntry` / `PayoutOperation` /
> `PayoutReconciliation` / `PayoutReconciliationItem`）：它们**没有 `tenantId` 列**，是纯关联表或平台级数据。
> 登记了会让 Prisma 报错；不登记则**完全不受作用域约束**——查询前必须自行校验归属
> （如 `payoutId` 属于当前租户、`reconciliationId` 来自平台超管的权限检查之后）。
> `PayoutReconciliationItem.payoutId` 可空（D 类「渠道有、本地没有」），「按 payoutId 反查租户」这层安全网对它失效。

**租户上下文**（`tenant-context.ts`）由 `AsyncLocalStorage` 承载，由全局拦截器
`TenantContextInterceptor` 建立：

- 已认证请求 → 租户范围取自 JWT；
- 匿名请求 → 从子域名解析（`X-Tenant-Subdomain` 头优先，其次 Host 第一段）；解析不出 → 404。
- `tenantId === null && role === PLATFORM_ADMIN` 才是**平台作用域**（跨租户读），写操作必须显式指定 `tenantId`。

> ⚠️ **最关键的一条约束**：`tenantContext.run(...)` 的回调**必须是 async 函数**。
> Prisma 6 的 query 返回 PrismaPromise（thenable），SQL 在 `then()` 被调用时才执行；
> 同步回调会让 ALS 上下文在那一刻丢失，**隔离机制静默失效、不抛错**。
> 同样，`$transaction(async tx => …)` 回调内读上下文是安全的（ALS 沿 Promise 链传播）。

> ⚠️ **跨进程边界没有上下文**：队列消费者、定时任务必须用 `runForTenant(tenantId, fn)` 显式重建，
> 且 `tenantId` **必须来自可信源**（由后端签发，不能取客户端提交的内容）。

> ⚠️ **原生 SQL 不受隔离保护**：`TenantPrismaService` 刻意不暴露 `$queryRaw` / `$executeRaw`，
> 只留了一个 `databaseNow()`（查 `now()`，不涉及租户数据）。`order/inventory.service.ts` 里的
> `FOR UPDATE` 是唯一的例外——它**手写**了 `tenantId` 条件，且列名是 camelCase **必须加双引号**
> （`"tenantId"`；不加引号 PostgreSQL 会折叠成小写，报错信息完全看不出真实原因）。

### 2.2 订单状态机与并发

状态流转只有一张转移表：`api/src/modules/order/order-status.ts` 的 `ORDER_TRANSITIONS`。
**所有流转必须先问 `canTransition()`**——散落在各 service 里迟早有入口漏校验。

但 `canTransition()` 只管「合不合法」，**并发下两个请求都可能拿到 true**。真正的守卫是
条件更新：把 `from` 状态放进 `updateMany` 的 `where`，靠受影响行数判定赢家。

> ⚠️ **改状态与动库存必须在同一个事务里**。分成两个事务，释放失败时订单已是终态而库存没还回去，
> 那批库存永久卡在预占里。

状态机：`PENDING_PAYMENT → PAID / CANCELLED / CLOSED`，`PAID → SHIPPED / REFUNDED`，
`SHIPPED → COMPLETED / REFUNDED`，其余为终态。`REFUNDED` **不回补库存**（退的是钱不是货；
「退货入库」是另一套流程，从未实现）。

### 2.3 库存三段流水

`api/src/modules/order/inventory.service.ts`（下单链路，与 `modules/inventory/` 的管理端调整是两套）：

| 类型 | `quantity`（业务量） | `stock` 实际变化 | 触发时机 |
|---|---|---|---|
| `RESERVE` | `-qty` | `-= qty` | 下单 |
| `DEDUCT` | `-qty` | **不变** | 支付成功（预占转售出） |
| `RELEASE` | `+qty` | `+= qty` | 取消 / 超时 |

- **未冲抵预占量 = `-Σ(RESERVE) - Σ(RELEASE) + Σ(DEDUCT)`**。三个符号不能混：RESERVE 与 DEDUCT 同为负数
  但语义不同，一股脑相加会让 DEDUCT 被当成「增加预占」，售出后的货能再释放一次（凭空造货）。
- 释放与扣减**必须校验**「该订单在该 SKU 上尚未被冲抵的预占量」。
- **行锁而非乐观锁**：`SELECT ... FOR UPDATE`，按 id **排序后逐条加锁**（排序是死锁防护的全部；
  一条 `IN` 查询的加锁顺序由查询计划决定，不随列表顺序变化）。`stockVersion` 乐观锁保留给管理端
  人工调整，两者互为对称保护。
- 流水表是 **append-only 审计凭证**，既不软删也不允许物理删除。
- 销量**不要**从流水统计（RESERVE 与 DEDUCT 都是负数，会重复计数）——看 `order_items.quantity` 求和。

### 2.4 金额一律整数分

schema 里所有金额字段都是 `Int`（分），**全程不换算成元**。费率用 `commissionBps`（万分比）。
计算逻辑抽成**纯函数**放在 `*.ts` 里（`billing/ledger.ts`、`billing/commission.ts`、`billing/settlement.ts`、
`common/payment/payout-verification.ts`）——不碰数据库、不读上下文，
目的是让「计钱的每一条分支都能被完整断言」。

账目相关的两个易错点（已在 `ledger.ts` 的注释里详述）：

- **冲回是一行独立流水，不是一个负数字段**（`CommissionEntryType.REVERSAL`、`ReceiptType.SALE_REVERSAL`），
  单列求和即净额。
- **流水的符号与报表口径相反**：流水里冲回是负数，报表要的是正数（`netRevenue = 订阅 + 抽佣 − 冲回`），
  转换在 `toReportAmounts()` 里完成，符号传错时**直接抛错**而不是静默算错。

### 2.5 模块依赖：billing ⇄ payment 的环用下沉法绕过

```
order → billing → payment → order
```

`billing` **绝对不能 import `payment`**（成环，NestJS 启动直接报错）。
出款渠道与核实契约因此下沉到 `api/src/common/payment/`（**`common/` 下唯一持有 `@Module` 的目录**），
用 `@Global()` 的 `PayoutProvidersModule` 注册实现并导出。`billing` 只
`@Inject(PAYOUT_VERIFICATION)` 拿 token——依赖图上没有 `billing → payment` 的边，环被绕开。

`api/src/common/payment/README.md` 写了这条规则的完整理由，改那个目录前必读。
其中一条特别重要：**核实闸与打款 worker 必须查同一个渠道**——
`payout-verification.service.ts` 的 `pickProvider` 与 `payment/payout.worker.ts` 的 `firstProvider`
必须一起改，否则「钱打到 A 渠道、核实查 B 渠道」→ 核实问出「没打」→ **重复打款**。

### 2.6 认证与 RBAC

- 四种角色：`PLATFORM_ADMIN` / `MERCHANT_OWNER` / `MERCHANT_STAFF` / `CUSTOMER`。
- **RBAC 用 `@Roles()` 装饰器，不注册成 `APP_GUARD`**。NestJS 守卫顺序是
  `[...全局, ...类级, ...方法级]`，全局守卫会跑在 `JwtAuthGuard` 之前，那时 `request.user` 还没填。
  `@Roles()` 在**同一次** `UseGuards` 里显式排 `[JwtAuthGuard, RolesGuard]`，认证必然先于鉴权。
  没挂 `@Roles()` 的路由不受角色限制。
- **令牌轮换 + 60 秒宽限期**（阶段 5c，`modules/auth/token-grace.service.ts`）：
  旧刷新令牌在宽限期内被重复提交，返回**同一枚**新令牌且**不吊销令牌族**——
  解决了「商家同时开两个后台标签页被踢下线」。
  宽限记录存新令牌密文，需**定时清理**（只清列不删行，保留令牌族的审计线索）。
- **令牌刷新决策逻辑被抽成纯模块** `src/lib/jwt-callback.ts`（`storefront` 与 `merchant-admin` 各一份，
  逐行一致——改一份必须同步另一份），因为 `auth.ts` 顶层就调 `NextAuth({...})`，
  import 它就会初始化整个 next-auth 依赖图 → 测不了。
  `platform-admin` **没有**这个模块，它的 `jwt` / `session` 回调内联在 `auth.ts` 里（它不刷新令牌）。
- 生产环境启动自检：`assertSecureConfig()` / `assertPayoutEncryptionKey()` /
  `PayoutEncryptionSelfCheck` **都在 `listen()` 之前**执行——带着解不开的密文启动，
  运营看到的全是失败的出款单，没人知道根因是密钥配错了。

### 2.7 队列（BullMQ）

队列名在 `api/src/common/queue/queue.constants.ts`：
`PAYMENT_TIMEOUT_QUEUE`（支付超时释放预占）、`PAYMENT_WEBHOOK_QUEUE`（支付回调）、
`BILLING_QUEUE`（计费每日扫描：账单生成 + 自动扣款）、`AUTH_QUEUE`（令牌宽限清理）、
`COMPENSATION_QUEUE`（支付补偿扫描：未处理完的 webhook 事件 + 丢失的超时释放）、
`PAYOUT_QUEUE`（出款执行：审批后打款 + 卡死扫描 + 定时对账）。

- `QueueService` 只负责**入队**；连接由 `BullModule` 管。
- **BullMQ 默认 `attempts` 是 0**（一次都不重试）——本项目统一设 `attempts: 3` + 指数退避。
- 出款入队是**例外**：`attempts: 1`，重试由出款单自己的 `attemptCount` + 退避控制；
  两层重试叠在一起会绕过退避（`addWithOptions` 的存在理由）。
- 队列操作有 **3 秒超时**。BullMQ 覆盖了 ioredis 的 `retryStrategy` → 无限退避 → Redis 不可达时
  `queue.add()` 的 Promise **永远不 settle**，不设超时会让请求永远挂住。
- **周期任务用 `addRepeating`（`upsertJobScheduler`）**，固定 `jobSchedulerId` 去重，重复注册是覆盖不是叠加。
- `addRepeating` 在 `onModuleInit` 里调用 → **Redis 启动时不可达 = 进程启动失败**（有意为之：
  周期任务没注册意味着账目与令牌清理都不跑，不如快速失败）。
- **消费端仍要幂等**：任务可能在消费途中崩溃后被重新投递。幂等靠**条件更新**，不是唯一索引。

### 2.8 三个前端：同源中转路由

**前端不直连后端**：后端没开 CORS（设计上前后端同源，由 Nginx 反代），accessToken 不能进浏览器，
NextAuth 的 `auth()` 只能在服务端请求作用域里调用。所以：

```
客户端组件 ──fetch 同源 /api/**──▶ Next.js Route Handler ──Bearer token──▶ api:3000/api/v1/**
```

- 中转路由在各前端的 `src/app/api/**/route.ts`。公共辅助在 `src/lib/route-helpers.ts`
  （`readJson` / `toErrorResponse` / `unauthorizedResponse`），客户端封装在 `src/lib/api-client.ts`
  （`apiFetch` / `apiFetchAuthed` / `ApiError`）。
- **中转层必须「白名单重建」请求体，不能原样透传**（`ValidationPipe` 开了 `forbidNonWhitelisted`，
  多一个字段就是 400）。典型范本：`merchant-admin/src/app/api/products/batch/route.ts`——
  动作白名单 `ALLOWED_ACTIONS`、批量上限 200（与后端 `ArrayMaxSize(200)` 对齐）、
  畸形请求体挡掉。`merchant-admin` 与 `storefront` 各有一组「中转路由护栏」测试
  （`test/app/api/*.test.ts`）。
- `ApiError` 把网络层失败收敛成 `ApiError(503, 'NETWORK_ERROR', '网络连接失败…')`——
  否则页面上会出现 Node 原始串 `fetch failed`。
- `localizeApiMessage` 按**文案**匹配（`'Unauthorized'`）而不是按 `code` 匹配，
  因为后端主动抛的中文消息状态码同样是 401，按 code 匹配会覆盖掉更具体的信息。

**三个前端的认证差异**（`src/auth.ts`）：

| 前端 | scope | 租户来源 | 说明 |
|---|---|---|---|
| `storefront` | `CUSTOMER` | 带 `x-tenant-subdomain`（从**当前请求**解析，不读环境变量） | 一个进程服务所有店铺 |
| `merchant-admin` | `MERCHANT` | 不带子域名 | 中心域名没有「当前店铺」，租户完全由 accessToken 里的 tenantId 决定 |
| `platform-admin` | `PLATFORM` | 不带子域名 | 超管 `tenantId` 恒为 null；scope 写错会被后端角色过滤掉且提示与「密码错误」相同，极难排查 |

三者都是 `session: { strategy: 'jwt' }` + Credentials provider，**没有 middleware.ts**——
角色守卫在 Route Handler 与 Server Component 里手工做（`auth()` + 判 `session.role`）。

**主题 token 链路**：商家在 `merchant-admin` 改主题 → 后端 `modules/theme`（`ThemeService.sanitize`
按白名单过滤）→ `GET /public/theme` → storefront 的 `src/app/api/theme/route.ts` 中转 →
`src/lib/theme.ts` 的 `buildThemeCss()` 拼成 `--brand-*` CSS 变量 → 服务端内联 `<style>` +
客户端 `ThemeWatcher` 轮询（30 秒）`setProperty`。`globals.css` 的 `@theme inline` 把 `--brand-*`
映射成 Tailwind 的 `--color-*` 等命名空间。

> ⚠️ **变量名映射表（`CSS_VARS` / `GROUP_CSS_VARS`）必须导出给客户端复用**——
> 服务端与客户端各写一份必然漂移（服务端加了新 token 而客户端没加 → 那个 token 永远不生效）。
> ⚠️ `GROUP_CSS_VARS` **同时就是白名单**（键名不能靠前缀拼，否则 `tokens.textScale['sm; } body{']`
> 就能逃出 CSS 声明）。
> ⚠️ 阶段 5d 已把这条链路接通（删掉了 `@theme inline` 里的自引用与分组标量缺口，
> 见 `storefront/test/app/globals-css.test.ts` 的 I1–I6 断言）。**当前遗留**是：
> L13 商家改字号时行高比例不跟随（CSS 不允许除以长度，需产品策略）、
> L14 Tailwind 内置阴影刻度商家配不了、L16 部分 token 在 storefront 没有消费者。

### 2.9 结算与出款链路（阶段 5g / 5h / 5i / 5j / 5k / 5l / 5m）

```
支付成功 → 抽佣流水(CommissionEntry) + 货款流水(MerchantReceipt)
        → 结算单(SettlementStatement，一个商家 × 一个 UTC 自然月)
        → 商家申请出款(Payout) → 平台审批 → 打款(PayoutWorker) → 对账(PayoutReconciliation)
```

- **结算单的金额只从流水算，不从订单重新聚合**；三个金额是生成时刻的快照，确认后冻结。
- **出款单状态机**：`REQUESTED → APPROVED → PROCESSING → PAID | FAILED`，
  另有 `REJECTED`（商家可重申同一周期）与 `CANCELLED`（仅 REQUESTED 可撤）。
  `PayoutKind` 分 `NORMAL`（正常）与 `SUPPLEMENT`（补差：该期已 PAID 后又回填进来的流水）。
- **`FAILED` 不等于钱没了**：失败会释放明细占用，商家可重新申请，那笔钱仍属于「待出款」。
  `IN_FLIGHT_PAYOUT_STATUSES`（`REQUESTED`/`APPROVED`/`PROCESSING`）是「在途」口径的**唯一来源**，
  别的地方不要自己再列一遍状态。
- **补差路径必须优先于正常路径判定**（`deriveApplicableKind`）：正常单已 `PAID` 时它**也是活跃单**，
  先判正常路径会让补差入口永远不可达。
- **收款账户与出款单快照是密文**（`common/crypto/field-cipher.ts`），密钥来自
  `PAYOUT_ACCOUNT_ENCRYPTION_KEY`。密钥轮换后已打款的快照将**永久解不开**。
- **渠道对账（5m）**：六类差异 A–F（`ReconciliationDiffType`）+ 严重级 `INFO`/`WARNING`/`CRITICAL`。
  A 类自动纠正（渠道成功、本地卡在 PROCESSING）；B 类走人工四道闸。
  ⚠️ 比对引擎是**纯函数**（`payment/payout-reconcile.engine.ts`），
  ⚠️ 渠道记录**必须排序**后再比对（`sortChannelRecords`）——否则同一份账单换个行序，
  C 类告警会变成「匹配一致」，CSV 不配 `paidAt` 列时权威记录 100% 由数组顺序决定。
  ⚠️ CSV 导入的「状态」列与状态值映射**都必填**（不配 → 全部被当成「渠道已打款成功」→ 误判 A 类 → 自动改成已付款）。
- **渠道核实三层**（`common/payment/payout-verification.service.ts`）：只有渠道**明确说没打**，
  才允许解卡重打（`PayoutService.unstick` 的核实闸）。

### 2.10 Nginx 网关与租户标识

`infra/nginx/platform.test.conf`：

- `<tenant>.platform.test` → storefront，`/api/` → api，**网关注入 `X-Tenant-Subdomain`**。
- `api.platform.test` / `merchant.platform.test` / `admin.platform.test` → 中心域名，
  **显式剥除** `X-Tenant-Subdomain`（`proxy_set_header X-Tenant-Subdomain ""`）。

> ⚠️ **子域名是路由标识，不是凭证**。客户端设的同名头不可信（网关会覆盖，但应用侧也不能依赖）。
> 真正的访问控制来自认证与 RBAC。
> ⚠️ 后端有 `RESERVED_SUBDOMAINS` 保留名单（`admin`/`api`/`app`/…），
> 命中时按「不存在」处理（不查库、措辞一致），防止子域名接管与侧信道枚举。

### 2.11 错误处理

全局 `AllExceptionsFilter` 统一错误体：`{ code, message, details?, traceId }`，
`code` 由 HTTP 状态码映射（`common/filters/error-codes.ts`）。前端 `ApiError` 直接读这个结构。

---

## 三、测试约定

| 层 | 位置 | 跑法 |
|---|---|---|
| 后端单测 | `api/src/**/*.spec.ts`（与源码同目录） | `cd api && npm test` |
| 后端 e2e | `api/test/*.e2e-spec.ts` | `cd api && npm run test:e2e` |
| 前端单测 | 各前端 `test/**/*.test.{ts,tsx}` | `cd <前端> && npm test` |

- **后端 e2e 跑在测试库 `ecommerce_test`**（`DATABASE_URL_TEST`），与开发库物理隔离。
  `npm test` / `npm run test:e2e` 会先自动应用迁移（`test/deploy-test-db.mjs`、`test/setup-e2e.ts`）。
- **前端 Vitest 全局环境是 `node`**；组件测试在自己的文件里用
  `// @vitest-environment jsdom` 逐文件切换（逐文件注释优先于全局配置）。
- ⚠️ **`vitest.config.ts` 的 `esbuild: { jsx: 'automatic' }` 必须写在根级**（不能写在 `test` 下，
  Vite 的根级选项），否则组件测试报 `React is not defined`（esbuild 不读 tsconfig 的 `jsx: preserve`）。
- ⚠️ **`server-only` 要 alias 到 `test/stubs/server-only.ts`**——next-auth 会间接 import 它，
  node 环境下直接 import 会抛错。
- Route Handler 测试不需要起服务器：Next.js 的 Route Handler 就是普通导出函数，
  传一个 `new Request(url, { method, body })` 就能拿到 `Response`。
  公共 harness 在各前端 `test/helpers/route-harness.ts`。

---

## 四、文档与流程约定

`docs/superpowers/` 是本仓库的**主要上下文来源**：

- `specs/<日期>-<阶段>-<主题>-design.md` —— 设计文档
- `plans/<日期>-plan-<阶段>-<主题>.md` —— 实施计划（按 Task 拆解）
- `plans/<日期>-plan-<阶段>-<主题>-acceptance.md` —— 验收记录（**含踩坑清单与「实施期偏离计划」表**）

阶段编号：`01` → `02a/02b` → `03` → `04` → `05a`（营销）→ `05b`（平台计费）→ `05c`（令牌宽限期）
→ `05d`（主题/错误收口）→ `05e`（抽佣流水）→ `05f`（支付可靠性）→ `05g`（结算单）
→ `05h-1/05h-2`（出款申请 / 真正打款）→ `05i`（账目口径收口）→ `05j`（资金安全）→ `05k`（资金链路收尾）
→ `05l`（出款运维兜底）→ `05m`（渠道对账）。

**改代码前先读对应阶段的 design 与 acceptance**——那些文件里记着「实施期偏离计划」的**真缺陷**
（例如 5m 的计划里有 9 处真缺陷：NestJS 字段名是 `metadata.metatype` 不是 `metaclass`、
`groupChannelRecords` 从未被调用导致排序从未执行、对账端点被 `:id` 抢先匹配导致列表端点 100% 不可达）。
注释密度很高不是冗余——**大部分注释记录的是「为什么不能改成显然的写法」**，改代码时不要顺手「简化」它们。

---

## 五、其它约定

- **推送到 GitHub**：本机 `github.com:443` 可能不可达但 `api.github.com` 可达。
  `git push` 超时失败时改用 `export GH_TOKEN=$(gh auth token) && node tools/push-via-api.mjs <本地分支> <远端分支>`
  （通过 Git Data API 手工构造 tree / commit / ref）。
  ⚠️ **远端的 `main` 是 squash 版**，与本地保留的完整历史**必然分叉**——`git push` 会被拒。
  本地分支落后远端时：`git fetch` → 核对 `git diff HEAD origin/main` 为空 →
  `git reset --soft origin/main` → 重新提交 → 走 API 脚本。**不要 `git pull`**（会产生无意义的合并）。
- **金额、时区、时钟**：金额全程整数分；周期标识统一走 `formatPeriodLabel`（UTC 自然月），
  不要各处自己算月份；过期判定统一用**数据库时钟**（`prisma.databaseNow()`），
  多副本部署时各机器时钟有偏差——但秒级的宽限期判定用应用时钟（`AuthService` 的事）。
- **迁移历史**：`20261022071848_add_sku_stock_version` 在全新库上整条跳过是**故意的**
  （`ALTER TABLE IF EXISTS`），**不要动它**（后面有 `20261024160000_ensure_sku_stock_version` 兜底）。
  托管数据库上需要 DBA 先装 `pg_trgm` 扩展（`CREATE EXTENSION IF NOT EXISTS pg_trgm;`）——
  商品搜索依赖它，而 `CREATE EXTENSION` 需要超级用户权限。
- **假支付 / 假出款网关**：`FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED` **默认关闭**，
  它们是安全边界不是便利开关（假网关的支付页无需登录就能把订单付掉）。
  `NODE_ENV=production` 且开启 → **进程硬失败**（`assert-secure-config.ts`）。
  两个开关**相互独立**，用同一个开关会让两个环境的启停互相牵连。
- **编码准则**（来自用户全局偏好）：简单优先、外科手术式改动、不假设不掩饰困惑——
  动手前先说明假设，存在多种解释时全部列出；每一行改动都要能追溯到用户的需求。
