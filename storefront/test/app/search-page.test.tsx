// @vitest-environment jsdom
/**
 * 搜索页：后端故障渲染错误与重试；只有取数成功但结果为空才说「没有找到」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { fetchPublicProducts } = vi.hoisted(() => ({
  fetchPublicProducts: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'demo.platform.test' }),
}));
// 页面会 import @/lib/api-client 的 ApiError；该薄壳顶层 import @/auth，
// 不 mock 会把 next-auth 整个依赖图拉进 jsdom。
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/catalog', () => ({ fetchPublicProducts }));

import { ApiError } from '@/lib/api-client';

async function renderPage(q: string) {
  const Page = (await import('@/app/(shop)/search/page')).default;
  const ui = await Page({ searchParams: Promise.resolve({ q }) });
  return render(ui);
}

beforeEach(() => vi.clearAllMocks());

describe('搜索页的错误态', () => {
  it('后端故障 → 错误 + 重试，不谎报「没有找到」', async () => {
    fetchPublicProducts.mockRejectedValue(
      new ApiError(503, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试'),
    );
    await renderPage('测试 鞋');

    expect(screen.getByText('网络连接失败，请检查网络后重试')).toBeTruthy();
    expect(screen.queryByText('没有找到相关商品。')).toBeNull();
    expect(screen.getByRole('link', { name: '重试' }).getAttribute('href')).toBe(
      `/search?q=${encodeURIComponent('测试 鞋')}`,
    );
  });

  it('后端正常但结果为空 → 显示「没有找到」', async () => {
    fetchPublicProducts.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 48,
    });
    await renderPage('测试');

    expect(screen.getByText('没有找到相关商品。')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '重试' })).toBeNull();
  });
});
