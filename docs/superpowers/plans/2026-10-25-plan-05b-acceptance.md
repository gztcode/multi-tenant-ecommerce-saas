# 阶段 5b 验收记录

验收日期：2026-10-26
验收范围：计划 5b「平台计费（套餐 / 订阅 / 账单 / 抽佣 / 报表）」的 Task 1–9
（`docs/superpowers/plans/2026-10-25-plan-05b-billing.md`）
分支：`gzt/电商项目`

结论：**有条件通过** —— 自动化测试全绿；浏览器手测 **9 个场景全部通过**；
**17 项护栏的失败注入里 16 项确认抓到**，剩下 **1 项（M11）是「护栏有覆盖、
但计划指向的那一层观测不到」**；
**M15 原本没有测试覆盖，已在本次验收补上断言并复验**；
手测过程中发现并修复了 **3 个真 bug**
（套餐的「店铺数不限」语义被默认值吃掉；后端返回空响应体时前端显示成「加载失败」；
换套餐时续费账单按**旧套餐**出账，升级时平台少收钱）。
另有 **1 个能力缺口**：套餐的 `maxStores` **只声明不约束**（没有「新增店铺」接口）。
详见 §三、§四、§五、§六。

---

## 一、自动化测试结果

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端 e2e | `cd api && npx jest --config ./test/jest-e2e.json --runInBand` | 全部通过 | **470 passed / 470 total**（26 个套件） |
| 后端单元测试 | `cd api && npm test` | 全部通过 | **151 passed / 151 total**（7 个套件） |
| 前端单测（merchant-admin） | `cd merchant-admin && npm test` | 全部通过 | **191 passed / 191 total** |
| 前端单测（platform-admin） | `cd platform-admin && npm test` | 全部通过 | **181 passed / 181 total**（7 个文件） |
| 前端单测（storefront） | `cd storefront && npm test` | 全部通过 | **175 passed / 175 total** |
| 后端类型检查 | `cd api && npx tsc --noEmit -p tsconfig.json` | 无错误 | 通过（exit 0） |
| 后端 lint | `cd api && npm run lint` | 0 error | **2 error** —— 只有 `api/test/media.e2e-spec.ts` 的 `609:41` 与 `618:42`（**阶段 2 遗留，未动**） |
| 三个前端的 lint / build / tsc | `npm run lint` / `npm run build` / `npx tsc --noEmit` | 0 error / 成功 / 无错误 | 全部通过 |

26 个 e2e 套件里，阶段 5b 新增 / 改动的有 5 个：
`billing`（套餐与订阅）、`billing-renewal`（账单与续费）、`billing-quota`
（抽佣快照 / 到期拦截 / 额度与功能权限）、`billing-list`（账单与支付方式列表）、
`billing-report`（平台报表与跨租户订阅列表）。

**本阶段新增的测试文件**：

- `api/test/billing.e2e-spec.ts`（Task 4：套餐与订阅，护栏 M1/M2/M3/M4）
- `api/test/billing-renewal.e2e-spec.ts`（Task 5：账单、续费与订阅付款，M5/M9/M10/M11）
- `api/test/billing-quota.e2e-spec.ts`（Task 6：抽佣快照、到期拦截、额度与功能权限，M7/M8/M12/M13/M14/M15/M16）
- `api/test/billing-list.e2e-spec.ts`（Task 7：商家侧的账单与支付方式列表）
- `api/test/billing-report.e2e-spec.ts`（Task 8：平台报表与跨租户订阅列表，M17）
- `api/src/modules/billing/commission.spec.ts`（Task 3：抽佣纯函数，M6）
- `api/src/modules/billing/subscription-state.spec.ts`（Task 4：有没有服务的纯函数）
- `merchant-admin/test/lib/billing.test.ts`、`merchant-admin/test/app/api/billing-whitelist.test.ts`
- `merchant-admin/test/lib/money.test.ts`
- `platform-admin/test/lib/billing.test.ts`、`platform-admin/test/app/api/billing-whitelist.test.ts`
- `platform-admin/test/app/{plans,subscriptions,reports}-page.test.tsx`（三个页面的页面级测试）
- `platform-admin/test/components/plan-form.test.tsx`（套餐表单的组件测试）
- `platform-admin/test/lib/api-client.test.ts`（空响应体当 null）
- `merchant-admin/test/lib/api-client.test.ts`（同上）

**验收时补的一条覆盖**（失败注入发现的缺口，见 §四 M15）：

- `api/test/billing-quota.e2e-spec.ts` 新增 `describe('M15：到期判定用数据库时钟')`
  （2 条用例 + 照抄阶段 5a 的 `freezeAppClock` helper）。
  阶段 5b 的到期判定在 `subscription-state.ts` / `subscription.service.ts`，
  **本阶段原本没有这条护栏的测试** —— 不补的话，M15 就只能写「没测到」。

> ⚠️ **e2e 跑之前要停掉连着同一个 Redis 的 api**（阶段 3 踩过的坑）：
> 容器里的 webhook worker 与超时 worker 也在消费同一个队列，
> 容器连开发库、测试连测试库，于是容器抢走测试投的任务，测试超时失败。

---

## 二、容器化验证

```bash
cd infra && docker compose build && docker compose up -d
```

**八个服务全部起来**：

| 容器 | 状态 | 端口 |
|------|------|------|
| ecommerce-postgres | healthy | 15432→5432 |
| ecommerce-redis | healthy | 16380→6379 |
| ecommerce-minio | healthy | 19000→9000 / 19001→9001 |
| ecommerce-api | **healthy** | 3000→3000 |
| ecommerce-storefront | Up | 3001→3000 |
| ecommerce-merchant-admin | Up | 3002→3000 |
| ecommerce-platform-admin | Up | 3003→3000 |
| ecommerce-nginx | Up | 80→80 |

**公开接口实测**：

| 请求 | 实测 | 说明 |
|------|------|------|
| `GET /api/v1/health` | 200 `{"status":"ok"}` | api 容器 healthy |
| `GET /api/v1/platform/plans`（平台超管） | 200，`total: 4`（试用套餐 ¥0 / 基础版 ¥9900 / 专业版 ¥29900 / 下架测试 ¥100 `status:"DISABLED"`） | 阶段 5b 新增 |
| `GET /api/v1/platform/subscriptions`（平台超管） | 200，`total: 2`（跨两个租户） | 阶段 5b 新增，跨租户 |
| `GET /api/v1/platform/reports`（平台超管） | 200 `{"from":…,"to":…,"subscriptionRevenue":39800,"commissionRevenue":0,"reversal":0,"netRevenue":39800}` | 阶段 5b 新增 |
| `GET /api/v1/platform/subscriptions`（**商家**令牌） | **403** `{"code":"FORBIDDEN","message":"当前角色无权访问该资源"}` | 护栏 M17 |
| `GET /api/v1/platform/subscriptions`（未登录） | **401** `{"code":"UNAUTHORIZED"}` | |
| `GET /api/v1/billing/plans`（商家） | 200，`total: 3`（**只含在售的**，下架的「下架测试」被过滤） | 商家可订阅的套餐列表 |
| `GET /api/v1/billing/invoices`（商家） | 200 `{"items":[],"total":0}` | 阶段 5b 新增 |
| `GET /api/v1/billing/payment-methods`（商家） | 200，`total: 1`（provider `fake` / type `CARD` / `isDefault: true`，**响应里没有 `token`**） | 阶段 5b 新增 |
| `GET localhost:3001/login` | 200 | 店铺前台 |
| `GET localhost:3002/login` | 200 | 商家后台 |
| `GET localhost:3003/login` | 200 | 平台超管后台 |

⚠️ **本机 dev 的前端一律用 3011 / 3016 / 3017，不要测 3001 / 3002 / 3003 的旧镜像** ——
但**容器化验证这一节就是要测镜像**，所以这里重建了镜像再测。

---

## 三、浏览器手测（9 个场景）

**环境**：api 本地跑在 3000（`FAKE_PAYMENT_ENABLED=true`）、storefront dev 3011、
merchant-admin dev 3016、platform-admin dev 3017（启动前 `rm -rf .next`）。
**测试账号**：商家 `owner@demo.platform.test` / `Demo12345!`，
消费者 `customer@demo.platform.test` / `Demo12345!`，
平台超管 `admin@platform.test` / `Admin12345!`。

> ⚠️ **到期场景（6/7/8）用直接改库模拟时间流逝**（把 `currentPeriodEnd` /
> `trialEndsAt` 挪到过去），并用一次手动投递的 BullMQ `scan` 任务触发续费扫描 ——
> 扫描本身是每天跑一次的定时任务，手测里等不到。

| # | 场景 | 实测 |
|---|------|------|
| 1 | 平台超管建一个套餐 | 提示「套餐已创建」，列表从 1 条变 2 条：`基础版 BASIC ¥99.00 30 天 14 天 5% 商品 100 · SKU 200 · 店铺 1 功能开关「无」 在售`。**「元 → 分」「% → 基点」的换算在表单边界做对了**（99.00 元 → ¥99.00；5% → 5%） |
| 2 | 商家订阅它 | 新商家在「套餐」页看到三个可订阅套餐（试用套餐 / 基础版 / 专业版）；点「开通」→ 提示「已提交开通申请，稍后刷新即可看到新的订阅状态」；「当前订阅」页显示 `基础版 / 试用中 / 本期：2026/10/26 至 2026/11/9 / 试用到 2026/11/9，到期后开始计费。`（**试用到期日 = 今天 + 套餐的 14 天试用**）。**订单里的抽佣快照用的是这个套餐的费率**：新订单 `commissionRate = 500`、`commissionAmount = 1240`（= 24800 分 × 500 基点） |
| 3 | 领券 / 用券 | ① 订阅的套餐**不含** `features.marketing` 时建券 → **403「当前套餐不包含该功能，请升级套餐」**；② 升级到**含**营销功能的套餐（走「切换到这个套餐」→ 账单付清 → `pendingPlanId` 生效）后建券 → **成功**（`升级后建的券 MKT5B1 减 ¥10.00，满 ¥100.00 可用 · 进行中`）。③ 消费者在领券中心能看到并领取商家建的券 |
| 4 | 结算页下单 | 结算页：`商品原价 ¥258.00 / 优惠券 -¥10.00 / 实付金额 ¥248.00`；订单详情同样四行金额。**抽佣不出现在消费者的金额里** —— 抽佣是平台从商家订单里抽走的部分，不是商家付给平台的订阅费，也不影响消费者的实付 |
| 5 | 改套餐的费率 | 平台把试用套餐的费率从 5% 改成 10%（500 → 1000 基点）→ **历史订单的快照不变**：`commissionRate` 仍是 500、`commissionAmount` 仍是 1240 |
| 6 | 试用到期 | 把 demo 商家的订阅改成 EXPIRED 后：① 消费者侧下单被拒 → **「该店铺暂未开通服务」**；② 商家后台**仍然可用** —— 订单列表正常打开、「确认发货」成功（发货时间与快递单号都写上了）、「整单退款」成功（订单转 REFUNDED，**`refundedAt` 也写上了**） |
| 7 | 绑定支付方式后到期 | 绑了支付方式（渠道 fake）+ 周期挪到临近到期 → 扫描自动生成账单 `INV…` **29900 分**（= 专业版的价格）→ **自动扣款成功，账单 PAID**，订阅期自动延长一个月 |
| 8 | 没有支付方式时到期 | 没绑支付方式 + 周期挪到过去 → 账单生成了（**9900 分**，当时当前套餐是基础版）但**没扣**（账单 OPEN），订阅被置 EXPIRED；api 日志留下「订阅 … 没有绑定的支付方式，账单 … 等待商家手动支付」；商家在「账单」页点「去支付」→ 跳假网关 → 「确认支付」→ **账单 PAID、订阅期延长一个周期、`pendingPlanId` 在这一刻生效**（套餐切换成功） |
| 9 | 平台后台的报表 | 「报表」页显示 `订阅收入 ¥398.00 / 抽佣收入 ¥0.00 / 退款冲回 ¥0.00 / 净收入 ¥398.00`，并附一句「净收入 = 订阅收入 + 抽佣收入 − 退款冲回」；「统计区间：2026/9/26 23:07:00 ~ 2026/10/26 23:07:00」（**后端用数据库时钟算的「最近 30 天」，前端原样回显**）。与库里对得上：两张已付账单 9900 + 29900 = 39800 分。填上日期后区间变成 `2026/10/26 08:00:00 ~ 2026/10/27 08:00:00`（**UTC 自然日**） |

### 顺带验到的三个页面

- **「套餐」页**：新建 / 编辑 / 下架三个写操作都通。下架有二次确认，文案是
  「确定下架套餐「下架测试」？下架后商家不能再订阅它，且**无法重新上架**。」；
  下架后该套餐**从商家的可订阅列表里消失**（护栏 M3）。
- **「订阅」页**：跨租户的订阅视图 —— 商家名 + 子域名 + 当前套餐 + 待生效套餐 +
  状态 + 抽佣费率 + 当前周期 + 到期后不续费。
- **金额与费率的展示**：`0 元`显示成「¥0.00」而不是「—」（免费套餐与「拿不到价格」是两回事）；
  `null` 的额度显示成「不限」；`0` 的额度显示成「0」（**0 = 一个都不许，与「不限」不是一回事**）。

### ⚠️ 手测时踩到的四个环境坑

1. **同 host 不同端口共用 cookie**：`localhost:3011` / `3016` / `3017` 是同一个 host，
   **cookie 不按端口隔离**。在平台超管后台登录会覆盖商家后台的会话（反过来也一样），
   表现为「切回去发现被登出了」。生产环境是三个不同域名，无此问题。
2. **假支付网关默认关闭**：`FAKE_PAYMENT_ENABLED` 不设就是关，
   且 `NODE_ENV=production` 时**拒绝启动**（假网关的支付页无需登录，知道
   paymentId 就能把订单付掉）。手测要跑自动续费与「去支付」，只能本地起一个
   dev 实例（`FAKE_PAYMENT_ENABLED=true`），且 **JWT_SECRET 要与容器一致**，
   否则已签发的令牌立刻失效（401）。
3. **自动化里填不了 `datetime-local`**：`page.fill()` 对 `input[type=datetime-local]`
   无效（真实用户手动操作没问题），要用原生 setter + `input` 事件。
4. **`page.click` 的 CSS 选择器不支持链式后代**：`:has-text()` 只能出现在**终端**
   （`loc=css:tr:has-text("TEMP")` 可以，`loc=css:tr:has-text("TEMP") button` 会报
   「Invalid locator」）。行内的按钮要用快照里的 `ref`。

---

## 四、机制级验证（失败注入）

**这是本次验收的重点。** 逐项把保护逻辑临时改坏、跑测试、确认失败、立刻还原。

⚠️ **目的不是「让测试挂」，是「证明这条护栏有测试覆盖」**：
改了护栏而测试照样通过 → **这条护栏没有测试覆盖** → 如实写「这条没测到」。

| 护栏 | 注入形态 | 预期挂掉的测试 | 实测 |
|------|---------|--------------|------|
| **M1** | `SubscribeDto` 加 `price` 字段 | 「M1：订阅请求体带 price → 400」 | ✅ **抓到** —— 期望 400，实得 **201** |
| **M2** | `SubscribeDto` 加 `commissionBps` 字段 | 「M2：订阅请求体带 commissionBps → 400」 | ✅ **抓到** —— 期望 400，实得 **201** |
| **M3** | `findActiveById` 去掉 `status: ACTIVE` | 「M3：订阅一个已下架的套餐 → 404」 | ✅ **抓到** —— 期望 404，实得 **201** |
| **M4** | `subscribe()` 去掉「已有就返回」 | 「M4：重复开通 → 不会插出第二条订阅」 | ✅ **抓到** —— 期望 201，实得 **409**（真的去 insert，撞唯一索引）。DB 层另有 `subscriptions_tenantId_key` UNIQUE 索引兜底 |
| **M5** | 删掉 `invoices_subscriptionId_periodStart_key` 唯一索引 | 「M5：同一周期生成两张账单 → 第二张没建出来」 | ✅ **抓到** —— 第二张**真的建出来了**（`expect(second).toBeNull()` 实得一个 Invoice 对象）；另一条「扣款失败后再扫一次」的用例也连带暴露（库里 2 张而不是 1 张） |
| **M6** | `commission.ts` 去掉 `Math.min(raw, payableAmount)` | commission.spec 的「封顶到实付」 | ✅ **抓到**，但**计划指向的那条用例探测不到** —— 见 §四·M6 |
| **M7** | 改套餐费率时顺手改历史订单的 `commissionRate` | 「M7：改套餐的费率 → 历史订单的抽佣快照不变」 | ✅ **抓到** —— 期望 500，实得 **2000** |
| **M8** | `quota.service` 的 `currentPlan` 改成进程内缓存（订阅时快照） | 「M8：改套餐的额度 → 已订阅的商家立刻按新额度判」 | ✅ **抓到** —— 期望 409，实得 **201** |
| **M9** | `generateInvoice` 的 `amount: plan.price` → `amount: 0` | 「M9：账单金额只从套餐价格读」 | ✅ **抓到** —— 期望 9900，实得 **0** |
| **M10** | 去掉订阅付款回调的金额核对（`checkWebhookEvent` 与 `applySubscriptionEvent` **两处**） | 「M10：回调金额与账单金额不一致 → 账单仍是 OPEN，订阅期不延长」 | ✅ **抓到** —— 期望 OPEN，实得 **PAID**（不一致的金额被接受了）。⚠️ 只改一处**抓不到** —— 这条护栏是双层的 |
| **M11** | `markInvoicePaidInTx` 去掉 `status` 条件 | 「M11：同一个回调重复发两次 → 订阅期只延长一个周期」 | ⚠️ **没挂** —— 见 §四·M11 |
| **M12** | 去掉下单前的 `canAcceptOrders` 检查 | 「M12：订阅已到期 → 消费者侧下单被拒」 | ✅ **抓到** —— 期望 503，实得 **201**（同组的「商家后台仍可用」仍通过，说明只拦了消费者侧） |
| **M13** | 去掉 `products.service.create` 的额度检查 | 「M13：商品数达上限 → 建商品被拒」 | ✅ **抓到** —— 期望 409，实得 **201** |
| **M14** | `hasFeature` 的缺省改成「不是 false 就算有」 | 「M14：套餐不含营销功能 → 建券被拒」 | ✅ **抓到** —— 期望 403，实得 **201** |
| **M15** | `canAcceptOrders` 的 `databaseNow()` → `new Date()` | 「M15：到期判定用数据库时钟」（**本次验收新补**） | ✅ **抓到** —— 期望 false，实得 **true** |
| **M16** | 额度检查从 service 层挪到 controller 层 | 「M16：绕过 controller 直接调 service，额度照样拦得住」 | ✅ **抓到** —— service 直接调用**没有抛错**。⚠️ 注入后 **M13 的用例仍然通过**（走 HTTP 的路被 controller 拦住了）—— 这正说明「检查在哪一层」这件事是可观测的 |
| **M17** | 去掉 `platform-report.controller` 的 `@Roles(PLATFORM_ADMIN)` | 报告 e2e 的两条「商家账号 → 403」 | ✅ **抓到** —— 期望 403，实得 **200**（两条「未登录 → 401」仍通过，注入精确） |

**汇总：17 项里 16 项确认抓到；M11 是「护栏本身有覆盖，但计划指向的那一层观测不到」。**

### M6：计划指向的那条用例在数学上探测不到封顶

计划的 §9.2 把 M6 指向 `commission.spec.ts` 的
`'⚠️ 封顶到实付：面额大的费率不能抽出超过实付的钱（护栏 M6）'`。
注入去掉封顶后，**挂的是它的兄弟用例** `'⚠️ 费率高于 100% 也封顶到实付'`
（`rateBps: 20000`），而不是计划指向的那条。

**原因**：计划指向的那条用的是 `rateBps: 10000`（100%）、`payableAmount: 300` ——
`raw = round(300 × 10000 / 10000) = 300`，**恰好等于封顶值 300**。
去掉封顶后结果一模一样（300 vs 300），这条用例**在数学上无法探测封顶是否存在**。

⚠️ 顺带说明：后端的 `CreatePlanDto` 把 `commissionBps` 限在 `@Max(10_000)`，
所以**通过接口根本配不出 > 100% 的费率** —— 封顶在真实链路上是**纯防御**，
真正的探测者只能是纯函数测试里 `rateBps: 20000` 那条。
护栏 M6 **有**测试覆盖，只是覆盖点不在计划写的那条上。**已把计划 §9.2 的指向改掉。**

### M11：护栏有覆盖，但 `status` 条件这一层观测不到

用探针实测（探针已删）：把 `markInvoicePaidInTx` 的 `status` 条件去掉后 ——
- `markInvoicePaid` **确实被调了两次**（护栏确实被破坏）；
- 但**订阅期没有延长两次**。

**原因**：`markInvoicePaidInTx` 写的是 `currentPeriodEnd: invoice.periodEnd`
—— **绝对值**（账单行上的周期终点），不是「在当前基础上 + 30 天」的相对延长。
所以它**天然幂等**，`status` 条件只是**第二层**防御。

而现有用例第二次投递用的是**同一个 eventId**，被 `insertEvent` 的唯一索引闸
挡住（`processed: false`），压根没走到 `markInvoicePaid`。

**结论**：护栏 M11（重复回调不让订阅期延长两次）**有覆盖** ——
由 webhook 层的幂等闸 + 订阅期写绝对值兜住；
但 `markInvoicePaid` 里那个 `status` 条件**在当前实现下观测不到**。
⚠️ 要让它可观测，需要一条「相对延长」的实现或一条绕过 webhook 幂等闸的用例 ——
**两者都会改变行为，本次验收不做**（记入 §六 已知遗留项）。

---

## 五、手测与注入中发现并修复的缺陷

### 1. 套餐的「店铺数不限」被默认值吃掉（已修）

`api/src/modules/billing/plan.service.ts` 的 `create()` 写的是
`maxStores: dto.maxStores ?? 1`。**`??` 把 `null` 也当成「没传」** ——
前端按「额度留空即不限」发 `maxStores: null`，后端却建成 **1**。

界面上的标签写着「店铺数上限（留空 = 不限）」，**实际给的是 1** ——
超管以为自己不限店铺，实际只能开 1 个。

**修法**：区分「没传」与「显式传 null」：
`maxStores: dto.maxStores === undefined ? 1 : dto.maxStores`。
（`maxProducts` / `maxSkus` 没这个问题 —— 它们的默认值本来就是 null。）

**补测试**：显式传 `maxStores: null` → 建出来是 null；不传 → 仍是 1。

### 2. 后端返回空响应体时，前端显示成「加载失败」（已修）

**复现**：一个**刚注册、还没有订阅**的商家打开商家后台的「订阅」页 → 页面显示

```
当前订阅加载失败：Unexpected end of JSON input
```

**根因**：后端 `GET /billing/subscription` 在没有订阅时返回 **200 + Content-Length: 0**
（NestJS 的 handler 返回 `null` 就是这样）。前端 `apiFetch` 无条件 `await response.json()`，
空 body 直接抛 JSON 解析错误 —— **真实情况是「没有数据」，界面上却显示成「加载失败」**。
商家第一次进这一页看到的就是这句。

**修法**：两个前端的 `apiFetch` 都改成先 `await response.text()`，
空白则返回 `null`（204 的分支保留在前面，仍返回 `undefined`）。

**补测试**：`merchant-admin/test/lib/api-client.test.ts` 与
`platform-admin/test/lib/api-client.test.ts`（各 4 条）。

### 3. 换套餐时，续费账单按**旧套餐**出账（已修）

**复现**：商家当前订 ¥99 的「基础版」，切换到 ¥299 的「专业版」（`pendingPlanId`）。
到期续费时生成的账单金额是 **9900**（旧套餐的价），但这个周期开始后订阅会切到
「专业版」（`markInvoicePaid` 里 `planId = pendingPlanId`）——
**商家付 ¥99 用上了 ¥299 的套餐，平台少收了 ¥200**；反向换则是多收。

**根因**：账单覆盖的是**下一个周期**，而下��个周期跑的是**待生效的套餐**。

**修法**：`renewal.service.ts` 的 `renewOne()` 里取套餐用
`subscription.pendingPlanId ?? subscription.planId`。

**补测试**：有 `pendingPlanId` 时生成的账单金额 = 待生效套餐的价格；
没有时仍是当前套餐的价格。

⚠️ **连带的一个设计问题（未定论）**：改完之后，账单的**周期长度**也按**待生效套餐**的
`periodDays` 算。当前周期是 30 天、新套餐是 365 天时，下一期会一次性收一年 ——
这与「续费延续原周期长度」的说法不同。**本次验收只修了定价，没动周期长度**，
记入 §六 已知遗留项。

---

## 六、已知遗留项（诚实列出）

1. **套餐的 `maxStores` 只声明不约束** —— 套餐配了「店铺数上限」，但**没有「新增店铺」接口**
   （商家注册时建的那个店铺是唯一的入口），所以这个上限当前**无处可施**。
   护栏 M13 的验收表只要求商品与 SKU 两条。等「新增店铺」功能落地后再补检查点。

2. **M11 的 `status` 条件观测不到**（详见 §四·M11）—— 护栏本身有覆盖，
   但 `markInvoicePaid` 里那一层防御在当前实现下测不出来。

3. **换套餐时账单的周期长度按新套餐算**（详见 §五·3 的连带说明）——
   定价已修正，周期长度的语义还没定论。

4. **平台的报表只有「四个数」，没有分项明细** —— 抽佣收入是一个总数，
   超管看不到「哪个商家贡献了多少」。要出明细得再做一张抽佣流水表
   （设计文档 §九当初的取舍：不建独立表，代价就是跨订单聚合）。

5. **`platform-admin` 至今没有组件测试的基建沉淀** —— 本阶段搬了 storefront 的
   vitest 配置（jsdom + RTL），但只给 `plan-form` 写了组件测试；
   三个页面靠的是「遍历 React 元素树」的页面级测试（`test/helpers/page-tree.ts`），
   不是真的渲染 —— 那种方式测不了交互与样式。

---

## 七、交付物清单

### 后端（`api/`）

- `src/modules/billing/` —— `plan.service.ts`、`subscription.service.ts`、
  `invoice.service.ts`、`quota.service.ts`、`report.service.ts`、
  `commission.ts`（纯函数）、`subscription-state.ts`（纯函数）、
  `billing.controller.ts`（商家侧）、`platform-billing.controller.ts`（套餐）、
  `platform-report.controller.ts`（订阅列表与报表）
- `src/modules/billing/dto/` —— `subscribe.dto.ts`、`create-plan.dto.ts`、
  `update-plan.dto.ts`、`report-query.dto.ts`
- `src/modules/payment/` —— `payment.service.ts`（退款路径补写 `refundedAt`）、
  `renewal.service.ts`（续费扫描 + 账单定价套餐）、`renewal.worker.ts`、
  `payment-method.service.ts`（列表不返回 `token`）
- `src/modules/order/order.service.ts`（抽佣快照与到期拦截）
- `src/modules/catalog/products/products.service.ts`（商品额度）、
  `src/modules/catalog/specs/spec-matrix.service.ts`（SKU 额度）
- `src/modules/coupon/coupon.service.ts` / `promotion.service.ts`（营销功能开关）
- `prisma/schema.prisma`（四张新表 + 订单上的两个抽佣字段 + `refundedAt`）
- `prisma/migrations/20261025220000_add_billing_tables/migration.sql`
- `prisma/seed.ts`（试用套餐 + demo 租户的订阅）

### 商家后台（`merchant-admin/`）

- `src/app/(dashboard)/billing/page.tsx` + `subscription-panel.tsx`（订阅页的四个块）
- `src/app/api/billing/**`（6 个中转路由：套餐、订阅、账单、支付方式）
- `src/lib/billing.ts`、`src/lib/money.ts`

### 平台超管后台（`platform-admin/`）

- `src/app/(dashboard)/plans/`（套餐列表 + 新建 / 编辑 / 上下架）
- `src/app/(dashboard)/subscriptions/`（跨租户的订阅列表）
- `src/app/(dashboard)/reports/`（四个数 + 时间区间筛选）
- `src/app/api/billing/**`（4 个中转路由：套餐、订阅、报表）
- `src/lib/billing.ts`、`src/lib/money.ts`、`src/lib/route-helpers.ts`
- `vitest.config.ts` + `test/**`（**平台超管后台第一次有单元测试**）

### 文档

- `docs/superpowers/specs/2026-10-25-plan-05b-billing-design.md`（设计文档）
- `docs/superpowers/plans/2026-10-25-plan-05b-billing.md`（实施计划，§0.5 勘误表 16 条）
- `docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md`（本文件）

---

## 八、下一阶段

**阶段 5c：修阶段 4 的技术债。**

本阶段顺手记下的、可以放到 5c 的事：

1. **`maxStores` 的约束点**（§六·1）—— 等「新增店铺」接口。
2. **抽佣流水明细**（§六·4）—— 报表要能分项就得补一张流水表。
3. **M11 的可观测性**（§六·2）—— 要么改成相对延长并补用例，要么在注释里写明
   「`status` 条件是第二层防御，当前实现下测不到」。
4. **换套餐的周期长度语义**（§六·3）—— 定价已修，周期长度待定论。
