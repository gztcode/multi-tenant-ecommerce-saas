import type { NextConfig } from "next";

/**
 * 后端的 base URL（含 `/api/v1` 前缀），只给下面的 dev/e2e 转发用。
 *
 * ⚠️ **在 `rewrites()` 里读**，不在模块顶层固化：配置改坏时测试能直接
 * 断言「destination 跟着 `API_BASE_URL` 走」，也让 dev server 的热重载
 * 读到新值。
 */
const DEFAULT_API_BASE_URL = 'http://localhost:3000/api/v1';

/** 假网关路径（支付中转返回的根相对 payUrl 就落在这里） */
const FAKE_GATEWAY_SOURCE = '/api/v1/pay/fake/:path*';

/**
 * dev / e2e 形态下的「网关替身」。
 *
 * 生产形态里，店铺子域名下的 `/api/v1/` 由 nginx 的 `location /api/v1/`
 * 直接转发给 api，请求根本到不了 storefront。但本机 `npm run dev`
 * （api:3000 + storefront:3001）与 browser e2e（api:3100 + storefront:3001）
 * 前面都没有网关：支付中转返回的 payUrl 是**根相对**的
 * `/api/v1/pay/fake/:paymentId`，浏览器按当前 origin 解析后会打到
 * storefront，没有这条 rewrite 就是 Next 的 404。
 *
 * ⚠️ **只匹配假网关路径**，不要扩成 `/api/v1/:path*`：那会让 storefront
 * 变成通用 API 后门，绕过「浏览器写操作走 BFF 白名单」的约定。
 * ⚠️ **生产构建里不生成**（`next build` 时 `NODE_ENV=production`）：
 * standalone 产物里 rewrite 的 destination 是构建期固化的，生产又用不到它，
 * 留着只会变成僵尸配置；构建机没有 `API_BASE_URL` 时还会拼出无效地址。
 */
const devOnlyRewrites: Pick<NextConfig, 'rewrites'> =
  process.env.NODE_ENV === 'production'
    ? {}
    : {
        async rewrites() {
          // 显式兜底，绝不把 `undefined` 拼进 destination（Next 不会报错，
          // 只会在请求时静默失败）。尾斜杠去掉，避免 `//pay/fake`。
          const base = (
            process.env.API_BASE_URL || DEFAULT_API_BASE_URL
          ).replace(/\/+$/, '');
          return [
            {
              source: FAKE_GATEWAY_SOURCE,
              destination: `${base}/pay/fake/:path*`,
            },
          ];
        },
      };

const nextConfig: NextConfig = {
  // standalone 产物：构建时 Next.js 会把运行期真正用到的依赖与 server.js
  // 收敛进 .next/standalone，容器镜像不必携带完整 node_modules。
  output: 'standalone',
  transpilePackages: ['@ecom/frontend-shared'],
  ...devOnlyRewrites,
  // ⚠️ 原来这里有一段 `webpack` 配置把 `vitest` 推进 externals，防止
  // next build 去编译顶层 test/。Next.js 16 起 Turbopack 是默认打包器，
  // 留着 `webpack` 配置会直接让构建失败（Turbopack 不读它）；测试目录本来
  // 就在 src/ 之外、进不了构建图，所以这段配置已删除。
};

export default nextConfig;
