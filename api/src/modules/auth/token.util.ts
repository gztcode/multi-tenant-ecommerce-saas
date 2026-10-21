import { createHash, randomBytes } from 'node:crypto';

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
