// @vitest-environment jsdom
/**
 * 错误边界的兜底文案。
 *
 * ## 为什么要有
 *
 * 三个应用此前**零错误边界**（没有 `error.tsx` / `global-error.tsx`）。
 * 一个未捕获的渲染异常 → 整页白屏 + 浏览器默认的英文报错堆栈。
 * 消费者看到的是「Something went wrong」—— 对电商前台是不可接受的。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import ErrorPage from '@/app/error';
import GlobalError from '@/app/global-error';

describe('错误边界', () => {
  it('error.tsx 显示中文提示并提供「重试」', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('boom')} reset={reset} />);

    expect(screen.getByText(/出错了/).textContent).toContain('出错了');
    // ⚠️ 不能把原始错误信息糊给用户
    expect(document.body.textContent).not.toContain('boom');
    const button = screen.getByRole('button', { name: '重试' });
    button.click();
    expect(reset).toHaveBeenCalled();
  });

  it('global-error.tsx 自带 html/body 且显示中文提示', () => {
    // ⚠️ global-error 不能用 app 的 layout，所以它自己带 <html><body>。
    //    用 renderToStaticMarkup 而不是 RTL 的 render —— RTL 往 body 里塞
    //    一个 div，而 <html> 塞进 div 是非法 DOM。
    const html = renderToStaticMarkup(
      <GlobalError error={new Error('boom')} reset={vi.fn()} />,
    );

    expect(html).toContain('<html');
    expect(html).toContain('<body');
    expect(html).toContain('出错了');
    expect(html).toContain('重试');
    // ⚠️ 不能把原始错误信息糊给用户
    expect(html).not.toContain('boom');
  });
});
