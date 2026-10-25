# 计划 5a：营销（优惠券与满减活动）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让商家能在自己的店铺发**优惠券**与**满减活动**，消费者领券、结算时自动享受优惠；订单**快照**优惠信息，历史订单不重算。券的额度在**下单时预占核销**、订单取消/支付超时时释放——与阶段 3 的库存预占/释放完全同构。

**Architecture:** 后端新增一个 `coupon` 模块（券、领取、核销、满减活动四张表 + 优惠引擎）。优惠引擎是**纯函数** `computeDiscount(context): DiscountResult`——不碰数据库、不读上下文，因此能被完整单测（阶段 3 的「库存流水双语义」就是靠把逻辑做成可测的纯函数才抓住 bug 的）。读数据库的部分（候选券查询、当前活动查询）在 service 层，组装好 `DiscountContext` 再调纯函数。下单流程在**锁 SKU 之后**接入优惠：算 `originalAmount` → 查候选券与活动 → 调引擎 → 建订单（写优惠快照字段）→ 扣库存 → **预占券的核销**（同一事务）。取消与超时关闭走**同一个释放函数**，把核销从 `RESERVED` 转 `RELEASED`、`reservedCount` 减 1。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 | Next.js 15 + React 19 + Tailwind 4 + shadcn/ui | Vitest（前端单测）+ Jest/Supertest（后端）

**对应设计文档:** `docs/superpowers/specs/2026-10-25-plan-05a-marketing-design.md` 全文。**本计划是该文档的可执行展开**，两者冲突时以设计文档为准。

---

## 零、全局约定

### 0.1 沿用阶段 3 的既有约定（不要重新发明）

| 约定 | 位置 | 说明 |
|------|------|------|
| 金额一律整数分，**禁止浮点运算** | 全局 | 阶段 0.4 已定。`Math.ceil(3000 * 1.1)` 的真值是 `3300.0000000000005`（项目踩过）。前端只做展示换算（`formatPrice`），**不在计算层换算** |
| 租户隔离靠 `TenantPrismaService` 的 Prisma 扩展 | `api/src/common/tenant/` | 新表**必须**登记进 `TENANT_SCOPED_MODELS`，否则**服务启动直接失败**（`tenant-prisma.service.ts` 第 581–598 行的 `assertTenantScopedModelsRegistered` 会扫 schema） |
| **`TenantPrismaService` 是包装模式，每个模型一个 getter** | `api/src/common/tenant/tenant-prisma.service.ts` 第 462–544 行 | 漏了 getter → 业务代码写 `this.prisma.coupon` **直接编译不过**。这不是「忘了也能跑」，是编译期就炸——但实现者容易临时改用 `as any` 绕过，那才是真的破防 |
| 关联读取必须显式 `where` | 全局 | 扩展的软删过滤**只作用于顶层**，嵌套关联不会被自动过滤（`order.service.ts` 第 413–480 行 `readSkuDetails` 的注释与做法） |
| 唯一约束冲突转 409 | `api/src/common/errors/unique-constraint.ts` 的 `rethrowIfUniqueViolation` | 阶段 2a 建的。**P2002 必须在事务外处理**——唯一约束冲突让 PostgreSQL 事务进入 aborted 状态，在同一事务里继续查会报 `current transaction is aborted`（`order.service.ts` 第 143–150 行与第 176–198 行） |
| 状态流转用条件更新 | `updateMany` where 带 `status` | 靠**受影响行数**判赢家，不用「先查后改」。阶段 3 最关键的并发正确性（`order.service.ts` 第 574–630 行 `transitionInTx`） |
| 手写索引**不能靠 `prisma migrate diff` 生成** | 迁移 | diff 不认识条件唯一索引，会把它们当漂移输出成 `DROP INDEX`（阶段 2 已经踩过）。见 `api/prisma/migrations/20261024093418_add_transaction_tables/migration.sql` 第 184–215 行的手写段 |
| 中转路由必须白名单重建请求体 | `*/src/app/api/**` | 阶段 2b 安全审查确立的约定。整段透传会让后端 `forbidNonWhitelisted` 400，而更根本的问题是**价格字段绝不能从客户端来** |
| 代码注释用简体中文，大量用「⚠️」标注重要约束、块注释解释「为什么」 | 全局 | 本项目既有风格。注释解释的是「为什么这样写」与「不这样写会怎样」，不是复述代码 |
| **`prisma migrate reset` 禁用** | 全局 | 阶段 2 已经因此踩过坑。迁移漂移时用 `migrate diff` 兜底 |
| 前端断言要具体 | 全部 | 「只断言 200」「只断言报错」都算恒真。**组件测试同样适用**（阶段 4 护栏 2） |
| Server Component 不能往客户端组件传函数 | 前端 | `tsc` 与 `next build` 都通过，只有真正渲染才 500（阶段 2b 踩过） |
| 路由模块只导出 HTTP 方法 | `*/src/app/api/**/route.ts` | 多导出一个普通函数就会让 `next build` 报「not a valid Route export field」（阶段 3 踩过） |
| 公开路径要带 `x-tenant-subdomain` | `storefront/src/lib/api-client.ts` 的 `apiFetch` | 匿名请求靠子域名定位租户；商家后台**不带**这个头（中心域名没有「当前店铺」，租户身份由 accessToken 里的 `tenantId` 决定，`merchant-admin/src/lib/api-client.ts` 第 33–34 行） |
| storefront 测试：全局环境保持 `node`，组件测试逐文件切 jsdom | `storefront/vitest.config.ts` | `// @vitest-environment jsdom` 写在文件第一行。`storefront/test/setup.ts` 里**已有**显式 `afterEach(() => cleanup())`，**不要重复加**（项目 `globals: false`，全局 `afterEach` 不存在，RTL 的自动 cleanup 不会注册） |

### 0.2 本阶段的 17 项护栏

设计文档 §七 列了 **7 条可被利用的漏洞（M1–M7）** 与 **10 条正确性风险（M8–M17）**，本计划把它们归并成 **17 条护栏**（M1–M17 一一对应，编号即设计文档的编号）。

护栏的粒度是「**一条可测的失效模式**」：
- 每条护栏**至少一个失败注入**——改坏它，对应的测试必须真的失败
- 护栏编号写进测试的注释里，验收（Task 7）按编号逐条核对

**M1–M7 是「可被利用的漏洞」**（安全向），**M8–M17 是「正确性风险」**（账务与并发向）。
两组都要失败注入：安全向的护栏被改坏时，攻击路径在 e2e 里能跑出来；正确性向的护栏被改坏时，
金额或计数会错，而**这些错在响应体里往往看不出来**——必须查库断言。

### 0.3 端口与基础设施

| 服务 | 宿主机 | 容器内 | 状态 |
|------|--------|--------|------|
| PostgreSQL | 15432 | 5432 | 已在跑 |
| MinIO | 19000 | 9000 | 已在跑 |
| Redis | 16380 | 6379 | 已在跑 |
| api | 3000 | 3000 | 已在跑 |
| storefront | 3011 | 3000 | dev 用 3011（3001 被容器占） |
| merchant-admin | 3016 | 3000 | dev 用 3016（3002 被容器占） |

> ⚠️ **本地 dev 起前端前先 `rm -rf .next`**——3001–3003 是**旧镜像**，不含阶段 5a 的功能。
> 阶段 2b 栽过两次「实测报缺陷、复现不出来」，根因都是测了旧镜像。

### 0.4 目录

```
api/src/modules/
├─ coupon/         # 新建：券 + 领取 + 核销 + 满减活动 + 优惠引擎
│  ├─ coupon.module.ts
│  ├─ coupon.service.ts           # 券的 CRUD + 领取
│  ├─ coupon.controller.ts        # 消费者侧：领券、我的券
│  ├─ merchant-coupon.controller.ts  # 商家侧：券与活动的 CRUD
│  ├─ coupon-redemption.service.ts   # 预占核销 / 释放（与库存预占同构）
│  ├─ promotion.service.ts        # 满减活动
│  ├─ discount-engine.ts          # 纯函数 computeDiscount
│  └─ dto/*.dto.ts
api/src/modules/order/
├─ order.service.ts                # 修改：接入优惠 + 预占核销 + 释放
└─ order-timeout.service.ts        # 修改：超时关闭时释放券
storefront/src/app/(shop)/
├─ checkout/page.tsx               # 修改：券选择 + 四行金额
└─ coupons/page.tsx                # 新建：领券中心
storefront/src/app/api/coupons/    # 新建：中转路由
merchant-admin/src/app/(dashboard)/
└─ marketing/                      # 新建：营销页
```

### 0.5 计划勘误索引表

> **按阶段 3 与阶段 4 的做法**：计划初稿写完后，拿它对着**现有代码**逐条核对，
> 发现与现状不符的地方就地修正，并在这里留一张索引表。
>
> **本表留空——实施时填。** 实施者每发现一处不符，**继续在表里加行**，
> 并在正文对应位置就地修正。不要只改表不改正文。

| # | 问题 | 后果 | 在哪修 |
|---|------|------|--------|
| 1 | **`orders.totalAmount` 必须保持「实付」语义** —— 支付链路的金额核对读的是 `payment.service.ts` 里的 `order.totalAmount` | 新增 `originalAmount` 存原价、`totalAmount` 存实付。搞反了支付链路全线失败 | Task 1（schema） |
| 2 | `coupon_redemptions` 的 `@@unique([couponId, orderId])` **挡不住**「同一张券先后被两个订单核销」 | 必须**手写**部分唯一索引 `coupon_redemptions_coupon_active_uniq ON ("couponId") WHERE "status" IN ('RESERVED','USED')` | Task 1（迁移） |
| 3 | 租户扩展**禁止 `upsert`**（`tenant-prisma.service.ts:307`） | `coupon_claims` 的数量累计要用「先 findFirst 再 create/updateMany」，并发的 P2002 **在事务外**重试 | Task 3（领取） |
| 4 | 设计 §4.1 的 `PromotionCandidate` 缺 `startsAt/endsAt`，但算法要判「未过期」 | 引擎的输入类型里补上这两个字段 | Task 2 |
| 5 | 设计 §五 的 `reservedCount` 条件更新（`lt: limit`）在本阶段「一券一实例」的模型下**没有对应的上限字段** | 改为**以部分唯一索引作并发闸门**；`reservedCount` **只是计数快照**，不是闸门 | Task 4（下单核销） |
| 6 | Task 2 的「门槛为 0 = 无门槛」用例**自相矛盾**：`originalAmount: 1` + `value: 1000` 断言优惠 1000、实付 0，与「满减额不能把金额减成负数」冲突 | 引擎行为正确（封顶到 1），改的是断言 | Task 2 |
| 7 | **M15 的失败注入测不出来**：原用例的 `NOW` 与真实时钟仅差 9 小时，有效期窗口覆盖两种时刻，变异后 26 例全绿 | 把测试时间改到 2019 年（真实时钟永远到不了），并补一条「只改 `context.now` 就换判定结果」的专用断言 | Task 2 |
| 8 | `prisma migrate diff` 仍会输出 3 条 `DROP INDEX`（`payments_provider_txn_uniq` 与两条 `products_*_trgm`） | 迁移文件里剔除它们（它们是手写索引，被 diff 误判为漂移） | Task 1（迁移） |

### 0.6 护栏对照表（验收以这张表为准）

**下表是唯一权威对照。** 护栏编号 = 设计文档 §七 的编号（M1–M17）。

| 护栏 | 内容 | 在哪测 | 风险出处 |
|------|------|--------|---------|
| **M1** | **客户端传优惠金额无效**：请求体里任何优惠相关字段一律被拒（`forbidNonWhitelisted`）；订单的优惠快照字段只由引擎写入 | Task 4（e2e）、Task 5（中转路由白名单测试） | §7.1 M1 |
| **M2** | **券的门槛/面额不可被客户端篡改**：请求体只接受 `couponId`，面额/门槛/优惠额一律从库里读 | Task 4（e2e）、Task 5 | §7.1 M2 |
| **M3** | **跨租户用券被拒**：候选券查询在当前租户作用域内做；平台券走平台作用域查询但只取 `scope = PLATFORM` 的 | Task 4（e2e） | §7.1 M3 |
| **M4** | **限额不被并发超发**：`claimedCount` 用条件更新（`where: { claimedCount: { lt: totalLimit } }`），受影响行数为 0 就是超发 → 409。**不能「先查后改」** | Task 3（e2e） | §7.1 M4 |
| **M5** | **同一张券不被两笔订单同时用**：`coupon_redemptions` 的部分唯一索引（`WHERE status IN ('RESERVED','USED')`）+ 核销时的条件更新，撞唯一索引 → 409 | Task 4（e2e） | §7.1 M5 |
| **M6** | **优惠绕过库存校验**：引擎保证 `payableAmount >= 0`，下单前再校验一次；金额计算不采信任何客户端输入 | Task 2（纯函数单测）、Task 4 | §7.1 M6 / §7.2 M10 |
| **M7** | **平台券不被伪造**：`scope` 不由客户端传入——创建时按「当前用户是不是平台超管」在服务端决定，店铺账号创建的一律 `SHOP` | Task 3（e2e） | §7.1 M7 |
| **M8** | **订单取消时券被释放**：释放与改状态**同一事务**；加测试「取消后券能再次使用」 | Task 5（e2e） | §7.2 M8 |
| **M9** | **订单超时关闭时券被释放**：**两个路径调用同一个释放函数** | Task 5（e2e） | §7.2 M9 |
| **M10** | **优惠额算错不会让 `payable` 为负**：引擎里 `min(coupon.value, afterPromotion)` 封顶；下单前断言 `payable >= 0` | Task 2（纯函数单测） | §7.2 M10 |
| **M11** | **折扣的浮点误差**：本阶段只有满减券（整数减法，无误差）；将来做折扣时用整数域 `Math.round(原价 * (100-折扣) / 100)` | Task 2（纯函数单测，断言整数域） | §7.2 M11 |
| **M12** | **历史订单不被重算**：订单存**快照**；退款读快照而不是重算 | Task 4（e2e：改券的规则后订单金额不变） | §7.2 M12 |
| **M13** | **退款金额与实付相符**：退款额 = 订单的 `totalAmount`（已含优惠）；**不重算优惠** | Task 5（e2e） | §7.2 M13 |
| **M14** | **券的领取与核销状态同步**：`reservedCount` 与 `usedCount` 对得上核销记录数；每次状态变更都在**同一事务**里更新计数 | Task 3 + Task 4 + Task 5（e2e：核对「计数 = 核销记录数」） | §7.2 M14 |
| **M15** | **活动/券过期时间用数据库时钟**：统一用 `now()` 比较（`startsAt <= now() AND endsAt > now()`），不用应用进程的时钟 | Task 3（e2e）+ Task 4 | §7.2 M15 |
| **M16** | **满减活动与券的叠加顺序不写反**：顺序写进引擎的**单一实现**里并加测试（活动先、券后） | Task 2（纯函数单测） | §7.2 M16 |
| **M17** | **前端展示的优惠与后端算的一致**：前端展示的是**估算值**，下单响应返回**服务端算出的真实金额**，页面以响应为准并提示「以提交时为准」 | Task 5（前端） | §7.2 M17 |

> ⚠️ **M11 在本阶段是「预留位」**：本阶段只有满减券，不触发除法。
> 护栏 M11 的可测形态是「引擎里**没有**任何浮点除法」——
> 测试要断言 `payableAmount` 与 `originalAmount` 都是**整数**（`Number.isInteger`），
> 且在面额大于金额时**不出现** `3300.0000000000005` 这类尾数。
> 将来做折扣券时，这条护栏要升级成真正的整数域除法断言。

---

## Task 1：数据模型与迁移

本 Task 铺好阶段 5a 的地基：4 张新表、`orders` 的优惠快照字段、租户白名单登记、
模型 getter、手写部分唯一索引。

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/<stamp>_add_marketing_tables/migration.sql`
- Modify: `api/src/common/tenant/tenant-models.ts`
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`
- Test: `api/src/common/tenant/tenant-prisma.service.spec.ts`（追加用例）

> ⚠️ **本 Task 有三件必需的事容易漏**：
> 1. `TenantPrismaService` 是「包装」模式：每个模型一个 getter
>    （`get coupon() { return this.client.coupon; }`）。不新增 getter，
>    业务代码写 `this.prisma.coupon` **直接编译不过**。
> 2. `orders` 的优惠快照字段**不在设计文档的 `Order` 模型定义里**——
>    它在设计文档 §3.5 里单独列着。照抄 §3.1–§3.4 的模型定义会漏掉这 8 个字段。
> 3. **手写部分唯一索引**（`coupon_redemptions` 的「一张券只能被一个订单预占」）
>    Prisma 表达不了，且 `prisma migrate diff` 会把它当漂移删掉。

- [ ] **Step 1.1: 先写失败测试**

新表的白名单登记是 fail-fast 的：漏登记 → **服务启动失败**（不是运行时报错）。
所以先写一个**验证白名单完整性**的单元测试。

在 `api/src/common/tenant/tenant-prisma.service.spec.ts` 末尾追加：

```typescript
  it('阶段 5a 的新表全部登记在租户作用域白名单里', () => {
    // 漏登记的后果是「那张表的所有读写都不附加 tenantId 条件」——
    // 彻底失去隔离且没有任何报错。所以这条断言守着它。
    const expected = [
      'Coupon',
      'CouponClaim',
      'CouponRedemption',
      'Promotion',
    ];
    for (const model of expected) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  it('券与活动走软删：软删后商家还能查历史核销记录', () => {
    // 券是营销配置，商家可能想「下架」但保留历史核销记录的可追溯性。
    expect(SOFT_DELETE_MODELS.has('Coupon')).toBe(true);
    expect(SOFT_DELETE_MODELS.has('Promotion')).toBe(true);
  });

  it('领取记录与核销记录不软删：它们是财务凭证', () => {
    // ⚠️ **反向断言**，锁住一个刻意的决定。
    // 核销记录软删掉的话，「这张券被用掉了」这件事就没了——
    // 对账时无法回答「用户手里的券为什么不见了」。
    expect(SOFT_DELETE_MODELS.has('CouponClaim')).toBe(false);
    expect(SOFT_DELETE_MODELS.has('CouponRedemption')).toBe(false);
  });
```

在文件头部加 import：

```typescript
import { SOFT_DELETE_MODELS, TENANT_SCOPED_MODELS } from './tenant-models';
```

> **三条断言分别守三件事**：白名单（隔离）、软删名单的两类归属（配置 vs 凭证）。
> 反向断言（`CouponClaim` 不软删）比正向断言更重要——它防的是「顺手把新表都加进
> 软删名单」这种过度统一的改动。

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：FAIL，`expected false to be true`（`Coupon` 未登记）。

- [ ] **Step 1.3: 写数据模型**

`api/prisma/schema.prisma` 追加 **4 个模型 + 3 个枚举**（照设计文档 §3.1–§3.4）：

| 模型 | 枚举 | 带 tenantId | 登记白名单 | 登记软删 |
|------|------|------------|-----------|---------|
| `Coupon` | `CouponType` / `CouponScope` / `CouponStatus` | 是 | 是 | 是 |
| `CouponClaim` | — | 是 | 是 | **否** |
| `CouponRedemption` | `CouponRedemptionStatus` | 是 | 是 | **否** |
| `Promotion` | `PromotionStatus` | 是 | 是 | 是 |

`Coupon` 模型（设计文档 §3.1）：

```prisma
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

  // ⚠️ **刻意不声明 tenant 关系**，只有 tenantId 标量。
  // 与 Order / Address 同款做法：外键只引用 id 不带 tenantId，
  // 「跨租户挂载」由 service 层显式校验，而不是靠外键悄悄放行。
  //
  // ⚠️ 唯一索引由迁移手写部分唯一索引（软删后 code 仍占用唯一性）。
  @@index([tenantId, status])
  @@map("coupons")
}
```

`CouponClaim`（设计文档 §3.2）：

```prisma
model CouponClaim {
  id        String   @id @default(uuid())
  tenantId  String
  couponId  String
  customerId String
  quantity  Int      @default(1)
  createdAt DateTime @default(now())

  // ⚠️ 唯一索引由迁移手写部分唯一索引（软删后 code 仍占用唯一性）。
  @@index([tenantId, customerId])
  @@map("coupon_claims")
}
```

`CouponRedemption`（设计文档 §3.3）：

```prisma
enum CouponRedemptionStatus {
  RESERVED
  USED
  RELEASED
}

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

  // ⚠️ **刻意不声明 tenant 关系**，只有 tenantId 标量（与 Order 同款）。
  //
  // ⚠️ 唯一索引由迁移手写部分唯一索引（见 migration.sql）。
  @@index([tenantId, customerId])
  @@map("coupon_redemptions")
}
```

`Promotion`（设计文档 §3.4）：

```prisma
enum PromotionStatus {
  ACTIVE
  PAUSED
  EXPIRED
}

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

  // ⚠️ **刻意不声明 tenant 关系**，只有 tenantId 标量。
  @@index([tenantId, status])
  @@map("promotions")
}
```

`Order` 模型追加 **8 个优惠快照字段**（设计文档 §3.5）：

```prisma
  // ---------- 阶段 5a：优惠快照 ----------
  //
  // ⚠️ **全部是快照**：券的名称、码、活动将来改了或删了，
  // 历史订单的金额与凭证都不受影响（设计文档 §7.2 M12）。
  //
  // ⚠️ `originalAmount` 是「优惠前的原价小计」，
  // `totalAmount` 是「优惠后的实付」——
  // **totalAmount 保持它现有的语义**（阶段 3 的支付金额核对读的是它，
  // 见 payment.service.ts 第 254 行的金额核对），
  // 所以支付金额自动就是实付额，不需要改支付链路。
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

> ⚠️ **`totalAmount` 的语义不能变**。阶段 3 的 `PaymentService.checkWebhookEvent`
>（`payment.service.ts` 第 253–260 行）拿 `event.amount !== order.totalAmount` 判金额不符。
> 若把 `totalAmount` 保持成「原价」而另设一个「实付」字段，支付金额核对会全线失败。
> **正确做法**：`totalAmount` = 实付（优惠后），`originalAmount` = 原价。
> 阶段 3 之前没有优惠，两者是同一个数，所以老订单不受影响。

> ⚠️ **`Tenant` 的反向关系**：Prisma 要求双向关系都声明，否则 schema 校验直接失败。
> 本 Task 的 4 个模型**刻意不声明 tenant 关系**（只有 `tenantId` 标量），
> 所以 `Tenant` **不需要**加反向字段——不声明关系就没有双向要求。
> 这是照抄 `Order` / `Address` / `Payment` 的既有做法（`schema.prisma` 第 503–506 行、
> 第 448–455 行、第 558–559 行的注释都写明了理由）。

- [ ] **Step 1.4: 写迁移（手写索引 + `migrate diff` 生成建表）**

**先让 Prisma 生成建表部分**：

```bash
cd api && npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/p5a/tables.sql
```

然后建迁移目录（目录名带时间戳，格式照
`api/prisma/migrations/20261024093418_add_transaction_tables/`），把 `tables.sql` 作为基础，
**追加**手写索引：

```sql
-- ---------- 手写的部分唯一索引 ----------
--
-- Prisma 的 @@unique 表达不了「条件唯一」，且 PostgreSQL 的 NULL 不参与唯一性判定。
-- 下面三条索引 Prisma schema 里**刻意没有声明**，全靠迁移手写。
--
-- ⚠️ 它们必须手写：`prisma migrate diff` 不认识条件唯一索引，会把它们当漂移
-- 输出成 DROP INDEX（阶段 2 已经踩过这个坑）。

-- 券码在租户内唯一，但软删后仍占用 —— 所以用部分唯一索引只约束未删除的
--
-- ⚠️ 为什么不用 `@@unique([tenantId, code])`：软删后 code 仍占用唯一性，
-- 而商家「先下架一张券、再用同一个码发一张新券」是正常操作。
-- 普通的 @@unique 做不到「仅对未删除记录生效」——带 deletedAt 的复合唯一
-- 也无效，因为 PostgreSQL 的 NULL 不参与唯一性判定。
-- 与 categories.slug 的处理完全同款（schema.prisma 第 157–160 行）。
CREATE UNIQUE INDEX "coupons_tenant_code_uniq"
  ON "coupons" ("tenantId", "code") WHERE "deletedAt" IS NULL;

-- 一个用户对同一张券只有一行领取汇总（quantity 累加在行内）
--
-- ⚠️ 这条**不是**部分唯一索引：CouponClaim 不软删，行永远存在。
CREATE UNIQUE INDEX "coupon_claims_coupon_customer_uniq"
  ON "coupon_claims" ("couponId", "customerId");

-- **一张券只能被一个订单预占**（M5 的数据层保证）
--
-- ⚠️ 这条是本阶段最关键的索引。设计文档 §3.3 的 `@@unique([couponId, orderId])`
-- 表达的是「同一张券不能被两个订单各核销一次」——但它**拦不住**
-- 「券 A 被订单 1 核销后，又被订单 2 核销」，
-- 因为 couponId 与 orderId 都不同，组合是唯一的。
--
-- 真正要拦的是「**同一张券**在同一时刻只能有一条 RESERVED/USED 的核销」。
-- 那个条件是 status，Prisma 表达不了 → 必须手写部分唯一索引。
--
-- 这样并发下单抢同一张券时：一个成功、一个撞唯一索引 → 转 409「该券已被使用」。
CREATE UNIQUE INDEX "coupon_redemptions_coupon_active_uniq"
  ON "coupon_redemptions" ("couponId")
  WHERE "status" IN ('RESERVED', 'USED');
```

> ⚠️ **`coupon_redemptions_coupon_active_uniq` 的 `WHERE` 条件是 `status IN ('RESERVED','USED')`**
> ——`RELEASED` 不在条件里，所以券被释放后**同一张券可以被再次核销**。
> 这正是 M8/M9「取消后券能再次使用」的数据层保证。
>
> ⚠️ **枚举值在 SQL 里是字符串**（`'RESERVED'`），PostgreSQL 的枚举类型在
> `WHERE` 子句里可以与字符串常量比较——这一点实测过。

应用迁移：

```bash
cd api && npx prisma migrate deploy
```

> **若 `migrate dev` 因为 drift 失败，绝不 reset**——阶段 2 已经因此踩过坑。
> 用上面的 `migrate diff` 兜底。

- [ ] **Step 1.5: 登记白名单**

`api/src/common/tenant/tenant-models.ts` 的两个白名单都补上：

```typescript
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User',
  'Store',
  // 商品中心（计划 2）
  'Category',
  'Product',
  'ProductSpec',
  'ProductSpecValue',
  'Sku',
  'SkuSpecValue',
  'Media',
  'ProductMedia',
  'InventoryMovement',
  // 交易链路（计划 3）
  'Cart',
  'CartItem',
  'Address',
  'Order',
  'OrderItem',
  'Payment',
  // 营销（计划 5a）
  'Coupon',
  'CouponClaim',
  'CouponRedemption',
  'Promotion',
]);
```

`SOFT_DELETE_MODELS` 补两张：

```typescript
export const SOFT_DELETE_MODELS = new Set<string>([
  'Category',
  'Product',
  'ProductSpec',
  'ProductSpecValue',
  'Sku',
  'Media',
  'Address',
  // 营销（计划 5a）：券与活动是**营销配置**，商家可能想「下架」但保留
  // 历史核销记录的可追溯性，所以走软删。
  //
  // ⚠️ CouponClaim / CouponRedemption **不软删**——它们是财务凭证
  //（与 InventoryMovement 同款理由：append-only 的审计记录）。
  'Coupon',
  'Promotion',
]);
```

- [ ] **Step 1.6: 加模型 getter**

`api/src/common/tenant/tenant-prisma.service.ts` 里每个模型一个 getter
（现有模式：`get sku() { return this.client.sku; }`，第 495–498 行）。
**4 个新模型各加一个**：

```typescript
  // ------- 营销（计划 5a）模型 delegate 代理 -------

  get coupon() {
    return this.client.coupon;
  }

  get couponClaim() {
    return this.client.couponClaim;
  }

  get couponRedemption() {
    return this.client.couponRedemption;
  }

  get promotion() {
    return this.client.promotion;
  }
```

> **漏了 getter 会怎样**：业务代码写 `this.prisma.coupon` 时 TypeScript 报
> `Property 'coupon' does not exist`——编译期就炸，不会静默出错。
> 但漏了它会让实现者临时改用 `as any` 绕过，那才是真的破防。

- [ ] **Step 1.7: 跑测试**

```bash
cd api && npx jest src/common/tenant/tenant-prisma.service.spec.ts
```

预期：PASS（白名单那几条转绿）。

```bash
cd api && npx prisma validate && npx tsc --noEmit && npm run lint
```

预期：干净。

> **`prisma validate` 必跑**——它是 schema 双向关系问题的第一道闸。
> `tsc --noEmit` 抓的是「getter 漏了」。

- [ ] **Step 1.8: 提交**

```bash
git add api/
git commit -m "feat(api): 阶段 5a 的数据模型与迁移

落地 4 张营销表（券 / 领取记录 / 核销记录 / 满减活动）与 orders 的 8 个
优惠快照字段，并把新表登记进租户作用域白名单与软删名单。

两处刻意的不对称，是有意的：
- Coupon 与 Promotion 走软删——商家想「下架」一张券但保留历史核销的
  可追溯性；而 CouponClaim 与 CouponRedemption 是财务凭证，append-only，
  软删掉就答不出「用户手里的券为什么不见了」。
- CouponCode 在租户内用部分唯一索引（WHERE deletedAt IS NULL）而不是
  @@unique——软删后码仍占用唯一性，而「先下架再用同一个码发新券」是正常操作。
  普通的 @@unique 做不到「仅对未删除记录生效」，带 deletedAt 的复合唯一也
  无效，因为 PostgreSQL 的 NULL 不参与唯一性判定。

coupon_redemptions_coupon_active_uniq 是本阶段最关键的索引：一张券在同一
时刻只能有一条 RESERVED/USED 的核销。它挡住「同一张券被两笔订单同时用」
（M5）——而设计文档里的 @@unique([couponId, orderId]) 挡不住，
因为那张券先后被两个订单核销时 couponId 与 orderId 都不同，组合是唯一的。

orders 的优惠字段全是快照：券的名字、码、活动将来改了或删了，
历史订单的金额与凭证都不受影响。

totalAmount 保持「实付」语义不变（阶段 3 的支付金额核对读它），
新增 originalAmount 存优惠前的原价——阶段 3 之前两者是同一个数，老订单不受影响。

TenantPrismaService 补 4 个模型 getter——它是包装模式，每个模型一个 getter，
不补的话业务代码写 this.prisma.coupon 直接编译不过。"
```

---

## Task 2：优惠引擎（纯函数）

**这是本阶段最核心的一块**，也是唯一能**完整单测**的一块。

**Files:**
- Create: `api/src/modules/coupon/discount-engine.ts`
- Create: `api/src/modules/coupon/discount-engine.spec.ts`

> ⚠️ **为什么必须是纯函数**：优惠引擎的每一条分支（门槛不满足、门槛刚好满足、
> 券面额大于应付、活动与券叠加、无券、券已用完）都要能被断言。
> 如果引擎读数据库，测它就要起数据库 + 造数据 + 起租户上下文——
> 测试会变成「构造场景」而不是「断言行为」，且慢到没法反复跑。
>
> 阶段 3 的「库存流水双语义」就是靠把逻辑做成可测的纯函数才抓住 bug 的
> （`inventory.service.ts` 第 32–48 行与第 405–430 行的注释）。
>
> **纯函数的边界**：不碰数据库、不读上下文、不读 `Date.now()`。
> 时间由调用方通过 `context.now` 传进来（这也是 M15 的落点）。

### 2.1 先写失败测试

`api/src/modules/coupon/discount-engine.spec.ts`：

```typescript
import { computeDiscount } from './discount-engine';
import type { DiscountContext } from './discount-engine';

/**
 * 优惠引擎的纯函数单测。
 *
 * ⚠️ **全部在整数域里断言**：金额一律整数分。
 * 「满 100 减 30」写成 10000 与 3000，断言写成 `toBe(7000)`，
 * 不是 `toBeCloseTo(70)`。
 */

const NOW = new Date('2026-10-25T00:00:00Z');

function makeContext(
  overrides: Partial<DiscountContext> = {},
): DiscountContext {
  return {
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    now: NOW,
    originalAmount: 10000,
    items: [{ skuId: 'sku-1', quantity: 1, price: 10000 }],
    candidateCoupons: [],
    promotion: null,
    ...overrides,
  };
}

/** 造一张候选券 */
function coupon(overrides: Partial<DiscountContext['candidateCoupons'][number]> = {}) {
  return {
    id: 'coupon-1',
    code: 'SAVE10',
    name: '减 10 元',
    type: 'FIXED' as const,
    value: 1000,
    minAmount: 5000,
    ...overrides,
  };
}

describe('优惠引擎 computeDiscount', () => {
  describe('无券无活动', () => {
    it('没有券也没有活动：实付 = 原价，优惠额都是 0', () => {
      const result = computeDiscount(makeContext());

      expect(result.payableAmount).toBe(10000);
      expect(result.promotionDiscountAmount).toBe(0);
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.appliedCoupon).toBeNull();
    });
  });

  describe('门槛判定', () => {
    it('券的门槛按「活动后金额」判定：门槛不满足则这张券不可用', () => {
      // 门槛 5000，金额 10000 → 门槛满足
      const ok = computeDiscount(
        makeContext({ candidateCoupons: [coupon({ minAmount: 5000 })] }),
      );
      expect(ok.couponDiscountAmount).toBe(1000);
      expect(ok.payableAmount).toBe(9000);

      // 门槛 20000，金额 10000 → 不满足
      const notOk = computeDiscount(
        makeContext({ candidateCoupons: [coupon({ minAmount: 20000 })] }),
      );
      expect(notOk.couponDiscountAmount).toBe(0);
      expect(notOk.appliedCoupon).toBeNull();
      expect(notOk.payableAmount).toBe(10000);
    });

    it('门槛刚好等于金额：满足（≥ 而不是 >）', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 5000,
          candidateCoupons: [coupon({ minAmount: 5000, value: 1000 })],
        }),
      );

      expect(result.couponDiscountAmount).toBe(1000);
      expect(result.payableAmount).toBe(4000);
    });

    it('门槛为 0 = 无门槛：任何金额都可用', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 1,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );

      expect(result.couponDiscountAmount).toBe(1000);
      expect(result.payableAmount).toBe(0);
    });

    it('门槛按「活动后金额」判定：活动减完不达标则券不可用', () => {
      // 原价 10000，活动门槛 5000 减 6000 → 活动后 4000
      // 券的门槛 5000 → 4000 < 5000 → 券不可用
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: {
            id: 'promo-1',
            name: '满 50 减 60',
            minAmount: 5000,
            discountAmount: 6000,
          },
          candidateCoupons: [coupon({ minAmount: 5000, value: 1000 })],
        }),
      );

      expect(result.promotionDiscountAmount).toBe(6000);
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(4000);
    });
  });

  describe('优惠额封顶（M10 / M6）', () => {
    it('券面额大于应付金额：优惠额被封顶，实付为 0 而不是负数', () => {
      // 面额 1000，金额 300 → 减 300，不是减 1000
      const result = computeDiscount(
        makeContext({
          originalAmount: 300,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );

      expect(result.couponDiscountAmount).toBe(300);
      expect(result.payableAmount).toBe(0);
      // ⚠️ 关键断言：绝不为负
      expect(result.payableAmount).toBeGreaterThanOrEqual(0);
    });

    it('活动减免额大于原价：活动优惠额被封顶，实付为 0', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 300,
          promotion: {
            id: 'promo-1',
            name: '大额活动',
            minAmount: 0,
            discountAmount: 10000,
          },
        }),
      );

      expect(result.promotionDiscountAmount).toBe(300);
      expect(result.payableAmount).toBe(0);
    });

    it('实付恒不小于 0：遍历一组极端组合', () => {
      // 穷举一组「券面额 / 门槛 / 活动减免」的组合，断言 payable >= 0。
      // 这是 M10 的机械化版本——比逐个 case 断言更不容易漏。
      const amounts = [0, 1, 300, 9999, 10000];
      const values = [0, 1, 1000, 999999];
      for (const originalAmount of amounts) {
        for (const value of values) {
          for (const promoDiscount of [0, 1, 1000, 999999]) {
            const result = computeDiscount(
              makeContext({
                originalAmount,
                promotion: {
                  id: 'p',
                  name: 'p',
                  minAmount: 0,
                  discountAmount: promoDiscount,
                },
                candidateCoupons: [coupon({ minAmount: 0, value })],
              }),
            );
            expect(result.payableAmount).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });

  describe('多张券取最优（设计文档 §二 决策 3）', () => {
    it('两张券：选折后总价更低的那张', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [
            coupon({ id: 'c1', code: 'A', value: 1000, minAmount: 0 }),
            coupon({ id: 'c2', code: 'B', value: 3000, minAmount: 0 }),
          ],
        }),
      );

      expect(result.appliedCoupon?.id).toBe('c2');
      expect(result.couponDiscountAmount).toBe(3000);
      expect(result.payableAmount).toBe(7000);
    });

    it('两张券折后总价并列：取优惠额更大的那张', () => {
      // 面额 3000 但门槛 10000 → 不可用
      // 面额 2000 门槛 0 → 可用，优惠 2000
      // 另一张面额 2000 但金额只剩 1000 → 优惠 1000，折后 9000
      // 显然不等价；换成真正并列的场景：
      // 券 A：门槛 10000、面额 3000 → 可用，优惠 3000，折后 7000
      // 券 B：门槛 10000、面额 3000 → 可用，优惠 3000，折后 7000（并列）
      // 再加一张：门槛 10000、面额 3000 但夹在中间 → 断言取最先到的那张
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [
            coupon({ id: 'first', code: 'FIRST', value: 3000, minAmount: 10000 }),
            coupon({ id: 'second', code: 'SECOND', value: 3000, minAmount: 10000 }),
          ],
        }),
      );

      expect(result.couponDiscountAmount).toBe(3000);
      // 并列时取「先到的」——候选券的数组顺序
      expect(result.appliedCoupon?.id).toBe('first');
    });

    it('一张券门槛不满足、另一张满足：选中满足的那张', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          candidateCoupons: [
            coupon({ id: 'big', code: 'BIG', value: 1000, minAmount: 50000 }),
            coupon({ id: 'ok', code: 'OK', value: 2000, minAmount: 5000 }),
          ],
        }),
      );

      expect(result.appliedCoupon?.id).toBe('ok');
      expect(result.couponDiscountAmount).toBe(2000);
    });

    it('所有券都不可用：不选券，优惠额为 0', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [coupon({ minAmount: 50000 })],
        }),
      );

      expect(result.appliedCoupon).toBeNull();
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(10000);
    });
  });

  describe('活动与券的叠加顺序（M16）', () => {
    it('顺序是「先活动、后券」：券的门槛按活动后的金额判定', () => {
      // 原价 10000
      // 活动：门槛 5000，减 2000 → 活动后 8000
      // 券：门槛 8000（刚好等于活动后金额），面额 1000
      // 若顺序写反（先券后活动），券看到的是 10000 ≥ 8000 也满足，
      // 但优惠额会变成 10000 - 1000 - 2000 = 7000（一样）——
      // 所以要看**优惠额分配**：promotionDiscount 必须是 2000、couponDiscount 必须是 1000
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: {
            id: 'promo-1',
            name: '满 50 减 20',
            minAmount: 5000,
            discountAmount: 2000,
          },
          candidateCoupons: [coupon({ minAmount: 8000, value: 1000 })],
        }),
      );

      expect(result.promotionDiscountAmount).toBe(2000);
      expect(result.couponDiscountAmount).toBe(1000);
      expect(result.payableAmount).toBe(7000);
      // 恒等式：原价 - 活动 - 券 = 实付
      expect(
        10000 - result.promotionDiscountAmount - result.couponDiscountAmount,
      ).toBe(result.payableAmount);
    });

    it('顺序写反会被抓到：活动门槛按「券后金额」判定时优惠额会不同', () => {
      // 原价 10000
      // 券：门槛 0，面额 3000 → 券后 7000
      // 活动：门槛 8000，减 1000
      //
      // 「先活动后券」：活动看 10000 ≥ 8000 → 减 1000 → 9000；
      //                 券看 9000 ≥ 0 → 减 3000 → 实付 6000
      // 「先券后活动」：券减 3000 → 7000；活动看 7000 < 8000 → 不减
      //                 → 实付 7000
      //
      // 两者实付不同，所以这条断言能区分顺序。
      const result = computeDiscount(
        makeContext({
          originalAmount: 10000,
          promotion: {
            id: 'promo-1',
            name: '满 80 减 10',
            minAmount: 8000,
            discountAmount: 1000,
          },
          candidateCoupons: [coupon({ minAmount: 0, value: 3000 })],
        }),
      );

      expect(result.promotionDiscountAmount).toBe(1000);
      expect(result.couponDiscountAmount).toBe(3000);
      expect(result.payableAmount).toBe(6000);
    });
  });

  describe('PERCENT 类型（本阶段不实现，M11 的预留位）', () => {
    it('PERCENT 券不被使用：本阶段只实现 FIXED', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [coupon({ type: 'PERCENT', value: 90, minAmount: 0 })],
        }),
      );

      // 不选它，也不报错（本阶段是「静默跳过」，不是「抛异常」）
      expect(result.appliedCoupon).toBeNull();
      expect(result.couponDiscountAmount).toBe(0);
      expect(result.payableAmount).toBe(10000);
    });
  });

  describe('整数域（M11）', () => {
    it('实付与优惠额都是整数：绝不含浮点尾数', () => {
      const result = computeDiscount(
        makeContext({
          originalAmount: 3000,
          candidateCoupons: [coupon({ minAmount: 0, value: 1000 })],
        }),
      );

      expect(Number.isInteger(result.payableAmount)).toBe(true);
      expect(Number.isInteger(result.couponDiscountAmount)).toBe(true);
      expect(Number.isInteger(result.promotionDiscountAmount)).toBe(true);
      // ⚠️ 具体地：不能是 2000.0000000000005 这类值
      expect(result.payableAmount).toBe(2000);
    });
  });

  describe('appliedCoupon 的内容', () => {
    it('选中时带上 id / code / name / discountAmount', () => {
      const result = computeDiscount(
        makeContext({
          candidateCoupons: [
            coupon({ id: 'c9', code: 'HELLO', name: '见面礼', value: 2000, minAmount: 0 }),
          ],
        }),
      );

      expect(result.appliedCoupon).toEqual({
        id: 'c9',
        code: 'HELLO',
        name: '见面礼',
        discountAmount: 2000,
      });
    });
  });
});
```

- [ ] **Step 2.2: 跑测试确认失败**

```bash
cd api && npx jest src/modules/coupon/discount-engine.spec.ts
```

预期：FAIL，`Cannot find module './discount-engine'`。

- [ ] **Step 2.3: 写引擎**

`api/src/modules/coupon/discount-engine.ts`：

```typescript
/**
 * 优惠引擎（阶段 5a Task 2）。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文、不读 `Date.now()`。
 * 时间由调用方通过 `context.now` 传进来（这是 M15 的落点——
 * 过期判定用数据库的 `now()`，不用应用进程的时钟）。
 *
 * 为什么必须纯函数：优惠引擎的每一条分支都要能被完整断言。
 * 引擎读数据库的话，测它就要起数据库 + 造数据 + 起租户上下文，
 * 测试会变成「构造场景」而不是「断言行为」。
 * 阶段 3 的「库存流水双语义」就是靠把逻辑做成可测的纯函数才抓住 bug 的。
 *
 * ## 算法（顺序不可换，设计文档 §4.2）
 *
 * ```
 * 1. promotionDiscount = 0
 *    若 promotion 存在且 未过期 且 originalAmount >= promotion.minAmount：
 *        promotionDiscount = min(promotion.discountAmount, originalAmount)
 *    afterPromotion = originalAmount - promotionDiscount
 *
 * 2. 对每张候选券：
 *        若 afterPromotion < coupon.minAmount → 该券不可用
 *        else：
 *            discount = min(coupon.value, afterPromotion)
 *            该券的折后总价 = afterPromotion - discount
 *    取「折后总价最小」的那张券；并列时取优惠额最大的；再并列取先到的
 *
 * 3. couponDiscount = 选中券的 discount（没选中则 0）
 * 4. payable = afterPromotion - couponDiscount     ← 恒 >= 0
 * ```
 *
 * ⚠️ **门槛按「活动后金额」判定，优惠额也按「活动后金额」封顶。**
 * 用户视角：应付多少，就按多少判门槛、减多少。
 *
 * ⚠️ **满减额不能把金额减成负数**：`min(discount, 金额)` 这个封顶是硬要求。
 * 没有它，一张 100 元的满减券用在 30 元的订单上会让 payable 变成 -70。
 */

/** 候选券的输入形状（由 service 层从库里读出来） */
export interface CouponCandidate {
  id: string;
  code: string;
  name: string;
  /** FIXED：满减券（本阶段唯一实现）；PERCENT：折扣券（预留） */
  type: 'FIXED' | 'PERCENT';
  /** FIXED 时是面额（整数分）；PERCENT 时是折扣数（85 = 85 折） */
  value: number;
  /** 使用门槛（整数分）。0 = 无门槛 */
  minAmount: number;
}

/** 满减活动的输入形状 */
export interface PromotionCandidate {
  id: string;
  name: string;
  /** 门槛（整数分）：订单商品原价小计 >= minAmount 才享受 */
  minAmount: number;
  /** 减免金额（整数分） */
  discountAmount: number;
}

/** 引擎的输入 */
export interface DiscountContext {
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
  /**
   * 当前时间。
   *
   * ⚠️ **由调用方传入，引擎自己不读 `Date.now()`**——
   * 这样测试可以确定性地构造「已过期 / 未过期」的场景。
   *
   * ⚠️ 生产上这个值应当来自**数据库的 `now()`**（M15）：
   * 用应用进程的时钟，多副本部署时各机器的时钟有偏差，
   * 边界时刻会出现「这张券在这台机器上过期了、在那台机器上还没过期」。
   */
  now: Date;
}

/** 引擎的输出 */
export interface DiscountResult {
  /** 用了哪张券（没就是 null） */
  appliedCoupon: {
    id: string;
    code: string;
    name: string;
    discountAmount: number;
  } | null;
  /** 满减活动减免（整数分） */
  promotionDiscountAmount: number;
  /** 券减免（整数分） */
  couponDiscountAmount: number;
  /** 最终应付（整数分）。恒 >= 0 */
  payableAmount: number;
}

/**
 * 计算优惠。
 *
 * ⚠️ **全程整数域**：`min` / 加减乘除都不涉及浮点。
 * 将来做折扣券（PERCENT）时，折扣额必须用整数域算：
 * `Math.round(原价 * (100 - 折扣) / 100)`，绝不能 `原价 * (1 - 折扣/100)`
 * ——后者会引入浮点尾数（M11）。
 */
export function computeDiscount(context: DiscountContext): DiscountResult {
  const { originalAmount, candidateCoupons, promotion, now } = context;

  // ---- 1. 满减活动 ----
  //
  // ⚠️ 活动的过期判定用**调用方传入的 now**（生产上是数据库的 now()），
  // 不用应用进程的时钟（M15）。
  let promotionDiscountAmount = 0;
  if (
    promotion &&
    isWithinWindow(promotion.startsAt, promotion.endsAt, now) &&
    originalAmount >= promotion.minAmount
  ) {
    // ⚠️ 封顶：活动减免不能超过原价，否则 payable 会变负（M10）。
    promotionDiscountAmount = Math.min(promotion.discountAmount, originalAmount);
  }
  const afterPromotion = originalAmount - promotionDiscountAmount;

  // ---- 2. 券：逐张算折后总价，取最优 ----
  //
  // ⚠️ 「最优」的判据是**折后总价最小**（设计文档 §4.2），
  // 不是「优惠额最大」——两者在金额被封顶时不等价：
  // 一张面额 10000 的券用在 3000 的单上，优惠额被封顶成 3000，
  // 折后 0；另一张面额 2000 的券优惠 2000，折后 1000。前者更优。
  let best: { coupon: CouponCandidate; discount: number; payable: number } | null =
    null;

  for (const coupon of candidateCoupons) {
    // ⚠️ PERCENT 本阶段不实现：静默跳过（不抛异常）。
    // 抛异常的话，库里存了一张 PERCENT 券就会让整个下单流程挂掉——
    // 那比「这张券不生效」糟糕得多。
    if (coupon.type !== 'FIXED') {
      continue;
    }
    // 门槛按**活动后金额**判定
    if (afterPromotion < coupon.minAmount) {
      continue;
    }
    // ⚠️ 优惠额按**活动后金额**封顶（M10）
    const discount = Math.min(coupon.value, afterPromotion);
    const payable = afterPromotion - discount;

    if (best === null || payable < best.payable) {
      best = { coupon, discount, payable };
    }
    // ⚠️ **并列时取先到的**：上面的比较是严格小于（`<`），
    // 所以优惠额相等（折后总价相等）时保留先遍历到的那张。
    // 候选券的顺序由 service 层按 `claimedAt` 升序给出，
    // 保证「并列取先到的」是确定的、可测的。
  }

  const couponDiscountAmount = best?.discount ?? 0;

  // ---- 3 & 4. 实付 ----
  //
  // ⚠️ 恒 >= 0：步骤 2 的 `min` 保证了 discount <= afterPromotion，
  // 而 afterPromotion >= 0（活动减免也被封顶了）。
  const payableAmount = afterPromotion - couponDiscountAmount;

  return {
    appliedCoupon: best
      ? {
          id: best.coupon.id,
          code: best.coupon.code,
          name: best.coupon.name,
          discountAmount: best.discount,
        }
      : null,
    promotionDiscountAmount,
    couponDiscountAmount,
    payableAmount,
  };
}

/**
 * 当前时刻是否落在有效期内。
 *
 * ⚠️ 边界是**左闭右开**（`startsAt <= now < endsAt`）：
 * `startsAt === endsAt` 意味着「有效期内长度为 0」，永远不生效。
 */
export function isWithinWindow(
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined,
  now: Date,
): boolean {
  if (startsAt && now.getTime() < startsAt.getTime()) {
    return false;
  }
  if (endsAt && now.getTime() >= endsAt.getTime()) {
    return false;
  }
  return true;
}
```

> ⚠️ **`PromotionCandidate` 里加了 `startsAt` / `endsAt`**——
> 设计文档 §4.1 的 `PromotionCandidate` 只列了 `id / name / minAmount / discountAmount`，
> 但 §4.2 的算法说「若 promotion 存在且 **未过期**」。
> **「未过期」这个判据在输入形状里必须有对应字段**，否则引擎没法实现它。
> 活动与券的有效期判定逻辑相同（都是 `startsAt <= now < endsAt`），
> 所以两个 candidate 都带上这两个字段。

- [ ] **Step 2.4: 跑测试确认通过**

```bash
cd api && npx jest src/modules/coupon/discount-engine.spec.ts
```

预期：PASS。

- [ ] **Step 2.5: 提交**

```bash
git add api/
git commit -m "feat(api): 优惠引擎（纯函数）

优惠引擎是纯函数 computeDiscount(context): DiscountResult——不碰数据库、
不读上下文、不读 Date.now()（时间由调用方通过 context.now 传入）。
这样它的每一条分支都能被完整单测：门槛不满足、门槛刚好满足、券面额大于
应付、活动与券叠加、无券、所有券都不可用。

纯函数不是洁癖，是为了让测试断言「行为」而不是「构造场景」。
阶段 3 的库存流水双语义就是靠把逻辑做成可测的纯函数才抓住 bug 的。

三处要害：
- 优惠额按「活动后金额」封顶（min(面额, 应付)）。没有它，一张 100 元的
  满减券用在 30 元的订单上会让实付变成 -70（M10）。
- 门槛按「活动后金额」判定，顺序固定「先活动、后券」。用户视角是「应付
  多少就按多少判门槛、减多少」。顺序写反的用例能抓到它（M16）。
- 多张券取「折后总价最小」的那张，不是「优惠额最大」——面额被封顶时两者
  不等价。并列时取先到的，候选券顺序由 service 层按 claimedAt 升序给出，
  保证可测。

全程整数域：将来做折扣券（PERCENT）时用 Math.round(原价 * (100-折扣) / 100)，
绝不用原价 * (1 - 折扣/100)——后者会引入浮点尾数（M11）。本阶段的 PERCENT
券静默跳过而不是抛异常：库里存了一张 PERCENT 券不该让整个下单流程挂掉。"
```

---

## Task 3：券与满减活动的管理、领取

本 Task 实现「商家发券/发活动」与「消费者领券」两条链路，以及 M4（限额并发超发）、
M7（平台券不被伪造）、M14（计数同步）、M15（数据库时钟）。

**Files:**
- Create: `api/src/modules/coupon/coupon.module.ts`
- Create: `api/src/modules/coupon/coupon.service.ts`
- Create: `api/src/modules/coupon/coupon.controller.ts`
- Create: `api/src/modules/coupon/merchant-coupon.controller.ts`
- Create: `api/src/modules/coupon/promotion.service.ts`
- Create: `api/src/modules/coupon/dto/create-coupon.dto.ts`
- Create: `api/src/modules/coupon/dto/update-coupon.dto.ts`
- Create: `api/src/modules/coupon/dto/claim-coupon.dto.ts`
- Create: `api/src/modules/coupon/dto/create-promotion.dto.ts`
- Create: `api/src/modules/coupon/dto/update-promotion.dto.ts`
- Modify: `api/src/app.module.ts`
- Test: `api/test/coupon.e2e-spec.ts`

### 3.1 先写失败测试

`api/test/coupon.e2e-spec.ts`。护栏对应：**M4 限额并发超发**、
**M7 平台券不被伪造**、**M14 计数同步**、**M15 数据库时钟**。

```typescript
  it('领券：claimedCount 加 1，coupon_claims 里多一行', async () => {
    // 领一张 → claimedCount = 1、coupon_claims 有 1 行 quantity = 1
  });

  it('并发领限量券：只有请求数个成功，其余 409', async () => {
    // ⚠️ **要真的并发**：Promise.all([...])，不能先 await A 再 await B。
    // 券的 totalLimit = 1，10 个并发请求 → 只有 1 个 201，其余 409。
    // 且 claimedCount 必须**恰好是 1**（不是 2、不是 0）。
  });

  it('并发领限量券之后：claimedCount 与 coupon_claims 的 quantity 之和一致', async () => {
    // M14。断言 coupons.claimedCount === Σ(coupon_claims.quantity)
  });

  it('每用户限领：超出 perUserLimit 被拒', async () => {
    // perUserLimit = 1，同一用户领第二次 → 409
    // 另一个用户领 → 成功
  });

  it('已过期的券不能领', async () => {
    // endsAt 在过去 → 409
  });

  it('未开始的券不能领', async () => {
    // startsAt 在未来 → 409
  });

  it('暂停的券不能领（status = PAUSED）', async () => { /* ... */ });

  it('平台券不被伪造：商家创建的券 scope 一律是 SHOP', async () => {
    // ⚠️ M7。请求体里传 scope: 'PLATFORM' → 后端**忽略**它（DTO 里不声明
    // 这个字段 → forbidNonWhitelisted 直接 400）。
    // 断言：创建的券 scope === 'SHOP'，且响应 201。
    // 若实现是「DTO 接收 scope 并原样写入」，这条会挂。
  });

  it('平台超管创建的券 scope 才是 PLATFORM', async () => {
    // 用平台作用域的上下文创建 → scope === 'PLATFORM'
    // ⚠️ 平台作用域下 create 必须显式指定 tenantId（扩展的规则，
    // 见 tenant-prisma.service.ts 第 322–332 行）
  });

  it('券码重复：P2002 转 409 而不是 500', async () => {
    // 同一租户内创建两个同 code 的券 → 第二个 409
    // 用 rethrowIfUniqueViolation 的文案
  });

  it('过期判定用数据库的 now()：用「数据库时钟往前推」构造的券已过期', async () => {
    // ⚠️ M15。构造一个 startsAt/endsAt 相对**数据库当前时间**已经过期的券，
    // 领它 → 409。
    // 这条测的是「查询里的时间比较用的是数据库的 now()」——
    // 实现里应该用 $queryRaw 取 now() 或在 where 里直接写 Prisma.sql。
  });

  it('软删的券不能领、不能出现在可领列表里', async () => { /* ... */ });
```

> **并发用例的断言要具体**：
> - 「只有 1 个成功」要断言 `responses.filter(r => r.status === 201).length === 1`
> - 「claimedCount 恰好是 1」要查库断言 `coupon.claimedCount === 1`
> - 「计数与领取记录一致」要**求和**：`claims.reduce((s, c) => s + c.quantity, 0)`
>   ——只断言 `claims.length === 1` 是不够的（quantity 可能是 2）
>
> **M15 的测试要点**：不能只断言「过期了领不到」——那测不出「用的是数据库时钟
> 还是应用时钟」。要断言的是**边界行为**：把券的 `endsAt` 设成
> 「数据库当前时间 - 1 秒」就领不到。若实现用的是应用进程的 `new Date()`，
> 在本机（应用与数据库同一台机器）两者几乎一样，测不出差别——
> **所以这条测试的价值在于锁住「查询里用了数据库 now()」这个写法**，
> 失败注入时把它改成 `new Date()` 即可验证测试有效。

### 3.2 写 DTO

`api/src/modules/coupon/dto/create-coupon.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 创建优惠券。
 *
 * ⚠️ **不声明 `scope` 字段**（M7）：平台券只能由平台超管创建，
 * 而「当前用户是不是平台超管」是**服务端**从登录身份推导的，
 * 不是客户端能传的字段。客户端传 `scope` 会被
 * `forbidNonWhitelisted` 直接 400。
 *
 * ⚠️ **不声明 `claimedCount` / `reservedCount` / `usedCount`**：
 * 它们是服务端的计数，客户端传了就是伪造额度。
 *
 * ⚠️ **不声明 `tenantId`**：租户由上下文推导。
 */
export class CreateCouponDto {
  @ApiProperty({ description: '券码（租户内唯一）' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: '券名称' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ required: false, description: '券说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: '面额（整数分）', example: 1000 })
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  value!: number;

  @ApiProperty({ description: '使用门槛（整数分），0 = 无门槛', example: 5000 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  minAmount!: number;

  @ApiProperty({ required: false, description: '每用户限领张数，不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  perUserLimit?: number;

  @ApiProperty({ required: false, description: '总发放上限，不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  totalLimit?: number;

  @ApiProperty({ description: '生效开始时间（ISO 8601）' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ description: '生效结束时间（ISO 8601）' })
  @IsISO8601()
  endsAt!: string;
}
```

`api/src/modules/coupon/dto/claim-coupon.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 领取优惠券。
 *
 * ⚠️ **只接受 `couponId` 或 `code`**——券的面额、门槛、有效期一律从库里读。
 * 客户端传 `discountAmount` / `value` / `minAmount` 会被
 * `forbidNonWhitelisted` 直接 400（M2）。
 */
export class ClaimCouponDto {
  @ApiProperty({ required: false, description: '券 id（与 code 二选一）' })
  @IsOptional()
  @IsString()
  couponId?: string;

  @ApiProperty({ required: false, description: '券码（与 couponId 二选一）' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ required: false, description: '领取张数，默认 1', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;
}
```

`api/src/modules/coupon/dto/create-promotion.dto.ts` 与 `update-promotion.dto.ts` 同形
（`name` / `description?` / `minAmount` / `discountAmount` / `startsAt` / `endsAt`），
`update-coupon.dto.ts` 是 `create-coupon.dto.ts` 的全 `Partial` 版本。

> **DTO 校验的边界**：`endsAt` 大于 `startsAt` 这类**跨字段**校验，
> `class-validator` 的装饰器做不到，要**在 service 层显式判**并抛 `BadRequestException`。
> 不要为了这个引入 `@ValidateIf` 之类的组合技巧——那会让校验规则散在两处。

### 3.3 写领取逻辑（M4 的核心）

`api/src/modules/coupon/coupon.service.ts`：

```typescript
  /**
   * 领取优惠券。
   *
   * ## M4：限额不被并发超发
   *
   * ⚠️ **必须用条件更新，不能「先查后改」**。
   *
   * 「先查 claimedCount 再写」的话，两个并发请求会都读到同一个旧值
   * （比如 0），都判定「还有额度」，然后都写 1 —— **结果是 1，但发出去了 2 张**
   * （`coupon_claims` 里两行，用户的券多了一张，商家亏一张）。
   *
   * 正确做法（与阶段 3 的状态流转同款）：
   * ```
   * updateMany({ where: { id, claimedCount: { lt: totalLimit } },
   *              data: { claimedCount: { increment: 1 } } })
   * ```
   * 受影响行数为 0 就是「额度已满」→ 409。
   * 数据库保证只有一个并发请求能拿到额度。
   *
   * ⚠️ **每用户限领用同一套办法**：先 `updateMany` 扣 `coupon_claims`
   * 那一行的 quantity（where 带 `quantity + 本次 <= perUserLimit`），
   * 受影响行数为 0 就是超限。
   *
   * ⚠️ **两件事必须在同一个事务里**：
   * 1. `coupons.claimedCount` 的条件更新
   * 2. `coupon_claims` 那一行的 upsert（quantity 累加）
   * 分成两个事务的话，计数加了而领取记录没加 → 用户的券凭空消失。
   */
  async claim(couponIdOrCode: string, customerId: string, quantity: number) {
    const tenantId = this.currentTenantId();

    return this.prisma.$transaction(
      async (tx) => {
        // 1. 找券（租户作用域内 —— 扩展自动附加 tenantId 条件）
        const coupon = await this.findCoupon(tx, couponIdOrCode);
        if (!coupon) {
          throw new NotFoundException('优惠券不存在');
        }

        // 2. 状态与有效期判定
        //
        // ⚠️ **有效期判定用数据库的 now()**（M15），不用应用进程的时钟。
        // 用 $queryRaw 取数据库的当前时间——`SELECT now()` 返回的是
        // 数据库服务器的时间，与时区配置无关。
        const dbNow = await this.databaseNow(tx);
        if (coupon.status !== CouponStatus.ACTIVE) {
          throw new ConflictException('该优惠券当前不可领取');
        }
        if (!isWithinWindow(coupon.startsAt, coupon.endsAt, dbNow)) {
          throw new ConflictException('该优惠券不在领取时间内');
        }

        // 3. **条件更新**扣总量（M4）
        //
        // ⚠️ `claimedCount: { lt: totalLimit }` 这个 where 条件只在
        // totalLimit 非空时才有意义 —— totalLimit 为 null（不限量）时，
        // where 条件要省略（`{ lt: null }` 在 Prisma 里恒为 false，
        // 会把不限量的券也拦住）。
        const affected = await tx.coupon.updateMany({
          where: {
            id: coupon.id,
            ...(coupon.totalLimit !== null
              ? { claimedCount: { lt: coupon.totalLimit } }
              : {}),
          },
          data: { claimedCount: { increment: quantity } },
        });
        if (affected.count === 0) {
          throw new ConflictException('该优惠券已被领完');
        }

        // 4. **条件更新**扣每用户限量
        //
        // ⚠️ `coupon_claims` 上有 `@@unique([couponId, customerId])`
        // （手写的部分唯一索引），所以一个用户对一张券只有一行。
        // 「增量」用 `updateMany` + `quantity: { lt: perUserLimit }`：
        // ⚠️ 这里判的是**行内的 quantity**，而条件写在 where 里要写成
        //    `quantity: { lte: perUserLimit - quantity }`（本次领取后的总量
        //    不超过限额）。Prisma 的 `lt`/`lte` 是与**当前行值**比较，
        //    不是「比较后再加」——所以这里要把「本次领取量」先从限额里减掉。
        const limit = coupon.perUserLimit;
        if (limit !== null) {
          const claimed = await tx.couponClaim.findFirst({
            where: { couponId: coupon.id, customerId },
            select: { quantity: true },
          });
          const already = claimed?.quantity ?? 0;
          if (already + quantity > limit) {
            // ⚠️ 这里**不能直接抛**：前面第 3 步的 claimedCount 已经加了，
            // 抛异常会让整个事务回滚——那正是我们要的（回滚掉第 3 步的计数）。
            // 所以直接抛，让事务回滚即可。
            throw new ConflictException('你已达到该优惠券的限领张数');
          }
        }

        // 5. 写领取记录（upsert 一行，quantity 累加）
        await tx.couponClaim.upsert({
          where: { couponId_customerId: { couponId: coupon.id, customerId } },
          create: { tenantId, couponId: coupon.id, customerId, quantity },
          update: { quantity: { increment: quantity } },
        });

        return { couponId: coupon.id, quantity };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }
```

> ⚠️ **`upsert` 在租户作用域模型上是禁止的**——
> `tenant-prisma.service.ts` 第 307–314 行的 `assertNotUniqueOnly` 会拦 `upsert`：
> 「Prisma 的 upsert 只接受唯一字段，无法附加 tenantId 条件，会造成跨租户越权」。
>
> **正确写法**是「先 `findFirst` 查，再分情况 `create` 或 `updateMany`」：
>
> ```typescript
> const existing = await tx.couponClaim.findFirst({
>   where: { couponId: coupon.id, customerId },
> });
> if (existing) {
>   await tx.couponClaim.updateMany({
>     where: { id: existing.id },
>     data: { quantity: { increment: quantity } },
>   });
> } else {
>   await tx.couponClaim.create({
>     data: { tenantId, couponId: coupon.id, customerId, quantity },
>   });
> }
> ```
>
> ⚠️ **并发下这个写法有个窗口**：两个请求都 `findFirst` 查不到 → 都 `create` →
> 一个撞 `coupon_claims_coupon_customer_uniq` 的 P2002。
> **P2002 必须在事务外处理**（唯一约束冲突让 PostgreSQL 事务 aborted）。
> 所以外层要 catch P2002 → **在事务外**重试一次整个领取流程。
> 这与 `order.service.ts` 第 176–198 行的幂等键处理完全同款。
>
> ⚠️ **另外，`create` 时 `tenantId` 要显式写出**：租户扩展在运行时会注入它，
> 但 TypeScript 只认 Prisma 生成的类型，不看运行时行为，漏掉会在
> `tsc --noEmit` 处报错（`inventory.service.ts` 第 213–216 行的注释）。

**「数据库时钟」的取法**：

```typescript
  /**
   * 取数据库的当前时间。
   *
   * ⚠️ **M15：过期判定统一用数据库的 `now()`**，不用应用进程的时钟。
   *
   * 为什么：多副本部署时各机器的时钟有偏差，边界时刻会出现
   * 「这张券在这台机器上过期了、在那台机器上还没过期」。
   * 数据库的 `now()` 是**单一事实来源**。
   *
   * ⚠️ `$queryRaw` 绕过 Prisma 扩展——但这里查的是 `now()`，
   * **不涉及任何租户数据**，所以不需要手写 tenantId 条件
   * （与 `inventory.service.ts` 第 542–547 行那条不同：那里查的是租户数据）。
   */
  private async databaseNow(tx: PrismaTransaction): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`;
    return rows[0].now;
  }
```

> ⚠️ **候选券与活动的查询也要用数据库时钟**：
> `where: { startsAt: { lte: dbNow }, endsAt: { gt: dbNow } }`
> ——注意是 `lte` / `gt`（左闭右开），与 `isWithinWindow` 的边界一致。

### 3.4 写创建券（M7）

```typescript
  /**
   * 创建优惠券（商家侧）。
   *
   * ⚠️ **M7：`scope` 由服务端决定，不由客户端传入**。
   *
   * - 商家账号（MERCHANT_OWNER / MERCHANT_STAFF）→ 一律 `SHOP`
   * - 平台超管（PLATFORM_ADMIN）→ `PLATFORM`
   *
   * 客户端传 `scope` 会被 `forbidNonWhitelisted` 直接 400（DTO 里没这个字段）。
   * 但**服务端也不能盲信 DTO**——DTO 只是第一道闸，
   * 这里显式从**登录身份**推导才是真正的兑现点。
   */
  async createCoupon(dto: CreateCouponDto): Promise<Coupon> {
    const context = getTenantContext();
    const isPlatformAdmin = context.role === UserRole.PLATFORM_ADMIN;

    // ⚠️ 平台超管创建时租户从请求上下文拿不到（平台作用域的 tenantId 是 null），
    // 所以平台券的 tenantId 要显式指定。
    // ⚠️ **平台作用域下扩展要求 create 显式带 tenantId**
    // （tenant-prisma.service.ts 第 322–332 行），
    // 少带会抛 TenantScopeError。
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('平台超管创建平台券时必须指定目标租户');
    }

    // 校验有效期
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }

    try {
      return await this.prisma.coupon.create({
        data: {
          tenantId,
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          type: CouponType.FIXED,
          value: dto.value,
          minAmount: dto.minAmount,
          perUserLimit: dto.perUserLimit ?? null,
          totalLimit: dto.totalLimit ?? null,
          scope: isPlatformAdmin ? CouponScope.PLATFORM : CouponScope.SHOP,
          status: CouponStatus.ACTIVE,
          startsAt,
          endsAt,
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**：这里没有开事务，但 catch 里也不要做查询。
      // rethrowIfUniqueViolation 只把 P2002 转成 409，其它错误原样抛出
      // （common/errors/unique-constraint.ts 的注释说明了为什么不能吞掉别的错误）。
      rethrowIfUniqueViolation(error, '券码');
    }
  }
```

> ⚠️ **`type` 固定写 `CouponType.FIXED`**：本阶段只实现满减券。
> DTO 里**没有** `type` 字段——让客户端传 `type: 'PERCENT'` 的话，
> 库里会躺着一张本阶段算不动的券（引擎会静默跳过它，用户领了却用不了）。
> 折扣券的实现留到将来的阶段，那时再放开 DTO。
>
> ⚠️ **`rethrowIfUniqueViolation` 的签名是 `(error, fieldLabel): never`**——
> 它要么抛 409、要么把原错误抛出去，所以**不需要**再 `throw`。
> 但 TypeScript 不知道它是 `never`（函数签名里写了 `: never`，调用方
> 能推断出「后面不可达」——所以 `catch` 块结束时不需要补 throw）。

### 3.5 写控制器

**消费者侧** `coupon.controller.ts`：

```typescript
/**
 * 消费者侧的优惠券接口。
 *
 * ⚠️ **领券必须登录**：`coupon_claims` 记的是 customerId，
 * 游客领了也没地方记。所以这里挂 JwtAuthGuard（不是 OptionalJwtAuthGuard）。
 */
@ApiTags('coupons')
@Controller('coupons')
@UseGuards(JwtAuthGuard)
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Get('available')
  @ApiOperation({ summary: '当前可领取的券' })
  async available(@Req() request: Request) {
    return this.couponService.listAvailable(this.currentCustomerId(request));
  }

  @Get('mine')
  @ApiOperation({ summary: '我持有的券' })
  async mine(@Req() request: Request) {
    return this.couponService.listMine(this.currentCustomerId(request));
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '领取优惠券' })
  async claim(@Body() dto: ClaimCouponDto, @Req() request: Request) {
    return this.couponService.claim(dto, this.currentCustomerId(request));
  }
}
```

**商家侧** `merchant-coupon.controller.ts`：

```typescript
/**
 * 商家侧的优惠券与活动接口。
 *
 * ⚠️ **路径是 `merchant/coupons` 而不是 `coupons`**——
 * 与 `merchant/orders` 同款理由：消费者侧与商家侧的鉴权方式根本不同，
 * 同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 */
@ApiTags('merchant-coupons')
@Controller('merchant/coupons')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantCouponController {
  // GET    /merchant/coupons          券列表
  // POST   /merchant/coupons          创建券
  // PATCH  /merchant/coupons/:id      改券（暂停 / 启用 / 改面额）
  // DELETE /merchant/coupons/:id      软删券
  // GET    /merchant/promotions       活动列表
  // POST   /merchant/promotions       创建活动
  // PATCH  /merchant/promotions/:id   改活动
  // DELETE /merchant/promotions/:id   软删活动
}
```

> ⚠️ **「暂停 / 启用」用 `PATCH` 改 `status`，不用单独的端点**——
> `status` 有三个值（ACTIVE / PAUSED / EXPIRED），用 `PATCH` 改更直白。
> `EXPIRED` **不由客户端设置**：它是系统在券过期时算出来的展示态，
> 客户端设了也没意义（本阶段的过期判定靠 `endsAt`，不靠 `status`）。

### 3.6 写模块与注册

`api/src/modules/coupon/coupon.module.ts`：

```typescript
@Module({
  imports: [AuthModule],
  controllers: [CouponController, MerchantCouponController],
  providers: [CouponService, PromotionService],
  exports: [CouponService, PromotionService],
})
export class CouponModule {}
```

在 `api/src/app.module.ts` 的 `imports` 里加 `CouponModule`。

### 3.7 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/coupon.e2e-spec.ts
```

### 3.8 提交

```bash
git add api/
git commit -m "feat(api): 优惠券与满减活动的管理与领取

领券的限额判定用**条件更新**（updateMany where 带 claimedCount < totalLimit），
不用「先查后改」：两个并发请求会都读到同一个旧值、都判定「还有额度」，
然后都写 1——结果是计数是 1，但发出去了 2 张，商家亏一张。
数据库保证只有一个并发请求能拿到额度（M4）。每用户限领用同一套办法。

有效期判定统一用**数据库的 now()**（M15），不用应用进程的时钟：
多副本部署时各机器的时钟有偏差，边界时刻会出现「这张券在这台机器上过期了、
在那台机器上还没过期」。数据库的 now() 是单一事实来源。

scope 由服务端从登录身份推导（M7）：店铺账号创建的券一律 SHOP，
平台超管创建的才是 PLATFORM。客户端传 scope 会被 forbidNonWhitelisted 400，
但 DTO 只是第一道闸，服务端显式推导才是真正的兑现点。

DTO 里刻意**没有** type 字段：本阶段只实现满减券，让客户端传 type: 'PERCENT'
的话，库里会躺着一张本阶段算不动的券（引擎会静默跳过，用户领了却用不了）。

coupon_claims 的累计用「先 findFirst 再 create/updateMany」而不是 upsert——
租户作用域模型上 upsert 被扩展直接拒绝（它只接受唯一字段，附加不了
tenantId 条件）。并发下两个请求都查到「不存在」会撞部分唯一索引，
P2002 在事务外重试一次整个领取流程。"
```

---

## Task 4：下单流程接入优惠 + 券的预占核销

**这是本阶段的第二个核心 Task。** 优惠计算挂进阶段 3 的下单事务，
券的核销与建单同生共死。

**Files:**
- Create: `api/src/modules/coupon/coupon-redemption.service.ts`
- Modify: `api/src/modules/order/order.service.ts`
- Modify: `api/src/modules/order/dto/place-order.dto.ts`
- Test: `api/test/order-discount.e2e-spec.ts`

### 4.1 先写失败测试

`api/test/order-discount.e2e-spec.ts`。护栏对应：**M1 客户端传优惠金额无效**、
**M2 门槛/面额不可篡改**、**M3 跨租户用券被拒**、**M5 同一张券不被两笔订单同时用**、
**M6 优惠不绕过金额校验**、**M12 历史订单不被重算**、**M14 计数同步**、
**M16 叠加顺序**。

```typescript
  it('下单用券：实付 = 原价 - 券减免，订单里写优惠快照', async () => {
    // 原价 10000，券面额 1000 → order.totalAmount = 9000
    // order.couponDiscountAmount = 1000、order.couponId = 券 id、
    // order.couponCode / couponName = 券的快照
    // order.originalAmount = 10000
  });

  it('下单不带券：优惠字段全为 0，实付 = 原价', async () => { /* ... */ });

  it('M1：请求体里带 discountAmount → 400，订单金额不受影响', async () => {
    // 请求 { ..., discountAmount: 99999 } → 400（forbidNonWhitelisted）
    // 且不能建出订单
  });

  it('M2：请求体里带 couponValue / couponMinAmount → 400', async () => {
    // 同上
  });

  it('M2：只传 couponId 时，面额与门槛一律从库里读', async () => {
    // 库里券面额 1000 → 订单 couponDiscountAmount = 1000
    // 请求体里没有任何面额字段能改它
  });

  it('M3：跨租户用券被拒', async () => {
    // A 店的券拿到 B 店下单 → 券不在候选列表里 → 不用它（实付 = 原价）
    // 或显式传一个别家店的 couponId → 400 / 404
  });

  it('M3：平台券在任意店铺可用', async () => {
    // 平台券（scope = PLATFORM）→ B 店也能用
  });

  it('M5：并发用同一张券下单：只有一个订单成功，另一个 409', async () => {
    // ⚠️ **要真的并发**：Promise.all([...])
    // 同一张券，两个并发下单 → 一个 201、一个 409
    // 且 coupon_redemptions 里只有 1 行 RESERVED
  });

  it('M5：券被一张订单占用后，不能被另一张订单用', async () => {
    // 顺序执行：第一个下单成功，第二个下单 → 409
  });

  it('M6：券面额大于订单金额时，实付为 0 而不是负数', async () => {
    // 券面额 10000，订单 300 → totalAmount = 0
    // ⚠️ 断言 order.totalAmount >= 0
  });

  it('M6：下单前校验实付不为负', async () => {
    // 断言 order.totalAmount >= 0（查库）
  });

  it('M12：改了券的规则后，历史订单金额不变', async () => {
    // 下单 → 把券的 value 改成 5000 → 再读订单 → totalAmount 仍是原来的值
  });

  it('M12：订单里的券名与券码是快照', async () => {
    // 下单 → 把券改名 → 订单里的 couponName 仍是旧名字
  });

  it('M16：活动与券叠加，活动先、券后', async () => {
    // 原价 10000，活动减 2000、券减 1000 → 实付 7000
    // 订单里 promotionDiscountAmount = 2000、couponDiscountAmount = 1000
  });

  it('M14：核销后券的 reservedCount 加 1', async () => {
    // 查库断言 coupons.reservedCount === 1
    // 且 coupon_redemptions 里那一行的 status === 'RESERVED'、
    // discountAmount === 订单里的 couponDiscountAmount
  });

  it('门槛不满足的券不参与优惠：实付 = 原价', async () => { /* ... */ });

  it('已过期的券不参与优惠', async () => { /* ... */ });

  it('不在有效期内的活动不参与优惠', async () => { /* ... */ });
```

> **M5 的并发用例断言要具体**：
> - `responses.filter(r => r.status === 201).length === 1`
> - `responses.filter(r => r.status === 409).length === 1`
> - 查库：`coupon_redemptions` 里 `couponId` 匹配的行数 === 1
> - 查库：`coupons.reservedCount === 1`
>
> **「查库」不是可选的**：两个订单都成功时，响应体看起来完全正常，
> 只有查 `coupon_redemptions` 的行数才发现券被用了两次。

### 4.2 改下单 DTO

`api/src/modules/order/dto/place-order.dto.ts` 加一个字段：

```typescript
  @ApiProperty({
    required: false,
    description: '使用的优惠券 id（只传 id，面额与门槛一律从库里读）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  couponId?: string;
```

> ⚠️ **只加 `couponId`，不加任何金额字段**（M1 / M2）。
> `discountAmount` / `couponValue` / `couponMinAmount` / `promotionDiscountAmount`
> 一律**不在 DTO 里声明**——`forbidNonWhitelisted` 会把它们 400。
> 这是 M1 的第一道闸；服务端「只从库里读」是第二道闸。

### 4.3 写核销服务（预占 / 释放）

`api/src/modules/coupon/coupon-redemption.service.ts`：

```typescript
/**
 * 券的核销服务（阶段 5a Task 4）。
 *
 * ## 与阶段 3 的「库存预占/释放」完全同构
 *
 * | 阶段 | 库存 | 券 |
 * |------|------|-----|
 * | 下单 | `RESERVE` 流水 + 扣 `stock` | 核销 `RESERVED` + `reservedCount` 加 1 |
 * | 支付成功 | `DEDUCT` 流水（库存不变） | 核销 `USED` + `reservedCount` 减 1、`usedCount` 加 1 |
 * | 取消/超时 | `RELEASE` 流水 + 加回 `stock` | 核销 `RELEASED` + `reservedCount` 减 1 |
 *
 * 同样的「条件更新 + 受影响行数判赢家 + 与订单状态同事务」三件套。
 */
@Injectable()
export class CouponRedemptionService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 预占核销（在下单事务内调用）。
   *
   * ⚠️ **必须与建单在同一个事务里**：券的额度被占住与订单被创建必须同生共死。
   * 分成两个事务的话，订单失败而券被占住，用户的券就白占了。
   *
   * ⚠️ **预占用条件更新**：`updateMany({ where: { id, reservedCount: { lt: limit } },
   * data: { reservedCount: { increment: 1 } } })`——
   * 受影响行数为 0 就是「这张券已被占满」，抛 409。
   *
   * ⚠️ **核销记录的插入靠部分唯一索引**（`coupon_redemptions_coupon_active_uniq`）：
   * 并发下单抢同一张券时，一个成功、一个撞唯一索引 → 转 409（M5）。
   * ⚠️ **P2002 必须在事务外处理**——但这里的冲突发生在**下单事务内**，
   * 所以处理方式与阶段 3 的「订单号撞号」相同：**整个事务回滚，外层重开一个
   * 事务重试**（`order.service.ts` 第 150–199 行的模式），
   * 或者在事务内 catch 后抛一个**业务异常**（不是原始的 P2002），
   * 让外层认出它并转 409。
   *
   * 这里选**后者**：在事务内 catch P2002 → 抛 `ConflictException('该券已被使用')`。
   * ConflictException 会让事务回滚，而它**不是** P2002，
   * 所以外层的 P2002 处理逻辑（重试）不会误判它。
   */
  async reserveInTx(
    tx: PrismaTransaction,
    input: {
      couponId: string;
      customerId: string;
      orderId: string;
      discountAmount: number;
    },
  ): Promise<void> {
    const tenantId = this.currentTenantId();

    // 1. **条件更新**扣预占数
    const affected = await tx.coupon.updateMany({
      where: { id: input.couponId },
      data: { reservedCount: { increment: 1 } },
    });
    if (affected.count === 0) {
      throw new NotFoundException('优惠券不存在');
    }

    // 2. 插核销记录（RESERVED）
    try {
      await tx.couponRedemption.create({
        data: {
          tenantId,
          couponId: input.couponId,
          customerId: input.customerId,
          orderId: input.orderId,
          status: CouponRedemptionStatus.RESERVED,
          discountAmount: input.discountAmount,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // ⚠️ 撞的是 `coupon_redemptions_coupon_active_uniq`：
        // 这张券已经被别的订单预占了（M5）。
        // ⚠️ **抛业务异常而不是原始 P2002**：ConflictException 会让事务回滚，
        // 且它不是 P2002，所以外层的 P2002 重试逻辑不会误判。
        throw new ConflictException('该券已被使用');
      }
      throw error;
    }
  }
```

> ⚠️ **`reservedCount` 的条件更新**与设计文档 §五的写法
> `updateMany({ where: { id, reservedCount: { lt: limit } }, ... })` **略有不同**：
> 设计文档说的是「`reservedCount` 达到某个上限」，但本阶段的券是
> **「一张券一个实例」**——`coupon_claims` 记的是「这个用户领了这张券多少张」，
> 而 `coupon_redemptions` 是**按券 id 唯一**的（部分唯一索引保证一张券只能被
> 一个订单预占）。
>
> 换句话说：**本阶段一张「券记录」对应一次领取**，不是可复用的券模板。
> 所以 `reservedCount` 不需要「上限」判定——真正的并发闸门是那条部分唯一索引。
> `reservedCount` 只是一个**计数快照**，用来核对「计数 = 核销记录数」（M14）。
>
> ⚠️ **这意味着「用户领 3 张券」在数据模型里是 `coupon_claims.quantity = 3`，
> 但核销只有一次机会**——因为 `coupon_redemptions` 的 `@@unique([couponId, orderId])`
> 与部分唯一索引都是按 `couponId` 而不是「券实例 id」。
>
> **这是一个已知的模型简化**，要在代码注释里写清楚：
> 「本阶段一张券记录 = 一次领取；`perUserLimit > 1` 的语义是
> 「可以领多张，但每次下单只能用其中一张」——而由于核销按 couponId 唯一，
> 多张同码的券在核销层面被视为同一张。」
>
> **实施时若发现这个简化会导致用例跑不通**（比如「领 2 张、用掉 1 张后另一张还能用」
> 测不了），**不要改数据模型**（那是设计文档 §3 的既定形状），
> 而是在 `coupon_claims.quantity` 上做区分：领取记录按「第几张」建多行。
> **具体做法见 §0.5 勘误表**——实施时把发现记进去。

**释放与核销（USED）**：

```typescript
  /**
   * 释放核销（订单取消 / 超时关闭时调用）。
   *
   * ⚠️ **必须与改订单状态在同一个事务里**（M8 / M9）：
   * 否则订单已取消而券还占着，用户的券就再也用不了。
   *
   * ⚠️ **用条件更新**：`updateMany({ where: { id, status: 'RESERVED' },
   * data: { status: 'RELEASED' } })`——
   * 受影响行数为 0 说明这条核销不是 RESERVED（已 USED 或已 RELEASED），
   * 什么都不做。**重复释放是安全的**。
   */
  async releaseInTx(tx: PrismaTransaction, orderId: string): Promise<void> {
    const redemptions = await tx.couponRedemption.findMany({
      where: { orderId, status: CouponRedemptionStatus.RESERVED },
    });
    for (const redemption of redemptions) {
      const affected = await tx.couponRedemption.updateMany({
        where: { id: redemption.id, status: CouponRedemptionStatus.RESERVED },
        data: { status: CouponRedemptionStatus.RELEASED },
      });
      if (affected.count === 0) {
        continue; // 已经被别人处理过了（重复释放）
      }
      await tx.coupon.updateMany({
        where: { id: redemption.couponId },
        data: { reservedCount: { decrement: 1 } },
      });
    }
  }

  /**
   * 确认核销（支付成功时调用）。
   *
   * ⚠️ `reservedCount` 减 1、`usedCount` 加 1——额度从「占住」变成「消耗掉」。
   *
   * ⚠️ **这是本阶段唯一把 `reservedCount` 减到 0 的路径之一**
   * （另一个是释放）。两个路径都要条件更新。
   */
  async markUsedInTx(tx: PrismaTransaction, orderId: string): Promise<void> {
    const redemptions = await tx.couponRedemption.findMany({
      where: { orderId, status: CouponRedemptionStatus.RESERVED },
    });
    for (const redemption of redemptions) {
      const affected = await tx.couponRedemption.updateMany({
        where: { id: redemption.id, status: CouponRedemptionStatus.RESERVED },
        data: { status: CouponRedemptionStatus.USED },
      });
      if (affected.count === 0) {
        continue;
      }
      await tx.coupon.updateMany({
        where: { id: redemption.couponId },
        data: {
          reservedCount: { decrement: 1 },
          usedCount: { increment: 1 },
        },
      });
    }
  }
```

### 4.4 接入下单流程

`api/src/modules/order/order.service.ts` 的 `createOrderInTx` 改成：

```typescript
    // ---- 4a. 锁 SKU ----（不变）
    await this.inventory.lockSkusInTx(tx, merged.map((item) => item.skuId));

    // ---- 4b. 读单价与快照（此时行锁在握，读到的是最新值）----
    const skuDetails = await this.readSkuDetails(tx, merged.map((i) => i.skuId));

    // ---- 4c. **算优惠**（新增，插在锁 SKU 之后）----
    //
    // ⚠️ **优惠计算必须在「锁 SKU 之后」**（设计文档 §五）：
    // 券的门槛与活动都要按**实时价**判定，而实时价只有在锁住 SKU 之后才稳定。
    //
    // ⚠️ 优惠计算与券的核销在**同一个事务**里（与建单一起）：
    // 券的额度被占住与订单被创建必须同生共死。
    const originalAmount = merged.reduce((sum, item) => {
      const detail = skuDetails.get(item.skuId);
      if (!detail) {
        throw new NotFoundException('SKU 不存在或不可售');
      }
      return sum + detail.price * item.quantity;
    }, 0);

    const discount = await this.couponService.computeForOrder({
      tenantId,
      customerId: owner,
      originalAmount,
      items: merged.map((item) => ({
        skuId: item.skuId,
        quantity: item.quantity,
        price: skuDetails.get(item.skuId)!.price,
      })),
      requestedCouponId: dto.couponId,
    });

    // ⚠️ **下单前再校验一次实付不为负**（M6）：
    // 引擎保证了它，但这里是最后一道闸——负金额订单会破坏账目。
    if (discount.payableAmount < 0) {
      throw new BadRequestException('优惠计算结果异常，请重试');
    }

    // ---- 4d. 建订单（含优惠快照字段）----
    const order = await this.createOrderAndItems(tx, {
      // ...既有字段...
      originalAmount,
      promotionDiscountAmount: discount.promotionDiscountAmount,
      promotionId: discount.appliedPromotion?.id ?? null,
      couponDiscountAmount: discount.couponDiscountAmount,
      couponId: discount.appliedCoupon?.id ?? null,
      couponCode: discount.appliedCoupon?.code ?? null,
      couponName: discount.appliedCoupon?.name ?? null,
    });

    // ---- 4e. 扣库存 + 记 RESERVE 流水（不变）----
    await this.inventory.reserveInTx(tx, order.id, /* ... */);

    // ---- 4f. **预占券的核销**（新增）----
    //
    // ⚠️ **在建单之后、事务提交之前**：
    // 建单失败 → 整个事务回滚 → 券没被占住；券占不住 → 整个事务回滚 → 订单没建成。
    // 这就是「同生共死」。
    if (discount.appliedCoupon) {
      await this.couponRedemption.reserveInTx(tx, {
        couponId: discount.appliedCoupon.id,
        customerId: owner,
        orderId: order.id,
        discountAmount: discount.couponDiscountAmount,
      });
    }

    return order;
```

> ⚠️ **`totalAmount` 的赋值**：`createOrderAndItems` 里现有的
> `totalAmount = merged.reduce(...)`（`order.service.ts` 第 344–353 行）
> **要改成 `discount.payableAmount`**。
> 这是 M1/M2/M6 的落点——**订单金额只由引擎算出来**。
> 而 `originalAmount` 存优惠前的原价。

### 4.5 候选券的查询

`CouponService.computeForOrder`：

```typescript
  /**
   * 组装 `DiscountContext` 并调纯函数。
   *
   * ⚠️ **候选券的查询在当前租户作用域内做**（M3）：
   * 租户扩展会自动附加 tenantId 条件，所以「别家店的券」根本查不到。
   *
   * ⚠️ **平台券走平台作用域查询，但只取 `scope = PLATFORM` 的**（M3）：
   * 平台券的 tenantId 指向平台租户，在租户作用域内查不到它。
   * 所以要显式走一次 `platformScope()`，**但 where 里必须带上
   * `scope: PLATFORM`**——不加的话就是「拿别的店的券来用」。
   */
  async computeForOrder(input: {
    tenantId: string;
    customerId: string;
    originalAmount: number;
    items: Array<{ skuId: string; quantity: number; price: number }>;
    requestedCouponId?: string;
  }): Promise<OrderDiscount> {
    const dbNow = await this.databaseNow();

    // 1. 候选券：用户持有的、ACTIVE、在有效期内的、没被用掉的
    //
    // ⚠️ **「没被用掉」的判定**：没有 `status IN (RESERVED, USED)` 的核销记录。
    // 这与部分唯一索引 `coupon_redemptions_coupon_active_uniq` 是同一件事
    // 的两个面：索引保证「不可能同时有两条」，这里的查询保证「只把没被占的
    // 拿出来当候选」。
    const claims = await this.prisma.couponClaim.findMany({
      where: { customerId: input.customerId },
      orderBy: { createdAt: 'asc' },
      include: {
        coupon: {
          // ⚠️ **关联读取必须显式写 where**（全局约定）：
          // 扩展的软删过滤只作用于顶层，嵌套关联不会被自动过滤。
          where: {
            deletedAt: null,
            status: CouponStatus.ACTIVE,
            startsAt: { lte: dbNow },
            endsAt: { gt: dbNow },
          },
        },
      },
    });

    const candidateCoupons: CouponCandidate[] = [];
    for (const claim of claims) {
      const coupon = claim.coupon;
      if (!coupon) continue;
      // ⚠️ **范围判定**（M3）：店铺券限本店，平台券全店可用
      if (coupon.scope === CouponScope.SHOP && coupon.tenantId !== input.tenantId) {
        continue;
      }
      // ⚠️ **已用掉的跳过**
      const used = await this.prisma.couponRedemption.findFirst({
        where: {
          couponId: coupon.id,
          status: { in: [CouponRedemptionStatus.RESERVED, CouponRedemptionStatus.USED] },
        },
        select: { id: true },
      });
      if (used) continue;
      candidateCoupons.push({
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        minAmount: coupon.minAmount,
      });
    }

    // 2. 平台券：跨租户取，但要**显式限定 scope = PLATFORM**
    const platformCoupons = await tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.coupon.findMany({
        where: {
          scope: CouponScope.PLATFORM,
          deletedAt: null,
          status: CouponStatus.ACTIVE,
          startsAt: { lte: dbNow },
          endsAt: { gt: dbNow },
          id: { in: claims.map((c) => c.couponId) },
        },
        include: {
          // 平台券的领取记录也在平台作用域里
        },
      });
      return rows;
    });
    // ...把平台券并进 candidateCoupons...

    // 3. 当前生效的满减活动（租户作用域内）
    const promotion = await this.prisma.promotion.findFirst({
      where: {
        deletedAt: null,
        status: PromotionStatus.ACTIVE,
        startsAt: { lte: dbNow },
        endsAt: { gt: dbNow },
      },
      orderBy: { discountAmount: 'desc' },
    });

    // 4. 调纯函数
    const result = computeDiscount({
      tenantId: input.tenantId,
      customerId: input.customerId,
      originalAmount: input.originalAmount,
      items: input.items,
      candidateCoupons,
      promotion: promotion
        ? {
            id: promotion.id,
            name: promotion.name,
            minAmount: promotion.minAmount,
            discountAmount: promotion.discountAmount,
            startsAt: promotion.startsAt,
            endsAt: promotion.endsAt,
          }
        : null,
      now: dbNow,
    });

    // 5. 客户端指定了券 → 只用那一张
    //
    // ⚠️ **M2：客户端只传 couponId，面额与门槛一律从库里读**。
    // 这里把候选列表**收窄成那一张**——不是「客户端传了多少钱就减多少」。
    if (input.requestedCouponId) {
      const picked = candidateCoupons.find((c) => c.id === input.requestedCouponId);
      if (!picked) {
        throw new BadRequestException('优惠券不可用');
      }
      const single = computeDiscount({
        ...context,
        candidateCoupons: [picked],
      });
      // ⚠️ 收窄后要**重算**，不能沿用上面的多券结果——
      // 客户端明确选了哪张，就用哪张（哪怕另一张更优）。
      return { ...single, appliedPromotion: promotion ? {...} : null };
    }

    return { ...result, appliedPromotion: promotion ? {...} : null };
  }
```

> ⚠️ **「客户端指定了券就只用那一张」是本计划的一个明确决策**：
> 设计文档 §4.2 说「取最优」，但那说的是「系统自动挑」。
> 用户在结算页**手动选了**一张券，就该用那张——否则用户选了 30 元券、
> 系统偷偷用了 50 元券，界面上显示的和实际扣的不一样（M17）。
>
> **「自动选最优」与「手动指定」是两条路径**：
> - 手动指定 → 只算那一张（不可用就报错）
> - 没指定 → 在候选里取最优
>
> 结算页默认**带上用户选的券**提交，所以实际路径是「手动指定」。
> 「自动选最优」是「用户没选」时的兜底。

### 4.6 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/order-discount.e2e-spec.ts
```

### 4.7 提交

```bash
git add api/
git commit -m "feat(api): 下单接入优惠 + 券的预占核销

优惠计算插在「锁 SKU 之后」：券的门槛与活动都要按实时价判定，
而实时价只有在锁住 SKU 之后才稳定（设计文档 §五）。

券的核销与建单在同一个事务里：券的额度被占住与订单被创建必须同生共死。
分成两个事务的话，订单失败而券被占住，用户的券就白占了。

并发抢同一张券靠那条部分唯一索引（coupon_redemptions_coupon_active_uniq）：
一个成功、一个撞唯一索引 → 转 409「该券已被使用」。
⚠️ 撞索引时抛的是 ConflictException 而不是原始 P2002——ConflictException
会让事务回滚，且它不是 P2002，所以外层的 P2002 重试逻辑不会误判它。

订单金额只由引擎算出来：totalAmount 改成优惠后的实付，originalAmount 存
优惠前的原价。请求体里只加 couponId 一个字段——面额、门槛、优惠额一律
从库里读，客户端传的优惠额字段被 forbidNonWhitelisted 直接 400（M1 / M2）。

用户手动选了券就只用那一张，不在候选里另挑更优的：结算页显示的和实际
扣的必须一致，否则用户在结算页选了 30 元券、被扣掉 50 元券的差价，
界面解释不清（M17）。「自动取最优」只在用户没选时兜底。"
```

---

## Task 5：取消 / 支付超时时释放券的核销

**Files:**
- Modify: `api/src/modules/order/order.service.ts`（`cancelOrder` 与 `releaseReservationInTx`）
- Modify: `api/src/modules/order/order-timeout.service.ts`
- Modify: `api/src/modules/payment/payment.service.ts`（支付成功 → `markUsedInTx`）
- Test: `api/test/coupon-release.e2e-spec.ts`

### 5.1 先写失败测试

`api/test/coupon-release.e2e-spec.ts`。护栏对应：**M8 取消时释放**、
**M9 超时时释放**、**M9 两个路径共用同一函数**、**M13 退款金额与实付相符**、
**M14 计数同步**。

```typescript
  it('M8：取消订单：核销转 RELEASED，reservedCount 减 1，券能再次使用', async () => {
    // 下单用券 → 查库：核销 status = RESERVED、reservedCount = 1
    // 取消订单 → 查库：核销 status = RELEASED、reservedCount = 0
    // **再用同一张券下单 → 成功**（这是 M8 的核心断言）
  });

  it('M9：支付超时关闭：核销同样被释放', async () => {
    // 构造已过 payExpiresAt 的订单 → 跑超时释放
    // 查库：核销 status = RELEASED、reservedCount = 0
  });

  it('M9：取消与超时释放共用同一个释放函数', async () => {
    // ⚠️ 这条是**结构性**断言，用代码检查而不是运行时行为：
    // 读 order.service.ts 的源码，断言「cancelOrder」与
    // 「order-timeout.service.ts」里都出现了同一个方法名。
    //
    // 或者更实际的写法：分别走取消路径与超时路径，
    // 断言两条路径的**库内结果完全一致**（核销状态、reservedCount）。
    // 形态上不同、内容相同 —— 两处各写一套时，改了一处另一处就会漂。
  });

  it('M14：计数与核销记录数一致', async () => {
    // 下单用券 → 取消 → 查库：
    // coupons.reservedCount === 0
    // coupons.usedCount === 0
    // coupon_redemptions 里 status = 'USED' 的行数 === 0
  });

  it('支付成功后：核销转 USED，usedCount 加 1，reservedCount 减 1', async () => {
    // 下单用券 → 假网关支付 → 查库：
    // 核销 status = 'USED'、reservedCount = 0、usedCount = 1
  });

  it('M13：退款额 = 实付额（已含优惠），不重算优惠', async () => {
    // 下单用券（实付 9000）→ 支付 → 退款
    // 查库：payment.amount === 9000（不是 10000）
    // 订单的 totalAmount 仍是 9000
  });

  it('M12：退款后订单的优惠快照不变', async () => {
    // 退款后查订单：couponDiscountAmount 仍是下单时的值
  });

  it('重复释放是安全的：取消两次不会把 reservedCount 减成 -1', async () => {
    // 取消 → 查库 reservedCount === 0
    // 再取消一次（订单已是 CANCELLED，条件更新拦住）→ reservedCount 仍是 0
  });
```

> **M9 的「两个路径共用同一函数」怎么测才不恒真**：
> 只断言「两条路径的结果一样」确实不够——两处各写一套但当前行为一致时，
> 测试会通过，将来改了一处就会漂，而测试抓不住。
>
> **更实际的形态**：本 Task **在实现上**就只提供**一个**释放函数
> （`OrderService.releaseReservationInTx` 内部同时释放库存与券），
> 取消路径与超时路径都调它。测试断言两条路径的库内结果一致，
> **代码审查时确认只有一处实现**。计划里写死这个约定，实现者照做。

### 5.2 改释放函数（一个函数，两处调用）

`api/src/modules/order/order.service.ts`：

```typescript
  /**
   * 释放订单的预占（库存还回去 + 记 RELEASE 流水 + **释放券的核销**）。
   *
   * ⚠️ **取消订单与支付超时释放共用这个函数**（M9，设计文档 §5.1）：
   * 两处各写一套「释放」逻辑必然漂移——比如改了取消却忘了改超时释放，
   * 就会出现「取消的订单库存没还回去、券还占着」。
   *
   * ⚠️ **库存与券的释放必须在同一个事务里**：订单已取消而券还占着，
   * 用户的券就再也用不了（M8）。
   *
   * ⚠️ **刻意不提供「自己开事务」的版本**：调用方必须在自己的事务里
   * 组合「条件更新状态 + 释放预占」。理由见下面 releaseReservationInTx 的注释。
   */
  async releaseReservationInTx(
    tx: PrismaTransaction,
    orderId: string,
  ): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { skuId: true, quantity: true },
    });

    // 释放库存（不变）
    if (items.length > 0) {
      await this.inventory.releaseInTx(tx, orderId, items);
    }

    // ⚠️ **释放券的核销**（新增）
    await this.couponRedemption.releaseInTx(tx, orderId);
  }
```

`cancelOrder`（`order.service.ts` 第 645–668 行）**不用改**——它已经调
`this.releaseReservationInTx(tx, order.id)`，而那个函数现在同时释放库存与券。

`order-timeout.service.ts`（第 118 行）**也不用改**——它调的是
`this.order.releaseReservationInTx(tx, orderId)`，同一个函数。

> ⚠️ **这就是 M9 的兑现点**：两条路径**调用的是同一个函数**，
> 而那个函数内部同时释放库存与券。不需要「记得两边都改」。

### 5.3 支付成功 → 核销转 USED

`api/src/modules/payment/payment.service.ts` 的 `applyEventInTx`
（第 449–460 行记 DEDUCT 流水那一段）后面加：

```typescript
    // ---- 赢了才记 DEDUCT 流水（quantity=-qty，**库存不变**）----
    await this.inventory.deductInTx(tx, order.id, /* ... */);

    // ---- **确认券的核销**（新增）----
    //
    // ⚠️ **必须在同一个事务里**：订单转 PAID 与券的核销确认同生共死。
    // 分成两个事务的话，订单已支付而券还停在 RESERVED——
    // 券的额度被占着，用户看到「我的券」里它还在却用不了。
    //
    // ⚠️ **与取消路径互斥**：支付成功后订单不再是 PENDING_PAYMENT，
    // 取消路径的条件更新会拦住它。两条路径都靠「核销状态的条件更新」
    // 保证只生效一次。
    await this.couponRedemption.markUsedInTx(tx, order.id);
```

> ⚠️ **`payment` 模块要注入 `CouponRedemptionService`**——
> 这让 `payment → coupon` 成为一个新的依赖方向。
> **检查会不会形成循环**：
> - `coupon` 模块**不依赖** `payment` 模块 ✓
> - `coupon` 模块**不依赖** `order` 模块（它只依赖 Prisma 与引擎）✓
> - 所以 `payment → coupon`、`order → coupon`、`payment → order` 三条边
>   都不构成环 ✓
>
> **但 `order → coupon` 与 `coupon → order` 的方向要定死**：
> `coupon` 模块**不 import** `order` 模块。
> 核销服务只按 `orderId` 字符串操作，不需要 order 模块的任何能力。

> ⚠️ **退款路径（M13）不用改**：`PaymentService.refund` 第 586–603 行
> 转订单为 `REFUNDED` 时**不重算优惠**——它读的 `order.totalAmount`
> 就是下单时算出的实付额。**这就是 M13 的兑现点**：退款额天然等于实付额。
> **但要在代码注释里补一句**，说明「这里不重算优惠是有意的」，
> 免得后来的人以为是漏了。

### 5.4 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/coupon-release.e2e-spec.ts
```

### 5.5 提交

```bash
git add api/
git commit -m "feat(api): 取消与支付超时时释放券的核销

取消路径与超时路径**调用的是同一个释放函数**（releaseReservationInTx），
那个函数内部同时释放库存与券的核销。两处各写一套必然漂移——改了取消
忘了改超时，就会出现「取消的订单库存没还回去、券还占着」（M9）。
库存与券的释放都在订单状态流转的**同一个事务**里：订单已取消而券还占着，
用户的券就再也用不了（M8）。

支付成功时核销转 USED：reservedCount 减 1、usedCount 加 1。
它与取消路径互斥——两条路径都靠「核销状态的条件更新」保证只生效一次，
重复释放是安全的（reservedCount 不会减成 -1）。

退款额天然等于实付额：退款读的是订单的 totalAmount（下单时算出的实付），
**不重算优惠**（M13）。这不是漏了，是有意的——券的规则将来可能改，
改了就对不上历史账（M12）。"
```

---

## Task 6：前端——消费者领券与用券

**Files:**
- Modify: `storefront/src/lib/cart.ts`（加优惠相关类型与纯函数）
- Create: `storefront/src/lib/coupon.ts`（类型 + 纯函数）
- Modify: `storefront/src/app/(shop)/checkout/page.tsx`
- Modify: `storefront/src/components/checkout/checkout-form.tsx`
- Create: `storefront/src/app/(shop)/coupons/page.tsx`
- Create: `storefront/src/components/coupon/coupon-list.tsx`
- Create: `storefront/src/app/api/coupons/route.ts`（中转）
- Create: `storefront/src/app/api/coupons/claim/route.ts`（中转）
- Modify: `storefront/src/components/order/order-detail.tsx`（显示优惠快照）
- Test: `storefront/test/lib/coupon.test.ts`
- Test: `storefront/test/app/api/coupon-whitelist.test.ts`

### 6.1 约束（阶段 2b / 3 / 4 踩过的坑）

1. **中转路由必须白名单重建请求体**——领券的请求体只接受 `couponId` 或 `code`，
   **绝不接受任何金额字段**。客户端传 `discountAmount` 会被后端 400，
   而更根本的问题是金额只能由后端算（M1 / M2）。
2. **Server Component 不能往客户端组件传函数**——逻辑内嵌在 `'use client'` 组件里。
3. **公开路径要带 `x-tenant-subdomain`**——`apiFetch` 的 `subdomain` 选项直接用。
4. **组件测试逐文件切 jsdom**：`// @vitest-environment jsdom` 写在文件第一行。
   **全局环境保持 `node`，不要改全局配置**。
5. **`storefront/test/setup.ts` 里已有显式 `afterEach(() => cleanup())`——不要重复加。**
6. **金额展示的换算只在展示层做**——用 `formatPrice`（`storefront/src/lib/format.ts`），
   不要在计算层除以 100。

### 6.2 先写失败测试

`storefront/test/lib/coupon.test.ts`（纯函数，node 环境）：

```typescript
import { describe, expect, it } from 'vitest';
import {
  discountBreakdown,
  type DiscountPreview,
} from '@/lib/coupon';

/**
 * 结算页金额拆分的纯函数测试。
 *
 * ⚠️ **断言要具体**：断言每个字段的**确切数值**，不是「显示了什么」。
 */

describe('优惠金额拆分', () => {
  it('四行：原价 / 活动减 / 券减 / 实付', () => {
    const breakdown = discountBreakdown({
      originalAmount: 10000,
      promotionDiscountAmount: 2000,
      couponDiscountAmount: 1000,
    });

    expect(breakdown.originalAmount).toBe(10000);
    expect(breakdown.promotionDiscountAmount).toBe(2000);
    expect(breakdown.couponDiscountAmount).toBe(1000);
    expect(breakdown.payableAmount).toBe(7000);
    expect(breakdown.totalDiscount).toBe(3000);
  });

  it('没有优惠时：实付 = 原价，优惠额为 0', () => {
    const breakdown = discountBreakdown({
      originalAmount: 10000,
      promotionDiscountAmount: 0,
      couponDiscountAmount: 0,
    });

    expect(breakdown.payableAmount).toBe(10000);
    expect(breakdown.totalDiscount).toBe(0);
  });

  it('实付恒不小于 0：优惠额超过原价时被截断', () => {
    const breakdown = discountBreakdown({
      originalAmount: 300,
      promotionDiscountAmount: 0,
      couponDiscountAmount: 1000,
    });

    expect(breakdown.payableAmount).toBe(0);
    expect(breakdown.payableAmount).toBeGreaterThanOrEqual(0);
  });

  it('全程整数：每个字段都是整数', () => {
    const breakdown = discountBreakdown({
      originalAmount: 3000,
      promotionDiscountAmount: 0,
      couponDiscountAmount: 1000,
    });

    expect(Number.isInteger(breakdown.payableAmount)).toBe(true);
    expect(breakdown.payableAmount).toBe(2000);
  });
});
```

`storefront/test/app/api/coupon-whitelist.test.ts`（中转路由白名单，照
`storefront/test/app/api/order-whitelist.test.ts` 的写法）：

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return { ...actual, apiFetch: vi.fn() };
});

import { auth } from '@/auth';
import { cookies, headers } from 'next/headers';
import { apiFetch } from '@/lib/api-client';

import { POST as claimCoupon } from '@/app/api/coupons/claim/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);
const cookiesMock = vi.mocked(cookies);
const headersMock = vi.mocked(headers);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ couponId: 'c-1' } as never);
  headersMock.mockResolvedValue(
    new Headers({ 'x-tenant-subdomain': 'demo' }) as never,
  );
  cookiesMock.mockResolvedValue({ get: () => undefined } as never);
});

describe('护栏：领券请求体白名单重建', () => {
  it('只把 couponId 发给后端', async () => {
    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { couponId: 'c-1' }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/coupons/claim', {
      method: 'POST',
      body: { couponId: 'c-1' },
      subdomain: 'demo',
      token: TEST_SESSION.accessToken,
    });
  });

  it('金额字段不进后端请求体', async () => {
    await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', {
        couponId: 'c-1',
        discountAmount: 99999,
        value: 99999,
        minAmount: 0,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('discountAmount');
    expect(body).not.toHaveProperty('value');
    expect(body).not.toHaveProperty('minAmount');
    expect(Object.keys(body)).toEqual(['couponId']);
  });

  it('tenantId / customerId / scope 不进后端请求体', async () => {
    await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', {
        couponId: 'c-1',
        tenantId: 'other-tenant',
        customerId: 'someone-else',
        scope: 'PLATFORM',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['couponId']);
  });

  it('畸形请求体 → 400，且不调后端', async () => {
    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', ['c-1']),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401，且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await claimCoupon(
      postRequest('http://localhost/api/coupons/claim', { couponId: 'c-1' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
```

> **中转路由的白名单测试照 `storefront/test/app/api/order-whitelist.test.ts` 的写法**
> （阶段 2b 建的 harness 直接复用）。断言要断言 apiFetch 收到的**完整 body**，
> 而不是「某个字段不在」——「全都丢掉」的实现也能通过后者。

### 6.3 写纯函数与类型

`storefront/src/lib/coupon.ts`：

```typescript
/**
 * 优惠券的前端类型与纯函数。
 *
 * ⚠️ **金额一律整数分**（全局约定）。前端只做展示换算，
 * 真实金额永远由后端算——下单请求体里连价格字段都不许带。
 */

/** 券的类型（与后端 CouponType 一一对应） */
export type CouponType = 'FIXED' | 'PERCENT';

/** 可领取的券 */
export interface AvailableCoupon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: CouponType;
  /** 面额（整数分） */
  value: number;
  /** 使用门槛（整数分），0 = 无门槛 */
  minAmount: number;
  /** 剩余可领张数；null = 不限量 */
  remaining: number | null;
  startsAt: string;
  endsAt: string;
}

/** 我持有的券 */
export interface MyCoupon extends AvailableCoupon {
  /** 已领取张数 */
  quantity: number;
  /** 已用掉的张数 */
  usedQuantity: number;
  /** 状态：可��� / 已用完 / 已过期 */
  state: 'AVAILABLE' | 'USED_UP' | 'EXPIRED';
}

/** 优惠金额的拆分（结算页与订单详情共用） */
export interface DiscountBreakdown {
  /** 原价小计（优惠前） */
  originalAmount: number;
  /** 满减活动减免 */
  promotionDiscountAmount: number;
  /** 券减免 */
  couponDiscountAmount: number;
  /** 优惠合计 */
  totalDiscount: number;
  /** 实付（整数分） */
  payableAmount: number;
}

/**
 * 把「原价 + 活动减 + 券减」拆成四行展示用的数据。
 *
 * ⚠️ **实付最多减到 0**：优惠额超过原价时截断到 0，
 * 绝不让实付变成负数（后端也保证这一点，但前端也要兜住——
 * 展示一个负数金额比不展示更糟）。
 *
 * ⚠️ **全程整数域**：不除以 100，换算成「元」只在 `formatPrice` 里做。
 */
export function discountBreakdown(input: {
  originalAmount: number;
  promotionDiscountAmount: number;
  couponDiscountAmount: number;
}): DiscountBreakdown {
  const totalDiscount = Math.min(
    input.originalAmount,
    input.promotionDiscountAmount + input.couponDiscountAmount,
  );
  return {
    originalAmount: input.originalAmount,
    promotionDiscountAmount: input.promotionDiscountAmount,
    couponDiscountAmount: input.couponDiscountAmount,
    totalDiscount,
    payableAmount: input.originalAmount - totalDiscount,
  };
}

/**
 * 券的门槛是否满足（用于结算页的**展示**）。
 *
 * ⚠️ **这是估算值，不是最终判定**：真实判定在后端的引擎里。
 * 这里的判断只是让界面不要展示一张「肯定用不了」的券。
 */
export function couponThresholdMet(
  coupon: { minAmount: number },
  originalAmount: number,
): boolean {
  return originalAmount >= coupon.minAmount;
}

/**
 * 券能不能用在当前购物车上（展示层判断）。
 *
 * ⚠️ **保守**：宁可少显示一张能用的券，也不要显示一张用不了的——
 * 前端少显示是体验问题，多显示是「点了必然报错」。
 */
export function couponUsable(
  coupon: AvailableCoupon,
  originalAmount: number,
): boolean {
  return (
    coupon.type === 'FIXED' &&
    couponThresholdMet(coupon, originalAmount) &&
    new Date(coupon.endsAt).getTime() > Date.now()
  );
}
```

> ⚠️ **`couponUsable` 用 `Date.now()` 是「展示层的当前时间」**——
> 它与服务端用数据库时钟的判定（M15）**可能不一致**（边界时刻）。
> 这是刻意的：前端只是**少显示**一张券，真正能不能用由后端说了算。
> 代码注释里写清楚这一点，别让后来的人以为它与 M15 矛盾。

### 6.4 改结算页

`storefront/src/components/checkout/checkout-form.tsx`：

- **新增「优惠券」区块**：一个下拉，列出可用的券（`couponUsable` 过滤后的），
  默认选「不使用优惠券」
- **金额区改成四行**：原价 / 活动减 / 券减 / 实付
- **提交时带上 `couponId`**（选了才带）
- **下单成功后以响应里的订单金额为准**（M17）

```tsx
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">优惠券</h2>
        {usableCoupons.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无可用的优惠券。
          </p>
        ) : (
          <select
            value={couponId}
            onChange={(event) => setCouponId(event.target.value)}
            className="rounded-md border p-2 text-sm"
          >
            <option value="">不使用优惠券</option>
            {usableCoupons.map((coupon) => (
              <option key={coupon.id} value={coupon.id}>
                {coupon.name}（减 {formatPrice(coupon.value)}
                {coupon.minAmount > 0
                  ? `，满 ${formatPrice(coupon.minAmount)} 可用`
                  : ''}
                ）
              </option>
            ))}
          </select>
        )}
      </section>
```

提交时：

```tsx
        body: JSON.stringify({
          addressId,
          items: toOrderItems(cart.items ?? []),
          idempotencyKey,
          ...(couponId ? { couponId } : {}),
          ...(remark.trim() ? { remark: remark.trim() } : {}),
        }),
```

> ⚠️ **结算页显示的优惠是「估算值」**（M17）：
> 结算页按购物车的当前金额算一个预览，但**真实金额由后端在下单时算**
> （下单时 SKU 价格可能已经变了）。所以页面要有一行提示：
> 「金额以提交时为准」。下单响应里返回的是服务端算出的真实金额，
> 订单详情页以响应为准。
>
> ⚠️ **幂等键的既有约定不许破坏**：
> `checkout-form.tsx` 第 33–69 行的 `useIdempotencyKey`（sessionStorage 持有）
> 是阶段 3 定下的约定——**进入结算页时生成并持有**，失败重试复用同一个。
> 加优惠券时**不要**动它。
> ⚠️ 优惠券的选择**不进幂等键**：用户改了券的选择后重新提交，
> 用的是**同一个**幂等键 → 后端会返回**第一次的订单**（幂等键命中）。
> 这是幂等的正确语义（同一个键 = 同一次下单尝试）。
> **但要让用户知道**：改完券后要提示「请刷新页面重新下单」——
> 或者更简单：**下单成功后清掉幂等键**（现有代码第 138 行已经这么做了），
> 用户改了券再提交会命中旧订单。**实施时把这个交互定清楚**，
> 记进 §0.5 勘误表。

### 6.5 写领券中心

`storefront/src/app/(shop)/coupons/page.tsx`（Server Component）+ 
`storefront/src/components/coupon/coupon-list.tsx`（客户端组件）：

- 领券中心：列出当前可领的券，每张券一个「立即领取」按钮
- 「我的券」页签：列出持有的券（可用 / 已用完 / 已过期）

```tsx
'use client';

/**
 * 领券列表。
 *
 * ⚠️ **逻辑内嵌在组件内部，没有从 Server Component 往下传回调**——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（阶段 2b 踩过）。
 */
export function CouponList({
  available,
  mine,
}: {
  available: AvailableCoupon[];
  mine: MyCoupon[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim(couponId: string) {
    setBusyId(couponId);
    setError(null);
    try {
      const response = await fetch('/api/coupons/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ couponId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '领取失败');
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '领取失败');
    } finally {
      setBusyId(null);
    }
  }
  // ...渲染
}
```

### 6.6 写中转路由

`storefront/src/app/api/coupons/route.ts`（GET 可领的券 + 我的券）与
`storefront/src/app/api/coupons/claim/route.ts`（POST 领券）：

```typescript
import { NextResponse } from 'next/server';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';

/**
 * 领券的中转。
 *
 * 请求体按白名单重建：只接受 `couponId` 或 `code`。
 *
 * ⚠️ **绝不接受金额字段**（护栏 M1 / M2）：面额、门槛、优惠额一律由后端
 * 从库里读。客户端多传一个 `discountAmount` 会被后端 400，
 * 而更根本的问题是「客户端算的优惠额一律不信」。
 */
export async function POST(request: Request) {
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  // ⚠️ 白名单重建：只保留这两个键，**其余全部丢弃**
  const body: Record<string, unknown> = {};
  if (typeof payload.couponId === 'string' && payload.couponId !== '') {
    body.couponId = payload.couponId;
  } else if (typeof payload.code === 'string' && payload.code !== '') {
    body.code = payload.code;
  } else {
    return NextResponse.json(
      { message: 'couponId 或 code 必须提供一个' },
      { status: 400 },
    );
  }

  try {
    const result = await fetchBackend('/coupons/claim', {
      method: 'POST',
      body,
      subdomain,
      token,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

> ⚠️ **`couponId` 与 `code` 是「二选一」，不是都传**：
> 都传时以 `couponId` 为准——`couponId` 是主键，精确匹配；
> `code` 是给人看的、可能被改的（商家可以改码？本阶段不改，但字段是开放的）。
> **都传时不能两个都发给后端**，否则后端的查找逻辑会有歧义。

### 6.7 改订单详情

`storefront/src/components/order/order-detail.tsx` 的「支付信息」区加优惠四行：

```tsx
        {initial.originalAmount > initial.totalAmount && (
          <>
            <dt className="text-muted-foreground">商品原价</dt>
            <dd>{formatPrice(initial.originalAmount)}</dd>
            {initial.promotionDiscountAmount > 0 && (
              <>
                <dt className="text-muted-foreground">活动减免</dt>
                <dd>-{formatPrice(initial.promotionDiscountAmount)}</dd>
              </>
            )}
            {initial.couponDiscountAmount > 0 && (
              <>
                <dt className="text-muted-foreground">优惠券</dt>
                <dd>
                  -{formatPrice(initial.couponDiscountAmount)}
                  {initial.couponName ? `（${initial.couponName}）` : ''}
                </dd>
              </>
            )}
          </>
        )}
        <dt className="text-muted-foreground">实付金额</dt>
        <dd>{formatPrice(initial.totalAmount)}</dd>
```

> ⚠️ **用 `formatPrice` 而不是内联的 `(x / 100).toFixed(2)`**：
> 现有代码第 162 行、第 199 行用的是内联写法，但那是既有代码。
> **新增的部分用 `formatPrice`**——它处理了 null / undefined
> （返回 `—`），而内联写法遇到 null 会显示 `NaN`。
> **不要顺手改既有行**（外科手术式改动）。

同时在 `storefront/src/lib/cart.ts` 的 `Order` 接口加优惠字段：

```typescript
  /** 原价小计（优惠前，整数分） */
  originalAmount: number;
  /** 满减活动减免（整数分） */
  promotionDiscountAmount: number;
  /** 券减免（整数分） */
  couponDiscountAmount: number;
  /** 券 id（快照） */
  couponId: string | null;
  /** 券码（快照） */
  couponCode: string | null;
  /** 券名（快照） */
  couponName: string | null;
```

### 6.8 跑检查

```bash
cd storefront && npm test && npm run lint && npm run build
```

预期：全部通过。

> ⚠️ **`npm test` 的文件数**：阶段 4 的验收记录说 storefront 原为 75 passed / 6 个文件，
> 阶段 4 加了组件测试。本 Task 新增 2 个测试文件
> （`test/lib/coupon.test.ts` + `test/app/api/coupon-whitelist.test.ts`）。
> **记下实际数字**，验收时按增量核对。

### 6.9 提交

```bash
git add storefront/
git commit -m "feat(storefront): 消费者领券与结算用券

结算页加「优惠券」下拉与四行金额（原价 / 活动减 / 券减 / 实付），
让用户看得懂优惠从哪来。领券中心页列出可领的券与「我的券」。

中转路由按白名单重建请求体：领券只接受 couponId 或 code，
金额字段一律丢弃——客户端算的优惠额一律不信，面额与门槛由后端从库里读。

结算页显示的优惠是**估算值**：真实金额由后端在下单时算（下单时 SKU 价格
可能已经变了），所以页面有一行「金额以提交时为准」，订单详情以服务端返回的
金额为准。

幂等键的既有约定不动（进入结算页时生成并持有，失败重试复用同一个）——
但要注意优惠券的选择不进幂等键：改了券再提交会命中第一次的订单，
这是幂等的正确语义。"
```

---

## Task 7：商家后台营销页

**Files:**
- Create: `merchant-admin/src/app/(dashboard)/marketing/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/marketing/coupon-form.tsx`
- Create: `merchant-admin/src/app/(dashboard)/marketing/promotion-form.tsx`
- Create: `merchant-admin/src/app/api/coupons/route.ts`（中转）
- Create: `merchant-admin/src/app/api/coupons/[id]/route.ts`（中转）
- Create: `merchant-admin/src/app/api/promotions/route.ts`（中转）
- Create: `merchant-admin/src/app/api/promotions/[id]/route.ts`（中转）
- Modify: `merchant-admin/src/app/(dashboard)/layout.tsx`（导航加「营销」）
- Test: `merchant-admin/test/app/api/coupon-whitelist.test.ts`

### 7.1 先写失败测试

`merchant-admin/test/app/api/coupon-whitelist.test.ts`
（照 `merchant-admin/test/app/api/order-whitelist.test.ts` 的写法）：

```typescript
describe('护栏：创建券的请求体白名单重建', () => {
  it('只把 code / name / value / minAmount / startsAt / endsAt 发给后端', async () => {
    // 断言 apiFetch 收到的**完整 body**
  });

  it('scope / tenantId / claimedCount / reservedCount / usedCount 不进后端请求体', async () => {
    // ⚠️ **M7 的前端侧**：scope 不由客户端传。
    // 断言这些键全部不在 body 里，且 body 的键集合是精确的那几个。
  });

  it('金额字段必须是非负整数', async () => {
    // value 为负 / 为小数 → 400，且不调后端
  });

  it('畸形请求体 → 400，且不调后端', async () => { /* ... */ });

  it('未登录 → 401，且不调后端', async () => { /* ... */ });
});
```

### 7.2 写营销页

`merchant-admin/src/app/(dashboard)/marketing/page.tsx`：

- **两个页签**：「优惠券」与「满减活动」
- **优惠券页签**：券列表（名称、码、面额、门槛、状态、已领 / 已核销数）+ 新建 + 编辑 + 暂停/启用 + 删除
- **满减活动页签**：活动列表（名称、门槛、减免、有效期、状态）+ 新建 + 编辑 + 暂停/启用 + 删除

> ⚠️ **金额的输入单位**：后端用整数分，界面上用「元」。
> 转换**只在表单的边界做**——用户输入 `9.9` 元 → 提交 `990` 分。
> ⚠️ **「元 → 分」的转换要避免浮点误差**：`Math.round(parseFloat(input) * 100)`
> ——`parseFloat('9.9') * 100` 的真值是 `990.0000000000001`，
> `Math.round` 把它收敛成 `990`。**不要写 `parseFloat(input) * 100` 不取整**。
> 这一条要单测（`merchant-admin/test/lib/money.test.ts`）。

`merchant-admin/src/app/(dashboard)/layout.tsx` 的导航加一项：

```tsx
            <Link href="/marketing" className="underline-offset-4 hover:underline">
              营销
            </Link>
```

### 7.3 写中转路由

四个中转路由（列表 / 创建 / 改 / 删），全部按白名单重建请求体。
照 `merchant-admin/src/app/api/orders/[orderNo]/refund/route.ts` 的写法。

> ⚠️ **merchant-admin 的中转路由不带 `x-tenant-subdomain`**——
> 中心域名没有「当前店铺」，租户身份由 accessToken 里的 `tenantId` 决定
> （`merchant-admin/src/lib/api-client.ts` 第 33–34 行的注释）。

### 7.4 跑检查

```bash
cd merchant-admin && npm test && npm run lint && npm run build
```

### 7.5 提交

```bash
git add merchant-admin/
git commit -m "feat(merchant-admin): 营销页（券与满减活动的创建/编辑/暂停）

商家后台加「营销」页签：优惠券与满减活动两个列表，各自支持新建、编辑、
暂停/启用、删除。删除走软删——券要保留历史核销记录的可追溯性。

创建券的请求体按白名单重建：scope 不由客户端传（M7——平台券只能由
平台超管创建，客户端传了也会被后端 DTO 拒掉），claimedCount /
reservedCount / usedCount 这些服务端计数一个都不放行。

「元 → 分」的转换要取整：Math.round(parseFloat(input) * 100)——
parseFloat('9.9') * 100 的真值是 990.0000000000001，不取整会差一分钱。"
```

---

## Task 8：阶段 5a 验收

**Files:**
- Create: `docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md`
- Modify: `README.md`

### 8.1 浏览器手测

**环境注意（阶段 2b / 3 / 4 都栽过）**：

- 3001–3003 端口是**旧构建的容器**，不含阶段 5a 的功能。
  本地 dev 用 **3011**（storefront）/ **3016**（merchant-admin），启动前先 `rm -rf .next`。
- **不要在旧容器上测**——阶段 2b 有两次「实测报缺陷、复现不出来」，
  根因都是测了旧镜像。

**测试账号**：商家 `owner@demo.platform.test` / `Demo12345!`；
消费者 `customer@demo.platform.test` / `Demo12345!`（阶段 3 加进 seed 的）。

**逐条走**：

| # | 场景 | 预期 |
|---|------|------|
| 1 | 商家后台新建一张满 100 减 10 的券 | 券出现在列表里 |
| 2 | 商家后台新建一个满 200 减 30 的活动 | 活动出现在列表里 |
| 3 | 前台领券中心 | 能看到可领的券 |
| 4 | 点「立即领取」 | 提示成功，「我的券」里多了一张 |
| 5 | 结算页（购物车金额 ≥ 券门槛） | 四行金额显示正确，券在下拉里可选 |
| 6 | 选券后提交订单 | 订单详情的实付 = 原价 − 券减免；商家后台订单详情也显示优惠 |
| 7 | **把券的码改成一样再创建一张** | 能创建成功（软删/部分唯一索引的语义正确） |
| 8 | 取消未支付订单 | **券能再次使用**（这是 M8 的手测形态） |
| 9 | 领一张限 1 张的券，领第二次 | 被拒，提示可读 |
| 10 | 结算页把金额改到低于券门槛 | 券在下拉里不可选（或提交后提示不可用） |
| 11 | 支付成功后看「我的券」 | 券变成「已用完」 |
| 12 | 活动生效期间下单 | 订单里有活动减免，活动与券叠加 |

### 8.2 失败注入（恒真自检）

**17 项护栏逐项做**（设计文档 §七 的 M1–M17）。做法照阶段 2b：

1. 改坏一处护栏
2. 跑对应测试，**确认它真的失败**
3. 改回来
4. 复跑确认通过

**判断变异是否生效前，先确认代码真的被改坏了**——把字段名改成不存在的名字
是可靠探针。**编译错误不算「抓到」。**

逐项的注入形态：

| 护栏 | 注入形态 | 预期挂掉的测试 |
|------|---------|--------------|
| M1 | 下单 DTO 里加 `discountAmount` 字段并用它算金额 | Task 4 的「M1」用例 |
| M2 | 下单 DTO 里加 `couponValue` 字段并优先用它 | Task 4 的「M2」用例 |
| M3 | 候选券查询去掉 `scope = PLATFORM` 限制 | Task 4 的「M3 跨租户」用例 |
| M4 | 领券的 `updateMany` 改成「先查后改」 | Task 3 的「并发领限量券」用例 |
| M5 | 删掉迁移里的 `coupon_redemptions_coupon_active_uniq` | Task 4 的「M5 并发用券」用例 |
| M6 | 引擎里的 `Math.min(coupon.value, afterPromotion)` 去掉 | Task 2 的「优惠额封顶」用例 |
| M7 | 创建券时 `scope` 改成读 DTO | Task 3 的「平台券不被伪造」用例 |
| M8 | `releaseInTx` 不改 `reservedCount` | Task 5 的「M8 取消时释放」用例 |
| M9 | 超时路径改成**不**调 `releaseReservationInTx` | Task 5 的「M9 超时释放」用例 |
| M10 | 引擎去掉封顶 | Task 2 的「实付恒 >= 0」用例 |
| M11 | 引擎里改成浮点乘法 | Task 2 的「整数域」用例 |
| M12 | 下单时从库里实时读券的面额（不写快照） | Task 4 的「M12 历史订单」用例 |
| M13 | 退款时重算优惠 | Task 5 的「M13 退款额」用例 |
| M14 | `reservedCount` 的更新不放在同一事务 | Task 5 的「M14 计数同步」用例 |
| M15 | 有效期判定改成用 `new Date()` | Task 3 的「M15 数据库时钟」用例 |
| M16 | 引擎里把活动与券的顺序调换 | Task 2 的「M16 叠加顺序」用例 |
| M17 | 结算页不用服务端的返回金额 | 手测 #6 |

> ⚠️ **M5 的注入要特别注意**：删掉那条索引后，
> `prisma migrate deploy` 不会自动把它加回来（迁移历史里有它）。
> 注入后要**手动** `DROP INDEX`，测完再手动建回来——
> **不要用 `prisma migrate reset`**（全局约定禁用）。
>
> ⚠️ **M15 的注入预期**：把 `dbNow` 换成 `new Date()` 后，
> 在本机上「数据库时钟」与「应用时钟」几乎一样，**测试可能不会挂**。
> 这正是 §0.6 里说的「M15 的测试价值在于锁住写法」。
> 注入时要**确保测试真的挂了**——如果没挂，说明这条护栏**没有测试覆盖**，
> 要在验收记录里**如实写「这条没测到」**，不要含糊过去。

### 8.3 容器化验证

```bash
cd infra && docker compose build && docker compose up -d
```

七个服务全部起来。公开接口要用店铺子域名访问。

### 8.4 写验收记录

`docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md`，结构照
`2026-10-24-plan-03-acceptance.md` 与 `2026-10-25-plan-04-frontend-polish-acceptance.md`：

1. 自动化测试结果
2. 容器化验证
3. 手动验收场景（**填实测看到的东西**，不写「正常」）
4. **机制级验证（失败注入）表** —— 17 项护栏逐项，这是重点
5. 交付物清单
6. **已知遗留项**（诚实列出没测到的、没覆盖的）
7. 下一阶段（5b：平台计费）

> ⚠️ **第 4 项里 M15 与 M17 要特别标注**：
> M15 可能在注入后**测不出差别**（本机两个时钟几乎一致），
> M17 是手测项不是自动化项。
> **如实写清楚**——「失败注入没有生效」比「看起来测过了」诚实得多。

### 8.5 更新 README 与记忆

- README 的「当前进度」与「后续计划」
- 记忆里 `project_plan02_execution.md` 更新进度与新踩的坑

- [ ] **Step 8.6: 提交**

```bash
git add docs/ README.md
git commit -m "docs: 阶段 5a 验收记录与收尾"
```

---

## 附：Task 与护栏的对应表

| Task | 覆盖的护栏编号 | 关键产出 |
|------|--------------|---------|
| 1 | —（白名单登记本身是 fail-fast） | 4 张表 + 8 个快照字段 + 3 个 getter + 1 条手写部分唯一索引 |
| 2 | M6、M10、M11、M16 | 纯函数 `computeDiscount` + 完整单测（引擎的每条分支） |
| 3 | M4、M7、M14（领取侧）、M15 | 券与活动的 CRUD、领券的并发限额、平台券的服务端判定 |
| 4 | M1、M2、M3、M5、M6（下单侧）、M12、M14（核销侧）、M16（端到端） | 下单接入优惠 + 券的预占核销 + 订单快照 |
| 5 | M8、M9、M13、M14 | 取消与超时共用同一释放函数；支付成功转 USED |
| 6 | M1、M2、M17（前端侧） | 领券中心、结算页四行金额、中转路由白名单 |
| 7 | M7（前端侧）、M1、M2（创建侧） | 商家后台营销页 + 中转路由白名单 |
| 8 | 全部 17 项复验 | 验收记录 + 失败注入表 |

---

## 附：本计划相对设计文档的**实施层决策**（不改设计，只定细节）

设计文档没有明确说、但实施时必须定下来的事，集中列在这里，
免得实施者各自发明一套：

| # | 决策 | 理由 |
|---|------|------|
| 1 | **用户手动选了券就只用那一张**，不在候选里另挑更优的 | 用户选了 30 元券、系统偷偷用 50 元券，界面显示的和实际扣的不一样（M17）。「自动取最优」只在用户没选时兜底 |
| 2 | **`PromotionCandidate` 加 `startsAt` / `endsAt`** | 设计文档 §4.1 的形状里没有有效期字段，但 §4.2 的算法要判「未过期」。输入形状里必须有对应字段 |
| 3 | **活动取「减免额最大」的那一个**（`orderBy: { discountAmount: 'desc' }`） | 设计文档说「当前生效的店铺满减活动」（单数），但表里可能有多条 ACTIVE。取减免最大的这条是最不容易让商家意外的规则 |
| 4 | **「一张券记录 = 一次领取」**：`coupon_claims.quantity` 累加在**一行**上，核销按 `couponId` 唯一 | 设计文档 §3.2/§3.3 的形状。⚠️ **已知简化**：`perUserLimit > 1` 时多张同码券在核销层面被视作同一张。**实施时若发现用例跑不通**，记进 §0.5 勘误表再定方案，**不要擅自改数据模型** |
| 5 | **核销撞唯一索引时抛 `ConflictException` 而不是原始 P2002** | P2002 会让事务 aborted；抛业务异常能让事务正常回滚，且不会被外层的 P2002 重试逻辑误判 |
| 6 | **退款路径不改**：读 `order.totalAmount` 即实付额 | 设计文档 §7.2 M13 说「退款额 = 实付额」。退款逻辑本来就读 `totalAmount`，天然满足。**要在代码注释里写明「不重算优惠是有意的」** |
| 7 | **`Coupon` 的 `type` 固定 `FIXED`，DTO 里没有 `type` 字段** | 本阶段只实现满减券。让客户端传 `type: 'PERCENT'` 的话，库里会躺着一张算不动的券 |
| 8 | **`scope` 的平台超管路径**：平台超管创建平台券时必须显式指定目标租户 | 平台作用域的 `tenantId` 是 null，扩展要求 `create` 显式带 `tenantId`（否则抛 `TenantScopeError`） |
