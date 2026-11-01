# 阶段 5m「渠道对账」设计

> **前置**：阶段 5l（出款运维兜底）已完成并合并（PR #21）。
> 本阶段补上资金链路上的最后一块：**「钱到底打没打」有了一个能落到账上的答案。**

---

## 一、背景与目标

### 1.1 这一阶段要解决什么

到 5l 为止，出款链路的人工部分已经有了一套「能用的兜底」：人工重试、人工解卡、留痕、必填原因。
但它有一个**前提是假的** —— 那些操作都建立在「**运营知道钱没打出去**」这个假设上。

这个假设在现实里不成立：

| 现实 | 后果 |
|------|------|
| 渠道调用超时 / 回包丢失 | 我们不知道钱打没打出去。5l 的 `failedBeforePayout=false` 只表达「**渠道被调用过**」—— 连渠道明确返回失败的单也落在这个标记下（保守方向，安全但不可用） |
| 渠道打成功了，但我们把它记成了失败 | 商家看到「出款失败」，钱其实到了。**两边对不上，且没人知道** |
| 渠道打了，但本地压根没这张单 | 漏记了一笔出款 → 账目漂移，商家以为没拿到钱 |
| 运营要去渠道后台翻 | 逐笔翻，慢且不可审计 |

而 5l 的三道人工闸在「渠道成功、本地记错」这个场景下**全是死路**：

| 渠道说 SUCCESS，本地是 | 现有处置路径 | 结果 |
|---|---|---|
| `PROCESSING`（卡住） | unstick→APPROVED→重打 | ❌ **重复打款** |
| `PROCESSING`（卡住） | unstick→FAILED（`failedBeforePayout=true`）→retry | ❌ 撒谎 + 重复打款 |
| `FAILED` | retry（被 `failedBeforePayout` 闸挡住） | ❌ 无路可走 |

5l 的验收记录里已经点了这一条：**「人工重试可能重复打款 …… 真正的解法是渠道对账（L43），不在本阶段」**。
本阶段就是那个解法。

### 1.2 这一阶段要补的三条腿

L43 不是「加一张对账报表」，它要同时补三样东西，缺一不可：

1. **单笔实时核实** —— 「这一笔到底打没打」（`queryPayout` 真正可用）
2. **批量对账** —— 「这个窗口里，渠道打了哪些、我们记了哪些，两边差在哪」（`listPayouts` + 账单文件）
3. **让渠道的结论能落地** —— 差出来了得有地方去（新的状态转换 + 留痕），否则对账只是一张没人能执行的报表

### 1.3 这一阶段明确不做的

| 不做 | 理由 |
|------|------|
| **B 类差异（渠道成功、本地记成失败）的自动纠正** | ⚠️ **本阶段的核心决策**。这类单的 `payout_entries` 已被释放 → 恢复它要复原「当初那批流水」，让**机器**在没人盯着的时候改一笔钱的状态，风险收益不划算 → 改为**人工处置**（运营确认渠道 + 系统校验明细可复原） |
| **新增出款单状态** | 沿用 5k/5l 的决策：`PAID` 已经是终态，缺的是**转换**不是**状态** |
| **外部告警通道**（邮件 / Prometheus / Sentry） | 本仓没有告警基建。替代方案是站内：平台端出款页顶部横幅 + 未处置差异数 |
| **真实渠道接入** | 本仓只有本地假出款网关。对账机制先在假网关上跑通，接口形状按「真渠道会怎么给账单」设计 |
| **跨期调账**（R7）与 **L54 逐笔结佣** | 5j/5k/5l 都明确排除 —— 前提是「跨期退款归属哪一期」这个**产品决策** |
| **对账结果自动改账目**（改结算单 / 改流水） | 本阶段只改 `payouts` 的状态。账目口径的修正是另一个动作（5i/5j 已有缺笔可见性） |
| **让「渠道明确拒付」的单可安全重试** | 即给 `PayoutExecuteResult` 加「渠道明确拒付」标记、让 `handleFailure` 传 `failedBeforePayout: true`。这改的是 5h-2 的 worker 语义，属相邻改进 → 记为遗留（§十·10.3） |
| **发现「渠道长期不返回终态」的单** | 渠道流水状态非终态时无法判断是「还在处理」还是「卡住了」→ 强行分类会产生高频误报 → 记为遗留 |

---

## 二、渠道侧的能力

### 2.1 `PayoutProvider` 扩展

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

/** 单笔核实的入参 —— ⚠️ **两个键至少给一个** */
export interface PayoutQuery {
  /** 渠道交易号（`PAID` 的单才有） */
  providerTxnId?: string;
  /** 渠道侧业务单号（= 我们的 `payoutNo`，**所有调过渠道的单都有**） */
  referenceNo?: string;
}

export interface PayoutProvider {
  readonly channel: string;
  readonly provider: string;

  execute(input: PayoutExecuteInput): Promise<PayoutExecuteResult>;

  /** 查一笔打款的状态（对账 / 核实用） */
  queryPayout(query: PayoutQuery): Promise<{
    status: string;
    amount?: number;
    paidAt?: Date;
  }>;

  /**
   * ⚠️ **新增**：批量查渠道侧的出款流水（对账用）。
   * 时间窗是**左闭右开**的 `[from, to)`。
   */
  listPayouts(query: { from: Date; to: Date }): Promise<ChannelPayoutRecord[]>;
}
```

⚠️ **`queryPayout` 的入参必须改成对象，且必须支持 `referenceNo`** ——
「卡在 `PROCESSING` 的单」**没有 `payoutTxnId`**（它是 `markPaid` 的唯一写入点，`payout-execution.service.ts:207`），
而解卡核实闸的对象恰恰是 `PROCESSING` 的单。
只按 `providerTxnId` 查 → **核实闸对它的全部对象都是死代码** → 永远 fail-closed → 解卡功能 100% 不可用。

`payoutNo` 是我们打款时传给渠道的（`payout.worker.ts:174` `referenceNo: claim.payoutNo`），
而且渠道流水里本来就有这个字段（`ChannelPayoutRecord.referenceNo`）→ 渠道侧有条件支持按它查。

⚠️ **`queryPayout` 目前没有任何生产调用方**（只有接口定义、假网关实现、单测 mock）→ 改签名的**生产**影响为零。
但 `api/src/modules/payment/payout-worker.spec.ts:25-31,56` 的假 provider mock 也要跟着改
（`queryPayout` 的参数形状 + 新增 `listPayouts`）。

⚠️ **`listPayouts` 是新方法，不是可选的** —— 对账的核心价值就是「拿到渠道在这个窗口里打了**哪些**单」，
只查单笔只能核对**我们已经知道的单**，**永远发现不了漏记的出款（D 类）**。

### 2.2 匹配键与「一单多流水」

#### 匹配键

| 优先级 | 键 | 说明 |
|---|---|---|
| 1 | `referenceNo`（= 我们的 `payoutNo`） | 打款时我们传给渠道的业务单号。真渠道账单一般带「商户订单号」→ **首选** |
| 2 | `providerTxnId`（= 我们的 `payoutTxnId`） | 渠道交易号。本地 `PAID` 的单一定有它；但**渠道账单未必回显** |
| — | 都对不上 | → **D 类**（渠道有、本地无） |

⚠️ **`payoutNo` 唯一**（`payouts_payoutNo_key` 唯一索引）；
**`payoutTxnId` 没有唯一约束**（`schema.prisma:1278` 是裸的可空列）→
走第 2 级匹配时若命中**多张**本地单，**按 `paidAt` / `failedAt` 最新的一张取，并记一条差异**，不要静默取第一条。

⚠️ **不引入模糊匹配**（按金额 + 时间 + 账户名去猜）—— 猜错的代价是「把别人的单认成自己的」，
比匹配不上严重得多。匹配不上就是 D 类，交给人看。

#### 一单多流水（渠道重试）

⚠️ **一张本地单可能对应多条渠道流水**：第一次打款失败、退避后第二次成功 → 渠道侧有两条流水
（同一个 `referenceNo`，两个不同的 `providerTxnId`）。

→ **比对前先归组**：把匹配到同一张本地单的所有渠道流水放进一组，
每组取一条**权威记录**：

1. 组内有 `status === 'SUCCESS'` 的 → **取它**（有多条 SUCCESS 则取 `paidAt` 最晚的）
2. 组内没有 SUCCESS → 取 `paidAt` 最晚的（没有 `paidAt` 的取最后一条）

⚠️ **「失败那次也要进 `listPayouts` 的结果集」** —— 否则「第一次失败第二次成功」在渠道侧只剩一条 SUCCESS，
看起来像「只打了一次」，对账就测不出重试场景。

### 2.3 假网关要「说真话」

⚠️ **现在不能直接拿 `queryPayout` 当核实闸** —— `fake-payout.provider.ts:156-159` 恒返回 `SUCCESS`
→ 拿它做核实的话，**每一张单都会被判定为「渠道说已打款」** → 解卡重打功能全废（§六）。

→ 假网关改为**存每次 `execute` 的真实结果**，**按 `referenceNo` 与 `providerTxnId` 两个键都建索引**
（`PROCESSING` 的单只有 `payoutNo`，没有交易号 —— 见 §2.1），
`queryPayout` 按真实状态返回，`listPayouts` 按时间窗返回**全部**尝试记录（含失败那次）。

⚠️ **假网关要补一个时间字段** —— `execute` 现在**不记录任何时刻**
（`fake-payout.provider.ts:78` 的 `received` Map 只存 `PayoutExecuteInput`，那个类型里没有时间字段），
`listPayouts(from, to)` 无从实现。
→ 记录里加 `executedAt: Date`，**用 `new Date()` 即可** ——
假网关是纯内存结构，注入 `TenantPrismaService` 只为拿一个时钟是过度设计；
e2e 里两者相差毫秒级，不影响判定。真正的时间窗判定在比对引擎里做（§四）。

⚠️ **进程内状态 → 多进程部署下对账结果是垃圾**：
`listPayouts` 读的是进程内 Map。若 api 与 worker 不在同一进程，
api 侧看到的渠道流水是**空的** → 每次对账都把所有 `PAID` 单报成 **E 类**（最危险的那类）
→ 差异列表被垃圾淹没。

⚠️ **但当前 compose 是单进程，尚未触发这个限制** ——
`infra/docker-compose.yml` 只有一个 `api` 服务，`Dockerfile` 的 `CMD ["node", "dist/main.js"]` 只有一个进程，
`@Processor(PAYOUT_QUEUE)` 的 `PayoutWorker` 就在 Nest 进程里 → **api 与 worker 同进程** ✅
这个限制针对的是「将来把 worker 拆成独立服务」之后。

→ **e2e 必须让 api 与 worker 同进程**（现状满足 ✅）；若将来拆 worker，这段要重新设计。

⚠️ **`listPayouts` 在假网关未启用时要抛明确的错**（不是返回空数组）：
返回空数组会被当成「渠道说这一笔没有」→ 全部变 E 类。抛错才能让调用方区分
「渠道说没有」与「我压根没问上渠道」。

### 2.4 前置修复：`markFailed` 要存渠道交易号

⚠️ **这是「实时核实」能不能做起来的前提**。

现状：`payoutTxnId` 的**唯一写入点**是 `PayoutExecutionService.markPaid`
（`payout-execution.service.ts:207`）。`markFailed` **不写** → **`FAILED` 的单没有渠道交易号**。

而渠道失败时**是给了交易号的** —— `PayoutExecuteResult.providerTxnId` 在失败路径也有值
（假网关的失败分支就返回了 `providerTxnId`，见 `fake-payout.provider.ts:130`），**是我们没存**。

→ 改动：

```ts
export interface MarkFailedInput {
  reason: string;
  failedAt: Date;
  failedBeforePayout?: boolean;
  /** ⚠️ **新增**：渠道交易号。失败时渠道也会给 —— 不存就无从核实 */
  providerTxnId?: string;
}
```

`markFailed` 的 `data` 里补写 `payoutTxnId: input.providerTxnId`
（⚠️ **只在有值时写**，`undefined` 不能覆盖已有值 —— Prisma 会忽略 `undefined` 字段，正好）。

⚠️ **worker 的 5 个 `markFailed` 调用点里，只有 2 个要传交易号**（`payout.worker.ts`）：

| 行号 | 分支 | 渠道被调用过吗 | 要传交易号吗 |
|---|---|---|---|
| `:133` | 账户解密失败 | ❌ 没有 | 不传 |
| `:146` | `checkGates` 金额/账户闸 | ❌ 没有 | 不传 |
| `:161` | 没有可用渠道 | ❌ 没有 | 不传 |
| `:252` | 渠道金额核对不通过 | ✅ 调用过（返回了 SUCCESS 但金额对不上） | **要传** |
| `:281` | `handleFailure` 达到重试上限 | ✅ 调用过 | **要传** |

⚠️ **前三个不能传** —— 渠道压根没被调用，没有交易号。传个假值进去会污染「核实」的判断。

### 2.5 前置修复：`markPaid` 要清掉失败痕迹

⚠️ **`markPaid` 的 `data` 现在只清 `failureReason`**（`payout-execution.service.ts:203-210`），
**不清 `failedAt`、不清 `failedBeforePayout`**。

后果：一张先 `FAILED` 后 `PAID` 的单，两个字段都残留 →
① §四·4.1 靠这三个时间戳捞单 → 残留的 `failedAt` 会让这张单落进**另一个**窗口；
② `failedBeforePayout` 停在 `true`（`retry` 重置成 `false`，但 worker 的 `scheduleRetry` 路径不重置）
→ 一张 `PAID` 的单带着「钱确定没打出去」的标记，**语义自相矛盾**。

→ `markPaid` 的 `data` 补 `failedAt: null`、`failedBeforePayout: false`。

---

## 三、数据模型

### 3.1 新枚举

```prisma
/// 对账的数据来源
enum ReconciliationSource {
  /// 渠道 API 批量查单
  API
  /// 渠道账单文件导入
  FILE
}

/// 对账任务的状态
enum ReconciliationStatus {
  RUNNING
  COMPLETED
  FAILED
}

/// 差异类型（对应 §四·4.3 的 A–F）
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
  INFO
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

⚠️ **`PayoutOperationAction` 加两个值**：

```prisma
enum PayoutOperationAction {
  RETRY
  UNSTUCK_TO_FAILED
  UNSTUCK_TO_APPROVED
  /// ⚠️ **新增**：对账发现渠道已打款，本地是 PROCESSING → 自动纠正为 PAID
  RECONCILE_TO_PAID
  /// ⚠️ **新增**：人工确认「渠道已打款」→ FAILED 纠正为 PAID
  MANUAL_CONFIRM_PAID
}
```

⚠️ **枚举加值不新增状态** —— `PAID` 已是终态，本阶段加的是**转换**。

### 3.2 `payouts` 加一列：释放明细时记下的流水 id

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

⚠️ **写入点只有两处**（都是释放明细的地方）：
① `PayoutExecutionService.markFailed`（`payout-execution.service.ts:270` 删明细的地方）
② `PayoutService.unstick` 的 `to='FAILED'` 分支（`payout.service.ts:1046-1048` 删明细的地方）

⚠️ **读 id 与删明细必须在同一个事务里** —— 否则会出现「明细已删、id 没记上」的窗口，
这张单就永远复原不了（只能落人工处理）。

⚠️ **5l 的 `retry` 继续用「重算」** —— 本阶段不动它（外科手术式改动）。
两者口径的差异记在 §十·10.3。

### 3.3 `payout_reconciliations`（对账任务）

⚠️ **不带 `tenantId`** —— 对账是**平台级**动作，跨所有租户（与 `payout_operations` 同款）
→ **不登记进 `TENANT_SCOPED_MODELS`** → 在 `tenant-prisma.service.ts` 加一个裸 delegate。

⚠️ **它不受任何租户作用域约束** —— 任何忘了带 `reconciliationId` 的查询都会返回**全平台数据**。
本表本身不含商家金额（只有统计数字），风险可控；但**必须**在 `tenant-models.ts` 里写明这条警告
（与 `PayoutOperation` 的说明同款，`tenant-models.ts:118-123`）。

```prisma
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
```

### 3.4 `payout_reconciliation_items`（差异明细）

⚠️ **同样不带 `tenantId`** → 不登记白名单 → 裸 delegate。

⚠️ **本表不受任何作用域约束，且 `payoutId` 可空**（D 类没有本地单）→
「按 `payoutId` 反查租户」这个安全网在 D 类上**直接失效** →
任何列表/详情查询**必须**同时按 `reconciliationId` 限定，
且 `reconciliationId` 只能来自平台超管的权限检查之后。
本表含 `channelReferenceNo`（= 商家的出款单号）与金额 → **泄露即跨租户泄露**。

```prisma
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
  @@index([payoutId])
  @@map("payout_reconciliation_items")
}
```

#### 重复差异的去重

⚠️ **每次对账都会重新产生差异项** → 若不做去重，「未处置差异数」会**单调增长**
→ §五·5.4 的横幅数字一直涨 → 运营要反复处理同一个问题。

→ **规则**：本次对账产生差异后，把历史上同 `(payoutId, type)` 的 `PENDING` 项标为 `IGNORED`
（`note` 写「已被 {新对账任务 id} 重新评估」）。D 类没有 `payoutId` → 用 `channelTxnId` 代替。

⚠️ **历史记录保留** —— 被标 `IGNORED` 的项不删，审计时要能看到「这个问题被对账发现过几次」。

### 3.5 `payout_operations` 加一列

⚠️ **加列，不改已应用的迁移** —— `20261030130000_add_payout_ops` 已经应用了，改它会让 checksum 失配。

```prisma
/// ⚠️ **新增**：触发的对账任务 id。
/// 没有它就答不出「这次对账纠正了哪几张单」——
/// 留痕只有「谁在什么时候把哪张单改了」，没有「为什么」。
reconciliationId String?
```

### 3.6 迁移

⚠️ **手写 SQL**（`prisma migrate dev` 在本仓不可用 —— 历史迁移 checksum 不符，见 5j/5k/5l 的记录）。

新增迁移目录 `api/prisma/migrations/20261031100000_add_payout_reconciliation/`：

1. **先建 4 个新枚举**（`CREATE TYPE`）—— PostgreSQL 的顺序要求
2. `ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'RECONCILE_TO_PAID';`
   与 `ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'MANUAL_CONFIRM_PAID';`
   - ⚠️ **PG 16 允许在事务里 `ADD VALUE`**，但**新值不能在同一个事务里被使用**。
     我们只在应用代码里用这两个值，迁移 SQL 本身不碰它们 → **单个迁移文件可行** ✅
     （与本仓 `20261029110000_add_processing_status/migration.sql:18` 的既有先例一致）
   - ⚠️ **两条语句要分开写**（一条只能加一个值）；**要带 `IF NOT EXISTS`**（本仓迁移的幂等约定）
3. `ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "releasedEntryIds" TEXT;`
4. `ALTER TABLE "payout_operations" ADD COLUMN IF NOT EXISTS "reconciliationId" TEXT;` + 索引
5. `CREATE TABLE IF NOT EXISTS "payout_reconciliations"` / `"payout_reconciliation_items"`
   + 外键（`ON DELETE CASCADE ON UPDATE CASCADE`）+ 索引

⚠️ **不改动任何既有枚举的取值** → 部分唯一索引 `payouts_tenantId_period_kind_active_uniq` 不受影响。

---

## 四、比对引擎

### 4.1 参与比对的本地单

⚠️ **不能用 `createdAt` 筛** —— 那会把「还没调过渠道的单」（`REQUESTED` / `APPROVED`）也捞进来，
它们在渠道侧压根没有记录 → 全变成假的 D 类。

**判据是「这张单调过渠道」**，对应三个时间戳：

```ts
where: {
  OR: [
    { paidAt: { gte: from, lt: to } },       // 打过且成功
    { processingAt: { gte: from, lt: to } }, // 打过且卡住
    { failedAt: { gte: from, lt: to } },     // 打过且失败
  ],
}
```

⚠️ **E 类（本地已付、渠道查无此笔）只能靠这个捞出来** —— 它的标记是 `paidAt`。
若按 `createdAt` 筛，一张三个月前创建、上周打款成功的单会落进错误的窗口。

⚠️ **这个 `where` 不带 `status`** —— `PAID` / `PROCESSING` / `FAILED` 三种都要参与比对；
`REQUESTED` / `APPROVED` / `REJECTED` / `CANCELLED` 不会被这三个时间戳命中，自然进不来。

⚠️ **跑在平台作用域下**（`payouts` 在租户白名单里，但对账是平台级动作）。

### 4.2 时间窗与两侧并集

| 侧 | 捞取范围 | 为什么 |
|---|---|---|
| 本地 | **名义窗口** `[from, to)` | 本地时间戳是数据库时钟（UTC），可靠 |
| 渠道 | **扩大的窗口** `[from - 15h, to + 15h)` | 渠道流水的时间戳可能是渠道本地时区，与 UTC 最多差 14 小时（UTC+14） |

⚠️ **15 小时是刻意取整的** —— 12 小时**盖不住 UTC+14**（Kiribati 时区），15 小时留 1 小时余量。

⚠️ **两边时钟不同源** —— 这是「误报 D 类」的第二个来源（第一个是匹配不上）。
扩大的窗口**不会引入假差异**（§四·4.4 第三步的判定保证这一点）。

### 4.3 差异分类

| # | 类型枚举 | 渠道说 | 本地记 | 含义 | 严重级 | 处置 |
|---|---|---|---|---|---|---|
| A | `CHANNEL_PENDING_LOCAL` | SUCCESS | `PROCESSING` | 钱打了，本地卡在中间 | INFO | ✅ **自动纠正** → `PAID` |
| B | `CHANNEL_SUCCESS_LOCAL_FAILED` | SUCCESS | `FAILED` | 钱打了，本地误判失败 | WARNING | ❌ **人工处置**（§五·5.2） |
| C | `AMOUNT_MISMATCH` | SUCCESS | `PAID` 但金额不同 | 打错金额 | CRITICAL | ❌ 人工 |
| D | `CHANNEL_ONLY` | 有记录 | 无这张单 | **漏记了一笔出款** | CRITICAL | ❌ 人工 |
| E | `LOCAL_PAID_CHANNEL_ABSENT` | 无记录 | `PAID` | **钱可能压根没出去** | CRITICAL | ❌ 人工 + **预警** |
| F | `STATUS_MISMATCH` | FAILED | `PAID` | **渠道明确拒付**，本地却记成已付 | CRITICAL | ❌ 人工 + **预警** |

⚠️ **匹配上了、金额一致、状态一致** → 计入 `matchedCount`，**不落 item 表**。

⚠️ **F 类（渠道拒付）比 E 类更明确** —— 渠道告诉我们「这笔没成」，而本地记着「已付款」。
商家以为拿到了钱，实际没有 → **与 E 类同等的预警等级**，但处置方向不同：
E 类要判断「是延迟还是拒付」，F 类已经知道是拒付 → 走退款 / 冲账。

### 4.4 判定的顺序

```
第一步：归组
  1a. 逐条渠道流水匹配本地单（referenceNo → providerTxnId）
  1b. 匹配到同一张本地单的渠道流水放进同一组（§二·2.2）
  1c. 每组取一条权威记录：优先 SUCCESS（多条取 paidAt 最晚的）；
      没有 SUCCESS 的取 paidAt 最晚的

第二步：逐张本地单（§4.1 捞出的集合）对照它的权威渠道记录
  a. 渠道 SUCCESS 且 本地 PROCESSING      → A 类
  b. 渠道 SUCCESS 且 本地 FAILED         → B 类
  c. 渠道 SUCCESS 且 本地 PAID 且金额不同  → C 类
  d. 渠道 SUCCESS 且 本地 PAID 且金额一致  → 匹配（matchedCount++）
  e. 渠道 FAILED  且 本地 PAID           → F 类（渠道拒付）
  f. 渠道 FAILED  且 本地 FAILED         → 匹配（双方一致，matchedCount++）
  g. 渠道非终态 / 其它组合               → **不算差异**
  h. 没有权威渠道记录 且 本地是 PAID       → E 类

第三步：没有匹配到任何本地单的渠道流水
  a. 时刻落在【扩大的窗口】内 → D 类
  b. 落在窗口外（时钟偏移导致的多余记录） → **忽略**
```

⚠️ **g 档是「不算差异」** —— 渠道流水里可能有大量非终态记录（渠道还在处理），
它们与本地状态的各种组合都不是矛盾。**只有「双方都声称终态且互相矛盾」才是差异。**

⚠️ **g 档的已知局限**（§一·1.3 明确不做）：「渠道永远不返回终态」的单会被永久忽略。

⚠️ **第三步的 b 档是必须的** —— 扩大的窗口会把名义窗口之外的渠道记录也拉进来，
一律判成 D 类的话，每次对账都会凭空多出一堆假差异。

⚠️ **f 档（渠道失败 + 本地失败）算匹配** —— 双方一致说「没打出去」，这是正常状态，不是差异。

### 4.5 比对引擎的契约

⚠️ **引擎是纯函数** —— 不查库、不改库。两个集合由调用方（对账服务）组装好传进来。

```ts
/** 参与比对的本地单（已按 §4.1 查好） */
interface LocalPayoutForReconcile {
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

interface ReconcileInput {
  /** 名义窗口 [from, to) */
  window: { from: Date; to: Date };
  /** 扩大的窗口边界（用于判定 D 类是否落在窗口内） */
  expandedWindow: { from: Date; to: Date };
  /** 本地单集合 */
  localPayouts: LocalPayoutForReconcile[];
  /** 渠道流水集合（已含失败那次） */
  channelRecords: ChannelPayoutRecord[];
}

interface ReconcileDiff {
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

interface ReconcileOutput {
  diffs: ReconcileDiff[];
  /** 口径 = **本地单数**（不是渠道流水条数） */
  matchedCount: number;
}
```

⚠️ **组装的职责在 Task 8 的对账服务** —— 查本地单（§4.1 的 where）+ 拉渠道流水
（`listPayouts` 或 CSV 解析结果）+ 调引擎 + 落差异项。引擎本身只管分类。

---

## 五、处置

### 5.1 A 类：自动纠正（`PROCESSING → PAID`）

⚠️ **可以复用 `PayoutExecutionService.markPaid`** —— 它的条件更新已经是
`where: { id, status: PROCESSING }`（`payout-execution.service.ts:202`），
而且它会**联动结算单转 `PAID`**（`kind === 'NORMAL'` 且结算单是 `CONFIRMED` 时，`:222-232`）。

⚠️ **A 类的明细还在** —— `payout_entries` 只在 `markFailed` 里被删（`:270`），
`PROCESSING` 状态的单明细从未释放 → **不需要复原、不需要重算** ✅

流程：

```
1. markPaid(payoutId, {
     providerTxnId: 权威渠道记录的 providerTxnId,
     channel: 渠道名,
     paidAt: ⚠️ 数据库时钟（await databaseNow()），不是渠道时刻（见下）
   })
2. tx.payoutOperation.create({
     action: 'RECONCILE_TO_PAID',
     operatorId: 'system:reconciliation',   // ⚠️ 定时/自动纠正没有真人
     fromStatus: 'PROCESSING', toStatus: 'PAID',
     reconciliationId: 本次对账任务 id,      // ⚠️ 关联到对账任务
     reason: '渠道对账：渠道确认已打款，本地纠正为已付款（渠道流水号 xxx）',
   })
```

⚠️ **`paidAt` 统一用数据库时钟** —— 不能用渠道侧时刻。
`payouts.paidAt` 在正常流程里是 `databaseNow()`（`payout.worker.ts:241`），
若 A 类改用渠道时钟，同一张表里会出现**两套时钟口径**，而 §四·4.1/§4.2 的窗口筛选是建立在
「本地时间戳是数据库时钟」这个前提上的。
→ **渠道时刻只存在对账的 item 表（`channelPaidAt`）与留痕的 reason 里** —— 那才是它该待的地方。

⚠️ **`markPaid` 返回 `false` 表示条件更新没命中**（状态已被改掉）→ 跳过，不报错。
⚠️ **但必须记一条日志** —— 现状是**完全静默**（`payout-execution.service.ts:212-214` 直接 `return false`）。
补上日志的理由：worker 可能刚好在通道的对账纠正**之前**落了 `PAID`，
这时「渠道打了两次」的怀疑无法排除 —— 有日志才查得清。

⚠️ **`payoutTxnId` 冲突时以谁为准** —— 对账写入的是**渠道侧权威值**；
worker 后续的 `markPaid` 因 `where` 不命中而**不会覆盖**它 → 天然是「对账的赢」，无需额外处理。

⚠️ **结算单联动只在 `kind === 'NORMAL'` 时发生**（护栏 X6，补差单不改结算单）→ 复用 `markPaid` 自动满足。

### 5.2 B 类：人工处置（`FAILED → PAID`）

⚠️ **本阶段明确不做自动纠正**（§1.3）。但**人工处置也不能是「直接改状态」**。

**问题**：`markFailed` 会 `deleteMany` 释放 `payout_entries`（`payout-execution.service.ts:270`）。
释放是必须的 —— `payout_entries.entryId` 是全局唯一索引，不释放的话商家重新申请同一期会撞 P2002 → 500。

**释放的代价**：`FAILED` 的单**已经丢失了「它原本要打哪些流水」这个信息**。

**若直接把 `FAILED` 改成 `PAID` 而不恢复明细**：

| 后果 | 分析 |
|---|---|
| 商家能不能重新申请同一期？ | **不能** —— 转 `PAID` 会占位 `(tenantId, periodStart, kind)`，而部分唯一索引的 `WHERE` 不含 `PAID` → 商家申请会撞索引。⚠️ **`REQUESTED` 也占位**（不在 `NOT IN ('REJECTED','CANCELLED','FAILED')` 里）→ 商家**刚申请**就挡住了，不需要等审批 |
| 会不会打第二次钱？ | **不会** —— 若商家已经重新申请过，新单已占位 → 原单转 `PAID` 撞部分唯一索引 → **数据库挡住** ✅ |
| **真正的问题** | 这批流水**不在任何出款单的明细里**，商家也申请不了 → **这笔钱在出款维度上凭空消失**：商家少拿了，账上又没有出款记录 |

⚠️ **所以 B 类的人工处置必须恢复明细。** 但**不能用「重算」恢复**：

- `NORMAL` 单重算出来的是「该期全部货款流水」，与当初纳入的一致 ✅
- `SUPPLEMENT`（补差）单的纳入范围是「**本单已占** ∪ 未被他单占用」（`computeSupplementAmounts`），
  **依赖 `payout_entries` 本身** —— 明细已被释放 → 重算出的范围失真 → **复原不出「当初那批」** ❌

→ **根治办法：释放明细时把 id 记下来**（§三·3.2 的 `releasedEntryIds`）。

**四道闸**：

| 闸 | 检查 | 不过怎么办 |
|---|---|---|
| ① **明细可复原** | `releasedEntryIds` 非空（存量单为 `null` → 不可复原） | 落人工待处理项，注明「明细无法复原，需人工处理」 |
| ② **金额与笔数对得上** | 按 `releasedEntryIds` 查 `merchant_receipts`，**带符号**金额之和 == `receiptAmount` 且 **笔数 == `entryCount`**。<br>另校验 `netAmount == receiptAmount − commissionAmount`（自洽） | 账已经漂了 → 拒绝，转人工账务处理 |
| ③ **明细未被他人占用** | 那些流水的 `entryId` 是否已被**别的**出款单占用（`payout_entries.entryId` 唯一索引） | 已被占用 → 说明商家已经重新申请、**钱可能正在打第二次** → 拒绝并标「**疑似重复付款**」，需人工退款处理 |
| ④ **渠道核实 + 结算单状态** | ①渠道核实：实时 `queryPayout({ referenceNo: payoutNo })` 说 SUCCESS？不可用则查该单最近一次对账结果。<br>②结算单状态：`statementId` 为 **null** → 该期零额抽佣、无结算单 → **跳过联动，不算异常** ✅；是 `PAID` → 幂等 no-op ✅；是 `REJECTED` / `CANCELLED` → **联动不会发生** → 结算单与出款单状态不一致 → 拒绝 | 拿不到渠道结论 → 拒绝（fail-closed）；<br>结算单状态异常 → 拒绝并说明 |

⚠️ **闸 ③ 必须显式带租户条件** —— `payout_entries` **不在租户白名单**（`tenant-models.ts:114-116`）→
扩展不附加任何过滤 → 查询返回全局事实。要显式带 `payout: { tenantId, periodStart }`
（照 `computeUnclaimedAmounts` 的写法，`payout.service.ts:1642-1645`）。

⚠️ **闸 ④ 的核实与 §六 的解卡闸共用同一套三层核实**（§六·6.3）。

**通过四闸后**：

```
1. tx.payoutEntry.createMany({ data: releasedEntryIds 还原的明细 })
2. tx.payout.updateMany({
     where: { id, status: 'FAILED' },
     data: { status: 'PAID', paidAt: 数据库时钟, payoutChannel, payoutTxnId,
             failureReason: null, failedAt: null, failedBeforePayout: false },
   })
3. tx.settlementStatement.updateMany({ where: { id: statementId, status: 'CONFIRMED' },
                                         data: { status: 'PAID', paidAt } })
   ⚠️ **statementId 为 null 时跳过本步**（该期零额抽佣、没有结算单 —— 是常态不是异常）
4. tx.payoutOperation.create({ action: 'MANUAL_CONFIRM_PAID', ... })
```

⚠️ **结算单联动要自己写，不能直接复用 `markPaid`**（它的 `where` 是 `status: PROCESSING`）→
在 `PayoutExecutionService` 里新增一个方法，**内部复用同一段结算单联动逻辑**（不要复制粘贴两遍）。

⚠️ **`failedAt` 与 `failedBeforePayout` 要清空** —— 它们记的是「落 FAILED 那一刻」的判断，
现在是 `PAID` 了，留着会误导（§二·2.5 是同一件事的另一半）。

⚠️ **`attemptCount` 不重置** —— 与 `retry` 的处理不同（`retry` 重置为 0 是因为要**重新打**；
这里钱已经打了，次数是历史事实，保留）。

⚠️ **数据库是最后一道兜底** —— 即使四道闸都过了，转 `PAID` 时若撞上部分唯一索引
`payouts_tenantId_period_kind_active_uniq`（说明商家已经重新申请过同一期），
**必须捕获 P2002 并翻成业务错误**，不能让它冒成 500。

### 5.3 C / D / E / F 类：人工待处理

只落 `payout_reconciliation_items`，**不改任何状态**。

| 类型 | 运营要做什么 |
|---|---|
| C（金额不符） | 人工联系渠道与商家，追回多付或少付的部分。⚠️ **系统无法自动纠正** |
| D（渠道有本地无） | 查清「这张出款单为什么没进我们系统」→ 补建出款单或冲账 |
| E（本地已付渠道无） | ⚠️ **最危险**：商家以为拿到了钱，渠道说没这笔。可能是渠道拒付、可能是账单延迟。→ 人工核实，必要时走退款 |
| F（渠道拒付，本地已付） | 渠道明确告诉我们没成 → 走退款 / 冲账流程 |

⚠️ **E / F 类的处置不能自动** —— 机器无法区分「渠道拒付了」和「账单还没出」。

### 5.4 E / F 类的预警

⚠️ 仓里**没有**邮件 / 外部告警基建 → 只能**站内**：

1. 平台端**出款列表页**顶部：存在 `severity === CRITICAL` 且 `resolution === PENDING` 的差异时，
   显示红色横幅 + 未处置数量
2. 平台端**对账页**：差异列表按严重级排序，E / F / C / D 置顶

⚠️ **`platform-admin/src/components/ui/` 只有 card / label / table / button / input** ——
**没有 badge / banner / alert 组件**。既有的告警写法是裸段落
（`<p role="alert" className="text-sm text-destructive">`，见 `payout-actions.tsx:230`、
`settlement-actions.tsx:178`、`plan-form.tsx:400`）→ 沿用这个风格，不新建组件库。

---

## 六、解卡重打的前置闸

### 6.1 为什么必须有

5l 的验收记录留下：**「人工重试可能重复打款 …… 界面警示 + 必填原因 + 留痕只能降低误操作概率，不能消除。
真正的解法是渠道对账（L43）」**。

L43 落地后，如果**只加对账不加闸**，反而会制造新的竞态：

```
运营看到「卡住了」→ 点「解卡重打」→ 钱打第二次
                                     ↑
                        对账任务可能还没跑到，或跑完了运营没看
```

### 6.2 闸要罩住 `unstick` 的**两个分支**

⚠️ **容易漏的一点**：`unstick` 的两个分支**都会导致重打**：

| 分支 | 后果 |
|---|---|
| `to='APPROVED'` | 直接重新入队打款 |
| `to='FAILED'` | 设 `failedBeforePayout: true` → **制造出一张「可安全重试」的单** → 之后能被 `retry` 重打 |

→ **闸必须放在 `unstick` 的入口**，罩住整个方法，不是只罩重打那一条。

### 6.3 三层核实

⚠️ **这套逻辑有且只有一处实现** —— `PayoutVerificationService.verify()`（§七·7.5 的模块归属）。
§五·5.2 的闸 ④ 与这里的解卡闸**都调它**，不各写一遍。

```
第 1 层：实时渠道核实
  → provider.queryPayout({ referenceNo: payout.payoutNo })
     ⚠️ 用 referenceNo（payoutNo），**不是** providerTxnId ——
        PROCESSING 的单没有 payoutTxnId（§二·2.1）
  → 渠道说 SUCCESS → 【拒绝解卡】，并把这张单纠正为 PAID（渠道是权威）
                       · 本地是 PROCESSING → 走 A 类自动纠正路径（§五·5.1）
  → 渠道说 FAILED  → 允许解卡（渠道明确说没打）
  → 核实不可用（抛错 / 渠道不支持 / 查不到这条）→ 第 2 层

第 2 层：查该单最近一次对账结果
  → 查 payout_reconciliation_items 里该 payoutId 的最新记录
  → 渠道结论是 SUCCESS → 同上，拒绝并纠正
  → 渠道结论是 FAILED  → 允许解卡
  → 没有对账记录      → 第 3 层

第 3 层：fail-closed
  → 拒绝解卡，提示「无法确认该笔是否已打款，请先执行渠道对账」
```

⚠️ **「渠道查不到这条」不等于「渠道说没打」** —— 查不到可能是渠道还没处理、也可能只是不支持按单号查。
只有渠道**明确说 FAILED** 才放行解卡。

⚠️ **解卡语境里不存在「本地是 FAILED」这一支** —— `unstick` 的入口已经校验
`payout.status !== PROCESSING` 就 409（`payout.service.ts:987-991`），
解卡接口**根本不会作用于 FAILED 单**。B 类的处置入口在 §五·5.2 的独立端点，不在这里。

⚠️ **副作用要说清楚：解卡功能会变严。** 渠道不支持按单号查询、又没有对账结果时，解卡做不了。
这是「宁可不做也不重复打款」的取舍，方向与 5l 的设计一致。

⚠️ **`retry` 不受这道闸约束** —— `retry` 只对 `FAILED` 且 `failedBeforePayout === true` 生效，
那种单渠道**从没被调用过** → 不存在重复打款风险 ✅

### 6.4 闸的落点

⚠️ **闸在 `PayoutService.unstick` 的入口**（billing 模块）—— 它是**业务规则**，不能被绕开。
放在 service 层，任何调用方（controller、将来的定时任务）都自动受约束。

⚠️ **但 billing 模块拿不到 `PayoutProvider`** —— 这是本仓的硬边界：
`billing.module.ts:56-60` 明写「**`billing` 模块绝对不能 import `payment`** ——
那就成了 `order → billing → payment → order` 的环，NestJS 启动直接报错」。
而 `PayoutService` 的构造器（`payout.service.ts:211-215`）也没有任何 provider 句柄。

→ **解法：契约下沉到 `common/`，实现放 payment，billing 按 token 注入。**

```ts
// api/src/common/payment/payout-verification.ts   ← 纯契约，仿 common/queue/queue.constants.ts
export const PAYOUT_VERIFICATION = Symbol('PAYOUT_VERIFICATION');

export interface PayoutVerificationTarget {
  id: string;
  payoutNo: string;
  payoutTxnId: string | null;
}

export interface PayoutVerificationVerdict {
  /** PAID = 渠道说钱打了；FAILED = 渠道说没打；UNKNOWN = 问不出结论 */
  verdict: 'PAID' | 'FAILED' | 'UNKNOWN';
  /** 结论来源 */
  source: 'REALTIME' | 'RECONCILIATION' | 'NONE';
  providerTxnId?: string;
  amount?: number;
  paidAt?: Date;
}

export interface PayoutVerification {
  verify(target: PayoutVerificationTarget): Promise<PayoutVerificationVerdict>;
}
```

- `payment` 模块提供 `PayoutVerificationService`（持有 `PAYOUT_PROVIDERS`），
  并用 `{ provide: PAYOUT_VERIFICATION, useExisting: PayoutVerificationService }` 注册
- `billing` 的 `PayoutService` 用 `@Inject(PAYOUT_VERIFICATION)` 注入
- **依赖方向仍是 `payment → billing`（单向）** —— `common/` 的契约文件不 import 任何模块，不构成环 ✅

---

## 七、对账服务与 API

### 7.1 手动触发

平台端「立即对账」→ 选渠道 + 时间窗 → 建一个 `RUNNING` 任务 → 同步执行 → 落结果。

⚠️ **同步执行** vs 入队：一次对账的量取决于窗口内的出款单数。日常量级（几十上百笔）同步跑没问题，
但**窗口开太大会超时**。
→ **本阶段同步执行，但设三道上限**：时间窗最大跨度 **31 天**；渠道侧返回的记录数上限 **10000 条**
（超了就把任务落 `FAILED` 并写明原因，**不做静默截断** —— 截断出来的对账结论是错的）；
**单次执行超时 30 秒**（超了同样落 `FAILED` 并写明原因）。

⚠️ **前端要有 loading 态** —— 同步执行意味着 HTTP 请求会挂到对账跑完（可能十几秒）。

⚠️ **这个上限与「不引入分页」是冲突的**（§十·10.1 风险 1）→ 真渠道接入前必须补分页或分片拉取。

### 7.2 账单文件导入（CSV）

⚠️ **真渠道的 CSV 字段千差万别** → 不能用固定模板（要超管先整理成模板，等于把对账的价值打没）。

**上传时做列映射**。超管指定：

| 映射项 | 说明 |
|---|---|
| 渠道交易号列 | 必填（否则无法匹配） |
| 业务单号列 | 选填（`payoutNo` 匹配用） |
| 金额列 | 必填 |
| **金额单位** | ⚠️ **分 / 元** —— 猜错就是金额差 100 倍 |
| 状态列 | 选填 |
| **状态值映射** | ⚠️ 哪些值算 `SUCCESS`、哪些算 `FAILED`（渠道的状态词五花八门：成功/已付/打款成功/0/1） |
| 打款时间列 | 选填 |

⚠️ **状态值映射不能省** —— 解析不出状态就没法分类，只能全部落成「未知」→ 对账等于没做。

**原始文件不落盘** —— 只存解析后的记录 + 映射配置（`columnMapping` JSON）+ 文件名。
对账单不大（几万行以内），内存处理足够。

⚠️ **上传约束**：单文件大小上限 **5MB**、行数上限 **10000 行**（与 §7.1 的渠道记录数上限一致）；
解析只取白名单列，不做公式展开等富文本特性。

**两条来源走同一个比对引擎** —— API 拉来的记录与 CSV 解析出的记录，
都转成 `ChannelPayoutRecord[]` 后进同一个 `reconcile()`。

⚠️ **CSV 导入的多条流水** —— 同一 `payoutNo` 在账单里出现多行（重试）→
**同样要归组**（§二·2.2），归组逻辑在比对引擎里，两条来源共用。

### 7.3 定时对账

照 `PayoutScanScheduler` 的模式（一个只负责注册周期任务的 `@Injectable`）：

- `PAYOUT_QUEUE` 上新增 job name `'reconcile'`（现在只有 `'execute'` 与 `'scan'`）
- 每日跑一次，对**昨天**（UTC 自然日）
- ⚠️ **幂等**：同一天重复跑 → 检查「该渠道该窗口是否已有 `COMPLETED` 任务」→ 有就跳过
- ⚠️ **jobId 要稳定**（照 `runScan` 的 `payout-{id}-rescue-{attemptCount}` 风格）→ 用 `payout-reconcile-{yyyyMMdd}`

⚠️ **假网关未启用时根本不注册这个周期任务** —— 而不是注册了让它每天失败。
生产环境 `assertSecureConfig` 在 `FAKE_PAYOUT_ENABLED === 'true'` 时拒绝启动
→ 生产环境假网关必然不可用 → `listPayouts` 会抛错 →
注册了就是**每天落一条 `FAILED` 任务**，对账列表变成「每天都失败」，比不做还糟。

→ **注册前判断 `isFakePayoutEnabled()`**：为 false 就不注册 `'reconcile'` 周期任务。
手动触发端点同样要在入口检查，返回 409 + 文案
**「该渠道当前不可用（本地假出款网关未启用），无法执行渠道对账」**。

⚠️ **这句文案要在两处一致** —— §2.3 的 `listPayouts` 抛错与这里的 409 是两条独立的报错路径，
用**同一个常量**（或同一段注释指明），避免两处漂移。

⚠️ **文案不要写成「该渠道不支持批量查单」** —— 那暗示是渠道能力问题，
运营看到会以为系统坏了；实际原因是「本地假网关没开」。

### 7.4 端点清单（平台端）

⚠️ **全部挂平台超管权限**（`@Roles(PLATFORM_ADMIN)` 之类）——
新表不受租户作用域约束，只有平台超管能查。

⚠️ **端点归属 payment 模块**（§七·7.5）→ 路由前缀仍是 `/platform/payouts/...`，
但**控制器文件在 payment 模块**（`api/src/modules/payment/platform-payout-reconciliation.controller.ts`），
不走 billing 的 `platform-payout.controller.ts`。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/platform/payouts/reconciliations` | GET | 对账任务列表（分页） |
| `/platform/payouts/reconciliations/:id` | GET | 任务详情 + 差异列表 |
| `/platform/payouts/reconciliations` | POST | 手动触发对账（渠道 + 时间窗）。**不查幂等** —— 手动重跑是有意行为（§10.1 第 6 条） |
| `/platform/payouts/reconciliations/import` | POST | 上传账单 CSV（multipart + 列映射） |
| `/platform/payouts/reconciliations/:id/items/:itemId/resolve` | POST | 处置一条差异（`RESOLVED` / `IGNORED` + 说明） |
| `/platform/payouts/:id/confirm-paid` | POST | **B 类人工处置**：`FAILED → PAID`（走 §五·5.2 的四道闸） |
| `/platform/payouts/:id/reconciliation-status` | GET | 该单最近一次对账结论（解卡闸第 2 层用，详情页也展示） |
| `/platform/payouts/reconciliation-summary` | GET | 未处置差异的统计（给列表页的横幅用） |

⚠️ **B 类的「确认已付款」是独立端点**，不是差异项的处置 —— 差异项上点「确认已付款」时，
前端调这个端点（带 `payoutId` + 原因），成功后把对应的差异项标为 `RESOLVED`。

⚠️ **CSV 上传用 `multipart`** —— `platform-admin` 的同源中转路由要能透传 `FormData`。
既有的同源中转路由（`retry/route.ts`）都是 JSON body，CSV 是**第一个 multipart 的** → 需要单独处理。

⚠️ **CSV 导入的依赖与样板本仓全缺** —— 后端要引入 `FileInterceptor`（`@nestjs/platform-express` 才有）
+ 配 `MulterModule`；`@types/multer` 不在 devDependencies（`multer` 只是传递依赖，没类型）；
**没有任何 CSV 解析库**（`package.json` 无 `papaparse` / `csv-parse`）；
`api/test/` 下**零个** `.attach` / `FormData` 用例可参考。
→ 选型与样板见 §九 的 Task 9。

### 7.5 模块归属与依赖方向（**本阶段最重要的一条结构性约束**）

⚠️ **本仓的铁律**（`billing.module.ts:50-60`）：

```
payment  →  billing  →  （无）
   ↓          ↑
 order ────────┘

⚠️ **billing 绝对不能 import payment** —— 那就成了
`order → billing → payment → order` 的环，NestJS 启动直接报错。
所以「凡是要碰支付渠道的事一律在 payment 模块里」。
```

→ **本阶段的所有「碰渠道」的东西都放 payment 模块**：

| 组件 | 归属 | 依赖 |
|---|---|---|
| `PayoutVerificationService`（三层核实，§六·6.3） | **payment** | `PAYOUT_PROVIDERS`（同模块）+ `payoutReconciliationItem` 裸 delegate（common） |
| `PayoutReconciliationService`（对账服务，Task 8） | **payment** | `PayoutProvider.listPayouts`（同模块）+ `PayoutExecutionService`（billing，**已导出** ✅） |
| `PlatformPayoutReconciliationController`（对账端点） | **payment** | 同上 |
| `PayoutReconcileScheduler`（定时任务注册器） | **payment** | `QueueService`（common） |
| 比对引擎（纯函数） | **common 或 payment** | 无依赖 → 放 `api/src/modules/payment/payout-reconcile.engine.ts`，便于单测 |
| B 类处置的新方法（`FAILED → PAID`） | **billing** 的 `PayoutExecutionService`（**已导出** ✅） | `PayoutVerificationService`（经 token 注入） |
| A 类自动纠正 | **billing** 的 `PayoutExecutionService.markPaid`（**已导出** ✅） | 无 |

⚠️ **`PayoutExecutionService` 已经从 billing 导出**（`billing.module.ts:94-96`）→
payment 侧调它不需要改动 billing 的 exports ✅

⚠️ **billing 不需要导出 `PayoutService`** —— 对账服务与核实服务都不需要它
（A 类走 `markPaid`、B 类走新的 `PayoutExecutionService` 方法，都不需要 `PayoutService`）。

⚠️ **唯一需要跨模块的契约是 `PAYOUT_VERIFICATION`** → 放 `api/src/common/payment/payout-verification.ts`
（仿 `common/queue/queue.constants.ts` 的先例：跨模块契约放 `common/`）。

---

## 八、平台端界面

| 页面 | 内容 |
|---|---|
| **对账页**（新增，导航里加一项） | 任务列表（渠道、窗口、状态、统计）+ 点进去看差异明细 + 处置 |
| **对账差异详情** | 差异列表按严重级排序（E/F/C/D 置顶），每条显示双方金额与状态、处置按钮 |
| **出款列表页** | 顶部横幅：未处置的 CRITICAL 差异数量 + 跳转链接 |
| **出款详情页** | 操作记录里显示对账纠正的留痕（`RECONCILE_TO_PAID` / `MANUAL_CONFIRM_PAID`）+ 最近一次对账结论 |

⚠️ **平台端现有页面都是服务端组件**（`payouts/page.tsx` 是 `async function` + `apiFetchAuthed`），
数据直连后端，**不走 Next.js `/api` 路由**。但**触发行**（处置差异、确认已付款）需要客户端组件
→ 照 5l 的做法走同源中转路由（`platform-admin/src/app/api/billing/payouts/...`）。

⚠️ **没有 badge / banner 组件** → 沿用裸 `<p role="alert">` 的写法风格。
⚠️ **横幅要带跳转链接**（现有的 `<p role="alert">` 样例都是纯文本，没有链接的形态可抄）→
用 `<p role="alert" className="text-sm text-destructive">` 包一个 `<Link>`（`Link` 已在 `layout.tsx` 用过），
**不要为了一个链接新建组件**。

---

## 九、任务分解

⚠️ **顺序不能随便调** —— 每个 Task 单独提交后必须能编译、能跑测试。
所以 **schema 迁移必须排第一**（Task 1 就要写 `releasedEntryIds` 这个 Prisma 字段，
字段不在 schema 里就编译不过）。

| # | Task | 内容 | 依赖 | 提交后自检 |
|---|---|---|---|---|
| 1 | **schema + 迁移** | 4 个新枚举 + `PayoutOperationAction` 加 2 值 + `payouts` 加 `releasedEntryIds` + `payout_operations` 加 `reconciliationId` + 2 张新表 + 手写迁移 + 裸 delegate + `tenant-models.ts` 的警告说明 | — | `npx prisma migrate deploy` 通过；`npx tsc --noEmit` 通过；全量单测通过 |
| 2 | **渠道接口扩展** | `PayoutQuery` / `ChannelPayoutRecord` 类型；`queryPayout` 改签名；`PayoutProvider.listPayouts`；假网关实现（双索引 + `executedAt` + 如实返回）；`payout-worker.spec.ts` 的 mock 跟着改 | — | 单测通过；假网关的 `queryPayout` / `listPayouts` 有单测 |
| 3 | **前置修复** | ① `markFailed` 存 `providerTxnId`；② `markFailed` 释放明细时**同事务**记 `releasedEntryIds`；③ `PayoutService.unstick(to='FAILED')` 同样记；④ `markPaid` 清 `failedAt` / `failedBeforePayout`；⑤ worker 的 2 个调用点传交易号（**`handleFailure` 要多收一个 `providerTxnId` 参数**）；⑥ 假网关存真实结果 | 1, 2 | 单测 + `payout-execution.e2e-spec.ts` 通过；新加的断言：失败后 `payouts.payoutTxnId` 有值、`releasedEntryIds` 有值 |
| 4 | **比对引擎** | 纯函数（契约见 §四·4.5）：归组 + 差异分类 A–F + 时间窗两侧并集 + 匹配键 + 时钟偏移处理 | 2 | 引擎单测全绿；**变异验证**：把某档判定改错 → 对应用例必须报警 |
| 5 | **核实服务** | `common/payment/payout-verification.ts` 契约 + payment 的 `PayoutVerificationService`（三层核实）+ token 注册 + billing 侧注入 | 1, 2 | 核实服务单测：三档结论（PAID / FAILED / UNKNOWN）各一条 |
| 6 | **差异处置** | **A 类**：`PROCESSING → PAID`（复用 `markPaid`，`paidAt` 用数据库时钟）+ `RECONCILE_TO_PAID` 留痕 + `markPaid` 返回 false 时补日志。<br>**B 类**：`FAILED → PAID` + 四道闸 + `MANUAL_CONFIRM_PAID` 留痕 + 结算单联动 | 1, 3, 4, 5 | e2e：A 类自动纠正后状态与留痕都对；B 类四道闸逐条能挡住 |
| 7 | **解卡重打前置闸** | 三层核实放进 `PayoutService.unstick` 入口（罩住两个分支） | 5 | e2e：渠道说 SUCCESS 时解卡被拒；渠道说 FAILED 时放行；问不出结论时拒绝 |
| 8 | **对账服务 + API + 定时任务** | `PayoutReconciliationService`（payment）：查本地单 + 拉渠道流水 + 调引擎 + 落差异项 + 去重；手动触发端点；差异处置端点；`PayoutReconcileScheduler`（`PAYOUT_QUEUE` 的 `'reconcile'` job，`isFakePayoutEnabled()` 为 false 时不注册） | 1, 4, 5, 6, 7 | e2e：造出 A/B/C/D/E/F 六种差异，断言分类与处置都对 |
| 9 | **CSV 账单导入** | multipart 基建 + CSV 解析 + 列映射 + 导入端点 | 8 | e2e：上传一份 CSV → 断言解析出的记录与差异 |
| 10 | **平台端界面** | 对账页 + 差异处置 + E/F 类预警横幅 + 详情页留痕展示 + 导航 | 8, 9 | 浏览器手测（见 Task 11 的环境说明） |
| 11 | **验收** | e2e + 失败注入 + 浏览器手测 + 验收记录 | 全部 | 全量测试通过 |

### 9.1 Task 9 的技术选型（本仓首次引入，先定好）

```
① 依赖
   npm i papaparse            （CSV 解析；或 csv-parse，二选一）
   npm i -D @types/multer      （multer 只是 @nestjs/platform-express 的传递依赖，没有类型）
② 后端
   MulterModule.register({ limits: { fileSize: 5 * 1024 * 1024 } })
   @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
   @UploadedFile() file: Express.Multer.File
   列映射走独立的 @Body() DTO（全局 ValidationPipe 对 multipart 的 body 部分同样生效）
   ⚠️ 全局 ValidationPipe 是 { whitelist: true, forbidNonWhitelisted: true }
      → 列映射 DTO 的字段不能多写，多写直接 400
③ 行数上限 10000：解析后检查，超限 → 409（不是静默截断）
④ 前端
   ⚠️ apiFetch 硬编码 'content-type': 'application/json' 且 JSON.stringify(body)
      → **multipart 不能走 apiFetch**，要另写一条裸 fetch（不设 content-type，
        让浏览器自动带 boundary）
⑤ e2e
   supertest 的 .attach('file', Buffer.from(csvText), 'bill.csv')
   .field('columnMapping', JSON.stringify({...}))
   ⚠️ api/test/ 下零个 .attach / FormData 用例 → 这是本仓第一个 multipart e2e
```

### 9.2 Task 11 的 e2e 造数路线与手测环境

**e2e 的造数路线**：

⚠️ **对账 e2e 不能照抄 5l 的「暂停队列」** ——
5l 的 `payout-ops.e2e-spec.ts:183` 暂停队列是因为重试会把单放回 `APPROVED` 重新入队，
worker 抢跑会造成竞态。对账 e2e 需要**渠道侧真的有流水**。

→ **路线：队列继续暂停，e2e 直接调 provider 造渠道流水。**

- e2e 通过 `app.get(FakePayoutProvider)` 拿到实例（**需要把 `FakePayoutProvider` 从 payment 模块 export**，
  当前 `payment.module.ts:113` 只导出 3 个 service），直接调
  `execute({ referenceNo: payout.payoutNo, ... })` → 假网关的记录表里就有了这条流水
- ⚠️ **`referenceNo` 必须传本地单的 `payoutNo`** → 匹配得上 → 能造出 A/B/C 类
- 造 E 类：本地单手工置为 `PAID`，渠道侧不放记录 → `listPayouts` 查不到它
- 造 D 类：只调 `execute` 不建本地单

⚠️ **e2e 里假出款网关是开着的** —— `api/test/setup.ts:18` 有
`process.env.FAKE_PAYOUT_ENABLED = 'true'`（5h-2 加的），每个测试文件的进程都会跑 ✅

**手测环境**：

⚠️ **compose 的 api 跑在 `NODE_ENV: production`**（`infra/docker-compose.yml:100`）→
① 假网关默认不可用（没设 `FAKE_PAYOUT_ENABLED`）
② 即使设了，`assertSecureConfig` 也会**拒绝启动**
（`api/src/common/config/assert-secure-config.ts:45-52`）

→ **手测对账必须用开发模式跑 api**：`NODE_ENV=development` + `FAKE_PAYOUT_ENABLED=true`。
做法与 5h-2 的验收记录一致：**临时改 `infra/docker-compose.yml`，手测完 `git checkout --` 还原**。

⚠️ **不要把 `FAKE_PAYOUT_ENABLED=true` 写进 compose 主文件** —— 那是 production 环境，
护栏 X11 就是为拦它。

⚠️ **好消息：当前 compose 是单进程**（一个 `api` 服务，`CMD ["node", "dist/main.js"]`）→
api 与 worker 同进程 → §二·2.3 的「多进程不可信」限制**当前不触发**。

## 十、风险与遗留

### 10.1 本阶段引入的

| # | 风险 | 说明 | 缓解 |
|---|------|------|------|
| 1 | **假网关的账单形态是我们自己定的** | 没有真渠道 → 对账的「渠道侧数据形态」由我们自己设计 → 存在「照着自己设计自己」的风险 | 接口形状按「真渠道会怎么给」设计（时间窗 + 业务单号）；⚠️ **但「不引入分页」与 §7.1 的「10000 条上限」冲突** —— 真渠道单窗口超 10000 条时对账整体失败 → **真渠道接入前必须补分页或分片拉取**（记入 §10.3） |
| 2 | **A 类自动纠正会改钱的状态** | 渠道说 SUCCESS 就把本地改成 PAID —— 若渠道的账单本身有误呢 | 只在「渠道 SUCCESS + 本地 PROCESSING」时触发（本地状态本来就不对）；写 `payout_operations` 留痕 + 关联对账任务，事后可查可追 |
| 3 | **解卡功能变严** | 渠道不支持按单号查询 + 无对账记录 → 解卡被拒 | 有意为之。解卡是「解卡」不是「打款」，被拒后运营仍可走「重试」等其它路径 |
| 4 | **E / F 类可能长期挂着** | 渠道账单延迟 → 误报 → 运营反复处理 | 差异项可标 `IGNORED`；**新一次对账会把旧的 PENDING 项标 IGNORED**（§三·3.4）→ 未处置数不单调增长 |
| 5 | **CSV 解析是攻击面** | 超管上传的文件被解析 | 限大小（5MB / 10000 行）；只取白名单列；不做公式展开等富文本特性；列映射逐项校验 |
| 6 | **对账任务会重复跑** | 手动 + 定时都触发 | 定时任务自己检查「同窗口已有 COMPLETED 任务则跳过」；手动重跑是有意行为，不拦 |
| 7 | **多进程部署下假网关的对账结果是垃圾** | `listPayouts` 读进程内 Map；api 与 worker 不同进程时渠道流水是空的 → 所有 `PAID` 单都变 E 类 | e2e 保持同进程（现状满足 ✅）；⚠️ **当前 compose 是单进程，尚未触发**（`CMD ["node", "dist/main.js"]`，worker 在 Nest 进程内）→ 限制针对的是「将来把 worker 拆成独立服务」之后 |
| 8 | **B 类依赖 `releasedEntryIds`，存量单没有** | 5m 之前就 FAILED 的单无法复原明细 → B 类的人工处置对它们不可用 | 落人工待处理项并注明「明细无法复原，需人工处理」，**不猜** |
| 9 | **CSV 导入是本仓首次引入 multipart 与文件解析** | `api/src/` 下 `multipart` / `FileInterceptor` / `UploadedFile` / `MulterModule` **零结果**；`@types/multer` 不在 devDependencies；无 CSV 解析库；`api/test/` 下零个 multipart 用例 | 选型与样板见 §九·9.1；文件大小上限 5MB / 行数上限 10000；只取白名单列；不做公式展开等富文本特性 |

### 10.2 本阶段解决的

| # | 遗留 | 状态 |
|---|------|------|
| 1 | **L43 渠道对账** | ✅ 本阶段解决 |
| 2 | 5l 遗留 1：人工重试可能重复打款 | ✅ **部分解决** —— 解卡前有渠道核实闸；仍不能完全消除（运营可以无视提示） |
| 3 | 5l 的「解卡重打」与对账的竞态 | ✅ 本阶段解决（§六） |
| 4 | 「渠道说钱打了但本地记失败」无路可走 | ✅ 本阶段解决（B 类人工处置路径） |
| 5 | 5l 遗留「`FAILED` 承载两种语义」 | ⚠️ **部分解决** —— 渠道明确拒付的单仍落 `failedBeforePayout=false` → 不能一键重试（§1.3 明确不做） |

### 10.3 仍未处理的

| # | 事项 | 说明 |
|---|------|------|
| 1 | **L31 漏结流水无主动告警** | 本阶段是「出款侧」的对账，5j 的「缺笔」是「账务侧」的 → 两者未打通 |
| 2 | **L33 出款单作废重开** | `APPROVED` 后金额要改的场景（补差单只做加法） |
| 3 | **R7 跨期调账 + L54 逐笔结佣** | 等产品决策 |
| 4 | **5k 遗留 4：解密根因只进日志** | 平台端仍看不到「是没迁移 / 是密钥错了 / 是版本不匹配」 |
| 5 | **对账与账目口径未打通** | 对账只改 `payouts` 状态；结算单 / 流水的修正仍是另一件事 |
| 6 | **`prisma migrate dev` 仍不可用** | 历史迁移 checksum 不符；本阶段照旧手写 SQL |
| 7 | **渠道接口无分页** | 与 §7.1 的 10000 条上限冲突 → 真渠道接入前必须补分页或分片拉取 |
| 8 | **「渠道长期不返回终态」的单发现不了** | 归组时非终态一律不算差异（§四·4.4 的 g 档）→ 强行分类会产生高频误报 |
| 9 | **5l 的 `retry` 仍用「重算」而非 `releasedEntryIds`** | 两者口径不同：`retry` 的语义是「重新打」→ 要的是「当前应纳入的集合」；B 类是「确认已打了」→ 要的是「当初那批」。**本阶段不动 `retry`**（外科手术式改动） |
| 10 | **让「渠道明确拒付」的单可安全重试** | 需要给 `PayoutExecuteResult` 加「渠道明确拒付」标记并让 `handleFailure` 据此传 `failedBeforePayout: true` —— 改的是 5h-2 的 worker 语义，属相邻改进 |
| 11 | **对账只覆盖出款侧** | 结算单 / 抽佣流水 / 商家对账单的「缺笔」不在本阶段 |

---

## 十一、审查记录

### 11.1 独立审查（对照源码逐条核实）

> 本设计经**独立审查代理**对照源码逐条核实（30 处源码事实 + 7 组逻辑推演），
> 抓出 **7 处必须改的设计缺口**。逐条记录如下（设计已按此修正）。

| # | 审查指出的问题 | 修正 |
|---|---------------|------|
| 1 | **`markFailed` 不写 `payoutTxnId`** → 「实时核实」对 `FAILED` 的单**无从谈起** | §2.4：`MarkFailedInput` 加 `providerTxnId?`；worker 的 5 个调用点里只有 2 个该传 |
| 2 | **假网关的 `queryPayout` 恒返回 `SUCCESS`** → 拿它当核实闸会让**解卡重打功能全废** | §2.3：假网关存真实结果并如实返回 |
| 3 | **B 类若直接改 `PAID` 而不恢复明细** → 流水在出款维度上**凭空消失**（商家少拿、账上无出款记录） | §5.2：改用「转 PAID 会占位 + 部分唯一索引挡住重复付款」的准确推导；B 类必须复原明细 |
| 4 | **B 类用「重算」复原明细对补差单失真**（`computeSupplementAmounts` 依赖已被释放的 `payout_entries`） | §3.2：新增 `releasedEntryIds` 列，**释放明细时记下 id** → NORMAL / SUPPLEMENT 都能精确复原 |
| 5 | **解卡核实闸对 `PROCESSING` 单是死代码**（该单没有 `payoutTxnId`，而它是 `markPaid` 的唯一写入点）→ 核实闸永远 fail-closed → **解卡功能 100% 不可用** | §2.1 / §6.3：`queryPayout` 的入参改成对象并**支持 `referenceNo`**（`payoutNo` 是打款时传给渠道的，渠道侧有条件支持） |
| 6 | **同一单多渠道流水（渠道重试）没有处理** → `matchedCount` 口径不明、假网关失败记录要不要进结果集未定 | §二·2.2：先归组再取权威记录（优先 SUCCESS）；假网关**必须**把失败那次也记进 `listPayouts` |
| 7 | **假网关未启用时定时任务会每天失败**（生产环境 `assertSecureConfig` 拒绝启用假网关） | §7.3：注册前判断 `isFakePayoutEnabled()`，为 false 就不注册 `'reconcile'` 周期任务 |

另采纳 10 条「建议改」：`markPaid` 清 `failedAt` / `failedBeforePayout`（§2.5）、
`paidAt` 统一用数据库时钟（§5.1，消除两套时钟口径）、
`payoutTxnId` 无唯一约束时的多命中处理（§2.2）、
枚举注释补 F（§3.1）、闸 ③ 显式带租户条件（§5.2）、
闸 ④ 加结算单状态检查（§5.2）、±15 小时的窗口余量（§4.2）、
PENDING 差异去重（§3.4）、新表的作用域警告（§3.3/§3.4）、
`ADD VALUE IF NOT EXISTS`（§3.6）、多进程下假网关不可信（§二·2.3）。

### 11.2 第二轮审查（任务依赖 / 模块边界 / 可测性）

> 第一轮修完后再审一轮，**不复审第一轮已覆盖的事实**，聚焦三件第一轮没查的：
> 修正本身是否自洽、**§九 Task 分解的依赖顺序**、**e2e 与手测能不能真跑起来**。
> 抓出 **14 处必须改**，其中 3 处是结构性的。

| # | 审查指出的问题 | 修正 |
|---|---------------|------|
| 1 | **§九 Task 顺序不可行** —— Task 1 要写 `releasedEntryIds`，但这一列是 Task 3 才建的 → Prisma 字段不存在 → **第一个提交就编译不过** | §九 重排：**schema + 迁移排第一**（Task 1），并给每个 Task 加「依赖」与「提交后自检」两列（§九） |
| 2 | **§6.4 的解卡闸在 `PayoutService.unstick`（billing）里，但 billing 拿不到 `PayoutProvider`**，且 `billing.module.ts:56-60` 明写 billing 绝对不能 import payment（会成环） | §六·6.4 + **新增 §七·7.5**：契约下沉到 `common/payment/payout-verification.ts`，实现放 payment，billing 按 token 注入；**核实服务、对账服务、对账端点、定时任务全部放 payment** |
| 3 | **§七 没点名「对账服务」放哪个模块** —— 它跨了 billing 与 payment 的边界 | §七·7.5 的组件归属表逐个点名；确认 `PayoutExecutionService` 已从 billing 导出，**不需要**额外导出 `PayoutService` |
| 4 | **§5.2 的结算单联动没有 `statementId` 为 null 的分支**（零额抽佣商家该期没有结算单，是常态） | §五·5.2 闸 ④ 补一档「`statementId` 为 null → 跳过联动，不算异常」；流程步骤 3 加注 |
| 5 | **CSV 导入是本仓首次引入 multipart**：无 `FileInterceptor` 基建、`@types/multer` 缺失、无 CSV 解析库、无 multipart 测试样板 | §九 新增 §九·9.1 写死技术选型与样板；§十·10.1 补风险第 9 条 |
| 6 | **§九 没有「依赖」列** → Task 6/7 的前置产出容易漏 | §九 的表加「依赖」列 |
| 7 | **§6.3 的「本地是 FAILED」分支在解卡语境里不可达**（`unstick` 入口已挡非 `PROCESSING`） | §六·6.3 删掉该分支并注明原因；B 类的入口只在 §五·5.2 的独立端点 |
| 8 | **`:281` 那个 `markFailed` 调用点拿不到 `providerTxnId`** —— `handleFailure` 的入参里没有 `result` | §九 Task 3 补「`handleFailure` 要多收一个 `providerTxnId` 参数」 |
| 9 | **§九 Task 4「纯函数」没定义入参出参，也没说谁组装两个集合** | §四 新增 §四·4.5 的契约（`ReconcileInput` / `ReconcileOutput`），并写明组装职责在对账服务 |
| 10 | **§2.3/§七 没说假网关的 `listPayouts` 要补时间字段**（`execute` 现在不记任何时刻） | §二·2.3 补 `executedAt`，并说明用 `new Date()` 而非数据库时钟的理由 |
| 11 | **闸 ② 的「金额之和」没说是带符号**（`merchant_receipts.amount` 是带符号的，`SALE_REVERSAL` 为负） | §五·5.2 闸 ② 补「**带符号**」三字，避免实施时用 `Math.abs` |
| 12 | **手动端点的 409 文案「该渠道不支持批量查单」误导**（实际是本地假网关没开） | §七·7.3 改成「该渠道当前不可用（本地假出款网关未启用），无法执行渠道对账」，并要求两处用同一常量 |
| 13 | **对账 e2e 不能照抄 5l 的「暂停队列」** —— 需要渠道侧真有流水 | §九·9.2 给出路线：队列继续暂停，e2e 直接调 `provider.execute({ referenceNo: payout.payoutNo })` 造流水；并指出需把 `FakePayoutProvider` 从 payment 模块 export |
| 14 | **手测环境三重障碍**（compose 跑 `NODE_ENV=production` + 假网关默认关 + `assertSecureConfig` 拦人） | §九·9.2 写明手测必须用开发模式跑 api，临时改 compose 后还原；并澄清**当前 compose 是单进程**，§二·2.3 的多进程限制当前不触发 |

另采纳 3 条建议：核实逻辑**一处实现两处引用**（§六·6.3 明确落点）、
手动触发端点**不查幂等**（§七·7.4）、同步对账加 30 秒执行超时 + 前端 loading 态（§七·7.1）。

### 11.3 驳回的建议

| # | 建议 | 驳回理由 |
|---|------|---------|
| 1 | 给 `PayoutExecuteResult` 加「渠道明确拒付」标记，让 `handleFailure` 传 `failedBeforePayout: true` | 这是**改 5h-2 的 worker 语义**，属相邻改进，与本阶段的核心（对账）无关 → 记为遗留（§1.3 / §10.3 第 10 条）。核实闸区分「渠道说失败」与「没问出结果」靠的是 `queryPayout` 的返回状态，不依赖这个标记 |
| 2 | 「渠道长期非终态 + 本地已 PAID」单列一类 | 渠道流水状态非终态时无法区分「还在处理」与「卡住了」→ 强行分类会产生**高频误报** → 记为遗留（§10.3 第 8 条）更诚实 |
| 3 | （第二轮）「把核实闸下沉到 payment 模块的 `PayoutVerificationService`，由 `PayoutService.unstick` 注入它」 | ⚠️ **这条建议本身是错的** —— billing 注入 payment 的服务 = `billing → payment` = 与它自己引用的 `billing.module.ts:56-60` 冲突，还是环。**契约下沉到 `common/` 才是正解**（§六·6.4 / §七·7.5） |

### 11.4 自审修正记录

> 初稿写完后的自查（占位符 / 内部矛盾 / 歧义），改了 5 处：

| # | 问题 | 修正 |
|---|------|------|
| 1 | 差异分类只列了 A–E，漏了「**渠道拒付、本地记已付**」这一形态 | 补 **F 类** `STATUS_MISMATCH`，并进枚举、分类表、比对算法、待处理表 |
| 2 | 写「worker 的 3 个失败调用点都要传交易号」 | 实际是 **5 个调用点，且只有 2 个**该传（`:252` / `:281`）—— 前三个渠道压根没被调用，传假值会污染核实判断 |
| 3 | 比对算法的「其它组合」一档含糊（写「匹配或忽略」） | 拆成 f / g 两档写死，并补判据：「**只有双方都声称终态且互相矛盾才是差异**」 |
| 4 | 时间窗跨度写成「如 31 天」 | 定死 **31 天**，并补渠道记录数上限 **10000 条**，且规定超限要落 `FAILED` 而非静默截断 |
| 5 | B 类转 `PAID` 没提数据库唯一索引的兜底 | 补：撞 P2002 要翻成业务错误，不能冒成 500 |
