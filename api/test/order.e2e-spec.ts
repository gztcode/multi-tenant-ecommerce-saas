import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { OrderStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { OrderService } from '../src/modules/order/order.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 订单与状态机的 e2e（阶段 3 Task 4）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 6：下单幂等键
 * - 护栏 7：跨租户下单被拒
 * - 护栏 8：订单金额不能被客户端传的价格篡改
 * - 护栏 10：状态流转用条件更新（并发下只有一个赢家）
 * - 护栏 15：订单状态机拒绝非法流转
 * - 护栏 16：取消订单释放预占
 * - 护栏 17：流转到 REFUNDED 不碰库存
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface UserBody {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
}

interface TokenBody {
  accessToken: string;
  user: UserBody;
}

interface SkuBody {
  id: string;
  price: number;
}

interface SpecMatrixBody {
  skus: SkuBody[];
}

interface OrderItemBody {
  id: string;
  skuId: string;
  productId: string;
  productName: string;
  skuSnapshot: { specs: Array<{ name: string; value: string }> };
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

interface OrderBody {
  id: string;
  orderNo: string;
  customerId: string | null;
  status: string;
  totalAmount: number;
  itemCount: number;
  receiverName: string;
  receiverPhone: string;
  remark: string | null;
  trackingNo: string | null;
  items: OrderItemBody[];
}

interface OrderListBody {
  items: OrderBody[];
}

interface AddressBody {
  id: string;
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

function orderListBody(response: { body: unknown }): OrderListBody {
  return response.body as OrderListBody;
}

function addressBody(response: { body: unknown }): AddressBody {
  return response.body as AddressBody;
}

describe('订单与状态机 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let orderService: OrderService;

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
    orderService = app.get(OrderService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  /**
   * 造一个已上架、已定价的商品，返回它的 SKU id。
   *
   * 走完整的商家接口（建商品 → 铺规格 → 定价 → 上架），
   * 这样 SKU 的归属与上架状态都是真的，不靠直接落库绕过业务规则。
   */
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

  /**
   * 造一个带**多个规格**的已上架商品，返回它的 SKU id。
   *
   * 用来验证 `skuSnapshot` 的形状（设计 §3.4 / 计划 §4.4b 第 4 条）：
   * `{ specs: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] }`
   */
  async function publishMultiSpecSku(
    token: string,
    name: string,
    specs: Array<{ name: string; values: string[] }>,
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
        specs: specs.map((spec) => ({
          name: spec.name,
          values: spec.values.map((value) => ({ value })),
        })),
      })
      .expect(200);
    // 取第一个组合（第一个规格的第一个值 × 第二个规格的第一个值）
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

  /** 入库若干件（走库存调整接口，让流水也是真的） */
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

  /** 在某个店铺注册一个消费者，返回令牌 */
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

  /** 造一条收货地址，返回它的 id */
  async function createAddress(token: string): Promise<string> {
    const created = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${token}`)
      .send({
        receiver: '张三',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      })
      .expect(201);
    return addressBody(created).id;
  }

  /** 读某个 SKU 当前的库存 */
  async function readStock(tenantId: string, skuId: string): Promise<number> {
    return asTenant(tenantId, async () => {
      const sku = await prisma.sku.findFirst({ where: { id: skuId } });
      return sku?.stock ?? -1;
    });
  }

  /** 读某个 SKU 的全部流水 */
  async function readMovements(tenantId: string, skuId: string) {
    return asTenant(tenantId, () =>
      prisma.inventoryMovement.findMany({
        where: { skuId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /**
   * 把订单推进到 `PAID`。
   *
   * ⚠️ Task 5 的支付还没做，没有 HTTP 端点能把订单转成已支付。
   * 这里直接落库推进状态——测的是**状态机**，
   * 「支付回调怎么把订单转成 PAID」由 Task 5 的用例负责。
   */
  async function markPaid(tenantId: string, orderNo: string): Promise<void> {
    await asTenant(tenantId, () =>
      prisma.order.updateMany({
        where: { orderNo },
        data: { status: 'PAID', paidAt: new Date() },
      }),
    );
  }

  /**
   * 下单。
   *
   * ⚠️ 刻意**不写成 async**：写成 async 会把 supertest 的 Test 对象
   * 包进 Promise，`await placeOrder(...).expect(201)` 就变成
   * `await Promise.expect(...)` —— expect 不是函数。
   */
  function placeOrder(
    token: string,
    payload: {
      addressId: string;
      items: Array<{ skuId: string; quantity: number }>;
      idempotencyKey?: string;
      remark?: string;
    },
  ) {
    return http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${token}`)
      .send(payload);
  }

  // ---- 下单基本流程 ----

  it('下单：订单、订单项、金额都由服务端算', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '下单的商品', 1500);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const response = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);

    const order = orderBody(response);
    // 金额 = 1500 × 2 = 3000（整数分）
    expect(order.totalAmount).toBe(3000);
    expect(order.itemCount).toBe(2);
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.items).toHaveLength(1);
    expect(order.items[0].unitPrice).toBe(1500);
    expect(order.items[0].subtotal).toBe(3000);
    expect(order.items[0].quantity).toBe(2);
    // 收货信息是下单时的快照
    expect(order.receiverName).toBe('张三');
    expect(order.receiverPhone).toBe('13800000000');

    // 库存被预占（扣掉可售库存）
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);

    // 订单号格式：日期 + 10 位随机，全小写字母数字
    expect(order.orderNo).toMatch(/^\d{8}-[a-z0-9]{10}$/);

    // 流水里有一条 RESERVE
    const movements = await readMovements(merchant.tenantId, skuId);
    const reserveMovements = movements.filter((m) => m.type === 'RESERVE');
    expect(reserveMovements).toHaveLength(1);
    expect(reserveMovements[0].quantity).toBe(-2);
  });

  it('下单：订单项快照商品名与规格，商家改名改价不影响已有订单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '原来的商品名', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const order = orderBody(placed);

    // 快照里应有商品名与规格
    expect(order.items[0].productName).toBe('原来的商品名');
    expect(order.items[0].skuSnapshot.specs).toEqual([
      { name: '规格', value: '默认' },
    ]);

    // 商家后来改名改价
    const productId = order.items[0].productId;
    await http(app)
      .patch(`/api/v1/catalog/products/${productId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '改过的商品名' })
      .expect(200);
    await http(app)
      .patch(`/api/v1/catalog/products/${productId}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 9999 })
      .expect(200);

    // 再读订单：快照不变
    const detail = await http(app)
      .get(`/api/v1/orders/${order.orderNo}`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);
    const reread = orderBody(detail);
    expect(reread.items[0].productName).toBe('原来的商品名');
    expect(reread.items[0].unitPrice).toBe(1000);
    expect(reread.totalAmount).toBe(1000);
  });

  it('下单时读到的单价是加锁后的最新值：改价后下的单按新价算', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '改价后下单的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    // 先把价格改成 2000（下单前就改完，不与下单事务竞争）
    const productId = await asTenant(merchant.tenantId, async () => {
      const rows = await prisma.sku.findMany({ where: { id: skuId } });
      return rows[0].productId;
    });
    await http(app)
      .patch(`/api/v1/catalog/products/${productId}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 2000 })
      .expect(200);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);

    // 单价必须等于下单那一刻的 SKU 价格（2000），不是更早的 1000
    expect(orderBody(placed).items[0].unitPrice).toBe(2000);
    expect(orderBody(placed).totalAmount).toBe(4000);
  });

  it('skuSnapshot 的形状：规格名与规格值都快照下来', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishMultiSpecSku(
      merchant.token,
      '多规格的商品',
      [
        { name: '颜色', values: ['黑色', '白色'] },
        { name: '尺码', values: ['M', 'L'] },
      ],
      2500,
    );
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);

    // ⚠️ 形状必须与设计 §3.4 一致：
    // `{ specs: [{ name: '颜色', value: '黑色' }, ...] }`
    const snapshot = orderBody(placed).items[0].skuSnapshot;
    expect(snapshot.specs).toEqual([
      { name: '颜色', value: '黑色' },
      { name: '尺码', value: 'M' },
    ]);
  });

  // ---- 护栏 8：金额由服务端算 ----

  it('金额由服务端算：请求体里的 unitPrice 被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '防篡改的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    // 请求里带价格字段 → forbidNonWhitelisted → 400
    const response = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1, unitPrice: 1 } as never],
    });
    expect(response.status).toBe(400);

    // 顶层也试一次
    const topLevel = await http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${customer.token}`)
      .send({
        addressId,
        items: [{ skuId, quantity: 1 }],
        totalAmount: 1,
      });
    expect(topLevel.status).toBe(400);

    // ⚠️ 查库确认没有留下任何订单，库存也没被动过
    const orders = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { customerId: customer.userId } }),
    );
    expect(orders).toHaveLength(0);
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
  });

  it('下单成功时订单金额等于 SKU 的真实价格', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '真实价格的商品', 3333);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const response = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 3 }],
    }).expect(201);

    expect(orderBody(response).totalAmount).toBe(9999);
  });

  // ---- 护栏 6：幂等键 ----

  it('重复提交同一个幂等键返回同一个订单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '幂等的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);
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

    // ⚠️ 查库确认只有一条订单，库存只减一次
    const orders = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { customerId: customer.userId } }),
    );
    expect(orders).toHaveLength(1);
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);

    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RESERVE')).toHaveLength(1);
  });

  it('并发提交同一个幂等键：只建一笔订单，只扣一次库存', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '并发幂等的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);
    const idempotencyKey = unique();

    // ⚠️ 必须真的并发。
    //
    // ⚠️ **发 5 个而不是 2 个**：两个并发请求不保证会「撞上」——
    // 第二个的幂等快路径查询可能在第一个提交之后才跑，
    // 于是它直接命中已有订单，压根不触发 P2002 那条路径。
    // 发得越多，「至少两个在对方提交前完成快路径查询」的概率越高，
    // 唯一索引冲突那条路径才真的被走到。
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        placeOrder(customer.token, {
          addressId,
          items: [{ skuId, quantity: 1 }],
          idempotencyKey,
        }),
      ),
    );

    // 所有请求都要成功（一个建单，其余命中幂等返回同一个订单）
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);
    const orderNos = new Set(results.map((r) => orderBody(r).orderNo));
    expect(orderNos.size).toBe(1);

    // ⚠️ 查库确认只有一笔订单，库存只扣一次
    const orders = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { customerId: customer.userId } }),
    );
    expect(orders).toHaveLength(1);
    expect(await readStock(merchant.tenantId, skuId)).toBe(9);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RESERVE')).toHaveLength(1);
  });

  // ---- 护栏 7：跨租户下单被拒 ----

  it('跨租户下单被拒：把 A 店的 SKU 放进 B 店的订单', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuOfA = await publishSku(a.token, 'A 店的商品', 1000);
    await stockIn(a.token, skuOfA, 10);
    const customerOfB = await registerCustomer(b.subdomain);
    const addressOfB = await createAddress(customerOfB.token);

    const response = await placeOrder(customerOfB.token, {
      addressId: addressOfB,
      items: [{ skuId: skuOfA, quantity: 1 }],
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    // A 店的库存没被动过，B 店没有订单
    expect(await readStock(a.tenantId, skuOfA)).toBe(10);
    const ordersOfB = await asTenant(b.tenantId, () => prisma.order.findMany());
    expect(ordersOfB).toHaveLength(0);
  });

  it('跨租户下单被拒：B 店的地址不能用在 A 店的下单里', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuOfA = await publishSku(a.token, 'A 店的商品', 1000);
    await stockIn(a.token, skuOfA, 10);
    const customerOfA = await registerCustomer(a.subdomain);
    const addressOfB = await registerCustomer(b.subdomain);
    const addressIdOfB = await createAddress(addressOfB.token);

    const response = await placeOrder(customerOfA.token, {
      addressId: addressIdOfB,
      items: [{ skuId: skuOfA, quantity: 1 }],
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await readStock(a.tenantId, skuOfA)).toBe(10);
  });

  // ---- 护栏 10 / 15：状态机 ----

  it('状态机拒绝非法流转：COMPLETED 不能转回 PAID', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '终态的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // ⚠️ Task 5 的支付还没做，先把订单推进到 PAID 才能发货
    await markPaid(merchant.tenantId, orderNo);

    // 商家发货
    await http(app)
      .post(`/api/v1/merchant/orders/${orderNo}/ship`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ trackingNo: 'SF123456' })
      .expect(201);

    // 消费者确认收货
    await http(app)
      .post(`/api/v1/orders/${orderNo}/confirm`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);

    // ⚠️ COMPLETED 是终态：再确认一次必须被拒
    const again = await http(app)
      .post(`/api/v1/orders/${orderNo}/confirm`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(again.status).toBe(409);

    // 查库确认状态仍是 COMPLETED
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { orderNo } }),
    );
    expect(rows[0].status).toBe('COMPLETED');
  });

  it('状态机拒绝非法流转：PENDING_PAYMENT 不能直接发货', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '没付款就发货', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    const response = await http(app)
      .post(`/api/v1/merchant/orders/${orderNo}/ship`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ trackingNo: 'SF123456' });
    expect(response.status).toBe(409);

    const rows = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { orderNo } }),
    );
    expect(rows[0].status).toBe('PENDING_PAYMENT');
  });

  it('状态机拒绝非法流转：PENDING_PAYMENT 不能确认收货', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '没发货就收货', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    const response = await http(app)
      .post(`/api/v1/orders/${orderNo}/confirm`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(response.status).toBe(409);
  });

  // ---- 护栏 16：取消订单释放预占 ----

  it('取消订单释放预占：库存加回、记 RELEASE 流水', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '会取消的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 3 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;
    expect(await readStock(merchant.tenantId, skuId)).toBe(7);

    await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);

    // 库存加回
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);

    // 记一条 RELEASE 流水
    const movements = await readMovements(merchant.tenantId, skuId);
    const releaseMovements = movements.filter((m) => m.type === 'RELEASE');
    expect(releaseMovements).toHaveLength(1);
    expect(releaseMovements[0].quantity).toBe(3);

    // 状态转 CANCELLED
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { orderNo } }),
    );
    expect(rows[0].status).toBe('CANCELLED');
  });

  it('已支付的订单不能取消', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '已支付不能取消', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // 直接把状态改成 PAID（Task 5 的支付回调还没做，这里直接落库推进状态）
    await markPaid(merchant.tenantId, orderNo);

    const response = await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(response.status).toBe(409);

    // ⚠️ 查库确认库存没被还回去
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { orderNo } }),
    );
    expect(rows[0].status).toBe('PAID');
  });

  it('重复取消同一订单被拒：库存只被加回一次', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重复取消的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);

    const again = await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(again.status).toBe(409);

    // ⚠️ 库存只被加回一次（不能是 12）
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(1);
  });

  it('取消是原子的：释放失败时订单状态不能已经变成 CANCELLED', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '释放会失败的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // ⚠️ 先把预占「消耗掉」：记一条 DEDUCT 流水，
    // 该订单未冲抵的预占量变成 0 —— 之后的释放会因「预占量不足」被拒。
    //
    // 这模拟的是「释放这一步失败」的真实场景（预占量对不上、
    // 锁超时、数据库抖动……）。
    const orderId = await asTenant(merchant.tenantId, async () => {
      const rows = await prisma.order.findMany({ where: { orderNo } });
      return rows[0].id;
    });
    await asTenant(merchant.tenantId, () =>
      prisma.inventoryMovement.create({
        data: {
          tenantId: merchant.tenantId,
          skuId,
          type: 'DEDUCT',
          quantity: -2,
          stockBefore: 8,
          stockAfter: 8,
          orderId,
          reason: '测试：模拟预占已被消耗',
        },
      }),
    );

    const response = await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    // ⚠️ 关键断言：状态**不能**是 CANCELLED。
    // 分成两个事务（先改状态再释放）的话，释放失败时订单已经是 CANCELLED，
    // 而超时释放任务看到状态不是 PENDING_PAYMENT 也不会再管它——
    // 那批库存就永久卡在预占里。
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { orderNo } }),
    );
    expect(rows[0].status).toBe('PENDING_PAYMENT');
  });

  // ---- 护栏 17：转 REFUNDED 不碰库存 ----

  it('流转到 REFUNDED 不碰库存：货已发出，退的是钱不是库存', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退款不碰库存', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // 推进到 PAID → SHIPPED
    await markPaid(merchant.tenantId, orderNo);
    await http(app)
      .post(`/api/v1/merchant/orders/${orderNo}/ship`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ trackingNo: 'SF123456' })
      .expect(201);

    const stockBefore = await readStock(merchant.tenantId, skuId);
    expect(stockBefore).toBe(8);

    // 转 REFUNDED（Task 5 的退款端点还没做，这里直接落库推进状态）
    await asTenant(merchant.tenantId, () =>
      prisma.order.updateMany({
        where: { orderNo },
        data: { status: 'REFUNDED' },
      }),
    );

    // ⚠️ 关键断言：库存与退款前**完全相同**，且不得出现 RELEASE 流水
    expect(await readStock(merchant.tenantId, skuId)).toBe(stockBefore);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
    expect(movements.filter((m) => m.type === 'DEDUCT')).toHaveLength(0);
  });

  // ---- 商家侧接口 ----

  it('商家侧：订单列表、详情、发货', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '商家侧的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // 商家列表能看到
    const list = await http(app)
      .get('/api/v1/merchant/orders')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const items = orderListBody(list).items;
    expect(items).toHaveLength(1);
    expect(items[0].orderNo).toBe(orderNo);

    // 商家详情
    const detail = await http(app)
      .get(`/api/v1/merchant/orders/${orderNo}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(orderBody(detail).orderNo).toBe(orderNo);

    // ⚠️ Task 5 的支付还没做，先把订单推进到 PAID 才能发货
    await markPaid(merchant.tenantId, orderNo);

    // 发货
    const shipped = await http(app)
      .post(`/api/v1/merchant/orders/${orderNo}/ship`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ trackingNo: 'SF123456' })
      .expect(201);
    expect(orderBody(shipped).status).toBe('SHIPPED');
    expect(orderBody(shipped).trackingNo).toBe('SF123456');

    // 发货后确认收货
    await http(app)
      .post(`/api/v1/orders/${orderNo}/confirm`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);

    const afterConfirm = await http(app)
      .get(`/api/v1/merchant/orders/${orderNo}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(orderBody(afterConfirm).status).toBe('COMPLETED');
  });

  it('商家侧：订单列表按状态筛选', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '筛选用的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // 取消一笔，让状态变成 CANCELLED
    await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);

    const cancelled = await http(app)
      .get('/api/v1/merchant/orders')
      .query({ status: 'CANCELLED' })
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(orderListBody(cancelled).items).toHaveLength(1);
    expect(orderListBody(cancelled).items[0].status).toBe('CANCELLED');

    const pending = await http(app)
      .get('/api/v1/merchant/orders')
      .query({ status: 'PENDING_PAYMENT' })
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(orderListBody(pending).items).toHaveLength(0);
  });

  it('分页参数被夹到合法区间：超大 pageSize 拖不出全部订单，畸形参数不 500', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '分页的商品', 1000);
    await stockIn(merchant.token, skuId, 50);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    for (let i = 0; i < 3; i++) {
      await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
      }).expect(201);
    }

    // ⚠️ **pageSize 有上限**：否则 pageSize=999999 一次就把整个租户的
    // 订单拖出去——那是实打实的数据泄露。
    const huge = await http(app)
      .get('/api/v1/merchant/orders')
      .query({ pageSize: 999999 })
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(orderListBody(huge).items.length).toBeLessThanOrEqual(100);

    // ⚠️ **畸形参数不能变成 500**：page=0 会算出负的 skip 让 Prisma 报错，
    // page=abc 会让 Number() 得到 NaN。畸形入参变 500 是最容易被拿来
    // 刷错误日志、触发告警的形态。
    const malformed: Array<Record<string, string | number>> = [
      { page: 0 },
      { page: -5 },
      { page: 'abc' },
      { pageSize: 'abc' },
      { pageSize: 0 },
      { pageSize: -1 },
    ];
    for (const query of malformed) {
      const response = await http(app)
        .get('/api/v1/merchant/orders')
        .query(query)
        .set('authorization', `Bearer ${merchant.token}`);
      expect(response.status).toBe(200);
    }

    // 正常分页仍然工作
    const paged = await http(app)
      .get('/api/v1/merchant/orders')
      .query({ page: 1, pageSize: 2 })
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(orderListBody(paged).items).toHaveLength(2);
  });

  it('消费者侧：我的订单列表只列自己的订单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '列表隔离的商品', 1000);
    await stockIn(merchant.token, skuId, 20);
    const customerA = await registerCustomer(merchant.subdomain);
    const customerB = await registerCustomer(merchant.subdomain);
    const addressA = await createAddress(customerA.token);
    const addressB = await createAddress(customerB.token);

    await placeOrder(customerA.token, {
      addressId: addressA,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    await placeOrder(customerB.token, {
      addressId: addressB,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);

    const listA = await http(app)
      .get('/api/v1/orders')
      .set('authorization', `Bearer ${customerA.token}`)
      .expect(200);
    expect(orderListBody(listA).items).toHaveLength(1);
  });

  it('消费者侧：不能查看别人的订单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '越权查看的商品', 1000);
    await stockIn(merchant.token, skuId, 20);
    const customerA = await registerCustomer(merchant.subdomain);
    const customerB = await registerCustomer(merchant.subdomain);
    const addressA = await createAddress(customerA.token);

    const placed = await placeOrder(customerA.token, {
      addressId: addressA,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    const response = await http(app)
      .get(`/api/v1/orders/${orderNo}`)
      .set('authorization', `Bearer ${customerB.token}`);
    // ⚠️ 断言要具体：不能只断言「4xx」——那会掩盖真实缺陷
    // （比如 401 与 404 意味着完全不同的东西）。
    // 这里期望 404：服务层带 customerId 过滤，查不到就是「不存在」。
    expect(response.status).toBe(404);
  });

  it('消费者侧：游客不能读订单详情、也不能取消订单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '游客越权的商品', 1000);
    await stockIn(merchant.token, skuId, 20);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // ⚠️ **这条守着一个真实的越权**：订单号不是秘密——它出现在支付回调、
    // 商家后台的搜索框、日志里。游客（或换个人）拿订单号就能读别人的
    // 收货信息、甚至把别人的订单取消掉。
    const read = await http(app)
      .get(`/api/v1/orders/${orderNo}`)
      .set('x-tenant-subdomain', merchant.subdomain);
    expect(read.status).toBe(401);

    const cancel = await http(app)
      .post(`/api/v1/orders/${orderNo}/cancel`)
      .set('x-tenant-subdomain', merchant.subdomain);
    expect(cancel.status).toBe(401);

    // 订单没被动过
    const stillPending = await http(app)
      .get(`/api/v1/orders/${orderNo}`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(stillPending.status).toBe(200);
    expect(orderBody(stillPending).status).toBe('PENDING_PAYMENT');
  });

  it('消费者侧：游客下单被拒（本阶段不支持游客订单）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '游客下单的商品', 1000);
    await stockIn(merchant.token, skuId, 10);

    // ⚠️ 本阶段要求登录下单（设计 §十三 遗留项 8 的取舍之一：
    // 「本阶段就要求游客下单前登录」）。
    const response = await http(app)
      .post('/api/v1/orders')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({
        addressId: 'some-address',
        items: [{ skuId, quantity: 1 }],
      });
    expect(response.status).toBe(401);

    // 库存没被动过——没下单就没有预占
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
  });

  it('下单后购物车里已下单的条目被清掉', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '清购物车的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    await http(app)
      .post('/api/v1/cart/items')
      .set('authorization', `Bearer ${customer.token}`)
      .send({ skuId, quantity: 2 })
      .expect(201);

    await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);

    const cart = await http(app)
      .get('/api/v1/cart')
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);
    const cartItems = (cart.body as { items: Array<{ skuId: string }> }).items;
    expect(cartItems.filter((item) => item.skuId === skuId)).toHaveLength(0);
  });

  // ---- 护栏 10：状态流转的条件更新（并发下只有一个赢家）----

  it('并发流转：两个请求同时把 PENDING_PAYMENT 转走，只有一个生效', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '并发流转的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;

    // ⚠️ 直接调服务的 transition：模拟「支付回调」与「超时释放」同时到达。
    //
    // 两者都从 PENDING_PAYMENT 出发，一个想转 PAID、一个想转 CANCELLED。
    // 「先查后改」的写法会让两个都读到 PENDING_PAYMENT 然后都往下走——
    // 订单转成了 PAID，库存却被还回去（超卖）。
    // 条件更新（where 带 status）让数据库保证只有一方能赢。
    //
    // ⚠️ 这里刻意**不**用 HTTP 端点：HTTP 的取消端点自己就带条件更新，
    // 测它测的是「端点有没有做条件更新」，而不是「条件更新对不对」。
    // 而支付回调端点在 Task 5 才有。
    const orderId = await asTenant(merchant.tenantId, async () => {
      const rows = await prisma.order.findMany({ where: { orderNo } });
      return rows[0].id;
    });

    const results = await asTenant(merchant.tenantId, () =>
      Promise.all([
        orderService.transition(
          orderId,
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.PAID,
          { paidAt: new Date() },
        ),
        orderService.transition(
          orderId,
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.CANCELLED,
          { cancelledAt: new Date() },
        ),
      ]),
    );

    // 恰好一个成功
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(1);

    // 查库确认订单只被流转了一次
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.order.findMany({ where: { orderNo } }),
    );
    expect([OrderStatus.PAID, OrderStatus.CANCELLED]).toContain(rows[0].status);
  });

  it('并发取消同一个订单：库存只被释放一次', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '并发取消的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const orderNo = orderBody(placed).orderNo;
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);

    // ⚠️ 必须真的并发
    const responses = await Promise.all([
      http(app)
        .post(`/api/v1/orders/${orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`),
      http(app)
        .post(`/api/v1/orders/${orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`),
    ]);

    // 一个成功一个冲突
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    // ⚠️ 关键断言：库存只被加回一次（不能是 12）
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(1);
  });
});
