'use client';

/**
 * 根级错误边界。
 *
 * ⚠️ **它替换的是整个应用**，所以**不能用 app 的 layout**
 * ——layout 本身可能正是出错的原因。
 * 因此这里自带 `<html><body>`，并且**不 import 任何 app 内的东西**
 * （含 globals.css）：那些 import 同样可能失败。
 *
 * 代价是没有 Tailwind 类可用 → 用内联样式。
 *
 * ⚠️ **颜色一律写 oklch 字面量，不写 `var(--brand-*)`**：
 * 本文件渲染在根 layout **之外**，此时 globals.css 未必已加载，
 * 引用 `var(--brand-foreground)` 等变量会拿到**未定义值**（文字可能不可见）。
 * 这里的字面量与 `globals.css` 的 `:root` 里对应的 `--brand-*` 逐字一致
 * （商家覆盖主题时，本页不跟随 —— 但可读性优先于主题一致性）。
 *
 * ⚠️ **`<html>` 不带 `geistSans.variable` 是刻意取舍**：
 * 全局错误页往往正是「CSS 都没加载」导致的，此时不该依赖 CSS 变量，
 * 所以字体改用内联的 system 栈兜底。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: '16px',
          padding: '32px',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
          color: 'oklch(0.145 0 0)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700 }}>
          应用出错了
        </h1>
        <p style={{ margin: 0, color: 'oklch(0.556 0 0)' }}>
          页面遇到了一个意外错误，你可以重试一次；如果一直不行，请稍后再来。
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            padding: '8px 16px',
            borderRadius: '6px',
            border: '1px solid oklch(0.922 0 0)',
            background: 'oklch(0.205 0 0)',
            color: 'oklch(0.985 0 0)',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </body>
    </html>
  );
}
