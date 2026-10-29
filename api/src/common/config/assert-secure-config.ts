const PLACEHOLDER_SECRET = 'change-me-in-production-at-least-32-chars-long';

/**
 * 启动时的配置安全断言。
 *
 * `JWT_SECRET` 的占位符长度（46 字节）远超 HS256 要求的 256 bit，argon2 与
 * Prisma 都不会对它报错——但它「看起来像一个合理的值」，没有任何机制阻止它被
 * 原样带进生产。一旦泄露，任何人都能用它自行签发任意租户、任意角色的令牌。
 * 因此必须在创建 Nest 应用**之前**硬失败：那时还没有任何连接与监听，
 * 不会留下半启动的进程。
 */
export function assertSecureConfig(): void {
  const secret = process.env.JWT_SECRET ?? '';

  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET 至少需要 32 个字符，当前只有 ${secret.length} 个。` +
        '请设置一个足够随机的密钥（可用 `openssl rand -base64 48` 生成）。',
    );
  }

  if (process.env.NODE_ENV === 'production' && secret === PLACEHOLDER_SECRET) {
    throw new Error(
      '生产环境禁止使用 .env.example 里的 JWT_SECRET 占位符，请换成真实密钥。',
    );
  }

  // ⚠️ 假支付网关在生产环境开启 = 任何人知道 paymentId 就能免费下单（R3）。
  //
  // 假网关的支付页面**无需登录**——知道 paymentId 就能把订单付掉。
  // 所以这个开关在生产环境必须**拒绝启动**，而不是「配错了就那样吧」。
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FAKE_PAYMENT_ENABLED === 'true'
  ) {
    throw new Error(
      '生产环境禁止启用 FAKE_PAYMENT_ENABLED：假支付网关无需登录即可支付订单。',
    );
  }

  // ⚠️ 假出款网关在生产环境开启 = 平台能让「打款失败」（阶段 5h-2）。
  //
  // 与假支付网关**分成两条**：用同一个开关的话，开着假支付就等于
  // 同时开着假出款，两个环境的启停会互相牵连。
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FAKE_PAYOUT_ENABLED === 'true'
  ) {
    throw new Error(
      '生产环境禁止启用 FAKE_PAYOUT_ENABLED：假出款网关能让出款失败。',
    );
  }
}
