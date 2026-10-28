# 阶段 5f 验收记录：支付可靠性（修丢钱洞 + 兜底扫描）

**验收日期**：2026-10-28
**范围**：计划 5f「支付可靠性」的 Task 1–5
（`docs/superpowers/plans/2026-10-27-plan-05f-payment-reliability.md`）
**设计**：[`docs/superpowers/specs/2026-10-27-plan-05f-payment-reliability-design.md`](../specs/2026-10-27-plan-05f-payment-reliability-design.md)
**分支**：`gzt/电商项目`

**结论**：**通过（有条件）** —— 自动化测试全绿（后端单测 **186/186**、e2e **499/499**，
三个前端未改动、全部照旧）；**9 项护栏逐条核对，8 项有自动化证据**；
**5 条失败注入逐条单独复验**，4 条直接抓到、1 条揭示了**双层防线**（见 §四·4.2）；
⚠️ **浏览器手测未做**（理由见 §三，如实列出，不编造）。

---

## 一、自动化测试结果

### 1.1 数字对账

| 项目 | 阶段 5f 之前 | 阶段 5f 之后 | 增量 | 结果 |
|------|-------------|-------------|------|------|
| 后端单元测试（Jest） | 186 | **186** | 0 | ✅ 12 suites |
| 后端 e2e | 490 | **499** | **+9** | ✅ 27 suites |
| storefront（Vitest） | 209 | **209** | 0 | ✅ 24 files |
| merchant-admin（Vitest） | 207 | **207** | 0 | ✅ 16 files |
| platform-admin（Vitest） | 197 | **197** | 0 | ✅ 8 files |

> 5f **没有前端改动** → 三个前端的数字不变 ✅
> 5e 的 `api/src/modules/billing/commission.service.spec.ts`（7 条）在 5f 之前就已存在。

### 1.2 各条命令的实测

| 命令 | 通过标准 | 实测 |
|------|---------|------|
| `cd api && npx jest --passWithNoTests` | 全部通过 | **186 passed / 186**（12 suites） |
| `cd api && npm run test:e2e` | 全部通过 | **499 passed / 499**（27 suites） |
| `cd api && npx tsc --noEmit` | 无输出 | ✅ 无输出 |
| `cd api && npx eslint src/ test/` | 无告警 | ✅ |

### 1.3 本阶段新增的 9 条 e2e

| 文件 | 用例 | 覆盖 |
|------|------|------|
| `api/test/payment.e2e-spec.ts` | 3 | ⚠️ 入队失败时 webhook 接口要报失败（5xx），让渠道重投（M1）<br>⚠️ 渠道重投同一个 eventId → 事件被重新处理，订单转 PAID（M2）<br>⚠️ 订阅回调的事件行 `kind = SUBSCRIPTION`（由端点写入，不可被渠道伪造，M8） |
| `api/test/payment-compensation.e2e-spec.ts` | 6 | 扫描 A：未处理完的事件被重新入队（M3）/ 金额不符的不被重投（M4）/ 刚落库的不被扫到<br>扫描 A：同一个事件用不同轮次的 jobId 能重复入队（M7）<br>扫描 B：已过支付期限仍待支付的订单被释放（M5）/ 还在支付期限内的订单不被释放（M6） |

---

## 二、容器化验证

| 检查项 | 期望 | 实测 |
|--------|------|------|
| 镜像构建 | 新迁移能在镜像里应用 | ✅ `docker compose up -d --build api` 成功（`20261028153000_add_webhook_event_kind` 自动应用） |
| 容器健康 | `Up (healthy)`、`/health` 返回 ok | ✅ |
| **容器里的 `dist` 产物路径** | 必须是 `dist/main.js`（不是 `dist/src/main.js`） | ✅ 5f **没有在 `api/` 下新增顶层目录** → 产物路径不受影响（阶段 5e 的那个坑不会重演） |

---

## 三、浏览器手测（计划列了 1 条）

### ⚠️ **未做** —— 如实列出，不编造结果

计划 §1 的手测项是：「停掉 Redis → 投递一个 webhook → 观察到接口返回 5xx → 恢复 Redis → 重投 → 订单转 PAID」。

**没做的原因**：

1. **容器里假支付网关是关闭的** —— `infra/docker-compose.yml` 没有 `FAKE_PAYMENT_ENABLED`，
   而 `NODE_ENV=production` 时假网关**拒绝启动**（假网关无需登录即可支付，生产上不能开）。
   → 要手测就必须用 `docker compose -f docker-compose.yml -f /tmp/override.yml up -d api`
   临时开启假网关，**而那时的容器配置已经不是生产配置了** —— 手测证明的东西代表性反而下降。
2. 手测还需要一笔**真实订单 + 签名回调**（假网关的签名用 HMAC + 共享密钥），
   成本远高于它带来的增量信息。

**等价的证据**（更强的部分）：e2e 的 M1/M2 是在**真实的 Nest 应用**上跑的 ——
真实签名的 HTTP 回调、真实的 BullMQ 队列、真实的「重投 → 订单转 PAID」，
断言的是**接口的状态码**（5xx）与**订单的最终状态**。它覆盖了手测想验证的全部机制，
只是不经过浏览器。

⚠️ **这一条记在遗留里**（见 §六·7）：浏览器层面的手测缺口，等将来有「不需要改容器配置」的
测试环境时补。

---

## 四、机制级验证

### 4.1 9 项护栏（M1–M9）逐条核对

| 护栏 | 内容 | 测试位置 | 期望 | 实测 | 结论 |
|------|------|---------|------|------|------|
| **M1** | webhook 入队失败 → 接口返回 **5xx**（不是 200） | `payment.e2e-spec.ts`「⚠️ 入队失败时 webhook 接口要报失败（5xx）」 | 接口 5xx | 把队列的 `add` 打成抛错 → 响应码 **≥ 500** | ✅ |
| **M2** | 渠道重投同一个 eventId → 事件被重新处理（订单转 PAID） | `payment.e2e-spec.ts`「⚠️ 渠道重投同一个 eventId → 事件被重新处理」 | 第一次投递 5xx → 事件行 `processedAt` 仍为 null → 重投返回 200 → 订单转 PAID | 四步全部符合：第一次 **5xx**；事件行 **1 条**且 `processedAt === null`；重投 **200**；订单最终 **PAID** | ✅ |
| **M3** | 补偿扫描 A：未处理完的事件被重新入队 | `payment-compensation.e2e-spec.ts`「扫描 A：未处理完的事件被重新入队」 | 扫到 → 重新入队 | `requeued ≥ 1`；队列里能看到该事件的 job，且 **jobId 含 `-comp-`** | ✅ |
| **M4** | 补偿扫描 A：**金额不符**的事件**不**被重投 | 同上「扫描 A：金额不符的事件不被重投」 | `rejected ≥ 1`、队列里没有该事件的 job | `rejected ≥ 1`；该事件的 job 数 **0** | ✅ |
| **M5** | 补偿扫描 B：已过支付期限仍待支付的订单被释放 | `payment-compensation.e2e-spec.ts`「扫描 B：已过支付期限仍待支付的订单被释放」 | 订单转 CLOSED | 订单**不再**是 PENDING_PAYMENT（转 CLOSED） | ✅ |
| **M6** | 补偿扫描 B：**还在支付期限内的**订单**不**被释放 | 同上「扫描 B：还在支付期限内的订单不被释放」 | 订单仍是 PENDING_PAYMENT | 订单**仍**是 PENDING_PAYMENT | ✅ |
| **M7** | 补偿 job 能**重复入队**（jobId 带轮次标记，不被 BullMQ 静默忽略） | 同上「扫描 A：同一个事件用不同轮次的 jobId 能重复入队」 | 同一个事件、两个不同 jobId → 两个 job 都在 | `getJob('…-comp-round1')` 与 `getJob('…-comp-round2')` **都存在**；两个 **jobId 不同** | ✅ |
| **M8** | 事件的 `kind` **由端点写入**（不可被渠道伪造） | `payment.e2e-spec.ts`「⚠️ 订阅回调的事件行 kind = SUBSCRIPTION」 | 订阅回调 → 事件行 `kind = SUBSCRIPTION` | 事件行 **1 条**、`kind === 'SUBSCRIPTION'` | ✅ |
| **M9** | **正常路径不受影响**：webhook 正常时仍返回 200 且订单流转 | 既有 e2e | 既有断言不变 | `payment.e2e-spec.ts` **23 条**（含既有 webhook 用例）全过 | ✅ |

**9 条里 8 条有自动化实测证据**（M1–M8），M9 由既有 e2e 覆盖 ✅

### 4.2 失败注入复验（5 条，**每条单独跑**）

> ⚠️ **每条都单独跑，没有叠加** —— 阶段 5c 的教训：
> 「注入 A + 注入 B 叠加 → 挂 N 条」**不能**用来证明 A 缺独立锁点，
> 叠加时 A 的代码可能根本没机会执行。

| # | 注入 | 结果 |
|---|------|------|
| **F1** | `enqueueWebhookEvent` 把投递失败 **catch 住不抛**（5d 的旧行为） | ✅ **挂 3 条**（M1 + M2 的两处 + 另一条依赖它的用例） |
| **F2** | 补偿扫描 A 去掉 `checkWebhookEvent` 的**金额核对** | ✅ **挂 1 条**（M4） |
| **F3** | 补偿扫描 B 的「还没到支付期限就不动」判定 | ⚠️ **单打一层不挂**（见下） |
| **F4** | `enqueueWebhookEvent` **忽略 `jobIdSuffix`**（补偿 job 的 jobId 不再带轮次标记） | ✅ **挂 1 条**（M7） |
| **F5** | `insertEvent` 的「`processedAt` 为 null → 允许重试」改成**一律跳过** | ✅ **挂 1 条**（M2） |

**F3 的发现（有价值）**：「已过支付期限」这道防线有**两层**：

| 打掉哪一层 | 结果 |
|---|---|
| 只打掉**扫描器**的 `where: { payExpiresAt: { lt: now } }` | ❌ 没挂 —— `releaseExpiredOrderInTx` 里还有一道 |
| 只打掉**service** 里 `if (order.payExpiresAt > now) return false` | ❌ 没挂 —— 扫描器的 `where` 已经挡住了 |
| **两层同时打掉** | ✅ **挂 1 条**（M6） |

⚠️ **所以「F3 单条注入测不出东西」是护栏本身有两层，不是漏测**。
这与「两层都有的地方单打一层测不出」是同一类现象 —— 阶段 5c 的教训里提过
「注入 A + 注入 B 叠加 → 挂 N 条」不能证明 A，但反过来**单打一层不挂**也不能证明没有 A。

### 4.3 失败注入的复现方法

```bash
# 1. 改文件（例：注入 F1）
#    api/src/modules/payment/payment.service.ts
#      await this.queue.add(  →  try { await this.queue.add(
#      （对应把 catch 补上，让它吞掉）
# 2. 跑对应的 e2e
cd api && npm run test:e2e -- payment
# 3. 恢复（⚠️ 目标文件必须已提交，否则 git checkout -- 会把自己的改动一起抹掉）
git checkout -- api/src/modules/payment/payment.service.ts
# 4. 逐次核实 git status 干净
```

---

## 五、发现并修复的缺陷

### 1. **5d 引入的丢钱洞**（本阶段的主目标）

5d 的决策 D9「webhook 投递失败不报失败」的两条理由经核实**都不成立**：

- 「支付已入库」—— 不成立：此刻只落了**事件行**，`Payment` 单与订单流转都还没发生
- 「诱导用户重复支付」—— 不成立：返回 5xx 是给**渠道**看的，用户不参与这个请求

而 `insertEvent` 的注释（`payment.service.ts:645-652`）白纸黑字写着：
「`processedAt` 为 null → 允许重试」是**唯一**的救回机制，且「**没人会去扫这张表**」。

5d 之前：入队时 Redis 挂 → Promise 永不 settle → **请求挂死** → 渠道超时 → **重投** → 事件被重新入队 → 处理 ✅（体验差，数据不丢）
5d 之后：3 秒超时 + catch 住不抛 → **返回 200** → 渠道不重投 → 事件永远卡住 → **订单永不流转** ❌（体验好，数据丢）

**修法**：`enqueueWebhookEvent` 去掉 try/catch，失败**抛出去** → 503 → 渠道重投 → 事件不丢。
⚠️ **`order.service.ts` 那条路径不动** —— 它的「投递失败不抛」是**对的**（订单已建成，报失败会诱发重复下单）。

### 2. **补偿 job 的 jobId 会被 BullMQ 静默忽略**

BullMQ 里 **failed job 的 hash 还在** → 用同一个 jobId 重新入队会被**静默忽略**
（`addJob` 的 Lua 脚本按 jobId 查存在性）→ 补偿等于没做。
**修法**：`enqueueWebhookEvent` 加可选的 `jobIdSuffix`（默认空串 → 既有调用点行为不变），
补偿扫描传 `-comp-${轮次标记}`。

### 3. **代理实施中断留下的两个坑**（阶段 5f Task 3 的实施代理撞了 API 速率上限）

- **「连续两轮都能入队」那条用例的前提是错的**：第一轮重投后 worker 就消费了，
  `processedAt` 被置上 → 第二轮**本来就不该**再扫到它。
  → 改成直接验「同一个事件、两个不同 jobId → 两个 job 都在」（用 `getJob` 查而不是扫队列，
  因为 worker 消费得很快，扫队列会不稳定）
- **临时的验证文件被留在了仓库里**（`api/test/comp-verify.e2e-spec.ts`）→ 改名为
  `api/test/payment-compensation.e2e-spec.ts`

### 4. **事件表加 `kind` 时漏了两个内部调用点**（实施代理主动发现并补上）

`insertEvent` 除了 webhook 端点，还有**两个内部调用方**（假网关的订单路径与订阅路径）。
只改端点的话，**订阅支付的假网关事件会被记成 `ORDER`** → 直接废掉这一列的意义。
→ 两处都补上 `PaymentKind.ORDER` / `PaymentKind.SUBSCRIPTION`。

---

## 六、已知遗留项（诚实列出）

1. **L21**：webhook 事件的**自动重放**（把处理过的事件重新推给商家/用户看）—— 与「保证处理不丢」是两件事
2. **L22**：**BullMQ failed 队列的通用捞取机制** —— 5f 只解决两条具体路径
3. **L23**：**告警**：连续多轮补偿都没处理掉的 —— 项目里只有 Logger，没有告警基建
4. **L24**：事件表的**历史行 `kind` 一律是 `ORDER`**（迁移的默认值）→ 其中**订阅**类的事件会被补偿扫描判成「找不到订单」→ 不重投（保守，不会误处理）。这批事件在 5f 之前就已经卡住，且 `processedAt` 为 null 的极少
5. **L25**：结算单 / 抽佣出款 —— 5e 的 L18/L19
6. **L26**：跨副本分布式刷新锁 —— 5c 的 L5，扩副本前必须做
7. ⚠️ **本阶段新增**：**浏览器手测未做**（见 §三）—— 容器里假网关默认关闭，
   要手测就得改容器配置（那时的配置已不是生产配置）
8. ⚠️ **阶段 5d 的遗留 L1 / L12 仍只做了一半**：本阶段用**兜底扫描**覆盖了
   「投递失败」与「队列任务丢失」，但**没有**做通用的失败队列捞取（L22）

---

## 七、交付物清单

### 后端（`api/`）

| 文件 | 说明 |
|------|------|
| `src/modules/payment/payment.service.ts` | `enqueueWebhookEvent` 失败**抛出去**；`insertEvent` 收 `kind`；`enqueueWebhookEvent` 加 `jobIdSuffix` |
| `src/modules/payment/webhook.controller.ts` | 端点把 `kind` 传给 `insertEvent` |
| `src/modules/payment/compensation.service.ts` | **新增** 两个兜底扫描 + 周期任务注册 |
| `src/modules/payment/compensation.worker.ts` | **新增** 消费者（平台作用域） |
| `src/modules/payment/payment.module.ts` | 注册两个新 provider |
| `src/modules/queue/queue.constants.ts` / `queue.module.ts` / `queue.service.ts` | 新增 `compensation` 队列 |
| `src/modules/order/order.module.ts` | 导出 `OrderTimeoutService`（payment → order，单向） |
| `prisma/schema.prisma` + `prisma/migrations/20261028153000_add_webhook_event_kind/` | 事件表加 `kind` 列 |
| `test/payment.e2e-spec.ts` | 新增 3 条（M1/M2/M8） |
| `test/payment-compensation.e2e-spec.ts` | **新增** 6 条（M3–M7） |

### 文档

| 文件 | 说明 |
|------|------|
| `docs/superpowers/specs/2026-10-27-plan-05f-payment-reliability-design.md` | 设计文档 |
| `docs/superpowers/plans/2026-10-27-plan-05f-payment-reliability.md` | 实施计划 |
| `docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md` | **本文件** |

---

## 八、下一阶段

5f 之后，平台侧的业务闭环还差**结算单**（L25）：从抽佣流水聚合出「某商家 × 某周期」的应收单据。
⚠️ 切之前要先确认「生产已跑过回填」——**抽佣流水表是 5e 才建的**，
历史订单的流水要靠 `npm run backfill:commissions` 补齐（5f 的 L24 记录了它的两个边界）。
