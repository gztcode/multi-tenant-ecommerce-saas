// @vitest-environment jsdom
/**
 * 消费者「我的订单」列表（P2 工程债：组件零测试）。
 *
 * 筛选与分页都走 URL 查询串（服务端重新渲染列表的输入），
 * 断言必须落在 `router.push` 收到的**完整 URL** 上，不能只断言「被调用过」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrderList } from '@/components/order/order-list';
import type { Order } from '@/lib/cart';

const { pushMock, refreshMock, searchParamsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  searchParamsMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => searchParamsMock(),
}));

/** 造订单 fixture（默认待支付，实付 1900 分） */
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
    remark: null,
    payChannel: null,
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    cancelledAt: null,
    trackingNo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParamsMock.mockReturnValue(new URLSearchParams(''));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('订单列表', () => {
  it('空列表：显示「还没有订单。」', () => {
    render(<OrderList initial={[]} total={10} page={1} pageSize={5} />);

    expect(screen.getByText('还没有订单。')).toBeTruthy();
  });

  it('金额与状态中文映射：实付按分转元保留两位，状态用 ORDER_STATUS_LABEL', () => {
    render(
      <OrderList
        initial={[
          makeOrder(),
          makeOrder({
            id: 'o2',
            orderNo: 'NO-2',
            status: 'SHIPPED',
            totalAmount: 2550,
          }),
        ]}
        total={2}
        page={1}
        pageSize={5}
      />,
    );

    expect(screen.getByText('¥19.00')).toBeTruthy(); // 1900 分
    expect(screen.getByText('¥25.50')).toBeTruthy(); // 2550 分
    // 「待支付」「待收货」各出现两次：一次是筛选按钮，一次是订单状态列
    expect(screen.getAllByText('待支付')).toHaveLength(2);
    expect(screen.getAllByText('待收货')).toHaveLength(2);
  });

  it('筛选：点「待支付」推 /orders?status=PENDING_PAYMENT，点「全部状态」推 /orders（不带查询串）', async () => {
    render(<OrderList initial={[]} total={2} page={1} pageSize={5} />);

    await userEvent.click(
      screen.getByRole('button', { name: '待支付' }),
    );
    expect(pushMock).toHaveBeenCalledWith('/orders?status=PENDING_PAYMENT');

    await userEvent.click(
      screen.getByRole('button', { name: '全部状态' }),
    );
    expect(pushMock).toHaveBeenLastCalledWith('/orders');
  });

  it('分页：下一页带 page=2 且保留其它查询串（status=PAID）', async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams('page=1&status=PAID'),
    );
    render(
      <OrderList
        initial={[makeOrder(), makeOrder({ id: 'o2', orderNo: 'NO-2' })]}
        total={10}
        page={1}
        pageSize={5}
      />,
    );

    await userEvent.click(
      screen.getByRole('button', { name: '下一页' }),
    );
    expect(pushMock).toHaveBeenCalledWith('/orders?page=2&status=PAID');
  });

  it('分页：上一页带 page=1 且保留其它查询串', async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams('page=2&status=PAID'),
    );
    render(
      <OrderList
        initial={[makeOrder(), makeOrder({ id: 'o2', orderNo: 'NO-2' })]}
        total={10}
        page={2}
        pageSize={5}
      />,
    );

    await userEvent.click(
      screen.getByRole('button', { name: '上一页' }),
    );
    expect(pushMock).toHaveBeenCalledWith('/orders?page=1&status=PAID');
  });

  it('分页护栏：第 1 页「上一页」禁用，点击不发 push（goPage 的 Math.max(1,·) 此时不可达）', async () => {
    render(
      <OrderList
        initial={[makeOrder(), makeOrder({ id: 'o2', orderNo: 'NO-2' })]}
        total={10}
        page={1}
        pageSize={5}
      />,
    );

    const prev = screen.getByRole('button', { name: '上一页' });
    expect(prev.hasAttribute('disabled')).toBe(true);

    await userEvent.click(prev);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('分页信息：显示总数与当前页/总页数', () => {
    render(
      <OrderList
        initial={[makeOrder(), makeOrder({ id: 'o2', orderNo: 'NO-2' })]}
        total={10}
        page={1}
        pageSize={5}
      />,
    );

    expect(screen.getByText('共 10 个订单 · 第 1 / 2 页')).toBeTruthy();
  });

  it('当前筛选高亮：URL 带 status=PAID 时「待发货」按钮高亮，其余不高亮；无 status 时「全部状态」高亮', () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams('status=PAID'),
    );
    render(
      <OrderList
        initial={[makeOrder({ status: 'PAID' })]}
        total={1}
        page={1}
        pageSize={5}
      />,
    );

    const paid = screen.getByRole('button', { name: '待发货' });
    const pending = screen.getByRole('button', { name: '待支付' });
    expect(paid.className).toContain('border-primary');
    expect(pending.className).not.toContain('border-primary');
  });

  it('当前筛选高亮：无 status 时「全部状态」按钮高亮', () => {
    render(<OrderList initial={[]} total={1} page={1} pageSize={5} />);

    const all = screen.getByRole('button', { name: '全部状态' });
    const pending = screen.getByRole('button', { name: '待支付' });
    expect(all.className).toContain('border-primary');
    expect(pending.className).not.toContain('border-primary');
  });
});
