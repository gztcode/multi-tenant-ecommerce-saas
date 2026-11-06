import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PayoutStatus, ReconciliationSource } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';
import { seedPayout } from './payout-fixture';

/**
 * 对账两条写路由的**接线护栏**（2026-11-05 审计 P2-B4）。
 *
 * 守的是四条接线：
 * | 接线 | 去掉会怎样 |
 * |---|---|
 * | `@Body() dto: XxxDto` | 改成内联 TS 类型 → 全局 `ValidationPipe` 的 `toValidate()` **直接跳过校验** → 请求体里的垃圾字段一路透传到服务层，api 侧一声不吭 |
 * | `@HttpCode(HttpStatus.OK)` | 响应码从 200 变成 201 → 前端 BFF 按 200 判定成功就会炸 |
 * | `@Roles(PLATFORM_ADMIN)` | 普通商家令牌就能批量确认差异 / 人工确认已付款 → **改钱的操作越权** |
 * | `@Param('id')` / `@Param('payoutId')` | 路径参数没绑上 → 操作的是「空 id」而不是请求里指定的那一单 |
 *
 * ⚠️ **这四条以前没有任何自动化测试锚定**：
 *    前端那个测试连的是 mock 的 `apiFetch`，根本不碰后端。
 *
 * ⚠️ **本文件只碰接线，不碰业务**：造数只造「够控制器走完校验并进入服务层」的数据，
 *    业务语义（闸 ①②③④、游标、留痕）由
 *    `payout-reconciliation-service.e2e-spec.ts` 与
 *    `payout-reconciliation.e2e-spec.ts` 负责。
 */

/** 批量确认的路由前缀 */
const BATCH_CONFIRM = '/api/v1/platform/payout-reconciliations';
/** 人工确认已付款的路由前缀 */
const CONFIRM_PAID = '/api/v1/platform/payout-reconciliations/payouts';

/** 一个一定不存在的 uuid（用来造「资源不存在」的场景） */
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

/** 把错误消息摊平成一段文本（Nest 的 ValidationPipe 给的是字符串数组） */
function errorText(response: { body: unknown }): string {
  const body = response.body as { message?: unknown };
  if (Array.isArray(body.message)) {
    return body.message.join(' | ');
  }
  if (typeof body.message === 'string') {
    return body.message;
  }
  return JSON.stringify(body);
}

describe('对账写路由的接线护栏 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  /** 本文件造出来的对账任务 id（结束时清掉，不留给别的 e2e 文件） */
  const createdReconciliationIds: string[] = [];
  /** 本文件造出来的出款单 id */
  const createdPayoutIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    // ⚠️ **必须与 main.ts 一致** —— `forbidNonWhitelisted: true` 才是
    //    「多传一个字段就 400」的那道闸
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
    // ⚠️ **e2e 文件共享同一个测试库** —— 本文件造的对账任务 / 出款单
    //    会进别的文件的平台级扫描（对账差异、卡单扫描）→
    //    只删自己造的，不碰别人的。
    await asPlatform(async () => {
      if (createdReconciliationIds.length > 0) {
        await prisma.payoutReconciliation.deleteMany({
          where: { id: { in: createdReconciliationIds } },
        });
      }
      if (createdPayoutIds.length > 0) {
        await prisma.payout.deleteMany({
          where: { id: { in: createdPayoutIds } },
        });
      }
    });
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

  /**
   * 造一个对账任务。
   *
   * ⚠️ **`source` 决定批量确认的结果**：
   *    - `FILE` → 进批量确认流程（要拿到 **200** 就必须是 FILE）；
   *    - `API` → 一律 409「只有账单文件导入的对账任务支持批量确认」。
   *
   * ⚠️ **两种 source 都要有** —— `④ @Param 接线` 靠它们区分：
   *    路径参数没绑上时 `id` 是 `undefined`，而 **Prisma 会忽略 `where` 里的
   *    `undefined`**（等于「不带条件」）→ 两次请求会落到**同一行**。
   *    只有让两个 id 给出**互斥**的结果，护栏才真的有牙齿。
   */
  async function seedReconciliation(
    source: ReconciliationSource,
  ): Promise<string> {
    const row = await asPlatform(() =>
      prisma.payoutReconciliation.create({
        data: {
          channel: 'fake-payout',
          source,
          windowFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
          windowTo: new Date(),
          ...(source === ReconciliationSource.FILE
            ? { fileName: '账单.csv' }
            : {}),
          triggeredBy: 'admin-1',
        },
        select: { id: true },
      }),
    );
    createdReconciliationIds.push(row.id);
    return row.id;
  }

  // ============================================================
  // ① DTO 接线：校验真的生效
  // ============================================================

  it('批量确认：缺 note → 400（DTO 校验生效）', async () => {
    const token = await loginPlatformAdmin();
    const id = await seedReconciliation(ReconciliationSource.FILE);

    const response = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FILTER' });

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('note');
  });

  it('批量确认：多传一个未声明字段 → 400（forbidNonWhitelisted 生效）', async () => {
    const token = await loginPlatformAdmin();
    const id = await seedReconciliation(ReconciliationSource.FILE);

    const response = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FILTER', note: '确认', bogus: '不该出现' });

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('bogus');
  });

  it('批量确认：mode=IDS 但缺 itemIds → 400（@ValidateIf 分支生效）', async () => {
    const token = await loginPlatformAdmin();
    const id = await seedReconciliation(ReconciliationSource.FILE);

    const response = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'IDS', note: '确认' });

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('itemIds');
  });

  it('批量确认：mode 取值非法 → 400', async () => {
    const token = await loginPlatformAdmin();
    const id = await seedReconciliation(ReconciliationSource.FILE);

    const response = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FOO', note: '确认' });

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('mode');
  });

  it('批量确认：limit 超过 200 → 400（上界生效）', async () => {
    const token = await loginPlatformAdmin();
    const id = await seedReconciliation(ReconciliationSource.FILE);

    const response = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FILTER', note: '确认', limit: 201 });

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('limit');
  });

  it('人工确认已付款：缺 reason → 400', async () => {
    const token = await loginPlatformAdmin();

    const response = await http(app)
      .post(
        `${CONFIRM_PAID}/${'0'.repeat(8)}-0000-0000-0000-000000000000/confirm-paid`,
      )
      .set('authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('reason');
  });

  it('人工确认已付款：传旧字段 payoutNo → 400（不是「被忽略」）', async () => {
    const token = await loginPlatformAdmin();

    const response = await http(app)
      .post(
        `${CONFIRM_PAID}/${'0'.repeat(8)}-0000-0000-0000-000000000000/confirm-paid`,
      )
      .set('authorization', `Bearer ${token}`)
      .send({ reason: '渠道确认已打款', payoutNo: 'PO-1' });

    expect(response.status).toBe(400);
    expect(errorText(response)).toContain('payoutNo');
  });

  // ============================================================
  // ② @HttpCode(200) 接线
  // ============================================================

  it('批量确认成功 → 200（不是 201）', async () => {
    const token = await loginPlatformAdmin();
    const id = await seedReconciliation(ReconciliationSource.FILE);

    const response = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FILTER', note: '批量确认' });

    // ⚠️ **必须是 200** —— 去掉 `@HttpCode(HttpStatus.OK)` 会变成 201，
    //    前端 BFF 按 200 判定成功就会炸。
    expect(response.status).toBe(200);
    // ⚠️ **也要断言 body 的完整形状** —— 只断言状态码的话，
    //    「200 但 body 是别的东西」照样过。
    expect(response.body).toEqual({
      succeeded: [],
      failed: [],
      nextCursor: null,
    });
  });

  // ============================================================
  // ③ @Roles 接线
  // ============================================================

  it('两条路由：未登录 → 401', async () => {
    const id = await seedReconciliation(ReconciliationSource.FILE);

    await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .send({ mode: 'FILTER', note: '确认' })
      .expect(401);

    await http(app)
      .post(
        `${CONFIRM_PAID}/${'0'.repeat(8)}-0000-0000-0000-000000000000/confirm-paid`,
      )
      .send({ reason: '确认' })
      .expect(401);
  });

  it('两条路由：商家令牌 → 403', async () => {
    const merchant = await createMerchant(app, prisma);
    const id = await seedReconciliation(ReconciliationSource.FILE);
    const token = `Bearer ${merchant.token}`;

    const batch = await http(app)
      .post(`${BATCH_CONFIRM}/${id}/items/batch-confirm`)
      .set('authorization', token)
      .send({ mode: 'FILTER', note: '确认' });
    expect(batch.status).toBe(403);
    expect(errorText(batch)).toContain('当前角色无权访问该资源');

    const confirm = await http(app)
      .post(
        `${CONFIRM_PAID}/${'0'.repeat(8)}-0000-0000-0000-000000000000/confirm-paid`,
      )
      .set('authorization', token)
      .send({ reason: '确认' });
    expect(confirm.status).toBe(403);
    expect(errorText(confirm)).toContain('当前角色无权访问该资源');
  });

  // ============================================================
  // ④ @Param 接线
  // ============================================================

  /**
   * ⚠️ **为什么必须是「两个 id → 两种互斥结果」** ——
   *
   * 路由参数没绑上时，`id` 会是 `undefined`，而 **Prisma 会忽略 `where` 里的
   * `undefined`**（等于「不带条件」）→ 两次请求会落到**同一行**。
   * 所以「不存在 → 404」这种**单一**断言**没有牙齿**：
   * 参数没绑上时它照样能过（查到第一行 → 状态不是 FAILED → 也可能抛别的错，
   * 但只要那行的状态恰好对上，单条断言就分辨不出来）。
   *
   * → **两个 id 必须给出互斥的结果**（一个 200、一个 409）：
   *   参数没绑上 → 两次请求结果相同 → **必然有一条断言挂掉**。
   */
  it('批量确认：任务 id 被正确绑到服务层（两个 id → 两种互斥结果）', async () => {
    const token = await loginPlatformAdmin();
    const fileId = await seedReconciliation(ReconciliationSource.FILE);
    const apiId = await seedReconciliation(ReconciliationSource.API);

    // ---- FILE 任务 → 进批量确认流程 → 200 ----
    const file = await http(app)
      .post(`${BATCH_CONFIRM}/${fileId}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FILTER', note: '确认' });
    expect(file.status).toBe(200);
    expect(file.body).toEqual({
      succeeded: [],
      failed: [],
      nextCursor: null,
    });

    // ---- API 任务 → 409「只有账单文件导入的对账任务支持批量确认」 ----
    const api = await http(app)
      .post(`${BATCH_CONFIRM}/${apiId}/items/batch-confirm`)
      .set('authorization', `Bearer ${token}`)
      .send({ mode: 'FILTER', note: '确认' });
    expect(api.status).toBe(409);
    expect(errorText(api)).toContain('账单文件导入');
  });

  it('人工确认已付款：出款单 id 被正确绑到服务层（两个 id → 两种互斥结果）', async () => {
    const token = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    // ⚠️ **必须是一张「记成失败」的出款单** —— 只有 FAILED 才会走到
    //    「明细无法复原」那道闸；别的状态会在更早的「状态已变」那里停下。
    const payout = await seedPayout(prisma, {
      tenantId: merchant.tenantId,
      status: PayoutStatus.FAILED,
    });
    createdPayoutIds.push(payout.id);

    // ---- 真有这张单 → 走到业务闸 → 409「明细无法复原」 ----
    const existing = await http(app)
      .post(`${CONFIRM_PAID}/${payout.id}/confirm-paid`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: '渠道确认已打款' });
    expect(existing.status).toBe(409);
    expect(errorText(existing)).toContain('明细无法复原');

    // ---- 不存在的单 → 404「出款单不存在」 ----
    const missing = await http(app)
      .post(`${CONFIRM_PAID}/${MISSING_ID}/confirm-paid`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: '渠道确认已打款' });
    expect(missing.status).toBe(404);
    expect(errorText(missing)).toContain('出款单不存在');
  });
});
