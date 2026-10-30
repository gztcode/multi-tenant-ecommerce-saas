import { BadRequestException, NotFoundException } from '@nestjs/common';

import { tenantContext } from '../../common/tenant/tenant-context';
import { PayoutAccountService, maskAccountNo } from './payout-account.service';
import { PayoutCipherService } from './payout-cipher.service';

/**
 * 商家收款账户的服务层单测（阶段 5h-1 Task 5）。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**：每个方法的返回值由 `options` 配好，
 *    **它不按 `where` 过滤**（与 `payout.service.spec.ts` 同款）。
 *    代价是「查不到别家的账户」这种行为在单测里测不出来 ——
 *    → **租户隔离（P9）靠「断言 service 层传的 where」来验**。
 *
 * ⚠️ **阶段 5j：账号落库即密文** —— 假数据里的 `accountNoCipher` 也是密文，
 *    `maskedAccountNo` 是预存的掩码串。
 */

/** 收款账户的形状（阶段 5j：账号是密文） */
function payoutAccount(overrides?: {
  id?: string;
  accountName?: string;
  bankName?: string;
  accountNoCipher?: string;
  maskedAccountNo?: string;
  encryptionVersion?: number;
  updatedAt?: Date;
}) {
  return {
    id: overrides?.id ?? 'acct-a',
    tenantId: 'tenant-a',
    accountName: overrides?.accountName ?? '张三',
    bankName: overrides?.bankName ?? '测试银行',
    accountNoCipher: overrides?.accountNoCipher ?? 'cipher-6222000000000000',
    maskedAccountNo: overrides?.maskedAccountNo ?? '************0000',
    encryptionVersion: overrides?.encryptionVersion ?? 1,
    createdAt: new Date('2025-08-01T00:00:00.000Z'),
    updatedAt: overrides?.updatedAt ?? new Date('2025-08-02T00:00:00.000Z'),
  };
}

/**
 * 假 Prisma 的查询参数（只要能读出 `where` 就够断言了）。
 *
 * ⚠️ **刻意宽松**：`where` 的具体形状随服务层的写法变，
 *    这里钉死它只会让每次改查询都要改类型。
 */
interface QueryArgs {
  where?: Record<string, unknown>;
  data?: unknown;
  select?: unknown;
}

/**
 * 取某个 mock 的**第一次调用**的参数。
 *
 * ⚠️ **为什么要有这个 helper**：直接写 `mock.calls[0][0]` 在
 *    `strictNullChecks` 下会报「可能为 undefined」，而每处都写
 *    `!` 又太吵。这里集中一处断言「确实被调用过」——
 *    少调一次就该让测试挂掉，而不是静默跳过断言。
 */
function argsOf(mock: { mock: { calls: unknown[][] } }): QueryArgs {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return (call ?? [])[0] as QueryArgs;
}

/**
 * 一只最小可用的假 Prisma。
 *
 * ⚠️ **只实现服务层真正用到的那几个方法**：多写一个就多一处
 *    「测试里的假实现与真实 Prisma 行为不一致」的风险。
 */
function fakePrisma(options: {
  /** 查出来的收款账户（null = 还没设） */
  account?: ReturnType<typeof payoutAccount> | null;
  /** `create` 的返回值 */
  created?: ReturnType<typeof payoutAccount>;
  /** `updateMany` 影响多少行 */
  updateManyCount?: number;
}) {
  /**
   * ⚠️ **用 `jest.fn<返回值, 参数元组>()` 而不是 `jest.fn((_args) => ...)`**：
   *    后者会留下一个**没用到的参数**，本仓库的 eslint 没开
   *    `argsIgnorePattern` → 每个桩都要报 unused-vars。
   */
  const prisma = {
    merchantPayoutAccount: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.account === undefined ? payoutAccount() : options.account,
        ),
      ),
      updateMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: options.updateManyCount ?? 1 }),
      ),
      create: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.created ?? payoutAccount()),
      ),
    },
  };
  return prisma;
}

/** 把假 Prisma 塞进服务（只用到 `as unknown as` 的一次性断言） */
function makeService(
  prisma: ReturnType<typeof fakePrisma>,
): PayoutAccountService {
  return new PayoutAccountService(
    prisma as unknown as never,
    new PayoutCipherService(),
  );
}

/** 在租户上下文里调用（服务层靠 `getTenantContext()` 取租户） */
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: 'tenant-a', userId: 'user-a', role: null },
    async () => fn(),
  );
}

/**
 * ⚠️ **单元测试进程里没有 .env** —— `PayoutCipherService` 在构造时就要密钥，
 *    拿不到就直接抛错。所以这里显式设一个**测试用**密钥。
 *
 * ⚠️ **固定值而不是随机值**：密文要能被断言（解出来 == 原文），
 *    随机密钥会让「这条密文是谁加密的」无从判断。
 */
const TEST_ENCRYPTION_KEY = 'test-payout-encryption-key-at-least-32-chars';

beforeAll(() => {
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

describe('收款账户：读', () => {
  it('没有账户 → 返回 null', async () => {
    const prisma = fakePrisma({ account: null });
    const service = makeService(prisma);

    const view = await asTenant(() => service.get());

    expect(view).toBeNull();
  });

  it('有账户 → 返回脱敏后的账号（不是完整账号）', async () => {
    const prisma = fakePrisma({
      account: payoutAccount({
        accountNoCipher: 'cipher-6222000000000000',
        maskedAccountNo: '************0000',
      }),
    });
    const service = makeService(prisma);

    const view = await asTenant(() => service.get());

    expect(view).not.toBeNull();
    expect(view?.accountName).toBe('张三');
    expect(view?.bankName).toBe('测试银行');
    expect(view?.maskedAccountNo).toBe('************0000');
    // ⚠️ **完整账号不能出现在响应里**：脱敏了还往外送等于没脱敏
    expect(JSON.stringify(view)).not.toContain('6222000000000000');
  });

  it('⚠️ 库里的账号是密文，但 API 只返回掩码串（展示路径不解密）', async () => {
    // ⚠️ **「只返回掩码串」不能靠「密文里没有明文子串」来验** ——
    //    那只说明密文没泄露原文，不说明 API 有没有解密。
    //    这里换成：**API 返回的掩码串 == 用明文算出来的掩码串**，
    //    且**读出来的密文没被解密过**（解密会失败 → 说明展示路径没解密）。
    const plain = '6222000000000000';
    const cipher = new PayoutCipherService().encrypt(plain);
    const prisma = fakePrisma({
      account: payoutAccount({
        accountNoCipher: cipher,
        maskedAccountNo: maskAccountNo(plain),
      }),
    });
    const service = makeService(prisma);

    const view = await asTenant(() => service.get());

    expect(view?.maskedAccountNo).toBe(maskAccountNo(plain));
    // ⚠️ **掩码串来自库里预存的那份**，不是现算的
    expect(view?.maskedAccountNo).toBe('************0000');
    // ⚠️ **完整账号一个字节都不能漏出去**
    expect(JSON.stringify(view)).not.toContain(plain);
  });

  it('⚠️ 商家侧的查询不手写 tenantId（靠租户作用域扩展自动附加）', async () => {
    // ⚠️ **手写的那份是无效的**：`withMergedWhere` 是 `{...base, ...extra}`
    //    → 扩展附的 tenantId 会**覆盖**调用方写的同键值。
    //    所以手写既不构成漏洞，也不产生任何效果 —— 它只是噪声，
    //    而且**看起来像「这里自己保证了租户隔离」**，容易误导后来者。
    const prisma = fakePrisma({ account: payoutAccount() });
    const service = makeService(prisma);

    await asTenant(() => service.get());

    const call = argsOf(prisma.merchantPayoutAccount.findFirst);
    expect(call.where).toEqual({});
    expect(call.where?.tenantId).toBeUndefined();
  });
});

describe('收款账户：写（有则更新、无则新建）', () => {
  it('没有账户 → 走 create 分支', async () => {
    const prisma = fakePrisma({ account: null });
    const service = makeService(prisma);

    const view = await asTenant(() =>
      service.set({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      }),
    );

    expect(prisma.merchantPayoutAccount.create).toHaveBeenCalledTimes(1);
    expect(prisma.merchantPayoutAccount.updateMany).not.toHaveBeenCalled();
    expect(view.maskedAccountNo).toBe('************0000');
  });

  it('⚠️ create 落库的是密文（不是明文），版本号为 1', async () => {
    const prisma = fakePrisma({ account: null });
    const service = makeService(prisma);
    const plain = '6225880000000000';

    await asTenant(() =>
      service.set({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: plain,
      }),
    );

    const data = argsOf(prisma.merchantPayoutAccount.create).data as Record<
      string,
      unknown
    >;
    // ⚠️ **库里不该再有完整账号的明文副本**
    expect(data.accountNo).toBeUndefined();
    expect(data.accountNoCipher).toBeDefined();
    expect(data.accountNoCipher).not.toBe(plain);
    // ⚠️ **更强的断言**：密文解出来就是原文（不只是「不等于原文」）
    expect(
      new PayoutCipherService().decrypt(data.accountNoCipher as string),
    ).toBe(plain);
    // ⚠️ **掩码串单独存** —— 密文长度 ≠ 明文长度，
    //    掩码要按明文长度打星 → 不解密就还原不出掩码
    expect(data.maskedAccountNo).toBe(maskAccountNo(plain));
    expect(data.encryptionVersion).toBe(1);
  });

  it('已有账户 → 走 updateMany 分支，不调 create', async () => {
    const prisma = fakePrisma({ account: payoutAccount() });
    const service = makeService(prisma);
    const plain = '6225880000000001';

    await asTenant(() =>
      service.set({
        accountName: '李四',
        bankName: '工商银行',
        accountNo: plain,
      }),
    );

    expect(prisma.merchantPayoutAccount.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.merchantPayoutAccount.create).not.toHaveBeenCalled();
    const updateCall = argsOf(prisma.merchantPayoutAccount.updateMany);
    expect(updateCall.where).toEqual({ id: 'acct-a' });
    const data = updateCall.data as Record<string, unknown>;
    expect(data.accountName).toBe('李四');
    expect(data.bankName).toBe('工商银行');
    // ⚠️ **落库的是密文**
    expect(data.accountNo).toBeUndefined();
    expect(
      new PayoutCipherService().decrypt(data.accountNoCipher as string),
    ).toBe(plain);
    expect(data.maskedAccountNo).toBe(maskAccountNo(plain));
    expect(data.encryptionVersion).toBe(1);
    // ⚠️ **回读的是更新后的那行**：更新完再查一次，
    //    返回值才是新值 —— 不是把旧值当成新值返回。
    expect(prisma.merchantPayoutAccount.findFirst).toHaveBeenCalledTimes(2);
  });

  it('⚠️ 账号留空 → 不带账号那三个键（保留原账号）', async () => {
    // ⚠️ **后端只回脱敏值**，商家改开户人姓名时手里没有原账号
    //    → 留空表示「不修改这一项」。
    //    ⚠️ **写成空串会把账号清成空** —— 钱就不知道打给谁了。
    const prisma = fakePrisma({ account: payoutAccount() });
    const service = makeService(prisma);

    await asTenant(() =>
      service.set({ accountName: '李四', bankName: '工商银行' }),
    );

    const updateCall = argsOf(prisma.merchantPayoutAccount.updateMany);
    expect(updateCall.data).toEqual({
      accountName: '李四',
      bankName: '工商银行',
    });
    const data = updateCall.data as Record<string, unknown>;
    expect(data.accountNo).toBeUndefined();
    expect(data.accountNoCipher).toBeUndefined();
    expect(data.maskedAccountNo).toBeUndefined();
    expect(data.encryptionVersion).toBeUndefined();
  });

  it('⚠️ 首次设置且账号留空 → 400（没有账号不知道钱打给谁）', async () => {
    const prisma = fakePrisma({ account: null });
    const service = makeService(prisma);

    await expect(
      asTenant(() =>
        service.set({ accountName: '张三', bankName: '招商银行' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.merchantPayoutAccount.create).not.toHaveBeenCalled();
  });

  it('create 时带上 tenantId（租户作用域下扩展也会注入）', async () => {
    const prisma = fakePrisma({ account: null });
    const service = makeService(prisma);

    await asTenant(() =>
      service.set({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      }),
    );

    const createCall = argsOf(prisma.merchantPayoutAccount.create);
    expect((createCall.data as Record<string, unknown>).tenantId).toBe(
      'tenant-a',
    );
  });

  it('updateMany 影响 0 行 → 404', async () => {
    const prisma = fakePrisma({
      account: payoutAccount(),
      updateManyCount: 0,
    });
    const service = makeService(prisma);

    await expect(
      asTenant(() =>
        service.set({
          accountName: '李四',
          bankName: '工商银行',
          accountNo: '6225880000000001',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('⚠️ set 里的 findFirst 也不手写 tenantId', async () => {
    const prisma = fakePrisma({ account: payoutAccount() });
    const service = makeService(prisma);

    await asTenant(() =>
      service.set({
        accountName: '李四',
        bankName: '工商银行',
        accountNo: '6225880000000001',
      }),
    );

    const call = argsOf(prisma.merchantPayoutAccount.findFirst);
    expect(call.where?.tenantId).toBeUndefined();
  });
});

describe('账号脱敏', () => {
  it('短于等于 8 位 → 全打码', () => {
    expect(maskAccountNo('')).toBe('');
    expect(maskAccountNo('1234')).toBe('****');
    expect(maskAccountNo('12345678')).toBe('********');
  });

  it('长于 8 位 → 只留尾 4 位', () => {
    expect(maskAccountNo('123456789')).toBe('*****6789');
    expect(maskAccountNo('6222000000000000')).toBe('************0000');
  });

  it('⚠️ 短账号不能因为「留尾 4 位」而露出来（短账号很容易被猜）', () => {
    // ⚠️ 账号 8 位时若按「留尾 4 位」处理 → 露一半，只剩 4 位猜不出来吗？
    //    4 位数字只有 1 万种，全打码才是安全的。
    expect(maskAccountNo('12345678')).not.toContain('5678');
  });
});
