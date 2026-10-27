/**
 * 主题 token 的定义——**单一事实来源**。
 *
 * 为什么放后端：storefront 与 merchant-admin 是两个独立项目、不共享代码，
 * 各自维护一份 token 白名单必然漂移（加了一个新 token 只改了一边，
 * 结果就是前台渲染不出来、后台也配不了）。
 *
 * ⚠️ 颜色格式是 **oklch**，不是 HSL 三元组。仓库的 globals.css 用的是
 * Tailwind CSS 4 + shadcn/ui 新版，默认值就是 `oklch(0.205 0 0)`。
 */

export interface ColorTokenDefinition {
  key: string;
  label: string;
  /**
   * CSS 变量名（统一在 `--brand-*` 命名空间下，
   * Tailwind 侧由 globals.css 的 `@theme inline` 映射成 `--color-*` 等）
   */
  cssVar: string;
  defaultValue: string;
}

export interface ScalarTokenDefinition {
  key: string;
  label: string;
  /**
   * CSS 变量名（统一在 `--brand-*` 命名空间下，
   * Tailwind 侧由 globals.css 的 `@theme inline` 映射成 `--color-*` 等）
   */
  cssVar: string;
  defaultValue: string;
}

export const COLOR_TOKENS: ColorTokenDefinition[] = [
  {
    key: 'background',
    label: '背景色',
    cssVar: '--brand-background',
    defaultValue: 'oklch(1 0 0)',
  },
  {
    key: 'foreground',
    label: '文字色',
    cssVar: '--brand-foreground',
    defaultValue: 'oklch(0.145 0 0)',
  },
  {
    key: 'card',
    label: '卡片背景',
    cssVar: '--brand-card',
    defaultValue: 'oklch(1 0 0)',
  },
  {
    key: 'cardForeground',
    label: '卡片文字',
    cssVar: '--brand-card-foreground',
    defaultValue: 'oklch(0.145 0 0)',
  },
  {
    key: 'primary',
    label: '主色',
    cssVar: '--brand-primary',
    defaultValue: 'oklch(0.205 0 0)',
  },
  {
    key: 'primaryForeground',
    label: '主色上的文字',
    cssVar: '--brand-primary-foreground',
    defaultValue: 'oklch(0.985 0 0)',
  },
  {
    key: 'secondary',
    label: '次要色',
    cssVar: '--brand-secondary',
    defaultValue: 'oklch(0.97 0 0)',
  },
  {
    key: 'secondaryForeground',
    label: '次要色上的文字',
    cssVar: '--brand-secondary-foreground',
    defaultValue: 'oklch(0.205 0 0)',
  },
  {
    key: 'muted',
    label: '弱化色',
    cssVar: '--brand-muted',
    defaultValue: 'oklch(0.97 0 0)',
  },
  {
    key: 'mutedForeground',
    label: '弱化色上的文字',
    cssVar: '--brand-muted-foreground',
    defaultValue: 'oklch(0.556 0 0)',
  },
  {
    key: 'accent',
    label: '强调色',
    cssVar: '--brand-accent',
    defaultValue: 'oklch(0.97 0 0)',
  },
  {
    key: 'accentForeground',
    label: '强调色上的文字',
    cssVar: '--brand-accent-foreground',
    defaultValue: 'oklch(0.205 0 0)',
  },
  {
    key: 'destructive',
    label: '危险色',
    cssVar: '--brand-destructive',
    defaultValue: 'oklch(0.577 0.245 27.325)',
  },
  {
    key: 'destructiveForeground',
    label: '危险色上的文字',
    cssVar: '--brand-destructive-foreground',
    defaultValue: 'oklch(0.985 0 0)',
  },
  {
    key: 'border',
    label: '边框色',
    cssVar: '--brand-border',
    defaultValue: 'oklch(0.922 0 0)',
  },
  {
    key: 'ring',
    label: '聚焦环',
    cssVar: '--brand-ring',
    defaultValue: 'oklch(0.708 0 0)',
  },
];

export const RADIUS_TOKEN: ScalarTokenDefinition = {
  key: 'radius',
  label: '圆角',
  cssVar: '--brand-radius',
  defaultValue: '0.625rem',
};

export const FONT_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'fontSans',
    label: '正文字体',
    cssVar: '--brand-font-sans',
    defaultValue: 'var(--font-geist-sans)',
  },
  {
    key: 'fontMono',
    label: '等宽字体',
    cssVar: '--brand-font-mono',
    defaultValue: 'var(--font-geist-mono)',
  },
];

export const TEXT_SCALE_TOKENS: ScalarTokenDefinition[] = [
  { key: 'xs', label: '最小', cssVar: '--brand-text-xs', defaultValue: '0.75rem' },
  { key: 'sm', label: '小', cssVar: '--brand-text-sm', defaultValue: '0.875rem' },
  { key: 'base', label: '正文', cssVar: '--brand-text-base', defaultValue: '1rem' },
  { key: 'lg', label: '大', cssVar: '--brand-text-lg', defaultValue: '1.125rem' },
  { key: 'xl', label: '特大', cssVar: '--brand-text-xl', defaultValue: '1.25rem' },
];

export const WEIGHT_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'normal',
    label: '常规',
    cssVar: '--brand-font-weight-normal',
    defaultValue: '400',
  },
  {
    key: 'medium',
    label: '中等',
    cssVar: '--brand-font-weight-medium',
    defaultValue: '500',
  },
  {
    key: 'semibold',
    label: '半粗',
    cssVar: '--brand-font-weight-semibold',
    defaultValue: '600',
  },
  {
    key: 'bold',
    label: '加粗',
    cssVar: '--brand-font-weight-bold',
    defaultValue: '700',
  },
];

/**
 * 间距组：**只有一个**基础值。
 *
 * ⚠️ **为什么不是五档刻度**：Tailwind 4 的间距只有**单一** `--spacing`
 * 基础值（`p-4` = `calc(var(--spacing) * 4)`），**没有** `--spacing-xs` 这种
 * 刻度命名空间 —— 五档刻度在技术上无法表达。
 * 语义因此从「五档刻度」变成「**全局间距密度**」。
 *
 * ⚠️ **老数据自动降级**：`sanitize()` 按本数组的定义取键，老数据里的
 * `xs`/`sm`/`lg`/`xl` 不在白名单 → 被丢弃；`base` 保留 → 无需写迁移。
 */
export const SPACING_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'base',
    label: '间距密度',
    cssVar: '--brand-spacing',
    defaultValue: '0.25rem',
  },
];

/**
 * 阴影组。
 *
 * ⚠️ **默认值必须与 globals.css 的 `:root` 里的 `--brand-shadow-*` 逐字一致**：
 * 前者决定「商家没配时接口返回什么」，后者决定「没人注入时页面用什么」。
 * 两边不一样 → 商家清空某个字段后外观会跳变。
 * 两边的默认值都写在这两个文件里，靠**同一次提交**保证不漂移；
 * 两侧各有一条单测约束自己的那份字面量，改动时需**同步核对两边**。
 */
export const SHADOW_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'sm',
    label: '轻',
    cssVar: '--brand-shadow-sm',
    defaultValue:
      '0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))',
  },
  {
    key: 'base',
    label: '标准',
    cssVar: '--brand-shadow-base',
    defaultValue: '0 4px 6px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))',
  },
  {
    key: 'lg',
    label: '重',
    cssVar: '--brand-shadow-lg',
    defaultValue:
      '0 10px 15px -3px var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 4px 6px -4px var(--tw-shadow-color, rgb(0 0 0 / 0.1))',
  },
];

/**
 * token 值的形状校验。
 *
 * `stores.themeTokens` 是 Json 字段，客户端可以塞任何东西。
 * 不校验就直接拼进 CSS，一个 `{ "background": "url(javascript:...)" }`
 * 就能把任意 CSS 注入页面——这是实打实的 XSS 矢量。
 *
 * 规则：
 * - 颜色必须是 oklch(...) 形式：只允许字母、数字、空格、点、%、括号、逗号、斜杠
 * - 其余标量只允许字母、数字、点、%、rem、px、em、vh、vw、逗号、空格、斜杠、括号
 * - 长度上限 200 字符
 */
const COLOR_VALUE = /^oklch\([0-9a-zA-Z.%\-/ ]{1,180}\)$/;
const SCALAR_VALUE = /^[0-9a-zA-Z.%\-/,_() ]{1,180}$/;

export function isValidColorValue(value: unknown): value is string {
  return typeof value === 'string' && COLOR_VALUE.test(value);
}

export function isValidScalarValue(value: unknown): value is string {
  return typeof value === 'string' && SCALAR_VALUE.test(value);
}

/** 已知的 token 分组名 */
export const TOKEN_GROUPS = [
  'colors',
  'textScale',
  'weights',
  'spacing',
  'shadows',
] as const;

export type TokenGroup = (typeof TOKEN_GROUPS)[number];
