/**
 * 把主题 token 拼成 CSS 变量声明。
 *
 * 变量名统一在 `--brand-*` 命名空间下（设计文档 §4.2.1）：
 * Tailwind 侧由 globals.css 的 `@theme inline` 映射成 `--color-*` 等命名空间，
 * 运行时（服务端内联 `<style>` / 客户端 `setProperty`）只注入 `--brand-*`。
 *
 * ⚠️ 值已经由后端 ThemeService.sanitize 按白名单过滤过，
 * 这里不再重复校验——但拼装时仍然只接受映射表里出现过的变量名，
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

/**
 * 顶层 token（颜色 + 三个标量）→ CSS 变量名。
 *
 * ⚠️ **导出**是为了让客户端的 ThemeWatcher 用同一份映射
 * （components/theme/theme-watcher.tsx）——客户端与服务端各写一份
 * 映射表，迟早会漂移：服务端加了新 token 而客户端没加，
 * 那个 token 在客户端就永远不生效。
 *
 * 这是**纯模块**，没有 'use client'——两端都能 import。
 * ⚠️ **不要给它加 'use client'**：加了会让 Server Component 那边
 * 多一层客户端边界。
 */
export const CSS_VARS: Record<string, string[]> = {
  // colors
  background: ['--brand-background'],
  foreground: ['--brand-foreground'],
  card: ['--brand-card'],
  cardForeground: ['--brand-card-foreground'],
  primary: ['--brand-primary'],
  primaryForeground: ['--brand-primary-foreground'],
  secondary: ['--brand-secondary'],
  secondaryForeground: ['--brand-secondary-foreground'],
  muted: ['--brand-muted'],
  mutedForeground: ['--brand-muted-foreground'],
  accent: ['--brand-accent'],
  accentForeground: ['--brand-accent-foreground'],
  destructive: ['--brand-destructive'],
  destructiveForeground: ['--brand-destructive-foreground'],
  border: ['--brand-border'],
  ring: ['--brand-ring'],
  // 标量
  radius: ['--brand-radius'],
  fontSans: ['--brand-font-sans'],
  fontMono: ['--brand-font-mono'],
};

/**
 * 分组标量：组 → 键 → CSS 变量名。
 *
 * ⚠️ **这张表同时就是白名单**：能写出去的键必须逐个列在这里。
 *
 * 为什么分组要额外收窄：颜色与顶层标量的键由 CSS_VARS 逐个列出，不在表里的键
 * 自然被跳过；但分组标量若只靠「前缀 + 键」拼出来，键名就成了可注入面——
 * `tokens.textScale['sm; } body{']` 会拼出 `--text-sm; } body{ : 1rem;`，
 * 直接逃出这条声明。改成**显式映射**后，能写出去的键必须出现在表里，
 * 注入面被映射本身堵死。
 *
 * ⚠️ **间距组只有一个键**：Tailwind 4 的间距只有单一 `--spacing` 基础值
 * （`p-4` = `calc(var(--spacing) * 4)`），没有 `--spacing-*` 刻度命名空间，
 * 五档刻度在技术上无法表达 → 语义变成「全局间距密度」。
 *
 * ⚠️ 同样**导出**给客户端的 ThemeWatcher 用（理由同 CSS_VARS）。
 */
export const GROUP_CSS_VARS: Record<string, Record<string, string>> = {
  textScale: {
    xs: '--brand-text-xs',
    sm: '--brand-text-sm',
    base: '--brand-text-base',
    lg: '--brand-text-lg',
    xl: '--brand-text-xl',
  },
  weights: {
    normal: '--brand-font-weight-normal',
    medium: '--brand-font-weight-medium',
    semibold: '--brand-font-weight-semibold',
    bold: '--brand-font-weight-bold',
  },
  shadows: {
    sm: '--brand-shadow-sm',
    base: '--brand-shadow-base',
    lg: '--brand-shadow-lg',
  },
  spacing: {
    base: '--brand-spacing',
  },
};

/** 生成 :root 规则的内容 */
export function buildThemeCss(tokens: ThemeTokenValues): string {
  const declarations: string[] = [];

  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string' || value === '') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const key of ['radius', 'fontSans', 'fontMono'] as const) {
    const value = tokens[key];
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string' || value === '') continue;
    declarations.push(`  ${vars[0]}: ${value};`);
  }

  for (const [group, mapping] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string' || value === '') continue;
      // 键不在映射里 → 不写（映射即白名单）
      const varName = mapping[key];
      if (!varName) continue;
      declarations.push(`  ${varName}: ${value};`);
    }
  }

  return declarations.join('\n');
}
