# api — 多租户电商 SaaS 后端

NestJS 11 + Prisma 6 + PostgreSQL 16。

## 本地运行

```bash
# 依赖与配置
npm install && cp .env.example .env

# 数据库迁移与种子
npm run prisma:deploy && npm run prisma:seed

# 开发模式
npm run start:dev
```

服务默认监听 `http://localhost:3000`，API 前缀 `/api/v1`，
接口文档 `http://localhost:3000/api/docs`。

## 测试

```bash
npm test              # 单元测试（886 条 / 47 个套件）
npm run test:e2e      # 端到端测试（657 条 / 40 个套件，串行）
npm run test:cov      # 单元测试覆盖率
npm run test:cov:e2e  # e2e 覆盖率
npm run lint          # 静态检查
```

- e2e **必须串行**（`--runInBand`）：共享同一个测试库与 Redis 队列，并行会互相干扰。
- e2e 与单元测试都跑在**测试库** `ecommerce_test`（`DATABASE_URL_TEST`）上，
  与开发库物理隔离；`npm test` / `npm run test:e2e` 会先自动应用迁移。

## 账目运维脚本

```bash
npm run backfill:ledger          # 回填抽佣流水（幂等，可重复跑）
npm run check:ledger             # 校验账目一致性
npm run migrate:payout-encryption   # 收款账户明文 → 密文的存量迁移
```

## 本地假网关与沙箱

`FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED` **默认关闭**，且**只在非生产环境存在**：

- 假支付网关的支付页**无需登录**就能把订单付掉；
- 假出款网关会模拟「打款失败」。

它们是**安全边界**，不是便利开关。`NODE_ENV=production` 且任一开关为 `true` 时，
进程**硬失败**（`assert-secure-config.ts`）。两个开关**相互独立**，不要合并
（支付假网关的渠道名是 `fake`，出款是 `fake-payout`）。

沙箱渠道（`sandbox`）走 HTTP mock 服务，**仅开发环境可见**，
用 `SANDBOX_*` 环境变量指向它（见根目录 `AGENTS.md` 的「渠道配置与默认渠道」）。

## 渠道适配层（阶段 6）

| 路径 | 说明 |
| --- | --- |
| `src/common/channel/` | 渠道描述符、配置解析（`channel-config.ts` 是 devOnly 名单的**唯一事实来源**）与告警钩子 |
| `src/common/payment/` | 出款渠道契约（`submit` / `queryPayout`）、渠道注册表与假出款网关实现 |
| `src/modules/payment/` | 支付侧渠道注册表、退款状态机（`REFUNDING`）、渠道对账引擎 |
| `src/common/platform-settings/` | 平台默认出款渠道的读写（DB 优先、环境变量兜底、未配置时 fail-closed） |

⚠️ **新渠道接入必须先过 `test/channel-contract/` 的共享契约**，
契约不过 = 不允许接入（见 `AGENTS.md` 的「新渠道准入」）。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/common/tenant/` | 租户隔离的核心：Prisma query extension、租户上下文、三张白名单表 |
| `src/common/payment/` | 出款渠道与核实契约的下沉区。**`common/` 下唯一持有 `@Module` 的目录**——因为 `billing` 不能 import `payment`（成环） |
| `src/common/channel/` | 渠道描述符、配置解析与告警钩子（阶段 6 新增） |
| `src/common/platform-settings/` | 平台默认出款渠道设置（阶段 6 新增） |
| `src/common/queue/` | BullMQ 队列名常量 |
| `src/common/crypto/` | 字段级加密（AES-256-GCM） |
| `src/modules/` | 业务模块：auth / catalog / cart / order / payment / coupon / billing / theme / media / inventory / stores / tenants / tenancy / queue |
| `src/health/` | 健康检查（含 Redis 探活与 degraded 降级） |
| `src/modules/billing/` | 计费与资金链路：订阅、账单、抽佣流水、结算单、出款、商家对账单 |
| `src/modules/payment/` | 支付与打款：支付单、webhook、补偿、出款 worker、渠道对账引擎 |
| `prisma/schema.prisma` | 数据模型。**所有金额字段都是 `Int`（分）** |
| `test/` | e2e 测试（`*.e2e-spec.ts`）与测试库迁移脚本 |

数据库连接：`postgresql://ecommerce:ecommerce@localhost:15432/ecommerce`
（宿主机端口 15432，容器内 5432；本机端口分配见仓库根 README。）

根目录 `README.md` 与 `docs/superpowers/plans/` 有完整说明。
