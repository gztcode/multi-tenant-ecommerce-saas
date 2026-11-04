// @vitest-environment jsdom
/**
 * 品类页：品类接口故障不能伪装成「品类不存在」；只有品类树正常但 slug 找不到才 notFound()。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { notFoundMock, fetchPublicCategories, fetchPublicProducts } =
  vi.hoisted(() => ({
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    fetchPublicCategories: vi.fn(),
    fetchPublicProducts: vi.fn(),
  }));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'demo.platform.test' }),
}));
// 页面会 import @/lib/api-client 的 ApiError；该薄壳顶层 import @/auth，
// 不 mock 会把 next-auth 整个依赖图拉进 jsdom。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/catalog', () => ({
  fetchPublicCategories,
  fetchPublicProducts,
}));

import { ApiError } from '@/lib/api-client';

async function renderPage(slug: string) {
  const Page = (await import('@/app/(shop)/c/[slug]/page')).default;
  const ui = await Page({ params: Promise.resolve({ slug }) });
  return render(ui);
}

beforeEach(() => vi.clearAllMocks());

describe('品类页的错误态', () => {
  it('品类接口故障 → 错误 + 重试，不显示「品类不存在」', async () => {
    fetchPublicCategories.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('shoes');

    expect(screen.getByText('网络连接失败，请检查网络后重试')).toBeTruthy();
    expect(screen.queryByText('品类不存在')).toBeNull();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '重试' }).getAttribute('href')).toBe(
      '/c/shoes',
    );
    expect(fetchPublicProducts).not.toHaveBeenCalled();
  });

  it('品类树正常但 slug 不存在 → notFound()', async () => {
    fetchPublicCategories.mockResolvedValue([]);
    await expect(renderPage('missing')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('商品接口故障 → 渲染错误，不 notFound()，且不谎报「还没有商品」', async () => {
    fetchPublicCategories.mockResolvedValue([
      { id: 'c1', slug: 'shoes', name: '鞋', parentId: null, children: [] },
    ]);
    fetchPublicProducts.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('shoes');

    expect(screen.getByText('网络连接失败，请检查网络后重试')).toBeTruthy();
    expect(
      screen.queryByText('这个品类下还没有上架商品。'),
    ).toBeNull();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '重试' }).getAttribute('href')).toBe(
      '/c/shoes',
    );
  });
});
