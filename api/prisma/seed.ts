import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * 阶段 2a 的示例店铺子域名。
 *
 * ⚠️ 不能落在 RESERVED_SUBDOMAINS 里（admin / api / media 等），
 * 否则注册与子域名解析都会被拒。
 */
const DEMO_SUBDOMAIN = 'demo';

/** 平台超管账号（阶段 1 起就有，保留原逻辑） */
async function seedPlatformAdmin(): Promise<void> {
  // ⚠️ **必须小写化**：登录路径（auth.service.ts 的 login）会把输入的邮箱
  // `toLowerCase()` 后**精确匹配**查询。而唯一索引是 `UNIQUE (lower(email))`，
  // 存大写也能通过唯一约束——于是库里就可能出现一条 `ADMIN@PLATFORM.TEST`，
  // 登录时按小写查不到，用户永远登不进去。
  //
  // 写之前统一小写化，存进去的形态就与登录时的查询形态一致。
  const email = (
    process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test'
  ).toLowerCase();
  const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';

  const existing = await prisma.user.findFirst({
    // 查重也大小写不敏感：与 lower(email) 唯一索引的语义对齐，
    // 否则库里已有大写形态时会走插入分支，然后被唯一索引拦下抛 P2002。
    where: {
      email: { equals: email, mode: 'insensitive' },
      role: UserRole.PLATFORM_ADMIN,
    },
  });

  if (existing) {
    console.log(`平台超管已存在，跳过：${email}`);
    return;
  }

  try {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        displayName: '平台超管',
        role: UserRole.PLATFORM_ADMIN,
        tenantId: null,
      },
    });
  } catch (error) {
    // 平台超管邮箱由部分唯一索引 users_platform_admin_email_key 兜底，
    // 并发执行 seed 时后到的一方会撞唯一约束，此时同样视为幂等成功。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      console.log(`平台超管已存在（并发创建），跳过：${email}`);
      return;
    }
    throw error;
  }

  console.log(`已创建平台超管：${email} / ${password}`);
}

/**
 * 阶段 2a 的示例店铺：一个租户 + 一个店主 + 三层品类树 + 若干带规格矩阵的商品。
 *
 * ⚠️ **幂等是硬要求**，不是风格问题：`npm test` 与 e2e 的 globalSetup 都会跑
 * `migrate deploy` 之后重新执行 seed，重复执行会撞部分唯一索引而整体失败。
 * 因此这里的每一层都先按业务键（slug / sku code）查重，命中就整棵子树跳过。
 *
 * 用的是**裸 PrismaClient**（不是 TenantPrismaService），所以租户扩展不会生效，
 * 每一次写入都必须显式带上 tenantId——这也是为什么下面到处都能看到 tenantId。
 */
async function seedDemoStore(): Promise<void> {
  // ⚠️ **必须小写化**：登录路径（auth.service.ts 的 login）会把输入的邮箱
  // `toLowerCase()` 后**精确匹配**查询，存大写就登不进去。详见
  // seedPlatformAdmin 处的说明。
  const merchantEmail = (
    process.env.SEED_DEMO_MERCHANT_EMAIL ?? 'owner@demo.platform.test'
  ).toLowerCase();
  const merchantPassword = process.env.SEED_DEMO_MERCHANT_PASSWORD ?? 'Demo12345!';

  const existingTenant = await prisma.tenant.findUnique({
    where: { subdomain: DEMO_SUBDOMAIN },
  });

  if (existingTenant) {
    console.log(`示例店铺已存在（子域名 ${DEMO_SUBDOMAIN}），跳过商品中心种子`);
    return;
  }

  // ---- 租户与店铺 ----
  const tenant = await prisma.tenant.create({
    data: {
      name: '示例店铺',
      subdomain: DEMO_SUBDOMAIN,
      status: 'TRIAL',
    },
  });
  const tenantId = tenant.id;

  await prisma.store.create({
    data: { tenantId, name: '示例店铺', slug: 'default' },
  });

  await prisma.user.create({
    data: {
      email: merchantEmail,
      passwordHash: await argon2.hash(merchantPassword),
      displayName: '示例店主',
      role: UserRole.MERCHANT_OWNER,
      tenantId,
    },
  });
  const ownerId = (
    await prisma.user.findFirstOrThrow({ where: { email: merchantEmail } })
  ).id;

  // ---- 三层品类树 ----
  // sort 按写入顺序递增：公开接口的品类树按 sort 升序返回，排序即展示顺序。
  const category = async (name: string, slug: string, sort: number, parentId: string | null) =>
    prisma.category.create({
      data: { tenantId, name, slug, sort, parentId },
    });

  const apparel = await category('服饰', 'apparel', 0, null);
  const tshirt = await category('T恤', 'tshirt', 0, apparel.id);
  await category('纯棉T恤', 'cotton-tshirt', 0, tshirt.id);
  const shoes = await category('鞋靴', 'shoes', 1, apparel.id);
  const digital = await category('手机数码', 'digital', 2, null);
  // 软删演示用的空品类——刻意挂在**没有商品**的分支上。
  const clearance = await category('清仓专区', 'clearance', 3, apparel.id);

  // ---- 商品 ----
  const product = async (data: {
    name: string;
    slug: string;
    subtitle?: string;
    description?: string;
    categoryId: string;
    status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
    publishedAt?: Date;
    minPrice?: number;
  }) =>
    prisma.product.create({
      data: {
        tenantId,
        categoryId: data.categoryId,
        name: data.name,
        slug: data.slug,
        subtitle: data.subtitle,
        description: data.description,
        status: data.status,
        // ⚠️ publishedAt 必须显式给：seed 走的是裸 PrismaClient，
        // 绕过了 ProductsService.update 里那段「首次转 PUBLISHED 才写时间」的逻辑。
        // 不给的话公开列表按 publishedAt 降序时，它会排在所有真实商品之后。
        publishedAt: data.publishedAt ?? null,
        minPrice: data.minPrice ?? 0,
      },
    });

  /**
   * 建一个带规格矩阵的商品。
   *
   * 笛卡尔积由这里的 for 循环手工展开——不复用 SpecMatrixService：
   * 那个服务依赖租户上下文与事务，seed 里没有请求上下文。
   * 维度顺序（spec.sort）与 SKU 的规格值组合严格对应，和线上一致。
   */
  const productWithSpecs = async (opts: {
    name: string;
    slug: string;
    subtitle?: string;
    description?: string;
    categoryId: string;
    status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
    publishedAt?: Date;
    dims: Array<{ name: string; values: string[] }>;
    /** 与 dims 的笛卡尔积一一对应，顺序一致；按组合逐项落 SKU */
    skus: Array<{
      price: number;
      comparePrice?: number;
      stock: number;
      status?: 'ACTIVE' | 'INACTIVE';
      values: string[];
    }>;
  }) => {
    const p = await product({ ...opts, minPrice: Math.min(...opts.skus.map((s) => s.price)) });

    const valueIdByText = new Map<string, string>();
    for (const [dimIndex, dim] of opts.dims.entries()) {
      const spec = await prisma.productSpec.create({
        data: { tenantId, productId: p.id, name: dim.name, sort: dimIndex },
      });
      for (const [valueIndex, value] of dim.values.entries()) {
        const created = await prisma.productSpecValue.create({
          data: { tenantId, specId: spec.id, value, sort: valueIndex },
        });
        valueIdByText.set(`${dim.name}:${value}`, created.id);
      }
    }

    // 价格已经是「分」，初始库存用 INITIAL 流水留痕而不是直接写 stock，
    // 这样流水表与库存台账从一开始就对得上（与库存调整接口的语义一致）。
    for (const [index, skuInput] of opts.skus.entries()) {
      const sku = await prisma.sku.create({
        data: {
          tenantId,
          productId: p.id,
          code: `${opts.slug.toUpperCase()}-${String(index + 1).padStart(2, '0')}`,
          price: skuInput.price,
          comparePrice: skuInput.comparePrice,
          stock: skuInput.stock,
          status: skuInput.status ?? 'ACTIVE',
        },
      });
      for (const value of skuInput.values) {
        // 取值文本可能跨维度重名（「黑色」既是颜色也可能是款式），
        // 所以按「维度名:取值」定位，而不是只看取值文本。
        const specName =
          opts.dims.find((d) => d.values.includes(value))?.name ?? '';
        const valueId = valueIdByText.get(`${specName}:${value}`);
        if (!valueId) {
          throw new Error(`种子数据内部错误：SKU ${index + 1} 的取值「${value}」未找到`);
        }
        await prisma.skuSpecValue.create({
          data: { tenantId, skuId: sku.id, valueId },
        });
      }
      if (skuInput.stock > 0) {
        await prisma.inventoryMovement.create({
          data: {
            tenantId,
            skuId: sku.id,
            type: 'INITIAL',
            quantity: skuInput.stock,
            stockBefore: 0,
            stockAfter: skuInput.stock,
            reason: '初始建仓',
            operatorId: ownerId,
          },
        });
      }
    }

    return p;
  };

  // 商品 1：双规格矩阵（颜色 × 尺码），4 个 SKU 全部有货，价格各不相同
  await productWithSpecs({
    name: '重磅纯棉T恤',
    slug: 'cotton-tee',
    subtitle: '260g 双纱精梳棉，越洗越软',
    description: '克重 260g 的双纱精梳棉面料，落肩版型，男女同款。',
    categoryId: tshirt.id,
    status: 'PUBLISHED',
    publishedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    dims: [
      { name: '颜色', values: ['黑色', '白色'] },
      { name: '尺码', values: ['M', 'L'] },
    ],
    skus: [
      { price: 12900, comparePrice: 19900, stock: 50, values: ['黑色', 'M'] },
      { price: 12900, stock: 32, values: ['黑色', 'L'] },
      { price: 12900, stock: 0, values: ['白色', 'M'] },
      { price: 13900, stock: 18, values: ['白色', 'L'] },
    ],
  });

  // 商品 2：单规格（颜色），其中「限量红」处于 INACTIVE 且库存为 0
  await productWithSpecs({
    name: '城市漫步运动鞋',
    slug: 'city-sneaker',
    subtitle: '缓震中底，通勤也能穿',
    categoryId: shoes.id,
    status: 'PUBLISHED',
    publishedAt: new Date(Date.now() - 24 * 3600 * 1000),
    dims: [{ name: '颜色', values: ['米白', '雾霾蓝', '限量红'] }],
    skus: [
      { price: 45900, stock: 12, values: ['米白'] },
      { price: 45900, stock: 5, values: ['雾霾蓝'] },
      { price: 49900, stock: 0, status: 'INACTIVE', values: ['限量红'] },
    ],
  });

  // 商品 3：无规格单品，最低价与排序用例都靠它
  const powerBank = await product({
    name: '65W 氮化镓充电器',
    slug: 'gan-charger-65w',
    subtitle: '双 C 口，可折叠插脚',
    description: '支持 PD3.0 / PPS，实测 65W 满载。',
    categoryId: digital.id,
    status: 'PUBLISHED',
    publishedAt: new Date(Date.now() - 2 * 3600 * 1000),
    minPrice: 9900,
  });
  const chargerSku = await prisma.sku.create({
    data: {
      tenantId,
      productId: powerBank.id,
      code: 'GAN65-BLK',
      price: 9900,
      comparePrice: 13900,
      stock: 80,
    },
  });
  await prisma.inventoryMovement.create({
    data: {
      tenantId,
      skuId: chargerSku.id,
      type: 'INITIAL',
      quantity: 80,
      stockBefore: 0,
      stockAfter: 80,
      reason: '初始建仓',
      operatorId: ownerId,
    },
  });

  // 商品 4：草稿——用来验证「公开接口看不到草稿」
  await productWithSpecs({
    name: '限量联名款（待上架）',
    slug: 'collab-tee',
    subtitle: '还没上架，公开接口应该查不到',
    categoryId: tshirt.id,
    status: 'DRAFT',
    dims: [{ name: '尺码', values: ['S', 'M'] }],
    skus: [
      { price: 19900, stock: 10, values: ['S'] },
      { price: 19900, stock: 10, values: ['M'] },
    ],
  });

  // ---- 软删除示例 ----
  //
  // ⚠️ 软删演示用的品类必须挂在**没有商品**的分支上。曾经这里软删的是「鞋靴」，
  // 而「城市漫步运动鞋」挂在它下面——于是那个活跃商品在前台的品类页里不可达，
  // 商家后台的品类列也显示「—」。
  //
  // 这个状态在正常业务里出不来：`CategoriesService.remove()` 会拒绝删除
  // 有商品的品类。种子数据直接写 deletedAt 绕过了那个检查，才造出了这个
  // 「活跃商品挂在已删品类下」的脏状态。
  // 留着这两条是为了让本地开发能亲眼验证软删除过滤确实生效：
  // 前台列表与搜索都查不到它们，但库里确实有记录。
  const staleProduct = await product({
    name: '已下架的季节限定品',
    slug: 'seasonal-limited',
    subtitle: '已软删除，不应出现在任何列表里',
    categoryId: tshirt.id,
    status: 'PUBLISHED',
    publishedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    minPrice: 29900,
  });
  await prisma.product.update({
    where: { id: staleProduct.id },
    data: { deletedAt: new Date() },
  });

  await prisma.category.update({
    where: { id: clearance.id },
    data: { deletedAt: new Date() },
  });

  console.log(
    `已创建示例店铺：${DEMO_SUBDOMAIN}.platform.test，` +
      `店主 ${merchantEmail} / ${merchantPassword}`,
  );
  console.log('  3 层品类树（服饰 / T恤 / 纯棉T恤、鞋靴、清仓专区[已软删]、手机数码）');
  console.log('  4 个商品（3 个已上架含规格矩阵、1 个草稿、1 个软删除示例）');
}

/**
 * 示例消费者账号（阶段 3 起）。
 *
 * 独立于 seedDemoStore：那个函数在店铺已存在时会整棵跳过，
 * 把消费者塞进去就永远建不出来。
 */
async function seedDemoCustomer(): Promise<void> {
  // ⚠️ **必须小写化**：登录路径（auth.service.ts 的 login）会把输入的邮箱
  // `toLowerCase()` 后**精确匹配**查询。而唯一索引是 `UNIQUE (lower(email))`，
  // 存大写也能通过唯一约束——于是库里就可能出现一条
  // `CUSTOMER@DEMO.PLATFORM.TEST`，登录时按小写查不到，用户永远登不进去。
  //
  // 写之前统一小写化，存进去的形态就与登录时的查询形态一致。
  const email = (
    process.env.SEED_DEMO_CUSTOMER_EMAIL ?? 'customer@demo.platform.test'
  ).toLowerCase();
  const password = process.env.SEED_DEMO_CUSTOMER_PASSWORD ?? 'Demo12345!';

  const existing = await prisma.user.findFirst({
    // ⚠️ 必须大小写不敏感：数据库的唯一索引是
    // users_customer_email_ci_key —— UNIQUE (lower(email), "tenantId")
    // WHERE role IN (CUSTOMER, MERCHANT_STAFF)。若这里用大小写敏感的精确匹配，
    // 库里已有 customer@demo.platform.test 时，查 CUSTOMER@DEMO.PLATFORM.TEST
    // 会查不到而走插入分支，然后被 lower(email) 索引拦下抛 P2002。
    where: { email: { equals: email, mode: 'insensitive' }, role: UserRole.CUSTOMER },
  });
  if (existing) {
    console.log(`示例消费者已存在，跳过：${email}`);
    return;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { subdomain: DEMO_SUBDOMAIN },
  });
  if (!tenant) {
    console.log('示例店铺不存在，跳过消费者账号');
    return;
  }

  try {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        displayName: '示例消费者',
        role: UserRole.CUSTOMER,
        tenantId: tenant.id,
      },
    });
  } catch (error) {
    // 邮箱由部分唯一索引 users_customer_email_ci_key 兜底，
    // 并发执行 seed 时后到的一方会撞唯一约束，此时同样视为幂等成功。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      console.log(`示例消费者已存在（并发创建），跳过：${email}`);
      return;
    }
    throw error;
  }

  console.log(`已创建示例消费者：${email} / ${password}`);
}

async function main() {
  await seedPlatformAdmin();
  await seedDemoStore();
  // 消费者账号依赖租户已建出来，所以放在 seedDemoStore 之后
  await seedDemoCustomer();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });