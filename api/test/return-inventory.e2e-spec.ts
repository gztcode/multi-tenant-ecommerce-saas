import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 退货入库的 e2e（阶段 11d）。
 *
 * 造 REFUNDED 的路径：下单 → 假网关回调支付 → 商家退款（merchant 路由）。
 * 假网关回调的签名机制与 payment.e2e-spec 同款（HMAC 全原始 body）。
 *
 * 覆盖：
 * 1. happy path：REFUNDED 订单入库 → 库存增加、RETURN 流水带 orderId；
 * 2. 上限：入库量 > 购买量 − 已入库量 → 400（数据层防重复入库）；
 * 3. 同 SKU 多条目合并后校验（绕不过上限）；
 * 4. 状态闸：非 REFUNDED（PAID）订单 → 409；
 * 5. 外来 SKU → 400；
 * 6. RBAC：CUSTOMER 令牌 → 403。
 */

const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';
const FAKE_CHANNEL = 'fake';

interface IdBody {
  id: string;
}

interface OrderBody {
  orderNo: string;
  totalAmount: number;
  status: string;
}

describe('退货入库（阶段 11d）', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // ⚠️ `rawBody: true`：webhook 端点要拿原始字节验签（与 payment.e2e 同款）
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
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
    delete process.env.FAKE_PAYMENT_ENABLED;
    delete process.env.FAKE_PAYMENT_SECRET;
    await app.close();
  });

  // ---------- 造数辅助 ----------

  /** 发布一个单 SKU 商品并返回 SKU id（与 order.e2e 的 publishSku 同款；规格矩阵建的 SKU 库存为 0，补一笔入库） */
  async function publishSku(
    token: string,
    name: string,
    price: number,
    stock = 10,
  ): Promise<string> {
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send({ name, slug: `p-${unique()}` })
      .expect(201);
    const productId = (created.body as IdBody).id;

    const matrix = await http(app)
      .put(`/api/v1/catalog/products/${productId}/specs`)
      .set('authorization', `Bearer ${token}`)
      .send({
        version: 1,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);
    const skuId = (
      matrix.body as { skus: Array<{ id: string }> }
    ).skus[0].id;

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

    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${token}`)
      .send({ skuId, type: 'ADJUST_IN', quantity: stock })
      .expect(201);

    return skuId;
  }

  async function registerCustomer(
    subdomain: string,
  ): Promise<{ token: string }> {
    const response = await http(app)
      .post('/api/v1/auth/register/customer')
      .set('x-tenant-subdomain', subdomain)
      .send({
        email: `ret-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '退货顾客',
      })
      .expect(201);
    return { token: (response.body as { accessToken: string }).accessToken };
  }

  async function createAddress(token: string): Promise<string> {
    const created = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${token}`)
      .send({
        receiver: '退货测试',
        phone: '13800001111',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      })
      .expect(201);
    return (created.body as IdBody).id;
  }

  function signFakeWebhook(payload: Record<string, unknown>): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', FAKE_SECRET)
      .update(body)
      .digest('hex');
    return { body, signature };
  }

  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { tenantId, userId: null, role: null },
      async () => fn(),
    );
  }

  async function readOrder(
    tenantId: string,
    orderNo: string,
  ): Promise<OrderBody & { id: string }> {
    return asTenant(tenantId, async () => {
      const rows = await prisma.order.findFirst({
        where: { orderNo },
      });
      if (!rows) throw new Error(`order ${orderNo} not found`);
      return rows as unknown as OrderBody & { id: string };
    });
  }

  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  /** 下单 → 发起支付 → 假网关回调 → 订单 PAID。返回订单（含 id） */
  async function placeAndPay(
    merchant: { token: string; subdomain: string; tenantId: string },
    skuId: string,
    quantity: number,
  ): Promise<{ order: OrderBody & { id: string }; customerToken: string }> {
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${customer.token}`)
      .send({ addressId, items: [{ skuId, quantity }] })
      .expect(201);
    const orderNo = (placed.body as { orderNo: string }).orderNo;

    const paid = await http(app)
      .post(`/api/v1/orders/${orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(201);
    const paymentId = (paid.body as { paymentId: string }).paymentId;

    const payload = {
      eventId: `evt-ret-${unique()}`,
      providerTxnId: paymentId,
      orderNo,
      amount: (placed.body as { totalAmount: number }).totalAmount,
      success: true,
    };
    const { body, signature } = signFakeWebhook(payload);
    await http(app)
      .post(`/api/v1/webhooks/payment/${FAKE_CHANNEL}`)
      .set('content-type', 'application/json')
      .set('x-fake-signature', signature)
      .send(body)
      .expect(200);

    const becamePaid = await waitFor(async () => {
      const row = await readOrder(merchant.tenantId, orderNo);
      return row.status === 'PAID';
    });
    expect(becamePaid).toBe(true);
    const paidOrder = await readOrder(merchant.tenantId, orderNo);
    return { order: paidOrder, customerToken: customer.token };
  }

  it('happy path：REFUNDED 订单入库 → 库存增加、RETURN 流水带 orderId', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退货测试商品', 1500);
    const stockBefore = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirstOrThrow({ where: { id: skuId } });
      return sku.stock;
    });

    const { order } = await placeAndPay(merchant, skuId, 2);
    // PAID 后库存已扣减
    const stockAfterDeduct = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirstOrThrow({ where: { id: skuId } });
      return sku.stock;
    });
    expect(stockAfterDeduct).toBe(stockBefore - 2);

    // 商家退款 → REFUNDED（库存按设计不回补）
    await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: '退货测试' })
      .expect(201);
    const refunded = await readOrder(merchant.tenantId, order.orderNo);
    expect(refunded.status).toBe('REFUNDED');
    const stockAfterRefund = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirstOrThrow({ where: { id: skuId } });
      return sku.stock;
    });
    expect(stockAfterRefund).toBe(stockAfterDeduct); // 退款不回补（有意取舍）

    // 退货入库：2 件回到仓库
    await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        orderId: order.id,
        items: [{ skuId, quantity: 2 }],
        reason: '货已退回仓库',
      })
      .expect(201);

    const stockAfterReturn = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirstOrThrow({ where: { id: skuId } });
      return sku.stock;
    });
    expect(stockAfterReturn).toBe(stockAfterRefund + 2);

    const movements = await asTenant(merchant.tenantId, () =>
      prisma.inventoryMovement.findMany({
        where: { skuId, orderId: order.id, type: 'RETURN' },
      }),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(2);
    expect(movements[0].orderId).toBe(order.id);
  });

  it('⚠️ 上限：入库量超过购买量 − 已入库量 → 400', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退货上限商品', 900);
    const { order } = await placeAndPay(merchant, skuId, 1);
    await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: 'x' })
      .expect(201);

    // 第一次入库 1 件（= 购买量）
    await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ orderId: order.id, items: [{ skuId, quantity: 1 }] })
      .expect(201);

    // 再想入 1 件 → 超上限
    const response = await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ orderId: order.id, items: [{ skuId, quantity: 1 }] })
      .expect(400);
    expect((response.body as { message: string }).message).toContain(
      '最多还能入库 0 件',
    );
  });

  it('⚠️ 同 SKU 多条目合并后校验（拆两笔绕不过上限）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退货合并商品', 700);
    const { order } = await placeAndPay(merchant, skuId, 1);
    await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: 'x' })
      .expect(201);

    const response = await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        orderId: order.id,
        items: [
          { skuId, quantity: 1 },
          { skuId, quantity: 1 },
        ],
      })
      .expect(400);
    // 合并后请求 2 件、余量 1 件 → 拒绝，且文案是「还能入 1 件」
    expect((response.body as { message: string }).message).toContain(
      '最多还能入库 1 件',
    );
  });

  it('⚠️ 状态闸：PAID（未退款）订单不能退货入库', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '未退款商品', 600);
    const { order } = await placeAndPay(merchant, skuId, 1);

    const response = await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ orderId: order.id, items: [{ skuId, quantity: 1 }] })
      .expect(409);
    expect((response.body as { message: string }).message).toContain(
      'REFUNDED',
    );
  });

  it('⚠️ 外来 SKU：不在订单里的商品 → 400', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退货主商品', 500);
    const otherSkuId = await publishSku(merchant.token, '无关商品', 300);
    const { order } = await placeAndPay(merchant, skuId, 1);
    await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: 'x' })
      .expect(201);

    const response = await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ orderId: order.id, items: [{ skuId: otherSkuId, quantity: 1 }] })
      .expect(400);
    expect((response.body as { message: string }).message).toContain(
      '不在本订单中',
    );
  });

  it('⚠️ RBAC：CUSTOMER 令牌不能退货入库', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '权限商品', 400);
    const { order, customerToken } = await placeAndPay(merchant, skuId, 1);

    await http(app)
      .post('/api/v1/inventory/returns')
      .set('authorization', `Bearer ${customerToken}`)
      .send({ orderId: order.id, items: [{ skuId, quantity: 1 }] })
      .expect(403);
  });
});
