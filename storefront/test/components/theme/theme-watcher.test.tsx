// @vitest-environment jsdom
/**
 * 护栏 10 / 11 / 12：主题轮询与客户端注入。
 *
 * ⚠️ 断言要具体：断言**写了哪个 CSS 变量、写的值是什么**，
 * 不是只断言「某个东西出现在 DOM 里」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 造一个「每次调用都返回**新** Response」的 fetch mock。
 *
 * ⚠️ **必须每次都造新的**：Response 的 body 只能读一次
 * （第二次读抛 "Body is unusable: Body has already been read"）。
 * 用 `mockResolvedValue(jsonResponse(...))` 的话，所有轮询拿到的是**同一个**
 * Response 实例 → 第二次轮询读 body 抛错 → 被组件的 catch 吞掉 →
 * 组件根本不会调 applyTokens → 「主题没变时不重写 DOM」那条用例
 * 会因为「什么都没发生」而恒真通过。
 */
function mockFetchOk(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const TOKENS = {
  colors: { primary: 'oklch(0.7 0.19 40)' },
  radius: '1.5rem',
  fontSans: 'var(--font-geist-sans)',
  fontMono: 'var(--font-geist-mono)',
  textScale: {},
  weights: {},
  spacing: {},
  shadows: {},
};

/**
 * 动态 import ThemeWatcher。
 *
 * ⚠️ **每个用例都要重新 import**：组件里有个**模块级**的 `lastApplied`
 * （变更检测用的「上一次写入的内容」）。它在组件卸载后**故意不清空**
 * ——生产语义是对的（重新挂载时若主题没变，不必重写 DOM）。
 * 但在测试里，上一个用例已经写过同一份 TOKENS → 新用例的第一次拉取
 * 会被变更检测挡掉 → 断言「变量被写上了」就挂。
 *
 * 所以这里用 `vi.resetModules()` + 动态 import 给每个用例一份干净的模块。
 */
async function loadThemeWatcher() {
  vi.resetModules();
  const mod = await import('@/components/theme/theme-watcher');
  return mod.ThemeWatcher;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 每个用例前把行内样式清干净，别让上一个用例的残留影响断言
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThemeWatcher', () => {
  it('把主题的 CSS 变量写到 documentElement 的行内样式上', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    mockFetchOk({ tokens: TOKENS });

    render(<ThemeWatcher />);

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
    );
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('1.5rem');
  });

  it('轮询请求打在中转路由上，且明确不缓存', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    const fetchMock = mockFetchOk({ tokens: TOKENS });

    render(<ThemeWatcher />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // ⚠️ 断言要具体：URL + 选项，不是「fetch 被调用了」
    expect(fetchMock).toHaveBeenCalledWith('/api/theme', { cache: 'no-store' });
  });

  it('只写白名单里的变量名（护栏 12）', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    // 后端万一漏过滤了一个未知的 token，客户端也不能把它写进去
    mockFetchOk({
      tokens: {
        ...TOKENS,
        colors: { ...TOKENS.colors, 恶意键: 'x' },
      },
    });

    render(<ThemeWatcher />);

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
    );
    expect(document.documentElement.style.getPropertyValue('--恶意键')).toBe('');
    expect(document.documentElement.getAttribute('style')).not.toContain('恶意键');
  });

  it('拉取失败时不影响页面，也不清掉已有的主题（护栏 11）', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    // 先成功一次，主题写上去了
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ tokens: TOKENS }))
      .mockImplementation(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    // ⚠️ 传一个小间隔，否则第二轮轮询要等 30 秒（生产默认值）才发生
    render(<ThemeWatcher intervalMs={20} />);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
        'oklch(0.7 0.19 40)',
      ),
    );

    // 再失败一次，主题应该还在
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(
      'oklch(0.7 0.19 40)',
    );
  });

  it('组件卸载后不再轮询', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    const fetchMock = mockFetchOk({ tokens: TOKENS });

    const { unmount } = render(<ThemeWatcher />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();
    const callsBefore = fetchMock.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('字体 token 不写进行内样式（L21：客户端注入与服务端行为不一致）', async () => {
    const ThemeWatcher = await loadThemeWatcher();
    // ⚠️ `--font-geist-sans` 只在 next/font 挂在 <body> 上的变量作用域里存在，
    // root 作用域看不到它 → 写进去也解析不出来，纯属改变可观察状态而无视觉收益。
    // 所以 fontSans / fontMono 被**排除出客户端注入范围**。
    mockFetchOk({ tokens: TOKENS });

    render(<ThemeWatcher />);

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--radius')).toBe('1.5rem'),
    );
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('');
  });

  it('主题没变时不重写 DOM（护栏 10 的性能部分 / 失败注入 #13）', async () => {
    // ⚠️ 这是失败注入 #13 的挂点。
    // 若实现里没有变更检测（每次轮询都重写全部 CSS 变量），
    // 第二次拉取时 setProperty 还会被调用 → 这条用例会挂。
    //
    // 为什么要这条：轮询间隔 30 秒，每次都重写全部 CSS 变量
    // → 触发全页样式重算，与设计意图（§4.4.3 的「变更检测」行）相悖。
    const ThemeWatcher = await loadThemeWatcher();
    const setPropertySpy = vi.spyOn(
      CSSStyleDeclaration.prototype,
      'setProperty',
    );

    const fetchMock = mockFetchOk({ tokens: TOKENS });

    const { unmount } = render(<ThemeWatcher intervalMs={20} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 第一次写入完之后，把计数归零
    setPropertySpy.mockClear();

    // 等到轮询至少跑过一次，主题内容**完全没变**
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    expect(setPropertySpy).not.toHaveBeenCalled();

    unmount();
    setPropertySpy.mockRestore();
  });
});
