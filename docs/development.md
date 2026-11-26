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
npm run test:cov:e2e  # 项目真实覆盖率

# 浏览器级 e2e（Playwright，真实 Chromium 走 storefront 全链路）
npm test --workspace @ecom/browser-e2e   # 登录→加购→下单→假网关支付→PAID
```

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

> CI（`.github/workflows/ci.yml`）分六个 job：`api`（tsc + lint + 单测）、
> `frontend` matrix（storefront / merchant-admin / platform-admin 各自 tsc + 单测 +
> lint + build）、`shared`（tsc）与 `e2e`（串行跑 `test:e2e`，排除依赖 MinIO 的
> media 套件）。

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
