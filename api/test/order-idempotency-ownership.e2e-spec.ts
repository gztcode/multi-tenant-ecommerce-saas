import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 下单幂等键的消费者归属 (e2e)。
 *
 * 对应 2026-11-05 审计 P0-2：幂等键的查找与唯一索引都只按「租户 + 键」，
 * 不含 customerId —— 消费者 B 用消费者 A 的幂等键下单，会直接拿到
 * A 的整张订单（收货人、电话、省市区详址），B 自己的单根本没创建。
 * 主控已在隔离库实测复现。
 *
 * 修复 = 两条腿（缺一不可，见审计条目）：
 * 1. 唯一索引 `orders_tenant_idempotency_uniq` 改成
 *    `(tenantId, customerId, idempotencyKey)`（否则 where 加了归属后，
 *    并发重查分支查不到 → P2002 直接 500）；
 * 2. `findByIdempotencyKey` 的 where 加上 `customerId`。
 */

// ---- 响应体的类型收敛（与 order.e2e-spec.ts 同一写法）----

interface TokenBody {
  accessToken: string;
  user: { id: string; role: string; tenantId: string | null };
}

interface SpecMatrixBody {
  skus: Array<{ id: string }>;
}

interface OrderBody {
  id: string;
  orderNo: string;
  customerId: string | null;
  receiverName: string;
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function specMatrixBody(response: { body: unknown }): SpecMatrixBody {
  return response.body as SpecMatrixBody;
}

function orderBody(response: { body: unknown }): OrderBody {
  return response.body as OrderBody;
}

describe('下单幂等键的消费者归属 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
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

  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  async function registerCustomer(
    subdomain: string,
  ): Promise<{ token: string; userId: string }> {
    const response = await http(app)
      .post('/api/v1/auth/register/customer')
      .set('x-tenant-subdomain', subdomain)
      .send({
        email: `customer-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '测试顾客',
      })
      .expect(201);
    const body = tokenBody(response);
    return { token: body.accessToken, userId: body.user.id };
  }

  /** 造一条收货地址，收货人可指定（用来区分两个消费者的订单快照） */
  async function createAddress(
    token: string,
    receiver: string,
  ): Promise<string> {
    const created = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${token}`)
      .send({
        receiver,
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      })
      .expect(201);
    return (created.body as { id: string }).id;
  }

  /** 造一个已上架、已定价的商品，返回它的 SKU id */
  async function publishSku(
    token: string,
    name: string,
    price = 1000,
  ): Promise<string> {
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send({ name, slug: `p-${unique()}` })
      .expect(201);
    const productId = (created.body as { id: string }).id;

    const matrix = await http(app)
      .put(`/api/v1/catalog/products/${productId}/specs`)
      .set('authorization', `Bearer ${token}`)
      .send({
        version: 1,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);
    const skuId = specMatrixBody(matrix).skus[0].id;

    await http(app)
      .patch(`/api/v1/catalog/products/${productId}/skus/${skuId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ price })
      .expect(200);

    await http(app)
      .patch(`/api/v1/catalog/products/${productId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    return skuId;
  }

  async function stockIn(
    token: string,
    skuId: string,
    quantity: number,
  ): Promise<void> {
    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${token}`)
      .send({ skuId, type: 'ADJUST_IN', quantity })
      .expect(201);
  }

  /**
   * 下单。刻意不写成 async：写成 async 会把 supertest 的 Test 对象
   * 包进 Promise，`await placeOrder(...).expect(...)` 就变成
   * `await Promise.expect(...)` —— expect 不是函数。
   */
  function placeOrder(
    token: string,
    payload: {
      addressId: string;
      items: Array<{ skuId: string; quantity: number }>;
      idempotencyKey?: string;
    },
  ) {
    return http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${token}`)
      .send(payload);
  }

  it('消费者 B 用消费者 A 的幂等键下单：得到 B 自己的订单，而不是 A 的', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '归属测试商品', 1000);
    await stockIn(merchant.token, skuId, 10);

    const alice = await registerCustomer(merchant.subdomain);
    const bob = await registerCustomer(merchant.subdomain);
    const aliceAddress = await createAddress(alice.token, '张三');
    const bobAddress = await createAddress(bob.token, '李四');

    const idempotencyKey = unique();

    const aliceRes = await placeOrder(alice.token, {
      addressId: aliceAddress,
      items: [{ skuId, quantity: 1 }],
      idempotencyKey,
    }).expect(201);
    const aliceOrder = orderBody(aliceRes);

    const bobRes = await placeOrder(bob.token, {
      addressId: bobAddress,
      items: [{ skuId, quantity: 1 }],
      idempotencyKey,
    }).expect(201);
    const bobOrder = orderBody(bobRes);

    // B 必须拿到 B 自己的订单：收货人是 B 地址快照的李四，不是张三
    expect([bobOrder.orderNo, bobOrder.receiverName]).not.toEqual([
      aliceOrder.orderNo,
      aliceOrder.receiverName,
    ]);
    expect(bobOrder.receiverName).toBe('李四');
    expect(bobOrder.customerId).toBe(bob.userId);

    // 两个消费者各有一笔订单，库存各预占一次
    const orders = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { idempotencyKey } }),
    );
    expect(orders).toHaveLength(2);
    const customerIds = orders.map((o) => o.customerId).sort();
    expect(customerIds).toEqual([alice.userId, bob.userId].sort());
  });

  it('同消费者重放同一个幂等键仍返回同一笔订单（幂等语义不被破坏）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重放测试商品', 1000);
    await stockIn(merchant.token, skuId, 10);

    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token, '张三');
    const idempotencyKey = unique();

    const first = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
      idempotencyKey,
    }).expect(201);
    const second = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
      idempotencyKey,
    }).expect(201);

    expect(orderBody(second).orderNo).toBe(orderBody(first).orderNo);

    const orders = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { customerId: customer.userId } }),
    );
    expect(orders).toHaveLength(1);
  });

  it('并发提交同一个幂等键（同一消费者）：只建一笔订单，只扣一次库存', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '并发归属测试商品', 1000);
    await stockIn(merchant.token, skuId, 10);

    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token, '张三');
    const idempotencyKey = unique();

    // 发 5 个：保证「至少两个在对方提交前完成快路径查询」，
    // P2002 → 事务外重查那条路径才会真的被走到。
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        placeOrder(customer.token, {
          addressId,
          items: [{ skuId, quantity: 1 }],
          idempotencyKey,
        }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);
    const orderNos = new Set(results.map((r) => orderBody(r).orderNo));
    expect(orderNos.size).toBe(1);

    const orders = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { idempotencyKey } }),
    );
    expect(orders).toHaveLength(1);
  });
});
