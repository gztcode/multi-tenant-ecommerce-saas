import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { InvoiceService } from '../src/modules/billing/invoice.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 商家侧的账单与支付方式**列表**端点（阶段 5b Task 7 的前置小步）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 租户隔离：账单与支付方式的列表**不含别家租户**的数据
 * - 安全护栏：支付方式列表**不返回 `token`**（渠道给的扣款凭证）
 * - 租户身份来自 accessToken 里的 tenantId，**不需要额外的租户 header**
 */

/** 假网关的共享密钥。测试里显式设置，确保与实现读到的是同一个值。 */
const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';

/** 假网关的渠道名 */
const FAKE_CHANNEL = 'fake';

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface TokenBody {
  accessToken: string;
}

interface PlanBody {
  id: string;
}

interface SubscriptionBody {
  id: string;
  currentPeriodEnd: string;
  planId?: string;
  pendingPlanId?: string | null;
}

/** 列表接口返回的账单（只断言用到的字段） */
interface InvoiceItem {
  id: string;
  number: string;
  amount: number;
  status: string;
  tenantId: string;
}

/** 列表接口返回的支付方式（只断言用到的字段） */
interface PaymentMethodItem {
  id: string;
  provider: string;
  channel: string;
  type: string;
  isDefault: boolean;
}

/** 列表接口的响应体 */
interface ListBody<T> {
  items: T[];
  total: number;
}

describe('商家侧的账单与支付方式列表 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let invoices: InvoiceService;

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
    invoices = app.get(InvoiceService);
  });

  afterAll(async () => {
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

  /** 平台超管登录（种子里已有这个账号） */
  async function loginPlatformAdmin(): Promise<string> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    return (response.body as TokenBody).accessToken;
  }

  /** 建一个套餐，返回它的 id */
  async function createPlan(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const adminToken = await loginPlatformAdmin();
    const created = await http(app)
      .post('/api/v1/platform/plans')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        code: `P-${unique()}`,
        name: '列表用的套餐',
        price: 9900,
        periodDays: 30,
        trialDays: 0,
        commissionBps: 500,
        ...overrides,
      })
      .expect(201);
    return (created.body as PlanBody).id;
  }

  /** 商家订阅一个套餐 */
  async function subscribe(
    merchantToken: string,
    planId: string,
  ): Promise<SubscriptionBody> {
    const response = await http(app)
      .post('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ planId })
      .expect(201);
    return response.body as SubscriptionBody;
  }

  /**
   * 给商家造一张账单。
   *
   * ⚠️ 账单不是商家自己建出来的（只有续费扫描与手动续费会建），
   * 这里直接调 `InvoiceService.generateInvoice` 落库 ——
   * 目的是让列表接口**有数据可列**，被测的是列表不是账单生成。
   */
  async function seedInvoice(
    tenantId: string,
    subscriptionId: string,
    planId: string,
    periodStart: Date,
  ): Promise<string> {
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
    const invoice = await asTenant(tenantId, () =>
      invoices.generateInvoice({
        subscriptionId,
        tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(invoice).not.toBeNull();
    return invoice!.number;
  }

  /** 商家绑一个支付方式 */
  async function bindPaymentMethod(
    merchantToken: string,
    type = 'CARD',
  ): Promise<PaymentMethodItem> {
    const response = await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ type, channel: FAKE_CHANNEL })
      .expect(201);
    return response.body as PaymentMethodItem;
  }

  // ============================================================
  // 账单列表
  // ============================================================

  it('GET /billing/invoices：返回本店的账单，不含别家租户的', async () => {
    const merchant = await createMerchant(app, prisma);
    const other = await createMerchant(app, prisma);
    const planId = await createPlan();

    const subscription = await subscribe(merchant.token, planId);
    const otherSubscription = await subscribe(other.token, planId);

    const mine = await seedInvoice(
      merchant.tenantId,
      subscription.id,
      planId,
      new Date(subscription.currentPeriodEnd),
    );
    const theirs = await seedInvoice(
      other.tenantId,
      otherSubscription.id,
      planId,
      new Date(otherSubscription.currentPeriodEnd),
    );

    const response = await http(app)
      .get('/api/v1/billing/invoices')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = response.body as ListBody<InvoiceItem>;
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].number).toBe(mine);
    expect(body.items[0].tenantId).toBe(merchant.tenantId);

    // ⚠️ **别家租户的账单不能出现**
    expect(body.items.some((item) => item.number === theirs)).toBe(false);
  });

  it('GET /billing/invoices：账单按创建时间倒序（新的在前）', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();

    const subscription = await subscribe(merchant.token, planId);
    const firstPeriodStart = new Date(subscription.currentPeriodEnd);
    const first = await seedInvoice(
      merchant.tenantId,
      subscription.id,
      planId,
      firstPeriodStart,
    );
    // ⚠️ **下一个周期** —— 周期不同才不会撞 `@@unique([subscriptionId, periodStart])`
    const second = await seedInvoice(
      merchant.tenantId,
      subscription.id,
      planId,
      new Date(firstPeriodStart.getTime() + 30 * DAY_MS),
    );

    const response = await http(app)
      .get('/api/v1/billing/invoices')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = response.body as ListBody<InvoiceItem>;
    expect(body.total).toBe(2);
    // ⚠️ **新的在前** —— 商家后台的账单页默认按时间倒序
    expect(body.items[0].number).toBe(second);
    expect(body.items[1].number).toBe(first);
  });

  it('GET /billing/invoices：商家账号不需要额外的租户 header', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();

    const subscription = await subscribe(merchant.token, planId);
    await seedInvoice(
      merchant.tenantId,
      subscription.id,
      planId,
      new Date(subscription.currentPeriodEnd),
    );

    // ⚠️ **不带 `x-tenant-subdomain`**：租户身份来自 accessToken 里的 tenantId
    const response = await http(app)
      .get('/api/v1/billing/invoices')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = response.body as ListBody<InvoiceItem>;
    expect(body.total).toBe(1);
  });

  it('GET /billing/invoices：没登录 → 401', async () => {
    await http(app).get('/api/v1/billing/invoices').expect(401);
  });

  // ============================================================
  // 支付方式列表
  // ============================================================

  it('GET /billing/payment-methods：返回本店的支付方式，不含别家租户的', async () => {
    const merchant = await createMerchant(app, prisma);
    const other = await createMerchant(app, prisma);

    const mine = await bindPaymentMethod(merchant.token);
    const theirs = await bindPaymentMethod(other.token);

    const response = await http(app)
      .get('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = response.body as ListBody<PaymentMethodItem>;
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(mine.id);
    expect(body.items[0].channel).toBe(FAKE_CHANNEL);
    expect(body.items[0].isDefault).toBe(true);

    // ⚠️ **别家租户的支付方式不能出现**
    expect(body.items.some((item) => item.id === theirs.id)).toBe(false);
  });

  it('GET /billing/payment-methods：列表里没有 token（安全护栏）', async () => {
    const merchant = await createMerchant(app, prisma);
    await bindPaymentMethod(merchant.token);

    // ⚠️ **库里确实有 token**（渠道给的扣款凭证）—— 不是「本来就没有」
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBeTruthy();

    const response = await http(app)
      .get('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    // ⚠️ **关键断言**：整个响应体里不能出现 token
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('fake_pm_');

    const body = response.body as ListBody<PaymentMethodItem>;
    expect(body.items[0]).not.toHaveProperty('token');
  });

  it('GET /billing/payment-methods：默认的排在最前', async () => {
    const merchant = await createMerchant(app, prisma);
    await bindPaymentMethod(merchant.token, 'CARD');
    await bindPaymentMethod(merchant.token, 'WECHAT');

    const response = await http(app)
      .get('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = response.body as ListBody<PaymentMethodItem>;
    expect(body.total).toBe(2);
    // ⚠️ **新绑的那个是默认的**（绑定时把之前的默认清掉了）
    expect(body.items[0].isDefault).toBe(true);
    expect(body.items[0].type).toBe('WECHAT');
    expect(body.items[1].isDefault).toBe(false);
  });

  it('GET /billing/payment-methods：商家账号不需要额外的租户 header', async () => {
    const merchant = await createMerchant(app, prisma);
    await bindPaymentMethod(merchant.token);

    // ⚠️ **不带 `x-tenant-subdomain`**：租户身份来自 accessToken 里的 tenantId
    const response = await http(app)
      .get('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = response.body as ListBody<PaymentMethodItem>;
    expect(body.total).toBe(1);
  });

  it('GET /billing/payment-methods：没登录 → 401', async () => {
    await http(app).get('/api/v1/billing/payment-methods').expect(401);
  });

  it('POST /billing/payment-methods：绑定的响应里也没有 token（安全护栏）', async () => {
    const merchant = await createMerchant(app, prisma);

    // ⚠️ **绑定的那次响应同样不能带 token** —— 那是渠道给的扣款凭证，
    // 发到浏览器就等于把它交出去了。
    // ⚠️ **手写的返回类型里没有 `token` 并不算数**：Prisma 默认返回整行，
    // 类型声明骗不了运行时（必须真的 select 才保证）。
    const response = await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('fake_pm_');
    expect(response.body).not.toHaveProperty('token');

    // ⚠️ **库里确实有 token** —— 不是「本来就没有」
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBeTruthy();
  });

  // ============================================================
  // 换套餐（下个周期生效）
  // ============================================================

  it('PATCH /billing/subscription：已有订阅时换套餐写 pendingPlanId，当前套餐不变', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();
    const newPlanId = await createPlan();

    await subscribe(merchant.token, planId);

    const response = await http(app)
      .patch('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ planId: newPlanId })
      .expect(200);

    const body = response.body as SubscriptionBody;
    // ⚠️ **下个周期才生效**：当前套餐**不变**，只写 pendingPlanId。
    expect(body.planId).toBe(planId);
    expect(body.pendingPlanId).toBe(newPlanId);

    // ⚠️ **再查一次**：确认真的落库了，不只是响应体上写着。
    const current = await http(app)
      .get('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const currentBody = current.body as SubscriptionBody;
    expect(currentBody.planId).toBe(planId);
    expect(currentBody.pendingPlanId).toBe(newPlanId);
  });

  it('⚠️ POST /billing/subscription 仍然幂等（护栏 M4）：不换套餐', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();
    const otherPlanId = await createPlan();

    await subscribe(merchant.token, planId);

    // ⚠️ **重复开通要返回旧订阅**，不是插两行、也不是换套餐。
    const response = await http(app)
      .post('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ planId: otherPlanId })
      .expect(201);

    const body = response.body as SubscriptionBody;
    expect(body.planId).toBe(planId);
    expect(body.pendingPlanId).toBeNull();

    const current = await http(app)
      .get('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const currentBody = current.body as SubscriptionBody;
    expect(currentBody.planId).toBe(planId);
    expect(currentBody.pendingPlanId).toBeNull();
  });

  it('PATCH /billing/subscription：没订阅时 404（不能凭空开一个）', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();

    await http(app)
      .patch('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ planId })
      .expect(404);
  });

  it('PATCH /billing/subscription：没登录 → 401', async () => {
    await http(app)
      .patch('/api/v1/billing/subscription')
      .send({ planId: 'plan-1' })
      .expect(401);
  });
});
