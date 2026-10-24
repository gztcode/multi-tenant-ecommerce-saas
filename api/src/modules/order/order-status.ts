import { OrderStatus } from '@prisma/client';

/**
 * 订单状态机（阶段 3 Task 4）。
 *
 * ## 为什么必须集中在一张表里
 *
 * 状态流转如果散落在各个 controller / service 里，迟早会有某个入口漏校验——
 * 比如「确认收货」检查了 `SHIPPED`，「发货」却忘了检查 `PAID`，
 * 于是订单能从 `PENDING_PAYMENT` 直接跳到 `SHIPPED`（货没收到钱就发出去了）。
 *
 * 散落的另一重代价是**改动成本**：状态表要改时，得在十几个地方找。
 *
 * 所以这里只有一张转移表，所有流转都必须先问 `canTransition()`。
 *
 * ## 转移表与设计 §七 一致
 *
 * | 状态 | 含义 | 可转出到 |
 * |------|------|---------|
 * | `PENDING_PAYMENT` | 已下单，库存已预占，等待支付 | `PAID` / `CANCELLED` / `CLOSED` |
 * | `PAID` | 已支付 | `SHIPPED` / `REFUNDED` |
 * | `SHIPPED` | 已发货 | `COMPLETED` / `REFUNDED` |
 * | `COMPLETED` | 已确认收货 | ——（终态）|
 * | `CANCELLED` | 用户主动取消，库存已释放 | ——（终态）|
 * | `REFUNDED` | 已退款，库存**不**回补 | ——（终态）|
 * | `CLOSED` | 超时未支付，库存已释放 | ——（终态）|
 *
 * ⚠️ `REFUNDED` 不回补库存：货已经发出去了，退的是钱不是库存。
 * 「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
 */
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED', 'CLOSED'],
  PAID: ['SHIPPED', 'REFUNDED'],
  SHIPPED: ['COMPLETED', 'REFUNDED'],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
  CLOSED: [],
};

/** 这个状态是不是终态（不能再转出） */
export function isTerminal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

/**
 * 这个流转是否被状态机允许。
 *
 * ⚠️ **光问「允不允许」不够**——并发场景下两个请求都可能拿到 `true`
 * （它们读到的是同一个旧状态）。所以真正的守卫是
 * `OrderService.transition()` 里的**条件更新**：
 * 把 `from` 放进 `updateMany` 的 `where`，靠受影响行数判定谁赢了。
 *
 * 这个函数管的是「流转本身合不合法」，条件更新管的是「这次流转能不能生效」。
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}
