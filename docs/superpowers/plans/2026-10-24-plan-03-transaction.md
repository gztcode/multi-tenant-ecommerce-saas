# 计划 3：交易链路 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 2 的商品中心之上建出完整交易闭环——购物车 → 下单（库存预占）→ 支付 → 发货 → 确认收货，并把阶段 2 遗留的 `RESERVE` / `RELEASE` / `DEDUCT` 三种库存流水类型真正用起来。

**Architecture:** 后端新增三个模块：`cart`（购物车与地址簿）、`order`（订单状态机与库存预占）、`payment`（支付抽象与 webhook）。订单**下单走 `FOR UPDATE` 行锁**（不是阶段 2 的乐观锁——下单是高频操作，乐观锁会大量 409），库存流水的 `RESERVE`/`RELEASE`/`DEDUCT` 三态在同一个事务里与订单状态一起流转。状态流转**一律用条件更新**（`updateMany` where 带 `status`），靠受影响行数判定并发赢家。支付层用 `PaymentProvider` 接口 + 一个本地假网关（真实渠道适配器预留接口）。超时释放走 Redis + BullMQ 的 delayed job。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 + BullMQ 5 + Redis 7 | Next.js 15 + React 19 + Tailwind 4 + shadcn/ui | Vitest（前端单测）+ Jest/Supertest（后端）

**对应设计文档:** `docs/superpowers/specs/2026-10-24-plan-03-transaction-design.md` 全文。**本计划是该文档的可执行展开**，两者冲突时以设计文档为准。

---

## 零、全局约定

### 0.1 沿用阶段 2 的既有约定（不要重新发明）

| 约定 | 位置 | 说明 |
|------|------|------|
| 金额一律整数分 | 全局 | 阶段 0.4 已定 |
| 时间存 `timestamptz`，API 传 ISO 8601 | 全局 | 阶段 0.4 已定 |
| 租户隔离靠 `TenantPrismaService` 扩展 | `api/src/common/tenant/` | 新表**必须**登记进 `TENANT_SCOPED_MODELS`，否则服务启动直接失败 |
| 软删除模型 | `SOFT_DELETE_MODELS` | 阶段 2 已定；新增带 `deletedAt` 的表要一并登记 |
| 关联读取必须显式 `where` | 全局 | 扩展的软删过滤**只作用于顶层**，嵌套关联不会被自动过滤 |
| 唯一约束冲突要转 409 | `rethrowIfUniqueViolation` | `api/src/common/errors/unique-constraint.ts`，阶段 2a 建的 |
| 中转路由必须白名单重建请求体 | `merchant-admin/src/app/api/**` | 阶段 2b 安全审查确立的约定 |
| 前端断言要具体 | 全部 | 「只断言 200」「只断言报错」都算恒真 |

### 0.2 本阶段的 20 项护栏

设计文档 §十一.1 列了 20 项，每项**至少一个失败注入**。实施时把护栏编号写进测试的注释里，
验收时按编号逐条核对。

**设计文档 §十二 的 16 个风险（R1–R16）**是这些护栏的来源，实施时对照着看。

### 0.3 端口与基础设施

| 服务 | 宿主机 | 容器内 | 状态 |
|------|--------|--------|------|
| PostgreSQL | 15432 | 5432 | 已在跑 |
| MinIO | 19000 | 9000 | 已在跑 |
| **Redis** | **16380** | **6379** | **本 Task 新增** |
| api | 3000 | 3000 | 已在跑 |
| storefront | 3011 | 3000 | dev 用 3011（3001 被容器占） |
| merchant-admin | 3016 | 3000 | dev 用 3016（3002 被容器占） |

### 0.4 目录

```
api/src/modules/
├─ cart/          # 新建：购物车 + 地址簿
├─ order/         # 新建：订单 + 状态机 + 库存预占
├─ payment/       # 新建：支付抽象 + 假网关 + webhook
├─ queue/         # 新建：BullMQ 封装
└─ ...
merchant-admin/src/app/api/     # 新增中转路由
storefront/src/app/(shop)/      # 新增购物车/结算/订单页
```

### 0.5 计划勘误（2026-10-24，实施前的一轮核对）

本计划初稿写完后，拿它对着**现有代码**逐条核对了一遍，发现 23 处与现状不符。
已在正文各处就地修正，这里留一张索引表，免得有人按旧版本做。

| # | 问题 | 后果 | 在哪修 |
|---|------|------|--------|
| 1 | `TenantPrismaService` 是包装模式，每个模型一个 getter，Task 1 没让加 | 业务代码写 `this.prisma.order` 编译不过 | Task 1 Step 1.5b |
| 2 | 设计 §3.4 的 `Order` 漏了 `idempotencyKey` 字段（只在 §5.1 片段里有） | 手写索引引用不存在的列 → **迁移直接失败** | Task 1 Step 1.4 |
| 3 | BullMQ 两套混用：Task 1 裸 `bullmq`，Task 6 用 `@Processor` 装饰器 | 装饰器式 worker 拿不到连接，worker 静默不工作 | Task 1 Step 1.3 / 1.6 |
| 4 | 队列消费者没重建租户上下文 | 查 Order/Sku 抛 `TenantScopeError` | Task 5 Step 3b、Task 6 Step 2 |
| 5 | Task 5 缺 webhook 消费端 worker | 事件被记下但订单永不流转 | Task 5 Step 3b |
| 6 | 支付成功的 DEDUCT 流水与订单转 `PAID` 没有归属 | R5 只有超时释放那一侧，仍会超卖 | Task 5 Step 3b |
| 7 | dto 文件名写成 `dto/*.d.ts` | `.d.ts` 是类型声明文件，装不了实现 | Task 2 / 4 / 5 的 Files |
| 8 | 退款端点在设计 §十 的接口清单里不存在 | 状态机有 `REFUNDED` 但无入口可触发 | Task 5 Step 2b |
| 9 | 发起支付的端点也不在清单里 | 验收 #6「假网关支付」没有入口 | Task 5 Step 2b |
| 10 | 退款若放 order 模块 → payment 与 order 循环依赖 | Nest 启动失败 | Task 4（依赖方向单向 `payment → order`） |
| 11 | seed 里没有消费者账号 | Task 8 的浏览器手测登录不了消费者侧 | Task 1 Step 1.5c |
| 12 | 假网关支付页路径与 `setGlobalPrefix('api/v1')` 冲突 | 跳转 404 | Task 8 §8.1 |
| 13 | 设计 §三 开头说「7 张表全带 tenantId」与 §3.7 自相矛盾 | 实施时不知该不该登记事件表 | Task 1 Step 1.1（反向断言锁住） |
| 14 | 结算页的幂等键「提交时生成」与「进入结算页时生成」两句矛盾 | 两份订单 | Task 7 §7.2 |
| 15 | 设计 §11.1 的护栏编号（1–20）与 §十二 的风险编号（R1–R16）两套混用，计划正文还发生了偏移 | 验收时按编号核对对不上 | §0.6 对照表 |
| 16 | 设计 §3 的 Prisma 模型只写了一侧关系，漏三个反向字段 | `prisma validate` 直接失败 | Task 1 Step 1.4 |
| 17 | `InventoryMovement.operatorId` 是**非空**，但预占/释放是系统行为、没有人工操作人（游客下单连 customerId 都为空） | 预占流水填不出操作人 | Task 3（放宽为可空 + 新迁移） |
| 18 | 行锁的 `id IN (...) + ORDER BY id` 里，**加锁顺序由查询计划决定**，不随 IN 列表顺序变化 | 去掉排序也不死锁 → 护栏 5 不可测 | Task 3（改为逐条加锁） |
| 19 | `InventoryMovement` 只有自由文本的 `reason`，**流水与订单之间没有数据层关联** | 对从未预占过的 SKU 释放 → 凭空造货，且流水与库存自洽、对账看不出问题 | Task 3（加 `orderId` 字段 + 释放/扣减校验预占量） |
| 20 | 「未冲抵预占量」的汇总公式写成「三者 quantity 之和取负」——**`DEDUCT` 的符号算反了** | 已售出的货还能再释放一次（凭空造货）；且公式同号的两类流水语义不同，不能一股脑求和 | Task 3（按类型分别汇总，见 §3.2c） |
| 21 | 消费者侧订单接口挂「游客或登录」守卫，而归属过滤写成「`customerId` 为空就不加条件」 | **游客能读任意订单详情并取消它**（泄露姓名/手机号/地址） | Task 4（改挂 `JwtAuthGuard` + 服务层 `requireCustomerId`） |
| 22 | 订单号唯一冲突的「重试一次」写在事务内 | P2002 让事务 aborted，重试必然失败 → 500 | Task 4（重试移到事务外，重开整个事务） |
| 23 | 列表接口的分页没有上下限，也没有畸形参数兜底 | `pageSize=999999` 拖出整个租户的订单；`page=0` / `page=abc` → 500 | Task 4（`common/http/pagination.ts` 统一处理） |
| 24 | **`@nestjs/bullmq` v12 没有 `@Process` 装饰器**——只有 `WorkerHost` 基类 + `process(job)` | worker 照抄旧版写法编译不过 | Task 5 Step 3b、Task 6 Step 2 |
| 25 | 计划 Step 3（controller 落事件行）与 Step 3b（worker 也落）自相矛盾 | 两处都插必然冲突，worker 永远处理不下去 | Task 5（事件行只在 controller 插，worker 只做业务流转） |
| 26 | webhook 端点与假网关页面**没有子域名**，租户上下文拦截器会直接 404 | 端点全 404 | Task 5（挂 `@Skip()`） |
| 27 | 验签需要**请求的原始字节**，而默认 JSON parser 会消费掉请求流 | 拿不到 rawBody，验签必然失败 | Task 5（`main.ts` 开 `rawBody: true`） |

> **另外两处小错**：Task 1 的 Step 编号从 1.2 起跳（1.1 漏了 checkbox）；
> Task 1 的 commit message 说「三处索引」却列了四条。两处都已改正。

### 0.6 护栏与风险的对照表（验收以这张表为准）

**设计文档里有两套编号**：§11.1 的**护栏编号**（1–20）与 §12 的**风险编号**
（R1–R16）。本计划正文里写的「R4」「R5」「R14」等，**实际指的是护栏编号**，
但字母用了 R —— 于是同一串字符在两套体系里指的是完全不同的事
（护栏 5 = 按 skuId 排序加锁；风险 R5 = 支付回调与超时释放并发）。
个别处还发生了偏移（Task 3 的「R8 加锁顺序防死锁」说的其实是护栏 5，
护栏 8 是「金额不可篡改」）。

**所以：验收（Task 8）一律按护栏编号 1–20 核对，风险编号只作辅助说明。**
下表是唯一权威对照：

| 护栏 | 内容 | 在哪测 | 风险出处 |
|------|------|--------|---------|
| 1 | 合并取 max 不累加 | Task 2 | §12.2 R9 |
| 2 | 合并重新校验 | Task 2 | §12.2 R10 |
| 3 | 合并幂等 | Task 2 | §13 遗留项 9 |
| 4 | 行锁串行化并发下单 | Task 3 | §12.2 R8 的措施 |
| 5 | 按 skuId 排序加锁 | Task 3 | §12.2 R8 |
| 6 | 下单幂等键 | Task 4 | §12.2 R7 |
| 7 | 跨租户下单被拒 | Task 4 | §八 多租户边界 |
| 8 | 金额不可篡改 | Task 4 | §12.1 R4 |
| 9 | 预占不足整单回滚 | Task 3 | §12.1 R5 的相邻风险 |
| 10 | 状态流转用条件更新 | Task 4（payment 侧） + Task 6（释放侧） | §12.1 R5 |
| 11 | webhook 验签后才落库 | Task 5 | §12.1 R1 |
| 12 | webhook 幂等 | Task 5 | §12.1 R2 |
| 13 | webhook 金额核对 | Task 5 | §6.3 |
| 14 | webhook 不采信 tenantId | Task 5 | §12.1 R6 |
| 15 | 状态机拒绝非法流转 | Task 4 | §七 状态机 |
| 16 | 假网关生产拒绝启动 | Task 5 | §12.1 R3 |
| 17 | 退款不回补库存 | Task 4（流转） + Task 5（完整） | §7.1 |
| 18 | jobId 去重 + 消费端幂等 | Task 6 | §12.2 R15 |
| 19 | 地址默认地址唯一 | Task 2 | §12.2 R14 |
| 20 | 地址归属当前租户 | Task 2 | §3.3 |

---

## Task 1：基础设施与数据模型

本 Task 铺好阶段 3 的地基：Redis 服务、BullMQ 封装、7 张新表与迁移、租户白名单登记。

**Files:**
- Modify: `infra/docker-compose.yml`
- Modify: `api/.env.example`
- Modify: `infra/.env.example`
- Modify: `api/src/common/tenant/tenant-models.ts`
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`
- Modify: `api/src/app.module.ts`
- Modify: `api/prisma/seed.ts`
- Create: `api/prisma/migrations/<stamp>_add_transaction_tables/migration.sql`
- Create: `api/src/modules/queue/queue.module.ts`
- Create: `api/src/modules/queue/queue.service.ts`
- Create: `api/src/common/queue/queue.constants.ts`

> **勘误（2026-10-24，实施前发现）**：本 Task 原计划只让登记白名单，
> **漏了两件必需的事**——
> 1. `TenantPrismaService` 是「包装」模式：每个模型一个 getter
>    （`get sku() { return this.client.sku; }`）。不新增 getter，
>    业务代码写 `this.prisma.order` 直接编译不过。
> 2. `Order` 模型缺 `idempotencyKey String?` 字段（设计 §3.4 漏了，只在 §5.1
>    的片段里出现）。而 Step 1.4 的手写索引引用了这个列 →
>    **照抄 §3.4 会让迁移直接失败**。
>
> 详见下文各 Step 的补充说明。

- [ ] **Step 1.1: 先写失败测试**

新表的白名单登记是 fail-fast 的：漏登记 → 服务启动失败。所以先写一个**验证白名单完整性**的单元测试。

在 `api/src/common/tenant/tenant-prisma.service.spec.ts` 末尾追加：

```typescript
  it('阶段 3 的新表全部登记在租户作用域白名单里', () => {
    // 漏登记的后果是「那张表的所有读写都不附加 tenantId 条件」——
    // 彻底失去隔离且没有任何报错。所以这条断言守着它。
    const expected = [
      'Cart',
      'CartItem',
      'Address',
      'Order',
      'OrderItem',
      'Payment',
    ];
    for (const model of expected) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  it('webhook 幂等表不登记进白名单：它是渠道事件的数据，租户从订单反查', () => {
    // 反向断言，锁住一个刻意的决定。设计文档 §3.7 与 §三开头自相矛盾
    // （前者说不带 tenantId、不登记，后者说 7 张表全部登记），
    // 实际按前者实现。这条测试让矛盾再出现时会立刻暴露。
    expect(TENANT_SCOPED_MODELS.has('PaymentWebhookEvent')).toBe(false);
  });
```

在文件头部加 import：

```typescript
import { TENANT_SCOPED_MODELS } from './tenant-models';
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：FAIL，`expected false to be true`（`Cart` 未登记）。

### 1.2 加 Redis 服务

`infra/docker-compose.yml` 的 `postgres` 服务之后插入：

```yaml
  redis:
    image: redis:7-alpine
    container_name: ecommerce-redis
    restart: unless-stopped
    command: redis-server --appendonly yes
    ports:
      # 宿主机端口 16380：本机标准端口 6379 已被其他项目栈占用
      - '${REDIS_PORT:-16380}:6379'
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 10s
      timeout: 3s
      retries: 10
```

在 `volumes:` 下加 `- redis-data:`。

`api` 服务加环境变量与依赖：

```yaml
    environment:
      REDIS_URL: redis://redis:6379
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
      redis:
        condition: service_healthy
```

> **容器内用服务名 `redis`，宿主机用 16380。** 阶段 1 的 `.env` 里端口是给宿主机
> 客户端用的，容器间通信走服务名。

`api/.env.example` 补一行（宿主机开发用）：

```bash
# Redis（BullMQ 队列）。宿主机端口 16380：本机标准端口 6379 已被其他项目栈占用。
# 容器内的 api 服务由 compose 覆盖成 redis://redis:6379。
REDIS_URL=redis://localhost:16380
```

`infra/.env.example` 补一行（compose 用）：

```bash
# Redis
REDIS_PORT=16380
```

> **两处都要有，指向不同。** `api/.env.example` 是给宿主机上跑的
> `npm run start:dev` 用的（连 `localhost:16380`）；`infra/.env` 是给
> compose 里的 api 容器用的（连服务名 `redis:6379`）。搞混的症状是
> 「本机 dev 起不来」或「容器里连不上」。

### 1.3 装依赖

```bash
cd api && npm install @nestjs/bullmq bullmq ioredis
```

预期：`added N packages`。

> **为什么是 `@nestjs/bullmq` 而不是只用 `bullmq`**：Task 6 的 worker 用
> `@Processor` / `@Process` 装饰器，那两个装饰器由 `@nestjs/bullmq` 提供。
> 装饰器式 worker 必须从 **Nest 注册的队列实例**里拿连接——用原生
> `new Worker()` 手写出来的 worker 与 `@nestjs/bullmq` 的 `BullModule`
> 是两套独立的连接管理，混用会出现「装饰器注入了但连接不通」这类难查的问题。
>
> 既然 Task 6 已经用了装饰器，Task 1 的队列封装就统一走 `@nestjs/bullmq`：
> `BullModule.forRootAsync` 配 Redis 连接、`BullModule.registerQueue` 注册队列名、
> `QueueService` 用 `@InjectQueue(名字)` 注入。

### 1.4 写数据模型

`api/prisma/schema.prisma` 追加 **7 个模型与 2 个枚举**（照设计文档 §3.1–§3.7，
**包括 §3.6 的 `payments.provider` 字段与那两条部分唯一索引**）：

| 模型 | 枚举 | 带 tenantId | 登记白名单 |
|------|------|------------|-----------|
| `Cart` | — | 是 | 是 |
| `CartItem` | — | 是 | 是 |
| `Address` | — | 是 | 是 |
| `Order` | `OrderStatus` | 是 | 是 |
| `OrderItem` | — | 是 | 是 |
| `Payment` | `PaymentStatus` | 是 | 是 |
| `PaymentWebhookEvent` | — | **否** | **否** |

> ⚠️ **`PaymentWebhookEvent` 不带 `tenantId`，因此不登记进白名单。**
> 它是渠道事件的数据，租户从订单反查。
>
> ⚠️ **`Order` 模型要补一个设计文档 §3.4 漏掉的字段**：
>
> ```prisma
>   // 幂等键。同一个键重复下单返回同一个订单，而不是新建一个。
>   // 部分唯一索引：不同租户可以用同一个键（虽然不该，但不该因此报错）。
>   idempotencyKey String?
> ```
>
> 设计文档 §3.4 的 `Order` 定义里**没有这个字段**，只在 §5.1 的片段里出现过。
> 照抄 §3.4 会让 Step 1.4 的手写索引 `("tenantId", "idempotencyKey")`
> 引用一个不存在的列 → **迁移直接失败**。这是设计文档的一处内部不一致，
> 已同步修正到设计文档。
>
> ⚠️ **`Order.idempotencyKey` 需要一条部分唯一索引**，Prisma 表达不了，
> 写进迁移的手写 SQL 里。
>
> ⚠️ **要补三个反向关系字段**。现有 schema 里已经写着这条规矩：
> 「Prisma 要求双向关系都声明，否则 schema 校验直接失败」。
> 设计 §3 的模型定义只写了一侧，漏了这三个：
>
> | 补在哪个模型 | 字段 | 因为 |
> |------------|------|------|
> | `Tenant` | `carts Cart[]` | `Cart` 声明了 `tenant Tenant @relation` |
> | `User` | `carts Cart[]` | `Cart` 声明了 `customer User? @relation` |
> | `Sku` | `cartItems CartItem[]` | `CartItem` 声明了 `sku Sku @relation` |
>
> 漏了它们，`prisma validate` 直接失败（且报错信息不会告诉你缺的是哪一侧）。
>
> `Address` 与 `Order` / `Payment` **刻意不声明 tenant 关系**——
> 它们只有 `tenantId` 标量。这样设计是为了「数据库挡不住跨租户挂载」
> 这个显式风险（护栏 20）由 service 层负责，而不是靠外键悄悄放行。

迁移文件（**手写，不靠 `prisma migrate dev` 生成**，因为部分唯一索引与
`pg_trgm` 那种手写索引会被 diff 误删——阶段 2 已经踩过）：

先让 Prisma 生成建表部分：

```bash
cd api && npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/p3/tables.sql
```

然后建迁移目录，把 `tables.sql` 作为基础，**追加**手写索引：

```sql
-- 购物车：一个消费者在同一店铺只有一个购物车（合并的前提）
CREATE UNIQUE INDEX "carts_tenant_customer_uniq"
  ON "carts" ("tenantId", "customerId") WHERE "customerId" IS NOT NULL;
CREATE UNIQUE INDEX "carts_tenant_guest_uniq"
  ON "carts" ("tenantId", "guestToken") WHERE "guestToken" IS NOT NULL;

-- 默认地址唯一
CREATE UNIQUE INDEX "addresses_tenant_customer_default_uniq"
  ON "addresses" ("tenantId", "customerId")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;

-- 下单幂等键
CREATE UNIQUE INDEX "orders_tenant_idempotency_uniq"
  ON "orders" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- 支付幂等：同一笔渠道交易不会落成两条支付单（R2）
CREATE UNIQUE INDEX "payments_provider_txn_uniq"
  ON "payments" ("provider", "providerTxnId");
```

> **`payments_provider_txn_uniq` 不能省。** `providerTxnId` 可空，
> 而 PostgreSQL 的 NULL 不参与唯一判定——多个 NULL 互不冲突，正好符合
> 「还没拿到渠道交易号的支付单可以有多条」的预期。

应用迁移：

```bash
cd api && npx prisma migrate deploy
```

> **若 `migrate dev` 因为 drift 失败，绝不 reset**——阶段 2 已经因此踩过坑。
> 用上面的 `migrate diff` 兜底。

- [ ] **Step 1.5: 登记白名单**

`api/src/common/tenant/tenant-models.ts` 的两个白名单都补上：

```typescript
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User', 'Store',
  'Category', 'Product', 'ProductSpec', 'ProductSpecValue',
  'Sku', 'SkuSpecValue', 'Media', 'ProductMedia', 'InventoryMovement',
  // 阶段 3：交易链路
  'Cart', 'CartItem', 'Address', 'Order', 'OrderItem', 'Payment',
]);
```

`SOFT_DELETE_MODELS` 补 `Address`：

```typescript
export const SOFT_DELETE_MODELS = new Set<string>([
  'Category', 'Product', 'ProductSpec', 'ProductSpecValue', 'Sku', 'Media',
  'Address',
]);
```

> `Cart` / `CartItem` **不软删**——购物车是临时数据，清空即删。
> `Order` / `OrderItem` / `Payment` **不软删**——它们是财务凭证，
> 只能靠状态机流转（`CANCELLED` / `CLOSED` / `REFUNDED`），不能删。

- [ ] **Step 1.5b: 加模型 getter**

`api/src/common/tenant/tenant-prisma.service.ts` 里每个模型一个 getter
（现有模式：`get sku() { return this.client.sku; }`）。**7 个新模型各加一个**：

```typescript
  get cart() {
    return this.client.cart;
  }

  get cartItem() {
    return this.client.cartItem;
  }

  get address() {
    return this.client.address;
  }

  get order() {
    return this.client.order;
  }

  get orderItem() {
    return this.client.orderItem;
  }

  get payment() {
    return this.client.payment;
  }

  // 不在租户白名单里，但业务代码要读写它（webhook 幂等表）
  get paymentWebhookEvent() {
    return this.client.paymentWebhookEvent;
  }
```

> **漏了 getter 会怎样**：业务代码写 `this.prisma.order` 时 TypeScript 报
> `Property 'order' does not exist`——编译期就炸，不会静默出错。
> 但漏了它会让实现者临时改用 `as any` 绕过，那才是真的破防。
>
> **`paymentWebhookEvent` 也要 getter**：它不在租户白名单（所以读写都不附加
> tenantId 条件），但代码照样要访问它——「不在白名单」不等于「不存在」。

- [ ] **Step 1.5c: seed 里加消费者账号**

Task 8 的浏览器手测要用 `customer@demo.platform.test` 登录消费者侧，
但现在的 `prisma/seed.ts` 只有平台超管与店主，**没有消费者账号**。

新增一个独立的 `seedDemoCustomer()`（不要塞进 `seedDemoStore()` 里——
那个函数在「店铺已存在」时会提前 `return`，消费者账号就永远建不出来）：

```typescript
/**
 * 示例消费者账号（阶段 3 起）。
 *
 * 独立于 seedDemoStore：那个函数在店铺已存在时会整棵跳过，
 * 把消费者塞进去就永远建不出来。
 */
async function seedDemoCustomer(): Promise<void> {
  const email = process.env.SEED_DEMO_CUSTOMER_EMAIL ?? 'customer@demo.platform.test';
  const password = process.env.SEED_DEMO_CUSTOMER_PASSWORD ?? 'Demo12345!';

  const existing = await prisma.user.findFirst({
    where: { email, role: UserRole.CUSTOMER },
  });
  if (existing) {
    console.log(`示例消费者已存在，跳过：${email}`);
    return;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { subdomain: DEMO_SUBDOMAIN },
  });
  if (!tenant) {
    console.log('示例店铺不存在，跳过消费者账号');
    return;
  }

  await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash(password),
      displayName: '示例消费者',
      role: UserRole.CUSTOMER,
      tenantId: tenant.id,
    },
  });

  console.log(`已创建示例消费者：${email} / ${password}`);
}
```

`main()` 里在 `seedDemoStore()` **之后**调用它（要等租户建出来）。

> **`UserRole.CUSTOMER` 的租户归属**：消费者的 `tenantId` 指向注册的那家店。
> 阶段 3 明确**不支持跨店会员**（设计文档 §十三 遗留项 1）——
> 「同一个人在 A 店和 B 店各有一个会员账号」是现状，不是本阶段要改的。

- [ ] **Step 1.6: 写队列封装**

创建 `api/src/common/queue/queue.constants.ts`：

```typescript
/** 支付超时释放预占的延迟任务队列 */
export const PAYMENT_TIMEOUT_QUEUE = 'payment-timeout';

/** 支付回调的异步消费队列 */
export const PAYMENT_WEBHOOK_QUEUE = 'payment-webhook';
```

创建 `api/src/modules/queue/queue.service.ts`：

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
} from '../../common/queue/queue.constants';

export type QueueName =
  | typeof PAYMENT_TIMEOUT_QUEUE
  | typeof PAYMENT_WEBHOOK_QUEUE;

/**
 * BullMQ 队列封装的**入队侧**。
 *
 * 队列实例由 `@nestjs/bullmq` 的 `BullModule` 注册（见 queue.module.ts），
 * 这里只负责「往队列里投递任务」，不负责连接管理——连接是 Nest 的事。
 *
 * 为什么用 BullMQ 而不是自建轮询：轮询的延迟不可控（要低延迟就得高频轮询），
 * 且多实例部署时要有分布式锁。BullMQ 是电商后台的默认选择。
 *
 * ⚠️ `jobId` 的去重语义靠 BullMQ：同名的 jobId 不会重复入队。
 * 但**消费端仍要幂等**——任务可能在消费途中进程崩溃，重启后被重新投递。
 * 消费端的幂等靠数据库的唯一索引。
 */
@Injectable()
export class QueueService {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    @InjectQueue(PAYMENT_TIMEOUT_QUEUE) timeoutQueue: Queue,
    @InjectQueue(PAYMENT_WEBHOOK_QUEUE) webhookQueue: Queue,
  ) {
    this.queues.set(PAYMENT_TIMEOUT_QUEUE, timeoutQueue);
    this.queues.set(PAYMENT_WEBHOOK_QUEUE, webhookQueue);
  }

  /**
   * 投递一个延迟任务。
   *
   * @param jobId 幂等键——同名不会重复入队
   */
  async addDelayed(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    delayMs: number,
    jobId: string,
  ): Promise<void> {
    await this.queueOf(queueName).add(jobName, data, {
      delay: delayMs,
      jobId,
    });
  }

  async add(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    jobId: string,
  ): Promise<void> {
    await this.queueOf(queueName).add(jobName, data, { jobId });
  }

  private queueOf(queueName: QueueName): Queue {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`队列不存在：${queueName}`);
    }
    return queue;
  }
}
```

创建 `api/src/modules/queue/queue.module.ts`：

```typescript
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import {
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
} from '../../common/queue/queue.constants';
import { QueueService } from './queue.service';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL ?? 'redis://localhost:16380',
        // BullMQ 的 Worker 硬性要求：它内部用阻塞命令等待任务，
        // ioredis 默认的 maxRetriesPerRequest=1 会在重连时抛错、
        // 中断阻塞读，表现为「worker 静默停摆」。
        maxRetriesPerRequest: null,
      },
    }),
    BullModule.registerQueue(
      { name: PAYMENT_TIMEOUT_QUEUE },
      { name: PAYMENT_WEBHOOK_QUEUE },
    ),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
```

在 `api/src/app.module.ts` 的 `imports` 里加 `QueueModule`。

> **直接读 `process.env`，不要用 `ConfigService`**：本项目**没有注册
> `ConfigModule`**（`@nestjs/config` 装了但全程未 import）。现有的
> `assert-secure-config.ts` 也是直接读 `process.env`。跟着这个风格走，
> 不要为了一个模块把配置体系改掉。

- [ ] **Step 1.7: 跑测试**

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：PASS（白名单那条转绿）。

```bash
cd api && npx tsc --noEmit && npm run lint
```

预期：干净。

- [ ] **Step 1.8: 提交**

```bash
git add infra/ api/
git commit -m "feat(api): 阶段 3 的基础设施与数据模型

新增 Redis 服务（宿主机 16380）与 BullMQ 队列封装，落地 7 张交易表
（购物车 / 购物车项 / 地址簿 / 订单 / 订单项 / 支付单 / webhook 幂等表），
并登记进租户作用域白名单。

四处索引是手写的，Prisma 表达不了，且 migrate diff 会把它们当漂移删掉：
- carts 的两个部分唯一索引（消费者与游客各一个购物车，是合并的前提）
- addresses 的默认地址唯一索引
- orders 的下单幂等键索引
- payments 的 (provider, providerTxnId) 幂等索引（R2，缺了它同一笔
  渠道交易会落成两条支付单）

Order.idempotencyKey 让重复提交返回同一个订单而不是新建一个。

TenantPrismaService 补 7 个模型 getter——它是包装模式，每个模型一个 getter，
不补的话业务代码写 this.prisma.order 直接编译不过。

队列走 @nestjs/bullmq 而非裸 bullmq：Task 6 的 worker 用 @Processor 装饰器，
装饰器式 worker 必须从 Nest 注册的队列实例取连接，两套混用会连不通。

PaymentWebhookEvent 不带 tenantId、不登记白名单——它是渠道事件的数据，
租户从订单反查。

seed 补一个消费者账号，Task 8 的浏览器手测要用它。"
```

---

## Task 2：购物车与地址簿

`cart` 模块。购物车按店铺分（订单属于一个店铺），游客用 cookie 里的 token 标识，
登录后合并。

**Files:**
- Create: `api/src/modules/cart/cart.module.ts`
- Create: `api/src/modules/cart/cart.service.ts`
- Create: `api/src/modules/cart/cart.controller.ts`
- Create: `api/src/modules/cart/address.service.ts`
- Create: `api/src/modules/cart/address.controller.ts`
- Create: `api/src/modules/cart/dto/*.dto.ts`
- Create: `api/src/common/guards/optional-jwt-auth.guard.ts`
- Test: `api/test/cart.e2e-spec.ts`

### 2.0 消费者侧的认证与租户范围（实施前补充）

购物车要同时支持**游客**与**登录消费者**，这决定了 controller 怎么写。
三件既有机制必须先说清楚：

1. **现有 `JwtAuthGuard` 是类级守卫，挂了会拒绝匿名请求。**
   它挂在 controller 上时走 `AuthGuard('jwt')`；`@Public()` 只放行**身份认证**这一层，
   租户上下文拦截器照常工作。所以 `@Public()` 不能用来实现「游客或登录」——
   它会让登录用户也变成匿名，拿不到 customerId。
   → 本 Task 新增 `OptionalJwtAuthGuard`：**有 Bearer token 就验证（失败 401），
   没有就放行**（`request.user` 为 undefined）。它挂在消费者侧的 controller 上。

2. **租户上下文的来源是「JWT 优先，匿名才看子域名」**
   （`tenant-context.interceptor.ts` 的 `buildContext`）：
   - 带 token → 租户 = `JWT.tenantId`，`userId` = `JWT.sub`
   - 匿名 → 租户 = 子域名解析出来的店铺，`userId` = null
   → 购物车的租户范围一律取 `getTenantContext().tenantId`。

3. **跨店会员不支持**（设计 §十三 遗留项 1）。消费者在店铺 A 注册后，
   他在店铺 B 带 token 的请求拿到的仍是 **A 的租户上下文**——
   于是 B 店的 SKU 不属于 A，B 店的购物车也访问不到。
   这不是 bug 而是本阶段明确的能力边界，**但要在代码注释里写清楚**，
   别让后来的人以为是漏了判断。

   > **不要试图修这个**。要让「登录用户在当前店铺的上下文」以子域名为准，
   > 得改 `TenantContextInterceptor` 的优先级——那会波及阶段 1、2 的所有接口，
   > 远超本阶段范围。

4. **读取 cookie 需要 cookie-parser 中间件，本项目目前没有。**
   Express 自带 `res.cookies.set()`（写），但 `req.cookies`（读）必须靠
   `cookie-parser` 中间件。所以本 Task 要：
   - `cd api && npm install cookie-parser && npm install -D @types/cookie-parser`
   - `api/src/main.ts` 里 `app.use(cookieParser())`（放在 `setGlobalPrefix` 前后都行，
     但要在 `app.listen` 之前）
   - **e2e 测试里也要加**（`app.use(cookieParser())`），否则测试读不到 cookie，
     游客相关的用例会全挂

   > 现有的 e2e 基建在 `api/test/catalog-public.e2e-spec.ts` 等文件里各自
   > `app.useGlobalPipes(...)` / `app.useGlobalInterceptors(...)`，
   > 新写的 `cart.e2e-spec.ts` 按同样的路子来。

### 2.1 先写失败测试

`api/test/cart.e2e-spec.ts`。护栏对应：**护栏 1 合并取 max**、**护栏 2 合并重校验**、
**护栏 3 合并幂等**、**护栏 19 默认地址唯一**、**护栏 20 地址归属**
（护栏编号体系见计划 §0.6）。

关键用例：

```typescript
  it('游客加购：cookie 里的 token 标识购物车，同一店铺只有一个', async () => { /* ... */ });

  it('登录合并：同一 SKU 的数量取 max 而不是累加', async () => {
    // 游客加 2 件 → 登录后账号里已有 3 件 → 合并后是 3 件，不是 5 件
  });

  it('合并时重新校验：游客车里已下架的商品被丢弃', async () => { /* ... */ });

  it('合并是幂等的：游客车已不存在时返回成功', async () => { /* ... */ });

  it('跨租户不能引用别人的 SKU 加购', async () => { /* ... */ });

  it('加购数量超过上限被拒绝', async () => { /* ... */ });

  it('默认地址唯一：设第二个默认地址时旧的自动取消', async () => { /* ... */ });

  it('地址的 customerId 必须属于当前租户', async () => { /* ... */ });
```

> **断言要具体。** 「合并取 max」这条不能只断言 `quantity === 3`——
> 累加也会得到 5，max 才会得到 3，所以断言值本身就是区分度 ✓
> 但「合并时丢弃下架商品」要额外查一次库确认那条真的不在购物车里，
> 不能只断言总数。

- [ ] **Step 2.2: 写实现**

`CartService` 的核心方法：

```typescript
  /** 取当前请求的购物车（游客或登录），没有就建一个 */
  async currentCart(tenantId: string, customerId: string | null, guestToken: string | null) {
    // 游客：按 (tenantId, guestToken) 找
    // 登录：按 (tenantId, customerId) 找
    // 都没有 → 建一个
    // ⚠️ 并发建购物车可能撞部分唯一索引 → 捕获 P2002 后重查复用，
    //    不要把 500 抛给用户（遗留项 #9）
  }

  /** 合并游客购物车到账号购物车 */
  async merge(tenantId: string, customerId: string, guestToken: string | null): Promise<Cart> {
    // 1. 游客车不存在 → 直接返回账号车（幂等，R11）
    // 2. 两个都有 → 逐个 SKU 合并：
    //      两边都有 → 取 max（R9）
    //      只有一边有 → 搬过来
    //      ⚠️ 搬进来的每一条都要重新校验（R10）：
    //         SKU 属于当前租户、ACTIVE、未软删、商品上架、数量不超上限
    //         不合格的直接丢弃，不报错
    // 3. 删游客车、清 cookie
  }
```

`guestToken` 的生成与 cookie：

```typescript
  /** 32 字节随机，足够不可枚举 */
  private newGuestToken(): string {
    return randomBytes(32).toString('base64url');
  }
```

cookie 设置（**HttpOnly + SameSite=Lax**）：

```typescript
  // ⚠️ Express 的写法是 response.cookie(name, value, options)——
  //    response.cookies.set(...) 是 Fastify 的。本项目用 Express 适配器。
  response.cookie('cart_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
```

> **SameSite=Lax 的含义**：跨站的 POST 不带 cookie（写操作安全），
> 但顶级导航的 GET 会带。我们的写操作全是 POST ✓
> `cart_token` 里只有 token，购物车内容在数据库——避开 cookie 4KB 的限制。

**合并的两条上限**（设计 §4.2 的独立引用块，计划的初稿漏了）：

> **合并也要限流与上限。** 一个游客车可能有几百个条目（每条都带 skuId），
> 合并时要**限制单次处理的条目数**，避免恶意构造超大 cookie + 大购物车拖垮服务。

所以 `merge` 要有两条独立的上限：
1. **单次合并处理的条目数上限**（比如 200 条）——超出的部分直接丢弃，
   不报错（合并是尽力而为的动作）
2. **每条的数量上限**（§4.3 的 99）与**合并后的总数量上限**——都要判

> 游客车的条目只能通过 `addItem` 产生，所以「游客条目自身数量超上限」
> 在当前路径下不可达。但**要显式判**——不可达不等于可以不写，
> 将来若加了「导入购物车」「后台加购」之类的入口，这条就是唯一的防线。

- [ ] **Step 2.3: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/cart.e2e-spec.ts
```

- [ ] **Step 2.4: 提交**

```bash
git add api/
git commit -m "feat(api): 购物车与地址簿

游客用 cookie 里的 32 字节随机 token 标识购物车（购物车内容在数据库，
避开 cookie 4KB 限制），登录后合并到账号购物车。

三处合并的坑：
- 数量取 max 而不是累加——同一份意图的两份记录，累加会翻倍超卖（R9）
- 搬进来的每条都重新校验 SKU 归属/可售/上架/数量上限，陈旧内容直接丢弃（R10）
- 合并要幂等，游客车不存在时返回成功而不是报错（R11）

地址簿的默认地址用部分唯一索引保证唯一，设新默认前先把旧的置 false。
地址的 customerId 要校验属于当前租户（外键不带 tenantId，数据库挡不住，R20）。
"
```

---

## Task 3：库存预占

**这是整个阶段 3 最核心的一步。** 预占与释放的并发正确性决定会不会超卖。

**Files:**
- Modify: `api/prisma/schema.prisma`（`InventoryMovement.operatorId` 放宽为可空，见下）
- Create: `api/prisma/migrations/<stamp>_allow_null_inventory_movement_operator/migration.sql`
- Create: `api/src/modules/order/inventory.service.ts`
- Create: `api/src/modules/order/order.module.ts`
- Test: `api/test/inventory-reserve.e2e-spec.ts`

> **必须先放宽 `InventoryMovement.operatorId`。**
>
> 阶段 2 的 schema 里它是 `String`（**非空**），语义是「谁做了这次库存变动」
> ——阶段 2 的库存调整接口是商家手动操作，所以填店主 id。
>
> 但阶段 3 的预占/释放是**系统行为**，没有人工操作人；
> 游客下单时连 `orders.customerId` 都是空的，填不出一个消费者 id。
> 填 `'system'` 这类假值会让「谁动了库存」失真。
>
> 所以把字段放宽成 `String?`，用一条新迁移实现（**放宽约束是安全的**）：
>
> ```sql
> ALTER TABLE "inventory_movements" ALTER COLUMN "operatorId" DROP NOT NULL;
> ```
>
> > ⚠️ **不要改阶段 2 已应用的迁移文件**——改了会破坏 Prisma 记的 checksum，
> > 已部署的库会直接报「migration file was modified」。只能新增迁移。

### 3.1 先写失败测试

护栏对应：**护栏 4 行锁串行化**、**护栏 5 按 skuId 排序加锁**、
**护栏 9 预占不足整单回滚**（编号体系见计划 §0.6）。
「流水的双语义」是设计 §5.2 的实现约束，不是 20 项护栏之一。

```typescript
  it('并发下单：两个订单抢同一 SKU，库存只减一次', async () => {
    // 两个并发下单各买 1 件，库存只有 1 件 → 只有一个成功，另一个 409
  });

  it('加锁按 skuId 排序：两个订单含两个 SKU 且顺序相反，不死锁', async () => {
    // 订单 A: [sku1, sku2]，订单 B: [sku2, sku1]
    // 不排序加锁 → 死锁；排序后两个都成功
  });

  it('预占流水：quantity 是业务量，stock 是实际库存', async () => {
    // RESERVE: quantity=-5, stockBefore=10, stockAfter=5
    // DEDUCT:  quantity=-5, stockBefore=5,  stockAfter=5   ← 库存不变
  });

  it('库存不足时整单回滚，不留半截订单', async () => { /* ... */ });

  it('SKU 属于别的租户时不能被预占', async () => { /* ... */ });
```

> **并发用例要真的并发**：`Promise.all([请求A, 请求B])`，
> 不能先 await A 再 await B（那就不是并发了，测不到行锁）。
>
> **死锁用例更难**：两个事务各自持有对方要的行锁才会死锁，
> 所以两个请求必须**同时**进入加锁阶段。PostgreSQL 的
> `deadlock_timeout` 默认 1 秒，检测到死锁后抛 `P2034`
> （Prisma 的「写冲突或死锁」）。排序后两个都成功。
>
> **断言要查库**：「库存只减一次」要查 `skus.stock` 与
> `inventory_movements` 的行数，不能只看响应状态码。

- [ ] **Step 3.2: 写预占实现**

**行锁的 SQL 必须手写 `tenantId`**——`$queryRaw` 绕过 Prisma 扩展，
这是阶段 2 已经踩过的坑（`minPrice` 的原生 SQL 同样要手写租户条件）。

```typescript
  /**
   * 锁定并返回这些 SKU。
   *
   * ⚠️ 两条硬性要求：
   * 1. **按 id 排序、逐条加锁**——两个订单含两个 SKU 且顺序相反时会死锁
   *    （A→B vs B→A：各自持有对方要的行锁）。
   *    排序后全局加锁顺序一致，死锁不可能发生。
   *
   *    ⚠️ **为什么逐条加锁而不是一条 `id IN (...)`**：
   *    一条 IN 查询的加锁顺序由**查询计划**决定（位图扫描按堆序、
   *    索引扫描按索引序），**不随 IN 列表的顺序变化**。
   *    也就是说，计划碰巧一致时不排序也不会死锁——但那是运气，
   *    计划一变（统计信息更新、索引增减、读写分离的副本）就可能不再一致。
   *    逐条加锁把「全局一致的加锁顺序」变成**实现的确定性保证**，
   *    不依赖任何计划假设。N 个 SKU 就是 N 条语句，对下单这种低频路径完全够用。
   *    （这条是 2026-10-24 实施时实测修正的：原设计的 `IN (...) + ORDER BY id`
   *    在实测里去掉 ORDER BY 也不会死锁，用例抓不到——护栏 5 必须是可测的。）
   *
   * 2. **手写 tenantId 条件**——`$queryRaw` 绕过 Prisma 扩展，
   *    扩展的隔离保护在这里不生效。
   */
  private async lockSkus(tx: PrismaTransaction, tenantId: string, skuIds: string[]) {
    const sorted = [...skuIds].sort();
    const locked: LockedSku[] = [];
    for (const skuId of sorted) {
      const rows = await tx.$queryRaw<LockedSku[]>`
        SELECT id, "productId", price, stock, "stockVersion", status, "deletedAt"
        FROM skus
        WHERE id = ${skuId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      locked.push(...rows);
    }
    return locked;
  }
```

**预占的事务**：

```typescript
  async reserve(tenantId: string, orderId: string, items: Array<{ skuId: string; quantity: number }>) {
    return this.prisma.$transaction(async (tx) => {
      // 1. 按 id 排序加锁并读出当前值
      const locked = await this.lockSkus(tx, tenantId, items.map((i) => i.skuId));

      // 2. 校验：每个 SKU 都要在锁到的结果里（数量对不上说明 id 不存在或跨租户）
      //    状态 ACTIVE、未软删、库存足够
      // 3. 扣库存（带 stockVersion 条件，受影响行数为 0 说明被管理端改过，回滚重试）
      // 4. 记 RESERVE 流水
      // 5. 记 DEDUCT？—— 不，扣减是支付成功时才做
    });
  }
```

**流水语义**（设计文档 §5.2）：

| 阶段 | `quantity` | `stockBefore → stockAfter` |
|------|------------|--------------------------|
| `RESERVE` | `-qty` | `stock -= qty` |
| `DEDUCT` | `-qty` | **不变** |
| `RELEASE` | `+qty` | `stock += qty` |

### 3.2b 三个必须知道的实现细节

1. **交互式事务要显式设超时。** Prisma 的 `$transaction(async (tx) => ...)`
   默认 `maxWait: 5000` / `timeout: 5000`（5 秒）。行锁等待会占掉这个预算——
   两个订单抢同一 SKU 时，后一个要等前一个提交。**要设成 10 秒左右**，
   否则并发用例会因超时失败，症状看起来像「行锁实现有 bug」。

2. **`$queryRaw` 返回的列名是数据库里的原样。**
   本项目的 `@@map` 只映射表名、**字段没有 `@map`**——建表时列名就是
   camelCase 且加了双引号。所以 `SELECT id, "productId", price, stock, status, "deletedAt"`
   返回的对象键就是 `id` / `productId` / `price` / `stock` / `status` / `deletedAt`。
   - `"productId"` 与 `"deletedAt"` **必须加双引号**，否则 PostgreSQL 会把
     驼峰折叠成小写，报 `column "productid" does not exist`
   - `price` / `stock` / `status` 都是小写，不加引号也能匹配

3. **扣库存走 `updateMany`（带 `stockVersion` 条件）。**
   行锁负责「并发下单不丢更新」，`stockVersion` 负责「管理端的人工调整
   不与下单互相覆盖」——两者都要（设计 §5.1）。受影响行数为 0 说明
   期间有人改过库存，整个事务回滚并让调用方重试。
   `updateMany` 走 Prisma 扩展，**会自动附加 tenantId 条件** ✓。

### 3.2c 「未冲抵预占量」的汇总公式（**实施时踩过，公式在这里定死**）

释放与扣减都要校验「本次操作的量不超过该订单该 SKU 尚未被冲抵的预占量」。
要算这个量，先看三种流水的 `quantity` 符号：

| 类型 | quantity | 语义 | 对「未冲抵预占量」的影响 |
|------|----------|------|----------------------|
| `RESERVE` | `-qty` | 占用预占 | **减少** |
| `RELEASE` | `+qty` | 归还预占 | **增加** |
| `DEDUCT` | `-qty` | 确认售出，消耗预占 | **减少** |

⚠️ **`RESERVE` 与 `DEDUCT` 的 quantity 同为负数，但语义不同**——
所以**不能**把三者的 quantity 一股脑加起来取负。那样 `DEDUCT` 会被当成
「增加预占」，售出后的货又能被释放一次（凭空造货）。

**正确公式：`-Σ(RESERVE) - Σ(RELEASE) + Σ(DEDUCT)`**

| 组合 | 未冲抵量 |
|------|---------|
| 只有 RESERVE(-5) | 5 ✓ |
| RESERVE(-5) + RELEASE(+5) | 0 ✓ |
| RESERVE(-5) + DEDUCT(-5) | 0 ✓ |
| RESERVE(-5) + RELEASE(+5) + DEDUCT(-5) | -5（超额，应被拒）|

> **DEDUCT 与 RELEASE 是互斥的两条路径**：支付成功后订单就成交了，
> 不会再走超时释放。所以测试里它们必须**分属两个订单**——
> 同一个订单先扣减再释放，在业务上根本不成立。

- [ ] **Step 3.3: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/inventory-reserve.e2e-spec.ts
```

- [ ] **Step 3.4: 提交**

```bash
git add api/
git commit -m "feat(api): 库存预占（行锁 + 流水三态）

预占走 SELECT ... FOR UPDATE 行锁，不用阶段 2 的乐观锁——乐观锁适合低频的
人工调整（冲突了返回 409 让商家重试），但下单是高频操作、两个订单撞同一个
SKU 是常态，乐观锁会大量 409。行锁串行化同一 SKU 的扣减，不需要重试循环。

行锁 SQL 两条硬性要求：
- 按 id 排序——否则两个订单含两个 SKU 且顺序相反时会死锁（R8）
- 手写 tenantId 条件——\$queryRaw 绕过 Prisma 扩展，隔离保护在这里不生效

流水的两个语义别混：quantity 是业务量与方向，stockBefore/After 是实际库存。
DEDUCT 的 quantity=-qty 但库存不变（预占时已扣）。销量一律看 order_items，
不要从流水统计——流水里 RESERVE 与 DEDUCT 都是负数会重复计数（R12）。
"
```

---

## Task 4：订单与状态机

**Files:**
- Create: `api/src/modules/order/order.service.ts`
- Create: `api/src/modules/order/order.controller.ts`
- Create: `api/src/modules/order/merchant-order.controller.ts`
- Create: `api/src/modules/order/order-status.ts`
- Create: `api/src/modules/order/dto/*.dto.ts`
- Test: `api/test/order.e2e-spec.ts`

> **为什么两个 controller**：消费者侧与商家侧的**鉴权方式不同**——
> 消费者侧用 `OptionalJwtAuthGuard`（游客或登录都行，Task 2 建的），
> 商家侧用 `JwtAuthGuard` + `@Roles(UserRole.MERCHANT_OWNER)`。
> 混在一个 controller 里就得逐个方法换守卫，容易漏。
>
> 商家侧的 `POST /api/v1/orders/:orderNo/ship`（发货，填快递单号）
> **归 order 模块**——它不涉及支付能力，只是订单状态流转。

### 4.1 先写失败测试

护栏对应：**护栏 6 下单幂等键**、**护栏 7 跨租户下单**、
**护栏 8 金额不可篡改**、**护栏 15 状态机拒绝非法流转**
（编号体系见计划 §0.6）。

```typescript
  it('重复提交同一个幂等键返回同一个订单', async () => {
    // 同一 idempotencyKey 下两次下单 → orderNo 相同、订单只有一条、
    // 库存只减一次
  });

  it('金额由服务端算：请求体里的 unitPrice 被拒绝', async () => {
    // 请求里带 unitPrice → forbidNonWhitelisted → 400
    // 且订单里的 unitPrice 等于 SKU 的真实价格
  });

  it('跨租户下单被拒：把 A 店的 SKU 放进 B 店的订单', async () => { /* ... */ });

  it('状态机拒绝非法流转：COMPLETED 不能转回 PAID', async () => { /* ... */ });

  it('取消订单释放预占：库存加回、记 RELEASE 流水', async () => { /* ... */ });

  it('已支付的订单不能取消', async () => { /* ... */ });

  it('流转到 REFUNDED 不碰库存：货已发出，退的是钱不是库存', async () => {
    // 护栏 17 的**状态流转部分**。退款后 stock 必须与退款前**完全相同**，
    // 且**不得**出现 RELEASE 类型的流水——退货入库是另一套流程。
    // 这条要在库里查 stock 与流水类型，不能只看响应。
    //
    // ⚠️ 这里只测 order 模块的**状态流转**。完整的退款（调 provider.refund()
    // + HTTP 端点）在 Task 5 测——见那一步的说明。
  });
```

> **模块依赖方向：`payment` → `order`（单向）。**
>
> 这个方向是刻意定的，不能反过来：
> - `payment` 模块的 webhook 消费端要把订单转 `PAID` → 需要 order 模块
> - `payment` 模块的退款端点要调 `provider.refund()` 并转 `REFUNDED`
>   → 需要 order 模块
> - `order` 模块**不需要** payment 模块：下单只锁 SKU、只算金额，
>   发起支付是「建支付单 + 调 createPayment」，那件事放在 payment 模块
>   由 order 模块**反向调用**是不必要的耦合
>
> 若把退款端点放进 order 模块，order 就要 import payment，
> 而 payment 又要 import order（流转订单）→ **循环依赖**。
> 所以：**退款端点归 payment 模块，`order` 只提供状态流转能力。**

- [ ] **Step 4.2: 写状态机**

`order-status.ts`——**状态流转必须集中在一张表里**，不能散落在各个 controller：

```typescript
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED', 'CLOSED'],
  PAID: ['SHIPPED', 'REFUNDED'],
  SHIPPED: ['COMPLETED', 'REFUNDED'],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
  CLOSED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
```

- [ ] **Step 4.3: 写条件更新**

**这是 R5（并发超卖）的核心。** 任何状态流转都用条件更新，
不用「先查后改」：

```typescript
  /**
   * 条件更新订单状态。
   *
   * ⚠️ 绝不能「先 findFirst 查状态，再 update」——两个并发事务会都读到
   * 同一个旧状态然后都往下走。必须把状态放进 where 里，靠受影响行数
   * 判定谁赢了。这是阶段 3 最关键的并发正确性。
   */
  async transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) {
      throw new ConflictException(`订单状态不能从 ${from} 变为 ${to}`);
    }
    const affected = await this.prisma.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to, ...extra },
    });
    // count === 0 → 期间已被别人改过，本次不生效
    return affected.count === 1;
  }
```

- [ ] **Step 4.4: 写下单**

```typescript
  async placeOrder(input: PlaceOrderInput) {
    const { tenantId, customerId, idempotencyKey, addressId, items, remark } = input;

    // 1. 幂等键命中 → 直接返回已有订单（不重新扣库存）
    if (idempotencyKey) {
      const existing = await this.prisma.order.findFirst({
        where: { tenantId, idempotencyKey },
      });
      if (existing) return existing;
    }

    // 2. 地址：校验 customerId 属于当前租户，且不是软删的
    // 3. 取地址快照（receiver/phone/province/city/district/detail）

    // 4. 事务：
    //    a. 锁 SKU（按 id 排序）、校验可售/上架/库存
    //    b. 建订单 + 订单项（快照商品名与规格）
    //    c. 扣库存 + 记 RESERVE 流水
    //    d. 清购物车里已下单的条目
    // 5. 投超时释放的 delayed job（见 Task 6）
    // 6. 返回订单
  }
```

> **订单项的快照**：`productName` 与 `skuSnapshot` 在下单时写入，
> 商家后来改名改价都不影响已有订单。
>
> **`unitPrice` 从锁住的 SKU 读**，请求体里不接受价格字段。

### 4.4b 下单的五个实现细节（**实施时必须踩准**）

1. **幂等键的并发处理不能只靠「先查后插」。**
   两个并发请求带**同一个** `idempotencyKey`：都会查到「不存在」，
   然后都去插入 → 一个撞 `orders_tenant_idempotency_uniq` 的 P2002。
   正确做法：
   - **事务外**先查一次（快路径，命中直接返回已有订单，不重新扣库存）
   - 未命中 → 进事务创建
   - 事务里撞 P2002 → 事务回滚（**P2002 会让 PostgreSQL 事务进入 aborted 状态，
     不能在同一个事务里继续查**）→ **在事务外**重查并返回那笔已有订单

   > ⚠️ 「在同一个事务里 catch P2002 然后查」是错的：PostgreSQL 里唯一约束
   > 冲突会让整个事务变成 aborted，后续查询全部报
   > `current transaction is aborted`。P2002 必须在**事务外**处理。

2. **订单号生成**：`日期 + 10 位随机`，如 `20261024-K3M9X2Q4TZ`，
   全小写字母数字。**必须处理唯一冲突**——并发下单可能生成相同的号
   （概率极低但非零），捕获 P2002 后**重试一次**即可，不要把 500 抛给用户。
   订单号会出现在支付回调、商家后台搜索框里，**不要含租户信息**。

3. **`tenantId` 从上下文读，不要当参数传。**
   与 Task 3 的 `OrderInventoryService` 保持一致（用 `getTenantContext()`），
   也与 `InventoryService` / `AddressService` 的既有写法一致。

4. **`skuSnapshot` 的内容**：形如
   `{ specs: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] }`
   ——下单时刻的规格组合。商家后来改了规格值也不影响已有订单。
   取规格值要**显式写关联过滤**（扩展的软删过滤只作用于顶层）。

5. **游客下单的已知限制**（设计 §十三 遗留项 8）：`orders.customerId` 为空时，
   消费者侧按 `customerId` 查订单**查不到**——游客下完单只能靠下单响应里的
   订单号继续支付。**本阶段不实现「按联系方式查最近订单」**，
   但要在代码注释里写清楚这是已知限制，别让后来的人以为是漏了。

   > 支付不受影响：`POST /api/v1/orders/:orderNo/pay` 是凭订单号操作的，
   > 订单号全局唯一。

- [ ] **Step 4.5: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/order.e2e-spec.ts
```

- [ ] **Step 4.6: 提交**

```bash
git add api/
git commit -m "feat(api): 订单与状态机

状态流转集中在一张转移表里，不散落在各个 controller——散落的话迟早
会有某个入口漏校验。

所有状态流转用条件更新（updateMany where 带 status），靠受影响行数
判定并发赢家，不用「先查后改」。这是阶段 3 最关键的并发正确性：
支付回调与超时释放并发时，两者都读到 PENDING_PAYMENT 就会都往下走，
结果是已支付但库存被还回去（超卖，R5）。

下单支持幂等键：同一键重复提交返回同一个订单，不新建、不重复扣库存（R7）。
订单金额只从 SKU 读，请求体里的价格字段被 forbidNonWhitelisted 拒掉（R9）。
"
```

---

## Task 5：支付抽象、假网关与 webhook

**Files:**
- Create: `api/src/modules/payment/payment-provider.interface.ts`
- Create: `api/src/modules/payment/fake-payment.provider.ts`
- Create: `api/src/modules/payment/payment.service.ts`
- Create: `api/src/modules/payment/payment.controller.ts`
- Create: `api/src/modules/payment/webhook.controller.ts`
- Create: `api/src/modules/payment/webhook.worker.ts`
- Create: `api/src/modules/payment/fake-payment.controller.ts`
- Create: `api/src/modules/payment/payment.module.ts`
- Create: `api/src/modules/payment/dto/*.dto.ts`
- Modify: `api/src/common/config/assert-secure-config.ts`
- Test: `api/test/payment.e2e-spec.ts`

> **本 Task 要新增两个端点**（设计文档 §十 的接口清单里漏了，但验收要用）：
>
> | 方法 | 路径 | 归属 | 说明 |
> |------|------|------|------|
> | POST | `/api/v1/orders/:orderNo/pay` | 消费者 | 发起支付：建支付单 + 调 `provider.createPayment()`，返回支付页面 URL |
> | POST | `/api/v1/orders/:orderNo/refund` | 商家 | 整单退款：调 `provider.refund()` + 订单转 `REFUNDED`，**不回补库存** |
>
> 两个端点都**放在 payment 模块**——它俩都要用 payment 模块的能力
> （`createPayment` / `refund`），而 order 模块不依赖 payment 模块
> （依赖方向是单向的 `payment → order`，理由见 Task 4）。

### 5.1 先写失败测试

护栏对应：**R1 先验签后落库**、**R2 支付幂等索引**、**R3 假网关生产禁用**、
**R13 金额核对**、**R14 不采信 tenantId**。

```typescript
  it('未验签的 webhook 不会落库：伪造 eventId 占位后再来真的会被忽略', async () => {
    // 这一条直接验证 R1：
    // 先发一个签名错误的请求（eventId=X）→ 库里不应该有这行
    // 再发一个签名正确、eventId=X 的请求 → 库里应该只有一行
    // 若实现是「先落库再验签」，第一条就会占位，真实的那条被忽略
  });

  it('同一事件重复到达只处理一次', async () => { /* ... */ });

  it('支付金额与订单金额不一致时拒绝流转并告警', async () => {
    // 回调金额 1 分，订单 100 元 → 订单不转 PAID
  });

  it('webhook 不采信请求体里的 tenantId', async () => { /* ... */ });

  it('生产配置下假支付网关不可用', async () => {
    // FAKE_PAYMENT_ENABLED=true + NODE_ENV=production → 启动被拒绝
  });

  it('同一笔渠道交易不会落成两条支付单', async () => {
    // R2。两条不同 eventId 的回调带着同一个 providerTxnId →
    // payments 表里只能有一行。要断言**行数**，不能只看响应状态码。
  });

  it('支付成功：订单转 PAID、流水记 DEDUCT、库存不再变', async () => {
    // R5 的支付侧 + 流水双语义：
    // 订单 PENDING_PAYMENT → PAID（条件更新）
    // 流水多一条 DEDUCT，quantity = -qty 但 stockBefore == stockAfter（库存不变）
  });

  it('退款不回补库存：货已发出，退的是钱不是库存', async () => {
    // 护栏 17 的完整版（Task 4 只测了状态流转那半）。
    // 退款后 stock 必须与退款前**完全相同**，
    // 且**不得**出现 RELEASE 类型的流水。要查库，不能只看响应。
  });
```

- [ ] **Step 2: 写支付抽象**

`payment-provider.interface.ts`：

```typescript
export interface CreatePaymentInput {
  orderId: string;
  orderNo: string;
  amount: number;
  subject: string;
}

export interface CreatePaymentResult {
  providerTxnId: string;
  /** 渠道相关的支付数据（微信是 code_url、支付宝是跳转 URL、假网关是本地页面） */
  payload: Record<string, unknown>;
  expiresAt: Date;
}

export interface NormalizedWebhookEvent {
  provider: string;
  channel: string;
  eventId: string;
  providerTxnId: string;
  orderNo: string;
  amount: number;
  success: boolean;
}

export interface PaymentProvider {
  readonly channel: string;
  readonly provider: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  queryPayment(providerTxnId: string): Promise<{ status: string }>;
  refund(paymentId: string, amount: number, reason: string): Promise<{ status: string }>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): NormalizedWebhookEvent;
}
```

`fake-payment.provider.ts`：本地假网关。

> **假网关的支付页面无需登录**——知道 paymentId 就能把订单付掉。
> 所以它受 `FAKE_PAYMENT_ENABLED` 开关控制，且默认关闭。
> 它的 `parseWebhook` 用一个共享密钥做「验签」。

- [ ] **Step 2b: 写三个端点**

**① 发起支付**（`payment.controller.ts`，消费者侧）：

```typescript
/**
 * 发起支付。
 *
 * ⚠️ 金额**只从订单读**，请求体不接受任何金额字段。
 * ⚠️ 同一个订单同一渠道只能有一笔支付单——`payments` 表的
 * `(orderId, channel)` 唯一索引兜底，重复发起返回已有的那笔。
 */
@Post('orders/:orderNo/pay')
async pay(@Param('orderNo') orderNo: string) {
  // 1. 查订单（租户作用域，扩展自动过滤）
  // 2. 订单状态必须是 PENDING_PAYMENT
  // 3. 建支付单（provider + channel + amount，amount 取自订单）
  // 4. 调 provider.createPayment() → 拿到支付页面 URL
  // 5. 把 payload 存进支付单的 rawResponse，返回给前端
}
```

**② 退款**（`payment.controller.ts`，商家侧，要 `@Roles()` 守卫）：

```typescript
/**
 * 整单退款。
 *
 * ⚠️ **退款不回补库存**——货已经发出去了，退的是钱不是库存。
 * 「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
 * 这个取舍要在商家后台的文案里说明。
 */
@Post('orders/:orderNo/refund')
async refund(@Param('orderNo') orderNo: string, @Body() dto: RefundDto) {
  // 1. 查支付单（该订单该渠道的那笔，必须是 SUCCESS）
  // 2. 调 provider.refund(paymentId, amount, reason)
  // 3. 支付单转 REFUNDED
  // 4. 订单转 REFUNDED（条件更新，走 order 模块的 transition）
  // 5. **不碰库存、不记 RELEASE 流水**
}
```

**③ 假网关的支付页面**（`fake-payment.controller.ts`）：

```typescript
/**
 * 假网关的支付页面。
 *
 * ⚠️ **未开启 FAKE_PAYMENT_ENABLED 时这个端点根本不存在**（404）。
 * ⚠️ 页面无需登录——知道 paymentId 就能付掉订单，所以受开关控制。
 */
@Get('pay/fake/:paymentId')
async page(@Param('paymentId') paymentId: string, @Res() res: Response) {
  // 1. 开关没开 → 抛 404
  // 2. 查支付单 → 渲染一个极简 HTML（订单号、金额、两个按钮）
  //    「确认支付」→ 置支付单 SUCCESS 并主动调用 webhook 处理逻辑
  //    「模拟支付失败」→ 走失败分支
}
```

> **假网关为什么直接调 webhook 处理逻辑而不是发 HTTP 请求**：
> 「服务调自己」会引入自我依赖，在容器编排里还要处理网络地址问题。
> 直接调用同一段处理逻辑，既真实（幂等与状态机都被走到）又不脆弱。

- [ ] **Step 3: 写 webhook 端点**

`webhook.controller.ts`：

```typescript
/**
 * 支付渠道回调。
 *
 * ⚠️ 这个端点**不挂 JWT**（渠道回调没有登录态），也不挂租户上下文
 * （渠道回调不带子域名）。所以：
 * 1. **必须验签**，且**验签通过才能落库**——否则攻击者能抢先用
 *    eventId 占位，让真实回调被当重复事件忽略（R1）。
 * 2. **租户从订单反查**，绝不采信请求体里的 tenantId（R14）。
 * 3. 只按订单 id 操作，不接受任何指向别的租户的参数。
 */
@Post('webhooks/payment/:channel')
async handle(@Param('channel') channel: string, @Req() request: Request) {
  const raw = Buffer.from(await request.arrayBuffer());
  const provider = this.providers.get(channel);
  if (!provider) throw new NotFoundException('未知的支付渠道');

  // 1. 验签（内部会抛 401）
  const event = provider.parseWebhook(raw, request.headers as Record<string, string>);

  // 2. 金额核对（R13）——不核对就流转，等于「付 1 分钱买 100 元」
  // 3. 幂等落库：插入事件行，冲突则说明重复投递，直接返回成功
  // 4. 投递到 payment-webhook 队列异步消费
}
```

**幂等的三道防线**（设计文档 §6.3）：

1. `payment_webhook_events` 的 `(provider, eventId)` 唯一索引 —— 但**必须在验签之后**才尝试插入
2. `payments` 的 `(provider, providerTxnId)` 唯一索引
3. 状态流转的条件更新（Task 4 的 `transition`）

> ⚠️ **webhook 端点与假网关页面必须挂 `@Skip()`**：
> 它们**没有子域名**（渠道回调按路径区分渠道，不带店铺子域名），
> 租户上下文拦截器在解析不出店铺时会直接抛 404。
> 漏掉这个标记的症状就是「webhook 全 404」。
>
> ⚠️ **`main.ts` 必须开 `rawBody: true`**：
> 验签需要**请求的原始字节**，而默认的 JSON parser 会消费掉请求流，
> 那时 `request.rawBody` 是 undefined，验签必然失败。
> e2e 里也要开（`NestFactory.create(AppModule, { rawBody: true })`）。

- [ ] **Step 3b: 写 webhook 消费端（worker）**

**这一步原计划漏了**，但没有它 webhook 就只是「记录了事件」而订单永不流转。
`webhook.worker.ts`：

```typescript
/**
 * 支付回调的异步消费端。
 *
 * ⚠️ **必须重建租户上下文**：`AsyncLocalStorage` 的上下文只存在于当前
 * 异步调用链内，队列消费者是跨进程边界的——不显式重建的话，
 * 查租户作用域模型（Order / Payment）会抛 `TenantScopeError`。
 *
 * ⚠️ 任务里的 tenantId **必须来自可信源**（下单时由后端签发），
 * 绝不能取自客户端提交的内容——否则「重建上下文」本身就成了越权通道。
 */
@Processor(PAYMENT_WEBHOOK_QUEUE)
export class WebhookWorker extends WorkerHost {
  async process(job: Job<{ tenantId: string; orderId: string; eventId: string }>) {
    return runForTenant(job.data.tenantId, async () => {
      // ⚠️ 第 3~5 步必须在**同一个事务**里：
      // 订单转 PAID 与记 DEDUCT 流水分属两个事务的话，
      // 会出现「订单已支付但流水没记」的账目缺口。
      await this.prisma.$transaction(async (tx) => {
        // 1. 幂等落库：插入事件行。冲突 → 重复投递，直接返回
        // 2. 查订单 → 核对金额（R13）→ 不等就拒绝流转并告警
        // 3. 支付单置 SUCCESS（条件更新，避免重复处理）
        // 4. 订单 PENDING_PAYMENT → PAID（**条件更新**，R5）
        //    用 order 模块的 `transitionInTx(tx, ...)`——
        //    它是「在调用方事务内做条件更新」的版本，
        //    状态流转与库存流水才能同生共死
        // 5. 赢了才记 DEDUCT 流水（quantity=-qty，**库存不变**）
        //    用 inventory 模块的 `deductInTx(tx, orderId, items)`
      });
    });
  }
}
```

> **第 4 步是 R5 的另一半**，不能只做超时释放那一侧：
> 支付回调与超时释放都用 `where: { status: 'PENDING_PAYMENT' }` 的条件更新，
> 数据库保证只有一方能赢。少了这一侧，超时释放与支付并发时仍会超卖。
>
> ⚠️ **`@nestjs/bullmq` v12 没有 `@Process` 装饰器**（2026-10-24 实测修正）：
> 只有 `WorkerHost` 基类 + `process(job)` 方法，按 `job.name` 分派。
> 照抄旧版的 `@Process('payment')` 会编译不过。Task 6 的 worker 同理。
>
> ⚠️ **事件行只在 controller 插一次**（幂等闸），worker **不再插**——
> 两处都插必然冲突，worker 会永远处理不下去。分工是：
> - **controller**：验签 → 落事件行（唯一索引挡住重复投递）→ 入队
> - **worker**：只做业务流转（查订单、核对金额、置支付单 SUCCESS、转订单状态、记流水）
>
> ⚠️ **worker 的租户从队列任务里取，订单在「该租户作用域内」查**——
> 这样队列里的 tenantId 才是有承重的，R14（不采信请求体里的 tenantId）
> 也才真正可测。把订单查询放到平台作用域会让 R14 的变异打不中。
>
> **第 5 步的 DEDUCT 流水**：`quantity = -qty` 但 `stockBefore == stockAfter`
> ——预占时库存已经扣过了，这里只是把「预占」转成「已售」（设计 §5.2）。

- [ ] **Step 4: 假网关的生产禁用**

`api/src/common/config/assert-secure-config.ts` 加一条：

```typescript
  // 假支付网关在生产环境开启 = 任何人知道 paymentId 就能免费下单（R3）
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FAKE_PAYMENT_ENABLED === 'true'
  ) {
    throw new Error(
      '生产环境禁止启用 FAKE_PAYMENT_ENABLED：假支付网关无需登录即可支付订单',
    );
  }
```

- [ ] **Step 5: 跑测试**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payment.e2e-spec.ts
```

- [ ] **Step 6: 提交**

```bash
git add api/
git commit -m "feat(api): 支付抽象、本地假网关与 webhook

PaymentProvider 接口按真实渠道设计（createPayment/queryPayment/refund/
parseWebhook），本阶段接一个本地假网关——真沙箱要商户资质与密钥，
本机拿不到。真实适配器是「填密钥」的工作，不是「改架构」的工作。

webhook 端点的三处要害：
- **验签通过才落库**（R1）。反过来做的话，攻击者能抢先用 eventId 占位，
  真实支付回调被当重复事件忽略——钱付了订单永不流转。
- **金额先核对再流转**（R13）。不核对等于「付 1 分钱买 100 元商品」。
- **租户从订单反查**，绝不采信请求体里的 tenantId（R14）。

消费端用条件更新把订单转 PAID（R5 的支付侧），赢了才记 DEDUCT 流水
（quantity=-qty 但库存不变——预占时已扣）。队列消费要 runForTenant 重建
租户上下文，AsyncLocalStorage 的上下文不跨进程边界。

补三个端点：发起支付、整单退款、假网关支付页面。退款**不回补库存**——
货已发出，退的是钱不是库存。

模块依赖方向是单向的 payment → order：webhook 消费端与退款端点都要
流转订单，order 模块不需要 payment 模块的能力。

假支付网关默认关闭，且生产环境开启会拒绝启动（R3）——它无需登录，
知道 paymentId 就能免费下单。
"
```

---

## Task 6：支付超时释放

**Files:**
- Create: `api/src/modules/order/order-timeout.service.ts`
- Create: `api/src/modules/order/order-timeout.worker.ts`
- Test: `api/test/order-timeout.e2e-spec.ts`

### 6.1 先写失败测试

护栏对应：**R5 条件更新**、**R15 jobId 去重**。

```typescript
  it('超时未支付：释放预占、订单转 CLOSED', async () => { /* ... */ });

  it('已支付的订单超时释放时不动库存', async () => {
    // 直接构造「订单已 PAID + 超时任务触发」→ 库存不变、状态不变（R5）
  });

  it('超时任务与支付回调并发：只有一个生效', async () => {
    // 两个并发 → 库存不会既加回又被扣（R5）
  });

  it('同一个订单只排一个超时任务', async () => {
    // jobId 相同 → 队列里只有一个（护栏 18、R15）
  });

  it('消费端幂等：同一个任务被重复投递也只生效一次', async () => {
    // 护栏 18。队列的 jobId 去重**不等于**消费端幂等——
    // 任务可能在消费途中进程崩溃，重启后被重新投递。
    // 重复投递时库存不能被加回两次。
  });
```

- [ ] **Step 2: 写 worker**

```typescript
/**
 * 支付超时释放。
 *
 * ⚠️ 释放前**不能**「先查状态再改」——必须用条件更新
 * （updateMany where 带 status='PENDING_PAYMENT'），
 * 靠受影响行数判定谁赢了。理由见 Task 4 的 transition()。
 *
 * ⚠️ 队列的 delayed job **不保证准时**，所以不能依赖它的准时性。
 * 订单自己的 payExpiresAt 也要判。
 */
@Processor(PAYMENT_TIMEOUT_QUEUE)
export class OrderTimeoutWorker extends WorkerHost {
  async process(job: Job<{ tenantId: string; orderId: string }>) {
    // ⚠️ 必须重建租户上下文：队列消费是跨进程边界的，
    //    AsyncLocalStorage 的上下文不跟着走。不重建的话查 Order/Sku
    //    会抛 TenantScopeError。
    return runForTenant(job.data.tenantId, async () => {
      // ⚠️ **第 1 步与第 3 步必须在同一个事务里**。
      //
      // 分成两个事务的话：订单先转成 CLOSED，释放预占再失败
      // （预占量对不上、锁超时）——而超时释放任务看到状态不是
      // PENDING_PAYMENT 也不会再管它，那批库存就**永久卡在预占里**，
      // 再也回不到可售库存。
      //
      // 用 order 模块的两个「可在调用方事务内执行」的方法：
      // - `transitionInTx(tx, orderId, PENDING_PAYMENT, CLOSED, {...})`
      // - `releaseReservationInTx(tx, orderId)`
      await this.prisma.$transaction(async (tx) => {
        // 1. 条件更新订单 PENDING_PAYMENT → CLOSED
        // 2. 返回 false → 已支付或已取消 → 什么都不做（事务回滚）
        // 3. 赢了才释放预占：stock += qty、记 RELEASE 流水
      });
    });
  }
}
```

> **`runForTenant()` 是 `api/src/common/tenant/tenant-context.ts` 里现成的**，
> 那个文件的注释已经点明用途：「跨越进程边界的地方（队列消费者、定时任务、
> 消息处理器）没有上下文可用，必须显式重建，用 `runForTenant()`」。
> 别自己再写一套。
>
> ⚠️ **任务里的 `tenantId` 必须来自可信源**——它由下单时后端签发，
> 绝不能取自客户端提交的内容。否则「重建上下文」本身就成了越权通道。
>
> ⚠️ **`@nestjs/bullmq` v12 没有 `@Process` 装饰器**——worker 继承
> `WorkerHost` 并实现 `process(job)`，按 `job.name` 分派。
>
> ⚠️ **队列的 delayed job 不保证准时**，所以不能依赖它的准时性：
> 订单自己的 `payExpiresAt` 也要判。

- [ ] **Step 3: 投任务**

下单成功后（Task 4 的第 5 步）：

```typescript
await this.queue.addDelayed(
  PAYMENT_TIMEOUT_QUEUE,
  'release',
  { tenantId, orderId },
  PAYMENT_TIMEOUT_MS,       // 15 分钟
  `timeout-${orderId}`,     // jobId 去重：同一订单只排一个
);
// ⚠️ **jobId 不能含冒号**：BullMQ v6 抛 `Custom Id cannot contain :`。
//    只有恰好三段且每段是 UUID 的形式被放行，所以用连字符。
```

- [ ] **Step 4: 跑测试并提交**

```bash
git add api/
git commit -m "feat(api): 支付超时释放预占

BullMQ delayed job 触发后，**用条件更新**把订单从 PENDING_PAYMENT 改成
CLOSED，靠受影响行数判定谁赢了——不这么做的话，支付回调与超时释放并发时
两者都读到 PENDING_PAYMENT，结果是已支付但库存被还回去（超卖，R5）。

jobId 用 timeout-{orderId}，同一订单只排一个任务。
（⚠️ **jobId 不能含冒号**：BullMQ v6 抛 `Custom Id cannot contain :`。）
但队列去重不等于消费端幂等：任务可能在消费途中崩溃重启后被重投，
消费端仍要靠数据库的唯一索引兜底。
"
```

---

## Task 7：前端——消费者购物车与商家订单页

**Files:**
- Create: `storefront/src/app/(shop)/cart/page.tsx`
- Create: `storefront/src/app/(shop)/checkout/page.tsx`
- Create: `storefront/src/app/(shop)/orders/page.tsx`
- Create: `storefront/src/app/(shop)/orders/[orderNo]/page.tsx`
- Create: `storefront/src/lib/cart.ts`
- Create: `merchant-admin/src/app/(dashboard)/orders/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/orders/[orderNo]/page.tsx`
- Create: `merchant-admin/src/components/order/order-list.tsx`
- Create: `merchant-admin/src/app/api/orders/**/route.ts`（中转路由）

> **storefront 不需要单独的假网关支付页**——假网关的支付页面由 api 服务提供
> （`GET /api/v1/pay/fake/:paymentId`），订单详情页的「去支付」按钮直接跳过去。
> 这与真实渠道的形态一致（微信是跳 `code_url`、支付宝是跳支付 URL），
> 前端不需要为假网关写特例。

### 7.1 约束（阶段 2b 踩过的坑）

1. **Server Component 不能往客户端组件传函数**——`tsc` 与 `next build` 都通过，
   只有真正渲染才 500。逻辑内嵌在 `'use client'` 组件里。
2. **中转路由必须白名单重建请求体**（阶段 2b 安全审查确立的约定）。
3. **公开路径要带 `x-tenant-subdomain`**——`storefront/src/lib/api-client.ts` 的
   `apiFetch` 已有 `subdomain` 选项，直接用。
4. **前端断言要具体**：单测只断言状态码极易恒真。

### 7.2 storefront 的购物车与结算

**游客购物车**要在服务端用 `cookies()` 读 `cart_token`——Next.js 15 里
`cookies()` 是异步的。

**结算页的关键**：

- **进入结算页时**生成 `idempotencyKey = crypto.randomUUID()`，
  **放进 state**，提交失败重试时**复用同一个 key**（这才是幂等的意义）
- 成功跳转订单详情页

> **幂等键不能在「点提交」时才生成**——用户点一次、网络超时、再点一次，
> 如果每次都新生成 key，就成了两个订单。必须在「进入结算页」时生成并持有。
> （原计划里这两句是矛盾的：一处写「提交时生成」，另一处写「必须在进入
> 结算页时生成并持有」。以**后者**为准。）

### 7.3 商家后台的订单页

- 订单列表：按状态、时间筛选 + 分页
- 订单详情：订单项快照、收货信息、支付信息、**发货表单**（填快递单号）
- 发货走 `POST /api/v1/orders/:orderNo/ship`
- 退款走 `POST /api/v1/orders/:orderNo/refund`，**按钮旁要有一行说明**：
  「退款只退钱，库存不会自动加回——退货入库是另一套流程」
  （设计 §7.1 的取舍，商家看到「库存在退款后没变」会以为系统坏了）

### 7.4 storefront 的订单页

- 订单列表：按状态分组
- 订单详情：**「去支付」按钮**（调 `POST /api/v1/orders/:orderNo/pay`，
  拿回支付页面 URL 后跳转）、**「取消订单」按钮**、
  **「确认收货」按钮**（`POST /api/v1/orders/:orderNo/confirm`）

### 7.5 前端测试

用阶段 2b 建立的 Vitest 基建：

- `storefront/test/lib/cart.test.ts` —— 购物车金额计算等纯函数
- `merchant-admin/test/app/api/order-whitelist.test.ts` —— 中转路由的请求体白名单

**中转路由的白名单测试照 `merchant-admin/test/app/api/query-whitelist.test.ts` 的写法**
（阶段 2b 建的 harness 直接复用）。

- [ ] **Step 7.6: 跑检查**

```bash
cd storefront && npm test && npm run lint && npm run build
cd merchant-admin && npm test && npm run lint && npm run build
cd api && npm test && npm run test:e2e
```

- [ ] **Step 7.7: 提交**

```bash
git add storefront/ merchant-admin/
git commit -m "feat: 消费者购物车结算与商家订单页

结算页的幂等键在**进入页面时**生成并持有，提交失败重试时复用同一个——
若每次提交都新生成，用户点一次网络超时再点一次就成了两个订单。

商家后台的订单页含发货表单（填快递单号），走中转路由。
中转路由照阶段 2b 确立的约定做请求体白名单重建。
"
```

---

## Task 8：阶段 3 验收

**Files:**
- Create: `docs/superpowers/plans/2026-10-24-plan-03-acceptance.md`
- Modify: `README.md`

### 8.1 浏览器手测

**环境注意（阶段 2b 栽过两次）**：

- 3001–3003 端口是**旧构建的容器**，不含阶段 3 的功能。
  本地 dev 用 **3011**（storefront）/ **3016**（merchant-admin），启动前先 `rm -rf .next`。
- **不要在旧容器上测**——阶段 2b 有两次「实测报缺陷、复现不出来」，
  根因都是测了旧镜像。

**测试账号**：商家 `owner@demo.platform.test` / `Demo12345!`；
消费者 `customer@demo.platform.test` / `Demo12345!`（Task 1 已加进 seed）。

**假网关的支付页在 api 服务上**：`GET /api/v1/pay/fake/:paymentId`
（`main.ts` 设了 `setGlobalPrefix('api/v1')`，所以路径带前缀）。
storefront 的「去支付」按钮跳过去——**别在旧容器上测**（见上）。

**逐条走**：

| # | 场景 | 预期 |
|---|------|------|
| 1 | 游客加购 → 刷新页面 | 购物车还在（cookie 生效） |
| 2 | 游客加购 → 登录 | 购物车合并，数量取 max 不翻倍 |
| 3 | 加购一个已下架商品 | 被拒，提示可读 |
| 4 | 结算页提交订单 | 库存减少、订单出现在列表、流水有 RESERVE |
| 5 | **连点两次提交** | 只有一个订单，库存只减一次（幂等键） |
| 6 | 假网关支付 | 订单转 PAID、流水有 DEDUCT、库存**不再变** |
| 7 | 支付后查库存 | 与预占时相同（预占已扣） |
| 8 | 取消未支付订单 | 库存加回、流水有 RELEASE |
| 9 | 超时未支付（等 15 分钟或改配置缩短） | 订单转 CLOSED、库存加回 |
| 10 | 商家后台发货 | 状态转 SHIPPED、填了快递单号 |
| 11 | 消费者确认收货 | 状态转 COMPLETED |
| 12 | 退款 | 状态转 REFUNDED、**库存不变** |
| 13 | 改地址簿的默认地址 | 下单时用的是新的默认地址 |
| 14 | 下单后改地址簿 | 订单里的收货快照**不变** |
| 15 | 主题改动后前台 | 颜色/圆角随之变化 |

### 8.2 失败注入（恒真自检）

**20 项护栏逐项做**（设计文档 §十一.1）。做法照阶段 2b：

1. 改坏一处护栏
2. 跑对应测试，**确认它真的失败**
3. 改回来
4. 复跑确认通过

**判断变异是否生效前，先确认代码真的被改坏了**——把字段名改成不存在的名字
是可靠探针。**编译错误不算「抓到」。**

### 8.3 容器化验证

```bash
cd infra && docker compose build && docker compose up -d
```

七个服务（现在是**八个**，多了 Redis）全部起来。公开接口要用店铺子域名访问。

### 8.4 写验收记录

`docs/superpowers/plans/2026-10-24-plan-03-acceptance.md`，结构照
`2026-10-22-plan-02a-acceptance.md`：

1. 自动化测试结果
2. 容器化验证
3. 手动验收场景（**填实测看到的东西**，不写「正常」）
4. **机制级验证（失败注入）表** —— 20 项护栏逐项，这是重点
5. 交付物清单
6. **已知遗留项**（诚实列出没测到的、没覆盖的）
7. 下一阶段

### 8.5 更新 README 与记忆

- README 的「当前进度」与「后续计划」
- 记忆里 `project_plan02_execution.md` 更新进度与新踩的坑

- [ ] **Step 8.6: 提交**

```bash
git add docs/ README.md
git commit -m "docs: 阶段 3 验收记录与收尾"
```

---

## 附：Task 与护栏的对应表

| Task | 覆盖的护栏编号 | 风险出处见 §0.6 对照表 |
|------|--------------|---------------------|
| 1 | —（白名单登记本身是 fail-fast） | §12.2 R16 |
| 2 | 1, 2, 3, 19, 20 | |
| 3 | 4, 5, 9 | |
| 4 | 6, 7, 8, 10（payment 侧）、15、17（流转半） | |
| 5 | 10（payment 侧）、11, 12, 13, 14, 16、17（完整） | |
| 6 | 10（释放侧）、18 | |
| 7 | —（前端交互） | |
| 8 | 全部 20 项复验 | |

