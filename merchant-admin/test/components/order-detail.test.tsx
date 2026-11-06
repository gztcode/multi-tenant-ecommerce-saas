// @vitest-environment jsdom
/**
 * 商家侧订单详情组件（`OrderDetail`）。
 *
 * ⚠️ **锚点是「已收款待退款」这一支**（2026-11-05 审计 P0-3）：
 *    钱已收但订单没接住（订单已超时关闭 / 已被消费者取消 / 已被另一渠道先付掉），
 *    商家原本既看不到提示、也没有退款按钮——那笔钱就没人能退。
 *    这里锁住两件事：**提示要渲染出来**、**退款按钮要出现**。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { OrderDetail } from '@/components/order/order-detail';
import type { MerchantOrder } from '@/components/order/types';

function order(overrides: Partial<MerchantOrder> = {}): MerchantOrder {
  return {
    id: 'order-1',
    orderNo: 'ORD202611050000000001',
    customerId: 'customer-1',
    status: 'CLOSED',
    totalAmount: 3000,
    itemCount: 1,
    receiverName: '张三',
    receiverPhone: '13800000000',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    detail: '科技园 1 号',
    remark: null,
    payChannel: null,
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    cancelledAt: null,
    trackingNo: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('订单详情：已收款待退款的提示', () => {
  it('有待退款时渲染出提示，写明笔数与金额', () => {
    render(
      <OrderDetail
        initial={order({
          status: 'CLOSED',
          pendingRefundCount: 2,
          pendingRefundAmount: 2500,
        })}
      />,
    );

    const notice = screen.getByTestId('pending-refund-notice');
    expect(notice.textContent).toContain('2 笔款项已收款但未结算进本单');
    // 金额用既有的格式化工具（分 → ¥xx.xx），不自己手写除以 100
    expect(notice.textContent).toContain('¥25.00');
    expect(notice.textContent).toContain('会把这笔待退款退回给买家');
  });

  it('有待退款时退款按钮出现，且文案点明含待退款（不能叫「整单退款」）', () => {
    render(
      <OrderDetail
        initial={order({
          status: 'CLOSED',
          pendingRefundCount: 1,
          pendingRefundAmount: 1500,
        })}
      />,
    );

    const button = screen.getByRole('button', {
      name: '退款（含待退款 ¥15.00）',
    });
    expect(button).toBeTruthy();
    expect(screen.queryByRole('button', { name: '整单退款' })).toBeNull();
  });

  it('没有待退款时不显示提示，退款按钮仍是「整单退款」', () => {
    render(<OrderDetail initial={order({ status: 'PAID' })} />);

    expect(screen.queryByTestId('pending-refund-notice')).toBeNull();
    expect(screen.getByRole('button', { name: '整单退款' })).toBeTruthy();
  });

  it('待退款的订单即便已关闭，退款入口也要在（商家得有办法退掉这笔钱）', () => {
    render(
      <OrderDetail
        initial={order({
          status: 'CLOSED',
          pendingRefundCount: 1,
          pendingRefundAmount: 1500,
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: '退款' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '退款（含待退款 ¥15.00）' }),
    ).toBeTruthy();
  });

  it('「退款只退钱，库存不会自动加回」的说明不能丢', () => {
    render(
      <OrderDetail
        initial={order({
          status: 'CLOSED',
          pendingRefundCount: 1,
          pendingRefundAmount: 1500,
        })}
      />,
    );

    expect(
      screen.getByText(/退款只退钱，库存不会自动加回——退货入库是另一套流程/),
    ).toBeTruthy();
  });
});
