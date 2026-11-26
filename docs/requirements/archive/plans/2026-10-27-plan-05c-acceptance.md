# 阶段 5c 验收记录

验收日期：2026-10-27
验收范围：计划 5c「刷新令牌宽限期（RFC 9700）」的 Task 1–5
（`docs/superpowers/plans/2026-10-27-plan-05c-auth-grace-period.md`）
设计文档：
[`docs/superpowers/specs/2026-10-27-plan-05c-auth-grace-period-design.md`](../specs/2026-10-27-plan-05c-auth-grace-period-design.md)
分支：`gzt/电商项目`

结论：**通过** —— 自动化测试全绿（后端 e2e **连跑 3 轮均 481/481**）；
**11 项护栏逐条核对全部通过**（每条都有「期望什么、实到什么」的实测记录，见 §四）；
**9 条失败注入逐条复验，8 条确认抓到预期挂点**，
剩下 **1 条（注入 2）在本阶段补断言后也抓到了** —— 但它的保护点是
「查库断言」而不是「响应层断言」，删掉它**不会**让任何**行为**断言变红，
这一点如实记在 §六·1；
浏览器手测**完成**（多标签页并发刷新场景端到端跑通，见 §三）——
⚠️ 但收尾时复核发现**手测没有真正触发宽限期分支**，
它证明的是「多标签页并发刷新不踢下线 + 宽限记录确实落库」，
**没有**证明「宽限期内重放返回同一枚令牌」与「不吊销全族」
（见 §三·3.3）；
实施期发现并修复了 **4 个缺陷**（见 §五）。

⚠️ **本阶段没有「有条件通过」那一档的犹豫项** —— 11 项护栏全部有实测证据，
失败注入全部复验过，手测跑通了，遗留项全部如实列出（§六）。

---

## 一、自动化测试结果（数字对账）

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端单元测试 | `cd api && npm test` | 全部通过 | **160 passed / 160 total**（8 个套件） |
| 后端 e2e（第 1 轮） | `cd api && npm run test:e2e` | 全部通过 | **481 passed / 481 total**（27 个套件），41.3s |
| 后端 e2e（第 2 轮） | 同上 | 全部通过 | **481 passed / 481 total**，41.8s |
| 后端 e2e（第 3 轮） | 同上 | 全部通过 | **481 passed / 481 total**，47.6s |
| 前端单测（merchant-admin） | `cd merchant-admin && npm test` | 全部通过 | **200 passed / 200 total**（15 个文件） |
| 前端单测（storefront） | `cd storefront && npm test` | 全部通过 | **184 passed / 184 total**（19 个文件） |
| 前端单测（platform-admin） | `cd platform-admin && npm test` | 全部通过 | **181 passed / 181 total**（7 个文件） |
| 前端类型检查 | `cd <前端> && npx tsc --noEmit` | 无错误 | 三个前端全部 exit 0 |
| 前端 lint | `cd <前端> && npm run lint` | 0 error | 三个前端全部通过 |
| 前端构建 | `cd <前端> && npm run build` | 构建成功 | 三个前端全部成功 |
| 后端 lint | `cd api && npm run lint` | 0 error | **2 error** —— 只有 `api/test/media.e2e-spec.ts` 的 `609:41` 与 `618:42`（`no-unsafe-member-access`），**阶段 2 遗留，本阶段未动**（外科手术式改动原则） |

### 1.1 数字对账：阶段 5c 新增了多少

| 项目 | 阶段 5c 之前 | 阶段 5c 之后 | 增量 |
|------|-------------|-------------|------|
| 后端单元测试 | 151（阶段 5b 记录） | **160** | **+9**（`token.util.spec.ts` 的加解密与密钥派生） |
| 后端 e2e | 470（阶段 5b 记录） | **481** | **+11** |
| merchant-admin 单测 | 191 | **200** | **+9**（`jwt-callback.test.ts`） |
| storefront 单测 | 175 | **184** | **+9**（同上） |
| platform-admin 单测 | 181 | **181** | 0（本阶段不碰平台后台） |

> ✅ **计划勘误表 #11 的「9 条」是对的**：计划散文里写的「10 条」是笔误，
> 参考测试文件里确实只有 9 个 `it`。实测增量 **+9**，与勘误表一致。

### 1.2 e2e 连跑 3 轮的实测

**api 容器全程在跑**（`ecommerce-api` 容器 healthy，未停止），
3 轮都是 481/481 全绿，**没有出现随机的假失败**。
这坐实了 README 里那句「跑 e2e 不需要停 api 容器」。

> ⚠️ 队列前缀隔离的实证：跑完 e2e 后在 Redis 里能看到两套键 ——
> `bull:auth:repeat:token-grace-cleanup:...`（容器里的生产队列）与
> `bull-e2e:auth:repeat:token-grace-cleanup:...`（e2e 的隔离队列），
> **互不干扰**。

### 1.3 后端 e2e 里新增的那 11 条

```
✓ 宽限期内再次使用已轮换的旧令牌，返回同一枚新令牌
✓ 超出宽限期后再次使用旧令牌返回 401，并连带作废整个令牌族
✓ 宽限期内重用旧令牌不牵连其它设备（G3）
✓ 宽限期不因重放而延长（G4）
✓ 宽限密文解不开时走超期分支，不返回空令牌（G5）
✓ 并发重用同一枚令牌：两个都成功且拿到同一枚（G6）
✓ 链式自愈：回退到已轮换的令牌后能再换回下一枚（G8）
✓ 登出后重放前身令牌返回 401，且不牵连其它设备（洞二）
✓ 全族吊销后重放族内已轮换的令牌返回 401（洞一）
✓ 宽限期内多次重放拿到的始终是同一枚令牌
✓ 把过期宽限记录的密文抹掉，没过期的保留（G7）
```

---

## 二、容器化验证

### 2.1 容器跑的是阶段 5c 的代码

⚠️ **验收开始时，容器里的镜像是阶段 5c 之前的旧构建**
（`Up 12 hours`，`dist/modules/auth/auth.service.js` 里 `graceExpiresAt` 出现 **0** 次）。
先 `docker compose up -d --build api` 重建，再 `prisma migrate deploy`，
之后容器里的代码才真的包含阶段 5c。

| 检查项 | 期望 | 实测 |
|--------|------|------|
| 容器 `dist` 里有宽限期代码 | `graceExpiresAt` 出现 ≥ 1 次 | **3 次** ✓ |
| 数据库有新列 | `refresh_tokens` 有 `graceExpiresAt` 与 `rotatedToToken` | 两列都在 ✓ |
| 迁移状态 | 无待应用迁移 | `No pending migrations to apply` ✓ |
| 宽限记录真的落库 | 轮换后旧行 `revokedReason=ROTATED`、密文非空、`graceExpiresAt` 非空 | 实测一行：`ROTATED / has_cipher=t / has_grace=t` ✓ |
| 定时任务已注册 | Redis 里有 `bull:auth:repeat:token-grace-cleanup` | 找到，且 `opts.repeat.every = 3600000`（1 小时）✓ |
| 清理逻辑真的能抹密文 | 显式调 `TokenGraceService.cleanup()` 后密文变 null | 造一条过期带密文的行 → 清理 → **密文在吗 = false** ✓ |
| 启动时兜底清理 | 进程重启后过期的密文被抹掉 | 脚本启动时 `onModuleInit` 的兜底清理先跑，把行抹了（显式调用因此返回「清掉 0 条」）✓ |

### 2.2 容器上的活体验证（G1）

直接对运行中的容器发请求，验证「宽限期内重放返回**同一枚**新令牌」：

```
T1                = yXAR-hiVW8NDf9nvTpwVVS7c6SWzaUyTF3ZZLR6E
重放拿到的         = yXAR-hiVW8NDf9nvTpwVVS7c6SWzaUyTF3ZZLR6E
G1 容器验证：✓ 同一枚
```

### 2.3 容器状态已复原

手测期间临时把 `JWT_EXPIRES_IN` 改成 `5s`（用一份临时的 compose 覆盖文件，
**没有改仓库里的 `infra/docker-compose.yml`**），手测结束后
`docker compose up -d --force-recreate api` 复原为 `2h` 并核实：
`docker exec ecommerce-api printenv JWT_EXPIRES_IN` → **`2h`** ✓

---

## 三、浏览器手测

### 3.1 环境

| 项 | 值 |
|----|-----|
| 浏览器 | ego lite 0.6.0.16（已常驻，未冷启动，未抢前台） |
| 任务空间 | `5c-宽限期手测-20261027`（spaceId 22），结束已 `finish({ keep: [] })` 关掉全部标签页 |
| merchant-admin dev server | `http://localhost:3016`（`npx next dev -p 3016`，手测后已停） |
| storefront dev server | `http://localhost:3011`（`npx next dev -p 3011`，手测后已停） |
| 后端 | `http://localhost:3000`（容器），`JWT_EXPIRES_IN=5s`（临时） |

> ⚠️ **accessToken 怎么让它过期**：后端默认签 2 小时寿命的 accessToken，
> 没法手测时干等。所以临时把容器的 `JWT_EXPIRES_IN` 调成 `5s`
> （`docker compose` 的 `environment` 段里写死了 `2h`，shell 里的环境变量**盖不住**它，
> 必须用一份临时的 compose 覆盖文件 `-f` 叠加）。
> 手测完已用 `--force-recreate` 复原并核实。

> ⚠️ **只手测 merchant-admin**：三个前端同 host 不同端口**共用 cookie**
> （cookie 不按端口隔离），在一个后台登录会**覆盖**另一个的会话。
> 这次只需要验证「多标签页」这一个场景，开两个后台反而会互相干扰。

### 3.2 场景：两个标签页并发刷新

⚠️ **收尾时复核**：这次手测**没有真正触发宽限期分支** ——
两个标签页命中了前端的在途去重，后端只被调用了 1 次。
下表里的实测数字都是真实的，但**它们证明的东西比原记录写的窄**，
见 §三·3.3。

**步骤**：

1. 标签页 1 登录商家后台（`manual-1793074661@example.test`），标签页 2 停在登录页
2. 等 8 秒（accessToken 的 5 秒寿命已过）
3. 清掉 `localStorage` 里的 `ecommerce.session-sync.last-refresh`
   （它有 30 秒的幂等窗口，不清的话第二个标签页会直接「skipped」）
4. **两个标签页同时**打 `/api/auth/session`（next-auth 自带的 Route Handler，
   它**能**把刷新结果写回 cookie）

**实测**：

| 观测项 | 期望 | 实测 |
|--------|------|------|
| 两个标签页的刷新响应 | 都是 200 | **`[200, 200]`** ✓ |
| 标签页 1 是否被踢下线 | 仍在登录态 | **✓ 仍登录**（页面仍有「退出登录」按钮） |
| 标签页 2 是否被踢下线 | 仍在登录态 | **✓ 仍登录** |
| 服务端有没有把令牌族吊销 | **不能**有 `REPLAY` | 库里只有 `ROTATED`，**一行 `REPLAY` 都没有** ✓ |
| 宽限记录有没有正确落库 | 旧行有密文 + 宽限截止时刻 | `ROTATED / has_cipher=t / has_grace=t` ✓ |

**第二轮**（再等 8 秒让新令牌也过期，再并发刷一次）：

| 观测项 | 期望 | 实测 |
|--------|------|------|
| 两个标签页的刷新响应 | 都是 200 | **`[200, 200]`** ✓ |
| 令牌链 | 上一枚被 `ROTATED`、新的一枚顶上 | `09659dab(ROTATED) ← 97ddaf7a(活跃)` ✓ |
| 全族有没有被吊销 | **不能**有 `REPLAY` | **库里零 `REPLAY`** ✓ |

### 3.3 手测的结论（收尾时更正：结论比原记录窄）

⚠️ **手测实际上没有触发宽限期分支** —— 这一条是收尾时的更正，
原记录把它写成了「阶段 5c 的核心价值在真实浏览器上的端到端验证」，
**夸大了**。

**为什么没触发**：两个标签页打的是**同一个** dev server 进程
（`localhost:3016`），`token-refresh.ts` 的 `inFlightRefreshes` 是
**模块级变量** → 两个并发刷新会**合并成一次**后端调用。探针实测：

```
两个标签页同时刷新同一枚 T0：
  → 命中在途去重，复用同一个 Promise
  A 状态码 = 200  B 状态码 = 200
  A 的 refreshToken === B 的 refreshToken ? true
  是否拿到新令牌（!= T0）? true
  => 后端被调用的次数：1（第二个命中了 inFlightRefreshes）
```

**手测确实证明了**：

- ✅ **多标签页并发刷新不再把用户踢下线**（端到端）
- ✅ **令牌族没有被吊销**（库里零 `REPLAY`）
- ✅ **宽限记录确实落库了**（旧行 `ROTATED` + 有密文 + 有宽限截止时刻）
  —— 这是「轮换时写了宽限记录」的证据

**手测没有证明**：

- ❌ 宽限期内重放返回**同一枚**令牌（需要第二个请求真的打到后端）
- ❌ 宽限期内**不吊销全族**（这才是阶段 5c 的核心价值）

⚠️ **而且手测验证的更接近另一道防线**：改造前的失败模式
（「服务端每次读会话都轮换令牌、浏览器拿不到新令牌」）
恰恰是由 `canDeliverCookie` 那道防线解决的 —— **阶段 5c 之前就修好了**
（阶段 4 的 `8545635`）。

**宽限期分支本身由 e2e 覆盖**：G1（宽限期内返回同一枚）、
G3（不牵连其它设备）、G6（并发重放拿到同一枚）、G8（链式自愈）。

⚠️ **手测不是回归保护**：这个场景的自动化覆盖在 Task 4
（`api/test/auth.e2e-spec.ts` 的 G3 / G6 / G8 与前端 `jwt-callback.test.ts`）。
手测只是**补充**证据。

### 3.4 手测时踩到的两个环境坑

| 坑 | 现象 | 解法 |
|----|------|------|
| **compose 的 `environment` 段写死了 `JWT_EXPIRES_IN: 2h`** | `JWT_EXPIRES_IN=5s docker compose up -d api` **不生效**（shell 的环境变量盖不住 compose 文件里的字面量） | 用一份临时的覆盖文件 `docker compose -f docker-compose.yml -f /tmp/override.yml up -d api` 叠加 |
| **`docker compose up -d` 不会「撤销」已经不存在的环境变量** | 删掉覆盖文件后重建，容器里**仍然**是 `5s` | 必须 `docker compose up -d --force-recreate api` 才能真正复原（已核实复原为 `2h`） |

---

## 四、机制级验证

### 4.1 11 项护栏逐条核对

> 每条都写「**期望什么、实到什么**」，不只写「通过」。

| 护栏 | 内容 | 测试位置 | 期望 | 实测 | 结论 |
|------|------|---------|------|------|------|
| **G1** | 宽限期内重用已轮换的旧令牌 → 200，且拿到的是**同一枚**新令牌 | `api/test/auth.e2e-spec.ts`「刷新令牌重放检测 › 宽限期内再次使用已轮换的旧令牌，返回同一枚新令牌」 | 第二次用旧令牌刷新 → HTTP **200**；响应里的 `refreshToken` 与第一次轮换出来的**逐字相同** | HTTP **200**；`body(refreshed).refreshToken === rotated`（与第一次那枚**逐字相同**）。另在**运行中的容器**上复验过（§2.2），同样是同一枚 | ✅ |
| **G2** | 超出宽限期重用旧令牌 → 401，且连带作废整个令牌族 | 同上「超出宽限期后再次使用旧令牌返回 401，并连带作废整个令牌族」 | 把 `graceExpiresAt` 改成过去时刻 → 旧令牌刷新 **401**；**随后**用轮换出来的那枚（`rotated`）刷新也必须 **401** | 旧令牌 → **401**；紧接着用 `rotated` → **401**（族确实被吊销了） | ✅ |
| **G3** | 宽限期内重用旧令牌不牵连其它设备 | `api/test/auth.e2e-spec.ts`「宽限期内重用旧令牌不牵连其它设备（G3）」 | 两台设备各登录一次；设备 A 的令牌被轮换后重放 → 200 且拿到同一枚；**设备 B 的令牌仍能刷新** → 200 | A 重放 → **200** 且 `refreshToken === rotated`；**设备 B 刷新 → 200**（未被牵连） | ✅ |
| **G4** | 宽限限期不因重放而延长（`graceExpiresAt` 不被推后） | 同上「宽限期不因重放而延长（G4）」 | 轮换后查库拿到 `graceExpiresAt`/`revokedAt` → 宽限期内再重放一次 → **再次查库**，`graceExpiresAt` **逐毫秒不变**；且 `graceExpiresAt - revokedAt` **精确等于** `REFRESH_GRACE_PERIOD_MS`（60000） | 重放后 `after.graceExpiresAt.getTime() === before.graceExpiresAt.getTime()`（**未被推后**）；差值 **精确 = 60000**（基准是 `revokedAt` 而非 `createdAt`，见勘误表 #5） | ✅ |
| **G5** | 宽限密文解不开时不得返回空令牌 —— 走超期分支（401 + 吊销全族） | 同上「宽限密文解不开时走超期分支，不返回空令牌（G5）」 | 把 `rotatedToToken` 篡改成合法长度的乱码 → 刷新 **401**；响应体里**不能**有 `refreshToken` 字段 | HTTP **401**；`expect(response.body).not.toHaveProperty('refreshToken')` **通过**（不是 200 + 空令牌） | ✅ |
| **G6** | 并发重用同一枚令牌：两个都成功，且拿到同一枚令牌，全族不被吊销 | 同上「并发重用同一枚令牌：两个都成功且拿到同一枚（G6）」 | 两个 `Promise.all` 并发刷新 → 状态码排序后 **`[200, 200]`**；两枚 `refreshToken` **相同**且都 ≠ 原令牌；**再用那枚刷新仍能成功**（族没被误吊销） | 状态码 **`[200, 200]`**；`tokens[0] === tokens[1]` 且 `tokens[0] !== token`；**再用它刷新 → 200** | ✅ |
| **G7** | 过期的宽限密文被清理任务抹掉，没过期的保留 | `api/test/token-grace.e2e-spec.ts` | 造一条过期的（`graceExpiresAt` 在过去）与一条没过期的 → 调 `cleanup()` → **过期行的密文为 null**、**宽限截止时刻保留**（审计线索）；**没过期行的密文原样保留** | `cleared >= 1`；过期行 `rotatedToToken === null` 且 `graceExpiresAt !== null`；未过期行 `rotatedToToken === 'cipher-text-placeholder'`。**另有一条「清理之后不该再有残留」**：`count(where: 密文非空 且 已过期) === 0` | ✅ |
| **G8** | 链式自愈：回退到已轮换的令牌后，能再换回下一枚 | 同上「链式自愈：回退到已轮换的令牌后能再换回下一枚（G8）」 | **走满 4 步**：① T0→T1；② T1→T2（T1 已作废）；③ 用 T0 刷新拿回 **T1**（已作废的那枚）；④ **用 T1 再刷新 → 拿回 T2** | ① `t1 ≠ t0`；② `t2 ≠ t1`；③ 拿回的**就是 `t1`**；④ **200 且拿回 `t2`**（`body(r4).refreshToken === t2`） | ✅ |
| **G9** | accessToken 过期时刷新 | `merchant-admin/test/lib/jwt-callback.test.ts`「accessToken 过期且能送回 cookie 时刷新，并把新令牌落到 token 上（G9）」 | 已过期的 accessToken + `canDeliverCookie=true` → 刷新被调用 → **新令牌落到 token 上** | `result.accessToken === 'fresh-access'`、`result.refreshToken === 'fresh-refresh'`（两个字段都被换掉） | ✅ |
| **G10** | 送不回去 cookie 时不刷新 | 同上「送不回去 cookie 时不刷新（G10）」 | 已过期的 accessToken + `canDeliverCookie=false` → **不刷新** → 两个令牌**原封不动** | `result.accessToken === token.accessToken`、`result.refreshToken === 'old-refresh'`（一个字段都没动） | ✅ |
| **G11** | 刷新失败：`invalid` → 作废会话；`network` → 保留旧令牌 | 同上「刷新失败且判定为「凭证失效」时作废整个会话（G11）」与「刷新失败但只是网络问题时保留旧令牌（G11 / L18）」 | `invalid` → **accessToken 与 refreshToken 都被清空**（`undefined`）；`network` → **两个都保留原值** | `invalid`：`result.accessToken === undefined` 且 `result.refreshToken === undefined`；`network`：`result.accessToken === token.accessToken` 且 `result.refreshToken === 'old-refresh'` | ✅ |

**11 项护栏全部有实测证据，全部通过。**

⚠️ **G11 的补充断言**（不属于 G1–G11 编号，但同批补上的）：
`session` 回调里 `token.accessToken` 为 undefined 时 → **兜底成 `''`**。
实测 `result.accessToken === ''` ✓（这一条防的是「类型断言 `as string` 在运行时原样传出 undefined」）。

### 4.2 失败注入复验（9 条）

> 每条都写「**期望什么、实到什么**」。
> ⚠️ 注入用的文件**全部是已提交状态**（`auth.service.ts` 在 `770fcf9`、
> `token-grace.service.ts` 在 `7b74fa0`、两个 `jwt-callback.ts` 在 `008b2b3`），
> 所以每次注入后都能用 `git checkout --` 安全恢复；恢复后逐次核实 `git status` 干净。

| # | 注入内容 | 期望挂掉 | 实际挂掉 | 结论 |
|---|---------|---------|---------|------|
| 1 | `handleRevokedToken` 的宽限期分支条件改 `false` | ≥ 4 | **8** | ✅ 挂点充足。挂的是：宽限期内重放同一枚（响应层）、G3、G4、G6、G8、洞二、宽限期内多次重放、并发刷新那条 —— **8 条**。<br>⚠️ **与上游记录的 6 条不一致**：上游那次跑在补断言**之前**，之后 G8、洞二、宽限期内多次重放这三条又补了断言，所以条数从 6 涨到 8。**不是回归**，是覆盖变强了。 |
| 2 | 删掉 `revokeTokenFamily` 里的 `rotatedToToken: null` | 上游记录 **0** | **1** | ✅ **本阶段已修好**（勘误表 #9 补的查库断言）。挂的是「全族吊销后重放族内已轮换的令牌返回 401（洞一）」，具体挂在 `expect(t1Row?.rotatedToToken).toBeNull()` —— 密文没被抹掉。<br>⚠️ **但要注意保护点的性质**：这条挂的是**查库断言**，不是**响应层断言**。删掉 `rotatedToToken: null` **不会**让任何「HTTP 状态码」类的断言变红 —— 行为层面看不出来，只有查库才看得见。见 §六·1。 |
| 3 | 修补 1 的 `alive` 改成 `true` | 上游记录 **2** | **单独跑：1 条**（洞二）<br>**与注入 1 叠加跑：8 条** | ✅ **单独跑有独立锁点**。只把 `alive` 改成恒真、**不关掉宽限期分支** → 挂 **1** 条，正是「登出后重放前身令牌返回 401，且不牵连其它设备（洞二）」：<br>`expected 401 "Unauthorized", got 200 "OK"`（`test/auth.e2e-spec.ts:846`）<br>`Tests: 1 failed, 45 passed, 46 total`<br>⚠️ 这说明 **`alive` 有独立的行为层锁点** —— 没有它，登出后重放前身令牌会拿到 200 + 一枚有效 accessToken，**登出的意图被撤销**。<br>⚠️ **叠加时那 8 条挂的是注入 1 的功劳**：叠加后宽限期分支整个被关掉，`alive` 代码根本没机会执行。叠加数字**不能**用来判断 `alive` 有没有锁点。 |
| 4 | 删掉 `revokeTokenFamily` 的 `OR: [{ revokedReason: ROTATED }]` | 1 | **1** | ✅ 挂在「洞一」的 `expect(t1Row?.revokedReason).toBe(REPLAY)` —— 实得 `"ROTATED"`（期望 `"REPLAY"`）。这正是勘误表 #9 补的查库断言的作用。 |
| 5 | 拒绝分支（③）改成调 `revokeTokenFamily` | 1 | **1** | ✅ 挂在「登出后重放前身令牌返回 401，且不牵连其它设备（洞二）」的**最后一步** —— 设备 B 的令牌刷新**期望 200，实得 401**。「不牵连其它设备」这条语义**有独立锁点**。 |
| 6 | 清理任务的 `lt` 反转成 `gt` | 2 | **2** | ✅ 两条都挂：「把过期宽限记录的密文抹掉，没过期的保留（G7）」的 `expect(expiredRow?.rotatedToToken).toBeNull()`（实得 `"cipher-text-placeholder"`），以及「清理之后不该再有带密文的过期记录残留」的 `expect(remaining).toBe(0)`（实得 **1**）。 |
| 7 | 前端：删掉 `if (!canDeliverCookie) return token;` | 1 | **1**（两个前端各 1） | ✅ merchant-admin 与 storefront **各挂 1 条**：G10 那条，实得 `"fresh-refresh"`（期望 `"old-refresh"`）。 |
| 8 | 前端：`shouldInvalidateSession(result)` 改 `false` | 1 | **1** | ✅ 挂在 G11 的 `invalid` 分支 —— 实得一枚**没被清空的 accessToken**（期望 `undefined`）。 |
| 9 | 前端：`?? ''` 改 `as string` | 1 | **1** | ✅ 挂在「accessToken 缺失时兜底成空串」—— 实得 `undefined`（期望 `''`）。 |

**9 条注入全部复验过。** 8 条与上游记录一致或更强；
**注入 2 从上游的「0 条挂」变成「1 条挂」** —— 这是本阶段
勘误表 #9 补的查库断言带来的**真实改进**，如实记录。

⚠️ **注入 3 的复核（收尾时补做）**：本次验收**单独**跑了注入 3
（只把 `alive` 改成恒真，**不关掉宽限期分支**），实测**挂 1 条** —— 洞二。
所以 **`alive` 有独立的行为层锁点**（详见上表）。
⚠️ 之前那句「单独跑会怎样没有单独跑、不猜」的标注**已被这次实测取代**。

⚠️ **为什么叠加时会挂 8 条**：叠加意味着宽限期分支整个被关掉（注入 1），
`alive` 那段代码**压根没机会执行**，挂的 8 条全是注入 1 的功劳。
**叠加数字不能用来判断 `alive` 有没有独立锁点** —— 上一版验收记录
正是犯了这个错，把「叠加 8 条」当成了「`alive` 没有独立锁点」的证据。

### 4.3 失败注入的复现方法

```bash
# 1. 改文件（例：注入 6）
#    api/src/modules/auth/token-grace.service.ts
#      where: { graceExpiresAt: { lt: now } }  →  { gt: now }

# 2. 跑对应的 e2e
cd api && npx jest --config test/jest-e2e.json test/token-grace.e2e-spec.ts

# 3. 恢复（目标文件必须已提交，否则会把自己的改动一起抹掉）
git checkout -- api/src/modules/auth/token-grace.service.ts
git status --short   # 必须为空
```

---

## 五、发现并修复的缺陷

本阶段实施期（Task 2–4）发现并修复了 **4 个缺陷**。
⚠️ 这 4 个**不是本次验收新发现的**（验收期间没有发现新缺陷），
而是实施期发现、当场修掉、并在本次验收中**复验**的。

另有一条**收尾时的加固**（第 5 条）—— 它不是缺陷，是把「依赖隐式不变量」
的查询改成「查询本身带条件」。

### 1. 登出后重放前身令牌能换回一枚有效的 accessToken

**现象**：用户登出之后，只要有人重放**前身令牌**（还在 60 秒宽限期内），
`handleRevokedToken` 的宽限期分支照样返回 200 + 一枚**新签发的 accessToken** ——
**登出的意图被撤销了**。

**为什么是本阶段引入的**：改造前重放前身令牌必然 401。
阶段 5c 让 `ROTATED` 的行**多了一枚可兑换的密文**，
于是一个改造前**不可利用**的既有缺口变成了可利用的漏洞。

**修法**：宽限期内放行之前，先确认**那枚新令牌本身还活着**
（查它的 `revokedReason`）。`LOGOUT` / `REPLAY` → **只 401，不吊销全族**；
`ROTATED` → **放行**（链式自愈依赖它，见 §四·G8）。

**验收复验**：`auth.e2e-spec.ts` 的「洞二」用例 —— 重放前身令牌 → 401 且
响应体不带 `accessToken`；**设备 B 仍能刷新**（这条断言有独立锁点，见 §四·4.2 注入 5）。

### 2. 全族吊销够不到已 ROTATED 的行

**现象**：`revokeTokenFamily` 的第一个 `updateMany` 的 where 是 `{ userId, revokedAt: null }` ——
只覆盖**还没被吊销**的行。已经 `ROTATED` 的行 `revokedAt` 非空，被直接跳过。
于是全族吊销之后，族内那些**已轮换**的行仍带着
`revokedReason = ROTATED` + 完整的宽限密文 + 未到期的 `graceExpiresAt` ——
重放它们照样进宽限期分支。「吊销全族」**名不副实**。

**修法**：第一个 `updateMany` 的 where 加 `OR: [{ revokedReason: ROTATED }]`。
⚠️ **`LOGOUT` 不纳入** —— 登出的令牌不该被重放路径改写成 `REPLAY`，
那会掩盖「用户主动登出」这个事实。

**验收复验**：`auth.e2e-spec.ts` 的「洞一」用例 —— 直接查库断言
`revokedReason === REPLAY` **且** `rotatedToToken === null`。
删掉 OR 分支 → 挂 1 条（注入 4）；删掉 `rotatedToToken: null` → 挂 1 条（注入 2）。

### 3. 轮换时读两次时钟

**现象**：轮换路径的 `data` 里 `revokedAt` 与 `graceExpiresAt` **各自调了一次 `new Date()`** ——
两次读之间跨过毫秒边界，差值就是 **60001** 而不是 **60000**。
e2e 断言的是**精确相等**，**实测失败率约 10%**（20 轮挂 2 轮）。

**修法**：同一次轮换只取一次时钟（事务内 `const rotateNow = new Date()`，两处复用），
与 `revokeTokenFamily` 里本来就是 `const now = new Date()` 的写法对齐。
改后连跑 10 轮 0 失败。

**验收复验**：G4 的断言 `graceExpiresAt - revokedAt === REFRESH_GRACE_PERIOD_MS`
在本次的 3 轮 e2e（每轮都跑到 G4）里**全部精确通过**。

### 4. 「清理之后不该有残留」与「宽限期放行前查目标令牌」两条断言的覆盖缺口

**现象**：两条关键行为**没有断言**：
- 「清理任务跑完，库里不该再有带密文的过期记录残留」—— 只有「至少清掉 1 条」
- 「全族吊销时把密文抹掉」—— 当时只断言了 HTTP 状态码

**后果**：删掉 `revokeTokenFamily` 的 OR 分支**不会有任何测试挂**
（响应层已被另一道防线挡住）—— 「吊销全族」语义正确性的**唯一**保证
却最容易被静默删掉。

**修法**：补了两条**查库断言**（`token-grace.e2e-spec.ts` 的「清理之后不该再有残留」、
`auth.e2e-spec.ts` 的「洞一」里的 `rotatedToToken === null`）。

**验收复验**：§四·4.2 的注入 2 —— **从上游的「0 条挂」变成「1 条挂」**；
注入 4 也是 1 条挂。

### 5. 「宽限期放行前查目标令牌」的查询只按 `tokenHash`（收尾时的加固）

**现象**：修补 1 里查目标令牌状态的 `findFirst` 只有一个条件
（`where: { tokenHash: ... }`）。`RefreshToken` 不在 `TENANT_SCOPED_MODELS` 里，
所以这是一条**全局无过滤查询**。

**当前是安全的**：宽限密文**只由服务端写**，`tokenHash` 由
`hashRefreshToken` 派生、库里有唯一约束 —— 不存在「同一枚 hash 属于两个用户」
的情况。

**但完全依赖隐式不变量** —— 一旦将来有别的写入路径绕过这些不变量
（例如从别处导入令牌、批量修数据），这条查询就会跨用户命中。

**修法**：查询的 where **显式带上 `userId`**，
把安全从「依赖隐式不变量」变成「查询本身带条件」（防御纵深）。

⚠️ **这一处加固不改变任何行为** —— `userId` 条件在正常路径下是恒真的
（目标令牌本来就是同一枚令牌的轮换产物，属同一个用户）。

**验收复验**：改完后 `auth.e2e-spec.ts` 仍 **46/46 全过**。

---

## 六、已知遗留项（诚实列出）

### 1. `rotatedToToken: null`（全族吊销时抹密文）的保护点只有「查库断言」

⚠️ **这一条要特别说明清楚**（上游的注入 2 记录是「0 条挂」，本阶段已改善但仍有边界）。

- **改善前**：删掉它 → **0 条挂**（完全没有保护）
- **改善后**（本阶段补了查库断言）：删掉它 → **1 条挂**，挂在「洞一」的
  `expect(t1Row?.rotatedToToken).toBeNull()`

**但仍然要说清楚**：这条断言是**查库断言**，不是**响应层断言**。
删掉 `rotatedToToken: null` 之后，**HTTP 响应层面看不出任何差别**
（401 仍是 401，族仍被吊销）—— 只有直接查库才能发现密文还在。
所以这条护栏的**保护强度弱于**其它几条：它是「查出来才知道漏了」，
不是「行为变了就立刻响」。

**将来怎么补**：可以加一条**响应层**的断言 ——
「全族吊销后重放族内已轮换的令牌 → 401 **且** 不带 `refreshToken` 字段」
（现在只断言了 401）。但那时也已经被「洞二」的响应层防线挡住了，
**本质上是同一个洞**。真正能区分的只有查库。**这条遗留项如实保留。**

### 2. Redis 不可达时 API 静默挂死

`app.init()` 既不 resolve 也不 reject，应用静默挂死（30 秒超时仍在阻塞）。
**既有缺陷，非本阶段引入** —— 对照实验：`RenewalService.onModuleInit` 与
`TokenGraceService.onModuleInit` **各摘一个都仍然阻塞**，两个都摘才 110ms 启动成功。
根因是 `queue.module.ts` 的 `maxRetriesPerRequest: null` + ioredis 无限重试。
K8s 里表现为 Pod 永远 `Running` 但不 Ready。**属阶段 5d 的范畴。**

### 3. `refresh_tokens` 的过期行仍无限累积

清理只**抹列**不**删行**（保留令牌族的审计线索）。
`refresh_tokens` 的行在 `expiresAt` 过期后依然留在表里。
**本阶段刻意不做**（设计文档 §4.6 明确：删行会让「令牌族」的审计线索断掉）。

### 4. 跨副本的分布式刷新锁仍未做

前端 `token-refresh.ts` 的 `inFlightRefreshes` 仍是**模块级变量**，
**只在单进程内有效**。扩副本后两个副本各刷一次 → 后端会收到两枚同样的旧令牌 ——
**宽限期让后果变轻**（拿到同一枚令牌而不是被踢），但**重复请求本身还在**。
后端侧没有分布式锁。

### 5. 宽限期判定用应用时钟，与阶段 5a 的 `databaseNow()` 约定不同

**决策 D4 刻意为之**（同一段逻辑里混用两个时钟源会造成更隐蔽的错）：
判定令牌是否在宽限期内（**秒级、决定放行与否**）一律用应用时钟；
清理任务（**批量扫描、精度要求小时级**）用数据库时钟。
**代价**：多副本时钟偏差会让宽限期长度有**秒级**浮动。

#### 5.1 两个时钟源混用有一个具体后果：边界上「提前进超期分支」→ 吊销全族

`token-grace.service.ts` 的 `cleanup()` 用 `databaseNow()`（**数据库时钟**），
`auth.service.ts` 的宽限期放行判定用 `new Date()`（**应用时钟**）。
数据库时钟比应用时钟快 Δ ms 时，存在宽度 Δ 的窗口，该行
**既被 cleanup 抹掉密文、又被应用判为「仍在宽限期内」** →
`restored = null` → 落到第 ④ 档 → **吊销整个令牌族**（不是温和的 401）。

⚠️ **这条路径已被实测确认**（探针在测试库上跑出了 `rotatedToToken: null`
+ `graceExpiresAt` 未过期的行）。

**当前缓解**：本机时钟偏差 0ms；生产上 NTP 同步下偏差通常 <100ms。

⚠️ **不是安全问题** —— 「提前进超期分支」= **更严格**，不是更宽松
（宁可吊销全族，也不放行）。但它**不是**温和的 401，而是吊销全族，
对其它设备有影响，所以值得记下来。

### 6. 前端 `jwt-callback.ts` 原地修改 `token` 对象

`token.accessToken = ...` 是**原地修改**。现有 9 条用例无法区分
「原地修改」与「返回新对象」—— 两种实现都能让测试全绿。
将来若改成不可变处理（返回新对象），测试照样全绿。**现有断言不够。**

### 7. 将来加「改密码」功能时，必须同时吊销令牌族

本项目**当前没有改密码端点** —— `passwordHash` 只在注册时写，
全局搜不到任何改密逻辑。所以「改密码后旧令牌应失效」这条
**既没实现、也没被列为遗留项**（本次收尾时补记）。

⚠️ 将来加这个功能时**容易漏掉**令牌族的吊销 ——
而漏掉的后果是「改了密码，泄漏的刷新令牌仍能换到新 accessToken」。
改密端点落地时，应当在同一处调用 `revokeTokenFamily`
（或等价的「吊销该用户全部刷新令牌」）。

### 8. `merchant-admin` 仍没有 jsdom 组件测试基建

**阶段 4 遗留**，5c 只把决策逻辑变成可测（纯模块，node 环境就能测）。
组件级测试仍需在 `merchant-admin` 上补 `vitest.config.ts` + `test/setup.ts`。
**属阶段 5d 的范畴。**

---

## 七、交付物清单

### 后端（`api/`）

| 文件 | 改动 |
|------|------|
| `prisma/schema.prisma` | `RefreshToken` 加两列：`rotatedToToken`（密文）、`graceExpiresAt` |
| `prisma/migrations/20261027102207_add_refresh_token_grace/migration.sql` | 加两列的迁移 |
| `src/modules/auth/token.util.ts` | **新增** `deriveGraceKey`（HKDF-SHA256 从 `JWT_SECRET` 派生）、`encryptToken` / `decryptToken`（AES-256-GCM）、`REFRESH_GRACE_PERIOD_MS = 60_000` |
| `src/modules/auth/token.util.spec.ts` | **新增** 加解密与密钥派生的单元测试（9 条） |
| `src/modules/auth/auth.service.ts` | 宽限期判定（`handleRevokedToken` 的第 ② 档）、`isConcurrentRace` 删除、`issueTokens` 拆分、**轮换只取一次时钟**、`revokeTokenFamily` 覆盖 ROTATED 行、**放行前的目标令牌查询带上 `userId`**（§五·5） |
| `src/modules/auth/token-grace.service.ts` | **新增** 宽限密文的清理 + 周期任务注册 + 启动时兜底 |
| `src/modules/auth/token-grace.worker.ts` | **新增** 清理任务的消费端 |
| `src/modules/auth/auth.module.ts` | 装配 `TokenGraceService` / `TokenGraceWorker` |
| `src/common/queue/queue.constants.ts` | **新增** `AUTH_QUEUE = 'auth'` |
| `src/common/queue/queue.module.ts` | 注册新队列 |
| `src/modules/queue/queue.service.ts` | `QueueName` 联合类型加一项 + 构造函数注入 |
| `test/auth.e2e-spec.ts` | 改 1 组 + 新增 1 组（宽限期）+ 2 条（洞一 / 洞二） |
| `test/token-grace.e2e-spec.ts` | **新增** 清理任务的 e2e（2 条） |

### 前端（`storefront/` + `merchant-admin/`）

| 文件 | 改动 |
|------|------|
| `src/lib/jwt-callback.ts` | **新增**（两份副本，逐行一致）—— 决策逻辑抽成纯模块 |
| `src/auth.ts` | 改为引用 `jwt-callback.ts`（两份副本） |
| `test/lib/jwt-callback.test.ts` | **新增** 9 条用例（两份副本） |
| `src/lib/token-refresh.ts` | 更新过期注释（「后端没有宽限期」那段已不成立）（两份副本） |

### 文档

| 文件 | 说明 |
|------|------|
| `docs/superpowers/specs/2026-10-27-plan-05c-auth-grace-period-design.md` | 设计文档 |
| `docs/superpowers/plans/2026-10-27-plan-05c-auth-grace-period.md` | 实施计划（含 12 条勘误表） |
| `docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md` | **本文件** |
| `README.md` | 更正 e2e 警告、更新测试数字、后续计划表 |

---

## 八、下一阶段（阶段 5d 的起点）

### 8.1 阶段 5d 接手什么

**前端技术债**（设计文档 §一、§十）：

- 主题链路：字体 token 服务端失效、分组标量接上消费者、商家后台实时预览
- 前台错误处理统一（`fetch failed` 泄漏、购物车误报为空）
- `merchant-admin` 的 **jsdom 组件测试基建**（§六·8）
- storefront RSC 首次加载的 `Unauthorized` 闪烁

**计费遗留项**（阶段 5b 的遗留）：

- 抽佣流水明细（报表分项）
- M11 的可观测性
- 换套餐的周期长度语义

**本阶段遗留项**（§六，**逐条对应**）：

| §六 条目 | 内容 | 5d 要不要做 |
|----------|------|------------|
| §六·1 | `rotatedToToken: null`（全族吊销时抹密文）的保护点只有「查库断言」，不是响应层断言 | 可选（加响应层断言的收益见该条分析） |
| §六·2 | Redis 不可达时 API 静默挂死 | **要**（属 5d 的范畴） |
| §六·3 | `refresh_tokens` 的过期行仍无限累积 | 暂不做（刻意保留审计线索） |
| §六·4 | 跨副本的分布式刷新锁 | **要**（扩副本前**必须**做） |
| §六·5 | 宽限期判定用应用时钟，与 `databaseNow()` 约定不同（多副本时钟偏差 → 宽限期长度有秒级浮动；且 §六·5.1 记了「边界上提前进超期分支 → 吊销全族」这个具体后果） | **要**（扩副本前确认 60 秒窗口够用） |
| §六·6 | 前端 `jwt-callback.ts` 原地修改 `token` 对象，现有断言无法区分「原地修改」与「返回新对象」 | 建议做（改成不可变处理时补断言） |
| §六·7 | 将来加「改密码」功能时，**必须同时吊销令牌族**（当前没有改密端点） | 将来加改密功能时做 |
| §六·8 | `merchant-admin` 仍没有 jsdom 组件测试基建 | **要**（属 5d 的范畴） |

⚠️ **§六·7 之前的版本是「`alive` 判断缺少独立的行为层锁点」** ——
那条结论**已被推翻**：单独跑注入 3（只把 `alive` 改成恒真）实测**挂 1 条**
（洞二），证明 `alive` **有**独立的行为层锁点。见 §四·4.2。
`alive` 那条查询的「只按 tokenHash」问题**不是遗留项** ——
收尾时已加固（查询改为 `tokenHash` + `userId`），见 §五·5。

### 8.2 阶段 5c 留给 5d 的一句话

> 宽限期让后端**认得**「这枚旧令牌我刚发过新令牌」，
> 但前端**送不回**刷新结果时，轮换仍会发生 —— 两者**互补**，都必要。

⚠️ **不要把宽限期当成「前端不用管了」的借口**：
`merchant-admin/src/auth.ts` 里的 `canDeliverCookie` 判断与
`token-refresh.ts` 里的在途去重**仍然必须保留**。
删掉它们，后端就会每读一次会话就把令牌往作废的方向推一步 ——
**那正是阶段 4 修掉的「开第二个标签页就被踢」**。
这两条前端防线各有**独立的失败注入证据**（注入 7 挂 1 条）。

### 8.3 扩副本之前必须先做的三件事

1. **分布式刷新锁**（§六·4）—— 前后端两侧都要
2. **`inFlightRefreshes` 换成 Redis 侧的锁** —— 它现在是模块级变量，只在单进程内有效
3. **宽限期长度对时钟偏差的容忍**（§六·5、§六·5.1）—— 多副本时钟偏差会让宽限期有秒级浮动，
   60 秒的窗口要确认够用；⚠️ 偏差的具体后果是「边界上提前进超期分支 → 吊销全族」
   （不是温和的 401），见 §六·5.1
