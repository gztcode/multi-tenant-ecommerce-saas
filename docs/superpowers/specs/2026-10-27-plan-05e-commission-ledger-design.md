# 阶段 5e 设计：抽佣流水明细 + M11 收尾

> 阶段 5d（主题统一 + 前端错误处理收口 + Redis 挂死修复）已完成并合并（PR #12）。
> 本阶段接手两件事：**把抽佣从「订单上的两个快照字段 + 报表跨订单聚合」抽成一张流水表**，
> 以及 **5b 留下的 M11**。

**日期**：2026-10-28
**依据**：`docs/superpowers/specs/2026-10-25-plan-05b-billing-design.md` §十一（遗留 1 与 7）、
`docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md` §六·2 与 §四·M11

---

## 一、目标与范围

### 1.1 目标

1. **抽佣有独立的流水**：每一笔抽佣与每一笔冲回都是一条可查的记录，
   平台能按「商家 × 区间」看到谁贡献了多少，为将来的结算单铺路。
2. **M11 收尾**：把「重复的支付回调延长两次订阅期」这条护栏**真正测到**，
   并在注释里写明它当前为什么测不出来。

### 1.2 范围

| 编号 | 子项 | 涉及 |
|------|------|------|
| 5e-0 | 抽佣流水的**数据模型与迁移** | `api/` |
| 5e-1 | **支付成功时写抽佣流水**、**退款成功时写冲回流水** | `api/` |
| 5e-2 | 历史订单的**回填**（幂等服务方法 + CLI 脚本） | `api/` |
| 5e-3 | 平台的**抽佣明细查询端点** | `api/` |
| 5e-4 | platform-admin 的**「抽佣明细」页** | `platform-admin/` |
| 5e-5 | **M11 的断言与注释** | `api/` |
| 5e-6 | 对账与验收 | 全栈 |

### 1.3 明确不做

| 不做 | 原因 |
|------|------|
| **结算单**（period 级的应收单据） | 流水表是它的**前置**，不是它本身。结算单要定「周期怎么切」「跨周期退款怎么摊」，是独立的设计 |
| **把平台收入报表切到流水表** | ⚠️ 切换的前提是**生产已回填**。不切的话报表口径一点不变、零回归风险；切了的话，部署顺序错了报表就是 0。等生产回填完成、且对账 e2e 稳定通过后再说（记为遗留 L18） |
| **抽佣出款** | 5b 的决策：只记账。5b 遗留 1 |
| **商家级抽佣费率覆盖** | 5b 的决策 4：费率只配在套餐上 |
| **改 `Order` 加「计佣基数」字段** | ⚠️ `Order.totalAmount` **本身就是「优惠后的实付」快照**、下单后再也不会变，它就是计佣基数。加第 4 个字段是冗余（详见 §4.2） |
| L1 / L12（webhook 与超时释放的**补偿机制**） | 5d 的遗留，与抽佣完全无关 |
| L13 / L16（主题遗留：行高不跟随、部分 token 无消费者） | 5d 的遗留，与抽佣完全无关 |

---

## 二、事实基础

### 2.1 抽佣现状

**数据落在订单的两个快照字段上**（`api/prisma/schema.prisma:530-533`）：

```prisma
  /** 抽佣费率快照（基点）。下单时从套餐读，写死在订单上 */
  commissionRate Int @default(0)
  /** 抽佣额快照（整数分）。下单时按实付算出 */
  commissionAmount Int @default(0)
```

**写入点只有一个** —— 下单时（`api/src/modules/order/order.service.ts:382-388`）：

```ts
const plan = await this.quota.currentPlan(tenantId);
const rateBps = plan?.commissionBps ?? 0;
const commission = computeCommission({
  payableAmount: discount.payableAmount,
  rateBps,
});
```

落库在 `order.service.ts:416-417`（`createOrderAndItems` 的入参）。
`computeCommission` 全仓只有这一处生产调用（`api/src/modules/billing/commission.ts:28`）。

⚠️ **支付与退款都不改这两个字段** —— 它们是**下单那一刻**定下的快照。

### 2.2 退款冲回：今天没有实体，只有报表层面的推导

- 退款时只写 `order.refundedAt`（`payment.service.ts:994`，用**数据库的时钟**），
  并把订单转 `REFUNDED`（`:1017-1020`）。
- 报表的「冲回」是**从订单聚合出来的**（`report.service.ts:137-143`）：

```ts
const reversalAggregate = await this.prisma.order.aggregate({
  where: {
    status: OrderStatus.REFUNDED,
    refundedAt: { gte: from, lt: to },
  },
  _sum: { commissionAmount: true },
});
```

### 2.3 报表今天怎么聚合

`api/src/modules/billing/report.service.ts:85-165`，跨两张表：

| 指标 | 来源 | 过滤 |
|------|------|------|
| 订阅收入 | `invoice` 聚合 | `status = PAID` 且 `paidAt ∈ [from, to)` |
| 抽佣收入（毛额） | `order` 聚合 | **只看 `paidAt ∈ [from, to)`，不看 status** |
| 退款冲回 | `order` 聚合 | `status = REFUNDED` 且 `refundedAt ∈ [from, to)` |
| 净额 | —— | 订阅 + 抽佣 − 冲回 |

⚠️ **抽佣只看 `paidAt` 不看 status** 的理由写在 `report.service.ts:107-119`：
按 status 筛会造出凭空的负收入（订单在 P 支付、P+1 退款时，P 的抽佣行会因
status 变成 REFUNDED 而漏掉，P+1 的冲回行又照记 —— 两期合起来净额是 −500，真相是 0）。

⚠️ **冲回按退款期间归期，不按支付期间** —— 否则退款当月的账会把「白拿的抽佣」算成收入。

### 2.4 5b 为什么没建表（决策 9）

> 「**抽佣不建独立表**，存成订单上的两个快照字段 | `commissions` 表 |
> 抽佣的「分叉点」只有一个 —— 支付成功（订单状态机已表达），退款也是订单状态。
> 阶段 5a 的 `coupon_redemptions` 需要独立表，是因为核销有自己的生命周期；抽佣没有」

5b 的遗留（§十一·7）：

> 「抽佣不建独立表 —— 报表 SQL 要跨订单聚合；将来做结算单时再抽一层。」

⚠️ **5b 的决策在本阶段被推翻**：抽佣**确实**需要一个独立表 —— 不是因为「分叉点更多」，
而是因为**「按商家 × 区间出结算单」需要流水**。从订单聚合能算出总额，
但算不出「这一笔抽佣属于哪个商家的哪一次成交」。

### 2.5 仓库里已有的「流水表」先例

| 表 | 位置 | 形态 |
|---|---|---|
| `InventoryMovement` | `schema.prisma:355-399` | append-only 审计流水；`orderId` 可空；外键 `onDelete: Restrict`（注释写明「流水是审计凭证，物理删除有流水的 SKU 必须被 DB 拒绝」） |
| `CouponRedemption` | `schema.prisma:735` | 券核销流水（5a 建独立表的理由：核销有自己的生命周期） |
| `PaymentWebhookEvent` | `schema.prisma:634` | 渠道事件表，不带 tenantId |

⚠️ **没有**任何名为 ledger / settlement / 结算单 的表或服务。

### 2.6 M11 的真实缺口

5b 护栏清单（`2026-10-25-plan-05b-billing-design.md:604`）：

> | **M11** | **重复的支付回调延长两次订阅期** | 白嫖 | provider + providerTxnId 幂等 + 事件表幂等索引（阶段 3 同款） |

⚠️ **纠正一个流传的说法**：5d 的设计文档写「M11 的实际缺口只是**缺日志**」—— **这是错的**。
M11 与日志无关。5b 验收记录（`2026-10-25-plan-05b-acceptance.md:206-223`）的结论是：

> `markInvoicePaidInTx` 写的是 `currentPeriodEnd: invoice.periodEnd`（**绝对值**），
> 所以**天然幂等**，`status` 条件只是**第二层**防御；现有用例第二次投递用同一 eventId，
> 被 `insertEvent` 唯一索引挡在 `markInvoicePaid` **之前**。

即：**护栏有覆盖，但计划指向的那一层观测不到**。

### 2.7 两条出路的取舍（5b 验收记录 §四·M11 给了两条）

1. 改成**相对延长**并补用例 —— 让 `status` 条件变成真正的主防线、因而可观测。
   ⚠️ 代价：**改了订阅延期的语义**，且幂等从此依赖那层条件 —— 守卫失效就是真的白嫖。
2. 在注释里写明「`status` 条件是第二层防御，当前实现下测不到」。

**本阶段选第 2 条**（见 §三 D6），并**补一条真正测到绝对值实现幂等的断言**。

---

## 三、关键决策

| 编号 | 决策 | 理由 |
|------|------|------|
| D1 | 抽佣流水建**独立表** `commission_entries`，推翻 5b 的决策 9 | 「按商家 × 区间出结算单」需要「这一笔属于哪个商家的哪一次成交」，从订单聚合算不出来 |
| D2 | **冲回用正负流水行 + type 枚举**（`COMMISSION` / `REVERSAL`），金额带符号 | 单列求和即净额；与 `InventoryMovement` 的 append-only 审计凭证同款。**不用**负数字段 —— 那样「冲回了哪笔」就断了 |
| D3 | 抽佣行在**支付成功时**写，不在下单时 | **未支付的订单不该有抽佣**（钱没进来）；且 `occurredAt = paidAt` 与现状报表的归期口径**逐字一致** |
| D4 | 冲回行在**退款成功时**写，与 `refundedAt` 同一个事务 | 同上，`occurredAt = refundedAt` |
| D5 | 回填做成**幂等的服务方法 + CLI 脚本**，不是迁移里的 SQL | ⚠️ 迁移里的回填**测不到** —— e2e 的种子数据在迁移**之后**才灌进去。做成服务方法才能被 e2e 验证。⚠️ **且因为报表口径不切，忘了跑回填没有任何正确性影响** |
| D6 | M11 走「**注释写明 + 补幂等断言**」，不改实现 | 改成相对延长会**改订阅延期的语义**，且幂等从此依赖那层条件。⚠️ 但补的断言**不是现在那条** —— 见 §6.3 |
| D7 | **平台收入报表不切到流水表** | 切换的前提是生产已回填；不切则口径一点不变、零回归。对账 e2e 保证两者不会漂 |
| D8 | **不给 `Order` 加字段** | `Order.totalAmount` **本身就是「优惠后的实付」快照**、下单后再也不会变，它就是计佣基数。流水表自己复制一份 `baseAmount` 即可 |

---

## 四、设计

### 4.1 数据模型

```prisma
enum CommissionEntryType {
  COMMISSION
  REVERSAL
}

model CommissionEntry {
  id         String             @id @default(uuid())
  tenantId   String
  orderId    String
  /** 订单号快照（对外凭证） */
  orderNo    String
  type       CommissionEntryType
  /**
   * 金额（整数分，**带符号**）。
   * COMMISSION > 0（抽佣）；REVERSAL < 0（冲回）。
   */
  amount     Int
  /** 抽佣费率快照（基点）。套餐费率会变 → 必须快照 */
  rateBps    Int
  /** 计佣基数快照（= 实付 = `Order.totalAmount`） */
  baseAmount Int
  /**
   * 业务发生时间。
   * COMMISSION = 支付时间；REVERSAL = 退款时间。
   * ⚠️ **与现状报表的归期口径逐字一致** —— 抽佣按 paidAt、冲回按 refundedAt。
   */
  occurredAt DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  /**
   * ⚠️ **外键 Restrict**：流水是审计凭证。
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

⚠️ **`Order` 侧要加反向关系**（Prisma 要求双向声明，否则 schema 校验失败）：

```prisma
  commissionEntries CommissionEntry[]
```

⚠️ **`tenantId` 是纯标量，不声明 tenant 关系** —— 与 `Order.tenantId` 同款：
「跨租户挂载」由 service 层显式校验，不靠外键悄悄放行。

### 4.2 三处快照

| 快照 | 来源 | 为什么必须复制 |
|------|------|---------------|
| `rateBps` | `order.commissionRate` | 套餐费率会变（护栏 M8：改套餐费率不能影响已成交订单） |
| `baseAmount` | `order.totalAmount` | ⚠️ `totalAmount` 现在是快照、不会变；复制一份是**防御性**的 —— 将来它的语义若变，历史流水不受影响 |
| `orderNo` | `order.orderNo` | 对外凭证；复制一份便于导出（订单号本身不可变，但流水不该依赖回查） |

⚠️ **不给 `Order` 加「计佣基数」字段**：计佣基数 = `order.totalAmount`（实付），
它已经是快照。加第 4 个字段是冗余，且两处不一致时反而没人知道哪个对。

### 4.3 写入

**两处写入，都在已有事务里**（原子：写失败 → 整个事务回滚 → 订单状态不变）：

| 行 | 位置 | 内容 |
|----|------|------|
| COMMISSION | `payment.service.ts` 的订单转 PAID 处（与 `paidAt` 同一个 `$transaction`） | `amount = order.commissionAmount`、`occurredAt = paidAt` |
| REVERSAL | `payment.service.ts` 的退款处（与 `refundedAt` 同一个 `$transaction`） | `amount = -order.commissionAmount`、`occurredAt = refundedAt` |

**幂等的三层保障**：

1. **订单状态条件更新**（`status = PENDING_PAYMENT` / `= PAID`）——
   重复投递的第二次 `won = false` → **走不到写流水那里** ✅
2. **`@@unique([orderId, type])`** —— 数据库兜底 ✅
3. 写入用 `upsert` 而不是 `create` —— 撞唯一索引不该抛 P2002 ✅

⚠️ **不写零行**：`commissionAmount = 0`（免费套餐）不产生流水行 ——
否则表里全是 0，聚合时白扫一遍。

### 4.4 回填

`CommissionService.backfill()`（幂等，可重复跑）+ CLI 脚本 `api/scripts/backfill-commission-entries.ts`。

| 行 | 条件 | `occurredAt` | `amount` |
|----|------|--------------|----------|
| COMMISSION | `paidAt != null` 且 `commissionAmount != 0` | `paidAt` | `+commissionAmount` |
| REVERSAL | `status = REFUNDED` 且 `refundedAt != null` 且 `commissionAmount != 0` | `refundedAt` | `-commissionAmount` |

**跳过并计数**（返回值里报出来，不要静默）：

- `commissionAmount = 0` 的订单 → 零行没意义
- **`refundedAt IS NULL` 的已退款订单** → ⚠️ 5b 之前退的款没记时间（`schema.prisma:544-548`
  明说），**冲回无法归期**。现状报表同样跳过它们（`refundedAt: {gte, lt}` 对 null 不匹配）
  → **两个口径一致**，不回填不影响对账 ✅

⚠️ **回填与新写入的判定规则必须逐字对应**，否则对账 e2e 会红。这是 D5 选服务方法
（而不是迁移 SQL）的主要原因 —— 规则写在 TS 里能被单测与审查。

### 4.5 平台端查询端点

`GET /platform/commissions?from&to`（缺省「最近 30 天」，与报表页同款）→

```ts
interface CommissionLedgerResponse {
  from: Date;
  to: Date;
  /** 按商家汇总（净抽佣 = 该商家区间内所有流水行之和） */
  byMerchant: Array<{
    tenantId: string;
    /** 商家名（跨租户取 `Tenant.name`） */
    tenantName: string;
    /** 商家子域名（对外凭证，`Tenant.subdomain`） */
    subdomain: string;
    /** 净抽佣（整数分，可负） */
    netAmount: number;
    /** 流水行数 */
    entryCount: number;
    /** 其中冲回行数 */
    reversalCount: number;
  }>;
  /** 明细行 */
  entries: Array<{
    id: string;
    tenantId: string;
    orderNo: string;
    type: 'COMMISSION' | 'REVERSAL';
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
    orderId: string;
  }>;
}
```

⚠️ **跨租户查询用 `platformScope()`**（与 `report.service.ts:94` 同款）。

⚠️ **商家名要另查 `Tenant` 表** —— `Order.tenantId` 是纯标量、没声明关系，
不能靠 Prisma 的 include 拿到名字。在 service 里查一次商家 id 集合 → 批量取 `Tenant`。

### 4.6 platform-admin 的「抽佣明细」页

- 路由 `platform-admin/src/app/(dashboard)/commissions/page.tsx`
- 导航加一项（`platform-admin/src/app/(dashboard)/layout.tsx:42-48`）
- **Server Component，区间来自 URL**（`?from=&to=`），与报表页同款 —— 可分享、可后退、不引客户端 state
- **直接 `apiFetchAuthed` 调后端**（报表页同款，不需要中转路由）
- 页面结构：**按商家汇总**的表（商家 / 子域名 / 净抽佣 / 笔数）+ **明细**的表（时间 / 订单号 / 类型 / 金额 / 费率 / 基数）
- ⚠️ **金额一律用后端返回的值，前端不自己加总** —— 与报表页「前端绝不自己算净额」同款原则

### 4.7 M11 的注释与断言

**注释**（`invoice.service.ts` 的 `markInvoicePaidInTx`）写明：

> ⚠️ **「`status` 条件是第二层防御，当前实现下测不到** ——
> 订阅期延长写的是**绝对值**（`currentPeriodStart: invoice.periodStart`、
> `currentPeriodEnd: invoice.periodEnd`），所以**同一个账单被重复处理也只会延长一次**。
> 那层 `status` 条件防的是「账单被重复处理」这个假设不成立时的意外，
> **当前实现下无法从外部观测到它是否起作用**。

**断言**：5b 现有的用例用**同一个 eventId** 投递第二次，被**事件表的唯一索引**
挡在 `markInvoicePaid` **之前** → **根本没测到那层防御**。

新用例要投递**两个不同 eventId、但 `providerTxnId` 相同**的事件
（渠道重试换了事件 id 的恶劣形式）→ 事件表幂等挡不住 → `markInvoicePaidInTx`
被调两次 → **断言订阅期只延长一次**（`currentPeriodEnd` 前后相同）。

---

## 五、风险清单

| # | 风险 | 缓解 |
|---|------|------|
| R1 | **写入点漏了某条路径** → 流水与订单快照对不上 | 对账 e2e：流水表按区间聚合 == 报表的抽佣 − 冲回；写路径只有支付与退款两处，各自 e2e 覆盖 |
| R2 | **回填与新写入的判定规则漂移** → 对账红 | 规则写在同一个 service 方法里，回填与写入共用；e2e 直接比两边 |
| R3 | 支付与退款的**并发**导致同一订单写出两行 | 订单状态条件更新 + `@@unique([orderId, type])` |
| R4 | 回填脚本在**生产上跑了两次** | `upsert` 幂等；e2e 连跑两次断言行数不变 |
| R5 | **报表口径不切** → 流水表成了「只写不读」的影子表 | 明细页读它 ✅；对账 e2e 保证它不漂；「切报表口径」记为遗留 L18，等生产回填完成后再做 |
| R6 | 明细页的**商家名**取不到（`Order.tenantId` 无关系） | service 里批量查 `Tenant`；端点测试断言名字正确 |
| R7 | 流水表**体积**增长快（每笔订单 1–2 行） | 只写非零行；`@@index([tenantId, occurredAt])` 与 `@@index([occurredAt])` 覆盖两种主要查询 |
| R8 | M11 的新用例**在别处被挡掉**（如渠道侧的 providerTxnId 幂等） | 断言要落在**订阅的 `currentPeriodEnd` 前后相同**上，而不是「调用次数」；e2e 实测确认 |

---

## 六、测试策略

### 6.1 新增的护栏

| # | 护栏 | 在哪测 |
|---|------|--------|
| N1 | 支付成功 → 产生**一条** COMMISSION 流水，金额 = 抽佣快照，`occurredAt` = 支付时间 | e2e |
| N2 | 退款成功 → 产生**一条** REVERSAL 流水，金额 = **负的**抽佣快照，`occurredAt` = 退款时间 | e2e |
| N3 | 重复投递**同一笔支付** → **不产生第二条** COMMISSION 行 | e2e |
| N4 | 订单**从未支付** → **不产生** COMMISSION 行 | e2e |
| N5 | 回填后，流水表按区间聚合 == 报表的「抽佣收入 − 冲回」 | e2e（**对账**） |
| N6 | 回填**连跑两次** → 行数不变（幂等） | e2e |
| N7 | 回填**跳过** `refundedAt IS NULL` 的已退款订单，且**计数**报出来 | e2e + 单测 |
| N8 | 明细端点按商家汇总的净抽佣 == 该商家明细行之和 | e2e |
| N9 | 明细端点的商家名与 `Tenant.name` 一致 | e2e |
| N10 | **两个不同 eventId、同一 providerTxnId** → 订阅期**只延长一次**（M11 的实质） | e2e |
| N11 | `commissionAmount = 0` 的订单 → **不产生**流水行 | e2e |
| N12 | 有流水的订单**不能被物理删除**（`onDelete: Restrict`） | 迁移注释 + 手工验证 |

### 6.2 失败注入

| # | 注入 | 预期挂掉 |
|---|------|---------|
| F1 | 支付时不写 COMMISSION 行 | N1、N5 |
| F2 | 退款时不写 REVERSAL 行 | N2、N5 |
| F3 | 冲回行的金额**不取负** | N2、N5、N8 |
| F4 | 抽佣行在下单时写（而不是支付时） | N1、N4、N5 |
| F5 | 回填时**不过滤** `commissionAmount = 0` | N11 |
| F6 | 回填时**不过滤** `refundedAt IS NULL` | N7 |
| F7 | 回填用 `create` 而不是 `upsert`（第二次撞唯一索引） | N6 |
| F8 | 明细端点**前端自己算**净额（后端返回毛额） | N8 |
| F9 | M11 的新用例投递**同一个** eventId（退回 5b 的写法） | N10 |

### 6.3 M11 的断言细节

⚠️ **不能沿用 5b 的写法**。5b 的用例第二次投递用**同一个 eventId** → 被
`insertEvent` 的唯一索引挡在 `markInvoicePaid` **之前** → 断言「订阅期只延长一次」
**恒真**，测的不是那层防御。

新用例：

1. 造一张 OPEN 的订阅账单
2. 投递**第一个**事件（`eventId = E1`，`providerTxnId = T`）→ 订阅期延长一次
3. 投递**第二个**事件（`eventId = E2`，**同一个** `providerTxnId = T`）→ 事件表幂等挡不住
4. 断言 `subscription.currentPeriodEnd` **与第 2 步之前相同**（没有第二次延长）

⚠️ 第 4 步是关键：断言要落在**订阅期的值**上，不能落在「调用了几次」上 ——
后者可能被更上层的幂等（渠道侧 `providerTxnId` 唯一）挡掉，测的就不是 `markInvoicePaidInTx`。

### 6.4 浏览器手测

1. 平台后台「抽佣明细」页能打开，区间选择与报表页一致
2. 改一个商家的主题色 → 抽佣明细页**不受影响**（它不读主题）
3. 商家的订单支付后 → 明细页出现对应的 COMMISSION 行
4. 退款后 → 明细页出现 REVERSAL 行（金额为负）
5. 按商家汇总的净抽佣 == 明细行之和
6. 明细页显示的商家名与商家后台一致

---

## 七、遗留项

| # | 遗留 | 说明 |
|---|------|------|
| L17 | **平台收入报表仍从订单聚合**，没切到流水表 | 等生产回填完成、且对账 e2e 稳定通过后再切。切换前要先确认「生产已跑过回填」 |
| L18 | **结算单**没有做 | 流水表是它的前置。周期怎么切、跨周期退款怎么摊，是独立设计 |
| L19 | **抽佣出款**没有做 | 5b 遗留 1：只记账 |
| L20 | 回填**跳过的历史退款**（`refundedAt IS NULL`）永远不会被冲回 | 5b 之前退的款没记时间 → 归期不可知。现状报表同样跳过 → 口径一致，但这两笔抽佣在账上一直挂着 |

---

## 附：与既有设计的关系

- **阶段 5b（平台计费）**：本阶段做它的遗留 1 与 7（抽佣流水、结算单前置），
  并推翻它的决策 9（「抽佣不建独立表」）。决策 4（费率只配在套餐上）、
  决策 5（按实付抽）、护栏 M6/M7/M8/M13/M17 全部继续成立。
- **阶段 5d**：本阶段不碰主题与错误处理。5d 的遗留 L1/L12/L13/L16 与本阶段无关。
- **阶段 3（交易链路）**：抽佣挂在订单状态机上（支付成功 / 退款成功），
  流水只是把这两次状态变化**记成流水**。
