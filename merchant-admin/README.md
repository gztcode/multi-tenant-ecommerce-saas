# merchant-admin（商家后台）

多租户电商 SaaS 平台的商家端。商家登录后管理自己店铺的商品、订单、营销与设置。

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
| `src/lib/api-client.ts` | 后端 API 封装：`apiFetch` / `apiFetchAuthed` / `ApiError` |
| `src/app/(auth)/login/` | 登录页 |
| `src/app/(dashboard)/` | 后台页面：概览、店铺设置 |
| `src/app/api/stores/me/route.ts` | 店铺设置保存的**同源中转**接口 |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth 的 HTTP 入口 |

## 关键约定

- **客户端不直连后端 API。** 后端没有开 CORS（设计上前端与 API 同源，由 Nginx 反代），
  浏览器从 `localhost:3002` 直连 `localhost:3000` 会被预检拦掉，表现为
  `Failed to fetch` 且不带任何后端错误信息。**写操作一律走本项目的同源中转路由**
  （如 `/api/stores/me`），由服务端读 session、调后端。
  这样也顺带让 accessToken 只存在于服务端，不必为了发一个写请求就下发到客户端。
- **`apiFetchAuthed` 只能在服务端组件里用。** 它内部 `await auth()`，而 NextAuth v5
  的 `auth()` 要读 cookie，只能在服务端请求作用域里调用——客户端组件里调它会抛
  `headers was called outside a request scope`。
- **登录用 `scope: 'MERCHANT'`。** 商家账号与消费者账号可能同邮箱，登录入口
  决定匹配哪一个身份。
- **`auth()` 是服务端 API。** NextAuth v5 里 `auth()` 只能在服务端组件里用；
  客户端组件用 `signIn` / `signOut`。
- **令牌存 JWT session。** `accessToken`、`role`、`tenantId` 由 `jwt` 回调写入，
  `session` 回调透出，服务端组件据此调后端。
- **`themeTokens` 的结构是 `{ colors: { primary: '#rrggbb' } }`。** 后端只把它当
  不透明的 JSON 存，约定由前端定；storefront 读它渲染主题色时依赖同一结构。

## 单元测试

```bash
npm test          # 跑一遍（CI 用）
npm run test:watch   # watch 模式
```

框架是 **Vitest**（不是 Jest——Next.js 15 + React 19 生态里 Vitest 是主流，
原生 ESM/TS，`vi.mock` 好用）。配置见 `vitest.config.ts`。

### 测什么、不测什么

只测两类东西：

1. **Route Handler。** Next.js 的 Route Handler 就是普通导出函数
   （`export async function POST(request: Request)`），**可以直接 import 并调用**，
   传一个 `new Request(url, { method, body })` 就能拿到返回的 `Response`。
   **不需要起服务器，也不需要 jsdom。**
   - mock `@/auth` 的 `auth()`，让它返回 `{ accessToken: 'test-token' }` 或 null；
   - mock `@/lib/api-client` 的 `apiFetch`，**断言它被调用时收到的参数**
     ——这是验证「白名单真的重建了 body」的唯一办法。
2. **纯函数。** 例如 `src/lib/theme.ts` 的 `buildThemeCss`（在 storefront 那边）。

**明确不测 React 组件渲染**：那需要 jsdom + React Testing Library，
是另一个成本量级的事，本轮不做。

测试放在顶层 `test/` 目录（`src/` 之外），`next build` 不会编译它们。

### 现有测试覆盖的护栏

| 测试文件 | 护栏 |
| --- | --- |
| `test/app/api/auth-guard.test.ts` | 中转路由的认证：未登录必须 401，且**不得**调后端 |
| `test/app/api/body-whitelist.test.ts` | 中转路由的请求体白名单：未知字段必须被丢弃（不透传给后端） |
| `test/app/api/malformed-body.test.ts` | 中转路由拦截数组 / 字符串 / null 请求体 → 400 |
| `test/app/api/batch-ids-limit.test.ts` | 批量接口的 ids 数量上限（> 200 → 400） |

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

### 覆盖的护栏

认证未登录 401 且不碰后端、请求体白名单重建、数组/字符串/null 请求体拦截、
批量 ids 上限（200）、**查询参数白名单重建**。

