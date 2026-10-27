// @vitest-environment jsdom
/**
 * 结算页的**错误态**。
 *
 * ## 为什么这条用例必须存在
 *
 * 结算页原来这样写：
 *   `if (!cart || cart.items.length === 0) redirect('/cart')`
 * 而 `fetchCurrentCart()` 在后端不可达时返回 `{ cart: null, error: '…' }`
 * —— 页面不读 error，直接把 `cart === null` 当成「空购物车」→
 * **把用户弹回购物车页，错误信息在跳转中丢失**。
 *
 * 用户看到的是「购物车是空的」，而真实原因是「后端连不上」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { redirectMock, fetchCurrentCart, fetchAddresses, fetchCouponPreview } =
  vi.hoisted(() => ({
    redirectMock: vi.fn(),
    fetchCurrentCart: vi.fn(),
    fetchAddresses: vi.fn(),
    fetchCouponPreview: vi.fn(),
  }));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ accessToken: 'tok' })) }));
vi.mock('@/lib/shop-api', () => ({
  fetchCurrentCart: (...args: unknown[]) => fetchCurrentCart(...args),
  fetchAddresses: (...args: unknown[]) => fetchAddresses(...args),
  fetchCouponPreview: (...args: unknown[]) => fetchCouponPreview(...args),
}));
// CheckoutForm 是客户端组件，测试里不需要它
vi.mock('@/components/checkout/checkout-form', () => ({
  CheckoutForm: () => null,
}));

async function renderCheckout() {
  const Page = (await import('@/app/(shop)/checkout/page')).default;
  const ui = await Page();
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchCurrentCart.mockResolvedValue({
    cart: { items: [{ skuId: 'sku-1', quantity: 1 }] },
    error: null,
  });
  fetchAddresses.mockResolvedValue({ addresses: [], error: null });
  fetchCouponPreview.mockResolvedValue({ preview: null });
});

describe('结算页的错误态', () => {
  it('购物车加载失败 → 显示错误，不跳回购物车页', async () => {
    fetchCurrentCart.mockResolvedValue({
      cart: null,
      error: '网络连接失败，请检查网络后重试',
    });

    await renderCheckout();

    expect(
      screen.getByText('网络连接失败，请检查网络后重试'),
    ).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('地址加载失败 → 显示错误，不跳回购物车页', async () => {
    fetchAddresses.mockResolvedValue({
      addresses: [],
      error: '地址簿加载失败',
    });

    await renderCheckout();

    expect(screen.getByText('地址簿加载失败')).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('购物车真的是空的 → 跳回购物车页', async () => {
    fetchCurrentCart.mockResolvedValue({ cart: { items: [] }, error: null });

    await renderCheckout();

    expect(redirectMock).toHaveBeenCalledWith('/cart');
  });
});
