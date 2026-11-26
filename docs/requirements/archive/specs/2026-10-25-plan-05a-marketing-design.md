# 计划 5a：营销（优惠券与满减活动）设计文档

> **本文档是实施计划的权威依据。** 实施计划 `2026-10-25-plan-05a-marketing.md` 是本文档的可执行展开，两者冲突时以本文档为准。

## 一、目标与非目标

### 目标

让商家能在自己的店铺发**优惠券**与**满减活动**，消费者领券、结算时自动享受优惠；订单**快照**优惠信息，历史订单不重算。

### 非目标（本阶段明确不做）

| 不做 | 原因 |
|------|------|
| 平台计费（订阅套餐、抽佣结算、平台报表） | 阶段 5b，涉及钱与周期，风险等级不同 |
| 会员等级、积分、拼团、秒杀 | 主设计 §10.1 明文「不做」 |
| 发票、税务、账单 PDF | 主设计 §10.2 明文「不做」 |
| 订单改价后重算优惠 | 阶段 3 没有改单能力，本阶段不引入 |
| 部分退款 | 阶段 3 只支持整单退款，本阶段延续 |
| 券的指定商品/品类范围 | 先做「全店商品」，字段预留范围位 |

## 二、关键决策速查

| # | 决策 | 放弃了什么 | 为什么 |
|---|------|-----------|--------|
| 1 | **券只有「满减券」一种**（`type` 枚举预留 `FIXED`/`PERCENT`） | 一上来就做折扣券 | 主设计 §10.1 只列了满减；折扣券要处理「按什么基数打折」，且要整数域除法。先把字段设计对，实现留到以后 |
| 2 | **满减活动（店铺级，自动）与优惠券（用户持有，手动）可以叠加** | 两者互斥 | 现实中就是「活动价 + 券」。互斥会让「有活动时券完全失效」，用户体感差。计算顺序固定为「先活动、后券」 |
| 3 | **一张订单最多用一张券**，多张券之间取最优 | 多券叠加 | 主设计 §10.1 的引擎骨架明确是「收集可用券 → 每张算折后总价 → **取最优**」 |
| 4 | **平台券与店铺券进同一个池子**，各自算折后价后取最优 | 层级优先级规则 | 一个统一算法比「平台 > 店铺 > 活动」这类层级规则简单得多，也不用为平台券写特例分支 |
| 5 | **券的两个限额分开存**：`perUserLimit`（每用户限领张数）与 `totalLimit`（总发放上限）；每用户的领取量放在独立的 `coupon_claims` 表 | 存在 JSON 列里 | `@@unique([couponId, userId])` 一行汇总，判定「每人限领」= 查这一行的数量。JSON 列没法做条件更新 |
| 6 | **券在「下单时预占核销」，订单取消/超时关闭时释放** | 支付成功才核销 | 与阶段 3 的「库存预占/释放」完全同构。支付成功才核销的话，并发下单会超发——用户手里能同时有两笔订单用同一张券 |
| 7 | **订单快照优惠信息**，退款退**实付额**（原价 − 优惠） | 每次退款重算优惠 | 阶段 3 验收记录 §六 遗留项 4 已定「历史订单不重算」。券的规则将来可能改，改了就对不上历史账 |
| 8 | **优惠只作用于商品金额**，不涉及运费与积分 | — | 阶段 3 已定「订单金额只算商品」，本阶段延续 |
| 9 | **打折（若将来实现）用整数域算**：`Math.round(原价 * (100 - 折扣) / 100)`，全程整数分 | 浮点直接乘 | `Math.ceil(3000 * 1.1)` 的真值是 `3300.0000000000005`（项目踩过）。本阶段只有满减券，实际不触发除法；字段设计要为它留好位置 |

## 三、数据模型

### 3.1 coupons（优惠券）

```prisma
model Coupon {
  id          String   @id @default(uuid())
  tenantId    String
  // 平台券的 tenantId 指向平台租户；店铺券指向商家租户
  code        String
  name        String
  description String?
  // FIXED：满减券（本阶段唯一实现的类型）
  // PERCENT：折扣券（预留，本阶段不实现）
  type        CouponType @default(FIXED)
  // FIXED 时是面额（整数分）；PERCENT 时是折扣数（85 = 85 折）
  value       Int
  // 使用门槛（整数分）。0 = 无门槛
  minAmount  Int      @default(0)
  // 每用户限领张数；null = 不限
  perUserLimit Int?
  // 总发放上限；null = 不限
  totalLimit  Int?
  // 已领取总数（用于限总量的并发判定）
  claimedCount Int    @default(0)
  // 已发放的券里，当前被订单预占核销的数量
  reservedCount Int    @default(0)
  // 已被订单实际使用的数量
  usedCount   Int      @default(0)
  // 平台券对所有店铺生效；店铺券只在本店生效
  scope       CouponScope @default(SHOP)
  status      CouponStatus @default(ACTIVE)
  startsAt    DateTime
  endsAt      DateTime
  deletedAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([tenantId, code])
  @@index([tenantId, status])
  @@map("coupons")
}

enum CouponType {
  FIXED
  PERCENT
}

enum CouponScope {
  SHOP
  PLATFORM
}

enum CouponStatus {
  ACTIVE
  PAUSED
  EXPIRED
}
```

> ⚠️ `coupons` **不带软删**？**带** —— 券是营销配置，商家可能想「下架」但保留历史核销记录的可追溯性。
> 但**核销记录 `coupon_redemptions` 绝对不能软删**（它是财务凭证，与 `inventory_movements` 同款理由）。

### 3.2 coupon_claims（领取记录）

```prisma
model CouponClaim {
  id        String   @id @default(uuid())
  tenantId  String
  couponId  String
  customerId String
  quantity  Int      @default(1)
  createdAt DateTime @default(now())

  @@unique([couponId, customerId])
  @@index([tenantId, customerId])
  @@map("coupon_claims")
}
```

> 一行汇总「这个用户领了这张券多少张」。`perUserLimit` 的判定就是
> 「这一行的 quantity + 本次领取 ≤ perUserLimit」。

### 3.3 coupon_redemptions（核销记录）

```prisma
model CouponRedemption {
  id         String   @id @default(uuid())
  tenantId   String
  couponId   String
  customerId String
  orderId    String
  // RESERVED：订单已创建，额度被占住；订单取消/超时后释放
  // USED：订单已支付，额度真正消耗
  // RELEASED：额度已退回
  status     CouponRedemptionStatus @default(RESERVED)
  // 下单时的优惠额快照
  discountAmount Int
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([couponId, orderId])
  @@index([tenantId, customerId])
  @@map("coupon_redemptions")
}
```

> **「一张券只能被一个订单预占」靠部分唯一索引保证**（手写，Prisma 表达不了）：
> ```sql
> CREATE UNIQUE INDEX "coupon_redemptions_coupon_active_uniq"
>   ON "coupon_redemptions" ("couponId")
>   WHERE "status" IN ('RESERVED', 'USED');
> ```
> 这样并发下单抢同一张券时，一个成功、一个撞唯一索引 → 转 409「该券已被使用」。

### 3.4 promotions（满减活动）

```prisma
model Promotion {
  id          String   @id @default(uuid())
  tenantId    String
  name        String
  description String?
  // 门槛（整数分）：订单商品原价小计 ≥ minAmount 才享受
  minAmount   Int      @default(0)
  // 减免金额（整数分）
  discountAmount Int
  status      PromotionStatus @default(ACTIVE)
  startsAt    DateTime
  endsAt      DateTime
  deletedAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, status])
  @@map("promotions")
}

enum PromotionStatus {
  ACTIVE
  PAUSED
  EXPIRED
}
```

### 3.5 orders 的新增字段（快照）

```prisma
  // 原价小计（优惠前）
  originalAmount Int @default(0)
  // 满减活动减免
  promotionDiscountAmount Int @default(0)
  promotionId String?
  // 优惠券减免
  couponDiscountAmount Int @default(0)
  couponId String?
  couponCode String?
  couponName String?
```

> **全部是快照**：券的名称、码、活动将来改了或删了，历史订单的金额与凭证都不受影响。

### 3.6 租户隔离登记

新表 `coupons` / `coupon_claims` / `coupon_redemptions` / `promotions` **全部带 `tenantId`** → 全部登记进 `TENANT_SCOPED_MODELS`，并在 `TenantPrismaService` 加**对应的 getter**（该类是「包装」模式，每个模型一个 getter，漏了业务代码 `this.prisma.coupon` 直接编译不过）。

`coupons` 与 `promotions` 登记进 `SOFT_DELETE_MODELS`；`coupon_claims` 与 `coupon_redemptions` **不**软删（凭证）。

## 四、优惠引擎

### 4.1 输入与输出

```typescript
interface DiscountContext {
  tenantId: string;
  customerId: string;
  /** 商品原价小计（整数分），已锁定 SKU 的实时价算出来的 */
  originalAmount: number;
  /** 该订单的 SKU 明细，用于判定券的适用范围（本阶段恒为全店） */
  items: Array<{ skuId: string; quantity: number; price: number }>;
  /** 用户持有的候选券 */
  candidateCoupons: CouponCandidate[];
  /** 当前生效的店铺满减活动 */
  promotion: PromotionCandidate | null;
}

interface DiscountResult {
  /** 用了哪张券（没就是 null） */
  appliedCoupon: { id: string; code: string; name: string; discountAmount: number } | null;
  /** 满减活动减免 */
  promotionDiscountAmount: number;
  /** 券减免 */
  couponDiscountAmount: number;
  /** 最终应付（整数分） */
  payableAmount: number;
}
```

### 4.2 算法（**顺序不可换**）

```
1. promotionDiscount = 0
   若 promotion 存在且 未过期 且 originalAmount ≥ promotion.minAmount：
       promotionDiscount = min(promotion.discountAmount, originalAmount)
   afterPromotion = originalAmount - promotionDiscount

2. 对每张候选券：
       若券面额门槛基于「活动后金额」判定：
           若 afterPromotion < coupon.minAmount → 该券不可用
       else：
           discount = min(coupon.value, afterPromotion)
           该券的折后总价 = afterPromotion - discount
   取「折后总价最小」的那张券；并列时取优惠额最大的；再并列取先到的

3. couponDiscount = 选中券的 discount（没选中则 0）
4. payable = afterPromotion - couponDiscount     ← 恒 ≥ 0（步骤 2 的 min 保证了）
```

> ⚠️ **门槛按「活动后金额」判定**，优惠额也按「活动后金额」封顶。
> 用户视角：应付多少，就按多少判门槛、减多少。
>
> ⚠️ **满减额不能把金额减成负数**：`min(discount, 金额)` 这个封顶是硬要求。
> 没有它，一张 100 元的满减券用在 30 元的订单上会让 `payable` 变成 −70。

### 4.3 候选券的来源

「用户持有的券」= `coupon_claims` 里该用户的券，且：
- 券本身 `status = ACTIVE`
- 券在有效期内（`startsAt ≤ now < endsAt`）
- 券没被用过（没有 `status IN (RESERVED, USED)` 的核销记录）
- 券的适用范围匹配（平台券全店可用，店铺券限本店）

### 4.4 纯函数化

优惠引擎是**纯函数**：`computeDiscount(context): DiscountResult`。
不碰数据库、不读上下文 —— 这样它能被完整单测（阶段 3 的「库存流水双语义」就是靠把逻辑做成可测的纯函数才抓住 bug 的）。

读数据库的部分（候选券的查询、活动的查询）在 service 层，组装好 `DiscountContext` 再调纯函数。

## 五、下单流程的接入点

阶段 3 的下单事务（`OrderService.createOrderInTx`）：

```
锁 SKU → 校验可售/上架/库存 → 建订单 + 订单项 → 扣库存 + 记 RESERVE 流水
```

**接入优惠后的顺序**：

```
锁 SKU → 校验可售/上架/库存
  → 算 originalAmount（用锁内读到的实时价）
  → 查候选券 + 当前活动 → 调 computeDiscount → 得到 payableAmount
  → 建订单（含优惠快照字段）+ 订单项
  → 扣库存 + 记 RESERVE 流水
  → 预占券的核销（coupon_redemptions 插 RESERVED + 券的 reservedCount 条件更新）
```

> ⚠️ **优惠计算必须在「锁 SKU 之后」** —— 券的门槛与活动都要按**实时价**判定，
> 而实时价只有在锁住 SKU 之后才稳定。
>
> ⚠️ **券的核销与建单在同一个事务里** —— 券的额度被占住与订单被创建必须同生共死。
> 分成两个事务的话，订单失败而券被占住，用户的券就白占了。
>
> ⚠️ **预占核销用条件更新**：`updateMany({ where: { id, reservedCount: { lt: limit } }, data: { reservedCount: { increment: 1 } } })`
> —— 受影响行数为 0 就是「这张券已被占满」，抛 409。

### 5.1 券的释放

订单取消（`CANCELLED`）或支付超时关闭（`CLOSED`）时：
- `coupon_redemptions` 的 `RESERVED` 行 → `RELEASED`
- 券的 `reservedCount` 减 1

> 与阶段 3 的「释放库存预占」**完全同构**，且必须与改订单状态**在同一个事务里**
> —— 否则订单已取消而券还占着，用户的券就再也用不了。

## 六、前端

| 页面 | 位置 | 内容 |
|------|------|------|
| 商家后台营销页 | `merchant-admin/src/app/(dashboard)/marketing/` | 券与活动的列表、创建、编辑、暂停/启用 |
| 商家后台订单详情 | 已有 | 显示用了哪张券、优惠了多少 |
| storefront 领券 | 结算页 + 订单页 | 展示可领的券、领取 |
| storefront 用券 | 结算页 | 券的下拉选择、显示优惠前后的金额 |
| storefront 订单详情 | 已有 | 显示优惠快照 |

> **金额的展示**：结算页要显示「原价 / 活动减 / 券减 / 实付」四行，
> 让用户看得懂优惠从哪来。金额一律整数分 → 展示时转成「元」（两位小数），
> 转换要**在展示层做**，不要在计算层。

## 七、风险清单

### 7.1 可被利用的漏洞

| # | 漏洞 | 攻击路径 / 失效场景 | 后果 | 措施 |
|---|------|-------------------|------|------|
| **M1** | **客户端传优惠金额** | 请求体里塞 `discountAmount: 99999`，服务端照单全收 | 1 分钱买走 100 元商品 | 订单金额**只由服务端算**；请求体里任何优惠相关字段一律拒绝（`forbidNonWhitelisted`）。**订单的优惠快照字段只由引擎写入** |
| **M2** | **券的门槛/面额被客户端篡改** | 请求体里传 `couponId` + `discountAmount` | 绕过门槛 | 请求体只接受 `couponId`；面额、门槛、优惠额**一律从库里读**，客户端传的优惠额字段被 DTO 白名单拒掉 |
| **M3** | **跨租户用券** | B 店的订单用 A 店的券，或用平台券到不该用的店 | 跨租户优惠、平台承担损失 | 候选券查询在**当前租户作用域**内做；平台券的判定是「`scope = PLATFORM` **或** `tenantId = 当前租户`」，平台券走平台作用域查询但**只取 `scope = PLATFORM` 的**，不能取到别家店的券 |
| **M4** | **限额被并发超发** | 并发领同一张限量券 | 发出超量的券，商家承担 | `claimedCount` 用**条件更新**（`where: { claimedCount: { lt: totalLimit } }`），受影响行数为 0 就是超发 → 409。**不能「先查后改」** |
| **M5** | **同一张券被两笔订单同时用** | 并发下单用同一张券 | 一张券抵两笔订单的钱 | `coupon_redemptions` 的**部分唯一索引**（`WHERE status IN ('RESERVED','USED')`）+ 核销时的条件更新。撞唯一索引 → 转 409 |
| **M6** | **优惠绕过库存校验** | 优惠后的金额为负或极小，绕过「金额 > 0」的校验 | 负金额订单、退款套现 | `payableAmount` 由引擎保证 **≥ 0**；下单前再校验 `payableAmount >= 0`。**金额计算不采信任何客户端输入** |
| **M7** | **平台券被伪造** | 商家创建 `scope = PLATFORM` 的券 | 平台承担全店优惠 | `scope` **不由客户端传入** —— 创建时按「当前用户是不是平台超管」在服务端决定。店铺账号创建的一律 `SHOP` |

### 7.2 正确性风险

| # | 风险 | 后果 | 措施 |
|---|------|------|------|
| **M8** | **订单取消时券没释放** | 用户的券被永久占住 | 释放与改状态**同一事务**；加测试「取消后券能再次使用」 |
| **M9** | **订单超时关闭时券没释放** | 同上（超时路径与取消路径是两条代码） | **两个路径调用同一个释放函数**（阶段 3 的「取消与超时释放共用同一函数」是同款约定） |
| **M10** | **优惠额算错导致 `payable` 为负** | 负金额订单 | 引擎里 `min(coupon.value, afterPromotion)` 封顶；下单前断言 `payable >= 0` |
| **M11** | **折扣的浮点误差** | 差一分钱 | 本阶段只有满减券（整数减法，无误差）；将来做折扣时用整数域 `Math.round(原价 * (100-折扣) / 100)` |
| **M12** | **历史订单被重算** | 券规则改了，历史订单金额跟着变 | 订单存**快照**；退款读快照而不是重算 |
| **M13** | **退款金额与实付不符** | 退多了或退少了 | 退款额 = 订单的 `totalAmount`（已含优惠）；**不重算优惠** |
| **M14** | **券的领取与核销状态不同步** | `reservedCount` 与 `usedCount` 对不上 | 每次状态变更都在**同一事务**里更新计数；加测试核对「计数 = 核销记录数」 |
| **M15** | **活动/券过期时间用应用时钟 vs 数据库时钟** | 边界时刻判定不一致 | 统一用**数据库的 `now()`** 比较（`startsAt <= now() AND endsAt > now()`），不用应用进程的时钟 |
| **M16** | **满减活动与券叠加的顺序写反** | 用户看到的金额与实付不符 | 顺序写进引擎的**单一实现**里并加测试（活动先、券后） |
| **M17** | **前端展示的优惠与后端算的不一致** | 用户下单时金额变了 | 前端展示的是**估算值**（与购物车金额一样的处境），下单响应返回**服务端算出的真实金额**，页面以响应为准并提示「以提交时为准」 |

## 八、测试策略

| 层 | 覆盖什么 | 例子 |
|----|---------|------|
| **纯函数单测** | 优惠引擎的每条分支 | 门槛不满足、门槛刚好满足、券面额大于应付、活动与券叠加、无券、券已用完 |
| **e2e** | 领取的并发、结算的优惠、取消/超时后的释放、跨租户隔离 | 并发领限量券只成功一次、并发用同一张券只成功一次、取消后券能再用、跨租户用券被拒 |
| **失败注入** | 每条护栏 | 破坏条件更新 → 并发用例挂；把客户端优惠额当真 → 篡改用例挂 |
| **浏览器手测** | 商家发券 → 消费者领 → 结算用券 → 订单详情显示优惠快照 | 见实施计划 |

## 九、遗留项与已知取舍

1. **折扣券（PERCENT）本阶段不实现**，字段已预留。
2. **券的适用范围只做「全店商品」**，字段预留范围位。
3. **部分退款不支持**（阶段 3 只支持整单退款）。有优惠的部分退款该怎么退（优惠按比例摊到各订单项吗）是独立的问题。
4. **券的「限领次数」是每用户限领张数**，不是「每张券实例的使用次数」——后者在满减券的模型里没有意义（领了就是你的，用一次）。
5. **平台券与店铺券取最优时，只用一张** —— 平台券面额大就选平台券，店铺的活动仍然生效（活动是自动的、券是手动选的，两者叠加）。
6. **订单金额仍只算商品**，不含运费、不含积分。
