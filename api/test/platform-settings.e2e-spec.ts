import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PAYOUT_DEFAULT_CHANNEL_KEY } from '../src/common/platform-settings/platform-setting.service';
import { http } from './helpers';
import { createMerchant } from './merchant-fixture';

/**
 * 平台默认出款渠道设置（e2e，阶段 6a Task 4）。
 *
 * 守两件事：
 * 1. **平台超管能读能写**，写入带 `updatedBy` 留痕；
 * 2. **商家令牌一律 403** —— 这是在改「平台往哪家渠道打钱」。
 *
 * ⚠️ **本文件只写不跑**（由管理者统一跑 e2e）；但它必须能编译。
 *
 * ⚠️ **`platform_settings` 跨文件共享** —— 别的 spec 可能也会写这行，
 *    所以每个用例开始前/结束后都清掉本键，避免串味。
 */

interface LoginBody {
  accessToken: string;
}

// ⚠️ `/auth/me` 返回的是 `CurrentUserPayload`：主键字段叫 `userId`（不是 `id`）。
interface MeBody {
  userId: string;
  role: string;
}

interface SettingBody {
  channel: string;
  source: 'DATABASE' | 'ENV';
}

interface ChannelOptionBody {
  channel: string;
  provider: string;
}

const PLATFORM_ADMIN_EMAIL =
  process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
const PLATFORM_ADMIN_PASSWORD =
  process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';

describe('平台默认出款渠道设置 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let originalEnabled: string | undefined;
  let originalDefault: string | undefined;

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    originalEnabled = process.env.PAYOUT_ENABLED_CHANNELS;
    originalDefault = process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;

    // 测试里只启用假出款渠道，且不设 env 兜底（走 DB）
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout';
    delete process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;

    await deleteSettingRow();
  });

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.PAYOUT_ENABLED_CHANNELS;
    } else {
      process.env.PAYOUT_ENABLED_CHANNELS = originalEnabled;
    }
    if (originalDefault === undefined) {
      delete process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;
    } else {
      process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = originalDefault;
    }
  });

  /** 在平台作用域里删掉本键（测试代码在 HTTP 请求之外，没有上下文） */
  async function deleteSettingRow(): Promise<void> {
    await tenantContext.run(platformScope(), async () => {
      await prisma.platformSetting.deleteMany({
        where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
      });
    });
  }

  /** 平台超管登录，返回 accessToken 与用户 id */
  async function loginPlatformAdmin(): Promise<{
    token: string;
    userId: string;
  }> {
    const login = await http(app)
      .post('/api/v1/auth/login')
      .send({
        email: PLATFORM_ADMIN_EMAIL,
        password: PLATFORM_ADMIN_PASSWORD,
        scope: 'PLATFORM',
      })
      .expect(200);
    const token = (login.body as LoginBody).accessToken;

    const me = await http(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return { token, userId: (me.body as MeBody).userId };
  }

  it('⚠️ 未登录读取 → 401', async () => {
    await http(app).get('/api/v1/platform/settings/payout-channel').expect(401);
  });

  it('⚠️ 商家令牌读取 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .get('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${merchant.token}`)
      .expect(403);
  });

  it('⚠️ 商家令牌写入 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .put('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${merchant.token}`)
      .send({ channel: 'fake-payout' })
      .expect(403);
  });

  it('平台超管写入 → 返回 DATABASE 并留下 updatedBy', async () => {
    const admin = await loginPlatformAdmin();

    const response = await http(app)
      .put('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ channel: 'fake-payout' })
      .expect(200);

    expect(response.body as SettingBody).toEqual({
      channel: 'fake-payout',
      source: 'DATABASE',
    });

    const row = await tenantContext.run(platformScope(), async () =>
      prisma.platformSetting.findUnique({
        where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
      }),
    );
    expect(row?.updatedBy).toBe(admin.userId);
    expect(row?.value).toEqual({ channel: 'fake-payout' });
  });

  it('平台超管读取 → 返回已保存的 DATABASE 渠道', async () => {
    const admin = await loginPlatformAdmin();

    await http(app)
      .put('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ channel: 'fake-payout' })
      .expect(200);

    const response = await http(app)
      .get('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(response.body as SettingBody).toEqual({
      channel: 'fake-payout',
      source: 'DATABASE',
    });
  });

  it('DB 无行且 env 有值 → 读取回落 ENV', async () => {
    process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = 'fake-payout';
    const admin = await loginPlatformAdmin();

    const response = await http(app)
      .get('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(response.body as SettingBody).toEqual({
      channel: 'fake-payout',
      source: 'ENV',
    });
  });

  it('⚠️ DB 无行且 env 无值 → 200 且 channel=null（设置页要靠它渲染保存表单）', async () => {
    const admin = await loginPlatformAdmin();

    const response = await http(app)
      .get('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // ⚠️ **不能是 409** —— 否则全新环境里超管后台永远没有保存入口。
    expect(response.body).toEqual({ channel: null, source: 'NONE' });
  });

  it('⚠️ 写入未启用渠道 → 409 且不写库', async () => {
    const admin = await loginPlatformAdmin();

    await http(app)
      .put('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ channel: 'not-enabled-channel' })
      .expect(409);

    const row = await tenantContext.run(platformScope(), async () =>
      prisma.platformSetting.findUnique({
        where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
      }),
    );
    expect(row).toBeNull();
  });

  it('⚠️ 请求体带多余字段 → 400（forbidNonWhitelisted）', async () => {
    const admin = await loginPlatformAdmin();

    await http(app)
      .put('/api/v1/platform/settings/payout-channel')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ channel: 'fake-payout', tenantId: 'other-tenant' })
      .expect(400);
  });

  it('平台超管列出可选出款渠道 → 含 fake-payout', async () => {
    const admin = await loginPlatformAdmin();

    const response = await http(app)
      .get('/api/v1/platform/settings/payout-channels')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    const options = response.body as ChannelOptionBody[];
    expect(options).toContainEqual({
      channel: 'fake-payout',
      provider: 'fake-payout',
    });
  });
});
