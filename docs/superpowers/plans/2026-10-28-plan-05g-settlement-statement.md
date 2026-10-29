# 阶段 5g 实施计划：结算单（按商家 × 自然月的应收单据）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 5e 的抽佣流水聚合成「某商家 × 某自然月」的结算单（单据头 + 明细关联两张表），支持生成 / 重算 / 确认 / 取消确认，并在 platform-admin 上给出列表页与详情页。

**Architecture:** 数据只从 `commission_entries`（5e 的流水表）来，**不从订单重新聚合** —— 两套口径迟早漂。结算单按自然月（UTC）切周期，金额三件套（毛额 / 冲回 / 净额）由后端算完写进单据，前端只展示。状态机 `DRAFT ⇄ CONFIRMED` 可逆，为的是「漏结」有修复路径（已确认的单据也能退回来重算）。

**Tech Stack:** NestJS 11 + Prisma 6.19.3 + PostgreSQL 16 + Jest 30（api）；Next.js 15 App Router + React 19 + Tailwind CSS 4 + Vitest 3（platform-admin）

**设计文档**：`docs/superpowers/specs/2026-10-28-plan-05g-settlement-statement-design.md`

---

## 0. 给实施代理的必读

### 0.1 本仓库的几条硬规矩

| 规矩 | 说明 |
|------|------|
| **迁移一律手写 SQL** | `prisma migrate dev` 在本仓库会提示「需要重置 public schema」，而项目**明令禁用 `prisma migrate reset`**（阶段 2 已因此踩坑）。做法照 5c / 5e 的先例：写好 `migration.sql` → `psql` 应用 → `prisma migrate resolve --applied` 登记 |
| **金额一律整数分、费率一律基点** | 不在 service 里换算成元 |
| **租户作用域模型的「唯一字段 only」方法被禁** | `findUnique` / `update` / `delete` / `upsert` 在 `TENANT_SCOPED_MODELS` 里的模型上会抛 `TenantScopeError`（**平台作用域下也拒绝**）。只能用 `findFirst` + `updateMany` / `deleteMany` |
| **平台作用域下 `create` 必须显式带 `tenantId`** | `settlement_statements` 在白名单里 → 平台作用域写入必须自己带 `tenantId` |
| **新增带 `tenantId` 的模型必须登记白名单** | 否则 `assertTenantScopedModelsRegistered()` **让应用启动直接失败** |
| **新增模型必须在 `TenantPrismaService` 加 getter** | 该类用 getter 代理模型 delegate，不加工具类就访问不到 |
| **`tenantContext.run()` 的回调必须是 async 函数** | 同步回调会让租户上下文**静默失效** |
| **注释解释「为什么」，且必须准确** | 中文注释。写「为什么这样做」与「不做会怎样」，不写「这行代码做了什么」 |
| **外科手术式改动** | 只碰必须碰的地方，不顺手重构邻近代码 |

### 0.2 本阶段的护栏编号

设计文档 §六 定义了 **S1–S12**（护栏）与 **F1–F7**（失败注入）。实施过程中**每一条护栏都要有对应的自动化断言**，注释里要写清它防的是什么。

### 0.3 数据库

| 用途 | 连接串 |
|------|--------|
| 开发库 | `postgresql://ecommerce:ecommerce@localhost:15432/ecommerce?schema=public`（`api/.env` 的 `DATABASE_URL`） |
| 测试库 | `postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public`（`api/.env` 的 `DATABASE_URL_TEST`） |

⚠️ **测试库会被 `npm test` 自动 truncate**（`api/test/deploy-test-db.mjs` + `setup-e2e.ts`）。

⚠️ **不要在 `api/` 下新建顶层目录** —— TypeScript 的 common-root 推导会把产物路径从
`dist/main.js` 变成 `dist/src/main.js`，容器的 `CMD ["node","dist/main.js"]` 就找不到文件
（阶段 5e 踩过）。本计划新增的文件全在 `src/modules/billing/` 与 `test/` 之下 ✅。

### 0.4 e2e 夹具的月份：**2022 年**

⚠️ **为什么必须是 2022 年**：`api/test/billing-report.e2e-spec.ts` 的报表用例用
`nextWindow()` 从 **2020-01-01** 起每 60 天发一块区间，共约 12 块 → 占到 2021 年底。
结算单的 e2e 若也用 2020-2021 的月份，两边的数据会互相串。

→ **结算单 e2e 一律用 2022 年的月份**（`2022-01` ~ `2022-12`），与报表的窗口完全错开。

⚠️ **结算单 e2e 自己造流水行，不跑回填**：
`CommissionService.backfill()` 会扫全表 `paidAt` 非空的订单补流水，跨文件影响不可控。
结算单 e2e 直接 `prisma.commissionEntry.create(...)` 造行（这样也不受用例执行顺序影响）。

⚠️ **造流水行必须先造订单**：`CommissionEntry.orderId` 有外键 `Restrict`，指向 `orders.id`。

---

## Task 1：数据模型与迁移

**Files:**
- Modify: `api/prisma/schema.prisma`（新增枚举与两张表；给 `CommissionEntry` 加反向关系）
- Modify: `api/src/common/tenant/tenant-models.ts`（登记 `SettlementStatement`）
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`（加两个 getter）
- Create: `api/prisma/migrations/20261028190000_add_settlement_statements/migration.sql`

- [ ] **Step 1：改 `api/prisma/schema.prisma`**

在文件末尾（`model PaymentMethod` 之后）追加：

```prisma
// ---------- 阶段 5g：结算单 ----------

/**
 * 结算单的状态。
 *
 * ⚠️ **`PAID` 本阶段不可达**：抽佣出款不做（5b 遗留 1 / 5e 的 L19）。
 *    枚举值先留着 —— **加枚举值要改 schema + 迁移**，出款阶段必然要用，
 *    预留比将来补省事。
 */
enum SettlementStatus {
  /** 草稿：可重算、可取消确认 */
  DRAFT
  /** 已确认：金额与明细冻结 */
  CONFIRMED
  /** 已出款（阶段 5g 不做，出款阶段用） */
  PAID
}

/**
 * 结算单（平台开给商家的应收单据，阶段 5g）。
 *
 * ⚠️ **一张单 = 一个商家 × 一个自然月**（UTC，左闭右开）。
 *
 * ⚠️ **金额只从流水算**（`commission_entries`），**不从订单重新聚合** ——
 *    报表那套口径抄一遍必然漂。三个金额是**生成时刻的快照**，
 *    写死在这张单上；确认之后不再变。
 */
model SettlementStatement {
  id       String @id @default(uuid())
  tenantId String
  /** 结算单号（对外凭证，服务端生成，客户端不能指定） */
  statementNo String           @unique
  /** 周期起点（含）。该月 1 日 00:00:00.000Z */
  periodStart DateTime
  /** 周期终点（不含）。次月 1 日 00:00:00.000Z */
  periodEnd   DateTime
  /** 抽佣毛额（整数分）：Σ COMMISSION.amount，恒 >= 0 */
  grossAmount Int
  /** 退款冲回（整数分）：Σ REVERSAL.amount，**恒 <= 0** */
  reversalAmount Int
  /** 净额 = grossAmount + reversalAmount。**可以是负数** */
  netAmount Int
  /** 纳入的流水笔数 */
  entryCount Int @default(0)
  status     SettlementStatus @default(DRAFT)
  /** 确认时间。null = 未确认 */
  confirmedAt DateTime?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  entries SettlementStatementEntry[]

  // ⚠️ **同一商家同一周期只能有一张单**：重复生成走「先查后插」的幂等路径。
  @@unique([tenantId, periodStart])
  // 列表按周期倒序翻页
  @@index([periodStart])
  // 按状态筛选（「有多少张草稿待确认」）
  @@index([status])
  @@map("settlement_statements")
}

/**
 * 结算单纳入了哪些抽佣流水。
 *
 * ⚠️ **`entryId` 是全局唯一**（不是 `(statementId, entryId)` 复合唯一）：
 *   后者只能保证「同一张单里不重复」，前者才能保证
 *   **「一笔流水只能被一期结算」**。复合唯一是后者的弱化版，
 *   会放过「同一笔流水被两张单各结一次」。
 */
model SettlementStatementEntry {
  id          String   @id @default(uuid())
  statementId String
  /** 被纳入的抽佣流水 id（`commission_entries.id`） */
  entryId     String   @unique
  createdAt   DateTime @default(now())

  statement SettlementStatement @relation(fields: [statementId], references: [id], onDelete: Cascade)
  // ⚠️ **外键 Restrict**：流水是审计凭证，被结算单纳入后不允许被物理删除
  entry     CommissionEntry       @relation(fields: [entryId], references: [id], onDelete: Restrict)

  @@index([statementId])
  @@map("settlement_statement_entries")
}
```

⚠️ **`CommissionEntry` 要加反向关系**（Prisma 要求关系两端都声明，否则 schema 校验失败）。
在 `model CommissionEntry` 里，`order Order @relation(...)` 那行**下面**加：

```prisma
  /** 阶段 5g：被哪些结算单纳入了 */
  settlementEntries SettlementStatementEntry[]
```

- [ ] **Step 2：手写迁移 SQL**

Create `api/prisma/migrations/20261028190000_add_settlement_statements/migration.sql`：

```sql
-- 阶段 5g：结算单
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出。
-- 该命令在本项目会先提示「需要重置 public schema」（历史迁移文件在应用后
-- 被改过，与 _prisma_migrations 里的校验和不一致），而项目明令禁用
-- `prisma migrate reset`（阶段 2 已因此踩坑）。做法照 5c / 5e 的先例：
-- `prisma migrate diff` 生成 → 手工裁剪 → psql 应用 → migrate resolve 登记。
--
-- ⚠️ diff 会把阶段 2/5a 的**手写部分唯一索引**当成漂移输出成 DROP INDEX
-- （这个坑项目里已经踩过两次）。本次变更**只有一条 CREATE TYPE、两张新表、
-- 五个索引、两条外键**：没有 DROP TABLE、没有数据删除、没有改动既有表。

-- ---------- 枚举 ----------

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PAID');

-- ---------- 新表 ----------

-- CreateTable
CREATE TABLE "settlement_statements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "statementNo" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "grossAmount" INTEGER NOT NULL,
    "reversalAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_statements_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **tenantId 是纯标量，没有外键**：与 `orders.tenantId`、`commission_entries.tenantId`
-- 同款做法。「跨租户挂载」由 service 层显式校验，而不是靠外键悄悄放行。

-- ---------- 索引 ----------

-- CreateIndex
CREATE UNIQUE INDEX "settlement_statements_statementNo_key" ON "settlement_statements"("statementNo");

-- ⚠️ **同一商家同一周期只能有一张单**（护栏 S3 的数据层兜底）
-- CreateIndex
CREATE UNIQUE INDEX "settlement_statements_tenantId_periodStart_key" ON "settlement_statements"("tenantId", "periodStart");

-- CreateIndex
CREATE INDEX "settlement_statements_periodStart_idx" ON "settlement_statements"("periodStart");

-- CreateIndex
CREATE INDEX "settlement_statements_status_idx" ON "settlement_statements"("status");

-- CreateTable
CREATE TABLE "settlement_statement_entries" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_statement_entries_pkey" PRIMARY KEY ("id")
);

-- ⚠️ **entryId 全局唯一** → 一笔流水只能被一期结算（护栏 S4 的数据层兜底）。
-- 刻意**不**用 (statementId, entryId) 复合唯一 —— 那只保证「同一张单里不重复」，
-- 会放过「同一笔流水被两张单各结一次」。
-- CreateIndex
CREATE UNIQUE INDEX "settlement_statement_entries_entryId_key" ON "settlement_statement_entries"("entryId");

-- CreateIndex
CREATE INDEX "settlement_statement_entries_statementId_idx" ON "settlement_statement_entries"("statementId");

-- ---------- 外键 ----------

-- ⚠️ **statementId 用 Cascade**：明细行是单据的从属数据。
-- 单据本身**没有删除端点**（凭证不该被删），所以这个语义实际不触发。
-- AddForeignKey
ALTER TABLE "settlement_statement_entries" ADD CONSTRAINT "settlement_statement_entries_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "settlement_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠️ **entryId 用 Restrict**：已被结算单纳入的流水是账目的一部分，不允许被物理删除
-- AddForeignKey
ALTER TABLE "settlement_statement_entries" ADD CONSTRAINT "settlement_statement_entries_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "commission_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

⚠️ **迁移目录名的时间戳**：上面写的是 `20261028190000`。如果当前时间已经晚于它，
**改成更晚的时间戳**（迁移按名字字典序执行，名字必须排在 `20261028153000_add_webhook_event_kind` 之后）。

- [ ] **Step 3：登记白名单**

Modify `api/src/common/tenant/tenant-models.ts`，在 `TENANT_SCOPED_MODELS` 里
`// 抽佣流水（阶段 5e）` 那行下面加：

```ts
  // 结算单（阶段 5g）
  'SettlementStatement',
```

⚠️ **`SettlementStatementEntry` 刻意不登记**：它没有 `tenantId` 字段
（纯关联表），登记了也没有隔离效果。

⚠️ **漏登记的后果不是「少过滤一点」，而是应用启动直接失败** ——
`assertTenantScopedModelsRegistered()` 会在 `onModuleInit` 里硬失败。

- [ ] **Step 4：加 getter**

Modify `api/src/common/tenant/tenant-prisma.service.ts`，在
`// ------- 抽佣流水（阶段 5e）模型 delegate 代理 -------` 那段下面加：

```ts
  // ------- 结算单（阶段 5g）模型 delegate 代理 -------

  get settlementStatement() {
    return this.client.settlementStatement;
  }

  get settlementStatementEntry() {
    return this.client.settlementStatementEntry;
  }
```

- [ ] **Step 5：应用迁移 + 生成 client**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"

# 1. 应用到开发库
# ⚠️ **宿主机没有 psql**（`which psql` 为空）—— 走容器里的（项目先例，见 plan-01）：
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce \
  < prisma/migrations/20261028190000_add_settlement_statements/migration.sql

# 2. 登记（否则容器里的 migrate deploy 会再跑一遍 → "table already exists"）
npx prisma migrate resolve --applied 20261028190000_add_settlement_statements

# 3. 重新生成 client（新的枚举与模型类型）
npx prisma generate

# 4. 类型检查
npx tsc --noEmit
```

⚠️ **不需要跑 `prisma migrate diff` 做对照** —— Step 2 的 SQL 已经完整手写。
（若要对照，diff 需要 `--shadow-database-url`，而且它的输出**不能直接用**：
会把阶段 2/5a 的**手写部分唯一索引**当成漂移输出成 DROP INDEX，删了会导致
后续 `migrate deploy` 失败。这个坑项目里已经踩过两次。）

⚠️ **第 2 步不能省**：不登记的话，容器启动时的 `prisma migrate deploy`
会再执行一遍这份 SQL → 报表已存在 → 容器起不来。

⚠️ **测试库不用手动处理**：`npm test` 会先跑 `node test/deploy-test-db.mjs`
（内部是 `prisma migrate deploy`）→ 自动应用 ✅。

- [ ] **Step 6：验证应用能起来**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests
```

Expected: 全部通过（单测 186 条不变 —— 本 Task 没改任何业务代码）。

⚠️ **如果单测报「表不存在」** → 测试库还没应用新迁移。跑一次
`cd api && npm run db:test:deploy`（内部是 `prisma migrate deploy`）。

⚠️ **如果单测报「模型没登记」之类的启动错误**，说明 Step 3 或 Step 4 漏了。

- [ ] **Step 7：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/prisma/schema.prisma api/prisma/migrations/20261028190000_add_settlement_statements/migration.sql api/src/common/tenant/tenant-models.ts api/src/common/tenant/tenant-prisma.service.ts
git commit -m "feat(api): 结算单的两张表——单据头 + 流水明细关联"
```

---

## Task 2：纯函数（周期解析 + 金额聚合）

**Files:**
- Create: `api/src/modules/billing/settlement.ts`
- Create: `api/src/modules/billing/settlement.spec.ts`

- [ ] **Step 1：写失败的测试**

Create `api/src/modules/billing/settlement.spec.ts`：

```ts
import { BadRequestException } from '@nestjs/common';
import { CommissionEntryType } from '@prisma/client';

import {
  formatPeriodLabel,
  resolveMonthlyPeriod,
  summarizeEntries,
} from './settlement';

/**
 * 结算单的纯函数（阶段 5g）。
 *
 * ⚠️ **断言要具体**：断言每个分支的确切结果，不是「返回了一个布尔值」。
 * 周期解析与金额聚合是「结算单」与「收入报表」之间的**同一套口径**的载体 ——
 * 两者漂移了，账就对不上（对账 e2e 会红）。
 */
describe('自然月周期的解析', () => {
  it('2026-10 → [10-01, 11-01)（UTC）', () => {
    const period = resolveMonthlyPeriod('2026-10');
    expect(period.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(period.label).toBe('2026-10');
  });

  it('2026-01 → [01-01, 02-01)', () => {
    const period = resolveMonthlyPeriod('2026-01');
    expect(period.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('⚠️ 2026-12 → 终点跨年到 2027-01-01', () => {
    const period = resolveMonthlyPeriod('2026-12');
    expect(period.from.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('⚠️ 区间是左闭右开：2 月的终点就是 3 月的起点', () => {
    const feb = resolveMonthlyPeriod('2026-02');
    const mar = resolveMonthlyPeriod('2026-03');
    expect(feb.to.getTime()).toBe(mar.from.getTime());
  });

  it.each(['2026-13', '2026-00', '2026-1', '2026-10-01', 'abc', '', '2026-1a'])(
    '非法周期 %s → 抛 BadRequestException',
    (input) => {
      expect(() => resolveMonthlyPeriod(input)).toThrow(BadRequestException);
    },
  );

  it('⚠️ 闰年的 2 月终点是 3 月 1 日（2 月 29 日也在区间内）', () => {
    const period = resolveMonthlyPeriod('2028-02');
    expect(period.from.toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });
});

describe('结算单金额的聚合', () => {
  it('只有抽佣 → 毛额 = 抽佣，冲回 = 0，净额 = 毛额', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.COMMISSION, amount: 100 },
      { type: CommissionEntryType.COMMISSION, amount: 200 },
    ]);
    expect(amounts.grossAmount).toBe(300);
    expect(amounts.reversalAmount).toBe(0);
    expect(amounts.netAmount).toBe(300);
    expect(amounts.entryCount).toBe(2);
  });

  it('⚠️ 只有冲回 → 净额是负数（不是 0）', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.REVERSAL, amount: -150 },
    ]);
    expect(amounts.grossAmount).toBe(0);
    // ⚠️ **冲回保留负号**：流水的 amount 本身就是负数（5e 的 N2 护栏）
    expect(amounts.reversalAmount).toBe(-150);
    expect(amounts.netAmount).toBe(-150);
    expect(amounts.entryCount).toBe(1);
  });

  it('抽佣 + 冲回 → 净额 = 毛额 + 冲回（冲回是负数，不取负）', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.COMMISSION, amount: 100 },
      { type: CommissionEntryType.REVERSAL, amount: -30 },
    ]);
    expect(amounts.grossAmount).toBe(100);
    expect(amounts.reversalAmount).toBe(-30);
    expect(amounts.netAmount).toBe(70);
    expect(amounts.entryCount).toBe(2);
  });

  it('⚠️ 一抽佣一冲回金额相等 → 净额为 0（不是缺数据）', () => {
    const amounts = summarizeEntries([
      { type: CommissionEntryType.COMMISSION, amount: 100 },
      { type: CommissionEntryType.REVERSAL, amount: -100 },
    ]);
    expect(amounts.netAmount).toBe(0);
    expect(amounts.entryCount).toBe(2);
  });

  it('空 → 三个数都是 0，笔数 0', () => {
    const amounts = summarizeEntries([]);
    expect(amounts.grossAmount).toBe(0);
    expect(amounts.reversalAmount).toBe(0);
    expect(amounts.netAmount).toBe(0);
    expect(amounts.entryCount).toBe(0);
  });
});

describe('周期标识的回写', () => {
  it('从周期起点反推出 YYYY-MM', () => {
    expect(formatPeriodLabel(new Date('2026-10-01T00:00:00.000Z'))).toBe(
      '2026-10',
    );
  });

  it('⚠️ 单月要补零（1 月不是「2026-1」）', () => {
    expect(formatPeriodLabel(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01',
    );
  });

  it('12 月不补零到 13', () => {
    expect(formatPeriodLabel(new Date('2026-12-01T00:00:00.000Z'))).toBe(
      '2026-12',
    );
  });
});
```

- [ ] **Step 2：跑测试，确认失败**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest src/modules/billing/settlement.spec.ts
```

Expected: FAIL —— `Cannot find module './settlement'`。

- [ ] **Step 3：写实现**

Create `api/src/modules/billing/settlement.ts`：

```ts
import { BadRequestException } from '@nestjs/common';
import { CommissionEntryType } from '@prisma/client';

/**
 * 结算单的纯函数（阶段 5g）。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文。
 * 与 `commission.ts`（抽佣计算）同款理由 ——
 * **计钱的每一条分支都要能被完整断言**。
 *
 * ⚠️ **全程整数域**：金额一律整数分。
 */

/** 一个自然月的区间 */
export interface MonthlyPeriod {
  /** 区间起点（含）。该月 1 日 00:00:00.000Z */
  from: Date;
  /** 区间终点（不含）。次月 1 日 00:00:00.000Z */
  to: Date;
  /** 周期标识（`YYYY-MM`） */
  label: string;
}

/**
 * `YYYY-MM` → 该自然月的区间（左闭右开）。
 *
 * ⚠️ **为什么用 `YYYY-MM` 而不是 `from` / `to`**：
 * 调用方自己算月边界容易算错（时区、月末是 30 号还是 31 号），
 * 而「2026 年 10 月」是超管的真实心智。用 `YYYY-MM` 后，
 * **月边界只由后端算一次**，前端与 CLI 都不需要知道月末是几号。
 *
 * ⚠️ **为什么是左闭右开 `[from, to)`**：
 * 相邻两期不重不漏 —— 与 `ReportService.resolveWindow` 同一套区间语义。
 */
export function resolveMonthlyPeriod(period: string): MonthlyPeriod {
  const matched = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!matched) {
    throw new BadRequestException('周期格式非法：必须是 YYYY-MM（如 2026-10）');
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  // ⚠️ **`Date.UTC` 的月份是从 0 起的**：`month - 1` 是本月，`month` 是次月。
  //    写错就是差一个月（10 月的区间算成 11 月）。
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return { from, to, label: period };
}

/**
 * 从周期起点反推出周期标识。
 *
 * ⚠️ **用 UTC 的年月日**：整个系统的时间都是 UTC
 * （数据库的 `now()`、流水的 `occurredAt`），用本地时区会差 8 小时。
 */
export function formatPeriodLabel(periodStart: Date): string {
  const year = periodStart.getUTCFullYear();
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** 一笔待纳入结算单的流水（只需要类型与金额） */
export interface SettleableEntry {
  type: CommissionEntryType;
  /** 带符号：抽佣为正、冲回为负 */
  amount: number;
}

/** 结算单的三个金额 */
export interface SettlementAmounts {
  /** 抽佣毛额（整数分）。恒 >= 0 */
  grossAmount: number;
  /** 退款冲回（整数分）。恒 <= 0 */
  reversalAmount: number;
  /** 净额 = grossAmount + reversalAmount。**可以是负数** */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
}

/**
 * 把一批流水算成结算单的三个金额。
 *
 * ⚠️ **冲回不要再取一次负**：流水的 `REVERSAL.amount` 本身就是负数
 * （5e 的 N2 护栏），再取负会让净额翻倍。
 *
 * ⚠️ **净额可以是负数**：某商家本期只有一笔退款冲回、没有新的抽佣，
 * 那这一期平台「倒欠」商家钱。负数是合法结果，不是错误。
 */
export function summarizeEntries(entries: SettleableEntry[]): SettlementAmounts {
  let grossAmount = 0;
  let reversalAmount = 0;
  for (const entry of entries) {
    if (entry.type === CommissionEntryType.COMMISSION) {
      grossAmount += entry.amount;
    } else {
      reversalAmount += entry.amount;
    }
  }
  return {
    grossAmount,
    reversalAmount,
    netAmount: grossAmount + reversalAmount,
    entryCount: entries.length,
  };
}
```

- [ ] **Step 4：跑测试，确认通过**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest src/modules/billing/settlement.spec.ts
```

Expected: PASS，19 条（周期解析 11 + 金额聚合 5 + 周期标识 3）。

- [ ] **Step 5：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/settlement.ts api/src/modules/billing/settlement.spec.ts
git commit -m "feat(api): 结算单的周期解析与金额聚合（纯函数）"
```

---

## Task 3：服务层 —— 生成

**Files:**
- Create: `api/src/modules/billing/settlement.service.ts`

- [ ] **Step 1：新建 `api/src/modules/billing/settlement.service.ts`**

```ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  SettlementStatus,
  type CommissionEntry,
  type SettlementStatement,
} from '@prisma/client';

import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import {
  formatPeriodLabel,
  resolveMonthlyPeriod,
  summarizeEntries,
  type MonthlyPeriod,
} from './settlement';

/** 结算单对外的形状（列表与详情共用） */
export interface SettlementView {
  id: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  statementNo: string;
  /** 周期起点（含）。ISO 8601 */
  periodStart: string;
  /** 周期终点（不含）。ISO 8601 */
  periodEnd: string;
  /** 周期标识（`YYYY-MM`） */
  periodLabel: string;
  /** 抽佣毛额（整数分） */
  grossAmount: number;
  /** 退款冲回（整数分，负数） */
  reversalAmount: number;
  /** 净额（整数分，可以是负数） */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
  status: SettlementStatus;
  /** 确认时间。ISO 8601。null = 未确认 */
  confirmedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
}

/** 生成结算单的结果 */
export interface GenerateSettlementResult {
  /** 本次涉及的商家对应的单据（新建的 + 因幂等而复用的） */
  items: SettlementView[];
  /** 新建了几张 */
  created: number;
  /** 因「该期已有单据」而复用了几张 */
  skipped: number;
}

/** 单号撞了最多重试几次 */
const MAX_NUMBER_ATTEMPTS = 5;

/**
 * 结算单的服务（阶段 5g）。
 *
 * ⚠️ **数据只从 `commission_entries` 来**，不从订单重新聚合 ——
 *    报表那套口径抄一遍必然漂（设计文档 §2.1）。
 *
 * ⚠️ **必须显式走平台作用域**（跨租户聚合）：控制器上的 `@Roles` 管的是
 * 「谁能调」，管不了「service 在什么作用域里查库」。
 * 不显式声明的话，被商家上下文调用时会**静默只统计一个租户的数据**。
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 生成某期的结算单。
   *
   * ⚠️ **周期必须已结束**（设计 D7）：周期内的流水还会变，
   *    此时的数字不是凭证。周期末流水本就齐了（抽佣按支付期、冲回按退款期、
   *    迟到的支付按 `paidAt` 归期），生成即完整。
   *
   * ⚠️ **幂等**：同一商家同一周期重复生成 → **返回既有单据**，不产生第二张。
   *
   * @param tenantId 缺省 = 该期**所有有流水的商家**
   */
  async generate(input: {
    period: string;
    tenantId?: string;
  }): Promise<GenerateSettlementResult> {
    const period = resolveMonthlyPeriod(input.period);

    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **周期校验用数据库的时钟**（护栏 M15 的同款理由）：
      //    多副本部署时各机器的时钟有偏差，边界时刻会摇摆。
      const now = await this.prisma.databaseNow();
      if (period.to.getTime() > now.getTime()) {
        throw new BadRequestException(
          `周期 ${period.label} 尚未结束，不能出结算单`,
        );
      }

      const tenantIds = input.tenantId
        ? [input.tenantId]
        : await this.merchantIdsWithEntriesInPeriod(period);

      const items: SettlementView[] = [];
      let created = 0;
      let skipped = 0;

      for (const tenantId of tenantIds) {
        const outcome = await this.generateOne(tenantId, period, now);

        if (outcome.kind === 'empty') {
          // ⚠️ **显式点名了商家而这家本期没流水 → 404**：
          //    超管明确点了名，「这家没流水」是要知道的事实。
          //    批量时静默跳过 —— 不能因为一个商家没流水就中断整批。
          if (input.tenantId) {
            throw new NotFoundException(
              `该商家在 ${period.label} 没有抽佣流水，无法生成结算单`,
            );
          }
          continue;
        }

        items.push(outcome.view);
        if (outcome.kind === 'created') created += 1;
        else skipped += 1;
      }

      return { items, created, skipped };
    });
  }

  /**
   * 给一个商家生成一张单（幂等）。
   *
   * ⚠️ **撞号处理在事务外**：事务一旦因 P2002 失败就回滚了，
   *    在事务里查「目标单据在不在」是查不出真相的。
   */
  private async generateOne(
    tenantId: string,
    period: MonthlyPeriod,
    now: Date,
  ): Promise<
    | { kind: 'created'; view: SettlementView }
    | { kind: 'reused'; view: SettlementView }
    | { kind: 'empty' }
  > {
    // ---- 先查后插：这一期已经有单据 → 幂等复用 ----
    const existing = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart: period.from },
    });
    if (existing) {
      const view = await this.toView(existing);
      return { kind: 'reused', view };
    }

    // ---- 取该商家该期的流水 ----
    const entries = await this.entriesInPeriod(tenantId, period);
    if (entries.length === 0) {
      return { kind: 'empty' };
    }

    const amounts = summarizeEntries(entries);

    // ---- 建单据 + 关联行（一个事务） ----
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
      const statementNo = generateStatementNo(now);
      try {
        const statement = await this.prisma.$transaction(
          async (tx) => {
            const created = await tx.settlementStatement.create({
              data: {
                tenantId,
                statementNo,
                periodStart: period.from,
                periodEnd: period.to,
                grossAmount: amounts.grossAmount,
                reversalAmount: amounts.reversalAmount,
                netAmount: amounts.netAmount,
                entryCount: amounts.entryCount,
                status: SettlementStatus.DRAFT,
              },
            });
            await tx.settlementStatementEntry.createMany({
              data: entries.map((entry) => ({
                statementId: created.id,
                entryId: entry.id,
              })),
            });
            return created;
          },
          { maxWait: 10_000, timeout: 10_000 },
        );
        const view = await this.toView(statement);
        return { kind: 'created', view };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // ⚠️ **不靠 `error.meta.target` 判别**（`InvoiceService` 的做法在
        //    不同驱动版本下形状不一致），而是**重新查一次目标单据**：
        //    它现在存在 → 撞的是 `(tenantId, periodStart)` → 并发下别人先生成了
        //    → 幂等返回它；它不存在 → 撞的是 `statementNo` → 换个号再来。
        const raced = await this.prisma.settlementStatement.findFirst({
          where: { tenantId, periodStart: period.from },
        });
        if (raced) {
          const view = await this.toView(raced);
          return { kind: 'reused', view };
        }
        this.logger.warn(
          `结算单号 ${statementNo} 撞号，换一个号重试（第 ${attempt + 1} 次）`,
        );
      }
    }

    // ⚠️ **连撞 5 次说明随机数有问题**（或有别的进程在批量生成），
    //    此时抛错比「静默不出单据」好 —— 后者会让商家永远结不了账。
    throw new Error('生成结算单号失败：连续多次撞上唯一索引');
  }

  /** 该期有流水的商家 id 列表 */
  private async merchantIdsWithEntriesInPeriod(
    period: MonthlyPeriod,
  ): Promise<string[]> {
    const rows = await this.prisma.commissionEntry.groupBy({
      by: ['tenantId'],
      where: { occurredAt: { gte: period.from, lt: period.to } },
    });
    return rows.map((row) => row.tenantId);
  }

  /** 某商家某期的流水（左闭右开） */
  private async entriesInPeriod(
    tenantId: string,
    period: MonthlyPeriod,
  ): Promise<CommissionEntry[]> {
    return this.prisma.commissionEntry.findMany({
      where: {
        tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /**
   * 把一行结算单变成对外的形状（含商家名与子域名）。
   *
   * ⚠️ **商家名要单独查**：`SettlementStatement.tenantId` 是纯标量、
   * 没声明 Prisma 关系 → 拿不到商家名。
   * （`Tenant` **不在** `TENANT_SCOPED_MODELS` 白名单里，任何作用域都能查。）
   */
  private async toView(statement: SettlementStatement): Promise<SettlementView> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: statement.tenantId },
      select: { name: true, subdomain: true },
    });
    return this.toViewFields(statement, {
      // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行
      //（「有个商家产生了抽佣但查不到它的信息」是超管必须知道的事实）。
      name: tenant?.name ?? statement.tenantId,
      // ⚠️ **子域名查不到时给「—」**：空串看不出是「商家不存在」还是「数据缺失」。
      subdomain: tenant?.subdomain ?? '—',
    });
  }

  /** 单据本体 → 对外字段（不含商家信息） */
  private toViewFields(
    statement: SettlementStatement,
    tenant: { name: string; subdomain: string },
  ): SettlementView {
    return {
      id: statement.id,
      tenantId: statement.tenantId,
      tenantName: tenant.name,
      subdomain: tenant.subdomain,
      statementNo: statement.statementNo,
      periodStart: statement.periodStart.toISOString(),
      periodEnd: statement.periodEnd.toISOString(),
      periodLabel: formatPeriodLabel(statement.periodStart),
      grossAmount: statement.grossAmount,
      reversalAmount: statement.reversalAmount,
      netAmount: statement.netAmount,
      entryCount: statement.entryCount,
      status: statement.status,
      confirmedAt: statement.confirmedAt?.toISOString() ?? null,
      createdAt: statement.createdAt.toISOString(),
    };
  }
}

/**
 * 生成结算单号。
 *
 * ⚠️ **服务端生成**：结算单号不是秘密（它出现在对账单里），
 * 但**不能由客户端指定** —— 否则「A 单号对应 B 商家的账」就可能发生。
 *
 * ⚠️ **秒级时间戳 + 4 位随机数**：同一秒内生成 10000 张才会撞一次。
 */
function generateStatementNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `STL${stamp}${random}`;
}
```

⚠️ **`CommissionEntryType` 刻意不在这个文件里 import** ——
`summarizeEntries` 的参数类型 `SettleableEntry` 用的是它，但 service 里不需要
（Task 5 加 `SettlementDetailView` 时才把它加回来）。

⚠️ **`BadRequestException` / `NotFoundException` 都要用** —— 上面 import 了。

- [ ] **Step 2：类型检查 + lint**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
npx eslint src/modules/billing/settlement.service.ts
```

Expected: 两条都无输出。

⚠️ **如果 `SettlementStatus` / `SettlementStatement` 类型报「不存在」**，
说明 Task 1 的 `npx prisma generate` 没跑或没生效 → 重跑。

- [ ] **Step 3：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/settlement.service.ts
git commit -m "feat(api): 结算单的生成——按商家 × 自然月聚拢抽佣流水"
```

---

## Task 4：服务层 —— 重算 / 确认 / 取消确认

**Files:**
- Modify: `api/src/modules/billing/settlement.service.ts`

- [ ] **Step 1：加 `recalculate` / `confirm` / `unconfirm` 三个方法**

在 `SettlementService` 类的 `generate` 方法**之后**插入：

```ts
  /**
   * 重算：重新聚合该商家该期的流水。
   *
   * ⚠️ **只有 `DRAFT` 能重算**：`CONFIRMED` 的单据是冻结的，
   *    要改先「取消确认」。已确认的单据被悄悄改掉，
   *    超管手里那份就与系统里的对不上了。
   *
   * ⚠️ **必须先删旧的关联行**：不删的话 `entryId` 的唯一约束会让
   *    重新插入撞上**自己**（上一轮已经关联过同一批流水）→ 整批失败。
   */
  async recalculate(statementId: string): Promise<SettlementView> {
    return tenantContext.run(platformScope(), async () => {
      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (statement.status !== SettlementStatus.DRAFT) {
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能重算。请先取消确认。`,
        );
      }

      const period: MonthlyPeriod = {
        from: statement.periodStart,
        to: statement.periodEnd,
        label: formatPeriodLabel(statement.periodStart),
      };
      const entries = await this.entriesInPeriod(statement.tenantId, period);
      const amounts = summarizeEntries(entries);

      const updated = await this.prisma.$transaction(
        async (tx) => {
          await tx.settlementStatementEntry.deleteMany({
            where: { statementId: statement.id },
          });
          await tx.settlementStatementEntry.createMany({
            data: entries.map((entry) => ({
              statementId: statement.id,
              entryId: entry.id,
            })),
          });
          // ⚠️ **条件更新**：where 带 `status` —— 并发重算时只有一个能成功。
          const affected = await tx.settlementStatement.updateMany({
            where: { id: statement.id, status: SettlementStatus.DRAFT },
            data: {
              grossAmount: amounts.grossAmount,
              reversalAmount: amounts.reversalAmount,
              netAmount: amounts.netAmount,
              entryCount: amounts.entryCount,
            },
          });
          if (affected.count === 0) {
            throw new ConflictException('结算单状态已变，不能重算');
          }
          const rows = await tx.settlementStatement.findFirst({
            where: { id: statement.id },
          });
          if (!rows) {
            throw new NotFoundException('结算单不存在');
          }
          return rows;
        },
        { maxWait: 10_000, timeout: 10_000 },
      );

      return this.toView(updated);
    });
  }

  /**
   * 确认：`DRAFT → CONFIRMED`。
   *
   * ⚠️ **幂等**：重复确认原样返回，不报错。
   * ⚠️ **条件更新**（where 带 `status`）—— 两次并发确认不能都成功。
   */
  async confirm(statementId: string): Promise<SettlementView> {
    return tenantContext.run(platformScope(), async () => {
      const now = await this.prisma.databaseNow();
      const affected = await this.prisma.settlementStatement.updateMany({
        where: { id: statementId, status: SettlementStatus.DRAFT },
        data: { status: SettlementStatus.CONFIRMED, confirmedAt: now },
      });

      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (affected.count === 0) {
        // ⚠️ **已经是 CONFIRMED → 幂等返回**（不是报错）。
        if (statement.status === SettlementStatus.CONFIRMED) {
          return this.toView(statement);
        }
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能确认`,
        );
      }
      return this.toView(statement);
    });
  }

  /**
   * 取消确认：`CONFIRMED → DRAFT`。
   *
   * ⚠️ **为什么需要它**：漏结（已确认的单据之后又有该期的流水进来，
   *    比如跑了一次 `npm run backfill:commissions`）是死账 ——
   *    没有回退路径就永远修不好。退回来重算一次即可修正（设计 D6）。
   *
   * ⚠️ **`PAID` 不能取消**：已出款的单据退回来，改动的钱已经打给商家了。
   *    （本阶段不出款，这条是给将来出款阶段留的闸。）
   */
  async unconfirm(statementId: string): Promise<SettlementView> {
    return tenantContext.run(platformScope(), async () => {
      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (statement.status !== SettlementStatus.CONFIRMED) {
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能取消确认`,
        );
      }

      await this.prisma.settlementStatement.updateMany({
        where: { id: statementId, status: SettlementStatus.CONFIRMED },
        data: { status: SettlementStatus.DRAFT, confirmedAt: null },
      });

      const after = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!after) {
        throw new NotFoundException('结算单不存在');
      }
      return this.toView(after);
    });
  }
```

- [ ] **Step 2：补 import**

文件顶部的 `@nestjs/common` import 要加上 `ConflictException`：

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
```

- [ ] **Step 3：类型检查 + lint**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
npx eslint src/modules/billing/settlement.service.ts
```

Expected: 两条都无输出。

- [ ] **Step 4：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/settlement.service.ts
git commit -m "feat(api): 结算单的状态流转——重算 / 确认 / 取消确认"
```

---

## Task 5：服务层查询 + 端点 + DTO + 模块注册

**Files:**
- Modify: `api/src/modules/billing/settlement.service.ts`（加 `list` / `detail`）
- Create: `api/src/modules/billing/dto/create-settlement.dto.ts`
- Create: `api/src/modules/billing/dto/settlement-list-query.dto.ts`
- Create: `api/src/modules/billing/platform-settlement.controller.ts`
- Modify: `api/src/modules/billing/billing.module.ts`

- [ ] **Step 1：加 `list` 与 `detail` 两个方法**

在 `SettlementService` 类的 `unconfirm` 方法**之后**插入：

```ts
  /**
   * 结算单列表。
   *
   * ⚠️ **`total` 要是真实总数，不能用 `items.length`**：
   * `items` 被 `pageSize` 截断了，超管看到「总共 50 条」会以为平台只有 50 张单。
   * （与 `ReportService.listSubscriptions` 的同款理由。）
   */
  async list(input: {
    period?: string;
    status?: SettlementStatus;
    page: number;
    pageSize: number;
  }): Promise<{ items: SettlementView[]; total: number }> {
    const where: {
      periodStart?: Date;
      status?: SettlementStatus;
    } = {};
    if (input.period) {
      // ⚠️ **`period` 精确匹配 `periodStart`**：自然月的起点唯一。
      where.periodStart = resolveMonthlyPeriod(input.period).from;
    }
    if (input.status) {
      where.status = input.status;
    }

    return tenantContext.run(platformScope(), async () => {
      const [rows, total] = await Promise.all([
        this.prisma.settlementStatement.findMany({
          where,
          orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        this.prisma.settlementStatement.count({ where }),
      ]);
      return { items: await this.toViews(rows), total };
    });
  }

  /**
   * 结算单详情（含明细）。
   *
   * ⚠️ **明细的金额从流水 join 出来，不做快照**：
   * 流水是 append-only 的（不软删、不改），金额永不变 →
   * join 出来的值与生成时算的值必然一致。多存一份就是第二处数字来源。
   */
  async detail(statementId: string): Promise<SettlementDetailView> {
    return tenantContext.run(platformScope(), async () => {
      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }

      const links = await this.prisma.settlementStatementEntry.findMany({
        where: { statementId },
      });
      const entryIds = links.map((link) => link.entryId);
      const entries =
        entryIds.length > 0
          ? await this.prisma.commissionEntry.findMany({
              where: { id: { in: entryIds } },
              orderBy: { occurredAt: 'asc' },
            })
          : [];
      const entryById = new Map(entries.map((entry) => [entry.id, entry]));

      const view = (await this.toViews([statement]))[0];

      return {
        ...view,
        entries: links.flatMap((link) => {
          const entry = entryById.get(link.entryId);
          // ⚠️ **查不到就跳过而不是崩**：关联行有外键 Restrict，
          //    正常情况下查不到；但崩掉整页比少显示一行糟得多。
          if (!entry) return [];
          return [
            {
              entryId: entry.id,
              orderNo: entry.orderNo,
              type: entry.type,
              amount: entry.amount,
              rateBps: entry.rateBps,
              baseAmount: entry.baseAmount,
              occurredAt: entry.occurredAt.toISOString(),
            },
          ];
        }),
      };
    });
  }

  /**
   * 批量把结算单变成对外的形状（商家名批量查，避免 N+1）。
   */
  private async toViews(rows: SettlementStatement[]): Promise<SettlementView[]> {
    if (rows.length === 0) {
      return [];
    }
    const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, subdomain: true },
    });
    const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]));

    return rows.map((row) => {
      const tenant = tenantById.get(row.tenantId);
      return this.toViewFields(row, {
        name: tenant?.name ?? row.tenantId,
        subdomain: tenant?.subdomain ?? '—',
      });
    });
  }
```

在文件顶部的类型声明区（`GenerateSettlementResult` 之后）加上：

```ts
/** 结算单详情（含明细行） */
export interface SettlementDetailView extends SettlementView {
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: CommissionEntryType;
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
}
```

⚠️ **这一步要把 `CommissionEntryType` 的 import 加回来**（Task 3 里删掉过）：

```ts
import {
  CommissionEntryType,
  SettlementStatus,
  type CommissionEntry,
  type SettlementStatement,
} from '@prisma/client';
```

- [ ] **Step 2：写 DTO**

Create `api/src/modules/billing/dto/create-settlement.dto.ts`：

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * 生成结算单的请求体。
 *
 * ⚠️ **请求体里没有任何金额字段**：结算单的金额**只从流水算**，
 * 客户端传什么都不作数（全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，
 * 多传的键直接 400）。
 *
 * ⚠️ **`period` 是 `YYYY-MM` 而不是 `from` / `to`**：
 * 月边界只由后端算一次，前端不需要知道月末是 30 号还是 31 号。
 */
export class CreateSettlementDto {
  @ApiProperty({
    description: '结算周期（自然月，UTC）。必须是 YYYY-MM',
    example: '2026-10',
  })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: '周期格式非法：必须是 YYYY-MM（如 2026-10）',
  })
  period!: string;

  @ApiPropertyOptional({
    description: '指定商家。缺省 = 该期所有有流水的商家',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
```

Create `api/src/modules/billing/dto/settlement-list-query.dto.ts`：

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { SettlementStatus } from '@prisma/client';

/**
 * 结算单列表的查询参数。
 *
 * ⚠️ **`page` / `pageSize` 用 `@Type(() => Number)` 转一下**：
 * query 参数全是字符串，不转的话 `@IsInt()` 永远不通过。
 */
export class SettlementListQueryDto {
  @ApiPropertyOptional({
    description: '结算周期（自然月，UTC）。缺省 = 全部周期',
    example: '2026-10',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: '周期格式非法：必须是 YYYY-MM（如 2026-10）',
  })
  period?: string;

  @ApiPropertyOptional({
    description: '按状态筛选。缺省 = 全部状态',
    enum: ['DRAFT', 'CONFIRMED', 'PAID'],
  })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;

  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
```

- [ ] **Step 3：写控制器**

Create `api/src/modules/billing/platform-settlement.controller.ts`：

```ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { SettlementListQueryDto } from './dto/settlement-list-query.dto';
import { SettlementService } from './settlement.service';

/**
 * 平台超管的结算单。
 *
 * ⚠️ **路径带 `platform/` 前缀** —— 与 `PlatformReportController`、
 * `PlatformBillingController` 同款理由：消费者侧与平台侧的鉴权方式
 * 根本不同，同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：商家账号调这些接口要 403（护栏 S8）。
 * `@Roles` 装饰器自带 `JwtAuthGuard`，未登录得 401。
 */
@ApiTags('platform-settlement')
@Controller('platform')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformSettlementController {
  constructor(private readonly settlements: SettlementService) {}

  @Get('settlements')
  @ApiOperation({ summary: '结算单列表' })
  async list(@Query() query: SettlementListQueryDto) {
    return this.settlements.list({
      period: query.period,
      status: query.status,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Post('settlements')
  @ApiOperation({ summary: '生成结算单（缺省 = 该期所有有流水的商家）' })
  async generate(@Body() body: CreateSettlementDto) {
    return this.settlements.generate({
      period: body.period,
      tenantId: body.tenantId,
    });
  }

  @Get('settlements/:id')
  @ApiOperation({ summary: '结算单详情（含明细）' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.detail(id);
  }

  @Post('settlements/:id/confirm')
  @ApiOperation({ summary: '确认结算单（DRAFT → CONFIRMED，幂等）' })
  async confirm(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.confirm(id);
  }

  @Post('settlements/:id/unconfirm')
  @ApiOperation({ summary: '取消确认（CONFIRMED → DRAFT）' })
  async unconfirm(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.unconfirm(id);
  }

  @Post('settlements/:id/recalculate')
  @ApiOperation({ summary: '重算结算单（仅 DRAFT）' })
  async recalculate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.recalculate(id);
  }
}
```

⚠️ **`ParseUUIDPipe`**：id 是 uuid，非法 id 会让 Prisma 抛 P2023 → 500。
加上它 → 400 ✅。

- [ ] **Step 4：注册到模块**

Modify `api/src/modules/billing/billing.module.ts`：

import 段加：

```ts
import { PlatformSettlementController } from './platform-settlement.controller';
import { SettlementService } from './settlement.service';
```

`controllers` 数组加 `PlatformSettlementController`，
`providers` 数组加 `SettlementService`，
`exports` 数组加 `SettlementService`。

⚠️ **类注释里也要提一句这个新服务**（那个文件对每个 provider 都有解释为什么导出）。

- [ ] **Step 5：类型检查 + lint**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
npx eslint src/modules/billing/
```

Expected: 两条都无输出。

- [ ] **Step 6：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/settlement.service.ts api/src/modules/billing/dto/create-settlement.dto.ts api/src/modules/billing/dto/settlement-list-query.dto.ts api/src/modules/billing/platform-settlement.controller.ts api/src/modules/billing/billing.module.ts
git commit -m "feat(api): 结算单的查询端点与平台控制器"
```

---

## Task 6：e2e（护栏 S1–S12）

**Files:**
- Create: `api/test/settlement.e2e-spec.ts`

- [ ] **Step 1：写 e2e**

Create `api/test/settlement.e2e-spec.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import {
  CommissionEntryType,
  OrderStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 平台侧的结算单（阶段 5g）。
 *
 * 覆盖的护栏（编号见设计文档 §六·6.1）：S1–S12。
 *
 * ⚠️ **月份一律用 2022 年**：`billing-report.e2e-spec.ts` 的报表用例从
 * 2020-01-01 起每 60 天发一块区间，占到 2021 年底 —— 结算单若也用
 * 2020-2021 的月份，两边的数据会互相串。
 *
 * ⚠️ **自己造流水行，不跑回填**：`CommissionService.backfill()` 会扫全表
 * `paidAt` 非空的订单补流水，跨文件影响不可控。直接造行也不受用例顺序影响。
 */

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

/** 一个自然月的区间（左闭右开） */
interface Period {
  label: string;
  from: Date;
  to: Date;
}

/** 造一个自然月区间 */
function month(label: string): Period {
  const [year, m] = label.split('-').map(Number);
  return {
    label,
    from: new Date(Date.UTC(year, m - 1, 1)),
    to: new Date(Date.UTC(year, m, 1)),
  };
}

/** 区间内的某个时刻（避开边界） */
function inside(period: Period, offsetDays: number): Date {
  return new Date(period.from.getTime() + offsetDays * DAY_MS);
}

/** 结算单的一行（响应体） */
interface StatementBody {
  id: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  statementNo: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  grossAmount: number;
  reversalAmount: number;
  netAmount: number;
  entryCount: number;
  status: string;
  confirmedAt: string | null;
  createdAt: string;
}

/** 列表响应体 */
interface StatementListBody {
  items: StatementBody[];
  total: number;
}

/** 生成接口的响应体 */
interface GenerateBody {
  items: StatementBody[];
  created: number;
  skipped: number;
}

/** 详情响应体 */
interface DetailBody extends StatementBody {
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
}

/** 报表响应体（对账用） */
interface ReportBody {
  commissionRevenue: number;
  reversal: number;
}

describe('平台侧的结算单 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
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

  /** 在平台作用域里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 平台超管登录（种子里已有这个账号） */
  async function loginPlatformAdmin(): Promise<string> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * 造一笔订单（**必须先有订单**，流水有指向它的外键 Restrict）。
   */
  async function seedOrder(
    tenantId: string,
    options: {
      status?: OrderStatus;
      totalAmount?: number;
      commissionRate?: number;
      commissionAmount?: number;
      paidAt?: Date | null;
      refundedAt?: Date | null;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `STL-ORD-${unique()}`,
          status: options.status ?? OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 20000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: options.commissionRate ?? 500,
          commissionAmount: options.commissionAmount ?? 0,
          // ⚠️ **不能用 `??`**：`null ?? x` 返回 `x`，那样「传 null 表示
          //    没付过钱」会被静默忽略。
          paidAt: options.paidAt === undefined ? new Date() : options.paidAt,
          refundedAt: options.refundedAt === undefined ? null : options.refundedAt,
        },
      }),
    );
    return created.id;
  }

  /**
   * 造一行抽佣流水。
   *
   * ⚠️ **`occurredAt` 是「业务发生时间」**：抽佣取支付时间、冲回取退款时间 ——
   *    与报表的归期口径逐字一致。
   */
  async function seedEntry(
    tenantId: string,
    orderId: string,
    options: {
      type: CommissionEntryType;
      amount: number;
      occurredAt: Date;
      rateBps?: number;
      baseAmount?: number;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId,
          orderNo: `STL-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          rateBps: options.rateBps ?? 500,
          baseAmount: options.baseAmount ?? 20000,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 生成结算单 */
  async function generate(
    token: string,
    period: string,
    tenantId?: string,
  ): Promise<GenerateBody> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${token}`)
      .send(tenantId ? { period, tenantId } : { period })
      .expect(201);
    return response.body as GenerateBody;
  }

  /** 拉列表 */
  async function fetchList(
    token: string,
    query: Record<string, string> = {},
  ): Promise<StatementListBody> {
    const params = new URLSearchParams(query);
    const suffix = params.toString();
    const response = await http(app)
      .get(`/api/v1/platform/settlements${suffix ? `?${suffix}` : ''}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as StatementListBody;
  }

  /** 拉详情 */
  async function fetchDetail(
    token: string,
    id: string,
  ): Promise<DetailBody> {
    const response = await http(app)
      .get(`/api/v1/platform/settlements/${id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as DetailBody;
  }

  /**
   * 拉某个月的收入报表（**区间显式传入**，不依赖后端的缺省窗口）。
   *
   * ⚠️ **报表是平台维度的聚合**：别的商家在同一个月的数据也在里面 →
   *    对账时必须先取「基线」再取「造数之后」，**比差值**而不是比绝对值。
   */
  async function fetchReport(
    token: string,
    period: Period,
  ): Promise<ReportBody> {
    const response = await http(app)
      .get(
        `/api/v1/platform/reports?from=${period.from.toISOString()}&to=${period.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as ReportBody;
  }

  // ============================================================
  // S1：只纳入该商家该自然月的流水
  // ============================================================

  it('S1：生成只纳入该商家该自然月的流水（上月、下月、别家都不进）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const other = await createMerchant(app, prisma);
    const period = month('2022-01');
    const previous = month('2021-12');
    const next = month('2022-02');

    const ownOrderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, ownOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    // 上月的流水 → 不该进 1 月的单
    const prevOrderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, prevOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 700,
      occurredAt: inside(previous, 10),
    });

    // 下月的流水 → 不该进 1 月的单
    const nextOrderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, nextOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 900,
      occurredAt: inside(next, 10),
    });

    // 别的商家的流水 → 不该进这家的单
    const otherOrderId = await seedOrder(other.tenantId, {});
    await seedEntry(other.tenantId, otherOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 800,
      occurredAt: inside(period, 12),
    });

    const body = await generate(adminToken, '2022-01', merchant.tenantId);

    expect(body.created).toBe(1);
    expect(body.items).toHaveLength(1);
    const statement = body.items[0];
    expect(statement.grossAmount).toBe(100);
    expect(statement.entryCount).toBe(1);
    expect(statement.tenantId).toBe(merchant.tenantId);
  });

  // ============================================================
  // S2：三个金额由后端算
  // ============================================================

  it('S2：毛额 / 冲回 / 净额由后端算，且与逐笔之和一致', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-02');

    const orderA = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    const orderB = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 200,
      occurredAt: inside(period, 6),
    });
    const orderC = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderC, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 7),
    });

    const body = await generate(adminToken, '2022-02', merchant.tenantId);
    const statement = body.items[0];

    expect(statement.grossAmount).toBe(300);
    expect(statement.reversalAmount).toBe(-30);
    expect(statement.netAmount).toBe(270);
    expect(statement.entryCount).toBe(3);

    // ⚠️ **净额必须等于逐笔之和**：前端/后端都不许自己另算一套
    const detail = await fetchDetail(adminToken, statement.id);
    const sum = detail.entries.reduce((acc, e) => acc + e.amount, 0);
    expect(sum).toBe(statement.netAmount);
  });

  // ============================================================
  // S3：同一商家同一周期只有一张单（幂等）
  // ============================================================

  it('S3：重复生成同一商家同一周期 → 返回同一张单，不产生第二张', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-03');

    const orderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const first = await generate(adminToken, '2022-03', merchant.tenantId);
    expect(first.created).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await generate(adminToken, '2022-03', merchant.tenantId);
    // ⚠️ **幂等不是报错**：重复生成返回既有单据
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.items[0].id).toBe(first.items[0].id);
    expect(second.items[0].statementNo).toBe(first.items[0].statementNo);

    // ⚠️ **库里也只有一张**
    const count = await asPlatform(() =>
      prisma.settlementStatement.count({
        where: { tenantId: merchant.tenantId, periodStart: period.from },
      }),
    );
    expect(count).toBe(1);
  });

  // ============================================================
  // S4：一笔流水只能被一期结算
  // ============================================================

  it('S4：一笔流水只被关联到一张单据上', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-04');

    const orderId = await seedOrder(merchant.tenantId, {});
    const entryId = await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    await generate(adminToken, '2022-04', merchant.tenantId);

    const links = await asPlatform(() =>
      prisma.settlementStatementEntry.findMany({
        where: { entryId },
      }),
    );
    expect(links).toHaveLength(1);
  });

  // ============================================================
  // S5：跨期冲回落退款期
  // ============================================================

  it('S5：1 月支付、3 月退款 → 冲回落在 3 月，3 月单净额为负', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const january = month('2022-01');
    const march = month('2022-03');

    const orderId = await seedOrder(merchant.tenantId, {
      status: OrderStatus.REFUNDED,
      commissionAmount: 100,
      paidAt: inside(january, 10),
      refundedAt: inside(march, 5),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(january, 10),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.REVERSAL,
      amount: -100,
      occurredAt: inside(march, 5),
    });

    const jan = await generate(adminToken, '2022-01', merchant.tenantId);
    const mar = await generate(adminToken, '2022-03', merchant.tenantId);

    // ⚠️ **1 月的单不受 3 月的退款影响**（冲回按退款时点归期）
    expect(jan.items[0].netAmount).toBe(100);
    expect(jan.items[0].grossAmount).toBe(100);
    expect(jan.items[0].reversalAmount).toBe(0);

    // ⚠️ **3 月的单净额为负**：那一期平台「倒欠」商家钱
    expect(mar.items[0].grossAmount).toBe(0);
    expect(mar.items[0].reversalAmount).toBe(-100);
    expect(mar.items[0].netAmount).toBe(-100);
  });

  // ============================================================
  // S6：重算只有 DRAFT 能做
  // ============================================================

  it('S6：CONFIRMED 的单据重算 → 409，DRAFT 的能重算', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-05');

    const orderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2022-05', merchant.tenantId);
    const id = body.items[0].id;

    // DRAFT 能重算
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    // 确认之后就不能重算了
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);
  });

  // ============================================================
  // S7：确认幂等；确认后冻结
  // ============================================================

  it('S7：确认幂等（重复确认不报错），确认后金额冻结', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-06');

    const orderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2022-06', merchant.tenantId);
    const id = body.items[0].id;

    const first = await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((first.body as StatementBody).status).toBe('CONFIRMED');
    expect((first.body as StatementBody).confirmedAt).toBeTruthy();

    // ⚠️ **重复确认 → 幂等，不报错**
    const second = await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((second.body as StatementBody).status).toBe('CONFIRMED');

    // ⚠️ **确认后再来一笔流水 → 金额不变**（冻结）
    const orderB = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 500,
      occurredAt: inside(period, 20),
    });

    const after = await fetchDetail(adminToken, id);
    expect(after.netAmount).toBe(100);
    expect(after.entryCount).toBe(1);
  });

  // ============================================================
  // S8：鉴权
  // ============================================================

  it('S8：商家账号调平台接口 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .get('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);

    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: '2022-01' })
      .expect(403);
  });

  it('S8：没登录 → 401', async () => {
    await http(app).get('/api/v1/platform/settlements').expect(401);
    await http(app)
      .post('/api/v1/platform/settlements')
      .send({ period: '2022-01' })
      .expect(401);
  });

  // ============================================================
  // S9：对账 —— 结算单净额之和 == 收入报表同期的抽佣净额
  // ============================================================

  it('S9：对账：某期结算单的净额 == 收入报表同期的「抽佣收入 − 冲回」', async () => {
    // ⚠️ **这是本阶段最有价值的护栏**：
    //    结算单从**流水**聚合，收入报表从**订单**聚合 ——
    //    两条独立的路径给出同一个数，才算账对得上。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const january = month('2022-01');
    const february = month('2022-02');

    // ---- 先取「基线」：造数据**之前**的报表值 ----
    //
    // ⚠️ **基线必须在造数据之前取**：报表是**平台维度**的聚合，
    //    别的 e2e 文件（以及本文件里先跑的用例）也可能在同一个月造数据 →
    //    绝对值会飘。**差值**才是「这个用例自己贡献了多少」。
    const janBefore = await fetchReport(adminToken, january);
    const febBefore = await fetchReport(adminToken, february);

    // ① 已支付未退款 → 1 月抽佣 100
    const orderA = await seedOrder(merchant.tenantId, {
      status: OrderStatus.PAID,
      totalAmount: 20000,
      commissionAmount: 100,
      paidAt: inside(january, 10),
    });
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(january, 10),
    });

    // ② 已支付已退款：1 月支付（抽佣 150）、2 月退款（冲回 -150）
    const orderB = await seedOrder(merchant.tenantId, {
      status: OrderStatus.REFUNDED,
      totalAmount: 30000,
      commissionAmount: 150,
      paidAt: inside(january, 11),
      refundedAt: inside(february, 5),
    });
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 150,
      occurredAt: inside(january, 11),
    });
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -150,
      occurredAt: inside(february, 5),
    });

    // ---- 生成两期的结算单 ----
    const jan = await generate(adminToken, '2022-01', merchant.tenantId);
    const feb = await generate(adminToken, '2022-02', merchant.tenantId);

    // ---- 再取一次报表 ----
    const janAfter = await fetchReport(adminToken, january);
    const febAfter = await fetchReport(adminToken, february);

    // ---- 逐期对账 ----
    //
    // ⚠️ **断言的是「差值」，不是绝对值**：
    //    结算单只含**这一家**（生成时显式点名了 tenantId），
    //    报表是**平台维度**的 —— 别的商家在同月的抽佣也在里面。
    //    所以两边都要先减掉基线，才是同一笔账。
    const janReportDelta =
      janAfter.commissionRevenue -
      janBefore.commissionRevenue -
      (janAfter.reversal - janBefore.reversal);
    const febReportDelta =
      febAfter.commissionRevenue -
      febBefore.commissionRevenue -
      (febAfter.reversal - febBefore.reversal);

    // ⚠️ **1 月**：本用例贡献了抽佣 250（100 + 150），冲回 0（退款在 2 月）
    expect(janReportDelta).toBe(250);
    expect(jan.items[0].netAmount).toBe(janReportDelta);
    expect(jan.items[0].netAmount).toBe(250);

    // ⚠️ **2 月**：本用例贡献了抽佣 0（没有 2 月支付的订单），冲回 150
    expect(febReportDelta).toBe(-150);
    expect(feb.items[0].netAmount).toBe(febReportDelta);
    expect(feb.items[0].netAmount).toBe(-150);

    // ⚠️ **两期合起来是 0**：这笔单对平台的净贡献就是 0
    expect(jan.items[0].netAmount + feb.items[0].netAmount).toBe(0);
  });

  // ============================================================
  // S10：零额与负额
  // ============================================================

  it('S10：净额为 0 的单据正常生成；净额为负的单据也是负数（不是 0）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-07');

    // 一抽佣一冲回，金额相等 → 净额 0
    const orderA = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.REVERSAL,
      amount: -100,
      occurredAt: inside(period, 6),
    });

    // 只有冲回 → 净额为负
    const orderB = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 7),
    });

    const body = await generate(adminToken, '2022-07', merchant.tenantId);
    const statement = body.items[0];

    expect(statement.grossAmount).toBe(100);
    expect(statement.reversalAmount).toBe(-130);
    expect(statement.netAmount).toBe(-30);
    expect(statement.entryCount).toBe(3);
  });

  // ============================================================
  // S11：周期未结束不能生成
  // ============================================================

  it('S11：周期尚未结束 → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    // ⚠️ **用一个肯定还没结束的月份**：2999 年
    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2999-01' })
      .expect(400);
  });

  it('S11：周期格式非法 → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2022-13' })
      .expect(400);
  });

  // ============================================================
  // S12：列表的 total 是真实总数
  // ============================================================

  it('S12：列表的 total 是真实总数（items 被 pageSize 截断，total 不能跟着截）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-08');

    const before = await asPlatform(() => prisma.settlementStatement.count());

    const orderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });
    await generate(adminToken, '2022-08', merchant.tenantId);

    const body = await fetchList(adminToken, { period: '2022-08' });
    expect(body.total).toBe(1);
    expect(body.items.length).toBeLessThanOrEqual(body.total);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('S12：列表可按周期与状态筛选', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-09');

    const orderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });
    const body = await generate(adminToken, '2022-09', merchant.tenantId);
    await http(app)
      .post(`/api/v1/platform/settlements/${body.items[0].id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    const drafts = await fetchList(adminToken, {
      period: '2022-09',
      status: 'DRAFT',
    });
    expect(drafts.items).toHaveLength(0);

    const confirmed = await fetchList(adminToken, {
      period: '2022-09',
      status: 'CONFIRMED',
    });
    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.items[0].tenantId).toBe(merchant.tenantId);
  });

  // ============================================================
  // 其它
  // ============================================================

  it('该商家本期没有流水 → 显式点名时 404，批量时静默跳过', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2022-10', tenantId: merchant.tenantId })
      .expect(404);

    // 批量：没有流水的商家不产生单据，也不报错
    const body = await generate(adminToken, '2022-10');
    expect(body.created).toBeGreaterThanOrEqual(0);
  });

  it('批量生成：该期所有有流水的商家各有一张单', async () => {
    const adminToken = await loginPlatformAdmin();
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const period = month('2022-11');

    const orderA = await seedOrder(a.tenantId, {});
    await seedEntry(a.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });
    const orderB = await seedOrder(b.tenantId, {});
    await seedEntry(b.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 200,
      occurredAt: inside(period, 11),
    });

    const body = await generate(adminToken, '2022-11');

    const mine = body.items.filter(
      (item) => item.tenantId === a.tenantId || item.tenantId === b.tenantId,
    );
    expect(mine).toHaveLength(2);
    expect(body.created).toBeGreaterThanOrEqual(2);
  });

  it('取消确认：CONFIRMED → DRAFT，且 DRAFT 不能取消确认', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-12');

    const orderId = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2022-12', merchant.tenantId);
    const id = body.items[0].id;

    // DRAFT 不能取消确认
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);

    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    const unconfirmed = await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((unconfirmed.body as StatementBody).status).toBe('DRAFT');
    expect((unconfirmed.body as StatementBody).confirmedAt).toBeNull();
  });

  it('重算：新的流水进来后重算，金额跟着变', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-03');

    const orderA = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2022-03', merchant.tenantId);
    const id = body.items[0].id;
    expect(body.items[0].netAmount).toBe(100);

    // ⚠️ **又来一笔同期的流水**（模拟回填补进来的历史流水）
    const orderB = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 250,
      occurredAt: inside(period, 20),
    });

    const recalculated = await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((recalculated.body as StatementBody).netAmount).toBe(350);
    expect((recalculated.body as StatementBody).entryCount).toBe(2);

    // ⚠️ **明细里不能有重复的行**（重算要先删旧的关联行）
    const detail = await fetchDetail(adminToken, id);
    expect(detail.entries).toHaveLength(2);
  });

  it('详情：明细里的每一行都能对上流水', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2022-02');

    const orderA = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    const orderB = await seedOrder(merchant.tenantId, {});
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 6),
    });

    const body = await generate(adminToken, '2022-02', merchant.tenantId);
    const detail = await fetchDetail(adminToken, body.items[0].id);

    expect(detail.entries).toHaveLength(2);
    expect(detail.entries[0].type).toBe('COMMISSION');
    expect(detail.entries[0].amount).toBe(100);
    expect(detail.entries[0].rateBps).toBe(500);
    expect(detail.entries[1].type).toBe('REVERSAL');
    expect(detail.entries[1].amount).toBe(-30);
    // ⚠️ **明细是按时间排的**（流水按 `occurredAt` 升序）
    expect(detail.entries[0].occurredAt < detail.entries[1].occurredAt).toBe(
      true,
    );
  });

  it('详情：单据不存在 → 404', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/platform/settlements/00000000-0000-4000-8000-000000000000')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('详情：id 不是 uuid → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/platform/settlements/not-a-uuid')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
```

⚠️ **S9 的对账有个前提**：结算单 e2e 造的**订单**会被
`billing-report.e2e-spec.ts` 的回填扫到（回填扫全表 `paidAt` 非空的订单）。
回填会给这些订单补流水行 —— 但 `@@unique([orderId, type])` 会让回填跳过
（结算单 e2e 已经造过同类型的流水行了）→ **不会产生重复** ✅。

⚠️ **S9 的断言为什么用「差值」而不是绝对值**：
`GET /platform/reports` 是**平台维度**的聚合，别的商家在同一个月的数据也在里面
（本文件里先跑的用例就可能在 2022-01 造过抽佣）→ 绝对值会飘。
**基线在造数据之前取**，断言的是「本用例自己贡献了多少」✅。

⚠️ **其它用例为什么可以用绝对值**：S1 / S2 / S5 / S10 都**显式点名了商家**
（`generate(adminToken, '2022-01', merchant.tenantId)`），
结算单里只有这一家的流水 → 绝对值是安全的 ✅。
**只有批量生成（不传 tenantId）的那条用例不能用绝对值** ——
它只断言「我这两家在结果里」✅。

⚠️ **同理，S1 / S2 / S5 / S10 里那些「只生成这一家」的场景**：
`generate(adminToken, '2022-01', merchant.tenantId)` **显式点名了商家**，
所以只有这一家的流水会进单 ✅ 绝对值断言是安全的。
**只有批量生成（不传 tenantId）的那条用例不能用绝对值** —— 它只断言「我这两家在结果里」✅。

- [ ] **Step 2：跑 e2e**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- settlement
```

Expected: PASS，22 条。

⚠️ **如果报「表不存在」** → 迁移没应用到测试库。跑一次
`npm run db:test:deploy`（内部是 `prisma migrate deploy`）。

⚠️ **如果 S9 的差值断言失败**，先看失败的具体数字 ——
多半是 `backfill` 在这个用例之前跑了（它会给本用例的订单补流水）。
若如此，检查是不是**同一笔订单造了两条同类型的流水**（回填 + 手工造）——
`@@unique([orderId, type])` 会挡住，回填应该跳过。

- [ ] **Step 3：跑全量 e2e（确认没有破坏别的文件）**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e
```

Expected: 499 + 新增条数，全部通过。

⚠️ **`billing-report.e2e-spec.ts` 特别要看**：它的对账用例断言
`entries.length` 是 4 —— 结算单 e2e 造的行**必须不在它的窗口里**（2022 ✅）。

- [ ] **Step 4：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/test/settlement.e2e-spec.ts
git commit -m "test(api): 结算单的 e2e——含「结算单净额 == 报表抽佣净额」的对账护栏"
```

---

## Task 7：platform-admin 的页面与中转路由

**Files:**
- Modify: `platform-admin/src/lib/billing.ts`（加类型与文案）
- Create: `platform-admin/src/app/(dashboard)/settlements/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/settlements/settlement-actions.tsx`
- Create: `platform-admin/src/app/api/billing/settlements/route.ts`
- Create: `platform-admin/src/app/api/billing/settlements/[id]/confirm/route.ts`
- Create: `platform-admin/src/app/api/billing/settlements/[id]/unconfirm/route.ts`
- Create: `platform-admin/src/app/api/billing/settlements/[id]/recalculate/route.ts`
- Modify: `platform-admin/src/app/(dashboard)/layout.tsx`（导航加「结算单」）

- [ ] **Step 1：在 `platform-admin/src/lib/billing.ts` 里加类型**

在文件末尾追加：

```ts
// ============================================================
// 结算单（阶段 5g）
// ============================================================

/**
 * 结算单的状态。
 *
 * ⚠️ **必须与后端 Prisma 的 `SettlementStatus` 逐字一致**：
 * 写成 `CONFIRMED` 之外的拼法，界面上就是裸枚举。
 */
export type SettlementStatus = 'DRAFT' | 'CONFIRMED' | 'PAID';

/** 结算单的一行 */
export interface SettlementStatement {
  id: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  statementNo: string;
  /** 周期起点（含）。ISO 8601 */
  periodStart: string;
  /** 周期终点（不含）。ISO 8601 */
  periodEnd: string;
  /** 周期标识（`YYYY-MM`） */
  periodLabel: string;
  /** 抽佣毛额（整数分） */
  grossAmount: number;
  /** 退款冲回（整数分，负数） */
  reversalAmount: number;
  /** 净额（整数分，**可以是负数**） */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
  status: SettlementStatus;
  /** 确认时间。ISO 8601。null = 未确认 */
  confirmedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
}

/** 结算单详情（含明细行） */
export interface SettlementDetail extends SettlementStatement {
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: 'COMMISSION' | 'REVERSAL';
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
}

/** 列表接口的信封 */
export interface SettlementListResult {
  items: SettlementStatement[];
  total: number;
}

/** 生成接口的返回 */
export interface SettlementGenerateResult {
  items: SettlementStatement[];
  created: number;
  skipped: number;
}

/** 结算单状态的中文文案 */
const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  DRAFT: '草稿',
  CONFIRMED: '已确认',
  PAID: '已出款',
};

/**
 * 结算单状态 → 中文文案。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 * 显示笼统的兜底文案好过把裸枚举糊到界面上。
 */
export function describeSettlementStatus(
  status: SettlementStatus | string,
): string {
  return SETTLEMENT_STATUS_LABEL[status as SettlementStatus] ?? '未知状态';
}
```

⚠️ **金额换算复用 `formatRevenueLabel`**（同一个文件里已有）——
**不另造第二处「分 → 元」的换算**（5b 在 merchant-admin 上踩过
「各写各的换算、结果差一分钱」的坑）。

- [ ] **Step 2：写中转路由**

Create `platform-admin/src/app/api/billing/settlements/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 生成结算单的中转：POST /api/billing/settlements。
 *
 * ⚠️ **为什么不直接在客户端组件里 fetch 后端 API**：
 * ① 后端没开 CORS（前端与 API 同源，由 Nginx 反代）；
 * ② accessToken 不该进客户端代码。
 *
 * ⚠️ **请求体按白名单重建**：客户端传来的 body 是不受信任的输入，
 * 不能直接透传给后端。金额**永远不在请求体里** —— 结算单的金额只从流水算。
 */

/** 周期标识的格式 */
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** uuid 的格式 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const body = raw as { period?: unknown; tenantId?: unknown };

  // ⚠️ **period 必须匹配 YYYY-MM**：后端也会校验，但在这里就拦掉
  //    能给出更明确的提示（界面上「周期格式非法」比「校验失败」有用）。
  if (typeof body.period !== 'string' || !PERIOD_PATTERN.test(body.period)) {
    return NextResponse.json(
      { message: '周期格式非法：必须是 YYYY-MM（如 2026-10）' },
      { status: 400 },
    );
  }

  const payload: { period: string; tenantId?: string } = {
    period: body.period,
  };
  if (body.tenantId !== undefined && body.tenantId !== null) {
    if (
      typeof body.tenantId !== 'string' ||
      !UUID_PATTERN.test(body.tenantId)
    ) {
      return NextResponse.json(
        { message: 'tenantId 必须是合法的 uuid' },
        { status: 400 },
      );
    }
    payload.tenantId = body.tenantId;
  }

  try {
    const result = await apiFetch('/platform/settlements', {
      method: 'POST',
      body: payload,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

Create `platform-admin/src/app/api/billing/settlements/[id]/confirm/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 确认结算单的中转：POST /api/billing/settlements/:id/confirm。
 *
 * ⚠️ **请求体为空**：确认不接收任何参数（金额、周期都不能由客户端指定）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch(`/platform/settlements/${id}/confirm`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

Create `platform-admin/src/app/api/billing/settlements/[id]/unconfirm/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 取消确认的中转：POST /api/billing/settlements/:id/unconfirm。
 *
 * ⚠️ **请求体为空**：取消确认不接收任何参数。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch(`/platform/settlements/${id}/unconfirm`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

Create `platform-admin/src/app/api/billing/settlements/[id]/recalculate/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 重算结算单的中转：POST /api/billing/settlements/:id/recalculate。
 *
 * ⚠️ **请求体为空**：重算不接收任何参数（金额由后端从流水重算）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch(`/platform/settlements/${id}/recalculate`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

- [ ] **Step 3：写客户端操作组件**

Create `platform-admin/src/app/(dashboard)/settlements/settlement-actions.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 结算单的**写操作**（生成 / 确认 / 取消确认 / 重算）。
 *
 * ⚠️ **所有写操作都走同源的 `/api/**` 中转**（不是直连后端）：
 * 后端没开 CORS，而且 accessToken 不该进客户端代码。
 *
 * ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
 * 连点两次会一起通过检查发出两次请求（重复生成）。ref 是同步写的。
 */

/** 统一的失败文案前缀 */
const FAILURE_TEXT = '操作失败';

/**
 * 读取中转路由的错误体。
 *
 * ⚠️ **先判断 `response.ok` 再决定要不要解析**：中转可能返回 204 无内容，
 * 对 204 调 `response.json()` 会抛「body 已消费」。
 */
async function readFailure(
  response: Response,
  fallback: string,
): Promise<string | null> {
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return payload.message ?? fallback;
}

/**
 * 生成结算单的表单。
 *
 * ⚠️ **默认月份用 URL 里带来的那个**：超管通常是在「看某个月」的页面上
 * 决定生成那个月的单据。
 */
export function SettlementGenerateForm({ period }: { period?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(period ?? '');
  const [success, setSuccess] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function handleGenerate() {
    if (busyRef.current) return;

    setSuccess(null);
    setFailure(null);

    const trimmed = value.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(trimmed)) {
      setFailure('周期格式非法：必须是 YYYY-MM（如 2026-10）');
      return;
    }

    if (
      !confirm(
        `确定生成 ${trimmed} 的结算单？\n` +
          '会给该期所有有流水的商家各建一张单据。',
      )
    ) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch('/api/billing/settlements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ period: trimmed }),
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      const result = (await response.json()) as {
        created: number;
        skipped: number;
      };
      setSuccess(
        `已新建 ${result.created} 张结算单` +
          (result.skipped > 0 ? `，复用 ${result.skipped} 张已有单据` : ''),
      );
      // ⚠️ **成功后必须 router.refresh()**：列表是服务端渲染的，
      // 不刷新就看不到新单据。
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>生成结算单</CardTitle>
        <CardDescription>
          按自然月（UTC）给该期所有有流水的商家各建一张单据。
          周期必须已经结束。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="settlement-period">结算周期</Label>
            <Input
              id="settlement-period"
              type="month"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="如 2026-10"
            />
          </div>
          <div className="flex justify-end">
            <Button type="button" disabled={busy} onClick={handleGenerate}>
              {busy ? '生成中…' : '生成'}
            </Button>
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          {success && (
            <p role="status" className="text-sm text-primary">
              {success}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 单据上的状态操作按钮。
 *
 * ⚠️ **重算与取消确认都要 `confirm()`**：改的是账。
 */
export function SettlementRowActions({
  statementId,
  status,
}: {
  statementId: string;
  status: 'DRAFT' | 'CONFIRMED' | 'PAID';
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function run(
    action: 'confirm' | 'unconfirm' | 'recalculate',
    confirmText: string,
  ) {
    if (busyRef.current) return;
    if (!confirm(confirmText)) return;

    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/billing/settlements/${statementId}/${action}`,
        { method: 'POST' },
      );
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-2">
        {status === 'DRAFT' && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                run('confirm', '确定确认这张结算单？确认后金额与明细冻结。')
              }
            >
              确认
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  'recalculate',
                  '确定重算这张结算单？会按当前抽佣流水重新算一遍。',
                )
              }
            >
              重算
            </Button>
          </>
        )}
        {status === 'CONFIRMED' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(
                'unconfirm',
                '确定取消确认？取消后可以重算 —— 通常是为了修正漏结的流水。',
              )
            }
          >
            取消确认
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4：写列表页**

Create `platform-admin/src/app/(dashboard)/settlements/page.tsx`：

```tsx
import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describeSettlementStatus,
  formatDateTime,
  formatRevenueLabel,
  type SettlementListResult,
} from '@/lib/billing';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { SettlementGenerateForm, SettlementRowActions } from './settlement-actions';

/**
 * 平台结算单列表页（Server Component）。
 *
 * ⚠️ **净单一律用后端返回的 `netAmount`，前端不自己加总**：
 * 与抽佣明细页「前端绝不自己算净额」同款原则。
 *
 * ⚠️ **区间来自 URL**（`?period=YYYY-MM`）：
 * 这样结算单的周期可以分享、可以后退，也就不用引入客户端 state。
 */
export default async function SettlementsPage({
  searchParams,
}: {
  // Next.js 15 起 searchParams 是 Promise，必须 await。
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;

  // ⚠️ **格式不对就不调后端**：非法的周期明细比没有明细更糟。
  const periodError =
    periodParam && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodParam)
      ? '周期格式非法：必须是 YYYY-MM（如 2026-10）'
      : null;

  let list: SettlementListResult | null = null;
  let error: string | null = null;

  if (!periodError) {
    try {
      const query = periodParam ? `?period=${encodeURIComponent(periodParam)}` : '';
      list = await apiFetchAuthed<SettlementListResult>(
        `/platform/settlements${query}`,
      );
    } catch (cause) {
      if (cause instanceof ApiError) {
        error = `加载结算单失败（${cause.status}）：${cause.message}`;
      } else {
        error = cause instanceof Error ? cause.message : '结算单加载失败';
      }
    }
  }

  const items = list?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">结算单</h2>

      {periodError && <p className="text-sm text-destructive">{periodError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ⚠️ **纯 GET 表单**：提交就是一次普通的页面跳转，不需要任何客户端 JS。 */}
      <form method="get" action="/settlements" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="settlement-filter-period">结算周期</Label>
            <Input
              id="settlement-filter-period"
              type="month"
              name="period"
              defaultValue={periodParam ?? ''}
            />
          </div>
          <Button type="submit">查询</Button>
        </div>
        <p className="text-sm text-muted-foreground">
          不选周期 = 全部周期。周期按 UTC 自然月计算，左闭右开。
        </p>
      </form>

      <SettlementGenerateForm period={periodParam} />

      {list && (
        <Card>
          <CardHeader>
            <CardTitle>结算单</CardTitle>
            <CardDescription>
              共 {list.total} 张
              {list.total > items.length ? `（本页显示 ${items.length} 张）` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无结算单。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商家</TableHead>
                    <TableHead>周期</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>毛额</TableHead>
                    <TableHead>冲回</TableHead>
                    <TableHead>净额</TableHead>
                    <TableHead>笔数</TableHead>
                    <TableHead>单号</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((statement) => (
                    <TableRow key={statement.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/settlements/${statement.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {statement.tenantName}
                        </Link>
                      </TableCell>
                      <TableCell>{statement.periodLabel}</TableCell>
                      <TableCell>{describeSettlementStatus(statement.status)}</TableCell>
                      {/* ⚠️ **金额直接用后端返回的三个数**，前端不加总。 */}
                      <TableCell>{formatRevenueLabel(statement.grossAmount)}</TableCell>
                      <TableCell>{formatRevenueLabel(statement.reversalAmount)}</TableCell>
                      <TableCell>{formatRevenueLabel(statement.netAmount)}</TableCell>
                      <TableCell>{statement.entryCount}</TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {statement.statementNo}
                        </code>
                      </TableCell>
                      <TableCell>
                        <SettlementRowActions
                          statementId={statement.id}
                          status={statement.status}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

⚠️ **`formatCommissionRate` 在这个页面用不到** —— 那是费率，
结算单列表上没有费率列（费率在明细里，详情页才有）。
**所以 import 里不要写它**（ESLint 会报未使用）。

- [ ] **Step 5：写详情页**

Create `platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx`：

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  COMMISSION_ENTRY_TYPE_LABEL,
  describeSettlementStatus,
  formatCommissionRate,
  formatDateTime,
  formatRevenueLabel,
  type SettlementDetail,
} from '@/lib/billing';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { SettlementRowActions } from '../settlement-actions';

/**
 * 平台结算单详情页（Server Component）。
 *
 * ⚠️ **明细的金额直接展示后端给的值**：明细是流水 join 出来的，
 *    前端不自己加总（与列表页同款原则）。
 */
export default async function SettlementDetailPage({
  params,
}: {
  // Next.js 15 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let statement: SettlementDetail | null = null;
  let error: string | null = null;

  try {
    statement = await apiFetchAuthed<SettlementDetail>(
      `/platform/settlements/${id}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载结算单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '结算单加载失败';
  }

  if (!statement) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">结算单详情</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">结算单详情</h2>
        <Link
          href="/settlements"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {statement.tenantName} · {statement.periodLabel}
          </CardTitle>
          <CardDescription>
            单号 {statement.statementNo} · {describeSettlementStatus(statement.status)}
            {statement.confirmedAt
              ? ` · 确认于 ${formatDateTime(statement.confirmedAt)}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-6 text-sm">
              <span>毛额 {formatRevenueLabel(statement.grossAmount)}</span>
              <span>冲回 {formatRevenueLabel(statement.reversalAmount)}</span>
              <span className="font-medium">
                净额 {formatRevenueLabel(statement.netAmount)}
              </span>
              <span className="text-muted-foreground">
                {statement.entryCount} 笔
              </span>
            </div>
            <SettlementRowActions
              statementId={statement.id}
              status={statement.status}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>结算明细</CardTitle>
          <CardDescription>
            这一期纳入的抽佣流水：金额带符号（抽佣为正、冲回为负）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statement.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无明细。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>费率</TableHead>
                  <TableHead>计佣基数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.entries.map((entry) => (
                  <TableRow key={entry.entryId}>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                    </TableCell>
                    <TableCell>{entry.orderNo}</TableCell>
                    <TableCell>
                      {COMMISSION_ENTRY_TYPE_LABEL[entry.type] ?? entry.type}
                    </TableCell>
                    <TableCell>{formatRevenueLabel(entry.amount)}</TableCell>
                    <TableCell>{formatCommissionRate(entry.rateBps)}</TableCell>
                    <TableCell>{formatRevenueLabel(entry.baseAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 6：导航加「结算单」**

Modify `platform-admin/src/app/(dashboard)/layout.tsx`，
在 `抽佣明细`那个 `Link` 后面加：

```tsx
            <Link href="/settlements" className="underline-offset-4 hover:underline">
              结算单
            </Link>
```

- [ ] **Step 7：类型检查 + lint**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin"
npx tsc --noEmit
npx eslint src/
```

Expected: 两条都无输出。

- [ ] **Step 8：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add platform-admin/src/lib/billing.ts "platform-admin/src/app/(dashboard)/settlements" platform-admin/src/app/api/billing/settlements "platform-admin/src/app/(dashboard)/layout.tsx"
git commit -m "feat(platform-admin): 结算单的列表页与详情页"
```

---

## Task 8：platform-admin 的页面测试

**Files:**
- Create: `platform-admin/test/app/settlements-page.test.tsx`
- Create: `platform-admin/test/app/settlement-detail-page.test.tsx`

- [ ] **Step 1：写列表页测试**

Create `platform-admin/test/app/settlements-page.test.tsx`：

```tsx
/**
 * 平台结算单列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await SettlementsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算净额」**：
 * 把 `statement.netAmount` 换成「把明细加总一遍」时，
 * 净额会从 ¥999.99 变成 ¥-2.00 —— 而那笔账是错的。
 * 所以这里构造**故意对不上**的数据来锁住它。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ **`@/auth` 必须 mock 掉**：`@/lib/api-client` 会 import 它，
// 而 `next-auth` 会间接 import `next/server` —— 那是 ESM 下的路径别名，
// 在 node 环境下直接 import 会抛 `ERR_MODULE_NOT_FOUND`。
vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetchAuthed: apiFetchAuthedMock,
  };
});

import SettlementsPage from '@/app/(dashboard)/settlements/page';
import type { SettlementListResult } from '@/lib/billing';

import { collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **故意对不上**：
 * 单据的净额是 99999 分 = ¥999.99；
 * 毛额 100 分、冲回 -300 分 → 和 = -200 分 = ¥-2.00。
 * 页面若自己加总，净额格显示的就是 ¥-2.00。
 */
const LIST: SettlementListResult = {
  items: [
    {
      id: 'statement-1',
      tenantId: 'tenant-1',
      tenantName: '示例店铺',
      subdomain: 'demo',
      statementNo: 'STL202601010000001234',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-02-01T00:00:00.000Z',
      periodLabel: '2026-01',
      grossAmount: 100,
      reversalAmount: -300,
      netAmount: 99999,
      entryCount: 2,
      status: 'DRAFT',
      confirmedAt: null,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  total: 1,
};

async function renderPage(params: { period?: string } = {}): Promise<string[]> {
  const element = await SettlementsPage({
    searchParams: Promise.resolve(params),
  });
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(LIST);
});

describe('结算单列表页：周期来自 URL', () => {
  it('不给周期 → 路径里没有 period（列出全部）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/platform/settlements');
  });

  it('给了周期 → 路径里带 period', async () => {
    await renderPage({ period: '2026-01' });

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toContain('period=2026-01');
  });

  it('⚠️ 周期格式非法 → 提示，且根本不调后端', async () => {
    const texts = await renderPage({ period: '2026-13' });

    expect(hasText(texts, '周期格式非法')).toBe(true);
    // ⚠️ **非法周期的明细比没有明细更糟**：所以压根不调后端。
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });
});

describe('结算单列表页：金额一律用后端返回的值', () => {
  it('⚠️ 净额是后端给的值，不是前端把毛额与冲回加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算净额」的直接锁**：
    // 后端给的净额是 99999 分 → ¥999.99；
    // 前端自己加总的话是 100 + (−300) = −200 分 → ¥-2.00。
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥-2.00')).toBe(false);
  });

  it('⚠️ 冲回显示成负数（不是 0、也不是「—」）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥-3.00')).toBe(true);
  });

  it('状态显示中文文案', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '草稿')).toBe(true);
    expect(hasText(texts, 'DRAFT')).toBe(false);
  });

  it('显示商家名、单号与周期', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, 'STL202601010000001234')).toBe(true);
    expect(hasText(texts, '2026-01')).toBe(true);
  });
});

describe('结算单列表页：取数失败', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载结算单失败')).toBe(true);
    expect(hasText(texts, '500')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('结算单列表页：空数据', () => {
  it('没有结算单时显示「暂无结算单。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({ items: [], total: 0 });

    const texts = await renderPage();

    expect(hasText(texts, '暂无结算单。')).toBe(true);
  });

  it('⚠️ total 大于本页条数时提示「还有更多」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...LIST, total: 120 });

    const texts = await renderPage();

    expect(hasText(texts, '共 120 张')).toBe(true);
    expect(hasText(texts, '本页显示 1 张')).toBe(true);
  });
});
```

- [ ] **Step 2：写详情页测试**

Create `platform-admin/test/app/settlement-detail-page.test.tsx`：

```tsx
/**
 * 平台结算单详情页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：理由同列表页。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetchAuthed: apiFetchAuthedMock,
  };
});

import SettlementDetailPage from '@/app/(dashboard)/settlements/[id]/page';
import type { SettlementDetail } from '@/lib/billing';

import { collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **净额故意与明细对不上**：后端给的净额是 99999 分 = ¥999.99，
 * 明细两行是 100 与 −300 → 和 = −200 分 = ¥-2.00。
 * 页面若自己加总，净额格显示的就是 ¥-2.00。
 */
const DETAIL: SettlementDetail = {
  id: 'statement-1',
  tenantId: 'tenant-1',
  tenantName: '示例店铺',
  subdomain: 'demo',
  statementNo: 'STL202601010000001234',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
  periodLabel: '2026-01',
  grossAmount: 100,
  reversalAmount: -300,
  netAmount: 99999,
  entryCount: 2,
  status: 'CONFIRMED',
  confirmedAt: '2026-02-01T10:00:00.000Z',
  createdAt: '2026-02-01T00:00:00.000Z',
  entries: [
    {
      entryId: 'entry-1',
      orderNo: 'ORD-1',
      type: 'COMMISSION',
      amount: 100,
      rateBps: 500,
      baseAmount: 20000,
      occurredAt: '2026-01-05T00:00:00.000Z',
    },
    {
      entryId: 'entry-2',
      orderNo: 'ORD-2',
      type: 'REVERSAL',
      amount: -300,
      rateBps: 500,
      baseAmount: 20000,
      occurredAt: '2026-01-20T00:00:00.000Z',
    },
  ],
};

async function renderPage(id = 'statement-1'): Promise<string[]> {
  const element = await SettlementDetailPage({
    params: Promise.resolve({ id }),
  });
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(DETAIL);
});

describe('结算单详情页：取数', () => {
  it('按 id 拉详情', async () => {
    await renderPage('statement-1');

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/platform/settlements/statement-1');
  });

  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载结算单失败')).toBe(true);
  });
});

describe('结算单详情页：金额与状态', () => {
  it('⚠️ 净额是后端给的值，不是前端把明细加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算净额」的直接锁**
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥-2.00')).toBe(false);
  });

  it('⚠️ 冲回显示成负数', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥-3.00')).toBe(true);
  });

  it('显示状态的中文文案与单号', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '已确认')).toBe(true);
    expect(hasText(texts, 'CONFIRMED')).toBe(false);
    expect(hasText(texts, 'STL202601010000001234')).toBe(true);
  });
});

describe('结算单详情页：明细', () => {
  it('每一行显示自己的金额、类型与费率', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥1.00')).toBe(true);
    expect(hasText(texts, '抽佣')).toBe(true);
    expect(hasText(texts, '退款冲回')).toBe(true);
    expect(hasText(texts, '5%')).toBe(true);
    expect(hasText(texts, 'ORD-1')).toBe(true);
  });

  it('没有明细时显示「暂无明细。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...DETAIL, entries: [] });

    const texts = await renderPage();

    expect(hasText(texts, '暂无明细。')).toBe(true);
  });
});
```

- [ ] **Step 3：跑前端测试**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin"
npx vitest run test/app/settlements-page.test.tsx test/app/settlement-detail-page.test.tsx
```

Expected: PASS，约 18 条。

- [ ] **Step 4：跑全量前端测试**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin"
npx vitest run
```

Expected: 197 + 新增条数，全部通过。

- [ ] **Step 5：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add platform-admin/test/app/settlements-page.test.tsx platform-admin/test/app/settlement-detail-page.test.tsx
git commit -m "test(platform-admin): 结算单页面的测试——锁住「前端不自己算净额」"
```

---

## Task 9：验收（容器化 + 浏览器手测 + 失败注入）

> 这一步**由协调者（不是实施代理）执行** —— 它要动真环境、跑浏览器、
> 注入故障并逐条复验。

- [ ] **Step 1：容器化验证**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
docker compose -f infra/docker-compose.yml up -d --build api
docker compose -f infra/docker-compose.yml ps
curl -s http://localhost:3000/health
```

Expected: api `Up (healthy)`；`/health` 返回 `{"status":"ok",...}`。

⚠️ **容器里的 `dist` 产物路径**必须是 `dist/main.js`（不是 `dist/src/main.js`）。
本阶段新增的文件全在 `src/modules/billing/` 之下 → **common root 不变** ✅
（阶段 5e 加 `api/scripts/` 时踩过这个坑）。

- [ ] **Step 2：全量测试**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests
npm run test:e2e
npx tsc --noEmit
npx eslint src/ test/
```

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin"
npx vitest run
npx tsc --noEmit
npx eslint src/
```

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/storefront" && npx vitest run
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin" && npx vitest run
```

Expected: 全部通过。**记录四个数字**（api 单测、api e2e、platform-admin、
storefront、merchant-admin），填进验收记录。

- [ ] **Step 3：浏览器手测**

⚠️ **用 `ego-browser`**（不是内置浏览器），且**全程不得抢前台**：
先 `pgrep -f "ego lite"` 检查是否已常驻；已运行则直接复用，**禁止再 `open`**。

手测清单：

1. 超管登录 platform-admin（`http://localhost:3003`）→「结算单」。
2. 选一个**过去的月份** → 点「生成」→ 确认对话框 → 列表出现该期各商家的单据。
3. 金额与「抽佣明细」页同期对得上（毛额 / 冲回 / 净额三个数）。
4. 点进详情 → 明细逐笔与抽佣明细页一致。
5. 点「确认」→ 状态变「已确认」→ 再点「确认」→ 不报错（幂等）。
6. 点「重算」→ 被拒（已确认，409 → 界面给出错误提示）。
7. 点「取消确认」→ 状态回「草稿」→ 点「重算」→ 金额不变（没有新流水）。
8. 造一笔同期的抽佣流水 → 重算 → 金额跟着变（漏结修复路径可用）。

⚠️ **手测完清理**：造出来的测试数据要删掉，别污染开发库。

- [ ] **Step 4：失败注入（**逐条单独跑，不叠加**）**

⚠️ **逐条单独跑**：阶段 5c 的教训 ——
「注入 A + 注入 B 叠加 → 挂 N 条」**不能**用来证明 A 缺独立锁点，
叠加时 A 的代码可能根本没机会执行。

⚠️ **注入后恢复用 `git checkout -- <file>`**：⚠️ **目标文件必须已提交**，
否则 `git checkout --` 会把自己的改动一起抹掉。恢复后**逐次核实 `git status` 干净**。

| # | 注入 | 期望挂掉 |
|---|------|---------|
| F1 | `generateOne` 里去掉 `tenantId` 过滤 | S1 |
| F2 | `entriesInPeriod` 改成 `occurredAt: { gte: from, lte: to }`（右闭） | S1 |
| F3 | `generateOne` 里去掉「先查后插」的幂等分支 | S3 |
| F4 | `recalculate` 里去掉「先删旧关联行」 | S4（`entryId` 唯一约束冲突） |
| F5 | `summarizeEntries` 里冲回**再取一次负** | S2 / S5 / S9 |
| F6 | `confirm` 的 `updateMany` 去掉 `status` 条件 | S7 |
| F7 | `generate` 里去掉「周期已结束」校验 | S11 |

每条注入的跑法：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
# 1. 改文件
# 2. 跑定向测试
npm run test:e2e -- settlement
# 3. 恢复
git checkout -- api/src/modules/billing/settlement.service.ts
# 4. 核实
git status
```

⚠️ **「单打一层不挂」可能是双层防线**（5f 的 F3 就是这样）：
遇到这种情况要**先确认是不是双层**，再下结论，别急着记「漏测」。

- [ ] **Step 5：写验收记录**

Create `docs/superpowers/plans/2026-10-28-plan-05g-acceptance.md`，照
`docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md` 的结构写：

- 自动化测试结果（各数字的前后对比）
- 容器化验证
- 浏览器手测（**做了就写实际结果，没做就如实写没做 + 理由，不编造**）
- **护栏 S1–S12 逐条核对**（护栏 → 测试位置 → 期望 → 实测 → 结论）
- **失败注入 F1–F7 逐条单独复验**（每条挂了几条、挂了哪条）
- 发现并修复的缺陷
- 已知遗留项（**诚实列出**，含设计文档 §七 的 L18–L31）
- 交付物清单
- 下一阶段

- [ ] **Step 6：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add docs/superpowers/plans/2026-10-28-plan-05g-acceptance.md
git commit -m "docs: 阶段 5g 验收记录（护栏逐条 + 失败注入逐条单独复验）"
```

---

## 勘误表（实施期发现）

> 本节记录**实施过程中发现、本计划正文写错了或不够的地方**。
> 正文代码块保持原样（它是「当时的规格」），以本节为准。
> 先例见阶段 5a / 5f 的勘误表。

### 一、计划正文的错误（实施代理独立发现并修正）

| # | 位置 | 计划写的 | 实际应该是 | 怎么发现的 |
|---|------|---------|-----------|-----------|
| **E1** | Task 6 §0.4 | e2e 的月份用 **2022 年**，理由是「与 billing-report 的 2020–2021 窗口错开」 | **2024 年** | ⚠️ **计划的理由是错的**。实测 `billing-report.e2e-spec.ts` 的 `nextWindow()` 实际调用 **14 次** → 最后一块是 2022-02-20 ~ 2022-03-22 → **2022-01 ~ 2022-03 已被占用**。按计划用 2022-01 会让 `GET /platform/commissions` 那条既有用例的 `byMerchant` 从 1 个商家变成 5 个 → **既有 e2e 变红**。2024 年要 25 次调用才会被推到，安全 ✅ |
| **E2** | Task 6 的 S9 用例 | `expect(jan.items[0].netAmount + feb.items[0].netAmount).toBe(0)` | **`toBe(100)`** | ⚠️ **计划的算术错了**。① 那笔单（1 月支付 100、**从不退款**）对平台的净贡献就是 100；只有 ② 那笔（支付 150 / 退款 150）跨两期才是 0。写成 0 会把「冲回抵掉抽佣」与「这笔抽佣本来就是赚的」混为一谈。逐期对账（250 / −150）保持原样 |
| **E3** | Task 6 的 S12 用例 | 造 1 张单 → 断言 `total === 1` | **同期 3 个不同商家造 3 张单** → `pageSize=2` → `items.length === 2`、`total === 3` | ⚠️ 计划那条**证明不了护栏**：只有 1 张单时 `total === items.length` 恒成立，根本测不出「total 不跟着 pageSize 截」 |
| **E4** | Task 2 的 `resolveMonthlyPeriod` | 只用正则 `/^(\d{4})-(0[1-9]\|1[0-2])$/` 校验 | **还要加年份取值域检查 `[1000, 9998]`** | ⚠️ **代码质量审查发现的 Blocking**：JS 的 `Date.UTC` 会把 **0–99 的年份映射到 1900+年**（`Date.UTC(1,0,1)` = 1901 年）→ `resolveMonthlyPeriod('0001-01')` 返回的区间是 1901 年 1 月，而 `label` 仍是 `'0001-01'` —— 标签与区间不一致，且**全程不报错** |
| **E15** | Task 9 的 **F4** 注入 | 「`recalculate` 里去掉『先删旧关联行』」→ **期望挂掉 S4** | ⚠️ **期望写错了**：S4（一笔流水只能被一期结算）守的是**生成**路径，F4 打的是**重算**路径。实测挂的是 `S6` 与「重算金额跟着变」两条 —— 证明的是「重算路径必须先删旧关联行」，与 S4 无关 |
| **E16** | Task 9 的 **F3** 注入 | 「`generateOne` 里去掉『先查后插』的幂等分支」 | ⚠️ **幂等实际有**两道**检查**：①「先查后插」的前置查；②事务内撞 `(tenantId, periodStart)` 唯一索引后的 **P2002 并发竞态兜底**。只打掉① 会撞上第三道 `assertEntriesNotSettled`（409）；只打掉② → **全绿**（它只在并发时走到，e2e 没有并发用例） |

### 二、计划的「Expected」数字（实施后修正）

| 位置 | 计划写的 | 实际 |
|------|---------|------|
| Task 1 Step 6 | 「单测 186 条不变」 | **243 条**（186 + Task 2 的 57） |
| Task 2 Step 4 | 「PASS，19 条」 | **57 条**（修复前 20 条 + 修复新增 37 条） |
| Task 6 Step 2 | 「PASS，22 条」 | **24 条** |
| Task 8 Step 3 | 「约 18 条」 | **48 条**（页面级 32 + 客户端组件 16） |

### 三、计划代码块的措辞问题（实施时按实际实现处理）

| # | 位置 | 问题 | 处理 |
|---|------|------|------|
| **E5** | Task 7 的列表页 import | 代码块 import 了 `formatDateTime`，但列表页没有时间列 | **不 import**（ESLint 会报未使用）。费率 `formatCommissionRate` 同理 |
| **E6** | Task 8 的列表页断言 | `expect(path).toBe('/platform/settlements')` | 实际路径带 `pageSize=200`（Task 7 修复时加的）→ 改成 `toContain` + 单独断言 `pageSize=200` | ⚠️ **实施时只做了一半**：`toContain('/platform/settlements')` 改对了，但 `pageSize=200` 那条断言**一处都没写**（`platform-admin/test/` 全目录 grep 零命中）→ 断言对这个参数完全无感：写成 `/platform/settlements`（丢掉 pageSize）也能过。**规格审查发现，已补**（`settlements-page.test.tsx` 新增一条，两种路径各断言一次） |
| **E7** | Task 3 / Task 5 的 import | Task 3 说「`CommissionEntryType` 删掉」，Task 5 又要「加回来」 | 两步都做（Task 5 的 `SettlementDetailView` 用到了它）。**不是矛盾，是分两步** |
| **E8** | Task 3 的 `detail` 排序 | 计划的 `commissionEntry.findMany` 带 `orderBy: { occurredAt: 'asc' }`，但随后遍历的是**关联行**（顺序任意）→ 那个 `orderBy` **实际不生效** | service 层显式按 `occurredAt` 排序后再返回 |

### 四、实施期追加的护栏（计划没有的）

| # | 在哪 | 内容 |
|---|------|------|
| **E9** | Task 2 | `summarizeEntries` 的**符号不变量断言**（毛额 ≥ 0、冲回 ≤ 0）+ **未知流水类型抛错** —— 枚举扩容时炸出来，而不是静默算成冲回 |
| **E10** | Task 3+4+5 | `assertEntriesNotSettled`：**进事务前**查「这些流水是否已被任何单关联」→ 409 并带上冲突的订单号。P2002 有三个来源（`(tenantId, periodStart)` / `statementNo` / `entryId`），逐个区分 —— 只查单据会把「撞 entryId」误判成「号撞了」→ 换号重试 5 次 → 抛「生成结算单号失败」，**错误信息完全误导** |
| **E11** | Task 6 | S4 分两层测：服务层防线（手写一张「周期与流水错开」的脏单才可达）+ 数据层兜底（再插一次同一 `entryId` → 断言 DB 的 P2002） |
| **E12** | Task 8 | 客户端组件的 jsdom 测试（`settlement-actions.test.tsx`）：`confirm()` 弹窗、请求体不含金额键、成功与失败提示分开 —— 这些**页面级测试测不到**（客户端组件的文字在闭包里，遍历元素树拿不到） |
| **E13** | Task 4（重算） | ⚠️ **计划的重算没有「防撞 `entryId`」的闸**。计划的 `recalculate` 只校验「这张单是 DRAFT」，但**重算时会重新拉当期流水** —— 若某笔流水在这期间**已被另一张单结算**，重算就会把 `entryId` 塞进本单 → 撞唯一索引 → P2002，且报错信息会误导成「单号撞了」。实现补了 `assertEntriesNotSettledByOthers`：**自己的单放行、别人的单拦下**（与 E10 的 `assertEntriesNotSettled` 是两个函数，语义不同，别混用） |
| **E14** | Task 8 | ⚠️ **计划没有「详情页 404 → `notFound()`」的用例**。Task 8 是**唯一**能覆盖它的层级（Task 6 的 e2e 只能验接口返 404，验不到页面把它转成 `notFound()`）。**规格审查发现** |
| **E17** | Task 6 | ⚠️ **失败注入 F2（区间改成右闭 `lte: to`）翻出的护栏缺口**：改右闭后 **34 条 e2e 全绿** —— 因为测试数据全在月中，**没有任何用例覆盖「恰好落在周期边界那一瞬」**的流水。右闭会让它被**相邻两期各算一次** → 重复计账。**已补**：造一笔 `occurredAt === period.to` 的流水，断言本期与下期各含 1 笔；重新注入 F2 → 挂 1 条 ✅ |
| **E18** | Task 6 | ⚠️ **失败注入 F6（`confirm` 去掉 `status` 条件）翻出的护栏缺口**：改完后 **34 条 e2e 全绿** —— S7 只断言了 `status`，**没断言 `confirmedAt` 不被刷新**。已确认的单再次确认时 `updateMany` 影响 1 行 → 确认时间被改成现在 → 「确认后冻结」被破坏。**已补**：在 S7 里断言 `second.confirmedAt === first.confirmedAt`（⚠️ 两次确认之间先 `sleep 50ms`，否则同毫秒会**假通过**）；重新注入 F6 → 挂 1 条 ✅ |

### 五、⚠️ 一个遗留的脆弱点

**结算单 e2e 的月份（2024）与 `billing-report.e2e-spec.ts` 的窗口错开，是靠「它现在只有 14 块」这个事实维持的。**

⚠️ 将来 `billing-report.e2e-spec.ts` 若新增到 **25 块** `nextWindow()`，窗口就会吃进 2024 年 → 结算单的 e2e 会因为「平台维度的报表聚合」被污染。

**缓解**：结算单 e2e 的断言全部用**差值**（基线在造数据之前取）而不是绝对值 —— 所以即使真的重叠，也只会让 `billing-report` 那边的**绝对值断言**受影响（它本来就有的问题），结算单这边不会红。

⚠️ **这是「已知的脆弱点」，不是「已解决」**。若将来报表 e2e 涨到 25 块，结算单的月份要重新挑。

---

## 附：护栏与失败的对照速查

| 护栏 | 一句话 | 主要落在 |
|------|-------|---------|
| S1 | 只纳入该商家该自然月的流水 | Task 6 |
| S2 | 三个金额由后端算 | Task 2 + Task 6 |
| S3 | 同一商家同一周期只有一张单 | Task 6 |
| S4 | 一笔流水只能被一期结算 | Task 6 |
| S5 | 跨期冲回落退款期 | Task 6 |
| S6 | 重算只有 DRAFT 能做 | Task 6 |
| S7 | 确认幂等；确认后冻结 | Task 6 |
| S8 | 鉴权：403 / 401 | Task 6 |
| S9 | ⭐ 结算单净额 == 报表抽佣净额 | Task 6 |
| S10 | 零额与负额 | Task 6 |
| S11 | 周期未结束不能生成 | Task 6 |
| S12 | 列表的 total 是真实总数 | Task 6 |

| 失败 | 一句话 | 期望挂掉 |
|------|-------|---------|
| F1 | 不按 tenantId 过滤 | S1 |
| F2 | 区间右闭 | S1 |
| F3 | 去掉幂等分支 | S3 |
| F4 | 重算不删旧关联行 | S4 |
| F5 | 冲回再取负 | S2 / S5 / S9 |
| F6 | 确认不带 status 条件 | S7 |
| F7 | 去掉周期校验 | S11 |