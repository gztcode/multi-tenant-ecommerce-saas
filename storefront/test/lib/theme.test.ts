/**
 * 护栏 5：主题 token 的**键名**白名单——恶意键名不能逃出 `:root` 块。
 *
 * 为什么这是个注入面：分组标量是「前缀 + 键」拼出来的
 * （`--text-` + key）。若只靠前缀约束，键名就成了可注入面：
 * `tokens.textScale['sm; } body{']` 会拼出
 * `--text-sm; } body{ : 1rem;`，直接逃出这条声明。
 * 所以键必须显式列在白名单里（GROUP_KEYS），正则只校验**值**。
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
      xs: '0.25rem',
      sm: '0.5rem',
      base: '1rem',
      lg: '1.5rem',
      xl: '2rem',
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
    expect(css).not.toContain('--text-');
    expect(css).not.toContain('--font-weight-');
    expect(css).not.toContain('--spacing-');
    expect(css).not.toContain('--shadow-');
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
    expect(css).toContain('--text-xs: 0.75rem;');
    expect(css).toContain('--text-base: 1rem;');
  });

  it('全部合法键名都被输出（防止「全部丢弃」的实现蒙混过关）', () => {
    const css = buildThemeCss(makeTokens());

    // 颜色（CSS_VARS 里列出的）
    expect(css).toContain('--background: oklch(1 0 0);');
    expect(css).toContain('--foreground: oklch(0.145 0 0);');
    expect(css).toContain('--primary: oklch(0.205 0 0);');

    // 顶层标量
    expect(css).toContain('--radius: 0.625rem;');
    expect(css).toContain('--font-sans: var(--font-geist-sans);');
    expect(css).toContain('--font-mono: var(--font-geist-mono);');

    // 分组标量：textScale
    expect(css).toContain('--text-xs: 0.75rem;');
    expect(css).toContain('--text-sm: 0.875rem;');
    expect(css).toContain('--text-base: 1rem;');
    expect(css).toContain('--text-lg: 1.125rem;');
    expect(css).toContain('--text-xl: 1.25rem;');

    // 分组标量：weights
    expect(css).toContain('--font-weight-normal: 400;');
    expect(css).toContain('--font-weight-medium: 500;');
    expect(css).toContain('--font-weight-semibold: 600;');
    expect(css).toContain('--font-weight-bold: 700;');

    // 分组标量：spacing
    expect(css).toContain('--spacing-xs: 0.25rem;');
    expect(css).toContain('--spacing-sm: 0.5rem;');
    expect(css).toContain('--spacing-base: 1rem;');
    expect(css).toContain('--spacing-lg: 1.5rem;');
    expect(css).toContain('--spacing-xl: 2rem;');

    // 分组标量：shadows
    expect(css).toContain('--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);');
    expect(css).toContain('--shadow-base: 0 4px 6px -1px rgb(0 0 0 / 0.1);');
    expect(css).toContain('--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);');
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

    expect(css).toContain('--background: oklch(1 0 0);');
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

    expect(css).toContain('--text-xs: 0.75rem;');
    expect(css).not.toContain('--text-xxl');
    expect(css).not.toContain('--text-huge');
  });

  it('非字符串的值被跳过', () => {
    const css = buildThemeCss(
      makeTokens({
        textScale: { xs: 42 as unknown as string },
        colors: { background: 1 as unknown as string },
      }),
    );

    expect(css).not.toContain('--text-xs');
    expect(css).not.toContain('--background');
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

    // 分组为空 → 没有任何分组声明。
    // （顶层标量这里是空串而不是 undefined，所以会拼出 `--radius: ;` 这类
    //   空声明——这是当前实现的行为。值的合法性由后端 ThemeService 负责，
    //   这里只断言「不抛错」与「分组里没有东西」。）
    expect(css).not.toContain('--text-');
    expect(css).not.toContain('--font-weight-');
    expect(css).not.toContain('--spacing-');
    expect(css).not.toContain('--shadow-');
    expect(css).not.toContain('{');
    expect(css).not.toContain('}');
  });
});
