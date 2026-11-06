/**
 * 商家侧订单的可执行动作判定（`merchantActions`）。
 *
 * ⚠️ **「已收款待退款」这一支是防假绿的锚点**（2026-11-05 审计 P0-3）：
 *    钱已收但订单没接住（订单已超时关闭 / 已被消费者取消 / 已被另一渠道先付掉），
 *    订单本身是终态、按状态机退不了款——但商家**必须有办法把它退掉**。
 *    少了这一支，这类订单就成了「平台账上有一笔钱谁也动不了」的孤儿。
 */
import { describe, expect, it } from 'vitest';

import { merchantActions } from '@/components/order/types';

describe('merchantActions：没有待退款时按订单状态判定', () => {
  it('待支付：既不能发货也不能退款', () => {
    expect(merchantActions('PENDING_PAYMENT')).toEqual({
      canShip: false,
      canRefund: false,
    });
  });

  it('待发货：可发货也可退款', () => {
    expect(merchantActions('PAID')).toEqual({
      canShip: true,
      canRefund: true,
    });
  });

  it('待收货：不可发货但可退款', () => {
    expect(merchantActions('SHIPPED')).toEqual({
      canShip: false,
      canRefund: true,
    });
  });

  it('已关闭：没有待退款时不能退款（不能多显示按钮）', () => {
    expect(merchantActions('CLOSED', 0)).toEqual({
      canShip: false,
      canRefund: false,
    });
  });

  it('已取消：没有待退款时也不能退款', () => {
    expect(merchantActions('CANCELLED', 0)).toEqual({
      canShip: false,
      canRefund: false,
    });
  });

  it('已完成：不可发货也不可退款', () => {
    expect(merchantActions('COMPLETED', 0)).toEqual({
      canShip: false,
      canRefund: false,
    });
  });
});

describe('merchantActions：有待退款时一律可退款', () => {
  it('已关闭 + 1 笔待退款 → 可退款（锚点：没有这一条按钮就不出现）', () => {
    expect(merchantActions('CLOSED', 1)).toEqual({
      canShip: false,
      canRefund: true,
    });
  });

  it('已取消 + 2 笔待退款 → 可退款', () => {
    expect(merchantActions('CANCELLED', 2)).toEqual({
      canShip: false,
      canRefund: true,
    });
  });

  it('待支付 + 待退款 → 可退款（钱收了就不是「还没收到钱」）', () => {
    expect(merchantActions('PENDING_PAYMENT', 1)).toEqual({
      canShip: false,
      canRefund: true,
    });
  });

  it('待退款不改变发货的判定（这单该不该发货跟待退款无关）', () => {
    expect(merchantActions('CLOSED', 1).canShip).toBe(false);
    expect(merchantActions('PAID', 1).canShip).toBe(true);
  });

  it('不传待退款笔数时按 0 处理（旧的调用点不受影响）', () => {
    expect(merchantActions('CLOSED').canRefund).toBe(false);
    expect(merchantActions('PAID').canRefund).toBe(true);
  });
});
