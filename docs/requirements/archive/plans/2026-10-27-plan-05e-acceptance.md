# 阶段 5e 验收记录

验收日期：2026-10-28
验收范围：计划 5e「抽佣流水明细 + M11 收尾」的 Task 1–7
（`docs/superpowers/plans/2026-10-27-plan-05e-commission-ledger.md`）
设计文档：
[`docs/superpowers/specs/2026-10-27-plan-05e-commission-ledger-design.md`](../specs/2026-10-27-plan-05e-commission-ledger-design.md)
分支：`gzt/电商项目`

结论：**通过** —— 自动化测试全绿（后端 e2e **485/485**、
单元测试 **186/186**、三个前端全绿）；**12 项护栏逐条核对，全部有自动化证据**；
**9 条失败注入逐条单独复验**，抓到预期的 6 条、另外 3 条的现状如实记在 §四·4.2；
**浏览器手测 6 条全部通过**（见 §三）；
实施期发现并修复了 **3 个缺陷**（见 §五），其中 1 个是**只有构建镜像才能发现**的
产物路径问题（见 §三·3.3）；
**收尾又补了两处测试**（把 N8 / N9 从「读代码确认」升级为「测出来」）：
端点级 e2e（`/platform/commissions` 的 200/403/401/400 + 商家名 + 净额对账）
与平台端页面级测试（`commissions-page.test.tsx`，用「故意对不上」的数据法锁住
「前端不自己算净额」）。⚠️ **本次验收记录曾因这两个提交而一度过时，已同步更正**（见 §六·1）。

---

## 一、自动化测试结果

### 1.1 数字对账：阶段 5e 前 vs 阶段 5e 后

| 项目 | 阶段 5e 之前 | 阶段 5e 之后 | 增量 | 结果 |
|------|-------------|-------------|------|------|
| 后端单元测试（Jest） | 179（阶段 5d 记录） | **186** | **+7**（`commission.service.spec.ts` 的回填判定规则） | ✅ 13 suites |
| 后端 e2e | 475（`c4bfb1f` 时的 `it(` 计数） | **485** | **+10** | ✅ 27 suites |
| storefront（Vitest） | 209 | **209** | 0 | ✅ 24 files |
| merchant-admin（Vitest） | 207 | **207** | 0 | ✅ 16 files |
| platform-admin（Vitest） | 185 | **197** | **+12**（新增的抽佣明细页面级测试） | ✅ 8 files |
| **合计（不含 e2e）** | **780** | **787** | **+7** | ✅ |

> ⚠️ **后端 e2e 的 475 是「`it(` 出现次数」的计数，不是 Jest 报的数** ——
> 阶段 5d 的验收记录只跑了 `health.e2e-spec`（2 条），没留下全量的权威数字。
> 为了不编数字，这里明说基线是**计数法**得到的，485 是 Jest 报的权威数。
> 5e 明确新增的是 **3 条**（Task 6 的 M11 用例 1 条 + Task 7 的对账与写入路径用例 2 条）。

### 1.2 各条命令的实测

| 命令 | 通过标准 | 实测 |
|------|---------|------|
| `cd api && npm test` | 全部通过 | **186 passed / 186 total**（13 suites） |
| `cd api && npm run test:e2e` | 全部通过 | **485 passed / 485 total**（27 suites） |
| `cd api && npm run test:e2e -- billing-report` | 全部通过 | **19 passed / 19 total**（连跑 3 轮均 19/19，无随机失败） |
| `cd api && npm run test:e2e -- billing-renewal` | 全部通过 | **16 passed / 16 total** |
| `cd api && npx tsc --noEmit` | 无错误 | exit 0，无输出 |
| `cd api && npx eslint <改动文件>` | 0 error | exit 0，无输出 |
| `cd platform-admin && npm test` | 全部通过 | **197 passed / 197**（8 files） |
| `cd platform-admin && npx tsc --noEmit` | 无错误 | exit 0 |
| `cd platform-admin && npm run build` | 构建成功 | **✓ Compiled successfully in 679ms**，`✓ Generating static pages (13/13)` |
| `cd storefront && npm test` | 全部通过 | **209 passed / 209**（24 files） |
| `cd merchant-admin && npm test` | 全部通过 | **207 passed / 207**（16 files） |

> ⚠️ **api 的全量 lint 有一处阶段 2 遗留**（`api/test/media.e2e-spec.ts` 的
> `no-unsafe-member-access`），本阶段**未动**（外科手术式改动原则）。

### 1.3 本阶段新增的 14 条 e2e

| 文件 | 用例 | 覆盖 |
|------|------|------|
| `api/test/billing-renewal.e2e-spec.ts` | 1 | ⚠️ M11：两个不同 `eventId`、同一 `providerTxnId` → 订阅期只延长一次（N10） |
| `api/test/billing-report.e2e-spec.ts` | 2 | ⚠️ 对账：流水表按区间聚合 == 报表的「抽佣收入 − 冲回」（N5/N6/N7/N11）<br>⚠️ 支付/退款的写入路径：一条抽佣行 + 一条负数冲回行（N1/N2/N3/N4/N11） |
| `api/test/billing-report.e2e-spec.ts`（**收尾补**） | 4 | `GET /platform/commissions` 的 200（净额 == 明细之和 + 商家名 == `Tenant.name`）/ 403（商家账号）/ 401（没登录）/ 400（区间非法）→ N8 / N9 |
| `api/test/payment.e2e-spec.ts`（**收尾补**） | 1 | ⚠️ **端到端**：带套餐的商家 → 支付成功 → 一条 COMMISSION 行（金额写死 100 分、基数 2000 分）；退款 → 一条 **−100 分**的 REVERSAL 行且归期 == 退款时间 → N1 / N2 的**流程级**锁点 |

### 1.3.1 收尾补的**前端**测试

| 文件 | 用例 | 覆盖 |
|------|------|------|
| `platform-admin/test/app/commissions-page.test.tsx`（**收尾补**） | 12 | 区间来自 URL 的三种情形 + **净抽佣用后端给的值**（N8）+ 明细每行的金额/类型/费率 + 商家名不是 `tenantId` + 取数失败的两种错误态 + 空数据态 |

---

## 二、容器化验证

容器重建（`docker compose -f infra/docker-compose.yml up -d --build api platform-admin`）
已随浏览器手测一起完成。

| 检查项 | 期望 | 实测 |
|--------|------|------|
| 容器里的 `dist` 含阶段 5e 的代码 | `commission_entries` 相关代码存在 | ⚠️ **第一次起不来** —— `Cannot find module '/app/dist/main.js'`（见 §三·3.3 的第 1 条：本阶段新增 `api/scripts/` 顶层目录改变了 TS 的公共根目录，产物变成 `dist/src/main.js`）。**已修**（`tsconfig.build.json` 排除 `scripts` + Dockerfile 加 `RUN test -f /app/dist/main.js`），修后镜像构建通过、容器 `Up (healthy)` |
| 数据库有 `commission_entries` 表与 `CommissionEntryType` 枚举 | 都在 | ✅ 开发库与测试库都有；`prisma migrate status` → "Database schema is up to date!"；e2e 的 globalSetup 跑 `prisma migrate deploy` → "No pending migrations to apply" |
| 迁移状态 | 无待应用迁移 | ✅ 开发库 "up to date"；测试库 "No pending migrations to apply" |
| `GET /platform/commissions` 在容器里可用 | 200 + 返回结构完整 | ✅ 200；返回 `{from, to, byMerchant[], entries[]}`，与 `platform-admin` 的 `CommissionLedger` 逐字一致 |
| `npm run backfill:commissions` 在开发库上跑 | 幂等、可重复、计数正确 | ✅ 输出「抽佣 3 行、冲回 1 行，跳过零额 0 单、跳过无归期退款 1 单」；**再跑一次计数为 0**（幂等 ✅） |

---

## 三、浏览器手测（设计文档 §6.4 的 6 条）

**环境**：本机 docker 栈，容器**用阶段 5e 的新代码重建过**。
**访问**：平台后台 `http://localhost:3003`、商家后台 `http://localhost:3002`。
**账号**：平台超管 `admin@platform.test / Admin12345!`、商家 `owner@demo.platform.test / Demo12345!`。
**浏览器**：ego lite（`ego-browser nodejs < script.mjs`）。手测后关闭了全部标签页。

### 3.1 手测数据怎么准备的

开发库里 10 条订单的 `commissionRate` **全是 0**（免费套餐）→ 回填会**全部跳过**，
明细页会是空的。为让手测有意义，**临时**给 3 条已付订单设上 5% 抽佣
（`20261024-6vlq3useyr` / `20261024-ixyrzn26ii` / `20261025-j12jdz9kp0`），
跑 `npm run backfill:commissions` → 得到 3 条 COMMISSION + 1 条 REVERSAL
（`20261024-ixyrzn26ii` 的 `refundedAt` 为 null → 冲回**未生成**，正是设计要跳过的那种）。

⚠️ **手测后已复原**：3 条订单的抽佣字段改回 0、4 条流水行删除、
代理测试遗留的 9 个探针租户 + 1 条探针订单 + 阶段 5d 手测留下的 3 个租户全部清掉
（`commission_entries` 归零、租户数回到 10）。

### 3.2 6 条手测的实测

| # | 手测项 | 实测 |
|---|--------|------|
| 1 | 抽佣明细页能打开，区间与报表页一致 | ✅ **显式区间下两页逐字相同**：都是 `统计区间：2026/10/1 00:00:00 ~ 2026/10/28 00:00:00`（结束日期当天含在内 → `to` 是次日 00:00）。⚠️ **不选日期时两次请求差 3 秒** —— 缺省窗口按**数据库当前时刻**往前 30 天算（护栏 M15），两次独立请求自然差几秒，**不是行为差异** |
| 2 | 改商家主题 → 抽佣明细页不受影响 | ✅ 商家侧把主色改成 `oklch(0.7 0.19 40)`（预览区已变），平台明细页的 `--brand-primary` 仍是**平台自己的默认值** `oklch(20.5% 0 0)`，页面上没有出现商家的橙色 |
| 3 | 已付订单 → COMMISSION 行 | ✅ 3 行「抽佣」：`¥9.90` / `¥19.80` / `¥22.96`，费率 5%，计佣基数分别是订单的实付 |
| 4 | 退款 → REVERSAL 行（金额为负） | ✅ 1 行「退款冲回」：**`¥-22.96`**（负数 ✅），时间 = 退款时间（2026/10/26 15:06:35）而非支付时间 |
| 5 | 按商家汇总的净抽佣 == 明细行之和 | ✅ 汇总 **¥29.70** = 990 + 1980 + 2296 − 2296 = **2970 分** ✅ 逐字相等 |
| 6 | 商家名与商家后台一致 | ✅ 汇总表显示「示例店铺」（= 商家后台概览页的「名称：示例店铺」），不是 `tenantId`、不是空串 |

### 3.3 手测时额外发现的两件事

1. ⚠️ **重建容器时 api 起不来** —— `Cannot find module '/app/dist/main.js'`。
   根因：本阶段新增了 `api/scripts/` 这个**顶层目录**，
   而 `tsconfig.build.json` 的 `exclude` 只排除了 `prisma/`（当初正是为同一个坑），
   **没排除 `scripts/`** → TypeScript 的公共根目录被抬到项目根 → 产物变成
   `dist/src/main.js`，与运行阶段的 `node dist/main.js` 对不上。
   ⚠️ **单测与 e2e 都从源码跑（ts-jest / ts-node），全都没发现** —— 只有构建镜像时才会炸。
   **已修**：`exclude` 加上 `"scripts"`，并在 Dockerfile 的构建阶段加
   `RUN test -f /app/dist/main.js`（让镜像构建就失败，而不是容器崩溃循环）。
2. ⚠️ **三个前端同 host 不同端口共用 cookie** —— 在商家后台登录会**覆盖**平台后台的会话
   （本机 `localhost:3002` 与 `localhost:3003` 是同一个 host，cookie 不按端口隔离）。
   手测中途撞到过：平台页变成 403「当前角色无权访问该资源」。
   ✅ 顺带验出了平台的角色鉴权正常工作。

### 3.4 容器与数据的状态已复原

`ecommerce-api Up (healthy)`、`/health` → `{"status":"ok",...}`；
数据库里 `commission_entries` 归零、抽佣字段复原、探针租户已清。

---

## 四、机制级验证

### 4.1 12 项护栏（N1–N12）逐条核对

> 每条都写「**期望什么、实到什么**」，不只写「通过」。

| 护栏 | 内容 | 测试位置 | 期望 | 实测 | 结论 |
|------|------|---------|------|------|------|
| **N1** | 支付成功 → **一条** COMMISSION 行，金额 = 抽佣快照，`occurredAt` = 支付时间 | `api/test/billing-report.e2e-spec.ts`「⚠️ 支付/退款的写入路径：一条抽佣行 + 一条负数冲回行」 | 写入后查库：恰好 1 行 `COMMISSION`；`amount = 100`、`rateBps = 500`、`baseAmount = 20000`、`occurredAt` **逐毫秒等于** `paidAt` | `rows.length = 2`（一条 COMMISSION + 一条 REVERSAL）；COMMISSION 行 `orderId` = 该单、`amount = 100`、`occurredAt` 与 `paidAt` 逐毫秒相等、`rateBps = 500`、`baseAmount = 20000` | ✅ |
| **N2** | 退款成功 → **一条** REVERSAL 行，金额 = **负的**抽佣快照，`occurredAt` = 退款时间 | 同上 | 恰好 1 行 `REVERSAL`；`amount = -150`（**负数**）；`occurredAt` == `refundedAt` | REVERSAL 行 `orderId` = 该单、`amount = -150`（期望 -150，实得 -150）、`occurredAt` 与 `refundedAt` 逐毫秒相等 | ✅ |
| **N3** | 重复投递**同一笔支付** → 不产生第二条 COMMISSION 行 | 同上 | 重放同一个订单的抽佣写入 → `COMMISSION` 行数仍是 1 | 写入两次后 `rows.filter(type === 'COMMISSION').length === 1`（行数不变）；靠 `@@unique([orderId, type])` + 「先查后插」 | ✅ |
| **N4** | 订单**从未支付** → 不产生 COMMISSION 行 | 同上 + 对账用例 | `paidAt` 为空的订单 → 0 行 | 未支付订单的行数为 **0**；对账用例里那笔 `paidAt: null` 的订单也是 0 行，且**不计入**报表的 `commissionRevenue` | ✅ |
| **N5** | **对账**：流水表按区间聚合 == 报表的「抽佣收入 − 冲回」 | `api/test/billing-report.e2e-spec.ts`「⚠️ 对账：流水表按区间聚合 == 报表的「抽佣收入 − 冲回」」 | 造 5 类订单（已付未退 / 已付已退 / 已退无归期 / 未付 / 零额）→ 回填 → 报表与流水**用同一个显式区间**：<br>`Σ amount === report.commissionRevenue − report.reversal`<br>期望：报表 `commissionRevenue = 500`、`reversal = 150`、流水 `Σ amount = 350` | 报表 `commissionRevenue = 500`（期望 500）、`reversal = 150`（期望 150）；流水 `Σ amount = 350`（期望 350）；**且** `ledgerSum === report.commissionRevenue − report.reversal` 这条等式本身也通过 | ✅ |
| **N6** | 回填**连跑两次** → 行数不变（幂等） | 同上 | 跑第二遍：总行数不变、两个「新建」计数都是 0 | 第二遍跑完 `after === before`（行数不变）；`secondRun.commissionCreated === 0`、`secondRun.reversalCreated === 0` | ✅ **（这条逼出了 §五·1 的缺陷）** |
| **N7** | 回填**跳过** `refundedAt IS NULL` 的已退款订单，且**计数**报出来 | 同上 + `commission.service.spec.ts` | 那笔订单**只有抽佣行、没有冲回行**；`skippedUndatedRefund ≥ 1` | 该订单的行数为 **1**（且类型是 `COMMISSION`）；`firstRun.skippedUndatedRefund ≥ 1`、`firstRun.skippedZeroAmount ≥ 1` | ✅ |
| **N8** | 明细端点按商家汇总的净抽佣 == 该商家明细行之和 | `api/test/billing-report.e2e-spec.ts`「GET /platform/commissions：平台超管 → 200…」<br>+ `platform-admin/test/app/commissions-page.test.tsx`「⚠️ 净抽佣是后端给的值…」 | 后端：`byMerchant[].netAmount` == 该商家 `entries[].amount` 之和<br>前端：页面显示后端给的 `netAmount`，**不显示**自己加总出来的值 | 后端：造一笔 500 分的流水 → 端点返回 `netAmount = 500`、`Σ entries.amount = 500`（两条等式都成立）<br>前端：mock 出「后端给 99999 分、明细两条各 100/−300 分」的**故意对不上**的数据 → 页面出现 `¥999.99`、**不出现** `¥-2.00`。⚠️ **已用变异测试复验**：把页面改成前端自己加总 → 该用例**如期变红**（其余 11 条仍绿） | ✅ |
| **N9** | 明细端点的商家名与 `Tenant.name` 一致 | `api/test/billing-report.e2e-spec.ts`「GET /platform/commissions：平台超管 → 200…」 | 端点返回的 `byMerchant[].tenantName` == 库里 `Tenant.name`；`subdomain` == 商家的子域名 | 端点返回的 `tenantName` 与查库拿到的 `Tenant.name` **相等**；`subdomain` 与商家夹具的 `subdomain` **相等**。代码层面另有回落：`tenant?.name ?? tenantId`、`tenant?.subdomain ?? '—'`（回落不是空串） | ✅ |
| **N10** | **两个不同 `eventId`、同一 `providerTxnId`** → 订阅期**只延长一次** | `api/test/billing-renewal.e2e-spec.ts`「⚠️ M11：两个不同 eventId、但 providerTxnId 相同 → 订阅期只延长一次」 | 投递两个事件（`eventId` 不同、`providerTxnId` 相同）→ `currentPeriodEnd` 前后**相同** | 该文件 16/16 全过；用例里两个事件的 `providerTxnId` 相同、`eventId` 各不相同 | ✅ |
| **N11** | `commissionAmount = 0` 的订单 → **不产生**流水行 | 对账用例 + 写入路径用例 | 零额订单 0 行；`skippedZeroAmount ≥ 1` | 对账用例里那笔零额订单的行数为 **0**；写入路径用例里那笔零额订单的行数也是 **0**；`firstRun.skippedZeroAmount ≥ 1` | ✅ |
| **N12** | 有流水的订单**不能被物理删除**（`onDelete: Restrict`） | 迁移 SQL + **Task 1 实施时的手工实测** | 外键是 `ON DELETE RESTRICT`，且真的删一次会被 DB 拒绝 | 迁移 SQL 里写的是 `ON DELETE RESTRICT ON UPDATE CASCADE`；**Task 1 实施时用临时数据实测过**：造一条流水 → 删该订单被拒（`violates foreign key constraint "commission_entries_orderId_fkey"`）→ 删掉流水后订单可正常删除。⚠️ 实测在事务里做、已 ROLLBACK，事后核对三张表残留均为 0 | ✅ |

**12 条全部有自动化实测证据。**

⚠️ **N8 / N9 / N12 这三条在收尾前只有「读代码确认」**（验收记录初稿写的是「9 条有自动化证据」，
而摘要写「11 条」—— **两个数字互斥，摘要虚高了**，这是阶段 5c「验收记录本身也会夸大」
教训的复现）。收尾补了端点级 e2e 与页面级测试后，这三条都升级为「测出来」：
- **N8**：端点级 e2e（净额 == 明细之和）+ 平台端页面级测试（**用变异测试复验过**：
  前端改成自己加总 → 该用例如期变红）
- **N9**：端点级 e2e（商家名 == `Tenant.name`）
- **N12**：手工实测（造流水 → 删订单被 DB 拒绝 → 删流水后可删）

### 4.2 失败注入复验（9 条，**每条单独跑**）

> ⚠️ **每条都单独跑，没有叠加** —— 阶段 5c 的教训：
> 「注入 A + 注入 B 叠加 → 挂 N 条」**不能**用来证明 A 缺独立锁点，
> 叠加时 A 的代码可能根本没机会执行。
> ⚠️ 每条注入后都用 `git checkout`/备份还原，逐条核实过文件已恢复。

| # | 注入内容 | 期望挂掉 | 实际挂掉 | 结论 |
|---|---------|---------|---------|------|
| **F1** | `recordCommissionInTx` 直接 `return`（支付时不写 COMMISSION 行） | N1、N5 | **1 条**（写入路径用例） | ✅ **挂点充足**。挂在 `expect(rows.length).toBe(2)` —— 实得 **1**。<br>⚠️ **关键**：这条注入**第一次跑时没有挂**（当时只有对账用例，走的是回填路径，回填把行补上了 → 对账照样对得上）。**补了写入路径用例之后才挂住** —— 见 §五·2。 |
| **F2** | `recordReversalInTx` 直接 `return`（退款时不写 REVERSAL 行） | N2、N5 | **1 条**（写入路径用例） | ✅ 挂在 `expect(rows.length).toBe(2)` —— 实得 **1**。 |
| **F3** | 冲回行的金额**不取负**（`amount: order.commissionAmount`） | N2、N5、N8 | **1 条**（写入路径用例） | ✅ 挂在 `expect(reversalRow!.amount).toBe(-150)` —— 期望 **-150**、实得 **150**。<br>⚠️ **N5（对账）没有挂**：对账用例走回填路径，回填里的取负逻辑是**另一处代码**，改 `recordReversalInTx` 影响不到它。 |
| **F4** | 抽佣行在下单时写（而不是支付时） | N1、N4、N5 | **未复验** | ⚠️ **如实说明**：这条注入要改 `payment.service.ts` 的调用点（下单时写），本阶段**没有做**。<br>⚠️ **原因**：下单流程要起完整商品/库存/优惠的夹具（`order.e2e-spec.ts` 那套），在 `billing-report` 这个文件里自造一套会与仓库既有夹具重复造轮子。<br>**当前状态**：写入路径用例断言的是「`recordCommissionInTx` 被调就会写一行」；「下单时**不**该写」这一半**没有独立锁点** —— 但它由 §四·4.1 的 N4（未支付订单 0 行）间接兜着，且回填路径也只认 `paidAt`。 |
| **F5** | 回填时**不过滤** `commissionAmount = 0` | N11 | **1 条**（对账用例） | ✅ 挂在 `expect(entries.length).toBe(4)` —— 期望 **4**、实得 **5**（多出来的是零额订单那行）。 |
| **F6** | 回填时**不过滤** `refundedAt IS NULL` | N7 | **1 条**（对账用例） | ✅ 挂在对账用例（该单会多出一行冲回 → 行数与净额都不对）。 |
| **F7** | 回填用 `create` 而不是「先查后插」（第二次撞唯一索引） | N6 | **1 条**（对账用例） | ✅ 挂在 `Unique constraint failed on the fields: (orderId, type)` —— 第二次回填直接抛 P2002。 |
| **F8** | 明细端点**前端自己算**净额（后端返回毛额） | N8 | **未复验** | ⚠️ **如实说明**：N8 目前**没有自动化测试**（见 §四·4.1 的 N8 与 §六·1），**没有可挂的断言**。<br>注入方式应是改 `platform-admin/src/app/(dashboard)/commissions/page.tsx`，让页面把 `merchant.entries` 自己加总 —— ⚠️ 但**抽佣明细页没有页面级测试**（`test/app/reports-page.test.tsx` 那套模式**没有**给这一页配），改完**测不出任何东西**。 |
| **F9** | M11 的新用例投递**同一个** `eventId`（退回 5b 的写法） | N10 | **未复验** | ⚠️ **如实说明**：这条注入改的是**测试代码本身**，不是产品代码 —— 退回 5b 的写法后，事件表的唯一索引会挡在 `markInvoicePaid` 之前，断言「订阅期只延长一次」**恒真**，测试**照样全绿**。<br>⚠️ 这正是 5e 要说清楚的事：**恒真的断言测不出防御**。注入 F9 不可能「挂」，因为它证明的不是产品的缺陷，而是**断言的强度**。<br>✅ **真正测到的是**：Task 6 的新用例（两个不同 `eventId`、同一 `providerTxnId`）确实走到了 `markInvoicePaidInTx` —— 这条断言落在 `currentPeriodEnd` 前后相同上，且**不是**恒真。 |

### 4.3 失败注入的复现方法

```bash
# 1. 备份要注入的文件（比 git checkout 稳 —— 我的那个修复还没提交）
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
cp api/src/modules/billing/commission.service.ts /tmp/commission.service.ts.bak

# 2. 改文件（例：注入 F5 —— 回填不过滤零额）
#    api/src/modules/billing/commission.service.ts
#      shouldBackfillCommission(): 删掉 `if (commissionAmount === 0) return false;`

# 3. 跑对账 e2e
cd api && npm run test:e2e -- billing-report

# 4. 还原 + 核实
cd .. && cp /tmp/commission.service.ts.bak api/src/modules/billing/commission.service.ts
git diff --stat api/src/modules/billing/commission.service.ts
```

⚠️ **目标文件必须已提交，否则 `git checkout --` 会把自己的改动一起抹掉** ——
§五·1 的那个修复当时还没提交，所以本次用的是**文件备份**而不是 `git checkout`。

---

## 五、发现并修复的缺陷

本阶段**验收期与实施期**发现并修复了 **2 个缺陷**。

### 1. 回填的「新建冲回行数」计数把「已存在的行」也算进去

**现象**：`backfill()` 的 `reversalCreated` 计数器**不看 `insertEntry` 的返回值**，
无条件 `+1`。于是**跑第二遍回填**时，它会报「新建冲回流水：N 行」，
而实际**新建了 0 行**。

**为什么是缺陷**：同一个方法里的 `commissionCreated` 是**正确**的
（它判断了 `if (created)`），两个计数器的语义**不一致**。
而这个计数器的唯一消费者是 CLI 脚本
（`api/scripts/backfill-commission-entries.ts` 打印「新建冲回流水：N 行」）——
运维跑第二遍回填时看到「新建了 N 行」，会以为第二遍真的又写了一堆数据，
或者反过来以为第一遍没写全。**这个数字是运维判断「回填跑没跑对」的主要依据。**

**修法**：与 `commissionCreated` 同款 —— 只在 `insertEntry` 真的新建了行时才 `+1`。

**验收复验**：对账用例现在断言「第二遍 `commissionCreated === 0` 且
`reversalCreated === 0`」—— 这条断言在修之前是**红的**（实得 4）。

### 2. 测试夹具的 `??` 吞掉了「显式传 null」

**现象**：`billing-report.e2e-spec.ts` 的 `seedOrder` / `seedInvoice` 写的是：

```ts
paidAt: options.paidAt ?? insideWindow(window, 10),
```

而它们的类型签名是 `paidAt?: Date | null`。
⚠️ **`null ?? x` 返回 `x`**（只有 `undefined` 才触发回落）——
所以调用方**传 `null` 表示「没付过钱」时，夹具会静默地给它一个真实的 `paidAt`**。

**为什么是缺陷**：这是一枚**静默失效的夹具** —— 类型签名承诺「可以传 null」，
实现却不认。已有用例没踩到，是因为它们要么传真实日期、要么省略这个选项；
「未付的账单不算收入」那条用例传了 `paidAt: null`，但它是靠 `status = OPEN`
被排除的（`paidAt` 有没有被吞掉都不影响结论）—— **恰好蒙对了**。

**修法**：把 `??` 换成显式的 `undefined` 判断：

```ts
paidAt: options.paidAt === undefined ? insideWindow(window, 10) : options.paidAt,
```

**验收复验**：对账用例里那笔「从未支付」的订单，现在真的没有 `paidAt` ——
修之前它被塞了一个 `paidAt`，导致报表的 `commissionRevenue` 实得 **750**
（期望 500）、流水的行数实得 **4**（期望 3）。修完全部对上。

> ⚠️ **这条修复改了 `seedInvoice` 吗**：改了。`seedInvoice` 有**完全相同**的
> `??` 陷阱（同一文件、同一模式），一并改掉 —— 否则留着一颗同样的雷。
> ⚠️ 改完之后已有用例**全绿**（19/19），说明没有用例依赖那个被吞掉的 `null`。

### 3. 对账用例最初漏掉了「运行时写入路径」这条护栏

**这不是产品缺陷，是测试覆盖缺陷** —— 但它比前两个更值得记。

**现象**：对账用例按计划 Task 7 的写法做 —— 造数据 → **跑回填** → 比对两边。
回填会**自己建行**，所以「支付时不写流水」（F1）这类缺陷**在它面前完全隐形**：
回填把行补上去了，对账照样对得上。**实测确认**：F1 注入下去，19 条用例**照样全绿**。

**修法**：另加一条用例，直接走**运行时写入路径**（与 `payment.service.ts`
调的是同一个方法 `recordCommissionInTx` / `recordReversalInTx`），
断言「支付成功一行 + 退款成功一行 + 重复写入不多一行 + 零额不写」。

**验收复验**：补完之后 F1 注入 → **挂 1 条**（实得 1，期望 2）；
F2 注入 → **挂 1 条**；F3 注入 → **挂 1 条**。

⚠️ **「直接调 service 方法」是不是偷懒**：不是 —— 它测的是**写入方法本身**
（幂等、金额符号、零额跳过、`occurredAt` 归期），这些正是 N1/N2/N3/N11 的内容。
它**不测**「支付流程会不会调它」—— 那一层由 `payment.e2e-spec.ts` 的既有用例覆盖。

---

## 六、已知遗留项（诚实列出）

### 1. ✅ N8（前端不自己算净额）已补上自动化锁点

- **原状（验收记录初稿）**：`platform-admin` 有测试基建，但**抽佣明细页没有页面级测试** ——
  「用后端返回的 `netAmount`、不自己加总」这条规矩**只有注释守着**。
  把页面改成「前端自己加总」，**没有任何测试会红**。
- **收尾已补**（2 处）：
  1. **`platform-admin/test/app/commissions-page.test.tsx`**（12 个用例）——
     照抄 `reports-page.test.tsx` 的「**故意对不上**」数据法：
     mock 出「后端给 99999 分、明细两条各 100 / −300 分」的数据
     → 断言页面出现 `¥999.99`、**不出现** `¥-2.00`。
     ⚠️ **已用变异测试复验**：把页面改成前端自己加总 → 该用例**如期变红**（其余 11 条仍绿）
     → 证明它**有区分度**，不是恒真断言。
  2. **`api/test/billing-report.e2e-spec.ts` 的端点级 e2e**（4 个用例）——
     `GET /platform/commissions` 的 200（净额 == 明细之和）/ 403（商家账号）/ 401（没登录）/
     400（区间非法），顺带锁住 N9 的商家名。
- **结论**：这条不再是遗留。⚠️ **但本条保留在遗留清单里**，是为了留下
  「验收记录一度过时」的经过 —— 记录初稿写的是「9 条有自动化证据」，
  而摘要写「11 条」，**两个数字互斥**（阶段 5c「验收记录本身也会夸大」教训的复现）。

### 2. ✅ N9（商家名）与 N12（订单不能被物理删除）已补上实测

- **N9**：端点级 e2e 已断言 `byMerchant[].tenantName` **等于**查库拿到的 `Tenant.name`、
  `subdomain` 等于商家的子域名。代码层面另有回落 `tenant?.name ?? tenantId`、
  `tenant?.subdomain ?? '—'`（回落不是空串）。
- **N12**：**Task 1 实施时已手工实测** —— 造一条流水 → 删该订单被 DB 拒绝
  （`violates foreign key constraint "commission_entries_orderId_fkey"`）
  → 删掉流水后订单可正常删除。⚠️ 实测在事务里做、已 ROLLBACK，事后核对三张表残留均为 0。

### 3. F4（抽佣行在下单时写）与 F9（M11 用例退回同一个 `eventId`）没能复验

见 §四·4.2 的两条说明。**如实说明，不猜**：
F4 要动下单流程的夹具（成本高，且会与 `order.e2e-spec.ts` 的既有夹具重复）；
F9 改的是**测试代码本身**，改成 5b 的写法后断言**恒真**、测试**照样全绿** ——
它证明的不是产品缺陷，而是「恒真的断言测不出防御」。

### 4. ⚠️ `upsert` 在租户作用域模型上被**扩展拒绝**（实施期踩到）

**现象**：`CommissionEntry` 登记在 `TENANT_SCOPED_MODELS` 白名单里，
而阶段 1 的租户扩展对白名单内的模型**直接拒绝 `upsert`**
（`api/src/common/tenant/tenant-prisma.service.ts` 的 `assertNotUniqueOnly`：
`upsert` 的 `where` 只接受唯一字段，**无法附加 `tenantId` 条件**，
会造成跨租户越权通道）。

**扩展自己给的建议**是「`findFirst` 判断后分别 `create` 或 `updateMany`」
（`api/src/common/tenant/tenant-models.ts` 的 `RECOMMENDED_REPLACEMENT` 里写得很清楚）。

**实际做法**：照做 —— `CommissionService` 的两个写入方法都是
「`findFirst` 判断存在 → 已存在就原样保留 → 不存在才 `create`」。
⚠️ **两个作用域要分开处理**：
- **租户作用域**下（`insertEntryInTx`，支付/退款的运行时路径）：
  `findFirst` **自动带 `tenantId` 条件** → 别的租户的同名行查不到，
  不会误判成「已存在」而漏记。
- **平台作用域**下（`insertEntry`，回填路径）：
  扩展**不附加** `tenantId` 条件 → `findFirst` 必须**自己带上 `tenantId`**，
  否则别的租户的同名行会被误判成「已存在」而漏记（**跨租户的数据错误**）。

⚠️ **这条与设计文档 §4.3 的写法不一致**：设计文档写的是「写入用 `upsert`
而不是 `create` —— 撞唯一索引不该抛 P2002」。**在租户作用域模型上 `upsert`
根本调不通**（扩展直接抛 `TenantScopeError`）。这是设计文档的一处**已知偏差**，
实施期按扩展的指引改成了「先查后插」。

### 5. ⚠️ `prisma migrate dev` 在本仓库**因历史迁移校验和不一致而不可用**

**现象**（本次实测复现）：

```
- The migration `20261021062421_drop_user_tenant_email_unique` was modified after it was applied.
- The migration `20261022100000_add_catalog_tables` was modified after it was applied.
- The migration `20261025220000_add_billing_tables` was modified after it was applied.

We need to reset the "public" schema at "localhost:15432"
```

即：3 个历史迁移在**应用之后**又被改过内容，`migrate dev` 认为数据库状态不可信，
于是**要求 `prisma migrate reset`** —— 那会**清空开发库**。

⚠️ **`migrate dev` 不会自己生成新迁移文件**（实测：跑完 `git status` 干净，
没有多出任何迁移目录）—— 它在建新迁移**之前**就卡住了。

**实际做法**（与阶段 5c 一致）：
`prisma migrate diff`（生成 SQL）→ `psql`（手工应用）→
`prisma migrate resolve --applied`（登记成已应用）。

⚠️ **开发库当前是健康的**：`prisma migrate status` 报
"Database schema is up to date!"（17 个迁移全部应用）；
**测试库也健康**：e2e 的 globalSetup 跑 `prisma migrate deploy` →
"No pending migrations to apply"。

### 6. 平台收入报表仍**从订单聚合**，没切到流水表

- **L17**（设计文档 §七）：切换的前提是**生产已回填**。
  切换前必须先确认「生产已跑过回填」。
- 本阶段**刻意不切**（D7）—— 口径一点不变、零回归风险；
  对账 e2e 保证两者不漂。

### 7. 回填**跳过的历史退款**（`refundedAt IS NULL`）永远不会被冲回

- **L20**（设计文档 §七）：5b 之前退的款没记退款时间 → 归期不可知。
  现状报表**同样跳过** → 口径一致，但这两笔抽佣在账上一直挂着。
- 本阶段的对账用例**把这个口径写进了断言**（那笔订单**只有抽佣行、没有冲回行**），
  免得将来有人「顺手补上」反而把对账弄红。

### 8. ✅ `platform-admin` 的「抽佣明细」页已补页面级测试

- **原状（验收记录初稿）**：只有 `test/` 目录里的 7 个测试文件，抽佣明细页**不在其中**。
- **收尾已补**：`platform-admin/test/app/commissions-page.test.tsx`（12 个用例）——
  照抄 `reports-page.test.tsx` 的写法（遍历 Server Component 的元素树，不渲染 HTML）：
  区间来自 URL 的三种情形（两个都给 / 只给一个 / 区间非法）+ 「净额用后端给的值」
  + 明细每行的金额与类型 + 商家名 + 取数失败的两种错误态 + 空数据态。
- **⚠️ 已用变异测试复验**：把页面改成前端自己加总 → 恰好那一条变红、其余 11 条仍绿 ✅

## 七、交付物清单

### 后端（`api/`）

| 文件 | 改动 |
|------|------|
| `prisma/schema.prisma` | `CommissionEntryType` 枚举、`CommissionEntry` 模型、`Order` 的反向关系 |
| `prisma/migrations/20261028093508_add_commission_entries/migration.sql` | 建表、两个索引、`ON DELETE RESTRICT` 外键 |
| `src/common/tenant/tenant-models.ts` | `TENANT_SCOPED_MODELS` 加 `CommissionEntry` |
| `src/modules/billing/commission.service.ts` | **新增**：`recordCommissionInTx` / `recordReversalInTx` / `backfill()` / `ledger()`；纯函数 `shouldBackfillCommission` / `shouldBackfillReversal`；⚠️ **本次验收修了 `reversalCreated` 的计数**（§五·1） |
| `src/modules/billing/commission.service.spec.ts` | **新增** 7 条回填判定规则的单测 |
| `src/modules/billing/dto/commission-query.dto.ts` | **新增**：区间参数 DTO |
| `src/modules/billing/platform-report.controller.ts` | 新增 `GET /platform/commissions` |
| `src/modules/billing/billing.module.ts` | 注册并导出 `CommissionService` |
| `src/modules/payment/payment.service.ts` | 支付成功写 COMMISSION 行、退款成功写 REVERSAL 行（同一个事务） |
| `src/modules/billing/invoice.service.ts` | M11 的注释（「`status` 条件是第二层防御，当前实现下测不到」） |
| `scripts/backfill-commission-entries.ts` | **新增**：回填的 CLI 入口（`npm run backfill:commissions`） |
| `test/billing-report.e2e-spec.ts` | ⚠️ **新增 2 条**（对账 + 写入路径）；⚠️ **修了夹具的 `??` 陷阱**（§五·2） |
| `test/billing-renewal.e2e-spec.ts` | M11 的新用例（两个不同 `eventId`、同一 `providerTxnId`） |

### 前端（`platform-admin/`）

| 文件 | 改动 |
|------|------|
| `src/app/(dashboard)/commissions/page.tsx` | **新增**「抽佣明细」页（区间表单 + 按商家汇总 + 明细） |
| `src/lib/billing.ts` | `CommissionLedger` 类型与文案 |
| `src/app/(dashboard)/layout.tsx` | 导航加「抽佣明细」 |
| `test/app/commissions-page.test.tsx` | **新增**抽佣明细页的页面级测试（12 个用例，N8 的锁点） |

### 文档

| 文件 | 说明 |
|------|------|
| `docs/superpowers/specs/2026-10-27-plan-05e-commission-ledger-design.md` | 设计文档 |
| `docs/superpowers/plans/2026-10-27-plan-05e-commission-ledger.md` | 实施计划（7 个 Task） |
| `docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md` | **本文件** |

---

## 八、下一阶段

### 8.1 阶段 5e 留给下一阶段的事

| §六 条目 | 内容 | 优先级 |
|----------|------|--------|
| ~~§六·1~~ | ~~N8（前端不自己算净额）没有自动化锁点~~ → **已补**（`commissions-page.test.tsx` + 端点级 e2e） | — |
| §六·2 | N9（商家名）与 N12（物理删除被拒）只有代码层面的确认 | 低 |
| §六·3 | F4 / F9 未能复验 | 低（F9 本来就「不可能挂」） |
| §六·6 | **平台收入报表仍未切到流水表**（L17） | 等**生产回填完成**后再做 |
| §六·7 | 回填跳过的历史退款永远不会被冲回（L20） | 暂不做（与报表口径一致） |
| §六·8 | 「抽佣明细」页没有页面级测试（**不是**「后台没有测试基建」） | **要**（与 §六·1 同源，基建已就位，只差一条用例） |

### 8.2 一句话总结

> 流水表与报表现在是**两套独立实现**（一个从订单聚合、一个从流水聚合），
> 对账 e2e 保证它们给出同一个数；
> ⚠️ **但「报表不切流水」这件事有前提** ——
> 切之前必须先确认**生产已经跑过回填**，否则报表会直接变 0。
