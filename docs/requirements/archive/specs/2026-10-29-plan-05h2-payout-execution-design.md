# 阶段 5h-2 设计：真正打款（出款执行 + 补差调账）

> **前置**：阶段 5h-1 已完成并合并（PR #16）——
> [`2026-10-29-plan-05h-payout-ledger-design.md`](./2026-10-29-plan-05h-payout-ledger-design.md)。
> 5h-1 做到 `APPROVED` 为止（**账**），本阶段是**钱**。

**验收结论（5h-1 遗留的输入）**：
[`2026-10-29-plan-05h-payout-ledger-acceptance.md`](../plans/2026-10-29-plan-05h-payout-ledger-acceptance.md) §六。

---

## 一、本阶段要解决的问题

5h-1 结束时，出款单停在 `APPROVED`：金额已锁定、平台已同意付，
**但没有一分钱真的出去**。本阶段补齐三件事：

1. **执行**：`APPROVED → PROCESSING → PAID / FAILED`
2. **调账**：已出款的期再回填进流水，差额怎么补（5h-1 的 L32）
3. **闭环**：出款成功时把引用的结算单一并转 `PAID`

---

## 二、范围

### 2.1 做

| 项 | 内容 |
|----|------|
| **出款渠道抽象** | `PayoutProvider` 接口 + 本地假出款网关（与假支付网关同款形态） |
| **执行状态机** | `APPROVED → PROCESSING → PAID / FAILED`，条件更新互斥 |
| **异步执行** | 审批事务提交后入队，worker 调渠道；不阻塞审批 |
| **失败重试** | 最多 **3 次**自动重试，全失败落 `FAILED` 并**释放流水占用** |
| **结算单联动** | 出款单落 `PAID` 的**同一事务**里，结算单转 `PAID` + 记 `paidAt` |
| **补差出款单（L32）** | 已 `PAID` 的期若有新流水，生成**独立的补差单**，仍走「申请 → 审批」 |
| **两侧界面** | 商家端看到 `PROCESSING` / `PAID` / `FAILED`；平台端有「执行打款」相关的状态与重试入口 |

### 2.2 不做（明确排除）

| 项 | 归属 |
|----|------|
| 真实打款渠道（银行代付 API） | 无资质。`PayoutProvider` 定好形状，将来只是「填密钥」 |
| 部分出款（只打一部分钱） | 本项目出款粒度是整期整单 |
| 商家改收款账户后的追溯 | `PAID` 用的是打款时刻的账户快照，改账户不影响历史 |
| 平台收入报表切流水表（5g L18 / 5h-1 L40） | **仍不做**，但见 §九 的风险说明 |
| 出款对账单导出 | 5h-1 的 L36 |

---

## 三、核心决策（已与用户确认）

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| **D1** | 失败重试 | **自动重试 3 次后落 `FAILED`** | 网络抖动不该让商家反复申请；3 次后是确定性失败，交给人 |
| **D2** | 回填调账（L32） | **单独建一张「补差出款单」** | 复用现有状态机，不动「已打钱金额不可变」这条账务原则 |
| **D3** | 打款触发 | **审批后自动异步打款** | 平台人不必点第二次；异步避免渠道超时拖死审批事务 |
| **D4** | 结算单联动 | **出款 `PAID` 时同事务把结算单也转 `PAID`** | 5g 的「`PAID` 不能取消确认」才真正生效，账目闭环 |

---

## 四、架构

### 4.1 模块依赖（⚠️ 铁律不能破）

```
payment  →  billing  →  （无）
   ↓          ↑
 order ────────┘
```

⚠️ **`billing` 模块绝对不能 import `payment`** —— 会成为
`order → billing → payment → order` 的环，NestJS 启动直接报错
（5h-1 的 `billing.module.ts` 头注释已写明）。

**出款执行要调渠道，但出款单与结算单都在 `billing`。** 解法：

- `PayoutProvider` 接口与假出款网关定义在 **`payment` 模块**
  （与 `PaymentProvider` 并列 —— 渠道适配器天然属于 payment）
- `billing` 不 import `payment`，改为**入队**：`PayoutService` 只往
  `PAYOUT_QUEUE` 投一个 `{ payoutId }` 的 job
- `payment` 模块里的 `PayoutWorker` 消费该队列 → 调 `PayoutProvider` →
  再调 `billing` 的 `PayoutExecutionService` 落状态

⚠️ **队列本身在 `QueueModule`（`@Global()`）里注册** → 两边都能注入，**不构成模块依赖**。
这是本项目已有的模式（`payment` 通过 `QueueService` 投 `COMPENSATION_QUEUE`）。

### 4.2 组件清单

| 文件 | 所属模块 | 职责 |
|------|---------|------|
| `payment/payout-provider.interface.ts` | payment | `PayoutProvider` 接口 |
| `payment/fake-payout.provider.ts` | payment | 假出款网关（可手动触发成功/失败） |
| `payment/fake-payout.controller.ts` | payment | 假网关的「确认打款 / 模拟失败」端点 |
| `payment/payout.worker.ts` | payment | 消费 `PAYOUT_QUEUE`，调渠道 + 落状态 |
| `payment/payout.constants.ts` | payment | 渠道表令牌、可重试次数上限 |
| `billing/payout-execution.service.ts` | billing | **状态落库的唯一入口**（`markPaid` / `markFailed` / `scheduleRetry`） |
| `billing/payout.service.ts`（改） | billing | 审批后入队；补差单的申请逻辑 |
| `billing/payout-supplement.service.ts` | billing | 补差单的**检测与生成** |
| `billing/payout-reconcile.worker.ts` 或复用补偿扫描 | billing | 定期扫「`PROCESSING` 超时未落终态」的单 |
| `common/queue/queue.constants.ts`（改） | common | 加 `PAYOUT_QUEUE` |

---

## 五、数据模型变更

### 5.1 `payouts` 表新增列

```prisma
model Payout {
  // ... 5h-1 既有字段 ...
  /// 出款类型：正常出款 / 补差出款（5h-2）
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
  /// 卡死告警已发出的时刻（兜底扫描写，R3）
  /// ⚠️ **只为「告警去重」而存在**：不写它的话，兜底扫描每 5 分钟
  ///    就会把同一张卡住的单捞出来再打一遍日志 —— 一晚上几千行噪音，
  ///    真正的那一条反而被埋掉。写了它，每张单只告警一次。
  stuckLoggedAt DateTime?
}

enum PayoutKind {
  /// 正常出款（某一期的完整应结）
  NORMAL
  /// 补差出款（该期已 PAID 后又回填进来的流水）
  SUPPLEMENT
}
```

⚠️⚠️ **`PayoutStatus` 枚举要补一个 `PROCESSING`** —— 5h-1 的枚举是
`REQUESTED / APPROVED / REJECTED / CANCELLED / PAID / FAILED`，
**没有「打款中」这个状态**（5h-1 里 `PAID` / `FAILED` 是预留的、不可达的）。
而本阶段整个状态机（`APPROVED → PROCESSING → PAID / FAILED / APPROVED`）都依赖它。

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

⚠️ **枚举加值要用 `ALTER TYPE ... ADD VALUE`，且要单独一个迁移文件** ——
不要改已登记的迁移（`_prisma_migrations` 的 checksum 会失配）。
⚠️ **PG 12+ 允许 `ADD VALUE` 在事务块里跑**（`prisma migrate deploy` 会包事务），
但**新增的枚举值不能在同一个事务里被使用** → 迁移文件里只加值、不用它。

### 5.1b `settlement_statements` 表新增列

⚠️ **本阶段之前这张表没有 `paidAt`** —— 要记「钱什么时候打出去的」必须加：

```prisma
model SettlementStatement {
  // ... 既有字段 ...
  /// 打款完成时刻。null = 未打款（5h-2）
  /// ⚠️ 与 status = PAID 同步写入，两者语义必须一致
  paidAt DateTime?
}
```

⚠️ **`status` 已是 `SettlementStatus`，枚举里 `PAID` 早就有定义**（5g 留的），
本阶段只是**第一次真的会转到它**（5h-1 的迁移注释写着「5h-1 不可达」）。

### 5.1c 收款账户快照（防「审批后商家改账户」）

⚠️ **没有快照会出两个问题**：

1. 商家在 `PROCESSING` 期间改收款账户 → worker 执行时读到的是**新账户**，
   平台审批时看到并同意的是**旧账户** —— 钱打到了平台没审过的账户上。
2. `PAID` 之后追查「当时打给谁」时，账户表已经被改掉，**没有历史可查**。

**决策**：`approve` 的事务里把当前账户抄进 `payouts` 的三个 `snapshot*` 列；
worker **只读快照**，不再查 `merchant_payout_accounts`。

⚠️ **`snapshotAccountNo` 存完整账号**（不是脱敏版）—— 它是打款依据，
worker 要用它调渠道。它只出现在 `payouts` 表与服务端内部，
**API 返回时仍然只给脱敏版**（`maskAccountNo`，5h-1 的既有函数）。
⚠️ 这提高了「数据库泄露」的暴露面（5h-1 的 L38 已记「收款账户明文存」），
本阶段**不解决**（加密是独立任务），但快照让暴露面从「1 个账户表」
变成「账户表 + 每张出款单」，**这一条要写进 L38 的备注**。

⚠️ **`apply` 时也抄一份**（申请时商家看到的账户），`approve` 时**覆盖成本次审批的值**。
两边都写，`approve` 为准；这样「审批人看到的」与「实际执行的」必然一致。

⚠️ **`approve` 时必须重新读账户，并处理「账户已不存在」**：

`apply` 那边有 `if (!account) throw BadRequestException('请先设置收款账户')` 的守卫
（`payout.service.ts:140-145`），但 `approve` 没有。商家在 `REQUESTED` 期间
删掉或换了账户，审批时抄到的快照要么是空、要么是另一个账户：

```
approve 的事务内
  ├ 重新查 merchant_payout_accounts
  ├ 查不到 → 409「该商家已删除收款账户，请让其重新申请」
  └ 查得到 → 三个 snapshot* 列写入（accountName / bankName / 完整账号）
```

⚠️ **worker 侧还有一道**：`snapshotAccountNo` 为空 → 落 `FAILED` +
`failureReason = '收款账户快照缺失'`，**不调渠道**。两道闸都要有——
第一道挡住「新建时就没有」，第二道挡住「历史脏数据」。

⚠️ **快照必须在 `approve` 的同一个事务里写**，不能分成「先 update 状态、再单独写快照」——
那样会出现「状态已是 APPROVED、job 已入队、快照还没写」的窗口，
worker 拿到的可能是 `apply` 时的旧账户（正是快照要防的事）。
⚠️ **`PayoutView` 新增账户字段时必须走 `maskAccountNo`** ——
`snapshotAccountNo` 是完整账号，**绝不能原样进 API 响应**（Y14 验这条）。

### 5.2 ⚠️ 唯一索引必须跟着改（关键）

5h-1 的部分唯一索引：

```sql
CREATE UNIQUE INDEX payouts_tenantId_active_period_uniq
  ON payouts ("tenantId", "periodStart")
  WHERE status NOT IN ('REJECTED','CANCELLED');
```

**它挡住了补差单**：原单已经 `PAID`（不在排除列表里）→ 同一期再建补差单直接撞索引。

⚠️ 这是 5h-1 的 `@@unique` 表达不了 WHERE 子句、只能写在迁移 SQL 里的**同一条索引**，
本阶段要**先 DROP 再重建**：

```sql
DROP INDEX payouts_tenantId_active_period_uniq;

CREATE UNIQUE INDEX payouts_tenantId_period_kind_active_uniq
  ON payouts ("tenantId", "periodStart", kind)
  WHERE status NOT IN ('REJECTED','CANCELLED','FAILED');
```

⚠️ **`FAILED` 必须加进排除列表** —— 这是本阶段最容易漏的一处：

5h-1 的排除列表只有 `REJECTED` / `CANCELLED`（那时 `FAILED` 不可达）。
本阶段 `FAILED` 变成**可达的终态**，而它的语义与 `REJECTED` 一样是
「这张单没有把钱打出去，该期可以再来一次」。
不加进去的话：**一旦出款失败，该商家该期就永远无法再申请** ——
`apply` 撞唯一索引 → P2002 → 500（5h-1 的 E5 那种失败模式，换了个入口）。

⚠️ 同理，`findActivePayout` 与 `availablePeriods` 里那两处
`status: { notIn: [REJECTED, CANCELLED] }` **都要补上 `FAILED`** ——
数据库索引与查询条件必须是**同一个集合**，否则会出现
「查询认为不活跃、插入却被索引拦下」的错位。

⚠️ **索引变成三元组后，这两处查询必须同时带上 `kind`** ——
索引的唯一性粒度已经变成「(租户, 周期, kind)」，查询却不带 `kind`，
就会出现「以为只查正常单、实际把补差单也捞进来了」的错位（详见 §6.4b）。
所以 `findActivePayout` 的签名要改成
`findActivePayout(periodStart, kind)`，**调用方必须显式传 kind**。

**含义**：同一商家同一周期，**每种 `kind` 各只能有一张活跃单**。
→ 一张正常单（可能是 `PAID`）+ 一张补差单（也可能是 `PAID`）可以共存 ✅
→ 一张 `FAILED` 的正常单 + 一张新申请的正常单可以共存 ✅

⚠️ 但**历史数据迁移**要小心：`kind` 默认 `NORMAL`，重建索引时若已有数据违反新约束会失败。
先查一遍：
```sql
SELECT "tenantId", "periodStart", kind, COUNT(*) FROM payouts
WHERE status NOT IN ('REJECTED','CANCELLED')
GROUP BY 1,2,3 HAVING COUNT(*) > 1;
```
在 5h-1 的约束下这必然返回 0 行（旧索引更严），所以迁移是安全的。

### 5.3 索引补充（5h-1 遗留 L32 之外的 N 项）

```sql
-- 5h-1 验收记录 §六 L32：P6 闸按 statementId 查出款单，量大时全表扫
CREATE INDEX payouts_statementId_idx ON payouts ("statementId");
-- 执行侧：worker 按状态捞单
CREATE INDEX payouts_status_createdAt_idx ON payouts (status, "createdAt");
```

---

## 六、数据流

### 6.1 正常出款：审批 → 打款

```
平台审批通过（PayoutService.approve）
  └ 事务：REQUESTED → APPROVED，锁定金额
  └ 事务**提交之后**（不在事务里）→ PAYOUT_QUEUE.add(
      { payoutId },
      { jobId: `payout-${id}-1`, attempts: 1, removeOnComplete: true }
    )
    ⚠️ **`attempts: 1`（BullMQ 自身的重试关掉）**：重试由我们自己的
    `attemptCount` + 退避入队控制（§6.2）。两层重试叠在一起时，
    BullMQ 会在我们「退回 APPROVED 等下次」之后**又立刻重跑一次同一个 job**，
    绕过退避 → 3 次尝试在 1 秒内烧完。

PayoutWorker 消费
  ├ STEP 1：条件更新 APPROVED → PROCESSING（记 processingAt、attemptCount+1）
  │   ⚠️ `affected.count === 0` → **直接 return，什么都不做**
  │   （可能是另一路 worker 抢先了、或已被人工处理）→ **不重试，不落 FAILED**
  ├ STEP 1.5：两道「打之前」的闸（**都在调渠道之前**，不满足就不调）
  │   ├ netAmount <= 0 → 落 FAILED + failureReason='出款金额非正数'（X4）
  │   └ snapshotAccountNo 为空 → 落 FAILED + failureReason='收款账户快照缺失'（§5.1c）
  │   ⚠️ 两道闸的落 `FAILED` **都要在同一事务里释放明细占用**
  │      （`payoutEntry.deleteMany`）—— 否则商家重新申请撞唯一索引 → 500
  ├ STEP 2：调 PayoutProvider.execute({ referenceId, referenceNo, amount, account })
  └ STEP 3：落终态
      ├ 成功 → 事务：PROCESSING → PAID + 结算单 CONFIRMED → PAID（D4）
      └ 失败 → 事务：PROCESSING → APPROVED（attemptCount < 3）
                     或 PROCESSING → FAILED（attemptCount >= 3）+ 释放明细占用

⚠️ **入队必须在事务提交之后**：在事务里 `queue.add` 的话，worker 可能在事务
提交前就消费到 job —— STEP 1 的条件更新查不到那张单（还是 REQUESTED），
`count === 0` → 静默返回 → **这笔出款永远没人打**。
（与 5d 的「队列投递不能前移到事务之前」同源，5h-1 的坑 14 记过。）

⚠️ **`jobId: payout-${id}-1` 撞了就是重复投递、可以接受**：
`approve` 的 `REQUESTED → APPROVED` 条件更新保证「进入 APPROVED」只发生一次，
所以正常情况下不会重复入队。即便队列重投，撞上已存在的 jobId 会被 BullMQ 静默忽略，
**而这正是想要的**（第一次的 job 还在跑或已跑完）。**不要**把它理解成幂等保护 ——
真正的幂等保护是 STEP 1 的条件更新。
```

⚠️ **STEP 1 的「条件更新失败 → 静默返回」很重要**：若 STEP 1 失败也抛错，
BullMQ 会把它记成失败 job（哪怕 `attempts: 1`，也会进 failed 集合并触发告警噪音），
排查时全是「状态对不上」的假故障。**只有渠道调用真的失败才走到重试路径。**

### 6.2 重试：为什么是「退回 APPROVED」而不是「留在 PROCESSING」

```
失败且未超上限 → PROCESSING → APPROVED（attemptCount 保留）
  └ 入队下一次：PAYOUT_QUEUE.add({ payoutId }, { delay: 退避, jobId: `payout-${id}-${attempt}` })
```

⚠️ **退出 PROCESSING 是必须的**：若留在 `PROCESSING`，
平台的「执行中」列表会显示一堆在等重试的单，与「真的在渠道那里」的单混在一起。
退回 `APPROVED` 的语义是「**还没打出去，等下一次**」。

⚠️ **退避**：`attempt × 30 秒`（30s / 60s / 90s）。**不用指数退避**——
出款的失败通常是渠道临时不可用，分钟级重试够了；指数退避会让第 3 次拖到 2 小时后，
商家看到「已审批」两小时没动静会打电话。

⚠️ **jobId 必须带 `attempt`** —— 5f 的教训：BullMQ 里 failed job 的 hash 还在，
用**同一个 jobId** 重新入队会被**静默忽略**（补偿等于没做）。

### 6.3 失败终态：必须释放明细占用

```
PROCESSING → FAILED（attemptCount >= 3）
  ├ failureReason = 最后一次的渠道错误
  ├ failedAt = now
  └ payoutEntry.deleteMany({ payoutId })   ⚠️ 与状态更新同一个事务
```

**为什么必须释放**：`payout_entries.entryId` 是**全局唯一**（5h-1 的 P2）。
不释放的话，商家重新申请同一期会撞索引 → P2002 → **500**。
这是 5h-1 在「拒绝 / 撤回」上踩过的同一个坑（E5），`FAILED` 是**第三条**释放路径。

⚠️ **但 `FAILED` 与 `REJECTED` 的语义不同**：失败的单**可能真的打出去了**
（渠道超时，但钱到了）。所以：

- `FAILED` 的单一律**不自动重新申请**，必须商家**主动**再申请
- 界面文案要说清「出款失败，请联系平台确认是否已到账」
- ⚠️ **这是本阶段已知的最危险边界**，见 §九·R1

### 6.4 补差出款单（L32）

**触发**：商家在「可申请周期」里看到某个已 `PAID` 的期还有**未被任何出款单纳入**的流水。

```
availablePeriods() 的判定（改造，完整版见 §6.4b）
  ├ 该期有流水（occurredAt < now）
  ├ 算总应结（computeAmounts）
  ├ 已纳入的流水 id 集合 = 该期 status ∈ {REQUESTED, APPROVED, PROCESSING, PAID}
  │                       的**所有**单的 payout_entries（⚠️ 不是 entryCount 之和，
  │                       是**实际被占用的 entryId 集合**）
  ├ 若 总流水里有 entryId 不在该集合 → 该期「可申请补差」
  └ 否则按 5h-1 的规则
```

⚠️ **必须按 `entryId` 集合算，不能按 `entryCount` 求和** ——
`REJECTED` / `CANCELLED` / `FAILED` 的单已经 `deleteMany` 释放了明细，
它们的 `entryCount` 列**仍是旧数字**（历史快照，没有清零）。
拿 `entryCount` 求和会把「已释放的流水」算成「已纳入」→ 补差单永远不出现。
以 `payout_entries` 的实际行数为准，那才是「被占用」的唯一事实来源。

**生成**：`apply({ period })` 在这个情况下自动建 `kind = SUPPLEMENT` 的单。

#### ⚠️ `apply` 的判定顺序（改造后的完整伪码）

⚠️ **顺序不能乱** —— 三个问题都出在「先算金额还是先判类型」上：

```
apply({ period })
  ① 该期有活跃**且尚未 `PAID`** 的 NORMAL 单？
     （status NOT IN REJECTED/CANCELLED/FAILED/PAID）
     → 有 → 幂等返回它（5h-1 原样）
     ⚠️ **必须排除 `PAID`**：`PAID` 的正常单**也是「活跃单」**
     （它占着 `(tenantId, periodStart, kind)` 的索引位）——
     若 ① 把它也返回了，后面的 ③ 永远到不了 → **补差路径不可达**，
     商家永远申请不到补差单。这两条曾经自相矛盾（① 的条件恒包含 ③ 的条件）。
  ② 该期有活跃的 SUPPLEMENT 单？
     → 有 → 幂等返回它（⚠️ 文案要说「该期补差已出款」，见 N2）
  ③ 该期有 status = PAID 的 NORMAL 单？
     ├ 否 → 走 NORMAL 路径（5h-1 原样：computeAmounts + P3 + 佣金）
     └ 是 → 走 SUPPLEMENT 路径：
            ├ unclaimed = 该期未被任何单占用的流水
            ├ supplementAmount = Σ unclaimed.amount
            ├ ⚠️ supplementAmount <= 0 → 400「该期没有可补差的货款」
            │    （回填进来的是退款冲回流水 → 要商家退钱，是调账不是出款）
            ├ commissionAmount = 0（这一期不再扣佣，§6.4 的推导）
            └ netAmount = supplementAmount
```

⚠️ **③ 的「有 `PAID` 的 NORMAL 单」不能简化成「有任意 NORMAL 单」**：
`FAILED` 的正常单 → **必须走 NORMAL 路径**（重新申请时重算会把回填流水一起算进去，
这才是商家真正要的「这一期总共该给我多少」）。
若误走 SUPPLEMENT 路径 → 只打回填那部分的钱，**主体那部分永远打不出去**。

⚠️ **② 的幂等返回要区分文案**：返回的是 `SUPPLEMENT` 单时，
商家端要说「该期补差已出款 / 处理中」，而不是笼统的「已申请」。

⚠️ **① 与 ② 的幂等分支必须在最前**（5h-1 的教训）：
商家重复提交是网络重试，报错会让商家以为申请失败。

⚠️ **NORMAL 路径的 5h-1 逻辑一字不改**（`computeAmounts` + P3 + `netAmount > 0` 两道闸）——
本阶段只**新增** SUPPLEMENT 分支，不改 NORMAL 分支。

#### ⚠️ 佣金口径：必须先看清 5h-1 到底怎么扣的

`payout.service.ts:623`：

```ts
const commissionAmount = statement ? statement.netAmount : 0;
```

⚠️ **先纠正一个容易误解的点**：`statement.netAmount` **不是**结算单的「商家应得」，
它是结算单的**佣金净额**。结算单的数据源是 `commission_entries`（**抽佣流水**），
不是货款流水 —— 它的 `grossAmount` 是「抽佣毛额」、`reversalAmount` 是退款冲回、
`netAmount = grossAmount + reversalAmount` 是**平台这一期抽到的佣金**
（`settlement.service.ts:43-54`）。

所以 5h-1 的两个口径是：

```
receiptAmount   = 该期 merchant_receipts 之和   ← 货款（商家应收）
commissionAmount = 该期结算单的 netAmount       ← 佣金（平台抽的）
netAmount       = receiptAmount − commissionAmount ← 应结给商家
```

**佣金是「这一期总共该扣多少」的单个数，与流水条数无关**。
一张正常单把整期佣金一次扣完，不存在「按流水分摊」。

##### 补差单的佣金只有一个答案：**0**

> **补差佣金 = 0。补差应结 = 补差货款净额。**

⚠️ **决定性理由是一条不变量**：

> **同一期所有出款单的 `commissionAmount` 之和 = 该期结算单的 `netAmount`。**

正常单扣 `statement.netAmount`、补差单扣 0 → 和 = `statement.netAmount` ✅ 不变量成立。
若补差单改成扣「回填货款对应的抽佣」（= `C2`），则
「正常单 + 补差单」的佣金之和 = `C1 + C2 > C1 = statement.netAmount` ❌
**出款单的佣金总额比它的结算单多一笔，而那笔佣金没有任何结算单凭证**。

⚠️ **佣金只有结算单一个凭证**：出款单的 `commissionAmount` 必须能从它引用的
`statementId` 推出来。补差单引用的就是那张已 `PAID` 的结算单，
它的 `netAmount` 是**冻结值** —— 补差单再扣一笔 `C2`，等于篡改已出款的账。

⚠️ **绝不能照抄 5h-1 的 `computeAmounts` 再减一次** ——
那会让同一笔佣金被扣两遍（正常单扣一次、补差单再减一次）。
**补差单的金额计算必须是一段独立的、显式的逻辑**，不能复用 `computeAmounts`：

```ts
// 补差单专用：不复用 computeAmounts
const unclaimed = 该期流水.filter(r => !占用的 entryId 集合.has(r.id));
const supplementReceipt = sum(unclaimed.map(r => r.amount));   // 货物净额
const supplementCommission = 0;                                  // 这一期不再扣佣（见下方「代价」）
const supplementNet = supplementReceipt - supplementCommission;
```

##### ⚠️ 代价必须明说：平台在这笔回填货款上**没收佣**

⚠️ **「补差佣金 = 0」不是「佣金已经被扣过了」，而是「这一期不再扣」**。
两者的差别在回填场景里是实实在在的钱：

```
回填 R2 = 5000 分（货款），对应的抽佣 C2 = 500 分（10%）
  ├ 钱：平台在支付时就已经收走了 C2（钱先进平台账）
  ├ 账：结算单已 PAID、金额冻结 → C2 进不了任何结算单 → 账上只有 C1
  └ 出款：补差单打 R2 − 0 = 5000 → 商家拿 5000，平台实收 5000 + 500
```

⚠️ **所以「结算单 ↔ 实际收款」之间差一笔 `C2`（漏结佣金）**：
结算单说这一期佣金是 `C1`，平台实际收到了 `C1 + C2`。
出款单侧是**自洽的**（两单佣金之和 = `C1` = 结算单），差在结算单与真实现金流之间。

⚠️ **这个漏结本阶段修不了**：5g 的 D6（取消确认 → 重算）是漏结的修复手段，
但 `PAID` 的结算单**不能取消确认**（`settlement.service.ts:684` 的理由：
「已出款的单据退回来，改动的钱已经打给商家了」），P6 闸也会拦。
→ 记为 **L54**。

⚠️ **商家端要看得见**：补差单的佣金是 0，商家一定会问
「这 5000 块为什么不抽佣」。界面文案必须说清
「原结算单已结清，补差按零佣金结算」——
⚠️ **不能什么都不说**，否则商家会以为系统算错了、反复来申诉。

⚠️ **将来要收这笔佣**，前提是先做完 5g 的 L18（报表切流水表）——
两套口径统一之后，才谈得上「回填货款的佣怎么收」。本阶段**不做**（YAGNI）。

⚠️ **补差单也要 `payoutEntry.createMany`**（纳入的是 `unclaimed` 那批 `entryId`）——
不写明细的话：① 商家在详情页看不到补差单纳入了哪些流水；
② `unclaimed` 的判定会把这些流水当成「未纳入」→ **补差单可以无限叠**。

⚠️ **若 `supplementReceipt <= 0`（回填进来的是退款冲回流水）→ 不出补差单**，
`apply` 抛 400「该期没有可补差的货款」。要让商家退钱回去是**调账**的事，不是出款。

⚠️ **`statementId` 仍然指向那张结算单**（用于追溯与 P6 闸），但**不再用它算佣金**。

#### ⚠️⚠️ `approve` 必须按 `kind` 分支（否则补差单会二次扣佣金）

**这是本设计最容易漏的一处。** `payout.service.ts:295` 的 `approve` 会**无条件**
调 `computeAmounts` 并把 `commissionAmount` / `netAmount` 写回（`:339-344`）。
补差单若照常走这条路，会在审批那一刻被重算成「整期货款 − 整期佣金」——
**佣金扣了第二遍**，极端情况下 `netAmount` 变负数（例如补差货款 50、整期佣金 100 → −50）。

```
approve 里的重算分支（改造）
  ├ kind === NORMAL  → 原样调 computeAmounts（5h-1 的 P5，不动）
  └ kind === SUPPLEMENT →
      ├ ⚠️⚠️ 重算范围 = 本单已占用的 entryId ∪ (该期未被任何单占用的流水)
      │    ⚠️ **「未被任何单占用」是全局口径，用在这里会把本单自己
      │       纳入的流水算成「未纳入」** → 金额直接归零（详见下方）
      ├ receiptAmount = Σ 该范围.amount（⚠️ 不含其他单已占用的）
      ├ commissionAmount = 0
      ├ netAmount = receiptAmount
      ├ entryCount = 该范围.size
      ├ statementId 保持不变（仍指那张结算单，只作追溯凭证）
      └ ⚠️ 若 netAmount <= 0 → 409「该期补差金额已非正数，不能审批」
```

##### ⚠️⚠️⚠️ 「重算范围」必须是**本单口径**，不能是全局口径

⚠️ **这是本设计第二容易漏的一处，而且漏了会直接把钱打错。**

`apply` 时补差单已经 `payoutEntry.createMany` 把自己纳入的那批流水**占住了**。
若 `approve` 重算时用全局口径「该期未被任何单占用的流水」，
那**本单自己纳入的流水此刻正被本单占用** → 它们不在「未占用」集合里 →
**重算出的金额 ≈ 0** → `netAmount <= 0` → 审批直接 409，
或者更糟：期间又来了一笔新流水 → 重算出「只有那一笔」的金额 → **审批通过、金额错**。

```
正确：approve 的重算范围
  = 本单自己占用的 entryId（查本单的 payout_entries）
  ∪ (该期流水 − 所有单占用的 entryId)     ← 新进来的那些

错误：approve 的重算范围
  = 该期流水 − 所有单占用的 entryId        ← 把本单自己的也排除了 → 归零
```

⚠️ **两个「unclaimed」是两个不同的东西，别混**：

| 位置 | 口径 | 原因 |
|------|------|------|
| `availablePeriods`（§6.4b） | **全局**：该期流水 − 所有单的占用 | 那里没有「本单」概念 |
| `apply` 建补差单（§6.4） | **全局**：同上 | 单还没建，没有自己的占用 |
| **`approve` 重算补差单** | **本单口径**：本单已占 ∪ 全局未占 | 本单已经占住了自己那批 |

⚠️ **e2e 必须断言**：补差单 `apply` 后不新增流水直接 `approve` →
**金额必须与申请时完全一致**（这正是「本单口径」的唯一证据）。
⚠️ 失败注入 **Y19**：`approve` 的补差重算用全局口径 → 该用例必须挂
（`netAmount` 变成 0 → 409，或变成只有新流水的金额）。

⚠️ **`entryCount` 也要重算** —— 它是「这张单纳入了多少条流水」，
补差单的 `entryCount` 是**补差那批**的条数，不是整期的条数。
留着旧值会让商家在详情页看到「31 条」而明细只有 2 条。

##### ⚠️⚠️ `approve` 必须**同步 `payout_entries`**（否则重复打款）

`approve` 重算了金额范围（`amounts.entryIds`），却**不写 `payout_entries`** ——
审批时纳入的那些新流水**不在明细表里**。

后果（**重复打款**）：
1. 审批时纳入的流水 X 被算进金额 → 会被打款
2. ⚠️ 但 `payout_entries` 里没有 X → `computeUnclaimedAmounts` 认为 X 仍「未纳入」
3. → `availablePeriods` 的 `supplementAvailable` 又是 `true`
4. → **商家能再申请一张补差单，把 X 再打一次**

→ **修法**：`approve` 的**同一个事务里**同步明细：
`payoutEntry.deleteMany({ where: { payoutId } })` → 再按 `amounts.entryIds` `createMany`。
⚠️ **`deleteMany` 必须在前** —— `entryId` 是全局唯一索引，不先删就插会撞 → P2002 → 500。
⚠️ **正常单也要同步** —— 审批锁定的范围就是这张单纳入了的流水；
审批**之后**才回填的流水不在锁定范围里，那些才应该走补差单打。

⚠️ **补差单的重算为什么要做**（而不是直接用 `apply` 时的值）：
与 P5 同理——申请与审批之间可能又有流水进来。补差单的重算范围是
「**申请时纳入的那批 ∪ 新进来的那批**」，所以它**可能变大**。
⚠️ 但**已纳入的流水不会被别人抢走**（`entryId` 全局唯一），
所以重算只会因为「新流水进来」而变大，**不会变小**——
⚠️ **不会变小这条很重要**：它保证「审批时锁定的金额 ≥ 申请时的金额」，
商家不会在审批后拿到比申请时更少的钱。

⚠️ **e2e 必须断言**：补差单审批后 `commissionAmount === 0`，
且 `netAmount === receiptAmount`（**这是 B1 的唯一证据**）。
失败注入 `Y9b`：把 `approve` 的补差分支去掉（让它走 `computeAmounts`）→ 该用例必须挂。

#### P3 校验对补差单的处理

正常单与补差单的要求**不同**，不能用同一个函数硬套：

| 路径 | 对结算单的要求 | 理由 |
|------|--------------|------|
| 正常单 `apply` / `approve` | **必须 `CONFIRMED`**（5h-1 原样，不放宽） | 佣金要拿结算单的 `netAmount`，草稿单是没确认的数 |
| 补差单 `apply` / `approve` | **`CONFIRMED` 或 `PAID`** | 补差单不算佣金，结算单只作追溯凭证 |

⚠️ **实现方式**：给 `assertStatementConfirmed` 加一个第三参数
`{ allowPaid?: boolean }`，**只有补差路径传 `true`**。
⚠️ **不要改成「PAID 一律放行」** —— 那会让正常单也能对已 `PAID` 的结算单
重新算佣金，5h-1 的 P5（审批重算）与 P6（`PAID` 不可取消确认）会一起失效。
e2e 必须同时断言：**正常单对 `PAID` 结算单仍 409，补差单对 `PAID` 结算单通过**。

#### ⚠️ P6 闸也要加 `FAILED`

`settlement.service.ts:725-731` 的 P6 查询：

```ts
where: { statementId, status: { notIn: [REJECTED, CANCELLED] } }
```

本阶段 `FAILED` 变成可达终态，而**失败的单仍然挂着 `statementId`**
（§6.3 只释放 `payout_entries`，不清 `statementId`）。
不把它加进排除列表的话：**一次出款失败会让该结算单永远无法取消确认** ——
与 5h-1 想避免的「漏结修不了」是同一个问题。

⚠️ **四处 `notIn` 列表必须永远是同一个集合**（`REJECTED` / `CANCELLED` / `FAILED`）：
① 部分唯一索引的 `WHERE`；② `findActivePayout`；③ `settlement.service.ts` 的 P6 闸；
④ `availablePeriods` 的 `alreadyApplied`。
漏一处就会出现「一处认为不活跃、另一处认为活跃」的错位。

⚠️ **其中 ② 与 ④ 还必须带 `kind`**（索引已经是三元组）——
`findActivePayout(periodStart, kind)`、`availablePeriods` 里按 kind 分别查，
详见 §6.4b。

⚠️ **补差单不转结算单状态**（X6）：结算单在正常单 `PAID` 时已经转过了。
⚠️ **补差单的 `periodStart` 与原单相同** —— 靠 `kind` 区分（见 §5.2 的索引）。
⚠️ **补差单不允许再叠补差**：若该期已有一张活跃 `SUPPLEMENT`，`apply` 幂等返回它。
⚠️ **`requestedBy` 是必然存在的人**：补差单由**商家自己**在申请页发起
（与正常单同一个入口），`requestedBy` 就是当前登录的 `MERCHANT_OWNER`。
**没有「平台定时自动生成补差单」这条路径** —— 那会需要一个系统用户 id，
本阶段不做。

### 6.4b ⚠️ `availablePeriods` 必须 kind 化（否则补差永远发现不了）

5h-1 的 `availablePeriods`（`payout.service.ts:501-555`）返回**每期一项**，
用 `alreadyApplied: boolean` 表达「这期申请过了吗」。

⚠️ **一个布尔值表达不了 5h-2 的形状**：同一期可能**同时**有
「一张已 `PAID` 的正常单」+「还能再申请一张补差单」。
`alreadyApplied = true` 会让商家以为「这期已经结清了，什么都申请不了」——
**补差入口就此消失**。

⚠️ 而且 `alreadyApplied` 的查询（`:537-543`）**没带 `kind`**：
索引已经是 `(tenantId, periodStart, kind)` 三元组，查询却不带 `kind`，
一张 `SUPPLEMENT` 单也会把 `alreadyApplied` 置成 `true`。

**改造后的 `AvailablePeriodView`**：

```ts
export interface AvailablePeriodView {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  statementStatus: SettlementStatus | null;
  /** 该期是否已有活跃出款单（正常或补差都算） */
  alreadyApplied: boolean;
  /** 该期活跃单的种类；null = 没有活跃单。⚠️ 商家端靠它区分「点哪个按钮」 */
  appliedKind: PayoutKind | null;
  /** 该期还能不能申请补差（正常单已 PAID 且仍有未纳入流水） */
  supplementAvailable: boolean;
  /** 补差金额（整数分）；supplementAvailable = false 时为 null */
  supplementAmount: number | null;
}
```

⚠️ **`receiptAmount` / `commissionAmount` / `netAmount` / `entryCount` 的语义不变**，
仍然是「这一期总共应结多少」（`computeAmounts` 的结果）——
**不要**改成补差金额，否则商家会以为「这一期只能拿这么多」。
补差金额走**新字段** `supplementAmount`，两个数各说各的。

⚠️ **`alreadyApplied` 的口径**：有活跃单（`REQUESTED` / `APPROVED` /
`PROCESSING` / `PAID`，正常或补差都算）就是 `true`。
⚠️ **`PAID` 算「活跃」** —— 它占着索引位，同期开不出第二张同类单。

**改造后的判定顺序**：

```
for each period:
  ├ ① 无条件跑一次 computeAmounts（5h-1 原样）→ 整期金额字段
  │     ⚠️ 整期金额**与是否有活跃单无关**（§6.4b 的字段定义）
  ├ normalActive   = 该期 NORMAL 的活跃单
  ├ supplementActive = 该期 SUPPLEMENT 的活跃单
  ├ 若 supplementActive 存在
  │    → 展示该期，alreadyApplied = true，appliedKind = SUPPLEMENT
  │      supplementAvailable = false（它自己就是补差单）
  │      ⚠️ 补差单不允许再叠（X8）→ 即使还有新流水也不给入口
  ├ 否则若 normalActive 存在
  │    → 展示该期，alreadyApplied = true，appliedKind = NORMAL
  │    ├ 若 normalActive.status === PAID
  │    │    → 算 unclaimed（未被任何单占用的流水）
  │    │    → supplementAvailable = Σ unclaimed.amount > 0
  │    │      supplementAmount = Σ unclaimed.amount
  │    │      ⚠️ unclaimed 的口径是「**所有**单占用的」，
  │    │        不是「只算正常单」—— 补差单占的也算已纳入
  │    └ 否则（REQUESTED/APPROVED/PROCESSING）
  │         → supplementAvailable = false
  │           ⚠️ 正常单还在飞，不给补差入口（避免两张单同时在飞）
  └ 否则（没有活跃单）
       → 5h-1 原样：entryCount === 0 或 netAmount <= 0 → 跳过这一期
       → 否则展示该期，alreadyApplied = false，appliedKind = null
         supplementAvailable = false
       ⚠️ 这一支包含「正常单是 REJECTED / CANCELLED / FAILED」的情况
         → 商家点申请走 NORMAL 路径（重算把回填流水算进去），与 §6.4 一致
```

⚠️ **「没有活跃单」时不能跳过补差检测**：正常单若是 `FAILED`，
它不算活跃单 → 这一期会走「重新申请正常单」的路径（重算把回填流水算进去），
**而不是**补差路径 —— 与 §6.4 的 `apply` 判定一致。

⚠️ **`REJECTED` / `CANCELLED` / `FAILED` 的单不算活跃** →
它们的 `payout_entries` 已释放 → 那些流水回到「未纳入」集合 ✅

⚠️ **「未纳入」的集合按 `payout_entries` 的实际行算，不按 `entryCount` 求和** ——
理由见 §6.4 开头（被拒/撤回/失败的单 `entryCount` 是旧快照，没清零）。

⚠️ **性能**：`availablePeriods` 现在每期要查 2 次单 + 1 次明细集合。
5h-1 的写法是每期 `findFirst`（N+1）。本阶段期数不多（商家一年 12 期），
**沿用同样的逐期查法**即可，不做批量优化（YAGNI）。记为 L51。

### 6.5 结算单联动（D4）

```
出款单 PROCESSING → PAID 的同一个事务里：
  ├ payout.updateMany({ where: { id, status: PROCESSING }, data: { status: PAID, paidAt } })
  └ if (payout.statementId)
      settlementStatement.updateMany({
        where: { id: statementId, status: CONFIRMED },
        data: { status: PAID, paidAt },
      })
```

⚠️ **结算单更新用条件 `status: CONFIRMED`**（不用 `PAID`）：
已 `PAID` 的结算单被另一张单再触发时 `count === 0`，**不报错**（幂等）。
⚠️ **补差单不改结算单状态**（结算单在正常单 `PAID` 时就已转 `PAID`）。
⚠️ **结算单的 `paidAt` 与 `status` 同一次 `data` 里写** —— 分开写会出现
「status=PAID 但 paidAt=null」的矛盾行。

---

## 七、护栏

| # | 护栏 | 落地方式 |
|---|------|---------|
| **X1** | 同一张出款单只能被执行一次 | `PROCESSING` 的条件更新：`updateMany({ where: { id, status: APPROVED } })`，`count === 0` → 静默返回 |
| **X2** | 执行前金额必须是审批锁定的值 | worker 用 `payout.netAmount`（落库值），**不重算** —— 5h-1 的 P5 已在审批时锁定 |
| **X2b** | 打款账户必须是审批时看到的那个 | worker 只读 `payout.snapshot*`，**不查** `merchant_payout_accounts`（§5.1c） |
| **X3** | 渠道金额核对 | `PayoutProvider.execute` 返回的金额必须等于请求金额，不等 → 落 `FAILED` 且记 `failureReason` |
| **X4** | 打款金额必须 > 0 | worker 进 `PROCESSING` 前检查 `netAmount > 0`，否则**落 `FAILED` + `failureReason = '出款金额非正数'` + 释放明细占用**（⚠️ 不能「静默返回」—— 见下） |
| **X5** | `PAID` 后不可变 | 任何对 `PAID` 单的 `updateMany` 都带 `status` 条件 |
| **X6** | 结算单只跟着**正常单**转 `PAID` | 补差单不碰结算单状态 |
| **X7** | 失败重试有上限 | `attemptCount >= 3` → `FAILED`，不再入队 |
| **X8** | 补差单不重复 | `(tenantId, periodStart, kind)` 部分唯一索引 + 申请幂等 |
| **X9** | 补差单**不再扣佣金** | `supplementCommission = 0`（§6.4）；`supplementNet > 0` 才出单，否则 400 |
| **X10** | 角色边界 | 执行是**系统行为**（worker），不开放 HTTP；假网关端点受 `FAKE_PAYOUT_ENABLED` 控制（**独立于** `FAKE_PAYMENT_ENABLED`） |
| **X11** | 假出款网关生产环境拒绝启动 | `assert-secure-config.ts` 加**独立**一条（同 `FAKE_PAYMENT_ENABLED` 的写法） |
| **X12** | 渠道调用失败不能静默吞掉 | 落 `APPROVED`（或 `FAILED`）+ 记 `failureReason` + 主动入队下一次。⚠️ **不靠抛错让 BullMQ 重试**（`attempts: 1`），但**必须落状态与原因** —— 只打一行日志等于没有 |
| **X13** | 补差单不复用 `computeAmounts` | 佣金口径必须独立实现 —— 复用会让同一笔佣金扣两遍（§6.4） |
| **X14** | 完整收款账号不得出现在 API 响应里 | `PayoutView` 的账户字段一律走 `maskAccountNo`（§5.1c）；`snapshotAccountNo` 只存在于数据库与服务端内部 |
| **X15** | 卡死告警只发一次 | 兜底扫描只捞 `stuckLoggedAt IS NULL` 的单，记完写上时刻（R3 / N1） |
| **X16** | 补差单审批重算的范围必须是**本单口径** | 「本单已占用 ∪ 全局未占用」—— 用全局口径会让本单纳入的流水被当成未纳入，金额归零（§6.4） |

⚠️ **X4 为什么不能「静默返回」**：静默返回的话，这张单会永远停在 `APPROVED`——
商家看到「已审批」，平台看到「已审批」，**没有任何一方知道它没打出去**，
流水还被占着（商家重新申请撞 `payout_entries` 唯一索引 → 500）。
落 `FAILED` 才能让平台端列表标红、让商家看到「打款失败」、
让该期流水被释放（`FAILED` 的第三条释放路径，§6.3）。

---

## 八、错误码与界面

### 8.1 错误码

| 码 | 场景 |
|----|------|
| 400 | 补差单申请但该期没有未纳入的流水（或未纳入的净额 ≤ 0） |
| 404 | 出款单不存在 |
| 409 | 结算单未确认（补差单的 P3）；状态不允许执行；**审批时补差金额已非正数** |

⚠️ **执行失败不走 HTTP**：它是 worker 内部的状态流转，错误记在 `failureReason` 与日志里。

### 8.2 前端变更

| 侧 | 变更 |
|----|------|
| 商家端 | `PAYOUT_STATUS_LABEL` 加 `PROCESSING`（「打款中」）/ `PAID`（「已打款」）/ `FAILED`（「打款失败」）；`FAILED` 给「联系平台确认是否已到账」的提示 |
| 商家端 | 出款单列表加 `kind` 标记：正常 / **补差** |
| 商家端 | ⚠️ **补差单的详情页要写明「零佣金」的原因** —— 「原结算单已结清，本期补差按零佣金结算」（§6.4）。商家一定会问「这 5000 为什么不抽佣」，不说清楚就会反复申诉 |
| 商家端申请页 | 可申请周期里：`appliedKind === 'SUPPLEMENT'` → 显示「该期补差已出款 / 处理中」；`supplementAvailable` → 额外显示「可申请补差，补差金额 X 元」的按钮 |
| 商家端申请页 | ⚠️ **`supplementAmount` 与整期金额要分开显示** —— 整期 `netAmount` 是「这一期总共应结多少」，补差金额是「还能再拿多少」，混在一起商家会以为重复了 |
| 商家端申请页 | ⚠️ **按钮优先级**：`supplementAvailable` → 显示「申请补差」（**可点**）；否则 `alreadyApplied` → 禁用并显示「已申请」；否则 → 「申请出款」<br>⚠️ **不能只看 `alreadyApplied` 就禁用** —— 正常单 `PAID` 后 `alreadyApplied = true`，若直接禁用，**补差入口就此消失** |
| 平台端 | 列表加 `kind` 列（正常 / 补差）；`FAILED` 单显示 `failureReason` 与 `attemptCount` |
| 平台端 | ⚠️ **卡住的单标红**：`PROCESSING` 且距 `processingAt` 超过 10 分钟 → 标红（与兜底扫描的 `stuckLoggedAt` 互补，§九·R3） |
| 平台端 | ⚠️ **不提供「手动重试」按钮**（本阶段不做，记为遗留）—— 重试是自动的 |

---

## 九、风险与已知边界

### R1（最危险）：`FAILED` 可能已经真的打出去了

渠道超时 / 网络中断时，**钱可能已经到了商家账上**，而系统落的是 `FAILED`。
之后商家重新申请，会**重复打一笔**。

**本设计的选择**：`FAILED` 的文案明确要求人工核对（「请联系平台确认是否已到账」），
且平台端显示 `failureReason`。**不自动重新申请**。
⚠️ 商家**主动**再申请同一期是被**允许**的（`FAILED` 不在唯一索引的拦截列表里），
因为「不让商家出款」比「可能重复」更糟——重复可以靠对账追回，卡死追不回。

⚠️ **彻底的解法是渠道对账**（拉渠道的流水比对），本阶段不做 —— 记为 L43。
真渠道接入时**必须**先做对账再做任何自动重试。**本阶段的自动重试（3 次）在真渠道下要重新评估** ——
假网关是同步确定性返回，重试是安全的；真渠道超时语义不同。

⚠️ **这与 R3 是同一个原则的两面**：`FAILED`（渠道明确回了失败）可以重来；
`PROCESSING` 卡死（渠道没回话）**不能**自动重来。前者知道没打，后者不知道。

### R2：报表口径仍不一致（5h-1 的 L40）

平台收入报表走 `orders`，出款走 `merchant_receipts`。
现在钱真的出去了，两套口径不一致的**代价变成真金白银**。
**建议在 5h-2 之后立刻做 5g 的 L18**（报表切流水表）。

⚠️ **补差单把这条风险放大了**：补差单按零佣金结算（§6.4），
于是「报表里的佣金」> 「结算单里的佣金」> 0 —— 差额就是 L54 的漏结佣金。
⚠️ **报表看起来平台多赚了，出款单看起来平台少收了** —— 两个方向的错，
对账时最难查。本阶段**不解决**，但 L18 的紧迫性又上了一档。

### R3：`PROCESSING` 卡死

worker 崩溃 / 队列丢失 → 单子永远停在 `PROCESSING`，流水被占用。

**兜底**：复用 5f 的补偿扫描形态，但**绝不自动重试** —— 只把它们**标出来给人看**。

```
扫描（每 5 分钟一轮，单轮上限 100 条）
  ├ 捞 PROCESSING 且 processingAt < now - 10min 且 stuckLoggedAt IS NULL
  ├ 只记日志 + 计数（不做任何状态变更、不入队）
  └ ⚠️ 记完写 stuckLoggedAt = now（X15）—— 不写的话每 5 分钟重复告警一次
```

⚠️ **`stuckLoggedAt` 是「告警去重」，不是「已处理」**：
写了它不代表有人处理了这张单，只代表「已经告警过了」。
⚠️ **「它还在卡」这件事由平台端列表实时标红**（前端按
`processingAt` 距今 > 10 分钟判定）—— **两条路径互补**：
日志负责「第一次发生时惊动人」，列表负责「现在还卡着」。
若只靠日志，卡住的单会在告警一次后彻底消失（没人再看）；
若只靠列表，没人主动去刷列表，就永远没人知道。

⚠️ **为什么不能像 5f 那样退回重试**：

卡在 `PROCESSING` 的单，最可能的成因是「**请求发出去了、回包丢了**」——
钱**可能已经打到商家账上**。此时退回 `APPROVED` 再入队 = **确定性地重复打款**。
再叠加「`attemptCount` 不重置」，最坏会把同一笔打三次，然后落 `FAILED`，
而 `FAILED` 的语义又是「可能已到账」—— **三重打款**。

这与 R1 自相矛盾：R1 说「重试前必须人工核对」，R3 却又在自动重试。

**本阶段的选择**：卡住的单**就让它卡着**，靠日志与平台端列表暴露（`PROCESSING`
超过 10 分钟的行在平台端标红），由人工判断后决定。代价是该期流水被占用、
商家暂时无法出款 —— 但这比重复打款安全。

⚠️ **真渠道接入时**这本来就是唯一可行的做法：先拉渠道流水对账，
确认没打出去，再决定是否重投。**对账是自动重试的前置**（L43）。

⚠️ **本阶段假出款网关是同步返回的**（和假支付网关同款），
所以「回包丢失」在实际测试里不会发生 —— 这段兜底是**为真渠道预留的口子**，
不会被 e2e 覆盖（记为 L48，如实说明覆盖不到）。

### R3b：`APPROVED` 卡死 —— **这一类必须自动重投**

⚠️ **与 R3 是两类完全相反的卡住**，处理方式不能混：

| 状态 | 钱打出去了吗 | 处理 |
|------|------------|------|
| `PROCESSING` | **可能打出去了**（回包丢了） | **只告警，绝不重投**（R3） |
| `APPROVED` | **确定没打**（还没进 `PROCESSING`） | **自动重新入队**（本节） |

⚠️ **为什么 `APPROVED` 也需要兜底**：审批通过后要把出款单投到队列，
那次入队可能失败（Redis 抖动）。没有兜底的话，那张单会**永远停在 `APPROVED`** ——
商家看到「已审批」、平台看到「已审批」，**没有任何一方知道它没打出去**，
货款流水还被占着（商家重新申请撞 `payout_entries` 唯一索引 → 500）。

→ **救援条件**：`status = APPROVED` **且** `approvedAt < now - 10min`
**且** `attemptCount = 0`（`attemptCount` 在抢单时 `increment: 1`，
**从未被抢过的单是 0**）。

⚠️⚠️ **`attemptCount = 0` 这一条不能省** —— 少了它会与重试 job 抢跑：
`scheduleRetry` 退回 `APPROVED` 时**只清 `processingAt`、不刷新 `approvedAt`**
（刷新 `approvedAt` 是错的 —— 那是「审批时间」，刷新它会让平台端显示假时间）。
于是**两小时前**审批的单在重试退避期内（状态 `APPROVED`、`approvedAt` 很旧）
会被扫描命中 → **额外入队一个救援 job**。
⚠️ 救援 jobId（`payout-{id}-rescue-{N}`）与重试 jobId（`payout-{id}-{N}`）
**不同命名空间，BullMQ 不去重** → 两个 job 抢同一张单 →
**本该按退避打完的 3 次预算，几秒内被烧完**，渠道还没恢复就落了 `FAILED`。

| 场景 | `attemptCount` | 会被救援吗 | 对不对 |
|------|---------------|-----------|-------|
| 审批后入队失败 | 0 | ✅ 会 | 对 —— 确定没打出去 |
| 正在退避等待重试 | ≥ 1 | ❌ 不会 | 对 —— 它有自己的重试 job |
| job 被 BullMQ 丢了 | 0 | ✅ 会 | 对 —— 确定没打出去 |

⚠️ **救援的 jobId 要稳定**（`payout-{id}-rescue-{attemptCount}`，**不要用时间戳**）——
时间戳每次扫描都不同 → 队列里会堆满同一个单的重复 job。

### R4：`attemptCount` 的重置

`APPROVED → PROCESSING` 时 `attemptCount + 1`。退回 `APPROVED` 时**不重置**
（否则不会收敛到 `FAILED`）。
人工若想重置（例如确认渠道已恢复），本阶段**没有入口** —— 记为 L42。

⚠️ **退回 `APPROVED` 时必须同时把 `processingAt` 清空** ——
不清的话，下一次兜底扫描会把这些「正在等重试」的单当成「卡住的单」
重复捞出来（虽然本阶段的扫描只记日志不改状态，但日志会失真、平台端会误标红）。

---

## 十、测试策略

### 10.1 分层

| 层 | 覆盖 | 手法 |
|----|------|------|
| service 单测 | 状态机、X1/X5/X7、补差金额计算（X9/X13/X16）、P3 的 `allowPaid` 分流 | 手写假 Prisma |
| e2e | X1–X16 逐条 + 假网关全链路 | `api/test/payout-execution.e2e-spec.ts` |
| 前端单测 | 三个新状态的文案、补差标记、失败提示 | Vitest |
| 浏览器手测 | 审批 → 打款中 → 已打款；模拟失败 → 重试 → FAILED | `ego-browser` |

⚠️ **补差单的 e2e 必须自己造出「结算单已 `PAID` 且该期还有未纳入流水」这个形状** ——
正常流程走不出这个状态（正常单 `PAID` 时该期流水已被全部占用）。
造法：先正常出款到 `PAID`，再**直接插库**一笔该期的新 `merchant_receipts` 行。
⚠️ 这条与 5g 的教训同源：**测试数据没落在那个形状上，护栏就会「挂 0 条」**。

### 10.2 失败注入

| # | 注入 | 期望挂掉 |
|---|------|---------|
| Y1 | 去掉 `PROCESSING` 的条件 `status` | X1 |
| Y2 | worker 重算金额而非用落库值 | X2 |
| Y3 | 去掉渠道金额核对 | X3 |
| Y4 | 去掉 `netAmount > 0` 检查 | X4（金额为 0 的单会真的去调渠道） |
| Y5 | `PAID` 后仍可改 | X5 |
| Y6 | 补差单也改结算单状态 | X6 |
| Y7 | 去掉重试上限 | X7 |
| Y8 | 部分唯一索引去掉 `kind` | X8 |
| Y9 | 补差单**申请时**改成「复用 `computeAmounts` 再减一次佣金」 | X13（金额被扣两遍） |
| **Y9b** | 补差单**审批时**去掉 `kind` 分支（`approve` 走 `computeAmounts`） | X13（**审批那一刻**佣金被扣第二遍，`netAmount` 甚至变负） |
| Y10 | 假出款端点在 `NODE_ENV=production` 仍可访问 | X11 |
| Y11 | 渠道失败后既不落状态也不记 `failureReason`（只打日志） | X12 |
| Y12 | `FAILED` 不释放明细占用 | P2/补差单会撞索引 → 500 |
| Y13 | 正常单的 P3 也放宽成「PAID 放行」 | 5h-1 的 P3 用例（正常单对 PAID 仍须 409） |
| Y14 | worker 执行时重新查账户表（不用快照） | X2b |
| **Y15** | `PayoutView` 直接返回 `snapshotAccountNo` 原文（不走 `maskAccountNo`） | X14（API 响应里出现完整账号） |
| **Y16** | `availablePeriods` 的 `alreadyApplied` 不带 `kind` 过滤 | §6.4b（补差单被当成正常单 → 补差入口消失） |
| **Y17** | 卡死扫描不写 `stuckLoggedAt` | X15（第二轮扫描重复捞同一张单） |
| **Y18** | `apply` 的判定里把「有 `PAID` 的正常单」写成「有任意正常单」 | §6.4（`FAILED` 的正常单被误判成补差路径 → 主体那部分永远打不出去） |
| **Y19** | `approve` 重算补差金额时用**全局**「未纳入」口径（把本单自己纳入的也算成未纳入） | §6.4（补差单金额**归零**或只剩新流水 → 审批通过但金额错） |
| **Y20** | `approve` 不再同步 `payout_entries`（删掉 `deleteMany` + `createMany`） | 补差流程：同一笔流水能被**再打一次**（**重复打款**） | 资金漏洞 |
| **Y21** | 救援判据去掉 `attemptCount = 0` | 「X7：渠道连续失败 → 重试 3 次后落 FAILED」（救援 job 与重试 job 抢跑 → 预算几秒内烧完） | 资金漏洞 |
| **Y22** | 重试的 jobId 用「这一轮」的 `attemptCount`（而不是下一轮） | 「X7」/「X12」（jobId 与首次入队撞了 → BullMQ **静默忽略** → **重试从未发生**） | 功能失效 |

⚠️ **Y12 是 5h-1 的 E5 在第三条路径上的复现** —— 必须单独验。

⚠️ **Y9 与 Y9b 必须分开验** —— 同一个错误在两个不同的地方：
申请时算错（商家看到的金额就错）vs 审批时算错（**平台批的是对的，
落库的是错的**）。只验其中一个会漏掉另一个。

⚠️ **Y18 是「`FAILED` 的正常单」这个形状** —— 必须先造出
「正常单 `FAILED` + 该期有回填流水」，再 `apply`，
断言拿到的是 **NORMAL** 单（金额 = 整期重算，含回填流水），
而不是 SUPPLEMENT 单（金额 = 只有回填那部分）。

⚠️ **Y19 是「金额归零」而不是「金额算错」** —— 它比 Y9b 更隐蔽：
Y9b 错在**佣金**（金额还是正的，只是多扣了佣），
Y19 错在**金额本身**（直接归零）→ 若不专门造这个形状，
e2e 里的补差审批用例会先挂在 409 上，根本走不到断言。

⚠️ **Y17 的断言方式**：连续跑两轮兜底扫描，断言第二轮捞到的条数为 0
（且第一轮那批单的 `stuckLoggedAt` 非空）。

---

## 十一、遗留项

| # | 内容 |
|---|------|
| L41 | **`FAILED` 单的人工重试入口** —— 本阶段重试全自动，人工只能让商家重申请 |
| L42 | **`attemptCount` 的人工重置** —— 渠道恢复后没有入口把计数清零 |
| L43 | **渠道对账**（拉渠道流水比对）—— R1 的彻底解法，真渠道接入时必须先做 |
| L44 | **平台收入报表切流水表**（5g L18 / 5h-1 L40）—— 钱真的动了之后更紧迫 |
| L45 | 补差单的界面不够细（只是列表里一个标记，没有专门的「补差记录」视图） |
| L46 | 出款失败没有告警（5f L23 的告警基建仍未做） |
| L47 | 5h-1 的 N1（P9 用例的撤回断言轮不到执行）—— **本阶段开工前先补** |
| L48 | **卡在 `PROCESSING` 的单没有自动化测试覆盖** —— 假网关同步返回，造不出「回包丢失」；只能手工改库模拟（R3） |
| L49 | **`FAILED` 单的 `statementId` 引用仍占着 P6 闸** —— 已把 `FAILED` 加进排除列表解决，但若将来引入新终态，这张清单还会再漏 |
| L50 | **收款账户快照扩大了明文存储面**（5h-1 的 L38）—— 每张出款单都存一份完整账号 |
| L51 | **`availablePeriods` 的 N+1 查询**（§6.4b）—— 每期查 2 次单 + 1 次明细集合。商家一年 12 期，量小可接受，没做批量优化 |
| L52 | **卡死告警只发一次**（X15）—— `stuckLoggedAt` 写死后不再重复告警。长期卡住的单靠平台端列表标红暴露，没有「重新告警」入口 |
| L53 | **`supplementAmount` 的口径会随新流水变化** —— 补差金额是「当前未纳入的流水之和」，商家在申请与审批之间又来一笔新流水，审批时会重算（§6.4），差额由审批人判断 |
| L55 | **`availablePeriods` 是无上限 N+1** —— 先无 `take` 拉全量 `merchantReceipt`，再按月各跑 4~6 次查询。商家有两年流水就是 150+ 次查询。本阶段按 YAGNI 不做批量优化 |
| L54 | **回填货款的佣金成了「漏结佣金」**（§6.4）—— 钱在支付时就被平台收走了，但结算单已 `PAID` 冻结、`C2` 进不了任何结算单 → 结算单与实际收款差一笔。本阶段修不了（`PAID` 的结算单不能取消确认），将来要么走 5g L18 统一口径后再收，要么人工调账 |

---

## 十二、Task 划分（给计划用的粗粒度）

1. **先补 5h-1 的 N1**（P9 用例拆分）+ `payouts.statementId` 索引（L47）
2. 数据模型：`kind` + 执行字段 + 账户快照 + `stuckLoggedAt` + 结算单 `paidAt` + 索引重建（§5）
   ⚠️ 迁移**不要**用 `CONCURRENTLY` —— 它不能在事务块里跑，
   而本仓库的迁移要能走 `prisma migrate deploy`（deploy 把每个迁移包在一个事务里）
3. **`FAILED` 加进四处 `notIn` 列表**（索引 WHERE / `findActivePayout` /
   `availablePeriods` / `settlement.service.ts` 的 P6 闸）
   + **`findActivePayout` 与 `availablePeriods` 的 `alreadyApplied` 加 `kind` 条件**
   + 同步改 5h-1 的单测桩与断言（`payout.service.spec.ts:462`、
   `settlement.service.spec.ts:441`）
4. `PayoutProvider` 接口 + 假出款网关（独立 `FAKE_PAYOUT_ENABLED`）+ 端点 + 安全守卫
5. `PayoutExecutionService`（状态落库的唯一入口：`markPaid` / `markFailed` /
   `scheduleRetry` / `markStuckLogged`）+ 单测
   ⚠️ `markFailed` **必须同时释放 `payout_entries`**（第三条释放路径）
   ⚠️ `markStuckLogged` **只写 `stuckLoggedAt`，不改状态、不入队**（R3）——
     名字里带「Logged」就是为了防止实施者理解成「标记为失败」
6. `PayoutWorker`（从 `PAYOUT_PROVIDERS` 令牌注入）+ 队列 + 重试与退避
   + **STEP 1.5 的两道闸**（金额 ≤ 0 / 快照缺失 → 落 `FAILED`）
   + 卡死扫描（只记日志 + 写 `stuckLoggedAt`）
7. 审批后入队（改 `PayoutService.approve`：**事务内**抄账户快照 + 按 `kind` 分支重算，
   **事务提交后**入队）
8. 补差单：
   - `apply` 的判定顺序（§6.4 的伪码：NORMAL 幂等 → SUPPLEMENT 幂等 →
     有 `PAID` 正常单 → SUPPLEMENT 路径，否则 NORMAL 路径）
   - 独立金额逻辑（佣金 0，≤ 0 → 400）
   - `approve` 的 `kind` 分支（**不调 `computeAmounts`**）
   - P3 的 `allowPaid` 分流（只给补差路径开）
   - `availablePeriods` 的 kind 化（§6.4b：`appliedKind` / `supplementAvailable` /
     `supplementAmount`）
   - `settlement` 的 P6 同步
9. 结算单联动（`PAID` 同事务，同时写 `paidAt`）
10. e2e（X1–X16）+ 失败注入 Y1–Y19
    ⚠️ 补差用例要**直接插库**造出「结算单已 `PAID` 且该期还有未纳入流水」的形状
11. 前端：三个状态 + `kind` 标记 + 补差入口 + 失败提示 + 卡住标红
12. 验收
