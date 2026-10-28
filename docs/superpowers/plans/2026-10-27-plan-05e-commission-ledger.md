# 阶段 5e 实施计划：抽佣流水明细 + M11 收尾

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把抽佣从「订单上的两个快照字段 + 报表跨订单聚合」抽成一张可查的流水表（正负流水行），并把 5b 留下的 M11 护栏真正测到。

**Architecture:** 新建 `commission_entries` 表，一笔抽佣一行、一笔冲回一行，金额带符号；抽佣行在**支付成功时**写、冲回行在**退款成功时**写，都与订单状态变化在**同一个事务**里，`occurredAt` 与现状报表的归期口径逐字一致。回填做成**幂等的服务方法 + CLI 脚本**（不是迁移里的 SQL —— 迁移里的回填测不到），且**平台收入报表不切到流水表**，用一条对账 e2e 保证两者不漂。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 + Jest 30（api）；Next.js 15 App Router + React 19 + Tailwind CSS 4.3.3 + Vitest 3（platform-admin）。

**依据设计文档：** `docs/superpowers/specs/2026-10-27-plan-05e-commission-ledger-design.md`（`561f83e`）

---

## §0.5 勘误表

> **惯例：** 实施期间发现的「设计文档说错了 / 没说清」的地方，**先记在这里，再改代码**。
> 已知的设计勘误见设计文档 §二（尤其 §2.6「M11 不是缺日志」）。

| # | Task | 现象 | 处置 |
|---|------|------|------|
| — | — | （实施开始时为空） | — |
| E29 | 2/3/4 | **计划给的 `upsert` 在租户作用域模型上被直接拒绝**（`TenantScopeError`）—— 阶段 1 的租户扩展对白名单内的模型禁用 `findUnique`/`update`/`delete`/`upsert`（唯一字段 only 的方法无法附加 tenantId 条件 → 跨租户越权），**平台作用域下也拒** | 改成扩展自己推荐的「`findFirst` 后 `create`」。⚠️ **回填那版必须自己带 `tenantId`** —— 平台作用域下扩展不附加 tenantId 条件，不带就会把别家同 orderId 的行误判成「已存在」 |
| E30 | 1 | **`prisma migrate dev` 在本仓库不可用** —— 历史迁移文件被改过（校验和不一致），它提示要重置 public schema，而项目明令禁用 `migrate reset` | 改用 `prisma migrate diff` 生成 SQL → 手工裁剪 → `psql` 应用 → `prisma migrate resolve --applied` 登记（与阶段 5c 的做法一致） |
| E31 | 1/3 | **新增 `api/scripts/` 这个顶层目录改变了 TypeScript 的公共根目录** → 产物变成 `dist/src/main.js`，与运行阶段的 `node dist/main.js` 对不上 → **容器起不来**。⚠️ 单测与 e2e 都从源码跑（ts-jest / ts-node），**全都没发现** | `tsconfig.build.json` 的 `exclude` 加 `"scripts"`（与 `prisma/` 同款理由）；并在 Dockerfile 的构建阶段加 `RUN test -f /app/dist/main.js`，让镜像构建就失败而不是容器崩溃循环 |
| E32 | 3 | **回填的 `reversalCreated` 计数无条件自增**（`commissionCreated` 是门控的）→ 跑第二遍会谎报「新建了 N 行」，违反 N6 | 同样用 `if (created)` 门控。⚠️ **规格审查与实施者独立发现了同一个 bug** —— 说明变异测试式的交叉核对有价值 |

---

## §0.1 全局约定

### 分支与提交

- 仓库根：`/Users/tom/orca/workspaces/电商项目/电商项目`
- 分支：`gzt/电商项目`（**不要新建分支**）
- **docs 与业务代码分开提交**：设计/计划/验收记录的改动单独一个 commit。
- 提交信息一律中文，格式：`feat(api): …` / `fix(front): …` / `test(api): …` / `docs: …`

### 验证命令速查

| 目的 | 命令 |
|------|------|
| api 单元测试 | `cd api && npx jest --passWithNoTests` |
| api e2e（单个文件） | `cd api && npm run test:e2e -- <文件名>` |
| api 类型检查 | `cd api && npx tsc --noEmit` |
| platform-admin 测试 | `cd platform-admin && npm test` |
| platform-admin 类型检查 | `cd platform-admin && npx tsc --noEmit` |
| platform-admin 构建 | `cd platform-admin && npm run build` |

⚠️ **e2e 需要 `api/.env` 里的 `DATABASE_URL_TEST`**，且会 **truncate 测试库**（`api/test/setup-e2e.ts`）。跑之前确认那个库不是开发库。

### 本机端口（记忆里已记录）

PostgreSQL **15432**、Redis **16380**、api **3000**、三个前端 **3001 / 3002 / 3003**。

### 本仓库的既有纪律（每个 Task 都适用）

- **「外科手术式改动」**：只碰必须碰的地方，不顺手清理邻近代码、不重构没坏的东西、不顺手删除历史死代码。每一行改动都要能追溯到需求。
- **注释解释「为什么」**：本仓库注释密度很高，大量注释在解释某个设计约束的来龙去脉（防止后人「顺手改进」把它改坏）。注释必须**准确** —— 写之前核实事实。
- **中文**：注释与 commit message 一律简体中文；英文只保留标识符与框架名。
- **金额一律整数分**，费率用基点（万分之）。绝不出现 `amount * rate / 100` 这类浮点除法。

### 平台端页面的既有惯例

- `platform-admin` 的页面是 **Server Component**，区间来自 URL 的 `?from=&to=`（可分享、可后退、不引客户端 state）。
- 页面**直接 `apiFetchAuthed` 调后端**（不需要中转路由）—— 见 `platform-admin/src/app/(dashboard)/reports/page.tsx`。
- ⚠️ **金额一律用后端返回的值，前端不自己加总**（与报表页「前端绝不自己算净额」同款原则）。
- ⚠️ **platform-admin 没有真组件测试基建**（5b 遗留）—— 本阶段用现有的「页面级遍历元素树」测试方式（`platform-admin/test/helpers/page-tree.ts`），**不要**为这一页新建 jsdom 基建。

---

## §0.2 文件清单

### 新建

| 路径 | 职责 |
|------|------|
| `api/src/modules/billing/commission.service.ts` | 写流水行（支付/退款）、回填、平台端查询 |
| `api/src/modules/billing/commission.service.spec.ts` | 回填判定规则的纯逻辑单测 |
| `api/scripts/backfill-commission-entries.ts` | 回填的 CLI 入口 |
| `api/src/modules/billing/dto/commission-query.dto.ts` | 明细端点的区间参数 |
| `platform-admin/src/app/(dashboard)/commissions/page.tsx` | 平台的「抽佣明细」页 |

### 修改

| 路径 | 改什么 |
|------|--------|
| `api/prisma/schema.prisma` | `CommissionEntryType` 枚举、`CommissionEntry` 模型、`Order` 的反向关系 |
| `api/prisma/migrations/<时间戳>_add_commission_entries/migration.sql` | 建表、索引、外键 |
| `api/src/modules/payment/payment.service.ts` | 支付成功写 COMMISSION 行、退款成功写 REVERSAL 行 |
| `api/src/modules/billing/invoice.service.ts` | M11 的注释（`markInvoicePaidInTx`） |
| `api/src/modules/billing/platform-report.controller.ts` | 新增 `GET /platform/commissions` |
| `api/src/modules/billing/billing.module.ts` | 注册 `CommissionService` |
| `api/test/billing-report.e2e-spec.ts` | 对账 e2e |
| `api/test/billing-renewal.e2e-spec.ts` | M11 的新用例 |
| `platform-admin/src/lib/billing.ts` | 明细的类型与换算函数 |
| `platform-admin/src/app/(dashboard)/layout.tsx` | 导航加一项 |

---

## Task 1: 数据模型与迁移

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/<时间戳>_add_commission_entries/migration.sql`

---

### Step 1: 改 schema.prisma

**1a. 加枚举**（放在 `OrderStatus` 枚举附近，Prisma 的枚举在文件里是集中声明的）：

```prisma
/**
 * 抽佣流水的类型。
 *
 * ⚠️ **冲回不是负的数字字段，是一行独立的流水** ——
 * 这样「冲回了哪一笔」在表里查得到，且流水是 append-only 的审计凭证。
 */
enum CommissionEntryType {
  /** 抽佣（支付成功时记） */
  COMMISSION
  /** 退款冲回（退款成功时记） */
  REVERSAL
}
```

**1b. 加模型**（放在 `Order` 模型之后）：

```prisma
/**
 * 抽佣流水（阶段 5e）。
 *
 * ⚠️ **一笔抽佣一行、一笔冲回一行**，金额带符号：
 * COMMISSION 的 amount > 0，REVERSAL 的 amount < 0。
 * 单列求和即净额。
 *
 * ⚠️ **为什么要有这张表**：5b 的决策是「抽佣不建独立表，存成订单上的两个快照字段」，
 * 遗留写的是「报表 SQL 要跨订单聚合；将来做结算单时再抽一层」。
 * 本阶段把那层抽出来了 —— 不是因为分叉点变多了，而是
 * **「按商家 × 区间出结算单」需要「这一笔属于哪个商家的哪一次成交」**，
 * 从订单聚合算不出来。
 */
model CommissionEntry {
  id       String @id @default(uuid())
  tenantId String
  orderId  String
  /** 订单号快照（对外凭证） */
  orderNo  String
  type     CommissionEntryType
  /**
   * 金额（整数分，**带符号**）。
   * COMMISSION > 0（抽佣）；REVERSAL < 0（冲回）。
   */
  amount Int
  /** 抽佣费率快照（基点）。套餐费率会变 → 必须快照 */
  rateBps Int
  /** 计佣基数快照（= 实付 = `Order.totalAmount`） */
  baseAmount Int
  /**
   * 业务发生时间。
   * COMMISSION = 支付时间；REVERSAL = 退款时间。
   * ⚠️ **与平台收入报表的归期口径逐字一致** ——
   * 抽佣按 `paidAt`、冲回按 `refundedAt`。
   */
  occurredAt DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  /**
   * ⚠️ **外键 Restrict**：流水是审计凭证，
   * 有流水的订单不允许被物理删除（与 `InventoryMovement` 同款理由）。
   */
  order Order @relation(fields: [orderId], references: [id], onDelete: Restrict)

  // ⚠️ 一单一抽佣、一单一冲回 → 幂等的兜底
  @@unique([orderId, type])
  @@index([tenantId, occurredAt])
  @@index([occurredAt])
  @@map("commission_entries")
}
```

**1c. 给 `Order` 加反向关系**（Prisma 要求双向声明，否则 schema 校验失败）：

在 `Order` 模型的关系区（`items`/`payments` 旁边）加：

```prisma
  commissionEntries CommissionEntry[]
```

**1d. `tenantId` 是纯标量**，**不要**声明 tenant 关系 —— 与 `Order.tenantId` 同款：
「跨租户挂载」由 service 层显式校验，不靠外键悄悄放行。

### Step 2: 生成并手写迁移

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx prisma migrate dev --name add_commission_entries --create-only
```

⚠️ 本仓库的迁移是**手写 SQL**，不是 `prisma migrate diff` 的输出 ——
`--create-only` 生成的 SQL 要按下面的样子**改写**（列的类型、大小写、索引的手写部分）。

最终 `api/prisma/migrations/<时间戳>_add_commission_entries/migration.sql`：

```sql
-- 抽佣流水（阶段 5e）。
--
-- ⚠️ **为什么手写而不是用 prisma migrate diff 的输出**：
-- diff 会把「部分唯一索引」当成漂移输出成 DROP INDEX。
-- 本项目的部分唯一索引一律手写，并在文件里说明理由。
--
-- ⚠️ **金额带符号**：COMMISSION > 0（抽佣），REVERSAL < 0（冲回）。
-- 单列求和即净额。

-- CreateEnum
CREATE TYPE "CommissionEntryType" AS ENUM ('COMMISSION', 'REVERSAL');

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "type" "CommissionEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "baseAmount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commission_entries_orderId_type_key" ON "commission_entries"("orderId", "type");

-- ⚠️ 这两个索引覆盖两种主要查询：
-- ① 「某个商家在某区间内的流水」（平台结算单）
-- ② 「全平台在某区间内的流水」（平台收入报表将来切过来时用）
CREATE INDEX "commission_entries_tenantId_occurredAt_idx" ON "commission_entries"("tenantId", "occurredAt");

CREATE INDEX "commission_entries_occurredAt_idx" ON "commission_entries"("occurredAt");

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

⚠️ **`updatedAt` 没有默认值** —— 与仓库里其它表一致（Prisma 的 `@updatedAt` 由应用层写）。

### Step 3: 应用迁移并验证

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx prisma migrate dev
npx prisma generate
npx tsc --noEmit
```

Expected: 无类型错误；`npx prisma migrate status` 显示已是最新。

### Step 4: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/prisma/schema.prisma api/prisma/migrations/
git commit -m "feat(api): 加抽佣流水表（正负流水行 + 订单外键）"
```

---

## Task 2: 支付与退款的流水写入

**Files:**
- Create: `api/src/modules/billing/commission.service.ts`
- Modify: `api/src/modules/payment/payment.service.ts`
- Modify: `api/src/modules/billing/billing.module.ts`

⚠️ **`billing` 模块不 import `payment`**（`billing.module.ts` 的注释明说：一旦 import
就成环）。所以**写流水的逻辑放在 `billing` 模块的 service 里，由 `payment` 调它** ——
依赖方向是 `payment → billing`（单向，与 `payment → billing` 的 `InvoiceService` 同款）✅

---

### Step 1: 写 `CommissionService`（只含写入部分）

Create `api/src/modules/billing/commission.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { CommissionEntryType, Prisma } from '@prisma/client';

import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PrismaTransaction } from '../../common/prisma/prisma-transaction';

/**
 * 抽佣流水的写入。
 *
 * ⚠️ **本 service 只写不读**：读取（平台的明细端点）在 Task 4 加。
 * 拆开是因为「写」在支付/退款的热路径上，「读」是平台后台的低频查询。
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 记一笔抽佣（支付成功时）。
   *
   * ⚠️ **幂等**：同一笔订单的抽佣行只有一条 ——
   * ① 订单的状态条件更新（`status = PENDING_PAYMENT`）已经挡住了重复投递；
   * ② `@@unique([orderId, type])` 再兜一层；
   * ③ 这里用 `upsert` 而不是 `create`，撞唯一索引不该抛 P2002。
   *
   * ⚠️ **零额不记**：费率是 0（免费套餐）的订单不产生流水行 ——
   * 否则表里全是 0，聚合时白扫一遍。
   *
   * @param occurredAt 支付时间（用**数据库的时钟**，与订单的 `paidAt` 同源）
   */
  async recordCommissionInTx(
    tx: PrismaTransaction,
    order: {
      id: string;
      tenantId: string;
      orderNo: string;
      totalAmount: number;
      commissionRate: number;
      commissionAmount: number;
    },
    occurredAt: Date,
  ): Promise<void> {
    if (order.commissionAmount === 0) return;

    await tx.commissionEntry.upsert({
      where: { orderId_type: { orderId: order.id, type: CommissionEntryType.COMMISSION } },
      create: {
        tenantId: order.tenantId,
        orderId: order.id,
        orderNo: order.orderNo,
        type: CommissionEntryType.COMMISSION,
        amount: order.commissionAmount,
        rateBps: order.commissionRate,
        baseAmount: order.totalAmount,
        occurredAt,
      },
      update: {},
    });
  }

  /**
   * 记一笔退款冲回（退款成功时）。
   *
   * ⚠️ **金额取负**：冲回行是「平台要还回去的钱」，与抽佣行反向。
   * 单列求和即净额（抽佣 + 冲回）。
   */
  async recordReversalInTx(
    tx: PrismaTransaction,
    order: {
      id: string;
      tenantId: string;
      orderNo: string;
      totalAmount: number;
      commissionRate: number;
      commissionAmount: number;
    },
    occurredAt: Date,
  ): Promise<void> {
    if (order.commissionAmount === 0) return;

    await tx.commissionEntry.upsert({
      where: { orderId_type: { orderId: order.id, type: CommissionEntryType.REVERSAL } },
      create: {
        tenantId: order.tenantId,
        orderId: order.id,
        orderNo: order.orderNo,
        type: CommissionEntryType.REVERSAL,
        amount: -order.commissionAmount,
        rateBps: order.commissionRate,
        baseAmount: order.totalAmount,
        occurredAt,
      },
      update: {},
    });
  }
}
```

⚠️ **`upsert` 的 `update: {}`** —— 幂等的语义是「已存在就不改」（第一次写进去的值就是最终值）。

### Step 2: 在支付成功处写抽佣流水

Modify `api/src/modules/payment/payment.service.ts`。

**2a.** 在 import 区加 `CommissionService`（从 `../billing/commission.service`）。

**2b.** 找到 `markUsedInTx` 那一行（在订单转 PAID 的事务里）：

```ts
    await this.couponRedemption.markUsedInTx(tx, order.id);
```

在它**之后**加：

```ts
    // ---- 记一笔抽佣流水（阶段 5e）----
    //
    // ⚠️ **必须在同一个事务里**：订单转 PAID 与「这笔单赚到了抽佣」同生共死。
    // 分成两个事务的话，订单已支付而抽佣没记上 → 平台少收钱、账对不上。
    //
    // ⚠️ **`occurredAt` 用 `paidAt`** —— 与平台收入报表的归期口径逐字一致
    // （报表按 `Order.paidAt` 聚合抽佣）。
    //
    // ⚠️ **重复投递不会写第二行**：订单的状态条件更新在上面已经挡住了
    // （`won` 为 false 时就 return 了），这里压根走不到。
    await this.commission.recordCommissionInTx(tx, order, paidAt);
```

**2c.** 在 `PaymentService` 的构造器里注入 `CommissionService`（照现有 provider 的写法）。

### Step 3: 在退款成功处写冲回流水

Modify `api/src/modules/payment/payment.service.ts` 的退款方法。

在 `transitionInTx(tx, order.id, order.status, OrderStatus.REFUNDED, { refundedAt })` 之后、
`if (!won) { throw ... }` 之后加：

```ts
        // ---- 记一笔冲回流水（阶段 5e）----
        //
        // ⚠️ **金额取负**（`recordReversalInTx` 内部处理）——
        // 冲回是「平台要还回去的钱」，与抽佣行反向，单列求和即净额。
        //
        // ⚠️ **`occurredAt` 用 `refundedAt`** —— 与报表的冲回归期口径一致
        // （报表按 `Order.refundedAt` 聚合）。
        await this.commission.recordReversalInTx(tx, order, refundedAt);
```

⚠️ 退款那段的 `tx` 是 `this.prisma.$transaction(async (tx) => {...})` 里的 `tx` ✅

### Step 4: 注册 provider

Modify `api/src/modules/billing/billing.module.ts`：

- import 加 `import { CommissionService } from './commission.service';`
- `providers` 数组加 `CommissionService`
- ⚠️ **`exports` 要不要加？** —— `payment` 模块要用它 → **必须导出** ✅
  （`payment → billing` 的单向依赖，`billing` 不 import `payment`，不成环）

### Step 5: 类型检查

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
```

Expected: 无类型错误。

⚠️ 若报 `tx.commissionEntry` 不存在 → 跑 `npx prisma generate`。

### Step 6: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/commission.service.ts api/src/modules/billing/billing.module.ts api/src/modules/payment/payment.service.ts
git commit -m "feat(api): 支付成功记抽佣流水、退款成功记冲回流水"
```

---

## Task 3: 历史订单的回填

**Files:**
- Modify: `api/src/modules/billing/commission.service.ts`（加回填方法）
- Create: `api/scripts/backfill-commission-entries.ts`
- Test: `api/src/modules/billing/commission.service.spec.ts`（新建）

---

### Step 1: 写回填的纯逻辑

回填的**判定规则**抽成纯函数，才能被单测覆盖（设计文档 §4.4）。

在 `commission.service.ts` 里加：

```ts
/**
 * 一条历史订单要不要回填抽佣流水。
 *
 * ⚠️ **抽成纯函数是为了能单测**：回填的规则与「报表怎么过滤」必须**逐字对应**，
 * 否则流水表与报表的数字对不上（对账 e2e 会红）。
 *
 * @param paidAt 支付时间（null = 没付过钱 → 没有抽佣）
 * @param commissionAmount 下单时定下的抽佣快照
 * @param refundedAt 退款时间（null = 从没退过，或 5b 之前退的没记时间）
 * @param refunded 是否已退款
 */
export function shouldBackfillCommission(paidAt: Date | null, commissionAmount: number): boolean {
  // ⚠️ **没付过钱 → 没有抽佣**（与报表只看 paidAt 一致）
  if (!paidAt) return false;
  // ⚠️ **零额不记**（免费套餐的费率是 0）—— 表里全是 0 没意义
  if (commissionAmount === 0) return false;
  return true;
}

/**
 * 一条历史订单要不要回填冲回流水。
 *
 * ⚠️ **`refundedAt` 为 null 的已退款订单一律跳过** ——
 * 5b 之前退的款没记时间（`Order.refundedAt` 是 5b 加的），
 * **冲回无法归期**。现状报表同样跳过它们（`refundedAt: {gte, lt}` 对 null 不匹配）
 * → **两个口径一致** ✅
 */
export function shouldBackfillReversal(
  refunded: boolean,
  refundedAt: Date | null,
  commissionAmount: number,
): boolean {
  if (!refunded) return false;
  if (!refundedAt) return false;
  if (commissionAmount === 0) return false;
  return true;
}
```

### Step 2: 写回填的服务方法

在 `CommissionService` 里加：

```ts
  /**
   * 回填历史订单的抽佣流水。
   *
   * ⚠️ **幂等**：用 `upsert`，重复跑不会产生重复行、也不会改已有行。
   *
   * ⚠️ **为什么是服务方法而不是迁移里的 SQL**：迁移里的回填**测不到** ——
   * e2e 的种子数据在迁移**之后**才灌进去，迁移执行时表是空的。
   * 做成服务方法才能被 e2e 验证。
   *
   * ⚠️ **报表口径没切**（设计文档 D7）→ **忘了跑这个脚本没有任何正确性影响**，
   * 只是平台的「抽佣明细」页里历史行会不全。
   *
   * @returns 各类跳过的计数 —— **不要静默**，运维要看到「有多少历史退款被跳过了」
   */
  async backfill(): Promise<{
    commissionCreated: number;
    reversalCreated: number;
    skippedZeroAmount: number;
    skippedUndatedRefund: number;
  }> {
    const orders = await this.prisma.order.findMany({
      where: { paidAt: { not: null } },
      select: {
        id: true,
        tenantId: true,
        orderNo: true,
        totalAmount: true,
        commissionRate: true,
        commissionAmount: true,
        paidAt: true,
        refundedAt: true,
        status: true,
      },
    });

    let commissionCreated = 0;
    let reversalCreated = 0;
    let skippedZeroAmount = 0;
    let skippedUndatedRefund = 0;

    for (const order of orders) {
      const refunded = order.status === OrderStatus.REFUNDED;

      if (order.commissionAmount === 0) {
        skippedZeroAmount += 1;
      } else if (shouldBackfillCommission(order.paidAt, order.commissionAmount)) {
        await this.prisma.commissionEntry.upsert({
          where: { orderId_type: { orderId: order.id, type: CommissionEntryType.COMMISSION } },
          create: {
            tenantId: order.tenantId,
            orderId: order.id,
            orderNo: order.orderNo,
            type: CommissionEntryType.COMMISSION,
            amount: order.commissionAmount,
            rateBps: order.commissionRate,
            baseAmount: order.totalAmount,
            occurredAt: order.paidAt!,
          },
          update: {},
        });
        commissionCreated += 1;
      }

      if (refunded && order.commissionAmount === 0) {
        // 已计过上面的零额计数
      } else if (shouldBackfillReversal(refunded, order.refundedAt, order.commissionAmount)) {
        await this.prisma.commissionEntry.upsert({
          where: { orderId_type: { orderId: order.id, type: CommissionEntryType.REVERSAL } },
          create: {
            tenantId: order.tenantId,
            orderId: order.id,
            orderNo: order.orderNo,
            type: CommissionEntryType.REVERSAL,
            amount: -order.commissionAmount,
            rateBps: order.commissionRate,
            baseAmount: order.totalAmount,
            occurredAt: order.refundedAt!,
          },
          update: {},
        });
        reversalCreated += 1;
      } else if (refunded && !order.refundedAt) {
        // ⚠️ **已退款但没记退款时间** —— 5b 之前退的款。
        //    冲回无法归期 → 跳过（与报表口径一致），但要计数报出来。
        skippedUndatedRefund += 1;
      }
    }

    return { commissionCreated, reversalCreated, skippedZeroAmount, skippedUndatedRefund };
  }
```

⚠️ **`this.prisma.order.findMany` 要在平台作用域下跑** —— 抽佣流水是**跨租户**的
（平台看所有商家）。`TenantPrismaService` 带租户过滤 → 必须用 `tenantContext.run(platformScope(), ...)`，
与 `report.service.ts:94` 同款。

⚠️ 实施时**先核实** `platformScope` 与 `tenantContext` 的 import 路径
（`report.service.ts` 里有现成的用法，照抄）。

### Step 3: 写 CLI 脚本

Create `api/scripts/backfill-commission-entries.ts`：

```ts
/**
 * 回填历史订单的抽佣流水。
 *
 * ⚠️ **幂等，可以重复跑** —— 用的是 `upsert`。
 *
 * 用法：
 *   cd api && npx tsx scripts/backfill-commission-entries.ts
 *
 * ⚠️ 若项目没有 `tsx`，改用仓库既有的 ts-node 方式
 * （`api/package.json` 的 `test:debug` 脚本用的是 `ts-node/register`）——
 * **实施时按仓库的实际约定来**，别自造一个运行器。
 */
```

⚠️ **实施时先看仓库里有没有现成的脚本运行方式**（`api/package.json` 的 scripts、
`api/scripts/` 目录）。若没有，就用 `ts-node` 并在 `package.json` 加一个
`"backfill:commissions": "ts-node scripts/backfill-commission-entries.ts"`。

脚本的**内容**：建 Nest 应用上下文 → 取 `CommissionService` → 调 `backfill()` → 打印计数。

⚠️ 脚本要**优雅退出**（`process.exit(0)`），否则 Nest 的连接池会吊住进程。

### Step 4: 写单测

Create `api/src/modules/billing/commission.service.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';

import {
  shouldBackfillCommission,
  shouldBackfillReversal,
} from './commission.service';

/**
 * 回填的**判定规则**。
 *
 * ⚠️ **规则必须与平台收入报表的过滤逐字对应** ——
 * 不一致的话流水表与报表的数字对不上（对账 e2e 会红）。
 * 报表的口径（`report.service.ts`）：
 * - 抽佣：`paidAt ∈ [from, to)`，**不看 status**
 * - 冲回：`status = REFUNDED` 且 `refundedAt ∈ [from, to)`
 */
describe('回填的判定规则', () => {
  it('没付过钱 → 不回填抽佣', () => {
    expect(shouldBackfillCommission(null, 500)).toBe(false);
  });

  it('付过钱且金额非零 → 回填抽佣', () => {
    expect(shouldBackfillCommission(new Date(), 500)).toBe(true);
  });

  it('零额 → 不回填抽佣（免费套餐的费率是 0）', () => {
    expect(shouldBackfillCommission(new Date(), 0)).toBe(false);
  });

  it('没退款 → 不回填冲回', () => {
    expect(shouldBackfillReversal(false, new Date(), 500)).toBe(false);
  });

  it('已退款但 refundedAt 为 null → 不回填冲回（5b 之前退的款没记时间）', () => {
    expect(shouldBackfillReversal(true, null, 500)).toBe(false);
  });

  it('已退款且有 refundedAt → 回填冲回', () => {
    expect(shouldBackfillReversal(true, new Date(), 500)).toBe(true);
  });

  it('零额的已退款订单 → 不回填冲回', () => {
    expect(shouldBackfillReversal(true, new Date(), 0)).toBe(false);
  });
});
```

⚠️ **api 的单元测试用 Jest，不是 Vitest** —— 改成 `import { describe, expect, it } from '@jest/globals';`
（先看 `api/src/modules/billing/commission.spec.ts` 的现有写法，照抄它的 import 形式）。

### Step 5: 跑测试

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest src/modules/billing/commission.service.spec.ts
```

Expected: 7 个用例全过。

### Step 6: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/commission.service.ts api/src/modules/billing/commission.service.spec.ts api/scripts/
git commit -m "feat(api): 抽佣流水的历史回填（幂等 + 跳过计数）"
```

---

## Task 4: 平台的抽佣明细查询端点

**Files:**
- Modify: `api/src/modules/billing/commission.service.ts`（加查询方法）
- Create: `api/src/modules/billing/dto/commission-query.dto.ts`
- Modify: `api/src/modules/billing/platform-report.controller.ts`

---

### Step 1: 写查询方法

在 `CommissionService` 里加：

```ts
  /**
   * 平台的抽佣明细（跨租户）。
   *
   * ⚠️ **跨租户查询用 `platformScope()`** —— 与 `report.service.ts` 同款。
   *
   * ⚠️ **商家名要另查 `Tenant` 表**：`Order.tenantId` 是纯标量、没声明关系，
   * 拿不到商家名 → 先查流水，再按 tenantId 集合批量取 `Tenant`。
   *
   * ⚠️ **净额由后端算**（明细行之和）—— 前端不自己加总（与报表页同款原则）。
   */
  async ledger(input: { from: Date; to: Date }): Promise<CommissionLedgerResponse> {
    return tenantContext.run(platformScope(), async () => {
      const entries = await this.prisma.commissionEntry.findMany({
        where: { occurredAt: { gte: input.from, lt: input.to } },
        orderBy: { occurredAt: 'desc' },
      });

      // 批量取商家名
      const tenantIds = [...new Set(entries.map((e) => e.tenantId))];
      const tenants = await this.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true, subdomain: true },
      });
      const tenantById = new Map(tenants.map((t) => [t.id, t]));

      // 按商家汇总
      const byMerchantMap = new Map<string, { netAmount: number; entryCount: number; reversalCount: number }>();
      for (const entry of entries) {
        const agg = byMerchantMap.get(entry.tenantId) ?? { netAmount: 0, entryCount: 0, reversalCount: 0 };
        agg.netAmount += entry.amount;
        agg.entryCount += 1;
        if (entry.type === CommissionEntryType.REVERSAL) agg.reversalCount += 1;
        byMerchantMap.set(entry.tenantId, agg);
      }

      const byMerchant = [...byMerchantMap.entries()]
        .map(([tenantId, agg]) => {
          const tenant = tenantById.get(tenantId);
          return {
            tenantId,
            tenantName: tenant?.name ?? '（未知商家）',
            subdomain: tenant?.subdomain ?? '',
            netAmount: agg.netAmount,
            entryCount: agg.entryCount,
            reversalCount: agg.reversalCount,
          };
        })
        .sort((a, b) => b.netAmount - a.netAmount);

      return {
        from: input.from,
        to: input.to,
        byMerchant,
        entries: entries.map((e) => ({
          id: e.id,
          tenantId: e.tenantId,
          orderId: e.orderId,
          orderNo: e.orderNo,
          type: e.type,
          amount: e.amount,
          rateBps: e.rateBps,
          baseAmount: e.baseAmount,
          occurredAt: e.occurredAt.toISOString(),
        })),
      };
    });
  }
```

⚠️ **`this.prisma.tenant` 在平台作用域下可用吗** —— 实施时核实 `TenantPrismaService`
有没有 `tenant` 这个 getter（`report.service.ts` 里有没有用过）。若没有，
用 `this.prisma.$extends` 或换一种方式 —— **先看 `report.service.ts` 的
`listSubscriptions` 怎么取商家信息的，照抄**。

### Step 2: 写 DTO

Create `api/src/modules/billing/dto/commission-query.dto.ts`：

⚠️ **照抄 `dto/report-query.dto.ts`**（同一个区间语义、同一套校验装饰器）。

### Step 3: 加端点

Modify `api/src/modules/billing/platform-report.controller.ts`：

```ts
  /**
   * 平台的抽佣明细。
   *
   * ⚠️ **区间缺省是「最近 30 天」** —— 与平台收入报表同款，
   * 缺省窗口用**数据库的时钟**算（护栏 M15）。
   */
  @Get('commissions')
  @ApiOperation({ summary: '平台的抽佣明细（缺省最近 30 天）' })
  async commissions(@Query() query: CommissionQueryDto) {
    const { from, to } = await this.reports.resolveWindow({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return this.commission.ledger({ from, to });
  }
```

⚠️ **`resolveWindow` 现在是 `private` 的** —— 要把它改成 `public`（或加一个 public 的
包装方法）。⚠️ **这是对既有代码的改动，要在报告里说明**。

⚠️ 还要给 `PlatformReportController` 注入 `CommissionService`。

### Step 4: 类型检查 + 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
cd ..
git add api/src/modules/billing/commission.service.ts api/src/modules/billing/dto/commission-query.dto.ts api/src/modules/billing/platform-report.controller.ts
git commit -m "feat(api): 平台的抽佣明细端点（按商家汇总 + 明细）"
```

---

## Task 5: platform-admin 的「抽佣明细」页

**Files:**
- Create: `platform-admin/src/app/(dashboard)/commissions/page.tsx`
- Modify: `platform-admin/src/lib/billing.ts`
- Modify: `platform-admin/src/app/(dashboard)/layout.tsx`

---

### Step 1: 加类型与换算函数

Modify `platform-admin/src/lib/billing.ts`：

```ts
/**
 * 平台的抽佣明细。
 *
 * ⚠️ **金额一律整数分**：净额由后端算好，前端只做展示换算
 * （与 `ReportSummary` 同款原则）。
 */
export interface CommissionLedger {
  from: string;
  to: string;
  byMerchant: Array<{
    tenantId: string;
    tenantName: string;
    subdomain: string;
    /** 净抽佣（整数分，可负） */
    netAmount: number;
    entryCount: number;
    reversalCount: number;
  }>;
  entries: Array<{
    id: string;
    tenantId: string;
    orderNo: string;
    type: 'COMMISSION' | 'REVERSAL';
    /** 带符号：抽佣为正、冲回为负 */
    amount: number;
    /** 费率（基点） */
    rateBps: number;
    /** 计佣基数（整数分） */
    baseAmount: number;
    occurredAt: string;
  }>;
}

/** 抽佣流水类型的文案 */
export const COMMISSION_ENTRY_TYPE_LABEL: Record<'COMMISSION' | 'REVERSAL', string> = {
  COMMISSION: '抽佣',
  REVERSAL: '退款冲回',
};
```

⚠️ **复用 `formatRevenueLabel`**（`billing.ts` 里已有）把整数分显示成金额。

### Step 2: 写页面

Create `platform-admin/src/app/(dashboard)/commissions/page.tsx`：

⚠️ **照抄 `reports/page.tsx` 的骨架**（Server Component、URL 区间、`toIsoRange`、
「两个都给了才转区间」的校验、「两个都没给就不传 from/to」）。

页面结构：
1. 区间表单（同报表页）
2. **按商家汇总**的表：商家名 / 子域名 / 净抽佣 / 笔数 / 其中冲回笔数
3. **明细**的表：时间 / 订单号 / 类型 / 金额 / 费率 / 基数

⚠️ **净额一律用后端返回的 `netAmount`，前端不自己加总**。

### Step 3: 加导航

Modify `platform-admin/src/app/(dashboard)/layout.tsx`，在「报表」那一项后面加：

```tsx
            <Link href="/commissions" className="underline-offset-4 hover:underline">
              抽佣明细
            </Link>
```

### Step 4: 构建 + 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin"
npx tsc --noEmit && npm run build
cd ..
git add "platform-admin/src/app/(dashboard)/commissions/page.tsx" platform-admin/src/lib/billing.ts "platform-admin/src/app/(dashboard)/layout.tsx"
git commit -m "feat(platform-admin): 抽佣明细页（按商家汇总 + 明细）"
```

---

## Task 6: M11 的断言与注释

**Files:**
- Modify: `api/src/modules/billing/invoice.service.ts`（注释）
- Modify: `api/test/billing-renewal.e2e-spec.ts`（新用例）

---

### Step 1: 写注释

Modify `api/src/modules/billing/invoice.service.ts` 的 `markInvoicePaidInTx`：

在 `updateMany` 那段之前加：

```ts
    // ⚠️ **`status` 条件是第二层防御，当前实现下测不到** ——
    // 订阅期延长写的是**绝对值**（`currentPeriodStart: invoice.periodStart`、
    // `currentPeriodEnd: invoice.periodEnd`），所以**同一个账单被重复处理也只会延长一次**。
    // 那层 `status` 条件防的是「账单被重复处理」这个假设不成立时的意外，
    // 当前实现下**无法从外部观测到它是否起作用**。
    //
    // ⚠️ **护栏 M11 的用例不能靠「同一个 eventId 重复投递」** ——
    // 那会被事件表的唯一索引挡在 `markInvoicePaid` **之前**，
    // 断言「订阅期只延长一次」**恒真**，测的不是这层防御。
    // 真正的 M11 用例要投递**两个不同 eventId、但 providerTxnId 相同**的事件。
```

### Step 2: 写新用例

Modify `api/test/billing-renewal.e2e-spec.ts`，加一条用例：

⚠️ **先读这个文件里现有的 M11 用例，照抄它的夹具**（造账单、投递事件、断言订阅期）。

新用例的形状：

```ts
  it('⚠️ M11：两个不同 eventId、但 providerTxnId 相同 → 订阅期只延长一次', async () => {
    // ⚠️ **不能投递同一个 eventId** —— 事件表的唯一索引会挡在
    //    `markInvoicePaid` 之前，断言恒真，测的不是那层防御。
    //    这里的两个事件 **eventId 不同、providerTxnId 相同** ——
    //    渠道重试换了事件 id 的恶劣形式。
    //
    // ⚠️ **断言要落在「订阅期的值」上**，不能落在「调用了几次」上 ——
    //    后者可能被更上层的幂等（渠道侧 providerTxnId 唯一）挡掉。

    // ... 用文件里现成的夹具造一张 OPEN 的账单 ...
    // ... 投递事件 1（eventId=E1，providerTxnId=T）...
    // ... 记录订阅的 currentPeriodEnd ...
    // ... 投递事件 2（eventId=E2，providerTxnId=T）...
    // ... 断言 currentPeriodEnd 与记录的值相同（没有第二次延长）...
  });
```

⚠️ **实施时必须实际跑一遍**，确认第二个事件**真的走到了** `markInvoicePaidInTx` ——
若它被更上层的幂等挡掉，这条用例仍然是恒真的。**怎么确认**：临时在
`markInvoicePaidInTx` 里加一行 `console.log` 或断点，看第二次是否进入；
**验证完必须删掉**。

### Step 3: 跑 e2e

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- billing-renewal
```

Expected: 全过（含新用例）。

### Step 4: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/invoice.service.ts api/test/billing-renewal.e2e-spec.ts
git commit -m "test(api): M11 的用例改成两个不同 eventId、同一 providerTxnId"
```

---

## Task 7: 对账 e2e 与验收

**Files:**
- Modify: `api/test/billing-report.e2e-spec.ts`

---

### Step 1: 写对账用例

Modify `api/test/billing-report.e2e-spec.ts`，加一条：

```ts
  it('⚠️ 对账：流水表按区间聚合 == 报表的「抽佣收入 − 冲回」', async () => {
    // ⚠️ **这是「两套口径不许漂」的护栏** ——
    //    报表（现状：从订单聚合）与流水（新增：从表聚合）必须给出同一个数。
    //    不一致说明流水写入漏了某条路径，或回填规则漂了。
    //
    // ⚠️ **断言要具体**：期望什么、实到什么，不能只看红绿。
    //
    // ... 用文件里现成的夹具造数据（订单 + 支付 + 退款）...
    // ... 跑一遍回填（CommissionService.backfill()）...
    // ... 取流水的区间聚合，与报表的 commissionRevenue / reversal 对比 ...
  });
```

⚠️ **实施时先读 `billing-report.e2e-spec.ts` 里现成的夹具**（造订单、支付、退款、
取报表）—— 照抄它的写法，别自造一套。

⚠️ **对账的两个数怎么对齐**：
- 报表的 `commissionRevenue` = 区间内已付订单的抽佣之和（**毛额**）
- 报表的 `reversal` = 区间内已退款订单当初抽了多少（**正数**）
- 流水表：Σ `amount`（带符号）= 毛额 − 冲回
→ 所以断言是：`Σ amount === report.commissionRevenue - report.reversal` ✅

⚠️ **区间必须与报表用的区间一致** —— 报表页用「数据库时钟的最近 30 天」缺省，
测试里要**显式传 from/to** 给两边（照抄现有 e2e 的 `nextWindow()` 夹具）✅

### Step 2: 跑 e2e

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- billing-report
```

Expected: 全过。

### Step 3: 全量校验

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests && npx tsc --noEmit && npm run test:e2e
cd ../platform-admin
npm test && npx tsc --noEmit && npm run build
```

### Step 4: 写验收记录

Create `docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md`，内容包含：
- 自动化测试数字对账
- 12 条护栏（N1–N12）逐条核对
- 9 条失败注入（F1–F9）复验（**每条单独跑**，不要叠加 ——
  阶段 5c 的教训：「注入 A + 注入 B 叠加 → 挂 N 条」不能用来证明 A 缺独立锁点）
- 浏览器手测（设计文档 §6.4 的 6 条）
- 发现并修复的缺陷
- 遗留项

### Step 5: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/test/billing-report.e2e-spec.ts docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md
git commit -m "test(api): 抽佣流水与报表的对账 e2e + 阶段 5e 验收记录"
```

---

## §1 验收清单（全部 Task 完成后逐条过）

### 护栏对照

| # | 护栏 | 覆盖它的测试 |
|---|------|------------|
| N1 | 支付成功 → 一条 COMMISSION 行 | Task 7 的 e2e（**已升级为端到端**：`payment.e2e-spec.ts` 的「支付成功 → 记一笔抽佣流水」走真实的支付 + 退款流程） |
| N2 | 退款成功 → 一条 REVERSAL 行（负数） | 同上（同一个端到端用例的后半段） |
| N3 | 重复投递不产生第二条 | Task 7 的 e2e |
| N4 | 未支付不产生行 | 同上 |
| N5 | **对账**：流水聚合 == 报表抽佣 − 冲回 | 同上 |
| N6 | 回填连跑两次行数不变 | 同上 |
| N7 | 回填跳过 `refundedAt IS NULL` 且计数 | Task 3 的单测 + e2e |
| N8 | **前端不自己算净额**（汇总用后端给的 `netAmount`） | ⚠️ **勘误**：原写「Task 4 的 e2e」是错的（Task 4 没产出任何 e2e）→ 实际是 **Task 7 的对账 e2e**（后端口径）+ **收尾补的 `platform-admin/test/app/commissions-page.test.tsx`**（前端口径，用「故意对不上」的数据法） |
| N9 | 明细端点的商家名正确 | Task 7 的 e2e + 页面级测试 |
| N10 | M11：两个不同 eventId、同一 providerTxnId → 订阅期只延长一次 | Task 6 的 e2e |
| N11 | 零额订单不产生行 | Task 7 的 e2e |
| N12 | 有流水的订单不能被物理删除 | 迁移注释 + **已实测**（Task 1 实施时用临时数据验过，事务已回滚、无残留） |

### 浏览器手测（设计文档 §6.4 的 6 条）

用 **ego-browser**（先 `ego-browser skill` 看用法；**跑脚本文件要用 stdin 重定向**：
`ego-browser nodejs < round.mjs`）。**全程不得抢占前台**；结束后关闭全部标签页。

1. 平台后台「抽佣明细」页能打开，区间选择与报表页一致
2. 改一个商家的主题 → 抽佣明细页**不受影响**
3. 商家的订单支付后 → 明细页出现对应的 COMMISSION 行
4. 退款后 → 明细页出现 REVERSAL 行（金额为负）
5. 按商家汇总的净抽佣 == 明细行之和
6. 明细页显示的商家名与商家后台一致

### 收尾

1. 验收记录单独提交
2. 推分支（走 `tools/push-via-api.mjs`，**不用 `git push`**）
3. 开 PR → squash 合并 → 用 API 删远端分支（`gh pr merge --delete-branch` 在本机会失败）
4. 更新记忆
