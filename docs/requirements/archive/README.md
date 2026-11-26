# 归档：历史阶段的设计、计划与验收

这里保存阶段 1 ~ 11 的原始文档，**内容原样保留、不再维护**，只作为来龙去脉与决策依据的
存档。文中出现的路径若已随文档重组变化，以仓库当前结构为准。

## 目录

| 子目录 | 内容 |
|--------|------|
| [`specs/`](specs/) | 阶段设计文档（`*-design.md`），写「为什么这样做」与方案对比 |
| [`plans/`](plans/) | 实施计划（勾选式 Task）、验收记录（`*acceptance*`）、阶段性技术债清单 |

## 命名约定

- 设计：`YYYY-MM-DD-plan-<阶段号>-<主题>-design.md`
- 计划：`YYYY-MM-DD-plan-<阶段号>-<主题>.md`
- 验收：`YYYY-MM-DD-plan-<阶段号>-acceptance.md`
  （个别阶段的验收与计划同名，如 `2026-10-25-plan-04-frontend-polish-acceptance.md`）

阶段 02 拆成 2a/2b、阶段 5 拆成 5a ~ 5m、阶段 7 拆成 7a/7b/7c、阶段 8 拆成 8a/8b/8c，
编号与提交历史里的 `阶段 N` 说法一一对应。

## 阶段索引

| 阶段 | 主题 | 文档 |
|------|------|------|
| 1 | 地基与身份（monorepo、认证、租户上下文） | [设计](specs/2026-10-21-multi-tenant-ecommerce-saas-design.md) · [计划](plans/2026-10-21-plan-01-foundation-identity.md) · [验收](plans/2026-10-21-plan-01-acceptance.md) |
| 2a | 商品中心后端 | [设计](specs/2026-10-22-plan-02-product-center-design.md) · [计划](plans/2026-10-22-plan-02a-catalog-backend.md) · [验收](plans/2026-10-22-plan-02a-acceptance.md) |
| 2b | 商品中心前端（主题 token、前台浏览页、商家后台） | [设计](specs/2026-10-22-plan-02-product-center-design.md) · [计划](plans/2026-10-22-plan-02b-catalog-ui.md) · [验收](plans/2026-10-22-plan-02b-acceptance.md) |
| 3 | 交易链路：购物车 → 库存 → 订单 → 支付 | [设计](specs/2026-10-24-plan-03-transaction-design.md) · [计划](plans/2026-10-24-plan-03-transaction.md) · [验收](plans/2026-10-24-plan-03-acceptance.md) |
| 4 | 前端补齐与打磨 | [设计](specs/2026-10-25-plan-04-frontend-polish-design.md) · [计划](plans/2026-10-25-plan-04-frontend-polish.md) · [验收](plans/2026-10-25-plan-04-frontend-polish-acceptance.md) |
| 5a | 营销：优惠券与满减活动 | [设计](specs/2026-10-25-plan-05a-marketing-design.md) · [计划](plans/2026-10-25-plan-05a-marketing.md) · [验收](plans/2026-10-25-plan-05a-acceptance.md) |
| 5b | 平台计费：订阅、套餐、额度、抽佣、报表 | [设计](specs/2026-10-25-plan-05b-billing-design.md) · [计划](plans/2026-10-25-plan-05b-billing.md) · [验收](plans/2026-10-25-plan-05b-acceptance.md) |
| 5c | 刷新令牌宽限期（RFC 9700） | [设计](specs/2026-10-27-plan-05c-auth-grace-period-design.md) · [计划](plans/2026-10-27-plan-05c-auth-grace-period.md) · [验收](plans/2026-10-27-plan-05c-acceptance.md) |
| 5d | 主题变量统一 + 前端错误处理收口 + Redis 挂死修复 | [设计](specs/2026-10-27-plan-05d-theme-and-error-handling-design.md) · [计划](plans/2026-10-27-plan-05d-theme-and-error-handling.md) · [验收](plans/2026-10-27-plan-05d-acceptance.md) |
| 5e | 抽佣流水明细 | [设计](specs/2026-10-27-plan-05e-commission-ledger-design.md) · [计划](plans/2026-10-27-plan-05e-commission-ledger.md) · [验收](plans/2026-10-27-plan-05e-acceptance.md) |
| 5f | 支付可靠性（修丢钱洞 + 兜底扫描） | [设计](specs/2026-10-27-plan-05f-payment-reliability-design.md) · [计划](plans/2026-10-27-plan-05f-payment-reliability.md) · [验收](plans/2026-10-27-plan-05f-acceptance.md) |
| 5g | 结算单（商家 × 自然月的应收单据） | [设计](specs/2026-10-28-plan-05g-settlement-statement-design.md) · [计划](plans/2026-10-28-plan-05g-settlement-statement.md) · [验收](plans/2026-10-28-plan-05g-acceptance.md) |
| 5h-1 | 出款账 | [设计](specs/2026-10-29-plan-05h-payout-ledger-design.md) · [计划](plans/2026-10-29-plan-05h-payout-ledger.md) · [验收](plans/2026-10-29-plan-05h-payout-ledger-acceptance.md) |
| 5h-2 | 出款执行与补差调账 | [设计](specs/2026-10-29-plan-05h2-payout-execution-design.md) · [计划](plans/2026-10-29-plan-05h2-payout-execution.md) · [验收](plans/2026-10-29-plan-05h2-payout-execution-acceptance.md) |
| 5i | 账目口径收口 | [设计](specs/2026-10-30-plan-05i-ledger-reconciliation-design.md) · [计划](plans/2026-10-30-plan-05i-ledger-reconciliation.md) · [验收](plans/2026-10-30-plan-05i-ledger-reconciliation-acceptance.md) |
| 5j | 资金安全与账务闭环 | [设计](specs/2026-10-30-plan-05j-fund-security-ledger-closure-design.md) · [计划](plans/2026-10-30-plan-05j-fund-security-ledger-closure.md) · [验收](plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md) |
| 5k | 资金链路收尾 | [设计](specs/2026-10-30-plan-05k-fund-closure-design.md) · [计划](plans/2026-10-30-plan-05k-fund-closure.md) · [验收](plans/2026-10-30-plan-05k-fund-closure-acceptance.md) |
| 5l | 出款运维兜底 | [设计](specs/2026-10-30-plan-05l-payout-ops-design.md) · [计划](plans/2026-10-30-plan-05l-payout-ops.md) · [验收](plans/2026-10-30-plan-05l-payout-ops-acceptance.md) |
| 5m | 渠道对账（账单导入、差异分级、解卡重打） | [设计](specs/2026-10-31-plan-05m-payout-reconciliation-design.md) · [计划](plans/2026-10-31-plan-05m-payout-reconciliation.md) · [验收](plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md) |
| 6 | 渠道适配层与沙箱 | [设计](specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md) · [计划](plans/2026-11-02-plan-06-channel-adapter-sandbox.md) · [验收](plans/2026-11-02-plan-06-acceptance.md) |
| 7a | 工程与部署基建（CI、compose、Nginx、备份） | [设计](specs/2026-11-03-plan-07-engineering-hardening-design.md) · [计划](plans/2026-11-03-plan-07a-engineering-hardening.md) · [验收](plans/2026-11-03-plan-07a-acceptance.md) |
| 7b | api 代码收口（事务 / 分页 / 横切 / 访问日志） | [设计](specs/2026-11-03-plan-07-engineering-hardening-design.md) · [计划](plans/2026-11-04-plan-07b-api-hardening.md) · [验收](plans/2026-11-04-plan-07b-acceptance.md) |
| 7c | 前端共享包 `@ecom/frontend-shared` 与三端收口 | [设计](specs/2026-11-03-plan-07-engineering-hardening-design.md) · [计划](plans/2026-11-04-plan-07c-frontend-shared.md) · [验收](plans/2026-11-04-plan-07c-acceptance.md) |
| 8 | 部署与鉴权、资金与并发正确性、健壮性 | [设计](specs/2026-11-04-plan-08-resilience-auth-funds-design.md) · [计划](plans/2026-11-04-plan-08-resilience-auth-funds.md) · [验收](plans/2026-11-04-plan-08-acceptance.md) |
| 9 | 历史技术债清理（安全/运维/资金/前端文档） | [设计](specs/2026-11-04-plan-09-tech-debt-cleanup-design.md) · [计划](plans/2026-11-04-plan-09-tech-debt-cleanup.md) · [验收](plans/2026-11-04-plan-09-acceptance.md) |
| 10 | 事务边界与连接池收口 | [设计](specs/2026-11-04-plan-10-tx-boundary-design.md) · [计划](plans/2026-11-04-plan-10-tx-boundary.md) · [验收](plans/2026-11-04-plan-10-acceptance.md) |
| 11 | 可观测性与生产部署加固 | — · 计划见验收记录内的 Step 列表 · [验收](plans/2026-11-07-plan-11-observability-deploy-acceptance.md) |

## 其他归档文档

| 文档 | 内容 |
|------|------|
| [`plans/2026-11-04-tech-debt-inventory.md`](plans/2026-11-04-tech-debt-inventory.md) | 阶段 10 之前的技术债盘点清单（部分条目已在阶段 10/11 解决） |
| [`plans/2026-11-05-audit-findings.md`](plans/2026-11-05-audit-findings.md) | 阶段 11 之前的全仓审计发现（按严重度分级） |
| [`stage-history.md`](stage-history.md) | 原 README 的阶段进度叙述（阶段 11 倒推到阶段 1） |

当前待办见 [`../backlog.md`](../backlog.md)。
