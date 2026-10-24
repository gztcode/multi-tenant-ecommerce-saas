/**
 * 购物车与订单的纯函数：件数计算、排序、下单条目构造、地址拼接、
 * 状态对应的可执行操作。
 *
 * 断言要**具体**：只断言「返回了一个数组」或「不报错」极易恒真。
 * 这里对每条断言都给出确切的期望值，并且每个分支都测到
 * （尤其是「能不能执行某个操作」——判错的后果是「点了必然报错」）。
 */
import { describe, expect, it } from 'vitest';

import {
  consumerActions,
  formatAddress,
  isOrderStatus,
  itemSubtotal,
  ORDER_STATUS_LABEL,
  sortCartItems,
  toOrderItems,
  totalAmount,
  totalQuantity,
  type CartItem,
} from '@/lib/cart';

/** 构造一条购物车条目 */
function item(id: string, skuId: string, quantity: number): CartItem {
  return { id, skuId, quantity };
}

/**
 * 构造一条**带展示信息**的购物车条目。
 *
 * 单价是整数分——与后端的金额约定一致。
 */
function itemWithSku(
  id: string,
  skuId: string,
  quantity: number,
  price: number,
  productName = '重磅纯棉T恤',
): CartItem {
  return {
    id,
    skuId,
    quantity,
    sku: {
      id: skuId,
      price,
      product: { id: `p-${skuId}`, name: productName },
    },
  };
}

describe('totalQuantity：购物车总件数', () => {
  it('空购物车的件数是 0', () => {
    expect(totalQuantity([])).toBe(0);
  });

  it('件数是各条目数量之和', () => {
    expect(
      totalQuantity([
        item('i1', 'sku-a', 2),
        item('i2', 'sku-b', 3),
        item('i3', 'sku-c', 1),
      ]),
    ).toBe(6);
  });

  it('只有一条时件数就是那一条的数量', () => {
    expect(totalQuantity([item('i1', 'sku-a', 7)])).toBe(7);
  });
});

describe('itemSubtotal：单条条目的小计', () => {
  it('小计是单价乘数量', () => {
    expect(itemSubtotal(itemWithSku('i1', 'sku-a', 3, 12900))).toBe(38700);
  });

  it('缺单价的条目小计是 0，不猜价格', () => {
    expect(itemSubtotal(item('i1', 'sku-a', 3))).toBe(0);
  });
});

describe('totalAmount：购物车合计金额', () => {
  it('空购物车的金额是 0', () => {
    expect(totalAmount([])).toBe(0);
  });

  it('金额是各条目「单价 × 数量」之和', () => {
    expect(
      totalAmount([
        itemWithSku('i1', 'sku-a', 2, 12900),
        itemWithSku('i2', 'sku-b', 3, 2990),
        itemWithSku('i3', 'sku-c', 1, 100),
      ]),
    ).toBe(12900 * 2 + 2990 * 3 + 100);
  });

  it('只有一条时金额就是单价乘数量', () => {
    expect(totalAmount([itemWithSku('i1', 'sku-a', 4, 1250)])).toBe(5000);
  });

  it('结果是整数分，不带小数尾巴', () => {
    // ⚠️ 不能出现 0.1 之类的浮点尾巴——金额一律整数分
    const amount = totalAmount([
      itemWithSku('i1', 'sku-a', 3, 1000),
      itemWithSku('i2', 'sku-b', 7, 333),
    ]);
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBe(5331);
  });

  it('缺单价（后端没带上 sku）的条目按 0 计，不猜价格', () => {
    expect(
      totalAmount([item('i1', 'sku-a', 2), itemWithSku('i2', 'sku-b', 1, 500)]),
    ).toBe(500);
  });

  it('全部条目都缺单价时金额是 0', () => {
    expect(totalAmount([item('i1', 'sku-a', 2)])).toBe(0);
  });

  it('不改动原数组', () => {
    const original = [itemWithSku('i1', 'sku-a', 2, 1000)];
    totalAmount(original);
    expect(original[0].quantity).toBe(2);
  });
});

describe('sortCartItems：购物车条目排序', () => {
  it('按数量降序排列', () => {
    const sorted = sortCartItems([
      item('i1', 'sku-a', 1),
      item('i2', 'sku-b', 5),
      item('i3', 'sku-c', 3),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['i2', 'i3', 'i1']);
  });

  it('数量相同时按 id 升序，保证顺序稳定', () => {
    const sorted = sortCartItems([
      item('i2', 'sku-b', 2),
      item('i1', 'sku-a', 2),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('不改动原数组', () => {
    const original = [item('i1', 'sku-a', 1), item('i2', 'sku-b', 9)];
    sortCartItems(original);
    expect(original.map((i) => i.id)).toEqual(['i1', 'i2']);
  });
});

describe('toOrderItems：下单条目构造', () => {
  it('只带 skuId 与 quantity，不带任何价格字段', () => {
    const items = toOrderItems([item('i1', 'sku-a', 2)]);
    // 用 toEqual 而不是「不含某字段」：断言的是**后端收到的完整形状**，
    // 「全都丢掉」的实现也能通过「不含 price」的断言。
    expect(items).toEqual([{ skuId: 'sku-a', quantity: 2 }]);
    expect(Object.keys(items[0]).sort()).toEqual(['quantity', 'skuId']);
  });

  it('条目的 id 不进下单请求体（后端按 skuId 定位）', () => {
    const items = toOrderItems([item('cart-item-id', 'sku-a', 1)]);
    expect(items[0]).not.toHaveProperty('id');
  });

  it('空购物车得到空数组', () => {
    expect(toOrderItems([])).toEqual([]);
  });
});

describe('formatAddress：收货地址拼接', () => {
  it('省市区与详情连在一起，中间不加分隔符', () => {
    expect(
      formatAddress({
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      }),
    ).toBe('浙江省杭州市西湖区文一西路 100 号');
  });

  it('缺一节时不留多余的空白', () => {
    expect(
      formatAddress({
        province: '浙江省',
        city: '杭州市',
        district: '',
        detail: '文一西路 100 号',
      }),
    ).toBe('浙江省杭州市文一西路 100 号');
  });
});

describe('isOrderStatus：订单状态的合法性', () => {
  it('后端的七个状态都合法', () => {
    for (const status of Object.keys(ORDER_STATUS_LABEL)) {
      expect(isOrderStatus(status)).toBe(true);
    }
  });

  it('不认识的状态不合法', () => {
    // status 来自查询串，是用户可控的
    expect(isOrderStatus('FOO')).toBe(false);
    expect(isOrderStatus('paid')).toBe(false);
    expect(isOrderStatus('')).toBe(false);
  });
});

describe('consumerActions：消费者能做的操作', () => {
  it('待支付可以支付也可以取消', () => {
    expect(consumerActions('PENDING_PAYMENT')).toEqual({
      canPay: true,
      canCancel: true,
      canConfirm: false,
    });
  });

  it('待发货时三个操作都不能做', () => {
    expect(consumerActions('PAID')).toEqual({
      canPay: false,
      canCancel: false,
      canConfirm: false,
    });
  });

  it('待收货可以确认收货', () => {
    expect(consumerActions('SHIPPED')).toEqual({
      canPay: false,
      canCancel: false,
      canConfirm: true,
    });
  });

  it('终态什么都不能做', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'REFUNDED', 'CLOSED'] as const) {
      expect(consumerActions(status)).toEqual({
        canPay: false,
        canCancel: false,
        canConfirm: false,
      });
    }
  });
});
