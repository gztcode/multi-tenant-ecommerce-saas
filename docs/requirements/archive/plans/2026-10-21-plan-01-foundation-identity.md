# 计划 1：平台地基与身份体系 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个能跑通「商家注册开店 → 登录后台 → 配置店铺」的多租户电商底座地基，包含四项目脚手架、Prisma 数据层、租户隔离机制、三类身份鉴权、三个前端应用骨架，并以自动化测试证明跨租户数据不可达。

**Architecture:** 后端 `api/` 为 NestJS 模块化单体，PostgreSQL 共享库 + 每张业务表带 `tenantId`。租户隔离由两层组成：Prisma client extension（自动注入 `where.tenantId`、自动写入 `data.tenantId`、拦截危险操作）+ NestJS 全局 `TenantContextInterceptor`（解析租户并写入 `AsyncLocalStorage`）。前后端完全分离为四个独立项目，前端通过 NextAuth.js 的 Credentials Provider 把登录委托给后端，拿到后端签发的 JWT 后以 `Authorization: Bearer` 调用 API。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 + Passport-JWT + Argon2 + Jest/Supertest | Next.js 15 (App Router) + React 19 + NextAuth.js v5 (beta) + Tailwind CSS 4 + shadcn/ui + tanstack-query | Docker Compose + Nginx

**对应设计文档:** `docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md` 第 2.1、4、5、6、7、12、13 节

---

## 零、全局约定

### 0.1 目录与仓库

四个独立子项目位于仓库根目录：

```
电商项目/
├─ api/                # NestJS 后端
├─ storefront/         # Next.js 消费者店铺前台
├─ merchant-admin/     # Next.js 商家后台
├─ platform-admin/     # Next.js 平台超管后台
└─ infra/              # Docker Compose、Nginx、文档
```

本计划中所有路径相对于仓库根目录 `/Users/tom/orca/workspaces/电商项目/电商项目`。

### 0.2 命名与语言

- 代码标识符、注释、提交信息一律用简体中文（标识符本身用英文）
- Prisma 模型用 PascalCase，数据库表名用 `snake_case` 复数（通过 `@@map`）
- 提交信息格式：`<type>: <中文描述>`，type 取 `feat` / `fix` / `chore` / `test` / `docs`

### 0.3 本机端口分配

本机已运行着其他项目的容器栈（`deploy-*` 占用 5432/16379，`shopstack-*` 占用 6379/5672），标准端口不可用。本项目统一使用下列宿主机端口（容器内端口不变）：

| 服务 | 宿主机端口 | 容器内端口 | 引入计划 |
|------|-----------|-----------|---------|
| PostgreSQL | 15432 | 5432 | 计划 1 |
| Redis | 16380 | 6379 | 计划 3（支付队列） |
| MinIO | 19000 | 9000 | 计划 2（媒体上传） |

后续任务新增服务时必须沿用此表，不要占用标准端口。

**单一真相源约束**：同一配置项不得同时出现在 compose 硬编码与 `.env` 两处。
compose 一律用 `${VAR:-默认值}` 插值，`.env.example` 是唯一可编辑的来源。

### 0.4 贯穿全计划的技术决策

| 决策 | 取值 | 理由 |
|------|------|------|
| 密码哈希 | Argon2id（`argon2` 包） | 比 bcrypt 更抗 GPU 爆破 |
| Refresh Token | 60 字符随机串，库内存 SHA-256 哈希 | 高熵值用快速哈希足够；哈希存储便于吊销 |
| Access Token | JWT，`expiresIn` 2 小时，HS256 | 阶段 1 单一服务，HS256 足够 |
| 租户作用域模型 | `User`、`Store`（阶段 1） | 放在常量白名单里便于扩展 |
| 平台作用域 | `ctx.tenantId === null && ctx.role === PLATFORM_ADMIN` | 显式跨租户，其余情况一律拒绝 |
| 金额单位 | 整数分（`number`），不用浮点 | 避免精度问题 |
| 时间 | 数据库存 `timestamptz`，API 传 ISO 8601 字符串 | |

### 0.5 危险操作护栏（Prisma extension 强制）

Prisma 的 `findUnique` / `update` / `delete` 只接受唯一字段作为 `where`，无法附加 `tenantId` 条件——这是多租户系统最常见的越权漏洞来源。因此本计划**禁止**在租户作用域模型上使用这三个方法，extension 会直接抛错，强制改用 `findFirst` / `updateMany` / `deleteMany`。

---

## 阶段 1 需求覆盖映射

设计文档第 2.1 节列出的阶段 1 功能，分为四份计划交付。本计划（计划 1）覆盖范围如下：

| 设计文档 2.1 的模块 | 落在哪份计划 | 本计划覆盖的内容 |
|---------------------|-------------|-----------------|
| 租户与店铺 | 计划 1 | 商家注册开店、子域名解析、店铺状态、店铺设置读写 |
| 身份与权限 | 计划 1 | 三类身份、JWT + Refresh 轮换、RBAC 角色守卫 |
| 主题 | 计划 1（存储）/ 计划 2（渲染） | 计划 1 只做 `themeTokens` 的读写；CSS 变量渲染在计划 2 |
| 基础设施 | 计划 1 | Docker Compose、结构化日志、traceId、health 探活、Nginx 子域名配置 |
| 店铺前台 | 计划 1（骨架）/ 计划 2、3、4 | 计划 1 只做店铺首页与消费者登录个人中心 |
| 商家后台 | 计划 1（骨架）/ 计划 2、3、4 | 计划 1 只做概览页与店铺设置页 |
| 平台超管后台 | 计划 1（部分）/ 计划 4 | 计划 1 只做商家列表与状态变更；套餐抽佣在计划 4 |
| 商品中心 | 计划 2 | — |
| 库存 | 计划 3 | — |
| 购物车与订单 | 计划 3 | — |
| 支付 | 计划 3 | — |
| 营销 | 计划 4 | — |
| 平台计费 | 计划 4 | — |

**计划 1 是后续三份计划的依赖前提**：多租户隔离机制、身份体系、店铺模型都在这里定型，后面三份只在这套基础上叠加业务，不会回头改地基。

---

## Task 1：仓库骨架与本地基础设施

**Files:**
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `README.md`
- Create: `infra/docker-compose.yml`
- Create: `infra/.env.example`

- [ ] **Step 1: 创建根级 `.gitignore`**

```gitignore
# 依赖
node_modules/
.pnp
.pnp.js

# 构建产物
dist/
build/
.next/
out/
*.tsbuildinfo

# 环境变量
.env
.env.local
.env.*.local

# 数据库
*.db
*.db-journal

# 可视化头脑风暴临时文件
.superpowers/

# 日志
*.log
npm-debug.log*
yarn-error.log*

# 编辑器
.DS_Store
.idea/
.vscode/*
!.vscode/extensions.json

# 测试覆盖率
coverage/
```

- [ ] **Step 2: 创建 `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 3: 创建 `infra/docker-compose.yml`**

阶段 1 只需要 PostgreSQL。Redis 与 MinIO 分别在计划 2（媒体上传）与计划 3（支付队列）引入。

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: ecommerce-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-ecommerce}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-ecommerce}
      POSTGRES_DB: ${POSTGRES_DB:-ecommerce}
    ports:
      # 宿主机端口默认 15432：本机 5432 已被另一个项目的 postgres 容器占用
      - '${POSTGRES_PORT:-15432}:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-ecommerce} -d ${POSTGRES_DB:-ecommerce}']
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  pgdata:
```

- [ ] **Step 4: 创建 `infra/.env.example`**

```bash
# PostgreSQL 配置源：docker-compose.yml 通过 ${VAR:-默认值} 引用这里的变量。
# 复制为 .env 后可覆盖默认值；不复制也能起（compose 内置默认值与此处一致）。
# 用法：cp .env.example .env

# 宿主机端口 15432（本机 5432 已被其他项目占用），容器内仍是 5432
POSTGRES_USER=ecommerce
POSTGRES_PASSWORD=ecommerce
POSTGRES_DB=ecommerce
POSTGRES_PORT=15432
```

- [ ] **Step 5: 创建 `README.md`**

```markdown
# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。

## 子项目

| 目录 | 说明 | 技术栈 |
|------|------|--------|
| `api/` | 后端 API | NestJS + Prisma + PostgreSQL |
| `storefront/` | 消费者店铺前台 | Next.js + NextAuth.js |
| `merchant-admin/` | 商家后台 | Next.js + NextAuth.js |
| `platform-admin/` | 平台超管后台 | Next.js + NextAuth.js |
| `infra/` | 本地基础设施与部署编排 | Docker Compose + Nginx |

## 当前进度

阶段 1「平台地基与身份体系」正在实施中，计划见 `docs/superpowers/plans/2026-10-21-plan-01-foundation-identity.md`。
下列命令在阶段 1 完成后全部可用。

## 本地启动

```bash
# 1. 起数据库（宿主机端口 15432，容器内 5432）
cd infra && cp .env.example .env && docker compose up -d

# 2. 起后端（api/ 目录在阶段 1 期间创建）
cd api && npm install && cp .env.example .env && npm run prisma:deploy && npm run prisma:seed && npm run start:dev

# 3. 起三个前端（三个终端各一个）
cd storefront && npm install && npm run dev        # 消费者店铺前台 :3001
cd merchant-admin && npm install && npm run dev    # 商家后台 :3002
cd platform-admin && npm install && npm run dev    # 平台超管后台 :3003
```

数据库连接地址：`postgresql://ecommerce:ecommerce@localhost:15432/ecommerce`
本机端口分配见计划文档「0.3 本机端口分配」。

进入容器：`docker compose exec` 用服务名 `postgres`，`docker exec` 用容器名 `ecommerce-postgres`。

设计文档：`docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md`
实施计划：`docs/superpowers/plans/`
```

- [ ] **Step 6: 启动数据库并确认健康**

Run:
```bash
cd infra && docker compose up -d && sleep 3 && docker compose ps
```
Expected: `ecommerce-postgres` 状态为 `healthy`

- [ ] **Step 7: 提交**

```bash
git add .gitignore .editorconfig README.md infra/
git commit -m "chore: 仓库骨架、gitignore 与本地 PostgreSQL 编排"
```

---

## Task 2：后端脚手架与健康检查

**Files:**
- Create: `api/`（由 `nest new` 生成后按步骤调整）
- Modify: `api/package.json`
- Modify: `api/src/app.module.ts`
- Create: `api/src/health/health.controller.ts`
- Create: `api/src/health/health.module.ts`
- Create: `api/test/health.e2e-spec.ts`
- Create: `api/test/jest-e2e.json`

- [ ] **Step 1: 生成 NestJS 项目**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && npx --yes @nestjs/cli@11 new api --package-manager npm --skip-git --strict
```
Expected: 生成 `api/` 目录，含 `src/main.ts`、`src/app.module.ts`、`src/app.controller.ts`、`src/app.service.ts`、`test/app.e2e-spec.ts`、`tsconfig.json`、`nest-cli.json`

- [ ] **Step 2: 安装额外依赖**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm install @nestjs/config @nestjs/jwt @nestjs/passport @nestjs/swagger@11 @prisma/client@6 passport passport-jwt argon2 class-validator class-transformer && npm install -D prisma@6 @types/passport-jwt supertest @types/supertest
```
Expected: 无报错，package.json 中依赖写入完成

> 注意：`@nestjs/swagger` 必须钉在 `^11`（12.x 的 peer 依赖要求 NestJS 12，直接装会 `ERESOLVE` 失败）。`@nestjs/config`、`@nestjs/jwt`、`@nestjs/passport` 的 12.x 兼容 NestJS 11，可装最新版。

- [ ] **Step 3: 删除脚手架自带的示例控制器**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && rm -f src/app.controller.ts src/app.service.ts src/app.controller.spec.ts test/app.e2e-spec.ts
```
Expected: 文件已删除

> `src/app.controller.spec.ts` 是 `app.controller.ts` 的单元测试，删掉被测文件后它必然编译失败导致 `npm test` 挂掉，必须一并删除。

- [ ] **Step 4: 编写健康检查模块**

`api/src/health/health.controller.ts`：

```typescript
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: '存活探针' })
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
```

`api/src/health/health.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
```

- [ ] **Step 5: 改写 `api/src/app.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

@Module({
  imports: [HealthModule],
})
export class AppModule {}
```

- [ ] **Step 6: 配置 e2e 测试**

`api/test/jest-e2e.json`：

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  }
}
```

`api/test/health.e2e-spec.ts`：

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('健康检查 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health 返回 ok', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.timestamp).toBe('string');
  });
});
```

- [ ] **Step 7: 运行 e2e 测试确认通过**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx jest --config ./test/jest-e2e.json
```
Expected: `Tests: 1 passed, 1 total`

- [ ] **Step 8: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): NestJS 脚手架与健康检查端点"
```

---

## Task 3：Prisma 数据模型、迁移与种子数据

**Files:**
- Create: `api/prisma/schema.prisma`
- Create: `api/prisma/seed.ts`
- Create: `api/.env.example`
- Create: `api/.env`（不入库）
- Modify: `api/package.json`（加 `prisma.seed` 与脚本）

- [ ] **Step 1: 编写 `api/.env.example`**

```bash
# 开发库（宿主机端口 15432，容器内 5432）
DATABASE_URL="postgresql://ecommerce:ecommerce@localhost:15432/ecommerce?schema=public"

# 测试库（e2e 用，与开发库物理隔离）
DATABASE_URL_TEST="postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public"

# 应用
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1

# JWT
JWT_SECRET="change-me-in-production-at-least-32-chars-long"
JWT_EXPIRES_IN=2h
REFRESH_TOKEN_TTL_DAYS=30
```

- [ ] **Step 2: 创建开发库与测试库**

Run:
```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d postgres -c "CREATE DATABASE ecommerce_test;"
```
Expected: `CREATE DATABASE`
（开发库 `ecommerce` 已由 docker-compose 的 `POSTGRES_DB` 创建。注意容器名是 `ecommerce-postgres`，宿主机连接端口是 15432。）

- [ ] **Step 3: 编写 `api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  PLATFORM_ADMIN
  MERCHANT_OWNER
  MERCHANT_STAFF
  CUSTOMER
}

enum TenantStatus {
  TRIAL
  ACTIVE
  SUSPENDED
}

enum StoreStatus {
  DRAFT
  LIVE
  PAUSED
}

model Tenant {
  id        String       @id @default(uuid())
  name      String
  subdomain String       @unique
  status    TenantStatus @default(TRIAL)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  users  User[]
  stores Store[]

  @@map("tenants")
}

model User {
  id           String   @id @default(uuid())
  tenantId     String?
  email        String
  phone        String?
  passwordHash String
  displayName  String
  role         UserRole
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tenant        Tenant?         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  refreshTokens RefreshToken[]

  // 同一租户内邮箱唯一。PostgreSQL 的复合唯一约束在 tenantId 为 NULL 时不参与判定，
  // 因此平台超管（tenantId = null）的邮箱唯一性由迁移 add_user_email_ci_unique
  // 里的部分唯一索引 users_platform_admin_email_key 保证；
  // 租户内的大小写不敏感唯一性由表达式唯一索引 users_email_ci_key 保证。
  // 这两个索引由原生 SQL 创建，Prisma schema 无法表达，也因此不会出现在下面——
  // 不要删除本行的 @@unique，它是 db push 等同步路径下唯一的兜底约束。
  @@unique([tenantId, email])
  // 配合应用层统一小写化的 email 精确查询
  @@index([email])
  @@map("users")
}

model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("refresh_tokens")
}

model Store {
  id            String      @id @default(uuid())
  tenantId      String
  name          String
  slug          String
  status        StoreStatus @default(DRAFT)
  themeTokens   Json        @default("{}")
  paymentConfig Json        @default("{}")
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, slug])
  @@map("stores")
}
```

> `stores` 上不要单独建 `@@index([tenantId])`：`@@unique([tenantId, slug])` 的最左前缀已经能服务「按 tenantId 查该租户的店铺」（`EXPLAIN` 确认走 `stores_tenantId_slug_key`），多维护一份索引只会拖慢写入。后续所有带 `tenantId` 的业务表都遵循这个策略。

- [ ] **Step 4: 生成客户端并执行迁移**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && cp .env.example .env && npx prisma migrate dev --name init_tenant_identity
```
Expected: 输出 `Your database is now in sync with your schema.` 且生成 `prisma/migrations/xxx_init_tenant_identity/`

紧接着补一条原生 SQL 迁移，修复 Prisma schema 表达不了的两条唯一性约束：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx prisma migrate dev --name add_user_email_ci_unique --create-only
```

生成的迁移文件里 Prisma 只会写 `DROP INDEX "stores_tenantId_idx";`（因为 Step 3 去掉了冗余的 `@@index([tenantId])`），需要手工追加两条索引：

```sql
-- DropIndex
DROP INDEX "stores_tenantId_idx";

-- 大小写不敏感的租户内邮箱唯一。
-- Prisma 的 @@unique([tenantId, email]) 是大小写敏感的，且在 tenantId 为 NULL 时
-- 完全不参与唯一性判定，无法表达这两条业务约束，因此用原生 SQL 建表达式唯一索引。
CREATE UNIQUE INDEX "users_email_ci_key" ON "users" (LOWER("email"), "tenantId");

-- 平台超管（tenantId 为 NULL）的邮箱唯一。
-- PostgreSQL 的 NULL 不参与唯一性判定，所以复合唯一约束对平台超管无效，
-- 这里用部分唯一索引单独兜住。
CREATE UNIQUE INDEX "users_platform_admin_email_key"
  ON "users" (LOWER("email"))
  WHERE "tenantId" IS NULL AND "role" = 'PLATFORM_ADMIN';
```

然后应用：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx prisma migrate dev
```
Expected: `Your database is now in sync with your schema.`，且 `npx prisma migrate status` 显示 `Database schema is up to date!`（Prisma 不会把这两条自定义索引当成漂移）

**验证约束真的生效**（三条都要符合预期）：

```bash
# 1) 平台超管重复邮箱（大小写变体）应报 users_platform_admin_email_key
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "INSERT INTO users (id,\"tenantId\",email,\"passwordHash\",\"displayName\",role,\"createdAt\",\"updatedAt\") VALUES ('probe1',NULL,'Admin@platform.test','h','x','PLATFORM_ADMIN',now(),now());"

# 2) 租户内同邮箱大小写变体应报 users_email_ci_key
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "INSERT INTO tenants (id,name,subdomain,status,\"createdAt\",\"updatedAt\") VALUES ('probe-t1','P','probe-1','TRIAL',now(),now());"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "INSERT INTO users (id,\"tenantId\",email,\"passwordHash\",\"displayName\",role,\"createdAt\",\"updatedAt\") VALUES ('probe2','probe-t1','Bob@x.com','h','x','CUSTOMER',now(),now());"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "INSERT INTO users (id,\"tenantId\",email,\"passwordHash\",\"displayName\",role,\"createdAt\",\"updatedAt\") VALUES ('probe3','probe-t1','bob@x.com','h','x','CUSTOMER',now(),now());"

# 3) 不同租户同邮箱应成功
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "INSERT INTO tenants (id,name,subdomain,status,\"createdAt\",\"updatedAt\") VALUES ('probe-t2','P2','probe-2','TRIAL',now(),now());"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "INSERT INTO users (id,\"tenantId\",email,\"passwordHash\",\"displayName\",role,\"createdAt\",\"updatedAt\") VALUES ('probe4','probe-t2','bob@x.com','h','x','CUSTOMER',now(),now());"

# 清理探针数据
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "DELETE FROM tenants WHERE id LIKE 'probe-%'; DELETE FROM users WHERE id LIKE 'probe%';"
```

- [ ] **Step 5: 编写 `api/prisma/seed.ts`**

种子数据只创建**平台超管**，商家账号由注册流程产生（保证每家租户数据都是真实走通流程的）。

```typescript
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
  const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';

  const existing = await prisma.user.findFirst({
    where: { email, role: UserRole.PLATFORM_ADMIN },
  });

  if (existing) {
    console.log(`平台超管已存在，跳过：${email}`);
    return;
  }

  try {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        displayName: '平台超管',
        role: UserRole.PLATFORM_ADMIN,
        tenantId: null,
      },
    });
  } catch (error) {
    // 平台超管邮箱由部分唯一索引 users_platform_admin_email_key 兜底，
    // 并发执行 seed 时后到的一方会撞唯一约束，此时同样视为幂等成功。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      console.log(`平台超管已存在（并发创建），跳过：${email}`);
      return;
    }
    throw error;
  }

  console.log(`已创建平台超管：${email} / ${password}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 6: 配置 seed 脚本与 npm scripts**

修改 `api/package.json` 的 `scripts` 与新增 `prisma` 字段：

```json
{
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main",
    "test": "jest --passWithNoTests",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage --passWithNoTests",
    "test:e2e": "jest --config ./test/jest-e2e.json --runInBand",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:deploy": "prisma migrate deploy",
    "prisma:seed": "prisma db seed",
    "lint": "eslint \"{src,apps,libs,test}/**/*.ts\""
  },
  "prisma": {
    "seed": "ts-node --compiler-options {\"module\":\"CommonJS\"} prisma/seed.ts"
  }
}
```

三点必须注意：

1. **`lint` 的 glob 保持 `{src,apps,libs,test}/**/*.ts`**，不要收窄成 `src/**/*.ts`。阶段 1 的 21 个 e2e 用例全部在 `test/` 目录下，收窄后这些文件将完全脱离 lint 检查。
2. **`lint` 不带 `--fix`**。带 `--fix` 时它会静默改文件后返回 0，掩盖真实问题；修格式交给 `npm run format`。
3. **`test` 与 `test:cov` 都要带 `--passWithNoTests`**。Task 4 补上第一个单元测试前，没有测试文件时 jest 会以退出码 1 结束。
4. **`prisma:migrate`（`migrate dev`）仅限本地开发**。它会检测到 schema 与数据库不一致时自动生成并执行新迁移，在生产上执行轻则意外 DDL、重则在非交互管道里接受数据丢失。生产与 CI 一律用 `prisma:deploy`（`migrate deploy`）——Task 4 的 e2e globalSetup 与 Task 13 的部署流程都走 `prisma:deploy`。

同时修改 `api/package.json` 的 `jest` 字段，把 `collectCoverageFrom` 收窄：

```json
"jest": {
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "src",
  "testRegex": ".*\\.spec\\.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "collectCoverageFrom": ["**/*.(t|j)s", "!main.ts", "!**/*.module.ts"]
}
```

排除 `main.ts` 是因为它只在 `start:prod` 执行，单元测试永远碰不到，结构性 0%；排除 `*.module.ts` 是因为它们只是装饰器元数据。两者都会长期拖低 Task 13 的 60% 覆盖率目标，越早排除越省事。

> **注意排除模式不能写 `!src/main.ts`**：jest 的 `collectCoverageFrom` glob 是相对 `rootDir` 解析的，而这里的 `rootDir` 是 `src`，所以要用 `!main.ts` 和 `!**/*.module.ts`。写成 `!src/main.ts` 会匹配不到任何东西，排除静默失效。
>
> **关于 `.env` 的加载**：jest 本身不加载 `.env`，但 **Prisma Client 初始化时会自己加载**（生成的 client 内置了 dotenv，且不覆盖已存在的环境变量）。所以单元测试在没有额外配置的情况下会连上 `.env` 里的**开发库**。Task 4 起加 `setupFiles` 把 `DATABASE_URL` 重定向到 `DATABASE_URL_TEST`，让单元测试也跑在测试库上。

- [ ] **Step 7: 执行种子**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx prisma db seed
```
Expected: 输出 `已创建平台超管：admin@platform.test / Admin12345!`

- [ ] **Step 8: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/prisma api/package.json api/.env.example && git commit -m "feat(api): Prisma 数据模型、迁移与平台超管种子数据"
```

---

## Task 4：租户上下文与隔离版 PrismaClient（核心）

> **实施说明（本任务的实际实现与下方原始设计有两处 Prisma 6 适配差异，代码以仓库里的 `api/src/common/tenant/tenant-prisma.service.ts` 为准）**
>
> **差异 1：Prisma 6 移除了 `PrismaClientOptions.extensions` 构造选项**，扩展只能通过实例方法 `new PrismaClient().$extends(extension)` 应用。因此 `class TenantPrismaService extends PrismaClient` **不会**把扩展带到子类实例上（实测：子类实例的 delegate 是裸的，所有拦截都失效）。实现改为**包装**而非继承：内部持有 `$extends(tenantExtension)` 后的实例，通过 getter 把 `user` / `store` / `tenant` / `refreshToken` 等 delegate 与 `$transaction` / `$queryRaw` 等实例方法代理出来，对外仍是 `prisma.user.findMany(...)` 的写法。
>
> **差异 2：Prisma 6 的 query 调用返回 `PrismaPromise`（thenable 而非原生 Promise）**，而 `AsyncLocalStorage` 只能沿**原生 Promise** 的 then 链传播上下文。实测：同步回调 `run(ctx, () => prismaPromise)` 在 then 回调执行时 `getStore()` 返回 `undefined`——**租户上下文整个丢失，隔离机制静默失效**；改成 `run(ctx, async () => prismaPromise)` 后上下文正常保留。
>
> 由此得出贯穿全项目的硬性约束：
>
> > **所有 `tenantContext.run(...)` 的回调一律写成 `async () => ...`。**
>
> Task 4 的单元测试、Task 5 的拦截器、Task 6 与 Task 8 的服务层都必须遵守。Task 5 另有一条端到端验证（走真实 HTTP 请求）专门盯这条约束。
>
> **实施补充（代码审查阶段发现并已修复）**
>
> 审查用真实租户实测发现：**Prisma 6 里还有三个方法没被扩展覆盖，构成稳定的跨租户越权通道**——`upsert`（`where` 只能是唯一字段，无法附加 tenantId）、`createManyAndReturn`、`updateManyAndReturn`。实测在租户 A 的上下文里，租户 B 的店铺被改名为 `PWNED2` 并凭空多出一条。
>
> 修法：`upsert` 与既有的 `findUnique` / `update` / `delete` 同策略——**在租户作用域模型上直接拒绝**；`createManyAndReturn` / `updateManyAndReturn` 补上与 `createMany` / `updateMany` 同样的 handler。
>
> 同时修掉一个**误报**：嵌套写检查原先按 key 名黑名单判定，把 `themeTokens`（Json 类型的商家主题配置）里的 `push` / `set` 当成了 Prisma 的关系嵌套写。改为**schema 驱动**——用 `Prisma.dmmf` 取出模型的关系字段名，只有关系字段下的对象/数组才判定为嵌套写。
>
> 还有一条**收敛决策**：原生 SQL 旁路（`$queryRaw` / `$executeRaw` 系列）不经过扩展、完全不设防，阶段 1 又用不到，因此**从 Service 上移除这四个 getter**。将来真需要时，以显式注入 tenantId 条件的专用 wrapper 形式加回，而不是裸暴露 Prisma 原方法。`$transaction` 保留——实测交互式事务里的 `tx` 客户端仍带租户扩展。

**Files:**
- Create: `api/src/common/tenant/tenant-context.ts`
- Create: `api/src/common/tenant/tenant-scope.error.ts`
- Create: `api/src/common/tenant/tenant-models.ts`
- Create: `api/src/common/tenant/tenant-prisma.service.ts`
- Create: `api/src/common/tenant/tenant-prisma.service.spec.ts`
- Create: `api/test/setup-e2e.ts`
- Modify: `api/test/jest-e2e.json`（加 `globalSetup`）
- Modify: `api/src/app.module.ts`（提供 PrismaService）

- [ ] **Step 1: 定义租户作用域错误**

`api/src/common/tenant/tenant-scope.error.ts`：

```typescript
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}
```

- [ ] **Step 2: 定义租户作用域模型白名单**

`api/src/common/tenant/tenant-models.ts`：

```typescript
/**
 * 租户作用域模型白名单。
 * 名单内的模型：所有读写自动追加 tenantId 条件。
 * 新增业务表时必须同步登记到此处，否则等于没有隔离。
 */
export const TENANT_SCOPED_MODELS = new Set<string>(['User', 'Store']);

/** Prisma 中不支持非唯一 where 条件、因此禁止在租户作用域模型上使用的方法 */
export const UNIQUE_ONLY_OPERATIONS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateOrThrow',
  'delete',
  'deleteOrThrow',
]);
```

- [ ] **Step 3: 定义租户上下文**

`api/src/common/tenant/tenant-context.ts`：

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { UserRole } from '@prisma/client';

export interface TenantContextValue {
  /** 当前租户 ID；null 表示平台作用域（仅 platform_admin 可用） */
  tenantId: string | null;
  /** 当前登录用户 ID；匿名请求为 null */
  userId: string | null;
  /** 当前用户角色；匿名请求为 null */
  role: UserRole | null;
}

export const tenantContext = new AsyncLocalStorage<TenantContextValue>();

export function getTenantContext(): TenantContextValue {
  const context = tenantContext.getStore();
  if (!context) {
    throw new Error('租户上下文不存在：请求未经过 TenantContextInterceptor');
  }
  return context;
}

/** 是否处于显式的平台作用域（可跨租户读） */
export function isPlatformScope(context: TenantContextValue | undefined): boolean {
  return (
    !!context &&
    context.tenantId === null &&
    context.role === UserRole.PLATFORM_ADMIN
  );
}

/**
 * 显式的平台作用域上下文。
 *
 * 跨租户读取必须显式调用本函数包裹，把跨租户行为收敛到可审计的少数几处。
 * 目前的使用点：登录时按邮箱跨租户查账号、JWT 验签后按 ID 查用户、
 * 按子域名公开查询店铺。
 */
export function platformScope(): TenantContextValue {
  return { tenantId: null, userId: null, role: UserRole.PLATFORM_ADMIN };
}
```

- [ ] **Step 4: 编写隔离版 PrismaClient**

`api/src/common/tenant/tenant-prisma.service.ts`：

```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantScopeError } from './tenant-scope.error';
import { TENANT_SCOPED_MODELS, UNIQUE_ONLY_OPERATIONS } from './tenant-models';
import { TenantContextValue, isPlatformScope, tenantContext } from './tenant-context';

/** 嵌套写操作在租户作用域模型上被禁止：嵌套 payload 无法自动注入 tenantId */
const NESTED_WRITE_KEYS = new Set([
  'connect',
  'connectOrCreate',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'set',
  'push',
]);

function assertNoNestedWrites(data: unknown, path: string): void {
  if (Array.isArray(data)) {
    data.forEach((item, index) => assertNoNestedWrites(item, `${path}[${index}]`));
    return;
  }
  if (data !== null && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (NESTED_WRITE_KEYS.has(key)) {
        throw new TenantScopeError(
          `租户作用域模型禁止嵌套写操作：${path}.${key}。请拆成两次独立调用。`,
        );
      }
      assertNoNestedWrites(value, `${path}.${key}`);
    }
  }
}

type ScopeDecision =
  /** 模型不在白名单内：不做任何租户处理 */
  | { kind: 'not-scoped' }
  /** 平台作用域：显式跨租户，不附加过滤 */
  | { kind: 'platform' }
  /** 租户作用域：附加 tenantId 过滤 */
  | { kind: 'tenant'; where: { tenantId: string } };

/**
 * 判定当前请求对某个模型的租户作用域。
 *
 * 关键点：只有白名单内的模型才受隔离约束。
 * 白名单外的模型（Tenant、RefreshToken 等）在任何上下文下都可访问，
 * 否则会因为缺少上下文而无法执行与租户无关的系统级操作。
 */
function resolveScope(
  model: string,
  context: TenantContextValue | undefined,
): ScopeDecision {
  if (!TENANT_SCOPED_MODELS.has(model)) {
    return { kind: 'not-scoped' };
  }
  if (!context) {
    throw new TenantScopeError(
      `模型 ${model} 是租户作用域的，但当前请求没有租户上下文，拒绝访问`,
    );
  }
  if (isPlatformScope(context)) {
    return { kind: 'platform' };
  }
  if (!context.tenantId) {
    throw new TenantScopeError(
      `模型 ${model} 是租户作用域的，但当前请求既不是租户作用域也不是平台作用域，拒绝访问`,
    );
  }
  return { kind: 'tenant', where: { tenantId: context.tenantId } };
}

@Injectable()
export class TenantPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      extensions: {
        query: {
          $allModels: {
            // ---------- 读操作：自动追加 tenantId 过滤 ----------

            async findMany({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            async findFirst({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            async findFirstOrThrow({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            async count({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            async aggregate({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            async groupBy({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            // ---------- 唯一性方法：直接拒绝，避免绕过隔离 ----------

            async findUnique({ model, args, query }) {
              this.assertNotUniqueOnly(model, 'findUnique');
              return query(args);
            },

            async findUniqueOrThrow({ model, args, query }) {
              this.assertNotUniqueOnly(model, 'findUniqueOrThrow');
              return query(args);
            },

            async update({ model, args, query }) {
              this.assertNotUniqueOnly(model, 'update');
              return query(args);
            },

            async updateOrThrow({ model, args, query }) {
              this.assertNotUniqueOnly(model, 'updateOrThrow');
              return query(args);
            },

            async delete({ model, args, query }) {
              this.assertNotUniqueOnly(model, 'delete');
              return query(args);
            },

            async deleteOrThrow({ model, args, query }) {
              this.assertNotUniqueOnly(model, 'deleteOrThrow');
              return query(args);
            },

            // ---------- 写操作：自动注入 tenantId ----------

            async create({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind === 'not-scoped') return query(args);

              if (scope.kind === 'platform') {
                // 平台作用域写入：要求调用方显式指定 tenantId
                const data = args.data as Record<string, unknown> | undefined;
                if (!data || typeof data.tenantId !== 'string') {
                  throw new TenantScopeError(
                    `模型 ${model} 的平台作用域写入必须显式指定 tenantId`,
                  );
                }
                return query(args);
              }

              assertNoNestedWrites(args.data, 'data');
              return query({
                ...args,
                data: { ...(args.data as object), ...scope.where },
              });
            },

            async createMany({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind === 'not-scoped') return query(args);

              const rows = Array.isArray(args.data) ? args.data : [args.data];

              if (scope.kind === 'platform') {
                // 平台作用域写入：每一行都必须显式指定 tenantId
                rows.forEach((row, index) => {
                  const data = row as Record<string, unknown> | undefined;
                  if (!data || typeof data.tenantId !== 'string') {
                    throw new TenantScopeError(
                      `模型 ${model} 的平台作用域批量写入必须为每一行显式指定 tenantId` +
                        `（第 ${index} 行缺失）`,
                    );
                  }
                });
                return query(args);
              }

              rows.forEach((row, index) => assertNoNestedWrites(row, `data[${index}]`));
              return query({
                ...args,
                data: rows.map((row) => ({ ...(row as object), ...scope.where })),
              });
            },

            async updateMany({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },

            async deleteMany({ model, args, query }) {
              const scope = resolveScope(model, tenantContext.getStore());
              if (scope.kind !== 'tenant') return query(args);
              return query({ ...args, where: { ...args.where, ...scope.where } });
            },
          },
        },
      },
    });
  }

  private assertNotUniqueOnly(model: string, operation: string): void {
    if (!TENANT_SCOPED_MODELS.has(model)) return;
    if (!UNIQUE_ONLY_OPERATIONS.has(operation)) return;
    throw new TenantScopeError(
      `模型 ${model} 是租户作用域的，禁止使用 ${operation}：` +
        `Prisma 的 ${operation} 只接受唯一字段，无法附加 tenantId 条件，会造成跨租户越权。` +
        `请改用 ${operation === 'findUnique' || operation === 'findUniqueOrThrow' ? 'findFirst' : operation.startsWith('update') ? 'updateMany' : 'deleteMany'}。`,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 5: 编写隔离机制单元测试**

`api/src/common/tenant/tenant-prisma.service.spec.ts`：

```typescript
import { TenantPrismaService } from './tenant-prisma.service';
import { TenantScopeError } from './tenant-scope.error';
import {
  TenantContextValue,
  platformScope,
  tenantContext,
} from './tenant-context';
import { UserRole } from '@prisma/client';

describe('租户隔离版 PrismaClient', () => {
  let prisma: TenantPrismaService;

  const tenantA: TenantContextValue = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    role: UserRole.MERCHANT_OWNER,
  };

  const platformContext: TenantContextValue = {
    tenantId: null,
    userId: 'admin',
    role: UserRole.PLATFORM_ADMIN,
  };

  beforeEach(() => {
    prisma = new TenantPrismaService();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it('租户作用域模型上调用 findUnique 会被拒绝', async () => {
    await expect(
      prisma.user.findUnique({ where: { id: 'whatever' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域模型上调用 update 会被拒绝', async () => {
    await expect(
      prisma.store.update({ where: { id: 'whatever' }, data: { name: 'x' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域模型上调用 delete 会被拒绝', async () => {
    await expect(
      prisma.store.delete({ where: { id: 'whatever' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('没有租户上下文时读取租户作用域模型会被拒绝', async () => {
    await expect(prisma.store.findMany()).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('平台作用域下读取租户作用域模型不加过滤', async () => {
    const result = await tenantContext.run(platformContext, () =>
      prisma.store.findMany(),
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it('非租户作用域模型不受隔离约束', async () => {
    // Tenant 不在白名单内，没有租户上下文也能查询
    await expect(
      prisma.tenant.findUnique({ where: { subdomain: 'not-exists-at-all' } }),
    ).resolves.toBeNull();
  });

  it('租户作用域内读取会自动附加 tenantId 条件', async () => {
    const result = await tenantContext.run(tenantA, () =>
      prisma.store.findMany(),
    );
    // 查询能正常执行，说明 where 被正确合并（无匹配数据时返回空数组）
    expect(result).toEqual([]);
  });

  it('平台作用域下的写入必须显式指定 tenantId', async () => {
    await expect(
      tenantContext.run(platformContext, () =>
        prisma.store.create({ data: { name: 'x', slug: 'x' } }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域内写入会自动注入 tenantId', async () => {
    // Store.tenantId 有指向 tenants 的外键，必须先建一个真实租户
    const tenant = await prisma.tenant.create({
      data: { name: '隔离测试租户', subdomain: `probe-tenant-${Date.now()}` },
    });

    const created = await tenantContext.run(
      { ...tenantA, tenantId: tenant.id },
      () =>
        prisma.store.create({
          data: { name: '隔离测试店铺', slug: 'probe-store' },
        }),
    );

    expect(created.tenantId).toBe(tenant.id);

    // 清理：删除租户会级联删掉它的店铺
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });
});
```

- [ ] **Step 6: 运行单元测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx jest src/common/tenant
```
Expected: `Tests: 9 passed, 9 total`

- [ ] **Step 7: 配置 e2e 全局准备（自动跑测试库迁移）**

e2e 必须跑在**测试库**上。但有两个坑：

1. **jest 不会自动加载 `.env`**（只有 Prisma CLI 会），所以 `globalSetup` 里读不到 `process.env.DATABASE_URL_TEST`
2. **`new PrismaClient()` 读的是 `DATABASE_URL`**，不显式改写的话，e2e 会连到**开发库**——测试数据会污染开发数据，"测试库与开发库物理隔离"就成了空话

`api/test/setup-e2e.ts`：

```typescript
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default function globalSetup(): void {
  // jest 不加载 .env，Prisma CLI 才加载。globalSetup 与测试进程都要自己读。
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL_TEST 环境变量，e2e 测试无法运行。请在 api/.env 中配置它。',
    );
  }

  // 让后续的 PrismaClient 实例连到测试库而不是开发库
  process.env.DATABASE_URL = url;

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
```

`api/test/setup.ts`：

```typescript
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// e2e 全部跑在测试库上
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

jest.setTimeout(30_000);
```

> `process.loadEnvFile()` 需要 Node 20.12+（本项目用 Node 26，可用）。它不会覆盖已存在的环境变量，所以命令行里显式传入的值优先级更高。

`api/test/jest-e2e.json` 改为：

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  },
  "globalSetup": "<rootDir>/test/setup-e2e.ts",
  "setupFilesAfterEnv": ["<rootDir>/test/setup.ts"]
}
```

**验证 e2e 真的跑在测试库上**（不是开发库）：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run test:e2e
```
预期：测试通过。执行后查两个库的表数确认数据落在测试库：
```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -q -c "SELECT count(*) FROM stores;"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce_test -q -c "SELECT count(*) FROM stores;"
```

- [ ] **Step 8: 注册 PrismaService 到 AppModule**

`api/src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenantPrismaService } from './common/tenant/tenant-prisma.service';

@Module({
  imports: [HealthModule],
  providers: [TenantPrismaService],
  exports: [TenantPrismaService],
})
export class AppModule {}
```

- [ ] **Step 9: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): 租户上下文与隔离版 PrismaClient"
```

---

## Task 5：租户解析与全局上下文拦截器

**Files:**
- Create: `api/src/modules/tenancy/tenant-resolver.service.ts`
- Create: `api/src/modules/tenancy/tenant-resolver.service.spec.ts`
- Create: `api/src/modules/tenancy/tenant-context.interceptor.ts`
- Create: `api/src/modules/tenancy/tenancy.module.ts`
- Modify: `api/src/main.ts`（注册全局拦截器）

- [ ] **Step 1: 编写租户解析服务**

`api/src/modules/tenancy/tenant-resolver.service.ts`：

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { Tenant, TenantStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

@Injectable()
export class TenantResolverService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 根据子域名解析租户。
   * 注意：租户表本身不是租户作用域模型，此处查询不经过隔离扩展。
   */
  async resolveBySubdomain(subdomain: string): Promise<Tenant> {
    const normalized = subdomain.trim().toLowerCase();
    if (!normalized) {
      throw new NotFoundException('未指定店铺子域名');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { subdomain: normalized },
    });

    if (!tenant) {
      throw new NotFoundException(`店铺 ${normalized} 不存在`);
    }
    if (tenant.status === TenantStatus.SUSPENDED) {
      throw new NotFoundException(`店铺 ${normalized} 已被暂停`);
    }

    return tenant;
  }

  /** 从请求头或 host 中提取子域名 */
  static extractSubdomain(
    headers: Record<string, string | string[] | undefined>,
    host: string | undefined,
  ): string | null {
    const explicit = headers['x-tenant-subdomain'];
    if (typeof explicit === 'string' && explicit.trim()) {
      return explicit.trim().toLowerCase();
    }
    if (!host) return null;

    const hostname = host.split(':')[0].toLowerCase();
    // 形如 <tenant>.platform.test / <tenant>.localhost / <tenant>.example.com
    const parts = hostname.split('.');
    if (parts.length < 2) return null;
    return parts[0];
  }
}
```

- [ ] **Step 2: 编写租户解析单元测试**

`api/src/modules/tenancy/tenant-resolver.service.spec.ts`：

```typescript
import { TenantResolverService } from './tenant-resolver.service';

describe('TenantResolverService.extractSubdomain', () => {
  it('优先使用 X-Tenant-Subdomain 头', () => {
    const result = TenantResolverService.extractSubdomain(
      { 'x-tenant-subdomain': 'acme' },
      'ignored.platform.test',
    );
    expect(result).toBe('acme');
  });

  it('从 host 提取子域名', () => {
    const result = TenantResolverService.extractSubdomain({}, 'acme.platform.test');
    expect(result).toBe('acme');
  });

  it('host 带端口时忽略端口', () => {
    const result = TenantResolverService.extractSubdomain({}, 'acme.platform.test:3000');
    expect(result).toBe('acme');
  });

  it('host 无点号时返回 null', () => {
    const result = TenantResolverService.extractSubdomain({}, 'localhost');
    expect(result).toBeNull();
  });

  it('无任何信息时返回 null', () => {
    const result = TenantResolverService.extractSubdomain({}, undefined);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: 编写全局上下文拦截器**

`api/src/modules/tenancy/tenant-context.interceptor.ts`：

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { TenantContextValue, tenantContext } from '../../common/tenant/tenant-context';
import { TenantResolverService } from './tenant-resolver.service';

interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  tenantId: string | null;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly resolver: TenantResolverService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();

    // buildContext 是异步的（要查租户表），必须先 await 再把上下文写进
    // AsyncLocalStorage。用 from + switchMap 把 Promise 转成 Observable，
    // 异常会沿 observable 的 error 通道冒泡到全局异常过滤器。
    return from(this.buildContext(request)).pipe(
      switchMap(
        (contextValue) =>
          new Observable((subscriber) => {
            // ⚠️ 这里的 run() 回调必须是 async 函数，不能是同步函数。
            //
            // 原因：Prisma 6 的 query 调用返回的是 PrismaPromise（thenable 而非
            // 原生 Promise），真正的 SQL 执行发生在它的 then() 被调用时。
            // AsyncLocalStorage 只能沿**原生 Promise** 的 then 链传播上下文；
            // 同步回调返回 thenable 时，then 回调执行时 getStore() 返回 undefined，
            // 租户上下文会整个丢失——隔离机制在 HTTP 请求下会静默失效。
            //
            // 用 async 回调后 run() 返回真正的 Promise，ALS 会沿 then 链把上下文
            // 带到查询执行的那一刻。
            void tenantContext.run(contextValue, async () => {
              try {
                // 订阅动作也在作用域内完成，确保控制器方法返回的 PrismaPromise
                // 在这里被 await（即调用 then）时上下文仍然有效。
                const value = await lastValueFrom(next.handle());
                subscriber.next(value);
                subscriber.complete();
              } catch (error) {
                subscriber.error(error);
              }
            });
          }),
      ),
    );
  }

  private async buildContext(request: Request): Promise<TenantContextValue> {
    const user = (request as Request & { user?: AuthenticatedUser }).user;

    // 已认证请求：身份来自 JWT，租户范围也随之确定
    if (user) {
      return {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      };
    }

    // 匿名请求：从子域名解析租户（店铺前台场景）
    const subdomain = TenantResolverService.extractSubdomain(
      request.headers as Record<string, string | string[] | undefined>,
      request.hostname || undefined,
    );

    if (!subdomain) {
      throw new NotFoundException('无法确定店铺，请通过店铺子域名访问');
    }

    const tenant = await this.resolver.resolveBySubdomain(subdomain);

    return {
      tenantId: tenant.id,
      userId: null,
      role: null,
    };
  }
}
```

> **这个 async 约束必须在 Task 4、5、6、8 的所有 `tenantContext.run(...)` 调用点遵守**：回调一律写成 `async () => ...`。Task 4 的单元测试里已经踩过这个坑并留了注释。
>
> **实施补充（代码审查阶段发现）**
>
> 审查指出并已修复的几个问题，实现时不要重犯：
>
> 1. **`X-Tenant-Subdomain` 头的信任模型必须写进代码注释**：该头由**网关**从 Host 反推后注入，不是给客户端用的。子域名是路由标识不是凭证，猜到别人的子域名就能以那个租户身份发请求。真正的访问控制来自认证。**网关（Task 13 的 Nginx 配置）必须先剥除客户端传来的同名头**。
> 2. **平台保留子域名**（`admin` / `api` / `www` / `platform` 等）不允许解析，防止子域名接管，也避免攻击者通过响应差异枚举商家目录。名单在 `api/src/common/tenant/tenant-models.ts` 的 `RESERVED_SUBDOMAINS`。
> 3. **`AsyncLocalStorage.run` 是栈式的**：内层 `run` 替换当前上下文，内层结束后自动还原外层。Task 8 写「租户请求里临时以平台作用域查一次全局表」时依赖这个契约。
> 4. **e2e 的 supertest 类型断言集中到 `api/test/helpers.ts` 的 `http(app)`**，避免 `no-unsafe-argument` warning 随 e2e 文件数线性增长。
> 5. **子域名格式的正则必须引用公共常量 `SUBDOMAIN_PATTERN`**（见 `api/src/common/tenant/tenant-models.ts`），写入侧与读取侧共用，不要各自复制。

- [ ] **Step 4: 编写 tenancy 模块**

`api/src/modules/tenancy/tenancy.module.ts`：

```typescript
import { Global, Module } from '@nestjs/common';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantContextInterceptor } from './tenant-context.interceptor';

@Global()
@Module({
  providers: [TenantResolverService, TenantContextInterceptor],
  exports: [TenantResolverService, TenantContextInterceptor],
})
export class TenancyModule {}
```

- [ ] **Step 5: 在 `main.ts` 注册全局拦截器**

`api/src/main.ts` 改为：

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { TenantContextInterceptor } from './modules/tenancy/tenant-context.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(app.get(TenantContextInterceptor));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API 已启动：http://localhost:${port}/api/v1`);
}

void bootstrap();
```

- [ ] **Step 6: 在 AppModule 中引入 TenancyModule**

`api/src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { TenantPrismaService } from './common/tenant/tenant-prisma.service';

@Module({
  imports: [HealthModule, TenancyModule],
  providers: [TenantPrismaService],
  exports: [TenantPrismaService],
})
export class AppModule {}
```

- [ ] **Step 7: 健康检查改为免租户**

`api/src/health/health.controller.ts` 改为：

```typescript
import { Controller, Get, Skip } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @Skip()
  @ApiOperation({ summary: '存活探针' })
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
```

- [ ] **Step 8: 创建跳过装饰器**

`api/src/common/decorators/skip.decorator.ts`：

```typescript
import { SetMetadata } from '@nestjs/common';

export const SKIP_KEY = 'skip:interceptors';

/** 标记该路由不经过租户上下文拦截器（健康检查等公共端点） */
export const Skip = () => SetMetadata(SKIP_KEY, true);
```

在 `api/src/modules/tenancy/tenant-context.interceptor.ts` 顶部补充跳过逻辑——在 `intercept` 开头加入：

```typescript
import { Reflector } from '@nestjs/core';
import { SKIP_KEY } from '../../common/decorators/skip.decorator';

// 构造函数改为注入 Reflector
constructor(
  private readonly resolver: TenantResolverService,
  private readonly reflector: Reflector,
) {}

// intercept 方法开头插入
const skip = this.reflector.getAllAndOverride<boolean>(SKIP_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (skip) {
  return next.handle();
}
```

- [ ] **Step 9: 编写 e2e 测试：健康检查可用，店铺接口需要租户**

`api/test/tenancy.e2e-spec.ts`：

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('租户上下文 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('健康检查不要求租户上下文', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health');
    expect(response.status).toBe(200);
  });

  it('缺少子域名时返回 404', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/whatever');
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 10: 编写贯穿全链路的隔离验证 e2e**

单元测试证明不了「NestJS 拦截器 → AsyncLocalStorage → Prisma extension → SQL」这条链路上上下文不会丢。Task 4 已经验证过 Prisma 6 的 PrismaPromise（thenable）会让同步 `run()` 回调丢失上下文，所以这里必须有一个真正走 HTTP 的验证。

新建 `api/test/tenant-isolation.e2e-spec.ts`：

```typescript
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import { HealthModule } from '../src/health/health.module';
import { TenancyModule } from '../src/modules/tenancy/tenancy.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';

/** 只在测试里存在的探针控制器，用来验证租户上下文真的到达了 SQL */
@Controller('probe')
class ProbeController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get('stores')
  stores() {
    // 走的是租户作用域模型，隔离机制会在这里生效
    return this.prisma.store.findMany();
  }
}

@Module({
  imports: [HealthModule, TenancyModule],
  controllers: [ProbeController],
  providers: [TenantPrismaService],
})
class ProbeModule {}

describe('租户隔离全链路 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致：全局拦截器是租户上下文的唯一入口
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();

    prisma = app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('租户 A 的请求只能看到自己的店铺', async () => {
    const subA = `iso-a-${unique()}`;
    const subB = `iso-b-${unique()}`;

    const tenantA = await prisma.tenant.create({
      data: { name: '隔离商家 A', subdomain: subA },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: '隔离商家 B', subdomain: subB },
    });

    // 在租户 A 的上下文里建一个店铺。
    // 必须走 tenantContext.run 的 async 回调——同步回调会因为 Prisma 6 的
    // PrismaPromise 是 thenable 而丢失上下文，扩展会因「没有租户上下文」直接拒绝。
    const store = await tenantContext.run(
      { tenantId: tenantA.id, userId: null, role: UserRole.MERCHANT_OWNER },
      async () =>
        prisma.store.create({
          data: {
            name: 'A 的店铺',
            slug: 'a-store',
          } as unknown as Prisma.StoreCreateInput,
        }),
    );

    const responseA = await request(app.getHttpServer())
      .get('/api/v1/probe/stores')
      .set('X-Tenant-Subdomain', subA);

    const responseB = await request(app.getHttpServer())
      .get('/api/v1/probe/stores')
      .set('X-Tenant-Subdomain', subB);

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    // A 能看到自己的店铺
    expect(responseA.body).toHaveLength(1);
    expect(responseA.body[0].id).toBe(store.id);

    // B 看不到 A 的店铺 —— 这是整个隔离机制的核心保证
    expect(responseB.body).toHaveLength(0);

    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA.id, tenantB.id] } },
    });
  });

  it('缺少子域名时探针接口返回 404', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/probe/stores');
    expect(response.status).toBe(404);
  });
});
```

> 如果第一个用例里 `responseA.body` 长度是 0 而不是 1，说明 **AsyncLocalStorage 的上下文在 NestJS 管线里丢了**——多半是拦截器的 `run()` 回调写成了同步函数。回到 Step 3 确认回调是 `async () => {...}`。

- [ ] **Step 11: 运行测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx jest src/modules/tenancy && npm run test:e2e
```
Expected: 单元测试 5 passed；e2e 2 passed

- [ ] **Step 12: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): 租户解析与全局上下文拦截器"
```

---

## Task 6：认证模块（注册 / 登录 / 刷新 / 登出）

> **实施说明（实现阶段发现并已修复的几处，后续任务务必沿用）**
>
> 1. **`@nestjs/jwt` 与 `@nestjs/passport` 是纯 ESM 包**（`"type": "module"`）。Jest 的 CommonJS 运行时无法 require，会导致**全部 e2e 套件挂掉**。修法：`api/test/jest-e2e.json` 加
>    ```json
>    "transformIgnorePatterns": ["node_modules/(?!(@nestjs/jwt|@nestjs/passport)/)"]
>    ```
> 2. **所有 e2e 都要挂上与 `main.ts` 一致的 `ValidationPipe`**。不挂的话 DTO 校验（email 格式、密码规则、子域名格式、保留子域名）在 e2e 里完全没被验证过，API 契约等于没测。
> 3. **e2e 的 `globalSetup` 要在 `migrate deploy` 之后再 seed 一次**。否则测试库里没有平台超管，平台后台的 e2e 无从下手。`prisma/seed.ts` 是幂等的，重复跑安全。
> 4. **刷新令牌的重放检测要用 `revokedReason` 区分原因**，不能只看 `revokedAt`。`ROTATED`（被轮换）后再次出现 = 令牌可能泄露 → 吊销该用户全部令牌；`LOGOUT`（用户主动登出）后再次出现 = 误用 → 只返回 401，**不牵连其它设备**。多设备并存是商家常态，混为一谈会互相踢下线。两次写入要用 `$transaction` 保证原子。
> 5. `register/customer` **不能加 `@Skip()`**：消费者要注册到具体店铺名下，必须由租户拦截器按子域名解析出租户上下文。缺子域名时由拦截器返回 404。
> 6. `login` / `register/merchant` / `refresh` / `logout` **要加 `@Skip()`**：它们发生在中心域名，不属于任何具体店铺；`login` 本身还要跨租户按邮箱查账号。
> 7. 所有 `tenantContext.run(...)` 的回调**必须**是 `async () => ...`（Prisma 6 的 PrismaPromise 是 thenable）。

**Files:**
- Create: `api/src/modules/auth/dto/register-merchant.dto.ts`
- Create: `api/src/modules/auth/dto/register-customer.dto.ts`
- Create: `api/src/modules/auth/dto/login.dto.ts`
- Create: `api/src/modules/auth/dto/refresh.dto.ts`
- Create: `api/src/modules/auth/auth.service.ts`
- Create: `api/src/modules/auth/auth.controller.ts`
- Create: `api/src/modules/auth/jwt.strategy.ts`
- Create: `api/src/modules/auth/jwt-auth.guard.ts`
- Create: `api/src/common/decorators/current-user.decorator.ts`
- Create: `api/src/modules/auth/auth.module.ts`
- Create: `api/src/modules/auth/token.util.ts`
- Create: `api/test/auth.e2e-spec.ts`

- [ ] **Step 1: 编写令牌工具**

`api/src/modules/auth/token.util.ts`：

```typescript
import { createHash, randomBytes } from 'node:crypto';

const REFRESH_TOKEN_BYTES = 30;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 2: 编写 DTO**

`api/src/modules/auth/dto/register-merchant.dto.ts`：

```typescript
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { SUBDOMAIN_PATTERN } from '../../common/tenant/tenant-models';

export class RegisterMerchantDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(160)
  email!: string;

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(72)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: '密码必须同时包含字母和数字',
  })
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  merchantName!: string;

  @IsString()
  @Matches(SUBDOMAIN_PATTERN, {
    message: '子域名只能包含小写字母、数字和连字符，长度 3-32',
  })
  subdomain!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  storeName!: string;
}
```

`api/src/modules/auth/dto/register-customer.dto.ts`：

```typescript
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterCustomerDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(160)
  email!: string;

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  displayName!: string;
}
```

`api/src/modules/auth/dto/login.dto.ts`：

```typescript
import { IsEmail, IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export enum LoginScope {
  MERCHANT = 'MERCHANT',
  CUSTOMER = 'CUSTOMER',
  PLATFORM = 'PLATFORM',
}

export class LoginDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(160)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;

  @IsEnum(LoginScope, { message: 'scope 必须是 MERCHANT / CUSTOMER / PLATFORM' })
  scope!: LoginScope;
}
```

`api/src/modules/auth/dto/refresh.dto.ts`：

```typescript
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken!: string;
}
```

> **子域名格式必须引用公共常量**：`SUBDOMAIN_PATTERN` 定义在 `api/src/common/tenant/tenant-models.ts`，`register-merchant.dto.ts` 要 `@Matches(SUBDOMAIN_PATTERN, ...)`，**不要内联正则字面量**。读取侧（`TenantResolverService.extractSubdomain`）也用同一个常量做校验——两边一旦漂移，漂移是**静默**的：注册时被拒的格式仍然能从 Host 头解析进来。
>
> 验收时请确认 `api/src/common/tenant/tenant-models.ts` 里确实导出了 `SUBDOMAIN_PATTERN` 与 `isValidSubdomain()`（Task 5 已建），本步的 DTO 直接引用它们。

- [ ] **Step 3: 编写认证服务**

`api/src/modules/auth/auth.service.ts`：

```typescript
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import {
  generateRefreshToken,
  hashRefreshToken,
} from './token.util';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { LoginDto, LoginScope } from './dto/login.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  tenantId: string | null;
}

export interface AuthResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** 商家注册：一次创建租户 + 店主用户 + 首个店铺 */
  async registerMerchant(dto: RegisterMerchantDto): Promise<AuthResult> {
    const passwordHash = await argon2.hash(dto.password);
    const subdomain = dto.subdomain.toLowerCase();

    const existingTenant = await this.prisma.tenant.findFirst({
      where: { subdomain },
    });
    if (existingTenant) {
      throw new ConflictException(`子域名 ${dto.subdomain} 已被占用`);
    }

    const tenant = await this.prisma.tenant.create({
      data: { name: dto.merchantName, subdomain },
    });

    try {
      // 用户与店铺都属于租户作用域模型，必须在租户上下文内创建，
      // 这样 Prisma extension 才会自动注入 tenantId。
      //
      // ⚠️ run() 的回调必须是 async 函数：Prisma 6 的 PrismaPromise 是 thenable，
      // 同步回调会让 AsyncLocalStorage 的上下文在查询执行时丢失。
      const user = await tenantContext.run(
        {
          tenantId: tenant.id,
          userId: null,
          role: UserRole.MERCHANT_OWNER,
        },
        async () =>
          this.prisma.user.create({
            data: {
              email: dto.email.toLowerCase(),
              passwordHash,
              displayName: dto.merchantName,
              role: UserRole.MERCHANT_OWNER,
            },
          }),
      );

      await tenantContext.run(
        {
          tenantId: tenant.id,
          userId: null,
          role: UserRole.MERCHANT_OWNER,
        },
        async () =>
          this.prisma.store.create({
            data: {
              name: dto.storeName,
              slug: this.slugify(dto.storeName) || subdomain,
            },
          }),
      );

      return this.issueTokens(user);
    } catch (error) {
      // 创建用户或店铺失败时回滚租户，避免留下半成品租户
      await this.prisma.tenant.deleteMany({ where: { id: tenant.id } });
      throw error;
    }
  }

  /** 消费者注册：注册到当前子域名对应的租户 */
  async registerCustomer(dto: RegisterCustomerDto): Promise<AuthResult> {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new UnauthorizedException('无法确定店铺，缺少子域名');
    }

    const passwordHash = await argon2.hash(dto.password);

    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('该邮箱已注册');
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        displayName: dto.displayName,
        role: UserRole.CUSTOMER,
        tenantId: context.tenantId,
      },
    });

    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const email = dto.email.toLowerCase();

    const roleFilter = this.roleFilterFor(dto.scope);

    // 登录需要跨租户查找账号（用户输入邮箱时尚未确定属于哪个租户），
    // 因此显式使用平台作用域。密码校验通过后签发的 JWT 自带 tenantId，
    // 后续请求仍然按租户隔离。
    const candidates = await tenantContext.run(platformScope(), async () =>
      this.prisma.user.findMany({
        where: { email, ...roleFilter },
      }),
    );

    if (candidates.length === 0) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    for (const candidate of candidates) {
      const ok = await argon2.verify(candidate.passwordHash, dto.password);
      if (ok) {
        // 商家与消费者必须属于某个有效租户
        if (candidate.role !== UserRole.PLATFORM_ADMIN && !candidate.tenantId) {
          continue;
        }
        return this.issueTokens(candidate);
      }
    }

    throw new UnauthorizedException('邮箱或密码不正确');
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // 轮换：旧令牌立即吊销
    await this.prisma.refreshToken.updateMany({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private roleFilterFor(scope: LoginScope): Prisma.UserWhereInput {
    switch (scope) {
      case LoginScope.MERCHANT:
        return {
          role: { in: [UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF] },
        };
      case LoginScope.CUSTOMER:
        return { role: UserRole.CUSTOMER };
      case LoginScope.PLATFORM:
        return { role: UserRole.PLATFORM_ADMIN };
    }
  }

  /** 店铺 slug：优先取店铺名的拼音/英文形式，取不到则退回子域名 */
  private slugify(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private async issueTokens(user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    tenantId: string | null;
  }): Promise<AuthResult> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });

    const refreshToken = generateRefreshToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30));

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        tenantId: user.tenantId,
      },
      accessToken,
      refreshToken,
    };
  }
}
```

- [ ] **Step 4: 编写 JWT 策略与守卫**

`api/src/modules/auth/jwt.strategy.ts`：

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../../common/tenant/tenant-context';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: TenantPrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? 'change-me-in-production-at-least-32-chars-long',
    });
  }

  async validate(payload: JwtPayload) {
    // JWT 已通过签名校验，按 ID 查询用户是安全的跨租户读取。
    // 此处还处于 Guard 阶段，租户拦截器尚未执行，因此没有租户上下文，
    // 必须显式使用平台作用域。
    const user = await tenantContext.run(platformScope(), async () =>
      this.prisma.user.findFirst({
        where: { id: payload.sub },
      }),
    );

    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
```

`api/src/modules/auth/jwt-auth.guard.ts`：

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

- [ ] **Step 5: 编写当前用户装饰器**

`api/src/common/decorators/current-user.decorator.ts`：

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export interface CurrentUserPayload {
  userId: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload => {
    const request = context.switchToHttp().getRequest();
    return request.user as CurrentUserPayload;
  },
);
```

- [ ] **Step 6: 编写认证控制器**

`api/src/modules/auth/auth.controller.ts`：

```typescript
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Skip } from '../../common/decorators/skip.decorator';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/merchant')
  @Skip()
  @ApiOperation({ summary: '商家注册并开店' })
  registerMerchant(@Body() dto: RegisterMerchantDto) {
    return this.authService.registerMerchant(dto);
  }

  // 注意：register/customer 不能加 @Skip()。
  // 消费者要注册到某个具体店铺名下，必须由租户拦截器按子域名解析出租户上下文；
  // 跳过拦截器的话服务层拿不到 tenantId，注册必然失败。
  // 缺少子域名时由拦截器返回 404（无法确定店铺），这是正确的行为。
  @Post('register/customer')
  @ApiOperation({ summary: '消费者注册（需带店铺子域名）' })
  registerCustomer(@Body() dto: RegisterCustomerDto) {
    return this.authService.registerCustomer(dto);
  }

  // 登录也不加 @Skip()？—— 要加。
  // 登录发生在中心域名（api.platform.test / merchant.platform.test），
  // 不属于任何具体店铺，拦截器解析不出租户；而且登录本身就要跨租户按邮箱查账号。
  @Post('login')
  @HttpCode(200)
  @Skip()
  @ApiOperation({ summary: '登录' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  @Skip()
  @ApiOperation({ summary: '刷新令牌' })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @Skip()
  @ApiOperation({ summary: '登出（吊销刷新令牌）' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '当前登录用户' })
  me(@CurrentUser() user: CurrentUserPayload) {
    return user;
  }
}
```

- [ ] **Step 7: 编写认证模块**

`api/src/modules/auth/auth.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'change-me-in-production-at-least-32-chars-long',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '2h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
```

- [ ] **Step 8: 注册 AuthModule**

`api/src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantPrismaService } from './common/tenant/tenant-prisma.service';

@Module({
  imports: [HealthModule, TenancyModule, AuthModule],
  providers: [TenantPrismaService],
  exports: [TenantPrismaService],
})
export class AppModule {}
```

- [ ] **Step 9: 校验 JWT 密钥强度**

`api/.env.example` 里的 `JWT_SECRET` 占位符 `change-me-in-production-at-least-32-chars-long` 长度足够（46 字节，远超 HS256 要求的 256 bit），但它**看起来像一个合理的值**，没有任何机制阻止它被原样带进生产。补一道启动断言。

新建 `api/src/common/config/assert-secure-config.ts`：

```typescript
const PLACEHOLDER_SECRET = 'change-me-in-production-at-least-32-chars-long';

export function assertSecureConfig(): void {
  const secret = process.env.JWT_SECRET ?? '';

  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET 至少需要 32 个字符，当前只有 ${secret.length} 个。` +
        '请设置一个足够随机的密钥（可用 `openssl rand -base64 48` 生成）。',
    );
  }

  if (process.env.NODE_ENV === 'production' && secret === PLACEHOLDER_SECRET) {
    throw new Error(
      '生产环境禁止使用 .env.example 里的 JWT_SECRET 占位符，请换成真实密钥。',
    );
  }
}
```

在 `api/src/main.ts` 的 `bootstrap()` 里、创建 Nest 应用之前调用：

```typescript
import { assertSecureConfig } from './common/config/assert-secure-config';

async function bootstrap() {
  assertSecureConfig();

  const app = await NestFactory.create(AppModule);
  // ... 其余不变
}
```

> 注意：Task 5 会重写 `main.ts`（加全局前缀、ValidationPipe、全局拦截器），Task 9 会再加 Swagger 与异常过滤器。**这三次重写都要保留 `assertSecureConfig()` 这一行**，它是防止弱密钥上线的唯一一道闸。

- [ ] **Step 10: 编写认证 e2e 测试**

`api/test/auth.e2e-spec.ts`：

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';

describe('认证 (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');
  const subdomain = () => `shop-${unique()}`;
  const email = () => `merchant-${unique()}@example.test`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致：租户上下文拦截器是消费者注册能否拿到租户的前提
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('商家注册返回令牌与用户', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: email(),
        password: 'Passw0rd123',
        merchantName: '测试商家',
        subdomain: subdomain(),
        storeName: '测试店铺',
      });

    expect(response.status).toBe(201);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.refreshToken).toBeTruthy();
    expect(response.body.user.role).toBe('MERCHANT_OWNER');
    expect(response.body.user.tenantId).toBeTruthy();
  });

  it('子域名重复时注册失败', async () => {
    const taken = subdomain();
    const payload = {
      email: email(),
      password: 'Passw0rd123',
      merchantName: '商家甲',
      subdomain: taken,
      storeName: '店铺甲',
    };

    await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send(payload)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({ ...payload, email: email() })
      .expect(409);
  });

  it('商家登录成功返回令牌', async () => {
    const account = email();
    const sub = subdomain();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家乙',
        subdomain: sub,
        storeName: '店铺乙',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
  });

  it('密码错误时登录返回 401', async () => {
    const account = email();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家丙',
        subdomain: subdomain(),
        storeName: '店铺丙',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'WrongPassw0rd', scope: 'MERCHANT' })
      .expect(401);
  });

  it('刷新令牌可换取新令牌，旧令牌随即失效', async () => {
    const account = email();

    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家丁',
        subdomain: subdomain(),
        storeName: '店铺丁',
      })
      .expect(201);

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: register.body.refreshToken })
      .expect(200);

    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.body.refreshToken).not.toBe(register.body.refreshToken);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: register.body.refreshToken })
      .expect(401);
  });

  it('消费者注册需要店铺子域名', async () => {
    const sub = subdomain();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: email(),
        password: 'Passw0rd123',
        merchantName: '商家戊',
        subdomain: sub,
        storeName: '店铺戊',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register/customer')
      .set('X-Tenant-Subdomain', sub)
      .send({
        email: `customer-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '顾客',
      });

    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('CUSTOMER');
  });

  it('无子域名时消费者注册返回 404', async () => {
    // register/customer 不加 @Skip()，由租户拦截器按子域名解析租户；
    // 解析不出来时拦截器直接返回 404（无法确定店铺）
    await request(app.getHttpServer())
      .post('/api/v1/auth/register/customer')
      .send({
        email: `customer-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '顾客',
      })
      .expect(404);
  });
});
```

- [ ] **Step 11: 运行 e2e 测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run test:e2e
```
Expected: `Tests: 7 passed, 7 total`

> 如果出现 `TenantScopeError`，说明注册流程里嵌套 `users.create` 触发了护栏。修正方式：改为先建租户，再用带 `tenantId` 的独立 `prisma.user.create` 调用。

- [ ] **Step 12: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): 认证模块，注册登录刷新登出与令牌轮换"
```

---

## Task 7：RBAC 角色守卫与越权防护

> **实施说明（实现阶段发现的一处关键事实，务必记住）**
>
> **NestJS 的守卫执行顺序是 `[...全局, ...类级, ...方法级]`**（见 `@nestjs/core/helpers/context-creator.js` 的 `createContext`）——**全局守卫最先跑**，早于路由级 `@UseGuards`。
>
> 因此 `RolesGuard` **不能**注册成 `APP_GUARD`：那样它会在 `JwtAuthGuard` 之前执行，`request.user` 还没填，所有请求都会被判成「需要登录后访问」，**鉴权静默失效**。
>
> 正确做法：`@Roles()` 装饰器内部用**一次** `UseGuards(JwtAuthGuard, RolesGuard)` 显式排定顺序——数组顺序即执行顺序，认证必然先于鉴权。
>
> 也不要依赖装饰器堆叠顺序：方法装饰器由 TS 自下而上应用，分开写 `@UseGuards(JwtAuthGuard)` 和 `@Roles()` 时谁先注册取决于源码里谁写在下面，顺序是隐式的、写错就静默越权。
>
> 副作用（且是想要的）：标了 `@Roles()` 的路由自动带认证，未登录访问得 **401** 而不是 403，两种失败语义不混淆。
>
> 写这类守卫的测试时，务必做一次**恒真自检**——把角色比对改成恒真，确认 e2e 真的失败。Task 7 的实现过程中，正因为做了这个自检才发现按原设计写出来的 403 断言是**假通过**（角色判断压根没执行，是「需要登录后访问」在兜底）。

**Files:**
- Create: `api/src/common/decorators/roles.decorator.ts`
- Create: `api/src/common/guards/roles.guard.ts`
- Create: `api/test/rbac.e2e-spec.ts`

- [ ] **Step 1: 编写角色装饰器**

`api/src/common/decorators/roles.decorator.ts`：

```typescript
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 2: 编写角色守卫**

`api/src/common/guards/roles.guard.ts`：

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  CurrentUserPayload,
} from '../decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const user = context.switchToHttp().getRequest().user as
      | CurrentUserPayload
      | undefined;

    if (!user) {
      throw new ForbiddenException('需要登录后访问');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException('当前角色无权访问该资源');
    }

    return true;
  }
}
```

- [ ] **Step 3: 让 `@Roles()` 自行挂上认证与角色守卫**

角色守卫**不能**注册成 `APP_GUARD`（原因见本任务的「实施说明」）。正确做法是让 `@Roles()` 装饰器在**一次** `UseGuards` 里显式排定两个守卫的顺序。

`api/src/common/decorators/roles.decorator.ts`：

```typescript
import { SetMetadata, applyDecorators, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ROLES_KEY, RolesGuard } from '../guards/roles.guard';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';

export { ROLES_KEY };

/**
 * 声明某条路由允许访问的角色集合。
 *
 * 为什么在一次 UseGuards 里同时挂 JwtAuthGuard：
 * 1. 不注册成 APP_GUARD——全局守卫永远先于路由级 @UseGuards 跑，
 *    那时 request.user 还没填，鉴权会静默失效。
 * 2. 不依赖装饰器堆叠顺序——方法装饰器由 TS 自下而上应用，
 *    分开写 @UseGuards(JwtAuthGuard) 和 @Roles() 时谁先注册取决于源码
 *    谁写在下面，顺序是隐式的、写错就静默越权。
 *    在同一次 UseGuards 里显式排 [JwtAuthGuard, RolesGuard]，
 *    数组顺序即执行顺序，认证必然先于鉴权。
 *
 * 副作用（且是想要的）：标了 @Roles() 的路由自动带认证，
 * 未登录访问得到 401 而非 403，两种失败语义不再混淆。
 */
export const Roles = (...roles: UserRole[]) =>
  applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    UseGuards(JwtAuthGuard, RolesGuard),
  );
```

`ROLES_KEY` 定义在 `roles.guard.ts` 而不是装饰器里——装饰器要 import 守卫来挂守卫，若守卫再 import 装饰器拿 `ROLES_KEY`，就形成循环依赖，表现是 `canActivate` 里 `ROLES_KEY` 为 undefined（500），很难一眼定位。依赖方向固定为 装饰器 → 守卫，单向。

`api/src/app.module.ts` **不需要改动**（刻意不注册 `APP_GUARD`）。

- [ ] **Step 4: 编写 RBAC e2e 测试**

`RolesGuard` 必须真的被验证——光测 `/auth/me`（那用的是 `JwtAuthGuard`）证明不了角色守卫有任何作用。测试里放一个**只在测试中存在**的探针控制器，带 `@Roles()` 标注。

`api/test/rbac.e2e-spec.ts`：

```typescript
import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { Roles } from '../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';

/** 只在测试里存在的探针控制器，用来验证角色守卫真的生效 */
@Controller('probe')
class RoleProbeController {
  @Get('platform-only')
  @Roles(UserRole.PLATFORM_ADMIN)
  platformOnly() {
    return { ok: true, scope: 'platform' };
  }

  @Get('merchant-only')
  @Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
  merchantOnly() {
    return { ok: true, scope: 'merchant' };
  }

  @Get('any-authed')
  @UseGuards(JwtAuthGuard)
  anyAuthed() {
    return { ok: true, scope: 'any' };
  }
}

@Module({
  imports: [AppModule],
  controllers: [RoleProbeController],
})
class RbacProbeModule {}

describe('RBAC (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerMerchant() {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-${unique()}@example.test`,
        password: 'Passw0rd123',
        merchantName: '商家',
        subdomain: `s-${unique()}`,
        storeName: '店铺',
      })
      .expect(201);
    return response.body;
  }

  it('携带有效 JWT 时 /auth/me 返回当前用户', async () => {
    const auth = await registerMerchant();

    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.email).toBe(auth.user.email);
    expect(response.body.role).toBe('MERCHANT_OWNER');
  });

  it('无 Authorization 头时 /auth/me 返回 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('伪造的 JWT 返回 401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('商家访问平台专属端点返回 403', async () => {
    const auth = await registerMerchant();

    const response = await request(app.getHttpServer())
      .get('/api/v1/probe/platform-only')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(403);
  });

  it('平台超管访问平台专属端点返回 200', async () => {
    // 平台超管是种子数据里那个账号，用 PLATFORM 入口登录
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@platform.test',
        password: 'Admin12345!',
        scope: 'PLATFORM',
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/probe/platform-only')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.scope).toBe('platform');
  });

  it('商家访问商家端点返回 200', async () => {
    const auth = await registerMerchant();

    const response = await request(app.getHttpServer())
      .get('/api/v1/probe/merchant-only')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(200);
  });

  it('未登录访问带角色限制的端点返回 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/probe/platform-only').expect(401);
  });

  it('登出需要 access token，且登出后刷新令牌失效', async () => {
    const auth = await registerMerchant();

    // 不带 access token 登出 → 401（盲登出被挡住）
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: auth.refreshToken })
      .expect(401);

    // 带 access token 登出 → 204
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ refreshToken: auth.refreshToken })
      .expect(204);

    // 登出后那枚刷新令牌不能再换新令牌
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(401);
  });
});
```

- [ ] **Step 5: 运行测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run test:e2e
```
Expected: 全部 e2e 通过

- [ ] **Step 6: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): RBAC 角色守卫与全局注册"
```

---

## Task 8：店铺模块与跨租户越权防护测试

**Files:**
- Create: `api/src/modules/stores/dto/update-store.dto.ts`
- Create: `api/src/modules/stores/stores.service.ts`
- Create: `api/src/modules/stores/stores.controller.ts`
- Create: `api/src/modules/stores/stores.module.ts`
- Create: `api/src/modules/tenants/tenants.controller.ts`
- Create: `api/src/modules/tenants/tenants.service.ts`
- Create: `api/src/modules/tenants/tenants.module.ts`
- Create: `api/test/stores.e2e-spec.ts`

- [ ] **Step 1: 编写店铺 DTO**

`api/src/modules/stores/dto/update-store.dto.ts`：

```typescript
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsObject()
  themeTokens?: Record<string, unknown>;
}
```

- [ ] **Step 2: 编写店铺服务**

`api/src/modules/stores/stores.service.ts`：

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { Store } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 取当前租户的店铺（商家后台与消费者共享同一份数据） */
  async findMine(): Promise<Store> {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('当前身份不属于任何店铺');
    }

    const store = await this.prisma.store.findFirst({
      where: { tenantId: context.tenantId },
    });

    if (!store) {
      throw new NotFoundException('店铺不存在');
    }

    return store;
  }

  async updateMine(dto: UpdateStoreDto): Promise<Store> {
    const store = await this.findMine();

    await this.prisma.store.updateMany({
      where: { id: store.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.themeTokens !== undefined
          ? { themeTokens: dto.themeTokens as object }
          : {}),
      },
    });

    return this.findMine();
  }

  /** 按子域名取店铺（店铺前台公开接口） */
  async findBySubdomain(subdomain: string): Promise<Store> {
    // 子域名本身就是定位租户的入口，等价于一次显式的跨租户读取，
    // 因此使用平台作用域而不是当前请求的租户上下文。
    return tenantContext.run(platformScope(), async () => {
      const tenant = await this.prisma.tenant.findFirst({
        where: { subdomain: subdomain.toLowerCase() },
      });

      if (!tenant) {
        throw new NotFoundException('店铺不存在');
      }

      const store = await this.prisma.store.findFirst({
        where: { tenantId: tenant.id },
      });

      if (!store) {
        throw new NotFoundException('店铺不存在');
      }

      return store;
    });
  }
}
```

- [ ] **Step 3: 编写店铺控制器**

`api/src/modules/stores/stores.controller.ts`：

```typescript
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StoresService } from './stores.service';
import { UpdateStoreDto } from './dto/update-store.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Skip } from '../../common/decorators/skip.decorator';

@ApiTags('stores')
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '当前租户的店铺' })
  findMine() {
    return this.storesService.findMine();
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '更新当前租户的店铺设置' })
  updateMine(@Body() dto: UpdateStoreDto) {
    return this.storesService.updateMine(dto);
  }

  @Get('by-subdomain/:subdomain')
  @Skip()
  @ApiOperation({ summary: '按子域名查询店铺（公开）' })
  findBySubdomain(@Param('subdomain') subdomain: string) {
    return this.storesService.findBySubdomain(subdomain);
  }
}
```

- [ ] **Step 4: 编写平台超管的租户管理服务与控制器**

`api/src/modules/tenants/tenants.service.ts`：

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { Tenant, TenantStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 平台作用域查询：可跨租户 */
  async list(): Promise<Tenant[]> {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: TenantStatus): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findFirst({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('商家不存在');
    }

    await this.prisma.tenant.updateMany({
      where: { id },
      data: { status },
    });

    return this.prisma.tenant.findFirst({ where: { id } }) as Promise<Tenant>;
  }
}
```

`api/src/modules/tenants/tenants.controller.ts`：

```typescript
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { TenantsService } from './tenants.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

class UpdateTenantStatusDto {
  @IsEnum(TenantStatus, { message: 'status 必须是 TRIAL / ACTIVE / SUSPENDED' })
  status!: TenantStatus;
}

@ApiTags('tenants')
@Roles(UserRole.PLATFORM_ADMIN)
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @ApiOperation({ summary: '商家列表（平台超管）' })
  list() {
    return this.tenantsService.list();
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '变更商家状态（平台超管）' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.tenantsService.updateStatus(id, dto.status);
  }
}
```

- [ ] **Step 5: 编写模块文件**

`api/src/modules/stores/stores.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
```

`api/src/modules/tenants/tenants.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
```

- [ ] **Step 6: 注册模块**

`api/src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoresModule } from './modules/stores/stores.module';
import { TenantsModule } from './modules/tenants/tenants.module';

@Module({
  imports: [HealthModule, TenancyModule, AuthModule, StoresModule, TenantsModule],
})
export class AppModule {}
```

> `TenantPrismaService` 由 `TenancyModule`（`@Global()`）提供并导出，**不要**在这里重复声明——会多出一个实例（两条连接池），且 `app.get()` 拿到的与拦截器内部用的不是同一个。
> `RolesGuard` **刻意不注册成 `APP_GUARD`**——全局守卫最先跑（NestJS 的顺序是 `[...全局, ...类级, ...方法级]`），会早于 `JwtAuthGuard` 执行导致鉴权静默失效。角色限制由 `@Roles()` 装饰器自行挂载守卫。

- [ ] **Step 7: 编写跨租户越权防护 e2e 测试**

`api/test/stores.e2e-spec.ts`：

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';

describe('店铺与租户隔离 (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerMerchant(storeName: string) {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-${unique()}@example.test`,
        password: 'Passw0rd123',
        merchantName: '商家',
        subdomain: `s-${unique()}`,
        storeName,
      })
      .expect(201);
    return response.body;
  }

  it('商家能看到自己的店铺', async () => {
    const auth = await registerMerchant('我的店铺');

    const response = await request(app.getHttpServer())
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('我的店铺');
    expect(response.body.tenantId).toBe(auth.user.tenantId);
  });

  it('商家 A 看不到商家 B 的店铺', async () => {
    const authA = await registerMerchant('店铺 A');
    const authB = await registerMerchant('店铺 B');

    const responseA = await request(app.getHttpServer())
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authA.accessToken}`);

    const responseB = await request(app.getHttpServer())
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authB.accessToken}`);

    expect(responseA.body.id).not.toBe(responseB.body.id);
    expect(responseA.body.tenantId).not.toBe(responseB.body.tenantId);
    expect(responseA.body.name).toBe('店铺 A');
    expect(responseB.body.name).toBe('店铺 B');
  });

  it('商家更新店铺时无法把数据写到别的租户', async () => {
    const authA = await registerMerchant('原名 A');
    const authB = await registerMerchant('原名 B');

    await request(app.getHttpServer())
      .patch('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .send({ name: '改名后的 A' })
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authB.accessToken}`);

    expect(responseB.body.name).toBe('原名 B');
  });

  it('商家无法访问平台超管接口', async () => {
    const auth = await registerMerchant('商家店铺');

    await request(app.getHttpServer())
      .get('/api/v1/tenants')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(403);
  });

  it('按子域名可以公开查询店铺', async () => {
    const sub = `s-${unique()}`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-${unique()}@example.test`,
        password: 'Passw0rd123',
        merchantName: '商家',
        subdomain: sub,
        storeName: '公开店铺',
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/stores/by-subdomain/${sub}`);

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('公开店铺');
  });
});
```

- [ ] **Step 8: 运行测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run test:e2e
```
Expected: 全部通过（19 个 e2e）

- [ ] **Step 9: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): 店铺模块、租户管理与跨租户越权防护"
```

---

## Task 9：OpenAPI 文档与统一错误响应

**Files:**
- Create: `api/src/common/filters/all-exceptions.filter.ts`
- Create: `api/src/common/filters/error-codes.ts`
- Modify: `api/src/main.ts`
- Modify: `api/src/app.module.ts`（注册 filter）

- [ ] **Step 1: 定义错误码**

`api/src/common/filters/error-codes.ts`：

```typescript
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TENANT_SCOPE_VIOLATION: 'TENANT_SCOPE_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
```

- [ ] **Step 2: 编写全局异常过滤器**

`api/src/common/filters/all-exceptions.filter.ts`：

```typescript
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { TenantScopeError } from '../tenant/tenant-scope.error';
import { ERROR_CODES, ErrorCode } from './error-codes';

interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  traceId: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const traceId = request.header('x-trace-id') ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = ERROR_CODES.INTERNAL_ERROR;
    let message = '服务器内部错误';
    let details: unknown;

    if (exception instanceof TenantScopeError) {
      status = HttpStatus.FORBIDDEN;
      code = ERROR_CODES.TENANT_SCOPE_VIOLATION;
      message = exception.message;
      this.logger.error(`[${traceId}] 租户越权拦截：${exception.message}`);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const body = payload as { message?: unknown; error?: unknown };
        if (Array.isArray(body.message)) {
          message = body.message.join('；');
          details = body.message;
        } else if (typeof body.message === 'string') {
          message = body.message;
        } else {
          message = exception.message;
        }
      }

      code = this.codeForStatus(status);
    } else {
      this.logger.error(
        `[${traceId}] 未处理异常：${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    const body: ErrorBody = { code, message, traceId };
    if (details !== undefined) {
      body.details = details;
    }

    response.status(status).json(body);
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ERROR_CODES.CONFLICT;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}
```

- [ ] **Step 3: 在 `main.ts` 启用 Swagger 与全局过滤器**

`api/src/main.ts` 改为：

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { TenantContextInterceptor } from './modules/tenancy/tenant-context.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(app.get(TenantContextInterceptor));
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('多租户电商 SaaS API')
    .setDescription('阶段 1：平台地基与身份体系')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API 已启动：http://localhost:${port}/api/v1`);
  console.log(`接口文档：http://localhost:${port}/api/docs`);
}

void bootstrap();
```

- [ ] **Step 4: 验证错误响应格式**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run start:dev
```
另开终端：
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"not-an-email","password":"x","scope":"MERCHANT"}'
```
Expected: HTTP 400，响应体形如
```json
{"code":"VALIDATION_FAILED","message":"邮箱格式不正确","details":["邮箱格式不正确"],"traceId":"..."}
```

- [ ] **Step 5: 写一个错误格式 e2e 测试**

`api/test/errors.e2e-spec.ts`：

```typescript
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('统一错误响应 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('参数校验失败返回统一格式', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'x', scope: 'MERCHANT' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(typeof response.body.message).toBe('string');
    expect(typeof response.body.traceId).toBe('string');
  });

  it('未认证返回 401 且带错误码', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });
});
```

- [ ] **Step 6: 运行测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run test:e2e
```
Expected: 21 个 e2e 全部通过

- [ ] **Step 7: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add api/ && git commit -m "feat(api): OpenAPI 文档与统一错误响应格式"
```

---

## Task 10：storefront 前端骨架与消费者登录

**Files:**
- Create: `storefront/`（由 `create-next-app` 生成）
- Create: `storefront/src/lib/api-client.ts`
- Create: `storefront/src/auth.ts`
- Create: `storefront/src/app/api/auth/[...nextauth]/route.ts`
- Create: `storefront/src/app/(shop)/page.tsx`
- Create: `storefront/src/app/(shop)/login/page.tsx`
- Create: `storefront/src/app/(shop)/account/page.tsx`
- Create: `storefront/.env.example`

- [ ] **Step 1: 生成 Next.js 项目**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && npx --yes create-next-app@15 storefront --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --use-npm --skip-install
```
Expected: 生成 `storefront/` 目录

紧接着固定 dev 端口（`create-next-app` 生成的 `dev` 脚本是 `next dev`，默认监听 3000——而 api 也用 3000，三个前端不显式指定端口会互相抢端口、验收时随机命中错误的应用。写进 npm script 而非命令行传参，保证 README 里的裸 `npm run dev` 真的可用）：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/storefront" && npm pkg set scripts.dev="next dev -p 3001"
```
Expected: `package.json` 的 `scripts.dev` 变为 `next dev -p 3001`

- [ ] **Step 2: 安装依赖**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/storefront" && npm install && npm install next-auth@beta zod
```
Expected: 依赖安装完成

- [ ] **Step 3: 配置 shadcn/ui**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/storefront" && npx --yes shadcn@latest init -d -y && npx --yes shadcn@latest add button input card label
```
Expected: 生成 `src/components/ui/` 下的组件

- [ ] **Step 4: 创建环境变量示例**

`storefront/.env.example`：

```bash
# 后端 API 地址
API_BASE_URL="http://localhost:3000/api/v1"

# NextAuth
AUTH_SECRET="please-change-this-to-a-random-32-chars-string"
AUTH_URL="http://localhost:3001"
AUTH_TRUST_HOST=true
```

Run: `cp storefront/.env.example storefront/.env`

- [ ] **Step 5: 编写 API 客户端**

`storefront/src/lib/api-client.ts`：

```typescript
import { getSession } from '@/auth';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 店铺子域名：优先用请求头，其次用 host 的第一段 */
export function tenantSubdomain(host?: string | null): string {
  if (host) {
    const hostname = host.split(':')[0].toLowerCase();
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts[0];
    }
  }
  return process.env.NEXT_PUBLIC_TENANT_SUBDOMAIN ?? 'demo';
}

export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    subdomain?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.subdomain) {
    headers['x-tenant-subdomain'] = options.subdomain;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      payload.code ?? 'UNKNOWN',
      payload.message ?? '请求失败',
      payload.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** 带登录态调用后端 */
export async function apiFetchAuthed<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await getSession();
  return apiFetch<T>(path, {
    ...options,
    token: session?.accessToken,
  });
}
```

- [ ] **Step 6: 编写 NextAuth 配置**

`storefront/src/auth.ts`：

```typescript
import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    role: string;
    tenantId: string | null;
  }
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  tenantId: string | null;
  accessToken: string;
  refreshToken: string;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      name: 'customer',
      credentials: {
        email: { label: '邮箱', type: 'email' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials) {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: credentials?.email,
            password: credentials?.password,
            scope: 'CUSTOMER',
          }),
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as {
          user: { id: string; email: string; displayName: string; role: string; tenantId: string | null };
          accessToken: string;
          refreshToken: string;
        };

        return {
          id: data.user.id,
          email: data.user.email,
          name: data.user.displayName,
          role: data.user.role,
          tenantId: data.user.tenantId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        } as AuthUser;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authUser = user as AuthUser;
        token.accessToken = authUser.accessToken;
        token.refreshToken = authUser.refreshToken;
        token.role = authUser.role;
        token.tenantId = authUser.tenantId;
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string;
      session.role = token.role as string;
      session.tenantId = (token.tenantId as string | null) ?? null;
      return session;
    },
  },
});
```

> `DefaultSession` 若未使用则不导入，避免 lint 报错。

- [ ] **Step 7: 编写 NextAuth 路由**

`storefront/src/app/api/auth/[...nextauth]/route.ts`：

```typescript
import { handlers } from '@/auth';

export const { GET, POST } = handlers;
```

- [ ] **Step 8: 编写店铺首页**

`storefront/src/app/(shop)/page.tsx`：

```typescript
import { headers } from 'next/headers';
import { apiFetch, tenantSubdomain } from '@/lib/api-client';

interface StoreInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export default async function StorefrontHome() {
  const headerList = await headers();
  const subdomain = tenantSubdomain(headerList.get('host'));

  let store: StoreInfo | null = null;
  let error: string | null = null;

  try {
    store = await apiFetch<StoreInfo>(`/stores/by-subdomain/${subdomain}`);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : '店铺加载失败';
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold">{store?.name ?? '未知店铺'}</h1>
      <p className="text-muted-foreground">子域名：{subdomain}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">商品与结算功能在计划 2、计划 3 交付。</p>
    </main>
  );
}
```

- [ ] **Step 9: 编写登录页**

`storefront/src/app/(shop)/login/page.tsx`：

```typescript
'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function CustomerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError('邮箱或密码不正确');
      setPending(false);
      return;
    }

    router.push('/account');
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">登录</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? '登录中…' : '登录'}
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 10: 编写个人中心页**

`storefront/src/app/(shop)/account/page.tsx`：

```typescript
import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function CustomerAccountPage() {
  const session = await auth();

  if (!session) {
    redirect('/login');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold">我的账户</h1>
      <p>邮箱：{session.user?.email}</p>
      <p>角色：{session.role}</p>
    </main>
  );
}
```

- [ ] **Step 11: 启动并验证**

Run（终端 A）：
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run start:dev
```
Run（终端 B）：
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/storefront" && npm run dev
```
浏览器打开 `http://localhost:3001`，Expected: 显示店铺名或「未知店铺」但无 500 错误

- [ ] **Step 12: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add storefront/ && git commit -m "feat(storefront): 前端骨架、NextAuth 接入与消费者登录"
```

---

## Task 11：merchant-admin 前端骨架与店铺设置

**Files:**
- Create: `merchant-admin/`（由 `create-next-app` 生成）
- Create: `merchant-admin/src/lib/api-client.ts`
- Create: `merchant-admin/src/auth.ts`
- Create: `merchant-admin/src/app/api/auth/[...nextauth]/route.ts`
- Create: `merchant-admin/src/app/(auth)/login/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/layout.tsx`
- Create: `merchant-admin/src/app/(dashboard)/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/settings/page.tsx`
- Create: `merchant-admin/.env.example`

- [ ] **Step 1: 生成 Next.js 项目**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && npx --yes create-next-app@15 merchant-admin --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --use-npm --skip-install
```
Expected: 生成 `merchant-admin/` 目录

紧接着固定 dev 端口（理由同 Task 10：`create-next-app` 默认 3000，会与 api 及另两个前端抢端口）：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin" && npm pkg set scripts.dev="next dev -p 3002"
```
Expected: `package.json` 的 `scripts.dev` 变为 `next dev -p 3002`

- [ ] **Step 2: 安装依赖并初始化 shadcn/ui**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin" && npm install && npm install next-auth@beta zod && npx --yes shadcn@latest init -d -y && npx --yes shadcn@latest add button input card label
```
Expected: 依赖安装完成，UI 组件生成

- [ ] **Step 3: 创建环境变量**

`merchant-admin/.env.example`：

```bash
API_BASE_URL="http://localhost:3000/api/v1"
AUTH_SECRET="please-change-this-to-a-random-32-chars-string"
AUTH_URL="http://localhost:3002"
AUTH_TRUST_HOST=true
```

Run: `cp merchant-admin/.env.example merchant-admin/.env`

- [ ] **Step 4: 编写 API 客户端**

`merchant-admin/src/lib/api-client.ts`：

```typescript
import { auth } from '@/auth';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetchAuthed<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await auth();
  if (!session?.accessToken) {
    throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      payload.code ?? 'UNKNOWN',
      payload.message ?? '请求失败',
      payload.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
```

- [ ] **Step 5: 编写 NextAuth 配置**

`merchant-admin/src/auth.ts`：

```typescript
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    refreshToken: string;
    role: string;
    tenantId: string | null;
  }
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  accessToken: string;
  refreshToken: string;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      name: 'merchant',
      credentials: {
        email: { label: '邮箱', type: 'email' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials) {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: credentials?.email,
            password: credentials?.password,
            scope: 'MERCHANT',
          }),
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as {
          user: { id: string; email: string; displayName: string; role: string; tenantId: string | null };
          accessToken: string;
          refreshToken: string;
        };

        return {
          id: data.user.id,
          email: data.user.email,
          name: data.user.displayName,
          role: data.user.role,
          tenantId: data.user.tenantId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        } as AuthUser;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authUser = user as AuthUser;
        token.accessToken = authUser.accessToken;
        token.refreshToken = authUser.refreshToken;
        token.role = authUser.role;
        token.tenantId = authUser.tenantId;
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string;
      session.refreshToken = token.refreshToken as string;
      session.role = token.role as string;
      session.tenantId = (token.tenantId as string | null) ?? null;
      return session;
    },
  },
});
```

- [ ] **Step 6: 编写 NextAuth 路由与登录页**

`merchant-admin/src/app/api/auth/[...nextauth]/route.ts`：

```typescript
import { handlers } from '@/auth';

export const { GET, POST } = handlers;
```

`merchant-admin/src/app/(auth)/login/page.tsx`：

```typescript
'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function MerchantLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError('邮箱或密码不正确');
      setPending(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-2xl font-bold">商家后台登录</h1>
        <div className="flex flex-col gap-1">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? '登录中…' : '登录'}
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 7: 编写后台布局**

`merchant-admin/src/app/(dashboard)/layout.tsx`：

```typescript
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">商家后台</span>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/login' });
          }}
        >
          <button type="submit" className="text-sm underline">
            退出登录
          </button>
        </form>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 8: 编写仪表盘与设置页**

`merchant-admin/src/app/(dashboard)/page.tsx`：

```typescript
import { apiFetchAuthed } from '@/lib/api-client';

interface StoreInfo {
  id: string;
  name: string;
  status: string;
}

export default async function DashboardPage() {
  const store = await apiFetchAuthed<StoreInfo>('/stores/me');

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">概览</h1>
      <p>当前店铺：{store.name}</p>
      <p>店铺状态：{store.status}</p>
      <p className="text-sm text-muted-foreground">
        商品、订单、库存、营销模块分别在计划 2、3、4 交付。
      </p>
    </div>
  );
}
```

`merchant-admin/src/app/(dashboard)/settings/page.tsx`：

```typescript
'use client';

import { useEffect, useState } from 'react';
import { apiFetchAuthed } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface StoreInfo {
  id: string;
  name: string;
  themeTokens: Record<string, unknown>;
}

export default function StoreSettingsPage() {
  const [name, setName] = useState('');
  const [primary, setPrimary] = useState('#1677ff');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const store = await apiFetchAuthed<StoreInfo>('/stores/me');
        setName(store.name);
        const tokens = store.themeTokens as { colors?: { primary?: string } } | undefined;
        if (tokens?.colors?.primary) {
          setPrimary(tokens.colors.primary);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '加载失败');
      }
    })();
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    try {
      await apiFetchAuthed('/stores/me', {
        method: 'PATCH',
        body: {
          name,
          themeTokens: { colors: { primary } },
        },
      });
      setMessage('已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">店铺设置</h1>
      <div className="flex flex-col gap-1">
        <Label htmlFor="name">店铺名称</Label>
        <Input
          id="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="primary">主题主色</Label>
        <Input
          id="primary"
          type="color"
          value={primary}
          onChange={(event) => setPrimary(event.target.value)}
        />
      </div>
      {message && <p className="text-sm text-green-600">{message}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit">保存</Button>
    </form>
  );
}
```

- [ ] **Step 9: 启动并验证**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin" && npm run dev
```
浏览器打开 `http://localhost:3002/login`，用 Task 6 注册的商家账号登录，Expected: 进入概览页并看到店铺名

- [ ] **Step 10: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add merchant-admin/ && git commit -m "feat(merchant-admin): 前端骨架、NextAuth 接入与店铺设置"
```

---

## Task 12：platform-admin 前端骨架与商家管理

**Files:**
- Create: `platform-admin/`（由 `create-next-app` 生成）
- Create: `platform-admin/src/lib/api-client.ts`
- Create: `platform-admin/src/auth.ts`
- Create: `platform-admin/src/app/api/auth/[...nextauth]/route.ts`
- Create: `platform-admin/src/app/(auth)/login/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/layout.tsx`
- Create: `platform-admin/src/app/(dashboard)/page.tsx`
- Create: `platform-admin/.env.example`

- [ ] **Step 1: 生成 Next.js 项目**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && npx --yes create-next-app@15 platform-admin --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --use-npm --skip-install
```
Expected: 生成 `platform-admin/` 目录

紧接着固定 dev 端口（理由同 Task 10：`create-next-app` 默认 3000，会与 api 及另两个前端抢端口）：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin" && npm pkg set scripts.dev="next dev -p 3003"
```
Expected: `package.json` 的 `scripts.dev` 变为 `next dev -p 3003`

- [ ] **Step 2: 安装依赖并初始化 shadcn/ui**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin" && npm install && npm install next-auth@beta zod && npx --yes shadcn@latest init -d -y && npx --yes shadcn@latest add button input card label table
```
Expected: 依赖安装完成

- [ ] **Step 3: 创建环境变量**

`platform-admin/.env.example`：

```bash
API_BASE_URL="http://localhost:3000/api/v1"
AUTH_SECRET="please-change-this-to-a-random-32-chars-string"
AUTH_URL="http://localhost:3003"
AUTH_TRUST_HOST=true
```

Run: `cp platform-admin/.env.example platform-admin/.env`

- [ ] **Step 4: 编写 API 客户端**

`platform-admin/src/lib/api-client.ts`：

```typescript
import { auth } from '@/auth';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetchAuthed<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await auth();
  if (!session?.accessToken) {
    throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      payload.code ?? 'UNKNOWN',
      payload.message ?? '请求失败',
      payload.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
```

- [ ] **Step 5: 编写 NextAuth 配置**

`platform-admin/src/auth.ts`：

```typescript
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    refreshToken: string;
    role: string;
    tenantId: string | null;
  }
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  accessToken: string;
  refreshToken: string;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      name: 'platform',
      credentials: {
        email: { label: '邮箱', type: 'email' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials) {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: credentials?.email,
            password: credentials?.password,
            scope: 'PLATFORM',
          }),
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as {
          user: { id: string; email: string; displayName: string; role: string; tenantId: string | null };
          accessToken: string;
          refreshToken: string;
        };

        return {
          id: data.user.id,
          email: data.user.email,
          name: data.user.displayName,
          role: data.user.role,
          tenantId: data.user.tenantId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        } as AuthUser;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authUser = user as AuthUser;
        token.accessToken = authUser.accessToken;
        token.refreshToken = authUser.refreshToken;
        token.role = authUser.role;
        token.tenantId = authUser.tenantId;
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string;
      session.refreshToken = token.refreshToken as string;
      session.role = token.role as string;
      session.tenantId = (token.tenantId as string | null) ?? null;
      return session;
    },
  },
});
```

- [ ] **Step 6: 编写 NextAuth 路由与登录页**

`platform-admin/src/app/api/auth/[...nextauth]/route.ts`：

```typescript
import { handlers } from '@/auth';

export const { GET, POST } = handlers;
```

`platform-admin/src/app/(auth)/login/page.tsx`：

```typescript
'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError('邮箱或密码不正确');
      setPending(false);
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-2xl font-bold">平台超管登录</h1>
        <div className="flex flex-col gap-1">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? '登录中…' : '登录'}
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 7: 编写布局与商家列表页**

`platform-admin/src/app/(dashboard)/layout.tsx`：

```typescript
import { auth, signOut } from '@/auth';
import { redirect } from 'next/navigation';

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">平台超管后台</span>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/login' });
          }}
        >
          <button type="submit" className="text-sm underline">
            退出登录
          </button>
        </form>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
```

`platform-admin/src/app/(dashboard)/page.tsx`：

```typescript
import { apiFetchAuthed } from '@/lib/api-client';

interface TenantSummary {
  id: string;
  name: string;
  subdomain: string;
  status: string;
  createdAt: string;
}

export default async function PlatformHomePage() {
  const tenants = await apiFetchAuthed<TenantSummary[]>('/tenants');

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">商家列表</h1>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2">名称</th>
            <th className="py-2">子域名</th>
            <th className="py-2">状态</th>
            <th className="py-2">创建时间</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <tr key={tenant.id} className="border-b">
              <td className="py-2">{tenant.name}</td>
              <td className="py-2">{tenant.subdomain}</td>
              <td className="py-2">{tenant.status}</td>
              <td className="py-2">{new Date(tenant.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: 启动并验证**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin" && npm run dev
```
浏览器打开 `http://localhost:3003/login`，用 `admin@platform.test / Admin12345!` 登录，Expected: 看到商家列表表格

- [ ] **Step 9: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add platform-admin/ && git commit -m "feat(platform-admin): 前端骨架、NextAuth 接入与商家列表"
```

---

## Task 13：阶段 1 验收与收尾

**Files:**
- Create: `infra/nginx/platform.test.conf`
- Modify: `README.md`（补充阶段 1 验收步骤）
- Create: `docs/superpowers/plans/2026-10-21-plan-01-acceptance.md`（验收记录）

- [ ] **Step 1: 编写 Nginx 子域名配置**

`infra/nginx/platform.test.conf`：

```nginx
# 阶段 1 本地开发用子域名路由
# 使用前把 *.platform.test 指向 127.0.0.1：
#   127.0.0.1 *.platform.test

upstream api_backend {
    server api:3000;
}

upstream storefront_backend {
    server storefront:3000;
}

upstream merchant_admin_backend {
    server merchant-admin:3000;
}

upstream platform_admin_backend {
    server platform-admin:3000;
}

server {
    listen 80;
    server_name ~^(?<tenant>[a-z0-9-]+)\.platform\.test$;
    location / {
        proxy_pass http://storefront_backend;
        proxy_set_header Host $host;
        # 由网关从 Host 反推后注入，覆盖客户端传来的同名头
        proxy_set_header X-Tenant-Subdomain $tenant;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location /api/ {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Tenant-Subdomain $tenant;
    }
}

server {
    listen 80;
    server_name api.platform.test;
    location / {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        # 这些后端不接受客户端指定的子域名，显式剥除
        proxy_set_header X-Tenant-Subdomain "";
    }
}

server {
    listen 80;
    server_name merchant.platform.test;
    location / {
        proxy_pass http://merchant_admin_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Tenant-Subdomain "";
    }
}

server {
    listen 80;
    server_name admin.platform.test;
    location / {
        proxy_pass http://platform_admin_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Tenant-Subdomain "";
    }
}
```

- [ ] **Step 2: 运行后端全量测试**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npm run test:cov && npm run test:e2e && npm run test:cov:e2e
```
Expected: 单元测试与 e2e 全部通过

**覆盖率有两个口径，别混**：

| 命令 | 覆盖什么 | 阶段 1 实测 |
|------|---------|------------|
| `npm run test:cov` | **只**跑单元测试。jest 的 `rootDir` 是 `src`，因此只统计单元测试触及到的代码——本项目单元测试只覆盖隔离机制一个模块 | 26.17% |
| `npm run test:cov:e2e` | 跑 e2e，统计整个 `src/`。**这才是项目真实覆盖率** | **63.9%** |

阶段 1 的 60% 验收线以 `test:cov:e2e` 为准（63.9% 通过）。`test:cov` 的 26% 不是缺陷——业务逻辑主要由 e2e 覆盖，单元测试只针对隔离机制做精细验证。

- [ ] **Step 3: 运行后端类型检查与 lint**

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api" && npx tsc --noEmit && npm run lint
```
Expected: 无错误输出

- [ ] **Step 4: 运行三个前端的类型检查与 lint**

Run:
```bash
for app in storefront merchant-admin platform-admin; do
  cd "/Users/tom/orca/workspaces/电商项目/电商项目/$app" && npx tsc --noEmit && npm run lint
done
```
Expected: 无错误输出

- [ ] **Step 5: 手动走通验收场景**

> 阶段 1 的完整验收场景（26 条）与实测结果记录在
> `docs/superpowers/plans/2026-10-21-plan-01-acceptance.md`，含经 nginx 的完整栈走查
> 与每个护栏的**恒真自检**记录。

按顺序验证：

1. `curl -X POST http://localhost:3000/api/v1/auth/register/merchant -H 'content-type: application/json' -d '{"email":"demo@example.test","password":"Passw0rd123","merchantName":"演示商家","subdomain":"demo","storeName":"演示店铺"}'` → 201
2. `curl http://localhost:3000/api/v1/stores/by-subdomain/demo` → 200，返回「演示店铺」
3. `curl -X POST http://localhost:3000/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"demo@example.test","password":"Passw0rd123","scope":"MERCHANT"}'` → 200，拿 accessToken
4. `curl http://localhost:3000/api/v1/stores/me -H "Authorization: Bearer <accessToken>"` → 200，返回当前租户店铺
5. `curl http://localhost:3000/api/v1/tenants -H "Authorization: Bearer <accessToken>"` → 403（商家无权）
6. 用平台超管 token 请求 `/api/v1/tenants` → 200，返回商家列表
7. 浏览器 `http://localhost:3002/login` 用 demo 账号登录 → 进入概览页看到「演示店铺」
8. 浏览器 `http://localhost:3003/login` 用 `admin@platform.test` 登录 → 看到商家列表包含「演示商家」

- [ ] **Step 6: 记录验收结果**

`docs/superpowers/plans/2026-10-21-plan-01-acceptance.md`：

```markdown
# 计划 1 验收记录

验收日期：2026-10-21
验收人：<填写>
环境：macOS / Node <填写> / PostgreSQL 16

## 一、自动化测试

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端单元测试 | `cd api && npm test` | 7 个用例全部通过 | |
| 后端覆盖率 | `cd api && npm run test:cov` | statements ≥ 60% | |
| 后端 e2e | `cd api && npm run test:e2e` | 21 个用例全部通过 | |
| 后端类型检查 | `cd api && npx tsc --noEmit` | 无错误 | |
| 后端 lint | `cd api && npm run lint` | 无错误 | |
| 前端类型检查 | 三个前端各 `npx tsc --noEmit` | 无错误 | |
| 前端 lint | 三个前端各 `npm run lint` | 无错误 | |

## 二、手动验收场景

| # | 场景 | 通过标准 | 实测 |
|---|------|---------|------|
| 1 | 商家注册开店 | HTTP 201，返回 accessToken 且 user.role = MERCHANT_OWNER | |
| 2 | 按子域名查店铺 | HTTP 200，返回的店铺名与注册时一致 | |
| 3 | 商家登录 | HTTP 200，返回 accessToken 与 refreshToken | |
| 4 | 商家查自己的店铺 | HTTP 200，返回的 tenantId 与登录用户一致 | |
| 5 | 商家访问平台接口 | HTTP 403，错误码 FORBIDDEN | |
| 6 | 超管查商家列表 | HTTP 200，列表包含刚才注册的商家 | |
| 7 | 商家 A 查商家 B 的店铺 | 查不到（返回的是 A 自己的店铺） | |
| 8 | 商家后台登录 | 进入概览页，显示正确的店铺名 | |
| 9 | 超管后台登录 | 商家列表表格显示已注册商家 | |
| 10 | 刷新令牌轮换 | 新 refreshToken 与旧的不同，旧令牌再刷新返回 401 | |

## 三、发现的问题

（记录问题、影响范围、修复计划；无问题则写「无」）

## 四、结论

通过 / 不通过（不通过则列出必须修复项）
```

- [ ] **Step 7: 补充 README 的阶段 1 验收章节**

在 `README.md` 末尾追加：

```markdown
## 阶段 1 验收

1. `cd infra && docker compose up -d`
2. `cd api && npm install && cp .env.example .env && npm run prisma:deploy && npm run prisma:seed && npm run start:dev`
3. 分别启动三个前端：`npm run dev`（端口 3001 / 3002 / 3003）
4. 商家后台：<http://localhost:3002/login>
5. 平台超管后台：<http://localhost:3003/login>（默认账号 `admin@platform.test` / `Admin12345!`）

本地子域名调试：把 `127.0.0.1 *.platform.test` 写入 `/etc/hosts`，
再用 `demo.platform.test` 访问店铺前台。
```

- [ ] **Step 8: 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git add infra/nginx README.md docs/superpowers/plans/2026-10-21-plan-01-acceptance.md && git commit -m "docs: 阶段 1 验收记录、Nginx 子域名配置与验收说明"
```

- [ ] **Step 9: 提交计划 1 成果**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git status --short && git add -A && git commit -m "chore: 阶段 1 收尾" --allow-empty
```
Expected: 工作区干净

---

## 附：计划 1 之后

计划 1 完成后，依次写并执行：

- 计划 2：商品中心与店铺前台浏览
- 计划 3：交易链路（购物车 → 库存 → 订单 → 支付）
- 计划 4：营销、平台计费与平台超管

每个计划在动笔前，先对照本计划的已实现接口调整命名，避免返工。
