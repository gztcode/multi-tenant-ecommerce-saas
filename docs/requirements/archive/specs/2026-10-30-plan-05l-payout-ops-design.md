# 阶段 5l「出款运维兜底」设计

> **前置**：阶段 5k（资金链路收尾）已完成并合并（PR #20）。
> 本阶段把「钱出问题时运营只能改数据库」这件事变成**界面上的几个按钮**。

---

## 一、背景与目标

### 1.1 这一阶段要解决什么

到 5k 为止，出款链路的**自动**部分已经很完整（审批 → 入队 → 打款 → 重试 → 兜底扫描）。但**人工介入的部分是空白**：

| 现状 | 后果 |
|------|------|
| 卡在 `PROCESSING` 的单**没有任何接口能改状态** | 只能人工直接改库。`platform-payout.controller.ts` 只有 list / detail / approve / reject 四个端点。⚠️ 列表页**已经把这类单标红了**（前端按 `processingAt` 判定）—— 运营看得到，但**处理不了** |
| `FAILED` 的单**没有重试入口** | 渠道恢复后、密钥修好后，商家必须**全部重新申请** |
| `attemptCount` **不能重置** | 试满 3 次的单永远凑不齐预算 |
| 渠道的原始错误（可能是「Redis 连不上」「本地假出款网关未启用」）**原样透到商家屏幕** | 商家看到内部术语，而平台端的排查线索与商家看到的是同一份 |
| 出款列表**没有分页控件** | 两端都显式请求 `pageSize=100`（后端 `MAX_PAGE_SIZE` 就是 100）→ **第 101 张之后永远看不到**，而页面上写着「共 N 张（本页显示 M 张）」 |

### 1.2 为什么现在做

5k 修好了「解密失败 → 无限重试」这条**自动**链路，但它同时暴露了人工处置的空白：
5k 留下的第一条遗留就是「**崩溃窗口，且没有自助处置入口**」—— 单子卡在 `PROCESSING` 时，
运营**只能人工改库**。而 5k 也明确「**不做批量恢复已 `FAILED` 的出款单**」，
于是「渠道恢复后怎么办」这个问题至今无解。

资金链路的其余部分（结算单、对账单、报表）都已收口，**出款是最后一环**。

### 1.3 这一阶段明确不做的

| 不做 | 理由 |
|------|------|
| **商家自助发起重试** | 商家**不知道钱是否已经打出去**（渠道超时/网络中断时钱可能已到账）→ 自助重试 = **重复打款**。重复打款不可逆，只能由平台在核对渠道后操作 |
| **新增出款单状态** | 5k 刚定下「不加状态」的决策（加状态要动 Prisma 枚举 + 部分唯一索引的 `WHERE` + 两端文案 + 全部 `notIn` 排除列表）。本阶段用一个**布尔列**表达「确定没打」，代价小得多 |
| **告警通道**（Prometheus / Sentry / 邮件） | 本仓没有监控基础设施接入点。本阶段的替代方案是「运营能自己看见并处理」—— 平台端出款列表**已经**把卡住的单标红了（前端按 `processingAt` 判定），缺的只是「处理」那一半 |
| **渠道对账**（L43） | 依赖真实渠道的流水形态。`PayoutProvider` 目前只有单笔 `queryPayout` |
| **结算单明细的「后端零改动式」分页** | 详情接口目前**无上限全量返回** entries。为它做分页必须改响应结构 → 改为**新增独立分页端点**（见 §五·5.3） |
| **跨期调账**（R7）与 **L54 逐笔结佣** | 5j/5k 都明确排除 —— 前提是「跨期退款归属哪一期」这个**产品决策** |

---

## 二、数据模型改动

### 2.1 `payouts` 加一列

```prisma
/// 这次失败发生在**打款之前** —— 钱确定没打出去。
///
/// ⚠️ **true = 可安全重试**（渠道从未被调用）；
///    **false = 钱可能已经打出去**（渠道调过了，只是没成功回包）
///    —— 这种情况**只能人工核对渠道**，不能重试。
///
/// ⚠️ **不能靠 `failureReason` 的文案推断** —— 文案会被改、
///    会被手工编辑。判断依据必须是**打款动作有没有发生**。
failedBeforePayout Boolean @default(false)
```

**它的依据是代码结构自带的**（实测核对过 `payout.worker.ts` 的全部 5 个 `markFailed` 调用点）：

| # | 调用点 | 相对 `provider.execute` | 钱打出去没 | `failedBeforePayout` |
|---|--------|------------------------|-----------|---------------------|
| 1 | `:133` 解密失败（`accountError` 分支） | **之前** | 确定没打 | `true` |
| 2 | `:144` 打款前的两道闸（金额 ≤ 0 / 账户缺失） | **之前** | 确定没打 | `true` |
| 3 | `:157` 没有可用的出款渠道 | **之前** | 确定没打 | `true` |
| 4 | `:246` 渠道金额核对不通过 | **之后** | **可能已打**（渠道说成功了但金额不对） | `false` |
| 5 | `:273` 渠道失败且试满上限 | **之后** | **可能已打**（超时/网络中断 → 请求可能已发出） | `false` |
| 6 | **人工解卡转失败**（阶段 5l 新增） | 不适用 | 运营认定「没打出去」 | `true` |

⚠️ **第 6 行是人工判断**，不是代码推导 —— 运营点「解卡转失败」等于断言「渠道没打出去」。
所以它的**必填原因**就是这句断言的留痕（§二·2.2 的 `payout_operations.reason`）。

> ⚠️ **1/2/3 都在「调渠道之前」** → 渠道**从未被调用** → **确定没打钱** → 落 `FAILED` 安全。
> 这与 5k 的论证是同一条（解密/闸在调渠道之前），本阶段只是把它**记进数据**。

### 2.2 新增 `payout_operations` 表（人工操作留痕）

```prisma
/// 出款单的人工操作留痕（阶段 5l）。
///
/// ⚠️ **涉及钱的操作必须能追溯** —— 「谁在什么时候把哪张单重打了」
///    是运营出问题时第一个要回答的问题。
///    只在 `payouts` 上记「最近一次」会丢掉反复解卡的历史。
model PayoutOperation {
  id String @id @default(uuid())
  /// 出款单 id
  payoutId String
  /// 操作类型
  action PayoutOperationAction
  /// 操作人（平台超管的用户 id）
  operatorId String
  /// 操作时刻
  operatedAt DateTime @default(now())
  /// 操作原因（**必填** —— 涉及钱的操作不能没有理由）
  reason String
  /// 操作前的状态（留痕要能看出「从哪来」）
  fromStatus PayoutStatus
  /// 操作后的状态
  toStatus PayoutStatus
  /// 操作前的尝试次数（留痕要能看出「重试了几次」），
  /// nullable = 操作前没有这个字段的语义（如「解卡前 attemptCount=1」也是有的，
  /// 这里保留原样即可）
  attemptCountBefore Int?
  createdAt DateTime @default(now())

  @@index([payoutId, operatedAt])
  @@index([operatorId])
  @@map("payout_operations")

  /// 所属出款单（与 `payout_entries` 同款：`onDelete: Cascade` —— 出款单被删则留痕跟着删；
  /// 实际上出款单**没有删除接口**（只有 `CANCELLED` 状态），所以这条几乎不会触发）
  payout Payout @relation(fields: [payoutId], references: [id], onDelete: Cascade)
}

/// 出款单的人工操作类型
enum PayoutOperationAction {
  /// 重试：FAILED → APPROVED（确定没打，安全重打）
  RETRY
  /// 解卡转失败：PROCESSING → FAILED（认定没打，结束这件事）
  UNSTUCK_TO_FAILED
  /// 解卡重打：PROCESSING → APPROVED（⚠️ 可能重复打款）
  UNSTUCK_TO_APPROVED
}
```

⚠️ **`payout_operations` 不在租户白名单里** —— 它**没有 `tenantId` 字段**
（与 `settlement_statement_entries` / `payout_entries` 同款：租户从出款单反查）。
理由：它只在**平台作用域**下读写（只有平台超管能操作），加 `tenantId` 反而要维护两份真相。

⚠️ **要在 `api/src/common/tenant/tenant-models.ts` 的「刻意排除」注释区补一段** ——
那个文件里每个被排除的模型都有一段说明（`PayoutEntry` / `SettlementStatementEntry` /
`Plan` / `PaymentWebhookEvent`），**是本仓的既定惯例**，漏了会被下一个人「顺手登记进去」
→ 那会让扩展给它附加 tenantId 条件，而它**没有 `tenantId` 列** → Prisma 直接报错。

⚠️ **它不受作用域约束 → 任何忘了带 `payoutId` 的查询都会返回全平台数据**。
`payout_operations` 里 `reason` 是**运营手写的自由文本** → 不受任何脱敏约束 →
⚠️ **界面上要提示运营「不要写密钥、账号之类的信息」**（或后端对 `reason` 做长度与
敏感词的兜底截断）。

⚠️ **它是 append-only** —— 只插入，永不更新删除（与 `commission_entries` 同款）。

### 2.3 迁移

⚠️ **本仓 `prisma migrate dev` 不可用** —— 实测有 **3 条**历史迁移的 checksum 与文件不符
（`20261021062421_drop_user_tenant_email_unique`、`20261022100000_add_catalog_tables`、
`20261028190000_add_settlement_statements`），`migrate dev` 会要求 `migrate reset`（**会清库**，
本项目明令禁用）。

→ **手写 SQL + `prisma migrate resolve --applied`**（与 5e / 5j 同款做法）：

```sql
-- 1) 枚举（**必须先建枚举再建表** —— PostgreSQL 的顺序要求）
CREATE TYPE "PayoutOperationAction" AS ENUM ('RETRY', 'UNSTUCK_TO_FAILED', 'UNSTUCK_TO_APPROVED');

-- 2) payouts 加列
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failedBeforePayout" BOOLEAN NOT NULL DEFAULT false;

-- 3) 新表
CREATE TABLE IF NOT EXISTS "payout_operations" (
  "id" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "action" "PayoutOperationAction" NOT NULL,
  "operatorId" TEXT NOT NULL,
  "operatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  "fromStatus" "PayoutStatus" NOT NULL,
  "toStatus" "PayoutStatus" NOT NULL,
  "attemptCountBefore" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_operations_payoutId_fkey" FOREIGN KEY ("payoutId")
    REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "payout_operations_payoutId_operatedAt_idx" ON "payout_operations" ("payoutId", "operatedAt");
CREATE INDEX IF NOT EXISTS "payout_operations_operatorId_idx" ON "payout_operations" ("operatorId");
```

⚠️ **schema 里 `Payout` 模型要加反向关系字段**（Prisma 的双向关系两端都要声明）：

```prisma
model Payout {
  // …现有字段…
  /// 人工操作留痕（阶段 5l）
  operations PayoutOperation[]
}
```

⚠️ **历史行的 `failedBeforePayout` 怎么定**：
- 默认 `false`（保守 —— **宁可不给重试，也不能误重试**）
- **例外**：5k 才引入的业务口径在 **5k 之前不存在**（`git log -S` 实测确认：
  两句都只在 5k 的 commit `1bf0291` 首次出现，5k 之前 worker 写的是
  `'收款账户快照缺失'` 与 `'出款金额非法：${n} 分'`）→ 所以**精确等于**它们的行
  必然来自 5k 的「打款前」路径 → 可以安全置 `true`。
  迁移 SQL 里做**精确匹配**（`=`），**不做模糊包含**。

⚠️ **5k 的「打款前」路径有两句文案，都要考虑**（`checkGates` 的两条闸）：

| 文案 | 来源 | 置 `true` 吗 |
|------|------|------------|
| `收款账号信息异常，本次未打款，请更新收款账户后重新申请` | `accountError` 分支 **或**「账户缺失」闸 | ✅ **置 true** —— 确定没打，且**重新纳入后大概率能成** |
| `出款金额异常，本次未打款，请联系平台核对` | 「金额 ≤ 0」闸 | ❌ **保持 false** —— 金额非法是**脏数据**，重算大概率仍 ≤ 0 → 重试会在第 4 步被 409 挡住。置 `true` 只会让按钮出现后再被拒，**体验更差** |

```sql
UPDATE "payouts"
   SET "failedBeforePayout" = true
 WHERE "status" = 'FAILED'
   AND "failureReason" = '收款账号信息异常，本次未打款，请更新收款账户后重新申请';
```

⚠️ **为什么不按文案推断更多**：文案会被改、会被手工编辑、会被未来版本换掉。
这条精确匹配之所以安全，**只因为那句文案是 5k 引入的**（5k 之前不存在）——
这个前提一旦不成立，这条 SQL 就必须撤掉。
⚠️ 渠道失败落的老单（原文形态，`failureReason` 是渠道的报错）→ 一律 `false` ✓
（渠道失败是「可能已打」，本来就不该重试）

---

## 三、出款单的人工处置（后端）

### 3.1 三个操作与它们的护栏

全部在**平台作用域**下执行（`platformScope()`），只有**平台超管**能调。

| 操作 | 前置条件 | 状态流转 | 风险 |
|------|---------|---------|------|
| **A 重试** | `status = FAILED` **且** `failedBeforePayout = true` | → `APPROVED` | 无（确定没打） |
| **B 解卡转失败** | `status = PROCESSING` | → `FAILED` | 无（不再打款） |
| **C 解卡重打** | `status = PROCESSING` | → `APPROVED` | ⚠️ **可能重复打款** |

⚠️ **A 的前置条件是硬闸**：按钮只对 `failedBeforePayout = true` 的单出现，
服务端**也必须再查一次**（不靠前端传参）。`failedBeforePayout = false` 的单
（钱可能已打出去）**不给重试** —— 只能人工核对渠道。

⚠️ **B 与 C 的区别就是「钱到底打出去没有」**，而**运营判断不了**（他看不到渠道）→
→ 所以 C 的界面必须**明确警示**，且**必填原因**（写清「已核对渠道，确认未打款」之类）。

### 3.2 操作 A：重试（`FAILED` → `APPROVED`）

⚠️⚠️ **这一条不是「改个状态」那么简单** —— `markFailed` 在落 `FAILED` 时
**释放了明细占用**（`tx.payoutEntry.deleteMany({ where: { payoutId } })`）。
而 `payout_entries` 不只是「占用标记」，它**同时是「这张单要打哪些流水」的凭证**。
→ 一张 `FAILED` 的单，它的 `payout_entries` **是空的** → 直接转回 `APPROVED`，
**它要打的那些流水已经不在它的明细里** → 账实不符。

→ **重试必须重新纳入流水**（复用 `approve` 的那套：重算 + 同步明细）。

```
1. 查单（平台作用域）
2. 断言 status = FAILED 且 failedBeforePayout = true     ← 硬闸
3. ⚠️ 查该期有没有**别的**活跃出款单
   → 口径见下方「⚠️⚠️ 第 3 步的口径」—— **不能直接用 findActivePayout**
   → 有 → 409，消息点名是哪一张（payoutNo）
4. ⚠️ **按 kind 分支重算金额 + 重新纳入流水**
   → 口径见下方「⚠️⚠️ 第 4 步的口径」
   → **重算出的金额 ≠ 锁定的 netAmount → 409 拒绝**
     （「该期金额已变化（¥X → ¥Y），请让商家重新申请」）
5. 事务里：
   - status → APPROVED
   - attemptCount → 0        ← 重置预算
   - failureReason → null
   - failedAt → null         ← 旧的失败时刻不该留在已恢复的单上
   - failedBeforePayout → false   ← 这一次的失败已经处理掉了
   - processingAt → null
   - approvedAt → **不动**   ← 它的语义是「审批时间」，刷新它会让界面显示假的
   - 同步明细（deleteMany + createMany）
   - 插入 payout_operations（RETRY）
6. 事务外：重新入队（jobId = payout-{id}-retry-{n}，n 见下方）
```

⚠️⚠️ **第 3 步的口径**（不能直接用 `findActivePayout`）：

`findActivePayout(periodStart, kind)`（`payout.service.ts:1123`）是
**private 且只在商家侧（租户作用域）调用**的 —— 它的注释明写「不手写 tenantId，
靠租户作用域扩展自动附加」。

⚠️ **重试是平台端操作，跑在 `platformScope()` 下** → 扩展**不附加** tenantId 条件
→ 直接用它会**跨租户匹配**（**所有租户的 `periodStart` 都是同一天**）→
别家租户的同周期单会被误判成「有活跃单」→ 409 误伤。

→ **重试要用一个自己的查询**，口径必须与部分唯一索引
`payouts_tenantId_period_kind_active_uniq`（`(tenantId, periodStart, kind)`，
`WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')`）**逐字一致**：

```ts
where: {
  tenantId: payout.tenantId,      // ← 必须显式带（平台作用域下扩展不附加）
  periodStart: payout.periodStart,
  kind: payout.kind,               // ← kind 是索引的一部分，必须带
  status: { notIn: [REJECTED, CANCELLED, FAILED] },
  id: { not: payout.id },          // ← 排除自己
}
```

⚠️ **`kind` 必须带**：索引是**三元组**，同期**不同 kind** 的单**不冲突**
（正常单与补差单可以同期各有一张）。不带 `kind` 会误伤。
⚠️ **`PAID` 落在「活跃」里**（`notIn` 里没有它）→ 同期已有 `PAID` 正常单的老单
重试会被 409 拦下 —— **这是正确的**：那一期已经结清，老单本就该作废。

⚠️ **第 3 步为什么必须有**：`FAILED` 不在部分唯一索引的 `WHERE` 里，
所以商家**可以**在老单 `FAILED` 之后对同期重新申请一张新单。
此时老单转回 `APPROVED` → **与新单撞唯一索引** → P2002 → 500。

⚠️⚠️ **第 4 步的口径 —— 必须按 `kind` 分支**：

现有代码里有两个**互斥**的口径（护栏 X13：补差单**绝不能**调 `computeAmounts`，
否则佣金被扣两遍）：

| kind | 用哪个 | 它算的范围 |
|------|--------|-----------|
| `NORMAL` | `computeAmounts` | **整期**的货款流水（`merchantReceipt` 按 `occurredAt` 落在周期内），**不排除**他单占用；佣金取该期**结算单**的 `netAmount` |
| `SUPPLEMENT` | `computeSupplementAmounts` | 「**本单已占 ∪ 未被其他单占用的**」；佣金**恒为 0** |

⚠️ **补差单重试时 `computeSupplementAmounts` 的「本单已占」那一半已经没了**
（`markFailed` 释放了）→ 实际算的是「该期**未被任何单占用**的流水」。
这**恰好是对的**：正常单 `PAID` 时占了整期流水，剩下未被占用的就是回填进来的那批
→ 补差单重试算出的正是它原来该打的那批 ✓
⚠️ 但若期间**又回填了新的流水** → 算出的金额与锁定值不同 → **409**（第 4 步拦下）✓

⚠️ **正常单重试用 `computeAmounts` 为什么安全**：正常单 `FAILED` 意味着它**没 `PAID`**，
而补差单的存在前提是「正常单已 `PAID`」→ **同期不可能有补差单**；
同期也不可能有别的活跃正常单（第 3 步已拦）→ `computeAmounts` 算出的整期流水
正是这张单该打的 ✓

⚠️ **第 4 步的「金额变了就拒绝」是刻意保守**：申请与失败之间可能发生退款冲回、
新流水回填 → 重算出的金额与审批时锁定的不一样。
**金额变了 = 事实变了**，应该让商家**重新申请**（走正常的审批流程），
而不是运营替他决定打多少。5h-1 的 P5 护栏（「审批时重算金额」）是同一个道理。

⚠️ **比的是 `netAmount`**（审批时锁定的那个），**不是 `requestedAmount`**
（申请时的预估）—— 审批本来就会把它改掉，拿它比会每次都 409。

⚠️ **金额是整数分**（`Payout.netAmount Int`、`MerchantReceipt.amount Int`，
求和是整数加法）→ `≠` 比较**没有浮点风险** ✓

⚠️ **第 6 步的 jobId 轮次来源**：用 **`payout_operations` 里该单 `action = RETRY`
的行数 + 1**（不是 `attemptCount` —— 它刚被重置成 0 了）。
`payout-{id}-retry-{n}` 与现有的三种命名（`-1`、`-{attempt}`、`-rescue-{n}`）
**不撞名**，且**永不复用**（第 2 次人工重试 → `retry-2`）。
⚠️ **绝不能复用 jobId**：BullMQ 里 failed job 的 hash 还在，
用**同一个 jobId** 重新入队会被**静默忽略**（不报错、不入队 → 重试从未发生）。

⚠️ **入队失败怎么办**：审批时的做法是「记 `failureReason` + 等兜底扫描救援」。
这里沿用同一套 —— 记 `failureReason: '打款任务提交失败，系统将自动重试'`（业务口径，
原始异常只进日志），单子停在 `APPROVED` 且 `attemptCount = 0`。
⚠️ **兜底扫描捞它的条件是「`approvedAt` 超阈值」** —— 而 `approvedAt` 是**原来审批时**
的时刻（可能很旧）→ 立即命中 ✓；若是刚审批的单，最多等 10 分钟。
（这一步的兜底是 `scanStuck` 的「`APPROVED` 救援」分支，与 5h-2 同款。）
⚠️ **救援 job 与重试 job 抢同一张单不会重复打款** —— `claimForExecution` 的
条件更新（`where: { id, status: APPROVED }`）保证只有一个赢，另一个静默返回。

### 3.3 操作 B / C：解除卡单（`PROCESSING` → …）

`PROCESSING` 的单**钱可能已经打出去**（5h-2 的 R3：绝不自动重试）。
但它会**永远卡着** —— 当前没有任何接口能改它，只能人工改库。

⚠️ **三个操作后的状态字段全表**（每一格写明「写 / 清 / 不动」）：

| 字段 | A：重试（`FAILED`→`APPROVED`） | B：解卡转失败（`PROCESSING`→`FAILED`） | C：解卡重打（`PROCESSING`→`APPROVED`） |
|------|------|------|------|
| `status` | → `APPROVED` | → `FAILED` | → `APPROVED` |
| `attemptCount` | → **0**（重置预算） | **不动**（保留它卡住时的计数，供排查） | → **0**（人工介入 = 全新预算） |
| `failureReason` | → `null` | → 业务口径 | **不动**（本来就是 null） |
| `failedAt` | → `null`（旧的失败时刻不该留在已恢复的单上） | → **写**（数据库时钟） | 不动 |
| `failedBeforePayout` | → `false`（这次的失败处理完了） | → **`true`**（运营认定「没打出去」） | 保持 `false` |
| `processingAt` | → `null` | → `null` | → `null` |
| `approvedAt` | **不动**（语义是「审批时间」，刷新它会让界面显示假的） | 不动 | **不动**（同上） |
| `approvedBy` | 不动 | 不动 | 不动 |
| 明细占用 | **重新纳入**（§三·3.2 第 4 步） | ✅ **释放**（`deleteMany`，与 `markFailed` 同款） | ❌ **绝不能释放** |
| `payout_operations` | 一行（`RETRY`） | 一行（`UNSTUCK_TO_FAILED`） | 一行（`UNSTUCK_TO_APPROVED`） |

⚠️ **B 的 `attemptCount` 不重置**：它保留「这张单卡住时试了几次」这个事实，
排查时要看。⚠️ **C 重置为 0**：人工介入 = 给一份全新的 3 次预算。

⚠️ **B 转 `FAILED` 后 `failedBeforePayout = true`** —— 运营既然认定「没打出去」，
这张单就应当**可以重试**（否则运营还得再点一次「转失败」，再点一次「重试」，很别扭）。

⚠️ **C 绝不能释放明细** —— 释放了商家就能对同期重新申请，
那一笔流水会被**打两次**（一次是这张单，一次是商家新申请的单）。

⚠️ **B 与 C 都要记 `payout_operations`**。

⚠️ **A 与 C 的差别是本质的**：
- **A**（重试 `FAILED` 单）→ 明细**已被释放** → **必须重新纳入 + 重算**（§三·3.2）
- **C**（解卡重打 `PROCESSING` 单）→ 明细**一直都在**（它没落过 `FAILED`）
  → **不用动明细、不用重算**，只改状态与 `attemptCount`。
  重打用的是**审批时锁定**的金额（护栏 X2：打款用锁定的金额，不重算）→ 账实相符。

⚠️ **C 之后那张单若再落 `FAILED`**（重打后渠道失败试满）→ worker 的 `markFailed`
写 `failedBeforePayout = false`（§二·2.1 表格第 5 行）→ **不能重试** → 运营只能再解卡一次。
这条链**是自洽的**，但界面上要写清：「解卡重打」给的是**一次机会**，不是「重试资格」。

⚠️ **`PROCESSING` 的单要先确认它真的卡住了**：`processingAt` 超过阈值（默认 10 分钟，
与 `scanStuck` 的 `stuckThresholdMs` 一致）才允许操作 —— 否则它可能只是**正在打款**，
运营一点就把正在进行的打款打断了。

⚠️ **处置按钮只在详情页，不在列表页** —— 列表页的行内操作需要二次确认弹窗 +
必填原因，在一行里做体验差且容易误点。列表页只负责**标红**（已有的 `isStuck`）。

### 3.4 服务层的方法与端点

`PayoutService` 加两个方法（**都在平台作用域下**）：

```ts
/** 平台端人工重试（操作 A） */
async retry(payoutId: string, reason: string): Promise<PlatformPayoutView>

/** 平台端解除卡单（操作 B / C） */
async unstick(
  payoutId: string,
  input: { to: 'FAILED' | 'APPROVED'; reason: string },
): Promise<PlatformPayoutView>
```

⚠️ **都放在 `PayoutService` 而不是 `PayoutExecutionService`** ——
重试要做三件 `PayoutExecutionService` 不做的事：
① 查活跃单（要 `tenantId` + `periodStart` + `kind`，见 §三·3.2 第 3 步）
② 重算金额 + 同步明细（`computeAmounts` / `computeSupplementAmounts` 是
   `PayoutService` 的 **private** 方法）
③ 在**事务外**入队（与 `approve` 同款：入队必须在事务提交之后，
否则 worker 可能消费到还没提交的行）

⚠️ **状态更新的 `where` 必须带状态条件**（与 `approve` / `reject` / `cancel` /
`markFailed` / `claimForExecution` 同款）：

```ts
// 操作 A
where: { id: payoutId, status: PayoutStatus.FAILED, failedBeforePayout: true }
// 操作 B / C
where: { id: payoutId, status: PayoutStatus.PROCESSING }
```

`affected.count === 0` → **409**。⚠️ **不带 `status` 的话，两个超管同时点「重试」
会双双「成功」** → 第二个的明细 `createMany` 撞 `entryId` 唯一索引 → P2002 → 500，
而且数据库已经乱了（明细被清空）。

端点（`platform-payout.controller.ts`，全部 `PLATFORM_ADMIN` 角色）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/platform/payouts/:id/retry` | 操作 A。**要求 `failedBeforePayout = true`** |
| `POST` | `/platform/payouts/:id/unstick` | 操作 B / C，body 带 `to` 与 `reason` |

⚠️ **两个端点都要有 `reason`（必填、不能是空白）** —— 涉及钱的操作不能没有理由。
理由会进 `payout_operations.reason`。

⚠️⚠️ **前端还要加两个「中转路由」** —— 平台端的**所有写操作都走同源的
`/api/**` 中转**，不是直连后端（后端没开 CORS，且 accessToken 不该进客户端代码）。
现有中转：`platform-admin/src/app/api/billing/payouts/[id]/approve/route.ts`
与 `.../reject/route.ts`。本阶段要加：

| 中转路由 | 转发到 | 请求体 |
|---------|--------|--------|
| `POST /api/billing/payouts/:id/retry` | `/platform/payouts/:id/retry` | `{ reason }` |
| `POST /api/billing/payouts/:id/unstick` | `/platform/payouts/:id/unstick` | `{ to, reason }` |

中转的三个职责（照 `reject` 那份的写法）：
① `auth()` 拿会话，没登录 → `unauthorizedResponse()`；
② **按白名单重建请求体**（客户端传来的 body 是不受信任的输入，只取 `reason` / `to`）；
③ 错误 → `toErrorResponse(cause)`。

⚠️ **「重新打款」的 `to` 绝不能有默认值** —— 默认成 `FAILED` 的话，
运营漏传就会**静默走错方向**（把「重打」变成「标记失败」）。中转与后端**都要校验**。

⚠️ **409 vs 404 vs 400**：
- 单不存在 → 404
- 状态不对（不是 `FAILED` / 不是 `PROCESSING`）→ 409
- 该期有别的活跃单（操作 A）→ 409，消息点名是哪一张
- **重算金额与锁定金额不一致**（操作 A）→ 409，消息给出两个数
- `processingAt` 还没超阈值（操作 B / C）→ 409（「这张单可能正在打款」）
- `reason` 为空 → 400
- `failedBeforePayout = false` 却要重试 → **409**（不是 400 —— 状态合法但这个操作不允许；
  消息要说清「该单可能已打款，请先核对渠道」）

⚠️ **补差单（`kind = SUPPLEMENT`）的重试**：走操作 A，但第 4 步用
`computeSupplementAmounts` 的口径（佣金恒为 0）—— 见 §三·3.2 第 4 步的表格。
⚠️ 若那批流水已被别的单占用 → 算出的金额为 0 → **409**（「该期流水已被其他出款单
占用，请让商家重新申请」）→ 这时**不能**重试。

### 3.5 `markFailed` 加参数

```ts
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
   */
  failedBeforePayout?: boolean;
}
```

⚠️ **默认 `false`** —— 宁可保守。新增调用点若忘了传，会落成「不可重试」（安全方向）。

worker 的 5 个调用点按 §2.1 的表格传值。

---

## 四、失败原因的口径收口

### 4.1 现状与问题

`failureReason` 落库的**不全是原文** —— 要分清三类（实测 `grep failureReason` 的全部写入点）：

| 写入点 | 内容 | 是原文吗 |
|--------|------|---------|
| `payout.worker.ts:181` | **渠道抛出的异常原文**（`error.message`） | ⚠️ **是** —— 可能带主机名、请求 id、网关内部码 |
| `payout.worker.ts:240` | **渠道返回的 `failureReason`**（假网关是「假出款网关模拟的失败（第 N 次尝试）」） | ⚠️ **是** |
| `payout.worker.ts:246` | `渠道金额核对不通过（请求 X 分，渠道返回 Y 分）` | 半原文（含内部金额） |
| `payout.service.ts:608` | `打款任务提交失败，系统将自动重试` | ❌ 5k 已脱敏（Redis 的原始连接错误**只进日志**） |
| `payout.worker.ts:135` / `:216` | 业务口径（`收款账号信息异常…` / `出款金额异常…`） | ❌ 5k 已脱敏 |

⚠️ **所以「Redis 连不上」不是原文形态** —— 5k 已经把入队失败那条脱敏了。
真正会漏给商家的是**渠道侧的异常原文**。

商家看到的是**内部术语**，而平台端排查要的**恰恰是这份原文**。

### 4.2 改法：默认业务口径，平台端额外拿原文

- `toView`（商家端与平台端**共用**）的 `failureReason` → **业务口径**
- `toPlatformView` 额外加一个字段 `failureDetail` → **原文**（只有平台端有这个字段）

⚠️ **默认安全**：共用视图给的是业务口径；只有平台端视图额外暴露原文。
这样「忘记脱敏」的可能性被结构性消除 —— 新增端点若用 `toView`，默认就是安全的。

⚠️ **`failureDetail` 只承载渠道侧的原文** —— 它**看不到解密根因**（那是 5k 遗留 4，
根因只进 `logger.error`，从不进 `failureReason`）。界面上要写清这一点，
否则运营会以为「界面上没有就是没有别的线索」。

⚠️ **`failureDetail` 的三条护栏**：
1. **只在 `status = FAILED` 时返回**（其它状态没有失败详情）；
2. **长度截断**（渠道异常原文可能极长）；
3. **去掉换行**（原文可能带 `\n` → 直接渲染会破坏界面布局，也防止日志注入）。

⚠️ **商家端的业务口径按 `failedBeforePayout` 分流**：

| 情况 | `failedBeforePayout` | 商家看到 |
|------|---------------------|---------|
| 钱确定没打（解密失败 / 账户缺失 / 金额非法 / 人工转失败） | `true` | 「收款账号信息异常，本次未打款，请更新收款账户后重新申请」 |
| 钱可能已打（渠道失败试满 / 金额核对不通过） | `false` | 「出款未完成，请联系平台确认出款情况」 |

⚠️ **这顺带解决了 5k 的遗留 5**（「`FAILED` 承载了两种语义」）：5k 当时只能用
一句通用措辞覆盖两类（商家可能为一个确定没打钱的单白打电话），
现在商家端能**区分**了 —— 确定没打的说「本次未打款，请更新收款账户后重新申请」，
可能已打的说「请联系平台确认出款情况」。

⚠️ **第二类**为什么不能说「是否已到账」：那会让商家以为「可能没到」，
而实际是「可能已经到了，请去查」。

⚠️ **第一类**为什么不能说「未知原因」：它**知道**原因（账户不可用），且知道**该做什么**
（更新账户后重新申请）。

⚠️ **`APPROVED` 状态的 `failureReason`（入队失败）**：商家端**不显示**（5k 已定），
平台端显示「备注」行 —— 那句话本来就是业务口径，不受影响。

### 4.3 平台端界面

平台端出款单详情页显示**两行**：
- 「失败原因」→ 业务口径（与商家端一致）
- 「失败详情」→ **原文**（仅 `FAILED` 状态显示，仅平台端有）

⚠️ **为什么平台端要两行而不是只显示原文**：原文是给运营排查用的
（「Unsupported state or unable to authenticate data」比「收款账号信息异常」有用得多），
但**业务口径才是结论**。两行都给，运营既知道结论也知道根因。

---

## 五、列表分页

### 5.1 现状核对（已实测）

| 列表 | 后端 | 前端 |
|------|------|------|
| 商家端出款列表 | ✅ 已支持 `page`/`pageSize`/`total`（`clampPagination`：默认 20、上限 100） | 请求 `pageSize=100`，显示「共 N 张（本页显示 M 张）」，**无翻页控件** |
| 平台端出款列表 | ✅ 同上 | 请求 `pageSize=100`，超 100 张时提示「请按周期筛选」，**无翻页控件** |
| 结算单明细 | ❌ 详情接口**无上限全量返回** entries（`settlement.service.ts:919-929` 没有 `take`） | 一次性渲染全部 |

⚠️ **前两处后端零改动** —— `clampPagination` + `skip`/`take` + `total` 都已就位，
只是前端从不传 `page`、也没有控件可翻。

### 5.2 出款列表的分页（纯前端）

**控件形态**：页码分页（与后端的 `page`/`pageSize` 一致），每页条数 20 / 50 / 100 三档。

⚠️ **初始值必须是 100，不能是 20** —— 两端现有页面都**显式请求 `pageSize=100`**
（`merchant-admin/.../settlements/page.tsx:37`、`platform-admin/.../payouts/page.tsx:56`），
而 `clampPagination` 的默认值是 20。**若控件初始值设成 20，商家与运营会突然
「只能看到 20 张」** —— 明明以前能看到 100 张 → 会被当成「数据丢了」。
→ **默认 100**（与现状一致），20 / 50 作为另外两档。

⚠️ **为什么不改成「每页 100 + 加载更多」**：出款是**跨期**的列表，
商家几年下来几百张单，「加载更多」要一直点；而页码能直接跳到「第 3 页」。

⚠️ **必须显示总数**（「共 N 张」）—— 现在已经在显示了，分页后要显示「第 X / Y 页，共 N 张」。

⚠️ **两个端点都要有**（`/merchant/payouts` 与 `/platform/payouts`），共用一套分页控件组件。

⚠️ **筛选与分页的交互**：平台端出款列表支持按周期筛选。**筛选变化时页码重置为 1**
（否则会停在一个不存在的页上，列表变空）。

⚠️ **空结果的区分**：页码越界（请求第 5 页但只有 2 页）→ 显示「没有更多了」而不是错误。

⚠️ **平台端列表上那句「超过 100 张时请按周期筛选」要撤掉** —— 有了分页控件，
就能直接翻到第 2 页，不必靠筛选缩小范围。留着会误导。

⚠️ **顺带核对一处既有的不一致**：平台端**结算单列表**请求的是 `pageSize=200`
（`platform-admin/.../settlements/page.tsx:57`），但 `MAX_PAGE_SIZE = 100` →
**200 会被夹回 100**。那条页面的注释写着「后端 `pageSize` 的上限就是 200」——
**是错的**。本阶段改分页控件时会碰到它，一并核对。

### 5.3 结算单明细的分页（要加一个端点）

⚠️ **不能改详情接口的响应结构** —— `entries` 改成「本页的」会让现有消费者
（平台端页面 + 相关 e2e）拿到的数据变少，且**语义变了**（从「全部」变成「一页」）。

→ **新增独立端点**：

```
GET /platform/settlements/:id/entries?page=1&pageSize=20
→ { items: [...], total: N, page, pageSize }
```

详情接口**原样不动**（向后兼容）。

⚠️ **分页端点只返回「条目本身」**：
`entryId / orderNo / type / amount / rateBps / baseAmount / occurredAt`
+ 信封 `{ items, total, page, pageSize }`。

⚠️ **两个「整单级」的判定留在详情接口，不要搬进分页端点**：
- `missingEntryCount`（缺笔数 —— 整期的流水 vs 整期已纳入的流水）
- `canRecalculate`（有没有出款单引用）

理由：① 它们是**整单属性**，放在「一页明细」里会让人误以为是「这一页的缺笔数」；
② 算它们要多查几次（缺笔 3 次 + 引用 1 次）→ 每个分页请求都重算一遍是 N+1。
→ **前端并排调两个接口**：详情拿 `missingEntryCount` / `canRecalculate`，
分页端点拿当前页的条目。

⚠️ **设计初稿在这里写错过**：写的是「详情里有 `stale` 缺笔标记」——
**详情里没有 `stale` 这个字段**（`stale` 是**批量生成**响应里的，
`settlement.service.ts:253`），详情里的是 `missingEntryCount`。以本文为准。

⚠️ **为什么结算单明细也要做**：它的 entries 现在**无上限全量返回** ——
一期若有大额回填，响应会很大，前端一次渲染上千行表格。**这不只是 UI 问题，是接口问题。**

---

## 六、测试与验收

### 6.1 单测

| 位置 | 用例 |
|------|------|
| `payout-execution.service.spec.ts` | `markFailed` 落 `failedBeforePayout`；默认 `false`；`retryFailed` 在 `failedBeforePayout = false` 时**拒绝**；`unstick` → `FAILED` 时**释放明细**、→ `APPROVED` 时**不释放** |
| `payout.service.spec.ts`（新建或改写） | 重试前置条件；**该期有别的活跃单 → 409 并点名**；`reason` 为空 → 400；`payout_operations` 被写入（类型 / 操作人 / 原因 / 前后状态） |
| `payout-worker.spec.ts` | worker 的 5 个 `markFailed` 调用点**各自传对 `failedBeforePayout`**（1/2/3 → `true`，4/5 → `false`） |
| `payout.service.spec.ts` | `toView` 的 `failureReason` 按 `failedBeforePayout` 分流；`toPlatformView` 额外有 `failureDetail` 且是**原文** |

### 6.2 e2e

| 用例 | 断言 |
|------|------|
| 重试 | `FAILED` + `failedBeforePayout = true` → 状态回 `APPROVED`、**明细被重新纳入**（`payout_entries` 里该 `payoutId` 有行）、`attemptCount` 归零、单能正常打款成功 |
| 重试 | `FAILED` + `failedBeforePayout = false` → **409**，状态不变 |
| 重试 | 该期已有别的活跃单 → **409**，消息点名那张单的 `payoutNo` |
| 重试 | 该期金额已变化（插一笔退款冲回后再重试）→ **409**，消息含两个金额 |
| 解卡 | `PROCESSING` → `FAILED`：明细**被释放**（`payout_entries` 该 `payoutId` 无行）、`payout_operations` 有一行 |
| 解卡 | `PROCESSING` → `APPROVED`：明细**仍被占着**、`processingAt` 清空、`attemptCount` 归零 |
| 解卡 | `processingAt` 还在阈值内 → **409**（不能打断正在进行的打款） |
| 重试 | **两个超管同时点重试** → 一个成功、一个 **409**（`where` 带 `status: FAILED` 的条件更新） |
| 口径 | 商家端 `GET /merchant/payouts/:id` 的 `failureReason` **不含**渠道原文；平台端 `failureDetail` **含**原文 |
| 分页 | 三处列表翻页后拿到的条目**不重复、不遗漏**（第 1 页与第 2 页的 id 集合无交集，合计 = total） |

⚠️ **「明细被占着」的断言方式**：查 `payout_entries` 里该 `payoutId` 的行数
（重试与解卡重打都应是 **≥ 1**；解卡转失败应是 **0**）。

⚠️ **重试那条的「明细被重新纳入」是本阶段最容易被漏掉的断言** ——
只断言「状态回 APPROVED」的话，实现若忘了同步明细，
单子会以「金额对得上但没有任何流水被占用」的形态打款 → 商家能对同期重新申请 →
**同一笔流水打两次钱**。

⚠️ **分页的断言不能只看条数** —— 要比对**条目 id 的集合**，
否则「第 2 页返回了第 1 页的内容」这种错误会漏过去。

### 6.3 失败注入

| 编号 | 注入 | 期望 |
|------|------|------|
| **H1** | 去掉 `retryFailed` 里 `failedBeforePayout = true` 的检查 | 「`failedBeforePayout = false` → 409」那条挂 |
| **H2** | 去掉重试前的活跃单检查 | 「该期有别的活跃单 → 409」那条挂（撞 P2002 → 500） |
| **H3** | 解卡转 `APPROVED` 时也 `deleteMany` 明细 | 「明细仍被占着」那条挂 |
| **H4** | `toView` 的 `failureReason` 改回原文 | 「商家端不含渠道原文」那条挂 |
| **H5** | `markFailed` 的 worker 调用点全传 `false` | 「1/2/3 传 `true`」那条挂 |

⚠️ **失败注入必须独占**（不与全量测试并发）—— 注入期间源码是坏的。

### 6.4 浏览器手测

| 步 | 内容 |
|----|------|
| 1 | 平台端出款列表 → 能翻页，页码与总数正确 |
| 2 | 商家端出款列表 → 能翻页，第 2 页不是第 1 页的重复 |
| 3 | 平台端某张 `FAILED` 单 → 能看到「失败原因（业务口径）」与「失败详情（原文）」两行 |
| 4 | 商家端同一张单 → 只看到业务口径，**看不到**原文 |
| 5 | 平台端某张 `FAILED` + `failedBeforePayout = true` 的单 → 有「重试」按钮 |
| 6 | 平台端某张 `FAILED` + `failedBeforePayout = false` 的单 → **没有**「重试」按钮 |
| 7 | 平台端一张卡住的 `PROCESSING` 单 → 能解卡，两个方向都有警示与必填原因 |

---

## 七、风险与遗留

### 7.1 本阶段引入的

| # | 事项 | 说明 |
|---|------|------|
| 1 | **人工重试可能重复打款** | 操作 C（解卡重打）本质上是运营在做「钱没打出去」的判断。**界面警示 + 必填原因 + 留痕**只能降低误操作概率，**不能消除**。真正的解法是渠道对账（L43），不在本阶段 |
| 2 | **`failedBeforePayout` 是「历史信息」而非「当前事实」** | 它记录的是**落 FAILED 那一刻**钱打没打出去。将来若有别的代码路径改状态，这个标记可能不再准确 → 只能由「落 FAILED 的那个调用点」来保证正确性 |
| 3 | **状态机新增了两条转换**（`FAILED → APPROVED`、`PROCESSING → FAILED/APPROVED`） | ⚠️ **部分唯一索引的 `WHERE` 不含新目标状态** —— `APPROVED` 不在 `status NOT IN ('REJECTED','CANCELLED','FAILED')` 的排除列表里 → 转成 `APPROVED` 的单**重新占位**（这正是我们想要的：它又要打那些流水了） |
| 4 | **历史 `FAILED` 单的 `failedBeforePayout` 一律 `false`**（除 5k 那句业务口径的精确匹配） | 保守。渠道失败的老单**不能**一键重试 → 运营要先人工核对 |

### 7.2 5j / 5k 的遗留，本阶段处理了的

| # | 遗留 | 状态 |
|---|------|------|
| 1 | 5k 遗留 3：崩溃窗口卡 `PROCESSING`，无自助处置入口 | ✅ 本阶段解决（操作 B / C） |
| 2 | 5k 遗留 1：密钥配错 → 批量 `FAILED` 且不会自动恢复 | ✅ **部分解决** —— 确定没打的单现在能一键重试（不用商家全部重新申请） |
| 3 | 5k 遗留 5：`FAILED` 承载两种语义 | ✅ **商家端已能区分**（§四·4.2） |
| 4 | 5k 遗留 6：渠道失败原因原样透到商家屏幕 | ✅ 本阶段解决（§四） |
| 5 | L41 / L42：`FAILED` 无人工重试、`attemptCount` 无重置 | ✅ 本阶段解决 |
| 6 | L35 / L36：两端出款列表无分页 | ✅ 本阶段解决（§五·5.2） |
| 7 | L28：结算单明细分页 | ✅ 本阶段解决（§五·5.3） |

### 7.3 仍未处理的

| # | 事项 | 说明 |
|---|------|------|
| 1 | **L43 渠道对账** | 「钱到底打没打」的唯一权威答案。人工核对渠道是临时的替代 |
| 2 | **L31 漏结流水无主动告警** | 本阶段的「运营能看见并处理」是替代，不是告警 |
| 3 | **5k 遗留 4：根因只进日志** | 平台端仍看不到「是没迁移 / 是密钥错了 / 是版本不匹配」—— ⚠️ **`failureDetail` 也看不到**（它只承载渠道侧原文，解密根因从不进 `failureReason`）。要把解密根因放上界面，**需要单独决策**（那会把密钥相关的信息推到浏览器里） |
| 4 | **R7 跨期调账 + L54 逐笔结佣** | 等产品决策 |
| 5 | **L33 出款单作废重开** | 本阶段的「解卡转失败」覆盖了卡单场景，但 `APPROVED` 后金额要改的场景没有解 |
| 6 | **`prisma migrate dev` 仍不可用** | 3 条历史迁移的 checksum 不符。本阶段照旧手写 SQL |

---

## 八、实施分解

| Task | 内容 | 层 |
|------|------|------|
| 1 | `payouts.failedBeforePayout` 列 + `payout_operations` 表（+ `Payout` 的反向关系字段）+ 迁移 SQL + schema + `tenant-models.ts` 的排除注释 | 数据 |
| 2 | `markFailed` 加参数 + worker 5 个调用点传值 | 后端 |
| 3 | `PayoutService.retry`（含 kind 分支的重算 + 活跃单检查 + 重新纳入明细）/ `unstick` + 两个端点 | 后端 |
| 4 | `toView` 的口径分流 + `toPlatformView.failureDetail` + 商家端/平台端页面 | 后端 + 两端前端 |
| 5 | 平台端出款详情页的处置按钮（重试 / 解卡，含警示与必填原因）+ **两个中转路由** + 操作留痕展示 | 前端 |
| 6 | 两端出款列表的分页控件 + 结算单明细的分页端点与页面 | 前端 + 后端 |
| 7 | 单测 / e2e / 失败注入 / 手测 / 验收记录 | 全 |

---

## 九、独立审查的修正记录

本文档初稿写完后，派了一个**独立审查代理**做对抗式审查（要求它读实际代码验证每个假设，
而不是只读文档）。**它提出的 6 条技术问题全部核实成立**，已逐条改入本文档：

| # | 审查发现 | 处置 |
|---|---------|------|
| 1 | ⚠️ **重试的重算口径写错了** —— `computeAmounts`（正常单）**不排除**其他单占用的流水，而 `computeUnclaimedAmounts` / `computeSupplementAmounts` 是**补差单专用**。设计原文写「复用 approve 的 computeAmounts / computeUnclaimedAmounts 二选一」，没说按 `kind` 分支 —— 照字面实现会把补差单的佣金扣第二遍 | ✅ 改入 §三·3.2 第 4 步的 **kind 分支表**，并写清各自的范围与安全性论证 |
| 2 | ⚠️ **补差单的重试路径完全缺失** —— `computeSupplementAmounts` 的「本单已占 ∪ 未被其他单占用的」里，「本单已占」那半边已被 `markFailed` 释放 → 口径退化成「未被任何单占用的」 | ✅ 补进 §三·3.2 第 4 步：证明这个退化后的口径**恰好正确**（正常单 `PAID` 占了整期，剩下的就是回填那批），并写明「期间又回填了新流水 → 金额变了 → 409」 |
| 3 | ⚠️ **第 3 步的活跃单检查口径与唯一索引不匹配** —— `findActivePayout` 的 `kind` 是**必传**（索引是三元组），且 `PAID` 落在「活跃」里 | ✅ §三·3.2 第 3 步写全口径：`tenantId + periodStart + kind` + `notIn [REJECTED, CANCELLED, FAILED]`（**含 `PAID`**）+ 排除自己 |
| 4 | ⚠️⚠️ **更严重的一条（审查没提、我核实代码时发现的）** —— `findActivePayout` 是 **private 且只在商家侧（租户作用域）调用**的。重试跑在 `platformScope()` 下 → 扩展**不附加** tenantId 条件 → 直接用它会**跨租户匹配**（**所有租户的 `periodStart` 都是同一天**） | ✅ §三·3.2 第 3 步写明「**不能直接用 `findActivePayout`**，重试要自己写带 `tenantId` 的查询」，并给出代码 |
| 5 | ⚠️ **迁移 SQL 漏了 5k 的第二句业务口径** —— `checkGates` 有**两条**闸，两句都是 5k 引入、都在打款之前 | ✅ §二·2.3 补成表格，并说明「金额异常」那句**故意保持 `false`**（金额非法是脏数据，重算大概率仍 ≤ 0 → 置 true 只会让按钮出现后再被拒） |
| 6 | ⚠️ **`failureDetail` 的原文来源举错例** —— 设计举例的「Redis 连不上」**早已被 5k 脱敏**（`payout.service.ts:608` 写的是业务口径，Redis 原文只进日志） | ✅ §四·4.1 改成**五个写入点的分类表**，并补三条护栏（只在 `FAILED` 时返回 / 长度截断 / 去换行）+ 明确「`failureDetail` **看不到解密根因**」 |

**审查提的另外几条也已改入**：
- **分页默认 20 是行为变更**（现有页面显式请求 100，改后商家「只能看到 20 张」会被当成数据丢了）→ §五·5.2 改成**默认 100**；
- **设计说详情里有 `stale` 缺笔标记 —— 不存在**，详情里是 `missingEntryCount`（`stale` 是批量生成响应的字段）→ §五·5.3 已更正，并写明两个「整单级判定」留在详情接口；
- **jobId 的轮次来源未定义**（`attemptCount` 刚被重置成 0）→ 改用 `payout_operations` 里 `RETRY` 的行数 + 1，**永不复用**；
- **三个操作后的状态字段表不完整**（缺 `failedAt` / `approvedAt`）→ §三·3.3 补成**逐格写明「写 / 清 / 不动」的完整表**；
- **并发的 `where` 条件未给** → §三·3.4 写明 `where` 必须带 `status`（否则两个超管同时点会双双「成功」→ P2002）；
- **`tenant-models.ts` 的排除注释区要补一段**（本仓惯例，漏了会被下一个人「顺手登记」）；
- **处置按钮只在详情页，不在列表页**（列表行内做二次确认体验差且易误点）→ §三·3.3 写明；
- **平台端列表那句「超过 100 张时请按周期筛选」要撤掉**（有分页就不必靠筛选）；
- **平台端结算单列表请求 `pageSize=200` 但上限是 100**（那条页面的注释写错了）→ §五·5.2 记为「顺带核对」。

**审查也核实过、设计没问题的关键点**（记在这里，让后来人知道这些地方已经审过）：
`payout_operations` 无 `tenantId` 不会让应用启动失败（`assertTenantScopedModelsRegistered`
只扫带 `tenantId` 字段的模型）；迁移 SQL 的顺序对（枚举必须先于建表）；
两端出款列表后端确实已支持 `page`/`pageSize`/`total`；`clampPagination` 的默认值与上限引用准确；
结算单详情确实无上限全量返回；`payout_entries.entryId` 是全局唯一索引且**指向货款流水**；
`markFailed` 确实释放明细且与状态更新同事务；部分唯一索引的 `WHERE` 与 `findActivePayout`
的 `notIn` 逐字一致；worker 的 5 个 `markFailed` 调用点与「相对 `provider.execute` 的位置」
逐行准确；「落 `FAILED` 安全」的依据成立；**「5k 之前不可能产生过同样文案」成立**
（`git log -S` 实测两句都只在 5k 的 commit 首次出现）→ 迁移的精确匹配安全；
`toView` 只在 `payout.service.ts` 内部使用（改它不影响其他消费者）；
`toPlatformView` 确实是 `{...this.toView(payout), ...}` 的分层 → 加 `failureDetail` 能直接落地；
商家端 `PayoutItem` 不需要加 `failedBeforePayout`（口径分流在后端做）；
操作 C 不重算金额是安全的（明细还在、金额是锁定值 → 账实相符）。
