import { Injectable } from '@nestjs/common';

import {
  decryptField,
  deriveFieldKey,
  encryptField,
} from '../../common/crypto/field-cipher';

/**
 * 收款账户的字段加密（阶段 5j）。
 *
 * ⚠️ **这是全仓唯一能拿到「完整明文账号」的服务** ——
 *    展示路径一律用预存的掩码串（不解密），打款路径才解密。
 *    「唯一」靠纪律与 review 保证，不是靠类型系统（TS 拦不住调用方）。
 *
 * ⚠️ **密钥只在进程内存里**，不落盘、不进日志、不进 API 响应。
 */
@Injectable()
export class PayoutCipherService {
  private readonly key: Buffer;

  constructor() {
    const secret = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY ?? '';
    // ⚠️ **启动时已经校验过**（`assertPayoutEncryptionKey`），
    //    这里再兜一层：万一这个服务被别的上下文单独 new 出来，
    //    不能拿着空密钥继续跑。
    if (secret.length < 32) {
      throw new Error(
        'PAYOUT_ACCOUNT_ENCRYPTION_KEY 未配置或长度不足 32 个字符',
      );
    }
    this.key = deriveFieldKey(secret);
  }

  /** 明文 → 密文 */
  encrypt(plaintext: string): string {
    return encryptField(plaintext, this.key);
  }

  /**
   * 密文 → 明文。**不查版本号**。
   *
   * ⚠️ **生产路径应该用 `decryptVersioned`** —— 这一条不检查「这行到底加密过没有」，
   *    用在没迁移的行上会直接抛「密文格式不对」，看不出真正的原因。
   *    保留它是因为测试与离线工具需要「拿到密文就解」的直白语义。
   *
   * ⚠️ **失败一律抛错**（底层 `decryptField` 的语义），绝不返回空串。
   */
  decrypt(ciphertext: string): string {
    return decryptField(ciphertext, this.key);
  }

  /**
   * 读一行密文 → 明文，**并检查版本号**。
   *
   * ⚠️ **版本号不对就抛错，绝不按明文兜底** ——
   *    「忘了迁移」若被静默当成「就是明文」，就等于把加密悄悄关掉了。
   *
   * ⚠️ **「未加密」与「不认识这个版本」是两回事，文案要分开**：
   *    版本 0 是「还没迁移」（跑一次脚本就好）；版本 2 是「本进程解不了它」
   *    （换过算法），让它去跑迁移脚本是误导。
   *
   * @param version 该行的加密版本（0 = 尚未加密）
   * @param what    出错文案里指明是哪张表的哪一列
   */
  decryptVersioned(ciphertext: string, version: number, what: string): string {
    if (version === 0) {
      throw new Error(
        `${what} 尚未加密（版本 0），` +
          '请先执行 `npm run migrate:payout-encryption` 再重试。',
      );
    }
    if (version !== 1) {
      throw new Error(
        `${what} 的加密版本是 ${version}，本进程只认版本 1 —— ` +
          '请检查应用版本与迁移脚本是否配套。',
      );
    }
    return this.decrypt(ciphertext);
  }
}
