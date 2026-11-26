/**
 * 三个 `.tsx` 的冒烟测试：能不能渲染、有没有预期文案、服务端渲染会不会炸。
 *
 * ⚠️ **不引 jsdom / testing-library**：这三处只需要「渲染出来是那几句话」，
 *    `renderToStaticMarkup` 在 node 环境就够；本包的 session-sync 反而依赖
 *    jsdom 没有、node 有的 `BroadcastChannel`。
 *
 * ⚠️ 重点是**服务端渲染不抛**：`global-error` 是根级错误边界，
 *    它自己再抛错，用户看到的就是浏览器的白屏。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import AppError from '../src/app-error';
import GlobalError from '../src/global-error';
import { createSessionSyncComponent } from '../src/session-sync-component';

const error = new Error('页面炸了');
const reset = () => {};

describe('app-error（段落级错误边界）', () => {
  it('渲染出标题、说明与重试按钮', () => {
    const html = renderToStaticMarkup(<AppError error={error} reset={reset} />);

    expect(html).toContain('页面出错了');
    expect(html).toContain('页面加载时出了点问题');
    expect(html).toContain('重试');
    expect(html).toContain('<button');
  });

  it('⚠️ 不把原始错误信息渲染给用户（可能含内部细节）', () => {
    const html = renderToStaticMarkup(<AppError error={error} reset={reset} />);

    expect(html).not.toContain('页面炸了');
  });
});

describe('global-error（根级错误边界）', () => {
  it('自带 html/body（根布局已崩时也能显示）', () => {
    const html = renderToStaticMarkup(<GlobalError error={error} reset={reset} />);

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<body');
  });

  it('渲染出标题、说明与重试按钮', () => {
    const html = renderToStaticMarkup(<GlobalError error={error} reset={reset} />);

    expect(html).toContain('应用出错了');
    expect(html).toContain('页面遇到了一个意外错误');
    expect(html).toContain('重试');
    expect(html).not.toContain('页面炸了');
  });
});

describe('session-sync-component', () => {
  it('渲染为 null（不占位、不布局）', () => {
    const createSync = vi.fn(() => ({ start: async () => 'skipped' as const, stop: vi.fn() }));
    const SessionSync = createSessionSyncComponent(createSync);

    expect(renderToStaticMarkup(<SessionSync />)).toBe('');
  });

  it('⚠️ 服务端渲染阶段不创建同步器（也不发请求：副作用只在 useEffect 里）', () => {
    const createSync = vi.fn(() => ({ start: async () => 'skipped' as const, stop: vi.fn() }));
    const SessionSync = createSessionSyncComponent(createSync);

    renderToStaticMarkup(<SessionSync />);

    expect(createSync).not.toHaveBeenCalled();
  });
});
