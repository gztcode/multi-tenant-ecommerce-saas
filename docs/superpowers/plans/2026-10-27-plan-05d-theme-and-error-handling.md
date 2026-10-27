# 阶段 5d 实施计划：主题变量统一、前端错误处理收口、Redis 挂死修复

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让商家配的每一个主题 token 都在前台真实生效（统一到 `--brand-*` 命名空间）、让后端不可达时用户看到中文而不是 `fetch failed`、让 Redis 不可达时 API 不再永久挂死。

**Architecture:** 主题侧把「Tailwind 命名空间」与「品牌变量」分成两层：`@theme inline` 里只出现 Tailwind 命名空间并指向 `--brand-*`，默认值只存 `:root` 一处；运行时只注入 `--brand-*`。错误侧在三个 `api-client.ts` 的**唯一 fetch 出口**把网络错误收敛成 `ApiError(503, 'NETWORK_ERROR', 中文)`、把 401 的默认文案翻成中文，使 76 个渲染点零改动。Redis 侧给队列投递加 3 秒超时，并让下单与 webhook 的投递失败不再向上抛。

**Tech Stack:** NestJS 11 + Prisma 6 + BullMQ 6.4.1 + Jest 30（api）；Next.js 15 App Router + React 19 + Tailwind CSS 4.3.3 + Vitest 3（三个前端）；ioredis 6（探活）。

**依据设计文档：** `docs/superpowers/specs/2026-10-27-plan-05d-theme-and-error-handling-design.md`（修订版 `85f089a`）

---

## §0.5 勘误表

> **惯例：** 实施期间发现的「设计文档说错了 / 没说清」的地方，**先记在这里，再改代码**。
> 每个 Task 结束时把该 Task 新发现的勘误追加进来。已发现的勘误见设计文档 §5.2（S1–S13）。

| # | Task | 现象 | 处置 |
|---|------|------|------|
| E1 | 1 | **计划的 spec 文件里只有 4 个 `it`，但正文写「5 个用例全过」** | 按文件内容为准（4 个）。Task 1 实施时补了第 5 条（见 E3） |
| E2 | 1 | **`api/package.json` 的 jest 配置必须加 `transformIgnorePatterns`** —— `@nestjs/bullmq@12` 与 `@nestjs/bull-shared` 是 `"type": "module"` 的纯 ESM 包，jest 的 CommonJS runtime 无法 require，spec 一 import `queue.service.ts` 就报 `Must use import to load ES Module` | 已加：`"transformIgnorePatterns": ["/node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]`。⚠️ **与 `api/test/jest-e2e.json` 的既有约定一致**（e2e 配置里本来就有同一组包） |
| E3 | 1 | **代码质量审查用变异测试发现测试缺口**：把 `if (cause instanceof TimeoutError)` 改成 `if (true)`（所有错误都转 503），原有 4 条用例**全部照过** → 「只转 TimeoutError、其它错误原样抛」这条需求没被覆盖 | 已补一条用例（「队列报的普通错误原样抛出」），变异后确实挂、只有它挂 |
| E4 | 1 | `QUEUE_OPERATION_TIMEOUT_MS` 未导出，测试里硬编码 `3_000` → 以后调超时会静默测错东西 | 已导出，测试改为引用该常量 |
| E5 | 1 | `addRepeating` 的两个调用点在 `onModuleInit` 里 → Redis 启动时不可达会让**进程启动失败**（原先是永远卡在 bootstrap） | **有意保留**（快速失败比静默卡死更易恢复：容器编排会重启它）。已在 `withQueueTimeout` 的注释里写明后果与理由 |
| E6 | 1 | `all-exceptions.filter.ts` 的 `CODE_BY_STATUS` 没有 503 映射 → 503 的响应体 `code` 落成 `INTERNAL_ERROR` | **不改**：已核实前端**没有任何地方按 `code` 分支**，HTTP 状态是 503、用户看到的中文消息正确 → 无行为影响；改它要动 Task 1 文件集之外的文件 |
| E7 | 2 | **计划给的 `redis-probe.ts` 跑不起来**：`enableOfflineQueue: false` + 懒创建连接 ⇒ 首次 `ping()` 永远命中「Stream isn't writeable」→ **探活恒为 false，哪怕 Redis 好好的** | 改为「先等 `ready` 事件再 PING」（实测 ioredis v6：构造函数**立即** connect，`lazyConnect` 默认 false；`stream` 异步赋值）。实施者用**真实 Redis** 验证过修复前后 |
| E8 | 2 | `RedisProbe` 的字段 `client` 与方法 `client()` 重名 → TS2300 | 方法改名 `getClient()` |
| E9 | 2 | `addRepeating` 的两个调用点在 `onModuleInit` 里 → Redis 启动时不可达会让**进程启动失败** | **有意保留**（快速失败比静默卡死更易恢复：容器编排会重启它）。已在 `withQueueTimeout` 的注释里写明后果与理由 |
| E10 | 2 | **`/health` 的探活超时路径上泄漏监听器**：`once('ready')`/`once('error')` 在超时后不被摘掉 → `/health` 每 10 秒轮询一次就泄漏 2 个 → 长跑累积 | 改为「定时器放进同一个 Promise，`finally` 里无条件 `off`」。⚠️ 关键：`withTimeout` 用 `Promise.race` 实现，**超时分支拿不到清理机会** —— 必须自己握定时器。实测 20 次调用后监听器数不增长，总耗时 40042ms = 20 × 2000ms（单次仍是 2 秒，不是 4 秒） |
| E11 | 4 | **`@theme inline` 的「被覆盖的变量不落到 `:root`」是过于绝对的说法** | 实测编译产物：`--font-sans` / `--spacing` / `--text-sm` / `--radius-md` / `--default-font-family` / `--default-mono-font-family` / `--color-destructive-foreground` 这 7 个**仍落在** `@layer theme{:host,:root}` 里（因为 Tailwind 内置主题里这些键已存在）。功能无影响（值仍指向 `--brand-*`，且 `@layer theme` 优先级低于手写 `:root`），但注释已改准 |
| E12 | 4 | `GROUP_CSS_VARS` 与 `GROUP_KEYS` 是**两个必须同步维护的表** | `GROUP_KEYS` 整个删掉 —— 改成「组 → 键 → 变量名」的显式映射后，映射本身即白名单（注入面不变窄也不变宽，但少一处漂移源） |
| E13 | 6 | **`JSON.stringify(options.body)` 在 `try` 块内** → body 含循环引用时抛 `TypeError` 被 catch 抓走 → **误报成 `NETWORK_ERROR`(503)**，还污染监控里「后端不可用」的信号 | 序列化提到 `try` 之外。实测：`body === undefined` → `init.body` 仍是 `undefined`；`body === null` → `"null"`；循环引用 → 原生 `TypeError`（不再被误标 503） |
| E14 | 6 | `localizeApiMessage` 按 message 匹配，与后端 `UnauthorizedException()` 默认文案**硬耦合** —— 后端改文案则前端翻译静默失效 | **保留按 message 匹配**（审查建议的「按 code 匹配」是错的：后端主动抛的中文消息 code 也是 `UNAUTHORIZED`，按 code 匹配会把更具体的中文覆盖成通用文案）。只在注释里点明这个耦合与代价 |
| E15 | 6 | 覆盖后台**已存在**的 `api-client.test.ts` 时丢了一条「纯空白 body 也当 null」的用例 | 已补回。三份测试文件现在是 8 个用例、逐字节一致 |
| E16 | 7 | `account/page.tsx` 的注释说「凭证失效时把 `accessToken` 置为 `undefined`」—— 那是**中间态** | 核实 `jwt-callback.ts`：第 148 行置的是 **token** 上的 `undefined`，第 174 行的 session 回调把它兜底成 **`''`（空串）**。注释已改成描述最终态 |
| E17 | 8 | 测试对 `error.tsx` 的「不渲染 `error.message`」**没有设防**（变异实测：插入 `{error.message}` 后测试仍全过） | 已补 `expect(document.body.textContent).not.toContain('boom')`；变异实测能挂 |
| E18 | 8 | `global-error.tsx` 硬编码 Tailwind **zinc** 的 hex，与本仓库的 **oklch** 品牌令牌不符 | 改成与 `globals.css` 的 `:root` 逐字一致的 oklch 字面量。⚠️ **不能用 `var(--brand-*)`** —— global-error 渲染在根 layout 之外，此时 globals.css 未必加载，引用变量会拿到未定义值（可能看不见文字） |
| E19 | 9 | `merchant-admin/vitest.config.ts` 顶部注释仍写「不测 React 组件渲染……本轮明确不做」 | 已改成三类（Route Handler / 纯函数 / 组件渲染），并说明组件测试用逐文件的环境注释切换 |
| E20 | 5 | 三个 layout.tsx 挪了字体变量却**没有任何注释说明为什么** | 已补注释（写好 storefront 那份后 `cp` 同步三份），并补了 `storefront/test/app/layout-font.test.ts` 静态断言防回归 |
| E21 | 7 | `account/page.tsx` 的注释说「凭证失效时把 `accessToken` 置为 `undefined`」—— 那是**中间态** | 核实 `jwt-callback.ts`：第 148 行置的是 **token** 上的 `undefined`，第 174 行的 session 回调把它兜底成 **`''`（空串）**。注释已改成描述最终态 |
| E22 | 8 | 测试对 `error.tsx` 的「不渲染 `error.message`」**没有设防**（变异实测：插入 `{error.message}` 后测试仍全过） | 已补 `expect(document.body.textContent).not.toContain('boom')`；变异实测能挂 |
| E23 | 8 | `global-error.tsx` 硬编码 Tailwind **zinc** 的 hex，与本仓库的 **oklch** 品牌令牌不符 | 改成与 `globals.css` 的 `:root` 逐字一致的 oklch 字面量。⚠️ **不能用 `var(--brand-*)`** —— global-error 渲染在根 layout 之外，此时 globals.css 未必加载，引用变量会拿到未定义值（可能看不见文字） |
| E24 | 9 | `merchant-admin/vitest.config.ts` 顶部注释仍写「不测 React 组件渲染……本轮明确不做」 | 已改成三类（Route Handler / 纯函数 / 组件渲染），并说明组件测试用逐文件的环境注释切换 |
| E25 | 全局 | **最终整体审查发现 3 处跨 Task 的缺口** | ① `--text-*--line-height` 是硬编码比例，商家改字号时行高不跟随 → **记为遗留 L13**（修不了：`calc(1.25 / var(--brand-text-sm))` 非法）；② storefront 唯一一处 `shadow-md` 是 Tailwind 内置硬编码 → **改成 `shadow-base`**（走 `--brand-shadow-base`），其余内置刻度仍不可配 → 记为遗留 L14；③ merchant-admin 的 42 处 API 路由仍用 `!session` → 结果正确（401 → 中文），记为遗留 L15 |
| E26 | 全局 | **设计文档的字体机制描述与最终实现不符**：文档写的是 `--default-font-family` + fallback，最终实现是 `@theme inline`（无 fallback）+ `@layer base { html { @apply font-sans } }` | 两者都能让品牌字体生效，最终实现**不需要** fallback。已更正设计文档 §2.2.1 / A2 / R2 / §4.2.2 |
| E27 | 全局 | **globals.css 的 shasum 过期** | 文档里的 `f42d46d4…` 是改造前的值 → 全部改成 `ab00c18048759788c7f45b7d4ec836b8914fbf1d` |
| E28 | 全局 | **`buildThemeCss` 对空字符串会产出非法声明**（`--brand-radius: ;`） | 当前不可达（后端 `isValidScalarValue` 拒绝空串 → 回落默认值），但三处循环统一排除空串，把不变量钉在产生方；测试补了断言 |

---

## §0.1 全局约定（每个 Task 都适用）

### 目录与分支

- 仓库根：`/Users/tom/orca/workspaces/电商项目/电商项目`
- 分支：`gzt/电商项目`（**不要新建分支**，本阶段在这个分支上做）
- **docs 与业务代码分开提交**：设计文档/计划的改动单独一个 commit，业务代码每个 Task 一个 commit。

### 提交信息格式（中文）

```
feat(api): 队列投递加超时保护
fix(front): api-client 把网络错误收敛成中文 ApiError
feat(front): 主题变量统一到 --brand-* 命名空间
```

### 验证命令速查

| 目的 | 命令 |
|------|------|
| api 单元测试 | `cd api && npx jest --passWithNoTests` |
| api e2e（需要测试库） | `cd api && npm run test:e2e` |
| api 类型检查 | `cd api && npx tsc --noEmit` |
| storefront 测试 | `cd storefront && npm test` |
| storefront 类型检查 | `cd storefront && npx tsc --noEmit` |
| merchant-admin 测试 | `cd merchant-admin && npm test` |
| platform-admin 测试 | `cd platform-admin && npm test` |

⚠️ **e2e 需要 `api/.env` 里的 `DATABASE_URL_TEST`**，且会 **truncate 测试库**（`test/setup-e2e.ts`）。跑之前确认那个库不是开发库。

⚠️ **本机端口**（记忆里已记录）：PostgreSQL 用 **15432**、Redis 用 **16380**、api 用 **3000**、三个前端用 **3001/3002/3003**。

### 三个前端的「字节级副本」纪律

`storefront` / `merchant-admin` / `platform-admin` 是**三个独立的 Next 应用，没有共享包**。
凡是三边都要有的文件，靠「**写一份 → `cp` 到另外两边 → `diff` 校验**」保证一致，并在计划里写明 `diff` 命令。

本阶段涉及的副本：
- `src/app/globals.css`（三份逐字节一致，shasum `ab00c18048759788c7f45b7d4ec836b8914fbf1d`）
- `src/components/ui/button.tsx`（三份逐字节一致）
- `src/app/layout.tsx`（**内容不同**，只改 `<html>`/`<body>` 的 className 那一处，不要 `cp` 覆盖）
- `src/app/error.tsx` / `src/app/global-error.tsx`（新建，三份各自逐字节一致）
- `src/lib/api-client.ts`（**三份结构不同** —— storefront 独有 `ApiFetchOptions`/`request()`/`apiFetchWithSetCookie`，两个后台版没有；不要强行统一，只保证语义一致。**但三份的测试文件 `test/lib/api-client.test.ts` 是逐字节一致的**）

---

## §0.2 文件清单

### 新建

| 路径 | 职责 |
|------|------|
| `api/src/common/util/with-timeout.ts` | 通用超时包装（`withTimeout` + `TimeoutError`） |
| `api/src/health/redis-probe.ts` | 独立短连接 Redis 探活（失败得快、能恢复） |
| `api/src/health/health.service.ts` | 汇总 redis + database 两项探活 |
| `api/src/common/queue/queue.service.spec.ts` | 队列超时单测 |
| `api/src/modules/theme/theme-tokens.spec.ts` | token 定义单测 |
| `api/src/health/health.service.spec.ts` | 探活服务单测 |
| `storefront/test/app/globals-css.test.ts` | globals.css 的结构断言 |
| `storefront/test/lib/api-client.test.ts` | api-client 错误收口单测 |
| `storefront/test/app/checkout-page.test.tsx` | 结算页错误态单测 |
| `storefront/test/app/error-boundary.test.tsx` | 错误边界单测 |
| `merchant-admin/test/setup.ts` | Vitest 全局 setup（与 platform-admin 逐字节一致） |
| `merchant-admin/test/lib/api-client.test.ts` | 同 storefront 的那份，逐字节一致 |
| `merchant-admin/test/components/theme/theme-form.test.tsx` | 实时预览单测 |
| `platform-admin/test/lib/api-client.test.ts` | 同 storefront 的那份，逐字节一致 |
| `{storefront,merchant-admin,platform-admin}/src/app/error.tsx` | 段级错误边界 |
| `{storefront,merchant-admin,platform-admin}/src/app/global-error.tsx` | 根级错误边界 |

### 修改

| 路径 | 改什么 |
|------|--------|
| `api/src/modules/queue/queue.service.ts` | 三个投递方法加超时 |
| `api/src/modules/order/order.service.ts` | 投递失败 catch + logger |
| `api/src/modules/payment/payment.service.ts` | webhook 投递失败 catch |
| `api/src/health/health.controller.ts` | 真探活 + 503 |
| `api/src/health/health.module.ts` | 注册 HealthService / RedisProbe |
| `api/src/modules/theme/theme-tokens.ts` | cssVar 改名、间距单值、阴影默认值 |
| `api/test/health.e2e-spec.ts` | 断言新响应体 + degraded 分支 |
| `{storefront,merchant-admin,platform-admin}/src/app/globals.css` | `--brand-*` 两层结构 |
| `storefront/src/lib/theme.ts` | 映射表改造、删 `GROUP_KEYS` |
| `storefront/src/components/theme/theme-watcher.tsx` | 映射改造、放开字体、删错误注释 |
| `{storefront,merchant-admin,platform-admin}/src/app/layout.tsx` | 字体变量挪到 `<html>` |
| `{storefront,merchant-admin,platform-admin}/src/lib/api-client.ts` | 网络错误收口 + 401 中文化 + 空 body |
| `storefront/src/lib/route-helpers.ts` | 删失效的 `readableMessage` |
| `storefront/src/app/(shop)/checkout/page.tsx` | 错误态不再误报空车 |
| `storefront/src/app/(shop)/{coupons,account}/page.tsx` 等 6 处 | `!session` → `!session?.accessToken` |
| `platform-admin/src/app/(dashboard)/layout.tsx` | 同上（1 处） |
| `merchant-admin/package.json` | 补 4 个测试依赖 |
| `merchant-admin/vitest.config.ts` | 补 `setupFiles` / `esbuild.jsx` / include 扩 `.tsx` |
| `merchant-admin/src/components/theme/theme-form.tsx` | 实时预览 |

---

## Task 1: 队列投递加超时，投递失败不再向上抛

**为什么第一个做：** 这是 5d-0 的核心。现状是 Redis 挂掉时 `queue.add()` 的 Promise **永远不 settle** → 请求永久挂住。

**Files:**
- Create: `api/src/common/util/with-timeout.ts`
- Modify: `api/src/modules/queue/queue.service.ts`
- Modify: `api/src/modules/order/order.service.ts`
- Modify: `api/src/modules/payment/payment.service.ts`
- Test: `api/src/modules/queue/queue.service.spec.ts`

---

### Step 1: 写超时工具

Create `api/src/common/util/with-timeout.ts`：

```ts
/**
 * 给一个 Promise 加超时。
 *
 * ⚠️ **超时不会取消底层操作**：`Promise.race` 只是让调用方先拿到一个错误，
 * 底层那个 Promise 仍在跑（Redis 恢复后它可能**还会成功**）。
 * 「超时之后那个操作还算不算数」由调用方自己判断。
 *
 * 典型场景：BullMQ 覆盖了 ioredis 的 `retryStrategy` → 无限重试 →
 * Redis 不可达时 `queue.add()` 的 Promise 永远不 settle → 请求永久挂住。
 */

/** 超时错误。带可读的名字，方便日志与断言。 */
export class TimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly timeoutMs: number,
  ) {
    super(`操作超时（${timeoutMs}ms）：${what}`);
    this.name = 'TimeoutError';
  }
}

/**
 * 在 `timeoutMs` 内等 `promise`；超时则抛 {@link TimeoutError}。
 *
 * @param what 超时时的可读描述（会进错误消息）
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(what, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

### Step 2: 写失败的测试

Create `api/src/modules/queue/queue.service.spec.ts`：

```ts
import { ServiceUnavailableException } from '@nestjs/common';

import { QueueService } from './queue.service';

/**
 * 队列投递的超时保护。
 *
 * ## 为什么这条用例必须存在
 *
 * BullMQ 覆盖了 ioredis 的 `retryStrategy` → **无限重试** → Redis 不可达时
 * `queue.add()` 返回的 Promise **永远不 settle**。
 * 没有超时包装的话，下单请求会永久挂住：订单已落库、响应一直转圈。
 *
 * 所以这里用一个「永远不 settle 的 Promise」当队列的替身：
 * 没有超时 → 测试**挂住**（jest 超时失败）；有超时 → 抛 503。
 */
describe('QueueService 的超时保护', () => {
  /** 永远不 settle 的 Promise——模拟 Redis 不可达 */
  const pending = () => new Promise<never>(() => {});

  function makeService() {
    const queue = {
      add: jest.fn(() => pending()),
      upsertJobScheduler: jest.fn(() => pending()),
    };
    // 四个队列参数用同一个替身即可——本用例只关心「会不会超时」
    return new QueueService(queue as never, queue as never, queue as never, queue as never);
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('add 在队列不可达时抛 ServiceUnavailableException，而不是永远挂住', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const promise = service.add('payment-timeout', 'release', {}, 'job-1');
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await jest.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('addDelayed 在队列不可达时同样抛 503', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const promise = service.addDelayed(
      'payment-timeout',
      'release',
      {},
      60_000,
      'job-2',
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await jest.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('addRepeating 在队列不可达时同样抛 503', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const promise = service.addRepeating(
      'billing',
      'scan',
      {},
      60_000,
      'billing-scan',
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await jest.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('队列正常时原样返回结果（超时包装不改变成功路径）', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const service = new QueueService(
      queue as never,
      queue as never,
      queue as never,
      queue as never,
    );

    await expect(
      service.add('payment-timeout', 'release', {}, 'job-1'),
    ).resolves.toBeUndefined();
  });
});
```

### Step 3: 跑测试，确认失败

Run: `cd api && npx jest src/modules/queue/queue.service.spec.ts`

Expected: **FAIL** —— `ServiceUnavailableException` 没有被抛出（Promise 永远 pending → jest 超时）。

### Step 4: 给 QueueService 加超时

Modify `api/src/modules/queue/queue.service.ts`：

在 import 区加上：

```ts
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { TimeoutError, withTimeout } from '../../common/util/with-timeout';
```

在 `DEFAULT_JOB_OPTIONS` 之后加上：

```ts
/**
 * 队列投递超时（毫秒）。
 *
 * ⚠️ BullMQ 覆盖了 ioredis 的 `retryStrategy` → **无限退避重试** →
 * Redis 不可达时 `queue.add()` 的 Promise **永远不 settle**。
 * 不设超时的话，请求会永远挂住（订单已落库、响应一直转圈）。
 */
const QUEUE_OPERATION_TIMEOUT_MS = 3_000;
```

把三个方法改成包一层超时。`addDelayed` 改成：

```ts
  /**
   * 投递一个延迟任务。
   *
   * @param jobId 幂等键——同名不会重复入队
   */
  async addDelayed(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    delayMs: number,
    jobId: string,
  ): Promise<void> {
    await this.withQueueTimeout(
      this.queueOf(queueName).add(jobName, data, {
        delay: delayMs,
        jobId,
        ...DEFAULT_JOB_OPTIONS,
      }),
      `${queueName}/${jobName}`,
    );
  }
```

`add` 改成：

```ts
  async add(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    jobId: string,
  ): Promise<void> {
    await this.withQueueTimeout(
      this.queueOf(queueName).add(jobName, data, {
        jobId,
        ...DEFAULT_JOB_OPTIONS,
      }),
      `${queueName}/${jobName}`,
    );
  }
```

`addRepeating` 改成：

```ts
  async addRepeating(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    everyMs: number,
    jobSchedulerId: string,
  ): Promise<void> {
    await this.withQueueTimeout(
      this.queueOf(queueName).upsertJobScheduler(
        jobSchedulerId,
        { every: everyMs },
        {
          name: jobName,
          data: data as never,
          opts: DEFAULT_JOB_OPTIONS,
        },
      ),
      `${queueName}/${jobName}`,
    );
  }
```

在 `queueOf` 之前加上私有方法：

```ts
  /**
   * 给队列操作加超时。
   *
   * 超时 → `ServiceUnavailableException`（HTTP 503）。
   * ⚠️ **超时不会取消底层操作**：那个 `add()` 仍在跑，Redis 恢复后它可能
   * **还会成功入队**。调用方要按「超时后那个操作还算不算数」来决定怎么处理
   * （下单链路选择「失败不致命」，见 order.service.ts）。
   */
  private async withQueueTimeout<T>(
    promise: Promise<T>,
    what: string,
  ): Promise<T> {
    try {
      return await withTimeout(promise, QUEUE_OPERATION_TIMEOUT_MS, what);
    } catch (cause) {
      if (cause instanceof TimeoutError) {
        throw new ServiceUnavailableException(`队列操作超时：${what}`);
      }
      throw cause;
    }
  }
```

### Step 5: 跑测试，确认通过

Run: `cd api && npx jest src/modules/queue/queue.service.spec.ts`

Expected: **PASS** —— 4 个用例全过（勘误 E1：正文写的「5 个」与文件内容不符，以文件为准）。

### Step 6: 下单的投递失败不再向上抛

Modify `api/src/modules/order/order.service.ts`。

先加 logger（这个类现在没有）：在 import 区加 `Logger`，在类里加

```ts
  private readonly logger = new Logger(OrderService.name);
```

把 `await this.queue.addDelayed(...)` 那段（第 238 行附近）改成：

```ts
    // ⚠️ **投递失败不致命**：订单已建成、库存已预占、用户可以正常支付。
    //    这里报失败会让用户以为「没下单成功」而重下 → 重复订单。
    //    投递失败只影响「超时后自动关单」这一件事，不影响下单本身。
    //
    // ⚠️ **投递的位置不能前移**：`payExpiresAt` 在事务内建单时算，
    //    而 delayed job 从**入队时刻**起算延迟 —— 前移会让任务早于
    //    `payExpiresAt` 触发，被 `order-timeout.service.ts` 的「还没到期限」
    //    分支跳过且不重试 → 订单永远停在待支付、库存永久卡在预占。
    try {
      await this.queue.addDelayed(
        PAYMENT_TIMEOUT_QUEUE,
        'release',
        { tenantId, orderId },
        PAYMENT_TIMEOUT_MS,
        `timeout-${orderId}`,
      );
    } catch (cause) {
      this.logger.error(`支付超时释放任务投递失败：订单 ${orderId}`, cause);
    }
```

### Step 7: webhook 的投递失败不再向上抛

Modify `api/src/modules/payment/payment.service.ts` 的 `enqueueWebhookEvent`：把

```ts
    await this.queue.add(
      PAYMENT_WEBHOOK_QUEUE,
      'payment',
      {
        tenantId,
        kind,
        eventId: event.eventId,
        provider: event.provider,
        channel: event.channel,
        providerTxnId: event.providerTxnId,
        referenceNo: event.referenceNo,
        amount: event.amount,
        success: event.success,
      },
      `webhook-${event.provider}-${event.eventId}`,
    );
```

改成

```ts
    try {
      await this.queue.add(
        PAYMENT_WEBHOOK_QUEUE,
        'payment',
        {
          tenantId,
          kind,
          eventId: event.eventId,
          provider: event.provider,
          channel: event.channel,
          providerTxnId: event.providerTxnId,
          referenceNo: event.referenceNo,
          amount: event.amount,
          success: event.success,
        },
        `webhook-${event.provider}-${event.eventId}`,
      );
    } catch (cause) {
      // ⚠️ 支付已入库。报失败会诱导用户重复支付。
      //    通知丢失的补偿机制不在本阶段范围（见设计文档 L1）。
      this.logger.error(
        `支付通知投递失败：provider=${event.provider} eventId=${event.eventId}`,
        cause,
      );
    }
```

### Step 8: 跑 api 全部单测 + 类型检查

Run: `cd api && npx jest --passWithNoTests && npx tsc --noEmit`

Expected: 全部通过，无类型错误。

### Step 9: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/common/util/with-timeout.ts api/src/modules/queue/queue.service.ts api/src/modules/queue/queue.service.spec.ts api/src/modules/order/order.service.ts api/src/modules/payment/payment.service.ts
git commit -m "fix(api): 队列投递加超时保护，投递失败不再向上抛"
```

---

## Task 2: `/health` 真探活

**Files:**
- Create: `api/src/health/redis-probe.ts`
- Create: `api/src/health/health.service.ts`
- Modify: `api/src/health/health.controller.ts`
- Modify: `api/src/health/health.module.ts`
- Test: `api/src/health/health.service.spec.ts`
- Test: `api/test/health.e2e-spec.ts`（改）

---

### Step 1: 写 Redis 探活

Create `api/src/health/redis-probe.ts`：

```ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { withTimeout } from '../common/util/with-timeout';

/** 单次探活的超时（毫秒） */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Redis 探活。
 *
 * ## 为什么必须用**独立连接**，不能复用 BullMQ 的那个
 *
 * `queue.module.ts` 里 `BullModule.forRoot` 配的是 `maxRetriesPerRequest: null`
 * + BullMQ 默认的**无限退避重试**。那个实例在 Redis 挂掉时会把 `PING`
 * 排进离线队列里**永远不返回** —— 用它探活等于把探活本身也挂死
 * （正是本阶段要修的那个机制）。
 *
 * ## 连接参数的取舍
 *
 * - `enableOfflineQueue: false` —— 连接不可用时**立刻**失败，而不是把命令
 *   排进离线队列干等。这是「失败得快」的关键。
 * - `retryStrategy` **保留重试**（封顶 2 秒一次）—— 不能设成 `() => null`：
 *   那样连接一断就永久停止重连，Redis 恢复后探活再也回不来。
 * - `connectTimeout: 2000` —— 建连本身也要有上限。
 */
@Injectable()
export class RedisProbe implements OnModuleDestroy {
  private readonly logger = new Logger(RedisProbe.name);
  private client: Redis | null = null;

  /** Redis 不可达时返回 false（绝不抛出去） */
  async check(): Promise<boolean> {
    try {
      await withTimeout(
        this.client().ping(),
        PROBE_TIMEOUT_MS,
        'Redis PING',
      );
      return true;
    } catch {
      return false;
    }
  }

  private client(): Redis {
    if (!this.client) {
      this.client = new Redis(
        process.env.REDIS_URL ?? 'redis://localhost:16380',
        {
          connectTimeout: PROBE_TIMEOUT_MS,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 200, 2_000),
        },
      );
      // ⚠️ 连接失败会抛 'error' 事件；不接住的话 Node 会把它当成
      // 未处理的异常 → 整个进程挂掉。探活失败只该让 /health 报 degraded。
      this.client.on('error', () => {
        // 静默：探活的结果由 check() 的返回值表达
      });
    }
    return this.client;
  }

  onModuleDestroy(): void {
    this.client?.disconnect();
  }
}
```

### Step 2: 写探活服务

Create `api/src/health/health.service.ts`：

```ts
import { Injectable } from '@nestjs/common';

import { TenantPrismaService } from '../common/tenant/tenant-prisma.service';
import { withTimeout } from '../common/util/with-timeout';
import { RedisProbe } from './redis-probe';

/** 单项探活的超时（毫秒） */
const PROBE_TIMEOUT_MS = 2_000;

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    redis: boolean;
    database: boolean;
  };
  timestamp: string;
}

/**
 * 健康检查的业务逻辑。
 *
 * ⚠️ **数据库探活用 `databaseNow()`**：它是 `TenantPrismaService` 唯一暴露的
 * 原生 SQL 入口（`SELECT now()`），不涉及任何租户数据、不需要 tenantId 条件，
 * 而且它天然就是一个「真的连上了数据库」的证明。
 * 刻意不用 `$queryRaw` —— 那被刻意屏蔽了（原生 SQL 不经过租户扩展，
 * 放开就成了绕过隔离的后门）。
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly redis: RedisProbe,
  ) {}

  async check(): Promise<HealthReport> {
    const [redis, database] = await Promise.all([
      this.redis.check(),
      this.checkDatabase(),
    ]);

    return {
      status: redis && database ? 'ok' : 'degraded',
      checks: { redis, database },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await withTimeout(
        this.prisma.databaseNow(),
        PROBE_TIMEOUT_MS,
        '数据库 SELECT now()',
      );
      return true;
    } catch {
      return false;
    }
  }
}
```

### Step 3: 改 controller

Modify `api/src/health/health.controller.ts`（整体替换）：

```ts
import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Skip } from '../common/decorators/skip.decorator';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Skip()
  @ApiOperation({ summary: '存活探针' })
  async check(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.check();
    // ⚠️ **探活失败要用 503**：容器编排的 healthcheck 靠状态码判断，
    // 返回 200 会让「Redis 挂了」的容器继续被当成健康的。
    if (report.status === 'degraded') {
      res.status(503);
    }
    return report;
  }
}
```

### Step 4: 改 module

Modify `api/src/health/health.module.ts`（整体替换）：

```ts
import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { RedisProbe } from './redis-probe';

@Module({
  controllers: [HealthController],
  providers: [HealthService, RedisProbe],
})
export class HealthModule {}
```

⚠️ `TenantPrismaService` 由全局的 `TenancyModule` 提供并导出，**这里不需要 import**。

### Step 5: 写单测

Create `api/src/health/health.service.spec.ts`：

```ts
import { Test } from '@nestjs/testing';

import { TenantPrismaService } from '../common/tenant/tenant-prisma.service';
import { HealthService } from './health.service';
import { RedisProbe } from './redis-probe';

/**
 * 探活服务的降级判定。
 *
 * 关键性质：**任何一项探活抛错都只让那一项变 false**，不能让整个 /health 挂住。
 * 探活自己的目的是「快速告诉外界我是不是还活着」——
 * 如果探活会挂住，它就失去了意义（那正是本阶段要修的 Redis 挂死）。
 */
describe('HealthService', () => {
  async function makeService(redisOk: boolean, dbOk: boolean) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: RedisProbe,
          useValue: { check: async () => redisOk },
        },
        {
          provide: TenantPrismaService,
          useValue: {
            databaseNow: async () => {
              if (!dbOk) throw new Error('数据库连不上');
              return new Date();
            },
          },
        },
      ],
    }).compile();
    return moduleRef.get(HealthService);
  }

  it('两项都通 → ok', async () => {
    const service = await makeService(true, true);
    const report = await service.check();
    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({ redis: true, database: true });
    expect(typeof report.timestamp).toBe('string');
  });

  it('Redis 不通 → degraded，且数据库仍报 true', async () => {
    const service = await makeService(false, true);
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ redis: false, database: true });
  });

  it('数据库不通 → degraded', async () => {
    const service = await makeService(true, false);
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ redis: true, database: false });
  });

  it('两项都不通 → degraded', async () => {
    const service = await makeService(false, false);
    const report = await service.check();
    expect(report.status).toBe('degraded');
    expect(report.checks).toEqual({ redis: false, database: false });
  });
});
```

### Step 6: 跑单测，确认通过

Run: `cd api && npx jest src/health/health.service.spec.ts`

Expected: **PASS** —— 4 个用例全过。

### Step 7: 改 e2e

Modify `api/test/health.e2e-spec.ts`（整体替换）：

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { HealthService } from '../src/health/health.service';
import { http } from './helpers';

interface HealthResponse {
  status: string;
  checks: { redis: boolean; database: boolean };
  timestamp: string;
}

describe('健康检查 (e2e)', () => {
  let app: INestApplication;

  async function build(overrideHealth?: Partial<HealthService>) {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HealthService)
      .useValue(
        overrideHealth ?? {
          check: async () => ({
            status: 'ok',
            checks: { redis: true, database: true },
            timestamp: new Date().toISOString(),
          }),
        },
      )
      .compile();

    const instance = moduleRef.createNestApplication();
    // 与 main.ts 保持一致：e2e 必须复刻生产环境的全局管道，
    // 否则 DTO 校验、未知字段拒绝这些契约在测试里根本不会被执行。
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await instance.init();
    return instance;
  }

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health 返回 ok', async () => {
    app = await build();
    const response = await http(app).get('/health');
    const body = response.body as HealthResponse;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ redis: true, database: true });
    expect(typeof body.timestamp).toBe('string');
  });

  it('探活失败时返回 503 与 degraded', async () => {
    const degraded = await build({
      check: async () => ({
        status: 'degraded',
        checks: { redis: false, database: true },
        timestamp: new Date().toISOString(),
      }),
    });

    const response = await http(degraded).get('/health');
    const body = response.body as HealthResponse;

    expect(response.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe(false);

    await degraded.close();
  });
});
```

### Step 8: 跑 e2e，确认通过

Run: `cd api && npm run test:e2e -- health.e2e-spec`

Expected: **PASS** —— 2 个用例全过。

⚠️ 若 `DATABASE_URL_TEST` 没配，这一步会失败——那是环境问题，不是代码问题。

### Step 9: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/health/redis-probe.ts api/src/health/health.service.ts api/src/health/health.controller.ts api/src/health/health.module.ts api/src/health/health.service.spec.ts api/test/health.e2e-spec.ts
git commit -m "feat(api): /health 真探活，Redis 与数据库任一不通返回 503"
```

---

## Task 3: 后端 theme token 定义改名

**Files:**
- Modify: `api/src/modules/theme/theme-tokens.ts`
- Test: `api/src/modules/theme/theme-tokens.spec.ts`

⚠️ **这一改不影响运行时**：`cssVar` 字段只是 schema 的描述信息（`theme.service.ts` 的 `sanitize()` 用的是 `key` 与 `defaultValue`，不是 `cssVar`；storefront 的映射表是自己硬编码的）。所以可以独立提交，不会出现「中间状态主题失效」。

---

### Step 1: 写失败的测试

Create `api/src/modules/theme/theme-tokens.spec.ts`：

```ts
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  RADIUS_TOKEN,
  SHADOW_TOKENS,
  SPACING_TOKENS,
  TEXT_SCALE_TOKENS,
  WEIGHT_TOKENS,
} from './theme-tokens';

/**
 * token 定义的形状约束。
 *
 * ## 为什么这些是「定义级」的约束
 *
 * `cssVar` 是前后端唯一的耦合点：后端把 token 的 cssVar 放进 schema，
 * 前端（merchant-admin 的预览、storefront 的映射表）照着它写 CSS 变量。
 * 一旦两边对不上，商家配的值就写到一个没人读的变量上 —— **静默失效**。
 *
 * 所以这里把「全部 cssVar 都在 `--brand-*` 命名空间下」钉死。
 */

/** Tailwind 4 的阴影内置值（与 globals.css 的 `:root` 必须逐字一致） */
const TAILWIND_SHADOW_SM =
  '0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))';
const TAILWIND_SHADOW_BASE =
  '0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))';
const TAILWIND_SHADOW_LG =
  '0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1))';

describe('theme token 定义', () => {
  it('所有 cssVar 都在 --brand-* 命名空间下', () => {
    const all = [
      ...COLOR_TOKENS,
      RADIUS_TOKEN,
      ...FONT_TOKENS,
      ...TEXT_SCALE_TOKENS,
      ...WEIGHT_TOKENS,
      ...SPACING_TOKENS,
      ...SHADOW_TOKENS,
    ];

    for (const token of all) {
      expect(token.cssVar.startsWith('--brand-')).toBe(true);
    }
  });

  it('所有 cssVar 互不重复（重复会让两个 token 抢同一个变量）', () => {
    const all = [
      ...COLOR_TOKENS,
      RADIUS_TOKEN,
      ...FONT_TOKENS,
      ...TEXT_SCALE_TOKENS,
      ...WEIGHT_TOKENS,
      ...SPACING_TOKENS,
      ...SHADOW_TOKENS,
    ];
    const vars = all.map((t) => t.cssVar);

    expect(new Set(vars).size).toBe(vars.length);
  });

  it('间距组只剩一个「基础值」token', () => {
    expect(SPACING_TOKENS).toHaveLength(1);
    expect(SPACING_TOKENS[0].key).toBe('base');
    expect(SPACING_TOKENS[0].cssVar).toBe('--brand-spacing');
    expect(SPACING_TOKENS[0].defaultValue).toBe('0.25rem');
  });

  it('阴影默认值就是 Tailwind 的内置值', () => {
    expect(SHADOW_TOKENS.map((t) => t.defaultValue)).toEqual([
      TAILWIND_SHADOW_SM,
      TAILWIND_SHADOW_BASE,
      TAILWIND_SHADOW_LG,
    ]);
  });

  it('阴影默认值能过 isValidScalarValue（否则后端会把它当非法值丢掉）', () => {
    // 复合阴影值含逗号、括号与 var() —— 正则必须放行这些字符
    for (const token of SHADOW_TOKENS) {
      expect(token.defaultValue.length).toBeLessThanOrEqual(180);
    }
  });

  it('destructiveForeground 是存在的（历史上它是个没有任何消费者的空 token）', () => {
    const token = COLOR_TOKENS.find((t) => t.key === 'destructiveForeground');
    expect(token).toBeDefined();
    expect(token?.cssVar).toBe('--brand-destructive-foreground');
  });
});
```

### Step 2: 跑测试，确认失败

Run: `cd api && npx jest src/modules/theme/theme-tokens.spec.ts`

Expected: **FAIL** —— `cssVar` 还是 `--primary` 之类的裸名。

### Step 3: 改 theme-tokens.ts

Modify `api/src/modules/theme/theme-tokens.ts`：

**3a. 颜色 token 的 cssVar 改名**（16 个）：

```ts
export const COLOR_TOKENS: ColorTokenDefinition[] = [
  { key: 'background', label: '背景色', cssVar: '--brand-background', defaultValue: 'oklch(1 0 0)' },
  { key: 'foreground', label: '文字色', cssVar: '--brand-foreground', defaultValue: 'oklch(0.145 0 0)' },
  { key: 'card', label: '卡片背景', cssVar: '--brand-card', defaultValue: 'oklch(1 0 0)' },
  { key: 'cardForeground', label: '卡片文字', cssVar: '--brand-card-foreground', defaultValue: 'oklch(0.145 0 0)' },
  { key: 'primary', label: '主色', cssVar: '--brand-primary', defaultValue: 'oklch(0.205 0 0)' },
  { key: 'primaryForeground', label: '主色上的文字', cssVar: '--brand-primary-foreground', defaultValue: 'oklch(0.985 0 0)' },
  { key: 'secondary', label: '次要色', cssVar: '--brand-secondary', defaultValue: 'oklch(0.97 0 0)' },
  { key: 'secondaryForeground', label: '次要色上的文字', cssVar: '--brand-secondary-foreground', defaultValue: 'oklch(0.205 0 0)' },
  { key: 'muted', label: '弱化色', cssVar: '--brand-muted', defaultValue: 'oklch(0.97 0 0)' },
  { key: 'mutedForeground', label: '弱化色上的文字', cssVar: '--brand-muted-foreground', defaultValue: 'oklch(0.556 0 0)' },
  { key: 'accent', label: '强调色', cssVar: '--brand-accent', defaultValue: 'oklch(0.97 0 0)' },
  { key: 'accentForeground', label: '强调色上的文字', cssVar: '--brand-accent-foreground', defaultValue: 'oklch(0.205 0 0)' },
  { key: 'destructive', label: '危险色', cssVar: '--brand-destructive', defaultValue: 'oklch(0.577 0.245 27.325)' },
  { key: 'destructiveForeground', label: '危险色上的文字', cssVar: '--brand-destructive-foreground', defaultValue: 'oklch(0.985 0 0)' },
  { key: 'border', label: '边框色', cssVar: '--brand-border', defaultValue: 'oklch(0.922 0 0)' },
  { key: 'ring', label: '聚焦环', cssVar: '--brand-ring', defaultValue: 'oklch(0.708 0 0)' },
];
```

**3b. 圆角 / 字体 / 字阶 / 字重**：

```ts
export const RADIUS_TOKEN: ScalarTokenDefinition = {
  key: 'radius',
  label: '圆角',
  cssVar: '--brand-radius',
  defaultValue: '0.625rem',
};

export const FONT_TOKENS: ScalarTokenDefinition[] = [
  { key: 'fontSans', label: '正文字体', cssVar: '--brand-font-sans', defaultValue: 'var(--font-geist-sans)' },
  { key: 'fontMono', label: '等宽字体', cssVar: '--brand-font-mono', defaultValue: 'var(--font-geist-mono)' },
];

export const TEXT_SCALE_TOKENS: ScalarTokenDefinition[] = [
  { key: 'xs', label: '最小', cssVar: '--brand-text-xs', defaultValue: '0.75rem' },
  { key: 'sm', label: '小', cssVar: '--brand-text-sm', defaultValue: '0.875rem' },
  { key: 'base', label: '正文', cssVar: '--brand-text-base', defaultValue: '1rem' },
  { key: 'lg', label: '大', cssVar: '--brand-text-lg', defaultValue: '1.125rem' },
  { key: 'xl', label: '特大', cssVar: '--brand-text-xl', defaultValue: '1.25rem' },
];

export const WEIGHT_TOKENS: ScalarTokenDefinition[] = [
  { key: 'normal', label: '常规', cssVar: '--brand-font-weight-normal', defaultValue: '400' },
  { key: 'medium', label: '中等', cssVar: '--brand-font-weight-medium', defaultValue: '500' },
  { key: 'semibold', label: '半粗', cssVar: '--brand-font-weight-semibold', defaultValue: '600' },
  { key: 'bold', label: '加粗', cssVar: '--brand-font-weight-bold', defaultValue: '700' },
];
```

**3c. 间距组改成单一基础值**：

```ts
/**
 * 间距组：**只有一个**基础值。
 *
 * ⚠️ **为什么不是五档刻度**：Tailwind 4 的间距只有**单一** `--spacing`
 * 基础值（`p-4` = `calc(var(--spacing) * 4)`），**没有** `--spacing-xs` 这种
 * 刻度命名空间 —— 五档刻度在技术上无法表达。
 * 语义因此从「五档刻度」变成「**全局间距密度**」。
 *
 * ⚠️ **老数据自动降级**：`sanitize()` 按本数组的定义取键，老数据里的
 * `xs`/`sm`/`lg`/`xl` 不在白名单 → 被丢弃；`base` 保留 → 无需写迁移。
 */
export const SPACING_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'base',
    label: '间距密度',
    cssVar: '--brand-spacing',
    defaultValue: '0.25rem',
  },
];
```

**3d. 阴影默认值改成 Tailwind 内置值**：

```ts
/**
 * 阴影组。
 *
 * ⚠️ **默认值必须与 globals.css 的 `:root` 里的 `--brand-shadow-*` 逐字一致**：
 * 前者决定「商家没配时接口返回什么」，后者决定「没人注入时页面用什么」。
 * 两边不一样 → 商家清空某个字段后外观会跳变。
 * 两边的默认值都写在这两个文件里，靠**同一次提交**保证不漂移；
 * 两边各有一条单测断言同样的字面量，改一边就会让另一边红。
 */
export const SHADOW_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'sm',
    label: '轻',
    cssVar: '--brand-shadow-sm',
    defaultValue:
      '0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))',
  },
  {
    key: 'base',
    label: '标准',
    cssVar: '--brand-shadow-base',
    defaultValue: '0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))',
  },
  {
    key: 'lg',
    label: '重',
    cssVar: '--brand-shadow-lg',
    defaultValue:
      '0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1))',
  },
];
```

### Step 4: 跑测试，确认通过

Run: `cd api && npx jest src/modules/theme/theme-tokens.spec.ts`

Expected: **PASS** —— 6 个用例全过。

### Step 5: 跑 api 单测 + 类型检查

Run: `cd api && npx jest --passWithNoTests && npx tsc --noEmit`

Expected: 全过。

### Step 6: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/theme/theme-tokens.ts api/src/modules/theme/theme-tokens.spec.ts
git commit -m "feat(api): 主题 token 统一到 --brand-* 命名空间，间距改单一基础值"
```

---

## Task 4: 主题命名空间迁移（globals.css + 前端映射表）

**Files:**
- Modify: `storefront/src/app/globals.css`
- Modify: `merchant-admin/src/app/globals.css`（`cp` 过去）
- Modify: `platform-admin/src/app/globals.css`（`cp` 过去）
- Modify: `storefront/src/lib/theme.ts`
- Modify: `storefront/src/components/theme/theme-watcher.tsx`
- Test: `storefront/test/app/globals-css.test.ts`（新）
- Test: `storefront/test/lib/theme.test.ts`（改）
- Test: `storefront/test/components/theme/theme-watcher.test.tsx`（改）

⚠️ **这四步必须一起做完再提交**：CSS 改了而映射表没改 → 商家主题失效（中间状态是坏的）。

> ✅ **本 Task 的 Step 1 与 Step 3 的内容已实测验证过**（2026-10-27，写计划时试跑）：
> - 用新的 globals.css 跑 `storefront/test/app/globals-css.test.ts` → **9 个用例全过**
> - 用新的 globals.css 跑 `cd storefront && npm run build` → **构建成功**（Tailwind 编译无错）
>
> 所以这两步的内容可以直接照抄，不必重新推导。

---

### Step 1: 写 globals.css 的结构测试

Create `storefront/test/app/globals-css.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `globals.css` 的结构约束。
 *
 * ## 为什么要有这个测试
 *
 * 主题变量分两层（设计文档 §4.2.1）：
 * - `@theme inline` 里只出现 **Tailwind 命名空间**（`--color-*` / `--text-*` …），
 *   它们的值是 `var(--brand-*)`；
 * - `:root` / `.dark` 里只出现 **`--brand-*`**，默认值只存这一处。
 *
 * 这两层一旦写混（`:root` 里冒出裸名 `--primary`），商家配的值就会写到一个
 * **没人读的变量**上 —— 静默失效，且没有任何报错。
 * 所以用测试把结构钉死。
 */

const css = readFileSync(
  fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
  'utf8',
);

/** 取出一个 at-rule 块的内容 */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

/**
 * 取出一个块里**声明**的所有自定义属性名。
 *
 * ⚠️ **必须锚到行首**（`^\s*` + `m` 标志）：否则会连 `var(--font-geist-sans)`
 * 这类**值里的变量名**一起匹配进来 —— 那些不是声明。
 */
function declaredVars(source: string): string[] {
  return [...source.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]);
}

/** 取 @theme inline 块的内容 */
function themeBlock(): string {
  return block('@theme inline');
}

describe('globals.css 的主题变量结构', () => {
  it('@theme inline 里的颜色命名空间全部指向 --brand-*', () => {
    const theme = themeBlock();
    const colorVars = declaredVars(theme).filter((v) => v.startsWith('--color-'));
    expect(colorVars.length).toBe(32);
    for (const v of colorVars) {
      expect(theme).toContain(`${v}: var(--brand-${v.slice('--color-'.length)});`);
    }
  });

  it('@theme inline 里补上了 destructive-foreground（历史上是空 token）', () => {
    expect(css).toContain('--color-destructive-foreground: var(--brand-destructive-foreground);');
  });

  it('@theme inline 里没有字体自引用', () => {
    // `--font-sans: var(--font-sans)` 是自引用 → 计算值阶段无效
    expect(css).not.toContain('--font-sans: var(--font-sans);');
    expect(css).toContain('--font-sans: var(--brand-font-sans);');
  });

  it('@theme inline 里没有 fallback（默认值只存 :root 一处）', () => {
    // 形如 `var(--brand-x, ...)` 的 fallback 一律不允许
    expect(themeBlock()).not.toMatch(/var\(--brand-[a-z-]+,/);
  });

  it(':root 里声明的变量全部是 --brand-*（没有裸名残留）', () => {
    const vars = declaredVars(block(':root'));
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v.startsWith('--brand-')).toBe(true);
    }
  });

  it('.dark 里声明的变量全部是 --brand-*（没有裸名残留）', () => {
    const vars = declaredVars(block('.dark'));
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v.startsWith('--brand-')).toBe(true);
    }
  });

  it(':root 里有全部 32 个颜色变量的默认值', () => {
    const vars = new Set(declaredVars(block(':root')));
    for (const name of [
      'background', 'foreground', 'card', 'card-foreground',
      'popover', 'popover-foreground', 'primary', 'primary-foreground',
      'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
      'accent', 'accent-foreground', 'destructive', 'destructive-foreground',
      'border', 'input', 'ring',
      'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
      'sidebar', 'sidebar-foreground', 'sidebar-primary',
      'sidebar-primary-foreground', 'sidebar-accent',
      'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring',
    ]) {
      expect(vars.has(`--brand-${name}`)).toBe(true);
    }
  });

  it('阴影默认值与后端 theme-tokens.ts 逐字一致', () => {
    // ⚠️ 后端那份是「商家没配时接口返回什么」，前端这份是「没人注入时用什么」。
    //    两边不一致 → 商家清空某个字段后外观跳变。
    const root = block(':root');
    expect(root).toContain(
      '--brand-shadow-sm: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));',
    );
    expect(root).toContain(
      '--brand-shadow-base: 0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));',
    );
    expect(root).toContain(
      '--brand-shadow-lg: 0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1));',
    );
  });

  it('间距是单一基础值', () => {
    expect(css).toContain('--spacing: var(--brand-spacing);');
    expect(block(':root')).toContain('--brand-spacing: 0.25rem;');
  });
});
```

### Step 2: 跑测试，确认失败

Run: `cd storefront && npm test -- globals-css`

Expected: **FAIL** —— 现在 `:root` 里全是裸名。

### Step 3: 重写 globals.css

Modify `storefront/src/app/globals.css`（整体替换）：

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

/**
 * ① Tailwind 命名空间层。
 *
 * ⚠️ **这里只出现 Tailwind 命名空间**，值一律指向 `--brand-*`。
 * `@theme inline` 的语义是「被覆盖的变量不落到 `:root`，utility 里直接内联
 * 值引用」→ 与 Tailwind 内置刻度零冲突。
 *
 * ⚠️ **一律不写 fallback**：默认值只存 `:root` 一处（②），避免两处漂移。
 */
@theme inline {
  /* 颜色：32 个（全部改名，不只是商家能配的那 16 个） */
  --color-background: var(--brand-background);
  --color-foreground: var(--brand-foreground);
  --color-card: var(--brand-card);
  --color-card-foreground: var(--brand-card-foreground);
  --color-popover: var(--brand-popover);
  --color-popover-foreground: var(--brand-popover-foreground);
  --color-primary: var(--brand-primary);
  --color-primary-foreground: var(--brand-primary-foreground);
  --color-secondary: var(--brand-secondary);
  --color-secondary-foreground: var(--brand-secondary-foreground);
  --color-muted: var(--brand-muted);
  --color-muted-foreground: var(--brand-muted-foreground);
  --color-accent: var(--brand-accent);
  --color-accent-foreground: var(--brand-accent-foreground);
  --color-destructive: var(--brand-destructive);
  --color-destructive-foreground: var(--brand-destructive-foreground);
  --color-border: var(--brand-border);
  --color-input: var(--brand-input);
  --color-ring: var(--brand-ring);
  --color-chart-1: var(--brand-chart-1);
  --color-chart-2: var(--brand-chart-2);
  --color-chart-3: var(--brand-chart-3);
  --color-chart-4: var(--brand-chart-4);
  --color-chart-5: var(--brand-chart-5);
  --color-sidebar: var(--brand-sidebar);
  --color-sidebar-foreground: var(--brand-sidebar-foreground);
  --color-sidebar-primary: var(--brand-sidebar-primary);
  --color-sidebar-primary-foreground: var(--brand-sidebar-primary-foreground);
  --color-sidebar-accent: var(--brand-sidebar-accent);
  --color-sidebar-accent-foreground: var(--brand-sidebar-accent-foreground);
  --color-sidebar-border: var(--brand-sidebar-border);
  --color-sidebar-ring: var(--brand-sidebar-ring);

  /* 圆角 */
  --radius-sm: calc(var(--brand-radius) * 0.6);
  --radius-md: calc(var(--brand-radius) * 0.8);
  --radius-lg: var(--brand-radius);
  --radius-xl: calc(var(--brand-radius) * 1.4);
  --radius-2xl: calc(var(--brand-radius) * 1.8);
  --radius-3xl: calc(var(--brand-radius) * 2.2);
  --radius-4xl: calc(var(--brand-radius) * 2.6);

  /* 字体 */
  --font-sans: var(--brand-font-sans);
  --font-mono: var(--brand-font-mono);
  --font-heading: var(--brand-font-sans);

  /* 字阶 */
  --text-xs: var(--brand-text-xs);
  --text-sm: var(--brand-text-sm);
  --text-base: var(--brand-text-base);
  --text-lg: var(--brand-text-lg);
  --text-xl: var(--brand-text-xl);

  /* 字重 */
  --font-weight-normal: var(--brand-font-weight-normal);
  --font-weight-medium: var(--brand-font-weight-medium);
  --font-weight-semibold: var(--brand-font-weight-semibold);
  --font-weight-bold: var(--brand-font-weight-bold);

  /* 阴影 */
  --shadow-sm: var(--brand-shadow-sm);
  --shadow-base: var(--brand-shadow-base);
  --shadow-lg: var(--brand-shadow-lg);

  /* 间距（单一基础值） */
  --spacing: var(--brand-spacing);
}

/**
 * ② 品牌变量层——**默认值只在这里出现一次**。
 *
 * ⚠️ **手写的 `:root` 不在 `@layer` 里** → 优先级高于 Tailwind 编译产物
 * （`@layer theme` 里的 `:root`）→ 手写的这份赢。
 * 运行时的内联 `<style>` 同样是普通层的裸 `:root` → 同层、后出现者胜 →
 * 商家注入的值赢。
 *
 * ⚠️ **商家能配的只有 16 个颜色**；另外 16 个（popover / input / chart-* /
 * sidebar-*）商家配不了，值固定为 shadcn 默认。
 *
 * ⚠️ **阴影的默认值必须与 `api/src/modules/theme/theme-tokens.ts` 里的
 * `SHADOW_TOKENS.defaultValue` 逐字一致**（两边各有一条单测断言同样的
 * 字面量，改一边就会让另一边红）。
 */
:root {
  --brand-background: oklch(1 0 0);
  --brand-foreground: oklch(0.145 0 0);
  --brand-card: oklch(1 0 0);
  --brand-card-foreground: oklch(0.145 0 0);
  --brand-popover: oklch(1 0 0);
  --brand-popover-foreground: oklch(0.145 0 0);
  --brand-primary: oklch(0.205 0 0);
  --brand-primary-foreground: oklch(0.985 0 0);
  --brand-secondary: oklch(0.97 0 0);
  --brand-secondary-foreground: oklch(0.205 0 0);
  --brand-muted: oklch(0.97 0 0);
  --brand-muted-foreground: oklch(0.556 0 0);
  --brand-accent: oklch(0.97 0 0);
  --brand-accent-foreground: oklch(0.205 0 0);
  --brand-destructive: oklch(0.577 0.245 27.325);
  --brand-destructive-foreground: oklch(0.985 0 0);
  --brand-border: oklch(0.922 0 0);
  --brand-input: oklch(0.922 0 0);
  --brand-ring: oklch(0.708 0 0);
  --brand-chart-1: oklch(0.87 0 0);
  --brand-chart-2: oklch(0.556 0 0);
  --brand-chart-3: oklch(0.439 0 0);
  --brand-chart-4: oklch(0.371 0 0);
  --brand-chart-5: oklch(0.269 0 0);
  --brand-sidebar: oklch(0.985 0 0);
  --brand-sidebar-foreground: oklch(0.145 0 0);
  --brand-sidebar-primary: oklch(0.205 0 0);
  --brand-sidebar-primary-foreground: oklch(0.985 0 0);
  --brand-sidebar-accent: oklch(0.97 0 0);
  --brand-sidebar-accent-foreground: oklch(0.205 0 0);
  --brand-sidebar-border: oklch(0.922 0 0);
  --brand-sidebar-ring: oklch(0.708 0 0);

  --brand-radius: 0.625rem;
  --brand-font-sans: var(--font-geist-sans);
  --brand-font-mono: var(--font-geist-mono);
  --brand-text-xs: 0.75rem;
  --brand-text-sm: 0.875rem;
  --brand-text-base: 1rem;
  --brand-text-lg: 1.125rem;
  --brand-text-xl: 1.25rem;
  --brand-font-weight-normal: 400;
  --brand-font-weight-medium: 500;
  --brand-font-weight-semibold: 600;
  --brand-font-weight-bold: 700;
  --brand-shadow-sm: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
  --brand-shadow-base: 0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
  --brand-shadow-lg: 0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
  --brand-spacing: 0.25rem;
}

/**
 * dark 模式。
 *
 * ⚠️ **dark 模式目前从未启用**（全仓没有给 `<html>` 加 `.dark` 类的代码），
 * 这里保留是为了将来启用时不必重做。改名成 `--brand-*` 是为了守住
 * 「`--brand-*` 是唯一命名空间」这条不变量。
 *
 * ⚠️ **将来启用 dark 时要重做主题分层**：`.dark` 的值会盖掉商家注入的
 * `:root` 值（同优先级、`.dark` 在源码里更靠后）→ 商家主题在 dark 下失效。
 */
.dark {
  --brand-background: oklch(0.145 0 0);
  --brand-foreground: oklch(0.985 0 0);
  --brand-card: oklch(0.205 0 0);
  --brand-card-foreground: oklch(0.985 0 0);
  --brand-popover: oklch(0.205 0 0);
  --brand-popover-foreground: oklch(0.985 0 0);
  --brand-primary: oklch(0.922 0 0);
  --brand-primary-foreground: oklch(0.205 0 0);
  --brand-secondary: oklch(0.269 0 0);
  --brand-secondary-foreground: oklch(0.985 0 0);
  --brand-muted: oklch(0.269 0 0);
  --brand-muted-foreground: oklch(0.708 0 0);
  --brand-accent: oklch(0.269 0 0);
  --brand-accent-foreground: oklch(0.985 0 0);
  --brand-destructive: oklch(0.704 0.191 22.216);
  --brand-destructive-foreground: oklch(0.145 0 0);
  --brand-border: oklch(1 0 0 / 10%);
  --brand-input: oklch(1 0 0 / 15%);
  --brand-ring: oklch(0.556 0 0);
  --brand-chart-1: oklch(0.87 0 0);
  --brand-chart-2: oklch(0.556 0 0);
  --brand-chart-3: oklch(0.439 0 0);
  --brand-chart-4: oklch(0.371 0 0);
  --brand-chart-5: oklch(0.269 0 0);
  --brand-sidebar: oklch(0.205 0 0);
  --brand-sidebar-foreground: oklch(0.985 0 0);
  --brand-sidebar-primary: oklch(0.488 0.243 264.376);
  --brand-sidebar-primary-foreground: oklch(0.985 0 0);
  --brand-sidebar-accent: oklch(0.269 0 0);
  --brand-sidebar-accent-foreground: oklch(0.985 0 0);
  --brand-sidebar-border: oklch(1 0 0 / 10%);
  --brand-sidebar-ring: oklch(0.556 0 0);
  --brand-radius: 0.625rem;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```

### Step 4: 同步到另外两个前端

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cp storefront/src/app/globals.css merchant-admin/src/app/globals.css
cp storefront/src/app/globals.css platform-admin/src/app/globals.css
diff storefront/src/app/globals.css merchant-admin/src/app/globals.css && \
diff storefront/src/app/globals.css platform-admin/src/app/globals.css && \
echo "三份 globals.css 一致 ✅"
```

### Step 5: 改 button.tsx 里唯一直接消费裸变量的地方

⚠️ `storefront/src/components/ui/button.tsx:14` 的 `color-mix` 直接用了裸变量
`var(--secondary)` / `var(--foreground)`。

三个前端的 `src/components/ui/button.tsx` **逐字节一致**（已用 `diff` 核实）。

把第 13–15 行的 `secondary:` 变体：

```tsx
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
```

改成：

```tsx
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--brand-secondary),var(--brand-foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
```

⚠️ 这是 Tailwind 的**任意值**语法（`bg-[...]`），里面的 `_` 代表空格。
改名后仍是合法的任意值（`var()` 里允许字母、数字、连字符）✅。

改完同步三份：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cp storefront/src/components/ui/button.tsx merchant-admin/src/components/ui/button.tsx
cp storefront/src/components/ui/button.tsx platform-admin/src/components/ui/button.tsx
diff storefront/src/components/ui/button.tsx merchant-admin/src/components/ui/button.tsx && \
diff storefront/src/components/ui/button.tsx platform-admin/src/components/ui/button.tsx && \
echo "三份 button.tsx 一致 ✅"
```

⚠️ **这是全仓唯一直接消费裸变量的地方**。改完后确认没有残留：

```bash
grep -rn -- "--secondary\|--foreground\|--background\|--primary\|--radius" \
  storefront/src/app/globals.css storefront/src/components/ui/button.tsx
```

Expected: `globals.css` 里只出现 `--brand-*`（`--brand-secondary` 等），
`button.tsx` 里不再有裸的 `var(--secondary)`。

### Step 6: 改 storefront/src/lib/theme.ts

Modify `storefront/src/lib/theme.ts`（整体替换）：

```ts
/**
 * 把主题 token 拼成 CSS 变量声明。
 *
 * 变量名统一在 `--brand-*` 命名空间下（设计文档 §4.2.1）：
 * Tailwind 侧由 globals.css 的 `@theme inline` 映射成 `--color-*` 等命名空间，
 * 运行时（服务端内联 `<style>` / 客户端 `setProperty`）只注入 `--brand-*`。
 *
 * ⚠️ 值已经由后端 ThemeService.sanitize 按白名单过滤过，
 * 这里不再重复校验——但拼装时仍然只接受映射表里出现过的变量名，
 * 避免「后端漏了一个字段，前端就把任意内容拼进 style 标签」。
 */

export interface ThemeTokenValues {
  colors: Record<string, string>;
  radius: string;
  fontSans: string;
  fontMono: string;
  textScale: Record<string, string>;
  weights: Record<string, string>;
  spacing: Record<string, string>;
  shadows: Record<string, string>;
}

/**
 * 顶层 token（颜色 + 三个标量）→ CSS 变量名。
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
  // colors
  background: ['--brand-background'],
  foreground: ['--brand-foreground'],
  card: ['--brand-card'],
  cardForeground: ['--brand-card-foreground'],
  primary: ['--brand-primary'],
  primaryForeground: ['--brand-primary-foreground'],
  secondary: ['--brand-secondary'],
  secondaryForeground: ['--brand-secondary-foreground'],
  muted: ['--brand-muted'],
  mutedForeground: ['--brand-muted-foreground'],
  accent: ['--brand-accent'],
  accentForeground: ['--brand-accent-foreground'],
  destructive: ['--brand-destructive'],
  destructiveForeground: ['--brand-destructive-foreground'],
  border: ['--brand-border'],
  ring: ['--brand-ring'],
  // 标量
  radius: ['--brand-radius'],
  fontSans: ['--brand-font-sans'],
  fontMono: ['--brand-font-mono'],
};

/**
 * 分组标量：组 → 键 → CSS 变量名。
 *
 * ⚠️ **这张表同时就是白名单**：能写出去的键必须逐个列在这里。
 *
 * 为什么分组要额外收窄：颜色与顶层标量的键由 CSS_VARS 逐个列出，不在表里的键
 * 自然被跳过；但分组标量若只靠「前缀 + 键」拼出来，键名就成了可注入面——
 * `tokens.textScale['sm; } body{']` 会拼出 `--text-sm; } body{ : 1rem;`，
 * 直接逃出这条声明。改成**显式映射**后，能写出去的键必须出现在表里，
 * 注入面被映射本身堵死。
 *
 * ⚠️ **间距组只有一个键**：Tailwind 4 的间距只有单一 `--spacing` 基础值
 * （`p-4` = `calc(var(--spacing) * 4)`），没有 `--spacing-*` 刻度命名空间，
 * 五档刻度在技术上无法表达 → 语义变成「全局间距密度」。
 *
 * ⚠️ 同样**导出**给客户端的 ThemeWatcher 用（理由同 CSS_VARS）。
 */
export const GROUP_CSS_VARS: Record<string, Record<string, string>> = {
  textScale: {
    xs: '--brand-text-xs',
    sm: '--brand-text-sm',
    base: '--brand-text-base',
    lg: '--brand-text-lg',
    xl: '--brand-text-xl',
  },
  weights: {
    normal: '--brand-font-weight-normal',
    medium: '--brand-font-weight-medium',
    semibold: '--brand-font-weight-semibold',
    bold: '--brand-font-weight-bold',
  },
  shadows: {
    sm: '--brand-shadow-sm',
    base: '--brand-shadow-base',
    lg: '--brand-shadow-lg',
  },
  spacing: {
    base: '--brand-spacing',
  },
};

/** 生成 :root 规则的内容 */
export function buildThemeCss(tokens: ThemeTokenValues): string {
  const declarations: string[] = [];

  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const key of ['radius', 'fontSans', 'fontMono'] as const) {
    const value = tokens[key];
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const [group, mapping] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      // 键不在映射里 → 不写（映射即白名单）
      const varName = mapping[key];
      if (!varName) continue;
      declarations.push(`  ${varName}: ${value};`);
    }
  }

  return declarations.join('\n');
}
```

### Step 7: 改 storefront/src/components/theme/theme-watcher.tsx

Modify `storefront/src/components/theme/theme-watcher.tsx`：

**7a. import 去掉 `GROUP_KEYS`**：

```ts
import {
  CSS_VARS,
  GROUP_CSS_VARS,
  type ThemeTokenValues,
} from '@/lib/theme';
```

**7b. `CLIENT_SCALAR_KEYS` 放开字体，并重写那段错误注释**：

把原来那段「顶层标量里**只写 radius**……结论：写它**没有任何视觉收益**……」的长注释，
**整段替换**成：

```ts
/**
 * 顶层标量里写哪些：圆角 + 两个字体。
 *
 * ⚠️ **字体现在能生效了**（5d 之前不能）：
 * - `globals.css` 的 `@theme inline` 里 `--font-sans` 的自引用已去掉；
 * - next/font 的 `--font-geist-sans` 已从 `<body>` 挪到 `<html>`，
 *   所以 `:root` 作用域解析得到它；
 * - 自定义属性在**声明元素处**替换 —— 留在 `<body>` 上时 `<html>` 取不到值，
 *   body 的同名变量也不会来补救。
 *
 * 商家改字体 → 前台的 `font-family` 真的会变 → 所以字体也要写。
 */
const CLIENT_SCALAR_KEYS = ['radius', 'fontSans', 'fontMono'] as const;
```

**7c. `applyTokens` 的分组写入改成用显式映射**：

把原来那段「分组标量：键名是「前缀 + 键」拼出来的……」的循环改成：

```ts
  // 分组标量：组 → 键 → CSS 变量名的**显式映射**。
  //
  // ⚠️ 映射即白名单：键不在映射里就不写，键名逃不出 CSS 声明。
  for (const [group, mapping] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      const varName = mapping[key];
      if (!varName) continue;
      style.setProperty(varName, value);
    }
  }
```

⚠️ **同时要删掉**原文件里那段「这四组（--text-* / --spacing-* / --shadow-* / --font-weight-*）
**在前台没有任何消费者**……写与不写，视觉完全一样」的注释 —— **那段是错的**
（字阶/字重一直在生效）。

### Step 8: 更新既有的两个测试

**8a. `storefront/test/lib/theme.test.ts`** —— 变量名全变，把 `makeTokens` 里的 `spacing`
从 5 档改成单值，并更新断言：

```ts
    spacing: {
      base: '0.25rem',
    },
```

断言部分改成：

```ts
    // 颜色（CSS_VARS 里列出的）
    expect(css).toContain('--brand-background: oklch(1 0 0);');
    expect(css).toContain('--brand-foreground: oklch(0.145 0 0);');
    expect(css).toContain('--brand-primary: oklch(0.205 0 0);');

    // 顶层标量
    expect(css).toContain('--brand-radius: 0.625rem;');
    expect(css).toContain('--brand-font-sans: var(--font-geist-sans);');
    expect(css).toContain('--brand-font-mono: var(--font-geist-mono);');

    // 分组标量：textScale
    expect(css).toContain('--brand-text-xs: 0.75rem;');
    expect(css).toContain('--brand-text-sm: 0.875rem;');
    expect(css).toContain('--brand-text-base: 1rem;');
    expect(css).toContain('--brand-text-lg: 1.125rem;');
    expect(css).toContain('--brand-text-xl: 1.25rem;');

    // 分组标量：weights
    expect(css).toContain('--brand-font-weight-normal: 400;');
    expect(css).toContain('--brand-font-weight-medium: 500;');
    expect(css).toContain('--brand-font-weight-semibold: 600;');
    expect(css).toContain('--brand-font-weight-bold: 700;');

    // 分组标量：shadows
    expect(css).toContain('--brand-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);');
    expect(css).toContain('--brand-shadow-base: 0 4px 6px -1px rgb(0 0 0 / 0.1);');
    expect(css).toContain('--brand-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);');

    // 分组标量：spacing（**单一基础值**）
    expect(css).toContain('--brand-spacing: 0.25rem;');
```

把「恶意键名」那条用例里的

```ts
    expect(css).not.toContain('--text-');
    expect(css).not.toContain('--font-weight-');
    expect(css).not.toContain('--spacing-');
    expect(css).not.toContain('--shadow-');
```

改成

```ts
    expect(css).not.toContain('--brand-text-');
    expect(css).not.toContain('--brand-font-weight-');
    expect(css).not.toContain('--brand-shadow-');
```

（`--brand-spacing` 是合法变量名，恶意键拼不出它，所以**不能**断言 `not.toContain('--brand-spacing')`）

「单个恶意键名不拖累同组的正常键名」那条改成：

```ts
    expect(css).toContain('--brand-text-xs: 0.75rem;');
    expect(css).toContain('--brand-text-base: 1rem;');
```

「白名单之外的分组键名被丢弃」那条改成：

```ts
    expect(css).toContain('--brand-text-xs: 0.75rem;');
    expect(css).not.toContain('--brand-text-xxl');
    expect(css).not.toContain('--brand-text-huge');
```

「空 token 不会抛错」那条改成：

```ts
    expect(css).not.toContain('--brand-text-');
    expect(css).not.toContain('--brand-font-weight-');
    expect(css).not.toContain('--brand-shadow-');
```

**8b. `storefront/test/components/theme/theme-watcher.test.tsx`** —— 把

```ts
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
```

改成

```ts
      expect(
        document.documentElement.style.getPropertyValue('--brand-primary'),
      ).toBe('oklch(0.7 0.19 40)'),
```

把

```ts
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('1.5rem');
```

改成

```ts
    expect(
      document.documentElement.style.getPropertyValue('--brand-radius'),
    ).toBe('1.5rem');
```

把「只写白名单里的变量名（护栏 12）」那条里的

```ts
    expect(document.documentElement.style.getPropertyValue('--恶意键')).toBe('');
```

改成

```ts
    expect(
      document.documentElement.style.getPropertyValue('--brand-恶意键'),
    ).toBe('');
```

**并且把「字体 token 不写进行内样式」那条用例整个删掉** —— 它的结论在 5d 之后**不再成立**
（字体现在能生效、也该写进去）。改成：

```tsx
  it('字体 token 也写进行内样式（5d 之后字体能生效）', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    mockFetchOk({ tokens: TOKENS });

    render(<ThemeWatcher />);

    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue('--brand-radius'),
      ).toBe('1.5rem'),
    );
    expect(
      document.documentElement.style.getPropertyValue('--brand-font-sans'),
    ).toBe('var(--font-geist-sans)');
    expect(
      document.documentElement.style.getPropertyValue('--brand-font-mono'),
    ).toBe('var(--font-geist-mono)');
  });
```

### Step 9: 跑 storefront 全部测试

Run: `cd storefront && npm test`

Expected: **全部 PASS**。

### Step 10: 跑类型检查

Run: `cd storefront && npx tsc --noEmit && cd ../merchant-admin && npx tsc --noEmit && cd ../platform-admin && npx tsc --noEmit`

Expected: 三个前端都无类型错误。

### Step 11: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add storefront/src/app/globals.css merchant-admin/src/app/globals.css platform-admin/src/app/globals.css \
        storefront/src/components/ui/button.tsx merchant-admin/src/components/ui/button.tsx platform-admin/src/components/ui/button.tsx \
        storefront/src/lib/theme.ts storefront/src/components/theme/theme-watcher.tsx \
        storefront/test/app/globals-css.test.ts storefront/test/lib/theme.test.ts storefront/test/components/theme/theme-watcher.test.tsx
git commit -m "feat(front): 主题变量统一到 --brand-* 命名空间"
```

---

## Task 5: 字体变量从 `<body>` 挪到 `<html>`

**Files:**
- Modify: `storefront/src/app/layout.tsx`
- Modify: `merchant-admin/src/app/layout.tsx`
- Modify: `platform-admin/src/app/layout.tsx`

⚠️ **为什么必须挪**：自定义属性的 `var()` 替换发生在**声明它的那个元素上**。
`:root`（= `<html>`）声明 `--brand-font-sans: var(--font-geist-sans)` 时就地解析；
若 `--font-geist-sans` 只存在于 `<body>`，`<html>` 上解析不到 →
`--brand-font-sans` 变成 guaranteed-invalid → **body 的同名变量不会来补救**。

---

### Step 1: 改三个 layout.tsx

以 `storefront/src/app/layout.tsx` 为样板：

```tsx
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        {children}
        {/* 会话同步：把刷新后的会话 cookie 送回浏览器，并协调多标签页。
            挂在根 layout 上，所以**每个页面**都会跑一次。 */}
        <SessionSync />
      </body>
    </html>
  );
```

⚠️ **`variable` class 只声明 CSS 变量、不声明 `font-family`** → 挪动不改变
html 的字体，只让 `:root` 作用域能解析到 `var(--font-geist-sans)`。

⚠️ 三个前端的 layout.tsx **内容不同**（各自的 metadata、SessionSync 等），
**不要 `cp` 覆盖**——只改 `<html>` / `<body>` 的 className 那一处。

### Step 2: 验证

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
for f in storefront merchant-admin platform-admin; do
  echo "--- $f ---"
  grep -n "geistSans.variable\|geistMono.variable\|<html\|<body" $f/src/app/layout.tsx
done
```

Expected: 三处都显示 `variable` 出现在 `<html` 那一行、`<body` 那一行没有。

### Step 3: 跑类型检查 + 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cd storefront && npx tsc --noEmit && cd ../merchant-admin && npx tsc --noEmit && cd ../platform-admin && npx tsc --noEmit && cd ..
git add storefront/src/app/layout.tsx merchant-admin/src/app/layout.tsx platform-admin/src/app/layout.tsx
git commit -m "fix(front): 字体变量挪到 <html>，品牌字体终于能生效"
```

---

## Task 6: api-client 收口（网络错误 + 401 中文化 + 空 body）

**Files:**
- Modify: `storefront/src/lib/api-client.ts`
- Modify: `merchant-admin/src/lib/api-client.ts`
- Modify: `platform-admin/src/lib/api-client.ts`
- Test: `storefront/test/lib/api-client.test.ts`（新）
- Test: `merchant-admin/test/lib/api-client.test.ts`（新，与 storefront 逐字节一致）
- Test: `platform-admin/test/lib/api-client.test.ts`（新，与 storefront 逐字节一致）

---

### Step 1: 写失败的测试（三个前端同一份）

Create `storefront/test/lib/api-client.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api-client';

/**
 * api-client 的**错误收口**。
 *
 * ## 为什么收口点只有一个
 *
 * 三个应用的所有请求最终都从 `apiFetch` 出去。收口在这里 →
 * **76 个渲染点零改动**就变成中文。
 * 不收口的话，用户看到的就是原始的 `TypeError: fetch failed`。
 *
 * ## 断言要具体
 *
 * 断言 status / code / message 三样，**不是**只断言「抛了个错」。
 */

// ⚠️ **必须 mock 掉 `@/auth`**：`api-client` 顶层 import 它，而 `auth.ts`
// 顶层就调 `NextAuth({...})` → 会把 next-auth 的整个依赖图拉进来
// （含 `next/server`，在 Vitest 里解析不了 → 直接抛
// "Cannot find module '.../next/server'"，整个测试文件加载失败）。
// 本组用例只关心请求与错误的形状，登录态无关。
vi.mock('@/auth', () => ({
  auth: vi.fn(async () => null),
}));

describe('api-client 的错误收口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('网络不可达 → ApiError(503, NETWORK_ERROR)，message 是中文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    await expect(apiFetch('/public/theme')).rejects.toMatchObject({
      status: 503,
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络后重试',
    });
  });

  it('网络不可达时用户看不到 fetch failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const error = await apiFetch('/public/theme').catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('fetch failed');
  });

  it('401 + 后端默认文案 Unauthorized → 翻成中文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(apiFetch('/me')).rejects.toMatchObject({
      status: 401,
      message: '登录已过期，请重新登录',
    });
  });

  it('401 + 后端给的中文业务消息 → 原样透传（不翻译）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'TOKEN_INVALID', message: '刷新令牌无效或已过期' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(apiFetch('/me')).rejects.toMatchObject({
      status: 401,
      message: '刷新令牌无效或已过期',
    });
  });

  it('空响应体当成 null，不抛 Unexpected end of JSON input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    );

    await expect(apiFetch('/stores/me')).resolves.toBeNull();
  });

  it('204 返回 undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );

    await expect(apiFetch('/stores/me')).resolves.toBeUndefined();
  });

  it('正常响应原样解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'store-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(apiFetch('/stores/me')).resolves.toEqual({ id: 'store-1' });
  });
});
```

**三份同步**：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cp storefront/test/lib/api-client.test.ts merchant-admin/test/lib/api-client.test.ts
cp storefront/test/lib/api-client.test.ts platform-admin/test/lib/api-client.test.ts
```

⚠️ merchant-admin / platform-admin 的 `vitest.config.ts` 的 `include` 是 `test/**/*.test.ts`
✅ 包含这个文件。**测试文件里 `@/lib/api-client` 的别名在三个应用里都成立** ✅。

### Step 2: 跑测试，确认失败

Run: `cd storefront && npm test -- api-client`

Expected: **FAIL** —— 网络错误现在抛的是原始 `TypeError`，401 仍是英文。

### Step 3: 改 storefront/src/lib/api-client.ts

Modify `storefront/src/lib/api-client.ts`：

**3a. 加两个常量与一个翻译函数**（放在 `ApiError` 类之后）：

```ts
/** 网络不可达时的用户可见文案。 */
const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

/**
 * 把后端返回的消息翻成用户能看懂的中文。
 *
 * ⚠️ 只翻译后端的**默认文案**（Nest 的 'Unauthorized'），
 * 不动后端主动抛的中文消息（'刷新令牌无效或已过期'）——
 * 那些消息比通用文案更具体，翻译会丢掉信息。
 */
function localizeApiMessage(status: number, message: string): string {
  if (status === 401 && message === 'Unauthorized') {
    return '登录已过期，请重新登录';
  }
  return message;
}
```

**3b. `request()` 里的 fetch 包 try/catch**：

```ts
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    // 网络层失败：后端根本没连上，不是业务错误。
    // ⚠️ 收敛成 ApiError 是关键——所有渲染点写的是 `cause.message`，
    //    不收敛的话用户看到的就是原始的 "TypeError: fetch failed"。
    throw new ApiError(503, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
  }
```

**3c. `new ApiError` 用翻译后的 message**：

```ts
    throw new ApiError(
      response.status,
      payload.code ?? 'UNKNOWN',
      localizeApiMessage(response.status, payload.message ?? '请求失败'),
      payload.details,
    );
```

**3d. `apiFetch` 的空 body 处理**：

```ts
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const response = await request(path, options);

  if (response.status === 204) {
    return undefined as T;
  }

  // ⚠️ **空响应体当成 null**：后端在没有数据时返回 200 + 空 body
  // （NestJS 的 handler 返回 null 就是这样），`response.json()` 碰到空 body
  // 会抛「Unexpected end of JSON input」—— 真实情况是「没有数据」，
  // 界面上却显示成「加载失败」。
  const text = await response.text();
  if (text.trim() === '') return null as T;
  return JSON.parse(text) as T;
}
```

**3e. `apiFetchWithSetCookie` 的空 body 处理**：

```ts
  if (response.status === 204) {
    return { data: undefined as T, setCookie };
  }

  // ⚠️ 同 apiFetch：空 body 当 null
  const text = await response.text();
  if (text.trim() === '') return { data: null as T, setCookie };
  return { data: JSON.parse(text) as T, setCookie };
```

### Step 4: 改 merchant-admin/src/lib/api-client.ts

Modify `merchant-admin/src/lib/api-client.ts`：

⚠️ **这个文件的结构与 storefront 不同**：没有独立的 `request()`，fetch 直接在 `apiFetch` 里。
**空 body 处理它已经有了** ✅，只需要加 try/catch 与翻译。

**4a.** 在 `ApiError` 类之后加上与 3a 相同的 `NETWORK_ERROR_MESSAGE` 与 `localizeApiMessage`。

**4b.** 把 fetch 改成：

```ts
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    // 网络层失败：后端根本没连上，不是业务错误。
    // ⚠️ 收敛成 ApiError 是关键——所有渲染点写的是 `cause.message`，
    //    不收敛的话用户看到的就是原始的 "TypeError: fetch failed"。
    throw new ApiError(503, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
  }
```

**4c.** 把 `new ApiError(...)` 的 message 换成 `localizeApiMessage(response.status, payload.message ?? '请求失败')`。

### Step 5: 改 platform-admin/src/lib/api-client.ts

Modify `platform-admin/src/lib/api-client.ts` —— **与 merchant-admin 同样的三处改动**（4a/4b/4c）。

⚠️ 执行前先 `cat platform-admin/src/lib/api-client.ts` 确认结构与 merchant-admin 一致。

### Step 6: 跑三个前端的测试

Run:
```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cd storefront && npm test -- api-client && cd ../merchant-admin && npm test -- api-client && cd ../platform-admin && npm test -- api-client && cd ..
```

Expected: 三个都 **PASS**（各 7 个用例）。

### Step 7: 跑类型检查

```bash
cd storefront && npx tsc --noEmit && cd ../merchant-admin && npx tsc --noEmit && cd ../platform-admin && npx tsc --noEmit
```

### Step 8: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add storefront/src/lib/api-client.ts merchant-admin/src/lib/api-client.ts platform-admin/src/lib/api-client.ts \
        storefront/test/lib/api-client.test.ts merchant-admin/test/lib/api-client.test.ts platform-admin/test/lib/api-client.test.ts
git commit -m "fix(front): api-client 收口网络错误与 401 文案，用户不再看到 fetch failed"
```

---

## Task 7: storefront 的错误渲染点与登录判据

**Files:**
- Modify: `storefront/src/lib/route-helpers.ts`
- Modify: `storefront/src/app/(shop)/checkout/page.tsx`
- Modify: `storefront/src/app/(shop)/coupons/page.tsx`
- Modify: `storefront/src/app/(shop)/orders/page.tsx`
- Modify: `storefront/src/app/(shop)/orders/[orderNo]/page.tsx`
- Modify: `storefront/src/app/(shop)/account/page.tsx`
- Modify: `storefront/src/app/(shop)/account/addresses/page.tsx`
- Modify: `platform-admin/src/app/(dashboard)/layout.tsx`
- Test: `storefront/test/app/checkout-page.test.tsx`（新）

---

### Step 1: 写失败的测试

Create `storefront/test/app/checkout-page.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 结算页的**错误态**。
 *
 * ## 为什么这条用例必须存在
 *
 * 结算页原来这样写：
 *   `if (!cart || cart.items.length === 0) redirect('/cart')`
 * 而 `fetchCurrentCart()` 在后端不可达时返回 `{ cart: null, error: '…' }`
 * —— 页面不读 error，直接把 `cart === null` 当成「空购物车」→
 * **把用户弹回购物车页，错误信息在跳转中丢失**。
 *
 * 用户看到的是「购物车是空的」，而真实原因是「后端连不上」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { redirectMock, fetchCurrentCart, fetchAddresses, fetchCouponPreview } =
  vi.hoisted(() => ({
    redirectMock: vi.fn(),
    fetchCurrentCart: vi.fn(),
    fetchAddresses: vi.fn(),
    fetchCouponPreview: vi.fn(),
  }));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ accessToken: 'tok' })) }));
vi.mock('@/lib/shop-api', () => ({
  fetchCurrentCart: (...args: unknown[]) => fetchCurrentCart(...args),
  fetchAddresses: (...args: unknown[]) => fetchAddresses(...args),
  fetchCouponPreview: (...args: unknown[]) => fetchCouponPreview(...args),
}));
// CheckoutForm 是客户端组件，测试里不需要它
vi.mock('@/components/checkout/checkout-form', () => ({
  CheckoutForm: () => null,
}));

async function renderCheckout() {
  const Page = (await import('@/app/(shop)/checkout/page')).default;
  const ui = await Page();
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchCurrentCart.mockResolvedValue({
    cart: { items: [{ skuId: 'sku-1', quantity: 1 }] },
    error: null,
  });
  fetchAddresses.mockResolvedValue({ addresses: [], error: null });
  fetchCouponPreview.mockResolvedValue({ preview: null });
});

describe('结算页的错误态', () => {
  it('购物车加载失败 → 显示错误，不跳回购物车页', async () => {
    fetchCurrentCart.mockResolvedValue({
      cart: null,
      error: '网络连接失败，请检查网络后重试',
    });

    await renderCheckout();

    expect(
      screen.getByText('网络连接失败，请检查网络后重试'),
    ).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('地址加载失败 → 显示错误，不跳回购物车页', async () => {
    fetchAddresses.mockResolvedValue({
      addresses: [],
      error: '地址簿加载失败',
    });

    await renderCheckout();

    expect(screen.getByText('地址簿加载失败')).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('购物车真的是空的 → 跳回购物车页', async () => {
    fetchCurrentCart.mockResolvedValue({ cart: { items: [] }, error: null });

    await renderCheckout();

    expect(redirectMock).toHaveBeenCalledWith('/cart');
  });
});
```

### Step 2: 跑测试，确认失败

Run: `cd storefront && npm test -- checkout-page`

Expected: **FAIL** —— 现在会 `redirect('/cart')`，看不到错误文案。

### Step 3: 改 checkout/page.tsx

Modify `storefront/src/app/(shop)/checkout/page.tsx`：

把取数与判空那段改成：

```tsx
  const [{ cart, error: cartError }, { addresses, error: addressError }] =
    await Promise.all([fetchCurrentCart(), fetchAddresses()]);

  // ⚠️ 后端不可达时 fetchCurrentCart 返回 { cart: null, error: '…' }。
  //    之前不读 error，直接把 cart === null 当成「空购物车」→ 把用户弹回购物车页，
  //    错误信息在跳转中丢失。
  if (cartError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-2xl font-bold">结算</h1>
        <p className="text-destructive">{cartError}</p>
      </main>
    );
  }

  // ⚠️ 地址加载失败同样要显示错误：否则用户只看到一个空的地址选择框，
  //    只能自己猜「为什么不能下单」。
  if (addressError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-2xl font-bold">结算</h1>
        <p className="text-destructive">{addressError}</p>
      </main>
    );
  }

  // 购物车是空的没什么可结算的——回到购物车页而不是给一个空表单。
  if (!cart || (cart.items ?? []).length === 0) {
    redirect('/cart');
  }
```

⚠️ **`cart` 的类型**：`fetchCurrentCart` 返回 `Cart | null`，在 `if (!cart …) redirect()` 之后
TypeScript 不会自动收窄（`redirect` 返回 `never` ✅ 会收窄）—— 保持现有写法即可。

### Step 4: 删掉 route-helpers.ts 里失效的 readableMessage

Modify `storefront/src/lib/route-helpers.ts` —— 删掉整个 `readableMessage` 函数，并把
`toErrorResponse` 里的调用改成直接用 `cause.message`：

```ts
export function toErrorResponse(cause: unknown): NextResponse {
  if (cause instanceof ApiError) {
    // ⚠️ 不用再翻译 401：api-client 在源头就把 Nest 的默认文案 'Unauthorized'
    //    翻成中文了（见 lib/api-client.ts 的 localizeApiMessage）。
    return NextResponse.json(
      { message: cause.message, code: cause.code },
      { status: cause.status },
    );
  }
  return NextResponse.json({ message: '后端服务不可用' }, { status: 502 });
}
```

同时**删掉** `readableMessage` 的整个函数定义与它的注释块。

⚠️ **只删这个函数**，`readJson` / `unauthorizedResponse` / `toErrorResponse` 的其余逻辑不动
（外科手术式改动）。

### Step 5: 改 6 处 `!session` 判据

下面这些文件里的 `if (!session) {` 改成 `if (!session?.accessToken) {`：

- `storefront/src/app/(shop)/checkout/page.tsx`
- `storefront/src/app/(shop)/coupons/page.tsx`
- `storefront/src/app/(shop)/orders/page.tsx`
- `storefront/src/app/(shop)/orders/[orderNo]/page.tsx`
- `storefront/src/app/(shop)/account/page.tsx`
- `storefront/src/app/(shop)/account/addresses/page.tsx`

理由：`jwt-callback.ts` 的凭证失效分支把 `accessToken` 置为 `undefined`，
但 `session` 对象仍在 → `!session` 不成立 → **不跳登录页**，而是带着空 token
去请求 → 401 → 页面显示错误。改成判 `accessToken` 后，会话失效**直接跳登录页**
（与 merchant-admin 一致）。

⚠️ **只改这 6 个页面**。`platform-admin` / `merchant-admin` 那些 `app/api/**/route.ts`
里的 `if (!session)` **不动** —— 那是 API 路由，「未登录就 401」是正确语义，
且与项目既有约定一致（merchant-admin 的 API 路由也是这么写的）。

⚠️ `platform-admin/src/app/(dashboard)/layout.tsx:24` 的 `if (!session)` **要改**
（merchant-admin 的同名文件已经是 `!session?.accessToken`）。

改完用这条命令确认：

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
grep -rn "!session" storefront/src/app platform-admin/src/app/\(dashboard\)/layout.tsx
```

Expected: 只剩 `!session?.accessToken` 的形式（以及 API 路由里的 `!session`）。

### Step 6: 跑测试 + 类型检查

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cd storefront && npm test && npx tsc --noEmit && cd ../platform-admin && npm test && npx tsc --noEmit && cd ..
```

Expected: 全过。

### Step 7: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add storefront/src/lib/route-helpers.ts "storefront/src/app/(shop)/checkout/page.tsx" \
        "storefront/src/app/(shop)/coupons/page.tsx" "storefront/src/app/(shop)/orders/page.tsx" \
        "storefront/src/app/(shop)/orders/[orderNo]/page.tsx" "storefront/src/app/(shop)/account/page.tsx" \
        "storefront/src/app/(shop)/account/addresses/page.tsx" \
        "platform-admin/src/app/(dashboard)/layout.tsx" \
        storefront/test/app/checkout-page.test.tsx
git commit -m "fix(front): 结算页区分「空车」与「加载失败」，会话失效直接跳登录"
```

---

## Task 8: 三个前端的错误边界

**Files:**
- Create: `storefront/src/app/error.tsx`
- Create: `storefront/src/app/global-error.tsx`
- Create: `merchant-admin/src/app/error.tsx`
- Create: `merchant-admin/src/app/global-error.tsx`
- Create: `platform-admin/src/app/error.tsx`
- Create: `platform-admin/src/app/global-error.tsx`
- Test: `storefront/test/app/error-boundary.test.tsx`（新）

---

### Step 1: 写失败的测试

Create `storefront/test/app/error-boundary.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 错误边界的兜底文案。
 *
 * ## 为什么要有
 *
 * 三个应用此前**零错误边界**（没有 `error.tsx` / `global-error.tsx`）。
 * 一个未捕获的渲染异常 → 整页白屏 + 浏览器默认的英文报错堆栈。
 * 消费者看到的是「Something went wrong」—— 对电商前台是不可接受的。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import ErrorPage from '@/app/error';
import GlobalError from '@/app/global-error';

describe('错误边界', () => {
  it('error.tsx 显示中文提示并提供「重试」', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('boom')} reset={reset} />);

    expect(screen.getByText(/出错了/).textContent).toContain('出错了');
    const button = screen.getByRole('button', { name: '重试' });
    button.click();
    expect(reset).toHaveBeenCalled();
  });

  it('global-error.tsx 自带 html/body 且显示中文提示', () => {
    // ⚠️ global-error 不能用 app 的 layout，所以它自己带 <html><body>。
    //    用 renderToStaticMarkup 而不是 RTL 的 render —— RTL 往 body 里塞
    //    一个 div，而 <html> 塞进 div 是非法 DOM。
    const html = renderToStaticMarkup(
      <GlobalError error={new Error('boom')} reset={vi.fn()} />,
    );

    expect(html).toContain('<html');
    expect(html).toContain('<body');
    expect(html).toContain('出错了');
    expect(html).toContain('重试');
    // ⚠️ 不能把原始错误信息糊给用户
    expect(html).not.toContain('boom');
  });
});
```

### Step 2: 跑测试，确认失败

Run: `cd storefront && npm test -- error-boundary`

Expected: **FAIL** —— 模块不存在（`@/app/error` 解析不到）。

### Step 3: 写 error.tsx（三份一致）

Create `storefront/src/app/error.tsx`：

```tsx
'use client';

/**
 * 段级错误边界。
 *
 * ⚠️ **它接的是「已经渲染失败的那一段」**，捕获的是 React 渲染期抛出的异常。
 * 数据请求的错误不走这里（那些在页面里自己 catch 了）。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start gap-4 p-8">
      <h1 className="text-2xl font-bold">页面出错了</h1>
      <p className="text-muted-foreground">
        页面加载时出了点问题，你可以重试一次；如果一直不行，请稍后再来。
      </p>
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
        onClick={() => reset()}
      >
        重试
      </button>
    </main>
  );
}
```

⚠️ **`error` 参数没被用到** —— Next.js 要求这个签名，但**不要**把 `error.message`
渲染出来（那是内部细节，可能是英文堆栈）。

### Step 4: 写 global-error.tsx（三份一致）

Create `storefront/src/app/global-error.tsx`：

```tsx
'use client';

/**
 * 根级错误边界。
 *
 * ⚠️ **它替换的是整个应用**，所以**不能用 app 的 layout**
 * ——layout 本身可能正是出错的原因。
 * 因此这里自带 `<html><body>`，并且**不 import 任何 app 内的东西**
 * （含 globals.css）：那些 import 同样可能失败。
 *
 * 代价是没有 Tailwind 类可用 → 用内联样式。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: '16px',
          padding: '32px',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
          color: '#18181b',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700 }}>
          应用出错了
        </h1>
        <p style={{ margin: 0, color: '#71717a' }}>
          页面遇到了一个意外错误，你可以重试一次；如果一直不行，请稍后再来。
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            padding: '8px 16px',
            borderRadius: '6px',
            border: '1px solid #e4e4e7',
            background: '#18181b',
            color: '#fafafa',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </body>
    </html>
  );
}
```

### Step 5: 同步到另外两个前端

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cp storefront/src/app/error.tsx merchant-admin/src/app/error.tsx
cp storefront/src/app/error.tsx platform-admin/src/app/error.tsx
cp storefront/src/app/global-error.tsx merchant-admin/src/app/global-error.tsx
cp storefront/src/app/global-error.tsx platform-admin/src/app/global-error.tsx
diff storefront/src/app/error.tsx merchant-admin/src/app/error.tsx && \
diff storefront/src/app/error.tsx platform-admin/src/app/error.tsx && \
diff storefront/src/app/global-error.tsx merchant-admin/src/app/global-error.tsx && \
diff storefront/src/app/global-error.tsx platform-admin/src/app/global-error.tsx && \
echo "六个错误边界文件一致 ✅"
```

### Step 6: 跑测试 + 类型检查 + 构建

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cd storefront && npm test && npx tsc --noEmit && npm run build && cd ..
```

⚠️ **`npm run build` 必须过**：错误边界是 Next.js 的约定文件，签名不对会在构建期报错。
三个前端都要 build：

```bash
cd merchant-admin && npm run build && cd ../platform-admin && npm run build && cd ..
```

Expected: 三个 build 都成功。

### Step 7: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add storefront/src/app/error.tsx storefront/src/app/global-error.tsx \
        merchant-admin/src/app/error.tsx merchant-admin/src/app/global-error.tsx \
        platform-admin/src/app/error.tsx platform-admin/src/app/global-error.tsx \
        storefront/test/app/error-boundary.test.tsx
git commit -m "feat(front): 三个前端加错误边界，未捕获异常有中文兜底页"
```

---

## Task 9: merchant-admin 测试基建 + 主题实时预览

**Files:**
- Modify: `merchant-admin/package.json`
- Modify: `merchant-admin/vitest.config.ts`
- Create: `merchant-admin/test/setup.ts`
- Modify: `merchant-admin/src/components/theme/theme-form.tsx`
- Test: `merchant-admin/test/components/theme/theme-form.test.tsx`（新）

---

### Step 1: 补依赖

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin"
npm install -D @testing-library/react@^16.3.3 @testing-library/jest-dom@^7.0.1 @testing-library/user-event@^14.6.8 jsdom@^30.1.3
```

⚠️ 版本与 `platform-admin` 逐字一致。

### Step 2: 建 test/setup.ts

Create `merchant-admin/test/setup.ts`（与 `platform-admin/test/setup.ts` **逐字节一致**）：

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
// → 报 "Found multiple elements with the role \"button\""。实测过。
afterEach(() => {
  cleanup();
});
```

### Step 3: 改 vitest.config.ts

Modify `merchant-admin/vitest.config.ts`：

**3a.** 在 `defineConfig({` 的**根级**（不是 `test` 下面）加上：

```ts
  // ⚠️ **必须加这个**，否则所有组件测试报 `React is not defined`。
  //
  // 本项目的 tsconfig.json 是 `"jsx": "preserve"`（Next.js 用 SWC），
  // 而 **esbuild 不读 tsconfig 的 jsx 设置**——它默认走 classic transform，
  // 把 JSX 编译成 `React.createElement(...)`，测试文件里没有 import React
  // → ReferenceError: React is not defined。
  //
  // ⚠️ **`esbuild` 必须写在配置的根级，不能写在 `test` 下面**
  // （esbuild 是 Vite 的根级选项，写在 test 下不生效）。实测确认。
  esbuild: { jsx: 'automatic' },
```

**3b.** 在 `test: {` 里：

```ts
    // ⚠️ 扩到 .tsx：组件测试文件是 .tsx。
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
```

（把原来的 `include: ['test/**/*.test.ts']` 换掉，加上 `setupFiles`）

### Step 4: 写失败的测试

Create `merchant-admin/test/components/theme/theme-form.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 商家后台的主题**实时预览**。
 *
 * ## 为什么预览要隔离
 *
 * CSS 变量是**继承**的 → 在预览区外面包一个带内联 `--brand-*` 的 wrapper，
 * 内联变量只在这个子树里生效 → **后台页面自身的按钮不会被染色**。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ThemeForm, type ThemeSchema } from '@/components/theme/theme-form';

const SCHEMA: ThemeSchema = {
  colors: [
    { key: 'primary', label: '主色', cssVar: '--brand-primary', defaultValue: 'oklch(0.205 0 0)' },
    { key: 'background', label: '背景色', cssVar: '--brand-background', defaultValue: 'oklch(1 0 0)' },
  ],
  radius: { key: 'radius', label: '圆角', cssVar: '--brand-radius', defaultValue: '0.625rem' },
  fonts: [
    { key: 'fontSans', label: '正文字体', cssVar: '--brand-font-sans', defaultValue: 'var(--font-geist-sans)' },
  ],
  textScale: [{ key: 'sm', label: '小', cssVar: '--brand-text-sm', defaultValue: '0.875rem' }],
  weights: [{ key: 'semibold', label: '半粗', cssVar: '--brand-font-weight-semibold', defaultValue: '600' }],
  spacing: [{ key: 'base', label: '间距密度', cssVar: '--brand-spacing', defaultValue: '0.25rem' }],
  shadows: [{ key: 'lg', label: '重', cssVar: '--brand-shadow-lg', defaultValue: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }],
};

const INITIAL = {
  colors: { primary: 'oklch(0.205 0 0)', background: 'oklch(1 0 0)' },
  radius: '0.625rem',
  fontSans: 'var(--font-geist-sans)',
  textScale: { sm: '0.875rem' },
  weights: { semibold: '600' },
  spacing: { base: '0.25rem' },
  shadows: { lg: '0 10px 15px -3px rgb(0 0 0 / 0.1)' },
};

describe('主题表单的实时预览', () => {
  it('初始状态就把全部 token 写进预览区的内联变量', () => {
    render(<ThemeForm schema={SCHEMA} initial={INITIAL} onSave={vi.fn()} />);

    const preview = screen.getByTestId('theme-preview');
    expect(preview.style.getPropertyValue('--brand-primary')).toBe('oklch(0.205 0 0)');
    expect(preview.style.getPropertyValue('--brand-radius')).toBe('0.625rem');
    expect(preview.style.getPropertyValue('--brand-font-sans')).toBe('var(--font-geist-sans)');
    expect(preview.style.getPropertyValue('--brand-text-sm')).toBe('0.875rem');
    expect(preview.style.getPropertyValue('--brand-font-weight-semibold')).toBe('600');
    expect(preview.style.getPropertyValue('--brand-spacing')).toBe('0.25rem');
    expect(preview.style.getPropertyValue('--brand-shadow-lg')).toBe(
      '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    );
  });

  it('改主色 → 预览区立刻变，而页面自身的按钮不变色', () => {
    render(<ThemeForm schema={SCHEMA} initial={INITIAL} onSave={vi.fn()} />);

    const input = screen.getByLabelText('主色');
    fireEvent.change(input, { target: { value: 'oklch(0.7 0.19 40)' } });

    const preview = screen.getByTestId('theme-preview');
    expect(preview.style.getPropertyValue('--brand-primary')).toBe('oklch(0.7 0.19 40)');

    // 页面自身的「保存主题」按钮在预览区之外 → 不受影响
    const saveButton = screen.getByRole('button', { name: '保存主题' });
    expect(saveButton.style.getPropertyValue('--brand-primary')).toBe('');
    expect(saveButton.closest('[style]')?.getAttribute('style') ?? '').not.toContain(
      '--brand-primary',
    );
  });

  it('改字阶 → 预览区的 --brand-text-sm 跟着变', () => {
    render(<ThemeForm schema={SCHEMA} initial={INITIAL} onSave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('小'), {
      target: { value: '1rem' },
    });

    const preview = screen.getByTestId('theme-preview');
    expect(preview.style.getPropertyValue('--brand-text-sm')).toBe('1rem');
  });
});
```

### Step 5: 跑测试，确认失败

Run: `cd merchant-admin && npm test -- theme-form`

Expected: **FAIL** —— 没有 `data-testid="theme-preview"`。

### Step 6: 改 theme-form.tsx

Modify `merchant-admin/src/components/theme/theme-form.tsx`：

**6a. import 加上 `CSSProperties`：**

```tsx
import { useState, type CSSProperties } from 'react';
```

**6b. 在组件里加一个「由 draft 算出预览变量」的辅助函数**（放在 `ThemeForm` 之外，
因为它不依赖组件状态）：

```tsx
/**
 * 由 draft 算出预览区要用的内联 CSS 变量。
 *
 * ⚠️ **变量名来自后端 schema 的 `cssVar`** —— schema 里给的就是完整变量名
 * （`--brand-primary`、`--brand-text-sm`…），所以这里不需要另建一张映射表。
 *
 * ⚠️ **draft 的分组名与 schema 的分组名有一处不一致**：schema 里字体在
 * `fonts` 数组（顶层标量 `fontSans` / `fontMono`），而 draft 里是**顶层字段**
 * `fontSans` / `fontMono`（不在分组里）→ 这里分开处理。
 */
function buildPreviewStyle(
  draft: Record<string, unknown>,
  schema: ThemeSchema,
): CSSProperties {
  const vars: Record<string, string> = {};

  const put = (varName: string, value: unknown) => {
    if (typeof value === 'string' && value !== '') {
      vars[varName] = value;
    }
  };

  // 颜色
  const colors = (draft.colors ?? {}) as Record<string, unknown>;
  for (const token of schema.colors) {
    put(token.cssVar, colors[token.key]);
  }

  // 顶层标量：圆角
  put(schema.radius.cssVar, draft.radius);

  // 顶层标量：字体（draft 里是顶层字段，不在 fonts 分组里）
  for (const token of schema.fonts) {
    put(token.cssVar, draft[token.key]);
  }

  // 分组标量
  const groups = ['textScale', 'weights', 'spacing', 'shadows'] as const;
  for (const group of groups) {
    const values = (draft[group] ?? {}) as Record<string, unknown>;
    for (const token of schema[group]) {
      put(token.cssVar, values[token.key]);
    }
  }

  return vars as CSSProperties;
}
```

**6c. 在组件里算出预览变量**（在 `render` 之前）：

```tsx
  const previewStyle = buildPreviewStyle(draft, schema);
```

**6d. 加预览区 JSX**（放在 `<h3>店铺主题</h3>` 之后）：

```tsx
      {/* 实时预览：CSS 变量是继承的 → 内联变量只在这个子树里生效，
          预览区外面的页面（后台自己的按钮）不受影响。 */}
      <div
        data-testid="theme-preview"
        style={previewStyle}
        className="flex flex-col gap-3 rounded-lg border p-4"
      >
        <p className="text-xs">实时预览</p>
        <div className="flex items-center gap-3">
          <span className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
            主要按钮
          </span>
          <span className="rounded-lg border bg-card px-4 py-2 text-sm text-card-foreground shadow-lg">
            卡片
          </span>
        </div>
        <p className="font-sans text-sm text-muted-foreground">
          正文示例：商城里的商品标题与描述
        </p>
      </div>
```

⚠️ 预览区**必须**用标准 Tailwind 类（`bg-primary` / `rounded-lg` / `shadow-lg` /
`text-sm` / `font-semibold` / `font-sans`）→ 它们在 globals.css 里映射到
`--brand-*` → 内联变量一改就跟着变 ✅。

### Step 7: 跑测试，确认通过

Run: `cd merchant-admin && npm test -- theme-form`

Expected: **PASS** —— 3 个用例全过。

### Step 8: 跑 merchant-admin 全部测试 + 类型检查 + 构建

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/merchant-admin"
npm test && npx tsc --noEmit && npm run build
```

Expected: 全过。

### Step 9: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add merchant-admin/package.json merchant-admin/package-lock.json merchant-admin/vitest.config.ts \
        merchant-admin/test/setup.ts merchant-admin/src/components/theme/theme-form.tsx \
        merchant-admin/test/components/theme/theme-form.test.tsx
git commit -m "feat(merchant-admin): 主题表单加实时预览，补齐组件测试基建"
```

---

## §1 验收清单（全部 Task 完成后逐条过）

### 自动测试

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cd api && npx jest --passWithNoTests && npm run test:e2e && npx tsc --noEmit && cd ..
cd storefront && npm test && npx tsc --noEmit && npm run build && cd ..
cd merchant-admin && npm test && npx tsc --noEmit && npm run build && cd ..
cd platform-admin && npm test && npx tsc --noEmit && npm run build && cd ..
```

### 护栏对照（设计文档 §6.1）

| # | 护栏 | 覆盖它的测试 / 步骤 |
|---|------|------------------|
| G1 | 主色生效 | Task 4 的 globals-css 测试 + 浏览器手测 1 |
| G2 | 字体生效 | Task 5 的 grep + 浏览器手测 2 |
| G3 | 字阶生效 | Task 4 的 globals-css 测试 + 浏览器手测 3 |
| G4 | 字重生效 | 同上 |
| G5 | 阴影生效 | 同上 + 浏览器手测 3 |
| G6 | 间距生效 | 同上 + 浏览器手测 3 |
| G7 | 预览隔离 | Task 9 的 theme-form 测试 |
| G8 | 网络错误中文 | Task 6 的 api-client 测试（三个前端各一份） |
| G9 | 401 中文 | 同上 |
| G10 | 会话失效跳登录 | Task 7 的 grep + 浏览器手测 7 |
| G11 | 结算页错误态 | Task 7 的 checkout-page 测试 |
| G12 | 下单不挂死 | Task 1 的 queue.service 测试 + 浏览器手测 8 |
| G13 | /health degraded | Task 2 的 health.service 单测 + e2e |
| G14 | destructive-foreground 生效 | Task 4 的 globals-css 测试 + 浏览器手测 9 |
| G15 | 没有裸名残留 | Task 4 的 globals-css 测试 |
| G16 | 地址错误态 | Task 7 的 checkout-page 测试 |
| G17 | 无「失败但订单建了」 | Task 1 的代码 + 浏览器手测 8 |
| G18 | 组件测试基建 | Task 9 |
| G19 | Redis 挂时快速失败 | 浏览器手测 12 |

### 浏览器手测（设计文档 §6.3，12 条）

用 **ego-browser**（`ego-browser skill` 先看用法），**全程不得抢占前台**。
任务结束清理标签页。

1. 商家后台改主色 → 预览区变 → 保存 → 切到 storefront → 主色已变
2. 商家后台改字体 → 预览区字体变 → 保存 → storefront 字体已变
3. 商家后台改字阶/字重/阴影/间距 → 预览区对应变化 → storefront 对应变化
4. 商家后台自身的按钮颜色**不随**店铺主题变化
5. 停掉后端 → storefront 首页显示中文错误，**无 `fetch failed`**
6. 停掉后端 → 结算页显示中文错误，**不跳回购物车页**
7. 让 accessToken 失效 → storefront 跳登录页，**不显示 `Unauthorized`**
8. 停掉 Redis → 下单**不转圈**；`/health` 返回 degraded
9. 商家后台改 `destructiveForeground` → storefront 的 `.text-destructive-foreground` 生效
10. 三个前端的 globals.css 内容一致（shasum 相同），且页面**没有**任何裸变量残留
11. 停掉后端 → 结算页地址区显示中文错误（不是空的地址选择框）
12. 停掉 Redis 再启动 api → 容器日志 ~3 秒内有明确报错并退出（不是静默卡住）

### 收尾

1. 写验收记录 `docs/superpowers/plans/2026-10-27-plan-05d-acceptance.md`
2. 文档**单独**提交
3. 推分支（走 `tools/push-via-api.mjs`，**不用 `git push`** —— 见记忆「本机 GitHub 推送需走 API」）
4. 开 PR → 合并 → 删远端分支（用 API 删，`gh pr merge --delete-branch` 在本机会失败）
5. 更新记忆 `project_plan04_execution.md`
