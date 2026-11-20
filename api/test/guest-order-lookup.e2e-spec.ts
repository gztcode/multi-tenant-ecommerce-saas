import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
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
 * 游客订单查询的 e2e（阶段 11）。
 *
 * 覆盖四个契约：
 * 1. 订单号 + 收货手机号同时匹配 → 200 + **最小投影**（无收货人字段）；
 * 2. 手机号不匹配 → 404，措辞与「订单不存在」一致（不给爆破区分信号）；
 * 3. 同 IP × 订单号失败 5 次 → 429（防穷举手机号）；
 * 4. 跨租户隔离：租户 A 的订单在租户 B 的子域名下查不到。
 *
 * 订单直接经 prisma 落库（platformScope）——被测的是查询契约，
 * 不是下单链路（order.e2e-spec.ts 已覆盖）。
 */

interface LookupBody {
  orderNo: string;
  status: string;
  totalAmount: number;
  itemCount: number;
  createdAt: string;
  paidAt: string | null;
}

describe('游客订单查询（阶段 11）', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
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

  /** 直接落一条订单（绕过下单链路），返回订单号 */
  async function seedOrder(
    tenantId: string,
    over: Partial<{ orderNo: string; receiverPhone: string }> = {},
  ): Promise<string> {
    const orderNo = over.orderNo ?? `GL${unique()}`;
    await tenantContext.run(platformScope(), async () => {
      await prisma.order.create({
        data: {
          tenantId,
          orderNo,
          status: 'PAID',
          totalAmount: 9900,
          itemCount: 2,
          receiverName: '张三',
          receiverPhone: over.receiverPhone ?? '13800000000',
          province: '浙江省',
          city: '杭州市',
          district: '西湖区',
          detail: '文一西路 100 号',
          paidAt: new Date(),
        } as never,
      });
    });
    return orderNo;
  }

  it('订单号 + 收货手机号匹配 → 200 且只含最小投影', async () => {
    const merchant = await createMerchant(app, prisma);
    const orderNo = await seedOrder(merchant.tenantId);

    const response = await http(app)
      .post('/api/v1/orders/guest-lookup')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ orderNo, phone: '13800000000' })
      .expect(201);

    const body = response.body as LookupBody;
    expect(body.orderNo).toBe(orderNo);
    expect(body.status).toBe('PAID');
    expect(body.totalAmount).toBe(9900);
    expect(body.itemCount).toBe(2);
    // ⚠️ 最小投影：收货人信息一律不出现
    expect(body).not.toHaveProperty('receiverName');
    expect(body).not.toHaveProperty('receiverPhone');
    expect(body).not.toHaveProperty('province');
    expect(JSON.stringify(body)).not.toContain('张三');
  });

  it('手机号不匹配 → 404，措辞不给爆破者区分信号', async () => {
    const merchant = await createMerchant(app, prisma);
    const orderNo = await seedOrder(merchant.tenantId);

    const response = await http(app)
      .post('/api/v1/orders/guest-lookup')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ orderNo, phone: '13911111111' })
      .expect(404);
    expect((response.body as { message?: string }).message).toContain(
      '订单不存在或信息不匹配',
    );
  });

  it('⚠️ 同 IP × 订单号失败 5 次后 429（防穷举手机号）', async () => {
    const merchant = await createMerchant(app, prisma);
    const orderNo = await seedOrder(merchant.tenantId);

    for (let i = 0; i < 5; i += 1) {
      await http(app)
        .post('/api/v1/orders/guest-lookup')
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({ orderNo, phone: '1390000000' + i })
        .expect(404);
    }
    // 第 6 次还没开始查库就被熔断
    await http(app)
      .post('/api/v1/orders/guest-lookup')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ orderNo, phone: '13800000000' })
      .expect(429);
  });

  it('⚠️ 跨租户隔离：租户 A 的订单在租户 B 的子域名下查不到', async () => {
    const merchantA = await createMerchant(app, prisma);
    const merchantB = await createMerchant(app, prisma);
    const orderNo = await seedOrder(merchantA.tenantId);

    await http(app)
      .post('/api/v1/orders/guest-lookup')
      .set('x-tenant-subdomain', merchantB.subdomain)
      .send({ orderNo, phone: '13800000000' })
      .expect(404);
  });

  /**
   * ⚠️ 防爆破计数必须按「来源 IP × 订单号」隔离（P1：可信代理链）。
   *
   * 修复前 api 没有开 `trust proxy`，`request.ip` 恒等于 TCP 对端地址 ——
   * 生产上就是 Nginx / BFF 容器的 IP，所有来源共用一个计数桶，
   * 一个坏客户端就能把真实客户的查单入口锁死 10 分钟。
   *
   * 这里用 `x-forwarded-for` 模拟「可信代理层（Nginx / BFF）转发给 api 的头」：
   * - 单值 `1.2.3.4`：该客户端自己的 IP；
   * - `伪造值, 真实IP`：客户端自带伪造头、代理层追加了真实对端
   *   （Nginx 的 `$proxy_add_x_forwarded_for` 就是这个形状）。
   *
   * api 只信任一跳（`trust proxy = 1`）→ 取**最右**一项 = 真实 IP，
   * 客户端伪造的左端值无效。
   */
  describe('防爆破计数的来源隔离', () => {
    it('来源 A 连败 5 次后，来源 B 的第 1 次查询不应被连坐', async () => {
      const merchant = await createMerchant(app, prisma);
      const orderNo = await seedOrder(merchant.tenantId);

      for (let i = 0; i < 5; i += 1) {
        await http(app)
          .post('/api/v1/orders/guest-lookup')
          .set('x-tenant-subdomain', merchant.subdomain)
          .set('x-forwarded-for', '203.0.113.10')
          .send({ orderNo, phone: '1390000000' + i })
          .expect(404);
      }

      // 来源 A 自己第 6 次：仍然被限流
      await http(app)
        .post('/api/v1/orders/guest-lookup')
        .set('x-tenant-subdomain', merchant.subdomain)
        .set('x-forwarded-for', '203.0.113.10')
        .send({ orderNo, phone: '13800000000' })
        .expect(429);

      // 来源 B 第 1 次：不应被 A 连坐，仍是普通的「查不到」
      const response = await http(app)
        .post('/api/v1/orders/guest-lookup')
        .set('x-tenant-subdomain', merchant.subdomain)
        .set('x-forwarded-for', '203.0.113.20')
        .send({ orderNo, phone: '13911111111' })
        .expect(404);
      expect((response.body as { message?: string }).message).toContain(
        '订单不存在或信息不匹配',
      );
    });

    it('同一来源连败 5 次后，第 6 次仍被限流', async () => {
      const merchant = await createMerchant(app, prisma);
      const orderNo = await seedOrder(merchant.tenantId);

      for (let i = 0; i < 5; i += 1) {
        await http(app)
          .post('/api/v1/orders/guest-lookup')
          .set('x-tenant-subdomain', merchant.subdomain)
          .set('x-forwarded-for', '203.0.113.30')
          .send({ orderNo, phone: '1390000000' + i })
          .expect(404);
      }
      await http(app)
        .post('/api/v1/orders/guest-lookup')
        .set('x-tenant-subdomain', merchant.subdomain)
        .set('x-forwarded-for', '203.0.113.30')
        .send({ orderNo, phone: '13800000000' })
        .expect(429);
    });

    it('每次伪造不同的 x-forwarded-for 也绕不过限流', async () => {
      const merchant = await createMerchant(app, prisma);
      const orderNo = await seedOrder(merchant.tenantId);

      // 左端每次都变（客户端伪造），最右一项固定（代理层追加的真实对端）
      for (let i = 0; i < 5; i += 1) {
        await http(app)
          .post('/api/v1/orders/guest-lookup')
          .set('x-tenant-subdomain', merchant.subdomain)
          .set('x-forwarded-for', `198.51.100.${i}, 203.0.113.40`)
          .send({ orderNo, phone: '1390000000' + i })
          .expect(404);
      }
      await http(app)
        .post('/api/v1/orders/guest-lookup')
        .set('x-tenant-subdomain', merchant.subdomain)
        .set('x-forwarded-for', '198.51.100.99, 203.0.113.40')
        .send({ orderNo, phone: '13800000000' })
        .expect(429);
    });
  });

  it('畸形请求体（缺手机号）→ 400，不透传后端', async () => {
    const merchant = await createMerchant(app, prisma);
    await http(app)
      .post('/api/v1/orders/guest-lookup')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ orderNo: 'SOME-ORDER-NO' })
      .expect(400);
  });
});
