import { PayoutCipherService } from './payout-cipher.service';

/**
 * 收款账户字段加密服务的单测（阶段 5j 补强）。
 *
 * ⚠️ **为什么这个文件必须存在**：`decryptVersioned` 里有三条分支
 *    （版本 0 / 版本 1 / 不认识的版本），但全仓只有 `payout-execution.service.spec.ts`
 *    里的**一条**用例间接覆盖「版本 0 → 抛错」。那条用例一旦被删或改名，
 *    「版本 0 按明文兜底」这个致命变异就会**静默通过** ——
 *    而那个变异等于把加密悄悄关掉了。
 *
 * ⚠️ **这里只测这一个服务**：不碰 Prisma、不碰租户上下文。
 *    `encrypt` / `decrypt` 是纯函数式的（密钥来自构造时的环境变量），
 *    所以单元测试完全够。
 */

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

/** 用当前测试密钥造一个服务 */
function makeService(): PayoutCipherService {
  return new PayoutCipherService();
}

describe('PayoutCipherService：加解密往返', () => {
  it('明文加密后能原样解回来', () => {
    const service = makeService();
    const plain = '6222000000000000';

    expect(service.decrypt(service.encrypt(plain))).toBe(plain);
  });

  it('⚠️ 同一明文两次加密的密文不同（随机 iv）', () => {
    const service = makeService();

    expect(service.encrypt('6222000000000000')).not.toBe(
      service.encrypt('6222000000000000'),
    );
  });
});

describe('PayoutCipherService：解密失败一律抛错', () => {
  it('⚠️ 密文被篡改 → 抛错（绝不返回空串或 null）', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');
    const raw = Buffer.from(cipher, 'base64url');
    raw[raw.length - 1] ^= 0xff;

    expect(() => service.decrypt(raw.toString('base64url'))).toThrow();
  });

  it('⚠️ 密钥不对 → 抛错', () => {
    // ⚠️ **不改 `process.env`**：用同一把 key 加密，再用**另一把** key 解密。
    //    改环境变量的话，构造出来的服务可能压根不是同一把钥匙，
    //    测的就不是「密钥不对」而是「服务被换掉了」。
    const cipher = makeService().encrypt('6222000000000000');

    const original = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY =
      'another-payout-encryption-key-32-chars';
    try {
      expect(() => makeService().decrypt(cipher)).toThrow();
    } finally {
      process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = original;
    }
  });

  it('⚠️ 密文根本不是密文 → 抛错', () => {
    const service = makeService();

    expect(() => service.decrypt('这不是密文')).toThrow();
  });
});

describe('PayoutCipherService：decryptVersioned 的版本分支', () => {
  it('⚠️ 版本 0（尚未加密）→ 抛错，绝不按明文兜底', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');

    expect(() =>
      service.decryptVersioned(cipher, 0, '收款账户的账号'),
    ).toThrow();
  });

  it('⚠️ 版本 0 的报错文案要指向迁移脚本（运维照着就能修）', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');

    expect(() => service.decryptVersioned(cipher, 0, '收款账户的账号')).toThrow(
      /尚未加密/,
    );
    expect(() => service.decryptVersioned(cipher, 0, '收款账户的账号')).toThrow(
      /migrate:payout-encryption/,
    );
  });

  it('版本 1 → 正常解出明文', () => {
    const service = makeService();
    const plain = '6222000000000000';
    const cipher = service.encrypt(plain);

    expect(service.decryptVersioned(cipher, 1, '收款账户的账号')).toBe(plain);
  });

  it('⚠️ 不认识的版本（2）→ 抛错', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');

    expect(() =>
      service.decryptVersioned(cipher, 2, '收款账户的账号'),
    ).toThrow();
  });

  it('⚠️ 不认识的版本（2）的文案说「只认版本 1」，不能说「尚未加密」', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');

    let message = '';
    try {
      service.decryptVersioned(cipher, 2, '收款账户的账号');
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    expect(message).toContain('只认版本 1');
    // ⚠️ **版本 2 是「本进程解不了它」，不是「还没迁移」** ——
    //    把它说成「尚未加密」会让运维去跑迁移脚本，白跑一趟。
    expect(message).not.toContain('尚未加密');
  });

  it('⚠️ 「未加密」与「不认识」是两条不同的分支（错误文案不同）', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');

    const grab = (version: number): string => {
      try {
        service.decryptVersioned(cipher, version, '收款账户的账号');
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
      throw new Error(`版本 ${version} 本该抛错，却没有`);
    };

    const notEncrypted = grab(0);
    const unknownVersion = grab(2);

    expect(notEncrypted).not.toBe(unknownVersion);
    expect(notEncrypted).toContain('尚未加密');
    expect(unknownVersion).toContain('只认版本 1');
  });

  it('⚠️ 报错文案里带 `what`（运维要靠它知道是哪张表的哪一列坏了）', () => {
    const service = makeService();
    const cipher = service.encrypt('6222000000000000');

    expect(() =>
      service.decryptVersioned(cipher, 0, '出款单快照的账号'),
    ).toThrow(/出款单快照的账号/);
    expect(() =>
      service.decryptVersioned(cipher, 2, '出款单快照的账号'),
    ).toThrow(/出款单快照的账号/);
  });
});
