# 阶段 5k「资金链路收尾」验收记录

> **设计**：`docs/superpowers/specs/2026-10-30-plan-05k-fund-closure-design.md`
> **计划**：`docs/superpowers/plans/2026-10-30-plan-05k-fund-closure.md`

---

## 一、交付范围

照抄设计 §八 的 6 件事，逐条标注完成情况：

| # | 交付内容 | 状态 | 落点文件 |
|---|---------|------|---------|
| 1 | `claimForExecution` 捕获解密异常 + `ExecutionClaim` 加 `accountError` | ✅ 已完成 | `api/src/modules/billing/payout-execution.service.ts`（`catch` 块捕获后**不抛错**，`accountError` 带回根因；`ExecutionClaim` 接口加 `accountError: string \| null`） |
| 2 | worker 的 `accountError` 分支 → `markFailed`（业务口径）+ `checkGates` 两条闸的口径统一 | ✅ 已完成 | `api/src/modules/payment/payout.worker.ts`（`if (claim.accountError)` 在 `checkGates` **之前**；`checkGates` 两条闸改为「出款金额异常，本次未打款，请联系平台核对」/「收款账号信息异常，本次未打款，请更新收款账户后重新申请」） |
| 3 | 入队失败的口径统一 + 平台端「备注」行 | ✅ 已完成 | 后端 `api/src/modules/billing/payout.service.ts:608`（`failureReason: '打款任务提交失败，系统将自动重试'`，原始异常只进日志）；前端 `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx:158`（`status === 'APPROVED' && failureReason` 时显示「备注」行） |
| 4 | 启动自检（service + `main.ts` 落点 + `billing.module.ts` 的 exports） | ✅ 已完成 | `api/src/modules/billing/payout-encryption-self-check.service.ts`（新建，**两张表都查**）；`api/src/main.ts:60`（`await app.get(PayoutEncryptionSelfCheck).check()`）；`api/src/modules/billing/billing.module.ts:101-103`（导出该 provider） |
| 5 | 商家端：`lib/payout.ts`（三字段 + `describePayoutAccount`）+ 申请页 + 详情页 + 失败模板措辞 | ✅ 已完成 | `merchant-admin/src/lib/payout.ts`（`maskedAccountNo` / `maskedSnapshotAccountNo` / `snapshotAccountName` / `snapshotBankName` + `describePayoutAccount`）；`merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx`、`.../settlements/[id]/page.tsx`、`.../settlements/page.tsx`（失败模板统一为「请联系平台确认**出款情况**」） |
| 6 | 单测 / e2e / 失败注入 / 手测 / 验收记录 + 更正 5j 验收记录 | ✅ **已完成** | 单测 ✅、e2e ✅、失败注入 ✅（见 §三）、浏览器手测 ✅（见 §四）、本验收记录 ✅；5j 验收记录 §五 第 10 条已更正（实测是停在 `APPROVED`） |

⚠️ **第 6 条的两处补测**（协调者补）：失败注入暴露出 **G2 / G4 两条测试没有牙齿**，
已补断言并**重新注入验证**（见 §3.2 与 §3.4 的「补测后」小节）。

⚠️ **实施后又做了一轮独立审查**，找出 **1 个真缺陷**（启动自检漏查出款快照表）并已修，
另补了 e2e 的前提与平台端「备注」行的测试 —— 详见 §六。

---

## 二、自动化测试

| 层 | 命令 | 结果 |
|----|------|------|
| 单测（后端） | `cd api && npm test` | 30 suites / **526** tests 全绿 |
| 单测（商家端） | `cd merchant-admin && npx vitest run` | 27 files / **397** tests 全绿 |
| 单测（平台端） | `cd platform-admin && npx vitest run` | 15 files / **368** tests 全绿 |
| e2e（全量） | `cd api && npm run test:e2e` | 34 suites / **613** tests 全绿 |

⚠️ **全量 e2e 跑完后库里的数据是测试数据** —— e2e 的 globalSetup 会先清空测试库再 seed。

⚠️ **数字比 §三 的失败注入那一节多** —— 因为**实施后的独立审查**又补了：
后端 +1（自检的「两张表都要查」单测）、平台端 +4（备注行的测试）、
e2e +1（只改坏出款快照）。见 §六。

（本节的后端 / 商家端 / 平台端三行由失败注入代理在注入全部还原后复跑核对，数字与上表一致；
e2e 一行由协调者在 Task 6 跑出，失败注入代理**未跑 e2e** —— 注入期间源码是坏的，且 e2e 会清空测试库。）

---

## 三、失败注入

做法：**逐条注入 → 只跑那一个定向 spec → 确认挂 → 还原 → `git diff --stat` 校验还原**。
⚠️ **注入期间绝对没跑全量测试**（源码是坏的，全量跑会出一堆假失败并掩盖注入效果）；
⚠️ **注入期间没跑 e2e**（会清空测试库，且会读到被注入弄坏的源码）；
⚠️ **5 条注入全部独占执行**，不与任何其它测试并发。

| # | 注入点 | 跑的测试 | 第一轮结果 | 补测后结果 |
|---|--------|---------|-----------|-----------|
| G1 | `claimForExecution` 的 `catch` 恢复成抛错 | `payout-execution.service.spec.ts` | ✅ **FAIL（1 failed / 21 passed）** | —— 本来就有牙齿 |
| G2 | 删掉 worker 的 `if (claim.accountError) {...}` 整块 | `payout-worker.spec.ts` | ❌ **PASS（18 passed / 0 failed）** | ✅ **FAIL（1 failed / 17 passed）** —— 补了日志断言 |
| G3 | 注释掉 `markFailed` 的 `tx.payoutEntry.deleteMany` | `payout-execution.service.spec.ts` | ✅ **FAIL（1 failed / 21 passed）** | —— 本来就有牙齿 |
| G4 | 自检去掉 `tenantContext.run(platformScope(), ...)` | `payout-encryption-self-check.service.spec.ts` | ❌ **PASS（4 passed / 0 failed）** | ✅ **FAIL（4 failed / 4 total）** —— 假 Prisma 复刻了作用域闸 |
| G5 | 「两处都没有可校验的行 → 静默通过」改成抛错 | `payout-encryption-self-check.service.spec.ts` | ✅ **FAIL（1 failed / 3 passed）** | —— 本来就有牙齿 |

**第一轮 3 条有牙齿（G1 / G3 / G5）、2 条没有（G2 / G4）**；
**补测后 5 条全部有牙齿** ✅ —— 详见下面逐条。

### 3.1 G1 —— 把 `claimForExecution` 的 `catch` 改成重新抛出 ✅ 符合预期

```
注入改动：api/src/modules/billing/payout-execution.service.ts 的 catch 块里临时加一行
          throw error; // ⚠️ 失败注入 G1：临时恢复成抛错
跑的测试：cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
结果：    FAIL —— 1 failed / 21 passed / 22 total
挂掉的用例名：⚠️ 快照还没加密（版本 0）→ 不抛错，accountError 带着根因
失败信息摘要：
    出款单的收款账号快照 尚未加密（版本 0），请先执行 `npm run migrate:payout-encryption` 再重试。
    抛出点：PayoutCipherService.decryptVersioned（api/src/modules/billing/payout-cipher.service.ts:68）
    调用点：api/src/modules/billing/payout-execution.service.ts:147
    断言处：api/src/modules/billing/payout-execution.service.spec.ts:212
还原：    删掉 throw error; 那一行
还原校验：git diff --stat 无输出（工作区干净）
```

⚠️ 这条测的是**「解密失败不抛错」这个语义本身** —— 抛错会让整个事务回滚，
单子停在 `APPROVED` 且 `attemptCount` 一起被撤销 → 兜底扫描把它当成「审批后入队失败」
重新入队 → **每 5 分钟无限循环**（设计 §二·2.1）。

### 3.2 G2 —— 去掉 worker 的 `accountError` 分支 ❌ **注入后测试仍然通过（这条测试没有牙齿）**

```
注入改动：api/src/modules/payment/payout.worker.ts 里 if (claim.accountError) {...} 整块临时注释掉
跑的测试：cd api && npx jest src/modules/payment/payout-worker.spec.ts
结果：    PASS —— 18 passed / 0 failed（**一条都没挂**）
还原：    把整块加回去
还原校验：git diff --stat 无输出（工作区干净）
```

**为什么挂不了（如实记录）**：

worker 的 `accountError` 分支与 `checkGates` 的「账户缺失」闸，落 `FAILED` 时写的 `reason`
**是同一个字符串** ——

- `accountError` 分支：`'收款账号信息异常，本次未打款，请更新收款账户后重新申请'`（`payout.worker.ts:135`）
- `checkGates` 的 `!claim.account` 分支：`'收款账号信息异常，本次未打款，请更新收款账户后重新申请'`（`payout.worker.ts:216`）

目标用例「⚠️ 解密失败（accountError）→ 落 FAILED，不调渠道，理由是业务口径」
（`payout-worker.spec.ts:210`）断言的是这四件事：

| 断言 | 删掉分支后是否仍成立 |
|------|--------------------|
| `provider.execute` 没被调用 | ✅ 仍成立（`account` 为 null → 闸拦下） |
| `markPaid` 没被调用 | ✅ 仍成立 |
| `markFailed` 被调用 | ✅ 仍成立 |
| `reason` 不含「尚未加密」「密钥不匹配」「migrate:payout-encryption」 | ✅ 仍成立（闸的理由本来就没有内部术语） |
| `reason` 含「本次未打款」 | ✅ 仍成立 |

→ **断言无法区分这两条路径**，所以整块删掉也照样绿。

⚠️ **该分支唯一的独有行为是「根因进日志」**（`logger.error('...收款账号快照不可用：' + claim.accountError)`，
`payout.worker.ts:130-132`）—— 全仓**没有任何测试断言这条日志**
（`收款账号快照不可用` 这个串在整个仓库里只出现在实现里）。

⚠️ **e2e 侧同样没有牙齿**：`api/test/payout-encryption.e2e-spec.ts:867`
「解密失败 → 出款单落 FAILED，明细占用被释放，兜底扫描再也捞不到它」断言的是
`status = FAILED`、`failureReason` 含「本次未打款」、渠道没收到请求、明细释放、扫描捞不到 ——
这五条在删掉分支后**全部仍然成立**（走 `checkGates` 得到同样的 `reason`、同样落 `FAILED`、
同样释放明细、同样不再被扫描捞到）。

💡 **补测（协调者已实施）**：给 worker 单测补一条断言「`accountError` 非空时，
**日志里必须出现根因**」—— 用 `jest.spyOn(Logger.prototype, 'error')` 断言它被调用
且参数含「收款账号快照不可用」与根因本身。

**补测后重新注入验证**（协调者执行）：

```
注入改动：同前（删掉 if (claim.accountError) {...} 整块）
跑的测试：cd api && npx jest src/modules/payout-worker.spec.ts
          → cd api && npx jest src/modules/payment/payout-worker.spec.ts
结果：    FAIL —— 1 failed / 17 passed / 18 total
挂掉的用例名：⚠️ 解密失败（accountError）→ 落 FAILED，不调渠道，理由是业务口径
失败信息摘要：expect(jest.spyOn(...)).toHaveBeenCalledWith(...)
              Expected: "…收款账号快照不可用…"
              Received: 0 calls
还原：    把整块加回去
还原校验：git diff --stat 只剩两个 spec 的补强改动
```

✅ **G2 现在有牙齿了。**

⚠️ **e2e 侧仍然没有牙齿**（`api/test/payout-encryption.e2e-spec.ts` 的用例 8）：
它断言的五件事在删掉分支后全部仍成立。**e2e 验的是「闭环」（落 `FAILED` + 释放明细 +
不再被扫描捞到），分支本身由单测的日志断言守住** —— 两层分工，不重复。

### 3.3 G3 —— 去掉 `markFailed` 的明细释放 ✅ 符合预期

```
注入改动：api/src/modules/billing/payout-execution.service.ts 的 markFailed 里临时注释掉
          await tx.payoutEntry.deleteMany({ where: { payoutId } });
跑的测试：cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
结果：    FAIL —— 1 failed / 21 passed / 22 total
挂掉的用例名：⚠️ 释放明细占用（否则商家重新申请撞唯一索引 → 500）
失败信息摘要：
    expect(jest.fn()).toHaveBeenCalled()
    Expected number of calls: >= 1
    Received number of calls:    0
    断言处：api/src/modules/billing/payout-execution.service.spec.ts:360
还原：    去掉注释
还原校验：git diff --stat 无输出（工作区干净）
```

### 3.4 G4 —— 自检去掉平台作用域 ❌ **单测没有牙齿；真实服务上抛的是 `TenantScopeError`**

```
注入改动：api/src/modules/billing/payout-encryption-self-check.service.ts
          await tenantContext.run(platformScope(), async () => {  →  await (async () => {
          结尾的 });  →  })();
跑的测试：cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts
结果：    PASS —— 4 passed / 0 failed（**一条都没挂**）
还原：    把作用域改回去
还原校验：git diff --stat 无输出（工作区干净）
```

⚠️ **单测为什么挂不了**：自检的**单测用的是一只假 Prisma**
（`payout-encryption-self-check.service.spec.ts:12-30` 的 `fakePrisma`），
`findFirst` 就是个 `jest.fn()`，**没有任何租户扩展** → 作用域有没有被包住，
假 Prisma 根本感知不到。

⚠️ **「实际抛的是哪种错」的实测结果**（这是本条最关键的产出）：

设计 §六·6.3 要求 G4 的断言**区分错误类型** —— 自检失效与作用域失效抛的都是错，
分不清是谁抛的；如果实施者为了「让容器能起来」把作用域错误吞掉，自检就彻底失效了。

用**真的** `TenantPrismaService`（带租户扩展）跑 `check()`，实测：

| 状态 | 实际抛的错 | 消息 |
|------|-----------|------|
| **注入态**（去掉平台作用域） | **`TenantScopeError`**（`err.name` 与 `err.constructor.name` 都是它） | **「模型 MerchantPayoutAccount 是租户作用域的，但当前请求没有租户上下文，拒绝访问」** |
| **还原态**（作用域加回去） | 不再是 `TenantScopeError` | 作用域闸放行 → 继续往下走到真实数据库连接（探针指向的库不存在 → `PrismaClientInitializationError`）→ **证明闸在还原后确实放行** |

- 抛出点：`api/src/common/tenant/tenant-prisma.service.ts:96-100` 的 `resolveScope`
  （`if (!context) throw new TenantScopeError(...)`）；
- 模型 `MerchantPayoutAccount` **在租户白名单里**（`api/src/common/tenant/tenant-models.ts:112`）；
- ⚠️ **实测确认：抛的是 `TenantScopeError`，不是「账目加密自检失败」** —— 与设计 §六·6.3 的预期一致。

> **观察手段说明**：单测看不见，所以另外用了一个**一次性探针脚本**（放在 `/tmp/g4-probe.ts`，
> **不入仓库**）：用 `npx ts-node` 直接 `new TenantPrismaService()` + `new PayoutEncryptionSelfCheck()`，
> 在**没有任何租户上下文**的情况下调 `check()`，打印 `err.name` / `err.constructor.name` / `err.message`。
> ⚠️ 该探针**不需要数据库**（`resolveScope` 在**发查询之前**就抛错了），所以没有碰库、也没有清库。

💡 **G4 的牙齿在 e2e 侧**：`api/test/payout-encryption-self-check.e2e-spec.ts` 用的是
**真的** `TenantPrismaService`（`app.get(TenantPrismaService)`），注入状态下它的 3 条用例都会挂：

| e2e 用例 | 注入后的表现 |
|---------|------------|
| 「库里没有可校验的行 → 自检通过（不抛错）」 | `resolves.toBeUndefined()` → 被 `TenantScopeError` 拒 → **挂** |
| 「⚠️ 账户的密文被改坏 → 自检抛错，且消息指明检查哪个环境变量」 | `rejects.toThrow(/账目加密自检失败/)` → 实际是 `TenantScopeError` → **挂** |
| 「⚠️ 账户的密文是空串 → 自检抛错（空串是脏数据，不是「跳过」）」 | `rejects.toThrow(/空串/)` → 实际是 `TenantScopeError` → **挂** |

⚠️ 该 e2e 文件**会改真库的唯一一行账户**，按其文件头的说明**必须独占跑**，本次未跑。

💡 **补测（协调者已实施）**：让自检单测的**假 Prisma 复刻租户扩展的作用域闸** ——
在 `fakePrisma` 的 `findFirst` 里读 `tenantContext.getStore()`，不是平台作用域就抛
`TenantScopeError`（消息与真扩展一致）。

**补测后重新注入验证**（协调者执行）：

```
注入改动：同前（去掉 tenantContext.run(platformScope(), ...)）
跑的测试：cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts
结果：    FAIL —— 4 failed / 4 total（**四条全挂**）
失败信息摘要：Rejected to value: [TenantScopeError: 模型 MerchantPayoutAccount
              是租户作用域的，但当前请求没有租户上下文，拒绝访问]
还原：    把作用域改回去
还原校验：git diff --stat 只剩两个 spec 的补强改动
```

✅ **G4 现在有牙齿了**，而且失败信息**明确是 `TenantScopeError`** ——
正是设计 §六·6.3 要求的「断言要区分错误类型」：
自检自己的错是「账目加密自检失败」，作用域的错是 `TenantScopeError`，两者分得清。

⚠️ **单测不需要连库** —— 假 Prisma 的闸是本地判断，与真扩展的行为一致。

### 3.5 G5 —— 自检无可校验行时也报错 ✅ 符合预期

```
注入改动：api/src/modules/billing/payout-encryption-self-check.service.ts
          在「两处都没有可校验的行」处临时加：
            if (!payout) {
              throw new Error('账目加密自检失败：库里没有任何可校验的行（失败注入 G5）');
            }
跑的测试：cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts
结果：    FAIL —— 1 failed / 3 passed / 4 total
挂掉的用例名：库里没有可校验的行 → 不抛错（新库不该因此起不来）
失败信息摘要：
    expect(received).resolves.toBeUndefined()
    Received promise rejected instead of resolved
    Rejected to value: [Error: 账目加密自检失败：库里没有任何可校验的行（失败注入 G5）]
    断言处：api/src/modules/billing/payout-encryption-self-check.service.spec.ts:49
还原：    把 throw 删掉
还原校验：git diff --stat 无输出（工作区干净）
```

### 3.6 注入的汇总与结论

- **5 条注入全部执行、全部还原**，每条还原后 `git diff --stat` 均无输出；
- **第一轮：3 条有牙齿**（G1 / G3 / G5），**2 条没有牙齿**（G2 / G4）；
- **补测后重新注入：5 条全部有牙齿** ✅（G2 / G4 的补测与验证见 §3.2 / §3.4）；
- ⚠️ **G2 暴露的是一个设计事实，不是实现 bug**：两条路径的 `failureReason`
  **故意是同一个字符串**（对商家是同一件事）。所以「区分这两条路径」只能靠**日志** ——
  而「根因只进日志」正是设计 §二·2.4 的核心约定，之前**没有任何测试钉住它**。
  这条补测把「根因只进日志」变成了有牙齿的断言。

---

## 四、浏览器手测

### 4.1 准备

| 项 | 值 |
|----|-----|
| API | `http://localhost:3000`（容器 `ecommerce-api`） |
| 商家端 | `http://localhost:3002`（容器 `ecommerce-merchant-admin`） |
| 平台端 | `http://localhost:3003`（容器 `ecommerce-platform-admin`） |
| 浏览器 | 本机 `ego lite`（复用已运行的实例，**未抢前台**） |

⚠️ **容器跑的是构建产物，不挂源码卷** → 手测前必须 `docker compose build` + `up -d`
重建镜像，否则测的是旧代码。

⚠️ **重建后 api 容器启动成功且 `healthy`** —— 这本身就是**启动自检在真实启动时通过**的证据
（自检在 `app.listen()` 之前跑，密钥不对的话容器根本起不来）。

**手测数据**：开发库里没有出款单，用一次性脚本直接插了 4 张（PAID / FAILED /
APPROVED+入队失败 / APPROVED+兜底救援），商家账户用的是已有的 demo 商家
（`owner@demo.platform.test` / `Demo12345!`，收款账户「张三 / 招商银行 / ****1234」）。
**手测结束后已全部删除**（`payouts` 表剩余 0 行），一次性脚本也已删除。

### 4.2 五步结果

| 步 | 内容 | 结果 |
|----|------|------|
| 1 | 商家端「申请出款」页 → 能看到「本次出款将打到…」 | ✅ 「本次出款将打到：招商银行 \*\*\*\*\*\*\*\*\*\*\*\*1234 （张三）」 |
| 2 | 商家端出款单详情页 → 能看到「收款账户（申请时）」 | ✅ 「收款账户（申请时）：招商银行 \*\*\*\*\*\*\*\*\*\*\*\*1234 （张三）」 |
| 3 | 平台端出款单详情页 → 收款账户行**仍在**（回归） | ✅ 「收款账户 / 招商银行 \*\*\*\*\*\*\*\*\*\*\*\*1234 （张三）」 |
| 4 | 商家端 `FAILED` 单 → 失败原因是业务口径 | ✅ 见下 |
| 5 | 平台端 `APPROVED` + 有 `failureReason` → 能看到「备注」行 | ✅ 见下 |

**步骤 4 的实测断言**（在页面上直接查文本）：

```json
{
  "含本次未打款": true,
  "含密钥不匹配": false,
  "含尚未加密": false,
  "含请联系平台确认出款情况": true,
  "含旧措辞_是否已到账": false
}
```

页面原文：

> 出款失败：收款账号信息异常，本次未打款，请更新收款账户后重新申请。请联系平台确认出款情况。

**步骤 5 的实测断言**：

```json
{
  "含备注行": true,
  "含入队失败业务口径": true,
  "含Redis内部消息": false
}
```

页面原文：

> 备注 / 打款任务提交失败，系统将自动重试

⚠️ **「备注」行显示的是 `failureReason` 的原文** —— 所以后端写进去的必须是业务口径。
这次恰好验到了：**入队失败时界面看到的是「打款任务提交失败，系统将自动重试」，
不是 Redis 的原始异常消息**。

### 4.3 ⚠️ 手测发现的两个问题（已修）

**① 商家端两处拼法不一致（已修）**

第一轮手测时，申请页显示「招商银行 \*\*\*\*1234（张三）」（无空格），
详情页显示「招商银行 \*\*\*\*1234 （张三）」（有空格 —— `describePayoutAccount`
用 `parts.join(' ')` 拼的）。**同一个商家在两个页面看到两种写法。**

修法：申请页改成与 `describePayoutAccount` **逐字同款**的拼法
（`[bankName, maskedAccountNo, '（' + accountName + '）'].join(' ')`），
**不改 `describePayoutAccount`** —— 它是 5j 的交付物，平台端在用。

改完重建镜像复验，两处完全一致：

```
申请页："本次出款将打到：招商银行 ************1234 （张三）"
详情页："收款账户（申请时）：招商银行 ************1234 （张三）"
```

**② 兜底扫描会改写 `failureReason`（观察，不是 bug）**

第一轮造数据时给一张 `APPROVED` + `attemptCount = 0` 的单写上了
「打款任务提交失败，系统将自动重试」，结果平台上看到的是
**「本地假出款网关未启用」** —— 兜底扫描的「`APPROVED` 救援」分支捞到了它
（`approvedAt` 很旧 + `attemptCount = 0`）→ 重新入队 → worker 执行失败 →
`scheduleRetry` **用渠道的失败原因覆盖了 `failureReason`**。

⚠️ 这**证明兜底救援在工作**（正是它当初造成 5k 要修的那个无限循环的同一机制），
不是 bug。但它说明：**`APPROVED` 状态的 `failureReason` 不是稳定字段** ——
它会被重试过程改写。平台端的「备注」行显示的是**当前**的值。

⚠️ 顺带暴露一个**既有配置问题**（与本阶段无关）：开发环境的 api 容器**没开假出款网关**
（`FAKE_PAYOUT_ENABLED` 未设），所以开发库里被审批的出款单会一直失败。
e2e 靠 `api/test/setup.ts` 设 `FAKE_PAYOUT_ENABLED=true` 规避。

**②的手测规避**：另造一张 `approvedAt` 刚过（不到「卡住 10 分钟」阈值）且
`attemptCount = 1` 的单 —— 兜底扫描捞不到它 → `failureReason` 保持稳定 →
精确验到了入队失败的业务口径。

### 4.4 手测环境清理

- 造的 4 张出款单已删除（`payouts` 表剩余 0 行）；
- 一次性造数脚本（`api/tmp-5k-*.ts`）已删除；
- 浏览器 task space 已关闭（`task.finish({ keep: [] })`），标签页已清理。

---

## 五、遗留与风险

### 5.1 本阶段引入的（照抄设计 §七·7.1）

| # | 事项 | 说明 |
|---|------|------|
| 1 | **密钥配错 → 批量出款单 `FAILED`，且不会自动恢复** | 5j 的写路径闸只查**版本号**、不查密钥 → 密钥错时申请与审批都能过，一路到打款才炸。状态机没有 `FAILED → ?` 的转换 → 修好密钥后**商家必须全部重新申请**。这是「根因只进日志」+「不做批量恢复」两个选择的叠加后果 |
| 2 | **启动自检可能让容器起不来** | 库里有脏数据（用错密钥加密过的行）时自检失败 → 容器一直起不来 → 需要人工修数据。**这是故意的**（坏数据不该带着跑） |
| 3 | **崩溃窗口，且没有自助处置入口** | 事务提交到 `markFailed` 之间进程崩溃 → 单子卡 `PROCESSING` → 只告警不自动重试 → **当前没有任何接口能把它手工改成 `FAILED`** → 只能人工直接改库 |
| 4 | **`accountError` 的根因只进日志** | 平台端界面看不到「是没迁移 / 是密钥错了 / 是版本不匹配」，运营要翻日志。✅ 这条日志**现在有测试断言了**（见 §3.2 的补测） |
| 5 | **`FAILED` 承载了两种语义** | 「渠道试满 3 次」（钱**可能**已打出去，必须人工核对）与「解密失败」（**确定没打**，可让商家重新申请）。商家端用一句通用措辞（「请联系平台确认出款情况」）覆盖两者 → 商家可能为一个确定没打钱的单打了电话。不新增状态是刻意选择，代价在此 |
| 6 | **渠道失败原因会原样透到商家屏幕** | 渠道抛出的异常原文（可能是带主机名、请求 id 的网关报错）经 `markFailed` 落进 `failureReason`，商家端在 `FAILED` 时原样渲染。⚠️ **这是 5h-2 就有的行为，不是 5k 引入的**，且设计 §二·2.4 的口径规定**只覆盖解密路径**。**刻意不修**：渠道错误对商家没什么意义，但超管要靠它排查 —— 收掉它等于把超管的排查线索也收掉。要收的话得先决定「超管看渠道原文、商家不看」怎么实现（分端口径，不是字段口径） |

### 5.2 5j 的遗留，本阶段未处理（照抄设计 §七·7.2）

| # | 事项 | 状态 |
|---|------|------|
| 1 | 商家端与平台端的「纳入笔数」来源不同 | 有意保留 |
| 2 | 缺笔的双路径重复实现 | 有用例盯住一致性，重复本身保留 |
| 3 | 迁移脚本的备份表永久留在库里 | 需人工清理 |
| 4 | 5h-1 遗留的两条概率性 e2e flaky | 与本阶段无关 |

### 5.3 本次验收新增的遗留

| # | 事项 | 状态 |
|---|------|------|
| 1 | **G2 的目标用例没有牙齿** | ✅ **已修** —— 补了「`accountError` 非空时日志必须带根因」的断言，重新注入验证已挂（§3.2） |
| 2 | **G4 的牙齿只在 e2e 侧** | ✅ **已修** —— 自检单测的假 Prisma 现在复刻租户扩展的作用域闸，重新注入验证 4 条全挂且错误类型是 `TenantScopeError`（§3.4） |
| 3 | **5j 验收记录 §五 第 10 条尚未更正** | ✅ **已更正** —— 该条写的是「出款单停在 `PROCESSING`」，实测是停在 **`APPROVED`**（`attemptCount = 0`）。已改成实测值并附上「5k 实施期更正」的标注 |
| 4 | **e2e 侧的用例 8 无法区分「解密失败分支」与「账户缺失闸」** | 有意保留 —— e2e 验的是**闭环**（落 `FAILED` + 释放明细 + 不再被扫描捞到），**分支本身由单测的日志断言守住**。两层分工，不重复 |
| 5 | **开发环境没开假出款网关** | 与本阶段无关 —— `FAKE_PAYOUT_ENABLED` 只在 `api/test/setup.ts` 里设（e2e 用）。开发库里被审批的出款单会一直失败并把 `failureReason` 写成「本地假出款网关未启用」 |
| 6 | **`APPROVED` 状态的 `failureReason` 不是稳定字段** | 兜底扫描的救援分支捞到它并重试时，`scheduleRetry` 会用渠道的失败原因覆盖它。平台端的「备注」行显示的是**当前**的值（见 §4.3·②） |
| 7 | **渠道失败原因会原样透到商家屏幕** | 见 §5.1 第 6 条 —— 5h-2 就有的行为，刻意不修 |

---

## 六、实施后的独立审查

实现做完后，又派了一个**独立审查代理**做对抗式审查（要求它读实际代码验证每个假设，
并允许它跑失败注入）。**它找出 1 个真缺陷，已修；另 3 条已处置。**

| # | 审查发现 | 处置 |
|---|---------|------|
| 1 | ⚠️ **启动自检只查账户表、查不到就不查出款快照表** —— 与设计 §五·5.2 注释「两张表都要查」不符。实测构造「账户行正常 + 全部快照密文被改坏」，自检**照样通过** | ✅ **已修** —— 删掉早退，两张表各查一行、各自校验；补单测与 e2e（见 §6.1） |
| 2 | e2e「库里没有可校验的行」那条用例的**前提在真实跑批里是假的** —— 同批跑的其他文件会留下 11 行版本 1 的账户 → 断言恒真 | ✅ **已修** —— 显式把两张表的候选行都按回版本 0（`finally` 逐行还原），并把「候选行数为 0」写成断言 |
| 3 | 平台端新增的「备注」行**没有任何自动化测试** | ✅ **已修** —— 补 4 条（见 §6.2） |
| 4 | **渠道失败路径仍把渠道原文透到商家屏幕** | ⚠️ **不修，记为遗留**（§5.1 第 6 条 / §5.3 第 7 条）—— 5h-2 就有的行为，设计 §二·2.4 的口径只覆盖解密路径 |

### 6.1 自检的「两张表都要查」—— 修复与验证

```
修复：api/src/modules/billing/payout-encryption-self-check.service.ts
      删掉账户表分支里的 return → 两张表各取一行、各自校验（哪张先失败抛哪张）
      查询条件、字段名、tryDecrypt 实现一字未动

补单测：api/src/modules/billing/payout-encryption-self-check.service.spec.ts
      「账户行能解但快照行解不开 → 也要抛错（两张表都要查，不能早退）」
      断言 rejects.toThrow(/账目加密自检失败/) 与 rejects.toThrow(/出款单收款账号快照/)

补 e2e：api/test/payout-encryption-self-check.e2e-spec.ts
      「只改坏出款快照（账户行保持正确）→ check() 必须抛错」
      造一张带坏快照的出款单 → 断言抛错 → finally 里删掉

验证（临时把 return 加回去，跑完立刻还原）：
  单测：Received promise resolved instead of rejected → 1 failed / 4 passed
  e2e：同一条失败 → 1 failed / 3 passed
  还原后：单测 5 passed、e2e 4 passed
```

⚠️ **e2e 必须改坏「所有」候选行，不能只改自己造的那一张** ——
自检的 `findFirst` **没有 `orderBy`**，取到哪一行不确定。

### 6.2 平台端「备注」行的测试

`platform-admin/test/app/payout-detail-page.test.tsx` 补 4 条：

| 用例 | 断言 |
|------|------|
| `APPROVED` + 有 `failureReason` | 显示「备注」与该文案 |
| `APPROVED` + 无 `failureReason` | 不显示「备注」 |
| `FAILED` + 有 `failureReason` | 显示「失败原因」，**不**显示「备注」（两行不能并存） |
| `APPROVED` + 业务口径的 `failureReason` | 页面**不出现** `Redis` / `ECONNREFUSED` |

⚠️ 最后一条钉住后端口径 —— 「备注」行渲染的是 `failureReason` 的**原文**，
后端若把 Redis 的原始异常消息写进去，界面就会露出内部细节。

### 6.3 审查核实过、结论是「没问题的」关键点

（记在这里，让后来人知道这些地方已经被审过）

- 解密失败被捕获后**事务真的会提交**（`attemptCount` 的自增与 `status → PROCESSING` 都留下）；
- `accountError != null` **恒蕴含** `account == null` —— 不存在「有错误但有账户」的第四态；
- **「明文当密文」不可能被当成合法值返回**（`decryptField` 失败一律抛错）；
- worker 的 `accountError` 分支在 `checkGates` **之前**、在 `provider.execute` **之前**；
- `scanStuck` 的两个分支**都捞不到**落 `FAILED` 的单 → 无限循环真的断了；
- e2e 的「`scanStuck` 捞不到」那条断言**不是恒真** —— 审查代理构造了改写前的确切状态
  （`APPROVED` + `attemptCount = 0` + `approvedAt` 一小时前），实测 `scanStuck` **确实会捞到它**；
- 部分唯一索引的 WHERE 与 `findActivePayout` 的 `notIn` **逐字一致**，都含 `FAILED`；
- 启动自检在 `app.listen()` **之前**，用错密钥实测**端口没打开**、进程退出；
- 商家端**没有泄露完整账号**（护栏 X14 成立）；
- **没有超出设计范围的改动**（无 schema 变更、无新状态、无 `FAILED → APPROVED` 转换）。
