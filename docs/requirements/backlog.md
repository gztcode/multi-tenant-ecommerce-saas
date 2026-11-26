# 待办与技术债（backlog）

本文承接原根 `README.md` 的「后续计划」「剩余技术债」章节，**已按当前代码、PR 与 CI 记录重新校准**，
不再逐字保留原文。每条待办都带「状态 / 完成证据 / 估算 / 阻塞原因」，已完成项单独成节，
避免照着已完成的条目重复劳动。

返回：[需求与规划](README.md) · [历史阶段进度](archive/stage-history.md)

> 新需求不要直接写在这里：复制 [`TEMPLATE.md`](TEMPLATE.md) 建独立文件，
> 完成或过期后移入 [`archive/`](archive/)。

**状态口径**：

| 状态 | 含义 |
|------|------|
| 待办 | 已确认要做、无外部阻塞 |
| 已完成 | 有代码与合并记录（PR 号 + 合并 commit；有 CI run 的附链接） |
| 已放弃 | 有明确理由不做，保留决策依据 |
| 等业主裁决 | 产品 / 资源决策未定，工程侧不替业主拍板 |

各阶段的整体完成情况以 [`README.md` 第三节状态表](README.md#三当前状态) 为准；
本文件只维护**条目级**状态。

---

## 一、后续计划（计划 1 ~ 10）

> 「后续计划」表覆盖**计划 1 ~ 10**，这 10 个计划全部已完成并验收通过，保留作为进度对照
> （**范围只到计划 10**）。阶段 11 与 11b/11c/11d **不在本表**，完成情况见
> [`README.md` 第三节状态表](README.md#三当前状态) 与 [`archive/` 索引](archive/README.md)。
> 本表是进度记录，**不是待办清单**。

| 计划 | 内容 | 状态 |
|------|------|------|
| 计划 2a | 商品中心后端 | ✅ 已完成并验收通过 |
| 计划 2b | 商品中心前端：主题 token、storefront 浏览页、商家后台 | ✅ 已完成并验收通过 |
| 计划 3 | 交易链路：购物车 → 库存 → 订单 → 支付 | ✅ 已完成并验收通过 |
| 计划 4 | 前端补齐与打磨 | ✅ 已完成并验收通过（有条件通过） |
| 计划 5a | 营销：优惠券与满减活动 | ✅ 已完成并验收通过（有条件通过） |
| 计划 5b | 平台计费：SaaS 订阅、套餐、额度、抽佣、报表 | ✅ 已完成并验收通过（有条件通过） |
| 计划 5c | 刷新令牌宽限期（RFC 9700） | ✅ 已完成并验收通过 |
| 计划 5d | 主题变量统一（`--brand-*`）+ 前端错误处理收口 + Redis 挂死修复 | ✅ 已完成并验收通过 |
| 计划 5e | 抽佣流水明细 + M11 收尾 | ✅ 已完成并验收通过 |
| 计划 5f | 支付可靠性（修丢钱洞 + 兜底扫描） | ✅ 已完成并验收通过 |
| 计划 5g | 结算单（按商家 × 自然月的应收单据） | ✅ 已完成并验收通过 |
| 计划 5h-1 / 5h-2 | 出款账 → 真正打款（出款执行 + 补差调账） | ✅ 已完成并验收通过 |
| 计划 5i / 5j / 5k | 账目口径收口 → 资金安全与账务闭环 → 资金链路收尾 | ✅ 已完成并验收通过 |
| 计划 5l | 出款运维兜底 | ✅ 已完成并验收通过 |
| 计划 5m | 渠道对账（账单导入、差异分级、解卡重打） | ✅ 已完成并验收通过 |
| 计划 6 | 渠道适配层与沙箱（注册表、默认渠道、异步出款/退款、CSV 批量确认） | ✅ 已完成并验收通过 |
| 计划 7a | 工程与部署基建（CI、compose 安全、Nginx、备份） | ✅ 已完成并验收通过 |
| 计划 7b | api 代码收口（事务 / 分页 / 横切统一 / 访问日志） | ✅ 已完成并验收通过 |
| 计划 7c | 前端共享包 `@ecom/frontend-shared` + 三端收口 + loading 骨架 | ✅ 已完成并验收通过 |
| 计划 8a / 8b / 8c | 部署与鉴权 → 资金与并发正确性 → 健壮性与工程债 | ✅ 已完成并验收通过 |
| 计划 9 | 安全与部署、运维与 CI、资金并发护栏、前端与文档清理 | ✅ 已完成并验收通过 |
| 计划 10 | 事务边界与连接池收口（并发写路径的根因修复 + 静态护栏） | ✅ 已完成并验收通过 |

---

## 二、阶段 11 之后的剩余技术债

> **统一叫法**：这一组条目过去的标题按当时的进度改过两次（先按阶段 7 计，后按阶段 8 计），实际是
> **阶段 11 收尾后仍剩下的技术债**——阶段 6/7/8 明确不做的项，加上阶段 4/3 的遗留。
> `README.md` 与本文件此后统一使用「阶段 11 之后的剩余技术债」，旧写法不再使用。

### 2.1 待办（工程项）

> 原先的 #1「守卫拒绝的 401/403 没有访问日志」已收口（访问日志下沉到
> `AccessLogMiddleware`），移入[三、已完成](#三已完成保留索引)。
> 「对账差异详情支持筛选」也已收口（只读筛选，未动批量确认的人工闸），
> 同样移入[三、已完成](#三已完成保留索引)。

当前没有待办工程项。

### 2.2 已放弃（保留理由）

| 条目 | 状态 | 完成证据 / 现状 | 估算 | 放弃理由 |
|------|------|----------------|------|---------|
| 三端源码 import 路径大面积替换到共享包 | 已放弃 | 三端仍是 `export *` 薄壳（如 `storefront/src/lib/api-client.ts:3`） | 1–2 天 | 薄壳让调用点零改动；纯重构、无功能收益，将来真要清理再单独做 |
| 共享包独立发布 / 版本化 | 已放弃 | `packages/frontend-shared/package.json` 仍是 `"private": true`，无外部消费者 | 1–2 天 | 没有外部消费者，发布与版本化收益为零 |
| 通用平台设置中心抽象 | 已放弃 | `platform_settings` 目前只有 `payout.platformDefaultChannel` 一个 key（`api/src/common/platform-settings/platform-setting.service.ts:43`） | 3–5 天 | 只有一个 key，过早抽象；等出现第二个 key 再评估 |
| CSV 批量确认按严重级 / 状态扩展 `FILTER` | 已放弃 | 原 FILTER 固定条件见 `payout-reconciliation.service.ts:1218-1223` | 1–2 天 | 会放宽「批量只处理 A 类」的人工闸，动钱路径风险大于收益；改为只读筛选（已做完，见[三、已完成](#三已完成保留索引) 的「对账差异详情支持筛选」行） |
| `Order.itemCount` 补快照回写 | 已放弃 | `api/src/modules/order/order.service.ts:1048` 注释明确「下单时写入的件数总和」 | 无需做 | 当前没有改单路径；只有将来支持改单才需要回写 |
| 购物车金额改为实时精确值 | 已放弃 | `storefront/src/components/cart/cart-list.tsx:294` 已提示「金额为估算值，实际以提交订单时为准」 | 无需做 | 设计取舍：真实金额由后端在下单时按当时 SKU 价格计算 |

### 2.3 等业主裁决

以下问题属于产品或资源决策，**工程侧不替业主拍板**，原样列出：

| # | 待裁决问题 | 现状 / 代码位置 | 决策后工作量 |
|---|-----------|----------------|-------------|
| 1 | **换套餐的周期长度**：按新套餐 `periodDays`，还是按剩余周期折算？ | `api/src/modules/payment/renewal.service.ts:129` 目前按新套餐 `periodDays` 计算 `periodEnd` | 0.5 天 |
| 2 | **是否做多店**：决定 `maxStores` 是补实现还是从 backlog 删除。 | `api/src/modules/billing/quota.service.ts:141` 已读取；`platform-admin/src/app/(dashboard)/plans/plan-form.tsx:380` 标注「当前架构每租户固定 1 家，此字段暂不生效」 | 1 周+ |
| 3 | **跨店会员**是否有产品计划；没有则从 backlog 移除。 | 当前无会员模块 | 1 周+ |
| 4 | **对账人工闸边界**：A 类之外是否允许批量确认？当前设计明确不允许。 | `api/src/modules/payment/payout-reconciliation-resolver.service.ts` 顶部注释、`AGENTS.md` | 1–2 天 |
| 5 | **真实渠道优先级**：等资质期间是否要接第二家 sandbox？ | 当前只有 `fake` / `fake-payout`（`api/src/common/channel/channel-config.ts:25-28`），`sandbox` 仅开发环境可见 | 数周 |
| 6 | **secret manager / 托管数据库**是否近期目标；否则阶段 8-1 应改成「已完成（secret manager 除外）」并关闭。 | 仍靠 `api/.env.example` 注入环境变量；TLS / pino / `statement_timeout` 已完成（见「三、已完成」） | 0.5 天 |
| 7 | **CSV 来源 A 类的人工闸**是否维持「机器不替人改钱」的现状（建议维持）。 | 设计就是人工闸：CSV 来源的 A 类差异落 `PENDING` 人工项，批量确认按 `IDS` / `FILTER` 逐条复核 | 决策即可 |

---

## 三、已完成（保留索引）

> 这些条目曾以「待办」姿态留在本文件里，现已完成。保留索引是为了让后来者能查到
> 完成证据，**不要再照原条目重做**。

| 条目 | 完成证据 | 完成深度 / 备注 |
|------|---------|----------------|
| 给 `merchant-admin` 补组件测试基建 | PR #4（merge `bc1c8d0`，`merchant-admin/vitest.config.ts` 39 行 + 6 项护栏测试）＋ PR #11（merge `fd621c8`，`merchant-admin/test/lib/jwt-callback.test.ts` 9 条）；**无 CI run**——CI 门禁建于阶段 7a 之前 | 完全做完，`auth.ts` 的 `jwt` 回调可测 |
| 把分组标量（字阶 / 间距 / 阴影 / 字重）在前台接上消费者 | PR #12（merge `b5b6d68`）；`storefront/src/app/globals.css:77-93`；结构测试 `storefront/test/app/globals-css.test.ts:55-131`；无 CI run | 完全做完；结构测试不等同浏览器级字号断言 |
| 修字体 token 在服务端就失效 | PR #12（merge `b5b6d68`）；`storefront/src/app/globals.css:150` + `storefront/src/app/layout.tsx` 变量上移；测试 `globals-css.test.ts:69-73`；无 CI run | 完全做完 |
| 统一前台的错误处理 | PR #12（merge `b5b6d68`）新增 `storefront/src/app/error.tsx`；后续 `e02d42a` 抽到 `packages/frontend-shared/src/app-error.tsx`；无 CI run | 完全做完（重试按钮 + 人话文案） |
| 给商家后台做主题实时预览 | PR #12（merge `b5b6d68`）；`merchant-admin/src/components/theme/theme-form.tsx:39,166`；测试 `merchant-admin/test/components/theme/theme-form.test.tsx`；无 CI run | 完全做完。**纠正**：实现早于阶段 11，阶段 11 收尾只是复核，不是阶段 11 新增 |
| 给 e2e 的队列做隔离 + 每轮清库 | PR #5（merge `fd5e4f8`）；`api/test/setup-e2e.ts:34,49,91`；无 CI run | 完全做完（`bull-e2e` 前缀 + `truncateAllTables`） |
| 守卫拒绝的 401/403 没有访问日志 | PR #63；`api/src/common/http/access-log.middleware.ts` + `access-log.middleware.spec.ts`；`api/src/app.module.ts` 注册 `RequestIdMiddleware → AccessLogMiddleware → MetricsMiddleware` | 完全做完：访问日志从拦截器下沉到中间件层，`res 'finish'` 按最终状态码记录，401/403/404/500 都落一条；删除 `LoggingInterceptor`，同一次请求不会双写；仍不打 body / 密码 / token / cookie |
| 对账差异详情支持筛选 | 本 PR；`api/src/modules/payment/payout-reconciliation.service.ts` 的 `detail(id, filter)` + `dto/payout-reconciliation.dto.ts` 的 `DetailReconciliationDto`；`platform-admin/src/app/(dashboard)/reconciliations/[id]/page.tsx` 的筛选表单；单测 `payout-reconciliation.service.spec.ts` 的 `describe('筛选')`、e2e `payout-reconciliation-service.e2e-spec.ts` 的两条「详情筛选」用例 | 完全做完：`GET /platform/payout-reconciliations/:id` 支持可选 `severity` / `resolution` / `type`，只作用于差异列表与 `itemsTotal`；无参数时与改造前逐字一致（200 条上限与排序不变）；批量确认的 FILTER 固定条件（`PENDING + A 类 + payoutId`）与相关测试一行未改；`actionableCount` 不受筛选影响。**超过 200 条的差异现在靠筛选收窄范围看全**，文案不再承诺「去列表页按批次查看」 |
| 告警系统落地（webhook） | PR #30（merge `6b1eddf`），CI [run 42450549593](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42450549593) | 完全做完：`ALERT_WEBHOOK_URL` + `api/src/common/channel/webhook-alert-sink.ts`（去重与限频） |
| 跨副本分布式锁 | PR #30（merge `6b1eddf`），CI [run 42450549593](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42450549593) | 完全做完：`api/src/common/lock/redis-lock.service.ts` + spec；套在 media 清理、出款救援、渠道对账上 |
| pino 结构化日志 / 生产 TLS / 慢查询阈值 | PR #30（merge `6b1eddf`），CI [run 42450549593](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42450549593) | **主体做完**：`api/src/common/logging/pino-logger.service.ts`；`infra/nginx/templates/prod.conf.template:174-196`；`infra/postgres/init-tuning.sh:34`。**secret manager 未做**，见 [2.3 等业主裁决 #6](#23-等业主裁决) |
| 游客订单查询 | PR #30（merge `6b1eddf`），CI [run 42450549593](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42450549593)；后续 `ca6f116` 修防爆破可信代理 | 完全做完：订单号 + 收货手机号双因子、最小投影、Redis 失败计数；`api/src/modules/order/guest-order.controller.ts` + e2e `api/test/guest-order-lookup.e2e-spec.ts` |
| 阶段 11b：npm workspaces 化 | PR #30（merge `6b1eddf`），CI [run 42450549593](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42450549593) | 有实现、**无设计 / 计划 / 验收归档**。证据：根 `package.json` 的 `workspaces` 含 5 个子包；`@ecom/frontend-shared` 以 workspace 符号链接被三端引用；用法见[开发与测试](../development.md) |
| 阶段 11c：浏览器级 e2e（Playwright golden path） | PR #31（merge `88583bb`），CI [run 42452795536](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42452795536) | 有实现、**无设计 / 计划 / 验收归档**。证据：`e2e-browser/playwright.config.ts` 与 `e2e-browser/specs/`；命令见[开发与测试](../development.md) 的「浏览器级 e2e」 |
| 阶段 11d：退货入库流程 | PR #32（merge `9e287b3`），CI [run 42488083335](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42488083335) | 有实现、**无设计 / 计划 / 验收归档**。证据：`POST /api/v1/inventory/returns`（`api/src/modules/inventory/inventory.controller.ts`）+ e2e `api/test/return-inventory.e2e-spec.ts`；「退款不回补库存」的取舍不变，配套手动入口已补 |

---

## 四、阶段 4 验收优先项的处置对照

> 下面这份源自**阶段 4 验收当时的原始清单**（详见
> [验收记录 §七](archive/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)），
> 保留作历史记录。其中两条已不再单列：
> 原第 1 条「多标签页刷新竞态」由阶段 5c（刷新令牌宽限期，RFC 9700）实现；
> 原第 10 条「RSC 首次加载闪 `Unauthorized`」已由前端统一 401 文案
> （`packages/frontend-shared/src/api-client.ts:45`）与账户页「无 accessToken 直接跳登录」
> （`storefront/src/app/(shop)/account/page.tsx:13-17`）收口。其余条目顺延编号，
> **处置状态以本节为准，原清单不再作为待办。**

| # | 原条目 | 处置 | 指向 |
|---|--------|------|------|
| 1 | 给 `merchant-admin` 补组件测试基建 | 已完成 | [三、已完成](#三已完成保留索引) |
| 2 | 把分组标量在前台接上消费者 | 已完成 | [三、已完成](#三已完成保留索引) |
| 3 | 修字体 token 在服务端就失效 | 已完成 | [三、已完成](#三已完成保留索引) |
| 4 | 统一前台的错误处理 | 已完成 | [三、已完成](#三已完成保留索引) |
| 5 | 给商家后台做主题实时预览 | 已完成 | [backlog.md 三、已完成](backlog.md#三已完成保留索引) |
| 6 | 给 e2e 的队列做隔离 + 每轮清库 | 已完成 | [三、已完成](#三已完成保留索引) |
| 7 | 退货入库流程 | 已完成 | [backlog.md 三、已完成](backlog.md#三已完成保留索引) |
| 8 | 跨店会员 | 等业主裁决 | [backlog.md 2.3 等业主裁决](backlog.md#23-等业主裁决) |

## 五、阶段 3 遗留的处置对照

> 出自阶段 4 验收记录 §六（[链接](archive/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)）。
> 原清单里的游客订单查询已在阶段 11 补上；迁移在全新库上的行为描述已按实际纠正（整条跳过，不是失败）。

| 遗留项 | 处置 | 证据 / 说明 |
|--------|------|------------|
| 跨店会员不支持 | 等业主裁决 | 见 [backlog.md 2.3 等业主裁决](backlog.md#23-等业主裁决) |
| 游客订单查询 | 已完成 | 阶段 11（PR #30，merge `6b1eddf`）补了订单号 + 收货手机号双因子查询，见「三、已完成」 |
| 退款不回补库存 | 设计取舍 + 已补手动入口 | 退款仍不自动回补库存；配套退货入库已由阶段 11d 补上（PR #32），见「三、已完成」 |
| 购物车金额是估算值 | 已放弃（设计取舍） | 见 [2.2 已放弃](#22-已放弃保留理由) |
| `20261022071848_add_sku_stock_version` 迁移在全新库上的行为 | 描述纠正，无需修 | **不是「会失败」**：迁移用 `ALTER TABLE IF EXISTS` / `ADD COLUMN IF NOT EXISTS`，全新库上**整条跳过**（表还没建），已部署的库行为不变。这是设计如此，不要「修」它，详见 `api/prisma/migrations/20261022071848_add_sku_stock_version/migration.sql` 与 `AGENTS.md` |
