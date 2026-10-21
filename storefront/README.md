# storefront（消费者店铺前台）

多租户电商 SaaS 平台的消费者端。一个租户 = 一家店铺 = 一个子域名
（`<subdomain>.example.com`），浏览器落在哪家的域名下，看到的就是哪家的店。

## 本地启动

```bash
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
| `src/lib/tenant.ts` | 店铺子域名解析。优先取 `X-Tenant-Subdomain` 头，其次从 host 首段取；裸 IP / IPv6 / localhost 会被识别出来 |
| `src/lib/api-client.ts` | 后端 API 封装：`apiFetch` / `apiFetchAuthed` |
| `src/app/(shop)/` | 店铺侧页面：首页、登录、个人中心 |
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