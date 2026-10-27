import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `globals.css` 的结构约束。
 *
 * ## 为什么要有这个测试
 *
 * 主题变量分两层（设计文档 §4.2.1）：
 * - `@theme inline` 里只出现 **Tailwind 命名空间**（`--color-*` / `--text-*` …），
 *   它们的值是 `var(--brand-*)`；
 * - `:root` / `.dark` 里只出现 **`--brand-*`**，默认值只存这一处。
 *
 * 这两层一旦写混（`:root` 里冒出裸名 `--primary`），商家配的值就会写到一个
 * **没人读的变量**上 —— 静默失效，且没有任何报错。
 * 所以用测试把结构钉死。
 */

const css = readFileSync(
  fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
  'utf8',
);

/**
 * 取出一个 at-rule 块的内容。
 *
 * ⚠️ **取的是第一个 `}`** —— 前提是块内没有嵌套的 `{}`。
 * 当前 `:root` / `.dark` / `@theme inline` 三个块都满足；
 * 将来块里若加了 `@supports` 之类，得改成括号配对计数。
 */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

/**
 * 取出一个块里**声明**的所有自定义属性名。
 *
 * ⚠️ **必须锚到行首**（`^\s*` + `m` 标志）：否则会连 `var(--font-geist-sans)`
 * 这类**值里的变量名**一起匹配进来 —— 那些不是声明。
 */
function declaredVars(source: string): string[] {
  return [...source.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]);
}

/** 取 @theme inline 块的内容 */
function themeBlock(): string {
  return block('@theme inline');
}

describe('globals.css 的主题变量结构', () => {
  it('@theme inline 里的颜色命名空间全部指向 --brand-*', () => {
    const theme = themeBlock();
    const colorVars = declaredVars(theme).filter((v) => v.startsWith('--color-'));
    expect(colorVars.length).toBe(32);
    for (const v of colorVars) {
      expect(theme).toContain(`${v}: var(--brand-${v.slice('--color-'.length)});`);
    }
  });

  it('@theme inline 里补上了 destructive-foreground（历史上是空 token）', () => {
    expect(css).toContain('--color-destructive-foreground: var(--brand-destructive-foreground);');
  });

  it('@theme inline 里没有字体自引用', () => {
    // `--font-sans: var(--font-sans)` 是自引用 → 计算值阶段无效
    expect(css).not.toContain('--font-sans: var(--font-sans);');
    expect(css).toContain('--font-sans: var(--brand-font-sans);');
  });

  it('@theme inline 里没有 fallback（默认值只存 :root 一处）', () => {
    // 形如 `var(--brand-x, ...)` 的 fallback 一律不允许
    expect(themeBlock()).not.toMatch(/var\(--brand-[a-z-]+,/);
  });

  it(':root 里声明的变量全部是 --brand-*（没有裸名残留）', () => {
    const vars = declaredVars(block(':root'));
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v.startsWith('--brand-')).toBe(true);
    }
  });

  it('.dark 里声明的变量全部是 --brand-*（没有裸名残留）', () => {
    const vars = declaredVars(block('.dark'));
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      expect(v.startsWith('--brand-')).toBe(true);
    }
  });

  it(':root 里有全部 32 个颜色变量的默认值', () => {
    const vars = new Set(declaredVars(block(':root')));
    for (const name of [
      'background', 'foreground', 'card', 'card-foreground',
      'popover', 'popover-foreground', 'primary', 'primary-foreground',
      'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
      'accent', 'accent-foreground', 'destructive', 'destructive-foreground',
      'border', 'input', 'ring',
      'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
      'sidebar', 'sidebar-foreground', 'sidebar-primary',
      'sidebar-primary-foreground', 'sidebar-accent',
      'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring',
    ]) {
      expect(vars.has(`--brand-${name}`)).toBe(true);
    }
  });

  it('阴影默认值与后端 theme-tokens.ts 逐字一致', () => {
    // ⚠️ 后端那份是「商家没配时接口返回什么」，前端这份是「没人注入时用什么」。
    //    两边不一致 → 商家清空某个字段后外观跳变。
    const root = block(':root');
    expect(root).toContain(
      '--brand-shadow-sm: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));',
    );
    expect(root).toContain(
      '--brand-shadow-base: 0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));',
    );
    expect(root).toContain(
      '--brand-shadow-lg: 0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1));',
    );
  });

  it('间距是单一基础值', () => {
    expect(css).toContain('--spacing: var(--brand-spacing);');
    expect(block(':root')).toContain('--brand-spacing: 0.25rem;');
  });
});
