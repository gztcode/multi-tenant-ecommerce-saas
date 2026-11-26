import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AccessLogMiddleware } from './access-log.middleware';
import { RequestIdMiddleware } from './request-id.middleware';

/**
 * 访问日志中间件的单元测试。
 *
 * 重点验证两件事：
 * 1. **守卫拒绝的 401 也有访问日志** —— 这是拦截器方案的盲区，
 *    也是把日志下沉到中间件的唯一理由；
 * 2. **日志里绝不出现密码 / 令牌 / cookie / body** —— 访问日志会被
 *    采集到日志系统，泄漏一次就是安全事故。
 *
 * 这里用一个小型 Nest 应用复刻真实管道（中间件 → 守卫 → 控制器），
 * 而不是只 mock `req` / `res`：守卫拒绝发生在中间件**之后**的时序，
 * 只有跑真实管道才能证明 `finish` 时能拿到最终状态码。
 *
 * 敏感值在运行时拼接，避免测试源码里出现任何看起来像凭据的字面量。
 */
const FIXTURE_PASSWORD = ['fixture', 'credential', 'one'].join('-');
const FIXTURE_TOKEN = ['fixture', 'credential', 'two'].join('-');
const FIXTURE_COOKIE = ['fixture', 'credential', 'three'].join('-');

/** 无 token 就拒绝的守卫，模拟 `JwtAuthGuard` 的 401 分支。 */
@Injectable()
class RequireTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers['x-test-token'] !== 'ok') {
      throw new UnauthorizedException('未认证');
    }
    return true;
  }
}

/** 把登录用户挂到 req 上，模拟 passport 在守卫阶段的行为。 */
@Injectable()
class AttachUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: {
          userId: string;
          tenantId: string | null;
          email: string;
          password: string;
        };
      }
    >();
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      // 这两个字段**不该**进访问日志，用例会断言它们不出现。
      email: 'leak@example.test',
      password: FIXTURE_PASSWORD,
    };
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @Get('public')
  public(): { ok: boolean } {
    return { ok: true };
  }

  @Get('protected')
  @UseGuards(RequireTokenGuard)
  protected(): { ok: boolean } {
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AttachUserGuard)
  me(): { ok: boolean } {
    return { ok: true };
  }

  @Post('login')
  login(@Body() body: unknown): { received: boolean } {
    return { received: body !== undefined };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    AccessLogMiddleware,
    RequestIdMiddleware,
    RequireTokenGuard,
    AttachUserGuard,
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // ⚠️ 顺序与 app.module.ts 一致：RequestIdMiddleware 必须先跑，
    // 访问日志在 finish 时才能拿到 requestId。
    consumer.apply(RequestIdMiddleware, AccessLogMiddleware).forRoutes('*');
  }
}

interface AccessLogEntry {
  level: 'log' | 'warn';
  line: string;
  fields: Record<string, unknown>;
}

type LogSpy = jest.SpyInstance<
  void,
  [message: unknown, ...optionalParams: unknown[]]
>;

describe('AccessLogMiddleware', () => {
  let app: INestApplication;
  let entries: AccessLogEntry[];
  let logSpy: LogSpy;
  let warnSpy: LogSpy;

  /** 只收集访问日志（结构化字段里带 method + status），忽略 Nest 自身的日志。 */
  function record(
    level: AccessLogEntry['level'],
    message: unknown,
    params: unknown[],
  ): void {
    const [fields] = params;
    if (fields === null || typeof fields !== 'object') return;
    const recordFields = fields as Record<string, unknown>;
    if (
      typeof recordFields.method !== 'string' ||
      typeof recordFields.status !== 'number'
    ) {
      return;
    }
    entries.push({ level, line: String(message), fields: recordFields });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    entries = [];
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown, ...params: unknown[]) => {
        record('log', message, params);
      });
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown, ...params: unknown[]) => {
        record('warn', message, params);
      });
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('守卫拒绝的 401 也写一条访问日志（拦截器方案的盲区）', async () => {
    await request(app.getHttpServer() as App)
      .get('/probe/protected')
      .expect(401);

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].fields).toMatchObject({
      method: 'GET',
      status: 401,
      url: '/probe/protected',
    });
    // requestId 由先执行的 RequestIdMiddleware 生成。
    expect(entries[0].fields.requestId).toEqual(expect.any(String));
    expect(entries[0].fields.durationMs).toEqual(expect.any(Number));
  });

  it('正常 200 请求写一条日志，并透传上游 requestId', async () => {
    await request(app.getHttpServer() as App)
      .get('/probe/public')
      .set('x-request-id', 'req-from-upstream')
      .expect(200);

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('log');
    expect(entries[0].fields).toMatchObject({
      method: 'GET',
      status: 200,
      url: '/probe/public',
      requestId: 'req-from-upstream',
    });
  });

  it('一次请求只写一条访问日志（不与拦截器重复）', async () => {
    await request(app.getHttpServer() as App)
      .get('/probe/public')
      .expect(200);

    expect(entries).toHaveLength(1);
  });

  it('登录用户只带 userId / tenantId，不带邮箱与密码', async () => {
    await request(app.getHttpServer() as App)
      .get('/probe/me')
      .expect(200);

    expect(entries).toHaveLength(1);
    expect(entries[0].fields).toMatchObject({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('leak@example.test');
    expect(serialized).not.toContain(FIXTURE_PASSWORD);
  });

  it('不记录请求 body 中的密码 / 令牌 / cookie', async () => {
    await request(app.getHttpServer() as App)
      .post('/probe/login')
      .send({
        password: FIXTURE_PASSWORD,
        token: FIXTURE_TOKEN,
        cookie: FIXTURE_COOKIE,
      })
      .expect(201);

    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries[0]);
    for (const secret of [FIXTURE_PASSWORD, FIXTURE_TOKEN, FIXTURE_COOKIE]) {
      expect(serialized).not.toContain(secret);
    }
    // 字段里也不该出现 body / password / token / cookie 这些键。
    expect(serialized.toLowerCase()).not.toMatch(
      /password|token|cookie|"body"/,
    );
  });
});
