# 阶段 7c「前端共享包与三端收口」验收记录

> 执行日期：2026-11-04 · 分支 `plan-07b07c-hardening` · 计划：`docs/superpowers/plans/2026-11-04-plan-07c-frontend-shared.md`

## 一、交付范围

| 波次 | 内容 | 状态 | commit |
|---|---|---|---|
| 1 | 建 `packages/frontend-shared` + 8 个逐字节迁移模块 + 三端薄壳 | ✅ | `bf0338a` |
| 2 | api-client 工厂化 + money 统一 + route-helpers 收敛 + zod 分页校验接线 | ✅ | `6cfda91` |
| 3 | 21 个 loading.tsx + 三端 skeleton 组件 + 依赖归位 | ✅ | `1064b39` |
| 修复 | CI 三前端 job 先装共享包依赖 | ✅ | `955dfc1` |
| 修复 | 前端镜像构建带上共享包（file: 依赖断链） | ✅ | `7746cb4` |

## 二、共享包的形态与理由

- **npm `file:` 引用**（`"file:../packages/frontend-shared"`），不引入根 workspace：不动三端既有的 install / test / build 命令形态，也不必把整个仓库变成一个 npm 项目。
- **共享包的 `exports` 是 `"./*": "./src/*"`**——薄壳 `export * from '@ecom/frontend-shared/xxx'` 直接指到源码文件，不需要为每个模块写 exports 条目。
- **三处登记缺一不可**：`next.config.ts` 的 `transpilePackages`（编译）、`tsconfig.json` 的 `paths`（类型）、`vitest.config.ts` 的 `resolve.alias`（测试）。少任何一处都会在对应环节报「找不到模块」。
- **原位置一律保留薄壳**，三端调用点的 import 路径零改动。

## 三、逐字节迁移的模块

`token-refresh.ts` / `token-expiry.ts` / `session-sync.ts` / `jwt-callback.ts`（两端 × 4）、`app-error.tsx` / `global-error.tsx`（三端 × 2）——迁移后与原文件 `diff` 为空。`error.tsx` / `global-error.tsx` 是 Next.js 约定文件名，本地保留薄壳（`'use client'` 与 Next 的 props 语义都在薄壳里，源文件也留着 `'use client'`，双保险）。

**测试留在各端，只改 import 指向共享包**——三端测试数字不缩水（storefront 209 / merchant-admin 417 / platform-admin 429）。

## 四、计划偏离与判断

### 1. api-client 工厂的三处偏离（均保持原行为）

- **`tenantSubdomain` 语义调整**：storefront 的子域名是**逐请求**解析的（`server-cart.ts` 的 `currentSubdomain()` 每次从请求头取），不存在全局静态值。共享实现保留 `ApiFetchOptions.subdomain` 逐请求传参，工厂的 `tenantSubdomain` 只作全局缺省（storefront 传 `null` = 明确不发）。
- **`SharedApiClientOptions` 增加必填 `auth`**：`apiFetchAuthed` 依赖本端 NextAuth 的 `auth()`，共享包不可能 import 某一端的 `@/auth`，只能由薄壳注入（顺带保住了测试对 `@/auth` 的 `vi.mock` 生效路径）。
- **佣金报表响应是 `entries + total`**（`CommissionLedger` 还带 from/to/byMerchant），不是 `items + total`。`z.object` 会剥掉未声明字段，故另出宽松的 `paginatedEntriesResponse`（`z.looseObject`）；券列表恰好是 `{ items, total }`，用 `paginatedResponse`。

### 2. merchant 有两份 formatPrice，已收编成一份

`src/components/product/format.ts`（UI 实际用的）与 `src/lib/money.ts`（新增测试测的）是两份实现。当前行为逐字相同，但**测试没覆盖 UI 真正使用的那份**——将来改一处会漂。处置：共享包 `formatPrice` 接受 `number | null | undefined`（undefined → `'—'`，与原实现一致），`components/product/format.ts` 改为 re-export，6 处 import 路径不动。

### 3. 三端 zod 依赖删除后的落点

`zod` 从三端 dependencies 删除后仍以 **dev 依赖**存在（`shadcn` 自己依赖 zod）。这不构成运行时问题：三端 `.next/server` 里 zod 全被 webpack 打进 chunk，没有任何外部 `require("zod")`；分页校验用的 `zod` import 走的是共享包路径，解析到 `packages/frontend-shared/node_modules/zod`。

## 五、审查发现与修复

### Critical 1：CI 装不上共享包自身的依赖

CI 的三个前端 job 只在自己的目录跑 `npm ci`。npm 的 `file:` 链接**不会**把被链接包自身的依赖装进宿主 node_modules；而共享包在 `transpilePackages` 下按**真实路径**解析（`packages/frontend-shared/src/**`），向上找不到 node_modules → CI 里 storefront 报找不到 `react/jsx-dev-runtime`、merchant-admin 报找不到 `zod` / `next/server`。

**本地复现不出来**（各端 node_modules 恰好有这些包），所以这个坑能一路躲过本地全绿。

修复：三个 job 各加一步 `npm ci`（`working-directory: packages/frontend-shared`），并把共享包的 lock 纳入 `setup-node` 的缓存键。

### Critical 2：前端镜像构建必然失败

共享包是 `file:` 依赖，而三个前端的 build context 是单端目录 → 镜像里没有 `packages/frontend-shared` → `npm ci` 装出**断链软链** → 构建时共享包的 import 一条都解析不了。

修复：build context 改成**仓库根**，Dockerfile 把共享包 COPY 到 `/packages/frontend-shared`（`file:` 的相对路径是相对 **package.json 所在目录**算的，端的 package.json 在 `/app` → 目标就是 `/packages/...`，不是 `/app/packages/...`），并先给共享包装依赖；新增仓库根 `.dockerignore`。

**已验证**：三个镜像构建通过；`compose up -d` 重建后三个前端容器 healthy；storefront 首页 200 正常渲染。

### Minor 修正

- 共享包 `README.md` 补齐（波次 1 计划要求，漏建）。
- `storefront/test/app/error-boundary.test.tsx` 的 import 改回走本端薄壳（`@/app/error`），否则测试不再覆盖薄壳这一行接线。
- 三端 api-client 薄壳补 `localizeApiMessage` 导出（计划模板要求；原本三端都没导出过，全仓无 import）。
- `route-helpers` 共享头注释补回指向 `app/api/stores/me/route.ts` 的交叉引用。

## 六、验证结果

| 项 | 结果 |
|---|---|
| `storefront`：test / tsc / build | 209 passed / 0 错误 / 通过 |
| `merchant-admin`：test / tsc / build | 417 passed / 0 错误 / 通过 |
| `platform-admin`：test / tsc / build | 429 passed / 0 错误 / 通过 |
| 三端 lock（node:22 / npm 10） | `npm ci --dry-run` 全部通过 |
| 干净 CI 模拟（rsync + 容器内全量重装） | 三端 tsc / test / build 全绿 |
| 三个前端镜像 | 构建通过，容器 healthy，首页 200 |
| 共享包 symlink | `readlink storefront/node_modules/@ecom/frontend-shared` → `../../../packages/frontend-shared` |

### 手测（重建后的容器上）

| 场景 | 结果 |
|---|---|
| storefront 登录 | 注册顾客 → NextAuth credentials 登录 → 302 + session cookie；`/api/auth/session` 返回 accessToken / role / tenantId（共享包的 jwt-callback 逐字节迁移后行为一致） |
| 令牌刷新 | 同一枚 refresh token 在宽限期内连刷两次都成功（多标签页场景，阶段 5c 语义） |
| 登出 | 登出后同一 refresh token 立即失效 |
| merchant 券列表翻页 | 真实链路验证分页参数生效（详见 7b 验收记录） |
| 页面访问 | storefront 首页 200 正常渲染；两个后台 307 跳登录（未登录，正常） |
| 镜像 | 三个前端镜像构建通过 → `compose up -d` 重建 → 容器 healthy |

⚠️ 同 7b：手测前必须重建容器，否则测的是旧镜像（详见 7b 验收记录第五节）。

## 七、已知限制

- **`session-sync-component.tsx` 依赖各端 `@/lib/session-sync` alias**（有意设计：会话同步的纯逻辑留在端内，各端可定制）。代价是共享包**不可独立安装使用**（README 已注明）。若将来要独立发布或建独立 CI，必须先解掉这条回环（props 注入即可）。
- **三端测试各跑各的**，共享包没有自己的测试设施（计划明确不做）——共享包的覆盖率等于三端测试的并集。
- `storefront` 只补了 `orders` 一个 loading 页（计划显式指定）；`(shop)` 下还有 account / checkout / coupons / search 等异步页面没有骨架页。
- 共享包里的 `format-price.ts` 现在只是 `money.ts` 的再导出（避免两份 `formatPrice` 漂移），保留这个文件是为了不动既有 import 路径。
