# 开发指南

本地环境搭建、测试、代码规范与日常工具。生产部署见[部署指南](deployment.md)。

## 本地开发（不用 Docker）

```bash
# 1. 数据库
cd infra && docker compose up -d postgres redis

# 2. 依赖（npm workspaces：仓库根一次装完，含共享包）
npm install

# 3. 后端
cd api
cp .env.example .env
npm run prisma:deploy     # 应用迁移
npm run prisma:seed      # 造平台超管 + 示例店铺 + 示例账号（见下）
npm run start:dev

# 4. 三个前端（各开一个终端）
cd storefront     && cp .env.example .env && npm run dev   # :3001
cd merchant-admin && cp .env.example .env && npm run dev   # :3002
cd platform-admin && cp .env.example .env && npm run dev   # :3003
```

> ⚠️ **npm workspaces**（阶段 11b）：仓库根是一份 lockfile + 一个
> node_modules（依赖提升），`@ecom/frontend-shared` 以 workspace 符号链接
> 被三端引用。跑测试/构建用 `npm test --workspace api`、
> `npm run build --workspace storefront`，或直接进各目录执行原脚本
> （二进制会沿目录树向上解析到根 node_modules/.bin）。

> Node/npm 基线：Node 24 + npm 11（见仓库根 `.nvmrc`）。运行与构建也支持 Node 22，
> 但 api 的测试需 **Node ≥ 24.9**：NestJS 12 全家是 ESM-only，Jest 走 `require(esm)`
> 依赖 `vm.SourceTextModule.prototype.hasAsyncGraph`（Node 22 没有这个 API）。
> CI 与 Docker 镜像统一 npm 11；`package.json` 的 `engines` 只做提示，不作为安装闸。

### 本机端口

本机标准端口被其他项目占用，本项目统一用：

| 服务 | 宿主机端口 | 容器内端口 |
|------|-----------|-----------|
| PostgreSQL | **15432** | 5432 |
| Redis（计划 3） | 16380 | 6379 |
| MinIO（计划 2） | 19000 | 9000 |

### 示例账号（seed 造的）

| 角色 | 邮箱 | 密码 | 店铺子域名 |
|------|------|------|-----------|
| 平台超管 | `admin@platform.test` | `Admin12345!` | —— |
| 商家店主 | `owner@demo.platform.test` | `Demo12345!` | `demo` |
| 消费者 | `customer@demo.platform.test` | `Demo12345!` | `demo` |

> 邮箱在 seed 写入前会统一小写化——登录路径把输入小写化后**精确匹配**查询，
> 而唯一索引是 `UNIQUE (lower(email))`，两边不一致会登不进去（阶段 3 手测踩到过）。

### 本地跑假支付网关

假网关的支付页（`/api/v1/pay/fake/:paymentId`）**只在非生产环境下存在**：
`NODE_ENV=production` 且 `FAKE_PAYMENT_ENABLED=true` 时进程**硬失败**——
假网关的支付页无需登录就能把订单付掉。

```bash
cd api && FAKE_PAYMENT_ENABLED=true \
  FAKE_PAYMENT_SECRET=local-fake-payment-secret-at-least-16-chars \
  npm run start:dev
```

### 渠道配置与沙箱

支付与出款各有**渠道注册表**，启用的渠道由环境变量决定（逗号分隔）：

```bash
# 支付：非生产默认 fake；出款：非生产默认 fake-payout（两个独立实现、两个独立开关）
PAYMENT_ENABLED_CHANNELS=fake
PAYOUT_ENABLED_CHANNELS=fake-payout

# 沙箱渠道（阶段 6）：只在非生产注册，生产环境写进启用列表会启动失败
PAYMENT_ENABLED_CHANNELS=fake,sandbox
PAYOUT_ENABLED_CHANNELS=fake-payout,sandbox

# 平台默认出款渠道的兜底值（DB 里 platform_settings 有行时以 DB 为准）
PAYOUT_PLATFORM_DEFAULT_CHANNEL=fake-payout
```

- **默认出款渠道解析**：商家配置（商家后台「收款账户」页的 `preferredChannel`）
  → 平台配置（超管后台 `/settings`，落 `platform_settings`）→ **都缺失则 fail-closed**
  （不回落、不猜）。商家配了渠道就**不再读平台默认值**，避免平台没配时连坐。
- **`sandbox` 仅开发可见**：`NODE_ENV=production` 时既不注册、也不出现在渠道列表里，
  启动校验会直接拒绝启用 devOnly 渠道（`fake` / `fake-payout` / `sandbox`）。
  名单只在 `api/src/common/channel/channel-config.ts` 一处维护。
- **新渠道准入**：任何支付/出款渠道都必须先通过
  `api/test/channel-contract/` 的共享契约（`runPaymentProviderContract` /
  `runPayoutProviderContract`）。契约不过 = 不允许接入；确实不适用的单条用
  `it.skip` 写明原因，不要放宽断言。
- 出款契约是**异步**的（`submit()` + `queryPayout()`），退款契约也是
  （`refund()` + `queryRefund()`，新增 `REFUNDING` 状态）：`PROCESSING` 既不是成功
  也不是失败，`definitive: false` 的失败**绝不自动重试**。

## 测试

```bash
cd api
npm test              # 单元测试（隔离机制 / 状态机转移表 / 抽佣纯函数 / 渠道契约等；规模以 npx jest --listTests | wc -l 为准）
npm run test:e2e      # 端到端（串行；套件数以 npx jest --config test/jest-e2e.json --listTests 为准）
npm run test:cov:e2e  # 项目真实覆盖率（带 e2e 专属门禁，见下）

# 浏览器级 e2e（Playwright，真实 Chromium 走 storefront 全链路）
npm test --workspace @ecom/browser-e2e   # 登录→加购→下单→假网关支付→PAID
```

> 🔒 **e2e 覆盖率是独立的一道棘轮**（`api/test/jest-e2e.json` 的 `coverageThreshold`，
> 2026-11-27 加）：statements 35 / branches 46 / functions 29 / lines 34。
> 它只作用于 e2e 配置，和 `api/package.json` 里单测那组（59/52/53/59）互不影响。
>
> - **算式**：两遍实测 `37.12 / 48.57 / 31.37 / 36.58` 与 `37.12 / 48.56 / 31.37 / 36.58`，
>   取较低那遍向下取整再减 2 个点（37-2=35、48-2=46、31-2=29、36-2=34）。
>   只许**上调**，下调阈值等同于允许覆盖率倒退。
> - **为什么比单测低**：`collectCoverageFrom='src/**/*.ts'` 的统计口径里包含了
>   79 个 `*.spec.ts` 单测文件（8830 行，e2e 永远不加载，覆盖率恒为 0）。
>   只看 225 个非 spec 的产品文件，e2e 的 lines 是 76.81%、functions 83.18% ——
>   控制器 / DTO / 中间件这些「单测覆盖不到」的部分正是 e2e 在兜。
>   所以**不要**为了数字好看去改排除清单，要动就单独立项。
> - **不要和单测共用 `coverage/`**：e2e 用自己的 `coverage-e2e/`（配置里写死），
>   两边的报告互相覆盖会得出错误结论；该目录已进 `.gitignore`。
> - 49 个套件在同一个进程里累积 Istanbul 覆盖率，默认堆（本机实测约 2GB）会
>   OOM 崩掉（`FATAL ERROR: Ineffective mark-compacts near heap limit`），
>   `test:cov:e2e` 因此带 `--max-old-space-size=4096`。

> ✅ **跑 e2e 不需要停 api 容器**（阶段 5c 实测更正）。队列前缀隔离
> （`BULLMQ_PREFIX=bull-e2e`）与每轮清库早已实现，**容器 api 全程在跑**的情况下
> 阶段 6 实测 657/657、阶段 8 实测 663/663、阶段 9 实测 663/663、
> 阶段 10 实测 663/663 全绿（阶段 10 还在**连接池压到 5 条**的严苛条件下
> 连跑两次全绿 —— 即 GitHub 2 核 runner 的默认池大小）。
> 若仍遇到**随机的假失败**，再 `docker compose stop api` 排除。
> 历史背景见
> [阶段 3 验收记录 §一](requirements/archive/plans/2026-10-24-plan-03-acceptance.md)。

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`。
**三个前端都有单元测试**（Vitest；各端用例数以 `npx vitest list` 为准）：

```bash
cd merchant-admin  && npm test   # 中转路由的护栏（认证 / 白名单 / 畸形请求体 / 批量上限 / 订单白名单）+ 计费白名单 + 令牌刷新 + jwt 回调的决策逻辑 + 出款/收款账户组件测试
cd storefront     && npm test   # 中转路由与纯函数的白名单 + **前端组件测试**（jsdom + Testing Library：加购按钮 / 地址簿 / 主题轮询）+ jwt 回调的决策逻辑
cd platform-admin && npm test   # 计费与对账中转路由的白名单 + 页面级测试 + 套餐表单 / 平台默认渠道设置的组件测试
```

> ✅ **三个前端都有组件测试基建**（`vitest.config.ts` + `test/setup.ts`）：
> `storefront` 与 `platform-admin` 早就有，`merchant-admin` 在阶段 5d 之后补齐
> （`test/components/` + `test/app/`，逐文件用 `// @vitest-environment jsdom` 切换）。
> `jwt` 回调的**决策逻辑**另外抽成纯模块，阶段 7c 起收编进
> `packages/frontend-shared/src/jwt-callback.ts`（三端共用一份，各端
> `src/lib/jwt-callback.ts` 只是再导出），在 node 环境下单测。
>
> ⚠️ `vitest.config.ts` 里两处**不要删**：根级 `esbuild: { jsx: 'automatic' }`，
> 以及 `'server-only'` 的空模块 alias —— 删了组件测试或 next-auth 的 import 会直接炸。

e2e 与单元测试都跑在**测试库** `ecommerce_test` 上，与开发库物理隔离。

> CI（`.github/workflows/ci.yml`）分六个 job：`api`（tsc + lint + 单测覆盖率门禁）、
> `frontend` matrix（storefront / merchant-admin / platform-admin 各自 tsc + 单测 +
> lint + build）、`shared`（tsc + 单测，`npm test --workspace @ecom/frontend-shared`）与
> `e2e`（串行跑 `test:cov:e2e`，带 e2e 自己的覆盖率门禁；MinIO 用真容器起，
> media 套件也在里面跑）。

### 单测冷启动偶发变红：并行 worker 数超出机器承受能力（事项 #31，2026-11-27）

> 起因：PR #60 报告「同一 commit、同一 Node 24 大版本，跑三次里有一次 1 套件 /
> 2 用例变红，日志被 tail 截断没定位到」。本机冷跑复现后查明：**不是环境预热，
> 也不是套件之间互相污染**，而是 jest 按 CPU 核数自动并行，在一台 8 核 / 8GB
> （其中 OrbStack 虚拟机固定占 4GB）的机器上开 7 个 worker，把 Prisma query
> engine 和 localhost 往返拖过了测试里的固定时间预算。另一类红与本问题无关、
> 但同样表现为「随机」：**OrbStack 会在跑批中途自动关机或重启容器**，
> 让连 Redis / Postgres 的用例当场失败。两类都要认，别混成一个结论。

**复现条件**（三条同时满足时稳定变红，缺一条就可能全绿）：

1. 冷启动：跑前 `npx jest --clearCache`（`npm install` 后首次跑、CI 冷缓存都算）；
2. 测试库刚重建：`DROP SCHEMA public CASCADE` + `CREATE SCHEMA public`，再靠
   `npm test` 前置的 `test/deploy-test-db.mjs` 重新 `prisma migrate deploy`；
3. jest 用默认并行度（`maxWorkers` 未设 → 8 核机器 = 7 个 worker）。

**修复前样本**（2026-11-27，本机 8 核 / 8GB，Node 24.11.0，commit `f2d0a68`，
11 轮冷跑：**10 红 1 绿**，每轮都跑满全量单测，规模以
`npx jest --listTests | wc -l` 为准）：

| 轮次 | 结果 | 失败面 |
|------|------|--------|
| run-01 | 红 | 3 套件 / 10 用例（tenant-prisma、guest-order、sandbox-payout） |
| run-02 | 红 | 2 套件 / 2 用例（tenant-prisma、payout 契约） |
| run-03 | 红 | 1 套件 / 5 用例（tenant-prisma） |
| run-04 | 红 | 1 套件 / 4 用例（tenant-prisma） |
| run-05 | 红 | 1 套件 / 6 用例（tenant-prisma） |
| run-06 | 红 | 1 套件 / 4 用例（tenant-prisma） |
| run-07 | 红 | 1 套件 / 5 用例（tenant-prisma） |
| run-08 | 红 | 1 套件 / 2 用例（tenant-prisma） |
| run-09 | **绿** | —（同样冷跑，机器当时空闲） |
| run-10 | 红 | 2 套件 / 8 用例（tenant-prisma、guest-order） |
| run-11 | 红 | 环境中断：`P1001 Can't reach database server`（见下面「环境陷阱」） |

**失败形态**：全部是超时或连接类，**没有一条断言失败**，集中在三处真实 I/O：

- `src/common/tenant/tenant-prisma.service.spec.ts`（真实 Postgres）：
  `Exceeded timeout of 5000 ms for a test`，日志里伴随
  `Response from the Engine was empty`；
- `src/modules/order/guest-order.controller.spec.ts:43`（真实 Redis）：
  `Exceeded timeout of 5000 ms for a hook`；
- `src/common/payment/sandbox-payout.provider.spec.ts` 与
  `test/channel-contract/payout-provider.contract.spec.ts`（进程内 mock HTTP 服务）：
  `ServiceUnavailableException: 沙箱渠道调用失败（POST /payout）：TimeoutError: The operation was aborted due to timeout`。

**根因**（三层叠加，缺一层都不会红得这么稳定）：

1. **并发度只看核数、不看内存**：每个 jest worker 都要装一整套 Nest + ts-jest +
   Prisma query engine。7 个 worker 冷编译 77 个套件时，本机空闲内存最低掉到 **31 MB**、
   `load average` 峰值接近 **29**（每 10 秒采一次、共 517 个样本，其中还有别的 agent
   在同机跑），单条 `prisma.tenant.create` 从 ~100ms 涨到 5s 以上，
   engine 进程甚至会空响应。同一套代码、同一个刚迁移的空库，
   `npx jest src/common/tenant/tenant-prisma.service.spec.ts --runInBand` 只跑 **2.8 秒、25 个用例全绿**。
2. **两个固定预算原本按「空闲机器」估的**：jest 默认 `testTimeout: 5000`；沙箱出款渠道的
   `SANDBOX_HTTP_TIMEOUT_MS = 3_000`（`api/src/common/payment/sandbox-payout.provider.ts:23`）。
   机器被压满时，一次本该几十毫秒的 localhost 往返也会超过 3 秒。
3. **`tenant-prisma.service.spec.ts:29-35` 每个用例 `new TenantPrismaService()` + `$disconnect()`**，
   25 个用例 = 25 次 query engine 启停，把这条最脆的路径再放大一档。

**已排除的两个假设**：

- **`process.loadEnvFile` 在 jest 多 worker 下偶发不生效**（`api/test/setup-unit-env.ts`
  顶部注释里「复现概率约 50%」的说法）：11 轮冷跑里**一次都没出现**
  `Environment variable not found: DATABASE_URL`，日志每轮都有
  `Environment variables loaded from .env`。该注释已按实测结论改写。
- **套件之间互相污染**：失败与执行顺序无关，且单跑最可疑的那个套件全绿（见上）。

**修法（已落库：`api/package.json` 的 `jest` 字段加 `"maxWorkers": "50%"`）**：

1. 并发上限按核数的 50% 算：本机 8 核 → 4 个 worker，GitHub 标准 2 核 runner → 1 个
   （CI 会串行跑完 api 单测，慢一些但不会再被自己压垮）。这是唯一被数据支持的变量。
2. **不要**靠调大 `testTimeout` 或渠道超时来"修"：实测无效 —— 把 jest 预算放宽到 30 秒后，
   run-36 里 `src/modules/order/guest-order.controller.spec.ts` 的钩子照样超时
   （原因是被容器重启打断，见下），拉长预算只是把"5 秒红"变成"30 秒红"，
   还让真正挂住的用例多占半分钟才报错。所以 `testTimeout` 保持默认。

**并发度对照数据**（全部是"清库 + 清 jest 缓存"的冷跑；本机 8 核 / 8GB，Node 24.11.0，
commit `f2d0a68`）：

| 配置 | 轮次 | 结果 |
|------|------|------|
| 默认（`maxWorkers` = 7）+ jest 5s + 沙箱 3s | run-01~run-11（11 轮） | **10 红 1 绿** |
| `maxWorkers: "50%"`（4 个）+ jest 5s，沙箱 3s | run-12（1 轮） | 红（沙箱渠道 3s 超时） |
| `maxWorkers: "50%"`（4 个）+ jest 30s，沙箱 3s | run-13、run-14（2 轮） | 2 绿 |
| `maxWorkers: "50%"`（4 个）+ jest 30s + 沙箱 30s | run-15~run-42（28 轮） | **27 绿 1 红**（run-36：容器在跑批中途重启） |
| **还原成干净工作区**（无任何改动，默认 7 个 worker） | 收尾复跑 1 轮 | **红：1 套件 / 2 用例** —— 与 PR #60 报告的形态一致 |
| `npx jest --maxWorkers=2`，默认 5s 预算 | 隔离实验 3 轮 | **3 绿** |
| `npx jest --maxWorkers=3` / `--maxWorkers=4`，默认预算 | 各 3 轮 | 各 2 绿 1 红（两轮的红都是 OrbStack 跑批中途关机） |
| `npx jest src/common/tenant/tenant-prisma.service.spec.ts --runInBand` | 1 轮 | 绿（2.8 秒 / 25 个用例） |
| **落地配置**（`"maxWorkers": "50%"` + 默认 5s，即本仓现在的设置） | 10 轮 | **8 绿 2 红**：1 次 OrbStack 重启 postgres（PG 日志里同一分钟的 `fast shutdown`），1 次沙箱 3 秒预算在系统级负载（Spotlight 索引把 load 拉到 16）下击穿 |

**合计 43 轮完成的冷跑：30 绿 13 红**（另有 1 轮因中途人工叫停而作废）。13 红里
**11 红是并发过高**（Prisma engine 空响应 / 5 秒预算击穿 / 沙箱 3 秒预算击穿），
**2 红是 OrbStack 在跑批中途关机或重启容器**（`P1001` /
`ioredis MaxRetriesPerRequestError`）。**没有一条是断言失败。**

**关于 PR #60 报告的"1 套件 / 2 用例"那次失败**：在**还原成干净工作区的收尾复跑**里
复刻出来了 —— 默认 7 个 worker、无任何改动，红的就是
`src/common/tenant/tenant-prisma.service.spec.ts` 的 2 个用例，
报 `Exceeded timeout of 5000 ms for a test`，日志里同时出现
`Response from the Engine was empty`。也就是说这条报告不是"环境预热"，也不是另一个幽灵 bug：
它和上表里其余 10 次红是同一族（并发过高 → Prisma 引擎在 5 秒预算内没回来）。
⚠️ 仍要说清边界：**这是 8 核机器 + 多个 agent 同时在跑的本机，不是 CI 的 2 核 runner**，
所以"CI 上为什么红"只能给到"形态与机制一致、可在本机复现"，没有 CI 现场的完整日志就
无法把因果钉死在 CI 那一轮上。

**结论强度与残余风险**：

- 并行度是**关键变量**：默认 7 个 worker 下 12 轮 11 红（含还原后复跑那轮）；2 个 worker 下 3 轮全绿。
- 但它**不是**唯一变量，也不是"改了就永不红"：run-36 证明容器/VM 一重启，任何预算都会红。
  这类只能靠"跑前确认三个容器 healthy"来防（见下面环境陷阱）。
- 落地 `50%` 之后的 10 轮冷跑是 **8 绿 2 红**，两次都能落到机器级干扰上（容器被重启、
  系统索引把 load 拉到 16）。**本机不是干净基准**：同一时刻 macOS 的 Spotlight 索引
  （`mds` / `mdworker_shared`）就能吃掉一半 CPU。CI 的 2 核 runner 上 `50%` = 1 个 worker，
  不处在这个量级；若本机仍偶发，先看下面环境陷阱，别急着回退并发设置。
- 支付侧 `api/src/modules/payment/sandbox-payment.provider.ts:34` 的 3 秒超时同样硬编码、
  没有构造参数可覆盖；若哪天它开始红，改它属于产品行为变更，要单独评估，别顺手改。


**排查时踩到的环境陷阱**（与本 bug 无关，但会伪装成 flaky，别误判）：

- **OrbStack 会自动关机**：本机 Docker 跑在 OrbStack 里（`memory_mib: 4096`），
  跑批期间它**多次**（至少 4 次）在无操作的情况下自行关机或重启容器
  （`~/.orbstack/log/vmgr.log` 里是 `deadline reached - power off`），
  容器随之消失或重建 → 测试报 `P1001 Can't reach database` / `fetch failed` /
  `connect ECONNREFUSED` / `ioredis MaxRetriesPerRequestError`。这类失败
  **不是测试或代码的问题**，重跑前先 `orb start` 并确认 `docker ps` 里三个容器
  都是 `healthy`；批量跑时更要在**每一轮开跑前**确认一次（判据用
  `docker exec ecommerce-postgres pg_isready`，光看 `docker ps` 会被
  「容器还在、VM 即将关」的窗口骗过去）。
- **Node 22 跑不了 api 单测**：即使 `engines` 写的是 `>=22`，用 Node 22.21.1 跑
  `npx jest` 会在加载 `@nestjs/common`（ESM）时直接报
  `Must use import to load ES Module`，整套 0 用例。跑单测请用 Node 24
  （CI 也是 24）。
- **`npx prisma migrate deploy` 在 `api/` 下指向开发库**：它读 `DATABASE_URL`，
  而单测要的是 `DATABASE_URL_TEST` —— 正确入口是 `node test/deploy-test-db.mjs`
  （`npm test` 已内置）。手工重置测试库时用它，否则清了测试库却把迁移打到开发库上。

**下次再遇到单测随机变红，按这个顺序查**：

1. **完整日志落盘再看**，不要 `| tail`：
   `npm test -- --json --outputFile=result.json > run.log 2>&1`，
   失败的 `fullName` + 首行错误从 `result.json` 里读，别靠截断的 stdout。
2. **先分类**：断言失败 → 真 bug；`Exceeded timeout` / `TimeoutError` /
   `P1001` / `fetch failed` / `Environment variable not found` → 先怀疑环境与并发。
3. **单跑那个套件**（`npx jest <file> --runInBand`）：单跑绿、全量红 = 并发/资源问题；
   单跑也红 = 用例自身或环境问题。
4. **降并发复跑**：`npx jest --maxWorkers=2`。降下来就绿，基本可锁定并发度过高。
5. **确认依赖容器**：`docker ps` 三个容器是否 `healthy`；`orb status` 是否 `Running`。
6. 需要对照历史数据时，冷跑脚本与每轮快照的做法见本节的复现条件 ——
   关键是**每轮都清库 + 清 jest 缓存**，否则第二轮起就是热跑，测不出东西。

## 代码规范与 lint

- **api lint 已归零**（阶段 8c），但全量 lint 仍耗时；日常只对改动文件跑
  `npx eslint <file>`，要求零错误。CI 的 api job 跑全量 lint 作为门禁。
- **三个前端 lint 已进 CI**（阶段 9），本地提交前建议跑 `npm run lint`。
- 文案、注释、测试名、commit message 一律**简体中文**；commit 用中文
  conventional commits（`feat(api): ...` / `fix(front): ...`）。
- 更完整的硬性约定（租户隔离、事务边界、金额单位、迁移手写、渠道准入等）见
  仓库根 [`AGENTS.md`](../AGENTS.md)。

## 推送到 GitHub

本仓库远端是 `gztcode/multi-tenant-ecommerce-saas`。常规 `git push` 即可：

```bash
git push -u origin <分支名>
```

**若 `git push` 超时失败**（某些网络环境下 `github.com:443` 不可达，但 `api.github.com` 可达），
改用仓库里的 API 推送脚本：

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api.mjs <本地分支> <远端分支>
```

它通过 Git Data API 手工构造 tree / commit / ref，效果与 `git push` 等价。

中文分支名会让 `gh api` 的参数编码出错（422 / 打印字节数组），此时改用 curl 版：

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api-curl.mjs <本地分支> <远端分支>
```
