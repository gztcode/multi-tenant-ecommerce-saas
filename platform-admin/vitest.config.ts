import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置（Vitest）。
 *
 * 只测两类东西：
 * 1. **Route Handler**——Next.js 的 Route Handler 就是普通导出函数
 *    （`export async function POST(request: Request)`），可以直接 import 并调用，
 *    传一个 `new Request(url, { method, body })` 就能拿到返回的 Response。
 *    不需要起服务器，也不需要 jsdom。
 * 2. **纯函数**——例如 lib/billing.ts 的 formatCommissionRate。
 *
 * ⚠️ **组件测试也支持了**（下一轮）：`jsdom` 与 `@testing-library/user-event`
 * 就是为此装的（见下面的 `environment` 注释）。
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
    // ⚠️ **保持 `node`（全局默认）**。Route Handler 用的是 Web 标准的
    // Request / Response，Node 18+ 原生支持，不需要 jsdom。
    //
    // ⚠️ **组件测试在自己的文件里用 `// @vitest-environment jsdom` 切过去**——
    // 实测：逐文件的环境注释**优先于全局配置**。
    //
    // ⚠️ **`jsdom` 与 `@testing-library/user-event` 就是为了组件测试装的**：
    // 下一轮要给 `src/app/(dashboard)/plans/plan-form.tsx`（客户端组件）
    // 写组件测试 —— `user-event` 驱动表单（它模拟真实交互，比 fireEvent 准）。
    //
    // ⚠️ **`@testing-library/react` 与 `@testing-library/jest-dom` 被
    // `test/setup.ts` 用着**：前者做 `cleanup`（DOM 跨用例会累积），
    // 后者提供 jest-dom 的匹配器（`toBeInTheDocument` 等）。
    environment: 'node',
    // ⚠️ 扩到 .tsx：组件测试文件是 .tsx。
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
