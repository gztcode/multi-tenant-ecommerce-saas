# 阶段 6 实施计划：渠道适配层与沙箱

> **状态（2026-11-03）：阶段 6a / 6b / 6c 全部完成。** 完成情况与偏离记录见
> `docs/superpowers/plans/2026-11-02-plan-06-acceptance.md`；本文的勾选框保留原样
> 作为计划原文（与前几个阶段的计划一致，不事后回填勾选）。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 文档位置：`docs/superpowers/plans/2026-11-02-plan-06-channel-adapter-sandbox.md`。
> 设计依据：`docs/superpowers/specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md`。

**Goal:** 把支付/出款从「单一假网关」改造成可插拔的渠道适配层：显式注册、按渠道路由、默认渠道「商家 → 平台（后台可配）」、支持异步出款与异步退款、明确的失败语义、对账多渠道隔离、CSV 批量/全选人工确认，并用沙箱 + 契约测试锁住行为。**不接真实微信/支付宝。**

**Architecture:** 两个注册表（支付 / 出款）替代硬编码 `Map`；平台默认渠道落 `platform_settings`，商家默认渠道落 `merchant_payout_accounts.preferredChannel`；出款契约从同步 `execute()` 改为 `submit()` + `queryPayout()`；退款契约从同步 `refund()` 改为 `refund()` + `queryRefund()` 并引入 `PaymentStatus.REFUNDING`；worker 增加 `PROCESSING` 分支，`scanStuck` / 新增 `scanRefunding` 负责轮询；对账按 `payoutChannel` / `source` 隔离；CSV 来源的 A 类差异走批量人工确认（勾选当前列表 + 全选筛选结果，游标分批）；新增 `sandbox` 渠道（仅开发可见）与共享契约测试。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 + BullMQ + Jest 30（api）+ Next.js 15（platform-admin / merchant-admin 只改页面与同源中转）。

---

## 0. 全局约定（动手前必须知道）

### 0.1 测试与数据安全

- [ ] 后端测试读 `api/.env` 的 `DATABASE_URL_TEST`；e2e 会 `migrate deploy` → **truncate 所有业务表** → 清 `bull-e2e:*` → seed。**指错库就是数据灾难。**
- [ ] e2e 必须串行：`npm run test:e2e` / `npm run test:cov:e2e` 均已带 `--runInBand`。
- [ ] 本阶段预期 **3 个手写迁移**（见 Task 4 / Task 5 / Task 15）。一律手写 `migration.sql`，用 `npx prisma migrate diff` 核对，**不要用 `prisma migrate dev`**。
- [ ] `ALTER TYPE ... ADD VALUE` 与新枚举值的使用**不能放在同一个迁移文件里**；迁移文件只加值，不消费值。
- [ ] 新增带 `tenantId` 的模型必须登记 `tenant-models.ts`；本阶段无新租户表。`platform_settings` 是平台级表，**不要**登记。
- [ ] e2e 的 `truncateAllTables` 会自动清 `platform_settings`；涉及平台默认渠道的 spec 要自己 set/restore，避免跨文件污染。

### 0.2 模块依赖铁律

- [ ] `modules/billing` **绝对不能 import `modules/payment`**；渠道契约放 `common/payment/`，注册表用 `@Global()` 模块。
- [ ] `tenantContext.run(...)` 的回调必须是 `async` 函数。
- [ ] 租户作用域模型上禁止 `findUnique` / `update` / `delete` / `upsert`；用 `findFirst` / `updateMany` / `deleteMany`。
- [ ] `platform_settings` 不是租户作用域模型，可以用 `upsert`；但读写仍统一走 `tenantContext.run(platformScope(), ...)`，语义明确。
- [ ] 平台作用域下按 `tenantId` 精确查商家配置时，`where` 必须显式写 `tenantId`（`platformScope()` 不会自动加过滤）。

### 0.3 金额、时钟、文案

- [ ] 金额一律整数分；落库时刻用 `prisma.databaseNow()`（新增代码）；渠道返回的时刻只做展示/对账字段。
- [ ] 文案、注释、测试名、commit message 一律简体中文；commit 用中文 conventional commits。
- [ ] 日志不出现账号、密钥、完整回调原文。

### 0.4 lint 与失败注入纪律

- [ ] 不要跑 api 全量 `npm run lint` 当闸；只对本次改动文件跑 `npx eslint <file>`，新增文件零错误。
- [ ] 失败注入必须独占：故意改坏源码验证测试时，不同时跑其他测试。
- [ ] 每条新护栏至少配一条「改坏它会红」的测试；不写只测 happy path 的用例。

### 0.5 兼容

- [ ] `fake` 渠道与历史数据保留；`sandbox` 是新增渠道，不改 `fake` 的行为。
- [ ] 存量 `payouts.payoutChannel = null` 的单只在平台默认渠道下参与对账，不猜。
- [ ] `PayoutProvider.execute()` / 旧 `refund()` 签名删除后，所有 mock 同步改；不保留两套契约。
- [ ] 前端不直连后端：新页面写操作一律走同源 `app/api/**/route.ts`，并重建请求体白名单。

---

## 6a 适配层基础（不改出款/退款状态机）

> 6a 可以独立合并、独立上线；它只改注册、配置、平台/商家默认渠道、路由与对账隔离/CSV 闸。
> 6a 需要迁移 A（`platform_settings`）与迁移 B（`preferredChannel` + `RECONCILE_TO_PAID_BY_FILE`）。

### Task 1：渠道描述符与注册表

**Goal:** 用注册表替代两个硬编码 `Map`，提供 `get` / `resolveForPayout` / `list`。

**Files:**
- Create: `api/src/common/channel/channel.types.ts`
- Create: `api/src/common/channel/channel-config.ts`（环境变量解析：启用列表 / 生产判断 / `isChannelEnabled`）
- Create: `api/src/common/payment/payout-provider.registry.ts`
- Create: `api/src/modules/payment/payment-provider.registry.ts`
- Modify: `api/src/common/payment/payout-providers.module.ts`
- Modify: `api/src/modules/payment/payment.module.ts`
- Modify: `api/src/common/payment/payout-provider.interface.ts`
- Modify: `api/src/modules/payment/payment-provider.interface.ts`
- Test: `api/src/common/payment/payout-provider.registry.spec.ts`
- Test: `api/src/modules/payment/payment-provider.registry.spec.ts`

**Steps:**
- [ ] 定义 `ChannelDescriptor` / `ChannelCapabilities`（见设计 §4.1），含 `devOnly` / `asyncRefund` / `asyncPayout` / `queryByReferenceNo`。
- [ ] `channel-config.ts` 提供：`enabledChannels(kind)`、`isChannelEnabled(kind, channel)`、`isProduction()`；供注册表与平台设置共用，**不读 DB**。
- [ ] 给 `PaymentProvider` / `PayoutProvider` 增加 `readonly capabilities`；`fake` 两个 provider 填「全支持（异步为 false）」。
- [ ] 实现 `PayoutProviderRegistry`：
  - `get(channel)`：未注册 / 未启用 / 生产环境的 devOnly → `ConflictException`（中文，说明具体渠道）。
  - `resolveForPayout({ payoutChannel, merchantChannel, platformChannel })`：已定渠道 → 商家 → 平台 → 抛错（见设计 §4.4）。
  - `list({ includeDevOnly? })`：默认过滤 `devOnly`。
  - ⚠️ **不读 DB、不解析默认渠道** —— 默认渠道由调用方（`PlatformSettingService`）先解析好再传进来。
- [ ] 实现 `PaymentProviderRegistry`：同上，但支付必须显式给 channel，不提供默认。
- [ ] `payout-providers.module.ts` / `payment.module.ts` 用注册表提供者替换裸 `Map`；保留 `PAYOUT_PROVIDERS` / `PAYMENT_PROVIDERS` 令牌作为兼容导出（**只读、扁平 Map**）。
- [ ] 更新所有 `providers.get(channel)` / `providers.values()` 调用点改用注册表（先保持行为不变）。

**Tests:**
- [ ] 未注册 channel → 中文 409，不是 `undefined`。
- [ ] 未启用 channel → 中文 409。
- [ ] 生产环境下 `sandbox`（devOnly）即使注册也取不到；`list()` 不返回。
- [ ] `resolveForPayout` 四条路径：已定 → 商家 → 平台 → 抛错。

**Done when:** 现有测试全绿，新增注册表单测覆盖上述五条。

---

### Task 2：渠道配置与启动校验

**Goal:** 渠道由环境变量显式启用；生产环境禁止 fake/sandbox；配置错误在启动时硬失败。

**Files:**
- Modify: `api/src/common/config/assert-secure-config.ts`
- Modify: `api/.env.example`
- Modify: `infra/docker-compose.yml`（仅补注释/默认值，不放开 fake）
- Test: `api/src/common/config/assert-secure-config.spec.ts`（若不存在则 Create）

**Steps:**
- [ ] 增加读取与默认值：
  - `PAYMENT_ENABLED_CHANNELS` / `PAYOUT_ENABLED_CHANNELS`（逗号分隔；非生产默认 `fake`，生产必须显式设置）。
  - `PAYOUT_PLATFORM_DEFAULT_CHANNEL`（**仅兜底**；生产允许不设，由平台 UI 配置）。
  - `CHANNEL_MODE`（`sandbox` 仅开发）。
- [ ] 启动校验：
  1. `NODE_ENV=production` 且 `CHANNEL_MODE=sandbox` → 硬失败。
  2. 生产启用列表包含 `fake` / `sandbox` → 硬失败。
  3. 启用列表每项必须有实现；否则启动失败并点名变量与渠道。
  4. `PAYOUT_PLATFORM_DEFAULT_CHANNEL` 若设置，必须在 `PAYOUT_ENABLED_CHANNELS` 内。
- [ ] `.env.example` 补注释：fake/sandbox 是安全边界，不是便利开关；平台默认渠道优先从 DB 读。
- [ ] compose 默认值保持「不启用 fake 也能启动」的现状（只在注释里给出开发示例）。

**Tests:**
- [ ] 生产 + `CHANNEL_MODE=sandbox` → 抛错。
- [ ] 生产 + `PAYOUT_ENABLED_CHANNELS=fake` → 抛错。
- [ ] 生产 + `PAYMENT_ENABLED_CHANNELS=sandbox` → 抛错。
- [ ] `PAYOUT_PLATFORM_DEFAULT_CHANNEL=not-registered` → 抛错。
- [ ] 非生产不设变量 → 默认 fake，正常启动。

**Done when:** 启动失败文案明确指向具体变量；现有 compose 默认配置仍能启动。

---

### Task 3：支付能力门控与回调路由

**Goal:** 不支持的支付能力显式报错；webhook 按注册表路由。

**Files:**
- Modify: `api/src/modules/payment/payment.service.ts`
- Modify: `api/src/modules/payment/payment-method.service.ts`
- Modify: `api/src/modules/payment/webhook.controller.ts`
- Test: `api/src/modules/payment/payment.service.spec.ts`
- Test: `api/src/modules/payment/webhook.controller.spec.ts`（若不存在则 Create）

**Steps:**
- [ ] 退款前检查 `provider.capabilities.refund`；不支持 → 409「当前渠道不支持在线退款」。
- [ ] 自动续费扣款前检查 `authorizedCharge`；创建支付方式前检查 `paymentMethod`。
- [ ] webhook 的 `:channel` 改为 `PaymentProviderRegistry.get(channel)`；未知/未启用/生产 devOnly → 404。
- [ ] 保持「先验签、失败 401、不落库」的顺序不变。
- [ ] `providerOf(channel)` 统一走注册表，不再直接读 `Map`。

**Tests:**
- [ ] 不支持退款的 provider → 409，且不调用渠道。
- [ ] 未知 channel 的 webhook → 404，且不写 `payment_webhook_events`。
- [ ] 现有 fake webhook 用例仍全绿。

**Done when:** 能力门控有独立单测，webhook 路由不再直接读 `Map`。

---

### Task 4：平台默认渠道设置（`platform_settings` + 超管后台）

**Goal:** 平台默认渠道可在超管后台查看与修改，落 `platform_settings`；env 只在 DB 无行时兜底。

**Files:**
- Create: `api/prisma/migrations/<ts>_add_platform_settings/migration.sql`（**迁移 A**）
- Modify: `api/prisma/schema.prisma`
- Create: `api/src/common/platform-settings/platform-settings.module.ts`（`@Global()`，只含 service）
- Create: `api/src/common/platform-settings/platform-setting.service.ts`
- Create: `api/src/modules/platform-settings/platform-settings.module.ts`（controller 模块）
- Create: `api/src/modules/platform-settings/platform-settings.controller.ts`
- Create: `api/src/modules/platform-settings/dto/set-payout-channel.dto.ts`
- Modify: `api/src/app.module.ts`
- Modify: `api/src/common/payment/payout-providers.module.ts`（import 公共 settings 模块，供核实服务用）
- Test: `api/src/common/platform-settings/platform-setting.service.spec.ts`
- Test: `api/test/platform-settings.e2e-spec.ts`
- Create: `platform-admin/src/lib/settings.ts`
- Create: `platform-admin/src/app/(dashboard)/settings/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/settings/payout-channel-form.tsx`
- Create: `platform-admin/src/app/api/settings/payout-channel/route.ts`
- Modify: `platform-admin/src/app/(dashboard)/layout.tsx`（导航「设置」）
- Test: `platform-admin/test/...`（中转白名单）

**Migration A（手写）:**
- [ ] 新建 `platform_settings`：`id TEXT PK`、`key TEXT NOT NULL UNIQUE`、`value JSONB NOT NULL`、`updatedBy TEXT`、`createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`、`updatedAt TIMESTAMP(3) NOT NULL`。
- [ ] `prisma migrate diff` 核对为空。
- [ ] **不**在迁移里插默认行（无行时走 env 兜底，避免迁移把环境差异写死）。

**Steps:**
- [ ] `schema.prisma` 增加 `PlatformSetting`（见设计 §4.5），`@@map("platform_settings")`；**不登记** `tenant-models.ts`。
- [ ] `PlatformSettingService`：
  - `getPayoutDefaultChannel(): Promise<{ channel, source: 'DATABASE' | 'ENV' }>`；
  - `setPayoutDefaultChannel(channel, operatorId)`：用 `channel-config.isChannelEnabled` 校验（生产拒绝 devOnly），再 `upsert` `key = 'payout.platformDefaultChannel'`，写 `updatedBy`；
  - `listPayoutChannels()` 由控制器注入 `PayoutProviderRegistry` 实现（service 不依赖注册表，避免模块环）。
- [ ] 读取时校验：DB 里的渠道可能已被停用（环境变量/部署变更）→ 抛中文错误，不回落。
- [ ] 公共模块 `@Global()` 导出 service；`PayoutProvidersModule` import 它，供 `PayoutVerificationService` 兜底解析。
- [ ] 控制器（`PLATFORM_ADMIN`）：
  - `GET /platform/settings/payout-channel`；
  - `PUT /platform/settings/payout-channel`；
  - `GET /platform/settings/payout-channels`。
- [ ] 超管后台 `/settings`：
  - 服务端读当前渠道 + 来源；
  - 下拉只列出可用渠道（生产看不到 sandbox）；
  - 保存走同源 `PUT /api/settings/payout-channel`，body 白名单只放行 `{ channel }`（字符串、非空、长度上限）；
  - 文案写明「只影响新出款单；已审批/处理中的单不会换渠道」。
- [ ] 导航增加「设置」。

**Tests:**
- [ ] DB 无行、env 有值 → 返回 `source: 'ENV'`。
- [ ] DB 有行 → `source: 'DATABASE'`，且**覆盖** env。
- [ ] DB 行指向未启用渠道 → 读取抛中文错误。
- [ ] 保存未启用 / 生产 devOnly 渠道 → 400/409，不写库。
- [ ] 保存成功 → `updatedBy` 为操作人 id。
- [ ] e2e：平台超管可读写；商家令牌 403。
- [ ] 前端中转：未知字段丢弃；非字符串 / 空串返回 400。

**Done when:** 平台默认渠道可在后台改；env 只在首次部署兜底；改动有留痕。

---

### Task 5：商家默认渠道与账户页

**Goal:** 商家可配置默认出款渠道；账户页能看出「自己配的 / 平台默认」。

**Files:**
- Create: `api/prisma/migrations/<ts>_add_preferred_channel_and_file_reconcile_action/migration.sql`（**迁移 B**）
- Modify: `api/prisma/schema.prisma`
- Modify: `api/src/modules/billing/dto/set-payout-account.dto.ts`
- Modify: `api/src/modules/billing/payout-account.service.ts`
- Modify: `api/src/modules/billing/merchant-payout-account.controller.ts`
- Test: `api/src/modules/billing/payout-account.service.spec.ts`
- Modify: `merchant-admin/src/lib/payout.ts`
- Modify: `merchant-admin/src/app/(dashboard)/settlements/account/page.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/settlements/account/account-form.tsx`
- Modify: `merchant-admin/src/app/api/merchant/payout-account/route.ts`
- Test: `merchant-admin/test/...`（账户表单或中转路由）

**Migration B（手写）:**
- [ ] `ALTER TABLE "merchant_payout_accounts" ADD COLUMN "preferredChannel" TEXT;`
- [ ] `ALTER TYPE "PayoutOperationAction" ADD VALUE IF NOT EXISTS 'RECONCILE_TO_PAID_BY_FILE';`
- [ ] 同一文件内**不得使用**新枚举值；`prisma migrate diff` 核对为空。

**Steps:**
- [ ] `schema.prisma` 的 `MerchantPayoutAccount` 增加 `preferredChannel String?` 与注释（只影响**新**出款单）。
- [ ] `SetPayoutAccountDto` 增加可选 `preferredChannel`（`@IsOptional` + `@IsString` + `@MaxLength(40)`）；**空串 = 清除配置**，不传 = 不修改。
- [ ] `PayoutAccountService.set` 支持 `preferredChannel`；写入前用 `PayoutProviderRegistry` 校验「已启用且非 devOnly（生产）」，否则 400 中文。
- [ ] `PayoutAccountView` 增加 `preferredChannel` / `effectiveChannel` / `effectiveSource` / `preferredChannelUnavailable`：
  - 商家有值且仍启用 → `effectiveChannel` 取商家值，`effectiveSource = 'MERCHANT'`；
  - 商家有值但已停用 → `effectiveChannel` **仍显示商家配置值**，`effectiveSource = 'MERCHANT'`，`preferredChannelUnavailable = true`（执行时 fail-closed，**不静默切平台默认**）；
  - 商家没配 → `effectiveChannel` 取 `PlatformSettingService.getPayoutDefaultChannel()`，`effectiveSource = 'PLATFORM'`。
- [ ] 商家账户页增加「默认出款渠道」下拉：只展示可用渠道（生产看不到 sandbox），带「不选则用平台默认」说明；配置停用时显示醒目提示。
- [ ] 中转路由 `PUT /api/merchant/payout-account` 的 body 白名单加入 `preferredChannel`（未知字段丢弃）。

**Tests:**
- [ ] 商家配置 A、平台默认 B → `GET` 返回 `effectiveChannel=A`、`source=MERCHANT`。
- [ ] 商家没配、平台默认 B → `effectiveChannel=B`、`source=PLATFORM`。
- [ ] 商家配了未启用渠道 → 保存 400；存量数据在 `GET` 里 `preferredChannelUnavailable=true`。
- [ ] 空串清除配置；不传保持原值。
- [ ] 迁移在空库上可执行；`migrate diff` 为空。

**Done when:** 商家可配置、平台可兜底、停用配置可见且不静默回落。

---

### Task 6：出款按渠道路由与默认渠道解析

**Goal:** 去掉 `firstProvider()` / `pickProvider()`；`claimForExecution` 一次性解析并写入 `payoutChannel`，worker 与核实服务都按它取渠道。

**Files:**
- Modify: `api/src/modules/billing/payout-execution.service.ts`（`claimForExecution` 解析 / `channel` / `channelError`；`confirmPaidAfterReconciliation` select 补 `payoutChannel`）
- Modify: `api/src/modules/payment/payout.worker.ts`（处理 `channelError`、按 `claim.channel` 路由）
- Modify: `api/src/common/payment/payout-verification.service.ts`（`PayoutVerificationTarget.payoutChannel`）
- Modify: `api/src/modules/billing/payout.service.ts`（`unstick` 传 `payoutChannel`）
- Test: `api/src/modules/payment/payout-worker.spec.ts`
- Test: `api/src/common/payment/payout-verification.service.spec.ts`
- Test: `api/src/modules/billing/payout-execution.service.spec.ts`

**Steps:**
- [ ] `claimForExecution`：
  - select 补 `tenantId` / `payoutChannel`；
  - 若 `payoutChannel` 已有值 → 直接沿用（重试不换渠道）；
  - 否则在 `platformScope()` 事务里按 `tenantId` 查 `merchant_payout_accounts.preferredChannel`，并读 `PlatformSettingService.getPayoutDefaultChannel()`；
  - 用 `registry.resolveForPayout({ payoutChannel, merchantChannel, platformChannel })` 解析；
  - 解析结果写回 `payouts.payoutChannel`（与状态改 `PROCESSING` 同一个 `updateMany`）；
  - **解析失败不抛异常**：`ExecutionClaim` 增加 `channel: string | null` 与 `channelError: string | null`，照现有 `accountError` 的形态返回错误原因；
  - worker 在 `checkGates` 之前处理 `channelError`：`markFailed(reason, failedBeforePayout=true)`（渠道从未被调用，钱确定没打出去）。
    ⚠️ **不能靠抛异常**：事务回滚后单子仍是 `APPROVED`，`markFailed` 只接受 `PROCESSING` → 单子会永远卡在 `APPROVED`，兜底扫描每 5 分钟重投一次。
- [ ] `PayoutVerificationTarget` 增加 `payoutChannel: string | null`；两个调用方都从**库里读到的 payout** 传。
- [ ] `PayoutVerificationService` 注入 `PlatformSettingService`：`verifyRealtime` 的渠道 = `target.payoutChannel ?? (await settings.getPayoutDefaultChannel()).channel`；再用 `registry.get(channel)`。
- [ ] `verifyRealtime` 取不到渠道 → 返回 `null`（走下一层核实），不抛。
- [ ] worker：`registry.get(claim.channel)`；`claim.channel` 为空时记 `warn`（正常路径不该走到）。
- [ ] 删除 `firstProvider()` / `pickProvider()` 与 `providers.values()` 取首逻辑。
- [ ] 两处共用同一个 `PayoutProviderRegistry` 实例（`@Global()` 模块导出）。

**Tests:**
- [ ] 商家配置 A、平台默认 B → 新出款单 `payoutChannel=A`；已有 `payoutChannel=B` 的重试仍用 B。
- [ ] 商家没配、平台默认 B → `payoutChannel=B`。
- [ ] 商家配置停用 → 出款落 `FAILED + failedBeforePayout=true`（`channelError`），原因可读，且**不会**卡在 `APPROVED` 被兜底扫描无限重投。
- [ ] 注册两家渠道，`payoutChannel=A` → worker 调 A，不调 B。
- [ ] 核实服务对同一张单取到与 worker 相同的渠道；失败注入：故意取默认渠道 → 测试必须红。
- [ ] `payoutChannel=null` → 平台默认渠道，并断言有 `warn` 日志。

**Done when:** 代码里不再有「取第一个渠道」；解析、写入、worker、核实四处的渠道一致。

---

### Task 7：对账渠道隔离、CSV 自动纠正闸与批量确认

**Goal:** 本地单、差异去重、CSV A 类都按渠道/来源隔离；CSV 的 A 类支持勾选当前列表与全选筛选结果。

**Files:**
- Modify: `api/src/modules/payment/payout-reconciliation.service.ts`（隔离 + `actionableCount` + `resolveAutoDiffs(source)`）
- Modify: `api/src/modules/payment/payout-reconciliation-resolver.service.ts`（`manualCorrectToPaid`）
- Modify: `api/src/modules/payment/platform-payout-reconciliation.controller.ts`
- Create: `api/src/modules/payment/dto/batch-confirm-reconciliation.dto.ts`
- Modify: `api/src/modules/payment/payout-reconciliation.service.spec.ts`
- Modify/Create: `api/src/modules/payment/payout-reconciliation-resolver.service.spec.ts`
- Modify: `platform-admin/src/lib/reconciliation.ts`（`actionableCount` / `canBatchConfirm`）
- Modify: `platform-admin/src/app/(dashboard)/reconciliations/[id]/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/reconciliations/reconciliation-items-table.tsx`（客户端表格 + 复选框）
- Create: `platform-admin/src/app/api/billing/reconciliations/[id]/items/batch-confirm/route.ts`
- Test: `platform-admin/test/...`（批量中转白名单）

**Steps:**
- [ ] `loadLocalPayouts(channel, from, to)` 按 `payoutChannel = channel` 过滤；`null` 只在 `channel === 平台默认渠道` 时纳入（读 `PlatformSettingService`）。
- [ ] `supersedePreviousPending` 加 `reconciliation.channel` 限定（先取任务 `channel`，再按它过滤）。
- [ ] `resolveAutoDiffs(diffs, reconciliationId, source)`：
  - `source === API`：保持自动纠正 A 类。
  - `source === FILE`：**不自动改状态**，A 类保持 `PENDING`，`note` 写「CSV 来源需人工确认」。
- [ ] `manualCorrectToPaid`：把现有 `correctToPaid` 抽成可传 `action` / `operatorId` / `reason` 的方法；成功后再把 item 标 `RESOLVED`。
- [ ] 新增 `POST /platform/payout-reconciliations/:id/items/batch-confirm`：
  - DTO 两种模式（`mode` 用 `@IsIn`；`IDS` 时校验 `itemIds`，`FILTER` 时校验 `cursor`/`limit`）：
    - `IDS`：`itemIds: string[]`（`@ArrayMaxSize(200)`、`@ArrayUnique`、`@IsUUID('4', { each: true })`）+ `note`。
    - `FILTER`：`cursor?: string`（UUID）+ `limit?: number`（1–200，默认 200）+ `note`。
  - 校验任务存在且 `source === FILE`，否则 409「只有账单文件导入的对账任务支持批量确认」。
  - `IDS`：逐条复核属于该任务、`resolution = PENDING`、`type = CHANNEL_PENDING_LOCAL`、`payoutId` 非空。
  - `FILTER`：固定条件 + `id > cursor`，`orderBy: { id: 'asc' }`，`take: limit`；游标前进到本批最后一条（失败项也前进）。
  - 逐条执行 `manualCorrectToPaid`；返回 `{ succeeded, failed, nextCursor }`；部分成功不回滚。
  - 已处置 / 不属于该任务 / 类型不符 → 计入 `failed`，不静默跳过。
- [ ] 详情接口增加 `actionableCount`：`PENDING + CHANNEL_PENDING_LOCAL + payoutId 非空` 的条数（仅 `source = FILE` 有意义）。
- [ ] 平台端详情页：
  - 抽出客户端表格组件，增加复选框列；只有 `source === 'FILE' && type === 'CHANNEL_PENDING_LOCAL' && resolution === 'PENDING' && payoutId` 的行可选；
  - 表头全选当前页；
  - 底部操作条「确认选中（N 条）」→ `IDS`；「确认全部可批量确认（N 条）」→ `FILTER` 循环，显示进度与失败数，可中途停止；
  - `prompt()` 收集统一说明；成功后 `router.refresh()`。
- [ ] 同源中转路由：只放行 `{ mode, itemIds, cursor, limit, note }`；`IDS` 时 `itemIds` 去重、上限 200、必须都是字符串；`FILTER` 时只允许 `cursor`/`limit`；未知字段丢弃。
- [ ] 页面文案明确：「批量确认只纠正『渠道已打款、本地处理中』的差异；本地失败的 B 类仍需逐单走人工确认」。

**Tests:**
- [ ] 同一时间窗两家渠道的单，互不进入对方比对结果。
- [ ] 渠道 A 的去重不把渠道 B 的同 `(payoutId, type)` PENDING 项标掉。
- [ ] CSV 来源的 A 类差异 → `payouts.status` 仍是 `PROCESSING`，生成 `PENDING` 人工项。
- [ ] API 来源的 A 类差异 → 仍自动改 `PAID`（回归）。
- [ ] `IDS` 批量 3 条（其中 1 条已处置）→ 2 成功、1 失败；成功的 2 条变 `PAID` + `RESOLVED` + 留痕 `RECONCILE_TO_PAID_BY_FILE`。
- [ ] `FILTER` 分页：造 250 条可确认项，`limit=200` → 第一批 200 条 + `nextCursor`，第二批 50 条 + `null`；总数正好 250，不重不漏。
- [ ] `FILTER` 中途有失败项 → 游标仍前进，不会被无限重试。
- [ ] 非 FILE 任务调用批量确认 → 409，且不改任何单。
- [ ] 两个并发请求处理同一批 → 只有一方成功，另一方 `failed`，不重复打款。
- [ ] `payoutChannel = null` 的存量单只在平台默认渠道任务里出现。

**Done when:** 上述测试全绿；平台端可勾选/全选批量确认 CSV 的 A 类差异，且每次请求有界。

---

### 6a 验收

- [ ] `cd api && npm test` 全绿；`npm run test:e2e` 全绿。
- [ ] `PAYMENT_ENABLED_CHANNELS=fake`、`PAYOUT_ENABLED_CHANNELS=fake` 下现有功能不受影响。
- [ ] 迁移 A/B 在空库与已有库上都能 `migrate deploy`；`prisma migrate diff` 为空。
- [ ] 手动构造两家渠道（测试内注册），验证 worker / 核实 / 对账都按渠道隔离。
- [ ] 超管后台 `/settings` 改平台默认渠道 → 新出款单使用新渠道，已审批单不换渠道。
- [ ] 记录 acceptance：`docs/superpowers/plans/2026-11-02-plan-06a-acceptance.md`（实施后）。

---

## 6b 异步出款与沙箱

> 6b 是破坏性变更：`PayoutProvider.execute()` 删除。建议 6a 合并并稳定后再开 6b。
> 6b **不需要迁移**。

### Task 8：PayoutProvider 契约改造

**Goal:** 用 `submit()` + `queryPayout()` 替代 `execute()`，引入 `SUCCESS / PROCESSING / FAILED` 与 `definitive`。

**Files:**
- Modify: `api/src/common/payment/payout-provider.interface.ts`
- Modify: `api/src/common/payment/fake-payout.provider.ts`
- Modify: `api/src/common/payment/fake-payout.provider.spec.ts`
- Modify: `api/src/modules/payment/payout-worker.spec.ts`（mock 形状）
- Modify: `api/src/common/payment/payout-verification.service.ts`（query 返回类型）
- Modify: `api/src/modules/payment/payout.worker.ts`（调用点先按同步分支改完，状态机在 Task 9）

**Steps:**
- [ ] 定义 `PayoutSubmitResult` / `PayoutQueryResult`（见设计 §6.1）；`FAILED` 必带 `definitive`。
- [ ] `fake-payout.provider.ts` 实现 `submit()`；保留 `armScenario`，新增 `definitive_failure` / `processing` 场景。
- [ ] 删除 `execute()`；全仓搜索并改完所有调用方与 mock。
- [ ] `queryPayout` 返回归一化状态；`UNKNOWN` 不冒充 `FAILED`。
- [ ] 金额核对保持现状：`SUCCESS` 必须带回 `amount`，与请求不一致按失败处理。

**Tests:**
- [ ] 同一 `referenceId` 重复 `submit` → 渠道侧幂等，不产生两条成功记录。
- [ ] `SUCCESS` 的金额与请求一致。
- [ ] `FAILED + definitive=true` / `false` 两种结果可区分。
- [ ] `PROCESSING` 后 `queryPayout` 最终返回 `SUCCESS`。
- [ ] `queryPayout` 查无此单 → `UNKNOWN`。

**Done when:** `rg "\.execute\(" api/src` 无出款 provider 调用；所有出款测试改完并通过。

---

### Task 9：worker 处理 PROCESSING 与 definitive

**Goal:** 正确落 `PROCESSING`；不再把「结果未知」当失败自动重试。

**Files:**
- Modify: `api/src/modules/payment/payout.worker.ts`
- Modify: `api/src/modules/billing/payout-execution.service.ts`（新增 `markProcessing` 或复用现有 `recordChannel` + 状态保持）
- Test: `api/src/modules/payment/payout-worker.spec.ts`
- Test: `api/src/modules/billing/payout-execution.service.spec.ts`

**Steps:**
- [ ] `submit()` 四个分支按设计 §6.2 落库。
- [ ] `PROCESSING`：**不调 `markFailed`**，保持 `PROCESSING`，写 `processingAt` / `payoutChannel`，不投重试 job。
- [ ] `catch` 分支改为 `definitive=false`，`failedBeforePayout=false`，不自动重试。
- [ ] `definitive=true` 的失败才允许现有重试预算。
- [ ] `SUCCESS` 的金额与请求不一致 → 按 `definitive=false` 失败处理（钱可能已按错误金额打出）。

**Tests:**
- [ ] `PROCESSING` → 状态仍 `PROCESSING`，`attemptCount` 不额外递增，且没有重试 job。
- [ ] `definitive=true` → `failedBeforePayout=true`，有重试 job（未超预算时）。
- [ ] `definitive=false` → `failedBeforePayout=false`，无重试 job。
- [ ] 渠道抛异常 → `failedBeforePayout=false`。
- [ ] 失败注入：把 `definitive` 写反 → 测试必须红。

**Done when:** 四条核心测试全绿；`PROCESSING` 不再经过失败路径。

---

### Task 10：scanStuck 轮询异步渠道

**Goal:** 卡住的 `PROCESSING` 单先问渠道，再决定补记成功、允许重试或只告警。

**Files:**
- Modify: `api/src/modules/billing/payout-execution.service.ts`（`scanStuck`）
- Modify: `api/src/common/payment/payout-verification.service.ts`（如需单独 query 入口）
- Test: `api/src/modules/billing/payout-execution.service.spec.ts`
- Test: `api/src/common/payment/payout-verification.service.spec.ts`

**Steps:**
- [ ] `scanStuck` 对 `PROCESSING` 单逐张 `queryPayout({ referenceNo })`（单轮上限 50）。
- [ ] 渠道解析：`payout.payoutChannel ?? (await settings.getPayoutDefaultChannel()).channel`，再 `registry.get(...)`。
- [ ] `SUCCESS` → `markPaid`（写 `paidAt` / `payoutTxnId` / `payoutChannel`）。
- [ ] `FAILED + definitive=true` → `markFailed(failedBeforePayout=true)`，允许运营重试。
- [ ] `PROCESSING` / `UNKNOWN` / `definitive=false` / 查询异常 → 写 `stuckLoggedAt` + 告警日志，状态不变。
- [ ] 只有 `capabilities.asyncPayout=true` 的渠道才轮询；同步渠道的 `PROCESSING` 视为异常，保持「只告警」。

**Tests:**
- [ ] 渠道说 `SUCCESS` → 单子变 `PAID`，写 `paidAt` / `payoutTxnId`。
- [ ] 渠道说 `FAILED + definitive=true` → `FAILED` + `failedBeforePayout=true`。
- [ ] 渠道 `UNKNOWN` / 超时 → 状态不变，只写 `stuckLoggedAt`。
- [ ] 同步渠道的 `PROCESSING` → 不调用 `queryPayout`。
- [ ] 单轮超过 50 张 → 只处理 50 张（断言调用次数）。

**Done when:** 上述五条测试全绿；异步渠道不再「只告警」。

---

### Task 11：沙箱 provider 与 HTTP mock 服务

**Goal:** 提供一个走真实 HTTP 的 `sandbox` 渠道，能模拟成功、拒付、超时、处理中、金额不一致。

**Files:**
- Create: `api/src/modules/payment/sandbox-payment.provider.ts`
- Create: `api/src/common/payment/sandbox-payout.provider.ts`
- Create: `api/test/mock-channel-server.ts`
- Modify: `api/.env.example`（`SANDBOX_CHANNEL_URL` / `SANDBOX_PAYOUT_ASYNC` / `SANDBOX_SCENARIO`）
- Modify: 注册表（注册 sandbox，受 `*_ENABLED_CHANNELS` 与 `NODE_ENV` 控制）
- Test: `api/src/modules/payment/sandbox-payment.provider.spec.ts`
- Test: `api/src/common/payment/sandbox-payout.provider.spec.ts`

**Steps:**
- [ ] mock 服务实现 `POST /pay`、`POST /payout`、`GET /payout/:referenceNo`、`GET /payouts`、`POST /refund`、`GET /refund/:refundTxnId`、`POST /webhook`。
- [ ] 沙箱支付：创建支付返回可用 URL；回调走 HMAC 验签；`capabilities` 声明 `refund=true` / `asyncRefund=true`。
- [ ] 沙箱出款：默认同步；`SANDBOX_PAYOUT_ASYNC=true` 时 `submit` 返回 `PROCESSING`，`queryPayout` 在 N 秒后转终态。
- [ ] 场景注入：`success` / `reject` / `timeout` / `amount_mismatch` / `processing`；`reject` 返回 `definitive=true`，`timeout` 抛异常。
- [ ] 注册规则：`devOnly=true`，生产即使配了也注册失败或启动失败（Task 2 已做，双重保险）。

**Tests:**
- [ ] 五种场景各自走到预期分支。
- [ ] 回调验签失败 → 抛异常且不落库（provider 层）。
- [ ] 异步模式下，第一次 `submit` 返回 `PROCESSING`，随后 `queryPayout` 返回 `SUCCESS`。
- [ ] `timeout` 场景抛异常，调用方能落 `definitive=false`。

**Done when:** 沙箱可在测试里跑通一条完整支付/出款链路，且不依赖进程内直调。

---

### Task 12：契约测试套件

**Goal:** 任何 provider（fake / sandbox / 将来的真渠道）都必须通过同一套契约。

**Files:**
- Create: `api/test/channel-contract/payment-provider.contract.ts`
- Create: `api/test/channel-contract/payout-provider.contract.ts`
- Create: `api/test/channel-contract/payment-provider.contract.spec.ts`
- Create: `api/test/channel-contract/payout-provider.contract.spec.ts`
- Modify: `api/test/jest-e2e.json`（如契约测试走 e2e 配置）

**Steps:**
- [ ] 抽出 `runPaymentProviderContract({ createProvider })` 与 `runPayoutProviderContract({ createProvider })`。
- [ ] 支付契约 6 条、出款契约 8 条（见设计 §8.3）。
- [ ] 对 `fake` 与 `sandbox` 各跑一遍；异步用例在同步 provider 上 `it.skip` 并显式标注原因。
- [ ] 分页契约 A/B 必须覆盖「provider 忽略 pageSize」与「NaN 回落」。
- [ ] 契约套件写进 `AGENTS.md`：新渠道准入闸。

**Tests:**
- [ ] `fake` 全绿。
- [ ] `sandbox` 全绿。
- [ ] 故意让 sandbox 每页只返回 100 条 → 分页契约 A 必须红。
- [ ] 故意让 `queryPayout` 把 `UNKNOWN` 映射成 `FAILED` → 契约必须红。

**Done when:** 契约套件成为新增渠道的准入闸。

---

### Task 13：超时预算与日志钩子

**Goal:** 真渠道分页不因固定 30 秒超时失败；关键路径有结构化日志与告警钩子。

**Files:**
- Modify: `api/src/modules/payment/payout-reconciliation.service.ts`
- Modify: `api/src/common/payment/payout-provider.registry.ts`（provider timeout）
- Create: `api/src/common/channel/channel-alert.ts`
- Test: `api/src/modules/payment/payout-reconciliation.service.spec.ts`
- Test: `api/src/common/channel/channel-alert.spec.ts`（若不存在则 Create）

**Steps:**
- [ ] provider 描述符增加 `timeoutMs`（默认 10s；对账单页 30s）。
- [ ] 对账翻页预算 = `页数 × 单页超时`，不再固定 30 秒；超过预算抛现有中文错误。
- [ ] 可选并发翻页（最多 3 页），先去重再比对，顺序无关。
- [ ] 统一日志字段 `channel/provider/operation/referenceNo/attempt/definitive/elapsedMs`。
- [ ] `ChannelAlertSink` 默认实现打 `error` 日志；不引入新依赖。

**Tests:**
- [ ] 20 页 × 单页 2 秒的模拟 provider 不再被 30 秒固定超时打断。
- [ ] 超预算时抛错文案与现有一致。
- [ ] 日志不包含账号/密钥（用 spy 断言）。

**Done when:** 分页超时测试通过；日志字段有单测。

---

### 6b 验收

- [ ] `cd api && npm test` 全绿；`npm run test:e2e` 全绿。
- [ ] 沙箱异步出款链路可手动复现：`submit → PROCESSING → scanStuck → PAID`。
- [ ] 失败注入记录：`definitive` 写反、`PROCESSING` 落失败路径、同步渠道被轮询。
- [ ] 记录 acceptance：`docs/superpowers/plans/2026-11-02-plan-06b-acceptance.md`（实施后）。

---

## 6c 异步退款

> 6c 是破坏性变更：`PaymentProvider.refund()` 的返回类型变化。需要**迁移 C**。
> 关键原则：**`REFUNDED` 只在渠道确认成功后才写**；`REFUNDING` 是「已受理、结果未知」的唯一合法状态。

### Task 14：退款契约改造

**Goal:** 退款从「调用即成功」改成「受理 → 查询/回调」，支持 `SUCCESS / PROCESSING / FAILED` 与 `definitive`。

**Files:**
- Modify: `api/src/modules/payment/payment-provider.interface.ts`
- Modify: `api/src/modules/payment/fake-payment.provider.ts`
- Modify: `api/src/modules/payment/fake-payment.provider.spec.ts`
- Modify: `api/src/modules/payment/payment.service.ts`（先改调用形状，状态机在 Task 15）
- Modify: `api/src/modules/payment/payment.service.spec.ts`

**Steps:**
- [ ] 定义 `RefundResult` / `RefundQueryResult`（见设计 §5.2）；`FAILED` 必带 `definitive`。
- [ ] `PaymentProvider` 增加 `queryRefund(refundTxnId)`；`NormalizedWebhookEvent` 增加 `eventType` / `refundTxnId` / `refundStatus`（见设计 §5.4）。
- [ ] `fake-payment.provider.ts` 实现新返回类型：默认同步 `SUCCESS`；`armScenario('refund_processing')` 返回 `PROCESSING`。
- [ ] 全仓搜索 `provider.refund(` 并改完调用方与 mock；不保留旧返回类型。
- [ ] 未知 `eventType` 落 400 且不落库（在 Task 15 的 webhook 分流里落实）。

**Tests:**
- [ ] `refund` 返回 `PROCESSING` 时，`queryRefund` 最终返回 `SUCCESS`。
- [ ] `FAILED + definitive=true` / `false` 可区分。
- [ ] `queryRefund` 查无此单 → `UNKNOWN`。
- [ ] 退款金额与支付金额不一致 → 拒绝。

**Done when:** 退款契约能表达异步；所有旧 mock 改完。

---

### Task 15：REFUNDING 状态机、扫描与 webhook 分流

**Goal:** 退款受理后落 `REFUNDING`，只有渠道确认成功才落 `REFUNDED`；失败可安全重试；未知只告警。

**Files:**
- Create: `api/prisma/migrations/<ts>_add_refund_async_fields/migration.sql`（**迁移 C**）
- Modify: `api/prisma/schema.prisma`
- Modify: `api/src/modules/payment/payment.service.ts`
- Modify: `api/src/modules/payment/payment.controller.ts`
- Modify: `api/src/modules/payment/webhook.controller.ts`
- Modify: `api/src/modules/payment/payment.module.ts`（注册退款扫描）
- Create: `api/src/modules/payment/refund-scan.scheduler.ts`（如需）
- Test: `api/src/modules/payment/payment.service.spec.ts`
- Test: `api/src/modules/payment/webhook.controller.spec.ts`
- Test: `api/src/modules/payment/refund-scan.scheduler.spec.ts`（如需）

**Migration C（手写）:**
- [ ] `ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDING';`
- [ ] `ALTER TABLE "payments" ADD COLUMN "refundTxnId" TEXT;`
- [ ] `ALTER TABLE "payments" ADD COLUMN "refundRequestedAt" TIMESTAMP(3);`
- [ ] `ALTER TABLE "payments" ADD COLUMN "refundFailureReason" TEXT;`
- [ ] `ALTER TABLE "payments" ADD COLUMN "refundAttemptCount" INTEGER NOT NULL DEFAULT 0;`
- [ ] 同一个文件内不得使用 `REFUNDING` 值；用 `migrate diff` 核对。

**Steps:**
- [ ] `schema.prisma`：`PaymentStatus` 增加 `REFUNDING`；`Payment` 增加上述 5 个字段并写注释（`refundTxnId` 是 `queryRefund` 的键；`refundAttemptCount` 用于重试预算）。
- [ ] 退款主流程改造：
  1. 条件更新 `SUCCESS → REFUNDING`，`refundAttemptCount + 1`，写 `refundRequestedAt`（闸门仍只允许一个并发请求）。
  2. 调 `provider.refund()`：
     - `SUCCESS` → 现有事务（`Payment REFUNDED` + `Order REFUNDED` + 抽佣/货款冲回）。
     - `PROCESSING` → 保持 `REFUNDING`，写 `refundTxnId`，返回「退款处理中」。
     - `FAILED + definitive=true` → 回退 `SUCCESS`（`releaseRefundClaim` 改为 `REFUNDING → SUCCESS`），写 `refundFailureReason`，允许重试。
     - `FAILED + definitive=false` / 抛异常 → 保持 `REFUNDING`，交给扫描。
- [ ] `payment.controller.ts` 的退款响应增加 `{ status: 'REFUNDED' | 'REFUNDING' }`（前端不解析渠道私有字段）。
- [ ] webhook 分流：按 `eventType` 走支付/退款；退款事件按 `(provider, eventId)` 幂等；未知 `eventType` → 400 且不落库。
- [ ] 退款事件处理：
  - `SUCCESS` → 条件更新 `REFUNDING → REFUNDED`，执行现有的订单/抽佣/货款冲回事务。
  - `FAILED + definitive=true` → 回退 `SUCCESS`。
  - `PROCESSING` / `UNKNOWN` / 无 `definitive` → 只记日志，状态不变。
- [ ] `scanRefunding`（周期任务，复用 `PayoutScanScheduler` 的形态）：
  - 捞 `REFUNDING` 且 `refundRequestedAt` 超过阈值的单（单轮上限 50）；
  - 有 `refundTxnId` → `queryRefund`；没有 → 只告警（渠道未给受理号，无法查询）；
  - `SUCCESS` → 落 `REFUNDED`；`FAILED + definitive=true` → 回退 `SUCCESS`；其余只告警；
  - 本阶段不加告警去重列；用「日志 + 每轮最多一次」即可，不新增迁移。

**Tests:**
- [ ] `refund` 返回 `PROCESSING` → `payments.status = REFUNDING`，订单仍 `PAID`/`SHIPPED`，未冲回。
- [ ] `REFUNDING` + 回调 `SUCCESS` → `payments.status = REFUNDED`、订单 `REFUNDED`、冲回流水各一条。
- [ ] `REFUNDING` + 回调 `FAILED + definitive=true` → 回退 `SUCCESS`，可再次发起退款。
- [ ] `REFUNDING` + 回调 `FAILED + definitive=false` → 状态不变，只记日志。
- [ ] 并发两个退款请求 → 只有一个调渠道（条件更新挡住第二个）。
- [ ] 未知 `eventType` 的 webhook → 400 且不写 `payment_webhook_events`。
- [ ] `scanRefunding` 单轮最多处理 50 张；没有 `refundTxnId` 的单不调渠道。

**Done when:** 异步退款全链路可复现；`REFUNDED` 只由渠道确认成功触发。

---

### Task 16：沙箱异步退款与契约测试扩展

**Goal:** 沙箱能模拟异步退款；支付契约覆盖退款异步分支。

**Files:**
- Modify: `api/src/modules/payment/sandbox-payment.provider.ts`
- Modify: `api/test/mock-channel-server.ts`
- Modify: `api/test/channel-contract/payment-provider.contract.ts`
- Test: `api/src/modules/payment/sandbox-payment.provider.spec.ts`

**Steps:**
- [ ] `SANDBOX_REFUND_ASYNC=true` 时 `refund` 返回 `PROCESSING`，`queryRefund` 在 N 秒后转终态。
- [ ] mock 服务的 `POST /refund` / `GET /refund/:refundTxnId` 与沙箱实现对齐。
- [ ] 支付契约增加：异步退款 `PROCESSING → SUCCESS`、`FAILED + definitive` 两分支。
- [ ] `fake` 跳过异步退款用例并标注原因。

**Tests:**
- [ ] 沙箱异步退款：受理 → `PROCESSING` → 查询 → `SUCCESS`。
- [ ] 沙箱拒付：`FAILED + definitive=true`。
- [ ] 契约套件对 `fake` / `sandbox` 全绿。

**Done when:** 退款契约也有准入闸，和出款同等严格。

---

### Task 17：文档、验收与迁移检查

**Goal:** 把设计/计划/验收写进仓库，确认没有遗漏的迁移与兼容问题。

**Files:**
- Create: `docs/superpowers/specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md`（已迁入，实施期只补偏离记录）
- Create: `docs/superpowers/plans/2026-11-02-plan-06-channel-adapter-sandbox.md`（已迁入）
- Create: `docs/superpowers/plans/2026-11-02-plan-06-acceptance.md`
- Modify: `README.md`（测试条数、渠道说明、剩余技术债）
- Modify: `AGENTS.md`（渠道配置、平台设置、契约测试准入、默认渠道解析）
- Modify: `.opencode`/`CLAUDE.md`（如存在）

**Steps:**
- [ ] 迁移两份文档，补实施期偏离记录。
- [ ] 跑全量 `npm test` / `npm run test:e2e` / 三端 `npm test`。
- [ ] 失败注入记录：`definitive` 写反、路由取错渠道、CSV 闸失效、分页忽略 pageSize、退款 `PROCESSING` 落 `REFUNDED`、批量确认部分失败、平台默认渠道停用。
- [ ] 确认三个迁移的 `prisma migrate diff` 为空；若有差异，补手写迁移。
- [ ] README 的「剩余技术债」删掉本阶段已解决项，保留未解决项（告警系统、CI、分布式锁、真实渠道）。
- [ ] AGENTS.md 写清：`sandbox` 仅开发可见；新渠道必须先过契约测试；平台默认渠道在 `/settings` 配置。

**Done when:** acceptance 记录包含测试条数、失败注入结果、遗留清单；文档与代码一致。

---

## 依赖关系

```
6a
Task 1 ── Task 2 ── Task 3
   │         │
   ├── Task 4 ── Task 5 ── Task 6 ── Task 7   （迁移 A/B；可独立合并上线）
   │
6b（依赖 6a 的注册表与路由）
Task 8 ── Task 9 ── Task 10
             │
Task 11 ─────┴── Task 12 ── Task 13

6c（依赖 6b 的契约风格与沙箱）
Task 14 ── Task 15 ── Task 16   （迁移 C）

收尾
Task 17（依赖 6a/6b/6c 全部完成）
```

## 建议的提交拆分

1. `feat(api): 渠道描述符与支付/出款注册表`
2. `feat(api): 渠道配置与生产环境启动校验`
3. `feat(api): 支付能力门控与 webhook 渠道路由`
4. `feat(api): 平台默认渠道设置与超管后台`（含迁移 A）
5. `feat(api): 商家默认出款渠道与账户页`（含迁移 B）
6. `feat(api): 出款按 payoutChannel 路由并解析默认渠道`
7. `fix(api): 对账按渠道隔离并给 CSV 自动纠正加闸`
8. `feat(api): CSV 对账差异批量与全选确认`（含平台端 UI）
9. `refactor(api)!: 出款契约改为 submit/query 并引入 definitive`
10. `feat(api): worker 处理 PROCESSING 并由 scanStuck 轮询`
11. `feat(api): 沙箱渠道与 HTTP mock 服务`
12. `test(api): 支付/出款渠道契约测试`
13. `feat(api): 对账超时预算与渠道告警钩子`
14. `refactor(api)!: 退款契约改为异步 refund/queryRefund`
15. `feat(api): REFUNDING 状态机与退款扫描`（含迁移 C）
16. `feat(api): 沙箱异步退款与退款契约测试`
17. `docs: 阶段 6 设计与验收记录`

> `!` 表示破坏性变更：`PayoutProvider.execute()` 删除、`PaymentProvider.refund()` 返回类型变化。合并前确认没有其他分支依赖旧契约。

## 本阶段明确不做

- 真实微信/支付宝/银行渠道接入
- 真实退款回调的具体渠道格式（契约与状态机已按异步设计）
- 告警系统落地（只留 `ChannelAlertSink`）
- 跨副本分布式锁
- 通用平台设置中心（只做「平台默认出款渠道」一项）
- CSV 批量确认的严重级/状态筛选（本阶段「筛选结果」= 全部 A 类待处置项）
