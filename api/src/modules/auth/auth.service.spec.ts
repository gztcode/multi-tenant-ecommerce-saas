// ⚠️ `@nestjs/jwt` 12 是纯 ESM 包，Jest 的 CJS 运行时无法直接加载
//    （仓库已知约束，见 `src/modules/billing/ledger-check.ts` 顶部注释）。
//    本套用例只需要 `JwtService` 作为 DI 的参数类型，因此用工厂 mock 掉，
//    避免整条 import 图被 ESM 解析卡住。
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));

import { HttpException, HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { tenantContext } from '../../common/tenant/tenant-context';
import { AuthService } from './auth.service';
import { AuthThrottleService } from './auth-throttle.service';
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
      new AuthThrottleService({ production: false }),
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

/**
 * 注册路径用的 prisma mock。
 *
 * 只桩出注册流程真正用到的方法：少一个桩就会在用例里以
 * 「undefined is not a function」的形式炸出来，比断言失败更难读。
 */
function makeRegisterService() {
  const prisma = {
    databaseNow: jest.fn().mockResolvedValue(DB_NOW),
    tenant: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'someone@example.test',
        displayName: '某人',
        role: 'CUSTOMER',
        tenantId: 'tenant-1',
      }),
    },
    store: {
      create: jest.fn().mockResolvedValue({ id: 'store-1' }),
    },
    refreshToken: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'refresh-token-1' }),
    },
    $transaction: jest.fn(),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };

  return {
    prisma,
    service: new AuthService(
      prisma as never,
      jwt as never,
      new AuthThrottleService({ production: false }),
    ),
  };
}

/**
 * 注册路径的唯一约束兜底。
 *
 * ⚠️ P2002 一路冒到全局异常过滤器会变成 500「服务器内部错误」，
 *    所以「先查后建」的竞态必须在 service 层就地翻译成 409。
 */
describe('AuthService.registerMerchant：租户创建的 P2002 兜底', () => {
  const MERCHANT_DTO = {
    email: 'owner@example.test',
    password: 'Passw0rd123',
    merchantName: '示例商户',
    subdomain: 'acme-shop',
    storeName: 'Acme 官方旗舰店',
  };

  it('租户创建撞唯一约束（P2002）→ 409，不是 500', async () => {
    const { service, prisma } = makeRegisterService();
    prisma.tenant.create.mockRejectedValue({ code: 'P2002' });

    const promise = service.registerMerchant(MERCHANT_DTO);

    await expect(promise).rejects.toThrow(HttpException);
    await expect(promise).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    // 租户根本没建出来 → 没有可回滚的租户，绝不能去删别人的租户
    expect(prisma.tenant.deleteMany).not.toHaveBeenCalled();
  });

  it('租户创建抛非唯一约束错误 → 原样抛出，不被翻译成 409', async () => {
    const { service, prisma } = makeRegisterService();
    const boom = new Error('数据库连接断了');
    prisma.tenant.create.mockRejectedValue(boom);

    await expect(service.registerMerchant(MERCHANT_DTO)).rejects.toBe(boom);
  });

  it('租户建出来、后续建店主失败 → 仍然回滚租户（既有行为不回退）', async () => {
    const { service, prisma } = makeRegisterService();
    prisma.user.create.mockRejectedValue(new Error('建店主失败'));

    await expect(service.registerMerchant(MERCHANT_DTO)).rejects.toThrow(
      '建店主失败',
    );

    expect(prisma.tenant.deleteMany).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
    });
  });
});

describe('AuthService.registerCustomer：邮箱查重与 P2002 兜底', () => {
  const CUSTOMER_DTO = {
    email: 'buyer@example.test',
    password: 'Passw0rd123',
    displayName: '小张',
  };

  /** 消费者注册必须跑在租户上下文里（租户由子域名解析） */
  function register(service: AuthService) {
    return tenantContext.run(
      { tenantId: 'tenant-1', userId: null, role: UserRole.CUSTOMER },
      async () => service.registerCustomer(CUSTOMER_DTO),
    );
  }

  it('查重条件与数据库索引对齐：邮箱大小写不敏感 + 角色含店员', async () => {
    const { service, prisma } = makeRegisterService();

    await register(service);

    // 必须逐项对上 users_customer_email_ci_key：
    // (LOWER(email), tenantId) WHERE role IN ('CUSTOMER', 'MERCHANT_STAFF')
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: 'buyer@example.test', mode: 'insensitive' },
        role: { in: [UserRole.CUSTOMER, UserRole.MERCHANT_STAFF] },
      },
    });
  });

  it('创建用户撞唯一约束（P2002）→ 409，不是 500', async () => {
    const { service, prisma } = makeRegisterService();
    prisma.user.create.mockRejectedValue({ code: 'P2002' });

    const promise = register(service);

    await expect(promise).rejects.toThrow(HttpException);
    await expect(promise).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    await expect(promise).rejects.toThrow('该邮箱已注册');
  });

  it('创建用户抛非唯一约束错误 → 原样抛出，不被翻译成 409', async () => {
    const { service, prisma } = makeRegisterService();
    const boom = new Error('数据库连接断了');
    prisma.user.create.mockRejectedValue(boom);

    await expect(register(service)).rejects.toBe(boom);
  });
});
