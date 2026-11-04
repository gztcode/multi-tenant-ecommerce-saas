// @vitest-environment jsdom
/**
 * 商品详情页：只有 404 才是「商品不存在」；后端故障要渲染错误态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { notFoundMock, fetchPublicProduct } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  fetchPublicProduct: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'demo.platform.test' }),
}));
// 页面会 import @/lib/api-client 的 ApiError；该薄壳顶层 import @/auth，
// 不 mock 会把 next-auth 整个依赖图拉进 jsdom。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/catalog', () => ({ fetchPublicProduct }));
vi.mock('@/components/product/spec-selector', () => ({
  SpecSelector: () => null,
}));

import { ApiError } from '@/lib/api-client';

async function renderPage(slug = 'p1') {
  const Page = (await import('@/app/(shop)/p/[slug]/page')).default;
  const ui = await Page({ params: Promise.resolve({ slug }) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('商品详情页的错误态', () => {
  it('后端 404 → notFound()', async () => {
    fetchPublicProduct.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', '商品不存在'),
    );
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('后端故障 → 渲染错误与重试，不 notFound()', async () => {
    fetchPublicProduct.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('missing');

    expect(
      screen.getByText('网络连接失败，请检查网络后重试'),
    ).toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '重试' }).getAttribute('href')).toBe(
      '/p/missing',
    );
    expect(screen.getByRole('link', { name: '返回首页' }).getAttribute('href')).toBe(
      '/',
    );
  });
});
