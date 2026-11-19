// @vitest-environment jsdom
/**
 * 结算表单的关键行为（P1 护栏补测）。
 *
 * ⚠️ **为什么这个文件存在**：结算页测试（`test/app/checkout-page.test.tsx`）
 * 把 `CheckoutForm` mock 成 `null`，下单写路径在测试里整个被移除。
 * 这是全站最重要的「防重复下单」护栏——幂等键在**进入页面时**生成并持有，
 * 提交失败重试**复用同一个键**。若回归成「提交时生成或失败换键」，
 * 用户超时后重试会**下成两个订单、两个订单占同一批库存**，
 * 而现有测试必然全绿（因为被 mock 掉了）。
 *
 * ⚠️ **断言要具体**：断言的是**发出去的请求体**（JSON 解析后 `toEqual`），
 * 不是「点得动」或「没报错」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckoutForm } from '@/components/checkout/checkout-form';
import type { Address, Cart } from '@/lib/cart';
import type { CouponPreview } from '@/lib/coupon';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

// 结算页未登录时 `showAddressForm` 初始为 `addresses.length === 0`，
// 会渲染 AddressForm 触发它自己的 fetch——mock 掉避免干扰。
vi.mock('@/components/address/address-form', () => ({
  AddressForm: () => null,
}));

/** 造一个确定性的 `crypto.randomUUID`（jsdom 的 crypto 可能没有这个方法） */
function stubCrypto(returnValue = 'key-1') {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn().mockReturnValue(returnValue),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ADDRESS: Address = {
  id: 'addr-1',
  receiver: '张三',
  phone: '13800138000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文一西路 100 号',
  isDefault: true,
};

const CART: Cart = {
  id: 'cart-1',
  tenantId: 't1',
  customerId: 'c1',
  guestToken: null,
  items: [
    {
      id: 'item-1',
      skuId: 'sku-1',
      quantity: 2,
      sku: { id: 'sku-1', price: 1000, product: { id: 'p1', name: '测试商品' } },
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const PREVIEW: CouponPreview = {
  originalAmount: 2000,
  promotionDiscountAmount: 0,
  promotionName: null,
  coupons: [
    {
      id: 'coupon-1',
      code: 'CODE-1',
      name: '满 100 减 10',
      type: 'FIXED',
      value: 1000,
      minAmount: 0,
      discountAmount: 1000,
      payableAmount: 1000,
    },
  ],
  bestCouponId: null,
  bestCouponDiscountAmount: 0,
  payableAmount: 2000,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('结算表单', () => {
  it('首次提交：发 POST /api/orders，body 带幂等键，且空串券不传 couponId（护栏 M17）', async () => {
    stubCrypto('key-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ orderNo: 'NO-1' }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn
        preview={PREVIEW}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orders');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      addressId: 'addr-1',
      items: [{ skuId: 'sku-1', quantity: 2 }],
      idempotencyKey: 'key-1',
      // ⚠️ 默认券是空串（自动选最优），护栏 M17：**不传 couponId**，
      // 否则后端收到没有 couponId 的请求时会自己挑最优——这里断言
      // body 里没有 couponId 字段（toEqual 精确匹配）。
    });
    expect(pushMock).toHaveBeenCalledWith('/orders/NO-1');
  });

  it('选具体券后提交：couponId 带进去，且改券不换幂等键', async () => {
    stubCrypto('key-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ orderNo: 'NO-1' }))
      .mockResolvedValueOnce(jsonResponse({ orderNo: 'NO-2' }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn
        preview={PREVIEW}
      />,
    );

    // 第一次：默认空串（自动最优）提交
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));
    // 改选具体券
    await userEvent.selectOptions(screen.getByLabelText('优惠券'), 'coupon-1');
    // 第二次提交
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const body2 = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    // ⚠️ 幂等键在 state 里持有，改券不换键——同一键 = 同一次下单尝试
    expect(body2.idempotencyKey).toBe(body1.idempotencyKey);
    expect(body2.couponId).toBe('coupon-1');
  });

  it('提交失败后再提交：复用同一个幂等键（防重复下单）', async () => {
    stubCrypto('key-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: '库存不足' }, 500))
      .mockResolvedValueOnce(jsonResponse({ orderNo: 'NO-2' }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn
        preview={PREVIEW}
      />,
    );

    // 第一次失败
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));
    expect(await screen.findByText('库存不足')).toBeTruthy();
    // 第二次重试成功
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const body2 = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(body2.idempotencyKey).toBe(body1.idempotencyKey);
  });

  it('提交成功后清掉幂等键（下一次结算是新的尝试）', async () => {
    stubCrypto('key-1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ orderNo: 'NO-1' })),
    );

    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn
        preview={PREVIEW}
      />,
    );

    // 提交前：effect 已经把键写进 sessionStorage
    expect(window.sessionStorage.getItem('checkout.idempotencyKey')).toBe(
      'key-1',
    );
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));

    // ⚠️ 语义断言而不是 spy：jsdom 的 sessionStorage 方法在实例上且不可写，
    //    `vi.spyOn` 换不掉。断言「键被清掉」直接反映成功路径的语义。
    expect(window.sessionStorage.getItem('checkout.idempotencyKey')).toBeNull();
  });

  it('未登录：显示「下单需要先登录」，不渲染提交按钮', () => {
    stubCrypto('key-1');
    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn={false}
        preview={null}
      />,
    );

    expect(screen.getByText('下单需要先登录。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去登录' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '提交订单' })).toBeNull();
  });

  it('后端 500：显示后端 message，不跳转', async () => {
    stubCrypto('key-1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: '优惠券不可用' }, 500)),
    );

    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn
        preview={PREVIEW}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '提交订单' }));

    expect(await screen.findByText('优惠券不可用')).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('幂等键还没生成时提交被拦下（按钮禁用，不发请求）', async () => {
    // randomUUID 返回空串 → 键保持空 → 按钮禁用
    stubCrypto('');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CheckoutForm
        cart={CART}
        addresses={[ADDRESS]}
        loggedIn
        preview={PREVIEW}
      />,
    );

    const submit = screen.getByRole('button', { name: '提交订单' });
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
