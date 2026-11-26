# 阶段 5f 实施计划：支付可靠性（修丢钱洞 + 兜底扫描）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉「webhook 入队失败被静默吞掉 → 用户付了钱订单永不流转」的丢钱洞，并给「投递可能丢」的两条路径加平台自己的兜底扫描。

**Architecture:** ① `enqueueWebhookEvent` 的失败改为**抛出去**（503 → 渠道重投 → `insertEvent` 的「`processedAt` 为 null → 允许重试」分支生效）；② 事件表加 `kind` 列（由端点写入，不可被渠道伪造；**不加 `tenantId`**，保持 R14「租户从业务单反查」）；③ 新建 `compensation` 队列与扫描器，做两件事：未处理完的 webhook 事件重新入队、已过支付期限仍待支付的订单补释放。

**Tech Stack:** NestJS 11 + Prisma 6 + BullMQ 6.4.1 + Jest 30（api）。

**依据设计文档**：`docs/superpowers/specs/2026-10-27-plan-05f-payment-reliability-design.md`（`c042bc1`）

---

## §0.5 勘误表

| # | Task | 现象 | 处置 |
|---|------|------|------|
| — | — | （实施开始时为空） | — |

---

## §0.1 全局约定

- 仓库根：`/Users/tom/orca/workspaces/电商项目/电商项目`；分支 `gzt/电商项目`（**不要新建分支**）
- **docs 与业务代码分开提交**；提交信息一律中文（`feat(api):` / `fix(api):` / `test(api):` / `docs:`）
- **金额一律整数分**；费率用基点（万分之）
- **「外科手术式改动」**：只碰必须碰的地方，不顺手清理邻近代码、不重构没坏的东西
- **注释解释「为什么」**，且必须**准确** —— 写之前核实事实
- **中文**：注释与 commit message 一律简体中文；英文只保留标识符与框架名

### 验证命令

| 目的 | 命令 |
|------|------|
| api 单元测试 | `cd api && npx jest --passWithNoTests` |
| api e2e（单个文件） | `cd api && npm run test:e2e -- <文件名>` |
| api 类型检查 | `cd api && npx tsc --noEmit` |
| api lint | `cd api && npx eslint src/ test/` |

⚠️ **e2e 需要 `api/.env` 的 `DATABASE_URL_TEST`**，且会 **truncate 测试库**。

### 本阶段的两条纪律（务必遵守）

1. ⚠️ **不要动 `order.service.ts` 的超时释放投递** —— 5d 给它加的「投递失败 catch 住不抛」是**对的**
   （订单已建成、用户可正常支付，报失败会诱发重复下单）。本阶段只反转 `enqueueWebhookEvent`。
2. ⚠️ **在 `api/` 下新增顶层目录会改变 TypeScript 的公共根目录** → 产物变成 `dist/src/main.js`
   → **容器起不来**。本阶段**不新增顶层目录**（新增的文件都在 `api/src/modules/payment/` 下）✅

---

## Task 1: 修丢钱洞 —— webhook 入队失败要报失败

**Files:**
- Modify: `api/src/modules/payment/payment.service.ts`

---

### Step 1: 写失败的测试

⚠️ **先读 `api/test/payment.e2e-spec.ts` 里现有的 webhook 用例**（`postFakeWebhook` 的签名、
`webhookQueue` 的用法），照抄它的写法。

在 `api/test/payment.e2e-spec.ts` 加一条用例：

```ts
  it('⚠️ 入队失败时 webhook 接口要报失败（5xx），让渠道重投', async () => {
    // ⚠️ **让队列投递失败**：把队列的 add 打掉，让它抛。
    //    队列的 mock 怎么做，看这个文件里 `webhookQueue` 的既有用法。
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '入队失败的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
      2,
    );

    // ⚠️ **让入队失败**：把队列的 add 打成抛错
    const addSpy = jest
      .spyOn(webhookQueue, 'add')
      .mockRejectedValue(new Error('队列挂了'));

    const response = await postFakeWebhook({
      eventId: `evt-${unique()}`,
      providerTxnId: payment.paymentId,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    });

    // ⚠️ **必须是 5xx**：返回 200 的话渠道认为收到了、不会再重投，
    //    而事件行已经在库里（processedAt=null）却没人处理 → **这笔支付永远丢了**
    expect(response.status).toBeGreaterThanOrEqual(500);

    addSpy.mockRestore();

    // ⚠️ **事件行已经落了**（验签之后才插的）→ 渠道重投时
    //    `insertEvent` 见 processedAt=null → 返回 true → 允许重新处理
    const events = await prisma.paymentWebhookEvent.findMany({
      where: { eventId: expect.any(String) } as never,
    });
    expect(events.length).toBeGreaterThan(0);
  });
```

⚠️ **实施时按这个文件里的真实夹具调整**：
- `postFakeWebhook` 返回什么（`Response` 还是别的）
- `webhookQueue` 是不是 `jest.spyOn` 的对象（这个文件里已经有 `getQueueToken(PAYMENT_WEBHOOK_QUEUE)` 的用法）
- **Jest 里怎么 mock 一个被 Nest 注入的队列**（可能要 spy 在 `QueueService` 上而不是 `Queue` 上）

### Step 2: 跑测试，确认失败

Run: `cd api && npm run test:e2e -- payment`
Expected: **FAIL** —— 现在返回的是 200（5d 的「投递失败不抛」）。

### Step 3: 改 `enqueueWebhookEvent`

Modify `api/src/modules/payment/payment.service.ts`。

把 `enqueueWebhookEvent` 里 5d 加的那段 try/catch 去掉（**改成直接 await，让异常抛出去**），
并把那段**不准确**的注释替换成：

```ts
  /**
   * 投递 webhook 事件到队列。
   *
   * ⚠️ **任务里的 `tenantId` 必须来自订单反查**（见 `checkWebhookEvent`），
   * 绝不能取自客户端提交的内容——否则「重建上下文」本身就成了越权通道。
   *
   * ⚠️ **`kind` 必须一路带进队列**：消费端（`applyEvent`）要靠它决定
   * 反查哪张业务单（订单 / 账单）。少了它，订阅回调会被**无条件**当成订单回调
   * 去反查订单——查不到就静默丢掉，那笔续费的钱就没了。
   *
   * ⚠️ **入队失败必须抛出去**（阶段 5f 修的丢钱洞）：
   * 此刻只落了**事件行**（`insertEvent` 已在验签之后插好），`Payment` 单与
   * 订单流转**都还没发生**。若把失败吞掉、返回 200，渠道会认为收到了、
   * **不再重投** → 事件行的 `processedAt` 永远是 null → 没人处理 →
   * **用户付了钱，订单永不流转**。
   * 抛出去 → 渠道收到 5xx → **重投**同一个 eventId →
   * `insertEvent` 见 `processedAt` 为 null → 返回 true（允许重试）→ 重新入队 → 处理。
   *
   * ⚠️ **与「订单超时释放」的投递语义不同**：那边的失败是**不抛**
   * （订单已建成、用户可正常支付，报失败会诱发重复下单）。
   */
```

### Step 4: 跑测试，确认通过

Run: `cd api && npm run test:e2e -- payment`
Expected: **PASS**。

### Step 5: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/modules/payment/payment.service.ts api/test/payment.e2e-spec.ts
git commit -m "fix(api): webhook 入队失败要报失败，别让渠道以为收到了"
```

---

## Task 2: 事件表加 `kind` 列

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/<时间戳>_add_webhook_event_kind/migration.sql`
- Modify: `api/src/modules/payment/payment.service.ts`（`insertEvent` 收 `kind`）
- Modify: `api/src/modules/payment/webhook.controller.ts`（传 `kind`）

---

### Step 1: 改 schema

`api/prisma/schema.prisma` 的 `PaymentWebhookEvent` 模型里加：

```prisma
  /**
   * 这笔是订单支付还是订阅支付（阶段 5f 加）。
   *
   * ⚠️ **由 webhook 端点写入**（端点自己知道是哪个端点），不是渠道适配器猜的、
   *    也不是从请求体里取的 → **不可被渠道伪造**。
   *
   * ⚠️ **为什么需要它**：补偿扫描要重新入队未处理完的事件，
   *    而消费端靠 `kind` 决定反查订单还是反查账单。事件行原来没有这一列，
   *    补偿扫描就分不清该反查哪张表。
   *
   * ⚠️ **不加 `tenantId`** —— 阶段 3 的 R14：租户从业务单反查，不采信事件里的租户。
   */
  kind        PaymentKind @default(ORDER)
```

⚠️ `PaymentKind` 枚举已存在（`schema.prisma:872`）✅

### Step 2: 手写迁移

⚠️ **本仓库的迁移一律手写 SQL**（`prisma migrate diff` 的输出会把部分唯一索引当成漂移）。
目录名 `YYYYMMDDHHMMSS_add_webhook_event_kind`，SQL：

```sql
-- 事件表加 `kind` 列（阶段 5f）。
--
-- ⚠️ **为什么加它**：补偿扫描要重新入队「上次没处理完」的 webhook 事件，
-- 而消费端靠 `kind` 决定反查订单还是反查账单。事件行原来没有这一列，
-- 补偿扫描就分不清该反查哪张业务单。
--
-- ⚠️ **由 webhook 端点写入**（端点自己知道是哪个端点），不是渠道适配器猜的 →
--    **不可被渠道伪造**。
--
-- ⚠️ **不加 `tenantId`** —— 阶段 3 的 R14：租户从业务单反查，不采信事件里的租户。
--
-- ⚠️ **默认值 `ORDER`**：历史行一律按订单处理。补偿扫描遇到「按订单找不到」
--    的历史订阅事件会判成「找不到业务单」→ 不重投（保守，不会误处理）。

-- AlterTable
ALTER TABLE "payment_webhook_events" ADD COLUMN IF NOT EXISTS "kind" "PaymentKind" NOT NULL DEFAULT 'ORDER';
```

⚠️ **先看 `api/prisma/migrations/` 里现有的一个迁移**（比如 `20261028093508_add_commission_entries`），
**照它的实际风格写**（列的类型、大小写、`IF NOT EXISTS` 的用法）。上面是意图，实际以仓库为准。

### Step 3: 应用迁移

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx prisma migrate deploy   # ⚠️ 本仓库 `prisma migrate dev` 不可用（历史迁移校验和不一致）
npx prisma generate
npx tsc --noEmit
```

⚠️ **`prisma migrate dev` 在本仓库不可用**（它提示要重置 public schema，而项目明令禁用
`migrate reset`）。做法照阶段 5c/5e 的先例：`prisma migrate diff` 生成 SQL → 手工裁剪 →
`psql` 应用 → `prisma migrate resolve --applied` 登记。

### Step 4: `insertEvent` 收 `kind`

Modify `api/src/modules/payment/payment.service.ts`：

```ts
  async insertEvent(
    event: NormalizedWebhookEvent,
    kind: PaymentKind = PaymentKind.ORDER,
  ): Promise<boolean> {
```

在 `create` 的 `data` 里加 `kind,`。

⚠️ `PaymentKind` 要从 `@prisma/client` import（该文件已经 import 了别的东西，一并加上）。

### Step 5: 端点传 `kind`

Modify `api/src/modules/payment/webhook.controller.ts`：

```ts
    const inserted = await this.paymentService.insertEvent(event, kind);
```

⚠️ `kind` 是 `handleWebhook` 的参数 ✅ 已经在手边。

### Step 6: 类型检查 + 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
cd ..
git add api/prisma/schema.prisma api/prisma/migrations/ \
        api/src/modules/payment/payment.service.ts api/src/modules/payment/webhook.controller.ts
git commit -m "feat(api): 事件表加 kind 列，补偿扫描才知道反查哪张业务单"
```

---

## Task 3: 兜底扫描 —— 未处理完的事件 + 丢失的超时释放

**Files:**
- Create: `api/src/modules/payment/compensation.service.ts`
- Create: `api/src/modules/payment/compensation.worker.ts`
- Modify: `api/src/common/queue/queue.constants.ts`
- Modify: `api/src/modules/payment/payment.module.ts`（注册 provider 与 worker）

---

### Step 1: 加队列常量

`api/src/common/queue/queue.constants.ts`：

```ts
/** 支付补偿扫描队列（未处理完的 webhook 事件 + 丢失的超时释放） */
export const COMPENSATION_QUEUE = 'compensation';
```

### Step 2: 写补偿 service

Create `api/src/modules/payment/compensation.service.ts`。骨架：

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OrderStatus, PaymentKind, Prisma } from '@prisma/client';

import { COMPENSATION_QUEUE } from '../../common/queue/queue.constants';
import { platformScope, tenantContext } from '../../common/tenant/tenant-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { OrderTimeoutService } from '../order/order-timeout.service';
import { QueueService } from '../queue/queue.service';
import { PaymentService } from './payment.service';
import { NormalizedWebhookEvent } from './payment-provider.interface';

/** 补偿扫描的周期（毫秒）。默认 10 分钟 */
const COMPENSATION_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 事件「够老」的门槛（毫秒）。默认 5 分钟。
 *
 * ⚠️ **不能是 0**：刚落库的事件可能正在被消费端处理。
 */
const EVENT_STALE_MS = 5 * 60 * 1000;

/** 单轮最多处理多少条 —— 防一次扫太多把队列打爆 */
const MAX_PER_ROUND = 100;

/** 补偿 job 的 jobId 后缀 */
const COMPENSATION_JOB_SUFFIX = '-comp';
```

⚠️ **两个方法**：

**`retryUnprocessedEvents()`** —— 未处理完的 webhook 事件重新入队：

```ts
  /**
   * 把「上次没处理完」的 webhook 事件重新入队。
   *
   * ⚠️ **为什么需要它**：`insertEvent` 的「`processedAt` 为 null → 允许重试」
   *   分支只在**渠道重投**时才有意义（Task 1 保证渠道会重投）。
   *   但渠道的重投有次数与时间窗 —— 超出就不重投了。
   *   平台自己扫一遍才是最后的兜底。
   *
   * ⚠️ **每条独立 try/catch**：一条失败不能带倒整轮扫描。
   */
```

流程（在**平台作用域**下）：
1. 扫 `payment_webhook_events`：`where: { processedAt: null, createdAt: { lt: staleBefore } }`，`take: MAX_PER_ROUND`
2. 对每条：
   - 从 `row.payload` 取 `referenceNo` / `amount` / `success` / `channel` → 构造 `NormalizedWebhookEvent`
     （`provider` = `row.provider`，`eventId` = `row.eventId`，`providerTxnId` = `row.providerTxnId`）
   - `paymentService.checkWebhookEvent(event, row.kind)` → `accepted` 且 `tenantId` → 重投
   - 重投：`paymentService.enqueueWebhookEvent(event, tenantId, row.kind)`
     ⚠️ **jobId 要带区分标记**（BullMQ 里 failed job 的 hash 还在 → 用同一个 jobId
     重新入队会被**静默忽略**）
   - 不 accepted → 计数

**`releaseStuckOrders()`** —— 超时释放任务丢失的兜底：

```ts
  /**
   * 补释放「已过支付期限但订单还卡在待支付」的订单。
   *
   * ⚠️ **为什么需要它**：超时释放是靠**队列里的 delayed job** 做的
   *   （下单后投一个 15 分钟后的任务）。投递失败时没人知道 →
   *   订单永远卡在待支付、库存永久卡在预占。
   *
   * ⚠️ **与队列里的 job 重复执行**：幂等靠
   *   `releaseExpiredOrderInTx` 里 `transitionInTx(PENDING_PAYMENT → CLOSED)`
   *   的条件更新 —— 两边只有一个赢。
   */
```

流程（在**平台作用域**下）：
1. 扫 `order`：`where: { status: PENDING_PAYMENT, payExpiresAt: { lt: now } }`，`take: MAX_PER_ROUND`
2. 对每条：`runForTenant(order.tenantId, () => orderTimeout.releaseExpiredOrder(order.id))` → 计数

⚠️ **⚠️ 关键：`runForTenant` 必须在 `tenantContext.run(platformScope(), ...)` 里面** ——
平台的扫描是跨租户的，写操作要逐条切回租户作用域（与 `renewal.worker.ts` 同款）。

⚠️ **`releaseExpiredOrder` 需要租户上下文** —— `order-timeout.service.ts` 查的是租户作用域的
`Order` → 没有上下文会抛 `TenantScopeError`。

**`onModuleInit`** —— 注册周期任务（与 `renewal.service.ts:53` 同款）：

```ts
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      COMPENSATION_QUEUE,
      'compensate',
      {},
      COMPENSATION_INTERVAL_MS,
      'payment-compensation',
    );
  }
```

⚠️ **固定 `jobSchedulerId`**（`payment-compensation`）—— BullMQ 按它去重，
重复注册是覆盖不是叠加，否则每次重启都多一个任务。

### Step 3: 写 worker

Create `api/src/modules/payment/compensation.worker.ts` —— 照 `api/src/modules/payment/renewal.worker.ts`：

```ts
@Processor(COMPENSATION_QUEUE)
@Injectable()
export class CompensationWorker extends WorkerHost {
  constructor(private readonly compensation: CompensationService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'compensate') {
      return;
    }
    await tenantContext.run(platformScope(), async () => {
      await this.compensation.retryUnprocessedEvents();
      await this.compensation.releaseStuckOrders();
    });
  }
}
```

### Step 4: 注册

Modify `api/src/modules/payment/payment.module.ts`：
- providers 加 `CompensationService`
- providers 加 `CompensationWorker`（与 `RenewalWorker` / `WebhookWorker` 同款）

⚠️ **先看 `payment.module.ts` 里 `WebhookWorker` 是怎么注册的**（BullMQ 的 worker 要用
`BullModule.registerQueue` 的队列名）—— `COMPENSATION_QUEUE` 要在
`api/src/modules/queue/queue.module.ts` 的 `registerQueue` 里加上，否则 worker 拿不到队列。

⚠️ `queue.module.ts` 的 `BullModule.registerQueue({name: ...})` 要加 `COMPENSATION_QUEUE` ✅

### Step 5: 类型检查 + 跑现有 e2e

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx tsc --noEmit
npm run test:e2e -- payment
```

⚠️ **新增的周期任务会在 e2e 里真的注册** → e2e 的 `beforeAll` 会起 BullMQ 连接。
若 e2e 因为新队列而失败，看日志里的具体原因。

### Step 6: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/src/common/queue/queue.constants.ts api/src/modules/queue/queue.module.ts \
        api/src/modules/payment/compensation.service.ts api/src/modules/payment/compensation.worker.ts \
        api/src/modules/payment/payment.module.ts
git commit -m "feat(api): 支付补偿扫描——补未处理完的 webhook 事件与丢失的超时释放"
```

---

## Task 4: e2e 覆盖 M1–M8

**Files:**
- Modify: `api/test/payment.e2e-spec.ts`

---

### Step 1: 写用例

⚠️ **先读 `api/test/payment.e2e-spec.ts` 的既有夹具**（`createMerchant` / `publishSku` /
`stockIn` / `registerCustomer` / `createAddress` / `placeAndPay` / `postFakeWebhook` /
`readOrder` / `waitFor`）—— 全部照抄，别自造。

要覆盖的护栏（设计文档 §6.1）：

| # | 护栏 | 用例形状 |
|---|------|---------|
| M1 | webhook 入队失败 → 接口 5xx | Task 1 已写 ✅（本 Task 复核） |
| M2 | 渠道重投同一 eventId → 事件被重新处理 | 投递 → 让入队失败（断言 5xx）→ 恢复队列 → **用同一个 eventId 再投一次** → 断言订单转 PAID |
| M3 | 补偿扫描 A：未处理完的事件被重新处理 | 造一条 `processedAt = null` 的事件行（**直接用 prisma 造**）→ 调 `compensation.retryUnprocessedEvents()` → 断言订单转 PAID |
| M4 | 补偿扫描 A：金额不符的事件**不**被重投 | 造一条 `processedAt = null` 且金额与订单不符的事件 → 跑扫描 → 断言订单**没**转 PAID |
| M5 | 补偿扫描 B：已过支付期限仍待支付的订单被释放 | 造一个 `PENDING_PAYMENT` 且 `payExpiresAt` 已过期的订单 → 跑扫描 → 断言订单转 CLOSED、库存回补 |
| M6 | 补偿扫描 B：还在支付期限内的订单**不**被释放 | 造一个 `payExpiresAt` 在未来的订单 → 跑扫描 → 断言订单**仍**是 PENDING_PAYMENT |
| M7 | 补偿 job 能重复入队 | 连续跑两轮扫描 → 断言订单**只**流转一次（消费端幂等） |
| M8 | 事件的 `kind` 由端点写入 | 投递一个**订阅**回调 → 断言事件行的 `kind = SUBSCRIPTION` |

⚠️ **M3–M7 造数据的方式**：
- 「未处理完的事件」：直接用 prisma 造 `payment_webhook_events` 行（`processedAt` 留 null）
- 「已过支付期限的订单」：用 `seedOrder` 那样直接 `prisma.order.create`（`status: PENDING_PAYMENT`、
  `payExpiresAt` 给过去/未来的时刻）
- ⚠️ **订单需要真实的 SKU/库存**才能验「库存回补」—— 若夹具不好搭，M5 的断言可以只验
  **订单转 CLOSED**（不验库存），并在报告里说明

⚠️ **调扫描服务**：`moduleRef.get(CompensationService)` → `await compensation.retryUnprocessedEvents()`
⚠️ 扫描服务内部自己会 `tenantContext.run(platformScope(), ...)` → **测试里直接调它就行**，
不要在外面再套一层上下文。

### Step 2: 跑测试

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npm run test:e2e -- payment
```

Expected: **PASS**（用例数按实际写出来的算）。

### Step 3: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add api/test/payment.e2e-spec.ts
git commit -m "test(api): 支付补偿扫描与 webhook 重投链路的 e2e"
```

---

## Task 5: 失败注入复验 + 验收记录

**Files:**
- Modify: `docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md`（新建）

---

### Step 1: 逐条单独跑失败注入

⚠️ **每条单独跑，不叠加**（阶段 5c 的教训：「注入 A + 注入 B 叠加 → 挂 N 条」不能用来证明 A）。

| # | 注入 | 预期挂掉 |
|---|------|---------|
| F1 | `enqueueWebhookEvent` 改成 catch 住不抛 | M1、M2 |
| F2 | 补偿扫描 A 去掉 `checkWebhookEvent` 的金额核对 | M4 |
| F3 | 补偿扫描 B 去掉 `payExpiresAt` 条件 | M6 |
| F4 | 补偿 job 的 jobId 去掉区分标记 | M7 |
| F5 | `insertEvent` 的「`processedAt` 为 null → 允许重试」改成一律跳过 | M2、M3 |

⚠️ **注入用的文件必须已提交** —— 否则 `git checkout --` 会把自己的改动一起抹掉。
注入完逐条核实文件已恢复（`git status` 干净）。

### Step 2: 全量验证

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目/api"
npx jest --passWithNoTests && npx tsc --noEmit && npm run test:e2e
```

### Step 3: 写验收记录

Create `docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md`，照
`docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md` 的结构：
自动化测试数字对账 / 容器化验证 / 浏览器手测 / 机制级验证（护栏逐条 + 失败注入逐条单独跑）/
发现并修复的缺陷 / 已知遗留项。

⚠️ **验收记录里不要写没做过的手测结果** —— 本阶段只有一条浏览器手测
（停 Redis → webhook 5xx → 恢复 → 重投 → 订单转 PAID），做完就写实测值，没做就写「待执行」。

### Step 4: 提交

```bash
cd "/Users/tom/orca/workspaces/电商项目/电商项目"
git add docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md
git commit -m "docs: 阶段 5f 验收记录"
```

---

## §1 验收清单

### 护栏对照

| # | 护栏 | 覆盖它的测试 |
|---|------|------------|
| M1 | webhook 入队失败 → 5xx | Task 1 |
| M2 | 渠道重投 → 事件被重新处理 | Task 4 |
| M3 | 补偿扫描 A 重投未处理完的事件 | Task 4 |
| M4 | 补偿扫描 A 不重投金额不符的事件 | Task 4 |
| M5 | 补偿扫描 B 补释放已过期的订单 | Task 4 |
| M6 | 补偿扫描 B 不动还在期限内的订单 | Task 4 |
| M7 | 补偿 job 可重复入队、只生效一次 | Task 4 |
| M8 | 事件的 `kind` 由端点写入 | Task 4 |
| M9 | 正常路径不受影响 | 既有 e2e ✅ |

### 浏览器手测（1 条）

1. 停掉 Redis → 投递一个 webhook → 观察到接口返回 **5xx**（不是 200）→ 恢复 Redis → 重投 → 订单转 PAID

### 收尾

1. 验收记录单独提交
2. 推分支（走 `tools/push-via-api.mjs`，**不用 `git push`**）
3. 开 PR → squash 合并 → 用 API 删远端分支
4. 更新记忆
