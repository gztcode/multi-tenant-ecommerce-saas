import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 优惠预览接口（阶段 5a Task 6 的后端部分）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M15：活动/券的过期判定用数据库时钟
 * - 护栏 M16：活动与券的叠加顺序（活动先、券后），门槛按「活动后金额」判
 * - 护栏 M17：前端展示的是**估算值**，实付以下单时服务端算出的为准
 *
 * ## 为什么预览要放在后端
 *
 * ⚠️ **券的减免额不等于券的面额**：
 * 面额会被封顶（`min(coupon.value, 活动后金额)`），
 * 门槛也是按**活动后金额**判的（`afterPromotion < coupon.minAmount` 就不满足）。
 * 前端自己算就要把引擎的逻辑复制一份，两处必然漂移。
 * 所以预览由后端用**已有的纯函数引擎**算，前端只负责展示。
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

interface PromotionBody {
  id: string;
  name: string;
  minAmount: number;
  discountAmount: number;
}

/** 预览里单张券的减免情况 */
interface PreviewCouponBody {
  id: string;
  code: string;
  name: string;
  type: string;
  value: number;
  minAmount: number;
  discountAmount: number;
  payableAmount: number;
}

/** 预览接口的响应体 */
interface PreviewBody {
  originalAmount: number;
  promotionDiscountAmount: number;
  promotionName: string | null;
  coupons: PreviewCouponBody[];
  bestCouponId: string | null;
  bestCouponDiscountAmount: number;
  payableAmount: number;
}

/** 我的券的响应体（多了两个每用户状态的字段） */
interface MyCouponBody {
  id: string;
  code: string;
  used: boolean;
  claimedQuantity: number;
}

interface MyCouponListBody {
  items: MyCouponBody[];
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function couponBody(response: { body: unknown }): CouponBody {
  return response.body as CouponBody;
}

function promotionBody(response: { body: unknown }): PromotionBody {
  return response.body as PromotionBody;
}

function previewBody(response: { body: unknown }): PreviewBody {
  return response.body as PreviewBody;
}

function myCouponListBody(response: { body: unknown }): MyCouponListBody {
  return response.body as MyCouponListBody;
}

/** 把错误响应里的 message 摊平成一段文本，便于断言包含某个关键词 */
function errorText(response: { body: unknown }): string {
  const body = response.body as { message: string | string[] };
  const message = body.message;
  return Array.isArray(message) ? message.join('; ') : message;
}

describe('优惠预览与我的券的每用户状态 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  /**
   * 裸 PrismaClient：绕开租户扩展，用来读**数据库时钟**。
   *
   * ⚠️ TenantPrismaService 上没有 `$queryRaw`（阶段 1 刻意摘掉的），
   * 而「数据库的 now()」正是 M15 要锁住的东西，只能从裸 client 取。
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
    rawPrisma = new PrismaClient();
  });

  afterAll(async () => {
    await rawPrisma.$disconnect();
    await app.close();
  });

  /** 数据库的当前时间（M15 的单一事实来源） */
  async function databaseNow(): Promise<Date> {
    const rows = await rawPrisma.$queryRaw<Array<{ now: Date }>>`
      SELECT now() as now
    `;
    return rows[0].now;
  }

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
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
  ): Promise<PromotionBody> {
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
    return promotionBody(response);
  }

  /** 消费者领券 */
  async function claimCoupon(token: string, couponId: string): Promise<void> {
    await http(app)
      .post('/api/v1/coupons/claim')
      .set('authorization', `Bearer ${token}`)
      .send({ couponId })
      .expect(200);
  }

  /** 调预览接口 */
  function preview(token: string, originalAmount: number) {
    return http(app)
      .get('/api/v1/coupons/preview')
      .set('authorization', `Bearer ${token}`)
      .query({ originalAmount });
  }

  // ============================================================
  // 预览：活动减免
  // ============================================================

  describe('预览的「活动减」', () => {
    it('活动减与活动配置的减免额一致', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const promotion = await createPromotion(merchant.token, {
        name: '满 100 减 20',
        minAmount: 10_000,
        discountAmount: 2000,
      });

      const response = await preview(customer.token, 10_000).expect(200);
      const body = previewBody(response);

      // ⚠️ 具体的断言：活动配置的减免额原样出现在预览里
      expect(body.promotionDiscountAmount).toBe(promotion.discountAmount);
      expect(body.promotionDiscountAmount).toBe(2000);
      expect(body.promotionName).toBe(promotion.name);
      expect(body.originalAmount).toBe(10_000);
      // 没有券 → 实付 = 原价 - 活动减
      expect(body.payableAmount).toBe(8000);
      expect(body.bestCouponId).toBeNull();
      expect(body.bestCouponDiscountAmount).toBe(0);
    });

    it('没有生效的活动：活动减为 0，promotionName 为 null', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const response = await preview(customer.token, 10_000).expect(200);
      const body = previewBody(response);

      expect(body.promotionDiscountAmount).toBe(0);
      expect(body.promotionName).toBeNull();
      expect(body.payableAmount).toBe(10_000);
    });

    it('活动门槛不满足：活动减为 0（promotionName 仍是命中的活动名）', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      await createPromotion(merchant.token, {
        minAmount: 10_000,
        discountAmount: 2000,
      });

      // 原价 5000 < 门槛 10000 → 活动不生效
      const response = await preview(customer.token, 5000).expect(200);
      const body = previewBody(response);

      expect(body.promotionDiscountAmount).toBe(0);
      expect(body.payableAmount).toBe(5000);
    });
  });

  // ============================================================
  // 预览：券的减免与「最优」
  // ============================================================

  describe('预览的「券减」与最优券', () => {
    it('门槛不满足的券出现在列表里，但 discountAmount 为 0', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      // 门槛 10000，原价 5000 → 券不可用
      const coupon = await createCoupon(merchant.token, {
        name: '满 100 减 10',
        value: 1000,
        minAmount: 10_000,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await preview(customer.token, 5000).expect(200);
      const body = previewBody(response);

      // ⚠️ **不能把它从候选里悄悄去掉**——前端要显示它「不可用」
      expect(body.coupons).toHaveLength(1);
      expect(body.coupons[0].id).toBe(coupon.id);
      expect(body.coupons[0].discountAmount).toBe(0);
      expect(body.coupons[0].payableAmount).toBe(5000);
      // 门槛不满足的券不参与「取最优」
      expect(body.bestCouponId).toBeNull();
      expect(body.bestCouponDiscountAmount).toBe(0);
      expect(body.payableAmount).toBe(5000);
    });

    it('已核销的券不在 coupons 里', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const used = await createCoupon(merchant.token, {
        name: '已核销的券',
        value: 1000,
        minAmount: 0,
      });
      const kept = await createCoupon(merchant.token, {
        name: '还���用的券',
        value: 500,
        minAmount: 0,
      });
      await claimCoupon(customer.token, used.id);
      await claimCoupon(customer.token, kept.id);

      // ⚠️ 手工落一条 RESERVED 核销记录（模拟「下单预占住了」）
      await asTenant(merchant.tenantId, () =>
        prisma.couponRedemption.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: used.id,
            customerId: customer.userId,
            orderId: 'order-1',
            status: 'RESERVED',
            discountAmount: 1000,
          },
        }),
      );

      const response = await preview(customer.token, 5000).expect(200);
      const body = previewBody(response);

      const ids = body.coupons.map((c) => c.id);
      expect(ids).not.toContain(used.id);
      expect(ids).toContain(kept.id);
      // ⚠️ 最优也必须跳过已核销的券
      expect(body.bestCouponId).toBe(kept.id);
      expect(body.bestCouponDiscountAmount).toBe(500);
    });

    it('bestCouponId 是折后总价最小的那张券；payableAmount 等于原价 - 活动减 - 券减', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      // 活动减 3000 → 活动后 7000
      await createPromotion(merchant.token, {
        minAmount: 0,
        discountAmount: 3000,
      });
      // 两张都能用的券：面额 1000 与 2000
      const small = await createCoupon(merchant.token, {
        name: '小券',
        value: 1000,
        minAmount: 0,
      });
      const big = await createCoupon(merchant.token, {
        name: '大券',
        value: 2000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, small.id);
      await claimCoupon(customer.token, big.id);

      const response = await preview(customer.token, 10_000).expect(200);
      const body = previewBody(response);

      expect(body.promotionDiscountAmount).toBe(3000);
      expect(body.coupons).toHaveLength(2);

      const smallRow = body.coupons.find((c) => c.id === small.id);
      const bigRow = body.coupons.find((c) => c.id === big.id);
      expect(smallRow?.discountAmount).toBe(1000);
      expect(smallRow?.payableAmount).toBe(6000);
      expect(bigRow?.discountAmount).toBe(2000);
      expect(bigRow?.payableAmount).toBe(5000);

      // ⚠️ 最优 = 折后总价最小的那张（5000 < 6000）
      expect(body.bestCouponId).toBe(big.id);
      expect(body.bestCouponDiscountAmount).toBe(2000);
      // ⚠️ 实付 = 原价 - 活动减 - 券减 = 10000 - 3000 - 2000
      expect(body.payableAmount).toBe(5000);
      expect(body.payableAmount).toBe(
        body.originalAmount -
          body.promotionDiscountAmount -
          body.bestCouponDiscountAmount,
      );
    });

    it('券的门槛按「活动后金额」判定（活动后不够门槛 → 券不可用）', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      // 活动减 3000 → 活动后 7000；券门槛 8000 → 7000 < 8000 → 不可用
      await createPromotion(merchant.token, {
        minAmount: 0,
        discountAmount: 3000,
      });
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 8000,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await preview(customer.token, 10_000).expect(200);
      const body = previewBody(response);

      expect(body.promotionDiscountAmount).toBe(3000);
      expect(body.coupons).toHaveLength(1);
      expect(body.coupons[0].discountAmount).toBe(0);
      expect(body.bestCouponId).toBeNull();
      expect(body.payableAmount).toBe(7000);
    });

    it('券面额大于活动后金额：减免被封顶到活动后金额，实付为 0', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, {
        value: 10_000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const response = await preview(customer.token, 300).expect(200);
      const body = previewBody(response);

      // ⚠️ 封顶（M10）：优惠额不能超过原价
      expect(body.coupons[0].discountAmount).toBe(300);
      expect(body.coupons[0].payableAmount).toBe(0);
      expect(body.bestCouponDiscountAmount).toBe(300);
      expect(body.payableAmount).toBe(0);
      expect(body.payableAmount).toBeGreaterThanOrEqual(0);
    });

    it('没有券时：coupons 为空数组，最优券为 null', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const response = await preview(customer.token, 3000).expect(200);
      const body = previewBody(response);

      expect(body.coupons).toEqual([]);
      expect(body.bestCouponId).toBeNull();
      expect(body.bestCouponDiscountAmount).toBe(0);
      expect(body.payableAmount).toBe(3000);
    });

    it('平台券也在预览的候选里（平台作用域查询）', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      // ⚠️ **平台券的 tenantId 指向平台租户**：
      // 租户作用域的 `coupon.findMany` 查不到它，必须走平台作用域。
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
      // 领取记录落在**当前租户**下
      await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: platformCoupon.id,
            customerId: customer.userId,
            quantity: 1,
          },
        }),
      );

      const response = await preview(customer.token, 5000).expect(200);
      const body = previewBody(response);

      expect(body.coupons).toHaveLength(1);
      expect(body.coupons[0].id).toBe(platformCoupon.id);
      expect(body.coupons[0].discountAmount).toBe(1000);
      expect(body.bestCouponId).toBe(platformCoupon.id);
      expect(body.payableAmount).toBe(4000);
    });
  });

  // ============================================================
  // 预览是只读的
  // ============================================================

  describe('预览不做写操作', () => {
    it('调用前后券的 claimedCount / reservedCount / usedCount 都不变', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
      });
      await claimCoupon(customer.token, coupon.id);

      const before = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: coupon.id } }),
      );

      const response = await preview(customer.token, 5000).expect(200);
      expect(previewBody(response).bestCouponId).toBe(coupon.id);

      const after = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: coupon.id } }),
      );

      expect(after?.claimedCount).toBe(before?.claimedCount);
      expect(after?.reservedCount).toBe(before?.reservedCount);
      expect(after?.usedCount).toBe(before?.usedCount);
      // ⚠️ 领取的计数本身也没被预览改动
      expect(after?.claimedCount).toBe(1);
      expect(after?.reservedCount).toBe(0);
      expect(after?.usedCount).toBe(0);

      // ⚠️ 没有产生任何核销记录（预览不预占）
      const redemptions = await asTenant(merchant.tenantId, () =>
        prisma.couponRedemption.findMany({ where: { couponId: coupon.id } }),
      );
      expect(redemptions).toHaveLength(0);
    });
  });

  // ============================================================
  // 参数校验
  // ============================================================

  describe('预览的参数校验', () => {
    it('originalAmount 传非整数 → 400', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const response = await http(app)
        .get('/api/v1/coupons/preview')
        .set('authorization', `Bearer ${customer.token}`)
        .query({ originalAmount: '12.5' });

      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('originalAmount');
    });

    it('originalAmount 传负数 → 400', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const response = await http(app)
        .get('/api/v1/coupons/preview')
        .set('authorization', `Bearer ${customer.token}`)
        .query({ originalAmount: -1 });

      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('originalAmount');
    });

    it('originalAmount 缺失 → 400', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const response = await http(app)
        .get('/api/v1/coupons/preview')
        .set('authorization', `Bearer ${customer.token}`);

      expect(response.status).toBe(400);
      expect(errorText(response)).toContain('originalAmount');
    });

    it('预览必须登录：401', async () => {
      const merchant = await createMerchant(app, prisma);

      await http(app)
        .get('/api/v1/coupons/preview')
        .set('x-tenant-subdomain', merchant.subdomain)
        .query({ originalAmount: 1000 })
        .expect(401);
    });
  });

  // ============================================================
  // M15：过期判定用数据库时钟
  // ============================================================

  describe('M15：过期判定用数据库时钟', () => {
    /**
     * 把**应用进程**的时钟冻结到指定时刻。
     *
     * ⚠️ **为什么要冻**：本机上「数据库时钟」与「应用时钟」只差 1 毫秒，
     * 一张「刚好过期 1 秒」的券，用哪个时钟判结果都一样——
     * 失败注入时把 `dbNow` 换成 `new Date()`，测试**不会挂**（实测过）。
     * 冻到 2019 年之后，两个时钟差了 7 年，判定结果必然不同。
     *
     * ⚠️ **只替换 `Date`，不动定时器**：
     * `jest.useFakeTimers()` 会把 setTimeout 等也接管，
     * BullMQ 的 worker 会卡死。
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

    it('券的窗口横跨两个时钟：数据库钟说有效 → 预览里它可用', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      // 券的窗口：[2019-11-01, 2026-11-01)
      //   - 数据库钟（真实时间 ~2026-10）落在窗口**内** → 有效
      //   - 应用钟（冻到 2019-06）落在窗口**前** → 未开始
      const coupon = await createCoupon(merchant.token, {
        name: '横跨两个时钟的券',
        value: 1000,
        minAmount: 0,
        startsAt: '2019-11-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
      });
      await claimCoupon(customer.token, coupon.id);

      const restore = freezeAppClock(new Date('2019-06-01T00:00:00.000Z'));
      try {
        const response = await preview(customer.token, 5000).expect(200);
        const body = previewBody(response);

        // ⚠️ 用的是**数据库钟**：券有效 → 减 1000
        expect(body.coupons).toHaveLength(1);
        expect(body.coupons[0].discountAmount).toBe(1000);
        expect(body.bestCouponId).toBe(coupon.id);
        expect(body.payableAmount).toBe(4000);
      } finally {
        restore();
      }
    });

    it('券的窗口全在数据库钟之前：数据库钟说已过期 → 预览里它不可用', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, {
        name: '2019 年初的券',
        value: 1000,
        minAmount: 0,
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
        const response = await preview(customer.token, 5000).expect(200);
        const body = previewBody(response);

        // ⚠️ 券已过期 → 不在候选里 → 没有任何券可用
        expect(body.coupons).toHaveLength(0);
        expect(body.bestCouponId).toBeNull();
        expect(body.payableAmount).toBe(5000);
      } finally {
        restore();
      }
    });

    it('以数据库当前时间为基准，endsAt 刚过 1 秒的券不可用', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const dbNow = await databaseNow();
      const coupon = await createCoupon(merchant.token, {
        value: 1000,
        minAmount: 0,
        startsAt: new Date(dbNow.getTime() - 3600_000).toISOString(),
        endsAt: new Date(dbNow.getTime() - 1000).toISOString(),
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

      const response = await preview(customer.token, 5000).expect(200);
      expect(previewBody(response).coupons).toHaveLength(0);
    });
  });

  // ============================================================
  // 我的券：每用户状态
  // ============================================================

  describe('我的券的每用户状态', () => {
    it('未核销的券：used 为 false，claimedQuantity 是领取张数', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, { value: 1000 });
      await claimCoupon(customer.token, coupon.id);

      const response = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const items = myCouponListBody(response).items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(coupon.id);
      expect(items[0].used).toBe(false);
      expect(items[0].claimedQuantity).toBe(1);
    });

    it('领了多张：claimedQuantity 是张数之和', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, { value: 1000 });
      await claimCoupon(customer.token, coupon.id);
      await claimCoupon(customer.token, coupon.id);

      const response = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const items = myCouponListBody(response).items;
      expect(items[0].claimedQuantity).toBe(2);
      expect(items[0].used).toBe(false);
    });

    it('已核销（RESERVED）的券：used 为 true', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, { value: 1000 });
      await claimCoupon(customer.token, coupon.id);

      await asTenant(merchant.tenantId, () =>
        prisma.couponRedemption.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: coupon.id,
            customerId: customer.userId,
            orderId: 'order-1',
            status: 'RESERVED',
            discountAmount: 1000,
          },
        }),
      );

      const response = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const items = myCouponListBody(response).items;
      expect(items[0].used).toBe(true);
      expect(items[0].claimedQuantity).toBe(1);
    });

    it('已释放（RELEASED）的券：used 为 false（额度已退回）', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, { value: 1000 });
      await claimCoupon(customer.token, coupon.id);

      await asTenant(merchant.tenantId, () =>
        prisma.couponRedemption.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: coupon.id,
            customerId: customer.userId,
            orderId: 'order-1',
            status: 'RELEASED',
            discountAmount: 1000,
          },
        }),
      );

      const response = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const items = myCouponListBody(response).items;
      expect(items[0].used).toBe(false);
    });

    it('别人的核销不影响这个用户的 used', async () => {
      const merchant = await createMerchant(app, prisma);
      const a = await registerCustomer(merchant.subdomain);
      const b = await registerCustomer(merchant.subdomain);
      const coupon = await createCoupon(merchant.token, { value: 1000 });
      await claimCoupon(a.token, coupon.id);
      await claimCoupon(b.token, coupon.id);

      // 只有 A 的核销记录
      await asTenant(merchant.tenantId, () =>
        prisma.couponRedemption.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: coupon.id,
            customerId: a.userId,
            orderId: 'order-1',
            status: 'USED',
            discountAmount: 1000,
          },
        }),
      );

      const responseA = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${a.token}`)
        .expect(200);
      expect(myCouponListBody(responseA).items[0].used).toBe(true);

      const responseB = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${b.token}`)
        .expect(200);
      expect(myCouponListBody(responseB).items[0].used).toBe(false);
    });

    it('平台券也在「我的券」里，且能查到每用户状态', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

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
      // 领取记录落在**当前租户**下
      await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: platformCoupon.id,
            customerId: customer.userId,
            quantity: 2,
          },
        }),
      );
      // ⚠️ **核销记录的 tenantId 是「下单的那家店」**（不是券的租户）：
      // 所以平台券的核销记录也在当前租户下，租户作用域内查就能查到。
      await asTenant(merchant.tenantId, () =>
        prisma.couponRedemption.create({
          data: {
            tenantId: merchant.tenantId,
            couponId: platformCoupon.id,
            customerId: customer.userId,
            orderId: 'order-1',
            status: 'USED',
            discountAmount: 1000,
          },
        }),
      );

      const response = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const items = myCouponListBody(response).items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(platformCoupon.id);
      expect(items[0].used).toBe(true);
      expect(items[0].claimedQuantity).toBe(2);
    });
  });
});
