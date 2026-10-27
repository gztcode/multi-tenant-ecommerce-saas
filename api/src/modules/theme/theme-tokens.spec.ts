import {
  COLOR_TOKENS,
  FONT_TOKENS,
  isValidScalarValue,
  RADIUS_TOKEN,
  SHADOW_TOKENS,
  SPACING_TOKENS,
  TEXT_SCALE_TOKENS,
  WEIGHT_TOKENS,
} from './theme-tokens';

/**
 * token 定义的形状约束。
 *
 * ## 为什么这些是「定义级」的约束
 *
 * `cssVar` 是前后端唯一的耦合点：后端把 token 的 cssVar 放进 schema，
 * 前端（merchant-admin 的预览、storefront 的映射表）照着它写 CSS 变量。
 * 一旦两边对不上，商家配的值就写到一个没人读的变量上 —— **静默失效**。
 *
 * 所以这里把「全部 cssVar 都在 `--brand-*` 命名空间下」钉死。
 */

/** Tailwind 4 的阴影内置值（与 globals.css 的 `:root` 必须逐字一致） */
const TAILWIND_SHADOW_SM =
  '0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))';
const TAILWIND_SHADOW_BASE =
  '0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))';
const TAILWIND_SHADOW_LG =
  '0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1))';

describe('theme token 定义', () => {
  it('所有 cssVar 都在 --brand-* 命名空间下', () => {
    const all = [
      ...COLOR_TOKENS,
      RADIUS_TOKEN,
      ...FONT_TOKENS,
      ...TEXT_SCALE_TOKENS,
      ...WEIGHT_TOKENS,
      ...SPACING_TOKENS,
      ...SHADOW_TOKENS,
    ];

    for (const token of all) {
      expect(token.cssVar.startsWith('--brand-')).toBe(true);
    }
  });

  it('所有 cssVar 互不重复（重复会让两个 token 抢同一个变量）', () => {
    const all = [
      ...COLOR_TOKENS,
      RADIUS_TOKEN,
      ...FONT_TOKENS,
      ...TEXT_SCALE_TOKENS,
      ...WEIGHT_TOKENS,
      ...SPACING_TOKENS,
      ...SHADOW_TOKENS,
    ];
    const vars = all.map((t) => t.cssVar);

    expect(new Set(vars).size).toBe(vars.length);
  });

  it('间距组只剩一个「基础值」token', () => {
    expect(SPACING_TOKENS).toHaveLength(1);
    expect(SPACING_TOKENS[0].key).toBe('base');
    expect(SPACING_TOKENS[0].cssVar).toBe('--brand-spacing');
    expect(SPACING_TOKENS[0].defaultValue).toBe('0.25rem');
  });

  it('阴影默认值就是 Tailwind 的内置值', () => {
    expect(SHADOW_TOKENS.map((t) => t.defaultValue)).toEqual([
      TAILWIND_SHADOW_SM,
      TAILWIND_SHADOW_BASE,
      TAILWIND_SHADOW_LG,
    ]);
  });

  it('阴影默认值能过 isValidScalarValue（否则后端会把它当非法值丢掉）', () => {
    // 复合阴影值含逗号、括号与 var() —— 正则必须放行这些字符
    for (const token of SHADOW_TOKENS) {
      expect(isValidScalarValue(token.defaultValue)).toBe(true);
    }
  });

  it('destructiveForeground 是存在的（历史上它是个没有任何消费者的空 token）', () => {
    const token = COLOR_TOKENS.find((t) => t.key === 'destructiveForeground');
    expect(token).toBeDefined();
    expect(token?.cssVar).toBe('--brand-destructive-foreground');
  });
});
