# 计划 5b：平台计费（订阅套餐、抽佣记账、平台报表）设计文档

| 文档日期 | 2026-10-25 |
|---------|-----------|
| 文档状态 | 待用户审阅 |
| 前置 | 阶段 5a「营销（优惠券与满减活动）」已验收并合并（PR #9，验收记录见 `2026-10-25-plan-05a-acceptance.md`） |
| 后续 | 阶段 5c（修阶段 4 挖出来的技术债：令牌宽限期、主题 token、组件测试基建） |

> **本文档是实施计划的权威依据。** 实施计划 `2026-10-25-plan-05b-billing.md` 是本文档的可执行展开，两者冲突时以本文档为准。
>
> **本文档的决策来自与用户的一轮澄清**（范围、动钱深度、套餐差异、抽佣配置层级、抽佣基数、
> 续费方式、到期行为、支付链路接法）。每一处的取舍与放弃的东西都记在 §二。

---

## 一、目标与非目标

### 目标

让平台能**卖订阅**：平台超管配置套餐（价格、周期、试用期、抽佣费率、额度与功能权限），
商家订阅并在到期时续费；平台按订单**实付**抽佣记账，并出一份平台收入报表。

### 非目标（本阶段明确不做）

| 不做 | 原因 |
|------|------|
| 发票、税务、账单 PDF | 主设计 §10.2 明文「不做」 |
| **抽佣出款打给商家** | 出款是反向资金流，需要商户资质、对账与差错处理流程；本阶段只记账 |
| 升级套餐的**差价计算** | 换套餐在**下个周期**生效，当前周期不退款不补差价 |
| 多币种、汇率 | 主设计 §5 是「国际化与生态」，可选阶段 |
| 部分退款 | 阶段 3 只支持整单退款，本阶段延续 |
| 试用期之后再「补缴试用期的钱」 | 试用是免费周期，不产生账单 |
| 优惠券与「平台券」之外的计费维度 | 主设计 §10.2 只列了订阅与抽佣 |

### 阶段 5b 覆盖的「计划 5」剩余部分

| 计划 5 的三块 | 状态 |
|---|---|
| 营销（优惠券与满减活动） | **阶段 5a 已完成**（PR #7/#8/#9） |
| 平台计费（订阅 + 抽佣 + 报表） | **本阶段（5b）** |
| 平台超管的完整实现 | **已有**商家列表与详情（阶段 1）。本阶段加**计费相关页**（套餐 / 订阅 / 报表）；「平台营销页」（平台券的前端入口，阶段 5a 的遗留）与商家管理的增强留到 5c |
| 修阶段 4 挖出来的问题 | **阶段 5c**（本阶段顺手做掉其中一项：platform-admin 的测试基建） |

---

## 二、关键决策速查

| # | 决策 | 放弃了什么 | 为什么 |
|---|------|-----------|--------|
| 1 | **5b 只做平台计费**，阶段 4 的技术债另开 5c | 一轮清完所有欠账 | 计费自成一块，与「改认证核心」混在一起会让验收风险叠加。技术债不急，计费涉及钱，边界要清楚 |
| 2 | **订阅付款走支付渠道**（复用阶段 3 的 `PaymentProvider` + 假网关），**抽佣只记账** | 抽佣自动出款 | 与阶段 3 一致：假网关是「能跑通全链路的真渠道」，订阅的幂等/金额核对/webhook/失败重试都被走到。出款没有现成的渠道抽象 |
| 3 | **套餐之间靠「功能权限 + 数量额度」区分** | 只做价格与期限 | 只做价格的话，商家付了钱却得不到任何可感知的差别，订阅制没有实质意义 |
| 4 | **抽佣比例只配在套餐上**（不设商家级覆盖） | 商家级覆盖层 | 真实 SaaS 迟早要「给大客户单独谈抽成」，但那是**配置项**不是**架构**——真出现需求时加一个可空的覆盖字段即可。少一层现在用不上的配置 |
| 5 | **抽佣按实付抽**（基数 = `order.totalAmount`） | 按原价抽 | 平台分的是「真实成交的钱」；且与支付链路的金额核对同源（退款额 = 实付额，护栏 M13）。按原价抽的话，高折扣时平台佣金可能大于商家实收 |
| 6 | **自动续费 + 手动续费兜底** | 只自动 / 只手动 | 只自动：扣款失败时商家无法自救。只手动：主设计写的「按月自动续费」没实现，且商家忘了续费就停服 |
| 7 | **到期 → 停止接新单，商家后台全部可用** | 到期后台也只读 | 停服是平台的权利，但把商家锁死（连发货与退款都做不了）是坑商家，客诉会直接落到平台头上 |
| 8 | **复用并泛化阶段 3 的支付链路**（`payments` 表加 `kind`、可空 `orderId`、新增 `invoiceId`） | 订阅独立一套支付表 | 订阅独立一套 = 支付处理逻辑写第二遍，以后每加一种收款（充值、提现、广告费）就再复制一遍。泛化一次，长期省 |
| 9 | **抽佣不建独立表**，存成订单上的两个快照字段 | `commissions` 表 | 抽佣的「分叉点」只有一个 —— 支付成功（订单状态机已表达），退款也是订单状态。阶段 5a 的 `coupon_redemptions` 需要独立表，是因为核销有自己的生命周期；抽佣没有 |
| 10 | **试用期挂在套餐上**（`trialDays`），不挂租户 | 全局「试用套餐」 | 不需要「哪个套餐是试用套餐」这个额外概念与它的唯一性约束。代价：注册后**没有订阅就不能接单** |
| 11 | **额度用具体列，功能开关用 Json** | 全部用 Json / 全部用列 | 额度要在业务路径上**强制执行**，具体列能被编译期发现漏判；功能开关是纯键值对，加功能不该改表 |
| 12 | **额度与功能权限实时读当前套餐**，费率在订单上快照 | 全部快照 / 全部实时 | 额度改了就该立刻生效（商家页面显示什么就是什么）；费率影响已成交的钱，必须快照（护栏 M7） |

---

## 三、数据模型

> 金额一律**整数分**（全局约定）。费率用**基点**（basis points，万分之一）：`500` = 5%。
> 抽佣额 = `Math.round(实付 × rateBps / 10000)`，封顶到实付（护栏 M6）。

### 3.1 plans（套餐）

⚠️ **套餐是「平台的数据」，不是「租户的数据」** —— 它**不带 `tenantId` 字段**。

先例是阶段 3 的 `PaymentWebhookEvent`（刻意不带 `tenantId`，注释写着
「它是渠道事件的数据，不是租户的数据」）。`TenantPrismaService` 的启动断言
只要求「**带** `tenantId` 字段的模型必须登记」，所以不带 `tenantId` 的表
天然不在租户作用域里，扩展对它不附加任何条件。

> ⚠️ **为什么不用「挂在平台租户下」**：那要额外引入「平台租户」这个概念 ——
> 要么 seed 里造一个专门的租户，要么让超管每次创建套餐都手填一个归属租户 id
> （阶段 5a 的平台券就是这么做的，但对套餐是纯噪音：**套餐本来就是全局的**，
> 它挂在哪个租户下都不影响可见性）。
> 不带 `tenantId` 就没有这个问题。

```prisma
enum PlanStatus {
  ACTIVE
  DISABLED
}

model Plan {
  id          String    @id @default(uuid())
  code        String
  name        String
  description String?
  /** 周期价格（整数分）。0 = 免费 */
  price       Int
  /** 订阅周期（天）。30 = 按月 */
  periodDays  Int       @default(30)
  /** 试用期（天）。0 = 无试用 */
  trialDays   Int       @default(0)
  /** 抽佣比例（基点，万分之一）。500 = 5% */
  commissionBps Int     @default(0)
  /** 商品数上限。null = 不限 */
  maxProducts Int?
  /** SKU 数上限。null = 不限 */
  maxSkus     Int?
  /** 店铺数上限。null = 不限。默认 1（绝大多数套餐只允许一个店铺） */
  maxStores   Int?     @default(1)
  /** 功能开关。缺省一律视为 false（保守） */
  features    Json      @default("{}")
  status      PlanStatus @default(ACTIVE)
  /** 展示顺序（小的在前） */
  sortOrder   Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([code])
  @@index([status, sortOrder])
  @@map("plans")
}
```

`features` 的键（**用常量定义，不写字面量**）：

```typescript
/** 能不能用优惠券与满减活动 */
export const FEATURE_MARKETING = 'marketing';
```

> ⚠️ **额度与功能开关的「缺省」方向相反**：额度字段是 `null` 表示**不限**
> （与阶段 5a 的 `totalLimit: null` 同款），功能开关缺省是**没有**
> （`features` 里没有这个键 = false）。前者是「不设限」，后者是「不给权限」。
>
> ⚠️ **「能不能开多个店铺」不放在 `features` 里** —— 它就是「店铺数上限」，
> 用 `maxStores` 表达（默认 1）。两个机制表达同一件事会分叉
> （「`multiStore = true` 但 `maxStores = 1`」该听谁的？）。
> `features` 只留「有 / 无」型的功能。

### 3.2 subscriptions（订阅）

⚠️ **一个租户只有一条当前订阅**（`@@unique([tenantId])`）。历史不在这里 ——
历史在 `invoices` 里（每期一张账单，带套餐快照）。订阅是「当前状态」，账单是「历史」。

```prisma
enum SubscriptionStatus {
  TRIAL
  ACTIVE
  EXPIRED
  CANCELLED
}

model Subscription {
  id           String             @id @default(uuid())
  tenantId     String
  /** 套餐 id。⚠️ **纯标量，不声明 Prisma 关系** —— 套餐是平台的数据
   *  （不带 tenantId，见 §3.1），订阅是租户的数据，
   *  跨域的外键会让「挂到一张不存在的套餐上」悄悄通过。
   *  与阶段 5a 的 `CouponClaim.couponId` 同款。 */
  planId       String
  /** 待生效的套餐（下个周期生效）。null = 不换 */
  pendingPlanId String?
  status       SubscriptionStatus @default(TRIAL)
  startedAt    DateTime           @default(now())
  /** 试用截止。null = 不是试用 */
  trialEndsAt  DateTime?
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  /** 到期后不自动续费 */
  cancelAtPeriodEnd  Boolean        @default(false)
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  @@unique([tenantId])
  @@index([tenantId, status])
  @@map("subscriptions")
}
```

### 3.3 invoices（账单）

⚠️ **`@@unique([subscriptionId, periodStart])` 是护栏 M5 的数据层保证**：
同一周期只能有一张账单 —— 否则重复的续费回调会让订阅期翻倍。

```prisma
enum InvoiceStatus {
  OPEN
  PAID
  VOID
  FAILED
}

model Invoice {
  id             String        @id @default(uuid())
  tenantId       String
  subscriptionId String
  /** 套餐 id 快照（纯标量，同 3.2） */
  planId         String
  /** 账单号（对外凭证，会出现在渠道页面与对账单里） */
  number         String
  /** 应付金额（整数分）。只从套餐价格读，不从请求体读（护栏 M9） */
  amount         Int
  status         InvoiceStatus @default(OPEN)
  periodStart    DateTime
  periodEnd      DateTime
  /** 应付截止（一般是周期结束日） */
  dueAt          DateTime
  paidAt         DateTime?
  voidedAt       DateTime?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  // ⚠️ 账单与订阅**同租户**，所以是真关系（不像 planId 那样是跨租户纯标量）
  subscription Subscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)

  @@unique([tenantId, number])
  @@unique([subscriptionId, periodStart])
  @@index([tenantId, status])
  @@map("invoices")
}
```

### 3.4 payment_methods（支付方式）

自动续费需要「已授权的支付方式」。⚠️ **真实渠道的授权凭证必须加密存** ——
本项目的假网关给的是明文假 token，注释里写清楚这个边界。

```prisma
model PaymentMethod {
  id        String   @id @default(uuid())
  tenantId  String
  provider  String
  channel   String
  /** 支付方式类型：CARD / WECHAT / ALIPAY */
  type      String
  /**
   * 渠道侧的授权凭证。
   * ⚠️ **真实渠道必须加密存**（可解密的密文，不能是哈希 ——
   *  自动续费要拿它去扣款，不是用来比对的）。
   *  本阶段的假网关给的是明文假 token。
   */
  token     String
  isDefault Boolean  @default(false)
  /** 授权过期时间。null = 不过期 */
  expiresAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
  @@map("payment_methods")
}
```

### 3.5 payments 表的泛化（动阶段 3 的核心）

```prisma
enum PaymentKind {
  ORDER
  SUBSCRIPTION
}

model Payment {
  id            String        @id @default(uuid())
  tenantId      String
  /** 这笔支付单是订单支付还是订阅支付 */
  kind          PaymentKind   @default(ORDER)
  /** 订单支付时填；订阅支付为 null */
  orderId       String?
  /** 订阅支付时填；订单支付为 null */
  invoiceId     String?
  channel       String
  provider      String
  status        PaymentStatus @default(PENDING)
  providerTxnId String?
  amount        Int
  rawResponse   Json          @default("{}")
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  order   Order?   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  invoice Invoice? @relation(fields: [invoiceId], references: [id], onDelete: Cascade)

  @@index([tenantId, status])
  @@map("payments")
}
```

⚠️ **索引必须手写，且要改成部分唯一索引**：

```sql
-- 原来：CREATE UNIQUE INDEX "payments_orderId_channel_key" ON "payments"("orderId","channel");
-- ⚠️ orderId 变可空后，PostgreSQL 的 NULL **不参与唯一判定** ——
-- 多个 NULL 互不冲突 → 「同一个账单同一渠道只能有一笔支付单」这条保证没了，
-- 点两次「去支付」会建出两笔支付单。
DROP INDEX "payments_orderId_channel_key";
CREATE UNIQUE INDEX "payments_order_channel_uniq"
  ON "payments" ("orderId","channel") WHERE "orderId" IS NOT NULL;
CREATE UNIQUE INDEX "payments_invoice_channel_uniq"
  ON "payments" ("invoiceId","channel") WHERE "invoiceId" IS NOT NULL;
```

⚠️ **`payments_provider_txn_uniq`（provider, providerTxnId）保持不变** ——
它与 orderId 无关，泛化后仍然有效。

### 3.6 orders 的新增字段（抽佣快照）

```prisma
  /** 抽佣费率快照（基点）。下单时从套餐读，写死在订单上 */
  commissionRate Int @default(0)
  /** 抽佣额快照（整数分）。下单时按实付算出 */
  commissionAmount Int @default(0)
```

⚠️ **与阶段 5a 的券快照同款**：下单那一刻算出来、写死在订单上。
改套餐的费率**不影响已成交的订单**（护栏 M7），未来的单用新费率。

### 3.7 租户隔离登记

⚠️ **三张新表必须登记**进 `TenantPrismaService` 的 `TENANT_SCOPED_MODELS`
（`subscriptions` / `invoices` / `payment_methods`），否则**服务启动直接失败**
（`assertTenantScopedModelsRegistered` 会扫 schema）。

⚠️ **`plans` 刻意不登记** —— 它不带 `tenantId` 字段，扩展对它不附加任何条件
（与阶段 3 的 `PaymentWebhookEvent` 同款，见 §3.1）。
`Payment` **仍在**名单里（阶段 3 登记的），泛化不影响它的租户作用域行为。

⚠️ **`payment_methods` 是敏感数据**（存渠道授权凭证）——
它必须在租户作用域里，且**不允许跨租户读**。

### 3.8 TenantStatus 的收敛

现在 `TenantStatus` 有 `TRIAL / ACTIVE / SUSPENDED` 三个值。引入订阅后会有**两个真相源**
（租户状态 vs 订阅状态）。决定：

- **`Tenant.status` 收敛为 `ACTIVE / SUSPENDED`**，语义是「账号有没有被平台停用」。
- `TRIAL` 值废弃：迁移里把现有 `TRIAL` 的行改成 `ACTIVE`，再 `ALTER TYPE ... DROP VALUE 'TRIAL'`。
- **试用状态完全由 `Subscription.status` 表达**。
- `SUSPENDED` 的行为不变（JWT 策略拦登录、租户解析拦请求）—— 这是「平台封禁」，
  与「订阅到期」是**正交**的两件事。

---

## 四、支付链路的泛化

### 4.1 `PaymentProvider` 的输入输出改名

⚠️ **现有的 `orderId` 字段名是误导**：阶段 3 实际传的是**支付单 id**
（`provider.createPayment({ orderId: payment.id, ... })`），只有 `orderNo` 才是订单号。
5b 泛化时正好改名：

```typescript
export interface CreatePaymentInput {
  /** 支付单 id（uuid）——渠道侧的「支付单号」，也是幂等去重的依据 */
  referenceId: string;
  /** 业务单号（订单号 / 账单号），渠道页面与对账单上显示的 */
  referenceNo: string;
  /** 支付金额（整数分）。⚠️ 只从订单/账单读，绝不从请求体读 */
  amount: number;
  /** 标题 */
  subject: string;
}

export interface NormalizedWebhookEvent {
  provider: string;
  channel: string;
  eventId: string;
  providerTxnId: string;
  /** 业务单号（订单号 / 账单号） */
  referenceNo: string;
  amount: number;
  success: boolean;
}
```

### 4.2 新增 `chargeAuthorized`

⚠️ **现有的 `PaymentProvider` 只有「跳页面付款」一种语义** ——
自动续费需要「用已绑定的支付方式直接扣款」（真实渠道里叫 off-session charge）。
不新增这个能力，「自动续费」就只能降级成「自动生成账单 + 通知」。

```typescript
export interface PaymentProvider {
  // ...现有四个方法...

  /**
   * 用**已授权的支付方式**直接扣款（自动续费用）。
   *
   * ⚠️ **不能跳页面** —— 没有人来点。渠道异步回调结果。
   * ⚠️ 幂等由调用方保证：同一笔续费只能 charge 一次。
   */
  chargeAuthorized(input: {
    referenceId: string;
    referenceNo: string;
    amount: number;
    subject: string;
    /** 已授权的支付方式凭证 */
    paymentMethodToken: string;
  }): Promise<CreatePaymentResult>;
}
```

### 4.3 webhook 的分流

⚠️ **两个独立的 webhook 端点**，而不是一个端点里判断类型：

| 端点 | 处理 |
|------|------|
| `POST /webhooks/payment/:channel` | 订单支付（阶段 3 现状，逻辑不变，只是字段名改了） |
| `POST /webhooks/subscription/:channel` | 订阅付款 |

分流点由**端点本身**决定 —— 渠道适配器不需要猜「这笔是什么」。

订阅那一条的流程：**验签 → 按 `referenceNo` 反查账单拿租户（不采信请求体的 tenantId）→
金额核对（账单金额 = 事件金额）→ 幂等落库（provider + providerTxnId）→ 账单转 PAID → 订阅期延长**。

---

## 五、抽佣引擎（纯函数）

与阶段 5a 的 `discount-engine.ts` 同款：**纯函数、不碰数据库、不读上下文**，
每一条分支都能被完整断言。

```typescript
/**
 * 抽佣计算。
 *
 * ⚠️ **全程整数域**：费率用基点（万分之），抽佣额用整数分。
 * 绝不出现 `amount * rate / 100` 这种浮点除法。
 */
export function computeCommission(input: {
  /** 计佣基数：订单实付（整数分） */
  payableAmount: number;
  /** 费率（基点，万分之一）。500 = 5% */
  rateBps: number;
}): { amount: number } {
  const raw = Math.round((input.payableAmount * input.rateBps) / 10000);
  // ⚠️ **封顶到实付**：抽佣不能超过商家的实收（护栏 M6）
  return { amount: Math.max(0, Math.min(raw, input.payableAmount)) };
}
```

⚠️ `payableAmount * rateBps` 的量级：`10^8 × 10^4 = 10^12`，远小于 `2^53`，
整数安全。`Math.round` 收敛舍入误差（阶段 5a 的 M11 同款：将来做折扣券时也用整数域）。

---

## 六、订阅的生命周期

### 6.1 订阅与试用

**统一模型**：订阅 = 一串连续周期，试用只是**第一个免费周期**。

```
订阅某套餐（trialDays = 14）
  → Subscription 建行，status = TRIAL
  → trialEndsAt = now + 14 天
  → currentPeriod = [now, now+14天)      ← 试用期内**不生成账单**
试用结束（或付费套餐一开始）
  → 生成第一个付费周期的账单（OPEN）
  → 商家付款 → 账单 PAID → currentPeriod 顺延一个 periodDays
```

⚠️ **判定「有没有服务」不依赖定时任务**：

```typescript
export function hasService(
  subscription: { status: string; trialEndsAt: Date | null; currentPeriodEnd: Date },
  now: Date,
): boolean {
  if (subscription.status === 'TRIAL') {
    return subscription.trialEndsAt !== null && subscription.trialEndsAt.getTime() > now.getTime();
  }
  if (subscription.status === 'ACTIVE') {
    return subscription.currentPeriodEnd.getTime() > now.getTime();
  }
  return false;
}
```

即使定时任务没跑到，判定也是对的（护栏 M15：时间比较用**数据库时钟**，
不是应用进程的时钟）。

### 6.2 续费

**账单的生成时机统一为「周期开始前 3 天」**：

```
订阅（trialDays = 14，periodDays = 30）
  day 0    订阅生效，周期 = [day0, day14)      试用周期，**不生成账单**
  day 11   生成付费周期的账单（[day14, day44)），金额 = 套餐价
           → 此时自动扣款（若有绑定的支付方式）；没有就提醒商家去绑 + 付
  day 14   试用结束
  day 41   生成下一个周期的账单 …
```

⚠️ 试用期的账单**不生成**（免费周期不产生应付），
但**下一个付费周期的账单在试用结束前 3 天就生成** ——
商家在试用期里就能看到「要续费了」，不会到期才发现。

⚠️ 定时任务**每天跑一次**即可（不是每分钟）——
账单的生成与自动扣款都是「周期开始前 3 天」这个粒度，分钟级的精度没有意义。

| | 自动 | 手动 |
|---|---|---|
| 触发 | 定时任务扫「周期开始前 3 天」且没有该周期账单的订阅 | 商家在后台点「去支付」 |
| 动作 | 生成 `invoices`（OPEN）→ 有绑定的支付方式则 `chargeAuthorized` → 渠道回调 | 生成（或复用 OPEN 的）账单 → `createPayment` 拿 payUrl → 跳网关 → webhook |
| 结果 | 回调成功 → 账单 PAID → **订阅期延长一个周期** | 同左 |
| 失败 | 账单 FAILED，挂着等商家手动 | 同左 |

⚠️ **周期只能延长一次**（护栏 M5）：`@@unique([subscriptionId, periodStart])` 兜底 ——
重复的续费回调撞唯一索引 → 不再延长。

⚠️ **重复的支付回调不能让订阅延长两次**（护栏 M11）：
`payments_provider_txn_uniq`（provider, providerTxnId）幂等 + 事件表的幂等索引，
与阶段 3 同款。

### 6.3 到期

- 定时任务把过期的订阅置 `EXPIRED`（但判定不依赖它，见 §6.1）
- **消费者侧下单被拒**：「该店铺暂未开通服务」
- **商家后台全部可用**：登录、看商品、改设置、发货、退款

⚠️ **拦截点只在消费者侧的下单**（`POST /orders` 的 service 层）——
发货、退款这些**必须**还能做，否则等于把商家锁死。

---

## 七、额度与功能权限

### 7.1 执行点

| 限制 | 检查点 | 判定 |
|---|---|---|
| `features.marketing` | 创建/编辑券与活动时 | 缺省 false → 不允许 |
| `maxProducts` | 创建商品时 | 当前商品数 ≥ 上限 → 拒绝 |
| `maxSkus` | 创建 SKU 时 | 当前 SKU 数 ≥ 上限 → 拒绝 |
| `maxStores` | 创建店铺时 | 当前店铺数 ≥ 上限 → 拒绝（默认上限 1） |

⚠️ **全部在 service 层**（护栏 M17）—— 只在 controller 层拦的话，
绕过 controller 直接调 service 就拦不住。

⚠️ **计数用租户作用域下的 `count()`** —— 扩展自动附加 tenantId 条件，
软删过滤也自动生效（与阶段 5a 的 `listMine` 同款）。

### 7.2 超限的响应

拒绝并给**可执行的提示**：「当前套餐最多 10 个商品，请升级套餐」。
不是「已达上限」这种让商家无处可去的文案。

---

## 八、前端

### 8.1 商家后台 `/billing`（新页）

| 区块 | 内容 |
|---|---|
| 当前订阅 | 状态（试用中 / 有效 / 已到期）、套餐名、周期、到期时间、额度用量（商品 N / 上限 M） |
| 套餐列表 | 在售套餐（价、周期、试用期、额度、功能）→「开通」/「切换（下期生效）」 |
| 账单 | 历史账单 + 待付账单（待付的给「去支付」） |
| 支付方式 | 已绑定的支付方式（渠道、类型、默认标记）、绑定新方式、解绑 |

### 8.2 平台超管（platform-admin 三个新页）

- `/plans` 套餐管理：增删改、上下架、排序、费率与额度配置
- `/subscriptions` 订阅列表：按租户查，看状态 / 套餐 / 周期 / 到期
- `/reports` 收入报表：按时间范围看「订阅收入 / 抽佣收入 / 退款冲回 / 净收入」

⚠️ **platform-admin 至今没有任何单元测试**（README 已注明）。
5b 要给它加三个页 → **必须先把 storefront 的测试基建搬过去**
（`vitest.config.ts` + `test/setup.ts` + 逐文件 `// @vitest-environment jsdom`）。
这是阶段 4 遗留的第 2 项，顺手做掉。

### 8.3 消费者侧

无新界面。订阅到期时下单被拒，给一句「该店铺暂未开通服务」。

---

## 九、风险清单

> 编号即设计文档 §九 的编号（M1–M17）。护栏的粒度是「**一条可测的失效模式**」：
> 每条护栏至少一个失败注入，改坏它对应的测试必须真的失败。

### 9.1 可被利用的漏洞

| # | 漏洞 | 攻击路径 / 失效场景 | 后果 | 措施 |
|---|------|--------------------|------|------|
| **M1** | **订阅请求体可传价格 / 额度 / 费率** | 请求体里塞 `price: 0`，服务端照单全收 | 商家白嫖 | 请求体**只接受 `planId`**；价格、额度、费率、周期一律从库里读（护栏 M9 同源） |
| **M2** | **订阅时能指定抽佣费率** | 商家在订阅请求里传 `commissionBps: 0` | 平台白抽 | 订阅请求体**不接受任何费率字段**；费率只配在套餐上，平台超管也不能在订阅时改（决策 4） |
| **M3** | **套餐只能由平台超管创建** | 商家账号调 `POST /platform/plans` | 商家自己发一张免费套餐 | 套餐的写接口全部挂 `@Roles(PLATFORM_ADMIN)`；**商家侧没有创建套餐的接口**。订阅请求体只接受 `planId`（M1），且只接受 `status = ACTIVE` 的 |
| **M4** | **重复开通插出多条订阅** | 并发点两次「开通」 | 额度判定与周期延长都按「取第一条」算，出现分叉 | `@@unique([tenantId])` + 冲突转「已订阅」而不是报错 |
| **M5** | **同一周期两张账单 → 订阅期翻倍** | 重复的续费回调 | 白嫖 | `@@unique([subscriptionId, periodStart])`；重复回调撞索引 → 不再延长 |
| **M6** | **抽佣额超过实付 / 为负** | 费率配错或基数算错 | 平台倒贴钱 | 引擎封顶到实付（`min(raw, payableAmount)`）且下限 0；纯函数单测 |
| **M7** | **平台超管越权看到别家租户的订阅与账单** | 平台后台的列表接口不按租户过滤 | 平台自己越权（多租户底座里平台也是租户之一） | 平台侧的列表必须显式带租户维度；跨租户读要用 `platformScope()` 而不是在商家作用域里查 |

### 9.2 正确性风险

| # | 风险 | 后果 | 措施 |
|---|------|------|------|
| **M8** | **改套餐费率影响已成交订单** | 历史订单的抽佣额变了，对不上账 | 费率与抽佣额**下单时快照**在订单上（决策 12） |
| **M9** | **账单金额从请求体读** | 付 1 分钱 | 账单金额只从 `plan.price` 读 |
| **M10** | **支付回调金额与账单不一致** | 付了 A 金额、开通了 B 金额的套餐 | 事件金额 = 账单金额，不一致就拒绝（阶段 3 的 R13 同款） |
| **M11** | **重复的支付回调延长两次订阅期** | 白嫖 | provider + providerTxnId 幂等 + 事件表幂等索引（阶段 3 同款） |
| **M12** | **到期后还能接新单** | 欠费还在卖货 | 下单的 service 层查订阅；判定不依赖定时任务（§6.1） |
| **M13** | **额度超限没拦住** | 免费用无限商品 | 检查在 service 层；计数用租户作用域的 `count()` |
| **M14** | **功能开关被客户端绕过** | 免费用营销功能 | 开关实时读套餐，不从请求体读；`features` 缺省为 false |
| **M15** | **到期判定用应用时钟** | 多副本部署时钟偏差 → 边界时刻摇摆 | 统一用**数据库的 `now()`**（阶段 5a 的 M15 同款）；测试里把应用时钟冻到 2019 年 |
| **M16** | **额度与权限只在 controller 层拦** | 绕过 controller 直接调 service 就拦不住 | 检查点放在 service 层 |
| **M17** | **退款不冲回抽佣** | 平台收入虚高 | 报表有独立的「冲回」行，按 `refundedAt` 归期 |

> ⚠️ **M15 与阶段 5a 的 M15 是同一件事**（数据库时钟 vs 应用时钟），
> 测试手法也照抄：把应用时钟冻到 2019 年，两个钟差 7 年，判定必然不同。
>
> ⚠️ **M7 是本阶段新增的一类风险**：阶段 5a 的护栏全是「消费者越权」，
> 这一阶段多了「平台自己越权」——平台超管能看到的范围必须显式限定。

---

## 十、测试策略

| 层 | 覆盖 |
|---|---|
| 纯函数单测 | 抽佣计算（整数域、封顶到实付、边界费率）、订阅服务判定（试用中 / 有效 / 已到期 / 已取消）、额度判定 |
| service e2e | 订阅 / 试用 / 续费 / 到期 / 换套餐 / 额度超限 / 功能开关关闭 / 跨租户订阅 / 重复开通 |
| webhook e2e | 订阅付款回调：金额核对、幂等、**重复回调不延长两次订阅期** |
| 前端单测 | 商家后台订阅页的组件测试、platform-admin 的组件测试（**先把测试基建搬过去**） |
| 失败注入 | 17 项护栏逐项改坏 → 确认对应测试真的失败 |

### ⚠️ 本阶段最大的回归面

**`payments` 表泛化会动阶段 3 的支付核心**（20+ 条测试在守）。改法是机械的
（字段改名 + 按 `kind` 分流），但：

- 每改一处就跑阶段 3 的 `payment.e2e` / `order.e2e`，**不攒到最后**
- 阶段 3 的验收记录要更新（e2e 条数会变）
- `order-discount.e2e` 会因订单多两个快照字段而微调

---

## 十一、遗留项与已知取舍

1. **抽佣出款不做** —— 只记账。将来做结算单时，从订单聚合出「本期抽佣 / 冲回 / 净额」。
2. **升级套餐不做差价** —— 换套餐下个周期生效。
3. **试用期的「能力」来自所订阅的套餐** —— 没有「全局试用套餐」，商家自己选。
4. **`TenantStatus.TRIAL` 废弃** —— 试用状态由订阅表达。
5. **注册后没有订阅就不能接单** —— 这是订阅制 SaaS 的正常形态。
   seed 里要给 demo 租户**预置一条可用订阅**，保证阶段 3/5a 的既有手测仍可复现。
6. **平台超管的商家管理与营销页没做** —— 本阶段只做计费相关页；留到 5c。
7. **抽佣不建独立表** —— 报表 SQL 要跨订单聚合；将来做结算单时再抽一层。
8. **额度是「当前时刻」的计数** —— 没有「预约扩容」「月中扩容」这类能力。
9. **`payment_methods.token` 明文存** —— 真实渠道必须加密（注释里写明了）。
10. **一次订阅只能绑一个周期** —— 买了 3 个月付 3 个月的价，不支持「一次付清一年再按月摊」。

---

## 十二、与后续阶段的衔接

- **阶段 5c**：修阶段 4 挖出来的技术债（令牌宽限期、主题 token 的服务端失效、
  merchant-admin 的组件测试基建、e2e 队列隔离与每轮清库），
  外加**平台营销页**（阶段 5a 的遗留：平台超管创建平台券的前端入口）。
  本阶段顺手做掉的：platform-admin 的测试基建。
- **国际化与生态**（主设计 §3 的可选阶段 5）：多币种、开放 API、Webhook、应用市场。
  本阶段的 `PaymentProvider` 泛化（收款单 + `chargeAuthorized`）是那些能力的铺路石。
