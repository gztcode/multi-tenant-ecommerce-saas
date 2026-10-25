import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置（Vitest）。
 *
 * 覆盖纯函数、Route Handler 与 React 组件渲染测试。
 *
 * ⚠️ **全局环境保持 node**，组件测试在自己的文件里用
 * `// @vitest-environment jsdom` 逐文件切换——逐文件的注释优先于全局配置。
 */
export default defineConfig({
  // ⚠️ **必须加这个**，否则所有组件测试报 `React is not defined`。
  //
  // 本项目的 tsconfig.json 第 14 行是 `"jsx": "preserve"`（Next.js 用 SWC），
  // 而 **esbuild 不读 tsconfig 的 jsx 设置**——它默认走 classic transform，
  // 把 JSX 编译成 `React.createElement(...)`，测试文件里没有 import React
  // → ReferenceError: React is not defined。
  //
  // ⚠️ **`esbuild` 必须写在配置的根级，不能写在 `test` 下面**
  // （esbuild 是 Vite 的根级选项，写在 test 下不生效）。实测确认。
  esbuild: { jsx: 'automatic' },
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
    // ⚠️ **保持 `node`**。既有 Route Handler 测试与纯函数测试根本不需要
    // 浏览器环境（Node 18+ 原生支持 Web 标准的 Request / Response），
    // 改全局环境收益为零、风险是全部回归。
    // 组件测试在自己的文件里用 `// @vitest-environment jsdom` 切过去——
    // 实测：逐文件的环境注释**优先于全局配置**。
    environment: 'node',
    // ⚠️ 扩到 .tsx：组件测试文件是 .tsx。
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
