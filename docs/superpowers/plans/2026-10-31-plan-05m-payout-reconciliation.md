# 阶段 5m「渠道对账」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「钱到底打没打」有一个能落到账上的答案 —— 单笔实时核实 + 批量对账 + 让渠道的结论能落地（状态纠正 + 留痕）。

**Architecture:** 三层。① **渠道侧**：扩展 `PayoutProvider`（`queryPayout` 改签名 + 新增 `listPayouts`），本地假网关改为「存真实结果并如实返回」。② **比对侧**：纯函数 `reconcile()` 做「归组 → 差异分类 A–F」，不查库不改库；两侧集合由对账服务组装。③ **处置侧**：A 类自动纠正（复用 `markPaid`）、B 类人工处置（`PayoutExecutionService` 的新方法，四道闸）、解卡重打前置闸（`PayoutService.unstick` 入口调三层核实）。

**Tech Stack:** NestJS 11、Prisma 6（手写 SQL 迁移）、BullMQ 6、Jest 30（单测在 `api/src/**/*.spec.ts`，e2e 在 `api/test/**/*.e2e-spec.ts`）、Next.js（`platform-admin`）、`papaparse`（CSV 解析，本阶段首次引入）。

**设计依据:** `docs/superpowers/specs/2026-10-31-plan-05m-payout-reconciliation-design.md`（已过两轮独立审查 + 两轮自审）

---

## 零、动手前必须知道的三件事

### 0.1 本计划对设计文档的一处**结构性补正**

设计文档 §六·6.4 写了「契约下沉到 `common/`，实现放 payment，billing 按 token 注入」，但**没有说清 billing 怎么拿到那个 token**：

- billing `import` payment → `order → billing → payment → order` 的环 → **NestJS 启动直接报错**（`billing.module.ts` 顶部的模块注释明写这条铁律）
- billing 不 import payment → 就拿不到 payment 导出的 provider

→ **本计划的解法：把渠道表与核实服务一起下沉到一个 `@Global()` 的模块。**

```
api/src/common/payment/payout-providers.module.ts   ← @Global()，注册渠道表 + 核实服务
   ├─ PAYOUT_PROVIDERS（渠道表）
   ├─ PayoutVerificationService（三层核实实现）
   └─ PAYOUT_VERIFICATION（契约 token）
        ↓ 全局可见，billing 直接 @Inject(PAYOUT_VERIFICATION)
   billing/PayoutService（@Inject(PAYOUT_VERIFICATION)）
```

→ **代价**：`FakePayoutProvider` 与 `payout-provider.interface.ts` 要从 `api/src/modules/payment/` 搬到 `api/src/common/payment/`（因为全局模块的 provider 必须在**自己模块内**解析依赖，不能注入另一个非全局模块的 provider）。
→ **影响面已核实**：这两个文件的全部引用点共 **10 处**（见 Task 5 的 Step 1 清单），改动可控。
→ **依赖方向仍是单向的**：`payment → billing` 不变；`common/` 不 import 任何 `modules/` 下的**业务**模块（只 import `modules/tenancy/tenancy.module.ts` 这个「common 自己的外壳模块」，它不 import 任何东西，不构成环）。

⚠️ **实施时不要自行改成「billing import payment」或「用 `ModuleRef.get(..., { strict: false })` 绕」** —— 前者成环，后者是运行期才炸的隐式依赖。

### 0.2 全局约定（每个 Task 都适用，不再重复）

| 约定 | 内容 |
|---|---|
| **语言** | 一律简体中文（正文、注释、commit message、测试名、界面文案）。代码标识符、框架名、报错原文保留英文 |
| **时钟** | 涉及「落库时刻」一律用 `await this.prisma.databaseNow()`，**不用 `new Date()`**。唯一例外：假网关的 `executedAt`（进程内结构，见设计 §二·2.3） |
| **作用域** | 跨租户读一律 `tenantContext.run(platformScope(), async () => {...})`；回调**必须是 async 函数** |
| **金额单位** | 一律**整数分**。`merchant_receipts.amount` 是**带符号**的（`SALE_REVERSAL` 为负）→ 求和时**不许取绝对值** |
| **文案口径** | 给商家看的文案用业务口径，不出现「快照缺失」「密钥不匹配」「密文」等内部术语 |
| **提交粒度** | 每个 Task 结束提交一次，commit message 用中文 conventional commits（`feat(...)` / `fix(...)` / `refactor(...)` / `test(...)` / `docs(...)`） |
| **lint** | **不要跑全量 `npm run lint` 当验收闸** —— 后端当前**已有 9 处既有的 prettier 报错**（`payout-manual-action.dto.ts`、`settlement.service.spec.ts`、`payout-worker.spec.ts`、`settlement.e2e-spec.ts`，都与本阶段无关）。跑全量会让人去「顺手修」无关文件，违反外科手术式改动。**改为定向 lint**：只对本阶段改动的文件跑 `npx eslint <文件>`，要求**零新增**错误 |
| **不做的** | 不改任何既有枚举的**取值**（只加不改）；不改 `prisma migrate dev` 的用法（本仓仍不可用，一律手写 SQL）；不引入分页到渠道接口（记为遗留） |

### 0.3 文件结构总览

**新增（后端）**

```
api/src/common/payment/
  payout-provider.interface.ts      ← 从 modules/payment 搬来 + 扩展（Task 2 扩展，Task 5 搬）
  payout.constants.ts               ← 新增：PAYOUT_PROVIDERS token（Task 5）
  fake-payout.provider.ts           ← 从 modules/payment 搬来（Task 5）
  fake-payout.provider.spec.ts      ← 从 modules/payment 搬来（Task 5）
  payout-verification.ts            ← 新增：核实契约（Task 5）
  payout-verification.service.ts    ← 新增：三层核实实现（Task 5）
  payout-verification.service.spec.ts ← 新增（Task 5）
  payout-providers.module.ts        ← 新增：@Global() 模块（Task 5）
api/src/modules/payment/
  payout-reconcile.engine.ts        ← 新增：纯函数比对引擎（Task 4）
  payout-reconcile.engine.spec.ts   ← 新增（Task 4）
  payout-reconciliation.service.ts  ← 新增：对账服务（Task 8）
  payout-reconciliation-resolver.service.ts ← 新增：A/B 类处置（Task 6）
  platform-payout-reconciliation.controller.ts ← 新增：对账端点（Task 8）
  payout-reconcile.scheduler.ts     ← 新增：定时对账（Task 8）
  dto/payout-reconciliation.dto.ts  ← 新增（Task 8）
  dto/payout-reconciliation-import.dto.ts ← 新增（Task 9）
api/prisma/migrations/20261031100000_add_payout_reconciliation/migration.sql ← 新增（Task 1）
api/prisma/migrations/20261031110000_payout_reconciliation_indexes/migration.sql ← 新增（Task 1，实施期审查补）
api/test/payout-fixture.ts                     ← 新增：出款单造数夹具（Task 6）
api/test/payout-reconciliation.e2e-spec.ts     ← 新增：A/B 类处置（Task 6）
api/test/payout-unstick-gate.e2e-spec.ts       ← 新增：解卡闸（Task 7）
api/test/payout-reconciliation-service.e2e-spec.ts ← 新增：六类差异与对账服务（Task 8）
api/test/payout-reconciliation-import.e2e-spec.ts  ← 新增：CSV 导入（Task 9）
```

⚠️ **e2e 文件按主题拆分，不合并成一个** —— 与本仓既有约定一致
（`payout-ops` / `payout-execution` / `payout-encryption` / `settlement` 各管各的主题）。
**副作用是它让 Task 6/7/8/9 的文件集互不重叠 → 可以并行实施。**

**新增（前端）**

```
platform-admin/src/lib/reconciliation.ts                    ← 新增：类型与文案（Task 10）
platform-admin/src/app/(dashboard)/reconciliations/page.tsx   ← 新增：对账任务列表（Task 10）
platform-admin/src/app/(dashboard)/reconciliations/[id]/page.tsx ← 新增：差异详情（Task 10）
platform-admin/src/app/(dashboard)/reconciliations/reconciliation-actions.tsx ← 新增（Task 10）
platform-admin/src/app/api/billing/reconciliations/route.ts  ← 新增：中转（Task 10）
platform-admin/src/app/api/billing/reconciliations/[id]/route.ts ← 新增（Task 10）
platform-admin/src/app/api/billing/reconciliations/[id]/items/[itemId]/resolve/route.ts ← 新增（Task 10）
platform-admin/src/app/api/billing/reconciliations/import/route.ts ← 新增（Task 10）
platform-admin/src/app/api/billing/payouts/[id]/confirm-paid/route.ts ← 新增（Task 10）
```

**修改（后端）**

```
api/prisma/schema.prisma
api/src/common/tenant/tenant-prisma.service.ts   （加 2 个裸 delegate）
api/src/common/tenant/tenant-models.ts           （加 2 条作用域警告）
api/src/modules/payment/payout-provider.interface.ts   （Task 2 扩展 → Task 5 搬走）
api/src/modules/payment/fake-payout.provider.ts        （Task 2 扩展 → Task 5 搬走）
api/src/modules/payment/payment.module.ts               （Task 5 改 imports；Task 8 加 controller/scheduler）
api/src/modules/payment/payment.constants.ts            （Task 5 re-export）
api/src/modules/payment/payout.worker.ts                （Task 3 传交易号；Task 8 加 'reconcile' 分支）
api/src/modules/payment/payout-worker.spec.ts           （Task 2 改 mock）
api/src/modules/payment/fake-payout.controller.ts       （Task 5 改 import）
api/src/modules/billing/payout-execution.service.ts     （Task 3 落库修复；Task 6 加 B 类方法）
api/src/modules/billing/payout.service.ts               （Task 3 记 releasedEntryIds；Task 7 加解卡闸）
api/src/modules/billing/billing.module.ts               （Task 5/7 依赖全局模块，imports 不变）
api/test/payout-execution.e2e-spec.ts                   （Task 3 加断言；Task 5 改 import）
api/test/payout-encryption.e2e-spec.ts                  （Task 5 改 import）
api/package.json                                    （Task 9 加 papaparse / @types/multer）
```

**修改（前端）**

```
platform-admin/src/app/(dashboard)/layout.tsx      （Task 10 加导航）
platform-admin/src/app/(dashboard)/payouts/page.tsx （Task 10 加 CRITICAL 横幅）
```

### 0.4 本阶段**明确不做**的事（设计 §一·1.3 与 §十·10.3）

⚠️ **实施时撞见这些需求，不要顺手做** —— 它们是**有意排除**的，不是漏了。

| 不做 | 理由 |
|---|---|
| **B 类差异的自动纠正** | ⚠️ **本阶段的核心决策**。这类单的 `payout_entries` 已被释放 → 恢复它要复原「当初那批流水」，让机器在没人盯着的时候改一笔钱的状态，风险收益不划算 → 改为**人工处置**（运营确认渠道 + 系统校验明细可复原） |
| **新增出款单状态** | 沿用 5k/5l 的决策：`PAID` 已经是终态，缺的是**转换**不是**状态** |
| **外部告警通道**（邮件 / Prometheus / Sentry） | 本仓没有告警基建。替代方案是站内：平台端出款页顶部横幅 + 未处置差异数 |
| **真实渠道接入** | 本仓只有本地假出款网关。接口形状按「真渠道会怎么给账单」设计 |
| **跨期调账**（R7）与 **L54 逐笔结佣** | 前提是「跨期退款归属哪一期」这个**产品决策** |
| **对账结果自动改账目**（改结算单 / 改流水） | 本阶段只改 `payouts` 的状态 |
| **让「渠道明确拒付」的单可安全重试** | 要给 `PayoutExecuteResult` 加「渠道明确拒付」标记并让 `handleFailure` 据此传 `failedBeforePayout: true` —— 改的是 5h-2 的 worker 语义，属相邻改进 |
| **发现「渠道长期不返回终态」的单** | 渠道流水状态非终态时无法判断是「还在处理」还是「卡住了」→ 强行分类会产生高频误报 |
| **`retry` 改用 `releasedEntryIds`** | 两者口径不同：`retry` 的语义是「重新打」→ 要的是「当前应纳入的集合」；B 类是「确认已打了」→ 要的是「当初那批」。**本阶段不动 `retry`** |
| **渠道接口分页** | 与「10000 条上限」冲突 → **真渠道接入前必须补分页或分片拉取** |
| **对账只覆盖出款侧** | 结算单 / 抽佣流水 / 商家对账单的「缺笔」不在本阶段（L31 仍未解决） |
| **`prisma migrate dev`** | 历史迁移 checksum 不符，本仓一律手写 SQL |

---

### Task 1: schema + 迁移

**Files:**
- Modify: `api/prisma/schema.prisma`（4 个新枚举 + `PayoutOperationAction` 加 2 值 + `payouts.releasedEntryIds` + `payout_operations.reconciliationId` + 2 张新表 + 3 处索引）
- Create: `api/prisma/migrations/20261031100000_add_payout_reconciliation/migration.sql`
- Create: `api/prisma/migrations/20261031110000_payout_reconciliation_indexes/migration.sql`（实施期审查补，见 Step 4b）
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`（加 2 个裸 delegate）
- Modify: `api/src/common/tenant/tenant-models.ts`（加 2 条作用域警告）
- Test: 全量单测 + `npx tsc --noEmit`

**依赖：** 无。**必须第一个做** —— 后面的 Task 都要用这一批 Prisma 字段，字段不在 schema 里就编译不过。

- [ ] **Step 1: 在 `schema.prisma` 里加 5 个枚举**

在 `enum PayoutOperationAction { ... }`（当前在文件 `:1386-1394`）**之后**追加：

```prisma
/// 对账的数据来源（阶段 5m）
enum ReconciliationSource {
  /// 渠道 API 批量查单
  API
  /// 渠道账单文件导入
  FILE
}

/// 对账任务的状态（阶段 5m）
enum ReconciliationStatus {
  /// 执行中
  RUNNING
  /// 已完成
  COMPLETED
  /// 失败（超限 / 渠道不可用 / 解析出错）
  FAILED
}

/// 差异类型（阶段 5m；对应设计 §四·4.3 的 A–F 六类）
enum ReconciliationDiffType {
  /// A：渠道成功，本地卡在 PROCESSING
  CHANNEL_PENDING_LOCAL
  /// B：渠道成功，本地记成了 FAILED
  CHANNEL_SUCCESS_LOCAL_FAILED
  /// C：渠道成功，本地已付但金额不符
  AMOUNT_MISMATCH
  /// D：渠道有、本地没有这张单（漏记出款）
  CHANNEL_ONLY
  /// E：渠道没有、本地已付（最危险）
  LOCAL_PAID_CHANNEL_ABSENT
  /// F：渠道状态与本地状态不符（且不是 A/B 的形态）—— 例如渠道说拒付、本地记 PAID
  STATUS_MISMATCH
}

/// 差异的严重级（决定预警强度）
enum ReconciliationSeverity {
  /// A 类：渠道说已打，本地卡在中间
  INFO
  /// B 类：渠道说已打，本地误判失败
  WARNING
  /// C / D / E / F
  CRITICAL
}

/// 差异的处置状态
enum ReconciliationResolution {
  /// 待处置
  PENDING
  /// 已处置
  RESOLVED
  /// 已忽略（经核实无需处理）
  IGNORED
}
```

**同时**把 `enum PayoutOperationAction` 改成（只加值，不动既有取值）：

```prisma
/// 出款单的人工操作类型
enum PayoutOperationAction {
  /// 重试：FAILED → APPROVED（确定没打，安全重打）
  RETRY
  /// 解卡转失败：PROCESSING → FAILED（认定没打，结束这件事）
  UNSTUCK_TO_FAILED
  /// 解卡重打：PROCESSING → APPROVED（⚠️ 可能重复打款）
  UNSTUCK_TO_APPROVED
  /// 对账发现渠道已打款，本地是 PROCESSING → 自动纠正为 PAID（阶段 5m）
  RECONCILE_TO_PAID
  /// 人工确认「渠道已打款」→ FAILED 纠正为 PAID（阶段 5m）
  MANUAL_CONFIRM_PAID
}
```

- [ ] **Step 2: 给 `Payout` 加 `releasedEntryIds`，给 `PayoutOperation` 加 `reconciliationId`**

在 `model Payout` 里，`failedBeforePayout Boolean @default(false)`（当前 `:1311`）**之后**、`stuckLoggedAt DateTime?` **之前**插入：

```prisma
  /// ⚠️ **释放明细时记下的那批流水 id**（JSON 数组字符串）。
  ///
  /// `markFailed` / `unstick` 会 `deleteMany` 释放 `payout_entries`
  /// （`entryId` 是全局唯一索引，不释放商家重新申请会撞 P2002 → 500）。
  /// 释放之后「这张单原本要打哪些流水」就**丢了** ——
  /// 而 B 类（渠道说钱打了、本地记失败）要转 `PAID` 时**必须复原它**，
  /// 否则这批流水在出款维度上凭空消失（商家少拿、账上无出款记录）。
  ///
  /// ⚠️ **为什么不用「重算」复原**：补差单（`kind='SUPPLEMENT'`）的纳入范围
  /// 是「本单已占 ∪ 未被他单占用」，**依赖 `payout_entries` 本身** ——
  /// 明细已被释放 → 重算出的范围失真 → 复原不出「当初那批」。
  /// 记下 id 是**唯一精确**的复原方式。
  ///
  /// ⚠️ **存量单没有这一列**（`null`）→ B 类的人工处置对它们不可用 →
  /// 落人工待处理项，不猜。
  releasedEntryIds String?
```

在 `model PayoutOperation` 里，`attemptCountBefore Int?`（当前 `:1373`）**之后**插入：

```prisma
  /// ⚠️ **新增**（阶段 5m）：触发的对账任务 id。
  /// 没有它就答不出「这次对账纠正了哪几张单」——
  /// 留痕只有「谁在什么时候把哪张单改了」，没有「为什么」。
  ///
  /// ⚠️ **刻意不声明外键** —— 对账任务可能因保留策略被清理，
  /// 而留痕是审计凭证，**必须活得比任务久** → 不能 `ON DELETE CASCADE`；
  /// `ON DELETE SET NULL` 又会丢掉「这次对账」这一信息，
  /// 而这一列的全部意义就是这个信息。
  /// → 与 `Subscription.planId` 同款处理：service 层写入时校验 id 存在。
  reconciliationId String?
```

⚠️ **`model PayoutOperation` 还要加一条索引** —— 这一列存在的唯一理由就是
「答得出『这次对账纠正了哪几张单』」，查询就是 `where: { reconciliationId }`
→ 没有索引就是全表扫 `payout_operations`。在既有的 `@@index([operatorId])` **之后**追加：

```prisma
  // ⚠️ **这一列存在的唯一理由**是「答得出『这次对账纠正了哪几张单』」
  //    → 查询就是 where: { reconciliationId } → 没有索引就是全表扫。
  @@index([reconciliationId])
```

- [ ] **Step 3: 在 `schema.prisma` 里加两张新表**

追加到文件末尾：

```prisma
/// 渠道对账任务（阶段 5m）。
///
/// ⚠️ **不带 `tenantId`** —— 对账是**平台级**动作，跨所有租户
/// （与 `PayoutOperation` 同款）→ **不登记进 `TENANT_SCOPED_MODELS`**。
///
/// ⚠️ **它不受任何租户作用域约束** —— 任何忘了带 `reconciliationId` 的查询
/// 都会返回**全平台数据**。本表本身不含商家金额（只有统计数字），风险可控；
/// 但**必须**在 `tenant-models.ts` 里写明这条警告（与 `PayoutOperation` 同款）。
model PayoutReconciliation {
  id String @id @default(uuid())
  /// 渠道名
  channel String
  /// 数据来源
  source ReconciliationSource
  /// 对账窗口起点（含）
  windowFrom DateTime
  /// 对账窗口终点（不含）
  windowTo DateTime
  /// 账单文件名（FILE 来源）
  fileName String?
  /// 列映射（FILE 来源，JSON 字符串）
  columnMapping String?
  status ReconciliationStatus @default(RUNNING)
  /// 触发人（定时任务为 null）
  triggeredBy String?
  startedAt DateTime @default(now())
  finishedAt DateTime?
  /// 渠道侧流水条数（⚠️ 一张本地单可能对应多条 → 这个数会大于 localCount）
  channelCount Int @default(0)
  /// 本地参与比对的单数
  localCount Int @default(0)
  /// 匹配一致的**本地单**数（口径 = 本地单数，不是渠道流水条数）
  matchedCount Int @default(0)
  /// 差异笔数
  diffCount Int @default(0)
  /// 失败原因（FAILED 时）
  errorMessage String?
  createdAt DateTime @default(now())

  items PayoutReconciliationItem[]

  @@index([channel, windowFrom])
  @@index([status])
  @@map("payout_reconciliations")
}

/// 渠道对账的差异明细（阶段 5m）。
///
/// ⚠️ **同样不带 `tenantId`** → 不登记白名单 → 裸 delegate。
///
/// ⚠️ **本表不受任何作用域约束，且 `payoutId` 可空**（D 类没有本地单）→
/// 「按 `payoutId` 反查租户」这个安全网在 D 类上**直接失效** →
/// 任何列表/详情查询**必须**同时按 `reconciliationId` 限定，
/// 且 `reconciliationId` 只能来自平台超管的权限检查之后。
/// 本表含 `channelReferenceNo`（= 商家的出款单号）与金额 → **泄露即跨租户泄露**。
model PayoutReconciliationItem {
  id String @id @default(uuid())
  reconciliationId String
  /// 差异类型
  type ReconciliationDiffType
  /// 严重级
  severity ReconciliationSeverity
  /// 关联的本地出款单（⚠️ D 类可能为空 —— 渠道有、本地没有）
  payoutId String?
  /// 渠道流水号
  channelTxnId String?
  /// 渠道侧业务单号
  channelReferenceNo String?
  /// 渠道侧金额（分）
  channelAmount Int?
  /// 渠道侧状态
  channelStatus String?
  /// 渠道侧打款时刻
  channelPaidAt DateTime?
  /// 本地金额（分）
  localAmount Int?
  /// 本地状态
  localStatus PayoutStatus?
  /// 处置状态
  resolution ReconciliationResolution @default(PENDING)
  /// 处置人
  resolvedBy String?
  /// 处置时刻
  resolvedAt DateTime?
  /// 处置说明
  note String?
  createdAt DateTime @default(now())

  reconciliation PayoutReconciliation @relation(fields: [reconciliationId], references: [id], onDelete: Cascade)

  @@index([reconciliationId])
  @@index([resolution, severity])
  // ⚠️ **(payoutId, type) 而不是 (payoutId)** —— 去重查询要同时按 payoutId
  //    与 type 过滤；只按 payoutId 建索引的话 type 只能回表过滤。
  //    「按 payoutId 反查某张单的全部差异」也仍然走这个索引的前缀。
  @@index([payoutId, type])
  // ⚠️ **D 类（渠道有、本地没有）没有 payoutId** → 去重只能按渠道流水号
  //    → 这个键上必须有索引，否则每次对账都全表扫。
  @@index([channelTxnId, type])
  @@map("payout_reconciliation_items")
}
```

- [ ] **Step 4: 写迁移 SQL**

新建 `api/prisma/migrations/20261031100000_add_payout_reconciliation/migration.sql`：

```sql
-- ⚠️ **枚举必须先建**（PostgreSQL 的顺序要求：建表时要用到它）
CREATE TYPE "ReconciliationSource" AS ENUM ('API', 'FILE');
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "ReconciliationDiffType" AS ENUM (
  'CHANNEL_PENDING_LOCAL',
  'CHANNEL_SUCCESS_LOCAL_FAILED',
  'AMOUNT_MISMATCH',
  'CHANNEL_ONLY',
  'LOCAL_PAID_CHANNEL_ABSENT',
  'STATUS_MISMATCH'
);
CREATE TYPE "ReconciliationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "ReconciliationResolution" AS ENUM ('PENDING', 'RESOLVED', 'IGNORED');

-- ⚠️ **枚举加值**：两条语句要分开写（一条只能加一个值）；带 IF NOT EXISTS（本仓幂等约定）
-- ⚠️ **PG 16 允许在事务里 ADD VALUE，但新值不能在同一个事务里被使用** ——
--    本迁移 SQL 本身**不**使用这两个新值（只在应用代码里用）→ 单个迁移文件可行 ✅
--    （先例：20261029110000_add_processing_status/migration.sql:18）
ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'RECONCILE_TO_PAID';
ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'MANUAL_CONFIRM_PAID';

-- ⚠️ **加列**
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "releasedEntryIds" TEXT;
ALTER TABLE "payout_operations" ADD COLUMN IF NOT EXISTS "reconciliationId" TEXT;

CREATE INDEX IF NOT EXISTS "payout_operations_reconciliationId_idx"
  ON "payout_operations" ("reconciliationId");

-- ⚠️ **对账任务表**（无 tenantId → 不受租户作用域约束）
CREATE TABLE IF NOT EXISTS "payout_reconciliations" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "source" "ReconciliationSource" NOT NULL,
  "windowFrom" TIMESTAMP(3) NOT NULL,
  "windowTo" TIMESTAMP(3) NOT NULL,
  "fileName" TEXT,
  "columnMapping" TEXT,
  "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
  "triggeredBy" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "channelCount" INTEGER NOT NULL DEFAULT 0,
  "localCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "diffCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payout_reconciliations_channel_windowFrom_idx"
  ON "payout_reconciliations" ("channel", "windowFrom");
CREATE INDEX IF NOT EXISTS "payout_reconciliations_status_idx"
  ON "payout_reconciliations" ("status");

-- ⚠️ **差异明细表**（无 tenantId → 不受租户作用域约束；payoutId 可空 → 无外键）
CREATE TABLE IF NOT EXISTS "payout_reconciliation_items" (
  "id" TEXT NOT NULL,
  "reconciliationId" TEXT NOT NULL,
  "type" "ReconciliationDiffType" NOT NULL,
  "severity" "ReconciliationSeverity" NOT NULL,
  "payoutId" TEXT,
  "channelTxnId" TEXT,
  "channelReferenceNo" TEXT,
  "channelAmount" INTEGER,
  "channelStatus" TEXT,
  "channelPaidAt" TIMESTAMP(3),
  "localAmount" INTEGER,
  "localStatus" "PayoutStatus",
  "resolution" "ReconciliationResolution" NOT NULL DEFAULT 'PENDING',
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_reconciliation_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_reconciliation_items_reconciliationId_fkey"
    FOREIGN KEY ("reconciliationId") REFERENCES "payout_reconciliations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_reconciliationId_idx"
  ON "payout_reconciliation_items" ("reconciliationId");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_resolution_severity_idx"
  ON "payout_reconciliation_items" ("resolution", "severity");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_payoutId_idx"
  ON "payout_reconciliation_items" ("payoutId");
```

⚠️ **不要改任何既有枚举的取值** → 部分唯一索引 `payouts_tenantId_period_kind_active_uniq` 不受影响。

- [ ] **Step 4b: 补迁移（实施期代码审查发现）**

⚠️ **本 Step 是实施期代码审查补的** —— 第一个迁移**已经落库**了，
**不要改它**（改了 `prisma migrate deploy` 会因 checksum 不符报错）→ **新增第二个迁移文件**。

新建 `api/prisma/migrations/20261031110000_payout_reconciliation_indexes/migration.sql`：

```sql
-- ⚠️ **阶段 5m 实施期审查发现**：补两处缺失的索引
--
-- ① `payout_reconciliation_items` 的去重查询要同时按 (payoutId, type) 或
--    (channelTxnId, type) 过滤 —— D 类（渠道有、本地没有）没有 payoutId，
--    只能按渠道流水号 → 这个键上原本一个索引都没有 → 每次对账都全表扫。
--    这张表按设计只增不删（被标 IGNORED 的项保留，审计要看到「被发现过几次」）。
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_payoutId_type_idx"
  ON "payout_reconciliation_items" ("payoutId", "type");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_items_channelTxnId_type_idx"
  ON "payout_reconciliation_items" ("channelTxnId", "type");

-- ⚠️ **旧的单列索引被上面的复合索引的前缀覆盖** → 删掉，避免写放大
DROP INDEX IF EXISTS "payout_reconciliation_items_payoutId_idx";

-- ② `payout_operations.reconciliationId` 的索引 —— 这一列存在的唯一理由
--    是「答得出『这次对账纠正了哪几张单』」，查询就是 where: { reconciliationId }。
CREATE INDEX IF NOT EXISTS "payout_operations_reconciliationId_idx"
  ON "payout_operations" ("reconciliationId");
```

⚠️ **Step 3 的 schema 里 `PayoutReconciliationItem` 的索引也要同步改成**
`@@index([payoutId, type])` + `@@index([channelTxnId, type])`（去掉 `@@index([payoutId])`）。

- [ ] **Step 5: 加 2 个裸 delegate**

在 `api/src/common/tenant/tenant-prisma.service.ts` 的 `get payoutOperation()`（当前 `:630-632`）**之后**追加：

```ts
  // ------- 渠道对账（阶段 5m）模型 delegate 代理 -------

  // ⚠️ **不带 tenantId** —— 对账是平台级动作，跨所有租户（与 `PayoutOperation` 同款）
  // ⚠️ 因此**不受租户作用域约束** —— 查询前必须自行校验归属
  get payoutReconciliation() {
    return this.client.payoutReconciliation;
  }

  // ⚠️ **不带 tenantId，且 `payoutId` 可空**（D 类没有本地单）
  // ⚠️ 因此**不受租户作用域约束** —— 任何列表/详情查询**必须**同时带 `reconciliationId`
  get payoutReconciliationItem() {
    return this.client.payoutReconciliationItem;
  }
```

- [ ] **Step 6: 在 `tenant-models.ts` 里写明作用域警告**

在 `TENANT_SCOPED_MODELS` 数组的末尾（`PayoutOperation` 那段注释之后，`:124` 的 `]);` 之前）追加：

```ts
  //
  // ⚠️ **`PayoutReconciliation` 刻意排除**（阶段 5m）——
  //    它是「渠道对账任务」，**没有 `tenantId`**（对账是**平台级**动作，跨所有租户，
  //    与 `PayoutOperation` 同款）。
  //    ⚠️ **不要把它登记进白名单** —— 登记了扩展会给它附加 tenantId 条件，
  //    而它**没有 `tenantId` 列** → Prisma 直接报错。
  //    ⚠️ 它**不受作用域约束** → 任何忘了带 `reconciliationId` 的查询都会返回全平台数据。
  //    它只在**平台作用域**下读写（只有平台超管能操作对账）。
  //
  // ⚠️ **`PayoutReconciliationItem` 同样刻意排除**（阶段 5m）——
  //    它**没有 `tenantId`** 字段，且 `payoutId` **可空**（D 类「渠道有、本地没有」没有本地单）
  //    → 「按 `payoutId` 反查租户」这个安全网在 D 类上**直接失效**。
  //    ⚠️ 它含 `channelReferenceNo`（= 商家的出款单号）与金额 → **泄露即跨租户泄露**。
  //    ⚠️ 任何列表/详情查询**必须**同时按 `reconciliationId` 限定，
  //    且 `reconciliationId` 只能来自平台超管的权限检查之后。
```

- [ ] **Step 7: 验证**

```bash
cd api && npx prisma migrate deploy
```

预期：`Applied migration(s): 20261031100000_add_payout_reconciliation`（或「Already in database」）。

```bash
cd api && npx prisma generate && npx tsc --noEmit
```

预期：无输出（无类型错误）。

```bash
cd api && npx jest --passWithNoTests
```

预期：全部通过。

- [ ] **Step 8: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/prisma/schema.prisma \
        api/prisma/migrations/20261031100000_add_payout_reconciliation/migration.sql \
        api/src/common/tenant/tenant-prisma.service.ts \
        api/src/common/tenant/tenant-models.ts
git commit -m "feat(billing): 阶段 5m 的 schema —— 对账任务表、差异明细表与两处加列

新增 5 个枚举（对账来源/状态/差异类型/严重级/处置状态）、
PayoutOperationAction 的两个加值（对账自动纠正 / 人工确认已付款）、
payouts.releasedEntryIds（释放明细时记下的流水 id）与
payout_operations.reconciliationId（关联到对账任务）。

新表不带 tenantId —— 对账是平台级动作，与 PayoutOperation 同款，
已在 tenant-models.ts 写明不受作用域约束的警告。"
```

---

### Task 2: 渠道接口扩展 + 假网关如实记录

**Files:**
- Modify: `api/src/modules/payment/payout-provider.interface.ts`
- Modify: `api/src/modules/payment/fake-payout.provider.ts`
- Modify: `api/src/modules/payment/fake-payout.provider.spec.ts`
- Modify: `api/src/modules/payment/payout-worker.spec.ts`
- Test: `api/src/modules/payment/fake-payout.provider.spec.ts`（单元）、`api/src/modules/payment/payout-worker.spec.ts`（单元）

**依赖：** 无（可与 Task 1 并行，但**不要**同时改同一文件）。

- [ ] **Step 1: 扩展 `PayoutProvider` 接口**

改 `api/src/modules/payment/payout-provider.interface.ts`。在 `PayoutExecuteResult`（`:46-65`）**之后**追加两个类型，并把 `PayoutProvider` 整个替换：

```ts
/** 渠道侧的出款流水（对账用） */
export interface ChannelPayoutRecord {
  /** 渠道侧的业务单号（= 我们传给渠道的 `payoutNo`） */
  referenceNo?: string;
  /** 渠道交易号（= 我们拿到的 `providerTxnId`） */
  providerTxnId: string;
  /** 渠道实际打出的金额（整数分） */
  amount: number;
  /** 渠道侧状态（开放字符串：`SUCCESS` / `FAILED` / `PROCESSING` / …） */
  status: string;
  /** 渠道侧的打款时刻 */
  paidAt?: Date;
  /** 失败原因（渠道原文） */
  failureReason?: string;
}

/**
 * 单笔核实的入参 —— ⚠️ **两个键至少给一个**。
 *
 * ⚠️ **`referenceNo` 是必须支持的** —— 「卡在 `PROCESSING` 的单」**没有 `payoutTxnId`**
 * （它是 `markPaid` 的唯一写入点），而解卡核实闸的对象恰恰是 `PROCESSING` 的单。
 * 只按 `providerTxnId` 查 → 核实闸对它的全部对象都是死代码。
 */
export interface PayoutQuery {
  /** 渠道交易号（`PAID` 的单才有） */
  providerTxnId?: string;
  /** 渠道侧业务单号（= 我们的 `payoutNo`，**所有调过渠道的单都有**） */
  referenceNo?: string;
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

  /**
   * 查一笔打款的状态（对账 / 核实用）。
   *
   * ⚠️ **返回的 `status` 是开放字符串** —— 调用方只认 `'SUCCESS'` 与 `'FAILED'`，
   * 其余一律当「问不出结论」处理（fail-closed）。
   */
  queryPayout(
    query: PayoutQuery,
  ): Promise<{ status: string; amount?: number; paidAt?: Date }>;

  /**
   * ⚠️ **批量查渠道侧的出款流水**（对账用）。
   * 时间窗是**左闭右开**的 `[from, to)`。
   *
   * ⚠️ **必须包含失败的那次尝试** —— 否则「第一次失败第二次成功」在渠道侧
   * 只剩一条 SUCCESS，看起来像「只打了一次」，对账就测不出重试场景。
   */
  listPayouts(query: { from: Date; to: Date }): Promise<ChannelPayoutRecord[]>;
}
```

- [ ] **Step 2: 假网关改为「存真实结果」**

改 `api/src/modules/payment/fake-payout.provider.ts`。**整体替换**这个文件（下面的内容是完整的最终形态）：

```ts
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ChannelPayoutRecord,
  PayoutExecuteInput,
  PayoutExecuteResult,
  PayoutProvider,
  PayoutQuery,
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

/** 假网关记下的一次打款尝试 */
interface FakePayoutAttempt {
  /** 渠道交易号 */
  providerTxnId: string;
  /** 业务单号（= 我们的 `payoutNo`） */
  referenceNo: string;
  /** 金额（分） */
  amount: number;
  /** 渠道侧状态 */
  status: string;
  /** 失败原因 */
  failureReason?: string;
  /** ⚠️ **打款时刻** —— `listPayouts(from, to)` 的时间窗靠它过滤 */
  executedAt: Date;
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
 *
 * ## 阶段 5m 的变化：它必须「说真话」
 *
 * ⚠️ **原来的 `queryPayout` 恒返回 `SUCCESS`** —— 拿它当核实闸的话，
 * 每一张单都会被判定为「渠道说已打款」→ 解卡重打功能全废。
 * → 现在改为**存每次 `execute` 的真实结果**，按 `referenceNo` 与 `providerTxnId`
 * **两个键都建索引**（`PROCESSING` 的单只有 `payoutNo`，没有交易号）。
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
   * 每笔出款**实际发给渠道的请求**（按 `referenceId` 存）。
   *
   * ⚠️ **为什么需要它**：护栏 X2b 说「打款要用审批时的账户快照」。
   *    只断言 API 响应里的 `maskedSnapshotAccountNo` **验不了这一层** ——
   *    那个字段读的是**库里存的快照**，而「传给渠道的 account」是另一份数据。
   *    worker 若传了实时账户，钱会打到错的账户，而快照字段纹丝不动 →
   *    断言照样通过 → **护栏没有牙齿**。
   *    记录下真实发出去的请求，才能断言「渠道收到的就是快照」。
   *
   * ⚠️ **按 `referenceId` 存，不存「最后一次」**：e2e 里 worker 在同一进程跑，
   *    别的单子也在打款 → 「最后一次」会被别的单覆盖。
   */
  private readonly received = new Map<string, PayoutExecuteInput>();

  /**
   * 每次打款尝试的**真实结果**（阶段 5m）。
   *
   * ⚠️ **按 `referenceNo` 建索引**：解卡核实闸的对象是 `PROCESSING` 的单，
   *    它**没有 `payoutTxnId`** —— 只按交易号查会查不到。
   */
  private readonly attemptsByReferenceNo = new Map<string, FakePayoutAttempt[]>();

  /** 同上，按渠道交易号建索引（`PAID` 的单只有交易号） */
  private readonly attemptsByTxnId = new Map<string, FakePayoutAttempt>();

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
    // ⚠️ **必须自己兜底非有限数**：入参来自 HTTP body（见 `fake-payout.controller.ts`），
    //    而那里用的是**内联 TS 类型** → Nest 的 ValidationPipe 对
    //    `metatype === Object` 会**跳过校验** → `{"times":"abc"}` 能原样进来。
    //    `Math.floor('abc')` → `NaN` → `Math.max(0, NaN)` → `NaN` →
    //    `this.failTimes > 0` 恒为 false → **假网关永远成功**，
    //    失败剧本被静默吞掉（测试看起来「通过」，实际什么都没造出来）。
    //    `NaN` / `Infinity` 一律当作 0。
    this.failTimes = this.toFiniteCount(options.failTimes);
    this.amountOffset = this.toFiniteCount(options.amountOffset);
  }

  /** 把入参规整成「非负整数」，非有限数（NaN / Infinity）当作 0 */
  private toFiniteCount(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  }

  /** 当前还要失败几次（测试与诊断用） */
  remainingFailures(): number {
    return this.failTimes;
  }

  /**
   * 取某笔出款**实际发给渠道的请求**（测试与诊断用）。
   *
   * @param referenceId 出款单 id
   * @returns 传给渠道的请求；没打过就是 `undefined`
   */
  receivedRequest(referenceId: string): PayoutExecuteInput | undefined {
    return this.received.get(referenceId);
  }

  execute(input: PayoutExecuteInput): Promise<PayoutExecuteResult> {
    // ⚠️ **先记录再分支** —— 失败的那次也要留下记录：
    //    「渠道收到了什么」与「渠道成功没有」是两件事。
    this.received.set(input.referenceId, input);
    if (!isFakePayoutEnabled()) {
      // ⚠️ **返回 rejected promise 而不是同步抛错**：这个方法是**异步**的
      //    （`Promise<PayoutExecuteResult>`），调用方会用 `await` 接它。
      //    同步抛错与 rejected promise 在 `await` 下的表现一样，
      //    但同步抛错会让「`execute(...)` 这行本身就可能炸」——
      //    调用方若写成 `provider.execute(x).catch(...)` 就漏掉了。
      return Promise.reject(
        new ServiceUnavailableException('本地假出款网关未启用'),
      );
    }

    // ⚠️ **失败也要给渠道交易号**：真实渠道失败时也会返回一个流水号，
    //    运营对账时要靠它去渠道查「这笔到底打没打出去」。
    const providerTxnId = `fake-pay-${randomUUID()}`;

    if (this.failTimes > 0) {
      this.failTimes -= 1;
      const failureReason = `假出款网关模拟的失败（第 ${input.attempt} 次尝试）`;
      // ⚠️ **失败路径不应用金额偏移，也不消耗它**：
      //    金额偏移是用来造「渠道金额核对不通过」（护栏 X3）的，
      //    那条护栏只对**成功路径**有意义（成功却金额对不上）。
      //    失败路径若也加偏移，就会造出「失败时金额也错 + 之后成功时金额也错」
      //    的组合，把两件事混在一起，测出来的原因会指向错误的护栏。
      this.recordAttempt({
        providerTxnId,
        referenceNo: input.referenceNo,
        amount: input.amount,
        status: 'FAILED',
        failureReason,
      });
      return Promise.resolve({
        providerTxnId,
        status: 'FAILED',
        amount: input.amount,
        failureReason,
      });
    }

    const amount = input.amount + this.takeAmountOffset();
    this.recordAttempt({
      providerTxnId,
      referenceNo: input.referenceNo,
      amount,
      status: 'SUCCESS',
    });
    return Promise.resolve({
      providerTxnId,
      status: 'SUCCESS',
      // ⚠️ **金额偏移只在这一次生效** —— 用来造「渠道金额核对不通过」
      //    （护栏 X3）。不消耗掉的话，之后每次成功都带偏移。
      amount,
    });
  }

  /**
   * 查一笔打款的状态。
   *
   * ⚠️ **按真实记录回答**（阶段 5m）—— 恒返回 `SUCCESS` 会让解卡核实闸
   * 永远放行 → 解卡重打功能全废。
   */
  queryPayout(
    query: PayoutQuery,
  ): Promise<{ status: string; amount?: number; paidAt?: Date }> {
    const attempt = this.findAttempt(query);
    if (!attempt) {
      // ⚠️ **查不到 ≠ 渠道说没打** —— 只能回 `UNKNOWN`，
      //    让调用方进入下一层核实（fail-closed）。
      return Promise.resolve({ status: 'UNKNOWN' });
    }
    return Promise.resolve({
      status: attempt.status,
      amount: attempt.amount,
      paidAt: attempt.executedAt,
    });
  }

  /**
   * 批量查渠道侧的出款流水（阶段 5m）。
   *
   * ⚠️ **时间窗是左闭右开** `[from, to)`。
   * ⚠️ **失败的那次尝试也在结果里** —— 否则「第一次失败第二次成功」
   * 在渠道侧只剩一条 SUCCESS，对账就测不出重试场景。
   */
  listPayouts(query: { from: Date; to: Date }): Promise<ChannelPayoutRecord[]> {
    if (!isFakePayoutEnabled()) {
      // ⚠️ **抛错而不是返回空数组** —— 返回空数组会被当成
      //    「渠道说这一笔没有」→ 所有本地已付单全变成 E 类。
      return Promise.reject(
        new ServiceUnavailableException('本地假出款网关未启用'),
      );
    }
    const records: ChannelPayoutRecord[] = [];
    for (const attempts of this.attemptsByReferenceNo.values()) {
      for (const attempt of attempts) {
        if (
          attempt.executedAt.getTime() >= query.from.getTime() &&
          attempt.executedAt.getTime() < query.to.getTime()
        ) {
          records.push({
            referenceNo: attempt.referenceNo,
            providerTxnId: attempt.providerTxnId,
            amount: attempt.amount,
            status: attempt.status,
            paidAt: attempt.executedAt,
            failureReason: attempt.failureReason,
          });
        }
      }
    }
    return Promise.resolve(records);
  }

  /** 记下一次打款尝试（两个索引都建） */
  private recordAttempt(attempt: Omit<FakePayoutAttempt, 'executedAt'>): void {
    // ⚠️ **打款时刻在这里盖戳** —— 它是「这次尝试发生的那一刻」，
    //    属于记录动作本身，不该由调用方传（传了就有「传错时刻」的机会）。
    const record: FakePayoutAttempt = { ...attempt, executedAt: new Date() };
    const list = this.attemptsByReferenceNo.get(record.referenceNo) ?? [];
    list.push(record);
    this.attemptsByReferenceNo.set(record.referenceNo, list);
    this.attemptsByTxnId.set(record.providerTxnId, record);
  }

  /** 按 `providerTxnId` 或 `referenceNo` 找到对应的尝试记录 */
  private findAttempt(query: PayoutQuery): FakePayoutAttempt | undefined {
    if (query.providerTxnId) {
      const byTxn = this.attemptsByTxnId.get(query.providerTxnId);
      if (byTxn) {
        return byTxn;
      }
    }
    if (query.referenceNo) {
      const list = this.attemptsByReferenceNo.get(query.referenceNo);
      // ⚠️ **取最后一条** —— 同一单可能有多次尝试（重试），
      //    最后一次才是当前状态。
      return list && list.length > 0 ? list[list.length - 1] : undefined;
    }
    return undefined;
  }

  /** 取走一次金额偏移（只生效一次） */
  private takeAmountOffset(): number {
    const offset = this.amountOffset;
    this.amountOffset = 0;
    return offset;
  }
}
```

- [ ] **Step 3: 给假网关补单测**

在 `api/src/modules/payment/fake-payout.provider.spec.ts` 的 `describe` 块**末尾**（`it('渠道名固定', ...)` 之后）追加：

```ts
  it('queryPayout：按 referenceNo 查到真实状态（成功）', async () => {
    const provider = new FakePayoutProvider();
    await provider.execute(input);

    const result = await provider.queryPayout({
      referenceNo: input.referenceNo,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.amount).toBe(8500);
    expect(result.paidAt).toBeInstanceOf(Date);
  });

  it('queryPayout：按 providerTxnId 查到真实状态（失败）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    const failed = await provider.execute(input);

    const result = await provider.queryPayout({
      providerTxnId: failed.providerTxnId,
    });

    // ⚠️ **必须返回 FAILED 而不是 SUCCESS** —— 恒返回 SUCCESS 会让
    //    解卡核实闸永远放行 → 解卡重打功能全废
    expect(result.status).toBe('FAILED');
  });

  it('queryPayout：查不到 → UNKNOWN（不是 SUCCESS，也不是 FAILED）', async () => {
    const provider = new FakePayoutProvider();

    const result = await provider.queryPayout({ referenceNo: '不存在的单号' });

    // ⚠️ **「查不到」≠「渠道说没打」** —— 调用方据此进入下一层核实
    expect(result.status).toBe('UNKNOWN');
  });

  it('queryPayout：同一单多次尝试 → 返回最后一次的状态', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    await provider.execute(input);
    await provider.execute({ ...input, attempt: 2 });

    const result = await provider.queryPayout({ referenceNo: input.referenceNo });

    expect(result.status).toBe('SUCCESS');
  });

  it('listPayouts：返回时间窗内的全部尝试（含失败那次）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    await provider.execute(input);
    await provider.execute({ ...input, attempt: 2 });

    const records = await provider.listPayouts({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });

    // ⚠️ **两条都要在** —— 少了失败那次，对账就测不出重试场景
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.status).sort()).toEqual(['FAILED', 'SUCCESS']);
    expect(records[0].referenceNo).toBe(input.referenceNo);
  });

  it('listPayouts：时间窗外的记录不返回（左闭右开）', async () => {
    const provider = new FakePayoutProvider();
    await provider.execute(input);

    const records = await provider.listPayouts({
      from: new Date(Date.now() + 60_000),
      to: new Date(Date.now() + 120_000),
    });

    expect(records).toHaveLength(0);
  });

  it('listPayouts：网关未启用 → 抛错（不是返回空数组）', async () => {
    process.env.FAKE_PAYOUT_ENABLED = 'false';
    const provider = new FakePayoutProvider();

    // ⚠️ **返回空数组会被当成「渠道说这一笔没有」** → 全部本地已付单变 E 类
    await expect(
      provider.listPayouts({
        from: new Date(0),
        to: new Date(Date.now() + 60_000),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
```

- [ ] **Step 4: 改 `payout-worker.spec.ts` 的 mock**

`api/src/modules/payment/payout-worker.spec.ts`：

① `FakeProvider` 接口加 `listPayouts`：

```ts
interface FakeProvider {
  calls: unknown[];
  channel: string;
  provider: string;
  execute: jest.Mock;
  queryPayout: jest.Mock;
  listPayouts: jest.Mock;
}
```

② `fakeProvider` 工厂里，`queryPayout` 那一行改成：

```ts
    queryPayout: jest.fn(() => Promise.resolve({ status: 'SUCCESS' })),
    // ⚠️ **新增**（阶段 5m）：批量查单。默认返回空数组。
    listPayouts: jest.fn(() => Promise.resolve([])),
```

- [ ] **Step 5: 验证**

```bash
cd api && npx jest fake-payout.provider payout-worker
```

预期：两个文件全部通过（`fake-payout.provider.spec.ts` 新增 7 个用例，`payout-worker.spec.ts` 原有 20 个用例不受影响）。

```bash
cd api && npx tsc --noEmit
```

预期：无输出。

- [ ] **Step 6: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/src/modules/payment/payout-provider.interface.ts \
        api/src/modules/payment/fake-payout.provider.ts \
        api/src/modules/payment/fake-payout.provider.spec.ts \
        api/src/modules/payment/payout-worker.spec.ts
git commit -m "feat(payment): 渠道接口扩展 queryPayout 签名 + 新增 listPayouts，假网关改为说真话

queryPayout 的入参改成对象并支持 referenceNo —— 卡在 PROCESSING 的单没有
payoutTxnId，只按交易号查会让解卡核实闸对它的全部对象都是死代码。

新增 listPayouts：批量查渠道侧的出款流水。必须包含失败的那次尝试，否则
「第一次失败第二次成功」在渠道侧只剩一条 SUCCESS，对账测不出重试场景。

假网关原来恒返回 SUCCESS，拿它当核实闸会让每一张单都被判定为
「渠道说已打款」→ 解卡重打功能全废。改为存每次 execute 的真实结果，
按 referenceNo 与 providerTxnId 双索引。"
```

---

### Task 3: 前置修复（`markFailed` / `markPaid` / `unstick` / worker 调用点）

**Files:**
- Modify: `api/src/modules/billing/payout-execution.service.ts`
- Modify: `api/src/modules/billing/payout.service.ts`
- Modify: `api/src/modules/payment/payout.worker.ts`
- Test: `api/test/payout-execution.e2e-spec.ts`（加断言）

**依赖：** Task 1（`releasedEntryIds` 字段）、Task 2（`PayoutExecuteResult` 不变，但 worker 要传交易号）。

⚠️ **本 Task 与设计文档 §九 Task 3 的第 ⑥ 条重复**（「假网关存真实结果」已在 Task 2 完成）—— **不要重复做**。

- [ ] **Step 1: `markFailed` 存渠道交易号**

改 `api/src/modules/billing/payout-execution.service.ts` 的 `MarkFailedInput`（当前 `:21-37`），加一个字段：

```ts
/** 打款失败的结果 */
export interface MarkFailedInput {
  /** 失败原因（给运营看） */
  reason: string;
  /** 落 FAILED 的时刻（数据库时钟） */
  failedAt: Date;
  /**
   * 这次失败是否发生在**打款之前**。
   *
   * ⚠️ **true = 钱确定没打出去**（渠道从未被调用）→ 该单**可安全重试**。
   * ⚠️ **false = 钱可能已经打出去**（渠道调过了，只是没成功回包）
   *    → **不能重试**，只能人工核对渠道。
   *
   * ⚠️ **默认 false** —— 宁可保守。新增调用点若忘了传，
   *    会落成「不可重试」（安全方向）。
   */
  failedBeforePayout?: boolean;
  /**
   * ⚠️ **新增**（阶段 5m）：渠道交易号。失败时渠道也会给 —— 不存就无从核实。
   *
   * ⚠️ **只在渠道被调用过时才传** —— 渠道压根没被调用时传假值会污染核实判断。
   * ⚠️ **不传就不写**（`undefined` 会被 Prisma 忽略）—— 不能覆盖已有的值。
   */
  providerTxnId?: string;
}
```

再改 `markFailed` 的 `data`（当前 `:256-263`）：

```ts
          data: {
            status: PayoutStatus.FAILED,
            failedAt: input.failedAt,
            failureReason: input.reason,
            // ⚠️ **「钱确定没打出去」的标记**（阶段 5l）——
            //    平台端的「重试」按钮只对 true 的单出现。
            failedBeforePayout: input.failedBeforePayout ?? false,
            // ⚠️ **新增**（阶段 5m）：存渠道交易号。
            //    `payoutTxnId` 的唯一写入点原本是 `markPaid` → `FAILED` 的单
            //    没有交易号 → 「实时核实」对它们无从谈起。
            //    ⚠️ **`undefined` 会被 Prisma 忽略** → 渠道没被调用时不会写入空值，
            //    也不会覆盖已有的交易号。
            payoutTxnId: input.providerTxnId,
          },
```

- [ ] **Step 2: `markFailed` 释放明细时同事务记下 `releasedEntryIds`**

改 `api/src/modules/billing/payout-execution.service.ts` 的 `markFailed` 事务体（当前 `:270` 那一行）：

```ts
        // ⚠️ **与状态更新同一个事务** —— 分开写会出现
        //    「状态已 FAILED、明细还占着」的窗口
        //
        // ⚠️ **读 id 与删明细必须同事务**（阶段 5m）—— 分开写会出现
        //    「明细已删、id 没记上」的窗口 → 这张单永远复原不了（只能落人工处理）。
        const releasedEntries = await tx.payoutEntry.findMany({
          where: { payoutId },
          select: { entryId: true },
        });
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        if (releasedEntries.length > 0) {
          // ⚠️ **只有释放了明细才记** —— 没有明细可释放时不要写空数组，
          //    否则 B 类处置会误判「可复原」（闸 ① 要的是「当初那批」，
          //    空数组意味着「当初就没有明细」→ 与 null 的语义不同）
          await tx.payout.updateMany({
            where: { id: payoutId },
            data: { releasedEntryIds: JSON.stringify(releasedEntries.map((e) => e.entryId)) },
          });
        }
        return true;
```

- [ ] **Step 3: `markPaid` 清掉失败痕迹**

改 `api/src/modules/billing/payout-execution.service.ts` 的 `markPaid` 的 `data`（当前 `:202-210`）：

```ts
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.PAID,
            paidAt: input.paidAt,
            payoutChannel: input.channel,
            payoutTxnId: input.providerTxnId,
            // ⚠️ **失败原因要清掉**：重试成功后之前那次失败的原因不该留着
            failureReason: null,
            // ⚠️ **新增**（阶段 5m）：`failedAt` 与 `failedBeforePayout` 也要清。
            //    残留的 `failedAt` 会让这张单落进**另一个**对账窗口；
            //    停在 `true` 的 `failedBeforePayout` 会让一张 `PAID` 的单
            //    带着「钱确定没打出去」的标记 —— 语义自相矛盾。
            failedAt: null,
            failedBeforePayout: false,
          },
        });
```

- [ ] **Step 4: `markPaid` 返回 `false` 时补日志**

改 `api/src/modules/billing/payout-execution.service.ts` 的 `markPaid` 末尾（当前 `:212-214` 的 `return false;`）：

```ts
        if (affected.count === 0) {
          // ⚠️ **补日志**（阶段 5m）—— 现状是完全静默。
          //    对账纠正与 worker 可能撞车（worker 先落了 `PAID`），
          //    这时「渠道打了两次」的怀疑无法排除 → 有日志才查得清。
          this.logger.warn(
            `出款 ${payoutId} 的 markPaid 未命中（状态已变，可能已被对账纠正或人工处理）`,
          );
          return false;
        }
```

- [ ] **Step 5: `unstick` 转 `FAILED` 时同样记 `releasedEntryIds`**

改 `api/src/modules/billing/payout.service.ts` 的 `unstick` 事务体（当前 `:1044-1048`）：

```ts
        // ⚠️ **转 FAILED 时要释放明细** —— 与 `markFailed` 同款：
        //    单子结束了，商家可以对该期重新申请
        if (toStatus === PayoutStatus.FAILED) {
          // ⚠️ **读 id 与删明细同事务**（阶段 5m）—— 与 `markFailed` 同款理由
          const releasedEntries = await tx.payoutEntry.findMany({
            where: { payoutId },
            select: { entryId: true },
          });
          await tx.payoutEntry.deleteMany({ where: { payoutId } });
          if (releasedEntries.length > 0) {
            await tx.payout.updateMany({
              where: { id: payoutId },
              data: {
                releasedEntryIds: JSON.stringify(
                  releasedEntries.map((e) => e.entryId),
                ),
              },
            });
          }
        }
```

- [ ] **Step 6: worker 的两个调用点传渠道交易号**

改 `api/src/modules/payment/payout.worker.ts`：

① `handleFailure` 的签名（当前 `:274-279`）加一个参数：

```ts
  private async handleFailure(
    payoutId: string,
    attemptCount: number,
    reason: string,
    now: Date,
    providerTxnId: string,
  ): Promise<void> {
    if (attemptCount >= PAYOUT_MAX_ATTEMPTS) {
      await this.execution.markFailed(payoutId, {
        reason,
        failedAt: now,
        // ⚠️ **渠道已经调过了** → 钱**可能**已经打出去 → 不能重试
        failedBeforePayout: false,
        // ⚠️ **新增**（阶段 5m）：渠道失败时也会给交易号 → 存下来才能核实
        providerTxnId,
      });
      return;
    }
```

② `settle` 里调用 `handleFailure` 的地方（当前 `:245-249`）：

```ts
    if (result.status !== 'SUCCESS') {
      const reason = result.failureReason ?? '渠道返回失败';
      await this.handleFailure(
        payoutId,
        attemptCount,
        reason,
        now,
        // ⚠️ **渠道交易号一路带下来** —— `handleFailure` 拿不到 `result`
        //    就只能传空字符串，「实时核实」对 `FAILED` 的单就成了死代码
        result.providerTxnId,
      );
      return;
    }
```

③ 金额核对不通过那个 `markFailed`（当前 `:251-259`）：

```ts
    if (result.amount !== requestedAmount) {
      await this.execution.markFailed(payoutId, {
        reason: `渠道金额核对不通过（请求 ${requestedAmount} 分，渠道返回 ${result.amount} 分）`,
        failedAt: now,
        // ⚠️ **渠道已经调过了** → 钱**可能**已经打出去 → 不能重试
        failedBeforePayout: false,
        // ⚠️ **新增**（阶段 5m）：渠道调过了 → 交易号要存
        providerTxnId: result.providerTxnId,
      });
      return;
    }
```

⚠️ **前三个 `markFailed` 调用点（`:133` 解密失败、`:146` `checkGates`、`:161` 没有可用渠道）**都**不要**传 `providerTxnId` —— 渠道压根没被调用，没有交易号。传个假值进去会污染核实的判断。

- [ ] **Step 7: 补 e2e 断言**

在 `api/test/payout-execution.e2e-spec.ts` 的 `describe` 块里追加一个用例（放在文件末尾的 `describe` 内）：

```ts
  it('⚠️ 渠道失败 → payoutTxnId 与 releasedEntryIds 都要有值（阶段 5m）', async () => {
    // ⚠️ **这两条是「实时核实」与「B 类人工处置」的前提**：
    //    没有 payoutTxnId → 核实闸对 FAILED 的单是死代码；
    //    没有 releasedEntryIds → B 类永远复原不出明细。
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-10');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });

    // ⚠️ **先 arm 再 approve** —— approve 会立刻入队，worker 随时可能抢到 job；
    //    arm 晚一步就可能来不及。`times: 3` = 三次尝试全失败 →
    //    终态是 FAILED（`PAYOUT_MAX_ATTEMPTS = 3`）。
    await armScenario(adminToken, { times: 3 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();

    // ⚠️ **直接查库** —— 商家端响应体里没有这两个字段
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    // ⚠️ **渠道交易号必须存下来** —— 渠道失败时也会给
    expect(row!.payoutTxnId).toBeTruthy();
    // ⚠️ **释放的明细 id 必须记下来** —— 否则 B 类复原不出明细
    expect(row!.releasedEntryIds).toBeTruthy();
    const entryIds = JSON.parse(row!.releasedEntryIds!) as string[];
    expect(entryIds.length).toBeGreaterThan(0);
  });
```

⚠️ **本文件已有的辅助函数，直接用，不要另建**（`api/test/payout-execution.e2e-spec.ts`）：

| 名字 | 签名 | 位置 |
|---|---|---|
| `loginPlatformAdmin()` | `Promise<string>`（**只返回 token 字符串**，不是对象） | `:156` |
| `setupMerchantWithPeriod(adminToken, period, opts)` | `Promise<{ merchant, statementId }>` | `:278` |
| `apply(token, period)` | `Promise<PayoutBody>` | `:338` |
| `approve(adminToken, id)` | `Promise<PayoutBody>` | `:360` |
| `armScenario(adminToken, { times, amountOffset })` | `Promise<void>` | `:369` |
| `waitFor(predicate, timeoutMs?)` | `Promise<boolean>` | `:389` |
| `waitForStatus(token, id, status)` | `Promise<PayoutBody \| null>` | `:402` |
| `asPlatform(fn)` | `Promise<T>` | `:151` |

⚠️ **该文件里没有 `seedPayout`** —— 它走的是「造商家 → 申请 → 审批」的真链路，
`seedPayout` 只在 `api/test/payout-ops.e2e-spec.ts` 里（那是直接插库的版本）。

⚠️ **月份用 `2026-10`** —— 各 e2e 文件各占各的月份段（`payout-ops` 占 2022 全年、
`settlement` 占 2023-12 ~ 2025-07、`ledger-reconciliation` 占 2023 与 2025-08 起的月份），
`2026-10` 没人占。

- [ ] **Step 8: 验证**

```bash
cd api && npx tsc --noEmit
```

预期：无输出。

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payout-execution.e2e-spec.ts
```

预期：全部通过（含新增用例）。

⚠️ **失败注入必须独占** —— 不要与全量测试并发跑。

```bash
cd api && npx jest --passWithNoTests
```

预期：全部通过。

- [ ] **Step 9: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/src/modules/billing/payout-execution.service.ts \
        api/src/modules/billing/payout.service.ts \
        api/src/modules/payment/payout.worker.ts \
        api/test/payout-execution.e2e-spec.ts
git commit -m "fix(billing): 落 FAILED 时存下渠道交易号与被释放的明细 id

markFailed 原本不写 payoutTxnId（那是 markPaid 的唯一写入点）→ FAILED 的单
没有渠道交易号 → 「实时核实」对它们无从谈起。markFailed 释放 payout_entries
时也不记下被删的 entryId → B 类（渠道说钱打了、本地记失败）要转 PAID 时
复原不出「当初那批」流水，那批流水会在出款维度上凭空消失。

markPaid 补清 failedAt 与 failedBeforePayout —— 残留的 failedAt 会让这张单
落进另一个对账窗口，停在 true 的 failedBeforePayout 会让一张 PAID 的单
带着「钱确定没打出去」的标记。

markPaid 未命中时补日志：对账纠正与 worker 可能撞车，没有日志就查不清
「渠道是否打了两次」。"
```

---

### Task 4: 比对引擎（纯函数）

**Files:**
- Create: `api/src/modules/payment/payout-reconcile.engine.ts`
- Create: `api/src/modules/payment/payout-reconcile.engine.spec.ts`

**依赖：** Task 2（`ChannelPayoutRecord` 类型）、**Task 5（该类型文件已被搬到 `api/src/common/payment/`）**。

⚠️ **Task 5 必须先做** —— 它把 `payout-provider.interface.ts` 搬到 `common/payment/`，
本 Task 的 import 路径写的是**搬完之后**的路径。

⚠️ **引擎是纯函数** —— 不查库、不改库。两个集合由调用方（Task 8 的对账服务）组装好传进来。

- [ ] **Step 1: 写引擎的类型契约**

新建 `api/src/modules/payment/payout-reconcile.engine.ts`：

```ts
import { PayoutStatus } from '@prisma/client';
import {
  ReconciliationDiffType,
  ReconciliationSeverity,
} from '@prisma/client';
import type { ChannelPayoutRecord } from '../../common/payment/payout-provider.interface';

/** 参与比对的本地单（已按设计 §四·4.1 查好） */
export interface LocalPayoutForReconcile {
  id: string;
  payoutNo: string;
  payoutTxnId: string | null;
  status: PayoutStatus;
  netAmount: number;
  receiptAmount: number;
  commissionAmount: number;
  entryCount: number;
  paidAt: Date | null;
  processingAt: Date | null;
  failedAt: Date | null;
}

/** 比对引擎的入参 */
export interface ReconcileInput {
  /** 名义窗口 `[from, to)` */
  window: { from: Date; to: Date };
  /** 扩大的窗口边界（用于判定 D 类是否落在窗口内） */
  expandedWindow: { from: Date; to: Date };
  /** 本地单集合 */
  localPayouts: LocalPayoutForReconcile[];
  /** 渠道流水集合（**已含失败那次**） */
  channelRecords: ChannelPayoutRecord[];
}

/** 一条差异 */
export interface ReconcileDiff {
  type: ReconciliationDiffType;
  severity: ReconciliationSeverity;
  payoutId: string | null;
  channelTxnId: string | null;
  channelReferenceNo: string | null;
  channelAmount: number | null;
  channelStatus: string | null;
  channelPaidAt: Date | null;
  localAmount: number | null;
  localStatus: PayoutStatus | null;
}

/** 比对引擎的出参 */
export interface ReconcileOutput {
  diffs: ReconcileDiff[];
  /** 口径 = **本地单数**（不是渠道流水条数） */
  matchedCount: number;
}
```

⚠️ **不要写 `groupChannelRecords` 这样的「按 `referenceNo` 归组」的公开函数** ——
`reconcile` 的归组语义是「按 `matchLocal` 匹配到哪张本地单」分组（用 `payoutNo`
**或** `payoutTxnId`），与「按 `referenceNo` 分组」**不是一回事**。
首版计划里写了这么一个函数，它自己实现了排序却**没人调用**，
而它的注释「排序在这里」让人误以为排序已经生效 —— **结果 `reconcile` 一直在用未排序的组**。
→ 排序必须**在 `reconcile` 内部真正执行**（见 Step 2）。

- [ ] **Step 2: 写引擎的实现**

追加到 `api/src/modules/payment/payout-reconcile.engine.ts`：

```ts
/**
 * 把渠道流水按 `paidAt` 升序排好（**排序键要全序**，见 `compareProviderTxnId`）。
 *
 * ⚠️ **排序必须在 `reconcile` 内部真正执行** —— `pickAuthoritative` 的兜底规则
 *    「组内没有 SUCCESS → 取 `paidAt` 最晚的；全都没有 `paidAt` 的取最后一条」
 *    **依赖组内的顺序**。而渠道侧**不承诺输出顺序**
 *    （假网关按 `referenceNo` 分组输出，真渠道更是分页/倒序/按状态分组都有）
 *    → 不自己排序的话，同一份账单换个行序就会得出不同的结论。
 *
 * ⚠️ **CSV 账单不配 `paidAt` 列时，全部记录的 `paidAt` 都是 `undefined`**
 *    → 排序键完全为空 → **权威记录 100% 由数组顺序决定**。
 *    → 这就是「必须有 tie-break」的原因。
 */
function sortChannelRecords(
  records: ChannelPayoutRecord[],
): ChannelPayoutRecord[] {
  return [...records].sort((a, b) => {
    const at = a.paidAt?.getTime();
    const bt = b.paidAt?.getTime();
    if (at === undefined && bt === undefined) {
      return compareProviderTxnId(a, b);
    }
    if (at === undefined) return 1;   // 没有 paidAt 的排最后
    if (bt === undefined) return -1;
    if (at !== bt) return at - bt;
    return compareProviderTxnId(a, b);
  });
}

/**
 * tie-break：`providerTxnId` 的字典序。
 *
 * ⚠️ **必须有它** —— 两条记录 `paidAt` 完全相同时，比较结果为 0 →
 *    相对顺序取决于**输入顺序** → 权威记录仍会漂。
 *    加了它，排序就是**全序**，「同一份输入永远同一个结论」不再依赖数组初始顺序。
 */
function compareProviderTxnId(
  a: ChannelPayoutRecord,
  b: ChannelPayoutRecord,
): number {
  if (a.providerTxnId === b.providerTxnId) return 0;
  return a.providerTxnId < b.providerTxnId ? -1 : 1;
}

/**
 * 从一组里挑一条权威记录。
 *
 * 1. 组内有 `status === 'SUCCESS'` 的 → **取它**（有多条 SUCCESS 则取 `paidAt` 最晚的）
 * 2. 组内没有 SUCCESS → 取 `paidAt` 最晚的（没有 `paidAt` 的取最后一条）
 *
 * ⚠️ **第 2 条依赖组内已按 `paidAt` 升序排好** —— 见 `sortChannelRecords`。
 */
export function pickAuthoritative(
  group: ChannelPayoutRecord[],
): ChannelPayoutRecord {
  const successes = group.filter((r) => r.status === 'SUCCESS');
  if (successes.length > 0) {
    return latestByPaidAt(successes);
  }
  return latestByPaidAt(group);
}

/** 取 `paidAt` 最晚的一条；都没有 `paidAt` 时取数组最后一条 */
function latestByPaidAt(records: ChannelPayoutRecord[]): ChannelPayoutRecord {
  let best = records[records.length - 1];
  for (const record of records) {
    if (!record.paidAt) {
      continue;
    }
    if (!best.paidAt || record.paidAt.getTime() > best.paidAt.getTime()) {
      best = record;
    }
  }
  return best;
}
```

⚠️ **首版计划里 `groupChannelRecords` 的旧实现（已删，勿写）** ——
它把「先按 `paidAt` 升序排序再归组」写在了一个**没人调用**的函数里，
而 `reconcile` 自己重建了未排序的 `byReferenceNo` / `byTxnId` →
**排序从未生效**。实测后果：两条同 `referenceNo`、都无 `paidAt`、金额不同的流水，
输入顺序正着是「C 类金额不符（CRITICAL）」、倒过来是「匹配一致」
—— **金额差 1500 元的告警凭空消失**。

⚠️ **`reconcile` 步骤 ① 的归组循环之前必须先排序**：

```ts
  // ---- ① 把渠道流水归到本地单上 ----
  // ⚠️ **先排序** —— 见 `sortChannelRecords` 的说明
  const sortedRecords = sortChannelRecords(input.channelRecords);
  const byReferenceNo = new Map<string, ChannelPayoutRecord[]>();
  const byTxnId = new Map<string, ChannelPayoutRecord[]>();
  const orphanRecords: ChannelPayoutRecord[] = [];

  for (const record of sortedRecords) {
```

⚠️ **分组语义不变** —— `matchLocal` 的逻辑、`byReferenceNo` / `byTxnId` /
`orphanRecords` 三个容器、后续全部判定逻辑都保持原样，**只多一步排序**。

<details><summary>首版计划里那段已删除的实现（保留在此供对照，勿实现）</summary>

```ts
/**
 * 归组：把匹配到同一张本地单的所有渠道流水放进一组。
 *
 * ⚠️ **一单多流水是常态** —— 渠道重试会产生同一个 `referenceNo` 的多条流水
 * （第一次失败、第二次成功）→ 必须先归组再取权威记录，
 * 否则「第一次失败第二次成功」会被当成两条独立的记录。
 *
 * @returns 权威记录列表（每组一条）
 */
export function groupChannelRecords(
  records: ChannelPayoutRecord[],
): AuthoritativeRecord[] {
  const groups = new Map<string, ChannelPayoutRecord[]>();

  // ⚠️ **先按 `paidAt` 升序排序再归组** —— 「没有 `paidAt` 的取最后一条」
  //    这条兜底规则**依赖组内的顺序**。而渠道侧不承诺输出顺序
  //    （假网关按 `referenceNo` 分组输出，真渠道更是分页/倒序/按状态分组都有）
  //    → 不自己排序的话，同一份输入换个渠道顺序就会得出不同的结论。
  const sorted = [...records].sort((a, b) => {
    const at = a.paidAt?.getTime();
    const bt = b.paidAt?.getTime();
    if (at === undefined && bt === undefined) return 0;
    if (at === undefined) return 1;   // 没有 paidAt 的排最后
    if (bt === undefined) return -1;
    return at - bt;
  });

  for (const record of sorted) {
    // ⚠️ **归组键用 `referenceNo`** —— 渠道重试时 `providerTxnId` 会变，
    //    而 `referenceNo`（我们的 `payoutNo`）不变。
    //    没有 `referenceNo` 的记录按它自己的交易号单独成组。
    const key = record.referenceNo ?? `txn:${record.providerTxnId}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  const result: AuthoritativeRecord[] = [];
  for (const group of groups.values()) {
    result.push({ record: pickAuthoritative(group), group });
  }
  return result;
}

/**
 * 从一组里挑一条权威记录。
 *
 * 1. 组内有 `status === 'SUCCESS'` 的 → **取它**（有多条 SUCCESS 则取 `paidAt` 最晚的）
 * 2. 组内没有 SUCCESS → 取 `paidAt` 最晚的（没有 `paidAt` 的取最后一条）
 *
 * ⚠️ **第 2 条依赖组内已按 `paidAt` 升序排好** —— 见 `sortChannelRecords`。
 */
export function pickAuthoritative(
  group: ChannelPayoutRecord[],
): ChannelPayoutRecord {
  const successes = group.filter((r) => r.status === 'SUCCESS');
  if (successes.length > 0) {
    return latestByPaidAt(successes);
  }
  return latestByPaidAt(group);
}

/** 取 `paidAt` 最晚的一条；都没有 `paidAt` 时取数组最后一条 */
function latestByPaidAt(records: ChannelPayoutRecord[]): ChannelPayoutRecord {
  let best = records[records.length - 1];
  for (const record of records) {
    if (!record.paidAt) {
      continue;
    }
    if (!best.paidAt || record.paidAt.getTime() > best.paidAt.getTime()) {
      best = record;
    }
  }
  return best;
}
```

</details>

```ts
/**
 * 比对引擎的主函数（纯函数）。
 *
 * ## 判定顺序（设计 §四·4.4）
 *
 * ```
 * 第一步：归组（1a 匹配本地单 → 1b 同单归组 → 1c 取权威记录）
 * 第二步：逐张本地单对照它的权威渠道记录
 *   a. 渠道 SUCCESS 且 本地 PROCESSING      → A 类
 *   b. 渠道 SUCCESS 且 本地 FAILED         → B 类
 *   c. 渠道 SUCCESS 且 本地 PAID 且金额不同  → C 类
 *   d. 渠道 SUCCESS 且 本地 PAID 且金额一致  → 匹配
 *   e. 渠道 FAILED  且 本地 PAID           → F 类
 *   f. 渠道 FAILED  且 本地 FAILED         → 匹配
 *   g. 渠道非终态 / 其它组合               → 不算差异
 *   h. 没有权威渠道记录 且 本地是 PAID       → E 类
 * 第三步：没有匹配到任何本地单的渠道流水
 *   a. 时刻落在【扩大的窗口】内 → D 类
 *   b. 落在窗口外（时钟偏移导致的多余记录） → 忽略
 * ```
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const diffs: ReconcileDiff[] = [];
  let matchedCount = 0;

  // ---- ① 把渠道流水归到本地单上 ----
  const byReferenceNo = new Map<string, ChannelPayoutRecord[]>();
  const byTxnId = new Map<string, ChannelPayoutRecord[]>();
  const orphanRecords: ChannelPayoutRecord[] = [];

  for (const record of input.channelRecords) {
    const local = matchLocal(input.localPayouts, record);
    if (!local) {
      orphanRecords.push(record);
      continue;
    }
    if (record.referenceNo) {
      const list = byReferenceNo.get(record.referenceNo) ?? [];
      list.push(record);
      byReferenceNo.set(record.referenceNo, list);
    } else {
      const list = byTxnId.get(record.providerTxnId) ?? [];
      list.push(record);
      byTxnId.set(record.providerTxnId, list);
    }
  }

  // ---- ② 逐张本地单对照它的权威渠道记录 ----
  for (const local of input.localPayouts) {
    const group = [
      ...(byReferenceNo.get(local.payoutNo) ?? []),
      ...(local.payoutTxnId ? (byTxnId.get(local.payoutTxnId) ?? []) : []),
    ];

    if (group.length === 0) {
      // h 档：没有权威渠道记录且本地是 PAID → E 类
      if (local.status === PayoutStatus.PAID) {
        diffs.push({
          type: ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
          severity: ReconciliationSeverity.CRITICAL,
          payoutId: local.id,
          channelTxnId: null,
          channelReferenceNo: null,
          channelAmount: null,
          channelStatus: null,
          channelPaidAt: null,
          localAmount: local.netAmount,
          localStatus: local.status,
        });
      }
      // ⚠️ **其余状态没有权威渠道记录 → 不算差异**
      //    （本地 PROCESSING 但渠道查不到：可能渠道还没处理）
      continue;
    }

    const authoritative = pickAuthoritative(group);

    if (authoritative.status === 'SUCCESS') {
      if (local.status === PayoutStatus.PROCESSING) {
        // a 档 → A 类
        diffs.push(buildDiff(ReconciliationDiffType.CHANNEL_PENDING_LOCAL, ReconciliationSeverity.INFO, local, authoritative));
      } else if (local.status === PayoutStatus.FAILED) {
        // b 档 → B 类
        diffs.push(buildDiff(ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED, ReconciliationSeverity.WARNING, local, authoritative));
      } else if (local.status === PayoutStatus.PAID) {
        if (authoritative.amount !== local.netAmount) {
          // c 档 → C 类
          diffs.push(buildDiff(ReconciliationDiffType.AMOUNT_MISMATCH, ReconciliationSeverity.CRITICAL, local, authoritative));
        } else {
          // d 档 → 匹配
          matchedCount += 1;
        }
      } else {
        // ⚠️ **本地不是终态（REQUESTED / APPROVED）** → 不算差异
      }
    } else if (authoritative.status === 'FAILED') {
      if (local.status === PayoutStatus.PAID) {
        // e 档 → F 类（渠道明确拒付，本地却记已付）
        diffs.push(buildDiff(ReconciliationDiffType.STATUS_MISMATCH, ReconciliationSeverity.CRITICAL, local, authoritative));
      } else if (local.status === PayoutStatus.FAILED) {
        // f 档 → 双方一致说「没打出去」→ 匹配，不是差异
        matchedCount += 1;
      }
      // ⚠️ **本地是 PROCESSING 且渠道说 FAILED** → 不算差异
      //    （渠道说没打成功，本地还在等 → 正常的失败重试流程）
    } else {
      // g 档：渠道非终态 → **不算差异**
      //    「只有双方都声称终态且互相矛盾才是差异」
    }
  }

  // ---- ③ 没有匹配到任何本地单的渠道流水 ----
  for (const record of orphanRecords) {
    // ⚠️ **只在【扩大的窗口】内才算 D 类** —— 扩大的窗口会把名义窗口之外的
    //    渠道记录也拉进来（防时钟偏移），一律判成 D 类会凭空多出一堆假差异
    const paidAt = record.paidAt;
    if (!paidAt) {
      continue;
    }
    const t = paidAt.getTime();
    if (
      t < input.expandedWindow.from.getTime() ||
      t >= input.expandedWindow.to.getTime()
    ) {
      continue;
    }
    diffs.push({
      type: ReconciliationDiffType.CHANNEL_ONLY,
      severity: ReconciliationSeverity.CRITICAL,
      payoutId: null,
      channelTxnId: record.providerTxnId,
      channelReferenceNo: record.referenceNo ?? null,
      channelAmount: record.amount,
      channelStatus: record.status,
      channelPaidAt: paidAt,
      localAmount: null,
      localStatus: null,
    });
  }

  return { diffs, matchedCount };
}

/**
 * 把一条渠道流水匹配到本地单。
 *
 * ⚠️ **匹配键的优先级**（设计 §二·2.2）：
 * 1. `referenceNo`（= 我们的 `payoutNo`）—— 真渠道账单一般带「商户订单号」→ 首选
 * 2. `providerTxnId`（= 我们的 `payoutTxnId`）—— 渠道账单未必回显
 *
 * ⚠️ **`payoutTxnId` 没有唯一约束** → 命中**多张**本地单时，
 * **按 `paidAt` / `failedAt` 最新的一张取**，不要静默取第一条。
 */
function matchLocal(
  locals: LocalPayoutForReconcile[],
  record: ChannelPayoutRecord,
): LocalPayoutForReconcile | undefined {
  if (record.referenceNo) {
    const byNo = locals.find((l) => l.payoutNo === record.referenceNo);
    if (byNo) {
      return byNo;
    }
  }
  if (record.providerTxnId) {
    const candidates = locals.filter((l) => l.payoutTxnId === record.providerTxnId);
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      // ⚠️ **多命中 → 取最新的一张**（不要静默取第一条）
      return [...candidates].sort(
        (a, b) => localTimestamp(b) - localTimestamp(a),
      )[0];
    }
  }
  return undefined;
}

/** 本地单的业务时刻（`paidAt` → `failedAt` → `processingAt` → 0） */
function localTimestamp(local: LocalPayoutForReconcile): number {
  return (
    local.paidAt?.getTime() ??
    local.failedAt?.getTime() ??
    local.processingAt?.getTime() ??
    0
  );
}

/** 组装一条差异 */
function buildDiff(
  type: ReconciliationDiffType,
  severity: ReconciliationSeverity,
  local: LocalPayoutForReconcile,
  authoritative: ChannelPayoutRecord,
): ReconcileDiff {
  return {
    type,
    severity,
    payoutId: local.id,
    channelTxnId: authoritative.providerTxnId,
    channelReferenceNo: authoritative.referenceNo ?? null,
    channelAmount: authoritative.amount,
    channelStatus: authoritative.status,
    channelPaidAt: authoritative.paidAt ?? null,
    localAmount: local.netAmount,
    localStatus: local.status,
  };
}
```

- [ ] **Step 3: 写引擎的单测**

新建 `api/src/modules/payment/payout-reconcile.engine.spec.ts`：

```ts
import { PayoutStatus, ReconciliationDiffType } from '@prisma/client';
import {
  LocalPayoutForReconcile,
  reconcile,
} from './payout-reconcile.engine';
import type { ChannelPayoutRecord } from '../../common/payment/payout-provider.interface';

/**
 * 比对引擎的单元测试。
 *
 * ⚠️ **这是「A–F 六类差异」的判据表** —— 每一条判定都必须有一个用例。
 *    判定顺序错一档，对账的结论就全错。
 */

const FROM = new Date('2026-03-01T00:00:00.000Z');
const TO = new Date('2026-03-08T00:00:00.000Z');
const EXPANDED = {
  from: new Date(FROM.getTime() - 15 * 60 * 60 * 1000),
  to: new Date(TO.getTime() + 15 * 60 * 60 * 1000),
};

function local(over: Partial<LocalPayoutForReconcile> = {}): LocalPayoutForReconcile {
  return {
    id: 'payout-1',
    payoutNo: 'PAY1',
    payoutTxnId: null,
    status: PayoutStatus.PROCESSING,
    netAmount: 8500,
    receiptAmount: 8500,
    commissionAmount: 0,
    entryCount: 1,
    paidAt: null,
    processingAt: new Date('2026-03-02T00:00:00.000Z'),
    failedAt: null,
    ...over,
  };
}

function channel(over: Partial<ChannelPayoutRecord> = {}): ChannelPayoutRecord {
  return {
    referenceNo: 'PAY1',
    providerTxnId: 'txn-1',
    amount: 8500,
    status: 'SUCCESS',
    paidAt: new Date('2026-03-02T00:10:00.000Z'),
    ...over,
  };
}

describe('比对引擎', () => {
  it('A 类：渠道 SUCCESS + 本地 PROCESSING', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [channel()],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.CHANNEL_PENDING_LOCAL);
    expect(result.diffs[0].payoutId).toBe('payout-1');
    expect(result.matchedCount).toBe(0);
  });

  it('B 类：渠道 SUCCESS + 本地 FAILED', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({ status: PayoutStatus.FAILED, processingAt: null, failedAt: new Date('2026-03-02T00:00:00.000Z') }),
      ],
      channelRecords: [channel()],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED);
  });

  it('C 类：渠道 SUCCESS + 本地 PAID + 金额不同', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel({ amount: 9999 })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.AMOUNT_MISMATCH);
    expect(result.diffs[0].channelAmount).toBe(9999);
    expect(result.diffs[0].localAmount).toBe(8500);
  });

  it('C 类：渠道 SUCCESS + 本地 PAID + 渠道金额更小（渠道少打了钱）', () => {
    // ⚠️ **两个方向都要覆盖** —— 上面那条夹具是「渠道金额更大」（9999 vs 8500），
    //    只覆盖那一边的话，把判定从 `!==` 改成 `>` 仍然成立 → 变异验证不红。
    //    「渠道少打了钱」才是这个判定真正要咬住的方向。
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel({ amount: 8000 })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.AMOUNT_MISMATCH);
    expect(result.diffs[0].channelAmount).toBe(8000);
    expect(result.diffs[0].localAmount).toBe(8500);
  });

  it('D 类：渠道有、本地没有', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [],
      channelRecords: [channel({ referenceNo: 'PAY-UNKNOWN' })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.CHANNEL_ONLY);
    expect(result.diffs[0].payoutId).toBeNull();
  });

  it('E 类：本地已付 + 渠道查无此笔', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT);
    expect(result.diffs[0].payoutId).toBe('payout-1');
  });

  it('F 类：渠道 FAILED + 本地 PAID（渠道明确拒付）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel({ status: 'FAILED' })],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.STATUS_MISMATCH);
  });

  it('⚠️ 匹配一致（渠道 SUCCESS + 本地 PAID + 金额一致）→ 不落差异', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel()],
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(1);
  });

  it('⚠️ 双方都说失败 → 匹配，不是差异', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.FAILED,
          processingAt: null,
          failedAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel({ status: 'FAILED' })],
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(1);
  });

  it('⚠️ 渠道非终态 + 本地 PAID → 不算差异（g 档）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
      ],
      channelRecords: [channel({ status: 'PROCESSING' })],
    });

    expect(result.diffs).toHaveLength(0);
    // ⚠️ **必须断言 `matchedCount`** —— 只断言 `diffs` 长度时这条规则没有牙齿：
    //    把判定从 `=== 'SUCCESS'` 改成 `!== 'FAILED'` 后，非终态记录会被当成
    //    「已匹配」，`matchedCount` 从 0 变成 1，而 `diffs` 长度仍是 0 → 用例照样绿。
    //    而 `matchedCount` 是对账列表上展示的口径，虚增会让运营以为渠道侧已对上。
    expect(result.matchedCount).toBe(0);
  });

  it('⚠️ 一单多流水：先失败后成功 → 取 SUCCESS 那条（权威记录）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [
        channel({
          providerTxnId: 'txn-fail',
          status: 'FAILED',
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
        channel({
          providerTxnId: 'txn-ok',
          status: 'SUCCESS',
          paidAt: new Date('2026-03-02T00:10:00.000Z'),
        }),
      ],
    });

    // ⚠️ **只有一条差异** —— 两条流水归到同一组，取权威记录
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.CHANNEL_PENDING_LOCAL);
    expect(result.diffs[0].channelTxnId).toBe('txn-ok');
  });

  it('⚠️ 一单多流水：SUCCESS 那条 paidAt 更早 → 仍必须取 SUCCESS（不能被更晚的 FAILED 盖掉）', () => {
    // ⚠️ **这一条守的是资金安全** —— 上面那条用例里 SUCCESS 的 `paidAt` 更晚，
    //    所以「优先 SUCCESS」与「取 paidAt 最晚」结果相同 → 去掉「优先 SUCCESS」也不变红。
    //    方向反过来（SUCCESS 更早）才是承重的：去掉「优先 SUCCESS」会让
    //    **A 类差异整条丢失**（渠道已打款、本地卡 PROCESSING 的告警凭空消失）。
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [
        channel({
          providerTxnId: 'txn-ok',
          status: 'SUCCESS',
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
        }),
        channel({
          providerTxnId: 'txn-fail',
          status: 'FAILED',
          paidAt: new Date('2026-03-02T00:20:00.000Z'),
        }),
      ],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].type).toBe(ReconciliationDiffType.CHANNEL_PENDING_LOCAL);
    // ⚠️ **必须是 SUCCESS 那条** —— 不能是时间更晚的 FAILED
    expect(result.diffs[0].channelTxnId).toBe('txn-ok');
    expect(result.diffs[0].channelStatus).toBe('SUCCESS');
  });

  it('⚠️ 多条 SUCCESS → 取 paidAt 最晚的那条', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [local()],
      channelRecords: [
        channel({ providerTxnId: 'txn-old', paidAt: new Date('2026-03-02T00:00:00.000Z') }),
        channel({ providerTxnId: 'txn-new', paidAt: new Date('2026-03-02T00:30:00.000Z') }),
      ],
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].channelTxnId).toBe('txn-new');
  });

  it('⚠️ D 类只认「扩大窗口内」的渠道记录', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [],
      channelRecords: [
        channel({
          referenceNo: 'PAY-OUT-OF-WINDOW',
          // ⚠️ **落在扩大窗口之外** → 忽略（时钟偏移导致的多余记录）
          paidAt: new Date(EXPANDED.to.getTime() + 60_000),
        }),
      ],
    });

    expect(result.diffs).toHaveLength(0);
  });

  it('⚠️ 按 providerTxnId 也能匹配上本地单（渠道账单不回显业务单号）', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.PAID,
          processingAt: null,
          paidAt: new Date('2026-03-02T00:00:00.000Z'),
          payoutTxnId: 'txn-1',
        }),
      ],
      channelRecords: [channel({ referenceNo: undefined })],
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.matchedCount).toBe(1);
  });

  it('⚠️ 本地不是终态（REQUESTED）→ 不算差异', () => {
    const result = reconcile({
      window: { from: FROM, to: TO },
      expandedWindow: EXPANDED,
      localPayouts: [
        local({
          status: PayoutStatus.REQUESTED,
          processingAt: null,
          paidAt: null,
          failedAt: null,
        }),
      ],
      channelRecords: [],
    });

    expect(result.diffs).toHaveLength(0);
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
cd api && npx jest payout-reconcile.engine
```

预期：14 个用例全部通过。

- [ ] **Step 5: 变异验证（必做）**

⚠️ **单测全绿不等于判定写对了** —— 引擎的判定顺序错一档，结论全错。

逐条改坏下面这几处，**每次改完跑测试，必须有对应的用例变红**，改完立刻改回来：

| 改坏什么 | 必须变红的用例 |
|---|---|
| `authoritative.status === 'SUCCESS'` 改成 `!== 'FAILED'` | 「渠道非终态 + 本地 PAID → 不算差异」（**靠 `matchedCount` 断言**） |
| A 档的 `local.status === PayoutStatus.PROCESSING` 改成 `!== PayoutStatus.FAILED` | 「C 类」「匹配一致」「按 providerTxnId 匹配」 |
| C 档的 `authoritative.amount !== local.netAmount` 改成 `>` | 「C 类：…渠道金额更小（渠道少打了钱）」 |
| `pickAuthoritative` 里去掉「优先 SUCCESS」 | 「一单多流水：SUCCESS 那条 paidAt 更早 → 仍必须取 SUCCESS」 |
| D 档去掉「扩大窗口内」的判断 | 「D 类只认扩大窗口内的渠道记录」 |
| E 档的 `local.status === PayoutStatus.PAID` 改成 `!== PayoutStatus.FAILED` | 「本地不是终态（REQUESTED）」 |

验证完把代码改回来，测试重新全绿。

⚠️ **这张表在实施期被修正过** —— 首版的「必须变红的用例」有两处写错了名字，
而且其中三行**改坏了也不会变红**（测试夹具没覆盖到变异真正影响的方向）：

| 原写法 | 为什么不变红 | 补法 |
|---|---|---|
| g 档用例只断言 `diffs` 长度为 0 | 非终态被算成「已匹配」→ `matchedCount` 从 0 变 1，但 `diffs` 长度不变 | 给那条用例补 `expect(result.matchedCount).toBe(0)` |
| C 档夹具用「渠道金额**更大**」（9999 vs 8500） | `9999 > 8500` 仍成立 → 改成 `>` 不改结论 | 另加一条「渠道金额**更小**」（8000 vs 8500）的用例 |
| 「一单多流水」夹具里 SUCCESS 的 `paidAt` **更晚** | 「优先 SUCCESS」与「取 paidAt 最晚」结果相同 → 去掉前者也不改结论 | 另加一条 SUCCESS 的 `paidAt` **更早**的用例（方向反过来才承重） |

⚠️ **第三条的后果最重**：去掉「优先 SUCCESS」后，**A 类差异会整条丢失**
（渠道已打款、本地卡 PROCESSING 的资金安全告警凭空消失），而没有测试会红。

- [ ] **Step 6: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/src/modules/payment/payout-reconcile.engine.ts \
        api/src/modules/payment/payout-reconcile.engine.spec.ts
git commit -m "feat(payment): 渠道对账的比对引擎（纯函数）

把「哪些本地单、哪些渠道流水」两个集合交给引擎，引擎只做归组与差异分类
（A–F 六类），不查库不改库。

一单多流水（渠道重试）先归组再取权威记录：有 SUCCESS 取 SUCCESS
（多条取 paidAt 最晚的），否则取 paidAt 最晚的。判定顺序按设计 §四·4.4
写成九档 —— 只有「双方都声称终态且互相矛盾」才是差异，渠道非终态一律不算。

D 类只认落在扩大窗口内的渠道记录，否则每次对账都会凭空多出一堆假差异。"
```

---

### Task 5: 契约下沉 + 核实服务（把渠道表搬进全局模块）

**Files:**
- Move: `api/src/modules/payment/payout-provider.interface.ts` → `api/src/common/payment/payout-provider.interface.ts`
- Move: `api/src/modules/payment/fake-payout.provider.ts` → `api/src/common/payment/fake-payout.provider.ts`
- Move: `api/src/modules/payment/fake-payout.provider.spec.ts` → `api/src/common/payment/fake-payout.provider.spec.ts`
- Create: `api/src/common/payment/payout.constants.ts`
- Create: `api/src/common/payment/payout-verification.ts`
- Create: `api/src/common/payment/payout-verification.service.ts`
- Create: `api/src/common/payment/payout-verification.service.spec.ts`
- Create: `api/src/common/payment/payout-providers.module.ts`
- Modify: `api/src/modules/payment/payment.module.ts`
- Modify: `api/src/modules/payment/payment.constants.ts`
- Modify: `api/src/modules/payment/payout.worker.ts`
- Modify: `api/src/modules/payment/fake-payout.controller.ts`
- Modify: `api/src/modules/payment/payout-worker.spec.ts`
- Modify: `api/test/payout-execution.e2e-spec.ts`
- Modify: `api/test/payout-encryption.e2e-spec.ts`

**依赖：** Task 1（`payout_reconciliation_items` 表）、Task 2（`queryPayout` 新签名）。

⚠️ **这个 Task 解决的是「billing 怎么注入核实服务」** —— 见 §0.1。**不要**改成「billing import payment」。

- [ ] **Step 1: 搬文件（用 `git mv` 保留历史）**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
mkdir -p api/src/common/payment
git mv api/src/modules/payment/payout-provider.interface.ts api/src/common/payment/payout-provider.interface.ts
git mv api/src/modules/payment/fake-payout.provider.ts api/src/common/payment/fake-payout.provider.ts
git mv api/src/modules/payment/fake-payout.provider.spec.ts api/src/common/payment/fake-payout.provider.spec.ts
```

- [ ] **Step 2: 改全部 10 处 import**

| 文件 | 改法 |
|---|---|
| `api/src/common/payment/fake-payout.provider.ts` | `from './payout-provider.interface'` → **不变**（同目录了） |
| `api/src/common/payment/fake-payout.provider.spec.ts` | `from './fake-payout.provider'` → **不变** |
| `api/src/modules/payment/payout.worker.ts:11` | `from './payout-provider.interface'` → `from '../../common/payment/payout-provider.interface'` |
| `api/src/modules/payment/payout.worker.ts:12` | `from './payment.constants'` → `from '../../common/payment/payout.constants'` |
| `api/src/modules/payment/fake-payout.controller.ts:15` | `from './fake-payout.provider'` → `from '../../common/payment/fake-payout.provider'` |
| `api/src/modules/payment/payment.constants.ts:2` | `from './payout-provider.interface'` → `from '../../common/payment/payout-provider.interface'` |
| `api/src/modules/payment/payment.module.ts:18` | `from './fake-payout.provider'` → `from '../../common/payment/fake-payout.provider'` |
| `api/src/modules/payment/payment.module.ts:23` | `from './payout-provider.interface'` → `from '../../common/payment/payout-provider.interface'` |
| `api/src/modules/payment/payout-worker.spec.ts:7` | `from './payout-provider.interface'` → `from '../../common/payment/payout-provider.interface'` |
| `api/test/payout-execution.e2e-spec.ts:18` | `from '../src/modules/payment/fake-payout.provider'` → `from '../src/common/payment/fake-payout.provider'` |
| `api/test/payout-encryption.e2e-spec.ts:17` | 同上 | 

⚠️ `api/src/modules/payment/payout.worker.ts:12` 改的是 `PAYOUT_PROVIDERS` 的来源 —— 它现在住在 `common/payment/payout.constants.ts`（Step 3 新建）。**Step 2 与 Step 3 要一起做完才能编译过。**

- [ ] **Step 3: 新建 `api/src/common/payment/payout.constants.ts`**

```ts
import type { PayoutProvider } from './payout-provider.interface';

/**
 * 出款渠道表的注入令牌。
 *
 * ⚠️ **为什么住在 `common/`**（阶段 5m）——
 *    渠道表要在一个 `@Global()` 模块里注册（见 `payout-providers.module.ts`），
 *    这样 **billing 模块也能拿到它** —— 而 billing **绝对不能 import payment**
 *    （那会成 `order → billing → payment → order` 的环，NestJS 启动报错）。
 *    契约与实现一起下沉到 `common/`，是绕开这个死结的唯一办法。
 */
export const PAYOUT_PROVIDERS = 'PAYOUT_PROVIDERS';

/** 出款渠道表的类型别名 */
export type PayoutProviderMap = Map<string, PayoutProvider>;
```

- [ ] **Step 4: 改 `api/src/modules/payment/payment.constants.ts`（只保留收款的，转发出款的）**

```ts
import type { PaymentProvider } from './payment-provider.interface';

/**
 * 渠道表的注入令牌。
 *
 * ⚠️ 用一个**字符串令牌**而不是某个具体的 provider 类：
 * 渠道表的内容是「渠道名 → provider」的映射，将来接真渠道时
 * 多注册一个 provider 就行，不必改消费方的注入方式。
 */
export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

/** 渠道表的类型别名 */
export type PaymentProviderMap = Map<string, PaymentProvider>;

/**
 * ⚠️ **出款渠道表的 token 与类型已下沉到 `common/`**（阶段 5m）。
 *
 * 原因：渠道表要在一个 `@Global()` 模块里注册，billing 才能拿到它 ——
 * 而 billing **绝对不能 import payment**（会成模块环）。
 * 这里保留一个 re-export，让 payment 模块内部的引用点不必全改。
 */
export {
  PAYOUT_PROVIDERS,
  type PayoutProviderMap,
} from '../../common/payment/payout.constants';
```

- [ ] **Step 5: 新建 `api/src/common/payment/payout-verification.ts`（纯契约）**

```ts
/**
 * 出款核实的契约（阶段 5m）。
 *
 * ⚠️ **纯契约，不 import 任何模块** —— 仿 `common/queue/queue.constants.ts` 的先例。
 *    跨模块契约放 `common/` 是本仓的既定做法。
 *
 * ⚠️ **为什么需要它**：`billing` 模块的 `PayoutService.unstick` 要做「渠道核实闸」
 *    （防止重复打款），但 **billing 绝对不能 import payment**（模块环）。
 *    → 契约下沉到 `common/`，实现放能拿到渠道表的地方，billing 按 token 注入。
 */

/** 核实的对象（一张出款单） */
export interface PayoutVerificationTarget {
  /** 出款单 id */
  id: string;
  /** 出款单号（= 传给渠道的 `referenceNo`，**所有调过渠道的单都有**） */
  payoutNo: string;
  /** 渠道交易号（⚠️ `PAID` 的单才有；`PROCESSING` 的单没有） */
  payoutTxnId: string | null;
}

/** 核实的结论 */
export interface PayoutVerificationVerdict {
  /** `PAID` = 渠道说钱打了；`FAILED` = 渠道说没打；`UNKNOWN` = 问不出结论 */
  verdict: 'PAID' | 'FAILED' | 'UNKNOWN';
  /** 结论来源 */
  source: 'REALTIME' | 'RECONCILIATION' | 'NONE';
  /** 渠道交易号（渠道说了才给） */
  providerTxnId?: string;
  /** 渠道侧金额（分） */
  amount?: number;
  /** 渠道侧打款时刻 */
  paidAt?: Date;
}

/** 核实能力（billing 按 token 注入这个接口） */
export interface PayoutVerification {
  verify(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict>;
}

/** 注入令牌 */
export const PAYOUT_VERIFICATION = Symbol('PAYOUT_VERIFICATION');
```

- [ ] **Step 6: 新建 `api/src/common/payment/payout-verification.service.ts`（三层核实实现）**

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../tenant/tenant-context';
import { PAYOUT_PROVIDERS } from './payout.constants';
import type { PayoutProvider } from './payout-provider.interface';
import {
  PAYOUT_VERIFICATION,
  PayoutVerification,
  PayoutVerificationTarget,
  PayoutVerificationVerdict,
} from './payout-verification';

/**
 * 出款核实服务（阶段 5m）。
 *
 * ## 三层核实（设计 §六·6.3）
 *
 * ```
 * 第 1 层：实时渠道核实
 *   → provider.queryPayout({ referenceNo: payout.payoutNo })
 *   → 渠道说 SUCCESS → 拒绝解卡（并纠正为 PAID）
 *   → 渠道说 FAILED  → 允许解卡（渠道明确说没打）
 *   → 核实不可用 → 第 2 层
 *
 * 第 2 层：查该单最近一次对账结果
 *   → 渠道结论 SUCCESS → 同上
 *   → 渠道结论 FAILED  → 允许解卡
 *   → 没有对账记录 → 第 3 层
 *
 * 第 3 层：fail-closed
 *   → UNKNOWN，调用方拒绝解卡
 * ```
 *
 * ⚠️ **这套逻辑有且只有一处实现** —— 解卡闸与 B 类人工处置的闸 ④ 都调它，
 *    不各写一遍。
 *
 * ⚠️ **「渠道查不到这条」不等于「渠道说没打」** —— 只有渠道**明确说 FAILED**
 *    才放行。其余一律 fail-closed。
 */
@Injectable()
export class PayoutVerificationService implements PayoutVerification {
  private readonly logger = new Logger(PayoutVerificationService.name);

  constructor(
    @Inject(PAYOUT_PROVIDERS)
    private readonly providers: Map<string, PayoutProvider>,
    private readonly prisma: TenantPrismaService,
  ) {}

  async verify(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict> {
    const realtime = await this.verifyRealtime(target);
    if (realtime) {
      return realtime;
    }
    const fromReconciliation = await this.verifyFromReconciliation(target);
    if (fromReconciliation) {
      return fromReconciliation;
    }
    return { verdict: 'UNKNOWN', source: 'NONE' };
  }

  /** 第 1 层：实时渠道核实 */
  private async verifyRealtime(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict | null> {
    const provider = this.pickProvider();
    if (!provider) {
      return null;
    }
    try {
      // ⚠️ **用 referenceNo（payoutNo），不是 providerTxnId** ——
      //    `PROCESSING` 的单**没有** `payoutTxnId`（Task 3 起只有落 `FAILED`
      //    时才写它，落 `PAID` 时由 `markPaid` 写），所以 `referenceNo`
      //    是**唯一对所有状态都成立**的查询键。
      const result = await provider.queryPayout({
        referenceNo: target.payoutNo,
      });
      if (result.status === 'SUCCESS') {
        return {
          verdict: 'PAID',
          source: 'REALTIME',
          amount: result.amount,
          paidAt: result.paidAt,
        };
      }
      if (result.status === 'FAILED') {
        return { verdict: 'FAILED', source: 'REALTIME' };
      }
      // ⚠️ **渠道非终态 → 问不出结论** → 交给下一层
      this.logger.warn(
        `出款 ${target.id} 的渠道核实返回非终态（${result.status}），降级查对账结果`,
      );
      return null;
    } catch (error) {
      // ⚠️ **渠道不可用（抛错）→ 不是「渠道说没打」** → 交给下一层
      this.logger.warn(
        `出款 ${target.id} 的渠道核实失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** 第 2 层：查该单最近一次对账结果 */
  private async verifyFromReconciliation(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict | null> {
    // ⚠️ **`payout_reconciliation_items` 不受租户作用域约束**（无 tenantId）
    //    → 裸 delegate，返回的是全平台事实。查的是**已知 id**，
    //    不会跨租户泄露（`payoutId` 由调用方给出）。
    const items = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliationItem.findMany({
        where: { payoutId: target.id },
        orderBy: { createdAt: 'desc' },
        take: 1,
      }),
    );
    if (items.length === 0) {
      return null;
    }
    const item = items[0];
    if (item.channelStatus === 'SUCCESS') {
      return {
        verdict: 'PAID',
        source: 'RECONCILIATION',
        providerTxnId: item.channelTxnId ?? undefined,
        amount: item.channelAmount ?? undefined,
        paidAt: item.channelPaidAt ?? undefined,
      };
    }
    if (item.channelStatus === 'FAILED') {
      return { verdict: 'FAILED', source: 'RECONCILIATION' };
    }
    return null;
  }

  /**
   * 取渠道实现。
   *
   * ⚠️ **本阶段只有一个渠道（本地假网关）→ 取第一个**。
   * ⚠️ **将来接第二家时这里要改成按 `payouts.payoutChannel` 取** ——
   *    取「第一个」的话，加了第二家之后会查错渠道。
   *    ⚠️ 注意 `PROCESSING` 的单**还没有 `payoutChannel`**（那是 markPaid 写的）
   *    → 将来需要用 `payoutNo` 前缀或别的约定来定位渠道。
   */
  private pickProvider(): PayoutProvider | undefined {
    for (const provider of this.providers.values()) {
      return provider;
    }
    return undefined;
  }
}
```

- [ ] **Step 7: 新建 `api/src/common/payment/payout-providers.module.ts`（`@Global()`）**

```ts
import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../../modules/tenancy/tenancy.module';
import { FakePayoutProvider } from './fake-payout.provider';
import { PAYOUT_PROVIDERS } from './payout.constants';
import type { PayoutProvider } from './payout-provider.interface';
import { PAYOUT_VERIFICATION } from './payout-verification';
import { PayoutVerificationService } from './payout-verification.service';

/**
 * 出款渠道与出款核实的**全局模块**（阶段 5m）。
 *
 * ## 为什么必须是全局的
 *
 * `billing` 模块的 `PayoutService.unstick` 要做「渠道核实闸」（防重复打款），
 * 但 **`billing` 绝对不能 import `payment`** —— 那会成
 * `order → billing → payment → order` 的环，NestJS 启动直接报错
 * （见 `billing.module.ts` 顶部的模块注释）。
 *
 * → 把渠道表与核实服务放进一个 `@Global()` 模块 → **不产生模块依赖边**，
 *   billing 直接 `@Inject(PAYOUT_VERIFICATION)` 就能拿到。
 *
 * ## 依赖方向
 *
 * ```
 * common/payment/payout-providers.module.ts（@Global）
 *   ├─ FakePayoutProvider
 *   ├─ PAYOUT_PROVIDERS（渠道表）
 *   ├─ PayoutVerificationService（三层核实实现）
 *   └─ PAYOUT_VERIFICATION（契约 token，指向上面那个实现）
 *        ↓ 全局可见，任何模块都能注入
 *   billing/PayoutService、payment/PayoutVerificationService
 * ```
 *
 * ⚠️ **本模块 import `TenancyModule` 是安全的** —— `TenancyModule` 不 import
 *    任何模块，它只是把 `common/tenant` 里的服务注册成全局。
 *    不构成环。
 */
@Global()
@Module({
  imports: [TenancyModule],
  providers: [
    FakePayoutProvider,
    {
      provide: PAYOUT_PROVIDERS,
      useFactory: (fake: FakePayoutProvider): Map<string, PayoutProvider> => {
        const providers = new Map<string, PayoutProvider>();
        providers.set(fake.channel, fake);
        return providers;
      },
      inject: [FakePayoutProvider],
    },
    PayoutVerificationService,
    {
      provide: PAYOUT_VERIFICATION,
      useExisting: PayoutVerificationService,
    },
  ],
  exports: [FakePayoutProvider, PAYOUT_PROVIDERS, PAYOUT_VERIFICATION],
})
export class PayoutProvidersModule {}
```

- [ ] **Step 8: 改 `api/src/modules/payment/payment.module.ts`**

① `imports` 加上全局模块：

```ts
  imports: [
    AuthModule,
    OrderModule,
    CouponModule,
    BillingModule,
    // ⚠️ **出款渠道表与核实服务**（阶段 5m）——
    //    `@Global()` 模块，不产生模块依赖边（billing 也要用它）。
    PayoutProvidersModule,
  ],
```

② `providers` 里**删掉** `FakePayoutProvider` 与 `{ provide: PAYOUT_PROVIDERS, useFactory: ... }` 那一块（改由全局模块提供）。

③ 删掉不再需要的 import：`FakePayoutProvider`、`PayoutProvider`、`PAYOUT_PROVIDERS`（`PAYMENT_PROVIDERS` 保留 —— 它还在 `payment.constants.ts` 里）。

⚠️ **保留 `PAYMENT_PROVIDERS` 的 useFactory**（收款的假网关没动）。

- [ ] **Step 9: 写核实服务的单测**

新建 `api/src/common/payment/payout-verification.service.spec.ts`：

```ts
import { PayoutVerificationService } from './payout-verification.service';
import type { PayoutProvider } from './payout-provider.interface';

/**
 * 核实服务的单元测试（阶段 5m）。
 *
 * ⚠️ **三档结论各要一条** —— `PAID` / `FAILED` / `UNKNOWN`。
 *    `UNKNOWN` 这档最容易被漏测，而它恰恰是「宁可不做也不重复打款」的落点。
 */

function fakeProvider(over: Partial<PayoutProvider> = {}): PayoutProvider {
  return {
    channel: 'fake-payout',
    provider: 'fake-payout',
    execute: jest.fn(),
    queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    listPayouts: jest.fn(() => Promise.resolve([])),
    ...over,
  };
}

const target = {
  id: 'payout-1',
  payoutNo: 'PAY1',
  payoutTxnId: null,
};

describe('PayoutVerificationService', () => {
  it('第 1 层：渠道说 SUCCESS → PAID', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'SUCCESS', amount: 8500 }),
      ),
    });
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany: jest.fn(() => Promise.resolve([])) } } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('PAID');
    expect(verdict.source).toBe('REALTIME');
    expect(verdict.amount).toBe(8500);
  });

  it('第 1 层：渠道说 FAILED → FAILED', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'FAILED' })),
    });
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany: jest.fn(() => Promise.resolve([])) } } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('FAILED');
    expect(verdict.source).toBe('REALTIME');
  });

  it('⚠️ 第 1 层查不到 → 降级查对账结果', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          channelStatus: 'SUCCESS',
          channelTxnId: 'txn-9',
          channelAmount: 8500,
          channelPaidAt: new Date('2026-03-02T00:00:00.000Z'),
        },
      ]),
    );
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('PAID');
    expect(verdict.source).toBe('RECONCILIATION');
    expect(verdict.providerTxnId).toBe('txn-9');
  });

  it('⚠️ 渠道抛错 → 降级查对账结果（不是「渠道说没打」）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.reject(new Error('渠道不可用'))),
    });
    const findMany = jest.fn(() => Promise.resolve([]));
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    const verdict = await service.verify(target);

    // ⚠️ **绝不能是 FAILED** —— 渠道挂了就当「渠道说没打」→ 会放行解卡 → 重复打款
    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 问不出结论 → UNKNOWN（fail-closed）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany: jest.fn(() => Promise.resolve([])) } } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 核实用的是 referenceNo（payoutNo），不是 payoutTxnId', async () => {
    const queryPayout = jest.fn(() => Promise.resolve({ status: 'FAILED' }));
    const service = new PayoutVerificationService(
      new Map([['fake-payout', fakeProvider({ queryPayout })]]),
      { payoutReconciliationItem: { findMany: jest.fn(() => Promise.resolve([])) } } as never,
    );

    await service.verify(target);

    // ⚠️ **PROCESSING 的单没有 payoutTxnId** —— 只按交易号查 → 核实闸对它的
    //    全部对象都是死代码 → 解卡功能 100% 不可用
    expect(queryPayout).toHaveBeenCalledWith({ referenceNo: 'PAY1' });
  });
});
```

- [ ] **Step 10: 验证**

```bash
cd api && npx tsc --noEmit
```

预期：无输出。

```bash
cd api && npx jest payout-verification fake-payout.provider payout-worker
```

预期：三个文件全部通过。

```bash
cd api && npx jest --passWithNoTests
```

预期：全部通过。

- [ ] **Step 11: 验证「没有模块环」**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
grep -rn "modules/payment" api/src/modules/billing/ || echo "OK：billing 没有依赖 payment"
```

预期：输出 `OK：billing 没有依赖 payment`。

⚠️ **这一步是本 Task 的核心护栏** —— billing 一旦 import payment，NestJS 启动就会报循环依赖。

- [ ] **Step 12: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add -A api/src/common/payment api/src/modules/payment api/test
git commit -m "refactor(payment): 出款渠道表与核实服务下沉到 common 的全局模块

billing 模块的 unstick 要做「渠道核实闸」（防重复打款），但 billing 绝对
不能 import payment —— 那会成 order → billing → payment → order 的环，
NestJS 启动直接报错。

解法：把渠道表、假网关、核实契约与实现一起下沉到 common/payment，
用一个 @Global() 的 PayoutProvidersModule 注册。全局模块不产生模块
依赖边，billing 直接 @Inject(PAYOUT_VERIFICATION) 就能拿到。

核实服务实现三层：实时渠道核实 → 查最近一次对账结果 → fail-closed。
「渠道查不到这条」不等于「渠道说没打」，只有渠道明确说 FAILED 才放行。"
```

---

### Task 6: 差异处置（A 类自动纠正 + B 类人工四道闸）

**Files:**
- Modify: `api/src/modules/billing/payout-execution.service.ts`（新增 `confirmPaidAfterReconciliation`）
- Modify: `api/src/modules/billing/billing.module.ts`（`PayoutExecutionService` 注入 `PAYOUT_VERIFICATION`）
- Create: `api/src/modules/payment/payout-reconciliation-resolver.service.ts`
- Test: `api/test/payout-reconciliation.e2e-spec.ts`（新建，本 Task 先放 A/B 两类用例）

**依赖：** Task 1（表与枚举）、Task 3（`releasedEntryIds` 与 `payoutTxnId`）、Task 4（差异类型）、Task 5（核实服务）。

- [ ] **Step 1: `PayoutExecutionService` 注入核实服务**

改 `api/src/modules/billing/payout-execution.service.ts` 的 import 与构造器：

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PAYOUT_VERIFICATION } from '../../common/payment/payout-verification';
// ⚠️ **接口必须用 `import type`** —— 本仓 tsconfig 是
//    `isolatedModules: true` + `emitDecoratorMetadata: true`，
//    接口用在带 `@Inject` 装饰器的构造器参数上时，值导入会报 **TS1272**
//    （「`PayoutVerification` 只能作为类型使用，但这里被当作值使用」）。
import type { PayoutVerification } from '../../common/payment/payout-verification';
import { PayoutCipherService } from './payout-cipher.service';
```

```ts
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
    // ⚠️ **注入核实服务**（阶段 5m）—— B 类人工处置的闸 ④ 要用。
    //    按 token 注入（契约在 `common/`）→ **不产生 billing → payment 的模块边**。
    @Inject(PAYOUT_VERIFICATION)
    private readonly verification: PayoutVerification,
  ) {}
```

- [ ] **Step 2: 在 `PayoutExecutionService` 里新增 B 类方法**

追加到 `api/src/modules/billing/payout-execution.service.ts` 的类里（`markFailed` 之后）：

```ts
  /**
   * B 类人工处置：`FAILED → PAID`（阶段 5m）。
   *
   * ⚠️ **必须复原明细** —— `markFailed` 释放了 `payout_entries`，
   *    不复原的话这批流水在出款维度上**凭空消失**（商家少拿、账上无出款记录）。
   * ⚠️ **不能用「重算」复原** —— 补差单的纳入范围依赖 `payout_entries` 本身，
   *    明细已释放 → 重算失真 → 复原不出「当初那批」。只能用 `releasedEntryIds`。
   *
   * ## 四道闸（缺一不可）
   *
   * | 闸 | 检查 |
   * |---|---|
   * | ① 明细可复原 | `releasedEntryIds` 非空 |
   * | ② 金额与笔数 | **带符号**金额之和 == `receiptAmount` 且笔数 == `entryCount`；另校验 `netAmount == receiptAmount − commissionAmount` |
   * | ③ 明细未被他人占用 | 那些 `entryId` 是否已被**别的**出款单占用 |
   * | ④ 渠道核实 + 结算单状态 | 渠道说 SUCCESS？结算单状态允许联动？ |
   *
   * @throws ConflictException 闸没过时抛（业务错误，不冒成 500）
   */
  async confirmPaidAfterReconciliation(
    payoutId: string,
    input: {
      /** 人工确认的原因（会进留痕） */
      reason: string;
      /** 操作人（平台超管的用户 id） */
      operatorId: string;
      /** 关联的对账任务 id */
      reconciliationId?: string;
      /** 结算单 id（用于闸 ④ 的状态检查） */
      statementId?: string | null;
      /** 该单的出款单号（核实用） */
      payoutNo?: string;
    },
  ): Promise<boolean> {
    const trimmed = input.reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('操作原因不能为空');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      if (payout.status !== PayoutStatus.FAILED) {
        throw new ConflictException(
          `出款单状态已变（当前是 ${payout.status}），只有记成失败的出款单能确认已付款`,
        );
      }

      // ---- 闸 ①：明细可复原 ----
      const releasedEntryIds = this.parseReleasedEntryIds(payout.releasedEntryIds);
      if (releasedEntryIds.length === 0) {
        throw new ConflictException(
          '这张出款单的明细无法复原（没有记录被释放的流水），需人工处理',
        );
      }

      // ---- 闸 ②：金额与笔数对得上 ----
      const receipts = await this.prisma.merchantReceipt.findMany({
        where: { id: { in: releasedEntryIds } },
        select: { id: true, amount: true },
      });
      if (receipts.length !== releasedEntryIds.length) {
        throw new ConflictException(
          '被释放的货款流水已被删除，明细无法复原，需人工处理',
        );
      }
      // ⚠️ **带符号求和** —— `merchant_receipts.amount` 的冲回是负数，
      //    取绝对值会把「退了一笔」算成「多了一笔」。
      const sum = receipts.reduce((acc, r) => acc + r.amount, 0);
      if (sum !== payout.receiptAmount) {
        throw new ConflictException(
          `明细金额与出款单对不上（明细合计 ${sum} 分，出款单 ${payout.receiptAmount} 分），账已漂移，需人工账务处理`,
        );
      }
      if (receipts.length !== payout.entryCount) {
        throw new ConflictException(
          `明细笔数与出款单对不上（明细 ${receipts.length} 笔，出款单 ${payout.entryCount} 笔），需人工账务处理`,
        );
      }
      if (payout.netAmount !== payout.receiptAmount - payout.commissionAmount) {
        throw new ConflictException(
          '出款单的金额不自洽（净额 ≠ 货款 − 佣金），需人工账务处理',
        );
      }

      // ---- 闸 ③：明细未被他人占用 ----
      // ⚠️ **`payout_entries` 不在租户白名单** → 扩展不附加任何过滤 →
      //    **必须显式带 `payout: { tenantId, periodStart }`**，否则会读到别人家的单。
      const occupied = await this.prisma.payoutEntry.findMany({
        where: {
          entryId: { in: releasedEntryIds },
          // ⚠️ **排除本单自己**（本单的明细已被释放，理论上查不到，
          //    但别的出款单占用时要能查出来）
          NOT: { payoutId },
        },
        select: { entryId: true, payout: { select: { tenantId: true, periodStart: true } } },
      });
      const conflicting = occupied.filter(
        (e) =>
          e.payout.tenantId === payout.tenantId &&
          e.payout.periodStart.getTime() === payout.periodStart.getTime(),
      );
      if (conflicting.length > 0) {
        throw new ConflictException(
          '这批流水已被同期的另一个出款单占用，疑似重复付款，需人工退款处理',
        );
      }

      // ---- 闸 ④：渠道核实 + 结算单状态 ----
      const verdict = await this.verification.verify({
        id: payout.id,
        payoutNo: input.payoutNo ?? payout.payoutNo,
        payoutTxnId: payout.payoutTxnId,
      });
      if (verdict.verdict !== 'PAID') {
        throw new ConflictException(
          '渠道核实没有确认这笔已打款，无法标记为已付款（请先执行渠道对账）',
        );
      }

      const statementId = input.statementId ?? payout.statementId;
      if (statementId) {
        const statement = await this.prisma.settlementStatement.findFirst({
          where: { id: statementId },
          select: { status: true },
        });
        // ⚠️ **`statementId` 为 null 是常态**（零额抽佣的商家该期没有结算单）
        //    → 跳过联动，不算异常。
        if (statement) {
          if (
            statement.status !== SettlementStatus.CONFIRMED &&
            statement.status !== SettlementStatus.PAID
          ) {
            throw new ConflictException(
              '关联的结算单状态不允许联动（只有已确认或已付款的可以），需人工处理',
            );
          }
        }
      }

      // ---- 通过四闸：执行 ----
      const paidAt = await this.prisma.databaseNow();
      try {
        await this.prisma.$transaction(async (tx) => {
          // 1. 还原明细
          await tx.payoutEntry.createMany({
            data: releasedEntryIds.map((entryId) => ({ payoutId, entryId })),
            skipDuplicates: false,
          });

          // 2. 转 PAID
          await tx.payout.updateMany({
            where: { id: payoutId, status: PayoutStatus.FAILED },
            data: {
              status: PayoutStatus.PAID,
              paidAt,
              payoutChannel: payout.payoutChannel ?? 'fake-payout',
              payoutTxnId: verdict.providerTxnId ?? payout.payoutTxnId,
              failureReason: null,
              // ⚠️ **要清空** —— 它们记的是「落 FAILED 那一刻」的判断，
              //    现在是 PAID 了，留着会误导
              failedAt: null,
              failedBeforePayout: false,
              // ⚠️ **attemptCount 不重置** —— 钱已经打了，次数是历史事实
            },
          });

          // 3. 结算单联动（`statementId` 为 null 时跳过）
          if (statementId) {
            await tx.settlementStatement.updateMany({
              where: { id: statementId, status: SettlementStatus.CONFIRMED },
              data: { status: SettlementStatus.PAID, paidAt },
            });
          }

          // 4. 留痕
          await tx.payoutOperation.create({
            data: {
              payoutId,
              action: 'MANUAL_CONFIRM_PAID',
              operatorId: input.operatorId,
              reason: trimmed,
              fromStatus: PayoutStatus.FAILED,
              toStatus: PayoutStatus.PAID,
              attemptCountBefore: payout.attemptCount,
              reconciliationId: input.reconciliationId ?? null,
            },
          });
        });
      } catch (error) {
        // ⚠️ **数据库是最后一道兜底** —— 撞部分唯一索引
        //    `payouts_tenantId_period_kind_active_uniq` 说明商家已经重新申请过
        //    同一期 → **必须翻成业务错误**，不能让它冒成 500。
        if (this.isUniqueViolation(error)) {
          throw new ConflictException(
            '出款单状态已变（商家可能已重新申请同一期），无法标记为已付款',
          );
        }
        throw error;
      }

      this.logger.log(
        `对账人工确认已付款：${payoutId}（操作人 ${input.operatorId}）`,
      );
      return true;
    });
  }

  /** 解析 `releasedEntryIds`（JSON 数组字符串）；解析不出就当「不可复原」 */
  private parseReleasedEntryIds(raw: string | null): string[] {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }

  /** 判断是不是 Prisma 的唯一约束冲突（P2002） */
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    );
  }
```

⚠️ **补 import**：`BadRequestException`、`ConflictException`、`NotFoundException` 从 `@nestjs/common` 引入（`payout-execution.service.ts` 当前只 import 了 `Injectable, Logger`）。

- [ ] **Step 3: 新建 A/B 类处置服务**

新建 `api/src/modules/payment/payout-reconciliation-resolver.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../../common/tenant/tenant-context';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import type { ReconcileDiff } from './payout-reconcile.engine';

/**
 * 对账差异的处置服务（阶段 5m）。
 *
 * ## 两条处置路径
 *
 * | 类型 | 处置 | 依据 |
 * |---|---|---|
 * | **A 类**（`CHANNEL_PENDING_LOCAL`） | **自动纠正** `PROCESSING → PAID` | 渠道是权威 |
 * | **B 类**（`CHANNEL_SUCCESS_LOCAL_FAILED`） | **人工处置** `FAILED → PAID`（走四道闸） | ⚠️ 机器不改一笔钱的状态 |
 *
 * ⚠️ **B 类**的实现在 billing 的 `PayoutExecutionService.confirmPaidAfterReconciliation`
 *    （它要改 `payouts` + `settlement_statements` + `payout_entries` 三张表，
 *    与 `markPaid` 同处一地才不会漏掉结算单联动）。
 */
@Injectable()
export class PayoutReconciliationResolver {
  private readonly logger = new Logger(PayoutReconciliationResolver.name);

  constructor(
    private readonly execution: PayoutExecutionService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /**
   * 自动纠正 A 类差异。
   *
   * @returns 纠正成功的条数
   */
  async resolveAutoDiffs(
    diffs: ReconcileDiff[],
    reconciliationId: string,
  ): Promise<number> {
    let resolved = 0;
    for (const diff of diffs) {
      if (diff.type !== 'CHANNEL_PENDING_LOCAL' || !diff.payoutId) {
        continue;
      }
      const ok = await this.correctToPaid(diff, reconciliationId);
      if (ok) {
        resolved += 1;
      }
    }
    return resolved;
  }

  /**
   * A 类纠正：`PROCESSING → PAID`。
   *
   * ⚠️ **`paidAt` 用数据库时钟**，不是渠道时刻 —— `payouts.paidAt` 在正常流程里
   *    是 `databaseNow()`，混用两套时钟会让对账窗口筛选失真。
   *    渠道时刻只存在对账的 item 表与留痕的 reason 里。
   */
  private async correctToPaid(
    diff: ReconcileDiff,
    reconciliationId: string,
  ): Promise<boolean> {
    const payoutId = diff.payoutId!;
    return tenantContext.run(platformScope(), async () => {
      const paidAt = await this.prisma.databaseNow();
      const channel = await this.prisma.payout.findFirst({
        where: { id: payoutId },
        select: { payoutChannel: true },
      });
      const ok = await this.execution.markPaid(payoutId, {
        providerTxnId: diff.channelTxnId ?? '',
        channel: channel?.payoutChannel ?? 'fake-payout',
        paidAt,
      });
      if (!ok) {
        // ⚠️ **条件更新没命中** —— 状态已被改掉（worker 抢先落了 PAID）。
        //    **不报错**，但要留痕说明「为什么这张单没被对账纠正」。
        this.logger.warn(
          `对账纠正 ${payoutId} 未命中（状态已变，可能 worker 抢先落了 PAID）`,
        );
        return false;
      }
      await this.prisma.payoutOperation.create({
        data: {
          payoutId,
          action: 'RECONCILE_TO_PAID',
          // ⚠️ **定时/自动纠正没有真人** → 用系统身份
          operatorId: 'system:reconciliation',
          reason: `渠道对账：渠道确认已打款，本地纠正为已付款（渠道流水号 ${diff.channelTxnId ?? '未知'}）`,
          fromStatus: PayoutStatus.PROCESSING,
          toStatus: PayoutStatus.PAID,
          reconciliationId,
        },
      });
      return true;
    });
  }
}
```

⚠️ **留痕必须与状态变更在同一事务里** —— 上面的写法是两次调用。⚠️ **这是可接受的**：`markPaid` 内部已是事务；留痕失败只会丢一条审计记录，不会让钱的状态错乱。⚠️ **但要记日志**（上面 `markPaid` 内部已有）。

- [ ] **Step 4: 把 `PayoutExecutionService` 的新依赖加进 `billing.module.ts`**

`billing.module.ts` **不需要改 `imports`** —— `PAYOUT_VERIFICATION` 由 `@Global()` 的 `PayoutProvidersModule` 提供。

⚠️ **但要确认全局模块已被加载** —— 它由 `payment.module.ts` 的 `imports` 引入，而 `AppModule` 一定 import 了 `PaymentModule` ✅。若 `AppModule` 里 `PaymentModule` 是**懒加载**的，则全局模块在 billing 初始化时可能还没注册 → 改 `AppModule` 里 `PaymentModule` 的引用方式。实施时若遇到 `Nest can't resolve dependencies of the PayoutExecutionService (PAYOUT_VERIFICATION)`，先查这一条。

- [ ] **Step 5: 写 e2e（A 类 + B 类）**

**先造一个共享夹具** —— `api/test/payout-ops.e2e-spec.ts` 里那个 `seedPayout`
是**文件内私有**的（没 `export`），而且是 **13 个字段全必填**的「人工处置」版签名。
对账用例要的形状完全不同（金额随意、状态随意、常常要给同一个商家造 5 张单），
照搬那套签名会让每个用例写 13 行 → **新建一个短签名的共享夹具**。

⚠️ **不改 `payout-ops.e2e-spec.ts`** —— 它是绿的，为了复用去重构它属于「顺手改进」，
不在本阶段范围内。两个文件各有各的 `seedPayout`，各自服务各自的主题。

**新建 `api/test/payout-fixture.ts`**：

```ts
import { randomBytes } from 'node:crypto';
import { PayoutKind, PayoutStatus } from '@prisma/client';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../src/common/tenant/tenant-context';

/** 一天的毫秒数 */
export const DAY_MS = 24 * 3600 * 1000;

/** 一个自然月的区间（左闭右开） */
export interface Period {
  label: string;
  from: Date;
  to: Date;
}

/** 造一个自然月区间 */
export function month(label: string): Period {
  const [year, m] = label.split('-').map(Number);
  return {
    label,
    from: new Date(Date.UTC(year, m - 1, 1)),
    to: new Date(Date.UTC(year, m, 1)),
  };
}

/** 区间内的某个时刻（避开边界） */
export function inside(period: Period, offsetDays: number): Date {
  return new Date(period.from.getTime() + offsetDays * DAY_MS);
}

/**
 * 造数用的结算期序号。
 *
 * ⚠️ **为什么需要它** —— 部分唯一索引
 *    `payouts_tenantId_period_kind_active_uniq`
 *    = `(tenantId, periodStart, kind) WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')`
 *    → **同一租户下两张活跃单（`PAID` / `PROCESSING` / `REQUESTED` / `APPROVED`）
 *    不能有相同的 `periodStart`**。
 *    对账用例常常要给同一个商家造 5 张不同状态的单（其中 4 张是活跃的）
 *    → 结算期必须自动错开，否则插库直接撞 P2002。
 */
let periodSeq = 0;

/** 自动错开的结算期起点 */
function nextPeriodStart(): Date {
  periodSeq += 1;
  return new Date(Date.UTC(2021, 0, 1) + periodSeq * DAY_MS);
}

/** 造一张出款单时要什么 */
export interface SeedPayoutOptions {
  /** 商家租户 id */
  tenantId: string;
  /** 出款单状态 */
  status: PayoutStatus;
  /** 结算期起点 —— 留空则自动错开（见 `nextPeriodStart`） */
  periodStart?: Date;
  /** 结算期终点 —— 留空则 `periodStart + 30 天` */
  periodEnd?: Date;
  /** 货款净额（正数） */
  receiptAmount?: number;
  /** 佣金净额（正数） */
  commissionAmount?: number;
  /** 应结给商家的金额 —— 留空则 `receiptAmount − commissionAmount` */
  netAmount?: number;
  /** 纳入的货款流水笔数 */
  entryCount?: number;
  /** 出款单号 —— 留空则随机 */
  payoutNo?: string;
  /** 打款渠道名 */
  payoutChannel?: string | null;
  /** 渠道交易号 */
  payoutTxnId?: string | null;
  /** 已尝试次数 */
  attemptCount?: number;
  /** 失败原因 */
  failureReason?: string | null;
  /** 「钱确定没打出去」的标记 */
  failedBeforePayout?: boolean;
  /** 释放的明细 id（JSON 数组字符串）—— 阶段 5m 新增的字段 */
  releasedEntryIds?: string | null;
  /** 开始执行的时刻 */
  processingAt?: Date | null;
  /** 打款成功时刻 */
  paidAt?: Date | null;
  /** 失败落终态的时刻 */
  failedAt?: Date | null;
}

/** 造出来的一张出款单 */
export interface SeededPayout {
  id: string;
  payoutNo: string;
  netAmount: number;
  receiptAmount: number;
  commissionAmount: number;
  entryCount: number;
  status: PayoutStatus;
}

/**
 * 造一张出款单（直接插库，不走支付链路）。
 *
 * ⚠️ **只把「用例真正要区分的字段」做成必填**（`tenantId`、`status`），
 *    其余都有自洽的默认值：
 *    `receiptAmount = 10000`、`commissionAmount = 0`、
 *    `netAmount = receiptAmount − commissionAmount`、`entryCount = 0`。
 *
 * ⚠️ **账户快照留空** —— 对账用例不打款，不需要可解密的快照。
 *    真要打款的用例走「申请 → 审批」的真链路（`payout-execution.e2e-spec.ts` 那样）。
 */
export async function seedPayout(
  prisma: TenantPrismaService,
  options: SeedPayoutOptions,
): Promise<SeededPayout> {
  const receiptAmount = options.receiptAmount ?? 10_000;
  const commissionAmount = options.commissionAmount ?? 0;
  const netAmount = options.netAmount ?? receiptAmount - commissionAmount;
  const periodStart = options.periodStart ?? nextPeriodStart();
  const periodEnd =
    options.periodEnd ?? new Date(periodStart.getTime() + 30 * DAY_MS);

  const created = await tenantContext.run(platformScope(), async () =>
    prisma.payout.create({
      data: {
        tenantId: options.tenantId,
        payoutNo: options.payoutNo ?? `P5M-${randomBytes(6).toString('hex')}`,
        kind: PayoutKind.NORMAL,
        periodStart,
        periodEnd,
        statementId: null,
        receiptAmount,
        commissionAmount,
        netAmount,
        entryCount: options.entryCount ?? 0,
        status: options.status,
        requestedAmount: netAmount,
        requestedBy: 'test-merchant-user',
        approvedBy: null,
        approvedAt: null,
        attemptCount: options.attemptCount ?? 0,
        failureReason: options.failureReason ?? null,
        failedBeforePayout: options.failedBeforePayout ?? false,
        processingAt: options.processingAt ?? null,
        paidAt: options.paidAt ?? null,
        failedAt: options.failedAt ?? null,
        payoutChannel: options.payoutChannel ?? null,
        payoutTxnId: options.payoutTxnId ?? null,
        releasedEntryIds: options.releasedEntryIds ?? null,
        snapshotAccountName: null,
        snapshotBankName: null,
        snapshotAccountNoCipher: null,
        snapshotMaskedAccountNo: null,
        snapshotEncryptionVersion: 0,
      },
    }),
  );

  return {
    id: created.id,
    payoutNo: created.payoutNo,
    netAmount: created.netAmount,
    receiptAmount: created.receiptAmount,
    commissionAmount: created.commissionAmount,
    entryCount: created.entryCount,
    status: created.status,
  };
}

/**
 * 清掉所有出款单与对账数据。
 *
 * ⚠️ **为什么对账的 spec 必须调它** —— e2e 文件之间**共享同一个测试库**：
 *    `globalSetup` 每轮只清库一次，各 spec 文件之间不再清理 →
 *    前一个文件留下的出款单会进后一个文件的**对账结果**
 *    （本地 `PAID` + 渠道查无此笔 → 多出一条 E 类差异）。
 *    → 对账的 spec 必须在 `beforeAll` 里从干净状态开始。
 *
 * ⚠️ **删表顺序要紧**（外键）：
 *    ① `payout_reconciliation_items` 引用 `payout_reconciliations`；
 *    ② `payout_entries` / `payout_operations` 引用 `payouts`；
 *    ③ 最后才是 `payouts`。
 *
 * ⚠️ **不清 `merchant_receipts` 与 `settlement_statements`** ——
 *    出款单引用它们、不是它们引用出款单 → 留着不影响对账（对账只看 `payouts`），
 *    清了反而可能撞 Restrict 外键。
 */
export async function resetPayoutData(
  prisma: TenantPrismaService,
): Promise<void> {
  await tenantContext.run(platformScope(), async () => {
    await prisma.payoutReconciliationItem.deleteMany();
    await prisma.payoutReconciliation.deleteMany();
    await prisma.payoutEntry.deleteMany();
    await prisma.payoutOperation.deleteMany();
    await prisma.payout.deleteMany();
  });
}
```

**再建 `api/test/payout-reconciliation.e2e-spec.ts`**：

```ts
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import {
  PayoutStatus,
  ReconciliationDiffType,
  ReconciliationSeverity,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { FakePayoutProvider } from '../src/common/payment/fake-payout.provider';
import { PayoutExecutionService } from '../src/modules/billing/payout-execution.service';
import { PayoutReconciliationResolver } from '../src/modules/payment/payout-reconciliation-resolver.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { resetPayoutData, seedPayout } from './payout-fixture';

describe('渠道对账 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let fakeProvider: FakePayoutProvider;
  let payoutQueue: Queue;

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
    fakeProvider = app.get(FakePayoutProvider);
    payoutQueue = app.get(getQueueToken(PAYOUT_QUEUE));

    // ⚠️ **暂停出款队列** —— 造数是直接插库的，
    //    worker 若抢到别的单会把队列状态搅乱。
    await payoutQueue.pause();

    // ⚠️ **对账是平台级扫描** —— 别的 e2e 文件留下的出款单会进比对结果
    //    （本地 PAID + 渠道查无此笔 → 多出一条 E 类差异）。
    //    e2e 文件共享同一个测试库 → 必须从干净状态开始。
    await resetPayoutData(prisma);
  });

  afterAll(async () => {
    await payoutQueue.resume();
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
    const body = response.body as { accessToken: string };
    return body.accessToken;
  }
```

⚠️ **`FakePayoutProvider` 从 `../src/common/payment/fake-payout.provider` 导入** ——
Task 5 已经把它从 `api/src/modules/payment/` 搬到了 `api/src/common/payment/`。

本 Task 只写两个用例（其余在 Task 8 补）：

```ts
  it('A 类：渠道 SUCCESS + 本地 PROCESSING → 自动纠正为 PAID', async () => {
    // 造一张 PROCESSING 的出款单
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // 造渠道流水（成功）
    await fakeProvider.execute({
      referenceId: payout.id,
      referenceNo: payout.payoutNo,
      amount: payout.netAmount,
      account: { accountName: '张三', bankName: '测试银行', accountNo: '6222000000000000' },
      attempt: 1,
    });

    // 跑对账服务（Task 8 才有）→ 本 Task 直接调 resolver
    const resolver = app.get(PayoutReconciliationResolver);
    const resolved = await resolver.resolveAutoDiffs(
      [
        {
          type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
          severity: ReconciliationSeverity.INFO,
          payoutId: payout.id,
          channelTxnId: 'txn-auto',
          channelReferenceNo: payout.payoutNo,
          channelAmount: payout.netAmount,
          channelStatus: 'SUCCESS',
          channelPaidAt: new Date(),
          localAmount: payout.netAmount,
          localStatus: PayoutStatus.PROCESSING,
        },
      ],
      'recon-test-1',
    );

    expect(resolved).toBe(1);
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payout.id } }),
    );
    expect(row!.status).toBe(PayoutStatus.PAID);
    // ⚠️ **必须有留痕** —— 谁在什么时候把哪张单改了
    const op = await asPlatform(() =>
      prisma.payoutOperation.findFirst({ where: { payoutId: payout.id } }),
    );
    expect(op!.action).toBe('RECONCILE_TO_PAID');
    expect(op!.reconciliationId).toBe('recon-test-1');
  });

  it('B 类：闸 ① 过不了（没有 releasedEntryIds）→ 拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.FAILED,
      failedAt: new Date(),
      // ⚠️ **不给 releasedEntryIds** → 闸 ① 挡住
    });

    const execution = app.get(PayoutExecutionService);
    await expect(
      execution.confirmPaidAfterReconciliation(payout.id, {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
```

⚠️ **本文件的 `seedPayout` 是 `./payout-fixture` 导出的短签名版本** ——
只 `tenantId` 与 `status` 必填，其余走默认值。

⚠️ **不需要另选月份** —— 夹具的 `seedPayout` 自动错开 `periodStart`
（`nextPeriodStart()`），同一租户下造多张活跃单也不会撞部分唯一索引。

⚠️ **补 import**：`ConflictException`（`@nestjs/common`）。

- [ ] **Step 6: 验证**

```bash
cd api && npx tsc --noEmit
```

预期：无输出。

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payout-reconciliation.e2e-spec.ts
```

预期：2 个用例通过。

- [ ] **Step 7: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/src/modules/billing/payout-execution.service.ts \
        api/src/modules/billing/billing.module.ts \
        api/src/modules/payment/payout-reconciliation-resolver.service.ts \
        api/test/payout-fixture.ts \
        api/test/payout-reconciliation.e2e-spec.ts
git commit -m "feat(billing): B 类人工处置的四道闸 + A 类自动纠正

A 类（渠道说已打、本地卡在 PROCESSING）自动纠正为 PAID，复用 markPaid，
paidAt 用数据库时钟（混用渠道时钟会让对账窗口筛选失真），并写 RECONCILE_TO_PAID 留痕。

B 类（渠道说已打、本地记失败）走人工处置，四个闸：明细可复原、金额与笔数
对得上、明细未被他人占用、渠道核实 + 结算单状态。金额求和是带符号的 ——
冲回是负数，取绝对值会把「退了一笔」算成「多了一笔」。

明细必须靠 releasedEntryIds 复原，不能重算 —— 补差单的纳入范围依赖
payout_entries 本身，明细已释放后重算失真。"
```

---

### Task 7: 解卡重打的前置闸

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`
- Test: `api/test/payout-unstick-gate.e2e-spec.ts`（新建，本 Task 放解卡闸三个用例）

**依赖：** Task 5（核实服务 + 契约）、Task 6（`PayoutExecutionService` 注入核实服务的同款写法）。

⚠️ **本 Task 有一处对设计 §六·6.3 的明确偏离**，先说清楚：

> 设计原文说「渠道说 SUCCESS → 拒绝解卡，**并把这张单纠正为 PAID**」。
> 但**纠正逻辑（A 类）在 payment 模块的 `PayoutReconciliationResolver`**，
> 而 `unstick` 在 billing → **billing 调不到 payment**（模块环）。
> 再为「运营点了个被拒的按钮」这个场景下一个跨模块契约，收益不抵成本。
>
> → **本计划：解卡闸只「拒绝」，不纠正。**
> → **A 类的纠正由对账服务负责**（Task 8）—— 运营被拒后去看对账页、或等定时对账跑完，
>   A 类都会被自动纠正（`markPaid` 是条件更新，与 worker 竞争时只有一个赢）。
> → **提示文案必须写清下一步该做什么**（Task 10 的界面文案照此）。

- [ ] **Step 1: `PayoutService` 注入核实服务**

改 `api/src/modules/billing/payout.service.ts` 的 import：

```ts
import {
  Inject,
  // ... 现有的 import
} from '@nestjs/common';
import { PAYOUT_VERIFICATION } from '../../common/payment/payout-verification';
// ⚠️ **接口必须用 `import type`** —— 同 Task 6：`isolatedModules` +
//    `emitDecoratorMetadata` 下，接口用在带 `@Inject` 装饰器的构造器参数上
//    会报 **TS1272**。
import type { PayoutVerification } from '../../common/payment/payout-verification';
```

在 `PayoutService` 的构造器里加一个参数（**加在末尾**，避免打乱现有参数顺序）：

```ts
    // ⚠️ **注入核实服务**（阶段 5m）—— 解卡重打前要问渠道「这笔打没打」。
    //    按 token 注入（契约在 `common/`）→ **不产生 billing → payment 的模块边**。
    @Inject(PAYOUT_VERIFICATION)
    private readonly verification: PayoutVerification,
```

- [ ] **Step 2: 在 `unstick` 里加闸**

改 `api/src/modules/billing/payout.service.ts` 的 `unstick`（当前 `:966-1078`）。

**插入位置**：在「该出款单可能正在打款中（未超过卡住阈值）」那道检查**之后**、
`const toStatus = ...` **之前**。

```ts
      // ⚠️⚠️ **解卡重打的前置闸**（阶段 5m，设计 §六·6.3）——
      //    没有这道闸，运营点一下「解卡重打」就是**确定性地重复打款**：
      //    「卡在 PROCESSING」最可能的成因是「请求发出去了、回包丢了」→
      //    钱**可能已经打到商家账上**。
      //
      //    ⚠️ **这道闸罩住整个 `unstick`**（两个分支都会导致重打）：
      //    `to='APPROVED'` 直接重新入队；`to='FAILED'` 设 `failedBeforePayout: true`
      //    → 制造出一张「可安全重试」的单 → 之后能被 `retry` 重打。
      const verdict = await this.verification.verify({
        id: payout.id,
        payoutNo: payout.payoutNo,
        payoutTxnId: payout.payoutTxnId,
      });
      if (verdict.verdict === 'PAID') {
        // ⚠️ **渠道说钱已经打了** → 绝不能解卡
        //    （本 Task 的偏离说明：这里**不自动纠正**成 PAID ——
        //    纠正逻辑在 payment 模块的 resolver，billing 调不到。
        //    运营下一步是去对账页执行一次对账，A 类会被自动纠正。）
        throw new ConflictException(
          '渠道核实显示这张出款单已经打款成功，不能解卡重打（否则会重复打款）。' +
            '请到「渠道对账」页对账后查看结论。',
        );
      }
      if (verdict.verdict === 'UNKNOWN') {
        // ⚠️ **fail-closed** —— 问不出结论就不放行。
        //    「渠道查不到这条」不等于「渠道说没打」。
        throw new ConflictException(
          '无法确认该笔是否已打款，请先执行渠道对账再解卡',
        );
      }
      // verdict === 'FAILED' → 渠道明确说没打 → 允许解卡
```

- [ ] **Step 3: 写 e2e（三个用例）**

新建 `api/test/payout-unstick-gate.e2e-spec.ts`（**独立文件** —— 解卡闸与 A/B 类处置是两个主题，
本仓的 e2e 约定就是「一个主题一个文件」）：

```ts
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import { PayoutStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { FakePayoutProvider } from '../src/common/payment/fake-payout.provider';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { seedPayout } from './payout-fixture';

describe('解卡重打的前置闸 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let fakeProvider: FakePayoutProvider;
  let payoutQueue: Queue;

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
    fakeProvider = app.get(FakePayoutProvider);
    payoutQueue = app.get(getQueueToken(PAYOUT_QUEUE));

    // ⚠️ **暂停出款队列** —— 这三个用例走 `unstick`，
    //    若 `to='APPROVED'` 会把单放回队列 → worker 抢到就会打款，
    //    「状态必须没变」的断言就变成竞态。
    await payoutQueue.pause();
  });

  afterAll(async () => {
    await payoutQueue.resume();
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
    const body = response.body as { accessToken: string };
    return body.accessToken;
  }
```

然后追加三个用例：

```ts
  it('解卡闸：渠道说 SUCCESS → 拒绝解卡', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000), // 超过 10 分钟阈值
    });
    // 造渠道流水（成功）
    await fakeProvider.execute({
      referenceId: payout.id,
      referenceNo: payout.payoutNo,
      amount: payout.netAmount,
      account: { accountName: '张三', bankName: '测试银行', accountNo: '6222000000000000' },
      attempt: 1,
    });

    const response = await http(app)
      .post(`/api/v1/platform/payouts/${payout.id}/unstick`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ to: 'APPROVED', reason: '测试解卡' });

    expect(response.status).toBe(409);
    // ⚠️ **状态必须没变** —— 拒绝解卡就一张都不能重打
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payout.id } }),
    );
    expect(row!.status).toBe(PayoutStatus.PROCESSING);
  });

  it('解卡闸：渠道说 FAILED → 放行解卡', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // 造渠道流水（失败）
    fakeProvider.armScenario({ failTimes: 1 });
    await fakeProvider.execute({
      referenceId: payout.id,
      referenceNo: payout.payoutNo,
      amount: payout.netAmount,
      account: { accountName: '张三', bankName: '测试银行', accountNo: '6222000000000000' },
      attempt: 1,
    });

    const response = await http(app)
      .post(`/api/v1/platform/payouts/${payout.id}/unstick`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ to: 'FAILED', reason: '渠道确认没打出去' });

    expect(response.status).toBe(200);
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payout.id } }),
    );
    expect(row!.status).toBe(PayoutStatus.FAILED);
  });

  it('解卡闸：问不出结论 → 拒绝解卡（fail-closed）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // ⚠️ **渠道侧没有任何流水** → 实时核实返回 UNKNOWN → 降级查对账结果 → 也没有

    const response = await http(app)
      .post(`/api/v1/platform/payouts/${payout.id}/unstick`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ to: 'APPROVED', reason: '测试解卡' });

    expect(response.status).toBe(409);
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payout.id } }),
    );
    expect(row!.status).toBe(PayoutStatus.PROCESSING);
  });
```

⚠️ **队列要暂停** —— 这三个用例走 `unstick`，若 `to='APPROVED'` 会入队。
本文件自己的 `beforeAll` 末尾 `await payoutQueue.pause()`、`afterAll` 开头
`await payoutQueue.resume()`（骨架里已写好）。

⚠️ `adminToken` 来自本文件自己的 `loginPlatformAdmin()`，
`seedPayout` 来自 `./payout-fixture`（Task 6 建好，**签名是 `seedPayout(prisma, {...})`**）。

- [ ] **Step 4: 验证**

```bash
cd api && npx tsc --noEmit && npx jest --config ./test/jest-e2e.json --runInBand test/payout-unstick-gate.e2e-spec.ts
```

预期：3 个用例全部通过（本 Task 自己的文件）。

- [ ] **Step 5: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/src/modules/billing/payout.service.ts \
        api/test/payout-unstick-gate.e2e-spec.ts
git commit -m "feat(billing): 解卡重打前加渠道核实闸，防止重复打款

卡在 PROCESSING 的单最可能的成因是「请求发出去了、回包丢了」—— 钱可能
已经打到商家账上。运营点一下「解卡重打」就是确定性地重复打款。

闸罩住整个 unstick 的两个分支：to=APPROVED 直接重新入队；to=FAILED 设
failedBeforePayout=true 制造出一张「可安全重试」的单，之后能被 retry 重打。

核实走三层：实时渠道核实 → 查最近一次对账结果 → fail-closed。
只有渠道明确说 FAILED 才放行；问不出结论一律拒绝。"
```

---

### Task 8: 对账服务 + API + 定时任务

**Files:**
- Create: `api/src/modules/payment/payout-reconciliation.service.ts`
- Create: `api/src/modules/payment/platform-payout-reconciliation.controller.ts`
- Create: `api/src/modules/payment/payout-reconcile.scheduler.ts`
- Create: `api/src/modules/payment/dto/payout-reconciliation.dto.ts`
- Modify: `api/src/common/payment/payout.constants.ts`（加统一文案常量）
- Modify: `api/src/modules/payment/payment.module.ts`
- Modify: `api/src/modules/payment/payout.worker.ts`（加 `'reconcile'` job 分支）
- Test: `api/test/payout-reconciliation-service.e2e-spec.ts`（新建，本 Task 放六类差异用例）

**依赖：** Task 1、4、5、6、7。

- [ ] **Step 1: 加统一文案常量**

追加到 `api/src/common/payment/payout.constants.ts`：

```ts
/**
 * 假出款网关不可用时的统一文案（阶段 5m）。
 *
 * ⚠️ **两条独立的报错路径要用同一个常量**：
 * ① 假网关的 `listPayouts` 抛错；
 * ② 手动触发对账的端点返回 409。
 * 两处文案漂移会让运营以为是两个问题。
 */
export const FAKE_PAYOUT_UNAVAILABLE_MESSAGE = '本地假出款网关未启用';
```

⚠️ **同步改 `api/src/common/payment/fake-payout.provider.ts` 的两处** `new ServiceUnavailableException('本地假出款网关未启用')` → `new ServiceUnavailableException(FAKE_PAYOUT_UNAVAILABLE_MESSAGE)`，并 import 这个常量。

- [ ] **Step 2: 写 DTO**

新建 `api/src/modules/payment/dto/payout-reconciliation.dto.ts`：

```ts
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 手动触发对账的入参 */
export class TriggerReconciliationDto {
  /** 渠道名 */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  channel!: string;

  /** 窗口起点（含），ISO 字符串 */
  @IsDateString()
  from!: string;

  /** 窗口终点（不含），ISO 字符串 */
  @IsDateString()
  to!: string;
}

/** 对账任务列表的查询参数 */
export class ListReconciliationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // ⚠️ **`page` 不设上限** —— 它是页码不是每页条数，夹住它会让
  //    100 页之后的数据**永远取不到**（对账任务是只增不减的历史表）。
  //    每页条数才要夹（见 `pageSize`）。
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** 处置一条差异 */
export class ResolveReconciliationItemDto {
  /**
   * 处置结果。
   *
   * ⚠️ **必须用 `@IsIn`，不能用 `@IsString`** ——
   *    TS 的字面量联合类型在**运行时不存在**，class-validator 不看 TS 类型。
   *    只校验字符串的话，`PENDING` 能被提交 → 这条差异**重新回到「未处置」**
   *    （运营明明处置过了，未处置统计却不降），且 `resolvedAt` 已写上、
   *    状态自相矛盾。写成别的字符串还会撞 PG 的 enum → 冒成 500。
   */
  @IsIn(['RESOLVED', 'IGNORED'])
  resolution!: 'RESOLVED' | 'IGNORED';

  /** 处置说明 */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;
}

/** B 类人工确认已付款 */
export class ConfirmPaidDto {
  /** 操作原因（会进留痕） */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  /** 关联的对账任务 id（可选） */
  @IsOptional()
  @IsString()
  reconciliationId?: string;
}
```

⚠️ **全局 ValidationPipe 是 `{ whitelist: true, forbidNonWhitelisted: true, transform: true }`** → DTO 里没声明的字段会直接 400。

- [ ] **Step 3: 写对账服务**

新建 `api/src/modules/payment/payout-reconciliation.service.ts`：

```ts
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  PayoutStatus,
  ReconciliationDiffType,
  ReconciliationResolution,
  ReconciliationSource,
  ReconciliationStatus,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../../common/tenant/tenant-context';
import { withTimeout } from '../../common/util/with-timeout';
import { clampPagination } from '../../common/http/pagination';
import {
  FAKE_PAYOUT_UNAVAILABLE_MESSAGE,
  PAYOUT_PROVIDERS,
} from '../../common/payment/payout.constants';
import type { PayoutProvider } from '../../common/payment/payout-provider.interface';
import {
  FAKE_PAYOUT_CHANNEL,
  isFakePayoutEnabled,
} from '../../common/payment/fake-payout.provider';
import {
  LocalPayoutForReconcile,
  ReconcileDiff,
  reconcile,
} from './payout-reconcile.engine';
import { PayoutReconciliationResolver } from './payout-reconciliation-resolver.service';

/** 时间窗的最大跨度（天） */
export const RECONCILIATION_MAX_WINDOW_DAYS = 31;

/** 渠道侧返回的记录数上限 */
export const RECONCILIATION_MAX_CHANNEL_RECORDS = 10_000;

/** 单次对账的执行超时（毫秒） */
export const RECONCILIATION_TIMEOUT_MS = 30_000;

/**
 * 详情接口一次最多返回多少条差异项。
 *
 * ⚠️ **一个对账任务最多能产生上万条差异**（渠道记录数上限就是 10000 条）
 *    → 一次性全吐给浏览器会卡死。截断时必须带 `itemsTruncated` 标记，
 *    静默截断会让人以为「就这些差异」。
 */
export const RECONCILIATION_MAX_ITEMS = 200;

/** 判定 D 类用的「扩大窗口」余量（小时） */
export const RECONCILIATION_EXPANDED_MARGIN_HOURS = 15;

/**
 * 渠道对账服务（阶段 5m）。
 *
 * ## 它做什么
 *
 * 1. 查本地参与比对的单（按 `paidAt` / `processingAt` / `failedAt` 三个时间戳）
 * 2. 拉渠道侧的流水（`listPayouts`）
 * 3. 交给比对引擎分类
 * 4. 落差异项 + 去重
 * 5. A 类自动纠正
 *
 * ⚠️ **跑在平台作用域下** —— 对账是平台级动作，跨所有租户。
 */
@Injectable()
export class PayoutReconciliationService {
  private readonly logger = new Logger(PayoutReconciliationService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    @Inject(PAYOUT_PROVIDERS)
    private readonly providers: Map<string, PayoutProvider>,
    private readonly resolver: PayoutReconciliationResolver,
  ) {}

  /**
   * 手动触发一次对账（同步执行）。
   *
   * ⚠️ **三道上限**：窗口跨度 ≤ 31 天；渠道记录数 ≤ 10000；执行 ≤ 30 秒。
   *    超限一律把任务落 `FAILED` 并写明原因，**不做静默截断** ——
   *    截断出来的对账结论是错的。
   */
  async trigger(input: {
    channel: string;
    from: Date;
    to: Date;
    operatorId: string;
  }): Promise<{ id: string; status: string; diffCount: number; matchedCount: number }> {
    await this.assertWindow(input.from, input.to);
    this.assertChannelAvailable(input.channel);

    const reconciliation = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.create({
        data: {
          channel: input.channel,
          source: ReconciliationSource.API,
          windowFrom: input.from,
          windowTo: input.to,
          status: ReconciliationStatus.RUNNING,
          triggeredBy: input.operatorId,
        },
      }),
    );

    try {
      return await withTimeout(
        this.run(reconciliation.id, input.channel, input.from, input.to),
        RECONCILIATION_TIMEOUT_MS,
        '渠道对账',
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      await tenantContext.run(platformScope(), async () => {
        // ⚠️ **只把还在 `RUNNING` 的任务落 `FAILED`** ——
        //    `withTimeout` 是 `Promise.race`，超时**不会取消**底层的 `run()`，
        //    后台它仍在跑、最后会把任务改成 `COMPLETED`。
        //    → 两边都加 `RUNNING` 守卫，**先落终态的赢**。
        //    不加守卫的后果不只是状态显示错：超时落 `FAILED` 又被翻成
        //    `COMPLETED` → `runScheduled` 的幂等检查只查 `COMPLETED`
        //    → 那个窗口**永远不会再被对账**，那批出款单的差异静默丢失。
        const affected = await this.prisma.payoutReconciliation.updateMany({
          where: {
            id: reconciliation.id,
            status: ReconciliationStatus.RUNNING,
          },
          data: {
            status: ReconciliationStatus.FAILED,
            finishedAt: await this.prisma.databaseNow(),
            errorMessage: message,
          },
        });
        if (affected.count === 0) {
          // ⚠️ **任务行已被别人改过终态** —— 说明不是超时这条路径，
          //    静默即可，但留一行日志便于排查。
          this.logger.warn(
            `对账任务 ${reconciliation.id} 未落 FAILED（状态已被其他路径改过）`,
          );
        }
      });
      throw error;
    }
  }

  /** 定时对账：对「昨天」（UTC 自然日） */
  async runScheduled(channel: string): Promise<void> {
    if (!this.assertChannelAvailable(channel, false)) {
      return;
    }
    const now = await this.prisma.databaseNow();
    const to = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

    // ⚠️ **幂等**：同一天重复跑 → 已有 `COMPLETED` 任务就跳过
    const existing = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.findFirst({
        where: {
          channel,
          windowFrom: from,
          windowTo: to,
          status: ReconciliationStatus.COMPLETED,
        },
      }),
    );
    if (existing) {
      this.logger.log(`渠道对账跳过（该窗口已有完成的任务 ${existing.id}）`);
      return;
    }

    await this.trigger({
      channel,
      from,
      to,
      operatorId: 'system:scheduler',
    });
  }

  /** 对账的主体流程 */
  private async run(
    reconciliationId: string,
    channel: string,
    from: Date,
    to: Date,
  ): Promise<{ id: string; status: string; diffCount: number; matchedCount: number }> {
    const provider = this.providers.get(channel);
    if (!provider) {
      // ⚠️ **文案要与 `assertChannelAvailable` 一致** —— 同一件事说两句话，
      //    运营会以为是两个问题。
      throw new ConflictException(
        `该渠道当前不可用（${FAKE_PAYOUT_UNAVAILABLE_MESSAGE}），无法执行渠道对账`,
      );
    }

    // ---- ① 拉渠道流水 ----
    const expanded = {
      from: new Date(from.getTime() - RECONCILIATION_EXPANDED_MARGIN_HOURS * 3600_000),
      to: new Date(to.getTime() + RECONCILIATION_EXPANDED_MARGIN_HOURS * 3600_000),
    };
    const channelRecords = await provider.listPayouts({ from: expanded.from, to: expanded.to });
    // ⚠️ **渠道侧不承诺输出顺序** —— 假网关按 `referenceNo` 分组输出，
    //    真渠道更是分页/倒序/按状态分组都有 → 排序由比对引擎负责
    //    （引擎内部按 `paidAt` 升序排、`paidAt` 相同时按 `providerTxnId` 兜底）。
    //    ⚠️ **时间窗筛的是「发起打款时刻」** —— 假网关是同步的，两者等同；
    //    真渠道是异步的（发起与到账可能跨天）→ 真渠道接入时这个语义要重定。
    if (channelRecords.length > RECONCILIATION_MAX_CHANNEL_RECORDS) {
      throw new ConflictException(
        `渠道返回了 ${channelRecords.length} 条流水，超过上限 ${RECONCILIATION_MAX_CHANNEL_RECORDS} 条，请缩小时间窗`,
      );
    }

    // ---- ② 查本地参与比对的单 ----
    const localPayouts = await this.loadLocalPayouts(from, to);

    // ---- ③ 比对 ----
    const output = reconcile({
      window: { from, to },
      expandedWindow: expanded,
      localPayouts,
      channelRecords,
    });

    // ---- ④ 落差异项 + 去重 ----
    const completed = await tenantContext.run(platformScope(), async () => {
      await this.supersedePreviousPending(output.diffs, reconciliationId);
      if (output.diffs.length > 0) {
        await this.prisma.payoutReconciliationItem.createMany({
          data: output.diffs.map((diff) => ({
            reconciliationId,
            type: diff.type,
            severity: diff.severity,
            payoutId: diff.payoutId,
            channelTxnId: diff.channelTxnId,
            channelReferenceNo: diff.channelReferenceNo,
            channelAmount: diff.channelAmount,
            channelStatus: diff.channelStatus,
            channelPaidAt: diff.channelPaidAt,
            localAmount: diff.localAmount,
            localStatus: diff.localStatus,
          })),
        });
      }
      // ⚠️ **同样只认 `RUNNING`** —— 超时后 `trigger` 的 catch 已把任务
      //    落成 `FAILED`，这时后台的 `run()` 才跑完 → 不能再翻回 `COMPLETED`
      //    （那会让 `runScheduled` 的幂等检查永远跳过这个窗口）。
      const affected = await this.prisma.payoutReconciliation.updateMany({
        where: {
          id: reconciliationId,
          status: ReconciliationStatus.RUNNING,
        },
        data: {
          status: ReconciliationStatus.COMPLETED,
          finishedAt: await this.prisma.databaseNow(),
          channelCount: channelRecords.length,
          localCount: localPayouts.length,
          matchedCount: output.matchedCount,
          diffCount: output.diffs.length,
        },
      });
      return affected.count > 0;
    });

    // ⚠️ **没落成 `COMPLETED` 就不做 A 类纠正** —— 说明这轮已经超时、
    //    任务被落成 `FAILED`。这时再改出款单的状态，会出现
    //    「任务说失败、单子说已付」两边对不上。
    if (!completed) {
      this.logger.warn(
        `对账任务 ${reconciliationId} 未落 COMPLETED（可能已超时落 FAILED），跳过 A 类自动纠正`,
      );
      return {
        id: reconciliationId,
        status: ReconciliationStatus.FAILED,
        diffCount: output.diffs.length,
        matchedCount: output.matchedCount,
      };
    }

    // ---- ⑤ A 类自动纠正 ----
    await this.resolver.resolveAutoDiffs(output.diffs, reconciliationId);

    return {
      id: reconciliationId,
      status: ReconciliationStatus.COMPLETED,
      diffCount: output.diffs.length,
      matchedCount: output.matchedCount,
    };
  }

  /**
   * 查参与比对的本地单。
   *
   * ⚠️ **判据是「这张单调过渠道」** —— 对应 `paidAt` / `processingAt` / `failedAt`
   *    三个时间戳。用 `createdAt` 筛会把「还没调过渠道的单」也捞进来
   *    → 它们在渠道侧压根没有记录 → 全变成假的 D 类。
   * ⚠️ **这个 `where` 不带 `status`** —— `PAID` / `PROCESSING` / `FAILED` 三种都要参与。
   */
  private async loadLocalPayouts(
    from: Date,
    to: Date,
  ): Promise<LocalPayoutForReconcile[]> {
    return tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.payout.findMany({
        where: {
          OR: [
            { paidAt: { gte: from, lt: to } },
            { processingAt: { gte: from, lt: to } },
            { failedAt: { gte: from, lt: to } },
          ],
        },
        select: {
          id: true,
          payoutNo: true,
          payoutTxnId: true,
          status: true,
          netAmount: true,
          receiptAmount: true,
          commissionAmount: true,
          entryCount: true,
          paidAt: true,
          processingAt: true,
          failedAt: true,
        },
      });
      return rows as unknown as LocalPayoutForReconcile[];
    });
  }

  /**
   * 去重：把历史上同 `(payoutId, type)` 的 `PENDING` 项标为 `IGNORED`。
   *
   * ⚠️ **不做这个，「未处置差异数」会单调增长** → 运营要反复处理同一个问题。
   * ⚠️ **历史记录保留** —— 审计时要能看到「这个问题被对账发现过几次」。
   * ⚠️ **D 类没有 `payoutId`** → 用 `channelTxnId` 代替。
   */
  private async supersedePreviousPending(
    diffs: ReconcileDiff[],
    reconciliationId: string,
  ): Promise<void> {
    const note = `已被对账任务 ${reconciliationId} 重新评估`;
    for (const diff of diffs) {
      const where = diff.payoutId
        ? { payoutId: diff.payoutId, type: diff.type }
        : diff.channelTxnId
          ? { channelTxnId: diff.channelTxnId, type: diff.type }
          : null;
      if (!where) {
        continue;
      }
      await this.prisma.payoutReconciliationItem.updateMany({
        where: {
          ...where,
          resolution: ReconciliationResolution.PENDING,
        },
        data: {
          resolution: ReconciliationResolution.IGNORED,
          note,
          resolvedAt: await this.prisma.databaseNow(),
        },
      });
    }
  }

  /** 校验时间窗跨度 */
  private async assertWindow(from: Date, to: Date): Promise<void> {
    if (to.getTime() <= from.getTime()) {
      throw new BadRequestException('时间窗的终点必须晚于起点');
    }
    const days = (to.getTime() - from.getTime()) / (24 * 3600_000);
    if (days > RECONCILIATION_MAX_WINDOW_DAYS) {
      throw new BadRequestException(
        `时间窗跨度不能超过 ${RECONCILIATION_MAX_WINDOW_DAYS} 天`,
      );
    }
    // ⚠️ **整体落在未来的窗口要拒** —— 对未来的时段对账必然是空的，
    //    却会落一条「已完成、0 差异」的记录 → 对账列表里多一条没意义的记录，
    //    还会让人以为「那个时段已经对过了，钱没问题」。
    // ⚠️ **用数据库时钟**（不是 `new Date()`）—— 混用两套时钟，
    //    库与应用差几毫秒就会在边界上判错。
    const now = await this.prisma.databaseNow();
    if (from.getTime() > now.getTime()) {
      throw new BadRequestException('时间窗不能落在未来');
    }
  }

  /**
   * 校验渠道可用。
   *
   * ⚠️ **文案不要写成「该渠道不支持批量查单」** —— 那暗示是渠道能力问题，
   *    运营看到会以为系统坏了；实际原因是「本地假网关没开」。
   */
  private assertChannelAvailable(channel: string, throwOnFail = true): boolean {
    const provider = this.providers.get(channel);
    const available = !!provider && this.isFakeChannelUsable(channel);
    if (!available && throwOnFail) {
      throw new ConflictException(
        `该渠道当前不可用（${FAKE_PAYOUT_UNAVAILABLE_MESSAGE}），无法执行渠道对账`,
      );
    }
    return available;
  }

  /** 假网关是否可用（开关开着且 provider 在册） */
  private isFakeChannelUsable(channel: string): boolean {
    // ⚠️ **当前只有一个渠道** —— 用假网关自己的开关判断
    //    （渠道名要匹配假网关，将来接了真渠道不能拿假网关的开关说它可用）
    return channel === FAKE_PAYOUT_CHANNEL && isFakePayoutEnabled();
  }
}
```

⚠️ **DTO 里的 `channel` 校验**：`assertChannelAvailable` 查 `this.providers.get(channel)` → 渠道名不是 `fake-payout` 时会抛 409 ✅

- [ ] **Step 4: 写定时任务注册器**

新建 `api/src/modules/payment/payout-reconcile.scheduler.ts`：

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { isFakePayoutEnabled } from '../../common/payment/fake-payout.provider';
import { FAKE_PAYOUT_CHANNEL } from '../../common/payment/fake-payout.provider';

/**
 * 渠道对账的周期任务注册器（阶段 5m）。
 *
 * ⚠️ **假网关未启用时根本不注册这个周期任务** —— 而不是注册了让它每天失败。
 *    生产环境 `assertSecureConfig` 在 `FAKE_PAYOUT_ENABLED === 'true'` 时拒绝启动
 *    → 生产环境假网关必然不可用 → `listPayouts` 会抛错 →
 *    注册了就是**每天落一条 `FAILED` 任务**，对账列表变成「每天都失败」，比不做还糟。
 */
@Injectable()
export class PayoutReconcileScheduler implements OnModuleInit {
  constructor(private readonly queue: QueueService) {}

  async onModuleInit(): Promise<void> {
    if (!isFakePayoutEnabled()) {
      return;
    }
    await this.queue.addRepeating(
      PAYOUT_QUEUE,
      'reconcile',
      { channel: FAKE_PAYOUT_CHANNEL },
      24 * 60 * 60 * 1000,
      'payout-reconcile',
    );
  }
}
```

- [ ] **Step 5: `payout.worker.ts` 加 `'reconcile'` job 分支**

改 `api/src/modules/payment/payout.worker.ts` 的 `process`（当前 `:84-93`）：

```ts
  async process(job: Job<PayoutJob>): Promise<void> {
    if (job.name === 'scan') {
      await this.runScan();
      return;
    }
    if (job.name === 'reconcile') {
      // ⚠️ **定时对账**（阶段 5m）
      await this.runReconcile(job.data.channel);
      return;
    }
    if (job.name !== 'execute') {
      return;
    }
    await this.runExecute(job.data.payoutId);
  }
```

⚠️ `PayoutJob` 接口要加 `channel?: string`（`'reconcile'` job 的数据）：

```ts
/** 出款队列任务的数据 */
export interface PayoutJob {
  /** 出款单 id（`'execute'` job） */
  payoutId: string;
  /** 渠道名（`'reconcile'` job） */
  channel?: string;
}
```

并在类里加：

```ts
  /**
   * 定时对账（阶段 5m）。
   *
   * ⚠️ **失败不抛到 BullMQ** —— 抛出去会让 BullMQ 把它记成失败 job，
   *    而对账服务**自己已经**把任务落成了 `FAILED` 并写了原因。
   */
  private async runReconcile(channel: string | undefined): Promise<void> {
    if (!channel) {
      return;
    }
    try {
      await this.reconciliation.runScheduled(channel);
    } catch (error) {
      this.logger.error(
        `定时渠道对账失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
```

⚠️ `PayoutWorker` 的构造器要加 `private readonly reconciliation: PayoutReconciliationService`（**加在末尾**，避免打乱 `payout-worker.spec.ts` 的构造参数顺序 —— 那个 spec 用位置参数构造 worker，加在末尾就不用改现有用例）。

- [ ] **Step 6: 写 controller**

新建 `api/src/modules/payment/platform-payout-reconciliation.controller.ts`：

```ts
import {
  BadRequestException,
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
import { getTenantContext } from '../../common/tenant/tenant-context';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  ConfirmPaidDto,
  ListReconciliationsDto,
  ResolveReconciliationItemDto,
  TriggerReconciliationDto,
} from './dto/payout-reconciliation.dto';

/**
 * 平台侧的渠道对账接口（阶段 5m）。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`** —— 新表不受租户作用域约束，
 *    只有平台超管能查（护栏 P10）。
 *
 * ⚠️ **控制器放在 payment 模块**（设计 §七·7.5）——
 *    billing 绝对不能 import payment，而对账要碰渠道。
 *
 * ⚠️ **路由前缀是 `/platform/payout-reconciliations`，不是 `/platform/payouts/...`**
 *    —— billing 那边有 `@Get('payouts/:id')`（`platform-payout.controller.ts`），
 *    而 **billing 模块先于 payment 模块注册路由**（`payment.module.ts` 的
 *    `imports` 里有 `BillingModule` → NestJS 按依赖图先注册它）。
 *    → 对账端点若挂在 `/platform/payouts/` 下，`reconciliations` 与
 *    `reconciliation-summary` 这两个**单段**路径会被 `payouts/:id` 抢先匹配
 *    → `ParseUUIDPipe` 直接 400，**列表与统计端点 100% 不可达**。
 *    挪到独立前缀后，第 2 段是字面量 `payout-reconciliations`，与
 *    billing 的 `payouts` 不撞。
 */
@ApiTags('platform-payout-reconciliations')
@Controller('platform/payout-reconciliations')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformPayoutReconciliationController {
  constructor(
    private readonly reconciliations: PayoutReconciliationService,
    private readonly execution: PayoutExecutionService,
    private readonly prisma: TenantPrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: '对账任务列表' })
  async list(@Query() query: ListReconciliationsDto) {
    return this.reconciliations.list(query);
  }

  /**
   * ⚠️ **必须声明在 `:id` 之前** —— 两者都是 3 段
   *    （`payout-reconciliations/summary` 与 `payout-reconciliations/:id`），
   *    Express 按注册顺序先匹配先赢 → `summary` 在前才不会被 `:id` 吃掉。
   *    （「遮蔽」是静默的 400，e2e 已守住。）
   */
  @Get('summary')
  @ApiOperation({ summary: '未处置差异的统计（给横幅用）' })
  async summary() {
    return this.reconciliations.summary();
  }

  @Get('payouts/:payoutId/status')
  @ApiOperation({ summary: '该单最近一次对账结论' })
  async reconciliationStatus(
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
  ) {
    return this.reconciliations.statusForPayout(payoutId);
  }

  @Get(':id')
  @ApiOperation({ summary: '对账任务详情 + 差异列表' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.reconciliations.detail(id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手动触发渠道对账',
    description:
      '同步执行。⚠️ **不查幂等** —— 手动重跑是有意行为。' +
      '时间窗跨度上限 31 天，渠道记录数上限 10000 条，执行超时 30 秒。',
  })
  async trigger(@Body() dto: TriggerReconciliationDto) {
    const operatorId = this.currentOperatorId();
    return this.reconciliations.trigger({
      channel: dto.channel,
      from: new Date(dto.from),
      to: new Date(dto.to),
      operatorId,
    });
  }

  @Post(':id/items/:itemId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '处置一条对账差异' })
  async resolveItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: ResolveReconciliationItemDto,
  ) {
    await this.reconciliations.resolveItem(id, itemId, {
      resolution: dto.resolution,
      note: dto.note,
      operatorId: this.currentOperatorId(),
    });
    // ⚠️ **不能直接返回 boolean** —— Express 的 `res.send(true)` 会把
    //    布尔值当字符串发出去（`Content-Type: text/html`，body 是 `"true"`）
    //    → 前端 `response.json()` 直接抛「Unexpected token t」。
    //    → 一律返回对象。
    return { resolved: true };
  }

  @Post('payouts/:payoutId/confirm-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '人工确认「渠道已打款」（B 类处置）',
    description:
      '把一张记成失败的出款单纠正为已付款。会复原明细并联动结算单，' +
      '走四道闸：明细可复原、金额与笔数对得上、明细未被他人占用、渠道核实。',
  })
  async confirmPaid(
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
    @Body() dto: ConfirmPaidDto,
  ) {
    await this.execution.confirmPaidAfterReconciliation(payoutId, {
      reason: dto.reason,
      operatorId: this.currentOperatorId(),
      reconciliationId: dto.reconciliationId,
    });
    // ⚠️ **同 `resolveItem` —— 不能返回 boolean**（Express 会把它发成
    //    `text/html` 的 `"true"`，前端 `response.json()` 解析不了）。
    return { confirmed: true };
  }

  /** 取当前操作人（平台超管的用户 id） */
  private currentOperatorId(): string {
    const context = getTenantContext();
    if (!context.userId) {
      throw new BadRequestException('缺少用户上下文');
    }
    return context.userId;
  }
}
```

- [ ] **Step 7: 补对账服务的其余方法**

追加到 `api/src/modules/payment/payout-reconciliation.service.ts` 的类里：

```ts
  /** 对账任务列表（分页） */
  async list(query: {
    page?: number;
    pageSize?: number;
  }): Promise<{ items: unknown[]; total: number }> {
    // ⚠️ **用 `clampPagination` 而不是手写夹取** ——
    //    `page` 是页码不是每页条数，夹住它的上限会让 100 页之后的数据
    //    **永远取不到**（对账任务是只增不减的历史表，比订单列表更敏感）。
    //    `clampPagination` 只夹 `page` 的下限、夹 `pageSize` 的 1..100，
    //    正是这里要的。
    const { page, pageSize } = clampPagination(query.page, query.pageSize);
    return tenantContext.run(platformScope(), async () => {
      const [items, total] = await Promise.all([
        this.prisma.payoutReconciliation.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.payoutReconciliation.count(),
      ]);
      return { items, total };
    });
  }

  /** 对账任务详情 + 差异列表 */
  async detail(id: string): Promise<unknown> {
    return tenantContext.run(platformScope(), async () => {
      const reconciliation = await this.prisma.payoutReconciliation.findFirst({
        where: { id },
        include: { items: true },
      });
      if (!reconciliation) {
        throw new NotFoundException('对账任务不存在');
      }
      // ⚠️ **差异项要截断** —— 一个对账任务最多能产生上万条差异
      //    （渠道记录数上限就是 10000 条），一次性全吐给浏览器会卡死。
      //    → 截断并**明确告诉前端被截断了**（`itemsTruncated`），
      //    静默截断会让人以为「就这些差异」。
      const items = reconciliation.items.slice(0, RECONCILIATION_MAX_ITEMS);
      return {
        ...reconciliation,
        items,
        itemsTruncated: reconciliation.items.length > items.length,
        itemsTotal: reconciliation.items.length,
      };
    });
  }

  /** 处置一条差异 */
  async resolveItem(
    reconciliationId: string,
    itemId: string,
    input: { resolution: 'RESOLVED' | 'IGNORED'; note: string; operatorId: string },
  ): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payoutReconciliationItem.updateMany({
        where: { id: itemId, reconciliationId },
        data: {
          resolution: input.resolution,
          note: input.note,
          resolvedBy: input.operatorId,
          resolvedAt: await this.prisma.databaseNow(),
        },
      });
      if (affected.count === 0) {
        throw new NotFoundException('差异项不存在');
      }
      return true;
    });
  }

  /** 该单最近一次对账结论 */
  async statusForPayout(payoutId: string): Promise<unknown> {
    return tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliationItem.findFirst({
        where: { payoutId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** 未处置差异的统计 */
  async summary(): Promise<{
    pendingCritical: number;
    pendingWarning: number;
    pendingInfo: number;
  }> {
    return tenantContext.run(platformScope(), async () => {
      const items = await this.prisma.payoutReconciliationItem.findMany({
        where: { resolution: ReconciliationResolution.PENDING },
        select: { severity: true },
      });
      return {
        pendingCritical: items.filter(
          (i) => i.severity === ReconciliationSeverity.CRITICAL,
        ).length,
        pendingWarning: items.filter(
          (i) => i.severity === ReconciliationSeverity.WARNING,
        ).length,
        pendingInfo: items.filter(
          (i) => i.severity === ReconciliationSeverity.INFO,
        ).length,
      };
    });
  }
```

⚠️ **补 import**：`NotFoundException`（`@nestjs/common`）、`ReconciliationSeverity`（`@prisma/client`）。

- [ ] **Step 8: 改 `payment.module.ts`**

```ts
  imports: [
    AuthModule,
    OrderModule,
    CouponModule,
    BillingModule,
    PayoutProvidersModule,
  ],
  controllers: [
    PaymentController,
    WebhookController,
    FakePaymentController,
    SubscriptionPaymentController,
    FakePayoutController,
    // ⚠️ **渠道对账**（阶段 5m）
    PlatformPayoutReconciliationController,
  ],
  providers: [
    // ... 现有的
    // ⚠️ **渠道对账**（阶段 5m）
    PayoutReconciliationService,
    PayoutReconcileScheduler,
  ],
```

⚠️ **`PayoutReconciliationResolver` 在 Task 6 就已经注册过了** ——
Task 6 的 e2e 要用 `app.get(PayoutReconciliationResolver)`，所以它必须**先**注册进去。
**这里不要再写一遍**（同一个类注册两次虽然 NestJS 不报错，但会让「谁负责注册它」变模糊）。

⚠️ `PayoutReconciliationService` 注入 `PayoutReconciliationResolver`（同模块 ✅）与 `PayoutExecutionService`（billing，已导出 ✅）。

⚠️ `PlatformPayoutReconciliationController` 注入 `PayoutExecutionService`（billing ✅）与 `TenantPrismaService`（全局 ✅）。

- [ ] **Step 9: 补六类差异的 e2e**

新建 `api/test/payout-reconciliation-service.e2e-spec.ts`（**独立文件** —— 对账服务与差异分类是另一个主题）：

```ts
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import {
  PayoutStatus,
  ReconciliationDiffType,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { FakePayoutProvider } from '../src/common/payment/fake-payout.provider';
import { PayoutReconciliationService } from '../src/modules/payment/payout-reconciliation.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { resetPayoutData, seedPayout } from './payout-fixture';

describe('渠道对账服务与差异分类 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let fakeProvider: FakePayoutProvider;
  let payoutQueue: Queue;

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
    fakeProvider = app.get(FakePayoutProvider);
    payoutQueue = app.get(getQueueToken(PAYOUT_QUEUE));

    // ⚠️ **暂停出款队列** —— 造数是直接插库的，
    //    worker 若抢到别的单会把队列状态搅乱。
    await payoutQueue.pause();

    // ⚠️ **对账是平台级扫描** —— 别的 e2e 文件留下的出款单会进比对结果
    //    （本地 PAID + 渠道查无此笔 → 多出一条 E 类差异）。
    //    e2e 文件共享同一个测试库 → 必须从干净状态开始。
    await resetPayoutData(prisma);
  });

  afterAll(async () => {
    await payoutQueue.resume();
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
    const body = response.body as { accessToken: string };
    return body.accessToken;
  }
```

然后追加一个用例，造出 A–F 六类差异并断言分类：

⚠️ **造数路线**（设计 §九·9.2）：**队列继续暂停**，e2e 直接调 `fakeProvider.execute({ referenceNo: payout.payoutNo, ... })` 造渠道流水。

```ts
  it('六类差异：造出 A/B/C/D/E/F 并断言分类', async () => {
    const merchant = await createMerchant(app, prisma);
    const tenantId = merchant.tenantId;

    // A 类：渠道 SUCCESS + 本地 PROCESSING
    const aPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // B 类：渠道 SUCCESS + 本地 FAILED
    const bPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.FAILED,
      failedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // C 类：渠道 SUCCESS + 本地 PAID + 金额不同
    const cPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // E 类：本地 PAID + 渠道查无此笔
    const ePayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // F 类：渠道 FAILED + 本地 PAID
    const fPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const call = (referenceNo: string, amount: number, attempt = 1) =>
      fakeProvider.execute({
        referenceId: referenceNo,
        referenceNo,
        amount,
        account: { accountName: '张三', bankName: '测试银行', accountNo: '6222000000000000' },
        attempt,
      });

    await call(aPayout.payoutNo, aPayout.netAmount);
    await call(bPayout.payoutNo, bPayout.netAmount);
    await call(cPayout.payoutNo, cPayout.netAmount + 1); // 金额不同
    fakeProvider.armScenario({ failTimes: 1 });
    await call(fPayout.payoutNo, fPayout.netAmount);
    // D 类：只调渠道、不建本地单
    await call('PAY-NOT-OURS-001', 1234);

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await app
      .get(PayoutReconciliationService)
      .trigger({ channel: 'fake-payout', from, to, operatorId: 'admin-1' });

    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: result.id },
      }),
    );
    const types = items.map((i) => i.type).sort();
    expect(types).toEqual(
      [
        ReconciliationDiffType.AMOUNT_MISMATCH,
        ReconciliationDiffType.CHANNEL_ONLY,
        ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
        ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
        ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
        ReconciliationDiffType.STATUS_MISMATCH,
      ].sort(),
    );
    // ⚠️ **E 类要单独断言** —— 它没有渠道流水，靠「本地 PAID 且查无此笔」判定
    const eItem = items.find((i) => i.payoutId === ePayout.id);
    expect(eItem?.type).toBe(ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT);
  });
```

⚠️ `ePayout` 与 `cPayout`/`fPayout` 都是 `PAID` 且金额相同 → 若渠道侧有 c/f 的记录，E 类只对 e 成立 ✅（c 的金额不同 → C 类；f 的渠道 FAILED → F 类）。

⚠️ **E 类要单独断言** —— 上面的 `types` 断言只证明「六类都出现了」，**不能证明 E 类指向的是 `ePayout`**（万一 E 类错指到别的单上，`types` 断言照样通过）。所以要再补一条按 `payoutId` 定位的断言。

- [ ] **Step 10: 验证**

```bash
cd api && npx tsc --noEmit
```

预期：无输出。

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payout-reconciliation-service.e2e-spec.ts
```

预期：1 个用例通过（一个用例里造出 A–F 六类差异并逐类断言）。

⚠️ **失败注入必须独占** —— 不要与全量测试并发跑。

- [ ] **Step 11: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/src/common/payment/payout.constants.ts \
        api/src/common/payment/fake-payout.provider.ts \
        api/src/modules/payment/
git commit -m "feat(payment): 渠道对账服务、平台端点与定时任务

对账服务同步执行，但设三道上限：窗口跨度 ≤ 31 天、渠道记录数 ≤ 10000 条、
执行 ≤ 30 秒。超限一律落 FAILED 并写明原因，不做静默截断 —— 截断出来的
对账结论是错的。

本地单按 paidAt / processingAt / failedAt 三个时间戳捞 —— 判据是
「这张单调过渠道」。用 createdAt 筛会把还没调过渠道的单也捞进来，
它们在渠道侧压根没有记录，全变成假的 D 类。

差异项每次对账都会重新产生，去重靠把历史上同 (payoutId, type) 的 PENDING
项标 IGNORED；历史记录保留，审计时要能看到这个问题被发现过几次。

定时任务在假网关未启用时根本不注册 —— 注册了就是每天落一条 FAILED，
对账列表变成「每天都失败」，比不做还糟。"
```

---

### Task 9: CSV 账单导入

**Files:**
- Modify: `api/package.json`（加 `papaparse` 与 `@types/multer`）
- Create: `api/src/modules/payment/payout-reconciliation-csv.ts`
- Create: `api/src/modules/payment/dto/payout-reconciliation-import.dto.ts`
- Modify: `api/src/modules/payment/platform-payout-reconciliation.controller.ts`
- Modify: `api/src/modules/payment/payment.module.ts`
- Test: `api/test/payout-reconciliation-import.e2e-spec.ts`（新建，本 Task 放 CSV 导入用例）

**依赖：** Task 8。

⚠️ **本仓首次引入 multipart 与文件解析** —— `api/src/` 下 `multipart` / `FileInterceptor` / `UploadedFile` / `MulterModule` **零结果**；`@types/multer` 不在 devDependencies；**无任何 CSV 解析库**；`api/test/` 下**零个** `.attach` / `FormData` 用例。

- [ ] **Step 1: 装依赖**

```bash
cd api && npm i papaparse && npm i -D @types/multer
```

⚠️ **`multer` 只是 `@nestjs/platform-express` 的传递依赖，没有类型** → 必须装 `@types/multer`。

- [ ] **Step 2: 写列映射的类型与校验**

新建 `api/src/modules/payment/payout-reconciliation-csv.ts`：

```ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import Papa from 'papaparse';
import type { ChannelPayoutRecord } from '../../common/payment/payout-provider.interface';

/** 金额单位 */
export type CsvAmountUnit = 'CENT' | 'YUAN';

/**
 * CSV 的列映射（超管上传时指定）。
 *
 * ⚠️ **真渠道的 CSV 字段千差万别** → 不能用固定模板
 *    （要超管先整理成模板，等于把对账的价值打没）。
 */
export interface CsvColumnMapping {
  /** 渠道交易号列（**必填** —— 否则无法匹配） */
  txnIdColumn: string;
  /** 业务单号列（选填，`payoutNo` 匹配用） */
  referenceNoColumn?: string;
  /** 金额列（**必填**） */
  amountColumn: string;
  /**
   * ⚠️ **金额单位** —— 猜错就是金额差 100 倍。
   */
  amountUnit: CsvAmountUnit;
  /**
   * 状态列（**必填**）。
   *
   * ⚠️ **为什么改成必填** —— 不配状态列就**无从判断渠道是否真的打了款**。
   *    比对引擎只在渠道状态**恰好是 `'SUCCESS'`** 时才判 A 类
   *    （`payout-reconcile.engine.ts` 的 `authoritative.status === 'SUCCESS'` 分支）
   *    → A 类是**唯一会自动改钱状态**的差异（`PROCESSING → PAID`）。
   *    → 曾经的做法是「不配就当 SUCCESS」→ **所有渠道流水都被当成渠道已打款成功**
   *    → 本地还卡在 `PROCESSING` 的单全被判成 A 类 → **自动改成已付款**。
   *    → 那等于**系统替运营做了一个可能错的假设**，是最不能接受的一类默认。
   *    → 现在改成必填：配不了就别导，不给「误改钱状态」留口子。
   */
  statusColumn: string;
  /**
   * ⚠️ **状态值映射** —— 渠道的状态词五花八门（成功/已付/打款成功/0/1）。
   *    **与状态列同进同出** —— 配了状态列却不配映射 → 每个状态词原样落进
   *    `status` → 引擎只认 `'SUCCESS'` / `'FAILED'` 两个精确值 →
   *    全落进 g 档「渠道非终态 → 不算差异」→ **A/B/C/F 四类差异全部检不出来**，
   *    而响应里 `diffCount` 仍是 0 → 运营当成「一切正常」。
   *    → 不配映射等于「导入了但没对账」，比不导还糟（它假装做了）。
   */
  statusMapping: Record<string, string>;
  /**
   * 打款时间列（选填）。
   *
   * ⚠️ **不配这一列有严重后果** —— 比对引擎的 **D 类**（「渠道有、本地没有」，
   *    也就是**渠道打了钱而本地没记录**）判定依赖「这条流水的时刻是否落在
   *    扩大窗口内」，**没有时刻就无从判断** → 引擎会直接跳过这类记录。
   *    → **不配 `paidAtColumn` 的账单，所有 D 类差异都是不可见的**。
   *
   * ⚠️ **同一后果还有第二处** —— 归组排序也用 `paidAt`：全部记录都没有时刻时，
   *    排序退化成按 `providerTxnId` 的字典序（引擎有 tie-break，结论仍然确定，
   *    但「取 `paidAt` 最晚的那条」这条兜底就变成了「取交易号最大的那条」）。
   *
   * → **本阶段仍保持选填**（真实渠道的账单未必有时间列），
   *    但**导入端必须提示运营**：不配时间列 → D 类差异检不出来。
   */
  paidAtColumn?: string;
}

/** 导入的行数上限（与渠道记录数上限一致） */
export const CSV_MAX_ROWS = 10_000;

/**
 * 响应里最多回多少条「被跳过的行」的明细。
 *
 * ⚠️ **回明细是为了让运营能回去查原账单** —— 只给一个总数，运营还得自己
 *    数第几行有问题。
 * ⚠️ **超出的部分必须带 `skippedRowsTruncated` 标记** —— 静默截断会让人
 *    以为「就这么多行有问题」（与 `RECONCILIATION_MAX_ITEMS` 同一原则）。
 */
export const CSV_MAX_SKIPPED_ROWS_REPORTED = 100;

/**
 * 没有解析出任何「打款时间」时给运营的提示。
 *
 * ⚠️ **必须提示，不能静默** —— D 类（「渠道打了钱而本地没记录」）的判定
 *    依赖流水的时刻是否落在扩大窗口内。没有时刻 → 引擎的 D 类判定直接跳过
 *    → **渠道多打的钱一笔都检不出来**，而运营看到的是「差异数 0，一切正常」。
 *    静默就是给出「钱没问题的假象」。
 *
 * ⚠️ **不区分「没配列」与「配列全空」** —— 两者的后果**完全一样**
 *    （D 类都检不出来），对运营来说也只需要同一个动作：去补时刻。
 *    → 用同一句话覆盖两种情形，别让运营去分辨「是配置问题还是数据问题」。
 */
export const CSV_NO_PAID_AT_WARNING =
  '账单里没有解析出任何「打款时间」：渠道流水的时刻全部缺失，' +
  'D 类差异（渠道已打款、本地无记录）检不出来 —— ' +
  '请确认列映射里的 `paidAtColumn` 是否指向了真正的打款时间列、' +
  '且该列的格式能被解析后重新导入。';

/**
 * 校验列映射。
 *
 * @throws BadRequestException 映射不合法时抛
 */
export function assertColumnMapping(value: unknown): CsvColumnMapping {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestException('列映射不能为空');
  }
  const raw = value as Record<string, unknown>;
  const txnIdColumn = raw.txnIdColumn;
  const amountColumn = raw.amountColumn;
  const amountUnit = raw.amountUnit;

  if (typeof txnIdColumn !== 'string' || txnIdColumn.trim() === '') {
    throw new BadRequestException('必须指定「渠道交易号」列');
  }
  if (typeof amountColumn !== 'string' || amountColumn.trim() === '') {
    throw new BadRequestException('必须指定「金额」列');
  }
  if (amountUnit !== 'CENT' && amountUnit !== 'YUAN') {
    throw new BadRequestException('必须指定金额单位（分 或 元）');
  }
  // ⚠️ **状态列必填** —— 不配状态列就无从判断渠道是否真的打了款。
  //    比对引擎只在渠道状态**恰好是 `'SUCCESS'`** 时才判 A 类，
  //    而 A 类是**唯一会自动改钱状态**的差异（`PROCESSING → PAID`）。
  //    → 曾经「不配就当 SUCCESS」等于替运营做了一个可能错的假设，
  //    会把本地卡在 `PROCESSING` 的单**自动改成已付款**。
  //    → 现在不配就拒：宁可不让导，也不给误改钱留口子。
  const statusColumn = raw.statusColumn;
  if (typeof statusColumn !== 'string' || statusColumn.trim() === '') {
    throw new BadRequestException(
      '必须指定「状态」列：不配这一列就无从判断渠道是否真的打了款 —— ' +
        '所有渠道流水都会被当成「渠道已打款成功」，' +
        '本地还卡在处理中的出款单会被自动改成已付款。' +
        '请在列映射里补上 `statusColumn` 与配套的 `statusMapping` 后重新导入。',
    );
  }
  // ⚠️ **状态值映射与状态列同进同出** —— 配了状态列却不配映射，
  //    渠道的状态词会原样落进 `status` → 引擎只认 `'SUCCESS'` / `'FAILED'`
  //    两个精确值 → 全落进 g 档「渠道非终态 → 不算差异」
  //    → **A/B/C/F 四类差异全部检不出来**，而响应里 `diffCount` 仍是 0
  //    → 运营当成「一切正常」。那等于「导入了但没对账」，比不导还糟。
  const statusMapping = raw.statusMapping;
  if (
    typeof statusMapping !== 'object' ||
    statusMapping === null ||
    Array.isArray(statusMapping) ||
    Object.keys(statusMapping).length === 0
  ) {
    throw new BadRequestException(
      '必须指定「状态值映射」：配了状态列却不配映射，' +
        '渠道的状态词不会被引擎认成成功或失败 → ' +
        'A/B/C/F 四类差异全部检不出来，而差异数仍是 0。',
    );
  }
  return {
    txnIdColumn: txnIdColumn.trim(),
    referenceNoColumn:
      typeof raw.referenceNoColumn === 'string'
        ? raw.referenceNoColumn.trim()
        : undefined,
    amountColumn: amountColumn.trim(),
    amountUnit,
    statusColumn: statusColumn.trim(),
    statusMapping: statusMapping as Record<string, string>,
    paidAtColumn:
      typeof raw.paidAtColumn === 'string' ? raw.paidAtColumn.trim() : undefined,
  };
}

/**
 * 一条被跳过的行。
 *
 * ⚠️ **必须带行号** —— 运营要能回到**原账单**里查这一行到底怎么了。
 *    只说「跳过了 500 行」等于让人自己去数行号。
 */
export interface CsvSkippedRow {
  /** 行号（**账单文件里的物理行号**，第 1 行是表头 → 第一条数据是第 2 行） */
  rowNumber: number;
  /** 跳过的原因（中文，给运营看） */
  reason: string;
}

/** CSV 解析的结果 */
export interface CsvParseResult {
  /** 解析出来的渠道流水 */
  records: ChannelPayoutRecord[];
  /** 被跳过的行（⚠️ **不是空数组就说明账单有行没能参与对账**） */
  skippedRows: CsvSkippedRow[];
  /**
   * ⚠️ **实际解析出了几个打款时刻** —— 不是「配没配列」。
   *
   * → 配了列但整列是空值/格式不对时，这个数是 0 → **后果与不配列完全一样**
   *    （D 类差异全检不出来）→ 提示必须看这个数。
   */
  parsedPaidAtCount: number;
}

/**
 * 把 CSV 解析成渠道流水。
 *
 * ⚠️ **只取白名单列** —— 不做公式展开等富文本特性（解析上传文件是攻击面）。
 * ⚠️ **超行数上限直接报错**，不静默截断 —— 截断出来的对账结论是错的。
 * ⚠️ **跳过的行必须报告出来** —— 一份账单里若有 500 行金额格式不对，
 *    对账结论是**基于剩下的行**算的；运营不知道被跳过了几行 →
 *    看到「差异数 0」就以为钱没问题。
 *    → **静默丢行 = 给出「钱没问题的假象」**，与「不提示 D 类检不出来」同罪。
 */
export function parseCsvToChannelRecords(
  csvText: string,
  mapping: CsvColumnMapping,
): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    // ⚠️ **不跳空行** —— 空行要**占着位置**，
    //    否则后面所有行的行号都会偏移（运营拿着行号回原账单查会对不上）。
    //    空行在下面按「整行皆空」过滤掉，但**索引保留**。
    skipEmptyLines: false,
    // ⚠️ **不启用 dynamicTyping** —— 值全部当字符串，金额与时间我们自己处理
    dynamicTyping: false,
  });

  // ⚠️ **行号 = 物理行号** —— `parsed.data[0]` 对应文件的第 2 行
  //    （第 1 行是表头）→ 行号 = 索引 + 2。
  const rows = parsed.data
    .map((row, index) => ({
      row,
      rowNumber: index + 2,
    }))
    .filter(
      ({ row }) =>
        row && Object.values(row).some((v) => (v ?? '').trim() !== ''),
    );
  if (rows.length > CSV_MAX_ROWS) {
    throw new ConflictException(
      `账单文件有 ${rows.length} 行，超过上限 ${CSV_MAX_ROWS} 行`,
    );
  }

  const records: ChannelPayoutRecord[] = [];
  const skippedRows: CsvSkippedRow[] = [];
  let parsedPaidAtCount = 0;
  for (const { row, rowNumber } of rows) {
    const providerTxnId = (row[mapping.txnIdColumn] ?? '').trim();
    if (!providerTxnId) {
      // ⚠️ **没有交易号的行无法参与匹配** —— 但必须**报告**，
      //    不能静默丢（它可能是渠道多打的一笔钱）。
      skippedRows.push({
        rowNumber,
        reason: `「${mapping.txnIdColumn}」列为空，无法参与匹配`,
      });
      continue;
    }
    const amount = parseAmount(row[mapping.amountColumn], mapping.amountUnit);
    if (amount === null) {
      skippedRows.push({
        rowNumber,
        reason: `「${mapping.amountColumn}」列的金额无法解析（空值或非数字）`,
      });
      continue;
    }
    // ⚠️ **状态列必填**（`assertColumnMapping` 已拒掉不配的）→
    //    这里**不存在**「没有状态」的分支 → **永远不会凭空造出 `'SUCCESS'`**。
    const status = mapStatus(row[mapping.statusColumn], mapping.statusMapping);
    const paidAt = mapping.paidAtColumn
      ? parsePaidAt(row[mapping.paidAtColumn])
      : undefined;
    if (paidAt) {
      parsedPaidAtCount += 1;
    }

    records.push({
      providerTxnId,
      referenceNo: mapping.referenceNoColumn
        ? (row[mapping.referenceNoColumn] ?? '').trim() || undefined
        : undefined,
      amount,
      status,
      paidAt,
    });
  }
  return { records, skippedRows, parsedPaidAtCount };
}

/** 解析金额（按单位换算；解析不出返回 `null`） */
function parseAmount(raw: string | undefined, unit: CsvAmountUnit): number | null {
  const text = (raw ?? '').trim();
  if (text === '') {
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return null;
  }
  // ⚠️ **元 → 分要四舍五入** —— 直接截断会少给商家钱
  return unit === 'YUAN' ? Math.round(value * 100) : Math.round(value);
}

/**
 * 按映射表把渠道的状态词翻成内部状态。
 *
 * ⚠️ **翻不出就落 `'UNKNOWN'`，绝不落 `'SUCCESS'`** ——
 *    引擎只在渠道状态**恰好是 `'SUCCESS'`** 时才判 A 类
 *    （`payout-reconcile.engine.ts`：`authoritative.status === 'SUCCESS'`），
 *    而 A 类会**自动把本地出款单从 `PROCESSING` 改成 `PAID`**。
 *    → `'UNKNOWN'` 走引擎的 g 档「渠道非终态 → 不算差异」→ **不改钱**。
 *    → 反过来说：**宁可漏判，也不能误判成「渠道已打款」**。
 */
function mapStatus(
  raw: string | undefined,
  mapping: Record<string, string>,
): string {
  const text = (raw ?? '').trim();
  if (!text) {
    return 'UNKNOWN';
  }
  return mapping[text] ?? 'UNKNOWN';
}

/** 解析打款时刻（解析不出返回 `undefined`） */
function parsePaidAt(raw: string | undefined): Date | undefined {
  const text = (raw ?? '').trim();
  if (!text) {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
```

- [ ] **Step 3: 写导入的 DTO**

新建 `api/src/modules/payment/dto/payout-reconciliation-import.dto.ts`：

```ts
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * CSV 账单导入的入参。
 *
 * ⚠️ **列映射走 JSON 字符串** —— multipart 的 body 部分是字符串，
 *    Nest 的 ValidationPipe 对 `Object` 类型的 metatype 会**跳过校验**，
 *    所以这里声明成 `string` 并在服务层自己 `JSON.parse` + 逐项校验。
 */
export class ImportReconciliationDto {
  /** 列映射（JSON 字符串） */
  @IsString()
  @MinLength(2)
  columnMapping!: string;

  /** 渠道名（选填，默认 `fake-payout`） */
  @IsOptional()
  @IsString()
  @MinLength(1)
  channel?: string;

  /** 时间窗起点（含，ISO 字符串） */
  @IsOptional()
  @IsString()
  from?: string;

  /** 时间窗终点（不含，ISO 字符串） */
  @IsOptional()
  @IsString()
  to?: string;
}
```

- [ ] **Step 4: 在 controller 里加导入端点**

改 `api/src/modules/payment/platform-payout-reconciliation.controller.ts`：

① 补 import：

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assertColumnMapping,
  CSV_MAX_SKIPPED_ROWS_REPORTED,
  CSV_NO_PAID_AT_WARNING,
  parseCsvToChannelRecords,
} from './payout-reconciliation-csv';
import { ImportReconciliationDto } from './dto/payout-reconciliation-import.dto';
```

② 加端点：

```ts
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  @ApiOperation({
    summary: '导入渠道账单文件（CSV）',
    description:
      '⚠️ **本仓第一个 multipart 接口**。上传时指定列映射 —— ' +
      '真渠道的 CSV 字段千差万别，用固定模板等于把对账的价值打没。' +
      '文件上限 5MB、行数上限 10000 行。',
  })
  async importCsv(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportReconciliationDto,
  ) {
    if (!file) {
      throw new BadRequestException('请上传账单文件');
    }
    // ⚠️ **原始文件不落盘** —— 只存解析后的记录 + 映射配置 + 文件名
    const csvText = file.buffer.toString('utf8');
    let mappingRaw: unknown;
    try {
      mappingRaw = JSON.parse(dto.columnMapping);
    } catch {
      throw new BadRequestException('列映射不是合法的 JSON');
    }
    const mapping = assertColumnMapping(mappingRaw);
    const parsed = parseCsvToChannelRecords(csvText, mapping);
    const result = await this.reconciliations.importRecords({
      channel: dto.channel ?? 'fake-payout',
      fileName: file.originalname,
      columnMapping: JSON.stringify(mapping),
      records: parsed.records,
      from: dto.from ? new Date(dto.from) : undefined,
      to: dto.to ? new Date(dto.to) : undefined,
      operatorId: this.currentOperatorId(),
    });
    // ⚠️ **提示要基于「实际解析出了几个时刻」，不是「配没配列」** ——
    //    配了时间列但整列是空值/格式不对 → 一个时刻都解析不出来
    //    → **后果与不配列完全一样**（D 类检不出来），
    //    而响应里 `diffCount` 可能仍是 0（运营会当成「一切正常」）。
    const warning =
      parsed.parsedPaidAtCount === 0 ? CSV_NO_PAID_AT_WARNING : undefined;
    // ⚠️ **被跳过的行必须报告，不能静默丢** —— 对账结论是基于
    //    **剩下的行**算出来的；运营不知道跳了几行 → 看到「差异数 0」
    //    就以为钱没问题。
    // ⚠️ **明细要截断但必须带标记** —— 与 `RECONCILIATION_MAX_ITEMS` 同一原则：
    //    静默截断会让人以为「就这么多行有问题」。
    const reported = parsed.skippedRows.slice(0, CSV_MAX_SKIPPED_ROWS_REPORTED);
    return {
      ...result,
      ...(warning ? { warning } : {}),
      skippedRowCount: parsed.skippedRows.length,
      skippedRows: reported,
      skippedRowsTruncated: parsed.skippedRows.length > reported.length,
    };
  }
```

- [ ] **Step 5: 在对账服务里加 `importRecords`**

追加到 `api/src/modules/payment/payout-reconciliation.service.ts`：

```ts
  /**
   * 导入渠道账单文件并对账（阶段 5m）。
   *
   * ⚠️ **两条来源走同一个比对引擎** —— API 拉来的记录与 CSV 解析出的记录，
   *    都转成 `ChannelPayoutRecord[]` 后进同一个 `reconcile()`。
   *
   * ⚠️ **`expandedWindow` 与 `window` 同区间** —— API 来源的「扩大窗口」
   *    是为了容忍渠道侧时钟偏移（提前 15 小时发起、延后 15 小时到账）；
   *    CSV 是运营自己挑的时间窗，没有偏移可容忍 → 扩大反而会把
   *    窗口外的渠道流水误判成 D 类（渠道打了钱而本地没有）→ 假告警。
   */
  async importRecords(input: {
    channel: string;
    fileName: string;
    columnMapping: string;
    records: ChannelPayoutRecord[];
    from?: Date;
    to?: Date;
    operatorId: string;
  }): Promise<{ id: string; diffCount: number; matchedCount: number }> {
    const now = await this.prisma.databaseNow();
    const to = input.to ?? now;
    const from = input.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
    await this.assertWindow(from, to);
    if (input.records.length > RECONCILIATION_MAX_CHANNEL_RECORDS) {
      throw new ConflictException(
        `账单文件有 ${input.records.length} 条流水，超过上限 ${RECONCILIATION_MAX_CHANNEL_RECORDS} 条`,
      );
    }

    const reconciliation = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.create({
        data: {
          channel: input.channel,
          source: ReconciliationSource.FILE,
          windowFrom: from,
          windowTo: to,
          fileName: input.fileName,
          columnMapping: input.columnMapping,
          status: ReconciliationStatus.RUNNING,
          triggeredBy: input.operatorId,
        },
      }),
    );

    const localPayouts = await this.loadLocalPayouts(from, to);
    const output = reconcile({
      window: { from, to },
      expandedWindow: { from, to },
      localPayouts,
      channelRecords: input.records,
    });

    await tenantContext.run(platformScope(), async () => {
      await this.supersedePreviousPending(output.diffs, reconciliation.id);
      if (output.diffs.length > 0) {
        await this.prisma.payoutReconciliationItem.createMany({
          data: output.diffs.map((diff) => ({
            reconciliationId: reconciliation.id,
            type: diff.type,
            severity: diff.severity,
            payoutId: diff.payoutId,
            channelTxnId: diff.channelTxnId,
            channelReferenceNo: diff.channelReferenceNo,
            channelAmount: diff.channelAmount,
            channelStatus: diff.channelStatus,
            channelPaidAt: diff.channelPaidAt,
            localAmount: diff.localAmount,
            localStatus: diff.localStatus,
          })),
        });
      }
      await this.prisma.payoutReconciliation.updateMany({
        where: { id: reconciliation.id },
        data: {
          status: ReconciliationStatus.COMPLETED,
          finishedAt: await this.prisma.databaseNow(),
          channelCount: input.records.length,
          localCount: localPayouts.length,
          matchedCount: output.matchedCount,
          diffCount: output.diffs.length,
        },
      });
    });

    await this.resolver.resolveAutoDiffs(output.diffs, reconciliation.id);

    return {
      id: reconciliation.id,
      diffCount: output.diffs.length,
      matchedCount: output.matchedCount,
    };
  }
```

⚠️ **补 import**：`ChannelPayoutRecord`（类型）、`ReconciliationSource`（已在 import 列表里 ✅）。

- [ ] **Step 6: `payment.module.ts` 注册 MulterModule**

在 `api/src/modules/payment/payment.module.ts` 的 `imports` 里加：

```ts
    // ⚠️ **multipart**（阶段 5m）—— 本仓第一个文件上传的接口。
    //    MulterModule 提供 `FileInterceptor` 需要的 multer 实例。
    MulterModule.register({ limits: { fileSize: 5 * 1024 * 1024 } }),
```

并补 import：`import { MulterModule } from '@nestjs/platform-express';`

- [ ] **Step 7: 写 e2e**

新建 `api/test/payout-reconciliation-import.e2e-spec.ts`（**独立文件** —— CSV 导入是另一个主题）：

```ts
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import { PayoutStatus, ReconciliationDiffType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { resetPayoutData, seedPayout } from './payout-fixture';

describe('渠道对账的 CSV 账单导入 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let payoutQueue: Queue;

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
    payoutQueue = app.get(getQueueToken(PAYOUT_QUEUE));

    // ⚠️ **暂停出款队列** —— 造数是直接插库的，
    //    worker 若抢到别的单会把队列状态搅乱。
    await payoutQueue.pause();

    // ⚠️ **对账是平台级扫描** —— 别的 e2e 文件留下的出款单会进比对结果
    //    （本地 PAID + 渠道查无此笔 → 多出一条 E 类差异）。
    //    e2e 文件共享同一个测试库 → 必须从干净状态开始。
    await resetPayoutData(prisma);
  });

  afterAll(async () => {
    await payoutQueue.resume();
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
    const body = response.body as { accessToken: string };
    return body.accessToken;
  }
```

然后追加一个用例：

```ts
  it('CSV 导入：上传一份账单 → 断言解析出的差异', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // ⚠️ **本仓第一个 multipart e2e** —— supertest 的 `.attach` + `.field`
    const csv = [
      '交易号,业务单号,金额(元),状态,打款时间',
      `txn-csv-1,${payout.payoutNo},85.00,成功,2026-03-02 10:00:00`,
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          referenceNoColumn: '业务单号',
          amountColumn: '金额(元)',
          amountUnit: 'YUAN',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS', 失败: 'FAILED' },
          paidAtColumn: '打款时间',
        }),
      );

    expect(response.status).toBe(200);
    // ⚠️ **金额单位换算** —— 85.00 元 = 8500 分
    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: response.body.id },
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe(ReconciliationDiffType.CHANNEL_PENDING_LOCAL);
    expect(items[0].channelAmount).toBe(8500);
  });
```

⚠️ **上面这一条只覆盖「账单能解析、差异能产出」。下面三条覆盖三个**静默失败** —— 少了它们，缺陷会以「看起来一切正常」的形式溜过去。

**① 不配状态列 → 拒绝导入，且本地 `PROCESSING` 的单不会被改成 `PAID`**

```ts
  it('CSV 导入：不配状态列 → 拒绝导入，且本地 PROCESSING 的单不会被改成 PAID', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const csv = [
      '交易号,业务单号,金额(分)',
      `txn-csv-no-status,${payout.payoutNo},8500`,
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-no-status.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          referenceNoColumn: '业务单号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          // ⚠️ **刻意不配 statusColumn** ——
          //    曾经这里默认当成 SUCCESS → 本地 PROCESSING 的单被判成 A 类
          //    → **自动改成已付款**。
        }),
      );

    // ⚠️ **必须拒绝** —— 不配状态列就无从判断渠道是否真的打了款。
    //    「先假设成功再说」= 系统替运营做了一个可能错的假设。
    expect(response.status).toBe(400);
    const errorBody = response.body as { message?: string };
    expect(errorBody.message).toContain('状态');

    // ⚠️ **核心断言：出款单的状态没变** ——
    //    这条单如果被误判成 A 类，就会被自动纠正成 PAID（**改钱状态**）。
    const after = await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: payout.id },
        select: { status: true },
      }),
    );
    expect(after?.status).toBe(PayoutStatus.PROCESSING);

    // ⚠️ **不能产生任何 A 类差异** —— 既然没导入成功，就不该有对账结论。
    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { channelTxnId: 'txn-csv-no-status' },
      }),
    );
    expect(items).toHaveLength(0);
  });
```

**② 配了状态列但状态值映射缺失 → 同样拒绝（否则 A/B/C/F 全检不出来）**

```ts
  it('CSV 导入：配了状态列但状态值映射缺失 → 同样拒绝（否则 A/B/C/F 全检不出来）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const csv = [
      '交易号,业务单号,金额(分),状态',
      `txn-csv-no-mapping,${payout.payoutNo},8500,成功`,
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-no-mapping.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          referenceNoColumn: '业务单号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          // ⚠️ **刻意不配 statusMapping** ——
          //    渠道的状态词（原样）不会被引擎认成 SUCCESS/FAILED
          //    → A/B/C/F 四类差异全部检不出来，而差异数仍是 0。
        }),
      );

    expect(response.status).toBe(400);
    const errorBody = response.body as { message?: string };
    expect(errorBody.message).toContain('状态值映射');

    const after = await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: payout.id },
        select: { status: true },
      }),
    );
    expect(after?.status).toBe(PayoutStatus.PROCESSING);
  });
```

**③ 金额解析不出来的行 → 响应里必须报告跳过了几行与行号**

```ts
  it('CSV 导入：金额解析不出来的行 → 响应里必须报告跳过了几行与行号', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    const csv = [
      '交易号,金额(分),状态',
      'txn-csv-ok-1,1000,成功',
      'txn-csv-bad-amount,金额不对,成功',
      ',2000,成功',
      'txn-csv-ok-2,3000,成功',
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-bad-rows.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS' },
        }),
      );

    expect(response.status).toBe(200);
    const body = response.body as ImportResponseBody;

    // ⚠️ **必须报告跳过的行** —— 对账结论是**基于剩下的行**算的，
    //    运营不知道跳了几行 → 看到「差异数 0」就以为钱没问题。
    expect(body.skippedRowCount).toBe(2);
    expect(body.skippedRows).toBeDefined();
    expect(body.skippedRows).toHaveLength(2);

    // ⚠️ **行号要对得上原账单** —— 第 1 行是表头 → 数据从第 2 行开始。
    //    第 3 行金额解析不出、第 4 行没有交易号。
    const rowNumbers = body
      .skippedRows!.map((r) => r.rowNumber)
      .sort((a, b) => a - b);
    expect(rowNumbers).toEqual([3, 4]);
    // ⚠️ **原因要写清楚** —— 运营要能分清「金额坏了」与「没有交易号」。
    const reasons = body.skippedRows!.map((r) => r.reason).join(' | ');
    expect(reasons).toContain('金额');
    expect(reasons).toContain('交易号');

    // ⚠️ **只跳过了 2 行，明细不用截断**
    expect(body.skippedRowsTruncated).toBe(false);
    expect(merchant.tenantId).toBeTruthy();
  });
```

⚠️ **响应体的类型**要在 spec 顶部声明（否则 TS 报 `body.skippedRows` 不存在）：

```ts
/** 导入端点的响应体 */
interface ImportResponseBody {
  id: string;
  diffCount: number;
  matchedCount: number;
  /** ⚠️ **没解析出任何打款时刻时才有** —— 提示 D 类差异检不出来 */
  warning?: string;
  /** 被跳过的行数（⚠️ **不是 0 就说明账单有行没参与对账**） */
  skippedRowCount?: number;
  /** 被跳过的行明细（行号 + 原因） */
  skippedRows?: { rowNumber: number; reason: string }[];
  /** 被跳过的行明细是否被截断（⚠️ **截断了就不能当成「就这么多行有问题」**） */
  skippedRowsTruncated?: boolean;
}
```

⚠️ **上面三条之外的「不配时间列 → 必须带警告」也要有** —— 提示条件是「**实际解析出了几个时刻**」，不是「配没配列」。配了列但整列是空值，后果与不配列完全一样（D 类检不出来），而差异数仍是 0 → 运营当成「一切正常」。这条用例与「配了时间列 → 能检出 D 类」那条构成对照。

- [ ] **Step 8: 验证**

```bash
cd api && npx tsc --noEmit
```

预期：无输出。

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payout-reconciliation-import.e2e-spec.ts
```

预期：全部用例通过（账单能解析出差异 + 不配时间列要警告 + 配了时间列能检出 D 类 + 不配状态列要拒绝且不改钱状态 + 不配状态值映射要拒绝 + 跳过的行要报告行号）。

- [ ] **Step 9: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add api/package.json api/package-lock.json \
        api/src/modules/payment/payout-reconciliation-csv.ts \
        api/src/modules/payment/dto/payout-reconciliation-import.dto.ts \
        api/src/modules/payment/platform-payout-reconciliation.controller.ts \
        api/src/modules/payment/payout-reconciliation.service.ts \
        api/src/modules/payment/payment.module.ts \
        api/test/payout-reconciliation-import.e2e-spec.ts
git commit -m "feat(payment): 渠道账单 CSV 导入（multipart）

本仓第一个 multipart 接口：引入 papaparse 与 @types/multer，注册
MulterModule，文件上限 5MB、行数上限 10000 行。

上传时做列映射而不是用固定模板 —— 真渠道的 CSV 字段千差万别，要超管先
整理成模板等于把对账的价值打没。金额单位必填（分/元），猜错就是差 100 倍；
状态值映射必填 —— 解析不出状态就没法分类，对账等于没做。

原始文件不落盘，只存解析后的记录、映射配置与文件名。"
```

---

### Task 10: 平台端界面

**Files:**
- Create: `platform-admin/src/lib/reconciliation.ts`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/[id]/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/reconciliation-actions.tsx`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/trigger-reconciliation.tsx`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/import/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/import/import-csv-form.tsx`
- Create: `platform-admin/src/app/api/billing/reconciliations/route.ts`
- Create: `platform-admin/src/app/api/billing/reconciliations/[id]/route.ts`
- Create: `platform-admin/src/app/api/billing/reconciliations/[id]/items/[itemId]/resolve/route.ts`
- Create: `platform-admin/src/app/api/billing/reconciliations/import/route.ts`
- Create: `platform-admin/src/app/api/billing/payouts/[id]/confirm-paid/route.ts`
- Modify: `platform-admin/src/app/(dashboard)/layout.tsx`（导航加一项）
- Modify: `platform-admin/src/app/(dashboard)/payouts/page.tsx`（CRITICAL 横幅）

**依赖：** Task 8、Task 9。

⚠️ **平台端现有页面都是服务端组件**（`async function` + `apiFetchAuthed`），数据直连后端，**不走 Next.js `/api` 路由**。但**触发行**（处置差异、确认已付款）需要客户端组件 → 照 5l 的做法走同源中转路由。

⚠️ **没有 badge / banner / alert 组件** → 沿用裸 `<p role="alert" className="text-sm text-destructive">` 的写法风格（见 `payout-actions.tsx:230`、`settlement-actions.tsx:178`）。

⚠️ **没有 dialog 组件**，原因收集默认用原生 `prompt()`（照
`platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx`）。

- [ ] **Step 1: 写类型与文案**

新建 `platform-admin/src/lib/reconciliation.ts`：

```ts
/**
 * 渠道对账的类型与文案（阶段 5m）。
 *
 * ⚠️ **文案要给运营看** —— 用业务口径，不出现「快照」「密文」这类内部术语。
 */

export type ReconciliationSource = 'API' | 'FILE';
export type ReconciliationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type ReconciliationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type ReconciliationResolution = 'PENDING' | 'RESOLVED' | 'IGNORED';

export type ReconciliationDiffType =
  | 'CHANNEL_PENDING_LOCAL'
  | 'CHANNEL_SUCCESS_LOCAL_FAILED'
  | 'AMOUNT_MISMATCH'
  | 'CHANNEL_ONLY'
  | 'LOCAL_PAID_CHANNEL_ABSENT'
  | 'STATUS_MISMATCH';

export const RECONCILIATION_SOURCE_LABEL: Record<ReconciliationSource, string> =
  {
    API: '渠道接口',
    FILE: '账单文件',
  };

export const RECONCILIATION_STATUS_LABEL: Record<ReconciliationStatus, string> =
  {
    RUNNING: '执行中',
    COMPLETED: '已完成',
    FAILED: '失败',
  };

export const RECONCILIATION_SEVERITY_LABEL: Record<
  ReconciliationSeverity,
  string
> = {
  INFO: '提示',
  WARNING: '警告',
  CRITICAL: '严重',
};

export const RECONCILIATION_RESOLUTION_LABEL: Record<
  ReconciliationResolution,
  string
> = {
  PENDING: '待处置',
  RESOLVED: '已处置',
  IGNORED: '已忽略',
};

/**
 * 差异类型的中文说明。
 *
 * ⚠️ **E 类与 F 类要写清「钱可能有问题」** —— 运营看到「渠道没有这笔」，
 *    要知道这意味着商家以为拿到了钱、实际可能没有。
 */
export const RECONCILIATION_DIFF_LABEL: Record<ReconciliationDiffType, string> =
  {
    CHANNEL_PENDING_LOCAL: '渠道已打款，本地还卡在「打款中」',
    CHANNEL_SUCCESS_LOCAL_FAILED: '渠道已打款，本地记成了失败',
    AMOUNT_MISMATCH: '渠道已打款，但金额与出款单不一致',
    CHANNEL_ONLY: '渠道有一笔打款，我们系统里没有对应的出款单',
    LOCAL_PAID_CHANNEL_ABSENT: '本地记着已付款，渠道查不到这笔',
    STATUS_MISMATCH: '渠道说这笔没打成功，本地却记着已付款',
  };

/** 差异类型的严重级（前端按它排序，严重的置顶） */
export const RECONCILIATION_DIFF_SEVERITY: Record<
  ReconciliationDiffType,
  ReconciliationSeverity
> = {
  LOCAL_PAID_CHANNEL_ABSENT: 'CRITICAL',
  STATUS_MISMATCH: 'CRITICAL',
  AMOUNT_MISMATCH: 'CRITICAL',
  CHANNEL_ONLY: 'CRITICAL',
  CHANNEL_SUCCESS_LOCAL_FAILED: 'WARNING',
  CHANNEL_PENDING_LOCAL: 'INFO',
};

export interface ReconciliationItem {
  id: string;
  reconciliationId: string;
  type: ReconciliationDiffType;
  severity: ReconciliationSeverity;
  payoutId: string | null;
  channelTxnId: string | null;
  channelReferenceNo: string | null;
  channelAmount: number | null;
  channelStatus: string | null;
  channelPaidAt: string | null;
  localAmount: number | null;
  localStatus: string | null;
  resolution: ReconciliationResolution;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
}

export interface Reconciliation {
  id: string;
  channel: string;
  source: ReconciliationSource;
  windowFrom: string;
  windowTo: string;
  fileName: string | null;
  status: ReconciliationStatus;
  triggeredBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  channelCount: number;
  localCount: number;
  matchedCount: number;
  diffCount: number;
  errorMessage: string | null;
  items?: ReconciliationItem[];
}

export interface ReconciliationListResult {
  items: Reconciliation[];
  total: number;
}

export interface ReconciliationSummary {
  pendingCritical: number;
  pendingWarning: number;
  pendingInfo: number;
}
```

- [ ] **Step 2: 写对账任务列表页**

新建 `platform-admin/src/app/(dashboard)/reconciliations/page.tsx`：

```tsx
import Link from 'next/link';
import { apiFetchAuthed } from '@/lib/api-client';
import { formatCents } from '@/lib/payout';
import { formatDateTime } from '@/lib/billing';
import {
  RECONCILIATION_SOURCE_LABEL,
  RECONCILIATION_STATUS_LABEL,
  Reconciliation,
  ReconciliationListResult,
} from '@/lib/reconciliation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 渠道对账任务列表（阶段 5m）。
 *
 * ⚠️ **服务端组件** —— 数据直连后端，不走 Next.js 的 `/api` 路由。
 */
export default async function ReconciliationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  const data = await apiFetchAuthed<ReconciliationListResult>(
    `/platform/payout-reconciliations?page=${page}&pageSize=20`,
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">渠道对账</h1>

      <Card>
        <CardHeader>
          <CardTitle>对账任务</CardTitle>
        </CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有对账任务。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>渠道</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>时间窗</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>本地单</TableHead>
                  <TableHead>渠道流水</TableHead>
                  <TableHead>一致</TableHead>
                  <TableHead>差异</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item: Reconciliation) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.channel}</TableCell>
                    <TableCell>
                      {RECONCILIATION_SOURCE_LABEL[item.source] ?? item.source}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(item.windowFrom)} ~{' '}
                      {formatDateTime(item.windowTo)}
                    </TableCell>
                    <TableCell>
                      {RECONCILIATION_STATUS_LABEL[item.status] ?? item.status}
                    </TableCell>
                    <TableCell>{item.localCount}</TableCell>
                    <TableCell>{item.channelCount}</TableCell>
                    <TableCell>{item.matchedCount}</TableCell>
                    <TableCell>
                      <Link href={`/reconciliations/${item.id}`}>
                        {item.diffCount}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="mt-4 flex gap-4 text-sm">
            {page > 1 ? (
              <Link href={`/reconciliations?page=${page - 1}`}>上一页</Link>
            ) : null}
            <span>
              第 {page} 页 / 共 {data.total} 条
            </span>
            {page * 20 < data.total ? (
              <Link href={`/reconciliations?page=${page + 1}`}>下一页</Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

⚠️ **`formatDateTime`** 在 `platform-admin/src/lib/billing.ts`（既有）→ **不要另写**。
⚠️ **`formatCents`** 在 `platform-admin/src/lib/payout.ts`（既有）→ 本页用不到就别 import。

- [ ] **Step 3: 写差异详情页**

新建 `platform-admin/src/app/(dashboard)/reconciliations/[id]/page.tsx`：

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetchAuthed } from '@/lib/api-client';
import { formatCents } from '@/lib/payout';
import { formatDateTime } from '@/lib/billing';
import {
  RECONCILIATION_DIFF_LABEL,
  RECONCILIATION_DIFF_SEVERITY,
  RECONCILIATION_RESOLUTION_LABEL,
  RECONCILIATION_SEVERITY_LABEL,
  Reconciliation,
} from '@/lib/reconciliation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReconciliationActions } from '../reconciliation-actions';

/**
 * 对账任务的差异详情（阶段 5m）。
 *
 * ⚠️ **差异列表按严重级排序** —— E/F/C/D 置顶（运营先看最危险的）。
 */
export default async function ReconciliationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await apiFetchAuthed<Reconciliation>(
    `/platform/payout-reconciliations/${id}`,
  );

  const items = [...(data.items ?? [])].sort(
    (a, b) =>
      RECONCILIATION_DIFF_SEVERITY[b.type] === 'CRITICAL' ? 1 : 0 -
      (RECONCILIATION_DIFF_SEVERITY[a.type] === 'CRITICAL' ? 1 : 0),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">对账详情</h1>
        <Link href="/reconciliations" className="text-sm underline">
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>渠道：{data.channel}</p>
          <p>
            时间窗：{formatDateTime(data.windowFrom)} ~{' '}
            {formatDateTime(data.windowTo)}
          </p>
          <p>
            本地单 {data.localCount} 张 / 渠道流水 {data.channelCount} 条 / 一致{' '}
            {data.matchedCount} 张 / 差异 {data.diffCount} 条
          </p>
          {data.errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {data.errorMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>差异明细</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有差异。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>严重级</TableHead>
                  <TableHead>差异</TableHead>
                  <TableHead>渠道</TableHead>
                  <TableHead>本地</TableHead>
                  <TableHead>出款单</TableHead>
                  <TableHead>处置</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      {RECONCILIATION_SEVERITY_LABEL[item.severity]}
                    </TableCell>
                    <TableCell>
                      {RECONCILIATION_DIFF_LABEL[item.type] ?? item.type}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.channelStatus ?? '—'} /{' '}
                      {item.channelAmount !== null
                        ? formatCents(item.channelAmount)
                        : '—'}
                      {item.channelPaidAt
                        ? ` / ${formatDateTime(item.channelPaidAt)}`
                        : ''}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.localStatus ?? '—'} /{' '}
                      {item.localAmount !== null
                        ? formatCents(item.localAmount)
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.payoutId ? (
                        <Link href={`/payouts/${item.payoutId}`}>
                          {item.payoutId.slice(0, 8)}
                        </Link>
                      ) : (
                        item.channelReferenceNo ?? '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {RECONCILIATION_RESOLUTION_LABEL[item.resolution]}
                    </TableCell>
                    <TableCell>
                      <ReconciliationActions
                        reconciliationId={data.id}
                        itemId={item.id}
                        payoutId={item.payoutId}
                        diffType={item.type}
                        resolution={item.resolution}
                      />
                    </TableCell>
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

- [ ] **Step 4: 写客户端组件（处置与确认已付款）**

新建 `platform-admin/src/app/(dashboard)/reconciliations/reconciliation-actions.tsx`：

```tsx
'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 对账差异的处置操作（阶段 5m）。
 *
 * ⚠️ **照 `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx` 的写法** ——
 *    `busyRef` 防重复点击、原生 `prompt()` 收集原因、`router.refresh()` 刷新。
 * ⚠️ **没有 dialog 组件**，本仓的原因收集默认用 `prompt()`。
 */

const FAILURE_TEXT = '操作失败';

async function readFailure(
  response: Response,
  fallback: string,
): Promise<string | null> {
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return payload.message ?? fallback;
}

export function ReconciliationActions({
  reconciliationId,
  itemId,
  payoutId,
  diffType,
  resolution,
}: {
  reconciliationId: string;
  itemId: string;
  payoutId: string | null;
  diffType: string;
  resolution: string;
}) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (resolution !== 'PENDING') {
    return null;
  }

  async function resolve(target: 'RESOLVED' | 'IGNORED') {
    if (busyRef.current) return;
    const answer = prompt(
      target === 'RESOLVED'
        ? '请填写处置说明（会记进对账留痕）'
        : '请填写忽略这条差异的原因',
    );
    const trimmed = (answer ?? '').trim();
    if (!trimmed) {
      setFailure('必须填写处置说明');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/billing/reconciliations/${reconciliationId}/items/${itemId}/resolve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resolution: target, note: trimmed }),
        },
      );
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);
      router.refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : FAILURE_TEXT);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmPaid() {
    if (busyRef.current) return;
    const answer = prompt(
      '请填写确认原因（会记进出款操作留痕）。' +
        '确认后系统会复原这笔出款的明细并把状态改成已付款。',
    );
    const trimmed = (answer ?? '').trim();
    if (!trimmed) {
      setFailure('必须填写确认原因');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/billing/payouts/${payoutId}/confirm-paid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: trimmed,
          reconciliationId,
        }),
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);
      // ⚠️ **确认成功后把差异项一并标为已处置**
      await resolve('RESOLVED');
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : FAILURE_TEXT);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {diffType === 'CHANNEL_SUCCESS_LOCAL_FAILED' && payoutId ? (
        <button
          type="button"
          disabled={busy}
          onClick={confirmPaid}
          className="text-sm underline disabled:opacity-50"
        >
          {busy ? '处理中…' : '确认已付款'}
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve('RESOLVED')}
            className="mr-2 text-sm underline disabled:opacity-50"
          >
            {busy ? '处理中…' : '标记已处置'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve('IGNORED')}
            className="text-sm underline disabled:opacity-50"
          >
            忽略
          </button>
        </>
      )}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
```

⚠️ **`readFailure` 与 `payout-actions.tsx` 的同名函数保持一致** —— 成功时读后端的 `message`，失败时返回 `null`（表示「不是错误，是非 2xx 响应」，由调用方抛 `FAILURE_TEXT`）。

- [ ] **Step 5: 写同源中转路由**

新建 `platform-admin/src/app/api/billing/reconciliations/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/** 手动触发对账 */
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
  try {
    const result = await apiFetch('/platform/payout-reconciliations', {
      method: 'POST',
      body: raw,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

新建 `platform-admin/src/app/api/billing/reconciliations/[id]/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  try {
    const result = await apiFetch(`/platform/payout-reconciliations/${id}`, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

新建 `platform-admin/src/app/api/billing/reconciliations/[id]/items/[itemId]/resolve/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
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
  try {
    const result = await apiFetch(
      `/platform/payout-reconciliations/${id}/items/${itemId}/resolve`,
      { method: 'POST', body: raw, token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

新建 `platform-admin/src/app/api/billing/payouts/[id]/confirm-paid/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  const body = raw as { reason?: unknown };
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return NextResponse.json({ message: '必须填写操作原因' }, { status: 400 });
  }
  try {
    const result = await apiFetch(
      `/platform/payout-reconciliations/payouts/${id}/confirm-paid`,
      {
        method: 'POST',
        body: { reason: body.reason.trim() },
        token: session.accessToken,
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

新建 `platform-admin/src/app/api/billing/reconciliations/import/route.ts`（**multipart 的特殊写法**）：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { API_BASE_URL } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 上传渠道账单文件（multipart）。
 *
 * ⚠️ **不能走 `apiFetch`** —— 它硬编码了 `content-type: application/json`
 *    且会 `JSON.stringify(body)`。multipart 必须让浏览器/运行时自己带 boundary，
 *    所以这里写一条**裸 fetch**，**不设 content-type**。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { message: '请求不是合法的 multipart 表单' },
      { status: 400 },
    );
  }
  try {
    const response = await fetch(
      `${API_BASE_URL}/platform/payout-reconciliations/import`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
        // ⚠️ **不设 content-type** —— 让 fetch 自动带 boundary
        body: formData,
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        payload ?? { message: '上传失败' },
        { status: response.status },
      );
    }
    return NextResponse.json(payload);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

⚠️ **`API_BASE_URL` 若没在 `lib/api-client.ts` 里导出，就在那个文件里加一个导出的常量**（值与 `apiFetch` 内部用的那个一致）。⚠️ **不要自己另写一个 base URL**。

- [ ] **Step 6: 导航加一项**

改 `platform-admin/src/app/(dashboard)/layout.tsx`，在 `<Link href="/payouts">出款</Link>` **之后**加：

```tsx
            <Link
              href="/reconciliations"
              className="underline-offset-4 hover:underline"
            >
              渠道对账
            </Link>
```

- [ ] **Step 7: 出款列表页加 CRITICAL 横幅**

改 `platform-admin/src/app/(dashboard)/payouts/page.tsx`。在页面最外层 `<div>` 里、标题**之前**插入：

```tsx
      {summary.pendingCritical > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          有 {summary.pendingCritical} 条严重的渠道对账差异尚未处置（
          {summary.pendingWarning} 条警告、{summary.pendingInfo} 条提示）。{' '}
          <Link href="/reconciliations" className="underline">
            去查看
          </Link>
        </p>
      ) : null}
```

并在页面里取数据（与既有的 `apiFetchAuthed` 调用并列）：

```tsx
  const summary = await apiFetchAuthed<ReconciliationSummary>(
    '/platform/payout-reconciliations/summary',
  );
```

⚠️ **横幅要带跳转链接** —— 现有的 `<p role="alert">` 样例都是纯文本，没有链接的形态可抄 → 用 `<p role="alert">` 包一个 `<Link>`（`Link` 已在 `layout.tsx` 用过），**不要为了一个链接新建组件**。

- [ ] **Step 8: 加「立即对账」入口**

⚠️ **为什么必须有它** —— 定时对账每天只跑一次（UTC 自然日），
运营临时发现「这批单好像有问题」时干等一天是不可接受的。
**后端一直有 `POST /platform/payout-reconciliations` 这个手动触发端点，
但界面上没有入口** → 运营只能干等。
→ 也就是说：Step 5 已经写好的中转路由 `POST /api/billing/reconciliations`
**没有调用方** —— 后端能力在界面上等于不存在。

新建 `platform-admin/src/app/(dashboard)/reconciliations/trigger-reconciliation.tsx`，
在**列表页标题右侧**放一个「立即对账」按钮。

**要做的事与关键约束：**

| 约束 | 说明 |
|---|---|
| **按钮位置** | 列表页（`reconciliations/page.tsx`）标题**右侧** —— 它是「对账任务列表」这个页面的主操作 |
| **参数收集方式** | **本仓没有 dialog 组件** → 原因/参数收集默认用原生 `prompt()`（照 `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx`） |
| **收集哪些参数** | 渠道名、时间窗终点（不含）、时间窗起点（含）—— **默认值要给全**（运营最常见的是「就查昨天」，直接回车就能用） |
| **提交走哪条路** | 已有的中转路由 `POST /api/billing/reconciliations`（Step 5 已写好，**不要另写一条**） |
| **成功后** | `router.refresh()` —— 列表页是服务端组件，不刷新看不到新任务 |
| ⚠️ **必须有「对账中…」反馈** | **对账是同步的**（后端上限 30 秒）→ 按钮要进 `busy` 态并显示「对账中…」，否则运营会以为按钮没生效，连点好几次 |
| ⚠️ **防重复点击** | `busyRef`（读 ref 不读 state，与既有写操作同款 —— state 同一 tick 内还是旧值） |

⚠️ **本仓没有 dialog 组件**这一条在前面的 Task 10 抬头已经写过一次，
这里再强调是因为「立即对账」要收集**三个**参数。

⚠️ **失败要显示后端的 `message`** —— 后端对「时间窗落在未来」「跨度超 31 天」
「渠道不可用」都有具体文案，那些文案对运营有用，不要统一成一句「触发失败」。

- [ ] **Step 9: 加 CSV 账单导入界面**

⚠️ **为什么必须有它** —— **真渠道没有批量查单接口**，
CSV 账单导入是它**唯一**的对账途径。
没有这个界面 = 这个能力对运营**不存在**
（后端 `POST /platform/payout-reconciliations/import` 与中转路由
`POST /api/billing/reconciliations/import` 都写好了，却没有调用方）。

新建 `platform-admin/src/app/(dashboard)/reconciliations/import/page.tsx`
（独立页，路径 `/reconciliations/import`），
表单组件放 `platform-admin/src/app/(dashboard)/reconciliations/import/import-csv-form.tsx`。

**表单字段必须与后端的列映射一一对应**（后端的 `CsvColumnMapping`）：

| 表单字段 | 对应后端字段 | 必填 | 说明 |
|---|---|---|---|
| 账单文件 | `file` | ✅ | CSV，5MB 上限（与后端 `FileInterceptor` 的 `limits` 一致） |
| 渠道名 | `channel` | 选填 | 不填默认 `fake-payout` |
| 时间窗起点 / 终点 | `from` / `to` | 选填 | 不填 = 最近 24 小时；跨度 ≤ 31 天 |
| 交易号列 | `txnIdColumn` | ✅ | 无法匹配 |
| 业务单号列 | `referenceNoColumn` | 选填 | `payoutNo` 匹配用 |
| 金额列 | `amountColumn` | ✅ | |
| **金额单位** | `amountUnit` | ✅ | ⚠️ **不预选** —— 猜错就是金额差 100 倍，宁可让运营明确选一次，也不要替他做这个假设 |
| **状态列** | `statusColumn` | ✅ | ⚠️ **必填** —— 不配就无从判断渠道是否真的打了款 |
| **状态值映射** | `statusMapping` | ✅ | ⚠️ **与状态列同进同出** —— 配了列却不配映射 → A/B/C/F 四类差异全检不出来 |
| 打款时间列 | `paidAtColumn` | 选填 | ⚠️ 不配 → D 类差异检不出来（表单里要写清这个后果） |

**关键约束：**

- ⚠️ **提交走已有的中转路由** `POST /api/billing/reconciliations/import`
  （multipart，Step 5 已写好）。**不要另写一条**，
  更不要直连后端（后端没开 CORS，accessToken 也不该进客户端代码）。
- ⚠️ **不设 `content-type`** —— multipart 必须让浏览器自己带 boundary。
- ⚠️ **前端的校验口径必须与后端 `assertColumnMapping` 一致** ——
  前端少拦一道，运营要白等一次往返才知道自己填错了哪一栏。
- ⚠️ **响应里的 `warning` 与 `skippedRows` 必须显示**：
  - `warning` —— 没解析出打款时刻时的提示（否则运营把「差异数 0」当成「一切正常」）
  - `skippedRowCount` / `skippedRows` —— 被跳过的行数与明细（行号 + 原因）。
    对账结论是**基于剩下的行**算的，藏起来就是给出「钱没问题的假象」。
  - `skippedRowsTruncated` —— 明细被截断的标记（截断了就不能当成「就这么多行有问题」）
- ⚠️ **成功提示要给任务链接** —— 跳到 `/reconciliations/{id}` 看差异明细。

- [ ] **Step 10: 验证**

```bash
cd platform-admin && npx tsc --noEmit
```

预期：无输出。

```bash
cd platform-admin && npm run lint
```

预期：无 error。

```bash
cd platform-admin && npm run build
```

预期：构建成功。

- [ ] **Step 11: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add platform-admin/
git commit -m "feat(platform-admin): 渠道对账页、差异处置与严重差异横幅

对账任务列表 + 差异详情（差异按严重级排序，严重的置顶）。
触发行走同源中转路由，原因收集用原生 prompt —— 本仓没有 dialog 组件。

出款列表页顶部横幅显示未处置的严重差异数并带跳转链接。

补两个入口：「立即对账」（定时对账每天只跑一次，运营临时发现问题不能干等）
与 CSV 账单导入（真渠道没有批量查单接口，账单导入是它唯一的对账途径）。
对账是同步的（后端上限 30 秒），按钮要有「对账中…」的反馈。

CSV 上传的中转路由是本仓第一个 multipart 转发 —— apiFetch 硬编码了
content-type: application/json 且会 JSON.stringify(body)，multipart 必须
不设 content-type 让运行时自己带 boundary，所以写了一条裸 fetch。"
```

---

### Task 11: 验收

**Files:**
- Create: `docs/superpowers/acceptance/2026-10-31-05m-payout-reconciliation-acceptance.md`
- Test: 全量单测 + 全量 e2e + 浏览器手测

**依赖：** 全部。

- [ ] **Step 1: 全量单测**

```bash
cd api && npx jest --passWithNoTests
```

预期：全部通过。

- [ ] **Step 2: 全量 e2e**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand
```

预期：全部通过。

⚠️ **失败注入必须独占** —— 不要与全量测试并发跑。

- [ ] **Step 2.5: 定向 lint**

```bash
cd api && npx eslint \
  src/common/payment/payout-verification.ts \
  src/common/payment/payout-verification.service.ts \
  src/common/payment/payout-verification.service.spec.ts \
  src/common/payment/payout-providers.module.ts \
  src/common/payment/payout.constants.ts \
  src/common/payment/payout-provider.interface.ts \
  src/common/payment/fake-payout.provider.ts \
  src/common/payment/fake-payout.provider.spec.ts \
  src/modules/payment/payout-reconcile.engine.ts \
  src/modules/payment/payout-reconcile.engine.spec.ts \
  src/modules/payment/payout-reconciliation.service.ts \
  src/modules/payment/payout-reconciliation-resolver.service.ts \
  src/modules/payment/platform-payout-reconciliation.controller.ts \
  src/modules/payment/payout-reconcile.scheduler.ts \
  src/modules/payment/dto/payout-reconciliation.dto.ts \
  src/modules/payment/dto/payout-reconciliation-import.dto.ts \
  test/payout-fixture.ts \
  test/payout-reconciliation.e2e-spec.ts \
  test/payout-unstick-gate.e2e-spec.ts \
  test/payout-reconciliation-service.e2e-spec.ts \
  test/payout-reconciliation-import.e2e-spec.ts
```

预期：**无输出**（新建文件必须零错误）。

⚠️ **不要跑全量 `npx eslint "{src,test}/**/*.ts"`** —— 后端当前**已有 9 处既有的 prettier 报错**
（`payout-manual-action.dto.ts` 1 处、`settlement.service.spec.ts` 6 处、
`payout-worker.spec.ts` 1 处、`settlement.e2e-spec.ts` 1 处，**都与本阶段无关**）。
跑全量会让人去「顺手修」无关文件，违反外科手术式改动。

⚠️ **被修改的既有文件只保证「不新增错误」** —— 例如 `payout-worker.spec.ts:266`
那处 prettier 报错是既有的，**不要顺手改它**。

- [ ] **Step 3: 失败注入（逐条验护栏）**

按下面的清单逐条验证，每条都要有「注入前通过 / 注入后失败 / 还原后通过」的记录：

| # | 注入 | 预期 |
|---|---|---|
| 1 | 把 `reconcile()` 的 A 档判定改错（`PROCESSING` → `!== FAILED`） | B 类用例变红 |
| 2 | 把 `pickAuthoritative` 的「优先 SUCCESS」去掉 | 「一单多流水」用例变红 |
| 3 | 把 `unstick` 的核实闸整个注释掉 | 「解卡闸：渠道说 SUCCESS → 拒绝」用例变红 |
| 4 | 把核实服务的「渠道抛错 → 降级」改成「渠道抛错 → FAILED」 | 「问不出结论 → UNKNOWN」用例变红 |
| 5 | 把 `markFailed` 的 `releasedEntryIds` 写入删掉 | B 类 e2e 的闸 ① 用例变红 |
| 6 | 把 `markPaid` 的 `failedAt: null` 删掉 | Task 3 的 e2e 断言变红 |
| 7 | 把 `FakePayoutProvider.queryPayout` 改回恒返回 `SUCCESS` | 「queryPayout：查不到 → UNKNOWN」用例变红 |
| 8 | 把 CSV 的金额单位换算去掉（`YUAN` 也当分） | CSV e2e 的 `channelAmount` 断言变红 |

⚠️ **每条注入都要还原后再跑一次全量** —— 还原不干净的注入会污染后续验收。

- [ ] **Step 4: 浏览器手测**

⚠️ **手测必须用开发模式跑 api** —— compose 的 api 跑在 `NODE_ENV: production`
→ ① 假网关默认不可用；② 即使设了 `assertSecureConfig` 也会拒绝启动。

做法（与 5h-2 的验收记录一致）：

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
# 临时改 infra/docker-compose.yml：api 服务的 environment 加
#   NODE_ENV: development
#   FAKE_PAYOUT_ENABLED: 'true'
docker compose -f infra/docker-compose.yml up -d --build api
```

⚠️ **手测完必须 `git checkout -- infra/docker-compose.yml` 还原** —— 那是 production 环境，护栏 X11 就是为拦它。

手测清单：

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 打开平台端「渠道对账」页 | 任务列表正常渲染 |
| 2 | 点「立即对账」→ 选渠道 + 时间窗 | 同步执行完，列表多一条任务，状态「已完成」 |
| 3 | 点进任务详情 | 差异列表按严重级排序，严重的置顶 |
| 4 | 对一条差异点「标记已处置」 | 提示原因 → 提交 → 刷新后状态变「已处置」 |
| 5 | 对一条 B 类差异点「确认已付款」 | 若四道闸挡住 → 显示业务错误；若通过 → 状态变「已付款」，留痕可见 |
| 6 | 打开「出款」页 | 顶部有严重差异横幅 + 「去查看」链接可点 |
| 7 | 悬停/点击「渠道已打款，本地还卡在打款中」的差异 → 对应出款单 | 出款详情页的操作记录里能看到 `RECONCILE_TO_PAID` 留痕 |
| 8 | 上传一份 CSV 账单 | 列映射表单 → 上传 → 生成一条「账单文件」来源的任务 |

⚠️ **浏览器用本地 `ego lite`** —— 先 `pgrep -f "ego lite"` 检查是否已运行，已运行就复用（**不要 `open`**，会抢前台）；结束前清理标签页。

- [ ] **Step 5: 写验收记录**

新建 `docs/superpowers/acceptance/2026-10-31-05m-payout-reconciliation-acceptance.md`，至少包含：

- 手测 6 步（Task 11 Step 4 的 8 条）的逐步结果
- 失败注入 8 条的「注入前通过 / 注入后失败 / 还原后通过」记录
- 本阶段解决的遗留（设计 §10.2 的 5 条）与仍未处理的（§10.3 的 11 条）

⚠️ **验收记录必须写「实际跑了什么、看到什么」** —— 不要写成「应该可以」。

- [ ] **Step 6: 提交**

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
git add docs/superpowers/acceptance/2026-10-31-05m-payout-reconciliation-acceptance.md
git commit -m "docs: 阶段 5m 验收记录——渠道对账的手测、失败注入与遗留"
```

---

## 附录 A：Task 依赖图与实施波次

```
Task 1（schema + 迁移）──┬─→ Task 3（前置修复）──────────┐
                         │                              │
Task 2（渠道接口 + 假网关）─┼─→ Task 5（契约下沉 + 核实服务）─┼─→ Task 6（A/B 类处置）─┐
                         │        │                     │                      │
                         └─→ Task 4（比对引擎）──────────┘                      ↓
                                   │                                    Task 8（对账服务 + API + 定时）
                                   ↓                                            │
                          Task 7（解卡闸）──────────────────────────────┐        ├─→ Task 9（CSV 导入）
                                                                            ↓        └─→ Task 10（平台端界面）
                                                                     Task 11（验收） ←┘
```

⚠️ **Task 5 必须在 Task 4 / Task 6 / Task 7 之前** ——
Task 5 把 `payout-provider.interface.ts` 搬到 `api/src/common/payment/`
（Task 4 的引擎 import 的是搬完之后的路径），
且 Task 6 / Task 7 都要注入它提供的 `PAYOUT_VERIFICATION`。

**实施波次**（每波内的 Task 文件集互不重叠 → 可并行派实施代理；并发上限 3）：

| 波 | Task | 说明 |
|---|---|---|
| W1 | 1、2、3 | 三者文件集不重叠（schema / 渠道接口 / 前置修复） |
| W2 | 5 | 搬文件 + 改 10 处 import，机械但敏感，单独跑 |
| W3 | 4、7 | Task 4 建引擎（纯函数）；Task 7 加解卡闸 |
| W4 | 6 | A/B 类处置 |
| W5 | 8、10 | 后端对账服务 + 前端界面（前后端文件集不重叠） |
| W6 | 9 | CSV 导入（与 Task 8 改同一批后端文件 → 必须串行） |
| W7 | 11 | 验收 |

⚠️ **Task 8 与 Task 9 必须串行** —— 两者都改 `platform-payout-reconciliation.controller.ts`、
`payout-reconciliation.service.ts` 与 `payment.module.ts`。
⚠️ **Task 10 可以与 Task 8 并行** —— 前端只按计划里已定好的接口契约写，不需要后端先落地。

## 附录 B：常用命令

```bash
# 单测（jest rootDir 是 api/src）
cd api && npx jest <文件名片段>
cd api && npx jest --passWithNoTests          # 全量单测

# e2e（rootDir 是 api/test）
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/<文件名>

# 类型检查
cd api && npx tsc --noEmit
cd platform-admin && npx tsc --noEmit

# 迁移
cd api && npx prisma migrate deploy
cd api && npx prisma generate

# 前端
cd platform-admin && npm run lint
cd platform-admin && npm run build
```

⚠️ **失败注入必须独占** —— 不要与全量测试并发跑。
⚠️ **本机端口**：postgres 15432、redis 16380、minio 19000、api 3000、storefront 3001、merchant-admin 3002、platform-admin 3003。

