// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// `useSearchParams` 的返回要在各用例间切换初始查询串（分页保留查询串的用例需要），
// 而 `vi.mock` 的工厂被提升到 import 之前、读不到普通闭包变量，
// 所以用 `vi.hoisted` 存一个可变引用 + setter。
const { pushMock, searchParamsMock, setQuery } = vi.hoisted(() => {
  let current = new URLSearchParams('');
  return {
    pushMock: vi.fn(),
    searchParamsMock: vi.fn(() => current),
    setQuery: (query: string) => {
      current = new URLSearchParams(query);
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
  useSearchParams: () => searchParamsMock(),
}));

import { OrderList } from '@/components/order/order-list';
import type { MerchantOrder } from '@/components/order/types';

/** 造一条完整订单（字段多，只覆盖用例关心的部分） */
function makeOrder(overrides: Partial<MerchantOrder> = {}): MerchantOrder {
  return {
    id: 'ord-1',
    orderNo: 'ORD20260001',
    customerId: 'cus-1',
    status: 'PAID',
    totalAmount: 5900,
    itemCount: 2,
    receiverName: '张三',
    receiverPhone: '13800000000',
    province: '浙江省',
    city: '杭州市',
    district: '西湖区',
    detail: '文一路 1 号',
    remark: null,
    payChannel: 'fake',
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    cancelledAt: null,
    trackingNo: null,
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
    ...overrides,
  };
}

/** 默认让 totalPages > 1（12 条 / 每页 10 → 2 页），分页控件才渲染 */
const PAGE_PROPS = { total: 12, page: 1, pageSize: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  setQuery('');
});

afterEach(() => {
  // cleanup 在 test/setup.ts 里统一注册
});

describe('商家订单列表', () => {
  it('筛选：状态 + 起止时间一起提交 → 按源码顺序拼完整 URL', async () => {
    render(<OrderList initial={[makeOrder()]} {...PAGE_PROPS} />);

    await userEvent.selectOptions(screen.getByLabelText('状态'), 'PAID');
    fireEvent.change(screen.getByLabelText('下单时间从'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('到'), {
      target: { value: '2026-11-15' },
    });
    await userEvent.click(screen.getByRole('button', { name: '筛选' }));

    // 源码里 status → from → to 依次 set，URLSearchParams 按此顺序序列化
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toBe(
      '/orders?status=PAID&from=2026-11-01&to=2026-11-15',
    );
  });

  it('筛选：只选状态，空的 from/to 不占查询串', async () => {
    render(<OrderList initial={[makeOrder()]} {...PAGE_PROPS} />);

    await userEvent.selectOptions(screen.getByLabelText('状态'), 'PAID');
    await userEvent.click(screen.getByRole('button', { name: '筛选' }));

    expect(pushMock.mock.calls[0][0]).toBe('/orders?status=PAID');
  });

  it('筛选：全部为空 → 跳 /orders（不带查询串）', async () => {
    render(<OrderList initial={[makeOrder()]} {...PAGE_PROPS} />);

    await userEvent.click(screen.getByRole('button', { name: '筛选' }));

    expect(pushMock.mock.calls[0][0]).toBe('/orders');
  });

  it('分页：下一页 → 带 page=N', async () => {
    render(<OrderList initial={[makeOrder()]} {...PAGE_PROPS} />);

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(pushMock.mock.calls[0][0]).toBe('/orders?page=2');
  });

  it('分页：翻页保留其它查询串（status=PAID 不被冲掉）', async () => {
    setQuery('status=PAID');
    render(<OrderList initial={[makeOrder()]} {...PAGE_PROPS} />);

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(pushMock.mock.calls[0][0]).toBe('/orders?status=PAID&page=2');
  });

  it('分页：首页时「上一页」禁用，不会把 page 导航到 <1', () => {
    render(<OrderList initial={[makeOrder()]} {...PAGE_PROPS} />);

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  it('分页：page 越界输入为 0 时，翻页产物恒 ≥ 1（Math.max 防御）', async () => {
    render(
      <OrderList
        initial={[makeOrder()]}
        total={12}
        page={0}
        pageSize={10}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(pushMock.mock.calls[0][0]).toBe('/orders?page=1');
  });

  it('空态：没有订单时显示「没有符合条件的订单。」', () => {
    render(<OrderList initial={[]} {...PAGE_PROPS} />);

    expect(screen.getByText('没有符合条件的订单。')).toBeTruthy();
  });

  it('金额显示：整数分 → ¥xx.xx 格式', () => {
    render(
      <OrderList
        initial={[makeOrder({ totalAmount: 5900 })]}
        total={1}
        page={1}
        pageSize={10}
      />,
    );

    expect(screen.getByText('¥59.00')).toBeTruthy();
  });

  it('状态显示：英文枚举 → 中文文案', () => {
    render(
      <OrderList
        initial={[makeOrder({ status: 'SHIPPED' })]}
        total={1}
        page={1}
        pageSize={10}
      />,
    );

    // 「待收货」在筛选下拉框的 option 里也有，必须限定在表格内查
    expect(within(screen.getByRole('table')).getByText('待收货')).toBeTruthy();
  });
});
