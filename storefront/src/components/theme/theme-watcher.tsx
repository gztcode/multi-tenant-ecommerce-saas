'use client';

import { useEffect } from 'react';
import {
  CSS_VARS,
  GROUP_CSS_VARS,
  GROUP_KEYS,
  type ThemeTokenValues,
} from '@/lib/theme';

/** 轮询间隔（毫秒）。默认 30 秒。 */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 主题实时生效的客户端组件。
 *
 * ## 为什么需要它
 *
 * 服务端**已经是请求期拉取**（`(shop)/layout.tsx` 的 `force-dynamic` +
 * 每次请求调 `/public/theme`），但 `<style>` 标签**只在服务端渲染时注入**——
 * 页面不刷新就不会重新请求，也就不会重新注入，所以看不到新主题。
 *
 * 所以这里补上「客户端的二次拉取与重注入」。
 *
 * ## 为什么用轮询而不是推送
 *
 * - **多副本正确性**：storefront 在 Nginx 后面，将来扩副本时，
 *   「服务端缓存 + 失效广播」与 SSE 都需要跨副本同步状态，
 *   而轮询**是无状态的**——每个副本的客户端各自查各自的后端，
 *   后端查库拿到的永远是最新值。
 * - **不引入新基础设施**：推送方案要长连接 + 发布订阅；
 *   失效方案要共享缓存层 + 内部鉴权端点。轮询只要一个 HTTP 请求。
 *
 * ## 为什么用 setProperty 而不是重建 <style>
 *
 * 服务端注入的是 `:root { --primary: ... }`。
 * CSS 的**行内样式优先级高于任何样式表规则**，所以
 * `documentElement.style.setProperty('--primary', v)` 会**覆盖** `:root`
 * 里的同名变量，而其它没被覆盖的变量继续走 `:root`——
 * 这正是「增量更新」想要的语义，且不需要删掉服务端那份。
 */
export function ThemeWatcher({
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  /**
   * 轮询间隔（毫秒）。
   *
   * ⚠️ **这个 prop 是「为了可测」加的**，不是前瞻性设计——
   * 组件只有一个使用方（`(shop)/layout.tsx`），默认值就是生产值（30 秒）。
   * 测试传一个小值（如 20 毫秒）才能在用例里等到第二轮轮询。
   */
  intervalMs?: number;
}) {
  useEffect(() => {
    let cancelled = false;
    /**
     * 在途请求标志。
     *
     * ⚠️ `setInterval` 与 `visibilitychange` 会**叠加**——切回前台时
     * 可能正好赶上一次轮询，两个请求同时打出去。在途标志让后到的那个
     * 直接跳过（这一轮的结果马上就能拿到）。
     */
    let inFlight = false;

    /** 拉一次主题并写进 CSS 变量 */
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch('/api/theme', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as { tokens?: ThemeTokenValues };
        if (!payload.tokens) return;
        if (cancelled) return;
        applyTokens(payload.tokens);
      } catch {
        // 拉不到主题不影响页面：静默失败。
        //
        // ⚠️ 保留下来的是**客户端最后一次成功拉到的值**——
        // 它**可能比服务端注入的那份更新**（服务端注入的那份是页面
        // 渲染时的快照，本来就可能已过时）。所以这里不是「以服务端为准」。
      } finally {
        inFlight = false;
      }
    }

    const timer = setInterval(refresh, intervalMs);

    // 切回前台时立即查一次——后台标签页的定时器会被浏览器节流，
    // 用户切回来时立刻拿到最新主题，感知延迟 < 1 秒。
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 首次也查一次——服务端注入的那份可能是几秒前的
    void refresh();

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs]);

  return null;
}

/**
 * 上一次写入 DOM 的主题内容的序列化结果。
 *
 * ⚠️ **变更检测**（设计文档 §4.4.3 的「变更检测」行）：
 * 轮询间隔 30 秒，若每次都重写全部 CSS 变量，就会**每次轮询都触发
 * 全页样式重算**——与「主题没变就不动 DOM」的设计意图相悖。
 *
 * 用序列化后的字符串比较（而不是逐字段深比较）——序列化一次、比较一次，
 * 成本远低于一次深比较。⚠️ `JSON.stringify` 对键序敏感，
 * 后端返回的对象键序是稳定的；若要完全免疫，先对 keys 排序。
 *
 * ⚠️ 这是**模块级**变量，组件卸载后不清空——这是**对的**：
 * 新挂载的组件第一次拉取时，如果主题与上次相同，
 * 就**不需要**重写 DOM（服务端注入的那份还在，或上次的行内样式还在）。
 */
let lastApplied: string | null = null;

/** 把 token 序列化成一个可比较的字符串 */
function serializeTokens(tokens: ThemeTokenValues): string {
  return JSON.stringify({
    colors: tokens.colors ?? {},
    radius: tokens.radius,
    fontSans: tokens.fontSans,
    fontMono: tokens.fontMono,
    textScale: tokens.textScale ?? {},
    weights: tokens.weights ?? {},
    spacing: tokens.spacing ?? {},
    shadows: tokens.shadows ?? {},
  });
}

/**
 * 顶层标量里**只写 radius**，不写 fontSans / fontMono。
 *
 * ⚠️ **字体 token 的行为与其它 token 不一致**（设计文档 §5.2 的 L21）。
 * 这里说清楚事实，不假装它们一样：
 *
 * - `globals.css` 第 10 行是 `--font-sans: var(--font-sans)`——**自引用**。
 *   编译产物里它落在 `@layer theme{:host,:root{--font-sans:var(--font-sans)}}`，
 *   是个**循环引用** → 计算值阶段无效。
 * - `globals.css` 第 128 行的 `html { @apply font-sans }` 编译成
 *   `html{font-family:var(--font-sans)}`，而 `--font-geist-sans` 由 next/font
 *   通过 `.__variable_*` 类挂在 **`<body>` 上**（`src/app/layout.tsx` 第 28 行）
 *   ——它只在 body 子树里存在，**root 作用域看不到**。
 * - 所以**服务端注入的那份 `--font-sans` 本来就不生效**（商家改字体，
 *   前台看不到变化）。客户端若写行内 `--font-sans: var(--font-geist-sans)`，
 *   值里的 `--font-geist-sans` 在 root 作用域同样不存在 → 仍然无效，
 *   只是把 `getComputedStyle` 读到的值从「无效/回退」变成了「字面量文本」。
 *
 * 结论：写它**没有任何视觉收益**，却会改变可观察状态。
 * 所以这里**排除出客户端注入范围**。⚠️ 若将来把 `--font-geist-sans`
 * 也挂到 `<html>` 上、并且去掉 globals.css 里的自引用，
 * 这一条就可以放开了——但那要先改服务端，两端要一起改。
 */
const CLIENT_SCALAR_KEYS = ['radius'] as const;

/**
 * 把 token 写进 documentElement 的行内样式。
 *
 * ⚠️ **只写 CSS_VARS 里认识的名字**（护栏 12）。
 * 后端已经过滤过一次（ThemeService.sanitize），但客户端这条路是新开的，
 * 再收一道白名单——`setProperty` 的键名非法时 CSSOM 会忽略它，
 * 但白名单是更明确、更可测的防线。
 */
function applyTokens(tokens: ThemeTokenValues) {
  // ⚠️ 变更检测：主题没变就不动 DOM（失败注入 #13 的挂点）。
  const serialized = serializeTokens(tokens);
  if (serialized === lastApplied) return;
  lastApplied = serialized;

  const style = document.documentElement.style;

  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    style.setProperty(vars[0], value);
  }

  for (const key of CLIENT_SCALAR_KEYS) {
    const value = tokens[key];
    const vars = CSS_VARS[key];
    if (!vars || typeof value !== 'string') continue;
    style.setProperty(vars[0], value);
  }

  // 分组标量：键名是「前缀 + 键」拼出来的
  //
  // ⚠️ 这四组（--text-* / --spacing-* / --shadow-* / --font-weight-*）
  // **在前台没有任何消费者**——`globals.css` 的 `@theme inline` 块
  // 只映射 colors / radius / fonts。写与不写，视觉完全一样。
  //
  // 那为什么还写？理由是「**写了无害但也无用**」：保留写入以**对齐服务端
  // 行为**（`buildThemeCss` 会写全部 token），成本为零，将来 CSS 侧接上
  // 消费者时不需要再改客户端。⚠️ **不是**「不写会更糟」——那个前提不成立。
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
      style.setProperty(`${prefix}${key}`, value);
    }
  }
}
