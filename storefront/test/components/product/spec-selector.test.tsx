// @vitest-environment jsdom
/**
 * 护栏 2：「加入购物车」按钮的组件测试。
 *
 * 阶段 3 补上这个按钮后**没测过**（当时没有 jsdom / Testing Library），
 * 手测时又挖出 3 个 bug。本文件把那 3 类行为锁住。
 *
 * ⚠️ **断言要具体**：断言 URL + method + body，不是「界面上出现了某句话」。
 * 只断言界面文字的测试，换掉请求体照样通过——那是恒真断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SpecSelector } from '@/components/product/spec-selector';
import type { PublicProductDetail } from '@/lib/catalog';

/**
 * 造一份商品详情。
 *
 * 形状照 `storefront/src/lib/catalog.ts` 的 `PublicProductDetail`：
 * 两个规格维度（颜色 / 尺码），两个 SKU（黑色有货、白色缺货）。
 */
function makeProduct(
  overrides: Partial<PublicProductDetail> = {},
): PublicProductDetail {
  return {
    id: 'p1',
    name: '重磅纯棉T恤',
    slug: 'cotton-tee',
    subtitle: null,
    description: null,
    attributes: {},
    minPrice: 12900,
    publishedAt: '2026-10-01T00:00:00Z',
    category: null,
    media: [],
    specs: [
      {
        id: 'spec-color',
        name: '颜色',
        sort: 0,
        values: [
          { id: 'v-black', value: '黑色', sort: 0 },
          { id: 'v-white', value: '白色', sort: 1 },
        ],
      },
      {
        id: 'spec-size',
        name: '尺码',
        sort: 1,
        values: [{ id: 'v-m', value: 'M', sort: 0 }],
      },
    ],
    skus: [
      {
        id: 'sku-black-m',
        price: 12900,
        comparePrice: null,
        stock: 50,
        specValues: [{ valueId: 'v-black' }, { valueId: 'v-m' }],
      },
      {
        id: 'sku-white-m',
        price: 12900,
        comparePrice: null,
        stock: 0,
        specValues: [{ valueId: 'v-white' }, { valueId: 'v-m' }],
      },
    ],
    ...overrides,
  };
}

/** 造一个成功的 fetch 响应 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('「加入购物车」按钮', () => {
  it('没选规格时按钮不可用，并提示先选规格', () => {
    render(<SpecSelector product={makeProduct()} />);

    const button = screen.getByRole('button', { name: '加入购物车' });
    expect(button).toBeDisabled();
    expect(screen.getByText('请先选择商品规格。')).toBeTruthy();
  });

  it('选好规格后按钮可用', async () => {
    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));

    expect(screen.getByRole('button', { name: '加入购物车' })).not.toBeDisabled();
  });

  it('点按钮后调 POST /api/cart/items，且请求体带 skuId 与数量', async () => {
    // ⚠️ 关键断言：URL + method + body 都要断言。
    // 只断言「界面上出现了『已加入购物车』」的话，把 body 里的 skuId
    // 换成别的也照样通过——那是恒真断言。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: '加入购物车' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cart/items');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      skuId: 'sku-black-m',
      quantity: 1,
    });
  });

  it('成功后显示「已加入购物车。」与去购物车的链接', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: '加入购物车' }));

    expect(await screen.findByText('已加入购物车。')).toBeTruthy();
    const link = screen.getByRole('link', { name: '去购物车' });
    expect(link.getAttribute('href')).toBe('/cart');
  });

  it('失败时透出后端返回的 message，而不是笼统的「加入购物车失败」', async () => {
    // 阶段 3 验收场景 3 实测过后端返回
    // {"message":"商品不可售或不存在","code":"VALIDATION_FAILED"}
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { message: '商品不可售或不存在', code: 'VALIDATION_FAILED' },
          400,
        ),
      ),
    );

    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));
    await user.click(screen.getByRole('button', { name: '加入购物车' }));

    expect(await screen.findByText('商品不可售或不存在')).toBeTruthy();
    expect(screen.queryByText('加入购物车失败')).toBeNull();
  });

  it('缺货的规格不能加购', async () => {
    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '白色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));

    expect(screen.getByRole('button', { name: '加入购物车' })).toBeDisabled();
    expect(screen.getByText('该商品暂时缺货。')).toBeTruthy();
  });

  it('数量输入超过上限时夹到 99', async () => {
    const user = userEvent.setup();
    render(<SpecSelector product={makeProduct()} />);

    await user.click(screen.getByRole('button', { name: '黑色' }));
    await user.click(screen.getByRole('button', { name: 'M' }));

    const input = screen.getByLabelText('购买数量') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '150');

    await waitFor(() => expect(input.value).toBe('99'));
  });

  it('没有规格的商品可以直接加购', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const product = makeProduct({
      specs: [],
      skus: [
        {
          id: 'sku-plain',
          price: 5000,
          comparePrice: null,
          stock: 10,
          specValues: [],
        },
      ],
    });

    const user = userEvent.setup();
    render(<SpecSelector product={product} />);

    const button = screen.getByRole('button', { name: '加入购物车' });
    expect(button).not.toBeDisabled();
    await user.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      skuId: 'sku-plain',
      quantity: 1,
    });
  });
});
