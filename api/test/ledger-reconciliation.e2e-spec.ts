import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import {
  CommissionEntryType,
  OrderStatus,
  PayoutKind,
  PayoutStatus,
  ReceiptType,
} from '@prisma/client';
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
 * 账目口径收口（阶段 5i Task 3）的 e2e：平台收入报表的抽佣两个数
 * 从 `orders` 聚合切到 `commission_entries` 聚合。
 *
 * ⚠️ **本文件的核心是「让两套口径产生不同的结果」**：
 *   如果测试数据在两套口径下算出来一样，那么同一个断言切前切后都过
 *   → 用例**测不出有没有切**。所以这里造的是「订单支付期与流水归期
 *   不在同一期」的数据 —— 旧口径按 `orders.paidAt` 归期，新口径按
 *   `commission_entries.occurredAt` 归期，两者必然给出不同的数。
 *
 * ⚠️ **必须造有佣金的订单**：零佣金订单在两套口径下都是 0 → 测了等于没测。
 *   办法是让商家订阅**试用套餐**（种子里的 `trial` 套餐，`commissionBps = 500`
 *   即 5%），下单时订单才会带上非零的 `commissionAmount`。
 *
 * ⚠️ **每个用例用自己独立的商家**：报表是**平台维度**的聚合，
 *   同一个商家在同一个区间造数据，用例之间会互相污染。
 *
 * ⚠️ **月份用 2023-01 ~ 2023-11（无人占用的历史月份）**：
 *   报表是**平台维度**的聚合 → 别的 e2e 文件在同一个月份造了流水，
 *   我的断言就不再是绝对值了（只能写成「比基线多多少」，
 *   那样测的就不是「算得对不对」而是「差值算得对不对」）。
 *   `billing-report.e2e-spec.ts` 用的 2020-2022 那批窗口、
 *   `settlement.e2e-spec.ts` 用的 2024-01 ~ 2025-07、
 *   `payout.e2e-spec.ts` 与 `payout-execution.e2e-spec.ts`
 *   用的 2025-08 ~ 2026-09 —— **都占满了**。
 *   2023-01 ~ 2023-11 是全库唯一没有别的文件写流水的时间段
 *   （`settlement.e2e-spec.ts` 只用到 2023-12）。
 *   ⚠️ 这也是**绝对值断言的前提**：没有别人的数据，
 *   「8 月的抽佣收入是 0」才真的只能是 0。
 *
 * ⚠️ **文件后半段是商家侧对账单的 e2e（阶段 5i Task 5）** ——
 *   护栏 S1–S4 / S7（编号见设计文档 §十）。那一段的月份用
 *   **2025-08 ~ 2026-02**：与前面的报表用例不是同一套口径
 *   （报表是平台维度聚合，对账单是商家维度）→ 断言形态不同
 *   （对账单可以断言**绝对值**，因为它只算自家账）。
 *   ⚠️ **避开 2025-03 / 2025-04**：`settlement.e2e-spec.ts`
 *   对这两个月做过「**批量**生成（不点名商家）」并断言
 *   `created === 1` —— 往那两个月造流水会带偏它。
 *   ⚠️ **三态那条用例用 2023-04** —— 整个 `test/` 目录都没用过这个月份
 *   （2023-04 ~ 2023-07 / 2023-10 全库无人用）→ 不撞任何别的文件。
 */

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

/** 一个自然月的区间（左闭右开） */
interface Period {
  label: string;
  from: Date;
  to: Date;
}

/** 造一个自然月区间 */
function month(label: string): Period {
  const [year, m] = label.split('-').map(Number);
  return {
    label,
    from: new Date(Date.UTC(year, m - 1, 1)),
    to: new Date(Date.UTC(year, m, 1)),
  };
}

/** 区间内的某个时刻（避开边界） */
function inside(period: Period, offsetDays: number): Date {
  return new Date(period.from.getTime() + offsetDays * DAY_MS);
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

/** 商家侧对账单的一期（列表与详情共用的字段） */
interface StatementPeriodView {
  period: string;
  statementId: string | null;
  statementStatus: string | null;
  /** 货款净额（实时聚合，带符号） */
  receiptAmount: number;
  receiptCount: number;
  /** 佣金净额（取结算单的冻结值）；null = 没有结算单 */
  commissionAmount: number | null;
  commissionEntryCount: number;
  /** 应结 = 货款净额 − 佣金净额；null = 佣金未知 */
  payableAmount: number | null;
  /** 已出款（`PAID` 的出款单之和） */
  paidAmount: number;
  /** 在途（`REQUESTED` / `APPROVED` / `PROCESSING` 的出款单之和） */
  inFlightAmount: number;
  /** 待出款；null = 应结未知 */
  pendingAmount: number | null;
  /** 超付（已出款 > 应结时成立） */
  overpaidAmount: number;
  /** 能申请的出款类型；null = 不能申请 */
  applicableKind: 'NORMAL' | 'SUPPLEMENT' | null;
  /** 不能申请的原因；null = 能申请 */
  blockedReason: string | null;
}

/** 商家侧对账单详情（汇总 + 两段明细） */
interface StatementDetailBody extends StatementPeriodView {
  commissionEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    baseAmount: number;
    rateBps: number;
    amount: number;
    occurredAt: string;
  }>;
  receiptEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
    payoutStatus: 'IN_FLIGHT' | 'PAID' | null;
  }>;
}

/** 出款页「可申请周期」的一行 */
interface AvailablePeriodBody {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  statementStatus: string | null;
  alreadyApplied: boolean;
  appliedKind: string | null;
  supplementAvailable: boolean;
  supplementAmount: number | null;
}

/** 出款单的一行（商家侧） */
interface PayoutBody {
  id: string;
  kind: string;
  periodLabel: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  status: string;
  paidAt: string | null;
}

describe('账目口径收口：报表切到流水口径 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  /**
   * 平台超管的 token。
   *
   * ⚠️ **只登一次**：商家侧的夹具要生成 / 确认结算单，
   *   每条用例都重新登录会拖慢整套 e2e（登录要走密码哈希校验）。
   *
   * ⚠️ **名字与用例里的局部 `adminToken` 刻意不同** ——
   *   前面 4 条报表用例各自 `const adminToken = await loginPlatformAdmin()`，
   *   同名会遮蔽（shadow）这个模块级的变量，读代码时容易看错用的是哪个。
   */
  let platformAdminToken: string;

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
    platformAdminToken = await loginPlatformAdmin();
  });

  afterAll(async () => {
    await app.close();
  });

  /** 在平台作用域里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
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
    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * 造一个商家，并让他订阅**试用套餐**。
   *
   * ⚠️ **为什么必须订阅**：抽佣费率来自商家的当前套餐
   *   （`order.service.ts` 的 `quota.currentPlan(tenantId)?.commissionBps`）。
   *   没有订阅 → 费率 0 → 订单的 `commissionAmount` 是 0 →
   *   两套口径下这一单都是 0，测了等于没测。
   *
   * ⚠️ **试用套餐是种子里的 `trial` 套餐**（`commissionBps = 500`，
   *   即 5%），见 `prisma/seed.ts` 的 `seedTrialPlan()`。
   */
  async function createMerchantWithTrialPlan(): Promise<{
    token: string;
    tenantId: string;
  }> {
    const merchant = await createMerchant(app, prisma);

    const trial = await asPlatform(() =>
      prisma.plan.findFirst({ where: { code: 'trial' } }),
    );
    if (!trial) {
      throw new Error('种子里的试用套餐（code=trial）不存在，测试无法继续');
    }

    // ⚠️ **不断言响应体** —— 这里只需要「订阅成功」这个事实（`expect(201)` 已经断言了），
    //    响应体本身没有信息量。
    await http(app)
      .post('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ planId: trial.id })
      .expect(201);

    return { token: merchant.token, tenantId: merchant.tenantId };
  }

  /**
   * 造一笔订单。
   *
   * ⚠️ **`paidAt` 与流水的 `occurredAt` 是两个独立的字段** ——
   *   这正是本文件要测的那件事：两套口径按各自的时间字段归期。
   */
  async function seedOrder(
    tenantId: string,
    options: {
      totalAmount?: number;
      commissionAmount?: number;
      paidAt: Date;
      refundedAt?: Date | null;
      status?: OrderStatus;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `LEDGER-ORD-${unique()}`,
          status: options.status ?? OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 20000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: 500,
          commissionAmount: options.commissionAmount ?? 1000,
          paidAt: options.paidAt,
          refundedAt: options.refundedAt ?? null,
        },
      }),
    );
    return created.id;
  }

  /** 造一条抽佣流水（直接插库，不跑支付链路） */
  async function seedEntry(
    tenantId: string,
    orderId: string,
    options: {
      type: CommissionEntryType;
      amount: number;
      occurredAt: Date;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId,
          orderNo: `LEDGER-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          rateBps: 500,
          baseAmount: 20000,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 拉报表 */
  async function fetchReport(
    token: string,
    period: Period,
  ): Promise<ReportBody> {
    const response = await http(app)
      .get('/api/v1/platform/reports')
      .query({
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      })
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as ReportBody;
  }

  // ============================================================
  // 商家侧对账单的夹具（阶段 5i Task 5）
  // ============================================================

  /**
   * 造一笔货款流水（直接插库，不跑支付链路）。
   *
   * ⚠️ **必须先有订单**：`merchant_receipts.orderId` 是指向 `orders` 的
   *   `Restrict` 外键。
   *
   * ⚠️ **`SALE_REVERSAL` 的金额是负数** —— 货款冲回是负数，
   *   同一期的净额可能是负数（那是合法结果，不是错误）。
   */
  async function seedReceipt(
    tenantId: string,
    orderId: string,
    options: { type: ReceiptType; amount: number; occurredAt: Date },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.merchantReceipt.create({
        data: {
          tenantId,
          orderId,
          orderNo: `LEDGER-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 生成结算单（平台侧，显式点名商家） */
  async function generateStatement(
    adminToken: string,
    period: string,
    tenantId: string,
  ): Promise<string> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period, tenantId })
      .expect(200);
    const body = response.body as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    return body.items[0].id;
  }

  /** 确认结算单（平台侧） */
  async function confirmStatement(
    adminToken: string,
    statementId: string,
  ): Promise<void> {
    await http(app)
      .post(`/api/v1/platform/settlements/${statementId}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
  }

  /** 商家填收款账户（申请出款的前置条件） */
  async function setupPayoutAccount(token: string): Promise<void> {
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);
  }

  /** 商家申请出款 */
  async function applyPayout(
    token: string,
    period: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${token}`)
      .send({ period })
      .expect(201);
    return response.body as PayoutBody;
  }

  /** 平台审批通过 */
  async function approvePayout(
    adminToken: string,
    id: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .post(`/api/v1/platform/payouts/${id}/approve`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  /**
   * 等一个条件成立（轮询）。
   *
   * ⚠️ **间隔 100ms、超时 20 秒** —— 与 `payout-execution.e2e-spec.ts`
   *   同款：出款要经过「审批 → 入队 → worker 消费 → 调渠道 → 落状态」。
   */
  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 20_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  /**
   * 等这张出款单进入指定状态（`PAID` = 钱真的打出去了）。
   *
   * ⚠️ **返回最后一次读到的单据**，调用方可以直接断言它的金额 ——
   *   只返回 `boolean` 的话，断言就落不到「到底打了多少钱」上。
   */
  async function waitForPayoutStatus(
    token: string,
    id: string,
    status: PayoutStatus,
    timeoutMs = 20_000,
  ): Promise<PayoutBody | null> {
    let latest: PayoutBody | null = null;
    const ok = await waitFor(async () => {
      const response = await http(app)
        .get(`/api/v1/merchant/payouts/${id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      latest = response.body as PayoutBody;
      return latest.status === status;
    }, timeoutMs);
    return ok ? latest : null;
  }

  /** 拉商家侧对账单列表 */
  async function fetchStatementList(
    token: string,
  ): Promise<StatementPeriodView[]> {
    const response = await http(app)
      .get('/api/v1/merchant/statements')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as StatementPeriodView[];
  }

  /** 拉商家侧对账单某一期的详情 */
  async function fetchStatementDetail(
    token: string,
    period: string,
  ): Promise<StatementDetailBody> {
    const response = await http(app)
      .get(`/api/v1/merchant/statements/${period}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as StatementDetailBody;
  }

  /**
   * 拉商家侧对账单某一期的详情，**不断言状态码**。
   *
   * ⚠️ **为什么要有这个「不检查状态码」的版本**：
   *   对账单的详情接口里有 **S2 自检** —— 明细加总与佣金净额不一致时
   *   **直接抛错 → 接口 500**。这在生产是对的（宁可 500 也不能让商家
   *   自己加总发现差 1 分），但在测试里有个副作用：
   *   **一旦口径错了，接口先 500，`expect(200)` 先挂**，
   *   后面那些「条数 / 归属」的断言**根本没机会跑** →
   *   用例只能证明「接口炸了」，不能证明「是口径不对导致的」。
   *
   * ⚠️ **这里的用法**：先看状态码与 body，再把**口径断言**
   *   （条数、归属、发生时间）写在前面 → 口径错时挂的是
   *   **那条讲口径的断言**，而不是一个笼统的 500。
   */
  async function fetchStatementDetailRaw(
    token: string,
    period: string,
  ): Promise<{ status: number; body: StatementDetailBody }> {
    const response = await http(app)
      .get(`/api/v1/merchant/statements/${period}`)
      .set('authorization', `Bearer ${token}`);
    return {
      status: response.status,
      body: response.body as StatementDetailBody,
    };
  }

  /** 拉出款页的「可申请周期」 */
  async function fetchAvailablePeriods(
    token: string,
  ): Promise<AvailablePeriodBody[]> {
    const response = await http(app)
      .get('/api/v1/merchant/payouts/available-periods')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as AvailablePeriodBody[];
  }

  /**
   * 造一个「有货款流水 + 有抽佣流水 + 有收款账户」的商家。
   *
   * ⚠️ **货款与抽佣各用一笔订单**：流水有指向 `orders` 的 `Restrict` 外键，
   *   且 `merchant_receipts` 上有 `@@unique([orderId, type])`。
   *
   * ⚠️ **`commissionAmount = 0` 时不造抽佣流水** ——
   *   零额的抽佣流水会让结算单的 `entryCount` 多一笔，
   *   而「佣金明细条数」是要被断言的。
   */
  async function setupMerchantWithPeriod(
    period: Period,
    options: {
      receiptAmount: number;
      commissionAmount: number;
      /** 是否生成结算单（默认生成） */
      withStatement?: boolean;
      /** 是否确认结算单（默认确认） */
      confirmed?: boolean;
    },
  ): Promise<{ token: string; tenantId: string; statementId: string | null }> {
    const merchant = await createMerchantWithTrialPlan();

    const receiptOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: options.receiptAmount,
      commissionAmount: 0,
      paidAt: inside(period, 10),
    });
    await seedReceipt(merchant.tenantId, receiptOrderId, {
      type: ReceiptType.SALE,
      amount: options.receiptAmount,
      occurredAt: inside(period, 10),
    });

    if (options.commissionAmount !== 0) {
      const entryOrderId = await seedOrder(merchant.tenantId, {
        totalAmount: options.receiptAmount,
        commissionAmount: options.commissionAmount,
        paidAt: inside(period, 10),
      });
      await seedEntry(merchant.tenantId, entryOrderId, {
        type: CommissionEntryType.COMMISSION,
        amount: options.commissionAmount,
        occurredAt: inside(period, 10),
      });
    }

    let statementId: string | null = null;
    if (options.withStatement !== false) {
      statementId = await generateStatement(
        platformAdminToken,
        period.label,
        merchant.tenantId,
      );
      if (options.confirmed !== false) {
        await confirmStatement(platformAdminToken, statementId);
      }
    }

    await setupPayoutAccount(merchant.token);

    return { ...merchant, statementId };
  }

  // ============================================================
  // 用例 1：归期按流水（订单支付期与流水归期不同期）
  // ============================================================

  it('归期按流水：订单在 8 月支付、流水归期在 11 月 → 8 月的抽佣收入是 0', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchantWithTrialPlan();

    const payPeriod = month('2023-08');
    const ledgerPeriod = month('2023-11');

    // ---- 造「订单在 8 月支付、流水归期在 11 月」的数据 ----
    //
    // ⚠️ **这是本文件最关键的一步**：旧口径（读 `orders`，按 `paidAt`）
    //    会把这笔抽佣算进 **8 月**；新口径（读流水，按 `occurredAt`）
    //    **不会**算进 8 月。所以「8 月的抽佣收入是 0」这条断言
    //    **只有真的切了口径才会过**。
    const orderId = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 1000,
      paidAt: inside(payPeriod, 10),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 1000,
      occurredAt: inside(ledgerPeriod, 10),
    });

    // ---- 8 月：不该有抽佣收入（流水的归期不在 8 月）----
    const august = await fetchReport(adminToken, payPeriod);
    expect(august.commissionRevenue).toBe(0);
    expect(august.reversal).toBe(0);
    expect(august.netRevenue).toBe(0);

    // ---- 11 月：这笔抽佣在这里 ----
    const november = await fetchReport(adminToken, ledgerPeriod);
    expect(november.commissionRevenue).toBe(1000);
    expect(november.reversal).toBe(0);
    expect(november.netRevenue).toBe(1000);

    // ⚠️ **再验一次「旧口径会给出什么」**：直接查 `orders` 表，
    //    确认这笔单**确实**有 8 月的抽佣 —— 否则上面那条断言
    //    可能只是因为「造的数据本来就没有佣金」而恒真。
    const order = await asPlatform(() =>
      prisma.order.findFirst({ where: { id: orderId } }),
    );
    expect(order!.commissionAmount).toBe(1000);
    expect(order!.paidAt!.getTime()).toBe(inside(payPeriod, 10).getTime());
  });

  // ============================================================
  // 用例 2：冲回的符号（流水的负数 → 报表的正数）
  // ============================================================

  it('冲回符号：流水里是负数 → 报表的 reversal 是正数', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchantWithTrialPlan();

    const period = month('2023-09');

    // ---- 造一条负数的冲回流水 ----
    //
    // ⚠️ **流水的 `REVERSAL.amount` 恒 ≤ 0**：报表的
    //    `netRevenue = 订阅 + 抽佣 − 冲回` 要的是**正数**才减得掉。
    //    直接把流水的负数填进报表 → 冲回被减两次 → 净收入翻倍。
    const orderId = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 1000,
      paidAt: inside(period, 5),
      refundedAt: inside(period, 20),
      status: OrderStatus.REFUNDED,
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.REVERSAL,
      amount: -1000,
      occurredAt: inside(period, 20),
    });

    const body = await fetchReport(adminToken, period);

    // ⚠️ **必须是正数**：符号写反的话这里是 -1000。
    expect(body.reversal).toBe(1000);
    // ⚠️ **`-0` 不该出现**：冲回为 0 时报表给 0，不是 -0。
    expect(Object.is(body.reversal, -0)).toBe(false);
    // ⚠️ **净额要把冲回减掉**：0 − 1000 = −1000（这一期只有一笔退款）。
    expect(body.commissionRevenue).toBe(0);
    expect(body.netRevenue).toBe(-1000);
  });

  // ============================================================
  // 用例 3：归期按流水（补充）—— 一条流水的归期落在别期
  // ============================================================

  it('归期按流水（补充）：一条流水的归期落在别的期 → 那一期不该有它', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchantWithTrialPlan();

    const ownPeriod = month('2023-01');
    const otherPeriod = month('2023-02');

    // 抽佣流水归期在 2 月，但订单在 1 月支付
    const orderId = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 700,
      paidAt: inside(ownPeriod, 8),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 700,
      occurredAt: inside(otherPeriod, 8),
    });

    // 1 月：不该有它（流的归期在 2 月）
    const january = await fetchReport(adminToken, ownPeriod);
    expect(january.commissionRevenue).toBe(0);

    // 2 月：这笔抽佣在这里
    const february = await fetchReport(adminToken, otherPeriod);
    expect(february.commissionRevenue).toBe(700);
    expect(february.netRevenue).toBe(700);
  });

  // ============================================================
  // 用例 4：冲回与抽佣同月 —— 净额要减掉冲回（不能翻倍）
  // ============================================================

  it('同一期里既有抽佣又有冲回 → 净额 = 抽佣 − 冲回', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchantWithTrialPlan();

    const period = month('2023-03');

    const paidOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 1000,
      paidAt: inside(period, 5),
    });
    await seedEntry(merchant.tenantId, paidOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 1000,
      occurredAt: inside(period, 5),
    });

    const refundedOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 400,
      paidAt: inside(period, 6),
      refundedAt: inside(period, 20),
      status: OrderStatus.REFUNDED,
    });
    await seedEntry(merchant.tenantId, refundedOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 400,
      occurredAt: inside(period, 6),
    });
    await seedEntry(merchant.tenantId, refundedOrderId, {
      type: CommissionEntryType.REVERSAL,
      amount: -400,
      occurredAt: inside(period, 20),
    });

    const body = await fetchReport(adminToken, period);

    // ⚠️ **抽佣是毛额**：1000 + 400 = 1400（包含后来退掉的那笔）。
    expect(body.commissionRevenue).toBe(1400);
    // ⚠️ **冲回是正数**：400。
    expect(body.reversal).toBe(400);
    // ⚠️ **净额要把冲回减掉**：1400 − 400 = 1000。
    //    符号写反的话这里会变成 1800（冲回被减两次）。
    expect(body.netRevenue).toBe(1000);
  });

  // ============================================================
  // 商家侧对账单（阶段 5i Task 5）：护栏 S1–S4 / S7
  //
  // ⚠️ **每条用例用自己独立的商家 + 独立的月份**：
  //   出款单的幂等键是 `(tenantId, periodStart, kind)`，
  //   同商家同月反复造数据会让用例互相污染。
  //
  // ⚠️ **月份避开 2025-03 / 2025-04**：`settlement.e2e-spec.ts`
  //   对这两个月做过「批量生成（不点名商家）」并断言 `created === 1`
  //   → 往那两个月造流水会带偏它。
  // ============================================================

  it('S4：商家看到的三个数与出款页逐分相等（同一期，两边必须一致）', async () => {
    const period = month('2025-08');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });
    expect(merchant.statementId).not.toBeNull();

    // ---- 两个接口同时问同一期 ----
    const list = await fetchStatementList(merchant.token);
    const statement = list.find((item) => item.period === period.label);
    expect(statement).toBeDefined();

    const available = await fetchAvailablePeriods(merchant.token);
    const payoutView = available.find((item) => item.period === period.label);
    expect(payoutView).toBeDefined();

    // ⚠️ **货款净额逐分相等**
    expect(statement!.receiptAmount).toBe(10000);
    expect(payoutView!.receiptAmount).toBe(10000);
    expect(statement!.receiptAmount).toBe(payoutView!.receiptAmount);

    // ⚠️ **佣金净额逐分相等**（结算单的冻结值 = 1000）
    expect(statement!.commissionAmount).toBe(1000);
    expect(payoutView!.commissionAmount).toBe(1000);
    expect(statement!.commissionAmount).toBe(payoutView!.commissionAmount);

    // ⚠️ **应结逐分相等**（货款 − 佣金 = 9000）
    //    ⚠️ 对账单侧的字段叫 `payableAmount`，出款页侧叫 `netAmount` ——
    //    同一件事的两个名字，比的是**同一个数**。
    expect(statement!.payableAmount).toBe(9000);
    expect(payoutView!.netAmount).toBe(9000);
    expect(statement!.payableAmount).toBe(payoutView!.netAmount);

    // ⚠️ **两个页面对这一期的「能不能申请」也要一致**（护栏 S4 的另一半）：
    //    一个说能申请、另一个说不能，比任何一个错都更伤信任。
    expect(statement!.applicableKind).toBe('NORMAL');
    expect(payoutView!.appliedKind).toBeNull();
    expect(payoutView!.alreadyApplied).toBe(false);
  });

  it('S1：商家 A 访问商家 B 的期 → 拿不到 B 的任何数', async () => {
    const period = month('2025-09');

    // ---- 两个商家，同一期，各有各的账 ----
    const b = await setupMerchantWithPeriod(period, {
      receiptAmount: 20000,
      commissionAmount: 3000,
    });
    expect(b.statementId).not.toBeNull();

    const a = await setupMerchantWithPeriod(period, {
      receiptAmount: 5000,
      commissionAmount: 500,
    });
    expect(a.statementId).not.toBeNull();

    // ---- B 自己的账：B 能看到自己的数 ----
    const bDetail = await fetchStatementDetail(b.token, period.label);
    expect(bDetail.receiptAmount).toBe(20000);
    expect(bDetail.commissionAmount).toBe(3000);

    // ⚠️ **记下 B 的明细 id** —— 后面要断言「A 的响应里一根都不是 B 的」。
    //    ⚠️ **不能只断言金额**：`baseAmount` 是订单总额，
    //    两家碰巧用同一个总额时，金额断言就分不出谁是谁了。
    const bReceiptEntryIds = bDetail.receiptEntries.map((e) => e.entryId);
    const bCommissionEntryIds = bDetail.commissionEntries.map((e) => e.entryId);
    expect(bReceiptEntryIds).toHaveLength(1);
    expect(bCommissionEntryIds).toHaveLength(1);

    // ---- A 请求同一期 ----
    //
    // ⚠️ **这一期 A 自己也有流水** —— 断言的落点是「A 看到的是 **A 的** 数，
    //    不是 B 的数」，而不是「A 什么都看不到」。
    //    若租户隔离失效，A 会看到 B 的 20000 / 3000 → 这条会挂。
    const aDetail = await fetchStatementDetail(a.token, period.label);
    expect(aDetail.receiptAmount).toBe(5000);
    expect(aDetail.commissionAmount).toBe(500);
    expect(aDetail.payableAmount).toBe(4500);

    // ⚠️ **A 的明细里一根都不该是 B 的**
    expect(aDetail.receiptEntries).toHaveLength(1);
    expect(aDetail.commissionEntries).toHaveLength(1);
    expect(aDetail.receiptEntries.map((e) => e.entryId)).not.toContain(
      bReceiptEntryIds[0],
    );
    expect(aDetail.commissionEntries.map((e) => e.entryId)).not.toContain(
      bCommissionEntryIds[0],
    );
    // ⚠️ **结算单 id 也不能是 B 的那张**
    expect(aDetail.statementId).not.toBe(b.statementId);
    expect(aDetail.statementId).toBe(a.statementId);

    // ⚠️ **A 的列表里也不能有 B 的期**（两家都有流水 → 都在列表里，
    //    但金额必须各自是各自的）
    const aList = await fetchStatementList(a.token);
    const aView = aList.find((item) => item.period === period.label);
    expect(aView).toBeDefined();
    expect(aView!.receiptAmount).toBe(5000);
    expect(aView!.statementId).toBe(a.statementId);

    // ---- A 访问一个「自己没有流水」的期：别家有流水的那一期 ----
    //
    // ⚠️ **这一期 A 压根没有任何流水** → 对账单必须给出**空账**，
    //    绝不能把别家的数端出来。
    //    ⚠️ **这一期用另一个商家**（`bOther`）—— 上一段已经用 `b` 验过
    //    「两家都有流水时各看各的」；这一段验的是另一种形状：
    //    **A 什么都没有时也不能看到别人的**。
    const otherPeriod = month('2026-03');
    const bOther = await setupMerchantWithPeriod(otherPeriod, {
      receiptAmount: 7000,
      commissionAmount: 700,
    });
    expect(bOther.statementId).not.toBeNull();

    const aOther = await fetchStatementDetail(a.token, otherPeriod.label);
    expect(aOther.receiptAmount).toBe(0);
    expect(aOther.receiptCount).toBe(0);
    // ⚠️ **佣金也是 null（不是 0）** —— 「佣金是 0」与「佣金还没算」是两回事
    expect(aOther.commissionAmount).toBeNull();
    expect(aOther.payableAmount).toBeNull();
    expect(aOther.statementId).toBeNull();
    expect(aOther.statementStatus).toBeNull();
    // ⚠️ **明细也是空的**
    expect(aOther.commissionEntries).toHaveLength(0);
    expect(aOther.receiptEntries).toHaveLength(0);
    // ⚠️ **B 这一期的流水 id 一个都不该出现**
    const bOtherDetail = await fetchStatementDetail(
      bOther.token,
      otherPeriod.label,
    );
    expect(bOtherDetail.receiptEntries).toHaveLength(1);
    expect(aOther.receiptEntries.map((e) => e.entryId)).not.toContain(
      bOtherDetail.receiptEntries[0].entryId,
    );

    // ⚠️ **A 的列表里不该有这一期**（A 在这一期没有货款流水）
    const aListAfter = await fetchStatementList(a.token);
    expect(aListAfter.find((item) => item.period === otherPeriod.label)).toBe(
      undefined,
    );
  });

  it('S2：抽佣明细加总 = 佣金净额（商家自己加总能对上）', async () => {
    const period = month('2025-10');
    // ⚠️ **先不生成结算单** —— 下面三笔抽佣流水要**在结算单生成之前**造，
    //    否则结算单的明细关联（冻结的）里没有它们，
    //    而 `recalculate` 对已 `CONFIRMED` 的单是 409。
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 0,
      withStatement: false,
    });
    expect(merchant.statementId).toBeNull();

    // ---- 这一期造两笔抽佣 + 一笔冲回，让加总不是「一笔对一笔」 ----
    const orderA = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 1000,
      paidAt: inside(period, 5),
    });
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 1000,
      occurredAt: inside(period, 5),
    });

    const orderB = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 500,
      paidAt: inside(period, 6),
    });
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 500,
      occurredAt: inside(period, 6),
    });

    const orderC = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 800,
      paidAt: inside(period, 7),
      refundedAt: inside(period, 20),
      status: OrderStatus.REFUNDED,
    });
    await seedEntry(merchant.tenantId, orderC, {
      type: CommissionEntryType.REVERSAL,
      amount: -800,
      occurredAt: inside(period, 20),
    });

    // ---- 流水齐了再出结算单并确认 ----
    const statementId = await generateStatement(
      platformAdminToken,
      period.label,
      merchant.tenantId,
    );
    await confirmStatement(platformAdminToken, statementId);

    const detail = await fetchStatementDetail(merchant.token, period.label);

    // ---- 商家自己把明细加一遍 ----
    const sum = detail.commissionEntries.reduce((acc, e) => acc + e.amount, 0);
    // ⚠️ **加总要等于接口返回的佣金净额**（不是等于我们自己造的数）
    expect(sum).toBe(detail.commissionAmount);
    // ⚠️ **具体值**：1000 + 500 − 800 = 700
    expect(detail.commissionAmount).toBe(700);
    expect(sum).toBe(700);

    // ⚠️ **明细条数也要对上**（3 笔）
    expect(detail.commissionEntries).toHaveLength(3);
    expect(detail.commissionEntryCount).toBe(3);
    // ⚠️ **明细里确实有负数的冲回** —— 符号不能被偷偷取绝对值
    const reversal = detail.commissionEntries.find(
      (e) => e.type === 'REVERSAL',
    );
    expect(reversal).toBeDefined();
    expect(reversal!.amount).toBe(-800);
  });

  it('S3：货款明细加总 = 货款净额（商家自己加总能对上）', async () => {
    const period = month('2025-11');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });
    expect(merchant.statementId).not.toBeNull();

    // ---- 再造两笔货款流水（含一笔冲回）----
    const orderB = await seedOrder(merchant.tenantId, {
      totalAmount: 3000,
      commissionAmount: 0,
      paidAt: inside(period, 12),
    });
    await seedReceipt(merchant.tenantId, orderB, {
      type: ReceiptType.SALE,
      amount: 3000,
      occurredAt: inside(period, 12),
    });

    const orderC = await seedOrder(merchant.tenantId, {
      totalAmount: 2000,
      commissionAmount: 0,
      paidAt: inside(period, 15),
      refundedAt: inside(period, 21),
      status: OrderStatus.REFUNDED,
    });
    await seedReceipt(merchant.tenantId, orderC, {
      type: ReceiptType.SALE_REVERSAL,
      amount: -2000,
      occurredAt: inside(period, 21),
    });

    const detail = await fetchStatementDetail(merchant.token, period.label);

    // ---- 商家自己把货款明细加一遍 ----
    const sum = detail.receiptEntries.reduce((acc, e) => acc + e.amount, 0);
    expect(sum).toBe(detail.receiptAmount);
    // ⚠️ **具体值**：10000 + 3000 − 2000 = 11000
    expect(detail.receiptAmount).toBe(11000);
    expect(sum).toBe(11000);

    // ⚠️ **明细条数**：3 笔（一正一正一负）
    expect(detail.receiptEntries).toHaveLength(3);
    expect(detail.receiptCount).toBe(3);
    // ⚠️ **负数那笔在明细里是负数** —— 符号不能被偷偷取绝对值
    const reversal = detail.receiptEntries.find(
      (e) => e.type === 'SALE_REVERSAL',
    );
    expect(reversal).toBeDefined();
    expect(reversal!.amount).toBe(-2000);
  });

  it('S4：出款页说「可申请补差」时，对账单也说 applicableKind = SUPPLEMENT', async () => {
    const period = month('2025-12');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });
    expect(merchant.statementId).not.toBeNull();

    // ---- 先走一次正常的出款，打到 PAID ----
    const applied = await applyPayout(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);
    expect(applied.kind).toBe(PayoutKind.NORMAL);
    expect(applied.netAmount).toBe(8500);

    const approved = await approvePayout(platformAdminToken, applied.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);

    // ⚠️ **等 worker 真的把钱打出去**（`PAID`）。
    //    只等到 `APPROVED` 的话，「已出款」是 0 → 补差入口不成立 → 测不到东西。
    const paid = await waitForPayoutStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    expect(paid!.paidAt).not.toBeNull();
    expect(paid!.netAmount).toBe(8500);

    // ---- 再回填一笔货款到同一期（没被任何出款单纳入）----
    const backfillOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
      commissionAmount: 0,
      paidAt: inside(period, 20),
    });
    await seedReceipt(merchant.tenantId, backfillOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    // ---- 出款页：说「可申请补差」----
    const available = await fetchAvailablePeriods(merchant.token);
    const view = available.find((item) => item.period === period.label);
    expect(view).toBeDefined();
    expect(view!.supplementAvailable).toBe(true);
    expect(view!.supplementAmount).toBe(5000);
    // ⚠️ **补差入口不能被 `alreadyApplied` 吞掉**（护栏 X8）
    expect(view!.alreadyApplied).toBe(true);
    expect(view!.appliedKind).toBe(PayoutKind.NORMAL);

    // ---- 对账单：必须说同一件事 ----
    const detail = await fetchStatementDetail(merchant.token, period.label);
    expect(detail.applicableKind).toBe('SUPPLEMENT');
    expect(detail.blockedReason).toBeNull();

    // ⚠️ **已出款 / 在途 / 待出款也要拆得对**：
    //    应结 = 货款 15000 − 佣金 1500 = 13500；已出款 8500 → 待出款 5000
    expect(detail.receiptAmount).toBe(15000);
    expect(detail.commissionAmount).toBe(1500);
    expect(detail.payableAmount).toBe(13500);
    expect(detail.paidAmount).toBe(8500);
    expect(detail.inFlightAmount).toBe(0);
    expect(detail.pendingAmount).toBe(5000);
    expect(detail.overpaidAmount).toBe(0);

    // ⚠️ **回填的那笔在明细里标着「还没出款」**
    const unclaimed = detail.receiptEntries.filter(
      (e) => e.payoutStatus === null,
    );
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].amount).toBe(5000);

    // ⚠️ **被 `PAID` 的出款单纳入的那笔标着「已出款」**
    //
    // ⚠️ **不能只断言 `null` 那条**：那样的话，实现把「所有明细都标 null」
    //    也能过（`unclaimed` 的过滤条件恰好只挑 `null`）→
    //    「已出款」这个口径就**测不出来**。
    //    必须**再钉一条 `PAID`**：实现若把 `PAID` 误标成 `IN_FLIGHT` /
    //    `null`，这里会挂。
    const paidEntry = detail.receiptEntries.find((e) => e.amount === 10000);
    expect(paidEntry).toBeDefined();
    expect(paidEntry!.payoutStatus).toBe('PAID');
    // ⚠️ **货款明细一共两条**：10000（已出款）+ 5000（未出款）
    expect(detail.receiptEntries).toHaveLength(2);
  });

  it('结算单未确认 → 对账单说「不可申请」并给出原因', async () => {
    const period = month('2026-01');
    // ⚠️ **结算单生成了但不确认**（DRAFT）——
    //    DRAFT 的结算单**不是凭证**，任何路径都不能出款。
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
      confirmed: false,
    });
    expect(merchant.statementId).not.toBeNull();

    const detail = await fetchStatementDetail(merchant.token, period.label);

    // ⚠️ **不可申请**
    expect(detail.applicableKind).toBeNull();
    // ⚠️ **必须给出原因**（商家不知道卡在哪一步 → 只能打电话问客服）
    expect(detail.blockedReason).toBeTruthy();
    expect(detail.blockedReason).toContain('尚未确认');
    expect(detail.blockedReason).not.toBe('');

    // ⚠️ **结算单状态是 DRAFT（待确认）**
    expect(detail.statementStatus).toBe('DRAFT');
    expect(detail.statementId).toBe(merchant.statementId);

    // ⚠️ **DRAFT 期不展示抽佣明细**（未确认的账随时会变）
    expect(detail.commissionEntries).toHaveLength(0);
    // ⚠️ **货款明细照常展示**（货款是实时事实）
    expect(detail.receiptEntries).toHaveLength(1);

    // ---- 列表页也要说同样的话 ----
    const list = await fetchStatementList(merchant.token);
    const view = list.find((item) => item.period === period.label);
    expect(view).toBeDefined();
    expect(view!.applicableKind).toBeNull();
    expect(view!.blockedReason).toBeTruthy();
  });

  it('S7：同月内退款 → 已出款 > 应结 → overpaidAmount > 0 且 pendingAmount = 0', async () => {
    const period = month('2026-02');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });
    expect(merchant.statementId).not.toBeNull();

    // ---- 先走一次正常的出款，打到 PAID ----
    const applied = await applyPayout(merchant.token, period.label);
    expect(applied.netAmount).toBe(9000);
    const approved = await approvePayout(platformAdminToken, applied.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);

    const paid = await waitForPayoutStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    expect(paid!.paidAt).not.toBeNull();
    expect(paid!.netAmount).toBe(9000);

    // ---- 同月内发生退款 ----
    //
    // ⚠️ **必须在同一期**：跨月退款时冲回归**退款期**，
    //    原期的货款净额**不变** → 不会超付（设计 §5.4）。
    const refundOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 3000,
      commissionAmount: 300,
      paidAt: inside(period, 25),
      refundedAt: inside(period, 26),
      status: OrderStatus.REFUNDED,
    });
    await seedReceipt(merchant.tenantId, refundOrderId, {
      type: ReceiptType.SALE_REVERSAL,
      amount: -3000,
      occurredAt: inside(period, 26),
    });
    await seedEntry(merchant.tenantId, refundOrderId, {
      type: CommissionEntryType.REVERSAL,
      amount: -300,
      occurredAt: inside(period, 26),
    });

    const detail = await fetchStatementDetail(merchant.token, period.label);

    // ⚠️ **货款净额是实时的**：10000 − 3000 = 7000
    expect(detail.receiptAmount).toBe(7000);
    // ⚠️ **佣金是冻结的**（结算单没重算）→ 仍是 1000
    expect(detail.commissionAmount).toBe(1000);
    // ⚠️ **应结实时变小**：7000 − 1000 = 6000
    expect(detail.payableAmount).toBe(6000);
    // ⚠️ **已出款是审批那一刻的快照** → 仍是 9000
    expect(detail.paidAmount).toBe(9000);

    // ⚠️ **超付**：9000 − 6000 = 3000
    expect(detail.overpaidAmount).toBe(3000);
    expect(detail.overpaidAmount).toBeGreaterThan(0);

    // ⚠️⚠️ **待出款不能是负数**（护栏 S7 的核心）：
    //    max(0, 6000 − 9000 − 0) = 0，而不是 −3000。
    //    若实现写成 `应结 − 已出款` 不截断 → 这里会是 −3000 → 商家看到负数。
    expect(detail.pendingAmount).toBe(0);
    expect(detail.pendingAmount).not.toBeLessThan(0);

    // ⚠️ **超付时不能抛错** —— 商家要能看到自己已超付的事实
    expect(detail.overpaidAmount).toBe(3000);
  });

  // ============================================================
  // 失败注入 I3 / I7 的「装牙齿」用例
  //
  // ⚠️ **为什么这两条要单独写**：上面的用例里，
  //   每个商家**只有一期的流水** → 「这一期的抽佣」与「这个商家全部的抽佣」
  //   算出来**完全一样** → 注入 I3（把明细改成「该商家全部抽佣流水」）
  //   与正确实现**结果相同** → 那条护栏等于「挂 0 条」。
  //   同理，没有「在途的出款单」时，「待出款」与「在途」无关 →
  //   注入 I7（把待出款的计算漏掉在途）也测不出差别。
  //
  // ⚠️ **月份用 2026-04 / 2026-05 / 2026-06**：
  //   本文件已用掉 2025-08 ~ 2026-03；`settlement.e2e-spec.ts` 对
  //   2024-10 / 2024-12 / 2025-03 / 2025-04 做过「全库恰好几张单 /
  //   没有任何流水」的断言 → 那几个月不能碰。
  // ============================================================

  it('I3：商家有多期流水时，抽佣明细只含该期结算单纳入的流水', async () => {
    // ⚠️ **一个商家、两期流水** —— 这是本用例的全部意义：
    //    商家有 2026-04 与 2026-05 两期的抽佣流水，
    //    「这一期的」与「全部的」在条数与金额上**都不相等** →
    //    两种取法能区分开 → 注入 I3 才会被抓住。
    const periodA = month('2026-04');
    const periodB = month('2026-05');
    const merchant = await createMerchantWithTrialPlan();

    // ---- 2026-04：一笔货款 + 一笔抽佣 ----
    const receiptOrderA = await seedOrder(merchant.tenantId, {
      totalAmount: 10000,
      commissionAmount: 0,
      paidAt: inside(periodA, 10),
    });
    await seedReceipt(merchant.tenantId, receiptOrderA, {
      type: ReceiptType.SALE,
      amount: 10000,
      occurredAt: inside(periodA, 10),
    });

    const entryOrderA = await seedOrder(merchant.tenantId, {
      totalAmount: 10000,
      commissionAmount: 1000,
      paidAt: inside(periodA, 10),
    });
    const entryIdA = await seedEntry(merchant.tenantId, entryOrderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 1000,
      occurredAt: inside(periodA, 10),
    });

    // ---- 2026-05：一笔货款 + 两笔抽佣（**净额为 0**）----
    //
    // ⚠️⚠️ **为什么 5 月的抽佣净额是 0**（这是本用例最微妙的一处设计）：
    //
    //   对账单的详情接口里有 **S2 自检** —— 明细加总与佣金净额不一致时
    //   **直接抛错 → 接口 500**。若 5 月的抽佣净额**不是 0**，
    //   注入 I3（明细改成「该商家全部抽佣流水」）后 4 月的明细会变成
    //   「4 月那笔 + 5 月那笔」，加总 ≠ 4 月的佣金净额
    //   → **接口先 500 了** → 下面那条「条数」断言**根本没机会跑**
    //   → 用例只能证明「接口炸了」，不能证明「口径不对」。
    //
    //   把 5 月的抽佣净额做成 0（一笔 +2000、一笔冲回 −2000）之后：
    //   注入 I3 → 4 月的明细变成 3 笔、加总仍是 1000
    //   → **S2 自检照样通过** → 接口正常返回 200
    //   → **「条数」断言实打实地挂掉** ← 这就是「独立的条数/归属断言」
    //   的意义：它不依赖加总，也不会被自检抢跑。
    //
    // ⚠️ **这笔数据本身是现实的**：同一月里有一笔订单成交、又被退掉
    //   （抽佣 +2000、冲回 −2000），净佣金 0 —— 商家那期白忙一场。
    const receiptOrderB = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 0,
      paidAt: inside(periodB, 10),
    });
    await seedReceipt(merchant.tenantId, receiptOrderB, {
      type: ReceiptType.SALE,
      amount: 20000,
      occurredAt: inside(periodB, 10),
    });

    const entryOrderB = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 2000,
      paidAt: inside(periodB, 10),
    });
    const entryIdB = await seedEntry(merchant.tenantId, entryOrderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 2000,
      occurredAt: inside(periodB, 10),
    });

    // ⚠️ **冲回与抽佣同月**：5 月的抽佣净额 = 2000 − 2000 = 0
    const reversalOrderB = await seedOrder(merchant.tenantId, {
      totalAmount: 20000,
      commissionAmount: 2000,
      paidAt: inside(periodB, 15),
      refundedAt: inside(periodB, 20),
      status: OrderStatus.REFUNDED,
    });
    const entryIdBReversal = await seedEntry(
      merchant.tenantId,
      reversalOrderB,
      {
        type: CommissionEntryType.REVERSAL,
        amount: -2000,
        occurredAt: inside(periodB, 20),
      },
    );

    // ---- 两期各自一张已 CONFIRMED 的结算单 ----
    //
    // ⚠️ **必须先造完两期的流水再出单**：`settlement.e2e-spec.ts` 靠
    //   「流水齐了才出单」保证单子不漏笔。这里同理 ——
    //   4 月的单只纳入 4 月那笔、5 月的单只纳入 5 月那笔。
    const statementIdA = await generateStatement(
      platformAdminToken,
      periodA.label,
      merchant.tenantId,
    );
    await confirmStatement(platformAdminToken, statementIdA);

    const statementIdB = await generateStatement(
      platformAdminToken,
      periodB.label,
      merchant.tenantId,
    );
    await confirmStatement(platformAdminToken, statementIdB);

    // ---- 先把「这个商家一共有几笔抽佣流水」钉死 ----
    //
    // ⚠️ **直接查库数一遍**，而不是写死「2」——
    //    写死的话，将来有人往这个商家身上多插一笔流水，
    //    断言会莫名其妙地失败，而失败原因与断言本身无关。
    const allEntries = await asPlatform(() =>
      prisma.commissionEntry.findMany({
        where: { tenantId: merchant.tenantId },
        select: { id: true },
      }),
    );
    // ⚠️ **3 笔**：4 月 1 笔 + 5 月 2 笔（抽佣 + 冲回）
    expect(allEntries).toHaveLength(3);

    // ---- ⚠️⚠️ **「归属」的独立断言：结算单只纳入了它自己那一期** ----
    //
    // ⚠️ **为什么这一段在「调接口」之前**：接口里有 S2 自检
    //   （明细加总 ≠ 佣金净额 → **直接抛错 → 接口 500**）。
    //   注入 I3 后明细会变成「全部两笔」，加总 3000 ≠ 佣金净额 1000
    //   → **接口先 500 了**，接口层的条数断言根本没机会跑 →
    //   那样这条用例只能证明「接口炸了」，不能证明「口径不对」。
    //
    // ⚠️ **所以「条数 / 归属」的判定必须有一份不依赖接口返回的证据**：
    //   `settlement_statement_entries` 就是那张「结算单纳入了哪些流水」的凭证。
    //   断言它**只含 4 月那笔**（条数 1 < 全部 2）→ 这条断言**永远会跑**，
    //   且与「加总」完全无关 → 注入 I3 时它照样能指出问题。
    const includedLinks = await asPlatform(() =>
      prisma.settlementStatementEntry.findMany({
        where: { statementId: statementIdA },
        select: { entryId: true },
      }),
    );
    // ⚠️ **条数 < 该商家全部抽佣流水的条数** —— 这一条把
    //   「这一期」与「全部」在**结构上**分开，不依赖任何金额。
    expect(includedLinks).toHaveLength(1);
    expect(includedLinks.length).toBeLessThan(allEntries.length);
    // ⚠️ **纳入的必须是 4 月那笔，不是 5 月那笔**
    expect(includedLinks[0].entryId).toBe(entryIdA);
    expect(includedLinks[0].entryId).not.toBe(entryIdB);

    // ---- 查 4 月的对账单详情 ----
    //
    // ⚠️ **用「不断言状态码」的版本**：见 `fetchStatementDetailRaw` 的注释。
    //   口径错了的时候（S2 自检炸 → 500），我们要挂在**口径断言**上，
    //   而不是挂在「期望 200 实际 500」上。
    const rawA = await fetchStatementDetailRaw(merchant.token, periodA.label);
    const detailA = rawA.body;

    // ---- ⚠️⚠️ **接口层的条数断言** ----
    //
    // ⚠️ **状态码与「有没有明细」一起断言**：口径错时接口是 500，
    //   body 是错误对象、没有 `commissionEntries` 字段 → 直接断言条数会报
    //   「received value must have a length property」（看不出根因）。
    expect({
      status: rawA.status,
      // ⚠️ **500 的 body 是错误对象**，没有 `commissionEntries` 字段
      hasDetail: Array.isArray(detailA.commissionEntries),
    }).toEqual({ status: 200, hasDetail: true });

    expect(detailA.commissionEntries).toHaveLength(1);
    expect(detailA.commissionEntryCount).toBe(1);
    // ⚠️ **条数 < 该商家全部抽佣流水的条数** —— 接口侧再钉一遍。
    expect(detailA.commissionEntries.length).toBeLessThan(allEntries.length);

    // ---- ⚠️ **归属：只能是 4 月那笔，不能是 5 月那笔** ----
    expect(detailA.commissionEntries[0].entryId).toBe(entryIdA);
    expect(detailA.commissionEntries[0].entryId).not.toBe(entryIdB);
    expect(detailA.commissionEntries[0].entryId).not.toBe(entryIdBReversal);
    // ⚠️ **每一条明细的发生时间都必须落在 2026-04 内**
    for (const entry of detailA.commissionEntries) {
      expect(new Date(entry.occurredAt).getTime()).toBeGreaterThanOrEqual(
        periodA.from.getTime(),
      );
      expect(new Date(entry.occurredAt).getTime()).toBeLessThan(
        periodA.to.getTime(),
      );
    }
    // ⚠️ **5 月那两笔（发生时间在 2026-05）绝不能出现在 4 月的明细里**
    const aprilEntryIds = detailA.commissionEntries.map((e) => e.entryId);
    expect(aprilEntryIds).not.toContain(entryIdB);
    expect(aprilEntryIds).not.toContain(entryIdBReversal);

    // ---- 加总 = 佣金净额（4 月：1000）----
    const sumA = detailA.commissionEntries.reduce(
      (acc, e) => acc + e.amount,
      0,
    );
    expect(sumA).toBe(1000);
    expect(detailA.commissionAmount).toBe(1000);
    expect(sumA).toBe(detailA.commissionAmount);

    // ---- 对照：5 月的详情里只有 5 月那两笔 ----
    //
    // ⚠️ **两边都要对** —— 只断言 4 月的话，实现若「恒返回 4 月那笔」
    //   也能过；断言了 5 月才知道实现是**按期取的**。
    const detailB = await fetchStatementDetail(merchant.token, periodB.label);
    expect(detailB.commissionEntries).toHaveLength(2);
    const mayEntryIds = detailB.commissionEntries.map((e) => e.entryId);
    expect(mayEntryIds).toContain(entryIdB);
    expect(mayEntryIds).toContain(entryIdBReversal);
    expect(mayEntryIds).not.toContain(entryIdA);
    // ⚠️ **5 月的明细加总 = 0**（抽佣 2000 + 冲回 −2000）
    const sumB = detailB.commissionEntries.reduce(
      (acc, e) => acc + e.amount,
      0,
    );
    expect(sumB).toBe(0);
    expect(sumB).toBe(detailB.commissionAmount);
    // ⚠️ **两期的佣金净额不能串**：4 月 1000、5 月 0
    expect(detailA.commissionAmount).toBe(1000);
    expect(detailB.commissionAmount).toBe(0);
  });

  it('I7：有在途的出款单时，待出款要扣掉在途', async () => {
    // ⚠️ **2026-06**：本文件没用过；避开了 `settlement.e2e-spec.ts`
    //   做过「全库恰好几张单」断言的那几个月。
    const period = month('2026-06');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });
    expect(merchant.statementId).not.toBeNull();

    // ---- 申请出款，但**不审批** ----
    //
    // ⚠️ **`REQUESTED` 就是「在途」**：钱还没打出去，
    //   但单子已经占住了这一期 → 商家看到「待出款」时，
    //   必须知道「有一笔钱已经在流程里了」。
    const applied = await applyPayout(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);
    expect(applied.kind).toBe(PayoutKind.NORMAL);
    // ⚠️ **申请这一刻的应结**：10000 − 1000 = 9000
    expect(applied.netAmount).toBe(9000);

    // ---- 回填一笔货款，让「应结」大于「在途」----
    //
    // ⚠️ **为什么非要回填**：出款申请时把这一期的应结**整笔**纳入
    //   （`netAmount = 9000`），若不回填，应结 == 在途 → 待出款 = 0。
    //   0 这个值**区分不了**「正确扣了在途」与「压根没算在途」：
    //   两种实现都给出 0（后者是 `max(0, 9000 − 9000)`）。
    //   回填后应结 14000 > 在途 9000 → 待出款 5000，
    //   **只有扣了在途**才等于 5000。
    const backfillOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
      commissionAmount: 0,
      paidAt: inside(period, 20),
    });
    await seedReceipt(merchant.tenantId, backfillOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    // ---- 查这一期的对账单 ----
    const detail = await fetchStatementDetail(merchant.token, period.label);

    // ---- 货款与佣金（回填后货款变大、佣金是结算单的冻结值）----
    expect(detail.receiptAmount).toBe(15000);
    expect(detail.commissionAmount).toBe(1000);
    // ⚠️ **应结是实时的**：15000 − 1000 = 14000
    expect(detail.payableAmount).toBe(14000);

    // ---- 在途 = 那张 REQUESTED 的单的金额 ----
    expect(detail.inFlightAmount).toBe(9000);
    expect(detail.inFlightAmount).toBe(applied.netAmount);
    // ⚠️ **还没打出去 → 已出款是 0**
    expect(detail.paidAmount).toBe(0);

    // ---- ⚠️⚠️ **核心断言：待出款必须扣掉在途** ----
    //
    // ⚠️ **14000 − 0 − 9000 = 5000**：
    //   漏了在途的话是 14000 − 0 = 14000 → 这里挂。
    expect(detail.pendingAmount).toBe(5000);
    expect(detail.pendingAmount).toBe(
      detail.payableAmount! - detail.paidAmount - detail.inFlightAmount,
    );

    // ---- ⚠️ **独立断言：待出款 ≠ 应结** ----
    //
    // ⚠️ **为什么必须单独写一条**：注入 I7（待出款漏了在途）会让
    //   `pendingAmount` 恰好等于 `payableAmount` —— 只断言「待出款 = 5000」
    //   已经能挂，但**再加一条「两者不等」**能把「在途被算进了待出款」
    //   这件事**独立地**钉死：待出款必须比应结少掉在途那一笔。
    expect(detail.pendingAmount).not.toBe(detail.payableAmount);
    expect(detail.pendingAmount!).toBeLessThan(detail.payableAmount!);

    // ---- 超付为 0（已出款 0 < 应结 14000）----
    expect(detail.overpaidAmount).toBe(0);
  });

  it('三态：在途的出款单 → 货款明细标「出款中」而不是「已出款」', async () => {
    // ⚠️ **2023-04**：**整个 test/ 目录都没用过这个月份**
    //   （2023-01 / 02 / 03 / 08 / 09 / 11 被本文件的报表用例占着，
    //    2023-04 ~ 2023-07 / 2023-10 全库无人用）
    //   → 不撞本文件，也不撞别的 e2e 文件的月份。
    //
    // ⚠️ **必须是「已结束的月份」**：`settlement.service.ts` 的
    //   「周期尚未结束，不能出结算单」闸会把**当月**（2026-10）挡掉 → 400。
    const period = month('2023-04');
    const merchant = await setupMerchantWithPeriod(period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });
    expect(merchant.statementId).not.toBeNull();

    // ---- 申请出款，但**不审批** ----
    //
    // ⚠️ **`REQUESTED` 就是「在途」**：钱还没打出去，但单子已经
    //   占住了这一期的流水（`payout_entries` 里有它的行）。
    //
    // ⚠️ **不审批就不会被推进**：`REQUESTED` → `APPROVED` 只有平台
    //   主动审批才会发生；worker 只消费 `APPROVED` 的单 →
    //   停在这里是安全的、稳定的。
    const applied = await applyPayout(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);
    expect(applied.kind).toBe(PayoutKind.NORMAL);
    expect(applied.netAmount).toBe(9000);

    // ---- 查这一期的对账单 ----
    const detail = await fetchStatementDetail(merchant.token, period.label);

    // ---- ⚠️⚠️ **核心断言：货款明细标「出款中」** ----
    //
    // ⚠️ **这一期只有一笔货款**（`setupMerchantWithPeriod` 造的
    //   那笔 10000）→ 直接断言它，不用先筛。
    expect(detail.receiptEntries).toHaveLength(1);
    expect(detail.receiptEntries[0].amount).toBe(10000);
    // ⚠️ **必须是 `IN_FLIGHT`**：钱还没打，标「已出款」商家会来投诉。
    expect(detail.receiptEntries[0].payoutStatus).toBe('IN_FLIGHT');
    // ⚠️ **独立钉死两条否定断言**：
    //   只断言「是 `IN_FLIGHT`」的话，实现恒返回 `'IN_FLIGHT'`
    //   也能过；这里要保证它**不是**「已出款」、**也不是**「未出款」。
    expect(detail.receiptEntries[0].payoutStatus).not.toBe('PAID');
    expect(detail.receiptEntries[0].payoutStatus).not.toBeNull();

    // ---- 与顶部汇总口径对得上 ----
    //
    // ⚠️ **在途 9000、已出款 0** —— 与明细里那笔标「出款中」是同一件事。
    expect(detail.inFlightAmount).toBe(9000);
    expect(detail.paidAmount).toBe(0);
    expect(detail.payableAmount).toBe(9000);
  });
});
