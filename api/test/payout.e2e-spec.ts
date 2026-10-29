import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import {
  CommissionEntryType,
  OrderStatus,
  PayoutStatus,
  ReceiptType,
  SettlementStatus,
  UserRole,
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
 * 出款（阶段 5h-1）的 e2e。
 *
 * 覆盖的护栏：P1–P10（编号见设计文档 §六·6.1）。
 *
 * ⚠️ **每个用例用自己独立的商家 + 独立的月份**（两层隔离，5g 的同款教训）：
 *   出款单的幂等键是 `(tenantId, periodStart)` ——
 *   同一个商家在同一期反复造数据会让后一个用例拿到前一个用例的单据
 *   （断言互相污染）。
 *
 * ⚠️ **月份必须已结束**（出款与出结算单都要求周期已过）：
 *   服务层用**数据库的时钟**判定「周期是否结束」，
 *   拿不到未来的月份 → 结算单生成会 400「周期尚未结束」。
 *   本文件用的是 **2025-01、2025-08 ~ 2025-12、2026-01 ~ 2026-09**
 *   —— 都在 2026-10 之前，且避开了 5g 的 `settlement.e2e-spec.ts`
 *   占用的 2024-01 ~ 2025-07（尤其是它**批量出单**的 2024-10 / 2024-12 /
 *   2025-04 —— 那个月本文件一旦有商家的抽佣流水，它断言的
 *   「这一期恰好几张单」就会被本文件带偏）。
 *   `billing-report.e2e-spec.ts` 的报表窗口从 2020-01-01 起每 60 天一块、
 *   共 13 块（最后一块是 2021-12-21 → 2022-01-20）—— 都不在这些月份里。
 *
 * ⚠️ **不跑回填**：直接造 `merchant_receipts` 行，不跑支付链路 ——
 *   `ReceiptService.backfill()` 会扫全表 `paidAt` 非空的订单，跨文件影响不可控。
 *
 * ⚠️ **结算单要走真实流程**：出款引用结算单，佣金取**已 CONFIRMED 的结算单**
 *   的 `netAmount` → 必须先 `POST /platform/settlements` 生成，
 *   再 `POST /platform/settlements/:id/confirm`。
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

/** 出款单的一行（响应体） */
interface PayoutBody {
  id: string;
  payoutNo: string;
  tenantId?: string;
  tenantName?: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  status: string;
  requestedAmount: number;
  statementId: string | null;
  requestedBy: string;
  approvedBy: string | null;
  rejectedReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  entries?: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
  }>;
}

/** 列表响应体 */
interface PayoutListBody {
  items: PayoutBody[];
  total: number;
}

/** 可申请周期的响应体 */
interface AvailablePeriodBody {
  period: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  statementStatus: string | null;
  alreadyApplied: boolean;
}

/** 收款账户的响应体 */
interface AccountBody {
  accountName: string;
  bankName: string;
  maskedAccountNo: string;
  updatedAt: string;
}

/**
 * 校验失败时的错误消息。
 *
 * ⚠️ **有全局过滤器时是字符串，没挂过滤器时是字符串数组**：
 *    `AllExceptionsFilter` 会把 `ValidationPipe` 聚合出来的数组用「；」拼成一句，
 *    但本文件没有挂那个过滤器 → 拿到的就是 NestJS 默认的 `{ message: string[] }`。
 *    这里两种形态都兼容。
 */
function errorText(body: unknown): string {
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('；');
  }
  return typeof message === 'string' ? message : '';
}

describe('出款 (e2e)', () => {
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

  /** 在平台作用域里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 在某个租户的作用域里执行一段逻辑（造租户作用域的数据用） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { tenantId, userId: null, role: UserRole.MERCHANT_OWNER },
      async () => fn(),
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
    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * 造一个**员工**账号（`MERCHANT_STAFF`）并登录。
   *
   * ⚠️ **没有「创建员工」的接口** —— 注册接口只能开店主（`MERCHANT_OWNER`），
   *    员工账号只能直接落库。`User` 在租户白名单里 → 必须在**租户作用域**下建，
   *    平台作用域下建会抛 `TenantScopeError`。
   *
   * ⚠️ **登录用 `scope: MERCHANT`**：`roleFilterFor(MERCHANT)` 放行
   *    `MERCHANT_OWNER` 与 `MERCHANT_STAFF` 两种角色。
   */
  async function createMerchantStaff(
    tenantId: string,
  ): Promise<{ token: string; userId: string }> {
    const email = `staff-${unique()}@example.test`;
    const password = 'Passw0rd123';
    const passwordHash = await argon2.hash(password);

    const user = await asTenant(tenantId, () =>
      prisma.user.create({
        data: {
          email,
          passwordHash,
          displayName: '测试员工',
          role: UserRole.MERCHANT_STAFF,
        },
      }),
    );

    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'MERCHANT' })
      .expect(200);
    const body = response.body as { accessToken: string; user: { id: string } };
    expect(body.user.id).toBe(user.id);
    return { token: body.accessToken, userId: user.id };
  }

  /**
   * 造一笔订单（**必须先有订单**，货款流水有指向它的外键 Restrict）。
   */
  async function seedOrder(
    tenantId: string,
    options: {
      status?: OrderStatus;
      totalAmount?: number;
      commissionRate?: number;
      commissionAmount?: number;
      paidAt?: Date | null;
      refundedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `PAY-ORD-${unique()}`,
          status: options.status ?? OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 20000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: options.commissionRate ?? 500,
          commissionAmount: options.commissionAmount ?? 0,
          // ⚠️ **不能用 `??`**：`null ?? x` 返回 `x`，那样「传 null 表示
          //    没付过钱」会被静默忽略。
          paidAt: options.paidAt === undefined ? new Date() : options.paidAt,
          refundedAt:
            options.refundedAt === undefined ? null : options.refundedAt,
        },
      }),
    );
    return created.id;
  }

  /**
   * 造一笔货款流水（直接插库，不跑支付链路）。
   *
   * ⚠️ **`merchant_receipts` 在租户白名单里** → 平台作用域下写它
   *    **必须显式带 `tenantId`**（代码里已经带了）。
   *
   * ⚠️ **`(orderId, type)` 唯一** → 同一订单同一类型只能有一笔，
   *    同一订单要造两笔得用不同的 `type`。
   */
  async function seedReceipt(
    tenantId: string,
    orderId: string,
    options: {
      type: ReceiptType;
      amount: number;
      occurredAt: Date;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.merchantReceipt.create({
        data: {
          tenantId,
          orderId,
          orderNo: `PAY-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 造一笔抽佣流水（结算单的原料） */
  async function seedEntry(
    tenantId: string,
    orderId: string,
    options: {
      type: CommissionEntryType;
      amount: number;
      occurredAt: Date;
      rateBps?: number;
      baseAmount?: number;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId,
          orderNo: `PAY-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          rateBps: options.rateBps ?? 500,
          baseAmount: options.baseAmount ?? 20000,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 生成结算单（平台侧） */
  async function generate(
    token: string,
    period: string,
    tenantId: string,
  ): Promise<{ items: Array<{ id: string; netAmount: number }> }> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${token}`)
      .send({ period, tenantId })
      .expect(200);
    return response.body as { items: Array<{ id: string; netAmount: number }> };
  }

  /** 确认结算单（平台侧） */
  async function confirmStatement(
    token: string,
    statementId: string,
  ): Promise<void> {
    await http(app)
      .post(`/api/v1/platform/settlements/${statementId}/confirm`)
      .set('authorization', `Bearer ${token}`)
      .expect(201);
  }

  /**
   * 造一个「有货款流水 + 已确认结算单」的商家（周期可申请）。
   *
   * @param receiptAmount 该期的货款净额（整数分）
   * @param commissionAmount 该期的抽佣净额（结算单的 netAmount，整数分）
   * @param confirmStatement 是否把结算单确认掉（false = 留 DRAFT，验 P3）
   */
  async function setupMerchantWithPeriod(
    adminToken: string,
    period: Period,
    options: {
      receiptAmount: number;
      commissionAmount: number;
      confirmStatement?: boolean;
    },
  ): Promise<{
    merchant: { token: string; tenantId: string; subdomain: string };
    statementId: string | null;
  }> {
    const merchant = await createMerchant(app, prisma);

    // ---- 货款流水 ----
    const orderId = await seedOrder(merchant.tenantId, {
      totalAmount: options.receiptAmount,
    });
    await seedReceipt(merchant.tenantId, orderId, {
      type: ReceiptType.SALE,
      amount: options.receiptAmount,
      occurredAt: inside(period, 10),
    });

    // ---- 抽佣流水（结算单的原料）----
    let statementId: string | null = null;
    if (options.commissionAmount !== 0) {
      const entryOrderId = await seedOrder(merchant.tenantId, {
        totalAmount: options.receiptAmount,
        commissionAmount: options.commissionAmount,
      });
      await seedEntry(merchant.tenantId, entryOrderId, {
        type: CommissionEntryType.COMMISSION,
        amount: options.commissionAmount,
        occurredAt: inside(period, 10),
      });

      const body = await generate(adminToken, period.label, merchant.tenantId);
      expect(body.items).toHaveLength(1);
      statementId = body.items[0].id;
      if (options.confirmStatement !== false) {
        await confirmStatement(adminToken, statementId);
      }
    }

    // ---- 收款账户（没有它申请出款直接 400）----
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);

    return { merchant, statementId };
  }

  /** 商家申请出款 */
  async function apply(token: string, period: string): Promise<PayoutBody> {
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${token}`)
      .send({ period })
      .expect(201);
    return response.body as PayoutBody;
  }

  /** 商家拉出款单详情 */
  async function fetchMerchantDetail(
    token: string,
    id: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .get(`/api/v1/merchant/payouts/${id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  /** 平台审批通过 */
  async function approve(adminToken: string, id: string): Promise<PayoutBody> {
    const response = await http(app)
      .post(`/api/v1/platform/payouts/${id}/approve`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  /** 平台拒绝 */
  async function reject(
    adminToken: string,
    id: string,
    reason: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .post(`/api/v1/platform/payouts/${id}/reject`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ reason })
      .expect(200);
    return response.body as PayoutBody;
  }

  // ============================================================
  // P4 / D4：金额一律后端算
  // ============================================================

  it('P4：申请 → 金额 = 货款净额 − 佣金净额；请求体带 amount 不影响结果', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-01');
    const { merchant, statementId } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );

    // ⚠️ **请求体里多带一个 `amount` 字段**：
    //    `ApplyPayoutDto` 只有 `period` 一个属性，而 `ValidationPipe` 配了
    //    `forbidNonWhitelisted: true` → 多余字段会被**拒**（400）。
    //    护栏 P4 的要害是「金额不能由客户端指定」——
    //    要么被拒，要么被忽略，**绝不能影响算出来的金额**。
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: period.label, amount: 99999999 })
      .expect(400);
    expect(errorText(response.body)).toContain('amount');

    // ⚠️ **正规路径**：金额完全由后端算出来
    const body = await apply(merchant.token, period.label);
    expect(body.receiptAmount).toBe(10000);
    expect(body.commissionAmount).toBe(1500);
    // ⚠️ **净额 = 货款净额 − 佣金净额**（整数分）
    expect(body.netAmount).toBe(8500);
    expect(body.netAmount).toBe(body.receiptAmount - body.commissionAmount);
    expect(body.entryCount).toBe(1);
    expect(body.status).toBe(PayoutStatus.REQUESTED);
    // ⚠️ **引用的是那张已确认的结算单**
    expect(body.statementId).toBe(statementId);
  });

  // ============================================================
  // P1：幂等
  // ============================================================

  it('P1：重复申请同一周期 → 幂等返回同一张单，库里只有一张活跃单', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-02');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 20000,
      commissionAmount: 2000,
    });

    const first = await apply(merchant.token, period.label);

    // ⚠️ **把收款账户删掉**，用来区分「幂等前置检查」与「P2002 兜底」两层：
    //    前置检查在最前 → 重复申请直接返回既有单，**根本走不到收款账户的检查**；
    //    若前置检查被去掉 → 代码会继续往下走到「没有收款账户 → 400」。
    //    （只断言「两次返回同一张单」锁不住这一层：P2002 兜底也会返回同一张单。）
    await asPlatform(() =>
      prisma.merchantPayoutAccount.deleteMany({
        where: { tenantId: merchant.tenantId },
      }),
    );

    const second = await apply(merchant.token, period.label);

    // ⚠️ **幂等不是报错**：重复申请原样返回既有单据
    expect(second.id).toBe(first.id);
    expect(second.payoutNo).toBe(first.payoutNo);
    expect(second.netAmount).toBe(first.netAmount);

    // ⚠️ **库里也只有一张**
    const count = await asPlatform(() =>
      prisma.payout.count({
        where: { tenantId: merchant.tenantId, periodStart: period.from },
      }),
    );
    expect(count).toBe(1);
  });

  it('P1：库里已有一张被拒绝的单 → 该期还能重新申请', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-03');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 30000,
      commissionAmount: 3000,
    });

    // ---- 手工造一张「被拒绝」的旧单（模拟历史数据）----
    await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY-TEST-${unique()}`,
          periodStart: period.from,
          periodEnd: period.to,
          receiptAmount: 30000,
          commissionAmount: 3000,
          netAmount: 27000,
          entryCount: 0,
          status: PayoutStatus.REJECTED,
          requestedAmount: 27000,
          requestedBy: 'test-user',
          approvedBy: 'test-admin',
          rejectedReason: '测试用：一张被拒绝的旧单',
        },
      }),
    );

    // ---- 重新申请 → 必须成功 ----
    const body = await apply(merchant.token, period.label);
    expect(body.status).toBe(PayoutStatus.REQUESTED);
    expect(body.netAmount).toBe(27000);

    // ⚠️ **库里两张**：1 张 REJECTED + 1 张 REQUESTED
    const all = await asPlatform(() =>
      prisma.payout.findMany({
        where: { tenantId: merchant.tenantId, periodStart: period.from },
      }),
    );
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.status === PayoutStatus.REJECTED)).toHaveLength(
      1,
    );
    expect(all.filter((p) => p.status === PayoutStatus.REQUESTED)).toHaveLength(
      1,
    );
  });

  it('⚠️ P1 / D9（真链路）：申请 → 平台拒绝 → 商家再申请 → 成功', async () => {
    // ⚠️ **单测测不了这条**：假 Prisma 是配置驱动的，造不出状态机。
    //    而它正是「拒绝后不释放明细占用 → 重新申请撞 `payout_entries` 的
    //    唯一索引 → 500」的触发路径 → 必须走真链路验。
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-04');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 40000,
      commissionAmount: 4000,
    });

    // ---- ① 申请 ----
    const first = await apply(merchant.token, period.label);
    expect(first.status).toBe(PayoutStatus.REQUESTED);
    expect(first.netAmount).toBe(36000);

    // ⚠️ **申请时占用了一笔货款流水**
    const linksAfterApply = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { payoutId: first.id } }),
    );
    expect(linksAfterApply).toHaveLength(1);

    // ---- ② 平台拒绝 ----
    const rejected = await reject(adminToken, first.id, '测试用：这笔先拒掉');
    expect(rejected.status).toBe(PayoutStatus.REJECTED);
    expect(rejected.rejectedReason).toBe('测试用：这笔先拒掉');

    // ⚠️ **拒绝后要释放明细占用**：不释放的话重新申请会撞唯一索引 → 500
    const linksAfterReject = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { payoutId: first.id } }),
    );
    expect(linksAfterReject).toHaveLength(0);

    // ---- ③ 商家再申请 → 必须成功（不是 500）----
    const second = await apply(merchant.token, period.label);
    expect(second.status).toBe(PayoutStatus.REQUESTED);
    expect(second.netAmount).toBe(36000);
    // ⚠️ **是新的一张单**，不是把被拒的那张改回来
    expect(second.id).not.toBe(first.id);

    // ⚠️ **明细占用重新落上**
    const linksAfterReapply = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { payoutId: second.id } }),
    );
    expect(linksAfterReapply).toHaveLength(1);
  });

  it('⚠️ P1（真链路）：申请 → 商家撤回 → 再申请 → 成功', async () => {
    // ⚠️ **撤回是另一条释放明细的路径**：它由**商家**触发，
    //    走的是 `PayoutService.cancel`（不是 `reject`）→
    //    两条路径都要被证明能重新申请。
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-05');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 50000,
      commissionAmount: 5000,
    });

    // ---- ① 申请 ----
    const first = await apply(merchant.token, period.label);
    expect(first.status).toBe(PayoutStatus.REQUESTED);

    // ---- ② 撤回 ----
    const cancelled = await http(app)
      .delete(`/api/v1/merchant/payouts/${first.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect((cancelled.body as PayoutBody).status).toBe(PayoutStatus.CANCELLED);

    // ⚠️ **撤回后要释放明细占用**
    const linksAfterCancel = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { payoutId: first.id } }),
    );
    expect(linksAfterCancel).toHaveLength(0);

    // ---- ③ 再申请 → 必须成功 ----
    const second = await apply(merchant.token, period.label);
    expect(second.status).toBe(PayoutStatus.REQUESTED);
    expect(second.id).not.toBe(first.id);
    expect(second.netAmount).toBe(45000);
  });

  // ============================================================
  // P3：结算单必须已确认
  // ============================================================

  it('P3：结算单未 CONFIRMED → 409，且没建任何单', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    // ⚠️ **`confirmStatement: false`** → 结算单留在 DRAFT
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 60000,
      commissionAmount: 6000,
      confirmStatement: false,
    });

    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: period.label })
      .expect(409);
    expect(errorText(response.body)).toContain('尚未确认');

    // ⚠️ **没建任何单**（不能「先建后报错」）
    const count = await asPlatform(() =>
      prisma.payout.count({
        where: { tenantId: merchant.tenantId, periodStart: period.from },
      }),
    );
    expect(count).toBe(0);
  });

  // ============================================================
  // 周期校验与边界
  // ============================================================

  it('周期未结束 → 400，且没建单', async () => {
    const merchant = await createMerchant(app, prisma);
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);

    // ⚠️ **用一个肯定还没结束的月份**：2999 年
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: '2999-01' })
      .expect(400);
    expect(errorText(response.body)).toContain('尚未结束');

    const count = await asPlatform(() =>
      prisma.payout.count({ where: { tenantId: merchant.tenantId } }),
    );
    expect(count).toBe(0);
  });

  it('应结金额 ≤ 0（佣金比货款还多）→ 400，且没建单', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-07');
    // ⚠️ **货款 1000 分、佣金 1500 分** → 净额 −500
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 1000,
      commissionAmount: 1500,
    });

    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: period.label })
      .expect(400);
    expect(errorText(response.body)).toContain('应结金额');

    const count = await asPlatform(() =>
      prisma.payout.count({
        where: { tenantId: merchant.tenantId, periodStart: period.from },
      }),
    );
    expect(count).toBe(0);
  });

  // ============================================================
  // D7：申请时就固定纳入的流水
  // ============================================================

  it('D7：申请时固定纳入的流水 = 当期那几笔', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-08');
    const merchant = await createMerchant(app, prisma);

    // ---- 当期三笔货款流水 ----
    const orderA = await seedOrder(merchant.tenantId, { totalAmount: 1000 });
    const receiptA = await seedReceipt(merchant.tenantId, orderA, {
      type: ReceiptType.SALE,
      amount: 1000,
      occurredAt: inside(period, 5),
    });
    const orderB = await seedOrder(merchant.tenantId, { totalAmount: 2000 });
    const receiptB = await seedReceipt(merchant.tenantId, orderB, {
      type: ReceiptType.SALE,
      amount: 2000,
      occurredAt: inside(period, 6),
    });
    const orderC = await seedOrder(merchant.tenantId, { totalAmount: 3000 });
    const receiptC = await seedReceipt(merchant.tenantId, orderC, {
      type: ReceiptType.SALE,
      amount: 3000,
      occurredAt: inside(period, 7),
    });

    // ---- 上月的流水 → 不该被纳入 ----
    const previous = month('2026-07');
    const orderPrev = await seedOrder(merchant.tenantId, { totalAmount: 9000 });
    await seedReceipt(merchant.tenantId, orderPrev, {
      type: ReceiptType.SALE,
      amount: 9000,
      occurredAt: inside(previous, 10),
    });

    // ---- 抽佣流水 + 结算单 ----
    const entryOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 6000,
      commissionAmount: 600,
    });
    await seedEntry(merchant.tenantId, entryOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 600,
      occurredAt: inside(period, 5),
    });
    const body = await generate(adminToken, period.label, merchant.tenantId);
    await confirmStatement(adminToken, body.items[0].id);

    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);

    const payout = await apply(merchant.token, period.label);
    expect(payout.entryCount).toBe(3);
    expect(payout.receiptAmount).toBe(6000);

    // ⚠️ **`payout_entries` 里的 entryId 恰是当期那三笔**（不多不少）
    const links = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { payoutId: payout.id } }),
    );
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.entryId).sort()).toEqual(
      [receiptA, receiptB, receiptC].sort(),
    );

    // ⚠️ **详情里能看见这三笔，且都是当期的**
    const detail = await fetchMerchantDetail(merchant.token, payout.id);
    expect(detail.entries).toHaveLength(3);
    expect(detail.entries?.map((e) => e.entryId).sort()).toEqual(
      [receiptA, receiptB, receiptC].sort(),
    );
  });

  // ============================================================
  // P5：审批时重算金额
  // ============================================================

  it('P5：审批 → 锁定的是重算值；requestedAmount 保留申请时的预估', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ---- 申请 → 预估 9000 ----
    const requested = await apply(merchant.token, period.label);
    expect(requested.netAmount).toBe(9000);
    expect(requested.requestedAmount).toBe(9000);

    // ---- 申请之后又来了一笔货款流水（模拟回填补进来的历史流水）----
    const extraOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
    });
    await seedReceipt(merchant.tenantId, extraOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    // ---- 审批 → 锁定的是重算值 ----
    const approved = await approve(adminToken, requested.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);
    // ⚠️ **重算值**：货款 15000 − 佣金 1000 = 14000
    expect(approved.receiptAmount).toBe(15000);
    expect(approved.commissionAmount).toBe(1000);
    expect(approved.netAmount).toBe(14000);
    expect(approved.entryCount).toBe(2);
    // ⚠️ **`requestedAmount` 保留申请时的旧值**（9000）——
    //    它是「申请时商家看到并认可的那个数」的凭证
    expect(approved.requestedAmount).toBe(9000);

    // ⚠️ **落库的确实是重算值**（不是响应体好看而已）
    const persisted = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: requested.id } }),
    );
    expect(persisted?.netAmount).toBe(14000);
    expect(persisted?.requestedAmount).toBe(9000);
  });

  // ============================================================
  // P7：状态机
  // ============================================================

  it('P7：已审批的单再审批 → 409，且状态与金额不变', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 20000,
      commissionAmount: 2000,
    });

    const requested = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, requested.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);

    // ---- 再审批一次 → 409 ----
    const response = await http(app)
      .post(`/api/v1/platform/payouts/${requested.id}/approve`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);
    // ⚠️ **错误消息要说清是「已被审批 / 状态已变」**，
    //    不能是「单据不存在」——排查时这两件事要能分开
    expect(errorText(response.body)).toContain('不能重复审批');

    // ⚠️ **状态没被改坏**
    const after = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: requested.id } }),
    );
    // ⚠️ **不能再断言「状态必须是 APPROVED」**（阶段 5h-2 起失效）：
    //    审批通过后会**自动入队**，worker 抢到单就把状态推到 `PROCESSING`
    //    （再往下走就是 `PAID`）。这是 5h-2 的正常语义，不是缺陷。
    //    护栏真正要验的是「重复审批被拒」→ 状态**不能退回 `REQUESTED`**。
    expect(after?.status).not.toBe(PayoutStatus.REQUESTED);
    expect(after?.netAmount).toBe(18000);
  });

  it('P7：已审批的单不能撤回 → 409，且状态不变', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 25000,
      commissionAmount: 2500,
    });

    const requested = await apply(merchant.token, period.label);
    await approve(adminToken, requested.id);

    // ---- 撤回 → 409 ----
    const response = await http(app)
      .delete(`/api/v1/merchant/payouts/${requested.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(409);
    // ⚠️ **错误消息要点明当前状态**，让人一眼看出「它已经批过了」
    expect(errorText(response.body)).toContain('APPROVED');

    // ⚠️ **状态不变**：仍是 APPROVED，不能被撤回改成 CANCELLED
    const after = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: requested.id } }),
    );
    // ⚠️ 同上：审批后会自动入队，状态可能已经是 `PROCESSING` / `PAID`。
    //    护栏要验的是「撤回被拒」→ 状态**不能是 `CANCELLED`**、也不能退回 `REQUESTED`。
    expect(after?.status).not.toBe(PayoutStatus.CANCELLED);
    expect(after?.status).not.toBe(PayoutStatus.REQUESTED);
    expect(after?.cancelledAt).toBeNull();
  });

  it('拒绝必须带原因 → 缺原因 400；带上原因才落库', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-10');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 30000,
      commissionAmount: 3000,
    });

    const requested = await apply(merchant.token, period.label);

    // ---- 缺原因 → 400 ----
    const missing = await http(app)
      .post(`/api/v1/platform/payouts/${requested.id}/reject`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);
    expect(errorText(missing.body)).toContain('原因');

    // ⚠️ **被拒的单状态没变**（400 不能有副作用）
    const untouched = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: requested.id } }),
    );
    expect(untouched?.status).toBe(PayoutStatus.REQUESTED);

    // ---- 带上原因 → 成功 ----
    const rejected = await reject(adminToken, requested.id, '金额对不上');
    expect(rejected.status).toBe(PayoutStatus.REJECTED);
    expect(rejected.rejectedReason).toBe('金额对不上');
  });

  // ============================================================
  // P9：明细归属
  // ============================================================

  // ⚠️ **P9 拆成两个用例**（5h-1 验收记录 N1）：
  //    原来 GET 与 DELETE 的断言挤在一个 `it` 里 → **GET 的断言先失败**，
  //    DELETE 的断言**轮不到执行** → 「撤回越权被挡住」这条护栏**实际没被验证**。
  //    拆开之后，两个用例各自独立地成/败。
  it('P9：商家看不到别家的出款单详情（GET 越权）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant: owner } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 40000, commissionAmount: 4000 },
    );
    const other = await createMerchant(app, prisma);

    const requested = await apply(owner.token, period.label);

    // ---- 商家 A 看商家 B 的单 → 404（不是 403）----
    // ⚠️ **404 而不是 403**：说「存在但不是你的」本身就是信息泄露。
    await http(app)
      .get(`/api/v1/merchant/payouts/${requested.id}`)
      .set('authorization', `Bearer ${other.token}`)
      .expect(404);

    // ⚠️ **商家 B 的列表里看不到这张单**
    const list = await http(app)
      .get('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${other.token}`)
      .expect(200);
    expect((list.body as PayoutListBody).items).toHaveLength(0);
  });

  it('P9：商家不能撤回别家的出款单（DELETE 越权）', async () => {
    const adminToken = await loginPlatformAdmin();
    // ⚠️ **必须与上一个用例不同月份**：两个用例虽然各自建了独立商家
    //    （幂等键是 `(tenantId, periodStart)`），但同月份会让「该期只有一张活跃单」
    //    的直觉失效，读用例的人也会以为它们在断言同一张单。
    const period = month('2026-07');
    const { merchant: owner } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 40000, commissionAmount: 4000 },
    );
    const other = await createMerchant(app, prisma);

    const requested = await apply(owner.token, period.label);

    await http(app)
      .delete(`/api/v1/merchant/payouts/${requested.id}`)
      .set('authorization', `Bearer ${other.token}`)
      .expect(404);

    // ⚠️ **还要断言「那张单没被动过」** ——
    //    只断言 404 的话，一个「直接返回 404 但其实撤回了」的 bug 也能过。
    const after = await fetchMerchantDetail(owner.token, requested.id);
    expect(after.status).toBe(PayoutStatus.REQUESTED);
  });

  it('P9：明细里关联了别家的货款流水 → 详情不显示别家的订单号', async () => {
    // ⚠️ **这是 P9 的第二道闸**：`payout_entries` **不带 tenantId**
    //    → 租户作用域扩展对它不附加任何过滤 → 查出来的是**全局事实**。
    //    第一道闸（`payout.findFirst` 自动按 tenantId 过滤）只挡住
    //    「别人的出款单」；**挡不住「自己的单上挂着别人的流水」** ——
    //    那是脏数据（手工改过关联行、程序 bug、并发写串了）造成的样子。
    //    服务层 `entriesOf` 里那句 `where: { tenantId: payout.tenantId }`
    //    就是为这个场景存在的。
    //
    // ⚠️ **正常路径造不出这种数据**（申请时的流水一定来自本商家）→
    //    必须手工插库才能验这道闸。
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-01');
    const { merchant: owner } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 40000, commissionAmount: 4000 },
    );
    const other = await createMerchant(app, prisma);

    // ---- 别家的一笔货款流水 ----
    const otherOrderId = await seedOrder(other.tenantId, { totalAmount: 7777 });
    const otherReceiptId = await seedReceipt(other.tenantId, otherOrderId, {
      type: ReceiptType.SALE,
      amount: 7777,
      occurredAt: inside(period, 12),
    });

    // ---- 把它挂到 owner 的出款单上（脏数据）----
    const requested = await apply(owner.token, period.label);
    await asPlatform(() =>
      prisma.payoutEntry.create({
        data: { payoutId: requested.id, entryId: otherReceiptId },
      }),
    );

    // ---- 平台侧看这张单：别家的流水**不能出现** ----
    //
    // ⚠️ **为什么验平台侧而不是商家侧**：商家侧的 `merchant_receipts` 查询
    //    会被**租户作用域扩展**自动加上 `tenantId` 条件
    //    （`withMergedWhere` 是 `{...base, ...extra}` → 扩展附的那份
    //    **覆盖**调用方手写的同键值）→ 商家侧天然查不到别家的流水，
    //    服务层那句 `where: { tenantId: payout.tenantId }` 在商家侧是冗余的。
    //    **真正靠它挡住越权的是平台侧**：`detailForPlatform` 跑在
    //    `platformScope()` 下，扩展**不附加**任何 tenantId 条件 →
    //    没有那句显式过滤，脏数据里挂着的别家流水就会被显示出来。
    const platformDetail = await http(app)
      .get(`/api/v1/platform/payouts/${requested.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    const detail = platformDetail.body as PayoutBody;
    const entryIds = (detail.entries ?? []).map((e) => e.entryId);
    expect(entryIds).not.toContain(otherReceiptId);
    // ⚠️ **只显示 owner 自己那笔**
    expect(detail.entries).toHaveLength(1);
    expect(detail.entries?.[0].amount).toBe(40000);
    // ⚠️ **别家的订单号一个字都不能漏出去**
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(otherReceiptId);

    // ---- 商家侧同样看不到（租户作用域扩展已经挡住了）----
    const merchantDetail = await fetchMerchantDetail(owner.token, requested.id);
    expect((merchantDetail.entries ?? []).map((e) => e.entryId)).not.toContain(
      otherReceiptId,
    );
  });

  // ============================================================
  // P10：角色
  // ============================================================

  it('P10：员工申请出款 → 403', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-12');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 50000,
      commissionAmount: 5000,
    });

    const staff = await createMerchantStaff(merchant.tenantId);

    // ⚠️ **员工不能申请出款**
    await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${staff.token}`)
      .send({ period: period.label })
      .expect(403);

    // ⚠️ **员工也不能设置收款账户**（钱的去向）
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${staff.token}`)
      .send({
        accountName: '李四',
        bankName: '工商银行',
        accountNo: '6225880000000001',
      })
      .expect(403);

    // ⚠️ **一张单都没建**
    const count = await asPlatform(() =>
      prisma.payout.count({ where: { tenantId: merchant.tenantId } }),
    );
    expect(count).toBe(0);
  });

  it('P10：商家账号调平台审批端点 → 403', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-01');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 60000,
      commissionAmount: 6000,
    });

    const requested = await apply(merchant.token, period.label);

    await http(app)
      .get('/api/v1/platform/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);

    await http(app)
      .get(`/api/v1/platform/payouts/${requested.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);

    await http(app)
      .post(`/api/v1/platform/payouts/${requested.id}/approve`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);

    await http(app)
      .post(`/api/v1/platform/payouts/${requested.id}/reject`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: '商家自己批自己' })
      .expect(403);

    // ⚠️ **状态没被改**
    const after = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: requested.id } }),
    );
    expect(after?.status).toBe(PayoutStatus.REQUESTED);
  });

  it('P10：未登录 → 401', async () => {
    await http(app).get('/api/v1/merchant/payouts').expect(401);
    await http(app)
      .get('/api/v1/merchant/payouts/available-periods')
      .expect(401);
    await http(app)
      .post('/api/v1/merchant/payouts')
      .send({ period: '2026-01' })
      .expect(401);
    await http(app).get('/api/v1/merchant/payout-account').expect(401);
    await http(app).get('/api/v1/platform/payouts').expect(401);
    await http(app)
      .post(
        '/api/v1/platform/payouts/00000000-0000-4000-8000-000000000000/approve',
      )
      .expect(401);
  });

  // ============================================================
  // P2：一笔货款只能被出款一次（数据库层）
  // ============================================================

  it('P2：同一笔货款被两张开款单关联 → 数据库唯一约束拒绝（P2002）', async () => {
    // ⚠️ **这是数据层的兜底**：服务层用「先查后插」防重复，
    //    这一条验的是**唯一约束真的建上了** ——
    //    `payout_entries.entryId` 是**全局唯一**（不是 `(payoutId, entryId)`
    //    复合唯一），复合唯一是这条护栏的弱化版，会放过
    //    「同一笔货款被两张单各出一次」（商家拿到两笔钱）。
    const merchant = await createMerchant(app, prisma);
    const period = month('2025-02');

    const orderId = await seedOrder(merchant.tenantId, { totalAmount: 1000 });
    const entryId = await seedReceipt(merchant.tenantId, orderId, {
      type: ReceiptType.SALE,
      amount: 1000,
      occurredAt: inside(period, 10),
    });

    // ---- 手工造两张出款单（周期不同，绕开「同一商家同一周期一张活跃单」）----
    const first = await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY-TEST-${unique()}`,
          periodStart: period.from,
          periodEnd: period.to,
          receiptAmount: 1000,
          commissionAmount: 0,
          netAmount: 1000,
          entryCount: 1,
          status: PayoutStatus.REQUESTED,
          requestedAmount: 1000,
          requestedBy: 'test-user',
        },
      }),
    );
    await asPlatform(() =>
      prisma.payoutEntry.create({
        data: { payoutId: first.id, entryId },
      }),
    );

    const second = await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY-TEST-${unique()}`,
          periodStart: new Date(Date.UTC(2025, 2, 1)),
          periodEnd: new Date(Date.UTC(2025, 3, 1)),
          receiptAmount: 1000,
          commissionAmount: 0,
          netAmount: 1000,
          entryCount: 1,
          status: PayoutStatus.REQUESTED,
          requestedAmount: 1000,
          requestedBy: 'test-user',
        },
      }),
    );

    // ---- 再关联一次同一个 entryId → 必须被数据库拒绝 ----
    let code: string | undefined;
    try {
      await asPlatform(() =>
        prisma.payoutEntry.create({
          data: { payoutId: second.id, entryId },
        }),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    // ⚠️ **P2002 = 唯一约束冲突**：不是 P2003（外键）
    expect(code).toBe('P2002');

    // ⚠️ **库里只有一个关联行**：重复的插入没有落库
    const links = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { entryId } }),
    );
    expect(links).toHaveLength(1);
    expect(links[0].payoutId).toBe(first.id);
  });

  // ============================================================
  // 其它：可申请周期列表与收款账户
  // ============================================================

  it('可申请周期列表：该期已申请过 → alreadyApplied 为 true', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 70000,
      commissionAmount: 7000,
    });

    const before = await http(app)
      .get('/api/v1/merchant/payouts/available-periods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const periodsBefore = before.body as AvailablePeriodBody[];
    const mine = periodsBefore.find((p) => p.period === period.label);
    expect(mine).toBeDefined();
    expect(mine?.alreadyApplied).toBe(false);
    expect(mine?.netAmount).toBe(63000);
    expect(mine?.statementStatus).toBe(SettlementStatus.CONFIRMED);

    await apply(merchant.token, period.label);

    const after = await http(app)
      .get('/api/v1/merchant/payouts/available-periods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const periodsAfter = after.body as AvailablePeriodBody[];
    const mineAfter = periodsAfter.find((p) => p.period === period.label);
    expect(mineAfter?.alreadyApplied).toBe(true);
  });

  it('收款账户：首次设置 → 账号脱敏返回；留空更新不清掉账号', async () => {
    const merchant = await createMerchant(app, prisma);

    // ---- 还没有账户 → GET 返回空体 ----
    //
    // ⚠️ **不是 `null`**：NestJS 的 `ExpressAdapter.reply` 里有
    //    `if (isNil(body)) return response.send();` → 返回 `null` 时
    //    发出去的是**空响应体**（supertest 解析成 `{}`），不是 JSON 的 `null`。
    const empty = await http(app)
      .get('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(empty.body).toEqual({});
    expect(empty.text).toBe('');

    // ---- 首次设置 ----
    const created = await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      })
      .expect(200);
    const body = created.body as AccountBody;
    expect(body.accountName).toBe('张三');
    expect(body.bankName).toBe('招商银行');
    // ⚠️ **账号必须脱敏**：只留尾 4 位
    expect(body.maskedAccountNo).toBe('************0000');
    expect(body.maskedAccountNo).not.toContain('6225');

    // ---- 更新时留空账号 → 不能把账号清掉 ----
    const updated = await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ accountName: '张三丰', bankName: '招商银行' })
      .expect(200);
    const updatedBody = updated.body as AccountBody;
    expect(updatedBody.accountName).toBe('张三丰');
    expect(updatedBody.maskedAccountNo).toBe('************0000');
  });

  it('出款单列表：商家只看得到自己的单', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 80000,
      commissionAmount: 8000,
    });
    const other = await createMerchant(app, prisma);

    await apply(merchant.token, period.label);

    const list = await http(app)
      .get('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const body = list.body as PayoutListBody;
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].netAmount).toBe(72000);

    // ---- 平台侧看得到（跨商家）----
    const platformList = await http(app)
      .get('/api/v1/platform/payouts')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    const platformBody = platformList.body as PayoutListBody;
    const mine = platformBody.items.filter(
      (item) => item.tenantId === merchant.tenantId,
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);

    // ---- 别的商家看不到 ----
    const otherList = await http(app)
      .get('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${other.token}`)
      .expect(200);
    expect((otherList.body as PayoutListBody).items).toHaveLength(0);
  });
});
