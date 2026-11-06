/**
 * 商家侧订单的类型与状态文案。
 *
 * 单独成文件（对照 `components/product/types.ts`）：订单列表与订单详情
 * 两处都要用同一套类型与文案，各写一份必然漂移。
 */

/** 订单状态（与后端 Prisma 的 OrderStatus 枚举一一对应） */
export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'CLOSED';

/** 订单项快照 */
export interface OrderItem {
  id: string;
  skuId: string;
  productId: string;
  productName: string;
  skuSnapshot: unknown;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** 商家看到的订单 */
export interface MerchantOrder {
  id: string;
  orderNo: string;
  customerId: string | null;
  status: OrderStatus;
  totalAmount: number;
  itemCount: number;
  receiverName: string;
  receiverPhone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  remark: string | null;
  payChannel: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  trackingNo: string | null;
  createdAt: string;
  updatedAt: string;
  items?: OrderItem[];
  /**
   * 「已收款待退款」的金额合计（整数分）。
   *
   * ⚠️ 可选：旧数据与其它端可能没有这个字段，缺省按 0 处理。
   */
  pendingRefundAmount?: number;
  /** 「已收款待退款」的笔数（可选，同上） */
  pendingRefundCount?: number;
}

/** 订单状态的中文文案 */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '待发货',
  SHIPPED: '待收货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
  CLOSED: '已关闭',
};

/** 订单状态筛选项（含「全部」） */
export const ORDER_STATUS_OPTIONS: Array<{
  value: '' | OrderStatus;
  label: string;
}> = [
  { value: '', label: '全部状态' },
  { value: 'PENDING_PAYMENT', label: '待支付' },
  { value: 'PAID', label: '待发货' },
  { value: 'SHIPPED', label: '待收货' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
  { value: 'REFUNDED', label: '已退款' },
  { value: 'CLOSED', label: '已关闭' },
];

/**
 * 商家在当前状态下允许做哪些操作。
 *
 * 判定依据是后端的状态机（api/src/modules/order/order-status.ts 的转移表）：
 * - `PAID` → 可发货、可退款
 * - `SHIPPED` → 可退款（货已发出，仍可退）
 * - `PENDING_PAYMENT` → 都不行（还没收到钱）
 *
 * ⚠️ **`pendingRefundCount > 0` 时一律可退款**（2026-11-05 审计 P0-3）：
 *    订单已超时关闭 / 已被消费者取消 / 已被另一渠道先付掉时，
 *    渠道却确认收到了钱 —— 这笔钱标成了「已收款待退款」，
 *    订单本身是终态、按状态机退不了，但**商家必须有办法把它退掉**。
 *    后端 `PaymentService.orderAllowsRefund` 也放行这些状态，两边口径一致。
 *
 * ⚠️ 这里只是**界面上**的判断，后端还会再判一次。
 * 宁可保守：少显示一个按钮是体验问题，多显示一个按钮是「点了必然报错」。
 */
export function merchantActions(
  status: OrderStatus,
  pendingRefundCount = 0,
): {
  canShip: boolean;
  canRefund: boolean;
} {
  return {
    canShip: status === 'PAID',
    canRefund:
      status === 'PAID' || status === 'SHIPPED' || pendingRefundCount > 0,
  };
}
