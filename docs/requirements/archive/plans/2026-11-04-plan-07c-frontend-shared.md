# 阶段 7c「前端共享包与三端收口」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建 `packages/frontend-shared`（`file:` 引用，不引入根 workspace），把三端逐字节相同的模块收敛进包；`api-client` 工厂化收敛三份 80% 相同实现；统一 money；补齐三端 `loading.tsx`；清理依赖与 next.config 不一致。

**Architecture:** 波次 1 建包 + 逐字节模块迁移（单代理，先打通构建再批量）；波次 2 api-client 工厂化 + money + route-helpers（单代理，动的是波次 1 建的包）；波次 3 三路并行（loading.tsx + 依赖对齐）；波次 4 全量回归。**原 `src/lib` 位置一律保留 re-export，三端调用点 import 路径零改动**；测试文件留在各端（只改 import 指向共享包），三端测试数字不缩水。

**Tech Stack:** Next.js 15.5.28、NextAuth v5 beta.32、Vitest 3.2.7、npm `file:` 协议、zod ^4.6.7。

**设计文档:** `docs/superpowers/specs/2026-11-03-plan-07-engineering-hardening-design.md` §五

**执行约定:** 实施代理**不提交**；波次 1 的 Step 1（最小模块打通）没验证通过前不得批量迁移；工作分支 `plan-07c-frontend-shared`。

**关键事实（上下文核实结论，实施者必读）:**
- **与设计 §5.2 的两处已核实修正**：①「原测试迁移到共享包跑」改为「**测试留在各端、只改 import 指向共享包**」——避免三端测试数字缩水、不为测试另建设施（见文末「明确不做」）；②逐字节模块实际是 **storefront + merchant-admin 两端**（platform-admin 的 auth.ts 内联简化版、无刷新逻辑，本阶段不给它引入刷新）。
- `platform-admin` **没有** token-refresh / token-expiry / session-sync / jwt-callback（其 `src/auth.ts` 内联简化版、无刷新逻辑）——**本阶段不给 platform 引入刷新**（那是行为变化），token 模块只涉 storefront 与 merchant-admin 两端。
- 逐字节相同（md5 已核实）：`token-refresh.ts`(172 行)、`token-expiry.ts`(103 行)、`session-sync.ts`(403 行零运行时 import)、`jwt-callback.ts`(179 行)——以上×2 端；`error.tsx`(899B) 与 `global-error.tsx`——×3 端。
- `route-helpers.ts` 三份**仅注释差异**；merchant 版 `import { ApiError } from './api-client'`——放波次 2（等 ApiError 进共享包）。
- `api-client.ts` 三份差异比预期大：storefront(175 行) 有 `subdomain` 头 / `cookie` 转发 / `apiFetchWithSetCookie`（cart_token 转写）与 request() 分层结构；merchant(138 行) / platform(133 行) 单体、明确不发 subdomain。**以 storefront 版为超集实现工厂**。
- `money.ts` 两端逐字节相同（`yuanToCents` / `centsToYuan`，不带货币符号）；storefront `format.ts` 的 `formatPrice` 带 `¥` 前缀、null → `'—'`。共享包合并两套口径。
- 三端 vitest alias 一致（`@/` → `./src`、`server-only` → stub）；tsconfig `paths: {"@/*": ["./src/*"]}`、`moduleResolution: "bundler"`。共享包要在 **tsconfig paths 与 vitest alias 双处登记**。
- `zod ^4.6.7` 三端声明但 src 内 0 处 import（死依赖）——本阶段真正用起来（分页响应校验钩子），依赖移入共享包。
- 三端无任何 `loading.tsx`、无 Skeleton 使用。
- `session-sync.tsx` 组件被两端 `app/layout.tsx:3,41` 引用——保留本地 re-export 则 layout 零改动。

---

## 波次 1：建包 + 打通 + 逐字节模块迁移（单代理）

**Files:**
- Create: `packages/frontend-shared/package.json`、`packages/frontend-shared/src/*.ts`（逐字节迁移的 8 个模块）、`packages/frontend-shared/README.md`（3 行：用途 + 为什么 file: 引用）
- Modify: 三端 `package.json`（dependencies 加 `"@ecom/frontend-shared": "file:../packages/frontend-shared"`）、三端 `tsconfig.json`、三端 `vitest.config.ts`、三端 `next.config.ts`
- Modify: 两端 `src/lib/token-refresh.ts` 等原文件（改为 re-export）、`src/app/error.tsx` / `global-error.tsx` ×3 端、两端 `src/components/session/session-sync.tsx`

- [ ] **Step 1: 建包并用最小模块打通**（先验证 file: + transpilePackages + vitest 三件套都能解析，**通过前不得继续**）

`packages/frontend-shared/package.json`：

```json
{
  "name": "@ecom/frontend-shared",
  "version": "0.1.0",
  "private": true,
  "exports": {
    "./*": "./src/*"
  }
}
```

先只迁一个最小模块（`src/format-price.ts`，内容 = storefront `format.ts` 的 5 行 `formatPrice`）。三端 `package.json` 加依赖后 `npm install`（三端各跑一次，确认 node_modules 里出现 symlink）。三端 `next.config.ts` 补：

```ts
  transpilePackages: ['@ecom/frontend-shared'],
```

三端 `tsconfig.json` 的 paths 补（类型解析用，bundler resolution 下也保底）：

```json
      "@ecom/frontend-shared/*": ["../packages/frontend-shared/src/*"]
```

三端 `vitest.config.ts` 的 resolve.alias 补：

```ts
      '@ecom/frontend-shared': fileURLToPath(
        new URL('../packages/frontend-shared/src', import.meta.url),
      ),
```

验证（三端各跑）：

```bash
cd <端> && npx tsc --noEmit && npm run build && npm test
```

Expected: 三端全绿（storefront 临时把 `format.ts` 改为 re-export 共享包的 `formatPrice` 验证真实链路：`export { formatPrice } from '@ecom/frontend-shared/format-price';`——`format.ts` 本身保留此形态直到波次 2 的 money 统一）。

- [ ] **Step 2: 迁移逐字节相同的模块**（用 `cp` 保字节一致，迁移后与原文件 diff 必须为空）

共享包 `src/` 下建立：`token-refresh.ts`、`token-expiry.ts`、`session-sync.ts`、`jwt-callback.ts`、`app-error.tsx`（= error.tsx 内容）、`global-error.tsx`、`session-sync-component.tsx`（= session-sync.tsx 组件内容，保留其 `'use client'` 指令）。

两端原位置改为 re-export（三端调用点零改动）：

```ts
// storefront/src/lib/token-refresh.ts 与 merchant-admin 同款
export * from '@ecom/frontend-shared/token-refresh';
```

`jwt-callback.ts` 同款；`session-sync.ts` 同款。`error.tsx` / `global-error.tsx` 是 Next.js 约定文件，本地保留薄壳（**必须保留 `'use client'` 与 Next 的 props 语义**）：

```tsx
'use client';
export { default } from '@ecom/frontend-shared/app-error';
```

（global-error 同理指 `global-error`；共享包源文件里的 `'use client'` 也要保留——薄壳与源文件双保险。）`session-sync.tsx` 组件：

```tsx
'use client';
export { SessionSync } from '@ecom/frontend-shared/session-sync-component';
```

（导出名以组件实际导出为准——上下文显示是 `createSessionSync` 工厂 + 默认导出，实施时按源码对齐，薄壳保持原导出签名。）

- [ ] **Step 3: 测试文件只改 import**（留在各端，数字不缩水）

两端 `test/lib/token-refresh.test.ts`、`token-expiry.test.ts`、`session-sync.test.ts`、`jwt-callback.test.ts`（各 ×2）与 storefront `test/app/error-boundary.test.tsx`：把被测模块的 import 从 `@/lib/xxx` 改为 `@ecom/frontend-shared/xxx`。其余断言零改动。

- [ ] **Step 4: 验证**

```bash
cd storefront && npm test && npx tsc --noEmit && npm run build
cd merchant-admin && npm test && npx tsc --noEmit && npm run build
cd platform-admin && npm test && npx tsc --noEmit && npm run build
```

Expected: 三端全绿（413/209/427 数字不变）。**任何一端红都不许进入波次 2**。

## 波次 2：api-client 工厂化 + money 统一 + route-helpers（单代理）

**Files:**
- Create: `packages/frontend-shared/src/api-client.ts`（工厂实现）、`packages/frontend-shared/src/pagination-schema.ts`、`packages/frontend-shared/src/money.ts`、`packages/frontend-shared/src/route-helpers.ts`
- Modify: 三端 `src/lib/api-client.ts`（薄壳初始化）、两端 `src/lib/money.ts` + storefront `src/lib/format.ts`（re-export）、三端 `src/lib/route-helpers.ts`（re-export）
- Test: 三端 `test/lib/api-client.test.ts`（import 不动、必要时补工厂行为断言）、merchant `test/lib/money.test.ts` 补 formatPrice 断言

- [ ] **Step 1: 工厂实现**（以 storefront 版为超集：subdomain 头、cookie 转发、WithSetCookie 全部保留，参数化注入）

```ts
export interface SharedApiClientOptions {
  /** 例：/api/v1（三端各自的环境变量解析保持在本端壳里） */
  baseUrl: string;
  /** storefront 传店铺子域名头；merchant/platform 传 null（明确不发） */
  tenantSubdomain?: string | null;
  /** storefront 透传 cookie（cart_token）；其余端不传 */
  forwardCookie?: boolean;
}
export interface SharedApiClient {
  ApiError: typeof ApiError;
  localizeApiMessage: typeof localizeApiMessage;
  apiFetch: <T>(path: string, init?: ApiFetchOptions & { validate?: (data: unknown) => T }) => Promise<T>;
  apiFetchAuthed: typeof apiFetchAuthed;
  apiFetchWithSetCookie?: typeof apiFetchWithSetCookie;
}
export function createApiClient(options: SharedApiClientOptions): SharedApiClient { ... }
```

实现体从 storefront 版搬运（保留其 request() 分层与 204/空 body 处理；merchant/platform 缺的 `apiAbsoluteUrl` 一并保留在工厂返回里——等价能力超集，不改变三端行为）。`validate` 钩子在 JSON.parse 后调用，校验失败抛 `ApiError`（message 前缀「响应结构不符」）。

`packages/frontend-shared/src/pagination-schema.ts`：

```ts
import { z } from 'zod';

/** 7b 分页改造后的标准列表响应（items + total） */
export const paginatedResponse = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
});
```

三端 `src/lib/api-client.ts` 薄壳（以 storefront 为例）：

```ts
import { createApiClient } from '@ecom/frontend-shared/api-client';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

const shared = createApiClient({
  baseUrl: API_BASE_URL,
  tenantSubdomain: /* storefront: 从环境/请求上下文取，逻辑照搬原 apiFetch :85-87 */,
  forwardCookie: true,
});

export const ApiError = shared.ApiError;
export const localizeApiMessage = shared.localizeApiMessage;
export const apiFetch = shared.apiFetch;
export const apiFetchAuthed = shared.apiFetchAuthed;
export const apiFetchWithSetCookie = shared.apiFetchWithSetCookie!;
// storefront 原有的 apiAbsoluteUrl 等额外导出保持原样
```

merchant / platform 薄壳传 `tenantSubdomain: null`、不导出 WithSetCookie。**原文件的每个导出都必须在薄壳里保住**（grep 三端对 api-client 导出符号的使用清单逐一核对，漏一个就是运行时炸）。

- [ ] **Step 2: money 统一**

共享包 `src/money.ts` = 两端 `money.ts` 全量（`yuanToCents` / `centsToYuan`）+ storefront 的 `formatPrice`：

```ts
/** 价格展示：分 → ¥xx.xx；null → '—'（与 storefront 原口径一致） */
export function formatPrice(cents: number | null): string {
  if (cents === null) return '—';
  return `¥${centsToYuan(cents)}`;
}
```

两端 `src/lib/money.ts` 与 storefront `src/lib/format.ts` 改 re-export。merchant `test/lib/money.test.ts` 补 `formatPrice` 的三条断言（59.00、null→'—'、四舍五入口径）。

- [ ] **Step 3: route-helpers 收敛**（三份仅注释差异，以 merchant 版逻辑为准；ApiError 从共享包 import）

三端 `src/lib/route-helpers.ts` 改：

```ts
export * from '@ecom/frontend-shared/route-helpers';
```

storefront 版注释里特有的「为什么 storefront 也要中转」「cart_token cookie」说明**合并进共享包头注释**（不丢信息）。

- [ ] **Step 4: 分页校验钩子接线**（衔接 7b 的两个新分页接口；只在调用点用，不强制全站）

merchant 券列表取数处与 platform 佣金报表取数处：`apiFetch<CouponsPage>('/coupons?page=..', { validate: paginatedResponse.parse })` 的形态（以实际调用代码为准，validate 签名 `unknown => T`）。

- [ ] **Step 5: 验证**

```bash
cd storefront && npm test && npx tsc --noEmit && npm run build
cd merchant-admin && npm test && npx tsc --noEmit && npm run build
cd platform-admin && npm test && npx tsc --noEmit && npm run build
```

Expected: 三端全绿。手测 storefront 登录 → 令牌刷新 → 登出链路（`npm run dev` + api dev，或直接跑两端 auth 相关测试确认覆盖）。

## 波次 3：loading.tsx + 依赖对齐（三路并行）

**Files:**
- Create: merchant-admin 10 个 `src/app/(dashboard)/**/loading.tsx`（根 + settings/products/settlements/statements/inventory/marketing/orders/categories/billing）
- Create: platform-admin 9 个 `src/app/(dashboard)/**/loading.tsx`（根 + commissions/plans/settlements/tenants/subscriptions/payouts/reconciliations/reports）
- Create: storefront 1 个 `src/app/(shop)/orders/loading.tsx`
- Modify: 三端 `package.json`（`shadcn` 移到 devDependencies；**zod 从三端 dependencies 删除**——已由共享包声明）、`platform-admin/next.config.ts`（补 webpack externals.push('vitest')）

- [ ] **Step 1: 每端用一个统一的列表骨架模板**（shadcn Skeleton；各端 ui/skeleton.tsx 已存在则直接用）

```tsx
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-3 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
```

（`Skeleton` 的导入路径以各端 shadcn 实际组件位置为准；若某端无 skeleton 组件，按 shadcn CLI 产物手写一个 6 行 div 动画组件，三端同款。）

- [ ] **Step 2: 依赖与配置对齐**（只动列出的三处；`@vitest/coverage-v8` 保留 merchant 现状不强推）

- [ ] **Step 3: 验证**

```bash
cd <端> && npm test && npx tsc --noEmit && npm run build
```

Expected: 三端全绿；`grep -r '"zod"' <端>/package.json` 为空（除 storefront/merchant/platform 外）；platform build 时 vitest external 生效（若有 vitest 相关构建报错则该端 test 目录已被 build 扫到——如实记录）。

## 波次 4：全量回归（主会话执行）

- [ ] 三端 `npm test && npx tsc --noEmit && npm run build` 全绿
- [ ] 手测：storefront 登录 → 双标签页令牌刷新（阶段 5c 场景）→ 登出；merchant 后台券列表分页翻页；platform 佣金报表翻页
- [ ] `node -e "require('./packages/frontend-shared/package.json')"` 合法 JSON；三端 `node -e "console.log(require('fs').realpathSync('node_modules/@ecom/frontend-shared'))"` 指向 packages 目录（symlink 确认）
- [ ] 更新验收记录 `docs/superpowers/plans/2026-11-04-plan-07c-acceptance.md`

---

## 明确不做（本阶段）

- platform-admin 不引入令牌刷新（auth.ts 内联简化版保持原样——引入刷新是行为变化，超出共享包收敛范围）。
- 三端源码 import 路径不大面积替换（`@/lib/x` 薄壳全部保留）。
- 不建共享包独立 CI job / 独立 vitest 设施（测试留在各端）。
- `apiFetchWithSetCookie`、cart_token、subdomain 头等行为细节不重构，只参数化。
