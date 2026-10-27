import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 字体变量必须挂在 `<html>` 上。
 *
 * ## 为什么用「读源码」这种静态断言
 *
 * 这是一条 CSS 级联正确性 —— `:root`（= `<html>`）声明
 * `--brand-font-sans: var(--font-geist-sans)`，而自定义属性的 `var()` 替换
 * 发生在**声明它的那个元素上**。next/font 的 `.variable` 类若挂在 `<body>`
 * 上，`<html>` 处就解析不到 → 品牌字体静默失效。
 *
 * ⚠️ 这件事**没法靠组件测试测出来**（要真的渲染并读 `getComputedStyle`），
 * 而它恰恰是最容易被「顺手改回去」的一处 —— 所以用静态断言钉住源码形态。
 */
const layout = readFileSync(
  fileURLToPath(new URL('../../src/app/layout.tsx', import.meta.url)),
  'utf8',
);

/**
 * 取 `<html ...>` 开标签的原文。
 *
 * ⚠️ **必须先把注释剥掉**：`<html>` 上方那段说明里就有 `<html>` / `<body>`
 * 的字面量，不剥会先匹配到注释里的那个 `<html>`。
 */
function htmlTag(source: string): string {
  const match = source.match(/<html\b[^>]*>/);
  expect(match).not.toBeNull();
  return match![0];
}

/** 剥掉 JSX 表达式注释与 JS 块注释（两种都以 `*` `/` 斜杠星号包裹） */
function stripComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('根 layout 的字体变量', () => {
  it('字体变量 class 在 <html> 上', () => {
    const tag = htmlTag(stripComments(layout));
    expect(tag).toContain('geistSans.variable');
    expect(tag).toContain('geistMono.variable');
  });

  it('字体变量 class 不在 <body> 上（挪回去会让品牌字体失效）', () => {
    const bodyTag = stripComments(layout).match(/<body\b[^>]*>/);
    expect(bodyTag).not.toBeNull();
    expect(bodyTag![0]).not.toContain('geistSans.variable');
    expect(bodyTag![0]).not.toContain('geistMono.variable');
  });
});
