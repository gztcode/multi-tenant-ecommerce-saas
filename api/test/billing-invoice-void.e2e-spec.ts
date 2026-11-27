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
import {
  createMerchant,
  unique,
  type MerchantFixture,
} from './merchant-fixture';

/**
 * 发票作废 (e2e)。
 *
 * 钉住的是一条完整链路：**开票 → 作废 → 再作废失败 → 列表能按状态筛到**，
 * 外加跨租户、已支付不可作废、作废后不可再支付三条边界。
 *
 * ⚠️ 作废是**保留记录**的状态流转：账单行不删、账单号不变，
 * 所以断言里到处都要能看到「同一张账单还在，只是状态变了」。
 */

const DAY_MS = 24 * 3600 * 1000;

interface PlanBody {
  id: string;
}

interface SubscriptionBody {
  id: string;
  currentPeriodEnd: string;
}

interface InvoiceItem {
  id: string;
  tenantId: string;
  number: string;
  status: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

interface ListBody {
  items: InvoiceItem[];
  total: number;
}

describe('发票作废 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let invoices: InvoiceService;

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
    invoices = app.get(InvoiceService);
  });

  afterAll(async () => {
    await app.close();
  });

  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  // ============================================================
  // 夹具
  // ============================================================

  async function loginPlatformAdmin(): Promise<string> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  async function createPlan(): Promise<string> {
    const adminToken = await loginPlatformAdmin();
    const created = await http(app)
      .post('/api/v1/platform/plans')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        code: `P-${unique()}`,
        name: '作废用的套餐',
        price: 9900,
        periodDays: 30,
        trialDays: 0,
        commissionBps: 500,
      })
      .expect(201);
    return (created.body as PlanBody).id;
  }

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

  /** 直接调服务造一张账单（被测的是作废，不是账单生成） */
  async function seedInvoice(
    tenantId: string,
    subscriptionId: string,
    planId: string,
    periodStart: Date,
  ): Promise<InvoiceItem> {
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
    if (!invoice) {
      throw new Error('测试账单没有生成出来');
    }
    return invoice as unknown as InvoiceItem;
  }

  /** 造一个「已开票」的商家：返回商家、账单与作废人（店主账号） */
  async function merchantWithInvoice(): Promise<{
    merchant: MerchantFixture;
    invoice: InvoiceItem;
    owner: { id: string; displayName: string };
  }> {
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();
    const subscription = await subscribe(merchant.token, planId);
    const invoice = await seedInvoice(
      merchant.tenantId,
      subscription.id,
      planId,
      new Date(subscription.currentPeriodEnd),
    );

    const owner = await asTenant(merchant.tenantId, () =>
      prisma.user.findFirst({
        where: { tenantId: merchant.tenantId },
        select: { id: true, displayName: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    if (!owner) {
      throw new Error('商家没有店主账号');
    }
    return { merchant, invoice, owner };
  }

  function voidInvoice(
    token: string,
    number: string,
    body: Record<string, unknown> = {},
  ) {
    return http(app)
      .post(`/api/v1/billing/invoices/${encodeURIComponent(number)}/void`)
      .set('authorization', `Bearer ${token}`)
      .send(body);
  }

  // ============================================================
  // 主链路
  // ============================================================

  it('开票 → 作废 → 再作废 409 → 列表能按 VOID 筛到', async () => {
    const { merchant, invoice, owner } = await merchantWithInvoice();

    // 1) 作废
    const voided = await voidInvoice(merchant.token, invoice.number, {
      reason: '  换套餐，本期不续了  ',
    }).expect(201);

    const body = voided.body as InvoiceItem;
    expect(body.id).toBe(invoice.id);
    // ⚠️ 保留记录：账单号不变
    expect(body.number).toBe(invoice.number);
    expect(body.status).toBe('VOID');
    expect(body.voidedAt).not.toBeNull();
    expect(body.voidedBy).toBe(owner.id);
    // ⚠️ 展示名是查询时解析的，库里只存 userId
    expect(body.voidedByName).toBe(owner.displayName);
    // 前后空白去掉
    expect(body.voidReason).toBe('换套餐，本期不续了');

    // 2) 再作废 → 409（不静默成功）
    const again = await voidInvoice(merchant.token, invoice.number).expect(409);
    expect((again.body as { message: string }).message).toContain('已作废');

    // 3) 库里还在，状态与作废人是第一次的（没被第二次覆盖）
    const row = await asTenant(merchant.tenantId, () =>
      prisma.invoice.findFirst({ where: { number: invoice.number } }),
    );
    expect(row).not.toBeNull();
    expect(row!.status).toBe('VOID');
    expect(row!.voidedBy).toBe(owner.id);

    // 4) 列表默认仍能看到它（只是状态变了）
    const all = await http(app)
      .get('/api/v1/billing/invoices')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const allBody = all.body as ListBody;
    expect(allBody.items.map((item) => item.number)).toContain(invoice.number);

    // 5) 按 VOID 筛能筛到
    const voidedList = await http(app)
      .get('/api/v1/billing/invoices?status=VOID')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const voidedBody = voidedList.body as ListBody;
    expect(voidedBody.total).toBe(1);
    expect(voidedBody.items[0].number).toBe(invoice.number);
    expect(voidedBody.items[0].voidedByName).toBe(owner.displayName);

    // 6) 按 OPEN 筛不到它（筛选条件真的生效）
    const openList = await http(app)
      .get('/api/v1/billing/invoices?status=OPEN')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect((openList.body as ListBody).total).toBe(0);
  });

  it('作废后不能再发起支付（409，钱不能为已作废的账单收）', async () => {
    const { merchant, invoice } = await merchantWithInvoice();

    await voidInvoice(merchant.token, invoice.number).expect(201);

    const pay = await http(app)
      .post(
        `/api/v1/billing/invoices/${encodeURIComponent(invoice.number)}/pay`,
      )
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ channel: 'fake' })
      .expect(409);
    expect((pay.body as { message: string }).message).toContain('不允许支付');
  });

  // ============================================================
  // 不可作废的状态
  // ============================================================

  it('已支付的账单不能作废（已产生会计影响，走退款而不是作废）', async () => {
    const { merchant, invoice } = await merchantWithInvoice();

    // ⚠️ 走真实的「付清」路径：状态转 PAID，并延长订阅期
    const paid = await asTenant(merchant.tenantId, () =>
      invoices.markInvoicePaid(invoice.id),
    );
    expect(paid).toBe(true);

    const response = await voidInvoice(merchant.token, invoice.number).expect(
      409,
    );
    expect((response.body as { message: string }).message).toContain('已支付');

    const row = await asTenant(merchant.tenantId, () =>
      prisma.invoice.findFirst({ where: { number: invoice.number } }),
    );
    expect(row!.status).toBe('PAID');
    expect(row!.voidedAt).toBeNull();
    expect(row!.voidedBy).toBeNull();
  });

  // ============================================================
  // 租户隔离与认证
  // ============================================================

  it('跨租户作废：别家的账单号在本店下查不到 → 404，且原账单不受影响', async () => {
    const { invoice } = await merchantWithInvoice();
    const other = await createMerchant(app, prisma);

    await voidInvoice(other.token, invoice.number).expect(404);

    const row = await asTenant(invoice.tenantId, () =>
      prisma.invoice.findFirst({ where: { number: invoice.number } }),
    );
    expect(row!.status).toBe('OPEN');
    expect(row!.voidedAt).toBeNull();
  });

  it('没登录作废 → 401', async () => {
    const { invoice } = await merchantWithInvoice();

    await http(app)
      .post(
        `/api/v1/billing/invoices/${encodeURIComponent(invoice.number)}/void`,
      )
      .send({})
      .expect(401);
  });

  it('作废原因超过 200 字 → 400（DTO 校验），账单仍是 OPEN', async () => {
    const { merchant, invoice } = await merchantWithInvoice();

    await voidInvoice(merchant.token, invoice.number, {
      reason: '长'.repeat(201),
    }).expect(400);

    const row = await asTenant(merchant.tenantId, () =>
      prisma.invoice.findFirst({ where: { number: invoice.number } }),
    );
    expect(row!.status).toBe('OPEN');
  });

  it('客户端多传作废人字段 → 400（作废人只能来自登录态）', async () => {
    const { merchant, invoice } = await merchantWithInvoice();

    await voidInvoice(merchant.token, invoice.number, {
      voidedBy: 'someone-else',
    }).expect(400);
  });
});
