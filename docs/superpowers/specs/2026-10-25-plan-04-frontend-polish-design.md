# 计划 4：前端补齐与打磨 设计文档

| 项目 | 说明 |
|------|------|
| 文档日期 | 2026-10-25 |
| 文档状态 | 待用户审阅 |
| 前置 | 阶段 3「交易链路」已验收并合并（PR #5，验收记录见 `2026-10-24-plan-03-acceptance.md`） |
| 后续 | 阶段 4 后续板块（营销、平台计费与平台超管） |

> **本版说明**：初稿写完后做了一轮**对着现有代码的逐条核对**（阶段 3 的做法），
> 发现并修正了 25 处与现状不符的地方——其中 8 处**会直接导致实施时卡住或返工**。
> 完整的勘误索引表见**实施计划**的 §0.5（`2026-10-25-plan-04-frontend-polish.md`）。

---

## 一、目标与范围

阶段 3 把「购物车 → 下单 → 支付 → 发货 → 确认收货 → 退款」这条闭环跑通了，
但阶段 3 的验收记录 §六 里留了三条**前端**遗留项，且验收过程中的手测又挖出
两个真 bug。阶段 4 的第一个板块就是把这些清掉。

本板块的范围是**前端补齐与打磨**，四个子项（其中第 4 项拆成 4a / 4b 两半）：

| # | 子项 | 来源 | 性质 |
|---|------|------|------|
| 1 | 前端组件测试基建 | 验收 §六 遗留项 1 的说明（「Vitest 无 jsdom / Testing Library，做不了组件渲染测试」） | 能力缺口 |
| 2 | merchant-admin 的令牌刷新缺口 | 验收 §三「补做手测」发现的真 bug | **真 bug** |
| 3 | 地址簿的独立页面 | 验收 §六 遗留项 3 | 能力缺口 |
| 4a | 商家后台的**主题实时预览**（商家在后台编辑时**当场**看到效果） | 验收 §六 遗留项 2 | 能力缺口 —— **本阶段不做**，见 §七 遗留项 10 |
| 4b | **前台访客的实时生效**（商家保存后，**已打开前台的访客**看到效果） | 验收 §六 遗留项 2 | 能力缺口 —— **本阶段做** |

> ⚠️ **4a 与 4b 是两个不同的需求，不要混为一谈。**
>
> - **4a「实时预览」**：商家在商家后台的主题编辑页改主色，**在自己的浏览器里当场**看到效果。
>   这是**编辑器的体验**——商家还没保存就已经知道改成了什么样。
> - **4b「前台实时生效」**：商家**保存**之后，**正在浏览店铺前台的访客**看到新主题。
>   这是**已保存状态的传播**。
>
> 验收 §六 遗留项 2 的原文是「商家后台没有『主题改动』的**实时预览**——改完主题要刷新前台才看得到变化」。
> 本阶段做的是 **4b**；**4a 没做**。
> §一 的表格原先把整件事写成「验收 §六 遗留项 2」，读起来像遗留项 2 已被解决——
> 这是不对的，所以拆成 4a / 4b 两行，并各自标明做与不做。

### 1.1 为什么「组件测试基建」排在第一

不是因为它最重要，而是因为它**解锁另外三项的验证能力**：

- 子项 2（令牌刷新）本质是「在 `jwt` 回调里发 HTTP 请求并处理失败」——
  这段逻辑**只在组件/请求链路里才跑得起来**，纯函数测不了。
- 子项 3（地址簿页）是一个交互表单，逻辑全在客户端组件里。
- 子项 4b（前台主题实时生效）如果推荐方案涉及客户端轮询或 SSE，
  那更是**必须**有组件测试才敢改。

阶段 3 的验收记录 §三「补做手测」一节写得很直白：

> 前端测试基建是 Vitest 且只覆盖 `test/**/*.test.ts`，没有 jsdom /
> Testing Library，做不了组件渲染测试。那条链路当时只有类型检查 + 构建 + 逻辑推演兜底。

补完「加入购物车」按钮后**手测又挖出 2 个真 bug**（令牌过期不刷新、
购物车加载失败被显示成「购物车是空的」）。这两条本该被自动化测试抓住。

### 1.2 明确不做

- **不做真实浏览器的 E2E**（Playwright / Cypress）。本阶段只加 jsdom 级的
  组件渲染测试。理由见 §四.1 的「放弃的方案」。
- **不改后端接口**。本板块四个子项**不需要新增任何后端端点**——
  地址簿的中转路由已存在（`storefront/src/app/api/addresses/`），
  主题的读写端点已存在（`GET /public/theme` 与 `PATCH /stores/me`）。
- **不做跨店会员**。阶段 3 遗留项 4，本阶段不碰。
- **不做购物车金额改服务端实时价**。阶段 3 遗留项 4 **已经由阶段 3 实现**——
  `api/src/modules/cart/cart.service.ts` 第 411–417 行的 `read()` 里
  `include: { sku: { select: { id, price, product } } }`，
  **购物车接口返回的就是数据库里 SKU 的当前价**；前端
  `storefront/src/lib/cart.ts` 第 165 行的 `itemSubtotal` 用的就是 `item.sku?.price`。
  「估算」的只是**下单那一刻可能与此刻不同**——那是所有电商的固有语义，不是缺陷。
  **本阶段无需任何改动。**
- **不做商家后台的主题实时预览**（§一 子项 4a）。见 §七 遗留项 10。
- **不建 monorepo**。见 §四.2 的权衡。
- **不引入 SSE / WebSocket 长连接**。见 §四.4 的权衡。

---

## 二、关键决策速查

| # | 决策 | 选择 | 理由 | 放弃的方案 |
|---|------|------|------|----------|
| 1 | 组件测试运行环境 | **全局 `environment: 'node'` 保持不变**，组件测试文件顶部用 `// @vitest-environment jsdom` 逐文件切换 | **既有 Route Handler 测试与纯函数测试根本不需要浏览器环境**（Node 18+ 原生支持 Web 标准的 `Request`/`Response`），而全局切 jsdom 会波及全部既有测试——**改全局环境的收益为零、风险为全部回归**。实测：逐文件的 `// @vitest-environment jsdom` 注释**优先于全局配置**（把全局设成 `node` 时逐文件注释仍生效），所以「逐文件切」这个手段本身是可靠的 | 全局切 `jsdom`（会波及既有 Route Handler 与纯函数测试）；`environmentMatchGlobs`（Vitest 3 已废弃该选项，且仓库没有 `vitest.workspace.ts`） |
| 2 | 组件测试库 | **Vitest + jsdom + @testing-library/react + @testing-library/jest-dom + @testing-library/user-event** | 与 Vitest 3 同代；RTL 是 React 社区事实标准，Next.js 官方文档的单元测试章节用的就是它 | Playwright Component Testing（要额外起浏览器二进制，与「不引入真实浏览器 E2E」的边界冲突，且 CI 成本高一个量级）；Enzyme（不支持 React 19） |
| 3 | merchant-admin 令牌刷新 | **复制 storefront 的 `token-expiry.ts` + `auth.ts` 的刷新段**（物理复制，不建共享包） | 两个应用是**完全独立的 Next.js 应用**（仓库根没有 `package.json`，无 workspace）；建共享包要引入 monorepo 工具链（npm workspaces / turborepo / 构建顺序），为了 104 行纯函数付这个代价不划算 | 建 `packages/shared` 共享包（引入 monorepo 改造，超出本板块范围，且两个应用的 `tsconfig` / 构建产物都要改） |
| 4 | 地址簿路由 | **`storefront/src/app/(shop)/account/addresses/page.tsx`**，即 `/account/addresses` | 挂在 `(shop)` 路由组下 → 自动继承 `ShopLayout` 的主题注入；`(shop)/account/page.tsx` 已经存在且是「我的账户」，地址簿是它的子项 | 顶层 `app/addresses/`（会**绕过 `ShopLayout` 的主题注入**，主题不生效）；`/address` 单数（与后端 `/api/addresses` 复数不一致） |
| 5 | 地址簿导航入口 | **在首页导航栏加「地址」链接 + 在 `/account` 页加入口**，不做全局头部导航 | storefront **没有全局 header**（`(shop)/page.tsx` 的 nav 只在首页有）；加全局导航是布局改造，超出本板块 | 新建一个全局 Header 组件（要改 `(shop)/layout.tsx`，影响所有页面渲染路径） |
| 6 | 主题实时生效 | **storefront 端轮询 + 客户端注入 CSS 变量**（`/api/theme` 中转 → 30 秒轮询 → 更新 `<style>` 标签） | storefront 是**多副本**部署（`infra/docker-compose.yml` 里 nginx → `storefront:3000`），任何「服务端缓存 + 失效」方案都要处理「失效广播到所有副本」的问题；轮询是**无状态**的，天然对多副本正确 | 短 TTL 服务端缓存（延迟仍由 TTL 决定，且多副本各缓存各的）；商家保存时调 storefront 失效接口（需要 storefront 侧有共享状态——Redis 或外部缓存，本项目 Redis 只用于 BullMQ 队列）；SSE（要维护长连接、要处理断线重连与反向代理的连接超时） |
| 7 | 主题轮询的落点 | **客户端组件 `ThemeWatcher`**，挂在 `(shop)/layout.tsx` 里 | 主题是**视觉**属性，客户端改 CSS 变量不需要重渲染 React 树；放服务端则每次轮询都要重渲染整棵树 | 放 Server Component（每次轮询触发整树重渲染，浪费；且 RSC 里改不了 DOM） |
| 8 | 主题的生效延迟上限 | **30 秒**（轮询间隔），且**页面获得焦点时立即查一次** | 商家改完主题，访客最长 30 秒看到变化；「切回浏览器标签页」这个动作会立刻触发一次查询，实际感知延迟远小于 30 秒 | 更长的间隔（感知更慢）；更短的间隔（请求量放大 3–6 倍） |

---

## 三、现状盘点（设计的依据）

### 3.1 现有前端测试基建

| 应用 | 配置文件 | 环境 | include | 覆盖对象 |
|------|---------|------|---------|---------|
| storefront | `storefront/vitest.config.ts` | `environment: 'node'` | `test/**/*.test.ts` | 纯函数 + Route Handler |
| merchant-admin | `merchant-admin/vitest.config.ts` | `environment: 'node'` | `test/**/*.test.ts` | Route Handler + 纯函数 |

两个配置里都有一段明确的注释：

> ⚠️ 不测 React 组件渲染：那需要 jsdom + React Testing Library，
> 是另一个成本量级的事，本轮明确不做。

以及 `storefront/vitest.config.ts` 里：

```ts
test: {
  environment: 'node',
  include: ['test/**/*.test.ts'],
  globals: false,
},
```

**关键约束**：`include` 是 `test/**/*.test.ts`——**不包含 `.tsx`**。
组件测试文件是 `.tsx`，所以 include 必须扩成 `test/**/*.test.{ts,tsx}`。

`storefront/src/lib/token-expiry.ts` 用了 `Buffer.from(...)`（第 26–28 行）。
**⚠️ 但这不是「jsdom 环境没有 Buffer」**——实测 Vitest 3.2.7 的 jsdom environment
**显式注入 `global.Buffer = Buffer`**
（`node_modules/vitest/dist/chunks/index.CmSc2RE5.js` 第 556–557 行）。
把 `token-expiry.ts` 的 `readJwtExpiry` 原样放进 jsdom 环境跑，**正常工作**。
详见 §4.1.2 与 §5.3 第 1 条。

### 3.2 storefront 的令牌刷新（已实现，可复制）

`storefront/src/auth.ts` 是一套完整的实现：

| 位置 | 内容 |
|------|------|
| 第 50 行 | `const inFlightRefreshes = new Map<string, Promise<RefreshedTokens | null>>()` — 刷新去重 |
| 第 64–80 行 | `refreshTokens()` — 同一枚刷新令牌在途只发一次 |
| 第 83–104 行 | `requestRefresh()` — 真正发一次 `POST /auth/refresh` |
| 第 177–205 行 | `jwt` 回调里检测过期 → 刷新 → 失败则作废会话 |

`storefront/src/lib/token-expiry.ts` 提供 `readJwtExpiry` / `readJwtIssuedAt` /
`isTokenExpired` 三个纯函数，`storefront/test/lib/token-expiry.test.ts` 有 13 条用例覆盖。

### 3.3 merchant-admin 的令牌处理（缺口所在）

`merchant-admin/src/auth.ts` 第 86–96 行：

```ts
callbacks: {
  async jwt({ token, user }) {
    if (user) {
      const authUser = user as AuthUser;
      token.accessToken = authUser.accessToken;
      token.refreshToken = authUser.refreshToken;
      token.role = authUser.role;
      token.tenantId = authUser.tenantId;
    }
    return token;
  },
```

**没有过期判断，没有刷新**。后端 accessToken 有效期 2 小时
（`api/src/modules/auth/auth.module.ts` 第 27–28 行：
`expiresIn: (process.env.JWT_EXPIRES_IN ?? '2h')`），
而 NextAuth 的 JWT 会话默认活 30 天。

**后果**（阶段 3 验收已实测过 storefront 侧的同一个 bug）：
商家后台连续用超过 2 小时后，页面上的每个请求都带一枚过期令牌，
后端一律 401。商家看到的是「订单列表加载失败（401）」之类。

`merchant-admin/src/lib/api-client.ts` 第 67–72 行：

```ts
export async function apiFetchAuthed<T>(path, options = {}) {
  const session = await auth();
  return apiFetch<T>(path, { ...options, token: session?.accessToken });
}
```

`auth()` 走 NextAuth 的 `jwt` 回调——**只要 `jwt` 回调里做了刷新，
这里拿到的就是新的 accessToken**，不需要改 `api-client.ts`。

### 3.4 主题的当前取法

`storefront/src/app/(shop)/layout.tsx`：

| 行 | 内容 |
|----|------|
| 第 23 行 | `export const dynamic = 'force-dynamic'` — 放弃静态预渲染与 Full Route Cache |
| 第 30–31 行 | `await headers()` + `resolveTenantSubdomain(headerList)` — 从请求头解析租户 |
| 第 35–38 行 | `apiFetch<ThemeResponse>('/public/theme', { subdomain })` — **每次请求**都调后端 |
| 第 44 行 | `buildThemeCss(tokens)` — 拼成 CSS 变量声明 |
| 第 48–53 行 | 渲染 `<style dangerouslySetInnerHTML={{ __html: `:root {\n${css}\n}` }} />` |

**现状结论**：

1. storefront **已经是「请求期拉取」**，不是构建期注入。
   `force-dynamic` 保证了每个请求都重新渲染 layout。
2. 但 `<style>` 标签**只在服务端渲染时注入**，客户端不更新它。
   所以「改完主题要刷新才看得到」的真正原因是：
   **页面不刷新就不会重新请求，也就不会重新注入 `<style>`**。
3. 后端 `GET /public/theme` 走 `ThemeService.current()`
   （`api/src/modules/theme/theme.service.ts` 第 145–155 行），
   每次都查一次库（`prisma.store.findFirst`），**没有任何缓存**。

第 2 点决定了子项 4b 的解法空间：既然服务端已经是请求期拉取，
「让正在开着的页面也感知到变化」只需要**让客户端也能重新拉一次并更新 `<style>`**。

### 3.5 地址簿的当前状态

后端接口齐全（验收记录 §五）：

| 方法与路径 | 中转路由（storefront） |
|-----------|----------------------|
| `GET /api/v1/addresses` | `storefront/src/app/api/addresses/route.ts` 的 `GET` |
| `POST /api/v1/addresses` | `storefront/src/app/api/addresses/route.ts` 的 `POST` |
| `PATCH /api/v1/addresses/:id` | `storefront/src/app/api/addresses/[id]/route.ts` 的 `PATCH` |
| `DELETE /api/v1/addresses/:id` | `storefront/src/app/api/addresses/[id]/route.ts` 的 `DELETE` |

**中转路由已经能改、删、设默认**——阶段 3 验收场景 13/14 用 `PATCH /api/addresses/:id`
实测过「设默认地址」与「改地址」，后端返回 200。

**唯一缺的是界面**。现在唯一能新增地址的地方是
`storefront/src/components/checkout/checkout-form.tsx` 的 `AddressForm` 组件
（第 275–383 行），它被内嵌在结算表单里（第 216–222 行），
且 `AddressForm` 是**结算表单文件里的私有函数**（第 275 行 `function AddressForm`，
没有 `export`），外部拿不到。

**这引出一个重要的实现约束**：地址簿页需要「新增 / 编辑 / 删除 / 设默认」四种操作，
而结算页的 `AddressForm` 只做了「新增」。要么把 `AddressForm` 提取成共享组件
（`src/components/address/address-form.tsx`），要么在地址簿页重写一遍表单。
**前者更对**——表单字段有 6 个（收件人 / 手机 / 省 / 市 / 区县 / 详情），
复制一遍必然漂移。

---

## 四、四项的设计

### 4.1 子项 1：前端组件测试基建

#### 4.1.1 目标

让「渲染一个 React 组件 → 交互 → 断言」成为可能，
并用一条**示范性的组件测试**证明它真的可用。

#### 4.1.2 方案论证：全局切 jsdom 还是逐文件切

**候选 A：全局 `environment: 'jsdom'`**

改动最小（一行），但要付出：

1. **既有 125 条测试全部要重新验证。** storefront 75 条 + merchant-admin 50 条
   （验收记录 §一）。Route Handler 测试在 jsdom 下，`Request`/`Response` 来自
   jsdom 的 `undici` 垫片而不是 Node 原生实现——**行为有细微差异**
   （例如 `Response.headers.get('set-cookie')` 的多值处理）。
2. **既有的 Route Handler 与纯函数测试根本不需要浏览器环境。**
   Node 18+ 原生支持 Web 标准的 `Request`/`Response`，
   `token-expiry.ts` 的 13 条纯函数用例与 12 个路由白名单用例在 node 下全绿。
   把它们迁到 jsdom 是**纯粹的回归风险，换不到任何收益**。

   > ⚠️ **本条曾以错误的理由存在过。** 初稿写的是
   > 「jsdom 环境不注入 `Buffer`，`token-expiry.ts` 的 `Buffer.from`（第 26 行）
   > 会抛 `Buffer is not defined`」。**实测不成立**：Vitest 3.2.7 的 jsdom
   > environment **显式注入 `global.Buffer = Buffer`**
   > （`node_modules/vitest/dist/chunks/index.CmSc2RE5.js` 第 556–557 行）；
   > 把 `readJwtExpiry` 原样放进 jsdom 环境跑，**正常工作**。
   > 见 §5.3 第 1 条。
3. 阶段 2b/3 的验收记录里已经明确记过一类坑：
   「改动 X 之后它才冒出来——它是一颗埋着的雷，被别的文件改动引爆」。
   为加测试基建而惊动 125 条既有测试，是同一类风险。

**候选 B：全局保持 `node`，组件测试文件顶部用 `// @vitest-environment jsdom`**

Vitest 的**per-file environment 注释**是官方支持的机制：文件首行写
`// @vitest-environment jsdom`，该文件就用 jsdom 跑，其余文件不受影响。

代价：

1. 组件测试文件顶部要写一行注释——**但这一行本身就是文档**，
   读测试的人一眼就知道「这个文件跑在浏览器环境里」。
2. 忘记写这行的症状是 `document is not defined`——**报错很直白，不会静默跑偏**。

**候选 C：`environmentMatchGlobs`**

Vitest 3 已废弃这个选项（改用 `projects`）。而且要引入 `projects` 配置
就等于把配置文件拆成多份，多一堆概念。**放弃**。

**决策：候选 B。** 理由是「改全局环境的收益为零、风险是全部回归」——
现有 125 条测试没有任何一条需要浏览器环境，而新增的组件测试只需要自己的文件
是 jsdom 就够了。

**实测确认**：逐文件的 `// @vitest-environment jsdom` 注释**优先于全局配置**——
把 `vitest.config.ts` 的 `environment` 设成 `node`（或 `jsdom`）时，
带注释的文件仍然按注释指定的 jsdom 跑，不带注释的文件按全局配置跑。
所以「逐文件切」这个手段本身是可靠的，决策 1 的**结论不变，只是理由换了**
（见候选 A 第 2 条）。

#### 4.1.2.1 必须显式 `cleanup()`：本项目 `globals: false` 的连带后果

**这是一条会直接让组件测试全挂的坑，必须写进 setup。**

`@testing-library/react` v16 的**自动 cleanup** 依赖**全局** `afterEach`：

```js
// node_modules/@testing-library/react/dist/index.js 第 26 行
if (typeof afterEach === 'function') {
  afterEach(() => { cleanup(); });
}
```

而本项目的 Vitest 配置是 `globals: false`（`storefront/vitest.config.ts` 的
`test.globals`）——**全局 `afterEach` 不存在**，那个 `typeof afterEach === 'function'`
判断为假，**自动 cleanup 根本不注册**。

**实测后果**：不显式 cleanup 的话，DOM 会**跨用例累积**——
从第 2 条用例起 `getAllByRole` 就找到多个元素，报
`Found multiple elements with the role "button"`。

**因此**，setup 文件里必须显式写：

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

这不是「防御性代码」，而是 `globals: false` 的**直接后果**——
设计阶段完全没有提到这一点，是遗漏。

#### 4.1.3 方案论证：需要 mock 什么

组件测试要跑起来，有三样东西会「出意外」：

| 依赖 | 为什么会在测试里炸 | 处理方式 |
|------|-------------------|---------|
| `next/navigation` | `useRouter()` 在 App Router 的测试环境里返回 `null`，调用 `router.push()` 会抛 `Cannot read properties of null` | `vi.mock('next/navigation', ...)` 换成可控的假 router |
| `next/link` | 在 Vitest 里没有 Next 的运行时，`Link` 渲染成 `<a>` 即可，但 import 本身可能带 `next` 内部依赖 | 多数情况下**不需要 mock**（`next/link` 在纯客户端渲染下可工作）；若报错则 mock 成一个渲染 `<a href>` 的组件 |
| `fetch` | 组件里直接 `fetch('/api/cart/items')` 会真的发网络请求 | `vi.stubGlobal('fetch', vi.fn())` 或 `global.fetch = vi.fn()` |
| `next-auth` / `@/auth` | 组件若 import 了 `@/auth`，会把 `next-auth` 整个依赖图拉进来（含 `server-only`） | 组件测试里不 import `@/auth`；确需时 `vi.mock('@/auth', ...)` |

**关于 `server-only`**：两个 `vitest.config.ts` 已经把它 alias 到
`test/stubs/server-only.ts`（空模块）。这条要保留。

**关于 `globals: false`**：现有配置是 `globals: false`（不注入全局 `describe`/`it`），
所有测试都显式 `import { describe, expect, it } from 'vitest'`。
**新测试要沿用这个风格**——保持一致，且 `@testing-library/jest-dom` 的
匹配器（`toBeInTheDocument` 等）在 `globals: false` 下需要显式
`import '@testing-library/jest-dom/vitest'`（它会自行注册到 vitest 的 expect 上）。

> ⚠️ **`globals: false` 还有一个连带后果：RTL 的自动 cleanup 不会注册。**
> 详见 §4.1.2.1 —— setup 里必须显式 `afterEach(() => cleanup())`。

**关于 JSX 转换**：本项目的 `storefront/tsconfig.json` 第 14 行是
`"jsx": "preserve"`（Next.js 用 SWC 编译），**esbuild 不读这个设置**——
它默认走 classic transform，于是 JSX 编译成 `React.createElement(...)`，
而测试文件没有 `import React` → 报 `ReferenceError: React is not defined`。
**实测复现过**。所以 `vitest.config.ts` 必须在**根级**加
`esbuild: { jsx: 'automatic' }`（注意：加在 `test` 下面**不生效**，
esbuild 是 Vite 根级选项）。

#### 4.1.4 示范性组件测试：加入购物车按钮

选 `storefront/src/components/product/spec-selector.tsx` 的 `SpecSelector`：

| 理由 | 依据 |
|------|------|
| 它是阶段 3 补上但**没测过**的组件 | 验收记录 §六 遗留项 1 |
| 它内部有完整的交互状态机 | `selected` / `quantity` / `adding` / `addResult` 四个 state（第 34–39 行） |
| 它的失败模式全是「界面骗人」 | 手测挖出的三个 bug 全在这一类 |
| 它不 import `@/auth`，依赖图干净 | 只需 mock `fetch` |

**测试用例设计**（具体到断言）：

| # | 用例 | 断言 |
|---|------|------|
| 1 | 没选规格时按钮不可用 | `getByRole('button', { name: '加入购物车' })` 的 `disabled` 为真；页面上有「请先选择商品规格。」 |
| 2 | 选好规格后按钮可用 | 点了「黑色」再点「M」之后，按钮的 `disabled` 变假 |
| 3 | 点按钮调了中转路由 | `fetch` 被调用一次，URL 是 `/api/cart/items`，method 是 `POST`，body 是 `{"skuId":"<选中的 skuId>","quantity":1}` |
| 4 | 成功后显示「已加入购物车。」 | `findByText('已加入购物车。')` 出现；且有一个 `href="/cart"` 的「去购物车」链接 |
| 5 | 失败时显示后端返回的 message | `fetch` 返回 400 + `{"message":"商品不可售或不存在"}` → 页面上出现这句中文，**不是**「加入购物车失败」 |
| 6 | 数量上限被夹住 | 输入 150 → 输入框的值变成 `99` |
| 7 | 缺货时按钮不可用 | SKU 的 `stock` 为 0 → 按钮 disabled，页面显示「该商品暂时缺货。」 |

第 5 条特别重要：**验收 §三 场景 3 实测过**后端返回
`{"message":"商品不可售或不存在","code":"VALIDATION_FAILED"}`，
而组件的代码是 `throw new Error(payload.message ?? '加入购物车失败')`
（第 143 行）——**逻辑是对的，但没人测过**。这条用例把「后端的话原样透出」锁住。

第 7 条也是阶段 3 手测实测过的行为（第 184–185 行），
但**组件代码里没有这条分支的测试**。

#### 4.1.5 边界情况

| 情况 | 处理 |
|------|------|
| `product.skus` 为空 | `currentSku` 为 `null` → 按钮 disabled，提示「请先选择商品规格。」。测试要造一个空 `skus` 的商品断言不崩 |
| `product.specs` 为空（无规格商品） | `combinationExists` 的空集判定（第 60–65 行）成立，`currentSku` 命中唯一 SKU。测试要覆盖「无规格商品能直接加购」 |
| React 19 的 `act` 警告 | RTL 的 `user-event` 已经包了 `act`；`fireEvent` 手写时要用 `await waitFor`。**不要用 `fireEvent` 代替 `user-event`**——`user-event` 的真实事件序列能暴露真实 bug |
| 定时器 | `SpecSelector` 不用定时器。将来若有组件用 `setTimeout`，用 `vi.useFakeTimers()` |

---

### 4.2 子项 2：merchant-admin 的令牌刷新

#### 4.2.1 方案论证：复制 vs 共享包

**事实**：两个应用**完全独立**。

| 证据 | 位置 |
|------|------|
| 仓库根**没有** `package.json` | `ls` 根目录只有 `api/` `storefront/` `merchant-admin/` `platform-admin/` `infra/` `docs/` 等 |
| 两个应用各有独立的 `package.json` / `tsconfig.json` / `vitest.config.ts` / `eslint.config.mjs` | `storefront/package.json` 与 `merchant-admin/package.json` 各自声明 `vitest`、`next` 等依赖 |
| 两个应用的 `tsconfig.json` 的 `paths` 都只指向自己的 `src/` | `storefront/tsconfig.json`：`"@/*": ["./src/*"]` |
| 两个应用的 `vitest.config.ts` 的 alias 都只指向自己的 `src/` | 同上 |

**候选 A：复制**

`merchant-admin/src/lib/token-expiry.ts` ← 复制 `storefront/src/lib/token-expiry.ts`；
`merchant-admin/src/auth.ts` 的 `jwt` 回调 ← 复制 `storefront/src/auth.ts` 第 33–104 行
与第 177–205 行的对应段。

| 优点 | 缺点 |
|------|------|
| 零构建改动，两个应用互不影响 | 同一份逻辑有两份，改一处忘另一处会漂移 |
| 与仓库现状一致（两个应用本来就各自复制了 `api-client.ts` / `utils.ts` / `ui/*`） | |

**候选 B：建共享包（`packages/shared`）**

| 优点 | 缺点 |
|------|------|
| 单一事实来源 | 要把仓库变成 monorepo：根 `package.json` + `workspaces` 字段 + 共享包的 `tsconfig` + 两个应用的 `tsconfig` 要改 `paths` 指向包 + Next.js 的 `transpilePackages` 配置 |
| | 两个应用的 `node_modules` 布局、Vitest 的 alias 解析、Next 的构建产物路径全部要重新验证 |
| | 本项目**没有**任何 monorepo 工具链（无 turborepo / nx / pnpm workspace）——这是**基础设施改造**，不是「前端补齐」 |
| | 共享包要被两个 Next.js 应用分别打包，TypeScript 的 `paths` 映射在 Next 的 `transpilePackages` 下容易出「类型对不上但编译不报错」的怪问题 |

**决策：候选 A（复制）。**

**理由**：本阶段要共享的只有两样东西——
`token-expiry.ts`（104 行纯函数）与 `auth.ts` 里约 70 行的刷新段。
为 174 行代码引入 monorepo 工具链，代价与收益完全不成比例。

**但复制必须带一条防漂移的约定**（写进两份文件的注释里）：

> 本文件是 `storefront/src/lib/token-expiry.ts` 的副本。
> 改动其中一份时，**必须同步另一份**——两份的行为必须完全一致。
> 判据：两边的 `test/lib/token-expiry.test.ts` 应当是同一份文件。

「两份测试文件是同一份」是这条约定的**可执行证据**——
只要两份测试都通过且内容一致，行为就不会漂移。

#### 4.2.2 merchant-admin 的刷新逻辑与 storefront 的差异

**两处必须改**：

1. **不带 `x-tenant-subdomain`。**
   storefront 的 `authorize`（第 121–128 行）带 `x-tenant-subdomain`，
   因为消费者是「先确定店铺，再在店铺里登录」。
   merchant-admin 的 `authorize`（第 46–52 行）**刻意不带**——
   商家后台跑在中心域名（`merchant.platform.test`），
   租户身份完全由 accessToken 里的 `tenantId` 决定
   （`merchant-admin/src/auth.ts` 第 17–20 行的注释已写明）。

   → **刷新请求也不带这个头**。带上了反而会让 Nginx 的
   `proxy_set_header X-Tenant-Subdomain "";`（`infra/nginx/platform.test.conf`
   第 62 行）剥掉它——那行是刻意的，剥掉是对的。

2. **`refreshToken` 的存放位置一样。**
   两边的 `AuthUser` 接口都带 `refreshToken`（storefront 第 30 行、
   merchant-admin 第 29 行），`jwt` 回调都会写进 token。

**可以直接照抄的部分**：

| 组件 | 位置 | 说明 |
|------|------|------|
| `inFlightRefreshes` 去重表 | storefront `auth.ts` 第 50 行 | **必须照抄**。后端的刷新是**轮换**式的（`api/src/modules/auth/auth.service.ts` 第 284–290 行的条件更新），并发的第二次刷新会被判成重放，第 268 行 `revokeTokenFamily` 会**吊销用户所有设备上的登录** |
| `refreshTokens()` | 第 64–80 行 | 只清掉自己那一条（第 76–78 行），不能 `clear()` 整个 Map |
| `requestRefresh()` | 第 83–104 行 | **网络层出错（catch 分支）→ 保留旧令牌，本次请求失败**；**后端明确返回 401/403 → 刷新失败**。⚠️ 这两件事必须区分，见 §5.1 的 **L18** |
| `jwt` 回调的刷新段 | 第 177–205 行 | 刷新失败 → **作废整个会话**（`accessToken`/`refreshToken` 置 undefined），让用户重新登录 |
| `session` 回调 | 第 207–215 行 | 会话已作废时 `accessToken` 落成 `''`（不是 `undefined`）——merchant-admin 第 98 行是 `session.accessToken = token.accessToken as string`，需要改成 `?? ''` |

**最后一处是个坑**：merchant-admin 的 `session` 回调第 98 行是

```ts
session.accessToken = token.accessToken as string;
```

storefront 第 211 行是

```ts
session.accessToken = (token.accessToken as string | undefined) ?? '';
```

`as string` 是**类型断言，不是运行时转换**——运行时若 `token.accessToken` 是
`undefined`，`session.accessToken` 就是 `undefined`。
`merchant-admin/src/lib/api-client.ts` 第 30–32 行：

```ts
if (options.token) {
  headers.authorization = `Bearer ${options.token}`;
}
```

`undefined` 是 falsy → 不加 `Authorization` 头 → 后端按**游客**处理。
对商家后台来说，这意味着「令牌过期后刷新失败」会退化成「未登录」，
而不是「401」。症状差别不大，但**语义是错的**——必须照 storefront 改成 `?? ''`。

#### 4.2.3 边界情况

| 情况 | 期望行为 | 依据 |
|------|---------|------|
| accessToken 还没过期 | 不发刷新请求 | `isTokenExpired` 返回 false |
| accessToken 过期、refreshToken 有效 | 刷新成功，新令牌写回 token | storefront `auth.ts` 第 194–205 行 |
| accessToken 过期、refreshToken 也过期 | 作废会话，用户看到「请重新登录」 | 同上第 195–201 行 |
| accessToken 过期、**网络层失败**（后端没起来 / 连接被重置） | **保留旧令牌，不作废会话**——本次请求返回 401，等下一次读会话再试 | **⚠️ 与上一行不同**。一次 200ms 的网络抖动不该把商家永久踢出。区分办法：刷新请求**抛异常**（catch 分支）= 网络失败；**拿到 401/403 响应** = 凭证失效。见 §5.1 的 L18 |
| 并发读会话 | **只发一次**刷新请求 | `inFlightRefreshes`；后端第 268 行会吊销整个令牌族 |
| 短寿命令牌（如测试用 15 秒） | **不**被反复判成过期 | `isTokenExpired` 的提前量按令牌寿命的 1/10 收敛（`token-expiry.ts` 第 98–101 行） |
| 读不出 `exp` | 当作「没过期」，不触发刷新 | `token-expiry.ts` 第 91 行。刷新是轮换式的，无谓的刷新会踩到并发 |

---

### 4.3 子项 3：地址簿的独立页面

#### 4.3.1 路由设计

**选定**：`storefront/src/app/(shop)/account/addresses/page.tsx` → 路径 `/account/addresses`。

理由：

1. **在 `(shop)` 路由组下** → 自动继承 `ShopLayout`（`storefront/src/app/(shop)/layout.tsx`），
   主题注入生效。若放在顶层 `app/addresses/`，就**绕过**了 `ShopLayout`——
   那个布局里第 48–53 行注入的 `<style>` 是主题生效的唯一来源。
   这是选路由时最容易踩的坑。
2. **与现有 `(shop)/account/page.tsx` 同级** —— `/account` 已经存在（第 4 行 `CustomerAccountPage`），
   是「我的账户」页，显示邮箱 / 角色 / 租户。地址簿是它的子项，
   挂在它下面语义清晰。
3. **复数 `addresses`** —— 与后端 `/api/addresses`、中转路由 `/api/addresses` 一致。

**为什么不用 `/address`（单数）**：单数是「一个地址」，而这个页管理的是「地址簿」。

**为什么不用 `/account/address`**：与后端路径与中转路由不一致，没有额外好处。

#### 4.3.2 页面结构

```
/account/addresses
├── 标题「收货地址」
├── 「返回我的账户」链接 → /account   ← ⚠️ 必须有：否则用户从首页导航进本页后
│                                      **没有任何返回路径**（storefront 没有全局 header）
├── 「新增地址」按钮 → 展开内联表单
├── 地址列表（默认地址排最前，与后端 GET /addresses 的排序一致）
│   └── 每条：收件人 / 电话 / 地址 / 「默认」标记
│       ├── 「设为默认」按钮 → PATCH /api/addresses/:id { isDefault: true }
│       ├── 「编辑」按钮 → 内联展开表单 → PATCH
│       └── 「删除」按钮 → DELETE → 二次确认
└── 未登录 → redirect('/login')
```

**「返回」路径为什么要加**：storefront **没有全局 header**
（唯一的导航在首页，`(shop)/page.tsx` 第 30–46 行）。
用户在首页点了「地址」进来后，页面上除了地址列表与操作按钮，**没有别的出口**
——只能改地址或点浏览器后退。地址簿是「我的账户」页的子项，
「返回我的账户」是最自然的出口。

**未登录的处理**：与 `(shop)/account/page.tsx` 第 9–11 行一致——

```ts
const session = await auth();
if (!session) {
  redirect('/login');
}
```

**数据取法**：`storefront/src/lib/shop-api.ts` 第 65–89 行已有 `fetchAddresses()`，
直接复用。**不要新写一套**。

#### 4.3.3 与结算页的关系

**这是本子项最容易出错的地方**，必须明确：

1. **结算页的地址选择逻辑**（`checkout-form.tsx` 第 93–95 行）：
   ```ts
   const [addressId, setAddressId] = useState<string>(
     addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? '',
   );
   ```
   默认地址优先——**这个逻辑不变**。地址簿页改默认地址后，
   用户回到结算页会看到新的默认地址被选中。

2. **结算页的「新增地址」表单要保留。**
   结算时顺手加一个地址是高频场景（尤其「下单时发现没有这个地址」）。
   把 `AddressForm` 提取成共享组件后，**两个地方都用它**——
   结算页与地址簿页各引一份。

3. **`AddressForm` 的归属要改。**
   现在它是 `checkout-form.tsx` 第 275 行的私有函数。
   要提取到 `storefront/src/components/address/address-form.tsx`，
   **`export`** 出去，结算页改成 import。

4. **编辑态是新增态的超集。**
   提取后 `AddressForm` 要支持两种模式：
   - 新增：`onCreated(address)` → 调 `POST /api/addresses`
   - 编辑：`onUpdated(address)` → 调 `PATCH /api/addresses/:id`

   字段相同，只是提交目标不同。

5. **删除的软删语义**：后端的 `DELETE /api/v1/addresses/:id` 是**软删**
   （验收记录 §五：「软删地址」）。删除后列表里不再出现——
   前端不需要额外处理。

6. **「设为默认」的后端语义**：后端 `create` / `update` 时会先
   `clearDefault`（验收 §四 护栏 19：默认地址唯一）。
   前端**不需要**自己先取消旧的默认——**只管发 `isDefault: true`**。
   这条要写进注释，否则后来的人会以为前端也要处理。

#### 4.3.4 导航入口

**问题**：storefront **没有全局 header**。

| 事实 | 位置 |
|------|------|
| 唯一的导航在首页 | `storefront/src/app/(shop)/page.tsx` 第 30–46 行 |
| 首页导航有「购物车」「我的订单」「账户」三个链接 | 同上第 **38 / 41 / 44** 行（三个 `<Link>`） |
| 品类导航是每个品类的链接 | 同上第 31–35 行 |

**决策**：**两处入口，不做全局导航**。

| 入口 | 位置 | 说明 |
|------|------|------|
| 首页导航加「地址」 | `(shop)/page.tsx` 第 44 行后（「账户」链接之前） | 与「购物车」「我的订单」「账户」并列 |
| `/account` 页加一个链接 | `(shop)/account/page.tsx` | 「我的账户」页现在只有三行文字，正好加一行「收货地址 →」 |

**为什么不建全局 header**：那要改 `(shop)/layout.tsx`，
而这个 layout 是**所有店铺页面**的父级——改动它的渲染路径会影响每一个页面的
首屏渲染，且 `(shop)/layout.tsx` 是主题注入的地方（`force-dynamic` + `headers()`），
在那里再加东西会让「主题注入」这条链路的风险面变大。

**为什么不只加 `/account` 页的入口**：用户想「管理地址」时，
最自然的路径是「账户 → 地址」。但首页导航已经有「账户」了，
从首页点进账户再点地址是两步。只在首页导航加「地址」会让首页导航变长
（已经 4 个链接了）。

**两处都加，成本是 2 行。**

#### 4.3.5 边界情况

| 情况 | 处理 |
|------|------|
| 未登录 | `redirect('/login')`，与 `(shop)/account/page.tsx` 一致 |
| 地址簿为空 | 显示「还没有收货地址。」+「新增地址」按钮 |
| 加载失败 | 显示错误 + 「重试」按钮，**不谎报「空」**（`cart-list.tsx` 第 145–160 行的教训） |
| 删除默认地址后没有默认地址 | 后端 `DELETE` 后可能一条默认都不剩。结算页的逻辑是 `find(isDefault) ?? items[0] ?? ''`——会退到第一条，**不会空**。前端地址簿页也要能处理「没有默认标记」的状态 |
| 「设为默认」与「编辑时顺带勾选 isDefault」并发 | 后端有部分唯一索引（`addresses_tenant_customer_default_uniq`）兜底；前端不做乐观更新，**以服务端返回为准** |
| 表单校验 | 复用 `sanitizeAddressBody`（`storefront/src/lib/addresses.ts` 第 21–47 行）的规则：6 个字段都是非空字符串，`isDefault` 必须是布尔值。**不要在前端另写一套规则** |

---

### 4.4 子项 4b：主题改动后前台实时生效

#### 4.4.1 现状与问题的准确定位

§3.4 已经确认：storefront **已经是请求期拉取**（`force-dynamic` + 每次请求调
`/public/theme`），**不是构建期注入**。

所以问题的准确定位是：

> 服务端每次请求都拿到最新主题，但 `<style>` 标签**只在服务端渲染时注入**。
> **页面不刷新 → 不重新请求 → 不重新注入 → 看不到变化。**

也就是说，**缺的不是一个「更快的服务端缓存」，而是「客户端的二次拉取与重注入」**。
这直接排除了几个候选方案。

#### 4.4.2 候选方案论证

**候选 1：短 TTL 服务端缓存**

在 storefront 的 layout 里给主题加一个 TTL 缓存（比如 5 秒），
这样「刷新页面」最多 5 秒就能看到新主题。

| 优点 | 缺点 |
|------|------|
| 改动最小 | **只解决「刷新后」的问题，不解决「页面开着」的问题**——用户的要求明确是「正在开着页面的用户多久能看到变化」 |
| 降低后端压力（每次请求都查库，见 §3.4） | 多副本各缓存各的（TTL 从各副本各自的写入时刻算），延迟不一致 |

**评价**：不满足需求本身。**放弃**——但它揭示了一个真实问题：
**现在每个 storefront 请求都要查一次库**（`ThemeService.current()` 第 150 行
的 `prisma.store.findFirst`），这是本板块之外的性能债，记入 §七 遗留项。

**候选 2：每次请求拉取（去掉缓存）**

即现状。**已经是这样了**，不解决问题。**放弃**。

**候选 3：商家保存主题时调 storefront 的失效接口**

商家后台保存主题后，调 `POST http://storefront/internal/theme/invalidate`，
storefront 清掉自己的缓存。

| 优点 | 缺点 |
|------|------|
| 延迟低（保存后立刻生效） | **需要 storefront 侧有「可失效的共享状态」**——多副本时，副本 A 收到失效请求，副本 B 的缓存不会失效 |
| | 要新增一个内部接口 + 一个鉴权机制（内网调用也要防伪造——否则任何人都能打这个接口） |
| | 要引入一个共享缓存层（Redis）。**本项目的 Redis 目前只用于 BullMQ 队列**（`api/src/modules/queue/`），把它当缓存用是新的职责 |
| | 复杂度最高：新增端点 + 新增鉴权 + 新增缓存层 + 失效广播 |

**多副本问题**：storefront 在 `infra/docker-compose.yml` 里是**单副本**，
但 Nginx 后面按 `upstream storefront_backend { server storefront:3000; }`
（`infra/nginx/platform.test.conf` 第 9–11 行）配置——**将来扩副本时这个方案立刻出问题**。
`nginx` 的 `upstream` 块天然支持多 `server` 指令，改一行就能加副本。

**评价**：复杂度最高，多副本下需要额外的一致性机制。
**在本阶段放弃**——但如果将来要求「保存后 1 秒内全站生效」，
这个方案（或候选 4 的变体）才是对的。

**候选 4：SSE / WebSocket**

服务端向所有连着的浏览器推主题变更。

| 优点 | 缺点 |
|------|------|
| 延迟最低（< 1 秒） | 要在 Next.js 的 Route Handler 里维持长连接；Next.js 的 Node 运行时对长连接有约束 |
| | 要处理断线重连、心跳、Nginx 的 `proxy_read_timeout`（默认 60 秒，要配） |
| | **多副本**：客户端连的是哪个副本，就只收那个副本推的消息。副本 A 收到商家保存的推送，副本 B 的客户端收不到 → **要么做发布订阅（Redis pub/sub），要么客户端定期重连** |
| | 复杂度最高，且**收益被候选 5 覆盖** |

**评价**：**放弃**。为了「主题变了」这一个低频事件引入长连接基础设施，
复杂度与收益完全不成比例。

**候选 5：客户端轮询 + 客户端注入 CSS 变量**

在 storefront 放一个客户端组件 `ThemeWatcher`：

1. 挂载时查一次当前主题；
2. 每 30 秒查一次；
3. 页面 `visibilitychange` 到 `visible` 时立即查一次；
4. 主题变了就更新一个 `<style>` 标签的 CSS 变量。

**多副本**：**天然正确**——每个副本的客户端各自查各自的后端，
后端查库拿到的永远是最新值。**没有任何跨副本状态需要同步。**

| 优点 | 缺点 |
|------|------|
| **无状态**——多副本天然正确 | 延迟最高 30 秒（但 `visibilitychange` 会让实际感知延迟远小于此） |
| 实现简单：一个组件 + 一个中转路由 | 每个打开的店铺页多一个请求 / 30 秒 |
| 不动后端、不动 Nginx、不动部署 | |

**决策：候选 5。**

**推荐理由**（按重要性排序）：

1. **多副本正确性是硬约束。** 候选 3、4 都要跨副本同步状态，
   候选 5 什么都不用同步——**它是唯一「加副本不用改代码」的方案**。
2. **不引入新的基础设施。** 候选 3 需要共享缓存层 + 内部鉴权端点；
   候选 4 需要长连接 + 发布订阅。候选 5 只需要一个 HTTP 轮询。
3. **延迟可接受。** 商家改主题不是高频操作。30 秒 + 焦点触发查询，
   实际感知延迟通常在**几秒**（用户切回标签页时立即触发）。
4. **可降级。** 如果将来要求更快，把间隔从 30 秒调到 5 秒即可，
   不需要改架构。

**放弃的方案**：候选 1（不满足「页面开着」的需求）、候选 3（多副本需要额外一致性）、
候选 4（复杂度与收益不成比例）。

#### 4.4.3 实现要点

**新增一个同源中转路由**：`storefront/src/app/api/theme/route.ts`

```ts
/**
 * 主题查询的中转路由（给客户端的 ThemeWatcher 用）。
 *
 * ⚠️ 为什么要专门开一个中转而不是让浏览器直连后端：
 *    后端没开 CORS（设计上前端与 API 同源，由 Nginx 反代），
 *    浏览器直连会变成 Failed to fetch，且不带任何后端错误信息。
 *    同一个理由见 src/app/api/stores/me/route.ts 的说明。
 *
 * ⚠️ 租户从请求头解析：匿名访客靠子域名定位租户，
 *    主题是租户级的——服务端才有这个上下文。
 */
export async function GET() {
  const subdomain = await currentSubdomain();
  try {
    const result = await fetchBackend<ThemeResponse>('/public/theme', { subdomain });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

**新增客户端组件**：`storefront/src/components/theme/theme-watcher.tsx`

关键设计：

| 点 | 设计 |
|----|------|
| 挂载位置 | `(shop)/layout.tsx` 里，紧跟现有的 `<style>` 之后 |
| 注入方式 | **不复用服务端那个 `<style>` 标签**，自己维护一个。理由：服务端那个是服务端渲染的产物，客户端改它会与 React 的 hydration 冲突（React 认为它不该变） |
| 更新方式 | 用 `document.documentElement.style.setProperty('--primary', value)` **直接改 CSS 变量**，而不是重建 `<style>` 标签。这样与服务端注入的 `:root` 规则**合并**（行内样式优先级高于 `:root` 规则），不需要删除服务端那份 |
| 覆盖范围 | **全部** token：顶层标量（`radius` / `fontSans` / `fontMono`）+ 颜色 + **四组分组标量**（`textScale` / `weights` / `spacing` / `shadows`）。分组标量的键名是「前缀 + 键」拼出来的，要用 `GROUP_CSS_VARS` + `GROUP_KEYS` 两张表 |
| 变更检测 | 拿到的 tokens 与上一次的**逐字段比对**，相同就不动 DOM（避免每次轮询都触发样式重算）。实现形态：模块级 `lastApplied: string \| null`，把 tokens 序列化后比较，**相同直接 return** |
| 轮询间隔 | 30 秒 |
| 焦点触发 | `document.addEventListener('visibilitychange', ...)` → `document.visibilityState === 'visible'` 时立即查一次 |
| 失败处理 | **静默失败**。主题拉不到不该影响页面——**保留客户端最后一次成功拉到的值**（可能比服务端注入的那份更新，见 §4.4.5） |

**为什么用 `setProperty` 而不是重建 `<style>`**：

服务端注入的是 `:root { --primary: oklch(...); ... }`（`layout.tsx` 第 51 行）。
CSS 的行内样式（`element.style`）优先级高于任何样式表规则，
所以 `documentElement.style.setProperty('--primary', v)` 会**覆盖** `:root` 里的同名变量，
而其它没被覆盖的变量继续走 `:root`。这正好是「增量更新」想要的语义。

**⚠️ `fontSans` / `fontMono` 与其它 token 行为不一致（要单独核实）。**
`storefront/src/app/globals.css` 第 10 行是 `--font-sans: var(--font-sans);`
——**自引用**（shadcn 默认写法）。`@theme inline` 的 `inline` 语义是把值直接
内联进生成的 utility，所以 `.bg-primary` 编译出来是 `background-color: var(--primary)`，
**没问题**。但字体这一路不同：

- 客户端写 `documentElement` 的行内 `--font-sans: var(--font-geist-sans)`；
- 而 `--font-geist-sans` 只在 `storefront/src/app/layout.tsx` 第 6 行的
  `next/font` 变量作用域里存在（挂在 `<body>` 的 class 上，第 28 行），
  **在非 root 元素上引用会失效**。

**处理**：
1. 在真浏览器里核对
   `getComputedStyle(document.documentElement).getPropertyValue('--font-sans')`
   与实际渲染字体是否一致；
2. 必要时把这两个 token **排除出客户端注入范围**；
3. 至少在文档与代码注释里注明
   「**字体 token 依赖 `next/font` 的变量作用域，客户端注入行为与服务端不同**」。

这条记为 §五 的 **L21**（正确性风险），并在 §6.4 的手测清单里加一条核对项。

**中转路由要不要缓存？** 不要。轮询本身已经是低频（30 秒），
再加一层缓存就要处理失效问题（回到候选 3 的老路）。**每次查**——
`/public/theme` 是一次 `findFirst`（`theme.service.ts` 第 150 行），
开销可接受。

**⚠️ 客户端注入必须复用后端的白名单过滤。**
服务端注入的那份经过 `ThemeService.sanitize`（`theme.service.ts` 第 84–142 行）
与 `buildThemeCss` 的键名白名单（`storefront/src/lib/theme.ts` 第 69–74 行）。
**客户端拿到的是后端 `sanitize` 过的**（`GET /public/theme` 走 `ThemeService.current()`
第 145–155 行，它调 `sanitize`）。所以客户端可以直接信任后端返回的值。

**但仍然要只写自己认识的变量名** —— 客户端 `setProperty` 不受 `:root` 块约束，
写进去就是写进 `documentElement` 的行内样式。虽然 `setProperty` 的值里
带 `;` 或 `}` 不会逃出（CSSOM 会做值解析），但**只写认识的变量名**
仍是最稳妥的。客户端复用 `buildThemeCss` 生成的 CSS 文本是不行的
（那是给 `<style>` 用的）；需要一个「token → CSS 变量名」的映射。

**决策：客户端复用 `theme.ts` 的映射表，不要复制。**
**把 `storefront/src/lib/theme.ts` 里的 `CSS_VARS`、`GROUP_CSS_VARS`、
`GROUP_KEYS` 三张表一起导出**，客户端导入它们。
`theme.ts` 已经有 7 条单元测试（`storefront/test/lib/theme.test.ts`）守着它的白名单。

> **三张表都要导出，不能只导 `CSS_VARS`。**
> 分组标量（`textScale` / `weights` / `spacing` / `shadows`）的键名是
> 「前缀 + 键」拼出来的（`--text-` + key），要同时用 `GROUP_CSS_VARS`
> （前缀表）与 `GROUP_KEYS`（键名白名单表）。
>
> **⚠️ 但「必须写全」的原始理由不成立，要降级。**
> 原稿的理由是「只写主色与圆角是个半成品，比全写更糟——商家改了字阶、
> 间距、阴影，前台一样不变，而商家会以为改了却没生效」。
> **这个前提是错的**：storefront 的 `src/app/globals.css` 第 7–49 行的
> `@theme inline` 块**只映射 colors / radius / fonts**，
> `--text-*` / `--spacing-*` / `--shadow-*` / `--font-weight-*`
> **在前台没有任何消费者**（全仓 grep 确认）。
> 写与不写，**视觉完全一样**。
>
> **真正的产品级发现是另一件事**：**商家可编辑的分组标量在前台没有消费者**
> ——商家改了字阶/间距/阴影，前台纹丝不动，且**没有任何提示**。
> 这跟原来担心的「商家以为改了却没生效」是同一个失效模式，
> 只是原因不是客户端漏写，而是 **CSS 侧没接线**。
> → 记为 §七 遗留项 11。
>
> **那客户端还要不要写全？** 要写，但理由降级为「**写了无害但也无用**」：
> 客户端保留写入以**对齐服务端行为**（`buildThemeCss` 会写全部 token），
> 成本为零（一次循环），且将来 CSS 侧接上消费者时**不需要再改客户端**。

> ⚠️ 注意：`storefront/src/lib/theme.ts` **没有** `'use client'` 标记，
> 它是个纯模块，两端都能 import。加导出**不影响**现有的 Server Component 用法。

**客户端要不要也加 `'use client'`？** 不要——`theme.ts` 里的函数是纯的，
`buildThemeCss` 在服务端用、`CSS_VARS` 在客户端用，两边 import 同一个模块即可。
加了 `'use client'` 反而会让 Server Component 那边多一层客户端边界。

#### 4.4.4 「正在开着的用户多久能看到变化」

这是推荐方案里必须回答的问题。分三种用户状态：

| 用户状态 | 看到变化的延迟 |
|---------|--------------|
| 页面**在前台可见** | ≤ 30 秒（下一个轮询周期） |
| 页面在**后台标签页** | 切回前台时**立即**（`visibilitychange` 触发查询）→ 感知延迟 < 1 秒 |
| 页面**开着但浏览器节流了定时器** | 浏览器对后台标签页的定时器有节流（Chrome 最短 1 秒一次），30 秒的间隔不受影响；切回前台时立即查 |

**最坏情况的感知延迟：30 秒。**
**典型情况：用户切回标签页的瞬间（< 1 秒）。**

**这是一个明确的取舍**，写在这里：

> 我们**不保证**「保存后 1 秒内全站生效」。
> 若将来有这个要求，方案是候选 3（保存时调失效接口）+ Redis pub/sub
> 广播到所有副本——那是另一个量级的工程量，不在本板块。

#### 4.4.5 边界情况

| 情况 | 处理 |
|------|------|
| 主题拉取失败 | 静默失败，**保留客户端最后一次成功拉到的值**（可能比服务端注入的那份更新——服务端注入的那份本身也可能已过时） |
| 访客未登录 | 主题是**公开**接口（`@Public()`，`public-theme.controller.ts` 第 12 行），游客也能查 |
| 轮询在后台持续跑 | 浏览器节流会降低实际频率，无害。可以在 `document.hidden` 时跳过轮询（省请求） |
| 组件卸载 | `useEffect` 的清理函数里 `clearInterval` + 移除事件监听 |
| 多标签页 | 每个标签页各自轮询，互不影响 |
| 主题被改成与上次相同 | 逐字段比对后不变更 DOM（`lastApplied` 相同 → 直接 return） |
| 服务端注入与客户端注入冲突 | 客户端用行内样式，优先级更高，**覆盖**服务端那份 |

---

## 五、风险清单

按「能不能被外部利用」排序。**L1–L3、L18、L19 是可被利用的漏洞**，其余是正确性风险。

### 5.1 可被利用的漏洞

| # | 风险 | 攻击路径 / 失效场景 | 后果 | 采取的措施 |
|---|------|-------------------|------|-----------|
| **L1** | **merchant-admin 刷新失败后会话「假装还登录着」** | 后端 accessToken 2 小时过期 → 商家后台的 `jwt` 回调不做刷新 → `session.accessToken` 仍是那枚过期令牌 → 商家点任何操作都拿到 401。商家看到的是「加载失败（401）」，而**界面上仍然显示自己已登录**（`merchant-admin/src/app/(dashboard)/layout.tsx` 第 16–22 行只判 `!session`） | 商家后台在 2 小时后**整体不可用**，且现象是「某几个按钮坏了」而不是「请重新登录」。这是阶段 3 已在 storefront 侧实测过的同一类 bug | §4.2：照搬 storefront 的刷新实现；刷新失败 → **作废整个会话**（`accessToken`/`refreshToken` 置 `undefined`）→ `session` 回调落成 `''` → `api-client.ts` 第 30 行的 `if (options.token)` 不成立 → **不带 Authorization 头** → 被当游客 → 界面回到未登录态。⚠️ **还要补 `if (!session?.accessToken) redirect('/login')`**——只改 `?? ''` 不够：会话作废后 `session` 仍存在（只是 `accessToken` 是 `''`），`!session` 判不出来，页面仍显示「已登录」，点任何操作都是 401 |
| **L2** | **刷新去重缺失导致整个令牌族被吊销** | 若 merchant-admin 照搬**只有刷新、没有去重**的版本：一次页面请求会读好几次会话（`/api/auth/session`、页面里的 `auth()`、middleware），这些读**常常是并发**的 → 两个并发刷新带着同一枚旧令牌打过去 → 第一个成功并轮换 → 第二个拿着已作废的令牌 → 后端判为**重放** → `api/src/modules/auth/auth.service.ts` 第 268 行 `revokeTokenFamily` **吊销该用户所有设备上的登录** | 商家在**所有设备**上被踢下线。攻击者不需要做任何事，只需要让商家在 2 小时后点一下页面 | §4.2：`inFlightRefreshes` 去重表**必须照抄**（storefront `auth.ts` 第 50、64–80 行）。测试要断言「并发读会话 → `fetch('/auth/refresh')` 只被调一次」 |
| **L3** | **主题 CSS 变量注入** | 商家的 `themeTokens` 是 **JSON 字段、客户端可控**（`api/src/modules/theme/theme.service.ts` 第 75 行注释已点明）。若客户端的 `setProperty` 写入了未过滤的键名或未校验的值 | 若写入的是**值**：`setProperty` 的值由 CSSOM 解析，`;` / `}` 逃不出去——**风险有限**。若写入的是**键名**：`setProperty('--x', v)` 的键名非法时 CSSOM 会**忽略**（不抛错也不生效），也逃不出去 | 后端 `GET /public/theme` 走 `ThemeService.current()` → `sanitize()`（第 84–142 行）**已经过滤**。客户端再叠加一层：只写 `CSS_VARS` 里认识的名字（§4.4.3）。**双重保险**。⚠️ 注意：阶段 2b 的护栏 5 守的是「服务端注入的 `<style>` 里的键名白名单」——客户端这条路是新开的，**必须有对应的白名单** |
| **L18** | **网络抖动被当成「凭证失效」→ 会话被永久作废，用户被静默踢出且无法自愈** | 后端短暂抖动（部署重启、一次 200ms 的网络抖动）→ `requestRefresh` 的 `fetch` **抛异常** → 走 `catch` 分支 → `return null` → `jwt` 回调把 `accessToken` 与 `refreshToken` **都置 `undefined`** → 会话**永久作废** | 商家只是经历了一次 200ms 的抖动，就**被登出**，而且**不可逆**（连 refreshToken 也被清了，必须重新登录）。用户看到的是「莫名其妙跳回登录页」，且**没有任何解释**。现在的实现把「网络失败」与「凭证失效」混为一谈（§4.2.3 的边界表原话：「网络层出错按刷新失败处理（返回 null）」） | **区分「网络失败」与「凭证失效」**：<br>① **网络失败（catch 分支）** → **保留旧令牌**，让本次请求失败（返回 401），**不作废会话**；<br>② **只有后端明确返回 401/403** → 才作废整个会话。<br>实现上：`requestRefresh` 返回三态（`{ ok: true, tokens }` / `{ ok: false, reason: 'invalid' }` / `{ ok: false, reason: 'network' }`），`jwt` 回调只对 `'invalid'` 作废会话。测试要断言「网络异常 → 旧令牌仍在」「401 → 会话作废」两条 |
| **L19** | **刷新去重在多副本/多进程下失效 → 同一枚 refreshToken 被提交两次 → 全设备登录被吊销** | `inFlightRefreshes` 是**模块级变量，只在单进程内有效**（`storefront/src/auth.ts` 第 50 行）。扩副本后，两个并发请求落到**不同进程** → 各发一次刷新 → 同一枚 refreshToken 被提交两次 → 后端 `auth.service.ts` 第 268 行的 `revokeTokenFamily` **吊销该用户所有设备的登录** | 商家在**所有设备**上被踢下线。**⚠️ 但严重性比 L2 低**：后端 `auth.service.ts` 第 250 行的 `isConcurrentRace`（第 328–336 行）已为「并发竞态」兜底——轮换发生在本次请求开始**之后**时，只拒本请求、**不牵连其它设备**。**所以同一进程内的并发刷新不会吊销全设备**（L2 的措施已经挡住了这一类）。**但跨进程/跨机器的竞态窗口仍在**——两个进程的时钟差、`requestStartedAt` 的采样时机都可能让 `isConcurrentRace` 判成「真正的重放」 | §4.2：`inFlightRefreshes` 去重表**必须照抄**（storefront `auth.ts` 第 50、64–80 行）。⚠️ **`inFlightRefreshes` 只在单进程内有效，扩副本前必须换成 Redis 侧的分布式锁，或后端提供幂等刷新端点。** 在此之前，**不要扩 storefront/merchant-admin 的副本数**。测试要断言「并发读会话 → `fetch('/auth/refresh')` 只被调一次」（单进程内的去重），并把「跨进程竞态」**如实记为遗留项**（§七 遗留项 12） |

### 5.2 正确性风险

| # | 风险 | 失效场景 | 后果 | 措施 |
|---|------|---------|------|------|
| **L4** | 组件测试用 `fireEvent` 而不是 `user-event` | `fireEvent.click` 直接派发一个 `click` 事件，**不模拟**真实的事件序列（pointerdown → mousedown → focus → mouseup → click） | 测试通过但真实用户点不动。**这是组件测试最常见的自欺** | §4.1.4：示范性测试用 `@testing-library/user-event`；评审时把「有没有用 fireEvent」当成一条检查项 |
| **L5** | 组件测试忘写 `// @vitest-environment jsdom` | 测试在 node 环境跑 → `document is not defined` | **报错直白，不会静默跑偏**。但若组件恰好不碰 DOM，测试会在 node 环境「通过」——那就不是组件测试了 | 每个组件测试文件**首行**必须写这行注释；评审时逐个检查 |
| **L6** | 组件测试 mock 了 `fetch` 却没断言调用参数 | 只断言「界面出现了某句话」 | 断言恒真——换掉请求体照样通过。阶段 2b/3 的既有约定：**「前端断言要具体」** | §4.1.4 的每条用例都断言 **URL + method + body** |
| **L7** | 组件测试没清 mock | `vi.clearAllMocks()` 漏了，上一个用例的调用记录被下一个用例看到 | 断言串味，测试之间互相污染 | 每个用例的 `beforeEach` 里 `vi.clearAllMocks()`（既有测试已是这个模式，见 `merchant-admin/test/app/api/auth-guard.test.ts` 第 50–54 行） |
| **L8** | merchant-admin 的 `session` 回调漏改 `?? ''` | `session.accessToken = token.accessToken as string`（第 98 行）——`as string` 只是**类型断言**，运行时 `undefined` 原样传出 | 会话作废后 `session.accessToken` 是 `undefined` 而不是 `''`。`api-client.ts` 第 30 行的 `if (options.token)` 是 falsy 检查，**结果碰巧一样**（都不带 header）——但这是**巧合**，不是设计 | §4.2.2：照 storefront 第 211 行改成 `?? ''`；**并且**加一条测试断言「会话作废后 `session.accessToken === ''`」 |
| **L9** | 地址簿页的「设为默认」在前端做了乐观更新 | 前端把旧默认的 `isDefault` 改成 `false` 再把新的改成 `true`，然后**不等服务端响应**就更新界面 | 后端的 `clearDefault` 逻辑（护栏 19）没跑完，界面显示的与库里不一致 | **不做乐观更新**——等 `PATCH` 返回后用**服务端返回的地址**更新界面状态 |
| **L10** | 地址簿页的删除没有二次确认 | 软删虽然可恢复，但用户点错就少一个地址 | 体验问题 | 删除按钮要二次确认（与 `cart-list.tsx` 第 128 行 `confirm('确定清空购物车？')` 的既有风格一致） |
| **L11** | 提取 `AddressForm` 时改了字段校验规则 | 表单有 6 个必填字段，规则在 `sanitizeAddressBody`（`storefront/src/lib/addresses.ts` 第 21–47 行）与后端 DTO 各有一份 | 前后端规则漂移：前端放行、后端 400 | **前端不另写一套规则**——`sanitizeAddressBody` 已有 7 条单元测试（`storefront/test/lib/addresses.test.ts`），直接复用它的判定 |
| **L12** | 主题轮询在 SSR 阶段执行 | `ThemeWatcher` 里有 `setInterval` / `document.addEventListener` | SSR 阶段 `document` 不存在 → 整页 500（`tsc` 与 `next build` 都过得去——阶段 2b 踩过的那类坑） | `ThemeWatcher` 必须是 `'use client'`，且所有 DOM 操作放在 `useEffect` 里（`useEffect` 在 SSR 阶段不执行） |
| **L13** | 主题轮询的 `setInterval` 没清理 | 组件卸载后定时器还在跑 | 内存泄漏 + 无意义的请求 | `useEffect` 的清理函数里 `clearInterval` + `removeEventListener` |
| **L14** | 主题轮询的请求打在后端身上，后端每次都查库 | `ThemeService.current()` 每次 `prisma.store.findFirst`（第 150 行）；每个打开的店铺页每 30 秒查一次 | 数据库压力上升（本板块**新引入**的负载） | 频次低（30 秒 / 页），量级可控。**记录为遗留项**（§七 遗留项 3），不在本阶段加缓存——加缓存就要处理失效（回到候选 3 的复杂度） |
| **L15** | 复制 `token-expiry.ts` 后两边漂移 | 只改了一份 | storefront 与 merchant-admin 的过期判断不一致——一边刷新一边不刷新 | 约定「两份测试文件是同一份」（§4.2.1）；两份的 `test/lib/token-expiry.test.ts` 都要存在且断言相同的行为 |
| **L16** | 组件测试基建的 `include` 改成 `test/**/*.test.{ts,tsx}` 后，既有测试被重新收集 | `include` 扩大 → 收集到更多文件 | 既有测试意外失败（比如 `.tsx` 里恰好有同名文件） | 实施时先跑一次 `npm test` 确认收集到的文件数不变（应是 6 + 6），再继续 |
| **L17** | 地址簿页放在 `(shop)` 路由组外 | 写成 `app/addresses/page.tsx`（顶层） | **绕过 `ShopLayout` 的主题注入**（`layout.tsx` 第 48–53 行）→ 地址簿页没有店铺主题，白底黑字 | §4.3.1：路由必须是 `app/(shop)/account/addresses/page.tsx` |
| **L20** | **多标签页的「先后」竞态（不是并发）→ 全设备登录被吊销** | 标签页 A 刷新成功 → 后端把旧 refreshToken 标记 `ROTATED` 并下发新的，但新令牌**只写进 A 那个进程的 JWT**（A 所在的浏览器标签页自己的 cookie）→ 标签页 B 持有的还是**旧 cookie 里的旧 refreshToken** → B 下次刷新时，那枚旧令牌在 B 请求抵达前**已经被轮换过** → 后端 `auth.service.ts` 第 268 行的 `revokeTokenFamily` 判成「**真正的重放**」（`isConcurrentRace` 判否：轮换时间早于 B 的请求起始时间）→ **吊销该用户所有设备的登录** | 商家在**所有设备**上被踢下线。这**不是** L2 的并发问题（L2 是同一时刻的并发，被 `inFlightRefreshes` 挡住），也**不是** L19 的跨进程问题——这是**时间上先后**的「正常」使用：用户开两个标签页，A 先刷新了，B 稍后才刷新 | 识别「**轮换后旧令牌再次出现**」为**可恢复情形**（而不是重放）。这**需要后端配合**：给轮换后的旧令牌一个**宽限期**（宽限期内再次使用返回同一对新令牌，而不是吊销整个族），或后端提供**幂等刷新端点**。<br>**本阶段不解决后端**，**如实记为遗留项**（§七 遗留项 13）。<br>⚠️ 覆盖不到的部分要在文档里说清楚：**在宽限期机制落地前，多标签页并发使用商家后台存在被全设备踢下线的风险。** |
| **L21** | **`fontSans` / `fontMono` 的客户端注入与其它 token 行为不一致** | `storefront/src/app/globals.css` 第 10 行是 `--font-sans: var(--font-sans);`——**自引用**。`@theme inline` 对颜色这一路没问题（`.bg-primary` 编译出来是 `background-color: var(--primary)`），但字体这一路：客户端写 `documentElement` 的行内 `--font-sans: var(--font-geist-sans)`，而 `--font-geist-sans` 只在 `storefront/src/app/layout.tsx` 第 6 行的 `next/font` 变量作用域里存在（挂在 `<body>` 的 class 上，第 28 行） | 在**非 root 元素**上引用会失效 → 字体与商家设定不一致，且**没有任何报错**。商家改了字体，前台看着没变 | ① 在真浏览器里核对 `getComputedStyle(document.documentElement).getPropertyValue('--font-sans')` 与**实际渲染字体**是否一致（§6.4 加一条手测项）；② 必要时把这两个 token **排除出客户端注入范围**；③ 至少在文档与代码注释里注明「**字体 token 依赖 `next/font` 的变量作用域，客户端注入行为与服务端不同**」 |

### 5.3 设计阶段的疏漏（本轮自查已修掉）

1. 决策 1 的初稿是「全局切 jsdom」——已改为逐文件切环境。
   ⚠️ **但初稿给的理由是错的**：初稿写「`token-expiry.ts` 用了 `Buffer.from`（第 26 行），
   jsdom 环境没有 `Buffer`，13 条既有测试会全挂」。
   **实测不成立**：Vitest 3.2.7 的 jsdom environment **显式注入 `global.Buffer = Buffer`**
   （`node_modules/vitest/dist/chunks/index.CmSc2RE5.js` 第 556–557 行）；
   把 `token-expiry.ts` 的 `readJwtExpiry` 原样放进 jsdom 环境跑，**正常工作**。
   **决策的结论（逐文件切）仍然正确**，但**理由要换**：
   真正的理由是「既有 Route Handler 与纯函数测试**根本不需要浏览器环境**，
   全局切换会波及全部既有测试，而逐文件的 `// @vitest-environment jsdom`
   注释**优先于全局配置**（实测确认）——改全局环境的收益为零、风险是全部回归」。
   详见 §4.1.2。
2. 决策 3 的初稿是「建共享包」——写完核对仓库结构，发现根目录**没有**
   `package.json`，两个应用是完全独立的（各有 `package.json`/`tsconfig`/`vitest.config`），
   建共享包 = 引入 monorepo 工具链。已改为复制 + 防漂移约定。
3. 子项 4b 的初稿方向是「加服务端缓存」——写完核对 `layout.tsx` 第 23 行
   （`force-dynamic`）与第 35–38 行（每次请求拉取），发现**服务端本来就是请求期拉取**，
   问题不在缓存而在「客户端不更新」。已改为客户端轮询。
4. 决策 6 的初稿没考虑多副本——补了 Nginx `upstream` 的证据
   （`infra/nginx/platform.test.conf` 第 9–11 行）与候选方案的对比。
5. §4.2.2 漏了 merchant-admin `session` 回调的 `?? ''` 差异
   （第 98 行 vs storefront 第 211 行）——补为 L8。
6. **§4.1.3 完全没提 `globals: false` 会让 RTL 的自动 cleanup 不注册**——
   RTL v16 的自动 cleanup 依赖**全局** `afterEach`
   （`@testing-library/react/dist/index.js` 第 26 行是 `if (typeof afterEach === 'function')`），
   而本项目 `globals: false` → 全局 `afterEach` 不存在 → **自动 cleanup 根本不注册**
   → DOM 跨用例累积 → 从第 2 条用例起 `getAllByRole` 报
   `Found multiple elements with the role "button"`。已补为 §4.1.2.1。
7. **§4.1.3 漏了 JSX 转换的坑**——本项目 `storefront/tsconfig.json` 第 14 行是
   `"jsx": "preserve"`（Next 用 SWC），**esbuild 不读这个设置**，默认走 classic transform
   → `ReferenceError: React is not defined`。已补进 §4.1.3。
8. **§4.4.3「分组标量必须写全」的论证前提反了**——`@theme inline` 只映射
   colors / radius / fonts，`--text-*` / `--spacing-*` / `--shadow-*` / `--font-weight-*`
   **在前台没有消费者**，写与不写视觉完全一样。已降级为「写了无害但也无用」，
   并把真正的发现（**商家可编辑的分组标量在前台无消费者**）记为遗留项 11。

---

## 六、测试策略

延续阶段 3 的做法：**每个关键护栏都要做失败注入**——
把保护逻辑临时改坏、跑测试、确认失败、立刻还原，以此证明测试真的在守东西。

### 6.1 护栏清单（本阶段）

| # | 护栏 | 失效后果 | 怎么测 |
|---|------|---------|--------|
| 1 | **组件测试真的在渲染**（jsdom 环境生效、React 真的挂载了） | 组件测试变成「只 import 不渲染」的假测试 | 断言 `screen.getByRole('button', { name: '加入购物车' })` 存在。**注入验证**：**把某个组件测试文件里的 `// @vitest-environment jsdom` 注释删掉** → 该文件在全局 `node` 下跑 → `document is not defined` → 这条必须挂。⚠️ **不要改成「把全局 `environment` 改成 `node`」**——逐文件注释**优先于全局配置**，那样注入**不会生效**（实测确认） |
| 2 | **组件测试的断言是具体的**（断言 URL + method + body，不是只断言「出现了某句话」） | 断言恒真，改实现也测不出来 | 注入验证：把 `fetch` 的调用参数改成错的 URL → 必须挂 |
| 3 | **merchant-admin 在 accessToken 过期时刷新** | 商家后台 2 小时后整体不可用（L1） | 单测 `auth.ts` 的 `jwt` 回调逻辑；浏览器手测 |
| 4 | **merchant-admin 的刷新去重**（并发读会话只发一次刷新） | 并发刷新被判重放 → 吊销全设备登录（L2） | 单测：并发调 `jwt` 回调 3 次 → `fetch('/auth/refresh')` 只被调 1 次 |
| 5 | **刷新失败作废会话**（不是继续用过期令牌） | 用户拿着过期令牌继续请求 → 满屏 401 | 单测：刷新返回 401 → 断言 `session.accessToken === ''` 且 `refreshToken` 为空 |
| 6 | **短期令牌不被反复判过期**（提前量按寿命的 1/10 收敛） | 每次读会话都刷新 → 踩到并发 → L2 | 照抄 storefront `token-expiry.test.ts` 的 13 条用例 |
| 7 | **地址簿页能改、删、设默认** | 用户只能进结算页维护地址 | 组件测试 + 浏览器手测 |
| 8 | **地址簿页的表单校验规则与 `sanitizeAddressBody` 一致** | 前后端规则漂移 | 复用 `sanitizeAddressBody` 的 7 条用例 + 组件测试断言错误提示 |
| 9 | **地址簿页在 `(shop)` 路由组下**（继承主题注入） | 页面没有店铺主题（L17） | 浏览器手测：核对 `getComputedStyle(document.documentElement)` 拿到的 `--primary` 不是默认值 |
| 10 | **主题改动后前台能感知**（不刷新也能变） | 用户必须手动刷新 | 浏览器手测：改主题 → 切回前台标签页 → 核对计算样式 |
| 11 | **主题轮询失败不影响页面** | 后端抖动导致白屏 | 组件测试：`fetch` 返回 500 → 断言页面仍渲染出原有内容 |
| 12 | **主题的 CSS 变量只写白名单里的名字** | 注入面（L3） | 单测：客户端用的映射表只含 `CSS_VARS` 的键 |

### 6.2 测试分层

| 层 | 用什么 | 测什么 | 本阶段的量 |
|----|-------|-------|-----------|
| **纯函数单测** | Vitest + node 环境 | `token-expiry`（merchant-admin 侧新拷一份）、`sanitizeAddressBody`（复用） | merchant-admin +13 条（与 storefront 同一份） |
| **Route Handler 单测** | Vitest + node 环境 | 新增的 `/api/theme` 中转路由 | storefront **+2 条**（成功 / 后端 5xx）。⚠️ 原稿写「+3 条（成功 / 后端 5xx / **租户解析**）」——**「租户解析」没有测试可挂**：计划的 `theme.test.ts` 把 `currentSubdomain` 整个 mock 掉了，**没有测到解析逻辑**。两条路二选一（见 §6.3 的失败注入清单与实施计划 Task 4）：**要么**补一条真测 `resolveTenantSubdomain` 的用例（在 `storefront/src/lib/tenant.ts` 加单测），**要么**把这里改成「+2 条」 |
| **组件渲染测试** | Vitest + jsdom + RTL | 「加入购物车」按钮（示范）、地址簿页的表单与地址簿、主题轮询组件 | storefront +25 条左右 |
| **浏览器手测** | ego-browser | 商家后台连续用 2 小时后的表现、地址簿页的完整流程、主题实时生效 | 见 §6.4 |

### 6.3 失败注入清单（阶段 4 的「机制级验证」）

每一项都要：**改坏 → 跑测试 → 确认挂 → 还原 → 复跑确认绿**。

| # | 注入 | 预期挂掉的测试 |
|---|------|--------------|
| 1 | **把某个组件测试文件里的 `// @vitest-environment jsdom` 注释删掉** | 该文件在全局 `node` 下跑 → `ReferenceError: document is not defined`。⚠️ **不要改成「把全局 `environment` 改成 `node`」**——逐文件注释**优先于全局配置**，那样注入不会生效（实测确认） |
| 2 | `spec-selector.tsx` 的 `fetch` URL 改成 `/api/cart/item`（少个 s） | 断言 URL 的那条用例挂 |
| 3 | `spec-selector.tsx` 的 body 去掉 `quantity` | 断言 body 的那条用例挂 |
| 4 | `spec-selector.tsx` 删掉「缺货时禁用按钮」的判断 | 缺货用例挂 |
| 5 | `spec-selector.tsx` 的错误提示改成固定的「加入购物车失败」 | 「透出后端 message」用例挂 |
| 6 | merchant-admin `auth.ts` 去掉 `isTokenExpired` 判断 | 「过期时刷新」用例挂 |
| 7 | merchant-admin `auth.ts` 去掉 `inFlightRefreshes` 去重 | 「并发只刷新一次」用例挂 |
| 8 | merchant-admin `auth.ts` 的刷新失败分支改成「保留旧令牌」 | 「刷新失败作废会话」用例挂 |
| 9 | `token-expiry.ts` 的提前量去掉收敛（`Math.min` → `leewaySeconds`） | 「短寿命令牌不被反复判过期」用例挂 |
| 10 | 地址簿页的「设为默认」改成前端乐观更新、不等响应 | `address-book.test.tsx` 的「**设为默认等 PATCH 返回后才更新界面**」用例挂 |
| 11 | 地址簿页去掉删除的二次确认 | `address-book.test.tsx` 的「**点第一次不调 DELETE，第二次才调**」用例挂 |
| 12 | `ThemeWatcher` 的 `clearInterval` 删掉 | 组件卸载后定时器泄漏——**这条靠代码审查 + 手测**，不靠自动化（可加一条「卸载后不再请求」的用例）。⚠️ **#12 不计入 12 项护栏的自动化验证**（护栏清单里没有对应项），验收记录里要单独标注，别混进护栏账目 |
| 13 | `ThemeWatcher` 的变更检测改成「总是重写 DOM」（即把 `lastApplied` 的比较去掉） | `theme-watcher.test.tsx` 的「**主题没变时不重写 DOM**」用例挂（性能护栏）。⚠️ **这条要求实现里必须有变更检测**——见 §4.4.3 的「变更检测」行 |

### 6.4 浏览器手测清单

| # | 场景 | 预期 |
|---|------|------|
| 1 | merchant-admin：把 `JWT_EXPIRES_IN` 调到 45 秒，登录后等令牌过期 | 页面**自动**刷新令牌，后续操作正常（不是 401） |
| 2 | merchant-admin：**先让标签页 A 刷新成功**（A 里的 accessToken 过期 → A 触发刷新成功），**再让标签页 B 触发刷新**（B 还持有旧 cookie 里的旧 refreshToken） | **这是 L20 的「先后」竞态，不是并发。** 预期（**当前实现下会失败**）：后端 `refresh_tokens` 表里会出现 `REVOKED_FAMILY`（B 的旧令牌被判成「真正的重放」→ `revokeTokenFamily` 吊销全设备）。⚠️ **本阶段不修后端**——观察并**如实记录**这个现象，写进验收记录的遗留项（§七 遗留项 13）。**不要**把它当成「并发去重失效」——并发那一类由 `inFlightRefreshes` 挡住，护栏 4 的用例才是它的测试 |
| 3 | merchant-admin：把 refreshToken 也弄过期 | 界面回到未登录态（跳登录页），不是满屏 401 |
| 4 | storefront `/account/addresses` | 列表显示地址、默认地址有标记、能新增/编辑/删除/设默认；**页面上有「返回我的账户」的链接**（见 §4.3.2） |
| 5 | 地址簿页改默认地址 → 回结算页 | 结算页选中的是新的默认地址 |
| 6 | 地址簿页的样式 | 与其它店铺页一致（主题生效）——核对 `--primary` 不是默认值 |
| 7 | 商家后台改主题 → **不刷新** storefront，切换标签页 | 前台在几秒内变色（`visibilitychange` 触发） |
| 8 | 商家后台改主题 → storefront 页面**一直开着不动** | 30 秒内变色（轮询触发） |
| 9 | 后端停掉，storefront 页面刷新 | 页面仍能渲染（主题拉不到不白屏） |
| 10 | storefront 的字体 token | **L21 的核对项**：在控制台执行 `getComputedStyle(document.documentElement).getPropertyValue('--font-sans')`，与**实际渲染字体**对照。若不一致（很可能——`--font-geist-sans` 只在 `next/font` 的变量作用域里存在），把 `fontSans` / `fontMono` **排除出客户端注入范围**，并在验收记录里写明 |

---

## 七、遗留项与已知取舍

| # | 事项 | 影响 | 建议 |
|---|------|------|------|
| 1 | **主题生效延迟最长 30 秒** | 不是「保存即生效」 | 商家改主题是低频操作；「切回标签页立即生效」覆盖了绝大多数感知场景。若要 1 秒内生效 → 走 §4.4.2 候选 3 + Redis pub/sub |
| 2 | **主题轮询的请求量** | 每个打开的店铺页每 30 秒一个请求 | 量级可控。将来请求量成问题时，加一层「按租户 + 短 TTL」的**进程内**缓存（每副本各缓存各的，TTL 从各副本自己的写入时刻算——多副本下延迟不一致，但比不加缓存好） |
| 3 | **后端每次查库**（`ThemeService.current()` 每次 `findFirst`） | storefront 每个请求 + 每个轮询都查一次 `stores` 表 | 阶段 3 遗留的性能债，本阶段**不新增加缓存层**——加缓存就要处理失效（§4.4.2 候选 3 的复杂度） |
| 4 | **token-expiry.ts 有两份副本** | 改一份忘另一份会漂移 | 约定「两份测试文件是同一份」（§4.2.1）。**更彻底的解法是 monorepo 共享包**，但那是基础设施改造，见 §4.2.1 |
| 5 | **组件测试只覆盖了 storefront** | merchant-admin 的组件（订单列表、主题表单、库存面板）仍无渲染测试 | 本阶段只做一条示范性测试（验证基建可用）+ 地址簿页的测试。merchant-admin 的组件测试留到后续 |
| 6 | **地址簿页只有消费者侧** | 商家侧没有地址簿（商家发货填的是收货信息，不是地址簿） | 阶段 3 遗留项 3 说的是「消费者侧与商家侧都是这样」，但**商家侧本来就不需要**地址簿——商家发货时看到的是订单里的收货快照 |
| 7 | **没有真实浏览器的 E2E** | 跨页面的完整流程仍靠手测 | 本阶段不引入 Playwright。若将来手测负担变重再立项 |
| 8 | **主题的客户端注入覆盖服务端注入** | 客户端用行内样式（优先级更高）。若服务端也改了同一变量，客户端的值胜出 | 这是**期望行为**——客户端拿到的是更新更晚的值 |
| 9 | **「加入购物车」按钮之外的组件仍无渲染测试** | 阶段 3 手测挖出的三个 bug 里，只有加购按钮有组件测试 | 组件测试基建到位后，逐步补齐结算页、购物车页、订单页的渲染测试 |
| 10 | **商家后台没有主题的「实时预览」**（§一 子项 4a） | 商家在后台改主色，**在自己的浏览器里当场看不到效果**——只能切到另一个标签页看前台才知道改成什么样。**这是商家最容易困惑的场景**：改主色时自己都看不到变化 | 本阶段做的是 4b（**前台访客的实时生效**），**4a 没做**。<br>若要做：商家后台的主题编辑页需要一份**预览 iframe / 预览容器**，它自己调 `/public/theme`（或直接用编辑中的草稿值）渲染一份样式，与后台布局解耦。<br>⚠️ 注意这条**正是验收 §六 遗留项 2 的原文**（「商家后台没有『主题改动』的实时预览」）——**本阶段只解决了它的一半**（前台访客能感知），**另一半明确留在这里** |
| 11 | **商家可编辑的分组标量（字阶 / 间距 / 阴影 / 字重）在前台没有消费者** | 商家在后台改了字阶、间距、阴影，**前台纹丝不动**，且**没有任何提示**。商家会以为改了却没生效 | 根因在 **CSS 侧没接线**，不是客户端漏写：`storefront/src/app/globals.css` 第 7–49 行的 `@theme inline` 块只映射 colors / radius / fonts，`--text-*` / `--spacing-*` / `--shadow-*` / `--font-weight-*` **在前台没有任何消费者**。<br>要修：在 `@theme inline` 里补上映射，或把这些变量接到具体的 utility class 上。<br>⚠️ 本阶段的客户端**保留写入**这四组变量（对齐服务端 `buildThemeCss` 的行为，成本为零）——将来 CSS 侧接上消费者时不需要再改客户端 |
| 12 | **刷新去重只在单进程内有效，扩副本前必须换分布式锁**（L19） | `inFlightRefreshes` 是模块级变量，**多副本下两个进程各发一次刷新** → 同一枚 refreshToken 被提交两次 → 可能触发 `revokeTokenFamily` 吊销全设备登录 | **在换成 Redis 侧的分布式锁、或后端提供幂等刷新端点之前，不要扩 storefront / merchant-admin 的副本数。**<br>⚠️ 缓解：后端 `api/src/modules/auth/auth.service.ts` 第 250 行的 `isConcurrentRace` 对「并发竞态」有兜底（只拒本请求，不牵连其它设备）——**所以同一进程内的并发刷新不会吊销全设备**（L2 的措施已挡住），跨进程/跨机器的竞态窗口仍在 |
| 13 | **多标签页的「先后」刷新竞态会吊销全设备登录**（L20） | 标签页 A 刷新成功后，标签页 B 持有的旧 refreshToken 会被后端判成「真正的重放」→ `revokeTokenFamily` 吊销该用户**所有设备**的登录 | 需要**后端配合**：给轮换后的旧令牌一个**宽限期**（宽限期内再次使用返回同一对新令牌），或提供**幂等刷新端点**。本阶段**不改后端**。<br>⚠️ 在此之前，**多标签页并发使用商家后台有被全设备踢下线的风险**——这一点要在验收记录里如实写出来 |

---

## 附：与既有设计的关系

- 阶段 3 的设计文档 `2026-10-24-plan-03-transaction-design.md` §十二 的风险清单
  是本阶段风险清单的对照基准——阶段 3 靠它抓出 6 个可被利用的漏洞，
  本阶段的风险清单（§五）按同样标准排。
- 阶段 3 的验收记录 `2026-10-24-plan-03-acceptance.md` §六 是本阶段范围的
  直接来源（遗留项 1/2/3），§三「补做手测」是子项 2 的 bug 证据。
- 阶段 2b 确立的「中转路由必须白名单重建请求体」「前端断言要具体」两条约定，
  在本阶段继续适用（§四.3.5、§6.1 护栏 2）。
- 主设计文档 `2026-10-21-multi-tenant-ecommerce-saas-design.md` §十
  （营销与计费）留给阶段 4 的后续板块，本板块不碰。

## 附二：对阶段 3 验收记录的修正

这一轮核对时，发现阶段 3 验收记录里有两处结论与代码现状不符。**记录在这里，
免得后面的人按验收记录的字面意思理解。**

| # | 阶段 3 验收记录的说法 | 代码事实 | 修正 |
|---|------------------|---------|------|
| 1 | 遗留项 4：「购物车金额改服务端实时价」——初稿把它当成本阶段的**后端改动**排除掉 | **阶段 3 已经实现了。** `api/src/modules/cart/cart.service.ts` 第 411–417 行的 `read()` 里 `include: { sku: { select: { id, price, product } } }`——**购物车接口返回的就是数据库里 SKU 的当前价**；前端 `storefront/src/lib/cart.ts` 第 165 行的 `itemSubtotal` 用的就是 `item.sku?.price` | **阶段 3 遗留项 4 已经由阶段 3 实现**，**本阶段无需任何改动**。见 §1.2 |
| 2 | 遗留项 2：「商家后台没有『主题改动』的**实时预览**——改完主题要刷新前台才看得到变化」 | 这是**两个不同的需求**：①「实时预览」= 商家在后台编辑时**当场**看到效果；②「前台实时生效」= 商家保存后，**已打开前台的访客**看到效果。本阶段做的是 ② | **拆分**：4a（实时预览）**本阶段不做** → §七 遗留项 10；4b（前台实时生效）**本阶段做**。见 §一 的表格与 §1.2 |
