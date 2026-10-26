# 计划 5b：平台计费（订阅套餐、抽佣记账、平台报表）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平台能卖订阅 —— 平台超管配置套餐（价格、周期、试用期、抽佣费率、额度与功能权限），商家订阅并在到期时续费；平台按订单**实付**抽佣记账，并出一份平台收入报表。

**Architecture:** 后端新增一个 `billing` 模块（套餐 / 订阅 / 账单 / 支付方式四张表 + 抽佣纯函数 + 续费定时任务）。抽佣**不建独立表** —— 费率与抽佣额在下单时**快照**进订单，报表按订单聚合。订阅付款**复用并泛化**阶段 3 的支付链路（`payments` 表加 `kind` 与可空的 `invoiceId`，`PaymentProvider` 的「收款单」改名并新增 `chargeAuthorized`），订单支付那条路一行不改逻辑。额度与功能权限在 **service 层**拦截，到期只停止**消费者侧下单**，商家后台全部可用。

**Tech Stack:** NestJS 11 + Prisma 6 + PostgreSQL 16 | BullMQ（续费的每日扫描）| Next.js 15 + React 19 + Tailwind 4 + shadcn/ui | Vitest（前端单测）+ Jest/Supertest（后端）

**对应设计文档:** `docs/superpowers/specs/2026-10-25-plan-05b-billing-design.md` 全文。**本计划是该文档的可执行展开**，两者冲突时以设计文档为准。

---

## 零、全局约定

### 0.1 沿用阶段 3 / 5a 的既有约定（不要重新发明）

| 约定 | 位置 | 说明 |
|------|------|------|
| **金额一律整数分**，费率用**基点**（万分之） | 全局 | 阶段 0.4 已定。`price = 1000` 是 ¥10，`commissionBps = 500` 是 5%。抽佣额 = `Math.round(实付 × rateBps / 10000)`，全程整数域 |
| **租户隔离靠 `TenantPrismaService` 的 Prisma 扩展** | `api/src/common/tenant/` | 新表**带 `tenantId` 字段**的**必须**登记进 `TENANT_SCOPED_MODELS`，否则**服务启动直接失败**（`assertTenantScopedModelsRegistered` 会扫 schema）。⚠️ **不带 `tenantId` 字段的表不在扩展作用域里**（先例：阶段 3 的 `PaymentWebhookEvent`） |
| **`TenantPrismaService` 是包装模式，每个模型一个 getter** | `api/src/common/tenant/tenant-prisma.service.ts` 第 529–562 行 | 漏了 getter → 业务代码写 `this.prisma.subscription` **直接编译不过**。实现者容易临时改用 `as any` 绕过，那才是真的破防 |
| **平台级资源不带 `tenantId`** | 设计文档 §3.1 | `plans` 表**刻意不带** `tenantId`（它是平台的数据，不是租户的数据）。扩展对它不附加条件 |
| **状态流转用条件更新** | 全局 | `updateMany` where 带状态，靠**受影响行数**判赢家，不用「先查后改」。阶段 3 最关键的并发正确性 |
| **唯一约束冲突转 409** | `api/src/common/errors/unique-constraint.ts` 的 `rethrowIfUniqueViolation` | **P2002 必须在事务外处理** —— 唯一约束冲突让 PostgreSQL 事务进入 aborted 状态，在同一事务里继续查会报 `current transaction is aborted` |
| **手写索引不能靠 `prisma migrate diff` 生成** | 迁移 | diff 不认识条件唯一索引，会把它们当漂移输出成 `DROP INDEX`（阶段 2 已经踩过；阶段 5a 又踩过一次） |
| **时间判定用数据库时钟** | `api/src/common/tenant/tenant-prisma.service.ts` 的 `databaseNow()` | 阶段 5a 的 M15。多副本部署时各机器时钟有偏差，边界时刻会摇摆。**只有 `SELECT now()` 这一个窄 wrapper，没有裸 `$queryRaw`** |
| **队列消费者必须重建租户上下文** | `api/src/common/tenant/tenant-context.ts` 的 `runForTenant` | `AsyncLocalStorage` 的上下文不跨进程边界。任务里的 `tenantId` **必须来自可信源**（库里查出来的，不是客户端提交的） |
| **中转路由必须白名单重建请求体** | `*/src/app/api/**` | 阶段 2b 安全审查确立的约定。整段透传会让后端 `forbidNonWhitelisted` 400，而更根本的问题是**价格与费率字段绝不能从客户端来** |
| **代码注释用简体中文**，大量用「⚠️」标注重要约束、块注释解释「为什么」 | 全局 | 本项目既有风格。注释解释的是「为什么这样写」与「不这样写会怎样」，不是复述代码 |
| **`prisma migrate reset` 禁用** | 全局 | 阶段 2 已经因此踩过坑。迁移漂移时用 `migrate diff` 兜底 |
| **前端断言要具体** | 全部 | 「只断言 200」「只断言报错」都算恒真。**组件测试同样适用**（阶段 4 护栏 2） |
| **storefront 测试：全局环境保持 `node`，组件测试逐文件切 jsdom** | `storefront/vitest.config.ts` | `// @vitest-environment jsdom` 写在文件第一行。`storefront/test/setup.ts` 里**已有**显式 `afterEach(() => cleanup())`，**不要重复加** |
| **merchant-admin 与 platform-admin 的 vitest 只收 `test/**/*.test.ts`** | 各自的 `vitest.config.ts` | **不含 `.tsx`**，也没有 jsdom 环境。要测组件必须先搬 storefront 的基建（Task 8） |
| **e2e 跑之前必须停掉连着同一个 Redis 的 api 容器** | 环境 | 容器里的 worker 会抢走测试投的任务（容器连开发库、测试连测试库），表现为**随机的假失败**。阶段 3 踩过 |

### 0.2 本阶段的 17 项护栏

设计文档 §九列了 17 条（M1–M17）。**编号即设计文档的编号**，验收（Task 9）按编号逐条核对。

| 护栏 | 内容 | 在哪测 |
|------|------|--------|
| **M1** | **订阅请求体不可传价格 / 额度 / 费率** —— 请求体只接受 `planId`，其余一律从库里读 | Task 4（e2e）、Task 7（中转路由白名单） |
| **M2** | **订阅时不可指定抽佣费率** —— 费率只配在套餐上 | Task 4（e2e） |
| **M3** | **套餐只能由平台超管创建** —— 商家侧没有创建套餐的接口 | Task 4（e2e，商家账号调平台接口 → 403） |
| **M4** | **重复开通插出多条订阅** —— `@@unique([tenantId])` | Task 4（e2e） |
| **M5** | **同一周期两张账单 → 订阅期翻倍** —— `@@unique([subscriptionId, periodStart])` | Task 5（e2e） |
| **M6** | **抽佣额超过实付 / 为负** —— 引擎封顶到实付 | Task 3（纯函数单测） |
| **M7** | **改套餐费率影响已成交订单** —— 费率与抽佣额下单时快照 | Task 3（e2e）、Task 6 |
| **M8** | **改套餐额度影响已订阅商家** —— 额度实时读当前套餐 | Task 6（e2e） |
| **M9** | **账单金额从请求体读** —— 只从 `plan.price` 读 | Task 4（e2e） |
| **M10** | **支付回调金额与账单不一致** —— 事件金额 = 账单金额 | Task 5（webhook e2e） |
| **M11** | **重复的支付回调延长两次订阅期** —— provider + providerTxnId 幂等 | Task 5（webhook e2e） |
| **M12** | **到期后还能接新单** —— 下单的 service 层查订阅 | Task 6（e2e） |
| **M13** | **额度超限没拦住** —— 检查在 service 层 | Task 6（e2e） |
| **M14** | **功能开关被客户端绕过** —— 实时读套餐，套餐内缺这个键视为不给（**没套餐则不限制**） | Task 6（e2e） |
| **M15** | **到期判定用应用时钟** —— 用数据库的 `now()` | Task 5 / Task 6（e2e，把应用时钟冻到 2019 年） |
| **M16** | **额度与权限只在 controller 层拦** —— 检查点在 service 层 | Task 6（e2e，直接调 service） |
| **M17** | **平台超管越权看到别家租户的订阅与账单** | Task 4（e2e） |

### 0.3 端口与基础设施

| 服务 | 宿主机 | 容器内 | 状态 |
|------|--------|--------|------|
| PostgreSQL | 15432 | 5432 | 已在跑 |
| MinIO | 19000 | 9000 | 已在跑 |
| Redis | 16380 | 6379 | 已在跑 |
| api | 3000 | 3000 | 已在跑 |
| storefront | 3011 | 3000 | dev 用 3011（3001 被容器占） |
| merchant-admin | 3016 | 3000 | dev 用 3016（3002 被容器占） |
| platform-admin | 3017 | 3000 | dev 用 3017（3003 被容器占） |

> ⚠️ **本地 dev 起前端前先 `rm -rf .next`** —— 3001–3003 是**旧镜像**，
> 不含阶段 5b 的功能。阶段 2b 栽过两次「实测报缺陷、复现不出来」，
> 根因都是测了旧镜像。

### 0.4 目录

⚠️ **模块依赖不能成环** —— 这一点决定了本阶段的目录划分，**动手前必须先看懂**：

```
entitlement 的等价物（套餐/订阅/额度/账单）  ←  order, payment
                                              ↑      ↓
                                    payment（渠道、支付单、回调、自动扣款）
```

**最终形态（无环）**：

| 模块 | 装什么 | 依赖谁 |
|------|--------|--------|
| `billing` | 套餐、订阅、账单、额度、报表 | **不依赖任何业务模块** |
| `payment` | 渠道抽象、支付单、webhook、**续费的自动扣款**、支付方式 | order、coupon、billing |
| `order` | 下单 | coupon、billing |

**为什么是这个切法**（照抄会踩的坑）：

- 阶段 3 已经存在 **`payment → order`**（支付成功后流转订单状态 + 券核销）。
- 5b 的下单要查订阅 → **`order → billing`**。
- 若 `billing` 再依赖 `payment`（建支付单、扣款、验签），就成了
  **`order → billing → payment → order` 的环** —— NestJS 直接启动报错。

所以：**凡是要碰支付渠道的事，一律在 `payment` 模块里**，
`billing` 只管「账目与权益」，两者之间**只允许 `payment → billing` 一个方向**。

| 不做的事 | 后果 |
|----------|------|
| `billing` 里调 `PaymentProvider` | 成环 → 启动失败 |
| `payment` 里调 `billing` 之外的东西 | —— |
| 把「续费的自动扣款」放 billing | billing 要调 provider → 成环 |
| `order` 直接 import `billing` 的 **service** | 没问题（`billing` 不依赖 payment）✅ |

```
api/src/modules/billing/          # 账目与权益（**不碰支付渠道**）
├─ billing.module.ts
├─ plan.service.ts             # 套餐（平台级，不带 tenantId）
├─ subscription.service.ts     # 订阅、试用、换套餐、canAcceptOrders
├─ invoice.service.ts          # 账单、周期延长
├─ quota.service.ts            # 额度与功能权限的判定
├─ commission.ts               # 纯函数 computeCommission
├─ report.service.ts           # 报表的聚合
├─ billing.controller.ts       # 商家侧：套餐列表、订阅、账单
├─ platform-billing.controller.ts  # 平台侧：套餐 CRUD、订阅列表、报表
└─ dto/*.dto.ts
api/src/modules/payment/          # 渠道与收钱（**碰渠道**）
├─ payment-provider.interface.ts   # 修改：收款单改名 + chargeAuthorized
├─ fake-payment.provider.ts        # 修改
├─ payment.service.ts              # 修改：按 kind 分流 + 订阅侧的支付方法
├─ webhook.controller.ts           # 修改：新增订阅的 webhook 端点
├─ renewal.service.ts              # 新建：续费的每日扫描 + 自动扣款
├─ renewal.worker.ts               # 新建：队列消费端
└─ payment-method.service.ts       # 新建：支付方式的绑定/解绑/设默认
api/src/modules/order/
└─ order.service.ts            # 修改：下单时写抽佣快照；到期拦截
api/src/common/queue/
└─ queue.constants.ts          # 修改：新增 BILLING_QUEUE
storefront/src/lib/            # （无改动 —— 消费者侧无新界面）
merchant-admin/src/
├─ app/(dashboard)/billing/page.tsx      # 新建
├─ app/(dashboard)/billing/subscription-panel.tsx  # 新建
├─ app/api/billing/**/route.ts           # 新建（中转）
└─ lib/billing.ts                       # 新建（类型与纯函数）
platform-admin/src/
├─ app/(dashboard)/plans/page.tsx       # 新建
├─ app/(dashboard)/plans/plan-form.tsx  # 新建
├─ app/(dashboard)/subscriptions/page.tsx # 新建
├─ app/(dashboard)/reports/page.tsx     # 新建
├─ app/api/billing/**/route.ts          # 新建（中转）
└─ lib/billing.ts                       # 新建（类型与纯函数）
```

### 0.5 计划勘误索引表

> **按阶段 3 / 5a 的做法**：计划初稿写完后，拿它对着**现有代码**逐条核对，
> 发现与现状不符的地方就地修正，并在这里留一张索引表。
>
> **本表留空——实施时填。** 实施者每发现一处不符，**继续在表里加行**，
> 并在正文对应位置就地修正。不要只改表不改正文。

| # | 问题 | 后果 | 在哪修 |
|---|------|------|--------|
| 1 | Task 4 写 `SubscriptionService.hasService(tenantId)` 在**没有订阅行**时返回 `false`，即「从未订阅 = 没服务 = 拒单」 | 阶段 1–5a 的商家**全部没有订阅** —— 护栏 M12 一上线，93 条既有 e2e 全部 503，把整个阶段 1–5a 的行为禁掉 | Task 4 正文已改为 `canAcceptOrders`：**从未订阅 → 放行**，**有订阅但到期/取消 → 拒绝**。纯函数 `subscription-state.ts` 的 `hasService` 名字不变 |
| 2 | Task 6 写 `QuotaService.hasFeature` 在**没有套餐**时按 `features` 为空处理 → 返回 `false`（保守） | 「还没订阅」被当成「套餐明确不给」—— 阶段 5a 的建券与建活动全部 403，144 条既有 e2e 失败 | Task 6 正文已改为：**没有套餐 → 放行**（额度与功能开关都是「套餐给的」，没套餐就没有限制）；**套餐里缺这个键 → 视为不给**（白名单语义保持不变） |
| 3 | §6.5 表格给的三处**文件路径与现状不符**：`api/src/modules/product/product.service.ts`、`api/src/modules/product/spec-matrix.service.ts`、`api/src/modules/tenants/tenants.service.ts` | 照着路径改会找不到文件 | 现状是阶段 1 目录重组后的 `api/src/modules/catalog/products/products.service.ts` 与 `api/src/modules/catalog/specs/spec-matrix.service.ts`；§6.5 表格已就地修正 |
| 4 | §6.5 表格的第四行「`tenants.service.ts` 创建店铺的方法开头」**在现状里不存在** —— `tenants.service.ts` 只有 `list` 与 `updateStatus`；建店铺的唯一入口是 `auth.service.ts` 的 `registerMerchant`（商家注册时建第一个店铺） | 在那里加 STORE 额度检查是**死检查**：商家注册时租户刚建、无套餐，`assertWithinQuota` 必然放行。且产品**没有「新增店铺」接口** —— 套餐的 `maxStores` 当前无从约束 | **不加**这个死检查（护栏 M13 的验收表也只要求商品与 SKU 两条）。`maxStores` 「只声明不约束」这一事实记入 Task 9 的验收清单，等「新增店铺」功能落地后再补检查点 |
| 5 | §6.5 表格把 `createPromotion` / `updatePromotion` 写在 `coupon.service.ts` 下 | 实际这两个方法在 `api/src/modules/coupon/promotion.service.ts`（阶段 5a Task 3 的独立服务） | 已在 `promotion.service.ts` 的 `create` / `update` 开头加上功能开关检查；§6.5 表格已就地修正 |
| 6 | Task 7 要求写 `GET /billing/invoices` 与 `GET /billing/payment-methods` 两个中转路由，但**后端没有这两个 GET 端点** —— `InvoiceService` 与 `PaymentMethodService` 都只有写的方法，没有列表 | 中转路由写出来也是 404 —— 商家后台的「订阅」页拿不到账单与支付方式，页面一片空白 | Task 7 已补上后端的前置工作（见 §7.0）：`InvoiceService.list(tenantId)` 与 `PaymentMethodService.list(tenantId)`，以及对应的两个 GET 端点 |
| 7 | Task 7 没说 `PaymentMethod` 的列表**不能返回 `token`** | `payment_methods.token` 是渠道给的扣款凭证（自动续费要拿它去扣款），明文存在库里。列表接口把它吐给前端 = 把扣款凭证发到浏览器 | §7.0 明确要求：列表接口**只返回 id / provider / channel / type / isDefault / 时间**，**不选 `token` 字段** |
| 8 | Task 7 §7.4 要求面板上有「去支付」与「支付方式管理」，但 §7 的文件清单里**只有四个 GET 为主的路由** | 「去支付」「解绑」「设默认」没有对应的中转路由，按钮点了没反应；或者前端绕过中转直连后端（accessToken 进不了客户端） | §7.3 补三个路由：`invoices/[number]/pay`（POST）、`payment-methods`（POST 绑定）、`payment-methods/[id]`（DELETE 解绑）与 `payment-methods/[id]/default`（POST 设默认） |
| 9 | 计划把「开通套餐」等同于 `POST /billing/subscription`，**没考虑已有订阅时的情况** | 后端 `subscribe()` 命中幂等分支，**直接返回旧订阅、忽略新 planId**（护栏 M4）。商家点「开通」另一个套餐拿到 200，界面提示成功，实际套餐没换 —— **假装成功比报错更糟** | 后端加 `PATCH /billing/subscription` 暴露已有的 `changePlan()`（下个周期生效，`pendingPlanId`）；`subscribe()` 的幂等语义**不动**。前端按有无订阅分派 POST / PATCH |
| 10 | 后端 `POST /billing/invoices/:number/pay` 返回的 `payUrl` 是**后端的相对路径**（如 `/api/v1/pay/fake/xxx`） | 前端直接 `location.href = payUrl` 会打到**商家后台的域名**上 → 404，商家点了「去支付」跳不过去 | 中转路由把 `payUrl` 转成**绝对地址**再返回（`api-client.ts` 导出 `apiAbsoluteUrl`）。同理，后端的 `PaymentMethod` 列表**不返回 `token`** —— 那是扣款凭证，不能发到浏览器 |
| 11 | 前端自己写的枚举（`PlanStatus` / `SubscriptionStatus` / `InvoiceStatus`）**与后端 Prisma 枚举对不上** | 写成 `INACTIVE` / `CANCELED`（一个 L）/ `VOIDED`，后端返回的真实值 `DISABLED` / `CANCELLED`（两个 L）/ `VOID` 落到界面上就是**裸英文枚举**，而不是「已取消」「已作废」 | 前端枚举逐字对齐后端 `schema.prisma`，并加「后端真实值 → 中文」与「未知值 → 兜底」两条用例。⚠️ 这类漂移**测试测不出来** —— 测试是照着前端自己的类型写的，类型错了测试自然全绿 |
| 12 | Task 8 的 `report.service.ts` 正文里 `_sum: { commissionAmount: true }` 却读 `_sum.amount` | 抽佣收入与冲回**永远算成 0**（读出来是 `undefined`，`?? 0` 吞掉）—— 报表看起来「正常」，数字全错，**不报错** | 正文已改成读 `_sum.commissionAmount`（字段名与 `_sum` 的键逐字一致） |
| 13 | Task 8 的报表只把 `status = PAID` 的订单算进抽佣收入 | 已发货（`SHIPPED`）与已完成（`COMPLETED`）的订单**全部漏计** —— 那些订单的钱明明收了，抽佣却没入账 | ⚠️ 此处先改成 `status: { in: [PAID, SHIPPED, COMPLETED] }`，**后被第 15 条推翻**：最终口径是**只看 `paidAt`**（见第 15 条） |
| 14 | Task 8 的 `report.service.ts` 正文**没有显式走平台作用域**，也没有 `from` / `to` 回显，也没有区间校验 | 报表被商家上下文调用时会**静默只统计一个租户**的数据（数字看着正常，其实全错）；前端不知道后端实际用的是哪个区间 | 正文已改成 `tenantContext.run(platformScope(), ...)`（回调是 **async** 函数）+ 返回体带上 `from` / `to` + `from >= to` 抛 `BadRequestException` |
| 15 | Task 8 的报表把抽佣行按 `status IN (PAID, SHIPPED, COMPLETED)` 筛，冲回行按 `refundedAt` 归期 | **两侧口径不对称**：一笔单在 P 支付、P+1 退款时，P 的抽佣行因 status 变 REFUNDED 而漏掉它、P+1 的冲回行照记 —— 两期合起来净额 −500，**账上凭空少了钱**；同窗口支付且退款时净贡献 −500（真相是 0） | 正文已改为：抽佣行**只看 `paidAt`**（抽佣是支付时定下的快照，与后来退没退款无关），冲回行按 `refundedAt`；抽佣收入是**毛额**，净收入靠冲回抵掉 |
| 16 | Task 8 的订阅列表 `total` 用 `items.length`，而 `items` 被 `take: 200` 截断 | 跨租户视图下 200 家商家是正常量级，截断真的会发生 —— 超管看到「总共 200 条订阅」会以为平台只有 200 个订阅 | `total` 改成 `prisma.subscription.count()` 的**真实总数**，`items` 仍截断到 200；前端用 `total > items.length` 判断要不要提示「仅显示最近 200 条」 |
| 17 | Task 5 的 `renewOne()` 按 `subscription.planId` 取套餐来出续费账单 | 账单覆盖的是**下一个周期**，而下个周期跑的是**待生效的套餐**（`markInvoicePaid` 会把 `planId` 切成 `pendingPlanId`）。按当前套餐出账 → 商家从 ¥99 的套餐换到 ¥299 的套餐，下一期只收 ¥99，**平台少收钱**；反向换则是多收 | 正文已改成 `subscription.pendingPlanId ?? subscription.planId`（账单金额与周期长度都按**待生效的套餐**算）。⚠️ 周期长度随之改成新套餐的 `periodDays`，「续费延续原周期长度」的语义**尚未定论**，记入验收记录 §六 |
| 18 | §9.2 的 M6 指向 `commission.spec.ts` 的「封顶到实付：面额大的费率不能抽出超过实付的钱」 | 那条用例用 `rateBps: 10000`（100%）、`payableAmount: 300` → `raw = 300`，**恰好等于封顶值**，去掉封顶后结果一模一样 —— **这条用例在数学上探测不到封顶是否存在**（实测：注入后挂的是它的兄弟用例） | §9.2 的 M6 指向改成 `'⚠️ 费率高于 100% 也封顶到实付'`（`rateBps: 20000`）。⚠️ 后端的 `CreatePlanDto` 把 `commissionBps` 限在 `@Max(10_000)`，**通过接口配不出 > 100% 的费率** —— 封顶在真实链路上是纯防御，真正的探测者只能是纯函数测试 |

---

## Task 1：数据模型与迁移

**Files:**
- Modify: `api/prisma/schema.prisma`（四张新表 + `payments` 泛化 + `orders` 两个字段 + `TenantStatus` 收敛）
- Create: `api/prisma/migrations/20261025220000_add_billing_tables/migration.sql`
- Modify: `api/src/common/tenant/tenant-models.ts`（登记三张表）
- Modify: `api/src/common/tenant/tenant-prisma.service.ts`（加 getter）
- Modify: `api/prisma/seed.ts`（试用套餐 + demo 租户的订阅）
- Test: `api/src/common/tenant/tenant-prisma.service.spec.ts`

### 1.1 先写失败测试

改 `api/src/common/tenant/tenant-prisma.service.spec.ts`，加一条：

```typescript
it('billing 的三张租户作用域表都登记了，plans 刻意不登记', () => {
  // ⚠️ **plans 刻意不在名单里**：它不带 tenantId 字段（设计文档 §3.1），
  // 是「平台的数据」而不是「租户的数据」——先例是阶段 3 的 PaymentWebhookEvent。
  expect(TENANT_SCOPED_MODELS.has('Subscription')).toBe(true);
  expect(TENANT_SCOPED_MODELS.has('Invoice')).toBe(true);
  expect(TENANT_SCOPED_MODELS.has('PaymentMethod')).toBe(true);
  expect(TENANT_SCOPED_MODELS.has('Plan')).toBe(false);
});
```

- [ ] **Step 1.1: 把上面这条用例加进 `api/src/common/tenant/tenant-prisma.service.spec.ts`**（放在文件里其他 `TENANT_SCOPED_MODELS` 相关用例旁边）

### 1.2 跑测试确认失败

```bash
cd api && npx jest --runInBand src/common/tenant/tenant-prisma.service.spec.ts
```

预期：FAIL —— `Subscription` 还没登记。

### 1.3 改 schema

`api/prisma/schema.prisma`：

**a) 加四个枚举**

```prisma
enum PlanStatus {
  ACTIVE
  DISABLED
}

enum SubscriptionStatus {
  TRIAL
  ACTIVE
  EXPIRED
  CANCELLED
}

enum InvoiceStatus {
  OPEN
  PAID
  VOID
  FAILED
}

enum PaymentKind {
  ORDER
  SUBSCRIPTION
}
```

**b) 加四个模型**（贴设计文档 §3.1–§3.4 的原文，`Plan` **不带 `tenantId`**）

**c) 改 `Payment` 模型**：`orderId` 改可空、加 `invoiceId`、加 `kind`、加 `invoice` 关系
（`Payment` 与 `Invoice` 同租户 → 真关系）

**d) `Order` 加三个字段**：

```prisma
  /** 抽佣费率快照（基点）。下单时从套餐读，写死在订单上 */
  commissionRate Int @default(0)
  /** 抽佣额快照（整数分）。下单时按实付算出 */
  commissionAmount Int @default(0)
  /**
   * 退款时间。
   *
   * ⚠️ **阶段 3 的退款没有记时间** —— 报表的「退款冲回」要按**退款发生的
   * 期间**归期（不是按订单支付期间），所以这个字段是必需的。
   * 退款路径（`payment.service.ts` 的退款方法）要顺手写上。
   */
  refundedAt DateTime?
```

**e) `TenantStatus` 收敛**：`TRIAL` 值删除（试用状态由 `Subscription` 表达），
`Tenant.status` 的默认值从 `TRIAL` 改成 `ACTIVE`

- [ ] **Step 1.3: 按上面 (a)–(e) 改 `api/prisma/schema.prisma`**

### 1.4 写迁移

```bash
cd api && npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/billing-generated.sql
```

⚠️ **diff 的输出不能直接用** —— 它会把阶段 2/5a 的**手写部分唯一索引**
当漂移输出成 `DROP INDEX`（勘误表的老问题）。要做的：

1. 从 `/tmp/billing-generated.sql` 里挑出**建表与新列**的语句
2. **删掉**所有 `DROP INDEX`（那些是手写索引，diff 不认识）
3. **手写**三条索引：

```sql
-- ⚠️ orderId 变可空后，PostgreSQL 的 NULL **不参与唯一判定** ——
-- 多个 NULL 互不冲突 → 「同一个账单同一渠道只能有一笔支付单」这条保证没了。
CREATE UNIQUE INDEX "payments_order_channel_uniq"
  ON "payments" ("orderId","channel") WHERE "orderId" IS NOT NULL;
CREATE UNIQUE INDEX "payments_invoice_channel_uniq"
  ON "payments" ("invoiceId","channel") WHERE "invoiceId" IS NOT NULL;
```

4. `TenantStatus` 的 `TRIAL` 值的处理：

```sql
-- ⚠️ 用 RENAME VALUE 而不是 DROP + ADD：RENAME 保留了列默认值里对
-- 该值的引用（DROP 会让默认值失效）。PostgreSQL 10+ 支持。
ALTER TYPE "TenantStatus" RENAME VALUE 'TRIAL' TO 'ACTIVE';
```

⚠️ **索引名要与 Prisma 的期望一致**：Prisma 对带 `@@unique` 的模型会期望
`"<table>_<cols>_key"` 这样的名字。**部分唯一索引 Prisma 表达不了**
（它会当成漂移），所以这两条索引**必须手写，且要告诉 Prisma 别管它们** ——
阶段 5a 的做法是在迁移里手写，然后在 schema 里**不声明**对应的 `@@unique`。
本任务的 `payments` 上**不声明** `@@unique([orderId, channel])`，
改在 `@@index` 里都不写 —— 由迁移手写那两条。

⚠️ `Plan` 的 `@@unique([code])` 是普通唯一索引，Prisma 能表达 → 正常写进 schema，
迁移里由 diff 生成。

- [ ] **Step 1.4: 生成 diff、剔除 `DROP INDEX`、手写三条索引与 `RENAME VALUE`，把最终 SQL 写进 `api/prisma/migrations/20261025220000_add_billing_tables/migration.sql`**

### 1.5 登记租户作用域模型

`api/src/common/tenant/tenant-models.ts` 的 `TENANT_SCOPED_MODELS`：

```typescript
  // 平台计费（计划 5b）
  'Subscription',
  'Invoice',
  'PaymentMethod',
  // ⚠️ Plan 刻意**不在**这里：它不带 tenantId 字段（设计文档 §3.1），
  // 是「平台的数据」而不是「租户的数据」——先例是阶段 3 的 PaymentWebhookEvent。
```

- [ ] **Step 1.5: 改 `api/src/common/tenant/tenant-models.ts`**

### 1.6 加 getter

`api/src/common/tenant/tenant-prisma.service.ts`，在 `get promotion()` 后面加：

```typescript
  get subscription() {
    return this.client.subscription;
  }

  get invoice() {
    return this.client.invoice;
  }

  get paymentMethod() {
    return this.client.paymentMethod;
  }

  get plan() {
    return this.client.plan;
  }
```

- [ ] **Step 1.6: 加四个 getter**

### 1.7 应用迁移并生成客户端

```bash
cd api && npx prisma migrate deploy && npx prisma generate
```

预期：迁移应用成功，`prisma generate` 无报错。

⚠️ **迁移里如果有 `DROP INDEX` 被 diff 带进来，deploy 会失败**
（索引不存在）。这就是 Step 1.4 要剔除它们的原因。

- [ ] **Step 1.7: 跑 `npx prisma migrate deploy && npx prisma generate`**

### 1.8 改 seed

`api/prisma/seed.ts`：

**a) 建一个试用套餐**（平台的数据，`tenantId` 不存在）：

```typescript
  // ⚠️ **套餐是平台的数据，不带 tenantId**（设计文档 §3.1）。
  // 建一个试用套餐，让 demo 租户注册即试用。
  await prisma.plan.upsert({
    where: { code: 'trial' },
    update: {},
    create: {
      code: 'trial',
      name: '试用套餐',
      description: '14 天试用，含基础额度',
      price: 0,
      periodDays: 30,
      trialDays: 14,
      commissionBps: 500,
      maxProducts: 10,
      maxSkus: 50,
      maxStores: 1,
      features: { marketing: false },
      status: 'ACTIVE',
      sortOrder: 0,
    },
  });
```

⚠️ **`plan` 不在租户作用域里** → `prisma.plan.upsert` 里 `where: { code }` 是合法的
（`UNIQUE_ONLY_OPERATIONS` 的限制只作用于租户作用域模型）。

**b) 给 demo 租户建一条试用订阅**（让阶段 3/5a 的既有手测仍可复现 ——
否则 5b 之后 demo 店铺不能接单）：

```typescript
  const trialPlan = await prisma.plan.findUnique({ where: { code: 'trial' } });
  if (trialPlan) {
    await prisma.subscription.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        planId: trialPlan.id,
        status: 'TRIAL',
        startedAt: new Date(),
        trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 14 * 24 * 3600 * 1000),
      },
    });
  }
```

⚠️ **`subscriptions` 在租户作用域里** → `prisma.subscription` 是**裸 Prisma 客户端**
（seed 不经过 `TenantPrismaService`），所以 `where: { tenantId }` 是普通条件 ✓

- [ ] **Step 1.8: 按上面 (a)(b) 改 `api/prisma/seed.ts`**

### 1.9 跑测试

```bash
cd api && npx jest --runInBand src/common/tenant/tenant-prisma.service.spec.ts
cd api && npm run lint && npm run build
```

预期：全过。

⚠️ **`npm run build` 会暴露 schema 与代码的漂移** —— 本任务改了 `Payment` 的形状，
`payment.service.ts` 里 `payment.orderId` 的类型从 `string` 变成 `string | null`，
**此时 `tsc` 会报错**。这是预期的：那些改动在 **Task 2**。
本 Task 只要求 `tenant-prisma.service.spec.ts` 通过 + lint 通过；
`build` 的报错**记下来**，Task 2 会修掉。

- [ ] **Step 1.9: 跑那条 spec 与 `npm run lint`**

### 1.10 提交

```bash
git add api/prisma api/src/common/tenant
git commit -m "feat(api): 平台计费的数据模型与迁移

四张新表：plans（平台级，不带 tenantId）/ subscriptions / invoices /
payment_methods。payments 表泛化：加 kind（订单/订阅）、orderId 改可空、
新增 invoiceId；订单加两个抽佣快照字段。

⚠️ payments 的 (orderId, channel) 唯一索引必须改成部分唯一索引：
orderId 可空后 PostgreSQL 的 NULL 不参与唯一判定，「同一个账单同一渠道
只能有一笔支付单」这条保证就没了。

⚠️ TenantStatus 的 TRIAL 值用 RENAME VALUE 改成 ACTIVE：试用状态改由
Subscription 表达，租户状态收敛成「有没有被平台停用」这一件事。"
```

---

## Task 2：支付链路泛化（**本阶段风险最高，独立成 Task**）

**Files:**
- Modify: `api/src/modules/payment/payment-provider.interface.ts`
- Modify: `api/src/modules/payment/fake-payment.provider.ts`
- Modify: `api/src/modules/payment/payment.service.ts`
- Modify: `api/src/modules/payment/webhook.controller.ts`
- Modify: `api/src/modules/payment/fake-payment.controller.ts`
- Test: `api/test/payment.e2e-spec.ts`（阶段 3 的，改动后必须全绿）

### 2.1 先跑阶段 3 的基线

⚠️ **动手前先拿到基线**，否则改完之后不知道是自己改坏的还是本来就坏的。

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payment.e2e-spec.ts test/order.e2e-spec.ts
```

预期：全绿。**记下用例数**。

- [ ] **Step 2.1: 跑阶段 3 的支付与订单 e2e，记下用例数**

### 2.2 改接口：收款单改名 + 新增 chargeAuthorized

`api/src/modules/payment/payment-provider.interface.ts`：

```typescript
/** 发起支付时要传给渠道的信息 */
export interface CreatePaymentInput {
  /**
   * 支付单 id（uuid）——渠道侧的「支付单号」，也是幂等去重的依据。
   *
   * ⚠️ **阶段 5b 之前这个字段叫 `orderId`，但传的是支付单 id**
   * （`provider.createPayment({ orderId: payment.id, ... })`）——
   * 只有 `orderNo` 才是订单号。名字有误导，5b 借泛化一并改掉。
   */
  referenceId: string;
  /** 业务单号（订单号 / 账单号），渠道页面与对账单上显示的 */
  referenceNo: string;
  /** 支付金额（**整数分**）。⚠️ 只从订单/账单读，绝不从请求体读。 */
  amount: number;
  /** 商品标题（渠道页面上的显示名） */
  subject: string;
}

/** 用已授权的支付方式扣款的输入（自动续费） */
export interface ChargeAuthorizedInput {
  referenceId: string;
  referenceNo: string;
  amount: number;
  subject: string;
  /** 已授权的支付方式凭证（`payment_methods.token`） */
  paymentMethodToken: string;
}

/** 用已授权的支付方式扣款的结果 */
export interface ChargeAuthorizedResult {
  /** 渠道交易号。幂等去重要按它走 */
  providerTxnId: string;
  /**
   * 渠道侧的支付状态。
   * ⚠️ **开放字符串**：'SUCCESS' / 'FAILED' / 'PENDING' 各渠道不同。
   * 调用方只认 'SUCCESS'，其余走失败路径。
   */
  status: string;
}
```

`NormalizedWebhookEvent` 的 `orderNo` 改成 `referenceNo`（注释同步）：

```typescript
export interface NormalizedWebhookEvent {
  provider: string;
  channel: string;
  eventId: string;
  providerTxnId: string;
  /**
   * 业务单号（订单号 / 账单号）。
   *
   * ⚠️ **靠它反查租户**（不采信请求体里的 tenantId，阶段 3 的 R14）——
   * 订单路径反查订单，订阅路径反查账单。
   */
  referenceNo: string;
  amount: number;
  success: boolean;
}
```

`PaymentProvider` 接口加一个方法：

```typescript
export interface PaymentProvider {
  readonly channel: string;
  readonly provider: string;

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  queryPayment(providerTxnId: string): Promise<QueryPaymentResult>;
  refund(paymentId: string, amount: number, reason: string): Promise<RefundResult>;

  /**
   * 用**已授权的支付方式**直接扣款（自动续费用）。
   *
   * ⚠️ **同步返回结果，不跳页面** —— 没有人来点。真实渠道的
   * off-session charge 也是这个形态。
   * ⚠️ **重复调用由调用方保证幂等**：本项目用 `payments` 表的
   * `(invoiceId, channel)` 唯一索引（建支付单时就会撞）。
   */
  chargeAuthorized(
    input: ChargeAuthorizedInput,
  ): Promise<ChargeAuthorizedResult>;

  /**
   * 创建一个**已授权**的支付方式，返回渠道侧的凭证。
   *
   * ⚠️ **真实渠道这里要换成「跳授权页 + 回调」**（Stripe 的 SetupIntent
   * 就是这个形态）—— 本阶段的假网关直接给一个假 token。
   * 签名保持「同步返回 token」是为了让 service 层不用管两种流程。
   */
  createPaymentMethod(input: {
    /** 支付方式类型：CARD / WECHAT / ALIPAY */
    type: string;
  }): Promise<{ token: string }>;

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedWebhookEvent;
}
```

- [ ] **Step 2.2: 按上面改 `payment-provider.interface.ts`**

### 2.3 改假网关

`api/src/modules/payment/fake-payment.provider.ts`：

**a) `createPayment` 跟着改名**：

```typescript
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!isFakePaymentEnabled()) {
      throw new ServiceUnavailableException('本地假支付网关未启用');
    }
    return Promise.resolve({
      // ⚠️ 用支付单 id 本身当渠道交易号：假网关的「支付单」与「渠道交易」
      // 是一一对应的，省掉一层映射。
      providerTxnId: input.referenceId,
      payload: {
        payUrl: `/api/v1/pay/fake/${input.referenceId}`,
        referenceNo: input.referenceNo,
        amount: input.amount,
        subject: input.subject,
      },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  }
```

**b) 新增 `chargeAuthorized`**：

```typescript
  /**
   * 用已授权的支付方式扣款（自动续费）。
   *
   * ⚠️ **假网关的「已授权扣款」是立即成功的** —— 本地没有真的资金通道。
   * 但它**走的是与 `createPayment` 一样的形状**（返回渠道交易号），
   * 让调用方能像对待普通支付一样处理它（落 `providerTxnId`、比对金额）。
   *
   * ⚠️ **不能省掉这个方法**：没有它，「自动续费」只能降级成
   * 「自动生成账单 + 通知」，订阅链路就只验证了「跳页面付款」那一半。
   */
  chargeAuthorized(
    input: ChargeAuthorizedInput,
  ): Promise<ChargeAuthorizedResult> {
    if (!isFakePaymentEnabled()) {
      throw new ServiceUnavailableException('本地假支付网关未启用');
    }
    return Promise.resolve({
      providerTxnId: input.referenceId,
      status: 'SUCCESS',
    });
  }
```

**c) `parseWebhook` 的归一化**：`orderNo` → `referenceNo`（读 body 的键仍是 `orderNo`
—— 那是假网关自己的报文格式，不改；只是**归一化后**的字段改名）：

```typescript
    const eventId = readString(payload, 'eventId');
    const providerTxnId = readString(payload, 'providerTxnId');
    const referenceNo = readString(payload, 'orderNo');
    const amount = readNumber(payload, 'amount');
    const success = payload.success === true;

    if (!eventId || !providerTxnId || !referenceNo) {
      throw new BadRequestException('支付回调缺少必要字段');
    }
    // ...
    return {
      provider: this.provider,
      channel: this.channel,
      eventId,
      providerTxnId,
      referenceNo,
      amount,
      success,
    };
```

**d) 新增 `createPaymentMethod`**：

```typescript
  /**
   * 创建一个已授权的支付方式。
   *
   * ⚠️ **假网关给的是一个假 token** —— 本地没有真的支付方式。
   * 真实渠道这里要换成「跳授权页 + 回调」（Stripe 的 SetupIntent）。
   *
   * ⚠️ **token 由渠道给，不是客户端给的**：客户端传 token 的话，
   * 商家就能绑一个「不属于自己的」支付方式 —— 续费时扣的是别人的钱。
   */
  createPaymentMethod(input: { type: string }): Promise<{ token: string }> {
    if (!isFakePaymentEnabled()) {
      throw new ServiceUnavailableException('本地假支付网关未启用');
    }
    return Promise.resolve({
      token: `fake_pm_${randomUUID()}`,
    });
  }
```

- [ ] **Step 2.3: 按上面 (a)(b)(c)(d) 改 `fake-payment.provider.ts`**

### 2.4 改 PaymentService：按 kind 分流

`api/src/modules/payment/payment.service.ts`：

**a) `createPayment`（订单侧）的签名不变**，只是调 provider 时改字段名：

```typescript
    const result = await provider.createPayment({
      referenceId: payment.id,
      referenceNo: order.orderNo,
      amount,
      subject,
    });
```

**b) 新增订阅侧的三个方法**（先只写骨架，Task 5 补业务逻辑）：

```typescript
  /**
   * 建订阅的支付单并调渠道（**手动续费**走这条：跳页面付款）。
   *
   * ⚠️ **金额只从账单读**，请求体不接受任何金额字段（护栏 M9）。
   * ⚠️ **归属校验**：账单号不是秘密（它出现在渠道页面与对账单里），
   * 所以必须校验账单属于当前租户。
   */
  async createInvoicePayment(
    invoiceNumber: string,
    channel: string,
  ): Promise<CreatedPayment> { /* Task 5 补 */ }

  /**
   * 自动续费的扣款（**已授权的支付方式直接扣**，不跳页面）。
   *
   * ⚠️ **幂等靠 `payments` 的 `(invoiceId, channel)` 唯一索引**：
   * 建支付单时撞了就不再扣第二次。
   */
  async chargeInvoice(
    invoiceNumber: string,
    channel: string,
    paymentMethodToken: string,
  ): Promise<ChargeAuthorizedResult> { /* Task 5 补 */ }
```

**c) `readPaymentWithOrder` 改成按 kind 分支**：

```typescript
  /**
   * 读支付单与它引用的业务单（**跨租户**）。
   *
   * ⚠️ 渠道侧场景用（渠道的请求不带子域名，租户由支付单自己带）。
   * ⚠️ **按 `kind` 分支**：订单支付读订单，订阅支付读账单。
   */
  async readPaymentWithReference(paymentId: string): Promise<{
    payment: Payment;
    reference: { id: string; number: string; amount: number };
  }> { /* Task 5 补 */ }
```

**d) `fakeConfirmPayment` 按 kind 分流**：

```typescript
  async fakeConfirmPayment(paymentId: string): Promise<void> {
    const payment = await this.readPaymentAcrossTenants(paymentId);
    if (payment.kind === PaymentKind.SUBSCRIPTION) {
      await this.confirmInvoicePayment(payment);
      return;
    }
    await this.confirmOrderPayment(payment);
  }
```

（`confirmOrderPayment` 就是现在 `fakeConfirmPayment` 的全部内容，
`confirmInvoicePayment` 在 Task 5 补。）

**e) `checkWebhookEvent` 加 `kind` 参数**：

```typescript
  /**
   * 校验一个 webhook 事件。
   *
   * ⚠️ **租户从业务单反查**（订单或账单），绝不采信请求体里的 tenantId
   * （阶段 3 的 R14）。
   * ⚠️ **kind 决定反查哪张单** —— 由 webhook 的**端点**决定，
   * 渠道适配器不需要猜「这笔是什么」。
   */
  async checkWebhookEvent(
    event: NormalizedWebhookEvent,
    kind: PaymentKind,
  ): Promise<WebhookEventCheck> { /* 订单分支不变，订阅分支 Task 5 补 */ }
```

- [ ] **Step 2.4: 按上面 (a)–(e) 改 `payment.service.ts`**

### 2.5 加订阅的 webhook 端点

`api/src/modules/payment/webhook.controller.ts`：仿照现有的订单端点加一个：

```typescript
  /**
   * 订阅付款的回调。
   *
   * ⚠️ **与订单的回调分成两个端点**（而不是一个端点里判断类型）：
   * 分流点由**端点本身**决定 —— 渠道适配器不需要猜「这笔是什么」。
   */
  @Post('subscription/:channel')
  @HttpCode(HttpStatus.OK)
  async subscription(
    @Param('channel') channel: string,
    @Req() request: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    return this.handleWebhook(request, headers, channel, PaymentKind.SUBSCRIPTION);
  }
```

⚠️ **`@Skip()`** —— 渠道侧的请求不带子域名（与订单的回调同款）。
⚠️ **验签必须在落库之前**，失败抛异常 → HTTP 层转 401（阶段 3 的顺序，不能反）。

- [ ] **Step 2.5: 在 `webhook.controller.ts` 加订阅端点**

### 2.6 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payment.e2e-spec.ts test/order.e2e-spec.ts
```

预期：与 Step 2.1 的基线**同样的用例数全绿**。

⚠️ **用例数变了要查清楚**：阶段 3 的 e2e 大多走真实 HTTP 端点（`/pay/fake/.../confirm`），
改动面应该很小。**如果用例数变了，说明有测试被跳过或新增** —— 查清楚再往下走。

- [ ] **Step 2.6: 跑阶段 3 的 e2e，对比基线**

### 2.7 提交

```bash
git add api/src/modules/payment
git commit -m "refactor(api): 支付链路泛化成「收款单」

为订阅付款复用阶段 3 的支付链路（设计文档 §4）：

- PaymentProvider 的 CreatePaymentInput.orderId/orderNo 改名成
  referenceId/referenceNo。⚠️ 原来的 orderId 传的是**支付单 id**
  （只有 orderNo 才是订单号），名字有误导，借泛化一并改掉。
- NormalizedWebhookEvent.orderNo 改成 referenceNo（业务单号）。
- 新增 chargeAuthorized：用已授权的支付方式直接扣款（自动续费用）。
  ⚠️ 同步返回结果、不跳页面 —— 真实渠道的 off-session charge 同款。
  没有它，「自动续费」只能降级成「自动生成账单 + 通知」。
- payments 表加 kind，orderId 改可空、新增 invoiceId；
  (orderId, channel) 唯一索引改成部分唯一索引。
- webhook 分成两个端点（/webhooks/payment 与 /webhooks/subscription），
  分流点由端点决定，渠道适配器不需要猜「这笔是什么」。

订单支付那条路的逻辑一行没改 —— 只是字段名与索引形状变了。"
```

---

## Task 3：抽佣引擎（纯函数）

**Files:**
- Create: `api/src/modules/billing/commission.ts`
- Create: `api/src/modules/billing/commission.spec.ts`

### 3.1 先写失败测试

`api/src/modules/billing/commission.spec.ts`：

```typescript
import { computeCommission } from './commission';

/**
 * 抽佣计算（纯函数）。
 *
 * ⚠️ **断言要具体**：断言每个字段的**确切数值**，不是「返回了一个对象」。
 * 这里断言的每一个数字都是**整数分** —— 前端/后端一旦出现浮点，
 * 「100 元抽 5%」就会变成 4.999999999。
 */
describe('computeCommission：抽佣计算', () => {
  it('5% 的费率：实付 10000 → 抽佣 500', () => {
    expect(computeCommission({ payableAmount: 10000, rateBps: 500 })).toEqual({
      amount: 500,
    });
  });

  it('费率 0 → 不抽', () => {
    expect(computeCommission({ payableAmount: 10000, rateBps: 0 })).toEqual({
      amount: 0,
    });
  });

  it('实付 0 → 抽佣 0', () => {
    expect(computeCommission({ payableAmount: 0, rateBps: 500 })).toEqual({
      amount: 0,
    });
  });

  it('⚠️ 封顶到实付：面额大的费率不能抽出超过实付的钱（护栏 M6）', () => {
    // 100% 费率抽 300 的单，只能抽 300
    expect(computeCommission({ payableAmount: 300, rateBps: 10000 })).toEqual({
      amount: 300,
    });
  });

  it('⚠️ 费率高于 100% 也封顶到实付', () => {
    expect(computeCommission({ payableAmount: 300, rateBps: 20000 })).toEqual({
      amount: 300,
    });
  });

  it('⚠️ 全程整数：结果一定是整数，且不出现浮点尾数', () => {
    // 999 * 3333 / 10000 = 332.9667 → 取整 333
    const result = computeCommission({ payableAmount: 999, rateBps: 3333 });
    expect(Number.isInteger(result.amount)).toBe(true);
    expect(result.amount).toBe(333);
  });

  it('⚠️ 抽佣额永远不为负', () => {
    expect(
      computeCommission({ payableAmount: 10000, rateBps: -100 }).amount,
    ).toBe(0);
  });
});
```

- [ ] **Step 3.1: 建 `api/src/modules/billing/commission.spec.ts`，写上面这些用例**

### 3.2 跑测试确认失败

```bash
cd api && npx jest --runInBand src/modules/billing/commission.spec.ts
```

预期：FAIL —— 模块不存在。

### 3.3 写实现

`api/src/modules/billing/commission.ts`：

```typescript
/**
 * 平台抽佣的计算。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文。
 * 与阶段 5a 的 `discount-engine.ts` 同款理由 ——
 * 计钱的每一条分支都要能被完整断言。
 *
 * ⚠️ **全程整数域**：费率用基点（万分之），抽佣额用整数分。
 * 绝不出现 `amount * rate / 100` 这种浮点除法。
 */

/** 抽佣的结果 */
export interface CommissionResult {
  /** 抽佣额（整数分）。恒 >= 0，且 <= 计佣基数 */
  amount: number;
}

/**
 * 算抽佣。
 *
 * @param payableAmount 计佣基数：订单**实付**（整数分，已含优惠）
 * @param rateBps 费率（基点，万分之一）。500 = 5%
 */
export function computeCommission(input: {
  payableAmount: number;
  rateBps: number;
}): CommissionResult {
  // ⚠️ `payableAmount * rateBps` 的量级：10^8 × 10^4 = 10^12，
  // 远小于 2^53，整数安全。`Math.round` 收敛舍入误差。
  const raw = Math.round((input.payableAmount * input.rateBps) / 10000);
  // ⚠️ **封顶到实付**（护栏 M6）：抽佣不能超过商家的实收，
  // 否则高折扣时平台倒贴钱。下限 0。
  return { amount: Math.max(0, Math.min(raw, input.payableAmount)) };
}
```

- [ ] **Step 3.3: 建 `api/src/modules/billing/commission.ts`**

### 3.4 跑测试确认通过

```bash
cd api && npx jest --runInBand src/modules/billing/commission.spec.ts
```

预期：7 passed。

- [ ] **Step 3.4: 跑那条 spec**

### 3.5 提交

```bash
git add api/src/modules/billing
git commit -m "feat(api): 抽佣计算的纯函数

费率用基点（万分之），抽佣额用整数分，全程整数域。
⚠️ 封顶到实付：抽佣不能超过商家的实收，否则高折扣时平台倒贴钱（M6）。

纯函数是为了让计钱的每一条分支都能被完整断言 ——
与阶段 5a 的优惠引擎同款理由。"
```

---

## Task 4：套餐与订阅（service + 控制器）

**Files:**
- Create: `api/src/modules/billing/plan.service.ts`
- Create: `api/src/modules/billing/subscription.service.ts`
- Create: `api/src/modules/billing/billing.controller.ts`（商家侧）
- Create: `api/src/modules/billing/platform-billing.controller.ts`（平台侧）
- Create: `api/src/modules/billing/dto/create-plan.dto.ts`
- Create: `api/src/modules/billing/dto/update-plan.dto.ts`
- Create: `api/src/modules/billing/dto/subscribe.dto.ts`
- Create: `api/src/modules/billing/billing.module.ts`
- Modify: `api/src/app.module.ts`（注册 BillingModule）
- Test: `api/test/billing.e2e-spec.ts`

### 4.1 先写失败测试

`api/test/billing.e2e-spec.ts`（新建）。写法照 `api/test/coupon.e2e-spec.ts`
（复用 `test/helpers.ts` 的 `http(app)`、`test/merchant-fixture.ts` 的 `createMerchant`）。

必测用例（断言要具体，护栏编号写进注释）：

| 用例 | 护栏 | 断言 |
|------|------|------|
| 商家订阅一个在售套餐 → 建出订阅行 | — | 订阅的 `planId` 是那套餐、`status` 是 TRIAL（套餐有试用时） |
| **订阅请求体带 `price` → 400** | M1 | 后端 DTO 的 `forbidNonWhitelisted` 拒掉；且库里没有订阅行 |
| **订阅请求体带 `commissionBps` → 400** | M2 | 同上 |
| **订阅一个 `status = DISABLED` 的套餐 → 404** | M3 | 「套餐不存在或已下架」 |
| **商家账号调 `POST /platform/plans` → 403** | M3 | 平台接口挂 `@Roles(PLATFORM_ADMIN)` |
| **重复开通 → 不会插出第二条** | M4 | 订阅表的行数仍是 1 |
| **账单金额 = 套餐价格**（Task 5 补） | M9 | — |
| 平台超管建套餐 → 出现在商家能订阅的列表里 | — | 列表里有它 |
| 平台超管改套餐的费率 → **已订阅的商家不受影响** | M8 | 额度是实时读的 → 这里断言的是**费率快照**（Task 6 补） |

- [ ] **Step 4.1: 建 `api/test/billing.e2e-spec.ts`，按上表写用例**

### 4.2 跑测试确认失败

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing.e2e-spec.ts
```

预期：FAIL —— 模块不存在。

### 4.3 写 DTO

`api/src/modules/billing/dto/subscribe.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * 商家订阅一个套餐。
 *
 * ⚠️ **只接受 `planId`**（护栏 M1 / M2 / M9）：
 * 价格、周期、额度、抽佣费率一律从库里读。
 * 客户端多传一个 `price` 会被 `forbidNonWhitelisted` 直接 400；
 * 而更根本的问题是「客户端算的钱一律不信」。
 */
export class SubscribeDto {
  @ApiProperty({ description: '套餐 id' })
  @IsString()
  @MaxLength(64)
  planId!: string;
}
```

`api/src/modules/billing/dto/create-plan.dto.ts`：

```typescript
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 创建套餐（平台超管）。
 *
 * ⚠️ **金额一律整数分**，费率用**基点**（万分之）。
 * ⚠️ **`features` 是功能开关**（`{ marketing: true }`）——
 * 缺省一律视为 false（保守）。
 */
export class CreatePlanDto {
  @ApiProperty({ description: '套餐代码（全局唯一）' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: '套餐名称' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ required: false, description: '套餐说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: '周期价格（整数分）。0 = 免费', example: 9900 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  price!: number;

  @ApiProperty({ description: '订阅周期（天）', example: 30 })
  @IsInt()
  @Min(1)
  @Max(365)
  periodDays!: number;

  @ApiProperty({ required: false, description: '试用期（天）。0 = 无试用' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;

  @ApiProperty({ description: '抽佣比例（基点，万分之一）。500 = 5%', example: 500 })
  @IsInt()
  @Min(0)
  @Max(10_000)
  commissionBps!: number;

  @ApiProperty({ required: false, description: '商品数上限。不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxProducts?: number;

  @ApiProperty({ required: false, description: 'SKU 数上限。不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxSkus?: number;

  @ApiProperty({ required: false, description: '店铺数上限。不填 = 不限', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxStores?: number;

  @ApiProperty({
    required: false,
    description: '功能开关，如 `{ marketing: true }`。缺省视为 false',
    type: 'object',
    additionalProperties: { type: 'boolean' },
  })
  @IsOptional()
  @IsObject()
  features?: Record<string, boolean>;
}
```

`update-plan.dto.ts` 用 `PartialType(CreatePlanDto)`（与阶段 5a 的 `UpdateCouponDto` 同款）。

- [ ] **Step 4.3: 写三个 DTO 文件**

### 4.4 写 PlanService

`api/src/modules/billing/plan.service.ts`：

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PlanStatus, type Plan } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { rethrowIfUniqueViolation } from '../../common/errors/unique-constraint';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

/**
 * 套餐（平台级）。
 *
 * ⚠️ **`plans` 表刻意不带 `tenantId`**（设计文档 §3.1）：
 * 套餐是**平台的数据**，不是租户的数据 —— 扩展对它不附加任何条件。
 * 先例是阶段 3 的 `PaymentWebhookEvent`。
 *
 * ⚠️ **只有平台超管能写**（护栏 M3）：写接口挂在
 * `platform/plans`（`@Roles(PLATFORM_ADMIN)`），商家侧**没有**创建接口。
 */
@Injectable()
export class PlanService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 在售的套餐（商家能看到的） */
  async listActive(): Promise<Plan[]> {
    return this.prisma.plan.findMany({
      where: { status: PlanStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** 全部套餐（平台侧） */
  async listAll(): Promise<Plan[]> {
    return this.prisma.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * 按 id 找**在售**的套餐。
   *
   * ⚠️ **下架的套餐订不了**（护栏 M3）。
   */
  async findActiveById(id: string): Promise<Plan | null> {
    return this.prisma.plan.findFirst({
      where: { id, status: PlanStatus.ACTIVE },
    });
  }

  async create(dto: CreatePlanDto): Promise<Plan> {
    try {
      return await this.prisma.plan.create({
        data: {
          code: dto.code.trim(),
          name: dto.name.trim(),
          description: dto.description ?? null,
          price: dto.price,
          periodDays: dto.periodDays,
          trialDays: dto.trialDays ?? 0,
          commissionBps: dto.commissionBps,
          maxProducts: dto.maxProducts ?? null,
          maxSkus: dto.maxSkus ?? null,
          maxStores: dto.maxStores ?? 1,
          features: dto.features ?? {},
          status: PlanStatus.ACTIVE,
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**（唯一约束冲突让事务 aborted）
      rethrowIfUniqueViolation(error, '套餐代码');
    }
  }

  /**
   * 改套餐。
   *
   * ⚠️ **`update` 在租户作用域模型上被扩展禁用**（where 只接受唯一字段）——
   * 但 `plans` **不在**租户作用域里，所以 `update` 是合法的。
   */
  async update(id: string, dto: UpdatePlanDto): Promise<Plan> {
    const data: Record<string, unknown> = {};
    if (dto.code !== undefined) data.code = dto.code.trim();
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.periodDays !== undefined) data.periodDays = dto.periodDays;
    if (dto.trialDays !== undefined) data.trialDays = dto.trialDays;
    if (dto.commissionBps !== undefined) data.commissionBps = dto.commissionBps;
    if (dto.maxProducts !== undefined) data.maxProducts = dto.maxProducts;
    if (dto.maxSkus !== undefined) data.maxSkus = dto.maxSkus;
    if (dto.maxStores !== undefined) data.maxStores = dto.maxStores;
    if (dto.features !== undefined) data.features = dto.features;

    const found = await this.prisma.plan.findFirst({ where: { id } });
    if (!found) {
      throw new NotFoundException('套餐不存在');
    }
    return this.prisma.plan.update({ where: { id }, data });
  }

  /** 下架套餐（软删语义：保留历史订单里的套餐快照） */
  async disable(id: string): Promise<Plan> {
    const found = await this.prisma.plan.findFirst({ where: { id } });
    if (!found) {
      throw new NotFoundException('套餐不存在');
    }
    return this.prisma.plan.update({
      where: { id },
      data: { status: PlanStatus.DISABLED },
    });
  }
}
```

- [ ] **Step 4.4: 写 `plan.service.ts`**

### 4.5 写 SubscriptionService

先写一个**纯函数**（判定逻辑要与数据库无关，才能被完整断言）：

`api/src/modules/billing/subscription-state.ts`：

```typescript
/**
 * 订阅状态的判定（纯函数）。
 *
 * ⚠️ **纯函数**：不碰数据库、不读上下文。与阶段 5a 的 `discount-engine.ts`
 * 同款理由 —— 判定「有没有服务」是业务里最常被改坏的一段，
 * 它必须能被单独测。
 */

/** 判定所需的最小形状 */
export interface ServiceState {
  status: string;
  /** 试用截止。null = 不是试用 */
  trialEndsAt: Date | null;
  /** 当前周期结束 */
  currentPeriodEnd: Date;
}

/**
 * 这个租户现在有没有服务（能不能接新单）。
 *
 * ⚠️ **同时看状态与时间**：即使扫任务的 worker 还没跑到，
 * 判定也是对的 —— 不依赖「有没有人来把过期的改成 EXPIRED」。
 *
 * ⚠️ **试用与正式两种口径不同**：试用期看 `trialEndsAt`，
 * 正式期看 `currentPeriodEnd`。
 */
export function hasService(state: ServiceState, now: Date): boolean {
  if (state.status === 'TRIAL') {
    return (
      state.trialEndsAt !== null &&
      state.trialEndsAt.getTime() > now.getTime()
    );
  }
  if (state.status === 'ACTIVE') {
    return state.currentPeriodEnd.getTime() > now.getTime();
  }
  // EXPIRED / CANCELLED —— 没有服务
  return false;
}
```

⚠️ **`now` 由调用方传入**（服务层传数据库的时钟），函数内部不读 `Date.now()`
—— 与阶段 5a 的 `myCouponState` 同款。

`api/src/modules/billing/subscription.service.ts`：

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionStatus, type Subscription } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { rethrowIfUniqueViolation } from '../../common/errors/unique-constraint';
import { PlanService } from './plan.service';

/**
 * 订阅。
 *
 * ⚠️ **一个租户只有一条当前订阅**（`@@unique([tenantId])`）。
 * 历史不在这里 —— 历史在账单里（每期一张，带套餐快照）。
 * 订阅是「当前状态」，账单是「历史」。
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly plans: PlanService,
  ) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new ForbiddenException('无法确定店铺');
    }
    return context.tenantId;
  }

  /** 当前订阅（没有就是 null） */
  async current(tenantId: string): Promise<Subscription | null> {
    return this.prisma.subscription.findFirst({ where: { tenantId } });
  }

  /**
   * 这个租户现在**能不能接新单**。
   *
   * ⚠️ **「从未订阅」与「订阅已到期」是两件事**：
   * - **从未订阅**（没有订阅行）→ **放行**。商家还没选套餐，
   *   不等于不允许卖货 —— 护栏 M12 要求拦的是「到期后」。
   *   ⚠️ 把两者混为一谈会把阶段 1–5a 的既有行为整个禁掉
   *   （那些商家都没有订阅）。
   * - **有订阅但已到期 / 已取消** → **拒绝**。
   *
   * ⚠️ **判定不依赖定时任务**：即使扫任务的 worker 还没跑到，
   * 判定也是对的（同时看状态**与时间**）。
   * ⚠️ **时间用数据库的时钟**（护栏 M15）—— 多副本部署时各机器的时钟
   * 有偏差，边界时刻会摇摆。
   */
  async canAcceptOrders(tenantId: string): Promise<boolean> {
    const subscription = await this.current(tenantId);
    if (!subscription) {
      return true;
    }
    const now = await this.prisma.databaseNow();
    return hasService(subscription, now);
  }

  /**
   * 订阅一个套餐。
   *
   * ⚠️ **只接受 `planId`**（护栏 M1 / M2 / M9）：价格、周期、额度、
   * 费率一律从库里读。
   * ⚠️ **只能订在售的套餐**（护栏 M3）。
   * ⚠️ **重复开通要幂等，不是插两行**（护栏 M4）。
   */
  async subscribe(planId: string): Promise<Subscription> {
    const tenantId = this.currentTenantId();

    const plan = await this.plans.findActiveById(planId);
    if (!plan) {
      throw new NotFoundException('套餐不存在或已下架');
    }

    // ⚠️ **已有订阅就返回现有的**（护栏 M4）：重复点「开通」是常事，
    // 报错会让用户以为出错了。
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (existing) {
      return existing;
    }

    // ⚠️ **时间用数据库的时钟**（护栏 M15）
    const now = await this.prisma.databaseNow();
    const dayMs = 24 * 3600 * 1000;
    const trialEndsAt =
      plan.trialDays > 0 ? new Date(now.getTime() + plan.trialDays * dayMs) : null;

    try {
      return await this.prisma.subscription.create({
        data: {
          tenantId,
          planId: plan.id,
          status: trialEndsAt
            ? SubscriptionStatus.TRIAL
            : SubscriptionStatus.ACTIVE,
          startedAt: now,
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd:
            trialEndsAt ?? new Date(now.getTime() + plan.periodDays * dayMs),
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**
      rethrowIfUniqueViolation(error, '订阅');
      throw new ConflictException('订阅失败，请重试');
    }
  }

  /**
   * 换套餐（**下个周期生效**）。
   *
   * ⚠️ **不做差价计算**（设计文档 §一）：当前周期不退款不补差价，
   * `pendingPlanId` 在下一个周期开始时生效。
   */
  async changePlan(planId: string): Promise<Subscription> {
    const tenantId = this.currentTenantId();
    const plan = await this.plans.findActiveById(planId);
    if (!plan) {
      throw new NotFoundException('套餐不存在或已下架');
    }
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!existing) {
      throw new NotFoundException('还没有订阅');
    }
    // ⚠️ **用 `updateMany` 而不是 `update`**：租户作用域模型上
    // `update` 的 where 只接受唯一字段，扩展会直接拒绝。
    await this.prisma.subscription.updateMany({
      where: { tenantId },
      data: { pendingPlanId: plan.id },
    });
    return this.prisma.subscription.findFirst({ where: { tenantId } }) as never;
  }

  /** 到期后不自动续费 */
  async cancelAtPeriodEnd(tenantId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { tenantId },
      data: { cancelAtPeriodEnd: true },
    });
  }
}
```

- [ ] **Step 4.5: 写 `subscription.service.ts`**

### 4.6 写控制器

`api/src/modules/billing/billing.controller.ts`（**商家侧**）：

```typescript
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PlanService } from './plan.service';
import { SubscriptionService } from './subscription.service';
import { SubscribeDto } from './dto/subscribe.dto';

/**
 * 商家侧的计费接口。
 *
 * ⚠️ **订阅请求体只接受 `planId`**（护栏 M1 / M2 / M9）。
 */
@ApiTags('billing')
@Controller('billing')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
export class BillingController {
  constructor(
    private readonly plans: PlanService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: '可订阅的套餐列表' })
  async listPlans() {
    return this.plans.listActive();
  }

  @Get('subscription')
  @ApiOperation({ summary: '当前订阅' })
  async currentSubscription() {
    const tenantId = /* 当前租户 */;
    return this.subscriptions.current(tenantId);
  }

  @Post('subscription')
  @ApiOperation({ summary: '订阅一个套餐' })
  subscribe(@Body() dto: SubscribeDto) {
    return this.subscriptions.subscribe(dto.planId);
  }
}
```

`api/src/modules/billing/platform-billing.controller.ts`（**平台侧**）：

```typescript
/**
 * 平台超管的计费接口。
 *
 * ⚠️ **路径是 `platform/plans` 而不是 `plans`** —— 与阶段 5a 的
 * `merchant/coupons` 同款理由：消费者侧与平台侧的鉴权方式根本不同，
 * 同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 */
@ApiTags('platform-billing')
@Controller('platform/plans')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformBillingController { /* 套餐的 CRUD */ }
```

⚠️ **平台的控制器**还要有「订阅列表」与「报表」两条路径，
但它们不在 `platform/plans` 这个前缀下 —— 拆成
`platform/subscriptions` 与 `platform/reports` 两个 controller。

- [ ] **Step 4.6: 写三个控制器（商家侧 / 平台套餐 / 平台订阅与报表）**

### 4.7 写模块并注册

`api/src/modules/billing/billing.module.ts`：

```typescript
@Module({
  imports: [AuthModule],
  controllers: [
    BillingController,
    PlatformBillingController,
    PlatformSubscriptionController,
    PlatformReportController,
  ],
  providers: [PlanService, SubscriptionService, InvoiceService, QuotaService],
  exports: [PlanService, SubscriptionService, InvoiceService, QuotaService],
})
export class BillingModule {}
```

⚠️ **`billing` 模块不 import `payment`** —— 它一旦 import，
`order → billing → payment → order` 就成了环（NestJS 启动报错）。
详见 §0.4 的依赖图。

⚠️ **导出 `SubscriptionService` 与 `QuotaService`** —— Task 6 的下单流程要调它们，
模块依赖方向是 `order → `billing`（单向），反过来会循环依赖。

`api/src/app.module.ts` 加 `BillingModule` 的 import。

- [ ] **Step 4.7: 写模块并在 `app.module.ts` 注册**

### 4.8 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing.e2e-spec.ts
cd api && npm run lint && npm run build
```

预期：全过。

- [ ] **Step 4.8: 跑那条 e2e 与 lint/build**

### 4.9 提交

```bash
git add api/src/modules/billing api/src/app.module.ts api/test/billing.e2e-spec.ts
git commit -m "feat(api): 套餐与订阅

平台超管配置套餐（价格、周期、试用期、抽佣费率、额度、功能开关），
商家订阅与换套餐（换套餐下个周期生效，不做差价计算）。

⚠️ 订阅请求体只接受 planId：价格、周期、额度、费率一律从库里读（M1/M2/M9）。
⚠️ 只能订在售的套餐（M3）；套餐的写接口全在 platform/ 前缀下，
商家侧没有创建接口（M3）。
⚠️ 重复开通要幂等——返回现有的订阅，不是插两行（M4）。
⚠️ 时间用数据库的时钟（M15）。"
```

---

## Task 5：账单、续费与订阅付款

> ⚠️ **本 Task 跨两个模块，这是 §0.4 的依赖规则决定的**：
> 「账目」在 `billing`，「碰渠道的事」在 `payment`。
> **只有 `payment → billing` 一个方向**，反过来就成环。

**Files:**
- Create: `api/src/modules/billing/invoice.service.ts`
- Create: `api/src/modules/payment/payment-method.service.ts`（支付方式的绑定）
- Create: `api/src/modules/payment/renewal.service.ts`（续费的每日扫描 + 自动扣款）
- Create: `api/src/modules/payment/renewal.worker.ts`（队列消费端）
- Modify: `api/src/common/queue/queue.constants.ts`
- Modify: `api/src/modules/queue/queue.service.ts`
- Modify: `api/src/modules/queue/queue.module.ts`
- Modify: `api/src/modules/payment/payment.service.ts`（补 Task 2 留的订阅侧方法）
- Modify: `api/src/modules/payment/webhook.controller.ts`（补订阅端点的实现）
- Modify: `api/src/modules/payment/payment.module.ts`（导出新的服务）
- Test: `api/test/billing-renewal.e2e-spec.ts`

### 5.1 先写失败测试

`api/test/billing-renewal.e2e-spec.ts`（新建）：

| 用例 | 护栏 | 断言 |
|------|------|------|
| 续费回调成功 → 订阅期延长一个周期 | — | `currentPeriodEnd` 变成 `periodEnd`；账单 `status = PAID` |
| **回调金额 ≠ 账单金额 → 拒绝** | M10 | 账单仍是 OPEN；订阅期**没**延长 |
| **同一个回调重复发两次 → 只延长一次** | M11 | `currentPeriodEnd` 只往后延了一个周期（不是两个） |
| **同一周期生成两张账单 → 撞唯一索引** | M5 | 第二张被拒（`P2002` → 409 或跳过） |
| 试用到期 → 生成第一个付费周期的账单 | — | 账单金额 = 套餐价；`periodStart` = 试用结束日 |
| 账单金额 = 套餐价格（不是请求体传的） | M9 | 改套餐价后重新生成的账单跟着变 |

- [ ] **Step 5.1: 建 `api/test/billing-renewal.e2e-spec.ts`，按上表写用例**

### 5.2 跑测试确认失败

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing-renewal.e2e-spec.ts
```

预期：FAIL。

### 5.3 加队列

`api/src/common/queue/queue.constants.ts`：

```typescript
/** 计费的每日扫描队列（生成账单 + 自动扣款） */
export const BILLING_QUEUE = 'billing';
```

`api/src/modules/queue/queue.service.ts`：
- `QueueName` 联合类型加上 `typeof BILLING_QUEUE`
- 构造函数注入 `@InjectQueue(BILLING_QUEUE) billingQueue`
- 加一个方法：

```typescript
  /**
   * 投递一个**周期性**任务。
   *
   * ⚠️ **固定 `jobId` 是去重的关键**：BullMQ 的周期性任务按
   * （jobId + repeat 配置）去重，固定 jobId 意味着重复注册是**覆盖**而不是
   * **叠加** —— 否则每次重启应用都会多一个扫描任务。
   */
  async addRepeating(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    everyMs: number,
    jobId: string,
  ): Promise<void> {
    await this.queueOf(queueName).add(jobName, data, {
      jobId,
      repeat: { every: everyMs },
      ...DEFAULT_JOB_OPTIONS,
    });
  }
```

`api/src/modules/queue/queue.module.ts` 的 `BullModule.registerQueue` 加上
`{ name: BILLING_QUEUE }`。

- [ ] **Step 5.3: 加队列常量、`addRepeating` 方法与注册**

### 5.4 写 InvoiceService

`api/src/modules/billing/invoice.service.ts`：

```typescript
import { ConflictException, Injectable } from '@nestjs/common';
import { InvoiceStatus, SubscriptionStatus, type Invoice } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { rethrowIfUniqueViolation } from '../../common/errors/unique-constraint';
import { PlanService } from './plan.service';

/**
 * 账单与订阅周期。
 *
 * ⚠️ **同一周期只能有一张账单**（护栏 M5）：
 * `@@unique([subscriptionId, periodStart])` 兜底 —— 重复的续费回调
 * 撞唯一索引 → 不会让订阅期翻倍。
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly plans: PlanService,
  ) {}

  /**
   * 生成某个周期的账单。
   *
   * ⚠️ **金额只从套餐价格读**（护栏 M9）：请求体不接受任何金额字段。
   * ⚠️ **免费周期不出账单**（试用期）：`price = 0` 的套餐不出账单。
   */
  async generateInvoice(input: {
    subscriptionId: string;
    tenantId: string;
    planId: string;
    periodStart: Date;
    periodEnd: Date;
    dueAt: Date;
  }): Promise<Invoice | null> {
    const plan = await this.prisma.plan.findFirst({ where: { id: input.planId } });
    if (!plan) {
      throw new Error('套餐不存在');
    }
    // ⚠️ **免费周期不出账单** —— 出了也是 0 元，还会污染「待付账单」的列表
    if (plan.price === 0) {
      return null;
    }

    const now = await this.prisma.databaseNow();
    try {
      return await this.prisma.invoice.create({
        data: {
          tenantId: input.tenantId,
          subscriptionId: input.subscriptionId,
          planId: plan.id,
          number: generateInvoiceNumber(now),
          amount: plan.price,
          status: InvoiceStatus.OPEN,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          dueAt: input.dueAt,
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**。这里撞的是 (subscriptionId, periodStart) ——
      // 说明这个周期已经有账单了，返回 null（幂等）而不是报错。
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 账单付清 → 订阅期延长一个周期。
   *
   * ⚠️ **条件更新**：`updateMany` where 带 `status: OPEN`，
   * 受影响行数为 0 说明这张账单已经处理过了 —— **不重复延长**（护栏 M11）。
   */
  async markInvoicePaid(invoiceId: string): Promise<boolean> {
    const now = await this.prisma.databaseNow();
    const affected = await this.prisma.invoice.updateMany({
      where: { id: invoiceId, status: InvoiceStatus.OPEN },
      data: { status: InvoiceStatus.PAID, paidAt: now },
    });
    if (affected.count === 0) {
      return false;
    }

    const invoice = await this.prisma.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) {
      return false;
    }

    // ⚠️ **延长周期 + 让待生效的套餐在这里生效**
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: invoice.subscriptionId },
    });
    if (!subscription) {
      return false;
    }
    const nextPlanId = subscription.pendingPlanId ?? subscription.planId;

    await this.prisma.subscription.updateMany({
      where: { id: invoice.subscriptionId },
      data: {
        status: SubscriptionStatus.ACTIVE,
        planId: nextPlanId,
        pendingPlanId: null,
        currentPeriodStart: invoice.periodStart,
        currentPeriodEnd: invoice.periodEnd,
        trialEndsAt: null,
      },
    });
    return true;
  }
}
```

**账单号**（`api/src/modules/billing/invoice.service.ts` 里的小函数）：

```typescript
/**
 * 生成账单号。
 *
 * ⚠️ **服务端生成**：账单号不是秘密（它出现在渠道页面与对账单里），
 * 但**不能由客户端指定** —— 否则「付了 A 账单的钱、开通了 B 账单」就可能发生。
 */
function generateInvoiceNumber(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `INV${stamp}${random}`;
}
```

- [ ] **Step 5.4: 写 `invoice.service.ts`**

### 5.5 补完支付侧的订阅方法与支付方式绑定

补完 Task 2 留的三个骨架（`payment.service.ts`）：

```typescript
  /**
   * 建订阅的支付单并调渠道（**手动续费**：跳页面付款）。
   *
   * ⚠️ **金额只从账单读**（护栏 M9 / M10 的前半段）。
   * ⚠️ **归属校验**：账单号不是秘密，必须校验它属于当前租户。
   */
  async createInvoicePayment(
    invoiceNumber: string,
    channel: string,
  ): Promise<CreatedPayment> {
    const tenantId = this.currentTenantId();
    const provider = this.providerOf(channel);

    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId, number: invoiceNumber },
    });
    if (!invoice) {
      throw new NotFoundException('账单不存在');
    }
    if (invoice.status !== InvoiceStatus.OPEN) {
      throw new ConflictException('账单当前状态不允许支付');
    }

    // ⚠️ **同一个账单同一渠道只能有一笔支付单** ——
    // `payments_invoice_channel_uniq` 兜底。重复发起时返回已有的那笔
    // （用户点两次「去支付」是常事）。
    const raced = await this.prisma.payment.findFirst({
      where: { invoiceId: invoice.id, channel },
    });
    if (raced) {
      return this.toCreatedPayment(raced, invoice.number);
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        kind: PaymentKind.SUBSCRIPTION,
        invoiceId: invoice.id,
        channel,
        provider: provider.provider,
        amount: invoice.amount,
      },
    });

    const result = await provider.createPayment({
      referenceId: payment.id,
      referenceNo: invoice.number,
      amount: invoice.amount,
      subject: `订阅账单 ${invoice.number}`,
    });

    await this.prisma.payment.updateMany({
      where: { id: payment.id, providerTxnId: null },
      data: { providerTxnId: result.providerTxnId },
    });

    return {
      paymentId: payment.id,
      payUrl: String(result.payload.payUrl ?? ''),
      amount: invoice.amount,
    };
  }
```

`chargeInvoice`（自动续费）：

```typescript
  /**
   * 自动续费的扣款（**已授权的支付方式直接扣**，不跳页面）。
   *
   * ⚠️ **幂等靠 `payments_invoice_channel_uniq`**：建支付单时撞了就
   * 不再扣第二次。
   */
  async chargeInvoice(
    invoiceNumber: string,
    channel: string,
    paymentMethodToken: string,
  ): Promise<ChargeAuthorizedResult> {
    const tenantId = this.currentTenantId();
    const provider = this.providerOf(channel);

    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId, number: invoiceNumber },
    });
    if (!invoice) {
      throw new NotFoundException('账单不存在');
    }
    if (invoice.status !== InvoiceStatus.OPEN) {
      throw new ConflictException('账单当前状态不允许支付');
    }

    const existing = await this.prisma.payment.findFirst({
      where: { invoiceId: invoice.id, channel },
    });
    if (existing) {
      // ⚠️ **已经扣过了** —— 不重复扣（护栏 M11）
      throw new ConflictException('该账单已有支付单');
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        kind: PaymentKind.SUBSCRIPTION,
        invoiceId: invoice.id,
        channel,
        provider: provider.provider,
        amount: invoice.amount,
      },
    });

    const result = await provider.chargeAuthorized({
      referenceId: payment.id,
      referenceNo: invoice.number,
      amount: invoice.amount,
      subject: `订阅账单 ${invoice.number}`,
      paymentMethodToken,
    });

    await this.prisma.payment.updateMany({
      where: { id: payment.id, providerTxnId: null },
      data: { providerTxnId: result.providerTxnId },
    });

    return result;
  }
```

⚠️ **`chargeAuthorized` 是同步返回的**（Task 2 的设计）——
调用方（续费的 worker）在拿到 `status === 'SUCCESS'` 后**直接**推进账单状态，
不走 webhook。**手动付款**才走 webhook 那条路。

**支付方式的绑定**（新建 `api/src/modules/billing/payment-method.service.ts`）：

```typescript
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PAYMENT_PROVIDERS } from '../payment/payment.constants';
import { Inject } from '@nestjs/common';
import type { PaymentProvider } from '../payment/payment-provider.interface';

/**
 * 商家的支付方式（自动续费的前提）。
 *
 * ⚠️ **token 由渠道给，不是客户端给的** —— 客户端传 token 的话，
 * 商家就能绑一个「不属于自己的」支付方式，续费时扣的是别人的钱。
 *
 * ⚠️ **token 明文存**：真实渠道必须加密存（可解密的密文 ——
 * 自动续费要拿它去扣款，不是用来比对的）。
 */
@Injectable()
export class PaymentMethodService {
  constructor(
    private readonly prisma: TenantPrismaService,
    @Inject(PAYMENT_PROVIDERS)
    private readonly providers: Map<string, PaymentProvider>,
  ) {}

  /** 绑定一个支付方式 */
  async create(tenantId: string, type: string, channel: string) {
    const provider = this.providers.get(channel);
    if (!provider) {
      throw new BadRequestException('未知的支付渠道');
    }
    const { token } = await provider.createPaymentMethod({ type });
    return this.prisma.paymentMethod.create({
      data: {
        tenantId,
        provider: provider.provider,
        channel,
        type,
        token,
        isDefault: true,
      },
    });
  }

  /** 解绑 */
  async remove(tenantId: string, id: string): Promise<void> {
    // ⚠️ **用 `updateMany` 而不是 `delete`**：租户作用域模型上
    // `delete` 的 where 只接受唯一字段，扩展会直接拒绝。
    // ⚠️ 这里是**物理删除**（不是软删）：支付方式不用保留历史 ——
    // 但**核销记录要留**，所以只删 token 所在的这一行。
    await this.prisma.paymentMethod.deleteMany({ where: { id, tenantId } });
  }

  /** 设为默认（默认的只有一个） */
  async setDefault(tenantId: string, id: string): Promise<void> {
    await this.prisma.paymentMethod.updateMany({
      where: { tenantId },
      data: { isDefault: false },
    });
    await this.prisma.paymentMethod.updateMany({
      where: { id, tenantId },
      data: { isDefault: true },
    });
  }
}
```

⚠️ **`deleteMany` 是物理删除** —— `payment_methods` **不在** `SOFT_DELETE_MODELS` 里
（它不是凭证，是「下次续费用什么扣」的指针）。删了它不影响历史账单。

- [ ] **Step 5.5: 补完 `payment.service.ts` 的三个订阅侧方法，并新建 `payment-method.service.ts`**

### 5.6 写续费的每日扫描

`api/src/modules/payment/renewal.service.ts`：

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { SubscriptionStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { tenantContext, platformScope } from '../../common/tenant/tenant-context';
import { runForTenant } from '../../common/tenant/tenant-context';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import { InvoiceService } from '../billing/invoice.service';
import { PaymentService } from './payment.service';

/** 提前几天生成账单 */
export const INVOICE_LEAD_DAYS = 3;

/**
 * 续费的每日扫描：生成账单 + 尝试自动扣款。
 *
 * ⚠️ **这个服务在 `payment` 模块里**，不在 `billing` 里 ——
 * 它要调渠道（`chargeAuthorized`），而 `billing` 一旦依赖 `payment`
 * 就会与 `order → billing` 构成**模块依赖的环**
 * （`order → billing → payment → order`），NestJS 启动直接报错。
 * 详见计划 §0.4 的依赖图。
 *
 * ⚠️ **扫描在平台作用域下做**（要扫所有租户的订阅），
 * **写操作在租户作用域下做**（账与支付单都是租户的数据）。
 * 两者的切换用 `runForTenant`。
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    // ⚠️ **`billing → payment` 是被禁止的方向**，所以这里是
    // `payment → billing`（单向）—— 账目的事问 billing 要。
    private readonly invoices: InvoiceService,
    private readonly payments: PaymentService,
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * 注册每日扫描的周期性任务。
   *
   * ⚠️ **固定 jobId**：BullMQ 的周期性任务按（jobId + repeat 配置）去重，
   * 固定 jobId 意味着重复注册是覆盖而不是叠加。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'scan',
      {},
      { jobId: 'billing-scan', repeat: { every: 24 * 3600 * 1000 } },
    );
  }

  /**
   * 扫一遍：找出「周期开始前 3 天内到期」的订阅，逐个处理。
   */
  async scan(): Promise<void> {
    const now = await this.prisma.databaseNow();
    const lead = new Date(now.getTime() + INVOICE_LEAD_DAYS * 24 * 3600 * 1000);

    // ⚠️ **平台作用域下扫** —— 要找所有租户的订阅
    const due = await tenantContext.run(platformScope(), () =>
      this.prisma.subscription.findMany({
        where: {
          status: { in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE] },
          currentPeriodEnd: { lte: lead },
          cancelAtPeriodEnd: false,
        },
      }),
    );

    for (const subscription of due) {
      // ⚠️ **写操作回到租户作用域** —— 租户 id 来自库里（可信源），
      // 不是客户端提交的
      await runForTenant(subscription.tenantId, async () => {
        await this.renewOne(subscription.id);
      });
    }
  }

  /** 给一个订阅生成下一期的账单并尝试自动扣款 */
  private async renewOne(subscriptionId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId },
    });
    if (!subscription) return;

    // ⚠️ **账单按「待生效的套餐」出**：这张账单覆盖的是**下一个周期**，
    // 而下一个周期跑的是 pendingPlanId 那个套餐（markInvoicePaid 会把
    // planId 切成它）。按当前套餐出账的话，商家从 ¥99 的套餐换到 ¥299 的套餐，
    // 下一期只收 ¥99 —— **平台少收钱**；反向换则是多收。
    const nextPlanId = subscription.pendingPlanId ?? subscription.planId;
    const plan = await this.prisma.plan.findFirst({
      where: { id: nextPlanId },
    });
    if (!plan) return;

    const now = await this.prisma.databaseNow();
    const dayMs = 24 * 3600 * 1000;

    // ⚠️ **下一个周期的边界**：从当前周期结束日开始
    const periodStart = subscription.currentPeriodEnd;
    const periodEnd = new Date(periodStart.getTime() + plan.periodDays * dayMs);

    const invoice = await this.invoices.generateInvoice({
      subscriptionId: subscription.id,
      tenantId: subscription.tenantId,
      planId: plan.id,
      periodStart,
      periodEnd,
      dueAt: periodStart,
    });
    if (!invoice) {
      // 免费周期（试用期）不出账单 —— 但**试用到期**要把状态转成 EXPIRED
      await this.expireIfNeeded(subscription, now);
      return;
    }

    // ⚠️ **自动扣款**：有绑定的支付方式才扣
    const method = await this.prisma.paymentMethod.findFirst({
      where: { tenantId: subscription.tenantId, isDefault: true },
    });
    if (!method) {
      // 没有支付方式 → 账单挂着，等商家手动付
      return;
    }

    // ⚠️ **自动扣款**：走的是「已授权的支付方式直接扣」那条路
    // （`chargeAuthorized` 同步返回结果，不跳页面）
    const result = await this.payments.chargeInvoice(
      invoice.number,
      method.channel,
      method.token,
    );
    if (result.status !== 'SUCCESS') {
      // ⚠️ **扣款失败 → 账单标 FAILED**，商家可以手动重试
      await this.prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.OPEN },
        data: { status: InvoiceStatus.FAILED },
      });
      return;
    }
    // ⚠️ **付清 → 延长一个周期**（条件更新，重复处理不会延长两次）
    await this.invoices.markInvoicePaid(invoice.id);
  }
}
```

- [ ] **Step 5.6: 写 `renewal.service.ts`**

### 5.7 写队列消费端

`api/src/modules/payment/renewal.worker.ts`：

```typescript
/**
 * 续费扫描的消费端。
 *
 * ⚠️ **必须在平台作用域下跑**：扫描要跨租户。
 * 写操作由 `RenewalService` 内部用 `runForTenant` 切回租户作用域。
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 幂等靠「同一周期只能有一张账单」的唯一索引。
 */
@Processor(BILLING_QUEUE)
@Injectable()
export class RenewalWorker extends WorkerHost {
  async process(job: Job): Promise<void> {
    if (job.name !== 'scan') {
      return;
    }
    await tenantContext.run(platformScope(), async () => {
      await this.renewal.scan();
    });
  }
}
```

- [ ] **Step 5.7: 写 `renewal.worker.ts`**

### 5.8 补订阅的 webhook 处理

⚠️ **订阅的 webhook 端点在 `payment` 模块里**（不是 billing）——
它要用 provider 验签与幂等落库（都在 payment 模块），而它要标记的账单在
billing 模块 → **`payment → billing`，方向对了，不成环** ✓

`api/src/modules/payment/webhook.controller.ts` 的订阅端点调
`PaymentService.handleSubscriptionWebhook(event)`，其实现：

```typescript
  /**
   * 处理订阅付款的回调。
   *
   * ⚠️ **金额必须与账单一致**（护栏 M10）：不一致就拒绝 ——
   * 付了 A 金额、开通了 B 金额的套餐，是最典型的资金漏洞。
   * ⚠️ **租户从账单反查**（不采信请求体里的 tenantId，阶段 3 的 R14）。
   */
  async handleSubscriptionWebhook(event: NormalizedWebhookEvent): Promise<void> {
    const check = await this.checkWebhookEvent(event, PaymentKind.SUBSCRIPTION);
    if (!check.accepted || !check.tenantId) {
      return;
    }
    const inserted = await this.insertEvent(event);
    if (!inserted) {
      return;   // 重复回调 —— 幂等表挡住了
    }
    // ⚠️ **金额核对**（护栏 M10）
    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId: check.tenantId, number: event.referenceNo },
    });
    if (!invoice) {
      return;
    }
    if (invoice.amount !== event.amount) {
      // ⚠️ **金额对不上就拒绝**，不推进任何状态
      this.logger.error(`订阅回调金额不符：账单 ${invoice.amount}，事件 ${event.amount}`);
      return;
    }
    if (!event.success) {
      await this.prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.OPEN },
        data: { status: InvoiceStatus.FAILED },
      });
      return;
    }
    // ⚠️ **付清 → 延长周期**（条件更新，重复回调不会延长两次）
    await this.billing.markInvoicePaid(invoice.id);
  }
```

- [ ] **Step 5.8: 补订阅的 webhook 处理**

⚠️ **`PaymentService` 要注入 `InvoiceService`**（billing 模块的）→
`api/src/modules/payment/payment.module.ts` 加 `imports: [..., BillingModule]`。

⚠️ **这是 `payment → billing` 的单向依赖** —— 与 §0.4 的依赖图一致，
**不是环**（`billing` 不 import `payment`）✓

### 5.9 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing-renewal.e2e-spec.ts test/billing.e2e-spec.ts test/payment.e2e-spec.ts
cd api && npm run lint && npm run build
```

预期：全绿。

- [ ] **Step 5.9: 跑那三个 e2e 与 lint/build**

### 5.10 提交

```bash
git add api/src/modules/billing api/src/common/queue api/src/modules/queue api/src/modules/payment
git commit -m "feat(api): 账单、续费与订阅付款

账单的生成时机统一为「周期开始前 3 天」，定时任务每天扫一次。
试用期的账单不生成（免费周期），但下一个付费周期的账单在试用结束前
3 天就生成——商家在试用期里就能看到「要续费了」。

⚠️ 同一周期只能有一张账单（M5）：@@unique([subscriptionId, periodStart]) 兜底，
重复的续费回调撞索引 → 不会让订阅期翻倍。
⚠️ 账单付清 → 订阅期延长用条件更新（status = OPEN），重复回调不延长两次（M11）。
⚠️ 回调金额必须与账单一致，不一致就拒绝、不推进任何状态（M10）。
⚠️ 扫描在平台作用域下做，写操作回到租户作用域（runForTenant）——
租户 id 来自库里，不是客户端提交的。"
```

---

## Task 6：下单接入（抽佣快照 + 到期拦截）与额度、功能权限

**Files:**
- Create: `api/src/modules/billing/quota.service.ts`
- Modify: `api/src/modules/order/order.service.ts`（抽佣快照 + 到期拦截）
- Modify: `api/src/modules/order/order.module.ts`（import BillingModule）
- Modify: `api/src/modules/product/product.service.ts`（商品额度）
- Modify: `api/src/modules/product/product.module.ts`（import BillingModule）
- Modify: `api/src/modules/product/spec-matrix.service.ts`（SKU 额度）
- Modify: `api/src/modules/coupon/coupon.service.ts`（营销功能开关）
- Modify: `api/src/modules/coupon/coupon.module.ts`（import BillingModule）
- Test: `api/test/billing-quota.e2e-spec.ts`

⚠️ **依赖方向**：`order` / `product` / `coupon` → `billing`（单向）✓
`billing` 不 import 它们 → 不成环 ✓（§0.4 的依赖图）

### 6.1 先写失败测试

`api/test/billing-quota.e2e-spec.ts`（新建）：

| 用例 | 护栏 | 断言 |
|------|------|------|
| 下单成功 → 订单上有抽佣快照 | M7 | `commissionRate` = 套餐费率；`commissionAmount` = 实付 × 费率 |
| **改套餐费率 → 历史订单的抽佣不变** | M7 | 老订单的 `commissionAmount` 仍是原值 |
| **订阅过期 → 下单被拒** | M12 | 409/503「该店铺暂未开通服务」 |
| **订阅过期 → 商家后台仍可用**（发货、退款不报错） | M12 | 发货接口 201 |
| **商品数达上限 → 建商品被拒** | M13 | 409「当前套餐最多 N 个商品，请升级套餐」 |
| **SKU 数达上限 → 建 SKU 被拒** | M13 | 同上 |
| **营销功能关闭 → 建券被拒** | M14 | 403「当前套餐不包含营销功能」 |
| **额度检查绕不过 controller** | M16 | 直接调 service 也被拒 |
| **改套餐额度 → 已订阅商家立刻按新额度判** | M8 | 额度是实时读的 |

- [ ] **Step 6.1: 建 `api/test/billing-quota.e2e-spec.ts`，按上表写用例**

### 6.2 跑测试确认失败

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing-quota.e2e-spec.ts
```

预期：FAIL。

### 6.3 写 QuotaService

`api/src/modules/billing/quota.service.ts`：

```typescript
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Plan } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

/** 功能开关的键（**用常量，不写字面量**） */
export const FEATURE_MARKETING = 'marketing';

/** 额度检查的种类 */
export type QuotaKind = 'PRODUCT' | 'SKU' | 'STORE';

const QUOTA_LABEL: Record<QuotaKind, string> = {
  PRODUCT: '商品',
  SKU: 'SKU',
  STORE: '店铺',
};

/**
 * 额度与功能权限。
 *
 * ⚠️ **检查点在 service 层**（护栏 M16）：只在 controller 层拦的话，
 * 绕过 controller 直接调 service 就拦不住。
 *
 * ⚠️ **额度与功能开关实时读当前套餐**（护栏 M8）：商家在页面上看到什么，
 * 就是什么。套餐改了额度，已订阅的商家立刻按新额度判。
 * （**费率不一样** —— 它影响已成交的钱，所以下单时快照在订单上。）
 */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 当前租户的套餐（没有订阅就没有套餐） */
  async currentPlan(tenantId: string): Promise<Plan | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!subscription) {
      return null;
    }
    return this.prisma.plan.findFirst({ where: { id: subscription.planId } });
  }

  /**
   * 这个功能**有没有被限制**。
   *
   * ⚠️ **没有套餐 → 不限制**（返回 true）：额度与功能开关都是「套餐给的」，
   * 没套餐就没有限制。⚠️ 这与「套餐明确不给」是**两件事** ——
   * 前者是不设限，后者是禁止。混为一谈会把「还没订阅」的商家
   * 整个功能都禁掉（阶段 5a 的商家就是这么被误伤的）。
   *
   * ⚠️ **套餐里缺这个键 → 视为不给**（保守）：功能开关是「白名单」语义 ——
   * 套餐没显式打开的功能，就当它没有。
   */
  async hasFeature(tenantId: string, feature: string): Promise<boolean> {
    const plan = await this.currentPlan(tenantId);
    if (!plan) {
      return true;
    }
    const features = (plan.features ?? {}) as Record<string, unknown>;
    return features[feature] === true;
  }

  /**
   * 额度检查：超了就拒绝。
   *
   * ⚠️ **没有套餐 → 不限制**：额度是套餐给的，没套餐就没有上限。
   * ⚠️ **上限为 null → 不限制**（与阶段 5a 的 `totalLimit: null` 同款）。
   */
  async assertWithinQuota(tenantId: string, kind: QuotaKind): Promise<void> {
    const plan = await this.currentPlan(tenantId);
    if (!plan) {
      return;
    }
    const limit =
      kind === 'PRODUCT'
        ? plan.maxProducts
        : kind === 'SKU'
          ? plan.maxSkus
          : plan.maxStores;
    if (limit === null || limit === undefined) {
      return;
    }
    const current = await this.countUsage(tenantId, kind);
    if (current >= limit) {
      throw new ConflictException(
        `当前套餐最多 ${limit} 个${QUOTA_LABEL[kind]}，请升级套餐`,
      );
    }
  }

  /**
   * 计数。
   *
   * ⚠️ **用租户作用域的 `count()`** —— 扩展自动附加 tenantId 条件，
   * 软删过滤也自动生效（已软删的商品不占额度）。
   */
  private async countUsage(tenantId: string, kind: QuotaKind): Promise<number> {
    if (kind === 'PRODUCT') {
      return this.prisma.product.count({ where: { tenantId } });
    }
    if (kind === 'SKU') {
      return this.prisma.sku.count({ where: { tenantId } });
    }
    return this.prisma.store.count({ where: { tenantId } });
  }

  /**
   * 功能开关检查：没有这个功能就拒绝。
   *
   * ⚠️ **拒绝的文案要说清是套餐的问题**（护栏 M14）：
   * 「当前套餐不包含营销功能，请升级套餐」——
   * 商家看到这句话才知道下一步做什么。
   */
  async assertHasFeature(tenantId: string, feature: string): Promise<void> {
    if (await this.hasFeature(tenantId, feature)) {
      return;
    }
    throw new ForbiddenException('当前套餐不包含该功能，请升级套餐');
  }
}
```

- [ ] **Step 6.3: 写 `quota.service.ts`**

### 6.4 下单接入

`api/src/modules/order/order.service.ts`：

**a) 注入 billing 的服务**（模块依赖方向 `order` → `billing`，单向）：

```typescript
  constructor(
    ...
    private readonly billing: SubscriptionService,
    private readonly quota: QuotaService,
  ) {}
```

**b) 下单流程里，在锁 SKU 之后、算优惠之前插入到期拦截**：

```typescript
    // ⚠️ **到期 → 不接新单**（护栏 M12）
    //
    // ⚠️ **「从未订阅」是放行的**：商家还没选套餐 ≠ 不许卖货。
    //   拦的是「订阅已到期 / 已取消」。
    //
    // ⚠️ **只拦消费者侧的下单**：发货、退款这些**必须**还能做，
    // 否则等于把商家锁死（客诉会直接落到平台头上）。
    if (!(await this.billing.canAcceptOrders(tenantId))) {
      throw new ServiceUnavailableException('该店铺暂未开通服务');
    }
```

**c) 算完优惠后取套餐费率，写抽佣快照**：

```typescript
    // ⚠️ **抽佣快照**（护栏 M7）：费率从套餐读，金额按**实付**算。
    // 快照在订单上 —— 改套餐费率不影响已成交订单。
    const plan = await this.quota.currentPlan(tenantId);
    const rateBps = plan?.commissionBps ?? 0;
    const commission = computeCommission({
      payableAmount: discount.payableAmount,
      rateBps,
    });
```

**d) 建单时写进订单**（`createOrderAndItems` 的 input 加两个字段）：

```typescript
        commissionRate: rateBps,
        commissionAmount: commission.amount,
```

⚠️ **`computeCommission` 只返回 `{ amount }`** —— 费率是从套餐读的，
不是算出来的，所以要单独传给 `createOrderAndItems`。

- [ ] **Step 6.4: 按上面 (a)–(d) 改 `order.service.ts`**

### 6.5 在业务路径上插额度与功能检查

| 文件 | 位置 | 插入 |
|------|------|------|
| `api/src/modules/catalog/products/products.service.ts` | 创建商品的方法开头 | `await this.quota.assertWithinQuota(tenantId, 'PRODUCT')` |
| `api/src/modules/catalog/specs/spec-matrix.service.ts` | 创建 SKU 的方法开头（SKU 只在这里创建） | `await this.quota.assertWithinQuota(tenantId, 'SKU')` |
| `api/src/modules/coupon/coupon.service.ts` | `createCoupon` / `updateCoupon` 开头 | `await this.quota.assertHasFeature(tenantId, FEATURE_MARKETING)` |
| `api/src/modules/coupon/promotion.service.ts` | `create` / `update` 开头 | `await this.quota.assertHasFeature(tenantId, FEATURE_MARKETING)` |

⚠️ **STORE 额度当前没有检查点**（勘误表 #4）：建店铺的唯一入口是
`auth.service.ts` 的 `registerMerchant`（商家注册时建第一个店铺），
那时租户刚创建、还没有套餐，检查必然放行；产品也没有「新增店铺」接口。
⚠️ **不要为此在注册路径上加一条永远放行的死检查** ——
`maxStores` 「只声明不约束」这件事记在 Task 9 的验收清单里。

⚠️ **模块依赖方向**：`coupon` → `billing` 与 `order` → `billing` 同款（单向）。
⚠️ **不要让 `billing` 反过来 import `order` / `coupon`** —— 会循环依赖。

- [ ] **Step 6.5: 在四处业务路径上插入检查**

### 6.6 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing-quota.e2e-spec.ts test/order-discount.e2e-spec.ts test/coupon.e2e-spec.ts
cd api && npm run lint && npm run build
```

预期：全绿。

⚠️ **`order-discount.e2e` 会因为订单多两个字段而需要微调断言** ——
如果它挂了，先看是不是断言里写死了订单对象的形状。

- [ ] **Step 6.6: 跑那三个 e2e 与 lint/build**

### 6.7 提交

```bash
git add api/src/modules/billing api/src/modules/order api/src/modules/product api/src/modules/coupon api/src/modules/tenants api/test/billing-quota.e2e-spec.ts
git commit -m "feat(api): 下单接入抽佣快照、到期拦截与额度权限

下单时把抽佣费率与抽佣额**快照**进订单 —— 改套餐费率不影响已成交订单（M7）。
抽佣基数是实付（订单 totalAmount，已含优惠）。

⚠️ 到期 / 未订阅 → 消费者侧下单被拒（M12），但**只拦下单**：
发货、退款这些必须还能做，否则等于把商家锁死。

⚠️ 额度与功能开关的检查在 service 层（M16）—— 只在 controller 层拦的话，
绕过 controller 直接调 service 就拦不住。
⚠️ 额度与功能开关**实时读当前套餐**（M8），费率是快照 —— 一个是「现在能用多少」，
一个是「当时按多少算的钱」，语义不同。
⚠️ 营销功能关闭时建券被拒（M14），文案要说清是套餐的问题。"
```

---

## Task 7：商家后台的订阅页

**Files:**
- Modify: `api/src/modules/billing/invoice.service.ts`（加 `list`）
- Modify: `api/src/modules/billing/billing.controller.ts`（加 `GET invoices`）
- Modify: `api/src/modules/payment/payment-method.service.ts`（加 `list`）
- Modify: `api/src/modules/payment/subscription-payment.controller.ts`（加 `GET payment-methods`）
- Test: `api/test/billing-list.e2e-spec.ts`
- Create: `merchant-admin/src/lib/billing.ts`
- Create: `merchant-admin/src/app/(dashboard)/billing/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/billing/subscription-panel.tsx`
- Create: `merchant-admin/src/app/api/billing/plans/route.ts`
- Create: `merchant-admin/src/app/api/billing/subscription/route.ts`
- Create: `merchant-admin/src/app/api/billing/invoices/route.ts`
- Create: `merchant-admin/src/app/api/billing/invoices/[number]/pay/route.ts`
- Create: `merchant-admin/src/app/api/billing/payment-methods/route.ts`
- Create: `merchant-admin/src/app/api/billing/payment-methods/[id]/route.ts`
- Create: `merchant-admin/src/app/api/billing/payment-methods/[id]/default/route.ts`
- Modify: `merchant-admin/src/app/(dashboard)/layout.tsx`（导航加「订阅」）
- Test: `merchant-admin/test/app/api/billing-whitelist.test.ts`
- Test: `merchant-admin/test/lib/billing.test.ts`

### 7.0 **先补后端缺的列表端点**（勘误表 #6 / #7）

⚠️ **后端商家侧目前只有三个计费端点**：
`GET /billing/plans`、`GET /billing/subscription`、`POST /billing/subscription`，
加上 `payment` 模块里的 `POST /billing/invoices/:number/pay` 与
`POST/DELETE /billing/payment-methods...`。
⚠️ **没有「账单列表」与「支付方式列表」的 GET** ——
`InvoiceService` 与 `PaymentMethodService` 都只有写的方法。
不补的话，中转路由写出来也是 404，商家后台的页面拿不到数据。

`api/src/modules/billing/invoice.service.ts` 加：

```typescript
  /**
   * 这个租户的账单列表（新的在前）。
   *
   * ⚠️ **租户作用域的 `findMany`** —— 扩展自动附加 tenantId 条件，
   * 不需要自己写 `where: { tenantId }`（写了也一样，但容易漏）。
   */
  async list(tenantId: string): Promise<{ items: Invoice[]; total: number }> {
    const items = await this.prisma.invoice.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items, total: items.length };
  }
```

`api/src/modules/payment/payment-method.service.ts` 加：

```typescript
  /**
   * 这个租户的支付方式列表。
   *
   * ⚠️ **不返回 `token`**（勘误表 #7）：那是渠道给的扣款凭证，
   * 自动续费要拿它去扣款。列表接口把它吐给前端 = 把凭证发到浏览器。
   * 用 `select` 显式挑字段 —— 挑不到就不会漏出去，
   * 写 `omit` 的话将来加字段时容易漏改。
   */
  async list(tenantId: string) {
    const items = await this.prisma.paymentMethod.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        provider: true,
        channel: true,
        type: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { items, total: items.length };
  }
```

控制器各加一个 GET：

```typescript
// billing.controller.ts（商家侧）
  @Get('invoices')
  @ApiOperation({ summary: '本店的账单列表' })
  async listInvoices() {
    return this.invoices.list(this.subscriptions.currentTenantId());
  }
```

```typescript
// subscription-payment.controller.ts（商家侧，payment 模块）
  @Get('payment-methods')
  @ApiOperation({ summary: '本店的支付方式' })
  async listPaymentMethods() {
    const tenantId = this.paymentService.currentTenantId();
    return this.paymentMethods.list(tenantId);
  }
```

⚠️ **`billing.controller.ts` 要注入 `InvoiceService`** ——
`BillingModule` 里已经 providers 了 `InvoiceService`，不用改模块。

- [ ] **Step 7.0: 补后端的两个列表端点**

### 7.1 先写失败测试

`merchant-admin/test/app/api/billing-whitelist.test.ts`（照
`merchant-admin/test/app/api/order-whitelist.test.ts` 的写法）：

| 用例 | 护栏 | 断言 |
|------|------|------|
| 订阅请求体只把 `planId` 发给后端 | M1 | apiFetch 收到的 body 恰好是 `{ planId }` |
| `price` / `commissionBps` / `maxProducts` 不进后端 | M1 / M2 | body 的键集合精确等于 `['planId']` |
| 畸形请求体 → 400 且不调后端 | — | — |
| 未登录 → 401 且不调后端 | — | — |

- [ ] **Step 7.1: 建测试文件，按上表写用例**

### 7.2 跑测试确认失败

```bash
cd merchant-admin && npx vitest run test/app/api/billing-whitelist.test.ts
```

预期：FAIL —— 模块不存在。

### 7.3 写中转路由

`merchant-admin/src/app/api/billing/subscription/route.ts`：

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 订阅的中转。
 *
 * ⚠️ **白名单重建请求体**：只接受 `planId`（护栏 M1 / M2 / M9）。
 * 价格、额度、费率一律由后端从库里读 —— 客户端多传一个 `price`
 * 会被后端 400，而更根本的问题是「客户端算的钱一律不信」。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  const planId = payload.planId;
  if (typeof planId !== 'string' || planId === '') {
    return NextResponse.json(
      { message: 'planId 必须是非空字符串' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch('/billing/subscription', {
      method: 'POST',
      body: { planId },
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

其余路由照 `merchant-admin/src/app/api/categories/route.ts` 的写法
（中转路由不带 `x-tenant-subdomain` —— 中心域名没有「当前店铺」，
租户身份由 accessToken 里的 `tenantId` 决定）。

⚠️ **七个路由与后端端点的对应**（勘误表 #8 —— 计划初稿只列了四个，
但 §7.4 的面板要「去支付」与「支付方式管理」，那几个按钮需要路由）：

| 中转路由 | 方法 | 后端端点 | 请求体白名单 |
|----------|------|----------|--------------|
| `/api/billing/plans` | GET | `GET /billing/plans` | —— |
| `/api/billing/subscription` | GET | `GET /billing/subscription` | —— |
| `/api/billing/subscription` | POST | `POST /billing/subscription` | **只接受 `planId`** |
| `/api/billing/invoices` | GET | `GET /billing/invoices` | —— |
| `/api/billing/invoices/[number]/pay` | POST | `POST /billing/invoices/:number/pay` | **只接受 `channel`**（可选） |
| `/api/billing/payment-methods` | GET | `GET /billing/payment-methods` | —— |
| `/api/billing/payment-methods` | POST | `POST /billing/payment-methods` | **只接受 `type` 与 `channel`** |
| `/api/billing/payment-methods/[id]` | DELETE | `DELETE /billing/payment-methods/:id` | —— |
| `/api/billing/payment-methods/[id]/default` | POST | `POST /billing/payment-methods/:id/default` | —— |

⚠️ **绑定支付方式不接受 `token`** —— token 必须由渠道给，
客户端传 token 的话商家就能绑「不属于自己的」支付方式，续费时扣的是别人的钱。

⚠️ **Next.js 15 的动态路由参数是 Promise**：
`export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> })`
里要 `const { id } = await params;`。

- [ ] **Step 7.3: 写七个中转路由**

### 7.4 写前端类型与页面

`merchant-admin/src/lib/billing.ts`：类型（`Plan` / `Subscription` / `Invoice`）
+ 展示用的纯函数（`describeSubscriptionStatus`、`describeInvoiceStatus`）。

⚠️ **纯函数要能被单测** —— 但 merchant-admin 的 vitest 只收 `test/**/*.test.ts`
（不含 `.tsx`）。纯函数放 `src/lib/billing.ts` 就能被 `test/lib/billing.test.ts` 测到。

`merchant-admin/src/app/(dashboard)/billing/page.tsx`（Server Component）：
服务端取「套餐列表 + 当前订阅 + 账单 + 支付方式」，把数据传给客户端组件。

`merchant-admin/src/app/(dashboard)/billing/subscription-panel.tsx`（客户端组件）：
页签切换 + 「开通套餐」+ 「去支付」+ 支付方式管理。

⚠️ **逻辑内嵌在组件内部**，不从 Server Component 往下传回调
（Server → Client 传函数在 tsc 与 next build 下都能过，只有真正渲染才 500）。

- [ ] **Step 7.4: 写 `lib/billing.ts` 与两个页面组件**

### 7.5 跑检查

```bash
cd merchant-admin && npm test && npm run lint && npm run build
```

预期：全绿。

- [ ] **Step 7.5: 跑三条命令**

### 7.6 提交

```bash
git add merchant-admin/
git commit -m "feat(merchant-admin): 订阅页

商家后台加「订阅」页：当前订阅、套餐列表、账单、支付方式。

⚠️ 中转路由按白名单重建请求体：订阅只接受 planId，价格与额度字段一律丢弃——
客户端算的钱一律不信（M1/M2/M9）。"
```

---

## Task 8：平台侧的后端接口 + 报表 / 订阅 / 套餐三页 + 测试基建

**Files:**
- Create: `api/src/modules/billing/platform-report.controller.ts`（平台的订阅列表与报表）
- Create: `api/src/modules/billing/report.service.ts`（报表的聚合）
- Create: `platform-admin/vitest.config.ts`（搬 storefront 的）
- Create: `platform-admin/test/setup.ts`（搬 storefront 的）
- Create: `platform-admin/test/stubs/server-only.ts`（搬 storefront 的）
- Create: `platform-admin/src/lib/billing.ts`
- Create: `platform-admin/src/app/(dashboard)/plans/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/plans/plan-form.tsx`
- Create: `platform-admin/src/app/(dashboard)/subscriptions/page.tsx`
- Create: `platform-admin/src/app/(dashboard)/reports/page.tsx`
- Create: `platform-admin/src/app/api/billing/**/route.ts`
- Modify: `platform-admin/src/app/(dashboard)/layout.tsx`（导航加三项）
- Test: `api/test/billing-report.e2e-spec.ts`
- Test: `platform-admin/test/lib/billing.test.ts`
- Test: `platform-admin/test/app/api/billing-whitelist.test.ts`

### 8.1 先写失败测试

`api/test/billing-report.e2e-spec.ts`（新建）：

| 用例 | 护栏 | 断言 |
|------|------|------|
| 报表的订阅收入 = 已付账单之和 | — | 造 2 张已付账单 + 1 张未付 → 只算 2 张 |
| 报表的抽佣收入 = 已支付订单的抽佣之和 | — | 造 2 笔已支付订单 |
| **抽佣收入包含已发货与已完成的订单（不只 PAID）** | — | `PAID` / `SHIPPED` / `COMPLETED` 三态都算 |
| **已退款的订单仍进抽佣收入（按 `paidAt`），冲回行把它抵掉** | M8 | 抽佣收入是**毛额**（含那笔退款的），冲回 = 那笔订单的 `commissionAmount`；两者相抵后**该单对本期净贡献为 0** |
| **跨窗口：支付期记收入、退款期记冲回，两期净额为 0** | — | 支付窗口的抽佣收入照记，退款窗口只记冲回；两块窗口的净贡献合起来为 0 |
| 净收入 = 订阅收入 + 抽佣收入 − 冲回 | — | 三个数对得上 |
| **报表是平台维度的** | — | A 商家与 B 商家的数据进同一份报表 |
| **平台超管看别家租户的订阅 → 那是他的职责；但商家不能看别家的** | M17 | 商家账号调 `GET /platform/subscriptions` → 403；调 `GET /platform/reports` → 403 |
| 没登录 → 401 | — | 两个端点都是 |
| 区间非法（`from >= to`）→ 400 | — | 相等也当非法 |
| `from` 格式非法 → 400 | — | DTO 的 `@IsDateString()` 挡掉 |
| 缺省区间 = 最近 30 天 | — | `from` / `to` 有值且相差 30 天 |
| **平台超管的订阅列表能看到别家租户的订阅** | — | 两个商家的订阅都在列表里 |

⚠️ **每个用例要用**互不重叠**的时间区间**：报表是**平台维度**的聚合，
它统计的是「区间内所有租户的所有订单」。用例之间共享一个区间的话，
前一个用例造的数据会被后一个用例的断言算进去，
断言只能写成「比基线多多少」—— 那样测的就不是「算得对不对」，
而是「差值算得对不对」，基数一变就飘。
各自独立的区间让每个用例都能断言**绝对值**，这才是真正在测聚合逻辑。

- [ ] **Step 8.1: 建 `api/test/billing-report.e2e-spec.ts`，按上表写用例**

### 8.2 跑测试确认失败

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing-report.e2e-spec.ts
```

预期：FAIL。

### 8.3 写报表的聚合

`api/src/modules/billing/report.service.ts`：

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import { InvoiceStatus, OrderStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../../common/tenant/tenant-context';

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

/** 缺省报表区间：最近 30 天 */
const DEFAULT_WINDOW_DAYS = 30;

/** 平台收入报表的四个数（金额一律整数分） */
export interface ReportSummary {
  from: Date;
  to: Date;
  subscriptionRevenue: number;
  commissionRevenue: number;
  reversal: number;
  netRevenue: number;
}

/**
 * 平台收入报表。
 *
 * ⚠️ **抽佣不建独立表**（设计文档 §九的取舍）→ 抽佣的两个数要**跨订单聚合**。
 * 这正是那个取舍的代价：SQL 会长一点，但少一张表与一套生命周期。
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 按时间区间出报表。
   *
   * ⚠️ **必须显式走平台作用域**（跨租户聚合）：
   * 控制器虽然挂了 `@Roles(PLATFORM_ADMIN)`，但那管的是「谁能调」，
   * 管不了「service 在什么作用域里查库」。不显式声明的话，
   * 这个方法被商家上下文调用时会**静默只统计一个租户的数据**。
   *
   * ⚠️ **`run()` 的回调必须是 async 函数**：Prisma 6 的 PrismaPromise
   * 是 thenable 而非原生 Promise，同步回调会让 AsyncLocalStorage 上下文
   * 在查询真正执行的那一刻丢失，租户隔离会**静默失效**。
   */
  async summary(input: { from?: Date; to?: Date }): Promise<ReportSummary> {
    const { from, to } = await this.resolveWindow(input);

    // ⚠️ **区间必须非空**：`from >= to` 的区间算不出任何东西，
    // 与其返回一串 0 让调用方以为「这段时间没收入」，不如响亮地报错。
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('区间非法：from 必须早于 to');
    }

    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **订阅收入** = 区间内**已付**账单的金额之和。
      const subscriptionAggregate = await this.prisma.invoice.aggregate({
        where: {
          status: InvoiceStatus.PAID,
          paidAt: { gte: from, lt: to },
        },
        _sum: { amount: true },
      });

      // ⚠️ **抽佣收入** = 区间内**已支付**订单的抽佣快照之和。
      //
      // ⚠️ **只看 `paidAt`，不看 status**：抽佣是**支付时定下的快照**
      // （`Order.commissionAmount`），钱收进来就赚到了这笔抽佣，
      // 与后来退没退款**无关** —— 退款是另一个时点上的另一件事，
      // 由下面的冲回行单独表达。
      //
      // ⚠️ **按 status 筛会造出凭空的负收入**：订单在 P 支付、P+1 退款时，
      // P 的抽佣行会因为 status 变成 REFUNDED 而漏掉它，
      // P+1 的冲回行又照记 —— 两期合起来净额是 −500，而真相是 0。
      // 同窗口支付且退款更糟：净贡献 −500（真相是 0）。
      //
      // `paidAt` 非空本身就等价于「这笔单收过钱」：
      // PENDING_PAYMENT / CANCELLED / CLOSED 的订单 paidAt 都是 null，
      // `gte`/`lt` 对 null 不匹配，天然被排除。
      const commissionAggregate = await this.prisma.order.aggregate({
        where: {
          paidAt: { gte: from, lt: to },
        },
        _sum: { commissionAmount: true },
      });

      // ⚠️ **退款冲回** = 区间内**已退款**订单当初抽了多少。
      //
      // ⚠️ **抽佣收入是毛额（gross）**：区间内收过钱的订单的抽佣之和，
      // **包含后来退款的那些**。冲回是区间内退款要还回去的部分。
      // 净收入 = 订阅收入 + 抽佣收入 − 冲回。
      // 一笔单无论退没退款，全周期净贡献都是对的：
      // 退了就是 +抽佣（支付期）−抽佣（退款期）= 0。
      //
      // ⚠️ **按退款期间归期，不按支付期间**：一笔在 1 月支付、3 月退款的订单，
      // 3 月的账上要有那笔冲回 —— 否则 3 月的账会把「白拿的抽佣」算成收入。
      const reversalAggregate = await this.prisma.order.aggregate({
        where: {
          status: OrderStatus.REFUNDED,
          refundedAt: { gte: from, lt: to },
        },
        _sum: { commissionAmount: true },
      });

      // ⚠️ **`_sum` 的键必须与字段名逐字一致**：写 `_sum: { commissionAmount: true }`
      // 就要读 `_sum.commissionAmount`。读成 `_sum.amount` 拿到的是 undefined，
      // `?? 0` 之后永远是 0 —— **数字全错却不报错**。
      const subscriptionRevenue = subscriptionAggregate._sum.amount ?? 0;
      const commissionRevenue = commissionAggregate._sum.commissionAmount ?? 0;
      const reversal = reversalAggregate._sum.commissionAmount ?? 0;

      return {
        from,
        to,
        subscriptionRevenue,
        commissionRevenue,
        reversal,
        netRevenue: subscriptionRevenue + commissionRevenue - reversal,
      };
    });
  }

  /**
   * 定出报表的区间。
   *
   * ⚠️ **时间用数据库的时钟**（护栏 M15）：多副本部署时各机器的时钟有偏差，
   * 边界时刻会摇摆。数据库的 `now()` 是单一事实来源。
   *
   * ⚠️ **缺省窗口在这里算，不在 DTO 里**：DTO 只负责解析，
   * 这样默认窗口与显式传入的窗口用**同一个时钟来源**。
   */
  private async resolveWindow(input: {
    from?: Date;
    to?: Date;
  }): Promise<{ from: Date; to: Date }> {
    // ⚠️ **只在真的需要 `now` 时才查库**：`from` 与 `to` 都显式传入时
    // `now` 根本用不到，那次 DB 往返是白跑的。
    const to = input.to ?? (await this.prisma.databaseNow());
    const from =
      input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);

    return { from, to };
  }
}
```

⚠️ **`Order.refundedAt` 由 Task 1 加的** —— 阶段 3 的退款没记时间，
报表的「退款冲回」要按退款发生的期间归期，所以 Task 1 已经加了字段。
**但退款路径还没写它** —— 本 Task 顺手补上（`payment.service.ts` 的退款方法）：

```typescript
    // ⚠️ **退款时间用数据库的时钟**（护栏 M15，与本仓库其它地方一致）：
    // 多副本部署时各机器的时钟有偏差，边界时刻会摇摆。
    const refundedAt = await this.prisma.databaseNow();

    await this.prisma.$transaction(
      async (tx) => {
        // ⚠️ **顺手记下退款时间**（Task 1 加的 `Order.refundedAt`）：
        // 报表的「退款冲回」要按**退款发生的期间**归期，
        // 不是按订单支付的期间。阶段 3 的退款没记这个时间。
        const won = await this.orderService.transitionInTx(
          tx,
          order.id,
          order.status,
          OrderStatus.REFUNDED,
          { refundedAt },
        );
        // ...
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
```

⚠️ **`transitionInTx` 的第 5 个参数就是写进订单的额外字段** ——
`data: { status: to, ...extra }`，所以传 `{ refundedAt: ... }` 即可。

- [ ] **Step 8.3: 写 `report.service.ts`，并在退款路径上补写 `refundedAt`**

### 8.4 写平台的控制器

`api/src/modules/billing/platform-report.controller.ts`：

```typescript
/**
 * 平台超管的订阅列表与报表。
 *
 * ⚠️ **路径带 `platform/` 前缀** —— 与阶段 5b 的 `platform/plans` 同款理由：
 * 消费者侧与平台侧的鉴权方式根本不同，同一条路径上挂两套守卫时，
 * NestJS 按注册顺序匹配，先注册的那套会把另一套**整个遮住**。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：商家账号调这些接口要 403（护栏 M17）。
 * `@Roles` 装饰器自带 `JwtAuthGuard`，未登录得 401。
 */
@ApiTags('platform-billing')
@Controller('platform')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformReportController {
  constructor(private readonly reports: ReportService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: '跨租户的订阅列表' })
  async subscriptions() {
    return this.reports.listSubscriptions();
  }

  @Get('reports')
  @ApiOperation({ summary: '平台收入报表（缺省最近 30 天）' })
  async report(@Query() query: ReportQueryDto) {
    // ⚠️ **DTO 的 `@IsDateString()` 已经挡掉了非法格式**，
    // 所以这里拿到的都是合法的 ISO 字符串 —— `new Date()` 不会得到 Invalid Date。
    return this.reports.summary({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }
}
```

`ReportQueryDto` 的 `from` / `to` 用 `@IsDateString()`（ISO 字符串），
两个都可选；**缺省是「最近 30 天」**。

⚠️ **DTO 里不要放默认值**：默认窗口要用**数据库的时钟**算（护栏 M15），
而 DTO 是在请求解析阶段构造的，那时拿不到数据库时钟 ——
所以「缺省最近 30 天」的判定放在 service 层，
让默认窗口与显式传入的窗口用**同一个时钟来源**。

⚠️ **跨租户的订阅列表要分开查再合并**：`Subscription.planId` 与
`Subscription.tenantId` **都不是 Prisma 关系**（订阅表只有 `planId` 纯标量，
也没有声明 `tenant` 关系），所以 `include: { tenant: true }` 写不出来。
`Tenant` 与 `Plan` **都不在** `TENANT_SCOPED_MODELS` 白名单里，任何作用域都能查。
⚠️ **查不到就回落到 id 本身**（套餐被硬删时也要让超管看到这一行），
而不是让整行消失 —— 否则超管看到的订阅总数会莫名其妙对不上账。

- [ ] **Step 8.4: 写 `platform-report.controller.ts` 与 `ReportQueryDto`**

### 8.5 跑测试

```bash
cd api && npx jest --config ./test/jest-e2e.json --runInBand test/billing-report.e2e-spec.ts
cd api && npm run lint && npm run build
```

预期：全绿。

- [ ] **Step 8.5: 跑那条 e2e 与 lint/build**

### 8.6 搬测试基建

⚠️ **platform-admin 至今没有任何单元测试**（README 已注明）。
5b 要给它加三个页 → **必须先搬 storefront 的基建**，否则这些页面的逻辑
一行都测不了。

从 `storefront/` 复制这三个文件并改路径别名（`@/` → `platform-admin/src`）：

| 从 | 到 |
|---|---|
| `storefront/vitest.config.ts` | `platform-admin/vitest.config.ts` |
| `storefront/test/setup.ts` | `platform-admin/test/setup.ts` |
| `storefront/test/stubs/server-only.ts` | `platform-admin/test/stubs/server-only.ts` |

⚠️ **逐文件 jsdom 的规则照抄**：组件测试文件第一行写
`// @vitest-environment jsdom`，**不要**改全局环境。

⚠️ **`include` 要扩到 `.tsx`**：storefront 的配置是
`include: ['test/**/*.test.{ts,tsx}']`；platform-admin 原本是
`['test/**/*.test.ts']` —— 组件测试要 `.tsx`，所以照 storefront 的写。

- [ ] **Step 8.6: 搬三个文件并对齐 `package.json` 的 test 脚本**

### 8.7 写前端的测试

`platform-admin/test/lib/billing.test.ts`：金额与状态的展示纯函数。

`platform-admin/test/app/api/billing-whitelist.test.ts`：
平台侧的创建套餐请求体白名单 —— **`price` / `commissionBps` / `features` 要放行**
（平台超管**就是**配这些的人），但 `tenantId` **不放行**
（套餐是平台的数据，不带 tenantId）。

- [ ] **Step 8.7: 写两个测试文件**

### 8.8 写三个页面

- `/plans`：套餐列表（名称、价格、周期、试用期、费率、额度、状态）+ 新建 + 编辑 + 上下架
- `/subscriptions`：订阅列表（租户、套餐、状态、周期、到期、费率）
- `/reports`：按时间范围看「订阅收入 / 抽佣收入 / 退款冲回 / 净收入」

⚠️ **报表的三个数**由后端算（Step 8.3），前端**只展示**，不自己算 ——
与结算页的金额同款原则（客户端算的钱一律不信）。

- [ ] **Step 8.8: 写三个页面与它们的中转路由**

### 8.9 跑检查

```bash
cd platform-admin && npm test && npm run lint && npm run build
```

预期：全绿。

- [ ] **Step 8.9: 跑三条命令**

### 8.10 提交

```bash
git add api/src/modules/billing api/test/billing-report.e2e-spec.ts platform-admin/
git commit -m "feat(platform): 收入报表接口与套餐 / 订阅 / 报表三页

报表的四个数由后端算：订阅收入、抽佣收入、退款冲回、净收入。
⚠️ 抽佣不建独立表 → 抽佣的两个数要跨订单聚合（设计文档 §九的取舍的代价）。

⚠️ 顺手把 storefront 的测试基建搬过来 —— platform-admin 至今没有任何
单元测试（阶段 4 的遗留项），这三个页面的逻辑一行都测不了。

⚠️ 创建套餐的请求体**要**放行 price / commissionBps / features
（平台超管就是配这些的人），但 tenantId **不放行** —— 套餐是平台的数据，
不带 tenantId。"
```

---

## Task 9：阶段 5b 验收

**Files:**
- Create: `docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md`
- Modify: `README.md`

### 9.1 浏览器手测

**环境注意**（阶段 2b / 3 / 4 / 5a 都栽过）：

- 3001–3003 端口是**旧构建的容器**，不含阶段 5b 的功能。
  本地 dev 用 **3011**（storefront）/ **3016**（merchant-admin）/
  **3017**（platform-admin），启动前先 `rm -rf .next`。
- **不要在旧容器上测** —— 阶段 2b 有两次「实测报缺陷、复现不出来」，
  根因都是测了旧镜像。

**测试账号**：商家 `owner@demo.platform.test` / `Demo12345!`；
消费者 `customer@demo.platform.test` / `Demo12345!`；
平台超管 `admin@platform.test` / `Admin12345!`。

| # | 场景 | 预期 |
|---|------|------|
| 1 | 平台超管建一个套餐 | 出现在商家能订阅的列表里 |
| 2 | 商家订阅它 | 订阅页显示「试用中」与到期时间；**订单里的抽佣快照**用的是这个套餐的费率 |
| 3 | 领券 / 用券 | 试用套餐的 `features.marketing = false` → 建券被拒；升级到有营销功能的套餐后可以 |
| 4 | 结算页下单 | 订单详情显示商品原价与实付（实付 = 原价 − 抽佣？不 —— **抽佣不是商家付的钱**，见下） |
| 5 | 改套餐的费率 | **历史订单的抽佣快照不变** |
| 6 | 试用到期 | 商家后台仍可用（发货、退款都行）；**消费者侧下单被拒** |
| 7 | 绑定支付方式后到期 | 账单自动生成并自动扣款；订阅期延长 |
| 8 | 没有支付方式时到期 | 账单生成了但没扣；商家手动「去支付」后延长 |
| 9 | 平台后台的报表 | 订阅收入、抽佣收入、冲回、净收入四个数与库里对得上 |

> ⚠️ **第 4 条的提醒**：抽佣是**平台从商家订单里抽走的部分**，
> 它**不是**商家付给平台的订阅费，也不影响消费者的实付。
> 消费者的实付 = 商品原价 − 优惠（与阶段 5a 一样）。
> 抽佣只出现在**平台后台的报表**与**订单的抽佣快照字段**上。

- [ ] **Step 9.1: 逐条走完上表 9 个场景，把实测看到的东西填进验收记录**

### 9.2 失败注入（恒真自检）

**17 项护栏逐项做**。做法照阶段 5a：

1. 改坏一处护栏
2. 跑对应测试，**确认它真的失败**
3. 改回来
4. 复跑确认通过

| 护栏 | 注入形态 | 预期挂掉的测试 |
|------|---------|--------------|
| M1 | 订阅 DTO 加 `price` 字段并优先用它 | Task 4 的「M1」用例 |
| M2 | 订阅 DTO 加 `commissionBps` 字段并优先用它 | Task 4 的「M2」用例 |
| M3 | 商家的订阅接口不查 `status = ACTIVE` | Task 4 的「下架套餐」用例 |
| M4 | 订阅的 `@@unique([tenantId])` 去掉 + 去掉「已有就返回」 | Task 4 的「重复开通」用例 |
| M5 | 去掉 `@@unique([subscriptionId, periodStart])` | Task 5 的「同一周期两张账单」用例 |
| M6 | 引擎去掉封顶（`Math.min(raw, payableAmount)`） | Task 3 的「⚠️ 费率高于 100% 也封顶到实付」用例（⚠️ **不是**「面额大的费率…」那条 —— 它的 `rateBps: 10000` 恰好等于封顶值，数学上探测不到，见勘误第 18 条） |
| M7 | 下单时不快照费率（每次实时读） | Task 6 的「改费率不影响历史订单」用例 |
| M8 | 额度改成订阅时快照（存在订阅行上） | Task 6 的「改额度立刻生效」用例 |
| M9 | 账单的金额从请求体读 | Task 4/5 的「账单金额 = 套餐价」用例 |
| M10 | 回调的金额核对去掉 | Task 5 的「金额不符被拒」用例 |
| M11 | `markInvoicePaid` 去掉 `status = OPEN` 条件 | Task 5 的「重复回调只延长一次」用例（⚠️ **实测没挂** —— `markInvoicePaidInTx` 写的是 `currentPeriodEnd: invoice.periodEnd`（**绝对值**），天然幂等，那条 `status` 条件在当前实现下**观测不到**；护栏本身由 webhook 层的幂等闸兜住。详见验收记录 §四·M11） |
| M12 | 下单不查订阅状态 | Task 6 的「到期后下单被拒」用例 |
| M13 | 额度检查去掉 | Task 6 的「超额被拒」用例 |
| M14 | 功能开关缺省改成 true | Task 6 的「营销关闭时建券被拒」用例 |
| M15 | 到期判定用 `new Date()` | `api/test/billing-quota.e2e-spec.ts` 的「M15：到期判定用数据库时钟」（⚠️ **这条测试原本不存在** —— 阶段 5b 没有到期判定的时钟用例，已在验收时按阶段 5a 的 `freezeAppClock` 补上，见验收记录 §一） |
| M16 | 额度检查从 service 挪到 controller | Task 6 的「绕不过 controller」用例 |
| M17 | 平台的订阅列表不按租户过滤 | Task 4 的「平台越权」用例 |

> ⚠️ **M15 的注入预期**：把数据库时钟换成 `new Date()` 后，在本机上两个时钟
> 几乎一样，**测试可能不会挂**。照阶段 5a 的做法：把**应用时钟冻到 2019 年**
> （两个钟差 7 年），注入就必然分叉。**要确保测试真的挂了**——
> 如果没挂，说明这条护栏**没有测试覆盖**，要在验收记录里
> **如实写「这条没测到」**，不要含糊过去。

- [ ] **Step 9.2: 逐项做 17 条失败注入，记下结果**

### 9.3 容器化验证

```bash
cd infra && docker compose build && docker compose up -d
```

七个服务全部起来。公开接口要用店铺子域名访问。

- [ ] **Step 9.3: 重建镜像并起全部容器**

### 9.4 写验收记录

`docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md`，结构照
`2026-10-25-plan-05a-acceptance.md`：

1. 自动化测试结果
2. 容器化验证
3. 手动验收场景（**填实测看到的东西**，不写「正常」）
4. **机制级验证（失败注入）表** —— 17 项护栏逐项，这是重点
5. 交付物清单
6. **已知遗留项**（诚实列出没测到的、没覆盖的）
7. 下一阶段（5c：修阶段 4 的技术债）

- [ ] **Step 9.4: 写验收记录**

### 9.5 更新 README 与记忆

- README 的「当前进度」与「后续计划」
- 记忆里 `project_plan04_execution.md` 更新进度与新踩的坑

- [ ] **Step 9.5: 更新 README 与记忆**

### 9.6 提交

```bash
git add docs/ README.md
git commit -m "docs: 阶段 5b 验收记录与收尾"
```

---

## 附：Task 与护栏的对应表

| Task | 覆盖的护栏编号 | 关键产出 |
|------|--------------|---------|
| 1 | —（白名单登记本身是 fail-fast） | 4 张新表 + `payments` 泛化 + 2 个快照字段 + 3 个 getter + 2 条手写部分唯一索引 |
| 2 | —（重构，不改行为） | `PaymentProvider` 泛化 + `chargeAuthorized` + 两个 webhook 端点 |
| 3 | M6 | 抽佣纯函数（整数域 + 封顶） |
| 4 | M1 / M2 / M3 / M4 / M9 / M17 | 套餐与订阅的 service + 商家侧与平台侧控制器 |
| 5 | M5 / M9 / M10 / M11 / M15 | 账单、续费扫描、订阅付款的 webhook |
| 6 | M7 / M8 / M12 / M13 / M14 / M15 / M16 | 抽佣快照、到期拦截、额度与功能权限 |
| 7 | M1（前端侧） | 商家后台的订阅页 + 白名单中转 |
| 8 | M1 / M2（平台侧） | 平台超管的三页 + 测试基建 |
| 9 | 全部 17 项 | 失败注入的逐项验证 |

## 附：本计划相对设计文档的**实施层决策**（不改设计，只定细节）

1. ⚠️ **模块依赖不能成环 —— 这决定了目录划分**（§0.4）：
   阶段 3 已有 `payment → order`，5b 的下单要查订阅 → `order → billing`。
   若 `billing` 再依赖 `payment`，就成了 `order → billing → payment → order`
   的环，NestJS 启动直接报错。
   **所以：凡是要碰支付渠道的事一律在 `payment` 模块**，
   `billing` 只管账目与权益，两者之间**只允许 `payment → billing` 一个方向**。
   「续费的每日扫描」因此也放在 `payment` 模块（它要调渠道）。
2. **`Plan` 不带 `tenantId`** —— 设计文档 §3.1 已定（平台的数据不是租户的数据）。
   连带：`Plan` **不登记**进 `TENANT_SCOPED_MODELS`（不带 `tenantId` 的表天然不在扩展作用域里）。
3. **`Payment` 与 `Invoice` 同租户 → 真关系**；`Payment` 与 `Order` 同租户 → 真关系；
   `Subscription.planId` / `Invoice.planId` **跨域 → 纯标量**。
4. **`chargeAuthorized` 同步返回结果**，不跳页面 —— 真实渠道的 off-session charge 同款。
   自动续费走这条（同步），手动续费走 webhook。
5. **webhook 分成两个端点**（`/webhooks/payment` 与 `/webhooks/subscription`），
   分流点由**端点本身**决定 —— 渠道适配器不需要猜「这笔是什么」。
6. **账单的生成时机是「周期开始前 3 天」**，定时任务**每天**跑一次。
   试用期的账单不生成，但下一个付费周期的账单在试用结束前 3 天生成。
7. **没有订阅 → 不做额度限制**（额度是套餐给的）；但**没有订阅 → 不能接新单**。
8. **额度检查插在四处业务路径**（商品 / SKU / 店铺 / 营销），全部在 service 层。
9. **账单号服务端生成**（`INV` + 时间戳 + 4 位随机数），客户端不能指定。
10. **`plan` 的 `features` 用 Json，额度用可空的具体列** ——
    额度要在业务路径上强制执行，具体列能被编译期发现漏判。
11. **`TenantStatus` 的 `TRIAL` 值用 `RENAME VALUE` 改成 `ACTIVE`** ——
    RENAME 保留了列默认值里对该值的引用（DROP 会让默认值失效）。
12. ⚠️ **`Order` 加 `refundedAt` 字段** —— 阶段 3 的退款**没记时间**，
    而报表的「退款冲回」要按**退款发生的期间**归期。退款路径要顺手写上
    （`transitionInTx` 的第 5 个参数就是写进订单的额外字段）。
13. **「有没有服务」的判定抽成纯函数**（`subscription-state.ts` 的 `hasService`）——
    它是业务里最常被改坏的一段，必须能被单独断言。
14. **支付方式的绑定接口也在 `payment` 模块** —— 绑定要调 provider 的
    `createPaymentMethod`（拿渠道给的授权凭证，客户端不能自己传 token）。

