import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';
import { createMerchant, type MerchantFixture } from './merchant-fixture';

/** 全局异常过滤器统一后的错误响应体 */
interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  traceId: string;
}

function errorBody(response: { body: unknown }): ErrorBody {
  return response.body as ErrorBody;
}

/**
 * 畸形查询参数不 500 (e2e)
 *
 * 对应 2026-11-05 审计 P2-5。这三个接口原来都是**裸 `@Query`**：
 * 裸参数拿不到 ValidationPipe（`toValidate()` 会跳过原生类型），于是
 * `page=abc` → `Number()` = NaN → Prisma 报 500；
 * `status=FOO` → Prisma 拒枚举 → 500；
 * `from=乱码` → Invalid Date → 500。
 *
 * 改用查询 DTO 之后畸形入参一律 400，且文案要能指到具体字段。
 * 这组用例的作用是**防止有人把 DTO 换回裸 `@Query`**：
 * 换回去之后前端完全看不出差别，只有这里会红。
 */
describe('畸形查询参数返回 400 而不是 500 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let merchant: MerchantFixture;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    // 与 main.ts 保持一致：e2e 拿到的 app 是另建的一套，
    // 不显式挂过滤器就断言不到统一错误格式（那样这条测试会假绿）。
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(TenantPrismaService);
    merchant = await createMerchant(app, prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 断言「400 + 校验失败错误码 + 文案里能看到出错的字段名」 */
  function expectBadRequest(
    response: { status: number; body: unknown },
    expectedInMessage: string,
  ): void {
    expect(response.status).toBe(400);
    const body = errorBody(response);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toContain(expectedInMessage);
    // details 保留原始数组，前端可以按字段名精确定位
    expect(Array.isArray(body.details)).toBe(true);
  }

  describe('商品列表（管理端）', () => {
    it('status 传非法枚举值：400 而不是 500', async () => {
      const response = await http(app)
        .get('/api/v1/catalog/products?status=FOO')
        .set('authorization', `Bearer ${merchant.token}`);

      expectBadRequest(response, 'status');
    });

    it('分页参数传非数字：400 而不是 500', async () => {
      for (const query of ['page=abc', 'pageSize=abc']) {
        const response = await http(app)
          .get(`/api/v1/catalog/products?${query}`)
          .set('authorization', `Bearer ${merchant.token}`);

        expectBadRequest(response, query.split('=')[0]);
      }
    });

    it('分页参数越界：400 而不是 500', async () => {
      for (const query of [
        'page=0',
        'page=-5',
        'pageSize=0',
        'pageSize=999999',
      ]) {
        const response = await http(app)
          .get(`/api/v1/catalog/products?${query}`)
          .set('authorization', `Bearer ${merchant.token}`);

        expectBadRequest(response, query.split('=')[0]);
      }
    });

    it('未知查询参数：400（forbidNonWhitelisted）', async () => {
      const response = await http(app)
        .get('/api/v1/catalog/products?foo=bar')
        .set('authorization', `Bearer ${merchant.token}`);

      expectBadRequest(response, 'foo');
    });

    it('合法参数仍然返回 200', async () => {
      await http(app)
        .get('/api/v1/catalog/products?page=1&pageSize=20&status=DRAFT')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);
    });
  });

  describe('库存流水列表', () => {
    it('分页参数传非数字：400 而不是 500', async () => {
      for (const query of ['page=abc', 'pageSize=abc']) {
        const response = await http(app)
          .get(`/api/v1/inventory/movements?${query}`)
          .set('authorization', `Bearer ${merchant.token}`);

        expectBadRequest(response, query.split('=')[0]);
      }
    });

    it('分页参数越界：400 而不是 500', async () => {
      for (const query of ['page=0', 'pageSize=999999']) {
        const response = await http(app)
          .get(`/api/v1/inventory/movements?${query}`)
          .set('authorization', `Bearer ${merchant.token}`);

        expectBadRequest(response, query.split('=')[0]);
      }
    });

    it('合法参数仍然返回 200', async () => {
      await http(app)
        .get('/api/v1/inventory/movements?page=1&pageSize=50')
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);
    });
  });

  describe('商家订单列表', () => {
    it('status 传非法枚举值：400 而不是 500', async () => {
      const response = await http(app)
        .get('/api/v1/merchant/orders?status=FOO')
        .set('authorization', `Bearer ${merchant.token}`);

      expectBadRequest(response, 'status');
    });

    it('时间参数不是合法日期：400 而不是 500', async () => {
      for (const query of [
        'from=garbage',
        'to=notadate',
        // ⚠️ 这两个「像 ISO 8601」但 `new Date()` 解析不出来：
        // 只用 `@IsDateString()` 的话它们能过校验，然后变成 Invalid Date → 500。
        'from=20260101',
        'to=2026-W01-1',
      ]) {
        const response = await http(app)
          .get(`/api/v1/merchant/orders?${query}`)
          .set('authorization', `Bearer ${merchant.token}`);

        expectBadRequest(response, query.split('=')[0]);
      }
    });

    it('分页参数传非数字：400 而不是 500', async () => {
      const response = await http(app)
        .get('/api/v1/merchant/orders?page=abc')
        .set('authorization', `Bearer ${merchant.token}`);

      expectBadRequest(response, 'page');
    });

    it('合法参数仍然返回 200', async () => {
      await http(app)
        .get(
          '/api/v1/merchant/orders?page=1&pageSize=20&status=PAID&from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z',
        )
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);
    });
  });
});
