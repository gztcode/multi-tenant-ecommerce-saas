# 阶段 3 验收记录

验收日期：2026-10-24
验收范围：计划 3「交易链路」（`2026-10-24-plan-03-transaction.md` 的 Task 1–8）
分支：`gzt/电商项目`
结论：**有条件通过** —— 自动化测试与 20 项护栏全部通过；浏览器手测 15 个场景中
**15 个全部通过**；手测过程中发现并修复了 **1 个真 bug**（seed 写入的邮箱
大小写与登录查询不一致）；另有 **1 个能力缺口**（storefront 没有「加入购物车」的界面入口）
在验收收尾时补上，并在补做手测时**又发现并修复了 2 个真 bug**
（访问令牌过期后前端不刷新导致加购报 Unauthorized；购物车加载失败被显示成「购物车是空的」）。
详见 §三与 §六。

---

## 一、自动化测试结果

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端单元测试 | `cd api && npm test` | 全部通过 | **102 passed / 102 total**（4 个套件） |
| 后端 e2e | `cd api && npm run test:e2e` | 全部通过 | **282 passed / 282 total**（17 个套件） |
| 前端单测（storefront） | `cd storefront && npm test` | 全部通过 | **75 passed / 75 total**（6 个文件）—— 补做手测时新增 `token-expiry`（13 条）与 `addresses`（7 条） |
| 前端单测（merchant-admin） | `cd merchant-admin && npm test` | 全部通过 | **50 passed / 50 total**（6 个文件） |
| 后端类型检查 | `cd api && npx tsc --noEmit` | 无错误 | 通过 |
| 后端 lint | `cd api && npm run lint` | 0 error | **2 error**（阶段 2 遗留，见 §六） |

17 个 e2e 套件：`health` / `errors` / `auth` / `rbac` / `stores` / `tenancy` /
`tenant-isolation` / `catalog` / `catalog-public` / `media` / `inventory` /
`cart` / `inventory-reserve` / `order` / `order-timeout` / `payment` / `address`。

**本次验收新增的两条覆盖**（护栏失败注入验证发现的缺口，见 §四 G1 / G5）：

- `api/test/order-timeout.e2e-spec.ts` ——「超时释放是原子的：释放失败时订单状态不能
  已经变成 CLOSED」
- `api/src/modules/order/order-status.spec.ts` —— 订单状态机转移表的单元测试（新建文件，
  11 条用例）

> e2e 从 281 涨到 282（新增 G1 一条）；单元测试从 91 涨到 102（新增 G5 一个套件 11 条）。

### 收尾复跑（阶段 3 验收完成后又跑了一轮全量验证）

在补完 storefront 的「加入购物车」入口之后，又把上面所有命令**重跑了一遍**
（跑之前按下面那条提示停了 api 容器）：

| 项目 | 实测 |
|------|------|
| 后端 e2e | **282 passed / 282 total**（17 个套件） |
| 后端单元测试 | **102 passed / 102 total**（4 个套件） |
| 后端类型检查 | 通过（0 error） |
| 后端 lint | **2 error** —— 只有 `api/test/media.e2e-spec.ts` 的 `609:41` 与 `618:42`（阶段 2 遗留，未动） |
| storefront | test **55/55**、lint 0 error、build 成功 |
| merchant-admin | test **50/50**、lint 0 error、build 成功 |

**但 e2e 连跑 8 轮里有 3 轮各挂 1 条**，且挂的不是同一条 —— 根因是**测试库
跨轮次不清理**（阶段 2 的基建问题），详见 §六 遗留项 15。把测试库里的超期
`PENDING` 媒体行清掉后，全量 e2e 即 17 套件 / 282 用例全绿。**这不是阶段 3
引入的缺陷，也没有改实现。**

跑完复验后已把 api 容器起回来（`docker compose up -d api`，healthy）。

### ⚠️ e2e 跑之前必须停掉连着同一个 Redis 的 api 容器

**这是本次验收踩到的一个环境坑，记下来免得下次重蹈。**

`npm run test:e2e` 期间，**docker 里那个 api 容器的 webhook worker 与超时 worker
也在消费同一个 Redis 队列**。测试往 `payment-webhook` 队列投的任务被容器抢走，
容器连的是开发库（`ecommerce`）而测试连的是测试库（`ecommerce_test`），
于是容器报「订单不存在」、事件行的 `processedAt` 永远不被置上，
测试里 `waitFor` 轮询 10 秒后超时失败。

实测对照：

```bash
# 容器在跑时
$ cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payment.e2e-spec.ts
Test Suites: 1 failed, 1 total
Tests:       3 failed, 19 passed, 22 total      # 65.8s

# docker compose stop api 之后
$ cd api && npx jest --config ./test/jest-e2e.json --runInBand test/payment.e2e-spec.ts
Test Suites: 1 passed, 1 total
Tests:       22 passed, 22 total               # 5.9s
```

同理，本机手工起的 api（`npm run start:dev`）也会抢任务。

**这不是产品缺陷，是测试隔离缺陷**：e2e 用的队列没有与开发环境隔离
（队列名固定 `payment-webhook` / `payment-timeout`，Redis 实例固定 `localhost:16380`）。
已记入 §六遗留项。

---

## 二、容器化验证

`cd infra && docker compose build && docker compose up -d` 后 8 个服务全部起来：

| 服务 | 状态 | 端口 | 备注 |
|------|------|------|------|
| `ecommerce-postgres` | Up 2 days (healthy) | 15432→5432 | 本机 5432 被别的项目栈占用 |
| `ecommerce-redis` | Up 8 hours (healthy) | 16380→6379 | 本机 6379 被别的项目栈占用 |
| `ecommerce-minio` | Up 2 days (healthy) | 19000→9000 / 19001→9001 | |
| `ecommerce-api` | Up (healthy) | 3000→3000 | `healthcheck` 通过 |
| `ecommerce-storefront` | Up | 3001→3000 | 阶段 3 重新构建 |
| `ecommerce-merchant-admin` | Up | 3002→3000 | 阶段 3 重新构建 |
| `ecommerce-platform-admin` | Up | 3003→3000 | 阶段 2 镜像（10-21 构建，本阶段无改动） |
| `ecommerce-nginx` | Up | 80→80 | |

镜像构建时间 vs 提交时间（确认测的是最新构建）：

```
infra-api:latest             2026-10-24 17:45:37 +0800
infra-storefront:latest      2026-10-24 17:45:46 +0800
infra-merchant-admin:latest  2026-10-24 17:45:45 +0800
infra-platform-admin:latest  2026-10-21 15:56:41 +0800   ← 阶段 2 的，本阶段未改
```

### 接口实测

| 场景 | 命令 | 实测 |
|------|------|------|
| 后端健康检查 | `curl -s http://localhost:3000/api/v1/health` | `{"status":"ok",...}` HTTP=200 ✅ |
| 健康检查（带子域名） | `curl -s -H 'Host: demo.platform.test' .../api/v1/health` | HTTP=200 ✅ |
| 健康检查（带头） | `curl -s -H 'X-Tenant-Subdomain: demo' .../api/v1/health` | HTTP=200 ✅ |
| 公开商品列表（nginx + 子域名） | `curl -s -H 'Host: demo.platform.test' 'http://localhost/api/v1/public/products?pageSize=2'` | HTTP=200，返回 3 个已上架商品 ✅ |
| 公开商品列表（直连 api + 头） | `curl -s -H 'X-Tenant-Subdomain: demo' 'http://localhost:3000/api/v1/public/products?pageSize=2'` | 与上面**逐字节相同** ✅ |
| 公开品类树 | `curl -s -H 'X-Tenant-Subdomain: demo' .../api/v1/public/categories` | HTTP=200，三层嵌套 ✅ |
| 无子域名访问 | `curl -s http://localhost:3000/api/v1/public/products` | HTTP=404「无法确定店铺，请通过店铺子域名访问」✅（fail-closed，设计如此） |
| 店铺前台（nginx） | `curl -s -H 'Host: demo.platform.test' http://localhost/` | HTTP=200 ✅ |
| 商家后台（nginx） | `curl -sL -H 'Host: merchant.platform.test' http://localhost/` | 307 → `/login` → 200 ✅（会话守卫） |
| 平台后台（nginx） | `curl -sL -H 'Host: admin.platform.test' http://localhost/` | 307 → `/login` → 200 ✅ |
| 数据库迁移 | `docker compose logs api` | `12 migrations found` / `No pending migrations to apply.` ✅ |

---

## 三、手动验收场景（15 个）

**环境**：storefront 本地 dev 跑在 **3011**、merchant-admin 跑在 **3016**（启动前
`rm -rf .next`）。**没有在 3001–3003 的旧容器上测**——那两个是阶段 2 的镜像，
不含阶段 3 的功能。

**另外起了一个本地 api 跑在 3010**（`NODE_ENV=development` + `FAKE_PAYMENT_ENABLED=true`）。
原因见下面的「场景 6」。

浏览器：ego-browser（复用已常驻的实例，未抢前台）。

| # | 场景 | 结果 | 实际看到的 / 查库核对到的 |
|---|------|------|------------------------|
| 1 | 游客加购 → 刷新页面 | ✅ 通过 | **已补做真浏览器手测**（见 §三 末尾「补做手测」一节）。未选规格时「加入购物车」按钮 `disabled=true`、页面提示「请先选择商品规格。」；选好「重磅纯棉T恤 / 黑色 / M」后按钮可点，数量填 2，点下去页面出现「已加入购物车。」+「去购物车」链接（`/cart`）。<br>查库：`carts` 表里 `customerId` 为空、`guestToken` 非空的一行，`cart_items.quantity = 2` —— **真浏览器点按钮 → 后端落库**这条链路通了 ✅。<br>购物车页显示商品名「重磅纯棉T恤」、单价「¥129.00」、数量「2」、小计「¥258.00」、底部「共 2 件 / 合计 ¥258.00」+「金额为估算值，实际以提交订单时为准」。 |
| 2 | 游客加购 → 登录 | ✅ 通过 | **已补做真浏览器手测**：游客车 8 件、账号车 3 件，登录后合并结果是 **8**（`max(8,3)`），**不是 11**（没翻倍）。查库：合并后只剩一个 `carts` 行，`customerId` 已设、`guestToken` 为 NULL，`cart_items.quantity = 8` —— 游客车被 `deleteMany` 删掉（`CartItem` 级联）✅。<br>加购入口本身也走通了：游客态点「加入购物车」→「已加入购物车。」，登录页输 `customer@demo.platform.test` / `Demo12345!` → 跳 `/account`，回购物车页拿到合并后的车。 |
| 3 | 加购一个已下架商品 | ✅ 通过 | 加购「限量联名款（待上架）」（product 状态 `DRAFT`）的 SKU → HTTP **400**，响应体 `{"message":"商品不可售或不存在","code":"VALIDATION_FAILED"}`。提示可读 ✅ |
| 4 | 结算页提交订单 | ✅ 通过 | 结算页显示地址单选组（含「默认」标记）、买家备注输入框、商品清单「65W 氮化镓充电器 ¥99.00 × 7 = ¥693.00」、合计「¥693.00」，并注明「金额由服务端按下单时的 SKU 价格计算，页面上的数字不是最终金额」。提交后跳到 `/orders/20261024-v6c14tcort`：状态「待支付」、应付金额「¥693.00」、件数 7、收货信息「张三 13800000000 / 浙江省杭州市西湖区文一西路 100 号」。<br>查库：`orders` 新增一行 `status=PENDING_PAYMENT`、`totalAmount=69300`；`skus.stock` 从 **80 → 73**；`inventory_movements` 新增一行 `type=RESERVE, quantity=-7, stockBefore=80, stockAfter=73`，且带 `orderId` ✅ |
| 5 | 连点两次提交 | ✅ 通过 | 用**同一个幂等键并发**发两次 `POST /api/orders`（比连点更严格）：两个响应都返回 **同一个订单号** `20261024-6vlq3useyr`，HTTP 都是 201。<br>查库：该 `idempotencyKey` 对应的订单**只有 1 行**；`skus.stock` 从 **73 → 71**（**只减一次** 2 件）；`inventory_movements` 只有 **1 行** `RESERVE quantity=-2, stockBefore=73, stockAfter=71` ✅ |
| 6 | 假网关支付 | ✅ 通过 | 订单详情页点「去支付」→ 跳到 `http://localhost:3010/api/v1/pay/fake/<paymentId>`，页面标题「本地假支付网关」、提示「⚠️ 这是本机开发用的假网关，不是真实支付渠道。」，列出订单号 `20261024-6vlq3useyr` 与应付金额「19800（整数分）」，两个按钮「确认支付」/「模拟支付失败」。点「确认支付」后订单转 **PAID**。<br>查库：`orders.status=PAID`、`paidAt` 已置；`payments` 一行 `status=SUCCESS, amount=19800, channel=fake`；`inventory_movements` 新增一行 `type=DEDUCT, quantity=-2, **stockBefore=71, stockAfter=71**` —— **库存不再变** ✅ |
| 7 | 支付后查库存 | ✅ 通过 | `skus.stock = 71`，与预占时（71）**完全相同**。DEDUCT 流水的 `stockBefore` 与 `stockAfter` 都是 71 ✅ |
| 8 | 取消未支付订单 | ✅ 通过 | 订单详情页点「取消订单」→ 弹出确认框「确定取消这笔订单？取消后预占的库存会释放。」→ 确认后页面状态「已取消」+ 提示「订单已取消」。<br>查库：`orders.status=CANCELLED`、`cancelledAt` 已置；`skus.stock` 从 **71 → 78**（+7 加回）；`inventory_movements` 新增一行 `type=RELEASE, quantity=7, stockBefore=71, stockAfter=78`，带 `orderId` ✅ |
| 9 | 超时未支付 | ✅ 通过 | 15 分钟等不起，走后台改库 + 直接调 `OrderTimeoutService.releaseExpiredOrder(orderId)`（就是队列任务里跑的那个函数）。<br>① 用 Nest 测试容器启动 `AppModule` 拿到真实的 `OrderTimeoutService`；② 把该订单的 `payExpiresAt` 改成 `now - 60s`；③ 调 `releaseExpiredOrder` → **返回 true**（确实释放了）。<br>查库：`orders.status=CLOSED`、`closedAt=2026-10-24 09:55:38` 已置；`skus.stock` 从 **75 → 78**（+3 加回）；`inventory_movements` 新增一行 `type=RELEASE, quantity=3, stockBefore=75, stockAfter=78` ✅ |
| 10 | 商家后台发货 | ✅ 通过 | 商家后台 `/orders` 列表显示 3 笔订单，状态列分别是「已关闭」「待发货」「已取消」，金额/件数/收货人/下单时间都对。<br>进入「待发货」那笔的详情页，有「发货」区块（快递单号输入框 + 「确认发货」按钮）、「退款」区块、收货信息、支付与物流。填入 `SF1234567890` 点「确认发货」→ 状态变「待收货」，页面提示「已发货」，发货时间 `2026/10/24 17:56:37`，**快递单号显示 SF1234567890** ✅ |
| 11 | 消费者确认收货 | ✅ 通过 | 消费者订单详情页出现「确认收货」按钮（发货后才有）。点它弹确认框「确定已收到货？」→ 确认后状态「**已完成**」+ 提示「已确认收货」。<br>查库：`orders.status=COMPLETED`、`completedAt=2026-10-24 09:57:28` 已置 ✅ |
| 12 | 退款 | ✅ 通过 | 商家后台「整单退款」按钮旁有一行说明「退款只退钱，库存不会自动加回——退货入库是另一套流程。」点它弹确认框 → 确认后订单详情页状态「**已退款**」+ 提示「已退款」。<br>查库：`orders.status=REFUNDED`；`payments.status=REFUNDED`；**`skus.stock` 仍是 74，与退款前完全相同**；该订单的 `inventory_movements` 里**没有 RELEASE** 行 ✅<br>注：退款按钮只在 `PAID` / `SHIPPED` 时出现（`COMPLETED` 是终态，转移表无出边），所以这条用的是「已发货」的订单。 |
| 13 | 改地址簿的默认地址 | ✅ 通过 | 新建地址「李四 / 13900000000 / 广东省深圳市南山区科技园路 1 号」并 `isDefault=true` → 原默认地址自动翻成 `false`（查库确认）。<br>重新打开结算页：两个地址都列出来，「李四」那条带「**默认**」标记。**不点任何单选框直接提交** → 订单 `20261024-52gkvgvzdx` 的收货信息是「李四 13900000000 / 广东省深圳市南山区科技园路 1 号」，用的是新的默认地址 ✅ |
| 14 | 下单后改地址簿 | ✅ 通过 | 下单后把默认地址改成「李四改 / 科技园路 999 号」（`PATCH /api/addresses/:id` 返回 200）。<br>查库：地址簿里已经是「李四改 / 科技园路 999 号」，但 `orders` 那行的收货快照**仍是**「李四 / 科技园路 1 号」。消费者订单详情页显示的也是「李四 13800000000 / 广东省深圳市南山区科技园路 1 号」—— **快照不变** ✅ |
| 15 | 主题改动后前台 | ✅ 通过 | 商家后台「店铺设置」→ 改「主色」为 `oklch(0.7 0.19 40)`、「圆角」为 `1.5rem`，点「保存主题」→ 页面提示「已保存」。<br>刷新 storefront：`getComputedStyle(document.documentElement)` 得到 `--primary = oklch(0.7 0.19 40)`（改前是 `oklch(0.205 0 0)`）、`--radius = 1.5rem`（改前是 `0.625rem`）。商品详情页价格元素的**实际渲染颜色**也是 `oklch(0.7 0.19 40)` ✅<br>（验收后已把主题改回原值。） |

### 补做手测（「加入购物车」按钮，2026-10-24 晚）

**为什么要补**：验收收尾时补上了「加入购物车」按钮（提交 `669226d`），但**补完没有
重新手测**——前端测试基建是 Vitest 且只覆盖 `test/**/*.test.ts`，没有 jsdom /
Testing Library，做不了组件渲染测试。那条链路当时只有类型检查 + 构建 + 逻辑推演兜底。

**环境**（严格避开 3001–3003 的旧容器）：
- api：**本地 dev 跑在 3110**（`FAKE_PAYMENT_ENABLED=true`），连开发库
  （`api/.env` 的 `DATABASE_URL`，宿主机 15432）
- storefront：**本地 dev 跑在 3011**，启动前 `rm -rf .next`，
  `API_BASE_URL` 指向 3110 的本地 api（不是容器）
- merchant-admin：本次不起
- 浏览器：ego-browser（复用已常驻的实例，未抢前台）

**测的商品**：`重磅纯棉T恤`（slug `cotton-tee`，两个规格维度：颜色 黑色/白色 ×
尺码 M/L，共 4 个 SKU），前端入口 `/p/cotton-tee`。

**逐条实测结果**：

| # | 项 | 实测 |
|---|----|------|
| 1 | 未选规格时 | 「加入购物车」按钮 `disabled=true`，数量输入框也禁用，页面提示「**请先选择商品规格。**」 |
| 2 | 选好规格后 | 按钮可点，页面显示选中 SKU 的价格「¥129.00」与「库存 50 件」 |
| 3 | 点「加入购物车」 | 页面出现「**已加入购物车。**」+「**去购物车**」链接（`href="/cart"`） |
| 4 | 落库 | `carts` 一行（`customerId` 为 NULL、`guestToken` 非空），`cart_items` 一行 `quantity = 2`（选了黑色/M、数量填 2） |
| 5 | 购物车页 | 表头「商品 / 单价 / 数量 / 小计 / 操作」；行内「重磅纯棉T恤」、「¥129.00」、数量「2」、「¥258.00」；底部「共 2 件 / 合计 ¥258.00」+「金额为估算值，实际以提交订单时为准」 |
| 6 | 改数量 | 改成 5 → 页面小计变「¥645.00」、底部「共 5 件 / 合计 ¥645.00」，查库 `quantity = 5` |
| 7 | 重复加购 | 同一 SKU 再加 3 件 → 数量累加成 **8**（不是新开一行），落库 `quantity = 8` |
| 8 | 数量上限 | 输入框填 150 → 被夹成 **99**；再加 99 → 后端拒「**同一商品的加购总量不能超过 99**」（8+99 > 99），页面显示这句可读提示 |
| 9 | 登录合并 | 游客车 8 件、账号车 3 件 → 登录后合并结果是 **8**（`max(8,3)`），**不是 11**；查库只剩一个 `carts` 行，`customerId` 已设、`guestToken` 为 NULL，`quantity = 8` |

**结论**：§三 的场景 1、2 从「⚠️ 部分通过」改成「✅ 通过」。

**补做手测时又挖出 2 个真 bug**（见下一节）。

### 手测过程中发现并修复的真 bug

**seed 写入的邮箱大小写与登录查询的大小写不一致 → 消费者账号无法登录。**

**现象**：用计划里给的账号 `customer@demo.platform.test` / `Demo12345!` 在 storefront
登录，页面显示「**邮箱或密码不正确**」。

**排查**：

1. 查 `users` 表，消费者账号**存在**，但 `email` 存的是 **`CUSTOMER@DEMO.PLATFORM.TEST`**
   （大写）；商家账号 `owner@demo.platform.test` 是小写，**登录正常**。
2. 读 `auth.service.ts` 的 `login`：`const email = dto.email.toLowerCase();`
   之后 `where: { email, ... }` 是**精确匹配**（不是 `mode: 'insensitive'`）。
   所以输入小写、库里存大写 → **查不到候选** → 走「用户不存在」分支 →
   统一返回「邮箱或密码不正确」。
3. 读 `prisma/seed.ts`：`seedDemoCustomer` 写库时用的是 `email` 字面量（小写），
   查重却用 `mode: 'insensitive'` —— 所以**它找到了那条大写记录并「跳过」了**，
   永远不会把它修正回来。大写记录是**更早版本的 seed** 留下的。

**根因**：唯一索引是 `UNIQUE (lower(email))`，**存大写也能通过唯一约束**；
但登录路径会把输入小写化后**精确匹配**查询。seed 的写入路径没有做同样的归一化，
于是「库里存大写」这件事既不违反约束、又查不出来。

**修复**（`api/prisma/seed.ts`，不属于 `api/src/**` 的业务实现）：三处 seed 的
邮箱在写入前统一 `toLowerCase()`（`seedPlatformAdmin` / `seedDemoStore` /
`seedDemoCustomer`），平台超管的查重也改成大小写不敏感，与 `lower(email)`
唯一索引的语义对齐。开发库里的存量大写行用一条 `UPDATE` 修正。

**修复后**：消费者登录成功（HTTP 200，拿到 accessToken 与 customerId）。

---

**访问令牌过期后前端不刷新 → 加购报 Unauthorized，购物车页显示「购物车是空的」。**

**现象**（补做手测时发现）：浏览器里带着上一轮验收留下的登录态，点「加入购物车」
得到的是一句英文的「**Unauthorized**」；购物车页显示「**购物车是空的。**」——
**但车其实还在库里**。

**根因**：后端的 accessToken 有效期 2 小时（`JWT_EXPIRES_IN`），而 NextAuth 的
会话默认活 30 天。storefront 把后端的 accessToken 存进 NextAuth 的会话里
（`src/auth.ts` 的 `jwt` 回调），**却从来不用存着的 refreshToken 去换新的**——
后端明明提供了 `POST /auth/refresh`（轮换式，设计 §6.4）。于是两小时后，
中转路由带过去的还是那枚过期令牌 → 后端 401。

更糟的是**购物车页把「加载失败」显示成「购物车是空的」**：
`cart-list.tsx` 里 `items.length === 0` 的早返回排在错误提示**前面**，
所以 401 时 `cart` 是 `null` → `items` 是 `[]` → 走「空购物车」分支，
真正的错误被吞掉。用户以为东西没了，实际上库里好好躺着。

**修复**（全在 `storefront/`）：

1. `src/lib/token-expiry.ts`（新增）——读 JWT 的 `exp` 判断是否过期。
   提前量**按令牌自身寿命的 1/10 收敛**：固定 60 秒的提前量会让短寿命令牌
   （比如测试用的 15 秒）**永远**被判成「已过期」，于是每次读会话都去刷新。
2. `src/auth.ts`——`jwt` 回调里发现 accessToken 过期就用 refreshToken 换新的；
   刷新失败（刷新令牌也过期/被吊销）则作废整个会话，让用户重新登录。
3. ⚠️ **刷新必须去重**：后端的刷新是**轮换**式的，而 `jwt` 回调在**每次读会话**
   时都跑，一次页面请求会读好几次且常常是**并发**的。两个并发刷新带着同一枚
   旧令牌打过去 → 第一个成功并轮换 → 第二个拿着已作废的令牌 → 后端判定
   **重放** → **整个令牌族被吊销** → 用户在所有设备上被踢下线。
   所以同一枚刷新令牌在途的刷新只发一次（`inFlightRefreshes`）。
   实测（把 `JWT_EXPIRES_IN` 调到 45 秒、并发读 3 次会话）：修复前 3 条 REPLAY
   吊销记录、令牌族全灭；修复后 1 条 ROTATED、无吊销。
4. `src/components/cart/cart-list.tsx`——加载失败时**显示错误 + 「重试」**，
   绝不谎报「购物车是空的」。
5. `src/lib/route-helpers.ts`——后端认证失败时抛的是 Nest 默认的
   `UnauthorizedException('Unauthorized')`，翻成「登录已过期，请重新登录」。
6. `src/lib/server-cart.ts`——`currentToken()` 不再把空串当令牌发出去
   （`Authorization: Bearer ` 会被后端当成「带了令牌」去验签然后 401）。

**修复后实测**：令牌过期后点「加入购物车」→「已加入购物车。」；购物车页显示
真实的车（「共 2 件 / 合计 ¥258.00」）；查库 `carts.customerId` 已设、
`quantity = 2` —— **是账号车，不是游客车**。

---

**`addresses/route.ts` 多导出一个普通函数 → 违反 Next.js 的路由导出约束。**

**现象**：`next build` 报
`Route "src/app/api/addresses/route.ts" does not match the required types of a
Next.js Route. "sanitizeAddressBody" is not a valid Route export field.`

**根因**：Next.js 要求路由模块**只导出 HTTP 方法**（GET/POST/PATCH/DELETE…）。
`addresses/route.ts` 里的 `sanitizeAddressBody` 是个纯函数（不碰 request、
不碰 cookies），却被 `export` 出去，还被 `[id]/route.ts` 导入。

**为什么平时不报**：这个报错**取决于 TypeScript 检查模块的顺序**——
改动 `src/auth.ts` 之后它才冒出来。逐项 bisect 确认：同样的 `auth.ts` 改动下，
干净仓库能构建、加上 `auth.ts` 就挂；只加一行注释则不挂。
也就是说它是一颗**埋着的雷**，被别的文件改动引爆。

**修复**：把 `sanitizeAddressBody` 搬到 `src/lib/addresses.ts`（它本来就是纯函数，
放在 lib 里还能直接进单元测试），两个路由改成从 `@/lib/addresses` 导入。
顺带补了 7 条单元测试（白名单不透传 `customerId`、空串与非字符串字段被拒、
`isDefault` 必须是布尔值等）。

---

## 四、机制级验证（失败注入）

**这是本次验收的重点。** 逐项把保护逻辑临时改坏、跑测试、确认失败、立刻还原，
以此证明那些测试真的在守东西；「测试全绿」本身不能证明任何事。

20 项（含子项共 27 条）全部确认。

| # | 护栏 | 注入方式 | 抓住它的测试 | 实测结果 |
|---|------|---------|-------------|---------|
| 1 | 合并取 max | `Math.max(a,b)` → `a + b` | cart.e2e:345 | ✅ 抓到 |
| 2 | 合并重新校验 | 去掉 `status: ACTIVE` + `product: PUBLISHED` 条件 | cart.e2e:381 | ✅ 抓到 |
| 3 | 合并幂等 | `if (!guestCart) return` → 提前清理 | cart.e2e:425 | ✅ 抓到 |
| 3b | 合并删游客车 | `deleteMany` 的 id 改成不存在的 | cart.e2e:575 | ✅ 抓到 |
| 4 | 行锁串行化 | 去掉 `FOR UPDATE` | inventory-reserve.e2e:212/277/350 | ✅ 抓到（3 条挂） |
| 5 | 按 skuId 排序加锁 | 去掉 `.sort()` | inventory-reserve.e2e:350 | ✅ 抓到（真实 PG 死锁 40P01） |
| 6 | 下单幂等键 | 快路径 + P2002 恢复路径**同时**失效 | order.e2e:530/562 | ✅ 抓到（**两层同时破才挂**，见下） |
| 7 | 跨租户下单 | 租户扩展过滤 + 原生 SQL 的 tenantId **同时**去掉 | order.e2e:605 | ✅ 抓到（**三层同时破才挂**，见下） |
| 8 | 金额不可篡改 | DTO 加 `unitPrice` + 总额改读它 | order.e2e:480 | ✅ 抓到 |
| 9 | 预占不足整单回滚 | 库存不足的抛错改成 `continue` | inventory-reserve.e2e:478 | ✅ 抓到 |
| 10 | 条件更新（订单侧） | `transitionInTx` 退化成「先查后改」 | order.e2e:1197 | ✅ 抓到 |
| 10b | 条件更新（超时侧） | 同上 | **G1：竞态窗口太窄，抓不到 → 本次补强** | ⚠️ → **补强后 ✅** |
| 11 | 验签后才落库 | 控制器改成「先落库后验签」 | payment.e2e:529 | ✅ 抓到 |
| 12 | webhook 幂等 | `insertEvent` 冲突分支 `return false` → `return true` | payment.e2e:647 | ✅ 抓到 |
| 13 | 金额核对后才流转 | 金额不符时不再 `return {accepted:false}` | payment.e2e:837 | ✅ 抓到 |
| 14 | 不采信 tenantId（入口） | 控制器把请求体的 tenantId 塞进队列任务 | payment.e2e:882 | ✅ 抓到 |
| 14b | 不采信 tenantId（消费端） | 消费端改成「按订单自己的租户流转」 | payment.e2e:929 | ✅ 抓到（**本次新增**） |
| 15 | 状态机拒绝非法流转 | `updateMany` 去掉 `status: from` 条件 | order.e2e:648/690/715/771 | ✅ 抓到（5 条挂） |
| 15b | 转移表本身 | `canTransition` 改成恒真 | **G5：无独立覆盖 → 本次补强** | ⚠️ → **补强后 ✅** |
| 16 | 假网关生产拒绝启动 | 生产检查改成不抛错 | payment.e2e:1231 | ✅ 抓到 |
| 17 | 退款不回补库存 | 退款事务里加 `releaseReservationInTx` | payment.e2e:1122 + order.e2e:886 | ✅ 抓到 |
| 18 | jobId 去重 | `timeout-${orderId}` → 加随机后缀 | order-timeout.e2e:465 | ✅ 抓到 |
| 18b | 消费端幂等（超时侧） | 条件更新改成「先查后改」 | order-timeout.e2e:519 | ✅ 抓到 |
| 18c | 条件更新（支付侧） | `payment.updateMany` 去掉 `status: PENDING` | **单独破抓不到** —— 事件表闸门接住了，属纵深防御 | ⚠️ |
| 19 | 默认地址唯一 | `create` 里不再先 `clearDefault` | cart.e2e:798 | ✅ 抓到 |
| 20 | 地址归属当前租户 | `assertCustomerInTenant` 去掉 role 条件 / 整体移除 | cart.e2e:849 | ✅ 抓到 |

另有 8 条附加的纵深防御验证：worker 重建租户上下文（超时侧 + 支付侧）、超时释放判
`payExpiresAt`、取消的原子性（状态+释放同事务）、webhook 队列 jobId 去重、支付侧与
超时侧的条件更新、地址归属校验整体移除 —— **全部 ✅ 抓住**。

### 三层防御的说明

- **护栏 6（幂等键）**：单独破任一层都抓不到 —— DB 的部分唯一索引接住了。
  **两层同时破才挂**。覆盖的是「整体失效」，不是「某一层失效」。
- **护栏 7（跨租户）**：单独破租户扩展的过滤，原生 SQL 的手写 `tenantId` 兜着；
  单独破原生 SQL，扩展兜着。**三层同时破才挂**。
- **护栏 18c（支付侧条件更新）**：真正生效的是事件表的 `(provider, eventId)` 唯一索引，
  后面的条件更新是**纵深防御**。这一条**单独破抓不到**是**符合预期**的，
  不是覆盖缺口 —— 它的作用是在闸门失效时兜住。

### G1：超时释放的原子性（本次补强）

**原来的覆盖缺口**：`releaseExpiredOrderInTx` 用条件更新（正确），但把它退化成
「先查后改」的变异，**连跑 8 次测试都抓不住** —— 那 8 次跑依赖「支付回调与超时释放
恰好撞在一起」，撞上的概率太低，不撞的时候退化实现表现得完全正常。

**补的用例**（`api/test/order-timeout.e2e-spec.ts`，照 `order.e2e-spec.ts:831`
「取消是原子的」那一条的写法）：先手动造一条 `DEDUCT` 流水把「未冲抵预占量」做成 0，
让释放**必然失败**，然后触发超时释放，断言**订单状态不能已经变成 CLOSED**。
**不靠竞态，稳定复现。**

**失败注入复核**（把条件更新退化成「先查后改」+ 把「改状态」与「释放预占」拆成两个
独立事务）：

```
$ npx jest --config ./test/jest-e2e.json --runInBand test/order-timeout.e2e-spec.ts
● 支付超时释放 (e2e) › 超时释放是原子的：释放失败时订单状态不能已经变成 CLOSED
  expect(received).toBe(expected)
  Expected: "PENDING_PAYMENT"
  Received: "CLOSED"

Test Suites: 1 failed, 1 total
Tests:       1 failed, 6 passed, 7 total     ← 只有新加的这条挂
```

还原后 7 条全绿。

### G5：状态机转移表（本次补强）

**原来的覆盖缺口**：`canTransition` 改成恒真，**整套 e2e 全绿** —— 真正拦住非法流转的
是 `transitionInTx` 里的 `updateMany` 条件，不是 `canTransition`。也就是说
`canTransition` 是**纵深防御**，但没有测试证明它在起作用。

**补的用例**（新建 `api/src/modules/order/order-status.spec.ts`，11 条）：
转移表覆盖全部 7 个状态且无漏项/多项；表内列出的每一条合法流转返回 true；
**表外的每一条流转返回 false**（含 `COMPLETED → PAID`、`PENDING_PAYMENT → SHIPPED`、
`PENDING_PAYMENT → COMPLETED`）；四个终态（`COMPLETED` / `CANCELLED` / `REFUNDED` /
`CLOSED`）没有任何出边；状态不能流转到自身。断言写成**从表里枚举**而不是逐条手写，
以后往表里加状态时用例自动跟着变。

**失败注入复核**（`canTransition` 改成 `return true`）：

```
$ npx jest src/modules/order/order-status.spec.ts
Tests:       7 failed, 4 passed, 11 total

# 同一变异下，e2e 全绿（确认这就是那个覆盖缺口）
$ npx jest --config ./test/jest-e2e.json --runInBand test/order-timeout.e2e-spec.ts test/order.e2e-spec.ts
Test Suites: 2 passed, 2 total
Tests:       35 passed, 35 total
```

还原后 11 条全绿。

---

## 五、交付物清单

### 数据模型（3 张新表 + 3 条迁移）

`api/prisma/schema.prisma` 新增 `Cart` / `CartItem` / `Address` / `Order` / `OrderItem` /
`Payment` / `PaymentWebhookEvent` 七张表，`InventoryMovement` 加 `orderId` 与可空的
`operatorId`。

| 迁移 | 内容 |
|------|------|
| `20261024093418_add_transaction_tables` | 阶段 3 的全部新表与索引 |
| `20261024110849_allow_null_inventory_movement_operator` | `operatorId` 可空（系统操作） |
| `20261024140000_add_inventory_movement_order_id` | `InventoryMovement.orderId` |

### 后端模块（3 个新模块）

- `api/src/modules/cart/` —— 购物车与地址簿（`cart.service.ts` / `cart.controller.ts` /
  `address.service.ts` / `address.controller.ts`）
- `api/src/modules/order/` —— 订单与状态机（`order.service.ts` / `order-status.ts` /
  `inventory.service.ts` / `order-timeout.service.ts` / `order-timeout.worker.ts`）
- `api/src/modules/payment/` —— 支付抽象、本地假网关与 webhook（`payment.service.ts` /
  `payment-provider.interface.ts` / `fake-payment.provider.ts` / `fake-payment.controller.ts` /
  `webhook.controller.ts` / `webhook.worker.ts`）

### 新增接口

| 方法与路径 | 用途 |
|-----------|------|
| `GET /api/v1/cart` | 读当前购物车（游客按 cookie，登录按 customerId） |
| `POST /api/v1/cart/items` | 加购 |
| `PATCH /api/v1/cart/items/:id` | 改数量 |
| `DELETE /api/v1/cart/items/:id` | 删条目 |
| `DELETE /api/v1/cart` | 清空购物车 |
| `POST /api/v1/cart/merge` | 登录后把游客车合并进账号车 |
| `GET /api/v1/addresses` | 地址簿列表（默认地址排最前） |
| `POST /api/v1/addresses` | 新建地址 |
| `PATCH /api/v1/addresses/:id` | 改地址（含设/取消默认） |
| `DELETE /api/v1/addresses/:id` | 软删地址 |
| `POST /api/v1/orders` | 下单（库存预占 + 排超时任务） |
| `GET /api/v1/orders` | 消费者订单列表（按状态筛选 + 分页） |
| `GET /api/v1/orders/:orderNo` | 消费者订单详情 |
| `POST /api/v1/orders/:orderNo/cancel` | 取消未支付订单（释放预占） |
| `POST /api/v1/orders/:orderNo/confirm` | 确认收货 |
| `POST /api/v1/orders/:orderNo/pay` | 发起支付（返回支付页面 URL） |
| `GET /api/v1/merchant/orders` | 商家订单列表（状态 + 时间区间筛选 + 分页） |
| `GET /api/v1/merchant/orders/:orderNo` | 商家订单详情 |
| `POST /api/v1/merchant/orders/:orderNo/ship` | 发货（填快递单号） |
| `POST /api/v1/merchant/orders/:orderNo/refund` | 整单退款（**不回补库存**） |
| `POST /api/v1/webhooks/payment/:channel` | 渠道回调（验签 → 核金额 → 幂等落库 → 入队） |
| `GET /api/v1/pay/fake/:paymentId` | 本地假网关的支付页 |
| `POST /api/v1/pay/fake/:paymentId/confirm` | 假网关「确认支付」 |
| `POST /api/v1/pay/fake/:paymentId/fail` | 假网关「模拟支付失败」 |

### 前端页面

| 应用 | 页面 |
|------|------|
| storefront | `/cart`（购物车）、`/checkout`（结算）、`/orders`（我的订单）、`/orders/[orderNo]`（订单详情，含「去支付」「取消订单」「确认收货」） |
| merchant-admin | `/orders`（订单列表）、`/orders/[orderNo]`（订单详情，含发货表单与退款按钮） |

### 前端中转路由

`storefront/src/app/api/` 下新增 `cart/`（含 `items`、`merge`）、`addresses/`、
`orders/`（含 `[orderNo]/cancel`、`confirm`、`pay`）；`merchant-admin/src/app/api/orders/`
下新增中转路由。全部按阶段 2b 确立的约定做**请求体白名单重建**。

### 基础设施

`infra/docker-compose.yml` 增加 `api` 的 `payment-timeout` / `payment-webhook` 两个
BullMQ 队列依赖；`api/src/modules/queue/queue.module.ts` 登记两个队列。

---

## 六、已知遗留项

**诚实地列出来：哪些没测到、哪些没覆盖、哪些是刻意的取舍。**

### 功能缺口

1. ~~**storefront 没有「加入购物车」的界面入口**~~ —— **手测新发现，验收收尾时已补上**。
   当时的状况：后端 `POST /api/v1/cart/items` 与 storefront 的中转路由
   `POST /api/cart/items` 都在，实测能正常加购（购物车页会正确显示商品名、
   单价、数量、小计、合计）；但**商品列表页、商品详情页、搜索页、品类页都没有
   「加入购物车」按钮**，全仓库 `grep` 不到任何组件调用 `POST /api/cart/items`。
   后果是场景 1、2、3 在界面上走不通，只能用中转路由直接发起加购来验证后端语义。

   **已修**（提交 `669226d`）：商品详情页的规格选择器里加了「加入购物车」按钮——
   选好具体 SKU 之后才可用（没选规格时禁用并提示「请先选择商品规格」），
   带数量输入（1–99），加载中禁用防重复点击，成功显示「已加入购物车」并给出
   去购物车的入口，失败显示后端返回的可读 message。
   中转路由同时补了 `quantity` 上限校验与一条「多余字段不会被透传」的测试。

   > ✅ **已补做真浏览器手测**（见 §三 末尾「补做手测」一节）：按钮在真浏览器里点得动，
   > 「已加入购物车。」→「去购物车」→ 落库 → 购物车页显示 → 改数量 → 登录合并
   > → 重复加购，六项全部实测通过。§三 的场景 1、2 因此从「部分通过」改成「✅ 通过」。
   >
   > 补做手测时**又挖出 2 个真 bug**（详见 §六「手测过程中发现并修复的真 bug」）：
   > 访问令牌过期后前端不刷新令牌（加购报 Unauthorized、购物车页显示「购物车是空的」），
   > 以及 `addresses/route.ts` 多导出一个普通函数违反 Next.js 的路由导出约束
   > （平时不报错，被别的文件改动改变 TS 检查顺序时才暴露，导致 `next build` 挂掉）。

2. **商家后台没有「主题改动」的实时预览** —— 改完主题要刷新前台才看得到变化。
   本次手测是「保存 → 刷新前台 → 计算样式变了」，不是实时预览。

3. **地址簿没有独立页面** —— 地址只能在结算页的「新增地址」按钮与中转路由里维护，
   没有一个可以集中管理地址的页面。消费者侧与商家侧都是这样。

### 刻意的取舍（设计如此，不是没做完）

4. **跨店会员不支持**（设计 §十三 遗留项 1）—— 一个消费者在多家店是**多条独立的用户
   记录**，账号不通用。本次实测：同一邮箱在 A 店登录后，浏览 B 店是游客态。
5. **游客订单查不到**（设计 §十三 遗留项 8）—— `orders.customerId` 为空时消费者侧
   按 `customerId` 查订单查不到，游客下完单只能靠下单响应里的订单号继续支付。
   实测：`GET /api/v1/orders` 不带 token → HTTP 401「Unauthorized」。
   **本阶段不实现「按联系方式查最近订单」**，这是明确的能力边界。
6. **退款不回补库存**（设计 §7.1）—— 货已经发出去了，退的是钱不是库存。
   「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
   实测：退款后 `skus.stock` 与退款前**完全相同**，且没有 RELEASE 流水。
   商家后台的退款按钮旁有一行说明「退款只退钱，库存不会自动加回——退货入库是另一套流程。」
7. **购物车金额是估算值** —— 页面上的合计 = 当前价 × 数量；**下单时按实时价重算**。
   购物车页底部有一行「金额为估算值，实际以提交订单时为准」，结算页有一行
   「金额由服务端按下单时的 SKU 价格计算，页面上的数字不是最终金额」。
   本次实测两者一致（¥693.00），但**价格变了就不一致** —— 这是设计如此。
8. **BullMQ 的 delayed job 不保证准时** —— 超时释放**靠订单自己的 `payExpiresAt` 兜底**
   （队列任务提前触发时，`releaseExpiredOrderInTx` 会判 `payExpiresAt` 并放弃执行）。
   本次手测场景 9 正是靠这个兜底：把 `payExpiresAt` 改到过去后手动触发释放。
9. **`20261022071848_add_sku_stock_version` 这条阶段 2 的迁移在全新库上会失败** ——
   它 DROP 了一个**后建**的索引。**不要动它**（改了会破坏 `prisma migrate` 的
   checksum 校验，后续所有迁移都会被拒）。已记为遗留项。

### 测试与环境的已知问题

10. **e2e 的队列没有与开发环境隔离** —— **本次踩到**。`npm run test:e2e` 期间，
    docker 里 api 容器的 worker 会抢走测试投进同一个 Redis 的任务（连的是开发库），
    导致 `payment.e2e-spec.ts` 出现 3–6 条假失败（详见 §一 的对照输出）。
    **跑 e2e 前必须先 `docker compose stop api`**（本机手工起的 api 同样要停）。
    根治办法是给 e2e 用独立的队列名前缀或独立的 Redis 实例。
11. **共享 Redis 里堆积了大量 failed job** —— 验收前 `payment-timeout` 队列里躺着
    **1913** 条 failed job（历次测试运行 + 手工测试留下的）。它们不阻塞新任务，
    但会拖慢 BullMQ 的清理、干扰排查。验收前已清空。
12. **`api/test/media.e2e-spec.ts` 有 2 条既存 lint 报错**（阶段 2 遗留）——
    `609:41` 与 `618:42` 的 `no-unsafe-member-access`。不是本阶段引入的，
    本阶段也没有顺手改（外科手术式改动原则）。
13. **偶尔有 1 条 e2e flaky** —— 历史上出现过重跑即过的情况。
    **收尾复跑时又复现了一次**，根因见下面第 15 条（不是随机 flake，是残留数据）。

### 本次补上的覆盖

14. **G1（超时释放的原子性）** 与 **G5（状态机转移表）** 两处覆盖缺口已补，
    见 §四。补完后「条件更新退化成先查后改」与「`canTransition` 改成恒真」
    都能被稳定抓住。

### 收尾复跑时新发现的

15. **e2e 跑完不清库，测试库会跨轮次累积残留数据** —— **本次收尾复跑时踩到**。
    `test/setup-e2e.ts` 只做 `prisma migrate deploy` + `prisma db seed`，
    **不删表**，所以每跑一轮 e2e 就往测试库里堆一批数据。

    实测：全量 e2e 连跑 **8 轮**，**5 轮全绿、3 轮各挂 1 条**，而且挂的**不是同一条**：

    - 2 轮挂 `media.e2e-spec.ts`「孤儿清理跨租户」——
      `expect(result.marked).toBe(2)` 收到 **10**。
      原因：`cleanupOrphans()` 是**平台级**任务，会扫全库所有超过 24 小时的
      `PENDING` 媒体行；而 `catalog` / `catalog-public` 两个套件每次跑都会留下
      若干 `PENDING` 媒体行。测试库里当时已积了 **120** 条超期 `PENDING`，
      其中 8 条的 MinIO 对象已不存在，于是被一并标成孤儿，计数从 2 变成 10。
    - 1 轮挂 `catalog.e2e-spec.ts`「规格减少时多余的 SKU 置为 INACTIVE」——
      断言保留的 SKU 仍是 `ACTIVE`，实际收到 `INACTIVE`。
      **同一个用例单独跑是绿的**（47/47），只有夹在其他套件后面跑才红。

    验证方式：把测试库里超期的 `PENDING` 媒体行删掉（`DELETE 120`），
    紧接着的**全量** e2e 就是 **17 套件 / 282 用例全绿**；再跑一次又有几率翻红。

    **这不是阶段 3 引入的缺陷**，是阶段 2 的 e2e 基建问题（`setup-e2e.ts` 没清库），
    与第 10 条的队列争抢是**同一类病**：测试环境与「上一轮的残留」不隔离。
    本次**没有改** `setup-e2e.ts`（外科手术式改动原则，且改它会影响所有套件）。
    根治办法：在 `setup-e2e.ts` 里每轮跑之前 truncate 业务表（或给每个套件
    一个独立的 schema / 数据库）。

---

## 七、下一阶段

阶段 3 把「购物车 → 下单 → 支付 → 发货 → 确认收货 → 退款」这条闭环跑通了，
但有几处**用户路径上的断点**应该在下一阶段优先补上：

1. ~~**补「加入购物车」的界面入口**（§六 遗留项 1）~~ —— **已在验收收尾时补上**
   （提交 `669226d`，商品详情页的规格选择器里），并**已补做真浏览器手测**
   （见 §三「补做手测」一节）：按钮点得动、落库正确、购物车页显示完整、
   改数量落库正确、登录合并取 max 不翻倍、重复加购累加且不超 99 上限。
   §三 的场景 1、2 已是「✅ 通过」。手测途中又修掉了 2 个真 bug
   （访问令牌过期不刷新、购物车加载失败被显示成「购物车是空的」）。
2. **给 e2e 的队列做隔离**（§六 遗留项 10）—— 否则每次跑 e2e 都要先停容器，
   这会持续制造「实测报缺陷、复现不出来」的假象（阶段 2b 栽过两次这个坑）。
   同类问题还有一条：**e2e 之间没有清库**，测试库会跨轮次累积残留数据，
   同样会让断言「全局状态」的用例时绿时红（见 §六 遗留项 15）。
3. **地址簿的独立页面**（§六 遗留项 3）—— 现在的地址只能在结算页里加，
   改默认地址要进结算页，不合理。
4. **购物车金额改成服务端实时价** —— 现在的合计是估算值，价格变动时会与实付不符
   （虽然下单时按实价重算是对的，但用户看到的数字会骗人）。
5. **退货入库流程**（§六 遗留项 6）—— 退款不回补库存是有意的取舍，但配套的
   「退货入库」始终没有实现，库存账面与实物长期会不一致。
6. **跨店会员**（§六 遗留项 4）—— 等有了会员体系的需求再动。

后端接口与数据模型在本阶段已相对完整，下一阶段的形态更可能是**前端补齐 + 体验打磨**，
而不是再加新的交易能力。
