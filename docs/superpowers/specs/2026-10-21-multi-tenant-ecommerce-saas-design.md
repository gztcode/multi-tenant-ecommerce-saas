# 多租户电商 SaaS 平台 — 设计文档

| 项目 | 说明 |
|------|------|
| 文档日期 | 2026-10-21 |
| 文档状态 | 待用户审阅 |
| 目标交付范围 | 完整多租户电商 SaaS 平台（多阶段交付，阶段 1 先落地） |
| 当前目录 | `电商项目/`（空仓库，仅含初始提交） |

---

## 一、目标与非目标

### 1.1 目标

构建一个**多租户电商 SaaS 平台**，作为可复用的电商底座（template base），具备如下特征：

- 单实例服务多个独立商家，每个商家拥有自己的店铺、商品、订单、客户
- 商家可以接入自己的支付方式、配置主题、管理商品与订单
- 平台方可以管理商家、配置套餐与抽佣、查看全局数据
- 后端 API 真正可被第三方复用（前后端完全分离）
- 为后续扩展（多通道支付、营销玩法、国际化、开放生态）预留接入点

### 1.2 非目标（阶段 1 不做）

- 不做 i18n / 多语言：界面文案先中文
- 不做开放 API / Webhook 生态：留接口层但不暴露文档
- 不做微服务：阶段 1 为模块化单体
- 不做 K8s 部署：阶段 1 用 Docker Compose；阶段 2+ 视情况
- 不做主题可视化编辑器：阶段 1 商家通过表单配置 token

---

## 二、阶段 1 详细范围

阶段 1 是落地本次设计的第一个独立交付物，目标是**跑通一个能下单、能结算的多租户电商底座**。

### 2.1 必须交付的功能

| 模块 | 内容 |
|------|------|
| 租户与店铺 | 商家注册、登录；店铺创建；子域名解析；店铺状态（试用 / 激活 / 暂停） |
| 身份与权限 | 平台超管 / 商家后台用户 / 终端消费者 三类身份；JWT + Refresh；RBAC |
| 商品中心 | 商品、分类（含层级）、属性、SKU、媒体；商品状态（草稿 / 上架 / 下架） |
| 库存 | 单仓；预占、释放、扣减；事务化 |
| 购物车与订单 | 未登录/登录购物车合并；下单状态机；订单列表与详情；基础退款 |
| 支付 | 微信支付、支付宝 双通道；统一 `PaymentProvider` 抽象；webhook + 队列重试 |
| 营销 | 优惠券（满减、订单级）；满减活动 |
| 平台计费 | 商家订阅套餐；按月扣费；平台抽佣比例；订单结算记账 |
| 店铺前台 | 商品浏览、下单、支付二维码、个人中心（订单、地址） |
| 商家后台 | 数据看板、商品上下架、订单处理、库存、优惠、营销、设置、订阅 |
| 平台超管后台 | 商家管理、套餐与抽佣配置、平台收入报表 |
| 主题 | CSS Token 多主题；每个商家一套主题配置 |
| 基础设施 | Docker Compose 编排；日志；监控入口（health 探活） |

### 2.2 阶段 1 验收标准

- 能注册一个新商家，开通店铺，配置子域名，发布商品
- 消费者访问子域名，能浏览商品、加购、下单、扫码支付、查看订单
- 商家后台能看见新订单、处理订单、配置优惠、查看销售数据
- 平台超管能管理商家、查看平台收入
- 两个支付通道的回调（微信支付、支付宝）在断网时队列能重试，不丢单
- 单元测试覆盖率 ≥ 60%，关键路径（下单、支付回调、库存预占）有 e2e 测试

---

## 三、阶段 2–5 高层路线图

每个阶段是独立的 spec → 实施计划流程。阶段 1 完成后逐个迭代。

| 阶段 | 内容 | 估计工作量 |
|------|------|-----------|
| 阶段 2 — 交易闭环加固 | 多种支付通道、Stripe 接入、退款/售后/退货流程、邮件/短信通知、物流跟踪、库存多仓 | 3–4 周 |
| 阶段 3 — 营销增长 | 会员等级、积分、限时折扣、推荐位、组合套餐、分享返利、商家报表 | 3 周 |
| 阶段 4 — 平台计费深化 | 自助续费/升降级、税务、对账、审计日志、主题市场、应用市场雏形 | 2–3 周 |
| 阶段 5 — 国际化与生态 | 多语言、多币种、开放 API、Webhook、应用市场、第三方登录 | 3 周（可选） |

---

## 四、整体架构

### 4.1 前后端完全分离

四个**独立项目**，互不依赖源码，类型通过 OpenAPI 共享：

```
电商项目/
├─ api/                # NestJS 后端
├─ storefront/         # Next.js 消费者店铺前台（单实例，按子域名服务多店铺）
├─ merchant-admin/     # Next.js 商家后台
├─ platform-admin/     # Next.js 平台超管后台
└─ infra/              # Docker Compose、Nginx、CI 脚本、风格基线文档
```

部署上四个项目可以各自独立发布、独立扩缩容。开发时本地用 `infra/` 目录的 docker-compose 一把拉起。

### 4.2 后端模块化单体

阶段 1 后端**不拆微服务**，而是模块化单体。理由：业务耦合度高、初期带宽不够拆服务。

模块划分为两层：

- **基础设施层（横向能力）**：`auth`、`tenancy`、`rbac`、`payment`、`media`、`messaging`、`queue`
- **业务模块**：`tenants`、`stores`、`catalog`、`inventory`、`cart`、`orders`、`marketing`、`billing`、`customers`

每个业务模块是一个 NestJS module，包含 controller / service / repository / dto / entity。

---

## 五、项目目录结构（草案）

```
api/
├─ src/
│  ├─ modules/
│  │  ├─ auth/
│  │  ├─ tenancy/
│  │  ├─ catalog/
│  │  ├─ inventory/
│  │  ├─ cart/
│  │  ├─ orders/
│  │  ├─ marketing/
│  │  ├─ billing/
│  │  ├─ stores/
│  │  ├─ tenants/
│  │  └─ customers/
│  ├─ infra/                 # Prisma client, Redis, queue, storage, logger
│  ├─ common/                # interceptors, filters, decorators, pipes
│  └─ main.ts
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts
├─ test/
├─ Dockerfile
└─ package.json

storefront/
├─ app/                      # Next.js App Router
│  ├─ (storefront)/[...slug] # 动态店铺路由
│  └─ api/                   # BFF（可选）
├─ components/
├─ lib/                      # 客户端 SDK、token 解析
├─ public/
├─ Dockerfile
└─ package.json

merchant-admin/
├─ app/                      # Next.js App Router
│  ├─ (auth)/login
│  ├─ (dashboard)/products
│  ├─ (dashboard)/orders
│  └─ ...
├─ components/
├─ Dockerfile
└─ package.json

platform-admin/              # 同 merchant-admin 结构，路由和权限不同
```

`infra/` 目录（共用，放 docker-compose 与 nginx 配置）：

```
infra/
├─ docker-compose.yml        # Postgres + Redis + MinIO + api + 3 web
├─ nginx/                    # 反向代理、子域名路由
└─ ci/                       # CI 脚本模板
```

---

## 六、数据模型概要

完整 schema 在阶段 1 实施时细化。下面是阶段 1 关键表与字段（每张业务表都带 `tenantId`）：

| 表 | 关键字段 |
|----|----------|
| `tenants` | id、name、subdomain、status、subscriptionPlanId、createdAt |
| `users` | id、tenantId(role=platform 时为 null)、email、phone、passwordHash、role |
| `stores` | id、tenantId、name、slug、status、themeTokens(jsonb)、paymentConfig(jsonb) |
| `categories` | id、tenantId、parentId、name、slug |
| `products` | id、tenantId、categoryId、name、description、status、mediaIds[]、attributes(jsonb) |
| `skus` | id、productId、tenantId、skuCode、price、stock、attributes(jsonb) |
| `carts` | id、tenantId、customerId(可空)、items(jsonb)、createdAt |
| `orders` | id、tenantId、orderNo、status、totalAmount、discountAmount、payAmount、customerId、addressId、paymentChannel、createdAt |
| `order_items` | id、orderId、tenantId、skuId、qty、unitPrice、subtotal |
| `payments` | id、tenantId、orderId、channel、status、providerTxnId、amount、rawResponse(jsonb) |
| `coupons` | id、tenantId、code、type、value、minOrderAmount、startsAt、endsAt、usageLimit |
| `inventory_movements` | id、tenantId、skuId、type(reserve/release/deduct/restock)、qty、refOrderId |
| `subscription_plans` | id、tenantId(null 表示平台级)、name、price、features(jsonb) |
| `subscriptions` | id、tenantId、planId、startedAt、expiresAt、status |
| `commissions` | id、tenantId、orderId、rate、amount、status、settledAt |
| `media` | id、tenantId、url、key、mime、size、uploadedBy |
| `addresses` | id、tenantId、customerId、receiver、phone、province、city、detail |
| `audit_logs` | id、tenantId、actorId、action、target、payload(jsonb)、createdAt |

### 6.1 多租户隔离实现

- 所有业务表必带 `tenantId` 字段（在 schema 中通过 Prisma middleware 强制）
- 后端拦截器（`TenancyInterceptor`）：从 JWT / 子域名 / 路由参数解析 `tenantId`，注入到请求上下文
- 所有写入操作必须带 `tenantId`；不带的请求被拒绝
- 所有读取通过 Prisma extension 自动追加 `where: { tenantId }`
- 跨租户操作只在 `role = platform_admin` 且显式指定 target tenantId 时允许
- 阶段 1 不做应用层加密；如果未来需要企业级合规，可升级到独立数据库

**哪些方法被拒绝、哪些被改写：**

| 方法 | 处理 | 原因 |
|------|------|------|
| `findMany` / `findFirst` / `findFirstOrThrow` / `count` / `aggregate` / `groupBy` | 自动合并 `where.tenantId` | 支持非唯一 where 条件 |
| `create` / `createMany` / `createManyAndReturn` | 自动注入 `data.tenantId` | 同上 |
| `updateMany` / `updateManyAndReturn` / `deleteMany` | 自动合并 `where.tenantId` | 同上 |
| `findUnique` / `findUniqueOrThrow` / `update` / `updateOrThrow` / `delete` / `deleteOrThrow` / `upsert` | **在租户作用域模型上直接拒绝** | 这些方法的 `where` 只接受唯一字段，无法附加 `tenantId` 条件 |

> Prisma 6 移除了 `updateOrThrow` / `deleteOrThrow`（裸 client 上就是 `undefined`），因此这两个方法不存在绕过风险，但仍在拒绝名单里以防将来 Prisma 加回来。

**原生 SQL 旁路：**

`$queryRaw` / `$queryRawUnsafe` / `$executeRaw` / `$executeRawUnsafe` 不经过扩展，不会附加 `tenantId` 条件，属于**有意不暴露**的旁路：阶段 1 的 `TenantPrismaService` **不提供**这四个方法。将来确需原生 SQL 时（报表、聚合），必须以显式注入租户条件的专用 wrapper 形式加回，而不是裸暴露 Prisma 原方法。

**嵌套写操作：**

关系字段下的嵌套写（`data: { tenant: { connect: {...} } }`）被拒绝——嵌套 payload 无法自动注入 `tenantId`。判定采用 **schema 驱动**：用 Prisma 的 datamodel 取出模型的关系字段名，只有关系字段下的对象/数组才判定为嵌套写。Json 字段（如 `themeTokens`）里的任意 key 都是商家自定义数据，不受影响。

### 6.2 邮箱唯一性模型

邮箱属于「这个人」，但账号是「这个人在某个身份下的存在」。因此唯一性按角色分层：

| 角色 | 唯一性范围 | 理由 |
|------|-----------|------|
| `PLATFORM_ADMIN` | 全局唯一 | 平台管理员就一个人 |
| `MERCHANT_OWNER` | 全局唯一 | 店主账号就是「这个人在平台上的身份」。要经营第二家店应当用 `MERCHANT_STAFF` 身份，而不是再开一个店主账号——否则登录时按邮箱跨租户查账号会命中多个候选，落点不确定 |
| `MERCHANT_STAFF` | 租户内唯一 | 店员是「某个人在某家店的岗位」，与消费者同属店铺内的普通账号 |
| `CUSTOMER` | 租户内唯一 | 顾客在每家店各有一个账号 |

这四层全部由**部分唯一索引**表达（Prisma schema 表达不了条件唯一约束）：

```sql
CREATE UNIQUE INDEX "users_platform_admin_email_key"
  ON "users" (LOWER("email")) WHERE "tenantId" IS NULL AND "role" = 'PLATFORM_ADMIN';
CREATE UNIQUE INDEX "users_merchant_owner_email_key"
  ON "users" (LOWER("email")) WHERE "role" = 'MERCHANT_OWNER';
CREATE UNIQUE INDEX "users_customer_email_ci_key"
  ON "users" (LOWER("email"), "tenantId") WHERE "role" IN ('CUSTOMER', 'MERCHANT_STAFF');
```

**注意**：不能用 `@@unique([tenantId, email])` 这类不含角色的约束——它比上面三条都严格，会把「店主在自己开的店里当消费者下单」这种正常用法也挡在前面，抛出无法解释给用户的冲突。

**跨租户同邮箱的消费者登录**：按创建时间升序取候选，保证落点确定（最早创建的优先）。店铺前台接入后（计划 10）应带上店铺子域名，把顾客登录限定在当前店铺内。

### 6.3 子域名与租户标识

**子域名是路由标识，不是凭证。** 任何客户端都能设 `X-Tenant-Subdomain` 头，猜到别人的子域名就能以那个租户的身份发起请求。因此：

| 约定 | 说明 |
|------|------|
| 头由网关写入 | `X-Tenant-Subdomain` 由网关从 Host 反推后注入。**网关必须先剥除客户端传来的同名头** |
| 头仅供内部调用 | 显式头优先于 Host，是为了支持 storefront 服务端渲染这类没有店铺 Host 的内部调用 |
| 真正的访问控制来自认证 | 匿名接口只能读到该店铺的公开数据；租户内的私有数据一律走认证 + RBAC |
| 保留子域名 | `admin` / `api` / `www` / `platform` 等基础设施保留名不允许商家注册，也不允许解析——防止子域名接管，并避免攻击者通过响应差异枚举商家目录 |
| 格式单一来源 | 写入侧（注册 DTO）与读取侧（解析）必须共用 `SUBDOMAIN_PATTERN`，两边漂移是静默失效 |

**跨进程任务的租户上下文**：`AsyncLocalStorage` 的上下文只存在于当前异步调用链内。队列消费者、定时任务这些跨进程的地方**完全没有上下文**，必须用 `runForTenant(tenantId, fn)` 显式重建，且回调必须是 async 函数。任务载荷里的 `tenantId` 必须由已认证的创建方签发，消费者不应取自客户端提交的内容。

### 6.4 停用与令牌

商家被平台置为 `SUSPENDED` 后，**该租户全部成员已签发的 access token 必须立即失效**，不能等到 JWT 自然过期（默认 2 小时）——否则「停用」这个管理动作形同虚设。

实现方式：`JwtStrategy.validate()` 在查到用户后额外确认其租户未被停用，命中即 401。平台超管没有 `tenantId`，不受此约束。

代价是每条需要认证的请求多一次租户状态查询。阶段 1 接受这个开销；后续若成为瓶颈，可在租户表上加短 TTL 缓存，或引入令牌版本号机制。

**登录侧对应**：`TenantResolverService.resolveBySubdomain()` 对 `SUSPENDED` 的租户直接抛 404，匿名请求无法再进入已停用店铺。

### 6.2 唯一性约束约定

PostgreSQL 的复合唯一约束在任一列为 `NULL` 时**整行不参与唯一性判定**。这意味着 `@@unique([tenantId, email])` 对 `tenantId` 为 null 的平台超管完全无效——同一个平台超管邮箱可以被插入任意多条，而登录逻辑若用「多候选 + 逐个比对密码」的方式实现，登录结果将取决于记录顺序。

因此阶段 1 用两条原生 SQL 索引补齐（Prisma schema 无法表达表达式索引与部分唯一索引，故放在迁移里）：

| 索引 | 作用 |
|------|------|
| `users_email_ci_key` | `UNIQUE (LOWER(email), tenantId)` —— 租户内大小写不敏感的邮箱唯一 |
| `users_platform_admin_email_key` | `UNIQUE (LOWER(email)) WHERE tenantId IS NULL AND role = 'PLATFORM_ADMIN'` —— 平台超管邮箱唯一 |

配套约定：

- 应用层写入一律把 `email` 小写化，查询侧同样小写化后再匹配（`@@index([email])` 服务精确匹配）
- `subdomain` 同样统一小写化；`tenants.subdomain` 保留 Prisma 的普通唯一约束（子域名本身是人工录入的，不存在大小写变体问题）
- 上述两条索引由迁移创建，**不要删除 schema 里 `@@unique([tenantId, email])`**——它是 `prisma db push` 等同步路径下唯一的兜底约束

### 6.3 索引策略

后续所有带 `tenantId` 的业务表统一遵循：

- 用 `@@unique([tenantId, 业务键])` 保证租户内唯一
- **不再单独建 `@@index([tenantId])`**——复合唯一索引的最左前缀已能服务「按 tenantId 查询」，多建一份只会拖慢写入
- 例外：`users` 因为 `tenantId` 可空，需要额外保留 `@@index([email])` 用于登录时的跨租户精确匹配

### 6.4 数据删除策略

阶段 1 采用「状态停用」而非「物理删除」：

| 场景 | 做法 |
|------|------|
| 停用商家 | `tenants.status = SUSPENDED`，数据保留，登录与下单被拒 |
| 商家注册失败回滚 | 物理删除刚创建的租户及其下数据（唯一的物理删除路径） |

`onDelete: Cascade` 的语义是「租户记录消失则其下的用户、店铺、刷新令牌一并消失」。因为 `tenants` 是数据的根：

- **业务代码不得暴露删除租户的能力**——只有注册回滚这一条内部路径可以物理删除
- 若将来需要「删除商家但保留数据用于审计或合规留存」，引入 `deletedAt DateTime?` 软删除字段。该字段的迁移成本随表数量线性增长（每张表一次全表 ALTER），且每条查询都要多一个过滤条件，因此**只在真正出现合规留存需求时再引入**，届时一次性加到全部业务表

---

## 七、鉴权与权限

### 7.1 三类身份

| 身份 | 登录入口 | 作用域 | Token |
|------|----------|--------|-------|
| 平台超管（`platform_admin`） | `platform-admin` 站点 | 跨租户 | JWT |
| 商家后台用户（`merchant_staff` / `merchant_owner`） | `merchant-admin` 站点 + 子域名限定 | 当前租户 | JWT + Refresh |
| 终端消费者（`customer`） | 店铺前台 | 当前租户 | JWT + Refresh；可选匿名购物车 |

### 7.2 实现

- 后端统一发 JWT（含 `userId`、`role`、`tenantId`、`sessionId`）
- 前端通过 `httponly` cookie 或 `Authorization: Bearer` 携带（同一主域下用 cookie，跨域用 Bearer）
- Refresh Token 存数据库（用于吊销）
- RBAC 通过 `@Roles('platform_admin')` 装饰器 + 全局 `RolesGuard`
- 阶段 1 不做 MFA、不做社交登录

---

## 八、支付架构

### 8.1 抽象与实现

```
PaymentProvider（interface）
├─ createPayment(order): { channel, payload, expiresAt }
├─ queryPayment(providerTxnId): { status }
├─ refund(paymentId, amount, reason): { status }
└─ parseWebhook(rawBody, headers): NormalizedWebhookEvent

WechatPayProvider implements PaymentProvider
AlipayProvider  implements PaymentProvider
```

- 阶段 1 必须对接真实沙箱（不是 mock）。通过环境变量切换。
- 商家店铺可配置启用哪些通道（`stores.paymentConfig` 字段）
- webhook 入口：`POST /webhooks/payment/wechat`、`POST /webhooks/payment/alipay`
- webhook 处理：签名校验 → 入队 → BullMQ 异步消费（重试 + 幂等）

### 8.2 幂等与对账

- 支付单与订单关联唯一索引：`(orderId, channel)` 唯一
- 幂等键 `providerTxnId + provider` 用于去重
- 每日对账 cron：调用 `queryPayment` 比对数据库订单，未匹配的产生告警

---

## 九、库存与订单事务

阶段 1 单仓、单笔订单库存预占流程：

```
下单：
  BEGIN TX
    SELECT stock FROM skus WHERE id = ? FOR UPDATE   -- 行锁
    IF stock < qty THEN 抛 InsufficientStock
    INSERT order + order_items
    INSERT inventory_movement(type=reserve, -qty)
  COMMIT

支付成功回调：
  INSERT inventory_movement(type=deduct, -qty)   -- 真正扣减
  UPDATE orders.status = paid

超时未支付：
  BullMQ delayed job
    DELETE inventory_movement(type=reserve)      -- 释放预占
    UPDATE orders.status = cancelled
```

退款时反向流程。所有库存变动都写到 `inventory_movements` 表，便于审计。

---

## 十、营销与计费（阶段 1 范围）

### 10.1 营销

- **优惠券**：满减、订单级、限领次数、限总量、有效期
- **满减活动**：满 X 减 Y，店铺级配置
- 阶段 1 不做积分、不做会员等级、不做拼团、不做秒杀

下单时优惠引擎：

```
输入：购物车 items、店铺优惠配置、用户优惠券
处理：收集可用券 → 计算每张券折后总价 → 取最优
输出：appliedCoupon、discountAmount、最终价
```

### 10.2 平台计费

- **订阅套餐**：平台方配置多个套餐（含 trial），商家订阅；按月自动续费
- **平台抽佣**：每笔订单按 rate% 抽成，写入 `commissions`，按月对账
- 阶段 1 不做发票、不做税务、不做账单 PDF

---

## 十一、商品 / UI / 主题

### 11.1 UI 库

- shadcn/ui（Radix + Tailwind），每个前端项目（storefront / merchant-admin / platform-admin）各自安装；统一的"风格基线"在 `infra/` 下以文档形式维护，不共享代码
- 表单用 `react-hook-form` + `zod`
- 数据请求：商家后台、平台超管用 `tanstack-query`；storefront 用 Next.js Server Components 直读 API + 客户端 `tanstack-query` 处理交互态

### 11.2 主题 token

`stores.themeTokens` 存 JSON：

```json
{
  "colors": { "primary": "#1677ff", "accent": "#52c41a" },
  "radius": "8px",
  "font": "Inter"
}
```

storefront 启动时把 token 注入到 CSS 变量：

```css
:root {
  --color-primary: var(--store-primary, #000);
  --radius-base: var(--store-radius, 6px);
}
```

商家通过表单修改 token，不需要懂代码、不需要重编译。

---

## 十二、API 风格与错误处理

### 12.1 REST 为主

- RESTful 资源风格
- 所有列表接口支持 `?page=&pageSize=&sort=&filter`
- 错误响应统一格式：

```json
{
  "code": "INSUFFICIENT_STOCK",
  "message": "库存不足",
  "details": { "skuId": "abc", "available": 3 },
  "traceId": "..."
}
```

### 12.2 OpenAPI 文档

- `/api/docs` 提供 Swagger UI，`/api/docs-json` 提供规范 JSON——**前端类型生成的唯一来源**
- 规范里的路径带全局前缀（如 `/api/v1/auth/login`），可直接被 `openapi-typescript` 消费

**约定：所有 DTO 字段必须显式写 `@ApiProperty`。** `@nestjs/swagger` 的 CLI 插件有个上游缺陷：只要被扫描的文件里出现一个本地枚举，就会在产物里生成 `require("<该文件的绝对路径>")`，运行时 Node 无法 require 一个 `.ts` 文件，服务直接起不来。显式写装饰器**拦不住**这个坏引用（插件读的是 TypeScript 类型注解，不读装饰器），因此项目选择停用插件的文件扫描（见 `api/nest-cli.json` 里的说明），schema 完全由显式装饰器提供。

代价是**新增 DTO 字段时若忘记写 `@ApiProperty`，文档会静默缺字段且没有任何报错**。新增字段时请一并补上。

---

## 十三、测试策略

| 层级 | 工具 | 覆盖率目标 |
|------|------|-----------|
| 单元测试 | Jest（后端）、Vitest（前端） | 后端 ≥ 60%、前端 ≥ 50% |
| 集成测试 | Jest + Supertest（API）、Playwright（前端） | 关键模块 ≥ 1 个 e2e 用例 |
| 契约测试 | OpenAPI schema validation | 每个 controller 一个 |
| E2E | Playwright | 阶段 1：商家注册 → 上架 → 消费者下单 → 支付回调（沙箱） |

关键路径必须有 e2e：下单链路、支付回调、库存预占释放、优惠计算、平台抽佣记账。

---

## 十四、部署与基础设施

### 14.1 阶段 1 dev/staging

- Docker Compose（`infra/docker-compose.yml`）一把拉起：Postgres + Redis + MinIO + api + storefront + merchant-admin + platform-admin
- 反向代理用 Nginx（`infra/nginx/`），按子域名路由到不同服务
- 子域名本地解析：dev 用 `*.platform.test` 走 `/etc/hosts` 或者用 `*.nip.io` 临时域；storefront 单实例内部通过请求 host 解析 tenantId

### 14.2 阶段 1 生产（如果跑通）

- 单 VPS：Docker Compose + Nginx + Certbot
- 数据库：托管 Postgres（Neon / Supabase / RDS）
- 对象存储：S3 / OSS / MinIO on VPS
- 监控：`/api/v1/health` 探活（全局前缀 `api/v1` 自 Task 5 起生效；该端点带 `@Skip()`，不要求租户上下文）；后续接入 Sentry / OpenTelemetry

### 14.3 日志与可观测

- 后端结构化 JSON 日志（含 `traceId`、`tenantId`、`userId`）
- 阶段 1 接 `pino` + 控制台；后续接入集中日志

---

## 十五、风险与开放问题

### 15.1 已知风险

- **多租户隔离出错**：典型 bug 模式是忘了加 `tenantId` 条件。Mitigation：Prisma extension 强制 + 集成测试覆盖 + lint 规则禁止裸查询
- **支付回调丢失**：Mitigation：BullMQ 重试 + 幂等键 + 人工对账入口
- **库存超卖**：Mitigation：`FOR UPDATE` 行锁 + 预占 + 事务
- **主题定制局限**：CSS Token 不支持布局结构调整。Mitigation：在文档里明确后续需要可视化编辑器

### 15.2 开放问题（阶段 1 实施时再敲定）

- 文件上传限速 / 病毒扫描策略
- 商家租户隔离之外的"敏感字段加密"策略（什么算敏感）
- 跨租户数据导出（GDPR-like）需求
- 子域名 vs 自定义顶级域名（阶段 1 仅子域名）
- 是否阶段 1 接 GraphQL？（建议不接，REST 优先）

---

## 十六、待办与下一步

- [ ] 用户确认本文档
- [ ] 调用 writing-plans 技能，把阶段 1 拆成可执行的实施计划
- [ ] 按计划逐步实施：先骨架（tenancy / auth），再商品，再交易

---

## 附：本次敲定的关键决策

| 决策项 | 选择 |
|--------|------|
| 项目目的 | 模板 / SaaS 底座 |
| 形态 | 多租户 SaaS（一实例多商家） |
| 阶段 1 范围 | 扩展版（含库存、营销、计费） |
| 后端 | NestJS + PostgreSQL + Prisma |
| 前端 | Next.js (App Router) + React + shadcn/ui + Tailwind |
| 多租户 | 共享库 + 每张表带 `tenantId` |
| 鉴权 | NextAuth.js (Auth.js v5) + JWT，前端用，backend 独立验证；后端统一发 JWT |
| 支付 | 微信支付 + 支付宝（双通道） |
| 多主题 | CSS Token（shadcn/ui 体系） |
| 前后端 | 四个独立项目（api / storefront / merchant-admin / platform-admin） |
| 类型同步 | OpenAPI → `openapi-typescript` 生成前端 client |
