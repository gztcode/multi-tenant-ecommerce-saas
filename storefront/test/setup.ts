/**
 * Vitest 的全局 setup。
 *
 * ⚠️ 只做「所有环境都需要」的事。jsdom 专属的东西不要放这里——
 * node 环境的测试也会加载它（setupFiles 对所有文件生效）。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// ⚠️ **必须显式 cleanup**：本项目 Vitest 配置 `globals: false`，全局 afterEach
// 不存在，RTL 的自动 cleanup 不会注册（@testing-library/react/dist/index.js:26
// 是 `if (typeof afterEach === 'function')`）。
// 不清的话 DOM 会跨用例累积，从第 2 条用例起 getAllByRole 就找到多个元素
// → 报 "Found multiple elements with the role \"button\""。实测过。
afterEach(() => {
  cleanup();
});
