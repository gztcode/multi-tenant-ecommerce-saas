# 计划 2：商品中心与店铺前台浏览 — 设计文档

| 项目 | 说明 |
|------|------|
| 文档日期 | 2026-10-22 |
| 文档状态 | 待用户审阅 |
| 对应实施计划 | `docs/superpowers/plans/2026-10-22-plan-02-product-center.md`（待编写） |
| 前置阶段 | 计划 1「平台地基与身份体系」已完成并验收（见 `2026-10-21-plan-01-acceptance.md`） |
| 后续阶段 | 计划 3「交易链路」、计划 4「营销、平台计费与平台超管」 |

> **编号说明**：主设计文档（`2026-10-21-multi-tenant-ecommerce-saas-design.md`）§3 的路线图
> 按「阶段 1–5」划分，与后来确定的「计划 1–4」不是一套编号。两者的映射关系见
> 本文 §十二。旧文档 §3 的表述在计划 2 落地后需要同步修订。

---

## 一、目标与范围

### 1.1 目标

把「平台地基」变成「能卖东西的电商底座」：商家能建品类、上架商品、传图、改库存、
配主题；消费者能浏览商品、筛选、搜索、查看详情。

本阶段交付的是**商品中心**与**店铺前台的浏览能力**，不含交易。

### 1.2 范围内

| 模块 | 内容 |
|------|------|
| 品类 | 租户自建的层级品类树（最多 3 层），增删改查 |
| 商品 | 草稿 / 上架 / 下架三态；描述性属性；软删除 |
| 规格矩阵 | 商品级规格维度 + 规格值 → 自动生成 SKU 骨架；整体替换 |
| SKU | 价格（整数分）、划线价、商家编码、库存、启用状态 |
| 媒体 | MinIO 直传（presigned URL）、确认、孤儿清理 |
| 库存 | 手动出入库 / 盘点 + append-only 流水台账 |
| 搜索 | pg_trgm 三元组模糊匹配 + 品类 / 价格区间 / 状态筛选 |
| 主题 | 全量 CSS token，商家表单配置，storefront 服务端注入 |
| 店铺前台 | 首页商品流、品类页、搜索结果页、商品详情页（规格选择器） |
| 商家后台 | 商品 CRUD、规格矩阵编辑器、批量上下架 / 改价 / 删除、库存调整与流水查询 |

### 1.3 范围外（留给后续阶段）

- **购物车、订单、支付** —— 计划 3。库存流水的 `RESERVE` / `RELEASE` / `DEDUCT`
  三种类型本阶段只在枚举里留位，不实现业务逻辑。
- **营销与优惠券** —— 计划 4。
- **多仓库存** —— 本阶段单仓，库存直接存在 SKU 上。将来做多仓时需迁移到独立的
  库存表（见 §四的「已知技术债」）。
- **商品主图自动裁剪 / 缩略图** —— 本阶段只登记原始图，不做图像处理。
- **可视化主题编辑器** —— 仍是表单配置 CSS token。
- **跨店铺聚合搜索** —— 品类是租户自建（§3.4），商品搜索只在本租户范围内。

---

## 二、关键决策速查

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 商品模型 | 规格矩阵（维度 + 值 + SKU 多对多） | 能自动生成 SKU 骨架、能做规格选择器、能按规格筛选；代价是多 3 张表 |
| 2 | 品类归属 | 商家自建，租户内独立 | 与现有隔离模型天然一致，只需把 `Category` 登记进白名单 |
| 3 | 描述性属性 | `Product.attributes` jsonb | 只用于详情页展示，不参与 SKU 组合，不支持按属性筛选 |
| 4 | 库存深度 | 手动出入库 + append-only 流水台账 | 阶段 2 无订单，预占逻辑无法端到端验证；枚举先留位给阶段 3 |
| 5 | 搜索实现 | pg_trgm 三元组 + GIN 索引 | 对中文有效（按三元组算，无需分词器），无需额外服务 |
| 6 | 媒体上传 | MinIO 直传（presigned URL） | 不占后端带宽；代价是前端要处理进度与失败重试 |
| 7 | 软删除 | 所有业务实体一律软删除，过滤条件由扩展自动合并 | 审计链不断、误删可恢复、规则无例外 |
| 8 | 价格表示 | 一律整数分 | 浮点价是迟早的资损事故，改起来要洗数据 |
| 9 | 商品封面 | 媒体列表中 `sort` 最小的那张，不设独立字段 | 单一事实来源，不存在两处抢着决定封面 |
| 10 | 价格排序 | 商品表冗余派生字段 `minPrice` | Prisma 不支持按关系字段排序，原生 SQL 会绕过隔离机制 |
| 11 | 规格写入 | 整体替换（PUT）+ `version` 乐观锁 | 前端不用自己算笛卡尔积；乐观锁防并发编辑静默覆盖 |
| 12 | 主题 token | 全量 token（16 语义色 + 字阶 + 字重 + 间距 + 阴影等） | 用户明确选择；不做可视化拖拽编辑器 |
| 13 | 后台商品管理 | 基础 CRUD + 批量操作 | 用户明确选择 |

---

## 三、架构与隔离模型

### 3.1 模块划分

新增三个后端模块，全部挂进阶段 1 的 `TenantPrismaService`，**不新开 Prisma client**
（两个 client 等于两个连接池，且隔离机制会失效）。

| 模块 | 职责 |
|------|------|
| `catalog` | 品类、商品、规格、SKU、公开读接口 |
| `media` | 上传凭证签发、媒体登记与确认、孤儿清理 |
| `inventory` | 库存调整、流水查询 |

`media` 与 `inventory` 独立成模块而非塞进 `catalog`：阶段 3 的订单也要调它们，
库存不是商品的私有概念。

### 3.2 白名单扩展

`api/src/common/tenant/tenant-models.ts` 里新增两张白名单，与既有
`TENANT_SCOPED_MODELS` 并列：

```typescript
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User', 'Store',
  'Category', 'Product', 'ProductSpec', 'ProductSpecValue',
  'Sku', 'SkuSpecValue', 'Media', 'ProductMedia', 'InventoryMovement',
]);

/** 走软删除的模型：扩展自动合并 deletedAt: null 条件 */
export const SOFT_DELETE_MODELS = new Set<string>([
  'Category', 'Product', 'Sku', 'Media',
]);
```

> **`ProductMedia` 必须登记进 `TENANT_SCOPED_MODELS`。**
> 阶段 1 的 `TenantPrismaService.assertTenantScopedModelsRegistered()`
> 会在启动时扫描 schema，凡是带 `tenantId` 字段却没登记的模型**直接让进程启动失败**。
> 这是刻意的 fail-fast 设计：新增业务表若忘了登记，那张表的所有读写都不会附加
> `tenantId` 条件——彻底失去隔离且没有任何报错，是这套机制最危险的失效模式。
> `ProductMedia` 同样带 `tenantId`（关联表也要隔离，不能靠父表兜底），
> 因此必须在白名单里。

**`InventoryMovement` 不在软删除名单里**——流水表是 append-only 的审计凭证，
既不软删也不允许物理删除。

### 3.3 隔离机制的 fail-closed 性质

阶段 1 的 `resolveScope`（`api/src/common/tenant/tenant-prisma.service.ts:88`）是
**fail-closed** 的：模型一旦进入白名单，上下文缺失时抛 `TenantScopeError`，
而不是退化成「不过滤」。

这意味着新模型登记进白名单之后，**忘记建立租户上下文的后果是 500，不是数据泄漏**。
本设计依赖这个性质。

软删除的合并逻辑同样 fail-closed：查询条件恒定带上 `deletedAt: null`，
业务代码漏写不会漏过滤。

### 3.4 公开读路径与 `@Public()` 装饰器

商品浏览是匿名的，但**绝不能用阶段 1 的 `@Skip()`**。`@Skip()` 让租户上下文拦截器
整个跳过，`tenantContext.getStore()` 返回 `undefined`，Product 查询当场抛错 500。
阶段 1 的 `@Skip()` 只用于健康检查（该端点不碰任何业务模型）。

因此新增 `@Public()` 装饰器，与 `@Skip()` 语义严格分离：

| 装饰器 | 租户上下文拦截器 | JWT 守卫 | 租户来源 | 适用 |
|--------|------------------|---------|---------|------|
| 无 | 建立 | 拦截 | JWT | 管理端接口 |
| `@Public()` | **建立** | 放行 | 子域名 | 商品浏览、店铺公开信息 |
| `@Skip()` | 跳过 | 拦截 | 无 | 健康检查 |

实现方式：`@Public()` 只影响 `JwtAuthGuard`，不影响 `TenantContextInterceptor`。
`JwtAuthGuard` 需改造为：命中 `@Public()` 元数据时直接 `return true`。

### 3.5 公开读路径的安全边界

**这条边界是本设计最重要的约束。**

- 匿名请求（无 JWT）的租户来自 `X-Tenant-Subdomain` 头或 `Host` 头，**两者都采信**。
- 只要请求带了 JWT，租户**只**来自令牌，子域名头一律无视——这是阶段 1
  `tenant-context.interceptor.ts:87` 已有的行为，本阶段不改。

这不构成越权，理由是分工：

- 匿名路径上**只有公开数据**。任何消费者本来就能浏览任何店铺的商品，
  子域名头被伪造不产生新的信息泄露。
- 管理路径上的租户来自令牌，子域名头根本不参与判定。

> ⚠️ **硬约束：匿名路径上的端点只允许返回公开数据。**
> 将来若要在公开端点上加「查本租户订单」之类的接口，必须同时把它挪到
> 需要认证的路径上——否则攻击者可以用任意 `X-Tenant-Subdomain` 头读到别人的数据。
> 每加一个公开端点都要逐个审视。

### 3.6 storefront → api 的子域名传递

容器内 storefront 直连 `api:3000`，Host 是服务名，解析不出子域名。
因此 **storefront 发出的每个请求都必须显式带 `X-Tenant-Subdomain`**，
取值来自已有的 `storefront/src/lib/tenant.ts` 的 `resolveTenantSubdomain(headers)`。

两条路径都要带：

- Server Component 直读后端
- 同源 BFF 代理路由（`storefront/src/app/api/**`）

阶段 1 的 BFF 代理没有踩到这个坑，是因为 `/stores/me` 带 JWT，走令牌分支。
本阶段的公开读接口不带令牌，完全依赖这个头。

---

## 四、数据模型

新增 9 张表。除下表列出的字段外，每张业务表都带 `tenantId`。

### 4.1 Category（品类）

```prisma
model Category {
  id        String   @id @default(uuid())
  tenantId  String
  parentId  String?
  name      String
  slug      String
  sort      Int      @default(0)
  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant   Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  parent   Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: Cascade)
  children Category[] @relation("CategoryTree")
  products Product[]

  // ⚠️ 唯一索引刻意**不在 schema 里声明**，由迁移手写部分唯一索引（见 §4.9）。
  // 原因：软删除后 slug 仍占用唯一性，而普通的 @@unique 做不到
  // 「仅对未删除记录生效」——带 deletedAt 的复合唯一也无效，
  // 因为 PostgreSQL 的 NULL 不参与唯一性判定。
  @@index([tenantId, parentId])
  @@map("categories")
}
```

**层级最多 3 层**，在 service 层校验。理由不是性能，是防止商家建出 8 层深树后
前台导航与面包屑失控。

**跨租户挂载**：Prisma 扩展会兜住（`findFirst` 自动带 `tenantId` 条件，查不到即报错），
但那拦下来的是 500，商家看不懂。service 层仍要显式校验 `parentId` 属于同租户
并给出可读错误。

**删除**：软删除。有子品类或商品时拒绝删除（提示先处理子项）。

### 4.2 Product（商品）

```prisma
model Product {
  id          String        @id @default(uuid())
  tenantId    String
  categoryId  String?
  name        String
  slug        String
  subtitle    String?
  description String?
  status      ProductStatus @default(DRAFT)
  attributes  Json          @default("{}")   // 描述性属性，不参与 SKU 组合
  minPrice    Int           @default(0)     // 派生字段，见 §四.3
  version     Int           @default(1)     // 乐观锁
  publishedAt DateTime?
  deletedAt   DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  tenant Tenant      @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  category Category? @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  specs   ProductSpec[]
  skus    Sku[]
  media   ProductMedia[]

  // ⚠️ 唯一索引由迁移手写部分唯一索引（见 §4.9），不在 schema 里声明。
  @@index([tenantId, status])
  @@index([tenantId, categoryId])
  @@map("products")
}
```

- `status`：`DRAFT` / `PUBLISHED` / `UNPUBLISHED`。
- `attributes` 是描述性属性，如 `{"材质":"纯棉","产地":"浙江"}`。仅在详情页渲染成参数表，
  **不支持按属性筛选**。
- `publishedAt` 在首次上架时写入，用于「最新」排序。
- 没有 `coverMediaId`——封面就是 `media` 里 `sort` 最小的那张（§4.7）。

### 4.3 minPrice 派生字段

商品本身没有价格，价格在 SKU 上。

Prisma **不支持按关系字段排序**（`orderBy: { skus: { price: 'asc' } }` 不可用）。
绕过去的唯一办法是原生 SQL，而那会绕过整个 Prisma 扩展，等于手写隔离条件——
阶段 1 花了大力气避免的事。

因此商品表冗余一个 `minPrice`（整数分），**为排序与价格区间筛选而存在**。

> Prisma 其实**支持**用关系做价格筛选（`skus: { some: { price: { gte, lte } } }`），
> 但本设计**不采用**。原因是语义会打架：用关系筛选时，判定标准是
> 「存在任一 SKU 落在区间内」；用 minPrice 排序时，标准是「商品的最低价」。
> 同一批商品在「筛选后」和「排序后」顺序会矛盾——一个 minPrice=100、
> 但含 500 元 SKU 的商品，既出现在 100–200 的筛选结果里，又排在最前面。
> 电商惯例是统一按「商品价（最低价）」，两者共用 `minPrice` 一个字段。

维护规则（写死，不允许实现时另做主张）：

1. **只有 `ACTIVE` 状态的 SKU 参与计算。** 下架的廉价 SKU 不该压着商品价格。
2. **重算与价格写入必须在同一事务内。**
3. 重算用一条 SQL 完成，不在应用层循环 SKU：

```sql
UPDATE products p SET min_price = sub.min_price
FROM (
  SELECT product_id, MIN(price) AS min_price
  FROM skus
  WHERE product_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
  GROUP BY product_id
) sub
WHERE p.id = sub.product_id
```

4. 另有一条 e2e 测试专门验证「改完 SKU 价格后商品 minPrice 同步更新」。

### 4.4 ProductSpec / ProductSpecValue（规格维度与值）

```prisma
model ProductSpec {
  id        String   @id @default(uuid())
  tenantId  String
  productId String
  name      String          // 颜色
  sort      Int      @default(0)
  deletedAt DateTime?

  product Product           @relation(fields: [productId], references: [id], onDelete: Cascade)
  values  ProductSpecValue[]

  // ⚠️ 唯一索引刻意**不在 schema 里声明**，由迁移手写部分唯一索引。
  // 软删除后同名规格会占用普通 @@unique —— 见 §4.10。
  @@index([tenantId, productId])
  @@map("product_specs")
}

model ProductSpecValue {
  id        String   @id @default(uuid())
  tenantId  String
  specId    String
  value     String          // 红色
  mediaId   String?         // 颜色图集：红色对应的图
  sort      Int      @default(0)
  deletedAt DateTime?

  spec   ProductSpec @relation(fields: [specId], references: [id], onDelete: Cascade)
  media  Media?      @relation(fields: [mediaId], references: [id], onDelete: SetNull)

  // ⚠️ 唯一索引由迁移手写部分唯一索引（软删除后同名值不占用唯一性）。
  @@index([tenantId, specId])
  @@map("product_spec_values")
}
```

规格是**商品级**定义，不是类目级模板。类目属性模板会大幅增加复杂度，
而它解决的问题（跨商品的统一属性筛选）在本阶段不是刚需。

### 4.5 Sku / SkuSpecValue

```prisma
model Sku {
  id           String   @id @default(uuid())
  tenantId     String
  productId    String
  code         String?         // 商家编码，可空
  price        Int             // 分
  comparePrice Int?            // 划线价，分
  stock        Int      @default(0)
  status       SkuStatus @default(ACTIVE)   // ACTIVE / INACTIVE
  deletedAt    DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  product   Product        @relation(fields: [productId], references: [id], onDelete: Cascade)
  specValues SkuSpecValue[]
  movements InventoryMovement[]

  // ⚠️ 唯一索引由迁移手写部分唯一索引（见 §4.9），不在 schema 里声明。
  @@index([tenantId, productId])
  @@map("skus")
}

model SkuSpecValue {
  id        String @id @default(uuid())
  tenantId  String
  skuId     String
  valueId   String

  sku   Sku            @relation(fields: [skuId], references: [id], onDelete: Cascade)
  value ProductSpecValue @relation(fields: [valueId], references: [id], onDelete: Cascade)

  @@unique([skuId, valueId])
  @@index([tenantId, skuId])
  @@map("sku_spec_values")
}
```

`code` 可空——PostgreSQL 的 NULL 不参与唯一性判定，所以多个 `code` 为 null 的
SKU 不会冲突。唯一索引由迁移手写**部分唯一索引**（`WHERE deleted_at IS NULL
AND code IS NOT NULL`），并对 `code` 取 `LOWER()`——商家填 `T-Shirt` 与
`t-shirt` 应当算同一个编码，与阶段 1 处理邮箱大小写的方式一致。

`Sku.status` 的 `INACTIVE` 表示「这个 SKU 不再使用」——规格矩阵缩减时多余的 SKU
统一置 `INACTIVE` 而不是软删除（理由见 §5.5 第 6 条）。
`INACTIVE` 的 SKU 不参与 `minPrice` 计算，公开接口也不返回。

### 4.6 Media（媒体）

```prisma
enum MediaStatus {
  PENDING     // 已签发上传凭证，文件还没到
  READY       // 已确认
  ORPHANED    // 清理任务标记：凭证过期但从未上传
}

model Media {
  id         String     @id @default(uuid())
  tenantId   String
  key        String              // MinIO object key
  url        String
  mime       String
  size       Int
  width      Int?
  height     Int?
  status     MediaStatus @default(PENDING)
  uploadedBy String
  deletedAt  DateTime?
  createdAt  DateTime   @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  products ProductMedia[]
  specValues ProductSpecValue[]

  @@unique([tenantId, key])
  @@index([tenantId, status])
  @@map("media")
}
```

三态是必需的：presigned URL 签发后商家可能直接关页面，数据库里就留下一条
永远指向不存在文件的记录。`PENDING` 超过 24 小时由清理任务置为 `ORPHANED`。

object key 带 `tenantId` 前缀（`{tenantId}/yyyy/mm/{随机串}.{ext}`），
即使 bucket 权限配错也能靠前缀隔离。bucket 保持私有。

### 4.7 ProductMedia（商品 ↔ 媒体）

```prisma
model ProductMedia {
  id        String @id @default(uuid())
  tenantId  String
  productId String
  mediaId   String
  sort      Int    @default(0)

  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  media   Media   @relation(fields: [mediaId], references: [id], onDelete: Cascade)

  @@unique([productId, mediaId])
  @@index([tenantId, productId])
  @@map("product_medias")
}
```

**封面就是 `sort` 最小的那张**，前台取 `[0]`。不设 `Product.coverMediaId`——
那个字段会与 `ProductMedia.sort` 抢着决定谁是封面，必然漂移。

### 4.8 InventoryMovement（库存流水）

```prisma
enum InventoryMovementType {
  INITIAL     // 创建 SKU 时的初始库存
  ADJUST_IN   // 手动入库
  ADJUST_OUT  // 手动出库
  CHECK       // 盘点：把库存改为某个实测值
  RESERVE     // 阶段 3 留位
  RELEASE     // 阶段 3 留位
  DEDUCT      // 阶段 3 留位
}

model InventoryMovement {
  id          String                 @id @default(uuid())
  tenantId    String
  skuId       String
  type        InventoryMovementType
  quantity    Int                    // 带符号的增量
  stockBefore Int
  stockAfter  Int
  reason      String?
  operatorId  String
  createdAt   DateTime               @default(now())

  sku Sku @relation(fields: [skuId], references: [id], onDelete: Restrict)

  @@index([tenantId, skuId, createdAt])
  @@map("inventory_movements")
}
```

- **append-only**：不允许 update / delete。扩展在 `SOFT_DELETE_MODELS` 里也不含它。
- `quantity` 是**带符号的增量**，方向由 `type` 决定：
  `INITIAL +50` / `ADJUST_IN +20` / `ADJUST_OUT -10` / `CHECK +8`（10 盘到 18）/
  `RESERVE -5` / `RELEASE +5` / `DEDUCT -5`。
- `stockBefore` / `stockAfter` 记录实际库存值，供对账与界面展示。
- `RESERVE` / `RELEASE` 的语义（占用可用量而非改变实际库存）留到阶段 3 细化，
  本阶段不实现。

**`sku` 外键用 `onDelete: Restrict`**，这是流水链的数据库层第二道防线：
物理删除一个已有流水的 SKU 会被 PostgreSQL 直接拒绝，即使应用层漏了检查也删不掉。
其余关系表用 `Cascade`（关联记录本身没有独立价值）。

### 4.9 软删除的落地方式

`Product` / `Sku` / `Category` / `Media` 都有 `deletedAt`。

**扩展的改动**（`tenant-prisma.service.ts`）：

| 操作类别 | 对 `SOFT_DELETE_MODELS` 的处理 |
|---------|-------------------------------|
| 读（findMany / findFirst / findFirstOrThrow / count / aggregate / groupBy） | `where` 自动合并 `deletedAt: null` |
| 写（updateMany / createManyAndReturn 等） | `where` 自动合并 `deletedAt: null` |
| `delete` / `deleteMany` | **抛错**，提示改用 `updateMany` 设 `deletedAt` |

物理删除在本阶段不开放。将来若要提供「彻底清除」入口（例如清理商家建错的
草稿商品），需要单独评审——它会与流水表的审计链冲突。

**⚠️ 关联读取不施加软删除过滤——业务层必须显式写 `where`。**

这条在 Task 2 实测确认过，结论与直觉相反：

| 写法 | 软删记录是否出现 |
|------|----------------|
| `prisma.sku.findMany()` | ❌ 不出现（顶层合并了 `deletedAt: null`） |
| `include: { skus: true }` | ✅ **出现**（扩展不作用于嵌套层） |
| `include: { skus: { where: { deletedAt: null } } }` | ❌ 不出现（显式过滤） |

原因是 Prisma 的 `include` 不是独立的 delegate 调用，而是拼进同一条查询的子查询，
`$allModels` 扩展只作用于顶层。

**租户隔离不受这个限制影响**——顶层 `where.tenantId` 已经把父记录滤掉了，
别的租户的关联自然无从出现。所以这是「漏过滤软删数据」，不是「跨租户泄漏」。

> **只有 to-many 关系能这么写。** Prisma 的 `where` 只存在于 to-many 关系的
> 嵌套参数上。to-one 关系（如 `ProductMedia.media`）的类型里没有 `where` 槽位，
> 要过滤得改成对关系字段做条件：`media: { where: { media: { deletedAt: null } } }`。

因此凡是读软删除模型的关联，业务层都要显式补 `where`：

```typescript
// 商品详情（管理端与公开端都要这样写）
include: {
  skus:   { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
  specs:  { where: { deletedAt: null }, orderBy: { sort: 'asc' },
            include: { values: { where: { deletedAt: null }, orderBy: { sort: 'asc' } } } },
  media:  { where: { media: { deletedAt: null } }, orderBy: { sort: 'asc' } },
}
```

阶段 2 的每个读关联的地方都要这么写。这条有回归用例守着
（`api/src/common/tenant/tenant-prisma.service.spec.ts` 的「关联读取」用例）。

### 4.10 唯一索引必须用部分唯一索引

软删除与普通唯一索引冲突：商家删掉「女装」品类后想再建一个同名品类，
如果唯一索引是 `@@unique([tenantId, slug])`，第二条会被数据库拒绝——
即使第一条已经软删除了。

带 `deletedAt` 的复合唯一也**解决不了**这个问题：PostgreSQL 的 NULL 不参与
唯一性判定，`(tenant_id, slug, NULL)` 与 `(tenant_id, slug, NULL)` 被视为不同，
唯一约束形同虚设。

正确做法是**部分唯一索引**，条件为「未删除」：

```sql
CREATE UNIQUE INDEX categories_tenant_slug_uniq
  ON categories (tenant_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX products_tenant_slug_uniq
  ON products (tenant_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX product_specs_product_name_uniq
  ON product_specs (product_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX product_spec_values_spec_value_uniq
  ON product_spec_values (spec_id, value) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX skus_tenant_code_uniq
  ON skus (tenant_id, code) WHERE deleted_at IS NULL AND code IS NOT NULL;
```

**凡带 `deletedAt` 且有唯一性要求的表都在名单里**：

| 表 | 唯一键 | 原因 |
|----|-------|------|
| `categories` | `(tenantId, slug)` | 删掉「女装」后能再建同名的 |
| `products` | `(tenantId, slug)` | 同上 |
| `skus` | `(LOWER(code), tenantId)` | 商家编码大小写不敏感 |
| `product_specs` | `(productId, name)` | 删掉「颜色」规格后能再加同名的 |
| `product_spec_values` | `(specId, value)` | 删掉「红色」后能再加同名的 |

这五张表在 Prisma schema 里**不声明 `@@unique`**，改由迁移手写。
阶段 1 已有同样的先例（`users_platform_admin_email_key` 等部分唯一索引），
处理方式一致：schema 里用注释说明，迁移里写原生 SQL。

`skus` 的索引额外加了 `code IS NOT NULL`——`code` 本身可空，
多个 `code` 为 null 的 SKU 不应互相冲突。

> **容易漏的一张是 `product_specs` 与 `product_spec_values`**：它们带
> `deletedAt`（规格可以删），但直觉上会以为「规格是商品的内部结构，
> 不会重名」。实际上商家把「颜色」这个维度删掉后，完全可能再加一个
> 叫「颜色」的维度——普通 `@@unique` 会让这个操作直接被数据库拒绝。

### 4.11 已知技术债

| 项 | 影响 | 触发时机 |
|----|------|---------|
| 单仓库存 | 库存直接存在 `Sku.stock` 上 | 计划 3 或 4 做多仓时，需迁移到独立的库存表（`warehouse_stocks`） |
| 商品图片无缩略图 | 前台列表页直接加载原图 | 媒体量上来后需要加缩略图字段或图片处理任务 |
| `minPrice` 派生字段 | 与真实 SKU 价格可能短暂不一致 | 已用事务 + e2e 测试兜住；多仓或跨店促销时要重新评估 |

---

## 五、API 契约

### 5.1 路由划分

公开读与管理端分成两组 controller，不在同一个 controller 里靠守卫切换——
那种做法容易漏配，且难以从路由表一眼看出哪些端点是公开的。

| 前缀 | 守卫 | 内容 |
|------|------|------|
| `/api/v1/public/categories` | `@Public()` | 品类树 |
| `/api/v1/public/products` | `@Public()` | 商品列表、详情 |
| `/api/v1/catalog/categories` | JWT + 商家角色 | 品类管理 |
| `/api/v1/catalog/products` | JWT + 商家角色 | 商品管理、规格、批量操作 |
| `/api/v1/media` | JWT + 商家角色 | 上传凭证、媒体登记 |
| `/api/v1/inventory` | JWT + 商家角色 | 库存调整、流水 |

### 5.2 公开读接口

```
GET /api/v1/public/categories
    → 品类树（嵌套结构，已过滤 deletedAt）

GET /api/v1/public/products
    ?page=1&pageSize=20
    &categoryId=          品类（不含子品类）
    &keyword=             关键词
    &minPrice=            分
    &maxPrice=            分
    &sort=latest|price_asc|price_desc
    → 商品卡片列表

GET /api/v1/public/products/:slug
    → 商品详情（商品 + 规格 + 规格值 + SKU + 媒体 + 描述性属性）
```

**列表接口不返回 SKU**（列表页只需要卡片信息：图、名称、价格区间、分类）。
用 Prisma `select` 显式裁剪字段，不做「先查全量再删字段」。

**详情接口不返回 `tenantId`** 等内部字段。

**`pageSize` 上限 100**，超出按 100 处理。否则 `pageSize=99999` 能把整个租户
的商品拖出去。

**只返回 `PUBLISHED` 状态的商品。** 店铺 `status` 为 `PAUSED` 时，公开接口返回空列表
（而不是 404），避免泄露店铺运营状态。

> ⚠️ **`DRAFT` 不拦截。** 商家注册后店铺的初始状态就是 `DRAFT`
> （`StoreStatus` 的 schema 默认值，注册流程没有显式传 `status`），
> 而阶段 2 没有「店铺上线」这道流程——商家上架商品后应该立刻能在前台看到。
> 若按「非 `LIVE` 即拦截」实现，公开接口会**永远返回空列表**，
> 而症状是「商品上架了但前台看不到」，很难往状态机方向想。
> 所以判定条件是 `status === 'PAUSED'`（被平台暂停）才拦截。

### 5.3 搜索实现

```sql
WHERE status = 'PUBLISHED'
  AND deleted_at IS NULL
  AND name ILIKE '%keyword%'
  AND category_id = $categoryId
  AND min_price BETWEEN $minPrice AND $maxPrice
```

`pg_trgm` 的 GIN 索引 Prisma schema 表达不了（`@@index` 只支持 B-tree），
必须在迁移里写原生 SQL：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm ON products USING GIN (name gin_trgm_ops);
```

> ⚠️ `CREATE EXTENSION` 需要以超级用户执行。阶段 1 的迁移全是普通 DDL，没有先例。
> 实施时**先单独验证这一步**再动别的迁移——跑不起来就要换搜索方案。

**用 Prisma 的 `contains` + `mode: 'insensitive'`，不要用 trgm 的 `%` 操作符。**
`contains` 生成的是 `ILIKE '%keyword%'`，而 pg_trgm 的 GIN 索引正好加速这个操作
（trgm 索引支持 LIKE / ILIKE 的前后通配查询）。用 `contains` 既能走索引，
又完全不需要原生 SQL——也就不会绕开 Prisma 扩展。
`%` 操作符（相似度阈值匹配）Prisma 并不暴露，要用就得写原生 SQL，那会绕开隔离机制。

代价：这是精确的子串匹配（大小写不敏感），**不是** trgm 的相似度阈值匹配——
后者能容忍错别字（「纯棉园领T恤」也能搜到「纯棉圆领T恤」）。对中文电商来说
子串匹配通常够用，容错搜索留到将来需要时再加。

价格区间筛选用 `minPrice`（商品表上的派生字段），与排序共用同一个字段，
避免同一批商品在「筛选后」和「排序后」顺序不一致。

### 5.4 商品管理接口

```
GET    /api/v1/catalog/products              列表（分页、筛选、搜索、排序）
POST   /api/v1/catalog/products              新建
GET    /api/v1/catalog/products/:id          详情（含规格与 SKU 全量）
PATCH  /api/v1/catalog/products/:id          更新（含状态切换）
DELETE /api/v1/catalog/products/:id          软删除

PUT    /api/v1/catalog/products/:id/specs    整体替换规格矩阵（带 version）
PUT    /api/v1/catalog/products/:id/media    设置商品的媒体列表
PATCH  /api/v1/catalog/products/:productId/skus/:skuId   更新单个 SKU

POST   /api/v1/catalog/products/batch        批量操作
GET    /api/v1/catalog/products/export       导出 CSV
POST   /api/v1/catalog/products/import       导入 CSV
```

**媒体列表用整体替换（PUT）**，请求体是媒体 id 的**有序数组**：

```json
{ "mediaIds": ["media-id-1", "media-id-2"] }
```

数组顺序就是 `sort`——封面是第一个。整体替换而不是增量接口，与规格矩阵同理：
前端不需要自己算增量，后端在一个事务里做「校验归属 → 删掉不再引用的 →
补上新引用的 → 按数组顺序重排 sort」。

**每个 mediaId 都必须属于当前租户**（跨租户引用要拒绝），
且必须是 `READY` 状态（还没上传完的不能挂到商品上）。

批量操作请求体：

```json
{
  "ids": ["uuid-1", "uuid-2"],
  "action": "PUBLISH" | "UNPUBLISH" | "DELETE" | "SET_CATEGORY" | "ADJUST_PRICE",
  "categoryId": "action=SET_CATEGORY 时必填",
  "mode": "action=ADJUST_PRICE 时必填，SET | PERCENT",
  "value": "action=ADJUST_PRICE 时必填，SET 为分，PERCENT 为百分比整数（10 表示 +10%）"
}
```

- 批量删除是软删除。
- 批量操作要么全成功要么全失败（单事务）。
- `ADJUST_PRICE` 作用于选中商品下**全部 ACTIVE 且未删除的 SKU**，
  调整后必须在同一事务里重算受影响商品的 `minPrice`。
  `PERCENT` 按百分比调整，`price` 向上取整到分。

**CSV 导入导出**（本阶段实现基础版）：

- 导出：按当前筛选条件导出商品的基础信息
  （名称、slug、分类路径、状态、描述性属性 JSON、SKU 数、最低价、库存合计），
  **不含**规格矩阵与媒体。
- 导入：固定列格式，逐行解析。**只支持新建商品的基础信息**，
  不支持导入规格矩阵、媒体与库存——那三样要能表达清楚，CSV 已经不合适。
- 导入**逐行独立**：某一行校验失败不影响其他行，响应返回每行的结果
  （成功 / 失败原因 + 行号）。不是全成功全失败。

> 之所以把 CSV 限定在「基础信息」，是因为规格矩阵的导入需要表达
> 「维度 + 值 + 笛卡尔积」的结构，用扁平表格表达会立刻变得不可读。
> 那部分走 JSON 导入或留到后面。

### 5.5 规格矩阵的整体替换

前端提交一份完整的规格结构：

```json
{
  "version": 3,
  "specs": [
    { "name": "颜色", "values": [{ "id": "v1", "value": "红色" }, { "value": "蓝色" }] },
    { "name": "尺码", "values": [{ "id": "v2", "value": "M" }, { "value": "L" }] }
  ]
}
```

后端在**一个事务**内：

1. 校验 `version` 与当前商品一致，否则 409「商品已被他人修改，请刷新后重试」
2. 校验维度数 ≤ 2、每维度值数 ≤ 20（防止笛卡尔积爆炸）
3. 算出笛卡尔积，与已有 SKU 比对。**维度列表为空（清空规格）时笛卡尔积返回空列表**，
   不生成组合——笛卡尔积的数学起点是「空集的单元素集 `[[]]`」，直接 reduce 会产出
   一个不挂任何规格值的 SKU，那条记录商家在界面上看不见却会污染列表与计数
4. **匹配到的** SKU 保留其价格、库存、编码（按规格值集合匹配）
5. **缺失的** SKU 新建（价格、库存取默认值 0）
6. **多余的** SKU 一律置 `INACTIVE`（不软删除）

**为什么 INACTIVE 而不是软删除**：商家把某个规格值删掉又加回来时（先下架
「蓝色」，几天后重新上架），软删的 SKU 查不到了——扩展会过滤 `deletedAt`——
重新算规格组合时会新建一个同组合的 SKU，库里就留下两条逻辑重复的记录。
置 `INACTIVE` 没有这个问题：它只表示「这个 SKU 不再使用」，不参与
`minPrice` 计算，公开接口也只返回 `ACTIVE` 的 SKU。

代价是留下一点存储，但换来了「规格反复调整不会产生垃圾数据」。
也因此，「有流水的 SKU 只能停用不能删」这条约束自然成立——SKU 根本不会被
软删除，只会被停用。

**清空规格时的处置**：规格被整体清空后，多余的 SKU 全部置 `INACTIVE`，
维度与取值软删（记录保留——规格值上挂着 SKU 关联与历史流水引用）。
此时商品没有任何 `ACTIVE` 的 SKU，`minPrice` 会变成 0。
这是刻意的：无规格的商品就没有可买的 SKU 变体，商家想恢复就再加规格。

> ⚠️ **Prisma 的 `notIn: []` 匹配不到任何行**，不是匹配全部。
> 软删除「本维度里不再出现的值」时若用
> `where: { specId, id: { notIn: keptValueIds } }`，而 `keptValueIds`
> 恰好为空（维度被整体清空），这条语句会一行都不更新——软删除形同虚设。
> 空集时必须走 `where: { specId }`。

### 5.6 媒体接口

```
POST   /api/v1/media/upload-url     { filename, mime, size }
                                     → { mediaId, uploadUrl, key, expiresIn }
POST   /api/v1/media/:id/confirm    → HEAD 对象确认存在与大小，置 READY
DELETE /api/v1/media/:id            软删除
GET    /api/v1/media                媒体列表（分页）
```

校验：mime 白名单（`image/jpeg` / `image/png` / `image/webp` / `image/gif`），
size ≤ 5MB。

### 5.7 库存接口

```
POST /api/v1/inventory/adjustments
     { skuId, type: "ADJUST_IN"|"ADJUST_OUT"|"CHECK", quantity, reason }
     → { movement, sku }

GET  /api/v1/inventory/movements?skuId=&page=1&pageSize=20
     → 流水列表

GET  /api/v1/inventory/summary?productId=
     → 各 SKU 的当前库存
```

`ADJUST_OUT` 的数量不得超过当前库存，超出返回 400「库存不足」。
`CHECK` 传的是盘点后的绝对值，流水里记成差量。

### 5.8 DTO 约定

**所有新增 DTO 字段必须显式写 `@ApiProperty`。**

阶段 1 的已知遗留项 #2：swagger 的 CLI 插件有上游缺陷，已停用文件扫描，
schema 完全由显式装饰器提供。**漏写装饰器不会报错，只会静默缺字段**，
前端 `openapi-typescript` 生成的类型会少一截。

---

## 六、媒体上传链路

### 6.1 流程

```
浏览器                    后端                      MinIO
  │                        │                        │
  ├─ POST /media/upload-url│                        │
  ├───────────────────────→│ 校验 mime / size      │
  │                        │ 建 Media(PENDING)     │
  │                        │ 生成 presigned PUT ───┼─→ 签发
  │← { mediaId, uploadUrl, key }                    │
  │                        │                        │
  ├─ XHR PUT uploadUrl ────────────────────────────→│ 写对象
  │← 进度事件 / 失败重试                            │
  │                        │                        │
  ├─ POST /media/:id/confirm│                        │
  ├───────────────────────→│ HEAD 对象 ─────────────┼─→ 校验存在与大小
  │                        │ 置 READY               │
  │← { media }                                    │
```

### 6.2 前端直传的实现细节

用 `XMLHttpRequest` 而不是 `fetch`——`fetch` 没有上传进度事件，
商家看不到上传到哪儿了。失败要能重试，重试时复用同一个 presigned URL
（有效期未过时可以重复 PUT 同一个 key）。

### 6.3 本地开发的 MinIO 接入

compose 里**新增** MinIO 服务（阶段 1 的 compose 只有 Postgres + 4 个应用 + nginx，
README 端口表里的 19000 只是预留，服务并不存在）：

- 宿主机端口 19000，容器内 9000（与 README 的端口分配一致）
- bucket 保持私有，只通过后端签发 URL 访问

**镜像来源**：用 `cgr.dev/chainguard/minio`，**不能用官方的 `minio/minio`**。
MinIO 社区版已停止维护，官方镜像先后从两个 registry 消失——2026-09-11
`minio/minio` 从 Docker Hub 删除（拉取报 `not found`），2026-09-24
`quay.io/minio/minio` 也改为要求认证（拉取报 `401`）。最后一个社区版还带
CVE-2026-40344（认证绕过）。Chainguard 那份是从源码重建的，S3 接口与数据格式兼容。

**CORS 靠环境变量配**：该镜像里没有 `mc`、`curl`、`wget`、`nc`，只有 bash 与
coreutils，所以改不了服务端配置，只能用 `MINIO_CORS_ALLOW_ORIGIN`。
实测该变量对预检请求生效。探活同理——用 bash 内置的 `/dev/tcp` 连 9000 端口。

### 6.4 孤儿清理

定时任务（后端内置的简单定时器即可，不引入队列）：把 `PENDING` 超过 24 小时的
媒体记录置为 `ORPHANED`，并删除 MinIO 中可能存在的对象。

---

## 七、主题 token

### 7.1 token 集合（全量）

基于 shadcn/ui 的 CSS 变量体系。商家配置的是**值**，storefront 注入成 CSS 变量。

**颜色格式是 oklch，不是 HSL 三元组。** 仓库里的 `globals.css` 用的是
Tailwind CSS 4 + shadcn/ui 新版，默认值就是 `oklch(0.205 0 0)` 这种写法。
商家配置的颜色必须是**完整的 oklch 字符串**，原样写进 CSS 变量。
取色器给的是 hex，需要在提交前转成 oklch。

**CSS 变量名沿用 shadcn 的约定**：`:root` 里是 `--primary` / `--background` 这类
裸名，Tailwind 侧由 `globals.css` 的 `@theme inline` 映射成 `--color-primary`。
注入时覆盖的是**裸名**那一层。

| 组 | token | 注入的 CSS 变量 |
|----|-------|----------------|
| 语义色（16） | `background` / `foreground` / `card` / `card-foreground` / `primary` / `primary-foreground` / `secondary` / `secondary-foreground` / `muted` / `muted-foreground` / `accent` / `accent-foreground` / `destructive` / `destructive-foreground` / `border` / `ring` | `--background` 等 |
| 圆角 | `radius` | `--radius`（`--radius-sm/md/lg/...` 由它派生） |
| 字体 | `fontSans` / `fontMono` | `--font-sans` / `--font-mono` |
| 字阶（5） | `textXs` / `textSm` / `textBase` / `textLg` / `textXl` | `--text-xs` 等 |
| 字重（4） | `weightNormal` / `weightMedium` / `weightSemibold` / `weightBold` | `--font-weight-normal` 等 |
| 间距（5） | `spaceXs` / `spaceSm` / `spaceBase` / `spaceLg` / `spaceXl` | `--spacing-xs` 等 |
| 阴影（3） | `shadowSm` / `shadowBase` / `shadowLg` | `--shadow-sm` 等 |

`stores.themeTokens` 存的 JSON 结构：

```json
{
  "colors": {
    "primary": "oklch(0.55 0.22 264)",
    "accent": "oklch(0.97 0 0)",
    "background": "oklch(1 0 0)"
  },
  "radius": "0.5rem",
  "fontSans": "Inter",
  "fontMono": "JetBrains Mono",
  "textScale": {
    "xs": "0.75rem", "sm": "0.875rem", "base": "1rem",
    "lg": "1.125rem", "xl": "1.25rem"
  },
  "weights": {
    "normal": "400", "medium": "500", "semibold": "600", "bold": "700"
  },
  "spacing": {
    "xs": "0.25rem", "sm": "0.5rem", "base": "1rem",
    "lg": "1.5rem", "xl": "2rem"
  },
  "shadows": {
    "sm": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    "base": "0 4px 6px -1px rgb(0 0 0 / 0.1)",
    "lg": "0 10px 15px -3px rgb(0 0 0 / 0.1)"
  }
}
```

**结构校验**：只有已知的 token 名会被注入 CSS。`stores.themeTokens` 是
`Json` 字段，客户端可以塞任何东西——注入前必须按白名单过滤，
否则一个 `{ "background": "url(javascript:...)" }` 就能把任意 CSS 注入页面。

### 7.2 注入时机

**在 Server Component 里注入。** 理由：

1. 匿名请求要靠子域名解析租户，而 token 是租户级的——服务端才有这个上下文。
2. 服务端注入顺带避免了 FOUC（首屏闪烁默认配色）。

实现：`storefront/src/app/layout.tsx` 是根 layout，拿不到店铺上下文
（layout 在所有子域名上共享，且 Next.js 的 layout 在子域名多租户场景下
不重新渲染）。因此注入要放在 `(shop)` 路由组的 layout 里，
或者在每个需要渲染主题的 page 里。

> **实施时必须先实测这一点**：Next.js App Router 的 layout 在同一实例服务多个
> 子域名时是否会缓存。若会缓存导致主题串店，必须改用 per-request 渲染
> （`export const dynamic = 'force-dynamic'` 或把注入下移到 page 层）。
> 这是本阶段唯一一处「框架行为未验证就写进设计」的地方，
> 列为 Task 1 的验证项之一。

### 7.3 商家后台的配置界面

商家后台的「店铺设置」页增加「主题」分区，用表单配置上述 token。
每个颜色项配一个取色器 + 色值文本框。

保存后 storefront 刷新即生效，无需重编译。

---

## 八、店铺前台

### 8.1 页面

| 路由 | 内容 |
|------|------|
| `/` | 首页：店铺信息 + 商品流（分页） |
| `/c/[slug]` | 品类页：品类下的商品 |
| `/search?q=` | 搜索结果页 |
| `/p/[slug]` | 商品详情：图、名称、价格、规格选择器、描述、参数表 |

### 8.2 渲染方式

沿用阶段 1 的同源架构：**Server Component 直读后端**（服务端调用，无 CORS 问题），
交互态用客户端组件 + `tanstack-query`。

写操作（未来的加购、收藏）走各自的同源中转路由 `/api/**`。

所有发往 api 的请求都带 `X-Tenant-Subdomain`（§3.6）。

### 8.3 规格选择器

商品详情页的核心交互：

- 规格维度按 `sort` 展示为若干组按钮（如「颜色」「尺码」）
- 选中一个组合后，查出对应的 SKU，显示其价格与库存
- 某个组合不存在对应 SKU（或 SKU 库存为 0）时，该按钮置灰不可选
- 切换某一维度的值时，若与其他维度的当前选择组合不存在，会自动调整为可用组合

「组合是否存在」的判断在前端基于已下发的 SKU 列表完成，不需要额外请求——
所以详情接口要返回完整的 SKU 与规格值对应关系。

---

## 九、商家后台

### 9.1 页面

| 路由 | 内容 |
|------|------|
| `/products` | 商品列表：搜索、品类筛选、状态筛选、批量操作栏 |
| `/products/new` | 新建商品 |
| `/products/[id]` | 编辑商品：基本信息、描述性属性、规格矩阵编辑器、媒体管理 |
| `/products/import` | CSV 导入（基础信息） |
| `/categories` | 品类树管理 |
| `/inventory` | 库存调整与流水查询 |

### 9.2 规格矩阵编辑器

后台最复杂的一块。交互要求：

- 增删规格维度（最多 2 个）、增删规格值（每维最多 20 个）
- 规格值变化后实时预览笛卡尔积的 SKU 数量
- SKU 表格：每个 SKU 一行，填价格、划线价、编码、库存、启用状态
- 已存在且有流水的 SKU，删除列时提示「将停用而非删除」

### 9.3 批量操作

列表页支持勾选后批量上架 / 下架 / 改品类 / 调整价格 / 删除。
批量删除是软删除。服务端单事务，全成功或全失败。

CSV 导入在独立的 `/products/import` 页面，逐行展示结果
（成功 / 失败原因 + 行号），不因为个别行失败而中断整批。

---

## 十、测试策略

延续阶段 1 的做法：e2e 为主力，**失败注入**（恒真自检）作为验收重点。

### 10.1 单元测试

- `minPrice` 重算逻辑（含下架 SKU 不参与计算）
- 规格笛卡尔积生成与匹配
- 主题 token 的结构校验与 CSS 变量拼装
- 软删除条件的合并

### 10.2 e2e 测试

| 场景 | 断言 |
|------|------|
| 跨租户商品不可见 | A 的商品在 B 的公开列表里查不到 |
| 跨租户商品不可改 | A 改 B 的商品 → 404 |
| 跨租户品类不可挂载 | A 把商品挂到 B 的品类 → 明确报错 |
| 软删除生效 | 删除的商品不再出现在列表与搜索结果里 |
| 软删除穿透关联读取 | 软删一张媒体图后，商品详情的媒体列表不含它；软删一个 SKU 后，商品详情的 SKU 列表不含它 |
| 规格替换 | 笛卡尔积正确；已有 SKU 的价格被保留；多余 SKU 被软删或停用 |
| 乐观锁 | version 不匹配 → 409 |
| 库存调整 | 流水记录正确；`ADJUST_OUT` 超量 → 400 |
| 公开接口隔离 | 不带子域名的请求 → 404；伪造子域名头只能看到公开数据 |
| 搜索 | 关键词命中；品类筛选；价格区间；下架商品搜不到 |
| minPrice 一致性 | 改 SKU 价格后商品 minPrice 同步 |

### 10.3 失败注入（验收重点）

每一项都要把保护逻辑临时改坏，确认对应测试**真的会失败**：

| 护栏 | 注入方式 | 预期 |
|------|---------|------|
| 租户隔离 | 去掉 `where.tenantId` 的合并 | 跨租户用例失败 |
| 软删除过滤 | 去掉 `deletedAt: null` 的合并 | 软删除用例失败 |
| minPrice 同步 | 去掉价格变更后的重算 | 一致性用例失败 |
| 乐观锁 | 去掉 version 校验 | 并发用例失败 |
| 库存不为负 | 去掉出库量校验 | 超量用例失败 |
| 公开接口 | 让公开端点走 `@Skip()` | 公开用例失败（500） |

### 10.4 前端验证

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`；
storefront 与 merchant-admin 的关键路径用真实浏览器点一遍（规格选择器、
批量操作、主题保存后刷新生效）。

---

## 十一、实施顺序

12 个 Task，**分两份实施计划**。拆分的理由是范围：11 个 Task 横跨后端 5 个模块
与 3 个前端应用，一份计划写下来超过 6000 行，实施时难以保持单份计划的聚焦度。
拆开后每份都能独立交付与验收。

| # | Task | 关键产出 | 落在 | 前置 |
|---|------|---------|------|------|
| 1 | 基础设施与前置验证 | compose 接 MinIO；验证 `pg_trgm`、MinIO 直传 CORS | 计划 2a | — |
| 2 | 数据模型与迁移 | 9 张表 + `minPrice` + 部分唯一索引 + trgm 索引；扩展加软删除合并 | 计划 2a | 1 |
| 3 | 品类模块 | 树形 CRUD、深度校验、跨租户挂载拦截 | 计划 2a | 2 |
| 4 | 商品 CRUD 与 minPrice | 商品增删改查、状态流转、`minPrice` 重算、乐观锁 | 计划 2a | 2, 3 |
| 5 | 规格矩阵 | 笛卡尔积生成、整体替换、有流水的 SKU 降级为停用 | 计划 2a | 4 |
| 6 | 媒体上传 | presigned 签发、confirm、孤儿清理 | 计划 2a | 1, 2 |
| 7 | 库存流水 | 调整接口、append-only 流水、枚举留位 | 计划 2a | 2, 4 |
| 8 | 公开读与搜索 | `@Public()` 端点、pg_trgm 搜索、字段裁剪 | 计划 2a | 3, 4, 5 |
| 9 | 主题 token | 全量 token 定义、商家表单、storefront 注入 | 计划 2b | 2 |
| 10 | storefront 浏览页 | 列表、品类筛选、详情、规格选择器 | 计划 2b | 8, 9 |
| 11 | 商家后台 | 商品 CRUD、规格矩阵编辑器、批量操作、CSV 导入导出、库存页 | 计划 2b | 6, 7, 8 |
| 12 | 验收 | 跨租户隔离、失败注入、浏览器手测 | 计划 2b | 全部 |

**计划 2a（商品中心后端）**交付后：商家能通过 API 建品类、上架带规格的商品、
传图、调库存；公开读接口与搜索可用。**计划 2b（商品中心前端与主题）**
在其上补齐三个前端的界面与主题渲染。

**顺序上的硬约束：**

- Task 4（商品模型）必须早于 Task 10 / 11（前端）。规格矩阵的数据结构是前端
  编辑器的基础，反过来做必然返工。
- Task 6（媒体）必须早于 Task 11，因为商品编辑表单要挂图。

**四项前置验证必须尽早做**，每一项失败都对应一个方案要换：

| 验证项 | 在哪验证 | 失败时的后果 |
|--------|---------|-------------|
| `CREATE EXTENSION pg_trgm` 能否在迁移里执行 | Task 1 | 搜索方案要换（如退回 `ILIKE` 全表扫描，或换分词方案） |
| MinIO 直传的 CORS 能否配通 | Task 1 | 媒体方案退回「经后端中转」 |
| Prisma 关联读取是否触发扩展过滤 | Task 2（扩展改完立刻验） | 软删除方案要改（否则软删的 SKU 仍会出现在商品详情里） |
| Next.js layout 是否按子域名分别渲染 | Task 9（主题注入前） | 主题注入要改到 page 层或强制动态渲染 |

后两项需要对应的代码先存在才能验，因此排在对应 Task 的第一步，
而不是全部堆在 Task 1。

---

## 十二、与主设计文档的编号映射

主设计文档 §3 的路线图（阶段 1–5）与实施计划编号（计划 1–4）不是一套编号：

| 主设计文档 | 实施计划 | 本文档对应 |
|-----------|---------|-----------|
| 阶段 1（扩展版，含库存营销计费） | 计划 1「平台地基与身份体系」 | — （已完成） |
| 阶段 2「交易闭环加固」 | 计划 2「商品中心与店铺前台浏览」 | **本文档** |
| 阶段 2 / 阶段 3 | 计划 3「交易链路：购物车 → 库存 → 订单 → 支付」 | — |
| 阶段 3 / 阶段 4 | 计划 4「营销、平台计费与平台超管的完整实现」 | — |
| 阶段 5 | （可选）国际化与生态 | — |

计划 2 落地后，需要修订主设计文档 §3 的路线图表述，使其与实施计划编号一致。

---

## 十三、开放问题

| # | 问题 | 暂定处理 |
|---|------|---------|
| 1 | 店铺 `status` 为 `PAUSED` 时，公开接口应返回空列表还是 404？ | **已定**：返回空列表（见 §5.2）。404 会泄露店铺运营状态。`DRAFT` 不拦截——注册后店铺就是 `DRAFT` |
| 2 | 商品 slug 改名后旧链接是否重定向？ | 本阶段不重定向，商家改名要自己承担。计划 3 可加 301 |
| 3 | 规格维度是否全局共享（如所有商品的「颜色」共用一套）？ | 不共享，商品级定义。共享是「属性模板」路线的一部分，不在本阶段 |
| 4 | 库存是否需要多仓？ | 单仓。触发时机见 §四.11 |
| 5 | 媒体是否需要视频？ | 本阶段只支持图片。视频要处理转码与播放器，成本高 |
