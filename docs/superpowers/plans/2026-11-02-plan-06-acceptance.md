# 阶段 6「渠道适配层与沙箱」验收记录

> **设计**：`docs/superpowers/specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md`
> **计划**：`docs/superpowers/plans/2026-11-02-plan-06-channel-adapter-sandbox.md`
> **验收日期**：2026-11-03

---

## 一、交付范围

计划拆成 6a / 6b / 6c 三个可独立合并的里程碑，共 17 个 Task：

| # | Task | 里程碑 | 状态 | 落点（commit） |
|---|------|--------|------|----------------|
| 1 | 渠道描述符与支付/出款注册表 | 6a | ✅ | `4ce6096` |
| 2 | 渠道配置与生产环境启动校验 | 6a | ✅ | `4ce6096` |
| 3 | 支付能力门控与 webhook 渠道路由 | 6a | ✅ | `4ce6096` |
| 4 | 平台默认渠道设置与超管后台（迁移 A） | 6a | ✅ | `4ce6096` / `4178904` |
| 5 | 商家默认出款渠道与账户页（迁移 B） | 6a | ✅ | `3a143b3` / `4178904` |
| 6 | 出款按 `payoutChannel` 路由并解析默认渠道 | 6a | ✅ | `3a143b3` |
| 7 | 对账按渠道隔离 + CSV 自动纠正闸 + 批量确认 | 6a | ✅ | `3a143b3` / `4178904` |
| 8 | `PayoutProvider` 契约改造（`submit` / `queryPayout` + `definitive`） | 6b | ✅ | `42dc17d` |
| 9 | worker 处理 `PROCESSING` 与 `definitive` | 6b | ✅ | `42dc17d` |
| 10 | `scanStuck` 按渠道轮询卡住的单 | 6b | ✅ | `6ee22b1` |
| 11 | 沙箱 provider + HTTP mock 服务 | 6b | ✅ | `29fb429` |
| 12 | 支付/出款渠道共享契约套件（含支付异步退款分支） | 6b | ✅ | `1c091f5` |
| 13 | 翻页超时预算与渠道告警钩子 | 6b | ✅ | `0d7d8da` |
| 14 | 退款契约改 `refund` / `queryRefund` | 6c | ✅ | `0819329` |
| 15 | `REFUNDING` 状态机、退款扫描、webhook 分流（迁移 C） | 6c | ✅ | `0819329` |
| 16 | 沙箱异步退款 + 退款契约测试 | 6c | ✅ | `0819329` |
| 17 | 文档、验收与迁移检查 | 收尾 | ✅ | 本文件 |

### 1.1 实施期偏离计划的地方

完整的「为什么改」记在设计文档 **§十三 实施期偏离记录**，这里只列会**影响使用方式**的四条：

1. **出款的假网关渠道名是 `fake-payout`，不是 `fake`** ——
   `PAYOUT_ENABLED_CHANNELS` / `PAYOUT_PLATFORM_DEFAULT_CHANNEL` 都要写 `fake-payout`。
   默认值在 `api/src/common/channel/channel-config.ts` 一处维护。
2. **假出款网关的剧本接口语义变了**：`POST /api/v1/pay/fake-payout/fail-next`
   的 `times` = 渠道**明确拒付**（`definitive: true`，可安全重试）；
   要造「结果未知」用 `unknownTimes`（`definitive: false`，一次落 `FAILED`、绝不自动重试）。
3. **`SandboxPayoutProvider` 必须用 `useFactory` 注册** ——
   以类注册时 Nest 会把构造参数 `number` 当成待注入的 provider，启动直接崩。
4. **`fake` 支付渠道也真跑异步退款用例**（`supportsAsyncRefund: true`）——
   它为 `armRefundScenario` 的能力声明负责；唯一保留的 `it.skip` 是
   「退款金额与原支付金额不一致 → 拒绝」（渠道层接口不带原支付金额）。

### 1.2 验收期发现并修掉的三处缺陷

| # | 现象 | 根因 | 处置 |
|---|------|------|------|
| 1 | `payout-execution` X7 断言「请联系平台确认出款情况」变红 | 6b 把渠道失败分成了 `definitive` 两桶，`times: 3` 现在是**明确拒付** → 重试预算用完后 `failedBeforePayout = true`，走了另一条文案 | 改写 X7（断言 `failedBeforePayout = true` + 中性文案），并**新增 X7b** 覆盖「结果未知一次落 FAILED、不自动重试」 |
| 2 | 商家端看到「收款账号信息异常，请更新收款账户后重新申请」 | `failedBeforePayout = true` 且原文不在白名单时，兜底回落了白名单第一条 —— 那是**说错原因**的话 | 新增中性兜底 `出款未成功，本次未打款，请联系平台处理`（`MERCHANT_GENERIC_NOT_SENT_REASON`），并补单测断言「不得回落收款账号文案」 |
| 3 | `payout` e2e 的 P7 偶发红 | 审批后自动入队，worker 抢到单就把状态推到 `PROCESSING`，而断言写死了错误消息里的 `APPROVED` | 断言改为 `/当前是「(APPROVED\|PROCESSING\|PAID)」状态，不能撤回/`，护栏本意（被拒 + 点明状态）不变 |

### 1.3 PR 前的全量代码审查修掉的问题

阶段 6 收尾时按「配置 / 出款与对账 / 异步出款 / 异步退款 / 前端 / 测试与文档」
切了六片做全量 review，下面是**会真出账或真的丢钱**的那几条（都已补测试）：

| # | 问题 | 后果 | 修法 |
|---|------|------|------|
| 1 | 新一轮退款抢闸门时**没清 `refundTxnId`**（`payment.service.ts`） | 上一次尝试的受理号留在库里，扫描 / 迟到回调会把「上一次已拒付」的结论当成这一次 → 闸门被放回 `SUCCESS` → 商家再退一次就是**重复退款** | 抢闸门与 `releaseRefundClaim` 都写 `refundTxnId: null` |
| 2 | 退款回调带的受理号在库里查不到时直接放弃，但事件仍被标成「已处理」 | 渠道异步受理才生成受理号时，合法退款回调被**永久吞掉**：钱退了，本地永远停在 `REFUNDING` | SUCCESS 事件按受理号查不到时回落到订单号再找一次；库里已有受理号且不一致则忽略（防迟到事件误改） |
| 3 | `scanStuck` 轮询到 `SUCCESS` 直接补记 `PAID`，**不核对金额** | 渠道打错金额在本地看起来完全正常（与 worker 的护栏 X3 矛盾），账实不符要等下次对账才发现 | 查询补 `netAmount`；金额不符落 `FAILED` + `failedBeforePayout: false`（禁止自动重试） |
| 4 | `stuckLoggedAt` 只写不清 | 一张单被标「已告警」后失败重试、再次卡在 `PROCESSING`，**永远不会再被轮询** | `claimForExecution` 进 `PROCESSING` 时清空 `stuckLoggedAt` |
| 5 | 平台默认渠道「尚未配置」时 `GET /platform/settings/payout-channel` 返回 409 | 超管后台 `/settings` 不渲染保存表单 → 全新环境**没有配置入口**，只能 curl | 新增 `readPayoutDefaultChannel()`：未配置返回 `{ channel: null, source: 'NONE' }`；执行路径 `getPayoutDefaultChannel()` 仍 fail-closed |
| 6 | CSV 导入的渠道名不归一化 | `fake-payout ` / `FAKE-PAYOUT` 被当成另一个渠道，本地单一条都匹配不上 → 整份账单变 D 类假告警 | 入库前 `normalizeChannel`，DTO 补 `@MaxLength(40)` |
| 7 | mock 服务的 `GET /payout/:referenceNo` 取插入顺序**第一条** | 重试后仍返回上一次的 `FAILED`，`scanStuck` 把已打款成功的单记成失败 → 运营重试 = 重复打款 | 改为取**最后一次**尝试 |
| 8 | 对账的可用性判断只认 `fake-payout`，报错文案写「假网关未启用」 | 触发 `sandbox` 对账时运营被引去翻 `FAKE_PAYOUT_ENABLED`，永远查不到真因 | 在册但未适配 API 对账的渠道给独立文案「请改用 CSV 账单导入」；定时对账跳过时留 warn |

### 1.4 审查后仍然保留的已知限制

- **出款单的渠道在「执行时」解析并在 `claimForExecution` 里写死**。审批与 worker 抢单之间
  若改了平台默认渠道，这张单会走新渠道。窗口很短（审批即入队，兜底扫描 10 分钟）；
  要彻底消除得在 `approve()` 里锁渠道，会牵连一批 e2e，留到下一阶段。
  界面文案已改成「一旦开始执行就写死渠道」，不再说「已审批的单不会换渠道」。
- **API 对账只适配了 `fake-payout`**；`sandbox` 只能走 CSV 账单导入。
  对账的定时任务也只注册 `fake-payout`。
- **对账仍是同步 HTTP**（翻页预算合计 630s），Nginx 默认 60s 会先 504 而任务在后台继续跑。
  改成队列任务随「告警系统落地」一起做。

---

## 二、自动化测试

| 层 | 命令 | 结果 |
|----|------|------|
| 单测（后端） | `cd api && npx jest --passWithNoTests` | **46 suites / 871 tests**（868 passed + 3 skipped）全绿 |
| e2e（后端全量，串行） | `cd api && npm run test:e2e` | **40 suites / 657 tests** 全绿 |
| 单测（商家后台） | `cd merchant-admin && npm test` | 27 files / **413 tests** 全绿 |
| 单测（平台后台） | `cd platform-admin && npm test` | 18 files / **427 tests** 全绿 |
| 单测（店铺前台） | `cd storefront && npm test` | 24 files / **209 tests** 全绿 |
| 类型检查 | `cd api && npx tsc --noEmit`；三端同上 | 均无输出（退出码 0） |
| 前端构建 | `cd <app> && npm run build`（三端） | 均成功 |
| 定向 lint | `npx eslint <本次改动文件>` | 无输出 |

> ⚠️ **e2e 必须串行**（`--runInBand`，`npm run test:e2e` 已带）—— 所有文件共享同一个
> 测试库与 Redis 队列，并行会互相污染。
>
> ⚠️ **3 条 skipped 都是有意的**：支付契约里「退款金额与原支付金额不一致 → 拒绝」
> 对 `fake` / `sandbox` 各跳一次（渠道层不适用），出款契约里 `fake` 的异步用例
> 跳一次（能力声明 `asyncPayout: false`，`submit` 即终态）。
>
> ⚠️ **失败注入必须独占**：下面的注入逐条单独跑，未与其它测试并发。

### 2.1 失败注入（逐条独占执行，均先变红再还原）

| # | 注入方式 | 命中的测试 | 结果 |
|---|----------|-----------|------|
| 1 | `payout.worker.ts`：`if (result.definitive)` 改成 `if (!result.definitive)` | `payout-worker.spec.ts` | **8 条变红** |
| 2 | `payout-execution.service.ts`：已定的 `payoutChannel` 不沿用（跳过第一分支） | `payout-execution.service.spec.ts` | 1 条变红（「重试沿用单子上的渠道」） |
| 3 | `payout-reconciliation-resolver.service.ts`：关掉 `source === 'FILE'` 的人工闸 | `payout-reconciliation{,-resolver}.service.spec.ts` | **2 条变红**（CSV 闸 + 批量确认不自动改 PAID） |
| 4 | `payout-reconciliation.service.ts`：翻页 `pageSize` 写死 10000，不再用配置值 | 同上 | 1 条变红（「页码与每页条数都要传」） |
| 5 | `payment.service.ts`：`PROCESSING` 直接走 `confirmRefundSuccess` | `payment.service.spec.ts` | 1 条变红（「PROCESSING → 保持 REFUNDING」） |
| 6 | `payout-reconciliation.service.ts`：批量确认失败项不再记入 `failed` | `payout-reconciliation.service.spec.ts` | 1 条变红（「2 成功 1 失败」） |
| 7 | `platform-setting.service.ts`：跳过「渠道已启用 / 生产非 devOnly」校验 | `platform-setting.service.spec.ts` | **2 条变红**（读取 fail-closed、保存拒绝未启用渠道） |

计划 §Task 17 里要求的七类注入全部覆盖：`definitive` 写反、路由取错渠道、
CSV 闸失效、分页忽略 `pageSize`、退款 `PROCESSING` 落 `REFUNDED`、
批量确认部分失败、平台默认渠道停用。

---

## 三、迁移检查

| 迁移 | 内容 | 状态 |
|------|------|------|
| `20261102120000_add_platform_settings` | 平台级设置表（`key` / `value` / 更新时间） | ✅ 已应用 |
| `20261102121000_add_preferred_channel_and_file_reconcile_action` | `merchant_payout_accounts.preferredChannel` + 枚举值 `RECONCILE_TO_PAID_BY_FILE` | ✅ 已应用 |
| `20261103040000_add_refund_async_fields` | `PaymentStatus.REFUNDING` + `payments.refundTxnId` / `refundRequestedAt` / `refundFailureReason` / `refundAttemptCount` | ✅ 已应用 |

```bash
cd api && npx prisma migrate status   # 29 migrations found / Database schema is up to date!
```

⚠️ **`prisma migrate diff` 仍有 4 条历史漂移**（`coupon_claims_coupon_customer_uniq`、
`payments_provider_txn_uniq`、`products_name_trgm`、`products_slug_trgm`）——
它们都是**手写索引**，Prisma 表达不了，diff 会当成「该删」。这是阶段 2 / 5a 就存在的
已知问题，**不是本阶段引入的，也不要去「修」**；新迁移里已刻意排除它们。

---

## 四、遗留清单（本阶段明确不做）

1. **真实渠道接入**（微信 / 支付宝 / 银行）：只做了适配层与沙箱；真渠道接入时按
   「新渠道准入」跑 `api/test/channel-contract/` 的共享契约，再补一轮 e2e。
2. **告警系统落地**：只留 `ChannelAlertSink` 钩子（卡住的出款单、退款问不出结论、
   对账超预算都会调），没有真正的告警通道。
3. **跨副本分布式锁**：周期任务靠 BullMQ `jobSchedulerId` 去重，
   「同一时间只允许一个对账任务」这类跨副本互斥没做。
4. **通用平台设置中心**：`platform_settings` 目前只有 `payout.platformDefaultChannel`。
5. **CSV 批量确认的严重级 / 状态筛选**：本阶段「全选筛选结果」= 该任务下全部
   A 类待处置项；加筛选时扩展 `FILTER` 模式的固定条件即可。

---

## 五、手工验收建议（按顺序）

1. `cd infra && docker compose up -d --wait postgres redis minio`，`cd api && npm run prisma:deploy && npm run prisma:seed`。
2. 用超管登录平台后台 → `/settings`：把「平台默认出款渠道」改成 `fake-payout`，
   再尝试保存一个未启用的渠道 → 应报中文 409，且不写库。
3. 商家后台「收款账户」页：不配 `preferredChannel` 时应显示「来源：平台」；
   配置后显示「来源：商家」，且不再受平台配置影响。
4. 发起一笔退款（假网关）：默认剧本应直接成功；把 `FAKE_*` 剧本改成退款
   `processing` 后，接口应返回 `REFUNDING`（不是 `REFUNDED`），
   扫描/回调确认后才变 `REFUNDED`。
5. 对账：用一个 FILE 来源任务验证「A 类差异不自动改 `PAID`」，
   再用「全选筛选结果」分批确认，观察返回的 `succeeded` / `failed` / `nextCursor`。
