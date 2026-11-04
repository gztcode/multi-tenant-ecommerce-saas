# 阶段 7「工程化与部署加固」设计

> **日期**：2026-11-03
> **前置**：阶段 6 验收通过后的全仓库审查（三路探索代理 + 人工核实）。
> **执行方式**：agent-team 波次并行（按无共享文件分组拆波次，每波并行派实施代理；代理不提交、只跑定向测试；两轮审查顺序不变但跨 Task 并发）。

---

## 一、背景与目标

阶段 6 完成后，对仓库做了三路审查（api 后端 / 三个前端 / infra 与部署），挖出
文档遗留清单之外的 30+ 条问题，按「高 / 中 / 低」分组并逐条立项，全部在本阶段收编：

- **工程基建缺口**：无 CI（全仓库无 `.github/`，5600+ 条测试全靠本地手动跑）、
  无任何备份机制、Redis 无密码且直出宿主机、api:3000 绕过 Nginx 剥除
  `X-Tenant-Subdomain`、`DATABASE_URL` 密码内联 fallback 与 `.env.example` 脱节。
- **代码质量债**：购物车合并非原子、多处复制粘贴（`currentTenantId` 失败处理
  15+ 处、`isUniqueViolation` 5 份）、券列表与佣金流水无分页、对账单全量拉表。
- **前端重复**：token 体系 5 个模块在 storefront 与 merchant-admin 逐字节相同
  （md5 已核实）、`api-client.ts` 三端约 80% 相同、三端无 `loading.tsx`。

**目标**：工程与部署层补齐回归保护与安全收口；api 与前端把已核实的质量问题
逐条修掉；全部改动有测试守着（改前改后测试通过）。

**坚持本机开发形态**：不引入 TLS / secret manager / pino / 新增容器 /
Kubernetes。README 已声明 compose 仅供本机开发，加固以「不暴露给局域网 +
密钥不内联」为度，生产化议题（TLS、多副本、集中日志）不在本阶段。

---

## 二、里程碑划分

| 里程碑 | 主题 | 并行度 | 落点 |
|--------|------|--------|------|
| **7a** | 工程与部署基建（CI / compose 安全 / Nginx / 备份） | 低——全是 infra 共享文件，单代理串行 | `infra/`、`.github/`、`tools/` |
| **7b** | api 代码收口（事务 / 分页 / 横切统一 / 日志） | 高——波次 1 五路并行 + 波次 2 横切串行 | `api/src`、两个前端页 |
| **7c** | 前端共享包与三端收口 | 中——包迁移串行 + 三端接入并行 | `packages/`、三前端 |

每个里程碑独立 PR + 独立验收文档，沿用项目惯例。CI 在 7a 最先落地，
后续所有改动都有回归保护。

---

## 三、7a 工程与部署基建

### 3.1 CI（`.github/workflows/ci.yml`）

- 触发：push 全分支 + PR。
- `api` job：services 起 postgres + redis（连接串对齐现有测试库约定），
  `npm ci` → `tsc --noEmit` → `npm test`（886 条单测）。
- 三个前端各一个 job：`npm ci` → `tsc --noEmit` → `vitest run` → `next build`。
- setup-node 开 npm 缓存。
- **e2e 首期不进 CI**：657 条串行耗时长且要完整迁移 + seed；CI 只保单测 + 构建，
  本地跑 e2e 的习惯不变，README 写明。
- 已知风险：本机 git 直连不可达（push 走 `tools/push-via-api.mjs`），云端
  Actions 能否正常触发只能推上去之后验证；若不可达，记入验收文档待办。

### 3.2 compose 安全收口（`infra/docker-compose.yml`）

- Redis 加 `requirepass`（新 env `REDIS_PASSWORD`），api 连接串改
  `redis://:<密码>@redis:6379`；`.env.example` 同步补变量。
- api 与 MinIO 控制台的宿主机端口映射加 `127.0.0.1:` 前缀——本机开发仍可直连，
  不再对局域网暴露（不彻底移除映射，避免破坏本地开发流）。
- `DATABASE_URL` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 改为引用 `.env` 变量，
  消除内联 fallback（修掉改 `.env` 的 `POSTGRES_PASSWORD` 不生效的脱节）。
- 全服务用 YAML anchor 统一 `logging: json-file, max-size 10m, max-file 3`；
  每服务加 `mem_limit`（指导值：postgres / api / minio 1g，三个前端 512m，
  redis / nginx 256m，实施时按 `docker stats` 实测微调）。

### 3.3 前端容器 healthcheck

三个 Next.js 容器用 `node -e "fetch('/')"` 探活（与 api 现有 healthcheck 同风格），
nginx `depends_on` 补 `condition: service_healthy`。

### 3.4 Nginx（`infra/nginx/platform.test.conf`）

gzip（css/js/json/svg）、`client_max_body_size 10m`、`proxy_read_timeout 60s`、
安全头（`X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy`）、
default server 返回 444。

### 3.5 备份

`infra/backup.sh`：`pg_dump` 全库 + MinIO 数据备份到本地目录；
README 写清挂 crontab 的方式。不引入 cron 容器。

### 3.6 顺手修

`tools/push-via-api.mjs` 的 `maxBuffer` 笔误（`10264` → `1024`）。

### 3.7 验证

`docker compose config` 通过；`docker compose up -d --wait` 全服务 healthy；
Redis 加密码后手测队列/支付链路真实可通；CI 首次用 API 脚本推送观察 run。

---

## 四、7b api 代码收口

### 4.1 波次 1（五路并行，文件域互不重叠）

| # | Task | 位置 | 设计 |
|---|------|------|------|
| 1 | 购物车合并事务化 + 批量化 | `api/src/modules/cart/cart.service.ts` | 先在内存算好合并结果（护栏不变：取 max、上限丢弃），「写合并结果 + 清不可售 + 删游客车」整体包 `$transaction`；新条目 `createMany`、数量调整按目标值分组批量 `updateMany`。补失败注入测试：中途抛错 → 整体回滚、无半合并状态、游客车仍在 |
| 2 | `setMedia` 批量化 | `api/src/modules/catalog/products/products.service.ts:328-345` | 事务内 `createMany({ skipDuplicates })` + 分组 `updateMany` 替代三重循环，行为不变 |
| 3 | 券服务两条（同文件一起做） | `api/src/modules/coupon/coupon.service.ts` | 商家券列表加分页（套 `clampPagination`，默认 50 / 上限 100）——**breaking change**，商家后台券列表页同步加最简分页；领券重试按 `meta.target` 收窄：只有命中领取记录约束名才重试，其余 P2002 照常抛（参照 `order.service.ts:1105` 既有模式） |
| 4 | 对账单列表改 DB 端聚合 | `api/src/modules/billing/merchant-statement.service.ts:135` | `findMany({ where: {} })` 全量拉表改 `groupBy` 取各租户 `occurredAt` min/max，行为不变 |
| 5 | 佣金流水分页 | `api/src/modules/billing/commission.service.ts:426` | 同 #3 模式，平台后台报表页同步接分页 |

### 4.2 波次 2（波次 1 合并后跑，避免同文件冲突）

| # | Task | 设计 |
|---|------|------|
| 6 | 横切收口（单代理串行，三条互相交叠） | ① `currentTenantId` 失败统一抛 `TenantContextMissingError`（403）——实施前先 grep 全部调用点与 e2e 对 404/401 的断言并同步改；② `isUniqueViolation` 5 份复制收敛到 `common/errors/unique-constraint.ts` 既有工具；③ 15 分钟支付超时、合并上限 200、分页上限 100 抽成各模块具名常量（**不进 env**，无调参需求） |
| 7 | 日志收口 | `main.ts:63` 改 Nest `Logger`；新增约 30 行 `LoggingInterceptor`（method / path / status / 耗时，不打 body 防敏感信息入日志）；Prisma client 配 `log: ['warn', 'error']`。**明确不做**：pino / 结构化日志（本机形态收益低，不引新依赖）、自定义慢查询阈值（Prisma 无原生支持，全量 query 事件太吵） |
| 8 | 条件项：订单列表 `include items` | `order.service.ts:916/946`——实施期先查两处前端是否真需要行项，不需要就砍掉，不预加 |

### 4.3 验证

每条改前改后测试通过；波次结束 `npm test`（886 条）全绿 + `tsc --noEmit`
无输出 + 涉及模块定向 e2e（cart / coupon / order / billing / reconciliation）。

---

## 五、7c 前端共享包与三端收口

### 5.1 共享包机制

新建 `packages/frontend-shared/`，三端 `package.json` 用
`"file:../packages/frontend-shared"` 引用；三端 `next.config.ts` 补
`transpilePackages`。**不引入根 package.json**，四个项目保持各自独立 install
的语义。实施第一步先用一个最小模块打通 build + vitest 解析，确认无坑再批量迁移。

### 5.2 迁入共享包的模块

| 重复度 | 模块 | 处理 |
|--------|------|------|
| 逐字节相同（md5 已核实） | `token-refresh.ts`、`token-expiry.ts`、`session-sync.ts` + `session-sync.tsx`（保留 `'use client'`）、`jwt-callback.ts`、`error.tsx`、`route-helpers.ts` | 直接迁移 |
| 约 80% 相同 | `api-client.ts` × 3 | 工厂化 `createApiClient({ buildHeaders, validate? })`，三端各留约 10 行初始化注入 header 策略 |
| 双实现 | `formatPrice`（storefront 5 行）vs `money.ts`（两端 43 行） | 统一到 `money.ts` 实现 |

- `validate` 钩子用 **zod**（把三端现有的死依赖真正用起来）先覆盖列表分页响应
  结构，不强制全站校验。
- 原 `src/lib` 下位置保留 re-export（`export * from '@ecom/frontend-shared/...'`），
  **三端源码 import 路径不大面积替换**——将来真要清理再单独做。
- 原测试迁移到共享包跑。

### 5.3 补 `loading.tsx`

三端 dashboard 内服务端取数的 route segment 各补一个（shadcn Skeleton），
约 10~15 个文件。

### 5.4 依赖与配置对齐

`shadcn` 移到 devDependencies；`next.config.ts` 三端对齐
（`webpack externals.push('vitest')` 三端都加）；`@vitest/coverage-v8`
保留 merchant 现状不强推三端。

### 5.5 波次结构

- 波次 1：建包 + 打通 + 逐字节模块迁移（单代理，环环相扣）。
- 波次 2：api-client 工厂化 + zod 校验 + money 统一（单代理，动的是波次 1 刚建的包）。
- 波次 3：loading.tsx + 依赖对齐（三端可并行）。

### 5.6 验证

三端 `npm test` 全绿（413 / 209 / 427）、`tsc --noEmit` 无输出、
`next build` 三端成功；手测 storefront 登录 → 令牌刷新 → 登出链路
（共享的正是这条链路的代码）。

---

## 六、风险与实施期调查项

| 风险 | 应对 |
|------|------|
| `file:` symlink 与 Next 构建/turbopack 兼容性未知 | 5.1 第一步先打通最小模块再批量迁移 |
| `currentTenantId` 统一 403 可能碰 e2e 对 404/401 的既有断言 | 实施前先 grep 调用点与断言，一次性同步 |
| Redis 加密码可能漏改某处连接串 | 7a 验收必测队列/支付链路真实可通 |
| 云端 Actions 不可达（本机网络受限的历史问题） | 推上去验证；不可达则记录待办，其余照常 |
| 分页是 breaking change，前端只做最小接入 | 券列表 / 佣金流水两个页面在 7b 同步改，e2e 守行为 |
| NextAuth 相关模块的隐式上下文依赖 | 5.2 迁移以三端测试全绿为准绳，不绿不迁 |

## 七、明确不做（本阶段范围外）

- 真实渠道接入、告警系统落地、跨副本分布式锁、通用平台设置中心、
  退货入库流程、套餐 `maxStores` 约束、跨店会员、游客订单查询
  （文档遗留清单，沿袭前阶段决策）。
- TLS / secret manager / pino 结构化日志 / 慢查询阈值 / e2e 进 CI / cron 容器
  （见 §一「坚持本机开发形态」）。
- 三端源码 import 路径大面积替换到共享包（5.2 保留 re-export，另行决策）。
- prisma migrate diff 的 4 条历史索引漂移（阶段 2 / 5a 已知问题，明确不修）。
