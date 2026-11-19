// @vitest-environment jsdom
/**
 * 消费者订单详情的关键行为（P1 护栏补测）。
 *
 * ⚠️ **为什么这个文件存在**：订单详情承载「去支付」「取消订单」「确认收货」
 * 三个写操作与金额快照展示，此前零测试。最危险的是**支付跳转**——
 * 支付页面是**站外**地址（另一个服务），若回归成 `router.push`，
 * 客户端导航管不了站外 URL，支付页打不开，而 tsc / next build 都过。
 *
 * ⚠️ **断言要具体**：支付断言 `window.location.assign` 收到完整 payUrl；
 * 取消/确认收货断言 `fetch` 收到正确 URL 与 body；confirm 取消时不发请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrderDetail } from '@/components/order/order-detail';
import type { Order } from '@/lib/cart';

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

/** 造订单 fixture（默认待支付，含金额快照） */
function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    orderNo: 'NO-1',
    customerId: 'c1',
    status: 'PENDING_PAYMENT',
    totalAmount: 1900,
    originalAmount: 2000,
    promotionDiscountAmount: 0,
    couponDiscountAmount: 100,
    couponId: 'coupon-1',
    couponCode: 'CODE-1',
    couponName: '满 100 减 10',
    itemCount: 2,
    receiverName: '张三',
    receiverPhone: '13800138000',
    province: '浙江省',
    city: '杭州市',
    district: '西湖区',
    detail: '文一西路 100 号',
    remark: '请放门口',
    payChannel: null,
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    cancelledAt: null,
    trackingNo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      {
        id: 'oi1',
        skuId: 'sku-1',
        productId: 'p1',
        productName: '测试商品',
        skuSnapshot: {},
        quantity: 2,
        unitPrice: 1000,
        subtotal: 2000,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
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
  vi.restoreAllMocks();
});

describe('订单详情', () => {
  it('待支付订单：显示去支付/取消订单，不显示确认收货', () => {
    render(<OrderDetail initial={makeOrder()} />);

    expect(screen.getByRole('button', { name: '去支付' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消订单' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认收货' })).toBeNull();
  });

  it('已发货订单：显示确认收货，不显示去支付/取消订单', () => {
    render(
      <OrderDetail
        initial={makeOrder({ status: 'SHIPPED', shippedAt: '2026-01-02T00:00:00.000Z' })}
      />,
    );

    expect(screen.getByRole('button', { name: '确认收货' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去支付' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消订单' })).toBeNull();
  });

  it('去支付：POST /api/orders/:orderNo/pay，然后 window.location.assign 跳到站外支付页', async () => {
    const assignSpy = vi.fn();
    vi.stubGlobal('location', { assign: assignSpy });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ payUrl: 'https://pay.example.com/abc' }),
      ),
    );

    render(<OrderDetail initial={makeOrder()} />);
    await userEvent.click(screen.getByRole('button', { name: '去支付' }));

    expect(fetch).toHaveBeenCalledWith('/api/orders/NO-1/pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // ⚠️ 站外地址必须用 assign——router.push 管不了跨服务导航
    expect(assignSpy).toHaveBeenCalledWith('https://pay.example.com/abc');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('去支付失败：显示后端 message，不跳转', async () => {
    const assignSpy = vi.fn();
    vi.stubGlobal('location', { assign: assignSpy });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: '订单已支付' }, 500)),
    );

    render(<OrderDetail initial={makeOrder()} />);
    await userEvent.click(screen.getByRole('button', { name: '去支付' }));

    expect(await screen.findByText('订单已支付')).toBeTruthy();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('取消订单：confirm 取消时不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));

    render(<OrderDetail initial={makeOrder()} />);
    await userEvent.click(screen.getByRole('button', { name: '取消订单' }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('取消订单：confirm 确认后 POST /api/orders/:orderNo/cancel 并 refresh', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));

    render(<OrderDetail initial={makeOrder()} />);
    await userEvent.click(screen.getByRole('button', { name: '取消订单' }));

    expect(fetch).toHaveBeenCalledWith('/api/orders/NO-1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(await screen.findByText('订单已取消')).toBeTruthy();
    expect(refreshMock).toHaveBeenCalled();
  });

  it('确认收货：confirm 确认后 POST /api/orders/:orderNo/confirm 并 refresh', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({})),
    );

    render(
      <OrderDetail initial={makeOrder({ status: 'SHIPPED' })} />,
    );
    await userEvent.click(screen.getByRole('button', { name: '确认收货' }));

    expect(fetch).toHaveBeenCalledWith('/api/orders/NO-1/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(await screen.findByText('已确认收货')).toBeTruthy();
    expect(refreshMock).toHaveBeenCalled();
  });

  it('金额快照展示：应付/原价/券减免按订单字段渲染，不用现在重新算', () => {
    render(<OrderDetail initial={makeOrder()} />);

    expect(screen.getByText('商品原价')).toBeTruthy();
    // ⚠️ ¥20.00 出现两次：原价 <dd> 与商品小计 <td>——都来自订单快照字段
    expect(screen.getAllByText('¥20.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('优惠券')).toBeTruthy();
    expect(screen.getByText(/-¥1\.00（满 100 减 10）/)).toBeTruthy(); // 券减免 100 分
    expect(screen.getByText('应付金额')).toBeTruthy();
    expect(screen.getByText('¥19.00')).toBeTruthy(); // 实付 1900 分
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2); // 件数 + 商品数量
  });

  it('无优惠订单：不显示原价/券减免行，只显示应付金额', () => {
    render(
      <OrderDetail
        initial={makeOrder({ originalAmount: 1900, couponDiscountAmount: 0 })}
      />,
    );

    expect(screen.queryByText('商品原价')).toBeNull();
    expect(screen.queryByText('优惠券')).toBeNull();
    expect(screen.getByText('应付金额')).toBeTruthy();
  });
});
