/**
 * 购物车与订单的前端类型 + 纯函数。
 *
 * 单独成文件而不是散在各个组件里：
 * - **类型**在服务端页面与客户端组件之间共享，两边各写一份必然漂移；
 * - **纯函数**（金额计算、状态文案、可执行的操作）要在单元测试里断言，
 *   塞在组件里就没法单独测了。
 *
 * ⚠️ 金额一律整数分（阶段 0.4 的全局约定）。前端**只做展示用的换算**，
 * 真实金额永远由后端算——下单请求体里连价格字段都不许带。
 */

/**
 * 购物车条目。后端 `GET /cart` 返回的就是这个形状。
 *
 * ⚠️ `sku` 是**展示**信息（商品名与单价），不是快照：购物车不是订单，
 * 下单时的快照由后端写进 `order_items`。这里带单价只是为了让购物车页
 * 能显示金额、算合计——**真实金额永远由后端在下单时算**。
 */
export interface CartItem {
  id: string;
  skuId: string;
  quantity: number;
  /** 后端带上的展示信息；老数据或异常情况下可能缺失，调用方要能兜住 */
  sku?: {
    id: string;
    /** 单价，整数分 */
    price: number;
    product: {
      id: string;
      name: string;
    };
  };
}

/** 购物车 */
export interface Cart {
  id: string;
  tenantId: string;
  customerId: string | null;
  guestToken: string | null;
  items: CartItem[];
  createdAt: string;
  updatedAt: string;
}

/** 收货地址 */
export interface Address {
  id: string;
  receiver: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
}

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

/** 订单 */
export interface Order {
  id: string;
  orderNo: string;
  customerId: string | null;
  status: OrderStatus;
  /** 实付（优惠后，整数分）——金额快照 */
  totalAmount: number;
  /** 原价小计（优惠前，整数分）——金额快照 */
  originalAmount: number;
  /** 满减活动减免（整数分）——金额快照 */
  promotionDiscountAmount: number;
  /** 券减免（整数分）——金额快照 */
  couponDiscountAmount: number;
  /** 用的券 id（快照） */
  couponId: string | null;
  /** 用的券码（快照） */
  couponCode: string | null;
  /** 用的券名（快照） */
  couponName: string | null;
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

/** 订单列表的分页响应 */
export interface OrderListResponse {
  items: Order[];
  total: number;
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

/** 状态是不是后端认识的合法值（查询串是用户可控的） */
export function isOrderStatus(value: string): value is OrderStatus {
  return value in ORDER_STATUS_LABEL;
}

/**
 * 购物车里的总件数。
 *
 * ⚠️ 与「总金额」不是一回事：件数是条目数量之和，金额是单价乘数量之和。
 */
export function totalQuantity(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * 单条购物车条目的小计（整数分）。
 *
 * ⚠️ 缺 `sku`（后端没带上单价）的条目按 0 计——宁可少算，
 * 也不能拿一个猜出来的价格显示给用户。
 *
 * ⚠️ **只在整数域里算**——单价与数量都是整数，乘积必然是整数，
 * 绝不能中途除以 100 或做别的浮点运算：
 * `Math.ceil(3000 * 1.1)` 的真值是 `3300.0000000000005`。
 * 换算成「元」只发生在**显示**环节（`formatPrice`），不参与计算。
 */
export function itemSubtotal(item: CartItem): number {
  return (item.sku?.price ?? 0) * item.quantity;
}

/**
 * 购物车里的合计金额（整数分）。
 *
 * ⚠️ 这是**展示用的估算值**，不是最终金额：真实金额由后端在下单时
 * 按当时的 SKU 价格算（护栏 8：客户端算的金额一律不信）。
 */
export function totalAmount(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + itemSubtotal(item), 0);
}

/**
 * 按数量降序、id 升序排序。
 *
 * 排序规则写死在这里而不是交给后端：购物车是「用户自己刚动过的那台车」，
 * 前端改完数量后要立刻重排，靠 id 兜底保证顺序稳定（React key 用 id，
 * 顺序变了会导致整列 DOM 重建、输入框失焦）。
 */
export function sortCartItems(items: CartItem[]): CartItem[] {
  return [...items].sort((a, b) => {
    if (a.quantity !== b.quantity) return b.quantity - a.quantity;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 提交下单用的条目（只带 skuId 与数量）。
 *
 * ⚠️ **不带任何价格字段**——后端的 ValidationPipe 开了 forbidNonWhitelisted，
 * 多带一个 price 就会 400；而更根本的是，价格只能由后端从 SKU 读
 * （护栏 8：客户端传的价格一律不信）。
 */
export function toOrderItems(items: CartItem[]): Array<{
  skuId: string;
  quantity: number;
}> {
  return items.map((item) => ({
    skuId: item.skuId,
    quantity: item.quantity,
  }));
}

/**
 * 收货地址的一行展示。
 *
 * 省份 + 城市 + 区县 + 详情的拼接在订单详情、地址列表、结算页三处出现，
 * 各写一份必然出现「订单页显示「浙江省杭州市西湖区」，地址页显示「浙江省 杭州市 西湖区」」
 * 这种不一致，所以定义在这里。
 */
export function formatAddress(address: {
  province: string;
  city: string;
  district: string;
  detail: string;
}): string {
  return `${address.province}${address.city}${address.district}${address.detail}`;
}

/**
 * 订单在当前状态下**允许消费者**做哪些操作。
 *
 * 判定依据是后端的状态机（api/src/modules/order/order-status.ts 的转移表）：
 * - `PENDING_PAYMENT` → 可支付、可取消
 * - `SHIPPED` → 可确认收货
 * - 终态（`COMPLETED` / `CANCELLED` / `REFUNDED` / `CLOSED`）→ 什么都不做
 *
 * ⚠️ 这里只是**界面上**的判断，后端还会再判一次。
 * 前端少显示一个按钮是体验问题，多显示一个按钮是「点了必然报错」——
 * 所以宁可保守。
 */
export function consumerActions(status: OrderStatus): {
  canPay: boolean;
  canCancel: boolean;
  canConfirm: boolean;
} {
  return {
    canPay: status === 'PENDING_PAYMENT',
    canCancel: status === 'PENDING_PAYMENT',
    canConfirm: status === 'SHIPPED',
  };
}

/**
 * 商家在当前状态下**允许**做哪些操作。
 *
 * - `PAID` → 可发货、可退款
 * - `SHIPPED` → 可退款（货已发出，仍可退）
 * - `PENDING_PAYMENT` → 不可发货（还没收到钱），也不可退款（没付过）
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
