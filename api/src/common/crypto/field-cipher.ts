import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * 通用字段加密（阶段 5j）。
 *
 * ⚠️ **格式与 `modules/auth/token.util.ts` 的 `encryptToken` 同款**：
 *    `base64url( iv(12) || authTag(16) || ciphertext )`，AES-256-GCM。
 *    同款是为了让全仓只有一种密文形状，读起来不用切换心智模型。
 *
 * ⚠️ **但失败语义相反 —— 这是刻意的**：
 *    `decryptToken` 失败返回 `null`（令牌本来就可能失效，调用方走「重新登录」）；
 *    **账目密文解密失败是异常**（密文损坏 / 密钥配错 / 数据没迁移），
 *    必须响亮地失败 —— 静默返回空值会让打款带着空账号去渠道，
 *    **钱打不出去且没人知道为什么**。
 */

/** 派生密钥的长度（AES-256 要 32 字节） */
const FIELD_KEY_BYTES = 32;

/** 加密 iv 的长度（GCM 推荐 12 字节） */
const FIELD_IV_BYTES = 12;

/** GCM 认证标签的长度 */
const FIELD_TAG_BYTES = 16;

/** HKDF 的 salt：与 info 一起把密钥的用途区分开 */
const FIELD_HKDF_SALT = 'multi-tenant-ecommerce-saas';

/**
 * HKDF 的 info：标识这把密钥的用途，换用途就要换 info。
 *
 * ⚠️ **不能与 `token.util.ts` 的 `refresh-token-grace-v1` 相同**：
 *    相同的话两处密文可以互相冒充。
 */
const FIELD_HKDF_INFO = 'payout-account-encryption-v1';

/**
 * 从环境变量里的密钥派生 AES 密钥。
 *
 * ⚠️ **派生而不是直接用**：环境变量是任意长度的字符串，
 *    AES-256 要正好 32 字节。
 */
export function deriveFieldKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(FIELD_HKDF_SALT, 'utf8'),
      Buffer.from(FIELD_HKDF_INFO, 'utf8'),
      FIELD_KEY_BYTES,
    ),
  );
}

/**
 * 加密一个字段，返回可落库的密文。
 *
 * ⚠️ **每次用随机 iv** —— 同一个明文加密两次的密文必须不同，
 * 否则「密文相同 ⇒ 明文相同」就成了可用的判据。
 */
export function encryptField(plaintext: string, key: Buffer): string {
  const iv = randomBytes(FIELD_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64url',
  );
}

/**
 * 解密一个字段。
 *
 * ⚠️ **失败一律抛错，绝不返回 null** —— 见文件头的说明。
 */
export function decryptField(ciphertext: string, key: Buffer): string {
  const raw = Buffer.from(ciphertext, 'base64url');
  if (raw.length < FIELD_IV_BYTES + FIELD_TAG_BYTES) {
    throw new Error('密文格式不对：长度不足');
  }
  const iv = raw.subarray(0, FIELD_IV_BYTES);
  const tag = raw.subarray(FIELD_IV_BYTES, FIELD_IV_BYTES + FIELD_TAG_BYTES);
  const body = raw.subarray(FIELD_IV_BYTES + FIELD_TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      'utf8',
    );
  } catch (error) {
    // ⚠️ **GCM 认证失败在数学上无法区分「密钥不对」与「密文被篡改」** ——
    //    两种情况下都是认证标签对不上。
    //    这里只把 OpenSSL 的英文原文换成能指向排查方向的中文，
    //    原始 message 一并附上，别把线索丢了。
    //    ⚠️ **不要在这里「猜」是哪种原因** —— 声称能区分就是骗人，
    //    运维会被引到错误的方向上去。
    throw new Error(
      `密文解密失败（密钥不匹配，或密文已被篡改）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
