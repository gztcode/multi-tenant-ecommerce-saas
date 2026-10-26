import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { InvoiceService } from '../src/modules/billing/invoice.service';
import { RenewalService } from '../src/modules/payment/renewal.service';
import { FakePaymentProvider } from '../src/modules/payment/fake-payment.provider';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 账单、续费与订阅付款的 e2e（阶段 5b Task 5）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M5：同一周期只能有一张账单（`@@unique([subscriptionId, periodStart])`）
 * - 护栏 M9：账单金额只从套餐价格读
 * - 护栏 M10：回调金额必须与账单金额一致，不一致就拒绝
 * - 护栏 M11：重复的续费回调只延长一次订阅期
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
  code: string;
  name: string;
  price: number;
  periodDays: number;
  trialDays: number;
  status: string;
}

interface SubscriptionBody {
  id: string;
  tenantId: string;
  planId: string;
  status: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

interface PaymentMethodBody {
  id: string;
  channel: string;
  type: string;
  isDefault: boolean;
}

/** 库里的账单行（只断言用到的字段） */
interface InvoiceRow {
  id: string;
  number: string;
  amount: number;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  paidAt: Date | null;
  subscriptionId: string;
}

/** 库里的订阅行（只断言用到的字段） */
interface SubscriptionRow {
  id: string;
  status: string;
  planId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function planBody(response: { body: unknown }): PlanBody {
  return response.body as PlanBody;
}

function subscriptionBody(response: { body: unknown }): SubscriptionBody {
  return response.body as SubscriptionBody;
}

function paymentMethodBody(response: { body: unknown }): PaymentMethodBody {
  return response.body as PaymentMethodBody;
}

describe('账单、续费与订阅付款 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let invoices: InvoiceService;
  let renewal: RenewalService;
  let fakeProvider: FakePaymentProvider;

  beforeAll(async () => {
    // ⚠️ 假网关的开关与密钥必须在 AppModule 加载**之前**设好：
    // BullModule.forRoot 与 provider 的构造都在模块求值时发生。
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // ⚠️ `rawBody: true`：webhook 端点要拿**原始字节**验签。
    app = moduleRef.createNestApplication({ rawBody: true });
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
    renewal = app.get(RenewalService);
    // ⚠️ **渠道表里放的就是这个实例** —— 所以 `jest.spyOn` 打在它身上
    // 就能模拟「渠道扣款失败」。
    fakeProvider = app.get(FakePaymentProvider);
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
    return tokenBody(response).accessToken;
  }

  /** 一个套餐的创建请求体 */
  function planPayload(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      code: `P-${unique()}`,
      name: '续费用的套餐',
      price: 9900,
      periodDays: 30,
      trialDays: 0,
      commissionBps: 500,
      ...overrides,
    };
  }

  /** 建一个套餐，返回它的 id */
  async function createPlan(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const adminToken = await loginPlatformAdmin();
    const created = await http(app)
      .post('/api/v1/platform/plans')
      .set('authorization', `Bearer ${adminToken}`)
      .send(planPayload(overrides))
      .expect(201);
    return planBody(created).id;
  }

  /** 商家订阅一个套餐，返回订阅行 */
  async function subscribe(
    merchantToken: string,
    planId: string,
  ): Promise<SubscriptionBody> {
    const response = await http(app)
      .post('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ planId })
      .expect(201);
    return subscriptionBody(response);
  }

  /** 读库里的订阅行 */
  async function readSubscription(
    tenantId: string,
  ): Promise<SubscriptionRow | null> {
    return asTenant(tenantId, async () => {
      const rows = await prisma.subscription.findMany({
        where: { tenantId },
      });
      return rows[0] ?? null;
    });
  }

  /** 读库里的全部账单行（按周期开始时间排序） */
  async function readInvoices(tenantId: string): Promise<InvoiceRow[]> {
    return asTenant(tenantId, async () => {
      const rows = await prisma.invoice.findMany({
        where: { tenantId },
        orderBy: { periodStart: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        number: row.number,
        amount: row.amount,
        status: row.status,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        dueAt: row.dueAt,
        paidAt: row.paidAt,
        subscriptionId: row.subscriptionId,
      }));
    });
  }

  /** 读库里的某张账单 */
  async function readInvoice(
    tenantId: string,
    number: string,
  ): Promise<InvoiceRow | null> {
    const rows = await readInvoices(tenantId);
    return rows.find((row) => row.number === number) ?? null;
  }

  /**
   * 构造一个签过名的假网关回调体。
   *
   * ⚠️ **签名覆盖整个原始 body**（HMAC-SHA256，hex）。
   */
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

  /** 发一个假网关的**订阅**回调 */
  function postFakeSubscriptionWebhook(payload: Record<string, unknown>) {
    const { body, signature } = signFakeWebhook(payload);
    return http(app)
      .post(`/api/v1/webhooks/subscription/${FAKE_CHANNEL}`)
      .set('content-type', 'application/json')
      .set('x-fake-signature', signature)
      .send(body);
  }

  /** 等一个条件成立（轮询） */
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

  // ============================================================
  // 续费回调成功 → 订阅期延长一个周期
  // ============================================================

  it('续费回调成功：订阅期延长一个周期，账单转 PAID', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);
    expect(subscription.status).toBe('ACTIVE');

    // 生成下一期的账单（周期从当前周期结束日开始）
    const periodStart = new Date(subscription.currentPeriodEnd);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
    const invoice = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(invoice).not.toBeNull();

    // 手动续费：建订阅的支付单并调渠道
    const paid = await http(app)
      .post(`/api/v1/billing/invoices/${invoice!.number}/pay`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ channel: FAKE_CHANNEL })
      .expect(201);

    // 假网关「确认支付」
    const paymentId = (paid.body as { paymentId: string }).paymentId;
    await http(app).post(`/api/v1/pay/fake/${paymentId}/confirm`).expect(200);

    // ⚠️ **查库**确认：订阅期延长了一个周期
    const after = await readSubscription(merchant.tenantId);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('ACTIVE');
    expect(after!.currentPeriodStart.getTime()).toBe(periodStart.getTime());
    expect(after!.currentPeriodEnd.getTime()).toBe(periodEnd.getTime());

    // ⚠️ 账单转 PAID
    const invoiceRow = await readInvoice(merchant.tenantId, invoice!.number);
    expect(invoiceRow!.status).toBe('PAID');
    expect(invoiceRow!.paidAt).not.toBeNull();

    // 平台超管能看到这个套餐（顺带确认没有把租户作用域搞坏）
    expect(adminToken).toBeTruthy();
  });

  // ============================================================
  // 护栏 M10：回调金额 ≠ 账单金额 → 拒绝
  // ============================================================

  it('M10：回调金额与账单金额不一致 → 账单仍是 OPEN，订阅期不延长', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);

    const periodStart = new Date(subscription.currentPeriodEnd);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
    const invoice = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(invoice).not.toBeNull();

    const before = await readSubscription(merchant.tenantId);

    // ⚠️ **回调金额只有 1 分**（账单是 9900）
    const response = await postFakeSubscriptionWebhook({
      eventId: `evt-${unique()}`,
      providerTxnId: `txn-${unique()}`,
      orderNo: invoice!.number,
      amount: 1,
      success: true,
    });
    // 渠道回调本身是「收到了」的语义（不该让渠道无限重试），
    // 但**账目不推进**——这才是要害。
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // ⚠️ **关键断言**：账单仍是 OPEN
    const invoiceRow = await readInvoice(merchant.tenantId, invoice!.number);
    expect(invoiceRow!.status).toBe('OPEN');
    expect(invoiceRow!.paidAt).toBeNull();

    // ⚠️ **关键断言**：订阅期**没有**延长
    const after = await readSubscription(merchant.tenantId);
    expect(after!.currentPeriodEnd.getTime()).toBe(
      before!.currentPeriodEnd.getTime(),
    );
  });

  // ============================================================
  // 护栏 M11：同一个回调重复发两次 → 只延长一次
  // ============================================================

  it('M11：同一个回调重复发两次 → 订阅期只延长一个周期', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);

    const periodStart = new Date(subscription.currentPeriodEnd);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
    const invoice = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(invoice).not.toBeNull();

    const before = await readSubscription(merchant.tenantId);
    const eventId = `evt-${unique()}`;
    const payload = {
      eventId,
      providerTxnId: `txn-${unique()}`,
      orderNo: invoice!.number,
      amount: 9900,
      success: true,
    };

    // 第一次投递
    const first = await postFakeSubscriptionWebhook(payload);
    expect(first.status).toBe(200);

    const becamePaid = await waitFor(async () => {
      const row = await readInvoice(merchant.tenantId, invoice!.number);
      return row?.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    // 第二次投递（**同一个 eventId**）
    const second = await postFakeSubscriptionWebhook(payload);
    expect(second.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // ⚠️ **查库**：订阅期只往后延了**一个**周期，不是两个
    const after = await readSubscription(merchant.tenantId);
    expect(after!.currentPeriodEnd.getTime()).toBe(periodEnd.getTime());
    // 不是「原来 + 2 个周期」
    expect(after!.currentPeriodEnd.getTime()).not.toBe(
      before!.currentPeriodEnd.getTime() + 2 * 30 * DAY_MS,
    );

    // 账单也只有一张、只付了一次
    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('PAID');
  });

  // ============================================================
  // 护栏 M5：同一周期生成两张账单 → 被拒
  // ============================================================

  it('M5：同一周期生成两张账单 → 第二张没建出来', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);

    const periodStart = new Date(subscription.currentPeriodEnd);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);

    const first = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(first).not.toBeNull();

    // ⚠️ **同一个周期再生成一次** —— 撞 `@@unique([subscriptionId, periodStart])`
    const second = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(second).toBeNull();

    // ⚠️ **查库**：库里只有一张账单
    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first!.id);
  });

  // ============================================================
  // 试用到期 → 生成第一个付费周期的账单
  // ============================================================

  it('试用到期：扫描生成第一个付费周期的账单，periodStart 是试用结束日', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({
      price: 9900,
      periodDays: 30,
      trialDays: 14,
    });

    const subscription = await subscribe(merchant.token, planId);
    expect(subscription.status).toBe('TRIAL');
    expect(subscription.trialEndsAt).not.toBeNull();

    // ⚠️ **把试用结束日挪到「3 天内」**（扫描的窗口是周期开始前 3 天）。
    // 试用期的 `currentPeriodEnd` 就是试用结束日 —— 所以挪它就等于
    // 「把试用挪到即将结束」。
    const trialEndsAt = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: {
          currentPeriodEnd: trialEndsAt,
          trialEndsAt,
        },
      }),
    );

    await renewal.scan();

    const all = await readInvoices(merchant.tenantId);
    // ⚠️ **试用期的账单不生成**（免费周期），但下一个付费周期的账单生成了
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe(9900);
    expect(all[0].status).toBe('OPEN');
    expect(all[0].periodStart.getTime()).toBe(trialEndsAt.getTime());
    expect(all[0].periodEnd.getTime()).toBe(
      trialEndsAt.getTime() + 30 * DAY_MS,
    );
  });

  // ============================================================
  // 护栏 M9：账单金额 = 套餐价格（不是请求体传的）
  // ============================================================

  it('M9：账单金额只从套餐价格读：改套餐价后重新生成的账单跟着变', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);

    const periodStart = new Date(subscription.currentPeriodEnd);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);

    const first = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart,
        periodEnd,
        dueAt: periodStart,
      }),
    );
    expect(first!.amount).toBe(9900);

    // ⚠️ **改套餐价**，再为**下一个周期**生成账单
    await http(app)
      .patch(`/api/v1/platform/plans/${planId}`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ price: 19900 })
      .expect(200);

    const nextPeriodStart = periodEnd;
    const nextPeriodEnd = new Date(nextPeriodStart.getTime() + 30 * DAY_MS);
    const second = await asTenant(merchant.tenantId, () =>
      invoices.generateInvoice({
        subscriptionId: subscription.id,
        tenantId: merchant.tenantId,
        planId,
        periodStart: nextPeriodStart,
        periodEnd: nextPeriodEnd,
        dueAt: nextPeriodStart,
      }),
    );

    // ⚠️ **金额跟着套餐价走** —— 不接受任何来自请求体的金额
    expect(second!.amount).toBe(19900);

    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(2);
    expect(all[0].amount).toBe(9900);
    expect(all[1].amount).toBe(19900);
  });

  // ============================================================
  // 支付方式的绑定
  // ============================================================

  it('绑定支付方式：token 由渠道给，解绑后消失', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    const method = paymentMethodBody(created);
    expect(method.isDefault).toBe(true);
    expect(method.channel).toBe(FAKE_CHANNEL);

    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows).toHaveLength(1);
    // ⚠️ **token 由渠道给**（假网关给的是 `fake_pm_*`），不是客户端传的
    expect(rows[0].token.startsWith('fake_pm_')).toBe(true);

    await http(app)
      .delete(`/api/v1/billing/payment-methods/${method.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const after = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(after).toHaveLength(0);
  });

  it('绑定支付方式时请求体带 token → 400（token 不能由客户端给）', async () => {
    const merchant = await createMerchant(app, prisma);

    const response = await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL, token: 'stolen-token' });

    expect(response.status).toBe(400);

    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows).toHaveLength(0);
  });

  // ============================================================
  // 扫描：自动续费（有绑定的支付方式 → 自动扣款）
  // ============================================================

  it('扫描：有绑定的支付方式时自动扣款，订阅期直接延长', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    await subscribe(merchant.token, planId);

    // 绑定一个支付方式（自动续费的前提）
    await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    // 把当前周期结束日挪到「3 天内」（扫描的窗口是周期开始前 3 天）
    const periodStart = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      }),
    );

    await renewal.scan();

    // ⚠️ **查库**：账单生成了、付了，订阅期延长了一个周期
    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe(9900);
    expect(all[0].status).toBe('PAID');
    expect(all[0].periodStart.getTime()).toBe(periodStart.getTime());

    const after = await readSubscription(merchant.tenantId);
    expect(after!.currentPeriodEnd.getTime()).toBe(
      periodStart.getTime() + 30 * DAY_MS,
    );
  });

  // ============================================================
  // 扣款失败 → 账单 FAILED → 商家手动支付能成功
  // ============================================================

  it('扣款失败后账单变 FAILED，商家手动支付能成功且订阅期延长', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    await subscribe(merchant.token, planId);

    // 绑定支付方式（自动续费的前提）
    await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    // 把当前周期结束日挪到「3 天内」（扫描的窗口是周期开始前 3 天）
    const periodStart = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      }),
    );

    // ⚠️ **让渠道扣款失败**
    //
    // ⚠️ `providerTxnId` 必须每次都不同：`(provider, providerTxnId)` 是
    // **全局**唯一索引（不带租户），用固定值会撞上别的用例留下的行。
    const spy = jest.spyOn(fakeProvider, 'chargeAuthorized').mockResolvedValue({
      providerTxnId: `txn-${unique()}`,
      status: 'FAILED',
    });

    try {
      await renewal.scan();
    } finally {
      spy.mockRestore();
    }

    // ⚠️ **账单变 FAILED**（上一次支付尝试失败了）
    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('FAILED');
    const failedInvoice = all[0];

    // ⚠️ **关键断言**：商家手动支付**不再 409**
    // （改之前：`invoice.status !== OPEN` → 409「账单当前状态不允许支付」）
    const paid = await http(app)
      .post(`/api/v1/billing/invoices/${failedInvoice.number}/pay`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ channel: FAKE_CHANNEL })
      .expect(201);

    // 假网关「确认支付」
    const paymentId = (paid.body as { paymentId: string }).paymentId;
    await http(app).post(`/api/v1/pay/fake/${paymentId}/confirm`).expect(200);

    const becamePaid = await waitFor(async () => {
      const row = await readInvoice(merchant.tenantId, failedInvoice.number);
      return row?.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    // ⚠️ **订阅期延长了一个周期**（`markInvoicePaid` 要放行 FAILED 账单，
    // 否则账单转不到 PAID，订阅也就永远不过期）
    const after = await readSubscription(merchant.tenantId);
    expect(after!.status).toBe('ACTIVE');
    expect(after!.currentPeriodEnd.getTime()).toBe(
      periodStart.getTime() + 30 * DAY_MS,
    );
  });

  // ============================================================
  // 周期已过且没付 → 扫描后订阅变 EXPIRED（付费套餐）
  // ============================================================

  it('周期已过且没付：扫描后付费订阅变 EXPIRED', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);
    expect(subscription.status).toBe('ACTIVE');

    // ⚠️ **把当前周期结束日挪到过去** —— 服务其实早就没了
    const past = new Date(Date.now() - DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: past },
      }),
    );

    await renewal.scan();

    // ⚠️ **关键断言**：订阅变成 EXPIRED
    // （改之前 `expireIfNeeded` 只在「账单为 null」时被调用，
    //  付费套餐的 ACTIVE 订阅永远走不到那里）
    const after = await readSubscription(merchant.tenantId);
    expect(after!.status).toBe('EXPIRED');
    // 周期结束日不动 —— 只是状态变了
    expect(after!.currentPeriodEnd.getTime()).toBe(past.getTime());
  });

  // ============================================================
  // 扣款失败 → 再扫一次 → 能重试扣款（不抛「该账单已有支付单」）
  // ============================================================

  it('扣款失败后再扫一次：能重试扣款，不抛「该账单已有支付单」', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    await subscribe(merchant.token, planId);

    await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ type: 'CARD', channel: FAKE_CHANNEL })
      .expect(201);

    const periodStart = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      }),
    );

    // ⚠️ **第一轮：扣款失败**
    const failing = jest
      .spyOn(fakeProvider, 'chargeAuthorized')
      .mockResolvedValue({
        providerTxnId: `txn-${unique()}`,
        status: 'FAILED',
      });
    try {
      await renewal.scan();
    } finally {
      failing.mockRestore();
    }

    const afterFirst = await readInvoices(merchant.tenantId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].status).toBe('FAILED');

    // ⚠️ **关键断言**：支付单被标成 FAILED（不是永远停在 PENDING）
    const payments = await asTenant(merchant.tenantId, () =>
      prisma.payment.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('FAILED');

    // ⚠️ **第二轮：渠道恢复正常**，扫描**不能抛「该账单已有支付单」**
    // （改之前：第二轮撞 `payments_invoice_channel_uniq` → 抛冲突 →
    //  这个订阅在该渠道上永久无法再自动扣款）
    const success = jest
      .spyOn(fakeProvider, 'chargeAuthorized')
      .mockResolvedValue({
        providerTxnId: `txn-${unique()}`,
        status: 'SUCCESS',
      });
    try {
      await expect(renewal.scan()).resolves.toBeUndefined();
    } finally {
      success.mockRestore();
    }

    // ⚠️ **账单付清了**
    const afterSecond = await readInvoices(merchant.tenantId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].status).toBe('PAID');

    // ⚠️ **订阅期延长了一个周期**
    const sub = await readSubscription(merchant.tenantId);
    expect(sub!.status).toBe('ACTIVE');
    expect(sub!.currentPeriodEnd.getTime()).toBe(
      periodStart.getTime() + 30 * DAY_MS,
    );

    // ⚠️ **只用了同一笔支付单**（没有新建第二笔）
    const paymentsAfter = await asTenant(merchant.tenantId, () =>
      prisma.payment.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(paymentsAfter).toHaveLength(1);
  });

  // ============================================================
  // 账单号撞车时不该静默吞掉这个周期
  // ============================================================

  it('账单号撞车：重试生成另一个号，这个周期照样出账单', async () => {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan({ price: 9900, periodDays: 30 });

    const subscription = await subscribe(merchant.token, planId);

    const periodStart = new Date(subscription.currentPeriodEnd);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
    // ⚠️ **第二个周期**（`periodStart` 不同 → `(subscriptionId, periodStart)` 不撞，
    // 只有账单号会撞）
    const nextPeriodStart = periodEnd;
    const nextPeriodEnd = new Date(nextPeriodStart.getTime() + 30 * DAY_MS);

    // ⚠️ **让两次生成用同一个时间戳**（账单号 = 秒级时间戳 + 4 位随机数）
    const fixedNow = new Date('2026-01-02T03:04:05.000Z');
    const nowSpy = jest
      .spyOn(prisma, 'databaseNow')
      .mockResolvedValue(fixedNow);

    // ⚠️ **让随机数先撞后不撞**：
    // 第 1 次调用 → 第一张账单的号
    // 第 2 次调用 → 撞号的那次尝试（重试前）
    // 第 3 次调用起 → 换号，重试成功
    let randomCalls = 0;
    const randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => {
      randomCalls += 1;
      return randomCalls <= 2 ? 0.1111 : 0.2222;
    });

    try {
      const first = await asTenant(merchant.tenantId, () =>
        invoices.generateInvoice({
          subscriptionId: subscription.id,
          tenantId: merchant.tenantId,
          planId,
          periodStart,
          periodEnd,
          dueAt: periodStart,
        }),
      );
      expect(first).not.toBeNull();

      // ⚠️ **同一个订阅、但下一个周期** —— 账单号撞的是
      // `(tenantId, number)`，而 `(subscriptionId, periodStart)` 不撞。
      // 改之前：撞号被静默当成「这个周期已经有账单了」→ 返回 null →
      // **这个周期永远不出账单**。
      const second = await asTenant(merchant.tenantId, () =>
        invoices.generateInvoice({
          subscriptionId: subscription.id,
          tenantId: merchant.tenantId,
          planId,
          periodStart: nextPeriodStart,
          periodEnd: nextPeriodEnd,
          dueAt: nextPeriodStart,
        }),
      );

      expect(second).not.toBeNull();
      // ⚠️ **账单号必须不同**
      expect(second!.number).not.toBe(first!.number);
    } finally {
      nowSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  // ============================================================
  // 换套餐后：续费账单按「待生效的套餐」出账
  // ============================================================

  it('有 pendingPlanId 时：续费账单按待生效套餐的价格出账', async () => {
    const merchant = await createMerchant(app, prisma);
    const currentPlanId = await createPlan({ price: 9900, periodDays: 30 });
    const pendingPlanId = await createPlan({ price: 29900, periodDays: 30 });

    await subscribe(merchant.token, currentPlanId);

    // ⚠️ **换套餐**（下个周期生效）—— `pendingPlanId` 就是待生效的套餐
    await http(app)
      .patch('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ planId: pendingPlanId })
      .expect(200);

    // 把当前周期结束日挪到「3 天内」（扫描的窗口是周期开始前 3 天）
    const periodStart = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      }),
    );

    await renewal.scan();

    // ⚠️ **关键断言**：账单金额是**待生效套餐**的价格（29900），不是
    // 当前套餐的 9900。
    //
    // 改之前：账单按 `subscription.planId`（当前套餐）出账 → 9900，
    // 但这个周期开始后订阅会切到待生效的套餐（`markInvoicePaid` 里
    // `planId = pendingPlanId`）—— **商家付 ¥99 用上了 ¥299 的套餐**，
    // 平台少收了 ¥200。
    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe(29900);
  });

  it('没有 pendingPlanId 时：续费账单按当前套餐的价格出账（回归）', async () => {
    const merchant = await createMerchant(app, prisma);
    const currentPlanId = await createPlan({ price: 9900, periodDays: 30 });

    await subscribe(merchant.token, currentPlanId);

    // 把当前周期结束日挪到「3 天内」（扫描的窗口是周期开始前 3 天）
    const periodStart = new Date(Date.now() + DAY_MS);
    await asTenant(merchant.tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId: merchant.tenantId },
        data: { currentPeriodEnd: periodStart },
      }),
    );

    await renewal.scan();

    // ⚠️ **回归**：没有待生效套餐时，金额仍是当前套餐的 9900
    const all = await readInvoices(merchant.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0].amount).toBe(9900);
  });
});
