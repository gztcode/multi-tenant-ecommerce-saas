import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { OrderTimeoutWorker } from '../src/modules/order/order-timeout.worker';
import type { OrderTimeoutJob } from '../src/modules/order/order-timeout.service';
import { CouponRedemptionService } from '../src/modules/coupon/coupon-redemption.service';
import type { Job } from 'bullmq';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 取消 / 支付超时时释放券的核销（阶段 5a Task 5）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M8：订单取消时券被释放（释放与改状态**同一事务**；取消后券能再次使用）
 * - 护栏 M9：订单超时关闭时券被释放（**两个路径调用同一个释放函数**）
 * - 护栏 M12：历史订单不被重算（退款后优惠快照不变）
 * - 护栏 M13：退款金额与实付相符（退的是实付额，不重算优惠）
 * - 护栏 M14：核销计数与核销记录同步（reservedCount / usedCount 对得上）
 *
 * ## 断言一律查库
 *
 * 「券被释放了」在响应体里**看不出来**——取消接口返回的是空体。
 * 必须查 `coupon_redemptions` 的 status 与 `coupons` 的两个计数字段。
 */

/** 假网关的共享密钥。测试里显式设置，确保与实现读到的是同一个值。 */
const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';
/** 假网关的渠道名（发起支付时用） */
const FAKE_CHANNEL = 'fake';

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
  status: string;
  totalAmount: number;
  originalAmount: number;
  couponDiscountAmount: number;
  couponId: string | null;
  couponCode: string | null;
  couponName: string | null;
}

interface RedemptionRow {
  id: string;
  couponId: string;
  orderId: string;
  status: string;
  discountAmount: number;
}

interface CouponCountRow {
  reservedCount: number;
  usedCount: number;
  claimedCount: number;
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

describe('取消 / 超时时释放券的核销 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let timeoutWorker: OrderTimeoutWorker;
  let couponRedemption: CouponRedemptionService;
  /**
   * 裸 PrismaClient：绕开租户扩展，用来造平台券、读平台券的计数。
   */
  let rawPrisma: PrismaClient;

  beforeAll(async () => {
    // ⚠️ 假网关的开关与密钥必须在 AppModule 加载**之前**设好：
    // BullModule.forRoot 与 provider 的构造都在模块求值时发生。
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;

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
    timeoutWorker = app.get(OrderTimeoutWorker);
    couponRedemption = app.get(CouponRedemptionService);
    rawPrisma = new PrismaClient();
  });

  afterAll(async () => {
    await rawPrisma.$disconnect();
    await app.close();
    delete process.env.FAKE_PAYMENT_ENABLED;
    delete process.env.FAKE_PAYMENT_SECRET;
  });

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  // ============================================================
  // 夹具
  // ============================================================

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

  /** 消费者领券 */
  async function claimCoupon(token: string, couponId: string): Promise<void> {
    await http(app)
      .post('/api/v1/coupons/claim')
      .set('authorization', `Bearer ${token}`)
      .send({ couponId })
      .expect(200);
  }

  /** 下单 */
  function placeOrder(
    token: string,
    payload: {
      addressId: string;
      items: Array<{ skuId: string; quantity: number }>;
      couponId?: string;
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
  ): Promise<RedemptionRow[]> {
    return asTenant(tenantId, () =>
      prisma.couponRedemption.findMany({
        where: { couponId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** 读券的三个计数字段（租户作用域内） */
  async function readCouponCounts(
    tenantId: string,
    couponId: string,
  ): Promise<CouponCountRow> {
    return asTenant(tenantId, async () => {
      const row = await prisma.coupon.findFirst({ where: { id: couponId } });
      return {
        reservedCount: row?.reservedCount ?? -1,
        usedCount: row?.usedCount ?? -1,
        claimedCount: row?.claimedCount ?? -1,
      };
    });
  }

  /** 读订单 */
  async function readOrder(
    tenantId: string,
    orderNo: string,
  ): Promise<{
    id: string;
    status: string;
    totalAmount: number;
    originalAmount: number;
    couponDiscountAmount: number;
    couponId: string | null;
    couponCode: string | null;
    couponName: string | null;
  }> {
    return asTenant(tenantId, async () => {
      const rows = await prisma.order.findMany({ where: { orderNo } });
      return rows[0];
    });
  }

  /** 把订单的支付期限改到**过去**（模拟「时间到了」） */
  async function expireOrder(tenantId: string, orderNo: string): Promise<void> {
    await asTenant(tenantId, () =>
      prisma.order.updateMany({
        where: { orderNo },
        data: { payExpiresAt: new Date(Date.now() - 60_000) },
      }),
    );
  }

  /** 造一个 worker 任务（worker 只读 name 与 data） */
  function timeoutJob(tenantId: string, orderId: string): Job<OrderTimeoutJob> {
    return {
      id: `test-${unique()}`,
      name: 'release',
      data: { tenantId, orderId },
    } as unknown as Job<OrderTimeoutJob>;
  }

  /** 等队列里的 webhook 任务被消费完（轮询订单状态） */
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

  /**
   * 下单用券，返回全套夹具。
   *
   * 默认面额 1000、单价 1000、数量 1 → 原价 1000、券减 1000、实付 0。
   * 实付为 0 会让支付路径很别扭（金额 0 的支付单），所以默认给数量 2
   * → 原价 2000、实付 1000。
   */
  async function placeOrderWithCoupon(options?: {
    quantity?: number;
    price?: number;
    value?: number;
  }): Promise<{
    merchant: Awaited<ReturnType<typeof createMerchant>>;
    customer: { token: string; userId: string };
    skuId: string;
    coupon: CouponBody;
    order: OrderBody;
  }> {
    const quantity = options?.quantity ?? 2;
    const price = options?.price ?? 1000;
    const value = options?.value ?? 1000;

    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '用券的商品', price);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);
    const coupon = await createCoupon(merchant.token, {
      value,
      minAmount: 0,
    });
    await claimCoupon(customer.token, coupon.id);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity }],
      couponId: coupon.id,
    }).expect(201);
    const order = orderBody(placed);

    return { merchant, customer, skuId, coupon, order };
  }

  // ============================================================
  // M8：取消订单时释放券的核销
  // ============================================================

  describe('M8：取消订单释放券', () => {
    it('M8：取消订单：核销转 RELEASED，reservedCount 减 1，券能再次使用', async () => {
      const { merchant, customer, skuId, coupon, order } =
        await placeOrderWithCoupon();

      // 下单后：核销是 RESERVED，reservedCount = 1
      const before = await readRedemptions(merchant.tenantId, coupon.id);
      expect(before).toHaveLength(1);
      expect(before[0].status).toBe('RESERVED');
      expect(
        (await readCouponCounts(merchant.tenantId, coupon.id)).reservedCount,
      ).toBe(1);

      // 取消订单
      await http(app)
        .post(`/api/v1/orders/${order.orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      // ⚠️ 查库：核销转 RELEASED、reservedCount 归 0
      const after = await readRedemptions(merchant.tenantId, coupon.id);
      expect(after).toHaveLength(1);
      expect(after[0].status).toBe('RELEASED');
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(0);

      // ⚠️ **M8 的核心断言**：同一张券能再次使用。
      // 券还占着的话，这里会拿到 409「该券已被使用」。
      const again = await placeOrder(customer.token, {
        addressId: await createAddress(customer.token),
        items: [{ skuId, quantity: 1 }],
        couponId: coupon.id,
      });
      expect(again.status).toBe(201);
      expect(orderBody(again).couponId).toBe(coupon.id);
    });

    it('M8：重复取消是安全的：reservedCount 不会减成 -1', async () => {
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      await http(app)
        .post(`/api/v1/orders/${order.orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      // ⚠️ 再取消一次：订单已是 CANCELLED，条件更新拦住
      const second = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`);
      expect(second.status).toBe(409);

      // ⚠️ 计数没被减成 -1
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(0);
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RELEASED');
    });

    it('M8：释放函数被重复调用：核销状态的条件更新拦住了第二次释放', async () => {
      // ⚠️ **这条直调释放函数**，绕开「订单状态的条件更新」那一层。
      //
      // 为什么要有这条：订单状态的条件更新（PENDING_PAYMENT → CANCELLED）
      // 确实能拦住「取消两次」，但它拦不住**释放函数本身**被重复调用——
      // 而释放函数是取消路径与超时路径**共用**的那一个（M9）。
      // 释放函数内部必须自己保证「只生效一次」：
      // 核销状态的条件更新（`where: { id, status: 'RESERVED' }`）。
      //
      // ⚠️ **这条是「重复释放是安全的」的真正兑现点**：
      // 把那个条件去掉，`reservedCount` 就会被减成 -1。
      const { merchant, coupon, order } = await placeOrderWithCoupon();

      const row = await readOrder(merchant.tenantId, order.orderNo);

      // 第一次释放
      await asTenant(merchant.tenantId, () =>
        prisma.$transaction((tx) => couponRedemption.releaseInTx(tx, row.id)),
      );
      expect(
        (await readCouponCounts(merchant.tenantId, coupon.id)).reservedCount,
      ).toBe(0);

      // ⚠️ 第二次释放（同一个订单）：必须什么都不做
      await asTenant(merchant.tenantId, () =>
        prisma.$transaction((tx) => couponRedemption.releaseInTx(tx, row.id)),
      );

      // ⚠️ 关键断言：reservedCount 没被减成 -1
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(0);
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RELEASED');
    });

    it('M8：释放与确认核销并发：只有一个生效（不会既释放又核销）', async () => {
      // ⚠️ 支付成功与取消/超时**互斥**靠的是订单状态的条件更新，
      // 但**核销层面的互斥**靠的是核销状态的条件更新：
      // 两条路径都从 RESERVED 出发，只有一条能改成终态。
      //
      // ⚠️ **这条直调两个核销函数**，绕开订单状态那一层。
      const { merchant, coupon, order } = await placeOrderWithCoupon();
      const row = await readOrder(merchant.tenantId, order.orderNo);

      const results = await asTenant(merchant.tenantId, () =>
        Promise.all([
          prisma.$transaction((tx) => couponRedemption.releaseInTx(tx, row.id)),
          prisma.$transaction((tx) =>
            couponRedemption.markUsedInTx(tx, row.id),
          ),
        ]),
      ).catch((error: unknown) => error);

      // ⚠️ 两条路径**不会都成功**：第二条会撞上「核销已不是 RESERVED」
      // 的条件更新（要么没命中、要么行锁等待后 count = 0）。
      // 断言「计数没有分叉」——这才是账务上真正要保的东西。
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);

      // ⚠️ 计数与核销记录必须一致（reservedCount + usedCount = 核销行数）
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount + counts.reservedCount).toBe(
        redemptions.filter(
          (r) => r.status === 'USED' || r.status === 'RESERVED',
        ).length,
      );
      // 核销记录只有一行，且是终态
      expect(redemptions).toHaveLength(1);
      expect(['RELEASED', 'USED']).toContain(redemptions[0].status);
      // 两种终态各自对应正确的计数
      if (redemptions[0].status === 'USED') {
        expect(counts.usedCount).toBe(1);
      } else {
        expect(counts.usedCount).toBe(0);
      }
      expect(results).toBeDefined();
    });

    it('M8：释放与改订单状态是同一个事务：释放失败时订单不能已经变成 CANCELLED', async () => {
      // ⚠️ **这条是 M8 的原子性兑现点**（设计文档 §5.1）。
      //
      // 失效形态（分成两个事务时）：订单先转成 CANCELLED，
      // 释放券的核销再失败 —— 而超时释放任务看到状态不是 PENDING_PAYMENT
      // 也不会再管它，那张券就**永久卡在预占里**，用户的券再也用不了。
      //
      // ⚠️ **这条不靠竞态**：直接让释放这一步**确定地**失败，
      // 从而稳定地抓住退化（阶段 3 的「超时释放是原子的」那条用例同款做法）。
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      // 让释放这一步失败（模拟锁超时、计数对不上等真实故障）
      const spy = jest
        .spyOn(couponRedemption, 'releaseInTx')
        .mockRejectedValue(new Error('模拟释放失败'));
      try {
        const response = await http(app)
          .post(`/api/v1/orders/${order.orderNo}/cancel`)
          .set('authorization', `Bearer ${customer.token}`);
        expect(response.status).toBe(500);
      } finally {
        spy.mockRestore();
      }

      // ⚠️ **关键断言**：状态**不能**是 CANCELLED。
      // 释放失败时订单必须还是 PENDING_PAYMENT。
      const row = await readOrder(merchant.tenantId, order.orderNo);
      expect(row.status).toBe('PENDING_PAYMENT');

      // ⚠️ 券还占着（没被释放），计数没变
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(1);
      expect(counts.usedCount).toBe(0);
    });
  });

  // ============================================================
  // M9：支付超时关闭时释放券的核销
  // ============================================================

  describe('M9：支付超时释放券', () => {
    it('M9：支付超时关闭：核销同样被释放', async () => {
      const { merchant, coupon, order } = await placeOrderWithCoupon();

      const row = await readOrder(merchant.tenantId, order.orderNo);
      await expireOrder(merchant.tenantId, order.orderNo);

      await timeoutWorker.process(timeoutJob(merchant.tenantId, row.id));

      // 订单转 CLOSED
      const after = await readOrder(merchant.tenantId, order.orderNo);
      expect(after.status).toBe('CLOSED');

      // ⚠️ 查库：核销转 RELEASED、reservedCount 归 0
      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RELEASED');
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(0);
    });

    it('M9：取消路径与超时路径的库内结果完全一致（共用同一个释放函数）', async () => {
      // ⚠️ 这条断言的是「两条路径的**结果**一致」。
      // 真正的兑现点在**实现上**：两条路径调用的是同一个函数
      // （`OrderService.releaseReservationInTx`），
      // 代码审查时确认只有一处实现。
      const cancelled = await placeOrderWithCoupon();
      const timedOut = await placeOrderWithCoupon();

      await http(app)
        .post(`/api/v1/orders/${cancelled.order.orderNo}/cancel`)
        .set('authorization', `Bearer ${cancelled.customer.token}`)
        .expect(200);

      const timedOutRow = await readOrder(
        timedOut.merchant.tenantId,
        timedOut.order.orderNo,
      );
      await expireOrder(timedOut.merchant.tenantId, timedOut.order.orderNo);
      await timeoutWorker.process(
        timeoutJob(timedOut.merchant.tenantId, timedOutRow.id),
      );

      const cancelRedemption = (
        await readRedemptions(cancelled.merchant.tenantId, cancelled.coupon.id)
      )[0];
      const timeoutRedemption = (
        await readRedemptions(timedOut.merchant.tenantId, timedOut.coupon.id)
      )[0];

      expect(cancelRedemption.status).toBe('RELEASED');
      expect(timeoutRedemption.status).toBe(cancelRedemption.status);

      const cancelCounts = await readCouponCounts(
        cancelled.merchant.tenantId,
        cancelled.coupon.id,
      );
      const timeoutCounts = await readCouponCounts(
        timedOut.merchant.tenantId,
        timedOut.coupon.id,
      );
      expect(timeoutCounts.reservedCount).toBe(cancelCounts.reservedCount);
      expect(timeoutCounts.usedCount).toBe(cancelCounts.usedCount);
      expect(cancelCounts.reservedCount).toBe(0);
    });
  });

  // ============================================================
  // 支付成功 → 核销转 USED
  // ============================================================

  describe('支付成功后核销转 USED', () => {
    it('支付成功后：核销转 USED，reservedCount 减 1，usedCount 加 1', async () => {
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      // 下单 → 核销 RESERVED
      const before = await readRedemptions(merchant.tenantId, coupon.id);
      expect(before[0].status).toBe('RESERVED');

      // 发起支付 + 假网关确认支付
      const payResponse = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/pay`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(201);
      const payment = payResponse.body as { paymentId: string };

      await http(app)
        .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
        .expect(200);

      const becamePaid = await waitFor(async () => {
        const rows = await readOrder(merchant.tenantId, order.orderNo);
        return rows.status === 'PAID';
      });
      expect(becamePaid).toBe(true);

      // ⚠️ 查库：核销转 USED，reservedCount = 0，usedCount = 1
      const after = await readRedemptions(merchant.tenantId, coupon.id);
      expect(after).toHaveLength(1);
      expect(after[0].status).toBe('USED');
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(1);
    });

    it('支付成功后订单不能再被取消：核销不会被释放成 RELEASED', async () => {
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      const payResponse = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/pay`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(201);
      const payment = payResponse.body as { paymentId: string };
      await http(app)
        .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
        .expect(200);
      const becamePaid = await waitFor(async () => {
        const rows = await readOrder(merchant.tenantId, order.orderNo);
        return rows.status === 'PAID';
      });
      expect(becamePaid).toBe(true);

      // 取消已支付的订单 → 409
      const cancel = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`);
      expect(cancel.status).toBe(409);

      // ⚠️ 核销仍然是 USED（没被释放），计数没变
      const after = await readRedemptions(merchant.tenantId, coupon.id);
      expect(after[0].status).toBe('USED');
      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(1);
    });
  });

  // ============================================================
  // M13 / M12：退款不重算优惠
  // ============================================================

  describe('M13 / M12：退款不重算优惠', () => {
    it('M13：退款额 = 实付额（已含优惠），不重算优惠', async () => {
      // 原价 2000（单价 1000 × 2），券减 1000 → 实付 1000
      const { merchant, customer, order } = await placeOrderWithCoupon();
      expect(order.originalAmount).toBe(2000);
      expect(order.couponDiscountAmount).toBe(1000);
      expect(order.totalAmount).toBe(1000);

      const payResponse = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/pay`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(201);
      const payment = payResponse.body as {
        paymentId: string;
        amount: number;
        channel: string;
      };
      // ⚠️ 支付金额是实付 1000，不是原价 2000
      expect(payment.amount).toBe(1000);
      expect(payment.channel).toBe(FAKE_CHANNEL);

      await http(app)
        .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
        .expect(200);
      const becamePaid = await waitFor(async () => {
        const rows = await readOrder(merchant.tenantId, order.orderNo);
        return rows.status === 'PAID';
      });
      expect(becamePaid).toBe(true);

      // 退款
      await http(app)
        .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ reason: '测试退款' })
        .expect(201);

      // ⚠️ 查库：退款额 = 实付额 1000（**不是**原价 2000）
      const payments = await asTenant(merchant.tenantId, () =>
        prisma.payment.findMany({ where: { orderId: order.id } }),
      );
      expect(payments[0].amount).toBe(1000);
      expect(payments[0].status).toBe('REFUNDED');

      // 订单的 totalAmount 仍是实付
      const after = await readOrder(merchant.tenantId, order.orderNo);
      expect(after.totalAmount).toBe(1000);
    });

    it('M12：退款后订单的优惠快照不变', async () => {
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      const payResponse = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/pay`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(201);
      const payment = payResponse.body as { paymentId: string };
      await http(app)
        .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
        .expect(200);
      const becamePaid = await waitFor(async () => {
        const rows = await readOrder(merchant.tenantId, order.orderNo);
        return rows.status === 'PAID';
      });
      expect(becamePaid).toBe(true);

      await http(app)
        .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ reason: '测试退款' })
        .expect(201);

      // ⚠️ 快照不变
      const after = await readOrder(merchant.tenantId, order.orderNo);
      expect(after.couponDiscountAmount).toBe(1000);
      expect(after.originalAmount).toBe(2000);
      expect(after.couponId).toBe(coupon.id);
      expect(after.couponCode).toBe(coupon.code);
      expect(after.couponName).toBe(coupon.name);
      expect(after.totalAmount).toBe(1000);
    });
  });

  // ============================================================
  // M14：计数与核销记录同步
  // ============================================================

  describe('M14：计数与核销记录数一致', () => {
    it('M14：下单 → 取消：reservedCount = 0、usedCount = 0、USED 行数为 0', async () => {
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      await http(app)
        .post(`/api/v1/orders/${order.orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(0);

      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions.filter((r) => r.status === 'USED')).toHaveLength(0);
      expect(redemptions.filter((r) => r.status === 'RESERVED')).toHaveLength(
        0,
      );
      expect(redemptions.filter((r) => r.status === 'RELEASED')).toHaveLength(
        1,
      );
    });

    it('M14：下单 → 支付：reservedCount = 0、usedCount = 1、USED 行数为 1', async () => {
      const { merchant, customer, coupon, order } =
        await placeOrderWithCoupon();

      const payResponse = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/pay`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(201);
      const payment = payResponse.body as { paymentId: string };
      await http(app)
        .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
        .expect(200);
      const becamePaid = await waitFor(async () => {
        const rows = await readOrder(merchant.tenantId, order.orderNo);
        return rows.status === 'PAID';
      });
      expect(becamePaid).toBe(true);

      const counts = await readCouponCounts(merchant.tenantId, coupon.id);
      expect(counts.reservedCount).toBe(0);
      expect(counts.usedCount).toBe(1);

      const redemptions = await readRedemptions(merchant.tenantId, coupon.id);
      expect(redemptions.filter((r) => r.status === 'USED')).toHaveLength(1);
      expect(redemptions.filter((r) => r.status === 'RESERVED')).toHaveLength(
        0,
      );
    });
  });

  // ============================================================
  // 平台券：领取路径 + 计数的租户归属
  // ============================================================

  describe('平台券', () => {
    /**
     * 造一张平台券。
     *
     * ⚠️ 平台券的 `tenantId` 指向平台租户，计数也在**那一行**上。
     * 租户作用域的 `updateMany` 改不到它——必须走平台作用域。
     */
    async function createPlatformCoupon(
      value = 1000,
    ): Promise<{ id: string; code: string; name: string }> {
      return rawPrisma.coupon.create({
        data: {
          tenantId: 'platform-tenant',
          code: `P-${unique()}`,
          name: '平台券',
          type: 'FIXED',
          value,
          minAmount: 0,
          scope: 'PLATFORM',
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 86_400_000),
        },
      });
    }

    it('平台券的领取路径存在：消费者能领到平台券并下单用掉', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '用平台券的商品', 1000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const platformCoupon = await createPlatformCoupon(1000);

      // ⚠️ **平台的领取路径**：消费者直接领平台券
      const claimed = await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: platformCoupon.id });
      expect(claimed.status).toBe(200);

      // 领取记录落在**当前租户**下
      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { customerId: customer.userId } }),
      );
      expect(claims).toHaveLength(1);
      expect(claims[0].couponId).toBe(platformCoupon.id);

      // 下单用掉它
      const placed = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: platformCoupon.id,
      }).expect(201);
      expect(orderBody(placed).couponDiscountAmount).toBe(1000);
      expect(orderBody(placed).totalAmount).toBe(0);
    });

    it('平台券出现在「可领的券」与「我的券」列表里', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const platformCoupon = await createPlatformCoupon(1000);

      // ⚠️ 「可领的券」：平台券对所有店铺生效，必须列出来
      const available = await http(app)
        .get('/api/v1/coupons/available')
        .set('x-tenant-subdomain', merchant.subdomain)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);
      const availableIds = (
        available.body as { items: Array<{ id: string }> }
      ).items.map((c) => c.id);
      expect(availableIds).toContain(platformCoupon.id);

      // 领了之后，「我的券」里也要有它
      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: platformCoupon.id })
        .expect(200);

      const mine = await http(app)
        .get('/api/v1/coupons/mine')
        .set('x-tenant-subdomain', merchant.subdomain)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);
      const mineIds = (mine.body as { items: Array<{ id: string }> }).items.map(
        (c) => c.id,
      );
      expect(mineIds).toContain(platformCoupon.id);
    });

    it('平台券的计数在平台行上：取消订单后 reservedCount 归 0', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '取消平台券的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const platformCoupon = await createPlatformCoupon(1000);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: platformCoupon.id })
        .expect(200);

      const placed = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: platformCoupon.id,
      }).expect(201);
      const order = orderBody(placed);

      // ⚠️ 平台券的计数在**平台租户的那一行**上：
      // 租户作用域的读根本看不到它，必须用裸 client 读。
      const row = await rawPrisma.coupon.findFirst({
        where: { id: platformCoupon.id },
      });
      expect(row?.reservedCount).toBe(1);
      expect(row?.usedCount).toBe(0);

      // 取消订单
      await http(app)
        .post(`/api/v1/orders/${order.orderNo}/cancel`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      // ⚠️ **关键断言**：平台券的 reservedCount 真的减回去了。
      // 释放路径若不分流（仍走租户作用域的 updateMany），
      // 这里会是 1 —— 券被永久占住。
      const after = await rawPrisma.coupon.findFirst({
        where: { id: platformCoupon.id },
      });
      expect(after?.reservedCount).toBe(0);
      expect(after?.usedCount).toBe(0);

      // 核销记录在**下单那家店**的租户下，状态是 RELEASED
      const redemptions = await readRedemptions(
        merchant.tenantId,
        platformCoupon.id,
      );
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].status).toBe('RELEASED');
    });

    it('平台券支付成功后：reservedCount 归 0、usedCount 加 1', async () => {
      const merchant = await createMerchant(app, prisma);
      const skuId = await publishSku(merchant.token, '付平台券的商品', 2000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);
      const platformCoupon = await createPlatformCoupon(1000);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: platformCoupon.id })
        .expect(200);

      const placed = await placeOrder(customer.token, {
        addressId,
        items: [{ skuId, quantity: 1 }],
        couponId: platformCoupon.id,
      }).expect(201);
      const order = orderBody(placed);

      const payResponse = await http(app)
        .post(`/api/v1/orders/${order.orderNo}/pay`)
        .set('authorization', `Bearer ${customer.token}`)
        .expect(201);
      const payment = payResponse.body as { paymentId: string };
      await http(app)
        .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
        .expect(200);
      const becamePaid = await waitFor(async () => {
        const rows = await readOrder(merchant.tenantId, order.orderNo);
        return rows.status === 'PAID';
      });
      expect(becamePaid).toBe(true);

      // ⚠️ 平台券的计数也走平台作用域
      const after = await rawPrisma.coupon.findFirst({
        where: { id: platformCoupon.id },
      });
      expect(after?.reservedCount).toBe(0);
      expect(after?.usedCount).toBe(1);
    });
  });
});
