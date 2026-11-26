# 架构设计

本文记录系统架构与关键设计取舍。**面向 AI 助手与新人的工程硬性约定**
（租户隔离、事务边界、渠道准入、金额单位等）集中在仓库根
[`AGENTS.md`](../AGENTS.md)；后端模块目录见 [`api/README.md`](../api/README.md)。

## 系统组成

| 目录 | 说明 | 端口 |
|------|------|------|
| `api/` | 后端 API | 3000 |
| `storefront/` | 消费者店铺前台 | 3001 |
| `merchant-admin/` | 商家后台 | 3002 |
| `platform-admin/` | 平台超管后台 | 3003 |
| `infra/` | 容器编排与网关路由 | 80 |
| `packages/frontend-shared/` | 三端共享包（`@ecom/frontend-shared`，npm workspace） | —— |

请求链路：浏览器 → Nginx（按 Host 路由、注入 `X-Tenant-Subdomain`）→ 三个 Next.js
应用（同源中转路由）→ `api`（全局前缀 `/api/v1`）。前端**不直连**后端，后端也不开 CORS。

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

## 模块依赖与渠道抽象

- **`modules/billing` 绝对不能 import `modules/payment`**：会形成
  `order → billing → payment → order` 的循环依赖，NestJS 启动直接报错。
  出款渠道契约与实现因此下沉到 `api/src/common/payment/` 的 `@Global()` 模块，
  详见该目录的 [`README`](../api/src/common/payment/README.md)。
- 支付与出款各有**渠道注册表**；渠道名单只在
  `api/src/common/channel/channel-config.ts` 一处维护。渠道配置、默认渠道解析与
  新渠道准入规则见 [`AGENTS.md` 的「渠道配置与默认渠道」](../AGENTS.md)，
  本地如何启用假网关/沙箱见[开发指南](development.md#渠道配置与沙箱)。

## 相关文档

- [开发指南](development.md) —— 本地环境、测试、代码规范
- [数据库](database.md) —— 数据模型约定、迁移、备份恢复
- [部署指南](deployment.md) —— compose 全栈与生产部署
- [需求与规划](requirements/README.md) —— 各阶段设计、计划与验收记录
