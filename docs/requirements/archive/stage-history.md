# 阶段进度记录（历史）

本文是原根 `README.md` 顶部的阶段进度叙述，**原文迁移**、未改内容，仅把链接指向
`docs/requirements/archive/` 下的归档路径，并修正了一处「当前进度」的时态措辞。
最新进度以 `git log` 与 [`archive/`](README.md) 中的验收记录为准。

返回：[需求与规划](../README.md) · [文档索引](../../README.md)

---


**当前进度（截至本次整理）：阶段 11「可观测性与生产部署加固」已完成并验收通过**
（验收记录见
[`plans/2026-11-07-plan-11-observability-deploy-acceptance.md`](plans/2026-11-07-plan-11-observability-deploy-acceptance.md)）。

阶段 11 在阶段 10（并发正确性）之上补「看得见、上得去」的两块：

- **可观测性**：pino 结构化日志（全局 `useLogger`，业务代码零改动；request-id
  贯穿访问日志与响应头；敏感字段递归脱敏）+ Prometheus 指标
  （`/api/v1/metrics`：HTTP RED、六队列深度、**卡单 gauge**
  ——REFUNDING/PROCESSING 超 30 分钟的单数，正常恒为 0）+
  `WebhookAlertSink`（`ALERT_WEBHOOK_URL` 配飞书/钉钉/自建机器人，
  渠道告警从「打条日志没人看」变成真推送；去重 10 分钟 + 限频 10 条/分钟）。
- **部署加固**：生产 TLS 模板（`infra/nginx/templates/prod.conf.template`，
  泛域名证书 + ACME 路由 + HSTS）与 compose 生产 override
  （`infra/docker-compose.prod.yml`）；网关 `limit_req` 限流；
  `statement_timeout=8s`（防单租户慢查询拖垮共享库）；compose 新增
  `migrate` 工具服务（builder 镜像带 prisma CLI，`--profile tools`）。
  完整部署流程见 **[`../../DEPLOY.md`](../../DEPLOY.md)**。
- **代码收口**：`payment.service.ts`（2636 行）拆为四个服务
  （lookup / order / refund / webhook）+ 202 行 facade；
  `payout.service.ts`（2052 行）拆为 `PayoutQueryService` + `PayoutStateService`
  + 82 行 facade——外部调用点与类型导出均零改动；
  媒体上传 confirm 增加 magic-byte 复核；媒体列表 readUrl 批量签发；
  新增**游客订单查询**（订单号 + 收货手机号双因子、最小投影、
  防爆破限流——「订单号不是秘密」决策的受控例外，见
  `guest-order.controller.ts` 注释）。
- **跨副本互斥**：`RedisLockService`（SET NX PX + Lua 比对删除，
  抢不到 = 跳过本轮、Redis 不可用不抛出）套在 media 孤儿清理
  （每副本各自的 setInterval，N 副本会清 N 遍）与出款救援/渠道对账
  （「同一时间只允许一个对账任务」的双保险）上。
- **指标收口**：HTTP 指标从拦截器挪到**中间件层**——守卫拒绝的
  401/403 也能进指标了（拦截器在守卫之后执行，根本注册不上）。

阶段 10 修的是并发写路径的**根因**：

- **事务回调内不再借第二条连接**：Prisma 的交互事务（`$transaction(async (tx) => ...)`）
  会独占一条连接，回调内再用非事务客户端（`this.prisma`）就要再借一条 ——
  连接池小时（GitHub 2 核 runner 上默认池只有 5 条），并发下单互相等死，
  先报 `P2024`（拿不到连接），外层事务随后超时报 `P2028`。
  涉及 coupon / subscription / quota / cart / invoice / payment /
  platform-setting 七个模块，**9 个根因、15 处借用点**全部改为走事务客户端。
- **静态检测器 + 回归护栏**：用 TypeScript 类型信息构建全局调用图，
  追踪「事务回调 → 方法转调 → `this.prisma`」的完整链路；
  护栏单测扫全仓，新增违规即 CI 红。豁免必须写明理由，
  锚点用「文件 + 方法名 + 表达式」而非会漂移的行号。
- **CI 撤掉规避配置**：e2e job 不再放大连接池（`connection_limit=20`）、
  也不再放宽事务超时（`PRISMA_TX_TIMEOUT_MS=30000`）——
  用默认池跑正是为了持续验证「根因已修」。

设计文档见
[`specs/2026-11-04-plan-10-tx-boundary-design.md`](specs/2026-11-04-plan-10-tx-boundary-design.md)；
实施计划见
[`plans/2026-11-04-plan-10-tx-boundary.md`](plans/2026-11-04-plan-10-tx-boundary.md)。

阶段 9「历史技术债清理」已完成并验收通过。阶段 9 按四批清历史遗留：

- **A 安全与部署**：生产环境拒绝默认/空的 PostgreSQL、Redis、MinIO 凭据；
  三端 `AUTH_SECRET` 启动守卫（含 compose 默认值与 `.env.example` 占位值，
  `next build` 阶段放行）；compose 密钥可被环境变量覆盖、端口默认只绑回环、
  MinIO 镜像钉 digest。
- **B 运维与 CI**：备份缺卷默认失败并校验归档完整性，新增 `infra/restore.sh`
  与 `crontab.example`；CI 三前端合并为 matrix 并补 `lint`，新增 e2e job；
  回填脚本遇到活跃出款单默认拒绝（`--force` 显式跳过）。
- **C 资金与并发**：取消确认在事务内回查与更新；刷新令牌统一使用数据库时钟；
  宽限密文清理同时删除超保留期的过期行；结算单 CSV 导出（含公式注入防护）；
  新增批量重试「确定未打款」失败单的脚本。
- **D 前端与文档**：70 处中转路由改为 `!session?.accessToken`；storefront
  四个页面补齐 loading 骨架；删除未使用的 `@nestjs/config` 与共享包
  `react-dom`；文档口径统一。

阶段 9 的设计文档见
[`specs/2026-11-04-plan-09-tech-debt-cleanup-design.md`](specs/2026-11-04-plan-09-tech-debt-cleanup-design.md)；
验收记录见
[`plans/2026-11-04-plan-09-acceptance.md`](plans/2026-11-04-plan-09-acceptance.md)。

阶段 8 修的是「部署能跑但会打架、并发下会丢钱」的高危问题：

- **8a 部署与鉴权**：Nginx 只把 `/api/v1/` 代理给 API，店铺子域名的 BFF 路由
  （`/api/cart`、`/api/auth/session`）归还 storefront；生产密钥守卫改为按
  「已知占位符集合」判断，compose 内置默认值在生产环境直接拒绝启动；
  platform-admin 补齐与另两端同构的令牌刷新链路。
- **8b 资金与并发正确性**：购物车加购改单条原子自增 + P2002 重试（并发不丢增量）；
  续费按成功支付单幂等结算、单租户异常不中断整批；渠道交易号绑定补 `provider`
  并检查影响行数，绑不上返回 false。
- **8c 健壮性与工程债**：券/媒体分页夹取与合并窗口上限 1000；前端搜索/品类/商品页
  区分 404 与故障、购物车受控输入失败回滚、库存面板切 SKU 丢弃过期响应；
  共享 `api-client` 无令牌显式 401；CI 补权限/并发/超时与 shared job；
  备份保留策略、`gunzip -t` 校验、nginx healthcheck 与静态资源 immutable 缓存；
  api lint 归零并清理未使用依赖。

阶段 8 的设计文档见
[`specs/2026-11-04-plan-08-resilience-auth-funds-design.md`](specs/2026-11-04-plan-08-resilience-auth-funds-design.md)；
验收记录见
[`plans/2026-11-04-plan-08-acceptance.md`](plans/2026-11-04-plan-08-acceptance.md)。

阶段 7 把「能跑」变成「有回归保护、不对外裸奔、代码不再重复」：

- **7a 工程与部署基建**：GitHub Actions 四 job CI（api 单测 + 三端 tsc/test/build）、
  Redis `requirepass` 且全部宿主机端口绑回环、compose 日志轮转与内存上限、
  Nginx 收口（gzip / body 上限 / 安全头 / default server 444）、`infra/backup.sh` 备份。
- **7b api 代码收口**：购物车合并事务化、`setMedia` 批量化、券与佣金流水分页、
  对账单 DB 端归期、租户上下文失败统一 403、访问日志收口（不打 body 与原始错误信息）。
- **7c 前端共享包**：新增 `packages/frontend-shared`（包名 `@ecom/frontend-shared`），
  把三端逐字节重复的令牌刷新 / 会话同步 / jwt 回调 / error 边界 / `api-client` /
  `money` / `route-helpers` 收编，三端保留薄壳 re-export（调用点零改动）；
  三端补 21 个 `loading.tsx` 骨架页。

上一阶段（阶段 6）交付的渠道适配层仍是支付与出款链路的核心：
阶段 6 修的是**渠道只有一家、契约按同步假设写**的老毛病：以前支付/出款注册表
硬编码单一渠道，出款「取第一个渠道」，`refund()` 调下去就当成功——接第二家渠道、
或渠道异步受理（先 `PROCESSING` 后确认）时，本地账会和渠道账对不上。
现在支付与出款各有**渠道注册表**（能力门控、超管可读的渠道列表、生产环境拒绝
`fake` / `sandbox` 启动），出款契约改为 `submit()` + `queryPayout()`、退款改为
`refund()` + `queryRefund()`，新增 `PaymentStatus.REFUNDING`：
**只有渠道确认成功才落 `REFUNDED`**，`PROCESSING` 保持处理中，`definitive: false`
的失败绝不自动重试（宁可人工核对，不可重复打款/退款）。

同时落地：默认出款渠道解析（商家配置 → 平台配置 → fail-closed，平台配置在超管
后台 `/settings`）、对账按渠道隔离、CSV 来源的 A 类差异人工闸与**批量确认**
（勾选 / 全选筛选结果，游标分批）以及**沙箱渠道**（`sandbox`，仅开发环境可见）。

阶段 7 的设计文档见
[`specs/2026-11-03-plan-07-engineering-hardening-design.md`](specs/2026-11-03-plan-07-engineering-hardening-design.md)；
阶段 7a / 7b / 7c 的验收记录分别见
[`7a`](plans/2026-11-03-plan-07a-acceptance.md) /
[`7b`](plans/2026-11-04-plan-07b-acceptance.md) /
[`7c`](plans/2026-11-04-plan-07c-acceptance.md)。

阶段 6 的设计文档见
[`specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md`](specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md)；
阶段 6 的验收记录见
[`plans/2026-11-02-plan-06-acceptance.md`](plans/2026-11-02-plan-06-acceptance.md)；
阶段 5m 的验收记录见
[`plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md`](plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md)；
阶段 5c 的验收记录见
[`plans/2026-10-27-plan-05c-acceptance.md`](plans/2026-10-27-plan-05c-acceptance.md)；
阶段 5b 的验收记录见
[`plans/2026-10-25-plan-05b-acceptance.md`](plans/2026-10-25-plan-05b-acceptance.md)；
阶段 5a 的验收记录见
[`plans/2026-10-25-plan-05a-acceptance.md`](plans/2026-10-25-plan-05a-acceptance.md)；
阶段 4 的验收记录见
[`plans/2026-10-25-plan-04-frontend-polish-acceptance.md`](plans/2026-10-25-plan-04-frontend-polish-acceptance.md)；
阶段 3 的验收记录见
[`plans/2026-10-24-plan-03-acceptance.md`](plans/2026-10-24-plan-03-acceptance.md)；
阶段 2b / 2a / 1 的见
[`2026-10-22-plan-02b-acceptance.md`](plans/2026-10-22-plan-02b-acceptance.md) /
[`2026-10-22-plan-02a-acceptance.md`](plans/2026-10-22-plan-02a-acceptance.md) /
[`2026-10-21-plan-01-acceptance.md`](plans/2026-10-21-plan-01-acceptance.md)。

---

