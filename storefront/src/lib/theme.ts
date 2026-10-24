/**
 * 把主题 token 拼成 CSS 变量声明。
 *
 * 变量名沿用 shadcn 的约定：`:root` 里是 `--primary` / `--background` 这类裸名，
 * Tailwind 侧由 globals.css 的 `@theme inline` 映射成 `--color-primary`。
 * 覆盖的是**裸名**那一层。
 *
 * ⚠️ 值已经由后端 ThemeService.sanitize 按白名单过滤过，
 * 这里不再重复校验——但拼装时仍然只接受后端 schema 里出现过的变量名，
 * 避免「后端漏了一个字段，前端就把任意内容拼进 style 标签」。
 */

export interface ThemeTokenValues {
  colors: Record<string, string>;
  radius: string;
  fontSans: string;
  fontMono: string;
  textScale: Record<string, string>;
  weights: Record<string, string>;
  spacing: Record<string, string>;
  shadows: Record<string, string>;
}

/** 与后端 theme-tokens.ts 一一对应的 CSS 变量名 */
const CSS_VARS: Record<string, string[]> = {
  // colors
  background: ['--background'],
  foreground: ['--foreground'],
  card: ['--card'],
  cardForeground: ['--card-foreground'],
  primary: ['--primary'],
  primaryForeground: ['--primary-foreground'],
  secondary: ['--secondary'],
  secondaryForeground: ['--secondary-foreground'],
  muted: ['--muted'],
  mutedForeground: ['--muted-foreground'],
  accent: ['--accent'],
  accentForeground: ['--accent-foreground'],
  destructive: ['--destructive'],
  destructiveForeground: ['--destructive-foreground'],
  border: ['--border'],
  ring: ['--ring'],
  // 标量
  radius: ['--radius'],
  fontSans: ['--font-sans'],
  fontMono: ['--font-mono'],
};

/** 分组标量：键 → CSS 变量名 */
const GROUP_CSS_VARS: Record<string, string> = {
  textScale: '--text-',
  weights: '--font-weight-',
  spacing: '--spacing-',
  shadows: '--shadow-',
};

/**
 * 分组内允许的 token 键白名单。
 *
 * 为什么分组要额外收窄：颜色与顶层标量的键由 CSS_VARS 逐个列出，不在表里的键
 * 自然被跳过；但分组标量是「前缀 + 键」拼出来的（`--text-` + key），
 * 若只靠前缀约束，键名就成了可注入面——`tokens.textScale['sm; } body{']`
 * 会拼出 `--text-sm; } body{ : 1rem;`，直接逃出这条声明。
 * 正则只校验**值**，键必须在这里显式列出。
 *
 * 这些键与后端 theme-tokens.ts 的定义一一对应，后端加了新 token 时要同步这里
 * （这是前后端唯一需要手动同步的地方，也是把它收窄到这个数量的原因）。
 */
const GROUP_KEYS: Record<string, ReadonlySet<string>> = {
  textScale: new Set(['xs', 'sm', 'base', 'lg', 'xl']),
  weights: new Set(['normal', 'medium', 'semibold', 'bold']),
  spacing: new Set(['xs', 'sm', 'base', 'lg', 'xl']),
  shadows: new Set(['sm', 'base', 'lg']),
};

/** 生成 :root 规则的内容 */
export function buildThemeCss(tokens: ThemeTokenValues): string {
  const declarations: string[] = [];

  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const key of ['radius', 'fontSans', 'fontMono'] as const) {
    const value = tokens[key];
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const [group, prefix] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    const allowed = GROUP_KEYS[group];
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      // 键必须在白名单内，否则可从键名逃出 CSS 声明
      if (!allowed.has(key)) continue;
      declarations.push(`  ${prefix}${key}: ${value};`);
    }
  }

  return declarations.join('\n');
}