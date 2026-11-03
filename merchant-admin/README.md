# merchant-admin（商家后台）

多租户电商 SaaS 平台的商家端。商家登录后管理自己店铺的商品、订单、营销、
账目与设置。

商家后台跑在**中心域名**（生产 `merchant.<域名>`，本地 `localhost:3002`），
**没有店铺子域名**——当前属于哪家店完全由 accessToken 里的 `tenantId` 决定。

## 本地启动

```bash
cp .env.example .env     # 按需改 AUTH_SECRET
npm install
npm run dev              # http://localhost:3002（固定 3002，3000 留给 api）
```

需要后端 `api` 已在 `http://localhost:3000` 运行。后端没起时页面会显示错误提示
与返回入口，**不会 500**。

先注册一个商家账号才能登录：

```bash
curl -X POST http://localhost:3000/api/v1/auth/register/merchant \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.test","password":"Passw0rd123","merchantName":"演示商家","subdomain":"demo","storeName":"演示店铺"}'
```

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/auth.ts` | NextAuth v5 配置。`authorize` 用 `scope: 'MERCHANT'` 调后端 `/auth/login`，**不带** `x-tenant-subdomain` |
| `src/lib/jwt-callback.ts` | 令牌刷新的**决策逻辑**（纯模块，可测）。`src/auth.ts` 只负责 NextAuth 配置 |
| `src/lib/api-client.ts` | 后端 API 封装：`apiFetch` / `apiFetchAuthed` / `ApiError` |
| `src/lib/route-helpers.ts` | 中转路由的公共辅助：`readJson` / `toErrorResponse` / `unauthorizedResponse` |
| `src/app/(auth)/login/` | 登录页 |
| `src/app/(dashboard)/` | 概览、品类、商品（含导入）、库存、订单、营销、店铺设置、订阅与账单、结算单与出款、商家对账单、**收款账户（含默认出款渠道）** |
| `src/app/api/` | 同源中转路由：商品、品类、订单、库存、营销、计费、出款、收款账户、媒体 |

## 关键约定

- **客户端不直连后端 API。** 后端没有开 CORS（设计上前端与 API 同源，由 Nginx 反代），
  浏览器从 `localhost:3002` 直连 `localhost:3000` 会被预检拦掉，表现为
  `Failed to fetch` 且不带任何后端错误信息。**写操作一律走本项目的同源中转路由**
  （如 `/api/stores/me`），由服务端读 session、调后端。
  这样也顺带让 accessToken 只存在于服务端，不必为了发一个写请求就下发到客户端。
- **中转层要「白名单重建」请求体，不能原样透传。** 后端的 `ValidationPipe` 开了
  `forbidNonWhitelisted`，多一个字段就是 400。而且**在中转层就按白名单挡掉**
  比透过去让后端 400 好——界面上的错误提示更明确，也避免有人拿这个中转
  顺手发出没有预览的不可逆操作。典型范本：`src/app/api/products/batch/route.ts`
  （动作白名单 + 批量上限 200 + 畸形请求体挡掉）。
- **`apiFetchAuthed` 只能在服务端组件里用。** 它内部 `await auth()`，而 NextAuth v5
  的 `auth()` 要读 cookie，只能在服务端请求作用域里调用——客户端组件里调它会抛
  `headers was called outside a request scope`。
- **登录用 `scope: 'MERCHANT'`。** 商家账号与消费者账号可能同邮箱，登录入口
  决定匹配哪一个身份。
- **`auth()` 是服务端 API。** NextAuth v5 里 `auth()` 只能在服务端组件里用；
  客户端组件用 `signIn` / `signOut`。
- **令牌存 JWT session。** `accessToken`、`role`、`tenantId` 由 `jwt` 回调写入，
  `session` 回调透出，服务端组件据此调后端。
- **刷新逻辑抽在 `src/lib/jwt-callback.ts`。** `src/auth.ts` 顶层就调 `NextAuth({...})`，
  import 它就会初始化整个 next-auth 依赖图 → 测不了。
  ⚠️ **与 `storefront` 的那份逐行一致，改一份必须同步另一份。**
- **`themeTokens` 的结构是 `{ colors: { primary: '#rrggbb' } }`。** 后端只把它当
  不透明的 JSON 存，约定由前端定；storefront 读它渲染主题色时依赖同一结构。
- **主题表单带预览区。** 改主色 / 字体 / 字阶 / 字重 / 阴影 / 间距时预览区实时联动，
  且与后台自身的 UI 隔离（后台按钮不跟着店铺主题变）。

## 单元测试

```bash
npm test          # 413 条 / 27 个文件
npm run test:watch   # watch 模式
```

框架是 **Vitest**（不是 Jest——Next.js 15 + React 19 生态里 Vitest 是主流，
原生 ESM/TS，`vi.mock` 好用）。配置见 `vitest.config.ts`。

### 测什么

三类：

1. **Route Handler。** Next.js 的 Route Handler 就是普通导出函数
   （`export async function POST(request: Request)`），**可以直接 import 并调用**，
   传一个 `new Request(url, { method, body })` 就能拿到返回的 `Response`。
   **不需要起服务器，也不需要 jsdom。**
   - mock `@/auth` 的 `auth()`，让它返回 `{ accessToken: 'test-token' }` 或 null；
   - mock `@/lib/api-client` 的 `apiFetch`，**断言它被调用时收到的参数**
     ——这是验证「白名单真的重建了 body」的唯一办法。
2. **纯函数。** 例如 `src/lib/money.ts` 的金额换算、`src/lib/jwt-callback.ts` 的
   刷新决策、`src/lib/payout.ts` 与 `src/lib/statement.ts` 的账目口径。
3. **React 组件渲染。** 需要 jsdom + Testing Library。

⚠️ **全局环境是 `node`**，组件测试在自己的文件里用
`// @vitest-environment jsdom` **逐文件切换**——逐文件的注释优先于全局配置。

### 现有测试覆盖的护栏

| 测试文件 | 护栏 |
| --- | --- |
| `test/app/api/auth-guard.test.ts` | 中转路由的认证：未登录必须 401，且**不得**调后端 |
| `test/app/api/body-whitelist.test.ts` | 中转路由的请求体白名单：未知字段必须被丢弃（不透传给后端） |
| `test/app/api/malformed-body.test.ts` | 中转路由拦截数组 / 字符串 / null 请求体 → 400 |
| `test/app/api/batch-ids-limit.test.ts` | 批量接口的 ids 数量上限（> 200 → 400） |
| `test/app/api/query-whitelist.test.ts` | 查询参数白名单重建 |
| `test/app/api/order-whitelist.test.ts` | 订单中转路由的护栏 |
| `test/app/api/{billing,coupon}-whitelist.test.ts` | 计费 / 营销中转路由的白名单 |
| `test/app/api/payout-route.test.ts` / `payout-account-route.test.ts` | 出款与收款账户中转路由 |
| `test/lib/jwt-callback.test.ts` | 令牌刷新的三条决策分支（9 条） |
| `test/components/theme/theme-form.test.tsx` | 主题表单的预览区实时联动，且不影响后台自身 UI |
| `test/app/payouts-page.test.tsx` 等 | 出款页、申请页、对账单页的页面级测试 |

### 写这类测试的坑

- **`vi.mock` 的路径要与被测文件里的 import 路径一致。**
  被测文件写 `import { auth } from '@/auth'`，测试里就写 `vi.mock('@/auth', ...)`。
  路径不一致 mock 不生效——症状是「测试跑起来但断言的是真实现」。
- **`@/auth` 会 import `next-auth`，`next-auth` 可能 import `server-only`**，
  在 Vitest（node 环境）里会直接抛错。`vitest.config.ts` 里把 `server-only`
  alias 到了一个空模块兜底。
- **断言要具体。** 这个项目栽过好几次「断言对了但没测到东西」：
  - 「只断言 200」——畸形入参也 200，等于没测；
  - 「只断言报错」——报错也可能来自别的原因。
  所以 401 就断言状态码**且**断言 `apiFetch` 没被调；400 就断言状态码**且**
  断言 body 里的错误文案；白名单就断言 `apiFetch` 收到的**完整 body**
  （用 `toEqual`，不是「不含某字段」——后者能被「全部丢弃」的实现蒙混过关）。
- **`esbuild: { jsx: 'automatic' }` 必须写在配置的根级**，不能写在 `test` 下面
  （esbuild 是 Vite 的根级选项）。漏了的话所有组件测试报 `React is not defined`
  ——本项目的 tsconfig 是 `"jsx": "preserve"`，而 esbuild 不读 tsconfig 的 jsx 设置。

### 覆盖的护栏

认证未登录 401 且不碰后端、请求体白名单重建、数组/字符串/null 请求体拦截、
批量 ids 上限（200）、**查询参数白名单重建**、令牌刷新决策、主题预览隔离。

测试放在顶层 `test/` 目录（`src/` 之外），`next build` 不会编译它们。
