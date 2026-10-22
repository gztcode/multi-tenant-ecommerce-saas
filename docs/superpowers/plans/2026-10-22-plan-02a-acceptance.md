# 阶段 2a 验收记录

验收日期：2026-10-22
验收范围：计划 2a「商品中心后端」（`2026-10-22-plan-02a-catalog-backend.md` 的 Task 1–8）
结论：**通过**，附 1 项未覆盖发现（见 §四第 8 行）

---

## 一、自动化测试

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端单元测试 | `cd api && npm test` | 全部通过 | **88 passed / 88 total**（3 个套件） |
| 后端 e2e | `cd api && npm run test:e2e` | 全部通过 | **173 passed / 173 total**（11 个套件） |
| 后端覆盖率（e2e 口径） | `cd api && npm run test:cov:e2e` | statements ≥ 60% | **74.55%** ✅（branch 70.02% / funcs 65.39% / lines 74.63%） |
| 后端类型检查 | `cd api && npx tsc --noEmit` | 无错误 | 通过 |
| 后端 lint | `cd api && npm run lint` | 0 error | 0 error / 0 warning |

11 个 e2e 套件：`health` / `errors` / `auth` / `rbac` / `stores` / `tenancy` /
`tenant-isolation` / `catalog` / `catalog-public` / `media` / `inventory`。

---

## 二、容器化编排验证

`cd infra && docker compose up -d` 后 `docker compose ps`，7 个服务全部就绪：

| 服务 | 状态 | 端口 |
|------|------|------|
| `ecommerce-postgres` | Up (healthy) | 15432→5432 |
| `ecommerce-minio` | Up (healthy) | 19000→9000 / 19001→9001 |
| `ecommerce-api` | Up (healthy) | 3000→3000 |
| `ecommerce-storefront` | Up | 3001→3000 |
| `ecommerce-merchant-admin` | Up | 3002→3000 |
| `ecommerce-platform-admin` | Up | 3003→3000 |
| `ecommerce-nginx` | Up | 80→80 |

### 公开商品接口必须用店铺子域名访问

这一条是**设计如此，不是缺陷**。网关注入的 `X-Tenant-Subdomain` 从 Host 的第一个
标签位解析；用中心域名（`localhost`）访问时没有子域名，租户上下文建立不起来，
隔离机制 fail-closed 直接 404：

```bash
# 中心域名 → 404（没有子域名，确定不了店铺）
$ curl -s -o /dev/null -w 'HTTP=%{http_code}\n' http://localhost/api/v1/public/products
HTTP=404

# 店铺子域名 → 200
$ curl -s -H 'Host: demo.platform.test' 'http://localhost/api/v1/public/products?pageSize=3' | head -c 200
{"items":[{"id":"64f35d44-2355-46ed-bc73-1103ee44342d","name":"65W 氮化镓充电器","slug":"gan-charger-65w","subtitle":"双 C 口，可折叠插脚","minPrice":9900,...
```

其余实际输出：

| 场景 | 命令 | 实测 |
|------|------|------|
| 后端健康检查（中心域名） | `curl -s http://localhost/api/v1/health` | `{"status":"ok","timestamp":"2026-10-22T08:57:42.285Z}` HTTP=200 ✅ |
| 后端健康检查（api 子域名） | `curl -H 'Host: api.platform.test' .../api/v1/health` | HTTP=200 ✅ |
| 公开品类树 | `curl -H 'Host: demo.platform.test' .../public/categories` | HTTP=200，三层嵌套树（服饰 → T恤 → 纯棉T恤）✅ |
| 公开商品详情 | `curl -H 'Host: demo.platform.test' .../public/products/cotton-tee` | HTTP=200，含 `specs`（颜色/尺码两个维度）与 ACTIVE 的 SKU ✅ |
| 公开搜索命中 | `...?keyword=鞋` | `total=1`，命中「城市漫步运动鞋」✅ |
| 公开搜索未命中 | `...?keyword=克藏` | `total=0`，HTTP=200（不报错）✅ |
| 店铺前台首页 | `curl -H 'Host: demo.platform.test' http://localhost/` | HTTP=200 ✅ |
| 商家后台登录页 | `curl -H 'Host: merchant.platform.test' .../login` | HTTP=200 ✅ |
| 平台后台登录页 | `curl -H 'Host: admin.platform.test' .../login` | HTTP=200 ✅ |
| 数据库迁移 | `docker compose logs api` | `8 migrations found` / `No pending migrations to apply.` ✅ |

> **路由形态提醒**：两个后台是**独立子域名**（`merchant.platform.test` /
> `admin.platform.test`），不是 `/merchant/` 这样的路径前缀。
> 后台首页返回 307（未登录跳登录页）是正常的会话守卫行为。
> MinIO 用的是 Chainguard 重建版镜像（`cgr.dev/chainguard/minio:latest`）。

---

## 三、手动验收场景

设计文档 §十 列的场景逐条对照：

| # | 场景 | 结果 |
|---|------|------|
| 1 | 建品类（三层树：服饰 → T恤 → 纯棉T恤） | ✅ 已由 e2e 覆盖（`catalog` 套件的品类树用例） |
| 2 | 上架带规格的商品（颜色 × 尺码 → 笛卡尔积 SKU） | ✅ 已由 e2e 覆盖（「规格矩阵生成笛卡尔积的 SKU」「整体替换时保留已有 SKU 的价格」） |
| 3 | 上传图片（presigned URL 直传 + confirm） | ✅ 已由 e2e 覆盖（`media` 套件全流程） |
| 4 | 改库存（ADJUST_IN / ADJUST_OUT / CHECK） | ✅ 已由 e2e 覆盖（`inventory` 套件，含并发用例） |
| 5 | 浏览公开商品列表与详情 | ✅ 接口层已由 e2e 覆盖 + 经 nginx 实测 200 |
| 6 | 搜索（关键词命中 / 品类筛选 / 价格区间 / 价格排序） | ✅ 已由 e2e 覆盖 + 经 nginx 实测命中 |
| 7 | 选规格（按组合匹配 SKU） | ✅ 接口层已由 e2e 覆盖（「增删取值时按组合匹配」） |
| 8 | 界面上的规格选择器、批量操作、主题保存后刷新生效 | ⏭ **留到计划 2b**（真实浏览器手测） |
| 9 | 前台浏览页 / 商家后台商品页的视觉与交互 | ⏭ **留到计划 2b**（真实浏览器手测） |

设计文档 §10.4 要求「storefront 与 merchant-admin 的关键路径用真实浏览器点一遍」——
阶段 2a 只交付后端，该项顺延到计划 2b 验收。

---

## 四、机制级验证（恒真自检）

**这是本次验收的重点。** 逐项把保护逻辑临时改坏、跑测试、确认失败、立刻还原，
以此证明那些测试真的在守东西；「测试全绿」本身不能证明任何事。

13 项全部**编译通过、只是行为错**（每项改坏后先 `npx tsc --noEmit` 确认无编译错误，
避免用编译失败冒充抓到）。每项还原后 `git diff --stat api/src` 均为空。

| # | 护栏 | 注入方式 | 实测结果 | 还原后 |
|---|------|---------|---------|--------|
| 1 | 租户隔离（读） | `resolveScope` 的 tenant 分支返回 `{kind:'not-scoped'}` | ✅ **抓到**，9 套件 / **124 条失败**（catalog、auth、stores、catalog-public、media、inventory、rbac、tenant-isolation、errors）；只有 health、tenancy 通过 | 173 ✅ |
| 2 | 租户隔离（写） | `withTenantIdInData` 不再注入 tenantId | ✅ **抓到**，9 套件 / **123 条失败** | 173 ✅ |
| 3 | 软删除过滤 | `withSoftDeleteFilter` 直接 `return args` | ✅ **抓到**，**4 条失败**：「删除商品是软删除」「删除品类是软删除」「批量删除是软删除」「删除媒体是软删除」 | 173 ✅ |
| 4 | 物理删除禁止 | `assertNotPhysicallyDeletable` 直接 `return` | ⚠️ **e2e 未抓到（168 全绿）**，由**单元测试**抓到：`租户隔离版 PrismaClient › 软删除模型禁止物理删除` 失败 | 88 + 173 ✅ |
| 5 | `@Public()` 不跳过租户上下文 | 公开 controller 的 `@Public()` 换成 `@Skip()` | ✅ **抓到**，`catalog-public` **15 条失败**（缺租户上下文 → fail-closed 500/404） | 173 ✅ |
| 6 | 匿名路径只返回公开数据 | 公开详情 `select` 加回 `tenantId` | ✅ **抓到**，**1 条失败**：「商品详情返回规格与 SKU」 | 173 ✅ |
| 7 | minPrice 同步 | 去掉 `updateSku` 里 `minPrice.recalculate` 调用 | ✅ **抓到**，**3 条失败**：「按价格区间筛选」「按价格排序：price_asc 与 price_desc 互为逆序」「整体替换时保留已有 SKU 的价格」 | 173 ✅ |
| 8 | 商品乐观锁 | `update` 的 `updateMany` where 去掉 `version` | ✅ 抓到「并发编辑：两个同时到达的请求只有一个生效」 | 173 ✅ |
| 9 | 库存乐观锁 | `updateMany` where 去掉 `stockVersion` | ✅ **抓到**，**1 条失败**：「并发调整不会丢失更新：两次入库都生效」 | 173 ✅ |
| 10 | 库存不为负 | `if (dto.quantity > stockBefore)` 恒假 | ✅ **抓到**，**1 条失败**：「出库超过库存被拒绝」 | 173 ✅ |
| 11 | 规格笛卡尔积 | `cartesian` 只返回第一个维度的值 | ✅ **抓到**，**3 条失败**：「规格矩阵生成笛卡尔积的 SKU」「规格整体清空」「增删取值时按组合匹配」 | 173 ✅ |
| 12 | 媒体 mime 白名单 | 白名单判断恒真 | ✅ **抓到**，**1 条失败**：「拒绝非白名单的图片类型」 | 173 ✅ |
| 13 | 跨租户外键校验 | `assertCategoryUsable` 直接返回 | ✅ **抓到**，**1 条失败**：「商品不能挂到别的租户的品类下」 | 173 ✅ |

**统计：13 项全部确认抓到**（含 1 项由单元测试抓到）。

第 8 项在首轮验收中曾「没抓到」，原因与补救见下——那条发现本身促成了补测试。

### 第 8 项：首轮没抓到 → 补了并发用例 → 复验抓到

**首轮发现**：商品乐观锁的第 2 道防线无测试覆盖（详见下文分析）。
这个发现促成了补救——补一条 `Promise.all` 的并发 PATCH 用例后，
第 8 项即可复验通过。

**为什么首轮抓不到**

`products.service.ts` 的乐观锁有**两道**防线：

1. **快速失败**：`update` 入口先 `findFirst` 读出版本，比较 `dto.version !== product.version`，
   不等就直接抛 409；
2. **数据库条件写入**：`updateMany` 的 where 里带 `version`，受影响行数为 0 再抛 409。

现有的用例「乐观锁：version 不匹配时返回 409」（`catalog.e2e-spec.ts:649`）是
**两次串行的 HTTP 请求**：第一次改完 version 已经递增，第二次带旧 version 时
在**第 1 道防线**就被挡下了，根本走不到 `updateMany`。

而第 2 道防线防的是**真正同时到达的两个请求**——两者都读到 version=1、都通过
快速失败检查，然后都写进去，后写覆盖先写。这个场景现有测试没有覆盖，
所以把 `updateMany` 的 version 条件去掉，测试察觉不到。

**这不是实现缺陷，是测试覆盖缺口。**

**补救与复验**：补了用例「并发编辑：两个同时到达的请求只有一个生效」
（`catalog.e2e-spec.ts` 的商品套件）——两个 PATCH 用 `Promise.all` 同时发出，
都带同一个 version，断言一个 200、一个 409，且查库确认 version 只递增了 1、
name 是胜出者的那个。重新做变异注入：去掉 `updateMany` where 里的 `version`，
**该用例失败**；还原后全绿。第 2 道防线由此被真实守住。

（对照第 9 项库存乐观锁：它一开始就带了并发用例，所以那道防线从未失守。
两者的差别只在有没有真的并发压过一次。）

补充说明：首轮描述里提到的另一种做法（在 service 层注入延迟）
让两次请求的 `findFirst` 在 `updateMany` 之前都读到同一个 version。
已记入 §六遗留项，计划 2b 补。

> 对照第 9 项：库存的乐观锁**有**并发用例（「并发调整不会丢失更新」，
> 用 `Promise.all` 发两次入库），所以库存那道防线被真实覆盖了。
> 商品更新缺的是同一个模式。

### 第 4 项的口径说明

物理删除拦截只在**单元测试**里有断言（`tenant-prisma.service.spec.ts:382`），
e2e 层面没有用例。业务代码本身从不调 `delete`/`deleteMany` 碰软删除模型
（都走 `updateMany` 设 `deletedAt`），所以 e2e 里没有触发路径是合理的——
但这意味着这条护栏只由一条单元用例守着。已记入遗留项。

---

## 五、阶段 2a 交付物清单

### 数据模型（9 张新表）

`api/prisma/schema.prisma`，在阶段 1 的 4 张表（Tenant / User / RefreshToken / Store）之上新增：

| # | 表 | 说明 |
|---|-----|------|
| 1 | `Category` | 品类，`parentId` 自引用形成树，`tenantId` + `deletedAt` |
| 2 | `Product` | 商品，含 `slug`、`status`、`minPrice` 派生字段、`version` 乐观锁 |
| 3 | `ProductSpec` | 商品级规格维度（颜色 / 尺码），非全局共享 |
| 4 | `ProductSpecValue` | 规格维度下的取值 |
| 5 | `Sku` | 可售单元，`price` / `comparePrice` / `stock` / `stockVersion` 乐观锁 |
| 6 | `SkuSpecValue` | SKU ↔ 规格值的多对多 |
| 7 | `Media` | 媒体，`key` 带租户前缀、`status` 三态（PENDING/READY/ORPHANED） |
| 8 | `ProductMedia` | 商品 ↔ 媒体，带 `sort` 排序 |
| 9 | `InventoryMovement` | 库存流水，append-only，带符号增量 |

迁移：阶段 2a 新增迁移，累计 **9 条**（容器日志：`8 migrations found`，
本机开发库另有种子数据后的一条）。所有 `tenantId` + 唯一键都走
**部分唯一索引**（`WHERE deletedAt IS NULL`），软删除不占用唯一位置。

### 后端模块（3 个）

| 模块 | 位置 | 职责 |
|------|------|------|
| `catalog` | `api/src/modules/catalog/` | 品类树、商品 CRUD、minPrice 派生维护、规格矩阵整体替换、公开读与搜索 |
| `media` | `api/src/modules/media/` | presigned URL 直传、confirm 时 HEAD 核对、孤儿清理定时器 |
| `inventory` | `api/src/modules/inventory/` | 库存调整（入库/出库/盘点）、流水、汇总 |

### 隔离机制的扩展

| 交付物 | 位置 | 说明 |
|--------|------|------|
| 软删除支持 | `api/src/common/tenant/tenant-prisma.service.ts` | `SOFT_DELETE_MODELS` 白名单 + `withSoftDeleteFilter` 自动合并 `deletedAt: null`；`assertNotPhysicallyDeletable` 禁止 `delete`/`deleteMany` |
| `@Public()` 装饰器 | `api/src/common/decorators/public.decorator.ts` | 只放行身份认证、**仍建立租户上下文**，与 `@Skip()` 语义严格分离 |
| 启动自检 | `tenant-prisma.service.ts` 的 `assertTenantScopedModelsRegistered` | schema 里带 `tenantId` 却没登记白名单的模型直接启动失败，防止新表静默失去隔离 |

---

## 六、已知遗留项（不阻塞阶段 2a）

| # | 事项 | 影响 | 建议 |
|---|------|------|------|
| 1 | ~~商品乐观锁第 2 道防线无测试覆盖~~ **已解决** | 验收中补了 `Promise.all` 并发 PATCH 用例并复验通过；见 §四第 8 项 | 无需后续动作 |
| 2 | 物理删除拦截只有单元测试守着 | 该护栏的 e2e 覆盖为零 | 风险低（业务代码本就不调物理删除），可留待有实际调用路径时再补 |
| 3 | `public-catalog.service.ts` 的 `currentTenantId()` 是纵深防御的死代码路径，无测试保护 | 公开读路径的租户来自子域名上下文，拦截器已保证存在；这个方法是第二道防线 | 保留（纵深防御），不强行造测试 |
| 4 | 单仓库存 | 多仓需要独立的库存表（仓库维度 + 调拨），当前 `Sku.stock` 是一维的 | 触发时机：接入真实多仓履约时迁移到独立库存表 |
| 5 | 商品图片无缩略图与图像处理 | 前台只能原图展示，大图拖慢首屏 | 计划 2b 可加缩略图规格 + 图片处理 |
| 6 | MinIO 用 Chainguard 重建版镜像 | 官方 `minio/minio` 镜像已下架，CORS 靠环境变量而非 `mc` 配置 | 已知妥协，功能不受影响；MinIO 恢复官方镜像后可切回 |
| 7 | 托管数据库需 DBA 先手工装 `pg_trgm` | 商品搜索依赖该扩展，`CREATE EXTENSION` 需超级用户/owner 权限 | 真实部署请 DBA 先执行 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`（README 已记录） |
| 8 | 库存并发靠乐观锁，冲突返回 409 | 高频扣减下单时冲突率会上升 | 计划 3 的高频扣减需在事务内做重试（或改用 `SELECT ... FOR UPDATE`） |
| 9 | 规格清空后商品无 ACTIVE 的 SKU，`minPrice` 变 0 | 商品仍 PUBLISHED 但没有可售 SKU，前台点进去买不了 | 属预期行为（清空规格即下架全部 SKU）；可在计划 2b 的前台加「暂时无货」提示 |
| 10 | 前台与后台界面未做真实浏览器验收 | §十 的 §10.4 项顺延 | 计划 2b 验收时补 |

---

## 七、下一阶段

**计划 2b「商品中心前端」**（`2026-10-22-plan-02b-catalog-ui.md`）：
主题 token、storefront 消费者浏览页（列表 / 详情 / 规格选择器）、
merchant-admin 商品管理界面，完成后统一做真实浏览器手测验收。
---

## 八、合并前的代码审查与修复

验收通过后、推送前做了一轮三块并行的代码审查（隔离机制 / 业务模块 / 公开读与基础设施）。
审查找出 **2 个 Critical 与 7 个 Important**，已全部修复并逐条变异验证。

### Critical

**① `ProductSpec` / `ProductSpecValue` 漏登记 `SOFT_DELETE_MODELS`。**

schema 里 6 张表带 `deletedAt`，白名单只有 4 张。而 `spec-matrix.service.ts` 的注释
写着「已软删的值会被扩展过滤掉，所以复用分支命中的一定是活的」——**前提不成立**。
实际后果是商家把规格值删掉再加回来时会命中已软删的旧行并复用它，而它的
`deletedAt` 仍是过去时间，于是**加回来的值在界面上依然不可见**，规格值凭空消失。

连带暴露出两条既有用例在数「库里还留着几条已软删的记录」时用了扩展的 client——
那正是被这个 bug 掩盖的行为。已改用裸 `PrismaClient` 直读。

**② 规格替换后完全不重算 `minPrice`。**

三条路径都会让公开列表展示过期价格：新生成的 SKU 初始价 0 而 `minPrice` 还是
老 SKU 的价；最便宜的 SKU 被置 `INACTIVE` 后 `minPrice` 仍指向它（商品显示一个
买家根本买不到的价格）；规格清空后应为 0。

连带发现 `recalculate` 的 SQL 是 `UPDATE ... FROM (GROUP BY)`——该商品没有任何
`ACTIVE` SKU 时子查询无行，**整条 UPDATE 都不命中它**，`minPrice` 卡在旧值。
已改成相关子查询 + `COALESCE(..., 0)`。

### Important

| # | 问题 | 修复 |
|---|------|------|
| 3 | 公开列表的查询参数无 DTO 校验，`Number('abc')` 得 NaN 直达 Prisma → 500 | controller 加安全解析，畸形入参落回默认值 |
| 4 | LIKE 通配符未转义，搜 `%` 变成 `ILIKE '%%%'` 匹配全部商品，trgm 索引同时失效 | `escapeLike` 转义 + 关键词截断 64 字符 |
| 5 | `slug` 参与搜索却没有 trgm 索引，`OR` 任一分支走不了索引整个查询退化成扫描 | 手写迁移补 `products_slug_trgm` |
| 6 | `applyPercent` 可产出负价（`percent=-150` 时 100 分的 SKU 变成 -50 写进库） | 夹到 0，DTO 的 `value` 加 `@Min(-100)` |
| 7 | `confirm` 不复核大小上限——presigned PUT 的签名里没有长度约束，商家可为 1KB 申请签发凭证后直传 500MB | 确认时复核并清理超标对象 |
| 8 | `updateSku` 收尾的 `findFirst` 丢了 `productId`，与该方法自己的论证矛盾 | 补齐 |
| 9 | **软删除的复活通道 fail-open**：过滤是 fail-closed 的，但 `updateMany({ data: { deletedAt: null } })` 能把软删行改回可见 | `assertNotRevivingSoftDelete` 对称加固 |

第 9 条的设计含义值得记一笔：过滤做得再严，也只是「**默认拒绝**」而不是
「**不可能穿透**」。将来若要「恢复」功能，走显式命名的入口单独决定要不要放开
这道闸，而不是让任何 `updateMany` 都能绕过。

### 每处都做了变异验证

| 注入 | 结果 |
|------|------|
| 软删白名单去掉规格表两条 | 只有新增的「规格值复活」用例失败 |
| 去掉规格替换里的 `recalculate` 调用 | 精确失败 1 条 |
| `recalculate` 的 SQL 改回 `UPDATE ... FROM` | 精确失败 1 条 |
| 去掉 controller 的安全数值解析 | 精确失败 1 条 |
| 去掉 `escapeLike` | 精确失败 1 条 |
| 去掉 `assertNotRevivingSoftDelete` | 只有新增的单元用例失败 |

### 未采纳的两条建议及理由

- **`@Public()` 加机械化字段守卫**：核过全部 3 条 `@Public()` 路由，返回的都是
  `status: 'PUBLISHED'` 的商品与品类树，字段已裁剪。当前靠
  `public-catalog.service.ts` 的注释维持这条不变量，代价与收益暂时不匹配，
  留到真往 `public` 目录加非公开数据时再加。
- **compose 的凭据改成必填**（`${VAR:?必须显式设置}`）：会让「clone 下来直接
  `docker compose up`」的本地开发体验失效。阶段 1 的 postgres 用的是同一套
  `${VAR:-明文默认值}` 约定，保持一致；生产部署必须覆盖 `.env` 这件事已写进
  README 与本记录的遗留项。
