# 阶段 5m「渠道对账」验收记录

> **设计**：`docs/superpowers/specs/2026-10-31-plan-05m-payout-reconciliation-design.md`
> **计划**：`docs/superpowers/plans/2026-10-31-plan-05m-payout-reconciliation.md`

---

## 一、交付范围

计划的 11 个 Task 逐条标注：

| # | Task | 状态 | 落点 |
|---|------|------|------|
| 1 | schema + 迁移（5 个枚举、2 个加值、2 个加列、2 张新表、3 个索引） | ✅ | `api/prisma/schema.prisma`、`api/prisma/migrations/20261031100000_add_payout_reconciliation/`、`20261031110000_payout_reconciliation_indexes/` |
| 2 | 渠道接口扩展 + 假网关「如实记录」 | ✅ | `api/src/common/payment/payout-provider.interface.ts`、`fake-payout.provider.ts` |
| 3 | 前置修复（`markFailed` 记 `releasedEntryIds` / `markPaid` 清失败痕迹 / `unstick` 加核实闸） | ✅ | `api/src/modules/billing/payout-execution.service.ts`、`api/src/modules/billing/payout.service.ts` |
| 4 | 比对引擎（纯函数，A–F 六类 + g 档） | ✅ | `api/src/modules/payment/payout-reconcile.engine.ts` |
| 5 | 契约下沉 + 核实服务（三层核实） | ✅ | `api/src/common/payment/payout-verification*.ts`、`payout-providers.module.ts` |
| 6 | 差异处置（A 类自动纠正 + B 类人工四道闸） | ✅ | `api/src/modules/payment/payout-reconciliation-resolver.service.ts`、`api/src/modules/billing/payout-execution.service.ts` |
| 7 | 解卡重打的前置闸 | ✅ | `api/src/modules/billing/payout.service.ts` 的 `unstick` |
| 8 | 对账服务 + API + 定时任务 | ✅ | `api/src/modules/payment/payout-reconciliation.service.ts`、`platform-payout-reconciliation.controller.ts`、`payout-reconcile.scheduler.ts`、`payout.worker.ts` |
| 9 | CSV 账单导入 | ✅ | `api/src/modules/payment/payout-reconciliation-csv.ts`、`dto/payout-reconciliation-import.dto.ts` |
| 10 | 平台端界面 | ✅ | `platform-admin/src/app/(dashboard)/reconciliations/**`、`src/lib/reconciliation.ts` |
| 11 | 验收（本文件） | ✅ | 见 §二 / §三 / §四 |

### 1.1 实施期偏离计划的 9 处

| # | 计划写的 | 实际改成 | 为什么 |
|---|---------|---------|-------|
| 1 | `FakePayoutProvider.recordAttempt` 要调用方传 `executedAt` | `Omit<…, 'executedAt'>` + 内部盖戳 | ⚠️ **计划有真缺陷**：必填字段两处调用点都没传 → `listPayouts` 直接抛 TypeError |
| 2 | NestJS 的 `metaclass` | `metadata.metatype` | ⚠️ **计划有真缺陷**：`@nestjs/common` 里字段名是 `metatype` |
| 3 | `import { PAYOUT_VERIFICATION, PayoutVerification }` | 拆成值导入 + `import type` | ⚠️ **计划有真缺陷**：`isolatedModules` + `emitDecoratorMetadata` 下，接口用在带 `@Inject` 的构造器参数上会报 TS1272 |
| 4 | 比对引擎的分组函数 `groupChannelRecords` | 删除死代码，抽出 `sortChannelRecords` | ⚠️ **计划有真缺陷（最严重）**：`reconcile` 自己重建了**未排序**的 Map，`groupChannelRecords` 从未被调用 → **排序从未执行**。后果：同一份账单换个行序，C 类（CRITICAL）告警会变成「匹配一致」；CSV 不配 `paidAt` 列时权威记录 100% 由数组顺序决定 |
| 5 | 对账端点挂 `/platform/payouts/...` | 挪到 `/platform/payout-reconciliations/...` | ⚠️ **计划有真缺陷**：billing 那边有 `@Get('payouts/:id')` 且**先注册** → `reconciliations` 与 `reconciliation-summary` 被 `:id` 抢先匹配 → `ParseUUIDPipe` 直接 400 → **列表与统计端点 100% 不可达，且不报任何错** |
| 6 | CSV 的「状态」列选填，不配默认 `SUCCESS` | **状态列与状态值映射都必填** | ⚠️ **计划有真缺陷**：不配状态列 → 所有流水被当成「渠道已打款成功」→ 本地还卡在处理中的单被判成 A 类 → **自动改成已付款**。引擎只认精确的 `SUCCESS` 才判 A 类，所以改成必填 |
| 7 | CSV 解析不出来的行静默跳过 | 报告跳过的行数与行号 | 对账结论是**基于剩下的行**算的，运营不知道跳了几行 → 看到「差异数 0」就以为钱没问题 |
| 8 | 「不配时间列」的提示看**有没有配列** | 看**实际解析出了几个时刻** | 配了列但整列是空值，后果与不配列完全一样（D 类检不出来），而差异数仍是 0 |
| 9 | Task 10 的 Step 1–7 | 补了「立即对账」与 CSV 导入两个入口 | ⚠️ **计划漏了**：后端一直有手动触发与 CSV 导入的端点，界面上却没有入口 → 定时对账每天只跑一次，运营临时发现问题只能干等；真渠道没有批量查单接口，CSV 导入是它唯一的对账途径。验收清单的第 2、8 步明确要这两个入口 |

### 1.2 有意多做的一处

**对账的差异项按 `(payoutId, type)` 去重时只标 `PENDING` 的历史项为 `IGNORED`，历史行保留** ——
审计时要能看到「这个问题被对账发现过几次」。若直接删，未处置数会单调增长 → 运营要反复处理同一个问题。

---

## 二、自动化测试

| 层 | 命令 | 结果 |
|----|------|------|
| 单测（后端） | `cd api && npx jest --passWithNoTests` | 32 suites / **628** tests 全绿 |
| e2e（后端全量，串行） | `cd api && npx jest --config test/jest-e2e.json --runInBand` | 39 suites / **646** tests 全绿 |
| 单测（平台端） | `cd platform-admin && npm test` | 16 files / **395** tests 全绿 |
| 类型检查 | `cd api && npx tsc --noEmit` / `cd platform-admin && npx tsc --noEmit` | 均无输出 |
| 定向 lint | 见下 | 无输出 |

⚠️ **e2e 必须串行跑**（`--runInBand`）—— 本仓的 e2e 共享同一个测试库与 Redis 队列，并行跑会互相干扰。

⚠️ **定向 lint，不跑全量** —— 后端有 9 处**既有**的 prettier 报错（`payout-manual-action.dto.ts` 1 处、`settlement.service.spec.ts` 6 处、`payout-worker.spec.ts` 1 处、`settlement.e2e-spec.ts` 1 处，都与本阶段无关）。跑全量会让人去「顺手修」无关文件。

⚠️ **验收时发现本阶段新建的 39 处 prettier 报错**（全在新建文件里）→ 规格要求「新建文件必须零错误」→ 已用 `eslint --fix` 清零（提交 `642c797`）。

### 2.1 新增的测试

| 文件 | 覆盖 |
|------|------|
| `api/src/modules/payment/payout-reconcile.engine.spec.ts` | A–F 六类分类、权威记录选取、排序确定性、金额符号 |
| `api/src/common/payment/payout-verification.service.spec.ts` | 三层核实、渠道抛错降级、查不到 → UNKNOWN |
| `api/src/common/payment/fake-payout.provider.spec.ts` | `queryPayout` 查不到 → UNKNOWN、`listPayouts` 窗口与顺序 |
| `api/src/modules/billing/payout-execution.service.spec.ts` | 四道闸（+9 条）、`markPaid` 清失败痕迹 |
| `api/src/modules/payment/payout.worker.spec.ts` | `'reconcile'` job 分支 |
| `api/test/payout-reconciliation.e2e-spec.ts` | A 类自动纠正 + B 类四道闸 |
| `api/test/payout-unstick-gate.e2e-spec.ts` | 解卡闸拒绝时**一个字节都不改** |
| `api/test/payout-reconciliation-service.e2e-spec.ts` | 六类差异分类 + 端点可达性 + 非法处置结果被拒 |
| `api/test/payout-reconciliation-import.e2e-spec.ts` | CSV 导入 + 三个静默失败（状态列必填、跳过行要报告、提示看实际时刻） |
| `platform-admin/test/components/import-csv-form.test.tsx` | CSV 导入表单 |

### 2.2 e2e 文件之间的隔离（实施期发现并修）

**三个对账 e2e 文件共享同一个测试库**（`globalSetup` 每轮只清库一次，文件之间不再清理）→ 前一个文件留下的出款单会进后一个文件的**对账结果**（本地 `PAID` + 渠道查无此笔 → 多出一条 E 类差异）→ 「六类差异」那条用例从「恰好六类」变成「七类」而红。

→ 在 `api/test/payout-fixture.ts` 加 `resetPayoutData()`，三个对账 spec 各自在 `beforeAll` 清干净。

---

## 三、失败注入（逐条验护栏）

| # | 注入什么 | 注入前 | 注入后 | 还原后 |
|---|---------|--------|--------|--------|
| 1 | `payout-reconcile.engine.ts:208` A 档判定 `=== PROCESSING` → `!== FAILED` | 引擎单测 24/24 绿 | **红**：9 条变红（C 类两条实得 `CHANNEL_PENDING_LOCAL`、「匹配一致」实得 1 条差异、`APPROVED/CANCELLED/REJECTED` 三条产出假 A 类） | 24/24 绿 |
| 2 | 同文件 `pickAuthoritative():65`「优先取 SUCCESS」永不生效 | 24/24 绿 | **红**：「SUCCESS 那条 paidAt 更早 → 仍必须取 SUCCESS」实得 0 条差异（A 类告警整条消失） | 24/24 绿 |
| 3 | `payout.service.ts:1037,1047` `unstick()` 的核实闸两个分支改成 `false &&` | 解卡闸 e2e 3/3 绿 | **红**：2 条变红（409 → 200，解卡被放行 = 确定性重复打款） | 3/3 绿 |
| 4 | `payout-verification.service.ts:150` 渠道抛错从「降级为 UNKNOWN」改成「判定为 FAILED」 | 10/10 绿 | **红**：「渠道抛错 → 降级查对账结果」实得 `FAILED` | 10/10 绿 |
| 5 | `payout-execution.service.ts:319` `markFailed()` 写 `releasedEntryIds` 改成 `false &&` | 单测 34/34 + e2e 24/24 绿 | **红**：2 条变红（`releasedEntryIds` 实得 `undefined` / `null`） | 34/34 + 24/24 绿 |
| 6 | 同文件 `:237` `markPaid()` 的 `failedAt: null` 删掉 | 全绿 | 🟢 **没红** —— 见 §五·1 | 还原后 diff 为空 |
| 7 | `fake-payout.provider.ts:233` 查不到时从 `UNKNOWN` 改成 `SUCCESS` | 18/18 绿 | **红**：「查不到 → UNKNOWN」实得 `SUCCESS` | 18/18 绿 |
| 8 | `payout-reconciliation-csv.ts:303` 金额单位换算恒 `Math.round(value)` | CSV e2e 7/7 绿 | **红**：`channelAmount` 实得 `85`（应为 `8500`，差 100 倍） | 7/7 绿 |

**8 条里 7 条被测试咬住。** 全部还原后：全量单测 628/628、全量 e2e 646/646、`tsc` 无输出、`git status` 干净。

### 3.1 三处「注入有效但红的不是预期那条用例」

不是护栏没牙齿，是打中的邻居：

- **第 1 条**：B 类用例（`渠道 SUCCESS + 本地 FAILED`）**仍绿** —— `FAILED !== FAILED` 为假，它仍落进 B 档分支。真正被咬住的是 C 类与「本地非终态不算差异」。
- **第 2 条**：引擎里有**两条**「一单多流水」用例，但「先失败后成功 → 取 SUCCESS 那条」里 SUCCESS 恰好也是最晚的 → 「优先 SUCCESS」与「取最晚」结论相同 → 改坏了也不红。**只有**「SUCCESS 更早 → 仍必须取 SUCCESS」那条能咬住（这也正是那条用例注释里写明的设计意图）。
- **第 5 条**：B 类 e2e 的「闸 ① 过不了」那条仍绿 —— 它测的是**反向路径**（人工造 `releasedEntryIds` 为空的单 → 期望闸 ① 拒绝），而注入删的是**写入**动作。真正咬住的是单测与 Task 3 新加的那条 e2e。

---

## 四、浏览器手测

⚠️ **手测必须用开发模式跑 api** —— compose 的 api 跑在 `NODE_ENV: production` → ① 假网关默认不可用；② `assertSecureConfig` 会拒绝启动。做法与 5h-2 的验收记录一致：临时给 `infra/docker-compose.yml` 的 api 服务加 `NODE_ENV: development` + `FAKE_PAYOUT_ENABLED: 'true'` → `docker compose up -d --build api platform-admin` → **手测完 `git checkout -- infra/docker-compose.yml` 还原**（已还原，`NODE_ENV: production` 已确认）。

⚠️ **浏览器用本地 `ego lite`** —— 先 `pgrep -f "ego lite"` 检查，已在运行（PID 708/882/1027）→ 直接复用，**没有 `open`**（会把窗口抢到前台）。结束前关闭了 Agent 建的标签页。

### 4.1 造数（先说明，因为两条差异都要靠它）

假网关的渠道流水存在**进程内存**里（`attemptsByReferenceNo`）→ **容器一重启，记录就没了**（第一次手测就踩到：重建容器后渠道流水是 0）。所以：

1. 造一张 `APPROVED` 的出款单（用开发库里现成的、`encryptionVersion = 1` 的收款账户快照）；
2. 把 `approvedAt` 改旧 1 小时 → 兜底扫描（5 分钟一轮）的条件是 `status = APPROVED AND approvedAt < now − 10min AND attemptCount = 0` → 自动重新入队 → worker 打款成功 → **渠道内存里有流水了**；
3. 之后**不重启容器**，用 psql 改本地状态来造差异。

| # | 步骤 | 预期 | 实际 |
|---|------|------|------|
| 1 | 打开平台端「渠道对账」页 | 任务列表正常渲染 | ✅ 渲染出「对账任务」表格（渠道/来源/时间窗/状态/本地单/渠道流水/一致/差异 八列），导航里出现「渠道对账」一项 |
| 2 | 点「立即对账」→ 选渠道 + 时间窗 | 同步执行完，列表多一条任务，状态「已完成」 | ✅ 点按钮 → 依次弹出「渠道名」「时间窗终点」「时间窗起点」三个输入框（默认值已填好）→ 提交后列表多出一条 `2026/10/2 ~ 2026/11/2`、`已完成`、`本地单 1` 的任务 |
| 3 | 点进任务详情 | 差异列表按严重级排序，严重的置顶 | ✅ CSV 导入那条任务的两条 D 类都显示「严重」，文案「渠道有一笔打款，我们系统里没有对应的出款单」，渠道侧 `SUCCESS / ¥99.00 / 2026/11/1 10:00:00`、本地侧 `—` |
| 4 | 对一条差异点「标记已处置」 | 提示原因 → 提交 → 刷新后状态变「已处置」 | ✅ 弹输入框收原因 → 提交后该行「处置」列变「已处置」，且**两个操作按钮消失**（已处置的不能再改） |
| 5 | 对一条 B 类差异点「确认已付款」 | 若四道闸挡住 → 显示业务错误 | ✅ B 类差异显示「警告 / 渠道已打款，本地记成了失败」，点「确认已付款」→ 页面红字「操作失败：这张出款单的明细无法复原（没有记录被释放的流水），需人工处理」→ **闸 ① 正确挡住**（这笔单是 psql 手工造的，没有 `releasedEntryIds`） |
| 6 | 打开「出款」页 | 顶部有严重差异横幅 + 「去查看」链接可点 | ✅ 横幅显示「有 1 条严重的渠道对账差异尚未处置（0 条警告、0 条提示）。去查看」，链接指向 `/reconciliations` |
| 7 | 悬停/点击「渠道已打款，本地还卡在打款中」的差异 → 对应出款单 | 出款详情页的操作记录里能看到 `RECONCILE_TO_PAID` 留痕 | ✅ psql 把本地改成 `PROCESSING`（渠道已有流水）后触发对账 → 差异 1 条 → **本地单自动从 PROCESSING 改回 PAID** → 详情页操作记录显示「2026/11/1 14:38:36 · system:reconciliation · 渠道对账自动纠正为已付款 · 渠道对账：渠道确认已打款，本地纠正为已付款（渠道流水号 fake-pay-4ceac0c9-…）」 |
| 8 | 上传一份 CSV 账单 | 列映射表单 → 上传 → 生成一条「账单文件」来源的任务 | ✅ 打开 `/reconciliations/import` → 选文件 + 填列映射（金额单位选「分」、状态值映射「成功 → 渠道已打款成功」、打款时间列填「打款时间」）→ 点「导入并对账」→ 结果显示「已生成一条「账单文件」来源的对账任务：差异 2 条、一致 0 条」+ 明细链接 |

### 4.2 手测后

- 手测数据已从开发库清掉（`payouts` / `payout_reconciliations` / `payout_reconciliation_items` / `payout_operations` 里手测造的都删了）
- `infra/docker-compose.yml` 已还原（`NODE_ENV: production`）
- api 容器已用还原后的 compose 重建

---

## 五、验收中发现并修掉的问题

### 1. 🔴 `markPaid()` 的 `failedAt: null` 没有任何测试咬住

**发现方式**：失败注入第 6 条 —— 删掉那行，**全量 627 条单测 + 646 条 e2e 全绿**。

**后果**：`failedAt` 记的是「落 FAILED 那一刻」的判断。残留着它，一张**已经 `PAID`** 的单会被对账引擎按 `failedAt` 再次捞进**另一个**时间窗（引擎按 `paidAt` / `processingAt` / `failedAt` 三个时间戳捞本地单）→ 造出假差异，或让 E 类（本地已付、渠道查不到）的口径判错。

**修法**：补一条单测断言 `failedAt` 被清成 `null`、`failedBeforePayout` 被清成 `false`，并用变异验证（把 `failedAt: null` 删掉 → 该用例立刻红）。提交 `34881bb`。

### 2. 🔴 超时后后台仍在跑，会把 `FAILED` 覆盖回 `COMPLETED`

**发现方式**：代码质量审查。

`withTimeout` 是 `Promise.race`，**不取消**底层操作。落终态的两处（`run()` 落 `COMPLETED`、`trigger()` 的 catch 落 `FAILED`）都没加守卫 → 超时落 `FAILED` 后，后台的 `run()` 又把它改回 `COMPLETED` → `runScheduled` 的幂等检查只查 `COMPLETED` → **那个窗口永远不会再被对账**，那批出款单的差异静默丢失。

**修法**：两边都改成「只认 `RUNNING`」，先落终态的赢；且没落成 `COMPLETED` 就不做 A 类纠正（否则出现「任务说失败、单子说已付」两边对不上）。提交 `59a0731`。

### 3. 🔴 人工确认已付款的四道闸有三个洞

**发现方式**：代码质量审查。

| 洞 | 后果 |
|---|---|
| 闸 ④ 的核实对象可由调用方替换（`input.payoutNo ?? payout.payoutNo`） | 传别的单的号就能核实别的单 → 渠道说「那单打了」→ 放行 → **这张单被改成已付款 → 重复付款** |
| 破护栏 X6（补差单也会把结算单改成 `PAID`） | 补差单的账务口径被破坏 |
| 事务内的条件更新不查 `affected.count` | 状态静默不生效，但留痕会说「从 FAILED 改到 PAID」→ **留痕是说谎**，而留痕是事后追责的唯一凭据 |
| 跨租户读缺 `tenantId`（`merchantReceipt` / `settlementStatement`） | 本方法跑在平台作用域，租户扩展**不附加任何过滤** → 闸 ④ 的两个数据源会读到别家的数据 |

**修法**：核实对象与结算单一律从库里读到的 `payout` 取（那两个字段已从签名删除）；补差单不联动结算单；`count === 0` 就回滚；两处读都补 `tenantId`。提交 `771b33c`。

### 4. 🔴 CSV 导入的三个静默失败

**发现方式**：实施代理自查 + 代码质量审查。

| 问题 | 后果 |
|---|---|
| 不配状态列 → 默认当成 `SUCCESS` | 所有流水被当成「渠道已打款成功」→ 本地卡在处理中的单被判成 A 类 → **自动改成已付款** |
| 状态值映射缺失 → 渠道状态词原样落进 `status` | 引擎不认 → A/B/C/F 四类差异全检不出来，而差异数仍是 0 |
| 解析不出来的行静默跳过 | 对账结论基于剩下的行算，运营不知道 |
| 「没配时间列」的提示只看有没有配列 | 配了列但整列空值，后果完全一样（D 类检不出来），差异数仍是 0 |

**修法**：状态列与状态值映射都必填（引擎只认精确的 `SUCCESS` 才判 A 类）；跳过行报告行号与原因；提示改看**实际解析出了几个时刻**。提交 `0f2257c`。

### 5. 🔴 端点返回 boolean → 前端 `response.json()` 解析失败

**发现方式**：手测时 e2e 断言拿到 `{}`。

Express 的 `res.send(true)` 会把布尔值当字符串发出去（`Content-Type: text/html`、body 是 `"true"`）→ 前端 `response.json()` 直接抛「Unexpected token t」。`resolveItem` 与 `confirmPaid` 两个端点都中招。

**修法**：一律返回对象（`{ resolved: true }` / `{ confirmed: true }`）。提交 `59a0731`。

### 6. 🟡 处置差异的 `resolution` 没有枚举校验

**发现方式**：代码质量审查。

只有 `@IsString()` → TS 的字面量联合类型在**运行时不存在** → `PENDING` 能被提交 → 这条差异**重新回到「未处置」**（运营明明处置过了，未处置统计却不降），且 `resolvedAt` 已写上、状态自相矛盾。写成别的字符串还会撞 PG 的 enum → 冒成 500。

**修法**：改用 `@IsIn(['RESOLVED', 'IGNORED'])`。提交 `59a0731`。

### 7. 🟡 `page` 被夹到 100 → 100 页之后的数据永远取不到

**发现方式**：代码质量审查。

`page` 是页码不是每页条数，夹住上限会让后面的页取不到（对账任务是只增不减的历史表，比订单列表更敏感）。且手写的夹取逻辑是 `common/http/pagination.ts` 的 `clampPagination` 的重复实现。

**修法**：改用 `clampPagination`（它只夹 `page` 的下限、夹 `pageSize` 的 1..100）。提交 `59a0731`。

### 8. 🟡 差异项一次全吐 → 上万条 JSON

**发现方式**：代码质量审查。

一个对账任务最多能产生 10000 条差异（渠道记录数上限），详情接口 `include: { items: true }` 一次全拉 → 浏览器卡死。

**修法**：截断到 200 条 + `itemsTruncated` / `itemsTotal` 标记（静默截断会让人以为「就这些差异」）。前端详情页顶部红字说明「共 N 条，这里只显示前 200 条」。提交 `59a0731`（后端）、`1acd0a7`（前端）。

### 9. 🟡 `RECONCILE_TO_PAID` 留痕显示成「人工操作」

**发现方式**：手测第 7 步看操作记录。

`describePayoutOperation` 的映射表里没有 5m 的两个新类型 → 回落到「人工操作」。而 `RECONCILE_TO_PAID` **恰恰不是人工做的**（是渠道对账自动纠正的，操作人是 `system:reconciliation`）→ 说成「人工操作」是**说谎**，事后追责会把系统动作记到某个人头上。

**修法**：补两条文案；并补测试（这个函数此前**完全没有测试守着** —— 缺条目正是没测试的原因）。提交 `b32b546`。

### 10. 🟡 导入的时间窗没校验日期格式

**发现方式**：实施代理自查。

只校验字符串 → `new Date('abc')` 得 Invalid Date → `assertWindow` 的三道闸全是 `Date.getTime()` 的比较 → **NaN 比较一律为假 → 全部放行** → 一路传到 Prisma 冒成 500 而不是 400。手动触发对账的 DTO 早就用了 `@IsDateString`，同一个时间窗概念两处口径必须一致。

**修法**：补 `@IsDateString()`。提交 `091c9fa`。

### 11. 🟡 两条前端测试被横幅带崩

**发现方式**：跑前端全量测试（Task 10 提交时只跑了 tsc/lint/build，漏了测试）。

出款列表页现在多拉一次未处置差异统计 → 「只调一次后端」与「非法周期压根不调后端」两条断言不再成立。

**修法**：改成「不调**出款明细**」—— 横幅的统计与周期无关，任何周期下都要显示。提交 `a1608f9`。

---

## 六、遗留

### 6.1 本阶段解决的（设计 §10.2）

| # | 遗留 | 状态 |
|---|------|------|
| 1 | L43 渠道对账 | ✅ 本阶段解决 |
| 2 | 5l 遗留 1：人工重试可能重复打款 | ⚠️ **部分解决** —— 解卡前有渠道核实闸；仍不能完全消除（运营可以无视提示） |
| 3 | 5l 的「解卡重打」与对账的竞态 | ✅ 本阶段解决（设计 §六） |
| 4 | 「渠道说钱打了但本地记失败」无路可走 | ✅ 本阶段解决（B 类人工处置路径） |
| 5 | 5l 遗留「`FAILED` 承载两种语义」 | ⚠️ **部分解决** —— 渠道明确拒付的单仍落 `failedBeforePayout=false` → 不能一键重试（设计 §1.3 明确不做） |

### 6.2 仍未处理的（设计 §10.3，11 条原样保留）

| # | 事项 |
|---|------|
| 1 | L31 漏结流水无主动告警 —— 本阶段是「出款侧」的对账，5j 的「缺笔」是「账务侧」的，两者未打通 |
| 2 | L33 出款单作废重开 |
| 3 | R7 跨期调账 + L54 逐笔结佣 —— 等产品决策 |
| 4 | 5k 遗留 4：解密根因只进日志 |
| 5 | 对账与账目口径未打通 —— 对账只改 `payouts` 状态；结算单 / 流水的修正仍是另一件事 |
| 6 | `prisma migrate dev` 仍不可用 —— 历史迁移 checksum 不符；本阶段照旧手写 SQL |
| 7 | **渠道接口无分页** —— 与 10000 条上限冲突 → 真渠道接入前必须补分页或分片拉取 |
| 8 | 「渠道长期不返回终态」的单发现不了 —— 归组时非终态一律不算差异（g 档）→ 强行分类会产生高频误报 |
| 9 | 5l 的 `retry` 仍用「重算」而非 `releasedEntryIds` |
| 10 | 让「渠道明确拒付」的单可安全重试 —— 要改 5h-2 的 worker 语义，属相邻改进 |
| 11 | 对账只覆盖出款侧 —— 结算单 / 抽佣流水 / 商家对账单的「缺笔」不在本阶段 |

### 6.3 验收中新发现的 4 条

| # | 事项 | 说明 |
|---|------|------|
| 1 | **`summary` 端点全表扫** | `findMany` 拉出所有 `PENDING` 项的 severity 再在应用层 filter → 数据量大时是慢查询。应改 `groupBy` |
| 2 | **详情的 `include: { items: true }` 是「捞完再截」** | 虽然返回给前端截到 200 条，但数据库里还是把上万条捞进了内存。真正的截断要在查询层做 |
| 3 | **CSV 导入的 A 类自动纠正没有人工确认闸** | 运营只要把某个状态词映射成 `SUCCESS`，那张卡在 `PROCESSING` 的单就会被**自动改成已付款**。彻底堵住要改纠正策略（CSV 来源的 A 类不自动纠正），属设计层面的决定 |
| 4 | **渠道名只是任务上的标签** | `loadLocalPayouts` 不按渠道过滤 —— 时间窗内的**所有**本地出款单都参与比对 → 同一时间窗内导入两个渠道的账单会互相参与 |

### 6.4 下一步的收尾清单

- **`PROCESSING` 的单没有 `payoutChannel` → 将来按 `payoutChannel` 取渠道会取不到** → 所有解卡全被拒。5m 只用了「第一个 provider」，接第二家渠道时必须一起改（`payout.worker.ts` 的 `firstProvider()` 与 `payout-verification.service.ts` 的取渠道逻辑）
- 真渠道接入前要补：渠道接口分页、`PayoutExecuteResult` 的「渠道明确拒付」标记、CSV 来源的 A 类是否该自动纠正
