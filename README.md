# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。一个实例服务多个商家：每个商家有自己的店铺、商品、订单与客户。

**当前进度：阶段 11「可观测性与生产部署加固」已完成并验收通过**
（验收记录见
[`docs/superpowers/plans/2026-11-07-plan-11-observability-deploy-acceptance.md`](docs/superpowers/plans/2026-11-07-plan-11-observability-deploy-acceptance.md)）。

阶段 11 在阶段 10（并发正确性）之上补「看得见、上得去」的两块：

- **可观测性**：pino 结构化日志（全局 `useLogger`，业务代码零改动；request-id
  贯穿访问日志与响应头；敏感字段递归脱敏）+ Prometheus 指标
  （`/api/v1/metrics`：HTTP RED、六队列深度、**卡单 gauge**
  ——REFUNDING/PROCESSING 超 30 分钟的单数，正常恒为 0）+
  `WebhookAlertSink`（`ALERT_WEBHOOK_URL` 配飞书/钉钉/自建机器人，
  渠道告警从「打条日志没人看」变成真推送；去重 10 分钟 + 限频 10 条/分钟）。
- **部署加固**：生产 TLS 模板（`infra/nginx/templates/prod.conf.template`，
  泛域名证书 + ACME 路由 + HSTS）与 compose 生产 override
  （`infra/docker-compose.prod.yml`）；网关 `limit_req` 限流；
  `statement_timeout=8s`（防单租户慢查询拖垮共享库）；compose 新增
  `migrate` 工具服务（builder 镜像带 prisma CLI，`--profile tools`）。
  完整部署流程见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**。
- **代码收口**：`payment.service.ts`（2636 行）拆为四个服务
  （lookup / order / refund / webhook）+ 202 行 facade；
  `payout.service.ts`（2052 行）拆为 `PayoutQueryService` + `PayoutStateService`
  + 82 行 facade——外部调用点与类型导出均零改动；
  媒体上传 confirm 增加 magic-byte 复核；媒体列表 readUrl 批量签发；
  新增**游客订单查询**（订单号 + 收货手机号双因子、最小投影、
  防爆破限流——「订单号不是秘密」决策的受控例外，见
  `guest-order.controller.ts` 注释）。
- **跨副本互斥**：`RedisLockService`（SET NX PX + Lua 比对删除，
  抢不到 = 跳过本轮、Redis 不可用不抛出）套在 media 孤儿清理
  （每副本各自的 setInterval，N 副本会清 N 遍）与出款救援/渠道对账
  （「同一时间只允许一个对账任务」的双保险）上。
- **指标收口**：HTTP 指标从拦截器挪到**中间件层**——守卫拒绝的
  401/403 也能进指标了（拦截器在守卫之后执行，根本注册不上）。

阶段 10 修的是并发写路径的**根因**：

- **事务回调内不再借第二条连接**：Prisma 的交互事务（`$transaction(async (tx) => ...)`）
  会独占一条连接，回调内再用非事务客户端（`this.prisma`）就要再借一条 ——
  连接池小时（GitHub 2 核 runner 上默认池只有 5 条），并发下单互相等死，
  先报 `P2024`（拿不到连接），外层事务随后超时报 `P2028`。
  涉及 coupon / subscription / quota / cart / invoice / payment /
  platform-setting 七个模块，**9 个根因、15 处借用点**全部改为走事务客户端。
- **静态检测器 + 回归护栏**：用 TypeScript 类型信息构建全局调用图，
  追踪「事务回调 → 方法转调 → `this.prisma`」的完整链路；
  护栏单测扫全仓，新增违规即 CI 红。豁免必须写明理由，
  锚点用「文件 + 方法名 + 表达式」而非会漂移的行号。
- **CI 撤掉规避配置**：e2e job 不再放大连接池（`connection_limit=20`）、
  也不再放宽事务超时（`PRISMA_TX_TIMEOUT_MS=30000`）——
  用默认池跑正是为了持续验证「根因已修」。

设计文档见
[`docs/superpowers/specs/2026-11-04-plan-10-tx-boundary-design.md`](docs/superpowers/specs/2026-11-04-plan-10-tx-boundary-design.md)；
实施计划见
[`docs/superpowers/plans/2026-11-04-plan-10-tx-boundary.md`](docs/superpowers/plans/2026-11-04-plan-10-tx-boundary.md)。

阶段 9「历史技术债清理」已完成并验收通过。阶段 9 按四批清历史遗留：

- **A 安全与部署**：生产环境拒绝默认/空的 PostgreSQL、Redis、MinIO 凭据；
  三端 `AUTH_SECRET` 启动守卫（含 compose 默认值与 `.env.example` 占位值，
  `next build` 阶段放行）；compose 密钥可被环境变量覆盖、端口默认只绑回环、
  MinIO 镜像钉 digest。
- **B 运维与 CI**：备份缺卷默认失败并校验归档完整性，新增 `infra/restore.sh`
  与 `crontab.example`；CI 三前端合并为 matrix 并补 `lint`，新增 e2e job；
  回填脚本遇到活跃出款单默认拒绝（`--force` 显式跳过）。
- **C 资金与并发**：取消确认在事务内回查与更新；刷新令牌统一使用数据库时钟；
  宽限密文清理同时删除超保留期的过期行；结算单 CSV 导出（含公式注入防护）；
  新增批量重试「确定未打款」失败单的脚本。
- **D 前端与文档**：70 处中转路由改为 `!session?.accessToken`；storefront
  四个页面补齐 loading 骨架；删除未使用的 `@nestjs/config` 与共享包
  `react-dom`；文档口径统一。

阶段 9 的设计文档见
[`docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md`](docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md)；
验收记录见
[`docs/superpowers/plans/2026-11-04-plan-09-acceptance.md`](docs/superpowers/plans/2026-11-04-plan-09-acceptance.md)。

阶段 8 修的是「部署能跑但会打架、并发下会丢钱」的高危问题：

- **8a 部署与鉴权**：Nginx 只把 `/api/v1/` 代理给 API，店铺子域名的 BFF 路由
  （`/api/cart`、`/api/auth/session`）归还 storefront；生产密钥守卫改为按
  「已知占位符集合」判断，compose 内置默认值在生产环境直接拒绝启动；
  platform-admin 补齐与另两端同构的令牌刷新链路。
- **8b 资金与并发正确性**：购物车加购改单条原子自增 + P2002 重试（并发不丢增量）；
  续费按成功支付单幂等结算、单租户异常不中断整批；渠道交易号绑定补 `provider`
  并检查影响行数，绑不上返回 false。
- **8c 健壮性与工程债**：券/媒体分页夹取与合并窗口上限 1000；前端搜索/品类/商品页
  区分 404 与故障、购物车受控输入失败回滚、库存面板切 SKU 丢弃过期响应；
  共享 `api-client` 无令牌显式 401；CI 补权限/并发/超时与 shared job；
  备份保留策略、`gunzip -t` 校验、nginx healthcheck 与静态资源 immutable 缓存；
  api lint 归零并清理未使用依赖。

阶段 8 的设计文档见
[`docs/superpowers/specs/2026-11-04-plan-08-resilience-auth-funds-design.md`](docs/superpowers/specs/2026-11-04-plan-08-resilience-auth-funds-design.md)；
验收记录见
[`docs/superpowers/plans/2026-11-04-plan-08-acceptance.md`](docs/superpowers/plans/2026-11-04-plan-08-acceptance.md)。

阶段 7 把「能跑」变成「有回归保护、不对外裸奔、代码不再重复」：

- **7a 工程与部署基建**：GitHub Actions 四 job CI（api 单测 + 三端 tsc/test/build）、
  Redis `requirepass` 且全部宿主机端口绑回环、compose 日志轮转与内存上限、
  Nginx 收口（gzip / body 上限 / 安全头 / default server 444）、`infra/backup.sh` 备份。
- **7b api 代码收口**：购物车合并事务化、`setMedia` 批量化、券与佣金流水分页、
  对账单 DB 端归期、租户上下文失败统一 403、访问日志收口（不打 body 与原始错误信息）。
- **7c 前端共享包**：新增 `packages/frontend-shared`（包名 `@ecom/frontend-shared`），
  把三端逐字节重复的令牌刷新 / 会话同步 / jwt 回调 / error 边界 / `api-client` /
  `money` / `route-helpers` 收编，三端保留薄壳 re-export（调用点零改动）；
  三端补 21 个 `loading.tsx` 骨架页。

上一阶段（阶段 6）交付的渠道适配层仍是支付与出款链路的核心：
阶段 6 修的是**渠道只有一家、契约按同步假设写**的老毛病：以前支付/出款注册表
硬编码单一渠道，出款「取第一个渠道」，`refund()` 调下去就当成功——接第二家渠道、
或渠道异步受理（先 `PROCESSING` 后确认）时，本地账会和渠道账对不上。
现在支付与出款各有**渠道注册表**（能力门控、超管可读的渠道列表、生产环境拒绝
`fake` / `sandbox` 启动），出款契约改为 `submit()` + `queryPayout()`、退款改为
`refund()` + `queryRefund()`，新增 `PaymentStatus.REFUNDING`：
**只有渠道确认成功才落 `REFUNDED`**，`PROCESSING` 保持处理中，`definitive: false`
的失败绝不自动重试（宁可人工核对，不可重复打款/退款）。

同时落地：默认出款渠道解析（商家配置 → 平台配置 → fail-closed，平台配置在超管
后台 `/settings`）、对账按渠道隔离、CSV 来源的 A 类差异人工闸与**批量确认**
（勾选 / 全选筛选结果，游标分批）以及**沙箱渠道**（`sandbox`，仅开发环境可见）。

阶段 7 的设计文档见
[`docs/superpowers/specs/2026-11-03-plan-07-engineering-hardening-design.md`](docs/superpowers/specs/2026-11-03-plan-07-engineering-hardening-design.md)；
阶段 7a / 7b / 7c 的验收记录分别见
[`7a`](docs/superpowers/plans/2026-11-03-plan-07a-acceptance.md) /
[`7b`](docs/superpowers/plans/2026-11-04-plan-07b-acceptance.md) /
[`7c`](docs/superpowers/plans/2026-11-04-plan-07c-acceptance.md)。

阶段 6 的设计文档见
[`docs/superpowers/specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md`](docs/superpowers/specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md)；
阶段 6 的验收记录见
[`docs/superpowers/plans/2026-11-02-plan-06-acceptance.md`](docs/superpowers/plans/2026-11-02-plan-06-acceptance.md)；
阶段 5m 的验收记录见
[`docs/superpowers/plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md`](docs/superpowers/plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md)；
阶段 5c 的验收记录见
[`docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md`](docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md)；
阶段 5b 的验收记录见
[`docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md`](docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md)；
阶段 5a 的验收记录见
[`docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md`](docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md)；
阶段 4 的验收记录见
[`docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md`](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)；
阶段 3 的验收记录见
[`docs/superpowers/plans/2026-10-24-plan-03-acceptance.md`](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md)；
阶段 2b / 2a / 1 的见
[`2026-10-22-plan-02b-acceptance.md`](docs/superpowers/plans/2026-10-22-plan-02b-acceptance.md) /
[`2026-10-22-plan-02a-acceptance.md`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md) /
[`2026-10-21-plan-01-acceptance.md`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md)。

---

## 子项目

| 目录 | 说明 | 端口 | 技术栈 |
|------|------|------|--------|
| `api/` | 后端 API | 3000 | NestJS 11 + Prisma 6 + PostgreSQL 16 |
| `storefront/` | 消费者店铺前台 | 3001 | Next.js 15 + NextAuth v5 + shadcn/ui |
| `merchant-admin/` | 商家后台 | 3002 | Next.js 15 + NextAuth v5 + shadcn/ui |
| `platform-admin/` | 平台超管后台 | 3003 | Next.js 15 + NextAuth v5 + shadcn/ui |
| `infra/` | 容器编排与网关路由 | 80 | Docker Compose + Nginx |
| `packages/frontend-shared/` | 三端共享包（`@ecom/frontend-shared`，npm workspace） | —— | TypeScript + zod |

---

## 全栈容器（Docker）

```bash
cd infra && docker compose up -d
```

八个服务一起起来：`postgres` / `minio` / `redis` / `api` / `storefront` / `merchant-admin` / `platform-admin` / `nginx`。

- 后端健康检查：<http://localhost:3000/api/v1/health>（api 端口仅绑定本机回环；经 Nginx 访问时用 `Host: api.platform.test`）
- 接口文档：<http://localhost:3000/api/docs>
- 店铺前台：<http://localhost/> （用 `Host` 头指定店铺，如 `Host: demo.platform.test`）

子域名本地调试：把 `127.0.0.1 *.platform.test` 写进 `/etc/hosts`。

> **注意**：compose 默认是 **production 姿态**（`api/Dockerfile` 自带 `ENV NODE_ENV=production`，compose 也显式设 `NODE_ENV: production`），
> 所以上面这条命令**原样跑不起来**。启动校验会拒绝 compose 内置的默认凭据：默认/空的 PostgreSQL、Redis、MinIO 密码，
> 以及示例/默认的 `JWT_SECRET` / `AUTH_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 都会让进程启动即失败。
> 要真跑通，必须通过环境变量提供真实的 `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_PASSWORD` 凭据，
> 以及真实的 `JWT_SECRET` / `AUTH_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY`（其中 `JWT_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 至少 32 字符，可用 `openssl rand -base64 48` 生成）。
>
> 本机联调请走下面的「本地开发」路径（`cd api && npm run start:dev`，读 `api/.env`，`NODE_ENV` 不是 production，不触发这些拒绝）。
> 也**不要**把 compose 的 `NODE_ENV` 改成 development 绕过：那会让非生产默认的假支付（`fake`）/ 假出款（`fake-payout`）渠道生效，
> 属于安全姿态变更。
>
> compose 里的 `JWT_SECRET` / `AUTH_SECRET` 是明文固定值，**仅供本机开发**；真实部署必须换成外部注入的随机密钥。

---

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

> Node/npm 基线：Node 22 + npm 11（见仓库根 `.nvmrc`；本机 Node 26 也可用）。
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

---

## 测试

```bash
cd api
npm test              # 单元测试（隔离机制 / 状态机转移表 / 抽佣纯函数 / 渠道契约等，1094 条 / 68 套件，3 条跳过）
npm run test:e2e      # 端到端（702 条 / 41 个套件，串行）
npm run test:cov:e2e  # 项目真实覆盖率
```

> ✅ **跑 e2e 不需要停 api 容器**（阶段 5c 实测更正）。队列前缀隔离
> （`BULLMQ_PREFIX=bull-e2e`）与每轮清库早已实现，**容器 api 全程在跑**的情况下
> 阶段 6 实测 657/657、阶段 8 实测 663/663、阶段 9 实测 663/663、
> 阶段 10 实测 663/663 全绿（阶段 10 还在**连接池压到 5 条**的严苛条件下
> 连跑两次全绿 —— 即 GitHub 2 核 runner 的默认池大小）。
> 若仍遇到**随机的假失败**，再 `docker compose stop api` 排除。
> 历史背景见
> [阶段 3 验收记录 §一](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md)。

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`。
**三个前端都有单元测试**（Vitest）：

```bash
cd merchant-admin  && npm test   # 428 条：中转路由的护栏（认证 / 白名单 / 畸形请求体 / 批量上限 / 订单白名单）+ 计费白名单 + 令牌刷新 + jwt 回调的决策逻辑 + 出款/收款账户组件测试
cd storefront     && npm test   # 228 条：中转路由与纯函数的白名单 + **前端组件测试**（jsdom + Testing Library：加购按钮 / 地址簿 / 主题轮询）+ jwt 回调的决策逻辑
cd platform-admin && npm test   # 475 条：计费与对账中转路由的白名单 + 页面级测试 + 套餐表单 / 平台默认渠道设置的组件测试
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

### 数据库迁移

```bash
cd api && npm run prisma:deploy
```

⚠️ **托管数据库上需要 DBA 先装 `pg_trgm` 扩展。** 商品搜索依赖它，
而 `CREATE EXTENSION` 需要超级用户或数据库所有者权限——RDS / Cloud SQL
这类平台上应用用户通常不是 owner，迁移会 `permission denied` 而失败。

本项目的 `docker compose` 不受影响：扩展在 `infra/postgres/init-extensions.sql`
里于建库阶段（超级用户身份）装好。真实部署请让 DBA 先执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 数据备份与恢复

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

---

## 架构要点

- **多租户隔离在客户端层强制**：Prisma query extension 自动给读写加 `tenantId` 条件，
  并拒绝 `findUnique`/`update`/`delete`/`upsert` 这类无法附加租户条件的方法。
  详见 `api/src/common/tenant/`。
- **租户上下文由全局拦截器建立**：`AsyncLocalStorage` 承载，已认证请求从 JWT 取租户范围，
  匿名请求从子域名解析。
- **子域名是路由标识，不是凭证**：`X-Tenant-Subdomain` 由网关注入，客户端设的值不可信；
  真正的访问控制来自认证与 RBAC。
- **前端不直连后端**：后端没开 CORS（设计上前端与 API 同源，由 Nginx 反代），
  写操作走各自的同源中转路由。
- **订单状态流转一律用条件更新**：把 `from` 状态放进 `updateMany` 的 `where`，
  靠受影响行数判定并发赢家（阶段 3 的护栏 10）。改状态与动库存**必须在同一个事务里**——
  分成两个事务的话，释放失败时订单已是终态而库存没还回去，那批库存就永久卡在预占里。
- **库存三种流水**：下单 `RESERVE`（扣库存）、取消/超时 `RELEASE`（还库存）、
  支付成功 `DEDUCT`（**不动库存**，只是把预占转成售出）。释放与扣减都要校验
  「该订单在该 SKU 上尚未被冲抵的预占量」，否则能凭空造货。

---

## 文档

- 设计文档：[`docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md`](docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md)
- 实施计划：[`docs/superpowers/plans/`](docs/superpowers/plans/)
- 验收记录：[`阶段 1`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md) / [`阶段 2a`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md) / [`阶段 2b`](docs/superpowers/plans/2026-10-22-plan-02b-acceptance.md) / [`阶段 3`](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md) / [`阶段 4`](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md) / [`阶段 5a`](docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md) / [`阶段 5b`](docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md) / [`阶段 5c`](docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md) / [`阶段 5d`](docs/superpowers/plans/2026-10-27-plan-05d-acceptance.md) / [`阶段 5e`](docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md) / [`阶段 5f`](docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md) / [`阶段 5g`](docs/superpowers/plans/2026-10-28-plan-05g-acceptance.md) / [`阶段 5h-1`](docs/superpowers/plans/2026-10-29-plan-05h-payout-ledger-acceptance.md) / [`阶段 5h-2`](docs/superpowers/plans/2026-10-29-plan-05h2-payout-execution-acceptance.md) / [`阶段 5i`](docs/superpowers/plans/2026-10-30-plan-05i-ledger-reconciliation-acceptance.md) / [`阶段 5j`](docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md) / [`阶段 5k`](docs/superpowers/plans/2026-10-30-plan-05k-fund-closure-acceptance.md) / [`阶段 5l`](docs/superpowers/plans/2026-10-30-plan-05l-payout-ops-acceptance.md) / [`阶段 5m`](docs/superpowers/plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md) / [`阶段 6`](docs/superpowers/plans/2026-11-02-plan-06-acceptance.md) / [`阶段 7a`](docs/superpowers/plans/2026-11-03-plan-07a-acceptance.md) / [`阶段 7b`](docs/superpowers/plans/2026-11-04-plan-07b-acceptance.md) / [`阶段 7c`](docs/superpowers/plans/2026-11-04-plan-07c-acceptance.md)

---

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

---

## 后续计划

| 计划 | 内容 |
|------|------|
| 计划 2a | 商品中心后端 —— **已完成并验收通过** |
| 计划 2b | 商品中心前端：主题 token、storefront 浏览页、商家后台 —— **已完成并验收通过** |
| 计划 3 | 交易链路：购物车 → 库存 → 订单 → 支付 —— **已完成并验收通过** |
| 计划 4 | 前端补齐与打磨 —— **已完成并验收通过**（有条件通过） |
| 计划 5a | 营销：优惠券与满减活动 —— **已完成并验收通过**（有条件通过） |
| 计划 5b | 平台计费：SaaS 订阅、套餐、额度、抽佣、报表 —— **已完成并验收通过**（有条件通过） |
| 计划 5c | 刷新令牌宽限期（RFC 9700）—— **已完成并验收通过** |
| 计划 5d | 主题变量统一（`--brand-*`）+ 前端错误处理收口 + Redis 挂死修复 —— **已完成并验收通过** |
| 计划 5e | 抽佣流水明细 + M11 收尾 —— **已完成并验收通过** |
| 计划 5f | 支付可靠性（修丢钱洞 + 兜底扫描）—— **已完成并验收通过** |
| 计划 5g | 结算单（按商家 × 自然月的应收单据）—— **已完成并验收通过** |
| 计划 5h-1 / 5h-2 | 出款账 → 真正打款（出款执行 + 补差调账）—— **已完成并验收通过** |
| 计划 5i / 5j / 5k | 账目口径收口 → 资金安全与账务闭环 → 资金链路收尾 —— **已完成并验收通过** |
| 计划 5l | 出款运维兜底 —— **已完成并验收通过** |
| 计划 5m | 渠道对账（账单导入、差异分级、解卡重打）—— **已完成并验收通过** |
| 计划 6 | 渠道适配层与沙箱（注册表、默认渠道、异步出款/退款、CSV 批量确认）—— **已完成并验收通过** |
| 计划 7a | 工程与部署基建（CI、compose 安全、Nginx、备份）—— **已完成并验收通过** |
| 计划 7b | api 代码收口（事务 / 分页 / 横切统一 / 访问日志）—— **已完成并验收通过** |
| 计划 7c | 前端共享包 `@ecom/frontend-shared` + 三端收口 + loading 骨架 —— **已完成并验收通过** |
| 计划 8a / 8b / 8c | 部署与鉴权 → 资金与并发正确性 → 健壮性与工程债 —— **已完成并验收通过** |
| 计划 9 | 安全与部署、运维与 CI、资金并发护栏、前端与文档清理 —— **已完成并验收通过** |
| 计划 10 | 事务边界与连接池收口（并发写路径的根因修复 + 静态护栏） —— **已完成并验收通过** |

### 阶段 8 之后的剩余技术债

阶段 7 明确**不做**的几件事（设计与验收记录里都写明了，别当成遗漏）：

1. **TLS / secret manager / 结构化日志（pino）/ 慢查询阈值** —— 坚持本机开发形态，
   compose 仅供本机，加固以「不暴露局域网 + 密钥不内联」为度。
2. **三端源码 import 路径大面积替换到共享包** —— 目前保留三端薄壳 re-export
   （调用点零改动），将来真要清理再单独做。
3. **共享包独立发布 / 版本化** —— 阶段 8 已把 `session-sync-component.tsx` 改成
   工厂注入（不再依赖各端 `@/lib/session-sync` alias），共享包可独立 `tsc` 并进了 CI；
   阶段 11b 已随 npm workspaces 化改为 workspace 符号链接（不再是 `file:` 依赖），
   但**尚未**独立发布或独立版本化。
4. **守卫的 401/403 不进访问日志** —— Nest 的守卫在拦截器链**之外**执行，
   任何全局拦截器都盖不到。（**指标**无此缺口：阶段 11 已把 HTTP 指标
   挪到中间件层，守卫拒绝的请求也能统计到。）
5. **`Order.itemCount` 是下单时的快照** —— 件数总和；订单项当前无修改路径，
   若将来支持改单需回写。

阶段 6 明确**没做**的四件事（设计与验收记录里都写明了，别当成遗漏）：

1. **真实渠道接入**（微信 / 支付宝 / 银行）—— 本阶段只做适配层与沙箱；
   契约已经是异步形状，接真渠道时按「新渠道准入」跑一遍契约并通过 e2e。
2. **告警系统落地** —— 阶段 11 已补：`ALERT_WEBHOOK_URL` 配置飞书/钉钉/自建
   机器人后，卡单/退款无结论/对账超预算会直接推送（带去重与限频）。
3. **跨副本的分布式锁** —— 阶段 11 已补：`RedisLockService`
   （`common/lock/`）套在 media 清理、出款救援、渠道对账上；
   其余周期任务仍靠 BullMQ 单消费语义。
4. **通用平台设置中心** —— `platform_settings` 目前只承载
   `payout.platformDefaultChannel` 一个 key。

仍然存在的（沿用前几阶段的清单，未因阶段 6 变化）：

1. **退货入库流程** —— 退款不回补库存是有意的取舍，但配套的退货入库始终没实现。
2. **套餐的 `maxStores` 只声明不约束** —— 没有「新增店铺」接口，上限当前无处可施
   （阶段 11 已在套餐表单与 DTO 上标注「当前架构每租户固定 1 家，此字段暂不生效」，
   等多店需求落地时再动租户上下文架构）。
3. **换套餐时账单的周期长度语义** —— 定价已按待生效套餐修正，周期长度按新套餐
   `periodDays` 算这一点仍未定论。
4. **给商家后台做主题实时预览** —— **已完成**（核实于阶段 11 收尾）：主题表单
   自带实时预览区（`theme-form.tsx` 的 `buildPreviewStyle` + `theme-preview`），
   后台 globals.css 已做 `--color-primary: var(--brand-primary)` 映射，
   预览注入的内联变量真实生效，3 条组件测试守护。
5. **跨店会员** / **购物车金额是估算值** —— 阶段 3 遗留。
   （游客订单查询在阶段 11 已补：订单号 + 收货手机号双因子，见 `GuestOrderController`。）
6. **CSV 批量确认的严重级 / 状态筛选** —— 本阶段「筛选结果」= 该任务下全部
   A 类待处置项；若加筛选，扩展 `FILTER` 模式的固定条件即可。

### 阶段 4 验收发现的下一阶段优先项（详见
[验收记录 §七](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)）：

> ⚠️ 下面这份源自**阶段 4 验收当时的原始清单**，保留作历史记录。
> 原第 1 条「多标签页刷新竞态」已由阶段 5c（刷新令牌宽限期）实现，故不再列出，其余条目顺延编号。
> 哪些已完成请看上面「阶段 7 之后的剩余技术债」一节。

1. **给 `merchant-admin` 补组件测试基建** —— 不补这套基建，`auth.ts` 的 `jwt` 回调
   **永远测不了**（失败注入 #6 / #8 证明：把「过期时刷新」整段删掉，75 条测试全绿）。
   护栏 3 / 5 现在只有手测在守。
2. **把分组标量（字阶 / 间距 / 阴影 / 字重）在前台接上消费者** —— 商家改这些值，
   前台**纹丝不动且无提示**（实测 `--text-base` 变了，渲染出来的字号没变）。
   要么在 `@theme inline` 里补上映射，要么**先把这些输入框在前台隐藏掉**。
3. **修字体 token 在服务端就失效** —— `@layer theme{...--font-sans:var(--font-sans)}`
   是循环引用，`--font-geist-sans` 又只挂在 `<body>` 上 → **商家改字体前台从来没生效过**。
   要两端一起改。
4. **统一前台的错误处理** —— 后端挂掉时页面把 Node 原始错误串 `fetch failed`
   显示给了用户，没有重试按钮。
5. **给商家后台做主题实时预览** —— 商家改主色时**自己都看不到变化**，
   只能切到另一个标签页看前台。
6. **给 e2e 的队列做隔离 + 每轮清库** —— 否则每次跑 e2e 都要先停 api 容器，
   会持续制造「实测报缺陷、复现不出来」的假象。
7. **退货入库流程** —— 退款不回补库存是有意的取舍，但配套的退货入库始终没实现。
8. **跨店会员** —— 等有了会员体系的需求再动。

阶段 3 遗留、本阶段仍未解决的（详见阶段 4 验收记录 §六）：
跨店会员不支持、游客订单查不到、退款不回补库存、购物车金额是估算值、
`20261022071848_add_sku_stock_version` 迁移在全新库上会失败（不要动它）。
