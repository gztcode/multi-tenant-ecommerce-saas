# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。一个实例服务多个商家：每个商家有自己的店铺、商品、订单与客户。

**当前进度：阶段 5c「刷新令牌宽限期（RFC 9700）」已完成并验收通过。**
阶段 5c 修的是**登录被踢下线**的老毛病：以前刷新令牌是**一次性**的，
同一枚旧令牌被提交第二次就会被判成「重放」→ 吊销用户**所有设备**的登录，
于是商家只要**同时开两个后台标签页**就会被踢出登录。
现在后端给轮换后的旧令牌一个**宽限期**（60 秒）：这枚令牌在宽限期内被重复提交，
后端返回**同一枚**新令牌，**不吊销令牌族**。

新增能力：后端的宽限期判定（`handleRevokedToken`）+ 宽限密文的**定时清理**；
商家侧与前台侧把 `jwt` 回调的**决策逻辑**抽成可测模块
（`src/lib/jwt-callback.ts`）并补上了单测 —— 护栏不再零覆盖。
客户端超时后重试、两个标签页串行抵达、跨副本各刷一次 —— 这些情况
**不再把用户踢下线**。宽限期**不替代**前端自己的去重与「送不回 cookie 就不刷」的判断，
两者互补。

设计文档见
[`docs/superpowers/specs/2026-10-27-plan-05c-auth-grace-period-design.md`](docs/superpowers/specs/2026-10-27-plan-05c-auth-grace-period-design.md)；
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
npm test              # 单元测试（隔离机制 / 状态机转移表 / 抽佣纯函数等，160 条）
npm run test:e2e      # 端到端（481 条，27 个套件）
npm run test:cov:e2e  # 项目真实覆盖率
```

> ✅ **跑 e2e 不需要停 api 容器**（阶段 5c 实测更正）。队列前缀隔离
> （`BULLMQ_PREFIX=bull-e2e`）与每轮清库早已实现，**容器 api 全程在跑**的情况下
> 连跑 3 轮 e2e 均 481/481 全绿。若仍遇到**随机的假失败**，
> 再 `docker compose stop api` 排除。
> 历史背景见
> [阶段 3 验收记录 §一](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md)。

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`。
**三个前端都有单元测试**（Vitest）：

```bash
cd merchant-admin  && npm test   # 200 条：中转路由的护栏（认证 / 白名单 / 畸形请求体 / 批量上限 / 订单白名单）+ 计费白名单 + 令牌刷新 + jwt 回调的决策逻辑
cd storefront     && npm test   # 184 条：中转路由与纯函数的白名单 + **前端组件测试**（jsdom + Testing Library：加购按钮 / 地址簿 / 主题轮询）+ jwt 回调的决策逻辑
cd platform-admin && npm test   # 181 条：计费中转路由的白名单 + 三个页面的页面级测试 + 套餐表单的组件测试
```

> ⚠️ **组件测试的基建在 `storefront` 与 `platform-admin` 上**（`vitest.config.ts` + `test/setup.ts`）。
> `merchant-admin` 还没有 —— 这直接导致 `merchant-admin/src/auth.ts` 的
> `jwt` 回调**零自动化覆盖**（详见阶段 4 验收记录 §四）。
>
> ✅ **阶段 5c 已把「零覆盖」这个洞补上了**（但不等于补上了组件测试基建）：
> `jwt` 回调的**决策逻辑**被抽成纯模块 `src/lib/jwt-callback.ts`
> （两个前端各一份，逐行一致），并在 **node 环境**下测了 9 条 ——
> 「accessToken 过期时刷新」「送不回去 cookie 时不刷新」
> 「刷新失败时作废会话 / 保留旧令牌」都有了断言。
> ⚠️ **`merchant-admin` 的 jsdom 组件测试基建仍缺**，属阶段 5d 的活。

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
- 验收记录：[`阶段 1`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md) / [`阶段 2a`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md) / [`阶段 2b`](docs/superpowers/plans/2026-10-22-plan-02b-acceptance.md) / [`阶段 3`](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md) / [`阶段 4`](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md) / [`阶段 5a`](docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md) / [`阶段 5b`](docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md) / [`阶段 5c`](docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md)

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
| 计划 5b | 平台计费：SaaS 订阅、套餐、额度、抽佣、报表 —— **已完成并验收通过**（有条件通过） |
| 计划 5c | 刷新令牌宽限期（RFC 9700）—— **已完成并验收通过** |

### 阶段 5c 之后的剩余技术债

阶段 4 验收时列的技术债清单里，有几条在阶段 5b 之后**变得更值钱**了
（详见[阶段 5b 验收记录 §八](docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md)）：

1. **抽佣流水明细** —— 现在的报表只有四个总数，超管看不到「哪个商家贡献了多少」。
   要出明细得补一张抽佣流水表（设计文档 §九当初的取舍：不建独立表，代价就是跨订单聚合）。
2. **套餐的 `maxStores` 只声明不约束** —— 没有「新增店铺」接口，那个上限当前无处可施。
3. **换套餐时账单的周期长度语义** —— 定价已修正（按待生效的套餐出账），
   但周期长度按新套餐的 `periodDays` 算这一点还没定论。
4. **M11 的可观测性** —— `markInvoicePaid` 里的 `status` 条件在当前实现下测不到
   （订阅期写的是绝对值，天然幂等）。

阶段 4 验收时列的**下一阶段优先项**（与 5b 无关）：

1. ~~**修多标签页的「先后」刷新竞态**~~ —— **阶段 5c 已做**：后端给轮换后的旧令牌
   加了**宽限期**（60 秒），宽限期内重复提交返回**同一枚**新令牌、不吊销令牌族。
   （「幂等刷新端点」那条备选路线没用上。）
2. **给 `merchant-admin` 补组件测试基建** —— 不补这套基建，`auth.ts` 的 `jwt` 回调
   **永远测不了**（失败注入 #6 / #8 证明：把「过期时刷新」整段删掉，75 条测试全绿）。
   护栏 3 / 5 现在只有手测在守。
   （⚠️ 阶段 5b 已经把同一套基建搬到了 `platform-admin`，照着搬一遍即可。）
   （✅ 阶段 5c 已经把 `jwt` 回调的**决策逻辑**抽成纯函数模块
   `src/lib/jwt-callback.ts` 并补上了单测 —— 护栏 3 / 5 不再只靠手测；
   但 jsdom 组件测试基建本身**仍未补**。）
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
7. ~~**给 e2e 的队列做隔离 + 每轮清库**~~ —— **早已实现**（`BULLMQ_PREFIX=bull-e2e`
   + 每轮清库）。阶段 5c 实测确认：**不需要停 api 容器**，连跑 3 轮 e2e 均全绿。
8. **退货入库流程** —— 退款不回补库存是有意的取舍，但配套的退货入库始终没实现。

### 阶段 4 验收发现的下一阶段优先项（详见
[验收记录 §七](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)）：

> ⚠️ 下面这份是**阶段 4 验收当时的原始清单**，保留作历史记录。
> 阶段 5c 之后哪些已完成，请看上面「阶段 5c 之后的剩余技术债」一节。

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
