# 计划 2a：商品中心后端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 的多租户地基上建出商品中心的后端——租户自建品类树、规格矩阵驱动的商品与 SKU、MinIO 直传媒体、手动出入库与流水台账、面向消费者的公开读与搜索接口。

**Architecture:** 后端新增三个 NestJS 模块 `catalog` / `media` / `inventory`，全部挂进阶段 1 已有的 `TenantPrismaService`（不新开 Prisma client）。租户隔离沿用现有的 Prisma query extension 机制，本阶段把 9 张新表登记进 `TENANT_SCOPED_MODELS`，并新增 `SOFT_DELETE_MODELS` 白名单让扩展自动合并 `deletedAt: null`。公开读端点用新的 `@Public()` 装饰器——它只放行 JWT 守卫，租户上下文拦截器照常从子域名解析租户，因此公开查询仍在隔离机制内。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16（pg_trgm）+ MinIO（S3 兼容）+ Jest/Supertest | Docker Compose

**对应设计文档:** `docs/superpowers/specs/2026-10-22-plan-02-product-center-design.md` 全文

**配套计划:** `docs/superpowers/plans/2026-10-22-plan-02b-catalog-ui.md`（主题 token、storefront 浏览页、商家后台、验收）

**本计划的交付边界：** 完成后，商家能通过 API 建品类、上架带规格的商品、传图、
调库存；公开读接口与搜索可用。**三个前端的界面与主题渲染在计划 2b。**
因此本计划的验收以 e2e 与接口契约为准，不做浏览器手测。

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

本机已运行着其他项目的容器栈，标准端口不可用。本项目沿用阶段 1 的分配：

| 服务 | 宿主机端口 | 容器内端口 | 引入计划 |
|------|-----------|-----------|---------|
| PostgreSQL | 15432 | 5432 | 计划 1 |
| MinIO | 19000 | 9000 | **计划 2（本计划引入）** |
| Redis | 16380 | 6379 | 计划 3（支付队列） |

**MinIO 的 API 端口 9000 与控制台端口 9001 不同**，控制台映射到宿主机 19001。
后续任务新增服务时必须沿用此表，不要占用标准端口。

### 0.4 贯穿全计划的技术决策

> ### ⚠️ 关联对象的租户归属要在 service 层校验
>
> 外键（如 `Product.categoryId`、`Category.parentId`、`SkuSpecValue.valueId`）
> **只引用 `id`，不带 `tenantId`**，数据库层面挡不住跨租户挂载：租户 B 可以
> 把自己的商品挂到租户 A 的品类下，A 读自己的商品时通过 `include: { category }`
> 就能看到——不是数据泄漏，是**数据完整性被破坏**。
>
> 扩展挡不住这类问题：它只往 `data` 注入 `tenantId`，不校验**被引用的对象**
> 属于哪个租户。所以凡是接收外键的写接口，都要在 service 里先查一次：
>
> ```typescript
> if (dto.parentId) {
>   const parent = await this.prisma.category.findFirst({ where: { id: dto.parentId } });
>   // 扩展自动带上 where.tenantId —— 跨租户的 id 查不到，就是拦住了
>   if (!parent) throw new BadRequestException('父品类不存在');
> }
> ```
>
> 这个模式在 Task 3（品类）、Task 4（商品）里已经有了。
> **Task 5 的规格值靠 `(specId, value)` 文本匹配而非传 id，天然安全**
> ——所以 `SpecValueInputDto` 刻意不设 `id` 字段。

> ### ⚠️ 关联读取必须显式写 `where`（Task 2 实测确认）
>
> Prisma 的 `include` 不是独立的 delegate 调用，而是拼进同一条查询的子查询，
> `$allModels` 扩展**只作用于顶层**。实测：
>
> | 写法 | 软删记录是否出现 |
> |------|----------------|
> | `prisma.sku.findMany()` | ❌ 不出现（顶层合并了 `deletedAt: null`） |
> | `include: { skus: true }` | ✅ **出现** |
> | `include: { skus: { where: { deletedAt: null } } }` | ❌ 不出现 |
>
> **租户隔离不受影响**——顶层 `where.tenantId` 已把父记录滤掉，
> 别的租户的关联自然无从出现。所以这是「漏过滤软删数据」，不是跨租户泄漏。
>
> **凡是读软删除模型的关联（`include` / `select`），业务层都要显式补 `where`。**
> 只有 to-many 关系能这么写；to-one 关系要用关系条件
> （`media: { where: { media: { deletedAt: null } } }`），
> 因为 to-one 的嵌套类型里没有 `where` 槽位。
>
> 回归用例在 `api/src/common/tenant/tenant-prisma.service.spec.ts`
> 的「关联读取」那一条，改这段代码前先看它。

| 决策 | 取值 | 理由 |
|------|------|------|
| 金额单位 | 整数分（`number`），不用浮点 | 避免精度问题；与阶段 1 一致 |
| 时间 | 数据库存 `timestamptz`，API 传 ISO 8601 字符串 | 与阶段 1 一致 |
| 商品模型 | 规格矩阵：维度 + 值 + SKU 多对多 | 能自动生成 SKU 骨架、能做规格选择器 |
| 品类归属 | 租户自建 | 与现有隔离模型一致 |
| 描述性属性 | `Product.attributes` jsonb | 只展示不筛选，建表不划算 |
| 软删除 | 所有业务实体走 `deletedAt`，过滤由扩展合并 | 审计链不断、误删可恢复、规则无例外 |
| 唯一索引 | 部分唯一索引（`WHERE deleted_at IS NULL`），迁移手写 | Prisma 表达不了，且 NULL 不参与唯一性判定 |
| 公开读 | `@Public()` 装饰器，租户仍来自子域名 | 公开数据也在隔离机制内 |
| 搜索 | pg_trgm 三元组 + GIN 索引 | 对中文有效，无需分词器与额外服务 |

### 0.5 本计划要新建/修改的文件总览

**后端 `api/`**

```
src/
├─ common/
│  ├─ decorators/
│  │  ├─ skip.decorator.ts          # 修改：新增 PUBLIC_KEY 与 @Public()
│  │  └─ public.decorator.ts        # 新建：@Public() 装饰器
│  └─ tenant/
│     ├─ tenant-models.ts            # 修改：扩白名单 + 新增 SOFT_DELETE_MODELS
│     └─ tenant-prisma.service.ts   # 修改：软删除条件合并 + 9 个 delegate getter
├─ modules/
│  ├─ auth/
│  │  └─ jwt-auth.guard.ts          # 修改：识别 @Public() 直接放行
│  ├─ catalog/                      # 新建模块
│  │  ├─ catalog.module.ts
│  │  ├─ categories/{controller,service}.ts
│  │  ├─ products/{controller,service}.ts
│  │  ├─ specs/spec-matrix.service.ts       # 笛卡尔积与匹配
│  │  ├─ pricing/min-price.service.ts      # minPrice 派生字段维护
│  │  └─ dto/…
│  │       create-product / update-product / batch-products
│  │       create-category / update-category
│  │       replace-specs / update-sku / set-product-media
│  ├─ media/                        # 新建模块
│  │  ├─ media.module.ts
│  │  ├─ media.service.ts
│  │  ├─ storage/minio.service.ts  # presigned URL 签发
│  │  └─ dto/…
│  ├─ inventory/                    # 新建模块
│  │  ├─ inventory.module.ts
│  │  ├─ inventory.service.ts
│  │  └─ dto/…
│  └─ tenancy/…
prisma/
├─ schema.prisma                   # 修改：9 个新模型
├─ migrations/<迁移名>/migration.sql
└─ seed.ts                         # 修改：加商品种子数据
test/
├─ catalog.e2e-spec.ts             # 新建：品类 + 商品 + 规格
├─ catalog-public.e2e-spec.ts      # 新建：公开读 + 搜索
├─ media.e2e-spec.ts
├─ inventory.e2e-spec.ts
└─ soft-delete.e2e-spec.ts
```

**前端 `storefront/`**

```
src/
├─ app/(shop)/
│  ├─ page.tsx                     # 修改：首页商品流
│  ├─ c/[slug]/page.tsx            # 新建：品类页
│  ├─ search/page.tsx              # 新建：搜索结果页
│  ├─ p/[slug]/page.tsx            # 新建：商品详情页
│  └─ layout.tsx                   # 修改：主题 token 注入
├─ components/
│  ├─ product/{product-card,spec-selector,product-gallery}.tsx
│  └─ theme/theme-provider.tsx
└─ lib/{api-client,tenant}.ts      # 修改：公开读要带子域名头
```

**前端 `merchant-admin/`**

```
src/app/(dashboard)/
├─ products/{page,new/page,[id]/page,import/page}.tsx
├─ categories/page.tsx
├─ inventory/page.tsx
└─ settings/page.tsx              # 修改：加主题分区
src/app/api/
├─ products/{route,import/export/route}.ts
├─ categories/route.ts
└─ inventory/{route,movements/route}.ts
src/components/product/spec-matrix-editor.tsx
```

**基础设施 `infra/`**

```
docker-compose.yml                 # 修改：加 MinIO 服务
```

> **nginx 不需要改。** 媒体是浏览器**直传** MinIO 的（`http://localhost:19000/...`），
> 不经过 Nginx；Nginx 只代理三个前端与 api。
> 生产的媒体域名由 `MINIO_PUBLIC_URL` 决定，那时才需要在 Nginx 里加一个
> `location`——那是部署配置，不属于本阶段的代码改动。

### 0.6 需求覆盖映射

设计文档的功能点 → 本计划的任务：

| 设计文档章节 | 内容 | Task |
|-------------|------|------|
| §3.2–3.3 | 白名单扩展、fail-closed 性质 | 2 |
| §3.4 | `@Public()` 装饰器 | 2 |
| §3.5 | 公开读路径安全边界 | 7 |
| §3.6 | storefront → api 子域名传递 | 7, 9 |
| §4.1 | Category 表与层级校验 | 2, 3 |
| §4.2 | Product 表 | 2, 4 |
| §4.3 | minPrice 派生字段 | 2, 4 |
| §4.4–4.5 | 规格矩阵四张表 | 2, 4 |
| §4.6 | Media 表与三态 | 2, 5 |
| §4.7 | ProductMedia | 2, 4 |
| §4.8 | InventoryMovement | 2, 6 |
| §4.9 | 软删除的落地方式 | 2 |
| §4.10 | 部分唯一索引 | 2 |
| §5.2 | 公开读接口 | 7 |
| §5.3 | 搜索实现 | 7 |
| §5.4 | 商品管理接口 | 4, 10 |
| §5.5 | 规格矩阵整体替换 | 4 |
| §5.6 | 媒体接口 | 5 |
| §5.7 | 库存接口 | 6 |
| §5.8 | DTO 约定 | 全部后端任务 |
| §六 | 媒体上传链路 | 5 |
| §七 | 主题 token | 8 |
| §八 | 店铺前台 | 9 |
| §九 | 商家后台 | 10 |
| §十 | 测试策略 | 全部 |
| §十一 | 实施顺序 | 全部 |

---

## Task 1：基础设施与两项前置验证

本 Task 解决两个「方案可能整个要换」的未知项：`pg_trgm` 扩展能否在迁移里执行、MinIO 直传的 CORS 能否配通。这两项在写任何业务代码之前必须先有结论。

**Files:**
- Modify: `infra/docker-compose.yml`
- Modify: `api/.env.example`
- Modify: `infra/.env.example`

- [ ] **Step 1: 在 compose 里加 MinIO 服务**

在 `infra/docker-compose.yml` 的 `postgres` 服务之后、`api` 服务之前插入：

```yaml
  minio:
    # ⚠️ 为什么不是官方的 minio/minio：
    #
    # MinIO 社区版已停止维护，官方镜像先后从两个 registry 消失——
    # 2026-09-11 `minio/minio` 从 Docker Hub 删除（拉取报 "not found"），
    # 2026-09-24 `quay.io/minio/minio` 也改为要求认证（拉取报 401）。
    # 最后一个社区版还带 CVE-2026-40344（认证绕过），钉老版本不是好答案。
    #
    # 这里用 Chainguard 从源码重建的 MinIO：S3 接口与数据格式兼容。
    # 该 registry 只有 latest 一个 tag，当前 digest 记录在 infra/.env.example 里备查。
    image: cgr.dev/chainguard/minio:latest
    container_name: ecommerce-minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-ecommerce}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-ecommerce-minio-secret}
      # 浏览器直传要跨域。镜像里没有 mc 可改服务端配置，只能走环境变量。
      # 多个来源用英文逗号分隔；实测该变量对预检请求生效。
      MINIO_CORS_ALLOW_ORIGIN: ${MINIO_CORS_ALLOW_ORIGIN:-http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost}
    ports:
      # 宿主机端口 19000：本机标准端口已被其他项目栈占用
      - '${MINIO_PORT:-19000}:9000'
      # 控制台端口，与 API 端口不同
      - '${MINIO_CONSOLE_PORT:-19001}:9001'
    volumes:
      # 必须挂 volume：不挂时 /data 落在容器可写层上，MinIO 启动会报
      # "Rename across devices not allowed"（.minio.sys/tmp 跨设备重命名失败）。
      - minio-data:/data
    healthcheck:
      # 这个镜像里没有 mc / curl / wget / nc，只有 bash 与 coreutils，
      # 所以探活只能用 bash 内置的 /dev/tcp：连得上 9000 端口就算就绪。
      # CMD-SHELL 默认走 /bin/sh，sh 没有 /dev/tcp，必须显式调 bash。
      test: ['CMD-SHELL', 'bash -c "exec 3<>/dev/tcp/127.0.0.1/9000"']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 10s
```

同时在文件末尾的 `volumes:` 下加一行 `- minio-data:`。

**还要改 `api` 服务的 `environment` 与 `depends_on`**——否则容器里的后端拿不到
MinIO 配置，签发出来的 presigned URL 会指向容器自己的 localhost，浏览器打不开。

在 `api` 服务的 `environment:` 块末尾追加：

```yaml
      # MinIO（媒体上传）。三个 endpoint 各管各的，含义见 api/.env.example。
      # ⚠️ MINIO_ENDPOINT 必须是**宿主机**地址（localhost:19000）：
      # 它会被签进 presigned URL，浏览器要能访问。浏览器跑在宿主机上，
      # localhost:19000 正好是宿主机映射的端口。
      MINIO_ENDPOINT: ${MINIO_ENDPOINT:-http://localhost:19000}
      # 后端自己 HEAD / 删除对象用的地址：容器内走服务名。
      MINIO_INTERNAL_ENDPOINT: ${MINIO_INTERNAL_ENDPOINT:-http://minio:9000}
      # 媒体对外访问地址（存进 media.url），浏览器要能访问。
      MINIO_PUBLIC_URL: ${MINIO_PUBLIC_URL:-http://localhost:19000}
      MINIO_BUCKET: ${MINIO_BUCKET:-ecommerce-media}
      MINIO_REGION: ${MINIO_REGION:-us-east-1}
      MINIO_ACCESS_KEY: ${MINIO_ROOT_USER:-ecommerce}
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD:-ecommerce-minio-secret}
      MEDIA_MAX_SIZE: ${MEDIA_MAX_SIZE:-5242880}
```

在 `api` 服务的 `depends_on:` 里加一条：

```yaml
      minio:
        condition: service_healthy
```

> **`api` 服务原本已有 `depends_on: postgres`**，加 `minio` 时不要把 `postgres`
> 那条覆盖掉——`depends_on` 是映射，一个服务一个键。

> **`$$` 而不是 `$`**：docker compose 会把 `$$` 转义成字面的 `$`，
> 容器内的 shell 才能把 `$$MINIO_ROOT_USER` 展开成环境变量。
> 写成 `$MINIO_ROOT_USER` 的话，compose 会先把它当变量插值
> （而它没在 `.env` 里定义），结果是空字符串。

- [ ] **Step 2: 写 MinIO 的环境变量示例**

`api/.env.example` 末尾追加：

```bash
# MinIO（媒体上传）。宿主机端口 19000，容器内 9000。
#
# ⚠️ MINIO_ENDPOINT 必须是**带协议头的完整 URL**：Task 6 会用它拼媒体访问地址
# 与 presigned URL 的 host，少了 http:// 会拼出「19000/ecommerce-media/xxx」
# 这种浏览器打不开的地址。
#
# 浏览器直传用的是宿主机端口，不是容器内端口——容器内的 api 签发
# presigned URL 时也必须用这个对外地址，否则浏览器解析不了 minio:9000。
MINIO_ENDPOINT=http://localhost:19000
# 后端自己访问 MinIO 用的地址（HEAD 确认、删除孤儿）。容器内跑 api 时是服务名。
MINIO_INTERNAL_ENDPOINT=http://minio:9000
# 媒体对外访问的基地址。生产部署时这里应该是 CDN 或 Nginx 暴露的域名，
# 与 MINIO_ENDPOINT 可能不同——所以单独拆一个变量。
MINIO_PUBLIC_URL=http://localhost:19000
MINIO_BUCKET=ecommerce-media
MINIO_REGION=us-east-1
MINIO_ACCESS_KEY=ecommerce
MINIO_SECRET_KEY=ecommerce-minio-secret
# 单文件大小上限（字节）
MEDIA_MAX_SIZE=5242880
```

`infra/.env.example` 追加：

```bash
# MinIO
MINIO_PORT=19000
MINIO_CONSOLE_PORT=19001
MINIO_ROOT_USER=ecommerce
MINIO_ROOT_PASSWORD=ecommerce-minio-secret
```

> **单一真相源约束**（沿用阶段 1 §0.3）：compose 里一律用 `${VAR:-默认值}` 插值，
> `.env.example` 是唯一可编辑的来源。上面 `api/.env.example` 与
> `infra/.env.example` 的重复是因为它们服务于两个独立的 compose 项目，
> 这是阶段 1 已有的结构，不要合并。

- [ ] **Step 3: 起 MinIO 并确认健康**

```bash
cd infra && docker compose up -d minio
```

等待健康：

```bash
cd infra && docker compose ps minio
```

预期：状态为 `healthy`（约 10–20 秒）。

CORS 不用额外配置——`MINIO_CORS_ALLOW_ORIGIN` 已经在 Step 1 写进 compose 的
`environment` 里了，服务一起来就生效。下一个步骤会验证它确实管用。

> **本步不创建 bucket。** 镜像里没有 `mc`，而 `minio/mc`、`quay.io/minio/mc`、
> `bitnami/mc`、`amazon/aws-cli` 在本机的 registry mirror 上全部拉不到。
> 与其在这个 Task 里手写 curl + AWS SigV4 签名去建 bucket，不如留到 Task 6——
> 那时 `@aws-sdk/client-s3` 已经装好，用 SDK 的 `CreateBucketCommand` 建
> 是顺理成章的事。Task 1 只需证明「服务能起、CORS 能配通」。

- [ ] **Step 4: 验证 CORS 预检请求能通过**

```bash
curl -s -i -X OPTIONS "http://localhost:19000/ecommerce-media/test.jpg" \
  -H "Origin: http://localhost:3001" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type" | head -20
```

预期：响应里有 `Access-Control-Allow-Origin: http://localhost:3001` 与
`Access-Control-Allow-Methods` 含 `PUT`。

> **这一步失败就意味着「MinIO 直传」方案不成立**，媒体上传要退回
> 「经后端中转」（浏览器把文件 POST 到 api，api 再转发给 MinIO）。
> 遇到这种情况不要跳过，先按设计文档 §六 的思路改方案再继续。

- [ ] **Step 5: 验证 `pg_trgm` 能否在迁移里执行**

先确认 PostgreSQL 容器里有这个扩展：

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U ecommerce -d ecommerce -c "SELECT name FROM pg_available_extensions WHERE name = 'pg_trgm';"
```

预期输出一行 ` pg_trgm`。

再验证以迁移身份执行 `CREATE EXTENSION` 不会失败——用一个临时事务试：

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U ecommerce -d ecommerce \
  -c "BEGIN; CREATE EXTENSION IF NOT EXISTS pg_trgm; ROLLBACK;"
```

预期：`CREATE EXTENSION`（在事务里执行成功）。

> **这一步失败则搜索方案要换**。`postgres:16-alpine` 官方镜像默认带了 contrib，
> 但如果本机拉的是精简镜像就会缺扩展。替代方案是换 `postgres:16`（非 alpine）
> 镜像，或退回 `ILIKE` 全表扫描（十万级商品内可接受，但要改设计文档 §5.3）。

- [ ] **Step 6: 提交**

```bash
git add infra/docker-compose.yml api/.env.example infra/.env.example
git commit -m "chore: 引入 MinIO 服务与媒体上传相关环境变量"
```

---

## Task 2：数据模型、迁移与扩展的软删除支持

本 Task 落地 9 张新表、部分唯一索引、`pg_trgm` 索引，并给 Prisma 扩展加软删除条件合并。这是后续所有任务的地基。

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20261022100000_add_catalog_tables/migration.sql`
- Modify: `api/src/common/tenant/tenant-models.ts`
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`
- Modify: `api/src/common/decorators/skip.decorator.ts`
- Create: `api/src/common/decorators/public.decorator.ts`
- Modify: `api/src/modules/auth/jwt-auth.guard.ts`
- Test: `api/src/common/tenant/tenant-prisma.service.spec.ts`

### 2.1 先写失败测试

在 `api/src/common/tenant/tenant-prisma.service.spec.ts` 末尾（最后一个 `it` 之后、
`});` 之前）追加两个用例。同时把文件第 11 行的 import 改成：

```typescript
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
```

追加的用例：

```typescript
  it('软删除模型自动合并 deletedAt: null 条件', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: '软删除测试租户', subdomain: `sd-${Date.now()}` },
    });

    const context = { ...tenantA, tenantId: tenant.id };

    const product = await tenantContext.run(context, async () =>
      prisma.product.create({
        data: {
          name: '待软删的商品',
          slug: `sd-product-${Date.now()}`,
        } as unknown as Prisma.ProductCreateInput,
      }),
    );

    // 软删除：设 deletedAt，不做物理删除
    await tenantContext.run(context, async () =>
      prisma.product.updateMany({
        where: { id: product.id },
        data: { deletedAt: new Date() },
      }),
    );

    // 走扩展的查询：软删除的记录必须查不到
    const visible = await tenantContext.run(context, async () =>
      prisma.product.findMany(),
    );
    expect(visible.map((p) => p.id)).not.toContain(product.id);

    // 用裸 Prisma 核对：记录仍在库里（是软删除，不是物理删除）
    const raw = new PrismaClient();
    const stillThere = await raw.product.findUnique({
      where: { id: product.id },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deletedAt).not.toBeNull();
    await raw.$disconnect();

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('软删除模型禁止物理删除', async () => {
    // 放在租户上下文里跑：没有上下文时 resolveScope 会先抛 TenantScopeError，
    // 那样这条用例会因为「错误的原因」通过，验证不到新加的物理删除拦截。
    await expect(
      tenantContext.run(tenantA, async () =>
        prisma.product.deleteMany({ where: { id: 'whatever' } }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });
```

> **为什么物理删除只测 `deleteMany` 不测 `delete`**：`delete` 在阶段 1 就已经被
> `UNIQUE_ONLY_OPERATIONS` 拦掉了（`findUnique` / `update` / `delete` / `upsert`
> 都只接受唯一字段，无法附加 tenantId 条件）。`deleteMany` 不在那张名单里，
> 才是本 Task 新加的 `assertNotPhysicallyDeletable` 真正生效的地方。

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：FAIL，且是**编译期失败**——`prisma.product` 这个 delegate 还不存在
（Step 6 才加 getter），ts-jest 报
`Property 'product' does not exist on type 'TenantPrismaService'`。

> **TypeScript 项目里 TDD 的「红」常常是编译错误而不是断言失败**，这是正常的：
> 测试引用了还不存在的 API，编译不过就是红。判定标准是「这条命令以非零码退出」，
> 不必要求错误信息长得像断言失败。
> 真正要盯的是 Step 9——那时 getter 已经加上，测试应当是**真的跑起来并通过**，
> 而不是又一次编译失败。

- [ ] **Step 2: 改 Prisma schema**

在 `api/prisma/schema.prisma` 的 `model Store { ... }` 之后追加 9 个模型：

```prisma
// ---------- 商品中心 ----------

model Category {
  id        String   @id @default(uuid())
  tenantId  String
  parentId  String?
  name      String
  slug      String
  sort      Int      @default(0)
  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant   Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: Cascade)
  children Category[] @relation("CategoryTree")
  products Product[]

  // ⚠️ 唯一索引刻意**不在 schema 里声明**：软删除后 slug 仍占用唯一性，
  // 而普通的 @@unique 做不到「仅对未删除记录生效」——带 deletedAt 的复合唯一
  // 也无效，因为 PostgreSQL 的 NULL 不参与唯一性判定。
  // 改由迁移手写部分唯一索引（见 migration.sql）。
  @@index([tenantId, parentId])
  @@map("categories")
}

model Product {
  id          String        @id @default(uuid())
  tenantId    String
  categoryId  String?
  name        String
  slug        String
  subtitle    String?
  description String?
  status      ProductStatus @default(DRAFT)
  attributes  Json          @default("{}")
  minPrice    Int           @default(0)
  version     Int           @default(1)
  publishedAt DateTime?
  deletedAt   DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  tenant   Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  category Category?      @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  specs    ProductSpec[]
  skus     Sku[]
  media    ProductMedia[]

  // ⚠️ 唯一索引由迁移手写部分唯一索引，不在 schema 里声明。
  @@index([tenantId, status])
  @@index([tenantId, categoryId])
  @@map("products")
}

enum ProductStatus {
  DRAFT
  PUBLISHED
  UNPUBLISHED
}

model ProductSpec {
  id        String   @id @default(uuid())
  tenantId  String
  productId String
  name      String
  sort      Int      @default(0)
  deletedAt DateTime?

  product Product            @relation(fields: [productId], references: [id], onDelete: Cascade)
  values  ProductSpecValue[]

  // ⚠️ 唯一索引刻意**不在 schema 里声明**，由迁移手写部分唯一索引（见 Step 3）。
  // 软删除后同名规格会占用普通 @@unique：商家把「颜色」规格删掉再加一个同名
  // 的，数据库会直接拒绝。
  @@index([tenantId, productId])
  @@map("product_specs")
}

model ProductSpecValue {
  id        String   @id @default(uuid())
  tenantId  String
  specId    String
  value     String
  mediaId   String?
  sort      Int      @default(0)
  deletedAt DateTime?

  spec  ProductSpec @relation(fields: [specId], references: [id], onDelete: Cascade)
  media Media?      @relation(fields: [mediaId], references: [id], onDelete: SetNull)

  // ⚠️ 唯一索引由迁移手写部分唯一索引（软删除后同名值不占用唯一性）。
  @@index([tenantId, specId])
  @@map("product_spec_values")
}

enum SkuStatus {
  ACTIVE
  INACTIVE
}

model Sku {
  id           String    @id @default(uuid())
  tenantId     String
  productId    String
  code         String?
  price        Int
  comparePrice Int?
  stock        Int       @default(0)
  status       SkuStatus @default(ACTIVE)
  deletedAt    DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  product    Product             @relation(fields: [productId], references: [id], onDelete: Cascade)
  specValues SkuSpecValue[]
  movements  InventoryMovement[]

  // ⚠️ 唯一索引由迁移手写部分唯一索引，不在 schema 里声明。
  @@index([tenantId, productId])
  @@map("skus")
}

model SkuSpecValue {
  id       String @id @default(uuid())
  tenantId String
  skuId    String
  valueId  String

  sku   Sku            @relation(fields: [skuId], references: [id], onDelete: Cascade)
  value ProductSpecValue @relation(fields: [valueId], references: [id], onDelete: Cascade)

  @@unique([skuId, valueId])
  @@index([tenantId, skuId])
  @@map("sku_spec_values")
}

enum MediaStatus {
  PENDING
  READY
  ORPHANED
}

model Media {
  id         String      @id @default(uuid())
  tenantId   String
  key        String
  url        String
  mime       String
  size       Int
  width      Int?
  height     Int?
  status     MediaStatus @default(PENDING)
  uploadedBy String
  deletedAt  DateTime?
  createdAt  DateTime    @default(now())

  tenant      Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  products    ProductMedia[]
  specValues  ProductSpecValue[]

  // ⚠️ 唯一索引由迁移手写部分唯一索引，不在 schema 里声明。
  @@index([tenantId, status])
  @@map("media")
}

model ProductMedia {
  id        String @id @default(uuid())
  tenantId  String
  productId String
  mediaId   String
  sort      Int    @default(0)

  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  media   Media   @relation(fields: [mediaId], references: [id], onDelete: Cascade)

  @@unique([productId, mediaId])
  @@index([tenantId, productId])
  @@map("product_medias")
}

enum InventoryMovementType {
  INITIAL
  ADJUST_IN
  ADJUST_OUT
  CHECK
  RESERVE
  RELEASE
  DEDUCT
}

model InventoryMovement {
  id          String                 @id @default(uuid())
  tenantId    String
  skuId       String
  type        InventoryMovementType
  quantity    Int
  stockBefore Int
  stockAfter  Int
  reason      String?
  operatorId  String
  createdAt   DateTime               @default(now())

  // Restrict 而非 Cascade：流水是审计凭证，物理删除有流水的 SKU 必须被数据库拒绝
  sku Sku @relation(fields: [skuId], references: [id], onDelete: Restrict)

  @@index([tenantId, skuId, createdAt])
  @@map("inventory_movements")
}
```

> **`ProductMedia` 也带 `tenantId`**，因此必须登记进 `TENANT_SCOPED_MODELS`——
> 阶段 1 的 `assertTenantScopedModelsRegistered()` 会在启动时扫描 schema，
> 带 `tenantId` 却没登记的模型会让进程启动失败。这是刻意的 fail-fast。

同时给 `Tenant` 模型补上反向关系（Prisma 要求双向关系都声明）：

```prisma
  categories     Category[]
  products       Product[]
  productSpecs   ProductSpec[]
  productSpecValues ProductSpecValue[]
  skus           Sku[]
  skuSpecValues  SkuSpecValue[]
  medias         Media[]
  productMedias  ProductMedia[]
  inventoryMovements InventoryMovement[]
```

改完 schema 后重新生成 Prisma client（否则 TypeScript 不知道新模型）：

```bash
cd api && npx prisma generate
```

预期输出：`Generated Prisma Client (v6.x.x)`。

- [ ] **Step 3: 生成并手改迁移**

```bash
cd api && npx prisma migrate dev --name add_catalog_tables --create-only
```

> **若这一步因为 drift 失败**（提示数据库状态与迁移历史不一致，要求 reset），
> **不要 reset**——那会丢掉开发库里的数据。改用 `migrate diff` 生成骨架：
>
> ```bash
> cd api && npx prisma migrate diff \
>   --from-schema-datasource prisma/schema.prisma \
>   --to-schema-datamodel prisma/schema.prisma \
>   --script > /tmp/catalog.sql
> ```
>
> 然后手动建迁移目录，把 `/tmp/catalog.sql` 放进去当 `migration.sql`，
> 再在文件末尾追加下面的手写 SQL。
> 阶段 1 就踩过 drift 的坑（手工删过索引导致 `migrate dev` 认为状态不一致）。
>
> **迁移目录名必须是 `YYYYMMDDHHMMSS_名字` 格式**——Prisma 按名字排序执行，
> 格式不对它会拒绝识别。

生成后打开 `api/prisma/migrations/<时间戳>_add_catalog_tables/migration.sql`，
**追加**以下内容（`prisma migrate dev` 生成的 SQL 不含这些）：

```sql
-- 部分唯一索引：软删除后 slug/code 不再占用唯一性。
--
-- 不能用 @@unique 表达：带 deletedAt 的复合唯一无效（PostgreSQL 的 NULL
-- 不参与唯一性判定），只能靠带 WHERE 条件的部分唯一索引。
--
-- 表名带双引号，与 Prisma 生成的迁移保持一致（阶段 1 的迁移就是这么写的）。
CREATE UNIQUE INDEX "categories_tenant_slug_uniq"
  ON "categories" ("tenantId", "slug") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "products_tenant_slug_uniq"
  ON "products" ("tenantId", "slug") WHERE "deletedAt" IS NULL;

-- 规格维度与规格值同样走软删除，普通 @@unique 会让「删掉「颜色」再加一个同名」
-- 直接被数据库拒绝。
CREATE UNIQUE INDEX "product_specs_product_name_uniq"
  ON "product_specs" ("productId", "name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "product_spec_values_spec_value_uniq"
  ON "product_spec_values" ("specId", "value") WHERE "deletedAt" IS NULL;

-- 商家编码大小写不敏感：填 T-Shirt 与 t-shirt 算同一个编码。
-- 与阶段 1 的 users_email_ci_key 同样的处理方式。
-- code 可空，NULL 不参与唯一性判定，所以额外排除 NULL。
CREATE UNIQUE INDEX "skus_tenant_code_uniq"
  ON "skus" (LOWER("code"), "tenantId")
  WHERE "deletedAt" IS NULL AND "code" IS NOT NULL;

-- 商品名称的模糊搜索索引。
-- pg_trgm 的 GIN 索引 Prisma schema 表达不了（@@index 只支持 B-tree），手写。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_name_trgm" ON "products" USING GIN ("name" gin_trgm_ops);

-- 公开列表按状态 + 时间筛选排序
CREATE INDEX "products_tenant_status_published_idx"
  ON "products" ("tenantId", "status", "publishedAt" DESC)
  WHERE "deletedAt" IS NULL;
```

> **`CREATE EXTENSION` 的执行者**：迁移以 `DATABASE_URL` 里的用户（`ecommerce`）身份运行。
> 该用户是 postgres 容器初始化时创建的**超级用户**，因此有权限执行。
> Task 1 Step 6 已验证过这一点。

- [ ] **Step 4: 应用迁移并确认索引建出来了**

```bash
cd api && npx prisma migrate deploy
```

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U ecommerce -d ecommerce -c "\d products"
```

预期：索引列表里能看到 `products_name_trgm`、`products_tenant_status_published_idx`、
`products_tenant_slug_uniq`。

- [ ] **Step 5: 扩白名单**

改 `api/src/common/tenant/tenant-models.ts`：

```typescript
/**
 * 租户作用域模型白名单。
 * 名单内的模型：所有读写自动追加 tenantId 条件。
 * 新增业务表时必须同步登记到此处，否则等于没有隔离。
 *
 * ⚠️ 阶段 1 的 TenantPrismaService.assertTenantScopedModelsRegistered()
 * 会在启动时扫描 schema，带 tenantId 却没登记的模型会直接让进程启动失败。
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User',
  'Store',
  // 商品中心（计划 2）
  'Category',
  'Product',
  'ProductSpec',
  'ProductSpecValue',
  'Sku',
  'SkuSpecValue',
  'Media',
  'ProductMedia',
  'InventoryMovement',
]);

/**
 * 走软删除的模型：扩展自动合并 `deletedAt: null` 条件。
 *
 * 不含 InventoryMovement —— 流水表是 append-only 的审计凭证，
 * 既不软删也不允许物理删除。
 */
export const SOFT_DELETE_MODELS = new Set<string>([
  'Category',
  'Product',
  'Sku',
  'Media',
]);
```

- [ ] **Step 6: 给扩展加软删除合并**

改 `api/src/common/tenant/tenant-prisma.service.ts`。

**6a. 加辅助函数**（放在 `withMergedWhere` 之后）：

```typescript
/**
 * 软删除模型：自动把 `deletedAt: null` 合并进 where。
 *
 * 合并而不是由调用方写，是为了「漏写一处就漏过滤一处」这种失效模式
 * 不会发生——过滤条件由扩展统一施加，业务代码无从绕过。
 *
 * 与 tenantId 的合并是两次独立的 merge：两次都调用 withMergedWhere，
 * 后一次会保留前一次已经写进去的键（withMergedWhere 是 {...base, ...extra}）。
 */
function withSoftDeleteFilter<T>(args: T, model: string): T {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  return withMergedWhere(args, { deletedAt: null });
}
```

**6b. 在每个读方法里合并**。把现有的：

```typescript
      async findMany({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        if (scope.kind !== 'tenant') return query(args);
        return query(withMergedWhere(args, scope.where));
      },
```

改成：

```typescript
      async findMany({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },
```

同样改 `findFirst`、`findFirstOrThrow`、`count`、`aggregate`、`groupBy` 六个方法。

> **注意**：`withSoftDeleteFilter` 要在 `resolveScope` 之后、`withMergedWhere` 之前应用。
> `resolveScope` 对不在白名单的模型返回 `not-scoped`，此时 `query(args)` 直接放行，
> 但软删除过滤仍要生效——所以过滤的合并不能放在 `if` 的早退分支之后。

**6c. 在写方法里合并**。`updateMany`、`updateManyAndReturn`、`deleteMany` 三个方法，
把 `return query(withMergedWhere(args, scope.where));` 改成：

```typescript
        const withDelete = withSoftDeleteFilter(args, model);
        return query(withMergedWhere(withDelete, scope.where));
```

**6d. 禁止物理删除**。在 `delete` 与 `deleteMany` 上加检查：

```typescript
      async delete({ model, args, query }) {
        assertNotUniqueOnly(model, 'delete');
        assertNotPhysicallyDeletable(model, 'delete');
        return query(args);
      },
```

并在 `deleteMany` 里加同样一行。新增辅助函数：

```typescript
/**
 * 软删除模型禁止物理删除。
 *
 * 物理删除会连带毁掉审计链：SKU 被物理删除后，它的历史库存流水
 * 就失去了指向对象（数据库层面还有 Restrict 外键兜着，但品类、
 * 媒体这类没有流水引用的模型就没有第二道防线了）。
 *
 * 「删除」的正确做法是软删除：
 *   await prisma.product.updateMany({ where: { id }, data: { deletedAt: new Date() } })
 */
function assertNotPhysicallyDeletable(model: string, operation: string): void {
  if (!SOFT_DELETE_MODELS.has(model)) return;
  throw new TenantScopeError(
    `模型 ${model} 是软删除模型，禁止使用 ${operation} 物理删除。` +
      '请改用 updateMany 设置 deletedAt。',
  );
}
```

**6e. 加 9 个 delegate getter**。在 `get refreshToken()` 之后追加：

```typescript
  get category() {
    return this.client.category;
  }

  get product() {
    return this.client.product;
  }

  get productSpec() {
    return this.client.productSpec;
  }

  get productSpecValue() {
    return this.client.productSpecValue;
  }

  get sku() {
    return this.client.sku;
  }

  get skuSpecValue() {
    return this.client.skuSpecValue;
  }

  get media() {
    return this.client.media;
  }

  get productMedia() {
    return this.client.productMedia;
  }

  get inventoryMovement() {
    return this.client.inventoryMovement;
  }
```

- [ ] **Step 7: 加 `@Public()` 装饰器**

改 `api/src/common/decorators/skip.decorator.ts`：

```typescript
import { SetMetadata } from '@nestjs/common';

export const SKIP_KEY = 'skip:interceptors';

/**
 * 标记该路由不经过租户上下文拦截器（健康检查等公共端点）。
 *
 * ⚠️ 与 @Public() 语义严格分离，不要混用：
 * - @Skip()：**不建立租户上下文**。只适用于完全不碰租户作用域模型的端点
 *   （如健康检查）。用在需要查业务表的地方会直接 500——
 *   隔离机制是 fail-closed 的，缺上下文时扩展会抛 TenantScopeError。
 * - @Public()：建立租户上下文（从子域名解析），只是不做身份认证。
 *   商品浏览这类「匿名但要按店铺隔离」的端点用它。
 */
export const Skip = () => SetMetadata(SKIP_KEY, true);
```

新建 `api/src/common/decorators/public.decorator.ts`：

```typescript
import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'public:auth';

/**
 * 标记该路由允许匿名访问。
 *
 * 与 @Skip() 的区别是**只放行身份认证，不跳过租户上下文**：
 * 租户上下文拦截器照常从子域名解析租户，因此公开读到的数据
 * 仍然经过租户隔离机制（Prisma 扩展自动附加 where.tenantId）。
 *
 * 适用：商品浏览、店铺公开信息这类「数据本来公开、但仍需按店铺隔离」的端点。
 *
 * ⚠️ 使用前提：挂 @Public() 的端点**只能返回公开数据**。
 * 若在公开端点上查本租户的数据（如订单），攻击者可以用伪造的
 * X-Tenant-Subdomain 头读到别人的数据——那时必须把端点挪到需要认证的路径上。
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
```

- [ ] **Step 8: 让 JWT 守卫识别 `@Public()`**

改 `api/src/modules/auth/jwt-auth.guard.ts`：

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PUBLIC_KEY } from '../../common/decorators/public.decorator';

/**
 * JWT 认证守卫。
 *
 * 只做「令牌有效 + 用户存在」这一层；角色级别的越权防护属于 Task 7 的 RBAC 守卫，
 * 这里刻意不混入，避免两种失败语义（401 未认证 / 403 已认证但无权限）混在一个守卫里。
 *
 * 命中 @Public() 的路由直接放行——但**只放行身份认证**，
 * 租户上下文拦截器不受影响，公开读依然经过租户隔离。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

- [ ] **Step 9: 跑测试**

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：PASS。

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：0 error。

- [ ] **Step 10: 验证「关联读取也触发扩展过滤」**

这是设计文档 §4.9 标出的风险点：Prisma 的嵌套 `include` 是否也走扩展的 `where`
合并。若不走，软删的 SKU 仍会出现在商品详情里——整个软删除方案就漏了。

**写成常驻的 jest 用例**，加到 `api/src/common/tenant/tenant-prisma.service.spec.ts`：

```typescript
  it('软删除能穿透关联读取', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: '关联读取测试租户', subdomain: `ar-${Date.now()}` },
    });

    const context = { ...tenantA, tenantId: tenant.id };

    const product = await tenantContext.run(context, async () =>
      prisma.product.create({
        data: {
          name: '带媒体的商品',
          slug: `ar-product-${Date.now()}`,
        } as unknown as Prisma.ProductCreateInput,
      }),
    );

    const media = await tenantContext.run(context, async () =>
      prisma.media.create({
        data: {
          key: `ar/${Date.now()}.jpg`,
          url: 'http://localhost:19000/ecommerce-media/ar/x.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: 'tester',
        } as unknown as Prisma.MediaCreateInput,
      }),
    );

    await tenantContext.run(context, async () =>
      prisma.productMedia.create({
        data: { productId: product.id, mediaId: media.id, sort: 0 },
      } as unknown as Prisma.ProductMediaCreateInput),
    );

    // 软删这张媒体
    await tenantContext.run(context, async () =>
      prisma.media.updateMany({
        where: { id: media.id },
        data: { deletedAt: new Date() },
      }),
    );

    // 关联读取：product 里不该再出现这张媒体
    const products = await tenantContext.run(context, async () =>
      prisma.product.findMany({
        where: { id: product.id },
        include: { media: true },
      }),
    );

    expect(products[0]?.media ?? []).toHaveLength(0);

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });
```

跑：

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：PASS。

> **如果失败**：说明 Prisma 的关联读取不走扩展的 `where` 合并。
> 此时软删除方案要改——在业务层显式过滤，或改用 `deletedAt` 的部分索引 + 查询时
> 手工加条件。**不要跳过这一步直接往下做**，Task 4 的商品详情会依赖这个结论。
>
> **为什么写成 jest 用例而不是一次性脚本**：`ts-node` 不会加载 `.env`，
> `new PrismaClient()` 会连到开发库或直接连不上；而且一次性脚本验证完就丢了，
> 回归时没人会再跑一遍。放进 spec 里既用测试库，又成为常驻的回归防护。

- [ ] **Step 11: 提交**

```bash
git add api/prisma api/src
git commit -m "feat(api): 商品中心数据模型、软删除过滤与 @Public() 装饰器"
```

---

## Task 3：品类模块

品类是租户自建的层级树。三个容易出错的地方：层级深度限制、跨租户挂载拦截、
删除时的子项检查。

**Files:**
- Create: `api/src/modules/catalog/catalog.module.ts`
- Create: `api/src/modules/catalog/categories/categories.service.ts`
- Create: `api/src/modules/catalog/categories/categories.controller.ts`
- Create: `api/src/modules/catalog/dto/create-category.dto.ts`
- Create: `api/src/modules/catalog/dto/update-category.dto.ts`
- Create: `api/test/catalog.e2e-spec.ts`
- Modify: `api/src/app.module.ts`

### 3.1 先写失败测试

**先创建 `api/test/merchant-fixture.ts`**——本计划后面 5 个 Task 的 e2e 都要用
`createMerchant()` 与 `unique()`。现在一次建好独立文件，比等到 Task 7 再回头
重构 Task 3 的 e2e 更稳（跨 Task 改文件容易漏）。

创建 `api/test/merchant-fixture.ts`：

```typescript
import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';

/** 随机后缀，避免同一个库里多次运行的测试撞 key / subdomain */
export const unique = () => randomBytes(6).toString('hex');

export interface MerchantFixture {
  token: string;
  subdomain: string;
  tenantId: string;
}

/**
 * 注册一个商家，返回 accessToken、子域名与租户 id。
 *
 * 注册接口本身就直接返回 accessToken（阶段 1 的设计），不必再登录一次。
 * 请求体字段名以 `RegisterMerchantDto` 为准：email / password /
 * merchantName / subdomain / storeName；密码规则是 8-72 位且同时含字母与数字。
 */
export async function createMerchant(
  app: INestApplication,
  prisma: TenantPrismaService,
): Promise<MerchantFixture> {
  const subdomain = `shop-${unique()}`;

  const response = await http(app)
    .post('/api/v1/auth/register/merchant')
    .send({
      email: `merchant-${unique()}@example.test`,
      password: 'Passw0rd123',
      merchantName: '测试商家',
      subdomain,
      storeName: '测试店铺',
    })
    .expect(201);

  return {
    token: response.body.accessToken as string,
    subdomain,
    tenantId: response.body.user.tenantId as string,
  };
}
```

然后创建 `api/test/catalog.e2e-spec.ts`。建应用的方式沿用阶段 1 的 e2e（先读
`api/test/stores.e2e-spec.ts` 对照，本文件是它的同构版本）：

```typescript
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

describe('品类 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
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

    prisma = app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

```

> **管理端接口要 JWT**：品类 controller 挂 `@UseGuards(JwtAuthGuard)`，
> e2e 用 `createMerchant()` 拿到的 token。租户隔离此时来自令牌里的
> `tenantId`，与子域名无关——这正是要验的点。

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：FAIL，404（路由还不存在）。

> ### ⚠️ 本 Task 实施后的修正（以实现为准）
>
> 执行本 Task 时审查发现并修掉了三处，说明里的代码需要按下面调整：
>
> **① `depthOf` 的 off-by-one。** 说明里那版无条件 `depth += 1`，走到根节点
> （`parentId` 为 null）那次循环照样加，于是二级品类被算成 3 层——
> **第三层品类永远创建不出来**。修法：读到 `parentId === null` 直接返回当前深度。
>
> **② `update` 换父时要校验子树深度，不只是新父的深度。** `assertParentUsable`
> 只看新父节点。带子树的节点被移到同级父下时，整棵子树会下沉一层而超出上限，
> 无人报错。需要 `depthOf(newParent) + subtreeHeight(id) <= MAX_CATEGORY_DEPTH`。
>
> **③ 换父要显式挡环。** 说明里只挡了「自己挂自己」。挂到自己的子孙下会成环，
> 当前恰好被 `depthOf` 沿环走到深度上限而拦住——那是**巧合不是检测**，
> 而 `subtreeHeight` 遇到环会栈溢出。需要 `assertNoCycle`（沿新父上溯找自己，
> 带步数上限防脏数据挂死）。
>
> **三处检查的顺序不能换**：`assertNoCycle` 必须在 `assertParentUsable` 之前。
> 反了的话环会被深度检查抢先拦下，环检测形同虚设。
> 三处都只在 `dto.parentId !== category.parentId` 时才跑。
>
> 最终 e2e 15 个用例，其中三个是变异验证过的（把对应的守卫注释掉，用例会真实失败）。

> ### ⚠️ 本 Task 实施后的修正（以实现为准）
>
> **① 原生 SQL 的列名是 camelCase，不是 snake_case。**
> `@@map` 只映射**表名**（`products` / `skus`），schema 里的字段没有 `@map`，
> 所以列名就是 `"productId"` / `"tenantId"` / `"minPrice"` / `"deletedAt"`。
> 写 snake_case 报 `column "product_id" does not exist`；
> 改成 camelCase 但**不加双引号**更坑——PostgreSQL 会折叠成小写，
> 报 `column "productid" does not exist`，字面上完全看不出只是少了一对引号。
>
> **② 百分比调价不能用浮点。**
> `Math.ceil(price * (1 + value / 100))` 有 IEEE754 陷阱：
> `3000 * 1.1` 的真值是 `3300.0000000000005`，ceil 成 **3301**——
> 商家「涨 10%」凭空多收一分钱。而且它**只在部分金额上发生**
> （`1000 * 1.1` 恰好等于 1100），这类金额相关的行为极难测出。
> 要在整数域完成乘法，除以 100 有余数才 +1，全程不碰浮点。
>
> **③ 乐观锁必须是原子的。**
> 说明里那版是「先 `findFirst` 校验 version、再无条件 `updateMany`」，
> 两步之间有竞态窗口——真正同时到达的两个请求都能通过校验然后都写进去，
> 后写覆盖先写。
> 正确做法是把 `version` 放进 `updateMany` 的 `where`，
> 由数据库在写入那一刻判断，受影响行数为 0 就抛 409。
> 前面的比较只当**快速失败**用，挡住「基于陈旧页面的顺序编辑」；
> 真正挡并发的是 where 里的条件。
>
> **④ 跨租户媒体的 e2e 用例不能拿别人的商品来测。**
> 说明里让 B 引用「A 名下商品的 A 的媒体」，但 B 在商品那一层就 404 了，
> 根本走不到媒体归属校验——恒真。要把商品建在 B 名下才测得到目标路径，
> 并在 400 之后额外查一次关联表确认真没写进去。

- [ ] **Step 2: 写 DTO**

创建 `api/src/modules/catalog/dto/create-category.dto.ts`：

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 品类创建。
 *
 * 刻意不接受 tenantId：租户扩展在写入时强制注入，客户端传了也会被覆盖；
 * ValidationPipe 开了 forbidNonWhitelisted，多传的字段直接 400。
 */
export class CreateCategoryDto {
  @ApiProperty({ minLength: 1, maxLength: 60, example: '女装' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 60,
    example: 'women',
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'URL 片段，租户内唯一（仅对未删除的品类生效）',
  })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字与连字符' })
  slug!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: '父品类 id，留空表示一级品类',
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ default: 0, description: '同级排序，数字小的靠前' })
  @IsOptional()
  @IsInt()
  sort?: number;
}
```

创建 `api/src/modules/catalog/dto/update-category.dto.ts`：

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 品类更新。所有字段可选，不传的保持原值。
 *
 * 用展开运算逐字段构造 data 而不是 `...dto`：直接展开会把将来往 DTO 上
 * 加的字段一并灌进 data，无意中扩大写入面。
 *
 * ⚠️ 不允许改 slug。slug 参与 URL，改了会让旧链接失效，
 * 而阶段 2 不做重定向（设计文档 §十三 开放问题 2）。商品的 slug 同理。
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ description: '父品类 id，null 表示提到一级' })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @ApiPropertyOptional({ description: '同级排序' })
  @IsOptional()
  @IsInt()
  sort?: number;
}
```

- [ ] **Step 3: 写 CategoriesService**

创建 `api/src/modules/catalog/categories/categories.service.ts`：

```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Category } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

/** 品类树的最大层数。一级品类算第 1 层。 */
export const MAX_CATEGORY_DEPTH = 3;

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 取当前租户 id；没有租户上下文时抛 404（不给调用方泄露「鉴权失败」细节） */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 品类树。
   *
   * 一次查平铺列表后在内存里拼树，而不是递归查询：
   * 品类数量在商家尺度上是几十到几百条，一次全取比 N+1 次递归快得多，
   * 而且避免了在循环里发查询（那会让租户上下文在 await 边界上更难保证）。
   */
  async tree(): Promise<Array<Category & { children: Category[] }>> {
    const tenantId = this.currentTenantId();
    const all = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
    });

    const byId = new Map<string, Category & { children: Category[] }>();
    for (const row of all) {
      byId.set(row.id, { ...row, children: [] });
    }

    const roots: Array<Category & { children: Category[] }> = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * 计算某个品类自身的层级深度（自身算第 1 层）。
   *
   * 沿着 parentId 往上走，最多走 MAX_CATEGORY_DEPTH 步。
   * 走满还没到顶说明链已经超深——这在正常数据里不可能（创建时已校验），
   * 但数据被外部改过时不能无限循环，所以给一个硬上限。
   */
  private async depthOf(categoryId: string): Promise<number> {
    let depth = 1;
    let currentId: string | null = categoryId;

    while (currentId && depth <= MAX_CATEGORY_DEPTH) {
      const row: { parentId: string | null } | null =
        await this.prisma.category.findFirst({
          where: { id: currentId },
          select: { parentId: true },
        });
      if (!row) return depth;
      // 走到顶了：这条链到此为止，当前 depth 就是答案，不再 +1。
      //
      // ⚠️ 无条件 `depth += 1` 会 off-by-one——根节点的 parentId 是 null，
      // 那次循环照样 +1，于是二级品类被算成 3 层，创建三级时被自己的上限拦下。
      if (!row.parentId) return depth;
      currentId = row.parentId;
      depth += 1;
    }
    return depth;
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    const tenantId = this.currentTenantId();

    if (dto.parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new BadRequestException('父品类不存在');
      }
      const parentDepth = await this.depthOf(dto.parentId);
      if (parentDepth >= MAX_CATEGORY_DEPTH) {
        throw new BadRequestException(
          `品类最多 ${MAX_CATEGORY_DEPTH} 层，「${parent.name}」已经在第 ${parentDepth} 层`,
        );
      }
    }

    return this.prisma.category.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
      } as never,
    });
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    const tenantId = this.currentTenantId();
    const category = await this.prisma.category.findFirst({ where: { id } });
    if (!category) {
      throw new NotFoundException('品类不存在');
    }

    // 换父节点时，父节点必须存在，且不能把自己挂到自己下面
    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('品类不能作为自己的父品类');
      }
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new BadRequestException('父品类不存在');
      }
      const parentDepth = await this.depthOf(dto.parentId);
      if (parentDepth >= MAX_CATEGORY_DEPTH) {
        throw new BadRequestException(
          `品类最多 ${MAX_CATEGORY_DEPTH} 层，「${parent.name}」已经在第 ${parentDepth} 层`,
        );
      }
    }

    await this.prisma.category.updateMany({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
      },
    });

    return this.prisma.category.findFirst({ where: { id } }) as Promise<Category>;
  }

  /**
   * 软删除品类。
   *
   * 有子品类或有商品时拒绝：留下指向已删品类的悬空引用会让前台
   * 分类导航出现空栏目。
   */
  async remove(id: string): Promise<void> {
    const category = await this.prisma.category.findFirst({ where: { id } });
    if (!category) {
      throw new NotFoundException('品类不存在');
    }

    const children = await this.prisma.category.count({
      where: { parentId: id },
    });
    if (children > 0) {
      throw new BadRequestException('该品类下还有子品类，请先删除子品类');
    }

    const products = await this.prisma.product.count({
      where: { categoryId: id },
    });
    if (products > 0) {
      throw new BadRequestException('该品类下还有商品，请先移动或删除商品');
    }

    await this.prisma.category.updateMany({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
```

- [ ] **Step 4: 写 CategoriesController**

创建 `api/src/modules/catalog/categories/categories.controller.ts`：

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

@ApiTags('categories')
@Controller('catalog/categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: '品类树' })
  tree() {
    return this.categoriesService.tree();
  }

  @Post()
  @ApiOperation({ summary: '创建品类' })
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新品类' })
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除品类（软删除）' })
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
```

- [ ] **Step 5: 写 CatalogModule 并注册**

创建 `api/src/modules/catalog/catalog.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CatalogModule {}
```

改 `api/src/app.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoresModule } from './modules/stores/stores.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { CatalogModule } from './modules/catalog/catalog.module';

@Module({
  imports: [
    HealthModule,
    TenancyModule,
    AuthModule,
    StoresModule,
    TenantsModule,
    CatalogModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 6: 补齐 e2e 用例**

在 `api/test/catalog.e2e-spec.ts` 里补上完整的用例集：

```typescript
  it('创建一级品类', async () => { /* 见上文 */ });

  it('创建三级品类成功，创建第四级被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const level1 = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '一级', slug: `l1-${unique()}` })
      .expect(201);

    const level2 = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '二级', slug: `l2-${unique()}`, parentId: level1.body.id })
      .expect(201);

    const level3 = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '三级', slug: `l3-${unique()}`, parentId: level2.body.id })
      .expect(201);

    await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '四级', slug: `l4-${unique()}`, parentId: level3.body.id })
      .expect(400);
  });

  it('跨租户不可见：别的商家的品类不在我的品类树里', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${a.token}`)
      .send({ name: 'A 的品类', slug: `a-${unique()}` })
      .expect(201);

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);

    expect(tree.body).toEqual([]);
  });

  it('跨租户不可改：改别人的品类返回 404', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${a.token}`)
      .send({ name: 'A 的品类', slug: `a-${unique()}` })
      .expect(201);

    await http(app)
      .patch(`/api/v1/catalog/categories/${created.body.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ name: '被篡改' })
      .expect(404);
  });

  it('把品类挂到别的租户的父品类下被拒绝', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const aCategory = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${a.token}`)
      .send({ name: 'A 的父品类', slug: `ap-${unique()}` })
      .expect(201);

    await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${b.token}`)
      .send({
        name: 'B 的子品类',
        slug: `bc-${unique()}`,
        parentId: aCategory.body.id,
      })
      .expect(400);
  });

  it('删除品类是软删除：删掉后不再出现在树里', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '待删品类', slug: `del-${unique()}` })
      .expect(201);

    await http(app)
      .delete(`/api/v1/catalog/categories/${created.body.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(204);

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    expect(tree.body).toEqual([]);
  });
```

- [ ] **Step 7: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：全部 PASS。

- [ ] **Step 8: 类型检查与 lint**

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：0 error。

- [ ] **Step 9: 提交**

```bash
git add api/src api/test
git commit -m "feat(api): 品类模块（租户自建层级树，深度限制 3 层）"
```

---

## Task 4：商品 CRUD 与 minPrice 维护

商品是本阶段的核心实体。本 Task 做商品的增删改查、状态流转与批量操作，
以及 `minPrice` 派生字段的维护。规格矩阵在 Task 5。

**Files:**
- Create: `api/src/modules/catalog/products/products.service.ts`
- Create: `api/src/modules/catalog/products/products.controller.ts`
- Create: `api/src/modules/catalog/pricing/min-price.service.ts`
- Create: `api/src/modules/catalog/dto/create-product.dto.ts`
- Create: `api/src/modules/catalog/dto/update-product.dto.ts`
- Create: `api/src/modules/catalog/dto/batch-products.dto.ts`
- Modify: `api/src/modules/catalog/catalog.module.ts`
- Modify: `api/test/catalog.e2e-spec.ts`

### 4.1 先写失败测试

在 `api/test/catalog.e2e-spec.ts` 的 `describe` 里追加用例。沿用已有的
`createMerchant()` 辅助：

```typescript
  it('创建商品默认是草稿状态，minPrice 为 0', async () => {
    const merchant = await createMerchant(app, prisma);

    const response = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        name: '经典圆领 T 恤',
        slug: `tee-${unique()}`,
      })
      .expect(201);

    expect(response.body.status).toBe('DRAFT');
    expect(response.body.minPrice).toBe(0);
    expect(response.body.version).toBe(1);
  });

  it('商品归属当前租户：别的租户看不到也改不了', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${a.token}`)
      .send({ name: 'A 的商品', slug: `pa-${unique()}` })
      .expect(201);

    await http(app)
      .get(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(404);

    await http(app)
      .patch(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ name: '被篡改' })
      .expect(404);
  });

  it('上架商品写入 publishedAt', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '待上架商品', slug: `pub-${unique()}` })
      .expect(201);

    const published = await http(app)
      .patch(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    expect(published.body.status).toBe('PUBLISHED');
    expect(published.body.publishedAt).toBeTruthy();
  });

  it('乐观锁：version 不匹配时返回 409', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '并发编辑商品', slug: `cc-${unique()}` })
      .expect(201);

    // 第一次更新成功，version 递增
    const updated = await http(app)
      .patch(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '第一次改名', version: created.body.version })
      .expect(200);

    // version 必须真的递增了，否则这条用例测不到乐观锁
    expect(updated.body.version).toBe(created.body.version + 1);

    // 第二次用旧的 version，冲突
    await http(app)
      .patch(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '第二次改名', version: created.body.version })
      .expect(409);
  });

  it('删除商品是软删除：列表里不再出现', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '待删商品', slug: `dp-${unique()}` })
      .expect(201);

    await http(app)
      .delete(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(204);

    const list = await http(app)
      .get('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const ids = (list.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).not.toContain(created.body.id);
  });

  it('设置商品媒体：跨租户的媒体不可引用', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${a.token}`)
      .send({ name: '媒体商品', slug: `md-${unique()}` })
      .expect(201);

    // A 造一张 READY 的媒体
    const media = await tenantContext.run(
      { tenantId: a.tenantId, userId: null, role: null },
      async () =>
        prisma.media.create({
          data: {
            key: `t/${Date.now()}.jpg`,
            url: 'http://localhost:19000/ecommerce-media/t/x.jpg',
            mime: 'image/jpeg',
            size: 100,
            status: 'READY',
            uploadedBy: 'tester',
          },
        }),
    );

    // B 引用 A 的媒体 → 400
    await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/media`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ mediaIds: [media.id] })
      .expect(400);

    // A 自己引用 → 200
    await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/media`)
      .set('authorization', `Bearer ${a.token}`)
      .send({ mediaIds: [media.id] })
      .expect(200);
  });

  it('批量上下架', async () => {
    const merchant = await createMerchant(app, prisma);

    const a = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '批量商品 A', slug: `ba-${unique()}` })
      .expect(201);

    const b = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '批量商品 B', slug: `bb-${unique()}` })
      .expect(201);

    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        ids: [a.body.id, b.body.id],
        action: 'PUBLISH',
      })
      .expect(200);

    expect(response.body.updated).toBe(2);
  });
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：新增的 6 条 FAIL（404，路由不存在），已有的品类用例仍然 PASS。

- [ ] **Step 2: 写 DTO**

创建 `api/src/modules/catalog/dto/create-product.dto.ts`：

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 商品创建。
 *
 * 刻意不接受 tenantId / minPrice / version / publishedAt / deletedAt：
 * - tenantId 由租户扩展注入
 * - minPrice 是派生字段，由 SKU 价格推导（见 MinPriceService）
 * - version / publishedAt / deletedAt 由服务端维护
 *
 * ValidationPipe 开了 forbidNonWhitelisted，客户端多传这些字段直接 400。
 */
export class CreateProductDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: '经典圆领 T 恤' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 120,
    example: 'classic-tee',
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'URL 片段，租户内唯一（仅对未删除的商品生效）',
  })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字与连字符' })
  slug!: string;

  @ApiPropertyOptional({ maxLength: 200, description: '副标题，显示在详情页价格下方' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @ApiPropertyOptional({ description: '商品详情，支持纯文本与换行' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ nullable: true, description: '品类 id' })
  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { 材质: '纯棉', 产地: '浙江' },
    description:
      '描述性属性（材质、产地这类不决定 SKU 组合的参数）。仅用于详情页展示，不参与按属性筛选',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}
```

创建 `api/src/modules/catalog/dto/update-product.dto.ts`：

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ProductStatus } from '@prisma/client';

/**
 * 商品更新。所有字段可选，不传的保持原值。
 *
 * ⚠️ 不允许改 slug（改了旧链接失效，阶段 2 不做重定向）。
 * ⚠️ 不允许直接改 minPrice（派生字段，由 SKU 价格推导）。
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @ApiPropertyOptional({ description: '商品详情' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ nullable: true, description: '品类 id，null 表示移出分类' })
  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({
    enum: ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'],
    description: '商品状态。首次转为 PUBLISHED 时写入 publishedAt',
  })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'UNPUBLISHED'])
  status?: ProductStatus;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      '乐观锁版本号。必须传当前版本，服务端校验不匹配时返回 409',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
```

创建 `api/src/modules/catalog/dto/set-product-media.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

/**
 * 设置商品的媒体列表（整体替换）。
 *
 * 数组顺序就是 sort——第一个是封面。
 *
 * 整体替换而不是增量接口，与规格矩阵同理：前端不需要自己算增量，
 * 后端在一个事务里做「校验归属 → 删掉不再引用的 → 补上新引用的 → 重排 sort」。
 */
export class SetProductMediaDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    maxItems: 20,
    example: ['media-id-1', 'media-id-2'],
    description: '媒体 id 的有序列表，第一个是封面',
  })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  mediaIds!: string[];
}
```

创建 `api/src/modules/catalog/dto/batch-products.dto.ts`：

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';

/** 批量操作的动作 */
export const BATCH_ACTIONS = [
  'PUBLISH',
  'UNPUBLISH',
  'DELETE',
  'SET_CATEGORY',
  'ADJUST_PRICE',
] as const;

export type BatchAction = (typeof BATCH_ACTIONS)[number];

/**
 * 批量操作。
 *
 * 单事务执行：要么全部生效，要么全部不生效。批量删除是软删除。
 */
export class BatchProductsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    maxItems: 200,
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({ enum: BATCH_ACTIONS })
  @IsIn(BATCH_ACTIONS)
  action!: BatchAction;

  @ApiPropertyOptional({ description: 'action=SET_CATEGORY 时必填' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    enum: ['SET', 'PERCENT'],
    description: 'action=ADJUST_PRICE 时必填。SET 设为固定价，PERCENT 按百分比调整',
  })
  @IsOptional()
  @IsIn(['SET', 'PERCENT'])
  mode?: 'SET' | 'PERCENT';

  @ApiPropertyOptional({
    description:
      'action=ADJUST_PRICE 时必填。SET 模式为分（整数），PERCENT 模式为百分比整数（10 表示 +10%）',
  })
  @IsOptional()
  @IsInt()
  value?: number;
}
```

> **`ADJUST_PRICE` 的语义**：作用于选中商品下**全部 ACTIVE 且未删除的 SKU**。
> `SET` 把每个 SKU 的 price 设为该值（分）；`PERCENT` 按百分比调整，
> 向上取整到分（`Math.ceil(price * (1 + value / 100))`）。
> 调整后必须在同一事务里重算受影响商品的 `minPrice`。

- [ ] **Step 3: 写 MinPriceService**

创建 `api/src/modules/catalog/pricing/min-price.service.ts`：

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';

/**
 * 事务客户端的类型。TenantPrismaService.$transaction 的回调参数就是这个类型。
 * 单独起名是为了让签名可读。
 */
export type PrismaTransaction = Omit<
  TenantPrismaService,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * 商品最低价的维护。
 *
 * `Product.minPrice` 是**派生字段**：真实价格在 SKU 上，商品本身没有价格。
 * 之所以冗余它，是因为 Prisma 不支持按关系字段排序
 * （`orderBy: { skus: { price: 'asc' } }` 不可用），而按价格排序是商品列表
 * 最常用的排序方式。绕过去的唯一办法是原生 SQL——那会绕过整个 Prisma 扩展，
 * 等于手写隔离条件，是阶段 1 花了大力气避免的事。
 *
 * 价格区间筛选也用它，与排序共用同一个字段，保证「筛选后」与「排序后」
 * 的语义一致（都用商品最低价）。
 *
 * ⚠️ 维护规则：
 * 1. 只有 ACTIVE 且未删除的 SKU 参与计算；
 * 2. 重算与价格写入必须在同一事务内；
 * 3. 重算用一条 SQL 完成，不在应用层循环 SKU。
 */
@Injectable()
export class MinPriceService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 重算指定商品的最低价。
   *
   * 必须在调用方的事务内执行（传入同一个 tx），
   * 否则会出现「价格已改、最低价还是旧值」的中间态被读到的窗口。
   *
   * ⚠️ `$executeRaw` **绕过了 Prisma 扩展**——扩展只作用于 Prisma 的模型
   * 查询，裸 SQL 不经过它。所以租户条件必须在这条 SQL 里手写：
   * 子查询的 `tenant_id` 与外层的 `p.tenant_id` 都要有。
   * 漏掉任何一处，跨租户改价就会污染别人的商品最低价。
   */
  async recalculate(
    tx: PrismaTransaction,
    tenantId: string,
    productIds: string[],
  ): Promise<void> {
    if (productIds.length === 0) return;

    await tx.$executeRaw`
      UPDATE products p SET min_price = sub.min_price
      FROM (
        SELECT product_id, MIN(price) AS min_price
        FROM skus
        WHERE product_id IN (${Prisma.join(productIds)})
          AND tenant_id = ${tenantId}
          AND status = 'ACTIVE'
          AND deleted_at IS NULL
        GROUP BY product_id
      ) sub
      WHERE p.id = sub.product_id AND p.tenant_id = ${tenantId}
    `;
  }
}
```

- [ ] **Step 4: 写 ProductsService**

创建 `api/src/modules/catalog/products/products.service.ts`：

```typescript
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product, ProductStatus } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';
import { MinPriceService, PrismaTransaction } from '../pricing/min-price.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { BatchProductsDto } from '../dto/batch-products.dto';
import { SetProductMediaDto } from '../dto/set-product-media.dto';

/** 管理端列表的每页条数上限 */
export const MAX_PAGE_SIZE = 100;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly minPrice: MinPriceService,
  ) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /** 管理端列表：分页 + 关键词 + 品类 + 状态筛选 */
  async list(query: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    categoryId?: string;
    status?: ProductStatus;
  }): Promise<{ items: Product[]; total: number; page: number; pageSize: number }> {
    const tenantId = this.currentTenantId();
    const page = Math.max(1, query.page ?? 1);
    // pageSize 上限 100：否则 pageSize=99999 能把整个租户的商品拖出去
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.ProductWhereInput = {
      tenantId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { slug: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** 商品详情（含规格与 SKU）。规格在 Task 5 接入后才有数据。 */
  async findOne(id: string) {
    this.currentTenantId();
    // ⚠️ 三处 include 都要显式写 where —— 见 §0.4：扩展的软删除过滤
    // 只作用于顶层，嵌套关联不会被自动过滤。
    // media 是 ProductMedia 列表（to-many），用关系条件过滤它关联的 Media。
    const product = await this.prisma.product.findFirst({
      where: { id },
      include: {
        skus: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        specs: {
          where: { deletedAt: null },
          orderBy: { sort: 'asc' },
          include: {
            values: { where: { deletedAt: null }, orderBy: { sort: 'asc' } },
          },
        },
        media: {
          where: { media: { deletedAt: null } },
          orderBy: { sort: 'asc' },
        },
      },
    });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    return product;
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const tenantId = this.currentTenantId();

    if (dto.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new BadRequestException('品类不存在');
      }
    }

    return this.prisma.product.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.attributes !== undefined ? { attributes: dto.attributes } : {}),
      } as never,
    });
  }

  /**
   * 更新商品。
   *
   * 乐观锁：传了 version 就必须与当前版本一致，否则 409。
   * 不传 version 则跳过校验——**但这是有代价的**：并发编辑会静默覆盖。
   * 前端必须传（Task 11 的编辑页会带上）。
   */
  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const tenantId = this.currentTenantId();
    const product = await this.prisma.product.findFirst({ where: { id } });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }

    if (dto.version !== undefined && dto.version !== product.version) {
      throw new ConflictException('商品已被他人修改，请刷新后重试');
    }

    if (dto.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new BadRequestException('品类不存在');
      }
    }

    const nextStatus = dto.status ?? product.status;
    // 首次转为 PUBLISHED 时写入 publishedAt；再次上架保留原时间
    const publishedAt =
      nextStatus === 'PUBLISHED' && product.status !== 'PUBLISHED'
        ? new Date()
        : product.publishedAt;

    await this.prisma.product.updateMany({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.attributes !== undefined ? { attributes: dto.attributes } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(publishedAt !== product.publishedAt ? { publishedAt } : {}),
        version: { increment: 1 },
      },
    });

    return this.prisma.product.findFirst({ where: { id } }) as Promise<Product>;
  }

  /** 软删除商品 */
  async remove(id: string): Promise<void> {
    this.currentTenantId();
    const product = await this.prisma.product.findFirst({ where: { id } });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    await this.prisma.product.updateMany({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 设置商品的媒体列表（整体替换）。
   *
   * 校验两件事：
   * 1. 每个 mediaId 都属于当前租户——否则就是跨租户引用别人的文件；
   * 2. 每个 mediaId 都是 READY 状态——还没上传完的不能挂到商品上。
   *
   * 覆盖式替换：在事务里删掉不再被引用的 ProductMedia、补上新引用的、
   * 按传入顺序重排 sort。
   */
  async setMedia(
    productId: string,
    mediaIds: string[],
  ): Promise<ProductMedia[]> {
    const tenantId = this.currentTenantId();

    const product = await this.prisma.product.findFirst({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }

    if (mediaIds.length > 0) {
      const media = await this.prisma.media.findMany({
        where: { id: { in: mediaIds } },
      });
      const found = new Set(media.map((m) => m.id));
      const missing = mediaIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        // 找不到的要么不存在，要么属于别的租户——不区分，避免探测别的租户有没有这个 id
        throw new BadRequestException(
          `媒体不存在或不可用：${missing.join('、')}`,
        );
      }
      const notReady = media.filter((m) => m.status !== 'READY');
      if (notReady.length > 0) {
        throw new BadRequestException('有媒体还没上传完成，不能挂到商品上');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 删掉不再被引用的
      await tx.productMedia.deleteMany({
        where: { productId, mediaId: { notIn: mediaIds } },
      });

      // 补上新引用的（已存在的不动）
      for (const mediaId of mediaIds) {
        const existing = await tx.productMedia.findFirst({
          where: { productId, mediaId },
        });
        if (!existing) {
          await tx.productMedia.create({
            data: { tenantId, productId, mediaId },
          });
        }
      }

      // 按传入顺序重排 sort
      for (const [sort, mediaId] of mediaIds.entries()) {
        await tx.productMedia.updateMany({
          where: { productId, mediaId },
          data: { sort },
        });
      }

      return tx.productMedia.findMany({
        where: { productId },
        orderBy: { sort: 'asc' },
      });
    });
  }

  /**
   * 批量操作。
   *
   * 单事务：全部成功或全部不生效。批量删除是软删除。
   * 批量改价后重算受影响商品的 minPrice。
   */
  async batch(dto: BatchProductsDto): Promise<{ updated: number }> {
    const tenantId = this.currentTenantId();

    if (dto.action === 'SET_CATEGORY' && !dto.categoryId) {
      throw new BadRequestException('批量改分类必须指定 categoryId');
    }
    if (dto.action === 'ADJUST_PRICE') {
      if (!dto.mode || dto.value === undefined) {
        throw new BadRequestException('批量改价必须指定 mode 与 value');
      }
    }
    if (dto.action === 'SET_CATEGORY' && dto.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new BadRequestException('品类不存在');
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: dto.ids } },
      });
      const productIds = products.map((p) => p.id);

      switch (dto.action) {
        case 'PUBLISH':
        case 'UNPUBLISH': {
          const status = dto.action === 'PUBLISH' ? 'PUBLISHED' : 'UNPUBLISHED';
          await tx.product.updateMany({
            where: { id: { in: productIds } },
            data: {
              status,
              ...(status === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
              version: { increment: 1 },
            },
          });
          break;
        }
        case 'DELETE': {
          await tx.product.updateMany({
            where: { id: { in: productIds } },
            data: { deletedAt: new Date() },
          });
          break;
        }
        case 'SET_CATEGORY': {
          await tx.product.updateMany({
            where: { id: { in: productIds } },
            data: { categoryId: dto.categoryId, version: { increment: 1 } },
          });
          break;
        }
        case 'ADJUST_PRICE': {
          const mode = dto.mode as 'SET' | 'PERCENT';
          const value = dto.value as number;
          const skus = await tx.sku.findMany({
            where: { productId: { in: productIds }, status: 'ACTIVE' },
          });
          for (const sku of skus) {
            const nextPrice =
              mode === 'SET'
                ? value
                : Math.ceil(sku.price * (1 + value / 100));
            await tx.sku.updateMany({
              where: { id: sku.id },
              data: { price: nextPrice },
            });
          }
          await this.minPrice.recalculate(tx, tenantId, productIds);
          break;
        }
      }

      return { updated: productIds.length };
    });

    return result;
  }
}
```

- [ ] **Step 5: 写 ProductsController**

创建 `api/src/modules/catalog/products/products.controller.ts`：

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProductStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ProductsService } from './products.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { BatchProductsDto } from '../dto/batch-products.dto';

@ApiTags('products')
@Controller('catalog/products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: '商品列表（管理端）' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'] })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('status') status?: ProductStatus,
  ) {
    return this.productsService.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      keyword,
      categoryId,
      status,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '商品详情（管理端，含规格与 SKU）' })
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: '创建商品' })
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新商品' })
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除商品（软删除）' })
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }

  @Put(':id/media')
  @ApiOperation({ summary: '设置商品的媒体列表（整体替换，数组顺序即封面顺序）' })
  setMedia(@Param('id') id: string, @Body() dto: SetProductMediaDto) {
    return this.productsService.setMedia(id, dto.mediaIds);
  }

  @Post('batch')
  @ApiOperation({ summary: '批量操作' })
  batch(@Body() dto: BatchProductsDto) {
    return this.productsService.batch(dto);
  }
}
```

> **路由顺序**：`@Post('batch')` 必须声明在 `@Post()` 之后、但路由匹配是按注册顺序的
> ——`batch` 是 POST，而 `@Post()` 没有路径参数，两者不冲突。
> 但 `@Get(':id')` 会匹配 `/batch`（GET），所以**批量操作只能用 POST**，
> 不要改成 GET。

- [ ] **Step 6: 注册到 CatalogModule**

改 `api/src/modules/catalog/catalog.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { MinPriceService } from './pricing/min-price.service';

@Module({
  controllers: [CategoriesController, ProductsController],
  providers: [CategoriesService, ProductsService, MinPriceService],
  exports: [CategoriesService, ProductsService, MinPriceService],
})
export class CatalogModule {}
```

- [ ] **Step 7: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：全部 PASS。

- [ ] **Step 8: 类型检查与 lint**

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：0 error。`Prisma` 导入若报未使用，说明 `where` 的类型标注可以去掉。

- [ ] **Step 9: 提交**

```bash
git add api/src api/test
git commit -m "feat(api): 商品 CRUD、状态流转、乐观锁与 minPrice 维护"
```

---

## Task 5：规格矩阵

规格矩阵是本阶段最复杂的部分：商家定义「颜色 / 尺码」两个维度与各自的取值，
系统自动生成笛卡尔积的 SKU 骨架，商家填价格与编码。

**整体替换（PUT）而非增量接口**：前端提交一份完整的规格结构，后端在一个事务里
做「匹配 → 新增 → 删除」。增量接口会让前端自己算笛卡尔积再发一串请求，
中途失败会留下不一致状态。

**Files:**
- Create: `api/src/modules/catalog/specs/spec-matrix.service.ts`
- Create: `api/src/modules/catalog/dto/replace-specs.dto.ts`
- Create: `api/src/modules/catalog/dto/sku-input.dto.ts`
- Modify: `api/src/modules/catalog/products/products.controller.ts`
- Modify: `api/src/modules/catalog/products/products.service.ts`
- Modify: `api/src/modules/catalog/catalog.module.ts`
- Modify: `api/test/catalog.e2e-spec.ts`

### 5.1 先写失败测试

在 `api/test/catalog.e2e-spec.ts` 追加：

```typescript
  it('规格矩阵生成笛卡尔积的 SKU', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '圆领 T 恤', slug: `tee-${unique()}` })
      .expect(201);

    const response = await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.body.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
          { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
        ],
      })
      .expect(200);

    // 2 × 2 = 4 个 SKU
    expect(response.body.skus).toHaveLength(4);
    expect(response.body.skus.map((s: { price: number }) => s.price)).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('整体替换时保留已有 SKU 的价格', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '保留价格商品', slug: `kp-${unique()}` })
      .expect(201);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.body.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    const skuId = first.body.skus[0].id as string;

    // 直接改这个 SKU 的价格
    await http(app)
      .patch(`/api/v1/catalog/products/${product.body.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 5900 })
      .expect(200);

    // 重新提交同样的规格，价格应当被保留
    const second = await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: first.body.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    expect(second.body.skus).toHaveLength(1);
    expect(second.body.skus[0].id).toBe(skuId);
    expect(second.body.skus[0].price).toBe(5900);
  });

  it('规格减少时多余的 SKU 置为 INACTIVE', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '缩减规格商品', slug: `rs-${unique()}` })
      .expect(201);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.body.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
        ],
      })
      .expect(200);

    expect(first.body.skus).toHaveLength(2);

    const second = await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: first.body.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    expect(second.body.skus).toHaveLength(1);
  });

  it('规格数量超限被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '超限商品', slug: `ol-${unique()}` })
      .expect(201);

    // 3 个维度，超出上限 2
    await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.body.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }] },
          { name: '尺码', values: [{ value: 'M' }] },
          { name: '厚度', values: [{ value: '薄' }] },
        ],
      })
      .expect(400);
  });

  it('乐观锁：规格替换时 version 不匹配返回 409', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '并发规格商品', slug: `cs-${unique()}` })
      .expect(201);

    await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.body.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    // 用过期的 version 再提交
    await http(app)
      .put(`/api/v1/catalog/products/${product.body.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.body.version,
        specs: [{ name: '颜色', values: [{ value: '蓝色' }] }],
      })
      .expect(409);
  });
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：新增的 5 条 FAIL（404）。

- [ ] **Step 2: 写 DTO**

创建 `api/src/modules/catalog/dto/replace-specs.dto.ts`：

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 规格值的输入。
 *
 * ⚠️ **不要加 id 字段。** 规格值按 `(specId, value)` 的**文本**匹配，
 * 而不是按 id——传 id 进来只会给「把 A 商品的规格值挂到 B 商品上」开门，
 * 而文本匹配天然不会有这个问题。前端也不需要传 id。
 */
export class SpecValueInputDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: '红色' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  value!: string;
}

/** 规格维度的输入 */
export class SpecInputDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: '颜色' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @ApiProperty({ type: 'array', items: SpecValueInputDto })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SpecValueInputDto)
  values!: SpecValueInputDto[];

  @ApiPropertyOptional({ default: 0, description: '维度展示顺序' })
  @IsOptional()
  @IsInt()
  sort?: number;
}

/**
 * 规格矩阵整体替换。
 *
 * 前端提交一份完整的规格结构，后端在一个事务里匹配既有 SKU、新增缺失的、
 * 删除多余的。增量接口会让前端自己算笛卡尔积再发一串请求，
 * 中途失败会留下「值删了但 SKU 还在」这类不一致状态。
 */
export class ReplaceSpecsDto {
  @ApiProperty({
    minimum: 1,
    description: '乐观锁版本号，与当前商品版本不一致时返回 409',
  })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({
    type: 'array',
    items: SpecInputDto,
    maxItems: 2,
    description: '规格维度，最多 2 个',
  })
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => SpecInputDto)
  specs!: SpecInputDto[];
}
```

> **为什么 `ReplaceSpecsDto` 里没有 SKU 的价格与编码字段？**
>
> 规格替换只管「有哪些规格、生成哪些 SKU」。SKU 的价格、编码由**另一个接口**
> （`PATCH /catalog/products/:productId/skus/:skuId`）单独修改。理由：
>
> - 规格替换的频率低（改款式），SKU 价格与库存的频率高（天天改价）；
> - 混在一起会让「替换规格」这个低频操作意外覆盖商家刚改的价格；
> - 库存本来就不该在这里改——库存只能通过库存调整接口改（有流水审计）。
>
> 这也是设计文档 §5.4 漏掉的一条接口，实施时要一并补上。

- [ ] **Step 3: 写 SpecMatrixService**

创建 `api/src/modules/catalog/specs/spec-matrix.service.ts`：

```typescript
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';
import { ReplaceSpecsDto } from '../dto/replace-specs.dto';

/** 最多允许的规格维度数 */
export const MAX_SPEC_DIMENSIONS = 2;
/** 每个维度最多允许的规格值数 */
export const MAX_SPEC_VALUES = 20;

/**
 * 规格矩阵的整体替换。
 *
 * 一次提交完整结构，后端在一个事务里完成：
 *   1. 维度按 name 与既有维度匹配（复用 id），多余的软删
 *   2. 规格值按 (specId, value) 的**文本**匹配（复用 id），多余的软删
 *   3. 算笛卡尔积，与既有 SKU 按「规格值 id 集合」匹配
 *   4. 匹配到的保留（价格、库存、编码不动）
 *   5. 缺失的新建（价格与库存为 0）
 *   6. 多余的 SKU **一律置 INACTIVE**（不软删除，理由见步骤 6 的注释）
 *
 * 第 6 条是关键：商家调了下架一个颜色，不能把这批 SKU 的历史库存流水弄没了。
 */
@Injectable()
export class SpecMatrixService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 笛卡尔积：规格维度 × 规格值 → 规格值 id 的组合列表。
   *
   * 每个组合是「每个维度各取一个值」的 id 数组，顺序与维度顺序一致——
   * 顺序稳定才能让「按组合匹配 SKU」有确定的结果。
   */
  private cartesian(
    dims: Array<{ values: Array<{ id: string }> }>,
  ): string[][] {
    return dims.reduce<string[][]>(
      (acc, dim) =>
        acc.flatMap((prefix) => dim.values.map((v) => [...prefix, v.id])),
      [[]],
    );
  }

  /** 把一组规格值 id 排序成稳定的键，用于比较两个组合是否相同 */
  private comboKey(valueIds: string[]): string {
    return [...valueIds].sort().join(',');
  }

  async replace(productId: string, dto: ReplaceSpecsDto) {
    const tenantId = this.currentTenantId();

    const product = await this.prisma.product.findFirst({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    if (dto.version !== product.version) {
      throw new ConflictException('商品已被他人修改，请刷新后重试');
    }

    if (dto.specs.length > MAX_SPEC_DIMENSIONS) {
      throw new BadRequestException(`规格维度最多 ${MAX_SPEC_DIMENSIONS} 个`);
    }
    for (const dim of dto.specs) {
      if (dim.values.length > MAX_SPEC_VALUES) {
        throw new BadRequestException(
          `规格「${dim.name}」最多 ${MAX_SPEC_VALUES} 个值`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // ---- 1. 维度：按 name 匹配 ----
      const existingSpecs = await tx.productSpec.findMany({
        where: { productId },
      });
      const specIdByName = new Map(existingSpecs.map((s) => [s.name, s.id]));
      const keptSpecIds = new Set<string>();

      const resolvedDims: Array<{
        id: string;
        name: string;
        values: Array<{ id: string; value: string }>;
      }> = [];

      for (const [index, dim] of dto.specs.entries()) {
        const existingSpecId = specIdByName.get(dim.name);
        let specId: string;

        if (existingSpecId) {
          specId = existingSpecId;
          keptSpecIds.add(existingSpecId);
          await tx.productSpec.updateMany({
            where: { id: existingSpecId },
            data: { sort: dim.sort ?? index },
          });
        } else {
          // 显式传 tenantId：不依赖「扩展在事务客户端上也会注入」这个前提。
          // 显式传是安全的——扩展的注入逻辑是 `{ ...data, tenantId }`，
          // 会用上下文里的值覆盖，传错也传不进去。
          const created = await tx.productSpec.create({
            data: {
              tenantId,
              productId,
              name: dim.name,
              sort: dim.sort ?? index,
            },
          });
          specId = created.id;
          keptSpecIds.add(specId);
        }

        // ---- 2. 规格值：按 (specId, value) 匹配 ----
        const existingValues = await tx.productSpecValue.findMany({
          where: { specId },
        });
        const valueIdByText = new Map(existingValues.map((v) => [v.value, v.id]));
        const keptValueIds = new Set<string>();
        const resolvedValues: Array<{ id: string; value: string }> = [];

        for (const [valueIndex, valueInput] of dim.values.entries()) {
          let valueId: string;
          const existingValueId = valueIdByText.get(valueInput.value);

          if (existingValueId) {
            valueId = existingValueId;
            keptValueIds.add(existingValueId);
            await tx.productSpecValue.updateMany({
              where: { id: existingValueId },
              data: { sort: valueIndex },
            });
          } else {
            const created = await tx.productSpecValue.create({
              data: {
                tenantId,
                specId,
                value: valueInput.value,
                sort: valueIndex,
              },
            });
            valueId = created.id;
            keptValueIds.add(valueId);
          }
          resolvedValues.push({ id: valueId, value: valueInput.value });
        }

        // 本维度里不再出现的值：软删除
        await tx.productSpecValue.updateMany({
          where: { specId, id: { notIn: [...keptValueIds] } },
          data: { deletedAt: new Date() },
        });

        resolvedDims.push({ id: specId, name: dim.name, values: resolvedValues });
      }

      // 不再出现的维度：软删除（其值由外键级联处理）
      await tx.productSpec.updateMany({
        where: { productId, id: { notIn: [...keptSpecIds] } },
        data: { deletedAt: new Date() },
      });

      // ---- 3. 笛卡尔积 ----
      const combos = this.cartesian(
        resolvedDims.map((d) => ({ values: d.values })),
      );

      // ---- 4. 既有 SKU 与它们的规格值 ----
      const existingSkus = await tx.sku.findMany({
        where: { productId },
        include: { specValues: true },
      });
      const skuByCombo = new Map<string, (typeof existingSkus)[number]>();
      for (const sku of existingSkus) {
        const key = this.comboKey(sku.specValues.map((sv) => sv.valueId));
        skuByCombo.set(key, sku);
      }

      // ---- 5. 匹配到的保留，缺失的新建 ----
      const keptSkuIds = new Set<string>();
      for (const combo of combos) {
        const key = this.comboKey(combo);
        const existing = skuByCombo.get(key);

        if (existing) {
          keptSkuIds.add(existing.id);
          // 规格值关联可能需要补齐（值被重建过的情况）
          const existingValueIds = new Set(
            existing.specValues.map((sv) => sv.valueId),
          );
          for (const valueId of combo) {
            if (!existingValueIds.has(valueId)) {
              await tx.skuSpecValue.create({
            data: { tenantId, skuId: existing.id, valueId },
          });
            }
          }
          continue;
        }

        const created = await tx.sku.create({
          data: { tenantId, productId, price: 0 },
        });
        for (const valueId of combo) {
          await tx.skuSpecValue.create({
            data: { tenantId, skuId: created.id, valueId },
          });
        }
        keptSkuIds.add(created.id);
      }

      // ---- 6. 多余的 SKU 一律置 INACTIVE ----
      //
      // **不用软删除**：商家把某个规格值删掉又加回来时（先下架「蓝色」，
      // 几天后重新上架），软删的 SKU 查不到了——扩展会过滤 deletedAt——
      // 重新算规格组合时会新建一个同组合的 SKU，库里就留下两条逻辑重复的记录。
      //
      // 置 INACTIVE 没有这个问题：它只表示「这个 SKU 不再使用」，
      // 不参与 minPrice 计算，公开接口也只返回 ACTIVE 的 SKU。
      // 代价是留下一点存储，但换来了「规格反复调整不会产生垃圾数据」。
      const surplus = existingSkus.filter((s) => !keptSkuIds.has(s.id));
      if (surplus.length > 0) {
        await tx.sku.updateMany({
          where: { id: { in: surplus.map((s) => s.id) } },
          data: { status: 'INACTIVE' },
        });
      }

      // 商品版本递增
      await tx.product.updateMany({
        where: { id: productId },
        data: { version: { increment: 1 } },
      });

      return tx.product.findFirst({
        where: { id: productId },
        include: {
          skus: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { specValues: true },
          },
          specs: {
            where: { deletedAt: null },
            orderBy: { sort: 'asc' },
            include: { values: { where: { deletedAt: null }, orderBy: { sort: 'asc' } } },
          },
        },
      });
    });
  }
}
```

> **⚠️ `tx` 的类型**：`this.prisma.$transaction(async (tx) => ...)` 的回调参数类型
> 由 Prisma 自动推导，无需手写标注。上面代码里没有标注 `tx` 的类型，
> 是因为 `TenantPrismaService.$transaction` 已经 `.bind(this.client)`，
> 泛型推断会走 Prisma 的 `Omit<...>` 事务客户端类型。
>
> **但 `$transaction` 的返回类型**：`tx.product.findFirst(...)` 返回
> `PrismaPromise`，在事务回调里会被 await。事务回调返回它是可以的
> （Prisma 会 await 事务内的所有 promise），但为了类型清晰，
> 显式 `await` 一下更好：
>
> ```typescript
>       const result = await tx.product.findFirst({
>         where: { id: productId },
>         include: { /* ... */ },
>       });
>       return result;
> ```

> **⚠️ `tx.productSpec.create` 的 data 缺 tenantId**：扩展会注入，但**事务里的
> `tx` 走的是同一个扩展**（Prisma 的交互式事务会带上 client 扩展）。
> 阶段 1 的 `assertTenantScopedModelsRegistered` 已确保所有模型都登记了。
> 若发现事务里没注入 tenantId，说明扩展在事务客户端上没生效，
> 必须在 `create` 里显式传 `tenantId`。**实施时要验证这一点**——
> 加一条 e2e：事务里建的 SKU 的 tenantId 正确。

- [ ] **Step 4: 加 SKU 单项更新接口**

在 `api/src/modules/catalog/products/products.service.ts` 里追加：

```typescript
  /**
   * 更新单个 SKU 的价格、划线价、编码与启用状态。
   *
   * 单独一个接口而不是并进规格替换：改价是高频操作，替换规格是低频操作，
   * 混在一起会让「替换规格」意外覆盖商家刚改的价格。
   *
   * 价格改完要重算商品的 minPrice——两者在同一事务里。
   */
  async updateSku(
    productId: string,
    skuId: string,
    dto: UpdateSkuDto,
  ): Promise<Sku> {
    const tenantId = this.currentTenantId();

    const sku = await this.prisma.sku.findFirst({
      where: { id: skuId, productId },
    });
    if (!sku) {
      throw new NotFoundException('SKU 不存在');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sku.updateMany({
        where: { id: skuId },
        data: {
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.comparePrice !== undefined
            ? { comparePrice: dto.comparePrice }
            : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      await this.minPrice.recalculate(tx, tenantId, [productId]);
    });

    return this.prisma.sku.findFirst({ where: { id: skuId } }) as Promise<Sku>;
  }
```

新建 `api/src/modules/catalog/dto/update-sku.dto.ts`：

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { SkuStatus } from '@prisma/client';

/**
 * SKU 更新（价格、划线价、编码、启用状态）。
 *
 * 不含 stock：库存只能通过库存调整接口改，理由见设计文档 §四.8。
 */
export class UpdateSkuDto {
  @ApiPropertyOptional({ minimum: 0, description: '售价，单位：分' })
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ minimum: 0, description: '划线价，单位：分' })
  @IsOptional()
  @IsInt()
  @Min(0)
  comparePrice?: number;

  @ApiPropertyOptional({ maxLength: 64, description: '商家编码' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'INACTIVE'],
    description: 'INACTIVE 的 SKU 不参与 minPrice 计算，前台不可见',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: SkuStatus;
}
```

在 `api/src/modules/catalog/products/products.controller.ts` 里追加路由：

```typescript
  @Patch(':productId/skus/:skuId')
  @ApiOperation({ summary: '更新单个 SKU' })
  updateSku(
    @Param('productId') productId: string,
    @Param('skuId') skuId: string,
    @Body() dto: UpdateSkuDto,
  ) {
    return this.productsService.updateSku(productId, skuId, dto);
  }

  @Put(':productId/specs')
  @ApiOperation({ summary: '整体替换规格矩阵' })
  replaceSpecs(
    @Param('productId') productId: string,
    @Body() dto: ReplaceSpecsDto,
  ) {
    return this.specMatrix.replace(productId, dto);
  }
```

controller 的构造函数要加 `SpecMatrixService`：

```typescript
  constructor(
    private readonly productsService: ProductsService,
    private readonly specMatrix: SpecMatrixService,
  ) {}
```

`CatalogModule` 的 providers 加上 `SpecMatrixService`。

- [ ] **Step 5: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog.e2e-spec.ts
```

预期：全部 PASS。若「保留已有 SKU 的价格」失败，检查 SKU 单项更新接口是否生效。

- [ ] **Step 6: 类型检查与 lint**

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：0 error。

- [ ] **Step 7: 提交**

```bash
git add api/src api/test
git commit -m "feat(api): 规格矩阵整体替换与 SKU 单项更新"
```

---

## Task 6：媒体上传（MinIO 直传）

商家上传图片走 presigned URL 直传：后端只签发凭证并登记记录，文件字节由浏览器
直接发给 MinIO。后端不中转文件，因此不占后端带宽。

**Files:**
- Modify: `api/package.json`
- Create: `api/src/modules/media/media.module.ts`
- Create: `api/src/modules/media/storage/minio.service.ts`
- Create: `api/src/modules/media/media.service.ts`
- Create: `api/src/modules/media/media.controller.ts`
- Create: `api/src/modules/media/dto/upload-url.dto.ts`
- Modify: `api/src/app.module.ts`
- Modify: `api/.env.example`
- Create: `api/test/media.e2e-spec.ts`

### 6.1 装依赖

```bash
cd api && npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

预期：`added N packages`。

- [ ] **Step 1.5: 确保 bucket 存在**

MinIO 不会自动建 bucket。镜像里没有 `mc` 可用，用 `@aws-sdk/client-s3`
（本步开头刚装好的依赖）建：

```bash
cd api && node -e "
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const c = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:19000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ecommerce', secretAccessKey: 'ecommerce-minio-secret' },
  forcePathStyle: true,
});
(async () => {
  const Bucket = 'ecommerce-media';
  try {
    await c.send(new HeadBucketCommand({ Bucket }));
    console.log('bucket 已存在');
    return;
  } catch (error) {
    // 只在「确实不存在」时创建。裸 catch 会把凭据错误、endpoint 写错、
    // 网络不通一并吞掉，然后 CreateBucket 再失败一次，最终抛出一个
    // 误导性的 AccessDenied——排查时会被带偏很远。
    const status = error?.$metadata?.httpStatusCode;
    const name = error?.name;
    if (status !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') {
      throw error;
    }
  }
  await c.send(new CreateBucketCommand({ Bucket }));
  console.log('bucket 已创建');
})();
"
```

预期输出：`bucket 已创建` 或 `bucket 已存在`。

> 凭据或 endpoint 配错时，这段脚本会**原样抛出** `AccessDenied` 之类的错误，
> 而不是伪装成「bucket 不存在」——排查方向才对。

> bucket 是**私有**的（不设匿名读）。媒体通过后端签发的 presigned URL 访问，
> 不靠公开读——商品图本来也不该无条件公开。

- [ ] **Step 2: 确认配置已就位**

MinIO 的环境变量在 **Task 1 Step 2** 已经写进 `api/.env.example` 与
`infra/.env.example` 了，本步不重复写。这里只确认两件事：

```bash
cd api && grep MINIO .env.example
```

预期能看到 `MINIO_ENDPOINT`、`MINIO_INTERNAL_ENDPOINT`、`MINIO_PUBLIC_URL`、
`MINIO_BUCKET`、`MINIO_REGION`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、
`MEDIA_MAX_SIZE` 八项。

> **三个 endpoint 各管各的，别混用**：
>
> | 变量 | 用途 | 本机开发 | 容器内 |
> |------|------|---------|--------|
> | `MINIO_ENDPOINT` | 签发 presigned URL（host 会进签名） | `http://localhost:19000` | **仍是** `http://localhost:19000`——浏览器不在容器里 |
> | `MINIO_INTERNAL_ENDPOINT` | 后端自己 HEAD / 删除 | `http://localhost:19000` | `http://minio:9000` |
> | `MINIO_PUBLIC_URL` | 拼媒体访问地址（存进 `media.url`） | `http://localhost:19000` | 生产环境应是 CDN 或 Nginx 暴露的域名 |
>
> **为什么签发与内部访问要分开**：presigned URL 的签名绑定了 host。
> 后端若用容器内的 `http://minio:9000` 签发，浏览器拿到的 URL 里是
> `minio:9000` 这个主机名——浏览器解析不了，上传必然失败。
>
> **为什么媒体地址要单独一个**：生产部署时媒体通常走 CDN 或 Nginx 域名，
> 与 MinIO 的接入地址不是同一个。分开才能换。

- [ ] **Step 3: 写 MinioService**

创建 `api/src/modules/media/storage/minio.service.ts`：

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MAX_PRESIGN_TTL_SECONDS = 15 * 60;

/**
 * MinIO 封装。
 *
 * 两个 client，区别只在 endpoint：
 * - `publicClient`：签发 presigned URL。endpoint 是**浏览器可达**的地址，
 *   因为签名绑定了 host，用容器内地址签出来的 URL 浏览器解析不了主机名。
 * - `internalClient`：后端自己用（HEAD 确认、删除孤儿）。用容器内地址更快。
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private publicClient!: S3Client;
  private internalClient!: S3Client;
  private bucket!: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'ecommerce-media';
  }

  onModuleInit(): void {
    const region = process.env.MINIO_REGION ?? 'us-east-1';
    const credentials = {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'ecommerce',
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'ecommerce-minio-secret',
    };

    this.publicClient = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:19000',
      region,
      credentials,
      forcePathStyle: true,
    });

    this.internalClient = new S3Client({
      endpoint:
        process.env.MINIO_INTERNAL_ENDPOINT ?? 'http://localhost:19000',
      region,
      credentials,
      forcePathStyle: true,
    });
  }

  /** 签发上传用的 presigned PUT URL */
  async createUploadUrl(key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn: MAX_PRESIGN_TTL_SECONDS,
    });
  }

  /** 确认对象存在，返回它的字节数；不存在返回 null */
  async statObject(key: string): Promise<number | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return head.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  /** 删除对象（清理孤儿用） */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.internalClient.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // 对象不存在时静默忽略——清理任务要能重复执行
    }
  }

  getBucketName(): string {
    return this.bucket;
  }
}
```

> **缺一个 import**：`PutObjectCommand` 也要从 `@aws-sdk/client-s3` 导入。
> 修正后的 import 段：
>
> ```typescript
> import {
>   DeleteObjectCommand,
>   HeadObjectCommand,
>   PutObjectCommand,
>   S3Client,
> } from '@aws-sdk/client-s3';
> ```

- [ ] **Step 4: 写 DTO 与 MediaService**

创建 `api/src/modules/media/dto/upload-url.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/** 允许的图片类型 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export class UploadUrlDto {
  @ApiProperty({ maxLength: 200, example: 'tee-front.jpg' })
  @IsString()
  @MaxLength(200)
  filename!: string;

  @ApiProperty({
    enum: ALLOWED_MIME_TYPES,
    example: 'image/jpeg',
    description: '图片类型，只接受白名单里的四种',
  })
  @IsString()
  mime!: string;

  // ⚠️ 这里**不写** @Max(上限)：上限由 MEDIA_MAX_SIZE 环境变量决定，
  // 而 class-validator 的装饰器在模块 import 时求值，那时 @nestjs/config
  // 还没加载 .env——写死一个数字就会与 service 里的判断形成两个真相源
  // （改环境变量不生效，或两边不一致）。
  // 上限的判定统一放在 MediaService 里，DTO 只管「是正整数」。
  @ApiProperty({
    minimum: 1,
    example: 204800,
    description: '文件字节数，上限由服务端的 MEDIA_MAX_SIZE 决定（默认 5MB）',
  })
  @IsInt()
  @Min(1)
  size!: number;
}
```

创建 `api/src/modules/media/media.service.ts`：

```typescript
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Media } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { MinioService } from './storage/minio.service';
import { ALLOWED_MIME_TYPES, UploadUrlDto } from './dto/upload-url.dto';

/** 超过这个时间仍是 PENDING 的记录视为孤儿 */
export const ORPHAN_AFTER_HOURS = 24;

@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly minio: MinioService,
  ) {}

  /**
   * 启动孤儿清理定时器。
   *
   * 阶段 1 没有引入 @nestjs/schedule，用原生 setInterval 就够——
   * 这类低频后台任务不值得为它加一个依赖。
   *
   * ⚠️ **必须 unref()**：不 unref 的定时器会让 Node 进程一直不退出，
   * e2e 测试跑完后 jest 会挂住。
   */
  onModuleInit(): void {
    const intervalMs = Number(
      process.env.MEDIA_CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000,
    );
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOrphans().catch((error: unknown) => {
        console.error('媒体孤儿清理失败', error);
      });
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /** 取文件扩展名：优先用 mime 推断，不信任客户端传的原始文件名 */
  private extensionOf(mime: string): string {
    switch (mime) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'image/gif':
        return 'gif';
      default:
        return 'bin';
    }
  }

  /**
   * 签发上传凭证。
   *
   * object key 带 tenantId 前缀：即使 bucket 权限配错，也能靠前缀做隔离，
   * 且清某个租户的文件时能按前缀批量处理。
   */
  async createUploadUrl(
    dto: UploadUrlDto,
    operatorId: string,
  ): Promise<{ media: Media; uploadUrl: string }> {
    const tenantId = this.currentTenantId();

    if (!ALLOWED_MIME_TYPES.includes(dto.mime as never)) {
      throw new BadRequestException(
        `不支持的图片类型：${dto.mime}。只支持 ${ALLOWED_MIME_TYPES.join('、')}`,
      );
    }

    const maxSize = Number(process.env.MEDIA_MAX_SIZE ?? 5242880);
    if (dto.size > maxSize) {
      throw new BadRequestException(
        `文件超过 ${Math.floor(maxSize / 1024 / 1024)}MB 上限`,
      );
    }

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const key = `${tenantId}/${yyyy}/${mm}/${randomBytes(12).toString('hex')}.${this.extensionOf(dto.mime)}`;

    // 媒体访问地址用 MINIO_PUBLIC_URL 而不是 MINIO_ENDPOINT：
    // 生产部署时媒体通常走 CDN 或 Nginx 暴露的域名，与 MinIO 接入地址不同。
    // 两者分开才能换。
    const publicBase =
      process.env.MINIO_PUBLIC_URL ??
      process.env.MINIO_ENDPOINT ??
      'http://localhost:19000';

    const media = await this.prisma.media.create({
      data: {
        key,
        url: `${publicBase}/${this.minio.getBucketName()}/${key}`,
        mime: dto.mime,
        size: dto.size,
        status: 'PENDING',
        uploadedBy: operatorId,
      },
    });

    const uploadUrl = await this.minio.createUploadUrl(key, dto.mime);
    return { media, uploadUrl };
  }

  /**
   * 确认上传完成。
   *
   * 后端 HEAD 对象核对存在与大小——只信客户端说「我传完了」是不够的，
   * 客户端可能根本没传，或者传了个空文件。
   */
  async confirm(id: string): Promise<Media> {
    this.currentTenantId();
    const media = await this.prisma.media.findFirst({ where: { id } });
    if (!media) {
      throw new NotFoundException('媒体不存在');
    }

    const actualSize = await this.minio.statObject(media.key);
    if (actualSize === null) {
      throw new BadRequestException('文件尚未上传或已被删除');
    }

    await this.prisma.media.updateMany({
      where: { id },
      data: { status: 'READY', size: actualSize },
    });

    return this.prisma.media.findFirst({ where: { id } }) as Promise<Media>;
  }

  async list(page: number, pageSize: number) {
    this.currentTenantId();
    const [items, total] = await Promise.all([
      this.prisma.media.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.media.count(),
    ]);
    return { items, total, page, pageSize };
  }

  /** 软删除媒体 */
  async remove(id: string): Promise<void> {
    this.currentTenantId();
    const media = await this.prisma.media.findFirst({ where: { id } });
    if (!media) {
      throw new NotFoundException('媒体不存在');
    }
    await this.prisma.media.updateMany({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 清理孤儿：PENDING 超过 24 小时的记录标为 ORPHANED。
   *
   * 为什么需要：presigned URL 签发后商家可能直接关页面，
   * 数据库里就留下一条永远指向不存在文件的记录。
   *
   * 逐条处理而不是一条 SQL 批量改：每条都要先 HEAD 一次确认对象确实不存在
   * （商家可能上传了但没来得及 confirm），存在的话不该标记为孤儿。
   *
   * ⚠️ **必须切到 platform scope**：这是平台级任务，要扫所有租户的记录。
   * 若沿用当前请求的租户上下文，扩展会自动附加 tenantId 条件，
   * 结果只能清理自己租户的媒体。
   *
   * platform scope 下 updateMany 不附加任何租户条件——所以 where 里必须
   * 有精确的 `id` 过滤（下面每条都是按 id 更新的，不会误伤）。
   */
  async cleanupOrphans(): Promise<{ marked: number }> {
    const threshold = new Date(
      Date.now() - ORPHAN_AFTER_HOURS * 3600 * 1000,
    );

    return tenantContext.run(platformScope(), async () => {
      const stale = await this.prisma.media.findMany({
        where: { status: 'PENDING', createdAt: { lt: threshold } },
      });

      let marked = 0;
      for (const media of stale) {
        const exists = await this.minio.statObject(media.key);
        if (exists !== null) {
          // 文件其实传上去了，只是没 confirm——补上确认而不是标孤儿
          await this.prisma.media.updateMany({
            where: { id: media.id },
            data: { status: 'READY', size: exists },
          });
          continue;
        }
        await this.prisma.media.updateMany({
          where: { id: media.id },
          data: { status: 'ORPHANED' },
        });
        await this.minio.deleteObject(media.key);
        marked += 1;
      }

      return { marked };
    });
  }
}
```


- [ ] **Step 5: 写 MediaController**

创建 `api/src/modules/media/media.controller.ts`：

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from './media.service';
import { UploadUrlDto } from './dto/upload-url.dto';

@ApiTags('media')
@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload-url')
  @ApiOperation({ summary: '签发上传凭证（presigned URL）' })
  createUploadUrl(
    @Body() dto: UploadUrlDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.mediaService.createUploadUrl(dto, user.userId);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: '确认上传完成' })
  confirm(@Param('id') id: string) {
    return this.mediaService.confirm(id);
  }

  @Get()
  @ApiOperation({ summary: '媒体列表' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.mediaService.list(
      page ? Number(page) : 1,
      Math.min(100, pageSize ? Number(pageSize) : 20),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除媒体（软删除）' })
  remove(@Param('id') id: string) {
    return this.mediaService.remove(id);
  }
}
```

> **`@CurrentUser()` 装饰器的形状**：先读
> `api/src/common/decorators/current-user.decorator.ts` 确认它返回什么——
> 阶段 1 可能返回整个 user 对象，也可能只返回某个字段。
> 按实际形状调整 `user.userId` 的写法。

- [ ] **Step 6: 写 MediaModule 并注册**

创建 `api/src/modules/media/media.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MinioService } from './storage/minio.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, MinioService],
  exports: [MediaService],
})
export class MediaModule {}
```

改 `api/src/app.module.ts`，在 `imports` 里加 `MediaModule`。

- [ ] **Step 7: 写 e2e**

创建 `api/test/media.e2e-spec.ts`。建应用的方式与 `catalog.e2e-spec.ts` 同构——
同样要有 `let prisma: TenantPrismaService` 与 `prisma = app.get(TenantPrismaService)`，
因为下面的用例要用 `prisma` 造数据。`createMerchant` 与 `unique` 从
`api/test/merchant-fixture.ts` import（Task 3 已经建好那个文件）。

核心用例：

```typescript
  it('签发上传凭证：返回 mediaId 与 presigned URL', async () => {
    const merchant = await createMerchant(app, prisma);

    const response = await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.jpg', mime: 'image/jpeg', size: 1024 })
      .expect(201);

    expect(response.body.media.id).toBeTruthy();
    expect(response.body.uploadUrl).toContain('X-Amz-Signature');
    expect(response.body.media.status).toBe('PENDING');
  });

  it('拒绝非白名单的图片类型', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.exe', mime: 'application/x-msdownload', size: 1024 })
      .expect(400);
  });

  it('拒绝超过大小上限的文件', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.jpg', mime: 'image/jpeg', size: 99999999 })
      .expect(400);
  });

  it('确认一个没上传的文件会被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.jpg', mime: 'image/jpeg', size: 1024 })
      .expect(201);

    await http(app)
      .post(`/api/v1/media/${created.body.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(400);
  });

  it('真实上传后确认成功，状态变 READY', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/media/upload-url')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ filename: 'a.jpg', mime: 'image/jpeg', size: 1024 })
      .expect(201);

    // 用后端自己的 fetch 直传（模拟浏览器 PUT）
    const bytes = Buffer.alloc(1024, 7);
    const put = await fetch(created.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);

    const confirmed = await http(app)
      .post(`/api/v1/media/${created.body.media.id}/confirm`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(201);

    expect(confirmed.body.status).toBe('READY');
    expect(confirmed.body.size).toBe(1024);
  });
```

> **`expect(put.ok).toBe(true)` 这一步依赖 Task 1 验证过的 CORS 与 MinIO 可达性。**
> 若失败，先确认 MinIO 容器在跑、bucket 存在、presigned URL 的 host 是
> `localhost:19000`（不是 `minio:9000`）。

- [ ] **Step 8: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/media.e2e-spec.ts
```

预期：全部 PASS。

- [ ] **Step 9: 提交**

```bash
git add api/src api/test api/package.json api/package-lock.json api/.env.example
git commit -m "feat(api): 媒体上传（MinIO presigned 直传、确认与孤儿清理）"
```

---

## Task 7：库存流水

本阶段只做手动出入库与盘点，但流水表从一开始就是 append-only 的审计台账，
且 `RESERVE` / `RELEASE` / `DEDUCT` 三种类型已在枚举里留位给计划 3。

**Files:**
- Create: `api/src/modules/inventory/inventory.module.ts`
- Create: `api/src/modules/inventory/inventory.service.ts`
- Create: `api/src/modules/inventory/inventory.controller.ts`
- Create: `api/src/modules/inventory/dto/adjust-stock.dto.ts`
- Modify: `api/src/app.module.ts`
- Create: `api/test/inventory.e2e-spec.ts`

### 7.1 先写失败测试

创建 `api/test/inventory.e2e-spec.ts`。建应用的方式与 `catalog.e2e-spec.ts` 同构，
`createMerchant` 与 `unique` 直接从 `api/test/merchant-fixture.ts` import
（Task 3 已经建好那个文件，不用重复定义）：

```typescript
import { createMerchant, unique } from './merchant-fixture';
```

`api/test/inventory.e2e-spec.ts` 的用例：

```typescript
  it('入库：库存增加并产生一条流水', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    const response = await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: 20, reason: '采购到货' })
      .expect(201);

    expect(response.body.sku.stock).toBe(20);
    expect(response.body.movement.stockBefore).toBe(0);
    expect(response.body.movement.stockAfter).toBe(20);
    expect(response.body.movement.quantity).toBe(20);
  });

  it('出库超过库存被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 5);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_OUT', quantity: 10 })
      .expect(400);
  });

  it('盘点：传绝对值，流水里记成差量', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 10);

    const response = await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'CHECK', quantity: 8 })
      .expect(201);

    expect(response.body.sku.stock).toBe(8);
    expect(response.body.movement.quantity).toBe(-2);
  });

  it('流水是只追加的：查得到历史记录', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: 10 })
      .expect(201);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_OUT', quantity: 3 })
      .expect(201);

    const list = await http(app)
      .get(`/api/v1/inventory/movements?skuId=${sku.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    expect(list.body.items).toHaveLength(2);
  });

  it('跨租户不可见：改不了别人的 SKU 库存', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const sku = await createSku(a.token, 10);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${b.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_OUT', quantity: 1 })
      .expect(404);
  });
```

> **`createSku` 辅助**：造一个带价格与库存的 SKU。
>
> ```typescript
>   /** 造一个 SKU，返回 { id, price, stock } */
>   async function createSku(
>     token: string,
>     stock: number,
>   ): Promise<{ id: string; price: number; stock: number }> {
>     const product = await http(app)
>       .post('/api/v1/catalog/products')
>       .set('authorization', `Bearer ${token}`)
>       .send({ name: '库存测试商品', slug: `inv-${unique()}` })
>       .expect(201);
>
>     const specs = await http(app)
>       .put(`/api/v1/catalog/products/${product.body.id}/specs`)
>       .set('authorization', `Bearer ${token}`)
>       .send({
>         version: product.body.version,
>         specs: [{ name: '规格', values: [{ value: '默认' }] }],
>       })
>       .expect(200);
>
>     const sku = specs.body.skus[0];
>     await http(app)
>       .patch(`/api/v1/catalog/products/${product.body.id}/skus/${sku.id}`)
>       .set('authorization', `Bearer ${token}`)
>       .send({ price: 1000 })
>       .expect(200);
>
>     // 库存只能通过库存调整接口改，这里直接造初始库存。
>     //
>     // ⚠️ 必须包在 tenantContext.run 里：Sku 是租户作用域模型，
>     // 扩展在没有租户上下文时直接抛 TenantScopeError（fail-closed），
>     // 裸调 prisma.sku.updateMany 会当场炸掉。
>     await tenantContext.run(
>       { tenantId: merchant.tenantId, userId: null, role: null },
>       async () =>
>         prisma.sku.updateMany({
>           where: { id: sku.id },
>           data: { stock },
>         }),
>     );
>
>     return { id: sku.id as string, price: 1000, stock };
>   }
> ```
>
> **补上 import**（文件头部）：
>
> ```typescript
> import { tenantContext } from '../src/common/tenant/tenant-context';
> ```

- [ ] **Step 7.2: 跑测试确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/inventory.e2e-spec.ts
```

预期：FAIL，404。

- [ ] **Step 3: 写 DTO**

创建 `api/src/modules/inventory/dto/adjust-stock.dto.ts`：

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * 本阶段支持的手动调整类型。
 *
 * RESERVE / RELEASE / DEDUCT 是计划 3（交易链路）用的，
 * 枚举里有位但本阶段不开放——它们的语义涉及「占用可用量」，
 * 与实际库存不是一回事。
 */
export const MANUAL_ADJUSTMENT_TYPES = [
  'ADJUST_IN',
  'ADJUST_OUT',
  'CHECK',
] as const;

export class AdjustStockDto {
  @ApiProperty({ description: 'SKU id' })
  @IsString()
  skuId!: string;

  @ApiProperty({
    enum: MANUAL_ADJUSTMENT_TYPES,
    description:
      'ADJUST_IN 入库（quantity 为增加量）；ADJUST_OUT 出库（quantity 为减少量）；CHECK 盘点（quantity 为盘点后的实际值）',
  })
  @IsIn(MANUAL_ADJUSTMENT_TYPES)
  type!: 'ADJUST_IN' | 'ADJUST_OUT' | 'CHECK';

  @ApiProperty({
    minimum: 0,
    description:
      '入库 / 出库填数量；盘点填盘点后的实际库存值。单位与库存一致（件）',
  })
  @IsInt()
  @Min(0)
  quantity!: number;

  @ApiPropertyOptional({ maxLength: 200, description: '调整原因' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
```

- [ ] **Step 4: 写 InventoryService**

创建 `api/src/modules/inventory/inventory.service.ts`：

```typescript
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovement, Sku } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 库存调整。
   *
   * 在一个事务里完成「改库存 + 记流水」，两者必须同生共死——
   * 只改库存不记流水会让台账与实际对不上，只记流水不改库存会让台账骗人。
   *
   * 流水的 quantity 是**带符号的增量**：
   * - ADJUST_IN  → +quantity
   * - ADJUST_OUT → -quantity
   * - CHECK      → 传入的是盘点后的实际值，增量 = 实际值 - 原值
   */
  async adjust(
    dto: AdjustStockDto,
    operatorId: string,
  ): Promise<{ sku: Sku; movement: InventoryMovement }> {
    this.currentTenantId();

    return this.prisma.$transaction(async (tx) => {
      const sku = await tx.sku.findFirst({ where: { id: dto.skuId } });
      if (!sku) {
        throw new NotFoundException('SKU 不存在');
      }

      const stockBefore = sku.stock;
      let stockAfter: number;
      let delta: number;

      // 用 if-else 而不是 switch：switch 里每个 case 都要 break，
      // 而 TS 的「使用前赋值」检查在 switch 外会报 stockAfter 可能未赋值
      // （控制流分析看不穿 switch 的分支穷尽性）。if-else 链没有这个问题。
      if (dto.type === 'ADJUST_IN') {
        delta = dto.quantity;
        stockAfter = stockBefore + delta;
      } else if (dto.type === 'ADJUST_OUT') {
        if (dto.quantity > stockBefore) {
          throw new BadRequestException(
            `库存不足：当前 ${stockBefore}，要出库 ${dto.quantity}`,
          );
        }
        delta = -dto.quantity;
        stockAfter = stockBefore + delta;
      } else {
        // CHECK：传的是盘点后的绝对值，流水里记成差量
        stockAfter = dto.quantity;
        delta = stockAfter - stockBefore;
      }

      await tx.sku.updateMany({
        where: { id: sku.id },
        data: { stock: stockAfter },
      });

      const movement = await tx.inventoryMovement.create({
        data: {
          skuId: sku.id,
          type: dto.type,
          quantity: delta,
          stockBefore,
          stockAfter,
          ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
          operatorId,
        },
      });

      const updated = await tx.sku.findFirst({ where: { id: sku.id } });
      return { sku: updated as Sku, movement };
    });
  }

  /** 流水列表。流水表是 append-only 的，没有修改与删除接口。 */
  async movements(query: {
    skuId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: InventoryMovement[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    this.currentTenantId();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

    const where = query.skuId ? { skuId: query.skuId } : {};

    const [items, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** 库存汇总：按商品列出各 SKU 的当前库存 */
  async summary(productId: string): Promise<
    Array<{ skuId: string; code: string | null; stock: number; status: string }>
  > {
    this.currentTenantId();
    const skus = await this.prisma.sku.findMany({
      where: { productId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, stock: true, status: true },
    });
    return skus.map((s) => ({
      skuId: s.id,
      code: s.code,
      stock: s.stock,
      status: s.status,
    }));
  }
}
```


> ### ⚠️ 本 Task 实施后的修正
>
> **① 库存调整要加乐观锁（已补）。**
> 说明里的 `findFirst` 读库存 → 算 delta → `updateMany` 写，在并发下会
> **丢失更新**：两个并发的入库各读到 `stock=10`、各自算出 `stockAfter=20`，
> 后写的覆盖先写的——入库两笔却只进一笔，而且流水里会记两条，账实对不上。
> 事务只保证「改库存 + 记流水」的原子性，**不保证读-改-写的隔离**。
>
> 修法与 `Product.version` 同一个模式：`Sku` 加 `stockVersion`，
> 把它放进 `updateMany` 的 `where`，受影响行数为 0 就抛 409。
> 手动调整是低频操作，让调用方重试即可；计划 3 的订单扣减是高频，
> 那时要在同一模式上加事务内重试。
>
> **② `prisma migrate diff` 会误删手写索引（已补）。**
> 用 diff 生成迁移时，`products_name_trgm` 这个手写的 GIN 索引被当成漂移，
> diff 输出了 `DROP INDEX "products_name_trgm"` ——删了商品搜索会退化成全表扫描。
> 用 diff 兜底 drift 时**必须逐条检查生成物**，把误删的索引紧接着建回来。

- [ ] **Step 5: 写 InventoryController 与 Module**

创建 `api/src/modules/inventory/inventory.controller.ts`：

```typescript
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InventoryService } from './inventory.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@ApiTags('inventory')
@Controller('inventory')
@UseGuards(JwtAuthGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('adjustments')
  @ApiOperation({ summary: '库存调整（入库 / 出库 / 盘点）' })
  adjust(
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.inventoryService.adjust(dto, user.userId);
  }

  @Get('movements')
  @ApiOperation({ summary: '库存流水列表' })
  @ApiQuery({ name: 'skuId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  movements(
    @Query('skuId') skuId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.inventoryService.movements({
      skuId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('summary')
  @ApiOperation({ summary: '库存汇总' })
  @ApiQuery({ name: 'productId', required: true, type: String })
  summary(@Query('productId') productId: string) {
    return this.inventoryService.summary(productId);
  }
}
```

创建 `api/src/modules/inventory/inventory.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
```

改 `api/src/app.module.ts` 加 `InventoryModule`。

- [ ] **Step 6: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/inventory.e2e-spec.ts
```

预期：全部 PASS。

- [ ] **Step 7: 类型检查与 lint**

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：0 error。

- [ ] **Step 8: 提交**

```bash
git add api/src api/test
git commit -m "feat(api): 库存调整与 append-only 流水台账"
```

---

## Task 8：公开读与搜索

面向消费者的只读接口：品类树、商品列表（含搜索与筛选）、商品详情。

**公开路径的租户来源**：请求不带 JWT 时，租户上下文拦截器从
`X-Tenant-Subdomain` 头或 Host 头解析。公开接口挂 `@Public()`——
它只放行身份认证，**拦截器照常运行**，因此公开查询仍然经过 Prisma 扩展的
`where.tenantId` 合并。

**Files:**
- Create: `api/src/modules/catalog/public/public-catalog.controller.ts`
- Create: `api/src/modules/catalog/public/public-catalog.service.ts`
- Create: `api/test/catalog-public.e2e-spec.ts`
- Modify: `api/src/modules/catalog/catalog.module.ts`

### 8.1 先写失败测试

创建 `api/test/catalog-public.e2e-spec.ts`：

```typescript
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';
import { tenantContext } from '../src/common/tenant/tenant-context';

describe('公开商品读取 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
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

    prisma = app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 造一个已上架的商品。
   *
   * 返回 version 是必要的：规格替换要带乐观锁版本号，
   * 而 version 的具体值取决于上架那次 PATCH 有没有让版本递增——
   * 写死一个数字（哪怕是 2）会让这个用例在 publishProduct 的实现一变就失效。
   */
  async function publishProduct(
    token: string,
    name: string,
  ): Promise<{ id: string; name: string; slug: string; version: number }> {
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send({ name, slug: `p-${unique()}` })
      .expect(201);

    const published = await http(app)
      .patch(`/api/v1/catalog/products/${created.body.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    return {
      id: created.body.id as string,
      name,
      slug: created.body.slug as string,
      version: published.body.version as number,
    };
  }

  it('匿名按子域名能读到已上架商品', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '公开商品甲');

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].name).toBe('公开商品甲');
  });

  it('响应里不包含 tenantId 等内部字段', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '字段裁剪商品');

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.body.items[0].tenantId).toBeUndefined();
    expect(response.body.items[0].version).toBeUndefined();
    expect(response.body.items[0].deletedAt).toBeUndefined();
  });

  it('草稿商品不出现在公开列表里', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '已上架商品');

    // 造一个草稿
    await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '草稿商品', slug: `d-${unique()}` })
      .expect(201);

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const names = (response.body.items as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(names).toContain('已上架商品');
    expect(names).not.toContain('草稿商品');
  });

  it('跨租户不可见：B 的公开列表里没有 A 的商品', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    await publishProduct(a.token, 'A 的公开商品');

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', b.subdomain)
      .expect(200);

    expect(response.body.items).toHaveLength(0);
  });

  it('不带子域名的请求返回 404', async () => {
    await http(app).get('/api/v1/public/products').expect(404);
  });

  it('关键词搜索命中商品', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '纯棉圆领T恤');

    const response = await http(app)
      .get('/api/v1/public/products?keyword=纯棉')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].name).toBe('纯棉圆领T恤');
  });

  it('商品详情返回规格与 SKU', async () => {
    const merchant = await createMerchant(app, prisma);
    const product = await publishProduct(merchant.token, '详情商品');

    await http(app)
      .put(`/api/v1/catalog/products/${product.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] }],
      })
      .expect(200);

    const response = await http(app)
      .get(`/api/v1/public/products/${product.slug}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.body.name).toBe('详情商品');
    expect(response.body.skus).toHaveLength(2);
    expect(response.body.specs).toHaveLength(1);
    expect(response.body.tenantId).toBeUndefined();
  });

  it('草稿商品的详情对外不可见', async () => {
    const merchant = await createMerchant(app, prisma);
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '草稿详情', slug: `dd-${unique()}` })
      .expect(201);

    await http(app)
      .get(`/api/v1/public/products/${created.body.slug}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(404);
  });
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog-public.e2e-spec.ts
```

预期：FAIL，404。

- [ ] **Step 2: 写 PublicCatalogService**

创建 `api/src/modules/catalog/public/public-catalog.service.ts`：

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';

/** 公开列表的每页条数上限 */
export const MAX_PUBLIC_PAGE_SIZE = 100;

/**
 * 公开商品读取。
 *
 * ⚠️ 本 service 里的每个方法都只能返回**公开数据**。
 *
 * 匿名请求的租户来自 `X-Tenant-Subdomain` 头或 Host 头，两者都可被伪造。
 * 这在本 service 里是无害的——商品本来就对所有人公开可见，
 * 伪造子域名只能看到那个店铺本来就公开的商品。
 *
 * 但这条安全性依赖于「公开路径上只有公开数据」这个不变量。
 * 将来若要在这里加「查本租户订单」之类的接口，就必须把它挪到需要认证的路径上，
 * 否则攻击者能用伪造的子域名头读到别人的数据。
 */
@Injectable()
export class PublicCatalogService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 店铺是否被暂停。
   *
   * 只有 `PAUSED` 才拦截——返回空列表而不是 404，避免泄露店铺的运营状态
   * （比如店铺被平台暂停了）。
   *
   * ⚠️ `DRAFT` **不拦截**：商家注册后店铺的初始状态就是 `DRAFT`
   * （`StoreStatus` 的 schema 默认值，注册流程没显式传 status），
   * 而阶段 2 没有「店铺上线」这道流程。若按「非 LIVE 即拦截」实现，
   * 公开接口会永远返回空列表——症状是「商品上架了但前台看不到」，
   * 很难往状态机上想。
   */
  private async isStorePaused(tenantId: string): Promise<boolean> {
    const store = await this.prisma.store.findFirst({
      where: { tenantId },
      select: { status: true },
    });
    return store?.status === 'PAUSED';
  }

  /** 公开的商品列表字段裁剪：不返回 tenantId / version / deletedAt 等内部字段 */
  private static readonly listSelect = {
    id: true,
    name: true,
    slug: true,
    subtitle: true,
    minPrice: true,
    publishedAt: true,
    category: { select: { id: true, name: true, slug: true } },
    media: {
      where: { media: { deletedAt: null } },
      orderBy: { sort: 'asc' },
      select: {
        sort: true,
        media: { select: { id: true, url: true, mime: true } },
      },
    },
  } satisfies Prisma.ProductSelect;

  async list(query: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    categoryId?: string;
    minPrice?: number;
    maxPrice?: number;
    sort?: 'latest' | 'price_asc' | 'price_desc';
  }) {
    const tenantId = this.currentTenantId();

    if (await this.isStorePaused(tenantId)) {
      return { items: [], total: 0, page: 1, pageSize: 20 };
    }

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PUBLIC_PAGE_SIZE,
      Math.max(1, query.pageSize ?? 20),
    );

    const where: Prisma.ProductWhereInput = {
      tenantId,
      status: 'PUBLISHED',
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.minPrice !== undefined || query.maxPrice !== undefined
        ? {
            minPrice: {
              ...(query.minPrice !== undefined ? { gte: query.minPrice } : {}),
              ...(query.maxPrice !== undefined ? { lte: query.maxPrice } : {}),
            },
          }
        : {}),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { slug: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.ProductOrderByWithRelationInput =
      query.sort === 'price_asc'
        ? { minPrice: 'asc' }
        : query.sort === 'price_desc'
          ? { minPrice: 'desc' }
          : { publishedAt: 'desc' };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: PublicCatalogService.listSelect,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** 公开的品类树 */
  async categories() {
    const tenantId = this.currentTenantId();

    if (await this.isStorePaused(tenantId)) {
      return [];
    }

    const all = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
      select: { id: true, name: true, slug: true, parentId: true },
    });

    const byId = new Map<
      string,
      (typeof all)[number] & { children: Array<(typeof all)[number]> }
    >();
    for (const row of all) {
      byId.set(row.id, { ...row, children: [] });
    }
    const roots: Array<(typeof all)[number] & { children: Array<(typeof all)[number]> }> = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /** 公开的商品详情 */
  async productDetail(slug: string) {
    const tenantId = this.currentTenantId();

    if (await this.isStorePaused(tenantId)) {
      throw new NotFoundException('商品不存在');
    }

    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'PUBLISHED' },
      select: {
        id: true,
        name: true,
        slug: true,
        subtitle: true,
        description: true,
        attributes: true,
        minPrice: true,
        publishedAt: true,
        category: { select: { id: true, name: true, slug: true } },
        // media 是 to-many 的 ProductMedia 列表，用关系条件过滤它关联的 Media
        media: {
          where: { media: { deletedAt: null } },
          orderBy: { sort: 'asc' },
          select: {
            sort: true,
            media: { select: { id: true, url: true, mime: true } },
          },
        },
        specs: {
          where: { deletedAt: null },
          orderBy: { sort: 'asc' },
          select: {
            id: true,
            name: true,
            sort: true,
            values: {
              where: { deletedAt: null },
              orderBy: { sort: 'asc' },
              select: { id: true, value: true, sort: true },
            },
          },
        },
        skus: {
          where: { deletedAt: null, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            price: true,
            comparePrice: true,
            stock: true,
            specValues: { select: { valueId: true } },
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    return product;
  }
}
```

> **⚠️ 搜索的实现方式**（比设计文档 §5.3 写的更简单，且更安全）：
>
> 设计文档里写的是 `name % '纯棉T恤'`（pg_trgm 的相似度操作符）。
> **Prisma 不暴露 `%` 操作符**，要用它就得写原生 SQL——那会绕过整个 Prisma
> 扩展，手写隔离条件。
>
> 实际上 Prisma 的 `contains` + `mode: 'insensitive'` 生成的是
> `ILIKE '%keyword%'`，**pg_trgm 的 GIN 索引正好加速这个操作**
> （trgm 索引支持 LIKE / ILIKE 的前后通配查询）。
>
> 所以直接用 `contains` 就能既走索引又不绕开隔离机制。
>
> **代价**：这是精确的子串匹配（大小写不敏感），不是 trgm 的相似度阈值匹配——
> 后者能容忍错别字（「纯棉园领T恤」也能搜到「纯棉圆领T恤」）。
> 对中文电商来说子串匹配通常够用；容错搜索留到将来需要时再加。
>
> **§8.3 的价格区间筛选**用的是 `Product.minPrice`（派生字段），
> 与排序共用同一字段，保证「筛选后」与「排序后」语义一致。

- [ ] **Step 3: 写 PublicCatalogController**

创建 `api/src/modules/catalog/public/public-catalog.controller.ts`：

```typescript
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { PublicCatalogService } from './public-catalog.service';

@ApiTags('public-catalog')
@Controller('public')
export class PublicCatalogController {
  constructor(private readonly publicCatalog: PublicCatalogService) {}

  @Get('categories')
  @Public()
  @ApiOperation({ summary: '品类树（公开）' })
  categories() {
    return this.publicCatalog.categories();
  }

  @Get('products')
  @Public()
  @ApiOperation({ summary: '商品列表（公开）' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String })
  @ApiQuery({ name: 'minPrice', required: false, type: Number })
  @ApiQuery({ name: 'maxPrice', required: false, type: Number })
  @ApiQuery({ name: 'sort', required: false, enum: ['latest', 'price_asc', 'price_desc'] })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('sort') sort?: 'latest' | 'price_asc' | 'price_desc',
  ) {
    return this.publicCatalog.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      keyword,
      categoryId,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      sort,
    });
  }

  @Get('products/:slug')
  @Public()
  @ApiOperation({ summary: '商品详情（公开）' })
  productDetail(@Param('slug') slug: string) {
    return this.publicCatalog.productDetail(slug);
  }
}
```

- [ ] **Step 4: 注册到 CatalogModule**

改 `api/src/modules/catalog/catalog.module.ts`：

```typescript
import { Module } from '@nestjs/common';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { SpecMatrixService } from './specs/spec-matrix.service';
import { MinPriceService } from './pricing/min-price.service';
import { PublicCatalogController } from './public/public-catalog.controller';
import { PublicCatalogService } from './public/public-catalog.service';

@Module({
  controllers: [
    CategoriesController,
    ProductsController,
    PublicCatalogController,
  ],
  providers: [
    CategoriesService,
    ProductsService,
    SpecMatrixService,
    MinPriceService,
    PublicCatalogService,
  ],
  exports: [
    CategoriesService,
    ProductsService,
    SpecMatrixService,
    MinPriceService,
    PublicCatalogService,
  ],
})
export class CatalogModule {}
```

- [ ] **Step 5: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/catalog-public.e2e-spec.ts
```

预期：全部 PASS。

- [ ] **Step 6: 验证搜索确实走了 trgm 索引**

确认索引被用上（`EXPLAIN`）：

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U ecommerce -d ecommerce -c "
    EXPLAIN (COSTS OFF)
    SELECT * FROM products
    WHERE name ILIKE '%纯棉%' AND deleted_at IS NULL;"
```

预期：计划里出现 `Bitmap Index Scan on products_name_trgm`。

> **若出现的是 `Seq Scan`**，说明数据量太小，PostgreSQL 判断顺序扫描更划算——
> 这是正常的，数据量大到一定程度才会切到索引。
> 用 `SET enable_seqscan = off;` 再跑一次即可确认索引可用。

- [ ] **Step 7: 跑全量测试与检查**

```bash
cd api && npm test && npm run test:e2e
```

预期：全部 PASS。阶段 1 的既有测试不能被本次改动破坏。

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：0 error。

- [ ] **Step 8: 更新 OpenAPI 文档描述**

改 `api/src/main.ts` 里的 swagger 描述：

```typescript
    .setDescription('多租户电商 SaaS API · 阶段 2：商品中心')
```

- [ ] **Step 9: 提交**

```bash
git add api/src api/test
git commit -m "feat(api): 公开商品读取与 pg_trgm 搜索"
```

---

## 计划 2a 收尾

- [ ] **Step A: 跑完整检查**

```bash
cd api && npm test && npm run test:e2e && npm run test:cov:e2e && npx tsc --noEmit && npm run lint
```

预期：全部通过。覆盖率应不低于阶段 1 的 63.9%。

- [ ] **Step B: 写种子数据**

改 `api/prisma/seed.ts`：加一个带品类、规格、SKU 与图片的示例商品，
让本地开发一启动就有东西可看。

- [ ] **Step C: 更新 README**

`README.md` 的「当前进度」改为「阶段 2a（商品中心后端）已完成」，
并把「后续计划」表格里的计划 2 标为进行中。

- [ ] **Step D: 更新验收记录**

新建 `docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md`，
记录自动化测试结果与接口清单。格式参照
`docs/superpowers/plans/2026-10-21-plan-01-acceptance.md`。

- [ ] **Step E: 提交**

```bash
git add api/prisma/seed.ts README.md docs/
git commit -m "docs: 阶段 2a 商品中心后端收尾与验收记录"
```

**下一步：执行计划 2b（主题 token、storefront 浏览页、商家后台、验收）。**
