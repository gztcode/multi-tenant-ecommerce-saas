/**
 * 护栏 5：主题 token 的**键名**白名单——恶意键名不能逃出 `:root` 块。
 *
 * 为什么这是个注入面：分组标量若只靠「前缀 + 键」拼出来
 * （`--text-` + key），键名就成了可注入面：
 * `tokens.textScale['sm; } body{']` 会拼出
 * `--text-sm; } body{ : 1rem;`，直接逃出这条声明。
 * 所以键必须显式列在映射里（GROUP_CSS_VARS），正则只校验**值**。
 *
 * 断言要两边都测：
 * - 恶意键名**不出现**在输出里（且不出现可逃逸的片段）
 * - 正常键名**必须出现**在输出里——只测「恶意被丢弃」不够，
 *   一个「全部丢弃」的实现也能通过那些断言。
 */
import { describe, expect, it } from 'vitest';

import { buildThemeCss, type ThemeTokenValues } from '@/lib/theme';

/** 构造一份完整的 token，测试里按需覆盖某个分组 */
function makeTokens(overrides: Partial<ThemeTokenValues> = {}): ThemeTokenValues {
  return {
    colors: {
      background: 'oklch(1 0 0)',
      foreground: 'oklch(0.145 0 0)',
      primary: 'oklch(0.205 0 0)',
    },
    radius: '0.625rem',
    fontSans: 'var(--font-geist-sans)',
    fontMono: 'var(--font-geist-mono)',
    textScale: {
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
    },
    weights: {
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    spacing: {
      base: '0.25rem',
    },
    shadows: {
      sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      base: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
      lg: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    },
    ...overrides,
  };
}

/** 恶意键名：每一个都试图从 CSS 声明里逃出去 */
const MALICIOUS_KEYS = [
  'sm; } body{',
  'xs; }',
  'base } :root { color: red; } .x {',
  'lg;} body{display:none',
  'xl: 1rem; } body { background: url(javascript:alert(1)); } .y{',
  'normal; } @import "evil.css"; .z{',
  'bold; }',
  'a\nb',
  'red;}body{color:red',
];

describe('护栏 5：buildThemeCss 的键名白名单', () => {
  it('恶意键名不产生任何 CSS 声明', () => {
    const textScale: Record<string, string> = {};
    for (const key of MALICIOUS_KEYS) {
      textScale[key] = '1rem';
    }

    const css = buildThemeCss(
      makeTokens({
        textScale,
        weights: Object.fromEntries(MALICIOUS_KEYS.map((k) => [k, '400'])),
        spacing: Object.fromEntries(MALICIOUS_KEYS.map((k) => [k, '1rem'])),
        shadows: Object.fromEntries(MALICIOUS_KEYS.map((k) => [k, '0 0 0'])),
      }),
    );

    // 一个恶意键名都不该出现在输出里
    for (const key of MALICIOUS_KEYS) {
      expect(css).not.toContain(key);
    }
    // 也不该出现任何能逃出声明块的片段
    expect(css).not.toContain('body{');
    expect(css).not.toContain('body {');
    expect(css).not.toContain('@import');
    expect(css).not.toContain('javascript:');
    expect(css).not.toContain('}');
    expect(css).not.toContain('{');
    // 整份输出里不该有任何来自恶意键名的前缀声明
    expect(css).not.toContain('--brand-text-');
    expect(css).not.toContain('--brand-font-weight-');
    expect(css).not.toContain('--brand-shadow-');
  });

  it('单个恶意键名不拖累同组的正常键名', () => {
    const css = buildThemeCss(
      makeTokens({
        textScale: {
          xs: '0.75rem',
          'sm; } body{': '1rem',
          base: '1rem',
        },
      }),
    );

    // 恶意键被丢弃
    expect(css).not.toContain('body{');
    expect(css).not.toContain('}');
    // 正常键保留
    expect(css).toContain('--brand-text-xs: 0.75rem;');
    expect(css).toContain('--brand-text-base: 1rem;');
  });

  it('全部合法键名都被输出（防止「全部丢弃」的实现蒙混过关）', () => {
    const css = buildThemeCss(makeTokens());

    // 颜色（CSS_VARS 里列出的）
    expect(css).toContain('--brand-background: oklch(1 0 0);');
    expect(css).toContain('--brand-foreground: oklch(0.145 0 0);');
    expect(css).toContain('--brand-primary: oklch(0.205 0 0);');

    // 顶层标量
    expect(css).toContain('--brand-radius: 0.625rem;');
    expect(css).toContain('--brand-font-sans: var(--font-geist-sans);');
    expect(css).toContain('--brand-font-mono: var(--font-geist-mono);');

    // 分组标量：textScale
    expect(css).toContain('--brand-text-xs: 0.75rem;');
    expect(css).toContain('--brand-text-sm: 0.875rem;');
    expect(css).toContain('--brand-text-base: 1rem;');
    expect(css).toContain('--brand-text-lg: 1.125rem;');
    expect(css).toContain('--brand-text-xl: 1.25rem;');

    // 分组标量：weights
    expect(css).toContain('--brand-font-weight-normal: 400;');
    expect(css).toContain('--brand-font-weight-medium: 500;');
    expect(css).toContain('--brand-font-weight-semibold: 600;');
    expect(css).toContain('--brand-font-weight-bold: 700;');

    // 分组标量：shadows
    expect(css).toContain('--brand-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);');
    expect(css).toContain('--brand-shadow-base: 0 4px 6px -1px rgb(0 0 0 / 0.1);');
    expect(css).toContain('--brand-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);');

    // 分组标量：spacing（**单一基础值**）
    expect(css).toContain('--brand-spacing: 0.25rem;');
  });

  it('未知颜色键名被丢弃（CSS_VARS 白名单）', () => {
    const css = buildThemeCss(
      makeTokens({
        colors: {
          background: 'oklch(1 0 0)',
          'evil; } body{': 'oklch(0 0 0)',
          notAToken: 'oklch(0 0 0)',
        },
      }),
    );

    expect(css).toContain('--brand-background: oklch(1 0 0);');
    expect(css).not.toContain('evil');
    expect(css).not.toContain('notAToken');
    expect(css).not.toContain('}');
  });

  it('白名单之外的分组键名被丢弃', () => {
    const css = buildThemeCss(
      makeTokens({
        textScale: {
          xs: '0.75rem',
          // 不在白名单里的正常键名（不是恶意，只是不认识）
          xxl: '2rem',
          huge: '3rem',
        },
      }),
    );

    expect(css).toContain('--brand-text-xs: 0.75rem;');
    expect(css).not.toContain('--brand-text-xxl');
    expect(css).not.toContain('--brand-text-huge');
  });

  it('非字符串的值被跳过', () => {
    const css = buildThemeCss(
      makeTokens({
        textScale: { xs: 42 as unknown as string },
        colors: { background: 1 as unknown as string },
      }),
    );

    expect(css).not.toContain('--brand-text-xs');
    expect(css).not.toContain('--brand-background');
  });

  it('空 token 不会抛错', () => {
    const css = buildThemeCss({
      colors: {},
      radius: '',
      fontSans: '',
      fontMono: '',
      textScale: {},
      weights: {},
      spacing: {},
      shadows: {},
    });

    // 空串**不产生任何声明**——`--brand-radius: ;` 是非法声明，
    // CSS 解析器会整条丢弃，所以不变量钉在产生方：只接受非空字符串。
    expect(css).not.toContain('--brand-radius');
    expect(css).not.toContain('--brand-font-sans');
    expect(css).not.toContain('--brand-font-mono');
    // 分组为空 → 没有任何分组声明。
    expect(css).not.toContain('--brand-text-');
    expect(css).not.toContain('--brand-font-weight-');
    expect(css).not.toContain('--brand-shadow-');
    expect(css).not.toContain('{');
    expect(css).not.toContain('}');
    // 一条声明都没产出 → 输出为空字符串。
    expect(css).toBe('');
  });

  it('空串值不产生空声明（颜色与分组同样适用）', () => {
    const css = buildThemeCss(
      makeTokens({
        colors: { background: '', primary: 'oklch(0.205 0 0)' },
        textScale: { xs: '', sm: '0.875rem' },
        shadows: { base: '' },
      }),
    );

    // 空串被跳过，非空值照常输出。
    expect(css).not.toContain('--brand-background');
    expect(css).not.toContain('--brand-text-xs');
    expect(css).not.toContain('--brand-shadow-base');
    expect(css).toContain('--brand-primary: oklch(0.205 0 0);');
    expect(css).toContain('--brand-text-sm: 0.875rem;');
    // 不得出现 `--xxx: ;` 这种非法声明。
    expect(css).not.toMatch(/:\s*;/);
  });
});
