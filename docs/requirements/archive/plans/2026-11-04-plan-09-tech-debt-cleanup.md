# 阶段 9 技术债清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已批准的阶段 9 设计，清理 P0 与工程类 P1/P2 技术债，把“已知但一直挂着”的工程项收口成可验证的改动。

**Architecture:** 四批次独立验收——A 安全与部署、B 运维与 CI、C 资金与并发、D 前端与文档。批内任务尽量互不依赖，按波次并行；每批结束跑定向验证，最后统一全量回归。

**Tech Stack:** NestJS 11 / Prisma 6 / PostgreSQL 16 / Redis 7 / Next.js 15.5 / Vitest 3 / Jest 30 / GitHub Actions / Docker Compose / Nginx。

**依据文档：**
- 设计：`docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md`
- 盘点：`docs/superpowers/plans/2026-11-04-tech-debt-inventory.md`

---

## 零、执行约定

### 0.1 本次采用的执行方式

采用 **agent-team 并行模式**：

1. 按「波次」并行派实施代理；同一波次内的任务不得改同一个文件。
2. **实施代理不提交、不做全量回归**，只跑本任务列出的定向测试。
3. 每个任务完成后先做规格审查，再做代码质量审查；两轮顺序不变，不同任务之间可并发。
4. 主控在每批审查通过后按任务提交（本计划每个 Task 末尾的 commit 命令由主控执行）。
5. 若改走 inline 执行，则按 Task 顺序逐条执行，每个 Task 末尾立即提交。

### 0.2 通用验证命令

```bash
# api
cd api && npx tsc --noEmit && npx eslint <改动文件>
npx jest <测试文件> --runInBand

# 三个前端（在各自目录）
npx tsc --noEmit && npm test -- <测试文件> && npm run lint

# compose 配置可解析
cd infra && docker compose config >/dev/null
```

> ⚠️ 本机 `ls` 被 alias 成 `eza`，脚本里不要依赖 `ls` 的可选参数；需要列文件时用 `find`。

### 0.3 批次与波次

| 波次 | 批次 | 任务 |
|---|---|---|
| 第 1 波 | A | Task 1–6 |
| 第 2 波 | B、C、D 中互不重叠的部分 | Task 7–14、17–19 |
| 第 3 波 | C 的资金脚本与依赖清理 | Task 15–16、20–21 |
| 第 4 波 | 收尾 | Task 22 |

**硬依赖：**
- Task 7（CI）依赖 Task 3（npm 11 统一）。
- Task 6 依赖 Task 3 中确定的 compose 默认值。
- Task 22 依赖前 21 个任务全部完成，测试条数必须最后实测。

---

## 一、批次 A：安全与部署

### Task 1：生产密钥守卫补全（API）

**Files：**
- Modify: `api/src/common/config/assert-secure-config.ts`
- Modify: `api/src/common/config/placeholder-secrets.ts`
- Test: `api/src/common/config/assert-secure-config.spec.ts`

- [ ] **Step 1：先写失败用例**

在 `assert-secure-config.spec.ts` 的 `KEYS` 数组补四项：

```ts
const KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'MINIO_ROOT_PASSWORD',
  'MINIO_SECRET_KEY',
  'FAKE_PAYMENT_ENABLED',
  'FAKE_PAYOUT_ENABLED',
  'CHANNEL_MODE',
  'PAYMENT_ENABLED_CHANNELS',
  'PAYOUT_ENABLED_CHANNELS',
  'PAYOUT_PLATFORM_DEFAULT_CHANNEL',
] as const;
```

在 `beforeEach` 的基线里补三项“合法值”（否则新断言会先在其他用例里误伤）：

```ts
// 生产基线的合法凭据：每个用例只覆盖自己关心的那一项。
process.env.DATABASE_URL =
  'postgresql://ecommerce:real-db-password@postgres:5432/ecommerce?schema=public';
process.env.REDIS_URL = 'redis://:real-redis-password@redis:6379';
process.env.MINIO_ROOT_PASSWORD = 'real-minio-password';
```

新增用例：

```ts
it('生产环境 + DATABASE_URL 使用默认密码 → 拒绝启动', () => {
  process.env.DATABASE_URL =
    'postgresql://ecommerce:ecommerce@postgres:5432/ecommerce?schema=public';

  expect(() => assertSecureConfig()).toThrow(/数据库密码/);
});

it('生产环境 + DATABASE_URL 没有密码 → 拒绝启动', () => {
  process.env.DATABASE_URL =
    'postgresql://ecommerce@postgres:5432/ecommerce?schema=public';

  expect(() => assertSecureConfig()).toThrow(/数据库密码/);
});

it('生产环境 + REDIS_URL 没有密码 → 拒绝启动', () => {
  process.env.REDIS_URL = 'redis://redis:6379';

  expect(() => assertSecureConfig()).toThrow(/Redis/);
});

it('生产环境 + MinIO 使用默认密码 → 拒绝启动', () => {
  process.env.MINIO_ROOT_PASSWORD = 'ecommerce-minio-secret';

  expect(() => assertSecureConfig()).toThrow(/MinIO/);
});

it('生产环境 + MinIO 密码为空 → 拒绝启动', () => {
  delete process.env.MINIO_ROOT_PASSWORD;
  delete process.env.MINIO_SECRET_KEY;

  expect(() => assertSecureConfig()).toThrow(/MinIO/);
});

it('非生产环境使用全部默认凭据 → 放行（本地开发）', () => {
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_URL =
    'postgresql://ecommerce:ecommerce@postgres:5432/ecommerce?schema=public';
  process.env.REDIS_URL = 'redis://redis:6379';
  process.env.MINIO_ROOT_PASSWORD = 'ecommerce-minio-secret';

  expect(() => assertSecureConfig()).not.toThrow();
});
```

在 `placeholder-secrets.ts` **不需要新增条目**：`.env.example` 的 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 直接复用 compose 默认值字面量，该值已在集合里（现有第 4 条）。

- [ ] **Step 2：运行，确认失败**

```bash
cd api && npx jest src/common/config/assert-secure-config.spec.ts --runInBand
```

预期：新增用例失败（`assertSecureConfig()` 没有抛错）。

- [ ] **Step 3：实现**

`assert-secure-config.ts`：

```ts
/** docker-compose 内置的默认数据库密码 */
const COMPOSE_DEFAULT_DB_PASSWORD = 'ecommerce';

/** docker-compose 内置的默认 MinIO 密码 */
const COMPOSE_DEFAULT_MINIO_PASSWORD = 'ecommerce-minio-secret';

export function assertSecureConfig(): void {
  assertJwtSecret();
  assertFakeToggles();
  assertProductionCredentials();
  assertChannelConfig();
}

/**
 * 生产环境的凭据守卫（阶段 9）。
 *
 * ⚠️ 只检查**本进程能看到的环境变量**：
 *    `AUTH_SECRET` 由 Next 进程读取，不在这里检查（见共享包的 `assertAuthSecret`）。
 * ⚠️ 非生产环境一律放行：本机 compose 与开发脚本本来就复用默认值。
 * ⚠️ URL 解析失败按「没有密码」处理（fail-closed），不吞异常后放行。
 */
function assertProductionCredentials(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const dbPassword = readUrlPassword(process.env.DATABASE_URL ?? '');
  if (!dbPassword || dbPassword === COMPOSE_DEFAULT_DB_PASSWORD) {
    throw new Error(
      '生产环境禁止使用默认/空的数据库密码：请设置 POSTGRES_PASSWORD，并同步更新 DATABASE_URL。',
    );
  }

  const redisPassword = readUrlPassword(process.env.REDIS_URL ?? '');
  if (!redisPassword) {
    throw new Error(
      '生产环境禁止使用无密码的 Redis：请在 REDIS_URL 中写入密码（redis://:密码@主机:端口）。',
    );
  }

  const minioPassword =
    process.env.MINIO_ROOT_PASSWORD ?? process.env.MINIO_SECRET_KEY ?? '';
  if (
    !minioPassword ||
    minioPassword === COMPOSE_DEFAULT_MINIO_PASSWORD
  ) {
    throw new Error(
      '生产环境禁止使用默认/空的 MinIO 密码：请设置 MINIO_ROOT_PASSWORD / MINIO_SECRET_KEY。',
    );
  }
}

/** 从连接串里取密码；非法 URL 或没有 userinfo 时返回空串。 */
function readUrlPassword(raw: string): string {
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw).password;
  } catch {
    return '';
  }
}
```

`placeholder-secrets.ts` **不新增条目**：`.env.example` 使用与 compose 默认值相同的字面量，而该字面量已经在 `KNOWN_PLACEHOLDER_SECRETS` 的第 4 条里，生产守卫会自动拒绝。

- [ ] **Step 4：运行，确认通过**

```bash
cd api && npx jest src/common/config --runInBand && npx tsc --noEmit
```

预期：全部通过，tsc 0 错误。

- [ ] **Step 5：提交**

```bash
git add api/src/common/config
git commit -m "feat(api): 生产环境补齐数据库/Redis/MinIO 默认凭据守卫"
```

---

### Task 2：三端 AUTH_SECRET 共享断言

**Files：**
- Create: `packages/frontend-shared/src/assert-auth-secret.ts`
- Modify: `storefront/src/auth.ts`
- Modify: `merchant-admin/src/auth.ts`
- Modify: `platform-admin/src/auth.ts`
- Test: `storefront/test/lib/assert-auth-secret.test.ts`
- Test: `merchant-admin/test/lib/assert-auth-secret.test.ts`
- Test: `platform-admin/test/lib/assert-auth-secret.test.ts`

- [ ] **Step 1：先写失败用例**

三个前端各建一份同样的测试（内容逐字相同，与仓库现有的三份 `jwt-callback.test.ts` 保持同一风格）：

```ts
/**
 * AUTH_SECRET 启动守卫：生产环境禁止使用空值或示例/默认值。
 *
 * ⚠️ 三端各一份是刻意的：`auth.ts` 本身就是三份副本，
 *    哪一端漏接守卫，都必须有测试当场暴露。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAuthSecret,
  KNOWN_AUTH_SECRET_PLACEHOLDERS,
} from '@ecom/frontend-shared/assert-auth-secret';

const savedNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
});

describe('assertAuthSecret', () => {
  it('生产环境 + 任一已知占位值 → 抛错', () => {
    process.env.NODE_ENV = 'production';

    for (const placeholder of KNOWN_AUTH_SECRET_PLACEHOLDERS) {
      expect(() => assertAuthSecret(placeholder)).toThrow(/AUTH_SECRET/);
    }
  });

  it('生产环境 + 空值 → 抛错', () => {
    process.env.NODE_ENV = 'production';

    expect(() => assertAuthSecret(undefined)).toThrow(/AUTH_SECRET/);
    expect(() => assertAuthSecret('')).toThrow(/AUTH_SECRET/);
  });

  it('生产环境 + 真实值 → 放行', () => {
    process.env.NODE_ENV = 'production';

    expect(() =>
      assertAuthSecret('a-real-auth-secret-with-enough-entropy'),
    ).not.toThrow();
  });

  it('非生产环境 + 占位值 → 放行（本地开发）', () => {
    process.env.NODE_ENV = 'development';

    expect(() => assertAuthSecret('change-me-auth-secret-at-least-32-chars')).not.toThrow();
  });
});
```

- [ ] **Step 2：运行，确认失败**

```bash
cd platform-admin && npm test -- test/lib/assert-auth-secret.test.ts
```

预期：模块不存在，导入失败。

- [ ] **Step 3：实现共享断言**

`packages/frontend-shared/src/assert-auth-secret.ts`：

```ts
/**
 * NextAuth 的 `AUTH_SECRET` 启动守卫（阶段 9）。
 *
 * ⚠️ **为什么放在共享包**：三端 `auth.ts` 是同一套逻辑的三份副本，
 *    守卫各写一份早晚漂移。这里只有一份实现，三端各调一次。
 *
 * ⚠️ **必须在 `auth.ts` 模块顶层调用**：NextAuth 在模块求值时读取 secret，
 *    等到请求进来再检查就晚了——进程已经带着默认密钥跑起来了。
 *
 * ⚠️ **占位值集合必须同时包含**：
 *    1. `infra/docker-compose.yml` 里 `${AUTH_SECRET:-...}` 的默认值；
 *    2. `infra/.env.example` 给开发者复制的显式占位值。
 *    只认其中一类，另一类就能原样进生产。
 */
export const KNOWN_AUTH_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  // infra/docker-compose.yml 的 ${AUTH_SECRET:-...} 默认值（与 compose 逐字相同）
  '<compose 中现有的 AUTH_SECRET 字面量>',
  // infra/.env.example 的显式占位值
  'change-me-auth-secret-at-least-32-chars',
]);

/** 生产环境禁止空值或已知默认值；非生产环境放行。 */
export function assertAuthSecret(secret: string | undefined): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (!secret) {
    throw new Error(
      '生产环境必须设置 AUTH_SECRET（可用 `openssl rand -base64 48` 生成）。',
    );
  }

  if (KNOWN_AUTH_SECRET_PLACEHOLDERS.has(secret)) {
    throw new Error(
      '生产环境禁止使用示例/默认的 AUTH_SECRET（含 docker-compose 内置默认值），请换成真实密钥。',
    );
  }
}
```

三端 `auth.ts` 在 import 之后、`NextAuth(...)` 之前各加两行：

```ts
import { assertAuthSecret } from '@ecom/frontend-shared/assert-auth-secret';

// ⚠️ 必须在模块求值时失败：NextAuth 在模块加载阶段就读取它。
assertAuthSecret(process.env.AUTH_SECRET);
```

- [ ] **Step 4：运行，确认通过**

```bash
cd storefront && npm test -- test/lib/assert-auth-secret.test.ts && npx tsc --noEmit
cd ../merchant-admin && npm test -- test/lib/assert-auth-secret.test.ts && npx tsc --noEmit
cd ../platform-admin && npm test -- test/lib/assert-auth-secret.test.ts && npx tsc --noEmit
```

预期：三端测试通过、tsc 0 错误。

- [ ] **Step 5：提交**

```bash
git add packages/frontend-shared/src/assert-auth-secret.ts \
  storefront/src/auth.ts merchant-admin/src/auth.ts platform-admin/src/auth.ts \
  storefront/test/lib/assert-auth-secret.test.ts \
  merchant-admin/test/lib/assert-auth-secret.test.ts \
  platform-admin/test/lib/assert-auth-secret.test.ts
git commit -m "feat(frontend-shared): 三端 AUTH_SECRET 生产占位值启动守卫"
```

---

### Task 3：compose 密钥可覆盖、端口回环与 MinIO digest

**Files：**
- Modify: `infra/docker-compose.yml`
- Modify: `infra/.env.example`（只加 `BIND_HOST` 与本任务相关的注释；完整补全在 Task 5）

- [ ] **Step 1：改 compose（逐处替换）**

1）API 的 `JWT_SECRET` 保留当前字面量作为默认值，改为可覆盖：

```yaml
      JWT_SECRET: ${JWT_SECRET:-<保留 compose 当前的 JWT_SECRET 字面量>}
```

2）三端 `AUTH_SECRET` 都改为（三处同值）：

```yaml
      AUTH_SECRET: ${AUTH_SECRET:-<保留 compose 当前的 AUTH_SECRET 字面量>}
```

3）MinIO API 端口与 nginx 端口绑回环，且主机可配：

```yaml
    ports:
      # 默认只绑本机回环；局域网访问显式设置 BIND_HOST=0.0.0.0
      - '${BIND_HOST:-127.0.0.1}:${MINIO_PORT:-19000}:9000'
```

```yaml
    ports:
      - '${BIND_HOST:-127.0.0.1}:${NGINX_PORT:-80}:80'
```

4）MinIO 镜像钉 digest（digest 已记录在 `infra/.env.example`）：

```yaml
    # 该 registry 只有 latest 一个 tag；用 digest 锁定到当前验证过的构建。
    # digest 来源：2026-11-04 `docker image inspect` 的 RepoDigests。
    image: cgr.dev/chainguard/minio@sha256:ad134b2dd572ae0d989d6807c3e45516cc75a34883a8021db2ff04be5d1d496a
```

- [ ] **Step 2：验证**

```bash
cd infra && docker compose config >/dev/null && docker compose config | grep -E 'AUTH_SECRET|JWT_SECRET|BIND_HOST|minio@sha256' | head
```

预期：命令退出 0；`JWT_SECRET`/`AUTH_SECRET` 显示展开后的当前默认值；两个端口前面有 `127.0.0.1`；镜像带 digest。

- [ ] **Step 3：提交**

```bash
git add infra/docker-compose.yml infra/.env.example
git commit -m "fix(infra): compose 密钥可覆盖、MinIO/nginx 默认只绑回环并钉镜像 digest"
```

---

### Task 4：Node/npm 版本统一

**Files：**
- Create: `.nvmrc`
- Modify: `api/package.json`
- Modify: `storefront/package.json`
- Modify: `merchant-admin/package.json`
- Modify: `platform-admin/package.json`
- Modify: `packages/frontend-shared/package.json`
- Modify 各项目 `package-lock.json`（`npm install --package-lock-only` 生成）
- Modify: `README.md`（记录基线）

- [ ] **Step 1：新增 `.nvmrc`**

```text
22
```

- [ ] **Step 2：五个 `package.json` 加 `engines`**

在 `"private": true` 之后加：

```json
  "engines": {
    "node": ">=22 <27",
    "npm": ">=11"
  },
```

五个文件：`api`、`storefront`、`merchant-admin`、`platform-admin`、`packages/frontend-shared`。

- [ ] **Step 3：重建 lock 的根元数据**

```bash
cd api && npm install --package-lock-only
cd ../packages/frontend-shared && npm install --package-lock-only
cd ../../storefront && npm install --package-lock-only
cd ../merchant-admin && npm install --package-lock-only
cd ../platform-admin && npm install --package-lock-only
```

预期：每个命令退出 0；lock 里各自 `packages[""]` 出现 `engines`。

- [ ] **Step 4：README 记录基线**

在 README 的开发环境段落补一句：

```markdown
> Node/npm 基线：Node 22 + npm 11（见仓库根 `.nvmrc`；本机 Node 26 也可用）。
> CI 与 Docker 镜像统一 npm 11；`package.json` 的 `engines` 只做提示，不作为安装闸。
```

- [ ] **Step 5：验证**

```bash
node -v && npm -v
cd api && npm ci --dry-run >/dev/null && echo api-lock-ok
```

预期：Node 22/26、npm 11；lock 可解析。

- [ ] **Step 6：提交**

```bash
git add .nvmrc api/package.json api/package-lock.json \
  storefront/package.json storefront/package-lock.json \
  merchant-admin/package.json merchant-admin/package-lock.json \
  platform-admin/package.json platform-admin/package-lock.json \
  packages/frontend-shared/package.json packages/frontend-shared/package-lock.json README.md
git commit -m "chore: 统一 Node 22 + npm 11 基线并补 engines/.nvmrc"
```

---

### Task 5：`.env.example` 补全

**Files：**
- Modify: `infra/.env.example`

- [ ] **Step 1：写入完整内容**

用下面的内容替换整个文件（保留现有注释里的 digest 与版本说明）：

```bash
# PostgreSQL 配置源：docker-compose.yml 通过 ${VAR:-默认值} 引用这里的变量。
# 复制为 .env 后可覆盖默认值；不复制也能起（compose 内置默认值与此处一致）。
# 用法：cp .env.example .env

# 宿主机绑定地址：默认只绑本机回环。
# 需要局域网访问时显式改成 0.0.0.0，并注意 MinIO 复用 root 凭据。
BIND_HOST=127.0.0.1

# 宿主机端口（本机 5432/6379 已被其他项目占用）
POSTGRES_USER=ecommerce
POSTGRES_PASSWORD=ecommerce
POSTGRES_DB=ecommerce
POSTGRES_PORT=15432
REDIS_PORT=16380
MINIO_PORT=19000
MINIO_CONSOLE_PORT=19001
API_PORT=3000
STOREFRONT_PORT=3001
MERCHANT_ADMIN_PORT=3002
PLATFORM_ADMIN_PORT=3003
NGINX_PORT=80

# 前端构建期变量（NEXT_PUBLIC_* 会被内联进产物）
NEXT_PUBLIC_TENANT_SUBDOMAIN=demo

# JWT 与 NextAuth 密钥
# ⚠️ 以下两个都是**示例值**：生产环境会被启动守卫拒绝，必须替换。
JWT_SECRET=<保留 .env.example 现有的 JWT_SECRET 占位值>
AUTH_SECRET=change-me-auth-secret-at-least-32-chars

# MinIO
MINIO_ROOT_USER=ecommerce
MINIO_ROOT_PASSWORD=ecommerce-minio-secret
# 允许直传的来源，英文逗号分隔。镜像里没有 mc，只能靠这个环境变量配 CORS。
MINIO_CORS_ALLOW_ORIGIN=http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost
# 三个 endpoint 各管各的：
# - MINIO_ENDPOINT 会被签进 presigned URL，必须是浏览器能访问的宿主机地址
# - MINIO_INTERNAL_ENDPOINT 是后端自己 HEAD/删除对象用的容器内地址
# - MINIO_PUBLIC_URL 写进 media.url
MINIO_ENDPOINT=http://localhost:19000
MINIO_INTERNAL_ENDPOINT=http://minio:9000
MINIO_PUBLIC_URL=http://localhost:19000
MINIO_BUCKET=ecommerce-media
MINIO_REGION=us-east-1
MEDIA_MAX_SIZE=5242880
# 当前镜像 digest（cgr.dev/chainguard/minio:latest 只有 latest 一个 tag，
# 没有版本 tag 可钉，compose 已直接用 digest 引用）：
# sha256:ad134b2dd572ae0d989d6807c3e45516cc75a34883a8021db2ff04be5d1d496a
# 对应 MinIO 版本 RELEASE.2026-09-22T19-25-18Z

# Redis
# 队列密码。只用字母与数字：密码会拼进 redis:// URL，特殊字符需要额外转义。
REDIS_PASSWORD=ecommerceRedis163

# 渠道（留空 = 使用代码默认值）
# ⚠️ 非生产环境即使留空，渠道列表也会列出 fake / fake-payout；
#    但 FAKE_PAYMENT_ENABLED / FAKE_PAYOUT_ENABLED 默认关闭 ——
#    「列表可见」不等于「调用可用」，调用会被拒绝。
CHANNEL_MODE=
PAYMENT_ENABLED_CHANNELS=
PAYOUT_ENABLED_CHANNELS=
PAYOUT_PLATFORM_DEFAULT_CHANNEL=
FAKE_PAYMENT_ENABLED=
FAKE_PAYOUT_ENABLED=

# 出款账户与账单快照的字段加密密钥（≥ 32 字符）。
# ⚠️ 这里填的是 compose 内置默认值：本机开发**保持不变**，
#    否则既有出款单快照会解不开。真实部署必须换成随机密钥；
#    生产环境使用默认值会被启动守卫拒绝。
# ⚠️ 轮换会导致既有快照永久解不开。
PAYOUT_ACCOUNT_ENCRYPTION_KEY=<与 compose 默认值相同的字面量>
```

> ⚠️ 这里填的字面量必须与 `infra/docker-compose.yml` 的默认值**逐字相同**；
> 它已经在 `placeholder-secrets.ts` 的已知占位集合里，生产环境会被拒绝启动。

- [ ] **Step 2：验证**

```bash
cd infra && cp .env.example /tmp/env.example.check && docker compose --env-file /tmp/env.example.check config >/dev/null && echo env-ok
```

预期：`env-ok`。若 compose 对某个值为空报错，把该变量改成注释，不要写空字符串。

- [ ] **Step 3：提交**

```bash
git add infra/.env.example
git commit -m "docs(infra): 补全 .env.example 的端口、密钥、MinIO 与渠道变量"
```

---

### Task 6：迁移流程收口

**Files：**
- Modify: `api/package.json`
- Modify: `AGENTS.md`
- Modify: `api/README.md`

- [ ] **Step 1：加 npm script**

在 `api/package.json` 的 `scripts` 里、`prisma:seed` 之后加：

```json
    "db:fix-legacy-checksum": "prisma db execute --schema prisma/schema.prisma --file prisma/fix-legacy-migration-checksum.sql",
```

- [ ] **Step 2：AGENTS.md 改为引用命令**

把现有这条：

```markdown
- 已应用旧版迁移的库若报 `migration have been modified`，按 `api/prisma/fix-legacy-migration-checksum.sql`
  的说明处理；**只在真报这个错时执行**。
```

改为：

```markdown
- 已应用旧版迁移的库若报 `migration have been modified`，在 `api/` 下执行
  `npm run db:fix-legacy-checksum`；**只在真报这个错时执行**，执行前先备份。
```

- [ ] **Step 3：api/README.md 的迁移章节补同一句**

在“数据库迁移与种子”一节末尾加：

```markdown
迁移报 `migration have been modified` 时，用 `npm run db:fix-legacy-checksum` 修正校验和；
不要用 `prisma migrate dev`（会要求清库）。
```

- [ ] **Step 4：验证**

```bash
cd api && node -e "const p=require('./package.json'); if(!p.scripts['db:fix-legacy-checksum']) process.exit(1); console.log('script-ok')"
```

预期：`script-ok`。

- [ ] **Step 5：提交**

```bash
git add api/package.json AGENTS.md api/README.md
git commit -m "chore(api): 迁移校验和修正固化为 npm script 并更新文档"
```

---

## 二、批次 B：运维与 CI

### Task 7：备份可验证、恢复脚本与 cron 示例

**Files：**
- Modify: `infra/backup.sh`
- Create: `infra/restore.sh`
- Create: `infra/crontab.example`
- Modify: `README.md`

- [ ] **Step 1：改 `backup.sh`**

1）保留天数改为正整数：

```bash
# 保留天数必须是正整数：0 会让 `-mtime +0` 删掉所有超过 1 天的备份。
if ! [[ "$BACKUP_KEEP_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup] BACKUP_KEEP_DAYS 必须是正整数：$BACKUP_KEEP_DAYS" >&2
  exit 1
fi
```

2）PostgreSQL 备份加 `--clean --if-exists`（否则恢复到非空库会撞「对象已存在」，恢复流程不可用）：

```bash
docker compose exec -T postgres pg_dump -U "$PG_USER" --clean --if-exists "$PG_DB" \
  | gzip > "$DEST/postgres-$PG_DB.sql.gz"
```

3）在读取 `.env` 之后加：

```bash
# 缺失卷的默认行为：失败退出。cron 场景需要显式选择才跳过。
ALLOW_MISSING_VOLUMES="${ALLOW_MISSING_VOLUMES:-0}"
```

4）MinIO / Redis 段替换为：

```bash
if [ -z "$MINIO_VOL" ]; then
  echo "[backup] 找不到 minio-data 卷" >&2
  if [ "$ALLOW_MISSING_VOLUMES" != "1" ]; then
    exit 1
  fi
  echo "[backup] ALLOW_MISSING_VOLUMES=1，跳过 MinIO 备份" >&2
else
  echo "[backup] minio volume: $MINIO_VOL"
  docker run --rm \
    -v "$MINIO_VOL":/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup \
    alpine tar czf "/backup/minio-data.tgz" -C /data .
  if ! tar tzf "$DEST/minio-data.tgz" >/dev/null; then
    echo "[backup] MinIO 备份校验失败，删除损坏文件" >&2
    rm -f "$DEST/minio-data.tgz"
    exit 1
  fi
  echo "[backup] MinIO 备份校验通过"
fi
```

Redis 段同样处理，产物名 `redis-data.tgz`，报错文案换成 Redis。

- [ ] **Step 2：新增 `infra/restore.sh`**

```bash
#!/usr/bin/env bash
# 从 ./backups/<时间戳>/ 恢复数据。
# 用法：
#   ./restore.sh postgres ./backups/<时间戳>/postgres-ecommerce.sql.gz --yes
#   ./restore.sh minio    ./backups/<时间戳>/minio-data.tgz --yes
#   ./restore.sh redis    ./backups/<时间戳>/redis-data.tgz --yes
# 不带 --yes 只打印计划，不动任何数据。
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

PG_USER="${POSTGRES_USER:-ecommerce}"
PG_DB="${POSTGRES_DB:-ecommerce}"

usage() {
  echo "用法：$0 <postgres|minio|redis> <备份文件> [--yes]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
TARGET="$1"
FILE="$2"
CONFIRM=0
if [ "${3:-}" = "--yes" ]; then
  CONFIRM=1
elif [ $# -ge 3 ]; then
  usage
fi

[ -f "$FILE" ] || { echo "[restore] 备份文件不存在：$FILE" >&2; exit 1; }
ABS_FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

find_volume() {
  docker volume ls --format '{{.Name}}' | grep -E "$1\$" | head -n1 || true
}

case "$TARGET" in
  postgres)
    echo "[restore] 计划：停止 api → 用 $ABS_FILE 覆盖数据库 $PG_DB → 启动 api"
    [ "$CONFIRM" = "1" ] || exit 0
    docker compose stop api
    # ⚠️ `ON_ERROR_STOP=1`：SQL 中途报错必须让脚本非零退出，
    #    不能「恢复了一半却显示完成」。
    gunzip -c "$ABS_FILE" | docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB"
    docker compose start api
    ;;
  minio|redis)
    VOL="$(find_volume "$TARGET-data")"
    if [ -z "$VOL" ]; then
      echo "[restore] 找不到 $TARGET-data 卷" >&2
      exit 1
    fi
    echo "[restore] 计划：停止 $TARGET → 清空卷 $VOL → 解包 $ABS_FILE → 启动 $TARGET"
    [ "$CONFIRM" = "1" ] || exit 0
    docker compose stop "$TARGET"
    docker run --rm \
      -v "$VOL":/data \
      -v "$(dirname "$ABS_FILE")":/backup:ro \
      alpine sh -c "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xzf /backup/$(basename "$ABS_FILE") -C /data"
    docker compose start "$TARGET"
    ;;
  *)
    usage
    ;;
esac

echo "[restore] 完成：$TARGET"
```

- [ ] **Step 3：新增 `infra/crontab.example`**

```cron
# 每天 03:00 备份。cron 的 PATH 常不含 docker，必须显式设置。
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
0 3 * * * cd /path/to/电商项目/infra && ./backup.sh >> backup.log 2>&1
```

- [ ] **Step 4：README 补 Redis 与恢复步骤**

把“数据备份”一节改为：

```markdown
### 数据备份与恢复

```bash
cd infra && ./backup.sh    # PostgreSQL 全量 + MinIO 数据卷 + Redis 数据卷 → infra/backups/<时间戳>/
```

定时备份见 `infra/crontab.example`。恢复前先确认目标：

```bash
cd infra
./restore.sh postgres ./backups/<时间戳>/postgres-ecommerce.sql.gz   # 先看计划，不执行
./restore.sh postgres ./backups/<时间戳>/postgres-ecommerce.sql.gz --yes
./restore.sh minio    ./backups/<时间戳>/minio-data.tgz --yes
./restore.sh redis    ./backups/<时间戳>/redis-data.tgz --yes
```

`infra/backups/` 已加入 `.gitignore`。
```

- [ ] **Step 5：验证**

```bash
cd infra && chmod +x restore.sh
bash -n backup.sh && bash -n restore.sh && echo syntax-ok
# 缺卷必须非零退出
ALLOW_MISSING_VOLUMES=0 BACKUP_DIR=/tmp/ecom-backup-test ./backup.sh; echo "exit=$?"
```

预期：`syntax-ok`；若本机没有 MinIO/Redis 卷，最后一条 `exit=1`。测试后清理 `/tmp/ecom-backup-test`。

- [ ] **Step 6：提交**

```bash
git add infra/backup.sh infra/restore.sh infra/crontab.example README.md
git commit -m "feat(infra): 备份完整性校验、缺失卷失败与可执行的恢复脚本"
```

---

### Task 8：CI 门禁（前端 lint + e2e + matrix）

**Files：**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1：改顶部注释**

```yaml
# 本机 git 直连不可达时，推送走 Git Data API；该方式现已能触发 push 事件。
# workflow_dispatch 保留为手动重跑入口。
```

- [ ] **Step 2：所有 job 在 `npm ci` 前统一 npm 11**

每个 `actions/setup-node@v4` 步骤之后加：

```yaml
      - run: npm install -g npm@11
```

共 5 个原 job + 新 e2e job。

- [ ] **Step 3：三个前端 job 收成一个 matrix**

删除 `storefront`、`merchant-admin`、`platform-admin` 三个 job，替换为：

```yaml
  frontend:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        include:
          - project: storefront
            tenant_subdomain: demo
          - project: merchant-admin
            tenant_subdomain: ''
          - project: platform-admin
            tenant_subdomain: ''
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: |
            ${{ matrix.project }}/package-lock.json
            packages/frontend-shared/package-lock.json
      - run: npm install -g npm@11
      - run: npm ci
        working-directory: packages/frontend-shared
      - run: npm ci
        working-directory: ${{ matrix.project }}
      - run: npx tsc --noEmit
        working-directory: ${{ matrix.project }}
      - run: npm test
        working-directory: ${{ matrix.project }}
      - run: npm run lint
        working-directory: ${{ matrix.project }}
      - run: npm run build
        working-directory: ${{ matrix.project }}
        env:
          NEXT_PUBLIC_TENANT_SUBDOMAIN: ${{ matrix.tenant_subdomain }}
          # auth.ts 模块顶层读 AUTH_SECRET，构建期预渲染用到 auth() 的路由会 MissingSecret
          AUTH_SECRET: ${{ secrets.CI_AUTH_SECRET || 'ci-auth-secret-with-enough-entropy' }}
          AUTH_TRUST_HOST: 'true'
```

> ⚠️ 不要往 workflow 里写真实生产密钥；这里只是让构建期 `auth.ts` 守卫能通过。
> 若仓库没有 `CI_AUTH_SECRET` secret，回落到固定字面量即可。

- [ ] **Step 4：新增 e2e job**

```yaml
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: ecommerce
          POSTGRES_PASSWORD: ecommerce
          POSTGRES_DB: ecommerce
        ports:
          - 15432:5432
        options: >-
          --health-cmd "pg_isready -U ecommerce"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 20
      redis:
        image: redis:7-alpine
        ports:
          - 16380:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public
      DATABASE_URL_TEST: postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public
      REDIS_URL: redis://localhost:16380
      BULLMQ_PREFIX: bull-e2e
      JWT_SECRET: ci-jwt-secret-with-enough-entropy-0123456789
      PAYOUT_ACCOUNT_ENCRYPTION_KEY: ci-payout-encryption-key-0123456789
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: api/package-lock.json
      - run: npm install -g npm@11
      - run: npm ci
        working-directory: api
      - run: npx prisma generate
        working-directory: api
      # Prisma 会自动创建 ecommerce_test，再装迁移需要的扩展
      - run: npx prisma migrate deploy
        working-directory: api
      - name: Install pg_trgm (e2e 测试库)
        run: docker exec ${{ job.services.postgres.id }} psql -U ecommerce -d ecommerce_test -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
      # media 套件依赖 MinIO，CI 不启动 MinIO，只排除这一套
      - run: npm run test:e2e -- --testPathIgnorePatterns=media.e2e-spec.ts
        working-directory: api
```

- [ ] **Step 5：验证**

```bash
# 本机只做静态校验：CI 语法与 actionlint（若已安装）
python3 - <<'PY'
import yaml
with open('.github/workflows/ci.yml') as f:
    data = yaml.safe_load(f)
assert {'api', 'shared', 'frontend', 'e2e'} <= set(data['jobs']), data['jobs'].keys()
print('yaml-ok')
PY
```

预期：`yaml-ok`。

- [ ] **Step 6：提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 前端 lint 门禁、e2e job 与前端 matrix 收敛"
```

---

## 三、批次 C：资金与并发护栏

### Task 9：回填闸（已出款周期拒绝回填）

**Files：**
- Create: `api/src/modules/billing/backfill-guard.ts`
- Test: `api/src/modules/billing/backfill-guard.spec.ts`
- Modify: `api/src/modules/billing/commission.service.ts`
- Modify: `api/src/modules/billing/receipt.service.ts`
- Modify: `api/scripts/backfill-commission-entries.ts`

- [ ] **Step 1：先写失败用例**

`backfill-guard.spec.ts`：

```ts
import { PayoutStatus } from '@prisma/client';
import {
  ActivePayoutsError,
  guardBackfill,
} from './backfill-guard';

function fakePrisma(payouts: unknown[]) {
  return {
    payout: {
      findMany: jest.fn().mockResolvedValue(payouts),
    },
  };
}

describe('回填闸', () => {
  it('存在活跃/已付款出款单 → 默认拒绝并带出清单', async () => {
    const prisma = fakePrisma([
      {
        tenantId: 'tenant-a',
        payoutNo: 'PO-1',
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-01T00:00:00.000Z'),
        kind: 'NORMAL',
        status: PayoutStatus.PAID,
      },
    ]);

    await expect(
      guardBackfill(prisma as never, false),
    ).rejects.toBeInstanceOf(ActivePayoutsError);
    expect(prisma.payout.findMany).toHaveBeenCalledTimes(1);

    // 终态失败单不能出现在「活跃」集合里
    const where = prisma.payout.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(
      expect.arrayContaining([PayoutStatus.PAID]),
    );
    expect(where.status.in).not.toContain(PayoutStatus.REJECTED);
    expect(where.status.in).not.toContain(PayoutStatus.CANCELLED);
    expect(where.status.in).not.toContain(PayoutStatus.FAILED);
  });

  it('--force → 不查询，直接放行', async () => {
    const prisma = fakePrisma([
      { tenantId: 'tenant-a', payoutNo: 'PO-1', status: PayoutStatus.PAID },
    ]);

    await expect(guardBackfill(prisma as never, true)).resolves.toBeUndefined();
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
  });

  it('只有终态失败单 → 放行', async () => {
    const prisma = fakePrisma([]);

    await expect(
      guardBackfill(prisma as never, false),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2：运行，确认失败**

```bash
cd api && npx jest src/modules/billing/backfill-guard.spec.ts --runInBand
```

预期：模块不存在。

- [ ] **Step 3：实现 guard**

`backfill-guard.ts`：

```ts
import { PayoutStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

/**
 * 「钱已经可能出去了」的出款状态。
 *
 * ⚠️ 只有 REJECTED / CANCELLED / FAILED 不算：它们没有把钱打出去。
 *    FAILED 仍然挂着 statementId，但失败不代表出款成功。
 */
const ACTIVE_PAYOUT_STATUSES = [
  PayoutStatus.REQUESTED,
  PayoutStatus.APPROVED,
  PayoutStatus.PROCESSING,
  PayoutStatus.PAID,
];

/** 一张阻止回填的出款单 */
export interface ActivePayoutPeriod {
  tenantId: string;
  payoutNo: string;
  periodStart: Date;
  periodEnd: Date;
  kind: string;
  status: PayoutStatus;
}

/** 有活跃出款单时抛出；调用方负责打印清单并非零退出。 */
export class ActivePayoutsError extends Error {
  constructor(readonly payouts: ActivePayoutPeriod[]) {
    super(
      `存在 ${payouts.length} 张未终结的出款单，拒绝对这些周期回填（重复回填 = 重复出款）。` +
        '确认要跳过着保护时使用 --force。',
    );
    this.name = 'ActivePayoutsError';
  }
}

/**
 * 回填前的闸。
 *
 * ⚠️ **必须在平台作用域下调用**：出款单是跨租户的，租户作用域只会看到一家。
 * ⚠️ **force 连查询都不做**：`--force` 是显式的运维决定，不需要再读一遍清单。
 */
export async function guardBackfill(
  prisma: TenantPrismaService,
  force: boolean,
): Promise<void> {
  if (force) {
    return;
  }

  const active = await prisma.payout.findMany({
    where: { status: { in: ACTIVE_PAYOUT_STATUSES } },
    select: {
      tenantId: true,
      payoutNo: true,
      periodStart: true,
      periodEnd: true,
      kind: true,
      status: true,
    },
    orderBy: { periodStart: 'asc' },
  });

  if (active.length > 0) {
    throw new ActivePayoutsError(active);
  }
}
```

- [ ] **Step 4：接入两个 backfill**

`CommissionService.backfill()` 与 `ReceiptService.backfill()` 的签名与入口改为：

```ts
async backfill(options: { force?: boolean } = {}): Promise<BackfillResult> {
  const result: BackfillResult = { /* 原字段 */ };

  await tenantContext.run(platformScope(), async () => {
    // ⚠️ 闸必须在物料查询之前：先挡住「已经出过款的周期」。
    await guardBackfill(this.prisma, options.force === true);

    // ...原有订单查询与循环保持不变...
  });

  return result;
}
```

> ⚠️ 两个 service 的返回类型名不同（`BackfillResult` / `ReceiptBackfillResult`），不要互抄。

- [ ] **Step 5：脚本支持 `--force`**

`api/scripts/backfill-commission-entries.ts`：

```ts
import { ActivePayoutsError } from '../src/modules/billing/backfill-guard';

async function main(): Promise<void> {
  loadEnv();
  const force = process.argv.includes('--force');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  let exitCode = 0;

  try {
    const commission = app.get(CommissionService);
    const receipt = app.get(ReceiptService);

    try {
      const result = await commission.backfill({ force });
      const receiptResult = await receipt.backfill({ force });
      // ...原有打印保持不变...
    } catch (cause) {
      if (cause instanceof ActivePayoutsError) {
        console.error(cause.message);
        for (const payout of cause.payouts) {
          console.error(
            `  - ${payout.payoutNo} tenant=${payout.tenantId} ` +
              `${payout.periodStart.toISOString().slice(0, 7)} ${payout.kind} ${payout.status}`,
          );
        }
        console.error('确认要跳过着保护时：npm run backfill:ledger -- --force');
        exitCode = 1;
      } else {
        throw cause;
      }
    }
  } finally {
    await app.close();
  }

  process.exit(exitCode);
}
```

- [ ] **Step 6：验证**

```bash
cd api && npx jest src/modules/billing/backfill-guard.spec.ts --runInBand && npx tsc --noEmit
```

预期：测试通过、tsc 0 错误。

- [ ] **Step 7：提交**

```bash
git add api/src/modules/billing/backfill-guard.ts \
  api/src/modules/billing/backfill-guard.spec.ts \
  api/src/modules/billing/commission.service.ts \
  api/src/modules/billing/receipt.service.ts \
  api/scripts/backfill-commission-entries.ts
git commit -m "feat(api): 回填前拦截已出款周期，默认拒绝并支持 --force"
```

---

### Task 10：批量重试“确定未打款”的失败出款单

**Files：**
- Create: `api/scripts/retry-pre-payout-failures.ts`
- Modify: `api/package.json`

- [ ] **Step 1：加 npm script**

```json
    "payout:retry-pre-payout": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' scripts/retry-pre-payout-failures.ts",
```

- [ ] **Step 2：实现脚本**

```ts
/**
 * 批量重试「确定未打款」的失败出款单（阶段 9）。
 *
 * ⚠️ **只选 `failedBeforePayout=true`**：这个标记意味着渠道从未被调用，
 *    钱确定没打出去。false 的单只能人工核对渠道，脚本绝不碰。
 *
 * ⚠️ **复用 `PayoutService.retry()`**：状态前置条件、事务、留痕、入队
 *    都在服务层，脚本不复制任何一条。
 *
 * ⚠️ **单条失败不中断整批**：一张单的状态可能在扫描后被别人改掉，
 *    整批中断会让其余可重试的单永远等不到处理。
 *
 * 用法（在 api/ 目录下）：
 *   npm run payout:retry-pre-payout
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { PayoutStatus, UserRole } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PayoutService } from '../src/modules/billing/payout.service';

const RETRY_REASON = '批量重试：解密/渠道前置失败，已确认未打款';

function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnv();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(TenantPrismaService);
    const payouts = app.get(PayoutService);

    const operator = await tenantContext.run(platformScope(), async () =>
      prisma.user.findFirst({
        where: { role: UserRole.PLATFORM_ADMIN },
        select: { id: true, email: true },
      }),
    );
    if (!operator) {
      throw new Error('找不到平台超管账号：批量重试需要操作人写 entry 留痕');
    }

    const targets = await tenantContext.run(platformScope(), async () =>
      prisma.payout.findMany({
        where: {
          status: PayoutStatus.FAILED,
          failedBeforePayout: true,
        },
        select: { id: true, payoutNo: true },
        orderBy: { requestedAt: 'asc' },
      }),
    );

    console.log(`操作人：${operator.email}`);
    console.log(`待重试：${targets.length} 张`);

    let succeeded = 0;
    let failed = 0;

    for (const target of targets) {
      try {
        await tenantContext.run(
          {
            tenantId: null,
            userId: operator.id,
            role: UserRole.PLATFORM_ADMIN,
          },
          () => payouts.retry(target.id, RETRY_REASON),
        );
        succeeded += 1;
        console.log(`  ✓ ${target.payoutNo}`);
      } catch (cause) {
        failed += 1;
        console.error(
          `  ✗ ${target.payoutNo}：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    console.log(`完成：成功 ${succeeded}，失败 ${failed}`);
  } finally {
    await app.close();
  }

  process.exit(0);
}

void main();
```

- [ ] **Step 3：验证**

```bash
cd api && npx tsc --noEmit && node -e "const p=require('./package.json'); if(!p.scripts['payout:retry-pre-payout']) process.exit(1); console.log('script-ok')"
```

预期：tsc 0 错误、`script-ok`。

- [ ] **Step 4：提交**

```bash
git add api/scripts/retry-pre-payout-failures.ts api/package.json
git commit -m "feat(api): 批量重试确定未打款的失败出款单脚本"
```

---

### Task 11：refresh token 过期行清理

**Files：**
- Modify: `api/src/modules/auth/token-grace.service.ts`
- Test: `api/src/modules/auth/token-grace.service.spec.ts`

- [ ] **Step 1：先写失败用例**

```ts
import { TokenGraceService } from './token-grace.service';

const NOW = new Date('2026-11-04T00:00:00.000Z');

function fakePrisma() {
  return {
    databaseNow: jest.fn().mockResolvedValue(NOW),
    refreshToken: {
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

function makeService(prisma: ReturnType<typeof fakePrisma>) {
  return new TokenGraceService(prisma as never, {} as never);
}

describe('TokenGraceService.cleanup', () => {
  it('删除超过 30 天保留期的过期行', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.cleanup();

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: {
          lt: new Date('2026-10-05T00:00:00.000Z'),
        },
      },
    });
    expect(result.deleted).toBe(2);
  });

  it('仍然抹掉已过宽限期的密文', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.cleanup();

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        graceExpiresAt: { lt: NOW },
        rotatedToToken: { not: null },
      },
      data: { rotatedToToken: null },
    });
    expect(result.cleared).toBe(3);
  });
});
```

- [ ] **Step 2：运行，确认失败**

```bash
cd api && npx jest src/modules/auth/token-grace.service.spec.ts --runInBand
```

预期：`cleanup()` 返回数字而不是对象，断言失败。

- [ ] **Step 3：实现**

```ts
/** 过期行保留的天数（审计窗口） */
const REFRESH_TOKEN_RETENTION_DAYS = 30;

/** 清理结果：抹密文与删行分开计数，日志要能看出各自多少 */
export interface TokenCleanupResult {
  cleared: number;
  deleted: number;
}
```

`onModuleInit` 的日志改为：

```ts
const result = await this.cleanup();
if (result.cleared > 0 || result.deleted > 0) {
  this.logger.log(
    `启动时清理了 ${result.cleared} 条宽限密文、${result.deleted} 条过期令牌行`,
  );
}
```

`cleanup()` 改为：

```ts
async cleanup(): Promise<TokenCleanupResult> {
  const now = await this.prisma.databaseNow();
  const retentionCutoff = new Date(
    now.getTime() - REFRESH_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  // ⚠️ **先删行再抹密文**：过期超过保留期的行整行删除，
  //    没必要再为它做一次 UPDATE。
  const deleted = await this.prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: retentionCutoff } },
  });

  const cleared = await this.prisma.refreshToken.updateMany({
    where: {
      graceExpiresAt: { lt: now },
      rotatedToToken: { not: null },
    },
    data: { rotatedToToken: null },
  });

  return { cleared: cleared.count, deleted: deleted.count };
}
```

同时更新类顶部注释：由“只清列不删行”改为“30 天内只清列，超过保留期才删行”。

- [ ] **Step 4：验证**

```bash
cd api && npx jest src/modules/auth/token-grace.service.spec.ts --runInBand && npx tsc --noEmit
```

- [ ] **Step 5：提交**

```bash
git add api/src/modules/auth/token-grace.service.ts api/src/modules/auth/token-grace.service.spec.ts
git commit -m "feat(api): 宽限清理同时删除超过 30 天保留期的过期令牌行"
```

---

### Task 12：刷新宽限期改用数据库时钟

**Files：**
- Modify: `api/src/modules/auth/auth.service.ts`
- Test: `api/src/modules/auth/auth.service.spec.ts`（新建）

- [ ] **Step 1：先写失败用例**

```ts
import { AuthService } from './auth.service';

const DB_NOW = new Date('2026-11-04T00:00:00.000Z');

function makeService(stored: Record<string, unknown>, dbNow: Date) {
  const prisma = {
    databaseNow: jest.fn().mockResolvedValue(dbNow),
    refreshToken: {
      findFirst: jest.fn().mockResolvedValue(stored),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };

  return {
    prisma,
    service: new AuthService(prisma as never, jwt as never),
  };
}

function expiredToken() {
  return {
    id: 'token-1',
    userId: 'user-1',
    tokenHash: 'hash',
    revokedAt: null,
    revokedReason: null,
    expiresAt: new Date('2026-11-03T00:00:00.000Z'),
    graceExpiresAt: null,
    rotatedToToken: null,
    user: {
      id: 'user-1',
      email: 'a@example.com',
      displayName: 'A',
      role: 'MERCHANT_OWNER',
      tenantId: 'tenant-a',
    },
  };
}

describe('AuthService.refresh：时钟跟随数据库', () => {
  it('应用时钟未过期、数据库时钟已过期 → 401', async () => {
    // 应用此时是 2026-11-02，令牌在 11-03 过期，看起来“还没过期”；
    // 数据库已经是 11-04，必须按数据库判定为过期。
    jest.useFakeTimers().setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
    const { service } = makeService(expiredToken(), DB_NOW);

    await expect(service.refresh('raw-token')).rejects.toThrow(
      '刷新令牌无效或已过期',
    );

    jest.useRealTimers();
  });
});
```

- [ ] **Step 2：运行，确认失败**

```bash
cd api && npx jest src/modules/auth/auth.service.spec.ts --runInBand
```

预期：用例失败（当前实现用 `new Date()`，判定为未过期，继续走轮换）。

- [ ] **Step 3：实现**

`refresh()` 入口取一次数据库时钟，并全程复用它：

```ts
async refresh(refreshToken: string): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(refreshToken);

  // ⚠️ **整次刷新只取一次时钟，且用数据库时钟**。
  //    原来的 `new Date()` 与 `databaseNow()` 不是同一个时钟：
  //    多副本/容器时钟偏几秒时，宽限期判定会与清理任务不一致
  //    → 既被判定在宽限期、密文又被清理掉，最后吊销整族。
  const now = await this.prisma.databaseNow();

  const stored = await this.prisma.refreshToken.findFirst({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) {
    throw new UnauthorizedException('刷新令牌无效或已过期');
  }

  if (stored.revokedAt) {
    return this.handleRevokedToken(stored, now);
  }

  if (stored.expiresAt < now) {
    throw new UnauthorizedException('刷新令牌无效或已过期');
  }

  // ...中间不变...

  const rotated = await this.prisma.$transaction(async (tx) => {
    // ⚠️ **沿用入口那一次时钟**：事务内再取一次会让
    //    revokedAt 与 graceExpiresAt 跨过毫秒边界（阶段 5c 已修过一次）。
    const count = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: {
        revokedAt: now,
        revokedReason: RefreshTokenRevokedReason.ROTATED,
        rotatedToToken: encryptToken(newRefreshToken, this.graceKey),
        graceExpiresAt: new Date(now.getTime() + REFRESH_GRACE_PERIOD_MS),
      },
    });
    // ...其余不变...
  });
  // ...其余不变...
}
```

`handleRevokedToken` 签名与判定改为：

```ts
private async handleRevokedToken(
  stored: Prisma.RefreshTokenGetPayload<{ include: { user: true } }>,
  now: Date,
): Promise<AuthResult> {
  // ...
  if (
    stored.revokedReason === RefreshTokenRevokedReason.ROTATED &&
    stored.graceExpiresAt &&
    now < stored.graceExpiresAt
  ) {
    // ...
  }
}
```

- [ ] **Step 4：运行，确认通过**

```bash
cd api && npx jest src/modules/auth --runInBand && npx tsc --noEmit
```

- [ ] **Step 5：提交**

```bash
git add api/src/modules/auth/auth.service.ts api/src/modules/auth/auth.service.spec.ts
git commit -m "fix(api): 刷新令牌的过期与宽限期判定统一改用数据库时钟"
```

---

### Task 13：`unconfirm` 收窄 TOCTOU（事务化）

**Files：**
- Modify: `api/src/modules/billing/settlement.service.ts`
- Modify: `api/src/modules/billing/settlement.service.spec.ts`

- [ ] **Step 1：先改测试桩并加失败用例**

在 `fakePrisma` 的 `$transaction` 里，让 `tx` 复用同一批 mock：

```ts
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      calls.push('$transaction');
      const tx = {
        settlementStatement: prisma.settlementStatement,
        payout: prisma.payout,
        settlementStatementEntry: {
          deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
          createMany: jest.fn(() => {
            calls.push('createMany');
            if (options.createManyThrows) {
              return Promise.reject(uniqueViolation());
            }
            return Promise.resolve({ count: 1 });
          }),
        },
      };
      return fn(tx);
    }),
```

> ⚠️ `prisma` 在闭包里被引用时已经初始化完成；`$transaction` 只会在调用时求值。

新增一条用例：闸与更新必须在同一个事务里。

```ts
it('取消确认在同一个事务里完成回查与更新', async () => {
  const prisma = fakePrisma({
    statements: [statement({ status: SettlementStatus.CONFIRMED })],
    affectedCount: 1,
  });
  const service = makeService(prisma);

  await service.unconfirm('stmt-a');

  expect(prisma.calls).toContain('$transaction');
});
```

- [ ] **Step 2：运行，确认失败**

```bash
cd api && npx jest src/modules/billing/settlement.service.spec.ts --runInBand
```

预期：新用例失败（`unconfirm` 目前不进入事务）。

- [ ] **Step 3：实现**

把 `hasActivePayoutReference` 改为接受事务客户端：

```ts
import type { Prisma } from '@prisma/client';

private async hasActivePayoutReference(
  statementId: string,
  client: Prisma.TransactionClient = this.prisma as unknown as Prisma.TransactionClient,
): Promise<boolean> {
  const referenced = await client.payout.findFirst({
    where: {
      statementId,
      status: {
        notIn: [
          PayoutStatus.REJECTED,
          PayoutStatus.CANCELLED,
          PayoutStatus.FAILED,
        ],
      },
    },
    select: { id: true },
  });
  return referenced !== null;
}
```

`unconfirm` 整体改为：

```ts
async unconfirm(statementId: string): Promise<SettlementView> {
  return tenantContext.run(platformScope(), async () => {
    // ⚠️ **回查与条件更新必须在同一个事务里**：
    //    原来「读出款单 → 更新状态」分两步，中间新建的出款单看不见。
    //    事务内回查能把「更新之后、提交之前」的插入纳入同一个快照。
    //    ⚠️ 仍不能覆盖「回查之后、提交之前」的纳秒级窗口 ——
    //    `approve` 侧继续回查结算单状态作为第二道防线。
    const updated = await this.prisma.$transaction(async (tx) => {
      const statement = await tx.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (statement.status !== SettlementStatus.CONFIRMED) {
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能取消确认`,
        );
      }

      if (
        await this.hasActivePayoutReference(
          statementId,
          tx as unknown as Prisma.TransactionClient,
        )
      ) {
        throw new ConflictException(
          '该结算单已被出款单引用，不能取消确认。若出款已执行，请走调账流程。',
        );
      }

      const affected = await tx.settlementStatement.updateMany({
        where: { id: statementId, status: SettlementStatus.CONFIRMED },
        data: { status: SettlementStatus.DRAFT, confirmedAt: null },
      });

      if (affected.count === 0) {
        // ⚠️ 仍要按实际状态报错：并发下可能已被别人改成 PAID。
        //    这里在事务内再读一次，抛错会让整个事务回滚。
        const current = await tx.settlementStatement.findFirst({
          where: { id: statementId },
        });
        throw new ConflictException(
          `结算单当前是「${current?.status ?? '未知'}」状态，不能取消确认`,
        );
      }

      const after = await tx.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!after) {
        throw new NotFoundException('结算单不存在');
      }
      return after;
    });

    return this.toView(updated);
  });
}
```

> ⚠️ `tx` 的类型是扩展客户端的交易上下文，与 `Prisma.TransactionClient` 不完全兼容；
> 与 `payout-execution.service.ts` 的既有写法一致，用 `as unknown as` 收窄。
> 不要在事务外再补一次读取：事务内读取到的就是本次判定看到的同一份状态。

- [ ] **Step 4：运行，确认通过**

```bash
cd api && npx jest src/modules/billing/settlement.service.spec.ts --runInBand && npx tsc --noEmit
```

- [ ] **Step 5：提交**

```bash
git add api/src/modules/billing/settlement.service.ts api/src/modules/billing/settlement.service.spec.ts
git commit -m "fix(api): 取消确认的出款单回查与状态更新收进同一事务"
```

---

### Task 14：结算单 CSV 导出

**Files：**
- Create: `api/src/common/http/csv.ts`
- Test: `api/src/common/http/csv.spec.ts`
- Modify: `api/src/modules/billing/settlement.service.ts`
- Modify: `api/src/modules/billing/platform-settlement.controller.ts`
- Test: `api/src/modules/billing/platform-settlement.controller.spec.ts`（新建）
- Modify: `platform-admin/src/app/(dashboard)/settlements/page.tsx`
- Create: `platform-admin/src/app/api/billing/settlements/export/route.ts`
- Test: `platform-admin/test/app/api/settlements-export-route.test.ts`

- [ ] **Step 1：先写 CSV 工具的失败用例**

`csv.spec.ts`：

```ts
import { escapeCsvCell, toCsv } from './csv';

describe('CSV 转义', () => {
  it('含逗号/引号/换行的字段加引号并双写引号', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('公式注入：= + - @ 开头的单元格前置单引号', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+86')).toBe("'+86");
    expect(escapeCsvCell('-12.00')).toBe("'-12.00");
    expect(escapeCsvCell('@cmd')).toBe("'@cmd");
  });

  it('空值与普通值原样输出', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell('STL-1')).toBe('STL-1');
  });
});

describe('toCsv', () => {
  it('空列表也能生成表头', () => {
    expect(toCsv(['结算单号', '净额'], [])).toBe('结算单号,净额\r\n');
  });

  it('逐行拼接并用 CRLF 结尾', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});
```

- [ ] **Step 2：运行，确认失败**

```bash
cd api && npx jest src/common/http/csv.spec.ts --runInBand
```

- [ ] **Step 3：实现 CSV 工具**

`api/src/common/http/csv.ts`：

```ts
/**
 * 极简 CSV 生成（阶段 9）。
 *
 * ⚠️ **公式注入防护**：`=`、`+`、`-`、`@` 开头的单元格会被 Excel/Sheets
 *    当成公式执行。即使数据来自自己的数据库，商家名与账目字段也可能是
 *    用户可控的，导出文件被运营打开时就可能执行。
 *
 * ⚠️ 负数的负号也会被前置单引号 —— 这是**刻意的取舍**：
 *    列含义比「能否直接求和」更重要，导入方应按文本处理。
 */
export function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;

  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** 表头 + 数据行 → CSV 文本（CRLF 结尾） */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const lines = [headers, ...rows].map((row) =>
    row.map(escapeCsvCell).join(','),
  );
  return `${lines.join('\r\n')}\r\n`;
}
```

- [ ] **Step 4：服务层加导出方法**

在 `SettlementService` 里加（金额按「分 → 元」展示）：

```ts
/**
 * 导出结算单 CSV。
 *
 * ⚠️ **仍受 `MAX_PAGE_SIZE` 限制**：不做跨页全量导出，
 *    超过上限时按周期筛选，与列表页文案口径一致。
 */
async exportCsv(input: { period?: string }): Promise<string> {
  const { items } = await this.list({
    period: input.period,
    page: 1,
    pageSize: MAX_PAGE_SIZE,
  });

  const yuan = (cents: number): string => (cents / 100).toFixed(2);

  return toCsv(
    [
      '结算单号',
      '商家',
      '子域名',
      '周期',
      '抽佣毛额',
      '退款冲回',
      '净额',
      '流水笔数',
      '缺笔数',
      '状态',
      '确认时间',
    ],
    items.map((item) => [
      item.statementNo,
      item.tenantName,
      item.subdomain,
      item.periodLabel,
      yuan(item.grossAmount),
      yuan(item.reversalAmount),
      yuan(item.netAmount),
      item.entryCount,
      item.missingEntryCount,
      item.status,
      item.confirmedAt ?? '',
    ]),
  );
}
```

导入：

```ts
import { MAX_PAGE_SIZE } from '../../common/http/pagination';
import { toCsv } from '../../common/http/csv';
```

- [ ] **Step 5：控制器加导出路由**

> ⚠️ **必须放在 `@Get('settlements/:id')` 之前**，否则 `export` 会被 `:id` 吞掉并触发 UUID 校验 400。

```ts
import { StreamableFile } from '@nestjs/common';

  @Get('settlements/export')
  @ApiOperation({ summary: '导出结算单 CSV（最多 100 条）' })
  async export(@Query() query: SettlementListQueryDto) {
    const csv = await this.settlements.exportCsv({ period: query.period });

    return new StreamableFile(Buffer.from(`\uFEFF${csv}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="settlements-${query.period ?? 'all'}.csv"`,
    });
  }
```

- [ ] **Step 6：控制器单测**

`platform-settlement.controller.spec.ts`：

```ts
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PlatformSettlementController } from './platform-settlement.controller';

describe('PlatformSettlementController CSV 导出', () => {
  it('类级权限是 PLATFORM_ADMIN', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, PlatformSettlementController),
    ).toEqual([UserRole.PLATFORM_ADMIN]);
  });

  it('空列表也返回表头，并带 UTF-8 BOM', async () => {
    const service = {
      exportCsv: jest.fn().mockResolvedValue('结算单号,商家\r\n'),
    };
    const controller = new PlatformSettlementController(service as never);

    const file = await controller.export({} as never);
    // 用公开的 getStream() 收集内容，不依赖 StreamableFile 的私有字段名。
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    const text = Buffer.concat(chunks).toString('utf8');

    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('结算单号,商家');
    expect(service.exportCsv).toHaveBeenCalledWith({ period: undefined });
  });
});
```

> `StreamableFile` 的构造选项在不同 Nest 小版本里字段名可能变化；
> 断言只用公开 API（`getStream()`）与响应内容。

- [ ] **Step 7：前端中转路由**

`platform-admin/src/app/api/billing/settlements/export/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { API_BASE_URL } from '@/lib/api-client';
import { unauthorizedResponse } from '@/lib/route-helpers';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 结算单 CSV 导出的中转。
 *
 * ⚠️ 不能走 `apiFetch`：它把响应当 JSON 解析，而这里是 `text/csv`。
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  const period = new URL(request.url).searchParams.get('period');
  if (period !== null && !PERIOD_PATTERN.test(period)) {
    return NextResponse.json(
      { message: '周期格式非法：必须是 YYYY-MM（如 2026-10）' },
      { status: 400 },
    );
  }

  const query = period ? `?period=${encodeURIComponent(period)}` : '';
  const response = await fetch(
    `${API_BASE_URL}/platform/settlements/export${query}`,
    { headers: { authorization: `Bearer ${session.accessToken}` } },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    return NextResponse.json(
      { message: body?.message ?? '导出失败' },
      { status: response.status },
    );
  }

  return new NextResponse(await response.text(), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition':
        response.headers.get('content-disposition') ??
        `attachment; filename="settlements-${period ?? 'all'}.csv"`,
    },
  });
}
```

- [ ] **Step 8：前端页面加导出按钮并改 pageSize**

`platform-admin/src/app/(dashboard)/settlements/page.tsx`：

1）`pageSize=200` 改成 `pageSize=100`（两处 query 拼接）。
2）注释改为“后端上限 100”。
3）文案 `超过 200 张时请按周期筛选` 改为 `超过 100 张时请按周期筛选`。
4）在 `CardHeader` 右侧加导出链接：

```tsx
<a
  href={`/api/billing/settlements/export${
    periodParam ? `?period=${encodeURIComponent(periodParam)}` : ''
  }`}
  className="text-sm underline underline-offset-4 hover:no-underline"
>
  导出 CSV
</a>
```

- [ ] **Step 9：前端路由测试**

`platform-admin/test/app/api/settlements-export-route.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: 'http://api.test/api/v1',
}));

import { auth } from '@/auth';
import { GET } from '@/app/api/billing/settlements/export/route';

const authMock = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('结算单 CSV 导出中转', () => {
  it('未登录 → 401 且不请求后端', async () => {
    authMock.mockResolvedValue(null as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request('http://localhost/api/billing/settlements/export'),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非法周期 → 400 且不请求后端', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request(
        'http://localhost/api/billing/settlements/export?period=2026-13',
      ),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('转发 Bearer 并把 text/csv 原样返回', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('结算单号,商家\r\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="settlements-2026-10.csv"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request(
        'http://localhost/api/billing/settlements/export?period=2026-10',
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/platform/settlements/export?period=2026-10',
      { headers: { authorization: 'Bearer token' } },
    );
    expect(response.headers.get('content-type')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(await response.text()).toContain('结算单号');
  });
});
```

- [ ] **Step 10：验证**

```bash
cd api && npx jest src/common/http/csv.spec.ts src/modules/billing/platform-settlement.controller.spec.ts --runInBand && npx tsc --noEmit
cd ../platform-admin && npm test -- test/app/api/settlements-export-route.test.ts && npx tsc --noEmit
```

- [ ] **Step 11：提交**

```bash
git add api/src/common/http/csv.ts api/src/common/http/csv.spec.ts \
  api/src/modules/billing/settlement.service.ts \
  api/src/modules/billing/platform-settlement.controller.ts \
  api/src/modules/billing/platform-settlement.controller.spec.ts \
  platform-admin/src/app/'(dashboard)'/settlements/page.tsx \
  platform-admin/src/app/api/billing/settlements/export/route.ts \
  platform-admin/test/app/api/settlements-export-route.test.ts
git commit -m "feat(billing): 结算单 CSV 导出（含转义与公式注入防护）"
```

---

### Task 15：分页文案与上限对齐

**Files：**
- Modify: `api/src/modules/billing/dto/settlement-list-query.dto.ts`
- Modify: `platform-admin/src/app/(dashboard)/settlements/page.tsx`（若 Task 14 已改完，只核对）

- [ ] **Step 1：DTO 用共享上限**

```ts
import { MAX_PAGE_SIZE } from '../../../common/http/pagination';
```

```ts
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
```

并更新 `@ApiPropertyOptional({ description: '每页条数（上限 100）', example: 100 })`。

- [ ] **Step 2：核对前端**

```bash
grep -n "pageSize=100\|超过 100 张" platform-admin/src/app/'(dashboard)'/settlements/page.tsx
grep -rn "pageSize=200" platform-admin/src || true
```

预期：前一条命中两处；后一条无输出。

- [ ] **Step 3：验证**

```bash
cd api && npx jest src/modules/billing/settlement.service.spec.ts --runInBand && npx tsc --noEmit
```

- [ ] **Step 4：提交**

```bash
git add api/src/modules/billing/dto/settlement-list-query.dto.ts
git commit -m "fix(billing): 结算单分页上限统一为 100 并同步文案"
```

---

### Task 16：中转路由会话判空（`!session` → `!session?.accessToken`）

**Files：**
- Modify: `merchant-admin/src/app/api/**/route.ts`（48 处）
- Modify: `platform-admin/src/app/api/**/route.ts`（22 处）
- Modify: `merchant-admin/test/app/api/auth-guard.test.ts`
- Modify: `platform-admin/test/app/api/billing-whitelist.test.ts`

- [ ] **Step 1：先补失败用例**

`merchant-admin/test/app/api/auth-guard.test.ts` 追加：

```ts
describe('护栏 1 补强：session 存在但 accessToken 为空', () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ accessToken: '' } as never);
  });

  it('GET /api/categories → 401 且不调后端', async () => {
    const response = await categoriesGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/products/batch → 401 且不调后端', async () => {
    const response = await batchPost(
      postRequest('http://localhost/api/products/batch', {
        ids: ['a'],
        action: 'PUBLISH',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
```

`platform-admin/test/app/api/billing-whitelist.test.ts` 的“未登录不碰后端”区块追加两条：

```ts
  it('session 存在但 accessToken 为空：GET 套餐列表 → 401 且不调后端', async () => {
    authMock.mockResolvedValue({ accessToken: '' } as never);

    const response = await plansGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('session 存在但 accessToken 为空：POST 创建套餐 → 401 且不调后端', async () => {
    authMock.mockResolvedValue({ accessToken: '' } as never);

    const response = await plansPost(
      postRequest('http://localhost/api/billing/plans', {}),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
```

> 导入名以文件里现有的 GET/POST 别名为准（`plansGet` / `plansPost` 若不存在，用该文件已有的别名）。

- [ ] **Step 2：运行，确认失败**

```bash
cd merchant-admin && npm test -- test/app/api/auth-guard.test.ts
cd ../platform-admin && npm test -- test/app/api/billing-whitelist.test.ts
```

预期：新用例 500/继续调后端，而不是 401。

- [ ] **Step 3：codemod**

```bash
cd /Users/tom/orca/projects/电商项目
for d in merchant-admin platform-admin; do
  find "$d/src/app/api" -type f -name '*.ts' -print0 \
    | xargs -0 perl -0pi -e 's/if \(!session\) \{/if (!session?.accessToken) {/g'
done
```

- [ ] **Step 4：核对数量**

```bash
grep -rn "if (!session)" merchant-admin/src/app/api platform-admin/src/app/api --include='*.ts' | wc -l
grep -rn "if (!session?.accessToken)" merchant-admin/src/app/api platform-admin/src/app/api --include='*.ts' | wc -l
```

预期：第一行 `0`；第二行 `70`。

- [ ] **Step 5：运行，确认通过**

```bash
cd merchant-admin && npm test -- test/app/api/auth-guard.test.ts && npx tsc --noEmit
cd ../platform-admin && npm test -- test/app/api/billing-whitelist.test.ts && npx tsc --noEmit
```

- [ ] **Step 6：提交**

```bash
git add merchant-admin/src/app/api platform-admin/src/app/api \
  merchant-admin/test/app/api/auth-guard.test.ts \
  platform-admin/test/app/api/billing-whitelist.test.ts
git commit -m "fix(admin): 中转路由同时校验 session 与 accessToken 非空"
```

---

### Task 17：storefront loading 骨架

**Files：**
- Create: `storefront/src/app/(shop)/account/loading.tsx`
- Create: `storefront/src/app/(shop)/checkout/loading.tsx`
- Create: `storefront/src/app/(shop)/coupons/loading.tsx`
- Create: `storefront/src/app/(shop)/search/loading.tsx`

- [ ] **Step 1：写四个文件**

每个文件内容与 `orders/loading.tsx` 风格一致：

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

- [ ] **Step 2：验证**

```bash
cd storefront && npx tsc --noEmit && npm run build >/dev/null && echo build-ok
```

预期：`build-ok`（若本机缺少构建环境变量，按 README 补 `AUTH_SECRET` 与 `NEXT_PUBLIC_TENANT_SUBDOMAIN`）。

- [ ] **Step 3：提交**

```bash
git add storefront/src/app/'(shop)'/account/loading.tsx \
  storefront/src/app/'(shop)'/checkout/loading.tsx \
  storefront/src/app/'(shop)'/coupons/loading.tsx \
  storefront/src/app/'(shop)'/search/loading.tsx
git commit -m "feat(storefront): 账户、结算、优惠券、搜索页补 loading 骨架"
```

---

## 四、批次 D：依赖与文档

### Task 18：依赖清理

**Files：**
- Modify: `api/package.json` + `api/package-lock.json`
- Modify: `storefront/package.json` + lock
- Modify: `merchant-admin/package.json` + lock
- Modify: `platform-admin/package.json` + lock
- Modify: `packages/frontend-shared/package.json` + lock

- [ ] **Step 1：删除确认无用的依赖**

```bash
cd api && npm uninstall @nestjs/config
cd ../merchant-admin && npm uninstall --save-dev shadcn
cd ../platform-admin && npm uninstall --save-dev shadcn
cd ../storefront && npm uninstall --save-dev shadcn
```

- [ ] **Step 2：共享包 `react-dom` 先确认再删**

```bash
cd /Users/tom/orca/projects/电商项目
grep -rn "react-dom" packages/frontend-shared/src || echo no-react-dom-usage
```

预期：`no-react-dom-usage`。若确有使用则保留，并在任务记录里写明原因。

确认无使用后：

```bash
cd packages/frontend-shared && npm uninstall react-dom @types/react-dom
```

- [ ] **Step 3：修正 seed 引号**

`api/package.json`：

```json
  "prisma": {
    "seed": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' prisma/seed.ts"
  },
```

- [ ] **Step 4：验证**

```bash
cd api && npm ci --dry-run >/dev/null && npx tsc --noEmit && echo api-ok
cd ../storefront && npm ci --dry-run >/dev/null && npx tsc --noEmit && echo storefront-ok
cd ../merchant-admin && npm ci --dry-run >/dev/null && npx tsc --noEmit && echo merchant-ok
cd ../platform-admin && npm ci --dry-run >/dev/null && npx tsc --noEmit && echo platform-ok
cd ../packages/frontend-shared && npx tsc --noEmit && echo shared-ok
```

- [ ] **Step 5：提交**

```bash
git add api/package.json api/package-lock.json \
  storefront/package.json storefront/package-lock.json \
  merchant-admin/package.json merchant-admin/package-lock.json \
  platform-admin/package.json platform-admin/package-lock.json \
  packages/frontend-shared/package.json packages/frontend-shared/package-lock.json
git commit -m "chore: 删除未使用的 @nestjs/config 与 shadcn，并修正 seed 引号"
```

---

### Task 19：文档口径统一

**Files：**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `storefront/README.md`
- Modify: `merchant-admin/README.md`
- Modify: `platform-admin/README.md`
- Modify: `api/README.md`

- [ ] **Step 1：实测测试条数与文件数**

```bash
cd api
npx jest --runInBand 2>&1 | tail -20        # 取 Tests / Test Suites
npx jest --config test/jest-e2e.json --runInBand 2>&1 | tail -20
cd ../storefront && npm test 2>&1 | tail -8
cd ../merchant-admin && npm test 2>&1 | tail -8
cd ../platform-admin && npm test 2>&1 | tail -8

# 文件数
find api/src -name '*.spec.ts' | wc -l
find api/test -name '*.e2e-spec.ts' | wc -l
find storefront/test merchant-admin/test platform-admin/test -name '*.test.ts*' | wc -l
```

> ⚠️ 数字必须是**本次执行末**的实测值；不要沿用阶段 8 的 927/663/223/421/465。

- [ ] **Step 2：更新根 README**

1）第 5 行进度改为：

```markdown
**当前进度：阶段 9「历史技术债清理」已完成并验收通过。**
```

2）在“后续计划”表加一行：

```markdown
| 计划 9 | 安全与部署、运维与 CI、资金并发护栏、前端与文档清理 —— **已完成并验收通过** |
```

3）标题 `### 阶段 7 之后的剩余技术债` 改为 `### 阶段 8 之后的剩余技术债`，并删除已闭环条目（e2e 进 CI、Node/npm 漂移），保留仍未做的产品决策类。

4）备份段落已在 Task 7 更新；确认含 Redis 与 `restore.sh`。

5）推送脚本段落补 curl 版（仓库里已有 `tools/push-via-api-curl.mjs`，不要新建）：

```markdown
中文分支名会让 `gh api` 的参数编码出错（422 / 打印字节数组），此时改用 curl 版：

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api-curl.mjs <本地分支> <远端分支>
```
```

6）测试数字更新为 Step 1 的实测值。

- [ ] **Step 3：更新 AGENTS.md**

1）阶段口径：

```markdown
  最近一次已完成的是 **阶段 9「历史技术债清理」**（2026-11-04）。
```

2）lint 纪律改为：

```markdown
- **api lint 已归零**（阶段 8c），但全量 lint 仍耗时；日常只对改动文件跑
  `npx eslint <file>`，要求零错误。CI 的 api job 跑全量 lint 作为门禁。
- **三个前端 lint 已进 CI**（阶段 9），本地提交前建议跑 `npm run lint`。
```

3）测试数字与 README 一致。

- [ ] **Step 4：更新三个子 README**

各自的“测试”段落改为本次实测条数与文件数；`api/README.md` 的脚本表补：

```markdown
npm run db:fix-legacy-checksum   # 迁移 checksum 修正（仅报 modified 时）
npm run backfill:ledger          # 历史流水回填（已出款周期默认拒绝，--force 跳过）
npm run payout:retry-pre-payout  # 批量重试确定未打款的失败出款单
```

- [ ] **Step 5：验证文档链接**

```bash
cd /Users/tom/orca/projects/电商项目
for f in docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md \
         docs/superpowers/plans/2026-11-04-plan-09-tech-debt-cleanup.md \
         docs/superpowers/plans/2026-11-04-tech-debt-inventory.md; do
  test -e "$f" || { echo "missing: $f"; exit 1; }
done
echo links-ok
```

- [ ] **Step 6：提交**

```bash
git add README.md AGENTS.md storefront/README.md merchant-admin/README.md platform-admin/README.md api/README.md
git commit -m "docs: 同步阶段 9 进度、测试条数与剩余技术债口径"
```

---

## 五、收尾

### Task 20：全量回归与验收记录

**Files：**
- Create: `docs/superpowers/plans/2026-11-04-plan-09-acceptance.md`

- [ ] **Step 1：api 全量单测**

```bash
cd api && npx tsc --noEmit && npm run lint && npx jest --runInBand
```

预期：0 失败；记录 Tests / Suites 数字。

- [ ] **Step 2：api 全量 e2e（本地）**

```bash
cd api && npm run test:e2e
```

预期：0 失败。若本机 MinIO 未起，media 套件失败属预期，记录并说明。

- [ ] **Step 3：三端全量**

```bash
for d in storefront merchant-admin platform-admin packages/frontend-shared; do
  (cd "$d" && npx tsc --noEmit) || exit 1
done
for d in storefront merchant-admin platform-admin; do
  (cd "$d" && npm test && npm run lint) || exit 1
done
```

- [ ] **Step 4：compose 与脚本冒烟**

```bash
cd infra && docker compose config >/dev/null
bash -n backup.sh && bash -n restore.sh
```

- [ ] **Step 5：写验收记录**

`docs/superpowers/plans/2026-11-04-plan-09-acceptance.md` 至少包含：

```markdown
# 阶段 9 验收记录

> 日期：2026-11-04
> 设计：docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md

## 一、完成范围
（逐条列出 A1–A5、B1–B3、C1–C7、D1–D5）

## 二、验证结果
- api 单测：<实测> 条 / <实测> 套件
- api e2e：<实测> 条 / <实测> 套件
- storefront / merchant-admin / platform-admin：<实测>
- 三端 tsc / lint / build：<结果>
- CI：<run id> 的 api/frontend(3)/shared/e2e 全绿
- 备份脚本：正例 + 缺卷 + 坏 tar 的退出码
- 恢复脚本：数据库/MinIO/Redis 各跑一次（或写明未跑原因）

## 三、已知限制
- 跨副本分布式锁仍未做（阶段 9 范围外）
- `unconfirm` 仍存在「回查后、提交前」的纳秒级窗口，`approve` 侧回查为第二道防线
- CSV 导出仍受 100 条上限限制
- 平台端不展示解密根因（按设计保持日志内）
```

- [ ] **Step 6：提交**

```bash
git add docs/superpowers/plans/2026-11-04-plan-09-acceptance.md
git commit -m "docs: 记录阶段 9 验收结果与已知限制"
```

---

### Task 21：推送与 CI 确认

- [ ] **Step 1：确认工作区干净**

```bash
cd /Users/tom/orca/projects/电商项目 && git status --short
```

预期：无输出。

- [ ] **Step 2：用 API 脚本推送（不要用 `git push`）**

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api.mjs main main
```

预期：脚本输出新的 commit sha，且远端 ref 更新。若报 TLS 抖动，重试（脚本已内置请求级重试）。

- [ ] **Step 3：确认 CI 六个 job**

```bash
gh run list --limit 3
gh run watch <run-id>
```

预期：`api`、`frontend (storefront)`、`frontend (merchant-admin)`、`frontend (platform-admin)`、`shared`、`e2e` 全部成功。

- [ ] **Step 4：更新自动记忆**

在 `~/.claude/projects/-Users-tom-orca-projects-----/memory/` 新增 `project_plan09_execution.md`，并在 `MEMORY.md` 加一行索引。内容只记**非显而易见**的坑（例如 CI e2e 的 pg_trgm 步骤、`export` 路由必须排在 `:id` 之前、生产守卫对本机 compose 的影响），不要复制代码或测试数字。

---

## 六、验收标准（汇总）

- **A**：`api` 单测 + tsc + lint 通过；三端 tsc/测试通过；`docker compose config` 通过且端口默认回环。
- **B**：备份脚本正反用例退出码正确；`restore.sh` 无 `--yes` 不动数据；CI 原五 job + 新 e2e job 全绿。
- **C**：回填闸单测通过；批量重试脚本 tsc 通过；`token-grace` 与 `auth` 新单测通过；`settlement` 单测 + 定向 e2e 通过；CSV 单测与前端路由测试通过。
- **D**：会话判空 codemod 后 70 处全部替换、两端各补 2 条测试；四个 loading 页构建通过；依赖删除后 lock 可 `npm ci`；README/AGENTS/子 README 数字与实测一致。
- **收尾**：api 全量单测 + 本地全量 e2e + 三端全量 + compose 冒烟；验收记录落盘；API 推送后 CI 六 job 全绿。

---

## 七、自查（写完计划后执行）

- [x] 设计 §2–§5 的每一项都能在本计划找到对应 Task：A1→T1/T2/T3、A2→T3、A3→T4/T8、A4→T6、A5→T5；B1→T7、B2→T8、B3→T8；C1→T9、C2→T10、C3→T11、C4→T12、C5→T13、C6→T14、C7→T15；D1→T16、D2→T17、D3→T18、D4→T19、D5→T3。
- [x] 没有 TBD / TODO / “类似 Task N” 的占位。
- [x] 类型与命名跨任务一致：`guardBackfill` / `ActivePayoutsError` / `TokenCleanupResult` / `escapeCsvCell` / `toCsv` / `assertAuthSecret`。
- [x] 明确不做的项未混入任务：分布式锁、产品决策类、Playwright、TLS、`commission_entries` 外键、Prisma 索引漂移、恢复 `migrate dev`。
