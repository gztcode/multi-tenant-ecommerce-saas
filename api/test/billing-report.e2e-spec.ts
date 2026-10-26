import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { InvoiceStatus, OrderStatus, SubscriptionStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 平台侧的收入报表与跨租户订阅列表（阶段 5b Task 8a）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - M17：商家账号调平台接口 → 403；未登录 → 401
 * - 报表是**平台维度**的：A 商家与 B 商家的数据进同一份报表
 * - 报表的四个数由**后端**算，前端只展示
 */

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

/**
 * 报表区间的起点。
 *
 * ⚠️ **显式传一个宽区间**：夹具的时间落在中间就行，
 * 不用关心「现在几点」——测试不会因为跑的时间不同而飘。
 */
const WINDOW_ORIGIN = new Date('2020-01-01T00:00:00.000Z');

/**
 * 给每个用例一块**互不重叠**的时间段。
 *
 * ⚠️ **为什么每个用例要自己的区间**：报表是**平台维度**的聚合 ——
 * 它统计的是「区间内所有租户的所有订单」。用例之间共享一个区间的话，
 * 前一个用例造的数据会被后一个用例的断言算进去，
 * 于是断言只能写成「比基线多多少」——那样测的就不是「算得对不对」，
 * 而是「差值算得对不对」，基数一变就飘。
 *
 * 各自独立的区间让每个用例都能断言**绝对值**，这才是真正在测聚合逻辑。
 *
 * ⚠️ **区间之间留足空隙**：每块 30 天，块与块之间空 30 天 ——
 * 落在块边界上的时间不会算进相邻的块。
 */
const WINDOW_SIZE_DAYS = 30;
const WINDOW_GAP_DAYS = 30;

/** 每个用例领一块自己的区间（按顺序发号） */
let windowCounter = 0;

/** 领一块新区间，返回它的 [from, to) */
function nextWindow(): { from: Date; to: Date } {
  const index = windowCounter++;
  const from = new Date(
    WINDOW_ORIGIN.getTime() +
      index * (WINDOW_SIZE_DAYS + WINDOW_GAP_DAYS) * DAY_MS,
  );
  const to = new Date(from.getTime() + WINDOW_SIZE_DAYS * DAY_MS);
  return { from, to };
}

/**
 * 某块区间**内**的某个时刻。
 *
 * ⚠️ **避开边界**：报表的区间是左闭右开 `[from, to)`，
 * 正好等于 `from` 或 `to` 会让边界语义干扰断言。
 */
function insideWindow(
  window: { from: Date; to: Date },
  offsetDays: number,
): Date {
  return new Date(window.from.getTime() + offsetDays * DAY_MS);
}

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
}

/** 报表的响应体 */
interface ReportBody {
  from: string;
  to: string;
  subscriptionRevenue: number;
  commissionRevenue: number;
  reversal: number;
  netRevenue: number;
}

/** 订阅列表的一行 */
interface SubscriptionItem {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSubdomain: string;
  planId: string;
  planName: string;
  pendingPlanId: string | null;
  pendingPlanName: string | null;
  status: string;
  commissionBps: number;
  startedAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

interface SubscriptionListBody {
  items: SubscriptionItem[];
  total: number;
}

describe('平台侧的收入报表与订阅列表 (e2e)', () => {
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

  /**
   * 在**平台作用域**里执行一段逻辑（跨租户读写）。
   *
   * ⚠️ **平台的 `createMany` 要求每一行都显式带 `tenantId`**：
   * 租户作用域下扩展会把 `tenantId` 强制覆盖成上下文里的那个，
   * 那样 201 条会全落成同一个租户，撞上 `@@unique([tenantId])`。
   */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
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
        name: '报表用的套餐',
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
   * 造一条订阅（直接落库）。
   *
   * ⚠️ **直接落库而不是走订阅接口**：订阅接口会按当前时刻算试用期与周期，
   * 而本测试要的是「一条周期完全可控的订阅」。
   */
  async function seedSubscription(
    tenantId: string,
    planId: string,
    window: { from: Date; to: Date },
    overrides: {
      pendingPlanId?: string | null;
      status?: SubscriptionStatus;
    } = {},
  ): Promise<string> {
    const created = await asTenant(tenantId, () =>
      prisma.subscription.create({
        data: {
          tenantId,
          planId,
          pendingPlanId: overrides.pendingPlanId ?? null,
          status: overrides.status ?? SubscriptionStatus.ACTIVE,
          startedAt: insideWindow(window, 1),
          trialEndsAt: null,
          currentPeriodStart: insideWindow(window, 1),
          currentPeriodEnd: insideWindow(window, 20),
        },
      }),
    );
    return created.id;
  }

  /**
   * 造一张账单。
   *
   * ⚠️ **`@@unique([subscriptionId, periodStart])`**：同一个订阅的同一个周期
   * 只能有一张账单 —— 造多张时周期要各不相同。
   */
  async function seedInvoice(
    tenantId: string,
    subscriptionId: string,
    planId: string,
    window: { from: Date; to: Date },
    periodOffsetDays: number,
    options: {
      amount?: number;
      status?: InvoiceStatus;
      paidAt?: Date | null;
    } = {},
  ): Promise<void> {
    const periodStart = insideWindow(window, periodOffsetDays);
    await asTenant(tenantId, () =>
      prisma.invoice.create({
        data: {
          tenantId,
          subscriptionId,
          planId,
          number: `INV-${unique()}`,
          amount: options.amount ?? 9900,
          status: options.status ?? InvoiceStatus.PAID,
          periodStart,
          periodEnd: new Date(periodStart.getTime() + 30 * DAY_MS),
          dueAt: periodStart,
          paidAt: options.paidAt ?? insideWindow(window, periodOffsetDays + 1),
        },
      }),
    );
  }

  /** 造一笔订单 */
  async function seedOrder(
    tenantId: string,
    window: { from: Date; to: Date },
    options: {
      status?: OrderStatus;
      totalAmount?: number;
      commissionRate?: number;
      commissionAmount?: number;
      paidAt?: Date | null;
      refundedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const created = await asTenant(tenantId, () =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `ORD-${unique()}`,
          status: options.status ?? OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 10000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: options.commissionRate ?? 500,
          commissionAmount: options.commissionAmount ?? 0,
          paidAt: options.paidAt ?? insideWindow(window, 10),
          refundedAt: options.refundedAt ?? null,
        },
      }),
    );
    return created.id;
  }

  /** 拉报表 */
  async function fetchReport(
    token: string,
    query: { from?: string; to?: string } = {},
  ): Promise<ReportBody> {
    const params = new URLSearchParams();
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    const suffix = params.toString();
    const response = await http(app)
      .get(`/api/v1/platform/reports${suffix ? `?${suffix}` : ''}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as ReportBody;
  }

  /** 拉某一块区间的报表 */
  async function fetchWindowReport(
    token: string,
    window: { from: Date; to: Date },
  ): Promise<ReportBody> {
    return fetchReport(token, {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    });
  }

  // ============================================================
  // 报表的四个数
  // ============================================================

  it('报表的订阅收入 = 区间内已付账单之和（未付的不算）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();
    const window = nextWindow();
    const subscriptionId = await seedSubscription(
      merchant.tenantId,
      planId,
      window,
    );

    // ⚠️ **三个不同的周期**：`@@unique([subscriptionId, periodStart])`
    await seedInvoice(merchant.tenantId, subscriptionId, planId, window, 3, {
      amount: 1000,
      status: InvoiceStatus.PAID,
      paidAt: insideWindow(window, 4),
    });
    await seedInvoice(merchant.tenantId, subscriptionId, planId, window, 8, {
      amount: 2000,
      status: InvoiceStatus.PAID,
      paidAt: insideWindow(window, 9),
    });
    // ⚠️ **未付的账单不算收入**：钱还没到手
    await seedInvoice(merchant.tenantId, subscriptionId, planId, window, 13, {
      amount: 5000,
      status: InvoiceStatus.OPEN,
      paidAt: null,
    });

    const body = await fetchWindowReport(adminToken, window);

    expect(body.subscriptionRevenue).toBe(3000);
  });

  it('报表的抽佣收入 = 区间内已支付订单的抽佣之和', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const window = nextWindow();

    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });
    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 200,
      paidAt: insideWindow(window, 11),
    });

    const body = await fetchWindowReport(adminToken, window);

    expect(body.commissionRevenue).toBe(300);
  });

  it('⚠️ 报表的抽佣收入包含已发货与已完成的订单（不只 PAID）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const window = nextWindow();

    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });
    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.SHIPPED,
      commissionAmount: 200,
      paidAt: insideWindow(window, 11),
    });
    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.COMPLETED,
      commissionAmount: 400,
      paidAt: insideWindow(window, 12),
    });

    const body = await fetchWindowReport(adminToken, window);

    // ⚠️ **只算 PAID 会把已发货/已完成的订单全部漏掉** ——
    // 那些订单的钱明明收了，抽佣却没入账。
    expect(body.commissionRevenue).toBe(700);
  });

  it('已退款的订单仍进抽佣收入（按 paidAt），冲回行把它抵掉', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const window = nextWindow();

    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });
    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.REFUNDED,
      commissionAmount: 50,
      paidAt: insideWindow(window, 11),
      refundedAt: insideWindow(window, 20),
    });

    const body = await fetchWindowReport(adminToken, window);

    // ⚠️ **抽佣按支付时点归期，退款按退款时点归期，同一笔单两行相抵**。
    //
    // 抽佣是**支付时定下的快照**（`Order.commissionAmount`）：
    // 钱收进来就赚到了这笔抽佣，与后来退没退款无关。
    // 所以抽佣收入是**毛额** —— 区间内收过钱的订单的抽佣之和，
    // **包含后来退款的那些**（100 + 50 = 150）。
    expect(body.commissionRevenue).toBe(150);
    // ⚠️ **冲回按退款时点归期**：那一期白拿的抽佣要还回去。
    expect(body.reversal).toBe(50);
    // ⚠️ **被退款的这一笔对本期净贡献是 0**：
    // +50（支付期记收入）− 50（退款期记冲回）= 0。
    // ⚠️ **这条断言是「凭空负收入」的护栏**：抽佣行若按 status 筛
    // （REFUNDED 的订单被排除），这里会变成 150 − 100 = 50，
    // 而真相是 100 —— 平台在一期内赚了又退了，那笔单贡献 0。
    expect(body.netRevenue).toBe(100);
  });

  it('⚠️ 跨窗口：支付期记收入、退款期记冲回，两期净额合起来为 0', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    // ⚠️ **两块互不重叠的区间**：`nextWindow()` 发的正是这样的区间
    const payWindow = nextWindow();
    const refundWindow = nextWindow();

    // 支付落在窗口 A、退款落在窗口 B
    await seedOrder(merchant.tenantId, payWindow, {
      status: OrderStatus.REFUNDED,
      commissionAmount: 500,
      paidAt: insideWindow(payWindow, 10),
      refundedAt: insideWindow(refundWindow, 5),
    });

    const payBody = await fetchWindowReport(adminToken, payWindow);
    const refundBody = await fetchWindowReport(adminToken, refundWindow);

    // ⚠️ **A 的抽佣收入照记**：退款发生在另一个时点，
    // 不影响支付期已经赚到的抽佣。
    expect(payBody.commissionRevenue).toBe(500);
    expect(payBody.reversal).toBe(0);
    // ⚠️ **B 只记冲回**：B 的区间里没有新的支付。
    expect(refundBody.commissionRevenue).toBe(0);
    expect(refundBody.reversal).toBe(500);

    // ⚠️ **两期合起来净贡献为 0**：平台赚了 500 又退回去 500。
    expect(payBody.netRevenue).toBe(500);
    expect(refundBody.netRevenue).toBe(-500);
    expect(payBody.netRevenue + refundBody.netRevenue).toBe(0);
  });

  it('报表的净收入 = 订阅收入 + 抽佣收入 − 冲回', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();
    const window = nextWindow();
    const subscriptionId = await seedSubscription(
      merchant.tenantId,
      planId,
      window,
    );

    await seedInvoice(merchant.tenantId, subscriptionId, planId, window, 3, {
      amount: 1000,
      status: InvoiceStatus.PAID,
      paidAt: insideWindow(window, 4),
    });
    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });
    await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.REFUNDED,
      commissionAmount: 50,
      paidAt: insideWindow(window, 11),
      refundedAt: insideWindow(window, 20),
    });

    const body = await fetchWindowReport(adminToken, window);

    expect(body.subscriptionRevenue).toBe(1000);
    // ⚠️ **抽佣收入是毛额**：包含那笔后来退款的 50
    expect(body.commissionRevenue).toBe(150);
    expect(body.reversal).toBe(50);
    expect(body.netRevenue).toBe(1000 + 150 - 50);
  });

  it('报表是平台维度的：A 商家与 B 商家的数据进同一份报表', async () => {
    const adminToken = await loginPlatformAdmin();
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const window = nextWindow();

    await seedOrder(a.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });
    await seedOrder(b.tenantId, window, {
      status: OrderStatus.PAID,
      commissionAmount: 200,
      paidAt: insideWindow(window, 11),
    });

    const body = await fetchWindowReport(adminToken, window);

    expect(body.commissionRevenue).toBe(300);
  });

  // ============================================================
  // 区间
  // ============================================================

  it('缺省区间 = 最近 30 天（响应里回显实际的 from 与 to）', async () => {
    const adminToken = await loginPlatformAdmin();

    const body = await fetchReport(adminToken);

    // ⚠️ **from / to 必须回显**：前端要靠它知道后端实际用的是哪个区间
    expect(body.from).toBeTruthy();
    expect(body.to).toBeTruthy();
    expect(typeof body.subscriptionRevenue).toBe('number');
    expect(typeof body.commissionRevenue).toBe('number');
    expect(typeof body.reversal).toBe('number');
    expect(typeof body.netRevenue).toBe('number');

    const from = new Date(body.from).getTime();
    const to = new Date(body.to).getTime();
    expect(to - from).toBe(30 * DAY_MS);
  });

  it('区间非法（from >= to）→ 400', async () => {
    const adminToken = await loginPlatformAdmin();
    const window = nextWindow();

    await http(app)
      .get('/api/v1/platform/reports')
      .query({ from: window.to.toISOString(), to: window.from.toISOString() })
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);

    // ⚠️ **相等也当非法**：空区间无意义
    await http(app)
      .get('/api/v1/platform/reports')
      .query({
        from: window.from.toISOString(),
        to: window.from.toISOString(),
      })
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('from 格式非法 → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/platform/reports')
      .query({ from: '不是日期' })
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  // ============================================================
  // 鉴权
  // ============================================================

  it('GET /platform/reports：商家账号 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .get('/api/v1/platform/reports')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);
  });

  it('GET /platform/subscriptions：商家账号 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .get('/api/v1/platform/subscriptions')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);
  });

  it('GET /platform/reports：没登录 → 401', async () => {
    await http(app).get('/api/v1/platform/reports').expect(401);
  });

  it('GET /platform/subscriptions：没登录 → 401', async () => {
    await http(app).get('/api/v1/platform/subscriptions').expect(401);
  });

  // ============================================================
  // 跨租户的订阅列表
  // ============================================================

  it('GET /platform/subscriptions：平台超管能看到别家租户的订阅', async () => {
    const adminToken = await loginPlatformAdmin();
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const planId = await createPlan();

    const subscriptionA = await subscribe(a.token, planId);
    const subscriptionB = await subscribe(b.token, planId);

    const response = await http(app)
      .get('/api/v1/platform/subscriptions')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = response.body as SubscriptionListBody;
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(subscriptionA.id);
    expect(ids).toContain(subscriptionB.id);

    const itemA = body.items.find((item) => item.id === subscriptionA.id);
    expect(itemA).toBeDefined();
    expect(itemA!.tenantId).toBe(a.tenantId);
    expect(itemA!.planId).toBe(planId);
    expect(itemA!.planName).toBe('报表用的套餐');
    expect(itemA!.commissionBps).toBe(500);
    expect(itemA!.tenantSubdomain).toBe(a.subdomain);
    expect(itemA!.pendingPlanId).toBeNull();
    expect(itemA!.pendingPlanName).toBeNull();
  });

  it('GET /platform/subscriptions：带待生效套餐时给出待生效套餐名', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const planId = await createPlan();
    const pendingPlanId = await createPlan({ name: '待生效的套餐' });

    const subscriptionId = await seedSubscription(
      merchant.tenantId,
      planId,
      nextWindow(),
      {
        pendingPlanId,
      },
    );

    const response = await http(app)
      .get('/api/v1/platform/subscriptions')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = response.body as SubscriptionListBody;
    const item = body.items.find((row) => row.id === subscriptionId);
    expect(item).toBeDefined();
    expect(item!.pendingPlanId).toBe(pendingPlanId);
    expect(item!.pendingPlanName).toBe('待生效的套餐');
  });

  it('⚠️ 订阅列表的 total 是真实总数（items 被 take: 200 截断，total 不能跟着截）', async () => {
    const adminToken = await loginPlatformAdmin();
    const planId = await createPlan();

    // ⚠️ **真实总数要独立算出来**：不能拿响应体自己算（那样测的是自洽，
    // 不是「对不对」）。造数据**之前**先数一次平台作用域下的订阅总数。
    const before = await asPlatform(() => prisma.subscription.count());

    // ⚠️ **造 201 条**：刚好超过 `take: 200` 的截断线。
    //
    // `Subscription.tenantId` **没有**到 `Tenant` 的外键（schema 里订阅只有
    // `tenantId` 纯标量），所以**不需要真的建 201 个商家** ——
    // 造 201 个不同的假 tenantId 字符串就行。
    //
    // ⚠️ **必须走平台作用域**：租户作用域下扩展会把 `tenantId` 强制覆盖成
    // 上下文里的那个 → 201 条全落成同一个租户 → 撞 `@@unique([tenantId])`。
    // 平台作用域下的 `createMany` 要求每一行都显式带 `tenantId`。
    const fakeTenantIds = Array.from(
      { length: 201 },
      () => `fake-tenant-${unique()}`,
    );
    const now = new Date();
    try {
      await asPlatform(() =>
        prisma.subscription.createMany({
          data: fakeTenantIds.map((tenantId) => ({
            tenantId,
            // ⚠️ **`planId` 是纯标量**：套餐是平台的数据，订阅表不声明外键，
            // 挂一个不存在的套餐也允许（超管看到这一行本身就是要查原因）
            planId,
            status: SubscriptionStatus.ACTIVE,
            startedAt: now,
            currentPeriodStart: now,
            currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
          })),
        }),
      );

      const response = await http(app)
        .get('/api/v1/platform/subscriptions')
        .set('authorization', `Bearer ${adminToken}`)
        .expect(200);

      const body = response.body as SubscriptionListBody;

      // ⚠️ **`items` 确实被截断了**（这是前提，断了这条用例就失去意义）
      expect(body.items.length).toBe(200);
      // ⚠️ **`total` 是真实总数**：201 条 + 之前的存量。
      // 若 `total` 用的是 `items.length`，这里会是 200 —— 断言会挂。
      expect(body.total).toBe(before + 201);
      expect(body.total).toBeGreaterThan(body.items.length);
    } finally {
      // ⚠️ **必须清理**：这 201 条不删会**污染后面所有用例** ——
      // 尤其是订阅列表的用例，它会看到多出来的行。
      // `Subscription` 不在 `SOFT_DELETE_MODELS` 里，物理删除是允许的。
      await asPlatform(() =>
        prisma.subscription.deleteMany({
          where: { tenantId: { in: fakeTenantIds } },
        }),
      );
    }
  });
});
