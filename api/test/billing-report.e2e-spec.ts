import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import {
  CommissionEntryType,
  InvoiceStatus,
  OrderStatus,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { CommissionService } from '../src/modules/billing/commission.service';
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
  let commission: CommissionService;

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
    // ⚠️ **对账用例要调回填**：回填是服务方法（D5），
    // 迁移里的 SQL 测不到 —— 种子数据在迁移之后才灌进去。
    commission = app.get(CommissionService);
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

  /**
   * 抽佣明细端点的响应体。
   *
   * ⚠️ **字段名与 `platform-admin/src/lib/billing.ts` 的 `CommissionLedger` 逐字一致** ——
   * 前后端各写一份类型，对不上就是前端的 TS 报错（编译期能抓到）。
   */
  interface CommissionLedgerBody {
    from: string;
    to: string;
    byMerchant: Array<{
      tenantId: string;
      tenantName: string;
      subdomain: string;
      netAmount: number;
      entryCount: number;
      reversalCount: number;
    }>;
    entries: Array<{
      id: string;
      tenantId: string;
      orderNo: string;
      type: string;
      amount: number;
      rateBps: number;
      baseAmount: number;
      occurredAt: string;
    }>;
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
          // ⚠️ **不能用 `??`**：`null ?? x` 返回 `x`（只有 `undefined` 才回落），
          // 那样「传 null 表示「没付过钱」」会被静默忽略 ——
          // 夹具的类型签名写着 `Date | null`，调用方传 null 却拿不到 null。
          paidAt:
            options.paidAt === undefined
              ? insideWindow(window, periodOffsetDays + 1)
              : options.paidAt,
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
          // ⚠️ **不能用 `??`**：`null ?? x` 返回 `x`（只有 `undefined` 才回落），
          // 那样「传 null 表示「没付过钱 / 没退过款」」会被静默忽略 ——
          // 夹具的类型签名写着 `Date | null`，调用方传 null 却拿不到 null。
          paidAt:
            options.paidAt === undefined
              ? insideWindow(window, 10)
              : options.paidAt,
          refundedAt:
            options.refundedAt === undefined ? null : options.refundedAt,
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
  // 对账：流水表 vs 报表
  // ============================================================

  it('⚠️ 对账：流水表按区间聚合 == 报表的「抽佣收入 − 冲回」', async () => {
    // ⚠️ **这是「两套口径不许漂」的护栏** ——
    //    报表（现状：从订单聚合）与流水（新增：从表聚合）必须给出同一个数。
    //    不一致说明流水写入漏了某条路径，或回填规则漂了。
    //
    // ⚠️ **断言要具体**：期望什么、实到什么，不能只看红绿。
    //
    // ⚠️ **区间必须显式传**：报表的缺省窗口是「数据库时钟的最近 30 天」，
    //    两边都用同一个显式区间，断言才能落在**绝对值**上。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const other = await createMerchant(app, prisma);
    const window = nextWindow();

    // ---- 造五类订单，覆盖回填的每一条判定分支 ----
    //
    // ⚠️ **订单 id 要留下来**：断言要落在「哪一单有几行」上，
    // 只断言总数的话，「① 多了一行、③ 少了一行」也能凑出同一个总数。
    //
    // ① 已支付未退款 → 回填一条 COMMISSION 行（100）
    const paidOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      totalAmount: 20000,
      commissionRate: 500,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });

    // ② 已支付已退款（退款时间也在窗口内）→ 回填一条 COMMISSION + 一条 REVERSAL
    //    ⚠️ **抽佣 150 是毛额**：报表的 `commissionRevenue` 照记，
    //    冲回由 `reversal`（150）单独抵掉。
    const refundedOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.REFUNDED,
      totalAmount: 30000,
      commissionRate: 500,
      commissionAmount: 150,
      paidAt: insideWindow(window, 11),
      refundedAt: insideWindow(window, 20),
    });

    // ③ 已退款但 `refundedAt` 为 null（5b 之前退的款）→ 回填**跳过**冲回
    //    ⚠️ **与报表口径一致**：报表的冲回是 `refundedAt ∈ [from, to)`，
    //    对 null 不匹配 → 报表也不算它。两个口径不许在这里分叉。
    //    ⚠️ **但它的抽佣行照记** —— 它收过钱（`paidAt` 非空）。
    const undatedRefundOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.REFUNDED,
      totalAmount: 40000,
      commissionRate: 500,
      commissionAmount: 250,
      paidAt: insideWindow(window, 12),
      refundedAt: null,
    });

    // ④ 从未支付 → 报表与回填都不算它（`paidAt` 为空）
    const unpaidOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PENDING_PAYMENT,
      totalAmount: 50000,
      commissionRate: 500,
      commissionAmount: 250,
      paidAt: null,
      refundedAt: null,
    });

    // ⑤ 零额订单（免费套餐的费率是 0）→ **不产生流水行**
    const zeroAmountOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      totalAmount: 60000,
      commissionRate: 0,
      commissionAmount: 0,
      paidAt: insideWindow(window, 13),
    });

    // ---- 跑一遍回填 ----
    //
    // ⚠️ **回填跑在平台作用域下**（抽佣流水是跨租户的），
    // `CommissionService.backfill()` 内部自己 `tenantContext.run(platformScope())`。
    const firstRun = await commission.backfill();

    // ⚠️ **回填是幂等的**（护栏 N6）：再跑一遍，行数不变。
    const before = await asPlatform(() => prisma.commissionEntry.count());
    const secondRun = await commission.backfill();
    const after = await asPlatform(() => prisma.commissionEntry.count());
    expect(after).toBe(before);
    // ⚠️ **第二遍什么都不该新建**：第一遍建过的行原样保留。
    expect(secondRun.commissionCreated).toBe(0);
    expect(secondRun.reversalCreated).toBe(0);

    // ---- 取报表（区间与流水用同一个） ----
    const report = await fetchWindowReport(adminToken, window);

    // ⚠️ **报表的期望值（绝对值）**：
    //    - 抽佣收入（毛额）= 100（①）+ 150（②）+ 250（③）= 500
    //      ⚠️ **④ 没付过钱 → 不算**；**⑤ 零额 → 算 0**。
    //    - 冲回 = 150（只有 ② 有 `refundedAt`）
    //      ⚠️ **③ 的 `refundedAt` 为 null → 报表同样跳过**（口径一致）。
    expect(report.commissionRevenue).toBe(500);
    expect(report.reversal).toBe(150);

    // ---- 取流水的区间聚合 ----
    //
    // ⚠️ **流水表用「带符号的 amount 单列求和」** = 毛额 − 冲回。
    const entries = await asPlatform(() =>
      prisma.commissionEntry.findMany({
        where: { occurredAt: { gte: window.from, lt: window.to } },
        orderBy: { occurredAt: 'asc' },
      }),
    );

    // ⚠️ **先断言条数**：条数不对时，求和的断言会给出误导性的期望值。
    //    期望 4 行：① COMMISSION(100) + ② COMMISSION(150) + ③ COMMISSION(250)
    //             + ② REVERSAL(-150)。
    //    ⚠️ **③ 有抽佣行、没有冲回行** —— 它收过钱（`paidAt` 非空），
    //    抽佣要记；但它的 `refundedAt` 为 null → 冲回无法归期 → 跳过。
    //    ⚠️ **④ 不该有任何行**（没付过钱）；**⑤ 不该有行**（零额）。
    expect(entries.length).toBe(4);

    const ledgerSum = entries.reduce((sum, row) => sum + row.amount, 0);

    // ⚠️ **流水里的每一行都要能被说清**（不是「凑出来等于」）：
    //    抽佣 3 行共 500、冲回 1 行 -150。
    const commissionRows = entries.filter((row) => row.type === 'COMMISSION');
    const reversalRows = entries.filter((row) => row.type === 'REVERSAL');
    expect(commissionRows.length).toBe(3);
    expect(reversalRows.length).toBe(1);
    // ⚠️ **抽佣行之和 == 报表的毛额抽佣**：500。
    expect(commissionRows.reduce((sum, row) => sum + row.amount, 0)).toBe(500);
    // ⚠️ **冲回金额必须是负数**（护栏 N2）—— 不取负的话净额会翻倍。
    expect(reversalRows[0].amount).toBe(-150);

    // ---- 逐单核对：哪一单有几行 ----
    //
    // ⚠️ **这一步是「总数断言」的加强版**：只断言「4 行、合计 350」的话，
    // 「① 多了一行、③ 少了一行」也能凑出同一个数。
    const rowsOf = (orderId: string) =>
      entries.filter((row) => row.orderId === orderId);

    // ① 一条 COMMISSION，100
    expect(rowsOf(paidOrderId).length).toBe(1);
    expect(rowsOf(paidOrderId)[0].type).toBe('COMMISSION');
    expect(rowsOf(paidOrderId)[0].amount).toBe(100);

    // ② 一条 COMMISSION(150) + 一条 REVERSAL(-150)
    expect(rowsOf(refundedOrderId).length).toBe(2);
    expect(
      rowsOf(refundedOrderId).find((row) => row.type === 'COMMISSION')?.amount,
    ).toBe(150);
    expect(
      rowsOf(refundedOrderId).find((row) => row.type === 'REVERSAL')?.amount,
    ).toBe(-150);

    // ③ **只有抽佣行、没有冲回行**（`refundedAt` 为 null → 冲回无法归期）
    expect(rowsOf(undatedRefundOrderId).length).toBe(1);
    expect(rowsOf(undatedRefundOrderId)[0].type).toBe('COMMISSION');
    expect(rowsOf(undatedRefundOrderId)[0].amount).toBe(250);

    // ④ **一行都没有**（护栏 N4：没付过钱 → 没有抽佣）
    expect(rowsOf(unpaidOrderId).length).toBe(0);

    // ⑤ **一行都没有**（护栏 N11：零额 → 不产生流水行）
    expect(rowsOf(zeroAmountOrderId).length).toBe(0);

    // ⚠️ **对账的核心断言**：流水净额 == 报表的「抽佣收入 − 冲回」。
    expect(ledgerSum).toBe(report.commissionRevenue - report.reversal);
    // ⚠️ **把期望值也写出来**（不只看红绿）：350。
    expect(ledgerSum).toBe(350);

    // ---- 归期口径也要对得上 ----
    //
    // ⚠️ **`occurredAt` 必须与报表的归期口径逐字一致**：
    //    抽佣按 `paidAt`、冲回按 `refundedAt`。
    for (const row of entries) {
      expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(
        window.from.getTime(),
      );
      expect(row.occurredAt.getTime()).toBeLessThan(window.to.getTime());
    }
    const reversalRow = reversalRows[0];
    expect(reversalRow.occurredAt.getTime()).toBe(
      insideWindow(window, 20).getTime(),
    );

    // ---- 租户隔离：别的租户查不到这家的流水 ----
    //
    // ⚠️ **护栏 N12 的隔离面**：`CommissionEntry` 登记在 `TENANT_SCOPED_MODELS` 里，
    // 别的租户在租户作用域下查它，扩展会自动带上 `tenantId` 条件 → 查不到。
    const seenByOther = await asTenant(other.tenantId, () =>
      prisma.commissionEntry.findMany({
        where: { occurredAt: { gte: window.from, lt: window.to } },
      }),
    );
    expect(seenByOther.length).toBe(0);

    // ⚠️ **平台作用域能看到全部**（跨租户聚合是台账的职责）。
    const seenByPlatform = await asPlatform(() =>
      prisma.commissionEntry.findMany({
        where: { occurredAt: { gte: window.from, lt: window.to } },
      }),
    );
    expect(seenByPlatform.length).toBe(4);

    // ---- 回填的跳过计数也要报出来 ----
    //
    // ⚠️ **不静默**：运维要看到「有多少历史退款被跳过了」。
    expect(firstRun.skippedUndatedRefund).toBeGreaterThanOrEqual(1);
    expect(firstRun.skippedZeroAmount).toBeGreaterThanOrEqual(1);
  });

  it('⚠️ 支付/退款的写入路径：一条抽佣行 + 一条负数冲回行', async () => {
    // ⚠️ **为什么单独一条**：对账用例走的是**回填**路径 ——
    //    回填会自己建行，所以「支付时不写流水」（F1）这类缺陷
    //    在对账用例里**看不出来**（回填把行补上了）。
    //    这一条直接走**运行时写入路径**（与 `payment.service.ts` 调的是同一个方法），
    //    才能把「支付成功 → 一条 COMMISSION 行」这条护栏真的锁住。
    const merchant = await createMerchant(app, prisma);
    const window = nextWindow();

    // ---- 支付成功 → 一条 COMMISSION 行 ----
    const paidOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      totalAmount: 20000,
      commissionRate: 500,
      commissionAmount: 100,
      paidAt: insideWindow(window, 10),
    });
    const paidAt = insideWindow(window, 10);

    await asTenant(merchant.tenantId, () =>
      prisma.$transaction(async (tx) => {
        await commission.recordCommissionInTx(
          tx,
          {
            id: paidOrderId,
            tenantId: merchant.tenantId,
            orderNo: 'ORD-支付成功',
            totalAmount: 20000,
            commissionRate: 500,
            commissionAmount: 100,
          },
          paidAt,
        );
      }),
    );

    // ---- 退款成功 → 一条 REVERSAL 行（金额为负） ----
    const refundedOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.REFUNDED,
      totalAmount: 30000,
      commissionRate: 500,
      commissionAmount: 150,
      paidAt: insideWindow(window, 11),
      refundedAt: insideWindow(window, 20),
    });
    const refundedAt = insideWindow(window, 20);

    await asTenant(merchant.tenantId, () =>
      prisma.$transaction(async (tx) => {
        await commission.recordReversalInTx(
          tx,
          {
            id: refundedOrderId,
            tenantId: merchant.tenantId,
            orderNo: 'ORD-退款成功',
            totalAmount: 30000,
            commissionRate: 500,
            commissionAmount: 150,
          },
          refundedAt,
        );
      }),
    );

    // ---- 重复写入同一笔 → 不产生第二行（护栏 N3） ----
    //
    // ⚠️ **幂等**：靠 `@@unique([orderId, type])` + 「先查后插」。
    // 这里重放同一个订单的抽佣写入 —— 行数必须不变。
    await asTenant(merchant.tenantId, () =>
      prisma.$transaction(async (tx) => {
        await commission.recordCommissionInTx(
          tx,
          {
            id: paidOrderId,
            tenantId: merchant.tenantId,
            orderNo: 'ORD-支付成功',
            totalAmount: 20000,
            commissionRate: 500,
            commissionAmount: 100,
          },
          paidAt,
        );
      }),
    );

    // ---- 零额订单 → 不产生行（护栏 N11） ----
    const zeroOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      totalAmount: 40000,
      commissionRate: 0,
      commissionAmount: 0,
      paidAt: insideWindow(window, 12),
    });

    await asTenant(merchant.tenantId, () =>
      prisma.$transaction(async (tx) => {
        await commission.recordCommissionInTx(
          tx,
          {
            id: zeroOrderId,
            tenantId: merchant.tenantId,
            orderNo: 'ORD-零额',
            totalAmount: 40000,
            commissionRate: 0,
            commissionAmount: 0,
          },
          insideWindow(window, 12),
        );
      }),
    );

    const rows = await asPlatform(() =>
      prisma.commissionEntry.findMany({
        where: { occurredAt: { gte: window.from, lt: window.to } },
        orderBy: { occurredAt: 'asc' },
      }),
    );

    // ⚠️ **恰好两行**：支付成功一行、退款成功一行。
    //    重复写入没多出第三行；零额订单没多出第四行。
    expect(rows.length).toBe(2);

    const commissionRow = rows.find((row) => row.type === 'COMMISSION');
    const reversalRow = rows.find((row) => row.type === 'REVERSAL');
    expect(commissionRow).toBeDefined();
    expect(reversalRow).toBeDefined();

    // ⚠️ **护栏 N1**：一条 COMMISSION 行，金额 = 抽佣快照，`occurredAt` = 支付时间。
    expect(commissionRow!.orderId).toBe(paidOrderId);
    expect(commissionRow!.amount).toBe(100);
    expect(commissionRow!.occurredAt.getTime()).toBe(paidAt.getTime());
    expect(commissionRow!.rateBps).toBe(500);
    expect(commissionRow!.baseAmount).toBe(20000);

    // ⚠️ **护栏 N2**：一条 REVERSAL 行，金额 = **负的**抽佣快照，
    // `occurredAt` = 退款时间。
    expect(reversalRow!.orderId).toBe(refundedOrderId);
    expect(reversalRow!.amount).toBe(-150);
    expect(reversalRow!.occurredAt.getTime()).toBe(refundedAt.getTime());

    // ⚠️ **护栏 N3**：重复写入不产生第二条 —— 上面只查出了 1 行 COMMISSION。
    expect(rows.filter((row) => row.type === 'COMMISSION').length).toBe(1);

    // ⚠️ **护栏 N11**：零额订单没有任何行。
    expect(rows.filter((row) => row.orderId === zeroOrderId).length).toBe(0);

    // ⚠️ **护栏 N4**：没付过钱的订单不会有抽佣行 ——
    //    写入方法只在「支付成功」那条路上被调用，这里显式验证一次。
    const unpaidOrderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PENDING_PAYMENT,
      totalAmount: 50000,
      commissionRate: 500,
      commissionAmount: 250,
      paidAt: null,
    });
    const rowsAfter = await asPlatform(() =>
      prisma.commissionEntry.findMany({
        where: { occurredAt: { gte: window.from, lt: window.to } },
      }),
    );
    expect(
      rowsAfter.filter((row) => row.orderId === unpaidOrderId).length,
    ).toBe(0);
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
  // ============================================================
  // 抽佣明细端点
  // ============================================================

  it('GET /platform/commissions：平台超管 → 200，且按商家的净抽佣 == 该商家的明细之和', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const window = nextWindow();

    const orderId = await seedOrder(merchant.tenantId, window, {
      status: OrderStatus.PAID,
      totalAmount: 10000,
      commissionRate: 500,
      commissionAmount: 500,
      paidAt: insideWindow(window, 5),
    });

    // ⚠️ **直接造流水行**：这里要验的是**端点**（鉴权、聚合、区间校验），
    //    写入路径由「对账 e2e」与 `payment.e2e-spec.ts` 的端到端用例负责。
    //    直接造还避免了一个顺序耦合：本用例若先跑回填，
    //    对账用例的 `firstRun` 计数就会变成 0。
    await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId: merchant.tenantId,
          orderId,
          orderNo: `ORD-${unique()}`,
          type: CommissionEntryType.COMMISSION,
          amount: 500,
          rateBps: 500,
          baseAmount: 10000,
          occurredAt: insideWindow(window, 5),
        },
      }),
    );

    const response = await http(app)
      .get(
        `/api/v1/platform/commissions?from=${window.from.toISOString()}&to=${window.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = response.body as CommissionLedgerBody;

    // ⚠️ **净额由后端算**：前端拿到 `netAmount` 直接展示。
    //    这里的断言是「后端自己算的净额 == 明细行之和」——
    //    端点自己加总一遍的话这里就会不一致。
    expect(body.byMerchant).toHaveLength(1);
    expect(body.byMerchant[0].tenantId).toBe(merchant.tenantId);
    expect(body.byMerchant[0].netAmount).toBe(500);
    expect(body.byMerchant[0].entryCount).toBe(1);
    expect(body.byMerchant[0].reversalCount).toBe(0);
    // ⚠️ **商家名不是 tenantId** —— 是另查 `Tenant` 拿到的名字与子域名
    const tenant = await asPlatform(() =>
      prisma.tenant.findUnique({ where: { id: merchant.tenantId } }),
    );
    expect(body.byMerchant[0].tenantName).toBe(tenant?.name);
    expect(body.byMerchant[0].subdomain).toBe(merchant.subdomain);

    const sum = body.entries.reduce((acc, e) => acc + e.amount, 0);
    expect(sum).toBe(body.byMerchant[0].netAmount);
  });

  it('GET /platform/commissions：商家账号 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .get('/api/v1/platform/commissions')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);
  });

  it('GET /platform/commissions：没登录 → 401', async () => {
    await http(app).get('/api/v1/platform/commissions').expect(401);
  });

  it('GET /platform/commissions：区间非法（from >= to）→ 400', async () => {
    const adminToken = await loginPlatformAdmin();

    // ⚠️ 与 `GET /platform/reports` 的行为一致：区间不合法就响亮地报错，
    // 而不是返回一串 0 让调用方以为「这段时间没抽佣」。
    await http(app)
      .get(
        '/api/v1/platform/commissions?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      )
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
