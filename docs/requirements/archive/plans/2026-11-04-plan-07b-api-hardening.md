# 阶段 7b「api 代码收口」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 api 侧已立项的质量问题：购物车合并非原子、setMedia N+1、券列表与佣金流水无分页、对账单全量拉表、领券 P2002 吞任意冲突、`currentTenantId` 失败处理 16 处不一致、`isUniqueViolation` 6 份复制、日志缺口，并补 merchant 订单列表缺失的 `itemCount`。

**Architecture:** 波次 1 五路并行（文件域互不重叠），波次 2 横切收口单代理串行（条目互相交叠），波次 3 全量回归。每条改动「改前改后测试通过」，分页为 breaking change 的两处由对应前端页同步做最小接入。

**Tech Stack:** NestJS 11、Prisma 6、Jest（单测同目录 `*.spec.ts`）、e2e 串行。

**设计文档:** `docs/superpowers/specs/2026-11-03-plan-07-engineering-hardening-design.md` §四

**执行约定（agent-team 模式）:** 实施代理**不提交**；验证命令必须真实执行并记录输出；工作分支 `plan-07b-api-hardening`。行号是写作时参考，以内容定位为准。

**关键事实（上下文核实结论，实施者必读）:**
- cart 模块**零单测**，只有 `api/test/cart.e2e-spec.ts`——T1 要新建 spec。
- `isUniqueViolation` 复制是 **6 份**不是 5 份；`payment.service.ts` 已 `import` 公共工具又在 L2309 定义了同名模块级 function（同名遮蔽），收口时必须处理。
- `coupon_claims_coupon_customer_uniq` 唯一约束**只存在于迁移 SQL**（`prisma/migrations/20261025100000_add_marketing_tables/migration.sql:131`），schema.prisma 无声明。
- merchant-admin 订单列表组件用了 `order.itemCount`（`src/components/order/order-list.tsx:145`），后端**从不返回**该字段（恒 undefined）——T8 补上。
- `currentTenantId` 有 **16 个定义点**（含 `merchant-statement` 的 `requireTenantId` 变体与 `payment.service` 的 public 版本）；e2e `tenant-isolation.e2e-spec.ts:163-197` 断言的是**拦截器层**的 404 + 文案「无法确定店铺，请通过店铺子域名访问」——**拦截器层一律不动**，本计划只统一 service 层为 403。
- 三个「magic number」（15 分钟支付超时 `order.service.ts:39-42`、合并上限 `cart.service.ts:47`、分页上限 `pagination.ts:10`）**已全部具名化**——设计里这条已完成，无需改动。

---

## 波次 1（五个 Task 文件域互不重叠，可并行）

### Task 1: 购物车合并事务化 + 批量化 + 补单测

**Files:**
- Modify: `api/src/modules/cart/cart.service.ts`（merge 方法，L129-240）
- Create: `api/src/modules/cart/cart.service.spec.ts`（cart 模块目前无任何单测）

- [ ] **Step 1: 先写失败测试**（新建 spec，聚焦「事务性」与「批量化结果正确」两个行为）

测试骨架（prisma 用既有单测的 mock 风格——参照 `api/src/modules/billing/merchant-statement.service.spec.ts` 的 provider mock 方式；以下断言必须全部落地）：

```ts
describe('CartService.merge', () => {
  it('游客条目与账号条目并存时取 max，且新建/更新全部发生在同一事务里', async () => {
    // mock：账号车已有 sku-A×2，游客车 sku-A×5 + sku-B×3（均可售）
    // 断言：$transaction 被调用一次；
    //       事务内 createMany 收到 sku-B×3；
    //       事务内分组 updateMany 收到 sku-A→5；
    //       返回前 deleteMany(游客车) 也在同一事务回调里执行
  });

  it('合并中途失败 → 整体回滚：账号车无半合并状态、游客车仍在', async () => {
    // mock：$transaction 的回调执行到 deleteMany 时抛错
    // 断言：抛错向上传播；createMany/updateMany 的写不落库（由真实事务保证，
    //       mock 层断言 deleteMany 抛错后没有额外的容器级写入被调用）
  });

  it('护栏不变：不可售 SKU 丢弃、数量超上限丢弃、幂等（无游客车直接返回）', async () => {
    // 三个子断言，行为与改造前 e2e 语义一致
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && npx jest src/modules/cart/cart.service.spec.ts`
Expected: FAIL（新断言在现有实现下不成立——现有实现无 `$transaction`、无 `createMany`）

- [ ] **Step 3: 重写 merge 的写入段**（校验/护栏逻辑不动，只改写入与事务边界）

替换 merge 方法中 `for (const guestItem of itemsToMerge) { ... }` 循环到 `await this.prisma.cart.deleteMany(...)` 的整段（原 L184-237）为：

```ts
    // 先在内存里把合并结果算完（护栏 1/2/3 的判定逻辑保持不变），
    // 再一次性写入——逐条 create/update 是几十次往返，且三步写入
    // 不在一个事务里，中途失败会留下「半合并」状态且游客车残留。
    const creates: { skuId: string; quantity: number }[] = [];
    const updatesByQuantity = new Map<number, string[]>();

    for (const guestItem of itemsToMerge) {
      // 护栏 2：搬进来的每一条都重新校验，不合格的直接丢弃（不报错）
      if (!sellableSkuIds.has(guestItem.skuId)) {
        continue;
      }

      // ⚠️ 当前不可达——游客条目只能由 addItem 产生，那里已经限了上限。
      // 但不可达不等于可以不写：将来若加了「导入购物车」「后台加购」
      // 之类的入口，这条就是唯一的防线。
      if (guestItem.quantity < 1 || guestItem.quantity > MAX_CART_QUANTITY) {
        continue;
      }

      // 护栏 1：两边都有 → 取 max
      const accountQuantity = accountQuantityBySku.get(guestItem.skuId);
      const mergedQuantity = accountQuantity
        ? Math.max(accountQuantity, guestItem.quantity)
        : guestItem.quantity;

      // 合并后的总数量也不能超上限
      if (mergedQuantity > MAX_CART_QUANTITY) {
        continue;
      }

      if (accountQuantity === undefined) {
        creates.push({ skuId: guestItem.skuId, quantity: mergedQuantity });
      } else if (mergedQuantity !== accountQuantity) {
        const list = updatesByQuantity.get(mergedQuantity) ?? [];
        list.push(guestItem.skuId);
        updatesByQuantity.set(mergedQuantity, list);
      }
    }

    // 「写合并结果 + 清不可售 + 删游客车」必须原子：分成多个事务的话，
    // 后面的失败会让订单车停在半合并状态、游客车残留，下次重复合并。
    return this.prisma.$transaction(async (tx) => {
      if (creates.length > 0) {
        await tx.cartItem.createMany({
          data: creates.map((c) => ({
            tenantId,
            cartId: accountCart.id,
            skuId: c.skuId,
            quantity: c.quantity,
          })),
        });
      }
      for (const [quantity, skuIds] of updatesByQuantity) {
        await tx.cartItem.updateMany({
          where: { cartId: accountCart.id, skuId: { in: skuIds } },
          data: { quantity },
        });
      }

      // 账号车里原本就有、但现在已经不可售的条目，在这次真的发生了合并时
      // 一并清掉（原 removeUnsellableItems 逻辑，注意要改用 tx 句柄）。
      await this.removeUnsellableItems(accountCart, tx);

      // 游客车整体删掉：条目已合并过去，留着会让「游客车还在」与实际状态不符，
      // 也会让下一次合并重复处理。CartItem 是 cascade 删的。
      await tx.cart.deleteMany({ where: { id: guestCart.id } });
    }).then(() => accountCart);
```

同时把 `removeUnsellableItems(cart: Cart)` 签名改为 `removeUnsellableItems(cart: Cart, tx?: Prisma.TransactionClient)`，内部所有 `this.prisma.` 调用改用 `tx ?? this.prisma`（检查该方法内是否还有别的调用方——有则保持默认参数兼容）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd api && npx jest src/modules/cart/cart.service.spec.ts`
Expected: PASS

- [ ] **Step 5: 回归 e2e**

Run: `cd api && npx jest --config ./test/jest-e2e.json test/cart.e2e-spec.ts`
Expected: 全绿（购物车 e2e 行为不变）

### Task 2: setMedia 批量化

**Files:**
- Modify: `api/src/modules/catalog/products/products.service.ts`（setMedia 的事务体，L322-345）

- [ ] **Step 1: 替换事务体内的两个循环**

把「补上新引用的」（逐个 `findFirst` + `create`）与「按传入顺序重排 sort」（逐条 `updateMany`）两个 for 循环整体替换为（外层 `$transaction` 与删除/返回逻辑不动）：

```ts
      const existingRows = await tx.productMedia.findMany({
        where: { productId, mediaId: { in: mediaIds } },
        select: { mediaId: true },
      });
      const existingIds = new Set(existingRows.map((r) => r.mediaId));
      const toCreate = mediaIds
        .filter((id) => !existingIds.has(id))
        .map((mediaId) => ({ tenantId, productId, mediaId }));
      if (toCreate.length > 0) {
        await tx.productMedia.createMany({ data: toCreate });
      }

      // 按传入顺序重排 sort：相同 sort 值分组批量 updateMany，
      // 最多 MAX_PAGE_SIZE(100) 组，替代逐条循环
      const idsBySort = new Map<number, string[]>();
      mediaIds.forEach((mediaId, sort) => {
        const list = idsBySort.get(sort) ?? [];
        list.push(mediaId);
        idsBySort.set(sort, list);
      });
      for (const [sort, mediaIdsInSort] of idsBySort) {
        await tx.productMedia.updateMany({
          where: { productId, mediaId: { in: mediaIdsInSort } },
          data: { sort },
        });
      }
```

- [ ] **Step 2: 行为回归验证**（catalog 无单测，以 e2e 为准绳）

Run: `cd api && npx jest --config ./test/jest-e2e.json test/catalog.e2e-spec.ts test/media.e2e-spec.ts 2>/dev/null || cd api && npx jest --config ./test/jest-e2e.json --listTests | grep -E 'catalog|media|product'`
Expected: 若无同名 e2e 文件，用上面第二条列出实际文件名并全跑；全绿。

- [ ] **Step 3: 补一个最小单测**（新建 `products.service.spec.ts`，只测 setMedia 的批量行为：已存在引用不重复创建、sort 重排正确、缺失媒体报错文案不变）

### Task 3: 券服务两条（分页 + P2002 收窄，同文件必须同一代理做）

**Files:**
- Modify: `api/src/modules/coupon/coupon.service.ts`（listCoupons L299-307、claim 重试 L341-372）
- Modify: 券列表 controller（grep `listCoupons` 找到入口，加 query DTO）
- Modify: `merchant-admin/src/components/marketing/coupon-manager.tsx`（最小分页接入）
- Test: `api/src/modules/coupon/coupon.service.spec.ts`（新建，coupon.service 现无 spec）

- [ ] **Step 1: listCoupons 加分页**（套用 order.service.ts:916 的既有模式）

```ts
  /** 券列表（商家侧，分页） */
  async listCoupons(params: { page?: number; pageSize?: number } = {}): Promise<{
    items: Coupon[];
    total: number;
  }> {
    const tenantId = this.currentTenantId();
    const { page, pageSize } = clampPagination(params.page, params.pageSize);
    const where = { tenantId };
    const [items, total] = await Promise.all([
      this.prisma.coupon.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.coupon.count({ where }),
    ]);
    return { items, total };
  }
```

Controller 加 `@Query() query: { page?: string; pageSize?: string }` 并用 `toIntOr`（`common/http/pagination.ts` 已导出）转数字后传入。**breaking change**：响应仍是 `{ items, total }`，但 items 变成一页——前端必须传参。

- [ ] **Step 2: claim 的 P2002 收窄**（照 order.service.ts:1095 的 isOrderNoViolation 模式）

```ts
  /**
   * 这次 P2002 是不是「领取记录」冲突（coupon_claims_coupon_customer_uniq）。
   *
   * 只有它才该静默重试；别的唯一约束冲突（如 code 撞了）是有业务含义的失败，
   * 吞掉重试会掩盖真实错误。
   */
  private isClaimViolation(error: unknown): boolean {
    if (!isUniqueViolation(error)) {
      return false;
    }
    const meta = (error as { meta?: { target?: unknown } }).meta;
    const target = meta?.target;
    const targetText = Array.isArray(target)
      ? target.filter((p): p is string => typeof p === 'string').join(',')
      : typeof target === 'string'
        ? target
        : '';
    return targetText.includes('coupon_claims_coupon_customer_uniq');
  }
```

claim 循环里的 `if (this.isUniqueViolation(error)) continue;` 改为 `if (this.isClaimViolation(error)) continue;`。新增的 `isClaimViolation` 内部用 `common/errors/unique-constraint` 的公共 `isUniqueViolation`（import 进来）。**类里原有的私有 `isUniqueViolation` 本 Task 不动**——它的收口归波次 2 的 Task 7，本 Task 只改 claim 的语义。

- [ ] **Step 3: 新建 coupon.service.spec.ts**，至少覆盖：
  - listCoupons 传 page/pageSize 时 skip/take 正确、返回 `{ items, total }`；
  - claim 撞 `coupon_claims_coupon_customer_uniq` 的 P2002 → 重试成功；
  - claim 撞**其他** P2002（meta.target 不含该约束名）→ 不重试、直接抛出。

- [ ] **Step 4: merchant-admin 券列表页最小分页接入**（参照 order-list 的分页 UI 样式；coupon-manager 调用处传 `page`/`pageSize`，加「上一页 / 下一页 + 共 N 条」）

- [ ] **Step 5: 验证**

Run: `cd api && npx jest src/modules/coupon/coupon.service.spec.ts && npx jest --config ./test/jest-e2e.json test/coupon.e2e-spec.ts test/coupon-release.e2e-spec.ts`
Expected: 全绿（领券/核销 e2e 不回归）

Run: `cd merchant-admin && npm test && npx tsc --noEmit`
Expected: 全绿

### Task 4: 对账单列表改 DB 端归期

**Files:**
- Modify: `api/src/modules/billing/merchant-statement.service.ts`（list 方法 L129-149）

- [ ] **Step 1: 实施前先查表名与列名**

Run: `grep -A5 'model MerchantReceipt' api/prisma/schema.prisma`（确认 `@@map` 表名与 occurredAt 列映射）

- [ ] **Step 2: 把全量拉表改成 DB 端 DISTINCT 归期**（Prisma 的 groupBy 无法按月份表达式分组，用参数化 $queryRaw；`tenantId` 走绑定参数无注入风险）

```ts
    // ⚠️ 「有哪些期」是从流水里推出来的。原来把本租户全部流水拉回内存
    // 只为取 occurredAt 的月份集合——订单量增长后这是无界查询，
    // 改成 DB 端 DISTINCT 归期，只回每月一行的字符串。
    const rows = await this.prisma.$queryRaw<{ period: string }[]>`
      SELECT DISTINCT to_char("occurredAt", 'YYYY-MM') AS period
      FROM "merchant_receipts"
      WHERE "tenantId" = ${tenantId}`;
    const receipts = rows.map((r) => ({
      occurredAt: new Date(`${r.period}-01T00:00:00Z`),
    })) as ReceiptPeriodRow[];
```

（表名/列名以 Step 1 的实际结果为准；`collectPeriodLabels` 与后续逻辑不动——它只需要 occurredAt 值。）

- [ ] **Step 3: 跑既有 spec + 相关 e2e**

Run: `cd api && npx jest src/modules/billing/merchant-statement.service.spec.ts && npx jest --config ./test/jest-e2e.json test/merchant-statement.e2e-spec.ts`
Expected: 全绿（spec 若 mock 了 findMany 需同步改为 mock $queryRaw——这是预期内的测试改动）

### Task 5: 佣金流水分页 + byMerchant 改 DB 聚合

**Files:**
- Modify: `api/src/modules/billing/commission.service.ts`（ledger L397-427）
- Modify: `api/src/modules/billing/platform-report.controller.ts`（L63-71 commissions 入口）
- Modify: `platform-admin` 佣金报表页（`app/(dashboard)/commissions/page.tsx` 及其取数封装）
- Test: `api/src/modules/billing/commission.service.spec.ts`（已存在，补分页断言）

- [ ] **Step 1: ledger 改造**——`entries` 分页 + `byMerchant` 改 DB 端聚合（byMerchant 必须保持全区间汇总，不能只汇一页）：

```ts
  async ledger(input: {
    from: Date;
    to: Date;
    page?: number;
    pageSize?: number;
  }): Promise<CommissionLedger & { total: number }> {
    const { from, to } = input;
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('区间非法：from 必须早于 to');
    }
    const { page, pageSize } = clampPagination(input.page, input.pageSize);
    return tenantContext.run(platformScope(), async () => {
      const where = { occurredAt: { gte: from, lt: to } };
      const [entries, total, grouped] = await Promise.all([
        this.prisma.commissionEntry.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.commissionEntry.count({ where }),
        // byMerchant 是「区间汇总」，必须全量聚合而非只汇当前页
        this.prisma.commissionEntry.groupBy({
          by: ['tenantId'],
          where,
          _sum: { netAmount: true },
        }),
      ]);
      // byMerchant 的商家名解析与净额口径保持原逻辑（netAmount 来自 _sum）
      ...
      return { from, to, byMerchant, entries, total };
    });
  }
```

（`netAmount` 字段名以 schema 实际字段为准；`_sum` 的空值处理沿用现有汇总代码口径。）

- [ ] **Step 2: controller 透传 page/pageSize**（`CommissionQueryDto` 加两个可选数字字段，`clampPagination` 夹取）

- [ ] **Step 3: platform-admin 报表页接入分页**（entries 分页 UI + `total` 展示；byMerchant 汇总卡片不受影响）

- [ ] **Step 4: 验证**

Run: `cd api && npx jest src/modules/billing/commission.service.spec.ts src/modules/billing/commission.spec.ts && npx jest --config ./test/jest-e2e.json test/platform-report.e2e-spec.ts 2>/dev/null; npx jest --config ./test/jest-e2e.json --listTests | grep -iE 'commission|report'`
Expected: 全绿

Run: `cd platform-admin && npm test && npx tsc --noEmit`
Expected: 全绿

---

## 波次 2（波次 1 全部合并后执行；单代理串行——三条互相交叠）

### Task 6: currentTenantId 统一（16 定义点收敛到单一实现）

**Files:**
- Create: `api/src/common/tenant/require-tenant.ts`
- Modify: 16 个 service/controller 的私有 `currentTenantId` 方法体（调用点 ~55 处**不动**）

- [ ] **Step 1: 新建公共函数**

```ts
import { ForbiddenException } from '@nestjs/common';
import { getTenantContext } from './tenant-context';

/**
 * 取当前租户 id；拿不到就 403。
 *
 * ⚠️ 这里统一的是 **service 层**的语义（已认证但上下文里没有 tenantId，
 * 通常是角色越界调到了租户接口）——匿名请求解析不到子域名的 404
 * 是 TenantContextInterceptor 的职责（文案「无法确定店铺，请通过店铺子域名访问」），
 * 那条路径 e2e 有精确断言，本函数绝不改变它。
 */
export function requireTenantId(): string {
  const { tenantId } = getTenantContext();
  if (!tenantId) {
    throw new ForbiddenException('无法确定店铺');
  }
  return tenantId;
}
```

- [ ] **Step 2: 16 个定义点的方法体全部改为委托**（保持方法名与可见性不变，调用点零改动；唯一例外 `merchant-statement.service.ts` 的 `requireTenantId` 直接改成 re-export 调用）：

```ts
  private currentTenantId(): string {
    return requireTenantId();
  }
```

注意：`payment.service.ts` 的 `currentTenantId` 是 **public**（被 billing.controller 跨 service 调用），同样只改方法体。文案统一为「无法确定店铺」（原 404/401 处的文案一并变 403 + 该文案）。

- [ ] **Step 3: 全量验证**（这是行为统一改动，必须全量跑）

Run: `cd api && npm test && npm run test:e2e`
Expected: 单测 886+ 全绿；e2e 657+ 全绿。若 tenant-isolation / auth 的 404 断言变红，**说明动了不该动的拦截器层**——回查改动，拦截器与「匿名解析子域名」路径必须保持 404 原文案。

### Task 7: isUniqueViolation 6 份复制收敛

**Files:**
- Modify: `coupon-redemption.service.ts`、`cart.service.ts`、`order.service.ts`、`payout-execution.service.ts`、`payment.service.ts`（coupon.service 已在 Task 3 处理）
- Modify: `api/src/common/errors/unique-constraint.ts`（如需补导出——现有 `isUniqueViolation` 已可直接用）

- [ ] **Step 1: 五个文件各自删除私有/本地 `isUniqueViolation` 定义，改为 `import { isUniqueViolation } from '../../../common/errors/unique-constraint'`（相对深度按文件实际层级）**

特别处理 `payment.service.ts`：L2309 的**模块级 function** 与文件顶部既有 `import` 同名——删除本地 function 后确认所有调用点走的都是公共版（公共版签名一致，行为等价）。类方法调用点 `this.isUniqueViolation(...)` 要改成 `isUniqueViolation(...)`。

- [ ] **Step 2: 验证**

Run: `cd api && npm test && npm run test:e2e`
Expected: 全绿（纯等价替换，任何红都是替换遗漏）

### Task 8: 商家订单列表补 itemCount

**Files:**
- Modify: `api/src/modules/order/order.service.ts`（listMerchantOrders L946-979）
- Test: e2e（merchant orders 套件）

- [ ] **Step 1: listMerchantOrders 的 findMany 加聚合 include**（消费者列表不需要行项，**不动** `listConsumerOrders`）

```ts
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { items: true } } },
      }),
```

返回前映射：`items: rows.map(({ _count, ...order }) => ({ ...order, itemCount: _count.items }))`（关联名 `items` 以 schema 的 `Order.items` 关系名为准）。

- [ ] **Step 2: e2e 断言补充**：merchant orders 列表 e2e 里补一条「列表项带 itemCount 且等于订单条目数」。

Run: `cd api && npx jest --config ./test/jest-e2e.json --listTests | grep -i order`（选商户订单相关套件跑）

### Task 9: 日志收口

**Files:**
- Modify: `api/src/main.ts`（L63 console.log；挂 LoggingInterceptor）
- Create: `api/src/common/http/logging.interceptor.ts`
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`（L451/457 两处 `new PrismaClient()`）

- [ ] **Step 1: LoggingInterceptor**（不打 body——防止敏感信息入日志）

```ts
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const req = context.switchToHttp().getRequest();
    const { method, url } = req;
    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse();
          this.logger.log(`${method} ${url} ${res.statusCode} ${Date.now() - startedAt}ms`);
        },
        error: (error: { status?: number; message?: string }) => {
          this.logger.warn(
            `${method} ${url} ${error?.status ?? 500} ${Date.now() - startedAt}ms ${error?.message ?? ''}`,
          );
        },
      }),
    );
  }
}
```

main.ts：`app.useGlobalInterceptors(app.get(TenantContextInterceptor), app.get(LoggingInterceptor))`（LoggingInterceptor 放在租户拦截器**之后**注册；Nest 全局 interceptor 先注册的在外层——租户上下文要先建立）。

- [ ] **Step 2: main.ts:63 的 `console.log` 改 `Logger.log`（用 main 里已有的 Nest Logger 实例）**

- [ ] **Step 3: Prisma client 日志**（两处 new PrismaClient 都要改；测试进程也会实例化——warn/error 级别不会刷屏）

```ts
new PrismaClient({
  log: process.env.NODE_ENV === 'test' ? ['error'] : ['warn', 'error'],
})
```

- [ ] **Step 4: 验证**

Run: `cd api && npm run build && npm test`
Expected: build 成功、单测全绿。启动 dev 服务后 `curl` 一个接口，终端应出现 `HTTP ... GET /api/v1/... 200 Nms` 格式日志。

---

## 波次 3：全量回归（主会话执行）

- [ ] `cd api && npm test`（预期 ≥ 893 条，新增 spec 计入）全绿
- [ ] `cd api && npm run test:e2e` 全绿（657+ 新增断言）
- [ ] `cd api && npx tsc --noEmit` 无输出
- [ ] `cd merchant-admin && npm test && npx tsc --noEmit && npm run build` 全绿
- [ ] `cd platform-admin && npm test && npx tsc --noEmit && npm run build` 全绿
- [ ] 更新验收记录 `docs/superpowers/plans/2026-11-04-plan-07b-acceptance.md`
