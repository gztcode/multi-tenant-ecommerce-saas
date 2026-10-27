# 阶段 5d 设计：主题系统统一、前端错误处理收口、Redis 挂死修复

> 阶段 5c（刷新令牌宽限期）已完成并验收。本阶段接手三件事：
> 主题链路（字体/分组标量/实时预览）、前端错误处理统一、
> 以及从 5c 插队过来的「Redis 不可达时 API 静默挂死」。

**日期**：2026-10-27
**依据**：`docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md` §八（5d 起点清单）
**关联**：阶段 4 前端补齐设计 §4.4、阶段 5b 计费设计 §九、阶段 5c 宽限期设计 §5.6

---

## 一、目标与范围

### 1.1 目标

1. **商家配的每一个主题 token 都在前台真实生效**，且生效机制只有一条、可推理。
2. **商家在后台改主题时能看到效果**，不必切标签页去前台验证。
3. **后端不可达时，用户看到的是中文提示而不是 `fetch failed`**；未捕获异常有兜底页面。
4. **Redis 不可达时，API 不再永久挂死**；健康检查能反映真实状态。

### 1.2 范围

| 编号 | 子项 | 涉及 |
|------|------|------|
| 5d-0 | Redis 挂死 + `/health` 真探活 | `api/` |
| 5d-1 | 主题变量统一（`--brand-*`）+ 字体修复 + 阴影/间距接上 | 三个前端 |
| 5d-2 | 商家后台主题实时预览 | `merchant-admin/` |
| 5d-3 | 前端错误处理收口（网络错误/401/结算页误报/layout 判据/错误边界） | 三个前端 |

### 1.3 明确不做

| 不做 | 原因 |
|------|------|
| platform-admin 的租户主题配置页 | 现状是**这个页面根本不存在**（全目录 grep 只命中 `globals.css` 一处）。做它是**新功能**，不是技术债 |
| 抽佣流水明细表 | 属阶段 5e 的计费遗留 |
| 跨副本分布式刷新锁 | 5c 遗留项，但当前**单副本单进程**（无 `replicas`、无 PM2）。扩副本前再做 |
| `maxStores` 约束 | 约束逻辑已写好（`quota.service.ts:85`），但**没有创建店铺的接口**（`stores.controller.ts` 无 `@Post`）。要么无意义、要么是新功能 |
| 「改密码」时吊销令牌族 | 5c 遗留项，**当前没有改密端点**。将来加改密功能时一并做 |
| 全局 toast 组件 | `error.tsx` + 内联提示已经够用。引入 toast 库是额外依赖 |
| `loading.tsx` 骨架屏 | 不在清单内，属于锦上添花 |

---

## 二、事实基础（本阶段的实测结论）

> ⚠️ **本节推翻了阶段 4 与 5c 文档里的一处判断**：
> 「四组分组标量在前台没有任何消费者」是**错的**。
> 字阶与字重**一直在生效**，走的是一条没有文档的「巧合路径」。
> 正确表述见 §2.3。

### 2.1 主题系统的两套机制

主题 token 的下发链路是：

```
后端 theme-tokens.ts（token 定义 + 白名单 + 值校验）
  → ThemeService.sanitize()（Json 字段过滤，安全边界）
  → GET /public/theme
  → storefront buildThemeCss() 拼成 ":root { ... }"
  → 内联 <style> 注入（服务端）
  → ThemeWatcher 轮询 + setProperty 增量覆盖（客户端）
```

Tailwind 侧的消费靠 `globals.css` 的 `@theme inline` 块（**三个前端逐字节一致**，
shasum `ab00c18048759788c7f45b7d4ec836b8914fbf1d`）：

```css
@theme inline {
  --color-background: var(--background);   /* 32 个颜色 */
  --font-sans: var(--font-sans);            /* ⚠️ 自引用 */
  --font-mono: var(--font-geist-mono);
  --font-heading: var(--font-sans);
  --radius-sm: calc(var(--radius) * 0.6);  /* 圆角：派生桥接 */
  ...
}
```

### 2.2 实测：Tailwind 4.3.3 的编译行为

用 `tailwindcss` 包的 `compile()` API 实测（`@import "tailwindcss"` + 项目真实的
`@theme inline` 块），产物关键片段：

```css
@layer theme, base, components, utilities;
@layer theme {
  :root, :host {
    --font-sans: var(--font-sans);      /* ⚠️ 自引用 → 计算值无效 */
    --spacing: 0.25rem;                 /* 单一变量，无刻度命名空间 */
    --text-sm: 0.875rem;
    --font-weight-semibold: 600;
    --default-font-family: var(--font-sans);
  }
}
@layer utilities {
  .text-sm        { font-size: var(--text-sm); line-height: var(--tw-leading, var(--text-sm--line-height)); }
  .font-semibold { --tw-font-weight: var(--font-weight-semibold); font-weight: var(--font-weight-semibold); }
  .p-4           { padding: calc(var(--spacing) * 4); }
  .shadow-sm     { --tw-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1); }  /* ⚠️ 硬编码 */
  .font-sans     { font-family: var(--font-sans); }
}
```

**四条实测结论（现状）**：

1. **`@theme inline` 让被覆盖的变量不再输出到 `:root`**，utility 里直接内联值引用。
   例：`@theme inline { --text-sm: var(--brand-text-sm, 0.875rem) }` 编译成
   `.text-sm { font-size: var(--brand-text-sm, 0.875rem) }`，而 `:root` 里**不再有**
   `--text-sm` → **与 Tailwind 内置刻度零冲突**。
2. **字阶、字重的 utility 引用变量** → 运行时覆盖同名 `:root` 变量**有效**。
3. **阴影的 utility 是硬编码**（Tailwind 把复合值内联展开了）→ 运行时覆盖
   `--shadow-sm` **完全无效**。
4. **间距只有单一 `--spacing` 基础值**，`p-4 = calc(var(--spacing) * 4)`。
   Tailwind 4 **没有** `--spacing-*` 刻度命名空间。

#### 2.2.1 第二轮实测：新方案（`--brand-*` 桥接）逐条验证

> 用 §4.2.1 的**最终** `@theme inline` 块重新编译，产物关键片段：

```css
@layer theme {
  :root, :host {
    --default-font-family: var(--brand-font-sans, var(--font-geist-sans));
    --default-mono-font-family: var(--brand-font-mono, var(--font-geist-mono));
  }
}
@layer utilities {
  .bg-primary     { background-color: var(--brand-primary); }
  .text-sm        { font-size: var(--brand-text-sm, 0.875rem); }
  .font-semibold  { font-weight: var(--brand-font-weight-semibold, 600); }
  .shadow-sm      { --tw-shadow: var(--brand-shadow-sm, 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))); }
  .p-4            { padding: calc(var(--brand-spacing, 0.25rem) * 4); }
  .rounded-sm     { border-radius: calc(var(--brand-radius) * 0.6); }
  .font-sans      { font-family: var(--brand-font-sans, var(--font-geist-sans)); }
}
```

**五条结论**：

| # | 结论 |
|---|------|
| A1 | **阴影复合值能内联** ✅ —— 含逗号与嵌套 `var()` 的复合值被正确展开成 `--tw-shadow` 变量引用。**风险 R1 解除**，不需要「手写 `@utility shadow-sm`」的 fallback 方案 |
| A2 | **字体内联正常** ✅ —— ⚠️ **最终实现用的不是这一套**（见下）。实测的机制是 `--default-font-family: var(--brand-font-sans, …)` + base 层 `html { font-family: var(--default-font-family, …) }`；**最终落地的是** `@theme inline { --font-sans: var(--brand-font-sans); }`（**不带 fallback**）+ `:root { --brand-font-sans: var(--font-geist-sans); }` + `@layer base { html { @apply font-sans; } }` → `html { font-family: var(--brand-font-sans); }`。两者都能让品牌字体作用到 html，**最终实现不需要 fallback**（`:root` 已定义默认值，且 §4.2.1 统一不带 fallback）。**风险 R2 解除** |
| A3 | **间距单值可表达** ✅ —— 覆盖 `--spacing` 后它不再落到 `:root`，但 utility 内联了 `calc(var(--brand-spacing, 0.25rem) * 4)` → 运行时覆盖 `--brand-spacing` 有效 |
| A4 | **`@theme inline` 的「不落到 `:root`」对所有命名空间一致成立** —— 被覆盖的变量在 `:root` 里一律不出现 → 与 Tailwind 内置刻度零冲突 |
| A5 | **`:root` 的默认值不必在 `@theme inline` 里再写一遍 fallback** —— 三个前端的 globals.css 逐字节一致，`:root` 一定在，`var(--brand-x)` 一定有值。**统一不带 fallback**（见 §4.2.1） |

### 2.3 因此，各组的真实状态是

| 组 | 后端 cssVar | 与 Tailwind 内置同名？ | 编译产物形态 | 现状 |
|----|------------|---------------------|------------|------|
| 颜色 | `--primary` … | 否（是 `--color-*` 命名空间） | `.bg-primary { background-color: var(--primary) }` | ✅ **生效**（正规的 `@theme inline` 桥接） |
| 圆角 | `--radius` | 否 | `--radius-lg: var(--radius)` | ✅ **生效**（派生桥接） |
| 字阶 | `--text-xs/sm/base/lg/xl` | ✅ **完全同名** | `font-size: var(--text-sm)` | ✅ **生效**（同名覆盖的巧合路径） |
| 字重 | `--font-weight-normal/medium/semibold/bold` | ✅ **完全同名** | `font-weight: var(--font-weight-semibold)` | ✅ **生效**（同名覆盖的巧合路径） |
| 阴影 | `--shadow-sm/base/lg` | `sm`/`lg` 同名，`base` 不同名 | **硬编码** | ❌ **不生效** |
| 间距 | `--spacing-xs/sm/base/lg/xl` | ❌ 名字全不同 | `calc(var(--spacing) * N)` | ❌ **不生效** |
| 字体 | `--font-sans`/`--font-mono` | — | `:root { --font-sans: var(--font-sans) }` | ❌ **不生效**（双重失效） |

**字体为什么双重失效**：

- `globals.css` 第 10 行 `--font-sans: var(--font-sans)` 是**自引用** → 计算值阶段无效。
- 即使修好自引用，`--font-geist-sans` 由 next/font 的 `.__variable_*` 类挂在
  **`<body>`** 上（`storefront/src/app/layout.tsx:28-30`），只在 body 子树里存在，
  **`:root` 作用域解析不到**。

**字阶/字重为什么「巧合地」生效**：运行时注入的裸 `:root { --text-sm: ... }`（无
`@layer`）优先级**高于** Tailwind 编译产物里 `@layer theme { :root { --text-sm: ... } }`
（CSS 层叠层：无 layer 的声明优先于任何 layer）→ 同名变量被覆盖 → utility 跟随。
但这条路径**没有任何文档和测试保护**：Tailwind 升级改名、后端改 `cssVar`、或新增一个
不同名的 token，都会让它静默失效。

### 2.3.1 颜色的两套清单不等长（32 vs 16）

`globals.css` 的 `@theme inline` 映射了 **32** 个颜色命名空间，而后端 `COLOR_TOKENS`
只有 **16** 个：

| | 数量 | 清单 |
|---|------|------|
| CSS 侧有、商家**配不了** | 16 | `popover`、`popover-foreground`、`input`、`chart-1..5`、`sidebar`、`sidebar-foreground`、`sidebar-primary`、`sidebar-primary-foreground`、`sidebar-accent`、`sidebar-accent-foreground`、`sidebar-border`、`sidebar-ring` |
| 商家**能配** | 16 | `background`、`foreground`、`card`、`card-foreground`、`primary`、`primary-foreground`、`secondary`、`secondary-foreground`、`muted`、`muted-foreground`、`accent`、`accent-foreground`、`destructive`、`destructive-foreground`、`border`、`ring` |

⚠️ 现状是：**这 32 个 CSS 变量共用同一套裸名**，商家改 `primary` 会连带影响
`bg-primary`，而 `chart-*`/`sidebar-*` 永远是固定的 shadcn 默认值。

⚠️ 另有一个**空 token**：后端 `COLOR_TOKENS` 里有 `destructiveForeground`
（`--destructive-foreground`），`storefront/src/lib/theme.ts` 里也有，
但 `globals.css` **既没有 `--destructive-foreground`，也没有 `--color-destructive-foreground`**
→ **商家配了它，前台什么都不变**。这与目标 1.1「商家配的**每一个**主题 token
都在前台真实生效」直接冲突 → 5d 必须补上映射（见 §4.2.1）。

### 2.4 前端错误处理的现状

| 事实 | 位置 |
|------|------|
| 三个 `api-client.ts` 的 `fetch()` **无 try/catch** → 网络错误是 `TypeError: fetch failed`，不是 `ApiError` | `storefront/src/lib/api-client.ts:60-65`、`merchant-admin/…:49-54`、`platform-admin/…:36-41` |
| **76 处**把 `cause.message` 直出给用户（三个前端合计，不含 api-client / route-helpers / shop-api） | RSC 页面 + 客户端组件 |
| `route-helpers.ts` 的收敛（502 + 「后端服务不可用」）**只覆盖 `/api/**` 中转路由** | `storefront/src/lib/route-helpers.ts:51-59` |
| RSC 直连路径（`shop-api.ts` 7 处）**完全裸奔** | `storefront/src/lib/shop-api.ts` |
| 三个应用**零错误边界**（无 `error.tsx`/`global-error.tsx`） | 全仓 grep 无命中 |
| 没有任何 toast 组件 | 40+ 处内联 `<p className="text-destructive">` |
| 401 显示英文 `Unauthorized` | `shop-api.ts` 7 处 + 15 个后台页面 |
| 商家后台保存主题失败的提示**已经是**脱敏后的文案（无需处理） | `theme-section.tsx` 抛的是 `new Error(payload.message)`，而 `payload.message` 来自 `/api/stores/me` 的 `toErrorResponse` 收敛结果 |
| 结算页把 `cart === null` 当成空车 `redirect('/cart')` | `storefront/src/app/(shop)/checkout/page.tsx:39-41` |
| storefront / platform-admin 的 layout 判据是 `!session`（松），merchant-admin 是 `!session?.accessToken`（紧） | `storefront` 6 处、`platform-admin/src/app/(dashboard)/layout.tsx:24-26` |

### 2.5 Redis 挂死的机制

- `api/src/modules/queue/queue.module.ts:31-54` 是**全项目唯一的 Redis 连接点**。
- BullMQ 覆盖了 ioredis 的 `retryStrategy`：
  `retryStrategy: (times) => Math.max(Math.min(Math.exp(times), 20000), 1000)` → **无限重试**。
- `waitUntilReady()` 只在 `ready` 或 `end` 时 resolve/reject，而 ioredis 永远不会 `end`
  → **`init()` 的 Promise 永远 pending** → `queue.add()` 永久 pending。
- `queue.service.ts` 的 `add`/`addDelayed`/`addRepeating` 都是**裸 `await`**，无超时。
- `order.service.ts:238` 的 `await this.queue.addDelayed(...)` 位于**事务提交之后**、
  **无 try/catch** → **订单已落库，响应永远挂住**；而若把超时抛出去，
  用户还会看到「失败」却发现订单其实建好了。
- ⚠️ **投递的位置有硬约束**（不是随手放哪都行）：`payExpiresAt` 在**事务内**建单时算，
  而 delayed job 从**入队时刻**起算延迟 → 前移会让任务早于 `payExpiresAt` 触发并被跳过。
  详见 §4.1.2。
- `payment.service.ts:684` 的 webhook 投递同理。
- `health.controller.ts:11-13` 返回**静态** `{ status: 'ok' }` → 不查 Redis 也不查数据库；
  `infra/docker-compose.yml:130-139` 的 api healthcheck 正是打这个端点 →
  **Redis 挂了容器仍报 healthy**。

---

## 三、关键决策

| 编号 | 决策 | 理由 |
|------|------|------|
| D1 | **主题变量统一到 `--brand-*` 命名空间**，运行时只注入 `--brand-*` | `@theme inline` 让被覆盖的变量不落到 `:root`，与内置刻度零冲突；「同名覆盖」那条巧合路径不再承载任何 token。**CSS 侧 32 个颜色命名空间全部改名**（含商家配不了的 `chart-*`/`sidebar-*`/`popover`/`input`），保证 `--brand-*` 是**唯一**命名空间 |
| D2 | **字体变量从 `<body>` 挪到 `<html>`** | next/font 的 `variable` class 只声明 CSS 变量、**不声明 `font-family`**，挪动安全；挪到 html 后 `:root` 作用域能解析到 `var(--font-geist-sans)`。⚠️ 自定义属性在**声明元素处**替换，不会在 body 补救 —— 留在 body 上则品牌字体永远取不到值 |
| D3 | **间距组改为单一 `--spacing` 基础值**（语义从「五档刻度」变成「全局间距密度」） | Tailwind 4 无 `--spacing-*` 命名空间，五档刻度**在技术上无法表达**。改 schema 后老数据自动降级（见 §4.2） |
| D4 | **阴影后端默认值改成 Tailwind 内置值** | 否则「商家不配」也会改变全站默认阴影外观 |
| D5 | **商家后台实时预览用 wrapper div + 内联 `--brand-*`** | CSS 变量继承 → 天然作用域隔离，不会把后台自身的按钮也染色；不需要 iframe |
| D6 | **网络错误在 `api-client.ts` 收口成 `ApiError(503, 'NETWORK_ERROR', 中文)`** | **零改动 76 个渲染点**就变成中文；`status=503` 是合法 HTTP，不引入新类型、不改 `route-helpers.ts` |
| D7 | **401 中文化也放在 `api-client.ts`** | 只翻译后端**默认文案** `'Unauthorized'`，不动后端主动抛的中文消息；一处改动全站生效 |
| D8 | **下单的队列投递留在事务提交之后，但投递失败不向上抛**（catch + error 日志） | 投递失败若向上抛 → 用户看到 503，但订单**已建成且可支付**（矛盾态，会诱发重复下单）；失败不抛 → 用户拿到正常响应。⚠️ **曾考虑「把投递前移到事务之前」**（让投递失败 ⇒ 确定无订单）——**已否决**，它会破坏超时释放任务的时序（§4.1.2） |
| D9 | **webhook 投递失败不报失败** | 支付已入库，报失败会诱导用户重复支付 |
| D10 | **本阶段不引入「超时释放任务丢失」的补偿机制** | 与 L1（webhook 补偿）同类。5d-0 只做到「请求不再挂死 + 失败不报 + 记日志」；底层 `queue.add()` 没被取消，Redis 恢复后通常会补上，进程重启才真丢 → 记入遗留 L12 |

---

## 四、设计

### 4.1 5d-0：Redis 挂死

#### 4.1.1 队列操作加超时

`api/src/modules/queue/queue.service.ts` 的三个投递方法包一层超时：

```ts
/** 队列投递超时（毫秒）。 */
const QUEUE_OPERATION_TIMEOUT_MS = 3_000;

private async withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ServiceUnavailableException(`队列操作超时：${what}`)),
          QUEUE_OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

三个方法（`add` / `addDelayed` / `addRepeating`）各自套 `withTimeout`。

⚠️ **`addRepeating` 的两个调用点都在 `onModuleInit` 里**，超时的影响比另外两个大：

| 调用点 | 注册什么 | 超时后 |
|--------|----------|--------|
| `auth/token-grace.service.ts:44` | 每小时清一次宽限记录 | 周期任务没注册 → 密文不再被清理 |
| `payment/renewal.service.ts:53` | 每日扫一次即将到期的订阅 | 周期任务没注册 → **续费账单不再自动生成** |

⚠️ **NestJS 里 `onModuleInit` 抛异常会导致 bootstrap 失败** → 进程起不来。
所以 Redis 在**启动时**不可达 = API 起不来（现状也一样，只是现状是**永远卡在
bootstrap**、没有任何提示；加超时后变成「3 秒后明确报错退出」——**从静默卡死变成快速失败**，
这是改进，不是退化）。

⚠️ **不要在 `onModuleInit` 里吞掉这个异常**：周期任务（续费扫描、宽限清理）
没注册意味着账目与令牌清理都不会跑 —— 与其让一个「看起来正常、其实不干活」的进程
跑着，不如启动失败让人立刻知道。⚠️ 这也意味着 §4.1.4 的 `/health` 返回 degraded
描述的是「**Redis 是在启动之后**挂掉」的情形；启动时就挂的话，根本没有进程能回答 `/health`。

⚠️ **超时后底层 Promise 仍在 pending**：不解决「挂死」本身，但**解决「请求永久挂住」**
—— 用户拿到 503 而不是永远等下去。底层连接会由 BullMQ 自己持续重连。

⚠️ **超时 ≠ 投递没发生**：底层那个 `queue.add()` 并没有被取消，Redis 恢复后它
**可能最终成功入队**。也就是说「API 报了 503，但任务其实排上了」是可能的。
这对下单链路的影响是**可控的**：任务带的是 `timeout-${orderId}`，
订单要么存在（会被正常释放）、要么不存在（worker 跳过）——
两种结局都不产生脏数据。**但它决定了 D8 的形态**：只有把投递放在事务之前，
「503」才能确定地等价于「没有订单」。

#### 4.1.2 下单的投递失败不致命

`api/src/modules/order/order.service.ts`：**投递的位置不动**（仍在事务提交之后），
只把「投递失败」从「向上抛」改成「捕获 + 记 error 日志」：

```ts
try {
  await this.queue.addDelayed(
    PAYMENT_TIMEOUT_QUEUE,
    'release',
    { tenantId, orderId },
    PAYMENT_TIMEOUT_MS,
    `timeout-${orderId}`,
  );
} catch (cause) {
  // ⚠️ 订单已建成、库存已预占、用户可以正常支付。
  //    这里报失败会让用户以为「没下单成功」而重下 → 重复订单。
  //    投递失败只影响「超时后自动关单」这一件事，不影响下单本身。
  this.logger.error(`支付超时释放任务投递失败：订单 ${orderId}`, cause);
}
```

**为什么不是「投递前移到事务之前」**（初稿的 D8，曾被采纳又被否决）：

前移的动机是「投递失败 ⇒ 确定无订单」——听起来更干净。但它会**破坏超时释放的时序**：

| 位置 | 事实 |
|------|------|
| `order.service.ts:514` | `payExpiresAt = Date.now() + 15min` —— 在**事务内**建单时算 |
| `order-timeout.service.ts:86` | `if (order.payExpiresAt && order.payExpiresAt.getTime() > now.getTime()) return false` —— 还没到支付期限就**跳过**，且任务已被消费掉，**不会重试** |
| BullMQ | delayed job 最早在**入队时刻 + 15min** 被消费 |

- **投递在事务之后**（现状与本方案）：入队时刻 T1 > 建单时刻 T0
  → 任务触发于 T1+15min **晚于** `payExpiresAt`（T0+15min）→ **正常释放** ✅
- **投递在事务之前**：入队时刻 T0 < 建单时刻 T1
  → 任务触发于 T0+15min **早于** `payExpiresAt`（T1+15min）约一个事务的耗时
  → `order-timeout.service.ts:86` 判定「还没到期限」→ **跳过**
  → 任务已被消费掉、不重试 → **订单永远停在待支付、库存永久卡在预占** ❌

⚠️ 顺带修正初稿的一处措辞：初稿说「投递失败在事务后 → 订单**永久卡在待支付**」。
这不准确——底层那个 `queue.add()` **没有被取消**，Redis 恢复后它通常会补上入队，
订单仍会被释放。真正要防的是「用户看到失败、订单却建好了」的**矛盾态**。

⚠️ 副作用：投递超时会让下单接口**慢 3 秒**（超时上限）才返回。可接受。

⚠️ 残留风险：Redis 长时间不可用 → 该订单可能不被自动释放 → 遗留 L12。

#### 4.1.3 webhook 投递失败不报失败

`api/src/modules/payment/payment.service.ts` 的 `enqueueWebhookEvent`：
投递超时 → 捕获 → 记 `error` 日志 → **不抛出**。支付已入库，通知丢失由后续补偿处理
（不在本阶段范围，记入遗留）。

#### 4.1.4 `/health` 真探活

`api/src/health/health.controller.ts`：

- ping Redis（**独立短连接**，见下）
- `SELECT 1` 探数据库
- 两者都通 → `{ status: 'ok' }`，HTTP 200
- 任一不通 → `{ status: 'degraded', checks: { redis: false, database: true } }`，HTTP 503

⚠️ **探活必须自带超时**（2 秒）—— BullMQ 的连接在 Redis 挂时永远 pending，
`waitUntilReady()` 不会 resolve。

⚠️ **必须用独立连接，不能复用 BullMQ 的那个 ioredis 实例**：
`queue.module.ts` 里 `BullModule.forRoot` 配的是
`maxRetriesPerRequest: null` + BullMQ 默认的**无限退避重试**，
那个实例在 Redis 挂时会把 `PING` 排进离线队列里**永远不返回**——
用它探活等于把探活本身也挂死（正是 5d-0 要修的那个机制）。
独立连接要**禁用重试**：`maxRetriesPerRequest: 1` + `retryStrategy: () => null`
+ `connectTimeout: 2000` → 连不上就立刻失败。

⚠️ `/health` 被 `@Skip()` 标记（跳过鉴权），保持不变。

⚠️ **数据库探活不要用 Prisma 的 `$queryRaw` 长连接**：复用连接池即可，
但要带 2 秒超时；连接池被占满时同样会挂。

### 4.2 5d-1：主题变量统一

#### 4.2.1 两层结构

**① Tailwind 命名空间层**（`globals.css` 的 `@theme inline`）—— 只在这里出现 Tailwind 命名空间：

```css
@theme inline {
  /* 颜色：32 个（全部改名，不只是商家能配的那 16 个） */
  --color-background: var(--brand-background);
  --color-foreground: var(--brand-foreground);
  --color-card: var(--brand-card);
  --color-card-foreground: var(--brand-card-foreground);
  --color-popover: var(--brand-popover);
  --color-popover-foreground: var(--brand-popover-foreground);
  --color-primary: var(--brand-primary);
  --color-primary-foreground: var(--brand-primary-foreground);
  --color-secondary: var(--brand-secondary);
  --color-secondary-foreground: var(--brand-secondary-foreground);
  --color-muted: var(--brand-muted);
  --color-muted-foreground: var(--brand-muted-foreground);
  --color-accent: var(--brand-accent);
  --color-accent-foreground: var(--brand-accent-foreground);
  --color-destructive: var(--brand-destructive);
  --color-destructive-foreground: var(--brand-destructive-foreground);  /* 新增：补上空 token */
  --color-border: var(--brand-border);
  --color-input: var(--brand-input);
  --color-ring: var(--brand-ring);
  --color-chart-1: var(--brand-chart-1);
  /* …chart-2..5… */
  --color-sidebar: var(--brand-sidebar);
  --color-sidebar-foreground: var(--brand-sidebar-foreground);
  --color-sidebar-primary: var(--brand-sidebar-primary);
  --color-sidebar-primary-foreground: var(--brand-sidebar-primary-foreground);
  --color-sidebar-accent: var(--brand-sidebar-accent);
  --color-sidebar-accent-foreground: var(--brand-sidebar-accent-foreground);
  --color-sidebar-border: var(--brand-sidebar-border);
  --color-sidebar-ring: var(--brand-sidebar-ring);

  /* 圆角：派生桥接保留 */
  --radius-sm: calc(var(--brand-radius) * 0.6);
  --radius-md: calc(var(--brand-radius) * 0.8);
  --radius-lg: var(--brand-radius);
  --radius-xl: calc(var(--brand-radius) * 1.4);
  --radius-2xl: calc(var(--brand-radius) * 1.8);
  --radius-3xl: calc(var(--brand-radius) * 2.2);
  --radius-4xl: calc(var(--brand-radius) * 2.6);

  /* 字体 */
  --font-sans: var(--brand-font-sans);
  --font-mono: var(--brand-font-mono);
  --font-heading: var(--brand-font-sans);

  /* 字阶 */
  --text-xs: var(--brand-text-xs);
  --text-sm: var(--brand-text-sm);
  --text-base: var(--brand-text-base);
  --text-lg: var(--brand-text-lg);
  --text-xl: var(--brand-text-xl);

  /* 字重 */
  --font-weight-normal: var(--brand-font-weight-normal);
  --font-weight-medium: var(--brand-font-weight-medium);
  --font-weight-semibold: var(--brand-font-weight-semibold);
  --font-weight-bold: var(--brand-font-weight-bold);

  /* 阴影 */
  --shadow-sm: var(--brand-shadow-sm);
  --shadow-base: var(--brand-shadow-base);
  --shadow-lg: var(--brand-shadow-lg);

  /* 间距（单一基础值） */
  --spacing: var(--brand-spacing);
}
```

**② 品牌变量层**（`globals.css` 的 `:root`）—— 默认值只在这里出现一次：

```css
:root {
  /* 颜色：32 个。商家能配的那 16 个默认值取自后端 theme-tokens.ts；
     另外 16 个（popover / input / chart-* / sidebar-*）商家配不了，
     值固定为 shadcn 默认，永远不变。 */
  --brand-background: oklch(1 0 0);
  --brand-foreground: oklch(0.145 0 0);
  /* …32 个颜色… */

  --brand-radius: 0.625rem;
  --brand-font-sans: var(--font-geist-sans);
  --brand-font-mono: var(--font-geist-mono);
  --brand-text-xs: 0.75rem;
  --brand-text-sm: 0.875rem;
  --brand-text-base: 1rem;
  --brand-text-lg: 1.125rem;
  --brand-text-xl: 1.25rem;
  --brand-font-weight-normal: 400;
  --brand-font-weight-medium: 500;
  --brand-font-weight-semibold: 600;
  --brand-font-weight-bold: 700;
  --brand-shadow-sm: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
  --brand-shadow-base: 0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
  --brand-shadow-lg: 0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
  --brand-spacing: 0.25rem;
}
```

⚠️ **`:root` 里的 shadcn 裸名（`--primary`、`--background`、`--radius` 等 32 个）删掉**，
只保留 `--brand-*`。唯一直接消费裸变量的地方是
`storefront/src/components/ui/button.tsx:14` 的
`color-mix(in_oklch, var(--secondary), var(--foreground)_5%)` → 改成
`var(--brand-secondary)` / `var(--brand-foreground)`。

⚠️ **`.dark` 块（`globals.css:86-118`）的 32 个裸名也要一起改名成 `--brand-*`**：
`:root` 的裸名删掉之后，`.dark` 里那套裸名就成了**没有任何消费者的孤儿声明**。
改名后 `--brand-*` 是唯一命名空间这条不变量才成立。

⚠️ **dark 模式目前从未启用**：全仓**没有任何地方**给 `<html>` 加 `.dark` 类
（只有 `dark:` 变体类名，出现在 `ui/button.tsx` / `ui/input.tsx` 里）。
所以 `.dark` 现在是死代码 —— 但它**不能只删一半**（删 `:root` 的裸名、留 `.dark` 的裸名），
那会留下 32 个孤儿声明。改名是保持一致性的最小动作。
⚠️ 改名后的副作用：将来若启用 dark 模式，`.dark` 的 `--brand-*` 会**盖掉**
商家注入的 `:root` `--brand-*`（同优先级、`.dark` 在源码里更靠后）→
商家主题在 dark 模式下失效 → 记入遗留（见 L11）。

⚠️ **补上 `--color-destructive-foreground`**：这是后端早就有的一个 token，
但 `globals.css` 里既没有 `--destructive-foreground` 也没有对应的 Tailwind 命名空间
→ 商家配了它前台什么都不变。目标 1.1 要求「商家配的**每一个** token 都真实生效」
→ 必须补。`:root` 里也要给它一个默认值 `oklch(0.985 0 0)`
（与 `theme-tokens.ts` 里 `destructiveForeground` 的默认值一致）。

⚠️ **`@theme inline` 里一律不写 fallback**（实测结论 A5）：`:root` 已经定义了
全套 `--brand-*` 默认值，三个前端的 globals.css 逐字节一致 → `var(--brand-x)`
一定有值。**默认值只存一处**（`:root`），避免两处各存一份导致漂移。
这正是 platform-admin / merchant-admin **不注入任何东西**也能正常显示的原因 ——
它们靠的是 `:root`，不是 fallback。

⚠️ **`:root` 里的默认值会被运行时注入覆盖**：编译产物的 `:root`（shadcn 默认值那份）
在 `@layer theme` 内，而手写的 `:root` 块在**普通层** → 优先级更高；
运行时的内联 `<style>` 的裸 `:root` 同样在普通层 → **同层，后出现者胜**。
现状（颜色能生效）已实测验证这个顺序成立。

⚠️ **三个前端都要改**（`globals.css` 逐字节一致，改一份必须同步三份，
shasum `ab00c18048759788c7f45b7d4ec836b8914fbf1d` 要保持不变）。
platform-admin / merchant-admin **不注入** `--brand-*` → 用 `:root` 的默认值
→ **零配置、零视觉变化**。

#### 4.2.2 字体修复

- `storefront/src/app/layout.tsx`、`merchant-admin/src/app/layout.tsx`、
  `platform-admin/src/app/layout.tsx`：next/font 的 `variable` class 从 `<body>` 挪到 `<html>`。
  ⚠️ 该 class **只声明 CSS 变量、不声明 `font-family`** → 挪动不改变 html 的字体，
  只让 `:root` 作用域能解析到 `var(--font-geist-sans)`。
- `globals.css` 的 `@theme inline` 里去掉自引用（见 §4.2.1）。
- ⚠️ **配套的一处改动：`globals.css` 的 `@layer base` 里保留 `html { @apply font-sans; }`**
  —— 这是品牌字体真正落到 html 上的那条路径（`@theme inline { --font-sans: var(--brand-font-sans); }`
  → `html { font-family: var(--brand-font-sans) }`）。⚠️ **不依赖 `--default-font-family` 的
  fallback** —— 与 §4.2.1「一律不写 fallback」一致。
- `theme-watcher.tsx` 的 `CLIENT_SCALAR_KEYS` 从 `['radius']` 放开为
  `['radius', 'fontSans', 'fontMono']` —— 现在写它有真实视觉收益了。

⚠️ **为什么挪到 `<html>` 就够了**（不是「挪高一点更保险」，是**必须**）：
自定义属性的 `var()` 替换发生在**声明它的那个元素上**——`:root`（= `<html>`）
声明 `--brand-font-sans: var(--font-geist-sans)` 时就地解析；
若 `--font-geist-sans` 只存在于 `<body>`，`<html>` 上解析不到
→ `--brand-font-sans` 变成 guaranteed-invalid → **body 的同名变量不会来补救**
（继承下去的是 html 上那个无效值）。

⚠️ **`theme-watcher.tsx` 里有一段错误注释必须一并改掉**（第 196-200 行）：

> 这四组（--text-* / --spacing-* / --shadow-* / --font-weight-*）**在前台没有任何消费者**
> ……写与不写，视觉完全一样。

**这句话是错的**（见 §2.3）——而且它就在**要被修改的文件里**，不删会直接误导实施者
以为「改了也没用」。同时 `CLIENT_SCALAR_KEYS` 上方那段「字体 token 写它没有任何视觉收益」
的长注释也要一并重写（它的结论在 5d 之后已经不成立）。

⚠️ 顺带：watcher 里 `applyTokens` 的分组写入逻辑（`${prefix}${key}`）要跟着
§4.2.4 的映射改造一起改，否则客户端写的还是旧的变量名。

#### 4.2.3 后端 schema 调整

`api/src/modules/theme/theme-tokens.ts`：

- `cssVar` 字段全部改成 `--brand-*`（**仅字段值**，token 的 `key` 不变 →
  **数据库里的 JSON key 不变 → 无需迁移**）。
  ⚠️ 只改这 **16 个颜色 token**（商家能配的那些）；
  另外 16 个 CSS 颜色（popover / input / chart-* / sidebar-*）**后端没有 token**，
  只在 `globals.css` 里改名，不进 schema。
- `SPACING_TOKENS` 从 5 档改成 1 个：
  ```ts
  export const SPACING_TOKENS: ScalarTokenDefinition[] = [
    { key: 'base', label: '间距密度', cssVar: '--brand-spacing', defaultValue: '0.25rem' },
  ];
  ```
  ⚠️ **老数据自动降级**：`sanitize()` 按 `SPACING_TOKENS` 的定义取键，
  老数据里的 `xs`/`sm`/`lg`/`xl` **不在白名单 → 被丢弃**，
  `base` 保留 → 无需写迁移。
  ⚠️ **`sanitize()` 会用默认值补齐缺失的键**（`defaults()` 是初值），
  所以前端拿到的 `spacing` 永远是 `{ base: '…' }` —— 不存在「键缺失」的情况。
- `SHADOW_TOKENS` 的 `defaultValue` 改成 **Tailwind 内置值**（与 §4.2.1 的 `:root` 一致）：
  - `sm` → `0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))`
  - `base` → `0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))`
  - `lg` → `0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1))`
  ⚠️ 内置值含 `var(--tw-shadow-color, rgb(0 0 0 / 0.1))` → 过 `isValidScalarValue`
  的正则 `^[0-9a-zA-Z.%\-/,_() ]{1,180}$`（允许逗号、括号、`var`）✅
  ⚠️ **默认值只存 `:root` 一处**（§4.2.1 的 A5），但后端 `defaultValue` 是**另一份**——
  它是「商家没配时前端拿到什么」的来源。两处必须一致，否则商家清空某个字段后
  外观会跳变。**写代码时把这两处一起改，并用同一条常量或同一次提交保证它们不漂移**。
- `FONT_TOKENS` 的 `defaultValue` 保持 `var(--font-geist-sans)`（挪到 html 后可解析）✅

#### 4.2.4 前端映射表

`storefront/src/lib/theme.ts`：

- `CSS_VARS` 的值全部改成 `--brand-*`。
- ⚠️ **`GROUP_CSS_VARS` 的结构要改：从「前缀 + 键」改成「组 → 键 → 变量名」的显式映射**：

  ```ts
  export const GROUP_CSS_VARS: Record<string, Record<string, string>> = {
    textScale: {
      xs: '--brand-text-xs',
      sm: '--brand-text-sm',
      base: '--brand-text-base',
      lg: '--brand-text-lg',
      xl: '--brand-text-xl',
    },
    weights: {
      normal: '--brand-font-weight-normal',
      medium: '--brand-font-weight-medium',
      semibold: '--brand-font-weight-semibold',
      bold: '--brand-font-weight-bold',
    },
    shadows: {
      sm: '--brand-shadow-sm',
      base: '--brand-shadow-base',
      lg: '--brand-shadow-lg',
    },
    spacing: {
      base: '--brand-spacing',   // 单值，键名只是为了放进统一结构
    },
  };
  ```

  ⚠️ **改完之后 `GROUP_KEYS` 整个删掉**：它现在是一张「与 `GROUP_CSS_VARS` 并行、
  必须同步维护」的白名单表（`textScale` 的键要在两处各写一遍）。
  改成显式映射后，**映射本身就是白名单** —— 键不在映射里就不写，
  注入安全性不变（`theme.ts` 原本的注释说明白名单是为了防「键名逃出 CSS 声明」，
  显式映射同样满足这一点，因为能写出去的键必须逐个列在映射里）。
  **少一处必须同步的东西。**
- ⚠️ **`buildThemeCss`（服务端拼 `:root`）与 `applyTokens`（客户端 `setProperty`）
  两处都要改**，它们共用 `GROUP_CSS_VARS`，改动是同一处。
- ⚠️ `theme-watcher.tsx` 也要跟着改（它 import 了 `GROUP_CSS_VARS` 与 `GROUP_KEYS`，
  `GROUP_KEYS` 删掉后它的 import 与白名单判断都要一起改）。

#### 4.2.5 商家后台：**不需要**新建映射表

`merchant-admin` 目前**没有** `lib/theme.ts`，也不需要新建。

⚠️ **初稿以为「预览需要 token → CSS 变量名的映射，所以要复制一份 storefront 的」——
这是多余的**：后端 `/theme/schema` 返回的 schema 里，**每个 token 的 `cssVar` 已经是
完整的变量名**（`TEXT_SCALE_TOKENS` 里是 `--text-xs`、`SPACING_TOKENS` 里是 `--spacing-xs`，
**都是全名不是前缀**）。schema 本身就是那张映射表。

→ 预览直接读 `schema.colors[i].cssVar` / `schema.textScale[i].cssVar` /
`schema.spacing[i].cssVar` 即可，**不新建文件、不用 `diff` 校对、少一处漂移源**。

⚠️ 但要注意一个**前提**：`theme-form.tsx` 的 `draft` 结构是
`{ colors: {...}, radius, fontSans, fontMono, textScale: {...}, weights: {...}, spacing: {...}, shadows: {...} }`，
而 schema 的分组名是 `colors / radius / fonts / textScale / weights / spacing / shadows`
（**`fonts` vs 顶层 `fontSans`/`fontMono` 不一致**）→ 预览拼变量名时要处理这个映射差异。

### 4.3 5d-2：商家后台实时预览

#### 4.3.1 预览的隔离机制

CSS 变量是**继承**的 → 在预览区外面包一个带内联 `--brand-*` 的 wrapper：

```tsx
<div style={previewStyle} className="rounded-lg border p-4">
  {/* 预览内容 */}
</div>
```

内联样式的变量**只在这个子树内生效**，后台页面自身的 `--brand-*`（未注入 → 用 fallback）
不受影响 ✅

#### 4.3.2 预览内容

一个「店铺风格的简化片段」：顶栏（主色底 + 主色上文字）+ 商品卡片（圆角、阴影、字阶、字重）。
用标准 Tailwind 类（`bg-primary` / `text-primary-foreground` / `rounded-lg` /
`shadow-lg` / `text-sm` / `font-semibold` / `font-sans`）→ **正好覆盖六组 token**。

⚠️ **不复制 storefront 的组件**：merchant-admin 与 storefront 不共享代码，
复制组件会带来同步负担。预览区用最小的内联 JSX 即可。

#### 4.3.3 颜色输入框

现状：颜色是 `oklch(...)` 字符串的**纯文本输入框**（`theme-form.tsx` 用
`renderScalars('colors', schema.colors)` 渲染，与其它组同款）。
5d 不改这个（改色选择器是新功能）→ 但**预览区让「改颜色」这件事第一次有了反馈**。

#### 4.3.4 draft 变化 → 实时更新

`theme-form.tsx` 的 `draft` state 每次变化 → 重算 `previewStyle` → 内联样式更新。
⚠️ **`draft` 里没被商家碰过的字段是 `initial` 的值**（后端 sanitize 后的值）→ 预览完整。

⚠️ **预览只保证「商家后台内立即可见」**。**前台**（storefront）仍靠
`ThemeWatcher` 的 30 秒轮询拿到新主题 —— 这是既有的机制，本阶段不动它。
换句话说：实时预览解决的是「商家改主色时自己都看不到变化」，
不解决「前台要等 30 秒」。要缩短前台延迟属于另一件事（推送 / 失效广播），
不在本阶段范围。

#### 4.3.5 测试基建

预览区是**客户端组件** → 组件测试需要 jsdom。
`merchant-admin` 当前**没有** `jsdom` / `@testing-library/*` 依赖。

5d 补齐（照搬 `platform-admin` 的现成方案）—— **4 样，缺一不可**：

1. **依赖**：`package.json` 的 `devDependencies` 加
   `@testing-library/react@^16.3.3` / `@testing-library/jest-dom@^7.0.1` /
   `@testing-library/user-event@^14.6.8` / `jsdom@^30.1.3`
   （版本与 `platform-admin` 逐字一致）
2. **`merchant-admin/test/setup.ts`**：与 `platform-admin/test/setup.ts` **字节级一致**
   （`import '@testing-library/jest-dom/vitest'` + `import { cleanup }` +
   `afterEach(() => cleanup())`）。⚠️ `cleanup` 必须显式调 —— 本项目
   `globals: false`，全局 `afterEach` 不存在，RTL 的自动 cleanup 不会注册
3. **`vitest.config.ts` 加 `setupFiles: ['./test/setup.ts']`** ← ⚠️ **初稿漏了这一条**
   （merchant-admin 的配置里**根本没有 `setupFiles` 这一项**；初稿说的「第 60 行」
   指的是 platform-admin 的，而 platform-admin 的 `test/setup.ts` 是**存在**的）
4. **`vitest.config.ts` 加 `esbuild: { jsx: 'automatic' }`** ← ⚠️ **初稿也漏了这一条**
   必须写在**配置的根级**（不能写在 `test` 下面）。⚠️ **缺了它，所有组件测试会报
   `React is not defined`** —— 本项目 tsconfig 是 `"jsx": "preserve"`（Next.js 用 SWC），
   而 esbuild 不读 tsconfig 的 jsx 设置，默认走 classic transform。
   `storefront` 与 `platform-admin` 的配置里都有这一条，merchant-admin 没有。

另外：`vitest.config.ts` 的 `include` 从 `test/**/*.test.ts` 扩成
`test/**/*.test.{ts,tsx}`；组件测试文件首行加 `// @vitest-environment jsdom`
（逐文件的环境注释优先于全局配置）。

⚠️ **`storefront` 的测试基建已经齐了，不要动**：
它的 `vitest.config.ts` 的 `include` **已经是** `test/**/*.test.{ts,tsx}`
（阶段 4 已扩，注释里写着「⚠️ 扩到 .tsx」），`test/setup.ts` 也存在。
⚠️ **初稿说「storefront 的 include 不含 .tsx，要加」是错的** —— 照做会是一次
无意义改动，甚至可能覆盖掉已经正确的配置。

### 4.4 5d-3：前端错误处理收口

#### 4.4.1 唯一的收口点：`api-client.ts`

三个应用的 `api-client.ts` 各自改（无 monorepo 共享包）。三份的结构一致，
且 **`request()` 是唯一的 fetch 出口**（`apiFetch` 与 `apiFetchWithSetCookie` 都调它），
`new ApiError(...)` 也只在 `request()` 里出现一次 → **每份文件只改两个地方**。

```ts
/** 网络不可达时的用户可见文案。 */
const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

/**
 * 把后端返回的消息翻成用户能看懂的中文。
 *
 * ⚠️ 只翻译后端的**默认文案**（Nest 的 'Unauthorized'），
 * 不动后端主动抛的中文消息（'刷新令牌无效或已过期'）——
 * 那些消息比通用文案更具体，翻译会丢掉信息。
 */
function localizeApiMessage(status: number, message: string): string {
  if (status === 401 && message === 'Unauthorized') {
    return '登录已过期，请重新登录';
  }
  return message;
}
```

`request()` 里的 fetch 包 try/catch：

```ts
let response: Response;
try {
  response = await fetch(`${API_BASE_URL}${path}`, { /* …原样… */ });
} catch {
  // 网络层失败：后端根本没连上，不是业务错误。
  // ⚠️ 收敛成 ApiError 是关键——所有渲染点写的是 `cause.message`，
  //    不收敛的话用户看到的就是原始的 "TypeError: fetch failed"。
  throw new ApiError(503, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
}
```

构造 `ApiError` 时用 `localizeApiMessage(status, message)` 替换原始 message：

```ts
throw new ApiError(
  response.status,
  payload.code ?? 'UNKNOWN',
  localizeApiMessage(response.status, payload.message ?? '请求失败'),
  payload.details,
);
```

✅ **结果：76 个渲染点零改动**，用户看到中文。

⚠️ **顺带清理**：`storefront/src/lib/route-helpers.ts` 的 `readableMessage()`
（把 `401 + 'Unauthorized'` 翻成「登录已过期」）在 5d 之后**变成死代码** ——
错误在 `api-client` 就已经翻译过了，`readableMessage` 判断的
`error.message === 'Unauthorized'` 永远不成立。→ **删掉它**，同时删掉
`route-helpers.ts` 里对它的调用。⚠️ 按「外科手术式改动」原则，
只删因本次改动而失效的部分，不动 `route-helpers.ts` 的其它逻辑。

#### 4.4.2 结算页的购物车误报

`storefront/src/app/(shop)/checkout/page.tsx`：

```ts
const [{ cart, error: cartError }, { addresses, error: addressError }] =
  await Promise.all([...]);
// ⚠️ 后端不可达时 fetchCurrentCart 返回 { cart: null, error: '…' }。
//    之前不读 error，直接把 cart === null 当成「空购物车」→ 把用户弹回购物车页，
//    错误信息在跳转中丢失。
if (cartError) {
  return <ErrorState message={cartError} />;
}
if (!cart || (cart.items ?? []).length === 0) {
  redirect('/cart');
}
```

`fetchCurrentCart()` / `fetchAddresses()` 的返回类型**已经**带 `error` 字段
（`shop-api.ts:43-46` 与 `:67-70`），只是页面没读。

⚠️ **`addressError` 要一起处理**（同一类缺陷、同一个函数）：
`fetchAddresses` 失败时返回 `{ addresses: [], error: '…' }`，
页面现在把它当「没有地址」→ 结算表单里地址选择框是空的，
用户看到的只是「没法下单」，没有任何原因提示。
→ 两个 error 都渲染成错误态。

#### 4.4.3 layout 的登录判据

`storefront` 的 6 处 + `platform-admin` 的 1 处：`if (!session)` →
`if (!session?.accessToken)`。

⚠️ 理由：`jwt-callback.ts` 的凭证失效分支把 `accessToken` 置为 `undefined`，
但 `session` 对象仍在 → `!session` 不成立 → **不跳登录页**，而是带着空 token
去请求 → 401 → 页面显示 `Unauthorized`。改成判 `accessToken` 后，
会话失效会**直接跳登录页**（与 merchant-admin 一致）。

#### 4.4.4 错误边界

三个应用各加两个文件：

- `src/app/error.tsx`（段级）：`'use client'`，接 `{ error, reset }`，
  渲染中文提示 + 「重试」按钮（调 `reset()`）。
- `src/app/global-error.tsx`（根级）：接 `{ error, reset }`，
  **自带 `<html><body>`**（不能用 app 的 layout），自包含内联样式。

⚠️ `global-error.tsx` 里不要 import 任何 app 内的东西（含 globals.css）。

#### 4.4.5 storefront 的空 body 处理

`storefront/src/lib/api-client.ts` 的 `apiFetch:28` 与 `apiFetchWithSetCookie:122`
两处直接 `response.json()`，后端返回空 body 时抛 `Unexpected end of JSON input`，
被当成「加载失败」。另两个应用已有「空 body 当 null」的处理 → 补齐这两处。

---

## 五、风险清单

### 5.1 正确性风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | ~~`@theme inline` 里的阴影复合值能否正常内联~~ | ✅ **已实测（A1）**：含逗号与嵌套 `var()` 的复合值被正确内联。**风险解除**，不需要手写 `@utility shadow-sm` 的 fallback |
| R2 | ~~`--default-font-family` 的内联行为~~ | ✅ **已实测（A2）**。⚠️ **最终实现换了机制**：`@theme inline { --font-sans: var(--brand-font-sans); }`（不带 fallback）+ `@layer base { html { @apply font-sans; } }`，配合 next/font 的变量挪到 `<html>`（见 §4.2.2）。**风险解除** |
| R3 | 改 `--brand-*` 后，运行时注入与 `globals.css` 的 `:root` **顺序**决定胜负 | 现状（颜色生效）已实测该顺序成立；用浏览器手测复核 |
| R4 | 间距改成单一基础值后，全站间距会整体变化 | 默认值仍是 `0.25rem` → 商家不改就零变化；改了就是「全局密度」语义 |
| R5 | 阴影默认值改成 Tailwind 内置值后，老租户的 `stores.themeTokens` 里存着旧默认值 | ⚠️ **老数据里的阴影值是「已保存的旧默认」**，会覆盖新默认值 → 老租户阴影比新的略浅。**可接受**（视觉差异极小），记入遗留 |
| R6 | **投递的位置不能前移** —— 前移会让任务早于 `payExpiresAt` 触发并被跳过 | 已核实 `order-timeout.service.ts:86` 的「还没到期限」分支 `return false`，且任务被消费后**不重试** → 订单永远不释放、库存卡死。投递保持在事务之后（D8），详见 §4.1.2 |
| R7 | `/health` 探活若自身超时过长，会拖慢容器的 healthcheck | 探活超时设 2 秒，healthcheck 的 `interval` 保持现状。⚠️ 且**必须用独立短连接**（禁用重试），不能用 BullMQ 那个无限重试的实例（§4.1.4） |
| R8 | `.dark` 块改名成 `--brand-*` 后，将来若启用 dark 模式，`.dark` 的值会盖掉商家注入的 `:root` 值 | dark 模式**当前从未启用**（全仓无 `.dark` 类的写入点）→ 5d 内零影响；将来启用时必须重做主题分层 → 记入遗留 L11 |
| R9 | **同一份默认值存在两处**：后端 `theme-tokens.ts` 的 `defaultValue` 与 `globals.css` 的 `:root` | 商家清空某字段后外观会跳变（两处不一致时）→ 两处**同一次提交**里一起改；后端那份是「接口返回什么」，前端那份是「没人注入时用什么」 |
| R10 | merchant-admin 的组件测试基建缺 `esbuild: { jsx: 'automatic' }` | 缺了会**全部**报 `React is not defined`（tsconfig 是 `"jsx": "preserve"`，esbuild 不读它）→ 照 platform-admin 的配置补齐（§4.3.5） |
| R11 | 全站只认 `--brand-*` 后，任何漏改的消费者会拿到**空值**而不是旧值 | 改完用 `grep -n -- "--primary\|--background\|--radius" globals.css` 确认没有残留裸名（护栏 G15）；再跑浏览器手测 |
| R12 | `addRepeating` 超时 → `onModuleInit` 抛异常 → **进程启动失败** | 这是期望行为（周期任务没注册 = 账目与令牌清理不跑，不如快速失败）。现状是「永远卡在 bootstrap、无任何提示」→ 5d 之后变成「3 秒后明确报错退出」。⚠️ 容器编排会把它判 unhealthy 并可能反复重启 —— 那是正确的：Redis 恢复后自动起来 |

### 5.2 设计阶段的疏漏（本轮自查已修掉）

| # | 疏漏 | 修法 |
|---|------|------|
| S1 | 初稿打算把 `--brand-*` 改名与「保留 shadcn 裸名 `--primary`」并行 | shadcn 组件**只有一处**直接用裸变量（`button.tsx:14` 的 `color-mix`）→ 改成 `var(--brand-secondary)` / `var(--brand-foreground)` 即可，`:root` 里不必保留裸名 |
| S2 | 初稿以为「字阶/字重没有消费者」，据此打算补 `@theme inline` 桥接 | 实测证明它们**已经生效**（同名覆盖）→ 若再补桥接会**破坏**现有行为；统一到 `--brand-*` 后桥接自然补上，不需要额外动作 |
| S3 | 初稿打算让「间距」也走 `--spacing-*` 刻度 | Tailwind 4 无此命名空间 → 改为单一基础值（D3） |
| S4 | 初稿把 webhook 投递也前移 | webhook 是「支付成功后」的**通知**，前置无意义 → 改为捕获 + 记日志（D9） |
| S5 | 初稿把颜色 token 写成「16 个」 | CSS 侧是 **32** 个命名空间（见 §2.3.1）→ 全部改名；只有 16 个进后端 schema |
| S6 | 初稿漏了 `destructive-foreground` 这个**空 token** | 商家配了不生效，与目标 1.1 冲突 → 补 `--color-destructive-foreground` 映射 + `:root` 默认值 |
| S7 | 初稿漏了 `.dark` 块（32 个裸名） | 一起改名（§4.2.1），否则留下孤儿声明 |
| S8 | 初稿说「storefront 的 vitest include 不含 .tsx，要加」 | **事实错误**：阶段 4 已改成 `test/**/*.test.{ts,tsx}` → 不动 |
| S9 | 初稿说 merchant-admin「`vitest.config.ts:60` 引用的 setup.ts 不存在」 | **事实错误**：merchant-admin 的配置里根本没有 `setupFiles`；第 60 行那个是 platform-admin 的（而它的 setup.ts 存在）→ 正确结论是「merchant-admin 缺 `setupFiles` 条目 + 缺 `esbuild.jsx` + include 不含 .tsx + 缺 4 个依赖」 |
| S10 | 初稿的 `@theme inline` 例子带 fallback，紧接着又说「不需要写 fallback」 | 自相矛盾，且默认值存两份会漂移 → **统一不带 fallback**，默认值只存 `:root`（A5） |
| S11 | 初稿要新建 `merchant-admin/src/lib/theme.ts` 给预览做映射 | 多余：后端 schema 的 `cssVar` **已经是完整变量名** → 预览直接读 schema（§4.2.5） |
| S12 | 初稿保留了 `GROUP_CSS_VARS`（前缀）与 `GROUP_KEYS`（白名单）两个平行结构 | 两个必须同步维护的表 → 改成「组 → 键 → 变量名」的显式映射，**`GROUP_KEYS` 整个删掉**（映射即白名单） |
| S13 | 初稿的 D8 是「把队列投递**前移**到事务之前」，并把它当成显然的改进 | 前移会**破坏超时释放的时序**：任务早于 `payExpiresAt` 触发 → 被 `order-timeout.service.ts:86` 的「还没到期限」分支跳过，且任务被消费后不重试 → **订单永远停在待支付、库存永久卡在预占**。改为「**投递留在事务后 + 失败不抛**」（D8）。⚠️ 这是初稿与「投递前移」方案**都**没发现的约束 |

---

## 六、测试策略

### 6.1 护栏清单

| # | 护栏 | 验证方式 |
|---|------|---------|
| G1 | 商家改**主色** → 前台 `.bg-primary` 的计算值改变 | 浏览器手测 + storefront 主题单测（`buildThemeCss` 产物断言） |
| G2 | 商家改**字体** → 前台 `font-family` 改变 | 浏览器手测（**这是 5d 之前完全失效的一项**） |
| G3 | 商家改**字阶** → `.text-sm` 计算字号改变 | 浏览器手测 |
| G4 | 商家改**字重** → `.font-semibold` 计算字重改变 | 浏览器手测 |
| G5 | 商家改**阴影** → `.shadow-sm` 计算 box-shadow 改变 | 浏览器手测（**5d 之前完全失效**） |
| G6 | 商家改**间距** → `.p-4` 计算 padding 改变 | 浏览器手测（**5d 之前完全失效**） |
| G7 | 商家后台改主色 → **预览区立刻变色**，后台自身按钮**不变色** | merchant-admin 组件测试（jsdom） |
| G8 | 后端不可达 → 页面显示中文，**不出现 `fetch failed`** | 前端单测（mock fetch 抛 TypeError） |
| G9 | 后端返回 401 → 页面显示「登录已过期」而非 `Unauthorized` | 前端单测 |
| G10 | 后端返回 401 且 `accessToken` 为空 → **跳登录页**，不显示错误 | storefront 单测 / 浏览器手测 |
| G11 | 结算页后端不可达 → **显示错误**，不 `redirect('/cart')` | storefront 单测 |
| G12 | Redis 不可达 → 下单**不会永久挂住**（3 秒内返回；订单已建成且可支付） | api 单测（mock QueueService 抛超时 → 断言 200 + 订单存在）+ e2e |
| G13 | `/health` 在 Redis 不可达时返回 **degraded / 503**，**且探活本身不会挂住** | api 单测（Redis 不可达时 `/health` 必须在 2 秒内返回） |
| G14 | 商家改 `destructiveForeground` → `--color-destructive-foreground` 生效（**5d 之前是空 token**） | 浏览器手测 |
| G15 | `globals.css` 里**不再有**任何 shadcn 裸名（`--primary`/`--background`/`--radius`…） | `grep` 断言 + 三个前端文件的 shasum 仍一致 |
| G16 | 结算页**地址**加载失败 → 显示错误，而不是给一个空的地址选择框 | storefront 单测 |
| G17 | 下单时队列投递失败 → **不出现「用户看到失败、订单却建好了」的矛盾态**（订单建成即返回成功） | api 单测（mock QueueService 抛超时 → 断言 200 + 订单存在 + 有一条 error 日志） |
| G18 | merchant-admin 的组件测试能跑起来（不报 `React is not defined`） | 跑一次组件测试 |
| G19 | Redis 在**启动时**不可达 → 进程在 ~3 秒内**明确报错退出**（不是静默卡在 bootstrap） | 停掉 Redis → 启动 api → 看日志与退出码 |

### 6.2 失败注入清单

| # | 注入 | 预期挂掉 |
|---|------|---------|
| I1 | 从 `@theme inline` 删掉 `--color-primary` 映射 | G1 |
| I2 | 把 `--font-sans` 改回自引用 | G2 |
| I3 | 从 `@theme inline` 删掉 `--text-sm` | G3 |
| I4 | 从 `@theme inline` 删掉 `--font-weight-semibold` | G4 |
| I5 | 从 `@theme inline` 删掉 `--shadow-sm` | G5 |
| I6 | 从 `@theme inline` 删掉 `--spacing` | G6 |
| I7 | 预览区去掉 wrapper 的内联变量 | G7 |
| I8 | `api-client` 去掉 fetch 的 try/catch | G8 |
| I9 | `api-client` 去掉 401 翻译 | G9 |
| I10 | layout 判据改回 `!session` | G10 |
| I11 | 结算页去掉 `cartError` 分支 | G11 |
| I12 | 去掉队列超时包装 | G12 |
| I13 | `/health` 改成静态返回 ok | G13 |
| I14 | 从 `@theme inline` 删掉 `--color-destructive-foreground` | G14 |
| I15 | 在 `:root` 里留一个 `--primary` 裸名 | G15 |
| I16 | 结算页去掉 `addressError` 分支 | G16 |
| I17 | 把队列投递失败改成向上抛（制造「失败但订单建了」） | G17 |
| I18 | 从 merchant-admin 的 vitest 配置里删掉 `esbuild.jsx` | G18 |
| I19 | 去掉 `addRepeating` 的超时包装 | G19 |

### 6.3 浏览器手测清单

1. 商家后台改主色 → 预览区变 → 保存 → 切到 storefront → 主色已变
2. 商家后台改字体 → 预览区字体变 → 保存 → storefront 字体已变
3. 商家后台改字阶/字重/阴影/间距 → 预览区对应变化 → storefront 对应变化
4. 商家后台自身的按钮颜色**不随**店铺主题变化
5. 停掉后端 → storefront 首页显示中文错误，**无 `fetch failed`**
6. 停掉后端 → 结算页显示中文错误，**不跳回购物车页**
7. 让 accessToken 失效 → storefront 跳登录页，**不显示 `Unauthorized`**
8. 停掉 Redis → 下单**不转圈**（按 §4.1.2 选定的形态返回）；`/health` 返回 degraded
9. 商家后台改 `destructiveForeground` → storefront 的 `.text-destructive-foreground` 生效
10. 三个前端的 `globals.css` 内容一致（shasum 相同），且页面**没有**任何裸变量残留
11. 停掉后端 → 结算页地址区显示中文错误（不是空的地址选择框）
12. 停掉 Redis 再启动 api → 容器日志 ~3 秒内有明确报错并退出（不是静默卡住）

---

## 七、遗留项

| # | 遗留 | 说明 |
|---|------|------|
| L1 | webhook 投递失败后的补偿 | 5d-0 只做到「不报失败 + 记日志」，通知丢失没有补偿机制 |
| L2 | 老租户已保存的旧阴影默认值 | 视觉差异极小，不做数据迁移 |
| L3 | 抽佣流水明细 | 属阶段 5e |
| L4 | `merchant-admin` 的 `jwt-callback.ts` 原地修改 token 对象 | 5c 遗留项，断言无法区分「原地改」与「返回新对象」 |
| L5 | 跨副本分布式刷新锁 + `inFlightRefreshes` 换 Redis 锁 | 扩副本前必须做 |
| L6 | 宽限期长度对多副本时钟偏差的容忍 | 扩副本前确认 60 秒窗口够用 |
| L7 | 前端颜色选择器 | 现在是 `oklch(...)` 纯文本输入框，可读性差；属新功能 |
| L8 | `platform-admin` 的租户主题配置页 | 页面根本不存在，属新功能 |
| L9 | 「改密码」时吊销令牌族 | 当前没有改密端点 |
| L10 | 三个前端重复的 `api-client.ts` / `theme.ts` | 无 monorepo 共享包，是项目现状；已用「字节级副本 + `diff` 校对」的纪律管理 |
| L11 | **dark 模式从未启用**；5d 把 `.dark` 块改名成 `--brand-*` 后，将来启用 dark 会盖掉商家主题 | 全仓没有给 `<html>` 加 `.dark` 类的代码；启用 dark 时必须重做主题分层（`.dark` 不该覆盖商家的 `--brand-*`） |
| L12 | **Redis 长时间不可用**时，支付超时释放任务可能丢失（订单卡在待支付、库存卡在预占） | 5d-0 只做到「请求不再挂死」；底层 `queue.add()` 没被取消，Redis 恢复后通常会补上，但进程重启就真丢 → 与 L1 同一套补偿机制 |
| L13 | **商家改字号时，行高比例不跟随** | Tailwind 的 `--text-sm--line-height: calc(1.25 / 0.875)` 是**硬编码的比例**（分母是主题里的固定值，不是商家的值）。商家把 `--brand-text-sm` 从 `0.875rem` 改成 `1rem`，字号变了但比例仍是 1.4286。⚠️ **修不了**：`calc(1.25 / var(--brand-text-sm))` 非法（CSS 不允许除以长度）。要跟随就得定一个「比例跟着字号变还是不变」的产品策略 |
| L14 | **Tailwind 内置的阴影刻度（`shadow-md` / `shadow-xl` …）商家配不了** | 5d 把 storefront 唯一一处 `shadow-md` 改成了 `shadow-base`（走 `--brand-shadow-base`），但**新写的代码若再用内置刻度就会重新失效**。要根治得让商家能配全部刻度，或在代码规范里禁用 |
| L15 | **merchant-admin 的 42 处 API 路由仍用 `!session`** | 会话失效时它们放行 → 带着空 token 请求 → 后端 401 → 被 `localizeApiMessage` 翻成「登录已过期」。**结果正确**（用户看到中文），只是多一次无用往返，且不像 storefront 那样本地跳登录。设计文档 §4.4.3 明确只列了 storefront 6 处 + platform-admin 1 处，merchant-admin 不在范围内 |
| L16 | **部分 token 在 storefront 没有消费者** → 商家配了看不到效果 | `shadow-sm` / `shadow-lg` / `text-destructive-foreground` 在 storefront 源码里**没有任何元素使用** → Tailwind 按使用扫描**不生成**对应 utility → 即使变量已接通（编译产物里 `--color-destructive-foreground: var(--brand-destructive-foreground)` 存在），页面上也看不到变化。**机制通、消费者缺**。5d 已把 storefront 唯一一处 `shadow-md` 改成 `shadow-base`，其余内置刻度仍不可配（L14） |

---

## 附：与既有设计的关系

- **阶段 4**（前端补齐）：本阶段做的是它 §7 遗留清单里「主题改动后前台实时生效」那条的**后续**，
  并修正了它对「分组标量无消费者」的判断（见 §2.3）。
- **阶段 5b**（平台计费）：本阶段不碰计费；5b 遗留的「换套餐周期长度语义」经探查确认**已闭合**
  （`renewal.service.ts:100-115` 用 pending 套餐的 `periodDays`，e2e 有覆盖），
  「M11 可观测性」的实际缺口只是**缺日志**，归入 5e。
- **阶段 5c**（宽限期）：本阶段不碰令牌逻辑；5c 遗留的「Redis 不可达时 API 静默挂死」
  被插队到本阶段的 5d-0。
