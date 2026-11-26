# 阶段 5f 设计：支付可靠性（修丢钱洞 + 兜底扫描）

> 阶段 5e（抽佣流水明细 + M11 收尾）已完成并合并（PR #13）。
> 本阶段修一个**会丢钱**的回归，并给两条「投递可能丢」的路径加上兜底扫描。

**日期**：2026-10-28
**依据**：`docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md` §六、
`docs/superpowers/specs/2026-10-27-plan-05d-theme-and-error-handling-design.md`（D9 与 L1/L12）

---

## 一、目标与范围

### 1.1 目标

1. **用户付了钱，订单一定要流转** —— 修掉 5d 引入的「webhook 入队失败被静默吞掉」的洞。
2. **投递可能丢的路径都要有兜底** —— 渠道不重投时，靠平台自己的扫描把漏掉的补上。

### 1.2 范围

| 编号 | 子项 | 涉及 |
|------|------|------|
| 5f-0 | **修丢钱洞**：webhook 入队失败要报失败（5xx → 渠道重投） | `api/` |
| 5f-1 | 事件表加 `kind` 列 | `api/` |
| 5f-2 | **兜底扫描 A**：未处理完的 webhook 事件 → 重新入队 | `api/` |
| 5f-3 | **兜底扫描 B**：超时释放任务丢失 → 补释放 | `api/` |
| 5f-4 | 计数日志与验收 | 全栈 |

### 1.3 明确不做

| 不做 | 原因 |
|------|------|
| **告警系统** | 项目里只有 `Logger`，没有告警基建。计数走 `error`/`warn` 日志 |
| **BullMQ failed 队列的通用捞取机制** | 范围会扩到队列框架层。5f-2/5f-3 各自解决自己那条路径 |
| **webhook 事件的「自动重放」**（重放历史事件给商家/用户看） | 与「保证处理不丢」是两件事 |
| **结算单 / 抽佣出款** | 5e 的 L18/L19，属另一个阶段 |
| **多副本分布式刷新锁** | 5c 的 L5，扩副本前再做 |
| 改 `insertEvent` 的幂等闸、事件表加 `tenantId` | 「租户从业务单反查」是阶段 3 的 R14 不变量，事件表**刻意**不带 tenantId |

---

## 二、事实基础

### 2.1 入站 webhook 的完整链路

`api/src/modules/payment/webhook.controller.ts:112-165`：

```
1. 验签（失败 → 401，一个字都不写进库）
2. checkWebhookEvent：金额核对 + 从业务单反查租户
3. insertEvent：落事件行（processedAt = null）
4. enqueueWebhookEvent：投到 payment-webhook 队列
5. 返回 { received: true, processed: true }
```

第 4 步的消费者（`api/src/modules/payment/webhook.worker.ts:70-100`）：
`runForTenant(tenantId, () => applyEvent(event, tenantId, kind))` —— 支付单转 SUCCESS、
订单转 PAID、记 DEDUCT 流水。

### 2.2 事件表的幂等闸与「允许重试」的设计

`api/src/modules/payment/payment.service.ts:620-666`，`insertEvent` 的注释白纸黑字写着：

> 「事件行是唯一的幂等闸：首次到达时插进去，业务处理完再打上 `processedAt`。
> 如果处理中途失败（死锁、瞬时故障、进程崩溃），事件行已经在库里而 `processedAt`
> 仍是 null——这时渠道重投同一个 eventId，若一律跳过，**这笔支付就永远丢了**
> （**没人会去扫这张表找未处理的事件**）。
> 所以：`processedAt` 为 null = 上次没处理完 → **允许重新处理**。」

⚠️ **「允许重新处理」这条分支只有在「渠道会重投」时才有机会走到**。
它是**唯一**的救回机制 —— 注释自己说了「没人会去扫这张表」。

### 2.3 5d 的 D9 切断了这条链（回归）

5d 的决策 D9：「**webhook 投递失败不报失败** —— 支付已入库，报失败会诱导用户重复支付」。

⚠️ **这两条理由都不成立**：

- 「支付已入库」不成立 —— 此刻（第 4 步）只落了**事件行**，`Payment` 单与订单流转
  **都还没发生**（它们在消费者里才做）。
- 「诱导用户重复支付」不成立 —— 返回 5xx 是给**渠道**看的，用户不参与这个请求。

⚠️ **5d 之前**（无超时包装）：入队时 Redis 挂 → Promise 永不 settle → **请求挂死**
→ 渠道超时 → **渠道重投** → 事件被重新入队 → 处理 ✅（体验差，数据不丢）
⚠️ **5d 之后**（3 秒超时 + catch 住不抛）：**返回 200** → 渠道不重投 → 事件行永远
`processedAt = null` → **订单永不流转**（用户付了钱，订单还是待支付，库存永久卡在预占）❌

**5d 把「体验差但数据不丢」换成了「体验好但数据丢」。**

⚠️ **`order.service.ts` 那条路径不受影响**：它走 `queue.addDelayed`（直接调 `QueueService`），
**不走 `enqueueWebhookEvent`** → 5d 给它加的「投递失败 catch 住不抛」**仍然正确**
（订单已建成、用户可正常支付，报失败会诱发重复下单）。

### 2.4 BullMQ 的 jobId 会挡住重新入队

`enqueueWebhookEvent` 的 jobId 是 `webhook-${provider}-${eventId}`。
BullMQ 里 **failed job 的 hash 仍然保留**（默认不 `removeOnFail`）→ 用**同一个 jobId**
重新入队会被**静默忽略**（`addJob` 的 Lua 脚本按 jobId 查存在性）。

⚠️ 所以**补偿用的 jobId 必须与原 jobId 区分**，否则补偿扫描做了等于没做。

### 2.5 仓库里现成的周期扫描机制

| 队列 | 扫描什么 | 注册在哪 |
|------|----------|----------|
| `auth` | 宽限记录的密文清理 | `token-grace.service.ts:44`（`onModuleInit`） |
| `billing` | 续费扫描（生成账单 + 自动扣款） | `renewal.service.ts:53`（`onModuleInit`） |

两者的共同形态（`renewal.worker.ts` 是最干净的样板）：

- 消费者在**平台作用域**下跑（扫描要跨租户）
- 写操作由 service 内部用 `runForTenant` 切回租户作用域
- 消费端**必须幂等**（BullMQ 是 at-least-once）
- 用 `addRepeating` + **固定 `jobSchedulerId`**（按它去重，重复注册是覆盖不是叠加）

### 2.6 超时释放的现状

- 队列任务 `timeout-${orderId}`，延迟 `PAYMENT_TIMEOUT_MS`（15 分钟），在**下单后**投递
- 消费者 `order-timeout.worker.ts` → `order-timeout.service.ts` 的 `releaseExpiredOrder(orderId)`
- `releaseExpiredOrderInTx` 的判定：`order.payExpiresAt > now` → 跳过（还没到期限）；
  否则 `transitionInTx(PENDING_PAYMENT → CLOSED)` + 释放预占
- ⚠️ **投递可能丢**：5d 给它加的「投递失败 catch 住不抛」→ 失败时**没人知道** →
  订单永远卡在待支付、库存永久卡在预占

---

## 三、关键决策

| 编号 | 决策 | 理由 |
|------|------|------|
| D1 | **`enqueueWebhookEvent` 的失败要抛出去**（反转 5d 的 D9） | 入站 webhook 的入队失败必须让渠道重投 —— `insertEvent` 的「`processedAt` 为 null → 允许重试」分支**只在这个前提下**才有意义（§2.2）。5d 的两条理由都不成立（§2.3） |
| D2 | **只改 `enqueueWebhookEvent`，不动 `order.service.ts` 那条** | 后者的语义不同：订单已建成，报失败会诱发重复下单。5d 那条决策对它是**对的** |
| D3 | **事件表加 `kind` 列，不加 `tenantId`** | 补偿扫描要知道反查哪张业务单（订单 vs 账单）。`kind` 由 **webhook 端点**写入（端点自己知道是哪个端点）→ **不可被渠道伪造**。⚠️ **不加 `tenantId`** —— 阶段 3 的 R14 明确「租户从业务单反查，不采信事件里的 tenantId」，加一列会动摇那条不变量 |
| D4 | 补偿扫描**重新反查**租户（`checkWebhookEvent`）而不是从事件行读 | 保持 R14；顺带**重做金额核对** → 金额不符的事件不该被重投 ✅ |
| D5 | 补偿 job 的 jobId **带一个区分标记**（`-comp`） | BullMQ 里 failed job 的 hash 还在 → 用原 jobId 重新入队会被**静默忽略**（§2.4） |
| D6 | 兜底扫描**新建一个队列**（`compensation`）而不是复用 `billing` | 职责单一。`RenewalWorker.process` 是按 `job.name` 分派的，塞进 `billing` 会让「续费扫描」和「支付补偿」混在一个消费者里 |
| D7 | 扫描 B **复用** `order-timeout.service` 的 `releaseExpiredOrder` | 不重写释放逻辑 —— 队列任务与扫描器做的是同一件事，幂等靠 `transitionInTx` 的条件更新（一个赢） |
| D8 | 补偿扫描的**判定窗口**（事件 N 分钟、订单已过支付期限）由常量定义，不做成配置 | 简单优先。窗口调优是以后的事 |

---

## 四、设计

### 4.1 5f-0：修丢钱洞

`api/src/modules/payment/payment.service.ts` 的 `enqueueWebhookEvent`：
**去掉 try/catch**（或 catch 后原样 rethrow）→ `ServiceUnavailableException`
（`queue.service.ts` 的 `withQueueTimeout` 抛的）传到控制器 → 全局过滤器 → **503**。

**重投链路**（渠道重投同一个 eventId）：

```
insertEvent → 撞唯一索引 → 查 existing.processedAt
  → null（上次没处理完）→ 返回 true → 控制器继续 → enqueueWebhookEvent → 入队 → 消费 → 处理 ✅
```

⚠️ **消费者幂等**靠 jobId（`webhook-${provider}-${eventId}`，同一个 jobId 不会重复处理）
与 `applyEvent` 里状态流转的条件更新（护栏 10）✅

⚠️ **同时改掉 5d 那段不准确的注释**（D9 的理由），写清楚：
「此刻只落了**事件行**，`Payment` 单与订单流转都还没发生；返回 5xx 是给**渠道**看的，
让渠道重投 —— 这是 `insertEvent` 里『`processedAt` 为 null → 允许重试』分支唯一的前提。」

### 4.2 5f-1：事件表加 `kind` 列

```prisma
model PaymentWebhookEvent {
  id            String    @id @default(uuid())
  provider      String
  eventId       String
  providerTxnId String?
  payload       Json
  processedAt   DateTime?
  createdAt     DateTime  @default(now())

  // ⚠️ **这笔是订单支付还是订阅支付**（阶段 5f 加）。
  //
  // ⚠️ **由 webhook 端点写入**（端点自己知道是哪个端点），不是渠道适配器猜的、
  //    也不是从请求体里取的 → 不可被渠道伪造。
  //
  // ⚠️ **为什么需要它**：补偿扫描要重新入队未处理完的事件，
  //    而消费端靠 `kind` 决定反查订单还是反查账单。事件行原来没有这一列，
  //    补偿扫描就分不清该反查哪张表。
  //
  // ⚠️ **不加 `tenantId`** —— 阶段 3 的 R14：租户从业务单反查，不采信事件里的租户。
  kind        PaymentKind @default(ORDER)
  ...
}
```

⚠️ **已有行怎么办**：`@default(ORDER)` → 历史行按 `ORDER` 处理。⚠️ 但历史里**订阅**的事件
会被误判成订单 → 补偿扫描时 `checkWebhookEvent(event, ORDER)` 找不到订单 → `accepted: false`
→ **不重投**（保守，不会误处理）✅ 代价：那批订阅事件补不回来（它们在 5f 之前就已经
「卡住」了，且 `processedAt` 为 null 的极少 —— 只有投递失败的那批）。

**写入点**：`insertEvent` 多收一个 `kind` 参数 → 由 `webhook.controller.ts` 传入
（它本来就知道 `kind` —— 端点分订阅/订单两条）✅

### 4.3 5f-2：兜底扫描 A —— 未处理完的 webhook 事件

**新增** `api/src/modules/payment/compensation.service.ts`：

```ts
@Injectable()
export class PaymentCompensationService {
  /**
   * 把「上次没处理完」的 webhook 事件重新入队。
   *
   * ⚠️ **为什么需要它**：`insertEvent` 的「`processedAt` 为 null → 允许重试」
   *   分支只在**渠道重投**时才有意义（5f-0 保证渠道会重投）。
   *   但渠道的重投有次数与时间窗 —— 超出就不重投了。
   *   平台自己扫一遍才是最后的兜底。
   *
   * ⚠️ **只处理「够老」的**：刚落地的事件可能正在处理中。
   */
  async retryUnprocessedEvents(): Promise<CompensationReport> { ... }
}
```

**流程**：

```
平台作用域下：
  扫 payment_webhook_events
    where: processedAt IS NULL AND createdAt < now() - EVENT_STALE_MINUTES
    （分批 + 上限，防一次扫太多）
  对每条：
    构造 NormalizedWebhookEvent（provider / channel / eventId / providerTxnId /
      payload 里的 referenceNo / amount / success）
    → checkWebhookEvent(event, row.kind)
       → accepted? tenantId?
         → 是：enqueueWebhookEvent(event, tenantId, row.kind)
                ⚠️ **jobId 要带区分标记**（D5）—— 用同一个 jobId 会被
                   BullMQ 静默忽略（failed job 的 hash 还在）
         → 否：计数（金额不符 / 找不到业务单）
```

⚠️ **`kind` 的作用**：`checkWebhookEvent(event, kind)` 决定反查订单还是反查账单 ✅

⚠️ **`enqueueWebhookEvent` 抛了怎么办**（Redis 还是挂的）：补偿扫描这一轮就失败 →
计数 + error 日志 → 下一个周期再试 ✅（扫描器本身不该因为一条失败就整体崩掉 →
**每条独立 try/catch**）

### 4.4 5f-3：兜底扫描 B —— 超时释放任务丢失

```
平台作用域下：
  扫 orders
    where: status = PENDING_PAYMENT AND payExpiresAt < now()
    （分批 + 上限）
  对每条：
    runForTenant(order.tenantId, () => orderTimeout.releaseExpiredOrder(order.id))
    → 计数
```

⚠️ **与队列里的 timeout job 重复** → 幂等靠 `transitionInTx` 的条件更新（一个赢）✅

⚠️ **释放要库存预占回滚** → `releaseExpiredOrderInTx` 在同一个事务里做 ✅

⚠️ **`payExpiresAt` 为 null 的订单**（老数据）→ 不匹配「已过」条件 → 扫不到。
⚠️ 它们的 `payExpiresAt` 是下单时写的（`order.service.ts`）→ 不是 null，只是老 ✅

### 4.5 4f-4：队列与 worker

**新增队列常量**（`api/src/common/queue/queue.constants.ts`）：

```ts
/** 支付补偿扫描队列（未处理完的 webhook 事件 + 丢失的超时释放） */
export const COMPENSATION_QUEUE = 'compensation';
```

**新增消费者**（`api/src/modules/payment/compensation.worker.ts`）—— 照 `renewal.worker.ts`：

```ts
@Processor(COMPENSATION_QUEUE)
@Injectable()
export class CompensationWorker extends WorkerHost {
  async process(job: Job): Promise<void> {
    if (job.name !== 'compensate') return;
    await tenantContext.run(platformScope(), async () => {
      await this.compensation.retryUnprocessedEvents();
      await this.compensation.releaseStuckOrders();
    });
  }
}
```

**注册周期任务**（`compensation.service.ts` 的 `onModuleInit`，与 `renewal.service.ts` 同款）：

```ts
await this.queue.addRepeating(
  COMPENSATION_QUEUE,
  'compensate',
  {},
  COMPENSATION_INTERVAL_MS,
  'payment-compensation',
);
```

### 4.6 计数与日志

每次扫描输出一行汇总：

```
支付补偿扫描完成：未处理事件 3 条（重投 2 条、金额不符 1 条），
超时未释放订单 1 条（已释放 1 条）
```

⚠️ **每条独立 try/catch** —— 一条失败不能带倒整轮扫描。

---

## 五、风险清单

| # | 风险 | 缓解 |
|---|------|------|
| R1 | **5f-0 让 webhook 接口在队列故障时返回 503** → 渠道会重投，可能打爆渠道的重试配额 | 只在**真的投递失败**时返回 503（正常路径不受影响）。渠道的重试是幂等闸后的重复处理 → 不会重复扣款 |
| R2 | **补偿扫描重复处理已在处理中的事件** | 只扫「够老」的（`createdAt` 早于 N 分钟）；消费端幂等靠状态流转的条件更新 ✅ |
| R3 | **补偿 job 的 jobId 带标记** → 同一事件每轮扫描会产生一个 job → 队列堆积 | 同一事件的补偿 job 用**同一个** jobId（`-comp` 后缀）→ 同一事件只会有一个补偿 job；但它若失败进 failed 队列，下一轮又会被忽略 ⚠️ → **解决**：jobId 带**扫描轮次**（如 `-comp-${轮次}`）？<br>**决策**：jobId 用 `-comp` 固定后缀；补偿 job 失败后由**下一轮扫描**重新入队 —— 若被 BullMQ 忽略，就记一条 warn 日志。⚠️ 这是一个**已知的边界**：BullMQ 的 failed job 占用 jobId → 补偿可能只成功一次。<br>**更稳的做法**：补偿 job 的 jobId 用**事件的 `updatedAt`/轮次**区分 → 允许重复入队 → 消费端幂等兜底 ✅ **采用这个** |
| R4 | **扫描 B 误关正在支付的订单** | 条件是 `status = PENDING_PAYMENT` **且** `payExpiresAt` 已过；`releaseExpiredOrderInTx` 里还有 `transitionInTx(PENDING_PAYMENT → CLOSED)` 的条件更新 → 与支付并发时**一个赢** ✅ |
| R5 | **平台作用域下改租户数据** | 所有写操作都在 `runForTenant(tenantId, ...)` 里 ✅（与 `renewal.worker.ts` 同款） |
| R6 | 事件表加列 → 迁移 | 一次 `ALTER TABLE ... ADD COLUMN ... DEFAULT 'ORDER'` ✅ 幂等（`ADD COLUMN IF NOT EXISTS`） |
| R7 | **补偿扫描在事件表很大时很慢** | 分批 + 上限 + 只扫「够老」的 ✅ |

---

## 六、测试策略

### 6.1 新增护栏

| # | 护栏 | 在哪测 |
|---|------|--------|
| M1 | **webhook 入队失败 → 接口返回 5xx**（不是 200） | e2e：让队列投递失败 → 断言响应码 |
| M2 | **渠道重投同一个 eventId → 事件被重新处理**（`processedAt` 为 null → 允许重试） | e2e：投递 → 让入队失败 → 重投 → 断言订单转 PAID |
| M3 | **补偿扫描 A**：未处理完的事件被重新入队并处理 | e2e：造一条 `processedAt = null` 的事件 → 跑扫描 → 断言订单转 PAID |
| M4 | **补偿扫描 A**：金额不符的事件**不**被重投 | e2e |
| M5 | **补偿扫描 B**：已过支付期限仍 PENDING_PAYMENT 的订单被释放 | e2e |
| M6 | **补偿扫描 B**：还在支付期限内的订单**不**被释放 | e2e |
| M7 | **补偿 job 能重复入队**（jobId 带轮次标记） | e2e：连续跑两轮扫描 → 断言处理了两次但订单只流转一次 |
| M8 | 事件表的 `kind` **不可被渠道伪造**（由端点写入） | e2e：投递一个订阅回调 → 断言事件行的 `kind = SUBSCRIPTION` |
| M9 | **正常路径不受影响**：webhook 正常时仍返回 200 且订单流转 | 既有 e2e 覆盖 ✅ |

### 6.2 失败注入

| # | 注入 | 预期挂掉 |
|---|------|---------|
| F1 | `enqueueWebhookEvent` 改成 catch 住不抛 | M1、M2 |
| F2 | 补偿扫描 A 去掉 `checkWebhookEvent` 的金额核对 | M4 |
| F3 | 补偿扫描 B 去掉 `payExpiresAt` 条件 | M6 |
| F4 | 补偿 job 的 jobId 去掉轮次标记 | M7 |
| F5 | `insertEvent` 的「`processedAt` 为 null → 允许重试」改成一律跳过 | M2、M3 |

### 6.3 浏览器手测

本阶段**没有前端改动** → 浏览器手测只有一条：
1. 停掉 Redis → 投递一个 webhook → 观察到接口返回 5xx（不是 200）→ 恢复 Redis → 重投 → 订单转 PAID

---

## 七、遗留项

| # | 遗留 | 说明 |
|---|------|------|
| L21 | **webhook 事件的自动重放**（把处理过的事件重新推给商家/用户） | 与「保证处理不丢」是两件事 |
| L22 | **BullMQ failed 队列的通用捞取机制** | 5f 只解决两条具体路径。通用机制要处理「任意队列的任意任务」 |
| L23 | **告警**：连续多轮补偿都没处理掉的 | 项目里只有 Logger，没有告警基建。将来接入告警时补 |
| L24 | 事件表的历史行 `kind` 一律是 `ORDER`（迁移的默认值） | 其中**订阅**类的事件会被补偿扫描判成「找不到订单」→ 不重投（保守）。这批事件在 5f 之前就已经卡住，且 `processedAt` 为 null 的极少 |
| L25 | 结算单 / 抽佣出款 | 5e 的 L18/L19 |
| L26 | 跨副本分布式刷新锁 | 5c 的 L5，扩副本前必须做 |

---

## 附：与既有设计的关系

- **阶段 5d**：本阶段**反转**了它的决策 D9（「webhook 投递失败不报失败」）——
  那条决策的理由（「支付已入库…诱导用户重复支付」）经核实不成立，且它切断了
  `insertEvent` 里「`processedAt` 为 null → 允许重试」这条唯一的救回机制。
  ⚠️ 5d 的**另一半**（「订单超时释放的投递失败不抛」）**仍然正确**，不动。
- **阶段 5c**：宽限期的 `insertEvent` 幂等闸与「`processedAt` 为 null → 允许重试」
  是本阶段补偿扫描的直接依据。
- **阶段 3**：R14「租户从业务单反查，不采信事件里的 tenantId」—— 决定了事件表
  **不加** `tenantId` 列。
