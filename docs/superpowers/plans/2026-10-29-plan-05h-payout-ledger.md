# 阶段 5h-1 实施计划：出款（把货款结算给商家）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让商家能看到「这一期我该拿多少钱」并发起出款申请，平台审批后**锁定金额** —— 账的部分做对，钱的部分（渠道）留给 5h-2。

**Architecture:** 新建一张「商家应收货款」流水表 `merchant_receipts`（与 5e 的 `commission_entries` 完全同款），写入点与抽佣流水**在同一个事务**里；出款单的应结金额 = **货款流水净额 − 结算单佣金净额**，两侧口径互补且都能追溯到具体单据。出款单按自然月与结算单一对一，**商家申请 + 平台审批**，金额在**审批那一刻**重算并锁定。

**Tech Stack:** NestJS 11 + Prisma 6.19.3 + PostgreSQL 16 + Jest 30（api）；Next.js 15 App Router + React 19 + Tailwind CSS 4 + Vitest 3（merchant-admin + platform-admin）

**设计文档**：`docs/superpowers/specs/2026-10-29-plan-05h-payout-ledger-design.md`

---

## 0. 给实施代理的必读

### 0.1 本仓库的几条硬规矩

| 规矩 | 说明 |
|------|------|
| **迁移一律手写 SQL** | `prisma migrate dev` 在本仓库会提示「需要重置 public schema」，而项目**明令禁用 `prisma migrate reset`**（阶段 2 已因此踩坑）。做法照 5c / 5e / 5g 的先例：写好 `migration.sql` → `psql` 应用 → `prisma migrate resolve --applied` 登记 |
| **宿主机没有 `psql`** | 用 `docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce < <文件>` |
| **金额一律整数分、费率一律基点** | 不在 service 里换算成元 |
| **租户作用域模型的「唯一字段 only」方法被禁** | `findUnique` / `update` / `delete` / `upsert` 在 `TENANT_SCOPED_MODELS` 里的模型上会抛 `TenantScopeError`（**平台作用域下也拒绝**）。只能用 `findFirst` + `updateMany` / `deleteMany` |
| **平台作用域下 `create` 必须显式带 `tenantId`** | `merchant_receipts` / `payouts` 在白名单里 → 平台作用域写入必须自己带 `tenantId` |
| **新增带 `tenantId` 的模型必须登记白名单** | 否则 `assertTenantScopedModelsRegistered()` **让应用启动直接失败** |
| **新增模型必须在 `TenantPrismaService` 加 getter** | 该类用 getter 代理模型 delegate，不加工具类就访问不到 |
| **`tenantContext.run()` 的回调必须是 async 函数** | 同步回调会让租户上下文**静默失效** |
| **注释解释「为什么」，且必须准确** | 中文注释。写「为什么这样做」与「不做会怎样」，不写「这行代码做了什么」 |
| **外科手术式改动** | 只碰必须碰的地方，不顺手重构邻近代码 |

### 0.2 本阶段的护栏编号

设计文档 §七 定义了 **P1–P10**（护栏）与 §八·8.2 的 **F1–F10**（失败注入）。
实施过程中**每一条护栏都要有对应的自动化断言**，注释里要写清它防的是什么。

⚠️ **P2（`entryId` 唯一）不用做失败注入** —— 它是数据库层约束，
用 e2e 直接插第二条关联行、断言 DB 抛 P2002 即可（5g 的 S4「数据层兜底」同款做法）。

### 0.3 数据库

| 用途 | 连接串 |
|------|--------|
| 开发库 | `postgresql://ecommerce:ecommerce@localhost:15432/ecommerce?schema=public`（`api/.env` 的 `DATABASE_URL`） |
| 测试库 | `postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public`（`api/.env` 的 `DATABASE_URL_TEST`） |

⚠️ **测试库会被 `npm test` 自动 truncate**（`api/test/deploy-test-db.mjs` + `setup-e2e.ts`）。

⚠️ **不要在 `api/` 下新建顶层目录** —— TypeScript 的 common-root 推导会把产物路径从
`dist/main.js` 变成 `dist/src/main.js`，容器的 `CMD ["node","dist/main.js"]` 就找不到文件
（阶段 5e 踩过）。本计划新增的文件全在 `src/modules/billing/`、`src/modules/payment/`、
`scripts/` 与 `test/` 之下 ✅。

### 0.4 e2e 夹具的月份：**2025-07 ~ 2025-10**

⚠️ **为什么不能跟结算单 e2e 用同一个月**：出款单要**引用结算单**，
所以出款 e2e 会自己造结算单 → 两边的数据会互相串（同 5g 的 E1）。

⚠️ **5g 的结算单 e2e 已经占了这些月份**（`api/test/settlement.e2e-spec.ts`）：
`2023-12`、`2024-01` ~ `2024-12`（每月都有）、`2025-02`、`2025-03`、`2025-04`、`2025-05`、`2025-06`。
⚠️ 其中 `2024-10` / `2024-12` / `2025-04` 是**批量模式**（不点名商家）用的，
占用它们会影响对方的「该期所有有流水的商家各有一张单」断言。

→ **出款 e2e 一律用 `2025-07` ~ `2025-10`**，与结算单 e2e 完全错开。

⚠️ **结算单要求「周期已结束」**（`periodEnd <= 数据库时钟`）→ 2025 年与 2026-01 ~ 09 都已结束，
2026-10 还没结束（今天是 2026-10-29）→ **不能用 2026-10**。

⚠️ **出款 e2e 自己造流水行，不跑回填**：
`CommissionService.backfill()` / `ReceiptService.backfill()` 会扫全表 `paidAt` 非空的订单补流水，
跨文件影响不可控。出款 e2e 直接 `prisma.merchantReceipt.create(...)` 造行。

⚠️ **造流水行必须先造订单**：`MerchantReceipt.orderId` 有外键 `Restrict`，指向 `orders.id`。

⚠️ **e2e 必须串行跑**：`api/test/tenant-isolation.e2e-spec.ts` 的 `tenant.deleteMany` 会
**Cascade** 删掉 `Order → CommissionEntry`（5g 的 R6）→ 并发跑会随机失败。
`npm run test:e2e` 本身是 `--runInBand` 串行的 ✅

### 0.5 波次编排与 `billing.module.ts` 的注册归属

**这个阶段有 5 个 Task 都要往 `billing.module.ts` 里加东西**
（Task 2 的 `ReceiptService`、Task 3 的 `PayoutService`、Task 5 的 `PayoutAccountService`
与两个 controller、Task 6/7 的两个 controller）——
**并行代理改同一个文件必然冲突**（一方 `git add` 时会把另一方的半成品一起提交）。

⚠️ **本计划的约定**：

| 谁 | 改 `billing.module.ts`？ |
|----|----------------------|
| **Task 2** | ✅ 它独占那一波（`ReceiptService`）—— 因为 Task 2 要跑 e2e，**应用必须能起得来** |
| **Task 3 / 5 / 6 / 7** | ❌ **不碰** —— 统一放到 **Task 8 的 Step 0** |
| **Task 8 Step 0** | ✅ 一次性把 `PayoutService` / `PayoutAccountService` / 三个 controller 全部注册进去 |

⚠️ **所以 Task 3/5/6/7 的代理不要验证「应用能启动」** —— 那时 `billing.module.ts`
里还没有这些 provider，Nest 会因依赖注入解析不到而启动失败。
它们的验证是 **tsc + eslint + 该模块的单测**，这三样都不依赖模块装配 ✅

⚠️ **Task 4 可以与 Task 3 并行**：它只改 `settlement.service.ts` 与
`settlement.e2e-spec.ts`，不碰 `billing.module.ts`；而且它跑的是 `settlement` 那个
e2e 文件 —— Task 3 跑的是**单测**（假 Prisma，不碰数据库）→ **不抢测试库** ✅

⚠️ **同一波里两个代理的 e2e 不能并行**（共用 `ecommerce_test` 库）。

### 0.6 波次表

| 波 | 代理数 | Task | 为什么这么排 |
|----|-------|------|------------|
| 1 | 1 | Task 1 数据模型与迁移 | 后面 7 个 Task 全都依赖这 4 张表，必须先做 |
| 2 | 1 | Task 2 货款流水的写入点 | 独占 `billing.module.ts`（注册 `ReceiptService`）+ 独占 e2e |
| 3 | 2 | Task 3 出款服务层 + Task 4 unconfirm 闸 | 一个只跑单测、一个跑 e2e；文件不重叠 |
| 4 | 2 | Task 5 收款账户 + Task 6 平台端 | 商家侧与平台侧的文件不重叠 |
| 5 | 1 | Task 7 商家端 | 与 Task 5 都改 merchant-admin → 必须错开 |
| 6 | 1 | Task 8 e2e 与验收 | 依赖全部；且要注册 `billing.module.ts` |

---

## Task 1：数据模型与迁移（4 张表 + 2 个枚举）

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20261029090000_add_payout_ledger/migration.sql`
- Modify: `api/src/common/tenant/tenant-models.ts`
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`

- [ ] **Step 1：在 `schema.prisma` 里加两个枚举**

在 `enum CommissionEntryType` 之后（找到 `api/prisma/schema.prisma` 里的 `enum CommissionEntryType`）追加：

```prisma
/// 商家应收货款的流水类型（阶段 5h-1）。
///
/// ⚠️ **与 `CommissionEntryType` 完全同款**：SALE 为正（货款入账）、
/// SALE_REVERSAL 为负（货款冲回 = 全额退款）。单列求和即净额。
enum ReceiptType {
  /// 货款入账（正数）：订单支付成功
  SALE
  /// 货款冲回（负数）：订单全额退款
  SALE_REVERSAL
}

/// 出款单的状态机（阶段 5h-1）。
///
/// ⚠️ **PAID / FAILED 在 5h-1 不可达** —— 本阶段不打钱，
/// 渠道那一半在 5h-2（5g 的 D5 同样的「预留比将来补省事」：加枚举值要改 schema + 迁移）。
enum PayoutStatus {
  /// 待审批：商家已申请，金额是**预估**
  REQUESTED
  /// 已审批：金额已锁定
  APPROVED
  /// 已拒绝：商家可重新申请同一周期
  REJECTED
  /// 已撤回：商家主动撤销（仅 REQUESTED 可撤）
  CANCELLED
  /// 已出款（5h-1 不可达，5h-2 用）
  PAID
  /// 出款失败（5h-1 不可达，5h-2 用）
  FAILED
}
```

- [ ] **Step 2：在 `schema.prisma` 里加四个模型**

在 `model SettlementStatementEntry` 之后追加：

```prisma
/// 商家应收货款流水（阶段 5h-1）。
///
/// ⚠️ **与 `CommissionEntry` 同款**，只是金额基数不同：
/// 抽佣流水记的是 `order.commissionAmount`（平台抽的），
/// 货款流水记的是 `order.totalAmount`（商家该收的实付）。
///
/// ⚠️ **索引比它少一条**：`CommissionEntry` 上还有一条 `@@index([occurredAt])`，
/// 是为平台侧的**跨租户**抽佣台账设的（那条查询没有 `tenantId` 条件，
/// 走不了复合索引的前导列）。5h-1 没有跨租户货款台账这个场景 → 不加那条。
///
/// ⚠️ **写入点与抽佣流水在同一个事务里**（`payment.service.ts`）→
/// 不可能出现「有货款、无抽佣」的时序差。唯一的口径例外是
/// **零额抽佣**（费率 0 的订单有货款、无抽佣流水）。
model MerchantReceipt {
  id       String @id @default(uuid())
  tenantId String
  orderId  String
  /// 订单号快照（商家核对时要看）
  orderNo String
  type     ReceiptType
  /// 带符号整数分：SALE 为正、SALE_REVERSAL 为负
  amount Int
  /// 归期：支付取 `paidAt`、退款取 `refundedAt`（与抽佣流水逐字一致）
  occurredAt DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  order Order @relation(fields: [orderId], references: [id], onDelete: Restrict)

  @@unique([orderId, type])
  @@index([tenantId, occurredAt])
  @@map("merchant_receipts")
}

/// 商家收款账户（阶段 5h-1）。
///
/// ⚠️ **一商家一账户**（`tenantId` 唯一）。
///
/// ⚠️ **`accountNo` 是明文存的** —— 本项目没有通用字段加密设施
/// （只在 auth 模块有 JWT 相关的）。**接真实支付渠道前必须改成加密存储**
/// （与 5b 对 `payment_methods` 的同一处理：设计写明，实现留到那一阶段）。
/// 界面只展示脱敏（尾号 4 位）。
model MerchantPayoutAccount {
  id       String @id @default(uuid())
  tenantId String @unique
  /// 开户人姓名
  accountName String
  /// 开户行
  bankName String
  /// 银行账号（⚠️ 明文存，见上）
  accountNo String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("merchant_payout_accounts")
}

/// 出款单（阶段 5h-1）。
///
/// ⚠️ **金额三件套站在「商家应收」角度**：
/// `commissionAmount` 是**正数**（平台抽了多少，与结算单的 `netAmount` 同号），
/// `netAmount = receiptAmount − commissionAmount` 是应结给商家的钱。
/// ⚠️ **别把结算单的 `reversalAmount`（负数）那套符号搬过来** —— 这一类
/// 已坑过两次（5g 的结算单 vs 平台收入报表）。
model Payout {
  id       String @id @default(uuid())
  tenantId String
  /// 出款单号（对外凭证，服务端生成；生成规则与撞号重试照抄 5g 的 `generateStatementNo`）
  payoutNo String @unique
  /// 周期起点（含）。该月 1 日 00:00:00.000Z
  periodStart DateTime
  /// 周期终点（不含）。次月 1 日 00:00:00.000Z
  periodEnd DateTime
  /// 引用的结算单。⚠️ **可空**：零额抽佣的商家该期没有结算单
  statementId String?
  /// 货款净额（正数）：该期 `merchant_receipts` 的金额之和
  receiptAmount Int
  /// 佣金净额（**正数** = 平台抽了多少）：结算单的 `netAmount`
  commissionAmount Int
  /// 应结给商家的金额 = `receiptAmount − commissionAmount`
  netAmount Int
  /// 纳入的货款流水笔数
  entryCount Int
  status PayoutStatus @default(REQUESTED)
  /// 申请时的**预估**金额（与 `netAmount` 可能不同 —— 审批时会重算）
  requestedAmount Int
  /// 申请人的用户 ID
  requestedBy String
  /// 审批人的用户 ID
  approvedBy String?
  /// 拒绝原因（拒绝时必填）
  rejectedReason String?
  requestedAt DateTime @default(now())
  approvedAt DateTime?
  cancelledAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  statement SettlementStatement? @relation(fields: [statementId], references: [id], onDelete: Restrict)
  entries PayoutEntry[]

  @@index([status])
  @@map("payouts")
}

/// 出款单明细关联（阶段 5h-1）。
///
/// ⚠️ **刻意不带 `tenantId`** → 不登记进 `TENANT_SCOPED_MODELS`
/// （与 5g 的 `settlement_statement_entries` 同款）：
/// 租户作用域扩展对它不附加任何过滤 → **service 层必须自己校验归属**。
model PayoutEntry {
  id       String @id @default(uuid())
  payoutId String
  /// 指向 `merchant_receipts.id` —— 一笔货款只能被出款一次
  entryId String @unique
  createdAt DateTime @default(now())

  payout Payout @relation(fields: [payoutId], references: [id], onDelete: Cascade)
  entry  MerchantReceipt @relation(fields: [entryId], references: [id], onDelete: Restrict)

  @@index([payoutId])
  @@map("payout_entries")
}
```

⚠️ **还要给既有模型加反向关系**（Prisma 要求关系两端都有声明）：

- `model Order` 里加 `receipts MerchantReceipt[]`
- `model SettlementStatement` 里加 `payouts Payout[]`

- [ ] **Step 3：写迁移 SQL（手写）**

Create `api/prisma/migrations/20261029090000_add_payout_ledger/migration.sql`：

```sql
-- 阶段 5h-1：出款（把货款结算给商家）
--
-- ⚠️ 本文件**不是** `prisma migrate dev` 的原样输出。
-- 该命令在本项目会先提示「需要重置 public schema」（历史迁移文件在应用后
-- 被改过，与 _prisma_migrations 里的校验和不一致），而项目明令禁用
-- `prisma migrate reset`（阶段 2 已因此踩坑）。做法照 5c / 5e / 5g 的先例：
-- 手写 → psql 应用 → `prisma migrate resolve --applied` 登记。
--
-- ⚠️ 本次变更：2 个枚举、4 张新表、12 条索引（8 条 CREATE INDEX + 4 个内联主键）、
-- 4 条外键。没有 DROP TABLE、没有数据删除、没有改动既有表。
--
-- ⚠️ 索引清单（数得出来，别照抄上面的数字）：
--   merchant_receipts_pkey                          PRIMARY KEY
--   merchant_receipts_orderId_type_key              UNIQUE (orderId, type)
--   merchant_receipts_tenantId_occurredAt_idx       (tenantId, occurredAt)
--   merchant_payout_accounts_pkey                   PRIMARY KEY
--   merchant_payout_accounts_tenantId_key           UNIQUE (tenantId)
--   payouts_pkey                                    PRIMARY KEY
--   payouts_payoutNo_key                            UNIQUE (payoutNo)
--   payouts_status_idx                              (status)
--   payouts_tenantId_active_period_uniq             UNIQUE (tenantId, periodStart) WHERE status NOT IN ('REJECTED','CANCELLED')
--   payout_entries_pkey                             PRIMARY KEY
--   payout_entries_entryId_key                      UNIQUE (entryId)
--   payout_entries_payoutId_idx                     (payoutId)

-- ---------- 枚举 ----------

-- CreateEnum
CREATE TYPE "ReceiptType" AS ENUM ('SALE', 'SALE_REVERSAL');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PAID', 'FAILED');

-- ---------- 新表 ----------

-- CreateTable
CREATE TABLE "merchant_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "type" "ReceiptType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_payout_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payoutNo" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "statementId" TEXT,
    "receiptAmount" INTEGER NOT NULL,
    "commissionAmount" INTEGER NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAmount" INTEGER NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "rejectedReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_entries" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_entries_pkey" PRIMARY KEY ("id")
);

-- ---------- 索引 ----------

-- CreateIndex
CREATE UNIQUE INDEX "merchant_receipts_orderId_type_key" ON "merchant_receipts"("orderId", "type");

-- CreateIndex
CREATE INDEX "merchant_receipts_tenantId_occurredAt_idx" ON "merchant_receipts"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payout_accounts_tenantId_key" ON "merchant_payout_accounts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_payoutNo_key" ON "payouts"("payoutNo");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- ⚠️ **部分唯一索引**：同一商家同一周期只能有**一张活跃**出款单。
-- 条件排除 REJECTED / CANCELLED —— 那两种是终态，商家可以**重新申请**同一周期。
-- ⚠️ **为什么不用全量唯一索引**：全量的会让「被拒绝的出款单」永久占住那个周期，
-- 商家再也不能申请 → 那笔钱永远拿不到。
-- ⚠️ **Prisma 的 `@@unique` 表达不了这个语义**（它不认 WHERE 子句），
-- 所以 schema 里**不要**声明它 —— 声明了也不生效，只会让���误以为约束在数据库层。
-- 这与 `payments` 表的三个部分唯一索引是同一套做法。
-- CreateIndex
CREATE UNIQUE INDEX "payouts_tenantId_active_period_uniq" ON "payouts"("tenantId", "periodStart") WHERE "status" NOT IN ('REJECTED', 'CANCELLED');

-- CreateIndex
CREATE UNIQUE INDEX "payout_entries_entryId_key" ON "payout_entries"("entryId");

-- CreateIndex
CREATE INDEX "payout_entries_payoutId_idx" ON "payout_entries"("payoutId");

-- ---------- 外键 ----------

-- ⚠️ **orderId 用 Restrict**：货款流水是账目的一部分，不允许被物理删除。
-- AddForeignKey
ALTER TABLE "merchant_receipts" ADD CONSTRAINT "merchant_receipts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ **statementId 用 Restrict**：结算单是凭证，没有删除端点 → 这个语义实际不触发，
-- 但外键能保证「引用的结算单一定存在」。
-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "settlement_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ **payoutId 用 Cascade**：明细行是出款单的从属数据。
-- AddForeignKey
ALTER TABLE "payout_entries" ADD CONSTRAINT "payout_entries_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠️ **entryId 用 Restrict**：已被出款的货款流水不允许被物理删除。
-- AddForeignKey
ALTER TABLE "payout_entries" ADD CONSTRAINT "payout_entries_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "merchant_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 4：应用迁移到开发库**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -v ON_ERROR_STOP=1 \
  < api/prisma/migrations/20261029090000_add_payout_ledger/migration.sql
```

Expected: 一连串 `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE` 的成功输出，**无 ERROR**。

⚠️ **`-v ON_ERROR_STOP=1` 不能省** —— 否则 psql 遇到错误会继续往下跑，
留下一半应用的表，比全失败更难收拾。

- [ ] **Step 5：登记迁移**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx prisma migrate resolve --applied 20261029090000_add_payout_ledger
```

Expected: `Migration 20261029090000_add_payout_ledger marked as applied.` ✅

- [ ] **Step 6：验证表结构**

```bash
docker exec -i ecommerce-postgres psql -U ecommerce -d ecommerce -c '\d payouts' -c '\d merchant_receipts'
```

Expected: `payouts` 有 19 个字段、`merchant_receipts` 有 9 个字段；
`payouts_tenantId_active_period_uniq` 这个**部分唯一索引**要出现在索引列表里。

- [ ] **Step 7：登记租户作用域白名单**

Modify `api/src/common/tenant/tenant-models.ts` —— 在 `TENANT_SCOPED_MODELS` 数组里追加三个模型：

```ts
  // ⚠️ `MerchantPayoutAccount` / `Payout` / `MerchantReceipt` 都是租户作用域模型 ——
  // 不登记的话 `assertTenantScopedModelsRegistered()` **让应用启动直接失败**
  // （阶段 1 的硬失败设计：宁可起不来，也不要静默地跨租户读写）。
  'MerchantReceipt',
  'MerchantPayoutAccount',
  'Payout',
```

⚠️ **`PayoutEntry` 刻意不登记** —— 它没有 `tenantId` 字段（与 5g 的
`SettlementStatementEntry` 同款）：租户作用域扩展对它不附加任何过滤 →
**service 层必须自己校验归属**。在 `TENANT_SCOPED_MODELS` 上方补一条注释说明这一点。

- [ ] **Step 8：加 `TenantPrismaService` 的 getter**

Modify `api/src/common/tenant/tenant-prisma.service.ts` —— 在 `get settlementStatementEntry()` 之后追加：

```ts
  // ------- 商家应收货款流水（阶段 5h-1）模型 delegate 代理 -------

  get merchantReceipt() {
    return this.client.merchantReceipt;
  }

  // ------- 商家收款账户（阶段 5h-1）模型 delegate 代理 -------

  get merchantPayoutAccount() {
    return this.client.merchantPayoutAccount;
  }

  // ------- 出款单（阶段 5h-1）模型 delegate 代理 -------

  get payout() {
    return this.client.payout;
  }

  // 不在租户白名单里，但业务代码要读写它（出款单明细，无 tenantId 字段）
  // ⚠️ 因此**不受租户作用域约束**——查询前必须自行校验 payoutId 属于当前租户
  get payoutEntry() {
    return this.client.payoutEntry;
  }
```

- [ ] **Step 9：生成 Prisma Client 并验证类型**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx prisma generate
npx tsc --noEmit
```

Expected: `prisma generate` 成功；`tsc --noEmit` **无输出**（类型全对）。
⚠️ 如果报 `MerchantReceipt` 找不到，说明 `schema.prisma` 的模型名或 `@@map` 写错了 ——
**以 `schema.prisma` 的模型名为准**（`prisma` 的类型名 = 模型名，`@@map` 只改数据库表名）。

- [ ] **Step 10：验证应用能启动（租户白名单的硬失败会在这里暴露）**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit && node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.\$queryRawUnsafe('SELECT 1').then(() => { console.log('DB 连得上'); return p.\$disconnect(); }).catch(e => { console.error(e.message); process.exit(1); });
"
```

Expected: `DB 连得上` ✅

⚠️ **白名单登记漏了会在应用启动时硬失败**（`assertTenantScopedModelsRegistered()`）——
那正是设计要的效果。所以 Task 7 的验收必须**真的启动一次应用**（容器重建或本地起一次），
不能只看 `tsc` 过。

- [ ] **Step 11：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/prisma/schema.prisma api/prisma/migrations/20261029090000_add_payout_ledger/ \
        api/src/common/tenant/tenant-models.ts api/src/common/tenant/tenant-prisma.service.ts
git commit -m "feat(api): 出款的两张新表——货款流水 + 出款单"
```

---

## Task 2：货款流水的写入点（与抽佣同一事务）+ 回填扩展

**Files:**
- Create: `api/src/modules/billing/receipt.service.ts`
- Create: `api/src/modules/billing/receipt.spec.ts`
- Modify: `api/src/modules/payment/payment.service.ts`（两处调用）
- Modify: `api/scripts/backfill-commission-entries.ts`

**为什么单独一个 Task**：这是本阶段**唯一**改 5f 刚加固过的 `payment.service.ts` 事务的地方，
风险最高 —— 5f 的教训（投递失败必须抛、jobId 带轮次标记）在这里都要重新审视。

- [ ] **Step 1：写纯函数的失败测试**

Create `api/src/modules/billing/receipt.spec.ts`：

```ts
import { shouldBackfillReceipt, shouldBackfillReceiptReversal } from './receipt.service';

describe('货款流水的回填判定', () => {
  it('没付过钱 → 不回填', () => {
    expect(shouldBackfillReceipt(null, 100)).toBe(false);
  });

  it('零额货款 → 不回填', () => {
    expect(shouldBackfillReceipt(new Date(), 0)).toBe(false);
  });

  it('正常订单 → 回填', () => {
    expect(shouldBackfillReceipt(new Date(), 100)).toBe(true);
  });

  it('⚠️ 零额抽佣但货款不为零 → 仍然回填（货款与抽佣的零额判定字段不同）', () => {
    // ⚠️ **这是与抽佣判定的关键差异**：抽佣看 `commissionAmount === 0`，
    // 货款看 `totalAmount === 0`。费率 0 的订单照样有货款要记。
    expect(shouldBackfillReceipt(new Date(), 100)).toBe(true);
  });

  describe('货款冲回的回填判定', () => {
    it('没退过款 → 不回填', () => {
      expect(shouldBackfillReceiptReversal(false, new Date(), 100)).toBe(false);
    });

    it('⚠️ 退过款但 refundedAt 为 null → 不回填（无法归期，与抽佣口径一致）', () => {
      expect(shouldBackfillReceiptReversal(true, null, 100)).toBe(false);
    });

    it('零额货款 → 不回填', () => {
      expect(shouldBackfillReceiptReversal(true, new Date(), 0)).toBe(false);
    });

    it('正常退款 → 回填', () => {
      expect(shouldBackfillReceiptReversal(true, new Date(), 100)).toBe(true);
    });
  });
});
```

- [ ] **Step 2：跑测试确认它失败**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests src/modules/billing/receipt.spec.ts
```

Expected: FAIL —— `Cannot find module './receipt.service'` ✅

- [ ] **Step 3：写 `receipt.service.ts`**

Create `api/src/modules/billing/receipt.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma, ReceiptType } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../../common/tenant/tenant-context';
import { CommissionOrderSnapshot } from './commission.service';

/**
 * 商家应收货款流水的写入与查询（阶段 5h-1）。
 *
 * ⚠️ **与 `CommissionService` 完全同款**，只是金额基数不同：
 * 抽佣流水记的是「平台抽了多少」（`order.commissionAmount`），
 * 货款流水记的是「商家该收多少」（`order.totalAmount`）。
 *
 * ⚠️ **为什么要有这张表**：出款的应结金额 = 货款净额 − 佣金净额，
 * 两边都要能追溯到具体单据。从订单现算的话，跨期退款时
 * 上期已出款的金额无法回溯修正（口径会漂）。
 */

/** 订单快照（写入货款流水只需要这些字段） */
export type ReceiptOrderSnapshot = Pick<
  CommissionOrderSnapshot,
  'id' | 'tenantId' | 'orderNo' | 'totalAmount'
>;

/**
 * 一条历史订单要不要回填货款流水。
 *
 * ⚠️ **零额判定看 `totalAmount`，不是 `commissionAmount`** ——
 * 抽佣的判定（`shouldBackfillCommission`）看的是抽佣额，
 * 费率 0 的订单**有货款、无抽佣**，货款那一行必须记。
 *
 * @param paidAt 支付时间。null = 没付过钱
 * @param totalAmount 实付（整数分）
 */
export function shouldBackfillReceipt(
  paidAt: Date | null,
  totalAmount: number,
): boolean {
  // ⚠️ **没付过钱 → 没有货款**（与报表只看 paidAt 一致）
  if (!paidAt) {
    return false;
  }
  // ⚠️ **零额不记** —— 表里全是 0 没意义
  if (totalAmount === 0) {
    return false;
  }
  return true;
}

/**
 * 一条历史订单要不要回填货款冲回流水。
 *
 * ⚠️ **`refundedAt` 为 null 的已退款订单一律跳过** ——
 * 5b 之前退的款没记时间，**冲回无法归期**。与抽佣的判定同款口径。
 *
 * @param refunded 订单是否已退款
 * @param refundedAt 退款时间。null = 5b 之前退的款
 * @param totalAmount 实付（整数分）
 */
export function shouldBackfillReceiptReversal(
  refunded: boolean,
  refundedAt: Date | null,
  totalAmount: number,
): boolean {
  if (!refunded) {
    return false;
  }
  if (!refundedAt) {
    return false;
  }
  if (totalAmount === 0) {
    return false;
  }
  return true;
}

/** 一行货款流水的写入内容 */
interface ReceiptEntryData {
  tenantId: string;
  orderId: string;
  orderNo: string;
  type: ReceiptType;
  amount: number;
  occurredAt: Date;
}

@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 记一笔货款（支付成功时）。
   *
   * ⚠️ **幂等**：靠 `@@unique([orderId, type])` + 「先查后插」。
   *
   * ⚠️ **零额不记**：实付 0 的订单不产生流水行。
   *
   * @param occurredAt 支付时间（用**数据库的时钟**，与订单的 `paidAt` 同源）
   */
  async recordReceiptInTx(
    tx: Prisma.TransactionClient,
    order: ReceiptOrderSnapshot,
    occurredAt: Date,
  ): Promise<void> {
    if (order.totalAmount === 0) {
      return;
    }

    await this.insertEntryInTx(tx, {
      tenantId: order.tenantId,
      orderId: order.id,
      orderNo: order.orderNo,
      type: ReceiptType.SALE,
      amount: order.totalAmount,
      occurredAt,
    });
  }

  /**
   * 记一笔货款冲回（退款成功时）。
   *
   * ⚠️ **金额取负**：与货款行反向，单列求和即净额。
   */
  async recordReceiptReversalInTx(
    tx: Prisma.TransactionClient,
    order: ReceiptOrderSnapshot,
    occurredAt: Date,
  ): Promise<void> {
    if (order.totalAmount === 0) {
      return;
    }

    await this.insertEntryInTx(tx, {
      tenantId: order.tenantId,
      orderId: order.id,
      orderNo: order.orderNo,
      type: ReceiptType.SALE_REVERSAL,
      // ⚠️ **金额取负**：与货款行反向，单列求和即净额。
      amount: -order.totalAmount,
      occurredAt,
    });
  }

  /**
   * 幂等地插一行货款流水（**先查后插**，不用 `upsert`）。
   *
   * ⚠️ **为什么不能用 `upsert`**：`MerchantReceipt` 登记在
   * `TENANT_SCOPED_MODELS` 白名单里（租户扩展对白名单内的模型**直接拒绝**
   * `upsert` —— 它的 where 只接受唯一字段，无法附加 tenantId 条件，
   * 会造成跨租户越权）。与 `CommissionService.insertEntryInTx` 同款理由。
   *
   * ⚠️ **已存在就原样保留**（不覆盖金额与时间）：那行是第一次记下的事实。
   *
   * @returns true = 新插了一行；false = 已存在，没动
   */
  private async insertEntryInTx(
    tx: Prisma.TransactionClient,
    data: ReceiptEntryData,
  ): Promise<boolean> {
    const existing = await tx.merchantReceipt.findFirst({
      where: { orderId: data.orderId, type: data.type },
      select: { id: true },
    });
    if (existing) {
      return false;
    }

    await tx.merchantReceipt.create({ data });
    return true;
  }

  /**
   * 某商家某期的货款流水（左闭右开，与结算单同口径）。
   *
   * ⚠️ **必须显式带 `tenantId`**：`merchant_receipts` 在租户白名单里，
   * 租户作用域下扩展会自动附加 tenantId 条件；但**平台作用域下不附加**，
   * 所以平台侧聚合时这里必须自己带上。
   */
  async receiptsInPeriod(
    tenantId: string,
    period: { from: Date; to: Date },
  ): Promise<
    Array<{
      id: string;
      orderId: string;
      orderNo: string;
      type: ReceiptType;
      amount: number;
      occurredAt: Date;
    }>
  > {
    return this.prisma.merchantReceipt.findMany({
      where: {
        tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /**
   * 回填历史订单的货款流水（平台作用域下跑）。
   *
   * ⚠️ **与抽佣的回填分开跑**：两者的零额判定字段不同
   * （抽佣看 `commissionAmount`、货款看 `totalAmount`），
   * 零额抽佣的订单**有货款、无抽佣** → 货款必须单独回填。
   */
  async backfill(): Promise<{
    receiptCreated: number;
    reversalCreated: number;
    skippedZeroAmount: number;
    skippedUndatedRefund: number;
  }> {
    const result = {
      receiptCreated: 0,
      reversalCreated: 0,
      skippedZeroAmount: 0,
      skippedUndatedRefund: 0,
    };

    await tenantContext.run(platformScope(), async () => {
      // ⚠️ **只查 `paidAt` 非空的订单**：没付过钱的订单没有货款。
      const orders = await this.prisma.order.findMany({
        where: { paidAt: { not: null } },
        select: {
          id: true,
          tenantId: true,
          orderNo: true,
          totalAmount: true,
          paidAt: true,
          refundedAt: true,
          status: true,
        },
      });

      for (const order of orders) {
        // ⚠️ **用枚举常量而不是字符串**：`OrderStatus.REFUNDED` 才是权威值，
        // 字符串比较在枚举扩容时会静默漏掉。
        const refunded = order.status === OrderStatus.REFUNDED;

        if (!shouldBackfillReceipt(order.paidAt, order.totalAmount)) {
          result.skippedZeroAmount += 1;
          continue;
        }

        const created = await this.insertEntry({
          tenantId: order.tenantId,
          orderId: order.id,
          orderNo: order.orderNo,
          type: ReceiptType.SALE,
          amount: order.totalAmount,
          // ⚠️ **归期用 `paidAt`** —— 与抽佣流水的归期口径逐字一致。
          occurredAt: order.paidAt as Date,
        });
        if (created) {
          result.receiptCreated += 1;
        }

        if (!refunded) {
          continue;
        }

        if (
          !shouldBackfillReceiptReversal(
            refunded,
            order.refundedAt,
            order.totalAmount,
          )
        ) {
          // ⚠️ **已退款但 `refundedAt` 为 null**：5b 之前退的款没记时间，
          // 冲回无法归期 → 跳过（与抽佣口径一致），但**要计数**。
          if (order.totalAmount !== 0) {
            result.skippedUndatedRefund += 1;
          }
          continue;
        }

        const createdReversal = await this.insertEntry({
          tenantId: order.tenantId,
          orderId: order.id,
          orderNo: order.orderNo,
          type: ReceiptType.SALE_REVERSAL,
          amount: -order.totalAmount,
          occurredAt: order.refundedAt as Date,
        });
        if (createdReversal) {
          result.reversalCreated += 1;
        }
      }
    });

    this.logger.log(
      `货款流水回填完成：货款 ${result.receiptCreated} 行、冲回 ${result.reversalCreated} 行，` +
        `跳过零额 ${result.skippedZeroAmount} 单、跳过无归期退款 ${result.skippedUndatedRefund} 单`,
    );

    return result;
  }

  /**
   * 幂等地插一行货款流水（**回填用**，走 `this.prisma` 而不是事务客户端）。
   *
   * ⚠️ **回填跑在平台作用域下**：平台作用域下扩展**不附加** tenantId 条件，
   * 所以这里的 `findFirst` 必须**自己带上 `tenantId`** ——
   * 不带的话，别的租户的同名行会被误判成「已存在」而漏记。
   */
  private async insertEntry(data: ReceiptEntryData): Promise<boolean> {
    const existing = await this.prisma.merchantReceipt.findFirst({
      where: {
        tenantId: data.tenantId,
        orderId: data.orderId,
        type: data.type,
      },
      select: { id: true },
    });
    if (existing) {
      return false;
    }

    await this.prisma.merchantReceipt.create({ data });
    return true;
  }
}
```

- [ ] **Step 4：跑测试确认它通过**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests src/modules/billing/receipt.spec.ts
```

Expected: PASS —— 8 passed ✅

- [ ] **Step 5：在 `payment.service.ts` 的两个事务里加写入调用**

Modify `api/src/modules/payment/payment.service.ts`：

**5a. 支付成功处**（在 `await this.commission.recordCommissionInTx(tx, order, paidAt);` **之后**紧接着加）：

```ts
    // ---- 记一笔货款流水（阶段 5h-1）----
    //
    // ⚠️ **必须在同一个事务里，且紧跟在抽佣流水之后**：
    // 两张流水表的口径必须同步 —— 「有货款 ⟺ 有抽佣」是出款计算的前提
    // （唯一的例外是零额抽佣，那是有货款、无抽佣）。
    //
    // ⚠️ **`occurredAt` 用 `paidAt`** —— 与抽佣流水、与平台收入报表的归期口径逐字一致。
    await this.receipt.recordReceiptInTx(tx, order, paidAt);
```

⚠️ **不要**把抽佣的那行注释删掉或改写 —— 5e 的注释记录了「为什么必须在同一事务」，
那是本仓库的既有知识。

**5b. 退款处**（在 `await this.commission.recordReversalInTx(tx, order, refundedAt);` 之后加）：

```ts
        // ---- 记一笔货款冲回流水（阶段 5h-1）----
        //
        // ⚠️ **金额取负**（`recordReceiptReversalInTx` 内部处理）——
        // 与货款行反向，单列求和即净额。
        //
        // ⚠️ **必须在同一个事务里**：订单转 REFUNDED 与「商家该收的钱被冲回了」
        // 同生共死。分成两个事务的话，退款成功而货款冲回没记上 → 商家多拿钱。
        await this.receipt.recordReceiptReversalInTx(tx, order, refundedAt);
```

**5c. 注入 `ReceiptService`**：在 `PaymentService` 的构造函数里加 `private readonly receipt: ReceiptService,`
与 import：

```ts
import { ReceiptService } from '../billing/receipt.service';
```

⚠️ **`PaymentModule` 要 import `BillingModule`**（或 `ReceiptService` 所在的模块），
否则 Nest 解析不出依赖 → 启动直接失败。检查 `api/src/modules/payment/payment.module.ts`
的 `imports` 数组，把 `BillingModule` 加进去（如果还没有）。

**5d. ⚠️ 把 `ReceiptService` 注册进 `BillingModule`（本 Task 独占这一波，见 §0.5）**

Modify `api/src/modules/billing/billing.module.ts`：

- `providers` 里加 `ReceiptService`
- `exports` 里加 `ReceiptService` —— ⚠️ **必须导出**：`PaymentModule` 要用它，
  NestJS 里 imported module 的 provider 只有被 `exports` 了才能被用到
- ⚠️ **纯追加**：不改既有行（5g 的做法是「8 增 0 删」）

⚠️ **Task 3/5/6/7 都不碰这个文件** —— 它们的注册统一放在 Task 8 的 Step 0。

- [ ] **Step 6：把回填脚本扩展成「一次跑两套」**

Modify `api/scripts/backfill-commission-entries.ts` —— 在现有回填逻辑之后，
**追加**货款流水的回填调用，并把日志改成两套计数都打。

⚠️ **命令名保持不变**（`npm run backfill:commissions`）——
运维的老习惯不用改；同时在 `api/package.json` 里加一个别名：

```json
"backfill:ledger": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' scripts/backfill-commission-entries.ts",
"backfill:commissions": "npm run backfill:ledger",
```

⚠️ **`backfill:commissions` 改成 `npm run backfill:ledger` 的转发**（不是两份脚本）——
两份脚本意味着两套逻辑要同步维护，早晚漂。

- [ ] **Step 7：跑定向测试 + 类型检查**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests src/modules/billing/
npx tsc --noEmit
npx eslint src/modules/billing/ src/modules/payment/ scripts/
```

Expected: 全部通过，`tsc` 无输出，`eslint` 无告警。

- [ ] **Step 8：跑支付与账务的 e2e（确认没改坏 5f/5e 的链路）**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- payment settlement billing-report order
```

Expected: 全绿。⚠️ **这一步是本 Task 的核心验收** —— 改了 `payment.service.ts` 的事务，
5f 的支付可靠性与 5e 的抽佣流水都必须**一条不落地**继续通过。

⚠️ **文件名要选对**（实测过）：抽佣台账的 e2e 在 **`billing-report.e2e-spec.ts`** 里，
**没有** `commission.e2e-spec.ts` 这个文件 → 写 `commission` 会静默地一个文件都匹配不到。
`payment` 会匹配到 `payment.e2e-spec.ts` 与 `payment-compensation.e2e-spec.ts` 两个；
`order` 会匹配到 3 个订单相关的 —— **都是想要的**（退款流程在 order 模块的端点里）。

- [ ] **Step 9：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/receipt.service.ts api/src/modules/billing/receipt.spec.ts \
        api/src/modules/payment/payment.service.ts api/src/modules/payment/payment.module.ts \
        api/scripts/backfill-commission-entries.ts api/package.json
git commit -m "feat(api): 商家应收货款流水——与抽佣流水同事务写入"
```

---

## Task 3：出款单的服务层（申请 / 审批 / 拒绝 / 撤回 / 查询）

**Files:**
- Create: `api/src/modules/billing/dto/apply-payout.dto.ts`
- Create: `api/src/modules/billing/dto/payout-decision.dto.ts`
- Create: `api/src/modules/billing/dto/payout-list-query.dto.ts`
- Create: `api/src/modules/billing/payout.service.ts`
- Create: `api/src/modules/billing/payout.service.spec.ts`

⚠️ **这是本阶段的核心 Task** —— 护栏 P1、P3、P4、P5、P7、P8、P9 全部落在它身上。

- [ ] **Step 1：写 DTO**

Create `api/src/modules/billing/dto/apply-payout.dto.ts`：

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * 申请出款的请求体。
 *
 * ⚠️ **请求体里没有任何金额字段**（护栏 P4）：应结金额全部由后端从
 * 货款流水与结算单算出来。前端能传金额的话，改一行前端就能改平台打给
 * 商家多少钱 —— 那不是「可被利用的漏洞」，那是把金额校验整个删掉。
 */
export class ApplyPayoutDto {
  @ApiProperty({
    description: '结算周期（自然月，UTC）。必须是 YYYY-MM',
    example: '2025-07',
  })
  @IsString()
  @Matches(/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/, {
    message: '周期格式非法：必须是 YYYY-MM，年份在 1000 到 9998 之间（如 2025-07）',
  })
  period!: string;
}
```

Create `api/src/modules/billing/dto/payout-decision.dto.ts`：

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 审批出款的请求体。
 *
 * ⚠️ **只有拒绝时才需要填原因**（`reason` 可选）——
 * 通过时没什么好解释的，非要商家与超管都填一遍「同意」纯属噪声。
 */
export class PayoutDecisionDto {
  @ApiProperty({
    description: '拒绝原因。拒绝时必填（由 service 层校验）',
    required: false,
    example: '该期结算单尚未确认',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}
```

Create `api/src/modules/billing/dto/payout-list-query.dto.ts`：

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { PayoutStatus } from '@prisma/client';

export class PayoutListQueryDto {
  @ApiProperty({ description: '按状态筛选', required: false })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @ApiProperty({ description: '按周期筛选（YYYY-MM）', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/, {
    message: '周期格式非法：必须是 YYYY-MM，年份在 1000 到 9998 之间',
  })
  period?: string;

  @ApiProperty({ description: '页码（从 1 开始）', required: false })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiProperty({ description: '每页条数', required: false })
  @IsOptional()
  @IsString()
  pageSize?: string;
}
```

- [ ] **Step 2：写服务层的失败测试（手写假 Prisma）**

⚠️ **手写假 Prisma 的骨架照抄 `api/src/modules/billing/settlement.service.spec.ts`**（5g 已有的文件，
**先读它** —— 它已经把「假 Prisma 怎么搭、`$transaction` 怎么桩、平台作用域怎么模拟」都写清楚了）。

⚠️ **5g 那份假 Prisma 是「配置驱动」的**：每个方法的返回值由 `options` 配好，
**它不按 `where` 过滤**（例如 `findFirst: jest.fn(() => Promise.resolve(options.statement ?? null))`）。
→ **本 Task 沿用这个风格**，**不要**自己写一个「真按 where 过滤」的假 Prisma（那是几倍的活，且不值）。

⚠️ **代价与对策**：假 Prisma 不按 `where` 过滤 ⇒ **「查不到别家的单」这种行为在单测里测不出来**
（`findFirst` 无论传什么 `where` 都返回配置的那个单）。
→ **租户隔离（P9）在单测里靠「断言 service 层传的 where」来验**：
```ts
const [call] = fakePrisma.payout.findFirst.mock.calls;
expect(call[0].where).toEqual({ id: payoutId });   // 商家侧：靠租户作用域自动过滤
```
⚠️ **跨租户的实际行为（404/403）放到 e2e 验**（Task 8 的「商家 A 访问商家 B 的单 → 404」）——
真实 Prisma 才会真的过滤。

⚠️ **本 Task 要在那个假 Prisma 上补的模型桩**（形状照抄既有文件里对应模型的写法）：

```ts
// ⚠️ **出款单**：条件更新（`updateMany`）的**影响行数要能被控制**
// （`options.updateManyCount`），「状态机 + 并发互斥」全靠它。
payout: {
  findFirst: jest.fn(() => Promise.resolve(options.payout ?? null)),
  findMany: jest.fn(() => Promise.resolve(options.payouts ?? [])),
  count: jest.fn(() => Promise.resolve(options.payoutCount ?? 0)),
  create: jest.fn(() => Promise.resolve(options.createdPayout ?? null)),
  updateMany: jest.fn(() => Promise.resolve({ count: options.updateManyCount ?? 1 })),
},

// ⚠️ **出款单明细**：`createMany` 的数据要能被断言（「申请时固定了哪些流水」）。
payoutEntry: {
  createMany: jest.fn(() => Promise.resolve({ count: 1 })),
  findMany: jest.fn(() => Promise.resolve(options.linkedRows ?? [])),
},

// ⚠️ **货款流水**：`findMany` 的**入参要被断言**（归期区间与 tenantId）。
merchantReceipt: {
  findMany: jest.fn(() => Promise.resolve(options.receipts ?? [])),
},
```

⚠️ **假 Prisma 的桩要「入参可断言」**：所有 `jest.fn()` 都要能被
`mock.calls[0][0].where` 读到 → 断言「service 层传了什么条件」。

要覆盖的用例（**每条护栏至少一条**）：

| 用例 | 护栏 | 断言 |
|------|------|------|
| 申请：周期未结束 → 400 | 周期校验 | 抛 `BadRequestException`，且**没建任何单**（`payout.create` 没被调用） |
| 申请：该期已有活跃出款单 → **幂等返回它** | P1 | 返回既有单；`payout.create` **没被调用** |
| 申请：应结金额 ≤ 0 → 400 | 边界 | 抛 `BadRequestException` |
| 申请：结算单未 CONFIRMED → 409 | P3 | 抛 `ConflictException` |
| 申请：请求体带金额 → **DTO 层拦住** | P4 | DTO 单测（见 Step 4） |
| 申请：固定纳入的流水写进 `payoutEntry.createMany` | D7 | 断言 `createMany` 的 data 里是当期那几笔流水的 id |
| 审批：重算金额（不等于申请时的预估） | P5 | 断言落库的 `netAmount` 是**重算值**，`requestedAmount` 保留旧值 |
| 审批：`updateMany` 的 where 带 `status: REQUESTED` | P7 | 断言 `updateMany` 的 `where.status` |
| 审批：affected.count === 0 → 409 | P7 | 桩返回 `{ count: 0 }` → 抛 `ConflictException` |
| 审批：拒绝必须带原因 | 边界 | 缺原因 → 400 |
| 撤回：只能撤 REQUESTED | P7 | 桩返回 `{ count: 0 }` → 409 |
| 撤回：**查单时的 where 里没有手写的 tenantId**（靠租户作用域自动过滤） | P9 | 断言 `findFirst` 的 `where` 是 `{ id: payoutId }` —— ⚠️ **不要自己带 tenantId**（带上会与租户作用域的自动过滤重复；且扩展附的那份会**覆盖**手写的那份 → 手写既不生效也不构成漏洞，只是噪声。见勘误 E6） |
| 明细归属：查流水时**带了 `tenantId`** | P9 | 断言 `merchantReceipt.findMany` 的 `where.tenantId` 等于 `payout.tenantId`（这才是真正的归属校验） |

- [ ] **Step 3：跑测试确认它失败**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests src/modules/billing/payout.service.spec.ts
```

Expected: FAIL —— `Cannot find module './payout.service'` ✅

- [ ] **Step 4：写 DTO 的单测（护栏 P4）**

在 `payout.service.spec.ts` 里加一组 DTO 断言（用 `class-validator` 的 `validate`）：

```ts
import { validate } from 'class-validator';
import { ApplyPayoutDto } from './dto/apply-payout.dto';

describe('申请出款的请求体（护栏 P4：金额一律后端算）', () => {
  it('⚠️ 带了金额字段 → 校验不过（DTO 里根本没有这个属性）', async () => {
    const dto = new ApplyPayoutDto();
    // ⚠️ 客户端多传一个字段，服务端**不会**报错（class-validator 默认忽略未知键）
    //    —— 所以护栏不在 DTO，而在「service 只从流水与结算单取数」这一侧。
    //    这条断言的作用是把「DTO 没有金额属性」这件事钉死：
    //    将来有人往 DTO 上加 `amount`，这条会立刻挂。
    expect(Object.keys(dto)).toEqual([]);
    expect('amount' in dto).toBe(false);
  });

  it('周期格式非法 → 校验不过', async () => {
    const dto = new ApplyPayoutDto();
    dto.period = '2025-13';
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('周期合法 → 校验过', async () => {
    const dto = new ApplyPayoutDto();
    dto.period = '2025-07';
    expect(await validate(dto)).toHaveLength(0);
  });
});
```

- [ ] **Step 5：写 `payout.service.ts`**

Create `api/src/modules/billing/payout.service.ts`：

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PayoutStatus,
  SettlementStatus,
  type Payout,
} from '@prisma/client';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { formatPeriodLabel, resolveMonthlyPeriod } from './settlement';

/** 出款单的对外形状（租户视角） */
export interface PayoutView {
  id: string;
  payoutNo: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  /** 货款净额（正数） */
  receiptAmount: number;
  /** 佣金净额（正数 = 平台抽了多少） */
  commissionAmount: number;
  /** 应结给商家的金额 */
  netAmount: number;
  entryCount: number;
  status: PayoutStatus;
  /** 申请时的预估金额（与 `netAmount` 可能不同 —— 审批时会重算） */
  requestedAmount: number;
  statementId: string | null;
  requestedBy: string;
  approvedBy: string | null;
  rejectedReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** 出款单明细的一行 */
export interface PayoutEntryView {
  entryId: string;
  orderNo: string;
  type: string;
  amount: number;
  occurredAt: string;
}

/** 出款单详情（含明细） */
export interface PayoutDetailView extends PayoutView {
  entries: PayoutEntryView[];
}

/** 平台视角：多商家名与子域名 */
export interface PlatformPayoutView extends PayoutView {
  tenantId: string;
  tenantName: string;
  subdomain: string;
}

/** 可申请周期的预览（商家端「申请出款」页用） */
export interface AvailablePeriodView {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  /** 该期结算单的状态；null = 该期没有结算单（零额抽佣） */
  statementStatus: SettlementStatus | null;
  /** 该期是否已有活跃出款单 */
  alreadyApplied: boolean;
}

/** 分页的入参 */
interface Paging {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/**
 * 出款单的服务层（阶段 5h-1）。
 *
 * ⚠️ **金额三件套站在「商家应收」角度**：`commissionAmount` 是**正数**
 * （平台抽了多少，与结算单的 `netAmount` 同号），
 * `netAmount = receiptAmount − commissionAmount` 是应结给商家的钱。
 * ⚠️ **别把结算单那套「冲回是负数」的符号搬过来** —— 这一类已坑过两次。
 *
 * ⚠️ **商家侧与平台侧的鉴权路径完全不同**：商家侧靠租户作用域扩展
 * 自动过滤（`payouts` 在白名单里），平台侧要显式 `platformScope()`。
 */
@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 商家申请出款（指定自然月）。
   *
   * ⚠️ **幂等检查放最前**：该期已有活跃出款单 → **原样返回它**
   * （不报错、不重算金额 —— 金额已锁定）。
   * 商家重复提交是网络重试或手滑，报错会让商家以为申请失败。
   */
  async apply(input: { period: string }): Promise<PayoutView> {
    const period = resolveMonthlyPeriod(input.period);
    const context = getTenantContext();
    const tenantId = context.tenantId;
    const userId = context.userId;

    if (!tenantId || !userId) {
      throw new BadRequestException('缺少租户或用户上下文');
    }

    // ⚠️ **幂等分支在最前**：先查「该期有没有活跃单」。
    // 查的时候**必须带上状态条件** —— REJECTED / CANCELLED 的单不占位，
    // 商家要能重新申请（部分唯一索引也是这个条件）。
    const existing = await this.findActivePayout(tenantId, period.from);
    if (existing) {
      return this.toView(existing);
    }

    // ⚠️ **周期必须已结束**：周期内的流水还会变（回填随时可能补进来），
    // 此时的数字不是凭证。与结算单的 D7 同一理由。
    const now = await this.prisma.databaseNow();
    if (period.to.getTime() > now.getTime()) {
      throw new BadRequestException(
        `周期 ${period.label} 尚未结束，不能申请出款`,
      );
    }

    // ⚠️ **收款账户必须先填**：没有账户就不知道钱打给谁。
    const account = await this.prisma.merchantPayoutAccount.findFirst({
      where: { tenantId },
    });
    if (!account) {
      throw new BadRequestException('请先在「出款」页设置收款账户');
    }

    const amounts = await this.computeAmounts(tenantId, period);

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

    const payoutNo = generatePayoutNo(now);
    let created: Payout;
    try {
      created = await this.prisma.$transaction(
        async (tx) => {
          const payout = await tx.payout.create({
            data: {
              tenantId,
              payoutNo,
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
      // ⚠️ **并发申请会撞唯一索引**：`payouts` 的「同一商家同一周期一张活跃单」
      // 是**部分唯一索引**（`WHERE status NOT IN ('REJECTED','CANCELLED')`）——
      // **Prisma 的 schema 层感知不到它**（`@@unique` 表达不了 WHERE 子句，
      // 它只存在于迁移 SQL 里）。两个并发申请会**同时**通过上面的前置查，
      // 然后其中一个撞索引 → P2002。
      //
      // ⚠️ **不能把 P2002 当错误抛出去**：对商家来说「你已经申请过了」
      // 不是失败。→ 重新查一次，拿到对方刚建的那张，幂等返回。
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const raced = await this.findActivePayout(tenantId, period.from);
      if (!raced) {
        // ⚠️ **撞的不是活跃周期那条索引**（例如 `payoutNo` 撞了）
        //    → 原样抛出，**不伪装成「重复申请」**。
        throw error;
      }
      return this.toView(raced);
    }

    this.logger.log(
      `出款申请已创建：${payoutNo}（${period.label}，${amounts.netAmount} 分）`,
    );
    return this.toView(created);
  }

  /**
   * 商家撤回申请（仅 `REQUESTED` 可撤）。
   *
   * ⚠️ **条件更新**（where 带 status）：与平台审批并发时，
   * 两个更新只有一个能成功，另一个拿到 409。
   */
  async cancel(payoutId: string): Promise<PayoutView> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new BadRequestException('缺少租户上下文');
    }

    // ⚠️ **先查后判**：查不到就是不存在或不是本租户的 → 404。
    // ⚠️ **别把「不是我的」说成「不存在」** —— 那是信息泄露（能区分
    // 「单号不存在」与「单号存在但不是你的」）。
    const payout = await this.prisma.payout.findFirst({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('出款单不存在');
    }

    const now = await this.prisma.databaseNow();
    const affected = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: PayoutStatus.REQUESTED },
      data: { status: PayoutStatus.CANCELLED, cancelledAt: now },
    });
    if (affected.count === 0) {
      throw new ConflictException(
        `出款单当前是「${payout.status}」状态，不能撤回`,
      );
    }

    const updated = await this.prisma.payout.findFirst({
      where: { id: payoutId },
    });
    return this.toView(updated as never);
  }

  /**
   * 平台审批：**通过**（重算并锁定金额）。
   *
   * ⚠️ **重算金额**（护栏 P5）：不采信申请时的预估 —— 从申请到审批之间，
   * 流水可能补进来了、结算单可能被重算了。锁定的是**审批那一刻**的值。
   */
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

      // ⚠️ **重算**：用的是与申请时完全相同的两条数据源。
      const period = { from: payout.periodStart, to: payout.periodEnd };
      const amounts = await this.computeAmounts(payout.tenantId, period);

      const now = await this.prisma.databaseNow();
      const affected = await this.prisma.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.REQUESTED },
        data: {
          status: PayoutStatus.APPROVED,
          approvedBy: userId,
          approvedAt: now,
          // ⚠️ **锁定的是重算后的值**：`requestedAmount` 保留申请时的预估，
          // 两者的差异由审批人自己判断（不设阈值、不强制填原因）。
          receiptAmount: amounts.receiptAmount,
          commissionAmount: amounts.commissionAmount,
          netAmount: amounts.netAmount,
          entryCount: amounts.entryCount,
          statementId: amounts.statementId,
        },
      });
      if (affected.count === 0) {
        throw new ConflictException('出款单已被审批或状态已变，不能重复审批');
      }

      const updated = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      return this.toPlatformView(updated as never);
    });
  }

  /**
   * 平台审批：**拒绝**（必须给原因）。
   *
   * ⚠️ **原因必填**：没有原因的拒绝对商家毫无意义 —— 商家不知道该改什么，
   * 只能打电话问客服。
   */
  async reject(payoutId: string, reason: string): Promise<PlatformPayoutView> {
    const trimmed = reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('拒绝出款必须填写原因');
    }

    const context = getTenantContext();
    const userId = context.userId;
    if (!userId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.REQUESTED },
        data: {
          status: PayoutStatus.REJECTED,
          approvedBy: userId,
          rejectedReason: trimmed,
        },
      });
      if (affected.count === 0) {
        throw new ConflictException('出款单已被处理或状态已变，不能重复审批');
      }

      const updated = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      return this.toPlatformView(updated as never);
    });
  }

  /**
   * 商家的出款单列表（只读）。
   *
   * ⚠️ **不传 tenantId**：商家侧靠租户作用域扩展自动过滤。
   */
  async listForTenant(
    query: { status?: PayoutStatus; period?: string } & Paging = {},
  ): Promise<{ items: PayoutView[]; total: number }> {
    const { page, pageSize } = this.clampPaging(query);
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.period
        ? { periodStart: resolveMonthlyPeriod(query.period).from }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.payout.count({ where }),
    ]);

    return { items: items.map((item) => this.toView(item)), total };
  }

  /** 商家的出款单详情（含明细） */
  async detailForTenant(payoutId: string): Promise<PayoutDetailView> {
    const payout = await this.prisma.payout.findFirst({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('出款单不存在');
    }
    const entries = await this.entriesOf(payout);
    return { ...this.toView(payout), entries };
  }

  /** 平台的出款单列表（跨商家） */
  async listForPlatform(
    query: { status?: PayoutStatus; period?: string } & Paging = {},
  ): Promise<{ items: PlatformPayoutView[]; total: number }> {
    return tenantContext.run(platformScope(), async () => {
      const { page, pageSize } = this.clampPaging(query);
      const where = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.period
          ? { periodStart: resolveMonthlyPeriod(query.period).from }
          : {}),
      };

      const [items, total] = await Promise.all([
        this.prisma.payout.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.payout.count({ where }),
      ]);

      return {
        items: await Promise.all(items.map((item) => this.toPlatformView(item))),
        total,
      };
    });
  }

  /** 平台的出款单详情（含明细与商家名） */
  async detailForPlatform(payoutId: string): Promise<PlatformPayoutView & { entries: PayoutEntryView[] }> {
    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      const entries = await this.entriesOf(payout);
      return { ...(await this.toPlatformView(payout)), entries };
    });
  }

  /**
   * 商家可申请的周期列表（**金额由后端算**，商家据此选周期）。
   *
   * ⚠️ **只列出真正能申请的周期**：周期已结束 + 有货款流水 + 应结 > 0。
   * 列出一堆不能申请的周期，商家挨个试才知道哪个能申请。
   */
  async availablePeriods(): Promise<AvailablePeriodView[]> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new BadRequestException('缺少租户上下文');
    }

    const now = await this.prisma.databaseNow();

    // ⚠️ **只查已结束的周期**：`occurredAt < now` 的月份才可能已结束。
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { tenantId, occurredAt: { lt: now } },
      orderBy: { occurredAt: 'desc' },
    });

    // ⚠️ **按月分组**：流水是逐笔的，周期是月的。
    const byPeriod = new Map<
      string,
      { entryIds: string[]; receiptAmount: number }
    >();
    for (const receipt of receipts) {
      const key = formatPeriodLabel(receipt.occurredAt);
      const bucket = byPeriod.get(key) ?? {
        entryIds: [],
        receiptAmount: 0,
      };
      bucket.entryIds.push(receipt.id);
      bucket.receiptAmount += receipt.amount;
      byPeriod.set(key, bucket);
    }

    const periods = [...byPeriod.entries()].sort((a, b) =>
      b[0].localeCompare(a[0]),
    );

    const views: AvailablePeriodView[] = [];
    for (const [period, bucket] of periods) {
      const resolved = resolveMonthlyPeriod(period);
      if (resolved.to.getTime() > now.getTime()) {
        continue;
      }
      const amounts = await this.computeAmounts(tenantId, resolved);
      if (amounts.entryCount === 0 || amounts.netAmount <= 0) {
        continue;
      }
      const applied = await this.prisma.payout.findFirst({
        where: {
          tenantId,
          periodStart: resolved.from,
          status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED] },
        },
        select: { id: true },
      });
      views.push({
        period,
        receiptAmount: amounts.receiptAmount,
        commissionAmount: amounts.commissionAmount,
        netAmount: amounts.netAmount,
        entryCount: amounts.entryCount,
        statementStatus: amounts.statementStatus,
        alreadyApplied: !!applied,
      });
    }
    return views;
  }

  /**
   * 算某一期的应结金额。
   *
   * ⚠️ **两侧口径**：
   * - 货款净额 = 该期 `merchant_receipts` 的金额之和
   * - 佣金净额 = 该期**已 CONFIRMED** 的结算单的 `netAmount`（没有结算单 → 0）
   *
   * ⚠️ **佣金取结算单的 `netAmount`，不是重新聚合抽佣流水** ——
   * 结算单是**已确认的凭证**，以它为准；重新聚合会与结算单的冻结值对不上。
   */
  private async computeAmounts(
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
      where: {
        tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });

    const receiptAmount = receipts.reduce((sum, r) => sum + r.amount, 0);

    // ⚠️ **结算单必须在已 CONFIRMED 的状态**（护栏 P3）。
    // 找到的那张若不是 CONFIRMED → 409 —— 不能拿一张草稿单当佣金依据。
    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart: period.from },
    });
    if (statement && statement.status !== SettlementStatus.CONFIRMED) {
      throw new ConflictException(
        `该期（${formatPeriodLabel(period.from)}）的结算单尚未确认，不能申请出款`,
      );
    }

    const commissionAmount = statement ? statement.netAmount : 0;

    return {
      receiptAmount,
      commissionAmount,
      netAmount: receiptAmount - commissionAmount,
      entryCount: receipts.length,
      entryIds: receipts.map((r) => r.id),
      statementId: statement?.id ?? null,
      statementStatus: statement?.status ?? null,
    };
  }

  /**
   * 出款单的明细（关联的货款流水）。
   *
   * ⚠️ **必须校验归属**（护栏 P9）：`payout_entries` **不在**租户白名单里
   * → 扩展不附加任何过滤 → 这里查到的是全局事实。
   *
   * ⚠️ **两道校验都要有**：
   * ① 调用方先确认 `payout` 是本租户的（商家侧靠租户作用域的
   *    `findFirst` 自动过滤；平台侧是显式查出来的）；
   * ② 这里再查流水时**带上 `payout.tenantId`** ——
   *    脏数据可能把别家的流水关联到这张单上（`payout_entries` 上
   *    没有 tenantId 约束），不带条件就会把别家的订单号显示给商家。
   */
  private async entriesOf(payout: {
    id: string;
    tenantId: string;
  }): Promise<PayoutEntryView[]> {
    const links = await this.prisma.payoutEntry.findMany({
      where: { payoutId: payout.id },
    });
    if (links.length === 0) {
      return [];
    }
    const receipts = await this.prisma.merchantReceipt.findMany({
      // ⚠️ **带上 tenantId**：别家的流水一律查不到 → 不会显示给商家。
      where: {
        tenantId: payout.tenantId,
        id: { in: links.map((link) => link.entryId) },
      },
    });
    const byId = new Map(receipts.map((r) => [r.id, r]));
    return links
      .map((link) => {
        const receipt = byId.get(link.entryId);
        if (!receipt) {
          return null;
        }
        return {
          entryId: receipt.id,
          orderNo: receipt.orderNo,
          type: receipt.type,
          amount: receipt.amount,
          occurredAt: receipt.occurredAt.toISOString(),
        };
      })
      .filter((entry): entry is PayoutEntryView => entry !== null)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  /** 单据 → 对外字段（租户视角） */
  private toView(payout: {
    id: string;
    payoutNo: string;
    periodStart: Date;
    periodEnd: Date;
    receiptAmount: number;
    commissionAmount: number;
    netAmount: number;
    entryCount: number;
    status: PayoutStatus;
    requestedAmount: number;
    statementId: string | null;
    requestedBy: string;
    approvedBy: string | null;
    rejectedReason: string | null;
    requestedAt: Date;
    approvedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
  }): PayoutView {
    return {
      id: payout.id,
      payoutNo: payout.payoutNo,
      periodStart: payout.periodStart.toISOString(),
      periodEnd: payout.periodEnd.toISOString(),
      periodLabel: formatPeriodLabel(payout.periodStart),
      receiptAmount: payout.receiptAmount,
      commissionAmount: payout.commissionAmount,
      netAmount: payout.netAmount,
      entryCount: payout.entryCount,
      status: payout.status,
      requestedAmount: payout.requestedAmount,
      statementId: payout.statementId,
      requestedBy: payout.requestedBy,
      approvedBy: payout.approvedBy,
      rejectedReason: payout.rejectedReason,
      requestedAt: payout.requestedAt.toISOString(),
      approvedAt: payout.approvedAt?.toISOString() ?? null,
      cancelledAt: payout.cancelledAt?.toISOString() ?? null,
      createdAt: payout.createdAt.toISOString(),
    };
  }

  /** 单据 → 对外字段（平台视角，多商家名） */
  private async toPlatformView(
    payout: Parameters<PayoutService['toView']>[0],
  ): Promise<PlatformPayoutView> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: payout.tenantId },
      select: { name: true, subdomain: true },
    });
    return {
      ...this.toView(payout),
      tenantId: payout.tenantId,
      // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行。
      tenantName: tenant?.name ?? payout.tenantId,
      subdomain: tenant?.subdomain ?? '—',
    };
  }

  /** 分页参数夹上下限 */
  private clampPaging(query: Paging): { page: number; pageSize: number } {
    const page =
      query.page && Number.isFinite(query.page) && query.page > 0
        ? Math.floor(query.page)
        : 1;
    const raw = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const pageSize =
      Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    return { page, pageSize };
  }
}

/**
 * 生成出款单号。
 *
 * ⚠️ **服务端生成**：出款单号不是秘密（它出现在对账单里），
 * 但**不能由客户端指定** —— 否则「A 单号对应 B 商家的账」就可能发生。
 *
 * ⚠️ **秒级时间戳 + 4 位随机数**：同一秒内生成 10000 张才会撞一次
 * （与 5g 的 `generateStatementNo` 同款）。
 */
function generatePayoutNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `PAY${stamp}${random}`;
}
```

⚠️ **注意**：这个文件里 `formatPeriodLabel` 从 `./settlement` 导入（5g 的纯函数），
`resolveMonthlyPeriod` 也是。⚠️ **不要重新实现一份** —— 两处口径漂了账就错了。

- [ ] **Step 6：跑测试确认它通过**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests src/modules/billing/payout.service.spec.ts
```

Expected: PASS —— 全部通过 ✅

- [ ] **Step 7：类型检查 + lint**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
npx eslint src/modules/billing/
```

Expected: `tsc` 无输出，`eslint` 无告警。

⚠️ **`toView` 的参数类型**：上面用 `Parameters<PayoutService['toView']>[0]` 有点绕。
如果 `tsc` 报「私有成员不可通过索引访问」，就把那个类型**抽成一个具名的 interface**
（`interface PayoutRow { ... }`）放在文件顶部，`toView(payout: PayoutRow)`。

- [ ] **Step 8：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/payout.service.ts api/src/modules/billing/payout.service.spec.ts \
        api/src/modules/billing/dto/apply-payout.dto.ts api/src/modules/billing/dto/payout-decision.dto.ts \
        api/src/modules/billing/dto/payout-list-query.dto.ts
git commit -m "feat(api): 出款单的服务层——申请、审批、拒绝、撤回"
```

---

## Task 4：5g 的 `unconfirm` 加「已被出款单引用」的闸

**Files:**
- Modify: `api/src/modules/billing/settlement.service.ts`（`unconfirm` 方法）
- Modify: `api/test/settlement.e2e-spec.ts`（加一条用例）

⚠️ **为什么这道闸必须有**（护栏 P6）：出款单的佣金金额是**审批时锁定的快照**。
结算单被「取消确认」后，佣金会变（重算）→ 已批的出款单金额就失真了 →
平台打出去的钱与账对不上。

- [ ] **Step 1：写失败的 e2e**

在 `api/test/settlement.e2e-spec.ts` 里加一条（**放在 S6 那组附近**）：

```ts
  it('⚠️ 已被出款单引用的结算单 → 不能取消确认（护栏 P6）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-03');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-03', merchant.tenantId);
    const id = body.items[0].id;

    // 先确认
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    // ⚠️ **手工造一张引用了这张结算单的出款单**：
    // 本阶段出款单的创建要走商家申请，而 e2e 里出款端点是 Task 7 才有的。
    // 这里直接插库 —— 测的是「结算单被引用后取消确认被拒」这条闸本身。
    await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY-TEST-${unique()}`,
          periodStart: period.from,
          periodEnd: period.to,
          statementId: id,
          receiptAmount: 100,
          commissionAmount: 100,
          netAmount: 0,
          entryCount: 0,
          status: 'APPROVED',
          requestedAmount: 0,
          requestedBy: 'test-user',
          approvedBy: 'test-admin',
        },
      }),
    );

    // ⚠️ **取消确认 → 409**，且结算单仍是 CONFIRMED
    const response = await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(String(response.body.message)).toContain('出款单');

    const after = await fetchDetail(adminToken, id);
    expect(after.status).toBe('CONFIRMED');
  });
```

- [ ] **Step 2：跑测试确认它失败**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- settlement
```

Expected: FAIL —— 期望 409，实际 201 ✅（因为闸还没加）

- [ ] **Step 3：加闸**

Modify `api/src/modules/billing/settlement.service.ts` 的 `unconfirm` 方法 ——
在它开始做状态更新**之前**加：

```ts
    // ⚠️ **已被出款单引用的结算单不能取消确认**（阶段 5h-1，护栏 P6）：
    //    出款单的佣金金额是**审批那一刻锁定的快照**。
    //    结算单被取消确认后重算，佣金会变 → 已批的出款单金额失真
    //    → 平台打出去的钱与账对不上。
    //
    //    ⚠️ **只查非终态的出款单**：REJECTED / CANCELLED 的单没有打钱，
    //    它们不构成「钱已经出去了」的事实 → 不该拦住修正漏结的路径。
    const referenced = await this.prisma.payout.findFirst({
      where: {
        statementId: statementId,
        status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED] },
      },
      select: { id: true },
    });
    if (referenced) {
      throw new ConflictException(
        '该结算单已被出款单引用，不能取消确认。若出款已执行，请走调账流程。',
      );
    }
```

⚠️ **注意**：这个方法跑在**平台作用域**下（`tenantContext.run(platformScope(), ...)`），
而 `payouts` 在租户白名单里 → **平台作用域下扩展不附加 tenantId 条件** → 查得到全局的 ✓

⚠️ **`PayoutStatus` 要 import**：在 `settlement.service.ts` 顶部的 `@prisma/client` import 里加上。

- [ ] **Step 4：跑测试确认它通过**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- settlement
```

Expected: PASS ✅

- [ ] **Step 5：确认没改坏 5g 原本的「取消确认」用例**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- settlement
```

Expected: 全绿，**且 5g 原本那条「CONFIRMED → 取消确认 → 回到 DRAFT」的用例仍然通过**
（那条用例没有出款单引用 → 闸不拦它）。

- [ ] **Step 6：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/settlement.service.ts api/test/settlement.e2e-spec.ts
git commit -m "fix(api): 已被出款单引用的结算单不能取消确认"
```

---

## Task 5：商家收款账户（service + 端点 + 页面）

**Files:**
- Create: `api/src/modules/billing/payout-account.service.ts`
- Create: `api/src/modules/billing/merchant-payout-account.controller.ts`
- Create: `merchant-admin/src/lib/payout.ts`
- Create: `merchant-admin/src/app/(dashboard)/settlements/account/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/settlements/account/account-form.tsx`
- Create: `merchant-admin/src/app/api/merchant/payout-account/route.ts`
- Create: `merchant-admin/test/app/api/payout-account-route.test.ts`

⚠️ **收款账户先做出款** —— 没有账户就不知道钱打给谁，申请会被 400 挡掉。
所以它必须排在出款申请之前。

- [ ] **Step 1：写服务层**

Create `api/src/modules/billing/payout-account.service.ts`：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';

/** 收款账户的对外形状（**账号脱敏**） */
export interface PayoutAccountView {
  accountName: string;
  bankName: string;
  /** 脱敏后的账号：只留尾 4 位 */
  maskedAccountNo: string;
  updatedAt: string;
}

/**
 * 商家收款账户的服务层（阶段 5h-1）。
 *
 * ⚠️ **一商家一账户**（`tenantId` 唯一）—— 本阶段不做多账户与默认账户。
 */
@Injectable()
export class PayoutAccountService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 读当前商家的收款账户（没有就是 null） */
  async get(): Promise<PayoutAccountView | null> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new NotFoundException('缺少租户上下文');
    }
    const account = await this.prisma.merchantPayoutAccount.findFirst({
      where: { tenantId },
    });
    if (!account) {
      return null;
    }
    return {
      accountName: account.accountName,
      bankName: account.bankName,
      maskedAccountNo: maskAccountNo(account.accountNo),
      updatedAt: account.updatedAt.toISOString(),
    };
  }

  /**
   * 设置当前商家的收款账户（**有则更新、无则新建**）。
   *
   * ⚠️ **用「先查后插」而不是 `upsert`**：`merchant_payout_accounts` 在
   * 租户白名单里，租户扩展对白名单模型**直接拒绝** `upsert`
   * （它的 where 只接受唯一字段，无法附加 tenantId 条件）。
   */
  async set(input: {
    accountName: string;
    bankName: string;
    accountNo: string;
  }): Promise<PayoutAccountView> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new NotFoundException('缺少租户上下文');
    }

    const existing = await this.prisma.merchantPayoutAccount.findFirst({
      where: { tenantId },
      select: { id: true },
    });

    if (existing) {
      const updated = await this.prisma.merchantPayoutAccount.updateMany({
        where: { id: existing.id },
        data: {
          accountName: input.accountName,
          bankName: input.bankName,
          accountNo: input.accountNo,
        },
      });
      if (updated.count === 0) {
        throw new NotFoundException('收款账户不存在');
      }
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: { tenantId },
      });
      return {
        accountName: account!.accountName,
        bankName: account!.bankName,
        maskedAccountNo: maskAccountNo(account!.accountNo),
        updatedAt: account!.updatedAt.toISOString(),
      };
    }

    const created = await this.prisma.merchantPayoutAccount.create({
      data: {
        tenantId,
        accountName: input.accountName,
        bankName: input.bankName,
        accountNo: input.accountNo,
      },
    });
    return {
      accountName: created.accountName,
      bankName: created.bankName,
      maskedAccountNo: maskAccountNo(created.accountNo),
      updatedAt: created.updatedAt.toISOString(),
    };
  }
}

/**
 * 账号脱敏：只留尾 4 位。
 *
 * ⚠️ **至少 4 位才脱敏**：账号短于 8 位时全打码 —— 短账号很容易被猜出来。
 */
export function maskAccountNo(accountNo: string): string {
  if (accountNo.length <= 8) {
    return '*'.repeat(accountNo.length);
  }
  return `${'*'.repeat(accountNo.length - 4)}${accountNo.slice(-4)}`;
}
```

- [ ] **Step 2：写商家侧端点**

Create `api/src/modules/billing/merchant-payout-account.controller.ts`：

```ts
import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PayoutAccountService } from './payout-account.service';

/**
 * 商家侧的收款账户接口。
 *
 * ⚠️ **只有 `MERCHANT_OWNER` 能改**：收款账户是钱的去向，
 * 员工改了等于把公司账户改了。
 */
class SetPayoutAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  accountName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  bankName!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(40)
  accountNo!: string;
}

@ApiTags('merchant-payout-account')
@Controller('merchant/payout-account')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantPayoutAccountController {
  constructor(private readonly accounts: PayoutAccountService) {}

  @Get()
  @ApiOperation({ summary: '当前商家的收款账户' })
  async get() {
    return this.accounts.get();
  }

  @Put()
  @ApiOperation({ summary: '设置当前商家的收款账户（有则更新）' })
  async set(@Body() dto: SetPayoutAccountDto) {
    return this.accounts.set({
      accountName: dto.accountName.trim(),
      bankName: dto.bankName.trim(),
      accountNo: dto.accountNo.trim(),
    });
  }
}
```

- [ ] **Step 3：⚠️ 不改 `billing.module.ts`（见 §0.5）**

⚠️ **本 Task 不碰 `billing.module.ts`** —— `PayoutAccountService` 与
`MerchantPayoutAccountController` 的注册**统一放在 Task 8 的 Step 0**。
理由：本阶段的 5 个 Task 都要往 `billing.module.ts` 里加东西，
并行代理改同一个文件必然冲突（一方的 `git add` 会把另一方的半成品一起提交）。

⚠️ **所以本 Task 不要验证「应用能启动」** —— 那时 `billing.module.ts` 里
还没有这些 provider，Nest 会因依赖注入解析不到而启动失败。
本 Task 的验证是 **tsc + eslint + 中转路由的单测** ✅

- [ ] **Step 4：写商家侧的类型文件**

Create `merchant-admin/src/lib/payout.ts`：

```ts
/**
 * 出款相关的类型与文案（阶段 5h-1）。
 *
 * ⚠️ **与后端 `api/src/modules/billing/payout.service.ts` 的类型一一对应** ——
 * 改了一边要改另一边。
 */

/** 出款单的状态 */
export type PayoutStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'PAID'
  | 'FAILED';

/** 出款单状态的中文文案 */
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  REQUESTED: '待审批',
  APPROVED: '已审批',
  REJECTED: '已拒绝',
  CANCELLED: '已撤回',
  PAID: '已出款',
  FAILED: '出款失败',
};

/** 未知状态回落「未知状态」 */
export function describePayoutStatus(status: PayoutStatus | string): string {
  return PAYOUT_STATUS_LABEL[status as PayoutStatus] ?? '未知状态';
}

/** 出款单的一行 */
export interface PayoutItem {
  id: string;
  payoutNo: string;
  periodLabel: string;
  /** 货款净额（正数） */
  receiptAmount: number;
  /** 佣金净额（正数 = 平台抽了多少） */
  commissionAmount: number;
  /** 应结给商家的金额 */
  netAmount: number;
  entryCount: number;
  status: PayoutStatus;
  /** 申请时的预估金额 */
  requestedAmount: number;
  requestedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
  rejectedReason: string | null;
}

/** 出款单详情（含明细） */
export interface PayoutDetail extends PayoutItem {
  periodStart: string;
  periodEnd: string;
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
  }>;
}

/** 收款账户（账号已脱敏） */
export interface PayoutAccount {
  accountName: string;
  bankName: string;
  maskedAccountNo: string;
  updatedAt: string;
}

/** 可申请的周期 */
export interface AvailablePeriod {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  /** 该期结算单的状态；null = 没有结算单 */
  statementStatus: string | null;
  alreadyApplied: boolean;
}
```

- [ ] **Step 5：写商家侧的中转路由**

Create `merchant-admin/src/app/api/merchant/payout-account/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 商家收款账户的中转。
 *
 * ⚠️ **请求体按白名单重建**：客户端发来的 `tenantId`、`maskedAccountNo`
 * 之类的一律不往��传 —— 账号只认「开户人 / 开户行 / 账号」三个字段。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/merchant/payout-account', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }
  const payload = parsed as Record<string, unknown>;

  const accountName =
    typeof payload.accountName === 'string' ? payload.accountName.trim() : '';
  const bankName =
    typeof payload.bankName === 'string' ? payload.bankName.trim() : '';
  const accountNo =
    typeof payload.accountNo === 'string' ? payload.accountNo.trim() : '';

  if (!accountName || !bankName || !accountNo) {
    return NextResponse.json(
      { message: '开户人、开户行、银行账号都要填' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch('/merchant/payout-account', {
      method: 'PUT',
      body: { accountName, bankName, accountNo },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

- [ ] **Step 6：写商家侧页面**

Create `merchant-admin/src/app/(dashboard)/settlements/account/page.tsx`：

```tsx
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type { PayoutAccount } from '@/lib/payout';
import { PayoutAccountForm } from './account-form';

/**
 * 商家侧的收款账户设置页（Server Component）。
 *
 * ⚠️ **账号只展示脱敏的**：后端返回的就是脱敏后的，
 * 页面**不能**自己去显示完整账号 —— 那就白脱敏了。
 */
export default async function PayoutAccountPage() {
  let account: PayoutAccount | null = null;
  let error: string | null = null;

  try {
    account = await apiFetchAuthed<PayoutAccount | null>(
      '/merchant/payout-account',
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载收款账户失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '收款账户加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">收款账户</h2>
      <p className="text-sm text-muted-foreground">
        出款的钱会打到这张卡上。一个商家只能有一张收款账户；
        账号在页面上只显示尾号。
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <PayoutAccountForm initial={account} />
    </div>
  );
}
```

Create `merchant-admin/src/app/(dashboard)/settlements/account/account-form.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import type { PayoutAccount } from '@/lib/payout';

/**
 * 收款账户表单。
 *
 * ⚠️ **账号输入框不回填完整账号**：后端只给脱敏值，
 * 商家要改账号时重新输入即可 —— 回填一个假的完整账号更危险
 * （商家以为改的是原账号，其实提交的是另一个）。
 */
export function PayoutAccountForm({
  initial,
}: {
  initial: PayoutAccount | null;
}) {
  const router = useRouter();
  const [accountName, setAccountName] = useState(initial?.accountName ?? '');
  const [bankName, setBankName] = useState(initial?.bankName ?? '');
  const [accountNo, setAccountNo] = useState('');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      // 走**同源中转**而不是直接调后端：后端没开 CORS，
      // 而且 accessToken 只留在服务端。
      const response = await fetch('/api/merchant/payout-account', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountName, bankName, accountNo }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new ApiError(
          response.status,
          'UNKNOWN',
          payload.message ?? '保存失败',
        );
      }

      setSuccess('已保存');
      setAccountNo('');
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `保存失败（${cause.status}）：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : '保存失败',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>收款账户</CardTitle>
        <CardDescription>
          {initial
            ? `当前账户：${initial.bankName} ${initial.maskedAccountNo}（${initial.accountName}）`
            : '还没有设置收款账户 —— 设好之后才能申请出款。'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="accountName">开户人姓名</Label>
            <Input
              id="accountName"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              maxLength={60}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bankName">开户行</Label>
            <Input
              id="bankName"
              value={bankName}
              onChange={(event) => setBankName(event.target.value)}
              maxLength={60}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="accountNo">银行账号</Label>
            <Input
              id="accountNo"
              value={accountNo}
              onChange={(event) => setAccountNo(event.target.value)}
              minLength={4}
              maxLength={40}
              placeholder={initial ? '不修改则留空' : '请输入银行账号'}
              required={!initial}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-primary">{success}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 7：写中转路由的测试**

Create `merchant-admin/test/app/api/payout-account-route.test.ts`（照抄
`merchant-admin/test/app/api/billing-whitelist.test.ts` 的骨架）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';

import { GET as accountGet, PUT as accountPut } from '@/app/api/merchant/payout-account/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ accountName: '张三' } as never);
});

describe('收款账户中转：请求体白名单', () => {
  it('只发开户人、开户行、账号三个字段', async () => {
    await accountPut(
      postRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
        tenantId: 'other-tenant',
        maskedAccountNo: '****0000',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'accountName',
      'accountNo',
      'bankName',
    ]);
  });

  it('缺字段 → 400 且不调后端', async () => {
    const response = await accountPut(
      postRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('畸形请求体 → 400 且不调后端', async () => {
    const response = await accountPut(
      postRequest('http://localhost/api/merchant/payout-account', ['a']),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await accountGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8：跑测试**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin"
npx vitest run test/app/api/payout-account-route.test.ts
```

Expected: PASS —— 4 passed ✅

- [ ] **Step 9：api 侧的类型检查**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit && npx eslint src/modules/billing/
```

Expected: 无输出 ✅

- [ ] **Step 10：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/payout-account.service.ts \
        api/src/modules/billing/merchant-payout-account.controller.ts \
        merchant-admin/src/lib/payout.ts \
        "merchant-admin/src/app/(dashboard)/settlements/account/page.tsx" \
        "merchant-admin/src/app/(dashboard)/settlements/account/account-form.tsx" \
        merchant-admin/src/app/api/merchant/payout-account/route.ts \
        merchant-admin/test/app/api/payout-account-route.test.ts
git commit -m "feat: 商家收款账户——设置与脱敏展示"
```

---

## Task 6：平台的出款审批端点与页面

**Files:**
- Create: `api/src/modules/billing/platform-payout.controller.ts`
- Create: `platform-admin/src/lib/payout.ts`
- Create: `platform-admin/src/app/(dashboard)/payouts/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx`
- Create: `platform-admin/src/app/api/billing/payouts/route.ts`
- Create: `platform-admin/src/app/api/billing/payouts/[id]/approve/route.ts`
- Create: `platform-admin/src/app/api/billing/payouts/[id]/reject/route.ts`
- Create: `platform-admin/test/app/payouts-page.test.tsx`
- Create: `platform-admin/test/app/payout-detail-page.test.tsx`
- Create: `platform-admin/test/components/payout-actions.test.tsx`

⚠️ **platform-admin 有 `Table` 组件与 `test/helpers/page-tree.ts`**（5g 建的）→ 直接用，
不用像 merchant-admin 那样从零搭。

- [ ] **Step 1：写平台侧端点**

Create `api/src/modules/billing/platform-payout.controller.ts`：

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { toIntOr } from '../../common/http/pagination';
import { PayoutService } from './payout.service';
import { PayoutDecisionDto } from './dto/payout-decision.dto';
import { PayoutListQueryDto } from './dto/payout-list-query.dto';

/**
 * 平台侧的出款审批接口。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：审批出款 = 决定把哪笔钱打给谁，
 * 商家账号调这些接口要 403（护栏 P10）。
 * ⚠️ **不用再加 `@UseGuards(JwtAuthGuard)`**：`@Roles` 装饰器**自带**
 * `JwtAuthGuard`（未登录得 401）—— 5g 的 `platform-settlement.controller.ts`
 * 就是这么写的，别多挂一层。
 */
@ApiTags('platform-payouts')
@Controller('platform')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Get('payouts')
  @ApiOperation({ summary: '出款单列表（跨商家）' })
  async list(@Query() query: PayoutListQueryDto) {
    return this.payouts.listForPlatform({
      status: query.status,
      period: query.period,
      page: toIntOr(query.page, undefined),
      pageSize: toIntOr(query.pageSize, undefined),
    });
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: '出款单详情' })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.detailForPlatform(id);
  }

  @Post('payouts/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '审批通过（重算并锁定金额）' })
  async approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.approve(id);
  }

  @Post('payouts/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '审批拒绝（必须给原因）' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayoutDecisionDto,
  ) {
    return this.payouts.reject(id, dto.reason ?? '');
  }
}
```

- [ ] **Step 2：⚠️ 不改 `billing.module.ts`（见 §0.5）**

⚠️ **本 Task 不碰 `billing.module.ts`** —— `PayoutService` 与
`PlatformPayoutController` 的注册**统一放在 Task 8 的 Step 0**
（理由见 §0.5：5 个 Task 都要改这个文件，并行代理改同一个文件必然冲突）。

⚠️ **所以本 Task 不要验证「应用能启动」**（缺 provider 会启动失败）。
本 Task 的验证是 **tsc + eslint + service 单测**（手写假 Prisma，不碰数据库）✅

- [ ] **Step 3：写平台侧的类型文件**

Create `platform-admin/src/lib/payout.ts` —— 内容与 `merchant-admin/src/lib/payout.ts` **同款**，
再额外加平台视角的字段：

```ts
export interface PlatformPayoutItem extends PayoutItem {
  tenantId: string;
  tenantName: string;
  subdomain: string;
}
```

⚠️ **别只写一半**：商家侧与平台侧的类型必须一致，否则平台页面拿不到商家名。

- [ ] **Step 4：写平台侧的列表页**

Create `platform-admin/src/app/(dashboard)/payouts/page.tsx` —— 照抄 5g 的
`settlements/page.tsx` 的结构（`Table` 组件、`pageSize=200`、周期筛选）：

```tsx
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { describePayoutStatus } from '@/lib/payout';
import type { PlatformPayoutItem } from '@/lib/payout';

/**
 * 平台侧的出款单列表页（Server Component）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 * 就是第二套口径，迟早漂。
 */
interface PayoutListResult {
  items: PlatformPayoutItem[];
  total: number;
}

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;

  let data: PayoutListResult | null = null;
  let error: string | null = null;

  try {
    const params = new URLSearchParams();
    if (period) {
      params.set('period', period);
    }
    params.set('pageSize', '200');
    data = await apiFetchAuthed<PayoutListResult>(
      `/platform/payouts?${params.toString()}`,
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载出款单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">出款</h2>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <>
          <p className="text-xs text-muted-foreground">共 {data.total} 张出款单</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>商家</TableHead>
                <TableHead>周期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>货款净额</TableHead>
                <TableHead>佣金</TableHead>
                <TableHead>应结金额</TableHead>
                <TableHead>笔数</TableHead>
                <TableHead>单号</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    暂无出款单。
                  </TableCell>
                </TableRow>
              ) : (
                data.items.map((payout) => (
                  <TableRow key={payout.id}>
                    <TableCell className="font-medium">{payout.tenantName}</TableCell>
                    <TableCell>{payout.periodLabel}</TableCell>
                    <TableCell>{describePayoutStatus(payout.status)}</TableCell>
                    <TableCell>¥{(payout.receiptAmount / 100).toFixed(2)}</TableCell>
                    <TableCell>¥{(payout.commissionAmount / 100).toFixed(2)}</TableCell>
                    <TableCell>¥{(payout.netAmount / 100).toFixed(2)}</TableCell>
                    <TableCell>{payout.entryCount}</TableCell>
                    <TableCell>{payout.payoutNo}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
```

⚠️ **列表页不直接链到详情页**：出款单的 id 是 UUID，5g 的结算单详情页是
`/settlements/[id]`。这里**要**链（超管要能点进去审批）→
在「商家」那格里包一层 `<Link href={`/payouts/${payout.id}`}>`。

- [ ] **Step 5：写平台侧的详情页与操作组件**

Create `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describePayoutStatus } from '@/lib/payout';
import type { PayoutStatus } from '@/lib/payout';

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
 * 出款单的审批操作。
 *
 * ⚠️ **只有「待审批」才显示按钮**：已审批的不能再批、已拒绝的不能改主意
 * （商家要重新申请）。已出款 / 出款失败在 5h-1 不可达。
 *
 * ⚠️ **拒绝必须填原因**：没有原因的拒绝对商家毫无意义 ——
 * 商家不知道该改什么，只能打电话问客服。
 */
export function PayoutActions({
  payoutId,
  status,
  requestedAmount,
}: {
  payoutId: string;
  status: PayoutStatus;
  /** 申请时的预估金额（审批时会重算 → 两者可能不同） */
  requestedAmount: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function run(action: 'approve' | 'reject') {
    // ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
    // 连点两次会一起通过检查发出两次请求。
    if (busyRef.current) return;

    if (action === 'reject') {
      const trimmed = reason.trim();
      if (!trimmed) {
        setFailure('拒绝出款必须填写原因');
        return;
      }
      if (
        !confirm(
          `确定拒绝这张出款单？\n拒绝原因：${trimmed}\n` +
            '商家可以重新申请同一周期。',
        )
      ) {
        return;
      }
    } else {
      if (
        !confirm(
          '确定通过这张出款单？\n' +
            '通过时平台会**重算一次金额并锁定**，之后不再随流水变化。',
        )
      ) {
        return;
      }
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);

    try {
      const response = await fetch(`/api/billing/payouts/${payoutId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({ reason: reason.trim() }) : undefined,
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      // ⚠️ **成功后必须 router.refresh()**：详情与列表是服务端渲染的，
      // 不刷新就看不到新状态。
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

  if (status !== 'REQUESTED') {
    return (
      <p className="text-sm text-muted-foreground">
        该出款单当前是「{describePayoutStatus(status)}」，没有可执行的审批操作。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="reject-reason" className="text-sm">
          拒绝原因（拒绝时必填）
        </label>
        <Input
          id="reject-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={200}
          placeholder="例如：该期结算单尚未确认"
        />
      </div>

      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={() => run('approve')}>
          {busy ? '处理中…' : '通过'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => run('reject')}
        >
          拒绝
        </Button>
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

Create `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`：

```tsx
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { describePayoutStatus } from '@/lib/payout';
import type { PlatformPayoutItem } from '@/lib/payout';
import { PayoutActions } from '../payout-actions';

/**
 * 平台侧的出款单详情页（Server Component）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 * 就是第二套口径，迟早漂。
 */
interface PayoutDetail extends PlatformPayoutItem {
  periodStart: string;
  periodEnd: string;
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
  }>;
}

export default async function PayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15 起 params 是 Promise，必须 await。
  const { id } = await params;

  let payout: PayoutDetail | null = null;
  let error: string | null = null;

  try {
    payout = await apiFetchAuthed<PayoutDetail>(`/platform/payouts/${id}`);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载出款单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">出款详情</h2>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!payout) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">出款详情</h2>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          {payout.tenantName}（{payout.subdomain}） · {payout.periodLabel}
        </p>
        <p>
          单号 {payout.payoutNo} · {describePayoutStatus(payout.status)}
        </p>
        <p>
          货款净额 ¥{(payout.receiptAmount / 100).toFixed(2)} · 平台佣金 ¥
          {(payout.commissionAmount / 100).toFixed(2)} · 应结金额 ¥
          {(payout.netAmount / 100).toFixed(2)} · {payout.entryCount} 笔
        </p>
        {payout.requestedAmount !== payout.netAmount && (
          <p className="text-muted-foreground">
            ⚠️ 商家申请时看到的是 ¥
            {(payout.requestedAmount / 100).toFixed(2)}，与当前金额不同 ——
            审批时会以**重算后的金额**为准。
          </p>
        )}
        {payout.rejectedReason && (
          <p className="text-destructive">拒绝原因：{payout.rejectedReason}</p>
        )}
      </div>

      <PayoutActions
        payoutId={payout.id}
        status={payout.status}
        requestedAmount={payout.requestedAmount}
      />

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">出款明细</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>订单号</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>金额</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payout.entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  暂无明细。
                </TableCell>
              </TableRow>
            ) : (
              payout.entries.map((entry) => (
                <TableRow key={entry.entryId}>
                  <TableCell>
                    {new Date(entry.occurredAt).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell>{entry.orderNo}</TableCell>
                  <TableCell>
                    {entry.type === 'SALE' ? '货款' : '货款冲回'}
                  </TableCell>
                  <TableCell>
                    ¥{(entry.amount / 100).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

⚠️ **`notFound()` 会抛异常**（`NEXT_HTTP_ERROR_FALLBACK;404`）→
后面的 `if (error)` 不会执行 —— 顺序不能颠倒。

⚠️ **`describePayoutStatus` 与「状态中文」的断言**：页面显示中文，
**不能**出现裸枚举 `REQUESTED` → 前端测试要断言这一点。

- [ ] **Step 6：写平台侧的中转路由**

Create `platform-admin/src/app/api/billing/payouts/route.ts` 与
`[id]/approve/route.ts`、`[id]/reject/route.ts` —— 照抄 5g 的
`platform-admin/src/app/api/billing/settlements/**`。

⚠️ `reject` 的中转路由要**白名单重建** body（只传 `reason`），
且 `reason` 为空时 → 400 且不调后端。

- [ ] **Step 7：写平台侧的前端测试**

Create `platform-admin/test/app/payouts-page.test.tsx`、
`platform-admin/test/app/payout-detail-page.test.tsx`、
`platform-admin/test/components/payout-actions.test.tsx` —— 照抄 5g 的三个对应文件。

⚠️ **照抄时要改的**：
- mock 的模块路径与类型换成出款的
- `describePayoutStatus` 断言「待审批」「已审批」等中文，**且断言不含裸枚举**
  （`hasText(texts, 'REQUESTED')` 必须为 false）
- ⚠️ **列表页的路径断言用精确匹配**：`expect(path).toBe('/platform/payouts?pageSize=200')`
- ⚠️ **金额断言要能区分三个数**：货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥2.00 ——
  用**不同的数值**，否则断言分不清是哪个字段

- [ ] **Step 8：跑测试**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin"
npx vitest run test/app/payouts-page.test.tsx test/app/payout-detail-page.test.tsx test/components/payout-actions.test.tsx
```

Expected: 全绿 ✅

- [ ] **Step 9：api 侧校验 + 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit && npx eslint src/modules/billing/
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/platform-payout.controller.ts \
        platform-admin/src/lib/payout.ts platform-admin/src/app/\(dashboard\)/payouts/ \
        platform-admin/src/app/api/billing/payouts/ platform-admin/test/
git commit -m "feat: 平台侧的出款审批——列表、详情、通过与拒绝"
```

---

## Task 7：商家侧的申请与查询

**Files:**
- Create: `api/src/modules/billing/merchant-payout.controller.ts`
- Modify: `merchant-admin/src/app/(dashboard)/layout.tsx`（导航加「出款」）
- Create: `merchant-admin/src/app/(dashboard)/settlements/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/settlements/apply/apply-form.tsx`
- Create: `merchant-admin/src/app/api/merchant/payouts/route.ts`
- Create: `merchant-admin/src/app/api/merchant/payouts/[id]/route.ts`（DELETE = 撤回）
- Create: `merchant-admin/src/app/api/merchant/payouts/available-periods/route.ts`
- Create: `merchant-admin/test/helpers/page-tree.ts`（**从 platform-admin 复制**）
- Create: `merchant-admin/test/app/payouts-page.test.tsx`
- Create: `merchant-admin/test/app/payout-apply-page.test.tsx`

⚠️ **merchant-admin 没有页面级测试的先例**（`test/app/` 下只有 `api/`）→
本 Task 要**先建 `test/helpers/page-tree.ts`**（照抄 platform-admin 的同名文件）。

⚠️ **merchant-admin 没有 `Table` 组件** → 页面用**裸 `<table>`**（照抄
`merchant-admin/src/components/order/order-list.tsx` 的写法）。

- [ ] **Step 1：写商家侧端点**

Create `api/src/modules/billing/merchant-payout.controller.ts`：

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { toIntOr } from '../../common/http/pagination';
import { PayoutService } from './payout.service';
import { ApplyPayoutDto } from './dto/apply-payout.dto';
import { PayoutListQueryDto } from './dto/payout-list-query.dto';

/**
 * 商家侧的出款接口。
 *
 * ⚠️ **只有 `MERCHANT_OWNER` 能申请/撤回**：出款是打钱，
 * 员工点了不该能把公司的钱打出去（护栏 P10）。
 *
 * ⚠️ **路由顺序**：NestJS 按注册顺序匹配 →
 * `available-periods` 这条**静态路径必须声明在 `:id` 之前**，
 * 否则会被 `:id` 吃掉（`ParseUUIDPipe` 收到 "available-periods" → 400）。
 */
@ApiTags('merchant-payouts')
@Controller('merchant/payouts')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Get('available-periods')
  @ApiOperation({ summary: '可申请的周期与各自的应结金额' })
  async availablePeriods() {
    return this.payouts.availablePeriods();
  }

  @Get()
  @ApiOperation({ summary: '我的出款单列表' })
  async list(@Query() query: PayoutListQueryDto) {
    return this.payouts.listForTenant({
      status: query.status,
      period: query.period,
      page: toIntOr(query.page, undefined),
      pageSize: toIntOr(query.pageSize, undefined),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '出款单详情' })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.detailForTenant(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '申请出款（指定自然月）' })
  async apply(@Body() dto: ApplyPayoutDto) {
    return this.payouts.apply({ period: dto.period });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '撤回申请（仅待审批可撤）' })
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.cancel(id);
  }
}
```

- [ ] **Step 2：⚠️ 不改 `billing.module.ts`（见 §0.5）**

⚠️ **本 Task 不碰 `billing.module.ts`** —— `MerchantPayoutController` 的注册
**统一放在 Task 8 的 Step 0**（理由见 §0.5）。

⚠️ **所以本 Task 不要验证「应用能启动」**（缺 provider 会启动失败）。
本 Task 的验证是 **tsc + eslint + 前端单测** ✅

- [ ] **Step 3：写商家侧的申请页与表单**

Create `merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx`：

```tsx
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type { AvailablePeriod } from '@/lib/payout';
import { PayoutApplyForm } from './apply-form';

/**
 * 商家侧的「申请出款」页（Server Component）。
 *
 * ⚠️ **金额全部由后端算**：这里只把后端给的「可申请周期 + 应结金额」
 * 传给表单，商家选周期 → 提交。商家**不能**自己填金额。
 */
export default async function PayoutApplyPage() {
  let periods: AvailablePeriod[] = [];
  let error: string | null = null;

  try {
    periods = await apiFetchAuthed<AvailablePeriod[]>(
      '/merchant/payouts/available-periods',
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载可申请周期失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '可申请周期加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">申请出款</h2>
      <p className="text-sm text-muted-foreground">
        选一个自然月提交申请。金额由平台按「货款 − 平台佣金」算好，
        审批时还会再算一次并锁定。
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <PayoutApplyForm periods={periods} />
    </div>
  );
}
```

Create `merchant-admin/src/app/(dashboard)/settlements/apply/apply-form.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import type { AvailablePeriod } from '@/lib/payout';

/**
 * 申请出款的表单。
 *
 * ⚠️ **周期用裸 `<select>`**：merchant-admin 没有 select 组件，
 * 而且 `type="month"` 的 input 在自动化测试里会被 jsdom 清洗成空串
 * （5g 的教训：非法周期那条用例根本没测到月份上界分支）。
 * 这里用 `<select>` 列可申请周期 —— 商家能选的只有后端给的那几个。
 */
export function PayoutApplyForm({ periods }: { periods: AvailablePeriod[] }) {
  const router = useRouter();
  const [period, setPeriod] = useState(periods[0]?.period ?? '');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const selected = periods.find((item) => item.period === period);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
    // 连点两次会一起通过检查发出两次请求（5g 的同款教训）。
    if (busyRef.current) return;

    if (!period) {
      setError('没有可申请的周期');
      return;
    }

    busyRef.current = true;
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      const response = await fetch('/api/merchant/payouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⚠️ **请求体里只有周期**：金额是后端算的，
        // 客户端多传一个 `amount` 也到不了后端（中转路由白名单重建）。
        body: JSON.stringify({ period }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new ApiError(
          response.status,
          'UNKNOWN',
          payload.message ?? '申请失败',
        );
      }

      setSuccess('申请已提交，等待平台审批');
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `申请失败（${cause.status}）：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : '申请失败',
      );
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>选择周期</CardTitle>
        <CardDescription>
          只有已结束、且有应结金额的周期才能申请。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {periods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无可申请的周期。
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="period">结算周期</Label>
              <select
                id="period"
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
              >
                {periods.map((item) => (
                  <option key={item.period} value={item.period}>
                    {item.period}（应结 ¥{(item.netAmount / 100).toFixed(2)}）
                    {item.alreadyApplied ? ' · 已申请' : ''}
                  </option>
                ))}
              </select>
            </div>

            {selected && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>
                  货款净额 ¥{(selected.receiptAmount / 100).toFixed(2)} ·
                  平台佣金 ¥{(selected.commissionAmount / 100).toFixed(2)} ·
                  应结 ¥{(selected.netAmount / 100).toFixed(2)}
                </p>
                <p>共 {selected.entryCount} 笔货款</p>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-primary">{success}</p>}

            <div className="flex justify-end">
              <Button type="submit" disabled={pending || !period}>
                {pending ? '提交中…' : '提交申请'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4：写商家侧的列表页、详情页与撤回按钮**

Create `merchant-admin/src/app/(dashboard)/settlements/page.tsx`：

```tsx
import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { describePayoutStatus } from '@/lib/payout';
import type { PayoutItem } from '@/lib/payout';

/**
 * 商家侧的「我的出款单」列表页（Server Component）。
 *
 * ⚠️ **merchant-admin 没有 `Table` 组件** → 用裸 `<table>`
 * （照抄 `merchant-admin/src/components/order/order-list.tsx` 的写法）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 * 就是第二套口径，迟早漂。
 */
interface PayoutListResult {
  items: PayoutItem[];
  total: number;
}

export default async function PayoutsPage() {
  let data: PayoutListResult | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<PayoutListResult>('/merchant/payouts');
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载出款单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">出款</h2>
      <p className="text-sm text-muted-foreground">
        平台按「货款 − 平台佣金」算出你这一期该拿多少钱。申请提交后由平台审批，
        审批时会再算一次并锁定金额。
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            共 {data.total} 张出款单
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th>周期</th>
                <th>状态</th>
                <th>货款净额</th>
                <th>平台佣金</th>
                <th>应结金额</th>
                <th>笔数</th>
                <th>单号</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 text-muted-foreground">
                    暂无出款单。
                  </td>
                </tr>
              ) : (
                data.items.map((payout) => (
                  <tr key={payout.id} className="border-b">
                    <td>
                      <Link
                        href={`/settlements/${payout.id}`}
                        className="underline"
                      >
                        {payout.periodLabel}
                      </Link>
                    </td>
                    <td>{describePayoutStatus(payout.status)}</td>
                    <td>¥{(payout.receiptAmount / 100).toFixed(2)}</td>
                    <td>¥{(payout.commissionAmount / 100).toFixed(2)}</td>
                    <td>¥{(payout.netAmount / 100).toFixed(2)}</td>
                    <td>{payout.entryCount}</td>
                    <td>{payout.payoutNo}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

Create `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx`：

```tsx
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { describePayoutStatus } from '@/lib/payout';
import type { PayoutDetail } from '@/lib/payout';
import { PayoutCancelButton } from '../payout-cancel-button';

/**
 * 商家侧的出款单详情页（Server Component）。
 */
export default async function PayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15 起 params 是 Promise，必须 await。
  const { id } = await params;

  let payout: PayoutDetail | null = null;
  let error: string | null = null;

  try {
    payout = await apiFetchAuthed<PayoutDetail>(`/merchant/payouts/${id}`);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载出款单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">出款详情</h2>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!payout) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">出款详情</h2>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          {payout.periodLabel} · 单号 {payout.payoutNo} ·{' '}
          {describePayoutStatus(payout.status)}
        </p>
        <p>
          货款净额 ¥{(payout.receiptAmount / 100).toFixed(2)} · 平台佣金 ¥
          {(payout.commissionAmount / 100).toFixed(2)} · 应结金额 ¥
          {(payout.netAmount / 100).toFixed(2)} · {payout.entryCount} 笔
        </p>
        {payout.rejectedReason && (
          <p className="text-destructive">拒绝原因：{payout.rejectedReason}</p>
        )}
      </div>

      <PayoutCancelButton payoutId={payout.id} status={payout.status} />

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">出款明细</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>时间</th>
              <th>订单号</th>
              <th>类型</th>
              <th>金额</th>
            </tr>
          </thead>
          <tbody>
            {payout.entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-muted-foreground">
                  暂无明细。
                </td>
              </tr>
            ) : (
              payout.entries.map((entry) => (
                <tr key={entry.entryId} className="border-b">
                  <td>{new Date(entry.occurredAt).toLocaleString('zh-CN')}</td>
                  <td>{entry.orderNo}</td>
                  <td>{entry.type === 'SALE' ? '货款' : '货款冲回'}</td>
                  <td>¥{(entry.amount / 100).toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

Create `merchant-admin/src/app/(dashboard)/settlements/payout-cancel-button.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { describePayoutStatus } from '@/lib/payout';
import type { PayoutStatus } from '@/lib/payout';

/**
 * 撤回出款申请的按钮。
 *
 * ⚠️ **只有「待审批」可撤**：已审批的金额已经锁定，撤回要走平台。
 */
export function PayoutCancelButton({
  payoutId,
  status,
}: {
  payoutId: string;
  status: PayoutStatus;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  if (status !== 'REQUESTED') {
    return null;
  }

  async function handleCancel() {
    if (busyRef.current) return;
    if (!confirm('确定撤回这张出款申请？撤回后可以重新申请同一周期。')) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);

    try {
      const response = await fetch(`/api/merchant/payouts/${payoutId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '撤回失败');
      }
      router.refresh();
    } catch (cause) {
      setFailure(
        `撤回失败：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={handleCancel}
        >
          {busy ? '撤回中…' : '撤回申请'}
        </Button>
        <span className="text-xs text-muted-foreground">
          当前状态：{describePayoutStatus(status)}
        </span>
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

- [ ] **Step 5：写商家侧的中转路由**

Create 三个中转路由：
- `merchant-admin/src/app/api/merchant/payouts/route.ts` —— GET（列表）/ POST（申请）
- `merchant-admin/src/app/api/merchant/payouts/[id]/route.ts` —— DELETE（撤回）
- `merchant-admin/src/app/api/merchant/payouts/available-periods/route.ts` —— GET

⚠️ POST 的 body **白名单重建**：只传 `{ period }`。
⚠️ ⚠️ **Next.js 的路由冲突**：`available-periods/route.ts` 与 `[id]/route.ts` ——
Next.js 里静态段优先于动态段 ✓ 不冲突（与 NestJS 的顺序要求不同）。

- [ ] **Step 6：导航加「出款」入口**

Modify `merchant-admin/src/app/(dashboard)/layout.tsx` —— 在
`<Link href="/billing">订阅</Link>` 之后加：

```tsx
            <Link href="/settlements" className="underline-offset-4 hover:underline">
              出款
            </Link>
```

- [ ] **Step 7：复制 `page-tree` helper**

```bash
cp "/Users/tom/orca/workspaces/电商项目/电商项目/platform-admin/test/helpers/page-tree.ts" \
   "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin/test/helpers/page-tree.ts"
```

⚠️ **复制后要检查 import 路径**：platform-admin 的 `page-tree.ts` 里
`import { ... } from 'react'` 是相对安全的 ✓ 但如果它 import 了别的东西要改。

⚠️ **不要在 helper 里写 platform-admin 特有的东西** —— 它应该是纯 React 工具。

- [ ] **Step 8：写商家侧的前端测试**

Create `merchant-admin/test/app/payouts-page.test.tsx` 与
`merchant-admin/test/app/payout-apply-page.test.tsx` —— 照抄 platform-admin 的
`settlements-page.test.tsx` 的结构。

⚠️ **照抄时要改的**：
- ⚠️ **商家侧的 `apiFetchAuthed` mock 路径一样**（`@/lib/api-client`）✓
- ⚠️ **`vi.mock('@/auth', ...)` 一样要 mock**（next-auth → next/server 在 node 环境解析失败）
- ⚠️ **商家侧的接口路径是 `/merchant/payouts`**，不是 `/platform/payouts`
- ⚠️ **金额断言用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥2.00）——
  数值相同就分不清是哪个字段
- ⚠️ **状态断言**：显示「待审批」且**不含裸枚举** `REQUESTED`

- [ ] **Step 9：跑测试**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin"
npx vitest run test/app/payouts-page.test.tsx test/app/payout-apply-page.test.tsx
```

Expected: 全绿 ✅

- [ ] **Step 10：全量校验 + 提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin"
npx vitest run && npx tsc --noEmit && npx eslint src/ test/
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit && npx eslint src/ test/
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/billing/merchant-payout.controller.ts \
        "merchant-admin/src/app/(dashboard)/settlements/page.tsx" \
        "merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx" \
        "merchant-admin/src/app/(dashboard)/settlements/[id]/payout-cancel-button.tsx" \
        "merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx" \
        "merchant-admin/src/app/(dashboard)/settlements/apply/apply-form.tsx" \
        "merchant-admin/src/app/(dashboard)/layout.tsx" \
        merchant-admin/src/app/api/merchant/payouts/ \
        merchant-admin/test/helpers/page-tree.ts merchant-admin/test/app/
git commit -m "feat: 商家侧的出款申请与查询"
```

---

## Task 8：e2e（护栏 P1–P10）与验收

**Files:**
- Create: `api/test/payout.e2e-spec.ts`
- Create: `docs/superpowers/plans/2026-10-29-plan-05h-payout-ledger-acceptance.md`

- [ ] **Step 0：⚠️ 把各 Task 的 provider / controller 统一注册进 `BillingModule`**

Modify `api/src/modules/billing/billing.module.ts` —— **一次性**把下面这些加进去
（前面各 Task 都刻意没碰这个文件，见 §0.5）：

| 类型 | 名字 | 来自 |
|------|------|------|
| provider | `PayoutService` | Task 3 |
| provider | `PayoutAccountService` | Task 5 |
| controller | `PlatformPayoutController` | Task 6 |
| controller | `MerchantPayoutController` | Task 7 |
| controller | `MerchantPayoutAccountController` | Task 5 |

⚠️ **`ReceiptService` 已经在 Task 2 注册过了** —— 别重复加。

⚠️ **纯追加**：不改既有行。`exports` 里**不用**加这些（只有 `ReceiptService` 需要导出，
因为 `PaymentModule` 要用它）。

⚠️ **注册完必须验证应用能起得来**（这是全阶段唯一一次验证）：
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit && npx eslint src/
```
⚠️ `tsc` 只查类型，**查不出 Nest 的依赖注入图** → 真正要靠 Task 8 的 e2e
（它会起真实的 Nest 应用）来验证装配对不对。

- [ ] **Step 1：写 e2e 的夹具**

`api/test/payout.e2e-spec.ts` 的夹具要能造出「某商家某期有货款流水 + 有结算单」：

```ts
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
        orderNo: `PAY-ORD-${unique()}`,
        type: options.type,
        amount: options.amount,
        occurredAt: options.occurredAt,
      },
    }),
  );
  return created.id;
}
```

⚠️ **`merchant_receipts.orderId` 有外键 `Restrict`** → 必须先造订单（用 5g e2e 里既有的
`seedOrder` helper，它在 `settlement.e2e-spec.ts` 里 → **复制过来**）。

⚠️ **结算单也要造**：出款引用结算单，所以 e2e 要先走一遍
`POST /platform/settlements` 生成并确认结算单。

- [ ] **Step 2：写护栏用例**

| 用例 | 护栏 | 断言 |
|------|------|------|
| 申请 → 金额 = 货款净额 − 佣金净额 | P4 / D4 | `netAmount === receiptAmount − commissionAmount`；**请求体带 `amount` 字段不影响结果** |
| 申请 → 重复申请同一周期 → **幂等返回同一张** | P1 | 两次 `id` 相同；库里只有 1 张活跃单 |
| 申请 → 该期已有**被拒绝**的单 → 能重新申请 | P1 / D9 | 成功；库里 2 张（1 张 REJECTED + 1 张 REQUESTED） |
| ⚠️ **申请 → 该期已有被拒绝的单 → 能重新申请**（真链路） | P1 / D9 / **E11** | **走完整三步**：申请 → 平台拒绝 → 商家再申请 → 成功。⚠️ **单测测不了这条**（假 Prisma 是配置驱动的，造不出状态机）—— 而它正是「拒绝后不释放明细占用 → 重新申请撞唯一索引 → 500」的触发路径，**必须真跑一遍** |
| ⚠️ **申请 → 该期已有已撤回的单 → 能重新申请**（真链路） | P1 / **E20** | 同上三步，撤回代替拒绝 |
| 申请 → 结算单未 CONFIRMED → 409 | P3 | 409；且**没建任何单** |
| 申请 → 周期未结束 → 400 | 周期校验 | 400；没建单 |
| 申请 → 应结 ≤ 0 → 400 | 边界 | 400 |
| 申请 → 固定纳入的流水 | D7 | `payout_entries` 里的 `entryId` 恰是当期那几笔 |
| 审批 → 重算金额（申请后流水变了） | P5 | 落库的 `netAmount` 是**重算值**；`requestedAmount` 保留旧值 |
| 审批 → 已审批的单再审批 → 409 | P7 | 409 |
| 审批 → 拒绝必须带原因 | 边界 | 缺原因 → 400 |
| 撤回 → 已审批的单 → 409 | P7 | 409；状态不变 |
| 撤回 → 被引用的结算单不能取消确认 | P6 | 409（这条在 `settlement.e2e-spec.ts` 里，见 Task 4） |
| 明细归属 → 商家 A 访问商家 B 的单 → 404 | P9 | 404 |
| 角色 → 员工申请出款 → 403 | P10 | 403 |
| 角色 → 商家调平台审批端点 → 403 | P10 | 403 |
| 未登录 → 401 | P10 | 401 |
| **P2**：同一笔货款被两张开款单关联 → P2002 | P2 | 直接插第二条 `payout_entry` → 断言 DB 抛 P2002 |

- [ ] **Step 3：跑 e2e**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- payout
```

Expected: 全绿 ✅

⚠️ **确认没改坏 5g 的 e2e**：
```bash
npm run test:e2e -- settlement
```

- [ ] **Step 4：容器化验证**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
docker compose -f infra/docker-compose.yml up -d --build api
docker compose -f infra/docker-compose.yml ps api
curl -s http://localhost:3000/api/v1/health
```

Expected: api `Up (healthy)`；`{"status":"ok",...}`。

⚠️ **探活路径带 `api/v1` 前缀** —— 应用设了 `setGlobalPrefix('api/v1')`，
`/health` 会返回 404。

⚠️ **确认容器里的产物路径仍是 `dist/main.js`**：
```bash
docker exec ecommerce-api ls /app/dist/main.js
```

- [ ] **Step 5：浏览器手测**

用 `ego-browser`（已常驻，不抢前台）。手测数据在**生产库**造、用完**清理干净**。

⚠️ **造数据用 SQL 直接插 `merchant_receipts`**（不用真实支付链路 ——
那要起假网关、造订单、造支付单，太重）。但要顺带验一次**真实支付链路**
（走假网关下单支付 → 确认 `merchant_receipts` 里有一行）。

手测清单：

1. 商家登录 merchant-admin → 「出款」→「收款账户」→ 填账户 → 保存 → 看到脱敏账号
2. 商家「申请出款」→ 看到可申请周期与应结金额 → 提交 → 「我的出款单」里出现「待审批」
3. 重复申请同一周期 → **不报错**，还是同一张单（幂等）
4. 平台登录 platform-admin → 「出款」→ 看到该单 → 详情 → 「通过」→ 状态变「已审批」
5. 商家侧看到「已审批」；再点「撤回」→ 409 提示
6. 另一张单：商家「撤回」→ 「已撤回」；平台对已撤回的单审批 → 409
7. 另一张单：平台「拒绝」（填原因）→「已拒绝」→ 商家**重新申请同一周期** → 成功
8. 商家 A 访问商家 B 的出款单 → 404/403
9. 员工账号申请出款 → 403
10. 真实支付链路：走假网关支付一笔订单 → 确认 `merchant_receipts` 里多了一行 SALE

⚠️ **手测完清理**：造出来的数据按标记前缀删掉，**先删明细关联再删单据**。

- [ ] **Step 6：失败注入 F1–F10（逐条单独跑，不叠加）**

| # | 注入 | 期望挂掉 |
|---|------|---------|
| F1 | 申请时去掉「周期已结束」校验 | 周期校验用例 |
| F2 | DTO 接受金额字段（后端采信前端金额） | P4 用例 |
| F3 | 审批时不重算（直接用申请时的金额） | P5 用例 |
| F4 | 去掉「结算单已 CONFIRMED」校验 | P3 用例 |
| F5 | 5g 的 `unconfirm` 去掉「已被出款单引用」的闸 | P6 用例（在 `settlement.e2e-spec.ts` 里） |
| F6 | 申请去掉「先查后插」的幂等分支 | P1 用例 |
| F7 | 审批/撤回的条件更新去掉 `status` | P7 用例 |
| F8 | 商家端点去掉 `@Roles(MERCHANT_OWNER)` | P10 用例 |
| F9 | 商家端点不校验归属 | P9 用例 |
| F10 | 审批之后仍能改金额 | P8 用例 |

⚠️ **逐条单独跑**（5c / 5f / 5g 的同一课）：叠加时 A 的代码可能根本没机会执行。

⚠️ **恢复用 `git checkout -- <file>`** —— 目标文件必须**已提交**
（本阶段每个 Task 都提交了 ✅）。

⚠️ **「挂 0 条」时先问「测试数据有没有落在那个形状上」**（5g 的教训）：
挂 0 条通常是**测试没覆盖到那个形状**，不是「护栏不存在」。

- [ ] **Step 7：写验收记录**

Create `docs/superpowers/plans/2026-10-29-plan-05h-payout-ledger-acceptance.md`，
照 `docs/superpowers/plans/2026-10-28-plan-05g-acceptance.md` 的结构：

- 自动化测试结果（各数字的前后对比）
- 容器化验证
- 浏览器手测（**做了就写实际结果，没做就如实写没做 + 理由，不编造**）
- **护栏 P1–P10 逐条核对**（护栏 → 测试位置 → 期望 → 实测 → 结论）
- **失败注入 F1–F10 逐条单独复验**（每条挂了几条、挂了哪条）
- 发现并修复的缺陷
- 已知遗留项（含设计文档 §九 的 **L32–L40**）
- 交付物清单
- 下一阶段（5h-2）

- [ ] **Step 8：提交**

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/test/payout.e2e-spec.ts \
        docs/superpowers/plans/2026-10-29-plan-05h-payout-ledger-acceptance.md
git commit -m "test(api): 出款的 e2e——护栏 P1–P10" && \
git add docs/superpowers/plans/2026-10-29-plan-05h-payout-ledger-acceptance.md && \
git commit -m "docs: 阶段 5h-1 验收记录（护栏逐条 + 失败注入逐条单独复验）"
```

---

## 勘误表（实施期发现）

> 本节记录**实施过程中发现、本计划正文写错了或不够的地方**。
> 正文代码块保持原样（它是「当时的规格」），以本节为准。
> 先例见阶段 5g 的勘误表。

### 一、计划正文的错误（实施代理独立发现并修正）

| # | 位置 | 计划写的 | 实际应该是 | 怎么发现的 |
|---|------|---------|-----------|-----------|
| **E1** | Task 3 的 `computeAmounts` | 把「结算单未 `CONFIRMED` → 409」的检查放在 `computeAmounts` **里面** | 拆成 `assertStatementConfirmed`，**只在申请/审批两个动作上校验**；`computeAmounts` 只取数、不抛 | ⚠️ **规格审查发现的真缺陷**：商家端「可申请周期」列表（设计 §6.3 要求返回每个周期的**结算单状态**）会因为这个抛异常而**整个 409** —— 商家一期的结算单没确认，连别的能申请的周期都看不到。设计要求列表里带 `statementStatus`，恰恰说明未确认的周期**要出现在列表里** |
| **E2** | Task 3 的 `toView` 类型 | `Parameters<PayoutService['toView']>[0]` | 具名 `interface PayoutRow` 放文件顶部 | ⚠️ TypeScript 拒绝私有成员通过索引访问取类型（计划 Step 7 已预判这条可能要改，实施时确认成立） |
| **E3** | Task 3 的 DTO 断言 | `expect(Object.keys(dto)).toEqual([])` | `toEqual(['period'])` + 断言 `'amount' in dto === false` | ⚠️ tsconfig `target: ES2023` → `useDefineForClassFields` 默认 true → `period!: string` 是**实例自有属性**（值 undefined），`Object.keys` 拿到 `['period']`。护栏意图不变：把「DTO 没有金额属性」钉死 |
| **E4** | Task 3 的 `entriesOf` | `map` + 类型谓词 `.filter((e): e is PayoutEntryView => e !== null)` | `flatMap` | ⚠️ `PayoutEntryView.type` 声明为 `string`，而 `MerchantReceipt.type` 是 `ReceiptType` **枚举** → 类型谓词要求「断言的类型可赋给参数类型」，**枚举 → string 的方向不成立** → 编译报错 |
| **E5** | Task 4 | 只加 e2e 用例 | 还要给 5g 的 `settlement.service.spec.ts` 补**假 Prisma 的 `payout` 桩** + 一条单测 | ⚠️ **闸让 5g 的单测全挂**（`this.prisma.payout` 是 undefined）→ 实施代理只跑了 e2e 漏了这层。闸必须同时有单测（`REJECTED` 的出款单**不拦**取消确认） |
| **E6** | Task 3 的单测用例表 | 「手写 tenantId 会与租户作用域的自动过滤重复，且在平台作用域下反而**漏**过滤」 | 「扩展附的那份会**覆盖**手写的那份（`withMergedWhere` 是 `{...base, ...extra}`，`extra` = 扩展的）→ 手写既**不生效**也不构成漏洞，只是噪声。平台作用域下手写反而是**加严**（把本该跨租户的查询限死在一个租户），不会漏」 | ⚠️ **规格审查发现该表述与实现相反** —— 覆盖方向搞反了。已核实 `tenant-prisma.service.ts` 的 `withMergedWhere` 实现 |
| **E7** | Task 3 的商家侧查询 | 手写 `tenantId`（`apply` 的账户查询、`findActivePayout`、`availablePeriods` 的两处） | **去掉手写**，靠扩展自动附加 | ⚠️ 同 E6：手写的那份会被覆盖 → 纯粹是噪声，且**看起来像「这里自己保证了租户隔离」**，容易误导后来者。⚠️ **`computeAmounts` 里的必须保留** —— 它**同时**被平台侧的 `approve` 调用，那里扩展不附加过滤 |

### 二、计划的「Expected」数字（实施后修正）

| 位置 | 计划写的 | 实际 |
|------|---------|------|
| Task 3 Step 6 | 「PASS —— 全部通过」（没写条数） | **29 条**（25 条计划内 + 4 条实施期补的） |
| Task 4 Step 4 | 「PASS」（没写条数） | e2e **37 条**（5g 原 35 + 新增 2 条） |

### 三、实施期追加的护栏（计划没有的）

| # | 在哪 | 内容 |
|---|------|------|
| **E8** | Task 3 的 `approve` | 审批时**再查一次**结算单是否仍 `CONFIRMED`（护栏 P3）。⚠️ **在 5h-1 内这条其实走不到**：结算单从 `CONFIRMED` 回到 `DRAFT` 只有「取消确认」一条路，而它被护栏 P6 挡着（这张单已被出款单引用）。**保留是防御性的** —— P6 的语义若变化（5h-2 允许某些状态取消确认），这道检查立刻生效 |
| **E9** | Task 4 | 反面用例：`REJECTED` / `CANCELLED` 的出款单引用**不拦**取消确认。这道闸不能挡过头 —— 那两种状态没有打钱，不构成「钱已经出去了」的事实 |
| **E10** | Task 3 | `availablePeriods` 的两条用例（某期结算单未确认 → 该期**照常列出**并带 `statementStatus`；周期未结束 → **不列**）。计划完全没覆盖这个方法 |

### 四、代码质量审查发现的缺陷（实施期修掉）

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| **E11** | Task 3 的 `reject()` / `cancel()` | ⚠️ **拒绝 / 撤回后重新申请必然 500**：`payout_entries.entryId` 是**全局唯一索引**，而这两个操作只改状态、**从不清理 `payout_entries`** → 商家重新申请时 `createMany` 撞索引 → P2002 → 补查活跃单为空 → 原样重抛 → 500。而设计 D9 明确承诺「拒绝后商家可以重新申请同一周期」 | `reject()` / `cancel()` 改成**事务**：改状态 + `payoutEntry.deleteMany({ payoutId })` 一起做。被拒/撤回的单没打钱，它占着的货款流水本就该放回去 |
| **E12** | Task 3 的 `approve()` | 申请时有两道闸（`entryCount === 0` / `netAmount <= 0`），**审批重算后没有**。申请与审批之间流水可能变（退款冲回占优）→ 重算出负数 → 原样锁进 `APPROVED` → 5h-2 按这个负数给商家打款 | `approve()` 在 `updateMany` 前补同样的两道闸，抛 409 |
| **E13** | Task 3 的 `reject()` | ① 不返回 404（`approve` 有）——「单号写错了」与「单子已处理」是同一个 409，排查时无法区分；② 写了 `approvedBy` 却没写 `approvedAt` → 视图里出现「审批人 admin-a / 审批时间 null」的矛盾组合 | 补存在性查询（404）+ 补 `approvedAt` |
| **E14** | Task 4 的 `unconfirm` 方法头注释 | 注释写着「**本阶段不出款**，这条是给将来出款阶段留的闸」—— 但 5h-1 已经出款，Task 4 加的闸**正是**这道闸。注释说「本阶段不出款」而代码里有出款闸 → 后来维护者会据此判断闸不存在 | 改成指向新闸 |
| **E15** | Task 4 的 5g 单测桩 | 假 Prisma 的 `payout.findFirst` **无视 `where`** → 把生产代码里的 `statementId` 或 `status` 删掉，单测照样绿 → 闸的全部语义零覆盖 | 桩改成**按 `where` 过滤**（`statementId` 匹配 + 状态不在终态里），并补一条断言 `where` 形状的用例 |
| **E16** | Task 3 的 `PayoutRow` | 是 `Payout` 的**手工影子类型**（只少 `updatedAt`），代价是三处 `as never` 硬转，且模型加字段时影子类型**静默漂移** | 删掉影子类型，`toView(payout: Payout)`，三处 `as never` 换成显式的 null 判断 |
| **E17** | Task 3 的 `clampPaging` | 自造了一份分页夹取，与 `src/common/http/pagination.ts` 的 `clampPagination` 重复，且上限不一致（200 vs 100） | 改用 `clampPagination`；`PayoutListQueryDto` 的 `page` / `pageSize` 改成 `@Type(() => Number)` + `@IsInt()`（原先是 `string`，与服务层的 `number` 形参对不上） |
| **E18** | Task 3 的 `listForPlatform` | **N+1**：逐条 `toPlatformView` → 每条一次 `tenant.findFirst` → `pageSize` 上限 100 时是 101 次查询（5g 的 `toViews` 早就解决了这个问题） | 补 `toPlatformViews`：一次 `tenant.findMany({ where: { id: { in: ids } } })` |

### 五、留给 Task 8（e2e）的验证缺口

| # | 缺什么 | 为什么单测补不了 |
|---|-------|----------------|
| **E19** | **「拒绝 → 重新申请同一周期」的真实链路** | 假 Prisma 是**配置驱动**的（`findFirst` 返回固定的 `options.payout`），造不出「第一次查不到、拒绝之后查得到、重新申请成功」这个状态机。⚠️ **这正是 E11 那个 500 的触发路径**，必须在 e2e 里走一遍：申请 → 拒绝 → 再申请 → 成功且金额一致 |
| **E20** | **「撤回 → 重新申请同一周期」的真实链路** | 同上 |
| **E21** | **商家 A 访问商家 B 的出款单 → 404** | 单测里假 Prisma 不按 `where` 过滤，跨租户行为只能靠真实 Prisma 验 |

---

## 附：护栏与失败的对照速查

| 护栏 | 一句话 | 主要落在 |
|------|--------|---------|
| P1 | 同一商家同一周期只有一张活跃出款单 | Task 3 + Task 8 |
| P2 | 一笔货款只能被出款一次 | Task 8（DB 约束） |
| P3 | 引用的结算单必须已 CONFIRMED | Task 3 + Task 8 |
| P4 | 金额全部由后端算 | Task 3 + Task 8 |
| P5 | 审批时重算金额 | Task 3 + Task 8 |
| P6 | 被出款单引用的结算单不能取消确认 | Task 4 + Task 8 |
| P7 | 状态机严格 + 条件更新 | Task 3 + Task 8 |
| P8 | APPROVED 后金额不可变 | Task 3 + Task 8 |
| P9 | 商家只能操作自己的数据 | Task 3 + Task 8 |
| P10 | 角色边界 | Task 6 + Task 7 + Task 8 |

| 失败 | 一句话 | 期望挂掉 |
|------|--------|---------|
| F1 | 去掉周期校验 | 周期用例 |
| F2 | DTO 接受金额 | P4 |
| F3 | 审批不重算 | P5 |
| F4 | 去掉结算单状态校验 | P3 |
| F5 | 去掉「已被出款单引用」的闸 | P6 |
| F6 | 去掉幂等分支 | P1 |
| F7 | 条件更新去掉 status | P7 |
| F8 | 去掉角色限制 | P10 |
| F9 | 不校验归属 | P9 |
| F10 | APPROVED 后还能改金额 | P8 |

---

## 附：实施期已知要改的地方（本计划写于设计定稿后，实施时若与代码现状不符，**以代码现状为准并在勘误表记录**）

1. ⚠️ **`BillingModule` 是否已 import `TenantPrismaModule`** —— 5g 的 `SettlementService`
   就在用 `TenantPrismaService`，应该已经 import 了 → 不必重复加。
2. ⚠️ **`PaymentModule` 是否已 import `BillingModule`** —— 5e 的抽佣流水走的是
   `PaymentService` → `CommissionService`，所以**应该已经有了** → 不必重复加。
   ⚠️ 若没有，`ReceiptService` 注入不进去 → Nest 启动直接失败。
3. ⚠️ **platform-admin 的 `ui` 目录有没有 `alert-dialog`** —— 5g 的拒绝确认用的是
   `confirm()`，没用 dialog → 「拒绝原因」的输入框可能要另想办法
   （条件渲染一个 `<input>` + 按钮）。
4. ⚠️ **`tenant-models.ts` 里 `TENANT_SCOPED_MODELS` 的实际写法** —— 5g 加了
   `SettlementStatement` 与 `SettlementStatementEntry`（后者**刻意不加**）→
   本阶段照抄那个注释风格。



