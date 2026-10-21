import {
  Controller,
  Get,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { UserRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { Roles } from '../src/common/decorators/roles.decorator';
import { http } from './helpers';

/**
 * 只在测试里存在的探针控制器，用来验证角色守卫真的生效。
 *
 * 探针挂在独立模块里而非 AppModule：它必须和真实业务代码走完全相同的
 * 全局守卫链路（RolesGuard 由 AppModule 的 APP_GUARD 提供），
 * 才能证明全局注册确实覆盖到了所有路由。
 */
@Controller('probe')
class RoleProbeController {
  @Get('platform-only')
  @Roles(UserRole.PLATFORM_ADMIN)
  platformOnly() {
    return { ok: true, scope: 'platform' };
  }

  @Get('merchant-only')
  @Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
  merchantOnly() {
    return { ok: true, scope: 'merchant' };
  }
}

@Module({
  imports: [AppModule],
  controllers: [RoleProbeController],
})
class RbacProbeModule {}

interface AuthResponseBody {
  accessToken: string;
  refreshToken: string;
  user: { email: string; role: string };
}

interface UserResponseBody {
  email: string;
  role: string;
}

interface ProbeResponseBody {
  ok: boolean;
  scope: string;
}

function authBody(response: { body: unknown }): AuthResponseBody {
  return response.body as AuthResponseBody;
}

function userBody(response: { body: unknown }): UserResponseBody {
  return response.body as UserResponseBody;
}

function probeBody(response: { body: unknown }): ProbeResponseBody {
  return response.body as ProbeResponseBody;
}

describe('RBAC (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacProbeModule],
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
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerMerchant() {
    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-${unique()}@example.test`,
        password: 'Passw0rd123',
        merchantName: '商家',
        subdomain: `s-${unique()}`,
        storeName: '店铺',
      })
      .expect(201);
    return authBody(response);
  }

  it('携带有效 JWT 时 /auth/me 返回当前用户', async () => {
    const auth = await registerMerchant();

    const response = await http(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(200);
    expect(userBody(response).email).toBe(auth.user.email);
    expect(userBody(response).role).toBe('MERCHANT_OWNER');
  });

  it('无 Authorization 头时 /auth/me 返回 401', async () => {
    await http(app).get('/api/v1/auth/me').expect(401);
  });

  it('伪造的 JWT 返回 401', async () => {
    await http(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('商家访问平台专属端点返回 403', async () => {
    const auth = await registerMerchant();

    const response = await http(app)
      .get('/api/v1/probe/platform-only')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(403);
  });

  it('平台超管访问平台专属端点返回 200', async () => {
    // 平台超管是种子数据里那个账号，用 PLATFORM 入口登录
    const login = await http(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@platform.test',
        password: 'Admin12345!',
        scope: 'PLATFORM',
      })
      .expect(200);

    const response = await http(app)
      .get('/api/v1/probe/platform-only')
      .set('Authorization', `Bearer ${authBody(login).accessToken}`);

    expect(response.status).toBe(200);
    expect(probeBody(response).scope).toBe('platform');
  });

  it('商家访问商家端点返回 200', async () => {
    const auth = await registerMerchant();

    const response = await http(app)
      .get('/api/v1/probe/merchant-only')
      .set('Authorization', `Bearer ${auth.accessToken}`);

    expect(response.status).toBe(200);
  });

  it('未登录访问带角色限制的端点返回 401', async () => {
    await http(app).get('/api/v1/probe/platform-only').expect(401);
  });

  it('登出需要 access token，且登出后刷新令牌失效', async () => {
    const auth = await registerMerchant();

    // 不带 access token 登出 → 401（盲登出被挡住）
    await http(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: auth.refreshToken })
      .expect(401);

    // 带 access token 登出 → 204
    await http(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ refreshToken: auth.refreshToken })
      .expect(204);

    // 登出后那枚刷新令牌不能再换新令牌
    await http(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(401);
  });
});
