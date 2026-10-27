import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置（Vitest）。
 *
 * 测三类东西：
 * 1. **Route Handler**——Next.js 的 Route Handler 就是普通导出函数
 *    （`export async function POST(request: Request)`），可以直接 import 并调用，
 *    传一个 `new Request(url, { method, body })` 就能拿到返回的 Response。
 *    不需要起服务器，也不需要 jsdom。
 * 2. **纯函数**——例如 lib/money.ts 的金额换算。
 * 3. **React 组件渲染**——需要 jsdom + React Testing Library。
 *    组件测试在自己的文件里用 `// @vitest-environment jsdom` 逐文件切换
 *    （逐文件的环境注释优先于全局配置），所以这里的全局环境保持 `node`。
 */
export default defineConfig({
  // ⚠️ **必须加这个**，否则所有组件测试报 `React is not defined`。
  //
  // 本项目的 tsconfig.json 是 `"jsx": "preserve"`（Next.js 用 SWC），
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
      // 被测路由虽然 mock 掉了 '@/auth'（不让真代码被加载），
      // 但只要依赖图里任何一处仍然引用到 server-only，就会炸。
      // 这里把它指向一个空模块兜底。
      'server-only': fileURLToPath(
        new URL('./test/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  test: {
    // node 环境即可：Route Handler 用的是 Web 标准的 Request / Response，
    // Node 18+ 原生支持，不需要 jsdom。
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
