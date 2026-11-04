# platform-admin（平台超管后台）

多租户电商 SaaS 平台的**平台超管**操作入口：商家（租户）治理、套餐与订阅、
抽佣与报表、结算单与出款审批、渠道对账。

与 `merchant-admin` / `storefront` 的区别在于：它跑在**中心域名**（本地为 `localhost:3003`），
不解析店铺子域名，登录身份完全由后端按账号绑定——超管不属于任何租户，令牌里 `tenantId` 为 `null`。

## 本地启动

前置：后端 `api` 已在 `localhost:3000` 运行，且开发库已完成迁移与种子数据。

```bash
cd platform-admin
# 共享包是 file: 依赖，必须先装它自己的依赖（npm 不会替你装）
(cd ../packages/frontend-shared && npm install)
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
| `src/auth.ts` | NextAuth 配置。`scope` 固定为 `'PLATFORM'`。`jwt` / `session` 回调内联（超管不刷新令牌） |
| `src/lib/api-client.ts` | 薄壳：调共享包 `createApiClient(...)`。`apiFetch` / `apiFetchAuthed` / `ApiError`，**不发** `x-tenant-subdomain` |
| `src/lib/route-helpers.ts` | 中转路由的公共辅助（再导出 `@ecom/frontend-shared/route-helpers`）：`readJson` / `toErrorResponse` / `unauthorizedResponse` |
| `src/lib/tenant.ts` | 商家类型、状态枚举与展示辅助 |
| `src/lib/reconciliation.ts` | 渠道对账的差异分类与展示口径 |
| `src/lib/settings.ts` | 平台设置（默认出款渠道）的类型与服务端取数 |
| `src/app/(auth)/login/page.tsx` | 登录页 |
| `src/app/(dashboard)/layout.tsx` | 受保护区：未登录跳 `/login`，含顶栏与登出 |
| `src/app/(dashboard)/page.tsx` | 概览 |
| `src/app/(dashboard)/tenants/` | 商家列表与详情、启用状态变更 |
| `src/app/(dashboard)/plans/` | 套餐管理 |
| `src/app/(dashboard)/subscriptions/` | 订阅列表 |
| `src/app/(dashboard)/commissions/` | 抽佣流水明细 |
| `src/app/(dashboard)/reports/` | 平台收入报表 |
| `src/app/(dashboard)/settlements/` | 结算单列表与详情、重算、确认 / 取消确认 |
| `src/app/(dashboard)/payouts/` | 出款单列表与详情、审批 / 拒绝 / 重试 / 解卡 |
| `src/app/(dashboard)/reconciliations/` | 渠道对账：列表、详情、差异处置、CSV 导入、**批量确认**（勾选 / 全选筛选结果） |
| `src/app/(dashboard)/settings/` | **平台设置**：默认出款渠道（阶段 6 新增） |
| `src/app/api/` | 同源中转路由 |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth 路由处理器 |

## 关键约定

**登录 scope 必须是 `'PLATFORM'`。** 后端 `/auth/login` 会按 `scope` 过滤候选角色，
写错成 `'MERCHANT'` 时超管账号会被角色过滤掉，而返回的提示与「密码错误」完全相同，
排查起来毫无线索。商家账号在本后台登录同样会被拒（后端按角色过滤）。

**不解析店铺子域名。** 平台后台没有「当前店铺」的概念，请求头里不带 `x-tenant-subdomain`。
中央域名在 Nginx 侧还会**显式剥除**这个头（`proxy_set_header X-Tenant-Subdomain ""`）。

**状态变更走同源中转，不在浏览器里直连后端。** 两个原因：

1. 后端没有开启 CORS（设计上前端与 API 同源，由 `infra/nginx/` 反代）；
   浏览器从 `localhost:3003` 直连 `localhost:3000` 会被拦掉，
   只留下一句无任何线索的 `Failed to fetch`。
2. `accessToken` 因此可以完全留在服务端，不必为发一个 `PATCH` 就下发到客户端组件。

**`apiFetchAuthed` 只能在服务端调用。** 它内部 `await auth()`，
而 NextAuth v5 的 `auth()` 在 JWT 策略下要读 cookie（走 `headers()`），
只能用在服务端组件与路由处理器的请求作用域里；
客户端组件调用会抛「`headers` was called outside a request scope」。

**中转层要「白名单重建」请求体，不能原样透传。** 后端的 `ValidationPipe` 开了
`forbidNonWhitelisted`，多一个字段就是 400。

**详情页从列表里筛商家。** 后端目前只提供 `GET /tenants`（列表）与
`PATCH /tenants/:id/status`，**没有** `GET /tenants/:id`，
所以详情页拉一次列表再按 id 过滤，而不是去调不存在的端点。

**未知状态不崩页面。** 后端的 `status` 是 Prisma enum 直出的字符串，
前端遇到未知取值时显示「未知状态（xx）」而不是 `undefined`。

**加载失败给提示，不让整页 500。** 后端没起、令牌角色不对（403）、
网络抖动等都在页面上渲染成错误提示，并保留返回入口。

## 单元测试

```bash
npm test          # 429 条 / 18 个文件
npm run test:watch   # watch 模式
```

框架是 **Vitest**，配置见 `vitest.config.ts`。

### 测什么

三类：

1. **Route Handler** —— 直接 import 并调用，传一个 `new Request(...)` 就能拿到 `Response`，
   不需要起服务器，也不需要 jsdom。
2. **纯函数** —— 例如 `src/lib/billing.ts` 的费率与金额口径、`src/lib/payout.ts`、
   `src/lib/reconciliation.ts` 的差异分类。
3. **React 组件渲染与页面级测试** —— 需要 jsdom + Testing Library。

⚠️ **全局环境是 `node`**，组件测试在自己的文件里用
`// @vitest-environment jsdom` **逐文件切换**——逐文件的注释优先于全局配置。

### 现有测试覆盖的护栏

| 测试文件 | 护栏 |
| --- | --- |
| `test/app/api/billing-whitelist.test.ts` | 计费中转路由的请求体白名单重建 |
| `test/app/{plans,reports,subscriptions,commissions}-page.test.tsx` | 四个页面的页面级测试 |
| `test/app/{settlements,payouts}-page.test.tsx` + `*-detail-page.test.tsx` | 结算单与出款单的列表 / 详情 |
| `test/components/plan-form.test.tsx` | 套餐表单 |
| `test/components/settlement-actions.test.tsx` | 结算单的确认 / 取消确认 / 重算动作 |
| `test/components/payout-actions.test.tsx` | 出款单的审批 / 拒绝 / 重试 / 解卡动作 |
| `test/components/import-csv-form.test.tsx` | CSV 账单导入表单 |
| `test/lib/{api-client,billing,payout}.test.ts` | 客户端封装与金额口径 |

### 写这类测试的坑

- **`vi.mock` 的路径要与被测文件里的 import 路径一致**（`@/auth`、`@/lib/api-client`）。
  路径不一致 mock 不生效——症状是「测试跑起来但断言的是真实现」。
- **`server-only` 在 Vitest（node 环境）里会直接抛错**，`vitest.config.ts` 里
  把它 alias 到了一个空模块兜底。
- **`esbuild: { jsx: 'automatic' }` 必须写在配置的根级**，不能写在 `test` 下面
  （esbuild 是 Vite 的根级选项）。漏了的话所有组件测试报 `React is not defined`
  ——本项目的 tsconfig 是 `"jsx": "preserve"`，而 esbuild 不读 tsconfig 的 jsx 设置。
- **断言要具体**：401 就断言状态码**且**断言 `apiFetch` 没被调；
  400 就断言状态码**且**断言 body 里的错误文案；白名单就断言 `apiFetch` 收到的
  **完整 body**（`toEqual`，不是「不含某字段」——后者能被「全部丢弃」的实现蒙混过关）。

测试放在顶层 `test/` 目录（`src/` 之外），`next build` 不会编译它们。
