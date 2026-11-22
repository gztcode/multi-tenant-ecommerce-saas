import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 产物：构建时 Next.js 会把运行期真正用到的依赖与 server.js
  // 收敛进 .next/standalone，容器镜像不必携带完整 node_modules。
  output: 'standalone',
  transpilePackages: ['@ecom/frontend-shared'],
  // ⚠️ 原来这里有一段 `webpack` 配置把 `vitest` 推进 externals，防止
  // next build 去编译顶层 test/。Next.js 16 起 Turbopack 是默认打包器，
  // 留着 `webpack` 配置会直接让构建失败（Turbopack 不读它）；测试目录本来
  // 就在 src/ 之外、进不了构建图，所以这段配置已删除。
};

export default nextConfig;
