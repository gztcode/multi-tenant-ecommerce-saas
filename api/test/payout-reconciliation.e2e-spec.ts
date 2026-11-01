import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConflictException, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import {
  PayoutStatus,
  ReconciliationDiffType,
  ReconciliationSeverity,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { FakePayoutProvider } from '../src/common/payment/fake-payout.provider';
import { PayoutExecutionService } from '../src/modules/billing/payout-execution.service';
import { PayoutReconciliationResolver } from '../src/modules/payment/payout-reconciliation-resolver.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { resetPayoutData, seedPayout } from './payout-fixture';

/**
 * 阶段 5m：渠道对账的**差异处置**（e2e）。
 *
 * ## 本文件守的两条底线
 *
 * | 类型 | 处置 | 本文件验什么 |
 * |---|---|---|
 * | **A 类**（渠道说已打、本地卡在 `PROCESSING`） | **自动纠正** `PROCESSING → PAID` | 状态被纠正 + 有留痕 + 留痕带着对账任务 id |
 * | **B 类**（渠道说已打、本地记成了 `FAILED`） | **人工处置** `FAILED → PAID`（四道闸） | ⚠️ **闸没过必须拒绝**（机器不许改一笔钱的状态） |
 *
 * ⚠️ **B 类这里只验「闸 ① 挡住」** —— 其余三道闸（金额笔数、被他人占用、
 *    渠道核实 + 结算单状态）在 Task 7 / Task 8 补。
 *
 * ⚠️ **造数直接插 `payouts` 行** —— 正常流程造不出这些形状
 *    （「卡在 PROCESSING 的单」「记成失败的单」）。
 *
 * ⚠️ **本文件的 `seedPayout` 是 `./payout-fixture` 导出的短签名版本** ——
 *    只 `tenantId` 与 `status` 必填，其余走默认值；
 *    结算期自动错开（`nextPeriodStart()`），同一租户下造多张活跃单也不会
 *    撞部分唯一索引 `payouts_tenantId_period_kind_active_uniq`。
 */
describe('渠道对账 (e2e)', () => {
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

    // ⚠️ **暂停出款队列** —— 造数是直接插库的，
    //    worker 若抢到别的单会把队列状态搅乱。
    await payoutQueue.pause();

    // ⚠️ **对账是平台级扫描** —— 别的 e2e 文件留下的出款单会进比对结果
    //    （本地 PAID + 渠道查无此笔 → 多出一条 E 类差异）。
    //    e2e 文件共享同一个测试库 → 必须从干净状态开始。
    await resetPayoutData(prisma);
  });

  afterAll(async () => {
    await payoutQueue.resume();
    await app.close();
  });

  /** 在平台作用域里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /**
   * 平台超管登录（种子里已有这个账号）。
   *
   * ⚠️ **本 Task 的两个用例都直接调服务层，用不到登录** ——
   *    但它属于本文件的公共脚手架（后续用例要调平台端 HTTP 接口时会用到），
   *    先留着，不删。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  it('A 类：渠道 SUCCESS + 本地 PROCESSING → 自动纠正为 PAID', async () => {
    // 造一张 PROCESSING 的出款单
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // 造渠道流水（成功）
    await fakeProvider.execute({
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

    // 跑对账服务（Task 8 才有）→ 本 Task 直接调 resolver
    const resolver = app.get(PayoutReconciliationResolver);
    const resolved = await resolver.resolveAutoDiffs(
      [
        {
          type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
          severity: ReconciliationSeverity.INFO,
          payoutId: payout.id,
          channelTxnId: 'txn-auto',
          channelReferenceNo: payout.payoutNo,
          channelAmount: payout.netAmount,
          channelStatus: 'SUCCESS',
          channelPaidAt: new Date(),
          localAmount: payout.netAmount,
          localStatus: PayoutStatus.PROCESSING,
        },
      ],
      'recon-test-1',
    );

    expect(resolved).toBe(1);
    const row = await asPlatform(() =>
      prisma.payout.findFirst({ where: { id: payout.id } }),
    );
    expect(row!.status).toBe(PayoutStatus.PAID);
    // ⚠️ **必须有留痕** —— 谁在什么时候把哪张单改了
    const op = await asPlatform(() =>
      prisma.payoutOperation.findFirst({ where: { payoutId: payout.id } }),
    );
    expect(op!.action).toBe('RECONCILE_TO_PAID');
    expect(op!.reconciliationId).toBe('recon-test-1');
  });

  it('B 类：闸 ① 过不了（没有 releasedEntryIds）→ 拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.FAILED,
      failedAt: new Date(),
      // ⚠️ **不给 releasedEntryIds** → 闸 ① 挡住
    });

    const execution = app.get(PayoutExecutionService);
    await expect(
      execution.confirmPaidAfterReconciliation(payout.id, {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
