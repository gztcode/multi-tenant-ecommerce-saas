// @vitest-environment jsdom
/**
 * 冒烟测试：确认 jsdom 环境与 React 渲染都真的生效。
 *
 * 护栏 1：组件测试真的在渲染。若这行环境注释被漏掉，
 * 这里会报 "document is not defined"——报错直白，不会静默跑偏。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('组件测试基建', () => {
  it('能渲染一个组件并查到它的文本', () => {
    render(<p>店铺前台</p>);
    expect(screen.getByText('店铺前台')).toBeTruthy();
  });

  it('jsdom 真的生效了（有 document 与 window）', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });
});
