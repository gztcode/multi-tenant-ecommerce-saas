# 阶段 10「事务边界与连接池收口」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **设计文档**：`docs/superpowers/specs/2026-11-04-plan-10-tx-boundary-design.md`

**Goal:** 消除「事务回调内借第二条连接」这一类缺陷，让并发写路径不再依赖连接池大小；用静态检测器把它固化成回归护栏。

**Architecture:** 沿用仓库已有的「方法接受可选客户端参数」模式（`coupon.service.ts` 的 `databaseNow(client)`），把散落的 `{ maxWait, timeout }` 之外再统一一处「客户端来源」。检测器用 TypeScript 类型信息构建全局调用图，追踪「事务回调 → 方法转调 → `this.prisma`」的完整链路。

**Tech Stack:** NestJS 11 + Prisma 6 + TypeScript 5.9（`ts.createProgram` + `TypeChecker`）+ Jest 30

---

## §0 全局约定 / 动手前必须知道

1. **中文**：注释、测试名、commit message、报告一律简体中文。
2. **不提交 git**：实施代理改完代码、跑完定向测试，**不执行 `git commit`**。主控审查通过后统一提交。
3. **只跑定向测试**：不要跑全量 e2e（要真实数据库与 MinIO，串行且慢）。全量回归由主控在最后统一跑。
4. **失败注入必须独占**：故意改坏源码验证测试时，不要同时跑其他测试。
5. **不改金额口径、不改业务语义**：本阶段只动「客户端从哪来」，不动任何金额、状态机、护栏判定逻辑。
6. **`prisma migrate dev` 不可用**（本仓历史迁移 checksum 不符）；本阶段不涉及迁移。
7. **lint 只对改动文件跑**：`npx eslint <file>`，要求零错误。
8. **注意：`PrismaTransaction` 类型在 `api/src/common/prisma/prisma-transaction.ts`**，它是 `tx` 的真实类型；`TenantPrismaService` 是非事务客户端的类型。

---

## Task 1：检测器自测 + 护栏单测

**Files:**
- Create: `api/src/common/db/tx-boundary-scanner.spec.ts`
- Modify: `api/src/common/db/tx-boundary-scanner.ts`（补豁免清单支持）

### 背景

检测器已经写好（`src/common/db/tx-boundary-scanner.ts`），当前能报出 15 处借用点 / 9 个根因，与人工审计完全吻合。本任务把它固化成**可回归的单测**，并加入**豁免清单机制**。

### Step 1：先写失败用例

**先给检测器补两个字段**（豁免锚点要抗行号漂移）：

在 `TxBoundaryFinding` 上加：

```ts
/** 借用点所在的方法名（所属类可省略，同名方法在本仓唯一） */
method: string;
/** 借用点所在的整条属性访问表达式（如 `this.prisma.coupon.findMany`） */
expr: string;
```

实现要点（都在 `findPrismaUsages` 与 `scanCallback` 里）：
- `method` 取**声明该借用点的方法名**（`owner` 已知，取 `method.name.getText()`）。
- `expr` 取从 `this.prisma` **向上走到最外层**的属性访问表达式的原文；
  用 `ts.forEachChild` 不行（会走到别的语句），改为**沿 `node.parent` 往上爬**，
  只要父节点仍是 `PropertyAccessExpression` 且父节点的 `expression` 就是当前节点，就继续爬。

⚠️ `node.parent` 需要 `setParentNodes: true`（脚本里已经开了）。

然后写 `tx-boundary-scanner.spec.ts`：

```ts
import * as ts from 'typescript';

import { findExemptViolations, scanProgram } from './tx-boundary-scanner';

const API_ROOT = join(__dirname, '..', '..', '..');

/** 用一段内联源码建一个最小 Program 并扫描 */
function scanSource(source: string): TxBoundaryFinding[] {
  const file = join(API_ROOT, 'src', '__tx_boundary_fixture__.ts');
  const host = ts.createCompilerHost({ strict: true });
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === file
      ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2023, true)
      : originalGetSourceFile(name, ...rest);
  host.fileExists = ((orig) => (name: string) => name === file || orig(name))(
    host.fileExists.bind(host),
  );
  host.readFile = ((orig) => (name: string) =>
    name === file ? source : orig(name))(host.readFile.bind(host));

  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    setParentNodes: true,
  }, host);

  return scanProgram(program, API_ROOT);
}
```

用例：

```ts
describe('事务边界扫描器', () => {
  it('事务回调内直接用 this.prisma → 报出', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await this.prisma.foo.findMany();
          });
        }
      }
    `;
    const findings = scanSource(src);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].expr).toBe('this.prisma.foo.findMany');
    expect(findings[0].method).toBe('run');
  });

  it('事务回调内只用量 tx → 不报', () => {
    const src = `
      class A {
        async run(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await tx.foo.findMany();
          });
        }
      }
    `;
    expect(scanSource(src)).toHaveLength(0);
  });

  it('事务外用 this.prisma → 不报', () => {
    const src = `
      class A {
        async run(prisma: any) {
          await this.prisma.foo.findMany();
          return prisma.$transaction(async (tx: any) => {
            await tx.bar.findMany();
          });
        }
      }
    `;
    expect(scanSource(src)).toHaveLength(0);
  });
});
```

### Step 2：运行，确认失败

```bash
cd api && npx jest src/common/db/tx-boundary-scanner.spec.ts --runInBand
```

### Step 3：补豁免清单支持

在 `tx-boundary-scanner.ts` 里加：

```ts
/**
 * 已登记的豁免点。
 *
 * ⚠️ **每条必须写 `why`**：将来有人想「顺手修掉」它时，
 *    会先看到理由 —— 而这正是它当初不能修的原因。
 *
 * ⚠️ **锚点用「文件 + 方法名 + 表达式」，不用行号**：
 *    行号会随任何改动漂移，豁免会莫名其妙失效（或误放行）。
 */
export interface TxBoundaryExemption {
  /** 相对 api 根的路径 */
  file: string;
  /** 借用点所在的方法名 */
  method: string;
  /** 借用点的属性访问表达式原文 */
  expr: string;
  /** 为什么可以豁免 */
  why: string;
}

/**
 * 剔除已登记的豁免点，返回**仍然违规**的项。
 */
export function findExemptViolations(
  findings: readonly TxBoundaryFinding[],
  exemptions: readonly TxBoundaryExemption[],
): TxBoundaryFinding[] {
  return findings.filter(
    (f) =>
      !exemptions.some(
        (e) =>
          e.file === f.file &&
          e.method === f.method &&
          e.expr === f.expr,
      ),
  );
}
```

**豁免清单单独放一个文件** `api/src/common/db/tx-boundary-exemptions.ts`：

```ts
import type { TxBoundaryExemption } from './tx-boundary-scanner';

/**
 * 已登记的、无法消除的借用点。
 *
 * ⚠️ **新增条目必须写清 `why`** —— 护栏会让「没有理由的例外」无法存在。
 * ⚠️ **锚点用「文件 + 方法名 + 表达式」，不用行号**：行号会随改动漂移。
 *
 * ⚠️ **当前清单为空**：阶段 10 初稿曾把「平台券查询」列为豁免项，
 *    理由是「tx 没有租户扩展」—— **实测证明这个前提是错的**：
 *    Prisma 6 的扩展会应用到交互事务客户端，平台作用域在 tx 上完全生效，
 *    `coupon.service.ts:529/535` 已有「平台券走 tx」的先例。
 *    所以 9 个根因全部修掉了，没有例外。
 */
export const TX_BOUNDARY_EXEMPTIONS: readonly TxBoundaryExemption[] = [];
```

### Step 4：加「全仓扫描」的护栏用例

同文件追加：

```ts
describe('全仓事务边界护栏', () => {
  it('除了已登记的豁免，不允许再有借用点', () => {
    const program = ts.createProgram(
      [join(API_ROOT, 'src', 'main.ts')],
      {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        setParentNodes: true,
      },
    );
    const findings = scanProgram(program, API_ROOT);
    const violations = findExemptViolations(findings, TX_BOUNDARY_EXEMPTIONS);
    expect(violations.map((v) => `${v.file}:${v.method} → ${v.expr}`)).toEqual([]);
  });
});
```

> ⚠️ **建 Program 很慢**（约 30–60 秒），这个文件顶部要加
> `jest.setTimeout(180_000);`，否则会超时失败。
> ⚠️ **这条用例在 T2–T5 修完之前是红的** —— 所以**它放到 T3 执行**（波次 2 之后），
> 不要放在 T1。T1 只写上面三条内联源码用例 + 豁免机制。

### Step 5：验证

```bash
cd api && npx jest src/common/db/tx-boundary-scanner.spec.ts --runInBand && npx tsc --noEmit && npx eslint src/common/db/tx-boundary-scanner.ts src/common/db/tx-boundary-scanner.spec.ts src/common/db/tx-boundary-exemptions.ts
```

### Step 6：提交（由主控执行）

```bash
git add api/src/common/db/tx-boundary-scanner.ts api/src/common/db/tx-boundary-scanner.spec.ts api/src/common/db/tx-boundary-exemptions.ts api/scripts/scan-tx-boundary.ts
git commit -m "test(api): 事务边界静态检测器与回归护栏"
```

---

## Task 2：修 coupon 链路（6 个借用点）

**Files:**
- Modify: `api/src/modules/coupon/coupon.service.ts`

### Step 1：先写失败用例

在 `api/src/modules/coupon/coupon.service.spec.ts`（若无则新建）加：

```ts
it('事务内计算优惠时，候选券查询走事务客户端（不借第二条连接）', async () => {
  // 造一个假 tx 与假 prisma，断言 buildDiscountContext 内部
  // 用的是 tx 而不是 this.prisma
});
```

> ⚠️ 具体写法以现有 coupon 单测的假对象风格为准（看文件里已有的 `fakePrisma` 之类）。

### Step 2：运行，确认失败

```bash
cd api && npx jest src/modules/coupon --runInBand
```

### Step 3：改造

给这三个方法加**带默认值的可选 client 参数**：

```ts
async computeForOrder(
  input: {...},
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<OrderDiscount>

private async buildDiscountContext(
  input: {...},
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<{...}>

private async findCandidateCoupons(
  customerId: string,
  dbNow: Date,
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<{...}>
```

内部把 `this.prisma.xxx` 改成 `client.xxx`，`this.databaseNow(this.prisma)` 改成 `this.databaseNow(client)`。

**⚠️ 关键例外（已被实测推翻，按实测走）**：初稿曾认为「平台券查询必须留在事务外」
（理由是 tx 不带租户扩展）。**实测证明 tx 带租户扩展**（探针：事务内 + 平台作用域 + tx
的扩展拦截结果与普通 client 完全一致），且 `coupon.service.ts:529/535` 的
`findClaimableCoupon` **早就在用 `tx.coupon.findFirst` 查平台券**。

所以平台券那段**照常改**：

```ts
// 平台作用域的写法原样保留（它管的是上下文，不是扩展），
// 只把里面的 this.prisma 换成 client
const platformCoupons = await tenantContext.run(platformScope(), async () =>
  client.coupon.findMany({ ... }),
);
```

`findCandidateCoupons` 的 `client` 参数类型是
`PrismaTransaction | TenantPrismaService`，**两者都支持**平台作用域查询
（扩展对普通 client 与 tx 同样生效）。

### Step 4：调用点透传

`order.service.ts` 的下单事务里：

```ts
const discount = await this.coupon.computeForOrder(
  { tenantId, customerId: owner, originalAmount, items: pricedItems, requestedCouponId: dto.couponId },
  tx,   // ⚠️ 传事务客户端
);
```

`preview()` 的调用点**不用改**（走默认值 `this.prisma`）。

### Step 5：验证

```bash
cd api && npx jest src/modules/coupon --runInBand && npx tsc --noEmit && npx eslint src/modules/coupon/coupon.service.ts
cd api && npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/scan-tx-boundary.ts
```

预期：扫描输出里 coupon 的借用点只剩平台券那一处（豁免项）。

---

## Task 3：修订阅与额度（4 个借用点）

**Files:**
- Modify: `api/src/modules/billing/subscription.service.ts`
- Modify: `api/src/modules/billing/quota.service.ts`
- Modify: `api/src/modules/order/order.service.ts`（调用点透传）

### Step 1：先写失败用例

在对应单测里加断言：`canAcceptOrders(tenantId, tx)` 与 `currentPlan(tenantId, tx)` 内部用 tx。

### Step 2：改造

```ts
// subscription.service.ts
async current(
  tenantId: string,
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<Subscription | null> {
  return client.subscription.findFirst({ where: { tenantId } });
}

async canAcceptOrders(
  tenantId: string,
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<boolean> {
  const subscription = await this.current(tenantId, client);
  if (!subscription) {
    return true;
  }
  const now = await this.databaseNow(client);   // ⚠️ 见 Step 3
  return hasService(subscription, now);
}
```

```ts
// quota.service.ts
async currentPlan(
  tenantId: string,
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<Plan | null> {
  const subscription = await client.subscription.findFirst({ where: { tenantId } });
  if (!subscription) {
    return null;
  }
  return client.plan.findFirst({ where: { id: subscription.planId } });
}
```

### Step 3：数据库时钟的双形态

`subscription.service.ts` 里没有 `databaseNow` 的双形态实现。**新增一个私有方法**，与 `coupon.service.ts` 的同名方法一致：

```ts
/**
 * 数据库时钟（双形态）。
 *
 * ⚠️ **事务内必须传 `tx`**：`this.prisma.databaseNow()` 会借普通连接，
 *    事务已经占住一条，再借一条会在小连接池上死等（P2024）。
 */
private async databaseNow(
  client: PrismaTransaction | TenantPrismaService,
): Promise<Date> {
  if (client instanceof TenantPrismaService) {
    return client.databaseNow();
  }
  const rows = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT now() as now
  `;
  return rows[0].now;
}
```

### Step 4：调用点透传

`order.service.ts` 的 `createOrderInTx` 内：

```ts
if (!(await this.billing.canAcceptOrders(tenantId, tx))) { ... }
```

`quota.currentPlan` 的调用点同理（在 `createOrderInTx` 内）。

### Step 5：验证

```bash
cd api && npx jest src/modules/billing/subscription.service.spec.ts src/modules/billing/quota.service.spec.ts --runInBand && npx tsc --noEmit
cd api && npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/scan-tx-boundary.ts
```

---

## Task 4：修购物车合并（1 个借用点）

**Files:**
- Modify: `api/src/modules/cart/cart.service.ts`

### 改造

```ts
private async findSellableSkuIds(
  skuIds: string[],
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<Set<string>> {
  ...
  const skus = await client.sku.findMany({ ... });
  ...
}
```

调用点（`removeUnsellableItems` 内，已经收了 `tx`）：

```ts
const sellableSkuIds = await this.findSellableSkuIds(
  items.map((item) => item.skuId),
  tx,   // ⚠️ 传事务客户端
);
```

### 验证

```bash
cd api && npx jest src/modules/cart --runInBand && npx tsc --noEmit
cd api && npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/scan-tx-boundary.ts
```

---

## Task 5：修账单、支付与出款（5 个借用点）

**Files:**
- Modify: `api/src/modules/billing/invoice.service.ts`
- Modify: `api/src/modules/payment/payment.service.ts`
- Modify: `api/src/common/platform-settings/platform-setting.service.ts`
- Modify: `api/src/modules/billing/payout-execution.service.ts`

### 5.1 invoice.service.ts:168

`markInvoicePaidInTx(tx, invoiceId)` 内部把 `await this.prisma.databaseNow()` 改为用 `tx`：

```ts
const rows = await tx.$queryRaw<Array<{ now: Date }>>`
  SELECT now() as now
`;
const now = rows[0].now;
```

**⚠️ 不改方法签名**（它是 public，注释明说要给将来复用）。

**⚠️ 语义注释必须补**：`tx` 上的 `now()` 是**事务开始时刻**，与事务外取有 ≤30s 偏差；`paidAt` 属财务口径，需在注释里写明。

### 5.2 payment.service.ts:863（applyEventInTx）

同样把方法内部的 `this.prisma` 改成 `tx`。

### 5.3 payment.service.ts:1509（退款）

```ts
// ⚠️ **时钟在事务外取**：它是「事件发生时刻」的语义，
//    放在事务内会多借一条连接（小池上死等）。
const now = await this.prisma.databaseNow();
await this.prisma.$transaction(async (tx) => {
  await this.applyRefundInTx(tx, payment.id, order, now, event.refundTxnId);
}, transactionOptions());
```

### 5.4 platform-setting.service.ts:98

`readPayoutDefaultChannel` 增加可选 client 参数，**但要把校验逻辑一起搬**（不能只搬读动作）：

```ts
private async readPayoutDefaultChannel(
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<{ channel: string | null }> {
  // ⚠️ **读与校验都在这里**：只搬读动作、漏掉校验，
  //    会让「已停用的渠道」被当成可用渠道（阶段 6 的设计）。
  const setting = await tenantContext.run(platformScope(), async () =>
    client.platformSetting.findUnique({ where: { key: PAYOUT_DEFAULT_CHANNEL_KEY } }),
  );
  ... // 原有校验一字不改
}
```

**⚠️ 平台作用域的坑**：`tenantContext.run(platformScope(), ...)` 仍然要保留
（它管的是上下文，不是扩展）。**实测确认**：Prisma 6 的扩展会应用到交互事务客户端，
所以 `client` 是 `tx` 时平台作用域同样生效（探针：事务内 + 平台作用域 + tx 的扩展
拦截 scope 判定与普通 client 完全一致）。`platformSetting` **不在**
`TENANT_SCOPED_MODELS` 里，`tx.platformSetting.findUnique` 与现状语义一致。

### 5.5 payout-execution.service.ts

`resolvePayoutChannel(tx, payout)` 内部调 `this.settings.getPayoutDefaultChannel()`，把 `tx` 透传下去：

```ts
// platform-setting.service.ts
async getPayoutDefaultChannel(
  client: PrismaTransaction | TenantPrismaService = this.prisma,
): Promise<{ channel: string | null }> {
  return this.readPayoutDefaultChannel(client);
}
```

**⚠️ 顺带记录一个不对称**（不改代码，写进注释）：`payout.service.ts` 的 `approve()` 已经把渠道解析放在事务外（注释明写「解析放在事务外面」），而执行路径 `claimForExecution` 放在事务里 —— 这个不对称本身是缺陷，本次只统一「不借第二条连接」，不调整解析位置（那是阶段 6 的语义，动它风险高）。

### 验证

```bash
cd api && npx jest src/modules/billing src/modules/payment --runInBand && npx tsc --noEmit
cd api && npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/scan-tx-boundary.ts
```

预期：扫描输出**只剩豁免清单里的平台券那一处**。

---

## Task 6：撤掉 CI 的规避配置并验证

**Files:**
- Modify: `.github/workflows/ci.yml`

### Step 1：撤掉

删掉 e2e job 的：

```yaml
# ⚠️ **必须显式放大连接池**：...（阶段 10 已修根因，这行撤掉）
DATABASE_URL: ...&connection_limit=20&pool_timeout=20
DATABASE_URL_TEST: ...&connection_limit=20&pool_timeout=20
```

以及：

```yaml
PRISMA_TX_TIMEOUT_MS: '30000'
```

**恢复成与 api job 一致的连接串**（不带连接池参数）。

### Step 2：本地验证并发用例

```bash
cd api && npx jest --config test/jest-e2e.json --runInBand test/order.e2e-spec.ts test/order-discount.e2e-spec.ts test/payout.e2e-spec.ts
```

**⚠️ 这一步是本阶段的核心验证**：撤掉参数后并发用例必须仍然通过。

### Step 3：本地全量 e2e

```bash
cd api && npm run test:e2e
```

预期：663/663。

### Step 4：推送并确认 CI

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api.mjs main main
```

然后 `gh run watch <run-id>`，确认六个 job 全绿（**特别是 e2e 在默认连接池下通过**）。

---

## Task 7：验收记录与文档

**Files:**
- Create: `docs/superpowers/plans/2026-11-04-plan-10-acceptance.md`
- Modify: `README.md`（技术债清单、测试条数）
- Modify: `AGENTS.md`（新增「事务边界」纪律）

### Step 1：写验收记录

至少包含：

```markdown
# 阶段 10 验收记录

> 日期：2026-11-04
> 设计：docs/superpowers/specs/2026-11-04-plan-10-tx-boundary-design.md

## 一、完成范围
（逐条列出 T1–T7 与 9 个根因点的修法）

## 二、验证结果
- 扫描器输出：<实测>（应只剩豁免项）
- api 单测：<实测> 条 / <实测> 套件
- api e2e：<实测> 条 / <实测> 套件
- CI：<run id>，撤掉 connection_limit 与 PRISMA_TX_TIMEOUT_MS 后六个 job 全绿

## 三、已知限制
- 事务内 `now()` 是事务开始时刻，与事务外取有 ≤30s 偏差（财务口径字段已注明）。
- 跨副本分布式锁仍未做。

## 四、与设计的偏差
1. **设计 §4.3「平台券查询无法走 tx」被实测推翻**。探针证实 Prisma 6 的扩展会应用到
   交互事务客户端，平台作用域在 tx 上完全生效；`coupon.service.ts:529/535` 已有先例。
   因此 9 个根因全部修掉，**豁免清单为空**（原计划有 1 条豁免）。
```

### Step 2：更新 README 与 AGENTS.md

README 的「阶段 8 之后的剩余技术债」里，如果提到了连接池/事务相关条目，更新为已闭环；测试条数按实测更新。

AGENTS.md 新增一条纪律：

```markdown
- **事务回调内不许借第二条连接**：`$transaction(async (tx) => ...)` 独占一条连接，
  回调内（含经方法转调）用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
  改法：方法接受可选 client 参数，事务内传 `tx`。
  护栏：`api/src/common/db/tx-boundary-scanner.spec.ts` 全仓扫描，
  豁免项必须写明理由。跑 `npm run scan:tx-boundary` 看当前清单。
```

### Step 3：提交

```bash
git add docs/superpowers/plans/2026-11-04-plan-10-acceptance.md README.md AGENTS.md
git commit -m "docs: 记录阶段 10 验收结果与事务边界纪律"
```

---

## 波次与依赖

| 波次 | 任务 | 并行性 |
|------|------|--------|
| 1 | T1（检测器与护栏） | 单独 —— 它是后续所有任务的验证工具 |
| 2 | T2 / T3 / T4 / T5 | 可并行 —— 文件集互不重叠（coupon / billing+order / cart / billing+payment+common） |
| 3 | T6（撤配置 + 验证） | 单独 —— 需要波次 2 全部完成 |
| 4 | T7（文档与验收） | 单独 —— 需要 T6 的实测数字 |

⚠️ **T3 与 T5 都改 `api/src/modules/billing/` 下的文件**（`subscription/quota` vs `invoice/payout`）——
文件不重叠，但**同属一个目录**，并行时注意不要各自跑 `git add` 整个目录。

---

## 验收标准（汇总）

- 扫描器输出**零借用点**（豁免清单为空）。
- 护栏单测全绿；新增违规会让 CI 红。
- api 单测、tsc、lint 全绿。
- 本地全量 e2e 通过。
- **CI 撤掉 `connection_limit=20` 与 `PRISMA_TX_TIMEOUT_MS` 后，e2e job 仍然全绿** —— 根因修复的硬证据。
- 验收记录写明平台作用域查询的实测结论与连接池容量建议。
