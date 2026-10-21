import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { http } from './helpers';

interface HealthResponse {
  status: string;
  timestamp: string;
}

describe('健康检查 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 保持一致：e2e 必须复刻生产环境的全局管道，
    // 否则 DTO 校验、未知字段拒绝这些契约在测试里根本不会被执行。
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health 返回 ok', async () => {
    const response = await http(app).get('/health');
    const body = response.body as HealthResponse;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });
});
