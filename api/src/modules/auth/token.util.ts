import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/** 刷新令牌随机字节数：base64url 编码后约 40 字符，远超熵下限 */
const REFRESH_TOKEN_BYTES = 30;

/**
 * 生成一次性刷新令牌（明文，只在登录/刷新时返回给客户端）。
 *
 * 用 30 字节（240 bit）随机数而非 UUID：UUID v4 只有 122 bit 有效熵，
 * 而这里的令牌是唯一凭证、没有服务端二次校验，可预测性必须做到最低。
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * 刷新令牌的落库形态。
 *
 * 数据库里只存 sha256 摘要而不是明文：RefreshToken 表经常被备份与只读分析，
 * 明文令牌一旦泄漏即可直接换取访问令牌；存摘要后，泄漏的只是哈希，
 * 无法反推（令牌本身是高熵随机数，无字典攻击面）。
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 刷新令牌的宽限期（毫秒）—— 60 秒。
 *
 * ⚠️ **导出**：e2e 要用它算「宽限截止时刻」，测试与服务端共用同一个常量，
 * 不会出现「测试里写死 60 秒、代码里改成 30 秒」这种漂移。
 *
 * ⚠️ **为什么是 60 秒**：要覆盖客户端超时（10–30 秒）+ 重试退避；
 * 同时对「令牌泄漏」的封窗仍然很短（从永久缩到 60 秒）。
 * ⚠️ **不因重放而延长** —— 延长等于给泄漏的令牌开更大的口子。
 */
export const REFRESH_GRACE_PERIOD_MS = 60_000;

/** 宽限记录用的加密密钥长度（AES-256 要 32 字节） */
const GRACE_KEY_BYTES = 32;

/** 加密 iv 的长度（GCM 推荐 12 字节） */
const GRACE_IV_BYTES = 12;

/** GCM 认证标签的长度 */
const GRACE_TAG_BYTES = 16;

/** HKDF 的 salt：与 info 一起把密钥的用途区分开 */
const GRACE_HKDF_SALT = 'multi-tenant-ecommerce-saas';

/** HKDF 的 info：标识这把密钥的用途，换用途就要换 info */
const GRACE_HKDF_INFO = 'refresh-token-grace-v1';

/**
 * 从 `JWT_SECRET` 派生宽限记录用的加密密钥。
 *
 * ⚠️ **为什么派生而不是新增一个环境变量**：
 * - 不给部署增加「必须配置、漏了就启动失败」的东西（那会 breaking）
 * - `JWT_SECRET` 已经被 `assertSecureConfig()` 强制校验（≥ 32 字符、
 *   生产环境禁用占位符），派生密钥自动继承这份保护
 * - **职责分离**：派生出的密钥与 JWT 签名密钥用途不同，
 *   即使同源，密文也不能冒充 JWT
 *
 * ⚠️ **派生密钥只存在于进程内存**，不落盘、不进日志。
 *
 * ⚠️ **代价**：`JWT_SECRET` 轮换后旧的宽限密文解不开 → 那些令牌走超期分支
 * → 吊销全族。但换 `JWT_SECRET` 本来就会让所有 JWT 失效、所有人重新登录，
 * 所以这个连带影响**不新增任何实际损失**。
 */
export function deriveGraceKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(GRACE_HKDF_SALT, 'utf8'),
      Buffer.from(GRACE_HKDF_INFO, 'utf8'),
      GRACE_KEY_BYTES,
    ),
  );
}

/**
 * 加密一枚令牌，返回可落库的密文。
 *
 * 格式：`base64url( iv(12) || authTag(16) || ciphertext )`
 *
 * ⚠️ **用 AES-256-GCM**（带认证标签）：密文被篡改时解密会失败，
 * 而不是悄悄解出一段垃圾。
 * ⚠️ **每次用随机 iv** —— 同一个明文加密两次的密文必须不同，
 * 否则「密文相同 ⇒ 明文相同」就成了可用的判据。
 */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(GRACE_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64url',
  );
}

/**
 * 解密一枚宽限记录里的令牌。
 *
 * ⚠️ **解密失败一律返回 `null`，绝不抛错**：调用方要把它当成
 * 「宽限期不可用」→ 走超期分支（吊销全族 + 401），
 * **不能**把 `null` 当成令牌返回给客户端。
 *
 * 失败覆盖三种情况：密钥被换、密文被改、密文格式损坏。
 */
export function decryptToken(payload: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(payload, 'base64url');
    if (raw.length < GRACE_IV_BYTES + GRACE_TAG_BYTES) return null;
    const iv = raw.subarray(0, GRACE_IV_BYTES);
    const tag = raw.subarray(GRACE_IV_BYTES, GRACE_IV_BYTES + GRACE_TAG_BYTES);
    const ciphertext = raw.subarray(GRACE_IV_BYTES + GRACE_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
