/**
 * 计费模块（套餐 / 订阅 / 账单 / 支付方式）的类型与展示纯函数。
 *
 * 单独成文件是因为服务端页面与客户端组件两边都要用：
 * 页面取数后把数据传给面板组件，两边各写一份必然漂移。
 *
 * ⚠️ **金额一律整数分**（全局约定），界面上用「元」，
 * 换算只在展示层做（见 `lib/money.ts`）。
 *
 * ⚠️ **这个文件是 `.ts` 不是 `.tsx`**：vitest 只收 test 目录下的 .test.ts，
 * 塞进组件文件就没法单独测这些纯函数了。
 */

import { centsToYuan } from '@/lib/money';

/**
 * 套餐的展示状态。
 *
 * ⚠️ **必须与后端 Prisma 的 `PlanStatus` 逐字一致**：
 * 写成 `INACTIVE` 的话，后端返回的 `DISABLED` 落到界面上就是裸枚举。
 */
export type PlanStatus = 'ACTIVE' | 'DISABLED';

/**
 * 订阅的状态。
 *
 * ⚠️ **取消是 `CANCELLED`（两个 L）**，与后端 Prisma 的 `SubscriptionStatus` 一致。
 */
export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

/**
 * 账单的状态。
 *
 * ⚠️ **作废是 `VOID`**，不是 `VOIDED`。
 */
export type InvoiceStatus = 'OPEN' | 'PAID' | 'VOID' | 'FAILED';

/** 支付方式的类型 */
export type PaymentMethodType = 'CARD' | 'WECHAT' | 'ALIPAY';

/** 套餐（平台的数据，商家能看到在售的） */
export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** 周期价格（整数分）。0 = 免费 */
  price: number;
  /** 订阅周期（天）。30 = 按月 */
  periodDays: number;
  /** 试用期（天）。0 = 无试用 */
  trialDays: number;
  /** 抽佣比例（基点，万分之一）。500 = 5% */
  commissionBps: number;
  /** 商品数上限。null = 不限 */
  maxProducts: number | null;
  /** SKU 数上限。null = 不限 */
  maxSkus: number | null;
  /** 店铺数上限。null = 不限 */
  maxStores: number | null;
  /** 功能开关。缺省一律视为 false（保守） */
  features: Record<string, unknown>;
  status: PlanStatus;
  /** 展示顺序（小的在前） */
  sortOrder: number;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** 订阅 */
export interface Subscription {
  id: string;
  tenantId: string;
  planId: string;
  /** 待生效的套餐（下个周期生效）。null = 不换 */
  pendingPlanId: string | null;
  status: SubscriptionStatus;
  /** ISO 8601 */
  startedAt: string;
  /** 试用截止。null = 不是试用 */
  trialEndsAt: string | null;
  /** ISO 8601 */
  currentPeriodStart: string;
  /** ISO 8601 */
  currentPeriodEnd: string;
  /** 到期后不自动续费 */
  cancelAtPeriodEnd: boolean;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** 账单 */
export interface Invoice {
  id: string;
  tenantId: string;
  subscriptionId: string;
  planId: string;
  /** 账单号（对外凭证） */
  number: string;
  /** 应付金额（整数分） */
  amount: number;
  status: InvoiceStatus;
  /** ISO 8601 */
  periodStart: string;
  /** ISO 8601 */
  periodEnd: string;
  /** 应付截止（一般是周期结束日） */
  dueAt: string;
  /** ISO 8601 */
  paidAt: string | null;
  /** ISO 8601 */
  voidedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

/**
 * 支付方式。
 *
 * ⚠️ **没有 `token` 字段**：那是渠道给的扣款凭证，只能在服务端用
 * （自动续费），发到浏览器等于把卡交出去。后端列表接口也用 `select`
 * 显式挑字段，压根不返回它。
 */
export interface PaymentMethodItem {
  id: string;
  /**
   * ⚠️ **后端的列表接口不返回它**（`select` 里没挑这个字段），
   * 运行时是 undefined。声明成可选，免得前端以为它一定有值。
   */
  tenantId?: string;
  provider: string;
  channel: string;
  type: PaymentMethodType;
  isDefault: boolean;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** 订阅状态的文案 */
const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  TRIAL: '试用中',
  ACTIVE: '生效中',
  EXPIRED: '已到期',
  CANCELLED: '已取消',
};

/** 账单状态的文案 */
const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  OPEN: '待支付',
  PAID: '已支付',
  FAILED: '支付失败',
  VOID: '已作废',
};

/**
 * 订阅状态 → 中文文案。
 *
 * ⚠️ **null 是「未订阅」而不是「无状态」**：商家第一次进这一页看到的就是它，
 * 是一句正常的业务状态，不是异常。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 * 显示一个笼统的兜底文案，好过把裸枚举（`WEIRD`）糊到界面上。
 * 但**不能猜成「生效中」**——猜错了商家会以为自己在付费中。
 */
export function describeSubscriptionStatus(
  subscription: Subscription | null | undefined,
): string {
  if (!subscription) return '未订阅';
  return SUBSCRIPTION_STATUS_LABEL[subscription.status] ?? '未知状态';
}

/**
 * 账单状态 → 中文文案。
 *
 * ⚠️ 未知状态同样回落到「未知状态」（同上）。
 */
export function describeInvoiceStatus(invoice: Invoice): string {
  return INVOICE_STATUS_LABEL[invoice.status] ?? '未知状态';
}

/**
 * 金额：整数分 → 「¥99.00」。
 *
 * ⚠️ **0 元显示成「¥0.00」而不是「—」**：免费套餐与「拿不到价格」
 * 是两回事，前者是真的 0 元，后者是缺数据。混为一谈会让商家以为
 * 自己看错了。
 *
 * ⚠️ 这里**不自己造第二套换算**：直接用 `lib/money.ts` 的 `centsToYuan`
 * （那边是「元 ↔ 分」的单一出处）。
 */
export function formatPriceLabel(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `¥${centsToYuan(cents)}`;
}

/**
 * 额度：null → 「不限」。
 *
 * ⚠️ 后端用 null 表示「不限」，0 表示「一个都不许」——两者含义完全不同，
 * 不能都显示成 0。
 */
export function formatQuota(limit: number | null | undefined): string {
  if (limit === null || limit === undefined) return '不限';
  return String(limit);
}

/**
 * 抽佣率：基点 → 百分比。
 *
 * ⚠️ 500 基点 = 5%。**用整数运算先除再格式化**，不要写成
 * `bps / 100 + '%'`（那是 5.00%），也不是 `bps / 10`（那是 50%）。
 */
export function formatCommissionRate(bps: number): string {
  const percent = bps / 100;
  // ⚠️ 去掉多余的尾零：12.50% → 12.5%，12.00% → 12%。
  return `${Number(percent.toFixed(2))}%`;
}
