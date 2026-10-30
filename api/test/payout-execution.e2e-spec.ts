import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import {
  CommissionEntryType,
  OrderStatus,
  PayoutKind,
  PayoutStatus,
  ReceiptType,
  SettlementStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { FakePayoutProvider } from '../src/modules/payment/fake-payout.provider';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { PayoutExecutionService } from '../src/modules/billing/payout-execution.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 出款执行（阶段 5h-2）的 e2e。
 *
 * 覆盖的护栏：X1–X16（编号见设计文档 §七）。
 *
 * ⚠️ **每个用例用自己独立的商家 + 独立的月份**（5h-1 的同款教训）：
 *   出款单的幂等键是 `(tenantId, periodStart, kind)` —— 同一商家同一期
 *   反复造数据会让后一个用例拿到前一个用例的单据（断言互相污染）。
 *
 * ⚠️ **不跑回填**：直接造 `merchant_receipts` 行，不跑支付链路 ——
 *   `ReceiptService.backfill()` 会扫全表，跨文件影响不可控。
 *
 * ⚠️ **断言一律写成「这个商家的这一张单」** —— 结算单 e2e 会批量出单，
 *   「全平台恰好 N 张」那种断言会被带偏。
 *
 * ⚠️ **月份只用 2025-08 ~ 2026-09** —— 结算单 e2e 对 2024-10 / 2024-12
 *   有「这一期**全库**恰好几张单 / 没有任何流水」的断言，往那些月份造流水
 *   会带偏它。
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
  kind: string;
  periodLabel: string;
  receiptAmount: number;
  commissionAmount: number;
  netAmount: number;
  entryCount: number;
  status: string;
  attemptCount: number;
  failureReason: string | null;
  processingAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  payoutChannel: string | null;
  maskedSnapshotAccountNo: string | null;
  statementId: string | null;
  createdAt: string;
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
  appliedKind: string | null;
  supplementAvailable: boolean;
  supplementAmount: number | null;
}

describe('出款执行 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let payoutQueue: Queue;

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
    payoutQueue = app.get(getQueueToken(PAYOUT_QUEUE));
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
   * 造一笔订单（货款流水有指向它的外键 Restrict → 必须先有订单）。
   */
  async function seedOrder(
    tenantId: string,
    options: { totalAmount?: number; commissionAmount?: number } = {},
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `PAYEX-ORD-${unique()}`,
          status: OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 20000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: 500,
          commissionAmount: options.commissionAmount ?? 0,
          paidAt: new Date(),
          refundedAt: null,
        },
      }),
    );
    return created.id;
  }

  /** 造一笔货款流水（直接插库，不跑支付链路） */
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
          orderNo: `PAYEX-ORD-${unique()}`,
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
          orderNo: `PAYEX-ORD-${unique()}`,
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
  ): Promise<{ id: string }> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${token}`)
      .send({ period, tenantId })
      .expect(200);
    const body = response.body as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    return body.items[0];
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
   * 造一个「有货款流水 + 已确认结算单 + 有收款账户」的商家（周期可申请）。
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

    const orderId = await seedOrder(merchant.tenantId, {
      totalAmount: options.receiptAmount,
    });
    await seedReceipt(merchant.tenantId, orderId, {
      type: ReceiptType.SALE,
      amount: options.receiptAmount,
      occurredAt: inside(period, 10),
    });

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

      const statement = await generate(
        adminToken,
        period.label,
        merchant.tenantId,
      );
      statementId = statement.id;
      if (options.confirmStatement !== false) {
        await confirmStatement(adminToken, statementId);
      }
    }

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

  /** 设定接下来 N 次打款的剧本（假网关；只有平台超管能调） */
  async function armScenario(
    adminToken: string,
    options: { times?: number; amountOffset?: number },
  ): Promise<void> {
    await http(app)
      .post('/api/v1/pay/fake-payout/fail-next')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        times: options.times ?? 0,
        amountOffset: options.amountOffset ?? 0,
      })
      .expect(200);
  }

  /**
   * 等一个条件成立（轮询）。
   *
   * ⚠️ **轮询间隔 100ms、超时 20 秒** —— 出款要经过「审批 → 入队 → worker 消费 →
   *   调渠道 → 落状态」，加上 3 次重试退避（e2e 里 100ms × 3），20 秒够用。
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

  /** 等这张出款单进入指定状态 */
  async function waitForStatus(
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

  // ============================================================
  // X1：同一张出款单只能被执行一次
  // ============================================================

  it('X1：审批 → 打款 → PAID；金额与审批锁定值一致', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });

    const applied = await apply(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);

    const approved = await approve(adminToken, applied.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);

    // ⚠️ **等 worker 打完款**
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    // ⚠️ **打出去的金额 = 审批锁定的金额**（护栏 X2：worker 不重算）
    expect(paid!.netAmount).toBe(8500);
    expect(paid!.paidAt).not.toBeNull();
    expect(paid!.payoutChannel).toBe('fake-payout');
  });

  it('X1：重复消费同一个 job → 不会打两次（幂等）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 20000,
      commissionAmount: 2000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    // ⚠️ **再投一次同一个 job** —— worker 抢不到（状态已是 PAID），
    //    条件更新让 `claimForExecution` 返回 null → 静默跳过。
    const first = await fetchMerchantDetail(merchant.token, applied.id);
    expect(first.status).toBe(PayoutStatus.PAID);
    const paidAt = first.paidAt;

    await payoutQueue.add(
      'execute',
      { payoutId: applied.id },
      { jobId: `manual-dup-${applied.id}`, attempts: 1 },
    );
    // ⚠️ **等一会儿，确认没有第二次打款**
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const second = await fetchMerchantDetail(merchant.token, applied.id);
    expect(second.status).toBe(PayoutStatus.PAID);
    // ⚠️ **打款时刻没有被改写**（若被重复执行，paidAt 会变）
    expect(second.paidAt).toBe(paidAt);
    // ⚠️ **尝试次数也没有再增**（抢不到单就不会 +1）
    expect(second.attemptCount).toBe(first.attemptCount);
  });

  // ============================================================
  // X2b：打款账户是审批时看到的那一个
  // ============================================================

  it('X2b：审批后商家改收款账户 → 打款仍用审批时的快照', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-10');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    // ⚠️⚠️ **先记下「审批那一刻」的账户密文** ——
    //    下面会把账户改掉，账户行里的密文就变了。
    //    这份密文正是快照该复制的那一份。
    const accountAtApproval = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
      }),
    );

    // ⚠️ **审批后立刻换账户**
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '李四',
        bankName: '工商银行',
        accountNo: '6225889999999999',
      })
      .expect(200);

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    // ⚠️ **快照是审批时的那一份**（尾号 0000，不是换后的 9999）
    expect(paid!.maskedSnapshotAccountNo).toMatch(/\*+0000$/);
    expect(paid!.maskedSnapshotAccountNo).not.toMatch(/\*+9999$/);

    // ⚠️⚠️ **还要断言「渠道实际收到的是哪份账号」** ——
    //    上面那条断言只验了「**库里存的是**审批时的快照」，
    //    验不了「**传给渠道的**是快照」——worker 若传实时账户，
    //    钱会打到错的账户，而库里的快照字段纹丝不动 → 断言照样通过。
    //    （失败注入 Y14 实测：只去掉这一层时，挂 0 条。）
    //
    // ⚠️ **阶段 5j 之后，这一行仍然是明文账号** ——
    //    渠道拿到的是**解密后的明文**（打款必须如此），
    //    这条断言恰恰是「解密链路通了」的证据。
    const fake = app.get(FakePayoutProvider);
    const received = fake.receivedRequest(applied.id);
    expect(received).toBeDefined();
    expect(received!.account.accountNo).toBe('6225880000000000');
    expect(received!.amount).toBe(paid!.netAmount);

    // ⚠️⚠️ **但库里存的是密文**（阶段 5j）——
    //    「渠道收到明文」与「库里存密文」必须**同时**成立：
    //    前者证明加密没把打款打断，后者证明加密真的生效了。
    //    只断言其中一条，两种坏实现都盖得住：
    //    库里存明文（没加密）/ 库里存密文但渠道收到掩码（打不出钱）。
    expect(accountAtApproval!.accountNoCipher).not.toBe('6225880000000000');
    expect(accountAtApproval!.accountNoCipher).not.toContain('62258800');
    expect(accountAtApproval!.encryptionVersion).toBe(1);

    const payout = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    expect(payout!.snapshotAccountNoCipher).not.toBe('6225880000000000');
    expect(payout!.snapshotAccountNoCipher).not.toContain('62258800');
    expect(payout!.snapshotEncryptionVersion).toBe(1);
    // ⚠️⚠️ **快照的密文就是「审批那一刻」账户行里那份** ——
    //    审批时**复制**（不是重新加密：重新加密会得到不同的密文，
    //    而「快照 = 审批那一刻的那一份」要求复制同一份密文），
    //    版本号也跟着一起复制。
    expect(payout!.snapshotAccountNoCipher).toBe(
      accountAtApproval!.accountNoCipher,
    );
    // ⚠️ **快照与「换后的账户」不一样** ——
    //    账户改了 → 重新加密 → 密文变了。
    //    这条断言保证快照没被「审批后又被覆盖」过。
    const accountAfterChange = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
      }),
    );
    expect(payout!.snapshotAccountNoCipher).not.toBe(
      accountAfterChange!.accountNoCipher,
    );
  });

  it('X14：API 响应里的账号是脱敏的（不是完整账号）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-11');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const detail = await fetchMerchantDetail(merchant.token, applied.id);
    // ⚠️ **完整账号绝不能出现在响应里**（护栏 X14）
    expect(JSON.stringify(detail)).not.toContain('6225880000000000');
    expect(detail.maskedSnapshotAccountNo).toMatch(/\*+0000$/);

    // ⚠️⚠️ **阶段 5j 之后，X14 得更硬一层** ——
    //    以前库里存的是明文，响应里给掩码就已经是全部防线；
    //    现在库里存的是密文 → **响应里连密文都不能给**
    //    （把密文端出去等于换个地方存账号，攻击者拿到密钥就能解开）。
    const account = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
      }),
    );
    expect(JSON.stringify(detail)).not.toContain(account!.accountNoCipher);
    const payout = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    expect(JSON.stringify(detail)).not.toContain(
      payout!.snapshotAccountNoCipher!,
    );

    // ⚠️ **平台端也一样** —— 超管看到的响应同样不能带账号。
    const platformDetail = await http(app)
      .get(`/api/v1/platform/payouts/${applied.id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(JSON.stringify(platformDetail.body)).not.toContain(
      '6225880000000000',
    );
    expect(JSON.stringify(platformDetail.body)).not.toContain(
      account!.accountNoCipher,
    );
  });

  // ============================================================
  // X2：执行前金额必须是审批锁定的值
  // ============================================================

  it('X2：审批后新增流水 → 打款金额仍是审批锁定值（worker 不重算）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, applied.id);
    // ⚠️ **审批后又来一笔流水** —— 若 worker 重算金额，
    //    打出去的会是 9000 + 5000 = 14000，而不是审批锁定的 9000
    const extraOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
    });
    await seedReceipt(merchant.tenantId, extraOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    // ⚠️ **打出去的是审批锁定值** —— 不是重算值
    expect(paid!.netAmount).toBe(approved.netAmount);
    expect(paid!.netAmount).toBe(9000);
  });

  // ============================================================
  // X3：渠道金额核对
  // ============================================================

  it('X3：渠道返回的金额与请求不一致 → 落 FAILED', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **让假网关返回的金额比请求的多 1 分** ——
    //    真实渠道打错钱就是这个形状（打 9000、账上记 9001）
    await armScenario(adminToken, { amountOffset: 1 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();
    expect(failed!.failureReason).toContain('金额核对不通过');
  });

  // ============================================================
  // X10 / X11：假网关端点的角色边界
  // ============================================================

  it('X10：商家调「模拟失败」端点 → 403（只有平台超管能改打款结果）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **商家不能让人打款失败** —— 这个端点能左右出款结果
    await http(app)
      .post('/api/v1/pay/fake-payout/fail-next')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ times: 3 })
      .expect(403);

    // ⚠️ **出款本身不受影响** —— 没有被 arm 失败
    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
  });

  // ============================================================
  // X4：打款金额必须 > 0
  // ============================================================

  it('X4：金额被改成 0 的单 → 落 FAILED，不调渠道', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-12');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    // ⚠️⚠️ **不能走 `approve`** —— 审批会**重算并写回金额**（护栏 P5），
    //    这里改成 0 会被重算覆盖 → worker 看到的仍是正常金额 → 测不到东西。
    //    正确做法：造一张「脏数据单」（直接改库成 APPROVED + netAmount = 0），
    //    再**手动投一个 execute job** 绕过 approve。
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: {
          status: PayoutStatus.APPROVED,
          netAmount: 0,
          approvedAt: new Date(),
        },
      }),
    );

    // ⚠️ **手动入队**（绕过 approve 的入队路径）
    await payoutQueue.add(
      'execute',
      { payoutId: applied.id },
      { jobId: `manual-${applied.id}`, attempts: 1 },
    );

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();
    // ⚠️ **金额非法 → 不调渠道，直接落 FAILED**
    expect(failed!.failureReason).toContain('出款金额非法');
    expect(failed!.attemptCount).toBe(1);
  });

  // ============================================================
  // X7：失败重试有上限
  // ============================================================

  it('X7：渠道连续失败 → 重试 3 次后落 FAILED，且 attemptCount = 3', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-01');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **让 3 次打款都失败** → 正好用满重试上限
    await armScenario(adminToken, { times: 3 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();
    expect(failed!.attemptCount).toBe(3);
    expect(failed!.failureReason).toContain('模拟的失败');
  });

  it('X12：渠道失败时落 APPROVED（等重试）并记 failureReason', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-02');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **只让 1 次失败** → 第 2 次会成功
    await armScenario(adminToken, { times: 1 });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
    expect(paid!.attemptCount).toBe(2);
  });

  // ============================================================
  // X5：PAID 后不可变
  // ============================================================

  it('X5：已 PAID 的单不能被撤回', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-03');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    await http(app)
      .delete(`/api/v1/merchant/payouts/${applied.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(409);

    const after = await fetchMerchantDetail(merchant.token, applied.id);
    expect(after.status).toBe(PayoutStatus.PAID);
  });

  it('X5：已 PAID 的单不能被拒绝', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-04');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    await http(app)
      .post(`/api/v1/platform/payouts/${applied.id}/reject`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ reason: '不该能拒绝' })
      .expect(409);

    const after = await fetchMerchantDetail(merchant.token, applied.id);
    expect(after.status).toBe(PayoutStatus.PAID);
  });

  // ============================================================
  // X6 / D4：结算单联动
  // ============================================================

  it('D4：出款 PAID 时，结算单同事务转 PAID 并写 paidAt', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-05');
    const { merchant, statementId } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );
    expect(statementId).not.toBeNull();

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    await waitForStatus(merchant.token, applied.id, PayoutStatus.PAID);

    const statement = await asPlatform(() =>
      prisma.settlementStatement.findFirst({
        where: { id: statementId! },
      }),
    );
    expect(statement!.status).toBe(SettlementStatus.PAID);
    // ⚠️ **paidAt 与 status 同步写** —— 分开写会出「status=PAID 但 paidAt=null」
    expect(statement!.paidAt).not.toBeNull();
  });

  // ============================================================
  // X8 / X9 / X13：补差单
  // ============================================================

  /**
   * 造出「该期已出款 + 有回填流水」的形状。
   *
   * @returns merchant、statementId、payoutId（已 PAID 的正常单）
   */
  async function setupPaidPeriodWithBackfill(
    adminToken: string,
    period: Period,
    options: { receiptAmount: number; commissionAmount: number },
  ): Promise<{
    merchant: { token: string; tenantId: string; subdomain: string };
    statementId: string | null;
    payoutId: string;
  }> {
    const { merchant, statementId } = await setupMerchantWithPeriod(
      adminToken,
      period,
      options,
    );

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();

    // ⚠️ **直接插库模拟回填**：一笔新的货款流水落在同一期。
    //    正常流程走不出这个形状（正常单 PAID 时该期流水已被全部占用）。
    const backfillOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 5000,
    });
    await seedReceipt(merchant.tenantId, backfillOrderId, {
      type: ReceiptType.SALE,
      amount: 5000,
      occurredAt: inside(period, 20),
    });

    return { merchant, statementId, payoutId: applied.id };
  }

  /** 商家拉可申请周期 */
  async function fetchAvailablePeriods(
    token: string,
  ): Promise<AvailablePeriodBody[]> {
    const response = await http(app)
      .get('/api/v1/merchant/payouts/available-periods')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as AvailablePeriodBody[];
  }

  it('X8/X9/X13：正常单已 PAID + 有回填流水 → 补差单佣金为 0', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-06');
    const { merchant } = await setupPaidPeriodWithBackfill(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });

    // ---- 可申请周期里要能看到补差入口 ----
    const periods = await fetchAvailablePeriods(merchant.token);
    const view = periods.find((item) => item.period === period.label);
    expect(view).toBeDefined();
    // ⚠️ **补差入口不能被 alreadyApplied 吞掉**（设计 §6.4b）
    expect(view!.alreadyApplied).toBe(true);
    expect(view!.appliedKind).toBe(PayoutKind.NORMAL);
    expect(view!.supplementAvailable).toBe(true);
    expect(view!.supplementAmount).toBe(5000);
    // ⚠️ **整期金额的语义不变** —— 它是「这一期总共应结多少」
    //    （含回填进来的那笔 5000：货款 15000 − 佣金 1500 = 13500）
    expect(view!.netAmount).toBe(13500);

    // ---- 再申请一次 → 得到补差单 ----
    const supplement = await apply(merchant.token, period.label);
    expect(supplement.kind).toBe(PayoutKind.SUPPLEMENT);
    // ⚠️ **补差佣金恒为 0**（护栏 X9 / X13）
    expect(supplement.commissionAmount).toBe(0);
    expect(supplement.netAmount).toBe(5000);
    expect(supplement.receiptAmount).toBe(5000);
    expect(supplement.entryCount).toBe(1);
  });

  it('X16：补差单审批后金额与申请时一致（本单口径的唯一证据）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-07');
    const { merchant } = await setupPaidPeriodWithBackfill(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });

    const supplement = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, supplement.id);

    // ⚠️⚠️ **金额必须与申请时完全一致** ——
    //    若 `approve` 用了全局「未纳入」口径，本单自己纳入的流水会被当成
    //    未纳入 → 金额归零 → 这条断言会挂（护栏 X16）。
    expect(approved.commissionAmount).toBe(0);
    expect(approved.netAmount).toBe(supplement.netAmount);
    expect(approved.netAmount).toBe(5000);
    expect(approved.entryCount).toBe(supplement.entryCount);

    // ⚠️ **补差单也能打款成功**
    const paid = await waitForStatus(
      merchant.token,
      supplement.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();
  });

  it('X6：补差单 PAID 时不改结算单状态（它早已是 PAID）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-08');
    const { merchant, statementId } = await setupPaidPeriodWithBackfill(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );
    expect(statementId).not.toBeNull();

    const supplement = await apply(merchant.token, period.label);
    await approve(adminToken, supplement.id);
    await waitForStatus(merchant.token, supplement.id, PayoutStatus.PAID);

    const statement = await asPlatform(() =>
      prisma.settlementStatement.findFirst({ where: { id: statementId! } }),
    );
    // ⚠️ **结算单本来就该是 PAID** —— 补差单**不能**把它改成别的状态
    expect(statement!.status).toBe(SettlementStatus.PAID);
  });

  it('X8：补差单不允许再叠 —— 再申请返回同一张', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-09');
    const { merchant } = await setupPaidPeriodWithBackfill(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1500,
    });

    const first = await apply(merchant.token, period.label);
    const second = await apply(merchant.token, period.label);

    expect(second.id).toBe(first.id);
    expect(second.kind).toBe(PayoutKind.SUPPLEMENT);

    const count = await asPlatform(() =>
      prisma.payout.count({
        where: {
          tenantId: merchant.tenantId,
          periodStart: period.from,
          kind: PayoutKind.SUPPLEMENT,
        },
      }),
    );
    expect(count).toBe(1);
  });

  // ============================================================
  // X15：卡死告警去重
  // ============================================================

  it('X15：卡在 PROCESSING 的单只告警一次（stuckLoggedAt 记上后不再捞）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    // ⚠️ **直接改成 PROCESSING 且 processingAt 是 20 分钟前** ——
    //    假网关是同步返回的，造不出「回包丢失」（设计 §九·R3 的遗留 L48）。
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: {
          status: PayoutStatus.PROCESSING,
          processingAt: new Date(Date.now() - 20 * 60 * 1000),
        },
      }),
    );

    // ⚠️ **直接调扫描服务**（不走队列）——
    //    队列里注册一个周期任务太重，而这里要验的是「捞取条件」。
    const execution = app.get(PayoutExecutionService);
    const now = new Date();
    const first = await execution.scanStuck(now);
    // ⚠️ **PROCESSING 的单不能被救援**（护栏 R3：钱可能已经打出去）
    expect(first.map((item) => item.id)).not.toContain(applied.id);

    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    // ⚠️ **stuckLoggedAt 已写** —— 第二轮就不会再捞它
    expect(row!.stuckLoggedAt).not.toBeNull();

    const second = await execution.scanStuck(new Date());
    // ⚠️⚠️ **不能靠返回值判断「是否重复告警」** ——
    //    `scanStuck` 的返回值只含「APPROVED 救援单」，
    //    卡在 `PROCESSING` 的单**永远不会出现在返回值里** → 断言恒真。
    //    （失败注入 Y17 实测：这条断言恒真，去掉 `stuckLoggedAt` 条件后挂 0 条。）
    //    真正可观测的是 **`stuckLoggedAt` 有没有被再次改写** ——
    //    第二轮若又捞到它，`markStuckLogged` 会再写一次时间。
    const rowAfterSecond = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    expect(rowAfterSecond!.stuckLoggedAt).toEqual(row!.stuckLoggedAt);
    expect(second.map((item) => item.id)).not.toContain(applied.id);
  });

  it('R3：卡在 APPROVED 的单会被救援（确定没打出去，重新入队是安全的）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **直接造一张卡在 APPROVED 的单**（模拟「审批后入队失败」）
    //    正常流程走不出这个形状：审批成功就会入队 → worker 立刻消费掉。
    //    只能手工插库（`status = APPROVED` + 很久以前的审批时刻）。
    //
    // ⚠️ **不能靠「申请 → 审批」走这条路** —— 审批成功就会入队，
    //    worker 立刻把它消费掉 → 造不出「一直卡在 APPROVED」。
    //
    // ⚠️ **这一期不能再 `apply`** —— 同一商家同一期同一 `kind` 只能有一张
    //    活跃单（部分唯一索引 `(tenantId, periodStart, kind)`），
    //    插一张 NORMAL 会与它撞索引。
    const stuck = await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAYEX-STUCK-${unique()}`,
          kind: PayoutKind.NORMAL,
          periodStart: period.from,
          periodEnd: period.to,
          receiptAmount: 10000,
          commissionAmount: 1000,
          netAmount: 9000,
          entryCount: 1,
          status: PayoutStatus.APPROVED,
          requestedAmount: 9000,
          requestedBy: 'test-user',
          approvedBy: 'test-admin',
          approvedAt: new Date(Date.now() - 20 * 60 * 1000),
        },
      }),
    );

    const execution = app.get(PayoutExecutionService);
    const rescues = await execution.scanStuck(new Date());
    // ⚠️ **APPROVED 的单会被捞出来救援**
    expect(rescues.map((item) => item.id)).toContain(stuck.id);
  });

  // ============================================================
  // 救援判据：只救「从未被执行过」的单
  // ============================================================

  it('救援判据：正在退避等待重试的单不会被兜底扫描捞走', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-02');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **造一张「正在退避等待重试」的形状** ——
    //    状态是 `APPROVED`（`scheduleRetry` 退回的样子）+
    //    `approvedAt` 很久以前（`scheduleRetry` **不刷新** `approvedAt`）+
    //    `attemptCount ≥ 1`（已经被抢过一次）。
    //    它**不是**卡死的单，只是恰好状态也是 `APPROVED`。
    const retrying = await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAYEX-RETRY-${unique()}`,
          kind: PayoutKind.NORMAL,
          periodStart: period.from,
          periodEnd: period.to,
          receiptAmount: 10000,
          commissionAmount: 1000,
          netAmount: 9000,
          entryCount: 1,
          status: PayoutStatus.APPROVED,
          requestedAmount: 9000,
          requestedBy: 'test-user',
          approvedBy: 'test-admin',
          approvedAt: new Date(Date.now() - 20 * 60 * 1000),
          attemptCount: 1,
        },
      }),
    );

    const execution = app.get(PayoutExecutionService);
    const rescues = await execution.scanStuck(new Date());
    // ⚠️⚠️ **不能被捞走** ——
    //    被捞走会多出一个救援 job，与重试 job 抢同一张单 →
    //    本该按 30s / 60s 退避打完的 3 次预算**几秒内被烧完**。
    expect(rescues.map((item) => item.id)).not.toContain(retrying.id);
  });

  // ============================================================
  // 失败后重新申请：明细必须已释放
  // ============================================================

  it('失败后重新申请同一期能成功（落 FAILED 时明细已释放）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-03');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ⚠️ **让 3 次打款都失败** → 落 `FAILED`
    await armScenario(adminToken, { times: 3 });
    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);
    const failed = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.FAILED,
    );
    expect(failed).not.toBeNull();

    // ⚠️⚠️ **重新申请同一期** ——
    //    `markFailed` 必须**释放明细占用**（`payout_entries.entryId` 是全局
    //    唯一索引）。不释放的话，这里 `createMany` 会撞唯一索引 → P2002
    //    → 500（商家看到的是「服务器错误」，不是「请重新申请」）。
    const again = await apply(merchant.token, period.label);
    expect(again.id).not.toBe(applied.id);
    expect(again.status).toBe(PayoutStatus.REQUESTED);
  });

  // ============================================================
  // 审批时纳入的流水必须同步进明细
  // ============================================================

  it('审批时新纳入的流水必须同步进明细（否则同一笔能被再打一次）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-04');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);

    // ⚠️ **申请之后、审批之前来一笔流水** ——
    //    审批要重算（护栏 P5）→ 锁定的金额含这笔 → 明细也必须同步含它。
    const extraOrderId = await seedOrder(merchant.tenantId, {
      totalAmount: 3000,
    });
    await seedReceipt(merchant.tenantId, extraOrderId, {
      type: ReceiptType.SALE,
      amount: 3000,
      occurredAt: inside(period, 15),
    });

    const approved = await approve(adminToken, applied.id);
    // ⚠️ **重算后的金额**：货款 10000 + 3000 = 13000，佣金 1000（结算单定的）
    expect(approved.entryCount).toBe(2);
    expect(approved.netAmount).toBe(12000);

    // ⚠️⚠️ **明细必须与审批锁定的范围一致** ——
    //    不同步的话，这笔 3000 没被占用 → 商家能再申请一张补差单
    //    把**同一笔流水再打一次**（重复打款）。
    const links = await asPlatform(() =>
      prisma.payoutEntry.findMany({ where: { payoutId: applied.id } }),
    );
    expect(links).toHaveLength(2);
  });

  // ============================================================
  // P3 不放宽：正常单对着已 PAID 的结算单必须 409
  // ============================================================

  it('P3 不放宽：正常单对着已 PAID 的结算单 → 409（补差才放行）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-10');
    const { merchant, statementId } = await setupMerchantWithPeriod(
      adminToken,
      period,
      { receiptAmount: 10000, commissionAmount: 1500 },
    );
    expect(statementId).not.toBeNull();

    // ⚠️ **手工把结算单改成 PAID**（模拟「已出款」）
    await asPlatform(() =>
      prisma.settlementStatement.updateMany({
        where: { id: statementId! },
        data: { status: SettlementStatus.PAID, paidAt: new Date() },
      }),
    );

    // ⚠️ **正常单对 PAID 的结算单必须 409**（P3 不放宽）
    const response = await http(app)
      .post('/api/v1/merchant/payouts')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: period.label })
      .expect(409);
    expect(
      (response.body as { message?: string | string[] }).message,
    ).toBeDefined();

    // ⚠️ **一张单都没建**
    const count = await asPlatform(() =>
      prisma.payout.count({
        where: {
          tenantId: merchant.tenantId,
          periodStart: period.from,
          kind: PayoutKind.NORMAL,
        },
      }),
    );
    expect(count).toBe(0);
  });
});
