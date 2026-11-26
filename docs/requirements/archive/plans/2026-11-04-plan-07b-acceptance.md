# 阶段 7b「api 代码收口」验收记录

> 执行日期：2026-11-04 · 分支 `plan-07b07c-hardening` · 计划：`docs/superpowers/plans/2026-11-04-plan-07b-api-hardening.md`

## 一、交付范围

| 波次 | Task | 状态 | commit |
|---|---|---|---|
| 1 | T1 购物车合并事务化 + 批量化 + 补单测 | ✅ | `2148d98` |
| 1 | T2 setMedia 批量化 | ✅ | `2148d98` |
| 1 | T3 券分页 + P2002 收窄 | ✅ | `2148d98` |
| 1 | T4 对账单 DB 端归期 | ✅ | `2148d98` |
| 1 | T5 佣金分页 + byMerchant DB 聚合 | ✅ | `2148d98` |
| 2 | T6 currentTenantId 统一 | ✅ | `de9e271` |
| 2 | T7 isUniqueViolation 收敛 | ✅ | `de9e271` |
| 2 | T8 商家订单列表 itemCount | ✅（口径修正，见下） | `de9e271` |
| 2 | T9 日志收口 | ✅ | `de9e271` |

## 二、关键决策与计划偏离

### 1. T1 事务句柄用仓库现成的 `PrismaTransaction`

计划写 `tx?: Prisma.TransactionClient`，但 Prisma 的 `TransactionClient` 与本仓库的**扩展 client**（自动附加 tenantId 的 query extension）不兼容。改用 `common/prisma/prisma-transaction.ts` 里现成的 `PrismaTransaction`（仓库已有 11+ 处既有用法佐证）。`removeUnsellableItems` 的 `tx` 改为**必传**——从类型层面杜绝「事务外写入」回归。

### 2. T4 原生 SQL 收进专用 wrapper

`TenantPrismaService` 刻意不暴露 `$queryRaw`（防绕过租户隔离的后门）。对账单的「有哪些期」改成 `merchantReceiptPeriods(tenantId)` wrapper 里的参数化 `$queryRaw`（tenantId 走绑定参数，无注入风险），而不是在 service 里裸写 SQL。

### 3. T8 的 itemCount 口径：**计划的口径是错的，已弃用**

计划要求用 `include: { _count: { select: { items: true } } }` 补 itemCount，并称「后端从不返回该字段（恒 undefined）」。核实结论：

- `prisma/schema.prisma:535` 有 `itemCount Int` 列，`listMerchantOrders` 的 `findMany` **从未有过 select/omit** → 该列一直随列表接口返回，「恒 undefined」的前提不成立。
- 该列在 `order.service.ts:495` 写入，值是 `merged.reduce((sum, item) => sum + item.quantity, 0)` = **件数总和**；详情页（`merchant-admin/src/components/order/order-detail.tsx:169`）显示的「件数」也是这个口径。
- `_count.items` 是订单项**行数**：1 个 SKU × 数量 2 → 行数 1、件数 2。照计划改会让**列表页与详情页显示不同的数字**。

处置：**弃用 `_count` 覆盖**，列表直接用 DB 列，两处口径统一。真正交付的是回归断言（SKU-A×2 + SKU-B×1 → `itemCount` 为 3，并与详情条目件数交叉验证）——写死 2（行数）、写死 3、恒返回 1 三种错误实现都被挡住。

### 4. T6 定义点计数

计划说 16 个，实施代理报 18 个，复审实测 **15 个**（12 个 private `currentTenantId` + payment/subscription 两个 public 版 + merchant-statement 的 private `requireTenantId`）。三个数都不一样，但**全部定义点均已收敛**，调用点 56 处零改动。

### 5. T6 的 403 边界

service 层拿不到租户 → 统一 403「无法确定店铺」；**拦截器层的匿名 404 原文案不动**（`tenant-context.interceptor.ts:102`，e2e `tenant-isolation.e2e-spec.ts:167/183/195` 有精确断言）。`require-tenant.ts` 的注释把这条边界写明。

### 6. 「上下文完全缺失」不是 403

`getTenantContext()` 在 ALS 里完全没有 store 时抛普通 Error（→ 500，通常是队列消费者忘了 `runForTenant()`）。`requireTenantId()` 只管「上下文在、但没有 tenantId」→ 403。这个边界有单测钉住。

## 三、审查发现与修复

### Critical：LoggingInterceptor 未注册 provider → API 起不来

spec 审查发现 `main.ts` 用 `app.get(LoggingInterceptor)`，但该类没注册成 provider，`app.get()` 抛 `UnknownElementException`——**API 在启动阶段就死**，而单测/e2e 都不加载 `main.ts`，CI 跑不出来。

修复：注册进 `AppModule` 的 `providers`，`main.ts` 用 `app.get()` 取。已做**真实启动冒烟**（build → 起进程 → 健康检查 200 → 杀进程）。

### Important：4 处同模式漏网

`payout.service.ts`（cancel / availablePeriods / apply）与 `payout-account.service.ts`（get / set）里还有 5 处「拿不到租户上下文」抛 400/404 的旧写法，已全部收敛到 `requireTenantId()`（403）。`apply()` 里租户与用户是两个判断，拆开：租户缺失 → 403，用户缺失 → 400「缺少用户上下文」。

### Important：访问日志漏掉守卫拒绝与租户解析失败

全局拦截器**先注册的在外层**。原先 LoggingInterceptor 注册在租户拦截器之后 → 租户解析失败抛的 404 落在外层，内层根本没被订阅 → 完全没有日志。已把 Logging 挪到**第一位**（最外层），实测匿名请求 404 现在落日志。

**已知缺口**：守卫的 401/403 仍不落日志——Nest 的守卫在拦截器链**之外**执行，任何全局拦截器都盖不到。

### Minor 修正

- 错误日志只打**异常类名**不打原始 message（与 `AllExceptionsFilter` 的脱敏口径一致；原始 message 常含表名、SQL 片段、文件路径）。
- 删掉 `coupon.service.ts` 因波次 1 改动而失效的私有 `isUniqueViolation`（死代码）。
- `setMedia` 的 sort 重排去掉恒为单元素的 Map 分组（数组下标不可能重复）。
- `inventory.service.ts` 的 import 格式与引号回归 prettier。

## 四、验证结果

| 项 | 结果 |
|---|---|
| `npm test`（api 单测） | 51 suites / **907 passed**（3 skipped；基线 886 + 新增 21） |
| `npm run test:e2e`（串行） | 40 suites / **657 passed** |
| `npx tsc --noEmit` | 0 错误 |
| 真实启动冒烟 | `Nest application successfully started` + 健康检查 200 + `[HTTP] GET /api/v1/health 200 4ms` |

**e2e 必须串行跑**（`--runInBand`）：并行时多个套件共享同一个测试库，会互相干扰（billing-report / payout-encryption / payout-execution / token-grace 会红）。这是既有问题，与本阶段无关；CI 只跑单测。

### 手测（真实 HTTP 链路，重建后的 api 容器上）

| 场景 | 结果 |
|---|---|
| 注册顾客 → NextAuth credentials 登录 | 302 + session cookie；`/api/auth/session` 返回 accessToken / role=CUSTOMER / tenantId |
| 令牌刷新 + 宽限期重放 | 同一枚 refresh token 连刷两次**都成功**（阶段 5c 的宽限期语义：多标签页不互相踢下线） |
| 登出 | 204；登出后同一 refresh token 刷新 → `刷新令牌无效或已过期` |
| 商家券列表分页 | `page=1&pageSize=2` → 2 条 / total 3；`page=2` → 1 条 / total 3；`page=999&pageSize=999` → 0 条 / total 3（超范围被 clamp） |
| 访问日志 | 容器日志有 `[HTTP] GET /api/v1/merchant/coupons?page=1&pageSize=2 200 5ms` 形态的行 |

⚠️ **登出只吊销 refresh token**（接口注释即如此写），access token 在其 TTL 内仍可用——JWT 无状态，吊销需要黑名单，本阶段未引入。

## 五、⚠️ 手测时踩的坑：容器跑的是旧镜像

第一次手测券列表分页时，`pageSize=2` 却返回全部 3 条——查下来是**容器里的 api 还是两天前的旧镜像**，本阶段的 api 改动（分页、`requireTenantId`、日志拦截器）一行都没生效。

**教训**：改了 api 代码后必须 `docker compose build api && docker compose up -d api` 再手测，否则测的是旧代码。本地 `npm test` / `npm run test:e2e` 跑的是工作区代码（是新的），**容器跑的是镜像里的旧代码**——两者不一致时永远以容器为准去查。

同理，这个坑也解释了为什么「LoggingInterceptor 未注册 provider」在本地与 CI 都跑不出来：容器是旧镜像，CI 只跑单测不加载 `main.ts`。

## 六、已知限制

- 守卫的 401/403 不进访问日志（Nest 拦截器链的结构性限制）。
- `Order.itemCount` 是下单时的快照（件数总和），订单项若事后变更不会回写——订单项本身当前无修改路径。
- e2e 并行跑会互相干扰，只能串行。
