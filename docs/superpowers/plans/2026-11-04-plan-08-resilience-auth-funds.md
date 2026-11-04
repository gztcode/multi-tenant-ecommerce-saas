# 阶段 8「部署韧性、鉴权与资金正确性」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉三类高危问题（经网关访问 BFF 404、生产密钥守卫失效、购物车/续费/渠道交易号的并发与资金缺陷），并收编 8c 的健壮性与工程债。

**Architecture:** 按 8a 部署与鉴权 / 8b 资金与并发 / 8c 健壮性与工程债拆成三波；8a 先落地（Nginx 与密钥守卫是其余验收的前置），8b 与 8c 的 api / 前端 / infra 三个域文件互不重叠，按波次并行。每个 Task 自带定向测试，主会话在 Task 验证通过后统一提交。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16（Jest 30）、Next.js 15.5 + NextAuth v5（Vitest 3）、Docker Compose v2、Nginx 1.27、GitHub Actions。

**设计文档:** `docs/superpowers/specs/2026-11-04-plan-08-resilience-auth-funds-design.md`

**执行约定（agent-team 模式）:**

- 实施代理**不提交**，只改文件并跑**定向**测试；commit 由主会话在 Task 验证通过后执行。
- 每个 Task 只碰 `Files:` 列出的文件。发现无关问题时**只报告、不动手**。
- 失败注入（故意改坏源码验证测试）必须**独占**执行，不能与其他测试并发。
- api 测试用 **Jest**（`cd api && npx jest <file>`），前端用 **Vitest**（`cd <app> && npx vitest run <file>`）。不要混用。
- 所有 e2e 读 `api/.env` 的 `DATABASE_URL_TEST`；跑 e2e 前确认 postgres/redis/minio 已起。
- 定向 lint：只对本次改动文件执行 `npx eslint <file>`；**不跑 api 全量 lint**（Task 15 之前仓库本来就有 28 处既有报错）。
- 工作分支：直接在 `main` 上按 Task 提交（仓库惯例）；docs 的改动单独 commit。

**波次与文件归属:**

| 波次 | Task | 并行说明 |
|---|---|---|
| 1（8a） | 1 / 2 / 3 | 三个 Task 文件互不重叠，可并行 |
| 2（8b） | 4 与（5 → 6） | Task 5/6 **都改 `payment.service.ts`，必须串行**；Task 4 与它们无文件重叠，可并行 |
| 3（8c-1） | 7 / 8 / 9 / 10 / 11 / 12 / 14 / 16 / 18 | api 健壮性、三个前端、共享包、备份、依赖清理互不重叠，可并行 |
| 4（8c-2） | 15 → 17 | 15 依赖波次 3 的 api 改动全部落地；17 依赖 Task 1 已改同一份 nginx 配置 |
| 5 | 13 → 19 | 13 依赖 15 的 lint 修复与 14 的 tsconfig；19 是阶段末全量回归 |

---

## Task 1: Nginx 把 `/api/**` 归还 storefront，只代理 `/api/v1/`

**Files:**
- Modify: `infra/nginx/platform.test.conf:64`

- [ ] **Step 1: 改前缀**

把店铺子域名 server 块里的：

```nginx
    location /api/ {
```

改为：

```nginx
    # ⚠️ **只代理后端自己的版本前缀**。`location /api/` 是最长前缀匹配，
    # 会把 storefront 的 BFF 路由（/api/cart、/api/auth/[...nextauth] 等）
    # 全部抢给 api_backend —— 而后端全局前缀是 /api/v1，这些请求在后端
    # 不存在 → 经网关访问时购物车/登录/下单整体 404（直连 :3001 正常）。
    location /api/v1/ {
```

- [ ] **Step 2: 语法检查并热加载**

Run:
```bash
cd infra && docker compose exec nginx nginx -t
```
Expected: `syntax is ok` / `test is successful`

Run:
```bash
cd infra && docker compose exec nginx nginx -s reload
```
Expected: 无输出（退出码 0）

- [ ] **Step 3: 逐条实测（四个域名 + 直连）**

先确保 api 与 storefront 在跑：`cd infra && docker compose up -d --wait api storefront`

Run:
```bash
for path in /api/cart /api/auth/session /api/v1/health; do
  printf '%s -> ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: demo.platform.test' "http://localhost$path"
done
printf 'direct:3001 /api/cart -> '
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/cart
```
Expected（与设计 §3.1 一致）:
```
/api/cart -> 200
/api/auth/session -> 200
/api/v1/health -> 200
direct:3001 /api/cart -> 200
```

再确认另外三个中心域名不受影响：
```bash
for h in api merchant admin; do
  printf '%s -> ' "$h"
  curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $h.platform.test" http://localhost/
done
```
Expected: 三条均为 `200`（api 的 `/` 可能 404，只要不是连接/路由错误即可；重点是没被新 location 抢走）。

- [ ] **Step 4: Commit**

```bash
git add infra/nginx/platform.test.conf
git commit -m "fix(infra): nginx 只代理 /api/v1/，把 /api/** 归还 storefront BFF"
```

---

## Task 2: 生产密钥守卫改为「已知占位符集合」判断

**Files:**
- Create: `api/src/common/config/placeholder-secrets.ts`
- Create: `api/src/common/config/placeholder-secrets.spec.ts`
- Modify: `api/src/common/config/assert-secure-config.ts:9,81-85`
- Modify: `api/src/common/config/assert-payout-encryption-key.ts:11-12,25-30`

- [ ] **Step 1: 先写失败测试**

创建 `api/src/common/config/placeholder-secrets.spec.ts`：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWN_PLACEHOLDER_SECRETS,
  isPlaceholderSecret,
} from './placeholder-secrets';
import { assertSecureConfig } from './assert-secure-config';
import { assertPayoutEncryptionKey } from './assert-payout-encryption-key';

/**
 * 守卫必须拦住 **compose 内置的默认密钥**，而不只是 .env.example 的占位符。
 *
 * 根因：原来的守卫做字面等值比较，比较目标与 compose 默认值不是同一个串，
 * 于是「提交进 git 的固定密钥 + NODE_ENV=production」能正常启动。
 *
 * ⚠️ 这个测试直接解析 `infra/docker-compose.yml`：
 *    将来谁改了 compose 默认值却忘了登记到集合，这里立刻红。
 */
const COMPOSE_PATH = join(__dirname, '../../../../infra/docker-compose.yml');

function composeValue(key: string): string {
  const content = readFileSync(COMPOSE_PATH, 'utf8');
  const line = content.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  if (!line) throw new Error(`compose 里找不到 ${key}`);

  const raw = line[1].trim();
  const withDefault = raw.match(/^\$\{[^:}]+:-([^}]+)\}$/);
  if (withDefault) return withDefault[1];
  if (raw.startsWith('${')) {
    throw new Error(`${key} 没有默认值，守卫集合无法覆盖`);
  }
  return raw;
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('已知占位符密钥集合', () => {
  it('集合非空', () => {
    expect(KNOWN_PLACEHOLDER_SECRETS.size).toBeGreaterThanOrEqual(2);
  });

  it('compose 的 JWT_SECRET 默认值在拒绝集合内', () => {
    expect(isPlaceholderSecret(composeValue('JWT_SECRET'))).toBe(true);
  });

  it('compose 的 PAYOUT_ACCOUNT_ENCRYPTION_KEY 默认值在拒绝集合内', () => {
    expect(isPlaceholderSecret(composeValue('PAYOUT_ACCOUNT_ENCRYPTION_KEY'))).toBe(
      true,
    );
  });

  it('真实随机值不在集合内', () => {
    expect(isPlaceholderSecret('a'.repeat(64))).toBe(false);
  });

  it('生产 + compose 默认 JWT_SECRET → assertSecureConfig 拒绝启动', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        JWT_SECRET: composeValue('JWT_SECRET'),
      },
      () => {
        expect(() => assertSecureConfig()).toThrow(/占位符/);
      },
    );
  });

  it('生产 + compose 默认账目密钥 → assertPayoutEncryptionKey 拒绝启动', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        PAYOUT_ACCOUNT_ENCRYPTION_KEY: composeValue(
          'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
        ),
      },
      () => {
        expect(() => assertPayoutEncryptionKey()).toThrow(/占位符/);
      },
    );
  });

  it('开发环境用 compose 默认值不拦截（本机 compose 要能起）', () => {
    withEnv(
      {
        NODE_ENV: 'development',
        JWT_SECRET: composeValue('JWT_SECRET'),
        PAYOUT_ACCOUNT_ENCRYPTION_KEY: composeValue(
          'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
        ),
      },
      () => {
        expect(() => assertSecureConfig()).not.toThrow();
        expect(() => assertPayoutEncryptionKey()).not.toThrow();
      },
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && npx jest src/common/config/placeholder-secrets.spec.ts`
Expected: FAIL —— `Cannot find module './placeholder-secrets'`

- [ ] **Step 3: 新建集合模块**

创建 `api/src/common/config/placeholder-secrets.ts`。四个值**原样**从现有文件抄写，不要重新拼：

```ts
/**
 * 已知的「示例/默认密钥」集合（阶段 8a）。
 *
 * ⚠️ **必须同时包含两类值**：
 * 1. `.env.example` 里给开发者复制的占位符（现有两个守卫各自写死的那两个串）
 * 2. `infra/docker-compose.yml` 里 `${VAR:-默认值}` 的默认值
 *
 * 原实现只与第一类做字面等值比较，但 compose 启动时注入的是第二类
 * ——于是「提交进 git 的固定密钥 + NODE_ENV=production」能正常启动。
 *
 * ⚠️ **不改 compose 的默认值**（设计 §3.2）：`PAYOUT_ACCOUNT_ENCRYPTION_KEY`
 * 一旦改动，既有出款单快照永久解不开。
 * ⚠️ `placeholder-secrets.spec.ts` 会解析 compose 断言默认值都在集合内，
 * 防止将来两边再次漂移。
 *
 * 值为空的字符串不在集合里：长度校验会先把它拦下，这里不重复处理。
 */
export const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  // 1) 原 assert-secure-config.ts 的 PLACEHOLDER_SECRET（.env.example 的 JWT_SECRET）
  'change-me-in-production-at-least-32-chars-long',
  // 2) 原 assert-payout-encryption-key.ts 的 PLACEHOLDER_KEY（.env.example 的账目密钥）
  'change-me-in-production-payout-key-at-least-32-chars-long',
  // 3) infra/docker-compose.yml 的 ${JWT_SECRET:-...} 默认值
  'local-dev-only-jwt-secret-at-least-32-chars-long',
  // 4) infra/docker-compose.yml 的 ${PAYOUT_ACCOUNT_ENCRYPTION_KEY:-...} 默认值
  '-local-dev-only-payout-encryption-key-at-least-32-chars',
]);

/** 该值是否是已知的示例/默认密钥 */
export function isPlaceholderSecret(value: string): boolean {
  return KNOWN_PLACEHOLDER_SECRETS.has(value);
}
```

⚠️ 上面四个值必须与源文件**逐字节一致**（第 1/2 项从两个守卫的常量抄，第 3/4 项从 compose 行抄）。第 3/4 项只抄 `${VAR:-...}` 里 `:-` 之后的默认值，**不要连 `${VAR:-}` 一起抄**。`placeholder-secrets.spec.ts` 的「compose 默认值在集合内」用例会兜住抄错。

- [ ] **Step 4: 改两个守卫**

`api/src/common/config/assert-secure-config.ts`：

1. 删除第 9 行的 `const PLACEHOLDER_SECRET = '...'`。
2. 在文件顶部 import 区加：

```ts
import { isPlaceholderSecret } from './placeholder-secrets';
```

3. 把 `assertJwtSecret()` 里的：

```ts
  if (process.env.NODE_ENV === 'production' && secret === PLACEHOLDER_SECRET) {
    throw new Error(
      '生产环境禁止使用 .env.example 里的 JWT_SECRET 占位符，请换成真实密钥。',
    );
  }
```

改为：

```ts
  if (process.env.NODE_ENV === 'production' && isPlaceholderSecret(secret)) {
    throw new Error(
      '生产环境禁止使用示例/默认的 JWT_SECRET 占位符（含 docker-compose 内置默认值），请换成真实密钥。',
    );
  }
```

`api/src/common/config/assert-payout-encryption-key.ts`：

1. 删除 `const PLACEHOLDER_KEY = '...'`。
2. 顶部加：

```ts
import { isPlaceholderSecret } from './placeholder-secrets';
```

3. 把比较分支改为：

```ts
  if (
    process.env.NODE_ENV === 'production' &&
    isPlaceholderSecret(secret)
  ) {
    throw new Error(
      '生产环境禁止使用示例/默认的 PAYOUT_ACCOUNT_ENCRYPTION_KEY 占位符' +
        '（含 docker-compose 内置默认值），请换成真实密钥。',
    );
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd api && npx jest src/common/config --runInBand`
Expected: `placeholder-secrets.spec.ts` 全部 PASS；既有 `assert-secure-config` 相关用例不回归。

Run: `cd api && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add api/src/common/config/placeholder-secrets.ts \
        api/src/common/config/placeholder-secrets.spec.ts \
        api/src/common/config/assert-secure-config.ts \
        api/src/common/config/assert-payout-encryption-key.ts
git commit -m "fix(api): 生产密钥守卫改为已知占位符集合，覆盖 compose 内置默认值"
```

---

## Task 3: platform-admin 补令牌刷新链路

**Files:**
- Create: `platform-admin/src/lib/jwt-callback.ts`
- Create: `platform-admin/src/lib/token-refresh.ts`
- Create: `platform-admin/src/lib/token-expiry.ts`
- Create: `platform-admin/src/lib/session-sync.ts`
- Create: `platform-admin/src/components/session/session-sync.tsx`
- Modify: `platform-admin/src/auth.ts`（整体替换为函数形式）
- Modify: `platform-admin/src/app/layout.tsx`
- Test: `platform-admin/test/lib/jwt-callback.test.ts`（从 merchant-admin 复制）
- Test: `platform-admin/test/lib/token-refresh.test.ts`（从 merchant-admin 复制）
- Test: `platform-admin/test/lib/token-expiry.test.ts`（从 merchant-admin 复制）

- [ ] **Step 1: 补薄壳**

四个 `src/lib/*.ts` 各只有一行再导出，逐字如下：

```ts
export * from '@ecom/frontend-shared/jwt-callback';
```

```ts
export * from '@ecom/frontend-shared/token-refresh';
```

```ts
export * from '@ecom/frontend-shared/token-expiry';
```

```ts
export * from '@ecom/frontend-shared/session-sync';
```

创建 `platform-admin/src/components/session/session-sync.tsx`（与另两端逐字节相同）：

```tsx
'use client';

export { SessionSync } from '@ecom/frontend-shared/session-sync-component';
```

- [ ] **Step 2: 复制三份刷新决策测试**

```bash
cp merchant-admin/test/lib/jwt-callback.test.ts platform-admin/test/lib/jwt-callback.test.ts
cp merchant-admin/test/lib/token-refresh.test.ts platform-admin/test/lib/token-refresh.test.ts
cp merchant-admin/test/lib/token-expiry.test.ts platform-admin/test/lib/token-expiry.test.ts
```

这三份测试只 import `@/lib/*`，与端无关，复制后无需改动。

- [ ] **Step 3: 跑测试确认薄壳可解析**

Run: `cd platform-admin && npx vitest run test/lib/jwt-callback.test.ts test/lib/token-refresh.test.ts test/lib/token-expiry.test.ts`
Expected: PASS（薄壳已存在，测试只测共享逻辑）。这一步确认深路径解析正常，不是红灯步骤。

- [ ] **Step 4: 把 auth.ts 换成函数形式**

用下面内容**整体替换** `platform-admin/src/auth.ts`：

```ts
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import {
  makeJwtCallback,
  makeSessionCallback,
  type AuthUser,
  type JwtToken,
  type SessionLike,
} from '@/lib/jwt-callback';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    role: string;
    tenantId: string | null;
  }
}

/**
 * 平台超管后台的 NextAuth 配置。
 *
 * ⚠️ **必须是函数形式**：只有函数形式能拿到「这次读会话的请求」，
 *    刷新逻辑据此判断 cookie 送不送得回去（详见 shared 的 jwt-callback）。
 *    对象形式没有过期刷新分支 —— 超管登录 2 小时后所有中转路由 401，
 *    但界面仍显示已登录，且无法自愈。
 *
 * ⚠️ **与 merchant-admin 唯一的差别**：`scope` 固定为 `'PLATFORM'`。
 *    后端 login 会按 scope 过滤候选角色，写错只会得到「密码错误」。
 *    平台后台跑在中心域名，不带 `x-tenant-subdomain`。
 */
export const { handlers, auth, signIn, signOut } = NextAuth(
  async (request: NextRequest | undefined) => ({
    session: { strategy: 'jwt' },
    trustHost: true,
    pages: { signIn: '/login' },
    providers: [
      Credentials({
        name: 'platform',
        credentials: {
          email: { label: '邮箱', type: 'email' },
          password: { label: '密码', type: 'password' },
        },
        async authorize(credentials) {
          const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: credentials?.email,
              password: credentials?.password,
              scope: 'PLATFORM',
            }),
          });

          if (!response.ok) {
            // 登录失败不返回具体原因，交给登录页统一显示「邮箱或密码不正确」。
            return null;
          }

          const data = (await response.json()) as {
            user: {
              id: string;
              email: string;
              displayName: string;
              role: string;
              tenantId: string | null;
            };
            accessToken: string;
            refreshToken: string;
          };

          return {
            id: data.user.id,
            email: data.user.email,
            name: data.user.displayName,
            role: data.user.role,
            tenantId: data.user.tenantId,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          } satisfies AuthUser;
        },
      }),
    ],
    callbacks: {
      jwt: makeJwtCallback(request !== undefined),
      // ⚠️ 类型适配放在这一侧，不污染被测模块（与另两端同构）。
      session: async (params) =>
        (await makeSessionCallback()(params as unknown as {
          session: SessionLike;
          token: JwtToken;
        })) as unknown as Session,
    },
  }),
);
```

- [ ] **Step 5: 根 layout 挂 SessionSync**

`platform-admin/src/app/layout.tsx`：

1. 顶部加 import：

```tsx
import { SessionSync } from "@/components/session/session-sync";
```

2. 把 `<body className="antialiased">` 里的 `{children}` 改为：

```tsx
      <body className="antialiased">
        {children}
        {/* 会话同步：把刷新后的会话 cookie 送回浏览器，并协调多标签页。
            挂在根 layout 上，所以**每个页面**都会跑一次。 */}
        <SessionSync />
      </body>
```

- [ ] **Step 6: 更新 platform-admin README 的目录描述**

把 `platform-admin/README.md` 目录表里 `src/auth.ts` 那一行的说明改为：

```
| `src/auth.ts` | NextAuth 配置（函数形式）。`scope` 固定为 `'PLATFORM'`；`jwt` / `session` 回调走共享包的刷新链路（阶段 8a 起） |
```

- [ ] **Step 7: 验证**

Run: `cd platform-admin && npx tsc --noEmit`
Expected: 退出码 0。

Run: `cd platform-admin && npm test`
Expected: 全部 PASS（原 429 条 + 复制的三份测试）。

Run: `cd platform-admin && AUTH_SECRET=ci-only-secret-ci-only-secret-ci-32 AUTH_TRUST_HOST=true npm run build`
Expected: 构建成功。

- [ ] **Step 8: Commit**

```bash
git add platform-admin/src/auth.ts \
        platform-admin/src/app/layout.tsx \
        platform-admin/src/components/session/session-sync.tsx \
        platform-admin/src/lib/jwt-callback.ts \
        platform-admin/src/lib/token-refresh.ts \
        platform-admin/src/lib/token-expiry.ts \
        platform-admin/src/lib/session-sync.ts \
        platform-admin/test/lib/jwt-callback.test.ts \
        platform-admin/test/lib/token-refresh.test.ts \
        platform-admin/test/lib/token-expiry.test.ts \
        platform-admin/README.md
git commit -m "feat(platform-admin): 补令牌刷新链路与多标签页会话同步"
```

---

## Task 4: 购物车加购改单条原子自增

**Files:**
- Modify: `api/src/modules/cart/cart.service.ts:349-369`
- Test: `api/test/cart.e2e-spec.ts`（追加用例）

- [ ] **Step 1: 先写失败测试**

在 `api/test/cart.e2e-spec.ts` 的「游客购物车」describe 末尾追加两条（放在 `加购数量超过上限被拒绝` 之后）：

```ts
  it('并发加购同一 SKU 两次：数量累加为 2，不丢增量', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '并发加购的商品');
    const { token } = await registerCustomer(merchant.subdomain);

    // 账号购物车还没有这条 SKU → 两个请求会同时走 create 分支，
    // 撞 @@unique([cartId, skuId]) 后重试自增（P2002 路径）。
    const results = await Promise.all([
      http(app)
        .post('/api/v1/cart/items')
        .set('authorization', `Bearer ${token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({ skuId, quantity: 1 }),
      http(app)
        .post('/api/v1/cart/items')
        .set('authorization', `Bearer ${token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({ skuId, quantity: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 201]);

    const final = await http(app)
      .get('/api/v1/cart')
      .set('authorization', `Bearer ${token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(cartBody(final).items).toHaveLength(1);
    expect(cartBody(final).items[0].quantity).toBe(2);
  });

  it('并发加购撞上限：一个成功一个 400（不是 500）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '上限并发的商品');
    const { token } = await registerCustomer(merchant.subdomain);

    // 先加到 98（上限 99），再并发各加 1
    await http(app)
      .post('/api/v1/cart/items')
      .set('authorization', `Bearer ${token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 98 })
      .expect(201);

    const results = await Promise.all([
      http(app)
        .post('/api/v1/cart/items')
        .set('authorization', `Bearer ${token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({ skuId, quantity: 1 }),
      http(app)
        .post('/api/v1/cart/items')
        .set('authorization', `Bearer ${token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({ skuId, quantity: 1 }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 400]);
    const rejected = results.find((r) => r.status === 400);
    expect(rejected?.body).toMatchObject({
      message: '同一商品的加购总量不能超过 99',
    });

    const final = await http(app)
      .get('/api/v1/cart')
      .set('authorization', `Bearer ${token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(cartBody(final).items[0].quantity).toBe(99);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/cart.e2e-spec.ts -t '并发加购'`
Expected: FAIL —— 第一条最终数量为 1（丢了一次增量）；第二条可能出现 500。

- [ ] **Step 3: 改实现**

把 `cart.service.ts:349-369` 的整段（从 `// 同一个 SKU 已经在车里` 到 `create` 调用结束）替换为：

```ts
    // 原子自增：把「读-改-写」压成一条 UPDATE。
    // 条件带上限，数量用 increment —— 并发请求各自 +N，不会互相覆盖。
    const updated = await this.prisma.cartItem.updateMany({
      where: {
        cartId: cart.id,
        skuId,
        quantity: { lte: MAX_CART_QUANTITY - quantity },
      },
      data: { quantity: { increment: quantity } },
    });
    if (updated.count === 1) {
      return;
    }

    // 0 行：要么行不存在，要么会超上限 —— 查一次区分这两种情况。
    const exists = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id, skuId },
    });
    if (exists) {
      throw new BadRequestException(
        `同一商品的加购总量不能超过 ${MAX_CART_QUANTITY}`,
      );
    }

    try {
      await this.prisma.cartItem.create({
        data: { tenantId: cart.tenantId, cartId: cart.id, skuId, quantity },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // 并发插入：另一个请求刚建了行 → 重试一次自增（此时行一定存在）
      const retried = await this.prisma.cartItem.updateMany({
        where: {
          cartId: cart.id,
          skuId,
          quantity: { lte: MAX_CART_QUANTITY - quantity },
        },
        data: { quantity: { increment: quantity } },
      });
      if (retried.count === 0) {
        throw new BadRequestException(
          `同一商品的加购总量不能超过 ${MAX_CART_QUANTITY}`,
        );
      }
    }
```

`isUniqueViolation` 已在文件第 1 行 import，`MAX_CART_QUANTITY` 已在第 11 行 import，无需新增 import。

- [ ] **Step 4: 跑定向测试**

Run: `cd api && npx jest src/modules/cart/cart.service.spec.ts --runInBand`
Expected: PASS（改数量、合并等既有路径不受影响）。

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/cart.e2e-spec.ts`
Expected: 全部 PASS（含新增 2 条）。

Run: `cd api && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/cart/cart.service.ts api/test/cart.e2e-spec.ts
git commit -m "fix(api): 购物车加购改为原子自增，修并发丢增量与 P2002 500"
```

---

## Task 5: 续费幂等与单租户故障隔离

> ⚠️ 本 Task 与 Task 6 都会改 `payment.service.ts`，**必须串行**（先 5 后 6）。

**Files:**
- Modify: `api/src/modules/payment/payment.service.ts:526-545`（`chargeInvoice` 成功状态）
- Modify: `api/src/modules/payment/renewal.service.ts:84-90`（scan 的 per-tenant try/catch）
- Modify: `api/src/modules/payment/renewal.service.ts:158-215`（`chargeAndSettle` 幂等预检查）
- Test: `api/test/billing-renewal.e2e-spec.ts`（追加用例）

- [ ] **Step 1: 先写失败测试**

在 `api/test/billing-renewal.e2e-spec.ts` 的最后一个 `describe` 内追加两条：

```ts
  it('支付单已 SUCCESS、账单仍 OPEN → 下一轮扫描不重复扣款并结清', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });
    const subscription = await subscribe(merchant.token, planId);

    await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    const periodStart = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      }),
    );

    // 第一轮：正常扣款成功（支付单落 SUCCESS、账单 PAID、周期延长）
    await renewal.scan();
    const [invoice] = await readInvoices(merchant.tenantId);
    expect(invoice.status).toBe('PAID');

    // 人为制造「扣款成功但结算失败」：账单回 OPEN、周期回退到同一期
    await asTenant(merchant.tenantId, async () => {
      await prisma.invoice.updateMany({
        where: { id: invoice.id },
        data: { status: 'OPEN' },
      });
      await prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      });
    });

    const chargeSpy = jest.spyOn(fakeProvider, 'chargeAuthorized');
    await renewal.scan();

    // 幂等键命中：不再调渠道，但账单要结清
    expect(chargeSpy).not.toHaveBeenCalled();
    const after = await readInvoices(merchant.tenantId);
    expect(after[0].status).toBe('PAID');
    chargeSpy.mockRestore();
  });

  it('单个租户续费抛异常：其余租户照常处理（不中断整批）', async () => {
    const failing = await createMerchant(app, prisma);
    const healthy = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const failingSub = await subscribe(failing.token, planId);
    await subscribe(healthy.token, planId);

    await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${failing.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);
    await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${healthy.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    const periodStart = new Date(Date.now() + DAY_MS);
    for (const tenantId of [failing.tenantId, healthy.tenantId]) {
      await asTenant(tenantId, () =>
        prisma.subscription.updateMany({
          where: { tenantId },
          data: { currentPeriodEnd: periodStart },
        }),
      );
    }

    // 先为两家各生成账单，拿到账单号（扫描内部也会生成，这里提前建好）
    for (const merchant of [failing, healthy]) {
      const subscription = await asTenant(merchant.tenantId, () =>
        prisma.subscription.findFirst({ where: { tenantId: merchant.tenantId } }),
      );
      await asTenant(merchant.tenantId, () =>
        invoices.generateInvoice({
          subscriptionId: subscription!.id,
          tenantId: merchant.tenantId,
          planId,
          periodStart,
          periodEnd: new Date(periodStart.getTime() + 30 * DAY_MS),
          dueAt: periodStart,
        }),
      );
    }

    const [failingInvoice] = await readInvoices(failing.tenantId);
    const original = fakeProvider.chargeAuthorized.bind(fakeProvider);
    const spy = jest
      .spyOn(fakeProvider, 'chargeAuthorized')
      .mockImplementation((request) => {
        if (request.referenceNo === failingInvoice.number) {
          throw new Error('渠道炸了');
        }
        return original(request);
      });

    await expect(renewal.scan()).resolves.toBeUndefined();

    const failingAfter = await readInvoices(failing.tenantId);
    expect(failingAfter[0].status).toBe('OPEN');
    const healthyAfter = await readInvoices(healthy.tenantId);
    expect(healthyAfter[0].status).toBe('PAID');

    spy.mockRestore();
    // failingSub 仅用于让 TS 知道变量被使用；断言它仍处于活跃状态
    expect(failingSub.status).toBe('ACTIVE');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/billing-renewal.e2e-spec.ts -t '支付单已 SUCCESS'`
Expected: FAIL —— 第二次扫描仍调用了 `chargeAuthorized`（甚至抛「该账单已支付」中断）。

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/billing-renewal.e2e-spec.ts -t '单个租户续费抛异常'`
Expected: FAIL —— `renewal.scan()` 抛出异常，健康租户的账单未支付。

- [ ] **Step 3: `chargeInvoice` 成功时落 SUCCESS**

`api/src/modules/payment/payment.service.ts` 中，把：

```ts
    if (result.status !== 'SUCCESS') {
```

改为：

```ts
    if (result.status === 'SUCCESS') {
      // ⚠️ **成功也必须落状态**：不落的话「已有成功扣款」这个事实无法从
      // 本地识别，下一轮扫描会对同一账期重复扣款。
      // 条件更新：并发重复处理时只有一次生效。
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
        },
        data: { status: PaymentStatus.SUCCESS },
      });
    } else {
```

文件尾部的这个 `if` 块结构保持不变（原来的 FAILED 写入成为 `else` 分支）。

- [ ] **Step 4: `chargeAndSettle` 加幂等预检查**

在 `renewal.service.ts` 的 `chargeAndSettle` 里，找到注释「⚠️ **自动扣款**：有绑定的支付方式才扣」，把这一段：

```ts
    // ⚠️ **自动扣款**：有绑定的支付方式才扣
    const method = await this.prisma.paymentMethod.findFirst({
```

前面插入：

```ts
    // ⚠️ **幂等键命中：该账单已有成功支付单** —— 覆盖「扣款成功但结算失败」
    //    的恢复路径（账单仍是 OPEN，但钱已经扣过了）。
    //    不查这一步的话，下一轮扫描会复用支付单再扣一次。
    const settled = await this.prisma.payment.findFirst({
      where: { invoiceId: invoice.id, status: PaymentStatus.SUCCESS },
    });
    if (settled) {
      await this.invoices.markInvoicePaid(invoice.id);
      await this.expireIfNeeded(subscription.id, now);
      return;
    }

    // ⚠️ **自动扣款**：有绑定的支付方式才扣
    const method = await this.prisma.paymentMethod.findFirst({
```

确认 `PaymentStatus` 已在 `renewal.service.ts` 顶部 import；若没有，补 `import { PaymentStatus } from '@prisma/client';`（与现有 import 合并）。

- [ ] **Step 5: `scan()` 加 per-tenant try/catch**

把 `renewal.service.ts` 的：

```ts
    for (const subscription of due) {
      // ⚠️ **写操作回到租户作用域** —— 租户 id 来自库里（可信源），
      // 不是客户端提交的
      await runForTenant(subscription.tenantId, async () => {
        await this.renewOne(subscription.id);
      });
    }
```

改为：

```ts
    for (const subscription of due) {
      try {
        // ⚠️ **写操作回到租户作用域** —— 租户 id 来自库里（可信源），
        // 不是客户端提交的
        await runForTenant(subscription.tenantId, async () => {
          await this.renewOne(subscription.id);
        });
      } catch (error) {
        // ⚠️ **单个租户失败不能中断整批**：否则当天其余所有租户的续费
        // 都不再执行。只记订阅 id 与异常类名，不打原始 message（可能含敏感数据）。
        this.logger.error(
          `订阅 ${subscription.id} 续费失败：${
            error instanceof Error ? error.constructor.name : typeof error
          }`,
        );
      }
    }
```

- [ ] **Step 6: 跑定向测试**

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/billing-renewal.e2e-spec.ts`
Expected: 全部 PASS（含新增 2 条）。

Run: `cd api && npx jest src/modules/payment/payment.service.spec.ts src/modules/billing/settlement.service.spec.ts --runInBand`
Expected: PASS。

Run: `cd api && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add api/src/modules/payment/payment.service.ts \
        api/src/modules/payment/renewal.service.ts \
        api/test/billing-renewal.e2e-spec.ts
git commit -m "fix(api): 续费按成功支付单幂等结算，单租户异常不再中断整批"
```

---

## Task 6: 渠道交易号绑定补 `provider` 并检查影响行数

> ⚠️ 本 Task 与 Task 5 都会改 `payment.service.ts`，**必须串行**（先 5 后 6）。

**Files:**
- Modify: `api/src/modules/payment/payment.service.ts:1980-2003`（`attachProviderTxnId` 的 updateMany）
- Test: `api/src/modules/payment/payment.service.spec.ts`（追加 describe）

- [ ] **Step 1: 先写失败测试**

在 `api/src/modules/payment/payment.service.spec.ts` 文件末尾追加：

```ts
describe('渠道交易号绑定（阶段 8b）', () => {
  type AttachFn = (
    order: { id: string; orderNo: string },
    event: NormalizedWebhookEvent,
  ) => Promise<boolean>;

  function setupAttach() {
    const prisma = prismaMock();
    const { service } = buildService(
      provider('fake', FAKE_CAPABILITIES),
      prisma,
    );
    const attach = (
      service as unknown as { attachProviderTxnId: AttachFn }
    ).attachProviderTxnId.bind(service);
    return { prisma, attach };
  }

  function event(over: Partial<NormalizedWebhookEvent> = {}): NormalizedWebhookEvent {
    return {
      provider: 'fake',
      channel: 'fake',
      eventId: 'evt-1',
      providerTxnId: 'txn-1',
      referenceNo: 'SO-1',
      amount: 1000,
      success: true,
      eventType: 'PAYMENT',
      ...over,
    };
  }

  it('写入时 where 带上 provider', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      attach({ id: 'order-1', orderNo: 'SO-1' }, event()),
    ).resolves.toBe(true);

    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'order-1',
          channel: 'fake',
          provider: 'fake',
          status: PaymentStatus.PENDING,
        }) as unknown,
      }),
    );
  });

  it('updateMany 命中 0 行 → 返回 false（不再静默成功）', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      attach({ id: 'order-1', orderNo: 'SO-1' }, event()),
    ).resolves.toBe(false);
  });

  it('provider 不匹配导致 0 行 → 返回 false', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      attach(
        { id: 'order-1', orderNo: 'SO-1' },
        event({ provider: 'sandbox', channel: 'fake' }),
      ),
    ).resolves.toBe(false);
  });

  it('渠道交易已落到别的订单 → 返回 false 且不写库', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue({ id: 'payment-other' });

    await expect(
      attach({ id: 'order-1', orderNo: 'SO-1' }, event()),
    ).resolves.toBe(false);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd api && npx jest src/modules/payment/payment.service.spec.ts -t '渠道交易号绑定'`
Expected: FAIL —— 第一条断言 `provider` 缺失；第二条返回 `true`。

- [ ] **Step 3: 改实现**

在 `attachProviderTxnId` 里，把 `try { await this.prisma.payment.updateMany({...}) }` 改为：

```ts
    let updated: { count: number };
    try {
      updated = await this.prisma.payment.updateMany({
        where: {
          orderId: order.id,
          channel: event.channel,
          // ⚠️ **必须带 provider**：预检查按 (provider, providerTxnId) 判冲突，
          //    写入却不带 provider 的话，另一个渠道的同号交易会把
          //    「这次绑定」当成成功，实际写错了行 / 一行都没写。
          provider: event.provider,
          status: PaymentStatus.PENDING,
        },
        data: { providerTxnId: event.providerTxnId },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // ⚠️ 并发撞唯一索引：不在业务事务里，重查一次判断是否真冲突。
      const stillConflicting = await this.prisma.payment.findFirst({
        where: {
          provider: event.provider,
          providerTxnId: event.providerTxnId,
          NOT: { orderId: order.id },
        },
      });
      if (stillConflicting) {
        this.logger.error(
          `渠道交易 ${event.providerTxnId} 已落到另一个订单的支付单上，` +
            `拒绝流转订单 ${order.orderNo}（事件 ${event.eventId}）`,
        );
      } else {
        this.logger.warn(
          `渠道交易 ${event.providerTxnId} 绑定时撞唯一索引但查不到冲突方，` +
            `拒绝流转订单 ${order.orderNo}（事件 ${event.eventId}）`,
        );
      }
      // ⚠️ 无论哪种情况都不返回 true —— 静默成功会让订单在缺少
      //    providerTxnId 的情况下继续流转，后续对账只能靠金额猜。
      return false;
    }

    if (updated.count === 0) {
      // 订单不处于 PENDING 或渠道不匹配 —— 这笔绑定没有落地。
      this.logger.warn(
        `渠道交易 ${event.providerTxnId} 未写入支付单（订单 ${order.orderNo}` +
          ` 不处于待支付或渠道不匹配，事件 ${event.eventId}）`,
      );
      return false;
    }
```

- [ ] **Step 4: 跑定向测试**

Run: `cd api && npx jest src/modules/payment/payment.service.spec.ts --runInBand`
Expected: PASS（含新增 4 条）。

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/payment.e2e-spec.ts`
Expected: PASS（webhook 主路径不回归）。

Run: `cd api && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/payment/payment.service.ts api/src/modules/payment/payment.service.spec.ts
git commit -m "fix(api): 渠道交易号绑定补 provider 条件并检查影响行数"
```

---

## Task 7: api 健壮性——归期、券分页、媒体分页

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts:1343-1358`
- Modify: `api/src/modules/coupon/coupon.service.ts:597-625`
- Modify: `api/src/modules/coupon/coupon.controller.ts:31-35`
- Modify: `api/src/modules/media/media.controller.ts:44-53`
- Modify: `storefront/src/lib/shop-api.ts:200-207`
- Test: `api/src/modules/coupon/coupon.service.spec.ts`（追加）
- Test: `api/test/media.e2e-spec.ts`（追加畸形分页用例）
- Test: `storefront/test/lib/shop-api.test.ts`（新建）

- [ ] **Step 1: `availablePeriods` 改用 DB 端 DISTINCT**

`payout.service.ts` 中把：

```ts
    // ⚠️ **只查已结束的周期**：`occurredAt < now` 的月份才可能已结束。
    // ⚠️ **不手写 tenantId**：商家侧靠租户作用域扩展自动附加。
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { occurredAt: { lt: now } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });

    // ⚠️ **按月分组**：流水是逐笔的，周期是月的。
    //    这里只要**周期清单**（金额由聚合统一算，
    //    不复用这里的求和 —— 两处口径漂了账就错了）。
    const periodLabels = new Set<string>();
    for (const receipt of receipts) {
      periodLabels.add(formatPeriodLabel(receipt.occurredAt));
    }

    const periods = [...periodLabels].sort((a, b) => b.localeCompare(a));
```

替换为：

```ts
    // ⚠️ **DB 端 DISTINCT 归期**：原来把本租户全部流水拉回内存取月份
    //    ——无界查询。复用 7b 的 `merchantReceiptPeriods(tenantId)`，
    //    每月只回一行字符串。
    // ⚠️ 这里**不按 now 过滤**：未结束的周期在下面的 `resolved.to > now`
    //    判断里跳过（保留原有语义）。
    const periodLabels = await this.prisma.merchantReceiptPeriods(tenantId);
    const periods = [...periodLabels].sort((a, b) => b.localeCompare(a));
```

检查文件里 `formatPeriodLabel` 是否还被别处使用；若只在这里用过，删除它的 import（**只删因本次改动失效的 import**）。

- [ ] **Step 2: 券列表加分页**

`coupon.service.ts` 的 `listAvailable` 方法签名改为接收可选分页参数，并把两处 `findMany` 改为有界查询 + 独立 count：

```ts
  /**
   * 当前可领取的券（分页）。
   *
   * ⚠️ **店铺券 + 平台券两个来源**，按 `createdAt desc` 合并后分页。
   *    精确跨来源分页需要各取 `skip + pageSize` 的窗口；窗口设硬上限，
   *    避免 `page` 很大时退化成无界查询（总数用独立 count，仍然准确）。
   */
  async listAvailable(params?: {
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: Coupon[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const tenantId = this.currentTenantId();
    const dbNow = await this.databaseNow(this.prisma);
    const { page, pageSize } = clampPagination(params?.page, params?.pageSize);
    const skip = (page - 1) * pageSize;
    // 合并窗口上限：超过它的深页返回空 items（total 仍准确）。
    const MAX_MERGE_WINDOW = 1000;
    const take = Math.min(skip + pageSize, MAX_MERGE_WINDOW);

    const shopWhere = {
      tenantId,
      status: CouponStatus.ACTIVE,
      startsAt: { lte: dbNow },
      endsAt: { gt: dbNow },
    };
    const platformWhere = {
      scope: CouponScope.PLATFORM,
      status: CouponStatus.ACTIVE,
      startsAt: { lte: dbNow },
      endsAt: { gt: dbNow },
    };

    const [shopCoupons, platformCoupons, shopTotal, platformTotal] =
      await Promise.all([
        this.prisma.coupon.findMany({
          where: shopWhere,
          orderBy: { createdAt: 'desc' },
          take,
        }),
        tenantContext.run(platformScope(), async () =>
          this.prisma.coupon.findMany({
            where: platformWhere,
            orderBy: { createdAt: 'desc' },
            take,
          }),
        ),
        this.prisma.coupon.count({ where: shopWhere }),
        tenantContext.run(platformScope(), async () =>
          this.prisma.coupon.count({ where: platformWhere }),
        ),
      ]);

    const merged = [...shopCoupons, ...platformCoupons].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const items = merged.slice(skip, skip + pageSize);

    return {
      items,
      total: shopTotal + platformTotal,
      page,
      pageSize,
    };
  }
```

顶部补 import（若尚未存在）：

```ts
import { clampPagination } from '../../common/http/pagination';
```

`coupon.controller.ts` 的 `available()` 改为透传分页：

```ts
  @Get('available')
  @ApiOperation({ summary: '当前可领取的券（分页）' })
  available(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.couponService.listAvailable({
      page: toIntOr(page, undefined),
      pageSize: toIntOr(pageSize, undefined),
    });
  }
```

并补 import：

```ts
import { toIntOr } from '../../common/http/pagination';
```

- [ ] **Step 3: 媒体列表用同一套夹取**

`media.controller.ts` 的 `list()` 改为：

```ts
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const { page: safePage, pageSize: safePageSize } = clampPagination(
      toIntOr(page, undefined),
      toIntOr(pageSize, undefined),
    );
    return this.mediaService.list(safePage, safePageSize);
  }
```

补 import：

```ts
import { clampPagination, toIntOr } from '../../common/http/pagination';
```

- [ ] **Step 4: storefront 券页显式取满一页**

分页默认 pageSize=20，不改前端的话「可领取的券」从第 21 张起会消失。`storefront/src/lib/shop-api.ts` 里把：

```ts
    const payload = await apiFetch<{ items: AvailableCoupon[] }>(
      '/coupons/available',
      { subdomain, token },
    );
```

改为：

```ts
    const payload = await apiFetch<{ items: AvailableCoupon[] }>(
      // ⚠️ 后端分页上限 100；券页一次取满，避免第 21 张起静默消失。
      '/coupons/available?pageSize=100',
      { subdomain, token },
    );
```

创建 `storefront/test/lib/shop-api.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, currentToken, currentSubdomain } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  currentToken: vi.fn(async () => 'tok'),
  currentSubdomain: vi.fn(async () => 'demo'),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch }));
vi.mock('@/lib/server-cart', () => ({ currentToken, currentSubdomain }));

import { fetchAvailableCoupons } from '@/lib/shop-api';

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
});

describe('可领取的券', () => {
  it('取第一页的满上限，而不是默认 20', async () => {
    await fetchAvailableCoupons();
    expect(apiFetch).toHaveBeenCalledWith('/coupons/available?pageSize=100', {
      subdomain: 'demo',
      token: 'tok',
    });
  });
});
```

- [ ] **Step 5: 补测试**

`coupon.service.spec.ts` 追加（沿用文件里已有的 `buildService(prisma)`；`listAvailable` 会走 `databaseNow(this.prisma)`，假 Prisma 需要提供 `$queryRaw`）：

```ts
  it('listAvailable 分页：page/pageSize 夹取且 total 来自 count', async () => {
    const prisma = {
      coupon: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // 店铺券
          .mockResolvedValueOnce([]), // 平台券
        count: jest.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(5),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ now: new Date('2026-11-04T00:00:00Z') }]),
    };
    const service = buildService(prisma);

    const result = await tenantContext.run(
      { tenantId: 'tenant-a', userId: null, role: null },
      async () => service.listAvailable({ page: 0, pageSize: 999 }),
    );

    expect(result).toMatchObject({ total: 12, page: 1, pageSize: 100 });
  });

  it('listAvailable 畸形分页不 500', async () => {
    const prisma = {
      coupon: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: new Date() }]),
    };
    const service = buildService(prisma);

    const result = await tenantContext.run(
      { tenantId: 'tenant-a', userId: null, role: null },
      async () =>
        service.listAvailable({
          page: Number.NaN,
          pageSize: Number.POSITIVE_INFINITY,
        }),
    );

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });
```

`api/test/media.e2e-spec.ts` 追加（放在「列表分页：pageSize 上限 100」之后）：

```ts
  it('畸形分页参数不 500：page=abc、pageSize=0', async () => {
    const merchant = await createMerchant(app, prisma);
    const response = await http(app)
      .get('/api/v1/media?page=abc&pageSize=0')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = mediaListBody(response);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.items).toEqual([]);
  });
```

- [ ] **Step 6: 跑定向测试**

Run: `cd api && npx jest src/modules/coupon/coupon.service.spec.ts src/modules/billing/payout.service.spec.ts --runInBand`
Expected: PASS。

Run: `cd api && npx jest --config test/jest-e2e.json --runInBand test/media.e2e-spec.ts test/payout.e2e-spec.ts`
Expected: PASS。

Run: `cd storefront && npx vitest run test/lib/shop-api.test.ts && npx tsc --noEmit`
Expected: PASS，退出码 0。

Run: `cd api && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add api/src/modules/billing/payout.service.ts \
        api/src/modules/coupon/coupon.service.ts \
        api/src/modules/coupon/coupon.controller.ts \
        api/src/modules/coupon/coupon.service.spec.ts \
        api/src/modules/media/media.controller.ts \
        api/test/media.e2e-spec.ts \
        storefront/src/lib/shop-api.ts \
        storefront/test/lib/shop-api.test.ts
git commit -m "fix(api): 归期改 DB 端 DISTINCT，券与媒体列表分页夹取"
```

---

## Task 8: storefront 三个页面区分 404 与后端故障

**Files:**
- Modify: `storefront/src/app/(shop)/search/page.tsx`
- Modify: `storefront/src/app/(shop)/c/[slug]/page.tsx`
- Modify: `storefront/src/app/(shop)/p/[slug]/page.tsx`
- Test: `storefront/test/app/search-page.test.tsx`
- Test: `storefront/test/app/category-page.test.tsx`
- Test: `storefront/test/app/product-page.test.tsx`

- [ ] **Step 1: 先写失败测试**

创建 `storefront/test/app/product-page.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 商品详情页：只有 404 才是「商品不存在」；后端故障要渲染错误态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { notFoundMock, fetchPublicProduct } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  fetchPublicProduct: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'demo.platform.test' }),
}));
// 页面会 import @/lib/api-client 的 ApiError；该薄壳顶层 import @/auth，
// 不 mock 会把 next-auth 整个依赖图拉进 jsdom。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/catalog', () => ({ fetchPublicProduct }));
vi.mock('@/components/product/spec-selector', () => ({
  SpecSelector: () => null,
}));

import { ApiError } from '@/lib/api-client';

async function renderPage() {
  const Page = (await import('@/app/(shop)/p/[slug]/page')).default;
  const ui = await Page({ params: Promise.resolve({ slug: 'p1' }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('商品详情页的错误态', () => {
  it('后端 404 → notFound()', async () => {
    fetchPublicProduct.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', '商品不存在'),
    );
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('后端故障 → 渲染错误与重试，不 notFound()', async () => {
    fetchPublicProduct.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage();
    expect(
      screen.getByText('网络连接失败，请检查网络后重试'),
    ).toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
```

创建 `storefront/test/app/search-page.test.tsx`：

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { fetchPublicProducts } = vi.hoisted(() => ({
  fetchPublicProducts: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'demo.platform.test' }),
}));
// 页面会 import @/lib/api-client 的 ApiError；该薄壳顶层 import @/auth，
// 不 mock 会把 next-auth 整个依赖图拉进 jsdom。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/catalog', () => ({ fetchPublicProducts }));

import { ApiError } from '@/lib/api-client';

async function renderPage(q: string) {
  const Page = (await import('@/app/(shop)/search/page')).default;
  const ui = await Page({ searchParams: Promise.resolve({ q }) });
  return render(ui);
}

beforeEach(() => vi.clearAllMocks());

describe('搜索页的错误态', () => {
  it('后端故障 → 错误 + 重试，不谎报「没有找到」', async () => {
    fetchPublicProducts.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('测试');

    expect(screen.getByText('网络连接失败，请检查网络后重试')).toBeTruthy();
    expect(screen.queryByText('没有找到相关商品。')).toBeNull();
    expect(screen.getByRole('link', { name: '重试' })).toBeTruthy();
  });

  it('后端正常但结果为空 → 显示「没有找到」', async () => {
    fetchPublicProducts.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 48,
    });
    await renderPage('测试');
    expect(screen.getByText('没有找到相关商品。')).toBeTruthy();
  });
});
```

创建 `storefront/test/app/category-page.test.tsx`：

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { notFoundMock, fetchPublicCategories, fetchPublicProducts } =
  vi.hoisted(() => ({
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    fetchPublicCategories: vi.fn(),
    fetchPublicProducts: vi.fn(),
  }));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'demo.platform.test' }),
}));
// 页面会 import @/lib/api-client 的 ApiError；该薄壳顶层 import @/auth，
// 不 mock 会把 next-auth 整个依赖图拉进 jsdom。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/catalog', () => ({
  fetchPublicCategories,
  fetchPublicProducts,
}));

import { ApiError } from '@/lib/api-client';

async function renderPage(slug: string) {
  const Page = (await import('@/app/(shop)/c/[slug]/page')).default;
  const ui = await Page({ params: Promise.resolve({ slug }) });
  return render(ui);
}

beforeEach(() => vi.clearAllMocks());

describe('品类页的错误态', () => {
  it('品类接口故障 → 错误 + 重试，不显示「品类不存在」', async () => {
    fetchPublicCategories.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('shoes');

    expect(screen.getByText('网络连接失败，请检查网络后重试')).toBeTruthy();
    expect(screen.queryByText('品类不存在')).toBeNull();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('品类树正常但 slug 不存在 → notFound()', async () => {
    fetchPublicCategories.mockResolvedValue([]);
    await expect(renderPage('missing')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('商品接口故障 → 渲染错误，不 notFound()', async () => {
    fetchPublicCategories.mockResolvedValue([
      { id: 'c1', slug: 'shoes', name: '鞋', parentId: null, children: [] },
    ]);
    fetchPublicProducts.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('shoes');
    expect(screen.getByText('网络连接失败，请检查网络后重试')).toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd storefront && npx vitest run test/app/product-page.test.tsx test/app/search-page.test.tsx test/app/category-page.test.tsx`
Expected: FAIL（页面当前把所有异常都吞成 null 或 `notFound()`）。

- [ ] **Step 3: 改商品详情页**

`p/[slug]/page.tsx` 顶部补：

```tsx
import Link from 'next/link';
import { ApiError } from '@/lib/api-client';
```

把取数部分替换为：

```tsx
  let product: Awaited<ReturnType<typeof fetchPublicProduct>> | null = null;
  let error: string | null = null;
  try {
    product = await fetchPublicProduct(subdomain, slug);
  } catch (cause) {
    // 只有 404 才是「商品不存在」；后端故障不能伪装成 404。
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error = cause instanceof Error ? cause.message : '商品加载失败';
  }

  if (error || !product) {
    return (
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-start gap-4 p-6">
        <p className="text-sm text-destructive">{error ?? '商品加载失败'}</p>
        <Link href={`/p/${slug}`} className="underline">
          重试
        </Link>
        <Link href="/" className="text-sm text-muted-foreground underline">
          返回首页
        </Link>
      </main>
    );
  }
```

（后面的渲染代码不动。）

- [ ] **Step 4: 改搜索页**

`search/page.tsx` 顶部补 `Link` 与 `ApiError` import，把取数替换为：

```tsx
  let products: Awaited<ReturnType<typeof fetchPublicProducts>> | null = null;
  let error: string | null = null;
  if (q) {
    try {
      products = await fetchPublicProducts(subdomain, {
        keyword: q,
        pageSize: 48,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : '商品加载失败';
    }
  }
```

在表单后插入错误态：

```tsx
      {error && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{error}</p>
          <Link
            href={`/search?q=${encodeURIComponent(q ?? '')}`}
            className="underline"
          >
            重试
          </Link>
        </div>
      )}
```

把「没有找到相关商品」的条件改为 `!error && products && products.items.length === 0`。

- [ ] **Step 5: 改品类页**

`c/[slug]/page.tsx` 顶部补 `notFound` 与 `Link`、`ApiError` import，取数部分改为：

```tsx
  let categories: Awaited<ReturnType<typeof fetchPublicCategories>> = [];
  let categoriesError: string | null = null;
  try {
    categories = await fetchPublicCategories(subdomain);
  } catch (cause) {
    categoriesError =
      cause instanceof Error ? cause.message : '品类加载失败';
  }

  const flat: Array<{
    id: string;
    slug: string;
    name: string;
    parentId: string | null;
  }> = [];
  const walk = (nodes: typeof categories) => {
    for (const node of nodes) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(categories);
  const category = flat.find((c) => c.slug === slug);

  if (categoriesError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col items-start gap-4 p-6">
        <p className="text-sm text-destructive">{categoriesError}</p>
        <Link href={`/c/${slug}`} className="underline">
          重试
        </Link>
        <Link href="/" className="text-sm text-muted-foreground underline">
          返回首页
        </Link>
      </main>
    );
  }

  if (!category) {
    notFound();
  }

  let products: Awaited<ReturnType<typeof fetchPublicProducts>> | null = null;
  let productsError: string | null = null;
  try {
    products = await fetchPublicProducts(subdomain, {
      categoryId: category.id,
      pageSize: 48,
    });
  } catch (cause) {
    productsError =
      cause instanceof Error ? cause.message : '商品加载失败';
  }
```

把渲染部分改为：

```tsx
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{category.name}</h1>
      {productsError && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{productsError}</p>
          <Link href={`/c/${slug}`} className="underline">
            重试
          </Link>
        </div>
      )}
      {!productsError && products && products.items.length === 0 && (
        <p className="text-muted-foreground">这个品类下还没有上架商品。</p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `cd storefront && npx vitest run test/app/product-page.test.tsx test/app/search-page.test.tsx test/app/category-page.test.tsx`
Expected: PASS。

Run: `cd storefront && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add "storefront/src/app/(shop)/search/page.tsx" \
        "storefront/src/app/(shop)/c/[slug]/page.tsx" \
        "storefront/src/app/(shop)/p/[slug]/page.tsx" \
        storefront/test/app/search-page.test.tsx \
        storefront/test/app/category-page.test.tsx \
        storefront/test/app/product-page.test.tsx
git commit -m "fix(storefront): 搜索/品类/商品页区分 404 与后端故障"
```

---

## Task 9: 购物车列表——受控输入与真正生效的重试

**Files:**
- Modify: `storefront/src/components/cart/cart-list.tsx:44-105,151-160,198-212`
- Test: `storefront/test/components/cart/cart-list.test.tsx`

- [ ] **Step 1: 先写失败测试**

创建 `storefront/test/components/cart/cart-list.test.tsx`：

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { CartList } from '@/components/cart/cart-list';

function cart(quantity: number) {
  return {
    id: 'cart-1',
    items: [
      {
        id: 'item-1',
        skuId: 'sku-1',
        quantity,
        sku: { id: 'sku-1', price: 1000, product: { id: 'p1', name: '商品' } },
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('购物车列表', () => {
  it('加载失败 → 显示错误，不谎报空车', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ message: '网络连接失败' }, 503),
      ),
    );
    render(<CartList />);
    expect(await screen.findByText('网络连接失败')).toBeTruthy();
    expect(screen.queryByText('购物车是空的。')).toBeNull();
  });

  it('重试按钮真的重取（不是 router.refresh）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: '网络连接失败' }, 503))
      .mockResolvedValueOnce(jsonResponse(cart(2)));
    vi.stubGlobal('fetch', fetchMock);

    render(<CartList />);
    const retry = await screen.findByRole('button', { name: '重试' });
    await userEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByDisplayValue('2')).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('改数量失败 → 输入框回到服务端数量', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cart(2)))
      .mockResolvedValueOnce(jsonResponse({ message: '改数量失败' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    render(<CartList />);
    const input = await screen.findByLabelText('商品 的数量');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.tab(); // 触发 blur

    expect(await screen.findByText('改数量失败')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByDisplayValue('2')).toBeTruthy();
    });
  });

  it('改数量成功 → 输入框显示新值', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cart(2)))
      .mockResolvedValueOnce(jsonResponse(cart(3)));
    vi.stubGlobal('fetch', fetchMock);

    render(<CartList />);
    const input = await screen.findByLabelText('商品 的数量');
    await userEvent.clear(input);
    await userEvent.type(input, '3');
    await userEvent.tab();

    await waitFor(() => {
      expect(screen.getByDisplayValue('3')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd storefront && npx vitest run test/components/cart/cart-list.test.tsx`
Expected: FAIL —— 重试用例里 `fetch` 只被调 1 次（`router.refresh` 不重跑客户端 effect）；失败回滚用例里输入框仍是 5。

- [ ] **Step 3: 抽 `load()` 并让重试调用它**

`cart-list.tsx` 里把首次加载的 `useEffect` 替换为：

```tsx
  /**
   * 读车。首次挂载与「重试」按钮共用。
   *
   * ⚠️ **重试不能只调 `router.refresh()`**：它不会重跑客户端组件的
   *    `useEffect`，界面会一直停在错误态。
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await call('/api/cart', 'GET');
      setCart(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '购物车加载失败');
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);
```

把错误态里的按钮改为：

```tsx
        <Button variant="outline" onClick={() => void load()}>
          重试
        </Button>
```

- [ ] **Step 4: 输入框改受控 + 本地草稿**

在组件 state 区加：

```tsx
  // 每个条目的输入草稿：用户正在输入、尚未提交的值。
  // 提交成功 / 失败 / 非法输入时清除，回到服务端数量。
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /** 清掉某个条目的草稿（不留下未使用的解构变量） */
  const clearDraft = (itemId: string) => {
    setDrafts((prev) => {
      const nextDrafts = { ...prev };
      delete nextDrafts[itemId];
      return nextDrafts;
    });
  };
```

把 `changeQuantity` 改为返回是否成功，并在成功时刷新本地 cart：

```tsx
  async function changeQuantity(
    itemId: string,
    quantity: number,
  ): Promise<void> {
    if (quantity < 1) return;
    setBusy(true);
    setError(null);
    try {
      const next = await call(`/api/cart/items/${itemId}`, 'PATCH', {
        quantity,
      });
      if (next) {
        setCart(next);
      } else {
        // 204：接口没回新 cart，重取一次
        await load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改数量失败');
      // ⚠️ 失败时把草稿清掉 → 受控输入回落到服务端数量，
      //    否则输入框会一直显示用户输入的、并未生效的值。
      clearDraft(itemId);
    } finally {
      setBusy(false);
    }
  }
```

把 `<Input ... />` 整块替换为：

```tsx
                <Input
                  type="number"
                  min={1}
                  max={99}
                  value={drafts[item.id] ?? String(item.quantity)}
                  aria-label={`${item.sku?.product.name ?? item.skuId} 的数量`}
                  disabled={busy}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [item.id]: event.target.value,
                    }))
                  }
                  onBlur={(event) => {
                    const raw = event.target.value;
                    const next = Number.parseInt(raw, 10);
                    clearDraft(item.id);
                    if (!Number.isFinite(next) || next < 1) {
                      return;
                    }
                    if (next !== item.quantity) {
                      void changeQuantity(item.id, next);
                    }
                  }}
                  className="w-24"
                />
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `cd storefront && npx vitest run test/components/cart/cart-list.test.tsx`
Expected: PASS。

Run: `cd storefront && npm test`
Expected: 全部 PASS（无回归）。

Run: `cd storefront && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add storefront/src/components/cart/cart-list.tsx \
        storefront/test/components/cart/cart-list.test.tsx
git commit -m "fix(storefront): 购物车改数量失败回滚输入框，重试按钮真正重取"
```

---

## Task 10: 库存面板切 SKU 的响应竞态

**Files:**
- Modify: `merchant-admin/src/components/product/inventory-panel.tsx:1,60-83`
- Test: `merchant-admin/test/components/inventory-panel.test.tsx`

- [ ] **Step 1: 先写失败测试**

创建 `merchant-admin/test/components/inventory-panel.test.tsx`：

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { InventoryPanel } from '@/components/product/inventory-panel';

const SKUS = [
  { skuId: 'sku-a', code: 'A', stock: 10, status: 'ACTIVE' },
  { skuId: 'sku-b', code: 'B', stock: 20, status: 'ACTIVE' },
];

function movements(item: string) {
  return {
    items: [
      {
        id: `${item}-1`,
        skuId: item,
        type: 'ADJUST_IN',
        quantity: 1,
        stockBefore: 0,
        stockAfter: 1,
        reason: item === 'sku-a' ? 'A 的流水' : 'B 的流水',
        createdAt: '2026-11-04T00:00:00.000Z',
      },
    ],
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('库存面板的切 SKU 竞态', () => {
  it('先发出的旧响应晚到 → 丢弃，不覆盖新选择', async () => {
    let resolveB!: (value: Response) => void;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('skuId=sku-a')) {
        // A 的响应故意晚到
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(JSON.stringify(movements('sku-a')))), 50);
        });
      }
      if (url.includes('skuId=sku-b')) {
        return new Promise<Response>((resolve) => {
          resolveB = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InventoryPanel skus={SKUS} />);

    // 初次加载 A → 立刻切到 B → 再切回 A（A 两个请求都在飞）
    const select = screen.getByLabelText('SKU');
    await userEvent.selectOptions(select, 'sku-b');
    await userEvent.selectOptions(select, 'sku-a');

    // 放行 B 的迟到响应
    resolveB(new Response(JSON.stringify(movements('sku-b'))));

    // 最终显示的必须是 A 的流水
    await waitFor(() => {
      expect(screen.getByText('A 的流水')).toBeTruthy();
    });
    expect(screen.queryByText('B 的流水')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（或行为不稳定）**

Run: `cd merchant-admin && npx vitest run test/components/inventory-panel.test.tsx`
Expected: FAIL —— B 的迟到响应覆盖了 A 的流水。

- [ ] **Step 3: 加请求序号**

`inventory-panel.tsx` 顶部补：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
```

（替换原来只 import `useCallback, useEffect, useState` 的那一行。）

在 state 声明后加：

```tsx
  // 请求序号：每次拉流水自增；响应回来时序号不等于最新值就丢弃。
  // 切 SKU 很快时，旧请求的响应可能晚于新请求到达。
  const reqSeq = useRef(0);
```

把 `loadMovements` 改为：

```tsx
  const loadMovements = useCallback(async (targetSkuId: string) => {
    const seq = ++reqSeq.current;
    if (!targetSkuId) {
      setMovements([]);
      setMovementsHint('没有商品参数，先从商品编辑页进来才能看某个 SKU 的流水。');
      return;
    }
    try {
      const response = await fetch(
        `/api/inventory/movements?skuId=${encodeURIComponent(targetSkuId)}&pageSize=50`,
      );
      // ⚠️ 旧响应：用户已经切到别的 SKU，丢弃，不覆盖新选择。
      if (seq !== reqSeq.current) return;
      if (!response.ok) {
        setMovementsHint(
          (await readResponse(response, '流水加载失败')) ?? '流水加载失败',
        );
        return;
      }
      const payload = (await response.json()) as { items?: Movement[] };
      setMovements(payload.items ?? []);
      setMovementsHint(null);
    } catch {
      if (seq !== reqSeq.current) return;
      setMovementsHint('流水加载失败');
    }
  }, []);
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `cd merchant-admin && npx vitest run test/components/inventory-panel.test.tsx`
Expected: PASS。

Run: `cd merchant-admin && npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add merchant-admin/src/components/product/inventory-panel.tsx \
        merchant-admin/test/components/inventory-panel.test.tsx
git commit -m "fix(merchant-admin): 库存流水切 SKU 时丢弃过期响应"
```

---

## Task 11: 共享 api-client——`forwardCookie` 必填、无令牌显式 401

**Files:**
- Modify: `packages/frontend-shared/src/api-client.ts:72-84,214-224`
- Modify: `storefront/src/lib/api-client.ts:7-15`
- Modify: `merchant-admin/src/lib/api-client.ts:7-13`
- Modify: `platform-admin/src/lib/api-client.ts:15-21`
- Test: `storefront/test/lib/api-client.test.ts`（追加）
- Test: `merchant-admin/test/lib/api-client.test.ts`（追加）
- Test: `platform-admin/test/lib/api-client.test.ts`（追加）

- [ ] **Step 1: 先写失败测试（三端各一份）**

在每个 `test/lib/api-client.test.ts` 末尾追加（三端相同，import 名以文件为准；下面以 storefront 为例）：

```ts
describe('无会话时的受保护请求', () => {
  it('session 为空 → 抛 401 ApiError，且不调后端', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // 受保护请求的导出名与其它导出一致（薄壳里 `export const <名字> = shared.<名字>`）
    const { apiFetchAuthed } = await import('@/lib/api-client');
    await expect(apiFetchAuthed('/me')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      message: '未登录或登录已过期',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

（该文件顶部已 `vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }))`；若没有，补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd storefront && npx vitest run test/lib/api-client.test.ts`
Expected: FAIL —— 当前无令牌会发一个匿名请求，`fetch` 被调用。

- [ ] **Step 3: 改共享客户端**

`packages/frontend-shared/src/api-client.ts`：

1. 把接口里的：

```ts
  /** storefront 透传 cookie（cart_token）；其余端不传 */
  forwardCookie?: boolean;
```

改为：

```ts
  /**
   * 是否转发 Cookie 头。
   *
   * ⚠️ **必填**：漏配会静默降级成「不转发」，游客购物车因此丢车。
   *    三端显式传 `true`（storefront）/ `false`（两个后台）。
   */
  forwardCookie: boolean;
```

2. 把受保护请求改为：

```ts
  async function apiFetchAuthed<T>(
    path: string,
    req: ApiFetchAuthedOptions = {},
  ): Promise<T> {
    const session = await options.auth();
    // ⚠️ **没有令牌就显式 401**，不要发匿名请求：
    //    匿名请求会被后端按「游客」处理，写操作落到错误的身份上，
    //    而且界面拿到的是 403/404 这类误导性错误。
    if (!session?.accessToken) {
      throw new ApiError(401, 'UNAUTHENTICATED', '未登录或登录已过期');
    }
    return apiFetch<T>(path, {
      ...req,
      validate: req.validate as ((data: unknown) => T) | undefined,
      token: session.accessToken,
    });
  }
```

3. 文件头注释里「其余端传 null 明确不发」同步改成「其余端显式传 false」。

- [ ] **Step 4: 三端薄壳显式传值**

`storefront/src/lib/api-client.ts` 已有 `forwardCookie: true`，不动。

`merchant-admin/src/lib/api-client.ts` 与 `platform-admin/src/lib/api-client.ts`，在 `tenantSubdomain: null,` 后各加一行：

```ts
  // 后台没有游客购物车，明确不转发 Cookie。
  forwardCookie: false,
```

- [ ] **Step 5: 跑三端测试与类型检查**

Run:
```bash
cd storefront && npx vitest run test/lib/api-client.test.ts && npx tsc --noEmit
cd merchant-admin && npx vitest run test/lib/api-client.test.ts && npx tsc --noEmit
cd platform-admin && npx vitest run test/lib/api-client.test.ts && npx tsc --noEmit
```
Expected: 三端均 PASS，tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add packages/frontend-shared/src/api-client.ts \
        storefront/test/lib/api-client.test.ts \
        merchant-admin/src/lib/api-client.ts \
        merchant-admin/test/lib/api-client.test.ts \
        platform-admin/src/lib/api-client.ts \
        platform-admin/test/lib/api-client.test.ts
git commit -m "fix(front): forwardCookie 改必填，无会话的受保护请求显式 401"
```

---

## Task 12: 共享 SessionSync 改工厂注入，解掉包内 `@/` 别名

**Files:**
- Modify: `packages/frontend-shared/src/session-sync-component.tsx:1-5,36`
- Modify: `storefront/src/components/session/session-sync.tsx`
- Modify: `merchant-admin/src/components/session/session-sync.tsx`
- Modify: `platform-admin/src/components/session/session-sync.tsx`

- [ ] **Step 1: 改共享组件为工厂**

`packages/frontend-shared/src/session-sync-component.tsx`：

1. 把第 5 行 `import { createSessionSync } from '@/lib/session-sync';` 改为：

```tsx
import type {
  SessionSync as SessionSyncInstance,
  SessionSyncOptions,
} from './session-sync';
```

2. 把 `export function SessionSync() {` 改为：

```tsx
export type CreateSessionSync = (
  options?: SessionSyncOptions,
) => SessionSyncInstance;

/**
 * 造一个 SessionSync 组件。
 *
 * ⚠️ **刷新实现由调用方注入**：共享包不能 import 各端的 `@/lib/session-sync`
 *    ——那会让共享包依赖各端 tsconfig 的路径别名，无法独立 `tsc`。
 *    三端薄壳各自把本端的 `createSessionSync` 传进来。
 */
export function createSessionSyncComponent(
  createSessionSync: CreateSessionSync,
) {
  return function SessionSync() {
```

3. 在函数体结束处（原来的 `}` 之前）补一个闭合括号，使结构变为：

```tsx
    return null;
  };
}
```

⚠️ 缩进保持与现有文件一致（函数体整体多一级缩进也可以，prettier 风格与本仓 tsx 一致即可）。

- [ ] **Step 2: 三端薄壳改用工厂**

`storefront/src/components/session/session-sync.tsx`、`merchant-admin/src/components/session/session-sync.tsx`、`platform-admin/src/components/session/session-sync.tsx` 三份**逐字节相同**，内容替换为：

```tsx
'use client';

import { createSessionSyncComponent } from '@ecom/frontend-shared/session-sync-component';
import { createSessionSync } from '@/lib/session-sync';

export const SessionSync = createSessionSyncComponent(createSessionSync);
```

- [ ] **Step 3: 验证**

Run:
```bash
cd storefront && npx tsc --noEmit && npx vitest run test/lib/session-sync.test.ts
cd merchant-admin && npx tsc --noEmit && npx vitest run test/lib/session-sync.test.ts
cd platform-admin && npx tsc --noEmit
```
Expected: 全部通过。

Run: `cd packages/frontend-shared && npx tsc --noEmit`
Expected: 退出码 0（若 tsconfig 尚未创建，先做 Task 14，再回来跑这一步）。

- [ ] **Step 4: Commit**

```bash
git add packages/frontend-shared/src/session-sync-component.tsx \
        storefront/src/components/session/session-sync.tsx \
        merchant-admin/src/components/session/session-sync.tsx \
        platform-admin/src/components/session/session-sync.tsx
git commit -m "refactor(front): SessionSync 改工厂注入，共享包不再依赖各端 @/ 别名"
```

---

## Task 13: CI 加固（权限 / 并发 / 超时 / api tsc / api lint / shared job）

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 顶层加权限与并发**

在 `jobs:` 之前加：

```yaml
permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

- [ ] **Step 2: 每个 job 加超时**

在 `api:`、`storefront:`、`merchant-admin:`、`platform-admin:` 每个 job 的 `runs-on` 下一行各加：

```yaml
    timeout-minutes: 20
```

- [ ] **Step 3: api job 补 tsc 与 lint**

在 api job 的 `npm ci` 之后、`npx prisma generate` 之前加：

```yaml
      - run: npx tsc --noEmit
        working-directory: api
      - run: npm run lint
        working-directory: api
```

- [ ] **Step 4: 新增 shared job**

在文件末尾加：

```yaml
  shared:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: packages/frontend-shared/package-lock.json
      - run: npm ci
        working-directory: packages/frontend-shared
      - run: npx tsc --noEmit
        working-directory: packages/frontend-shared
```

- [ ] **Step 5: 本地校验 YAML 与命令**

Run: `cd /Users/tom/orca/projects/电商项目 && ruby -e "require 'yaml'; YAML.load_file('.github/workflows/ci.yml'); puts 'ok'"`（或 `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'));print('ok')"`）
Expected: `ok`

Run: `cd packages/frontend-shared && npx tsc --noEmit`
Expected: 退出码 0（依赖 Task 14 已创建 tsconfig）。

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 加权限/并发/超时，api 补 tsc 与 lint，新增共享包检查 job"
```

---

## Task 14: 共享包可独立类型检查

**Files:**
- Create: `packages/frontend-shared/tsconfig.json`
- Modify: `packages/frontend-shared/package.json`（devDependencies 加 `@types/node`）
- Modify: `packages/frontend-shared/package-lock.json`（npm install 生成）

- [ ] **Step 1: 创建 tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "jsx": "preserve",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 补 `@types/node`**

Run:
```bash
cd packages/frontend-shared && npm install --save-dev @types/node@^22
```
Expected: `package.json` 的 devDependencies 出现 `"@types/node": "^22..."`，lockfile 更新。

- [ ] **Step 3: 类型检查**

Run: `cd packages/frontend-shared && npx tsc --noEmit`
Expected: 退出码 0。

若报 `Cannot find module 'next/navigation'` 等，确认第 1 步的 `include` 只有 `src`，且依赖已由 `npm install` 装在 `packages/frontend-shared/node_modules`；仍失败则贴完整报错，不要改 `skipLibCheck` 掩盖。

- [ ] **Step 4: Commit**

```bash
git add packages/frontend-shared/tsconfig.json \
        packages/frontend-shared/package.json \
        packages/frontend-shared/package-lock.json
git commit -m "build(front-shared): 加独立 tsconfig 与 @types/node，可单独 tsc"
```

---

## Task 15: api lint 收口（忽略 dist/coverage + 清 28 处报错）

**Files:**
- Modify: `api/eslint.config.mjs:7-9`
- Modify: `api/src/common/tenant/require-tenant.spec.ts:9,18`
- Modify: `api/src/modules/cart/cart.service.spec.ts:22,33`
- Modify: `api/src/modules/catalog/products/products.service.spec.ts:78`
- Modify: `api/src/modules/coupon/coupon.service.spec.ts:51,72`
- 其余 5 个文件的 prettier 报错由 `--fix` 处理

- [ ] **Step 1: ignores 补 dist 与覆盖率**

`api/eslint.config.mjs` 的：

```js
    ignores: ['eslint.config.mjs'],
```

改为：

```js
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**'],
```

- [ ] **Step 2: 先跑定向 `--fix`（只格式化，不做语义改动）**

Run:
```bash
cd api && npx eslint \
  src/common/tenant/require-tenant.spec.ts \
  src/modules/billing/commission.service.spec.ts \
  src/modules/billing/dto/payout-manual-action.dto.ts \
  src/modules/billing/settlement.service.spec.ts \
  src/modules/cart/cart.service.spec.ts \
  src/modules/catalog/products/products.service.spec.ts \
  src/modules/coupon/coupon.service.spec.ts \
  test/settlement.e2e-spec.ts --fix
```
Expected: 退出码 0 或仅剩下面 Step 3/4 的 5 处语义报错。

- [ ] **Step 3: 手工修 require-await（2 处）**

`require-tenant.spec.ts` 两处 `async () => requireTenantId()` 保持 `async`（`tenantContext.run` 的回调必须是 async，见 AGENTS.md），加行内豁免：

```ts
      // ⚠️ 回调必须是 async（tenantContext 的约定）；这里同步返回结果，
      //    所以显式豁免 require-await。
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => requireTenantId(),
```

两处（第 9 行与第 18 行）都要加，且各自带上行内注释。

- [ ] **Step 4: 手工修其余 3 处**

1. `cart.service.spec.ts`：`accountCart()` 与 `guestCart()` 的返回值去掉多余断言：

```ts
function accountCart(): Cart {
  return {
    id: ACCOUNT_CART_ID,
    tenantId: TENANT,
    customerId: CUSTOMER,
    guestToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function guestCart(): Cart {
  return {
    id: GUEST_CART_ID,
    tenantId: TENANT,
    customerId: null,
    guestToken: 'guest-token',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
```

2. `products.service.spec.ts:78`：把对 `createMany.mock.calls[0][0]` 的取值改成直接断言参数：

```ts
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ tenantId: 't1', productId: 'p1', mediaId: 'b' }],
    });
```

3. `coupon.service.spec.ts` 两处 `findMany.mock.calls[0][0]`：改为

```ts
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a' },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
```

和

```ts
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
```

（若该用例断言了调用次数，保留次数断言。）

- [ ] **Step 5: 全量 lint（现在必须为 0）**

Run: `cd api && npm run lint`
Expected: 无输出，退出码 0。

Run: `cd api && ./node_modules/.bin/eslint dist && echo IGNORED_OK`
Expected: 输出 `File ignored because of a matching ignore pattern` 与 `IGNORED_OK`（确认 dist 不再被扫）。

- [ ] **Step 6: 跑受影响单测**

Run:
```bash
cd api && npx jest src/common/tenant/require-tenant.spec.ts \
  src/modules/billing/commission.service.spec.ts \
  src/modules/cart/cart.service.spec.ts \
  src/modules/catalog/products/products.service.spec.ts \
  src/modules/coupon/coupon.service.spec.ts --runInBand
```
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add api/eslint.config.mjs \
        api/src/common/tenant/require-tenant.spec.ts \
        api/src/modules/billing/commission.service.spec.ts \
        api/src/modules/billing/dto/payout-manual-action.dto.ts \
        api/src/modules/billing/settlement.service.spec.ts \
        api/src/modules/cart/cart.service.spec.ts \
        api/src/modules/catalog/products/products.service.spec.ts \
        api/src/modules/coupon/coupon.service.spec.ts \
        api/test/settlement.e2e-spec.ts
git commit -m "chore(api): 忽略 dist/coverage 并清掉既有 lint 报错，纳入 CI"
```

---

## Task 16: 备份脚本——保留策略、redis 卷、校验与等待 postgres

**Files:**
- Modify: `infra/backup.sh`

- [ ] **Step 1: 改脚本**

在 `STAMP=` 之前加：

```bash
# 备份保留天数（默认 7）。超过的目录在备份成功后清理。
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
```

在读取 `.env` 之后、postgres 备份之前插入：

```bash
# 0) 确保 postgres 已就绪（容器没起时 pg_dump 会直接失败）
docker compose up -d --wait postgres
```

把 postgres 备份那两行改为：

```bash
echo "[backup] postgres: $PG_DB"
docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" \
  | gzip > "$DEST/postgres-$PG_DB.sql.gz"
# ⚠️ 备份后立即校验 gzip 完整性：损坏的备份比没有备份更危险。
gunzip -t "$DEST/postgres-$PG_DB.sql.gz"
echo "[backup] postgres 备份校验通过"
```

在 MinIO 段之后、完成提示之前插入 redis 卷备份（与 MinIO 同款动态查卷）：

```bash
# 3) Redis 数据卷热备（AOF 可能有写入中的不一致，本机开发够用）
REDIS_VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'redis-data$' | head -n1 || true)"
if [ -z "$REDIS_VOL" ]; then
  echo "[backup] 找不到 redis-data 卷，跳过 Redis 备份" >&2
else
  echo "[backup] redis volume: $REDIS_VOL"
  docker run --rm \
    -v "$REDIS_VOL":/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup \
    alpine tar czf "/backup/redis-data.tgz" -C /data .
fi
```

在 `echo "[backup] 完成 → $DEST"` 之前插入保留策略：

```bash
# 4) 保留策略：删除超过 N 天的备份目录（当前这次刚创建，不会被删）
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \
  -mtime +"$BACKUP_KEEP_DAYS" -exec rm -rf {} +
```

- [ ] **Step 2: 语法检查**

Run: `bash -n infra/backup.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: 本地完整跑一次**

Run:
```bash
cd infra && BACKUP_DIR=./backups-test ./backup.sh
```
Expected: 输出包含 `postgres 备份校验通过` 与 `完成 →`；`./backups-test/<时间戳>/` 下有 `postgres-ecommerce.sql.gz`，且 `gunzip -t` 通过。

Run:
```bash
cd infra && gunzip -t backups-test/*/postgres-ecommerce.sql.gz && echo VERIFIED
```
Expected: `VERIFIED`

- [ ] **Step 4: 验证保留策略**

Run:
```bash
cd infra && mkdir -p backups-test/20200101-000000 && touch -t 202001010000 backups-test/20200101-000000
BACKUP_DIR=./backups-test BACKUP_KEEP_DAYS=1 ./backup.sh
test ! -d backups-test/20200101-000000 && echo PRUNED
```
Expected: `PRUNED`

清理测试产物：
```bash
rm -rf infra/backups-test
```

- [ ] **Step 5: Commit**

```bash
git add infra/backup.sh
git commit -m "fix(infra): 备份补保留策略/redis 卷/gzip 校验并等待 postgres 就绪"
```

---

## Task 17: nginx 健康检查与静态资源缓存

**Files:**
- Modify: `infra/docker-compose.yml:262-280`（nginx 服务）
- Modify: `infra/nginx/platform.test.conf:48-74`（只在店铺子域名 server 块加静态缓存）

- [ ] **Step 1: compose 加 healthcheck**

nginx 服务的 `mem_limit: 256m` 之前加：

```yaml
    healthcheck:
      # ⚠️ 必须带 Host：默认 server 块对未知 Host 直接 return 444，
      #    不带 Host 的探活会被判失败。实测带 Host 返回可接受状态。
      test:
        [
          'CMD-SHELL',
          "wget -q -O /dev/null --header='Host: demo.platform.test' http://127.0.0.1/ || exit 1",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

- [ ] **Step 2: nginx 加静态缓存 location**

在店铺子域名 server 块的 `location /api/v1/ { ... }` **之后**加：

```nginx
    # Next.js 的构建产物带内容哈希，可以长期缓存。
    #
    # ⚠️ **本层一旦出现 add_header，就不再继承 server 级的安全头** ——
    #    所以这里把三条安全头原样补回来。
    location /_next/static/ {
        proxy_pass http://storefront_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Tenant-Subdomain $tenant;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # ⚠️ 只用 add_header：再写 `expires` 会产生第二条 Cache-Control。
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Frame-Options SAMEORIGIN always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }
```

只加在店铺子域名 server 块：两个后台是内部页面，且重复三份容易漂移；若阶段 9 有性能需求再抽 snippet。

- [ ] **Step 3: 验证**

Run:
```bash
cd infra && docker compose config --quiet && echo CONFIG_OK
```
Expected: `CONFIG_OK`

Run:
```bash
cd infra && docker compose up -d --build nginx && docker compose exec nginx nginx -t
```
Expected: 语法通过。

Run（等 30 秒左右）:
```bash
cd infra && docker compose ps nginx --format '{{.Name}} {{.Status}}'
```
Expected: 状态包含 `(healthy)`。

Run:
```bash
curl -sI -H 'Host: demo.platform.test' http://localhost/_next/static/chunks/main.js | grep -i 'cache-control'
```
Expected: 包含 `public, max-age=31536000, immutable`（路径 404 也应有响应头，因为 location 命中）。

- [ ] **Step 4: Commit**

```bash
git add infra/docker-compose.yml infra/nginx/platform.test.conf
git commit -m "feat(infra): nginx 加健康检查与 /_next/static immutable 缓存"
```

---

## Task 18: 依赖与失效文件清理

**Files:**
- Modify: `api/package.json` / `api/package-lock.json`
- Modify: `storefront/package.json` / `storefront/package-lock.json`
- Modify: `merchant-admin/package.json` / `merchant-admin/package-lock.json`
- Modify: `platform-admin/package.json` / `platform-admin/package-lock.json`
- Delete: `storefront/.dockerignore`、`merchant-admin/.dockerignore`、`platform-admin/.dockerignore`

- [ ] **Step 1: 删除未使用依赖**

Run:
```bash
cd api && npm uninstall ts-loader source-map-support
cd storefront && npm uninstall lucide-react
cd merchant-admin && npm uninstall lucide-react
cd platform-admin && npm uninstall lucide-react
```
Expected: 四个 package.json 与 lockfile 更新，`node_modules` 同步。

- [ ] **Step 2: 删除失效的 .dockerignore**

三个前端的构建上下文是**仓库根**（compose 里 `context: ..`），Docker 只读根目录的 `.dockerignore`，各端目录下的这几份从未生效：

```bash
git rm storefront/.dockerignore merchant-admin/.dockerignore platform-admin/.dockerignore
```

`api/.dockerignore` **保留**（它的 context 是 `../api`，确实生效）。

- [ ] **Step 3: 验证**

Run:
```bash
cd api && npx tsc --noEmit && npm test
```
Expected: PASS。

Run:
```bash
cd storefront && npx tsc --noEmit && npm test && npm run build
cd merchant-admin && npx tsc --noEmit && npm test && npm run build
cd platform-admin && npx tsc --noEmit && npm test && npm run build
```
（build 需要 `AUTH_SECRET`，与 CI 的写法一致：`AUTH_SECRET=ci-only-secret-ci-only-secret-ci-32 AUTH_TRUST_HOST=true npm run build`。）

Expected: 三端全部通过。

- [ ] **Step 4: Commit**

```bash
git add api/package.json api/package-lock.json \
        storefront/package.json storefront/package-lock.json \
        merchant-admin/package.json merchant-admin/package-lock.json \
        platform-admin/package.json platform-admin/package-lock.json
git commit -m "chore: 清理未使用依赖与失效的 .dockerignore"
```

---

## Task 19: 阶段末全量回归

**Files:** 无（只跑命令）

- [ ] **Step 1: api 全量**

```bash
cd infra && docker compose up -d --wait postgres redis minio
cd ../api && npm run prisma:deploy
npm test
npm run test:e2e
npx tsc --noEmit
npm run lint
```
Expected: 单测与 e2e 全绿，tsc/lint 退出码 0。

- [ ] **Step 2: 共享包与三个前端**

```bash
cd packages/frontend-shared && npm ci && npx tsc --noEmit
cd ../../storefront && npm test && npx tsc --noEmit && AUTH_SECRET=ci-only-secret-ci-only-secret-ci-32 AUTH_TRUST_HOST=true npm run build
cd ../merchant-admin && npm test && npx tsc --noEmit && AUTH_SECRET=ci-only-secret-ci-only-secret-ci-32 AUTH_TRUST_HOST=true npm run build
cd ../platform-admin && npm test && npx tsc --noEmit && AUTH_SECRET=ci-only-secret-ci-only-secret-ci-32 AUTH_TRUST_HOST=true npm run build
```
Expected: 全部通过。

- [ ] **Step 3: 全栈与网关链路**

```bash
cd infra && docker compose config --quiet
docker compose up -d --build --wait
for path in /api/cart /api/auth/session /api/v1/health; do
  printf '%s -> ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: demo.platform.test' "http://localhost$path"
done
docker compose ps nginx --format '{{.Status}}'
```
Expected: `/api/cart` 200、`/api/auth/session` 200、`/api/v1/health` 200、nginx `(healthy)`。

- [ ] **Step 4: 手工链路（假网关验收）**

用 `NODE_ENV=development` 起 api（或本机 `npm run start:dev`），按 README 的演示商家账号走一遍：

1. 店铺子域名经网关打开首页 → 商品详情 → 加入购物车 → 改数量 → 下单。
2. 商家后台登录 → 库存面板切换 SKU → 流水跟着切换（无旧数据闪现）。
3. 平台后台登录 → 概览 → 设置页能加载（登录 2 小时以上的场景用短 `JWT_EXPIRES_IN` 模拟；若不方便改配置，至少确认 `/api/auth/session` 在登录后不断被调用且无 401）。

Expected: 全链路无 404/500；购物车数量正确；会话同步无报错。

- [ ] **Step 5: 推送与 CI**

```bash
git log --oneline -20   # 确认所有 Task 已提交
git push origin main    # 若直连超时，用 tools/push-via-api.mjs（中文分支才用 curl 版）
```

推送后确认 GitHub Actions 五个 job（api / storefront / merchant-admin / platform-admin / shared）全绿；失败时按 job 日志修复后重跑。

---

## 附录：禁止事项

- 不改 `infra/docker-compose.yml` 里的 `JWT_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 默认值（解不开既有出款单快照）。
- 不把 platform-admin 的 22 处中转路由改成 `session?.accessToken` 判空（阶段 9）。
- 不给 `coupon.listAvailable` 的深页窗口加数据库 UNION（YAGNI；窗口上限 1000 已足够当前券量）。
- 不在 Task 15 之外顺手修无关文件的 prettier；`--fix` 只对列出的 8 个文件执行。
- 不删除 `api/.dockerignore`。
- 新增文案、注释、测试名、commit message 一律简体中文。
