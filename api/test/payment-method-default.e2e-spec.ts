import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 「默认支付方式」的不变式（审计 P1-5）。
 *
 * 不变式：**同一个租户最多一个默认支付方式**。
 *
 * ⚠️ 修之前这个不变式**只靠应用层代码保证**：
 * - `setDefault` 先无条件清空全部默认卡、再置目标为默认 →
 *   目标不存在/属别家租户时，清空命中所有默认卡、置位命中 0 行 →
 *   该租户一个默认卡都不剩，接口却返回 200「成功」；
 * - `remove` 删掉默认卡后不补位 → 同样落到「零个默认」；
 * - `create` 的「清默认 + 写新默认」两条语句不在事务里 → 并发时会写出两个默认。
 *
 * ⚠️ **零个默认的后果**：自动续费取不到默认卡（`renewal.service.ts`）→
 *   账单挂着等商家手动付 → 周期一过订阅**静默过期**，商家看不到任何错误。
 *
 * ⚠️ **两个默认的后果**：`findFirst` 无 `orderBy` → 扣哪张卡不确定。
 *
 * 本文件覆盖三层：
 * 1. 服务层：`setDefault` 的归属校验（404）、`remove` 的提位；
 * 2. 数据库层：`payment_methods_tenant_default_uniq` 部分唯一索引真的建上了；
 * 3. 并发层：并发绑定不会写出两个默认。
 */

/** 假网关的共享密钥。测试里显式设置，确保与实现读到的是同一个值。 */
const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';

/** 假网关的渠道名 */
const FAKE_CHANNEL = 'fake';

interface PaymentMethodItem {
  id: string;
  provider: string;
  channel: string;
  type: string;
  isDefault: boolean;
}

interface ListBody<T> {
  items: T[];
  total: number;
}

describe('默认支付方式的不变式 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    // ⚠️ 假网关的开关与密钥必须在 AppModule 加载**之前**设好：
    // BullModule.forRoot 与 provider 的构造都在模块求值时发生。
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;

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
    delete process.env.FAKE_PAYMENT_ENABLED;
    delete process.env.FAKE_PAYMENT_SECRET;
  });

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  /** 商家绑一个支付方式 */
  async function bindPaymentMethod(
    merchantToken: string,
    type = 'CARD',
  ): Promise<PaymentMethodItem> {
    const response = await http(app)
      .post('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ type, channel: FAKE_CHANNEL })
      .expect(201);
    return response.body as PaymentMethodItem;
  }

  /** 库里该租户的默认支付方式（没有就是 null） */
  async function readDefault(
    tenantId: string,
  ): Promise<PaymentMethodItem | null> {
    const rows = await asTenant(tenantId, () =>
      prisma.paymentMethod.findMany({
        where: { tenantId, isDefault: true },
      }),
    );
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0] ?? null;
  }

  // ============================================================
  // 服务层：setDefault 的归属校验
  // ============================================================

  it('setDefault 传一个不存在的 id → 404，且原有默认卡不受影响', async () => {
    const merchant = await createMerchant(app, prisma);
    const bound = await bindPaymentMethod(merchant.token);

    const response = await http(app)
      .post(`/api/v1/billing/payment-methods/${unique()}/default`)
      .set('authorization', `Bearer ${merchant.token}`);
    expect(response.status).toBe(404);

    // ⚠️ **关键断言**：默认卡没被清掉。
    // 修之前这里是「清空命中所有默认卡、置位命中 0 行」→ 零个默认，
    // 而接口还返回 200「成功」。
    const current = await readDefault(merchant.tenantId);
    expect(current?.id).toBe(bound.id);
  });

  it('setDefault 传别家租户的支付方式 id → 404，且本家的默认卡不受影响', async () => {
    const merchant = await createMerchant(app, prisma);
    const other = await createMerchant(app, prisma);
    const mine = await bindPaymentMethod(merchant.token);
    const theirs = await bindPaymentMethod(other.token);

    const response = await http(app)
      .post(`/api/v1/billing/payment-methods/${theirs.id}/default`)
      .set('authorization', `Bearer ${merchant.token}`);
    expect(response.status).toBe(404);

    const current = await readDefault(merchant.tenantId);
    expect(current?.id).toBe(mine.id);

    // ⚠️ **别家租户的默认卡也不能被动**
    const otherDefault = await readDefault(other.tenantId);
    expect(otherDefault?.id).toBe(theirs.id);
  });

  // ============================================================
  // 服务层：remove 的提位
  // ============================================================

  it('解绑默认卡：剩下的一张被提为默认（不留零个默认）', async () => {
    const merchant = await createMerchant(app, prisma);
    const first = await bindPaymentMethod(merchant.token, 'CARD');
    const second = await bindPaymentMethod(merchant.token, 'WECHAT');

    // ⚠️ **不能断言 `first.isDefault`**：那是第一次绑定时返回的**快照**，
    // 第二次绑定把它降级之后，这个对象不会跟着变。只能查库。
    const afterBind = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(
      afterBind.filter((row) => row.isDefault).map((row) => row.id),
    ).toEqual([second.id]);

    await http(app)
      .delete(`/api/v1/billing/payment-methods/${second.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    // ⚠️ **剩下的那张必须被提为默认**：
    // 修之前删掉默认卡就没人提位 → 零个默认 → 自动续费静默失效。
    const current = await readDefault(merchant.tenantId);
    expect(current?.id).toBe(first.id);

    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('解绑非默认卡：默认卡不动', async () => {
    const merchant = await createMerchant(app, prisma);
    const first = await bindPaymentMethod(merchant.token, 'CARD');
    const second = await bindPaymentMethod(merchant.token, 'WECHAT');

    await http(app)
      .delete(`/api/v1/billing/payment-methods/${first.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const current = await readDefault(merchant.tenantId);
    expect(current?.id).toBe(second.id);
  });

  it('解绑不存在的支付方式 → 200（幂等），不影响默认卡', async () => {
    const merchant = await createMerchant(app, prisma);
    const bound = await bindPaymentMethod(merchant.token);

    await http(app)
      .delete(`/api/v1/billing/payment-methods/${unique()}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const current = await readDefault(merchant.tenantId);
    expect(current?.id).toBe(bound.id);
  });

  // ============================================================
  // 数据库层：部分唯一索引
  // ============================================================

  it('数据库层：同一租户插第二个默认支付方式 → P2002（唯一索引真的建上了）', async () => {
    const merchant = await createMerchant(app, prisma);
    await bindPaymentMethod(merchant.token);

    let code: string | undefined;
    try {
      await asTenant(merchant.tenantId, () =>
        prisma.paymentMethod.create({
          data: {
            tenantId: merchant.tenantId,
            provider: 'fake',
            channel: FAKE_CHANNEL,
            type: 'CARD',
            token: 'fake_pm_direct',
            isDefault: true,
          },
        }),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    // ⚠️ **P2002 = 唯一约束冲突**：部分唯一索引
    // `payment_methods_tenant_default_uniq ON ("tenantId") WHERE "isDefault" = true`
    // 是这条不变式的最终防线 —— 应用层写错了也不会写出两个默认。
    expect(code).toBe('P2002');

    // ⚠️ **库里仍然只有一个默认**
    const current = await readDefault(merchant.tenantId);
    expect(current).not.toBeNull();
  });

  it('绑定多张卡：库里始终只有一个默认', async () => {
    const merchant = await createMerchant(app, prisma);
    await bindPaymentMethod(merchant.token, 'CARD');
    await bindPaymentMethod(merchant.token, 'WECHAT');
    await bindPaymentMethod(merchant.token, 'ALIPAY');

    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);

    const response = await http(app)
      .get('/api/v1/billing/payment-methods')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const body = response.body as ListBody<PaymentMethodItem>;
    expect(body.items.filter((item) => item.isDefault)).toHaveLength(1);
  });

  // ============================================================
  // 并发层
  // ============================================================

  it('并发绑定：不会写出两个默认（数据库唯一索引兜底）', async () => {
    const merchant = await createMerchant(app, prisma);

    const responses = await Promise.all([
      http(app)
        .post('/api/v1/billing/payment-methods')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ type: 'CARD', channel: FAKE_CHANNEL }),
      http(app)
        .post('/api/v1/billing/payment-methods')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ type: 'WECHAT', channel: FAKE_CHANNEL }),
    ]);

    // ⚠️ **失败的那个必须是 409 而不是 500**：
    // P2002 一路冒到全局过滤器会变成「服务器内部错误」。
    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
    }

    const rows = await asTenant(merchant.tenantId, () =>
      prisma.paymentMethod.findMany({ where: { tenantId: merchant.tenantId } }),
    );
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
  });
});
