# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。一个实例服务多个商家：每个商家有自己的店铺、商品、订单与客户。

**当前进度：阶段 5a「营销（优惠券与满减活动）」已完成并验收通过（有条件通过）。**
阶段 5a 让商家能在自己的店铺发**优惠券**与**满减活动**，消费者领券、结算时自动享受优惠；
订单**快照**优惠信息（历史订单不重算），券的额度在**下单时预占核销**、订单取消或支付超时时
**释放**——与阶段 3 的库存预占/释放完全同构。

新增能力：后端 4 张表 + 优惠引擎（纯函数）+ 消费侧/商家侧/平台侧三套接口；
storefront 加**领券中心**（`/coupons`）与结算页的**券下拉 + 四行金额**（原价/活动减/券减/实付）；
merchant-admin 加**营销页**（券与活动的新建、编辑、暂停/启用、删除）。

验收记录见
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

---

## 一键启动（Docker）

```bash
cd infra && docker compose up -d
```

八个服务一起起来：`postgres` / `minio` / `redis` / `api` / `storefront` / `merchant-admin` / `platform-admin` / `nginx`。

- 后端健康检查：<http://localhost/api/v1/health>
- 接口文档：<http://localhost/api/docs>
- 店铺前台：<http://localhost/> （用 `Host` 头指定店铺，如 `Host: demo.platform.test`）

子域名本地调试：把 `127.0.0.1 *.platform.test` 写进 `/etc/hosts`。

> **注意**：compose 里的 `JWT_SECRET` / `AUTH_SECRET` 是明文固定值，**仅供本机开发**。
> 真实部署必须换成外部注入的随机密钥。

---

## 本地开发（不用 Docker）

```bash
# 1. 数据库
cd infra && docker compose up -d postgres redis

# 2. 后端
cd api
npm install
cp .env.example .env
npm run prisma:deploy     # 应用迁移
npm run prisma:seed      # 造平台超管 + 示例店铺 + 示例账号（见下）
npm run start:dev

# 3. 三个前端（各开一个终端）
cd storefront     && npm install && cp .env.example .env && npm run dev   # :3001
cd merchant-admin && npm install && cp .env.example .env && npm run dev   # :3002
cd platform-admin && npm install && cp .env.example .env && npm run dev   # :3003
```

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

---

## 测试

```bash
cd api
npm test              # 单元测试（隔离机制 / 状态机转移表等，102 条）
npm run test:e2e      # 端到端（282 条，17 个套件）
npm run test:cov:e2e  # 项目真实覆盖率
```

> ⚠️ **跑 e2e 前先停掉连着同一个 Redis 的 api**：`docker compose stop api`
> （本机手工起的 api 同样要停）。否则容器的 BullMQ worker 会抢走测试投进同一个
> 队列的任务（容器连开发库、测试连测试库），表现为 `payment.e2e-spec.ts` 的
> **假失败**。详见
> [验收记录 §一](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md)。

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`。
其中 `storefront` 与 `merchant-admin` 另有单元测试（Vitest）：

```bash
cd merchant-admin && npm test   # 75 条：中转路由的护栏（认证 / 白名单 / 畸形请求体 / 批量上限 / 订单白名单）+ 令牌刷新（13 + 12）
cd storefront    && npm test   # 120 条：中转路由与纯函数的白名单 + **前端组件测试**（jsdom + Testing Library：加购按钮 / 地址簿 / 主题轮询）
```

> ⚠️ **组件测试只在 `storefront` 上有基建**（`vitest.config.ts` + `test/setup.ts`）。
> `merchant-admin` 还没有 —— 这直接导致 `merchant-admin/src/auth.ts` 的
> `jwt` 回调**零自动化覆盖**（详见阶段 4 验收记录 §四）。

详见两个项目各自的 README「单元测试」一节。

> **遗留项**：`platform-admin` 本轮**没有**配单元测试框架——它阶段 2b 没有改动，
> 没有需要保护的护栏。等它开始有改动时再补。

e2e 与单元测试都跑在**测试库** `ecommerce_test` 上，与开发库物理隔离。

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
- 验收记录：[`阶段 1`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md) / [`阶段 2a`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md) / [`阶段 2b`](docs/superpowers/plans/2026-10-22-plan-02b-acceptance.md) / [`阶段 3`](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md) / [`阶段 4`](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)

---

## 推送到 GitHub

本仓库远端是 `gztcode/multi-tenant-ecommerce-saas`。常规 `git push` 即可：

```bash
git push -u origin <分支名>
```

**若 `git push` 超时失败**（某些网络环境下 `github.com:443` 不可达，但 `api.github.com` 可达），
改用仓库里��� API 推送脚本：

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api.mjs <本地分支> <远端分支>
```

它通过 Git Data API 手工构造 tree / commit / ref，效果与 `git push` 等价。

---

## 后续计划

| 计划 | 内容 |
|------|------|
| 计划 2a | 商品中心后端 —— **已完成并验收通过** |
| 计划 2b | 商品中心前端：主题 token、storefront 浏览页、商家后台 —— **已完成并验收通过** |
| 计划 3 | 交易链路：购物车 → 库存 → 订单 → 支付 —— **已完成并验收通过** |
| 计划 4 | 前端补齐与打磨 —— **已完成并验收通过**（有条件通过） |
| 计划 5a | 营销：优惠券与满减活动 —— **已完成并验收通过**（有条件通过） |
| 计划 5b | 平台计费：SaaS 订阅、套餐、额度（下一步） |

### 阶段 5b（平台计费）的起点

阶段 5a 已经把「平台级资源」跑通了第一遍：`Coupon.scope = PLATFORM` +
`tenantId` 指向平台租户，各店铺引用平台券。5b 的套餐/订阅可以照这个形态做。

5a 留给 5b 的两件事（详见
[阶段 5a 验收记录 §六 / §八](docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md)）：

1. **平台超管创建平台券没有前端入口** —— 后端有 `POST /platform/coupons`，
   但 `platform-admin` 里只有「概览」与「租户详情」两个页面。5b 做平台后台时一并补上。
2. **「金额一律整数分」的约定在 5b 会被反复用到**（套餐价、账单、税费），沿用即可。

### 阶段 4 验收发现的下一阶段优先项（详见
[验收记录 §七](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)）：

1. **修多标签页的「先后」刷新竞态** —— 优先级最高：本阶段实测发现，**商家只要同时开
   两个后台标签页就会被踢出登录**（旧 refreshToken 被判成「真正的重放」→
   吊销全设备登录）。需要后端配合：给轮换后的旧令牌一个**宽限期**，
   或提供**幂等刷新端点**。
2. **给 `merchant-admin` 补组件测试基建** —— 不补这套基建，`auth.ts` 的 `jwt` 回调
   **永远测不了**（失败注入 #6 / #8 证明：把「过期时刷新」整段删掉，75 条测试全绿）。
   护栏 3 / 5 现在只有手测在守。
3. **把分组标量（字阶 / 间距 / 阴影 / 字重）在前台接上消费者** —— 商家改这些值，
   前台**纹丝不动且无提示**（实测 `--text-base` 变了，渲染出来的字号没变）。
   要么在 `@theme inline` 里补上映射，要么**先把这些输入框在前台隐藏掉**。
4. **修字体 token 在服务端就失效** —— `@layer theme{...--font-sans:var(--font-sans)}`
   是循环引用，`--font-geist-sans` 又只挂在 `<body>` 上 → **商家改字体前台从来没生效过**。
   要两端一起改。
5. **统一前台的错误处理** —— 后端挂掉时页面把 Node 原始错误串 `fetch failed`
   显示给了用户，没有重试按钮。
6. **给商家后台做主题实时预览** —— 商家改主色时**自己都看不到变化**，
   只能切到另一个标签页看前台。
7. **给 e2e 的队列做隔离 + 每轮清库** —— 否则每次跑 e2e 都要先停 api 容器，
   会持续制造「实测报缺陷、复现不出来」的假象。
8. **退货入库流程** —— 退款不回补库存是有意的取舍，但配套的退货入库始终没实现。
9. **跨店会员** —— 等有了会员体系的需求再动。

阶段 3 遗留、本阶段仍未解决的（详见阶段 4 验收记录 §六）：
跨店会员不支持、游客订单查不到、退款不回补库存、购物车金额是估算值、
`20261022071848_add_sku_stock_version` 迁移在全新库上会失败（不要动它）。
