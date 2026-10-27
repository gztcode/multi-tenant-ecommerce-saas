'use client';

import { useEffect } from 'react';
import {
  CSS_VARS,
  GROUP_CSS_VARS,
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
 * 服务端注入的是 `:root { --brand-primary: ... }`。
 * CSS 的**行内样式优先级高于任何样式表规则**，所以
 * `documentElement.style.setProperty('--brand-primary', v)` 会**覆盖** `:root`
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
 * 顶层标量里写哪些：圆角 + 两个字体。
 *
 * ⚠️ **字体现在能生效了**（5d 之前不能）：
 * - `globals.css` 的 `@theme inline` 里 `--font-sans` 的自引用已去掉；
 * - next/font 的 `--font-geist-sans` 已从 `<body>` 挪到 `<html>`，
 *   所以 `:root` 作用域解析得到它；
 * - 自定义属性在**声明元素处**替换 —— 留在 `<body>` 上时 `<html>` 取不到值，
 *   body 的同名变量也不会来补救。
 *
 * 商家改字体 → 前台的 `font-family` 真的会变 → 所以字体也要写。
 */
const CLIENT_SCALAR_KEYS = ['radius', 'fontSans', 'fontMono'] as const;

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

  // 分组标量：组 → 键 → CSS 变量名的**显式映射**。
  //
  // ⚠️ 映射即白名单：键不在映射里就不写，键名逃不出 CSS 声明。
  for (const [group, mapping] of Object.entries(GROUP_CSS_VARS)) {
    const values = tokens[group as keyof ThemeTokenValues] as
      | Record<string, string>
      | undefined;
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      const varName = mapping[key];
      if (!varName) continue;
      style.setProperty(varName, value);
    }
  }
}
