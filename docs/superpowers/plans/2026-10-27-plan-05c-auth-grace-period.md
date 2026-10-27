# 计划 5c：刷新令牌宽限期（RFC 9700）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一枚刚被轮换的刷新令牌，在 60 秒宽限期内再次被提交时返回**同一枚**新令牌，不再把它判成「真正的重放」而吊销该用户全部设备的登录。

**Architecture:** 后端给 `refresh_tokens` 表加两列（轮换出的新令牌**密文** + 宽限截止时刻），在 `AuthService.refresh()` 里把「并发竞态」与「先后竞态」合并成**一个**宽限期分支——宽限期内一律返回同一枚令牌，超期才吊销全族。密文用 AES-256-GCM，密钥由 HKDF 从 `JWT_SECRET` 派生（不新增必须配置的环境变量）。前端配套把 `auth.ts` 里「要不要刷新 / 刷新失败怎么办」的决策逻辑抽成纯模块并补单元测试——护栏 3 / 5 从此有了自动化覆盖。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 | BullMQ（宽限密文的定时清理）| Node `crypto`（HKDF + AES-256-GCM）| Next.js 15 + Vitest（前端单测）| Jest/Supertest（后端 e2e）

**对应设计文档:** `docs/superpowers/specs/2026-10-27-plan-05c-auth-grace-period-design.md` 全文。**本计划是该文档的可执行展开**，两者冲突时以设计文档为准。

---

## 零、全局约定

### 0.1 沿用既有约定（不要重新发明）

| 约定 | 位置 | 说明 |
|------|------|------|
| **租户隔离靠 `TenantPrismaService` 的 Prisma 扩展** | `api/src/common/tenant/` | ⚠️ **`RefreshToken` 刻意不在 `TENANT_SCOPED_MODELS` 里**（它按 `userId` 索引、跨租户），所以 `this.prisma.refreshToken.findFirst/updateMany` **不带** tenantId 条件，这是**对的**，不要给它加 |
| **`TenantPrismaService` 是包装模式，每个模型一个 getter** | 同上 | 用 `this.prisma.refreshToken`，不要 `as any` 绕过 |
| **`$transaction` 透传，回调里的 `tx` 是扩展 client** | 同上第 599 行 | 用 `PrismaTransaction` 类型（`api/src/common/prisma/prisma-transaction.ts`）。⚠️ **`$queryRaw` / `$executeRaw` 刻意没有暴露** —— 原生 SQL 不经过租户扩展，放开就是绕过隔离的后门 |
| **数据库时钟用 `databaseNow()`** | 同上第 627 行 | 那是**唯一**的原生 SQL 入口，只查 `now()`。要用数据库时间就调它，不要自己写 `$queryRaw` |
| **列名是 camelCase** | `api/prisma/schema.prisma` | `refresh_tokens` 只有**表名**被 `@@map` 成小写下划线，**列名保持原样**（`tokenHash` / `expiresAt` / `revokedAt`）。⚠️ 别写成 `token_hash` |
| **条件更新判并发赢家** | 全局 | `updateMany` 的 where 带状态，靠**受影响行数**判赢家，不用「先查后改」 |
| **时间判定用应用时钟**（本阶段例外见 §0.4） | `auth.service.ts` | 现有的 `revokedAt` / `expiresAt` / `isConcurrentRace` 都是应用时钟写的，宽限期沿用 |
| **代码注释用简体中文**，大量用「⚠️」标注重要约束、块注释解释「为什么」 | 全局 | 本项目既有风格 |
| **`prisma migrate reset` 禁用** | 全局 | 阶段 2 已经因此踩过坑。迁移漂移时用定向 SQL / `migrate diff` 兜底 |
| **前端断言要具体** | 全部 | 「只断言 200」「只断言报错」都算恒真 |
| **`storefront` 与 `merchant-admin` 的 vitest 都只收 `test/**/*.test.ts`** | 各自的 `vitest.config.ts` | 本阶段的纯函数测试是 `.ts`，**不需要** jsdom |
| **两个前端的同名 lib 文件是「逐行一致」的副本** | `token-refresh.ts` / `token-expiry.ts` | 改一份就要改另一份。判据：`diff` 两个文件无输出 |
| **`prisma migrate deploy` 而不是 `migrate dev`** | api | ⚠️ **本项目里 `migrate dev` 实际跑不通**（Task 1 实测）：它检测到「数据库不是同步状态」（历史上有 3 个迁移文件在应用后被改过，校验和与 `_prisma_migrations` 不一致）就弹「需要重置 public schema」的交互式提问，**并在生成文件之前就中止**。加列要用 `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script --shadow-database-url <影子库>` 生成 SQL 再**手工裁剪** |
| **写完代码跑 `npx eslint --fix`** | api / 两个前端 | ⚠️ eslint 把 `prettier/prettier` 设为 error 级规则，**排版不合规就是 lint 失败**。本计划的参考代码里有几行超 80 列（已在本文件里修好，但后续照抄仍可能带进来）——写完先 `--fix` 再验证 |

### 0.2 本阶段的 11 项护栏

**编号即验收（Task 6）的核对清单**。G1–G8 是后端的，G9–G11 是前端的。

| 护栏 | 内容 | 在哪测 |
|------|------|--------|
| **G1** | **宽限期内重用已轮换的旧令牌 → 200，且拿到的是**同一枚**新令牌** | Task 2（e2e） |
| **G2** | **超出宽限期重用旧令牌 → 401，且连带作废整个令牌族** | Task 2（e2e） |
| **G3** | **宽限期内重用旧令牌不牵连其它设备** | Task 2（e2e） |
| **G4** | **宽限期不因重放而延长**（`graceExpiresAt` 不被推后） | Task 2（e2e，查库） |
| **G5** | **宽限密文解不开时不得返回空令牌** —— 走超期分支（401 + 吊销全族） | Task 2（e2e） |
| **G6** | **并发重用同一枚令牌：两个都成功，且拿到同一枚令牌，全族不被吊销** | Task 2（e2e） |
| **G7** | **过期的宽限密文被清理任务抹掉，没过期的保留** | Task 3（e2e） |
| **G8** | **链式自愈**：回退到已轮换的令牌后，能再换回下一枚 | Task 2（e2e，4 步） |
| **G9** | **accessToken 过期时刷新**（阶段 4 的护栏 3） | Task 4（前端单测） |
| **G10** | **送不回去 cookie 时不刷新**（阶段 4 护栏 3 的另一半，`8545635` 的核心） | Task 4（前端单测） |
| **G11** | **刷新失败：`invalid` → 作废会话；`network` → 保留旧令牌**（阶段 4 的护栏 5） | Task 4（前端单测） |

### 0.3 本阶段**不做**的事

| 不做 | 为什么 |
|------|------|
| 前端「送不回刷新结果」的根治 | 阶段 4 的 `8545635` 已缓解（只在 cookie 送得回去的地方刷新）。宽限期是**互补**的另一半 |
| 多设备 / 多浏览器共享会话 | 各设备本就独立登录、各持独立令牌 |
| 跨副本的分布式刷新锁 | 前端 `inFlightRefreshes` 仍是单进程内有效。宽限期让跨副本的**后果**变轻，但没有消除重复请求 |
| `maxStores` 的约束点 | 依赖尚不存在的「新增店铺」接口 |
| 阶段 4 的其余前端技术债 | 属于阶段 5d |
| 计费遗留项 | 属于阶段 5d |

### 0.4 一处**有意的**时钟例外

**判定令牌是否在宽限期内（秒级、决定放行与否）一律用应用时钟** ——
与同文件里现有的 `revokedAt` / `expiresAt` 一致。

**清理任务用数据库时钟** —— 它是批量扫描，判定精度是「小时级」，
几百毫秒的时钟偏差无影响；而用数据库的 `now()` 可以一条 UPDATE 搞定。

两者职责不同、不混用。实现上清理任务调 `databaseNow()` 拿时间戳，
**不要**写 `$queryRaw`（那个入口被刻意封了）。

### 0.5 勘误表

> 实施过程中每偏离本计划一处，就在这里加一行，并**同时改计划正文**。
> 文档与业务代码分开提交。

| # | 位置 | 计划原本说 | 实际改成 | 为什么 |
|---|------|-----------|---------|--------|
| 1 | §0.1 约定表 + Task 1 的参考代码 | `npx prisma migrate dev --name add_refresh_token_grace` | 改用 `prisma migrate diff` 生成 SQL 后手工裁剪 | 该命令在本项目检测到「数据库不是同步状态」（3 个历史迁移文件的校验和与 `_prisma_migrations` 不一致），会弹「需要重置 public schema」并在生成文件前中止。项目明令禁用 `migrate reset` |
| 2 | Task 1 的参考代码 + 全部 Task 的代码块 | 直接照抄参考代码 | 写完先跑 `npx eslint --fix` | 计划里 9 行代码超 80 列，`prettier/prettier` 是 error 级规则 → `npm run lint` 会红。Task 1 实施时因此产生 4 个 lint error（已用 `style(api): 修正宽限期加解密代码的格式` 修掉），本文件里的参考代码已同步改成 prettier 合规的形态 |
| 3 | Task 2 的 Step 4d / 4f + 设计文档 §4.3 / §5.5 | `handleRevokedToken` 只有三档；`revokeTokenFamily` 的 where 是 `{ userId, revokedAt: null }` | 新增**第四档**「目标令牌已被明确吊销 → 401，不吊销全族」；`revokeTokenFamily` 的 where 加 `OR: [{ revokedReason: ROTATED }]` | Task 2 的代码质量审查查出**两个真漏洞**（设计文档 §5.6）：① **登出后重放前身令牌能换回一枚有效的 accessToken** —— 登出的意图被撤销；② 全族吊销够不到已 ROTATED 的行 → 重放族内已轮换的令牌能换回一枚（已被吊销的）令牌，「吊销全族」名不副实。**这两条是 Task 2 引入的** —— 改造前 ROTATED 行上没有可兑换的秘密 |
| 4 | Task 2 的 Step 1 / Step 2 | 计划只列了「改 1 组 + 新增 1 组」 | 另改**两条计划未列出的既有 e2e 用例** | ① `'刷新令牌可换取新令牌，旧令牌随即失效'` 的「旧令牌立即 401」断言在新语义下必然失败（60 秒内是 200）—— 删掉那条断言，保留「轮换确实换到了新令牌」的核心断言；② `'并发刷新 › 同一枚令牌并发刷新两次只有一次成功'` 的 `[200, 401]` 断言按设计文档 §5.5 与决策 D3 改为 `[200, 200]` + 两个拿到同一枚。**「超出宽限期后旧令牌失效」仍有覆盖**（Step 1 的第二条用例，且比原来更强：还断言了族被吊销） |
| 5 | 「Task 2 的补充」· 修补 7 | 用 `graceExpiresAt - createdAt` 断言宽限期长度 | 改用 `graceExpiresAt - revokedAt` | `createdAt` 是**建行**时刻（登录时），`graceExpiresAt` 是**轮换**时刻 + 60 秒 —— 中间隔着「登录→刷新」的耗时。实测（故意 sleep 1.5 秒）差值是 61515 而不是 60000，**照抄必然失败**。`revokedAt` 与 `graceExpiresAt` 在同一次原子 `updateMany` 里写入，同取轮换时刻，差值恒为 60000 |
| 6 | 「Task 2 的补充」· 修补 8 的「洞一」用例 | 只轮换一次（T0→T1） | 补第二次轮换（T0→T1→T2） | 计划给的代码与它自己的注释不一致（注释说「T1 也有自己的宽限记录指向 T2」，但代码只轮换了一次，根本没有 T2）。**只轮换一次的话 T1 是族里最新的令牌、`revokedAt` 为空**，落不到修补 2 的 ROTATED 分支上 |
| 7 | 「Task 2 的补充」· 修补 8 的「洞二」用例 | 只建一台设备，断言 401 与无 accessToken | 补上**第二台设备**并断言它仍能刷新 | 标题声称「不牵连其它设备」但断言里没有这一条。**「拒绝时牵连其它设备」这个行为没有锁点** —— 将来有人把拒绝分支改成调 `revokeTokenFamily`，不会有任何测试挂。失败注入实测：期望挂 1 条，实得挂 1 条 ✓ |
| 8 | 「Task 2 的补充」· 修补 7 | 断言 `graceExpiresAt - revokedAt === REFRESH_GRACE_PERIOD_MS` **精确相等** | 生产代码改成**同一次轮换只取一次时钟**（事务内 `const rotateNow = new Date()`，两处复用） | ⚠️ 原来的 `data` 里 `revokedAt` 与 `graceExpiresAt` **各自调了一次 `new Date()`** —— 两次读之间跨过毫秒边界，差值就是 60001 而不是 60000。**实测失败率约 10%**（20 轮挂 2 轮）。`revokeTokenFamily` 里本来就是 `const now = new Date()` 复用的写法，轮换路径是对齐它。改后连跑 10 轮 0 失败 |
| 9 | 「Task 2 的补充」· 修补 8 的「洞一」用例 | 只断言 HTTP 状态码 | 补一条**直接查库**的断言（`revokedReason === REPLAY` 且 `rotatedToToken === null`） | 只断言状态码的话，**删掉修补 2 的 OR 分支不会有任何测试挂**（响应层已被修补 1 独立挡住）—— 修补 2 处于**零测试覆盖**状态，是「吊销全族」语义正确性的唯一保证却最容易被静默删掉。补断言后：删掉 OR 分支 → 期望挂 1 条，实得挂 1 条 ✓ |
| 10 | 「Task 2 的补充」· 修补 5 | `toAuthUser` 用内联结构类型 | 三个方法的参数类型统一用已导出的 `AuthUser` | 同一份内联结构在文件里出现了三遍。`AuthUser` 的 `role: UserRole` 与 Prisma 的 `User.role` 完全兼容，`tsc --noEmit` 通过 |
| 11 | Task 4 的 Step 5 / Step 7 | 「10 条全过」「191 + 10 = 201」「175 + 10 = 185」 | 「**9 条**全过」「191 + 9 = 200」「175 + 9 = 184」 | **计划自身的笔误** —— 计划给出的参考测试文件里**只有 9 个 `it`**（4 + 2 + 3），「10」只出现在散文步骤说明里。实测基线：merchant-admin 191 → 200、storefront 175 → 184 |
| 12 | Task 3（审查发现，**非本阶段引入**） | —— | 记为**已知遗留项** | 审查实测：**Redis 不可达时 `app.init()` 既不 resolve 也不 reject**，应用静默挂死（30 秒超时仍在阻塞）。对照实验证明 `RenewalService.onModuleInit` 与 `TokenGraceService.onModuleInit` **各摘一个都仍然阻塞**，两个都摘才 110ms 启动成功 —— 说明这是**既有缺陷**（`queue.module.ts` 的 `maxRetriesPerRequest: null` + ioredis 无限重试），不是 Task 3 引入的。K8s 里表现为 Pod 永远 `Running` 但不 Ready |
| 13 | 「Task 2 的补充」· 修补 1 | 目标令牌的查询只按 `tokenHash` | 查询的 where **显式带上 `userId`** | `RefreshToken` 不在 `TENANT_SCOPED_MODELS` 里 → 这是**全局无过滤查询**。当前安全（密文只由服务端写、`tokenHash` 全局唯一），但**完全依赖隐式不变量** —— 加一道显式约束当防御纵深，把安全从「依赖隐式不变量」变成「查询本身带条件」。**不改变任何行为**（`userId` 条件在正常路径下恒真） |

> ⚠️ **收尾时补记**：上表 #1、#3、#4、#10、#12 这 5 条**当时只记了原因，没改到正文**，
> 与 §0.5 的约定（「实施过程中每偏离本计划一处，就在这里加一行，**并同时改计划正文**」）
> 不符。最终审查逐条核对后发现，**照着正文做 Task 2 会实现出那两个已被判定为真漏洞的版本**。
> 现已补改正文：
> - **#1** → Task 1 的 Step 6 **直接改成** `prisma migrate diff` 的写法
>   （「照做就会卡住」的问题，必须直接改）；
> - **#3** → Task 2 的 Step 4d / 4f **加了显式指引**，指明参考代码已被取代、
>   正确实现见「Task 2 的补充：审查后修补」；
> - **#4** → Task 2 的 Step 1 / Step 2 **补上了**那两条要改的既有用例；
> - **#10** → 「Task 2 的补充」· 修补 5 **直接改成**用 `AuthUser`；
> - **#12** → Task 3 的**开头**补上了这条遗留项的说明。

### 0.6 目录

```
api/src/modules/auth/
├─ auth.service.ts            # refresh 的宽限期判定（本阶段主要改动）
├─ auth.module.ts             # 装配 TokenGraceService / TokenGraceWorker
├─ token.util.ts              # 加解密纯函数 + 宽限期常量（本阶段新增内容）
├─ token.util.spec.ts         # 加解密的单元测试（**新增**）
├─ token-grace.service.ts     # 宽限密文的清理（**新增**）
└─ token-grace.worker.ts      # 清理任务的消费端（**新增**）

api/src/common/queue/
├─ queue.constants.ts         # 加 AUTH_QUEUE
├─ queue.module.ts            # 注册新队列
└─ queue.service.ts           # QueueName 联合类型加一项 + 构造函数注入

api/test/
├─ auth.e2e-spec.ts           # 改 1 组 + 新增 1 组
└─ token-grace.e2e-spec.ts    # 清理任务的 e2e（**新增**）

storefront/src/lib/jwt-callback.ts        # 决策逻辑（**新增**，与 merchant-admin 逐行一致）
storefront/src/auth.ts                    # 改为引用 jwt-callback
storefront/test/lib/jwt-callback.test.ts  # （**新增**）
merchant-admin/src/lib/jwt-callback.ts        # 同上
merchant-admin/src/auth.ts                    # 同上
merchant-admin/test/lib/jwt-callback.test.ts  # 同上
```

### 0.7 端口与基础设施

| 服务 | 宿主机 | 容器内 | 状态 |
|------|--------|--------|------|
| PostgreSQL | 15432 | 5432 | 已在跑 |
| MinIO | 19000 | 9000 | 已在跑 |
| Redis | 16380 | 6379 | 已在跑 |
| api | 3000 | 3000 | 已在跑 |
| storefront | 3011 | 3001 | dev 用 3011 |
| merchant-admin | 3016 | 3002 | dev 用 3016 |
| platform-admin | 3017 | 3003 | dev 用 3017 |

---

## Task 1：数据模型与加解密纯函数

**Files:**
- Modify: `api/prisma/schema.prisma`（`RefreshToken` 加两列）
- Create: `api/prisma/migrations/20261027XXXXXX_add_refresh_token_grace/migration.sql`（用 `prisma migrate diff` 生成 SQL 后手工裁剪，见 Step 6）
- Modify: `api/src/modules/auth/token.util.ts`（加三个导出 + 一个常量）
- Create: `api/src/modules/auth/token.util.spec.ts`

- [ ] **Step 1：写加解密的单元测试**

创建 `api/src/modules/auth/token.util.spec.ts`：

```ts
import {
  decryptToken,
  deriveGraceKey,
  encryptToken,
  REFRESH_GRACE_PERIOD_MS,
} from './token.util';

/**
 * 宽限记录里那枚新令牌的加解密（阶段 5c）。
 *
 * ⚠️ **这里测的是「密文在库里不泄露明文」这件事** ——
 * `token.util.ts` 里既有的原则是「数据库里只存 sha256 摘要而不是明文……
 * RefreshToken 表经常被备份与只读分析」。宽限期要返回**同一枚**令牌，
 * 就必须能把明文还原出来——本阶段用密文而不是明文来满足这个要求。
 */
describe('宽限记录的加解密', () => {
  const secret = 'a-test-secret-that-is-long-enough-for-hkdf';
  const key = deriveGraceKey(secret);

  it('加解密往返得到同一个明文', () => {
    const plain = 'the-refresh-token-value';
    expect(decryptToken(encryptToken(plain, key), key)).toBe(plain);
  });

  it('密文里不出现明文', () => {
    const plain = 'the-refresh-token-value';
    const cipher = encryptToken(plain, key);
    expect(cipher).not.toContain(plain);
    expect(Buffer.from(cipher, 'base64url').toString('utf8')).not.toContain(
      plain,
    );
  });

  it('每次加密的密文不同（随机 iv）', () => {
    const plain = 'same-plain';
    expect(encryptToken(plain, key)).not.toBe(encryptToken(plain, key));
  });

  it('用另一个密钥解密失败', () => {
    const cipher = encryptToken('x', key);
    const other = deriveGraceKey('another-secret-long-enough-for-hkdf');
    expect(decryptToken(cipher, other)).toBeNull();
  });

  it('密文被篡改时解密失败（认证标签）', () => {
    const cipher = encryptToken('x', key);
    const raw = Buffer.from(cipher, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    expect(decryptToken(raw.toString('base64url'), key)).toBeNull();
  });

  it('密文格式损坏时返回 null 而不是抛错', () => {
    expect(decryptToken('not-a-valid-cipher', key)).toBeNull();
    expect(decryptToken('', key)).toBeNull();
  });

  it('派生出的密钥是 32 字节，且不同密钥派生结果不同', () => {
    expect(key).toHaveLength(32);
    expect(deriveGraceKey(secret).equals(key)).toBe(true);
    expect(
      deriveGraceKey('another-secret-long-enough-for-hkdf').equals(key),
    ).toBe(false);
  });

  it('宽限期是 60 秒', () => {
    expect(REFRESH_GRACE_PERIOD_MS).toBe(60_000);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
cd api && npx jest src/modules/auth/token.util.spec.ts
```

预期：FAIL，报 `Cannot find module './token.util'` 导出的成员不存在（TS2305）或
`deriveGraceKey is not a function`。

- [ ] **Step 3：实现加解密**

修改 `api/src/modules/auth/token.util.ts`。**保留原有的 `generateRefreshToken` 与
`hashRefreshToken` 一字不动**，在文件末尾追加：

```ts
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
```

（把文件顶部原有的 `import { createHash, randomBytes } from 'node:crypto';`
替换成上面这个合并后的 import。）

并在文件末尾追加：

```ts
/**
 * 刷新令牌的宽限期（毫秒）—— 60 秒。
 *
 * ⚠️ **导出**：e2e 要用它算「宽限截止时刻」，测试与服务端共用同一个常量，
 * 不会出现「测试里写死 60 秒、代码里改成 30 秒」这种漂移。
 *
 * ⚠️ **为什么是 60 秒**：要覆盖客户端超时（10–30 秒）+ 重试退避；
 * 同时对「令牌泄漏」的封窗仍然很短（从永久缩到 60 秒）。
 * ⚠️ **不因重放而延长** —— 延长等于给泄漏的令牌开更大的口子。
 */
export const REFRESH_GRACE_PERIOD_MS = 60_000;

/** 宽限记录用的加密密钥长度（AES-256 要 32 字节） */
const GRACE_KEY_BYTES = 32;

/** 加密 nonce 的长度（GCM 推荐 12 字节） */
const GRACE_IV_BYTES = 12;

/** GCM 认证标签的长度 */
const GRACE_TAG_BYTES = 16;

/** HKDF 的 salt：与 info 一起把密钥的用途区分开 */
const GRACE_HKDF_SALT = 'multi-tenant-ecommerce-saas';

/** HKDF 的 info：标识这把密钥的用途，换用途就要换 info */
const GRACE_HKDF_INFO = 'refresh-token-grace-v1';

/**
 * 从 `JWT_SECRET` 派生宽限记录用的加密密钥。
 *
 * ⚠️ **为什么派生而不是新增一个环境变量**：
 * - 不给部署增加「必须配置、漏了就启动失败」的东西（那会 breaking）
 * - `JWT_SECRET` 已经被 `assertSecureConfig()` 强制校验（≥ 32 字符、
 *   生产环境禁用占位符），派生密钥自动继承这份保护
 * - **职责分离**：派生出的密钥与 JWT 签名密钥用途不同，
 *   即使同源，密文也不能冒充 JWT
 *
 * ⚠️ **派生密钥只存在于进程内存**，不落盘、不进日志。
 *
 * ⚠️ **代价**：`JWT_SECRET` 轮换后旧的宽限密文解不开 → 那些令牌走超期分支
 * → 吊销全族。但换 `JWT_SECRET` 本来就会让所有 JWT 失效、所有人重新登录，
 * 所以这个连带影响**不新增任何实际损失**。
 */
export function deriveGraceKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(GRACE_HKDF_SALT, 'utf8'),
      Buffer.from(GRACE_HKDF_INFO, 'utf8'),
      GRACE_KEY_BYTES,
    ),
  );
}

/**
 * 加密一枚令牌，返回可落库的密文。
 *
 * 格式：`base64url( iv(12) || authTag(16) || ciphertext )`
 *
 * ⚠️ **用 AES-256-GCM**（带认证标签）：密文被篡改时解密会失败，
 * 而不是悄悄解出一段垃圾。
 * ⚠️ **每次用随机 iv** —— 同一个明文加密两次的密文必须不同，
 * 否则「密文相同 ⇒ 明文相同」就成了可用的判据。
 */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(GRACE_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64url',
  );
}

/**
 * 解密一枚宽限记录里的令牌。
 *
 * ⚠️ **解密失败一律返回 `null`，绝不抛错**：调用方要把它当成
 * 「宽限期不可用」→ 走超期分支（吊销全族 + 401），
 * **不能**把 `null` 当成令牌返回给客户端。
 *
 * 失败覆盖三种情况：密钥被换、密文被改、密文格式损坏。
 */
export function decryptToken(payload: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(payload, 'base64url');
    if (raw.length < GRACE_IV_BYTES + GRACE_TAG_BYTES) return null;
    const iv = raw.subarray(0, GRACE_IV_BYTES);
    const tag = raw.subarray(
      GRACE_IV_BYTES,
      GRACE_IV_BYTES + GRACE_TAG_BYTES,
    );
    const ciphertext = raw.subarray(GRACE_IV_BYTES + GRACE_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
cd api && npx jest src/modules/auth/token.util.spec.ts
```

预期：PASS，8 条全过。

- [ ] **Step 5：给 schema 加两列**

修改 `api/prisma/schema.prisma` 的 `RefreshToken` 模型。**只加两列，别动别的**：

```prisma
model RefreshToken {
  id            String                     @id @default(uuid())
  userId        String
  // ROTATED：刷新时轮换掉旧令牌
  // LOGOUT：用户主动登出
  // REPLAY：疑似泄露，令牌族整体作废
  // 重放检测只对 ROTATED 触发——登出后的令牌被再次使用不牵连其它设备。
  revokedReason RefreshTokenRevokedReason?
  tokenHash     String                     @unique
  expiresAt     DateTime
  revokedAt     DateTime?
  // ⚠️ 阶段 5c：宽限期记录。
  //
  // rotatedToToken 存的是本枚令牌轮换出的**新令牌的密文**（AES-256-GCM），
  // 不是明文 —— 沿用 token.util.ts 里「不存明文」的原则
  // （这张表经常被备份与只读分析）。
  // graceExpiresAt 是宽限截止时刻，轮换时一次定死，不因重放而延长。
  rotatedToToken String?
  graceExpiresAt DateTime?
  createdAt     DateTime                   @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("refresh_tokens")
}
```

⚠️ **列名是 camelCase**（`rotatedToToken` / `graceExpiresAt`）。这张表只有
**表名**被 `@@map` 成小写下划线，列名保持 Prisma 的原样。

⚠️ **不要**给这两列加索引 —— 查询只按 `tokenHash`（已有唯一索引）走，
没有按 `graceExpiresAt` 查询的场景。

- [ ] **Step 6：生成并应用迁移**

⚠️ **本项目里 `prisma migrate dev` 跑不通**（勘误表 #1）——
它检测到「数据库不是同步状态」（历史上有 3 个迁移文件在应用后被改过，
校验和与 `_prisma_migrations` 不一致）就弹「需要重置 public schema」的交互式提问，
**并在生成文件之前就中止**。项目明令禁用 `migrate reset`，所以**不要**走这条路。

**改用 `prisma migrate diff` 生成 SQL，再手工裁剪**：

```bash
cd api && npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script \
  --shadow-database-url <影子库>
```

把输出的 SQL 裁剪成**只有两条 `ALTER TABLE ... ADD COLUMN`**，写成
`api/prisma/migrations/20261027XXXXXX_add_refresh_token_grace/migration.sql`。

⚠️ **`--shadow-database-url` 指向的影子库必须是一个空库** ——
影子库是用来让 Prisma 复现「从迁移历史到当前 schema」的差异的，
库里有别的东西会算出多余的 SQL。

生成迁移文件后手工检查它只有两条 `ALTER TABLE ... ADD COLUMN`，
然后：

```bash
cd api && npx prisma migrate deploy && npx prisma generate
```

⚠️ **`prisma generate` 必须跑** —— Prisma 的类型是从 schema 生成的，
不重新生成的话 `rotatedToToken` / `graceExpiresAt` 在 TypeScript 里不存在。

- [ ] **Step 7：验证迁移**

```bash
cd api && npx prisma migrate status
```

预期：Database schema is up to date。

- [ ] **Step 8：提交**

```bash
git add api/prisma/schema.prisma api/prisma/migrations api/src/modules/auth/token.util.ts api/src/modules/auth/token.util.spec.ts
git commit -m "feat(api): 刷新令牌宽限期的数据模型与加解密纯函数"
```

---

## Task 2：后端宽限期判定

**Files:**
- Modify: `api/src/modules/auth/auth.service.ts`
- Modify: `api/test/auth.e2e-spec.ts`

- [ ] **Step 1：先改现有的 e2e 组（语义已变）**

> ⚠️ **本步要改的是**「`describe('刷新令牌重放检测')` 里那条
> `'再次使用已轮换的旧令牌返回 401，并连带作废整个令牌族'`」。
> ⚠️ **但计划正文还漏了另外两条**（勘误表 #4）—— 实施时**也要改**：
> ① `'刷新令牌可换取新令牌，旧令牌随即失效'` 的「旧令牌立即 401」断言在新语义下
> **必然失败**（60 秒内是 200）—— 删掉那条断言，保留「轮换确实换到了新令牌」的核心断言；
> ② `'并发刷新 › 同一枚令牌并发刷新两次只有一次成功'` 的 `[200, 401]` 断言按设计文档 §5.5
> 与决策 D3 改为 `[200, 200]` + 两个拿到同一枚。
> **「超出宽限期后旧令牌失效」仍有覆盖**（Step 1 的第二条用例，且比原来更强：
> 还断言了族被吊销）。

打开 `api/test/auth.e2e-spec.ts`，找到 `describe('刷新令牌重放检测')`（约第 490 行）。

⚠️ **这一组用例共享一个账号且依赖执行顺序**（现有注释已说明，改造后仍然成立）——
现有的「再次使用已轮换的旧令牌返回 401」这条的**语义已经变了**：
宽限期内它应该返回 200。

把那条 `it('再次使用已轮换的旧令牌返回 401，并连带作废整个令牌族', ...)`
**替换成两条**：

```ts
    it('宽限期内再次使用已轮换的旧令牌，返回同一枚新令牌', async () => {
      // 阶段 5c 的宽限期：同一枚令牌在 60 秒内被重复提交时，
      // 返回**第一次那枚**新令牌，不吊销令牌族。
      // 这是「客户端超时后重试」不再把用户踢下线的关键。
      const refreshed = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original })
        .expect(200);

      // 关键断言：拿到的**就是**第一次那枚，不是新签的一枚。
      expect(body(refreshed).refreshToken).toBe(rotated);
    });

    it('超出宽限期后再次使用旧令牌返回 401，并连带作废整个令牌族', async () => {
      // 把这枚令牌的宽限截止时刻改成过去，模拟「已经过了 60 秒」。
      // ⚠️ 直接改库比冻时钟精确：只影响这一行，不影响别的用例。
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(original) },
        data: { graceExpiresAt: new Date(Date.now() - 1000) },
      });

      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original })
        .expect(401);

      // 关键断言：上一条作废了令牌族，因此轮换出来的那枚「合法」令牌
      // 也必须失效。没有这一步，系统只挡住旧令牌，攻击者仍可用
      // 已轮换的令牌无限续期。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated })
        .expect(401);
    });
```

⚠️ **需要在该文件顶部补两个 import**：

```ts
import {
  TenantPrismaService,
} from '../src/common/tenant/tenant-prisma.service';
import { hashRefreshToken } from '../src/modules/auth/token.util';
```

⚠️ **需要在该文件的 `describe` 里补一个 `prisma` 变量**。在
`describe('认证 (e2e)', () => {` 里，`let app: INestApplication;` 旁边加：

```ts
  let prisma: TenantPrismaService;
```

并在 `beforeAll` 里，`await app.init();` **之前**加：

```ts
    prisma = app.get(TenantPrismaService);
```

⚠️ **`hashRefreshToken` 是后端的函数，e2e 直接 import 源码是既有做法**
（`billing-report.e2e-spec.ts` 就 import 了 `src/common/tenant/tenant-context`）。

- [ ] **Step 2：新增一组独立用例**

> ⚠️ **本步新增的这一组之外，还要改**「`describe('并发刷新')` 里那条
> `'同一枚令牌并发刷新两次只有一次成功'`」—— 它的 `[200, 401]` 断言要按
> 设计文档 §5.5 与决策 D3 改为 `[200, 200]` + 两个拿到同一枚
> （勘误表 #4 的第 ② 条；详见 Step 1 开头的提示）。

在 `describe('认证 (e2e)', ...)` 里，`describe('刷新令牌重放检测')` **之后**插入：

```ts
  describe('刷新令牌宽限期（阶段 5c）', () => {
    /**
     * 造一个商家，返回它的两枚令牌。
     */
    async function loginMerchant(): Promise<{
      email: string;
      token: string;
    }> {
      const account = email();
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '宽限期商家',
          subdomain: subdomain(),
          storeName: '宽限期店铺',
        })
        .expect(201);
      const response = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);
      return { email: account, token: body(response).refreshToken };
    }

    it('宽限期内重用旧令牌不牵连其它设备（G3）', async () => {
      const account = email();
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '多设备商家',
          subdomain: subdomain(),
          storeName: '多设备店铺',
        })
        .expect(201);

      // 两台设备各登录一次，各有独立的令牌
      const deviceA = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);
      const deviceB = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);

      const tokenA = body(deviceA).refreshToken;
      const tokenB = body(deviceB).refreshToken;

      // 设备 A 的令牌被轮换
      const first = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA })
        .expect(200);
      const rotated = body(first).refreshToken;

      // 宽限期内重用 A 的旧令牌 → 200，且拿到同一枚
      const replay = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA })
        .expect(200);
      expect(body(replay).refreshToken).toBe(rotated);

      // 关键断言：设备 B 完全没参与，必须仍然能刷新。
      // 改造前这一条会挂 —— 重放会吊销该 userId 下的**全部**令牌。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenB })
        .expect(200);
    });

    it('宽限期不因重放而延长（G4）', async () => {
      const { token } = await loginMerchant();

      const first = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(200);

      const before = await prisma.refreshToken.findFirst({
        where: { tokenHash: hashRefreshToken(token) },
        select: { graceExpiresAt: true },
      });
      expect(before?.graceExpiresAt).not.toBeNull();

      // 在宽限期内再重放一次
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(200);

      const after = await prisma.refreshToken.findFirst({
        where: { tokenHash: hashRefreshToken(token) },
        select: { graceExpiresAt: true },
      });

      // 关键断言：宽限截止时刻**没有**被推后。
      // 延长等于给泄漏的令牌开更大的口子。
      expect(after?.graceExpiresAt?.getTime()).toBe(
        before?.graceExpiresAt?.getTime(),
      );
      expect(body(first).refreshToken).not.toBe(token);
    });

    it('宽限密文解不开时走超期分支，不返回空令牌（G5）', async () => {
      const { token } = await loginMerchant();

      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(200);

      // 把密文改成乱码（模拟密文被篡改 / 密钥被换）
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(token) },
        data: { rotatedToToken: 'this-is-not-a-valid-ciphertext' },
      });

      // 关键断言：401，**不是** 200 + 空的 refreshToken。
      // 响应体里绝不能出现 `refreshToken: null`。
      const response = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(401);

      expect(JSON.stringify(response.body)).not.toContain('refreshToken');
    });

    it('并发重用同一枚令牌：两个都成功且拿到同一枚（G6）', async () => {
      const { token } = await loginMerchant();

      const results = await Promise.all([
        http(app).post('/api/v1/auth/refresh').send({ refreshToken: token }),
        http(app).post('/api/v1/auth/refresh').send({ refreshToken: token }),
      ]);

      // ⚠️ 改造后两个都是 200 —— 宽限期统一处理「并发」与「先后」，
      // 判定不再依赖时序（这正是设计文档 §5.3 的实测结论）。
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200]);

      // 关键断言：两个拿到的是**同一枚**令牌。
      const tokens = results.map((r) => body(r).refreshToken);
      expect(tokens[0]).toBe(tokens[1]);
      expect(tokens[0]).not.toBe(token);

      // 关键断言：那枚令牌仍然可用（没有把整个令牌族误吊销）
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens[0] })
        .expect(200);
    });

    it('链式自愈：回退到已轮换的令牌后能再换回下一枚（G8）', async () => {
      const { token: t0 } = await loginMerchant();

      // ① 用 T0 刷新 → 得到 T1
      const r1 = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t0 })
        .expect(200);
      const t1 = body(r1).refreshToken;

      // ② 用 T1 刷新 → 得到 T2（T1 此时已作废）
      const r2 = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t1 })
        .expect(200);
      const t2 = body(r2).refreshToken;
      expect(t2).not.toBe(t1);

      // ③ 用 T0 刷新（仍在宽限期内）→ 拿到 T1 —— 一枚**已作废**的令牌
      const r3 = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t0 })
        .expect(200);
      expect(body(r3).refreshToken).toBe(t1);

      // ④ 用 ③ 拿到的 T1 再刷新 → 命中 T1 自己的宽限记录 → 拿回 T2
      // 这一步才是「链式自愈」的真正验证。
      const r4 = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t1 })
        .expect(200);
      expect(body(r4).refreshToken).toBe(t2);
    });
  });
```

- [ ] **Step 3：跑 e2e 确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns "auth.e2e-spec"
```

预期：多条 FAIL。
- 「宽限期内再次使用已轮换的旧令牌」期望 200，实际 401
- 「并发重用」期望 `[200, 200]`，实际 `[200, 401]`
- 其它新增用例也挂

⚠️ 若报「列 `graceExpiresAt` 不存在」，说明 Task 1 的 `prisma generate` 没跑或
迁移没应用 —— 回 Task 1 补做。

- [ ] **Step 4：改造 `auth.service.ts`**

修改 `api/src/modules/auth/auth.service.ts`。

**4a. 补 import**：

```ts
import {
  decryptToken,
  deriveGraceKey,
  encryptToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_GRACE_PERIOD_MS,
} from './token.util';
```

⚠️ **`Prisma` 这个名字已经在 import 列表里了**（第 7 行：
`import { Prisma, RefreshTokenRevokedReason, UserRole } from '@prisma/client';`），
所以 `Prisma.RefreshTokenGetPayload<...>` 直接可用，不用再 import。

**4b. 给类加一个密钥字段**。在 `export class AuthService {` 里，构造函数之前加：

```ts
  /**
   * 宽限记录用的加密密钥。
   *
   * ⚠️ **在构造时派生一次**：HKDF 不贵，但每次刷新都派生一遍是白跑的。
   * 它只存在于进程内存，不落盘、不进日志。
   */
  private readonly graceKey: Buffer;
```

并在构造函数里赋值：

```ts
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {
    this.graceKey = deriveGraceKey(
      process.env.JWT_SECRET ??
        'change-me-in-production-at-least-32-chars-long',
    );
  }
```

⚠️ **兜底值要与 `auth.module.ts` 里的 `JWT_SECRET` 兜底一致** ——
否则 JWT 签名用的密钥与派生密钥的来源不一致（虽然没关系，但要一致）。

**4c. 拆开 `issueTokens`**。把现有的 `issueTokens` 改成三个方法：

```ts
  /** 只签访问令牌（JWT 自包含，不需要落库） */
  private async signAccessToken(user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    tenantId: string | null;
  }): Promise<string> {
    return this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });
  }

  /** 生成一枚刷新令牌与它的过期时刻（**不落库**，由调用方决定写到哪） */
  private createRefreshToken(): { refreshToken: string; expiresAt: Date } {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    );
    return { refreshToken, expiresAt };
  }

  private async issueTokens(user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    tenantId: string | null;
  }): Promise<AuthResult> {
    const accessToken = await this.signAccessToken(user);
    const { refreshToken, expiresAt } = this.createRefreshToken();

    // RefreshToken 不是租户作用域模型，这里不需要（也不应该）切换上下文
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        tenantId: user.tenantId,
      },
      accessToken,
      refreshToken,
    };
  }
```

**4d. 重写 `refresh`**。把整个 `refresh` 方法替换成：

> ⚠️ **本节的参考代码已被勘误表 #3 取代 —— 不要照抄。**
> 下方的 `handleRevokedToken` 是**改造前三档**版本，
> **缺了第四档**「目标令牌已被明确吊销 → 401，不吊销全族」，
> 而 `refresh` 里也少了一次时钟读取（见勘误表 #8）。
> 少了第四档就会留下**洞二**（登出后重放前身令牌能换回一枚有效的 accessToken
> —— 登出的意图被撤销）与**洞一**（全族吊销够不到已 ROTATED 的行）。
> **正确实现见「Task 2 的补充：审查后修补」一节**
> （修补 1 = 第四档，修补 2 = `revokeTokenFamily` 的 OR 分支，
> 修补 3 = 类注释，修补 4 = accessToken 的签发位置，
> 修补 5 = 抽 `toAuthUser`）。

```ts
  async refresh(refreshToken: string): Promise<AuthResult> {
    const tokenHash = hashRefreshToken(refreshToken);

    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // 这枚令牌已经被吊销过，又被再次使用。
    if (stored.revokedAt) {
      return this.handleRevokedToken(stored);
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // ⚠️ **轮换：旧令牌立即作废，并同时记下宽限记录。**
    //
    // 刷新令牌是长期凭证且会在响应里明文回传客户端，不轮换的话，
    // 一枚泄漏的刷新令牌可以一直换取新令牌，泄露窗口无上限。
    //
    // ⚠️ **「标旧行」与「建新行」必须在同一个事务里** ——
    // 分成两步的话，中间失败会留下一枚「已作废但没有宽限记录」的旧令牌：
    // 客户端在窗口内重试它 → 判真重放 → 吊销全族。
    //
    // ⚠️ **「标旧行」的那一次 updateMany 必须是条件更新**
    //（where 带 revokedAt: null），不能是「先查后写」。
    // 同一枚令牌并发提交两次时，两个请求都会读到 revokedAt === null；
    // 条件更新让并发下只有一个请求的 count 为 1。
    const accessToken = await this.signAccessToken(stored.user);
    const { refreshToken: newRefreshToken, expiresAt } =
      this.createRefreshToken();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const count = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedReason: RefreshTokenRevokedReason.ROTATED,
          // ⚠️ **宽限记录**：新令牌的**密文**。
          // 存密文而不是明文 —— 这张表经常被备份与只读分析。
          rotatedToToken: encryptToken(newRefreshToken, this.graceKey),
          // ⚠️ **一次定死，不因重放而延长**。
          graceExpiresAt: new Date(Date.now() + REFRESH_GRACE_PERIOD_MS),
        },
      });

      // count === 0 → 另一个请求抢先轮换了这一枚。
      // 此时**不能**建新行（会多出一枚没人持有的令牌）。
      if (count.count === 0) return false;

      await tx.refreshToken.create({
        data: {
          userId: stored.user.id,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt,
        },
      });
      return true;
    });

    if (!rotated) {
      // 条件更新没命中：这枚令牌在我们读它之后、轮换它之前，
      // 被另一个请求轮换掉了。重新读一次拿**准确的**状态。
      const current = await this.prisma.refreshToken.findFirst({
        where: { id: stored.id },
        include: { user: true },
      });
      if (!current) {
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }
      return this.handleRevokedToken(current);
    }

    return {
      user: {
        id: stored.user.id,
        email: stored.user.email,
        displayName: stored.user.displayName,
        role: stored.user.role,
        tenantId: stored.user.tenantId,
      },
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * 处理一枚**已经被吊销过**的刷新令牌。
   *
   * 分三档（阶段 5c 之后）：
   * ① 登出后误用 → 401，不牵连其它设备
   * ② **宽限期内** → 返回**同一枚**新令牌，不吊销令牌族
   * ③ 其余（超期 / 密文解不开 / 已被判成重放）→ 吊销整个令牌族 → 401
   *
   * ⚠️ **② 与 ③ 之间不再区分「并发」与「先后」**（设计文档 §5.3 的实测结论）：
   * 那个区分依赖「轮换时刻 vs 请求起始时刻」的毫秒级比较，
   * 而两个请求是否重叠**取决于环境**——在别的机器上两个请求可能真串行抵达，
   * 于是同一条用例时而走 ② 时而走 ③，测试会变成 flaky。
   * 统一处理后判定不依赖任何时序。
   */
  private async handleRevokedToken(
    stored: Prisma.RefreshTokenGetPayload<{ include: { user: true } }>,
  ): Promise<AuthResult> {
    // ① 登出后误用：用户只是误用了自己刚登出的旧令牌。
    // 把它当成泄露处理会把手机、电脑等其它设备的登录一起踢掉。
    if (stored.revokedReason === RefreshTokenRevokedReason.LOGOUT) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }

    // ② 宽限期：同一枚令牌在 60 秒内被重复提交
    // （客户端超时重试、两个标签页串行抵达、跨副本各刷一次），
    // 返回**第一次那枚**新令牌，不吊销令牌族。
    //
    // ⚠️ **解密失败一律按「宽限期不可用」处理** → 落到 ③。
    // 绝不把 null 当成令牌返回给客户端。
    if (
      stored.revokedReason === RefreshTokenRevokedReason.ROTATED &&
      stored.graceExpiresAt &&
      new Date() < stored.graceExpiresAt
    ) {
      const restored =
        stored.rotatedToToken === null
          ? null
          : decryptToken(stored.rotatedToToken, this.graceKey);

      if (restored) {
        return {
          user: {
            id: stored.user.id,
            email: stored.user.email,
            displayName: stored.user.displayName,
            role: stored.user.role,
            tenantId: stored.user.tenantId,
          },
          // ⚠️ **accessToken 重新签发，refreshToken 是同一枚**。
          // accessToken 是无状态 JWT，重签无害且顺延会话；
          // refreshToken 必须同一枚才谈得上「幂等」。
          accessToken: await this.signAccessToken(stored.user),
          refreshToken: restored,
        };
      }
    }

    // ③ 这枚令牌在抵达前就已经离开了合法用户，说明它在别处还有第二个持有者。
    // 按 OAuth 2.0 安全最佳实践（RFC 9700 / BCP）作废整个令牌族 ——
    // 攻击者与真实用户同时失效，重新登录即可恢复。
    await this.revokeTokenFamily(stored.userId, stored.id);
    throw new UnauthorizedException(
      '刷新令牌已被使用过，出于安全考虑已吊销全部登录状态',
    );
  }
```

**4e. 删掉 `isConcurrentRace` 方法**。它的唯一职责是区分「并发」与「真重放」
以决定是否吊销全族，而这个职责已被宽限期完全取代。

⚠️ 同时删掉 `refresh` 里对 `requestStartedAt` 的使用 —— 新的 `refresh` 里
**没有**这个变量了。

**4f. `revokeTokenFamily` 补上抹密文**。两个 `updateMany` 的 `data` 都要加
`rotatedToToken: null`：

> ⚠️ **本节的参考代码已被勘误表 #3 取代 —— 不要照抄。**
> 下方的 `where: { userId, revokedAt: null }` 是**改造前**版本，
> **够不到已 ROTATED 的行** → 全族吊销后，族内已轮换的行仍带着
> 完整的宽限密文与未到期的 `graceExpiresAt`，重放它们照样能换回令牌 ——
> **「吊销全族」名不副实**（这就是「洞一」）。
> 正确实现见「Task 2 的补充：审查后修补」的**修补 2**
> （where 加 `OR: [{ revokedReason: ROTATED }]`，`LOGOUT` 不纳入）。

```ts
  private async revokeTokenFamily(
    userId: string,
    triggerTokenId: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokedReason: RefreshTokenRevokedReason.REPLAY,
          // ⚠️ 全族吊销后，这些宽限密文不该再能被返回。
          rotatedToToken: null,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { id: triggerTokenId },
        data: {
          revokedAt: now,
          revokedReason: RefreshTokenRevokedReason.REPLAY,
          rotatedToToken: null,
        },
      }),
    ]);
  }
```

- [ ] **Step 5：跑 e2e 确认通过**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns "auth.e2e-spec"
```

预期：PASS，`auth.e2e-spec.ts` 全部用例通过。

⚠️ **若「并发重用」那条挂**（实际是 `[200, 401]`），说明 `handleRevokedToken`
没被走到 —— 查 `refresh` 里 `stored.revokedAt` 的分支是不是漏了。

⚠️ **若报类型错误**（`tx.refreshToken` 不存在），说明 `PrismaTransaction` 类型
的 `tx` 上没有 `refreshToken` —— 检查是不是用了 `this.prisma` 而不是 `tx`。

- [ ] **Step 6：跑全量后端测试**

```bash
cd api && npm test 2>&1 | tail -20
```

预期：单元测试全过。

```bash
cd api && npm run test:e2e 2>&1 | tail -20
```

预期：e2e 全过（26 套件 / 470 条 + 本阶段新增）。

⚠️ **跑 e2e 不需要停 api 容器**（队列前缀隔离与每轮清库早已实现，
实测连跑 3 轮全绿）。但若出现**随机的假失败**，先 `docker compose stop api` 再试。

- [ ] **Step 7：失败注入（确认 G1–G8 的断言不是空的）**

**注入 1**：把 `handleRevokedToken` 里整个宽限期分支的条件改成
`false`（即宽限期永不生效）。

```bash
cd api && python3 - <<'PY'
import pathlib
p = pathlib.Path('src/modules/auth/auth.service.ts')
s = p.read_text()
s = s.replace("stored.graceExpiresAt &&\n      new Date() < stored.graceExpiresAt", "false &&\n      stored.graceExpiresAt &&\n      new Date() < stored.graceExpiresAt")
p.write_text(s)
PY
```

跑：

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns "auth.e2e-spec"
```

预期：**至少 4 条挂**（宽限期内重放、并发重用、不牵连其它设备、链式自愈）。

**注入 2**：把 `revokeTokenFamily` 里的 `rotatedToToken: null` 删掉。

预期：仍然全绿 —— 这条注入**测不出东西**是正常的（抹密文不改变行为，
只影响数据整洁度）。**如实记录这一点，不要假装它抓到了什么。**

⚠️ **注入 2 的意义是「确认这条断言不存在」** —— 它提醒我们：抹密文这条
没有自动化保护，将来有人删掉它不会有测试挂。这是**已知的技术债**，
记进验收记录。

**恢复**：把两处注入都改回去（用 `git diff` 确认 `auth.service.ts` 干净）。

- [ ] **Step 8：提交**

```bash
git add api/src/modules/auth/auth.service.ts api/test/auth.e2e-spec.ts
git commit -m "feat(api): 刷新令牌宽限期——同一枚旧令牌在 60 秒内换回同一枚新令牌"
```

---

## Task 2 的补充：审查后修补

> **这一节是 Task 2 的代码质量审查之后加的**（勘误表 #3）。
> Task 2 本身已实现并提交（`799ca7a`），本节修的是**审查查出的两个真漏洞**。
> 设计依据见设计文档 §5.6。

### 为什么必须修

Task 2 给 `ROTATED` 状态的行加上了**可兑换的新令牌密文**。
改造前，`ROTATED` 行上没有任何可兑换的秘密，所以下面两个缺口不可利用；
改造后它们都成了**真漏洞**：

| 洞 | 现象 | 危害 |
|---|---|---|
| **洞一** | `revokeTokenFamily` 的第一个 `updateMany` 的 where 是 `{ userId, revokedAt: null }` —— **够不到已 ROTATED 的行**。全族吊销后，族内已轮换的行仍带着完整的宽限密文与未到期的 `graceExpiresAt` | 重放族内已轮换的令牌 → 换回一枚**已被吊销**的令牌。「吊销全族」名不副实 |
| **洞二** | `logout` 只吊销**被提交的那一枚**。它的**前身**（把轮换成它的那枚）仍是 `ROTATED`，密文完好，宽限期未到 | 用户登出后，重放**前身令牌**能换回 **200 + 一枚新签发的有效 accessToken** —— **登出的意图被撤销**。⚠️ 改造前重放前身令牌必然 401 |

### 修补 1：宽限期内放行前，确认那枚新令牌还活着

**Files:** Modify `api/src/modules/auth/auth.service.ts`

把 `handleRevokedToken` 里宽限期分支的 `if (restored) { ... }` 改成：

```ts
      if (restored) {
        // ⚠️ **那枚新令牌自己还活着吗？**（阶段 5c 审查补上）
        //
        // 宽限记录存的是「我轮换出了哪枚新令牌」，但**那枚新令牌可能已经被吊销了**：
        // - 用户用它登出（LOGOUT）→ 不检查的话，**登出会被撤销**：
        //   重放前身令牌能换回一枚有效的 accessToken
        // - 它自己被判成真重放（REPLAY）→ 同理
        const target = await this.prisma.refreshToken.findFirst({
          // ⚠️ **显式带上 userId**：这一行是全局无过滤查询
          // （`RefreshToken` 不在 `TENANT_SCOPED_MODELS` 里）。
          // 当前安全（密文只由服务端写、`tokenHash` 全局唯一），
          // 但完全依赖隐式不变量 —— 加一道显式约束当防御纵深。
          where: {
            tokenHash: hashRefreshToken(restored),
            userId: stored.userId,
          },
          select: { revokedReason: true },
        });

        // ⚠️ **ROTATED 的目标要放行** —— 链式自愈（设计文档 §4.5）依赖它：
        // 重放 T0 拿回 T1，而 T1 此时已经是 ROTATED。
        // 若把它也拒绝，链就断了（G8 那条用例会挂）。
        const alive =
          target !== null &&
          (target.revokedReason === null ||
            target.revokedReason === RefreshTokenRevokedReason.ROTATED);

        if (alive) {
          return {
            user: {
              id: stored.user.id,
              email: stored.user.email,
              displayName: stored.user.displayName,
              role: stored.user.role,
              tenantId: stored.user.tenantId,
            },
            // ⚠️ **accessToken 重新签发，refreshToken 是同一枚**。
            // accessToken 是无状态 JWT，重签无害且顺延会话；
            // refreshToken 必须同一枚才谈得上「幂等」。
            accessToken: await this.signAccessToken(stored.user),
            refreshToken: restored,
          };
        }

        // ⚠️ **那枚新令牌已被明确吊销** → 只拒本请求，**不吊销全族**。
        // 「终止这条链」的意图已经表达过了；再吊销全族只会
        // **牵连其它设备**（登出场景）或**毫无意义**（已被判重放场景）。
        // 这与「登出后重用令牌 → 401，不牵连其它设备」是同一条原则。
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }
```

### 修补 2：`revokeTokenFamily` 的 where 覆盖 ROTATED 行

**Files:** Modify `api/src/modules/auth/auth.service.ts`

`revokeTokenFamily` 的第一个 `updateMany` 的 where 改成：

```ts
        where: {
          userId,
          // ⚠️ 不能只写 { revokedAt: null }：那只会覆盖**还没被吊销**的行。
          // 已经 ROTATED 的行带着**完整的宽限密文**活下来，
          // 重放它照样能在宽限期内换回令牌 ——「吊销全族」名不副实。
          //
          // ⚠️ **LOGOUT 不纳入**：登出的令牌不该被重放路径改写成 REPLAY，
          // 那会掩盖「用户主动登出」这个事实。
          //
          // ⚠️ 这个修改**不会牵连其它设备**：它只在「真重放被判定」时生效，
          // 而那时整个令牌族本来就要死。
          OR: [
            { revokedAt: null },
            { revokedReason: RefreshTokenRevokedReason.ROTATED },
          ],
        },
```

### 修补 3：`revokeTokenFamily` 的类注释已过时

**Files:** Modify `api/src/modules/auth/auth.service.ts`

⚠️ **改造后那段注释的后半句不成立了** —— 「并发刷新里的 loser 不走这里」
现在是对的（并发 loser 走宽限期 ② 分支），但「读到 revokedAt 已非空**且原因是 ROTATED**」
不准确：REPLAY 也会走到这里。改成：

```ts
  /**
   * 作废某个用户的整个刷新令牌族。
   *
   * 触发者是「判定为真重放」的路径（`handleRevokedToken` 的第 ③ 档）：
   * 宽限期已过、宽限密文解不开、或这枚令牌本身已被判成重放。
   *
   * ⚠️ **并发刷新里的 loser 不走这里**：它落进宽限期的第 ② 档
   * （返回同一枚新令牌），毫秒级竞态不是泄露，动辄吊销全族会把
   * 用户自己的其它设备一起踢下线。
   *
   * ⚠️ **where 必须覆盖 ROTATED 的行**（见下面的 OR）：那些行带着可兑换的
   * 宽限密文，够不到它们就等于「吊销全族」名不副实。
   *
   * 两次写入必须原子：中途失败会留下「整族已作废、但触发者仍标 ROTATED」
   * 的记录，下次重放同一枚令牌会再次触发全族吊销。
   */
```

### 修补 4：accessToken 挪到分支里签发

**Files:** Modify `api/src/modules/auth/auth.service.ts`

⚠️ 现在的写法是在 `$transaction` **之前**就 `signAccessToken`，
loser 分支会白签一枚（功能无害，但代码读起来像「先签好待用」）。
把 `const accessToken = await this.signAccessToken(stored.user);` 从
`refresh()` 里删掉，改成在两处返回里各自签：

- 成功路径（`rotated === true`）：在 `return { ... }` 之前签
- 宽限路径：在 `handleRevokedToken` 的 `alive` 分支里签（**已经在那里了**）

### 修补 5：抽 `toAuthUser`，去掉三处重复的字段映射

**Files:** Modify `api/src/modules/auth/auth.service.ts`

`{ id, email, displayName, role, tenantId }` 这 6 个字段现在出现在三处
（`refresh()` 的成功返回、`handleRevokedToken` 的宽限返回、`issueTokens`）。
抽一个私有方法：

```ts
  /** 把用户记录映射成对外的用户对象（三处返回都用它，避免漏改字段） */
  private toAuthUser(user: AuthUser): AuthUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
```

⚠️ **参数类型用已导出的 `AuthUser`，不要写内联结构类型**（勘误表 #10）——
同一份内联结构在文件里出现了三遍。`AuthUser` 的 `role: UserRole` 与
Prisma 的 `User.role` 完全兼容，`tsc --noEmit` 通过。

三处都改成 `user: this.toAuthUser(stored.user)`（`issueTokens` 那处用 `this.toAuthUser(user)`）。

### 修补 6：G5 的断言更准 + 覆盖 GCM 认证失败分支

**Files:** Modify `api/test/auth.e2e-spec.ts`

现在的密文 `'this-is-not-a-valid-ciphertext'` 只有 32 字符，
base64url 解出来 24 字节 < 28 → 被**长度守卫**拦下，
走不到 GCM 的认证失败路径。改成**合法长度**的乱码（40 字符）：

```ts
      // 把密文改成**合法长度**的乱码（模拟密文被篡改 / 密钥被换）。
      // ⚠️ 长度必须够 —— 不足 28 字节会被长度守卫拦下，
      // 走不到 GCM 的认证失败分支，测的就不是同一件事了。
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(token) },
        data: { rotatedToToken: 'A'.repeat(40) },
      });

      // 关键断言：401，**不是** 200 + 空的 refreshToken。
      // 响应体里绝不能出现 `refreshToken` 字段。
      const response = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(401);

      expect(response.body).not.toHaveProperty('refreshToken');
```

### 修补 7：e2e 真的用上 `REFRESH_GRACE_PERIOD_MS`

**Files:** Modify `api/test/auth.e2e-spec.ts`

⚠️ `token.util.ts` 里专门注释说「导出是为了让 e2e 用同一个常量，不会漂移」，
**但 e2e 根本没 import 它** —— 把常量从 60 秒改成 30 秒，这批 e2e 一条都不会挂。

在 G4 那条用例里加上：

```ts
      // 关键断言：宽限期就是常量里写的那个长度（防漂移）。
      //
      // ⚠️ **基准必须是 `revokedAt`，不是 `createdAt`** ——
      // `createdAt` 是**建行**时刻（登录时），`graceExpiresAt` 是**轮换**时刻 + 60 秒，
      // 中间隔着「登录→刷新」的耗时。实测（故意 sleep 1.5 秒）差值是 61515
      // 而不是 60000 —— 照抄 `createdAt` 基准会**必然失败**。
      // `revokedAt` 与 `graceExpiresAt` 在同一次原子 `updateMany` 里写入，
      // 同取轮换时刻，差值恒为 60000。
      const row = await prisma.refreshToken.findFirst({
        where: { tokenHash: hashRefreshToken(token) },
        select: { revokedAt: true, graceExpiresAt: true },
      });
      expect(
        (row?.graceExpiresAt?.getTime() ?? 0) -
          (row?.revokedAt?.getTime() ?? 0),
      ).toBe(REFRESH_GRACE_PERIOD_MS);
```

（需要在该文件顶部 import `REFRESH_GRACE_PERIOD_MS`。）

### 修补 8：补三条 e2e 用例

**Files:** Modify `api/test/auth.e2e-spec.ts`

在 `describe('刷新令牌宽限期（阶段 5c）')` 组里补：

```ts
    it('登出后重放前身令牌返回 401，且不牵连其它设备（洞二）', async () => {
      const { token: t0 } = await loginMerchant();

      // ① T0 刷新 → T1
      const r1 = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t0 })
        .expect(200);
      const t1 = body(r1).refreshToken;
      const access1 = body(r1).accessToken;

      // ② 用 T1 登出
      // ⚠️ 登出接口有 JwtAuthGuard，**必须带 Authorization 头**
      await http(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${access1}`)
        .send({ refreshToken: t1 })
        .expect(204);

      // ③ 关键断言：重放**前身** T0 → 401。
      // 不检查目标令牌状态的话，这里会返回 200 + 一枚有效的 accessToken
      // —— 登出的意图被撤销。
      const replay = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t0 })
        .expect(401);

      expect(replay.body).not.toHaveProperty('accessToken');
    });

    it('全族吊销后重放族内已轮换的令牌返回 401（洞一）', async () => {
      const { token: t0 } = await loginMerchant();

      // ① T0 刷新 → T1
      const r1 = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t0 })
        .expect(200);
      const t1 = body(r1).refreshToken;

      // ② 让 T0 超出宽限期 → 触发全族吊销
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(t0) },
        data: { graceExpiresAt: new Date(Date.now() - 1000) },
      });
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t0 })
        .expect(401);

      // ③ 关键断言：族内那枚**已轮换**的令牌（T1，它也有自己的宽限记录
      // 指向 T2）不能再换回令牌 —— 它指向的 T2 已经被吊销了。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: t1 })
        .expect(401);
    });

    it('宽限期内多次重放拿到的始终是同一枚令牌', async () => {
      const { token } = await loginMerchant();

      const first = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(200);
      const rotated = body(first).refreshToken;

      // 连续重放 3 次，每次都必须是**同一枚**
      for (let i = 0; i < 3; i += 1) {
        const again = await http(app)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: token })
          .expect(200);
        expect(body(again).refreshToken).toBe(rotated);
      }
    });
```

⚠️ **登出接口的路径与状态码要照现有 e2e 文件里的实际写法** ——
现有用例是 `POST /api/v1/auth/logout`，**要带 `Authorization: Bearer <accessToken>`**
（`JwtAuthGuard` 守卫），期望 **204**。

⚠️ **「洞一」必须轮换两次**（T0→T1→T2）——
只轮换一次的话，**T1 是族里最新的令牌、`revokedAt` 为空**，
早被 `{ revokedAt: null }` 覆盖，根本落不到修补 2 的 ROTATED 分支上。
（计划原稿给的代码只有一次轮换，与它自己的注释「T1 也有自己的宽限记录指向 T2」不一致。）

⚠️ **「洞二」必须建两台设备** —— 标题声称「不牵连其它设备」，
只建一台的话，「拒绝时吊销全族」这个行为**没有任何锁点**：
将来有人把拒绝分支改成调 `revokeTokenFamily`，不会有任何测试挂。
设备 B 的令牌是**另一个 `refreshToken` 行**，与设备 A 的链完全无关；
拒绝时若按 `userId` 吊销全族，设备 B 会被连带吊掉 → 断言会挂。
⚠️ **顺序要紧**：先重放 T0，再刷设备 B。反过来的话设备 B 先被轮换，
就验不到「设备 B 那枚**没被碰过**的令牌」还能不能用。

### 修补 9：验证

```bash
cd api && npx eslint --fix src/modules/auth/auth.service.ts test/auth.e2e-spec.ts
cd api && npx eslint "src/**/*.ts" "test/**/*.ts"
cd api && npx tsc --noEmit
cd api && npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns "auth.e2e-spec"
cd api && npm test 2>&1 | tail -10
cd api && npm run test:e2e 2>&1 | tail -10
```

⚠️ `test/**/*.ts` 里那 2 条**阶段 2 遗留**的 error（`media.e2e-spec.ts` 609/618）不是本节引入的。

**失败注入 3**（确认新增的断言不是恒真）：把修补 1 里 `const alive = ...` 改成
`const alive = true;` —— 预期「登出后重放前身令牌」与
「全族吊销后重放族内已轮换的令牌」两条挂掉。

⚠️ **必须「单独」跑这个注入** —— 不要与失败注入 1（关掉宽限期分支）叠加。
叠加时宽限期分支整个被关掉，`alive` 那段代码**压根没机会执行**，
挂的条数全是注入 1 的功劳 —— 用叠加数字判断 `alive` 有没有锁点会得出错误结论。

⚠️ **实测：期望 2 条，实得 1 条**（「洞二」挂，「洞一」不挂）。
原因：「洞一」那条即使 `alive = true` 也会被**别的东西**挡住 ——
`revokeTokenFamily`（修补 2）已经把 T1 的行改写成 REPLAY，
密文也被抹了，所以走不到宽限期分支。**两条用例锁的是不同的东西。**

✅ **收尾时复核（实测）**：单独跑注入 3 → **挂 1 条**，正是「洞二」
（`expected 401 "Unauthorized", got 200 "OK"`，
`Tests: 1 failed, 45 passed, 46 total`）。
所以 **`alive` 有独立的行为层锁点** —— 没有它，登出后重放前身令牌会拿到
200 + 一枚有效 accessToken，**登出的意图被撤销**。

**失败注入 4**：把修补 2 里 `OR: [{ revokedReason: ROTATED }]` 删掉 ——
预期「全族吊销后重放族内已轮换的令牌」那条挂掉。

⚠️ **实测：期望 1 条，实得 0 条** —— **测不出差别**。
原因：只失效修补 2 时，T1 的行确实残留 `ROTATED` + 完好密文 + 未过期宽限期
（洞的状态层被打开了），但响应仍是 401，因为**修补 1 先一步拦住了**。
**如实记录这一点，不要假装抓到了什么。**

⚠️ **由此得出两条必须写进验收记录的结论**：
1. **修补 1 与修补 2 是两道独立的防线**，不能互相替代 ——
   修补 1 是**响应层**的防线（拦住「把死令牌还回去」），
   修补 2 是**状态层**的防线（让族内已轮换的行真正被吊销、密文被抹）。
   **将来若要简化，只能删修补 2、不能删修补 1。**
2. 「洞一」那条用例**锁不住修补 2**（它锁的是响应结果，不是行状态）。
   想锁住修补 2，需要**查库**断言 T1 行的 `revokedReason` 变成了 `REPLAY`。

### 修补 10：提交

```bash
git add api/src/modules/auth/auth.service.ts api/test/auth.e2e-spec.ts
git commit -m "fix(api): 宽限期放行前确认目标令牌还活着——堵上登出被撤销的漏洞"
```

---

## Task 3：宽限密文的定时清理

> ⚠️ **Task 3 带出的一个已知遗留项**（勘误表 #12，**非本阶段引入**）：
> **Redis 不可达时 `app.init()` 既不 resolve 也不 reject，应用静默挂死**
> （30 秒超时仍在阻塞）。对照实验证明 `RenewalService.onModuleInit` 与
> `TokenGraceService.onModuleInit` **各摘一个都仍然阻塞**，两个都摘才 110ms 启动成功
> —— 说明根因在 `queue.module.ts` 的 `maxRetriesPerRequest: null` + ioredis 无限重试，
> 是**既有缺陷**。K8s 里表现为 Pod 永远 `Running` 但不 Ready。
> **属阶段 5d 的范畴**，本阶段不做。

**Files:**
- Modify: `api/src/common/queue/queue.constants.ts`
- Modify: `api/src/common/queue/queue.module.ts`
- Modify: `api/src/modules/queue/queue.service.ts`
- Create: `api/src/modules/auth/token-grace.service.ts`
- Create: `api/src/modules/auth/token-grace.worker.ts`
- Modify: `api/src/modules/auth/auth.module.ts`
- Create: `api/test/token-grace.e2e-spec.ts`

- [ ] **Step 1：写清理任务的 e2e**

创建 `api/test/token-grace.e2e-spec.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import {
  TenantContextInterceptor,
} from '../src/modules/tenancy/tenant-context.interceptor';
import {
  TenantPrismaService,
} from '../src/common/tenant/tenant-prisma.service';
import { TokenGraceService } from '../src/modules/auth/token-grace.service';
import { hashRefreshToken } from '../src/modules/auth/token.util';
import { RefreshTokenRevokedReason } from '@prisma/client';
import { http } from './helpers';

/**
 * 宽限密文的定时清理（阶段 5c）。
 *
 * ⚠️ **为什么要有这个任务**：宽限记录里存的是新令牌的**密文**，
 * 客户端轮换后就不会再用旧令牌，所以绝大多数行的密文**永远等不到**
 * 「有人来用它」的那一刻 —— 惰性清理根本不会触发。
 *
 * 护栏 G7：过期宽限记录的密文被抹掉，没过期的保留。
 */
describe('宽限密文的清理 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let grace: TokenGraceService;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();

    prisma = app.get(TenantPrismaService);
    grace = app.get(TokenGraceService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 造一枚「已轮换、带宽限记录」的令牌行。
   *
   * @param graceExpiresAt 宽限截止时刻；给一个过去的时刻就表示「已过期」
   */
  async function seedRotatedToken(
    graceExpiresAt: Date,
  ): Promise<{ userId: string; tokenHash: string }> {
    const account = `grace-${unique()}@example.test`;
    const registered = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '清理商家',
        subdomain: `shop-${unique()}`,
        storeName: '清理店铺',
      })
      .expect(201);

    const userId = (registered.body as { user: { id: string } }).user.id;
    const tokenHash = hashRefreshToken(`plain-${unique()}`);

    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        revokedAt: new Date(),
        revokedReason: RefreshTokenRevokedReason.ROTATED,
        rotatedToToken: 'cipher-text-placeholder',
        graceExpiresAt,
      },
    });

    return { userId, tokenHash };
  }

  it('把过期宽限记录的密文抹掉，没过期的保留（G7）', async () => {
    const expired = await seedRotatedToken(new Date(Date.now() - 1000));
    const alive = await seedRotatedToken(new Date(Date.now() + 60_000));

    const cleared = await grace.cleanup();

    // 至少抹掉了那一行（库里可能还有别的过期行，所以用 >= 而不是 ===）
    expect(cleared).toBeGreaterThanOrEqual(1);

    const expiredRow = await prisma.refreshToken.findFirst({
      where: { tokenHash: expired.tokenHash },
      select: { rotatedToToken: true, graceExpiresAt: true },
    });
    const aliveRow = await prisma.refreshToken.findFirst({
      where: { tokenHash: alive.tokenHash },
      select: { rotatedToToken: true, graceExpiresAt: true },
    });

    // 关键断言 1：过期的那行密文被抹了，但宽限截止时刻保留
    // （时刻是审计线索，不该被清掉）
    expect(expiredRow?.rotatedToToken).toBeNull();
    expect(expiredRow?.graceExpiresAt).not.toBeNull();

    // 关键断言 2：没过期的必须留着
    expect(aliveRow?.rotatedToToken).toBe('cipher-text-placeholder');
  });

  it('清理之后不该再有带密文的过期记录残留', async () => {
    // ⚠️ **不断言「清掉了 0 条」** —— 库里可能有别的套件造的过期记录。
    // 断言的是「清理之后一条都不剩」，这才是清理任务真正的职责。
    await grace.cleanup();

    const remaining = await prisma.refreshToken.count({
      where: {
        rotatedToToken: { not: null },
        graceExpiresAt: { lt: new Date() },
      },
    });

    expect(remaining).toBe(0);
  });
});
```

⚠️ **`revokedReason` 用的是 Prisma 枚举** `RefreshTokenRevokedReason.ROTATED`，
不是字符串 `'ROTATED'` —— 写字符串在 TS 里会类型报错。

- [ ] **Step 2：跑 e2e 确认失败**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns "token-grace"
```

预期：FAIL，报 `Cannot find module '../src/modules/auth/token-grace.service'`。

- [ ] **Step 3：加队列常量与注册**

**3a.** `api/src/common/queue/queue.constants.ts` 末尾追加：

```ts
/** 刷新令牌宽限记录清理队列 */
export const AUTH_QUEUE = 'auth';
```

**3b.** `api/src/modules/queue/queue.module.ts`：
- import 里加上 `AUTH_QUEUE`
- `BullModule.registerQueue(...)` 里加上 `{ name: AUTH_QUEUE }`

```ts
    BullModule.registerQueue(
      { name: PAYMENT_TIMEOUT_QUEUE },
      { name: PAYMENT_WEBHOOK_QUEUE },
      { name: BILLING_QUEUE },
      { name: AUTH_QUEUE },
    ),
```

**3c.** `api/src/modules/queue/queue.service.ts`：
- import 里加上 `AUTH_QUEUE`
- `QueueName` 联合类型加上 `| typeof AUTH_QUEUE`
- 构造函数加注入并登记：

```ts
  constructor(
    @InjectQueue(PAYMENT_TIMEOUT_QUEUE) timeoutQueue: Queue,
    @InjectQueue(PAYMENT_WEBHOOK_QUEUE) webhookQueue: Queue,
    @InjectQueue(BILLING_QUEUE) billingQueue: Queue,
    @InjectQueue(AUTH_QUEUE) authQueue: Queue,
  ) {
    this.queues.set(PAYMENT_TIMEOUT_QUEUE, timeoutQueue);
    this.queues.set(PAYMENT_WEBHOOK_QUEUE, webhookQueue);
    this.queues.set(BILLING_QUEUE, billingQueue);
    this.queues.set(AUTH_QUEUE, authQueue);
  }
```

- [ ] **Step 4：写清理服务**

创建 `api/src/modules/auth/token-grace.service.ts`：

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AUTH_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/** 清理的间隔（1 小时） */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 宽限记录的定时清理。
 *
 * ⚠️ **为什么必须清理**：宽限记录里存的是新令牌的**密文**。
 * 客户端轮换之后就不会再用旧令牌，所以绝大多数行的密文**永远等不到**
 * 「有人来用它」的那一刻 —— 惰性清理根本不会触发。
 * 不清理的话，这一列会随着每次轮换不断增长。
 *
 * ⚠️ **清理用数据库时钟**：批量扫描的判定精度是「小时级」，
 * 几百毫秒的时钟偏差无影响；而用数据库的 `now()` 可以一条 UPDATE 搞定。
 * ⚠️ **但不能写裸 SQL** —— `TenantPrismaService` 刻意不暴露
 * `$queryRaw` / `$executeRaw`（原生 SQL 不经过租户扩展，
 * 放开就成了绕过隔离的后门）。所以调现成的 `databaseNow()` 拿时间戳，
 * 再交给 Prisma 的 `updateMany`。
 *
 * ⚠️ **判定「令牌是否在宽限期内」（秒级、决定放行与否）用应用时钟** ——
 * 那是 `AuthService` 的事，与这里的批量扫描职责不同。
 */
@Injectable()
export class TokenGraceService implements OnModuleInit {
  private readonly logger = new Logger(TokenGraceService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queue: QueueService,
  ) {}

  /**
   * 注册周期任务，并在启动时先清一次。
   *
   * ⚠️ **启动时清一次是兜底**：清理任务依赖 BullMQ worker，
   * 而 worker 可能没起来或挂了 —— 那密文就会一直留着。
   * 启动时清一次，保证「进程重启过之后一定是干净的」。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      AUTH_QUEUE,
      'cleanup',
      {},
      CLEANUP_INTERVAL_MS,
      // ⚠️ **固定 jobSchedulerId**：BullMQ 的作业调度器按它去重，
      // 重复注册是覆盖而不是叠加 —— 否则每次重启应用都会多一个任务。
      'token-grace-cleanup',
    );

    const cleared = await this.cleanup();
    if (cleared > 0) {
      this.logger.log(`启动时清理了 ${cleared} 条过期的宽限记录`);
    }
  }

  /**
   * 抹掉所有**已过宽限期**的记录上的密文。
   *
   * ⚠️ **只清列不删行**：`refresh_tokens` 的行在 `expiresAt` 过期后依然留着
   * （既有状况）。删行会让「令牌族」的审计线索断掉。
   *
   * @returns 抹掉的行数
   */
  async cleanup(): Promise<number> {
    const now = await this.prisma.databaseNow();

    // ⚠️ `RefreshToken` 不在 `TENANT_SCOPED_MODELS` 里，
    // 所以这个 updateMany 不带 tenantId 条件 —— 它本来就跨租户。
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        graceExpiresAt: { lt: now },
        rotatedToToken: { not: null },
      },
      data: { rotatedToToken: null },
    });

    return result.count;
  }
}
```

- [ ] **Step 5：写消费端**

创建 `api/src/modules/auth/token-grace.worker.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AUTH_QUEUE } from '../../common/queue/queue.constants';
import { TokenGraceService } from './token-grace.service';

/**
 * 宽限记录清理的消费端。
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 这里的幂等靠「清理本身就是幂等的」（抹掉已抹掉的行不报错）。
 */
@Processor(AUTH_QUEUE)
@Injectable()
export class TokenGraceWorker extends WorkerHost {
  constructor(private readonly grace: TokenGraceService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'cleanup') {
      return;
    }
    await this.grace.cleanup();
  }
}
```

- [ ] **Step 6：装配**

修改 `api/src/modules/auth/auth.module.ts`：

```ts
import { TokenGraceService } from './token-grace.service';
import { TokenGraceWorker } from './token-grace.worker';
```

并把 providers 改成：

```ts
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    TokenGraceService,
    TokenGraceWorker,
  ],
```

⚠️ **`QueueModule` 是 `@Global()`**，所以 `QueueService` 自动可用，
**不要**在 `imports` 里加它（加了也无害，但没必要）。

- [ ] **Step 7：跑 e2e 确认通过**

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand --testPathPatterns "token-grace"
```

预期：PASS，2 条全过。

- [ ] **Step 8：跑全量 e2e**

```bash
cd api && npm run test:e2e 2>&1 | tail -20
```

预期：e2e 全过（新增 1 个套件）。

⚠️ **`onModuleInit` 会在每个 e2e 套件启动时跑一次清理** ——
这会抹掉别的套件造的过期宽限记录。⚠️ **如果哪个 e2e 用例依赖
「过期宽限记录还在」，它会被清掉** —— 检查 Task 2 的用例有没有这种依赖
（Task 2 的「超出宽限期」用例是**主动**把 `graceExpiresAt` 改成过去的，
改完之后如果别的套件的 `onModuleInit` 抢先跑了，就会被清掉 →
那条用例的旧令牌行 `rotatedToToken` 变 null → 走「解不开」分支 → 401 ✓
**结果一样**，断言仍成立 ✓）。

- [ ] **Step 9：提交**

```bash
git add api/src/common/queue api/src/modules/queue api/src/modules/auth/token-grace.service.ts api/src/modules/auth/token-grace.worker.ts api/src/modules/auth/auth.module.ts api/test/token-grace.e2e-spec.ts
git commit -m "feat(api): 宽限密文的定时清理与启动时兜底"
```

---

## Task 4：前端的决策逻辑可测

**Files:**
- Create: `storefront/src/lib/jwt-callback.ts`
- Create: `merchant-admin/src/lib/jwt-callback.ts`
- Modify: `storefront/src/auth.ts`
- Modify: `merchant-admin/src/auth.ts`
- Create: `storefront/test/lib/jwt-callback.test.ts`
- Create: `merchant-admin/test/lib/jwt-callback.test.ts`

- [ ] **Step 1：写单元测试**

创建 `merchant-admin/test/lib/jwt-callback.test.ts`：

```ts
/**
 * 护栏 G9 / G10 / G11：`jwt` 回调的决策逻辑。
 *
 * ⚠️ **这份逻辑之前零自动化覆盖**（阶段 4 验收记录 §六·5）：
 * 把「过期时刷新」整段删掉，75 条测试全绿。
 *
 * ⚠️ **为什么要抽成独立模块**：`auth.ts` 顶层就调 `NextAuth({...})`，
 * import 它会初始化 next-auth 的整个依赖图（含 `server-only`），
 * 在 Vitest 的 node 环境里直接报 `Cannot find module 'next/server'`。
 *
 * ⚠️ **这个模块不能 import `next-auth` 的任何东西**（连类型也不能）——
 * 所以它自己定义最小类型。
 */
import { describe, expect, it } from 'vitest';

import { makeJwtCallback, makeSessionCallback } from '@/lib/jwt-callback';
import type { JwtToken } from '@/lib/jwt-callback';

/** 造一个已过期的 accessToken（exp 在 1 小时前） */
function expiredAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
      iat: Math.floor(Date.now() / 1000) - 7200,
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** 造一个还没过期的 accessToken */
function validAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('jwt 回调：什么时候刷新（G9 / G10）', () => {
  it('accessToken 过期且能送回 cookie 时刷新，并把新令牌落到 token 上（G9）', async () => {
    // ⚠️ **刷新函数是注入点** —— 不然测试环境里没有后端，
    // fetch 必然失败 → 走 network 分支 → 断言不出「刷新成功了」。
    const jwt = makeJwtCallback(true, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    // 关键断言：新令牌落到了 token 上
    expect(result.accessToken).toBe('fresh-access');
    expect(result.refreshToken).toBe('fresh-refresh');
  });

  it('accessToken 没过期时完全不刷新', async () => {
    const jwt = makeJwtCallback(true, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const token: JwtToken = {
      accessToken: validAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    // 没过期 → 原样返回，一个字段都不动
    expect(result.accessToken).toBe(token.accessToken);
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('送不回去 cookie 时不刷新（G10）', async () => {
    // ⚠️ **这条是阶段 4 提交 8545635 的核心**。
    // 删掉它 → Server Component 里的 `await auth()` 每次都刷新 →
    // 服务端把旧令牌轮换掉、而浏览器永远拿不到新令牌 →
    // 下次读会话拿旧令牌去刷 → 后端判重放 → 吊销全族 →
    // **商家开第二个标签页就被踢下线**。
    const jwt = makeJwtCallback(false, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(token.accessToken);
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('token 里没有 accessToken 或 refreshToken 时原样返回', async () => {
    const jwt = makeJwtCallback(true, async () => ({
      ok: true,
      tokens: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' },
    }));
    const result = await jwt({ token: { role: 'MERCHANT_OWNER' } });
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
  });
});

describe('jwt 回调：刷新失败怎么办（G11）', () => {
  it('刷新失败且判定为「凭证失效」时作废整个会话（G11）', async () => {
    const jwt = makeJwtCallback(true, async () => ({
      ok: false,
      reason: 'invalid',
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    // 关键断言：两个令牌都被清空 → 中转路由按游客处理，
    // 用户界面上能看出自己掉登录了。
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
  });

  it('刷新失败但只是网络问题时保留旧令牌（G11 / L18）', async () => {
    // ⚠️ **一次 200ms 的抖动不该把商家永久踢出登录**。
    const jwt = makeJwtCallback(true, async () => ({
      ok: false,
      reason: 'network',
    }));
    const token: JwtToken = {
      accessToken: expiredAccessToken(),
      refreshToken: 'old-refresh',
      role: 'MERCHANT_OWNER',
      tenantId: 't1',
    };

    const result = await jwt({ token });

    expect(result.accessToken).toBe(token.accessToken);
    expect(result.refreshToken).toBe('old-refresh');
  });
});

describe('session 回调', () => {
  it('accessToken 缺失时兜底成空串，不把 undefined 传出去', async () => {
    const session = makeSessionCallback();
    const result = await session({
      session: { accessToken: 'x', role: 'MERCHANT_OWNER', tenantId: 't1' },
      token: { role: 'MERCHANT_OWNER', tenantId: 't1' },
    });

    // ⚠️ 原来写的是 `token.accessToken as string` —— 那只是**类型断言**，
    // 运行时 undefined 会原样传出。中转路由拿到空令牌会当游客处理，
    // 用户界面上看不出自己掉登录了。
    expect(result.accessToken).toBe('');
  });

  it('正常情况下把令牌与角色带出去', async () => {
    const session = makeSessionCallback();
    const result = await session({
      session: { accessToken: 'x', role: 'MERCHANT_OWNER', tenantId: 't1' },
      token: {
        accessToken: 'a1',
        role: 'MERCHANT_OWNER',
        tenantId: 't1',
      },
    });

    expect(result.accessToken).toBe('a1');
    expect(result.role).toBe('MERCHANT_OWNER');
    expect(result.tenantId).toBe('t1');
  });

  it('tenantId 为 null 时保持 null（平台超管）', async () => {
    const session = makeSessionCallback();
    const result = await session({
      session: { accessToken: 'x', role: 'PLATFORM_ADMIN', tenantId: null },
      token: { accessToken: 'a1', role: 'PLATFORM_ADMIN', tenantId: null },
    });

    expect(result.tenantId).toBeNull();
  });
});
```

⚠️ **刷新函数是注入点**：`makeJwtCallback` 的第二个参数是
`(refreshToken: string) => Promise<RefreshResult | null>`，默认用真实的
`refreshTokens`。测试靠它注入一个假的刷新函数，
这样才能断言「刷新成功了」而不必真的起一个后端
（测试环境里没有后端 → fetch 必然失败 → 走 network 分支 →
断言不出「刷新成功了」）。

⚠️ **`auth.ts` 那边仍然只传第一个参数**（用默认的真实实现）✓

- [ ] **Step 2：跑测试确认失败**

```bash
cd merchant-admin && npx vitest run test/lib/jwt-callback.test.ts
```

预期：FAIL，报 `Cannot find module '@/lib/jwt-callback'`。

- [ ] **Step 3：写 `jwt-callback.ts`**

创建 `merchant-admin/src/lib/jwt-callback.ts`：

```ts
import { isTokenExpired } from './token-expiry';
import {
  refreshTokens,
  shouldInvalidateSession,
  type RefreshResult,
} from './token-refresh';

/**
 * `jwt` 回调里那个 token 的最小形状。
 *
 * ⚠️ **自己定义而不是 import next-auth 的类型**：
 * `import type` 虽然编译后会被擦除，但一旦写成普通的 `import`，
 * Vitest 就会去解析 next-auth 的依赖图 → 同样的
 * `Cannot find module 'next/server'`。
 *
 * ⚠️ 本文件是 `storefront/src/lib/jwt-callback.ts` 与
 * `merchant-admin/src/lib/jwt-callback.ts` 这**两份文件的副本**，
 * 两份**逐行一致**（diff 无输出）。
 */

/** next-auth 的 jwt 回调里那个 token */
export interface JwtToken {
  accessToken?: string;
  refreshToken?: string;
  role?: string;
  tenantId?: string | null;
  [key: string]: unknown;
}

/** next-auth 的 session */
export interface SessionLike {
  accessToken: string;
  role: string;
  tenantId: string | null;
}

/**
 * 登录成功后由 authorize 返回、随后被塞进 JWT 的用户对象。
 *
 * 商家后台跑在中心域名（无店铺子域名），租户身份完全由 JWT 里的
 * `tenantId` 决定——所以这里把后端返回的字段原样带上就够了。
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  accessToken: string;
  refreshToken: string;
}

/**
 * 造 `jwt` 回调。
 *
 * @param canDeliverCookie 这次读会话**能不能把刷新后的 cookie 交回浏览器**。
 * @param refresh 刷新函数的注入点（默认用真实的 `refreshTokens`）。
 *   测试靠它断言「刷新成功了」而不必真的起一个后端。
 *
 * ## 为什么 `canDeliverCookie` 是整个修复的关键
 *
 * 后端的刷新是**轮换**式的：旧刷新令牌用掉就作废，再被用一次会被判成
 * 「真正的重放」→ `revokeTokenFamily` 吊销该用户**所有设备**的登录。
 *
 * ⚠️ **Server Component 里的 `await auth()` 拿不到 `Set-Cookie`**：
 * next-auth 的那条分支只取响应体，把响应头丢掉了。所以在这里刷新 =
 * 服务端把旧令牌轮换掉、而**浏览器永远拿不到新令牌** → 浏览器下次读会话
 * 又用那枚作废的旧令牌 → 后端判重放 → 吊销全族。
 *
 * 实测（阶段 4 验收记录 §三 场景 2）：**商家只要开第二个标签页就被踢下线**，
 * 后端 `refresh_tokens` 表里 9 枚令牌在同一毫秒被标成 `REPLAY`。
 *
 * ⇒ 所以**只在 cookie 送得回去的地方刷新**：
 * - NextAuth 自带的 `/api/auth/session` 路由
 * - middleware
 *
 * Server Component 那条路**不刷新**——它只是读 cookie 里已有的令牌，
 * 不会把令牌作废掉。
 *
 * ## 阶段 5c 的补充：后端现在有宽限期
 *
 * 后端在 60 秒内对同一枚旧令牌返回**同一枚**新令牌（见
 * `api/src/modules/auth/auth.service.ts` 的 `handleRevokedToken`），
 * 所以「客户端超时后重试」不再把用户踢下线。
 * ⚠️ **但那条缓解不替代本文件里的 `canDeliverCookie` 判断** ——
 * 后端认得「这枚旧令牌我刚发过新令牌」，但前端**送不回**刷新结果时，
 * 轮换仍会发生，每读一次会话就把令牌往作废的方向推一步。
 * 两者是**互补**的，都必要。
 */
export function makeJwtCallback(
  canDeliverCookie: boolean,
  refresh: (
    refreshToken: string,
  ) => Promise<RefreshResult | null> = refreshTokens,
) {
  return async function jwt({
    token,
    user,
  }: {
    token: JwtToken;
    user?: unknown;
  }): Promise<JwtToken> {
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
    // 后端的 accessToken 只有 2 小时，而 NextAuth 的会话默认活 30 天。
    // 不刷新的话，商家连续用超过 2 小时后，后台的每个请求都带一枚
    // 过期令牌 → 后端一律 401 → 商家看到「订单列表加载失败（401）」，
    // 而界面上仍然显示自己已登录。
    const accessToken = token.accessToken as string | undefined;
    const refreshToken = token.refreshToken as string | undefined;
    if (!accessToken || !refreshToken) return token;

    if (!isTokenExpired(accessToken, Math.floor(Date.now() / 1000))) {
      return token;
    }

    // ⚠️ **送不回去就别刷**（见上面 `canDeliverCookie` 的说明）。
    if (!canDeliverCookie) {
      return token;
    }

    const result = await refresh(refreshToken);
    if (!result || !result.ok) {
      if (!shouldInvalidateSession(result)) {
        // ⚠️ **网络失败 ≠ 凭证失效**。
        // 后端只是没响应（重启、抖动、一次 200ms 的卡顿）——
        // 凭证多半还是好的。**保留旧令牌**，让本次请求失败（401），
        // 下次读会话时再试一次。
        //
        // 若在这里作废会话：一次抖动就把用户**永久踢出登录**
        // （refreshToken 也被清掉，必须重新登录），而且不可逆。
        return token;
      }
      // 凭证真的失效了：作废整个会话，让用户重新登录。
      // 保留 accessToken 反而会让每个接口都回 401，
      // 用户看到的现象是「点了没反应」而不是「请重新登录」。
      return {
        ...token,
        accessToken: undefined,
        refreshToken: undefined,
      };
    }

    token.accessToken = result.tokens.accessToken;
    token.refreshToken = result.tokens.refreshToken;
    return token;
  };
}

/**
 * 造 `session` 回调。
 *
 * ⚠️ **accessToken 为空时要兜底成 `''`**：原来的
 * `token.accessToken as string` 只是**类型断言**，运行时 `undefined`
 * 会原样传出。会话已作废（刷新失败）时不该再给出一个「看起来登录着」的会话。
 */
export function makeSessionCallback() {
  return async function session({
    session,
    token,
  }: {
    session: SessionLike;
    token: JwtToken;
  }): Promise<SessionLike> {
    session.accessToken = (token.accessToken as string | undefined) ?? '';
    session.role = token.role as string;
    session.tenantId = (token.tenantId as string | null) ?? null;
    return session;
  };
}
```

- [ ] **Step 4：改 `auth.ts` 引用它**

修改 `merchant-admin/src/auth.ts`：

**4a.** 删掉 `import { isTokenExpired } from '@/lib/token-expiry';` 与
`import { refreshTokens, shouldInvalidateSession } from '@/lib/token-refresh';`，
换成：

```ts
import {
  makeJwtCallback,
  makeSessionCallback,
  type AuthUser,
} from '@/lib/jwt-callback';
```

**4b.** 删掉整个 `makeJwtCallback` 函数定义（从 `function makeJwtCallback(canDeliverCookie: boolean) {` 到它的结尾 `}`）。

**4c.** 删掉本文件里 `export interface AuthUser { ... }`（已搬到 `jwt-callback.ts`）。

**4d.** 把 callbacks 改成：

```ts
    callbacks: {
      jwt: makeJwtCallback(request !== undefined),
      session: makeSessionCallback(),
    },
```

⚠️ **注意**：`makeSessionCallback()` 返回的函数签名是
`({ session, token }) => Promise<SessionLike>`，而 next-auth 期望
`({ session, token }) => Session | Promise<Session>`。next-auth 的 `Session` 类型
比 `SessionLike` 多一些字段（`user`、`expires`），所以**类型可能对不上**。

⚠️ **如果 TS 报错**，在 `auth.ts` 那边做一次**适配**（不要改 `jwt-callback.ts`）：

```ts
      session: async (params) =>
        (await makeSessionCallback()(params as unknown as {
          session: SessionLike;
          token: JwtToken;
        })) as unknown as Session,
```

⚠️ **实现时先按上面那版写，跑 `npx tsc --noEmit` 看报什么**，
按实际报错做适配 —— **不要**为了绕过报错去改 `jwt-callback.ts` 的类型。

**4e.** `storefront/src/auth.ts` 做**完全相同**的改动。

⚠️ **两个文件本来就有差异**（storefront 带 `x-tenant-subdomain`、
`scope: 'CUSTOMER'`、`resolveTenantSubdomain`），**那些差异要保留**。
只有「`makeJwtCallback` / `session` 回调 / `AuthUser`」这三处要改成引用同一个模块。

- [ ] **Step 5：跑测试确认通过**

```bash
cd merchant-admin && npx vitest run test/lib/jwt-callback.test.ts
```

预期：PASS，9 条全过。

```bash
cd merchant-admin && npm test 2>&1 | tail -20
```

预期：全过（原有 191 条 + 新增 9 条 = 200 条）。

- [ ] **Step 6：把测试与实现复制到 storefront**

```bash
cp merchant-admin/test/lib/jwt-callback.test.ts storefront/test/lib/jwt-callback.test.ts
cp merchant-admin/src/lib/jwt-callback.ts storefront/src/lib/jwt-callback.ts
```

⚠️ **两份必须逐行一致** —— 用 `diff` 验证：

```bash
diff merchant-admin/src/lib/jwt-callback.ts storefront/src/lib/jwt-callback.ts && echo "实现一致 ✓"
diff merchant-admin/test/lib/jwt-callback.test.ts storefront/test/lib/jwt-callback.test.ts && echo "测试一致 ✓"
```

⚠️ **storefront 的 `jwt-callback.ts` 里的注释有一句是商家后台特有的**
（「商家后台跑在中心域名（无店铺子域名），租户身份完全由 JWT 里的 `tenantId` 决定」）
—— **两边要统一成同一句**，否则 `diff` 不干净。选一个中性表述：

```
 * 租户身份完全由 JWT 里的 `tenantId` 决定——
 * 所以这里把后端返回的字段原样带上就够了。
```

⚠️ **`token-refresh.ts` 的 import 路径**：storefront 那份是
`from './token-refresh'`（同目录相对路径）✓ 两份一致

- [ ] **Step 7：跑 storefront 的测试**

```bash
cd storefront && npx vitest run test/lib/jwt-callback.test.ts
```

预期：PASS，9 条全过。

```bash
cd storefront && npm test 2>&1 | tail -20
```

预期：全过（原有 175 条 + 新增 9 条 = 184 条）。

- [ ] **Step 8：类型检查与 lint**

```bash
cd merchant-admin && npx tsc --noEmit && npm run lint
cd ../storefront && npx tsc --noEmit && npm run lint
```

预期：都通过。

⚠️ **若 `tsc` 报 session 回调的类型不匹配**，按 Step 4d 的说明做适配。

- [ ] **Step 9：提交**

```bash
git add merchant-admin/src/lib/jwt-callback.ts merchant-admin/src/auth.ts merchant-admin/test/lib/jwt-callback.test.ts storefront/src/lib/jwt-callback.ts storefront/src/auth.ts storefront/test/lib/jwt-callback.test.ts
git commit -m "feat(前端): 把令牌刷新的决策逻辑抽成可测模块并补上护栏 3/5 的覆盖"
```

- [ ] **Step 10：失败注入（确认 G9 / G10 / G11 的断言不是空的）**

⚠️ **必须在提交之后做** —— 恢复时要用 `git checkout -- <文件>`，
未提交的文件会被 checkout 一起丢掉。

**注入 1**：把 `makeJwtCallback` 里 `if (!canDeliverCookie) { return token; }`
这一段删掉。

```bash
cd merchant-admin && python3 - <<'PY'
import pathlib
p = pathlib.Path('src/lib/jwt-callback.ts')
s = p.read_text()
s = s.replace("    if (!canDeliverCookie) {\n      return token;\n    }\n", "")
p.write_text(s)
PY
```

跑 `npx vitest run test/lib/jwt-callback.test.ts`。

预期：**「送不回去 cookie 时不刷新（G10）」那条挂**。

恢复：

```bash
cd merchant-admin && git checkout -- src/lib/jwt-callback.ts
```

**注入 2**：把 `shouldInvalidateSession(result)` 改成 `false`。

预期：**「刷新失败且判定为凭证失效时作废整个会话（G11）」那条挂**。

恢复同上。

**注入 3**：把 `?? ''` 改成 `as string`。

预期：**「accessToken 缺失时兜底成空串」那条挂**。

恢复同上。

⚠️ **注入 1 与注入 2 只在 merchant-admin 做** —— 两个应用的实现**逐行一致**
（Step 6 已用 `diff` 验证），一份的断言对另一份同样成立。
但**注入 3（session 兜底）也要在 storefront 做一次**：
storefront 的 `session` 回调被 RSC 页面直接用，兜底失效的后果更明显。

⚠️ **每次注入后都要记录「期望挂几条、实得挂几条」**，不能只看红绿。

- [ ] **Step 11：确认恢复并重跑全量**

```bash
git status --short
```

预期：干净（没有残留的修改）。

```bash
cd merchant-admin && npm test 2>&1 | tail -10
cd ../storefront && npm test 2>&1 | tail -10
```

预期：都全过。

```bash
cd merchant-admin && npm test 2>&1 | tail -10
cd ../storefront && npm test 2>&1 | tail -10
```

预期：都全过。

---

## Task 5：更新过期注释与 README

**Files:**
- Modify: `merchant-admin/src/lib/token-refresh.ts`
- Modify: `storefront/src/lib/token-refresh.ts`
- Modify: `README.md`

- [ ] **Step 1：更新 `token-refresh.ts` 里过期的注释**

两个文件里都有这段（**措辞略有不同**，逐字找到对应段落）：

```
 * ⚠️ **这个去重只在单进程内有效**（模块级变量）。扩副本前必须换成
 * Redis 侧的分布式锁，或让后端提供幂等刷新端点
 * （设计文档 §5.1 的 L19 / §七 遗留项 12）。
 *
 * 缓解：后端 `api/src/modules/auth/auth.service.ts` 第 250 行的
 * `isConcurrentRace` 已为**并发**竞态兜底（只拒本请求、不吊销其它设备），
 * 但**跨进程/跨标签页的「先后」竞态仍在**（L20，设计文档 §七 遗留项 13）——
 * 本阶段不解决后端，如实记为遗留项。
```

**替换成**：

```
 * ⚠️ **这个去重只在单进程内有效**（模块级变量）。扩副本前必须换成
 * Redis 侧的分布式锁。
 *
 * ⚠️ **阶段 5c 起，后端有了宽限期**（`api/src/modules/auth/auth.service.ts`
 * 的 `handleRevokedToken`）：同一枚令牌在 60 秒内被重复提交时，
 * 后端返回**同一枚**新令牌，不吊销令牌族。所以「客户端超时后重试」、
 * 「两个标签页串行抵达」、「跨副本各刷一次」这些情况
 * **不再把用户踢下线**。
 *
 * ⚠️ **但宽限期不替代本文件里的去重，也不替代 `auth.ts` 里的
 * `canDeliverCookie` 判断**：后端认得「这枚旧令牌我刚发过新令牌」，
 * 但前端**送不回**刷新结果时，轮换仍会发生，每读一次会话就把令牌
 * 往作废的方向推一步。两者是**互补**的，都必要。
```

⚠️ **两份文件的这段注释措辞要一致** —— 改完用 `diff` 验证：

```bash
diff merchant-admin/src/lib/token-refresh.ts storefront/src/lib/token-refresh.ts && echo "两份逐行一致 ✓"
```

⚠️ 如果 `diff` **本来就有输出**（改之前就有差异），那说明这两份文件**当前不是
逐行一致**的 —— 记下来（这是既有状况），并且**只保证本次改动的这段一致**。

- [ ] **Step 2：更正 README 里那条过时的警告**

`README.md` 的「测试」一节里有：

```
> ⚠️ **跑 e2e 前先停掉连着同一个 Redis 的 api**：`docker compose stop api`
> （本机手工起的 api 同样要停）。否则容器的 BullMQ worker 会抢走测试投进同一个
> 队列的任务（容器连开发库、测试连测试库），表现为 `payment.e2e-spec.ts` 的
> **假失败**。详见
> [验收记录 §一](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md)。
```

**替换成**：

```
> ✅ **跑 e2e 不需要停 api 容器**（阶段 5c 实测更正）。队列前缀隔离
> （`BULLMQ_PREFIX=bull-e2e`）与每轮清库早已实现，**容器 api 全程在跑**的情况下
> 连跑 3 轮 e2e 均 470/470 全绿。若仍遇到**随机的假失败**，
> 再 `docker compose stop api` 排除。
```

⚠️ **那段引用的阶段 3 验收记录链接要保留**（历史记录不删），
只是把「必须停」改成「不需要停，出了假失败再停」。

- [ ] **Step 3：更新 README 的测试数字与后续计划**

- 「测试」一节的后端数字改成实际值（跑完全量后填准数）
- 「后续计划」表格里加上「计划 5c | 刷新令牌宽限期（RFC 9700）—— **已完成并验收通过**」
- 顶部「当前进度」段落改成 5c

⚠️ **数字要跑完再填** —— 不要凭估计写。

- [ ] **Step 4：跑三个前端的完整验证**

```bash
cd merchant-admin && npx tsc --noEmit && npm run lint && npm run build
cd ../storefront && npx tsc --noEmit && npm run lint && npm run build
cd ../platform-admin && npx tsc --noEmit && npm run lint && npm run build
```

预期：全部通过。

⚠️ **`build` 会写 `.next`** —— 三个前端都要跑，别只跑改过的两个。

- [ ] **Step 5：提交**

```bash
git add merchant-admin/src/lib/token-refresh.ts storefront/src/lib/token-refresh.ts README.md
git commit -m "docs: 更新前端对后端宽限期的说明，并更正 README 里过时的 e2e 警告"
```

---

## Task 6：验收

**Files:**
- Create: `docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md`

- [ ] **Step 1：跑全量验证**

```bash
cd api && npm test 2>&1 | tail -15
cd api && npm run test:e2e 2>&1 | tail -15
cd api && npm run lint 2>&1 | tail -15
cd ../merchant-admin && npm test 2>&1 | tail -10 && npx tsc --noEmit && npm run lint && npm run build
cd ../storefront && npm test 2>&1 | tail -10 && npx tsc --noEmit && npm run lint && npm run build
cd ../platform-admin && npm test 2>&1 | tail -10 && npx tsc --noEmit && npm run lint && npm run build
```

⚠️ **api 的 lint 里有 2 条阶段 2 的既存 error**
（`api/test/media.e2e-spec.ts` 的 609/618，`no-unsafe-member-access`）。
那是**既有状况**，本阶段不修（外科手术式改动原则），但**要在验收记录里如实写出来**。

- [ ] **Step 2：逐条核对 11 项护栏**

对着 §0.2 的表格，把每条护栏的**测试位置与实测结果**写进验收记录。

⚠️ **每条都要写「期望什么、实到什么」**，不能只写「通过」。
例如：
- G1：期望「宽限期内重放 → 200 且 refreshToken 与第一次逐字相同」，实得「200，`refreshToken` 两次相等」
- G2：期望「超期后 → 401 且族被吊销」，实得「401；随后用轮换出来的那枚刷新 → 401」

- [ ] **Step 3：失败注入的完整记录**

把 Task 2 Step 7 与 Task 4 Step 11 的注入结果整理成表：

| 注入 | 期望挂掉 | 实际挂掉 | 结论 |
|------|---------|---------|------|
| 删掉宽限期分支 | 至少 4 条 | ? | ? |
| 删掉 `rotatedToToken: null` | **0 条** | 0 条 | ⚠️ **这条没有自动化保护**，是已知技术债 |
| 删掉 `canDeliverCookie` 判断 | G10 那条 | ? | ? |
| `shouldInvalidateSession` 改成 false | G11 那条 | ? | ? |
| `?? ''` 改成 `as string` | session 兜底那条 | ? | ? |

⚠️ **失败注入要看「期望什么、实到什么」，别只看红绿** ——
「期望 4 条实得 5 条」也是有效的观察，要写清楚。

- [ ] **Step 4：浏览器手测**

用 ego-browser 走一遍**多标签页**场景（这是宽限期最直接的受益者）：

1. 登录商家后台
2. 开第二个标签页
3. 在第一个标签页里等 accessToken 过期（或手工把 `JWT_EXPIRES_IN` 调短）
4. 观察第二个标签页**不被踢下线**

⚠️ **手测不是回归保护** —— 它只是补充，自动化覆盖在 Task 4。

⚠️ **这个手测场景有一个坑：它可能根本没触发宽限期分支**（阶段 5c 实施后的实测教训）。
两个标签页打的是**同一个** dev server 进程，而 `token-refresh.ts` 的
`inFlightRefreshes` 是**模块级变量** → 两个并发刷新会**合并成一次**后端调用，
后端只被调用 1 次 → **宽限期分支压根没走到**。
所以这个手测能证明的是「多标签页并发刷新不踢下线 + 宽限记录确实落库」，
**证明不了**「宽限期内重放返回同一枚令牌」与「不吊销全族」。
那两条要靠 e2e 的 G1 / G3 / G6 / G8。

⚠️ **本机三个前端同 host 不同端口共用 cookie**（3011 / 3016 / 3017 是同一个 host，
cookie 不按端口隔离），在一个后台登录会**覆盖**另一个的会话。手测时注意别混。

- [ ] **Step 5：写验收记录**

创建 `docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md`，八节：

1. 自动化测试结果（数字对账）
2. 容器化验证
3. 浏览器手测
4. 机制级验证（11 项护栏 + 失败注入）
5. 发现并修复的缺陷
6. 已知遗留项（**如实写**：`rotatedToToken: null` 没有自动化保护；
   `refresh_tokens` 的过期行仍无限累积；跨副本的分布式刷新锁仍未做）
7. 交付物清单
8. 下一阶段（阶段 5d 的起点）

- [ ] **Step 6：更新 README 与记忆**

- README 的「后续计划」表格与顶部进度段落
- `README.md` 的测试数字
- 记忆文件 `project_plan04_execution.md` 追加「阶段 5c」一节

- [ ] **Step 7：提交**

```bash
git add docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md README.md
git commit -m "docs: 阶段 5c 验收记录与收尾"
```

---

## 附：Task 与护栏的对应关系

| Task | 做什么 | 覆盖的护栏 |
|------|--------|-----------|
| 1 | 数据模型 + 加解密纯函数 | （基础设施，G5 的前提） |
| 2 | 后端宽限期判定 | G1、G2、G3、G4、G5、G6、G8 |
| 3 | 宽限密文的定时清理 | G7 |
| 4 | 前端决策逻辑可测 | G9、G10、G11 |
| 5 | 注释与文档 | —— |
| 6 | 验收 | 全部 11 条逐条核对 |
