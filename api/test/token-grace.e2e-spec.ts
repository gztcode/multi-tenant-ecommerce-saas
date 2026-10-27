import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { TokenGraceService } from '../src/modules/auth/token-grace.service';
import { hashRefreshToken } from '../src/modules/auth/token.util';
import { RefreshTokenRevokedReason } from '@prisma/client';
import { http } from './helpers';

/**
 * 宽限密文的定时清理（阶段 5c）。
 *
 * ⚠️ **为什么要有这个任务**：宽限记录里存的是新令牌的**密文**，
 * 客户端轮换后就不会再用旧令牌，所以绝大多数行的密文**永远等不到**
 * 「有人来用它」的那一刻 —— 惰性清理根本不会触发。
 *
 * 护栏 G7：过期宽限记录的密文被抹掉，没过期的保留。
 */
describe('宽限密文的清理 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let grace: TokenGraceService;

  const unique = () => randomBytes(6).toString('hex');

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
    grace = app.get(TokenGraceService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 造一枚「已轮换、带宽限记录」的令牌行。
   *
   * @param graceExpiresAt 宽限截止时刻；给一个过去的时刻就表示「已过期」
   */
  async function seedRotatedToken(
    graceExpiresAt: Date,
  ): Promise<{ userId: string; tokenHash: string }> {
    const account = `grace-${unique()}@example.test`;
    const registered = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '清理商家',
        subdomain: `shop-${unique()}`,
        storeName: '清理店铺',
      })
      .expect(201);

    const userId = (registered.body as { user: { id: string } }).user.id;
    const tokenHash = hashRefreshToken(`plain-${unique()}`);

    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        revokedAt: new Date(),
        revokedReason: RefreshTokenRevokedReason.ROTATED,
        rotatedToToken: 'cipher-text-placeholder',
        graceExpiresAt,
      },
    });

    return { userId, tokenHash };
  }

  it('把过期宽限记录的密文抹掉，没过期的保留（G7）', async () => {
    const expired = await seedRotatedToken(new Date(Date.now() - 1000));
    const alive = await seedRotatedToken(new Date(Date.now() + 60_000));

    const cleared = await grace.cleanup();

    // 至少抹掉了那一行（库里可能还有别的过期行，所以用 >= 而不是 ===）
    expect(cleared).toBeGreaterThanOrEqual(1);

    const expiredRow = await prisma.refreshToken.findFirst({
      where: { tokenHash: expired.tokenHash },
      select: { rotatedToToken: true, graceExpiresAt: true },
    });
    const aliveRow = await prisma.refreshToken.findFirst({
      where: { tokenHash: alive.tokenHash },
      select: { rotatedToToken: true, graceExpiresAt: true },
    });

    // 关键断言 1：过期的那行密文被抹了，但宽限截止时刻保留
    // （时刻是审计线索，不该被清掉）
    expect(expiredRow?.rotatedToToken).toBeNull();
    expect(expiredRow?.graceExpiresAt).not.toBeNull();

    // 关键断言 2：没过期的必须留着
    expect(aliveRow?.rotatedToToken).toBe('cipher-text-placeholder');
  });

  it('清理之后不该再有带密文的过期记录残留', async () => {
    // ⚠️ **不断言「清掉了 0 条」** —— 库里可能有别的套件造的过期记录。
    // 断言的是「清理之后一条都不剩」，这才是清理任务真正的职责。
    await grace.cleanup();

    const remaining = await prisma.refreshToken.count({
      where: {
        rotatedToToken: { not: null },
        graceExpiresAt: { lt: new Date() },
      },
    });

    expect(remaining).toBe(0);
  });
});
