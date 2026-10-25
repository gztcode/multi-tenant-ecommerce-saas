# 计划 3：交易链路 设计文档

| 项目 | 说明 |
|------|------|
| 文档日期 | 2026-10-24 |
| 文档状态 | 待用户审阅 |
| 前置 | 阶段 1（地基与身份）、阶段 2a（商品中心后端）、阶段 2b（主题与前端）均已合并 |
| 后续 | 计划 4「营销、平台计费与平台超管」 |

---

## 一、目标与范围

阶段 2 建的是「商品能卖」，阶段 3 建的是「真能卖出去」：消费者加购 → 下单 →
支付 → 商家发货 → 确认收货，以及贯穿其中的**库存预占**与**支付幂等**。

### 1.1 本阶段交付

| 模块 | 内容 |
|------|------|
| 购物车 | 游客 cookie + 登录账号购物车，登录时合并；按店铺（租户）分 |
| 收货地址 | 消费者地址簿（可多个、含默认地址）；下单时快照进订单 |
| 订单 | 完整状态机：下单 → 支付 → 发货 → 确认收货；取消 / 退款 / 关闭 |
| 库存预占 | 下单预占、超时释放、支付转实扣；流水 append-only |
| 支付 | `PaymentProvider` 抽象 + **本地假支付网关**（真实适配器预留接口） |
| 异步任务 | Redis + BullMQ：支付超时释放预占 |

### 1.2 明确不做

- **不接真实微信 / 支付宝**。本阶段用本地假支付网关（§六），但抽象层按真实
  渠道设计（签名校验、幂等键、对账接口都留好）。真实适配器是「填密钥」的工作，
  不是「改架构」的工作。
- **不做运费计算**。阶段 4 有营销与计费后一起做。订单金额 = 商品小计。
- **不做优惠券 / 满减**。阶段 4。
- **不做物流公司对接**。发货只填快递单号。
- **不做跨店会员**。见 §3.3。
- **不做售后 / 退货流程**。退款只做「整单退款」，不支持部分退货。

---

## 二、关键决策速查

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 支付通道 | 本地假支付网关 + 真实适配器预留 | 真沙箱要商户资质与密钥，本机拿不到；但抽象层按真实渠道设计，阶段 4 之后填密钥即可 |
| 2 | 购物车存储 | 游客 cookie（存 token）+ 数据库购物车，登录时合并 | 游客车也进数据库，避免 cookie 4KB 限制；合并逻辑统一 |
| 3 | 超时释放预占 | Redis + BullMQ delayed job | 电商标准做法；本机 16380 端口已预留 |
| 4 | 收货地址 | 地址簿 + 订单快照 | 订单里的快照不能随地址簿改动而变（电商硬要求） |
| 5 | 订单金额 | 只算商品金额 | 阶段 4 有优惠后重写订单表代价高，现在留干净 |
| 6 | 订单状态机 | 完整（含发货与确认收货） | 商家后台需要「发货」按钮，否则订单闭环不完整 |
| 7 | 库存预占方式 | 预占即扣 `stock` | 不改阶段 2 的 `stock` 语义（= 可售库存），前台显示的库存就是它 |

---

## 三、数据模型

新增 7 张表。其中 **6 张带 `tenantId`，登记进 `TENANT_SCOPED_MODELS`**
（**漏登记会让服务启动直接失败**——阶段 2 的 `assertTenantScopedModelsRegistered`
是 fail-fast 的）。

第 7 张 `payment_webhook_events`（§3.7）**不带 `tenantId`、不登记白名单**——
它是渠道事件的数据，租户从订单反查。

> ⚠️ 本节开头曾写成「新增 7 张表，全部带 `tenantId`，全部登记进白名单」，
> 与 §3.7 自相矛盾。**以本段为准**：6 张登记，1 张不登记。
>
> ⚠️ **下面的模型定义只写了一侧关系，实现时要补三个反向字段**
> （Prisma 要求双向关系都声明，否则 `prisma validate` 直接失败）：
> `Tenant.carts Cart[]`、`User.carts Cart[]`、`Sku.cartItems CartItem[]`。
>
> `Address` / `Order` / `Payment` **刻意不声明 tenant 关系**，
> 只有 `tenantId` 标量——这样「跨租户挂载」这个风险由 service 层显式校验
> （护栏 20），而不是靠外键悄悄放行。

### 3.1 carts（购物车）

```prisma
model Cart {
  id         String   @id @default(uuid())
  tenantId   String
  // 登录用户的购物车：customerId 有值、guestToken 为空
  customerId String?
  // 游客的购物车：guestToken 有值、customerId 为空
  guestToken String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  customer User?     @relation(fields: [customerId], references: [id], onDelete: Cascade)
  items    CartItem[]

  @@index([tenantId, customerId])
  @@index([tenantId, guestToken])
  @@map("carts")
}
```

**唯一性靠部分唯一索引**（Prisma 表达不了，且 `NULL` 不参与唯一判定）：

```sql
CREATE UNIQUE INDEX "carts_tenant_customer_uniq"
  ON "carts" ("tenantId", "customerId") WHERE "customerId" IS NOT NULL;
CREATE UNIQUE INDEX "carts_tenant_guest_uniq"
  ON "carts" ("tenantId", "guestToken") WHERE "guestToken" IS NOT NULL;
```

> **一个消费者在同一店铺只有一个购物车**，这是合并的前提。
> 若没有唯一约束，并发请求会造出两个购物车，合并逻辑就无从谈起。

### 3.2 cart_items

```prisma
model CartItem {
  id        String   @id @default(uuid())
  tenantId  String
  cartId    String
  skuId     String
  quantity  Int
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  cart Cart @relation(fields: [cartId], references: [id], onDelete: Cascade)
  sku  Sku  @relation(fields: [skuId], references: [id], onDelete: Cascade)

  @@unique([cartId, skuId])
  @@index([tenantId, cartId])
  @@map("cart_items")
}
```

### 3.3 addresses（消费者地址簿）

```prisma
model Address {
  id         String   @id @default(uuid())
  tenantId   String
  customerId String
  receiver   String
  phone      String
  province   String
  city       String
  district   String
  detail     String
  isDefault  Boolean  @default(false)
  deletedAt  DateTime?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([tenantId, customerId])
  @@map("addresses")
}
```

**默认地址必须唯一**——否则「取默认地址」返回哪一条是不确定的，
下单时可能取到用户已经删掉的地址。加部分唯一索引：

```sql
CREATE UNIQUE INDEX "addresses_tenant_customer_default_uniq"
  ON "addresses" ("tenantId", "customerId")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;
```

> 改默认地址时要**先把旧的置 false 再设新的**，否则会撞这个唯一索引
> （同一瞬间有两条 `isDefault = true`）。要么在一个事务里做，要么先置 false。

**地址的 `customerId` 必须属于当前租户**——外键只引用 `id` 不带 `tenantId`，
数据库挡不住跨租户挂载（与阶段 2 的 `categoryId` 同款问题）。
service 层要查一次 `customer` 确认归属。

> **跨店会员的限制在这里**：阶段 1 的 `User` 是租户作用域的，`CUSTOMER` 账号
> 只在注册的那家店铺有身份。所以「同一个人在 A 店和 B 店各有一个会员账号」
> 是现状，不是本阶段能改的。要支持跨店会员，得把消费者从租户作用域里拆出来
> （独立的 customer 表 + 与店铺的关联表），那是数据模型级变更。
> **本阶段明确不支持跨店会员**：游客可以跨店浏览，但会员身份是店铺内的。

### 3.4 orders

```prisma
enum OrderStatus {
  PENDING_PAYMENT
  PAID
  SHIPPED
  COMPLETED
  CANCELLED
  REFUNDED
  CLOSED
}

model Order {
  id         String      @id @default(uuid())
  tenantId   String
  orderNo    String      @unique
  customerId String?
  status     OrderStatus @default(PENDING_PAYMENT)

  totalAmount Int
  itemCount   Int

  // 收货信息快照（来自下单时选中的地址，之后地址簿改了也不影响订单）
  receiverName String
  receiverPhone String
  province    String
  city        String
  district    String
  detail      String

  remark String?

  // 幂等键。同一个键重复下单返回同一个订单，而不是新建一个。
  // 部分唯一索引：不同租户可以用同一个键（虽然不该，但不该因此报错）。
  // 见 §5.1。
  idempotencyKey String?

  payChannel   String?
  payExpiresAt DateTime?
  paidAt       DateTime?
  shippedAt    DateTime?
  completedAt  DateTime?
  cancelledAt  DateTime?
  closedAt     DateTime?
  trackingNo   String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  items    OrderItem[]
  payments Payment[]

  @@index([tenantId, customerId, status])
  @@index([tenantId, createdAt])
  @@map("orders")
}
```

**`orderNo` 的生成**：`日期 + 10 位随机`（如 `20261024-k3m9x2q4tz`），**全小写字母数字**。

- **必须全局唯一**（订单号会被消费者用来查订单、也会出现在支付回调里），
  所以用 `@@unique` 而不是复合唯一。
- 随机部分 10 位（约 60 bit）足够：即使每天 10 万单，碰撞概率也在 1e-10 量级。
- 生成后**仍要处理唯一冲突**：并发下单可能生成相同的号（概率极低但非零），
  捕获 P2002 后重试一次即可，不要把 500 抛给用户。
- **不含租户信息**：订单号会出现在支付回调、商家后台的搜索框、日志里。
  带上租户标识等于把「这是哪家店的订单」写进了一个会被外部看到的字段。
  租户归属从订单表本身查，不从订单号里解析。

### 3.5 order_items

```prisma
model OrderItem {
  id        String @id @default(uuid())
  tenantId  String
  orderId   String
  skuId     String
  productId String
  // 下单时的商品名与规格快照。商家后来改了名、改了价，订单里必须是当时的
  productName  String
  skuSnapshot Json
  quantity     Int
  unitPrice    Int
  subtotal     Int

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([tenantId, orderId])
  @@map("order_items")
}
```

### 3.6 payments

```prisma
enum PaymentStatus {
  PENDING
  SUCCESS
  FAILED
  CLOSED
  REFUNDED
}

model Payment {
  id           String        @id @default(uuid())
  tenantId     String
  orderId      String
  channel      String
  // ⚠️ provider 与 channel **不是一回事**：channel 是「微信 / 支付宝 / 假网关」
  // 这类渠道名，provider 是「渠道背后的服务提供方」（微信支付 vs 微信服务商、
  // 支付宝 vs 支付宝服务商）。幂等去重要按 provider 走——同一笔交易在服务商
  // 模式下会同时收到「服务商」与「直连」两个渠道的通知。
  provider     String
  status       PaymentStatus @default(PENDING)
  providerTxnId String?
  amount       Int
  rawResponse  Json          @default("{}")
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@unique([orderId, channel])
  @@index([tenantId, status])
  @@map("payments")
}
```

**两个唯一约束都是幂等的基础**：
- `(orderId, channel)` —— 一个订单在一个渠道只有一笔支付单，重复下单支付被拒
- `(provider, providerTxnId)` —— 同一笔渠道交易不会落成两条支付单（见 §六.3）

> ⚠️ **`(provider, providerTxnId)` 这条索引必须单独建，且是部分唯一索引**：
> `providerTxnId` 可空（还没拿到渠道交易号的支付单），而 PostgreSQL 的 NULL
> 不参与唯一判定——但**多个 NULL 恰恰是允许的**（符合预期），所以直接写
> `UNIQUE (provider, provider_txn_id)` 即可，NULL 行不会互相冲突。
>
> ```sql
> CREATE UNIQUE INDEX "payments_provider_txn_uniq"
>   ON "payments" ("provider", "providerTxnId");
> ```
>
> **这条索引不能省。** 少了它，攻击者（或渠道的重复投递）用**不同的 eventId**
> 重放同一笔交易时，第 1 道防线（事件表的 eventId 唯一）挡不住，
> 同一笔渠道交易会落成两条支付单，订单的支付金额与对账全部错乱。
> §3.6 的正文与代码曾经不一致（正文列了它、代码里没有），现已对齐。

### 3.7 payment_webhook_events（幂等表）

```prisma
model PaymentWebhookEvent {
  id            String   @id @default(uuid())
  provider      String
  eventId       String
  providerTxnId String?
  payload       Json
  processedAt   DateTime?
  createdAt     DateTime @default(now())

  @@unique([provider, eventId])
  @@map("payment_webhook_events")
}
```

> ⚠️ **这张表绝不能被未验签的请求写入——否则就是一个 DoS 与资金损失漏洞。**
>
> 攻击路径：攻击者抢先向 webhook 端点发一个 `eventId = "X"` 的伪造请求，
> 落库占住了 `(provider, "X")`。真实的支付回调随后到达，同一个 `eventId`
> 插入冲突 → **被当作重复事件忽略** → 订单永远不流转到 `PAID`，
> 而用户的钱已经付了。
>
> **所以顺序必须是「先验签，后落库」**：
> 1. 验签失败 → 直接 401，**一个字都不写进数据库**；
> 2. 验签通过 → 尝试插入事件行；
> 3. 插入冲突（`(provider, eventId)` 已存在）→ 判定为重复投递，忽略后续处理；
> 4. 插入成功 → 才处理业务逻辑。
>
> 换句话说：**唯一索引是第二道防线，第一道是验签**。
> 只靠唯一索引，攻击者能预先占位；只靠验签，渠道的重复投递会重复处理。
> 两者都要有，且顺序不能反。
>
> 这张表**不带 `tenantId`**，因此不在 `TENANT_SCOPED_MODELS` 白名单里
> （它不是租户的数据，是渠道事件的数据）。租户从订单反查，不从事件里取。

---

## 四、购物车

### 4.1 游客购物车

1. 首次访问时，服务端生成 32 字节随机 `guestToken`，写进 **HttpOnly + SameSite=Lax** 的
   cookie（`cart_token`），有效期 30 天。
2. cookie 里**只有 token**，购物车内容在数据库（`carts.guestToken`）。
3. 游客在 A 店加购 → A 店下的 `carts` 行；去 B 店 → B 店下的另一行。
   **购物车按店铺分**，因为订单属于一个店铺。

### 4.2 登录合并

消费者登录后：

```
1. 取游客 token（cookie 里有）+ 当前租户
2. 若该租户下没有游客购物车 → 直接建账号购物车
3. 若两个都有 → 合并：
     对每个 skuId：
       两边都有 → 数量取 max(游客数, 账号数)（不是累加——
                  游客数和账号数很可能本来就是同一批意图，累加会翻倍）
       只有一边有 → 直接搬
     ⚠️ 搬进来的每一项都要**重新校验**：
        - SKU 是否还属于当前租户、还 ACTIVE、没被软删
        - 商品是否还上架
        - 数量是否超过上限（§4.3）
        - 合并后的总数量是否超过上限
       不合格的**直接丢弃**（不报错）——合并是个尽力而为的动作，
       游客车的陈旧内容不该让登录失败
4. 删游客购物车，清 cookie
```

> **数量取 max 而不是累加。** 同一个消费者在同一个 SKU 上很可能
> 「游客时加过 2 件、登录后账号里也有 2 件」——那是同一份意图的两份记录，
> 累加会变成 4 件。这个判断错了会直接导致超卖。

> **合并接口必须幂等。** 前端在登录后、跳转前会调一次；
> 网络重试或用户手快点两次，不能报「游客购物车不存在」。
> 游客购物车不存在时**直接返回成功**（购物车已经是合并后的状态了）。

> **合并也要限流与上限。** 一个游客车可能有几百个条目（每条都带 skuId），
> 合并时要限制单次处理的条目数，避免恶意构造超大 cookie + 大购物车拖垮服务。

> **合并不能跨店铺。** 游客在 A 店的购物车只合并到 A 店的账号购物车。
> 合并接口要带 `tenantId`（由请求的店铺决定），不能接受客户端传的租户标识。

### 4.3 加购校验

加购时校验：
- SKU 存在、属于当前租户、状态 `ACTIVE`、未软删
- 商品已上架（`Product.status === 'PUBLISHED'`）
- 数量 > 0，且不超过一个上限（比如 99，防止有人一次加 999999 件）

> **数量上限是必要的**。没有上限时，一次 `quantity: 999999` 就会让
> 后续所有下单都失败（库存不足），但那单商品还是会占着购物车显示。

---

## 五、订单与库存预占

### 5.1 下单事务

**下单必须幂等**——这是电商的基本要求。用户连点两次「提交订单」、
或网络超时后重试，都不该产生两个订单、两次预占。

```
BEGIN TX
  -- 0. 幂等键检查：同一个 idempotencyKey 直接返回已存在的订单
  SELECT * FROM orders WHERE "idempotencyKey" = ? AND "tenantId" = ?
  -- 命中就直接返回那个订单（200 + 同一个 orderNo），不再建单
  --
  -- 1. 锁定 SKU 行。⚠️ 必须**按 skuId 排序**后加锁，
  --    否则两个订单含两个 SKU 且顺序相反时会死锁（A→B vs B→A）。
  --    排序后全局加锁顺序一致，死锁不可能发生。
  --
  --    ⚠️ **逐条加锁，不要用一条 id IN (...)**（2026-10-24 实测修正）：
  --    一条 IN 查询的加锁顺序由**查询计划**决定（位图扫描按堆序、
  --    索引扫描按索引序），**不随 IN 列表的顺序变化**。
  --    也就是说：计划碰巧一致时不排序也不会死锁——但那是运气，
  --    计划一变（统计信息更新、索引增减、读写分离的副本）就可能不再一致。
  --    逐条加锁把「全局一致的加锁顺序」变成**实现的确定性保证**。
  --    N 个 SKU 就是 N 条语句，对下单这种低频路径完全够用。
  SELECT ... FROM skus WHERE id = ? AND "tenantId" = ? FOR UPDATE
  -- （对排好序的每个 skuId 各执行一次）
  -- 2. 校验：SKU 可售、商品上架、库存足够、数量不超上限
  -- 3. 建订单 + 订单项（快照商品名与规格）
  -- 4. 扣库存 + 记 RESERVE 流水
  --    ⚠️ Prisma 的 updateMany 不能在库里做算术，stock 是**应用侧算好后写绝对值**
  --    （与阶段 2 的 inventory.service.ts 一致）。行锁保证读到的一定是最新的。
  UPDATE skus SET stock = <算好的绝对值>, "stockVersion" = "stockVersion" + 1
  INSERT INTO inventory_movements (type='RESERVE', quantity=-qty, ...)
  -- 5. 清空购物车里已下单的条目
COMMIT
```

> **死锁时的错误码**：PostgreSQL 检测到死锁抛 `40P01`（deadlock detected），
> Prisma 把它包成 `PrismaClientKnownRequestError`（`code === 'P2034'`），
> **不是** `P2002`（唯一约束冲突）。处理超时/重试的代码要区分这两者。

**幂等键怎么来**：前端在进入结算页时生成一个 UUID（`crypto.randomUUID()`），
下单时放进 `idempotencyKey` 请求头或请求体，服务端存进订单表。

```prisma
model Order {
  // …
  // 幂等键。同一个键重复下单返回同一个订单，而不是新建一个。
  // 部分唯一索引：不同租户可以用同一个键（虽然不该，但不该因此报错）。
  idempotencyKey String?
}
```

```sql
CREATE UNIQUE INDEX "orders_tenant_idempotency_uniq"
  ON "orders" ("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
```

> **幂等键不能由服务端从订单内容推导**（比如「同一用户同一秒同一商品算同一单」）。
> 那样会把用户「真的想再买一次」的场景也合并掉。必须由客户端显式提供。

> **加了行锁还要乐观锁的 `stockVersion` 吗？** 要，但作用不同：
> 行锁保证并发下单不会丢更新；`stockVersion` 保证**管理端的人工调整**
>（阶段 2 的 `adjustments` 接口）与下单不会互相覆盖。两者都要，
> 更新语句带上 `stockVersion` 条件，受影响行数为 0 说明期间被人改过库存，
> 整个事务回滚并让调用方重试。

**为什么用 `FOR UPDATE` 行锁而不是阶段 2 的乐观锁**：
阶段 2 的乐观锁（`stockVersion` + `updateMany` where）适合**低频的人工调整**——
冲突了返回 409，让商家重试。但下单是**高频**操作，两个并发下单撞上同一个 SKU
是常态，乐观锁会大量返回 409。

所以下单走行锁（串行化同一 SKU 的扣减），**乐观锁保留给管理端的人工调整**。

> 阶段 2 的遗留项写着「计划 3 的高频扣减需要事务内重试」——**用行锁就不需要重试**，
> 这比「乐观锁 + 重试循环」更简单也更可靠。行锁的代价是同一 SKU 的并发下单会排队，
> 但那本来就是必须串行的（扣的是同一份库存）。

> **行锁的写法要绕开 Prisma 扩展**：`$queryRaw` 不经过扩展，
> 所以 SQL 里**必须**自己带 `tenantId` 条件。这是阶段 2 已经踩过的坑
> （`minPrice` 的原生 SQL 同样要手写租户条件）。

### 5.1.1 下单时的数量与金额校验

加购时校验过的东西，**下单时必须再校验一遍**——加购和下单之间可能隔了很久，
中间的加购请求也可能被构造出来绕过加购接口。

| 校验 | 说明 |
|------|------|
| `quantity` 上限 | 每行 ≤ 99，且订单总行数 ≤ 100（防止构造超大订单） |
| SKU 可售 | `status = 'ACTIVE'`、未软删、属于当前租户 |
| 商品上架 | `Product.status = 'PUBLISHED'` |
| 库存足够 | 逐个 SKU 比对 `stock` |
| **金额由服务端算** | `unitPrice` 从 SKU 读，**绝不从请求体读**。请求体里的任何价格字段一律拒绝（`forbidNonWhitelisted`） |

> **「金额由服务端算」是防篡改的唯一办法。** 客户端传 `unitPrice: 1`、
> 服务端照单全收，就是一个可以 1 分钱买走 100 元商品的漏洞。

### 5.2 库存流水的三个阶段

阶段 2 已在枚举里留位 `RESERVE` / `RELEASE` / `DEDUCT`，本阶段实现它们。

### 5.1.2 `stock` 的语义在阶段 3 变了（管理端文案要跟着改）

阶段 2 的 `Sku.stock` 是「当前库存」。引入预占后，它变成**可售库存**
（= 物理库存 - 已预占未支付）。

| 阶段 | `stock` 的含义 |
|---|---|
| 阶段 2 | 当前库存（= 可售库存，因为没有预占这回事） |
| 阶段 3 | **可售库存** |

**后台的文案必须改**，否则商家会困惑：明明仓库里有货，页面却显示 0。

> 「已预占」与「物理库存」的差额要么单独加一个字段展示，要么在库存台账里
> 用 RESERVE / RELEASE 流水的累计量算出来。**建议加 `reservedQuantity`
> 展示列**（由流水累计得出，不入库），让商家一眼看到「可售 12 / 已预占 3 / 实物 15」。

**关键：流水有两个不同语义的信息，别混。**

| 字段 | 语义 |
|------|------|
| `quantity` | **业务量**与方向：预占 5 件记 `-5`，释放记 `+5`，确认售出记 `-5` |
| `stockBefore` / `stockAfter` | **实际库存**的数值变化 |

三个阶段的实际库存变化：

| 阶段 | quantity | stock 变化 | 含义 |
|------|----------|------------|------|
| `RESERVE` | `-qty` | `stock -= qty` | 预占：可售库存减少，货还没卖出去 |
| `DEDUCT` | `-qty` | **不变** | 确认售出：预占时已经扣过了，这里只标记成交 |
| `RELEASE` | `+qty` | `stock += qty` | 释放：超时未支付或取消，把可售库存还回去 |

> **`DEDUCT` 的 `stock` 不变**是这套模型里最容易看错的地方：
> 它的 `quantity = -qty` 但 `stockBefore == stockAfter`。
> 因为预占时已经把库存扣掉了，支付成功只是把「预占」转成「已售」。
>
> **销量不要从流水统计**——流水里 `RESERVE` 与 `DEDUCT` 都是负数，会重复计数。
> 销量看 `order_items.quantity` 求和。

### 5.3 支付超时释放

下单成功时往 BullMQ 投一个 delayed job（**默认 15 分钟**，与 `orders.payExpiresAt` 一致）：

```
到点触发 → 尝试把订单从 PENDING_PAYMENT 改成 CLOSED（条件更新）
         → 成功（受影响行数 = 1）→ 释放预占（stock += qty，记 RELEASE 流水）
         → 失败（受影响行数 = 0）→ 订单已不是 PENDING_PAYMENT，什么都不做
```

> ### ⚠️ 必须是**条件更新**，不能是「先查后改」
>
> 「查一下状态，是 PENDING_PAYMENT 才改」在并发下是不安全的：
>
> ```
> T1（超时释放）              T2（支付回调）
> SELECT status → PENDING    SELECT status → PENDING
> UPDATE status = CLOSED     UPDATE status = PAID
> stock += qty               （不改库存）
> ```
>
> 两个事务都读到 `PENDING_PAYMENT`，都往下走。结果：**订单变成 PAID，
> 但库存被还了回去**——超卖。
>
> 正确做法是把状态判断放进 `UPDATE` 的 `where` 里，靠**受影响行数**判定谁赢了：
>
> ```typescript
> const closed = await tx.order.updateMany({
>   where: { id: orderId, status: 'PENDING_PAYMENT' },
>   data: { status: 'CLOSED', closedAt: new Date() },
> });
> if (closed.count === 0) return;   // 已经支付或已取消，不碰库存
> // 只有赢了的那一方才释放预占
> await releaseReservation(tx, order);
> ```
>
> 支付回调那侧同理：`updateMany({ where: { id, status: 'PENDING_PAYMENT' }, data: { status: 'PAID' } })`，
> 只有 `count === 1` 的那一方才算支付成功。
>
> **这是整个阶段 3 最关键的一处并发正确性**——两处更新用同一个
> `status = 'PENDING_PAYMENT'` 条件，数据库保证只有一方能赢。
>
> 顺带：队列的 delayed job 不保证准时，所以**不能依赖它的准时性**，
> 订单自己也有 `payExpiresAt` 字段，两边都要判。

### 5.4 取消订单

消费者主动取消（仅 `PENDING_PAYMENT` 可取消）：释放预占 + 订单转 `CANCELLED`。
与超时释放走**同一个释放函数**，避免两处逻辑漂移。

---

## 六、支付

### 6.1 抽象

```typescript
export interface PaymentProvider {
  readonly channel: string;

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  queryPayment(providerTxnId: string): Promise<QueryPaymentResult>;
  refund(paymentId: string, amount: number, reason: string): Promise<RefundResult>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): NormalizedWebhookEvent;
}
```

`CreatePaymentResult` 含 `{ providerTxnId, payload /* 支付页面所需的任意数据 */, expiresAt }`。
`payload` 是渠道相关的（微信是 code_url，支付宝是跳转 URL，假网关是本地页面 URL）。

### 6.2 本地假支付网关

`FakePaymentProvider`：

- `createPayment` → 返回一个本地 URL：`/pay/fake/{paymentId}`
  （实际带全局前缀，是 `/api/v1/pay/fake/{paymentId}`）
- 该页面是一个简单的 HTML：显示订单号与金额，一个「确认支付」按钮
- 点按钮 → 服务端把该支付单置 SUCCESS，**并主动调用自己的 webhook 处理逻辑**
  （模拟渠道回调）
- 一个「模拟支付失败」按钮

**必须由环境变量开关控制，生产环境禁用**：

```bash
FAKE_PAYMENT_ENABLED=true   # 仅本机开发
```

未开启时，`createPayment` 直接抛错。

> **这个开关是安全边界，不是便利开关。** 假网关的支付页面无需登录，
> 知道 `paymentId` 就能把订单付掉——在生产环境开启等于**任何人都能免费下单**。
> 所以：
> 1. 开关默认**关闭**（不设就是关）；
> 2. 假网关的 webhook 还要带一个共享密钥，密钥不对直接 401；
> 3. 生产配置的校验里要显式检查「`FAKE_PAYMENT_ENABLED=true` 且 `NODE_ENV=production`」
>    这个组合并**拒绝启动**（阶段 1 已经有 `assertSecureConfig` 做同类检查，
>    在那里加一条）。

> **为什么不让假网关真的发 HTTP 请求到 webhook 端点**：那会引入
> 「服务调自己」的自我依赖，在容器编排里还要处理网络地址问题。
> 直接调用同一段处理逻辑，既真实（幂等与状态机都被走到）又不脆弱。

### 6.3 幂等与金额核对

**金额核对（先于幂等处理）**：webhook 里的支付金额必须与订单金额一致，
不一致**拒绝流转**并记一条告警——不然后果是「付了 1 分钱却把 100 元的订单标记成已支付」。

```
webhook 到达 → 验签 → 查订单 → 比对金额
   ├─ 金额不等 → 拒绝，告警，人工介入
   └─ 金额相等 → 进幂等流程
```

**幂等：三道防线**：

1. **`payment_webhook_events` 的 `(provider, eventId)` 唯一索引**
   —— 同一个渠道事件重复到达，插入时冲突 → 直接忽略后续处理
2. **`payments` 的 `(orderId, channel)` 唯一索引**
   —— 同一订单同一渠道不会落两笔支付单
3. **状态机的终态检查**
   —— 已 `SUCCESS` 的支付单收到 `SUCCESS` 事件，不做任何事（只记录事件）

> **三道都要有。** 只靠第 1 道，攻击者可以用不同的 eventId 重复同一笔交易；
> 只靠第 3 道，「记录事件」这一步本身可能被并发打两次。

### 6.4 webhook 端点

```
POST /api/v1/webhooks/payment/{channel}
```

- **不挂 JWT**（渠道回调没有登录态）
- **必须验签**（真实渠道用渠道公钥验签；假网关用共享密钥）
- **不挂租户上下文**——渠道回调不带子域名，租户从 `orderId` 反查
- 处理逻辑入队（BullMQ），消费端做幂等

> **webhook 端点不受租户隔离机制保护**（它没有租户上下文）。
> 所以它必须：① 验签 ② 从订单反查租户 ③ 只按订单 id 操作。
> 绝不能接受请求体里的 `tenantId`。

---

## 七、订单状态机

```
                    ┌──────────────┐
   下单 ───────────→│PENDING_PAYMENT│←── 消费者取消 ──┐
                    └──────┬───────┘                 │
                           │ 支付成功                 │ 释放预占
                    ┌──────▼───────┐                 │
                    │     PAID     │─────────────────┤
                    └──┬────────┬──┘                 │
             确认收货  │        │ 退款                │
              ┌───────▼──┐  ┌──▼────────┐            │
              │COMPLETED │  │ REFUNDED  │            │
              └──────────┘  └───────────┘            │
                                                   │
                                        ┌──────────▼───────┐
                                        │ CANCELLED/CLOSED │
                                        └──────────────────┘
```

| 状态 | 含义 | 可转出到 |
|------|------|---------|
| `PENDING_PAYMENT` | 已下单，库存已预占，等待支付 | `PAID` / `CANCELLED` / `CLOSED` |
| `PAID` | 已支付 | `SHIPPED` / `REFUNDED` |
| `SHIPPED` | 已发货 | `COMPLETED` / `REFUNDED` |
| `COMPLETED` | 已确认收货 | —— |
| `CANCELLED` | 用户主动取消，库存已释放 | —— |
| `REFUNDED` | 已退款，库存**不**回补（本期只支持整单退款，退款后退货是另一件事） | —— |
| `CLOSED` | 超时未支付，库存已释放 | —— |

> **状态流转必须在 service 层集中校验**，不能散落在各个 controller 里。
> 用一张「允许的转移表」驱动，越权流转直接抛 409。

### 7.1 退款

整单退款：`PAID` / `SHIPPED` → `REFUNDED`，调用 `provider.refund()`。

> **退款不把库存加回去。** 货已经发出去了，退的是钱不是库存。
> 「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
> 这个取舍要在商家后台的文案里说明，别让商家以为退完款库存就回来了。

---

## 八、多租户边界

| 实体 | 租户归属 |
|------|---------|
| 购物车 | 按店铺分（`carts.tenantId`） |
| 地址簿 | 租户级（消费者的地址在注册的店铺内） |
| 订单 | **一个订单只属于一个店铺** |
| 支付单 | 跟随订单 |
| 库存流水 | 跟随 SKU（因而跟随店铺） |

**跨店铺下单在模型上就不可能**——`order_items` 里的 SKU 都属于同一个租户，
下单事务里 `SELECT ... WHERE "tenantId" = ?` 已经保证了这一点。

> **一个订单必须全部商品来自同一店铺。** 这不是限制而是必然：
> 不同店铺的 SKU 库存、支付、退款都是独立的，混在一单里没法算账。
> 购物车在 UI 上也按店铺分组显示。

---

## 九、Redis 与队列

| 项 | 值 |
|---|---|
| 端口 | 16380（宿主）/ 6379（容器）——本机标准端口已被占用 |
| 队列 | `payment-timeout`（延迟任务）、`payment-webhook`（异步消费） |
| 延迟 | 15 分钟 |

**任务的 `jobId` 必须去重**：BullMQ 的 `jobId` 相同的任务不会重复入队。

- 超时释放任务：`jobId = "timeout-" + orderId`
  —— 同一个订单只会有一个超时任务，不会因为重试下单而排多个
- webhook 消费任务：`jobId = "webhook-" + provider + "-" + eventId`
  —— 同一事件重复投递时队列层面就挡掉了（与数据库的唯一索引形成双保险）

> ⚠️ **jobId 不能含冒号**（2026-10-24 实测修正）：BullMQ v6 会抛
> `Custom Id cannot contain :`，只有恰好三段且每段是 UUID 的形式被放行。
> 所以用连字符 `-` 而不是冒号 `:`。

> **BullMQ 的 jobId 去重不等于幂等。** 队列保证「同一个 jobId 不入队两次」，
> 但**消费端仍要幂等**——任务可能在消费途中进程崩溃，重启后被重新投递。
> 消费端的幂等靠数据库的唯一索引（§6.3 的三道防线）。

**新增基础设施依赖的取舍**：多一个 Redis 容器，但省掉了「自建轮询 + 分布式锁」
的一整套东西。对一个要给别人当模板的项目，BullMQ 是电商后台的默认选择。

**不引 Redis 的替代方案**（数据库轮询）被否掉了，原因记录在案：
轮询的延迟不可控（要轮询就得高频轮询），且多实例部署时要有分布式锁。

---

## 十、接口清单

### 10.1 消费者侧（storefront）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/cart` | 当前购物车（游客或登录） |
| POST | `/api/v1/cart/items` | 加购 |
| PATCH | `/api/v1/cart/items/:id` | 改数量 |
| DELETE | `/api/v1/cart/items/:id` | 删除条目 |
| DELETE | `/api/v1/cart` | 清空 |
| POST | `/api/v1/cart/merge` | 登录后合并游客购物车 |
| GET | `/api/v1/addresses` | 地址簿列表 |
| POST | `/api/v1/addresses` | 新增地址 |
| PATCH | `/api/v1/addresses/:id` | 改地址 |
| DELETE | `/api/v1/addresses/:id` | 删地址（软删） |
| POST | `/api/v1/orders` | 下单（预占库存） |
| GET | `/api/v1/orders` | 我的订单列表 |
| GET | `/api/v1/orders/:orderNo` | 订单详情 |
| POST | `/api/v1/orders/:orderNo/pay` | 发起支付（建支付单，返回支付页面 URL） |
| POST | `/api/v1/orders/:orderNo/cancel` | 取消订单 |
| POST | `/api/v1/orders/:orderNo/confirm` | 确认收货 |

### 10.2 商家侧（merchant-admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/merchant/orders` | 订单列表（按状态/时间筛选） |
| GET | `/api/v1/merchant/orders/:orderNo` | 订单详情 |
| POST | `/api/v1/merchant/orders/:orderNo/ship` | 发货（填快递单号） |
| POST | `/api/v1/merchant/orders/:orderNo/refund` | 整单退款（**不回补库存**） |

> ⚠️ **商家侧的路径带 `merchant/` 前缀**（2026-10-24 实施时修正）。
> 原先两侧都写 `/api/v1/orders`，但两侧的**鉴权方式不同**
> （消费者侧 `OptionalJwtAuthGuard` 允许游客，商家侧 `JwtAuthGuard` + `@Roles`）。
> 同一个路径挂两套守卫时，NestJS 按注册顺序匹配，**后注册的那整套会被
> 完全遮住**——商家会被消费者的守卫挡成 403。
>
> 带前缀也符合项目既有约定：管理端接口都带域名前缀
> （`catalog/products`、`inventory/adjustments`）。

### 10.3 支付与内部

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/webhooks/payment/:channel` | 渠道回调（**无 JWT、需验签**） |
| GET | `/api/v1/pay/fake/:paymentId` | 假网关的支付页面（仅 `FAKE_PAYMENT_ENABLED` 时可用） |

> ⚠️ **`/pay/fake/:paymentId` 带 `/api/v1` 前缀**——`main.ts` 设了
> `setGlobalPrefix('api/v1')`，所有路由都在它下面。
>
> ⚠️ **`/pay` 与 `/refund` 两个端点原先漏在清单外**（2026-10-24 补上）。
> 没有它们，消费者无从发起支付、商家无从触发退款，
> 而状态机里的 `PAID` 与 `REFUNDED` 就没有入口。
>
> **两个端点都归 payment 模块**——它们要用 `createPayment` / `refund`，
> 而 order 模块不依赖 payment 模块（依赖方向单向：`payment → order`）。

---

## 十一、测试与验收

延续阶段 2 的做法：**每个关键护栏都要做失败注入**。

### 11.1 必测的护栏

> ⚠️ **两套编号，别混**：本表的 1–20 是**护栏编号**（验收按它逐条核对），
> §十二 的 R1–R16 是**风险编号**（讨论设计时用）。
> 实施计划初稿里把护栏编号写成了「R4」「R5」这样的形式，
> 于是同一串字符在两套体系里指两件事——已于 2026-10-24 全部改正，
> 权威对照表见实施计划 `2026-10-24-plan-03-transaction.md` 的 §0.6。

| # | 护栏 | 失效后果 |
|---|------|---------|
| 1 | 购物车合并取 max 而不是累加 | 同一份意图被算成两份，超卖 |
| 2 | 合并要重新校验 SKU 与上架状态、数量上限 | 游客车里的陈旧内容带进正式订单 |
| 3 | 合并接口幂等 | 重试导致「游客购物车不存在」而登录失败 |
| 4 | 下单的行锁确实把并发下单串行化（两个并发下单，库存只减一次） | 丢失更新，超卖 |
| 5 | 下单按 skuId 排序加锁 | 两个订单含两个 SKU 且顺序相反 → 死锁 |
| 6 | 下单幂等键 | 连点提交订单 → 两个订单、两次预占 |
| 7 | 跨租户下单被拒（把 A 店的 SKU 放进 B 店的订单） | 跨租户超卖，账目错乱 |
| 8 | 订单金额不能被客户端传的价格篡改 | 1 分钱买走 100 元商品 |
| 9 | 库存预占不足时整单失败，不留半截订单 | 有订单没库存，或有库存没订单 |
| 10 | **状态流转用条件更新**（`updateMany` where 带 `status`），不用「先查后改」 | 支付回调与超时释放并发 → 已支付但库存被还回去 |
| 11 | webhook **验签后才落库** | 攻击者预占 eventId → 真实支付回调被丢弃，钱付了订单不流转 |
| 12 | webhook 幂等：同一事件重复到达只处理一次 | 重复扣款、重复流转 |
| 13 | webhook 的支付金额与订单金额比对后才流转 | 付 1 分钱却把 100 元订单标记已支付 |
| 14 | webhook 端点不采信请求体里的 tenantId | 跨租户篡改订单 |
| 15 | 订单状态机拒绝非法流转（如 `COMPLETED` → `PAID`） | 状态乱序，账目对不上 |
| 16 | 假支付网关在生产配置下拒绝启动 | 生产环境任何人可免费下单 |
| 17 | 退款不回补库存 | 商家以为退完款库存就回来了 |
| 18 | BullMQ jobId 去重 + 消费端幂等 | 重复投递导致重复处理 |
| 19 | 地址簿默认地址唯一 | 「取默认地址」返回哪条不确定 |
| 20 | 地址的 customerId 归属当前租户 | 跨租户挂载地址 |

### 11.2 覆盖缺口要主动交代

阶段 2 有两项护栏最终是「无自动化覆盖」的（前端没有测试框架，
后来补上了）。本阶段要把「哪些没测到」明确写出来，而不是含糊过去。

---

## 十二、风险清单

按「能不能被外部利用」排序。前 6 条是**可被利用的漏洞**，其余是正确性风险。

### 12.1 可被利用的漏洞

| # | 风险 | 攻击路径 | 后果 | 已采取的措施 |
|---|------|---------|------|-------------|
| R1 | webhook 事件表被未验签请求写入 | 抢先用 `eventId=X` 发伪造回调占位 | 真实支付回调被当重复事件忽略，**钱付了订单永不流转** | §3.7：**先验签后落库**；唯一索引只是第二道防线 |
| R2 | `payments` 缺 `(provider, providerTxnId)` 唯一索引 | 用不同 eventId 重放同一笔交易 | 同一笔交易落成两条支付单，对账全乱 | §3.6 补索引（本设计原正文与代码不一致，已对齐） |
| R3 | 假支付网关在生产可用 | 知道 paymentId 就能把订单付掉 | 任何人可免费下单 | §六.2：默认关闭 + 共享密钥 + 生产组合拒绝启动 |
| R4 | 订单金额采信客户端传入 | 请求体里带 `unitPrice: 1` | 1 分钱买走 100 元商品 | §5.1.1：金额只从 SKU 读，请求体里的价格字段被 `forbidNonWhitelisted` 拒掉 |
| R5 | 支付回调与超时释放并发 | 两者都读到 `PENDING_PAYMENT` | **已支付但库存被还回去**（超卖） | §5.3：条件更新 + 受影响行数判定，不再「先查后改」 |
| R6 | webhook 端点采信请求体里的 tenantId | 构造回调指定别的租户 | 跨租户篡改订单 | §六.4：租户从订单反查，只按订单 id 操作 |

### 12.2 正确性风险

| # | 风险 | 后果 | 措施 |
|---|------|------|------|
| R7 | 下单无幂等键 | 连点提交 → 两个订单、两次预占 | §5.1 客户端提供 `idempotencyKey` + 部分唯一索引 |
| R8 | 下单加锁顺序不定 | 两单含两 SKU 且顺序相反 → 死锁 | §5.1 按 `skuId` 排序后一次性加锁 |
| R9 | 购物车合并累加数量 | 同一意图算两份 → 超卖 | §4.2 取 max |
| R10 | 合并时不重新校验 | 陈旧的游客条目带进正式订单 | §4.2 逐项重校验，不合格直接丢弃 |
| R11 | 下单不校验数量上限 | 绕过加购接口构造超大订单 | §5.1.1 下单时再校验一次 |
| R12 | 库存流水的 `DEDUCT` 数量与库存变化不一致 | 被误读成扣了两次，销量算错 | §5.2 明确两套语义；销量一律看 `order_items` |
| R13 | 阶段 2 的 `stock` 语义变成「可售」 | 商家困惑「有货却显示 0」 | §5.1.2 后台文案与展示列要改 |
| R14 | 地址簿多条默认地址 | 取默认地址不确定，可能取到已删的 | §3.3 部分唯一索引 |
| R15 | BullMQ 重复投递 | 重复处理 | §九 `jobId` 去重 + 消费端幂等 |
| R16 | 阶段 3 的 `orders` / `payments` 等表忘登记白名单 | 服务启动直接失败 | §三 开头已点明；写完对照 schema 逐个核 |

### 12.3 设计阶段的疏漏（已在本轮修掉）

本设计初稿有 6 处内部不一致或未定义，审查时发现并已修：

1. `payments` 的正文列了 `(provider, providerTxnId)` 唯一索引，代码里没有，且表缺 `provider` 字段 → R2
2. webhook 事件表没说明「必须验签后才落库」→ R1
3. 下单流程没有幂等键 → R7
4. 超时释放写的是「重查订单状态」，并发下不安全 → R5
5. 下单加锁没规定顺序 → R8
6. `orderNo` 的生成规则里有「租户短码」，但 `tenants` 表没有这个字段 → 已改为纯随机

---

## 十三、遗留项与已知取舍

| # | 事项 | 影响 | 建议 |
|---|------|------|------|
| 1 | 跨店会员不支持 | 消费者在 A 店注册后不能在 B 店用同一身份 | 阶段 4 之后单独立项：把消费者从租户作用域拆出来 |
| 2 | 退款不回补库存 | 商家退完款，库存不会自动加回 | 做「退货入库」流程时要一起设计 |
| 3 | 假支付网关在生产禁用 | 真实上线前必须接上真渠道 | 抽象层已就位，填密钥 + 写签名校验即可 |
| 4 | 订单金额不含运费与优惠 | 阶段 4 加优惠时要重算历史订单？ | 建议阶段 4 只对新订单生效，历史订单不改 |
| 5 | 无跨店合并下单 | 一个订单只能一个店铺 | 模型上必然，不是限制 |
| 6 | BullMQ 的 delayed job 不保证准时 | 超时释放可能晚几分钟 | 订单状态判断兜底（幂等），不依赖准时性 |
| 7 | 库存流水的 `DEDUCT` 数量与库存变化不一致 | 容易被误读成扣了两次 | 销量一律看 `order_items`，流水只做审计 |
| 8 | **游客订单查不到** | `orders.customerId` 为空，消费者下完单只能靠订单号 + 联系方式查 | 补一个「按联系方式查最近订单」的查询，或本阶段就要求游客下单前登录 |
| 9 | 并发创建购物车可能撞唯一索引 | 两个并发请求都为同一消费者建购物车 | 捕获 P2002 后重查并复用，不要把 500 抛给用户 |
| 10 | 阶段 3 改变 `stock` 的语义 | 已有生产数据的可售库存含义变了 | 生产部署前需要跑一次「按流水重算可售库存」的迁移脚本 |

---

## 附：与既有设计的关系

主设计文档（`2026-10-21-multi-tenant-ecommerce-saas-design.md`）的
§八 支付架构、§九 库存与订单事务是本阶段的设计基础，
§六 的数据模型表里 `carts` / `orders` / `order_items` / `payments` /
`addresses` / `inventory_movements` 在阶段 2 已部分落地，本阶段补齐。
主设计文档的 §十（营销与计费）留给阶段 4。
