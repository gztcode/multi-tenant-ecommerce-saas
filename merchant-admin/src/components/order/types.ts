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
 * ⚠️ 这里只是**界面上**的判断，后端还会再判一次。
 * 宁可保守：少显示一个按钮是体验问题，多显示一个按钮是「点了必然报错」。
 */
export function merchantActions(status: OrderStatus): {
  canShip: boolean;
  canRefund: boolean;
} {
  return {
    canShip: status === 'PAID',
    canRefund: status === 'PAID' || status === 'SHIPPED',
  };
}
