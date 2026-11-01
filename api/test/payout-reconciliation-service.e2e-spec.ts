import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { Queue } from 'bullmq';
import { PayoutStatus, ReconciliationDiffType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_QUEUE } from '../src/common/queue/queue.constants';
import { FakePayoutProvider } from '../src/common/payment/fake-payout.provider';
import { PayoutReconciliationService } from '../src/modules/payment/payout-reconciliation.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { resetPayoutData, seedPayout } from './payout-fixture';

/**
 * 阶段 5m：渠道对账的**服务与差异分类**（e2e）。
 *
 * ## 本文件守的底线
 *
 * 造出 A–F 六类差异并逐类断言：
 *
 * | 类 | 形态 | 枚举值 |
 * |---|---|---|
 * | A | 渠道 SUCCESS + 本地 PROCESSING | `CHANNEL_PENDING_LOCAL` |
 * | B | 渠道 SUCCESS + 本地 FAILED | `CHANNEL_SUCCESS_LOCAL_FAILED` |
 * | C | 渠道 SUCCESS + 本地 PAID 但金额不同 | `AMOUNT_MISMATCH` |
 * | D | 渠道有、本地没有这张单 | `CHANNEL_ONLY` |
 * | E | 渠道查无此笔 + 本地 PAID | `LOCAL_PAID_CHANNEL_ABSENT` |
 * | F | 渠道 FAILED + 本地 PAID | `STATUS_MISMATCH` |
 *
 * ⚠️ **队列继续暂停** —— 造数是直接插库的，
 *    worker 若抢到别的单会把队列状态搅乱。
 *
 * ⚠️ **渠道流水直接调 `fakeProvider.execute`** —— 造数路线照设计 §九·9.2：
 *    走真的渠道调用 → 假网关如实记录 → 对账时读得回来。
 */
describe('渠道对账服务与差异分类 (e2e)', () => {
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

  it('六类差异：造出 A/B/C/D/E/F 并断言分类', async () => {
    const merchant = await createMerchant(app, prisma);
    const tenantId = merchant.tenantId;

    // A 类：渠道 SUCCESS + 本地 PROCESSING
    const aPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // B 类：渠道 SUCCESS + 本地 FAILED
    const bPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.FAILED,
      failedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // C 类：渠道 SUCCESS + 本地 PAID + 金额不同
    const cPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // E 类：本地 PAID + 渠道查无此笔
    const ePayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // F 类：渠道 FAILED + 本地 PAID
    const fPayout = await seedPayout(prisma, {
      tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const call = (referenceNo: string, amount: number, attempt = 1) =>
      fakeProvider.execute({
        referenceId: referenceNo,
        referenceNo,
        amount,
        account: {
          accountName: '张三',
          bankName: '测试银行',
          accountNo: '6222000000000000',
        },
        attempt,
      });

    await call(aPayout.payoutNo, aPayout.netAmount);
    await call(bPayout.payoutNo, bPayout.netAmount);
    await call(cPayout.payoutNo, cPayout.netAmount + 1); // 金额不同
    fakeProvider.armScenario({ failTimes: 1 });
    await call(fPayout.payoutNo, fPayout.netAmount);
    // D 类：只调渠道、不建本地单
    await call('PAY-NOT-OURS-001', 1234);

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await app
      .get(PayoutReconciliationService)
      .trigger({ channel: 'fake-payout', from, to, operatorId: 'admin-1' });

    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: result.id },
      }),
    );
    const types = items.map((i) => i.type).sort();
    expect(types).toEqual(
      [
        ReconciliationDiffType.AMOUNT_MISMATCH,
        ReconciliationDiffType.CHANNEL_ONLY,
        ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
        ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
        ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
        ReconciliationDiffType.STATUS_MISMATCH,
      ].sort(),
    );
    // ⚠️ **E 类要单独断言** —— 它没有渠道流水，靠「本地 PAID 且查无此笔」判定
    const eItem = items.find((i) => i.payoutId === ePayout.id);
    expect(eItem?.type).toBe(ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT);
  });

  /**
   * ⚠️ **这条用例守的是「端点可达」** —— 曾经踩过的坑：
   *    对账端点原本挂在 `/platform/payouts/...` 下，而 billing 那边有
   *    `@Get('payouts/:id')` 且**先注册** → `reconciliations` 与
   *    `reconciliation-summary` 被 `:id` 抢先匹配 → `ParseUUIDPipe` 直接 400
   *    → **列表与统计端点 100% 不可达，且不报任何错**（只是 400）。
   *
   *    这种「静默遮蔽」靠读代码看不出来，只能靠端到端真的打一遍。
   */
  it('平台端点可达：列表与统计返回数据（不被别的路由遮蔽）', async () => {
    const token = await loginPlatformAdmin();

    const list = await http(app)
      .get('/api/v1/platform/payout-reconciliations?page=1&pageSize=20')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const listBody = list.body as {
      items: Array<{ id: string; status: string }>;
      total: number;
    };
    expect(Array.isArray(listBody.items)).toBe(true);
    expect(listBody.total).toBeGreaterThanOrEqual(0);

    // ⚠️ **统计端点必须排在 `:id` 之前** —— 两者都是 3 段路径
    const summary = await http(app)
      .get('/api/v1/platform/payout-reconciliations/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const summaryBody = summary.body as {
      pendingCritical: number;
      pendingWarning: number;
      pendingInfo: number;
    };
    expect(typeof summaryBody.pendingCritical).toBe('number');
    expect(typeof summaryBody.pendingWarning).toBe('number');
    expect(typeof summaryBody.pendingInfo).toBe('number');
  });

  /** 其余四个端点也要真的打一遍 —— 路径改过，别再被遮蔽了 */
  it('平台端点可达：触发、详情、单笔结论、处置差异', async () => {
    const token = await loginPlatformAdmin();
    const auth = `Bearer ${token}`;

    // ---- 触发 ----
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // ⚠️ **本用例自造一张本地已付的单** —— 不依赖前一个用例留下的数据：
    //    ① 单独跑这个用例（`-t` 过滤）时也要成立；
    //    ② 断言不能是「有就查、没有就跳过」的条件断言（那等于没断言）。
    const merchant = await createMerchant(app, prisma);
    const localPaid = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const trigger = await http(app)
      .post('/api/v1/platform/payout-reconciliations')
      .set('Authorization', auth)
      .send({ channel: 'fake-payout', from, to })
      .expect(200);
    const triggered = trigger.body as { id: string; status: string };
    expect(triggered.id).toBeTruthy();
    expect(triggered.status).toBe('COMPLETED');

    // ---- 详情 ----
    const detail = await http(app)
      .get(`/api/v1/platform/payout-reconciliations/${triggered.id}`)
      .set('Authorization', auth)
      .expect(200);
    const detailBody = detail.body as {
      id: string;
      items: Array<{
        id: string;
        type: string;
        resolution: string;
        payoutId: string | null;
      }>;
      itemsTruncated: boolean;
      itemsTotal: number;
    };
    expect(detailBody.id).toBe(triggered.id);
    // ⚠️ **本地已付 + 渠道查无此笔 → 必然有一条 E 类差异**
    const eItem = detailBody.items.find((i) => i.payoutId === localPaid.id);
    expect(eItem).toBeTruthy();
    expect(eItem!.type).toBe(ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT);

    // ---- 处置这条差异 ----
    const resolve = await http(app)
      .post(
        `/api/v1/platform/payout-reconciliations/${triggered.id}/items/${eItem!.id}/resolve`,
      )
      .set('Authorization', auth)
      .send({ resolution: 'IGNORED', note: 'e2e 测试处置' })
      .expect(200);
    expect(resolve.body).toEqual({ resolved: true });

    const after = await asPlatform(() =>
      prisma.payoutReconciliationItem.findFirst({
        where: { id: eItem!.id },
        select: { resolution: true, note: true },
      }),
    );
    expect(after?.resolution).toBe('IGNORED');
    expect(after?.note).toBe('e2e 测试处置');

    // ---- 单笔结论 ----
    const status = await http(app)
      .get(
        `/api/v1/platform/payout-reconciliations/payouts/${localPaid.id}/status`,
      )
      .set('Authorization', auth)
      .expect(200);
    expect((status.body as { payoutId: string }).payoutId).toBe(localPaid.id);
  });

  /**
   * ⚠️ **`resolution` 必须是枚举校验** —— TS 的字面量联合类型在运行时不存在，
   *    只校验字符串的话 `PENDING` 能被提交 → 这条差异**重新回到「未处置」**
   *    （运营明明处置过了，未处置统计却不降），且 `resolvedAt` 已写上、
   *    状态自相矛盾。写成别的字符串还会撞 PG 的 enum → 冒成 500。
   */
  it('处置差异：非法处置结果被拒（不能写回 PENDING）', async () => {
    const token = await loginPlatformAdmin();
    const auth = `Bearer ${token}`;

    // ⚠️ **自造数据** —— 不依赖别的用例留下的东西。
    //    本地已付 + 渠道查无此笔 → 对账必然产出一条 E 类差异。
    const merchant = await createMerchant(app, prisma);
    await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PAID,
      paidAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const trigger = await http(app)
      .post('/api/v1/platform/payout-reconciliations')
      .set('Authorization', auth)
      .send({ channel: 'fake-payout', from, to })
      .expect(200);
    const reconId = (trigger.body as { id: string }).id;

    const detail = await http(app)
      .get(`/api/v1/platform/payout-reconciliations/${reconId}`)
      .set('Authorization', auth)
      .expect(200);
    const item = (detail.body as { items: Array<{ id: string }> }).items[0];
    expect(item).toBeTruthy();

    await http(app)
      .post(
        `/api/v1/platform/payout-reconciliations/${reconId}/items/${item.id}/resolve`,
      )
      .set('Authorization', auth)
      .send({ resolution: 'PENDING', note: '试图写回未处置' })
      .expect(400);
  });
});
