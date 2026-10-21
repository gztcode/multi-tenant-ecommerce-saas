import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 产物：构建时 Next.js 会把运行期真正用到的依赖与 server.js
  // 收敛进 .next/standalone，容器镜像不必携带完整 node_modules。
  output: 'standalone',
};

export default nextConfig;
