import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import {
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
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 阶段 5l：出款单的人工处置（重试 / 解卡）与失败原因口径收口（e2e）。
 *
 * ⚠️ **本文件守的是「涉及真实资金」的那条底线**：
 *    `failedBeforePayout = true`（渠道从未被调用 → 钱确定没打出去）才允许重试；
 *    `false`（渠道调过了 → 钱**可能**已经打出去）必须 409 ——
 *    重试就是**重复打款**。
 *
 * ⚠️ **造数直接插 `payouts` 行** —— 正常流程造不出这些形状：
 *    「渠道调用前就失败的 FAILED 单」「卡在 PROCESSING 的单」
 *    「同期的另一张活跃单」。货款流水（`merchant_receipts`）也直接插 ——
 *    跑支付链路会把渠道与队列的噪声引进来。
 *
 * ⚠️ **每个用例造的数据都在 `finally` 里清掉** —— e2e 跑在真库上：
 *    残留的 `payout_entries` 会占住 `merchant_receipts.id`（全局唯一索引），
 *    残留的出款单会让下一轮用例撞上部分唯一索引
 *    `payouts_tenantId_period_kind_active_uniq`。
 *
 * ⚠️ **「重试」的请求体只有 `reason`**（`to` 是解卡才用的字段）——
 *    前端 `platform-admin/src/app/api/billing/payouts/[id]/retry/route.ts`
 *    重建请求体时也只传 `reason`。
 *    → DTO 的 `to` **必须** `@IsOptional()`：全局 `ValidationPipe` 没开
 *    `skipMissingProperties`，少了它就会拿 `undefined` 也校验一遍
 *    → **「重试」端点必然 400**（本文件第一次跑时正是这么挂的）。
 *
 * ⚠️ **出款队列被暂停**（`beforeAll` 里 `queue.pause()`，`afterAll` 里恢复）：
 *    重试会把单放回 `APPROVED` 并重新入队，若 worker 抢先消费：
 *    ① 抢单 → `PROCESSING` → 解密失败 → 落 `FAILED` → **明细被释放**；
 *    ② 「明细被重新纳入」那条断言就会随机挂（实测是竞态，不是偶发）。
 *    暂停队列只挡掉**后台 worker 的抢跑**，
 *    被测的四道闸（状态 / `failedBeforePayout` / 同期活跃单 / 金额笔数）
 *    一道不少地被触发 —— 闸全在服务层，与队列无关。
 *
 * ⚠️ **月份用 2022-01 ~ 2022-10** —— 本文件独占这十个月：
 *    其它 e2e 文件占用的是 2023-01 ~ 2026-09（结算单 / 抽佣台账 / 出款三组），
 *    `ledger-reconciliation.e2e-spec.ts` 的注释还点名「2023-05 / 07 / 10
 *    是留给它自己的」—— 本文件不去占。
 *    ⚠️ 每个用例用**自己独立的商家** —— 出款单的幂等键是
 *    `(tenantId, periodStart, kind)`，同一商家同一期反复造数据会让
 *    后一个用例拿到前一个用例的单据。
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

/** 明文账号（测试固定值；库里存的是密文，这里只用来造账户行） */
const PLAIN_ACCOUNT_NO = '6225880000000000';

/** 商家端出款单的一行（响应体） */
interface PayoutBody {
  id: string;
  payoutNo: string;
  kind: string;
  periodLabel: string;
  status: string;
  attemptCount: number;
  failureReason: string | null;
  failedBeforePayout: boolean;
  netAmount: number;
  entryCount: number;
  processingAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
}

/** 平台端出款单详情（含明细与操作留痕） */
interface PlatformDetailBody extends PayoutBody {
  failureDetail: string | null;
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
  }>;
  operations: Array<{
    id: string;
    action: string;
    operatorId: string;
    operatorName: string;
    operatedAt: string;
    reason: string;
    fromStatus: string;
    toStatus: string;
  }>;
}

/** 一个用例造出来的全部数据（用来在 `finally` 里清干净） */
interface Scenario {
  merchant: { token: string; tenantId: string; subdomain: string };
  orderIds: string[];
  receiptIds: string[];
  payoutIds: string[];
}

/** 出款单留痕的一行（库里） */
interface OperationRow {
  id: string;
  payoutId: string;
  action: string;
  operatorId: string;
  reason: string;
  fromStatus: string;
  toStatus: string;
  attemptCountBefore: number | null;
}

describe('出款单的人工处置与失败原因口径 (e2e)', () => {
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

    // ⚠️ **暂停出款队列** —— 理由见文件头。
    //    不暂停的话，重试入队的 job 会被 worker 立刻消费，
    //    把刚重试成功的单改成 `FAILED` 并**释放明细**，
    //    「明细被重新纳入」那条断言就成了竞态。
    await payoutQueue.pause();
  });

  afterAll(async () => {
    // ⚠️ **必须恢复队列** —— 否则同一 Redis 上的后续 e2e 跑不动。
    //    （万一这里没恢复，e2e 的 globalSetup 每次都会清空 `bull-e2e:*`，
    //    下一轮同样是干净的。）
    await payoutQueue.resume();
    await app.close();
  });

  /** 在平台作用域里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 平台超管登录（种子里已有这个账号） */
  async function loginPlatformAdmin(): Promise<{
    token: string;
    userId: string;
    displayName: string;
  }> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    const body = response.body as {
      accessToken: string;
      user: { id: string; displayName: string };
    };
    return {
      token: body.accessToken,
      userId: body.user.id,
      displayName: body.user.displayName,
    };
  }

  /** 错误响应里的 message（ValidationPipe 给的是数组，其余是字符串） */
  function messageOf(body: unknown): string {
    const message = (body as { message?: string | string[] }).message;
    if (Array.isArray(message)) return message.join('；');
    return message ?? '';
  }

  /** 造一笔订单（货款流水有指向它的外键 Restrict → 必须先有订单） */
  async function seedOrder(
    tenantId: string,
    totalAmount: number,
    occurredAt: Date,
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `PAYOPS-ORD-${unique()}`,
          status: OrderStatus.PAID,
          totalAmount,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: 500,
          commissionAmount: 0,
          paidAt: occurredAt,
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
    amount: number,
    occurredAt: Date,
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.merchantReceipt.create({
        data: {
          tenantId,
          orderId,
          orderNo: `PAYOPS-ORD-${unique()}`,
          type: ReceiptType.SALE,
          amount,
          occurredAt,
        },
      }),
    );
    return created.id;
  }

  /**
   * 造一个「有货款流水 + 有收款账户」的商家。
   *
   * @param receiptAmounts 该期要造几笔货款流水、各多少钱（分）
   */
  async function setupMerchant(
    period: Period,
    receiptAmounts: number[],
  ): Promise<Scenario> {
    const merchant = await createMerchant(app, prisma);
    const orderIds: string[] = [];
    const receiptIds: string[] = [];

    for (const [index, amount] of receiptAmounts.entries()) {
      // ⚠️ **每笔流水的归期错开** —— `computeAmounts` 按 `occurredAt` 排序，
      //    归期全一样的话排序不稳定（断言只比集合，但明细顺序会飘）。
      const occurredAt = inside(period, 5 + index);
      const orderId = await seedOrder(merchant.tenantId, amount, occurredAt);
      const receiptId = await seedReceipt(
        merchant.tenantId,
        orderId,
        amount,
        occurredAt,
      );
      orderIds.push(orderId);
      receiptIds.push(receiptId);
    }

    // ⚠️ **设收款账户** —— 出款单的快照要抄它（库里是密文）。
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: PLAIN_ACCOUNT_NO,
      })
      .expect(200);

    return { merchant, orderIds, receiptIds, payoutIds: [] };
  }

  /** 造一张出款单（直接插库：正常流程造不出这些状态组合） */
  async function seedPayout(options: {
    tenantId: string;
    period: Period;
    status: PayoutStatus;
    failedBeforePayout: boolean;
    receiptAmount: number;
    commissionAmount: number;
    netAmount: number;
    entryCount: number;
    attemptCount?: number;
    failureReason?: string | null;
    processingAt?: Date | null;
    approvedAt?: Date | null;
    failedAt?: Date | null;
    requestedBy?: string;
    approvedBy?: string | null;
    payoutNo?: string;
    kind?: PayoutKind;
  }): Promise<string> {
    // ⚠️ **快照抄账户行里那份密文**（与 `approve` 同款）——
    //    造出一张「快照齐全」的出款单，重试时 worker 才不会因缺快照而立刻失败。
    const account = await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: options.tenantId },
      }),
    );

    const created = await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: options.tenantId,
          payoutNo: options.payoutNo ?? `PAYOPS-${unique()}`,
          kind: options.kind ?? PayoutKind.NORMAL,
          periodStart: options.period.from,
          periodEnd: options.period.to,
          statementId: null,
          receiptAmount: options.receiptAmount,
          commissionAmount: options.commissionAmount,
          netAmount: options.netAmount,
          entryCount: options.entryCount,
          status: options.status,
          requestedAmount: options.netAmount,
          requestedBy: options.requestedBy ?? 'test-merchant-user',
          approvedBy: options.approvedBy ?? null,
          approvedAt: options.approvedAt ?? null,
          attemptCount: options.attemptCount ?? 0,
          failureReason: options.failureReason ?? null,
          processingAt: options.processingAt ?? null,
          failedAt: options.failedAt ?? null,
          failedBeforePayout: options.failedBeforePayout,
          snapshotAccountName: account?.accountName ?? null,
          snapshotBankName: account?.bankName ?? null,
          snapshotAccountNoCipher: account?.accountNoCipher ?? null,
          snapshotMaskedAccountNo: account?.maskedAccountNo ?? null,
          snapshotEncryptionVersion: account?.encryptionVersion ?? 0,
        },
      }),
    );
    return created.id;
  }

  /** 给一张出款单挂上明细（模拟它占着这些货款流水） */
  async function attachEntries(
    payoutId: string,
    entryIds: string[],
  ): Promise<void> {
    await asPlatform(() =>
      prisma.payoutEntry.createMany({
        data: entryIds.map((entryId) => ({ payoutId, entryId })),
      }),
    );
  }

  /** 这张单的明细条数 */
  async function countEntries(payoutId: string): Promise<number> {
    return asPlatform(() => prisma.payoutEntry.count({ where: { payoutId } }));
  }

  /** 这张单的留痕（库里） */
  async function listOperations(payoutId: string): Promise<OperationRow[]> {
    return asPlatform(() =>
      prisma.payoutOperation.findMany({
        where: { payoutId },
        orderBy: { operatedAt: 'asc' },
      }),
    );
  }

  /** 清掉一个用例造出来的全部数据 */
  async function cleanup(scenario: Scenario): Promise<void> {
    await asPlatform(async () => {
      // ⚠️ **顺序要紧**：
      //    ① 先删出款单（`payout_entries` / `payout_operations` 随它级联删）；
      //    ② 再删明细（它对 `merchant_receipts` 有 Restrict 外键）；
      //    ③ 再删流水（它对 `orders` 有 Restrict 外键）；
      //    ④ 最后删订单。
      if (scenario.payoutIds.length > 0) {
        await prisma.payout.deleteMany({
          where: { id: { in: scenario.payoutIds } },
        });
        await prisma.payoutEntry.deleteMany({
          where: { payoutId: { in: scenario.payoutIds } },
        });
        await prisma.payoutOperation.deleteMany({
          where: { payoutId: { in: scenario.payoutIds } },
        });
      }
      if (scenario.receiptIds.length > 0) {
        await prisma.merchantReceipt.deleteMany({
          where: { id: { in: scenario.receiptIds } },
        });
      }
      if (scenario.orderIds.length > 0) {
        await prisma.order.deleteMany({
          where: { id: { in: scenario.orderIds } },
        });
      }
      await prisma.merchantPayoutAccount.deleteMany({
        where: { tenantId: scenario.merchant.tenantId },
      });
    });
  }

  /** 平台端重试 */
  function platformRetry(token: string, payoutId: string, reason: string) {
    return http(app)
      .post(`/api/v1/platform/payouts/${payoutId}/retry`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason });
  }

  /** 平台端解卡 */
  function platformUnstick(
    token: string,
    payoutId: string,
    to: 'FAILED' | 'APPROVED',
    reason: string,
  ) {
    return http(app)
      .post(`/api/v1/platform/payouts/${payoutId}/unstick`)
      .set('authorization', `Bearer ${token}`)
      .send({ to, reason });
  }

  /** 平台端读出款单详情 */
  async function fetchPlatformDetail(
    token: string,
    payoutId: string,
  ): Promise<PlatformDetailBody> {
    const response = await http(app)
      .get(`/api/v1/platform/payouts/${payoutId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as PlatformDetailBody;
  }

  /** 商家端读出款单详情 */
  async function fetchMerchantDetail(
    token: string,
    payoutId: string,
  ): Promise<PayoutBody> {
    const response = await http(app)
      .get(`/api/v1/merchant/payouts/${payoutId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as PayoutBody;
  }

  // ============================================================
  // 用例 1：重试 —— 确定没打钱的失败单 → APPROVED + 明细重新纳入 + 留痕
  // ============================================================

  it('重试：确定没打钱的失败单 → 状态回 APPROVED、明细被重新纳入、attemptCount 归零、留痕一行 RETRY', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-01');
    const scenario = await setupMerchant(period, [10000, 20000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        // ⚠️ **「渠道从未被调用」** —— 钱确定没打出去 → 允许重试
        failedBeforePayout: true,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 2,
        attemptCount: 2,
        failureReason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);

      // ---- 先给它挂上明细（模拟它曾经占着这两笔流水）----
      await attachEntries(payoutId, scenario.receiptIds);

      // ---- ⚠️⚠️ **模拟 `markFailed` 的释放：把明细删掉** ----
      //
      //    这一步是「明细被重新纳入」那条断言的**牙齿**：
      //    不先删，重试后「明细还在」可能是「压根没删过」，
      //    实现若**没有**「重新纳入」这一步，断言照样会过（恒真）。
      //    删掉之后，重试必须**重新算一遍并插回去**，断言才有意义。
      await asPlatform(() =>
        prisma.payoutEntry.deleteMany({ where: { payoutId } }),
      );
      // 前置断言：明细确实被释放了
      expect(await countEntries(payoutId)).toBe(0);

      // ---- 重试 ----
      const response = await platformRetry(
        admin.token,
        payoutId,
        '渠道调用前失败，重新打款',
      );
      expect(response.status).toBe(200);

      // ---- 断言 ①：状态回 APPROVED、attemptCount 归零 ----
      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.APPROVED);
      expect(after.attemptCount).toBe(0);
      // ⚠️ **失败原因被清掉** —— 这张单现在不是失败单了
      expect(after.failureReason).toBeNull();
      // ⚠️ **`failedBeforePayout` 归 false** ——
      //    这一列的语义是「**这次**失败发生在打款之前」；
      //    现在没有失败 → false（真要再失败，worker 会重新写）。
      expect(after.failedBeforePayout).toBe(false);

      // ---- 断言 ②：明细被重新纳入（库里 + 详情接口）----
      const links = await asPlatform(() =>
        prisma.payoutEntry.findMany({ where: { payoutId } }),
      );
      expect(links.map((link) => link.entryId).sort()).toEqual(
        [...scenario.receiptIds].sort(),
      );
      expect(after.entries.map((entry) => entry.entryId).sort()).toEqual(
        [...scenario.receiptIds].sort(),
      );

      // ---- 断言 ③：留痕一行 RETRY ----
      const operations = await listOperations(payoutId);
      expect(operations).toHaveLength(1);
      expect(operations[0].action).toBe('RETRY');
      expect(operations[0].reason).toBe('渠道调用前失败，重新打款');
      expect(operations[0].fromStatus).toBe(PayoutStatus.FAILED);
      expect(operations[0].toStatus).toBe(PayoutStatus.APPROVED);
      expect(operations[0].operatorId).toBe(admin.userId);
      // ⚠️ **尝试次数要记在留痕里** —— 「这张单之前试了几次」是排查的线索
      expect(operations[0].attemptCountBefore).toBe(2);

      // ---- 断言 ④：详情接口把留痕带出来，操作人显示的是名字不是 uuid ----
      expect(after.operations).toHaveLength(1);
      expect(after.operations[0].action).toBe('RETRY');
      expect(after.operations[0].operatorName).toBe(admin.displayName);

      // ---- 断言 ⑤：重新入队了，且 jobId 的轮次是 1 ----
      //
      // ⚠️ **jobId 绝不能复用** —— BullMQ 里 finished job 的 hash 还在，
      //    用同一个 jobId 重新入队会被**静默忽略**（不报错、不入队 →
      //    重试从未发生）。轮次必须单调递增。
      const job = await payoutQueue.getJob(`payout-${payoutId}-retry-1`);
      expect(job).toBeDefined();
      expect(job!.data).toEqual({ payoutId });
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 2：重试 —— 钱可能已经打出去 → 409
  // ============================================================

  it('重试：钱可能已经打出去的单（failedBeforePayout = false）→ 409，状态不变、没有任何留痕', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-02');
    const scenario = await setupMerchant(period, [30000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        // ⚠️ **渠道调过了，只是没成功回包** → 钱可能已经打出去
        failedBeforePayout: false,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 3,
        failureReason: '渠道金额核对不通过（请求 30000 分，渠道返回 30001 分）',
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);

      const response = await platformRetry(admin.token, payoutId, '想直接重试');
      expect(response.status).toBe(409);
      // ⚠️ **消息要说清「可能已经打款」** —— 运营看到 409 要知道下一步做什么
      expect(messageOf(response.body)).toContain('可能已经打款');

      // ---- 状态一点没变 ----
      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.FAILED);
      expect(after.attemptCount).toBe(3);
      expect(after.failedBeforePayout).toBe(false);

      // ---- 一条留痕都不能有** —— 被拒绝的操作不该留痕（留痕 = 操作**发生过**）
      expect(await listOperations(payoutId)).toHaveLength(0);
      expect(after.operations).toHaveLength(0);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 3：重试 —— 该期有别的活跃单 → 409（消息含那张单的单号）
  // ============================================================

  it('重试：该期有另一张活跃出款单 → 409，消息里带那张单的单号', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-03');
    const scenario = await setupMerchant(period, [30000]);

    try {
      // ⚠️ **失败的这一张**（渠道调用前失败）
      const failedId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        failedBeforePayout: true,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 1,
        failureReason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(failedId);

      // ⚠️⚠️ **同一期的另一张活跃单** ——
      //    `FAILED` 不在部分唯一索引的排除列表之外（它在列表里），
      //    所以「一张 FAILED + 一张 APPROVED」能共存。
      const otherPayoutNo = `PAYOPS-ACTIVE-${unique()}`;
      const otherId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.APPROVED,
        failedBeforePayout: false,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 0,
        approvedAt: new Date(),
        approvedBy: admin.userId,
        payoutNo: otherPayoutNo,
      });
      scenario.payoutIds.push(otherId);

      const response = await platformRetry(admin.token, failedId, '想重试这张');
      expect(response.status).toBe(409);
      // ⚠️ **消息必须点名那张单** —— 运营得知道先去处理哪一张
      expect(messageOf(response.body)).toContain(otherPayoutNo);

      // ---- 两张单的状态都没变 ----
      const after = await fetchPlatformDetail(admin.token, failedId);
      expect(after.status).toBe(PayoutStatus.FAILED);
      expect(await listOperations(failedId)).toHaveLength(0);

      const other = await fetchPlatformDetail(admin.token, otherId);
      expect(other.status).toBe(PayoutStatus.APPROVED);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 4：重试 —— 期间金额变了 → 409
  // ============================================================

  it('重试：失败之后该期金额变了 → 409，不能替商家决定打多少', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-04');
    const scenario = await setupMerchant(period, [10000]);

    try {
      // ---- 失败时锁定的是 10000 分 / 1 笔 ----
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        failedBeforePayout: true,
        receiptAmount: 10000,
        commissionAmount: 0,
        netAmount: 10000,
        entryCount: 1,
        attemptCount: 1,
        failureReason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);

      // ---- ⚠️ **期间又回填了一笔 5000 分的货款** ----
      //
      //    这就是「金额变了」的现实形状：单子失败之后、运营点重试之前，
      //    商家又卖了一单。重算出来是 15000 分 / 2 笔，与锁定的 10000 / 1 不一致。
      //    → 让商家重新申请（走正常审批），而不是运营替他决定打多少。
      const occurredAt = inside(period, 20);
      const extraOrderId = await seedOrder(
        scenario.merchant.tenantId,
        5000,
        occurredAt,
      );
      const extraReceiptId = await seedReceipt(
        scenario.merchant.tenantId,
        extraOrderId,
        5000,
        occurredAt,
      );
      scenario.orderIds.push(extraOrderId);
      scenario.receiptIds.push(extraReceiptId);

      const response = await platformRetry(admin.token, payoutId, '想重试这张');
      expect(response.status).toBe(409);
      expect(messageOf(response.body)).toContain('金额已变化');

      // ---- 状态没变、没有留痕 ----
      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.FAILED);
      expect(after.netAmount).toBe(10000);
      expect(await listOperations(payoutId)).toHaveLength(0);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 5：重试 —— 原因为空 → 400
  // ============================================================

  it('重试：原因为空（或只有空白）→ 400，涉及钱的操作不能没有理由', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-05');
    const scenario = await setupMerchant(period, [30000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        failedBeforePayout: true,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 1,
        failureReason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);

      // ---- 空字符串：DTO 的 `@IsNotEmpty` 直接拦下 ----
      const empty = await platformRetry(admin.token, payoutId, '');
      expect(empty.status).toBe(400);
      expect(messageOf(empty.body)).toContain('操作原因不能为空');

      // ---- 只有空白：DTO 放行（它只判空串），服务层的 trim 兜住 ----
      const blank = await platformRetry(admin.token, payoutId, '   ');
      expect(blank.status).toBe(400);
      expect(messageOf(blank.body)).toContain('操作原因不能为空');

      // ---- 单子一点没动 ----
      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.FAILED);
      expect(after.attemptCount).toBe(1);
      expect(await listOperations(payoutId)).toHaveLength(0);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 6：解卡 —— PROCESSING → FAILED
  // ============================================================

  it('解卡（转失败）：PROCESSING → FAILED，明细被释放、留痕一行 UNSTUCK_TO_FAILED', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-06');
    const scenario = await setupMerchant(period, [10000, 20000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.PROCESSING,
        // ⚠️ **卡在「打款中」** —— 钱**可能**已经打出去
        failedBeforePayout: false,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 2,
        attemptCount: 2,
        // ⚠️ **卡住超过 10 分钟** —— 不到阈值不许解卡（见下一条用例）
        processingAt: new Date(Date.now() - 20 * 60 * 1000),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);
      // ⚠️ **卡住的单仍然占着明细** —— 它还没结束
      await attachEntries(payoutId, scenario.receiptIds);
      expect(await countEntries(payoutId)).toBe(2);

      const response = await platformUnstick(
        admin.token,
        payoutId,
        'FAILED',
        '核对渠道流水，确认没有打出去',
      );
      expect(response.status).toBe(200);

      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.FAILED);
      // ⚠️ **`processingAt` 必须清** —— 不清的话兜底扫描会把它当成卡住的单反复捞
      expect(after.processingAt).toBeNull();
      // ⚠️ **认定「钱没打出去」→ 之后可以重试**
      expect(after.failedBeforePayout).toBe(true);
      // ⚠️ **尝试次数保持不动** —— 「这张单卡住时试了几次」是排查线索
      expect(after.attemptCount).toBe(2);

      // ---- 明细被释放 ----
      // ⚠️ **单子结束了，商家可以对该期重新申请** ——
      //    不释放的话，商家重新申请时 `payout_entries.entryId` 的唯一索引会撞。
      expect(await countEntries(payoutId)).toBe(0);

      // ---- 留痕一行 UNSTUCK_TO_FAILED ----
      const operations = await listOperations(payoutId);
      expect(operations).toHaveLength(1);
      expect(operations[0].action).toBe('UNSTUCK_TO_FAILED');
      expect(operations[0].reason).toBe('核对渠道流水，确认没有打出去');
      expect(operations[0].fromStatus).toBe(PayoutStatus.PROCESSING);
      expect(operations[0].toStatus).toBe(PayoutStatus.FAILED);
      expect(operations[0].attemptCountBefore).toBe(2);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 7：解卡 —— PROCESSING → APPROVED
  // ============================================================

  it('解卡（重新打款）：PROCESSING → APPROVED，明细仍被占着、attemptCount 归零、留痕一行 UNSTUCK_TO_APPROVED', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-07');
    const scenario = await setupMerchant(period, [10000, 20000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.PROCESSING,
        failedBeforePayout: false,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 2,
        attemptCount: 2,
        processingAt: new Date(Date.now() - 20 * 60 * 1000),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);
      await attachEntries(payoutId, scenario.receiptIds);

      const response = await platformUnstick(
        admin.token,
        payoutId,
        'APPROVED',
        '核对渠道确认没打出去，重新打款',
      );
      expect(response.status).toBe(200);

      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.APPROVED);
      expect(after.processingAt).toBeNull();
      // ⚠️ **尝试次数归零** —— 重新打款是一次全新的执行
      expect(after.attemptCount).toBe(0);

      // ---- ⚠️⚠️ **明细绝不能释放** ----
      //
      //    释放了商家就能对同期重新申请 → 同一笔流水打两次钱。
      expect(await countEntries(payoutId)).toBe(2);
      expect(after.entries).toHaveLength(2);

      // ---- 留痕一行 UNSTUCK_TO_APPROVED ----
      const operations = await listOperations(payoutId);
      expect(operations).toHaveLength(1);
      expect(operations[0].action).toBe('UNSTUCK_TO_APPROVED');
      expect(operations[0].fromStatus).toBe(PayoutStatus.PROCESSING);
      expect(operations[0].toStatus).toBe(PayoutStatus.APPROVED);
      expect(operations[0].attemptCountBefore).toBe(2);

      // ---- 重新入队了 ----
      //
      // ⚠️ **轮次从 1 起算** —— `UNSTUCK_TO_APPROVED` 与 `RETRY` 一起计数，
      //    两种动作都是「会重新打款」的动作。
      const job = await payoutQueue.getJob(`payout-${payoutId}-retry-1`);
      expect(job).toBeDefined();
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 8：解卡 —— processingAt 还在阈值内 → 409
  // ============================================================

  it('解卡：processingAt 还在卡住阈值内 → 409，不许打断正在进行的打款', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-08');
    const scenario = await setupMerchant(period, [10000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.PROCESSING,
        failedBeforePayout: false,
        receiptAmount: 10000,
        commissionAmount: 0,
        netAmount: 10000,
        entryCount: 1,
        attemptCount: 1,
        // ⚠️ **1 分钟前** —— 远不到 10 分钟的卡住阈值
        processingAt: new Date(Date.now() - 60 * 1000),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(payoutId);
      await attachEntries(payoutId, scenario.receiptIds);

      const response = await platformUnstick(
        admin.token,
        payoutId,
        'FAILED',
        '想把它标成失败',
      );
      expect(response.status).toBe(409);
      expect(messageOf(response.body)).toContain('阈值');

      // ---- 单子一点没动 ----
      const after = await fetchPlatformDetail(admin.token, payoutId);
      expect(after.status).toBe(PayoutStatus.PROCESSING);
      expect(after.attemptCount).toBe(1);
      expect(await countEntries(payoutId)).toBe(1);
      expect(await listOperations(payoutId)).toHaveLength(0);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 9：口径 —— 商家端不含渠道原文，平台端含原文
  // ============================================================

  it('口径：商家端 failureReason 不含渠道原文，平台端 failureDetail 含原文', async () => {
    const admin = await loginPlatformAdmin();
    const period = month('2022-09');
    const scenario = await setupMerchant(period, [30000]);

    try {
      // ---- ① 「钱可能已经打出去」那一桶：渠道原文 ----
      const channelReason =
        '渠道金额核对不通过（请求 30000 分，渠道返回 30001 分）';
      const channelPayoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        failedBeforePayout: false,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 3,
        failureReason: channelReason,
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(channelPayoutId);

      // ---- 商家端：只有业务口径 ----
      const merchantView = await fetchMerchantDetail(
        scenario.merchant.token,
        channelPayoutId,
      );
      expect(merchantView.failureReason).toBe(
        '出款未完成，请联系平台确认出款情况',
      );
      expect(merchantView.failureReason).not.toContain('金额核对不通过');
      // ⚠️⚠️ **整个响应体都不能带原文** ——
      //    只断言一个字段的话，字段名改一个就漏掉了。
      expect(JSON.stringify(merchantView)).not.toContain('金额核对不通过');
      // ⚠️ **渠道原文里的数字也不能泄给商家**
      expect(JSON.stringify(merchantView)).not.toContain('30001');

      // ---- 平台端：`failureDetail` 才是原文 ----
      const platformView = await fetchPlatformDetail(
        admin.token,
        channelPayoutId,
      );
      expect(platformView.failureDetail).toContain('渠道金额核对不通过');
      expect(platformView.failureDetail).toContain('30001');

      // ---- ② 「确定没打」那一桶：白名单里的措辞原样透传 ----
      //
      // ⚠️ **这一桶的措辞本来就是给商家看的**（worker 在打款前拦截时写入的），
      //    换成一句笼统的话反而会**说错原因**：
      //    金额异常的单被告知「收款账号信息异常」→ 商家去改收款账户，
      //    改完再申请还是同样的错 → 白跑一趟。
      const safeReason =
        '收款账号信息异常，本次未打款，请更新收款账户后重新申请';
      const safePayoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        failedBeforePayout: true,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 1,
        failureReason: safeReason,
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: admin.userId,
      });
      scenario.payoutIds.push(safePayoutId);

      const safeMerchantView = await fetchMerchantDetail(
        scenario.merchant.token,
        safePayoutId,
      );
      expect(safeMerchantView.failureReason).toBe(safeReason);
      expect(safeMerchantView.failedBeforePayout).toBe(true);
    } finally {
      await cleanup(scenario);
    }
  });

  // ============================================================
  // 用例 10：并发 —— 两个超管同时点重试 → 一个成功一个 409
  // ============================================================

  it('并发：两个超管同时点重试 → 恰好一个成功、一个 409，只有一条留痕', async () => {
    const adminA = await loginPlatformAdmin();
    const adminB = await loginPlatformAdmin();
    const period = month('2022-10');
    const scenario = await setupMerchant(period, [30000]);

    try {
      const payoutId = await seedPayout({
        tenantId: scenario.merchant.tenantId,
        period,
        status: PayoutStatus.FAILED,
        failedBeforePayout: true,
        receiptAmount: 30000,
        commissionAmount: 0,
        netAmount: 30000,
        entryCount: 1,
        attemptCount: 1,
        failureReason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: adminA.userId,
      });
      scenario.payoutIds.push(payoutId);

      // ---- ⚠️ **两个请求同时发出**（不是先后）----
      //
      //    护栏是**数据库层的条件更新**（`where` 带 `status = FAILED`）：
      //    第二个请求要么在前置检查里看到状态已变，要么在事务里
      //    `updateMany` 命中 0 行 —— 两条路都是 409。
      const [first, second] = await Promise.all([
        platformRetry(adminA.token, payoutId, '并发重试 A'),
        platformRetry(adminB.token, payoutId, '并发重试 B'),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      // ---- 只成功了一次 ----
      const after = await fetchPlatformDetail(adminA.token, payoutId);
      expect(after.status).toBe(PayoutStatus.APPROVED);
      expect(after.attemptCount).toBe(0);

      // ---- 只有一条留痕** —— 两次点击不能记成两次操作
      const operations = await listOperations(payoutId);
      expect(operations).toHaveLength(1);
      expect(operations[0].action).toBe('RETRY');
    } finally {
      await cleanup(scenario);
    }
  });
});
