// @vitest-environment jsdom
/**
 * 商品卡片的护栏测试（审计 P2 工程债）。
 *
 * `ProductCard` 是纯展示组件：只读 `product` 渲染链接、封面、名称、副标题与价格，
 * 无 fetch / router。因此**不需要 mock 任何东西**——`next/link` 在 vitest node
 * 环境下直接可用，`formatPrice` 是纯函数。
 *
 * ⚠️ **断言要具体**：断言 `<a>` 的 href、`<img>` 的 src/alt、价格文本，
 * 不是「界面上出现了某句话」。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProductCard } from '@/components/product/product-card';
import type { PublicProductCard } from '@/lib/catalog';

/**
 * 造一份商品卡片。
 *
 * 形状照 `storefront/src/lib/catalog.ts` 的 `PublicProductCard`。
 */
function makeProduct(
  overrides: Partial<PublicProductCard> = {},
): PublicProductCard {
  return {
    id: 'p1',
    name: '重磅纯棉T恤',
    slug: 'cotton-tee',
    subtitle: '220g 重磅面料',
    minPrice: 12900,
    publishedAt: '2026-10-01T00:00:00Z',
    category: { id: 'cat-1', name: '男装', slug: 'menswear' },
    media: [
      { sort: 0, media: { id: 'm-1', url: '/uploads/cover.jpg', mime: 'image/jpeg' } },
    ],
    ...overrides,
  };
}

describe('商品卡片', () => {
  it('整张卡片是链接，指向 /p/{slug}', () => {
    render(<ProductCard product={makeProduct()} />);

    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/p/cotton-tee');
  });

  it('有封面时渲染 <img>，src 取第一张媒体、alt 是商品名', () => {
    render(<ProductCard product={makeProduct()} />);

    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/uploads/cover.jpg');
    expect(img.getAttribute('alt')).toBe('重磅纯棉T恤');
  });

  it('无封面时显示「暂无图片」，且不渲染 <img>', () => {
    render(<ProductCard product={makeProduct({ media: [] })} />);

    expect(screen.getByText('暂无图片')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('渲染名称、副标题与格式化后的价格', () => {
    render(<ProductCard product={makeProduct()} />);

    expect(screen.getByRole('heading', { name: '重磅纯棉T恤' })).toBeTruthy();
    expect(screen.getByText('220g 重磅面料')).toBeTruthy();
    expect(screen.getByText('¥129.00')).toBeTruthy();
  });

  it('副标题为 null 时不渲染副标题段落', () => {
    render(<ProductCard product={makeProduct({ subtitle: null })} />);

    expect(screen.getByRole('heading', { name: '重磅纯棉T恤' })).toBeTruthy();
    expect(screen.queryByText('220g 重磅面料')).toBeNull();
  });
});
