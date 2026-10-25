import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { CouponService } from '../src/modules/coupon/coupon.service';
import type { CreateCouponDto } from '../src/modules/coupon/dto/create-coupon.dto';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 优惠券与满减活动的 e2e（阶段 5a Task 3）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M4：限额不被并发超发（条件更新，不是「先查后改」）
 * - 护栏 M7：平台券不被伪造（scope 由服务端按登录身份推导）
 * - 护栏 M14：领取计数与领取记录一致
 * - 护栏 M15：过期判定用数据库时钟，不用应用进程时钟
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

interface CouponBody {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: string;
  value: number;
  minAmount: number;
  perUserLimit: number | null;
  totalLimit: number | null;
  claimedCount: number;
  scope: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

interface PromotionBody {
  id: string;
  name: string;
  description: string | null;
  minAmount: number;
  discountAmount: number;
  status: string;
  startsAt: string;
  endsAt: string;
}

interface ClaimBody {
  couponId: string;
  quantity: number;
}

interface CouponListBody {
  items: CouponBody[];
}

interface PromotionListBody {
  items: PromotionBody[];
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function couponBody(response: { body: unknown }): CouponBody {
  return response.body as CouponBody;
}

function couponListBody(response: { body: unknown }): CouponListBody {
  return response.body as CouponListBody;
}

function promotionBody(response: { body: unknown }): PromotionBody {
  return response.body as PromotionBody;
}

function promotionListBody(response: { body: unknown }): PromotionListBody {
  return response.body as PromotionListBody;
}

function claimBody(response: { body: unknown }): ClaimBody {
  return response.body as ClaimBody;
}

/**
 * NestJS 的错误响应体。
 *
 * ⚠️ **`message` 可能是字符串也可能是字符串数组**：
 * `ValidationPipe` 的多条校验错误会聚成数组，业务异常（BadRequest 等）
 * 则是单个字符串。所以这里用 `unknown` + 收敛函数处理两种形态。
 */
interface ErrorBody {
  message: string | string[];
}

function errorBody(response: { body: unknown }): ErrorBody {
  return response.body as ErrorBody;
}

/** 把错误响应里的 message 摊平成一段文本，便于断言包含某个关键词 */
function errorText(response: { body: unknown }): string {
  const message = errorBody(response).message;
  return Array.isArray(message) ? message.join('; ') : message;
}

describe('优惠券与满减活动 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let couponService: CouponService;
  /**
   * 裸 PrismaClient：绕开租户扩展，用来读**数据库时钟**与查看软删行的真身。
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
    couponService = app.get(CouponService);
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

  /** 平台超管登录（种子里已有这个账号） */
  async function loginPlatformAdmin(): Promise<string> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    return tokenBody(response).accessToken;
  }

  /** 一张券的创建请求体（默认值让它落在「不限量、无门槛、长期有效」） */
  function couponPayload(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      code: `C-${unique()}`,
      name: '测试券',
      value: 1000,
      minAmount: 5000,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    };
  }

  /** 一张活动的创建请求体 */
  function promotionPayload(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      name: `活动-${unique()}`,
      minAmount: 10_000,
      discountAmount: 2000,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    };
  }

  // ============================================================
  // 商家侧：创建 / 编辑 / 暂停 / 删除
  // ============================================================

  describe('商家侧的券与活动管理', () => {
    it('商家创建券：201，且 scope 一律是 SHOP', async () => {
      const merchant = await createMerchant(app, prisma);

      const response = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ code: `C-${unique()}`, name: '满 50 减 10' }))
        .expect(201);

      const body = couponBody(response);
      expect(body.code).toBeTruthy();
      expect(body.name).toBe('满 50 减 10');
      expect(body.value).toBe(1000);
      expect(body.minAmount).toBe(5000);
      expect(body.type).toBe('FIXED');
      expect(body.status).toBe('ACTIVE');
      // ⚠️ M7：商家账号创建的券一律 SHOP
      expect(body.scope).toBe('SHOP');
      expect(body.claimedCount).toBe(0);
    });

    it('商家创建的券落在自己的租户下', async () => {
      const merchant = await createMerchant(app, prisma);
      const response = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);

      const rows = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findMany({ where: { id: couponBody(response).id } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(merchant.tenantId);
    });

    it('券码重复：P2002 转 409 而不是 500', async () => {
      const merchant = await createMerchant(app, prisma);
      const code = `C-${unique()}`;

      await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ code }))
        .expect(201);

      const response = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ code }))
        .expect(409);

      expect(response.body).toHaveProperty('message');
      expect(errorText(response)).toContain('券码');
    });

    it('结束时间不晚于开始时间：400', async () => {
      const merchant = await createMerchant(app, prisma);
      const now = Date.now();

      const response = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            startsAt: new Date(now).toISOString(),
            endsAt: new Date(now - 1000).toISOString(),
          }),
        )
        .expect(400);

      expect(errorText(response)).toContain('结束时间');
    });

    it('商家改券：改面额与名称', async () => {
      const merchant = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);

      const response = await http(app)
        .patch(`/api/v1/merchant/coupons/${couponBody(created).id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '改过的名字', value: 2000 })
        .expect(200);

      const body = couponBody(response);
      expect(body.name).toBe('改过的名字');
      expect(body.value).toBe(2000);
      // 未传的字段保持原样
      expect(body.minAmount).toBe(5000);
    });

    it('商家暂停券：status 变 PAUSED', async () => {
      const merchant = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);

      const response = await http(app)
        .patch(`/api/v1/merchant/coupons/${couponBody(created).id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ status: 'PAUSED' })
        .expect(200);

      expect(couponBody(response).status).toBe('PAUSED');
    });

    it('商家删券：软删，之后列表里查不到、库里 deletedAt 非空', async () => {
      const merchant = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .delete(`/api/v1/merchant/coupons/${couponId}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);

      const list = await http(app)
        .get('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);
      expect(couponListBody(list).items.map((c) => c.id)).not.toContain(
        couponId,
      );

      // ⚠️ 必须是**软删**：行还在，只是 deletedAt 被填上。
      // 只断言「列表里查不到」不够——物理删也能让列表少一条，
      // 必须绕开租户扩展用原生 client 确认行还在。
      const rows = await rawPrisma.$queryRawUnsafe<
        Array<{ id: string; deletedAt: Date | null }>
      >(`SELECT "id", "deletedAt" FROM coupons WHERE id = $1`, couponId);
      expect(rows).toHaveLength(1);
      expect(rows[0].deletedAt).not.toBeNull();
    });

    it('商家创建活动：201，门槛与减免额原样落库', async () => {
      const merchant = await createMerchant(app, prisma);

      const response = await http(app)
        .post('/api/v1/merchant/promotions')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(promotionPayload({ name: '满 100 减 20' }))
        .expect(201);

      const body = promotionBody(response);
      expect(body.name).toBe('满 100 减 20');
      expect(body.minAmount).toBe(10_000);
      expect(body.discountAmount).toBe(2000);
      expect(body.status).toBe('ACTIVE');
    });

    it('活动结束时间不晚于开始时间：400', async () => {
      const merchant = await createMerchant(app, prisma);
      const now = Date.now();

      const response = await http(app)
        .post('/api/v1/merchant/promotions')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          promotionPayload({
            startsAt: new Date(now).toISOString(),
            endsAt: new Date(now - 1000).toISOString(),
          }),
        )
        .expect(400);

      expect(errorText(response)).toContain('结束时间');
    });

    it('商家改活动 / 暂停活动 / 删活动', async () => {
      const merchant = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/promotions')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(promotionPayload())
        .expect(201);
      const promotionId = promotionBody(created).id;

      const patched = await http(app)
        .patch(`/api/v1/merchant/promotions/${promotionId}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ status: 'PAUSED', discountAmount: 3000 })
        .expect(200);
      expect(promotionBody(patched).status).toBe('PAUSED');
      expect(promotionBody(patched).discountAmount).toBe(3000);

      await http(app)
        .delete(`/api/v1/merchant/promotions/${promotionId}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);

      const list = await http(app)
        .get('/api/v1/merchant/promotions')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);
      expect(promotionListBody(list).items.map((p) => p.id)).not.toContain(
        promotionId,
      );
    });

    it('跨租户改券：改不到别家店的券（404）', async () => {
      const a = await createMerchant(app, prisma);
      const b = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${a.token}`)
        .send(couponPayload())
        .expect(201);

      await http(app)
        .patch(`/api/v1/merchant/coupons/${couponBody(created).id}`)
        .set('authorization', `Bearer ${b.token}`)
        .send({ name: 'B 店改的' })
        .expect(404);
    });

    it('消费者不能调商家接口：403', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${customer.token}`)
        .send(couponPayload())
        .expect(403);
    });

    it('未登录不能调商家接口：401', async () => {
      await http(app)
        .post('/api/v1/merchant/coupons')
        .send(couponPayload())
        .expect(401);
    });
  });

  // ============================================================
  // M7：平台券不被伪造
  // ============================================================

  describe('M7：scope 由服务端推导', () => {
    it('商家请求体里传 scope: PLATFORM → 400（DTO 里没这个字段）', async () => {
      const merchant = await createMerchant(app, prisma);

      const response = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ scope: 'PLATFORM' }))
        .expect(400);

      expect(errorText(response)).toContain('scope');
    });

    it('商家请求体里传 claimedCount → 400（计数不能由客户端伪造）', async () => {
      const merchant = await createMerchant(app, prisma);

      await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ claimedCount: 9999 }))
        .expect(400);
    });

    it('商家请求体里传 type: PERCENT → 400（本阶段只有满减券）', async () => {
      const merchant = await createMerchant(app, prisma);

      await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ type: 'PERCENT' }))
        .expect(400);
    });

    it('service 层也不采信 DTO 里的 scope：直调 service 造出的券仍是 SHOP', async () => {
      // ⚠️ **DTO 的白名单只是第一道闸**。万一哪天有人把 `scope` 加进 DTO
      // （或者绕过 HTTP 直接调 service），服务端**仍然**不能采信它——
      // 「谁是平台超管」是服务端的判断，不是客户端能传的字段。
      //
      // 这条用例刻意**绕过 HTTP 层**直调 service：
      // HTTP 层的 `forbidNonWhitelisted` 会先把带 scope 的请求体拦成 400，
      // 根本到不了 service，service 层的推导就永远没被测过。
      const merchant = await createMerchant(app, prisma);

      const created = await asTenant(merchant.tenantId, () =>
        couponService.createCoupon({
          code: `C-${unique()}`,
          name: '直调 service 造的券',
          value: 1000,
          minAmount: 0,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          // ⚠️ 伪造平台作用域：service 必须无视它
          scope: 'PLATFORM',
        } as unknown as CreateCouponDto),
      );

      expect(created.scope).toBe('SHOP');
    });

    it('平台超管创建的券 scope 才是 PLATFORM', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const response = await http(app)
        .post('/api/v1/platform/coupons')
        .set('authorization', `Bearer ${adminToken}`)
        .send(couponPayload({ tenantId: merchant.tenantId }))
        .expect(201);

      expect(couponBody(response).scope).toBe('PLATFORM');
    });

    it('商家不能创建平台券：调平台接口 403', async () => {
      const merchant = await createMerchant(app, prisma);

      await http(app)
        .post('/api/v1/platform/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ tenantId: merchant.tenantId }))
        .expect(403);
    });
  });

  // ============================================================
  // 消费者侧：领券
  // ============================================================

  describe('消费者领券', () => {
    it('领券：claimedCount 加 1，coupon_claims 里多一行', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;

      const response = await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(200);

      expect(claimBody(response).couponId).toBe(couponId);
      expect(claimBody(response).quantity).toBe(1);

      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      expect(coupon?.claimedCount).toBe(1);

      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { couponId } }),
      );
      expect(claims).toHaveLength(1);
      expect(claims[0].quantity).toBe(1);
      expect(claims[0].customerId).toBe(customer.userId);
    });

    it('按券码领券也可以', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const code = `C-${unique()}`;
      await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ code }))
        .expect(201);

      const response = await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ code })
        .expect(200);

      expect(claimBody(response).quantity).toBe(1);
    });

    it('领不存在的券：404', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: 'not-exist' })
        .expect(404);
    });

    it('领券必须登录：401', async () => {
      const merchant = await createMerchant(app, prisma);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({ couponId: 'whatever' })
        .expect(401);
    });

    it('领券请求体里传 discountAmount → 400（M2：面额只能从库里读）', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id, discountAmount: 99999 })
        .expect(400);
    });

    it('已过期的券不能领：409', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            startsAt: new Date(Date.now() - 7200_000).toISOString(),
            endsAt: new Date(Date.now() - 3600_000).toISOString(),
          }),
        )
        .expect(201);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id })
        .expect(409);
    });

    it('未开始的券不能领：409', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            startsAt: new Date(Date.now() + 3600_000).toISOString(),
            endsAt: new Date(Date.now() + 7200_000).toISOString(),
          }),
        )
        .expect(201);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id })
        .expect(409);
    });

    it('暂停的券不能领：409', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);

      await http(app)
        .patch(`/api/v1/merchant/coupons/${couponBody(created).id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ status: 'PAUSED' })
        .expect(200);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id })
        .expect(409);
    });

    it('软删的券不能领：404', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .delete(`/api/v1/merchant/coupons/${couponId}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(404);
    });

    it('跨租户领券：别家店的券领不到（404）', async () => {
      const a = await createMerchant(app, prisma);
      const b = await createMerchant(app, prisma);
      const customer = await registerCustomer(b.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${a.token}`)
        .send(couponPayload())
        .expect(201);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id })
        .expect(404);
    });
  });

  // ============================================================
  // M4：限额不被并发超发
  // ============================================================

  describe('M4：限额不被并发超发', () => {
    it('并发领限量券：只有 1 个成功，其余 409，且 claimedCount 恰好是 1', async () => {
      const merchant = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ totalLimit: 1 }))
        .expect(201);
      const couponId = couponBody(created).id;

      // 10 个**不同**的消费者并发领同一张总量为 1 的券
      const customers = await Promise.all(
        Array.from({ length: 10 }, () => registerCustomer(merchant.subdomain)),
      );

      // ⚠️ 要真的并发：Promise.all，不能先 await A 再 await B
      const responses = await Promise.all(
        customers.map((c) =>
          http(app)
            .post('/api/v1/coupons/claim')
            .set('authorization', `Bearer ${c.token}`)
            .send({ couponId }),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(9);

      // ⚠️ claimedCount 必须**恰好**是 1（不是 2、不是 0）
      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      expect(coupon?.claimedCount).toBe(1);
    });

    it('并发领限量券之后：claimedCount 与 coupon_claims 的 quantity 之和一致', async () => {
      const merchant = await createMerchant(app, prisma);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ totalLimit: 5 }))
        .expect(201);
      const couponId = couponBody(created).id;

      const customers = await Promise.all(
        Array.from({ length: 10 }, () => registerCustomer(merchant.subdomain)),
      );
      await Promise.all(
        customers.map((c) =>
          http(app)
            .post('/api/v1/coupons/claim')
            .set('authorization', `Bearer ${c.token}`)
            .send({ couponId }),
        ),
      );

      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { couponId } }),
      );
      // ⚠️ 必须**求和**——只断言 claims.length === 1 不够（quantity 可能是 2）
      const sum = claims.reduce((s, c) => s + c.quantity, 0);
      expect(sum).toBe(coupon?.claimedCount);
      expect(sum).toBeLessThanOrEqual(5);
    });

    it('每用户限领：超出 perUserLimit 被拒', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const other = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ perUserLimit: 1 }))
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(200);

      // 同一用户第二次 → 409
      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(409);

      // 另一个用户 → 成功
      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${other.token}`)
        .send({ couponId })
        .expect(200);
    });

    it('每用户限领：一次领多张也会被 perUserLimit 卡住', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ perUserLimit: 2 }))
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId, quantity: 3 })
        .expect(409);

      // ⚠️ 被拒的那次不能留下痕迹：claimedCount 与领取记录都没动
      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      expect(coupon?.claimedCount).toBe(0);
      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { couponId } }),
      );
      expect(claims).toHaveLength(0);
    });

    it('并发领同一张每用户限 1 张的券：同一用户只成功一次', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ perUserLimit: 1 }))
        .expect(201);
      const couponId = couponBody(created).id;

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          http(app)
            .post('/api/v1/coupons/claim')
            .set('authorization', `Bearer ${customer.token}`)
            .send({ couponId }),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);

      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { couponId } }),
      );
      expect(claims).toHaveLength(1);
      expect(claims[0].quantity).toBe(1);
    });

    it('不限量的券：总发放上限为 null 时不该被 0 挡住', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;
      expect(couponBody(created).totalLimit).toBeNull();

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(200);

      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      expect(coupon?.claimedCount).toBe(1);
    });
  });

  // ============================================================
  // M14：计数与领取记录同步
  // ============================================================

  describe('M14：领取计数与领取记录同步', () => {
    it('同一用户连领两次（不限量）：claimedCount 累加，coupon_claims 仍是同一行', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(200);
      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId })
        .expect(200);

      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { couponId } }),
      );
      expect(coupon?.claimedCount).toBe(2);
      expect(claims).toHaveLength(1);
      expect(claims[0].quantity).toBe(2);
    });

    it('领 2 张：claimedCount 加 2，coupon_claims 的 quantity 是 2', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId, quantity: 2 })
        .expect(200);

      const coupon = await asTenant(merchant.tenantId, () =>
        prisma.coupon.findFirst({ where: { id: couponId } }),
      );
      const claims = await asTenant(merchant.tenantId, () =>
        prisma.couponClaim.findMany({ where: { couponId } }),
      );
      expect(coupon?.claimedCount).toBe(2);
      expect(claims[0].quantity).toBe(2);
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
     * 计划 §8.2 的 M15 条目已经预告了这个坑：
     * 「注入时要确保测试真的挂了——如果没挂，说明这条护栏没有测试覆盖」。
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

    /**
     * 在**冻结的应用时钟**下注册一个消费者。
     *
     * ⚠️ **必须在冻结之后再注册**：JWT 的 `iat` / `exp` 由
     * `Date.now()` 算出，passport-jwt 验签时也用 `Date.now()`。
     * 先注册再冻结的话，2026 年签发的令牌在 2019 年看就是「还没生效」，
     * 请求会被守卫挡掉，测不到业务逻辑。
     */
    async function registerCustomerWithFrozenClock(
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

    afterEach(() => {
      (global as unknown as { Date: DateConstructor }).Date = Date;
    });

    it('券的窗口横跨两个时钟：数据库钟说有效、应用钟说未开始 → 领得到', async () => {
      const merchant = await createMerchant(app, prisma);

      // 券的窗口：[2019-11-01, 2026-11-01)
      //   - 数据库钟（真实时间 ~2026-10）落在窗口**内** → 有效 → 200
      //   - 应用钟（冻到 2019-06）落在窗口**前** → 未开始 → 409
      // 两个时钟给出**不同**结果，所以这条用例能区分实现用的是哪一个。
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            name: '横跨两个时钟的券',
            startsAt: '2019-11-01T00:00:00.000Z',
            endsAt: '2026-11-01T00:00:00.000Z',
          }),
        )
        .expect(201);

      const restore = freezeAppClock(new Date('2019-06-01T00:00:00.000Z'));
      try {
        const customer = await registerCustomerWithFrozenClock(
          merchant.subdomain,
        );

        const response = await http(app)
          .post('/api/v1/coupons/claim')
          .set('authorization', `Bearer ${customer.token}`)
          .send({ couponId: couponBody(created).id });

        expect(response.status).toBe(200);
      } finally {
        restore();
      }
    });

    it('券的窗口全在数据库钟之前：数据库钟说已过期 → 领不到', async () => {
      const merchant = await createMerchant(app, prisma);

      // 券的窗口：[2019-01-01, 2019-02-01)
      //   - 数据库钟（真实时间 ~2026-10）落在窗口**后** → 已过期 → 409
      // 这条与上一条合起来，才能唯一确定「已过期」与「未开始」两个分支
      // 都用数据库时钟判定：只实现「未开始」的话，上一条会挂、这条照样过，
      // 两条一起才把两个分支都锁住。
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            name: '2019 年初的券',
            startsAt: '2019-01-01T00:00:00.000Z',
            endsAt: '2019-02-01T00:00:00.000Z',
          }),
        )
        .expect(201);

      const restore = freezeAppClock(new Date('2019-06-01T00:00:00.000Z'));
      try {
        const customer = await registerCustomerWithFrozenClock(
          merchant.subdomain,
        );

        await http(app)
          .post('/api/v1/coupons/claim')
          .set('authorization', `Bearer ${customer.token}`)
          .send({ couponId: couponBody(created).id })
          .expect(409);
      } finally {
        restore();
      }
    });

    it('以数据库当前时间为基准，endsAt 刚过 1 秒的券领不到', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const dbNow = await databaseNow();

      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            startsAt: new Date(dbNow.getTime() - 3600_000).toISOString(),
            endsAt: new Date(dbNow.getTime() - 1000).toISOString(),
          }),
        )
        .expect(201);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id })
        .expect(409);
    });

    it('以数据库当前时间为基准，startsAt 刚过 1 秒的券还领不到', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const dbNow = await databaseNow();

      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            startsAt: new Date(dbNow.getTime() + 1000).toISOString(),
            endsAt: new Date(dbNow.getTime() + 3600_000).toISOString(),
          }),
        )
        .expect(201);

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${customer.token}`)
        .send({ couponId: couponBody(created).id })
        .expect(409);
    });
  });

  // ============================================================
  // 可领列表与我的券
  // ============================================================

  describe('可领列表与我的券', () => {
    it('可领列表只含本店的、ACTIVE 的、在有效期内的券', async () => {
      const merchant = await createMerchant(app, prisma);
      const customer = await registerCustomer(merchant.subdomain);

      const active = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload({ name: '在架的券' }))
        .expect(201);
      const expired = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(
          couponPayload({
            name: '过期券',
            startsAt: new Date(Date.now() - 7200_000).toISOString(),
            endsAt: new Date(Date.now() - 3600_000).toISOString(),
          }),
        )
        .expect(201);

      const response = await http(app)
        .get('/api/v1/coupons/available')
        .set('authorization', `Bearer ${customer.token}`)
        .expect(200);

      const ids = couponListBody(response).items.map((c) => c.id);
      expect(ids).toContain(couponBody(active).id);
      expect(ids).not.toContain(couponBody(expired).id);
    });

    it('我的券只含自己领过的', async () => {
      const merchant = await createMerchant(app, prisma);
      const a = await registerCustomer(merchant.subdomain);
      const b = await registerCustomer(merchant.subdomain);
      const created = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(couponPayload())
        .expect(201);
      const couponId = couponBody(created).id;

      await http(app)
        .post('/api/v1/coupons/claim')
        .set('authorization', `Bearer ${a.token}`)
        .send({ couponId })
        .expect(200);

      const response = await http(app)
        .get('/api/v1/coupons/mine')
        .set('authorization', `Bearer ${b.token}`)
        .expect(200);

      expect(couponListBody(response).items.map((c) => c.id)).not.toContain(
        couponId,
      );
    });
  });
});
