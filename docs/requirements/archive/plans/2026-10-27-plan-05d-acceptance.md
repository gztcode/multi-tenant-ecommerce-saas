# 阶段 5d 验收记录

**阶段**：5d —— 主题变量统一（`--brand-*`）+ 前端错误处理收口 + Redis 挂死修复
**范围**：`5ccccdf`（阶段 5c 收尾）→ 本记录，共 **22 个提交**（不含本验收记录自身）
**依据**：`docs/superpowers/specs/2026-10-27-plan-05d-theme-and-error-handling-design.md`（修订版 `85f089a`）
**计划**：`docs/superpowers/plans/2026-10-27-plan-05d-theme-and-error-handling.md`（含 §0.5 勘误表 E1–E28）

---

## 一、自动化测试结果

| 项目 | 用例数 | 结果 |
|------|--------|------|
| api（Jest） | 179 | ✅ 全过（12 suites） |
| storefront（Vitest） | 209 | ✅ 全过（22 files） |
| merchant-admin（Vitest） | 207 | ✅ 全过（16 files） |
| platform-admin（Vitest） | 185 | ✅ 全过（7 files） |
| **合计** | **780** | ✅ |

**类型检查**：四个项目 `tsc --noEmit` 全部无输出 ✅
**构建**：三个前端 `next build` 全部 `✓ Compiled successfully` ✅（唯一输出是 `error` 形参未使用的 ESLint warning —— Next 约定文件必须保留该形参，且仓库无 `--max-warnings`、无 CI 配置，不阻断）
**后端 e2e**：`npm run test:e2e -- health.e2e-spec` → 2/2 ✅

### 1.1 新增/改动的测试

| 文件 | 用例数 | 覆盖 |
|------|--------|------|
| `api/src/modules/queue/queue.service.spec.ts` | 5 | 三个投递方法的超时保护 + 「非超时错误原样抛出」 |
| `api/src/modules/theme/theme-tokens.spec.ts` | 6 | 命名空间、唯一性、间距单值、阴影默认值、`isValidScalarValue` 真调用、`destructiveForeground` |
| `api/src/health/health.service.spec.ts` | 4 | 两项探活的四种组合 |
| `api/src/health/redis-probe.spec.ts` | 4 | 「未就绪时先等 ready 再 PING」的回归防护 |
| `storefront/test/app/globals-css.test.ts` | 9 | 两层结构的形状约束（32 个颜色、无裸名、无 fallback、阴影默认值逐字一致…） |
| `storefront/test/app/layout-font.test.ts` | 2 | 字体变量 class 在 `<html>` 上、不在 `<body>` 上 |
| `storefront/test/lib/api-client.test.ts` | 8 | 网络错误 / 401 / 空 body / 204 / 正常解析（三份逐字节一致） |
| `storefront/test/app/checkout-page.test.tsx` | 3 | 空车 vs 加载失败 vs 地址加载失败 |
| `storefront/test/app/error-boundary.test.tsx` | 2 | 中文兜底 + 不泄漏 `error.message` |
| `merchant-admin/test/components/theme/theme-form.test.tsx` | 3 | 预览区实时联动 + 页面自身按钮不受影响 |

---

## 二、浏览器手测（12 条，真实环境）

**环境**：本机 docker 栈（`infra/docker-compose.yml`），容器**用本阶段的新代码重建过**（`docker compose up -d --build api storefront merchant-admin platform-admin`）。
**访问**：storefront `http://localhost:3001`、商家后台 `http://localhost:3002`、api `http://localhost:3000`。
**账号**：商家 `owner@demo.platform.test / Demo12345!`、消费者 `customer@demo.platform.test / Demo12345!`。
**浏览器**：ego lite（`ego-browser nodejs < script.mjs`）。全程未抢占前台；手测结束后关闭了全部 3 个标签页并把 demo 店铺的主题改回原值。

| # | 手测项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 商家后台改**主色** → 预览区变 → 保存 → storefront 主色已变 | ✅ | 预览区 `--brand-primary: oklch(0.7 0.19 40)`，预览按钮 `background-color: oklch(0.7 0.19 40)`；保存后后端 `themeTokens.colors.primary = oklch(0.7 0.19 40)`；storefront 服务端注入的 `:root` 含该值，探针元素 `.bg-primary` 计算值 = `oklch(0.7 0.19 40)` |
| 2 | 商家后台改**字体** → 预览区字体变 → 保存 → storefront 字体已变 | ✅ | 预览区 `<p class="font-sans">` 的 `font-family` = `Georgia, serif`；storefront 的 `html`/`body`/`p.font-sans` 计算字体均为 `Georgia, serif` |
| 3 | 商家后台改**字阶 / 字重 / 阴影 / 间距** → 预览区对应变化 → storefront 对应变化 | ✅ | 预览区：字号 `20px`（= 1.25rem）、字重 `800`、卡片 `box-shadow: rgba(255,0,0,.5) 0 20px 30px -10px`；storefront 探针：`.text-sm` → `20px`、`.font-semibold` → `800`、`.p-4` → `32px`（= `0.5rem × 4`） |
| 4 | 商家后台自身的按钮颜色**不随**店铺主题变化 | ✅ | 「保存主题」按钮所在作用域的 `--brand-primary` = `oklch(20.5% 0 0)`（`:root` 默认值），预览区里才是 `oklch(0.7 0.19 40)` |
| 5 | 停掉后端 → storefront 首页显示中文错误，**无 `fetch failed`** | ✅ | 首页正文 = 「网络连接失败，请检查网络后重试」，`hasFetchFailed: false` |
| 6 | 停掉后端 → 结算页显示中文错误，**不跳回购物车页** | ✅ | 结算页正文 = 「网络连接失败，请检查网络后重试」，`location.pathname` 仍为 `/checkout`（未跳 `/cart`） |
| 7 | 让 accessToken 失效 → storefront 跳登录页，**不显示 `Unauthorized`** | ⚠️ **部分验证** | 代码路径由单测与类型检查覆盖（`!session?.accessToken`）；浏览器侧未构造出「会话对象仍在但 accessToken 为空串」的状态（见 §五-3） |
| 8 | 停掉 Redis → 下单**不转圈**；`/health` 返回 degraded | ✅ | Redis 停后 `/health` → `{"status":"degraded","checks":{"redis":false,"database":true}}` **HTTP 503**，响应耗时 1.38s（探活 2s 预算内）；api 容器存活；容器健康检查 `FailingStreak` 累加到 11 后转为 **unhealthy** |
| 9 | 商家后台改 `destructiveForeground` → storefront 的 `.text-destructive-foreground` 生效 | ⚠️ **机制通、但前台无消费者** | 编译产物里有 `--color-destructive-foreground: var(--brand-destructive-foreground)`（机制接通 ✅）；但 storefront 源码里**没有任何元素用 `text-destructive-foreground`** → Tailwind 按使用扫描不生成该 utility → 前台看不到变化。记为遗留 **L16** |
| 10 | 三个前端的 globals.css 内容一致，页面无裸变量残留 | ✅ | 三份 `shasum` 同为 `ab00c18048759788c7f45b7d4ec836b8914fbf1d`；`globals-css.test.ts` 断言 `:root`/`.dark` 里只有 `--brand-*` |
| 11 | 停掉后端 → 结算页地址区显示中文错误（不是空的地址选择框） | ✅ | 与第 6 条同一次实测：结算页正文 = 「网络连接失败，请检查网络后重试」 |
| 12 | 停掉 Redis 再启动 api → 日志 ~3 秒内有明确报错并退出 | ✅ | 日志：`ServiceUnavailableException: 队列操作超时：auth/cleanup`（栈：`QueueService.withQueueTimeout` → `addRepeating` → `TokenGraceService.onModuleInit` → `callModuleInitHook`）→ 进程退出码 1 → 容器 `Restarting (1)` |

### 2.1 容器状态已复原

手测期间停过 api 与 Redis，均已恢复：`ecommerce-api Up (healthy)`、`ecommerce-redis Up (healthy)`、`/health` → `{"status":"ok",...}` HTTP 200 ✅
**demo 店铺的主题已改回原值**（`{colors:{primary:'oklch(0.205 0 0)'}, radius:'0.625rem', textScale:{base:'1rem'}}`）✅

---

## 三、机制级验证

### 3.1 主题链路的六个环节

用真实浏览器 + 真实容器逐环验证（不是读代码推断）：

```
后端 theme-tokens.ts 的 cssVar (--brand-*)
  → 前端 lib/theme.ts 的映射表（同一份被 buildThemeCss 与 theme-watcher 共用）
  → globals.css 的 @theme inline（--color-* → var(--brand-*)）
  → globals.css 的 :root 默认值（唯一一处）
  → 运行时注入（服务端内联 <style> 的裸 :root）
  → Tailwind utility（编译产物实测）
```

**编译产物实测**（`storefront/.next/static/css/`）：

```css
.bg-primary    { background-color: var(--brand-primary); }
.text-sm       { font-size: var(--brand-text-sm); }
.font-semibold { font-weight: var(--brand-font-weight-semibold); }
.p-4           { padding: calc(var(--brand-spacing) * 4); }
.shadow-base   { --tw-shadow: var(--brand-shadow-base); }
.hover\:shadow-base:hover { --tw-shadow: var(--brand-shadow-base); }
```

**注入面**：恶意键名（如 `tokens.textScale['sm; } body{']`）在 `GROUP_CSS_VARS` 的显式映射下**拼不出任何声明**（映射即白名单）—— 与改造前的「前缀 + 键白名单」等价，但少一张必须同步维护的表。

### 3.2 失败注入复验（12 条）

全部由各自的单测承担，且**审查阶段用变异测试逐条复验过**（把被测分支改坏 → 对应用例必须挂）：

| # | 注入 | 复验方式 | 结果 |
|---|------|---------|------|
| I1–I6 | 删掉 `@theme inline` 里的 `--color-primary` / `--font-sans` 自引用 / `--text-sm` / `--font-weight-semibold` / `--shadow-sm` / `--spacing` | `globals-css.test.ts` 逐条断言 | ✅ 挂 |
| I7 | 预览区去掉 wrapper 的内联变量 | 变异测试：`style={previewStyle}` 挪到外层 `<section>` | ✅ 挂 |
| I8 | `api-client` 去掉 fetch 的 try/catch | 变异测试 | ✅ 挂 2 条 |
| I9 | `api-client` 去掉 401 翻译 | 变异测试 | ✅ 挂 |
| I10 | layout 判据改回 `!session` | `layout-font.test.ts` 的静态断言 + 代码审查 | ✅ 挂 |
| I11 | 结算页去掉 `cartError` 分支 | 变异测试 | ✅ 挂 |
| I12 | 去掉队列超时包装 | `queue.service.spec.ts` | ✅ 挂 3 条 |
| I13 | `/health` 改成静态返回 ok | `health.service.spec.ts` + e2e | ✅ 挂 |
| I14–I19 | 删 `--color-destructive-foreground` / 留裸名 / 去掉 `addressError` 分支 / 投递失败向上抛 / 删 `esbuild.jsx` / 去掉探活超时 | 逐条单测 + 变异测试 | ✅ 挂 |

**变异测试中发现并补上的缺口**（审查阶段）：
- Task 1：把 `if (cause instanceof TimeoutError)` 改成 `if (true)` → 原 4 条用例**全过** → 补了「非超时错误原样抛出」这条 ✅
- Task 6：把 `localizeApiMessage` 改成恒返回原值 → 挂 ✅（这条本来就覆盖到了）
- Task 8：往 `error.tsx` 插入 `{error.message}` → 测试**全过** → 补了 `not.toContain('boom')` ✅

---

## 四、发现并修复的缺陷

| # | 缺陷 | 严重度 | 处置 |
|---|------|--------|------|
| 1 | **计划给的 `redis-probe.ts` 跑不起来** —— `enableOfflineQueue: false` + 懒创建连接 ⇒ 首次 `ping()` 永远命中「Stream isn't writeable」→ **探活恒为 false，哪怕 Redis 好好的** | 阻断 | 改为「先等 `ready` 事件再 PING」，用**真实 Redis** 验证过修复前后 |
| 2 | **探活超时路径上泄漏监听器** —— `once('ready')`/`once('error')` 在超时后不被摘掉 → `/health` 每 10 秒轮询一次泄漏 2 个 → 长跑累积 | 重要 | 定时器放进同一个 Promise、`finally` 里无条件 `off`。⚠️ 关键：`withTimeout` 用 `Promise.race` 实现，**超时分支拿不到清理机会** —— 必须自己握定时器。实测 20 次调用后监听器数不增长，总耗时 40042ms = 20 × 2000ms |
| 3 | **请求体序列化失败被误报成 503 网络错误** —— `JSON.stringify` 在 `try` 块内，body 含循环引用时抛 `TypeError` 被 catch 抓走 → 误报 `NETWORK_ERROR`，还污染监控里「后端不可用」的信号 | 重要 | 序列化提到 `try` 之外。实测：`body===undefined` → 仍是 `undefined`；`body===null` → `"null"`；循环引用 → 原生 `TypeError` |
| 4 | **`@theme inline` 的「被覆盖的变量不落到 `:root`」过于绝对** —— 实测编译产物里 `--font-sans`/`--spacing`/`--text-sm`/`--radius-md`/`--default-font-family`/`--default-mono-font-family`/`--color-destructive-foreground` 这 7 个**仍落在** `@layer theme{:host,:root}` 里 | 轻微 | 功能无影响（值仍指向 `--brand-*`，且 `@layer theme` 优先级低于手写 `:root`），但注释已改准 |
| 5 | **测试对 `error.tsx` 的「不渲染 `error.message`」没有设防** | 重要 | 补断言 + 变异复验 |
| 6 | **`global-error.tsx` 硬编码 zinc 的 hex**，与本仓库的 oklch 品牌令牌不符 | 重要 | 改成与 `:root` 逐字一致的 oklch 字面量。⚠️ **不能用 `var(--brand-*)`** —— global-error 渲染在根 layout 之外，此时 globals.css 未必加载 |
| 7 | **会话失效的注释描述的是中间态** —— `jwt-callback.ts:148` 置的是 token 上的 `undefined`，`:174` 的 session 回调兜底成 **`''`（空串）** | 轻微 | 注释改成描述最终态 |
| 8 | **商家改主题时，watcher 写的是旧变量名** | 阻断 | 随 Task 4 一起改（映射表统一） |
| 9 | **`buildThemeCss` 对空字符串产出非法声明**（`--brand-radius: ;`） | 轻微 | 三处循环统一排除空串 |
| 10 | **storefront 唯一一处 `shadow-md` 是 Tailwind 内置硬编码** → 商家配的阴影对它无效 | 重要 | 改成 `shadow-base`（走 `--brand-shadow-base`）；实测编译产物 `.hover\:shadow-base:hover { --tw-shadow: var(--brand-shadow-base) }` |

---

## 五、已知遗留项

### 5.1 设计文档已记录的（沿用）

L1（webhook 投递失败无补偿）、L2（老租户的旧阴影默认值）、L3（抽佣流水明细）、L4（merchant-admin 的 jwt-callback 原地修改）、L5（跨副本分布式刷新锁）、L6（宽限期对时钟偏差的容忍）、L7（前端颜色选择器）、L8（platform-admin 的租户主题配置页）、L9（改密码时吊销令牌族）、L10（三份 api-client/theme.ts 重复）、L11（dark 模式从未启用）、L12（Redis 长时间不可用时的补偿）

### 5.2 本阶段新增

| # | 遗留 | 说明 |
|---|------|------|
| **L13** | 商家改字号时，**行高比例不跟随** | Tailwind 的 `--text-sm--line-height: calc(1.25 / 0.875)` 是硬编码比例。**修不了**：`calc(1.25 / var(--brand-text-sm))` 非法（CSS 不允许除以长度）。要跟随需定「比例跟不跟」的产品策略 |
| **L14** | Tailwind 内置阴影刻度（`shadow-md`/`shadow-xl`…）商家配不了 | 5d 把 storefront 唯一一处 `shadow-md` 改成了 `shadow-base`，但**新写的代码若再用内置刻度就会重新失效** |
| **L15** | merchant-admin 的 42 处 API 路由仍用 `!session` | 会话失效时放行 → 带空 token 请求 → 后端 401 → 被 `localizeApiMessage` 翻成「登录已过期」。**结果正确**，只是多一次无用往返，且不像 storefront 那样本地跳登录 |
| **L16** | **部分 token 在 storefront 没有消费者** → 商家配了看不到效果 | `shadow-sm` / `shadow-lg` / `text-destructive-foreground` 在 storefront 源码里**没有任何元素使用** → Tailwind 按使用扫描不生成对应 utility。**机制是通的**（编译产物里 `--color-destructive-foreground: var(--brand-destructive-foreground)` 存在），但「配了 → 看得见」这一步缺消费者 |

### 5.3 与原计划的偏差（已记录在计划 §0.5 E1–E28）

实施期间共 28 条勘误，其中影响设计判断的有 6 条：E7（探活原方案跑不起来）、E10（监听器泄漏）、E11（`@theme inline` 的绝对化表述）、E13（序列化误报）、E25（跨 Task 的三处缺口）、E26（字体机制与设计文档不符）。

---

## 六、验收结论

**四个目标全部达成**（第 7 条手测为部分验证，第 9 条机制通但前台无消费者）：

1. ✅ **商家配的每一个主题 token 都在前台真实生效** —— 机制端到端闭合（§3.1 实测），但**部分 token 在前台没有消费者**（L16），配了看不到变化
2. ✅ **商家在后台改主题时能看到效果** —— 预览区实时联动 + 与后台自身 UI 隔离（手测 1–4）
3. ✅ **后端不可达时用户看到中文，未捕获异常有兜底页** —— 手测 5/6/11 + 三个前端各两个错误边界
4. ✅ **Redis 不可达时 API 不再永久挂死，健康检查反映真实状态** —— 手测 8/12：3 秒超时、503 + degraded、容器转 unhealthy、启动快速失败

**遗留**：L1–L16（见 §五）。其中 **L16** 与 **L13** 是本阶段新发现的「配了但效果不完整」的缺口，建议在 5e 或下一次主题迭代里处理。

**下一步**：开 PR → 合并 → 更新记忆。
