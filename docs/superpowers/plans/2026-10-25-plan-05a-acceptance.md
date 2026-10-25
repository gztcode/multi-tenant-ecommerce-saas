# 阶段 5a 验收记录

验收日期：2026-10-25
验收范围：计划 5a「营销（优惠券与满减活动）」的 Task 1–8
（`docs/superpowers/plans/2026-10-25-plan-05a-marketing.md`）
分支：`gzt/电商项目`

结论：**有条件通过** —— 自动化测试全绿；浏览器手测 12 个场景**全部通过**；
17 项护栏的失败注入里 **16 项确认抓到**、**1 项（M17）是手测项**，
其中 **M14 原先没测到**，已在本次验收补上断言并复验；
手测与注入过程中发现并修复了 **2 个真 bug**
（活动的选取没按门槛过滤；商家后台删除券/活动的中转返回 502 而删除其实成功了）。
另有 **1 个能力缺口**：平台超管创建平台券**没有前端入口**（后端接口有）。
详见 §三、§四、§五、§六。

---

## 一、自动化测试结果

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端单元测试 | `cd api && npm test` | 全部通过 | **132 passed / 132 total**（5 个套件） |
| 后端 e2e | `cd api && npm run test:e2e` | 全部通过 | **395 passed / 395 total**（21 个套件） |
| 前端单测（storefront） | `cd storefront && npm test` | 全部通过 | **175 passed / 175 total**（18 个文件） |
| 前端单测（merchant-admin） | `cd merchant-admin && npm test` | 全部通过 | **114 passed / 114 total**（11 个文件） |
| 后端类型检查 | `cd api && npx tsc --noEmit` | 无错误 | 通过（exit 0） |
| 后端 lint | `cd api && npm run lint` | 0 error | **2 error** —— 只有 `api/test/media.e2e-spec.ts` 的 `609:41` 与 `618:42`（**阶段 2 遗留，未动**） |
| storefront lint / build | `npm run lint` / `npm run build` | 0 error / 成功 | 0 error / 编译成功 |
| merchant-admin lint / build | `npm run lint` / `npm run build` | 0 error / 成功 | 0 error / 编译成功 |

21 个 e2e 套件：`health` / `errors` / `auth` / `rbac` / `stores` / `tenancy` /
`tenant-isolation` / `catalog` / `catalog-public` / `media` / `inventory` /
`cart` / `inventory-reserve` / `order` / `order-timeout` / `payment` / `address` /
`coupon` / `coupon-preview` / `coupon-release` / `order-discount`。

**本阶段新增的测试文件**：

- `api/test/coupon.e2e-spec.ts`（Task 3：领取与并发限额）
- `api/test/order-discount.e2e-spec.ts`（Task 4：下单接入优惠 + 预占核销，29 条）
- `api/test/coupon-release.e2e-spec.ts`（Task 5：取消与超时释放）
- `api/test/coupon-preview.e2e-spec.ts`（Task 6 补充：优惠预览，24 条）
- `api/src/modules/coupon/discount-engine.spec.ts`（Task 2：优惠引擎纯函数）
- `storefront/test/lib/coupon.test.ts`（23 条）
- `storefront/test/app/api/coupon-whitelist.test.ts`（17 条）
- `storefront/test/components/coupon/coupon-list.test.tsx`（8 条）
- `merchant-admin/test/lib/money.test.ts`（9 条）
- `merchant-admin/test/app/api/coupon-whitelist.test.ts`（23 条）

**验收时补的两条覆盖**（失败注入发现的缺口，见 §四 M14）：

- `api/test/order-discount.e2e-spec.ts` 的「M14：核销失败时订单也不该建出来（同生共死）」
  补了两条断言：第二单失败后 `reservedCount` 仍为 1、RESERVED 核销行仍为 1 行。
- 同文件新增「M16：多个活动同时生效：门槛已达的优先，哪怕它的减免额更小」
  （锁住 §五 修的那个 bug）。

> ⚠️ **e2e 跑之前要停掉连着同一个 Redis 的 api 容器**（阶段 3 踩过的坑）：
> 容器里的 webhook worker 与超时 worker 也在消费同一个队列，
> 容器连开发库、测试连测试库，于是容器抢走测试投的任务，测试超时失败。

---

## 二、容器化验证

```bash
cd infra && docker compose build && docker compose up -d
```

**七个服务全部起来**：

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

**公开接口实测**（店铺子域名走 `x-tenant-subdomain`）：

| 请求 | 实测 | 说明 |
|------|------|------|
| `GET /api/v1/health` | 200 | api 容器 healthy |
| `GET /api/v1/coupons/available` | 401 | 路由存在（消费者侧整组挂 JwtAuthGuard） |
| `GET /api/v1/coupons/preview?originalAmount=100` | 401 | 同上 |
| `GET /api/v1/merchant/coupons` | 401 | 商家侧路由存在 |
| `GET localhost:3001/coupons` | 307 → /login | **领券中心页面在新镜像里**（未登录被跳登录页） |
| `GET localhost:3002/login` | 200 | 商家后台 |

**容器版 storefront 的浏览器实测**（`localhost:3001`，登录消费者后访问 `/coupons`）：

```
领券中心
可领取（2）
我的券（1）
复用码的新券   减 ¥3.00，满 ¥10.00 可用   有效期至 2026-12-31 · 不限量   [立即领取]
满100减10     减 ¥10.00，满 ¥100.00 可用  有效期至 2026-12-31 · 剩余 98 张  [立即领取]
```

⚠️ **本机 dev 的前端一律用 3011 / 3016，不要测 3001 / 3002 的旧镜像** ——
但**容器化验证这一节就是要测镜像**，所以这里重建了镜像再测。

---

## 三、浏览器手测（12 个场景）

**环境**：storefront dev 3011、merchant-admin dev 3016（启动前 `rm -rf .next`）；
api 跑在 3000。**测试账号**：商家 `owner@demo.platform.test` / `Demo12345!`，
消费者 `customer@demo.platform.test` / `Demo12345!`。

| # | 场景 | 实测 |
|---|------|------|
| 1 | 商家后台新建一张满 100 减 10 的券 | 券出现在列表里：`满100减10 SAVE10 减 ¥10.00，满 ¥100.00 可用 · 进行中` |
| 2 | 商家后台新建一个满 200 减 30 的活动 | 活动出现在列表里：`满200减30 减 ¥30.00，满 ¥200.00 可用 · 进行中` |
| 3 | 前台领券中心 | 能看到可领的券（`可领取（1）`），带面额、门槛、有效期、剩余张数 |
| 4 | 点「立即领取」 | 提示「领取成功，结算时就能用这张券」，「我的券（1）」，剩余张数 100 → 99 |
| 5 | 结算页（购物车金额 ≥ 券门槛） | 四行金额显示正确，券在下拉里可选 |
| 6 | 选券后提交订单 | 订单详情的实付 = 原价 − 券减免 |
| 7 | 券码重复 | **软删后复用成功**（部分唯一索引只约束未删除的行）；未删除时复用被拒，提示「券码 已被占用，换一个再试」 |
| 8 | 取消未支付订单 | **券能再次使用**：核销 `RESERVED → RELEASED`，`reservedCount` 1 → 0，「我的券」从「已用完」变回「可用」 |
| 9 | 领一张限 1 张的券，领第二次 | 被拒，提示「你已达到该优惠券的限领张数」 |
| 10 | 结算页把金额改到低于券门槛 | 券在下拉里**置灰不可选**：「满100减10（未满 ¥100.00 门槛）」；金额区只剩原价与实付两行 |
| 11 | 支付成功后看「我的券」 | 券变成「已用完」；库里 `reservedCount=0 / usedCount=1`，核销记录 `RESERVED → USED` |
| 12 | 活动生效期间下单 | 订单里有活动减免，活动与券叠加 |

### 场景 5 / 6 的实测金额

结算页（购物车 ¥1620，券「满100减10」，活动「满200减30」）：

```
商品原价        ¥1620.00
活动减免（满200减30）  -¥30.00
优惠券          -¥10.00
实付金额        ¥1580.00
金额由服务端按下单时的 SKU 价格计算，页面上的数字不是最终金额，以提交时为准。
```

下单后订单详情页（服务端实算）：

```
商品原价        ¥1620.00
活动减免        -¥30.00
优惠券          -¥10.00（满100减10）
应付金额        ¥1580.00
```

**库里的快照与计数**（M12 / M14）：

```sql
select code, "claimedCount", "reservedCount", "usedCount" from coupons;
--  SAVE10 | 1 | 1 | 0
select status, "discountAmount" from coupon_redemptions;
--  RESERVED | 1000
select "orderNo", "originalAmount", "promotionDiscountAmount",
       "couponDiscountAmount", "couponName", "totalAmount" from orders;
--  20261025-l9g75ekcii | 162000 | 3000 | 1000 | 满100减10 | 158000
```

### ⚠️ 手测时踩到的三个环境坑

1. **本机两个前端同域共用 cookie**：`localhost:3011`（storefront）与 `localhost:3016`
   （merchant-admin）是同一个 host，**cookie 不按端口隔离**。在商家后台登录会覆盖
   消费者会话，storefront 立刻变成「该接口只对消费者开放」。
   生产环境是 `demo.platform.test` 与 `merchant.platform.test`，不同域，无此问题。
2. **假支付网关默认关闭**：`FAKE_PAYMENT_ENABLED` 不设就是关，
   且 `NODE_ENV=production` 时**拒绝启动**（假网关的支付页无需登录，知道
   paymentId 就能把订单付掉）。所以场景 11 要先停掉 api 容器，
   本地起一个 dev 实例（`FAKE_PAYMENT_ENABLED=true`），且 **JWT_SECRET 必须与
   容器一致**，否则 storefront 已有的会话立刻失效（401）。
3. **自动化里填不了 `datetime-local`**：`page.fill()` 对 `input[type=datetime-local]`
   无效（真实用户手动操作没问题），要用原生 setter + `input` 事件。

---

## 四、机制级验证（失败注入）

**这是本次验收的重点。** 逐项把保护逻辑临时改坏、跑测试、确认失败、立刻还原，
以此证明那些测试真的在守东西；「测试全绿」本身不能证明任何事。

**17 项全部做完：16 项确认抓到，1 项（M17）是手测项。**

| # | 护栏 | 注入方式 | 抓住它的测试 | 实测结果 |
|---|------|---------|-------------|---------|
| M1 | 客户端传优惠金额无效 | 下单 DTO 加可选 `discountAmount`，下单流程优先用它 | order-discount.e2e | ✅ 抓到（Expected 400 / Received 201） |
| M2 | 券的门槛/面额不可篡改 | 下单 DTO 加可选 `couponValue`，下单流程优先用它 | order-discount.e2e | ✅ 抓到（Expected 400 / Received 201） |
| M3 | 跨租户用券被拒 | 平台券查询去掉 `scope: PLATFORM` 限定 | order-discount.e2e | ✅ 抓到（Expected 400 / Received 404） |
| M4 | 限额不被并发超发 | 领券的条件更新改成「先 findFirst 再无条件递增」 | coupon.e2e | ✅ 抓到（Expected length 1 / Received 9；sum ≤ 5 变成 10） |
| M5 | 同一张券不被两笔订单同时用 | 手动 `DROP INDEX coupon_redemptions_coupon_active_uniq` | order-discount.e2e | ✅ 抓到（直调核销服务的那条挂了）⚠️ **半覆盖**，见 §六 |
| M6 | 优惠绕过库存校验 | 引擎去掉 `Math.min(coupon.value, afterPromotion)` | discount-engine.spec | ✅ 抓到（5 条，含实付变成 -1） |
| M7 | 平台券不被伪造 | DTO 加 `scope`，`createCoupon` 改读客户端字段 | coupon.e2e | ✅ 抓到（`Expected "SHOP" / Received "PLATFORM"`） |
| M8 | 订单取消时券被释放 | `releaseInTx` 去掉改 `reservedCount` 那一行 | coupon-release.e2e | ✅ 抓到（8 条，含全部 4 条 M8 用例） |
| M9 | 订单超时时券被释放 | 超时关闭路径不再调用释放券 | coupon-release.e2e | ✅ 抓到（`Expected "RELEASED" / Received "RESERVED"`） |
| M10 | 实付不为负 | 引擎去掉活动的封顶 | discount-engine.spec | ✅ 抓到（实付变成 -1） |
| M11 | 折扣的浮点误差 | 券减免写成 `coupon.value * 1.1` | discount-engine.spec | ✅ 抓到（13 条，出现 `3300.0000000000005`） |
| M12 | 历史订单不被重算 | 读订单时实时查券替换快照 | order-discount.e2e | ✅ 抓到（券名从「原来的名字」变成「改过的名字」） |
| M13 | 退款金额与实付相符 | 退款时重新计算优惠 | coupon-release.e2e | ✅ 抓到（`Expected 1000 / Received 2000`）⚠️ **可观测性有缺口**，见 §六 |
| M14 | 券的领取与核销状态同步 | 改 `reservedCount` 的 updateMany 移出建单事务 | order-discount + coupon-release | ❌ **原先没挂**（已补断言并复验，见下） |
| M15 | 活动/券过期时间用数据库时钟 | `databaseNow()` 换成 `new Date()` | coupon.e2e + order-discount.e2e | ✅ 抓到（`Expected 200 / Received 409`） |
| M16 | 满减活动与券的叠加顺序 | 引擎里「先活动后券」调换成「先券后活动」 | discount-engine.spec | ✅ 抓到（`Expected 1000 / Received 0`） |
| M17 | 前端展示的优惠与后端算的一致 | 结算页改用前端估算值显示、订单详情页优先用它 | 浏览器手测 | ✅ 手测确认（见下） |

### M14：原先真的没测到（本次验收补上）

失败注入把「改 `reservedCount` 的 updateMany」从建单事务里搬出来时，
`order-discount.e2e-spec.ts`（28 条）与 `coupon-release.e2e-spec.ts`（17 条）
**全部通过**。但库里真的分叉了：出现 `reservedCount = 2` 而 RESERVED 核销行
只有 1 行的券（预占路径的计数先提交了，撞部分唯一索引后事务回滚，计数没退回去）。

**原因**：原有的 M14 断言全部落在「顺利的下单 → 取消 / 支付」路径上，
这条路径计数与记录永远一致。**「预占失败后计数有没有被回退」没有任何断言**。

**已补**：在「M14：核销失败时订单也不该建出来（同生共死）」里加了两条断言 ——
第二单 409 之后 `reservedCount` 仍为 1、RESERVED 核销行仍为 1 行。

**并复验过**：重新做一次那个注入（`tx.coupon.updateMany` 改成
`this.prisma.coupon.updateMany`，即移出事务），**13 条测试挂掉**，
其中包含刚补断言的那条；还原后 29 条全绿。

### M15：计划里担心的「两个时钟几乎一致」并不存在

计划 §0.6 担心本机上数据库时钟与应用时钟几乎一致、注入后测不出差别。
**实测不是这样**：`coupon.e2e-spec.ts` 的 M15 用例用 `freezeAppClock` 把应用时钟
冻到 2019 年，与数据库时钟差 7 年，注入 `new Date()` 后**必然**分叉，测试确实挂了。
M15 在 `coupon.e2e-spec.ts` 与 `order-discount.e2e-spec.ts` 里各有一条独立用例，
两条都抓到了。

### M17 的手测实测数据

环境：容器版 storefront（`localhost:3001`）+ api（`localhost:3000`），demo 租户。

**第 1 轮（护栏生效）**：结算页渲染后把 SKU 的实时价从 13900 改成 99900，再提交订单。

| | 结算页（提交前，前端估算） | 订单详情页（提交后，服务端实算） |
|---|---|---|
| 商品原价 | ¥139.00 | ¥999.00 |
| 活动减免 | （不显示） | -¥88.88 |
| 优惠券 | -¥10.00 | -¥10.00 |
| **实付** | **¥129.00** | **¥900.12** |

→ 前端估算与服务端实算**确实不等**（差 ¥771.12）。

**第 2 轮（注入后）**：结算页把估算值写进 sessionStorage、订单详情页优先显示它。
订单详情页同时出现两块金额：注入块「支付信息（前端估算值）」显示 ¥129.00，
服务端块「支付信息」显示 ¥900.12 → **界面能显示成前端估算值**，
证明「以响应为准」这条护栏正是让真实金额显示出来的关键。
**第 3 轮（还原后）**：注入块消失，只剩服务端的 ¥900.12。

---

## 五、手测与注入中发现并修复的缺陷

### 1. 满减活动的选取没按门槛过滤（真实 bug，已修）

**症状**：同时有「满500减88」与「满200减30」两个活动时，订单 ¥459 的用户
**一分钱活动优惠都没拿到**。

**根因**：活动的选取只按「减免额最大」排序取一个，取到门槛没达成的那个时，
引擎判「门槛不满足」→ 整单没有活动优惠，而另一个门槛已达、减免额较小的活动
被跳过了。

**实测复现**（修复前）：

```json
{ "originalAmount": 45900,
  "promotionDiscountAmount": 0,
  "promotionName": "满500减88",
  "payableAmount": 45900 }
```

**修法**：查询时先按门槛过滤（`minAmount: { lte: originalAmount }`），
再在达标的活动里取减免额最大的。引擎里那道
`originalAmount >= promotion.minAmount` 的判定保留着（纯函数不查库，两边都要有）。

**补测**：「多个活动同时生效：门槛已达的优先，哪怕它的减免额更小」。

⚠️ 这条**不在 M1–M17 任何一条护栏里** —— 护栏表覆盖不到它，是失败注入时
顺带发现的。

### 2. 商家后台删券/删活动的中转返回 502（已修）

**症状**：在商家后台点「删除」，券确实从库里被软删了，但界面显示
「**后端服务不可用**」。

**根因**：后端删券返回 204（无内容），`apiFetch` 于是返回 `undefined`；
中转路由的 `NextResponse.json(result)` 在 `result` 是 `undefined` 时抛异常，
被 `toErrorResponse` 兜成 502。**删除其实成功了，界面却说失败** ——
商家会以为没删掉，于是再点一次，第二次才报「优惠券不存在」。

**修法**：改成与既有的 categories DELETE 路由同款：返回 204 + 空响应体。
补两条测试锁住「状态码是 204 且响应体为空」。

### 3. 计划与现状不符的 8 处（已记进计划 §0.5 勘误表）

其中最要命的一条：**计划 §6 的文件清单漏了 `storefront/src/app/api/orders/route.ts`**，
它的下单白名单里没有 `couponId` → 结算页选了券也会被中转**静默丢掉**，
用户选了券却完全不生效且没有任何报错。

---

## 六、已知遗留项（诚实列出）

1. **M5 是「半覆盖」**：去掉部分唯一索引后，只有「直调核销服务」的那条用例挂了；
   「并发用同一张券下单」那条**仍然通过** —— 因为下单路径上候选券查询先把
   已占住的券排掉了，唯一索引根本没被撞上。也就是说 M5 在真实下单路径上是被
   **候选券查询**挡住的，那条索引是绕过候选查询时唯一的闸门。不是缺陷，
   但「索引那条测试测的是直调服务」这件事要写清楚。
2. **M13 的可观测性有缺口**：退款金额只走到 `provider.refund(payment.id,
   payment.amount, reason)`，而**假网关把金额参数丢弃了**
   （`fake-payment.provider.ts` 里 `void amount`）。所以「退款金额 = 实付额」
   在真实渠道下能被看到，在假网关下看不到 —— 除非把重算额写回
   `payments.amount` 才能间接观察。建议将来给假网关加一个「查询最近一次退款
   金额」的端点，让这条护栏能被直接断言。
3. **M14 只补了「预占失败后计数回退」这一条**。「并发下计数与核销记录数始终对得上」
   的更强断言还没写。
4. **平台超管创建平台券没有前端入口**：后端有 `POST /platform/coupons`
   （`platform-coupon.controller.ts`，护栏 M7 要求 scope 由服务端按身份推导），
   但 `platform-admin/` 里只有「概览」与「租户详情」两个页面，
   **没有营销页**。平台券目前只能通过 API 创建。计划 Task 6/7 只覆盖了
   storefront 与 merchant-admin，这是**计划级的范围决定**，不是实现漏了。
5. **折扣券（PERCENT）没实现**：字段与引擎分支都预留了，但引擎会静默跳过它
   （设计文档 §九.1）。商家后台也没法创建（后端 DTO 不接受 `type`）。
6. **多个满减活动不叠加**：只取达标活动里减免额最大的一个（设计文档 §九.5）。
7. **满减活动没有「适用范围」**：券与活动都只做「全店商品」（设计文档 §九.2）。
8. **本机两个前端同域共用 cookie**（见 §三）：只是本机 dev 的现象，
   生产环境不同域。但它会让人在本地调试时反复掉登录态，值得记一笔。
9. **后端 lint 仍有 2 个 error**（`api/test/media.e2e-spec.ts` 的 609 / 618 行）——
   **阶段 2 遗留**，本阶段没有动它。
10. **storefront 与 merchant-admin 的组件测试覆盖有限**：storefront 有
    `coupon-list.test.tsx`（8 条），merchant-admin 的 vitest 配置只收
    `test/**/*.test.ts`（不含 tsx）、也没有 jsdom 环境，所以营销页的表单交互
    **没有组件测试**，只测了中转路由与纯函数。

---

## 七、交付物清单

### 后端（`api/`）

| 文件 | 内容 |
|------|------|
| `prisma/schema.prisma` | `Coupon` / `CouponClaim` / `CouponRedemption` / `Promotion` 四个模型 + `Order` 的 8 个优惠快照字段 |
| `prisma/migrations/20261025100000_add_marketing_tables/migration.sql` | 建表 + **手写**的部分唯一索引（`coupons_tenant_code_uniq`、`coupon_claims_coupon_customer_uniq`、`coupon_redemptions_coupon_active_uniq`） |
| `src/modules/coupon/discount-engine.ts` | 纯函数 `computeDiscount`（活动先、券后；门槛与封顶都在这里） |
| `src/modules/coupon/coupon.service.ts` | 券的 CRUD / 领取 / 列表 / **优惠预览** |
| `src/modules/coupon/coupon-redemption.service.ts` | 预占核销 / 释放 / 确认核销（与库存预占同构） |
| `src/modules/coupon/promotion.service.ts` | 满减活动 |
| `src/modules/coupon/coupon.controller.ts` | 消费者侧：`available` / `mine` / `preview` / `claim` |
| `src/modules/coupon/merchant-coupon.controller.ts` | 商家侧：券与活动的 CRUD |
| `src/modules/coupon/platform-coupon.controller.ts` | 平台侧：平台券的创建（护栏 M7） |
| `src/modules/order/order.service.ts` | 下单接入优惠 + 预占核销；取消与超时释放 |
| `src/modules/order/dto/place-order.dto.ts` | 只接受 `couponId`，**不接受任何优惠金额字段** |

### 前端（`storefront/`）

| 文件 | 内容 |
|------|------|
| `src/lib/coupon.ts` | 券的类型 + 纯函数（优惠拆分、剩余张数、可用判定、持有状态、预览拆分） |
| `src/lib/cart.ts` | `Order` 加优惠快照字段 |
| `src/lib/shop-api.ts` | 取数：优惠预览、可领取的券、我的券 |
| `src/app/api/coupons/claim/route.ts` | 领券中转（白名单重建请求体） |
| `src/app/api/orders/route.ts` | **下单白名单加 `couponId`**（否则券静默失效） |
| `src/app/(shop)/checkout/page.tsx` + `src/components/checkout/checkout-form.tsx` | 券下拉 + 四行金额 |
| `src/app/(shop)/coupons/page.tsx` + `src/components/coupon/coupon-list.tsx` | 领券中心 |
| `src/components/order/order-detail.tsx` | 优惠快照展示 |

### 商家后台（`merchant-admin/`）

| 文件 | 内容 |
|------|------|
| `src/lib/money.ts` | 「元 ↔ 分」转换（取整，不猜） |
| `src/lib/marketing.ts` | 券与活动的类型 + 日期格式转换 |
| `src/app/(dashboard)/marketing/page.tsx` + `src/components/marketing/*` | 营销页（两个页签） |
| `src/app/api/coupons/**` + `src/app/api/promotions/**` | 四个中转路由（全部白名单重建） |

### 文档

- `docs/superpowers/specs/2026-10-25-plan-05a-marketing-design.md`（设计）
- `docs/superpowers/plans/2026-10-25-plan-05a-marketing.md`（计划，§0.5 勘误表补了 25 条）
- 本文件（验收记录）

---

## 八、下一阶段

**阶段 5b：平台计费**（SaaS 订阅、套餐、额度）。

阶段 5a 留下的、与 5b 衔接的点：

- `Coupon` 的 `scope = PLATFORM` 与 `tenantId` 指向平台租户这套模型，
  是「平台级资源」的第一个实例 —— 5b 的套餐/订阅可以照这个形态做
  （平台租户下的行 + 各店铺引用）。
- 平台的「谁来创建平台券」现在只有后端接口（`POST /platform/coupons`），
  没有前端入口。5b 做平台后台时应该一并把 `platform-admin` 的营销页补上。
- 阶段的「金额一律整数分」约定在 5b 会被反复用到（套餐价、账单、税费），
  沿用即可。
