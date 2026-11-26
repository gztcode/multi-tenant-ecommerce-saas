# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。一个实例服务多个商家：每个商家有自己的店铺、商品、
订单与客户。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | NestJS 11 + Prisma 6 + PostgreSQL 16（全局前缀 `/api/v1`，Swagger 在 `/api/docs`） |
| 前端 | Next.js 16 + NextAuth v5 + shadcn/ui，三端共用 `@ecom/frontend-shared` |
| 基础设施 | Docker Compose + Nginx（按 Host 路由并注入 `X-Tenant-Subdomain`） |
| 测试 | 后端 Jest 30（单测 + e2e）、前端 Vitest 3、浏览器 e2e Playwright |

## 目录结构

| 目录 | 说明 | 端口 |
|------|------|------|
| `api/` | 后端 API（NestJS + Prisma） | 3000 |
| `storefront/` | 消费者店铺前台 | 3001 |
| `merchant-admin/` | 商家后台 | 3002 |
| `platform-admin/` | 平台超管后台 | 3003 |
| `infra/` | 容器编排与网关路由 | 80 |
| `packages/frontend-shared/` | 三端共享包（npm workspace） | —— |
| `docs/` | 文档（架构、开发、数据库、部署、需求） | —— |

## 快速开始

```bash
# 1. 起后端依赖（PostgreSQL / Redis / MinIO，本机端口 15432 / 16380 / 19000）
cd infra && docker compose up -d --wait postgres redis minio

# 2. 依赖（npm workspaces：仓库根一次装完）
npm install

# 3. 后端
cd api && { [ -f .env ] || cp .env.example .env; }
npm run prisma:deploy && npm run prisma:seed   # 首次：迁移 + 造示例数据
npm run start:dev

# 4. 三个前端各开一个终端
cd storefront     && ([ -f .env ] || cp .env.example .env) && npm run dev   # :3001
cd merchant-admin && ([ -f .env ] || cp .env.example .env) && npm run dev   # :3002
cd platform-admin && ([ -f .env ] || cp .env.example .env) && npm run dev   # :3003
```

示例账号（seed 造）：平台超管 `admin@platform.test` / `Admin12345!`，
商家店主 `owner@demo.platform.test` / `Demo12345!`（店铺子域名 `demo`）。

完整的依赖版本要求、测试库创建、假网关联调、测试命令与常见坑见
[开发指南](docs/development.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [文档索引](docs/README.md) | 全部文档入口与各子项目 README |
| [架构设计](docs/architecture.md) | 系统组成、请求链路、多租户隔离、订单状态机与库存流水、模块依赖与渠道抽象 |
| [开发指南](docs/development.md) | 本地环境、npm workspaces、本机端口、示例账号、渠道与假网关、测试、代码规范、推送 |
| [数据库](docs/database.md) | 数据模型约定、迁移流程、测试库、`pg_trgm`、备份与恢复 |
| [部署指南](docs/DEPLOY.md) | 本机全栈容器、生产部署（TLS、密钥、升级、回滚）、Nginx 与运维脚本 |
| [需求与规划](docs/requirements/README.md) | 需求模板、当前待办与技术债、阶段 1~11 的设计/计划/验收归档 |
| [AGENTS.md](AGENTS.md) | 面向 AI 助手与新人：目录布局、命令、不可违反的约定、踩坑记录（**动手前必读**） |

> 本 README 原先把架构、开发、测试、迁移、部署、阶段进度、技术债全部塞在一起，
> 本次整理按主题拆到 `docs/`：阶段进度叙述见
> [历史阶段进度](docs/requirements/archive/stage-history.md)，待办与技术债见
> [backlog](docs/requirements/backlog.md)，内容均为原文迁移。

## 当前状态

阶段 11「可观测性与生产部署加固」已完成并验收通过
（[验收记录](docs/requirements/archive/plans/2026-11-07-plan-11-observability-deploy-acceptance.md)）。
下一阶段待办见 [backlog](docs/requirements/backlog.md)。
