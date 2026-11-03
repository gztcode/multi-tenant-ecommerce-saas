import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import { OrderStatus, PayoutStatus, ReceiptType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { FakePayoutProvider } from '../src/common/payment/fake-payout.provider';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';
import { seedPayout } from './payout-fixture';

/**
 * 阶段 5m：解卡重打的前置闸（e2e）。
 *
 * ⚠️ **本文件守的是「钱只能打一次」那条底线**：
 *    出款单卡在 `PROCESSING`（打款请求发出去了，回包没回来）时，
 *    运营点一下「解卡重打」就可能**打两次钱**——
 *    「卡在 PROCESSING」最可能的成因恰恰是「请求发出去了、回包丢了」，
 *    钱**可能已经打到商家账上**。
 *
 *    → 解卡前必须先问渠道「这一笔到底打没打」：
 *    - 渠道说 **SUCCESS** → **拒绝解卡**（已经打过了）；
 *    - 渠道说 **FAILED** → **放行**（渠道明确说没打）；
 *    - **问不出结论** → **拒绝**（宁可不做，也不要重复打款）。
 *
 * ⚠️ **独立文件** —— 解卡闸与「对账差异的 A/B 类处置」是两个主题，
 *    本仓的 e2e 约定是「一个主题一个文件」。
 *
 * ⚠️ **队列要暂停** —— 这三个用例走 `unstick`，
 *    若 `to='APPROVED'` 会把单放回队列 → worker 抢到就会真的打款，
 *    「状态必须没变」的断言就变成竞态。
 *
 * ⚠️ **渠道流水靠 `FakePayoutProvider` 造** —— 它按 `referenceNo`
 *    存下每次 `execute` 的真实结果（阶段 5m Task 2），
 *    `queryPayout({ referenceNo })` 按真实记录回答，查不到返回 `UNKNOWN`。
 *    → 「渠道说 SUCCESS / FAILED / 问不出结论」三种情形都能造出来。
 *
 * ⚠️ **结算期自动错开** —— `seedPayout` 不给 `periodStart` 时会自己错开
 *    （部分唯一索引 `payouts_tenantId_period_kind_active_uniq`
 *    不允许同一租户下两张同期的活跃单）。
 *
 * ⚠️⚠️ **「拒绝」的价值全在「一个字节都不能改」** ——
 *    这道闸的全部意义是「拒绝时**什么都不发生**」。
 *    只断言 `status` 没变是不够的 —— 实现完全可能：
 *    先把 `processingAt` 清了再抛错（→ 兜底扫描捞不到这张卡单了）、
 *    先把 `failedBeforePayout` 改成 `true` 再抛错（→ 造出一张「可安全重试」的单）、
 *    先释放了明细再抛错（→ 商家能对同期重新申请 → 同一笔流水打两次钱）、
 *    先写了留痕再抛错（→ 留痕说「发生过一次解卡」，但其实没有）、
 *    先入队再抛错（→ 队列里多出一个 job，worker 一恢复就打款）。
 *    → 本文件对**每一处 `unstick` 会碰的东西**都断言「原样不变」。
 */
describe('解卡重打的前置闸 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let fakeProvider: FakePayoutProvider;
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
    fakeProvider = app.get(FakePayoutProvider);
    payoutQueue = app.get(getQueueToken(PAYOUT_QUEUE));

    // ⚠️ **暂停出款队列** —— 这三个用例走 `unstick`，
    //    若 `to='APPROVED'` 会把单放回队列 → worker 抢到就会打款，
    //    「状态必须没变」的断言就变成竞态。
    await payoutQueue.pause();
  });

  afterAll(async () => {
    await payoutQueue.resume();
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
    const body = response.body as { accessToken: string };
    return body.accessToken;
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
          orderNo: `P5M-ORD-${unique()}`,
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
          orderNo: `P5M-ORD-${unique()}`,
          type: ReceiptType.SALE,
          amount,
          occurredAt,
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

  /** 这张单的明细行（库里） */
  async function listEntries(
    payoutId: string,
  ): Promise<Array<{ entryId: string }>> {
    return asPlatform(() =>
      prisma.payoutEntry.findMany({
        where: { payoutId },
        orderBy: { entryId: 'asc' },
        select: { entryId: true },
      }),
    );
  }

  /** 这张单的留痕（库里） */
  async function listOperations(
    payoutId: string,
  ): Promise<Array<{ action: string }>> {
    return asPlatform(() =>
      prisma.payoutOperation.findMany({
        where: { payoutId },
        orderBy: { operatedAt: 'asc' },
        select: { action: true },
      }),
    );
  }

  /**
   * 拍一张出款单的**当前快照**（用来和「解卡之后」比）。
   *
   * ⚠️ **必须在触发解卡之前拍** —— 见 `expectNothingChanged` 的说明。
   */
  async function snapshotPayout(payoutId: string): Promise<{
    status: string;
    processingAt: Date | null;
    failedBeforePayout: boolean;
    attemptCount: number;
    failedAt: Date | null;
    failureReason: string | null;
    releasedEntryIds: string | null;
  }> {
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payoutId } }),
    );
    expect(row).not.toBeNull();
    return {
      status: row!.status,
      processingAt: row!.processingAt,
      failedBeforePayout: row!.failedBeforePayout,
      attemptCount: row!.attemptCount,
      failedAt: row!.failedAt,
      failureReason: row!.failureReason,
      releasedEntryIds: row!.releasedEntryIds,
    };
  }

  /**
   * 出款队列里与这张单相关的 job id 集合。
   *
   * ⚠️ **为什么不能只查 `payout-{id}-retry-1`** —— 那只覆盖「重新打款」那一轮。
   *    `unstick` 走 `APPROVED` 分支时入队的 jobId 由 `enqueueRetry` 生成
   *    （`payout-{id}-retry-N`），但实现若换了个 jobId 规则，
   *    只查一个固定 id 就查不到 → 断言恒真（没有牙齿）。
   *    → 这里把队列里**所有** job 捞出来，按 jobId 里含 payoutId 过滤。
   *
   * ⚠️ **状态列表只列 BullMQ 认的**（`JobState` = `finished | active |
   *    delayed | prioritized | waiting | waiting-children`）——
   *    `'paused'` **不是**合法状态（传进去会 400）。
   *    队列被暂停时 job 落在 `waiting` / `wait` 里（实测），都在列表内。
   */
  async function queueJobIdsFor(payoutId: string): Promise<string[]> {
    const jobs = await payoutQueue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'prioritized',
      'waiting-children',
    ]);
    return jobs
      .map((job) => job.id ?? '')
      .filter((jobId) => jobId.includes(payoutId))
      .sort();
  }

  /** 一个用例造出来的全部数据（用来在 `finally` 里清干净） */
  interface Scenario {
    merchant: { token: string; tenantId: string; subdomain: string };
    orderIds: string[];
    receiptIds: string[];
    payoutIds: string[];
  }

  /**
   * 造一个「有货款流水」的商家。
   *
   * ⚠️ **明细必须先挂上** —— 闸的实现会查 `payout_entries`
   *    （`unstick` 转 `FAILED` 分支会释放明细；核实闸本身在
   *    `payout.service.ts` 的 `unstick` 里按 `payoutId` 查明细）。
   *    一张单一张明细都没有的话，「明细被释放/被改动」那条断言
   *    就恒真（没有东西可释放）→ 断言没有牙齿。
   */
  async function setupMerchantWithReceipts(
    receiptAmounts: number[],
  ): Promise<Scenario> {
    const merchant = await createMerchant(app, prisma);
    const orderIds: string[] = [];
    const receiptIds: string[] = [];
    // ⚠️ **归期固定在 2021 年** —— `seedPayout` 的自动错开期是从
    //    2021-01-02 起算的，这里的流水落在同一片区间里，
    //    免得流水与单的结算期对不上（`computeAmounts` 按期取数）。
    const base = new Date(Date.UTC(2021, 0, 1));
    for (const [index, amount] of receiptAmounts.entries()) {
      const occurredAt = new Date(base.getTime() + index * 86_400_000);
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
    return { merchant, orderIds, receiptIds, payoutIds: [] };
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

  /**
   * 断言「这次被拒的解卡，一个字节都没改」。
   *
   * ⚠️ **必须拿「请求之前」的快照来比** ——
   *    若在请求**之后**才去库里读「原值」，读到的已经是**被改过的值**，
   *    断言两边相等 → **恒真** → 没有牙齿
   *    （这个坑真踩过：变异测试里把 `failedBeforePayout` 改成 `true`
   *    竟然一路绿灯通过，因为「改后的值」被当成了「原值」）。
   *    → 快照必须在**触发解卡之前**拍好。
   *
   * ⚠️ **逐条对应 `unstick` 会碰到的每一处** ——
   *    `payout.service.ts` 的 `unstick` 在闸之后会做：
   *    ① `payouts.status` 改成 `toStatus`；
   *    ② `payouts.processingAt` 清空；
   *    ③ `payouts.failedBeforePayout`（转 FAILED 时置 `true`）；
   *    ④ `payouts.attemptCount`（转 APPROVED 时归零）；
   *    ⑤ `payouts.failedAt` / `failureReason` / `releasedEntryIds`（转 FAILED 时）；
   *    ⑥ `payout_entries` 整批删除（转 FAILED 时释放明细）；
   *    ⑦ `payout_operations` 写一行留痕；
   *    ⑧ 出款队列入队一个 job（转 APPROVED 时）。
   *    → 闸没过时，①~⑧ **全部**都不该发生。
   */
  async function expectNothingChanged(
    payoutId: string,
    entryIds: string[],
    before: {
      status: string;
      processingAt: Date | null;
      failedBeforePayout: boolean;
      attemptCount: number;
      failedAt: Date | null;
      failureReason: string | null;
      releasedEntryIds: string | null;
    },
  ): Promise<void> {
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payoutId } }),
    );
    expect(row).not.toBeNull();

    // ---- ① `status` 没变 ----
    expect(row!.status).toBe(before.status);
    expect(row!.status).toBe(PayoutStatus.PROCESSING);
    // ---- ② `processingAt` 没被清掉 ----
    //
    //    ⚠️ **清了会被兜底扫描当成「卡住」重复捞** ——
    //    `scanStuck` 靠 `processingAt` 判定「卡住」，
    //    它一被清，这张卡单就永远捞不到了（也永远没人来救它）。
    expect(row!.processingAt).not.toBeNull();
    expect(row!.processingAt!.getTime()).toBe(before.processingAt!.getTime());
    // ---- ③ `failedBeforePayout` 没被改 ----
    //
    //    ⚠️ **它是「钱是否确定没打」的判据** ——
    //    被改成 `true` 就等于凭空造出一张「可安全重试」的单。
    expect(row!.failedBeforePayout).toBe(before.failedBeforePayout);
    // ---- ④ `attemptCount` 没被改 ----
    //    （转 APPROVED 时它会被归零 —— 那是「一次全新的执行」的语义）
    expect(row!.attemptCount).toBe(before.attemptCount);
    // ---- ⑤ 失败相关字段没被写 ----
    expect(row!.failedAt).toBe(before.failedAt);
    expect(row!.failureReason).toBe(before.failureReason);
    expect(row!.releasedEntryIds).toBe(before.releasedEntryIds);

    // ---- ⑥ `payout_entries` 整批明细原样不动 ----
    //
    //    ⚠️ **明细被释放 = 账漂移** ——
    //    `payout_entries.entryId` 是全局唯一索引，占着就代表
    //    「这笔流水只能被这张单打一次」。
    //    释放了 → 商家能对同期重新申请 → **同一笔流水打两次钱**。
    const entries = await listEntries(payoutId);
    expect(entries.map((e) => e.entryId).sort()).toEqual([...entryIds].sort());

    // ---- ⑦ `payout_operations` 一条留痕都不能有 ----
    //
    //    ⚠️ **闸没过就不该有任何「解卡」留痕** ——
    //    留痕 = 操作**发生过**；被拒的操作不是操作。
    expect(await listOperations(payoutId)).toHaveLength(0);

    // ---- ⑧ 出款队列里不该因为这次被拒的解卡多出/少掉 job ----
    expect(await queueJobIdsFor(payoutId)).toEqual([]);
  }

  it('解卡闸：渠道说 SUCCESS → 拒绝解卡，一个字节都不能改', async () => {
    const adminToken = await loginPlatformAdmin();
    const scenario = await setupMerchantWithReceipts([10000, 20000]);
    try {
      const payout = await seedPayout(prisma, {
        tenantId: scenario.merchant.tenantId,
        status: PayoutStatus.PROCESSING,
        processingAt: new Date(Date.now() - 20 * 60 * 1000), // 超过 10 分钟阈值
        attemptCount: 2,
      });
      scenario.payoutIds.push(payout.id);

      // ⚠️ **先挂明细** —— 闸的实现会查 `payout_entries`，
      //    一张明细都没有的话「明细没被动过」那条断言是恒真的（没有牙齿）。
      await attachEntries(payout.id, scenario.receiptIds);
      expect(await listEntries(payout.id)).toHaveLength(2);

      // 造渠道流水（成功）
      await fakeProvider.submit({
        referenceId: payout.id,
        referenceNo: payout.payoutNo,
        amount: payout.netAmount,
        account: {
          accountName: '张三',
          bankName: '测试银行',
          accountNo: '6222000000000000',
        },
        attempt: 1,
      });

      // ⚠️ **快照必须在触发解卡之前拍** —— 否则拿「改后的值」当「原值」比，
      //    断言恒真（变异测试里真踩过这个坑）。
      const before = await snapshotPayout(payout.id);

      const response = await http(app)
        .post(`/api/v1/platform/payouts/${payout.id}/unstick`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ to: 'APPROVED', reason: '测试解卡' });

      expect(response.status).toBe(409);

      // ⚠️ **拒绝解卡就一张都不能重打，且一个字节都不能改**
      await expectNothingChanged(payout.id, scenario.receiptIds, before);
    } finally {
      await cleanup(scenario);
    }
  });

  it('解卡闸：渠道说 FAILED → 放行解卡', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // 造渠道流水（失败）
    // ⚠️ **阶段 6b：解卡闸只认「确定失败」** —— 结果未知的失败会被核实
    //    服务判为「问不出结论」，解卡会被拒绝。
    fakeProvider.armScenario({ definitiveFailureTimes: 1 });
    await fakeProvider.submit({
      referenceId: payout.id,
      referenceNo: payout.payoutNo,
      amount: payout.netAmount,
      account: {
        accountName: '张三',
        bankName: '测试银行',
        accountNo: '6222000000000000',
      },
      attempt: 1,
    });

    const response = await http(app)
      .post(`/api/v1/platform/payouts/${payout.id}/unstick`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ to: 'FAILED', reason: '渠道确认没打出去' });

    expect(response.status).toBe(200);
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payout.id } }),
    );
    expect(row!.status).toBe(PayoutStatus.FAILED);
  });

  it('解卡闸：问不出结论 → 拒绝解卡（fail-closed），一个字节都不能改', async () => {
    const adminToken = await loginPlatformAdmin();
    const scenario = await setupMerchantWithReceipts([30000]);
    try {
      const payout = await seedPayout(prisma, {
        tenantId: scenario.merchant.tenantId,
        status: PayoutStatus.PROCESSING,
        processingAt: new Date(Date.now() - 20 * 60 * 1000),
        attemptCount: 1,
      });
      scenario.payoutIds.push(payout.id);

      // ⚠️ **先挂明细** —— 理由同上：没有明细就验不了「明细没被动过」。
      await attachEntries(payout.id, scenario.receiptIds);
      expect(await listEntries(payout.id)).toHaveLength(1);

      // ⚠️ **渠道侧没有任何流水** → 实时核实返回 UNKNOWN → 降级查对账结果 → 也没有

      // ⚠️ **快照必须在触发解卡之前拍** —— 否则拿「改后的值」当「原值」比，
      //    断言恒真（变异测试里真踩过这个坑）。
      const before = await snapshotPayout(payout.id);

      const response = await http(app)
        .post(`/api/v1/platform/payouts/${payout.id}/unstick`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ to: 'APPROVED', reason: '测试解卡' });

      expect(response.status).toBe(409);

      await expectNothingChanged(payout.id, scenario.receiptIds, before);
    } finally {
      await cleanup(scenario);
    }
  });
});
