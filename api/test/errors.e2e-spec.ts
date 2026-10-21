import {
  Controller,
  Get,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ERROR_CODES, ErrorCode } from '../src/common/filters/error-codes';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { Skip } from '../src/common/decorators/skip.decorator';
import { http } from './helpers';

/**
 * 统一错误响应格式的 e2e。
 *
 * 这里刻意**不走 main.ts** 而是自己 createNestApplication：main.ts 里的
 * useGlobalFilters 只对真正启动的进程生效，e2e 拿到的 app 是另建的一套，
 * 不显式挂上过滤器就断言不到统一格式——那样这条测试会假绿。
 */

/**
 * 只在测试里存在的探针控制器，用来触发两类真实业务代码里不该出现的异常：
 *
 * 1. `boom` 直接抛一个普通 Error，走过滤器的「未知异常」分支；
 * 2. `tenant-scope` 用隔离版 PrismaClient 调 findUnique，租户扩展必然抛
 *    TenantScopeError。
 *
 * 整个控制器标 @Skip()：探针不携带店铺子域名，若让租户拦截器跑，
 * 它会先抛「无法确定店铺」的 404，请求根本到不了探针方法，
 * 测到的就不是目标异常了。
 */
@Skip()
@Controller('probe')
class ErrorProbeController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get('boom')
  boom(): void {
    throw new Error('数据库密码是 hunter2');
  }

  @Get('tenant-scope')
  async tenantScope(): Promise<unknown> {
    // User 是租户作用域模型，findUnique 属于 UNIQUE_ONLY_OPERATIONS，
    // 租户扩展会在真正发 SQL 之前就抛 TenantScopeError。
    return this.prisma.user.findUnique({ where: { id: 'any-id' } });
  }
}

@Module({
  imports: [AppModule],
  controllers: [ErrorProbeController],
})
class ErrorProbeModule {}

interface ErrorResponseBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  traceId: string;
}

function errorBody(response: { body: unknown }): ErrorResponseBody {
  return response.body as ErrorResponseBody;
}

describe('统一错误响应 (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ErrorProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 保持完全一致：全局前缀、校验管道、租户拦截器、异常过滤器。
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerMerchant() {
    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `e-${unique()}@example.test`,
        password: 'Passw0rd123',
        merchantName: '商家',
        subdomain: `e-${unique()}`,
        storeName: '店铺',
      })
      .expect(201);
    return (response.body as { accessToken: string }).accessToken;
  }

  it('400 参数校验失败：code 为 VALIDATION_FAILED，message 是字符串', async () => {
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' });

    expect(response.status).toBe(400);
    const body = errorBody(response);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    // 关键：不能是数组。ValidationPipe 聚合多条错误时默认会返回数组，
    // 过滤器必须把它压成字符串。
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    // 原始数组保留在 details 里，供前端按字段名定位。
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('401 未认证：code 为 UNAUTHORIZED', async () => {
    const response = await http(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(errorBody(response).code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('403 角色不足：code 为 FORBIDDEN', async () => {
    const accessToken = await registerMerchant();

    // /tenants 整条控制器要求 PLATFORM_ADMIN，商家身份必然被 RolesGuard 拦下。
    const response = await http(app)
      .get('/api/v1/tenants')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(403);
    expect(errorBody(response).code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('404 资源不存在：code 为 NOT_FOUND', async () => {
    const response = await http(app).get(
      '/api/v1/stores/by-subdomain/does-not-exist',
    );

    expect(response.status).toBe(404);
    expect(errorBody(response).code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('409 冲突：重复子域名返回 code 为 CONFLICT', async () => {
    const subdomain = `dup-${unique()}`;
    const payload = {
      email: `d-${unique()}@example.test`,
      password: 'Passw0rd123',
      merchantName: '商家',
      subdomain,
      storeName: '店铺',
    };

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send(payload)
      .expect(201);

    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      // 邮箱换一个，只让 subdomain 撞车，确保触发的是子域名唯一约束
      .send({ ...payload, email: `d2-${unique()}@example.test` });

    expect(response.status).toBe(409);
    expect(errorBody(response).code).toBe(ERROR_CODES.CONFLICT);
  });

  it('403 租户越权：code 为 TENANT_SCOPE_VIOLATION', async () => {
    const response = await http(app).get('/api/v1/probe/tenant-scope');

    expect(response.status).toBe(403);
    const body = errorBody(response);
    expect(body.code).toBe(ERROR_CODES.TENANT_SCOPE_VIOLATION);
    expect(body.message).toContain('findUnique');
  });

  it('500 未处理异常：code 为 INTERNAL_ERROR，且不回显内部细节', async () => {
    const response = await http(app).get('/api/v1/probe/boom');

    expect(response.status).toBe(500);
    const body = errorBody(response);
    expect(body.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    // 原始异常信息含表名/SQL/连接串这类情报，绝不能出现在响应体里。
    expect(body.message).not.toContain('hunter2');
    expect(body.message).toBe('服务器内部错误');
    // 序列化后的整个响应体都不能漏出去
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('traceId 从 X-Trace-Id 请求头透传到响应体', async () => {
    const response = await http(app)
      .post('/api/v1/auth/login')
      .set('X-Trace-Id', 'abc123')
      .send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(errorBody(response).traceId).toBe('abc123');
  });

  it('未带 X-Trace-Id 时自动生成 traceId', async () => {
    const response = await http(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(typeof errorBody(response).traceId).toBe('string');
    expect(errorBody(response).traceId.length).toBeGreaterThan(0);
  });

  it('所有错误响应都含 code / message / traceId 三个字段', async () => {
    const accessToken = await registerMerchant();

    // 逐一覆盖各类错误来源：守卫、拦截器、ValidationPipe、服务层、未处理异常。
    const responses = await Promise.all([
      http(app).get('/api/v1/auth/me'),
      http(app)
        .get('/api/v1/tenants')
        .set('Authorization', `Bearer ${accessToken}`),
      http(app).get('/api/v1/stores/by-subdomain/nope'),
      http(app).post('/api/v1/auth/login').send({}),
      http(app).get('/api/v1/probe/boom'),
      http(app).get('/api/v1/probe/tenant-scope'),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([
      400, 401, 403, 403, 404, 500,
    ]);

    for (const response of responses) {
      const body = errorBody(response);
      // 三个必需字段齐全；details 可选（仅校验失败时出现）。
      expect(body.code).toEqual(expect.any(String));
      expect(body.message).toEqual(expect.any(String));
      expect(body.traceId).toEqual(expect.any(String));
      expect(
        Object.keys(body).every((key) =>
          ['code', 'message', 'traceId', 'details'].includes(key),
        ),
      ).toBe(true);
      // 旧的 NestJS 默认字段不该再出现，客户端按新契约解析即可
      expect(body).not.toHaveProperty('statusCode');
      expect(body).not.toHaveProperty('error');
    }
  });
});
