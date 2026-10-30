import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PayoutCipherService } from './payout-cipher.service';

/**
 * 启动时的账目加密自检（阶段 5k）。
 *
 * ⚠️ **每张表只取一行，不扫全表** —— 阶段 5j 明确否决过「启动时全表扫描自检」
 *    （每次启动把所有行拉出来解密一遍，太贵）。
 *
 * ⚠️ **失败即退出** —— 带着解不开的密文跑着，运营看到的全是失败的出款单，
 *    没人知道根因在启动时就该发现。数据坏了就不该带着跑。
 */
@Injectable()
export class PayoutEncryptionSelfCheck {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
  ) {}

  /**
   * 启动自检：拿两张表里**各一行**已加密的数据试解一次。
   *
   * ⚠️ **只校验 `encryptionVersion = 1` 的行** —— 版本 0 的行还没迁移，
   *    本来就解不开，不能因为它就让容器起不来。
   */
  async check(): Promise<void> {
    await tenantContext.run(platformScope(), async () => {
      // ⚠️ **两张表都要查，查完不早退** ——
      //    早退（查到账户行就 `return`）会漏掉「账户行用密钥 A、
      //    出款快照用密钥 B」的情形 —— 那种情况下账户行能解开、
      //    快照解不开 → 自检通过 → 容器照常起来 → 每一张出款单都落
      //    `FAILED`，运营只能翻日志反推（5j 的失败注入 F11 实测过
      //    「迁移脚本用错密钥加密了部分行」）。
      //
      // ⚠️ **条件只用版本号** —— 版本号是「这行加密过没有」的权威依据
      //    （5j 设计 §2 的原则：不能靠「能不能解密」去猜）。
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: { encryptionVersion: 1 },
        select: { id: true, accountNoCipher: true },
      });
      if (account) {
        this.tryDecrypt(account.accountNoCipher, '商家收款账户');
      }

      // ⚠️ **可空列必须用 `not: null`，不能用 `not: ''`** ——
      //    `snapshotAccountNoCipher` 是 `String?`（schema.prisma:1298），
      //    而 PostgreSQL 里 `col <> ''` 对 NULL 求值为 NULL（非 true）
      //    → `{ not: '' }` 会把 NULL 行一起排除，行为依赖 Prisma 版本，
      //    不该依赖。`not: null` 的语义是明确的。
      const payout = await this.prisma.payout.findFirst({
        where: {
          snapshotEncryptionVersion: 1,
          snapshotAccountNoCipher: { not: null },
        },
        select: { id: true, snapshotAccountNoCipher: true },
      });
      if (payout) {
        this.tryDecrypt(
          payout.snapshotAccountNoCipher as string,
          '出款单收款账号快照',
        );
      }
      // ⚠️ **两处都没有可校验的行 → 静默通过**：
      //    新库、或还没跑迁移的库（全是版本 0）都不该因此起不来。
    });
  }

  /**
   * 解一行；解不开就抛错让进程退出。
   *
   * ⚠️ **空串是脏数据，不是「跳过」** ——
   *    `accountNoCipher` 是 NOT NULL 列，空串只可能是迁移脚本留下的占位。
   *    跳过它就等于放过「正是自检要防的那种坏数据」。
   */
  private tryDecrypt(ciphertext: string, what: string): void {
    if (!ciphertext) {
      throw new Error(
        `账目加密自检失败：${what} 的密文是空串（迁移留下的占位或脏数据）。` +
          '请检查该数据是否已被 npm run migrate:payout-encryption 正确处理。',
      );
    }
    try {
      this.cipher.decryptVersioned(ciphertext, 1, what);
    } catch (error) {
      throw new Error(
        `账目加密自检失败：${what} 解不开（${
          error instanceof Error ? error.message : String(error)
        }）。` +
          '请检查 PAYOUT_ACCOUNT_ENCRYPTION_KEY 是否与加密时用的密钥一致' +
          '（本地 .env 与 infra/docker-compose.yml 必须逐字相同）。',
      );
    }
  }
}
