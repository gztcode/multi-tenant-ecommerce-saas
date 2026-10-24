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

## 单元测试

```bash
npm test          # 跑一遍（CI 用）
npm run test:watch   # watch 模式
```

框架是 **Vitest**（不是 Jest——Next.js 15 + React 19 生态里 Vitest 是主流，
原生 ESM/TS，`vi.mock` 好用）。配置见 `vitest.config.ts`。

### 测什么、不测什么

只测**纯函数**。目前是 `src/lib/theme.ts` 的 `buildThemeCss`——
主题 token 的**键名**白名单：分组标量是「前缀 + 键」拼出来的
（`--text-` + key），若只靠前缀约束，键名就成了可注入面
（`tokens.textScale['sm; } body{']` 会拼出 `--text-sm; } body{ : 1rem;`，
直接逃出这条声明）。所以键必须显式列在 `GROUP_KEYS` 白名单里。

**明确不测 React 组件渲染**：那需要 jsdom + React Testing Library，
是另一个成本量级的事，本轮不做。

测试放在顶层 `test/` 目录（`src/` 之外），`next build` 不会编译它们。

### 现有测试覆盖的护栏

| 测试文件 | 护栏 |
| --- | --- |
| `test/lib/theme.test.ts` | 主题 token 的键名白名单：恶意键名不能逃出 `:root` 块 |

断言要两边都测：恶意键名**不出现**在输出里，**且**正常键名
（`textScale.xs` 等）**必须出现**在输出里——只测「恶意被丢弃」不够，
一个「全部丢弃」的实现也能通过那些断言。

### 写这类测试的坑

- **`vi.mock` 的路径要与被测文件里的 import 路径一致。**
  路径不一致 mock 不生效——症状是「测试跑起来但断言的是真实现」。
- **`server-only` 在 Vitest（node 环境）里会直接抛错。**
  `vitest.config.ts` 里把它 alias 到了一个空模块兜底。
