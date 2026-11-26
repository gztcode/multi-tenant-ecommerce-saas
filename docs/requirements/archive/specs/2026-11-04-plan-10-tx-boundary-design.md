# 阶段 10「事务边界与连接池收口」设计

> **日期**：2026-11-04
> **起点**：阶段 9 把 e2e 纳入 CI 后，在 GitHub 2 核 runner 上稳定复现出并发下单失败。
> **目标**：消除「事务回调内借第二条连接」这一类缺陷，让并发写路径不再依赖连接池大小。

---

## 一、问题的来源

### 1.1 实测现象

阶段 9 的 e2e job 前两轮连续失败，失败用例全部是**并发写路径**：

| 轮次 | 报错 | 失败用例 |
|------|------|---------|
| 1、2 | Prisma `P2028` | `order.e2e-spec` 的并发幂等、`order-discount.e2e-spec` 的并发用券、`payout.e2e-spec` 的 D7 |
| 3 | Prisma `P2024` | 同上（放宽事务超时后暴露出来） |

- `P2028`：`Transaction already closed ... timeout for this transaction was 10000 ms`
- `P2024`：`Timed out fetching a new connection from the connection pool (Current connection pool timeout: 10, connection limit: 5)`

本机（M 系列多核）全量 e2e **663/663 通过**，单文件重跑也通过 —— 只有 2 核 runner 上必现。

### 1.2 两个叠加的成因

**成因一：交互事务独占连接，回调内部又借了一条。**

Prisma 的 `$transaction(async (tx) => ...)` 会**占住一条连接**直到回调返回。若回调内部（直接或经方法转调）用了 `this.prisma` 这个**非事务客户端**，那次查询就要**再借一条连接**。

GitHub runner 是 2 核，Prisma 默认连接池 = `CPU × 2 + 1` = **5**。而并发用例一次发 5 个请求：

```
请求1: 占事务连接(1) → 内部查券再借连接(2)
请求2: 占事务连接(3) → 内部查券再借连接(4)
请求3: 占事务连接(5) → 内部查券 → 池空 → 等 10 秒 → P2024
```

本机核多 → 池约 21 条 → 永远打不满 → 复现不出来。

**成因二：事务预算被行锁排队吃掉。**

并发下单会在同一行 SKU 上排队等锁，5 个请求串行化后，最后一个事务开始执行时已经过去 10 秒 → `P2028`。

### 1.3 阶段 9 的临时处置与它的不足

阶段 9 做了两处**参数层面**的处置：

- `PRISMA_TX_TIMEOUT_MS=30000`（仅 CI e2e job）
- `DATABASE_URL_TEST` 加 `connection_limit=20&pool_timeout=20`（仅 CI e2e job）

这两处让 CI 变绿，但**没有解决缺陷本身**：

- 生产环境的连接池大小取决于部署规格（CPU 核数），不是我们能假设的。**核少的机器上同样的代码会失败**。
- 参数越大，越掩盖问题而不是消除问题：真正的修法是「一个事务只占一条连接」。

阶段 10 的任务就是把它修掉。

---

## 二、范围与排除

### 2.1 本轮做

| 编号 | 内容 |
|------|------|
| T1 | 建立**可复用的静态检测器**，把「事务回调内借非事务连接」变成可自动发现的问题 |
| T2 | 修掉检测器报出的**全部 9 个根因点** |
| T3 | 把检测器固化成**回归护栏**（单测），防止新代码再犯 |
| T4 | 撤掉阶段 9 的**参数层面规避配置**（CI 的 `connection_limit=20` 与 `PRISMA_TX_TIMEOUT_MS`），验证并发用例靠根因修复而绿 |

### 2.2 明确不做

- **跨副本分布式锁**：与本阶段无关，仍是阶段 9 排除项。
- **把所有 `$transaction` 改成显式 `BEGIN/COMMIT`**：交互事务的语义（回调抛错自动回滚）正是我们要的。
- **连接池参数调优（`connection_limit` 生产取值）**：属于部署规格决策，本阶段只保证「代码不依赖池的大小」。
- **重构 service 分层**：本阶段只解决「事务边界」这一个维度，不顺手改架构。

---

## 三、审计结果

### 3.1 方法

两条独立路径互相印证：

1. **人工追踪调用链**：并行审计 6 个模块，每条发现再由独立 agent 复核（默认怀疑、逐条读代码验证）。
2. **静态检测器**：`api/src/common/db/tx-boundary-scanner.ts`，用 TypeScript 类型信息构建全局调用图，追踪事务回调 → 方法转调 → `this.prisma`。

两条路径的结论**完全吻合**，检测器因此可信。

### 3.2 根因清单（9 个）

| # | 文件:行 | 借用点 | 调用链 | 所在事务 |
|---|----------|--------|--------|---------|
| 1 | `coupon/coupon.service.ts:886` | `this.prisma` | `createOrderInTx` → `coupon.computeForOrder` → `buildDiscountContext` | 下单 |
| 2 | `coupon/coupon.service.ts:890` | `this.prisma` | 同上（活动查询） | 下单 |
| 3 | `coupon/coupon.service.ts:1044` | `this.prisma` | 同上 → `findCandidateCoupons`（领取记录） | 下单 |
| 4 | `coupon/coupon.service.ts:1058` | `this.prisma` | 同上（店铺券） | 下单 |
| 5 | `coupon/coupon.service.ts:1072` | `this.prisma` | 同上（平台券） | 下单 |
| 6 | `coupon/coupon.service.ts:1092` | `this.prisma` | 同上（已用掉的券） | 下单 |
| 7 | `billing/subscription.service.ts:39,62` | `this.prisma` | `createOrderInTx` → `billing.canAcceptOrders` → `current` / `databaseNow` | 下单 |
| 8 | `billing/quota.service.ts:40,46` | `this.prisma` | `createOrderInTx` → `quota.currentPlan` | 下单 |
| 9 | `cart/cart.service.ts:310` | `this.prisma` | `removeUnsellableItems` → `findSellableSkuIds` | 购物车合并 |
| 10 | `billing/invoice.service.ts:168` | `this.prisma` | `markInvoicePaid` → `markInvoicePaidInTx` → `databaseNow` | 账单付清 |
| 11 | `payment/payment.service.ts:863` | `this.prisma` | `applyEventInTx` | 支付事件 |
| 12 | `payment/payment.service.ts:1509` | `this.prisma` | 回调内实参 `databaseNow()` | 退款 |
| 13 | `common/platform-settings/platform-setting.service.ts:98` | `this.prisma` | `resolvePayoutChannel` → `settings.getPayoutDefaultChannel` → `readPayoutDefaultChannel` | 出款执行 |

> 表里按「借用点」列 13 行、按「根因」列 9 个（多个借用点共享同一处修改）。

### 3.3 风险分级

| 等级 | 根因 | 说明 |
|------|------|------|
| **高** | 1–8（下单链路） | 每次下单都触发；并发下单是最高频的写路径。CI 已复现失败 |
| **中** | 9、10、11、12、13 | 购物车合并 / 账单付清 / 支付事件 / 退款 / 出款执行。频率低，但同样会在低配机器上打满池 |

---

## 四、修复方案

### 4.1 统一手法：让方法接受「可选的客户端参数」

仓库里**已经有这个模式**：`coupon.service.ts` 的

```ts
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

且同文件 412 行的事务内调用**已经是正确用法**（传 `tx`）。也就是说：**「事务内走 tx」在这个仓库不是新发明，是同一文件内的写法不统一**。

本阶段沿用这个模式，统一为：

```ts
async 方法名(参数..., client: PrismaTransaction | TenantPrismaService = this.prisma)
```

**默认参数是 `this.prisma`**，所以：
- 事务外的既有调用点**一行都不用改**；
- 事务内的调用点显式传 `tx`。

### 4.2 逐个根因的修法

| # | 修法 | 注意 |
|---|------|------|
| 1–6 | `coupon.service.ts`：`buildDiscountContext` / `findCandidateCoupons` 增加 `client` 参数，内部改用 `client`；`computeForOrder` 透传 | 平台券那段用了 `tenantContext.run(platformScope(), ...)` —— **写法保留**，只把里面的 `this.prisma` 换成 `client`（tx 带租户扩展，实测见 4.3） |
| 7 | `subscription.service.ts`：`current` / `canAcceptOrders` 增加 `client` 参数 | `databaseNow()` 在 `client` 是 `tx` 时要用 `tx.$queryRaw`（`coupon.service.ts:412` 有先例） |
| 8 | `quota.service.ts`：`currentPlan` 增加 `client` 参数 | 同上 |
| 9 | `cart.service.ts`：`findSellableSkuIds` 增加 `client` 参数 | `removeUnsellableItems` 已经收 `tx` 了，只是没往下传 |
| 10 | `invoice.service.ts`：`markInvoicePaidInTx` 内部改用 `tx` 取时钟 | **不改签名**（它是 public，注释明说要给将来复用）。注意 `tx` 上的 `now()` 是事务开始时刻，与事务外取有极小偏差（≤30s），`paidAt` 属财务口径，需在注释里写明 |
| 11 | `payment.service.ts`：`applyEventInTx` 内部改用 `tx` | 同 10 |
| 12 | `payment.service.ts`：退款事务里 `await this.prisma.databaseNow()` 改为在事务**外**先取（它是纯读时钟，语义上属于「事件发生时刻」，放在事务外更准） | 移到事务外不影响正确性 |
| 13 | `platform-setting.service.ts`：`readPayoutDefaultChannel` 增加 `client` 参数 | **只搬读动作、不能漏掉校验**（`assertChannelUsable` 与 env 兜底）。另外 `payout.service.ts` 的 `approve()` 已经把渠道解析放在事务外（注释明写「解析放在事务外面」），执行路径却放在事务里 —— 这个不对称本身就是缺陷 |

### 4.3 平台作用域查询：可以走事务客户端（实测修订）

> ⚠️ **本节是对初稿的实测修订**。初稿曾断言「事务客户端 `tx` 没有租户扩展，
> 平台作用域查询无法走 tx」，并据此把它列为显式豁免项。**这个断言是错的**，
> 已被下面的实测推翻。

**实测结论**（探针脚本，用真库跑 Prisma 6）：

Prisma 6 的 `defineExtension` 扩展**会应用到交互事务客户端**。在事务回调内用
`tx.coupon.findMany(...)` 时，扩展照样拦截、照样按上下文解析作用域：

| 场景 | 扩展拦截到的 scope | where |
|------|-------------------|-------|
| 事务内 + 租户上下文 + `tx` | `{ kind: 'tenant', where: { tenantId } }` | 与普通 client 相同 |
| 事务内 + 平台作用域 + `tx` | `{ kind: 'platform' }` | 与普通 client 相同 |
| 事务内 + 平台作用域 + 普通 client | `{ kind: 'platform' }` | 与普通 client 相同 |

**代码既有先例**：`coupon.service.ts` 的 `findClaimableCoupon`（529/535 行）
**已经在用 `tx.coupon.findFirst` / `tx.coupon.findMany` 查平台券** ——
「平台作用域走 tx」在本仓不是新发明，是现成的写法。

**结论**：初稿里「平台券查询必须留在事务外」的建议**不成立**，理由有两条：

1. 前提是错的（tx 有扩展）；
2. 即便前提成立，「移到事务外算好候选券」也会**削弱护栏 M5** ——
   候选券的判定必须基于**锁住 SKU 后的实时价**，事务外的价是旧的。

所以本轮**全部 9 个根因、15 处借用点都可以修掉，没有豁免项**。
`tenantContext.run(platformScope(), ...)` 的写法**原样保留**（它管的是上下文，
不是扩展），只把里面的 `this.prisma` 换成 `client`。


### 4.4 护栏：把检测器变成回归测试

新增 `api/src/common/db/tx-boundary-scanner.spec.ts`：

- 用**内联的小段源码**（不是整个仓库）喂给扫描器，断言它能报出预埋的违规、并放过合规写法；
- 再加一条**全仓扫描**的用例：扫 `src/` 全部文件，断言**没有借用点**。

豁免机制仍然保留（将来遇到真的绕不开的情况要用），但**当前清单为空** —— 本轮 9 个根因全部修掉。

豁免登记用一张显式清单 `api/src/common/db/tx-boundary-exemptions.ts`：

```ts
/**
 * 已知的、无法消除的借用点。
 *
 * ⚠️ **每条必须写 `why`** —— 护栏要让「没有理由的例外」无法存在。
 * ⚠️ **锚点用「文件 + 方法名 + 表达式」，不用行号**：
 *    行号会随任何改动漂移，豁免会莫名其妙失效（或误放行）。
 */
export const TX_BOUNDARY_EXEMPTIONS: readonly TxBoundaryExemption[] = [];
```

豁免条目**必须带 `why`**，将来有人想改它时，会先看到理由。

---

## 五、验收标准

1. `npm run scan:tx-boundary` 输出**零借用点**。
2. 护栏单测通过：预埋违规能被报出，合规写法不被误报；全仓扫描断言零违规。
3. api 单测全绿、tsc 全绿、lint 零错误。
4. **本地全量 e2e 通过**，且**并发用例不再依赖连接池大小**。
5. **撤掉 CI 的 `connection_limit=20` 与 `PRISMA_TX_TIMEOUT_MS=30000`** 后，CI 的 e2e job 仍然全绿 —— 这是「根因已修」的硬证据。
6. 验收记录写明平台作用域查询的实测结论与连接池容量建议。

---

## 六、风险与回滚

| 风险 | 缓解 |
|------|------|
| 改 `subscription.current` / `quota.currentPlan` 等**被多处调用**的方法签名 | 一律用**带默认值的可选参数**，既有调用点不需要改 |
| 事务内 `now()` 与事务外 `now()` 的语义差异（`tx` 上是事务开始时刻） | 财务口径字段（`paidAt`）在注释里写明；必要时改用 `clock_timestamp()` |
| 平台券查询无法走 `tx` | **实测已排除**：tx 带租户扩展（见 §4.3），平台作用域在 tx 上完全生效，`coupon.service.ts:529/535` 已有先例 |
| 护栏误报导致将来无法正常写代码 | 豁免清单可扩充，但**必须写 `why`** |
| 撤掉 CI 规避配置后 CI 又红 | 若仍红，说明根因没修干净 —— 这正是要验证的 |

---

## 七、与既有约定的关系

- **`AGENTS.md` 的「租户作用域模型上 `findUnique` 被拒绝」**：本阶段改到的 `platformSetting` **不在** `TENANT_SCOPED_MODELS` 里，`tx.platformSetting.findUnique` 与现状语义一致，不必改。
- **`AGENTS.md` 的「落库时刻用 `prisma.databaseNow()`」**：本阶段**不放宽**这条 —— 事务内用 `tx.$queryRaw('SELECT now()')` 取的仍是数据库时钟。
- **金额用整数分、金额口径不改**：本阶段不动任何金额逻辑。
