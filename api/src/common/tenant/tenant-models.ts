/**
 * 店铺子域名的合法格式：长度 3-32，首尾必须是字母或数字，中间可含连字符。
 *
 * 单一事实来源：写入侧（Task 6 的注册 DTO）与读取侧（子域名解析）都必须引用这里，
 * 严禁各自复制一份正则——两处漂移会让「注册时被拒的格式」仍然能通过 Host 头进入解析。
 */
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$/;

/**
 * 平台保留子域名：这些名字留给基础设施自己用，不允许商家注册或解析。
 *
 * 命中时按「无法确定店铺」处理（不查库、错误措辞与「不存在」一致），
 * 既防止子域名接管，也避免攻击者通过响应差异枚举出商家目录。
 *
 * 两个理由：
 * 1. 子域名接管——商家可以注册 `admin` 这个子域名；将来基础设施一旦把
 *    `admin.platform.test` 指向超管后台，攻击者拿到的就是一个可被劫持的入口。
 * 2. 侧信道枚举——若保留字与「不存在」返回不同响应，攻击者用同一套字典
 *    就能判断哪些子域名被占用，从而枚举出商家目录。
 *
 * ⚠️ 这份名单**不是穷尽的**，只覆盖常见的基础设施保留名。新增内部子域名时
 * 必须同步登记到这里；真正彻底的防护在网关层的子域名白名单——网关只允许
 * 已注册的店铺子域名解析到应用，保留字根本不进入应用。
 */
export const RESERVED_SUBDOMAINS = new Set<string>([
  'admin',
  'api',
  'app',
  'auth',
  'cdn',
  'dashboard',
  'dev',
  'docs',
  'health',
  'internal',
  'login',
  'mail',
  'media',
  'platform',
  'register',
  'static',
  'status',
  'test',
  'www',
]);

/** 子域名是否合法（调用前需先 trim + 转小写） */
export function isValidSubdomain(value: string): boolean {
  return SUBDOMAIN_PATTERN.test(value);
}

/**
 * 租户作用域模型白名单。
 * 名单内的模型：所有读写自动追加 tenantId 条件。
 * 新增业务表时必须同步登记到此处，否则等于没有隔离。
 *
 * ⚠️ 阶段 1 的 TenantPrismaService.assertTenantScopedModelsRegistered()
 * 会在启动时扫描 schema，带 tenantId 却没登记的模型会直接让进程启动失败。
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'User',
  'Store',
  // 商品中心（计划 2）
  'Category',
  'Product',
  'ProductSpec',
  'ProductSpecValue',
  'Sku',
  'SkuSpecValue',
  'Media',
  'ProductMedia',
  'InventoryMovement',
  // 交易链路（计划 3）
  'Cart',
  'CartItem',
  'Address',
  'Order',
  'OrderItem',
  'Payment',
  // 营销（计划 5a）
  'Coupon',
  'CouponClaim',
  'CouponRedemption',
  'Promotion',
  // 平台计费（计划 5b）
  'Subscription',
  'Invoice',
  'PaymentMethod',
  // 抽佣流水（阶段 5e）
  'CommissionEntry',
  // ⚠️ Plan 刻意**不在**这里：它不带 tenantId 字段，
  // 是「平台的数据」而不是「租户的数据」——先例是阶段 3 的 PaymentWebhookEvent。
  // ⚠️ PaymentWebhookEvent 刻意**不在**这里：它是渠道事件的数据，不是租户的数据，
  // 租户从订单反查。
]);

/**
 * 走软删除的模型：扩展自动合并 `deletedAt: null` 条件。
 *
 * 不含 InventoryMovement —— 流水表是 append-only 的审计凭证，
 * 既不软删也不允许物理删除。
 */
/**
 * 走软删除的模型：扩展自动合并 `deletedAt: null` 条件，并禁止物理删除。
 *
 * ⚠️ 这份名单必须与 schema 里带 `deletedAt` 的模型**一一对应**。
 * 漏登记一张表，后果不是「少过滤一点」，而是那两张表上的软删完全失效：
 * 顶层查询读得到已软删的记录，物理删除也拦不住。
 *
 * 真实踩过的坑：`ProductSpec` / `ProductSpecValue` 漏登记，而
 * `spec-matrix.service.ts` 的注释写着「已软删的值会被扩展过滤掉，所以复用
 * 分支命中的一定是活的」——前提不成立。商家把规格值删掉再加回来时会命中
 * 已软删的旧行并复用它，而它的 deletedAt 仍是过去时间，于是**加回来的值
 * 在界面上依然不可见**，规格值凭空消失。
 *
 * 改这张表前先对一遍 schema：
 *   grep -l 'deletedAt' prisma/schema.prisma
 *   再列出所有带 deletedAt 的 model 名，两边必须一致。
 */
export const SOFT_DELETE_MODELS = new Set<string>([
  'Category',
  'Product',
  'ProductSpec',
  'ProductSpecValue',
  'Sku',
  'Media',
  // 交易链路（计划 3）：只有地址簿走软删。
  // Cart / CartItem 不软删——购物车是临时数据，清空即删。
  // Order / OrderItem / Payment 不软删——它们是财务凭证，只能靠状态机流转，不能删。
  'Address',
  // 营销（计划 5a）：券与活动是**营销配置**，商家可能想「下架」但保留
  // 历史核销记录的可追溯性，所以走软删。
  //
  // ⚠️ CouponClaim / CouponRedemption **不软删**——它们是财务凭证
  //（与 InventoryMovement 同款理由：append-only 的审计记录）。
  'Coupon',
  'Promotion',
]);

/**
 * Prisma 中只接受唯一字段作为 where 的方法。
 *
 * 这些方法无法附加 tenantId 条件，会造成跨租户越权，因此禁止在租户作用域模型上使用：
 * - findUnique / findUniqueOrThrow：读层面越权（按唯一字段读会读到别人租户的数据）
 * - update / delete：写层面越权（按唯一字段改/删会改到别人租户的数据）
 * - upsert：where 必须是唯一字段，无论是 `where: { id }` 还是
 *   `where: { tenantId_slug: { ... } }` 都会形成越权通道——
 *   前者完全无 tenantId 条件，后者里嵌入的 tenantId 也可以被伪造成别的租户
 *
 * 注意：`updateOrThrow` / `deleteOrThrow` 已从 Prisma 6 的裸 client 上彻底移除，
 * 扩展后的 client 上同样不存在，既无法调用也不可能成为越权通道。
 */
export const UNIQUE_ONLY_OPERATIONS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

/**
 * 被禁止的方法对应的「推荐替换」。
 *
 * 当扩展抛 `TenantScopeError` 提示调用方改用什么替代写法时，用这个映射生成文案，
 * 避免在各处用三元表达式硬编码。
 */
export const RECOMMENDED_REPLACEMENT: Record<string, string> = {
  findUnique: 'findFirst',
  findUniqueOrThrow: 'findFirst',
  update: 'updateMany',
  delete: 'deleteMany',
  upsert: 'findFirst 判断后分别 create 或 updateMany',
};
