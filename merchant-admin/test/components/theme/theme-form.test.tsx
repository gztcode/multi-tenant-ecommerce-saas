// @vitest-environment jsdom
/**
 * 商家后台的主题**实时预览**。
 *
 * ## 为什么预览要隔离
 *
 * CSS 变量是**继承**的 → 在预览区外面包一个带内联 `--brand-*` 的 wrapper，
 * 内联变量只在这个子树里生效 → **后台页面自身的按钮不会被染色**。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ThemeForm, type ThemeSchema } from '@/components/theme/theme-form';

const SCHEMA: ThemeSchema = {
  colors: [
    { key: 'primary', label: '主色', cssVar: '--brand-primary', defaultValue: 'oklch(0.205 0 0)' },
    { key: 'background', label: '背景色', cssVar: '--brand-background', defaultValue: 'oklch(1 0 0)' },
  ],
  radius: { key: 'radius', label: '圆角', cssVar: '--brand-radius', defaultValue: '0.625rem' },
  fonts: [
    { key: 'fontSans', label: '正文字体', cssVar: '--brand-font-sans', defaultValue: 'var(--font-geist-sans)' },
  ],
  textScale: [{ key: 'sm', label: '小', cssVar: '--brand-text-sm', defaultValue: '0.875rem' }],
  weights: [{ key: 'semibold', label: '半粗', cssVar: '--brand-font-weight-semibold', defaultValue: '600' }],
  spacing: [{ key: 'base', label: '间距密度', cssVar: '--brand-spacing', defaultValue: '0.25rem' }],
  shadows: [{ key: 'lg', label: '重', cssVar: '--brand-shadow-lg', defaultValue: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }],
};

const INITIAL = {
  colors: { primary: 'oklch(0.205 0 0)', background: 'oklch(1 0 0)' },
  radius: '0.625rem',
  fontSans: 'var(--font-geist-sans)',
  textScale: { sm: '0.875rem' },
  weights: { semibold: '600' },
  spacing: { base: '0.25rem' },
  shadows: { lg: '0 10px 15px -3px rgb(0 0 0 / 0.1)' },
};

describe('主题表单的实时预览', () => {
  it('初始状态就把全部 token 写进预览区的内联变量', () => {
    render(<ThemeForm schema={SCHEMA} initial={INITIAL} onSave={vi.fn()} />);

    const preview = screen.getByTestId('theme-preview');
    expect(preview.style.getPropertyValue('--brand-primary')).toBe('oklch(0.205 0 0)');
    expect(preview.style.getPropertyValue('--brand-radius')).toBe('0.625rem');
    expect(preview.style.getPropertyValue('--brand-font-sans')).toBe('var(--font-geist-sans)');
    expect(preview.style.getPropertyValue('--brand-text-sm')).toBe('0.875rem');
    expect(preview.style.getPropertyValue('--brand-font-weight-semibold')).toBe('600');
    expect(preview.style.getPropertyValue('--brand-spacing')).toBe('0.25rem');
    expect(preview.style.getPropertyValue('--brand-shadow-lg')).toBe(
      '0 10px 15px -3px rgb(0 0 0 / 0.1)',
    );
  });

  it('改主色 → 预览区立刻变，而页面自身的按钮不变色', () => {
    render(<ThemeForm schema={SCHEMA} initial={INITIAL} onSave={vi.fn()} />);

    const input = screen.getByLabelText('主色');
    fireEvent.change(input, { target: { value: 'oklch(0.7 0.19 40)' } });

    const preview = screen.getByTestId('theme-preview');
    expect(preview.style.getPropertyValue('--brand-primary')).toBe('oklch(0.7 0.19 40)');

    // 页面自身的「保存主题」按钮在预览区之外 → 不受影响
    const saveButton = screen.getByRole('button', { name: '保存主题' });
    expect(saveButton.style.getPropertyValue('--brand-primary')).toBe('');
    expect(saveButton.closest('[style]')?.getAttribute('style') ?? '').not.toContain(
      '--brand-primary',
    );
  });

  it('改字阶 → 预览区的 --brand-text-sm 跟着变', () => {
    render(<ThemeForm schema={SCHEMA} initial={INITIAL} onSave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('小'), {
      target: { value: '1rem' },
    });

    const preview = screen.getByTestId('theme-preview');
    expect(preview.style.getPropertyValue('--brand-text-sm')).toBe('1rem');
  });
});
