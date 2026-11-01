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
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { resetPayoutData, seedPayout } from './payout-fixture';

/** 导入端点的响应体 */
interface ImportResponseBody {
  id: string;
  diffCount: number;
  matchedCount: number;
  /** ⚠️ **没解析出任何打款时刻时才有** —— 提示 D 类差异检不出来 */
  warning?: string;
  /** 被跳过的行数（⚠️ **不是 0 就说明账单有行没参与对账**） */
  skippedRowCount?: number;
  /** 被跳过的行明细（行号 + 原因） */
  skippedRows?: { rowNumber: number; reason: string }[];
  /** 被跳过的行明细是否被截断（⚠️ **截断了就不能当成「就这么多行有问题」**） */
  skippedRowsTruncated?: boolean;
}

/**
 * 阶段 5m：渠道对账的 **CSV 账单导入**（e2e）。
 *
 * ## 本文件守的两条底线
 *
 * | 底线 | 为什么 |
 * |---|---|
 * | **上传的账单能被解析成渠道流水并进同一个比对引擎** | 真渠道没有 API，只能给账单文件 —— 这是阶段 5m 的最后一块拼图 |
 * | **金额单位换算不能错** | 元 → 分差 100 倍，猜错就是对账结论全错 |
 *
 * ⚠️ **本仓第一个 multipart e2e** —— supertest 的 `.attach` + `.field`。
 *
 * ⚠️ **造数直接插 `payouts` 行** —— 正常流程造不出「卡在 `PROCESSING` 的单」。
 */
describe('渠道对账的 CSV 账单导入 (e2e)', () => {
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

  it('CSV 导入：上传一份账单 → 断言解析出的差异', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // ⚠️ **本仓第一个 multipart e2e** —— supertest 的 `.attach` + `.field`
    const csv = [
      '交易号,业务单号,金额(元),状态,打款时间',
      `txn-csv-1,${payout.payoutNo},85.00,成功,2026-03-02 10:00:00`,
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          referenceNoColumn: '业务单号',
          amountColumn: '金额(元)',
          amountUnit: 'YUAN',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS', 失败: 'FAILED' },
          paidAtColumn: '打款时间',
        }),
      );

    expect(response.status).toBe(200);
    const body = response.body as ImportResponseBody;
    // ⚠️ **金额单位换算** —— 85.00 元 = 8500 分
    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: body.id },
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe(ReconciliationDiffType.CHANNEL_PENDING_LOCAL);
    expect(items[0].channelAmount).toBe(8500);
  });

  it('CSV 导入：不配时间列 → 响应里必须带警告（D 类差异检不出来）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    // ⚠️ **这条渠道流水匹配不到任何本地单** —— 正常情况是 D 类
    //    （渠道打了钱、本地没记录）。
    const csv = ['交易号,金额(分),状态', 'txn-csv-orphan,9900,成功'].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-no-time.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS' },
          // ⚠️ **刻意不配 paidAtColumn**
        }),
      );

    expect(response.status).toBe(200);
    const body = response.body as ImportResponseBody;
    // ⚠️ **必须有警告** —— 没时刻 → D 类判定跳过 → 差异数 0。
    //    不提示的话运营会把「差异数 0」当成「钱没问题」。
    expect(body.warning).toBeDefined();
    expect(body.warning).toContain('D 类');

    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: body.id },
      }),
    );
    // ⚠️ **D 类真的检不出来** —— 时刻缺失 → 引擎直接跳过这条孤儿流水。
    //    这正是为什么要警告。
    //    （只断言「没有 D 类」而不是「一条都没有」—— 别的用例留在默认窗口里的
    //      本地单会产出 E 类，那是与本用例无关的差异。）
    expect(
      items.filter((i) => i.type === ReconciliationDiffType.CHANNEL_ONLY),
    ).toHaveLength(0);
    expect(merchant.tenantId).toBeTruthy();
  });

  it('CSV 导入：配了时间列 → 同样一条孤儿流水能检出 D 类（对照上一条）', async () => {
    const adminToken = await loginPlatformAdmin();

    // ⚠️ **与上一条同形的账单，唯一的区别是多了「打款时间」列** ——
    //    这一条是上一条的对照：证明「检不出来」是缺时刻造成的，
    //    而不是 CSV 解析本身有问题。
    const csv = [
      '交易号,金额(分),状态,打款时间',
      'txn-csv-orphan-2,9900,成功,2026-03-02 10:00:00',
    ].join('\n');

    // ⚠️ **时间窗要盖住 CSV 里的时刻** —— 默认窗口是「最近 24 小时」，
    //    而 CSV 的时刻写死在 2026-03-02 → 落在窗口外 → 引擎按设计忽略。
    const from = '2026-03-01T00:00:00.000Z';
    const to = '2026-03-03T00:00:00.000Z';

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-with-time.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS' },
          paidAtColumn: '打款时间',
        }),
      )
      .field('from', from)
      .field('to', to);

    expect(response.status).toBe(200);
    const body = response.body as ImportResponseBody;
    // ⚠️ **配了时间列就不要警告** —— 警告是给「检不出来」的场景用的，
    //    无差别地报会把真正要看的警告淹掉。
    expect(body.warning).toBeUndefined();

    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: body.id },
      }),
    );
    const dClass = items.filter(
      (i) => i.type === ReconciliationDiffType.CHANNEL_ONLY,
    );
    expect(dClass).toHaveLength(1);
    expect(dClass[0].channelTxnId).toBe('txn-csv-orphan-2');
    expect(dClass[0].channelAmount).toBe(9900);
  });

  it('CSV 导入：不配状态列 → 拒绝导入，且本地 PROCESSING 的单不会被改成 PAID', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const csv = [
      '交易号,业务单号,金额(分)',
      `txn-csv-no-status,${payout.payoutNo},8500`,
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-no-status.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          referenceNoColumn: '业务单号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          // ⚠️ **刻意不配 statusColumn** ——
          //    曾经这里默认当成 SUCCESS → 本地 PROCESSING 的单被判成 A 类
          //    → **自动改成已付款**。
        }),
      );

    // ⚠️ **必须拒绝** —— 不配状态列就无从判断渠道是否真的打了款。
    //    「先假设成功再说」= 系统替运营做了一个可能错的假设。
    expect(response.status).toBe(400);
    const errorBody = response.body as { message?: string };
    expect(errorBody.message).toContain('状态');

    // ⚠️ **核心断言：出款单的状态没变** ——
    //    这条单如果被误判成 A 类，就会被自动纠正成 PAID（**改钱状态**）。
    const after = await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: payout.id },
        select: { status: true },
      }),
    );
    expect(after?.status).toBe(PayoutStatus.PROCESSING);

    // ⚠️ **不能产生任何 A 类差异** —— 既然没导入成功，就不该有对账结论。
    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { channelTxnId: 'txn-csv-no-status' },
      }),
    );
    expect(items).toHaveLength(0);
  });

  it('CSV 导入：配了状态列但状态值映射缺失 → 同样拒绝（否则 A/B/C/F 全检不出来）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.PROCESSING,
      processingAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const csv = [
      '交易号,业务单号,金额(分),状态',
      `txn-csv-no-mapping,${payout.payoutNo},8500,成功`,
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-no-mapping.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          referenceNoColumn: '业务单号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          // ⚠️ **刻意不配 statusMapping** ——
          //    渠道的状态词（原样）不会被引擎认成 SUCCESS/FAILED
          //    → A/B/C/F 四类差异全部检不出来，而差异数仍是 0。
        }),
      );

    expect(response.status).toBe(400);
    const errorBody = response.body as { message?: string };
    expect(errorBody.message).toContain('状态值映射');

    const after = await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: payout.id },
        select: { status: true },
      }),
    );
    expect(after?.status).toBe(PayoutStatus.PROCESSING);
  });

  it('CSV 导入：金额解析不出来的行 → 响应里必须报告跳过了几行与行号', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    const csv = [
      '交易号,金额(分),状态',
      'txn-csv-ok-1,1000,成功',
      'txn-csv-bad-amount,金额不对,成功',
      ',2000,成功',
      'txn-csv-ok-2,3000,成功',
    ].join('\n');

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-bad-rows.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS' },
        }),
      );

    expect(response.status).toBe(200);
    const body = response.body as ImportResponseBody;

    // ⚠️ **必须报告跳过的行** —— 对账结论是**基于剩下的行**算的，
    //    运营不知道跳了几行 → 看到「差异数 0」就以为钱没问题。
    expect(body.skippedRowCount).toBe(2);
    expect(body.skippedRows).toBeDefined();
    expect(body.skippedRows).toHaveLength(2);

    // ⚠️ **行号要对得上原账单** —— 第 1 行是表头 → 数据从第 2 行开始。
    //    第 3 行金额解析不出、第 4 行没有交易号。
    const rowNumbers = body
      .skippedRows!.map((r) => r.rowNumber)
      .sort((a, b) => a - b);
    expect(rowNumbers).toEqual([3, 4]);
    // ⚠️ **原因要写清楚** —— 运营要能分清「金额坏了」与「没有交易号」。
    const reasons = body.skippedRows!.map((r) => r.reason).join(' | ');
    expect(reasons).toContain('金额');
    expect(reasons).toContain('交易号');

    // ⚠️ **只跳过了 2 行，明细不用截断**
    expect(body.skippedRowsTruncated).toBe(false);
    expect(merchant.tenantId).toBeTruthy();
  });

  it('CSV 导入：配了时间列但整列为空 → 响应里必须有提示，且没有 D 类差异', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    // ⚠️ **这条渠道流水匹配不到任何本地单** —— 正常情况是 D 类。
    //    但「打款时间」列**配了、值却全是空的** → 时刻全缺 → D 类检不出来。
    const csv = [
      '交易号,金额(分),状态,打款时间',
      'txn-csv-empty-time,9900,成功,',
      'txn-csv-empty-time-2,9900,成功,',
    ].join('\n');

    const from = '2026-03-01T00:00:00.000Z';
    const to = '2026-03-03T00:00:00.000Z';

    const response = await http(app)
      .post('/api/v1/platform/payout-reconciliations/import')
      .set('authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'bill-empty-time.csv')
      .field(
        'columnMapping',
        JSON.stringify({
          txnIdColumn: '交易号',
          amountColumn: '金额(分)',
          amountUnit: 'CENT',
          statusColumn: '状态',
          statusMapping: { 成功: 'SUCCESS' },
          // ⚠️ **刻意配了时间列** —— 但那一列的值全是空的
          paidAtColumn: '打款时间',
        }),
      )
      .field('from', from)
      .field('to', to);

    expect(response.status).toBe(200);
    const body = response.body as ImportResponseBody;

    // ⚠️ **必须有提示** —— 「配了列」不等于「有时刻」。
    //    提示要基于**实际解析出的时刻数**（这里是 0），不是「配没配列」。
    //    后果要说清：D 类差异检不出来。
    expect(body.warning).toBeDefined();
    expect(body.warning).toContain('D 类');

    const items = await asPlatform(() =>
      prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: body.id },
      }),
    );
    // ⚠️ **真的没有 D 类** —— 时刻全缺 → 引擎直接跳过这两条孤儿流水。
    expect(
      items.filter((i) => i.type === ReconciliationDiffType.CHANNEL_ONLY),
    ).toHaveLength(0);
    expect(merchant.tenantId).toBeTruthy();
  });
});
