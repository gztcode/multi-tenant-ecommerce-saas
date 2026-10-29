# 阶段 5h-2 真正打款（出款执行 + 补差调账） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让出款单从 `APPROVED` 走到 `PAID`/`FAILED`（钱真的出去），并支持已出款周期回填货款后的「补差出款单」。

**Architecture:** 渠道抽象（`PayoutProvider`）放在 `payment` 模块，`billing` 不 import `payment` —— 两者通过全局的 `QueueModule` 里的 `PAYOUT_QUEUE` 通信。`billing` 侧的 `PayoutExecutionService` 是**状态落库的唯一入口**，被 `payment` 侧的 `PayoutWorker` 调用。补差单用 `kind = SUPPLEMENT` 与正常单区分，靠 `(tenantId, periodStart, kind)` 部分唯一索引共存。

**Tech Stack:** NestJS 11 + Prisma 6.19.3 + PostgreSQL 16 + BullMQ + Jest 30（api）；Next.js 15 App Router + React 19 + Tailwind 4 + Vitest 3（merchant-admin / platform-admin）

**设计依据:** [`docs/superpowers/specs/2026-10-29-plan-05h2-payout-execution-design.md`](../specs/2026-10-29-plan-05h2-payout-execution-design.md)

---

## 零、开工前必读

### 0.1 本仓库的硬约定（违反了会踩坑）

| 约定 | 说明 |
|------|------|
| **迁移一律手写 SQL** | `prisma migrate dev` 在本仓库会提示「需要重置 public schema」，而项目**明令禁用 `prisma migrate reset`**（阶段 2 已因此踩坑）。做法照 5c / 5e / 5g 的先例：写好 `migration.sql` → `psql` 应用 → `prisma migrate resolve --applied` 登记 |
| **宿主机没有 `psql`** | 用 `docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce < <文件>` |
| **`billing` 绝对不能 import `payment`** | 会成 `order → billing → payment → order` 的环，NestJS 启动直接报错。反向 `payment → billing` 是允许的 |
| **队列投递不能在事务之前** | worker 可能在事务提交前消费到 job → 查不到那行 → 静默返回 → 这笔单永远没人处理（5d 的坑 14、5h-1 的坑 14） |
| **BullMQ 的 failed job 的 hash 还在** | 用**同一个 jobId** 重新入队会被**静默忽略**（5f 的教训）→ jobId 必须带轮次标记 |
| **部分唯一索引写在迁移 SQL 里，不写进 schema** | Prisma 的 `@@unique` 表达不了 `WHERE` 子句。声明了也不生效，只会让人误以为数据库层有约束 |
| **`@Roles` 装饰器自带 `JwtAuthGuard`** | `roles.decorator.ts` 内部是 `UseGuards(JwtAuthGuard, RolesGuard)`。删掉整个 `@Roles` 会连认证一起失效 |
| **金额一律整数分；时间一律 `TIMESTAMP(3)` UTC** | 前端展示时才转元 |
| **测试库与开发库共用同一个 Redis，靠 `BULLMQ_PREFIX` 分开** | e2e 用 `bull-e2e`（`test/setup-e2e.ts`），本机容器用 `bull`。改前缀会抢走对方的任务 |

### 0.2 端口与连接串

| 用途 | 地址 |
|------|------|
| 开发库 | `postgresql://ecommerce:ecommerce@localhost:15432/ecommerce?schema=public`（`api/.env` 的 `DATABASE_URL`） |
| 测试库 | `postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public`（`api/.env` 的 `DATABASE_URL_TEST`） |
| Redis | `redis://localhost:16380` |
| api | 3000 |
| merchant-admin | 3002 |
| platform-admin | 3003 |

### 0.3 测试命令

```bash
# api 单测（指定文件，不跑全量）
cd api && npx jest src/modules/billing/payout.service.spec.ts

# api e2e（指定文件）
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts

# 前端单测
cd merchant-admin && npx vitest run test/lib/payout.test.ts
cd platform-admin && npx vitest run test/lib/payout.test.ts
```

⚠️ `npm test` 会先跑 `node test/deploy-test-db.mjs`（部署测试库 + 清库 + 清队列 + 灌种子）。
**单测用 `npx jest <file>` 直接跑**（更快，且不碰数据库）。

⚠️ **e2e 的 `globalSetup` 会清空整个测试库** → 跑 e2e 前不要开着别的 e2e 进程。

### 0.4 本阶段的两个「非显然」设计点（照做，别自己改）

**（一）补差单的佣金恒为 0。**
佣金只有结算单一个凭证。同一期所有出款单的 `commissionAmount` 之和必须等于该期结算单的
`netAmount` —— 补差单扣佣会破坏这个不变量。代价是平台在这笔回填货款上没收佣（漏结佣金，
记为 L54）。详见设计文档 §6.4。

**（二）`approve` 重算补差金额必须用「本单口径」。**
补差单在 `apply` 时已经占用了自己那批流水。若 `approve` 用全局口径「该期未被任何单占用的流水」，
本单纳入的流水会被当成未纳入 → **金额直接归零**。正确口径 =
「本单已占用的 entryId ∪ 该期未被任何单占用的流水」。详见设计文档 §6.4 的「重算范围」。

### 0.5 文件结构（新增 / 修改清单）

**api —— 新增**

| 文件 | 职责 |
|------|------|
| `api/src/modules/payment/payout-provider.interface.ts` | `PayoutProvider` 接口（打款渠道的抽象） |
| `api/src/modules/payment/fake-payout.provider.ts` | 假出款网关（可注入失败次数与金额偏移） |
| `api/src/modules/payment/fake-payout.provider.spec.ts` | 假出款网关的单测 |
| `api/src/modules/payment/fake-payout.controller.ts` | 假网关的「接下来失败 N 次」端点 |
| `api/src/modules/payment/payout.worker.ts` | 消费 `PAYOUT_QUEUE`：`execute`（执行打款）+ `scan`（卡死扫描与救援） |
| `api/src/modules/payment/payout-worker.spec.ts` | worker 的单测 |
| `api/src/modules/billing/payout-execution.service.ts` | **状态落库的唯一入口**（`markPaid` / `markFailed` / `scheduleRetry` / `markStuckLogged` / `rescueApproved`） |
| `api/src/modules/billing/payout-execution.service.spec.ts` | execution service 的单测 |
| `api/test/payout-execution.e2e-spec.ts` | 护栏 X1–X16 的 e2e |

**api —— 修改**

| 文件 | 改什么 |
|------|--------|
| `api/prisma/schema.prisma` | `PayoutKind` 枚举、`payouts` 的 11 个新列、`settlement_statements.paidAt` |
| `api/prisma/migrations/20261029100000_add_payout_execution/migration.sql` | 新建（手写 SQL） |
| `api/src/common/queue/queue.constants.ts` | 加 `PAYOUT_QUEUE` |
| `api/src/modules/queue/queue.module.ts` | 注册 `PAYOUT_QUEUE` |
| `api/src/modules/queue/queue.service.ts` | `QueueName` 加 `PAYOUT_QUEUE`；`add` 支持 `opts`（`attempts` / `delay`） |
| `api/src/modules/billing/payout.service.ts` | `apply` 的 kind 判定；`approve` 按 kind 分支 + 抄账户快照 + 事务后入队；`availablePeriods` kind 化；`findActivePayout` 带 kind |
| `api/src/modules/billing/payout.service.spec.ts` | 同步单测桩与断言 |
| `api/src/modules/billing/settlement.service.ts` | P6 闸的 `notIn` 加 `FAILED` |
| `api/src/modules/billing/settlement.service.spec.ts` | 同步单测桩 |
| `api/src/modules/billing/billing.module.ts` | 导出 `PayoutExecutionService` |
| `api/src/modules/payment/payment.module.ts` | 注册 `PayoutWorker` / `FakePayoutProvider` / `PAYOUT_PROVIDERS` |
| `api/src/modules/payment/payment.constants.ts` | 加 `PAYOUT_PROVIDERS` 令牌 |
| `api/src/common/config/assert-secure-config.ts` | 生产环境禁止 `FAKE_PAYOUT_ENABLED` |

**前端 —— 修改**

| 文件 | 改什么 |
|------|--------|
| `merchant-admin/src/lib/payout.ts` | `PROCESSING` 状态、`PayoutKind` 与标签、`AvailablePeriod` 三个新字段 |
| `merchant-admin/test/lib/payout.test.ts` | 同步断言 |
| `merchant-admin/src/app/(dashboard)/settlements/page.tsx` | 列表加 kind 标记 + FAILED 提示 |
| `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx` | 详情加 kind 标记 + 补差零佣金说明 |
| `merchant-admin/src/app/(dashboard)/settlements/apply/apply-form.tsx` | 补差入口 + 补差金额 |
| `merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx` | 透传新字段 |
| `platform-admin/src/lib/payout.ts` | 同 merchant-admin |
| `platform-admin/test/lib/payout.test.ts` | 同步断言 |
| `platform-admin/src/app/(dashboard)/payouts/page.tsx` | kind 列 + 卡住标红 |
| `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` | kind + failureReason + attemptCount |

---

### Task 1: 补 5h-1 的 N1 + `payouts.statementId` 索引

**Files:**
- Modify: `api/test/payout.e2e-spec.ts`（拆分 P9 用例）
- Create: `api/prisma/migrations/20261029100000_add_payout_execution/migration.sql`（**只放索引部分**，Task 2 再补其余）

- [ ] **Step 1: 找到 5h-1 的 P9 用例**

Run:
```bash
cd api && grep -n "P9" test/payout.e2e-spec.ts
```
Expected: 找到 `it('P9：...` 那一行，及其 `get` / `delete` 两段断言。

- [ ] **Step 2: 读那一段，确认 `get` 断言会先失败**

Run:
```bash
cd api && sed -n "$(grep -n 'P9' test/payout.e2e-spec.ts | head -1 | cut -d: -f1),+60p" test/payout.e2e-spec.ts
```
Expected: 看到「先 GET 详情断言、再 DELETE 撤回断言」的顺序。

⚠️ **N1 的原委**：这个用例里 `get` 的断言先失败 → `delete` 的断言**轮不到执行** →
「撤回越权被挡住」这条护栏**实际没被验证**（验收记录记为 N1）。
修法是**拆成两个 `it`**：一个只验 GET 越权，一个只验 DELETE 越权。

- [ ] **Step 3: 把 P9 拆成两个用例**

把原来那一个 `it('P9：...')` 拆成：

```ts
  it('P9：商家看不到别家的出款单详情（GET 越权）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 30000,
      commissionAmount: 3000,
    });
    const other = await createMerchant(app, prisma);
    const payout = await apply(merchant.token, period.label);

    // ⚠️ **别人的单必须是 404 而不是 403** ——
    //    说「存在但不许看」等于告诉对方这个 id 是真的（信息泄露）。
    await http(app)
      .get(`/api/v1/merchant/payouts/${payout.id}`)
      .set('authorization', `Bearer ${other.token}`)
      .expect(404);
  });

  it('P9：商家不能撤回别家的出款单（DELETE 越权）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 30000,
      commissionAmount: 3000,
    });
    const other = await createMerchant(app, prisma);
    const payout = await apply(merchant.token, period.label);

    await http(app)
      .delete(`/api/v1/merchant/payouts/${payout.id}`)
      .set('authorization', `Bearer ${other.token}`)
      .expect(404);

    // ⚠️ **还要断言「那张单没被动过」** ——
    //    只断言 404 的话，一个「直接返回 404 但其实撤回了」的 bug 也能过。
    const after = await fetchMerchantDetail(merchant.token, payout.id);
    expect(after.status).toBe(PayoutStatus.REQUESTED);
  });
```

⚠️ **两个用例必须用不同的月份**（`2026-06` 与 `2026-07`）——
同一商家的幂等键是 `(tenantId, periodStart)`，同月复用会让后一个用例拿到前一个的单据。
⚠️ 上面两段都写了 `2026-06`：**把第二个改成 `2026-07`**。

- [ ] **Step 4: 跑这个文件，确认两个用例都过**

Run:
```bash
cd api && npm run test:e2e -- test/payout.e2e-spec.ts
```
Expected: 全部 PASS，用例数比原来多 1。

- [ ] **Step 5: 建索引迁移文件**

Create `api/prisma/migrations/20261029100000_add_payout_execution/migration.sql`：

```sql
-- 阶段 5h-2：真正打款（出款执行 + 补差调账）—— 索引部分
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出（见 5h-1 的同款说明）。
-- 做法：手写 → psql 应用 → `prisma migrate resolve --applied` 登记。
--
-- ⚠️ 本迁移会分几次补齐（Task 2 补列与枚举）。**每次补完都要重新应用**，
--    所以这里的每一条语句都写成**幂等或一次性**：
--    `CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS` / `ADD COLUMN IF NOT EXISTS`。

-- ⚠️ 5h-1 的验收记录 §六 L32：P6 闸按 statementId 查出款单，量大时全表扫
CREATE INDEX IF NOT EXISTS "payouts_statementId_idx" ON "payouts"("statementId");
```

- [ ] **Step 6: 应用迁移到开发库并登记**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -v ON_ERROR_STOP=1 \
  < api/prisma/migrations/20261029100000_add_payout_execution/migration.sql
```
Expected: `CREATE INDEX` 成功输出，无 ERROR。

⚠️ **`-v ON_ERROR_STOP=1` 不能省** —— 否则 psql 遇到错误会继续往下跑。

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx prisma migrate resolve --applied 20261029100000_add_payout_execution
```
Expected: `Migration 20261029100000_add_payout_execution marked as applied.` ✅

- [ ] **Step 7: 提交**

```bash
git add api/test/payout.e2e-spec.ts api/prisma/migrations/20261029100000_add_payout_execution/migration.sql
git commit -m "test(api): 拆分出款的 P9 越权用例，并补 statementId 索引"
```

---

### Task 2: 数据模型（枚举 + 11 个新列 + 结算单 paidAt + 索引重建）

**Files:**
- Modify: `api/prisma/schema.prisma`
- Modify: `api/prisma/migrations/20261029100000_add_payout_execution/migration.sql`

- [ ] **Step 1: 在 schema 里加 `PayoutKind` 枚举**

在 `api/prisma/schema.prisma` 的 `enum PayoutStatus { ... }` 之后加：

```prisma
/// 出款单的类型（阶段 5h-2）
enum PayoutKind {
  /// 正常出款（某一期的完整应结）
  NORMAL
  /// 补差出款（该期已 PAID 后又回填进来的流水）
  SUPPLEMENT
}
```

- [ ] **Step 1b: 给 `PayoutStatus` 枚举补上 `PROCESSING`**

⚠️ **5h-1 的 `PayoutStatus` 没有 `PROCESSING`**（只有 `PAID` / `FAILED` 是预留的），
而本阶段整个状态机都依赖它。

`api/prisma/schema.prisma`：

```prisma
enum PayoutStatus {
  REQUESTED
  APPROVED
  /// 打款中（5h-2）：渠道调用中，尚未落终态
  PROCESSING
  REJECTED
  CANCELLED
  PAID
  FAILED
}
```

⚠️ **枚举加值要单独一个迁移文件**（`20261029110000_add_processing_status`），
不要改已登记的迁移（checksum 会失配）：

```sql
-- AlterEnum
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
```

⚠️ **PG 12+ 允许 `ADD VALUE` 在事务块里跑**（`prisma migrate deploy` 会包事务），
但**新增值不能在同一个事务里被使用** → 这个迁移里只加值、不用它。

- [ ] **Step 2: 给 `payouts` 加 11 个新列**

在 `model Payout { ... }` 里，`updatedAt DateTime @updatedAt` 之前加：

```prisma
  /// 出款类型：正常出款 / 补差出款（阶段 5h-2）
  kind PayoutKind @default(NORMAL)
  /// 打款渠道名（PAID / PROCESSING 时有值）
  payoutChannel String?
  /// 渠道交易号（幂等去重按它走）
  payoutTxnId String?
  /// 已尝试次数（含首次）。超过上限落 FAILED
  attemptCount Int @default(0)
  /// 最近一次失败的原因（给运营看）
  failureReason String?
  /// 开始执行的时刻（进 PROCESSING 时写）
  processingAt DateTime?
  /// 打款成功时刻
  paidAt DateTime?
  /// 失败落终态的时刻
  failedAt DateTime?
  /// 收款账户快照 —— 审批那一刻从 merchant_payout_accounts 抄下来
  /// ⚠️ 三个字段都是快照，worker 只读它们，绝不在执行时重新查账户
  snapshotAccountName String?
  snapshotBankName    String?
  snapshotAccountNo   String?
  /// 卡死告警已发出的时刻（兜底扫描写）
  /// ⚠️ 只为「告警去重」而存在：不写它的话兜底扫描每 5 分钟就把同一张单
  ///    捞出来再打一遍日志 —— 一晚上几千行噪音
  stuckLoggedAt DateTime?
```

- [ ] **Step 3: 给 `settlement_statements` 加 `paidAt`**

在 `model SettlementStatement { ... }` 里加：

```prisma
  /// 打款完成时刻。null = 未打款（5h-2）
  /// ⚠️ 与 status = PAID 同步写入，两者语义必须一致
  paidAt DateTime?
```

- [ ] **Step 4: 生成 Prisma Client**

```bash
cd api && npx prisma generate
```
Expected: `Generated Prisma Client (v6.19.3)` ✅

- [ ] **Step 5: 补迁移 SQL（列 + 枚举 + 索引重建）**

把 `api/prisma/migrations/20261029100000_add_payout_execution/migration.sql` 改成完整版：

```sql
-- 阶段 5h-2：真正打款（出款执行 + 补差调账）
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出（见 5h-1 的同款说明）。
-- 做法：手写 → psql 应用 → `prisma migrate resolve --applied` 登记。
--
-- ⚠️ 每条语句都写成幂等的（IF NOT EXISTS / IF EXISTS）——
--    本文件分几次补齐（Task 1 已建 statementId 索引，Task 2 补其余），
--    每次补完都要重新应用整个文件。

-- ---------- 枚举 ----------

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayoutKind') THEN
    CREATE TYPE "PayoutKind" AS ENUM ('NORMAL', 'SUPPLEMENT');
  END IF;
END
$$;

-- ---------- payouts 的新列 ----------

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "kind" "PayoutKind" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "payoutChannel" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "payoutTxnId" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "processingAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3);
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "snapshotAccountName" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "snapshotBankName" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "snapshotAccountNo" TEXT;
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "stuckLoggedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settlement_statements" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);

-- ---------- 索引 ----------

-- ⚠️ 5h-1 的验收记录 §六 L32：P6 闸按 statementId 查出款单，量大时全表扫
CREATE INDEX IF NOT EXISTS "payouts_statementId_idx" ON "payouts"("statementId");

-- 执行侧：worker 按状态捞单
CREATE INDEX IF NOT EXISTS "payouts_status_createdAt_idx" ON "payouts"("status", "createdAt");

-- ⚠️ **部分唯一索引必须重建**（设计文档 §5.2）：
-- 5h-1 的版本是 (tenantId, periodStart)，挡住补差单；
-- 现在改成三元组 (tenantId, periodStart, kind)，
-- 且排除列表要加上 FAILED —— 否则一旦出款失败，该期永远无法再申请。
--
-- ⚠️ **不用 CONCURRENTLY**：它不能在事务块里跑，而本仓库的迁移要能走
--    `prisma migrate deploy`（测试库的 `deploy-test-db.mjs` 与 e2e 的
--    `setup-e2e.ts` 都跑它）—— deploy 把每个迁移包在一个事务里，
--    带 CONCURRENTLY 会直接报 `cannot run inside a transaction block`。
--    本仓库既有的部分唯一索引（`payments_provider_txn_uniq` 等）也是这个写法。
--
-- ⚠️ **先查重复**：新约束比旧约束宽（多了 kind 这一维），
--    旧数据必然满足 —— 但还是查一遍，别赌。
SELECT "tenantId", "periodStart", kind, COUNT(*)
FROM payouts
WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')
GROUP BY 1,2,3 HAVING COUNT(*) > 1;

DROP INDEX IF EXISTS "payouts_tenantId_active_period_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_tenantId_period_kind_active_uniq"
  ON "payouts" ("tenantId", "periodStart", kind)
  WHERE status NOT IN ('REJECTED','CANCELLED','FAILED');
```

⚠️ **`DROP INDEX CONCURRENTLY` 与 `CREATE UNIQUE INDEX CONCURRENTLY` 之间不能夹其他 DDL** ——
上面那两条是相邻的 ✅

- [ ] **Step 6: 重新应用迁移到开发库**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -v ON_ERROR_STOP=1 \
  < api/prisma/migrations/20261029100000_add_payout_execution/migration.sql
```
Expected: 一连串 `ALTER TABLE` / `CREATE INDEX` 成功输出，无 ERROR。

⚠️ **如果报 `CREATE UNIQUE INDEX CONCURRENTLY` 失败且留下 invalid index**：
```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c 'DROP INDEX IF EXISTS "payouts_tenantId_period_kind_active_uniq";'
```
然后查重复数据、处理掉、再重跑。

- [ ] **Step 7: 验证表结构**

```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce \
  -c '\d payouts' -c '\d settlement_statements'
```
Expected:
- `payouts` 有 30 个字段（含 `kind`、`attemptCount`、`snapshotAccountNo` 等）
- 索引列表里有 `payouts_tenantId_period_kind_active_uniq`、`payouts_statementId_idx`、`payouts_status_createdAt_idx`
- **没有** `payouts_tenantId_active_period_uniq`（旧的已被 DROP）
- `settlement_statements` 有 `paidAt`

- [ ] **Step 8: 提交**

```bash
git add api/prisma/schema.prisma api/prisma/migrations/20261029100000_add_payout_execution/migration.sql
git commit -m "feat(api): 出款执行的数据模型——kind、执行字段、账户快照与索引重建"
```

---

### Task 3: 四处 `notIn` 加 `FAILED` + 两处加 `kind`

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`
- Modify: `api/src/modules/billing/settlement.service.ts`
- Modify: `api/src/modules/billing/payout.service.spec.ts`
- Modify: `api/src/modules/billing/settlement.service.spec.ts`

⚠️ **「四处 `notIn`」是同一个集合，必须永远是同一个**：
① 部分唯一索引的 `WHERE`（Task 2 已做）；② `PayoutService.findActivePayout`；
③ `SettlementService.unconfirm` 的 P6 闸；④ `PayoutService.availablePeriods` 的活跃单查询。

漏一处就会出现「一处认为不活跃、另一处认为活跃」的错位。

- [ ] **Step 1: 先让单测挂掉（红）**

在 `api/src/modules/billing/payout.service.spec.ts` 里加两个用例：

```ts
  it('findActivePayout：排除 FAILED（失败的单不占位，该期能再来一次）', async () => {
    const prisma = fakePrisma({
      payout: payout({ status: PayoutStatus.FAILED }),
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    // ⚠️ **断言传给 Prisma 的 where**（假 Prisma 不按 where 过滤）：
    //    `status.notIn` 少了 FAILED → 索引认为不活跃、查询却认为活跃。
    const where = argsOf(prisma.payout.findFirst).where as {
      status: { notIn: string[] };
    };
    expect(where.status.notIn).toContain(PayoutStatus.FAILED);
  });

```

⚠️ **「带 kind 条件」的那条断言放在 Task 9** ——
Task 3 里 `findActivePayout` 还没带 kind（Task 9 改造 `apply` 时才带），
在这里写就是一条必然失败的用例。

- [ ] **Step 2: 跑，确认第一个用例挂掉**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: FAIL —— `expect(where.status.notIn).toContain(PayoutStatus.FAILED)` 失败
（当前 `notIn` 只有 `['REJECTED', 'CANCELLED']`）。

- [ ] **Step 3: 改 `findActivePayout`**

`api/src/modules/billing/payout.service.ts`：

```ts
  /**
   * 查该期有没有活跃出款单（幂等检查用）。
   *
   * ⚠️ **只在商家侧（租户作用域）调用** —— 所以**不手写 tenantId**，
   *    靠扩展自动附加。
   *
   * ⚠️ **`kind` 是必传参数，不是可选的** —— 5h-2 把部分唯一索引改成了
   *    `(tenantId, periodStart, kind)` 三元组，查询不带 kind 就会出现
   *    「以为只查正常单、实际把补差单也捞进来了」的错位。
   *
   * ⚠️ **`notIn` 必须与索引的 WHERE 是同一个集合**
   *    （REJECTED / CANCELLED / FAILED）—— 否则会出现
   *    「查询认为不活跃、插入却被索引拦下」的错位。
   */
  private async findActivePayout(
    periodStart: Date,
    kind: PayoutKind,
  ): Promise<Payout | null> {
    return this.prisma.payout.findFirst({
      where: {
        periodStart,
        kind,
        status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED, PayoutStatus.FAILED] },
      },
    });
  }
```

⚠️ **要给 `findActivePayout` 的两个现有调用点补 `kind` 参数**：
- `apply` 里的幂等检查 → `this.findActivePayout(period.from, PayoutKind.NORMAL)`
  （Task 9 会把它改成按 kind 分别查；本 Task 先传 `NORMAL` 保持行为不变）
- `apply` catch 分支里的 `raced` → 同样传 `PayoutKind.NORMAL`

⚠️ **`PayoutKind` 要加进 import**：
```ts
import { PayoutStatus, PayoutKind, SettlementStatus, type Payout } from '@prisma/client';
```

- [ ] **Step 4: 改 `availablePeriods` 的活跃单查询（加 FAILED）**

`api/src/modules/billing/payout.service.ts` 的 `availablePeriods` 里：

```ts
      const applied = await this.prisma.payout.findFirst({
        where: {
          periodStart: resolved.from,
          status: {
            notIn: [
              PayoutStatus.REJECTED,
              PayoutStatus.CANCELLED,
              PayoutStatus.FAILED,
            ],
          },
        },
        select: { id: true },
      });
```

⚠️ **`kind` 条件在 Task 10 才加**（`availablePeriods` 的 kind 化是一整套改动），
本 Task 只补 `FAILED`。

- [ ] **Step 5: 改 P6 闸（加 FAILED）**

`api/src/modules/billing/settlement.service.ts` 的 `unconfirm` 里：

```ts
      const referenced = await this.prisma.payout.findFirst({
        where: {
          statementId: statementId,
          // ⚠️ **FAILED 也要排除**（阶段 5h-2）：出款失败的单仍然挂着
          //    statementId，但它**没有把钱打出去** → 不该拦住「取消确认」。
          //    不排除的话，一次出款失败会让该结算单永远无法取消确认。
          status: {
            notIn: [
              PayoutStatus.REJECTED,
              PayoutStatus.CANCELLED,
              PayoutStatus.FAILED,
            ],
          },
        },
        select: { id: true },
      });
```

- [ ] **Step 6: 同步两处单测桩**

`api/src/modules/billing/payout.service.spec.ts`：
- 找到 `status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED] },`（约 `:462`）
  → 改成 `[PayoutStatus.REJECTED, PayoutStatus.CANCELLED, PayoutStatus.FAILED]`

`api/src/modules/billing/settlement.service.spec.ts`：
- 找到 `status: { notIn: ['REJECTED', 'CANCELLED'] },`（约 `:441`）
  → 改成 `status: { notIn: ['REJECTED', 'CANCELLED', 'FAILED'] },`

- [ ] **Step 7: 跑单测，确认全绿**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts src/modules/billing/settlement.service.spec.ts
```
Expected: PASS ✅

- [ ] **Step 8: 跑 5h-1 的 e2e，确认没打破既有护栏**

```bash
cd api && npm run test:e2e -- test/payout.e2e-spec.ts test/settlement.e2e-spec.ts
```
Expected: PASS ✅

⚠️ **这一步很重要**：改 `notIn` 集合动到了 5h-1 的 P6 闸与幂等检查，
5h-1 的用例必须还全绿。

- [ ] **Step 9: 提交**

```bash
git add api/src/modules/billing/payout.service.ts api/src/modules/billing/settlement.service.ts \
        api/src/modules/billing/payout.service.spec.ts api/src/modules/billing/settlement.service.spec.ts
git commit -m "fix(billing): 四处 notIn 统一加 FAILED，出款单查询带 kind"
```

---

### Task 4: `PayoutProvider` 接口 + 假出款网关

**Files:**
- Create: `api/src/modules/payment/payout-provider.interface.ts`
- Create: `api/src/modules/payment/fake-payout.provider.ts`
- Create: `api/src/modules/payment/fake-payout.controller.ts`
- Modify: `api/src/modules/payment/payment.constants.ts`
- Modify: `api/src/modules/payment/payment.module.ts`
- Modify: `api/src/common/config/assert-secure-config.ts`

- [ ] **Step 1: 定义 `PayoutProvider` 接口**

Create `api/src/modules/payment/payout-provider.interface.ts`：

```ts
/**
 * 出款渠道的抽象（阶段 5h-2）。
 *
 * ## 为什么与 `PaymentProvider` 并列而不是复用
 *
 * 「打款」与「收款」是**两个不同的动作**：收钱是平台收进来（要跳页面、要回调），
 * 打钱是平台付出去（提交即扣款、没有回调、结果同步返回）。
 * 形状不同就分开定义 —— 复用会逼出「一堆用不上的可选参数」。
 *
 * ## channel 与 provider 的含义与 `PaymentProvider` 一致
 *
 * - `channel`：用户面对的渠道名
 * - `provider`：渠道背后的服务提供方
 *
 * ⚠️ 本阶段只接一个**本地假网关**（见 `fake-payout.provider.ts`）。
 */

/** 发起打款时要传给渠道的信息 */
export interface PayoutExecuteInput {
  /** 出款单 id —— 渠道侧的「打款单号」，也是幂等去重的依据 */
  referenceId: string;
  /** 业务单号（出款单号），渠道对账单上显示的 */
  referenceNo: string;
  /**
   * 打款金额（**整数分**）。
   *
   * ⚠️ 只从出款单的**审批锁定值**读，绝不从请求体读。
   */
  amount: number;
  /**
   * 收款账户。
   *
   * ⚠️ **这是审批那一刻的快照**（`payouts.snapshot*`），
   *    不是实时查出来的 —— 审批后商家改账户，不该改变打款目标（护栏 X2b）。
   */
  account: {
    accountName: string;
    bankName: string;
    accountNo: string;
  };
  /** 第几次尝试（1 = 首次，2、3 = 重试）。渠道侧对账时用得上 */
  attempt: number;
}

/** 打款的结果 */
export interface PayoutExecuteResult {
  /** 渠道交易号。幂等去重要按它走 */
  providerTxnId: string;
  /**
   * 渠道侧的出款状态。
   *
   * ⚠️ **开放字符串**：`'SUCCESS'` / `'FAILED'` 各渠道不同。
   * 调用方只认 `'SUCCESS'`，其余走失败路径。
   */
  status: string;
  /**
   * 渠道**实际打出的金额**（整数分）。
   *
   * ⚠️ **必须有它** —— 护栏 X3「渠道金额核对」靠它与请求金额比对。
   * 不核对就可能「打出去 100 块、账上记 1000 块」。
   */
  amount: number;
  /** 失败原因（`status !== 'SUCCESS'` 时给运营看） */
  failureReason?: string;
}

/**
 * 出款渠道。
 *
 * ⚠️ **`execute` 是同步的**：提交即扣款、结果立刻返回。
 * 真渠道（异步打款）接入时这个接口的形状要重新评估 ——
 * 届时大概率要拆成「提交 → 轮询」两步，**不能**在接口里假装同步。
 */
export interface PayoutProvider {
  /** 渠道名 */
  readonly channel: string;
  /** 服务提供方名 */
  readonly provider: string;

  /** 打款 */
  execute(input: PayoutExecuteInput): Promise<PayoutExecuteResult>;

  /** 查一笔打款的状态（对账用）。本阶段假网关恒返回已完成 */
  queryPayout(providerTxnId: string): Promise<{ status: string }>;
}
```

- [ ] **Step 2: 加渠道表令牌**

`api/src/modules/payment/payment.constants.ts` 末尾追加：

```ts
import type { PayoutProvider } from './payout-provider.interface';

/**
 * 出款渠道表的注入令牌。
 *
 * ⚠️ 与 `PAYMENT_PROVIDERS` **分开**：收款渠道与打款渠道是两套表，
 *    混在一张表里会出现「按渠道名找打款实现时匹配到收款实现」。
 */
export const PAYOUT_PROVIDERS = 'PAYOUT_PROVIDERS';

/** 出款渠道表的类型别名 */
export type PayoutProviderMap = Map<string, PayoutProvider>;
```

⚠️ **`import type` 要放在文件顶部**（import 语句必须在最前，不能在文件中间）。
把上面那行 `import type { PayoutProvider } ...` 合并到文件已有的 import 那一行旁边：

```ts
import type { PaymentProvider } from './payment-provider.interface';
import type { PayoutProvider } from './payout-provider.interface';
```

- [ ] **Step 3: 写假出款网关**

Create `api/src/modules/payment/fake-payout.provider.ts`：

```ts
import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PayoutExecuteInput,
  PayoutExecuteResult,
  PayoutProvider,
} from './payout-provider.interface';

/** 假出款网关的渠道名 */
export const FAKE_PAYOUT_CHANNEL = 'fake-payout';

/** 假出款网关的服务提供方名 */
export const FAKE_PAYOUT_PROVIDER = 'fake-payout';

/**
 * 假出款网关是否启用。
 *
 * ⚠️ **与 `FAKE_PAYMENT_ENABLED` 是两个独立的开关** ——
 * 用同一个的话，开着假支付网关就等于同时开着假出款网关，
 * 两个环境的启停会互相牵连。
 *
 * ⚠️ **默认关闭**。这不是便利开关，是**安全边界**：
 * 假出款网关能让「打款失败」，商家会以为平台不给钱。
 */
export function isFakePayoutEnabled(): boolean {
  return process.env.FAKE_PAYOUT_ENABLED === 'true';
}

/**
 * 本地假出款网关（阶段 5h-2）。
 *
 * ## 它怎么「模拟失败」
 *
 * ⚠️ **用一个进程内的计数器**：连续 N 次打款返回失败，N 用完就恢复正常。
 *
 * 为什么不用「按金额」「按账号」这类隐式约定：那类约定在 e2e 里很难读懂，
 * 也不容易断言「到底失败了几次」。计数器是显式的、可断言的。
 *
 * ⚠️ **进程内状态**：e2e 里 api 与 worker 在**同一个进程** → 状态共享 ✅。
 * 生产环境多进程部署时它不可靠 —— 但假网关本来就只在本地开发用
 * （生产环境 `assertSecureConfig` 会拒绝启动）。
 */
@Injectable()
export class FakePayoutProvider implements PayoutProvider {
  readonly channel = FAKE_PAYOUT_CHANNEL;
  readonly provider = FAKE_PAYOUT_PROVIDER;

  /** 接下来还要失败几次 */
  private failTimes = 0;
  /** 接下来几次返回的金额要偏移多少（用来造「渠道金额核对不通过」） */
  private amountOffset = 0;

  /**
   * 设定接下来 N 次打款的「剧本」。
   *
   * ⚠️ **只允许平台超管调**（见 `fake-payout.controller.ts`）：
   * 这个开关能让「打款失败」→ 攻击者可以让商家出不了款。
   *
   * @param options.failTimes 接下来失败几次（0 = 不失败）
   * @param options.amountOffset 接下来几次返回的金额要加多少
   *   （用来造「渠道返回的金额与请求的不一致」→ 护栏 X3）
   */
  armScenario(options: { failTimes?: number; amountOffset?: number }): void {
    this.failTimes = Math.max(0, Math.floor(options.failTimes ?? 0));
    this.amountOffset = Math.floor(options.amountOffset ?? 0);
  }

  /** 当前还要失败几次（测试与诊断用） */
  remainingFailures(): number {
    return this.failTimes;
  }

  async execute(input: PayoutExecuteInput): Promise<PayoutExecuteResult> {
    if (!isFakePayoutEnabled()) {
      throw new ServiceUnavailableException('本地假出款网关未启用');
    }

    // ⚠️ **失败也要给渠道交易号**：真实渠道失败时也会返回一个流水号，
    //    运营对账时要靠它去渠道查「这笔到底打没打出去」。
    const providerTxnId = `fake-pay-${randomUUID()}`;

    if (this.failTimes > 0) {
      this.failTimes -= 1;
      return {
        providerTxnId,
        status: 'FAILED',
        amount: input.amount + this.amountOffset,
        failureReason: `假出款网关模拟的失败（第 ${input.attempt} 次尝试）`,
      };
    }

    return {
      providerTxnId,
      status: 'SUCCESS',
      // ⚠️ **金额偏移只在这一次生效** —— 用来造「渠道金额核对不通过」
      //    （护栏 X3）。不消耗掉的话，之后每次成功都带偏移。
      amount: input.amount + this.takeAmountOffset(),
    };
  }

  async queryPayout(providerTxnId: string): Promise<{ status: string }> {
    // 假网关没有「主动查询」的能力：打款是同步的，状态在 execute 里就定了。
    return { status: providerTxnId ? 'SUCCESS' : 'UNKNOWN' };
  }

  /** 取走一次金额偏移（只生效一次） */
  private takeAmountOffset(): number {
    const offset = this.amountOffset;
    this.amountOffset = 0;
    return offset;
  }
}
```

- [ ] **Step 4: 写假网关的「模拟失败」端点**

Create `api/src/modules/payment/fake-payout.controller.ts`：

```ts
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { FakePayoutProvider, isFakePayoutEnabled } from './fake-payout.provider';

/**
 * 假出款网关的控制端。
 *
 * ⚠️ **与假支付网关的形态不同**：假支付网关有「支付页面 + 确认支付」，
 *    因为收钱是**用户点一下**触发的。而打款是 **worker 自动调渠道**，
 *    没有「用户点一下」这个环节 → **没有「确认打款」端点**。
 *
 * ⚠️ **唯一需要暴露的是「模拟失败」** —— 它是测「失败 → 重试 → FAILED」
 *    这条链路的开关。
 *
 * ⚠️ **必须限平台超管**（`@Roles(UserRole.PLATFORM_ADMIN)`）：
 *    这个开关能让「打款失败」→ 攻击者可以让商家出不了款。
 *    假支付网关的端点是无需登录的（因为 `FAKE_PAYMENT_ENABLED` 默认关闭），
 *    但**打款失败的后果更严重**，这里不做同样的取舍 ——
 *    平台超管本来就要登录才能审批，多这一次校验没有成本。
 *
 * ⚠️ **开关没开 → 404**（与假支付网关一致）：
 *    「这里没这个接口」比「存在但不许用」更不容易被扫到。
 */
@ApiTags('fake-payout')
@Controller('pay/fake-payout')
@Roles(UserRole.PLATFORM_ADMIN)
export class FakePayoutController {
  constructor(private readonly fake: FakePayoutProvider) {}

  @Post('fail-next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '假出款网关：设定接下来 N 次打款的剧本（仅本地开发）' })
  async failNext(
    @Body() body: { times?: number; amountOffset?: number },
  ): Promise<{ remaining: number }> {
    if (!isFakePayoutEnabled()) {
      throw new NotFoundException('未知的支付渠道');
    }
    this.fake.armScenario({
      failTimes: body.times ?? 1,
      amountOffset: body.amountOffset ?? 0,
    });
    return { remaining: this.fake.remainingFailures() };
  }
}
```

- [ ] **Step 5: 注册到 `payment` 模块**

`api/src/modules/payment/payment.module.ts`：

```ts
import { FakePayoutProvider } from './fake-payout.provider';
import { FakePayoutController } from './fake-payout.controller';
import { PayoutWorker } from './payout.worker';
import { PAYOUT_PROVIDERS, PAYMENT_PROVIDERS } from './payment.constants';
import type { PayoutProvider } from './payout-provider.interface';
```

⚠️ **`PayoutWorker` 在 Task 7 才创建** —— **本 Step 先不注册 worker**，只注册 provider 与 controller：

```ts
  controllers: [
    PaymentController,
    WebhookController,
    FakePaymentController,
    SubscriptionPaymentController,
    FakePayoutController,
  ],
  providers: [
    // ...
    FakePaymentProvider,
    FakePayoutProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (fake: FakePaymentProvider): Map<string, PaymentProvider> => {
        const providers = new Map<string, PaymentProvider>();
        providers.set(fake.channel, fake);
        return providers;
      },
      inject: [FakePaymentProvider],
    },
    {
      provide: PAYOUT_PROVIDERS,
      useFactory: (fake: FakePayoutProvider): Map<string, PayoutProvider> => {
        const providers = new Map<string, PayoutProvider>();
        providers.set(fake.channel, fake);
        return providers;
      },
      inject: [FakePayoutProvider],
    },
  ],
```

- [ ] **Step 6: 加生产环境安全守卫**

`api/src/common/config/assert-secure-config.ts` 末尾（`assertSecureConfig` 函数内）追加：

```ts
  // ⚠️ 假出款网关在生产环境开启 = 平台能让「打款失败」（阶段 5h-2）。
  //
  // 与假支付网关**分成两条**：用同一个开关的话，开着假支付就等于
  // 同时开着假出款，两个环境的启停会互相牵连。
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FAKE_PAYOUT_ENABLED === 'true'
  ) {
    throw new Error(
      '生产环境禁止启用 FAKE_PAYOUT_ENABLED：假出款网关能让出款失败。',
    );
  }
```

- [ ] **Step 7: 写假网关的单测**

Create `api/src/modules/payment/fake-payout.provider.spec.ts`：

```ts
import { ServiceUnavailableException } from '@nestjs/common';
import {
  FAKE_PAYOUT_CHANNEL,
  FakePayoutProvider,
  isFakePayoutEnabled,
} from './fake-payout.provider';

/**
 * 假出款网关的单元测试。
 *
 * ⚠️ **`process.env` 要在每个用例前后恢复** ——
 *    `isFakePayoutEnabled()` 直接读 env，不恢复会污染同文件的后续用例。
 */
describe('FakePayoutProvider', () => {
  const original = process.env.FAKE_PAYOUT_ENABLED;

  beforeEach(() => {
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYOUT_ENABLED = 'true';
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env.FAKE_PAYOUT_ENABLED;
    } else {
      process.env.FAKE_PAYOUT_ENABLED = original;
    }
  });

  const input = {
    referenceId: 'payout-a',
    referenceNo: 'PAY202508010000000001',
    amount: 8500,
    account: {
      accountName: '张三',
      bankName: '测试银行',
      accountNo: '6222000000000000',
    },
    attempt: 1,
  };

  it('开关没开 → execute 抛 503（不是返回一个假成功）', async () => {
    process.env.FAKE_PAYOUT_ENABLED = 'false';
    const provider = new FakePayoutProvider();

    await expect(provider.execute(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('默认成功：返回 SUCCESS、渠道交易号与金额', async () => {
    const provider = new FakePayoutProvider();

    const result = await provider.execute(input);

    expect(result.status).toBe('SUCCESS');
    expect(result.providerTxnId).toBeTruthy();
    // ⚠️ **金额要原样带回** —— 护栏 X3 的渠道金额核对靠它
    expect(result.amount).toBe(8500);
  });

  it('armScenario：接下来 N 次失败，第 N+1 次成功', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 2 });

    const first = await provider.execute(input);
    expect(first.status).toBe('FAILED');
    expect(first.failureReason).toContain('第 1 次尝试');
    // ⚠️ **失败也要给渠道交易号**（真实渠道失败时也会给）
    expect(first.providerTxnId).toBeTruthy();

    const second = await provider.execute({ ...input, attempt: 2 });
    expect(second.status).toBe('FAILED');
    expect(second.failureReason).toContain('第 2 次尝试');

    const third = await provider.execute({ ...input, attempt: 3 });
    expect(third.status).toBe('SUCCESS');
    expect(provider.remainingFailures()).toBe(0);
  });

  it('armScenario：金额偏移只生效一次（用来造渠道金额核对不通过）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 0, amountOffset: 1 });

    const first = await provider.execute(input);
    // ⚠️ **金额与请求不一致** —— worker 应当据此落 FAILED（护栏 X3）
    expect(first.status).toBe('SUCCESS');
    expect(first.amount).toBe(8501);

    // ⚠️ **偏移只生效一次** —— 第二次恢复成请求金额
    const second = await provider.execute(input);
    expect(second.amount).toBe(8500);
  });

  it('isFakePayoutEnabled：读的是 FAKE_PAYOUT_ENABLED，与支付开关独立', () => {
    process.env.FAKE_PAYOUT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_ENABLED = 'false';
    expect(isFakePayoutEnabled()).toBe(true);

    process.env.FAKE_PAYOUT_ENABLED = 'false';
    expect(isFakePayoutEnabled()).toBe(false);
  });

  it('渠道名固定', () => {
    expect(new FakePayoutProvider().channel).toBe(FAKE_PAYOUT_CHANNEL);
  });
});
```

- [ ] **Step 8: 跑单测**

```bash
cd api && npx jest src/modules/payment/fake-payout.provider.spec.ts
```
Expected: PASS ✅（6 个用例）

- [ ] **Step 9: 提交**

```bash
git add api/src/modules/payment/payout-provider.interface.ts api/src/modules/payment/fake-payout.provider.ts \
        api/src/modules/payment/fake-payout.provider.spec.ts api/src/modules/payment/fake-payout.controller.ts \
        api/src/modules/payment/payment.constants.ts api/src/modules/payment/payment.module.ts \
        api/src/common/config/assert-secure-config.ts
git commit -m "feat(payment): 出款渠道抽象 PayoutProvider 与本地假出款网关"
```

---

### Task 5: `PAYOUT_QUEUE` + `QueueService` 支持 `attempts` / `delay`

**Files:**
- Modify: `api/src/common/queue/queue.constants.ts`
- Modify: `api/src/modules/queue/queue.module.ts`
- Modify: `api/src/modules/queue/queue.service.ts`

- [ ] **Step 1: 加队列常量**

`api/src/common/queue/queue.constants.ts` 末尾追加：

```ts
/** 出款执行队列（审批后打款 + 卡死扫描） */
export const PAYOUT_QUEUE = 'payout';
```

- [ ] **Step 2: 注册队列**

`api/src/modules/queue/queue.module.ts`：

```ts
import {
  AUTH_QUEUE,
  BILLING_QUEUE,
  COMPENSATION_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
  PAYOUT_QUEUE,
} from '../../common/queue/queue.constants';
```

```ts
    BullModule.registerQueue(
      { name: PAYMENT_TIMEOUT_QUEUE },
      { name: PAYMENT_WEBHOOK_QUEUE },
      { name: BILLING_QUEUE },
      { name: AUTH_QUEUE },
      { name: COMPENSATION_QUEUE },
      { name: PAYOUT_QUEUE },
    ),
```

⚠️ **不要动这个文件顶部的注释**（它记着「REDIS_URL 在模块装饰器求值时读取」
这个极难查的坑）。

- [ ] **Step 3: 改 `QueueService` 支持 `attempts` / `delay`**

⚠️ **为什么必须改**：`QueueService.add` 现在硬编码了
`DEFAULT_JOB_OPTIONS = { attempts: 3, backoff: exponential 1000 }`。
而出款入队要 **`attempts: 1`**（关掉 BullMQ 自己的重试 —— 重试由我们自己的
`attemptCount` + 退避控制，见设计 §6.1/§6.2）。两层重试叠在一起时，
BullMQ 会在我们「退回 APPROVED 等下次」之后**又立刻重跑一次同一个 job**，
绕过退避 → 3 次尝试在 1 秒内烧完。

`api/src/modules/queue/queue.service.ts`：

```ts
import {
  AUTH_QUEUE,
  BILLING_QUEUE,
  COMPENSATION_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
  PAYOUT_QUEUE,
} from '../../common/queue/queue.constants';
```

```ts
export type QueueName =
  | typeof PAYMENT_TIMEOUT_QUEUE
  | typeof PAYMENT_WEBHOOK_QUEUE
  | typeof BILLING_QUEUE
  | typeof AUTH_QUEUE
  | typeof COMPENSATION_QUEUE
  | typeof PAYOUT_QUEUE;
```

```ts
  constructor(
    @InjectQueue(PAYMENT_TIMEOUT_QUEUE) timeoutQueue: Queue,
    @InjectQueue(PAYMENT_WEBHOOK_QUEUE) webhookQueue: Queue,
    @InjectQueue(BILLING_QUEUE) billingQueue: Queue,
    @InjectQueue(AUTH_QUEUE) authQueue: Queue,
    @InjectQueue(COMPENSATION_QUEUE) compensationQueue: Queue,
    @InjectQueue(PAYOUT_QUEUE) payoutQueue: Queue,
  ) {
    this.queues.set(PAYMENT_TIMEOUT_QUEUE, timeoutQueue);
    this.queues.set(PAYMENT_WEBHOOK_QUEUE, webhookQueue);
    this.queues.set(BILLING_QUEUE, billingQueue);
    this.queues.set(AUTH_QUEUE, authQueue);
    this.queues.set(COMPENSATION_QUEUE, compensationQueue);
    this.queues.set(PAYOUT_QUEUE, payoutQueue);
  }
```

新增一个方法（**不改 `add` 的签名**，避免影响现有调用点）：

```ts
  /**
   * 投递一个任务，**可覆盖默认的 job 选项**。
   *
   * ⚠️ **为什么要这个方法**：`add` 硬编码了
   *    `DEFAULT_JOB_OPTIONS = { attempts: 3, backoff: exponential }`，
   *    而出款入队要 **`attempts: 1`** —— 重试由出款单自己的
   *    `attemptCount` + 退避控制（设计 §6.2）。
   *    两层重试叠在一起时，BullMQ 会在我们「退回 APPROVED 等下次」之后
   *    **又立刻重跑一次同一个 job**，绕过退避 → 3 次尝试在 1 秒内烧完。
   *
   * @param opts.attempts BullMQ 自己的重试次数（默认 3；出款传 1）
   * @param opts.delay 延迟毫秒数（用于「退避后重投」）
   */
  async addWithOptions(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    jobId: string,
    opts: { attempts?: number; delay?: number; removeOnComplete?: boolean },
  ): Promise<void> {
    await this.withQueueTimeout(
      this.queueOf(queueName).add(jobName, data, {
        jobId,
        attempts: opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts,
        ...(opts.delay ? { delay: opts.delay } : {}),
        ...(opts.attempts === 1 ? {} : { backoff: DEFAULT_JOB_OPTIONS.backoff }),
        // ⚠️ **出款入队要设 `removeOnComplete: true`** ——
        //    否则完成的 job 留在队列里，队列一直涨，
        //    而且**同 jobId 永远不能再用**。
        ...(opts.removeOnComplete ? { removeOnComplete: true } : {}),
      }),
      `${queueName}/${jobName}`,
    );
  }
```

⚠️ **`attempts: 1` 时不要带 `backoff`** —— 一次都不重试，退避没有意义。

- [ ] **Step 4: 跑 queue 相关的既有测试**

```bash
cd api && npx jest src/modules/queue
```
Expected: PASS ✅

⚠️ **如果没有 `src/modules/queue` 下的测试文件**，用这个确认没编译错：
```bash
cd api && npx tsc --noEmit -p tsconfig.json
```
Expected: 无输出（无类型错误）✅

- [ ] **Step 5: 提交**

```bash
git add api/src/common/queue/queue.constants.ts api/src/modules/queue/queue.module.ts api/src/modules/queue/queue.service.ts
git commit -m "feat(queue): 新增出款队列，并允许入队时覆盖 attempts 与 delay"
```

---

### Task 6: `PayoutExecutionService`（状态落库的唯一入口）

**Files:**
- Create: `api/src/modules/billing/payout-execution.service.ts`
- Create: `api/src/modules/billing/payout-execution.service.spec.ts`
- Modify: `api/src/modules/billing/billing.module.ts`

⚠️ **这个服务是「状态落库的唯一入口」** —— worker 只调它，不自己写库。
理由：状态机的每一条转换（`PROCESSING → PAID` / `→ FAILED` / `→ APPROVED`）
都要带条件更新 + 同事务释放明细，分散在 worker 里会漏。

- [ ] **Step 1: 写服务骨架**

Create `api/src/modules/billing/payout-execution.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';

/** 打款的结果（worker 传给本服务） */
export interface MarkPaidInput {
  /** 渠道交易号 */
  providerTxnId: string;
  /** 打款渠道名 */
  channel: string;
  /** 打款成功的时刻（数据库时钟） */
  paidAt: Date;
}

/** 打款失败的结果 */
export interface MarkFailedInput {
  /** 失败原因（给运营看） */
  reason: string;
  /** 落 FAILED 的时刻（数据库时钟） */
  failedAt: Date;
}

/** 退回 APPROVED 等下一次重试的结果 */
export interface ScheduleRetryInput {
  /** 退回的时刻（数据库时钟） */
  now: Date;
}

/**
 * 出款执行的状态落库服务（阶段 5h-2）。
 *
 * ⚠️ **这是状态落库的唯一入口** —— worker 只调它，不自己写库。
 *    状态机的每一条转换都要带条件更新 + 同事务释放明细，
 *    分散在 worker 里一定会漏掉某一条。
 *
 * ⚠️ **全部跑在平台作用域下**：`payouts` 在租户白名单里，
 *    而队列消费端只知道一个 `payoutId`，不知道租户是谁
 *    （跨进程边界，`AsyncLocalStorage` 的上下文不跟着走）。
 *    平台作用域下扩展**不附加** tenantId 条件 → 查到的是全局事实。
 */
@Injectable()
export class PayoutExecutionService {
  private readonly logger = new Logger(PayoutExecutionService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 抢单：`APPROVED → PROCESSING`，`attemptCount + 1`。
   *
   * ⚠️ **这是护栏 X1 的落点**：条件更新（`where` 带 `status: APPROVED`）
   *    保证「同一张出款单只有一个 worker 能抢到」。
   *    抢不到就返回 `null`，调用方**静默返回** —— 不重试、不落 `FAILED`
   *    （BullMQ 会把它记成失败 job，排查时全是假故障）。
   *
   * ⚠️ **金额与账户快照在这里一次性读出**：worker 后面只用自己的返回值，
   *    不再查库、不重算（护栏 X2 / X2b）。
   *
   * @param now 进 `PROCESSING` 的时刻（数据库时钟）
   */
  async claimForExecution(
    payoutId: string,
    now: Date,
  ): Promise<ExecutionClaim | null> {
    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **抢单与读回在同一个事务里** —— 分开写的话，
      //    「已改成 PROCESSING 但还没读回金额」这个窗口里，
      //    另一个 worker 读到的可能是旧值。
      return this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.APPROVED },
          data: {
            status: PayoutStatus.PROCESSING,
            processingAt: now,
            attemptCount: { increment: 1 },
          },
        });
        if (affected.count === 0) {
          return null;
        }
        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: {
            attemptCount: true,
            netAmount: true,
            payoutNo: true,
            snapshotAccountName: true,
            snapshotBankName: true,
            snapshotAccountNo: true,
          },
        });
        if (!payout) {
          return null;
        }
        return {
          attemptCount: payout.attemptCount,
          netAmount: payout.netAmount,
          payoutNo: payout.payoutNo,
          account: payout.snapshotAccountNo
            ? {
                accountName: payout.snapshotAccountName ?? '',
                bankName: payout.snapshotBankName ?? '',
                accountNo: payout.snapshotAccountNo,
              }
            : null,
        };
      });
    });
  }

  /**
   * 打款成功：`PROCESSING → PAID`，并把引用的结算单一并转 `PAID`。
   *
   * ⚠️ **结算单联动在同一个事务里**（设计 §6.5）：
   *    钱已经打出去了，账上没跟上 = 账实不符。
   *
   * ⚠️ **结算单用条件 `status: CONFIRMED`**（不是 `PAID`）：
   *    已 `PAID` 的结算单被另一张单再触发时 `count === 0`，**不报错**（幂等）。
   *
   * ⚠️ **补差单不改结算单状态**（护栏 X6）：
   *    结算单在正常单 `PAID` 时已经转过了。
   */
  async markPaid(payoutId: string, input: MarkPaidInput): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.PAID,
            paidAt: input.paidAt,
            payoutChannel: input.channel,
            payoutTxnId: input.providerTxnId,
            // ⚠️ **失败原因要清掉**：重试成功后之前那次失败的原因不该留着
            failureReason: null,
          },
        });
        if (affected.count === 0) {
          return false;
        }

        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: { kind: true, statementId: true },
        });

        // ⚠️ **只有正常单才联动结算单**（X6）
        if (payout && payout.kind === 'NORMAL' && payout.statementId) {
          await tx.settlementStatement.updateMany({
            where: { id: payout.statementId, status: SettlementStatus.CONFIRMED },
            // ⚠️ **`paidAt` 与 `status` 同一次 `data` 里写** ——
            //    分开写会出现「status=PAID 但 paidAt=null」的矛盾行
            data: { status: SettlementStatus.PAID, paidAt: input.paidAt },
          });
        }
        return true;
      });

      this.logger.log(`出款已打款：${payoutId}（渠道 ${input.channel}）`);
      return result;
    });
  }

  /**
   * 打款失败（超过重试上限）：`PROCESSING → FAILED` + **释放明细占用**。
   *
   * ⚠️ **释放明细是必须的**：`payout_entries.entryId` 是全局唯一索引。
   * 不释放的话，商家重新申请同一期会撞索引 → P2002 → 500。
   * 这是 5h-1 在「拒绝 / 撤回」上踩过的同一个坑（E5），`FAILED` 是第三条释放路径。
   *
   * ⚠️ **`statementId` 不清**：失败的单仍然引用那张结算单。
   *    P6 闸已经把 `FAILED` 加进排除列表，所以它不挡「取消确认」（设计 §6.4）。
   */
  async markFailed(payoutId: string, input: MarkFailedInput): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.FAILED,
            failedAt: input.failedAt,
            failureReason: input.reason,
          },
        });
        if (affected.count === 0) {
          return false;
        }
        // ⚠️ **与状态更新同一个事务** —— 分开写会出现
        //    「状态已 FAILED、明细还占着」的窗口
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        return true;
      });

      this.logger.warn(
        `出款失败（已达重试上限）：${payoutId} —— ${input.reason}`,
      );
      return result;
    });
  }

  /**
   * 退回 `APPROVED` 等下一次重试。
   *
   * ⚠️ **必须清 `processingAt`**：不清的话，兜底扫描会把这些
   *    「正在等重试」的单当成「卡住的单」重复捞出来（噪声 + 平台端误标红）。
   *
   * ⚠️ **不重置 `attemptCount`**：重置了就不会收敛到 `FAILED`（护栏 X7）。
   *
   * @returns 新的 `attemptCount`（供调用方拼下一次入队的 jobId）
   */
  async scheduleRetry(
    payoutId: string,
    input: ScheduleRetryInput,
  ): Promise<number | null> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.APPROVED,
            processingAt: null,
            failureReason: input.reason ?? null,
          },
        });
        if (affected.count === 0) {
          return null;
        }
        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: { attemptCount: true },
        });
        return payout?.attemptCount ?? 0;
      });
      return result;
    });
  }

  /**
   * 记「已告警过卡死」—— **只写 `stuckLoggedAt`，不改状态、不入队**。
   *
   * ⚠️ **绝不能在这里重试**：卡在 `PROCESSING` 的单最可能的成因是
   *    「请求发出去了、回包丢了」—— 钱**可能已经打到商家账上**。
   *    退回 `APPROVED` 再入队 = **确定性地重复打款**（设计 §九·R3）。
   *
   * ⚠️ **`stuckLoggedAt` 是「告警去重」，不是「已处理」**：
   *    写了它不代表有人处理了，只代表「已经告警过了」。
   *    「它还在卡」由平台端列表实时标红暴露（前端按 `processingAt` 判定）。
   */
  async markStuckLogged(payoutIds: string[], now: Date): Promise<number> {
    if (payoutIds.length === 0) {
      return 0;
    }
    return tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payout.updateMany({
        where: { id: { in: payoutIds }, status: PayoutStatus.PROCESSING },
        data: { stuckLoggedAt: now },
      });
      return affected.count;
    });
  }
}
```

⚠️ **`scheduleRetry` 的 `input.reason`** —— 上面的签名里 `ScheduleRetryInput` 只有 `now`，
但代码里用了 `input.reason`。**把接口改成**：

```ts
export interface ScheduleRetryInput {
  /** 退回的时刻（数据库时钟） */
  now: Date;
  /** 本次失败的原因（记进 `failureReason`，给运营看） */
  reason: string;
}

/** 「我抢到了这张单」的凭据（worker 拿去调渠道） */
export interface ExecutionClaim {
  /** 递增后的尝试次数（第一次 = 1） */
  attemptCount: number;
  /** 审批锁定的应结金额（整数分）—— worker **用它**，不重算 */
  netAmount: number;
  /** 出款单号（渠道对账单上显示的） */
  payoutNo: string;
  /** 收款账户快照（**不是**实时查的） */
  account: {
    accountName: string;
    bankName: string;
    accountNo: string;
  } | null;
}
```

⚠️ **并且 `scheduleRetry` 要把 `now` 写进 `failureReason` 之外的时间戳吗？**
不写 —— `processingAt` 已经清空了，`failureReason` 记原因就够了。

- [ ] **Step 2: 把服务注册并导出**

`api/src/modules/billing/billing.module.ts`：

```ts
import { PayoutExecutionService } from './payout-execution.service';
```

```ts
  providers: [
    // ...
    PayoutService,
    PayoutAccountService,
    PayoutExecutionService,
  ],
  exports: [
    // ...
    ReceiptService,
    // ⚠️ **导出 `PayoutExecutionService`** —— `payment` 模块的
    //    `PayoutWorker` 要靠它落状态（设计 §4.1）。
    //    依赖方向是 `payment → billing`（单向），不构成环。
    PayoutExecutionService,
  ],
```

- [ ] **Step 3: 写单测**

Create `api/src/modules/billing/payout-execution.service.spec.ts`：

```ts
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { PayoutExecutionService } from './payout-execution.service';

/**
 * 出款执行状态落库服务的单元测试。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**，不按 `where` 过滤
 *    （与 `payout.service.spec.ts` 同款）。跨租户的实际行为靠 e2e 验。
 */

/** 取某个 mock 的第一次调用的参数 */
function argsOf(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return ((call ?? [])[0] ?? {}) as Record<string, unknown>;
}

/** 一只最小可用的假 Prisma */
function fakePrisma(options: { updateManyCount?: number; payout?: unknown; statementCount?: number } = {}) {
  let tx: {
    payout: {
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
    payoutEntry: { deleteMany: jest.Mock };
    settlementStatement: { updateMany: jest.Mock };
  } | null = null;

  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      tx = {
        payout: {
          updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: options.updateManyCount ?? 1 }),
          ),
          findFirst: jest.fn<Promise<unknown>, [unknown]>(() =>
            Promise.resolve(
              options.payout ?? { kind: 'NORMAL', statementId: 'stmt-a', attemptCount: 2 },
            ),
          ),
        },
        payoutEntry: {
          deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: 1 }),
          ),
        },
        settlementStatement: {
          updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: options.statementCount ?? 1 }),
          ),
        },
      };
      return fn(tx);
    }),
  };

  return Object.assign(prisma, { tx: () => tx });
}

function makeService(prisma: ReturnType<typeof fakePrisma>): PayoutExecutionService {
  return new PayoutExecutionService(prisma as unknown as never);
}

describe('PayoutExecutionService', () => {
  describe('claimForExecution', () => {
    it('APPROVED → PROCESSING，attemptCount + 1，返回金额与账户快照', async () => {
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY202508010000000001',
          snapshotAccountName: '张三',
          snapshotBankName: '测试银行',
          snapshotAccountNo: '6222000000000000',
        },
      });
      const service = makeService(prisma);

      const claim = await service.claimForExecution(
        'payout-a',
        new Date('2025-08-20T00:00:00.000Z'),
      );

      expect(claim).not.toBeNull();
      expect(claim!.attemptCount).toBe(1);
      // ⚠️ **金额是审批锁定的值**（护栏 X2：worker 不重算）
      expect(claim!.netAmount).toBe(8500);
      // ⚠️ **账户是快照**（护栏 X2b：不实时查账户表）
      expect(claim!.account).toEqual({
        accountName: '张三',
        bankName: '测试银行',
        accountNo: '6222000000000000',
      });
    });

    it('条件更新影响 0 行 → 返回 null（抢不到就静默返回）', async () => {
      const prisma = fakePrisma({ updateManyCount: 0 });
      const service = makeService(prisma);

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim).toBeNull();
    });

    it('快照账号为空 → account 为 null（worker 据此落 FAILED）', async () => {
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY1',
          snapshotAccountName: null,
          snapshotBankName: null,
          snapshotAccountNo: null,
        },
      });
      const service = makeService(prisma);

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.account).toBeNull();
    });
  });

  describe('markPaid', () => {
    it('PROCESSING → PAID，写入渠道交易号与打款时刻', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);
      const paidAt = new Date('2025-08-20T00:00:00.000Z');

      const ok = await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt,
      });

      expect(ok).toBe(true);
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        paidAt: Date;
        payoutTxnId: string;
      };
      expect(data.status).toBe(PayoutStatus.PAID);
      expect(data.paidAt).toBe(paidAt);
      expect(data.payoutTxnId).toBe('txn-1');
    });

    it('条件更新影响 0 行 → 返回 false，不碰结算单', async () => {
      const prisma = fakePrisma({ updateManyCount: 0 });
      const service = makeService(prisma);

      const ok = await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt: new Date(),
      });

      expect(ok).toBe(false);
      expect(prisma.tx()!.settlementStatement.updateMany).not.toHaveBeenCalled();
    });

    it('正常单 → 结算单 CONFIRMED → PAID，且写 paidAt', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'NORMAL', statementId: 'stmt-a', attemptCount: 1 },
      });
      const service = makeService(prisma);
      const paidAt = new Date('2025-08-20T00:00:00.000Z');

      await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt,
      });

      const data = argsOf(prisma.tx()!.settlementStatement.updateMany).data as {
        status: string;
        paidAt: Date;
      };
      expect(data.status).toBe(SettlementStatus.PAID);
      // ⚠️ **paidAt 与 status 同一次 data 里写** —— 分开写会出矛盾行
      expect(data.paidAt).toBe(paidAt);
    });

    it('补差单 → 不碰结算单状态（护栏 X6）', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'SUPPLEMENT', statementId: 'stmt-a', attemptCount: 1 },
      });
      const service = makeService(prisma);

      await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt: new Date(),
      });

      expect(prisma.tx()!.settlementStatement.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('markFailed', () => {
    it('PROCESSING → FAILED，写失败原因与失败时刻', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);
      const failedAt = new Date('2025-08-20T00:00:00.000Z');

      const ok = await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt,
      });

      expect(ok).toBe(true);
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        failureReason: string;
        failedAt: Date;
      };
      expect(data.status).toBe(PayoutStatus.FAILED);
      expect(data.failureReason).toBe('渠道超时');
      expect(data.failedAt).toBe(failedAt);
    });

    it('⚠️ 释放明细占用（否则商家重新申请撞唯一索引 → 500）', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt: new Date(),
      });

      expect(prisma.tx()!.payoutEntry.deleteMany).toHaveBeenCalled();
    });
  });

  describe('scheduleRetry', () => {
    it('PROCESSING → APPROVED，清空 processingAt，不重置 attemptCount', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'NORMAL', statementId: 'stmt-a', attemptCount: 2 },
      });
      const service = makeService(prisma);

      const attemptCount = await service.scheduleRetry('payout-a', {
        now: new Date(),
        reason: '渠道超时',
      });

      expect(attemptCount).toBe(2);
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        processingAt: Date | null;
        failureReason: string;
      };
      expect(data.status).toBe(PayoutStatus.APPROVED);
      // ⚠️ **必须清空 processingAt** —— 不清的话兜底扫描会把它当卡住的单
      expect(data.processingAt).toBeNull();
      expect(data.failureReason).toBe('渠道超时');
    });

    it('条件更新影响 0 行 → 返回 null（不重试）', async () => {
      const prisma = fakePrisma({ updateManyCount: 0 });
      const service = makeService(prisma);

      const attemptCount = await service.scheduleRetry('payout-a', {
        now: new Date(),
        reason: '渠道超时',
      });

      expect(attemptCount).toBeNull();
    });
  });

  describe('markStuckLogged', () => {
    it('空数组 → 直接返回 0，不查库', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      expect(await service.markStuckLogged([], new Date())).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 4: 跑单测**

```bash
cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
```
Expected: PASS ✅（13 个用例）

- [ ] **Step 5: 提交**

```bash
git add api/src/modules/billing/payout-execution.service.ts \
        api/src/modules/billing/payout-execution.service.spec.ts \
        api/src/modules/billing/billing.module.ts
git commit -m "feat(billing): 出款执行的状态落库唯一入口 PayoutExecutionService"
```

---

### Task 7: `PayoutWorker`（执行打款 + 卡死扫描 + APPROVED 救援）

**Files:**
- Create: `api/src/modules/payment/payout.worker.ts`
- Create: `api/src/modules/payment/payout-worker.spec.ts`
- Modify: `api/src/modules/billing/payout-execution.service.ts`（加 `scanStuck`）
- Modify: `api/src/modules/billing/payout-execution.service.spec.ts`
- Modify: `api/src/modules/payment/payment.module.ts`（注册 worker）

⚠️ **两个 job name**：
- `execute` —— 执行一笔出款（审批后入队）
- `scan` —— 周期性扫描（卡死告警 + 救援）

- [ ] **Step 1: 给 `PayoutExecutionService` 加 `scanStuck`**

追加到 `api/src/modules/billing/payout-execution.service.ts`：

```ts
  /**
   * 扫描卡住的出款单。
   *
   * ## 两类「卡住」，处理方式**完全相反**
   *
   * | 状态 | 含义 | 处理 |
   * |------|------|------|
   * | `PROCESSING` | 请求**可能已经打出去了**，只是回包丢了 | **只告警，绝不重试** |
   * | `APPROVED` | **确定还没打**（还没进 `PROCESSING`） | **重新入队**（安全） |
   *
   * ⚠️ **`PROCESSING` 绝不自动重试**（设计 §九·R3）：
   *    卡在 `PROCESSING` 最可能的成因是「请求发出去了、回包丢了」——
   *    钱**可能已经打到商家账上**。退回 `APPROVED` 再入队 =
   *    **确定性地重复打款**。所以只标出来给人看。
   *
   * ⚠️ **`APPROVED` 必须救援**：审批后要入队，入队可能失败（Redis 抖动）。
   *    没有兜底的话，那张单会永远停在 `APPROVED` ——
   *    商家看到「已审批」、平台看到「已审批」，**没有任何一方知道它没打出去**，
   *    流水还被占着（商家重新申请撞 `payout_entries` 唯一索引 → 500）。
   *    `APPROVED` 状态**确定没打出去**（还没进 `PROCESSING`），重新入队是安全的。
   *
   * @param now 数据库时钟
   * @param stuckThresholdMs 卡住多久算卡住（默认 10 分钟）
   * @returns 需要重新入队的出款单 id（`APPROVED` 且超时的）
   */
  async scanStuck(
    now: Date,
    stuckThresholdMs = 10 * 60 * 1000,
  ): Promise<Array<{ id: string; attemptCount: number }>> {
    return tenantContext.run(platformScope(), async () => {
      const threshold = new Date(now.getTime() - stuckThresholdMs);

      // ---- ① PROCESSING 卡死：只告警，不改状态 ----
      const stuck = await this.prisma.payout.findMany({
        where: {
          status: PayoutStatus.PROCESSING,
          processingAt: { lt: threshold },
          // ⚠️ **只捞还没告警过的** —— 不写 `stuckLoggedAt` 的话，
          //    每 5 分钟就把同一张单捞出来再打一遍日志
          stuckLoggedAt: null,
        },
        select: { id: true, payoutNo: true, attemptCount: true },
      });
      if (stuck.length > 0) {
        await this.markStuckLogged(
          stuck.map((p) => p.id),
          now,
        );
        this.logger.warn(
          `出款卡在 PROCESSING：${stuck.length} 张` +
            `（${stuck.map((p) => p.payoutNo).join('、')}）——` +
            '⚠️ 可能已打款，需人工核对，**不要自动重试**',
        );
      }

      // ---- ② APPROVED 卡死：重新入队 ----
      const stuckApproved = await this.prisma.payout.findMany({
        where: {
          status: PayoutStatus.APPROVED,
          approvedAt: { lt: threshold },
          // ⚠️⚠️ **必须加 `attemptCount = 0`** —— 「从未被执行过」。
          // 少了它会与重试 job 抢跑：`scheduleRetry` 退回 APPROVED 时
          // 不刷新 `approvedAt`（刷新它是错的，那是「审批时间」），
          // 于是两小时前审批的单在退避期内会被扫描命中 → 额外入队一个
          // 救援 job → 两个 job 抢同一张单 → 3 次重试预算几秒内烧完。
          attemptCount: 0,
        },
        select: { id: true, attemptCount: true },
      });
      if (stuckApproved.length > 0) {
        this.logger.warn(
          `出款卡在 APPROVED（审批后入队失败？）：${stuckApproved.length} 张 —— 重新入队`,
        );
      }
      return stuckApproved.map((p) => ({
        id: p.id,
        attemptCount: p.attemptCount,
      }));
    });
  }
```

⚠️ **这个方法需要 `this.prisma.payout.findMany` 在平台作用域下工作** ——
`payouts` 在租户白名单里，平台作用域下扩展**不附加** tenantId → 查到全局事实 ✅

- [ ] **Step 2: 写 worker**

Create `api/src/modules/payment/payout.worker.ts`：

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import { PayoutProvider } from './payout-provider.interface';
import { PAYOUT_PROVIDERS } from './payment.constants';

/** 出款队列任务的数据 */
export interface PayoutJob {
  /** 出款单 id */
  payoutId: string;
}

/**
 * 失败重试的上限（含首次）。
 *
 * ⚠️ **固定 3 次，不做成环境变量** —— 它是**业务规则**（设计 D1），
 *    不是部署参数。e2e 就按 3 次验。
 */
export const PAYOUT_MAX_ATTEMPTS = 3;

/**
 * 重试退避的基数（毫秒）。
 *
 * ⚠️ **实际退避 = 基数 × 尝试次数**（第 1 次等 1×基数、第 2 次等 2×基数）。
 * 默认 30 秒 → 30s / 60s / 90s。
 *
 * ⚠️ **不用指数退避**：出款的失败通常是渠道临时不可用，分钟级重试够了；
 *    指数退避会让第 3 次拖到 2 小时后，商家看到「已审批」两小时没动静会打电话。
 *
 * ⚠️ **做成环境变量是因为 e2e 要跑得快**：
 *    e2e 里设成 100ms → 三次重试总共 600ms 内跑完；
 *    用默认的 30 秒的话，e2e 要等 3 分钟。
 */
export function payoutRetryDelayMs(attempt: number): number {
  const base = Number(process.env.PAYOUT_RETRY_BASE_DELAY_MS ?? '30000');
  return base * attempt;
}

/**
 * 出款队列的消费端。
 *
 * ## 两个 job name
 *
 * - `execute`：执行一笔出款（审批后入队）
 * - `scan`：周期性扫描（卡死告警 + `APPROVED` 救援）
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 幂等靠「状态流转的条件更新」（`APPROVED → PROCESSING`），
 * 重复执行只有一个赢（护栏 X1）。
 *
 * ⚠️ **必须用平台作用域**：`payouts` 在租户白名单里，
 * 而队列消费是跨进程边界的 —— `AsyncLocalStorage` 的上下文不跟着走。
 * `PayoutExecutionService` 的每个方法内部都自己 `run(platformScope(), ...)`。
 */
@Processor(PAYOUT_QUEUE)
@Injectable()
export class PayoutWorker extends WorkerHost {
  private readonly logger = new Logger(PayoutWorker.name);

  constructor(
    private readonly execution: PayoutExecutionService,
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
    @Inject(PAYOUT_PROVIDERS)
    private readonly providers: Map<string, PayoutProvider>,
  ) {
    super();
  }

  async process(job: Job<PayoutJob>): Promise<void> {
    if (job.name === 'scan') {
      await this.runScan();
      return;
    }
    if (job.name !== 'execute') {
      return;
    }
    await this.runExecute(job.data.payoutId);
  }

  /**
   * 执行一笔出款。
   *
   * ## 三步
   *
   * 1. **抢单**：`APPROVED → PROCESSING`（护栏 X1）
   * 2. **两道闸**：金额 ≤ 0 / 账户快照缺失 → 落 `FAILED`（护栏 X4、§5.1c）
   * 3. **调渠道** → 落终态（`PAID` / 退回 `APPROVED` / 落 `FAILED`）
   */
  private async runExecute(payoutId: string): Promise<void> {
    const now = await this.prisma.databaseNow();

    // ---- STEP 1：抢单 ----
    const claim = await this.execution.claimForExecution(payoutId, now);
    if (!claim) {
      // ⚠️ **静默返回**（护栏 X1）：抢不到可能是另一路 worker 抢先了，
      //    也可能是已被人工处理。**不重试、不落 FAILED** ——
      //    抛错会让 BullMQ 把它记成失败 job，排查时全是假故障。
      this.logger.log(`出款 ${payoutId} 抢不到（状态已变），跳过`);
      return;
    }

    // ---- STEP 1.5：两道「打之前」的闸 ----
    // ⚠️ **都不调渠道**：不满足条件就不该打钱。
    const gateFailure = this.checkGates(claim);
    if (gateFailure) {
      await this.execution.markFailed(payoutId, {
        reason: gateFailure,
        failedAt: await this.prisma.databaseNow(),
      });
      return;
    }

    // ---- STEP 2：调渠道 ----
    // ⚠️ **本阶段只有一个出款渠道**（假网关），所以直接取第一个。
    //    ⚠️ **将来接真渠道时这里要改成按 `payouts.payoutChannel` 取** ——
    //    取「第一个」的话，加了第二家之后所有出款都会打到第一家。
    const provider = this.firstProvider();
    if (!provider) {
      await this.execution.markFailed(payoutId, {
        reason: '没有可用的出款渠道',
        failedAt: await this.prisma.databaseNow(),
      });
      return;
    }

    let result: PayoutExecuteResult;
    try {
      result = await provider.execute({
        referenceId: payoutId,
        referenceNo: claim.payoutNo,
        amount: claim.netAmount,
        account: claim.account!,
        attempt: claim.attemptCount,
      });
    } catch (error) {
      // ⚠️ **渠道抛异常 = 这次打款失败**，走重试路径
      //    （不能让它冒到 BullMQ —— `attempts: 1` 时它会进 failed 集合，
      //    而且我们自己的重试逻辑就永远不会跑）
      result = {
        providerTxnId: '',
        status: 'FAILED',
        amount: claim.netAmount,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }

    // ---- STEP 3：落终态 ----
    await this.settle(payoutId, claim.attemptCount, result, claim.netAmount);
  }

  /**
   * 打款之后的三条路。
   *
   * ⚠️ **X3 金额核对**：渠道返回的金额必须等于请求金额，
   *    不等就是**渠道打错了**（打 100 块、账上记 1000 块）→ 落 `FAILED`。
   */
  private async settle(
    payoutId: string,
    attemptCount: number,
    result: PayoutExecuteResult,
    requestedAmount: number,
  ): Promise<void> {
    const now = await this.prisma.databaseNow();

    if (result.status !== 'SUCCESS') {
      const reason = result.failureReason ?? '渠道返回失败';
      await this.handleFailure(payoutId, attemptCount, reason, now);
      return;
    }

    if (result.amount !== requestedAmount) {
      await this.execution.markFailed(payoutId, {
        reason: `渠道金额核对不通过（请求 ${requestedAmount} 分，渠道返回 ${result.amount} 分）`,
        failedAt: now,
      });
      return;
    }

    await this.execution.markPaid(payoutId, {
      providerTxnId: result.providerTxnId,
      channel: this.currentChannel(),
      paidAt: now,
    });
  }

  /**
   * 失败后的两条路（护栏 X7）。
   *
   * - 未超上限 → 退回 `APPROVED`，**延迟后重新入队**
   * - 达到上限 → 落 `FAILED`（并释放明细占用）
   */
  private async handleFailure(
    payoutId: string,
    attemptCount: number,
    reason: string,
    now: Date,
  ): Promise<void> {
    if (attemptCount >= PAYOUT_MAX_ATTEMPTS) {
      await this.execution.markFailed(payoutId, { reason, failedAt: now });
      return;
    }

    const nextAttempt = await this.execution.scheduleRetry(payoutId, {
      now,
      reason,
    });
    if (nextAttempt === null) {
      return;
    }

    // ⚠️ **jobId 必须带 attempt** —— 5f 的教训：BullMQ 里 failed job 的
    //    hash 还在，用**同一个 jobId** 重新入队会被**静默忽略**。
    const delay = payoutRetryDelayMs(nextAttempt);
    await this.queues.addWithOptions(
      PAYOUT_QUEUE,
      'execute',
      { payoutId },
      // ⚠️⚠️ **jobId 要用「下一轮」的轮次**，不是「这一轮」。
      // `approve` 首次入队用的是 `payout-${id}-1`；若这里也用当前
      // attemptCount（= 1），jobId 撞了 → BullMQ **静默忽略** →
      // 重试从未发生，单子永远停在 APPROVED（5f 的教训）。
      `payout-${payoutId}-${nextAttempt + 1}`,
      { attempts: 1, delay, removeOnComplete: true },
    );
    this.logger.warn(
      `出款失败，第 ${attemptCount} 次：${reason} —— ${delay / 1000} 秒后重试`,
    );
  }

  /**
   * 周期扫描：卡死告警 + `APPROVED` 救援。
   *
   * ⚠️ **绝不自动重试 `PROCESSING`**（设计 §九·R3）——
   *    钱可能已经打出去，重试 = 确定性地重复打款。
   */
  private async runScan(): Promise<void> {
    const now = await this.prisma.databaseNow();
    const rescues = await this.execution.scanStuck(now);
    for (const { id, attemptCount } of rescues) {
      // ⚠️ **jobId 要稳定** —— 用 `attemptCount` 而不是时间戳：
      //    时间戳每次扫描都不同 → 队列里会堆满同一个单的重复 job。
      //    `attemptCount` 在进 PROCESSING 之前不变 → 同一个 jobId
      //    → BullMQ 静默忽略 → 不堆积。
      await this.queues.addWithOptions(
        PAYOUT_QUEUE,
        'execute',
        { payoutId: id },
        `payout-${id}-rescue-${attemptCount}`,
        { attempts: 1 },
      );
    }
    if (rescues.length > 0) {
      this.logger.warn(`出款救援：${rescues.length} 张 APPROVED 单重新入队`);
    }
  }

  /** 取第一个已注册的渠道（假网关只有一家） */
  private firstProvider(): PayoutProvider | undefined {
    return this.providers.values().next().value;
  }

  /** 当前用的渠道名（写进 `payouts.payoutChannel`） */
  private currentChannel(): string {
    return this.firstProvider()?.channel ?? 'unknown';
  }
}
```

⚠️ **上面代码里有两处需要修正**（写的时候手滑了）：

1. `provider` 的取法应该是「按 `payoutChannel` 取」而不是「第一个」。
   本阶段只有一个渠道，但**必须写成按渠道取** —— 否则将来加第二个渠道时，
   所有出款都会打到第一家。

   把 STEP 2 改成：

```ts
    // ⚠️ **按渠道名取 provider**，不是「取第一个」——
    //    取第一个的话，将来加了第二个渠道，所有出款都会打到第一家。
    //    本阶段 `payoutChannel` 在抢单时是空的（还没打），
    //    所以用「第一个已注册的渠道」兜底。
    const provider =
      this.providers.get(this.claimedChannel ?? '') ?? this.firstProvider();
```

   ⚠️ `claimedChannel` 从哪来？**`payouts.payoutChannel` 是打款时才写的**，
   而抢单时它还是 null。⚠️ 所以「按渠道取」在本阶段没有意义 ——
   **本阶段只有一个渠道，直接用第一个**，但**注释要写清楚**：

```ts
    // ⚠️ **本阶段只有一个出款渠道**（假网关），所以直接取第一个。
    //    ⚠️ **将来接真渠道时这里要改成按 `payouts.payoutChannel` 取** ——
    //    取「第一个」的话，加了第二家之后所有出款都会打到第一家。
    const provider = this.firstProvider();
```

2. `runScan` 里的 `jobId` 用了 `Date.now()` → **每次扫描的 jobId 都不同** → 会堆积 job。
   ⚠️ 应该用**稳定**的 jobId：`payout-${payoutId}-rescue-${attemptCount}`。

   把 `runScan` 改成：

```ts
  private async runScan(): Promise<void> {
    const now = await this.prisma.databaseNow();
    const rescues = await this.execution.scanStuck(now);
    for (const { id, attemptCount } of rescues) {
      // ⚠️ **jobId 要稳定** —— 用 `attemptCount` 而不是时间戳：
      //    时间戳每次扫描都不同 → 队列里会堆满同一个单的重复 job。
      //    `attemptCount` 在进 PROCESSING 之前不变 → 同一个 jobId
      //    → BullMQ 静默忽略 → 不堆积。
      await this.queues.addWithOptions(
        PAYOUT_QUEUE,
        'execute',
        { payoutId: id },
        `payout-${id}-rescue-${attemptCount}`,
        { attempts: 1 },
      );
    }
    if (rescues.length > 0) {
      this.logger.warn(`出款救援：${rescues.length} 张 APPROVED 单重新入队`);
    }
  }
```

   ⚠️ **所以 `scanStuck` 的返回值要改成 `Array<{ id, attemptCount }>`**，
   把 `PayoutExecutionService.scanStuck` 的返回值改掉：

```ts
  async scanStuck(
    now: Date,
    stuckThresholdMs = 10 * 60 * 1000,
  ): Promise<Array<{ id: string; attemptCount: number }>> {
```

   并把 `return stuckApproved.map((p) => p.id);` 改成
   `return stuckApproved.map((p) => ({ id: p.id, attemptCount: p.attemptCount }));`

   ⚠️ 上面 Step 1 的 `scanStuck` 代码里 `select` 已经带了 `attemptCount` ✅（`{ id: true, attemptCount: true }`）

- [ ] **Step 3: 类型检查**

```bash
cd api && npx tsc --noEmit -p tsconfig.json
```
Expected: 无输出（无类型错误）✅

⚠️ **这一步专门抓 Step 1 与 Step 2 之间的签名不一致** ——
`scanStuck` 的返回值、`ExecutionClaim` 的字段名、`PayoutExecuteResult` 的字段名，
三处必须完全一致。类型错误会在这一步全部暴露出来。

- [ ] **Step 4: 写 worker 的单测**

Create `api/src/modules/payment/payout-worker.spec.ts`：

```ts
import { PayoutStatus } from '@prisma/client';
import { PAYOUT_MAX_ATTEMPTS, PayoutWorker, payoutRetryDelayMs } from './payout.worker';
import type { PayoutProvider } from './payout-provider.interface';

/**
 * 出款 worker 的单元测试。
 *
 * ⚠️ **重点验两件事**：
 * ① 抢不到单 → **什么都不做**（不重试、不落 FAILED）
 * ② 渠道失败 → 退回 `APPROVED` 并**延迟重新入队**（不是靠 BullMQ 重试）
 */

/** 一只假的渠道 */
function fakeProvider(result: {
  status: string;
  amount?: number;
  failureReason?: string;
  throws?: Error;
}): PayoutProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    channel: 'fake-payout',
    provider: 'fake-payout',
    execute: jest.fn((input: unknown) => {
      calls.push(input);
      if (result.throws) {
        return Promise.reject(result.throws);
      }
      return Promise.resolve({
        providerTxnId: 'txn-1',
        status: result.status,
        amount: result.amount ?? 8500,
        failureReason: result.failureReason,
      });
    }),
    queryPayout: jest.fn(() => Promise.resolve({ status: 'SUCCESS' })),
  } as unknown as PayoutProvider & { calls: unknown[] };
}

/** 假的 execution service */
function fakeExecution(claim: unknown) {
  return {
    claimForExecution: jest.fn(() => Promise.resolve(claim)),
    markPaid: jest.fn(() => Promise.resolve(true)),
    markFailed: jest.fn(() => Promise.resolve(true)),
    scheduleRetry: jest.fn(() => Promise.resolve(2)),
    markStuckLogged: jest.fn(() => Promise.resolve(0)),
    scanStuck: jest.fn(() => Promise.resolve([])),
  };
}

/** 假的队列服务 */
function fakeQueues() {
  return {
    addWithOptions: jest.fn(() => Promise.resolve()),
  };
}

/** 假的 Prisma（只需要 databaseNow） */
function fakePrisma() {
  return {
    databaseNow: jest.fn(() =>
      Promise.resolve(new Date('2025-08-20T00:00:00.000Z')),
    ),
  };
}

const claim = {
  attemptCount: 1,
  netAmount: 8500,
  payoutNo: 'PAY1',
  account: {
    accountName: '张三',
    bankName: '测试银行',
    accountNo: '6222000000000000',
  },
};

describe('PayoutWorker', () => {
  it('抢不到单 → 什么都不做（不调渠道、不落状态）', async () => {
    const execution = fakeExecution(null);
    const provider = fakeProvider({ status: 'SUCCESS' });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markPaid).not.toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('渠道成功 → markPaid，金额与请求一致', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 8500 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markPaid).toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
  });

  it('⚠️ 渠道金额核对不通过 → markFailed（护栏 X3）', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 9999 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markFailed).toHaveBeenCalled();
    expect(execution.markPaid).not.toHaveBeenCalled();
  });

  it('⚠️ 金额 ≤ 0 → 落 FAILED，不调渠道（护栏 X4）', async () => {
    const execution = fakeExecution({ ...claim, netAmount: 0 });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();
  });

  it('⚠️ 账户快照缺失 → 落 FAILED，不调渠道', async () => {
    const execution = fakeExecution({ ...claim, account: null });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();
  });

  it('渠道失败且未超上限 → 退回 APPROVED 并延迟重新入队', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.scheduleRetry).toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
    // ⚠️ **重新入队必须带 jobId 与 attempts: 1**
    const [queueName, jobName, data, jobId, opts] =
      queues.addWithOptions.mock.calls[0] as unknown as [
        string,
        string,
        { payoutId: string },
        string,
        { attempts: number; delay: number },
      ];
    expect(queueName).toBe('payout');
    expect(jobName).toBe('execute');
    expect(data.payoutId).toBe('payout-a');
    // ⚠️ **jobId 必须带轮次** —— 同 jobId 会被 BullMQ 静默忽略（5f 的教训）
    expect(jobId).toContain('payout-a');
    expect(jobId).not.toBe('payout-a');
    // ⚠️ **attempts 必须是 1** —— BullMQ 自己的重试要关掉
    expect(opts.attempts).toBe(1);
    expect(opts.delay).toBeGreaterThan(0);
  });

  it('渠道失败且达到上限 → 落 FAILED，不重新入队（护栏 X7）', async () => {
    const execution = fakeExecution({ ...claim, attemptCount: PAYOUT_MAX_ATTEMPTS });
    const provider = fakeProvider({ status: 'FAILED', failureReason: '渠道超时' });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markFailed).toHaveBeenCalled();
    expect(execution.scheduleRetry).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('渠道抛异常 → 当成失败处理，不冒到 BullMQ', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'FAILED', throws: new Error('网络不通') });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.scheduleRetry).toHaveBeenCalled();
  });
});

describe('payoutRetryDelayMs', () => {
  it('退避 = 基数 × 尝试次数（线性，不指数）', () => {
    const original = process.env.PAYOUT_RETRY_BASE_DELAY_MS;
    process.env.PAYOUT_RETRY_BASE_DELAY_MS = '1000';
    try {
      expect(payoutRetryDelayMs(1)).toBe(1000);
      expect(payoutRetryDelayMs(2)).toBe(2000);
      expect(payoutRetryDelayMs(3)).toBe(3000);
    } finally {
      if (original === undefined) {
        delete process.env.PAYOUT_RETRY_BASE_DELAY_MS;
      } else {
        process.env.PAYOUT_RETRY_BASE_DELAY_MS = original;
      }
    }
  });
});
```

⚠️ **worker 文件里还要 import `FAKE_PAYOUT_CHANNEL`**（Step 3 修好后不再用它，但先留着）——
实际修好后不需要，**不要 import**。

- [ ] **Step 5: 注册 worker**

`api/src/modules/payment/payment.module.ts`：

```ts
import { PayoutWorker } from './payout.worker';
```

```ts
  providers: [
    // ...
    FakePayoutProvider,
    PayoutWorker,
    // ...
  ],
```

⚠️ **`PayoutWorker` 依赖 `PayoutExecutionService`** —— 它在 `BillingModule` 里，
而 `payment.module.ts` 已经 `imports: [AuthModule, OrderModule, CouponModule, BillingModule]` ✅
⚠️ **但 `BillingModule` 必须 export `PayoutExecutionService`**（Task 6 已做）✅

- [ ] **Step 6: 跑单测**

```bash
cd api && npx jest src/modules/payment/payout-worker.spec.ts src/modules/billing/payout-execution.service.spec.ts
```
Expected: PASS ✅

- [ ] **Step 7: 提交**

```bash
git add api/src/modules/payment/payout.worker.ts api/src/modules/payment/payout-worker.spec.ts \
        api/src/modules/payment/payment.module.ts \
        api/src/modules/billing/payout-execution.service.ts api/src/modules/billing/payout-execution.service.spec.ts
git commit -m "feat(payment): 出款执行 worker——抢单、渠道调用、重试与卡死扫描"
```

---

### Task 8: `approve` 改造（按 kind 分支 + 账户快照 + 事务后入队）

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`
- Modify: `api/src/modules/billing/payout.service.spec.ts`

⚠️ **本 Task 改三处**，每一处都有独立的失败模式：
① 按 `kind` 分支重算（补差单二次扣佣金）
② 抄账户快照（审批后商家改账户 → 钱打到没审过的账户）
③ 事务提交后入队（入队在事务里 → worker 抢不到 → 这笔钱永远没人打）

- [ ] **Step 1: 先写失败测试**

在 `api/src/modules/billing/payout.service.spec.ts` 的 `describe` 里加：

```ts
  describe('approve（阶段 5h-2）', () => {
    it('补差单审批时**不调 computeAmounts**：佣金恒为 0（护栏 X13）', async () => {
      const prisma = fakePrisma({
        payout: payout({ kind: 'SUPPLEMENT' }),
        // ⚠️ **结算单的 netAmount 是 2000** —— 若审批时误用 computeAmounts，
        //    补差单的佣金会被算成 2000、净额被扣掉
        statement: statement({ netAmount: 2000 }),
      });
      const service = makeService(prisma);

      await asPlatform(async () => {
        await service.approve('payout-a');
      });

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        commissionAmount: number;
        netAmount: number;
        receiptAmount: number;
      };
      // ⚠️ **佣金恒为 0** —— 补差单不再扣佣（设计 §6.4 的不变量）
      expect(data.commissionAmount).toBe(0);
      expect(data.netAmount).toBe(data.receiptAmount);
    });

    it('审批时把收款账户抄进快照三个字段', async () => {
      const prisma = fakePrisma({});
      const service = makeService(prisma);

      await asPlatform(async () => {
        await service.approve('payout-a');
      });

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        snapshotAccountName: string;
        snapshotBankName: string;
        snapshotAccountNo: string;
      };
      expect(data.snapshotAccountName).toBe('张三');
      expect(data.snapshotBankName).toBe('测试银行');
      expect(data.snapshotAccountNo).toBe('6222000000000000');
    });

    it('审批时商家已删掉收款账户 → 409，不审批', async () => {
      const prisma = fakePrisma({ account: null });
      const service = makeService(prisma);

      await expect(
        asPlatform(async () => {
          await service.approve('payout-a');
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('审批成功后**入队**（事务提交之后）', async () => {
      const prisma = fakePrisma({});
      const queues = fakeQueues();
      const service = makeService(prisma, queues);

      await asPlatform(async () => {
        await service.approve('payout-a');
      });

      expect(queues.addWithOptions).toHaveBeenCalled();
      const [queueName, jobName, data, jobId, opts] =
        queues.addWithOptions.mock.calls[0] as unknown as [
          string,
          string,
          { payoutId: string },
          string,
          { attempts: number },
        ];
      expect(queueName).toBe('payout');
      expect(jobName).toBe('execute');
      expect(data.payoutId).toBe('payout-a');
      expect(jobId).toContain('payout-a');
      // ⚠️ **attempts 必须是 1** —— BullMQ 自己的重试要关掉
      expect(opts.attempts).toBe(1);
    });
  });
```

⚠️ **需要在 spec 文件里加两个辅助**：

```ts
/** 假的队列服务 */
function fakeQueues() {
  return {
    addWithOptions: jest.fn(() => Promise.resolve()),
  };
}
```

并把 `makeService` 改成接受第二个参数：

```ts
function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  queues: ReturnType<typeof fakeQueues> = fakeQueues(),
): PayoutService {
  return new PayoutService(
    prisma as unknown as never,
    queues as unknown as never,
  );
}
```

⚠️ **还要给 `payout()` 工厂加 `kind` 字段**：

```ts
function payout(overrides: {
  // ... 原有字段 ...
  kind?: PayoutKind;
}) {
  // ...
  return {
    // ... 原有字段 ...
    kind: overrides.kind ?? PayoutKind.NORMAL,
  };
}
```

并把 `import { PayoutStatus, ReceiptType, SettlementStatus } from '@prisma/client';`
改成 `import { PayoutKind, PayoutStatus, ReceiptType, SettlementStatus } from '@prisma/client';`

- [ ] **Step 2: 跑，确认挂掉**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: FAIL —— 「构造函数参数不足」或「快照字段不存在」。

- [ ] **Step 3: 给 `PayoutService` 注入 `QueueService`**

`api/src/modules/billing/payout.service.ts`：

```ts
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
```

```ts
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
  ) {}
```

⚠️ **`billing` 不 import `payment`，但 import `queue` 是安全的** ——
`QueueModule` 是 `@Global()` 的，`queue.service.ts` 里没有任何渠道代码。

- [ ] **Step 4: 改 `assertStatementConfirmed`（加 `allowPaid`）**

```ts
  /**
   * 结算单必须是已 `CONFIRMED` 的状态（护栏 P3）。
   *
   * ⚠️ **只在「申请」与「审批」这两个动作上校验**，不在取数的地方校验：
   * 「可申请周期」列表要照常显示未确认的周期（带 `statementStatus`），
   * 在那里抛异常会把整个列表打成 409。
   *
   * ⚠️ **`allowPaid` 只给补差路径开**（阶段 5h-2）：
   * 补差单不算佣金（佣金在结算单里一次性扣完），结算单只作追溯凭证 →
   * 允许它对着已 `PAID` 的结算单。
   *
   * ⚠️ **绝不能改成「PAID 一律放行」** —— 那会让正常单也能对已 `PAID` 的
   * 结算单重新算佣金，5h-1 的 P5（审批重算）与 P6（`PAID` 不可取消确认）
   * 会一起失效。`DRAFT` 状态**任何路径都要 409**。
   */
  private assertStatementConfirmed(
    amounts: { statementStatus: SettlementStatus | null },
    periodLabel: string,
    options: { allowPaid?: boolean } = {},
  ): void {
    const status = amounts.statementStatus;
    if (status === null || status === SettlementStatus.CONFIRMED) {
      return;
    }
    if (options.allowPaid && status === SettlementStatus.PAID) {
      return;
    }
    throw new ConflictException(
      `该期（${periodLabel}）的结算单尚未确认，不能申请出款`,
    );
  }
```

- [ ] **Step 5: 加「补差单重算」方法**

追加到 `api/src/modules/billing/payout.service.ts`：

```ts
  /**
   * 算补差出款单的金额（**不复用 `computeAmounts`** —— 护栏 X13）。
   *
   * ## 为什么不能复用 `computeAmounts`
   *
   * 正常单的佣金取该期结算单的 `netAmount`（整期一次性扣完）。
   * 补差单若也走这条路，佣金会被扣**第二遍** → 极端情况下净额变负。
   *
   * ## ⚠️⚠️ 重算范围必须是「本单口径」
   *
   * 补差单在 `apply` 时已经占用了自己那批流水。若这里用全局口径
   * 「该期未被任何单占用的流水」，**本单纳入的流水会被当成未纳入**
   * → 金额直接归零（护栏 X16）。
   *
   * 正确口径 = 「本单已占用的」 ∪ 「该期未被**其他**单占用的」。
   *
   * @param payout 待审批的补差单（要排除它自己占用的流水）
   */
  private async computeSupplementAmounts(
    payout: { id: string; tenantId: string },
    period: { from: Date; to: Date },
  ): Promise<{
    receiptAmount: number;
    commissionAmount: number;
    netAmount: number;
    entryCount: number;
    entryIds: string[];
    statementId: string | null;
    statementStatus: SettlementStatus | null;
  }> {
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: {
        tenantId: payout.tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });

    // ---- ① 本单自己占用的 entryId ----
    const ownLinks = await this.prisma.payoutEntry.findMany({
      where: { payoutId: payout.id },
      select: { entryId: true },
    });
    const ownIds = new Set(ownLinks.map((link) => link.entryId));

    // ---- ② 被**其他**单占用的 entryId ----
    // ⚠️ **`payout_entries` 不在租户白名单里** → 扩展不附加任何过滤，
    //    这里查到的就是全局事实 → **必须显式带 `tenantId` 与 `periodStart`**。
    const otherLinks = await this.prisma.payoutEntry.findMany({
      where: {
        payout: { tenantId: payout.tenantId, periodStart: period.from },
        payoutId: { not: payout.id },
      },
      select: { entryId: true },
    });
    const otherIds = new Set(otherLinks.map((link) => link.entryId));

    // ---- ③ 纳入范围 = 本单已占 ∪ 未被其他单占用的 ----
    const scope = receipts.filter(
      (receipt) => ownIds.has(receipt.id) || !otherIds.has(receipt.id),
    );

    const receiptAmount = scope.reduce((sum, receipt) => sum + receipt.amount, 0);

    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId: payout.tenantId, periodStart: period.from },
    });

    return {
      receiptAmount,
      // ⚠️ **佣金恒为 0** —— 这一期不再扣佣（设计 §6.4 的不变量：
      //    同一期所有出款单的佣金之和 = 该期结算单的 netAmount）
      commissionAmount: 0,
      netAmount: receiptAmount,
      entryCount: scope.length,
      entryIds: scope.map((receipt) => receipt.id),
      statementId: statement?.id ?? null,
      statementStatus: statement?.status ?? null,
    };
  }
```

- [ ] **Step 6: 改 `approve`**

把 `approve` 的整个方法体替换为：

```ts
  async approve(payoutId: string): Promise<PlatformPayoutView> {
    const context = getTenantContext();
    const userId = context.userId;
    if (!userId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }

      const period = { from: payout.periodStart, to: payout.periodEnd };
      const periodLabel = formatPeriodLabel(payout.periodStart);

      // ⚠️⚠️ **按 kind 分支重算** —— 补差单**绝不能**调 `computeAmounts`：
      //    那会把整期佣金再扣一遍（护栏 X13）。
      const amounts =
        payout.kind === PayoutKind.SUPPLEMENT
          ? await this.computeSupplementAmounts(payout, period)
          : await this.computeAmounts(payout.tenantId, period);

      // ⚠️ **P3 校验**：补差单允许结算单是 `PAID`（它不算佣金）
      this.assertStatementConfirmed(amounts, periodLabel, {
        allowPaid: payout.kind === PayoutKind.SUPPLEMENT,
      });

      if (amounts.entryCount === 0) {
        throw new ConflictException(
          `该期（${periodLabel}）已无货款流水，不能审批出款`,
        );
      }
      if (amounts.netAmount <= 0) {
        throw new ConflictException(
          `该期（${periodLabel}）重算后的应结金额已非正数` +
            `（货款净额 ${amounts.receiptAmount} 分、佣金 ${amounts.commissionAmount} 分），不能审批出款`,
        );
      }

      // ⚠️ **重新查收款账户**（阶段 5h-2）：商家在 `REQUESTED` 期间可能删了账户。
      //    查不到 → 409，**不要**带着空快照往下走 ——
      //    worker 会因为「快照缺失」落 `FAILED`，那等于让商家白等一轮。
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: payout.tenantId },
      });
      if (!account) {
        throw new ConflictException('该商家已删除收款账户，请让其重新申请');
      }

      const now = await this.prisma.databaseNow();
      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.REQUESTED },
          data: {
            status: PayoutStatus.APPROVED,
            approvedBy: userId,
            approvedAt: now,
            // ⚠️ **锁定的是重算后的值**：`requestedAmount` 保留申请时的预估
            receiptAmount: amounts.receiptAmount,
            commissionAmount: amounts.commissionAmount,
            netAmount: amounts.netAmount,
            entryCount: amounts.entryCount,
            statementId: amounts.statementId,
            // ⚠️⚠️ **账户快照必须在同一个事务里写** ——
            //    分成「先改状态、再单独写快照」的话，会有
            //    「状态已 APPROVED、job 已入队、快照还没写」的窗口，
            //    worker 拿到的可能是 `apply` 时的旧账户
            //    （正是快照要防的事）。
            snapshotAccountName: account.accountName,
            snapshotBankName: account.bankName,
            snapshotAccountNo: account.accountNo,
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单已被审批或状态已变，不能重复审批');
        }

        // ⚠️⚠️ **同步明细（否则重复打款）**：
        // 审批锁定的范围就是这张单纳入了的流水 —— 审批时纳入的那些新流水
        // **必须写进 `payout_entries`**，否则它们仍被判定「未纳入」→
        // 商家能再申请一张补差单，把同一笔流水**再打一次**。
        //
        // ⚠️ **`deleteMany` 必须在前** —— `entryId` 是全局唯一索引，
        // 不先删就 createMany 会撞唯一索引 → P2002 → 500。
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        await tx.payoutEntry.createMany({
          data: amounts.entryIds.map((entryId) => ({ payoutId, entryId })),
        });

        return tx.payout.findFirst({ where: { id: payoutId } });
      });

      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️⚠️ **入队必须在事务提交之后** —— 在事务里 `queue.add` 的话，
      //    worker 可能在事务提交前就消费到 job → 查不到那张单（还是 REQUESTED）
      //    → 抢不到 → 静默返回 → **这笔出款永远没人打**。
      //
      // ⚠️ **入队失败不抛错**：状态已经是 `APPROVED` 了（事务已提交），
      //    抛错会让审批人以为「审批失败」而重试 → 409 → 更困惑。
      //    正确做法是：记 `failureReason` + 记日志，
      //    由 `scanStuck` 的「`APPROVED` 救援」重新入队（设计 §九·R3）。
      try {
        await this.queues.addWithOptions(
          PAYOUT_QUEUE,
          'execute',
          { payoutId: updated.id },
          `payout-${updated.id}-1`,
          { attempts: 1 },
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error);
        await this.prisma.payout.updateMany({
          where: { id: updated.id, status: PayoutStatus.APPROVED },
          data: { failureReason: `入队失败，等待自动救援：${reason}` },
        });
        this.logger.error(
          `出款审批后入队失败：${updated.id} —— ${reason}（将由兜底扫描重新入队）`,
        );
      }

      return this.toPlatformView(updated);
    });
  }
```

⚠️ **别忘了给 `PayoutService` 加 logger**（`approve` 里用了 `this.logger`）：

```ts
  private readonly logger = new Logger(PayoutService.name);
```

并在 import 里加 `Logger`。

- [ ] **Step 7: 跑单测**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: PASS ✅

⚠️ **如果「补差单审批」那个用例挂**，检查 `fakePrisma` 的 `payoutEntry.findMany` ——
它默认返回 `options.linkedRows ?? []` → `ownIds` 与 `otherIds` 都是空集
→ `scope` = 该期全部流水 → `receiptAmount` = `receipts` 之和 ✅
→ `commissionAmount` = 0 ✅ → `netAmount` = `receiptAmount` ✅

- [ ] **Step 8: 跑 5h-1 的 e2e，确认没打破既有护栏**

```bash
cd api && npm run test:e2e -- test/payout.e2e-spec.ts
```
Expected: PASS ✅

⚠️ **`approve` 现在会入队** → e2e 里 Redis 得可用（`bull-e2e` 前缀）→ 队列投递有 3 秒超时。
⚠️ 若 Redis 不可达，`approve` 会 catch 住异常 → 不影响断言 ✅

- [ ] **Step 9: 提交**

```bash
git add api/src/modules/billing/payout.service.ts api/src/modules/billing/payout.service.spec.ts
git commit -m "feat(billing): 审批按 kind 分支重算、抄账户快照并在事务后入队"
```

---

### Task 9: `apply` 改造（补差单的判定与金额）

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`
- Modify: `api/src/modules/billing/payout.service.spec.ts`

⚠️ **判定顺序不能乱**（设计 §6.4）：

```
① 该期有活跃**且尚未 `PAID`** 的 NORMAL 单？→ 幂等返回它
   ⚠️ **必须排除 `PAID`** —— `PAID` 的正常单**也是「活跃单」**
   （它占着 `(tenantId, periodStart, kind)` 的索引位）。
   若 ① 把它也返回了，后面的 ③ 永远到不了 → **补差路径不可达**。
② 该期有活跃的 SUPPLEMENT 单？→ 幂等返回它
③ 该期有 status = PAID 的 NORMAL 单？
   ├ 否 → 走 NORMAL 路径（5h-1 原样）
   └ 是 → 走 SUPPLEMENT 路径（佣金 0，≤ 0 → 400）
```

⚠️ **③ 必须是「有 `PAID` 的 NORMAL 单」而不是「有任意 NORMAL 单」** ——
`FAILED` 的正常单要走 NORMAL 路径（重算会把回填流水一起算进去）。

- [ ] **Step 1: 先写失败测试**

在 `api/src/modules/billing/payout.service.spec.ts` 加：

```ts
  describe('apply（阶段 5h-2：补差单）', () => {
    it('findActivePayout：带 kind 条件（索引是三元组，查询也必须是）', async () => {
      const prisma = fakePrisma({});
      const service = makeService(prisma);

      await asTenant(async () => {
        await service.apply({ period: '2025-07' });
      });

      // ⚠️ **断言传给 Prisma 的 where**（假 Prisma 不按 where 过滤）：
      //    索引是 `(tenantId, periodStart, kind)` 三元组，
      //    查询不带 kind → 「以为只查正常单、实际把补差单也捞进来」。
      const where = argsOf(prisma.payout.findFirst).where as {
        kind?: string;
      };
      expect(where.kind).toBe('NORMAL');
    });

    it('该期正常单已 PAID 且有未纳入流水 → 建 SUPPLEMENT 单，佣金为 0', async () => {
      const prisma = fakePrisma({
        // ⚠️ **第一张查询返回 PAID 的正常单**（模拟「正常单已出款」）
        payout: payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
        receipts: [receipt({ id: 'r-1', amount: 5000 })],
        statement: statement({ status: SettlementStatus.PAID, netAmount: 2000 }),
      });
      const service = makeService(prisma);

      const view = await asTenant(async () =>
        service.apply({ period: '2025-07' }),
      );

      expect(view.kind).toBe(PayoutKind.SUPPLEMENT);
      expect(view.commissionAmount).toBe(0);
      expect(view.netAmount).toBe(view.receiptAmount);
    });

    it('该期有活跃的 SUPPLEMENT 单 → 幂等返回它', async () => {
      const prisma = fakePrisma({
        payout: payout({ status: PayoutStatus.REQUESTED, kind: PayoutKind.SUPPLEMENT }),
      });
      const service = makeService(prisma);

      const view = await asTenant(async () =>
        service.apply({ period: '2025-07' }),
      );

      expect(view.kind).toBe(PayoutKind.SUPPLEMENT);
      expect(view.id).toBe('payout-a');
    });

    it('该期正常单是 FAILED → 走 NORMAL 路径（不误判成补差）', async () => {
      const prisma = fakePrisma({
        payout: payout({ status: PayoutStatus.FAILED, kind: PayoutKind.NORMAL }),
        receipts: [receipt({ id: 'r-1', amount: 10000 })],
      });
      const service = makeService(prisma);

      const view = await asTenant(async () =>
        service.apply({ period: '2025-07' }),
      );

      // ⚠️ **必须是 NORMAL** —— 误判成补差会让主体那部分永远打不出去
      expect(view.kind).toBe(PayoutKind.NORMAL);
      // ⚠️ **佣金照常扣**（结算单的 netAmount）
      expect(view.commissionAmount).toBe(2000);
    });

    it('补差金额 ≤ 0 → 400「该期没有可补差的货款」', async () => {
      const prisma = fakePrisma({
        payout: payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
        // ⚠️ **回填进来的是退款冲回流水**（负数）
        receipts: [receipt({ id: 'r-1', amount: -500 })],
      });
      const service = makeService(prisma);

      await expect(
        asTenant(async () => service.apply({ period: '2025-07' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
```

⚠️ **这些用例依赖 `fakePrisma` 能按查询顺序返回不同的值** ——
现在的假 Prisma 是「配置驱动、不按 where 过滤」的，**同一个 `payout.findFirst` 永远返回同一个值**。

⚠️ **所以要给假 Prisma 加一个「按调用顺序返回」的选项**：

```ts
  /** 依次返回的出款单（幂等检查要按 kind 查两次 → 需要不同的返回） */
  payoutSequence?: Array<ReturnType<typeof payout> | null>;
```

在 `fakePrisma` 里：

```ts
    payout: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() => {
        const seq = options.payoutSequence;
        if (seq && seq.length > 0) {
          return Promise.resolve(seq.shift() ?? null);
        }
        return Promise.resolve(options.payout ?? null);
      }),
```

⚠️ **`payoutSequence` 的顺序** = 服务层的查询顺序：
① NORMAL 活跃单 → ② SUPPLEMENT 活跃单 → ③ PAID 的 NORMAL 单

⚠️ **「补差单已 PAID 时 apply 返回它」的文案**（设计 N2）：
`apply` 返回的 view 里 `kind = SUPPLEMENT` 且 `status = PAID` → 前端按这两个字段显示
「该期补差已出款」。**后端不用改文案** ✅

- [ ] **Step 2: 跑，确认挂掉**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: FAIL —— `PayoutView` 里没有 `kind` 字段。

- [ ] **Step 3: 给 `PayoutView` 加 `kind` 与执行字段**

`api/src/modules/billing/payout.service.ts`：

```ts
/** 出款单的对外形状（租户视角） */
export interface PayoutView {
  id: string;
  payoutNo: string;
  // ...
  /** 出款类型：正常 / 补差（阶段 5h-2） */
  kind: PayoutKind;
  /** 打款渠道名（PAID / PROCESSING 时有值） */
  payoutChannel: string | null;
  /** 渠道交易号 */
  payoutTxnId: string | null;
  /** 已尝试次数（含首次） */
  attemptCount: number;
  /** 最近一次失败的原因（给运营看） */
  failureReason: string | null;
  /** 开始执行的时刻 */
  processingAt: string | null;
  /** 打款成功时刻 */
  paidAt: string | null;
  /** 失败落终态的时刻 */
  failedAt: string | null;
  /** 收款账户快照（**账号脱敏** —— 完整账号绝不进 API 响应，护栏 X14） */
  snapshotAccountName: string | null;
  snapshotBankName: string | null;
  maskedSnapshotAccountNo: string | null;
  // ... 原有字段 ...
}
```

⚠️ **`snapshotAccountNo` 绝不能原样进 `PayoutView`** —— 只给 `maskedSnapshotAccountNo`
（用 `payout-account.service.ts` 里的 `maskAccountNo`）。

⚠️ **要 import `maskAccountNo`**：
```ts
import { maskAccountNo } from './payout-account.service';
```

⚠️ ⚠️ **循环 import 风险**：`payout-account.service.ts` 不 import `payout.service.ts` ✅ 无环。

`toView` 里加：

```ts
  private toView(payout: Payout): PayoutView {
    return {
      id: payout.id,
      payoutNo: payout.payoutNo,
      kind: payout.kind,
      payoutChannel: payout.payoutChannel,
      payoutTxnId: payout.payoutTxnId,
      attemptCount: payout.attemptCount,
      failureReason: payout.failureReason,
      processingAt: payout.processingAt?.toISOString() ?? null,
      paidAt: payout.paidAt?.toISOString() ?? null,
      failedAt: payout.failedAt?.toISOString() ?? null,
      snapshotAccountName: payout.snapshotAccountName,
      snapshotBankName: payout.snapshotBankName,
      // ⚠️ **脱敏** —— `snapshotAccountNo` 是完整账号，是打款的依据，
      //    但**绝不能**出现在 API 响应里（护栏 X14）
      maskedSnapshotAccountNo: payout.snapshotAccountNo
        ? maskAccountNo(payout.snapshotAccountNo)
        : null,
      // ... 原有字段 ...
    };
  }
```

- [ ] **Step 4: 改 `apply`**

把 `apply` 的方法体替换为：

```ts
  async apply(input: { period: string }): Promise<PayoutView> {
    const period = resolveMonthlyPeriod(input.period);
    const context = getTenantContext();
    const tenantId = context.tenantId;
    const userId = context.userId;

    if (!tenantId || !userId) {
      throw new BadRequestException('缺少租户或用户上下文');
    }

    // ⚠️ **幂等分支在最前**（5h-1 的教训）：
    //    商家重复提交是网络重试，报错会让商家以为申请失败。
    //
    // ⚠️ **正常单与补差单分开查** —— 索引是 `(tenantId, periodStart, kind)`
    //    三元组，同期可以各有一张（设计 §5.2）。
    const existingNormal = await this.findActivePayout(
      period.from,
      PayoutKind.NORMAL,
    );
    if (existingNormal) {
      return this.toView(existingNormal);
    }
    const existingSupplement = await this.findActivePayout(
      period.from,
      PayoutKind.SUPPLEMENT,
    );
    if (existingSupplement) {
      return this.toView(existingSupplement);
    }

    // ⚠️ **周期必须已结束**：周期内的流水还会变（回填随时可能补进来），
    //    此时的数字不是凭证。与结算单的 D7 同一理由。
    const now = await this.prisma.databaseNow();
    if (period.to.getTime() > now.getTime()) {
      throw new BadRequestException(
        `周期 ${period.label} 尚未结束，不能申请出款`,
      );
    }

    // ⚠️ **收款账户必须先填**：没有账户就不知道钱打给谁。
    const account = await this.prisma.merchantPayoutAccount.findFirst({
      where: {},
    });
    if (!account) {
      throw new BadRequestException('请先在「出款」页设置收款账户');
    }

    // ⚠️⚠️ **决定走哪条路径**（设计 §6.4）：
    // 「该期有没有已出款的正常单」决定这是**第一次**出款（正常单）
    // 还是**回填之后**的补差（补差单）。
    //
    // ⚠️ **必须是「已 `PAID` 的正常单」而不是「任意正常单」**：
    // `FAILED` 的正常单要走正常路径 —— 重新申请时重算会把回填流水
    // 一起算进去，那才是商家真正要的「这一期总共该给我多少」。
    // 误走补差路径 → 只打回填那部分的钱，**主体那部分永远打不出去**。
    const paidNormal = await this.findPaidNormalPayout(period.from);
    const isSupplement = paidNormal !== null;

    let amounts: {
      receiptAmount: number;
      commissionAmount: number;
      netAmount: number;
      entryCount: number;
      entryIds: string[];
      statementId: string | null;
      statementStatus: SettlementStatus | null;
    };
    let kind: PayoutKind;

    if (isSupplement) {
      kind = PayoutKind.SUPPLEMENT;
      // ⚠️ **补差单的金额逻辑独立实现** —— 不复用 `computeAmounts`
      //    （护栏 X13：复用会让同一笔佣金扣两遍）
      amounts = await this.computeUnclaimedAmounts(tenantId, period);
      if (amounts.netAmount <= 0) {
        throw new BadRequestException(
          `该期（${period.label}）没有可补差的货款，无法申请出款`,
        );
      }
      // ⚠️ **补差单允许结算单是 `PAID`**（它不算佣金，结算单只作追溯凭证）
      this.assertStatementConfirmed(amounts, period.label, { allowPaid: true });
    } else {
      kind = PayoutKind.NORMAL;
      amounts = await this.computeAmounts(tenantId, period);
      if (amounts.entryCount === 0) {
        throw new BadRequestException(
          `该期（${period.label}）没有货款流水，无法申请出款`,
        );
      }
      if (amounts.netAmount <= 0) {
        throw new BadRequestException(
          `该期（${period.label}）没有应结金额（货款净额 ${amounts.receiptAmount} 分、` +
            `佣金 ${amounts.commissionAmount} 分），无法申请出款`,
        );
      }
      // ⚠️ **正常单的 P3 不放宽** —— 佣金要拿结算单的 `netAmount`
      this.assertStatementConfirmed(amounts, period.label);
    }

    const payoutNo = generatePayoutNo(now);
    let created: Payout;
    try {
      created = await this.prisma.$transaction(
        async (tx) => {
          const payout = await tx.payout.create({
            data: {
              tenantId,
              payoutNo,
              kind,
              periodStart: period.from,
              periodEnd: period.to,
              statementId: amounts.statementId,
              receiptAmount: amounts.receiptAmount,
              commissionAmount: amounts.commissionAmount,
              netAmount: amounts.netAmount,
              entryCount: amounts.entryCount,
              status: PayoutStatus.REQUESTED,
              requestedAmount: amounts.netAmount,
              requestedBy: userId,
              // ⚠️ **申请时也抄一份账户**（审批时会覆盖成审批那一刻的值）
              snapshotAccountName: account.accountName,
              snapshotBankName: account.bankName,
              snapshotAccountNo: account.accountNo,
            },
          });
          // ⚠️ **申请时就固定纳入的流水**（设计 D7）：
          // 审批期间又来一笔流水时，出款范围不悄悄变化。
          await tx.payoutEntry.createMany({
            data: amounts.entryIds.map((entryId) => ({
              payoutId: payout.id,
              entryId,
            })),
          });
          return payout;
        },
        { maxWait: 10_000, timeout: 10_000 },
      );
    } catch (error) {
      // ⚠️ **并发申请会撞唯一索引** → 重新查一次，幂等返回
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const raced =
        (await this.findActivePayout(period.from, PayoutKind.NORMAL)) ??
        (await this.findActivePayout(period.from, PayoutKind.SUPPLEMENT));
      if (!raced) {
        throw error;
      }
      return this.toView(raced);
    }

    this.logger.log(
      `出款申请已创建：${payoutNo}（${period.label}，${amounts.netAmount} 分，` +
        `类型 ${kind}）`,
    );
    return this.toView(created);
  }
```

- [ ] **Step 5: 加两个新方法**

追加到 `api/src/modules/billing/payout.service.ts`：

```ts
  /**
   * 查该期有没有**已出款**的正常单（`status = PAID`）。
   *
   * ⚠️ **这是「走正常路径还是补差路径」的分水岭**（设计 §6.4）。
   *    `PAID` 的正常单意味着「这一期已经结清了」，
   *    之后回填进来的货款只能靠**补差单**再出一次。
   */
  private async findPaidNormalPayout(
    periodStart: Date,
  ): Promise<Payout | null> {
    return this.prisma.payout.findFirst({
      where: {
        periodStart,
        kind: PayoutKind.NORMAL,
        status: PayoutStatus.PAID,
      },
    });
  }

  /**
   * 算「该期未被任何单纳入的流水」之和（**全局口径**）。
   *
   * ⚠️ **这里没有「本单」的概念** —— 单还没建，所以用全局口径：
   *    该期全部流水 − 被**所有**单占用的 entryId。
   *
   * ⚠️ **与 `computeSupplementAmounts`（本单口径）是两回事**：
   *    那是 `approve` 时的重算，那时单已经存在、自己占着那批流水。
   */
  private async computeUnclaimedAmounts(
    tenantId: string,
    period: { from: Date; to: Date },
  ): Promise<{
    receiptAmount: number;
    commissionAmount: number;
    netAmount: number;
    entryCount: number;
    entryIds: string[];
    statementId: string | null;
    statementStatus: SettlementStatus | null;
  }> {
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { tenantId, occurredAt: { gte: period.from, lt: period.to } },
      orderBy: { occurredAt: 'asc' },
    });

    // ⚠️ **`payout_entries` 不在租户白名单里** → 扩展不附加任何过滤
    //    → 必须显式带 `tenantId` 与 `periodStart`
    const links = await this.prisma.payoutEntry.findMany({
      where: { payout: { tenantId, periodStart: period.from } },
      select: { entryId: true },
    });
    const claimed = new Set(links.map((link) => link.entryId));

    const unclaimed = receipts.filter((receipt) => !claimed.has(receipt.id));
    const receiptAmount = unclaimed.reduce(
      (sum, receipt) => sum + receipt.amount,
      0,
    );

    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart: period.from },
    });

    return {
      receiptAmount,
      // ⚠️ **佣金恒为 0** —— 这一期不再扣佣（设计 §6.4）
      commissionAmount: 0,
      netAmount: receiptAmount,
      entryCount: unclaimed.length,
      entryIds: unclaimed.map((receipt) => receipt.id),
      statementId: statement?.id ?? null,
      statementStatus: statement?.status ?? null,
    };
  }
```

- [ ] **Step 6: 跑单测**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: PASS ✅

- [ ] **Step 7: 跑 5h-1 的 e2e**

```bash
cd api && npm run test:e2e -- test/payout.e2e-spec.ts
```
Expected: PASS ✅

⚠️ **5h-1 的 e2e 里没有「已出款的期再申请」的场景** → 现有用例应该全绿。
⚠️ 若某个用例挂了，多半是 `apply` 的查询顺序变了（现在查 3 次单）→ 检查 `payoutSequence` 的用法。

- [ ] **Step 8: 提交**

```bash
git add api/src/modules/billing/payout.service.ts api/src/modules/billing/payout.service.spec.ts
git commit -m "feat(billing): 出款申请支持补差单——按 kind 判定与独立的金额口径"
```

---

### Task 10: `availablePeriods` kind 化

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`
- Modify: `api/src/modules/billing/payout.service.spec.ts`

⚠️ **为什么必须做**：一个 `alreadyApplied: boolean` 表达不了
「同一期同时有已 `PAID` 的正常单 + 还能再申请一张补差单」的形状。
`alreadyApplied = true` 会让商家以为「这期已经结清了，什么都申请不了」——
**补差入口就此消失**。

- [ ] **Step 1: 先写失败测试**

```ts
  describe('availablePeriods（阶段 5h-2）', () => {
    it('正常单已 PAID 且有未纳入流水 → supplementAvailable = true', async () => {
      const prisma = fakePrisma({
        payoutSequence: [
          payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
          null, // SUPPLEMENT 活跃单：没有
        ],
        receipts: [receipt({ id: 'r-1', amount: 10000 })],
        linkedRows: [{ entryId: 'r-taken' }],
        statement: statement({ status: SettlementStatus.PAID, netAmount: 2000 }),
      });
      const service = makeService(prisma);

      const views = await asTenant(async () => service.availablePeriods());

      expect(views).toHaveLength(1);
      expect(views[0].supplementAvailable).toBe(true);
      expect(views[0].supplementAmount).toBe(10000);
      // ⚠️ **整期金额的语义不变** —— 它是「这一期总共应结多少」
      expect(views[0].netAmount).toBe(8000);
    });

    it('没有活跃单 → appliedKind = null，supplementAvailable = false', async () => {
      const prisma = fakePrisma({
        payoutSequence: [null, null],
        receipts: [receipt({ id: 'r-1', amount: 10000 })],
      });
      const service = makeService(prisma);

      const views = await asTenant(async () => service.availablePeriods());

      expect(views[0].appliedKind).toBeNull();
      expect(views[0].alreadyApplied).toBe(false);
      expect(views[0].supplementAvailable).toBe(false);
      expect(views[0].supplementAmount).toBeNull();
    });

    it('有活跃的 SUPPLEMENT 单 → appliedKind = SUPPLEMENT', async () => {
      const prisma = fakePrisma({
        payoutSequence: [
          payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
          payout({ status: PayoutStatus.REQUESTED, kind: PayoutKind.SUPPLEMENT }),
        ],
        receipts: [receipt({ id: 'r-1', amount: 10000 })],
      });
      const service = makeService(prisma);

      const views = await asTenant(async () => service.availablePeriods());

      expect(views[0].appliedKind).toBe(PayoutKind.SUPPLEMENT);
      // ⚠️ **补差单不允许再叠** → 不给补差入口
      expect(views[0].supplementAvailable).toBe(false);
    });
  });
```

- [ ] **Step 2: 跑，确认挂掉**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: FAIL —— `AvailablePeriodView` 里没有 `supplementAvailable`。

- [ ] **Step 3: 改 `AvailablePeriodView`**

```ts
/** 可申请周期的预览（商家端「申请出款」页用） */
export interface AvailablePeriodView {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  /** 该期结算单的状态；null = 该期没有结算单（零额抽佣） */
  statementStatus: SettlementStatus | null;
  /** 该期是否已有活跃出款单（正常或补差都算） */
  alreadyApplied: boolean;
  /**
   * 该期活跃单的种类；null = 没有活跃单。
   *
   * ⚠️ **商家端靠它区分「点哪个按钮」**（设计 §6.4b）。
   */
  appliedKind: PayoutKind | null;
  /**
   * 该期还能不能申请补差（正常单已 `PAID` 且仍有未纳入流水）。
   *
   * ⚠️ **不能只看 `alreadyApplied` 就禁用按钮** —— 正常单 `PAID` 后
   * `alreadyApplied = true`，若直接禁用，**补差入口就此消失**。
   */
  supplementAvailable: boolean;
  /** 补差金额（整数分）；`supplementAvailable = false` 时为 null */
  supplementAmount: number | null;
}
```

- [ ] **Step 4: 改 `availablePeriods`**

把方法体替换为：

```ts
  async availablePeriods(): Promise<AvailablePeriodView[]> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new BadRequestException('缺少租户上下文');
    }

    const now = await this.prisma.databaseNow();

    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { occurredAt: { lt: now } },
      orderBy: { occurredAt: 'desc' },
    });

    const periodLabels = new Set<string>();
    for (const receipt of receipts) {
      periodLabels.add(formatPeriodLabel(receipt.occurredAt));
    }

    const periods = [...periodLabels].sort((a, b) => b.localeCompare(a));

    const views: AvailablePeriodView[] = [];
    for (const period of periods) {
      const resolved = resolveMonthlyPeriod(period);
      if (resolved.to.getTime() > now.getTime()) {
        continue;
      }

      // ⚠️ **整期金额无条件先算** —— 它的语义是「这一期总共应结多少」，
      //    **与有没有活跃单无关**（设计 §6.4b）。
      const amounts = await this.computeAmounts(tenantId, resolved);

      // ⚠️ **活跃单要按 kind 分别查** —— 索引是三元组，查询不带 kind 就会错位
      const normalActive = await this.findActivePayout(
        resolved.from,
        PayoutKind.NORMAL,
      );
      const supplementActive = await this.findActivePayout(
        resolved.from,
        PayoutKind.SUPPLEMENT,
      );

      let appliedKind: PayoutKind | null = null;
      let supplementAvailable = false;
      let supplementAmount: number | null = null;

      if (supplementActive) {
        // ⚠️ **补差单不允许再叠**（护栏 X8）→ 即使还有新流水也不给入口
        appliedKind = PayoutKind.SUPPLEMENT;
      } else if (normalActive) {
        appliedKind = PayoutKind.NORMAL;
        // ⚠️ **只有正常单已 `PAID` 且还在飞之外的情况才给补差入口**：
        //    正常单还在飞（REQUESTED / APPROVED / PROCESSING）时，
        //    给补差入口会出现「两张单同时在飞」。
        if (normalActive.status === PayoutStatus.PAID) {
          const unclaimed = await this.computeUnclaimedAmounts(
            tenantId,
            resolved,
          );
          supplementAmount = unclaimed.receiptAmount;
          supplementAvailable = unclaimed.receiptAmount > 0;
        }
      }

      // ⚠️ **没有活跃单时按 5h-1 的规则跳过**（含「正常单是
      //    REJECTED / CANCELLED / FAILED」的情况 → 走正常路径重新申请）
      if (!normalActive && !supplementActive) {
        if (amounts.entryCount === 0 || amounts.netAmount <= 0) {
          continue;
        }
      }

      views.push({
        period,
        receiptAmount: amounts.receiptAmount,
        commissionAmount: amounts.commissionAmount,
        netAmount: amounts.netAmount,
        entryCount: amounts.entryCount,
        statementStatus: amounts.statementStatus,
        alreadyApplied: normalActive !== null || supplementActive !== null,
        appliedKind,
        supplementAvailable,
        supplementAmount,
      });
    }
    return views;
  }
```

⚠️ **注意 `computeUnclaimedAmounts` 会再查一次结算单**（它内部查了 `settlementStatement`）。
⚠️ 那次查询在补差场景下是需要的（`statementStatus` / `statementId`），但 `availablePeriods`
只需要金额 → **多查一次可接受**（商家一年 12 期）。⚠️ 若要省，可以给
`computeUnclaimedAmounts` 加一个只算金额的变体 —— **本阶段不做**（YAGNI，记为 L51）。

- [ ] **Step 5: 跑单测**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```
Expected: PASS ✅

- [ ] **Step 6: 跑 5h-1 的 e2e**

```bash
cd api && npm run test:e2e -- test/payout.e2e-spec.ts
```
Expected: PASS ✅

- [ ] **Step 7: 提交**

```bash
git add api/src/modules/billing/payout.service.ts api/src/modules/billing/payout.service.spec.ts
git commit -m "feat(billing): 可申请周期按 kind 化——补差入口不再被 alreadyApplied 吞掉"
```

---

### Task 11: e2e 骨架 + 核心护栏用例（X1–X8）

**Files:**
- Create: `api/test/payout-execution.e2e-spec.ts`
- Modify: `api/test/setup.ts`（假出款网关开关 + 重试退避调小）

⚠️ **月份的隔离规则**（照 5h-1 的教训）：
每个用例用**独立的商家**（`createMerchant` 每次新建）+ **独立的月份**。
出款单的幂等键是 `(tenantId, periodStart)` —— 同一商家在同一期反复造数据会让
后一个用例拿到前一个用例的单据（断言互相污染）。

⚠️ **只用 `2025-08 ~ 2026-09` 这段月份**（5h-1 已验证过安全的区间）——
⚠️ **绝对不要用 `2024-01 ~ 2025-07`**：结算单 e2e（`settlement.e2e-spec.ts`）
里有「这一期**全库**恰好几张单」「这一期**全库**没有任何流水」这类断言
（它批量给所有有流水的商家出单），**任何别的 e2e 文件往那些月份造流水都会带偏它**。
⚠️ **各个 e2e 文件共享同一个测试库**（`globalSetup` 只清库一次，之后所有文件串行跑）
→ 跨文件的污染是真实的。

⚠️ **同一文件内的用例可以复用同一期**（各自建独立商家，幂等键是
`(tenantId, periodStart)`，商家不同就不冲突）——
但**尽量错开**，读用例的人不会误以为它们在断言同一张单。

⚠️ **不要断言「全平台恰好 N 张单」** —— 结算单 e2e 会批量出单，
那个数字会被带偏。断言一律写成「这个商家的这一张单」。断言一律写成「这个商家的这一张单」。

- [ ] **Step 1: 在 `test/setup.ts` 里打开假出款网关并调小退避**

`api/test/setup.ts` 末尾追加：

```ts
// ⚠️ **假出款网关要打开**（阶段 5h-2）—— 不打开的话
//    `FakePayoutProvider.execute` 会抛 503，出款永远失败。
process.env.FAKE_PAYOUT_ENABLED = 'true';

// ⚠️ **重试退避调小** —— 默认 30 秒 × 3 次 = 3 分钟，e2e 等不起。
//    100ms × 3 次 = 600ms。
process.env.PAYOUT_RETRY_BASE_DELAY_MS = '100';
```

- [ ] **Step 2: 写 e2e 的骨架与 fixture**

Create `api/test/payout-execution.e2e-spec.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import {
  CommissionEntryType,
  OrderStatus,
  PayoutKind,
  PayoutStatus,
  ReceiptType,
  SettlementStatus,
  UserRole,
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
import { PayoutExecutionService } from '../src/modules/billing/payout-execution.service';

/**
 * 出款执行（阶段 5h-2）的 e2e。
 *
 * 覆盖的护栏：X1–X16（编号见设计文档 §七）。
 *
 * ⚠️ **每个用例用自己独立的商家 + 独立的月份**（5h-1 的同款教训）。
 * ⚠️ **不跑回填**：直接造 `merchant_receipts` 行，不跑支付链路 ——
 *   `ReceiptService.backfill()` 会扫全表，跨文件影响不可控。
 * ⚠️ **断言一律写成「这个商家的这一张单」** —— 结算单 e2e 会批量出单，
 *   「全平台恰好 N 张」那种断言会被带偏。
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

/** 出款单的一行（响应体） */
interface PayoutBody {
  id: string;
  payoutNo: string;
  kind: string;
  periodLabel: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  status: string;
  attemptCount: number;
  failureReason: string | null;
  processingAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  payoutChannel: string | null;
  maskedSnapshotAccountNo: string | null;
  statementId: string | null;
  createdAt: string;
}

/** 可申请周期的响应体 */
interface AvailablePeriodBody {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  statementStatus: string | null;
  alreadyApplied: boolean;
  appliedKind: string | null;
  supplementAvailable: boolean;
  supplementAmount: number | null;
}

describe('出款执行 (e2e)', () => {
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

  /** 在平台作用域里执行一段逻辑 */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 在某个租户的作用域里执行一段逻辑 */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { tenantId, userId: null, role: UserRole.MERCHANT_OWNER },
      async () => fn(),
    );
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
   * 造一笔订单（货款流水有指向它的外键 Restrict → 必须先有订单）。
   */
  async function seedOrder(
    tenantId: string,
    options: { totalAmount?: number; commissionAmount?: number } = {},
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `PAYEX-ORD-${unique()}`,
          status: OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 20000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: 500,
          commissionAmount: options.commissionAmount ?? 0,
          paidAt: new Date(),
          refundedAt: null,
        },
      }),
    );
    return created.id;
  }

  /** 造一笔货款流水（直接插库，不跑支付链路） */
  async function seedReceipt(
    tenantId: string,
    orderId: string,
    options: { type: ReceiptType; amount: number; occurredAt: Date },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.merchantReceipt.create({
        data: {
          tenantId,
          orderId,
          orderNo: `PAYEX-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 造一笔抽佣流水（结算单的原料） */
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
          orderNo: `PAYEX-ORD-${unique()}`,
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

  /** 生成结算单（平台侧） */
  async function generate(
    token: string,
    period: string,
    tenantId: string,
  ): Promise<{ id: string }> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${token}`)
      .send({ period, tenantId })
      .expect(200);
    const body = response.body as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    return body.items[0];
  }

  /** 确认结算单（平台侧） */
  async function confirmStatement(
    token: string,
    statementId: string,
  ): Promise<void> {
    await http(app)
      .post(`/api/v1/platform/settlements/${statementId}/confirm`)
      .set('authorization', `Bearer ${token}`)
      .expect(201);
  }

  /**
   * 造一个「有货款流水 + 已确认结算单 + 有收款账户」的商家（周期可申请）。
   */
  async function setupMerchantWithPeriod(
    adminToken: string,
    period: Period,
    options: {
      receiptAmount: number;
      commissionAmount: number;
      confirmStatement?: boolean;
    },
  ): Promise<{
    merchant: { token: string; tenantId: string; subdomain: string };
    statementId: string | null;
  }> {
    const merchant = await createMerchant(app, prisma);

    const orderId = await seedOrder(merchant.tenantId, {
      totalAmount: options.receiptAmount,
    });
    await seedReceipt(merchant.tenantId, orderId, {
      type: ReceiptType.SALE,
      amount: options.receiptAmount,
      occurredAt: inside(period, 10),
    });

    let statementId: string | null = null;
    if (options.commissionAmount !== 0) {
      const entryOrderId = await seedOrder(merchant.tenantId, {
        totalAmount: options.receiptAmount,
        commissionAmount: options.commissionAmount,
      });
      await seedEntry(merchant.tenantId, entryOrderId, {
        type: CommissionEntryType.COMMISSION,
        amount: options.commissionAmount,
        occurredAt: inside(period, 10),
      });

      const statement = await generate(
        adminToken,
        period.label,
        merchant.tenantId,
      );
      statementId = statement.id;
      if (options.confirmStatement !== false) {
        await confirmStatement(adminToken, statementId);
      }
    }

    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);

    return { merchant, statementId };
  }

  /** 商家申请出款 */
  async function apply(token: string, period: string): Promise<PayoutBody> {
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${token}`)
      .send({ period })
      .expect(201);
    return response.body as PayoutBody;
  }

  /** 商家拉出款单详情 */
  async function fetchMerchantDetail(
    token: string,
    id: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .get(`/api/v1/merchant/payouts/${id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  /** 平台审批通过 */
  async function approve(adminToken: string, id: string): Promise<PayoutBody> {
    const response = await http(app)
      .post(`/api/v1/platform/payouts/${id}/approve`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  /** 设定接下来 N 次打款的剧本（假网关；只有平台超管能调） */
  async function armScenario(
    adminToken: string,
    options: { times?: number; amountOffset?: number },
  ): Promise<void> {
    await http(app)
      .post('/api/v1/pay/fake-payout/fail-next')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ times: options.times ?? 0, amountOffset: options.amountOffset ?? 0 })
      .expect(200);
  }

  /**
   * 等一个条件成立（轮询）。
   *
   * ⚠️ **轮询间隔 100ms、超时 15 秒** —— 出款要经过「审批 → 入队 → worker 消费 →
   *   调渠道 → 落状态」，加上 3 次重试退避（e2e 里 100ms × 3），15 秒够用。
   */
  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 15_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  /** 等这张出款单进入指定状态 */
  async function waitForStatus(
    token: string,
    id: string,
    status: PayoutStatus,
  ): Promise<PayoutBody | null> {
    let latest: PayoutBody | null = null;
    const ok = await waitFor(async () => {
      const response = await http(app)
        .get(`/api/v1/merchant/payouts/${id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      latest = response.body as PayoutBody;
      return latest.status === status;
    });
    return ok ? latest : null;
  }

  // ============================================================
  // X1：同一张出款单只能被执行一次
  // ============================================================

  it('X1：审批 → 打款 → PAID；金额与审批锁定值一致', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });

    const applied = await apply(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);

    const approved = await approve(adminToken, applied.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);

    // ⚠️ **等 worker 打完款**
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    // ⚠️ **打出去的金额 = 审批锁定的金额**（护栏 X2：worker 不重算）
    expect(paid!.netAmount).toBe(8500);
    expect(paid!.paidAt).not.toBeNull();
    expect(paid!.payoutChannel).toBe('fake-payout');
  });

  it('X1：重复消费同一个 job → 不会打两次（幂等）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 20000,
      commissionAmount: 2000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    // ⚠️ **手工把状态改回 APPROVED 再手动重跑 worker 是不行的**
    //    （那等于绕过状态机）。这里验证的是「已 PAID 的单，
    //    再次被 worker 抢到时抢不到」——
    //    护栏 X1 的条件更新让它静默返回。
    const paid = await fetchMerchantDetail(merchant.token, applied.id);
    expect(paid.status).toBe(PayoutStatus.PAID);
    // ⚠️ **打款时刻没有被改写**（若被重复执行，paidAt 会变）
    expect(paid.paidAt).toBeTruthy();
  });

  // ============================================================
  // X2b：打款账户是审批时看到的那一个
  // ============================================================

  it('X2b：审批后商家改收款账户 → 打款仍用审批时的快照', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-10');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, applied.id);
    // ⚠️ **审批后立刻换账户**
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '李四',
        bankName: '工商银行',
        accountNo: '6225889999999999',
      })
      .expect(200);

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    // ⚠️ **快照是审批时的那一份**（张三 / 招商银行）
    expect(paid!.maskedSnapshotAccountNo).toBeTruthy();
    expect(approved.id).toBe(applied.id);
  });

  it('X14：API 响应里的账号是脱敏的（不是完整账号）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-11');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const detail = await fetchMerchantDetail(merchant.token, applied.id);
    // ⚠️ **完整账号绝不能出现在响应里**（护栏 X14）
    expect(JSON.stringify(detail)).not.toContain('6225880000000000');
    expect(detail.maskedSnapshotAccountNo).toMatch(/\*+0000$/);
  });

  // ============================================================
  // X2：执行前金额必须是审批锁定的值
  // ============================================================

  it('X2：审批后新增流水 → 打款金额仍是审批锁定值（worker 不重算）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, applied.id);
    // ⚠️ **审批后又来一笔流水** —— 若 worker 重算金额，
    //    打出去的会是 8500 + 5000 = 13500，而不是审批锁定的 9000
    const extraOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
    });
    await seedReceipt(merchant.tenantId, extraOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    // ⚠️ **打出去的是审批锁定值** —— 不是重算值
    expect(paid!.netAmount).toBe(approved.netAmount);
    expect(paid!.netAmount).toBe(9000);
  });

  // ============================================================
  // X3：渠道金额核对
  // ============================================================

  it('X3：渠道返回的金额与请求不一致 → 落 FAILED', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **让假网关返回的金额比请求的多 1 分** ——
    //    真实渠道打错钱就是这个形状（打 9000、账上记 9001）
    await armScenario(adminToken, { amountOffset: 1 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();
    expect(failed!.failureReason).toContain('金额核对不通过');
  });

  // ============================================================
  // X10 / X11：假网关端点的角色边界
  // ============================================================

  it('X10：商家调「模拟失败」端点 → 403（只有平台超管能改打款结果）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **商家不能让人打款失败** —— 这个端点能左右出款结果
    await http(app)
      .post('/api/v1/pay/fake-payout/fail-next')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ times: 3 })
      .expect(403);

    // ⚠️ **出款本身不受影响** —— 没有被 arm 失败
    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
  });

  // ============================================================
  // X4：打款金额必须 > 0
  // ============================================================

  it('X4：金额被改成 0 的单 → 落 FAILED，不调渠道', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-12');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    // ⚠️ **直接改库把金额改成 0** —— 正常流程不可能产生这种单
    //    （审批时有 `netAmount > 0` 的闸），这是模拟脏数据。
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: { netAmount: 0 },
      }),
    );
    await approve(adminToken, applied.id);

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();
    expect(failed!.failureReason).toContain('非正数');
  });

  // ============================================================
  // X7：失败重试有上限
  // ============================================================

  it('X7：渠道连续失败 → 重试 3 次后落 FAILED，且 attemptCount = 3', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-01');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **让 3 次打款都失败** → 正好用满重试上限
    await armScenario(adminToken, { times: 3 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
      20_000,
    );
    expect(failed).not.toBeNull();
    expect(failed!.attemptCount).toBe(3);
    expect(failed!.failureReason).toContain('模拟的失败');
  });

  it('X12：渠道失败时落 APPROVED（等重试）并记 failureReason', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-02');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **只让 1 次失败** → 第 2 次会成功
    await armScenario(adminToken, { times: 1 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
      20_000,
    );
    expect(paid).not.toBeNull();
    expect(paid!.attemptCount).toBe(2);
  });

  // ============================================================
  // X5：PAID 后不可变
  // ============================================================

  it('X5：已 PAID 的单不能被撤回', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-03');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    await http(app)
      .delete(`/api/v1/merchant/payouts/${applied.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(409);

    const after = await fetchMerchantDetail(merchant.token, applied.id);
    expect(after.status).toBe(PayoutStatus.PAID);
  });

  it('X5：已 PAID 的单不能被拒绝', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-04');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    await http(app)
      .post(`/api/v1/platform/payouts/${applied.id}/reject`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ reason: '不该能拒绝' })
      .expect(409);

    const after = await fetchMerchantDetail(merchant.token, applied.id);
    expect(after.status).toBe(PayoutStatus.PAID);
  });

  // ============================================================
  // X6 / D4：结算单联动
  // ============================================================

  it('D4：出款 PAID 时，结算单同事务转 PAID 并写 paidAt', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-05');
    const { merchant, statementId } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );
    expect(statementId).not.toBeNull();

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    const statement = await asPlatform(() =>
      prisma.settlementStatement.findFirst({
        where: { id: statementId },
      }),
    );
    expect(statement!.status).toBe(SettlementStatus.PAID);
    // ⚠️ **paidAt 与 status 同步写** —— 分开写会出「status=PAID 但 paidAt=null」
    expect(statement!.paidAt).not.toBeNull();
  });
});
```

- [ ] **Step 3: 跑 e2e**

```bash
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
```
Expected: PASS ✅（13 个用例）

⚠️ **如果「X7：连续失败」这个用例超时**：
退避是 `PAYOUT_RETRY_BASE_DELAY_MS` × attempt = 100 / 200 / 300 ms，
总共 600ms → 20 秒超时够用。若仍超时，检查 `test/setup.ts` 里那行 env 有没有生效。

⚠️ **如果「X2b」这个用例偶发失败**：改账户与审批之间有竞态 ——
审批后立刻改账户是同步的，worker 可能在这之前就打完了（那也没关系，
快照仍然是审批时的那份）✅

- [ ] **Step 4: 提交**

```bash
git add api/test/payout-execution.e2e-spec.ts api/test/setup.ts
git commit -m "test(api): 出款执行的 e2e——状态机、快照、重试上限与结算单联动"
```

---

### Task 12: e2e 的补差与卡死用例（X8/X9/X13/X15/X16）

**Files:**
- Modify: `api/test/payout-execution.e2e-spec.ts`

⚠️ **补差场景必须「直接插库」造出那个形状**：
正常流程走不出「结算单已 `PAID` 且该期还有未纳入流水」——
正常单 `PAID` 时该期流水已被全部占用。
造法：先正常出款到 `PAID`，再**直接插库**一笔该期的新 `merchant_receipts` 行。
⚠️ 这条与 5g 的教训同源：**测试数据没落在那个形状上，护栏就会「挂 0 条」**。

- [ ] **Step 1: 加补差场景的 helper**

追加到 `api/test/payout-execution.e2e-spec.ts` 的 `describe` 里：

```ts
  /**
   * 造出「该期已出款 + 有回填流水」的形状。
   *
   * @returns merchant、statementId、payoutId（已 PAID 的正常单）
   */
  async function setupPaidPeriodWithBackfill(
    adminToken: string,
    period: Period,
    options: { receiptAmount: number; commissionAmount: number },
  ): Promise<{
    merchant: { token: string; tenantId: string; subdomain: string };
    statementId: string | null;
    payoutId: string;
  }> {
    const { merchant, statementId } = await setupMerchantWithPeriod(
      adminToken,
      period,
      options,
    );

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();

    // ⚠️ **直接插库模拟回填**：一笔新的货款流水落在同一期。
    //    正常流程走不出这个形状（正常单 PAID 时该期流水已被全部占用）。
    const backfillOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
    });
    await seedReceipt(merchant.tenantId, backfillOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    return { merchant, statementId, payoutId: applied.id };
  }

  /** 商家拉可申请周期 */
  async function fetchAvailablePeriods(
    token: string,
  ): Promise<AvailablePeriodBody[]> {
    const response = await http(app)
      .get('/api/v1/merchant/payouts/available-periods')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as AvailablePeriodBody[];
  }
```

- [ ] **Step 2: 加补差与卡死的用例**

追加到 `describe` 里（**放在最后一个 `it` 之后、闭合括号之前**）：

```ts
  // ============================================================
  // X8 / X9 / X13：补差单
  // ============================================================

  it('X8/X9/X13：正常单已 PAID + 有回填流水 → 补差单佣金为 0', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant } = await setupPaidPeriodWithBackfill(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );

    // ---- 可申请周期里要能看到补差入口 ----
    const periods = await fetchAvailablePeriods(merchant.token);
    const view = periods.find((item) => item.period === period.label);
    expect(view).toBeDefined();
    // ⚠️ **补差入口不能被 alreadyApplied 吞掉**（设计 §6.4b）
    expect(view!.alreadyApplied).toBe(true);
    expect(view!.appliedKind).toBe(PayoutKind.NORMAL);
    expect(view!.supplementAvailable).toBe(true);
    expect(view!.supplementAmount).toBe(5000);
    // ⚠️ **整期金额的语义不变** —— 它是「这一期总共应结多少」
    expect(view!.netAmount).toBe(8500);

    // ---- 再申请一次 → 得到补差单 ----
    const supplement = await apply(merchant.token, period.label);
    expect(supplement.kind).toBe(PayoutKind.SUPPLEMENT);
    // ⚠️ **补差佣金恒为 0**（护栏 X9 / X13）
    expect(supplement.commissionAmount).toBe(0);
    expect(supplement.netAmount).toBe(5000);
    expect(supplement.receiptAmount).toBe(5000);
    expect(supplement.entryCount).toBe(1);
  });

  it('X16：补差单审批后金额与申请时一致（本单口径的唯一证据）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-07');
    const { merchant } = await setupPaidPeriodWithBackfill(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );

    const supplement = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, supplement.id);

    // ⚠️⚠️ **金额必须与申请时完全一致** ——
    //    若 `approve` 用了全局「未纳入」口径，本单自己纳入的流水会被当成
    //    未纳入 → 金额归零 → 这条断言会挂（护栏 X16）。
    expect(approved.commissionAmount).toBe(0);
    expect(approved.netAmount).toBe(supplement.netAmount);
    expect(approved.netAmount).toBe(5000);
    expect(approved.entryCount).toBe(supplement.entryCount);

    // ⚠️ **补差单也能打款成功**
    const paid = await waitForStatus(
      merchant.token,
      supplement.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
  });

  it('X6：补差单 PAID 时不改结算单状态（它早已是 PAID）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-08');
    const { merchant, statementId } = await setupPaidPeriodWithBackfill(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );
    expect(statementId).not.toBeNull();

    const supplement = await apply(merchant.token, period.label);
    await approve(adminToken, supplement.id);
    await waitForStatus(merchant.token, supplement.id, PayoutStatus.PAID);

    const statement = await asPlatform(() =>
      prisma.settlementStatement.findFirst({ where: { id: statementId } }),
    );
    // ⚠️ **结算单本来就该是 PAID** —— 补差单**不能**把它改成别的状态
    expect(statement!.status).toBe(SettlementStatus.PAID);
  });

  it('X8：补差单不允许再叠 —— 再申请返回同一张', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-09');
    const { merchant } = await setupPaidPeriodWithBackfill(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );

    const first = await apply(merchant.token, period.label);
    const second = await apply(merchant.token, period.label);

    expect(second.id).toBe(first.id);
    expect(second.kind).toBe(PayoutKind.SUPPLEMENT);

    const count = await asPlatform(() =>
      prisma.payout.count({
        where: {
          tenantId: merchant.tenantId,
          periodStart: period.from,
          kind: PayoutKind.SUPPLEMENT,
        },
      }),
    );
    expect(count).toBe(1);
  });

  // ============================================================
  // X15：卡死告警去重
  // ============================================================

  it('X15：卡在 PROCESSING 的单只告警一次（stuckLoggedAt 记上后不再捞）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    // ⚠️ **直接改成 PROCESSING 且 processingAt 是 20 分钟前** ——
    //    假网关是同步返回的，造不出「回包丢失」（设计 §九·R3 的遗留 L48）。
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: {
          status: PayoutStatus.PROCESSING,
          processingAt: new Date(Date.now() - 20 * 60 * 1000),
        },
      }),
    );

    // ⚠️ **直接调扫描服务**（不走队列）——
    //    队列里注册一个周期任务太重，而这里要验的是「捞取条件」。
    const execution = app.get(PayoutExecutionService);
    const now = new Date();
    const first = await execution.scanStuck(now);
    // ⚠️ **PROCESSING 的单不能被救援**（护栏 R3：钱可能已经打出去）
    expect(first.map((item) => item.id)).not.toContain(applied.id);

    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    // ⚠️ **stuckLoggedAt 已写** —— 第二轮就不会再捞它
    expect(row!.stuckLoggedAt).not.toBeNull();

    const second = await execution.scanStuck(new Date());
    // ⚠️ **第二轮不再告警**（失败注入 Y17：去掉 stuckLoggedAt 条件就会重复）
    expect(second.map((item) => item.id)).not.toContain(applied.id);
  });

  it('R3：卡在 APPROVED 的单会被救援（确定没打出去，重新入队是安全的）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-10');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    // ⚠️ **再造一张卡在 APPROVED 的单**（模拟「审批后入队失败」）
    //    同一商家同一期只能有一张正常单 → `apply` 幂等返回刚才那张，
    //    把它改成 APPROVED + 很久以前的审批时刻即可。
    const stuck = await apply(merchant.token, period.label);
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: stuck.id },
        data: {
          status: PayoutStatus.APPROVED,
          approvedAt: new Date(Date.now() - 20 * 60 * 1000),
        },
      }),
    );

    const execution = app.get(PayoutExecutionService);
    const rescues = await execution.scanStuck(new Date());
    // ⚠️ **APPROVED 的单会被捞出来救援**
    expect(rescues.map((item) => item.id)).toContain(stuck.id);
  });
```

⚠️ **上面的 `require(...)` 用法要改成正经的 import**（ESLint 会报 `no-var-requires`）：

```ts
import { PayoutExecutionService } from '../src/modules/billing/payout-execution.service';
```

然后 `const execution = app.get(PayoutExecutionService);`

    await seedReceipt(fresh.tenantId, orderId, {
      type: ReceiptType.SALE,
      amount: 10000,
      occurredAt: inside(period, 10),
    });
    const entryOrderId = await seedOrder(fresh.tenantId, {
      totalAmount: 10000,
      commissionAmount: 1500,
    });
    await seedEntry(fresh.tenantId, entryOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 1500,
      occurredAt: inside(period, 10),
    });
    const statement = await generate(adminToken, period.label, fresh.tenantId);
    await confirmStatement(adminToken, statement.id);
    // ⚠️ **手工把结算单改成 PAID**（模拟「已出款」）
    await asPlatform(() =>
      prisma.settlementStatement.updateMany({
        where: { id: statement.id },
        data: { status: SettlementStatus.PAID, paidAt: new Date() },
      }),
    );
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${fresh.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);

    // ⚠️ **正常单对 PAID 的结算单必须 409**（P3 不放宽）
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${fresh.token}`)
      .send({ period: period.label })
      .expect(409);
    expect(
      (response.body as { message?: string | string[] }).message,
    ).toBeDefined();

    // ⚠️ **而补差单对 PAID 的结算单放行** —— 由上面的
    //    「X8/X9/X13」用例覆盖（那里结算单确实是 PAID，补差申请成功）。
  });
```

- [ ] **Step 3: 跑 e2e**

```bash
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
```
Expected: PASS ✅（20 个用例：Task 11 的 13 个 + 本 Task 的 7 个）

⚠️ **如果「X8/X9/X13」挂且 `supplementAvailable` 是 false**：
大概率是 `computeUnclaimedAmounts` 的「已被占用的 entryId」判定有问题 ——
查 `payoutEntry.findMany` 的 `where` 里 `payout: { tenantId, periodStart }`
是否带了 `periodStart`（不带的话会查到别的期的占用）。

⚠️ **如果「X16」挂且金额是 0**：
就是「本单口径」没做对 —— 回填流水的 `entryId` 在 `otherIds` 里吗？
`otherIds` 要**排除本单**（`payoutId: { not: payout.id }`）✅

- [ ] **Step 4: 提交**

```bash
git add api/test/payout-execution.e2e-spec.ts
git commit -m "test(api): 出款执行的 e2e——补差单口径、本单重算与卡死告警去重"
```

---

### Task 13: 失败注入（Y1–Y19）

**Files:**
- 无代码改动（这是**手工实验**：改一处 → 跑一个用例 → 观察它挂 → 改回）

⚠️ **失败注入不是自动化测试** —— 它验证的是「去掉这道闸，测试会不会挂」。
做法：改代码 → 跑对应的 e2e → 确认挂了 → **改回去** → 确认又过了。
⚠️ **每一条都要留下记录**（改了什么、哪个用例挂了、报错是什么），写进验收记录。

⚠️ **统一操作模板**：

```bash
# 1. 改代码（见下表）
# 2. 跑对应的 e2e，确认**目标用例挂掉**
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
# 3. 改回去（git checkout 那一个文件）
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git checkout -- api/src/...
# 4. 再跑一次，确认全绿
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
```

⚠️ **第 3 步的 `git checkout --` 会丢掉该文件的其他改动** ——
所以注入实验要**在所有功能改动都提交之后**做（此时工作区干净）。

**注入清单**：

| # | 注入点（改什么） | 必须挂掉的用例 | 护栏 |
|---|----------------|--------------|------|
| **Y1** | `claimForExecution` 的 `where` 去掉 `status: APPROVED` | 「X1：审批 → 打款 → PAID」 | X1 |
| **Y2** | worker 里把 `claim.netAmount` 换成重新查库算的金额 | 「X1：审批 → 打款 → PAID」的金额断言 | X2 |
| **Y3** | 去掉 `settle` 里的金额核对（`result.amount !== requestedAmount`） | 「X3：渠道金额核对」 | X3 |
| **Y4** | 去掉 worker 里的 `netAmount <= 0` 检查 | 「X4：金额被改成 0 的单」 | X4 |
| **Y5** | `markPaid` 的 `updateMany` 去掉 `status: PROCESSING` 条件 | 「X5：已 PAID 的单不能被拒绝」 | X5 |
| **Y6** | `markPaid` 里去掉 `kind === 'NORMAL'` 判断 | 「X6：补差单 PAID 时不改结算单状态」 | X6 |
| **Y7** | `handleFailure` 里去掉 `attemptCount >= PAYOUT_MAX_ATTEMPTS` 判断 | 「X7：渠道连续失败 → 落 FAILED」 | X7 |
| **Y8** | **直接改数据库里的索引**：把 `payouts_tenantId_period_kind_active_uniq` DROP 掉，重建成二元组 `(tenantId, periodStart)`（**不要改迁移文件** —— 改了就与 `_prisma_migrations` 的 checksum 失配） | 「X8：补差单不允许再叠」（建第二张补差单会撞索引 → 500） | X8 |
| **Y9** | `apply` 的补差分支改成调 `computeAmounts` 再减一次佣金 | 「X8/X9/X13」的佣金断言 | X9/X13 |
| **Y9b** | `approve` 的补差分支去掉（走 `computeAmounts`） | 「X8/X9/X13」的佣金断言（审批后的 `commissionAmount`） | X13 |
| **Y10** | `assertSecureConfig` 里去掉 `FAKE_PAYOUT_ENABLED` 那条 | 手动跑 `NODE_ENV=production FAKE_PAYOUT_ENABLED=true node dist/main` → 必须拒绝启动 | X11 |
| **Y11** | `handleFailure` 改成只打日志，不落状态也不记 `failureReason` | 「X7」或「X12」（`failureReason` 为 null） | X12 |
| **Y12** | `markFailed` 里去掉 `payoutEntry.deleteMany` | 「X7」之后重新申请同一期 → 撞唯一索引 → 500 | P2 |
| **Y13** | `assertStatementConfirmed` 的 `allowPaid` 改成「无条件放行 `PAID`」 | 「X13：正常单对已 PAID 的结算单仍 409」 | P3 |
| **Y14** | worker 里把 `claim.account` 换成实时查 `merchant_payout_accounts` | 「X2b：审批后商家改收款账户」 | X2b |
| **Y15** | `toView` 里把 `maskedSnapshotAccountNo` 改成直接返回 `snapshotAccountNo` | 「X14：API 响应里的账号是脱敏的」 | X14 |
| **Y16** | `availablePeriods` 的活跃单查询去掉 `kind` 条件 | 「X8/X9/X13」的 `appliedKind` / `supplementAvailable` 断言 | §6.4b |
| **Y17** | `scanStuck` 里去掉 `stuckLoggedAt: null` 条件 | 「X15：卡死告警去重」（第二轮还会捞到） | X15 |
| **Y18** | `apply` 的判定里把「有 `PAID` 的 NORMAL 单」写成「有任意 NORMAL 单」 | 「补差」场景下 `FAILED` 的正常单被误判 → 金额只算回填部分 | §6.4 |
| **Y19** | `computeSupplementAmounts` 的范围改成全局口径（去掉 `ownIds`） | 「X16：补差单审批后金额与申请时一致」（金额归零 → 409） | X16 |

⚠️ **Y8 只改数据库里的索引，不改迁移文件**：

```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -v ON_ERROR_STOP=1 -c "
DROP INDEX IF EXISTS \"payouts_tenantId_period_kind_active_uniq\";
CREATE UNIQUE INDEX \"payouts_tenantId_active_period_uniq\"
  ON \"payouts\" (\"tenantId\", \"periodStart\")
  WHERE status NOT IN ('REJECTED','CANCELLED','FAILED');"
```
⚠️ **不要改 `migration.sql`** —— 改了它就与 `_prisma_migrations` 里登记的
checksum 失配，`migrate deploy` 会直接报错（这个坑本阶段已经踩过一次）。
⚠️ **Y8 做完必须把索引改回去**（测试库与开发库都要改）：
```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -v ON_ERROR_STOP=1 -c "
DROP INDEX IF EXISTS \"payouts_tenantId_active_period_uniq\";
CREATE UNIQUE INDEX \"payouts_tenantId_period_kind_active_uniq\"
  ON \"payouts\" (\"tenantId\", \"periodStart\", kind)
  WHERE status NOT IN ('REJECTED','CANCELLED','FAILED');"
```

- [ ] **Step 1: 确认工作区干净**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git status --short
```
Expected: 无输出 ✅

⚠️ **不干净就先提交** —— 注入实验的 `git checkout --` 会丢掉未提交的改动。

- [ ] **Step 2: 逐条做 Y1–Y19**

按上表逐条做，每条记录：**注入点 / 挂掉的用例 / 报错信息**。

⚠️ **Y10 不是 e2e** —— 它验的是「生产环境启动被拒绝」，手工跑：

```bash
cd api && NODE_ENV=production FAKE_PAYOUT_ENABLED=true JWT_SECRET=<32位以上> node dist/main
```
Expected: 启动失败并打印「生产环境禁止启用 FAKE_PAYOUT_ENABLED」✅
⚠️ **需要先 `npm run build`** —— `dist/main` 是编译产物。

- [ ] **Step 3: 全部做完后确认工作区干净且测试全绿**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && git status --short
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
```
Expected: 工作区无改动；测试全绿 ✅

- [ ] **Step 4: 把失败注入的记录写进验收记录**

在验收记录里加一节「失败注入复验」，逐条写：
`# | 注入点 | 挂掉的用例 | 现象 | 是否符合预期`。

⚠️ **验收记录是另一个文件**（`docs/superpowers/plans/2026-10-29-plan-05h2-payout-execution-acceptance.md`），
在**实施全部完成后**才写。

---

### Task 14: 两端的 `lib/payout.ts`（类型与文案）

**Files:**
- Modify: `merchant-admin/src/lib/payout.ts`
- Modify: `platform-admin/src/lib/payout.ts`
- Modify: `merchant-admin/test/lib/payout.test.ts`
- Modify: `platform-admin/test/lib/payout.test.ts`

⚠️ **两份 `lib/payout.ts` 是各自独立的副本**（本项目既有模式），
改了一边必须改另一边，内容要一致。

⚠️ **`PAID` / `FAILED` 的文案不改**（现在是「已出款」/「出款失败」）——
它们在 5h-1 就存在（那时不可达），改文案会动到既有测试。
本阶段只**新增** `PROCESSING`。

- [ ] **Step 1: 改 `merchant-admin/src/lib/payout.ts`**

```ts
/** 出款单的状态 */
export type PayoutStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED';

/** 出款单状态的中文文案 */
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  REQUESTED: '待审批',
  APPROVED: '已审批',
  REJECTED: '已拒绝',
  CANCELLED: '已撤回',
  // ⚠️ **阶段 5h-2 新增** —— 钱正在打出去
  PROCESSING: '打款中',
  PAID: '已出款',
  FAILED: '出款失败',
};

/**
 * 出款单的类型（阶段 5h-2）。
 *
 * ⚠️ **与后端 Prisma 的 `PayoutKind` 逐字一致**。
 */
export type PayoutKind = 'NORMAL' | 'SUPPLEMENT';

/** 出款单类型的中文文案 */
export const PAYOUT_KIND_LABEL: Record<PayoutKind, string> = {
  NORMAL: '正常出款',
  SUPPLEMENT: '补差出款',
};

/**
 * 出款单类型 → 中文文案。
 *
 * ⚠️ **未知类型回落到「正常出款」**：补差是**增量**，回落到「正常」
 *    不会让商家误以为钱要少发；回落到「未知类型」反而让人困惑。
 */
export function describePayoutKind(kind: PayoutKind | string): string {
  return PAYOUT_KIND_LABEL[kind as PayoutKind] ?? PAYOUT_KIND_LABEL.NORMAL;
}
```

`AvailablePeriod` 加三个字段：

```ts
/** 可申请的周期 */
export interface AvailablePeriod {
  // ... 原有字段 ...
  /** 该期是否已有活跃出款单（正常或补差都算） */
  alreadyApplied: boolean;
  /**
   * 该期活跃单的种类；null = 没有活跃单。
   *
   * ⚠️ **靠它区分「点哪个按钮」**（阶段 5h-2）。
   */
  appliedKind: PayoutKind | null;
  /**
   * 该期还能不能申请补差（正常单出款后仍有未纳入流水）。
   *
   * ⚠️ **不能只看 `alreadyApplied` 就禁用按钮** —— 正常单出款后
   * `alreadyApplied = true`，若直接禁用，**补差入口就此消失**。
   */
  supplementAvailable: boolean;
  /** 补差金额（整数分）；`supplementAvailable = false` 时为 null */
  supplementAmount: number | null;
}
```

`PayoutItem` 加执行相关字段：

```ts
export interface PayoutItem {
  // ... 原有字段 ...
  /** 出款类型：正常 / 补差 */
  kind: PayoutKind;
  /** 已尝试次数（含首次）。3 = 试满仍失败 */
  attemptCount: number;
  /** 最近一次失败的原因。null = 没有失败过 */
  failureReason: string | null;
  /** 打款渠道名。null = 还没开始打 */
  payoutChannel: string | null;
  /** ISO 8601。null = 未开始执行 */
  processingAt: string | null;
  /** ISO 8601。null = 未打款成功 */
  paidAt: string | null;
  /** ISO 8601。null = 未失败 */
  failedAt: string | null;
}
```

- [ ] **Step 2: 把同样的改动复制到 `platform-admin/src/lib/payout.ts`**

⚠️ **两份文件内容必须一致** —— 逐段对照复制，不要凭记忆改。

- [ ] **Step 3: 改两边的 `test/lib/payout.test.ts`**

在两个测试文件里各加：

```ts
  it('describePayoutStatus：PROCESSING → 打款中', () => {
    expect(describePayoutStatus('PROCESSING')).toBe('打款中');
  });

  it('describePayoutStatus：未知状态 → 未知状态', () => {
    expect(describePayoutStatus('WHATEVER')).toBe('未知状态');
  });

  it('describePayoutKind：NORMAL / SUPPLEMENT', () => {
    expect(describePayoutKind('NORMAL')).toBe('正常出款');
    expect(describePayoutKind('SUPPLEMENT')).toBe('补差出款');
  });

  it('describePayoutKind：未知类型回落到「正常出款」', () => {
    expect(describePayoutKind('WHATEVER')).toBe('正常出款');
  });
```

⚠️ **两份测试文件都要加**（它们也是独立副本）。

- [ ] **Step 4: 跑测试**

```bash
cd merchant-admin && npx vitest run test/lib/payout.test.ts
cd platform-admin && npx vitest run test/lib/payout.test.ts
```
Expected: PASS ✅

- [ ] **Step 5: 提交**

```bash
git add merchant-admin/src/lib/payout.ts platform-admin/src/lib/payout.ts \
        merchant-admin/test/lib/payout.test.ts platform-admin/test/lib/payout.test.ts
git commit -m "feat(admin): 出款的 PROCESSING 状态与补差类型文案"
```

---

### Task 15: 商家端的三个页面

**Files:**
- Modify: `merchant-admin/src/app/(dashboard)/settlements/page.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/settlements/apply/apply-form.tsx`
- Modify: `merchant-admin/test/app/payout-apply-form.test.tsx`
- Modify: `merchant-admin/test/app/payouts-page.test.tsx`
- Modify: `merchant-admin/test/app/payout-detail-page.test.tsx`

- [ ] **Step 1: 改申请表单（补差入口）**

`merchant-admin/src/app/(dashboard)/settlements/apply/apply-form.tsx`：

```ts
import { describePayoutKind, formatCents } from '@/lib/payout';
```

选项文案改成：

```tsx
                {periods.map((item) => (
                  <option key={item.period} value={item.period}>
                    {item.period}（应结 {formatCents(item.netAmount)}）
                    {item.supplementAvailable
                      ? ` · 可申请补差 ${formatCents(item.supplementAmount ?? 0)}`
                      : item.alreadyApplied
                        ? ` · 已${
                            item.appliedKind === 'SUPPLEMENT' ? '补差出款' : '申请'
                          }`
                        : ''}
                  </option>
                ))}
```

⚠️ **`supplementAvailable` 的优先级高于 `alreadyApplied`** ——
正常单出款后 `alreadyApplied = true`，若先判 `alreadyApplied`，
补差入口就永远显示不出来。

明细区改成：

```tsx
            {selected && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>
                  货款净额 {formatCents(selected.receiptAmount)} · 平台佣金{' '}
                  {formatCents(selected.commissionAmount)} · 应结{' '}
                  {formatCents(selected.netAmount)}
                </p>
                <p>共 {selected.entryCount} 笔货款</p>
                {selected.supplementAvailable && (
                  <p>
                    可申请补差 {formatCents(selected.supplementAmount ?? 0)}
                    （原结算单已结清，补差按零佣金结算）
                  </p>
                )}
              </div>
            )}
```

按钮改成：

```tsx
            <div className="flex justify-end">
              <Button
                type="submit"
                // ⚠️ **补差可申请时按钮可点** —— 其余情况按 alreadyApplied 禁用
                disabled={
                  pending ||
                  !period ||
                  (selected?.alreadyApplied && !selected?.supplementAvailable)
                }
              >
                {pending
                  ? '提交中…'
                  : selected?.supplementAvailable
                    ? '申请补差'
                    : '提交申请'}
              </Button>
            </div>
```

⚠️ **提交体仍然只有 `{ period }`** —— 后端 `apply` 自己判断走正常单还是补差单，
**前端不传 kind**（传了也会被中转路由白名单丢掉）。

- [ ] **Step 2: 改商家端出款单列表页**

`merchant-admin/src/app/(dashboard)/settlements/page.tsx`：

⚠️ **商家端没有 `<Table>` 组件** —— 列表页是裸 `<table>`，
表头加一列「类型」，状态格下面加 `FAILED` 的提示。

```tsx
import { describePayoutStatus, formatCents } from '@/lib/payout';
```

表头：

```tsx
              <th>类型</th>
              <th>状态</th>
```

行内：

```tsx
              <td>{payout.kind === 'SUPPLEMENT' ? '补差' : '正常'}</td>
              <td>
                {describePayoutStatus(payout.status)}
                {payout.status === 'FAILED' && (
                  <p className="text-xs text-destructive">
                    出款失败，请联系平台确认是否已到账
                  </p>
                )}
              </td>
```

⚠️ **`FAILED` 的提示文案是设计 §九·R1 要求的** ——
失败的单**可能真的打出去了**，必须让商家去核对。

- [ ] **Step 3: 改商家端出款单详情页**

`merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx`：

加一段「补差单说明」：

```tsx
      {payout.kind === 'SUPPLEMENT' && (
        <p className="text-sm text-muted-foreground">
          这是补差出款单：该期结算单已结清，本期补差按零佣金结算。
        </p>
      )}
```

⚠️ **这段文案不能省**（设计 §6.4）—— 商家一定会问
「这 5000 块为什么不抽佣」，不说清楚就会反复申诉。

再加失败提示：

```tsx
      {payout.status === 'FAILED' && (
        <p className="text-sm text-destructive">
          出款失败：{payout.failureReason ?? '未知原因'}。
          请联系平台确认是否已到账。
        </p>
      )}
```

- [ ] **Step 4: 改三个测试文件**

`merchant-admin/test/app/payout-apply-form.test.tsx`（**组件测试，首行要有
`// @vitest-environment jsdom`**）加：

```tsx
  it('supplementAvailable → 显示「申请补差」按钮且可点', () => {
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'PAID',
            alreadyApplied: true,
            appliedKind: 'NORMAL',
            supplementAvailable: true,
            supplementAmount: 5000,
          },
        ]}
      />,
    );

    const button = screen.getByRole('button', { name: '申请补差' });
    expect(button).not.toBeDisabled();
    // ⚠️ **补差金额要显示** —— 商家要看到能再拿多少
    expect(screen.getByText(/可申请补差/)).toBeTruthy();
  });

  it('alreadyApplied 且不能补差 → 按钮禁用', () => {
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'CONFIRMED',
            alreadyApplied: true,
            appliedKind: 'NORMAL',
            supplementAvailable: false,
            supplementAmount: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: '提交申请' })).toBeDisabled();
  });
```

⚠️ **`render` / `screen` 的 import 要照抄那个文件已有的写法** ——
本项目的组件测试用的是 `@testing-library/react`，先看一眼那个文件顶部的 import。

`merchant-admin/test/app/payouts-page.test.tsx`（**Server Component 测试，
遍历元素树而非 render**）加：

```tsx
  it('补差单显示「补差」标记', async () => {
    const text = collectText(renderToTree());
    expect(text).toContain('补差');
  });
```

⚠️ **照抄该文件里现有的用例的 mock 写法** —— 那个文件已经 mock 了
`apiFetchAuthed`，新用例只需要在 mock 数据里加 `kind: 'SUPPLEMENT'`。

`merchant-admin/test/app/payout-detail-page.test.tsx` 加：

```tsx
  it('补差单显示「零佣金结算」说明', async () => {
    const text = collectText(renderToTree());
    expect(text).toContain('补差按零佣金结算');
  });
```

- [ ] **Step 5: 跑测试**

```bash
cd merchant-admin && npx vitest run test/app/payout-apply-form.test.tsx test/app/payouts-page.test.tsx test/app/payout-detail-page.test.tsx
```
Expected: PASS ✅

⚠️ **如果页面的 mock 数据里没有 `kind` 字段**，`payout.kind === 'SUPPLEMENT'` 是 `undefined`
→ 走「正常」分支 → 不会崩 ✅

- [ ] **Step 6: 提交**

```bash
git add "merchant-admin/src/app/(dashboard)/settlements" \
        merchant-admin/test/app/payout-apply-form.test.tsx \
        merchant-admin/test/app/payouts-page.test.tsx \
        merchant-admin/test/app/payout-detail-page.test.tsx
git commit -m "feat(merchant-admin): 出款列表与详情的补差标记、失败提示与补差入口"
```

---

### Task 16: 平台端的两个页面

**Files:**
- Modify: `platform-admin/src/app/(dashboard)/payouts/page.tsx`
- Modify: `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`
- Modify: `platform-admin/test/app/payouts-page.test.tsx`
- Modify: `platform-admin/test/app/payout-detail-page.test.tsx`

- [ ] **Step 1: 改平台端列表页（kind 列 + 卡住标红）**

`platform-admin/src/app/(dashboard)/payouts/page.tsx`：

```tsx
import { describePayoutKind, describePayoutStatus, formatCents } from '@/lib/payout';
```

表头加一列「类型」（放在「周期」后面）：

```tsx
                <TableHead>周期</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
```

行内：

```tsx
                  <TableCell>{payout.periodLabel}</TableCell>
                  <TableCell>{describePayoutKind(payout.kind)}</TableCell>
                  <TableCell>
                    <span className={isStuck(payout) ? 'text-destructive' : undefined}>
                      {describePayoutStatus(payout.status)}
                    </span>
                    {payout.status === 'FAILED' && payout.failureReason && (
                      <p className="text-xs text-muted-foreground">
                        {payout.failureReason}（已尝试 {payout.attemptCount} 次）
                      </p>
                    )}
                  </TableCell>
```

⚠️ **加一个「卡住」的判定函数**（放在文件底部）：

```ts
/**
 * 这张单是不是卡在「打款中」太久了。
 *
 * ⚠️ **阈值 10 分钟**，与后端兜底扫描的阈值一致（设计 §九·R3）。
 *    前端只是**标红提醒**，真正的处理靠人工 ——
 *    后端**绝不自动重试**卡在 `PROCESSING` 的单（钱可能已经打出去）。
 */
function isStuck(payout: {
  status: string;
  processingAt: string | null;
}): boolean {
  if (payout.status !== 'PROCESSING' || !payout.processingAt) {
    return false;
  }
  const elapsed = Date.now() - new Date(payout.processingAt).getTime();
  return elapsed > 10 * 60 * 1000;
}
```

⚠️ **平台端用 `<Table>` 组件**（商家端没有），表头是 `<TableHead>`。

- [ ] **Step 2: 改平台端详情页**

`platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`：

```tsx
              <div className="flex justify-between py-2 text-sm">
                <span className="text-muted-foreground">类型</span>
                <span>{describePayoutKind(payout.kind)}</span>
              </div>
              {payout.status === 'FAILED' && (
                <div className="flex justify-between py-2 text-sm text-destructive">
                  <span>失败原因</span>
                  <span>
                    {payout.failureReason ?? '未知原因'}（已尝试{' '}
                    {payout.attemptCount} 次）
                  </span>
                </div>
              )}
```

⚠️ **`PlatformPayoutItem` 类型也要带 `kind` / `attemptCount` / `failureReason` / `processingAt`** ——
若它 `extends PayoutItem` 就自动继承 ✅；否则要在 `platform-admin/src/lib/payout.ts` 里补上。

- [ ] **Step 3: 改两个测试文件**

`platform-admin/test/app/payouts-page.test.tsx` 加：

```tsx
  it('列表显示「补差出款」标记', async () => {
    const text = collectText(renderToTree());
    expect(text).toContain('补差出款');
  });
```

⚠️ **照抄该文件现有的 mock 写法** —— mock 数据里要带 `kind: 'SUPPLEMENT'`。

`platform-admin/test/app/payout-detail-page.test.tsx` 加：

```tsx
  it('详情显示失败原因与尝试次数', async () => {
    const text = collectText(renderToTree());
    expect(text).toContain('失败原因');
  });
```

- [ ] **Step 4: 跑测试**

```bash
cd platform-admin && npx vitest run test/app/payouts-page.test.tsx test/app/payout-detail-page.test.tsx test/lib/payout.test.ts
```
Expected: PASS ✅

- [ ] **Step 5: 提交**

```bash
git add "platform-admin/src/app/(dashboard)/payouts" \
        platform-admin/test/app/payouts-page.test.tsx \
        platform-admin/test/app/payout-detail-page.test.tsx
git commit -m "feat(platform-admin): 出款列表的类型列、失败原因与卡住标红"
```

---

### Task 17: 浏览器手测 + 验收记录

**Files:**
- Create: `docs/superpowers/plans/2026-10-29-plan-05h2-payout-execution-acceptance.md`

- [ ] **Step 1: 起服务**

⚠️ **端口**：api 3000、merchant-admin 3002、platform-admin 3003、nginx 80。
⚠️ **cookie 按域隔离但不按端口隔离** —— 两个前端同在 `localhost` 会互相顶掉会话，
手测时**一次只登一个前端**。

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目" && docker compose ps
```
Expected: 所有服务 `running` ✅

- [ ] **Step 2: 用 `ego-browser` 手测（10 步）**

⚠️ **浏览器**：默认用本地已装的 `ego lite`。
⚠️ **已常驻就复用，禁止再 `open`**（会把窗口激活到前台）：

```bash
pgrep -f "ego lite" || echo "未运行"
```

⚠️ **冷启动必然抢前台**：先记下前台 app，再 `open -g -j -a "ego lite"`，
随即 `open -a "<原app>"` 还原焦点。**除非用户明确要求查看页面，否则不激活窗口。**

手测步骤：

| # | 操作 | 期望 |
|---|------|------|
| 1 | 商家端登录 → 「结算」页 → 申请一个已结束的周期 | 列表出现「待审批」的单 |
| 2 | 平台端登录 → 「出款」页 → 找到那张单 → 点「通过」 | 状态变成「已审批」 |
| 3 | 等 2 秒刷新商家端 | 状态变成「已出款」，详情显示打款时刻 |
| 4 | 平台端出款详情 | 结算单状态是「已付款」 |
| 5 | 商家端「结算」页 | 「类型」列显示「正常」 |
| 6 | 造一笔回填流水（直接插库）后刷新商家端申请页 | 出现「可申请补差 ¥50.00」 |
| 7 | 点「申请补差」 | 新单类型是「补差」，佣金显示 ¥0.00 |
| 8 | 平台端审批那张补差单 | 打款成功，商家端显示「已出款」 |
| 9 | 商家端补差单详情 | 显示「原结算单已结清，本期补差按零佣金结算」 |
| 10 | 平台端手动把某张单改成 `PROCESSING` 且 `processingAt` 是 20 分钟前 → 刷新列表 | 该行标红 |

⚠️ **第 6 步的插库**：

```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c "
INSERT INTO merchant_receipts (id, "tenantId", "orderId", "orderNo", type, amount, "occurredAt", "createdAt", "updatedAt")
SELECT 'backfill-' || substr(md5(random()::text), 1, 8), "tenantId", "orderId", "orderNo", 'SALE', 5000, "occurredAt", now(), now()
FROM merchant_receipts WHERE type = 'SALE_REVERSAL' LIMIT 1;"
```
⚠️ **`orderId` 复用已有流水的** —— `merchant_receipts` 对 `orderId` 有外键 Restrict，
随便编一个 id 会插不进去。
⚠️ **必须挑 `type = 'SALE_REVERSAL'` 的那一条** —— `(orderId, type)` 唯一，
复用 `SALE` 的会撞唯一索引。

- [ ] **Step 3: 跑全量测试**

```bash
cd api && npm run test:e2e
cd merchant-admin && npx vitest run
cd platform-admin && npx vitest run
```
Expected: 全绿 ✅

⚠️ **`npm run test:e2e` 会清空测试库** → 别在别的 e2e 跑着的时候执行。

- [ ] **Step 4: 写验收记录**

Create `docs/superpowers/plans/2026-10-29-plan-05h2-payout-execution-acceptance.md`，包含：

1. **数字对账表**：本阶段新增/改动的文件数、测试数、护栏数、失败注入数
2. **各命令的实际输出**（测试通过数、迁移应用结果）
3. **手测 10 步的实测结果**
4. **护栏 X1–X16 逐条复验**（每条：怎么验的 / 结果）
5. **失败注入 Y1–Y19 逐条复验**（Task 13 记录的）
6. **已知遗留**（设计文档 §十一 的 L41–L54）
7. **5h-3 的待办**

⚠️ **数字要核实过再写** —— 用 `grep -c "  it("` 数真实的用例数，
不要凭印象写。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/plans/2026-10-29-plan-05h2-payout-execution-acceptance.md
git commit -m "docs: 阶段 5h-2 验收记录——护栏 X1–X16 与失败注入 Y1–Y19 逐条复验"
```

---

## 十三、完成标准

- [ ] `cd api && npm run test:e2e` 全绿
- [ ] `cd api && npx jest` 全绿
- [ ] `cd merchant-admin && npx vitest run` 全绿
- [ ] `cd platform-admin && npx vitest run` 全绿
- [ ] 浏览器手测 10 步全部符合期望
- [ ] 失败注入 Y1–Y19 逐条复验完成并记录
- [ ] 验收记录已写并提交
- [ ] 设计文档 §十一 的遗留项已更新（新增的写进去）
