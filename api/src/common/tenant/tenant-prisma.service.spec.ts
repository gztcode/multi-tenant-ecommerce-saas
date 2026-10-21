import { TenantPrismaService } from './tenant-prisma.service';
import { TenantScopeError } from './tenant-scope.error';
import {
  TenantContextValue,
  platformScope,
  tenantContext,
} from './tenant-context';
// 任务描述要求保留 platformScope 导入，即便当前用例没有用到，也保持导入以
// 与该模块其他入口对齐（这里用 void 操作符消费它，避免 unused-vars 报警）。
void platformScope;
import { Prisma, UserRole } from '@prisma/client';

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
});
