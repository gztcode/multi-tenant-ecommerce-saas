# platform-admin（平台超管后台）

多租户电商 SaaS 平台的**平台超管**操作入口：查看商家（租户）列表，并变更商家的启用状态。

与 `merchant-admin` / `storefront` 的区别在于：它跑在**中心域名**（本地为 `localhost:3003`），
不解析店铺子域名，登录身份完全由后端按账号绑定——超管不属于任何租户，令牌里 `tenantId` 为 `null`。

## 本地启动

前置：后端 `api` 已在 `localhost:3000` 运行，且开发库已完成迁移与种子数据。

```bash
cd platform-admin
npm install
cp .env.example .env   # 然后把 AUTH_SECRET 换成一串随机字符串
npm run dev            # http://localhost:3003
```

环境变量见 `.env.example`：

| 变量 | 说明 |
|------|------|
| `API_BASE_URL` | 后端 API 地址，默认 `http://localhost:3000/api/v1` |
| `AUTH_SECRET` | NextAuth 签名密钥，**必须**替换为随机字符串 |
| `AUTH_URL` | 本应用地址，默认 `http://localhost:3003` |
| `AUTH_TRUST_HOST` | 允许按请求头推断 host，本地开发需要 |

### 默认超管账号

```
admin@platform.test / Admin12345!
```

**仅限本地开发使用。** 该账号由 `api` 的种子数据创建（`prisma/seed.ts`），
邮箱密码可用 `SEED_PLATFORM_ADMIN_EMAIL` / `SEED_PLATFORM_ADMIN_PASSWORD` 覆盖；
部署到任何非本地环境前必须改掉或删除它。

## 目录

| 路径 | 说明 |
|------|------|
| `src/auth.ts` | NextAuth 配置。`scope` 固定为 `'PLATFORM'` |
| `src/lib/api-client.ts` | `apiFetch` / `apiFetchAuthed` / `ApiError`。**不发** `x-tenant-subdomain` |
| `src/lib/tenant.ts` | 商家类型、状态枚举与展示辅助 |
| `src/app/(auth)/login/page.tsx` | 登录页 |
| `src/app/(dashboard)/layout.tsx` | 受保护区：未登录跳 `/login`，含顶栏与登出 |
| `src/app/(dashboard)/page.tsx` | 商家列表 |
| `src/app/(dashboard)/tenants/[id]/page.tsx` | 商家详情 |
| `src/app/(dashboard)/tenants/[id]/status-form.tsx` | 状态切换表单（客户端组件） |
| `src/app/api/tenants/[id]/status/route.ts` | 状态变更的**同源中转**接口 |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth 路由处理器 |

## 关键约定

**登录 scope 必须是 `'PLATFORM'`。** 后端 `/auth/login` 会按 `scope` 过滤候选角色，
写错成 `'MERCHANT'` 时超管账号会被角色过滤掉，而返回的提示与「密码错误」完全相同，
排查起来毫无线索。商家账号在本后台登录同样会被拒（后端按角色过滤）。

**不解析店铺子域名。** 平台后台没有「当前店铺」的概念，请求头里不带 `x-tenant-subdomain`。

**状态变更走同源中转，不在浏览器里直连后端。** 两个原因：

1. 后端没有开启 CORS（设计上前端与 API 同源，由 `infra/nginx/` 反代）；
   浏览器从 `localhost:3003` 直连 `localhost:3000` 会被拦掉，
   只留下一句无任何线索的 `Failed to fetch`。
2. `accessToken` 因此可以完全留在服务端，不必为发一个 `PATCH` 就下发到客户端组件。

**`apiFetchAuthed` 只能在服务端调用。** 它内部 `await auth()`，
而 NextAuth v5 的 `auth()` 在 JWT 策略下要读 cookie（走 `headers()`），
只能用在服务端组件与路由处理器的请求作用域里；
客户端组件调用会抛「`headers` was called outside a request scope」。

**详情页从列表里筛商家。** 后端目前只提供 `GET /tenants`（列表）与
`PATCH /tenants/:id/status`，**没有** `GET /tenants/:id`，
所以详情页拉一次列表再按 id 过滤，而不是去调不存在的端点。

**未知状态不崩页面。** 后端的 `status` 是 Prisma enum 直出的字符串，
前端遇到未知取值时显示「未知状态（xx）」而不是 `undefined`。

**加载失败给提示，不让整页 500。** 后端没起、令牌角色不对（403）、
网络抖动等都在页面上渲染成错误提示，并保留返回入口。