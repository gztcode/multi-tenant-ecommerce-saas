import {
  isPlatformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TenantScopeError } from '../../common/tenant/tenant-scope.error';
import { PayoutCipherService } from './payout-cipher.service';
import { PayoutEncryptionSelfCheck } from './payout-encryption-self-check.service';

/**
 * 账目加密自检的单元测试。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `payout-execution.service.spec.ts` 同款）：
 *    真实行为（租户作用域怎么附加）靠 e2e 验。
 */

/**
 * ⚠️ **模拟租户扩展的作用域闸** ——
 *    真实的 `TenantPrismaService` 在**没有租户上下文**时是**抛
 *    `TenantScopeError`**，不是「查不到行」
 *    （`tenant-prisma.service.ts` 的 `resolveScope`）。
 *
 *    ⚠️ **假 Prisma 必须复刻这一点** —— 否则自检单测就感知不到
 *    「作用域有没有被包住」：把自检里的 `tenantContext.run(platformScope(), ...)`
 *    去掉，测试照样绿（失败注入 G4 实测过）。
 */
function assertPlatformScope(): void {
  if (!isPlatformScope(tenantContext.getStore())) {
    throw new TenantScopeError(
      '模型 MerchantPayoutAccount 是租户作用域的，但当前请求没有租户上下文，拒绝访问',
    );
  }
}

/** 一只最小可用的假 Prisma */
function fakePrisma(
  options: {
    account?: unknown;
    payout?: unknown;
  } = {},
) {
  return {
    merchantPayoutAccount: {
      findFirst: jest.fn(() => {
        assertPlatformScope();
        return Promise.resolve(
          options.account === undefined ? null : options.account,
        );
      }),
    },
    payout: {
      findFirst: jest.fn(() => {
        assertPlatformScope();
        return Promise.resolve(
          options.payout === undefined ? null : options.payout,
        );
      }),
    },
  };
}

/**
 * ⚠️ **单元测试进程里没有 .env** —— `PayoutCipherService` 在构造时就要密钥，
 *    拿不到就直接抛错。所以这里显式设一个**测试用**密钥。
 */
const TEST_ENCRYPTION_KEY = 'test-payout-encryption-key-at-least-32-chars';

beforeAll(() => {
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

describe('PayoutEncryptionSelfCheck', () => {
  it('库里没有可校验的行 → 不抛错（新库不该因此起不来）', async () => {
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma() as unknown as never,
      new PayoutCipherService(),
    );

    await expect(service.check()).resolves.toBeUndefined();
  });

  it('密文解得开 → 不抛错', async () => {
    const cipher = new PayoutCipherService();
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: {
          id: 'acc-1',
          accountNoCipher: cipher.encrypt('6222000000000000'),
        },
      }) as unknown as never,
      cipher,
    );

    await expect(service.check()).resolves.toBeUndefined();
  });

  it('⚠️ 密文是空串 → 抛错（空串是迁移留下的占位，不是「跳过」）', async () => {
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: { id: 'acc-1', accountNoCipher: '' },
      }) as unknown as never,
      new PayoutCipherService(),
    );

    await expect(service.check()).rejects.toThrow(/空串/);
  });

  it('⚠️ 密文解不开 → 抛错，且消息指明「哪张表」与「检查哪个环境变量」', async () => {
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: { id: 'acc-1', accountNoCipher: '这不是合法的密文' },
      }) as unknown as never,
      new PayoutCipherService(),
    );

    // ⚠️ **只断言「抛错」是没有牙齿的** —— 必须断言消息里说了什么，
    //    否则实施者把错误吞掉也算过
    await expect(service.check()).rejects.toThrow(/账目加密自检失败/);
    await expect(service.check()).rejects.toThrow(
      /PAYOUT_ACCOUNT_ENCRYPTION_KEY/,
    );
    await expect(service.check()).rejects.toThrow(/商家收款账户/);
  });

  it('⚠️ 账户行能解但快照行解不开 → 也要抛错（两张表都要查，不能早退）', async () => {
    // ⚠️ **这条是补一个真缺陷的牙齿** —— 原实现查到账户行就 `return`，
    //    出款快照表**永远查不到** → 「账户行用密钥 A、快照用密钥 B」
    //    的情形（5j 的失败注入 F11 实测过迁移脚本会用错密钥加密部分行）
    //    会被自检放过 → 容器照常起来 → 每张出款单都落 FAILED。
    const cipher = new PayoutCipherService();
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: {
          id: 'acc-1',
          accountNoCipher: cipher.encrypt('6222000000000000'),
        },
        payout: {
          id: 'payout-1',
          snapshotAccountNoCipher: '这不是合法的密文',
        },
      }) as unknown as never,
      cipher,
    );

    await expect(service.check()).rejects.toThrow(/账目加密自检失败/);
    // ⚠️ **消息要指明是哪张表** —— 运营才知道该查哪张
    await expect(service.check()).rejects.toThrow(/出款单收款账号快照/);
  });
});
