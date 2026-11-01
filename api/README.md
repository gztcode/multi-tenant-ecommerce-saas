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
npm test              # 单元测试（628 条 / 32 个套件）
npm run test:e2e      # 端到端测试（646 条 / 39 个套件）
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

## 本地假网关

`FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED` **默认关闭**，且**只在非生产环境存在**：

- 假支付网关的支付页**无需登录**就能把订单付掉；
- 假出款网关会模拟「打款失败」。

它们是**安全边界**，不是便利开关。`NODE_ENV=production` 且任一开关为 `true` 时，
进程**硬失败**（`assert-secure-config.ts`）。两个开关**相互独立**，不要合并。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/common/tenant/` | 租户隔离的核心：Prisma query extension、租户上下文、三张白名单表 |
| `src/common/payment/` | 出款渠道与核实契约的下沉区。**`common/` 下唯一持有 `@Module` 的目录**——因为 `billing` 不能 import `payment`（成环） |
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
