# storefront（消费者店铺前台）

多租户电商 SaaS 平台的消费者端。一个租户 = 一家店铺 = 一个子域名
（`<subdomain>.example.com`），浏览器落在哪家的域名下，看到的就是哪家的店。

## 本地启动

```bash
# 共享包是 file: 依赖，必须先装它自己的依赖（npm 不会替你装）
(cd ../packages/frontend-shared && npm install)

cp .env.example .env     # 按需改 AUTH_SECRET 与 NEXT_PUBLIC_TENANT_SUBDOMAIN
npm install
npm run dev              # http://localhost:3001（固定 3001，3000 留给 api）
```

需要后端 `api` 已在 `http://localhost:3000` 运行，否则首页会显示「店铺不存在」
（页面照常渲染，不会 500）。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/auth.ts` | NextAuth v5 配置。`authorize` 带 `x-tenant-subdomain` 调后端 `/auth/login`，scope 固定为 `CUSTOMER` |
| `src/lib/jwt-callback.ts` | 令牌刷新的**决策逻辑**——从 `@ecom/frontend-shared/jwt-callback` 再导出（阶段 7c 收编，三端共用一份） |
| `src/lib/tenant.ts` | 店铺子域名解析。优先取 `X-Tenant-Subdomain` 头，其次从 host 首段取；裸 IP / IPv6 / localhost 会被识别出来 |
| `src/lib/api-client.ts` | 后端 API 封装（薄壳）：调共享包的 `createApiClient(...)`，按本端策略注入子域名 / cookie 透传 / `auth` |
| `src/lib/theme.ts` | 主题 token → CSS 变量。`CSS_VARS` / `GROUP_CSS_VARS` 两张映射表**同时是白名单** |
| `src/lib/server-cart.ts` | 服务端调后端的公共封装（`currentSubdomain` / `forwardableCookie` / `fetchBackend`） |
| `src/app/(shop)/` | 店铺侧页面：首页、分类、商品详情、搜索、购物车、结算、订单、优惠券、地址簿、账户 |
| `src/app/api/` | 同源中转路由：购物车、订单、优惠券、地址、主题 |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth 的 HTTP 入口 |

## 关键约定

- **登录必须带店铺子域名。** 顾客邮箱只在租户内唯一，同一邮箱可以在多家店各有一个
  账号；不指定店铺时后端只能按创建时间兜底，用户会在 A 店的登录页登录进 B 店。
  子域名**从当前请求解析**（`src/lib/tenant.ts`），不是读环境变量——一个进程服务
  所有店铺时环境变量是固定的，会把顾客永远限定到同一家店。生产环境由网关从 Host
  反推后注入 `X-Tenant-Subdomain`；本地访问 `localhost:3001` 时取不到子域名，
  由 `NEXT_PUBLIC_TENANT_SUBDOMAIN` 兜底。
- **`auth()` 是服务端 API。** NextAuth v5 里 `auth()` 只能在服务端组件里用；
  客户端组件用 `signIn` / `signOut`。
- **令牌存 JWT session。** `accessToken`、`role`、`tenantId` 由 `jwt` 回调写入，
  `session` 回调透出，服务端组件据此调后端。
- **`jwt` 回调的决策逻辑抽在共享包。** `src/auth.ts` 顶层就调
  `NextAuth({...})`，import 它就会初始化整个 next-auth 依赖图 → 测不了。
  抽出来才能对「过期时刷新」「送不回去 cookie 时不刷新」「刷新失败时作废会话」
  这三条分支做断言。阶段 7c 起三端共用 `@ecom/frontend-shared/jwt-callback`
  同一份实现，`src/lib/jwt-callback.ts` 只是再导出——**不要再往这里写逻辑**。
- **主题变量的映射表要导出给客户端复用。** `CSS_VARS` / `GROUP_CSS_VARS`
  服务端（拼 `<style>`）与客户端（`ThemeWatcher` 的 `setProperty`）各用一份；
  各写一份必然漂移——服务端加了新 token 而客户端没加，那个 token 就永远不生效。
  ⚠️ `GROUP_CSS_VARS` **同时是白名单**：键名不能靠前缀拼，
  否则 `tokens.textScale['sm; } body{']` 能逃出 CSS 声明。

## 单元测试

```bash
npm test          # 228 条 / 30 个文件
npm run test:watch   # watch 模式
```

框架是 **Vitest**（不是 Jest——Next.js 15 + React 19 生态里 Vitest 是主流，
原生 ESM/TS，`vi.mock` 好用）。配置见 `vitest.config.ts`。

### 测什么

三类：

1. **纯函数** —— 主题 token 的白名单、购物车与优惠券的金额计算、子域名解析、
   令牌过期判定、jwt 回调的决策逻辑。
2. **Route Handler** —— Next.js 的 Route Handler 就是普通导出函数
   （`export async function POST(request: Request)`），**可以直接 import 并调用**，
   传一个 `new Request(url, { method, body })` 就能拿到返回的 `Response`。
   **不需要起服务器，也不需要 jsdom。**
3. **React 组件渲染** —— 需要 jsdom + Testing Library。

### 组件测试基建（阶段 5b 建起来）

⚠️ **全局环境是 `node`**，组件测试在自己的文件里用
`// @vitest-environment jsdom` **逐文件切换**——逐文件的注释优先于全局配置。
既有 Route Handler 测试与纯函数测试根本不需要浏览器环境，改全局环境收益为零、
风险是全部回归。

### 现有测试覆盖的护栏

| 测试文件 | 护栏 |
| --- | --- |
| `test/lib/theme.test.ts` | 主题 token 的键名白名单：恶意键名不能逃出 `:root` 块 |
| `test/lib/jwt-callback.test.ts` | 令牌刷新的三条决策分支（9 条） |
| `test/lib/tenant.test.ts` | 子域名解析：裸 IP / IPv6 / localhost 不被当成子域名 |
| `test/app/globals-css.test.ts` | `@theme inline` 里没有自引用，主题 token 真的落到 `:root` |
| `test/app/api/{cart,order,coupon}-whitelist.test.ts` | 中转路由的请求体白名单重建 |
| `test/components/theme/theme-watcher.test.tsx` | 主题轮询与 `setProperty` 的落点 |
| `test/components/address/*.test.tsx` | 地址簿与地址表单 |

断言要两边都测：恶意键名**不出现**在输出里，**且**正常键名
（`textScale.xs` 等）**必须出现**在输出里——只测「恶意被丢弃」不够，
一个「全部丢弃」的实现也能通过那些断言。

### 写这类测试的坑

- **`vi.mock` 的路径要与被测文件里的 import 路径一致。**
  路径不一致 mock 不生效——症状是「测试跑起来但断言的是真实现」。
- **`server-only` 在 Vitest（node 环境）里会直接抛错。**
  `vitest.config.ts` 里把它 alias 到了一个空模块兜底。
- **`esbuild: { jsx: 'automatic' }` 必须写在配置的根级**，不能写在 `test` 下面
  （esbuild 是 Vite 的根级选项）。漏了的话所有组件测试报 `React is not defined`
  ——本项目的 tsconfig 是 `"jsx": "preserve"`，而 esbuild 不读 tsconfig 的 jsx 设置。

测试放在顶层 `test/` 目录（`src/` 之外），`next build` 不会编译它们。
