// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { CartList } from '@/components/cart/cart-list';

function cart(quantity: number) {
  return {
    id: 'cart-1',
    items: [
      {
        id: 'item-1',
        skuId: 'sku-1',
        quantity,
        sku: { id: 'sku-1', price: 1000, product: { id: 'p1', name: '商品' } },
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('购物车列表', () => {
  it('加载失败 → 显示错误，不谎报空车', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ message: '网络连接失败' }, 503),
      ),
    );
    render(<CartList />);
    expect(await screen.findByText('网络连接失败')).toBeTruthy();
    expect(screen.queryByText('购物车是空的。')).toBeNull();
  });

  it('重试按钮真的重取（不是 router.refresh）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: '网络连接失败' }, 503))
      .mockResolvedValueOnce(jsonResponse(cart(2)));
    vi.stubGlobal('fetch', fetchMock);

    render(<CartList />);
    const retry = await screen.findByRole('button', { name: '重试' });
    await userEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByDisplayValue('2')).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('改数量失败 → 输入框回到服务端数量', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cart(2)))
      .mockResolvedValueOnce(jsonResponse({ message: '改数量失败' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    render(<CartList />);
    const input = await screen.findByLabelText('商品 的数量');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.tab(); // 触发 blur

    expect(await screen.findByText('改数量失败')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByDisplayValue('2')).toBeTruthy();
    });
  });

  it('改数量成功 → 输入框显示新值', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cart(2)))
      .mockResolvedValueOnce(jsonResponse(cart(3)));
    vi.stubGlobal('fetch', fetchMock);

    render(<CartList />);
    const input = await screen.findByLabelText('商品 的数量');
    await userEvent.clear(input);
    await userEvent.type(input, '3');
    await userEvent.tab();

    await waitFor(() => {
      expect(screen.getByDisplayValue('3')).toBeTruthy();
    });
  });
});
