# 阶段 5g 验收记录：结算单（按商家 × 自然月的应收单据）

**验收日期**：2026-10-29
**范围**：计划 5g「结算单」的 Task 1–9
（`docs/superpowers/plans/2026-10-28-plan-05g-settlement-statement.md`）
**设计**：[`docs/superpowers/specs/2026-10-28-plan-05g-settlement-statement-design.md`](../specs/2026-10-28-plan-05g-settlement-statement-design.md)
**分支**：`gzt/电商项目`

**结论**：**通过** —— 自动化测试全绿（后端单测 **252/252**、e2e **534/534**，
三个前端全绿）；容器化验证通过（新迁移在镜像里自动应用、产物路径正确）；
**浏览器手测 8 步全部实测通过**（含「漏结修复」闭环）；
12 条护栏逐条核对、7 条失败注入**逐条单独复验**；
过程中发现并修复了 **12 处缺陷**（含 3 处阻断级账务风险），
失败注入还**翻出 2 处护栏缺口并当场补上**。

---

## 一、自动化测试结果

### 1.1 数字对账

| 项目 | 阶段 5g 之前 | 阶段 5g 之后 | 增量 | 结果 |
|------|-------------|-------------|------|------|
| 后端单元测试（Jest） | 186 | **252** | **+66** | ✅ 15 suites |
| 后端 e2e | 499 | **534** | **+35** | ✅ 29 suites |
| storefront（Vitest） | 209 | **209** | 0 | ✅ 24 files |
| merchant-admin（Vitest） | 207 | **207** | 0 | ✅ 16 files |
| platform-admin（Vitest） | 207 | **254** | **+47** | ✅ 11 files |

> 5g **没有改动** storefront 与 merchant-admin → 两个前端的数字不变 ✅
> 后端 +66 = Task 2 的纯函数单测 57 条 + 修复轮新增的 service 单测 9 条
> e2e +35 = Task 6 的 24 条 + 修复轮新增的 10 条 + 失败注入发现缺口后补的 1 条
> platform-admin +47 = Task 8 的 30 条（列表 21 + 详情 16 的页面级部分按文件计）+ 客户端组件 17 条

### 1.2 各条命令的实测

| 命令 | 通过标准 | 实测 |
|------|---------|------|
| `cd api && npx jest --passWithNoTests` | 全部通过 | **252 passed / 252**（15 suites） |
| `cd api && npm run test:e2e` | 全部通过 | **534 passed / 534**（29 suites） |
| `cd api && npx tsc --noEmit` | 无输出 | ✅ 无输出 |
| `cd api && npx eslint src/ test/` | 无告警 | ✅ 无输出 |
| `cd platform-admin && npx vitest run` | 全部通过 | **254 passed / 254**（11 files） |
| `cd platform-admin && npx tsc --noEmit` | 无输出 | ✅ 无输出 |
| `cd platform-admin && npx eslint src/ test/` | 无告警 | ✅ 0 error（2 个既有 warning，见 §六·9） |
| `cd storefront && npx vitest run` | 全部通过 | **209 passed / 209**（24 files） |
| `cd merchant-admin && npx vitest run` | 全部通过 | **207 passed / 207**（16 files） |

### 1.3 本阶段新增的 e2e

| 文件 | 条数 | 覆盖 |
|------|------|------|
| `api/test/settlement.e2e-spec.ts` | 24 → **35** | 护栏 S1–S12（见 §四·4.1）+ 修复轮的 10 条 + 失败注入发现缺口后补的 1 条 |

---

## 二、容器化验证

| 检查项 | 期望 | 实测 |
|--------|------|------|
| 镜像构建 | 新迁移能在镜像里应用 | ✅ `docker compose up -d --build api` 成功（`20261028190000_add_settlement_statements` 自动应用） |
| 迁移登记 | `_prisma_migrations` 有该条且已应用 | ✅ `finished_at` 非空 |
| 枚举 | `SettlementStatus` 存在 | ✅ `pg_type` 查得 `SettlementStatus` |
| 表结构 | 13 个字段 + 4 条索引 + 外键 | ✅ 与 `schema.prisma` 一致；`statementNo` 与 `(tenantId, periodStart)` 两条唯一索引都在 |
| 容器健康 | `Up (healthy)` | ✅ |
| **探活端点** | 返回 ok | ✅ `GET /api/v1/health` → `{"status":"ok","checks":{"redis":true,"database":true}}` |
| **容器里的 `dist` 产物路径** | 必须是 `dist/main.js`（不是 `dist/src/main.js`） | ✅ `/app/dist/main.js` 存在 |
| 平台后台容器 | 结算单页面上线 | ✅ `platform-admin` 重建后 `/settlements` 返回 307（未登录跳转），登录后可访问 |

> ⚠️ **探活路径要带前缀**：应用设了 `setGlobalPrefix('api/v1')` → 实际路径是
> `/api/v1/health`，**不是** `/health`（后者返回 404）。计划正文写的 `/health` 不准确。

---

## 三、浏览器手测（8 步，全部实测）

用 `ego-browser`（已常驻，未抢前台）。手测数据在**生产库**造、用完**已清理干净**
（核对：单据 0 / 明细 0 / 流水 0 / 订单 0）。

### 3.1 手测数据与对账基准

造了两笔已支付订单 + 对应抽佣流水（订单号前缀 `MANUAL-5G-`，用于精确清理）：

| 商家 | 流水 | 报表口径 `netAmount` | 结算单 gross / reversal / net |
|------|------|---------------------|---------------------------|
| 示例店铺（demo） | COMMISSION 500、REVERSAL −200 | **300** | 500 / −200 / **300** |
| Ma（themetest-a） | COMMISSION 300、REVERSAL −500 | **−200** | 300 / −500 / **−200** |

> 这组数据同时是 **S9 护栏（结算单净额 == 报表抽佣净额）** 在真实环境下的对照基准。

### 3.2 逐条结果

| # | 手测项 | 实测 |
|---|--------|------|
| 1 | 超管登录 platform-admin → 「结算单」 | ✅ 登录成功，导航栏出现「结算单」入口 |
| 2 | 选过去的月份 → 点「生成」→ 确认框 → 列表出现该期各商家的单据 | ✅ 确认框文案「确定生成 2026-09 的结算单？」；提示「已新建 2 张结算单」；列表「共 2 张」 |
| 3 | 金额与「抽佣明细」页同期对得上 | ✅ 列表毛额/冲回/净额 ¥5.00 / ¥−2.00 / ¥3.00 与 Ma ¥3.00 / ¥−5.00 / ¥−2.00，与 `GET /platform/commissions` 的 `byMerchant` 逐个商家一致 |
| 4 | 点进详情 → 明细逐笔与抽佣明细页一致 | ✅ 六列表头齐全（时间/订单号/类型/金额/费率/计佣基数）；两行明细的金额、费率、基数与流水表逐字一致 |
| 5 | 点「确认」→ 状态变「已确认」 | ✅ 状态「草稿」→「已确认」，按钮随之从「确认 / 重算」变为「取消确认」，金额不变 |
| 6 | 点「重算」→ 被拒（已确认） | ✅ **API 层**：已确认时 `POST .../recalculate` → **409**，消息「结算单当前是「CONFIRMED」状态，不能重算。请先取消确认。」<br>⚠️ **UI 上此时没有「重算」按钮**（只有「取消确认」）—— 这条护栏在界面层由「按钮不出现」保证 |
| 7 | 点「取消确认」→ 状态回「草稿」→ 点「重算」→ 金额不变 | ✅ 状态回「草稿」，按钮变回「确认 / 重算」；重算后毛额/冲回/净额与笔数**全部不变**（当期无新流水） |
| 8 | 造一笔同期流水 → 重算 → 金额跟着变 | ✅ 补录一笔 COMMISSION 100 分 → 重算后毛额 ¥5.00→**¥6.00**、净额 ¥3.00→**¥4.00**、笔数 2→**3**、明细行数 2→**3** |

### 3.3 额外交手测（超出计划清单）

| # | 项目 | 实测 |
|---|------|------|
| A | 未登录访问平台结算单接口 | ✅ **401** |
| B | 商家身份（`owner@demo.platform.test`）访问平台结算单接口 | ✅ **403**「当前角色无权访问该资源」（列表与生成两个端点都是） |
| C | 复用已有单据时该期又进了流水 → 响应标出缺笔 | ✅ `stale: ["78b694db-…"]`（精确到示例店铺，Ma 不在列）；**单据金额未被擅改** |
| D | 前端把 `stale` 显示出来 | ✅ 提示「已新建 0 张结算单，复用 2 张已有单据。**有 1 个已有单据与当期流水对不上（可能缺笔），请到结算单列表里对该单据「取消确认」后「重算」以修正金额。**」 |
| E | 按提示走「取消确认 → 重算」真能修正金额 | ✅ 已确认(缺笔) → 取消确认 → 重算 → 毛额 ¥6.00→**¥6.50**、净额 ¥4.00→**¥4.50**、笔数 3→**4** |

### 3.4 ⚠️ 手测中发现的一个限制（如实记录）

**`type="month"` 的 input 无法用自动化工具填值**：Chrome 的 month input 不接受文本插入，
`fill('2026-09')` 之后值会被清空 → 组件报「周期格式非法」。

这是**自动化工具的限制，不是产品缺陷** —— 真实用户用原生月份选择器，产出的一定是
`YYYY-MM`，与组件的正则 `/^\d{4}-(0[1-9]|1[0-2])$/` 天然吻合。

手测改走 **URL 预填**路径（`/settlements?period=2026-09`）—— 这恰好就是组件注释里
描述的真实场景（「超管通常是在『看某个月』的页面上决定生成那个月的单据」）。

⚠️ 同一个限制也是前端测试里那条「非法周期」用例的由来（详见 §五·10）。

---

## 四、机制级验证

### 4.1 护栏 S1–S12 逐条核对

「实测」列填的是**失败注入的证据** —— 光有用例不够，要证明**把代码改坏时用例真的会挂**。

| 护栏 | 一句话 | 测试位置 | 注入 | 实测 | 结论 |
|------|--------|---------|------|------|------|
| **S1** | 只纳入该商家该自然月的流水 | `S1：生成只纳入该商家该自然月的流水` | **F1** 去掉 `tenantId` 过滤 | 挂 14 条（含 S1） | ✅ |
| **S1′** | ⭐ **周期边界那一瞬的流水归属** | `⚠️ 恰好落在周期边界那一瞬的流水 → 只被一期结算` | **F2** 区间改右闭 | ⚠️ **首轮挂 0 条** → 补测试后挂 1 条 | ✅（补后） |
| **S2** | 三个金额由后端算 | `S2：毛额 / 冲回 / 净额由后端算` | **F5** 冲回再取负 | 挂 6 条（含 S2） | ✅ |
| **S3** | 同一商家同一周期只有一张单 | `S3：重复生成同一商家同一周期` | **F3a** 去掉幂等前置查 | 挂 3 条（含 S3） | ✅ |
| **S4** | 一笔流水只能被一期结算 | `S4：…已被别的单据结算过 → 409`、`S4：…被关联两次 → P2002` | — | 生成路径未受 F4 影响（⚠️ 见 §四·4.2 的 F4 说明） | ✅（前置检查靠 P2002 兜底，见 §六·R8） |
| **S5** | 跨期冲回落退款期 | `S5：1 月支付、3 月退款` | **F5** | 挂 6 条（含 S5） | ✅ |
| **S6** | 重算只有 DRAFT 能做 | `S6：CONFIRMED 的单据重算 → 409` | **F4** 重算不删旧关联行 | 挂 2 条（含 S6） | ✅ |
| **S7** | 确认幂等；确认后冻结 | `S7：确认幂等，确认后金额冻结` | **F6** `confirm` 去掉 `status` 条件 | ⚠️ **首轮挂 0 条** → 补 `confirmedAt` 断言后挂 1 条 | ✅（补后） |
| **S8** | 鉴权 403 / 401 | `S8：商家账号调平台接口 → 403`、`S8：没登录 → 401` | — | e2e + **浏览器手测**双向验过（§三·3.3 A/B） | ✅ |
| **S9** | ⭐ 结算单净额 == 报表抽佣净额 | `S9：对账：…` | **F5** | 挂 6 条（含 S9）；审查另做过变异「结算改读 `orders`」→ 挂 23 条 | ✅ |
| **S10** | 零额与负额 | `S10：净额为 0 的单据正常生成；净额为负…` | **F5** | 挂 6 条（含 S10 两条） | ✅ |
| **S11** | 周期未结束不能生成 | `S11：周期尚未结束 → 400` | **F7** 去掉周期校验 | 挂 1 条（S11） | ✅ |
| **S12** | 列表的 total 是真实总数 | `S12：列表的 total 是真实总数` | **F1** | 挂 14 条（含 S12）；审查另做变异「`total = items.length`」→ 挂 1 条 | ✅ |

### 4.2 失败注入 F1–F7（**逐条单独跑，不叠加**）

> ⚠️ **逐条单独跑**：阶段 5c 的教训 ——
> 「注入 A + 注入 B 叠加 → 挂 N 条」**不能**用来证明 A 缺独立锁点，
> 叠加时 A 的代码可能根本没机会执行。

| # | 注入 | 期望挂掉 | 实测 | 结论 |
|---|------|---------|------|------|
| **F1** | `entriesInPeriod` 里去掉 `tenantId` 过滤 | S1 | **挂 14 条**（S1、S2、S5、S9、S10、S12、S3 的 stale 两条、批量两条…） | ✅ |
| **F2** | `entriesInPeriod` 改成 `occurredAt: { gte: from, lte: to }`（右闭） | S1 | ⚠️ **挂 0 条 —— 34 条全绿** | ❌ **护栏缺口，已补**（见 §四·4.4） |
| **F3a** | `generateOne` 的「先查后插」前置查查不到（幂等分支不可达） | S3 | **挂 3 条**（S3 + 两条 stale 用例）。失败详情：期望 200，实得 **409** —— 撞上 `assertEntriesNotSettled` 的「流水已被结算」 | ✅ |
| **F4** | `recalculate` 里去掉「先删旧关联行」 | ⚠️ 计划写 S4 | **挂 2 条**（`S6` 的 DRAFT 重算部分 + `重算：新的流水进来后重算，金额跟着变`）。⚠️ **S4 本身没挂** —— S4 管的是**生成**路径，F4 打的是**重算**路径 | ⚠️ 计划正文把两者混为一谈；实测证明「重算路径必须先删旧关联行」 |
| **F5** | `summarizeEntries` 里冲回**再取一次负** | S2 / S5 / S9 | **挂 6 条**（S2、S5、S9、S10 ×2 + 详情明细那条） | ✅ |
| **F6** | `confirm` 的 `updateMany` 去掉 `status` 条件 | S7 | ⚠️ **挂 0 条 —— 34 条全绿** | ❌ **护栏缺口，已补**（见 §四·4.4） |
| **F7** | `generate` 里去掉「周期已结束」校验 | S11 | **挂 1 条**（S11） | ✅ |

**关于 F5 的两层防线**：冲回取负后会变成**正数**，被 `summarizeEntries` 的
「符号不变量断言」（毛额 ≥ 0、冲回 ≤ 0）先挡住 → 抛 `Error` → 500。
e2e 断言的是「返回 200 且金额正确」，500 同样挂 ✅ —— 但**真正挡住它的是断言层**，
公式层本身没有独立的 e2e 保护（它有 57 条纯函数单测保护）。

**关于 F3 的两层**：`generateOne` 里有**两道**与幂等相关的检查 ——
①「先查后插」的前置查；②事务内撞 `(tenantId, periodStart)` 唯一索引后的 P2002 竞态兜底。
F3a 只打掉① → 撞上 `assertEntriesNotSettled`（第三道）→ 409。
**另单独验过「只打掉②」→ 35 条全绿** —— ②只在**并发**场景才走到，
e2e 没有并发用例，所以它**没有独立的回归保护**（见 §六·R8）。

### 4.3 失败注入的复现方法

```bash
# 1. 改文件（例：注入 F1）
#    api/src/modules/billing/settlement.service.ts
#      where: { tenantId, occurredAt: { gte: period.from, lt: period.to } }
#    → 去掉 tenantId
# 2. 跑定向测试
cd api && npm run test:e2e -- settlement
# 3. 恢复（⚠️ 目标文件必须已提交，否则 git checkout -- 会把自己的改动一起抹掉）
cd .. && git checkout -- api/src/modules/billing/settlement.service.ts
# 4. 逐次核实 git status 干净
```

⚠️ 恢复用 `git checkout --` 的前提是**该文件已提交**。本阶段所有被注入的文件
（`settlement.service.ts`、`settlement.ts`）在注入前都已提交 ✅

### 4.4 ⚠️ 注入发现的两处护栏缺口（**已补**）

失败注入的价值就在这里 —— **F2 与 F6 注入后 34 条测试全绿**，说明这两处护栏
当时**没有任何保护**：

| 缺口 | 后果 | 补法 | 复验 |
|------|------|------|------|
| **F2**：区间右闭（`lte: to`）无人拦截 | 恰好落在「次月 1 日 00:00:00.000Z」的流水会被**相邻两期各算一次** → **重复计账** | 新增用例 `⚠️ 恰好落在周期边界那一瞬的流水 → 只被一期结算`：造一笔 `occurredAt === period.to` 的流水，断言本期与下期**各含 1 笔** | ✅ 重新注入 F2 → **挂 1 条** |
| **F6**：`confirm` 去掉 `status` 条件无人拦截 | 已确认的单再次确认时 `updateMany` 影响 1 行 → **`confirmedAt` 被刷新** → 「确认后冻结」被破坏 | 在 S7 用例里补 `expect(second.confirmedAt).toBe(first.confirmedAt)`（⚠️ 两次确认之间先 `sleep 50ms`，否则两次落在同一毫秒会**假通过**） | ✅ 重新注入 F6 → **挂 1 条**（S7） |

---

## 五、发现并修复的缺陷

本阶段共发现并修复 **12 处**。其中 **3 处是阻断级账务风险**（可能算错账或让信息丢失）。

⚠️ **另有 2 处是「护栏缺口」**（不是实现缺陷，而是**测试没锁住**）——
它们是失败注入时翻出来的，详见 §四·4.4。

### 1.【阻断】`Date.UTC` 把 0–99 的年份映射到 1900+年

JS 的 `Date.UTC(1, 0, 1)` 实际是 **1901 年** 1 月 1 日。于是 `resolveMonthlyPeriod('0001-01')`
返回的区间是 1901 年，而 `label` 仍是 `'0001-01'` —— **标签与区间不一致，且全程不报错**，
静默产出一张周期错了一千年的结算单。

**修法**：在 `Date.UTC` **之前**加年份取值域检查 `[1000, 9998]`
（上限留余量，避免终点落到 `+010000-` 这种扩展年份格式）。
实测确认 `0100-01` 也有同样的往返不一致，被同一检查一并解决。

### 2.【阻断】`recalculate` 的 P2002 逃逸成 500

`assertEntriesNotSettledByOthers` 在**事务外**查，与事务之间存在 **TOCTOU 窗口**：
并发 `generate` 抢先把这笔流水结算了 → 事务内 `createMany` 撞 `entryId` 唯一索引
→ P2002 未被捕获 → 被全局异常过滤器吞成 500「服务器内部错误」。
超管完全看不出真实原因是「流水重复结算」。

**修法**：事务外包 `try/catch`；非 P2002 原样重抛；P2002 时**补跑一次**
`assertEntriesNotSettledByOthers` 让它抛 409；若它没抛（说明撞的不是 `entryId`）
则原样重抛 —— **不把别的故障伪装成「重复结算」**。

### 3.【阻断】`recalculate` 会把单据无声重算成「0 元 0 明细」

当期查不到流水时 → `deleteMany` 清空关联行 → `createMany` 空数组不报错
→ 单据变成 `0/0/0, entryCount=0`。这与 `generate` 的语义矛盾（`generate` 在无流水时
是 404 / 静默跳过，**从来不会产出一张空单**）。

⚠️ 这是**静默抹账**的形态 —— 万一 `entriesInPeriod` 的查询条件哪天写错，
单据会被无声清零，**没有任何报错线索**。

**修法**：`entries.length === 0` 时抛 409，**且在进事务之前**（关联行不会被删）。

### 4. 批量生成部分成功，但调用方无从得知哪几张已生成

批量时逐个商家各自提交事务。第 3 个商家命中 409 → **前 2 个商家的单据已落库**，
但整个请求抛 409、不返回任何 `items`。调用方不知道已经生成了哪几张；
重跑会走幂等分支返回旧单，更看不出差异。

**修法**：`GenerateSettlementResult` 加 `conflicts: Array<{tenantId, message}>`；
批量模式下捕获单个商家的 `ConflictException` 记进 `conflicts` 并继续，
成功商家照常进 `items`；**显式点名单个商家时仍直接抛 409**（调用方明确知道是哪家）。
controller 同时显式返回 **200**（而不是 `@Post` 的默认 201）——
这个端点返回的是「一次批量操作的结果」，不是「一个被创建的资源」。

### 5. 幂等复用不核对当期流水

`generateOne` 先查后插命中已有单据时直接返回，**不核对明细是否仍然完整**。
若该期后来又进了流水（例如跑了 `npm run backfill:commissions`），
`generate` 会返回一张**缺笔的旧单**，调用方看到「已复用」就以为「本期已结清」，
实际金额是错的。

**修法**：复用时查一次当期流水比对笔数，不一致则该商家 id 进
`GenerateSettlementResult.stale: string[]`。**只标记、不改单据**
（已 `CONFIRMED` 的单是冻结的，修正要走「取消确认 → 重算」）。

### 6. `unconfirm` 没查 `updateMany` 的 `affected.count`

并发两次 `unconfirm`：两次都读到 `CONFIRMED`，第二次影响 0 行，代码直接忽略。
与 `confirm`（**正确检查了** `affected.count`）实现不对称。将来有 `PAID` 状态时，
同样的写法会让「取消确认一个已出款的单」静默成功。

**修法**：与 `confirm` 对齐 —— count 为 0 时重读状态，按实际状态抛 409。

### 7. DTO 的周期正则与 service 不一致

DTO 的 `/^\d{4}-(0[1-9]|1[0-2])$/` 接受 `0000-01` / `0099-12` / `9999-12`，
而 `resolveMonthlyPeriod` 要求年份 ∈ `[1000, 9998]`。最终都返回 400 不会出错，
但 DTO 的报错文案「周期格式非法」对 `0000-01` 是误导（它格式合法，是年份超范围）。

**修法**：正则收紧为 `/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/`。
复审穷举比对（年份 0–10000 × 月份 6 种）：与 service 的判定 **0 处差异**。

### 8. 迁移文件的索引注释与 SQL 对不上

头部注释写「五个索引」，文件里实际有 **6 条** `CREATE INDEX`
（`settlement_statements` 上 4 条 + `settlement_statement_entries` 上 2 条）。
注释与 SQL 不一致会让人按注释去核对时漏掉一条。

**修法**：改成「六个索引」并附**逐条索引清单**（名字 + 列 + 唯一性）。
复审逐字比对：6/6 与 SQL 一致，三条唯一索引的列与 `schema.prisma` 完全吻合。

### 9. `formatPeriodLabel` 对非法 Date 返回 `'NaN-NaN'`

`getUTCFullYear()` 对 `Invalid Date` 返回 `NaN`，`padStart` 对 `NaN` 不生效 ——
不检查就会返回 `'NaN-NaN'` 这种标签，一路带着它跑到前端。

**修法**：加 `Number.isNaN(periodStart.getTime())` 检查，当场抛错。
⚠️ 抛的是 `Error`（不是 `BadRequestException`）→ 全局过滤器转 **500**。
**这是对的**：`periodStart` 只有两个来源（写入时恒为 `period.from`、读取时是 Prisma `DateTime`），
**都不是用户输入**，非法 Date 只可能是内部构造的 bug。

### 10. 详情页的 404 没有转成 `notFound()`

后端返 404 时，页面把它当普通错误渲染成「加载结算单失败（404）：结算单不存在」，
而不是 Next.js 的 404 页。

**修法**：`catch` 里判 `cause.status === 404` → `notFound()`。

⚠️ **修完仍然没有测试保护**（复审发现）：`settlement-detail-page.test.tsx` 里
`grep "404|notFound"` 零命中。→ 补了一条用例，mock `next/navigation` 的 `notFound`
并断言它被调用。
⚠️ **断言不能直接写 Next 的内部 digest**：App Router 实际抛的是
`NEXT_HTTP_ERROR_FALLBACK;404`（不是 pages router 的 `NEXT_NOT_FOUND;404`）——
断言那个字符串等于把测试焊死在 Next 的实现细节上，升级 Next 就会假红。

### 11. 前端测试形同虚设（3 处）

| # | 问题 | 后果 |
|---|------|------|
| a | 列表页笔数断言 `hasText(texts, '2')` | 单号 `STL202601010000001234` 里含 "2" → 把 `entryCount` 改成 999 照样绿 |
| b | 「非法周期」用例用 `user.type(input, '2026-13')` | jsdom 会把 `type=month` 的非法值清洗成 `""` → 测的是「空值非法」，月份上界分支**从未执行** |
| c | 「取消确认」「重算」只断言 URL，不断言 `method` | 把 `method: 'POST'` 改成 `GET` 照样绿 |

**修法**：(a) 改断言**整个文本节点**（列表页没有「笔」字，不能照抄详情页的 `'2 笔'`）；
(b) 用 `Object.defineProperty` 绕过 jsdom 的清洗（**原生 setter 也会被清洗，只有 defineProperty 能绕过**）；
(c) 各补 `expect(options.method).toBe('POST')`。

⚠️ 三条**都做了注入验证**：改坏实现后确认测试会挂、改回旧写法确认旧写法漏检。
复审再次独立注入验证，结论一致。

### 12. 前端没消费后端新增的 `conflicts` / `stale`

后端修好了「批量部分成功」与「幂等缺笔」，但前端**完全没显示**这两个字段 ——
批量生成时某个商家没能出单、或复用的单据缺笔，界面只说「已新建 2 张结算单」，
**用户无从得知有商家没出单、也不知道金额可能是错的**。

**修法**：`SettlementGenerateResult` 加两个**可选**字段；成功提示追加
「有 N 个商家没能出单（其余商家已出单成功）：<后端消息>」与
「有 N 个已有单据与当期流水对不上（可能缺笔），请到结算单列表里对该单据
『取消确认』后『重算』以修正金额」。

⚠️ 措辞上明确「**部分成功 ≠ 整体失败**」，否则用户会以为全失败了要重做。
⚠️ 后端返回缺字段时（旧响应形状）前端**不能崩** —— 用 `?? []` 兜底，并有专门用例。

---

## 六、已知遗留项（诚实列出）

### 6.1 设计文档既有的（§七 的 L18–L31）

| # | 内容 |
|---|------|
| **L18** | 把平台收入报表切到流水表 —— 5e 留下的。前置是「生产已跑过 `npm run backfill:commissions`」 |
| **L19** | 抽佣出款 —— 本阶段只记账，不出款 |
| **L20** | 回填跳过的历史退款（`refundedAt IS NULL`）永远不会被冲回 |
| **L27** | 已出款的周期被回填 —— 出款阶段必须禁止对已出款的周期做回填，或提供调账机制 |
| **L28** | 结算单明细不分页 —— 量级上来后要分页 |
| **L29** | 商家侧看不到自己的结算单 —— 本阶段只做平台侧 |
| **L30** | 结算单没有导出（CSV / PDF） |
| **L31** | 「漏结流水」的主动告警 —— 现在只有对账护栏在测试里盯着，生产上要靠超管定期对账 |

### 6.2 本阶段新发现的

| # | 内容 | 为什么不修 |
|---|------|-----------|
| **R1** | **批量模式下非 `ConflictException` 的异常会中断整批**：前面的商家已落库，调用方收到 500 且拿不到响应体 | ⚠️ 刻意不修：把真实故障（DB 断连）伪装成业务冲突，比中断更危险。**重跑可恢复视图**（幂等复用会返回已落库的单），不至于永久丢信息 |
| **R2** | `stale` 只比对**笔数**而非金额 | 当前数据模型下 `commissionEntry.amount` 与 `occurredAt` **都不会被改**（全仓无 `update`/`updateMany`/`upsert`）→ 笔数不变则金额必然不变。已在代码注释里写明这个前提；若将来流水可变，要改成比金额 |
| **R3** | `stale` 的元素是裸 `tenantId`（UUID），前端只显示**计数** | 界面上显示 UUID 对超管没有意义。后端可以改成带 `tenantName`，但那是 API 形状变更，超出本阶段范围 |
| **R4** | 复用分支多查一次 `entriesInPeriod`（批量时 N 次） | 实际净增查询 ≤ N（复用分支反而少查了一次明细表）。商家数上千时再考虑一次 `groupBy` |
| **R5** | ⚠️ **`commission_entries.tenantId` 没有外键约束** —— 手测时用一个不存在的 tenantId 插流水**成功了** | 既有事实，不在 5g 范围。结算单的兜底行为救了场（商家查不到时回落成 id + 「—」），但**报表口径可能已经错了**。建议后续给流水表补外键 |
| **R6** | ⚠️ **跨文件干扰**：`tenant-isolation.e2e-spec.ts` 的 `tenant.deleteMany` 会 **Cascade** 删掉 `Order → CommissionEntry` | 既有事实。若该文件与结算单文件**并发**跑，结算单的流水会被删掉 → 随机失败。e2e 必须串行跑 |
| **R7** | `payment-compensation.e2e-spec.ts › 扫描 A：未处理完的事件被重新入队` **偶发失败** | 既有 flake（BullMQ 队列时序）。实施代理在**未改动的干净树上连跑 5 次复现了 2 次**，确认与本次改动无关 |
| **R8** | 两处检查**没有独立的回归防护**：①S4 的服务层前置检查；②`generateOne` 的 P2002 并发竞态兜底 | ⚠️ 实测：只删①（留 P2002 兜底）→ 34 条全绿；只删②（留前置查）→ 35 条全绿；两处都删 → 3 条挂。**护栏最终被覆盖**（有第三道 `assertEntriesNotSettled` 兜底），但前两道各自都靠后面的兜底救回 |
| **R9** | S9 未锁住**报表自身的 `netRevenue` 公式** | 规格说的是「抽佣净额」，用例自己重算 `commissionRevenue − reversal` 是对的。但报表侧若把符号翻过来，S9 测不出来 |
| **R10** | `platform-admin` 有 2 个 eslint warning（`src/app/error.tsx`、`global-error.tsx` 的未使用参数） | 既有遗留，与 5g 无关。**0 error** |
| **R11** | `vi.restoreAllMocks()` 守卫**当前没有任何用例能证明它有效** | 删掉它，17 条仍全绿。它防的是「将来新增的用例忘记 spy `window.confirm`」。防御性代码，不必为它专门造用例 |

---

## 七、交付物清单

### 后端（`api/`）

| 文件 | 说明 |
|------|------|
| `prisma/schema.prisma` | `SettlementStatus` 枚举 + `SettlementStatement` + `SettlementStatementEntry` 两张表 |
| `prisma/migrations/20261028190000_add_settlement_statements/migration.sql` | **手写**的迁移（1 条 CREATE TYPE、2 张表、6 条索引、2 条外键） |
| `src/common/tenant/tenant-models.ts` | 登记 `SettlementStatement`；`SettlementStatementEntry` **刻意不登记**（无 `tenantId`，只能靠 service 层自觉校验） |
| `src/common/tenant/tenant-prisma.service.ts` | 两个新 getter |
| `src/modules/billing/settlement.ts` | 纯函数：周期解析 + 金额聚合 |
| `src/modules/billing/settlement.spec.ts` | 纯函数单测 57 条 |
| `src/modules/billing/settlement.service.ts` | 生成 / 重算 / 确认 / 取消确认 / 查询 |
| `src/modules/billing/settlement.service.spec.ts` | service 单测（手写假 Prisma） |
| `src/modules/billing/dto/create-settlement.dto.ts` / `settlement-list-query.dto.ts` | 请求 DTO |
| `src/modules/billing/platform-settlement.controller.ts` | 6 个端点，`@Roles(PLATFORM_ADMIN)` |
| `src/modules/billing/billing.module.ts` | 纯追加（8 增 0 删） |
| `test/settlement.e2e-spec.ts` | e2e：护栏 S1–S12 + 修复轮的用例 |

### 前端（`platform-admin/`）

| 文件 | 说明 |
|------|------|
| `src/lib/billing.ts` | 类型与标签 |
| `src/app/(dashboard)/settlements/page.tsx` | 列表页 |
| `src/app/(dashboard)/settlements/[id]/page.tsx` | 详情页（404 → `notFound()`） |
| `src/app/(dashboard)/settlements/settlement-actions.tsx` | 客户端组件（生成 / 确认 / 取消确认 / 重算） |
| `src/app/api/billing/settlements/**` | 同源中转路由（4 个） |
| `src/app/(dashboard)/layout.tsx` | 导航加「结算单」（3 行） |
| `test/app/settlements-page.test.tsx` / `settlement-detail-page.test.tsx` / `test/components/settlement-actions.test.tsx` | 页面级与组件级测试 |

### 文档

| 文件 | 说明 |
|------|------|
| `docs/superpowers/specs/2026-10-28-plan-05g-settlement-statement-design.md` | 设计文档 |
| `docs/superpowers/plans/2026-10-28-plan-05g-settlement-statement.md` | 实施计划（含勘误表） |
| `docs/superpowers/plans/2026-10-28-plan-05g-acceptance.md` | **本文件** |

---

## 八、下一阶段

结算单的**记账**闭环已完成（平台侧生成 → 确认 → 可重算 → 查得到，且与收入报表对得上）。

平台侧还差**出款**（L19）：从结算单到「把钱打给商家」。
⚠️ 切之前要先确认「生产已跑过回填」—— **抽佣流水表是 5e 才建的**，
历史订单的流水要靠 `npm run backfill:commissions` 补齐（5f 的 L24 记录了它的两个边界）。

⚠️ 另外两件事的**先后顺序**要注意：
1. **L18（报表切到流水表）** 最好在出款**之前**做 —— 报表口径与结算单口径一致了，出款才对得上账；
2. **L27（已出款的周期被回填）** 是出款阶段必须防的 —— 一旦有已出款的周期被回填，那笔钱就重复了。
