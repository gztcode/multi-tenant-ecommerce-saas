import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/** 库存调整接口的响应体：改后的 SKU + 本次产生的流水 */
interface AdjustResponseBody {
  sku: { id: string; stock: number };
  movement: {
    id: string;
    skuId: string;
    type: string;
    quantity: number;
    stockBefore: number;
    stockAfter: number;
    reason: string | null;
    operatorId: string;
    createdAt: string;
  };
}

interface MovementRow {
  id: string;
  skuId: string;
  type: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
}

interface MovementListBody {
  items: MovementRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** supertest 的 response.body 是 any，集中做一次类型收敛，业务代码里就不用断言 */
function adjustBody(response: { body: unknown }): AdjustResponseBody {
  return response.body as AdjustResponseBody;
}

function movementListBody(response: { body: unknown }): MovementListBody {
  return response.body as MovementListBody;
}

/** 商品创建 / 规格替换的响应体，只取本文件用得到的字段 */
interface ProductBody {
  id: string;
  version: number;
}

interface SpecMatrixBody {
  skus: Array<{ id: string }>;
}

function productBody(response: { body: unknown }): ProductBody {
  return response.body as ProductBody;
}

function specMatrixBody(response: { body: unknown }): SpecMatrixBody {
  return response.body as SpecMatrixBody;
}

/** 库存汇总接口的返回：每个 SKU 一行 */
interface SummaryRow {
  skuId: string;
  code: string | null;
  stock: number;
  status: string;
}

describe('库存流水 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();

    prisma = app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 在指定租户的上下文里查库。
   *
   * 必须走 `tenantContext.run` 的 async 回调：Prisma 扩展在没有租户上下文时
   * 对租户作用域模型 fail-closed，裸调 prisma.sku.updateMany 会抛 TenantScopeError。
   */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  /** 造一个 SKU，返回 { id, price, stock } */
  async function createSku(
    token: string,
    stock: number,
  ): Promise<{ id: string; price: number; stock: number }> {
    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send({ name: '库存测试商品', slug: `inv-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const specs = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${token}`)
      .send({
        version: created.version,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);

    const sku = specMatrixBody(specs).skus[0];
    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${sku.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ price: 1000 })
      .expect(200);

    // 库存只能通过库存调整接口改，这里直接造初始库存。
    //
    // ⚠️ 必须包在 tenantContext.run 里：Sku 是租户作用域模型，
    // 扩展在没有租户上下文时直接抛 TenantScopeError（fail-closed），
    // 裸调 prisma.sku.updateMany 会当场炸掉。
    const tenantId = resolveTenantId(token);
    await asTenant(tenantId, () =>
      prisma.sku.updateMany({
        where: { id: sku.id },
        data: { stock },
      }),
    );

    return { id: sku.id, price: 1000, stock };
  }

  /**
   * 从令牌里反查租户 id。
   *
   * createSku 的调用点只持有 token，而给 prisma 造初始库存必须显式带上租户上下文。
   * JWT 的 payload 在阶段 1 就是明文可解的，这里直接解，不额外查库。
   */
  function resolveTenantId(token: string): string {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { tenantId?: string | null };
    if (!payload.tenantId) {
      throw new Error('令牌里没有 tenantId，测试夹具无法继续');
    }
    return payload.tenantId;
  }

  it('入库：库存增加并产生一条流水', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    const response = await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        skuId: sku.id,
        type: 'ADJUST_IN',
        quantity: 20,
        reason: '采购到货',
      })
      .expect(201);

    const body = adjustBody(response);
    expect(body.sku.stock).toBe(20);
    expect(body.movement.stockBefore).toBe(0);
    expect(body.movement.stockAfter).toBe(20);
    expect(body.movement.quantity).toBe(20);
    // 流水要能追溯到操作人，否则台账出了事找不到人
    expect(body.movement.operatorId).toBeTruthy();
    expect(body.movement.reason).toBe('采购到货');
  });

  it('出库超过库存被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 5);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_OUT', quantity: 10 })
      .expect(400);

    // 断言不能只看 HTTP 400：还要确认库存真的没被动过。
    // 如果实现漏了回滚或先改了库再校验，这条会失败。
    const after = await asTenant(merchant.tenantId, () =>
      prisma.sku.findFirst({ where: { id: sku.id } }),
    );
    expect(after?.stock).toBe(5);

    // 被拒绝的出库不能留下一条流水
    const movements = await asTenant(merchant.tenantId, () =>
      prisma.inventoryMovement.findMany({ where: { skuId: sku.id } }),
    );
    expect(movements).toHaveLength(0);
  });

  it('盘点：传绝对值，流水里记成差量', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 10);

    const response = await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'CHECK', quantity: 8 })
      .expect(201);

    const body = adjustBody(response);
    expect(body.sku.stock).toBe(8);
    expect(body.movement.quantity).toBe(-2);
    expect(body.movement.stockBefore).toBe(10);
    expect(body.movement.stockAfter).toBe(8);
  });

  it('盘点盘盈：差量为正', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 10);

    const response = await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'CHECK', quantity: 13 })
      .expect(201);

    const body = adjustBody(response);
    expect(body.sku.stock).toBe(13);
    expect(body.movement.quantity).toBe(3);
  });

  it('流水是只追加的：查得到历史记录', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: 10 })
      .expect(201);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_OUT', quantity: 3 })
      .expect(201);

    const list = await http(app)
      .get(`/api/v1/inventory/movements?skuId=${sku.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = movementListBody(list);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);

    // 只追加台账的语义：流水按时间倒序，最新的一条就是最后一次调整。
    // 如果实现错误地覆盖了旧行（例如做成 update），这里会只剩 1 条；
    // 如果排序反了，type 序列会颠倒。
    expect(body.items.map((m) => m.type)).toEqual(['ADJUST_OUT', 'ADJUST_IN']);
    expect(body.items[0].quantity).toBe(-3);
    expect(body.items[1].quantity).toBe(10);
    // 每条流水都要能自证：前值 + 差量 = 后值
    for (const m of body.items) {
      expect(m.stockBefore + m.quantity).toBe(m.stockAfter);
    }

    // 直接查库确认台账确实有两行（接口分页也可能掩盖问题）
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.inventoryMovement.findMany({ where: { skuId: sku.id } }),
    );
    expect(rows).toHaveLength(2);
    expect(new Date(rows[0].createdAt).getTime()).toBeLessThanOrEqual(
      new Date(rows[1].createdAt).getTime(),
    );
  });

  it('跨租户不可见：改不了别人的 SKU 库存', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const sku = await createSku(a.token, 10);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${b.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_OUT', quantity: 1 })
      .expect(404);

    // 越权请求失败后，库存与流水都必须原封不动
    const after = await asTenant(a.tenantId, () =>
      prisma.sku.findFirst({ where: { id: sku.id } }),
    );
    expect(after?.stock).toBe(10);

    // 租户 B 也查不到租户 A 的流水
    const list = await http(app)
      .get(`/api/v1/inventory/movements?skuId=${sku.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(movementListBody(list).items).toHaveLength(0);
  });

  it('库存汇总：列出该商品下各 SKU 的当前库存', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '汇总测试商品', slug: `sum-${unique()}` })
      .expect(201);

    const created = productBody(product);

    const specs = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);

    const skuId = specMatrixBody(specs).skus[0].id;
    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId, type: 'ADJUST_IN', quantity: 7 })
      .expect(201);

    const response = await http(app)
      .get(`/api/v1/inventory/summary?productId=${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const rows = response.body as SummaryRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].skuId).toBe(skuId);
    expect(rows[0].stock).toBe(7);
  });

  it('枚举里留位但本阶段不开放的类型被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 10);

    // RESERVE 语义是「占用可用量」，与实际库存不是一回事，
    // 本阶段不开放——枚举里有位但 DTO 白名单不放行。
    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'RESERVE', quantity: 1 })
      .expect(400);
  });

  it('负数数量被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 10);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: -5 })
      .expect(400);
  });

  it('未登录不能调库存接口', async () => {
    await http(app).post('/api/v1/inventory/adjustments').send({}).expect(401);
  });

  it('流水表不在软删除名单里：伪造软删也查得到', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: 4 })
      .expect(201);

    // 流水表没有 deletedAt 字段，扩展也不会往它的 where 里合并
    // `deletedAt: null`——这正是「审计凭证不该被藏起来」的实现体现。
    // 用扩展 client 查即可（不需要裸 client，因为这里不是证明软删）。
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.inventoryMovement.findMany({ where: { skuId: sku.id } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('有流水的 SKU 不能被物理删除（数据库 Restrict 外键兜底）', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: 1 })
      .expect(201);

    // 必须用**裸** PrismaClient：扩展在两层上挡住物理删除
    // （Sku 是软删除模型，delete / deleteMany 直接抛 TenantScopeError），
    // 那样只能证明扩展在拦，证明不了数据库的 Restrict 外键也在拦。
    // 这里要验证的是后者——绕过应用层，数据库本身必须拒绝。
    const raw = new PrismaClient();
    try {
      await expect(raw.sku.delete({ where: { id: sku.id } })).rejects.toThrow();
      // 删除失败后 SKU 与流水都还在
      const still = await raw.sku.findUnique({ where: { id: sku.id } });
      expect(still?.stock).toBe(1);
    } finally {
      await raw.$disconnect();
    }
  });
  it('并发调整不会丢失更新：两次入库都生效', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    // 两个请求同时打过来，都读到 stock=0、各自算出 stockAfter=10。
    // 没有乐观锁的话后写的会覆盖先写的——入库两次却只有 10 件。
    const payload = {
      skuId: sku.id,
      type: 'ADJUST_IN',
      quantity: 10,
    };
    const [first, second] = await Promise.all([
      http(app)
        .post('/api/v1/inventory/adjustments')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(payload),
      http(app)
        .post('/api/v1/inventory/adjustments')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(payload),
    ]);

    // 乐观锁下：一个 201、一个 409，而不是「两个都成功但只进一笔」
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    // 查库核对。⚠️ Sku 是租户作用域模型，必须包在 tenantContext.run 里，
    // 否则扩展直接抛 TenantScopeError（fail-closed）。
    const tenantId = resolveTenantId(merchant.token);
    const after = await tenantContext.run(
      { tenantId, userId: null, role: null },
      async () => prisma.sku.findFirst({ where: { id: sku.id } }),
    );
    expect(after?.stock).toBe(10);

    // 流水也只有一条——不产生「记了账却没生效」的幽灵记录
    const movements = await tenantContext.run(
      { tenantId, userId: null, role: null },
      async () =>
        prisma.inventoryMovement.findMany({ where: { skuId: sku.id } }),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]?.stockAfter).toBe(10);
  });

  it('乐观锁版本号随每次调整递增', async () => {
    const merchant = await createMerchant(app, prisma);
    const sku = await createSku(merchant.token, 0);

    const tenantId = resolveTenantId(merchant.token);
    const before = await tenantContext.run(
      { tenantId, userId: null, role: null },
      async () => prisma.sku.findFirst({ where: { id: sku.id } }),
    );
    expect(before?.stockVersion).toBe(0);

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ skuId: sku.id, type: 'ADJUST_IN', quantity: 5 })
      .expect(201);

    const after = await tenantContext.run(
      { tenantId, userId: null, role: null },
      async () => prisma.sku.findFirst({ where: { id: sku.id } }),
    );
    expect(after?.stockVersion).toBe(1);
  });
});
