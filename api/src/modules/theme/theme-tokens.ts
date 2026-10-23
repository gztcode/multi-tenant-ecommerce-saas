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
  /** CSS 变量名（shadcn 约定用裸名，Tailwind 侧由 @theme inline 映射） */
  cssVar: string;
  defaultValue: string;
}

export interface ScalarTokenDefinition {
  key: string;
  label: string;
  cssVar: string;
  defaultValue: string;
}

export const COLOR_TOKENS: ColorTokenDefinition[] = [
  {
    key: 'background',
    label: '背景色',
    cssVar: '--background',
    defaultValue: 'oklch(1 0 0)',
  },
  {
    key: 'foreground',
    label: '文字色',
    cssVar: '--foreground',
    defaultValue: 'oklch(0.145 0 0)',
  },
  {
    key: 'card',
    label: '卡片背景',
    cssVar: '--card',
    defaultValue: 'oklch(1 0 0)',
  },
  {
    key: 'cardForeground',
    label: '卡片文字',
    cssVar: '--card-foreground',
    defaultValue: 'oklch(0.145 0 0)',
  },
  {
    key: 'primary',
    label: '主色',
    cssVar: '--primary',
    defaultValue: 'oklch(0.205 0 0)',
  },
  {
    key: 'primaryForeground',
    label: '主色上的文字',
    cssVar: '--primary-foreground',
    defaultValue: 'oklch(0.985 0 0)',
  },
  {
    key: 'secondary',
    label: '次要色',
    cssVar: '--secondary',
    defaultValue: 'oklch(0.97 0 0)',
  },
  {
    key: 'secondaryForeground',
    label: '次要色上的文字',
    cssVar: '--secondary-foreground',
    defaultValue: 'oklch(0.205 0 0)',
  },
  {
    key: 'muted',
    label: '弱化色',
    cssVar: '--muted',
    defaultValue: 'oklch(0.97 0 0)',
  },
  {
    key: 'mutedForeground',
    label: '弱化色上的文字',
    cssVar: '--muted-foreground',
    defaultValue: 'oklch(0.556 0 0)',
  },
  {
    key: 'accent',
    label: '强调色',
    cssVar: '--accent',
    defaultValue: 'oklch(0.97 0 0)',
  },
  {
    key: 'accentForeground',
    label: '强调色上的文字',
    cssVar: '--accent-foreground',
    defaultValue: 'oklch(0.205 0 0)',
  },
  {
    key: 'destructive',
    label: '危险色',
    cssVar: '--destructive',
    defaultValue: 'oklch(0.577 0.245 27.325)',
  },
  {
    key: 'destructiveForeground',
    label: '危险色上的文字',
    cssVar: '--destructive-foreground',
    defaultValue: 'oklch(0.985 0 0)',
  },
  {
    key: 'border',
    label: '边框色',
    cssVar: '--border',
    defaultValue: 'oklch(0.922 0 0)',
  },
  {
    key: 'ring',
    label: '聚焦环',
    cssVar: '--ring',
    defaultValue: 'oklch(0.708 0 0)',
  },
];

export const RADIUS_TOKEN: ScalarTokenDefinition = {
  key: 'radius',
  label: '圆角',
  cssVar: '--radius',
  defaultValue: '0.625rem',
};

export const FONT_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'fontSans',
    label: '正文字体',
    cssVar: '--font-sans',
    defaultValue: 'var(--font-geist-sans)',
  },
  {
    key: 'fontMono',
    label: '等宽字体',
    cssVar: '--font-mono',
    defaultValue: 'var(--font-geist-mono)',
  },
];

export const TEXT_SCALE_TOKENS: ScalarTokenDefinition[] = [
  { key: 'xs', label: '最小', cssVar: '--text-xs', defaultValue: '0.75rem' },
  { key: 'sm', label: '小', cssVar: '--text-sm', defaultValue: '0.875rem' },
  { key: 'base', label: '正文', cssVar: '--text-base', defaultValue: '1rem' },
  { key: 'lg', label: '大', cssVar: '--text-lg', defaultValue: '1.125rem' },
  { key: 'xl', label: '特大', cssVar: '--text-xl', defaultValue: '1.25rem' },
];

export const WEIGHT_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'normal',
    label: '常规',
    cssVar: '--font-weight-normal',
    defaultValue: '400',
  },
  {
    key: 'medium',
    label: '中等',
    cssVar: '--font-weight-medium',
    defaultValue: '500',
  },
  {
    key: 'semibold',
    label: '半粗',
    cssVar: '--font-weight-semibold',
    defaultValue: '600',
  },
  {
    key: 'bold',
    label: '加粗',
    cssVar: '--font-weight-bold',
    defaultValue: '700',
  },
];

export const SPACING_TOKENS: ScalarTokenDefinition[] = [
  { key: 'xs', label: '最小', cssVar: '--spacing-xs', defaultValue: '0.25rem' },
  { key: 'sm', label: '小', cssVar: '--spacing-sm', defaultValue: '0.5rem' },
  {
    key: 'base',
    label: '标准',
    cssVar: '--spacing-base',
    defaultValue: '1rem',
  },
  { key: 'lg', label: '大', cssVar: '--spacing-lg', defaultValue: '1.5rem' },
  { key: 'xl', label: '特大', cssVar: '--spacing-xl', defaultValue: '2rem' },
];

export const SHADOW_TOKENS: ScalarTokenDefinition[] = [
  {
    key: 'sm',
    label: '轻',
    cssVar: '--shadow-sm',
    defaultValue: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  {
    key: 'base',
    label: '标准',
    cssVar: '--shadow-base',
    defaultValue: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
  },
  {
    key: 'lg',
    label: '重',
    cssVar: '--shadow-lg',
    defaultValue: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
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
