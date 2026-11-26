# 阶段 8「部署韧性、鉴权与资金正确性」设计

> **日期**：2026-11-04
> **前置**：阶段 7（7a 工程基建 / 7b api 代码收口 / 7c 前端共享包）全部完成并推送 main。
> **输入**：阶段 7 之后的三路全仓库审查（api 后端 / 三个前端 / infra 与工程），
> 逐条实测核实后的 18 条问题清单。
> **执行方式**：agent-team 波次并行（按无共享文件分组拆波次，每波并行派实施代理；
> 代理不提交、只跑定向测试；两轮审查顺序不变但跨 Task 并发）。

---

## 一、背景与目标

阶段 7 修的是「工程基建」与「代码重复」，但审查发现三类**仍然存在**的问题：

1. **部署形态有功能性缺陷**：Nginx 把店铺子域名下的 `/api/**` 全部抢给后端，
   而 storefront 自己的 BFF 路由恰好也在 `/api/**` —— **经网关访问时购物车、
   登录、下单整体 404**。直连 `:3001` 一切正常，所以此前手测没暴露。
2. **安全校验形同虚设**：`assertSecureConfig` / `assertPayoutEncryptionKey`
   的占位符常量与 compose 内置默认值**不是同一个串**，用 compose 默认密钥
   在 `NODE_ENV=production` 下**能正常启动**——提交进 git 的固定密钥可直接投产。
3. **资金与并发正确性缺陷**：购物车加购是「读-改-写」会丢增量；
   续费扫描单租户异常中断整批、扣款与结算分离导致同一账期可能重复扣款；
   渠道交易号绑定的 where 缺 `provider` 且忽略影响行数。

**目标**：把这三类高危问题修掉，同时收编审查出的健壮性与工程债
（分页夹取、前端错误态/竞态、CI 加固、备份、依赖卫生）。

**坚持既有形态**：不引入 TLS / secret manager / 新容器 / 队列重设计；
platform-admin 只补令牌刷新链路，**不**改造 22 处中转路由的判空写法（延后到阶段 9）。

---

## 二、里程碑划分

| 里程碑 | 主题 | 并行度 | 落点 |
|--------|------|--------|------|
| **8a** | 部署与鉴权（Nginx / 生产密钥守卫 / platform-admin 刷新） | 低——infra 与 auth 有共享文件，单代理串行 | `infra/`、`platform-admin/src/auth.ts` |
| **8b** | 资金与并发正确性（购物车原子加购 / 续费幂等 / 交易号绑定） | 中——三处 api 文件独立，可并行 | `api/src/modules/{cart,payment}` |
| **8c** | 健壮性与工程债（分页 / 前端错误态与竞态 / CI / 备份 / 依赖） | 高——api / 前端 / infra 三域互不重叠 | 全仓 |

每个里程碑独立验收；阶段末统一做全量回归（api 单测 + e2e、三端 test/tsc/build、
镜像构建、真实链路手测）。

---

## 三、8a 部署与鉴权

### 3.1 Nginx 路径收口

**根因**：`infra/nginx/platform.test.conf:64` 的 `location /api/` 属于**最长前缀匹配**，
把店铺子域名下的 `/api/cart`、`/api/auth/[...nextauth]` 等 BFF 路由全部代理给
`api_backend`；而后端全局前缀是 `/api/v1`，这些请求在后端不存在 → 404。

**实测证据**（本机运行中的容器）：

| 请求 | 直连 `:3001` | 经 Nginx `demo.platform.test` |
|---|---|---|
| `/api/cart` | 200 | **404** |
| `/api/auth/session` | 200 | **404** |
| `/api/v1/health` | —— | 200 |

**修法**：`location /api/` → `location /api/v1/`。`/api/` 归还给 storefront 的
Next.js Route Handler；后端只在自己的版本前缀下被代理。

- 另外三个 server 块（`api.` / `merchant.` / `admin.`）只有 `location /`，无冲突，不动。
- 验证：经网关 `/api/cart`、`/api/auth/session` 返回 200；`/api/v1/health` 仍 200；
  直连行为不变；商品详情/搜索/结算页正常。

### 3.2 生产密钥守卫

**根因**：两个守卫做**字面等值比较**，但比较目标与 compose 内置默认值不是同一个串：

- `api/src/common/config/assert-secure-config.ts:9` 的 `PLACEHOLDER_SECRET`
  只等于 `api/.env.example` 里的值；
- `api/src/common/config/assert-payout-encryption-key.ts:11-12` 的 `PLACEHOLDER_KEY`
  同理；
- compose 的 `JWT_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 默认值是**另一个串**。

实测：`NODE_ENV=production` + compose 展开值 → 两个守卫**都不拦截**。

**修法**：新增 `api/src/common/config/placeholder-secrets.ts`，导出「已知占位符集合」
（`SET`，含 `.env.example` 值与 compose 默认值），两个守卫改为**集合成员判断**。

- **不改 compose 的默认值**：7a 验收明确记录 —— `PAYOUT_ACCOUNT_ENCRYPTION_KEY`
  的默认值一旦改动，既有出款单快照永久解不开（资金安全）。
- 加单测 `placeholder-secrets.spec.ts`：读取 `infra/docker-compose.yml`，
  断言两个默认值都在拒绝集合内 —— 防止将来再次漂移。
- 验证：`NODE_ENV=production` + compose 展开值 → 两个守卫都抛错；
  `NODE_ENV=development` 不受影响（本机 compose 能正常起）。

### 3.3 platform-admin 令牌刷新

**根因**：`platform-admin/src/auth.ts` 用**对象形式** `NextAuth({...})`，
`jwt` 回调只在登录时写入令牌，**没有过期刷新分支**；`src/lib/` 下也没有
`jwt-callback.ts` / `token-refresh.ts` / `token-expiry.ts` / `session-sync.ts` 薄壳
（7c 只收编了 storefront 与 merchant-admin 已有的副本）。后端 accessToken 有效期
`2h`（`api/src/modules/auth/auth.module.ts:29`），而 NextAuth 会话默认 30 天 ——
**超管登录 2 小时后必然卡死**：所有中转路由带过期令牌打后端 → 401，
界面仍显示已登录，且无法自愈。

**修法**（与另两端对齐，但不改 22 处路由）：

1. 补薄壳：`src/lib/jwt-callback.ts` / `token-refresh.ts` / `token-expiry.ts` /
   `session-sync.ts`，各一行 `export * from '@ecom/frontend-shared/...'`；
   补 `src/components/session/session-sync.tsx`。
2. `src/auth.ts` 改为**函数形式**：`NextAuth(async (request) => ({...}))`，
   `jwt: makeJwtCallback(request !== undefined)`，
   `session` 走 `makeSessionCallback()`。
3. 根 `src/app/layout.tsx` 挂 `<SessionSync />`。
4. 补单测：`test/lib/token-refresh.test.ts` / `jwt-callback.test.ts` /
   `token-expiry.test.ts`，与另两端同构。

**明确不做**：22 处中转路由的 `if (!session)` → `if (!session?.accessToken)` 改造
（按用户选择延后到阶段 9）。`makeSessionCallback` 会把空令牌兜底成 `''`，
配合刷新链路后，这条遗留的实际影响仅限「刷新失败后直调中转路由」的窄路径。

---

## 四、8b 资金与并发正确性

### 4.1 购物车原子加购

**根因**：`api/src/modules/cart/cart.service.ts:349-369` 先 `findFirst` 读现有行、
再 `updateMany` 写 `existing.quantity + quantity`。两个并发请求各读到 1，
各自算出 2，后写覆盖先写 —— 加了两次只留 1。`create` 分支撞
`@@unique([cartId, skuId])` 时 P2002 未被捕获，直接 500。

**修法**：改为**单条原子自增**，带上限条件：

```ts
const updated = await this.prisma.cartItem.updateMany({
  where: { cartId: cart.id, skuId, quantity: { lte: MAX_CART_QUANTITY - quantity } },
  data: { quantity: { increment: quantity } },
});
if (updated.count === 1) return;

// 0 行：要么不存在，要么会超上限 —— 查一次区分
const exists = await this.prisma.cartItem.findFirst({ where: { cartId: cart.id, skuId } });
if (exists) throw new BadRequestException(`同一商品的加购总量不能超过 ${MAX_CART_QUANTITY}`);

try {
  await this.prisma.cartItem.create({ data: { tenantId: cart.tenantId, cartId: cart.id, skuId, quantity } });
} catch (error) {
  if (!isUniqueViolation(error)) throw error;
  // 并发插入：重试一次自增（此时行一定存在）
  const retried = await this.prisma.cartItem.updateMany({
    where: { cartId: cart.id, skuId, quantity: { lte: MAX_CART_QUANTITY - quantity } },
    data: { quantity: { increment: quantity } },
  });
  if (retried.count === 0) throw new BadRequestException(`同一商品的加购总量不能超过 ${MAX_CART_QUANTITY}`);
}
```

**测试**：e2e `Promise.all([addItem(1), addItem(1)])` → 断言最终数量为 2；
并发加购触及上限时抛 400 而非 500。

### 4.2 续费幂等

**根因**：
- `api/src/modules/payment/renewal.service.ts:84-90` 的 `scan()` 循环**无 per-tenant
  `try/catch`**，任一租户抛异常（如 `chargeInvoice` 抛 `ConflictException('该账单已支付')`）
  会中断当天其余所有租户的续费。
- `chargeAndSettle`（`:158-212`）的「扣款」与「`markInvoicePaid`」是两步：
  扣款成功但结算失败时，账单仍是 `OPEN`，下一轮扫描**会对同一账期再次扣款**。
- `chargeInvoice` 在渠道返回 `SUCCESS` 时**不把支付单置 `SUCCESS`**（只在失败时置
  `FAILED`），导致「已有成功扣款」这一事实无法从本地状态识别。

**修法**（按用户选择：**幂等键**而非事务合并；渠道扣款是外部调用，不塞进长事务）：

- **幂等键** = `payments` 上已有的 `@@unique([invoiceId, channel])` + 支付单状态。
- `chargeInvoice`：渠道返回 `SUCCESS` 时条件更新支付单 `PENDING/FAILED → SUCCESS`。
- `chargeAndSettle`：先查该账单是否已有 `SUCCESS` 支付单 ——
  有则**跳过扣款、直接 `markInvoicePaid`**（覆盖「扣款成功但结算失败」的恢复路径）。
- `scan()` 循环内包 per-tenant `try/catch`：失败记 `error` 日志（含 subscriptionId
  与异常类名，不打原始 message）并 `continue`。

**测试**：e2e 构造「支付单已 `SUCCESS`、账单仍 `OPEN`」→ 下一轮扫描断言
**渠道只被调用一次**、账单被结算；另一个租户故意抛异常，断言其余租户仍被处理。

### 4.3 渠道交易号绑定

**根因**：`api/src/modules/payment/payment.service.ts:1936-2003` 的
`attachProviderTxnId`：
- 预检查按 `(provider, providerTxnId)`，但真正写入的 `updateMany` 的 where
  **缺 `provider`**；
- `updateMany` 返回 `count === 0`（订单不处于 `PENDING` 或渠道不匹配）时被**静默忽略**。

后果：同一笔渠道交易被另一个 provider 占用时抛 P2002，catch 里用**同样缺 provider
的语义**重查查不到冲突，于是 `return true` —— 上层认为绑定成功，实际支付单上
没有 `providerTxnId`，后续对账只能靠金额匹配。

**修法**：`updateMany` 的 where 补 `provider: event.provider`，并检查 `updated.count`；
为 0 时记录 `warn` 并返回 `false`（不再静默成功）。

**测试**：单测覆盖「provider 不匹配 → 返回 false」「count 为 0 → 返回 false」。

---

## 五、8c 健壮性与工程债

### 5.1 api

| 项 | 现状 | 修法 |
|---|---|---|
| `payout.service.ts:1346` `availablePeriods` | 全量拉该租户全部流水到内存取月份 | 改用 7b 已有的 `prisma.merchantReceiptPeriods(tenantId)`（DB 端 DISTINCT） |
| `coupon.service.ts` `listAvailable` | 两处 `findMany` 无 `take`，`total = items.length` | 加 `clampPagination` + `take/skip` + 独立 `count`；响应补 `page/pageSize` |
| `media.controller.ts:47-52` | `Number(page)` 未校验，`abc → NaN → 500`，`page=0 → 负 skip` | 改用 `clampPagination` / `toIntOr` |

- storefront 券页取第一页（`pageSize=100`，即上限）；响应结构从 `{items,total}`
  扩为 `{items,total,page,pageSize}`，前端只读 `items` 不受影响。
- 补测试：畸形分页参数返回正常结果（不 500）；`mediaIds` 重复时排序正确。

### 5.2 前端

| 项 | 位置 | 修法 |
|---|---|---|
| 后端故障被渲染成「没商品/商品不存在」 | `storefront/src/app/(shop)/search/page.tsx`、`c/[slug]/page.tsx`、`p/[slug]/page.tsx` | 区分 404 与故障：故障渲染错误态 + 重试；只有 404 才 `notFound()`（对齐首页 `page.tsx` 的写法） |
| 改数量失败不回滚输入框 | `storefront/src/components/cart/cart-list.tsx:198-210` | 输入改受控 + 本地 draft，失败时重置为服务端 `item.quantity`；成功但 204 也更新 |
| 「重试」按钮无效 | `cart-list.tsx:151-160` | 抽 `load()`，`useEffect` 与按钮共用；`router.refresh()` 不会重跑客户端 `useEffect` |
| 切 SKU 竞态：旧响应覆盖新选择 | `merchant-admin/src/components/product/inventory-panel.tsx:60-83` | 请求序号（`++reqSeq.current`），回来时序号不符则丢弃 |
| `forwardCookie` 漏配静默降级 | `packages/frontend-shared/src/api-client.ts:78,130-133` | 改为**必填** `forwardCookie: boolean`，三端显式传 `true`/`false`（漏配变编译错误） |
| 无 session 时静默匿名请求 | `packages/frontend-shared/src/api-client.ts:215-225` | `apiFetchAuthed` 在 `session?.accessToken` 为空时抛 `ApiError(401, 'UNAUTHENTICATED', '未登录或登录已过期')` |
| 共享包依赖各端 alias，不可独立检查 | `packages/frontend-shared/src/session-sync-component.tsx:5` | 共享包改为导出**工厂函数** `createSessionSyncComponent(createSessionSync)`，不再 `import '@/lib/session-sync'`；三端薄壳 `components/session/session-sync.tsx` 各自把本端 `@/lib/session-sync` 传进去。解掉「共享包不可独立 `tsc`」的回环 |

- 单测：cart-list 的「失败不谎报空」与「重试真的重取」；inventory-panel 的
  「旧响应被丢弃」；`apiFetchAuthed` 无 session 抛 401。

### 5.3 infra / 工程

| 项 | 现状 | 修法 |
|---|---|---|
| CI api job 无类型检查 | `.github/workflows/ci.yml` api job 只有 prisma generate + test | 补 `npx tsc --noEmit` |
| CI 无并发控制/超时/权限 | 无 `concurrency` / `timeout-minutes` / `permissions` | 顶层 `permissions: contents: read`；`concurrency`（cancel-in-progress）；每个 job `timeout-minutes: 20` |
| 共享包自身不被类型检查 | 无 `tsconfig.json`、无 CI 步骤 | 加 `packages/frontend-shared/tsconfig.json`；CI 加一个 shared job 跑 `tsc --noEmit`（依赖 5.2 的 props 注入解环） |
| api lint 报错 | `api/eslint.config.mjs` 的 `ignores` 只有 `eslint.config.mjs`；`npm run lint`（只扫 `{src,apps,libs,test}`）现有 **8 个文件 28 处**报错，`eslint .` 扫到 `dist/` 后膨胀到 454 处 | 补 `dist/**`、`coverage/**`；修掉 28 处（23 处 `--fix` 可解，另 5 处手改：`require-await` ×2、`no-unnecessary-type-assertion` ×2、`no-unsafe-member-access` ×3）；CI 纳入 `npm run lint` |
| 备份无保留策略/漏 redis/不验证 | `infra/backup.sh`（46 行） | 加保留天数（默认 7，`find -mtime +N -exec rm -rf`）；补 `redis-data` 卷；备份后 `gunzip -t` 校验；postgres 未起时先 `up -d --wait` |
| nginx 无 healthcheck / 无静态缓存 | `infra/docker-compose.yml` nginx 服务 | 加 healthcheck（容器内 `wget --header='Host: demo.platform.test' http://127.0.0.1/`，**已实测可用**）；补 `location /_next/static/` 的 immutable 缓存头 |
| 依赖卫生 | 三端 `lucide-react` 从未 import；api `ts-loader` / `source-map-support` 未使用；三端 `.dockerignore` 已失效 | 删除以上依赖与文件 |

- 验证：`docker compose config` 通过；nginx 容器变 healthy；备份脚本跑通并留下
  可 `gunzip -t` 的产物与保留策略生效；CI 四 job + shared job 全绿。

---

## 六、风险与实施期调查项

| 风险 | 应对 |
|---|---|
| Nginx 改动可能影响其他 server 块的既有路径 | 只改店铺子域名 server 块；改完逐条实测四个域名 + 直连 |
| 改 `cartItem` 加购逻辑可能破坏合并、改数量等既有路径 | 合并/改数量路径不动；补 e2e 覆盖「加购 + 合并 + 改数量」三条 |
| 续费恢复路径改动可能影响既有续费 e2e | 先读 `billing-renewal.e2e-spec.ts` 的既有断言，保持行为不变再补新用例 |
| 共享包 props 注入会改三端的 SessionSync 挂载 | 三端薄壳各改一行；三端单测 + build 守着 |
| api lint 首次纳入 CI 会暴露既有报错 | 先修报错（prettier 为主）再入 CI；lint 与 tsc 分开跑便于定位 |
| 备份改动涉及真实卷 | 只加逻辑不改路径；先在本地跑一次完整备份并验证恢复命令 |

---

## 七、明确不做（阶段 9+）

- platform-admin 22 处中转路由的 `session.accessToken` 判空改造。
- 真实渠道接入、告警通道落地、跨副本分布式锁、退货入库、套餐 `maxStores` 约束、
  跨店会员、游客订单查询。
- TLS / secret manager / 结构化日志 / 慢查询阈值 / e2e 进 CI / cron 容器。
- `applyPercent` 的折扣取整方向（属产品口径，非缺陷）。
- Prisma 迁移的 4 条历史索引漂移（阶段 2 / 5a 已知问题）。
