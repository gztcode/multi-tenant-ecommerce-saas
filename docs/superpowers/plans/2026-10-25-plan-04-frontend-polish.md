# 计划 4：前端补齐与打磨 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉阶段 3 验收暴露的前端问题——补上前端组件测试基建、修掉 merchant-admin 的令牌刷新缺口、加一个消费者侧的地址簿独立页、让主题改动在 storefront 实时生效。

**Architecture:** 后端**不动**（四个子项都不需要新增端点）。四个子项分属两个前端应用：
storefront 承担组件测试基建 + 地址簿页 + 主题实时生效；merchant-admin 承担令牌刷新。
组件测试基建走 **Vitest + jsdom + Testing Library**，**全局环境保持 `node`**，
组件测试文件用 `// @vitest-environment jsdom` 逐文件切换。令牌刷新**物理复制**
storefront 的实现（两个应用无共享包）。主题实时生效走**客户端轮询 + 客户端注入 CSS 变量**
——无状态、多副本天然正确。

**Tech Stack:** Next.js 15 + React 19 + Tailwind 4 + shadcn/ui | Vitest 3 + jsdom + @testing-library/react 16 + user-event | NestJS 11 + Prisma 6（**本阶段不改**）

**对应设计文档:** `docs/superpowers/specs/2026-10-25-plan-04-frontend-polish-design.md` 全文。**本计划是该文档的可执行展开**，两者冲突时以设计文档为准。

---

## 零、全局约定

### 0.1 沿用阶段 2b / 3 的既有约定（不要重新发明）

| 约定 | 位置 | 说明 |
|------|------|------|
| 金额一律整数分 | 全局 | 阶段 0.4 已定；前端只做展示换算，真实金额由后端算 |
| 中转路由必须白名单重建请求体 | `*/src/app/api/**` | 阶段 2b 安全审查确立的约定 |
| 公开路径要带 `x-tenant-subdomain` | `storefront/src/lib/api-client.ts` | 匿名请求靠子域名定位租户；`apiFetch` 的 `subdomain` 选项直接用 |
| 商家后台**不带** `x-tenant-subdomain` | `merchant-admin/src/lib/api-client.ts` 第 33–34 行 | 中心域名没有「当前店铺」，租户身份由 accessToken 里的 `tenantId` 决定 |
| 关联读取必须显式 `where` | 全局 | 扩展的软删过滤只作用于顶层 |
| 前端断言要具体 | 全部 | 「只断言 200」「只断言报错」都算恒真。**组件测试同样适用**（护栏 2） |
| Server Component 不能往客户端组件传函数 | 前端 | `tsc` 与 `next build` 都通过，只有真正渲染才 500（阶段 2b 踩过） |
| 路由模块只导出 HTTP 方法 | `*/src/app/api/**/route.ts` | 多导出一个普通函数就会让 `next build` 报「not a valid Route export field」（阶段 3 踩过） |
| 纯函数放 `src/lib/` | 前端 | 能直接进单元测试；不放路由文件里（上面那条约定） |

### 0.2 本阶段的 12 项护栏

设计文档 §六.1 列了 12 项，每项**至少一个失败注入**。实施时把护栏编号写进测试的注释里，
验收时按编号逐条核对。

**设计文档 §五 的 21 条风险（L1–L21）**是这些护栏的来源，实施时对照着看。
（L18–L21 是这一轮审查新增的：网络抖动误踢登出、跨进程刷新去重失效、
多标签页「先后」竞态、字体 token 的客户端注入。）

> ⚠️ **12 项护栏 ≠ 13 条失败注入**——失败注入 #12 不在护栏清单里
> （它靠代码审查 + 手测）。验收时账目要分清，见 Task 5.2。

### 0.3 端口与基础设施

| 服务 | 宿主机 | 容器内 | 状态 |
|------|--------|--------|------|
| PostgreSQL | 15432 | 5432 | 已在跑 |
| MinIO | 19000 | 9000 | 已在跑 |
| Redis | 16380 | 6379 | 已在跑（**本阶段不用**，除了后端已有的 BullMQ） |
| api | 3000 | 3000 | 已在跑 |
| storefront | 3011 | 3000 | dev 用 3011（3001 被容器占） |
| merchant-admin | 3016 | 3000 | dev 用 3016（3002 被容器占） |

> ⚠️ **本地 dev 起前端前先 `rm -rf .next`**——阶段 3 的验收记录 §三「补做手测」
> 明确写过这条。3001–3003 是**旧镜像**，不含阶段 3 的功能（阶段 2b 栽过两次
> 「实测报缺陷、复现不出来」）。

### 0.4 目录

```
storefront/
├─ src/
│  ├─ app/(shop)/account/addresses/page.tsx   # 新建：地址簿页
│  ├─ app/api/theme/route.ts                   # 新建：主题查询中转
│  ├─ components/address/address-form.tsx      # 新建：从 checkout-form 提取
│  ├─ components/address/address-book.tsx      # 新建：地址簿（列表 + 四种操作）
│  ├─ components/theme/theme-watcher.tsx       # 新建：主题轮询
│  └─ lib/theme.ts                             # 修改：导出 CSS_VARS 等三张表
├─ test/
│  ├─ setup.ts                                 # 新建：全局 setup（含显式 cleanup）
│  ├─ components/smoke.test.tsx                # 新建：基建冒烟
│  ├─ components/product/spec-selector.test.tsx # 新建：示范性组件测试
│  ├─ components/address/address-form.test.tsx  # 新建
│  ├─ components/address/address-book.test.tsx  # 新建：地址簿的四条关键用例
│  ├─ components/theme/theme-watcher.test.tsx   # 新建
│  └─ app/api/theme.test.ts                     # 新建：中转路由测试
└─ vitest.config.ts                            # 修改：include 扩到 tsx + esbuild.jsx
merchant-admin/
├─ src/
│  ├─ auth.ts                                  # 修改：加刷新
│  ├─ lib/token-expiry.ts                      # 新建：复制
│  ├─ lib/token-refresh.ts                     # 新建：刷新段抽出来以便测试
│  └─ app/(dashboard)/layout.tsx               # 修改：掉登录时跳 /login
└─ test/
   ├─ lib/token-expiry.test.ts                 # 新建：复制
   └─ lib/token-refresh.test.ts                # 新建：刷新逻辑的用例
```

### 0.5 计划勘误（2026-10-25，实施前的一轮核对）

> **按阶段 3 的做法**：计划初稿写完后，拿它对着**现有代码**逐条核对一遍，
> 发现与现状不符的地方就地修正，并在这里留一张索引表，免得有人按旧版本做。
>
> **本表已于 2026-10-25 填满**（初稿写完后的那轮核对，共 **25 条**）。
> 下表每条都**实测或对着代码逐行核对过**，不是推测。
> 实施者若再发现新的不符，**继续在表里加行**。

| # | 问题 | 后果 | 在哪修 |
|---|------|------|--------|
| **1** | **`vitest.config.ts` 缺 JSX 转换配置**。`storefront/tsconfig.json` 第 14 行是 `"jsx": "preserve"`（Next 用 SWC），**esbuild 不读这个设置**，默认走 classic transform | **阻塞开工**：照抄后所有组件测试报 `ReferenceError: React is not defined` | Task 1.3：在配置的**根级**加 `esbuild: { jsx: 'automatic' }`。⚠️ **加在 `test` 下面不生效**（esbuild 是 Vite 根级选项）——实测确认 |
| **2** | **`test/setup.ts` 缺显式 `cleanup()`**。RTL v16 的自动 cleanup 依赖**全局** `afterEach`（`@testing-library/react/dist/index.js` 第 26 行 `if (typeof afterEach === 'function')`），而本项目 Vitest 配置 `globals: false` → 全局 `afterEach` 不存在 → 自动 cleanup 根本不注册 | **阻塞开工**：照抄后从第 2 条用例起全部报 `Found multiple elements with the role "button"`（DOM 跨用例累积） | Task 1.3：setup 里显式 `afterEach(() => cleanup())`。设计文档 §4.1.2.1 补了这条「因此」 |
| **3** | **`token-refresh.ts` 用了未定义的 `API_BASE_URL`**（代码块里只在注释里提到） | **阻塞开工**：`ReferenceError: API_BASE_URL is not defined` | Task 2.5：把注释变成真代码 `const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';` |
| **4** | **Task 3 缺 `address-book.tsx`**，Files 列表与 §0.4 目录树都漏了它 | 设计文档 §6.3 的失败注入 #10（设为默认用乐观更新）、#11（删除二次确认）**没有测试可挂** → 验收时会误判成「注入没生效」 | Task 3：Files 补 `Create: storefront/src/components/address/address-book.tsx`；新增 `storefront/test/components/address/address-book.test.tsx`（≥4 条用例）；§0.4 目录树同步 |
| **5** | **Task 4 的 `applyTokens` 缺变更检测**。设计文档 §4.4.3 明确要求「变更检测：拿到的 tokens 与上一次的逐字段比对」 | 失败注入 #13（变更检测改成「总是重写 DOM」）**没有东西可改**；且每 30 秒轮询都重写全部 CSS 变量 → 触发全页样式重算，与设计意图相悖 | Task 4.3c：加模块级 `lastApplied: string \| null`，序列化后比较，相同则 return；补一条测试「主题没变时不重写 DOM」；失败注入 #13 指到它 |
| **6** | **各 Task 的预期测试条数全部算错** | 验收时对不上账，会误以为有测试没跑到 | 逐 Task 重算：Task 1 = 75 + 2 + 8 = **85**；Task 2 = 50 + 13 + 6 = **69**；Task 3 = 85 + 4 = **89**；Task 4 = 89 + 6 = **95**。每处都写明算式 + 「以实际输出为准，但增量必须等于新增用例数」 |
| **7** | **设计文档 §4.1.2 / §5.3 第 1 条的「jsdom 环境不注入 `Buffer`」是错的** | 决策 1（逐文件切 jsdom）的**结论正确但理由错误**；且把错误论断记成了「设计阶段的疏漏（已修）」 | 实测：Vitest 3.2.7 的 jsdom environment **显式注入 `global.Buffer = Buffer`**（`node_modules/vitest/dist/chunks/index.CmSc2RE5.js` 第 556–557 行）；把 `readJwtExpiry` 原样放进 jsdom 跑**正常工作**。设计文档已改掉论断与「疏漏」记录，并补上「**逐文件注释优先于全局配置**」这条实测事实 |
| **8** | **「购物车金额改服务端实时价」被误当成「后端的改动」排除了** | 阶段 3 遗留项 4 **其实已经由阶段 3 实现**：`api/src/modules/cart/cart.service.ts` 第 411–417 行的 `read()` 里 `include: { sku: { select: { id, price, product } } }`——**购物车接口返回的就是服务端当前价**；前端 `storefront/src/lib/cart.ts` 第 165 行的 `itemSubtotal` 用的就是 `item.sku?.price` | 设计文档 §1.2 与设计文档的「对阶段 3 验收记录的修正」已改；本计划附表第 6 行同步 |
| **9** | **设计文档 §一 的子项 2 混淆了「实时预览」与「前台实时生效」** | 读起来像把验收 §六 遗留项 2 解决了，而实际上只做了一半 | 设计文档 §一 的表格已拆成 **4a（实时预览，本阶段不做）** / **4b（前台实时生效，本阶段做）**；4a 列入 §七 遗留项 10 |
| **10** | **「网络失败」与「凭证失效」混为一谈** | 后端一次 200ms 的抖动 → `requestRefresh` 返回 `null` → `jwt` 回调把两个令牌都置 `undefined` → **会话被永久作废**，商家被静默踢出且**不可逆** | 设计文档 §5.1 新增 **L18**；Task 2 的实现要点同步改：**区分网络失败与凭证失效** |
| **11** | **多副本/多进程下刷新去重失效**。`inFlightRefreshes` 是模块级变量，只在单进程内有效 | 扩副本后两个进程各发一次刷新 → 同一枚 refreshToken 被提交两次 → `revokeTokenFamily` 吊销全设备登录。⚠️ **但**后端 `auth.service.ts` 第 250 行的 `isConcurrentRace` 已为并发竞态兜底（只拒本请求不牵连其它设备）——**L2 的严重性被高估**，跨进程/跨机器的竞态窗口仍在 | 设计文档 §5.1 新增 **L19** + §七 遗留项 12：措施栏写明「扩副本前必须换 Redis 侧的分布式锁或后端提供幂等刷新端点」，并引用 `isConcurrentRace` 这层兜底 |
| **12** | **多标签页的「先后」竞态（不是并发）** | A 刷新成功后新令牌只写进 A 的 JWT；B 持有旧 cookie 里的旧 refreshToken → B 下次刷新被判「真正的重放」→ 吊销全设备登录 | 设计文档 §5.2 新增 **L20** + §七 遗留项 13；§6.4 的手测场景 2 改成「**先让 A 刷新成功，再让 B 触发刷新**」，观察 `refresh_tokens` 表是否出现 `REVOKED_FAMILY` |
| **13** | **`ThemeWatcher` 的分组标量论证方向反了**。`@theme inline` 只映射 colors / radius / fonts，`--text-*` / `--spacing-*` / `--shadow-*` / `--font-weight-*` **在前台没有任何消费者** | 「只写主色与圆角是半成品，比全写更糟」的**前提不成立**（写与不写视觉完全一样）。真正的发现是：**商家可编辑的分组标量在前台没有消费者** | 设计文档 §4.4.3 已降级为「写了无害但也无用」，并新增 §七 遗留项 11 |
| **14** | **`setProperty` 覆盖不了 `@theme inline` 已内联的值 —— `fontSans` 的行为与其它 token 不一致** | `globals.css` 第 10 行的 `--font-sans: var(--font-sans)` 是**自引用**；客户端写的 `--font-geist-sans` 只在 `next/font` 的变量作用域里存在 → 在非 root 元素上引用会失效 | 设计文档 §5.2 新增 **L21**；§6.4 加一条手测项（核对 `getComputedStyle` 与实际渲染字体） |
| **15** | **轮询失败时保留的「旧主题」可能比服务端注入的还旧** | §4.4.5 那句「服务端注入的那份还在，用户看到的仍是最后一次成功的主题」在**服务端注入的那份本身已过时**时不成立 | 设计文档 §4.4.5 改述为「保留客户端最后一次成功拉到的值（可能比服务端注入的那份更新）」 |
| **16** | **`/api/theme` 的租户解析没被测到** | 计划的 `theme.test.ts` 把 `currentSubdomain` 整个 mock 掉了，**没有测到解析逻辑**；设计文档 §6.2 却声称要测「租户解析」（+3 条）——计划里只有 2 条 | 设计文档 §6.2 改成「**+2 条**」并写明两条路：要么补一条真测 `resolveTenantSubdomain` 的用例（在 `storefront/src/lib/tenant.ts` 加单测），要么就按 +2 条 |
| **17** | **行号修正：`merchant-admin/src/lib/api-client.ts`** | 引用了错的行号 | `if (options.token)`：第 **32** 行 → 第 **30** 行；`apiFetchAuthed`：第 **71–74** 行 → 第 **67–72** 行。设计文档 §3.3 / §4.2.2 / §5.1 L1 / §5.2 L8 与 Task 2 的 commit message 都已同步 |
| **18** | **行号修正：`storefront/src/app/(shop)/page.tsx` 的导航链接** | 引用了错的行号 | 第 37–45 行 → 第 **38 / 41 / 44** 行（三个 `<Link>`）。设计文档 §4.3.4 与 Task 3.3d 已同步 |
| **19** | **Step 1.2 的预期失败原因写错** | 写的是「`render` 找不到」或「`document is not defined`」，实测**都不是** | 实测：补上 `esbuild.jsx` 之前失败原因是 **`React is not defined`**；补上之后才会变成 `document is not defined`。Step 1.2 已改 |
| **20** | **Task 3 的 `AddressForm` 错误消息是英文**。`sanitizeAddressBody` 的 message 是 `"receiver 必须是非空字符串"`——字段名是英文的，直接显示给中文用户不行 | 中文界面里冒出英文字段名 | Task 3.3a：在 `addresses.ts` 里加中文字段名映射（并同步改 `addresses.test.ts` 的断言） |
| **21** | **Step 3.3b「结算页的行为一个字都不许变」与 Step 3.3a「校验用 `sanitizeAddressBody`」直接矛盾** | 提取组件后结算页会突然多出「留空字段被前端拦住」的行为 | Task 3.3a/3.3b：校验**不放在共享的 `AddressForm` 里**——`AddressForm` 保持原样（结算页行为不变），校验放在 `AddressBook` 之外的包装层里做 |
| **22** | **Task 2 缺商家后台的「掉登录」跳转**。`merchant-admin/src/app/(dashboard)/layout.tsx` 第 20 行只判 `!session` | 会话作废后 `session.accessToken === ''` 但 `session` 仍存在 → 页面**仍显示「已登录」**，点任何操作都是 401。**L1 的症状不会因为 `?? ''` 而消失** | Task 2.3c：改成 `if (!session?.accessToken) redirect('/login')` |
| **23** | **Task 4 的 `/api/theme` 路由缺 `Cache-Control: no-store`** | 将来有人给 nginx 加 `proxy_cache` 就会出问题（主题是最该实时的一类数据） | Task 4.3b：`return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })` |
| **24** | **失败注入 #1 的形态不对**。设计 §6.3 #1 写「`environment` 改成 `node` → 组件测试全挂」 | **实测不成立**：逐文件注释**优先于全局配置**，改全局配置注入不会生效 | 改成「**把某个组件测试文件里的 `// @vitest-environment jsdom` 注释删掉**」。设计文档 §6.1 护栏 1 与 §6.3 #1、Task 5 验收清单都已同步 |
| **25** | **失败注入 #12 的账目没标清楚** | #12（`clearInterval` 删掉）**不在 12 项护栏里**，混进去会让「12 项护栏逐项验证」的账目对不上 | 设计文档 §6.3 #12 加注「**#12 不计入 12 项护栏的自动化验证**」；Task 5 的验收清单同步标注 |

> **实施时重点核**（这一轮没能核的）：
>
> | # | 待核对 | 怎么核 |
> |---|--------|-------|
> | 1 | `@testing-library/react` 的最新版本是否支持 React 19.1 | 装完先写一条最小的 `render(<div/>)` 冒烟测试并跑通 |
> | 2 | `vitest.config.ts` 的 `include` 扩到 `{ts,tsx}` 后收集到的文件数是否仍是 6 + 6（+ 新增） | 装完先跑一次 `npm test`，看输出的文件数 |
> | 3 | `next/link` 在 Vitest 的 jsdom 环境里是否需要 mock | 写示范测试时若报 `next/link` 相关错，按设计文档 §4.1.3 的方案 mock |
> | 4 | 商家后台主题编辑页的实时预览要不要做 | 设计文档 §七 遗留项 10 —— **本阶段不做**，但要确认商家不会因此困惑 |

### 0.6 护栏与风险的对照表（验收以这张表为准）

设计文档里有两套编号：§六.1 的**护栏编号**（1–12）与 §五 的**风险编号**
（L1–L21）。本计划正文里写的是护栏编号。

**下表是唯一权威对照：**

| 护栏 | 内容 | 在哪测 | 风险出处 |
|------|------|--------|---------|
| 1 | 组件测试真的在渲染（jsdom 环境生效） | Task 1 | §5.2 L5 |
| 2 | 组件测试的断言是具体的（URL + method + body） | Task 1 | §5.2 L4 / L6 |
| 3 | merchant-admin 在 accessToken 过期时刷新 | Task 2 | §5.1 **L1**（可被利用的漏洞） |
| 4 | merchant-admin 的刷新去重（并发只发一次） | Task 2 | §5.1 **L2 / L19**（可被利用的漏洞） |
| 5 | 刷新失败作废会话（**但网络失败不作废**） | Task 2 | §5.1 **L1 / L18** / §5.2 L8 |
| 6 | 短期令牌不被反复判过期 | Task 2 | §5.2 L15 |
| 7 | 地址簿页能改、删、设默认 | Task 3 | §5.2 L9 / L10 |
| 8 | 地址簿页的表单校验与 `sanitizeAddressBody` 一致 | Task 3 | §5.2 L11 |
| 9 | 地址簿页在 `(shop)` 路由组下（继承主题注入） | Task 3 | §5.2 L17 |
| 10 | 主题改动后前台能感知（**且没变时不重写 DOM**） | Task 4 | §七 遗留项 1 |
| 11 | 主题轮询失败不影响页面 | Task 4 | §5.2 L12 |
| 12 | 主题的 CSS 变量只写白名单里的名字 | Task 4 | §5.1 **L3**（可被利用的漏洞） |

> **护栏 5 的措辞变了**：不是「刷新失败一律作废会话」，
> 而是「**只有凭证真的失效才作废**；网络失败保留旧令牌」（L18）。
> 测试要断言**两条**：401 → 作废；网络异常 → 保留。

---

## Task 1：前端组件测试基建 + 一条示范性组件测试

**这是本阶段优先级最高的一项**——它解锁另外三项的验证能力。

**Files:**
- Modify: `storefront/package.json`
- Modify: `storefront/vitest.config.ts`
- Modify: `storefront/src/lib/theme.ts`（导出 `CSS_VARS`，Task 4 要用）
- Create: `storefront/test/components/product/spec-selector.test.tsx`
- Create: `storefront/test/setup.ts`（若需要）

> ⚠️ **本 Task 只动 storefront**，不动 merchant-admin。
> merchant-admin 的组件测试留到后续（设计文档 §七 遗留项 5）——
> 基建在 storefront 验证过之后，搬到 merchant-admin 是机械工作。

### 1.1 先写失败测试（先让「组件测试」这件事本身失败）

**Step 1.1a: 装依赖**

```bash
cd storefront && npm install -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

预期：新增 4 个包（实际依赖数更多，`@testing-library/dom` 是传递依赖）。

> **版本要能配 React 19。** `@testing-library/react` v16 起支持 React 19；
> v13 及更早的版本用 `ReactDOM.render`，在 React 19 里已被移除。
> 装完先跑下面的冒烟测试确认。
>
> **`@testing-library/jest-dom` 要用 `/vitest` 入口**：
> `import '@testing-library/jest-dom/vitest'`。默认入口会找全局的 `expect`，
> 而本项目的 Vitest 配置是 `globals: false`（不注入全局 `expect`），
> 用默认入口会报「expect is not defined」。

**Step 1.1b: 写冒烟测试，确认基建可用**

先建 `storefront/test/components/smoke.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 冒烟测试：确认 jsdom 环境与 React 渲染都真的生效。
 *
 * 护栏 1：组件测试真的在渲染。若这行环境注释被漏掉，
 * 这里会报 "document is not defined"——报错直白，不会静默跑偏。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('组件测试基建', () => {
  it('能渲染一个组件并查到它的文本', () => {
    render(<p>店铺前台</p>);
    expect(screen.getByText('店铺前台')).toBeTruthy();
  });

  it('jsdom 真的生效了（有 document 与 window）', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });
});
```

> **`// @vitest-environment jsdom` 必须写在文件第一行**（注释之前不能有别的内容）。
> Vitest 用正则扫文件头，位置不对就不生效。

**Step 1.2: 跑测试确认失败**

```bash
cd storefront && npx vitest run test/components/smoke.test.tsx
```

预期：**FAIL**。失败原因是 **`ReferenceError: React is not defined`**。

> ⚠️ **实测过，失败原因不是「`render` 找不到」，也不是「`document is not defined`」。**
> 原因是本项目的 `storefront/tsconfig.json` 第 14 行是 `"jsx": "preserve"`
> （Next.js 用 SWC 编译），**esbuild 不读这个设置**——它默认走 classic transform，
> 把 JSX 编译成 `React.createElement(...)`，而测试文件没有 `import React`。
> **补上 Step 1.3 的 `esbuild: { jsx: 'automatic' }` 之后**，失败原因才会变成
> `document is not defined`（那才是护栏 1 的注入验证形态）。
> 两种失败都算「正确地失败」，但**必须知道当下是哪一种**。

**Step 1.3: 改 `vitest.config.ts`**

`storefront/vitest.config.ts` 改成：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // ⚠️ **必须加这个**，否则所有组件测试报 `React is not defined`。
  //
  // 本项目的 tsconfig.json 第 14 行是 `"jsx": "preserve"`（Next.js 用 SWC），
  // 而 **esbuild 不读 tsconfig 的 jsx 设置**——它默认走 classic transform，
  // 把 JSX 编译成 `React.createElement(...)`，测试文件里没有 import React
  // → ReferenceError: React is not defined。
  //
  // ⚠️ **`esbuild` 必须写在配置的根级，不能写在 `test` 下面**
  // （esbuild 是 Vite 的根级选项，写在 test 下不生效）。实测确认。
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(
        new URL('./test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  test: {
    // ⚠️ **保持 `node`**。既有 Route Handler 测试与纯函数测试根本不需要
    // 浏览器环境（Node 18+ 原生支持 Web 标准的 Request / Response），
    // 改全局环境收益为零、风险是全部回归。
    // 组件测试在自己的文件里用 `// @vitest-environment jsdom` 切过去——
    // 实测：逐文件的环境注释**优先于全局配置**。
    //
    // ⚠️ 不要再写「jsdom 里没有 Buffer」——那是错的，见设计文档 §5.3 第 1 条。
    // Vitest 3.2.7 的 jsdom environment 显式注入 `global.Buffer = Buffer`。
    environment: 'node',
    // ⚠️ 扩到 .tsx：组件测试文件是 .tsx。
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
```

新建 `storefront/test/setup.ts`：

```ts
/**
 * Vitest 的全局 setup。
 *
 * ⚠️ 只做「所有环境都需要」的事。jsdom 专属的东西不要放这里——
 * node 环境的测试也会加载它（setupFiles 对所有文件生效）。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// ⚠️ **必须显式 cleanup**：本项目 Vitest 配置 `globals: false`，全局 afterEach
// 不存在，RTL 的自动 cleanup 不会注册（@testing-library/react/dist/index.js:26
// 是 `if (typeof afterEach === 'function')`）。
// 不清的话 DOM 会跨用例累积，从第 2 条用例起 getAllByRole 就找到多个元素
// → 报 "Found multiple elements with the role \"button\"\"。实测过。
afterEach(() => {
  cleanup();
});
```

> **为什么 `@testing-library/jest-dom/vitest` 放在 setupFiles 而不是每个测试文件里**：
> 放在 setup 里只写一次，且导入顺序是确定的（setupFiles 在测试文件之前跑）。
> 代价是 node 环境的测试也会加载这个包——它很小，且只做匹配器注册，
> 在 node 环境下无害。

> **为什么必须显式 `cleanup()`**：`globals: false` 的直接后果，不是防御性代码。
> RTL v16 的自动 cleanup 依赖**全局** `afterEach`，那个全局在本项目不存在。
> 设计文档 §4.1.2.1 有完整说明。

> **为什么不用 `environmentMatchGlobs`**：Vitest 3 已废弃它。
> 逐文件的环境注释是官方支持的方式，且**那一行注释本身就是文档**。

**Step 1.4: 跑测试确认通过**

```bash
cd storefront && npx vitest run test/components/smoke.test.tsx
```

预期：PASS（2 条）。

**同时确认既有测试没被打破**：

```bash
cd storefront && npm test
```

预期：**75 + 2 = 77 passed**（验收记录 §一：storefront 原为 75 passed / 6 个文件；
`include` 扩到 `.tsx` 后**文件数应该仍是 6 + 1 = 7**——多出来的就是冒烟测试）。

> ⚠️ **如果收集到的文件数不是 7，说明 `include` 扩宽后收集到了意料之外的文件**
> （护栏 L16）。先查清楚再继续。

**Step 1.5: 写示范性的组件测试（「加入购物车」按钮）**

**这是本 Task 的核心交付物。** 它验证基建可用，同时把阶段 3 手测实测过的行为锁住。

创建 `storefront/test/components/product/spec-selector.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 护栏 2：「加入购物车」按钮的组件测试。
 *
 * 阶段 3 补上这个按钮后**没测过**（当时没有 jsdom / Testing Library），
 * 手测时又挖出 3 个 bug。本文件把那 3 类行为锁住。
 *
 * ⚠️ **断言要具体**：断言 URL + method + body，不是「界面上出现了某句话」。
 * 只断言界面文字的测试，换掉请求体照样通过——那是恒真断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SpecSelector } from '@/components/product/spec-selector';
import type { PublicProductDetail } from '@/lib/catalog';

/**
 * 造一份商品详情。
 *
 * 形状照 `storefront/src/lib/catalog.ts` 的 `PublicProductDetail`
 * （第 25–49 行）：两个规格维度（颜色 / 尺码），四个 SKU。
 */
function makeProduct(
  overrides: Partial<PublicProductDetail> = {},
): PublicProductDetail {
  return {
    id: 'p1',
    name: '重磅纯棉T恤',
    slug: 'cotton-tee',
    subtitle: null,
    description: null,
    attributes: {},
    minPrice: 12900,
    publishedAt: '2026-10-01T00:00:00Z',
    category: null,
    media: [],
    specs: [
      {
        id: 'spec-color',
        name: '颜色',
        sort: 0,
        values: [
          { id: 'v-black', value: '黑色', sort: 0 },
          { id: 'v-white', value: '白色', sort: 1 },
        ],
      },
      {
        id: 'spec-size',
        name: '尺码',
        sort: 1,
        values: [{ id: 'v-m', value: 'M', sort: 0 }],
      },
    ],
    skus: [
      {
        id: 'sku-black-m',
        price: 12900,
        comparePrice: null,
        stock: 50,
        specValues: [{ valueId: 'v-black' }, { valueId: 'v-m' }],
      },
      {
        id: 'sku-white-m',
        price: 12900,
        comparePrice: null,
        stock: 0,
        specValues: [{ valueId: 'v-white' }, { valueId: 'v-m' }],
      },
    ],
    ...overrides,
  };
}

/** 造一个成功的 fetch 响应 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('「加入购物车」按钮', () => {
  it('没选规格时按钮不可用，并提示先选规格', () => {
    render(<SpecSelector product={makeProduct()} />);

    const button = screen.getByRole('button', { name: '加入购物车' });
    expect(button).toBeDisabled();
    expect(screen.getByText('请先选择商品规格。')).toBeTruthy();
  });

  it('选好规格后按钮可用', async () => {
    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));

    expect(screen.getByRole('button', { name: '加入购物车' })).not.toBeDisabled();
  });

  it('点按钮后调 POST /api/cart/items，且请求体带 skuId 与数量', async () => {
    // ⚠️ 关键断言：URL + method + body 都要断言。
    // 只断言「界面上出现了『已加入购物车』」的话，把 body 里的 skuId
    // 换成别的也照样通过——那是恒真断言。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: '加入购物车' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cart/items');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      skuId: 'sku-black-m',
      quantity: 1,
    });
  });

  it('成功后显示「已加入购物车。」与去购物车的链接', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: '加入购物车' }));

    expect(await screen.findByText('已加入购物车。')).toBeTruthy();
    const link = screen.getByRole('link', { name: '去购物车' });
    expect(link.getAttribute('href')).toBe('/cart');
  });

  it('失败时透出后端返回的 message，而不是笼统的「加入购物车失败」', async () => {
    // 阶段 3 验收场景 3 实测过后端返回
    // {"message":"商品不可售或不存在","code":"VALIDATION_FAILED"}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { message: '商品不可售或不存在', code: 'VALIDATION_FAILED' },
          400,
        ),
      ),
    );

    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: '加入购物车' }));

    expect(await screen.findByText('商品不可售或不存在')).toBeTruthy();
    expect(screen.queryByText('加入购物车失败')).toBeNull();
  });

  it('缺货的规格不能加购', async () => {
    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '白色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));

    expect(screen.getByRole('button', { name: '加入购物车' })).toBeDisabled();
    expect(screen.getByText('该商品暂时缺货。')).toBeTruthy();
  });

  it('数量输入超过上限时夹到 99', async () => {
    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));

    const input = screen.getByLabelText('购买数量') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '150');

    await waitFor(() => expect(input.value).toBe('99'));
  });

  it('没有规格的商品可以直接加购', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const product = makeProduct({
      specs: [],
      skus: [
        {
          id: 'sku-plain',
          price: 5000,
          comparePrice: null,
          stock: 10,
          specValues: [],
        },
      ],
    });

    const user = userEvent.setup();
    render(<SpecSelector product={product} />);

    const button = screen.getByRole('button', { name: '加入购物车' });
    expect(button).not.toBeDisabled();
    await user.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      skuId: 'sku-plain',
      quantity: 1,
    });
  });
});
```

**Step 1.6: 跑测试**

```bash
cd storefront && npx vitest run test/components/product/spec-selector.test.tsx
```

预期：PASS（8 条）。

**Step 1.7: 跑全量**

```bash
cd storefront && npm test && npm run lint && npm run build
```

预期：**75 + 2 + 8 = 85 passed**（8 个文件）。

**算式**：既有 75 条（6 个文件）+ 冒烟测试 2 条（1 个文件）+ 示范性组件测试 8 条（1 个文件）
= **85 条 / 8 个文件**。

> ⚠️ **以实际输出为准，但增量必须等于新增的用例数**——
> 少了说明有文件没被收集到（比如 `include` 没扩对，或 `esbuild.jsx` 没加导致
> 组件测试整体挂了）。
> 每一处预期条数都按这个算式写，不要照抄一个孤零零的数字。

> **`npm run build` 不能省。** 阶段 3 的验收记录 §三 记着一个 bug：
> 「`addresses/route.ts` 多导出一个普通函数 → 违反 Next.js 的路由导出约束」，
> 而且**它平时不报错**，是被别的文件改动改变 TS 检查顺序时才引爆。
> 加了新文件就是「别的文件改动」。

**Step 1.8: 提交**

```bash
git add storefront/
git commit -m "test(storefront): 前端组件测试基建 + 「加入购物车」按钮的组件测试

前端测试基建原先只覆盖 test/**/*.test.ts 里的纯函数与 Route Handler，
没有组件渲染测试——阶段 3 补完「加入购物车」按钮后没测过，手测又挖出
3 个 bug（令牌过期不刷新、401 被吞成「购物车是空的」、路由多导出）。

引入 Vitest + jsdom + Testing Library。

**全局环境保持 node**，组件测试在自己的文件里用
\`// @vitest-environment jsdom\` 逐文件切换。改全局环境收益为零、
风险是全部回归：既有的 Route Handler 与纯函数测试根本不需要浏览器环境
（Node 18+ 原生支持 Web 标准的 Request/Response）。
逐文件的环境注释优先于全局配置（实测确认）。

vitest.config.ts 加 esbuild: { jsx: 'automatic' }（根级，不能写在 test 下）：
本项目 tsconfig 是 \"jsx\": \"preserve\"（Next 用 SWC），esbuild 不读这个设置，
默认走 classic transform → 所有组件测试报 React is not defined。

test/setup.ts 显式 afterEach(cleanup)：本项目 globals: false，全局 afterEach
不存在，RTL v16 的自动 cleanup 不会注册（它的判定是
\`if (typeof afterEach === 'function')\`）→ DOM 跨用例累积，
从第 2 条用例起就报 \"Found multiple elements with the role button\"。

示范性组件测试锁住「加入购物车」按钮：没选规格时禁用、选好后可用、
点按钮调 POST /api/cart/items（断言 URL + method + body，不是只断言界面
文字）、成功后显示「已加入购物车。」与去购物车链接、失败时透出后端返回的
message、缺货时禁用、数量夹到 99、无规格商品可直接加购。

断言全部用 @testing-library/user-event 而不是 fireEvent——fireEvent 不模拟
真实事件序列（pointerdown → mousedown → focus → mouseup → click），
用它会漏掉真实用户点不动的那类 bug。"
```

---

## Task 2：merchant-admin 的令牌刷新

**阶段 3 手测发现的真 bug**：商家后台连续用超过 2 小时后整体不可用。

**Files:**
- Create: `merchant-admin/src/lib/token-expiry.ts`
- Create: `merchant-admin/test/lib/token-expiry.test.ts`
- Modify: `merchant-admin/src/auth.ts`

> ⚠️ **本 Task 物理复制 storefront 的实现，不建共享包。**
> 理由见设计文档 §4.2.1：两个应用是完全独立的 Next.js 应用
> （仓库根**没有** `package.json`，没有 workspace），建共享包要引入
> monorepo 工具链——那不是「前端补齐」，是基础设施改造。
>
> **防漂移的约定**：本 Task 产出的 `token-expiry.ts` 与 `token-expiry.test.ts`
> 必须与 `storefront/` 下的同名文件**行为完全一致**。实施完要做一次
> 逐行 diff（见 Step 2.6）。

### 2.1 先写失败测试

**Step 2.1a: 复制 token-expiry 的测试**

```bash
cp storefront/test/lib/token-expiry.test.ts merchant-admin/test/lib/token-expiry.test.ts
```

改掉文件头注释里提到 storefront 的地方（改成「merchant-admin」），
**断言部分一个字都不许改**——那正是「两份测试是同一份」这条约定的执行方式。

**Step 2.2: 跑测试确认失败**

```bash
cd merchant-admin && npx vitest run test/lib/token-expiry.test.ts
```

预期：FAIL —— `Cannot find module '@/lib/token-expiry'`。

### 2.3 写实现

**Step 2.3a: 复制 `token-expiry.ts`**

```bash
cp storefront/src/lib/token-expiry.ts merchant-admin/src/lib/token-expiry.ts
```

改掉文件头注释里提到 storefront 的地方。**函数体一个字都不许改**。

> ⚠️ **必须连注释里的设计理由一起复制**。那几段注释解释了
> 「为什么提前量要按令牌寿命的 1/10 收敛」（固定 60 秒的提前量会让
> 15 秒寿命的测试令牌**永远**被判成已过期 → 每次读会话都刷新 →
> 刷新是轮换式的 → 并发的第二轮被后端判重放 → 用户的登录被全部作废）。
> 只复制代码不复制理由，后来的人会把它「简化」回去。

**Step 2.3b: 改 `merchant-admin/src/auth.ts`**

**① 加 import**（在第 3 行 `import Credentials from 'next-auth/providers/credentials';` 之后）：

```ts
import { isTokenExpired } from '@/lib/token-expiry';
```

**② 加去重表与刷新函数**（照 `storefront/src/auth.ts` 第 50–104 行，
插在 `export const { handlers, auth, signIn, signOut } = NextAuth({` 之前）：

> ⚠️ **这段内联代码最终会被删掉**（Step 2.5b 会把刷新段抽到
> `lib/token-refresh.ts` 去，以便单元测试）。
> 这里先照 `storefront/src/auth.ts` 的样子写一遍，作为「照抄」的中间步骤。
> **但三态返回（区分网络失败与凭证失效）要从一开始就写对**——
> 见 §5.1 的 L18。

```ts
/**
 * 正在进行中的刷新：刷新令牌 → 同一个 Promise。
 *
 * ⚠️ **必须有这个去重**。
 *
 * 后端的刷新是**轮换**式的：旧刷新令牌用掉就作废
 * （api/src/modules/auth/auth.service.ts 第 284–290 行），
 * 而被再次使用的那一枚会被当成**重放**，连带把用户**其它设备**的登录一起吊销
 * （同文件第 268 行 revokeTokenFamily）。
 *
 * `jwt` 回调会在**每次读会话**时跑，而一次请求可能读好几次
 * （`/api/auth/session`、页面里的 `auth()`、middleware……），
 * 这些读常常是**并发**的。没有去重的话：
 * 两个并发刷新带着同一枚旧令牌打过去 → 第一个成功并轮换，
 * 第二个拿着已作废的令牌 → 后端判定重放 → 整个令牌族被吊销 →
 * 用户在所有设备上被踢下线。
 *
 * 所以同一枚刷新令牌在途的刷新**只发一次**，后来的调用等同一个 Promise。
 *
 * ⚠️ **这个去重只在单进程内有效**（模块级变量）。扩副本前必须换成
 * Redis 侧的分布式锁，或让后端提供幂等刷新端点
 * （设计文档 §5.1 的 L19 / §七 遗留项 12）。
 *
 * ⚠️ 本文件是 `storefront/src/auth.ts` 同段逻辑的副本。
 * 改动其中一份时**必须同步另一份**。
 */
const inFlightRefreshes = new Map<string, Promise<RefreshedTokens | null>>();

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * 用刷新令牌换一对新令牌。
 *
 * 返回 null 表示刷新失败（刷新令牌过期、被吊销、并发被别人先刷新了）。
 * 调用方据此把会话作废，让用户重新登录——这比拿着一枚过期令牌
 * 继续发请求、让每个接口都回 401 要好。
 */
async function refreshTokens(refreshToken: string): Promise<RefreshedTokens | null> {
  // 同一枚令牌已有刷新在途：等它，不重复发请求
  const existing = inFlightRefreshes.get(refreshToken);
  if (existing) return existing;

  const pending = requestRefresh(refreshToken);
  inFlightRefreshes.set(refreshToken, pending);
  try {
    return await pending;
  } finally {
    // 只清掉自己这一条：万一期间有别的一枚令牌发起了刷新，
    // 直接 clear 会把别人的也抹掉。
    if (inFlightRefreshes.get(refreshToken) === pending) {
      inFlightRefreshes.delete(refreshToken);
    }
  }
}

/** 真正发一次刷新请求 */
async function requestRefresh(
  refreshToken: string,
): Promise<RefreshedTokens | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      accessToken?: string;
      refreshToken?: string;
    };
    if (!data.accessToken || !data.refreshToken) return null;
    return { accessToken: data.accessToken, refreshToken: data.refreshToken };
  } catch {
    // 后端没起来、网络断了——都按刷新失败处理
    return null;
  }
}
```

> ⚠️ **刷新请求不带 `x-tenant-subdomain`**——与 `authorize` 保持一致。
> 商家后台跑在中心域名（`merchant.platform.test`），租户身份完全由
> accessToken 里的 `tenantId` 决定（见本文件第 17–20 行的注释）。
> Nginx 的 `proxy_set_header X-Tenant-Subdomain "";`
> （`infra/nginx/platform.test.conf` 第 62 行）也会把它剥掉——那是对的。

**③ 改 `jwt` 回调**（替换第 87–95 行）：

```ts
    async jwt({ token, user }) {
      if (user) {
        const authUser = user as AuthUser;
        token.accessToken = authUser.accessToken;
        token.refreshToken = authUser.refreshToken;
        token.role = authUser.role;
        token.tenantId = authUser.tenantId;
        return token;
      }

      // ⚠️ **访问令牌过期就刷新**。
      //
      // 后端的 accessToken 只有 2 小时（api/src/modules/auth/auth.module.ts
      // 第 27–28 行 JWT_EXPIRES_IN ?? '2h'），而 NextAuth 的会话默认活 30 天。
      // 不刷新的话，商家连续用超过 2 小时后，后台的每个请求都带一枚
      // 过期令牌 → 后端一律 401 → 商家看到「订单列表加载失败（401）」，
      // 而界面上仍然显示自己已登录。
      const accessToken = token.accessToken as string | undefined;
      const refreshToken = token.refreshToken as string | undefined;
      if (!accessToken || !refreshToken) return token;

      if (!isTokenExpired(accessToken, Math.floor(Date.now() / 1000))) {
        return token;
      }

      const result = await refreshTokens(refreshToken);
      if (!result || !result.ok) {
        if (result && result.reason === 'network') {
          // ⚠️ **网络失败 ≠ 凭证失效**（设计文档 §5.1 的 L18）。
          // 后端只是没响应（重启、抖动、一次 200ms 的卡顿）——
          // 凭证多半还是好的。**保留旧令牌**，让本次请求失败（401），
          // 下次读会话时再试一次。
          //
          // 若在这里作废会话：一次抖动就把商家**永久踢出登录**
          // （refreshToken 也被清掉，必须重新登录），而且不可逆。
          return token;
        }
        // 凭证真的失效了（后端明确返回 401/403，或 refreshToken 已过期/被吊销）：
        // 作废整个会话，让用户重新登录。
        // 保留 accessToken 反而会让每个接口都回 401，
        // 用户看到的现象是「点了没反应」而不是「请重新登录」。
        return { ...token, accessToken: undefined, refreshToken: undefined } as typeof token;
      }

      token.accessToken = result.tokens.accessToken;
      token.refreshToken = result.tokens.refreshToken;
      return token;
    },
```

**④ 改 `session` 回调**（替换第 97–102 行）：

```ts
    async session({ session, token }) {
      // ⚠️ 会话已作废（刷新失败）：不该再给出一个「看起来登录着」的会话。
      // accessToken 为空 → 中转路由按游客处理，用户界面上也能看出
      // 自己掉登录了，而不是拿着空令牌去撞后端的 401。
      //
      // ⚠️ 这里**必须用 `?? ''`**：原来的 `token.accessToken as string` 只是
      // **类型断言**，运行时 `undefined` 会原样传出。
      session.accessToken = (token.accessToken as string | undefined) ?? '';
      session.role = token.role as string;
      session.tenantId = (token.tenantId as string | null) ?? null;
      return session;
    },
```

**⑤ 改商家后台的「掉登录」跳转**（`merchant-admin/src/app/(dashboard)/layout.tsx` 第 20–22 行）

现在只判 `!session`：

```ts
  if (!session) {
    redirect('/login');
  }
```

**会话作废后 `session` 仍然存在**（只是 `session.accessToken === ''`），
所以 `!session` 判不出来 → **页面仍然显示「已登录」**，点任何操作都是 401。
**L1 的症状不会因为 `?? ''` 而消失。** 改成：

```ts
  // ⚠️ 判 `!session?.accessToken` 而不是 `!session`：
  // 会话作废（刷新失败）后 session 仍存在，只是 accessToken 是 ''。
  // 只判 !session 的话页面仍显示「已登录」，点任何操作都是 401
  // ——L1 的症状不会因为 session 回调的 `?? ''` 而消失。
  if (!session?.accessToken) {
    redirect('/login');
  }
```

> ⚠️ 改完之后 `session` 仍然是「可能为 null」的 TS 类型
> （`redirect` 抛特殊错误中断渲染，但 TS 不知道）。
> 如果 `session.user?.email` 那一行报「possibly null」，
> 就改成 `session?.user?.email`（`layout.tsx` 第 51 行）。

**Step 2.4: 跑测试确认通过**

```bash
cd merchant-admin && npx vitest run test/lib/token-expiry.test.ts
```

预期：PASS（13 条，与 storefront 同一份）。

### 2.5 补三条针对刷新逻辑的测试

`token-expiry.ts` 的 13 条用例覆盖的是**纯函数**，不覆盖 `auth.ts` 的刷新段。
**刷新段要能被测，就得把它从 `auth.ts` 里剥出来**——但 `auth.ts` 顶层就调
`NextAuth({...})`，import 它就会真的初始化 NextAuth。

**方案**：把刷新段抽到 `merchant-admin/src/lib/token-refresh.ts`，
`auth.ts` 从那里 import。这样：

- `token-refresh.ts` 是纯模块，能直接进单元测试；
- `auth.ts` 只负责 NextAuth 的配置。

**⚠️ 这与「照抄 storefront」有偏差**——storefront 是内嵌在 `auth.ts` 里的。
但抽取是为了可测性，且**行为完全一致**。要在两边的注释里写明这处差异，
免得后来的人以为两边结构一样。

**Files 追加:**
- Create: `merchant-admin/src/lib/token-refresh.ts`
- Create: `merchant-admin/test/lib/token-refresh.test.ts`

`merchant-admin/src/lib/token-refresh.ts`：

```ts
/**
 * 访问令牌的刷新。
 *
 * ## 为什么从 `auth.ts` 里抽出来
 *
 * `auth.ts` 顶层就调用 `NextAuth({...})`，import 它就会真的初始化
 * NextAuth（连带 next-auth 的整个依赖图，含 `server-only`）。
 * 抽出来才能直接进单元测试。
 *
 * ⚠️ 本文件与 `storefront/src/lib/token-expiry.ts` 是同一套逻辑的副本
 * （storefront 那边内嵌在 `auth.ts` 里）。行为必须完全一致——
 * 判据是两边的测试文件断言相同的行为。
 */

/**
 * 后端地址。
 *
 * ⚠️ **必须真的定义它**（不要只写在注释里）——
 * 否则 `requestRefresh` 里引用 `${API_BASE_URL}` 会抛
 * `ReferenceError: API_BASE_URL is not defined`。
 * 与 `merchant-admin/src/auth.ts` 第 4–5 行的写法保持一致。
 */
const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

/**
 * 正在进行中的刷新：刷新令牌 → 同一个 Promise。
 *
 * ⚠️ **必须有这个去重**。理由见 `token-expiry.ts` 与
 * `storefront/src/auth.ts` 第 33–48 行的注释。
 *
 * ⚠️ **这个去重只在单进程内有效**（模块级变量）。扩副本前必须换成
 * Redis 侧的分布式锁，或让后端提供幂等刷新端点——见设计文档 §5.1 的 L19
 * 与 §七 遗留项 12。
 */
const inFlightRefreshes = new Map<string, Promise<RefreshResult | null>>();

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * 刷新结果的三态。
 *
 * ⚠️ **必须区分「网络失败」与「凭证失效」**（设计文档 §5.1 的 L18）。
 *
 * - `invalid`：后端**明确**返回 401/403 → 凭证真的失效了 → 作废整个会话。
 * - `network`：**请求根本没发出去或没拿到响应**（后端没起来、网络断了、
 *   一次 200ms 的抖动）→ **凭证多半还是好的** → **保留旧令牌**，
 *   让本次请求失败即可。
 *
 * 把两者混为一谈的后果：一次网络抖动就把商家**永久踢出登录**
 * （accessToken 与 refreshToken 都被清掉，必须重新登录）。
 */
export type RefreshResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; reason: 'invalid' | 'network' };

/**
 * 用刷新令牌换一对新令牌。
 *
 * 返回 null 表示「本次刷新没有拿到新令牌」，具体原因看 `RefreshResult`。
 */
export async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult | null> {
  const existing = inFlightRefreshes.get(refreshToken);
  if (existing) return existing;

  const pending = requestRefresh(refreshToken, fetchImpl);
  inFlightRefreshes.set(refreshToken, pending);
  try {
    return await pending;
  } finally {
    // 只清掉自己这一条
    if (inFlightRefreshes.get(refreshToken) === pending) {
      inFlightRefreshes.delete(refreshToken);
    }
  }
}

/** 真正发一次刷新请求 */
async function requestRefresh(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<RefreshResult | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
  } catch {
    // ⚠️ **网络失败**：请求没发出去或没拿到响应。
    // 这**不代表凭证失效**——保留旧令牌，让调用方按「本次请求失败」处理，
    // 不要作废会话（设计文档 §5.1 的 L18）。
    return { ok: false, reason: 'network' };
  }

  if (response.status === 401 || response.status === 403) {
    // ⚠️ **凭证失效**：后端明确拒了。调用方据此作废整个会话。
    return { ok: false, reason: 'invalid' };
  }
  if (!response.ok) {
    // 其它错误（5xx 等）：后端没给出「凭证无效」的结论，
    // 按网络类失败处理——保留旧令牌，下次再试。
    return { ok: false, reason: 'network' };
  }

  const data = (await response.json()) as {
    accessToken?: string;
    refreshToken?: string;
  };
  if (!data.accessToken || !data.refreshToken) {
    // 响应不完整：当作「没刷新成」，但**不**判定凭证失效。
    return { ok: false, reason: 'network' };
  }
  return {
    ok: true,
    tokens: { accessToken: data.accessToken, refreshToken: data.refreshToken },
  };
}
```

> **`fetchImpl` 参数是为了可测**。默认参数是全局 `fetch`，
> 测试时传一个假实现进去——这样**不用 `vi.stubGlobal`**，
> 也不会影响同一测试文件里的其它用例。
>
> ⚠️ `API_BASE_URL` 从 `process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1'`
> 读，与 `merchant-admin/src/auth.ts` 第 4–5 行一致。**要在代码里真的定义它**——
> 只写在注释里会得到 `ReferenceError: API_BASE_URL is not defined`。

`merchant-admin/test/lib/token-refresh.test.ts`：

```ts
/**
 * 护栏 3 / 4 / 5：merchant-admin 的令牌刷新。
 *
 * 这三条例外——它们守的是**可被利用的漏洞**（设计文档 §5.1 的 L1 / L2 / L18）：
 * - 不刷新 → 商家后台 2 小时后整体不可用，界面却显示「已登录」（L1）
 * - 不去重 → 并发刷新被判重放 → 吊销该用户**所有设备**的登录（L2）
 * - 网络失败也作废会话 → 一次抖动就把商家永久踢出（L18）
 */
import { describe, expect, it, vi } from 'vitest';

import { refreshTokens } from '@/lib/token-refresh';

/** 造一个成功的刷新响应 */
function refreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({ accessToken, refreshToken }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('刷新令牌', () => {
  it('成功后返回新的一对令牌', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse('new-access', 'new-refresh'));

    const result = await refreshTokens('old-refresh', fetchImpl);

    expect(result).toEqual({
      ok: true,
      tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' },
    });
  });

  it('请求体只带 refreshToken，不带任何别的东西', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse('new-access', 'new-refresh'));

    await refreshTokens('old-refresh', fetchImpl);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'old-refresh' });
  });

  it('并发调用只发一次请求（护栏 4）', async () => {
    // 后端的刷新是轮换式的，并发的第二次会被判成重放，
    // 连带吊销该用户所有设备上的登录（api/src/modules/auth/auth.service.ts
    // 第 268 行 revokeTokenFamily）。这是本 Task 最要紧的一条。
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(refreshResponse('new-access', 'new-refresh'));

    const results = await Promise.all([
      refreshTokens('same-refresh', fetchImpl),
      refreshTokens('same-refresh', fetchImpl),
      refreshTokens('same-refresh', fetchImpl),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it('后端明确返回 401 时判定为「凭证失效」（护栏 5）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));

    expect(await refreshTokens('bad-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('后端返回 403 时同样判定为「凭证失效」', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 403 }));

    expect(await refreshTokens('bad-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('网络异常判定为「网络失败」而不是「凭证失效」（护栏 5 / L18）', async () => {
    // ⚠️ 这条是 L18 的核心：一次 200ms 的抖动不该把商家永久踢出登录。
    // 网络失败 → 保留旧令牌 → 下次读会话再试。
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await refreshTokens('old-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('后端 5xx 判定为「网络失败」，不作废会话', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));

    expect(await refreshTokens('old-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('响应里缺 accessToken 时判为「网络失败」，不抛错', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ refreshToken: 'r' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    expect(await refreshTokens('old-refresh', fetchImpl)).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});
```

**Step 2.5b: 把 `auth.ts` 改成从 `token-refresh.ts` import**

把 Step 2.3b 里内嵌的 `inFlightRefreshes` / `refreshTokens` / `requestRefresh`
**整段删掉**，改成：

```ts
import { refreshTokens } from '@/lib/token-refresh';
```

`jwt` 回调里的 `await refreshTokens(refreshToken)` 保持不变——
签名一致（第二个参数有默认值）。

### 2.6 验证与提交

**Step 2.6a: 跑测试**

```bash
cd merchant-admin && npm test && npm run lint && npm run build
```

预期：**50 + 13 + 6 = 69 passed**，**8 个文件**。

**算式**：既有 50 条（6 个文件）+ `token-expiry.test.ts` 13 条（复制）
+ `token-refresh.test.ts` 6 条 = **69 条 / 8 个文件**。

> ⚠️ **以实际输出为准，但增量必须等于新增的用例数**——
> 少了说明有文件没被收集到。
> ⚠️ `token-refresh.test.ts` 的条数按 Step 2.5 的最终版本算：
> 那是 **6 条**（成功 / 请求体 / 并发只发一次 / 401 / 网络异常 / 缺 accessToken）。
> 若按 Step 2.5 的三态版本实施，则是 **8 条**（多出 403 与 5xx 两条），
> 总数相应变成 **71**。以实际写的用例数为准。

**Step 2.6b: 逐行 diff 两份 token-expiry**

```bash
diff storefront/src/lib/token-expiry.ts merchant-admin/src/lib/token-expiry.ts
diff storefront/test/lib/token-expiry.test.ts merchant-admin/test/lib/token-expiry.test.ts
```

预期：**只差文件头的注释**（各自指向本应用）。

> 这就是「两份测试是同一份」这条防漂移约定的**可执行检查**。
> 把这条 diff 命令写进代码评审的检查单。

**Step 2.6c: 提交**

```bash
git add merchant-admin/
git commit -m "fix(merchant-admin): 访问令牌过期后自动刷新，不再整体不可用

阶段 3 手测发现的真 bug：storefront 会用 refreshToken 换新的 accessToken，
merchant-admin 不会——后端 accessToken 只有 2 小时（JWT_EXPIRES_IN ?? '2h'），
而 NextAuth 的会话默认活 30 天。商家连续用超过 2 小时后，后台的每个请求
都带一枚过期令牌 → 后端一律 401 → 商家看到「加载失败（401）」，
而界面上仍然显示自己已登录（L1，可被利用的漏洞）。

把 storefront 那套做法搬过来：
- token-expiry.ts 复制过来（连设计理由一起复制）
- auth.ts 的 jwt 回调里检测过期 → 刷新 → 失败则作废整个会话
- session 回调改成 \`?? ''\`：原来的 \`token.accessToken as string\` 只是
  **类型断言**，运行时 undefined 会原样传出
- (dashboard)/layout.tsx 改成 \`if (!session?.accessToken) redirect('/login')\`：
  会话作废后 session 仍存在（只是 accessToken 是 ''），只判 !session 的话
  页面仍显示「已登录」，点任何操作都是 401——L1 的症状不会因为 ?? '' 而消失

刷新失败分两种，不混为一谈（L18，可被利用的漏洞）：
- 后端明确返回 401/403 → 凭证失效 → 作废整个会话
- 网络失败（请求没发出去/没拿到响应，或 5xx）→ 保留旧令牌，
  只让本次请求失败
把两者混为一谈的后果：一次 200ms 的网络抖动就把商家永久踢出登录
（refreshToken 也被清掉，不可逆）。

刷新必须去重（L2，可被利用的漏洞）：后端的刷新是轮换式的
（auth.service.ts 第 284–290 行的条件更新），并发的第二次刷新会被判成重放，
第 268 行 revokeTokenFamily 吊销该用户**所有设备**的登录。
一次页面请求会读好几次会话且常常并发，所以同一枚刷新令牌在途只发一次。

刷新逻辑抽到 lib/token-refresh.ts 而不是内嵌在 auth.ts——auth.ts 顶层就调
NextAuth({...})，import 它就会真的初始化 next-auth 的整个依赖图，抽出来
才能进单元测试。fetchImpl 参数让测试不用 stub 全局 fetch。

刷新请求不带 x-tenant-subdomain：商家后台跑在中心域名，租户身份完全由
accessToken 里的 tenantId 决定。

token-expiry.ts 是 storefront 同名文件的副本，改一边必须同步另一边——
判据是两份测试文件断言相同的行为（见提交里的 diff 命令）。"
```

---

## Task 3：地址簿的独立页面

**Files:**
- Create: `storefront/src/components/address/address-form.tsx`
- Create: `storefront/src/components/address/address-book.tsx`
- Modify: `storefront/src/components/checkout/checkout-form.tsx`
- Create: `storefront/src/app/(shop)/account/addresses/page.tsx`
- Modify: `storefront/src/app/(shop)/account/page.tsx`
- Modify: `storefront/src/app/(shop)/page.tsx`
- Create: `storefront/test/components/address/address-form.test.tsx`
- Create: `storefront/test/components/address/address-book.test.tsx`

> ⚠️ **`address-book.tsx` 不能漏。** 它承载设计文档 §6.3 的失败注入 #10
> （「设为默认」改成乐观更新）与 #11（去掉删除的二次确认）——
> **没有这份组件与它的测试，这两条注入就没有测试可挂**，
> 验收时会误判成「注入没生效」。

> ⚠️ **路由必须是 `app/(shop)/account/addresses/page.tsx`。**
> 放在顶层 `app/addresses/` 会**绕过 `ShopLayout` 的主题注入**
> （`storefront/src/app/(shop)/layout.tsx` 第 48–53 行注入 `<style>`）——
> 那个布局是店铺主题生效的唯一来源。护栏 9。

### 3.1 先写失败测试

**Step 3.1a: 写 `AddressForm` 的组件测试**

创建 `storefront/test/components/address/address-form.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 护栏 8：地址表单的校验规则与 `sanitizeAddressBody` 一致。
 *
 * ⚠️ **不要另写一套规则**。`sanitizeAddressBody`
 * （storefront/src/lib/addresses.ts 第 21–47 行）是前后端共同的白名单，
 * 它已有 7 条单元测试（storefront/test/lib/addresses.test.ts）守着。
 * 前端表单直接复用它的判定，前后端规则就不会漂移。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AddressForm } from '@/components/address/address-form';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 一条完整的地址 */
const VALID = {
  receiver: '张三',
  phone: '13800000000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文一西路 100 号',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('地址表单', () => {
  it('新增时提交全部六个字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'a1', ...VALID }));
    vi.stubGlobal('fetch', fetchMock);

    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<AddressForm mode="create" onCreated={onCreated} />);

    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    await user.type(screen.getByLabelText('手机号'), VALID.phone);
    await user.type(screen.getByLabelText('省份'), VALID.province);
    await user.type(screen.getByLabelText('城市'), VALID.city);
    await user.type(screen.getByLabelText('区 / 县'), VALID.district);
    await user.type(screen.getByLabelText('详细地址'), VALID.detail);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/addresses');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(VALID);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('编辑时提交到 PATCH /api/addresses/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'a1', ...VALID }));
    vi.stubGlobal('fetch', fetchMock);

    const onUpdated = vi.fn();
    const user = userEvent.setup();
    render(
      <AddressForm
        mode="edit"
        addressId="a1"
        initial={{ id: 'a1', ...VALID, isDefault: false }}
        onUpdated={onUpdated}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存地址' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/addresses/a1');
    expect(init.method).toBe('PATCH');
  });

  it('必填字段缺一不可：留空时前端拦住，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressForm mode="create" onCreated={vi.fn()} />);

    // 只填收件人，其余留空
    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('后端拒绝时显示后端返回的 message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: '手机号格式不正确' }, 400)),
    );

    const user = userEvent.setup();
    render(<AddressForm mode="create" onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    // 其余字段用默认值填满（下面逐个填）
    await user.type(screen.getByLabelText('手机号'), VALID.phone);
    await user.type(screen.getByLabelText('省份'), VALID.province);
    await user.type(screen.getByLabelText('城市'), VALID.city);
    await user.type(screen.getByLabelText('区 / 县'), VALID.district);
    await user.type(screen.getByLabelText('详细地址'), VALID.detail);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    expect(await screen.findByText('手机号格式不正确')).toBeTruthy();
  });
});
```

**Step 3.2: 跑测试确认失败**

```bash
cd storefront && npx vitest run test/components/address/address-form.test.tsx
```

预期：FAIL —— `Cannot find module '@/components/address/address-form'`。

### 3.3 写实现

**Step 3.3a: 提取 `AddressForm`**

新建 `storefront/src/components/address/address-form.tsx`。

**从 `storefront/src/components/checkout/checkout-form.tsx` 第 275–383 行搬过来**，
改动有两处：

1. **加 `'use client'`**（新文件是客户端组件）。
2. **加两种模式**：
   - `mode: 'create'` → `POST /api/addresses`，成功后调 `onCreated(address)`
   - `mode: 'edit'` → `PATCH /api/addresses/:id`，成功后调 `onUpdated(address)`

> ⚠️ **⚠️ 校验不放进 `AddressForm` 里**（这是一处**行为变更**的取舍，
> 详见下面的「为什么校验不放在 AddressForm 里」）。
> `AddressForm` 保持与现在的结算页版本**行为一致**。

组件的 props：

```ts
export function AddressForm({
  mode,
  addressId,
  initial,
  onCreated,
  onUpdated,
}: {
  mode: 'create' | 'edit';
  /** mode 为 'edit' 时必填 */
  addressId?: string;
  /** mode 为 'edit' 时的初始值 */
  initial?: Address;
  onCreated?: (address: Address) => void;
  onUpdated?: (address: Address) => void;
}) {
```

`mode` 为 `'edit'` 时用 `initial` 初始化表单 state，`mode` 为 `'create'` 时用空值。

##### 「为什么校验不放在 `AddressForm` 里」

**原计划在这里有个直接矛盾**：
Step 3.3a 说「校验用 `sanitizeAddressBody`」，
Step 3.3b 说「结算页的行为一个字都不许变」。
但结算页现在的 `AddressForm` **没有**这个校验——
加上它，结算页就会变成「留空字段被前端拦住」，那是**用户可见的行为变更**。

**两条路二选一，本计划选第一条**：

| 方案 | 做法 | 后果 |
|------|------|------|
| **A（采用）** | **校验放在 `AddressBook` 之外的包装层**——`AddressForm` 保持原样（结算页行为不变），地址簿页在提交前自己调 `sanitizeAddressBody` 校验 | 结算页**零行为变更**；地址簿页有前端校验。⚠️ 代价：地址簿页与结算页的校验入口不在一处——但**规则本身仍是同一份**（`sanitizeAddressBody`），不会漂移 |
| B | 校验放进 `AddressForm`，两个页面共用 | 结算页**行为变更**：用户点了没反应（前端拦住），而不是像现在这样发给后端、后端返回错误 |

**选 A 的理由**：阶段 3 验收场景 13 测的就是「结算页新增地址」这条路径，
「结算页行为不变」是明确写下的约束，不该在提取组件时被顺手改掉。

**「包装层」具体长什么样**：地址簿页的 `AddressBook` 组件在调用
`AddressForm` 的 `onCreated` / `onUpdated` 之前，先对表单值调
`sanitizeAddressBody`；不通过就把错误显示在 `AddressBook` 里（不提交）。

##### 中文字段名映射（`sanitizeAddressBody` 的错误消息是英文的）

`storefront/src/lib/addresses.ts` 第 34 行的 message 是
`` `${field} 必须是非空字符串` ``——`field` 是**英文字段名**
（`receiver` / `phone` / `province` / `city` / `district` / `detail`）。
直接显示给中文用户不行（界面上会出现「receiver 必须是非空字符串」）。

**改法**：在 `addresses.ts` 里加一张**中文字段名映射表**，
错误消息用它而不是原始字段名：

```ts
/** 字段名 → 中文名（错误消息要直接显示给用户） */
const FIELD_LABELS: Record<string, string> = {
  receiver: '收件人',
  phone: '手机号',
  province: '省份',
  city: '城市',
  district: '区 / 县',
  detail: '详细地址',
};

/** 字段名的中文显示名（未知字段原样返回） */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}
```

第 34 行改成：

```ts
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, message: `${fieldLabel(field)} 必须是非空字符串` };
    }
```

> ⚠️ **`addresses.test.ts` 的断言要同步改**——它现在断言的是英文字段名。
> 那 7 条用例的**断言要改成中文**（`storefront/test/lib/addresses.test.ts`）。
> 这是**唯一**一处「既有测试的断言要改」的地方，改的时候在 commit message 里说明。

##### `isDefault` 的消息

第 41 行的 `'isDefault 必须是布尔值'` 同样有英文。
它是**内部字段**（前端 UI 不暴露这个开关），可以保留英文；
若要一致，也加进 `FIELD_LABELS` 映射成「默认标记」。

**Step 3.3b: 改结算页**

`storefront/src/components/checkout/checkout-form.tsx`：

1. 删掉第 275–383 行的私有 `AddressForm` 函数。
2. 改成 import：
   ```ts
   import { AddressForm } from '@/components/address/address-form';
   ```
3. 第 216–222 行的用法改成：
   ```tsx
   {showAddressForm && (
     <AddressForm
       mode="create"
       onCreated={(address) => {
         setAddressesAndSelect(address);
       }}
     />
   )}
   ```

> ⚠️ **结算页的行为一个字都不许变**：
> 「新增地址」按钮仍然存在、表单仍然是内嵌展开的、
> 新增成功后仍然选中新地址并 `router.refresh()`。
> 阶段 3 验收场景 13 测的就是这条路径。
>
> ⚠️ **这正是校验不放在 `AddressForm` 里的原因**——
> 共享组件里加了 `sanitizeAddressBody` 校验，结算页就会多出
> 「留空字段被前端拦住」的行为，那是用户可见的变更。
> 校验放在 `AddressBook` 这一侧（见 Step 3.3a 的「为什么校验不放在
> `AddressForm` 里」）。

**Step 3.3c: 写地址簿页**

新建 `storefront/src/app/(shop)/account/addresses/page.tsx`。

结构：

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { fetchAddresses } from '@/lib/shop-api';
import { AddressBook } from '@/components/address/address-book';

export const dynamic = 'force-dynamic';

export default async function AddressesPage() {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const { addresses, error } = await fetchAddresses();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-8">
      {/* ⚠️ 必须有「返回」路径：storefront 没有全局 header，
          用户从首页导航进本页后没有任何出口（只能改地址或点浏览器后退）。 */}
      <Link href="/account" className="self-start text-sm underline">
        返回我的账户
      </Link>
      <h1 className="text-2xl font-bold">收货地址</h1>
      <AddressBook initial={addresses} error={error} />
    </main>
  );
}
```

> `dynamic = 'force-dynamic'` 与 `(shop)/checkout/page.tsx` 第 20 行一致——
> 地址是登录用户的私有数据，不能进静态缓存。

新建 `storefront/src/components/address/address-book.tsx`（`'use client'`）：

- 列表：每条地址显示收件人 / 电话 / 地址 / 「默认」标记
- 「新增地址」按钮 → 展开 `AddressForm`（`mode="create"`）
- 每条地址的「编辑」→ 展开 `AddressForm`（`mode="edit"`）
- 每条地址的「设为默认」→ `PATCH /api/addresses/:id` body `{ isDefault: true }`
- 每条地址的「删除」→ **二次确认** → `DELETE /api/addresses/:id`
- 加载失败 → 显示**错误** + 「重试」，**不谎报「空」**
  （`cart-list.tsx` 第 145–160 行的教训）

**关键实现约束**（护栏 7、风险 L9、L10）：

```ts
/**
 * 设为默认。
 *
 * ⚠️ **不做乐观更新**：前端不先改界面上的 isDefault，而是等
 * PATCH 返回后用**服务端返回的地址**更新状态。
 *
 * 理由：后端有部分唯一索引
 * （addresses_tenant_customer_default_uniq）保证默认地址唯一，
 * 且在 create/update 时会先 clearDefault。前端抢着改界面，
 * 界面显示的就与库里不一致。
 *
 * ⚠️ 前端**不需要**自己先取消旧的默认——只管发 `isDefault: true`。
 */
async function setDefault(id: string) {
  const response = await fetch(`/api/addresses/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isDefault: true }),
  });
  if (!response.ok) { /* 显示错误 */ return; }
  const updated = (await response.json()) as Address;
  // 用服务端返回的值更新列表：
  // 旧默认的那条按「服务端说它现在不是默认」处理，
  // 被设为默认的那条直接用服务端返回的整条记录覆盖。
  setAddresses((prev) =>
    prev.map((a) =>
      a.id === id
        ? updated
        : updated.isDefault
          ? { ...a, isDefault: false }
          : a,
    ),
  );
}
```

> 上面的 `setAddresses` 用服务端返回的 `updated`（而不是本地推算）来更新，
> 保证界面与库一致。
> ⚠️ **不要用「先改界面再发请求」的写法**——那是乐观更新，
> 是失败注入 #10 要注入的东西。

**删除的二次确认**：

```ts
/**
 * 删除地址。
 *
 * ⚠️ 二次确认。与 cart-list.tsx 第 128 行 `confirm('确定清空购物车？')`
 * 的既有风格一致。
 */
async function remove(address: Address) {
  if (!confirm(`确定删除「${address.receiver} ${address.phone}」的地址？`)) {
    return;
  }
  // ...
}
```

**Step 3.3c-bis: 写 `address-book` 的组件测试**

创建 `storefront/test/components/address/address-book.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 护栏 7 / 8：地址簿的四条关键行为。
 *
 * ⚠️ **这份测试不能少**——设计文档 §6.3 的失败注入
 * #10（「设为默认」改成乐观更新）与 #11（去掉删除的二次确认）
 * **挂在这份测试上**。没有它，这两条注入就没有测试可挂，
 * 验收时会误判成「注入没生效」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AddressBook } from '@/components/address/address-book';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ADDRESS_A = {
  id: 'a1',
  receiver: '张三',
  phone: '13800000000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文一西路 100 号',
  isDefault: false,
};

const ADDRESS_B = {
  id: 'a2',
  receiver: '李四',
  phone: '13900000000',
  province: '江苏省',
  city: '南京市',
  district: '鼓楼区',
  detail: '中山路 200 号',
  isDefault: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('地址簿', () => {
  it('「设为默认」要等 PATCH 返回后才更新界面（护栏 7 / L9）', async () => {
    // ⚠️ 关键：PATCH 的响应**延后**返回。
    // 若实现是乐观更新（先改界面再发请求），那么在响应回来之前
    // 界面上的「默认」标记就已经变了——这条用例会挂。
    let resolvePatch: (r: Response) => void = () => {};
    const patched = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/a1')) return patched;
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressBook initial={[ADDRESS_A, ADDRESS_B]} error={null} />);

    // 初始：a2 是默认
    expect(screen.getByText('默认')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '设为默认' }));

    // PATCH 还没返回 → 界面**不该**变
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('默认')).toBeTruthy();

    // PATCH 返回（服务端说 a1 现在是默认，a2 不是）
    resolvePatch(jsonResponse({ ...ADDRESS_A, isDefault: true }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '设为默认' }),
      ).toBeTruthy(),
    );
  });

  it('「删除」点第一次不调 DELETE，第二次才调（护栏 7 / L10）', async () => {
    // ⚠️ 这是失败注入 #11 的挂点。
    const confirmSpy = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)   // 第一次点：用户取消
      .mockReturnValueOnce(true);    // 第二次点：用户确认
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressBook initial={[ADDRESS_A, ADDRESS_B]} error={null} />);

    await user.click(screen.getByRole('button', { name: '删除' }));

    // 第一次：用户取消 → **不发 DELETE**
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    // 第二次：用户确认 → 才发 DELETE
    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/addresses/a1');
    expect(init.method).toBe('DELETE');
  });

  it('删除成功后列表里移除该项', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressBook initial={[ADDRESS_A, ADDRESS_B]} error={null} />);

    expect(screen.getByText('张三')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(screen.queryByText('张三')).toBeNull());
    // 另一条还在
    expect(screen.getByText('李四')).toBeTruthy();
  });

  it('加载失败时显示错误，而不是谎报「空」', async () => {
    render(<AddressBook initial={[]} error="地址簿加载失败" />);

    expect(screen.getByText('地址簿加载失败')).toBeTruthy();
    // ⚠️ 不能显示「还没有收货地址。」——那是谎报
    expect(screen.queryByText('还没有收货地址。')).toBeNull();
  });
});
```

> ⚠️ **「删除」的按钮名要能区分**。上面两条用例都用
> `getByRole('button', { name: '删除' })`——若列表里有两条地址，
> `getByRole` 会因为**找到多个**而报错。实施时要么给按钮加上可访问名
> （如 `aria-label="删除 张三 的地址"`），要么在测试里用 `getAllByRole(...)[0]`。
> **推荐前者**（按钮的可访问名带上收件人，对读屏软件也更友好）。
> 上面的用例按「列表里只有一条待删地址」的场景写，实施时按实际的
> 可访问名调整选择器即可。

**Step 3.3d: 加导航入口**

`storefront/src/app/(shop)/page.tsx` 第 44 行的「账户」链接**之前**加
（现有的三个 `<Link>` 在第 **38 / 41 / 44** 行）：

```tsx
<Link href="/account/addresses" className="underline">
  地址
</Link>
```

> 放在「账户」前面——顺序按「逛 → 交易 → 我的」：品类 → 购物车 → 我的订单 →
> 地址 → 账户。

`storefront/src/app/(shop)/account/page.tsx` 第 19 行后加：

```tsx
<Link href="/account/addresses" className="underline">
  收货地址
</Link>
```

（需要 `import Link from 'next/link';`）

**Step 3.3e: 改 `account/page.tsx` 的地址簿入口不造成循环**

`/account` → `/account/addresses` 是**向下**的引用，
`/account/addresses` **不引用** `/account`——没有循环。

### 3.4 跑测试与验证

**Step 3.4a: 自动化**

```bash
cd storefront && npm test && npm run lint && npm run build
```

预期：**85 + 4 = 89 passed**，**9 个文件**。

**算式**：Task 1 结束时 85 条 / 8 个文件
+ `address-form.test.tsx` 4 条（1 个文件）
+ `address-book.test.tsx` 4 条（1 个文件）
= **89 条 / 9 个文件**。

> ⚠️ **以实际输出为准，但增量必须等于新增的用例数**（8 条）。

**Step 3.4b: 浏览器手测**

环境：storefront 本地 dev 跑在 **3011**（启动前 `rm -rf .next`），
api 本地 dev 跑在 3010（`FAKE_PAYMENT_ENABLED=true`）。
**不要在 3001 的旧容器上测**（阶段 2b 栽过两次）。

| # | 场景 | 预期 |
|---|------|------|
| 1 | 登录后访问 `/account/addresses` | 看到地址列表、默认地址有「默认」标记 |
| 2 | 点「新增地址」填六个字段保存 | 列表里多一条 |
| 3 | 点某条地址的「编辑」改详情保存 | 列表里那条变了 |
| 4 | 点某条地址的「设为默认」 | 旧的默认标记消失、新的出现；**查库确认只有一条 `isDefault=true`** |
| 5 | 点「删除」 | 弹二次确认；**点「取消」不发请求**；确认后列表里那条没了 |
| 6 | 地址簿页的主题 | 与其它店铺页一致——`getComputedStyle(document.documentElement)` 的 `--primary` 不是默认值（护栏 9） |
| 7 | 在地址簿页改默认地址 → 回 `/checkout` | 结算页选中的是新的默认地址 |
| 8 | 结算页的「新增地址」仍能用 | 能新增、能选中新地址；**留空字段时仍然发给后端**（结算页行为没变——见 Step 3.3a 的「为什么校验不放在 `AddressForm` 里」） |
| 9 | 地址簿页留空字段提交 | **前端拦住**，错误提示是**中文**（「收件人 必须是非空字符串」，不是「receiver 必须是非空字符串」） |
| 10 | 地址簿页的「返回我的账户」链接 | 点它回到 `/account`（storefront 没有全局 header，这是唯一的返回路径） |

**Step 3.4c: 提交**

```bash
git add storefront/
git commit -m "feat(storefront): 消费者侧地址簿独立页

地址原先只能在结算页的「新增地址」里维护，改默认地址也要进结算页——
不合理。现在有 /account/addresses 独立页，能新增/编辑/删除/设默认。

路由挂在 (shop) 路由组下（不是顶层 app/addresses/）——顶层路由会**绕过
ShopLayout 的主题注入**，那个布局里的 <style> 是店铺主题生效的唯一来源。

AddressForm 从 checkout-form.tsx 提取到 components/address/address-form.tsx：
6 个必填字段复制一遍必然漂移。提取后支持两种模式（新增/编辑），
结算页与地址簿页各引一份。结算页的行为一个字没变。

表单校验复用 lib/addresses.ts 的 sanitizeAddressBody，不另写一套规则——
它是前后端共同的白名单（后端开了 forbidNonWhitelisted），另写必然漂移。

「设为默认」不做乐观更新：等 PATCH 返回后用服务端返回的地址更新界面。
后端有部分唯一索引保证默认地址唯一，前端抢着改界面会让界面与库里不一致。
前端也不需要自己先取消旧的默认，只管发 isDefault: true。

删除要二次确认（与 cart-list 的既有风格一致）。

导航入口两处：首页导航加「地址」、/account 页加「收货地址」。
没建全局 header——storefront 本来就没有，改 (shop)/layout.tsx 会影响
每一个页面的首屏渲染路径，而那正是主题注入的地方。"
```

---

## Task 4：主题改动后前台实时生效

**Files:**
- Modify: `storefront/src/lib/theme.ts`（导出 `CSS_VARS` / `GROUP_CSS_VARS` / `GROUP_KEYS`）
- Create: `storefront/src/app/api/theme/route.ts`
- Create: `storefront/src/components/theme/theme-watcher.tsx`
- Modify: `storefront/src/app/(shop)/layout.tsx`
- Create: `storefront/test/app/api/theme.test.ts`
- Create: `storefront/test/components/theme/theme-watcher.test.tsx`
- Create（可选）: `storefront/test/lib/tenant.test.ts`（若要给「租户解析」补一条真测，见 Step 4.1a）

> ⚠️ **后端不动。** `GET /public/theme` 已存在且是 `@Public()`
> （`api/src/modules/theme/public-theme.controller.ts` 第 12 行），
> 返回的 token 已经过 `ThemeService.sanitize` 过滤。

### 4.1 先写失败测试

**Step 4.1a: 中转路由的测试**

创建 `storefront/test/app/api/theme.test.ts`：

```ts
/**
 * 主题查询中转路由的测试。
 *
 * ⚠️ Route Handler 测试在 **node 环境**跑（不是 jsdom）——
 * 它用的是 Web 标准的 Request / Response，Node 18+ 原生支持。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server-cart', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server-cart')>(
    '@/lib/server-cart',
  );
  return {
    ...actual,
    currentSubdomain: vi.fn().mockResolvedValue('demo'),
    fetchBackend: vi.fn(),
  };
});

import { currentSubdomain, fetchBackend } from '@/lib/server-cart';

import { GET as themeGet } from '@/app/api/theme/route';

const subdomainMock = vi.mocked(currentSubdomain);
const fetchBackendMock = vi.mocked(fetchBackend);

beforeEach(() => {
  vi.clearAllMocks();
  subdomainMock.mockResolvedValue('demo');
});

describe('GET /api/theme', () => {
  it('带子域名去后端取主题', async () => {
    fetchBackendMock.mockResolvedValue({
      tokens: { colors: { primary: 'oklch(0.7 0.19 40)' } },
    });

    const response = await themeGet();
    const body = (await response.json()) as { tokens: unknown };

    expect(response.status).toBe(200);
    expect(body.tokens).toEqual({
      colors: { primary: 'oklch(0.7 0.19 40)' },
    });
    // ⚠️ 断言子域名确实带上了——匿名访客靠它定位租户
    expect(fetchBackendMock).toHaveBeenCalledWith('/public/theme', {
      subdomain: 'demo',
    });
  });

  it('后端出错时返回错误状态，不是 200', async () => {
    fetchBackendMock.mockRejectedValue(new Error('后端不可用'));

    const response = await themeGet();

    expect(response.status).not.toBe(200);
  });
});
```

> ⚠️ **⚠️ 这份测试里 `currentSubdomain` 被整个 mock 掉了，
> 所以「租户解析」的逻辑**根本没被测到**。
>
> 设计文档 §6.2 原先声称这一层有「+3 条（成功 / 后端 5xx / 租户解析）」，
> 但计划里只有 2 条。**两条路二选一**：
>
> | 方案 | 做法 | 后果 |
> |------|------|------|
> | **A** | 补一条**真测** `resolveTenantSubdomain` 的用例——新建 `storefront/test/lib/tenant.test.ts`，直接测 `storefront/src/lib/tenant.ts` 第 44–68 行的 `resolveTenantSubdomain`（`x-tenant-subdomain` 优先 / host 首段 / localhost 兜底） | 中转路由的测试仍是 2 条，但**多一个文件**。总数与文件数都要相应调整 |
> | **B** | 不补，把设计文档 §6.2 的「+3 条」改成「**+2 条**」 | 少一个文件。⚠️ 「租户解析」的解析逻辑就**没有**单测覆盖（它现在只被 `(shop)/layout.tsx` 间接用到） |
>
> **本计划采用 A**（多一个 `tenant.test.ts`，3 条用例），并在设计文档 §6.2
> 注明「要么补真测，要么改成 +2 条」。若实施时选 B，**记得同步改设计文档 §6.2**
> 与本 Task 的条数算式。

**Step 4.1b: `ThemeWatcher` 的组件测试**

创建 `storefront/test/components/theme/theme-watcher.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 护栏 10 / 11 / 12：主题轮询与客户端注入。
 *
 * ⚠️ 断言要具体：断言**写了哪个 CSS 变量、写的值是什么**，
 * 不是只断言「某个东西出现在 DOM 里」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { ThemeWatcher } from '@/components/theme/theme-watcher';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKENS = {
  colors: { primary: 'oklch(0.7 0.19 40)' },
  radius: '1.5rem',
  fontSans: 'var(--font-geist-sans)',
  fontMono: 'var(--font-geist-mono)',
  textScale: {},
  weights: {},
  spacing: {},
  shadows: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  // 每个用例前把行内样式清干净，别让上一个用例的残留影响断言
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThemeWatcher', () => {
  it('把主题的 CSS 变量写到 documentElement 的行内样式上', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ tokens: TOKENS })));

    render(<ThemeWatcher />);

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
    );
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('1.5rem');
  });

  it('只写白名单里的变量名（护栏 12）', async () => {
    // 后端万一漏过滤了一个未知的 token，客户端也不能把它写进去
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          tokens: {
            ...TOKENS,
            colors: { ...TOKENS.colors, 恶意键: 'x' },
          },
        }),
      ),
    );

    render(<ThemeWatcher />);

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
    );
    expect(document.documentElement.style.getPropertyValue('--恶意键')).toBe('');
    expect(document.documentElement.getAttribute('style')).not.toContain('恶意键');
  });

  it('拉取失败时不影响页面，也不清掉已有的主题（护栏 11）', async () => {
    // 先成功一次，主题写上去了
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tokens: TOKENS }))
      .mockResolvedValue(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ThemeWatcher />);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
    );

    // 再失败一次，主题应该还在
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
      'oklch(0.7 0.19 40)',
    );
  });

  it('组件卸载后不再轮询', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ tokens: TOKENS }));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<ThemeWatcher />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();
    const callsBefore = fetchMock.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('主题没变时不重写 DOM（护栏 10 的性能部分 / 失败注入 #13）', async () => {
    // ⚠️ 这是失败注入 #13 的挂点。
    // 若实现里没有变更检测（每次轮询都重写全部 CSS 变量），
    // 第二次拉取时 setProperty 还会被调用 → 这条用例会挂。
    //
    // 为什么要这条：轮询间隔 30 秒，每次都重写全部 CSS 变量
    // → 触发全页样式重算，与设计意图（§4.4.3 的「变更检测」行）相悖。
    const setPropertySpy = vi.spyOn(
      CSSStyleDeclaration.prototype,
      'setProperty',
    );

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ tokens: TOKENS }));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<ThemeWatcher intervalMs={20} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 第一次写入完之后，把计数归零
    setPropertySpy.mockClear();

    // 等到轮询至少跑过一次，主题内容**完全没变**
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    expect(setPropertySpy).not.toHaveBeenCalled();

    unmount();
    setPropertySpy.mockRestore();
  });
});
```

> **第 4 条用例的注意点**：它靠「卸载后不再有新的调用」来断言定时器被清理。
> 因为轮询间隔是 30 秒，这条用例**等 30 秒不现实**——
> 所以实现里要**允许注入轮询间隔**（`intervalMs` prop，默认 30000），
> 测试传一个小值（如 20 毫秒）。
>
> 这是**为了可测而加的一个 prop**，不是前瞻性设计——
> 组件只有一个使用方（`(shop)/layout.tsx`），默认值就是生产值。

**Step 4.2: 跑测试确认失败**

```bash
cd storefront && npx vitest run test/app/api/theme.test.ts test/components/theme/theme-watcher.test.tsx
```

预期：FAIL —— 找不到 `@/app/api/theme/route` 与 `@/components/theme/theme-watcher`。

### 4.3 写实现

**Step 4.3a: 导出 `CSS_VARS` / `GROUP_CSS_VARS` / `GROUP_KEYS`**

`storefront/src/lib/theme.ts` 里三张表都要导出：

| 行 | 现在 | 改成 |
|----|------|------|
| 第 25 行 | `const CSS_VARS: Record<string, string[]> = {` | `export const CSS_VARS: ...` |
| 第 50 行 | `const GROUP_CSS_VARS: Record<string, string> = {` | `export const GROUP_CSS_VARS: ...` |
| 第 69 行 | `const GROUP_KEYS: Record<string, ReadonlySet<string>> = {` | `export const GROUP_KEYS: ...` |

`CSS_VARS` 的改法（另两张表同理）：

```ts
/**
 * 与后端 theme-tokens.ts 一一对应的 CSS 变量名。
 *
 * ⚠️ **导出**是为了让客户端的 ThemeWatcher 用同一份映射
 * （components/theme/theme-watcher.tsx）——客户端与服务端各写一份
 * 映射表，迟早会漂移：服务端加了新 token 而客户端没加，
 * 那个 token 在客户端就永远不生效。
 *
 * 这是**纯模块**，没有 'use client'——两端都能 import。
 * ⚠️ **不要给它加 'use client'**：加了会让 Server Component 那边
 * 多一层客户端边界。
 */
export const CSS_VARS: Record<string, string[]> = {
```

**Step 4.3b: 写中转路由**

新建 `storefront/src/app/api/theme/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/route-helpers';
import { currentSubdomain, fetchBackend } from '@/lib/server-cart';
import type { ThemeTokenValues } from '@/lib/theme';

interface ThemeResponse {
  tokens: ThemeTokenValues;
}

/**
 * 主题查询的中转（给客户端的 ThemeWatcher 用）。
 *
 * ⚠️ 为什么要专门开一个中转而不是让浏览器直连后端：
 *    后端没开 CORS（设计上前端与 API 同源，由 Nginx 反代），
 *    浏览器直连会变成 Failed to fetch，且不带任何后端错误信息。
 *    同一个理由见 src/app/api/stores/me/route.ts 的说明。
 *
 * ⚠️ **租户从请求头解析**：匿名访客靠子域名定位租户，
 *    主题是租户级的——服务端才有这个上下文。
 *
 * ⚠️ **不缓存**：轮询本身已经是低频（30 秒），再加缓存就要处理失效，
 *    那会把复杂度推回「缓存失效广播」的老路。
 *
 * ⚠️ **响应头显式带 `cache-control: no-store`**：主题是最该实时的一类数据。
 *    不写的话，将来有人给 nginx 加 `proxy_cache` 就会出问题
 *    （缓存住的主题会一直生效，直到缓存过期）。
 */
export async function GET() {
  const subdomain = await currentSubdomain();

  try {
    const result = await fetchBackend<ThemeResponse>('/public/theme', {
      subdomain,
    });
    return NextResponse.json(result, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

> ⚠️ **路由模块只导出 HTTP 方法**——不要多导出一个 helper 函数，
> 否则 `next build` 会报「not a valid Route export field」
> （阶段 3 验收 §三 的第三个 bug）。

**Step 4.3c: 写 `ThemeWatcher`**

新建 `storefront/src/components/theme/theme-watcher.tsx`：

```tsx
'use client';

import { useEffect } from 'react';
import {
  CSS_VARS,
  GROUP_CSS_VARS,
  GROUP_KEYS,
  type ThemeTokenValues,
} from '@/lib/theme';

/** 轮询间隔（毫秒）。默认 30 秒。 */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 主题实时生效的客户端组件。
 *
 * ## 为什么需要它
 *
 * 服务端**已经是请求期拉取**（`(shop)/layout.tsx` 第 23 行的
 * `force-dynamic` + 第 35–38 行每次请求调 `/public/theme`），
 * 但 `<style>` 标签**只在服务端渲染时注入**——
 * 页面不刷新就不会重新请求，也就不会重新注入，所以看不到新主题。
 *
 * 所以这里补上「客户端的二次拉取与重注入」。
 *
 * ## 为什么用轮询而不是推送
 *
 * - **多副本正确性**：storefront 在 Nginx 后面
 *   （`infra/nginx/platform.test.conf` 第 9–11 行的 upstream），
 *   将来扩副本时，「服务端缓存 + 失效广播」与 SSE 都需要跨副本同步状态，
 *   而轮询**是���状态的**——每个副本的客户端各自查各自的后端，
 *   后端查库拿到的永远是最新值。
 * - **不引入新基础设施**：推送方案要长连接 + 发布订阅；
 *   失效方案要共享缓存层 + 内部鉴权端点。轮询只要一个 HTTP 请求。
 *
 * ## 为什么用 setProperty 而不是重建 <style>
 *
 * 服务端注入的是 `:root { --primary: ... }`（layout.tsx 第 51 行）。
 * CSS 的**行内样式优先级高于任何样式表规则**，所以
 * `documentElement.style.setProperty('--primary', v)` 会**覆盖** `:root`
 * 里的同名变量，而其它没被覆盖的变量继续走 `:root`——
 * 这正是「增量更新」想要的语义，且不需要删掉服务端那份。
 */
export function ThemeWatcher({ intervalMs = DEFAULT_INTERVAL_MS }: { intervalMs?: number }) {
  useEffect(() => {
    let cancelled = false;

    /** 拉一次主题并写进 CSS 变量 */
    async function refresh() {
      try {
        const response = await fetch('/api/theme', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as { tokens?: ThemeTokenValues };
        if (!payload.tokens) return;
        if (cancelled) return;
        applyTokens(payload.tokens);
      } catch {
        // 拉不到主题不影响页面：服务端注入的那份还在，
        // 用户看到的仍是最后一次成功的主题。**静默失败**。
      }
    }

    const timer = setInterval(refresh, intervalMs);

    // 切回前台时立即查一次——后台标签页的定时器会被浏览器节流，
    // 用户切回来时立刻拿到最新主题，感知延迟 < 1 秒。
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 首次也查一次——服务端注入的那份可能是几秒前的
    void refresh();

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs]);

  return null;
}

/**
 * 把 token 写进 documentElement 的行内样式。
 *
 * ⚠️ **只写 CSS_VARS 里认识的名字**（护栏 12）。
 * 后端已经过滤过一次（ThemeService.sanitize），但客户端这条路是新开的，
 * 再收一道白名单——`setProperty` 的键名非法时 CSSOM 会忽略它，
 * 但白名单是更明确、更可测的防线。
 */
function applyTokens(tokens: ThemeTokenValues) {
  const style = document.documentElement.style;

  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    style.setProperty(vars[0], value);
  }

  for (const key of ['radius', 'fontSans', 'fontMono'] as const) {
    const value = tokens[key];
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    style.setProperty(vars[0], value);
  }

  // 分组标量：键名是「前缀 + 键」拼出来的
  for (const [group, prefix] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    const allowed = GROUP_KEYS[group];
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      // 键必须在白名单内，否则可从键名逃出 CSS 声明
      if (!allowed.has(key)) continue;
      style.setProperty(`${prefix}${key}`, value);
    }
  }
}
```

##### 变更检测（A5 —— 必须有，否则失败注入 #13 没有东西可改）

**加在 `applyTokens` 的入口**，用一个**模块级**变量记住上次写入的内容：

```ts
/**
 * 上一次写入 DOM 的主题内容的序列化结果。
 *
 * ⚠️ **变更检测**（设计文档 §4.4.3 的「变更检测」行）：
 * 轮询间隔 30 秒，若每次都重写全部 CSS 变量，就会**每次轮询都触发
 * 全页样式重算**——与「主题没变就不动 DOM」的设计意图相悖。
 *
 * 用序列化后的字符串比较（而不是逐字段深比较）——序列化一次、比较一次，
 * 成本远低于一次深比较，且对「键的顺序变化」也免疫
 * （JSON.stringify 对同样的键序敏感，但后端返回的对象键序是稳定的；
 * 若要完全免疫，先对 keys 排序）。
 */
let lastApplied: string | null = null;

/** 把 token 序列化成一个可比较的字符串 */
function serializeTokens(tokens: ThemeTokenValues): string {
  return JSON.stringify({
    colors: tokens.colors ?? {},
    radius: tokens.radius,
    fontSans: tokens.fontSans,
    fontMono: tokens.fontMono,
    textScale: tokens.textScale ?? {},
    weights: tokens.weights ?? {},
    spacing: tokens.spacing ?? {},
    shadows: tokens.shadows ?? {},
  });
}
```

`applyTokens` 改成：

```ts
function applyTokens(tokens: ThemeTokenValues) {
  // ⚠️ 变更检测：主题没变就不动 DOM（失败注入 #13 的挂点）。
  const serialized = serializeTokens(tokens);
  if (serialized === lastApplied) return;
  lastApplied = serialized;

  const style = document.documentElement.style;
  // ...（原来的写入逻辑不变）
}
```

> ⚠️ **`lastApplied` 是模块级变量**，组件卸载后不清空——
> 这是**对的**：新挂载的组件第一次拉取时，如果主题与上次相同，
> 就**不需要**重写 DOM（服务端注入的那份还在，或上次的行内样式还在）。
>
> ⚠️ **但要注意测试的隔离**：`theme-watcher.test.tsx` 的
> 「主题没变时不重写 DOM」用例依赖模块级状态的初始值。
> 实施时若发现该用例因为「上一个用例已经写过同一个主题」而不稳定，
> 在测试文件里加一句 `vi.resetModules()` + 动态 import，
> 或让 `applyTokens` 导出一个仅供测试用的重置函数。

> ⚠️ **分组标量（textScale / weights / spacing / shadows）要一起写。**
> 它们的键名是「前缀 + 键」拼出来的（`--text-` + key），
> 所以要同时用 `GROUP_CSS_VARS`（前缀表）与 `GROUP_KEYS`（键名白名单表）——
> Step 4.3a 已经把这两张表一起导出了。
>
> ⚠️ **但「必须写全」的原始理由不成立**（设计文档 §4.4.3 与 N4）：
> `storefront/src/app/globals.css` 第 7–49 行的 `@theme inline` 块
> **只映射 colors / radius / fonts**——
> `--text-*` / `--spacing-*` / `--shadow-*` / `--font-weight-*`
> **在前台没有任何消费者**（全仓 grep 确认）。写与不写，视觉完全一样。
>
> **那为什么还要写？** 理由降级为「**写了无害但也无用**」：
> 客户端保留写入以**对齐服务端行为**（`buildThemeCss` 会写全部 token），
> 成本为零（一次循环），将来 CSS 侧接上消费者时**不需要再改客户端**。
> **真正的产品级发现是另一件事**——商家可编辑的分组标量在前台没有消费者，
> 记为设计文档 §七 遗留项 11。

**Step 4.3d: 挂上 `ThemeWatcher`**

`storefront/src/app/(shop)/layout.tsx` 第 54 行 `{children}` 之前加：

```tsx
import { ThemeWatcher } from '@/components/theme/theme-watcher';

// ... 在 return 里：
    <>
      {css ? (
        <style
          dangerouslySetInnerHTML={{ __html: `:root {\n${css}\n}` }}
        />
      ) : null}
      <ThemeWatcher />
      {children}
    </>
```

> **放在 `<style>` 之后、`{children}` 之前**：`ThemeWatcher` 渲染 `null`，
> 不占布局位置；位置只影响客户端注入的**时机**（effect 在挂载后跑）。

**Step 4.4: 跑测试与验证**

**Step 4.4a: 自动化**

```bash
cd storefront && npm test && npm run lint && npm run build
```

预期：**89 + 6 = 95 passed**，**11 个文件**。

**算式**：Task 3 结束时 89 条 / 9 个文件
+ `theme.test.ts` 2 条（1 个文件）
+ `theme-watcher.test.tsx` 5 条（1 个文件，含新增的「主题没变时不重写 DOM」）
= **95 条 / 11 个文件**。

> ⚠️ 若按 Step 4.1a 的方案 A 补了 `tenant.test.ts`（3 条），
> 则是 **89 + 2 + 5 + 3 = 99 条 / 12 个文件**。以实际写的用例数为准，
> 但**增量必须等于新增的用例数**。
>
> ⚠️ **`npm run build` 特别重要**：`(shop)/layout.tsx` 是 Server Component，
> 往里加一个客户端组件会改 RSC 边界。构建期会检查这一点——
> 但**有些错误构建期抓不到**（阶段 2b 的「传函数给客户端组件」就是
> 构建期过得去、渲染时才 500）。所以手测不能省。

**Step 4.4b: 浏览器手测**

| # | 场景 | 预期 |
|---|------|------|
| 1 | 商家后台改主色为 `oklch(0.7 0.19 40)` → 保存 | 提示「已保存」 |
| 2 | **不刷新** storefront，切到 storefront 标签页 | **几秒内**变色（`visibilitychange` 触发） |
| 3 | storefront 页面**一直开着不动** | **30 秒内**变色（轮询触发） |
| 4 | storefront 页面刷新 | 立刻是新的主题（服务端注入那条路径本来就通） |
| 5 | 改圆角为 `1.5rem` | `--radius` 变成 `1.5rem` |
| 6 | 停掉 api，刷新 storefront | 页面仍能渲染（主题拉不到不白屏） |
| 7 | 两个 storefront 标签页 | 两个都变（每个标签页各自轮询） |
| 8 | **字体 token**（L21 的核对项） | 控制台执行 `getComputedStyle(document.documentElement).getPropertyValue('--font-sans')`，与**实际渲染字体**对照。⚠️ **很可能会不一致**——`--font-geist-sans` 只在 `next/font` 的变量作用域里存在（`src/app/layout.tsx` 第 6 行，挂在 `<body>` 的 class 上），在非 root 元素上引用会失效。若不一致，把 `fontSans` / `fontMono` **排除出客户端注入范围**，并在验收记录里写明 |

**核对命令**（浏览器控制台）：

```js
getComputedStyle(document.documentElement).getPropertyValue('--primary')
```

> ⚠️ **场景 5 的分组标量不在这条手测里**——
> 分组标量（字阶 / 间距 / 阴影）在前台**没有消费者**
> （设计文档 §4.4.3 与 §七 遗留项 11），
> 改了它们前台**看不出变化**，这是**已知的产品缺陷**，不是本阶段的 bug。
> 手测时不要因为「改了没反应」而判定失败。

**Step 4.4c: 提交**

```bash
git add storefront/
git commit -m "feat(storefront): 主题改动后前台实时生效

现状：服务端**已经是请求期拉取**（(shop)/layout.tsx 的 force-dynamic +
每次请求调 /public/theme），但 <style> 标签只在服务端渲染时注入——
页面不刷新就不会重新请求，也就看不到新主题。

所以缺的不是「更快的服务端缓存」，而是「客户端的二次拉取与重注入」。
加一个 ThemeWatcher 客户端组件：30 秒轮询 + 切回前台时立即查一次，
用 documentElement.style.setProperty 把 CSS 变量写进行内样式。

用 setProperty 而不是重建 <style> 标签：行内样式的优先级高于任何样式表
规则，会覆盖服务端注入的 :root 里的同名变量，而其它变量继续走 :root——
正好是增量更新要的语义，且不用删掉服务端那份。

**为什么是轮询而不是推送**：
- 多副本正确性。storefront 在 Nginx 后面（upstream storefront_backend），
  「服务端缓存 + 失效广播」与 SSE 都要跨副本同步状态；轮询是无状态的——
  每个副本的客户端各自查各自的后端，后端查库拿到的永远是最新值。
- 不引入新基础设施。推送要长连接 + 发布订阅；失效要共享缓存层 + 内部端点。

生效延迟：前台可见时 ≤ 30 秒；切回标签页时 < 1 秒（visibilitychange 触发）。
不保证「保存后 1 秒内全站生效」——那是另一个量级的工程量。

主题的 CSS 变量映射复用 lib/theme.ts 的 CSS_VARS（导出它），
不另写一份——服务端加了新 token 而客户端没加，那个 token 就永远不生效。
客户端再收一道白名单：后端已经 sanitize 过一次，但客户端这条路是新开的。

新增 /api/theme 中转（浏览器不能直连后端，没有 CORS）。租户从请求头解析——
匿名访客靠子域名定位租户。不缓存：轮询已经低频，加缓存就要处理失效。"
```

---

## Task 5：阶段 4 验收

**Files:**
- Create: `docs/superpowers/plans/2026-10-25-plan-04-acceptance.md`
- Modify: `README.md`

### 5.1 自动化测试结果

照阶段 3 验收记录 §一 的表格：

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 前端单测（storefront） | `cd storefront && npm test` | 全部通过 | 填 |
| 前端单测（merchant-admin） | `cd merchant-admin && npm test` | 全部通过 | 填 |
| storefront lint | `cd storefront && npm run lint` | 0 error | 填 |
| merchant-admin lint | `cd merchant-admin && npm run lint` | 0 error | 填 |
| storefront build | `cd storefront && npm run build` | 成功 | 填 |
| merchant-admin build | `cd merchant-admin && npm run build` | 成功 | 填 |
| 后端单元测试 | `cd api && npm test` | 全部通过 | 填（**本阶段不应有任何变化**） |
| 后端 e2e | `cd api && npm run test:e2e` | 全部通过 | 填 |

> ⚠️ **跑 e2e 前必须先 `docker compose stop api`**——验收记录 §一 的环境坑：
> 容器里的 worker 会抢同一个 Redis 队列上的任务，导致假失败。
>
> ⚠️ **后端一行没改**，后端测试的数字应该与阶段 3 验收时**完全一致**
> （102 / 282）。**数字变了要查清楚**——可能是环境残留，不是本阶段的改动。

### 5.2 失败注入（护栏逐项）

**12 项护栏逐项做**（设计文档 §六.1）。做法照阶段 3 的验收记录 §四：

1. 改坏一处护栏
2. 跑对应测试，**确认它真的失败**
3. 改回来
4. 复跑确认通过

**判断变异是否生效前，先确认代码真的被改坏了**——把字段名改成不存在的名字
是可靠探针。**编译错误不算「抓到」。**

失败注入的具体清单见设计文档 §六.3（13 条）。

> ⚠️ **账目要分清**：**12 项护栏**与**13 条失败注入**不是一一对应。
> - **#12**（`ThemeWatcher` 的 `clearInterval` 删掉）**不在 12 项护栏里**
>   ——它靠代码审查 + 手测，**不计入 12 项护栏的自动化验证**。
>   验收记录里要单独列，别混进护栏账目。
> - **#1** 的注入形态是「**把某个组件测试文件里的
>   `// @vitest-environment jsdom` 注释删掉**」，
>   **不是**「把全局 `environment` 改成 `node`」——
>   逐文件注释**优先于全局配置**，后者不会生效（实测确认）。
> - **#10 / #11** 挂在 `address-book.test.tsx` 上（Step 3.3c-bis），
>   **#13** 挂在 `theme-watcher.test.tsx` 的「主题没变时不重写 DOM」上
>   （Step 4.1b）。

### 5.3 浏览器手测

照设计文档 §六.4 的 **10 条场景**（第 2 条是 L20 的「先后」竞态，
第 10 条是 L21 的字体 token 核对）。

**环境注意**（阶段 2b 栽过两次）：
- storefront 本地 dev **3011**、merchant-admin **3016**，启动前 `rm -rf .next`
- **不要在 3001–3003 的旧容器上测**
- merchant-admin 的令牌过期手测需要改 `JWT_EXPIRES_IN`（如 45 秒），
  **改完记得改回来**

### 5.4 写验收记录

`docs/superpowers/plans/2026-10-25-plan-04-acceptance.md`，结构照
`2026-10-24-plan-03-acceptance.md`：

1. 自动化测试结果
2. 组件测试基建专章（**新增**——本阶段的核心交付物，
   要写清楚「基建长什么样、示范测试断言了什么、失败注入抓到了什么」）
3. 手动验收场景（**填实测看到的东西**，不写「正常」）
4. **机制级验证（失败注入）表** —— 12 项护栏逐项
5. 交付物清单
6. **已知遗留项**（诚实列出没测到的、没覆盖的）
7. 下一阶段

### 5.5 更新 README 与记忆

- README 的「当前进度」与「后续计划」
- 记忆里 `project_plan02_execution.md` 更新进度与新踩的坑

**Step 5.6: 提交**

```bash
git add docs/ README.md
git commit -m "docs: 阶段 4 前端补齐与打磨验收记录与收尾"
```

---

## 附：Task 与护栏的对应表

| Task | 覆盖的护栏编号 | 风险出处见 §0.6 对照表 |
|------|--------------|---------------------|
| 1 | 1, 2 | §5.2 L4 / L5 / L6 / L7 |
| 2 | 3, 4, 5, 6 | §5.1 **L1 / L2 / L18 / L19**（可被利用的漏洞）、§5.2 L8 / L15 |
| 3 | 7, 8, 9 | §5.2 L9 / L10 / L11 / L17 |
| 4 | 10, 11, 12 | §5.1 **L3**（可被利用的漏洞）、§5.2 L12 / L13 / L21 |
| 5 | 全部 12 项复验 | |

### 附：Task 之间的依赖

```
Task 1（组件测试基建）
   │
   ├──► Task 3（地址簿页的组件测试需要 jsdom）
   │
   └──► Task 4（ThemeWatcher 的组件测试需要 jsdom）

Task 2（merchant-admin 令牌刷新）—— 独立，不依赖 Task 1
```

> **Task 1 必须先做**——Task 3 与 Task 4 的组件测试都要用到 jsdom 基建。
> **Task 2 可以并行**——它不碰组件测试，只加纯函数与一个可测的模块。

### 附：本阶段刻意不做的事

| # | 不做 | 理由 |
|---|------|------|
| 1 | 真实浏览器的 E2E（Playwright） | 设计文档 §一.2 |
| 2 | monorepo / 共享包 | 设计文档 §4.2.1 |
| 3 | 改后端任何一行 | 四个子项都不需要新端点 |
| 4 | merchant-admin 的组件测试 | 设计文档 §七 遗留项 5 |
| 5 | 地址簿页的商家侧版本 | 商家发货用的是订单里的收货快照，不需要地址簿 |
| 6 | 购物车金额改服务端实时价 | **阶段 3 遗留项 4 已经由阶段 3 实现**——`api/src/modules/cart/cart.service.ts` 第 411–417 行的 `read()` 里 `include: { sku: { select: { id, price, product } } }`，**购物车接口返回的就是服务端当前价**；前端 `storefront/src/lib/cart.ts` 第 165 行的 `itemSubtotal` 用的就是 `item.sku?.price`。**本阶段无需任何改动** |
| 7 | 主题的服务端缓存 | 设计文档 §七 遗留项 3 |
| 8 | **商家后台的主题实时预览**（设计文档 §一 子项 4a） | 设计文档 §七 遗留项 10。**这是验收 §六 遗留项 2 的原文**——本阶段只解决了它的另一半（前台访客的实时生效） |
| 9 | **分组标量在前台的接线**（让字阶 / 间距 / 阴影真正生效） | 设计文档 §七 遗留项 11。客户端**保留写入**这四组变量（对齐服务端行为，成本为零） |
| 10 | **多标签页「先后」刷新竞态的后端修复** | 需要后端配合（宽限期或幂等刷新端点）。设计文档 §5.2 的 L20 / §七 遗留项 13 |
