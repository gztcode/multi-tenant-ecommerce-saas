# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。一个实例服务多个商家：每个商家有自己的店铺、商品、订单与客户。

**当前进度：阶段 2a「商品中心后端」已完成并验收通过。** 验收记录见
[`docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md)；
阶段 1 的验收记录见
[`docs/superpowers/plans/2026-10-21-plan-01-acceptance.md`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md)。

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

六个服务一起起来：`postgres` / `api` / `storefront` / `merchant-admin` / `platform-admin` / `nginx`。

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
cd infra && docker compose up -d postgres

# 2. 后端
cd api
npm install
cp .env.example .env
npm run prisma:deploy     # 应用迁移
npm run prisma:seed      # 造一个平台超管：admin@platform.test / Admin12345!
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

---

## 测试

```bash
cd api
npm test              # 单元测试（隔离机制，88 条）
npm run test:e2e      # 端到端（173 条，11 个套件）
npm run test:cov:e2e  # 项目真实覆盖率（74.55%）
```

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`。

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

---

## 文档

- 设计文档：[`docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md`](docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md)
- 实施计划：[`docs/superpowers/plans/`](docs/superpowers/plans/)
- 验收记录：[`阶段 1`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md) / [`阶段 2a`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md)

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
| 计划 2b | 商品中心前端：主题 token、storefront 浏览页、商家后台 |
| 计划 3 | 交易链路：购物车 → 库存 → 订单 → 支付（微信 + 支付宝） |
| 计划 4 | 营销、平台计费与平台超管的完整实现 |
