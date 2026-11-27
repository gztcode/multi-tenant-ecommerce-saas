/**
 * 浏览器 e2e 的固定端口与演示账号。
 *
 * `playwright.config.ts` 与各 spec 都从这里读，避免「配置里一个端口、
 * 用例里另一个端口」——那种错在本地 `reuseExistingServer` 下会被掩盖，
 * 到了 CI 才变成连不上的超时。
 */

export const API_PORT = 3100;
export const STOREFRONT_PORT = 3001;
export const MERCHANT_ADMIN_PORT = 3002;

/** 独立库，见 playwright.config.ts 顶部说明 */
export const DATABASE_URL =
  'postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_browser?schema=public';

export const API_BASE_URL = `http://localhost:${API_PORT}/api/v1`;
export const STOREFRONT_URL = `http://localhost:${STOREFRONT_PORT}`;
export const MERCHANT_ADMIN_URL = `http://localhost:${MERCHANT_ADMIN_PORT}`;

/**
 * 两个前端 NextAuth 的会话加密密钥（本机 e2e 专用值，不是生产凭据）。
 *
 * ⚠️ **单源在这里**：`playwright.config.ts` 给两个前端注入它，
 * spec 里解会话 cookie 也用它 —— 三处各写一份的话，改了配置而忘了 spec，
 * 解密会静默失败（拿到 `null`），用例看起来「通过了」其实什么都没验证。
 *
 * 会话 cookie 是 JWE（加密，不是签名），不拿这把密钥连 `refreshToken` 都读不出来。
 */
export const AUTH_SECRET =
  process.env.AUTH_SECRET ?? 'browser-e2e-auth-secret-0123456789';

/**
 * 与 `api/prisma/seed.ts` 的演示数据一一对应。
 *
 * ⚠️ 改 seed 里的账号/密码时这里要一起改：浏览器 e2e 不通过接口造账号，
 * 直接登录 seed 建好的示例商家与示例消费者。
 */
export const DEMO = {
  customerEmail: 'customer@demo.platform.test',
  customerPassword: 'Demo12345!',
  merchantEmail: 'owner@demo.platform.test',
  merchantPassword: 'Demo12345!',
} as const;
