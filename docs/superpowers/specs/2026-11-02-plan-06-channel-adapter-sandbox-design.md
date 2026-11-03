# 阶段 6「渠道适配层与沙箱」设计

> 状态：草案（2026-11-02）
> 范围：**适配层、渠道路由、沙箱与契约测试**；不接真实微信 / 支付宝 / 银行。
> 依据：阶段 5m 验收记录 §六、根 README「阶段 5m 之后的剩余技术债」、当前 `api/src` 代码。
>
> 文档位置：`docs/superpowers/specs/2026-11-02-plan-06-channel-adapter-sandbox-design.md`。

---

## 一、目标与非目标

### 1.1 目标

1. **渠道可插拔**：新增渠道只改注册表与适配器，不改 `order` / `billing` / 对账主流程。
2. **按渠道路由**：去掉 `firstProvider()` / `pickProvider()` 的「取第一个」，改为按 `payouts.payoutChannel` 精确路由。
3. **默认渠道可配置**：商家在账户页配置，平台在超管后台配置（`platform_settings` 表）；商家优先，没有则平台；两者都没有则 fail-closed。
4. **出款契约能吃下异步**：把同步 `execute()` 拆成 `submit()` + `queryPayout()`，支持 `PROCESSING`。
5. **退款契约能吃下异步**：真实渠道退款是异步的，引入 `REFUNDING` 与 `queryRefund()`，不再假设「调用即退款成功」。
6. **失败语义可判定**：区分「渠道明确拒付」与「超时 / 结果未知」，前者才允许安全重试。
7. **对账多渠道隔离**：本地出款单、差异去重、CSV 来源都按渠道/来源隔离。
8. **CSV 人工确认支持批量与全选**：CSV 来源的 A 类差异不自动纠正；支持勾选当前列表，也支持「全选筛选结果」（服务端按游标分批推进，不一次吃下整张表）。
9. **沙箱仅开发可见**：`sandbox` 渠道只在非生产环境注册/展示，生产启用直接拒绝启动。
10. **契约测试**：任何候选渠道（含沙箱）都必须先通过同一套支付/出款契约测试。
11. **平台可运维**：平台默认渠道有超管后台 UI，改动留痕（`updatedBy` / `updatedAt`）。

### 1.2 非目标（本阶段明确不做）

- 真实微信支付 / 支付宝 / 银行代付的实现与商户资质、证书、密钥托管。
- 真实渠道退款的具体对接（**契约、状态机、沙箱与契约测试**在本阶段，真实实现后续）。
- 生产级告警系统（只预留结构化日志与告警钩子）。
- 跨副本分布式锁（扩副本前另立专项）。
- 渠道计费、限额、风控、合规材料。
- 通用「平台设置中心」：本阶段只做**出款默认渠道**这一项设置，不做任意 key-value 配置 UI。

---

## 二、现状与问题（代码证据）

### 2.1 注册表硬编码单一渠道

- 支付：`api/src/modules/payment/payment.module.ts:118-124` 用 `useFactory` 注册 `Map`，只 `set(fake.channel, fake)`。
- 出款：`api/src/common/payment/payout-providers.module.ts` 同样只注册 `FakePayoutProvider`。
- 结果：没有「启用哪些渠道」「默认渠道」「未启用渠道如何报错」的概念。

### 2.2 出款取「第一个渠道」

- `api/src/modules/payment/payout.worker.ts:424` `firstProvider()` 返回 `providers.values()` 的第一项。
- `api/src/common/payment/payout-verification.service.ts:230` `pickProvider()` 同样取第一个。
- 注释已明确：接第二家渠道时，两处必须一起改，否则会出现「钱打到 A、核实查 B」→ 重复打款。
- `payouts.payoutChannel` 已有，`PayoutExecutionService.recordChannel` 在调渠道前写入；但路由逻辑还没用它。

### 2.3 出款契约是同步的

- `api/src/common/payment/payout-provider.interface.ts` 的 `execute()` 返回 `PayoutExecuteResult`，调用方只认 `status === 'SUCCESS'`，其余一律走失败路径。
- 真实渠道大概率是「提交 → 轮询 / 回调」，接口注释自己已经写了「接入时形状要重新评估，不能在接口里假装同步」。
- 现状没有 `PROCESSING` 分支：渠道返回处理中会被当成失败，可能触发不安全的重试。

### 2.4 失败语义不可判定

- `PayoutExecuteResult` 只有 `status` / `amount` / `failureReason`。
- 无法区分「渠道明确拒付」与「超时不知道打没打」。
- 这直接导致 5m 遗留：「渠道明确拒付的单仍不能一键重试」。

### 2.5 退款是同步假设

- `api/src/modules/payment/payment.service.ts:986` 的 `refund()`：
  1. 先把 `payments.status` 条件更新成 `REFUNDED` 当作闸门；
  2. 再调 `provider.refund()`；
  3. 失败才把状态还回去。
- `PaymentStatus` 只有 `PENDING / SUCCESS / FAILED / CLOSED / REFUNDED`，**没有 `REFUNDING`**。
- 真实渠道退款是异步的：调用只代表「受理」，不代表钱已退。按现状，渠道返回「处理中」会被当成失败并释放闸门，可能重复退款；或者被当成成功，账面先退而钱没退。

### 2.6 对账没有按渠道隔离

- `api/src/modules/payment/payout-reconciliation.service.ts:487` `loadLocalPayouts(from, to)` 不按 `payoutChannel` 过滤。
- `:533` `supersedePreviousPending` 不按渠道限定，第二家渠道会把别家的同 `(payoutId, type)` PENDING 项标掉。
- 5m 验收 §6.3 已把它列为新发现的问题。

### 2.7 CSV 来源没有自动纠正闸

- `payout-reconciliation.service.ts:112` 与 `:419` 分别写 `source: API` / `source: FILE`。
- `PayoutReconciliationResolver.resolveAutoDiffs()` 不接收 `source`，A 类一律自动改 `PROCESSING → PAID`。
- 运营把 CSV 某个状态词映射成 `SUCCESS`，就能自动把一张卡在 `PROCESSING` 的单改成已付款。

### 2.8 分页已有，但超时预算没重算

- `listPayouts` 已支持 `page/pageSize`，`fetchChannelRecords` 已循环翻页，并有上限、去重、空串保护（5m 后的 `cbd3b35` 已补）。
- 但 `RECONCILIATION_TIMEOUT_MS` 仍是固定 30 秒；真渠道每页 1–2 秒、20 页必然超时。
- 需要按「页数 × 单页超时」重算，或改为并发翻页。

### 2.9 生产运维缺口（本阶段只预留，不解决）

- 没有告警；`scanStuck` 对 `PROCESSING` 只写 `stuckLoggedAt` 并打日志。
- 没有 CI；没有分布式锁；密钥仍是环境变量明文注入。

---

## 三、设计原则

1. **channel 与 provider 分开**：`channel` 是用户/运营看到的渠道名，`provider` 是背后的服务提供方（直连 vs 服务商）。幂等与对账按 `provider` 走，路由按 `channel` 走。
2. **显式启用，fail-closed**：没有注册或没有启用的渠道，调用时立刻报中文错误，不静默回落到第一个。
3. **契约归一化**：调用方只认归一化后的 `SUCCESS / PROCESSING / FAILED / UNKNOWN`，不解析渠道私有状态。
4. **渠道是权威，但机器不猜**：渠道明确说成功 → 可以自动纠正；渠道明确说失败 → 可以安全重试；结果未知 → 只告警 / 人工。
5. **适配层不泄漏到领域层**：`billing` 仍然不能 import `payment`；出款契约继续放在 `common/payment/`，注册表继续用 `@Global()` 模块。
6. **金额整数分、时间用数据库时钟、幂等键用业务单号**：与现有约定一致。
7. **沙箱与生产同契约**：沙箱不是旁路，它必须走同一套接口、同一套验签、同一套失败注入；但**只在开发环境可见**。
8. **默认渠道解析顺序固定**：`payouts.payoutChannel`（已定）→ 商家配置 → 平台配置 → 失败。禁止「取第一个」。

---

## 四、渠道模型

### 4.1 描述符

```ts
export interface ChannelDescriptor {
  channel: string;
  provider: string;
  enabled: boolean;
  /** 是否仅开发环境可见（sandbox=true） */
  devOnly: boolean;
  capabilities: ChannelCapabilities;
}

export interface ChannelCapabilities {
  refund: boolean;
  /** 退款是否异步（真实渠道通常为 true） */
  asyncRefund: boolean;
  authorizedCharge: boolean;
  paymentMethod: boolean;
  /** 出款是否异步 */
  asyncPayout: boolean;
  /** 是否支持按 referenceNo 查询（PROCESSING 的单没有 providerTxnId） */
  queryByReferenceNo: boolean;
  /** 是否提供批量流水（对账 API 模式） */
  listPayouts: boolean;
}
```

### 4.2 注册表

新增两个注册表服务，替代 `useFactory` 里的裸 `Map`：

- `api/src/modules/payment/payment-provider.registry.ts`
- `api/src/common/payment/payout-provider.registry.ts`

接口：

```ts
class PayoutProviderRegistry {
  get(channel: string): PayoutProvider;        // 未注册/未启用 → 抛中文异常
  resolveForPayout(input: {
    payoutChannel?: string | null;
    merchantChannel?: string | null;
    platformChannel: string;                   // 由调用方先解析（DB → env）
  }): PayoutProvider;
  list(options?: { includeDevOnly?: boolean }): ChannelDescriptor[];
}
```

⚠️ **注册表不读 DB、不读默认渠道配置** —— 它只做「渠道名 → 实现」的解析与启用校验。平台默认渠道的 DB → env 解析在 `PlatformSettingService`，避免 `PayoutProvidersModule ↔ PlatformSettingsModule` 循环依赖。

注册表由 `payment.module.ts` / `payout-providers.module.ts` 构建；保留现有 `PAYMENT_PROVIDERS` / `PAYOUT_PROVIDERS` 注入令牌作为兼容层，但**新代码只依赖注册表**。

### 4.3 配置

```bash
# 逗号分隔；不设时非生产回落各自的默认渠道，生产必须显式设置。
# ⚠️ 支付与出款的假网关**渠道名不同**（两个独立实现、两个独立开关）：
#    支付是 `fake`，出款是 `fake-payout`。写成同一个名字会让人以为开一个就开了两个。
PAYMENT_ENABLED_CHANNELS=fake
PAYOUT_ENABLED_CHANNELS=fake-payout

# 沙箱（仅开发环境可见）需要显式加入启用列表
PAYMENT_ENABLED_CHANNELS=fake,sandbox
PAYOUT_ENABLED_CHANNELS=fake-payout,sandbox

# 平台默认渠道的**兜底值**（DB 里 platform_settings 没配时才用它）
PAYOUT_PLATFORM_DEFAULT_CHANNEL=fake-payout

# 沙箱/假网关模式；生产启用直接拒绝启动
CHANNEL_MODE=sandbox
```

> ⚠️ 上面的「非生产默认」由 `api/src/common/channel/channel-config.ts` 的
> `DEV_DEFAULT_CHANNELS` 决定（`PAYMENT → fake`、`PAYOUT → fake-payout`），
> 与 `DEV_ONLY_CHANNELS`（`fake` / `fake-payout` / `sandbox`）同在一处 —— 别在别处再写一份。

启动校验（扩展 `assert-secure-config.ts`）：

1. `NODE_ENV=production` 时，`CHANNEL_MODE=sandbox` 或启用 `fake` / `sandbox` → 硬失败。
2. 启用列表里的每个 channel 必须有对应 provider 实现；否则启动失败。
3. `PAYOUT_PLATFORM_DEFAULT_CHANNEL` 若设置，必须在启用列表内；生产允许不设（改由平台 UI 配置）。
4. 未启用渠道被调用 → 409（运营可读的中文原因），不是 500。
5. `list()` 默认过滤 `devOnly`；只有非生产且显式 `includeDevOnly` 时才返回 `sandbox`。

⚠️ **DB 里的平台默认渠道在启动时无法校验**（启动校验只读环境变量）。它在写入时校验一次、在每次读取时再校验一次；读到未启用/已停用的渠道 → fail-closed，不回落。

### 4.4 默认渠道解析（商家 → 平台 → 失败）

**商家配置**落在 `merchant_payout_accounts.preferredChannel`（与收款账户同一张表，避免为单个字段新建表）。**平台配置**落在 `platform_settings` 表里 `key = 'payout.platformDefaultChannel'` 的一行；`PAYOUT_PLATFORM_DEFAULT_CHANNEL` 只在 DB 没有这行时兜底（首次部署 / 迁移前）。

`GET /merchant/payout-account` 额外返回：

```ts
{
  preferredChannel: string | null;      // 商家自己配的
  effectiveChannel: string;             // 最终会用的
  effectiveSource: 'MERCHANT' | 'PLATFORM';
  preferredChannelUnavailable: boolean; // 商家配了但渠道已停用 → 执行时 fail-closed
}
```

目的是让商家能看出「我没配，现在用的是平台默认」，以及「我配的渠道已停用，需要改」。
⚠️ 商家配置停用时**不回落**到平台默认：`effectiveChannel` 仍显示商家值，执行时直接报错。

解析顺序（仅在出款进入执行时解析一次）：

1. `payouts.payoutChannel` 已有值（重试 / 重新提交）→ 沿用，保证同一张单不会换渠道。
2. `merchant_payout_accounts.preferredChannel` 有值 → 用它。
3. `platform_settings['payout.platformDefaultChannel']` → 用它；DB 没有这行时用 `PAYOUT_PLATFORM_DEFAULT_CHANNEL`。
4. 都没有 / 配置的渠道未启用 → 抛中文错误，**不回落**、不猜（API 场景表现为 409；worker 场景落 `FAILED + failedBeforePayout=true`）。

⚠️ 商家配置了但渠道已停用 → 报错让商家改，不静默切到平台默认（钱打到哪家必须是确定的）。
⚠️ 解析结果在 `claimForExecution` 时写入 `payouts.payoutChannel`，worker 只读它。
⚠️ **平台默认渠道每次从 DB 读，不做进程内缓存** —— 多副本下没有可靠的失效机制，缓存会让「刚在后台改完、打款还用旧渠道」。

### 4.5 平台默认渠道配置（`platform_settings`）

数据模型（非租户作用域，**不要**登记到 `tenant-models.ts`）：

```prisma
model PlatformSetting {
  id        String   @id @default(uuid())
  key       String   @unique
  value     Json
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("platform_settings")
}
```

服务：`PlatformSettingService`（放 `api/src/common/platform-settings/`，只依赖 `TenancyModule`，**不依赖注册表**）

```ts
getPayoutDefaultChannel(): Promise<{ channel: string; source: 'DATABASE' | 'ENV' }>;
setPayoutDefaultChannel(channel: string, operatorId: string): Promise<void>;
```

控制器放 `api/src/modules/platform-settings/`（可注入全局的 `PayoutProviderRegistry` 来列出可用渠道）。
⚠️ 这个拆分是为了避开 `PayoutProvidersModule`（核实服务要读平台默认渠道）与设置模块之间的循环依赖。

- 读取：`key = 'payout.platformDefaultChannel'`；无行则回落 `PAYOUT_PLATFORM_DEFAULT_CHANNEL`；两者都没有 → 抛中文错误。
- 写入：先用 `channel-config.isChannelEnabled('PAYOUT', channel)` 校验「已启用且非 devOnly（生产）」，再 `upsert`；记录 `updatedBy`。
  ⚠️ **不通过 `PayoutProviderRegistry` 校验** —— 否则 `PayoutProvidersModule`（要注入本 service 做核实兜底）与本模块形成环。`channel-config` 是纯环境变量解析，两处共用。
- 读取时也校验：DB 里的渠道可能已被停用（配置变更）→ fail-closed，不静默换渠道。

接口（全部 `PLATFORM_ADMIN`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/platform/settings/payout-channel` | `{ channel, source }` |
| `PUT` | `/platform/settings/payout-channel` | 校验后写 DB，返回 `{ channel, source: 'DATABASE' }` |
| `GET` | `/platform/settings/payout-channels` | 可选出款渠道（过滤 `devOnly`），供下拉 |

超管后台：

- 新增导航「设置」→ `/settings`。
- 页面展示当前平台默认渠道 / 来源（DB 还是环境变量兜底），下拉只列出已启用渠道；生产看不到 sandbox。
- 保存走同源 `PUT /api/settings/payout-channel`，body 白名单只放行 `{ channel }`。
- 文案写明：**只影响新出款单**；已审批 / 处理中的单按 `payouts.payoutChannel` 走，不会换渠道。

---

## 五、支付适配层

### 5.1 能力门控

- `PaymentProvider` 增加 `readonly capabilities: ChannelCapabilities`。
- `payment.service.ts` / `payment-method.service.ts` / 退款路径在调用前检查能力：
  - 不支持退款 → 409「当前渠道不支持在线退款」；
  - 不支持已授权扣款 → 409「当前渠道不支持自动续费」；
  - 不支持创建支付方式 → 409。
- `webhook.controller.ts` 的 `:channel` 路由改为走注册表；未知/未启用渠道返回 404。
- `parseWebhook` 的验签失败仍然是 401 且不落库（现有约定）。

### 5.2 异步退款契约

真实渠道退款是异步的，退款契约必须从「调用即成功」改成「受理 → 查询/回调」。

```ts
export type RefundResult =
  | { status: 'SUCCESS'; refundTxnId: string; amount: number }
  | { status: 'PROCESSING'; refundTxnId?: string }
  | {
      status: 'FAILED';
      refundTxnId?: string;
      /** true = 渠道明确拒绝；false = 超时/结果未知 */
      definitive: boolean;
      failureReason?: string;
    };

export interface RefundQueryResult {
  status: 'SUCCESS' | 'PROCESSING' | 'FAILED' | 'UNKNOWN';
  refundTxnId?: string;
  amount?: number;
  /** 仅 FAILED 有意义 */
  definitive?: boolean;
  failureReason?: string;
}
```

`PaymentProvider` 增加：

```ts
refund(input: { paymentId: string; amount: number; reason: string }): Promise<RefundResult>;
queryRefund(refundTxnId: string): Promise<RefundQueryResult>;
```

### 5.3 退款状态机

数据模型（手写迁移）：

- `PaymentStatus` 增加 `REFUNDING`。
- `Payment` 增加：
  - `refundTxnId String?`
  - `refundRequestedAt DateTime?`
  - `refundFailureReason String?`
  - `refundAttemptCount Int @default(0)`

流程：

1. 商家发起退款：条件更新 `SUCCESS → REFUNDING`，`refundAttemptCount + 1`，写 `refundRequestedAt`。
2. 调 `provider.refund()`：
   - `SUCCESS` → 走现有「Payment REFUNDED + Order REFUNDED + 冲回抽佣」事务。
   - `PROCESSING` → 保持 `REFUNDING`，写 `refundTxnId`，返回「退款处理中」。
   - `FAILED + definitive=true` → 回退 `SUCCESS`，写 `refundFailureReason`，允许重试。
   - `FAILED + definitive=false` / 抛异常 → 保持 `REFUNDING`，交给扫描核实。
3. 退款回调 / 扫描：
   - `queryRefund` / webhook 说 `SUCCESS` → 落 `REFUNDED` 并冲回抽佣。
   - `FAILED + definitive=true` → 回退 `SUCCESS`，允许重试。
   - `UNKNOWN` / `PROCESSING` → 只告警，不动状态。
4. 扫描：复用 `scanStuck` 的思路，新增 `scanRefunding`（只处理 `REFUNDING` 超时的单，限量 50）。

⚠️ **`REFUNDED` 只在渠道确认成功后才写**；`REFUNDING` 是「已受理、结果未知」的唯一合法状态。
⚠️ 退款回调的 `eventId` 仍走 `payment_webhook_events` 幂等；退款事件与支付事件共用同一张表，按 `provider + eventId` 去重。

### 5.4 回调归一化

`NormalizedWebhookEvent` 增加：

```ts
eventType: 'PAYMENT' | 'REFUND';
/** 退款事件才有 */
refundTxnId?: string;
refundStatus?: 'SUCCESS' | 'FAILED' | 'PROCESSING';
```

`webhook.controller.ts` 按 `eventType` 分流：支付事件走现有订单/账单路径；退款事件走退款状态机。未知 `eventType` 落 400 且不落库。

### 5.5 不变的部分

- 支付单、webhook 幂等、金额核对、`(provider, providerTxnId)` 唯一索引都不改。
- 假网关保留，作为 `fake` 渠道；沙箱另起 `sandbox` 渠道，不覆盖 `fake` 的历史数据。

---

## 六、出款适配层（核心变更）

### 6.1 新契约

```ts
export type PayoutSubmitResult =
  | { status: 'SUCCESS'; providerTxnId: string; amount: number; paidAt?: Date }
  | { status: 'PROCESSING'; providerTxnId?: string; amount?: number }
  | {
      status: 'FAILED';
      providerTxnId?: string;
      amount?: number;
      definitive: boolean;
      failureReason?: string;
    };

export interface PayoutQueryResult {
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNKNOWN';
  providerTxnId?: string;
  amount?: number;
  paidAt?: Date;
  definitive?: boolean;
  failureReason?: string;
}

export interface PayoutProvider {
  readonly channel: string;
  readonly provider: string;
  readonly capabilities: ChannelCapabilities;

  submit(input: PayoutExecuteInput): Promise<PayoutSubmitResult>;
  queryPayout(query: PayoutQuery): Promise<PayoutQueryResult>;
  listPayouts(query: { from: Date; to: Date; page?: number; pageSize?: number }): Promise<ChannelPayoutRecord[]>;
}
```

> `PayoutExecuteInput` 保留原名，避免大范围改测试；`execute()` 删除，所有调用方改 `submit()`。

### 6.2 worker 状态机

`payout.worker.ts` 的 STEP 2/3 改为：

| submit 返回 | 落库动作 | `failedBeforePayout` | 后续 |
|---|---|---|---|
| `SUCCESS` | `markPaid`（现有） | — | 结束 |
| `FAILED` + `definitive=true` | `markFailed` | `true` | 进入现有重试预算 |
| `FAILED` + `definitive=false` | `markFailed` | `false` | 只能人工核对 |
| `PROCESSING` | 保持 `PROCESSING`，写 `processingAt` / `payoutChannel` | — | 交给 `scanStuck` 轮询 |
| `submit` 抛异常 | `markFailed` | `false`（保守） | 只能人工核对 |

⚠️ 关键：**`PROCESSING` 绝不能再当成失败**。现有 catch 分支把异常一律落 `FAILED`，要改成「异常 = 结果未知」，不能进自动重试。

### 6.3 卡住单轮询

不新增 worker，复用现有的 `scanStuck`（`payout-execution.service.ts:798`）：

1. 捞出 `PROCESSING` 且超过阈值的单。
2. 对每张单，用其 `payoutChannel` 调 `queryPayout({ referenceNo })`：
   - `SUCCESS` → `markPaid`（渠道是权威）；
   - `FAILED` + `definitive=true` → `markFailed(failedBeforePayout=true)`，允许运营重试；
   - `PROCESSING` / `UNKNOWN` / `definitive=false` → 维持现状：写 `stuckLoggedAt` + 告警日志。
3. 单次扫描限制条数（如 50），避免一次扫全表。

⚠️ 只有 `capabilities.asyncPayout=true` 的渠道才轮询；同步渠道的 `PROCESSING` 视为异常，仍然只告警。

### 6.4 渠道路由

- `payout.worker.ts`：`registry.get(claim.channel)`；claim 里带 `payoutChannel`（`claimForExecution` 的 select 补字段），解析失败走 `channelError`。
- `payout-verification.service.ts`：`pickProvider(channel)`，调用方把 `payoutChannel` 传进来。
- `PayoutExecutionService.recordChannel` 同时写 `payoutChannel`（已有）；本阶段不加 `payoutProvider` 列，provider 由注册表推导。
- **两处必须一起改、一起验**：worker 与核实服务取到不同渠道 = 重复打款。

---

## 七、对账多渠道隔离

### 7.1 本地单过滤

`loadLocalPayouts(channel, from, to)`：

```ts
where: {
  OR: [
    { payoutChannel: channel, paidAt: { gte: from, lt: to } },
    { payoutChannel: channel, processingAt: { gte: from, lt: to } },
    { payoutChannel: channel, failedAt: { gte: from, lt: to } },
  ],
}
```

存量 `payoutChannel = null` 的单（5m 之前）只在 `channel === 平台默认渠道` 时纳入（平台默认渠道由 `PlatformSettingService` 解析：DB → env），避免第二家渠道把它们误判成 D 类。

### 7.2 差异去重

`supersedePreviousPending` 按 `reconciliation.channel` 限定：

```ts
where: {
  reconciliation: { channel },   // 或先查任务再按 channel 过滤
  payoutId, type,
}
```

### 7.3 CSV 自动纠正闸与批量确认

`resolveAutoDiffs(diffs, reconciliationId, source)`：

- `source === API`：保持自动纠正 A 类。
- `source === FILE`：**不自动改状态**，把 A 类落成 `PENDING` 人工项，备注「CSV 来源需人工确认」。

人工确认：

- 单条与批量**共用同一条** `manualCorrectToPaid` 路径（A 类纠正 + 留痕 `RECONCILE_TO_PAID_BY_FILE` + 把 item 标 `RESOLVED`）；单条只是 `itemIds` 长度为 1。
- 现有 `resolveItem` 仍只负责「已处置 / 已忽略」的备注，**不改钱**；它不再承担 A 类确认。
- **批量**：新增 `POST /platform/payout-reconciliations/:id/items/batch-confirm`，支持两种模式：
  - `{ mode: 'IDS', itemIds: string[], note }`：勾选当前列表。`itemIds` 上限 200 且去重，`note` 1–200 字。
  - `{ mode: 'FILTER', cursor?, limit?, note }`：**全选筛选结果**。服务端固定条件为「属于该任务 + `resolution = PENDING` + `type = CHANNEL_PENDING_LOCAL` + `payoutId` 非空」，按 `id ASC` 游标取一批（`limit` 默认 200、上限 200），返回 `nextCursor`；客户端循环调用直到 `nextCursor = null`。
  - 前置：任务存在且 `source = FILE`，否则 409；非 FILE 任务不受理批量确认。
  - 逐条执行 A 类纠正（`PROCESSING → PAID`，与自动纠正同一条 `correctToPaid` 路径），留痕 `action = RECONCILE_TO_PAID_BY_FILE`、`operatorId = 真实操作人`、`reason` 带统一说明。
  - 纠正成功后把差异项标成 `RESOLVED`（`note` / `resolvedBy` / `resolvedAt`）。
  - 返回 `{ succeeded: string[], failed: Array<{ id, message }>, nextCursor: string | null }`；**允许部分成功**，不整体回滚。
  - 已处置 / 不属于该任务 / 类型不符的 item 计入失败，不静默跳过；游标仍然前进，避免同一条失败项被无限重试。
- 详情接口增加 `actionableCount`：该任务下 `PENDING + CHANNEL_PENDING_LOCAL + payoutId 非空` 的条数（仅 `source = FILE` 大于 0），供「确认全部（N 条）」按钮显示。
- 平台端详情页：差异表增加复选框（只对可批量确认的行显示）+ 表头「全选当前页」；底部操作条：
  - 「确认选中（N 条）」→ `mode = IDS`；
  - 「确认全部可批量确认（N 条）」→ `mode = FILTER` 循环，显示进度与失败数，可中途停止；停止后剩余项仍是 `PENDING`。
  - `prompt()` 收集统一说明，成功后 `router.refresh()`。

⚠️ **为什么不一次请求处理全部**：A 类纠正每条都要独立事务（`markPaid` + 留痕），几千条会超过 HTTP 超时并把连接占死；游标分批让每次请求有界、可中断、可重试。
⚠️ **并发运营**：两个人在同一任务上同时点「确认全部」是安全的 —— 每条的状态更新是条件更新，只有第一个成功；后到的计入 `failed`（「已处置」），不会重复打款。
⚠️ 批量确认不是「绕过校验」：每一条仍要复核「任务来源是 FILE / 类型是 A 类 / 仍是 PENDING / 属于该任务」，只是省点击，不省校验。
⚠️ A 类纠正与 B 类人工确认**不是一回事**：A 类是渠道说已打款、本地卡在 `PROCESSING` → `markPaid`；B 类是本地记成 `FAILED` → 走四道闸 `confirmPaidAfterReconciliation`。批量确认只做前者。

---

## 八、沙箱与契约测试

### 8.1 沙箱 provider（仅开发环境）

新增 `sandbox` 渠道（不复用 `fake`）：

- `api/src/modules/payment/sandbox-payment.provider.ts`
- `api/src/common/payment/sandbox-payout.provider.ts`

规则：

- 只在 `NODE_ENV !== 'production'` 且 `PAYMENT_ENABLED_CHANNELS` / `PAYOUT_ENABLED_CHANNELS` 显式包含时注册。
- `list()` 默认不返回 `devOnly` 渠道；平台端下拉在生产环境看不到 sandbox。
- 生产环境启用 sandbox（或 `CHANNEL_MODE=sandbox`）→ 启动失败。

行为：

- 支付：创建支付返回一个本地 sandbox 页面；回调走真实 HTTP + HMAC 验签；支持退款（异步）、已授权扣款、支付方式创建。
- 出款：默认同步；`SANDBOX_PAYOUT_ASYNC=true` 时返回 `PROCESSING`，由 `queryPayout` 在 N 秒后转 `SUCCESS` 或 `FAILED`。
- 退款：`SANDBOX_REFUND_ASYNC=true` 时返回 `PROCESSING`，由 `queryRefund` / 回调转终态。
- 失败注入：`SANDBOX_SCENARIO` 支持 `success` / `reject` / `timeout` / `amount_mismatch` / `processing`。

### 8.2 HTTP mock 服务

为了让「适配层」真的走 HTTP（而不是进程内直调），新增：

- `api/test/mock-channel-server.ts`：仅测试用的 HTTP 服务，提供 `POST /pay`、`POST /payout`、`GET /payout/:referenceNo`、`GET /payouts`、`POST /refund`、`GET /refund/:refundTxnId`、`POST /webhook`。
- 契约测试与 e2e 通过 `SANDBOX_CHANNEL_URL` 指向它。

### 8.3 契约测试套件

新增共享测试：

- `api/test/channel-contract/payment-provider.contract.ts`
- `api/test/channel-contract/payout-provider.contract.ts`

对每个实现跑同一组用例：

**支付**
1. 创建支付返回可用的 `payload` 与 `expiresAt`。
2. 回调验签失败 → 抛异常且不落库。
3. 重复回调（同 `eventId`）→ 幂等。
4. 金额不一致 → 拒绝。
5. 不支持的退款能力 → 明确报错。
6. 异步退款：`refund` 返回 `PROCESSING`，`queryRefund` 最终给出 `SUCCESS` / `FAILED`。

**出款**
1. `referenceId` 相同重复提交 → 渠道侧幂等。
2. `SUCCESS` → 金额核对。
3. `FAILED + definitive=true` → 可重试。
4. `FAILED + definitive=false` → 不可自动重试。
5. `PROCESSING` → `queryPayout` 最终能给出结论。
6. `listPayouts` 分页契约 A：请求 `pageSize=500` 时每页必须给满 500（除非末页）。
7. 分页契约 B：`NaN` / `Infinity` 回落到默认值，不返回空数组。
8. 按 `referenceNo` 查询（`PROCESSING` 单没有 `providerTxnId`）。

---

## 九、超时与可观测性

### 9.1 超时

- 每个 provider 声明 `timeoutMs`（默认 10s；对账查询 30s）。
- 对账翻页预算 = `页数 × 单页超时`，不再固定 30 秒；超过预算抛现有中文错误。
- 可选优化：并发翻页（最多 3 页并发），但必须保持顺序无关的去重。

### 9.2 日志

统一结构化字段：

```ts
logger.warn('渠道调用失败', {
  channel, provider, operation: 'submit' | 'query' | 'refund' | 'list',
  referenceNo, attempt, definitive, elapsedMs,
});
```

⚠️ 日志里**不出现**账号、密钥、完整回调原文。

### 9.3 告警钩子

本阶段不建告警系统，只留一个 `ChannelAlertSink` 接口（默认实现打 `error` 日志）。后续接 Slack / 邮件 / 监控时只换实现。

---

## 十、兼容与迁移

### 10.1 预期迁移（3 个文件，均手写）

1. `6a` 迁移 A：`add_platform_settings`
   - 新建 `platform_settings`（`id` / `key` 唯一 / `value JSONB` / `updatedBy` / `createdAt` / `updatedAt`）。
2. `6a` 迁移 B：`add_preferred_channel_and_file_reconcile_action`
   - `merchant_payout_accounts` 增加 `preferredChannel TEXT NULL`。
   - `payout_operation_action` 增加枚举值 `RECONCILE_TO_PAID_BY_FILE`。
     ⚠️ `ALTER TYPE ... ADD VALUE` 与该文件里的 `ALTER TABLE` 可以共存（PG 12+），
     但**同一文件内不得再使用这个新值**（PG 在同一个事务里看不到新枚举值）。
3. `6c` 迁移：`add_refund_async_fields`
   - `PaymentStatus` 增加 `REFUNDING`（`ALTER TYPE ... ADD VALUE`）；
   - `payments.refundTxnId TEXT NULL`；
   - `payments.refundRequestedAt TIMESTAMP NULL`；
   - `payments.refundFailureReason TEXT NULL`；
   - `payments.refundAttemptCount INTEGER NOT NULL DEFAULT 0`。

⚠️ 三个迁移都用 `npx prisma migrate diff` 核对，再 `npx prisma migrate deploy`；**不要用 `prisma migrate dev`**。
⚠️ 如果 6a / 6b / 6c 分开上线，迁移也按里程碑分开；不要提前上未使用的列。
⚠️ `platform_settings` **不登记**到 `tenant-models.ts`（平台级表，没有 `tenantId`）；e2e 的 `truncateAllTables` 会自动覆盖它。

### 10.2 兼容

- `fake` 渠道保留，历史数据不变；`sandbox` 是新增渠道。
- `PayoutProvider.execute` / `PaymentProvider.refund` 的旧签名删除后，所有测试 mock 必须同步改；这是有意的破坏性变更，避免两套契约并存。
- 存量 `payoutChannel = null` 的单按 §7.1 的默认渠道规则处理。
- 存量 `payments.status = SUCCESS` 的退款请求走新 `REFUNDING` 流程；已 `REFUNDED` 的单不受影响。

---

## 十一、验收标准

1. `PAYMENT_ENABLED_CHANNELS=fake,sandbox`、`PAYOUT_ENABLED_CHANNELS=fake,sandbox` 在非生产可同时启动。
2. 生产环境启用 `fake` / `sandbox` 或 `CHANNEL_MODE=sandbox` → 启动失败；`list()` 不返回 sandbox。
3. 未知/未启用渠道调用返回 409；webhook 未知渠道返回 404。
4. 默认渠道：商家配置优先，平台配置兜底；商家配置的渠道停用时保存报 400、执行落 `FAILED` 并可重试，**不静默回落**。
5. 平台默认渠道可在超管后台 `/settings` 查看与修改；保存后只影响新出款单；DB 里配了未启用渠道时读取 fail-closed。
6. 出款：`PROCESSING` 不再被当成失败；`definitive=true` 的失败可重试，`definitive=false` 不可自动重试。
7. 两家渠道同时注册时，worker 与核实服务都按 `payoutChannel` 取到同一家。
8. 同一时间窗导入两个渠道的 CSV，互不参与对方比对；`supersedePreviousPending` 不跨渠道。
9. CSV 来源的 A 类差异不自动改 `PAID`，落人工项；批量确认支持「勾选当前列表」与「全选筛选结果」（游标分批、每批上限 200、允许部分成功）。
10. 退款：`REFUNDING` 不再被当成 `REFUNDED`；异步退款在 `queryRefund` / 回调确认后才落 `REFUNDED`；明确失败可重试，未知只告警。
11. `sandbox` provider 通过支付/出款契约测试；`fake` 也跑同一套（允许跳过异步用例）。
12. 现有 628 单测 + 646 e2e 全绿；新增契约测试、多渠道路由测试、批量确认测试、平台设置测试全绿。
13. 失败注入：渠道超时、500、重复回调、忽略分页参数、金额不一致、退款处理中、批量确认部分失败、平台默认渠道停用，均能复现预期分支。

---

## 十二、风险与未决

| 风险 | 说明 | 处置 |
|---|---|---|
| 异步契约改动面大 | `submit/query` + `REFUNDING` 会改 worker、退款、核实服务、测试 mock | 拆 6a / 6b / 6c 三个里程碑，6a 先做无状态机变更的适配层 |
| 异步退款状态机复杂 | `REFUNDING` 与订单 `REFUNDED`、抽佣冲回、优惠券回滚都要对齐 | 退款成功才落终态；失败只回退到 `SUCCESS`；未知只告警 |
| 真渠道不是同步返回 | 沙箱只能模拟，不能证明真渠道行为 | 契约测试 + 真实渠道接入时再补一轮 acceptance |
| 多渠道路由遗漏 | worker 与核实服务改一处漏一处 → 重复打款 | 两处共用同一个 `PayoutProviderRegistry`，并加「取到不同渠道」的失败注入测试 |
| 默认渠道配置分散 | 商家在账户表、平台在 `platform_settings`、env 只兜底，排查时容易漏 | `GET /merchant/payout-account` 返回 effectiveChannel + source；平台 `/settings` 显示来源；验收记录写清 |
| 平台默认渠道被改坏 | DB 里可能写入已停用 / devOnly 渠道 | 写入时校验；读取时再校验；不缓存；fail-closed |
| CSV 批量确认误操作 | 一次确认几百条，错一条影响一笔钱 | 每条仍复核来源/类型/状态/归属；游标分批；返回逐条结果；UI 二次确认；留痕记 `RECONCILE_TO_PAID_BY_FILE` |
| 批量确认期间并发处置 | 两个运营同时点「确认全部」 | 条件更新保证每条只成功一次；后到者计入 `failed`；游标前进不重试 |
| 存量 `payoutChannel=null` | 5m 之前的单没有渠道名 | 只在默认渠道下纳入；不猜 |
| 超时预算 | 并发翻页会改变顺序 | 先去重再比对，顺序无关；并发上限 3 |

### 已确认的产品决策

1. `sandbox` **只在开发环境可见**，生产启动失败、下拉不展示。
2. CSV 来源的 A 类人工确认**支持批量**：勾选当前列表 + 全选筛选结果（游标分批），每条仍复核来源/类型/状态/归属。
3. 默认渠道：**商家配置优先，没有则平台配置**（平台在超管后台 `/settings` 配置，落 `platform_settings`）；两者都没有则 fail-closed。
4. 真实渠道退款是**异步**的，退款契约从本阶段开始按 `REFUNDING` 设计。

### 剩余未决

1. `platform_settings` 本阶段只承载「平台默认出款渠道」一个 key；通用设置中心留到后续。
2. CSV 批量确认的「筛选结果」目前等于「该任务下所有 A 类待处置项」；若后续加严重级/状态筛选，扩展 `FILTER` 模式的固定条件即可。
3. 真实渠道接入时，退款回调与支付回调是否共用同一个 webhook 端点；本设计按 `eventType` 分流，预留了共用能力。

---

## 十三、实施期偏离记录（2026-11-03 收尾补记）

设计与最终代码的差异，逐条写明**为什么改**，避免后来者照着旧文字复现错。

1. **出款的假网关叫 `fake-payout`，不是 `fake`**（§4.3 / §十一 第 1、2 条原文写作 `fake`）。
   支付与出款是两个独立实现、两个独立开关（`FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED`），
   合成一个渠道名会让人以为开一个就开了两个。默认值写在
   `api/src/common/channel/channel-config.ts` 的 `DEV_DEFAULT_CHANNELS`：
   `PAYMENT → fake`、`PAYOUT → fake-payout`；devOnly 名单同在 `DEV_ONLY_CHANNELS` 一处。

2. **`fake` 支付渠道也真跑异步退款用例**（§十一 第 11 条原文是「允许跳过异步用例」）。
   假网关实现了 `armRefundScenario`，能演 `processing / reject / unknown`，
   于是契约套件对 `fake` 也传 `supportsAsyncRefund: true` —— 跳过它等于让
   「`asyncRefund = true`」这个能力声明没人验。**唯一**保留的跳过是
   「退款金额与原支付金额不一致 → 拒绝」：渠道层 `refund()` 根本不带原支付金额，
   该单条 `it.skip` 并在代码里写明原因。

3. **`SandboxPayoutProvider` 必须用 `useFactory` 注册**（不在设计里，但踩了就崩）。
   它的构造函数收一个 `number`（单次 HTTP 超时预算，带默认值）。以**类**注册时
   Nest 会反射构造参数，把 `Number` 当成待注入的 provider → 启动直接报
   `Nest can't resolve dependencies of the SandboxPayoutProvider (?)`。
   `payout-providers.module.ts` 里改为 `useFactory: () => new SandboxPayoutProvider()`。

4. **`scanStuck` 是三结论，不是两结论**：`HANDLED` / `INCONCLUSIVE`（下一轮继续问，
   **不写** `stuckLoggedAt`）/ `NOT_POLLED`（渠道不支持按单号查询 → 写告警标记）。
   写成「问不出结论也写 stuckLoggedAt」会让告警只响一次就被当成已处理。

5. **重试预算的适用范围**：`refundAttemptCount < 3` 只约束**发起路径**
   （重复点退款不会无限打渠道），扫描与回调推进不消耗预算。

6. **失败措辞的兜底修正**（阶段 6b 引入 `definitive` 之后暴露）：
   `failedBeforePayout = true` 且 `failureReason` 不在
   `MERCHANT_SAFE_FAILURE_REASONS` 白名单时，**不再回落白名单第一条**
   「收款账号信息异常…」，改为中性兜底
   `出款未成功，本次未打款，请联系平台处理`。
   原因：`definitive: true` 的渠道拒付（重试预算用完后）也会落进这一桶，
   原文是渠道措辞；回落「收款账号信息异常」是**说错原因**，商家会去改收款账户、
   改完再申请还是同样的错。

7. **假出款网关的剧本接口语义变了**（e2e 与手工验收都要注意）：
   `POST /api/v1/pay/fake-payout/fail-next` 的 `times` = **渠道明确拒付**
   （`definitive: true`，可安全重试）；**结果未知**用 `unknownTimes`
   （`definitive: false`，一次就落 `FAILED`、绝不自动重试）。
   对应 e2e：`payout-execution` 的 X7 改为断言 `failedBeforePayout = true`，
   并新增 X7b 覆盖「结果未知不重试」。
