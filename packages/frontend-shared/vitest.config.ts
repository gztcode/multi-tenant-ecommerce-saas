import { defineConfig } from 'vitest/config';

/**
 * 共享包自己的测试配置。
 *
 * ⚠️ **必须显式打开 JSX 自动转换**：`tsconfig.json` 里是 `jsx: preserve`
 *    （交给 Next 编译），esbuild 默认不认这种设置，组件冒烟测试会报
 *    `React is not defined`。三端 `vitest.config.ts` 里同一条也不要删。
 *
 * ⚠️ **不引 jsdom / testing-library**：本包只有逻辑与「能不能渲染」两类断言，
 *    `react-dom/server` 的 `renderToStaticMarkup` 在 node 环境就够了。
 *    `session-sync` 依赖的 `BroadcastChannel` 反而是 jsdom 没有、node 有的。
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    globals: false,
  },
});
