import type { HelmetOptions } from 'helmet';

/**
 * 全局安全响应头配置。
 *
 * 抽成常量是为了让 e2e 能复刻生产配置——e2e 用 `Test.createTestingModule`
 * 自建实例，**不走 `main.ts` 的 `bootstrap()`**，写在 `main.ts` 里的
 * `app.use(helmet(...))` 在 e2e 中根本不执行，测不到。
 *
 * 本服务只返回 JSON（唯一的 HTML 是 Swagger UI 与假支付页），
 * 所以真正起作用的是下面三项：
 * - `x-content-type-options`：禁止浏览器猜 MIME（防把 JSON 当脚本执行）
 * - `referrer-policy`：跨站时不泄漏路径
 * - `x-frame-options`：禁止被第三方 iframe 嵌套（点击劫持）
 *
 * HSTS **必须在这里关掉**：helmet 8 的默认值是 `max-age=31536000; includeSubDomains`
 * （一年 + 全部子域），而 `infra/nginx/templates/prod.conf.template` 特意用的是
 * `max-age=300` —— 上线初期不敢锁一年，先短值观察。两层都发的话浏览器会收到
 * **两个** `Strict-Transport-Security` 头，且应用层那个一年期的会盖掉运维刻意设的短值
 * （一旦有子域还没上 HTTPS，一年内整个域名连不回来）。
 * 应用层也看不到真实的外部协议（它只看到 Nginx 转发来的 http），本就不该判这个。
 *
 * ⚠️ **CSP 显式关掉**：helmet 默认的 `script-src 'self'` 会拦掉 Swagger UI
 *    的内联脚本，`/api/docs` 直接白屏。对 JSON 响应而言 CSP 本来也没有意义。
 */
export const SECURITY_HEADERS_OPTIONS: HelmetOptions = {
  contentSecurityPolicy: false,
  strictTransportSecurity: false,
};
