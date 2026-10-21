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
