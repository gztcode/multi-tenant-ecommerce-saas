import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 产物：构建时 Next.js 会把运行期真正用到的依赖与 server.js
  // 收敛进 .next/standalone，容器镜像不必携带完整 node_modules。
  output: 'standalone',
  // 单元测试不属于应用代码，next build 不应该编译它们
  //（否则会报「页面里不能用 vitest」之类的错）。
  // 测试放在顶层 test/ 目录（src 之外），这里再加一道显式排除兜底。
  webpack: (config) => {
    config.externals.push('vitest');
    return config;
  },
};

export default nextConfig;
