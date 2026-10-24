import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置（Vitest）。
 *
 * 只测纯函数——目前是 lib/theme.ts 的 buildThemeCss（主题 token 的键名白名单）。
 *
 * ⚠️ 不测 React 组件渲染：那需要 jsdom + React Testing Library，
 * 是另一个成本量级的事，本轮明确不做。
 */
export default defineConfig({
  resolve: {
    alias: {
      // 与 tsconfig.json 的 paths 对齐：`@/` 指向 `src/`
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // next-auth 会间接 import 'server-only'，那是个只在 Next 编译期有意义的
      // 标记模块，在 node 环境下直接 import 会抛错。
      'server-only': fileURLToPath(
        new URL('./test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
