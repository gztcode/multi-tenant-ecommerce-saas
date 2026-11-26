# 阶段 5l「出款运维兜底」验收记录

> **设计**：`docs/superpowers/specs/2026-10-30-plan-05l-payout-ops-design.md`
> **计划**：`docs/superpowers/plans/2026-10-30-plan-05l-payout-ops.md`

---

## 一、交付范围

照抄设计 §八 的 7 件事，逐条标注完成情况：

| # | 交付内容 | 状态 | 落点文件 |
|---|---------|------|---------|
| 1 | `payouts.failedBeforePayout` 列 + `payout_operations` 表 + 迁移 SQL + schema + `tenant-models.ts` 排除注释 | ✅ 已完成 | `api/prisma/schema.prisma`、`api/prisma/migrations/20261030130000_add_payout_ops/migration.sql`、`api/src/common/tenant/tenant-models.ts` |
| 2 | `markFailed` 加参数 + worker 5 个调用点传值 | ✅ 已完成 | `api/src/modules/billing/payout-execution.service.ts`、`api/src/modules/payment/payout.worker.ts` |
| 3 | `PayoutService.retry`（kind 分支重算 + 活跃单检查 + 重新纳入明细）/ `unstick` + 两个端点 | ✅ 已完成 | `api/src/modules/billing/payout.service.ts`、`api/src/modules/billing/dto/payout-manual-action.dto.ts`、`api/src/modules/billing/platform-payout.controller.ts` |
| 4 | `toView` 口径分流 + `toPlatformView.failureDetail` + 商家端/平台端页面 | ✅ 已完成 | 后端 `payout.service.ts`；前端 `platform-admin/src/lib/payout.ts` 与两端详情页 |
| 5 | 平台端处置按钮 + 两个中转路由 + 操作留痕展示 | ✅ 已完成 | `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx`、`.../payouts/[id]/page.tsx`、`platform-admin/src/app/api/billing/payouts/[id]/retry/route.ts` 与 `.../unstick/route.ts` |
| 6 | 两端出款列表的分页控件 + 结算单明细分页端点与页面 | ✅ 已完成 | `api/src/modules/billing/settlement.service.ts`（`listEntries`）、`platform-settlement.controller.ts`、三个前端页面 |
| 7 | 单测 / e2e / 失败注入 / 手测 / 验收记录 | ✅ 已完成 | 见 §二 / §三 / §四 / 本文件 |

### 1.1 实施期偏离计划的 6 处（都是「计划本身有缺陷」，不是实现走偏）

| # | 计划写的 | 实际改成 | 为什么 |
|---|---------|---------|-------|
| 1 | `enqueueRetry` 的 jobId 轮次只数 `action: 'RETRY'` | 同时数 `RETRY` + `UNSTUCK_TO_APPROVED`，并减 1 | ⚠️ **计划有真缺陷**：只数 `RETRY` 时，`unstick → APPROVED` 得 `-retry-1`，该 job 失败后（BullMQ 留 hash）再走 `retry` → `RETRY` 计数仍是 0 → **又是 `-retry-1`** → 被 BullMQ **静默忽略** → 重试从未发生，**钱永远打不出去** |
| 2 | `merchantFailureReason` 对 `failedBeforePayout = true` 一律返回「收款账号信息异常…」 | 改成**白名单透传**（白名单外退回通用措辞） | ⚠️ **计划有真缺陷**：那一桶里还有「出款金额异常…」「没有可用的出款渠道」—— 金额异常的单被告知「收款账号信息异常」，商家改完账户再申请还是同样的错。白名单里的值**本来就是给商家看的措辞**（解密根因只进日志） |
| 3 | 重试只比金额 | 追加「笔数一致」闸 | 只比金额会漏掉「一笔换一笔、总额不变」→ 纳入的流水集合变了 → 被换掉的那笔「没被任何单占用」→ 商家能对它再申请补差单 → **同一笔打两次**。`payouts` 表只存笔数没存流水 id，这是能做到的最强校验 |
| 4 | `merchantFailureReason` 在 `toView` 里改 | 同上，但**商家端前端也要跟着改** | ⚠️ **计划漏了商家端前端** → 见 §五 的两处真缺陷 |
| 5 | Task 5 的组件文案「可能已经打款」 | 改成「可能已打款」 | 计划给的**组件片段与测试断言自相矛盾**（片段写「可能已经打款」、断言写 `/可能已打款/`）→ 以测试为准，并与 FAILED 分支的措辞统一 |
| 6 | `listEntries` 的 `total = links.length` | 改成 `all.length` | `all` 是实际会渲染出来的行。`links.length` 会把「查不到流水的关联行」也计入 → 页面显示「共 120 笔」但最后一页只翻出 118 笔 |

### 1.2 有意多做的一处

**操作留痕的「操作人」转成显示名**（`operatorName`）：留痕表只存 `operatorId`（uuid），
界面上只给一串 uuid 谁都认不出是谁操作的 —— 而「谁在什么时候把哪张单重打了」
正是留痕表存在的理由。详情接口一次查齐所有操作人（不做 N+1），查不到（账号被删）
回落到 id —— 留痕不能凭空消失。

### 1.3 计划外改动（都是必需的）

- `api/src/common/tenant/tenant-prisma.service.ts` —— 加 `payoutOperation` delegate（不加则无法编译，与 `payoutEntry` 同款先例）
- `api/test/payout-execution.e2e-spec.ts` —— 商家端断言按新口径改写（口径变了，断言必须跟着变）
- `platform-admin/test/app/payout-detail-page.test.tsx`、`merchant-admin/test/app/*.test.tsx` —— 契约新增必填字段，夹具必须补

---

## 二、自动化测试

| 层 | 命令 | 结果 |
|----|------|------|
| 单测（后端） | `cd api && npm test` | 30 suites / **567** tests 全绿 |
| 单测（商家端） | `cd merchant-admin && npx vitest run` | 27 files / **406** tests 全绿 |
| 单测（平台端） | `cd platform-admin && npx vitest run` | 15 files / **384** tests 全绿 |
| e2e（全量，串行） | `cd api && npx jest --config test/jest-e2e.json --runInBand` | 35 suites / **629** tests 全绿 |

⚠️ **e2e 必须串行跑**（`--runInBand`）—— 本仓的 e2e 共享同一个测试库与 Redis 队列，
并行跑会互相干扰。**这不是本阶段引入的问题**：5i 的验收记录就写着
「`payment-compensation`「扫描 A…」与 `payout`「P7…」概率性挂（本进程 BullMQ worker
抢走测试自己入队的 job）」，5k 的设计文档 §七 同款记录。并行跑会随机挂 6~8 条，
串行跑 629 条全绿。

### 2.1 新增的测试

| 文件 | 条数 | 覆盖 |
|------|------|------|
| `api/src/modules/payment/payout-worker.spec.ts` | +4 | worker 五个失败分支的「确定没打」标记（原只覆盖 2 个） |
| `api/src/modules/billing/payout-execution.service.spec.ts` | +2 | `markFailed` 的标记落库与默认值 |
| `api/src/modules/billing/payout.service.spec.ts` | +25 | 重试的四道闸、解卡的两条分支、口径分流、留痕 |
| `api/test/payout-ops.e2e-spec.ts` | 10 | 见 §2.2 |
| `api/src/modules/billing/settlement.service.spec.ts` | +6 | 明细分页（跨页不漏不重、字段一致、404） |
| `api/test/settlement.e2e-spec.ts` | +6 | 明细分页端点（排序、跨页、夹取、404/400/403） |
| `platform-admin/test/components/payout-actions.test.tsx` | +3 | 按钮的出现条件（护栏） |
| `platform-admin/test/app/payout-detail-page.test.tsx` | +3 | 操作记录（操作人、动作、空态） |
| `platform-admin/test/app/payouts-page.test.tsx` | + | 出款列表的翻页与筛选联动 |
| `merchant-admin/test/app/payouts-page.test.tsx` | +1 | 失败口径按「钱打没打」分流 |
| `merchant-admin/test/app/payout-detail-page.test.tsx` | +1 | 失败口径不重复、不自相矛盾 |

### 2.2 e2e 的 10 条用例

| # | 用例 | 断言要点 |
|---|------|---------|
| 1 | 重试：确定没打 | → APPROVED、**明细被重新纳入**、attemptCount 归零、留痕一行 `RETRY` |
| 2 | 重试：钱可能已打 | → **409**（消息含「可能已经打款」）、状态不变、**零留痕** |
| 3 | 重试：同期有别的活跃单 | → **409**，消息带那张单的 `payoutNo` |
| 4 | 重试：期间金额变了 | → **409** |
| 5 | 重试：原因为空 | → **400** |
| 6 | 解卡转失败 | → FAILED、**明细被释放**、留痕 `UNSTUCK_TO_FAILED` |
| 7 | 解卡转重打 | → APPROVED、**明细仍被占着**、attemptCount 归零、留痕 `UNSTUCK_TO_APPROVED` |
| 8 | 解卡：未超卡住阈值 | → **409**（不许打断正在进行的打款） |
| 9 | 口径 | 商家端 `failureReason` **不含**渠道原文；平台端 `failureDetail` **含**原文 |
| 10 | 并发 | 两个超管同时点重试 → 恰好一个 200 一个 409，且**只有一条留痕** |

两处「断言有牙齿」的设计：
① **「明细被重新纳入」**先 `createMany` 挂上明细再 `deleteMany` 清空（模拟 `markFailed`
的释放）→ 没有「重新纳入」这一步断言必挂，不会「碰巧还在」；
② **并发用例**断言留痕只有一条 —— 两次点击不能记成两次操作。

⚠️ **出款队列在 `beforeAll` 暂停、`afterAll` 恢复** —— 否则后台 worker 抢跑会把
「明细被重新纳入」变成竞态。e2e 用独立的 `bull-e2e` Redis 前缀，与开发环境隔离。

---

## 三、失败注入

做法：**逐条注入 → 只跑那一个定向 spec → 确认挂 → 还原 → `git diff --exit-code` 校验还原**。
⚠️ **注入期间绝对没跑全量测试**（源码是坏的，全量跑会出一堆假失败并掩盖注入效果）；
⚠️ **七条注入全部独占执行**，不与任何其它测试并发。

| # | 注入点 | 跑的测试 | 结果 | 挂掉的测试名 |
|---|--------|---------|------|-------------|
| H1 | 删掉 `retry` 里 `failedBeforePayout` 的显式检查 | `payout-ops.e2e-spec.ts` | ✅ FAIL（1/10） | 重试：钱可能已经打出去的单 → 409 |
| H2 | 删掉重试前的「该期有别的活跃单」检查 | `payout-ops.e2e-spec.ts` | ✅ FAIL（1/10） | 重试：该期有另一张活跃出款单 → 409 |
| H3 | 解卡转 `APPROVED` 时也释放明细 | `payout-ops.e2e-spec.ts` | ✅ FAIL（1/10） | 解卡（重新打款）：明细仍被占着 |
| H4 | `toView` 的 `failureReason` 改回原文 | `payout-ops.e2e-spec.ts` | ✅ FAIL（1/10） | 口径：商家端不含渠道原文 |
| H5 | worker 的三处 `failedBeforePayout: true` 改 `false` | `payout-worker.spec.ts` + `payout-execution.e2e-spec.ts` | ✅ FAIL（单测 4/24、e2e 1/23） | 打款前的失败 → 标记「确定没打」（4 条）/ X4：金额被改成 0 的单 |
| H6 | 删掉重试时的「重新纳入明细」 | `payout-ops.e2e-spec.ts` | ✅ FAIL（1/10） | 重试：明细被重新纳入 |
| H7 | 删掉解卡时「`processingAt` 未超阈值」的检查 | `payout-ops.e2e-spec.ts` | ✅ FAIL（1/10） | 解卡：processingAt 还在卡住阈值内 → 409 |

**七条全部验证成功**，且**每条都只有指定的那条挂**（除 H5 的单测挂了 4 条，正是预期的 4 条），
没有出现「整份 e2e 挂掉」的扩散现象。

### 3.1 各条的实际失败摘要

| # | 关键输出 |
|---|---------|
| H1 | `Expected substring: "可能已经打款"` / `Received string: "出款单状态已变，不能重复重试"` |
| H2 | `Expected: 409` / `Received: 500`（服务端：`Unique constraint failed on the fields: ('tenantId','periodStart','kind')` → P2002） |
| H3 | `Expected: 2` / `Received: 0`（明细被无条件释放） |
| H4 | `Expected: "出款未完成，请联系平台确认出款情况"` / `Received: "渠道金额核对不通过（请求 30000 分，渠道返回 30001 分）"` |
| H5 | `Expected: true` / `Received: false`（4 条 worker 单测）；e2e 的 X4 挂在 `Expected substring: "出款金额异常"` / `Received string: "出款未完成，请联系平台确认出款情况"` |
| H6 | `Expected  - 4` / `Received  + 1`（`Array ["3765ce93-…","884e14ca-…"]` vs `Array []`） |
| H7 | `Expected: 409` / `Received: 200` |

### 3.2 H1 的一个发现（值得记录）

去掉 `retry` 的**显式**检查后，事务里 `updateMany` 的 `where: { failedBeforePayout: true }`
**仍然挡住了**这次重试 → 状态码仍是 409。但**消息**退化成了「出款单状态已变，不能重复重试」。

→ **这道显式闸的价值在「文案可读」上，不在「拦截」上** —— 拦截由数据库条件兜住了。
两处都要留：显式检查给运营一句能看懂的话，数据库条件防并发。

### 3.3 H5 的覆盖位置（澄清）

H5 在 `payout-ops.e2e-spec.ts` 里**没有**被兜住（那个文件的重试场景直接构造落库数据、
在数据库层改状态，不驱动 worker 跑那三条「打款前拦截」分支）。

但**不是覆盖缺口** —— worker 的这三条路径由 `payout-execution.e2e-spec.ts` 的
X4 用例驱动**真实 worker** 覆盖（协调者亲自跑过 H5 变异对那个文件，X4 确实挂）。
加上 `payout-worker.spec.ts` 的 4 条单测，**三条防线都在**。

---

## 四、浏览器手测

工具：本机 `ego lite`（`pgrep -f "ego lite"` 检查后复用，全程未抢前台，结束后清理了标签页）。
⚠️ **平台端与商家端共用同一个 `AUTH_SECRET`** → cookie 按域共享、不按端口隔离 →
**同一浏览器里只能有一个登录态**，两个端要轮流登录。

| 步 | 内容 | 结果 |
|----|------|------|
| 1 | 平台端出款列表翻页 | ✅ 共 28 张、本页 20 张、第 1/2 页、三档 pageSize 链接齐全；第 2 页 8 行，**与第 1 页零交集**；按周期筛选后所有翻页链接**都带 `period`**（筛选不会被悄悄重置） |
| 2 | 商家端出款列表翻页 | ✅ 第 1 页 20 行、第 2 页 8 行、零交集 |
| 3 | 平台端 FAILED 单的「失败原因」与「失败详情」两行 | ✅ 两行都在；「失败详情」是**渠道原文**（`渠道金额核对不通过（请求 28500 分，渠道返回 28501 分）`），「失败原因」是业务口径 |
| 4 | 商家端同一张单 | ✅ 只看到业务口径，**看不到**渠道原文（列表与详情均验证） |
| 5 | 平台端 FAILED + `failedBeforePayout = true` | ✅ 有「重试」按钮；文案是业务口径；**无解密根因泄露** |
| 6 | 平台端 FAILED + `failedBeforePayout = false` | ✅ **没有**「重试」按钮；有「该单可能已打款（渠道调过了，只是没成功回包），不能直接重试。请先核对渠道是否已到账。」 |
| 7 | 平台端卡住的 PROCESSING 单 | ✅ 两个方向都有（标记为失败 / 重新打款）；「重新打款」带**红字警示**（`text-destructive`：「⚠️ 这张单可能已打款（卡在「打款中」超过 10 分钟）。重新打款会重复打款，请先核对渠道。」）；二次确认已验（取消后页面不变、不发请求） |

### 4.1 手测时额外做的三组交互验证

| 组 | 内容 | 结果 |
|----|------|------|
| A | 点「标记为失败」→ 确认 → **原因只填空白** | ✅ 页面显示「必须填写操作原因」，**状态未变**（仍是「打款中」），不发请求 |
| B | 点「标记为失败」→ 确认 → 填真实原因 | ✅ 状态从「打款中」变成「出款失败」；「重试」按钮出现（`unstick → FAILED` 认定「没打出去」→ `failedBeforePayout = true`）；「操作记录」区块出现，含**动作**（解除卡单（标记为失败））、**原因**、**操作人** |
| C | 数据库核对 | ✅ `payout_operations` 一行 `UNSTUCK_TO_FAILED`，`fromStatus=PROCESSING`、`toStatus=FAILED`、`attemptCountBefore=1`、`reason` 与界面一致 |

⚠️ **「重试」成功路径没有在浏览器里走通** —— 手测用的数据是造的，没有真实的货款流水
与结算单支撑，重算金额必然对不上 → 服务端正确返回 409「该期（2026-05）的金额已变化」。
**该路径由 e2e 用真实数据覆盖**（§2.2 的第 1 条：状态回 APPROVED、明细被重新纳入、
attemptCount 归零、留痕一行 RETRY）。

⚠️ **浏览器手测造的数据已全部清理** —— 开发库的 `payouts` / `payout_entries` /
`payout_operations` 计数均回到 0。

---

## 五、实施期发现并修掉的 2 个真缺陷

⚠️ **两个都不是「实现写错」，而是「计划/设计漏了」** —— 而且**都是靠自动化手段发现的**，
其中 DTO 那个是**浏览器手测**与**e2e 双向独立暴露**的。

### 5.1 缺陷一：`PayoutManualActionDto.to` 缺 `@IsOptional()` → **「重试」端点必然 400**

- **现象**：平台端点「重试」→ 界面报 `操作失败：to must be one of the following values: FAILED, APPROVED`
- **根因**：全局 `ValidationPipe` 没开 `skipMissingProperties`（默认 false）→ `@IsIn` 拿
  `undefined` 也校验一遍 → **任何不带 `to` 的请求体都被拒**。而「重试」的请求体
  本来就只有 `reason`（前端中转路由也只重建 `reason`）→ **后端与前端契约对不上**
- **暴露方式**：浏览器手测点「重试」时暴露；e2e 代理独立跑时同样暴露（6 条挂掉、全是 400）
- **修法**：一行 —— `@IsOptional()`。加完之后：没传 `to` → 跳过校验（由控制器按端点各自
  的要求兜底：unstick 显式要求 `to`，缺了就 400）；传了但值不对 → `@IsIn` 照样拦
- **回归**：三种情形都验过 —— 重试只带 `reason` → 通过校验；unstick 不带 `to` → 400
  「必须指定目标状态（FAILED 或 APPROVED）」；unstick 带非法 `to` → 400

### 5.2 缺陷二：商家端前端没跟着口径收口改 → 列表页没区分、详情页自相矛盾

- **现象**：后端把 `toView` 的 `failureReason` 改成业务口径后，商家端两处都错了：
  - **列表页**写死了「出款失败，请联系平台确认出款情况」→ 两类失败用同一句，
    商家看不到「确定没打」这个关键区分，白打一个电话核对
  - **详情页**写的是「出款失败：{原因}。请联系平台确认出款情况。」→ 后端给的已经是
    完整一句话，前端再包一遍就成了「出款失败：出款未完成，请联系平台确认出款情况。
    请联系平台确认出款情况。」而「确定没打」那一类还会**自相矛盾**：前面说
    「本次未打款」后面说「请联系平台确认」
- **根因**：计划 Task 4 的前端部分只覆盖了平台端，**漏了商家端**
- **修法**：两处都改成直接显示后端给的业务口径，不再自己拼措辞 ——
  「哪些失败意味着没打钱」的知识在后端（那里才有 `failedBeforePayout` 这个事实依据），
  前端按文案分支迟早会漂
- **暴露方式**：浏览器手测时发现（商家端列表一律显示通用口径、详情页文案自相矛盾）

### 5.3 一处覆盖缺口（不是缺陷，是测试不够）

Task 2 的**规格审查**查出：worker 的五个 `markFailed` 调用点里，只有 2 个有测试保护，
另外 3 个（`checkGates` 的两道闸、没有可用渠道、**渠道金额核对不通过**）改掉取值
**不会有任何测试报警**。其中「渠道金额核对不通过」最危险 —— 那一处若是 `true`，
就意味着渠道调过、钱可能已打出去的单被标成「可安全重试」→ 重复打款。

已补 4 条用例覆盖剩下三个调用点的全部路径（含 `checkGates` 的两道闸各自一条），
并断言「渠道确实未被调用 / 已被调用」。变异验证：把「渠道金额核对不通过」那处
改成 `true` → 新测试立刻报警（`Expected: false / Received: true`）。

---

## 六、审查记录

| Task | 规格符合性审查 | 代码质量审查 |
|------|--------------|-------------|
| Task 1（数据模型） | ✅ 逐条符合，无缺失无多做 | ✅ 安全关键路径全部成立（回填论证链独立验证 6 个环节） |
| Task 2（`markFailed` + worker） | ✅ 五个取值无一取反 | 查出覆盖缺口 → 已补 4 条测试（§五·5.3） |
| Task 6（分页） | ✅ 6 处与计划不同的决定逐条判定可接受 | —— |

**Task 1 的代码质量审查提了 1 条「重要」建议，本阶段不采纳**：
裸 `CREATE TYPE` 不幂等（重跑整份迁移会卡死）。理由：**已应用的迁移不能改** ——
改了就 checksum 失配、`migrate deploy` 直接报错；将来要加列/索引就**新建迁移**
（本仓 `add_processing_status` 就是这个先例）。裸 `CREATE TYPE` 与本仓 14 个历史迁移里的
13 个一致。

---

## 七、遗留与风险

### 7.1 本阶段引入的（照抄设计 §七·7.1）

| # | 事项 | 说明 |
|---|------|------|
| 1 | **人工重试可能重复打款** | 操作 C（解卡重打）本质上是运营在做「钱没打出去」的判断。**界面警示 + 必填原因 + 留痕**只能降低误操作概率，**不能消除**。真正的解法是渠道对账（L43），不在本阶段 |
| 2 | **`failedBeforePayout` 是「历史信息」而非「当前事实」** | 它记录的是**落 FAILED 那一刻**钱打没打出去。将来若有别的代码路径改状态，这个标记可能不再准确 → 只能由「落 FAILED 的那个调用点」来保证正确性 |
| 3 | **状态机新增了两条转换**（`FAILED → APPROVED`、`PROCESSING → FAILED/APPROVED`） | ⚠️ **部分唯一索引的 `WHERE` 不含新目标状态** —— `APPROVED` 不在 `status NOT IN ('REJECTED','CANCELLED','FAILED')` 的排除列表里 → 转成 `APPROVED` 的单**重新占位**（这正是我们想要的：它又要打那些流水了） |
| 4 | **历史 `FAILED` 单的 `failedBeforePayout` 一律 `false`**（除 5k 那句业务口径的精确匹配） | 保守。渠道失败的老单**不能**一键重试 → 运营要先人工核对 |

### 7.2 5j / 5k 的遗留，本阶段处理了的（照抄设计 §七·7.2）

| # | 遗留 | 状态 |
|---|------|------|
| 1 | 5k 遗留 3：崩溃窗口卡 `PROCESSING`，无自助处置入口 | ✅ 本阶段解决（操作 B / C） |
| 2 | 5k 遗留 1：密钥配错 → 批量 `FAILED` 且不会自动恢复 | ✅ **部分解决** —— 确定没打的单现在能一键重试（不用商家全部重新申请） |
| 3 | 5k 遗留 5：`FAILED` 承载两种语义 | ✅ **商家端已能区分**（列表与详情都按「钱打没打」分流） |
| 4 | 5k 遗留 6：渠道失败原因原样透到商家屏幕 | ✅ 本阶段解决（§四） |
| 5 | L41 / L42：`FAILED` 无人工重试、`attemptCount` 无重置 | ✅ 本阶段解决 |
| 6 | L35 / L36：两端出款列表无分页 | ✅ 本阶段解决 |
| 7 | L28：结算单明细分页 | ✅ 本阶段解决 |

### 7.3 仍未处理的（照抄设计 §七·7.3）

| # | 事项 | 说明 |
|---|------|------|
| 1 | **L43 渠道对账** | 「钱到底打没打」的唯一权威答案。人工核对渠道是临时的替代 |
| 2 | **L31 漏结流水无主动告警** | 本阶段的「运营能看见并处理」是替代，不是告警 |
| 3 | **5k 遗留 4：根因只进日志** | 平台端仍看不到「是没迁移 / 是密钥错了 / 是版本不匹配」—— ⚠️ **`failureDetail` 也看不到**（它只承载渠道侧原文，解密根因从不进 `failureReason`）。要把解密根因放上界面，**需要单独决策**（那会把密钥相关的信息推到浏览器里） |
| 4 | **R7 跨期调账 + L54 逐笔结佣** | 等产品决策 |
| 5 | **L33 出款单作废重开** | 本阶段的「解卡转失败」覆盖了卡单场景，但 `APPROVED` 后金额要改的场景没有解 |
| 6 | **`prisma migrate dev` 仍不可用** | 3 条历史迁移的 checksum 不符。本阶段照旧手写 SQL |

### 7.4 本阶段实测发现、但不在设计里的

| # | 事项 | 说明 |
|---|------|------|
| 1 | **平台端详情的 `failureReason` 与 `failureDetail` 语义部分重复** | `toView` 统一走 `merchantFailureReason`，所以平台端的 `failureReason` **也是**业务口径，渠道原文只在 `failureDetail`。超管看得到原文（信息没丢），但两个字段在平台端看起来重复。**这是「默认安全」设计的代价**，不是缺陷 |
| 2 | **平台端结算单列表页仍是一次取 200 条** | 页面显式请求 `pageSize=200`，但后端 `MAX_PAGE_SIZE` 是 **100** → 实际被夹到 100；页面上的「本页显示 N 张 / 超过 200 张时请按周期筛选」**说的 200、实际 100**，连代码注释写的「后端 `pageSize` 的上限就是 200」也是错的。**既有的不一致**，不在本阶段范围（计划只列了三处） |
| 3 | **「金额异常」这一类失败的重试按钮行为在历史单与新增单上不一致** | 历史行按迁移的回填规则是 `false`（不出现按钮），新增行是 `true`（出现按钮，点了被 409 挡）。**不是安全漏洞**（409 挡住了，钱不会重复打），但属体验不一致 |
| 4 | **端点的校验错误信息是英文** | 例如 `to must be one of the following values: FAILED, APPROVED` 会原样显示在平台端界面上。平台端面向超管，优先级不高；后续若要统一，需要在 `AllExceptionsFilter` 里把校验错误翻成业务口径 |
