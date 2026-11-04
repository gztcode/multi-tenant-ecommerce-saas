// ⚠️ `@nestjs/jwt` 12 是纯 ESM 包，Jest 的 CJS 运行时无法直接加载
//    （仓库已知约束，见 `src/modules/billing/ledger-check.ts` 顶部注释）。
//    本套用例只需要 `JwtService` 作为 DI 的参数类型，因此用工厂 mock 掉，
//    避免整条 import 图被 ESM 解析卡住。
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));

import { AuthService } from './auth.service';

const DB_NOW = new Date('2026-11-04T00:00:00.000Z');

function makeService(stored: Record<string, unknown>, dbNow: Date) {
  const prisma = {
    databaseNow: jest.fn().mockResolvedValue(dbNow),
    refreshToken: {
      findFirst: jest.fn().mockResolvedValue(stored),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };

  return {
    prisma,
    service: new AuthService(prisma as never, jwt as never),
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
