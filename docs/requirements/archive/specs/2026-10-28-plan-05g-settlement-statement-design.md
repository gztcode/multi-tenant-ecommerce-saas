# 阶段 5g 设计：结算单（按商家 × 自然月的应收单据）

> 阶段 5f（支付可靠性）已完成并合并（PR #14）。
> 本阶段接手 **5b 遗留 1 与 5e 遗留 L18**：把抽佣流水（5e）聚合成一张
> **「某商家 × 某自然月」的应收单据**。
>
> **日期**：2026-10-28
> **依据**：`docs/superpowers/specs/2026-10-27-plan-05e-commission-ledger-design.md`
> §一·1.3（结算单是独立的设计）、`docs/superpowers/specs/2026-10-25-plan-05b-billing-design.md`
> §十一·遗留 1 与 遗留 7

---

## 一、目标与范围

### 1.1 目标

1. **抽佣有了对外的单据**：平台按自然月给每个商家出一张结算单，
   单据上写明「这一期抽了多少、冲回多少、净额多少、依据哪几笔」，
   并且**确认后冻结**，不会因为后来的流水而变。
2. **账目可对账**：结算单的净额之和 **必须** 等于平台收入报表同期的抽佣净额。
   这条对账把「流水表」「报表」「结算单」三套数字锁在一起。

### 1.2 范围

| 编号 | 子项 | 涉及 |
|------|------|------|
| 5g-0 | 结算单的**数据模型与迁移** | `api/` |
| 5g-1 | 结算单的**生成 / 重算 / 确认 / 取消确认**（服务层） | `api/` |
| 5g-2 | 平台的**结算单端点**（列表 / 详情 / 生成 / 重算 / 确认 / 取消确认） | `api/` |
| 5g-3 | platform-admin 的**「结算单」列表页与详情页** | `platform-admin/` |
| 5g-4 | **对账护栏**（结算单净额之和 == 收入报表抽佣净额） | `api/` |
| 5g-5 | 验收 | 全栈 |

### 1.3 明确不做

| 不做 | 原因 |
|------|------|
| **抽佣出款**（打钱给商家） | 5b 的决策：出款是反向资金流，需要商户资质、对账与差错处理流程；本阶段只记账（5b 遗留 1 / 5e 的 L19） |
| **商家侧页面与接口** | 商家侧鉴权路径与平台侧完全不同（`@Roles(PLATFORM_ADMIN)` vs 租户作用域），工作量约翻倍。本阶段只做平台侧 |
| **把平台收入报表切到流水表** | ⚠️ 切换的前提是**生产已跑过 `npm run backfill:commissions`**。不切的话报表口径一点不变、零回归风险（5e 的 L18 仍挂着） |
| **「取消确认」的自动触发** | 本阶段只有超管手工点，没有自动作废 |
| **结算单的导出（CSV / PDF）** | 本阶段只在页面上看 |
| **明细行的分页** | 结算单详情一次返回全部明细行。金额量级上来后要分页（记为遗留） |
| 5f / 5d / 5c 的遗留 | 与结算单无关 |

---

## 二、事实基础

### 2.1 抽佣流水已就位（5e 的成果）

`api/prisma/schema.prisma` 里已有 `CommissionEntry`：

- **一笔抽佣一行、一笔冲回一行**，金额带符号：`COMMISSION` 的 `amount > 0`，`REVERSAL` 的 `amount < 0`。
- **归期口径**：`occurredAt` = 抽佣取 `paidAt`、冲回取 `refundedAt` ——
  与平台收入报表的归期口径**逐字一致**（5e 的 R5）。
- **唯一约束** `@@unique([orderId, type])`：一单一抽佣、一单一冲回。
- **append-only 的审计凭证**：不软删、`orderId` 外键 `Restrict`。

**这份表就是结算单的唯一数据源**。结算单不再从订单聚合 —— 那样会把
「抽佣 / 冲回」两套口径再抄一遍，迟早漂。

### 2.2 5b / 5e 对结算单的原始设想

| 出处 | 原文 |
|------|------|
| 5b §十一·遗留 1 | 「**抽佣出款不做** —— 只记账。将来做结算单时，从订单聚合出「本期抽佣 / 冲回 / 净额」。」 |
| 5b §九·决策 9 | 「**抽佣不建独立表** —— 报表 SQL 要跨订单聚合；将来做结算单时再抽一层。」 |
| 5e §一·1.3 | 「**结算单**（period 级的应收单据）…… 要定「周期怎么切」「跨周期退款怎么摊」，是独立的设计。」 |

⚠️ **5b 的「从订单聚合」已被 5e 的决策 D1 推翻**：5e 建了流水表，
结算单从**流水**聚合。理由与 5e 一致：从订单聚合算不出
「这一笔属于哪个商家的哪一次成交」。

### 2.3 仓库里已有的「单据」先例：`Invoice`

`Invoice`（5b）是本仓库里最接近结算单的东西，它的每个设计都有先例可循：

| Invoice 的做法 | 结算单怎么跟 |
|--------------|--------------|
| `number` 是对外凭证，服务端生成 | `statementNo` 同款（`STL` + 时间戳 + 随机数） |
| `@@unique([tenantId, number])` | ⚠️ 结算单用**全局** `statementNo @unique`（结算单号是对外凭证，不该在商家之间重复） |
| `@@unique([subscriptionId, periodStart])` —— 同一周期只有一张账单 | `@@unique([tenantId, periodStart])` —— 同一商家同一周期只有一张结算单 |
| 金额只从套餐价格读，**请求体不接受金额** | ⚠️ 结算单的金额**只从流水算**，请求体不接受任何金额字段 |
| 状态机 `OPEN → PAID / FAILED / VOID` | `DRAFT → CONFIRMED`（`PAID` 预留，见 §3·D5） |
| 免费周期**不出账单** | 该期**没有流水**的商家**不出结算单**（见 §4.4） |

⚠️ **Invoice 踩过的坑**（`invoice.service.ts` 的注释里写得很清楚）：
「撞 `(subscriptionId, periodStart)`」与「撞 `(tenantId, number)`」是**两回事**，
不区分就会把「号撞了」误判成「周期已经有账单了」→ **该周期永远不出账单**。
结算单的号生成照抄这个教训，但用**更稳的判别法**（见 §4.4）。

### 2.4 报表今天怎么聚合（为什么不切）

平台收入报表（`report.service.ts`）**仍然从订单聚合**：

- `commissionRevenue` = Σ `Order.commissionAmount` where `paidAt ∈ [from, to)`（**毛额**）
- `reversal` = Σ `Order.commissionAmount` where `status = REFUNDED` **and** `refundedAt ∈ [from, to)`（**正数**）
- `netRevenue` = `subscriptionRevenue + commissionRevenue − reversal`

⚠️ **报表口径与流水口径是「两套独立的实现碰巧一致」**：
5e 的对账 e2e 已经在保证它们相等（「流水表按区间聚合 == 报表的『抽佣收入 − 冲回』」）。

⭐ **这给 5g 送了一个现成的对账标尺**：
> 某期**所有结算单的净额之和** **必须** 等于**收入报表同期的 `commissionRevenue − reversal`**。

结算单基于流水、报表基于订单 —— 两条独立的路径给出同一个数，
这才是真正的「账对得上」。这条护栏是本阶段最有价值的测试（§4.7 的 S9）。

---

## 三、关键决策

| 编号 | 决策 | 理由 |
|------|------|------|
| **D1** | 结算单**落两张表**：`settlement_statements`（单据头）+ `settlement_statement_entries`（明细关联） | 纯报表视图没有「已确认」状态，同一期能反复出款；明细关联表让「这一期结了哪几笔」可追溯，并让「一笔流水只能被一期结算」成为数据层保证 |
| **D2** | 周期 = **自然月（UTC）**，左闭右开 `[月初 00:00Z, 次月初 00:00Z)` | 抽佣按成交**绝对时间**归期，用日历月切最直观；边界唯一、无歧义、跨商家可比 |
| **D3** | **冲回落退款发生期**（1 月支付、3 月退款 → 3 月单净额为负） | 与平台收入报表口径**逐字一致**（§2.4）。落回原支付期需要「已出款单据可被改写」的机制，且两边数字会对不上 |
| **D4** | **手工触发生成**（超管点按钮），不做定时任务 | 本期只有一个商家量级的商家需要结算；自动生成会在周期未结束时抢跑。定时任务是运维需求，不是本阶段的 |
| **D5** | 状态机 `DRAFT ⇄ CONFIRMED`，枚举里**预留 `PAID`** | `PAID` 本阶段不可达（不做出款），但出款阶段必然要用 —— **加枚举值要改 schema + 迁移**，预留比将来补省事。状态机的**可逆性**（取消确认）是为了修漏结（§3·D6） |
| **D6** | **`DRAFT` 可重算**（重建关联行与金额）；`CONFIRMED` 冻结，但**可取消确认**回到 `DRAFT` | 漏结的唯一来源是「回填补了历史流水」或「单据算错了」。没有回退路径，漏结就是死账 |
| **D7** | **生成要求周期已结束**（`periodEnd <= 数据库时钟`） | 周期内流水虽已基本齐了，但回填随时可能补进来。「本期数字还会变」的凭证没有意义 |
| **D8** | 金额三件套：`grossAmount` / `reversalAmount` / `netAmount`，**全部由后端算** | 前端再算一遍就成了第二套口径，账迟早对不上（5e 的同款原则） |
| **D9** | 一笔流水**只能被一期结算**（`@@unique([entryId])`） | 数据层兜底。正常路径下不可能触发（一笔流水的 `occurredAt` 只落在一个自然月），留着防手工改数据与将来引入的新功能 |
| **D10** | 「同一商家同一周期一张单」用 `@@unique([tenantId, periodStart])` + **先查后插** | 重复生成是**幂等**（返回既有单据），不是报错。与 Invoice 同款语义，但判别法更稳（§4.4） |
| **D11** | **报表口径不切** | 切换的前提是生产已回填。本阶段只给流水表加一个**消费方**，不动报表的算法 → 零回归风险（5e 的 L18 仍挂着） |
| **D12** | 结算单**登记进 `TENANT_SCOPED_MODELS`**；明细关联表**不登记**（它没有 `tenantId`） | 结算单是租户的数据（将来商家要看自己的），登记白名单后租户作用域下自动带 `tenantId` 条件。⚠️ 不登记会让 `assertTenantScopedModelsRegistered()` **在启动时直接失败** |

---

## 四、设计

### 4.1 数据模型

```prisma
enum SettlementStatus {
  /** 草稿：可重算、可取消确认 */
  DRAFT
  /** 已确认：金额与明细冻结 */
  CONFIRMED
  /** 已出款（阶段 5g 不做，出款阶段用） */
  PAID
}

model SettlementStatement {
  id           String @id @default(uuid())
  tenantId     String
  /** 结算单号（对外凭证，服务端生成） */
  statementNo  String           @unique
  /** 周期起点（含）。自然月月初 00:00:00Z */
  periodStart  DateTime
  /** 周期终点（不含）。次月月初 00:00:00Z */
  periodEnd    DateTime
  /** 抽佣毛额（整数分）：Σ COMMISSION.amount，恒 ≥ 0 */
  grossAmount  Int
  /** 退款冲回（整数分）：Σ REVERSAL.amount，**恒 ≤ 0** */
  reversalAmount Int
  /** 净额 = grossAmount + reversalAmount。**可以是负数** */
  netAmount    Int
  /** 纳入的流水笔数 */
  entryCount   Int              @default(0)
  status       SettlementStatus @default(DRAFT)
  /** 确认时间。null = 未确认 */
  confirmedAt  DateTime?
  createdAt    DateTime         @default(now())
  updatedAt    DateTime         @updatedAt

  entries SettlementStatementEntry[]

  // ⚠️ **同一商家同一周期只能有一张单**（D10）
  @@unique([tenantId, periodStart])
  // 列表按周期倒序翻页
  @@index([periodStart])
  // 按状态筛选（「有多少张草稿待确认」）
  @@index([status])
  @@map("settlement_statements")
}

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

⚠️ **`CommissionEntry` 要加反向关系**（Prisma 要求关系两端都声明，否则 schema 校验失败）：

```prisma
model CommissionEntry {
  // ...既有字段...
  /** 阶段 5g：被哪些结算单纳入了 */
  settlementEntries SettlementStatementEntry[]
}
```

**配套的四处登记**（漏了任何一处都跑不起来）：

| 位置 | 改什么 |
|------|--------|
| `api/src/common/tenant/tenant-models.ts` | `TENANT_SCOPED_MODELS` 加 `SettlementStatement`（⚠️ **不加则应用启动直接失败**，`assertTenantScopedModelsRegistered()` 是硬失败）。`SettlementStatementEntry` **不加**（它没有 `tenantId`） |
| `api/src/common/tenant/tenant-prisma.service.ts` | 加两个 getter：`settlementStatement`、`settlementStatementEntry`（该类用 getter 代理模型 delegate，**不加工具类就访问不到**） |
| `api/src/modules/billing/billing.module.ts` | 注册新的 provider 与 controller |
| `api/prisma/migrations/<时间戳>_add_settlement_statements/` | 迁移（见下） |

⚠️ **迁移不用 `prisma migrate dev`**：该命令在本项目会先提示「需要重置 public schema」
（历史迁移文件在应用后被改过，与 `_prisma_migrations` 的校验和不一致），
而项目明令禁用 `prisma migrate reset`（阶段 2 已因此踩坑）。
照 **5c / 5e 的先例**：`prisma migrate diff --from-migrations ... --to-schema-datamodel`
生成 SQL 后**手工裁剪**（diff 会把阶段 2/5a 的**手写部分唯一索引**当成漂移输出成
DROP INDEX，删了会导致后续 `migrate deploy` 失败），
再 `psql` 执行 + `prisma migrate resolve --applied`。

**几处刻意的选择**：

- **明细表不存金额快照**。金额从 `commission_entries` join 出来。
  流水是 append-only 的（不软删、不改），金额永不变 → join 出来的值与
  生成时算的值必然一致。多存一份就是**第二处数字来源**，迟早漂。
- **`entryId` 是全局唯一**（不是 `(statementId, entryId)` 复合唯一）。
  后者只能保证「同一张单里不重复」，前者才能保证「**一笔流水只能被一期结算**」（D9）。
  复合唯一是后者的弱化版，会放过「同一笔流水被两张单各结一次」。
- **`onDelete: Cascade`（statementId）**：明细行是单据的从属数据。
  单据本身**没有删除端点**（凭证不该被删），所以这个语义实际不触发。
- **`onDelete: Restrict`（entryId）**：与 `CommissionEntry.orderId` 的 Restrict 同款理由 ——
  已被结算单纳入的流水是账目的一部分。

### 4.2 周期：自然月（UTC）

**输入格式 `YYYY-MM`**（例如 `2026-10`），**不是** `from` / `to`。

⚠️ **为什么不用 `from` / `to`**：调用方自己算月边界容易算错（时区、月末），
而「2026 年 10 月」是超管的真实心智。用 `YYYY-MM` 后，
**月边界只由后端算一次**，前端与 CLI 都不需要知道「月末是 30 号还是 31 号」。

```ts
/** `YYYY-MM` → 该自然月的 [起点, 终点) */
export function resolveMonthlyPeriod(period: string): { from: Date; to: Date } {
  const matched = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!matched) throw new BadRequestException('周期格式非法：必须是 YYYY-MM');
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const from = new Date(Date.UTC(year, month - 1, 1));
  // ⚠️ **终点是次月 1 号 00:00Z**（右开区间）：
  //    10 月的区间是 [10-01, 11-01)，11 月的第一个瞬间不属于 10 月。
  //    `Date.UTC(year, month, 1)` 里 month 是「从 0 起的月序号」，
  //    传 month（即 10）就是「11 月」—— 这正是我们要的。
  const to = new Date(Date.UTC(year, month, 1));
  return { from, to };
}
```

⚠️ **`Date.UTC` 的月份是从 0 起的**：`Date.UTC(2026, 9, 1)` 是 10 月 1 号，
`Date.UTC(2026, 10, 1)` 是 11 月 1 号。写错就是差一个月。

⚠️ **周期边界与报表的区间语义一致**：`[from, to)` 左闭右开。
相邻两期不重不漏 —— 与 5b 的 `ReportService.resolveWindow` 同一套语义。

### 4.3 归期口径：抽佣按支付期、冲回按退款期

**这一条是 5g 与收入报表能对上账的根本**（§2.4）。

| 流水类型 | `occurredAt` | 落在哪一期 |
|---------|-------------|-----------|
| `COMMISSION` | `paidAt` | **支付**所在的自然月 |
| `REVERSAL` | `refundedAt` | **退款**所在的自然月 |

举例：一笔 1 月支付（抽佣 100）、3 月退款（冲回 −100）：

| 周期 | 毛额 | 冲回 | 净额 |
|------|------|------|------|
| 1 月 | 100 | 0 | **+100** |
| 3 月 | 0 | −100 | **−100** |

两期净额合起来是 0 —— 这笔单对平台的净贡献就是 0 ✅。
**3 月的结算单净额为负**是合法的：平台那一期「倒欠」商家钱。

⚠️ **净额为负的结算单必须能表达**（用户已确认）：前端要显示 `¥-100.00`，
不能显示成 `—` 或 `0.00`。`formatRevenueLabel` 直接吃负数即可（`centsToYuan` 支持）。

### 4.4 生成

```
POST /platform/settlements
body: { period: 'YYYY-MM', tenantId?: string }
→ { items: SettlementStatement[], created: number, skipped: number }
```

**流程**：

1. 解析周期 → `[periodStart, periodEnd)`。
2. **校验周期已结束**（D7）：`periodEnd <= 数据库时钟`。不满足 → 400。
3. **确定商家范围**：
   - 传了 `tenantId` → 就是这一个商家。
   - 没传 → **该期有流水的所有商家**（`commission_entries` 按 `tenantId` 分组）。
4. **对每个商家**（各自一个事务，见下）：
   1. **先查后插**：查 `(tenantId, periodStart)` 是否已有单据。
      - 有 → **跳过**（幂等），`skipped++`，把既有单据放进 `items`。
   2. 查该商家该期的流水（`occurredAt ∈ [periodStart, periodEnd)`）。
      - 一条都没有 → 该商家不生成单据（**免费周期不出账单**的同款理由）。
        - ⚠️ 显式传了 `tenantId` 而该商家本期无流水 → **404**
          （超管明确点名了商家，「这家没流水」是要知道的事实）；
          批量时静默跳过（不能因为一个商家没流水就中断整批）。
   3. 算三个金额 → 建单据（DRAFT）→ 建明细关联行。
   4. **撞号处理**（§2.3 的坑）：

      ```
      for (attempt = 0; attempt < 5; attempt++) {
        try {
          create(statement)   // statementNo 每次重新生成
          break
        } catch (e) {
          if (!isUniqueViolation(e)) throw e
          // ⚠️ **不靠 error.meta.target 判别**（Invoice 的做法在
          //    不同驱动版本下形状不一致），而是**重新查一次**：
          const existing = await findStatement(tenantId, periodStart)
          if (existing) {
            // 撞的是 (tenantId, periodStart) → 并发下别人先生成了 → 幂等返回它
            return existing
          }
          // 查不到 → 撞的是 statementNo → 换个号再来
        }
      }
      ```

      ⭐ 这个「catch 后重新查」的判别法**比 Invoice 的更稳**：
      它不看错误的形状，只看「目标单据现在存不存在」。
   5. 建明细关联行：`createMany`（一批行）。`entryId` 唯一约束兜底（D9）。

**返回值语义**：`items` = **本次涉及的商家对应的单据**（新建的 + 因幂等而复用的），
`created` = 新建了几张，`skipped` = 因为「该期已有单据」而复用了几张。
恒等式：`items.length === created + skipped`。

**请求体校验放在 DTO**（`CreateSettlementDto`）：

```ts
export class CreateSettlementDto {
  /** 周期。必须是 YYYY-MM */
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '周期格式非法：必须是 YYYY-MM（如 2026-10）' })
  period!: string;

  /** 指定商家。缺省 = 该期所有有流水的商家 */
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
```

⚠️ **`period` 的格式在 DTO 里挡掉**（而不是等到 service 抛）——
全局 `ValidationPipe` 开了 `whitelist` + `forbidNonWhitelisted` + `transform`，
非法输入会得到一句明确的 400，而不是「周期格式非法」这种要靠 service 兜的错。

⚠️ **请求体里没有任何金额字段**（D8）：结算单的金额**只从流水算**。
客户端传什么都不作数 —— DTO 的 `forbidNonWhitelisted` 会直接 400 多传的键。

**每个商家一个事务**，不是一个大事务：
- 100 个商家 × 每人 10 笔流水 = 1100 次插入，塞进一个事务会撞 10 秒超时。
- 分开之后，某个商家失败只影响那一个，其余照常生成（返回值里能看到 `skipped`）。

**金额计算**：

```ts
const gross = entries.filter((e) => e.type === 'COMMISSION')
  .reduce((sum, e) => sum + e.amount, 0);
const reversal = entries.filter((e) => e.type === 'REVERSAL')
  .reduce((sum, e) => sum + e.amount, 0);   // ⚠️ 已经是负数，不再取负
const net = gross + reversal;
```

⚠️ **冲回不要再取一次负**：流水的 `REVERSAL.amount` 本身就是负数
（5e 的 N2 护栏）。再取负会让净额翻倍。

⚠️ **三个金额由后端算完写进单据**（D8），前端只展示。

### 4.5 重算

```
POST /platform/settlements/:id/recalculate
→ { statement: SettlementStatement, entryCount: number }
```

- **只有 `DRAFT` 能重算**。`CONFIRMED` 调它 → **409 Conflict**
  （已确认的单据是冻结的，要改先取消确认）。
- 流程（**在一个事务里**）：
  1. 删掉这张单据的全部明细关联行（`deleteMany({ where: { statementId } })`）。
     —— 这一步同时**释放了 `entryId` 的唯一占用**，否则重新插入会撞自己。
  2. 重新聚合该商家该期的流水。
  3. 重建关联行 + 更新三个金额与 `entryCount`。

⚠️ **重算不会改变 `status`**：重算后仍是 `DRAFT`（它本来就是 DRAFT 才让重算）。

### 4.6 确认 / 取消确认

```
POST /platform/settlements/:id/confirm    → SettlementStatement
POST /platform/settlements/:id/unconfirm  → SettlementStatement
```

| 当前状态 | `confirm` | `unconfirm` |
|---------|----------|------------|
| `DRAFT` | → `CONFIRMED`，记 `confirmedAt` | 400（没确认过，不能取消） |
| `CONFIRMED` | **幂等**：原样返回 | → `DRAFT`，清 `confirmedAt` |
| `PAID` | 幂等返回 | 400（已出款，不能取消） |

⚠️ **幂等用「条件更新」实现**（`updateMany` where 带 `status`），
不是「先查后写」—— 两次并发确认不能都成功：

```ts
const affected = await tx.settlementStatement.updateMany({
  where: { id, status: SettlementStatus.DRAFT },
  data: { status: SettlementStatus.CONFIRMED, confirmedAt: now },
});
// affected.count === 0 → 已经是 CONFIRMED（或不存在）→ 幂等返回
```

⚠️ **`SettlementStatement` 在 `TENANT_SCOPED_MODELS` 里** →
扩展**禁止** `update` / `findUnique` / `delete` / `upsert`（`assertNotUniqueOnly`）。
必须用 `findFirst` + `updateMany`（与 `InvoiceService.markInvoicePaidInTx` 同款）。

### 4.7 查询端点

⚠️ **端点归属**：新建 `PlatformSettlementController`
（`@Controller('platform')` + `@Roles(UserRole.PLATFORM_ADMIN)`），
**不塞进 `PlatformReportController`** —— 后者的职责是「报表与订阅列表」，
结算单是另一个子域，混在一起两边都难读。
路径前缀与鉴权注解与 `PlatformReportController` **完全同款**
（`@Roles` 自带 `JwtAuthGuard`，未登录 401、商家账号 403）。

| 端点 | 说明 |
|------|------|
| `GET /platform/settlements` | 列表。query：`period`（`YYYY-MM`，可选）、`status`（可选）、`page`（默认 1）、`pageSize`（默认 50，最大 200）。返回 `{ items, total }` |
| `GET /platform/settlements/:id` | 详情。返回单据头 + `tenantName` / `subdomain` + 明细行数组 |

**列表的排序**：`periodStart` 倒序，同期按 `createdAt` 倒序。

⚠️ **`total` 要是真实总数**，不能用 `items.length`（`items` 被 `pageSize` 截断了）。
超管看到「总共 50 条」而实际有 500 条会以为平台只有 50 张单。
（与 `ReportService.listSubscriptions` 的同款理由。）

**详情的明细行**从 `commission_entries` join 出来：

```ts
{
  entryId, orderNo, type, amount, rateBps, baseAmount, occurredAt
}
```

⚠️ **明细不分页**（本阶段）。结算单一笔通常只有几十到几百行，
量级上来后要分页（记为遗留）。

### 4.8 「漏结」这个洞与它的堵法

**场景**：3 月的结算单已 `CONFIRMED`。之后运维跑了
`npm run backfill:commissions`，补进了 3 月的一笔历史流水（100 分）。
→ 3 月的结算单净额少了 100 分，**且永远不会自动修正**。

⭐ **三条防线**：

| 防线 | 作用 |
|------|------|
| ① **生成要求周期已结束**（D7） | 正常流程下周期末流水就齐了（详见 §4.3 的三种情形），生成即完整 |
| ② **DRAFT 可重算**（D6） | 单据还没确认时重算一次即可修正 |
| ③ **CONFIRMED 可取消确认**（D6） | 已确认的也能退回来重算 |

⚠️ **⚠️ 防线 ③ 需要配合「取消确认」**：没有它，漏结就是死账。
这就是本阶段要多一个 `unconfirm` 端点的全部理由。

⚠️ **仍然存在的一个洞**（**记为遗留 L27**）：
如果 3 月已**出款**（本阶段不做）之后再回填，账就真的对不上了。
出款阶段必须解决这个 —— 至少要禁止对已出款的周期做回填。

### 4.9 platform-admin 的页面

**`/settlements`（列表页，Server Component）**：

- 顶部：**周期选择**（`<input type="month">`，原生月份选择器，值就是 `YYYY-MM`）
  + **状态筛选** + 「查询」（纯 GET 表单，与抽佣明细页同款）。
- 「**生成结算单**」按钮（客户端组件）：
  - 选一个周期 → POST `/api/billing/settlements` → `router.refresh()`。
  - ⚠️ **必须 `confirm()` 确认**：这是批量写操作，一次会给一批商家建单。
- 表格：商家 / 子域名 / 周期 / 状态 / 毛额 / 冲回 / 净额 / 笔数 / 单号。
  - 金额列**直接用后端返回的三个数**，前端不加总（D8）。
  - 状态列给中文文案（草稿 / 已确认 / 已出款）。
- 每行的操作：**确认**（DRAFT 时可点）、**重算**（DRAFT 时可点）、
  **取消确认**（CONFIRMED 时可点）。
  - 重算与取消确认也要 `confirm()`（改的是账）。

**`/settlements/[id]`（详情页，Server Component）**：

- 单据头：单号、商家、周期、状态、三个金额、笔数、确认时间。
- 明细表：时间 / 订单号 / 类型 / 金额 / 费率 / 计佣基数。
  - 与抽佣明细页的表格同款（可复用组件，但**不要**过度抽象 —— 两处的列不一样）。

**同源中转路由**（写操作不能直连后端：跨域 + token 不能进客户端）：

| 路由 | 方法 | 转发到 |
|------|------|--------|
| `/api/billing/settlements` | POST | `POST /platform/settlements` |
| `/api/billing/settlements/[id]/confirm` | POST | `POST /platform/settlements/:id/confirm` |
| `/api/billing/settlements/[id]/unconfirm` | POST | `POST /platform/settlements/:id/unconfirm` |
| `/api/billing/settlements/[id]/recalculate` | POST | `POST /platform/settlements/:id/recalculate` |

⚠️ **中转要按白名单重建请求体**（与 `plans/plan-body.ts` 同款纪律）：
`period` 必须匹配 `YYYY-MM`，`tenantId` 必须是 UUID 或不传。
**金额永远不在请求体里**（D8）。

**前端类型**放 `platform-admin/src/lib/billing.ts`（结算单就是计费的一部分，
金额换算函数直接复用 `formatRevenueLabel`，**不另造第二处换算**）。

---

## 五、风险清单

| # | 风险 | 后果 | 处置 |
|---|------|------|------|
| R1 | 结算单与收入报表口径漂移 | 账对不上 | S9 的对账护栏（净额之和 == 报表净额） |
| R2 | 一笔流水被两期结算 | 平台重复计收 | `@@unique([entryId])`（D9） |
| R3 | 同一期重复生成 | 同一商家两张单 | `@@unique([tenantId, periodStart])` + 先查后插（D10） |
| R4 | 结算单号撞号被误判成「该期已有单」 | 该商家该期永远不出单 | catch 后**重新查一次**判别（§4.4） |
| R5 | 净额为负的结算单在前端显示成 0 或 `—` | 超管以为没冲回 | `formatRevenueLabel` 直接吃负数；S10 断言 |
| R6 | 已确认的单据被后来的回填改出缺口 | 账少了 | 取消确认 + 重算（D6）；遗留 L27 记下「已出款后回填」这个洞 |
| R7 | 漏结发生后**没人知道** | 账少了且无人察觉 | S9 的对账护栏在测试里持续盯着；生产上靠超管定期看 |
| R8 | 忘了给 `SettlementStatement` 登记白名单 | **应用启动直接失败** | D12；`assertTenantScopedModelsRegistered()` 是硬失败，不会静默 |
| R9 | 忘了加 `TenantPrismaService` 的 getter | 编译不过 | 编译期能抓到 |
| R10 | 明细行一次返回全部 | 响应无界膨胀 | 本阶段可接受；记为遗留 |

---

## 六、测试策略

### 6.1 新增的护栏（S1–S12）

| 编号 | 护栏 | 期望 |
|------|------|------|
| **S1** | 生成只纳入**该商家该自然月**的流水 | 上月的、下月的、别的商家的都不进单据 |
| **S2** | 三个金额由**后端**算 | `grossAmount` / `reversalAmount` / `netAmount` 与逐笔之和一致 |
| **S3** | **同一商家同一周期只有一张单** | 重复生成返回同一张（`created` 不变），不产生第二张 |
| **S4** | **一笔流水只能被一期结算** | 同一笔 `entryId` 不能出现在两张单据里 |
| **S5** | **跨期冲回落退款期** | 1 月支付 / 3 月退款 → 3 月单净额为负；1 月单净额不变 |
| **S6** | **重算只有 DRAFT 能做** | `CONFIRMED` 重算 → 409 |
| **S7** | **确认幂等**；`CONFIRMED` 后金额冻结 | 重复确认不报错；确认后重算被拒 |
| **S8** | **鉴权**：商家账号 → 403；未登录 → 401 | 全部端点 |
| **S9** | ⭐ **对账**：某期所有结算单的净额之和 == 收入报表同期的 `commissionRevenue − reversal` | 两套独立路径给出同一个数 |
| **S10** | **零额与负额**：净额为 0 / 为负的结算单都正常生成与展示 | 负数不被截成 0 |
| **S11** | **周期未结束不能生成** | → 400 |
| **S12** | **列表的 `total` 是真实总数** | 不是 `items.length` |

### 6.2 失败注入（**逐条单独跑**，不叠加）

| # | 注入 | 期望挂掉 |
|---|------|---------|
| F1 | 生成时不按 `tenantId` 过滤（把别家的流水也纳进来） | S1 |
| F2 | 生成时用 `occurredAt ≤ periodEnd`（右闭区间） | S1（跨月的流水被多算） |
| F3 | 生成时不加 `@@unique([tenantId, periodStart])` 的幂等处理 | S3 |
| F4 | 重算时不删旧的明细关联行 | S4（`entryId` 唯一约束冲突 → 整批失败） |
| F5 | 冲回金额**再取一次负** | S2 / S5 / S9 |
| F6 | 确认时不带 `status` 条件更新 | S7（并发确认两次都成功） |
| F7 | 周期校验去掉 | S11 |

⚠️ **逐条单独跑**：阶段 5c 的教训 ——
「注入 A + 注入 B 叠加 → 挂 N 条」**不能**用来证明 A 缺独立锁点，
叠加时 A 的代码可能根本没机会执行。

⚠️ **「单打一层不挂」可能是双层防线**：5f 的 F3 就是这样 ——
「已过支付期限」在扫描器的 `where` 与 service 的判定里各有一层，
单独打掉一层测不出东西。遇到这种情况要**先确认是不是双层**，再下结论。

### 6.3 浏览器手测

1. 超管登录 platform-admin → 「结算单」页 → 选一个**过去的月份** → 点「生成」。
2. 列表出现该期各商家的单据 → 金额与抽佣明细页同期对得上。
3. 点进详情 → 明细行与抽佣明细页逐笔一致。
4. 点「确认」→ 状态变「已确认」→ 再点「确认」→ 不报错。
5. 点「重算」→ 被拒（已确认）。
6. 点「取消确认」→ 状态回「草稿」→ 点「重算」→ 金额不变（没有新流水）。

---

## 七、遗留项

| 编号 | 内容 |
|------|------|
| **L18** | **把平台收入报表切到流水表** —— 5e 留下的，仍未做。前置是「生产已跑过 `npm run backfill:commissions`」 |
| **L19** | **抽佣出款** —— 5b 遗留 1 / 5e 的 L19。本阶段只记账 |
| **L20** | **回填跳过的历史退款**（`refundedAt IS NULL`）永远不会被冲回 —— 5e 的 L20 |
| **L27** | **已出款的周期被回填** —— 本阶段新增。出款阶段必须禁止对已出款的周期做回填，或提供调账机制 |
| **L28** | **结算单明细不分页** —— 量级上来后要分页 |
| **L29** | **商家侧看不到自己的结算单** —— 本阶段只做平台侧 |
| **L30** | **结算单没有导出**（CSV / PDF） |
| **L31** | **「漏结流水」的主动告警** —— 现在只有对账护栏在测试里盯着，生产上要靠超管定期对账 |

---

## 附：与既有设计的关系

- **阶段 5b**（平台计费）：遗留 1（结算单）与遗留 7（抽佣流水的前置）在本阶段落地；
  遗留「抽佣出款」仍挂着（L19）。
- **阶段 5e**（抽佣流水）：`CommissionEntry` 是本阶段的**唯一数据源**；
  5e 的 L18（切报表口径）仍挂着。
- **阶段 5f**（支付可靠性）：不相关。
