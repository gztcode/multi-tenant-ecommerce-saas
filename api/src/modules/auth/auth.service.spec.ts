// ⚠️ `@nestjs/jwt` 12 是纯 ESM 包，Jest 的 CJS 运行时无法直接加载
//    （仓库已知约束，见 `src/modules/billing/ledger-check.ts` 顶部注释）。
//    本套用例只需要 `JwtService` 作为 DI 的参数类型，因此用工厂 mock 掉，
//    避免整条 import 图被 ESM 解析卡住。
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));

import { HttpException, HttpStatus } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';
import { LoginScope } from './dto/login.dto';

const DB_NOW = new Date('2026-11-04T00:00:00.000Z');

function makeService(stored: Record<string, unknown>, dbNow: Date) {
  const prisma = {
    databaseNow: jest.fn().mockResolvedValue(dbNow),
    refreshToken: {
      findFirst: jest.fn().mockResolvedValue(stored),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };

  return {
    prisma,
    service: new AuthService(
      prisma as never,
      jwt as never,
      new LoginThrottleService(),
    ),
  };
}

function expiredToken() {
  return {
    id: 'token-1',
    userId: 'user-1',
    tokenHash: 'hash',
    revokedAt: null,
    revokedReason: null,
    expiresAt: new Date('2026-11-03T00:00:00.000Z'),
    graceExpiresAt: null,
    rotatedToToken: null,
    user: {
      id: 'user-1',
      email: 'a@example.com',
      displayName: 'A',
      role: 'MERCHANT_OWNER',
      tenantId: 'tenant-a',
    },
  };
}

describe('AuthService.refresh：时钟跟随数据库', () => {
  it('应用时钟未过期、数据库时钟已过期 → 401', async () => {
    // 应用此时是 2026-11-02，令牌在 11-03 过期，看起来"还没过期"；
    // 数据库已经是 11-04，必须按数据库判定为过期。
    jest.useFakeTimers().setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
    const { service } = makeService(expiredToken(), DB_NOW);

    await expect(service.refresh('raw-token')).rejects.toThrow(
      '刷新令牌无效或已过期',
    );

    jest.useRealTimers();
  });
});

/**
 * 登录失败限流（审计 P2-3）。
 *
 * ⚠️ **账号不存在也要计数**：撞库主要就是在试大量**没注册过**的邮箱。
 */
describe('AuthService.login：失败限流（审计 P2-3）', () => {
  const WRONG = {
    email: 'a@example.com',
    password: 'wrong-password',
    scope: LoginScope.CUSTOMER,
  };

  it('连续失败 5 次 → 第 6 次被 429 拦住', async () => {
    const { service } = makeService({}, DB_NOW);

    for (let i = 0; i < 5; i += 1) {
      await expect(service.login(WRONG, null)).rejects.toThrow(
        '邮箱或密码不正确',
      );
    }

    await expect(service.login(WRONG, null)).rejects.toThrow(HttpException);
    await expect(service.login(WRONG, null)).rejects.toThrow(
      /登录失败次数过多/,
    );
    // 必须是 429（而不是别的错误码），否则前端会按「密码错误」提示误导用户
    await expect(service.login(WRONG, null)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('登录成功 → 计数清零（改对密码就不该继续被限）', async () => {
    const hash = await argon2.hash('right-password');
    const { service, prisma } = makeService({}, DB_NOW);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        email: 'a@example.com',
        passwordHash: hash,
        role: 'MERCHANT_OWNER',
        tenantId: 'tenant-a',
        displayName: 'A',
      },
    ]);

    for (let i = 0; i < 4; i += 1) {
      await expect(service.login(WRONG, null)).rejects.toThrow(
        '邮箱或密码不正确',
      );
    }
    await expect(
      service.login({ ...WRONG, password: 'right-password' }, null),
    ).resolves.toBeDefined();

    // 计数已清零 → 再错 5 次才轮到 429
    for (let i = 0; i < 4; i += 1) {
      await expect(service.login(WRONG, null)).rejects.toThrow(
        '邮箱或密码不正确',
      );
    }
    await expect(service.login(WRONG, null)).rejects.toThrow(
      '邮箱或密码不正确',
    );
    await expect(service.login(WRONG, null)).rejects.toThrow(HttpException);
    await expect(service.login(WRONG, null)).rejects.toThrow(
      /登录失败次数过多/,
    );
  });
});
