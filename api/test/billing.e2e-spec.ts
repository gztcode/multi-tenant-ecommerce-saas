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
 * 套餐与订阅的 e2e（阶段 5b Task 4）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M1：订阅请求体不接受 `price`（价格只能从库里读）
 * - 护栏 M2：订阅请求体不接受 `commissionBps`（费率只能从库里读）
 * - 护栏 M3：套餐的写接口只有平台超管能用；下架的套餐订不了
 * - 护栏 M4：重复开通要幂等，不是插两行
 * - 护栏 M9：订阅请求体只认 `planId`，其余一律从库里读
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface TokenBody {
  accessToken: string;
}

interface PlanBody {
  id: string;
  code: string;
  name: string;
  price: number;
  periodDays: number;
  trialDays: number;
  commissionBps: number;
  status: string;
  maxProducts: number | null;
  maxSkus: number | null;
  maxStores: number | null;
}

interface SubscriptionBody {
  id: string;
  tenantId: string;
  planId: string;
  pendingPlanId: string | null;
  status: string;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

/**
 * 套餐列表的响应体。
 *
 * ⚠️ **统一成 `{ items, total }`**（与阶段 5a 的 `GET /coupons/available` 同形）：
 * 两个前端 Task（商家后台订阅页、平台超管三页）要消费这两个接口，
 * 统一成一种形状，前端少写一套解析。
 */
interface PlanListBody {
  items: PlanBody[];
  total: number;
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function planBody(response: { body: unknown }): PlanBody {
  return response.body as PlanBody;
}

function planListBody(response: { body: unknown }): PlanListBody {
  return response.body as PlanListBody;
}

function subscriptionBody(response: { body: unknown }): SubscriptionBody {
  return response.body as SubscriptionBody;
}

/**
 * NestJS 的错误响应体。
 *
 * ⚠️ **`message` 可能是字符串也可能是字符串数组**：
 * `ValidationPipe` 的多条校验错误会聚成数组，业务异常（NotFound 等）
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

describe('套餐与订阅 (e2e)', () => {
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

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
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

  /** 一个套餐的创建请求体 */
  function planPayload(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      code: `P-${unique()}`,
      name: '测试套餐',
      price: 9900,
      periodDays: 30,
      trialDays: 0,
      commissionBps: 500,
      ...overrides,
    };
  }

  // ============================================================
  // 商家侧：订阅
  // ============================================================

  describe('商家侧的订阅', () => {
    it('商家订阅一个在售套餐：建出订阅行，planId 是那套餐', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      const response = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId })
        .expect(201);

      const body = subscriptionBody(response);
      expect(body.planId).toBe(planId);
      expect(body.tenantId).toBe(merchant.tenantId);
      // ⚠️ 套餐没有试用期时，订阅直接是 ACTIVE（不是 TRIAL）
      expect(body.status).toBe('ACTIVE');

      // ⚠️ 必须**查库**确认订阅行真的落库了，只看响应体不够
      const rows = await asTenant(merchant.tenantId, () =>
        prisma.subscription.findMany({
          where: { tenantId: merchant.tenantId },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].planId).toBe(planId);
    });

    it('套餐有试用期时：订阅状态是 TRIAL', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ trialDays: 14 }))
        .expect(201);
      const planId = planBody(created).id;

      const response = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId })
        .expect(201);

      const body = subscriptionBody(response);
      expect(body.status).toBe('TRIAL');
      expect(body.trialEndsAt).not.toBeNull();
    });

    it('M1：订阅请求体带 price → 400，且库里没有订阅行', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      const response = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId, price: 0 })
        .expect(400);

      expect(errorText(response)).toContain('price');

      // ⚠️ **必须查库**：被拒的请求不能留下任何痕迹
      const rows = await asTenant(merchant.tenantId, () =>
        prisma.subscription.findMany({
          where: { tenantId: merchant.tenantId },
        }),
      );
      expect(rows).toHaveLength(0);
    });

    it('M2：订阅请求体带 commissionBps → 400，且库里没有订阅行', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      const response = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId, commissionBps: 0 })
        .expect(400);

      expect(errorText(response)).toContain('commissionBps');

      const rows = await asTenant(merchant.tenantId, () =>
        prisma.subscription.findMany({
          where: { tenantId: merchant.tenantId },
        }),
      );
      expect(rows).toHaveLength(0);
    });

    it('M3：订阅一个已下架的套餐 → 404', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      // 下架（软删语义：保留历史订阅里的套餐快照）
      await http(app)
        .delete(`/api/v1/platform/plans/${planId}`)
        .set('authorization', `Bearer ${adminToken}`)
        .expect(200);

      const response = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId })
        .expect(404);

      expect(errorText(response)).toContain('套餐不存在或已下架');

      const rows = await asTenant(merchant.tenantId, () =>
        prisma.subscription.findMany({
          where: { tenantId: merchant.tenantId },
        }),
      );
      expect(rows).toHaveLength(0);
    });

    it('M4：重复开通 → 不会插出第二条订阅', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      const first = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId })
        .expect(201);
      const second = await http(app)
        .post('/api/v1/billing/subscription')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ planId })
        .expect(201);

      // 两次返回的是**同一条**订阅
      expect(subscriptionBody(second).id).toBe(subscriptionBody(first).id);

      // ⚠️ 必须查库：行数仍然是 1
      const rows = await asTenant(merchant.tenantId, () =>
        prisma.subscription.findMany({
          where: { tenantId: merchant.tenantId },
        }),
      );
      expect(rows).toHaveLength(1);
    });

    it('未登录不能订阅：401', async () => {
      await http(app)
        .post('/api/v1/billing/subscription')
        .send({ planId: 'whatever' })
        .expect(401);
    });
  });

  // ============================================================
  // 平台侧：套餐管理
  // ============================================================

  describe('平台侧的套餐管理', () => {
    it('平台超管建套餐：出现在商家能订阅的列表里', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ name: '平台上新套餐' }))
        .expect(201);

      const planId = planBody(created).id;
      expect(planBody(created).price).toBe(9900);
      expect(planBody(created).periodDays).toBe(30);
      expect(planBody(created).commissionBps).toBe(500);
      expect(planBody(created).status).toBe('ACTIVE');

      const list = await http(app)
        .get('/api/v1/billing/plans')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);

      const listed = planListBody(list);
      expect(listed.items.map((p) => p.id)).toContain(planId);
      expect(listed.total).toBe(listed.items.length);
    });

    it('平台超管建套餐时请求体带 tenantId → 400', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const response = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ tenantId: merchant.tenantId }))
        .expect(400);

      expect(errorText(response)).toContain('tenantId');
    });

    it('M3：商家账号调平台建套餐接口 → 403', async () => {
      const merchant = await createMerchant(app, prisma);

      const response = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${merchant.token}`)
        .send(planPayload())
        .expect(403);

      expect(response.body).toHaveProperty('message');
    });

    it('M3：商家账号调平台套餐列表接口 → 403', async () => {
      const merchant = await createMerchant(app, prisma);

      await http(app)
        .get('/api/v1/platform/plans')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(403);
    });

    it('平台超管改套餐：价格与名称都改掉了', async () => {
      const adminToken = await loginPlatformAdmin();

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      const response = await http(app)
        .patch(`/api/v1/platform/plans/${planId}`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ name: '改过的套餐', price: 19900 })
        .expect(200);

      expect(planBody(response).name).toBe('改过的套餐');
      expect(planBody(response).price).toBe(19900);
      // 未传的字段保持原样
      expect(planBody(response).periodDays).toBe(30);
    });

    it('套餐代码重复 → 409', async () => {
      const adminToken = await loginPlatformAdmin();
      const code = `P-${unique()}`;

      await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ code }))
        .expect(201);

      const response = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ code }))
        .expect(409);

      expect(errorText(response)).toContain('套餐代码');
    });

    it('改套餐时把 code 改成别的套餐已用的 code → 409（不是 500）', async () => {
      const adminToken = await loginPlatformAdmin();
      const code = `P-${unique()}`;

      const first = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ code }))
        .expect(201);
      const firstId = planBody(first).id;

      const second = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const secondId = planBody(second).id;

      // ⚠️ **P2002 必须在 service 层兜住**：不兜的话会一路冒到全局过滤器，
      // 变成 500「服务器内部错误」。
      const response = await http(app)
        .patch(`/api/v1/platform/plans/${secondId}`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ code })
        .expect(409);

      expect(errorText(response)).toContain('套餐代码');

      // ⚠️ 必须查库：冲突的改**没有生效**，第一个套餐的 code 还在
      const rows = await prisma.plan.findMany({
        where: { id: { in: [firstId, secondId] } },
      });
      expect(rows.find((p) => p.id === firstId)?.code).toBe(code);
      expect(rows.find((p) => p.id === secondId)?.code).not.toBe(code);
    });

    it('平台侧的套餐列表：形状是 { items, total }', async () => {
      const adminToken = await loginPlatformAdmin();

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      const list = await http(app)
        .get('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .expect(200);

      const listed = planListBody(list);
      expect(listed.items.map((p) => p.id)).toContain(planId);
      expect(listed.total).toBe(listed.items.length);
    });

    it('下架的套餐不在商家的可订阅列表里', async () => {
      const adminToken = await loginPlatformAdmin();
      const merchant = await createMerchant(app, prisma);

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);
      const planId = planBody(created).id;

      await http(app)
        .delete(`/api/v1/platform/plans/${planId}`)
        .set('authorization', `Bearer ${adminToken}`)
        .expect(200);

      const list = await http(app)
        .get('/api/v1/billing/plans')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);

      expect(planListBody(list).items.map((p) => p.id)).not.toContain(planId);
    });

    // ============================================================
    // 额度的「不限」语义：显式传 null ≠ 没传
    // ============================================================

    it('显式传 maxStores: null（= 不限）→ 建出来的套餐是 null，不是 1', async () => {
      const adminToken = await loginPlatformAdmin();

      // ⚠️ **显式传 null**：前端「店铺数上限（留空 = 不限）」留空时发的就是它。
      // 改之前 `dto.maxStores ?? 1` 把 null 当成「没传」→ 建出来是 **1**，
      // 界面上写着「留空 = 不限」，实际只能开 1 个店铺。
      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload({ maxStores: null }))
        .expect(201);

      expect(planBody(created).maxStores).toBeNull();
    });

    it('不传 maxStores → 建出来的套餐是默认值 1', async () => {
      const adminToken = await loginPlatformAdmin();

      const created = await http(app)
        .post('/api/v1/platform/plans')
        .set('authorization', `Bearer ${adminToken}`)
        .send(planPayload())
        .expect(201);

      // ⚠️ **没传时默认值仍然生效**（绝大多数套餐只允许一个店铺）
      expect(planBody(created).maxStores).toBe(1);
    });
  });
});
