import { TenantPrismaService } from './tenant-prisma.service';
import { TenantScopeError } from './tenant-scope.error';
import { SOFT_DELETE_MODELS, TENANT_SCOPED_MODELS } from './tenant-models';
import {
  TenantContextValue,
  platformScope,
  tenantContext,
} from './tenant-context';
// 任务描述要求保留 platformScope 导入，即便当前用例没有用到，也保持导入以
// 与该模块其他入口对齐（这里用 void 操作符消费它，避免 unused-vars 报警）。
void platformScope;
import { Prisma, PrismaClient, UserRole } from '@prisma/client';

describe('租户隔离版 PrismaClient', () => {
  let prisma: TenantPrismaService;

  const tenantA: TenantContextValue = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    role: UserRole.MERCHANT_OWNER,
  };

  const platformContext: TenantContextValue = {
    tenantId: null,
    userId: 'admin',
    role: UserRole.PLATFORM_ADMIN,
  };

  beforeEach(() => {
    prisma = new TenantPrismaService();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it('租户作用域模型上调用 findUnique 会被拒绝', async () => {
    await expect(
      prisma.user.findUnique({ where: { id: 'whatever' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域模型上调用 update 会被拒绝', async () => {
    await expect(
      prisma.store.update({ where: { id: 'whatever' }, data: { name: 'x' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域模型上调用 delete 会被拒绝', async () => {
    await expect(
      prisma.store.delete({ where: { id: 'whatever' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域模型上调用 upsert 会被拒绝', async () => {
    // upsert 的 where 必须是唯一键：按 id 来无法附加 tenantId，按
    // tenantId_slug 来嵌入的 tenantId 可被伪造——都必须拒绝
    await expect(
      prisma.store.upsert({
        where: { id: 'whatever' },
        create: { name: 'x', slug: 'x' },
        update: { name: 'x' },
      } as unknown as Prisma.StoreUpsertArgs),
    ).rejects.toBeInstanceOf(TenantScopeError);

    await expect(
      prisma.store.upsert({
        where: { tenantId_slug: { tenantId: 'whatever', slug: 'whatever' } },
        create: { name: 'x', slug: 'x' },
        update: { name: 'x' },
      } as unknown as Prisma.StoreUpsertArgs),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('没有租户上下文时读取租户作用域模型会被拒绝', async () => {
    await expect(prisma.store.findMany()).rejects.toBeInstanceOf(
      TenantScopeError,
    );
  });

  it('平台作用域下读取租户作用域模型不加过滤', async () => {
    // 这里的 callback 必须是 async 函数：Prisma 6 的 query 调用基于
    // PrismaPromise（thenable），AsyncLocalStorage 无法跨过 thenable 链。
    // 用 async 包裹让 run() 返回真正的 Promise，ALS 才会沿 then 链传播。
    const result = await tenantContext.run(platformContext, async () =>
      prisma.store.findMany(),
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it('非租户作用域模型不受隔离约束', async () => {
    // Tenant 不在白名单内，没有租户上下文也能查询
    await expect(
      prisma.tenant.findUnique({ where: { subdomain: 'not-exists-at-all' } }),
    ).resolves.toBeNull();
  });

  it('租户作用域内读取会自动附加 tenantId 条件', async () => {
    // 先造一个「别的租户」的店铺：只有真的加了 tenantId 过滤，
    // 租户 A 的上下文才查不到它。库里为空时这条断言是恒真的。
    const otherTenant = await prisma.tenant.create({
      data: { name: '别的租户', subdomain: `probe-other-${Date.now()}` },
    });

    await tenantContext.run(
      { tenantId: otherTenant.id, userId: null, role: UserRole.MERCHANT_OWNER },
      async () =>
        prisma.store.create({
          data: {
            name: '别的租户的店铺',
            slug: 'other-store',
          } as unknown as Prisma.StoreCreateInput,
        }),
    );

    const result = await tenantContext.run(tenantA, async () =>
      prisma.store.findMany(),
    );

    // 租户 A 的上下文绝不能看到别的租户的店铺
    expect(result).toEqual([]);

    // 清理：删除租户会级联删掉它的店铺
    await prisma.tenant.deleteMany({ where: { id: otherTenant.id } });
  });

  it('平台作用域下的写入必须显式指定 tenantId', async () => {
    await expect(
      tenantContext.run(platformContext, async () =>
        prisma.store.create({
          // 通过 unknown 转型：让扩展在运行时注入 tenantId，
          // 静态类型仍接受调用方漏掉必填字段的写法。
          data: { name: 'x', slug: 'x' } as unknown as Prisma.StoreCreateInput,
        }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('租户作用域内写入会自动注入 tenantId', async () => {
    // Store.tenantId 有指向 tenants 的外键，必须先建一个真实租户
    const tenant = await prisma.tenant.create({
      data: { name: '隔离测试租户', subdomain: `probe-tenant-${Date.now()}` },
    });

    const created = await tenantContext.run(
      { ...tenantA, tenantId: tenant.id },
      async () =>
        prisma.store.create({
          // 同上：通过 unknown 转型跳过必填字段校验，验证扩展会自动注入 tenantId。
          data: {
            name: '隔离测试店铺',
            slug: 'probe-store',
          } as unknown as Prisma.StoreCreateInput,
        }),
    );

    expect(created.tenantId).toBe(tenant.id);

    // 清理：删除租户会级联删掉它的店铺
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('租户作用域内 createManyAndReturn 会自动注入 tenantId', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        name: 'createManyAndReturn 测试租户',
        subdomain: `cmrt-${Date.now()}`,
      },
    });

    const created = await tenantContext.run(
      { ...tenantA, tenantId: tenant.id },
      async () =>
        prisma.store.createManyAndReturn({
          data: [
            { name: '批量 A', slug: 'cmrt-a' },
            { name: '批量 B', slug: 'cmrt-b' },
          ] as unknown as Prisma.StoreCreateManyInput[],
        }),
    );

    expect(created).toHaveLength(2);
    for (const row of created) {
      expect(row.tenantId).toBe(tenant.id);
    }

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('租户作用域内 updateManyAndReturn 合并 where.tenantId，不会越权改到别的租户', async () => {
    const tenantAInstance = await prisma.tenant.create({
      data: { name: 'UMR 租户 A', subdomain: `umr-a-${Date.now()}` },
    });
    const tenantBInstance = await prisma.tenant.create({
      data: { name: 'UMR 租户 B', subdomain: `umr-b-${Date.now()}` },
    });

    // 在租户 B 的上下文里给 B 建一个店铺
    const storeB = await tenantContext.run(
      {
        tenantId: tenantBInstance.id,
        userId: null,
        role: UserRole.MERCHANT_OWNER,
      },
      async () =>
        prisma.store.create({
          data: {
            name: 'B 原名',
            slug: 'b-store',
          } as unknown as Prisma.StoreCreateInput,
        }),
    );

    // 切到租户 A，尝试用 `where: { id: storeB.id }` 改 B 的店铺
    const result = await tenantContext.run(
      { ...tenantA, tenantId: tenantAInstance.id },
      async () =>
        prisma.store.updateManyAndReturn({
          where: {
            id: storeB.id,
            tenantId: tenantBInstance.id,
          },
          data: { name: 'PWNED' },
        }),
    );

    // 合并 where.tenantId 后条件变成 `{ id: storeB.id, tenantId: A }`，应该一条都改不到
    expect(result).toEqual([]);

    // 核对 B 的店铺确实没被改——必须包在 tenantContext 里，因为没上下文下 store 是不可访问的
    const checkB = await tenantContext.run(
      {
        tenantId: tenantBInstance.id,
        userId: null,
        role: UserRole.MERCHANT_OWNER,
      },
      async () =>
        prisma.store.findFirst({
          where: { id: storeB.id },
        }),
    );
    expect(checkB?.name).toBe('B 原名');

    // 但如果用 `where: { id: storeB.id, tenantId: B.id }`（带对了 tenantId）期望正常工作
    const okResult = await tenantContext.run(
      { ...tenantA, tenantId: tenantBInstance.id },
      async () =>
        prisma.store.updateManyAndReturn({
          where: { id: storeB.id },
          data: { name: '合法改名' },
        }),
    );
    expect(okResult).toHaveLength(1);
    expect(okResult[0]?.name).toBe('合法改名');

    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantAInstance.id, tenantBInstance.id] } },
    });
  });

  it('主题 token 里的 push / set 不被误拦', async () => {
    // 实测场景：商家自定义主题配置，`themeTokens` 是 Json 字段，里面的 key 是用户数据
    const tenant = await prisma.tenant.create({
      data: { name: '主题 token 测试租户', subdomain: `tt-${Date.now()}` },
    });

    const created = await tenantContext.run(
      { ...tenantA, tenantId: tenant.id },
      async () =>
        prisma.store.create({
          data: {
            name: '主题测试店',
            slug: 'tt-store',
            themeTokens: {
              push: '#000',
              colors: { primary: '#1677ff' },
            },
            paymentConfig: {
              set: { provider: 'stripe' },
            },
          } as unknown as Prisma.StoreCreateInput,
        }),
    );

    expect(created.tenantId).toBe(tenant.id);

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('关系字段的嵌套写仍被拒绝', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: '嵌套写测试租户', subdomain: `nw-${Date.now()}` },
    });

    // 真实数据库外键在 Store.tenantId 上，存在会因外键冲突失败，
    // 因此只断言扩展层抛 TenantScopeError 即可（不会真的写入）。
    // 通过 unknown 转型跳过外键必须存在的可选校验，专门验证扩展层运行时拦截。
    const nestedWriteArgs = {
      data: {
        name: '嵌套写店',
        slug: 'nw-store',
        tenant: { connect: { id: tenant.id } },
      },
    } as unknown as Prisma.StoreCreateArgs;

    await expect(
      tenantContext.run({ ...tenantA, tenantId: tenant.id }, async () =>
        prisma.store.create(nestedWriteArgs),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('updateMany 的 data 带关系嵌套写也会被拒绝', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        name: 'updateMany 嵌套写测试租户',
        subdomain: `umn-${Date.now()}`,
      },
    });

    // updateMany 的 data 类型只允许标量字段，`tenant` 会让 TS 直接报错；
    // 通过 unknown 转型跳过静态校验，专门验证扩展层运行时拦截
    const evilArgs = {
      where: { slug: 'whatever' },
      data: {
        tenant: { connect: { id: tenant.id } },
      },
    } as Prisma.StoreUpdateManyArgs;

    await expect(
      tenantContext.run({ ...tenantA, tenantId: tenant.id }, async () =>
        prisma.store.updateMany(evilArgs),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('软删除模型自动合并 deletedAt: null 条件', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: '软删除测试租户', subdomain: `sd-${Date.now()}` },
    });

    const context = { ...tenantA, tenantId: tenant.id };

    const product = await tenantContext.run(context, async () =>
      prisma.product.create({
        data: {
          name: '待软删的商品',
          slug: `sd-product-${Date.now()}`,
        } as unknown as Prisma.ProductCreateInput,
      }),
    );

    // 软删除：设 deletedAt，不做物理删除
    await tenantContext.run(context, async () =>
      prisma.product.updateMany({
        where: { id: product.id },
        data: { deletedAt: new Date() },
      }),
    );

    // 走扩展的查询：软删除的记录必须查不到
    const visible = await tenantContext.run(context, async () =>
      prisma.product.findMany(),
    );
    expect(visible.map((p) => p.id)).not.toContain(product.id);

    // 用裸 Prisma 核对：记录仍在库里（是软删除，不是物理删除）
    const raw = new PrismaClient();
    const stillThere = await raw.product.findUnique({
      where: { id: product.id },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deletedAt).not.toBeNull();
    await raw.$disconnect();

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('软删除模型禁止物理删除', async () => {
    // 放在租户上下文里跑：没有上下文时 resolveScope 会先抛 TenantScopeError，
    // 那样这条用例会因为「错误的原因」通过，验证不到新加的物理删除拦截。
    await expect(
      tenantContext.run(tenantA, async () =>
        prisma.product.deleteMany({ where: { id: 'whatever' } }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('关联读取不施加软删除过滤，但租户隔离仍然生效', async () => {
    // ⚠️ 这条用例记录的是**实测结论**，Task 4/5 的实现必须依赖它：
    //
    // Prisma 的 `include` 嵌套关联不是独立的 delegate 调用，而是拼进同一条查询的
    // 子查询，$allModels 扩展只作用于顶层调用。因此扩展合成的 where.deletedAt
    // **不会**传导到嵌套层——软删掉的关联记录照样会被读出来。
    // 租户隔离不受影响：顶层 where.tenantId 过滤掉了父记录，其关联自然无从出现，
    // 所以跨租户读取仍然拿不到别人的数据。
    //
    // 实践含义：**凡是软删除模型的关联读取，业务层必须显式写
    // `include: { skus: { where: { deletedAt: null } } }`**，
    // 不能指望扩展自动兜底。Task 4 的商品详情、Task 5 的规格矩阵都按此实现。
    //
    // ⚠️ 只有「一对多」关系能这么写：Prisma 的 `where` 只存在于 to-many 关系的
    // 嵌套参数上，to-one 关系（如 ProductMedia.media）的类型里根本没有 where 槽位，
    // 想过滤必须改成 select 子查询或单独查一次。
    const tenant = await prisma.tenant.create({
      data: { name: '关联读取测试租户', subdomain: `ar-${Date.now()}` },
    });

    const context = { ...tenantA, tenantId: tenant.id };

    const product = await tenantContext.run(context, async () =>
      prisma.product.create({
        data: {
          name: '带规格的商品',
          slug: `ar-product-${Date.now()}`,
        } as unknown as Prisma.ProductCreateInput,
      }),
    );

    // 用 Product.skus（一对多，带 deletedAt）作为探针——这正是 Task 4/5 会读的形状
    // skuId/productId 是必填外键，用 unknown 转型跳过静态校验，交给数据库外键兜底
    const sku = await tenantContext.run(context, async () =>
      prisma.sku.create({
        data: { productId: product.id, price: 1990, stock: 10 },
      } as unknown as Prisma.SkuCreateArgs),
    );

    // 软删这个 SKU
    await tenantContext.run(context, async () =>
      prisma.sku.updateMany({
        where: { id: sku.id },
        data: { deletedAt: new Date() },
      }),
    );

    // 顶层查询：软删除生效，SKU 查不到
    const topLevel = await tenantContext.run(context, async () =>
      prisma.sku.findMany(),
    );
    expect(topLevel).toHaveLength(0);

    // 关联读取：软删的 SKU **仍会**出现——这正是上面注释记录的已知限制
    const nested = await tenantContext.run(context, async () =>
      prisma.product.findMany({
        where: { id: product.id },
        include: { skus: true },
      }),
    );
    expect(nested[0]?.skus).toHaveLength(1);
    expect(nested[0]?.skus[0]?.deletedAt).not.toBeNull();

    // 业务层的正确写法：显式补 where
    const explicit = await tenantContext.run(context, async () =>
      prisma.product.findMany({
        where: { id: product.id },
        include: { skus: { where: { deletedAt: null } } },
      }),
    );
    expect(explicit[0]?.skus ?? []).toHaveLength(0);

    // 租户隔离对关联读取依然生效：别的租户连父记录都读不到
    const otherTenant = await prisma.tenant.create({
      data: { name: '关联读取对照租户', subdomain: `ar2-${Date.now()}` },
    });
    const seenByOther = await tenantContext.run(
      { ...tenantA, tenantId: otherTenant.id },
      async () =>
        prisma.product.findMany({
          include: { skus: true },
        }),
    );
    expect(seenByOther).toEqual([]);

    await prisma.tenant.deleteMany({
      where: { id: { in: [tenant.id, otherTenant.id] } },
    });
  });
  it('软删除模型禁止通过 updateMany 把 deletedAt 置 null 复活记录', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: '复活拦截测试租户', subdomain: `rv-${Date.now()}` },
    });
    const context = { ...tenantA, tenantId: tenant.id };

    const product = await tenantContext.run(context, async () =>
      prisma.product.create({
        // 断言套在 data 的**值**上而不是整个参数上：ProductCreateInput 要求
        // 带关系字段 tenant，而扩展在运行时注入 tenantId，静态类型看不到。
        data: {
          name: '待复活商品',
          slug: `rv-${Date.now()}`,
        } as unknown as Prisma.ProductCreateInput,
      }),
    );

    // 先软删
    await tenantContext.run(context, async () =>
      prisma.product.updateMany({
        where: { id: product.id },
        data: { deletedAt: new Date() },
      }),
    );

    // 再试着复活 —— 必须被拒。
    // 过滤方向是 fail-closed 的，但解除过滤原本是 fail-open 的：
    // 没有这道闸，一次普通的 updateMany 就能抹掉删除痕迹。
    await expect(
      tenantContext.run(context, async () =>
        prisma.product.updateMany({
          where: { id: product.id },
          data: { deletedAt: null },
        }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);

    // 用裸 client 核对：确实还是已软删状态，没被复活
    const raw = new PrismaClient();
    const still = await raw.product.findUnique({ where: { id: product.id } });
    expect(still?.deletedAt).not.toBeNull();
    await raw.$disconnect();

    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  });

  it('阶段 3 的新表全部登记在租户作用域白名单里', () => {
    // 漏登记的后果是「那张表的所有读写都不附加 tenantId 条件」——
    // 彻底失去隔离且没有任何报错。所以这条断言守着它。
    const expected = [
      'Cart',
      'CartItem',
      'Address',
      'Order',
      'OrderItem',
      'Payment',
    ];
    for (const model of expected) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  it('webhook 幂等表不登记进白名单：它是渠道事件的数据，租户从订单反查', () => {
    // 反向断言，锁住一个刻意的决定。
    expect(TENANT_SCOPED_MODELS.has('PaymentWebhookEvent')).toBe(false);
  });

  it('阶段 5a 的新表全部登记在租户作用域白名单里', () => {
    // 漏登记的后果是「那张表的所有读写都不附加 tenantId 条件」——
    // 彻底失去隔离且没有任何报错。所以这条断言守着它。
    const expected = ['Coupon', 'CouponClaim', 'CouponRedemption', 'Promotion'];
    for (const model of expected) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  it('billing 的三张租户作用域表都登记了，plans 刻意不登记', () => {
    // ⚠️ **plans 刻意不在名单里**：它不带 tenantId 字段，
    // 是「平台的数据」而不是「租户的数据」——先例是阶段 3 的 PaymentWebhookEvent。
    expect(TENANT_SCOPED_MODELS.has('Subscription')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('Invoice')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('PaymentMethod')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('Plan')).toBe(false);
  });

  it('券与活动走软删：软删后商家还能查历史核销记录', () => {
    // 券是营销配置，商家可能想「下架」但保留历史核销记录的可追溯性。
    expect(SOFT_DELETE_MODELS.has('Coupon')).toBe(true);
    expect(SOFT_DELETE_MODELS.has('Promotion')).toBe(true);
  });

  it('领取记录与核销记录不软删：它们是财务凭证', () => {
    // ⚠️ **反向断言**，锁住一个刻意的决定。
    // 核销记录软删掉的话，「这张券被用掉了」这件事就没了——
    // 对账时无法回答「用户手里的券为什么不见了」。
    expect(SOFT_DELETE_MODELS.has('CouponClaim')).toBe(false);
    expect(SOFT_DELETE_MODELS.has('CouponRedemption')).toBe(false);
  });
});
