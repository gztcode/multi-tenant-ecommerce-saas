import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { HealthService } from '../src/health/health.service';
import { http } from './helpers';

interface HealthResponse {
  status: string;
  checks: { redis: boolean; database: boolean };
  timestamp: string;
}

describe('健康检查 (e2e)', () => {
  /**
   * 两个用例各建一个 Nest 应用实例（含 Prisma 连接池与 BullMQ 连接）。
   * ⚠️ **两个都要在 `afterAll` 里关闭**：只关一个的话，
   * 另一个用例先失败 / 提前抛错时会漏关 → 残留连接挂住 jest 进程。
   * 所以这里收集所有建出来的实例，逐个关。
   */
  const apps: INestApplication[] = [];

  async function build(overrideHealth?: Partial<HealthService>) {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HealthService)
      .useValue(
        overrideHealth ?? {
          check: () =>
            Promise.resolve({
              status: 'ok',
              checks: { redis: true, database: true },
              timestamp: new Date().toISOString(),
            }),
        },
      )
      .compile();

    const instance = moduleRef.createNestApplication();
    // 与 main.ts 保持一致：e2e 必须复刻生产环境的全局管道，
    // 否则 DTO 校验、未知字段拒绝这些契约在测试里根本不会被执行。
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await instance.init();
    apps.push(instance);
    return instance;
  }

  afterAll(async () => {
    await Promise.all(apps.map((instance) => instance.close()));
  });

  it('GET /health 返回 ok', async () => {
    const app = await build();
    const response = await http(app).get('/health');
    const body = response.body as HealthResponse;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ redis: true, database: true });
    expect(typeof body.timestamp).toBe('string');
  });

  it('探活失败时返回 503 与 degraded', async () => {
    const degraded = await build({
      check: () =>
        Promise.resolve({
          status: 'degraded',
          checks: { redis: false, database: true },
          timestamp: new Date().toISOString(),
        }),
    });

    const response = await http(degraded).get('/health');
    const body = response.body as HealthResponse;

    expect(response.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe(false);
  });
});
