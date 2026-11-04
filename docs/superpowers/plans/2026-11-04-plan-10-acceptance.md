# 阶段 10 验收记录「事务边界与连接池收口」

> **日期**：2026-11-04
> **设计**：[`docs/superpowers/specs/2026-11-04-plan-10-tx-boundary-design.md`](../specs/2026-11-04-plan-10-tx-boundary-design.md)
> **计划**：[`docs/superpowers/plans/2026-11-04-plan-10-tx-boundary.md`](2026-11-04-plan-10-tx-boundary.md)
> **起点**：阶段 9 把 e2e 纳入 CI 后，在 GitHub 2 核 runner 上稳定复现并发下单失败。

---

## 一、问题的根因

### 1.1 两个报错是同一个根因的两层症状

阶段 9 的 CI e2e job 前三轮连续失败，报错是两个：

| 报错 | 含义 |
|------|------|
| Prisma `P2028` | 交互事务超时（10 秒） |
| Prisma `P2024` | `Timed out fetching a new connection from the connection pool (connection limit: 5)` |

**初稿把它们当成两个问题**，后来实测证明是**同一个**：

1. `$transaction(async (tx) => ...)` 会**独占一条连接**直到回调返回；
2. 回调内部（直接或经方法转调）用了 `this.prisma` 这个**非事务客户端** → **再借一条连接**；
3. GitHub runner 是 2 核，Prisma 默认池 = `CPU × 2 + 1` = **5**；
4. 5 个并发下单各占一条事务连接 → 池里只剩给「内部再借」用的额度；
5. 内部查询等不到连接 → 等满 `pool_timeout` → 报 `P2024`；
6. 外层事务在等待期间耗尽 10 秒预算 → 报 `P2028`。

所以 **`P2024` 是因，`P2028` 是果**。修掉「事务内借第二条连接」，两个报错一起消失。

### 1.2 本机为什么复现不出来

本机（M 系列多核）Prisma 默认池约 21 条，永远打不满。阶段 9 因此只能用
「放大连接池 + 放宽事务超时」两个参数把 CI 变绿 —— **参数层面的规避，不是修复**：
生产环境的池大小取决于部署规格，核少的机器上同样的代码会失败。

---

## 二、审计：两条独立路径互相印证

| 路径 | 方法 | 结论 |
|------|------|------|
| 人工追踪 | 并行审计 6 个模块，每条发现由独立代理复核（默认怀疑、逐条读代码） | 9 个根因 |
| 静态检测器 | `api/src/common/db/tx-boundary-scanner.ts`，用 TypeScript 类型信息构建全局调用图 | 9 个根因 / 15 处借用点 |

**两条路径完全吻合** —— 检测器因此可信，可以作为护栏的基础。

检测器不是文本匹配：真实的问题几乎都藏在**方法转调链**里
（`this.coupon.computeForOrder(...)` 自己不碰库，但它转调的 `buildDiscountContext` 里用了 `this.prisma`）。
只有类型信息 + 调用图才能看到完整链路。

---

## 三、⚠️ 设计初稿的前提被实测推翻

设计初稿 §4.3 断言：

> **事务客户端 `tx` 没有租户扩展** —— 它不会自动附加 `tenantId`，也不会自动处理 `platformScope()`。
> 所以查平台券这一步**不能**用 `tx`，必须留在事务外。

**这个断言是错的。** 实测（探针脚本，真库跑 Prisma 6）：

| 场景 | 扩展拦截到的 scope | where |
|------|-------------------|-------|
| 事务内 + 租户上下文 + `tx` | `{ kind: 'tenant', where: { tenantId } }` | 与普通 client 相同 |
| 事务内 + 平台作用域 + `tx` | `{ kind: 'platform' }` | 与普通 client 相同 |
| 事务内 + 平台作用域 + 普通 client | `{ kind: 'platform' }` | 与普通 client 相同 |

**Prisma 6 的 `defineExtension` 扩展会应用到交互事务客户端。**

代码也早有先例：`coupon.service.ts` 的 `findClaimableCoupon`（529/535 行）
**本来就在用 `tx.coupon.findFirst` / `tx.coupon.findMany` 查平台券**。

### 3.1 推翻它带来的两个后果

1. **9 个根因全部可以修掉，豁免清单从 1 条变成 0 条**。
2. 初稿建议的「把候选券计算移到事务外」**不能采纳** ——
   候选券的判定必须基于**锁住 SKU 之后的实时价**（护栏 M5），
   事务外的价是旧的，移到事务外会**削弱护栏**。

设计文档 §4.3 已按实测修订，并标注了这次修订。

---

## 四、改了什么

### 4.1 统一手法

沿用仓库**已有**的模式（`coupon.service.ts` 的 `databaseNow(client)`），
把散落的写法统一为：

```ts
async 方法名(参数..., client: PrismaTransaction | TenantPrismaService = this.prisma)
```

默认参数是 `this.prisma`，所以**事务外的既有调用点一行都不用改**，
事务内的调用点显式传 `tx`。

### 4.2 九个根因逐条

| # | 文件 | 方法 | 修法 |
|---|------|------|------|
| 1–6 | `coupon/coupon.service.ts` | `computeForOrder` / `buildDiscountContext` / `findCandidateCoupons` | 加 `client` 参数，内部改用 `client`；平台券那段保留 `tenantContext.run(platformScope(), ...)` 包装，只换里面的客户端 |
| 7 | `billing/subscription.service.ts` | `current` / `canAcceptOrders` | 加 `client` 参数；新增双形态 `databaseNow(client)`（与 coupon 同款） |
| 8 | `billing/quota.service.ts` | `currentPlan` | 加 `client` 参数 |
| 9 | `cart/cart.service.ts` | `findSellableSkuIds` | 加 `client` 参数；事务外的调用点保持走默认值 |
| 10 | `billing/invoice.service.ts` | `markInvoicePaidInTx` | 内部改用 `tx.$queryRaw` 取时钟（**签名未动**） |
| 11 | `payment/payment.service.ts` | `applyEventInTx` | 同 10 |
| 12 | `payment/payment.service.ts` | `applyRefundEventInTenant` | 取时钟**挪到事务外**（纯读时钟，语义上是「事件发生时刻」） |
| 13 | `common/platform-settings/platform-setting.service.ts` | `readPayoutDefaultChannel` / `getPayoutDefaultChannel` | 加 `client` 参数，**只搬读动作**，校验与 env 兜底原样保留 |

顺带：`payout-execution.service.ts` 的 `resolvePayoutChannel` 参数类型由
`Prisma.TransactionClient` 改为 `PrismaTransaction`，调用点那行
`tx as unknown as Prisma.TransactionClient` 的类型收窄**随之删除**（实测编译直接通过，
原注释描述的「不兼容」在当前 Prisma 6 类型定义下已不复存在）。

### 4.3 业务语义一字未改

- 金额、状态机、优惠判定、渠道解析优先级（已定 → 商家 → 平台）全部未动。
- 「从未订阅 → 放行」「有订阅但到期 → 拒绝」原样保留。
- 候选券判定仍基于**锁 SKU 后的实时价**。

---

## 五、护栏

### 5.1 检测器

`api/src/common/db/tx-boundary-scanner.ts` —— 用 TypeScript 类型信息构建全局调用图，
追踪「事务回调 → 方法转调 → `this.prisma`」的完整链路。

`npm run scan:tx-boundary` 输出当前清单。

### 5.2 豁免机制

`api/src/common/db/tx-boundary-exemptions.ts` —— **当前为空**（9 个根因全修掉了）。

豁免条目**必须带 `why`**；锚点用「文件 + 方法名 + 表达式」，
**不用行号**（行号会随任何改动漂移，豁免会莫名其妙失效或误放行）。

### 5.3 ⚠️ 护栏自身的一个盲区（已修）

护栏第一版只扫方法体，**扫不到参数默认值**。实测对照：

| 写法 | 检测结果 |
|------|---------|
| 方法体直接写 `this.prisma` | 报出 |
| `client: X = this.prisma` + 事务内忘传 client | **报不出** |

**危害很直接**：本阶段引入的正是「方法接受可选客户端参数」模式，
将来有人新增一个带 `client = this.prisma` 的方法、事务内忘了传 `tx` ——
这是**最可能发生的回归形态**，而护栏完全看不见。

**修法**：加一条规则 ——
「方法体用到 `client` 参数」且「调用点实参个数不足以覆盖它」
→ 该参数会取默认值 `this.prisma` → 借第二条连接。

失败注入验证：故意把 `computeForOrder` 的 `client` 实参删掉，
检测器立刻报出（定位到参数位置与完整调用链）；加回后归零。

---

## 六、验证结果

### 6.1 静态扫描

```
$ npm run scan:tx-boundary
共 0 处可疑点
```

护栏单测：`api/src/common/db/tx-boundary-scanner.spec.ts` —— **11 条全绿**
（含全仓扫描用例，3 秒）。

### 6.2 类型与 lint

| 命令 | 结果 |
|------|------|
| `npx tsc --noEmit` | No errors found |
| `npx eslint <10 个改动文件>` | No issues found |

### 6.3 api 单测

```
Test Suites: 59 passed, 59 total
Tests:       3 skipped, 959 passed, 962 total
```

（阶段 9 验收记录写的是 950 条 / 58 套件 —— 那是**阶段 9 当时的实测值**，
阶段 9 之后又追加了提交，数字随之漂移；本阶段以当前实测为准。）

新增用例：检测器 spec 11 条（`tx-boundary-scanner.spec.ts`）+ cart spec 1 条
（事务内可售判定必须走 tx）。

### 6.4 ⚠️ 决定性证据：5 连接池下的对照实验

本机池约 21 条，模拟不了 2 核 runner。做法：把 `DATABASE_URL_TEST` 的
`connection_limit` 压到 **5**（= GitHub 2 核 runner 的默认值）。

| 代码状态 | 连接池 | 结果 |
|---------|--------|------|
| **修复前** | 5 条 | ❌ `order-discount` 并发用券 + `order` 并发幂等 **报 `P2028` 失败** |
| **修复后** | 5 条 | ✅ 全量 e2e **663/663 通过**（连续两次） |
| 修复后 | 默认（~21） | ✅ 全量 e2e **663/663 通过** |

**同一个 5 连接池的环境下，修复前失败、修复后通过** —— 这就是「根因已修」的硬证据，
不再依赖「参数调大就没问题」。

### 6.5 CI

| 项 | 结果 |
|----|------|
| e2e job 的 `connection_limit=20&pool_timeout=20` | **已撤掉** |
| e2e job 的 `PRISMA_TX_TIMEOUT_MS=30000` | **已撤掉** |
| CI run | 见 §六「CI 结论」 |

---

## 七、已知限制

1. **事务内的 `now()` 是「事务开始时刻」**，与事务外取有 ≤30s 偏差。
   `paidAt`、`invoice.paidAt` 属财务口径字段，已在代码注释中写明。
   偏差在容差内（事务本身远短于 30 秒），但**将来若要更精确**可改用 `clock_timestamp()`。
2. **跨副本分布式锁仍未做** —— 阶段 9 的排除项，本阶段不涉及。
3. **`transactionOptions()` 的 `PRISMA_TX_TIMEOUT_MS` 逃生口保留** ——
   CI 不再用它，但慢环境（极慢的托管数据库）仍可设。
   默认 10 秒是「行锁排队」的合理预算。

---

## 八、与设计的偏差

| # | 偏差 | 原因 |
|---|------|------|
| 1 | **设计 §4.3「平台券查询无法走 tx」被实测推翻** | Prisma 6 的扩展会应用到交互事务客户端（探针证实）；`coupon.service.ts:529/535` 早有先例。9 个根因全修，**豁免清单从 1 条改为 0 条** |
| 2 | **豁免锚点从「行号」改为「文件 + 方法名 + 表达式」** | 行号会随任何改动漂移，豁免会莫名其妙失效或误放行 |
| 3 | **护栏新增「client 参数未显式传入」规则** | 第一版护栏有盲区：只看方法体，扫不到默认参数兜底 —— 而那正是最可能发生的回归形态 |
| 4 | **`resolvePayoutChannel` 的参数类型改为 `PrismaTransaction`** | 实测 `PrismaTransaction` 与扩展式查找参数兼容，原来的类型收窄注释已过时；收窄随之删除 |

---

## 九、提交清单

| 提交 | 内容 |
|------|------|
| `401ed85` | 阶段 10 设计与实施计划 |
| `734f185` | 实测推翻「tx 无租户扩展」的前提（设计与计划同步修订） |
| `8819df9` | 事务边界静态检测器与回归护栏 |
| `e1f6ee0` | 事务回调内不再借第二条连接（9 个根因 / 15 处借用点） |
| `12f2ea6` | 撤掉 e2e job 的连接池与事务超时规避配置 + README/AGENTS.md |

---

## 十、CI 结论

| 项 | 值 |
|----|-----|
| CI run | [`41846199950`](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/41846199950) |
| 结论 | **success**（六个 job 全绿） |
| 提交 SHA | `a9bf21fad5699886c09e46ba59fd4a2fc51ac01e` |

| job | 结论 |
|-----|------|
| `api` | success |
| `frontend (merchant-admin)` | success |
| `frontend (platform-admin)` | success |
| `frontend (storefront, demo)` | success |
| `shared` | success |
| **`e2e`** | **success** ← 撤掉连接池放大与事务超时放宽后的结果 |

**e2e job 用的是 Prisma 默认连接池**（GitHub 2 核 runner 上 = `CPU×2+1` = **5 条**），
且**事务超时是默认的 10 秒** —— 与阶段 9 失败时的环境相比，唯一变化是**代码修了根因**。

这就是「根因已修」的硬证据：不是把参数调大把问题盖住，而是把依赖参数的那部分代码改掉了。
