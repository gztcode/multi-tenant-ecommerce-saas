import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { CouponRedemptionService } from '../src/modules/coupon/coupon-redemption.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 下单接入优惠 + 券的预占核销（阶段 5a Task 4）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M1：客户端传优惠金额无效（请求体里的优惠字段一律被拒）
 * - 护栏 M2：券的门槛/面额不可被客户端篡改（只接受 couponId）
 * - 护栏 M3：跨租户用券被拒（平台券跨店可用，店铺券不跨店）
 * - 护栏 M5：同一张券不被两笔订单同时用（部分唯一索引）
 * - 护栏 M6：优惠不绕过金额校验（实付不为负）
 * - 护栏 M12：历史订单不被重算（快照）
 * - 护栏 M14：核销计数与核销记录同步
 * - 护栏 M16：满减活动与券的叠加顺序（活动先、券后）
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface TokenBody {
  accessToken: string;
  user: { id: string };
}

interface CouponBody {
  id: string;
  code: string;
  name: string;
  value: number;
  minAmount: number;
}

interface OrderBody {
  id: string;
  orderNo: string;
  totalAmount: number;
  originalAmount: number;
  promotionDiscountAmount: number;
  promotionId: string | null;
  couponDiscountAmount: number;
  couponId: string | null;
  couponCode: string | null;
  couponName: string | null;
  items: Array<{ unitPrice: number; quantity: number; subtotal: number }>;
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function couponBody(response: { body: unknown }): CouponBody {
  return response.body as CouponBody;
}

function orderBody(response: { body: unknown }): OrderBody {
  return response.body as OrderBody;
}

/** 把错误响应里的 message 摊平成一段文本，便于断言包含某个关键词 */
function errorText(response: { body: unknown }): string {
  const body = response.body as { message: string | string[] };
  const message = body.message;
  return Array.isArray(message) ? message.join('; ') : message;
}

describe('下单优惠与券的预占核销 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let couponRedemption: CouponRedemptionService;
  /**
   * 裸 PrismaClient：绕开租户扩展，用来在**平台作用域**下造平台券，
   * 以及查看软删行的真身。
   */
  let rawPrisma: PrismaClient;

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
    couponRedemption = app.get(CouponRedemptionService);
    rawPrisma = new PrismaClient();
  });

  afterAll(async () => {
    await rawPrisma.$disconnect();
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
   * 这样 SKU 的归属与上架状态都是真的。
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
    const skuId = (matrix.body as { skus: Array<{ id: string }> }).skus[0].id;

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

  /** 在某个店铺注册一个消费者，返回令牌与用户 id */
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
    return (created.body as { id: string }).id;
  }

  /** 商家建一张券 */
  async function createCoupon(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<CouponBody> {
    const response = await http(app)
      .post('/api/v1/merchant/coupons')
      .set('authorization', `Bearer ${token}`)
      .send({
        code: `C-${unique()}`,
        name: '测试券',
        value: 1000,
        minAmount: 0,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...overrides,
      })
      .expect(201);
    return couponBody(response);
  }

  /** 商家建一个满减活动 */
  async function createPromotion(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const response = await http(app)
      .post('/api/v1/merchant/promotions')
      .set('authorization', `Bearer ${token}`)
      .send({
        name: `活动-${unique()}`,
        minAmount: 0,
        discountAmount: 2000,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...overrides,
      })
      .expect(201);
    return response.body as { id: string };
  }

  /** 消费者领券 */
  async function claimCoupon(token: string, couponId: string): Promise<void> {
    await http(app)
      .post('/api/v1/coupons/claim')
      .set('authorization', `Bearer ${token}`)
      .send({ couponId })
      .expect(200);
  }

  /** 下单（刻意不写成 async，见 order.e2e-spec.ts 的同款说明） */
  function placeOrder(
    token: string,
    payload: {
      addressId: string;
      items: Array<{ skuId: string; quantity: number }>;
      couponId?: string;
      idempotencyKey?: string;
    } & Record<string, unknown>,
  ) {
    return http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${token}`)
      .send(payload);
  }

  /** 查某个券的核销记录（租户作用域内） */
  async function readRedemptions(
    tenantId: string,
    couponId: string,
  ): Promise<
    Array<{
      id: string;
      orderId: string;
      status: string;
      discountAmount: number;
    }>
  > {
    return asTenant(tenantId, () =>
      prisma.couponRedemption.findMany({
        where: { couponId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  // ============================================================
  // 优惠的基本生效与快照
  // ============================================================

  describe('下单用券', () => {
    it('下单用券：实付 = 原价 - 券减免，订单里写优惠快照', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '用券的商品', 5000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        name: '满减券',
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 2 }],
        couponId: coupon.id,
      }).expect(201);

      const order = orderBody(response);
      // 原价 5000 × 2 = 10000，券减 1000 → 实付 9000
      expect(order.originalAmount).toBe(10_000);
      expect(order.couponDiscountAmount).toBe(1000);
      expect(order.totalAmount).toBe(9000);
      expect(order.couponId).toBe(coupon.id);
      expect(order.couponCode).toBe(coupon.code);
      expect(order.couponName).toBe(coupon.name);
      expect(order.promotionDiscountAmount).toBe(0);
      expect(order.promotionId).toBeNull();

      // ⚠️ 查库确认（响应体之外的第二道断言）
      const rows = await asTenant(merchant.tenantId, () =>
        prisma.order.findMany({ where: { customerId: customer.userId } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].totalAmount).toBe(9000);
      expect(rows[0].originalAmount).toBe(10_000);
    });

    it('下单不带券：优惠字段全为 0，实付 = 原价', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '不用券的商品', 1500);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 2 }],
      }).expect(201);

      const order = orderBody(response);
      expect(order.originalAmount).toBe(3000);
      expect(order.totalAmount).toBe(3000);
      expect(order.couponDiscountAmount).toBe(0);
      expect(order.couponId).toBeNull();
      expect(order.couponCode).toBeNull();
      expect(order.couponName).toBeNull();
      expect(order.promotionDiscountAmount).toBe(0);
      expect(order.promotionId).toBeNull();
    });

    it('门槛不满足的券不参与优惠：实付 = 原价', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '门槛不够的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 100_000,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);

      const order = orderBody(response);
      expect(order.originalAmount).toBe(1000);
      expect(order.totalAmount).toBe(1000);
      expect(order.couponDiscountAmount).toBe(0);
    });

    it('已过期的券不参与优惠：实付 = 原价', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '过期券的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        startsAt: new Date(Date.now() - 7200_000).toISOString(),
        endsAt: new Date(Date.now() - 3600_000).toISOString(),
      });
      // ⚠️ 过期券领不到，所以直接落一条领取记录
      await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: coupon.id,
            customerId: customer.userId,
            quantity: 1,
          },
        }),
      );

      // ⚠️ **不传 couponId**：过期券不在候选里 → 走「没有券」的路径。
      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
      }).expect(201);

      const order = orderBody(response);
      expect(order.totalAmount).toBe(1000);
      expect(order.couponDiscountAmount).toBe(0);
      expect(order.couponId).toBeNull();

      // ⚠️ 查库确认过期券没有被核销
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(0);
    });

    it('显式传一张已过期的券 → 400「优惠券不可用」', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(
        merchant.token,
        '显式传过期券的商品',
        1000,
      );
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        startsAt: new Date(Date.now() - 7200_000).toISOString(),
        endsAt: new Date(Date.now() - 3600_000).toISOString(),
      });
      await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: coupon.id,
            customerId: customer.userId,
            quantity: 1,
          },
        }),
      );

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      });

      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('优惠券不可用');
    });

    it('不在有效期内的活动不参与优惠：实付 = 原价', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '过期活动的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      await createPromotion(merchant.token, {
        discountAmount: 500,
        startsAt: new Date(Date.now() - 7200_000).toISOString(),
        endsAt: new Date(Date.now() - 3600_000).toISOString(),
      });

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
      }).expect(201);

      const order = orderBody(response);
      expect(order.totalAmount).toBe(1000);
      expect(order.promotionDiscountAmount).toBe(0);
      expect(order.promotionId).toBeNull();
    });
  });

  // ============================================================
  // M1 / M2：客户端不能篡改优惠
  // ============================================================

  describe('M1 / M2：客户端不能传优惠相关字段', () => {
    it('M1：请求体里带 discountAmount → 400，且建不出订单', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, 'M1 的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        discountAmount: 99_999,
      });

      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('discountAmount');

      // ⚠️ 不能建出订单，库存也不能被动
      const orders = await asTenant(merchant.tenantId, () =>
        prisma.order.findMany({ where: { customerId: customer.userId } }),
      );
      expect(orders).toHaveLength(0);
      const sku = await asTenant(merchant.tenantId, () =>
        prisma.sku.findFirst({ where: { id: skuId } }),
      );
      expect(sku?.stock).toBe(10);
    });

    it('M2：请求体里带 couponValue / couponMinAmount → 400', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, 'M2 的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      for (const field of ['couponValue', 'couponMinAmount']) {
        const response = await placeOrder(customer.token, {
          addressId,
          items: [{ skuId, quantity: 1 }],
          [field]: 1,
        });
        expect(response.status).toBe(400);
        expect(errorText(response)).toContain(field);
      }

      const orders = await asTenant(merchant.tenantId, () =>
        prisma.order.findMany({ where: { customerId: customer.userId } }),
      );
      expect(orders).toHaveLength(0);
    });

    it('M2：只传 couponId 时，面额与门槛一律从库里读', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '面额从库读的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);

      // 库里面额 1000 → 优惠 1000，不是客户端能定的数
      expect(orderBody(response).couponDiscountAmount).toBe(1000);
      expect(orderBody(response).totalAmount).toBe(1000);
    });

    it('M2：请求体里带 promotionDiscountAmount → 400', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '活动金额的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        promotionDiscountAmount: 99_999,
      });

      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('promotionDiscountAmount');
    });
  });

  // ============================================================
  // M3：跨租户用券
  // ============================================================

  describe('M3：跨租户用券', () => {
    it('M3：A 店的券不在 B 店的候选里 → 实付 = 原价', async () => {
      const a = await createMerchant(app, prisma);
      const b = await createMerchant(app, prisma);
      const skuOfB = await publishSku(b.token, 'B 店的商品', 1000);
      await stockIn(b.token, skuOfB, 10);
      const customerOfB = await registerCustomer(b.subdomain);
      const addressOfB = await createAddress(customerOfB.token);

      const couponOfA = await createCoupon(a.token, {
        value: 1000,
        minAmount: 0,
      });
      // A 店的券在 A 店被领取；B 店的消费者拿不到它
      const customerOfA = await registerCustomer(a.subdomain);
      await claimCoupon(customerOfA.token, couponOfA.id);

      const response = await placeOrder(customerOfB.token, {
        addressId: addressOfB,
        items: [{ skuId: skuOfB, quantity: 1 }],
      });

      // ⚠️ 具体的断言：不是「4xx」，而是「用不上这张券 → 实付 = 原价」。
      // 券不在候选列表里 → 走「没有券」的路径，不报错。
      expect(response.status).toBe(201);
      const order = orderBody(response);
      expect(order.originalAmount).toBe(1000);
      expect(order.totalAmount).toBe(1000);
      expect(order.couponDiscountAmount).toBe(0);
      expect(order.couponId).toBeNull();
    });

    it('M3：显式传别家店的 couponId → 400，且不建单、不核销', async () => {
      const a = await createMerchant(app, prisma);
      const b = await createMerchant(app, prisma);
      const skuOfB = await publishSku(b.token, 'B 店的商品 2', 1000);
      await stockIn(b.token, skuOfB, 10);
      const customerOfB = await registerCustomer(b.subdomain);
      const addressOfB = await createAddress(customerOfB.token);

      const couponOfA = await createCoupon(a.token, {
        value: 1000,
        minAmount: 0,
      });
      // ⚠️ **伪造一条指向 A 店券的领取记录**（落在 B 店的租户下）：
      // 这是「别家店的券落到别人手里」的最坏形态。
      // 服务端必须靠租户作用域把 A 店的券挡住——**不能**因为
      // 「有一条领取记录指向它」就当它可用。
      await asTenant(b.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: b.tenantId,
            couponId: couponOfA.id,
            customerId: customerOfB.userId,
            quantity: 1,
          },
        }),
      );

      const response = await placeOrder(customerOfB.token, {
        addressId: addressOfB,
        items: [{ skuId: skuOfB, quantity: 1 }],
        couponId: couponOfA.id,
      });

      // ⚠️ 具体的断言：400「优惠券不可用」，**不是** 5xx、也不是「默默不打折」
      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('优惠券不可用');

      // ⚠️ 查库确认：B 店没有订单，A 店的券没有被核销
      const ordersOfB = await asTenant(b.tenantId, () =>
        prisma.order.findMany({ where: { customerId: customerOfB.userId } }),
      );
      expect(ordersOfB).toHaveLength(0);
      const redemptions = await readRedemptions(a.tenantId, couponOfA.id);
      expect(redemptions).toHaveLength(0);
    });

    it('M3：平台券在任意店铺可用', async () => {
      const a = await createMerchant(app, prisma);
      const b = await createMerchant(app, prisma);
      const skuOfB = await publishSku(b.token, '用平台券的商品', 1000);
      await stockIn(b.token, skuOfB, 10);
      const customerOfB = await registerCustomer(b.subdomain);
      const addressOfB = await createAddress(customerOfB.token);

      // ⚠️ **平台券的 tenantId 指向平台租户**，与店铺券不同。
      // 这里直接用裸 client 造：裸 client 绕开租户扩展，
      // 正是「平台作用域写入必须显式带 tenantId」的形态。
      const platformCoupon = await rawPrisma.coupon.create({
        data: {
          tenantId: 'platform-tenant',
          code: `P-${unique()}`,
          name: '平台券',
          type: 'FIXED',
          value: 1000,
          minAmount: 0,
          scope: 'PLATFORM',
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 86_400_000),
        },
      });

      // B 店的消费者持有这张平台券（领取记录落在 B 店的租户下）
      await asTenant(b.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: b.tenantId,
            couponId: platformCoupon.id,
            customerId: customerOfB.userId,
            quantity: 1,
          },
        }),
      );

      const response = await placeOrder(customerOfB.token, {
        addressId: addressOfB,
        items: [{ skuId: skuOfB, quantity: 1 }],
        couponId: platformCoupon.id,
      }).expect(201);

      const order = orderBody(response);
      expect(order.originalAmount).toBe(1000);
      expect(order.couponDiscountAmount).toBe(1000);
      expect(order.totalAmount).toBe(0);
      expect(order.couponId).toBe(platformCoupon.id);
      expect(order.couponName).toBe('平台券');

      // A 店不参与这次下单：A 店没有订单
      const ordersOfA = await asTenant(a.tenantId, () =>
        prisma.order.findMany(),
      );
      expect(ordersOfA).toHaveLength(0);
    });
  });

  // ============================================================
  // M5：同一张券不被两笔订单同时用
  // ============================================================

  describe('M5：同一张券不被两笔订单同时用', () => {
    it('M5：券被一张订单占用后，不能被另一张订单用', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(
        merchant.token,
        '一张券两单的商品名',
        1000,
      );
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const first = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);
      expect(orderBody(first).totalAmount).toBe(0);

      const second = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      });

      // ⚠️ 具体的断言：不是 5xx，而是 409「该券已被使用」
      expect(second.status).toBe(409);
      expect(errorText(second)).toContain('券');

      // ⚠️ 查库：核销记录仍然只有 1 行
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RESERVED');
    });

    it('M5：并发用同一张券下单：只有一个订单成功，另一个 409', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '并发用券的商品', 1000);
      await stockIn(merchant.token, skuId, 20);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      // ⚠️ 必须**真的并发**：Promise.all，不能先 await A 再 await B
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          placeOrder(customer.token, {
            addressId,
            items: [{ skuId, quantity: 1 }],
            couponId: coupon.id,
          }),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(4);

      // ⚠️ **查库**（不是可选的）：两个订单都成功时响应体看着完全正常，
      // 只有查核销记录的行数才发现券被用了两次。
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RESERVED');

      // 订单也只建了一笔
      const orders = await asTenant(merchant.tenantId, () =>
        prisma.order.findMany({ where: { customerId: customer.userId } }),
      );
      expect(orders).toHaveLength(1);
    });

    it('M5：并发预占同一张券 → 撞部分唯一索引的那个被转成 409', async () => {
      // ⚠️ **这条直调核销服务**，绕开「候选券查询」那一层。
      //
      // 为什么要有这条：下单流程里，候选券的查询**先**把已占住的券排除掉了，
      // 所以「两个事务同时把同一张券占住」这件事在真实下单路径里
      // 几乎不会发生——实测把三处护栏一起拆掉才逼出这条路径。
      // 但它**必须**存在：部分唯一索引 `coupon_redemptions_coupon_active_uniq`
      // 才是并发闸门，撞索引时必须转 409 而不是 500。
      //
      // ⚠️ **两个事务真正并发**：各自 `updateMany` 加计数后，
      // 一个先插核销记录、另一个撞唯一索引。
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const results = await asTenant(merchant.tenantId, () =>
        Promise.all(
          ['order-a', 'order-b'].map((orderId) =>
            prisma.$transaction(async (tx) => {
              await couponRedemption.reserveInTx(tx, {
                tenantId: merchant.tenantId,
                couponId: coupon.id,
                customerId: customer.userId,
                orderId,
                discountAmount: 1000,
                scope: 'SHOP',
              });
              return 'ok';
            }),
          ),
        ),
      ).catch((error: unknown) => error);

      // ⚠️ 一个成功、一个 409（ConflictException）
      expect(results).toBeInstanceOf(Error);
      const error = results as { status?: number; message?: unknown };
      expect(error.status).toBe(409);
      expect(String(error.message)).toContain('该券已被使用');

      // ⚠️ 查库：只有一条 RESERVED 核销记录
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RESERVED');
    });
  });

  // ============================================================
  // M6：优惠不绕过金额校验
  // ============================================================

  describe('M6：实付不为负', () => {
    it('M6：券面额大于订单金额时，实付为 0 而不是负数', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '券比货贵的商品', 300);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 10_000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);

      const order = orderBody(response);
      expect(order.originalAmount).toBe(300);
      expect(order.couponDiscountAmount).toBe(300);
      expect(order.totalAmount).toBe(0);
      expect(order.totalAmount).toBeGreaterThanOrEqual(0);
    });

    it('M6：活动减免也不会把实付减成负数', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '活动比货贵的商品', 300);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      await createPromotion(merchant.token, {
        discountAmount: 10_000,
        minAmount: 0,
      });

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
      }).expect(201);

      const order = orderBody(response);
      expect(order.originalAmount).toBe(300);
      expect(order.promotionDiscountAmount).toBe(300);
      expect(order.totalAmount).toBe(0);
      expect(order.totalAmount).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================
  // M12：历史订单不被重算
  // ============================================================

  describe('M12：历史订单是快照', () => {
    it('M12：改了券的规则后，历史订单金额不变', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '改券规则前的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const placed = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);
      expect(orderBody(placed).totalAmount).toBe(1000);

      // 商家把面额改成 5000
      await http(app)
        .patch(`/api/v1/merchant/coupons/${coupon.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ value: 5000 })
        .expect(200);

      // 再读订单：金额不变
      const detail = await http(app)
        .get(`/api/v1/orders/${orderBody(placed).orderNo}`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);
      const reread = orderBody(detail);
      expect(reread.totalAmount).toBe(1000);
      expect(reread.originalAmount).toBe(2000);
      expect(reread.couponDiscountAmount).toBe(1000);
    });

    it('M12：订单里的券名与券码是快照', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '改券名的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        name: '原来的名字',
      });
      await claimCoupon(customer.token, coupon.id);

      const placed = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);
      expect(orderBody(placed).couponName).toBe('原来的名字');
      expect(orderBody(placed).couponCode).toBe(coupon.code);

      // 商家改名
      await http(app)
        .patch(`/api/v1/merchant/coupons/${coupon.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '改过的名字' })
        .expect(200);

      const detail = await http(app)
        .get(`/api/v1/orders/${orderBody(placed).orderNo}`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(orderBody(detail).couponName).toBe('原来的名字');
    });
  });

  // ============================================================
  // M16：活动与券的叠加顺序
  // ============================================================

  describe('M16：活动与券叠加', () => {
    it('M16：活动与券叠加，活动先、券后', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '活动加券的商品', 10_000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const promotion = await createPromotion(merchant.token, {
        minAmount: 0,
        discountAmount: 2000,
      });
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);

      const order = orderBody(response);
      expect(order.originalAmount).toBe(10_000);
      expect(order.promotionDiscountAmount).toBe(2000);
      expect(order.promotionId).toBe(promotion.id);
      expect(order.couponDiscountAmount).toBe(1000);
      // 活动先减 2000 → 8000；券再减 1000 → 7000
      expect(order.totalAmount).toBe(7000);
    });

    it('M16：券的门槛按「活动后金额」判定', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(
        merchant.token,
        '门槛按活动后判的商品',
        10_000,
      );
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      // 活动减 3000 → 7000；券门槛 8000 → 7000 < 8000 → 券不可用
      await createPromotion(merchant.token, {
        minAmount: 0,
        discountAmount: 3000,
      });
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 8000,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);

      const order = orderBody(response);
      expect(order.promotionDiscountAmount).toBe(3000);
      expect(order.couponDiscountAmount).toBe(0);
      expect(order.totalAmount).toBe(7000);
    });
  });

  // ============================================================
  // M14：核销计数与核销记录同步
  // ============================================================

  describe('M14：核销计数与核销记录同步', () => {
    it('M14：核销后券的 reservedCount 加 1，核销记录是 RESERVED', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '核销计数的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const placed = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);
      const order = orderBody(placed);

      // ⚠️ 查库断言（响应体里看不到计数）
      const couponRow = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: coupon.id } }),
      );
      expect(couponRow?.reservedCount).toBe(1);
      expect(couponRow?.usedCount).toBe(0);

      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RESERVED');
      // 核销记录的优惠额 = 订单里的券减免
      expect(redemptions[0].discountAmount).toBe(order.couponDiscountAmount);
      expect(redemptions[0].discountAmount).toBe(1000);
      // 核销记录指向这一笔订单
      expect(redemptions[0].orderId).toBe(order.id);
    });

    it('M14：没有用券的订单不产生核销记录', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(
        merchant.token,
        '不用券不核销的商品',
        2000,
      );
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        // ⚠️ **门槛不满足**（订单原价 2000 < 门槛 5000）：
        // 券在候选里，但引擎判它不适用 → 不用它 → 不产生核销记录。
        minAmount: 5000,
      });
      await claimCoupon(customer.token, coupon.id);

      await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
      }).expect(201);

      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(0);
      const couponRow = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: coupon.id } }),
      );
      expect(couponRow?.reservedCount).toBe(0);
    });

    it('M14：用户没选券但持有可用券 → 自动取最优（兜底路径）', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '自动取最优的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      // ⚠️ **没传 couponId** → 走「自动取最优」的兜底路径（计划 §4.5）
      const response = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
      }).expect(201);

      const order = orderBody(response);
      expect(order.couponDiscountAmount).toBe(1000);
      expect(order.totalAmount).toBe(1000);

      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RESERVED');
    });

    it('M14：核销失败时订单也不该建出来（同生共死）', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '同生共死的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      // 先用这张券下一单（占用住）
      await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      }).expect(201);

      // 第二单用同一张券 → 409，且**不应**留下第二笔订单
      const second = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      });
      expect(second.status).toBe(409);

      const orders = await asTenant(merchant.tenantId, () =>
        prisma.order.findMany({ where: { customerId: customer.userId } }),
      );
      expect(orders).toHaveLength(1);
      // 库存只被扣了一次
      const sku = await asTenant(merchant.tenantId, () =>
        prisma.sku.findFirst({ where: { id: skuId } }),
      );
      expect(sku?.stock).toBe(9);
    });
  });

  // ============================================================
  // M15：过期判定用数据库时钟
  // ============================================================

  describe('M15：有效期判定用数据库时钟', () => {
    /**
     * 把**应用进程**的时钟冻结到指定时刻。
     *
     * ⚠️ **为什么要冻**：本机上「数据库时钟」与「应用时钟」只差 1 毫秒，
     * 一张「刚好过期 1 秒」的券，用哪个时钟判结果都一样——
     * 失败注入时把 `dbNow` 换成 `new Date()`，测试**不会挂**（实测过）。
     * 冻到 2019 年之后，两个时钟差了 7 年，判定结果必然不同。
     *
     * ⚠️ **只替换 `Date`，不动定时器**：`jest.useFakeTimers()` 会把
     * setTimeout 等也接管，BullMQ 的 worker 会卡死。
     *
     * ⚠️ **静态成员要一并替换**（`now` / `parse` / `UTC`）：
     * BullMQ 的 `waitForRateLimit` 会调 `Date.now()`，
     * 少了它会在 app.close() 时抛 `Date.now is not a function`。
     */
    function freezeAppClock(at: Date): () => void {
      const RealDate = Date;
      const frozen = at.getTime();
      class FrozenDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(frozen);
          } else {
            // @ts-expect-error —— 透传给 Date 的构造签名（可变参数）
            super(...args);
          }
        }
        static now(): number {
          return frozen;
        }
        static parse(...args: unknown[]): number {
          return RealDate.parse(...(args as [string]));
        }
        static UTC(...args: unknown[]): number {
          return RealDate.UTC(...(args as [number]));
        }
      }
      (global as unknown as { Date: DateConstructor }).Date =
        FrozenDate as unknown as DateConstructor;
      return () => {
        (global as unknown as { Date: DateConstructor }).Date = RealDate;
      };
    }

    afterEach(() => {
      (global as unknown as { Date: DateConstructor }).Date = Date;
    });

    it('券的窗口横跨两个时钟：数据库钟说有效、应用钟说未开始 → 用得上券', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(
        merchant.token,
        '横跨两个时钟的商品',
        2000,
      );
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      // 券的窗口：[2019-11-01, 2026-11-01)
      //   - 数据库钟（真实时间 ~2026-10）落在窗口**内** → 有效 → 用得上
      //   - 应用钟（冻到 2019-06）落在窗口**前** → 未开始 → 用不上
      // 两个时钟给出**不同**结果，所以这条用例能区分实现用的是哪一个。
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        name: '横跨两个时钟的券',
        startsAt: '2019-11-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
      });
      await claimCoupon(customer.token, coupon.id);

      const restore = freezeAppClock(new Date('2019-06-01T00:00:00.000Z'));
      try {
        const response = await placeOrder(customer.token, {
          addressId,
          items: [{ skuId, quantity: 1 }],
          couponId: coupon.id,
        }).expect(201);

        const order = orderBody(response);
        // ⚠️ 用的是**数据库钟**：券有效 → 优惠 1000
        expect(order.couponDiscountAmount).toBe(1000);
        expect(order.totalAmount).toBe(1000);
      } finally {
        restore();
      }
    });

    it('券的窗口全在数据库钟之前：数据库钟说已过期 → 用不上券', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(
        merchant.token,
        '数据库钟说过期的商品',
        2000,
      );
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      // 券的窗口：[2019-01-01, 2019-02-01)
      //   - 数据库钟（真实时间 ~2026-10）落在窗口**后** → 已过期 → 用不上
      // 这条与上一条合起来，才能唯一确定「已过期」与「未开始」两个分支
      // 都用数据库时钟判定：只实现「未开始」的话，上一条会挂、这条照样过。
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        name: '2019 年初的券',
        startsAt: '2019-01-01T00:00:00.000Z',
        endsAt: '2019-02-01T00:00:00.000Z',
      });
      // ⚠️ **过期券领不到**（领取也按数据库钟判有效期），
      // 所以直接落一条领取记录，构造「用户手里有一张已过期的券」的场景。
      await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: coupon.id,
            customerId: customer.userId,
            quantity: 1,
          },
        }),
      );

      const restore = freezeAppClock(new Date('2019-06-01T00:00:00.000Z'));
      try {
        // ⚠️ **不传 couponId**（走「自动取最优」的兜底路径）：
        // 显式指定一张过期的券会得到 400「优惠券不可用」，
        // 那样就分不清是「过期判定用哪个时钟」还是「显式指定被拒」。
        // 走自动路径，看到的是**券有没有被选中**——那才是时钟判定的结果。
        const response = await placeOrder(customer.token, {
          addressId,
          items: [{ skuId, quantity: 1 }],
        }).expect(201);

        const order = orderBody(response);
        // ⚠️ 券已过期 → 不参与优惠 → 实付 = 原价
        expect(order.couponDiscountAmount).toBe(0);
        expect(order.totalAmount).toBe(2000);
      } finally {
        restore();
      }
    });
  });
});
