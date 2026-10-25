/**
 * 营销模块（优惠券与满减活动）的类型。
 *
 * 单独成文件是因为服务端页面与客户端组件两边都要用：
 * 页面取数后把数据传给表单组件，两边各写一份必然漂移。
 *
 * ⚠️ **金额一律整数分**（全局约定），界面上用「元」，
 * 转换只在表单的边界做（见 `lib/money.ts`）。
 */

/** 券的作用域：SHOP = 本店券；PLATFORM = 平台券（只能由平台超管创建） */
export type CouponScope = 'SHOP' | 'PLATFORM';

/** 券的状态 */
export type CouponStatus = 'ACTIVE' | 'PAUSED' | 'EXPIRED';

/** 活动的状态 */
export type PromotionStatus = 'ACTIVE' | 'PAUSED' | 'EXPIRED';

/** 优惠券 */
export interface Coupon {
  id: string;
  /** 券码（租户内唯一） */
  code: string;
  name: string;
  description: string | null;
  /** 本阶段只有 FIXED（满减券） */
  type: string;
  /** 面额（整数分） */
  value: number;
  /** 使用门槛（整数分），0 = 无门槛 */
  minAmount: number;
  /** 每用户限领张数；null = 不限 */
  perUserLimit: number | null;
  /** 总发放上限；null = 不限 */
  totalLimit: number | null;
  /** 已发放张数 */
  claimedCount: number;
  /** 被订单预占核销的数量 */
  reservedCount: number;
  /** 已被订单实际使用的数量 */
  usedCount: number;
  scope: CouponScope;
  status: CouponStatus;
  /** ISO 8601 */
  startsAt: string;
  /** ISO 8601 */
  endsAt: string;
}

/** 满减活动 */
export interface Promotion {
  id: string;
  name: string;
  description: string | null;
  /** 门槛（整数分），0 = 无门槛 */
  minAmount: number;
  /** 减免金额（整数分） */
  discountAmount: number;
  status: PromotionStatus;
  /** ISO 8601 */
  startsAt: string;
  /** ISO 8601 */
  endsAt: string;
}

/** 券的状态文案 */
export const COUPON_STATUS_LABEL: Record<CouponStatus, string> = {
  ACTIVE: '进行中',
  PAUSED: '已暂停',
  EXPIRED: '已过期',
};

/** 活动的状态文案 */
export const PROMOTION_STATUS_LABEL: Record<PromotionStatus, string> = {
  ACTIVE: '进行中',
  PAUSED: '已暂停',
  EXPIRED: '已过期',
};

/**
 * ISO 8601 → `<input type="datetime-local">` 要的本地时间格式。
 *
 * ⚠️ **必须是本地时间**：datetime-local 的值不带时区，浏览器按本地时间理解。
 * 直接把 ISO 字符串塞进去会被当成 UTC，差一个时区。
 */
export function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * `<input type="datetime-local">` 的值 → ISO 8601（给后端）。
 *
 * ⚠️ datetime-local 的值**不带时区**，按浏览器本地时间理解，
 * 所以直接 `new Date(value)` 再 `.toISOString()` 即可 —— 转成 UTC 是对的。
 *
 * @returns ISO 字符串；值为空或非法时返回 null
 */
export function fromLocalDateTimeInput(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
