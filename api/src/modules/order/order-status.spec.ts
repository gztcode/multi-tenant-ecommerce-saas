import { OrderStatus } from '@prisma/client';
import { ORDER_TRANSITIONS, canTransition, isTerminal } from './order-status';

/**
 * 订单状态机的**转移表**本身要有独立覆盖（阶段 3 验收 G5）。
 *
 * ## 为什么这条用例必须存在
 *
 * 失败注入验证时发现：把 `canTransition` 改成恒真（`return true`），
 * 整套 e2e **全绿**——一条都不挂。
 *
 * 原因是真正拦住非法流转的不是 `canTransition`，而是
 * `OrderService.transitionInTx` 里的**条件更新**：
 * `updateMany({ where: { id, status: from } })` 靠受影响行数判定谁赢了。
 *
 * 也就是说：`canTransition` 目前是**纵深防御**——它拒绝「问都不该问的流转」，
 * 但没有测试证明它在起作用。一旦它恒真，防线少了一层而没人知道。
 *
 * 所以这里把转移表**当成被测对象**直接测：
 * 每一条合法流转返回 true，每一条非法流转返回 false。
 *
 * ## 断言的形态
 *
 * 不逐条手写 `expect(canTransition(a, b)).toBe(true)`（漏写一条就少测一条），
 * 而是**从表里枚举**：合法流转 = 表里列出的每一对；非法流转 = 全集减去表里的。
 * 这样以后往 `ORDER_TRANSITIONS` 里加状态，用例自动跟着变，
 * 不会出现「表加了新状态但用例没跟上」的静默缺口。
 */

const ALL_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.CLOSED,
];

/** 终态：没有出边 */
const TERMINAL_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.CLOSED,
];

describe('订单状态机转移表', () => {
  it('转移表覆盖了全部订单状态，没有漏项也没有多项', () => {
    // 漏登记的后果：某个状态在表里是 undefined，
    // `canTransition` 读 `undefined.includes` 会**抛 TypeError**，
    // 错误信息还很难指向「状态机漏了这个状态」。
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(
      ALL_STATUSES.map((s) => s).sort(),
    );
  });

  it('转移表里的每个目标状态都是合法订单状态', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it('每一条表内列出的合法流转都返回 true', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it('每一条表外的流转都返回 false', () => {
    // 枚举全集 × 全集，再减去表里列出的合法对——剩下的必须全被拒。
    // 特别地覆盖：
    // - COMPLETED → PAID（终态复活）
    // - PENDING_PAYMENT → SHIPPED（没付钱就发货）
    // - PENDING_PAYMENT → COMPLETED（没付钱就收货）
    const legal = new Set<string>();
    for (const from of ALL_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        legal.add(`${from}->${to}`);
      }
    }

    const rejected: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) {
          // 流转到自身不是合法流转（表里没有自环）
          expect(canTransition(from, to)).toBe(false);
          continue;
        }
        if (legal.has(`${from}->${to}`)) {
          continue;
        }
        expect(canTransition(from, to)).toBe(false);
        rejected.push(`${from}->${to}`);
      }
    }

    // 至少要有几条被拒的，否则说明枚举写错了（断言恒真）
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('三个终态（COMPLETED / CANCELLED / REFUNDED / CLOSED）没有任何出边', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(ORDER_TRANSITIONS[status]).toEqual([]);
      expect(isTerminal(status)).toBe(true);
      // 终态不能转到任何状态
      for (const to of ALL_STATUSES) {
        expect(canTransition(status, to)).toBe(false);
      }
    }
  });

  it('非终态都能被识别出来', () => {
    expect(isTerminal(OrderStatus.PENDING_PAYMENT)).toBe(false);
    expect(isTerminal(OrderStatus.PAID)).toBe(false);
    expect(isTerminal(OrderStatus.SHIPPED)).toBe(false);
  });

  it('状态不能流转到自身', () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('PENDING_PAYMENT 只能转出到 PAID / CANCELLED / CLOSED', () => {
    // 显式锁住这条最容易出事的规则：没付钱的订单不能跳到发货或收货
    expect(canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PAID)).toBe(
      true,
    );
    expect(
      canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED),
    ).toBe(true);
    expect(canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CLOSED)).toBe(
      true,
    );
    expect(
      canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.SHIPPED),
    ).toBe(false);
    expect(
      canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.COMPLETED),
    ).toBe(false);
    expect(
      canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.REFUNDED),
    ).toBe(false);
  });

  it('PAID 只能转出到 SHIPPED / REFUNDED', () => {
    expect(canTransition(OrderStatus.PAID, OrderStatus.SHIPPED)).toBe(true);
    expect(canTransition(OrderStatus.PAID, OrderStatus.REFUNDED)).toBe(true);
    expect(canTransition(OrderStatus.PAID, OrderStatus.COMPLETED)).toBe(false);
    expect(canTransition(OrderStatus.PAID, OrderStatus.CANCELLED)).toBe(false);
    expect(canTransition(OrderStatus.PAID, OrderStatus.CLOSED)).toBe(false);
  });

  it('SHIPPED 只能转出到 COMPLETED / REFUNDED', () => {
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.COMPLETED)).toBe(
      true,
    );
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.REFUNDED)).toBe(true);
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.CANCELLED)).toBe(
      false,
    );
  });

  it('COMPLETED 不能复活回 PAID', () => {
    expect(canTransition(OrderStatus.COMPLETED, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.COMPLETED, OrderStatus.SHIPPED)).toBe(
      false,
    );
    expect(canTransition(OrderStatus.COMPLETED, OrderStatus.COMPLETED)).toBe(
      false,
    );
  });
});
