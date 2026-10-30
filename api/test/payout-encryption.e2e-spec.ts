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
 * 阶段 5j：收款账户与出款单快照的字段加密（e2e）。
 *
 * ⚠️ **这些用例不验证「密文长什么样」** —— 密文格式是实现细节。
 *    它们验证的是**对外可观察的行为**：
 *    ① 库里的账号不是明文 ② API 只给掩码 ③ 打款渠道收到的是完整明文。
 *
 * ⚠️ **月份用 2025-08 ~ 2025-11**：本文件自己独占这四个月，
 *    与 `payout-execution.e2e-spec.ts`（2025-08 ~ 2026-09）、
 *    `payout.e2e-spec.ts`（2025-01 ~ 2026-09）、
 *    `ledger-reconciliation.e2e-spec.ts`（2023 / 2025-08 ~ 2026-06）
 *    都撞了月份。
 *    ⚠️ **但每个用例用自己独立的商家** —— 出款单的幂等键是
 *    `(tenantId, periodStart, kind)`，同一商家同一期反复造数据会让
 *    后一个用例拿到前一个用例的单据。
 *    ⚠️ 撞月份本身不致命：断言全是**「这个商家的这一张单」**
 *    形态，不做「全库恰好几张单」的断言。
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

/** 明文账号（测试固定值，便于断言「渠道收到的就是它」） */
const PLAIN_ACCOUNT_NO = '6225880000000000';

/** 收款账户的响应体 */
interface PayoutAccountBody {
  accountName: string;
  bankName: string;
  maskedAccountNo: string;
  updatedAt: string;
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

describe('收款账户与出款单快照的字段加密 (e2e)', () => {
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

  /** 造一笔订单（货款流水有指向它的外键 Restrict → 必须先有订单） */
  async function seedOrder(
    tenantId: string,
    options: { totalAmount?: number; commissionAmount?: number } = {},
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `PAYENC-ORD-${unique()}`,
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
  ): Promise<void> {
    await asPlatform(() =>
      prisma.merchantReceipt.create({
        data: {
          tenantId,
          orderId,
          orderNo: `PAYENC-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          occurredAt: options.occurredAt,
        },
      }),
    );
  }

  /** 造一笔抽佣流水（结算单的原料） */
  async function seedEntry(
    tenantId: string,
    orderId: string,
    options: {
      type: CommissionEntryType;
      amount: number;
      occurredAt: Date;
    },
  ): Promise<void> {
    await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId,
          orderNo: `PAYENC-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          rateBps: 500,
          baseAmount: 20000,
          occurredAt: options.occurredAt,
        },
      }),
    );
  }

  /** 生成结算单（平台侧） */
  async function generate(
    token: string,
    period: string,
    tenantId: string,
  ): Promise<string> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${token}`)
      .send({ period, tenantId })
      .expect(200);
    const body = response.body as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    return body.items[0].id;
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

  /** 商家设置收款账户 */
  async function setPayoutAccount(
    token: string,
    accountNo = PLAIN_ACCOUNT_NO,
  ): Promise<PayoutAccountBody> {
    const response = await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo,
      })
      .expect(200);
    return response.body as PayoutAccountBody;
  }

  /** 商家读收款账户 */
  async function fetchPayoutAccount(token: string): Promise<PayoutAccountBody> {
    const response = await http(app)
      .get('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as PayoutAccountBody;
  }

  /**
   * 造一个「有货款流水 + 已确认结算单 + 有收款账户」的商家（周期可申请）。
   *
   * @param setAccount 是否顺手设置收款账户（默认设置）
   */
  async function setupMerchantWithPeriod(
    adminToken: string,
    period: Period,
    options: {
      receiptAmount: number;
      commissionAmount: number;
      setAccount?: boolean;
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

      statementId = await generate(adminToken, period.label, merchant.tenantId);
      await confirmStatement(adminToken, statementId);
    }

    if (options.setAccount !== false) {
      await setPayoutAccount(merchant.token);
    }

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

  /** 平台审批通过 */
  async function approve(adminToken: string, id: string): Promise<PayoutBody> {
    const response = await http(app)
      .post(`/api/v1/platform/payouts/${id}/approve`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  /** 平台读出款单详情 */
  async function fetchPlatformDetail(
    adminToken: string,
    id: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .get(`/api/v1/platform/payouts/${id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
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

  /**
   * 等一个条件成立（轮询）。
   *
   * ⚠️ **间隔 100ms、超时 20 秒** —— 与 `payout-execution.e2e-spec.ts`
   *   同款：打款要经过「审批 → 入队 → worker 消费 → 调渠道 → 落状态」。
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
  // 用例 1：落库的是密文，掩码串与版本号都对
  // ============================================================

  it('商家设账户 → 库里存的是密文，不是明文账号', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-08');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ---- 查库看账户行 ----
    const account = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
      }),
    );
    expect(account).not.toBeNull();

    // ⚠️⚠️ **核心断言：库里存的不能是明文** ——
    //    这条断言才是「库泄露不等于账号泄露」的牙齿。
    //    只断言「掩码串对」是不够的：密文列若还存着明文，
    //    掩码串照样对，但账号照样在库里裸奔。
    expect(account!.accountNoCipher).not.toBe(PLAIN_ACCOUNT_NO);
    expect(account!.accountNoCipher).not.toContain(PLAIN_ACCOUNT_NO);
    // ⚠️ **密文里也不能有账号的任何一段**（防止「只加密了一半」）
    expect(account!.accountNoCipher).not.toContain('62258800');
    expect(account!.accountNoCipher).not.toContain('0000');

    // ⚠️ **掩码串单独存**：密文长度 ≠ 明文长度，
    //    而掩码要按明文长度打星 → 不解密就还原不出掩码。
    expect(account!.maskedAccountNo).toBe('************0000');
    expect(account!.maskedAccountNo).not.toContain(PLAIN_ACCOUNT_NO);

    // ⚠️ **版本号是 1（已加密）** —— 0 表示「这行还没迁移」
    expect(account!.encryptionVersion).toBe(1);
  });

  // ============================================================
  // 用例 2：读账户只给掩码
  // ============================================================

  it('商家读账户 → 只返回掩码串，响应里没有完整账号', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-09');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const view = await fetchPayoutAccount(merchant.token);

    // ⚠️ **只给掩码串**
    expect(view.maskedAccountNo).toBe('************0000');
    expect(view.accountName).toBe('张三');
    expect(view.bankName).toBe('招商银行');

    // ⚠️⚠️ **整个响应里不能有完整账号**（护栏 X14）——
    //    断言整个响应体，而不是只断言某个字段：
    //    字段名改一个就漏掉了。
    expect(JSON.stringify(view)).not.toContain(PLAIN_ACCOUNT_NO);
    // ⚠️ **也不能有「除了掩码之外」的账号片段** ——
    //    只查完整串的话，「6225880000」这种半截也会漏过去。
    expect(JSON.stringify(view)).not.toContain('62258800');
    // ⚠️ **响应里也不该出现密文本身** ——
    //    展示路径读掩码列，不解密；把密文端出去等于换个地方存账号。
    const account = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
      }),
    );
    expect(JSON.stringify(view)).not.toContain(account!.accountNoCipher);
  });

  // ============================================================
  // 用例 3：出款单的快照也是密文
  // ============================================================

  it('申请出款 → 出款单快照存的是密文', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-10');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);

    const payout = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: applied.id } }),
    );
    expect(payout).not.toBeNull();

    // ⚠️⚠️ **核心断言：快照不是明文账号**
    expect(payout!.snapshotAccountNoCipher).not.toBeNull();
    expect(payout!.snapshotAccountNoCipher).not.toBe(PLAIN_ACCOUNT_NO);
    expect(payout!.snapshotAccountNoCipher).not.toContain('62258800');

    // ⚠️ **掩码串跟着走**
    expect(payout!.snapshotMaskedAccountNo).toBe('************0000');

    // ⚠️ **版本号跟着密文一起复制** ——
    //    否则会出现「密文是新的、版本号是 0」的错配，
    //    打款时解密会以为没迁移而抛错。
    expect(payout!.snapshotEncryptionVersion).toBe(1);

    // ⚠️ **快照复制的是账户行里那份密文本身** ——
    //    「重新加密」会得到不同的密文（随机 iv），
    //    而「快照 = 审批那一刻的那一份」要求复制同一份密文。
    const account = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
      }),
    );
    expect(payout!.snapshotAccountNoCipher).toBe(account!.accountNoCipher);
  });

  // ============================================================
  // 用例 4：平台端读出款单只给掩码
  // ============================================================

  it('平台端读出款单 → 快照是掩码串，响应里没有完整账号', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2025-11');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    const approved = await approve(adminToken, applied.id);
    expect(approved.status).toBe(PayoutStatus.APPROVED);

    // ---- 平台端详情 ----
    const detail = await fetchPlatformDetail(adminToken, applied.id);

    // ⚠️ **掩码串正确**
    expect(detail.maskedSnapshotAccountNo).toBe('************0000');

    // ⚠️⚠️ **整个响应里不能有完整账号**（护栏 X14）
    expect(JSON.stringify(detail)).not.toContain(PLAIN_ACCOUNT_NO);
    expect(JSON.stringify(detail)).not.toContain('62258800');

    // ⚠️ **商家端也一样** —— 商家看自己的出款单同样只该看到掩码
    const merchantDetail = await fetchMerchantDetail(
      merchant.token,
      applied.id,
    );
    expect(merchantDetail.maskedSnapshotAccountNo).toBe('************0000');
    expect(JSON.stringify(merchantDetail)).not.toContain(PLAIN_ACCOUNT_NO);
  });

  // ============================================================
  // 用例 5：打款渠道收到的是完整明文（解密链路通了）
  // ============================================================

  it('审批并打款 → 渠道收到的是完整明文账号', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-01');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);
    await approve(adminToken, applied.id);

    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();

    // ⚠️⚠️ **核心断言：渠道收到的是完整明文账号** ——
    //    这是「加密没有把打款功能打断」的证据。
    //    只断言「库里是密文」的话，实现把打款也改成传掩码串
    //    （钱打不出去）也能过。
    const fake = app.get(FakePayoutProvider);
    const received = fake.receivedRequest(applied.id);
    expect(received).toBeDefined();
    expect(received!.account).not.toBeNull();
    expect(received!.account.accountNo).toBe(PLAIN_ACCOUNT_NO);
    // ⚠️ **户名与开户行是明文**（它们本来就印在卡面上）
    expect(received!.account.accountName).toBe('张三');
    expect(received!.account.bankName).toBe('招商银行');
    expect(received!.amount).toBe(paid!.netAmount);
  });

  // ============================================================
  // 用例 6：未迁移的行 → 读路径抛错（绝不按明文兜底）
  // ============================================================

  it('未迁移的行（版本号 0）→ 打款路径抛错，不按明文兜底', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-02');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);

    // ⚠️ **把快照的版本号改回 0** —— 模拟「这张单是在迁移前出的，
    //    快照里的账号压根没加密」。
    //
    // ⚠️ **为什么改快照而不是账户行**：这条要验的是**打款路径**
    //    （`payout-execution.service.ts` 的 `decryptVersioned`），
    //    它读的是**出款单上的快照**。改账户行验的是写路径闸（下面那条）。
    //
    // ⚠️ **改完必须还原** —— e2e 跑在真库上，残留的 `version = 0`
    //    会污染后续用例（这里用 try/finally 保证一定还原）。
    const originalVersion = (await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: applied.id },
        select: { snapshotEncryptionVersion: true },
      }),
    ))!.snapshotEncryptionVersion;

    try {
      await asPlatform(() =>
        prisma.payout.updateMany({
          where: { id: applied.id },
          data: { snapshotEncryptionVersion: 0 },
        }),
      );

      // ---- 手工把它拨成 APPROVED —— 绕过 approve 的入队路径 ----
      //
      // ⚠️ **为什么不用 `approve`**：
      //    审批会**重新抄一份账户行里的密文**（`approve` 的事务里覆盖快照）
      //    → 改在审批前的快照会被覆盖掉；
      //    改在审批后的话，worker 可能已经抢到单打完了。
      //    手工置 `APPROVED` 既不覆盖快照，也**不入队** → 没有竞态。
      await asPlatform(() =>
        prisma.payout.updateMany({
          where: { id: applied.id },
          data: {
            status: PayoutStatus.APPROVED,
            approvedAt: new Date(),
            approvedBy: 'test-admin',
          },
        }),
      );

      // ---- 直接调抢单这一步 —— 它就是解密发生的地方 ----
      //
      // ⚠️ **为什么不走队列**：解密在 `claimForExecution` 里，
      //    而 worker 的 try/catch 只包住「调渠道」那一段 →
      //    解密抛错会让 job 变成 BullMQ 的 failed job，
      //    **出款单停在 `PROCESSING`**（既没 PAID 也没 FAILED）。
      //    那个「停在 PROCESSING」是**另一个话题**（卡死告警会兜住它），
      //    这条用例要守的是「**解密失败绝不按明文兜底**」——
      //    直接调这一步，异常会原样抛到测试手里。
      const execution = app.get(PayoutExecutionService);
      await expect(
        execution.claimForExecution(applied.id, new Date()),
      ).rejects.toThrow(/尚未加密/);

      // ⚠️⚠️ **错误消息必须指向「没加密」** ——
      //    实现若按明文兜底（拿明文当密文去解），
      //    这里会是「密文解密失败（密钥不匹配，或密文已被篡改）」——
      //    消息长得像，但根因不同：按明文兜底等于把加密悄悄关掉，
      //    迁移脚本也永远不会提醒运维去补迁移。
      //    → 所以除了「尚未加密」，还要看到「迁移」这两个字。
      let message = '';
      try {
        await execution.claimForExecution(applied.id, new Date());
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('尚未加密');
      // ⚠️ **必须点名迁移命令** —— 运维看到「尚未加密」还不够，
      //    他得知道**敲哪条命令**才能修好。
      expect(message).toContain('migrate:payout-encryption');
      expect(message).not.toContain('密钥不匹配');

      // ⚠️ **钱绝不能打出去** —— 解密失败就不能调渠道。
      //    这里直接调的是抢单这一步，压根没走到渠道，
      //    但把「渠道没收到过请求」钉死更保险。
      const fake = app.get(FakePayoutProvider);
      expect(fake.receivedRequest(applied.id)).toBeUndefined();
    } finally {
      // ⚠️⚠️ **还原版本号** —— 真库上残留 `version = 0` 会污染后续用例。
      await asPlatform(() =>
        prisma.payout.updateMany({
          where: { id: applied.id },
          data: { snapshotEncryptionVersion: originalVersion },
        }),
      );
    }

    // ---- 实测还原结果 ----
    const restored = await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: applied.id },
        select: { snapshotEncryptionVersion: true },
      }),
    );
    expect(restored!.snapshotEncryptionVersion).toBe(originalVersion);
    expect(restored!.snapshotEncryptionVersion).toBe(1);

    // ---- 还原后这张单能正常打款（证明抛错确实是版本号触发的）----
    //
    // ⚠️ **刚才的 `claimForExecution` 抛错前已经把单改成 `PROCESSING` 了**
    //    （抢单是事务里的第一步更新），所以这里要先把它拨回 `APPROVED`，
    //    否则 worker 抢不到单（护栏 X1 的条件更新）。
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: { status: PayoutStatus.APPROVED, processingAt: null },
      }),
    );
    await payoutQueue.add(
      'execute',
      { payoutId: applied.id },
      { jobId: `payenc-unmigrated-${applied.id}`, attempts: 1 },
    );
    const paid = await waitForStatus(
      merchant.token,
      applied.id,
      PayoutStatus.PAID,
    );
    expect(paid).not.toBeNull();

    // ⚠️ **渠道最终收到的是完整明文账号** —— 解密链路本身是通的，
    //    刚才的失败纯粹是版本号不对造成的。
    const fake = app.get(FakePayoutProvider);
    const received = fake.receivedRequest(applied.id);
    expect(received).toBeDefined();
    expect(received!.account.accountNo).toBe(PLAIN_ACCOUNT_NO);
  });

  // ============================================================
  // 用例 7：写路径闸 —— 账户行没加密 → 不许建单
  // ============================================================

  it('账户行未加密（版本号 0）→ 申请出款被拒，且不新建出款单', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-03');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    // ---- 把账户行的版本号改回 0 ----
    //
    // ⚠️ **模拟「这家商家在迁移前就设过账户，迁移脚本没跑到它」** ——
    //    这行的 `accountNoCipher` 里存的是**明文**（迁移前的旧数据）。
    const originalVersion = (await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
        select: { encryptionVersion: true },
      }),
    ))!.encryptionVersion;

    try {
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { tenantId: merchant.tenantId },
          data: { encryptionVersion: 0 },
        }),
      );

      // ---- 申请出款 → 必须被拒 ----
      //
      // ⚠️ **不断言具体状态码**：闸可能给 400（参数/数据不合法）
      //    也可能给 409（与现有状态冲突）。这里只断言「**不是 201**」
      //    且「**没建单**」—— 这才是这条用例真正要守的东西。
      const response = await http(app)
        .post('/api/v1/merchant/payouts')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ period: period.label });
      expect(response.status).not.toBe(201);
      expect(response.status).toBeGreaterThanOrEqual(400);
      // ⚠️ **必须带错误消息** —— 商家要知道为什么不能申请，
      //    而不是看到一个「服务器错误」。
      expect(
        (response.body as { message?: string | string[] }).message,
      ).toBeDefined();

      // ⚠️⚠️ **一张单都没建** ——
      //    闸必须在建单**之前**生效。若闸在事务里但先建了单再回滚，
      //    这条断言也过；真正要防的是「单建出来了、只是没走审批」。
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

      // ⚠️⚠️ **更关键：没有明文快照落库** ——
      //    闸若只是「不建单」但把快照写进了别的行（脏数据），
      //    这里会露出来。整张表扫一遍，确认这个商家名下没有任何
      //    含明文账号的快照。
      const payouts = await asPlatform(() =>
        prisma.payout.findMany({ where: { tenantId: merchant.tenantId } }),
      );
      expect(payouts).toHaveLength(0);
      for (const payout of payouts) {
        expect(payout.snapshotAccountNoCipher ?? '').not.toContain(
          PLAIN_ACCOUNT_NO,
        );
      }
    } finally {
      // ⚠️⚠️ **还原版本号** —— 真库上残留 `version = 0` 会污染后续用例：
      //    下一次申请出款会被这道闸直接拒掉。
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { tenantId: merchant.tenantId },
          data: { encryptionVersion: originalVersion },
        }),
      );

      // ⚠️⚠️⚠️ **还要清掉「闸没生效时建出来的单」** ——
      //    闸没落地时，`apply` 会成功建单，而那张单的快照**复制了
      //    版本 0 的账户行** → 库里留下一张「密文是新的、版本号是 0」
      //    的错配行。它会污染后续用例（打款时会因版本号不对而抛错）。
      //    这里无条件删一遍：闸生效时这里本来就该是空的（删不到东西）。
      await asPlatform(() =>
        prisma.payout.deleteMany({
          where: { tenantId: merchant.tenantId },
        }),
      );
    }

    // ---- 实测还原结果 ----
    const restored = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
        select: { encryptionVersion: true },
      }),
    );
    expect(restored!.encryptionVersion).toBe(originalVersion);
    expect(restored!.encryptionVersion).toBe(1);

    // ---- 还原后申请出款能成功（证明闸确实是版本号触发的）----
    const applied = await apply(merchant.token, period.label);
    expect(applied.status).toBe(PayoutStatus.REQUESTED);
  });
});
