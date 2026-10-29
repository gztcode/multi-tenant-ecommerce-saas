/**
 * 平台超管后台的计费模块（套餐 / 订阅 / 报表）的类型与展示纯函数。
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
 * 套餐（平台的数据）。
 *
 * ⚠️ **没有 `tenantId`**：套餐是平台的数据，不属于任何租户。
 */
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

/**
 * 平台视角的订阅（一行里带上租户名与套餐名）。
 *
 * ⚠️ **租户名与套餐名是后端查好一起返回的**：订阅表上只有 `tenantId`
 * 与 `planId` 两个纯标量，没有 Prisma 关系，后端是分别查完再合并的。
 */
export interface PlatformSubscription {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSubdomain: string;
  planId: string;
  planName: string;
  /** 待生效的套餐（下个周期生效）。null = 不换 */
  pendingPlanId: string | null;
  pendingPlanName: string | null;
  status: SubscriptionStatus;
  /** 抽佣比例（基点）。查不到套餐时后端给 0 */
  commissionBps: number;
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
}

/**
 * 列表接口的统一信封（套餐与订阅列表都是这个形状）
 */
export interface ListResult<T> {
  items: T[];
  total: number;
}

/**
 * ⚠️ **后端订阅列表按 200 条截断**（`SUBSCRIPTION_PAGE_SIZE`），
 * `total` 是真实总数。页面要靠 `total > items.length` 提示「还有更多」。
 */
export type PlanList = ListResult<Plan>;
export type SubscriptionList = ListResult<PlatformSubscription>;

/**
 * 平台收入报表。
 *
 * ⚠️ **金额一律整数分**：抽佣与净收入都在后端算好，前端只做展示换算。
 */
export interface ReportSummary {
  /** 区间起点。ISO 8601 */
  from: string;
  /** 区间终点（不含）。ISO 8601 */
  to: string;
  /** 订阅收入：区间内已付账单的金额之和 */
  subscriptionRevenue: number;
  /** 抽佣收入（毛额）：区间内收过钱的订单的抽佣快照之和 */
  commissionRevenue: number;
  /** 退款冲回：区间内已退款订单当初抽了多少 */
  reversal: number;
  /** 净收入 = 订阅收入 + 抽佣收入 − 冲回 */
  netRevenue: number;
}

/**
 * 平台的抽佣明细。
 *
 * ⚠️ **金额一律整数分**：净额由后端算好，前端只做展示换算
 * （与 `ReportSummary` 同款原则）。
 */
export interface CommissionLedger {
  /** 区间起点。ISO 8601 */
  from: string;
  /** 区间终点（ISO 8601，**不含**） */
  to: string;
  /** 按商家汇总 */
  byMerchant: Array<{
    tenantId: string;
    tenantName: string;
    subdomain: string;
    /** 净抽佣（整数分，可负） */
    netAmount: number;
    entryCount: number;
    reversalCount: number;
  }>;
  /** 抽佣流水明细 */
  entries: Array<{
    id: string;
    tenantId: string;
    orderNo: string;
    type: 'COMMISSION' | 'REVERSAL';
    /** 带符号：抽佣为正、冲回为负 */
    amount: number;
    /** 费率（基点，万分之一） */
    rateBps: number;
    /** 计佣基数（整数分） */
    baseAmount: number;
    /** ISO 8601 */
    occurredAt: string;
  }>;
}

/** 抽佣流水类型的文案 */
export const COMMISSION_ENTRY_TYPE_LABEL: Record<
  'COMMISSION' | 'REVERSAL',
  string
> = {
  COMMISSION: '抽佣',
  REVERSAL: '退款冲回',
};

/** 套餐状态的文案 */
const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  ACTIVE: '在售',
  DISABLED: '已下架',
};

/** 订阅状态的文案 */
const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  TRIAL: '试用中',
  ACTIVE: '生效中',
  EXPIRED: '已到期',
  CANCELLED: '已取消',
};

/**
 * 已知的功能开关的中文名。
 *
 * ⚠️ **这只是「锦上添花」**：表里没有的键**照样要显示**（见
 * `formatFeatureFlags`）——超管要看到套餐究竟开了什么，
 * 静默丢掉未知键等于把「前端还没跟上后端」这件事藏起来。
 */
const FEATURE_LABEL: Record<string, string> = {
  marketing: '营销工具',
  coupon: '优惠券',
  analytics: '数据分析',
  multiStore: '多店铺',
  apiAccess: 'API 接入',
  prioritySupport: '优先客服',
};

/**
 * 套餐状态 → 中文文案。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 * 显示一个笼统的兜底文案，好过把裸枚举（`WEIRD`）糊到界面上。
 * 但**不能猜成「在售」**——猜错了超管会以为一个已下架的套餐还在卖。
 */
export function describePlanStatus(status: PlanStatus | string): string {
  return PLAN_STATUS_LABEL[status as PlanStatus] ?? '未知状态';
}

/**
 * 订阅状态 → 中文文案。
 *
 * ⚠️ 未知状态同样回落到「未知状态」（同上），**不能猜成「生效中」**——
 * 猜错了超管会以为这是一家还在付费的商家。
 */
export function describeSubscriptionStatus(
  status: SubscriptionStatus | string,
): string {
  return SUBSCRIPTION_STATUS_LABEL[status as SubscriptionStatus] ?? '未知状态';
}

/**
 * 金额：整数分 → 「¥99.00」。
 *
 * ⚠️ **0 元显示成「¥0.00」而不是「—」**：免费套餐与「拿不到价格」
 * 是两回事，前者是真的 0 元，后者是缺数据。混为一谈会让超管以为
 * 自己看错了。
 *
 * ⚠️ 这里**不自己造第二套换算**：直接用 `lib/money.ts` 的 `centsToYuan`
 * （那边是「元 ↔ 分」的单一出处）。阶段 5b 已经在 merchant-admin 上踩过
 * 一次「各写各的换算、结果差一分钱」的坑。
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

/**
 * 订阅周期：天数 → 「30 天」。
 *
 * ⚠️ 不折算成「1 个月」——30 天与「月」不是一回事（有的月份 31 天），
 * 折算出来的「月」在边界上会算错。
 */
export function formatPeriodDays(days: number): string {
  return `${days} 天`;
}

/**
 * 时间戳 → 本地时间字符串。
 *
 * ⚠️ **解析失败时原样回显**：后端某天返回了一个意外的时间串，
 * 这里是表格里的一个单元格，炸掉它等于整张表都渲染不出来。
 * 原样回显至少能让超管一眼看出「这个值不对」。
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 功能开关 → 可读描述。
 *
 * ⚠️ **未知的键也要显示出来**（用原始键名）：超管要知道套餐究竟开了什么，
 * 静默丢掉未知键等于把「前端还没跟上后端」这件事藏起来。
 * 已知键显示中文名（`marketing` → 「营销工具」）。
 *
 * ⚠️ **只显示「开」的开关**：功能开关缺省一律视为 false（保守），
 * 全列出 `{ marketing: false }` 只会让界面上多出一堆「没开」的噪音。
 */
export function formatFeatureFlags(features: Record<string, unknown>): string {
  const entries = Object.entries(features).filter(([, value]) => value === true);
  if (entries.length === 0) return '无';

  return entries
    .map(([key]) => FEATURE_LABEL[key] ?? key)
    .join('、');
}

/**
 * 收入：整数分 → 「¥99.00」。
 *
 * ⚠️ **直接复用 `formatPriceLabel`**：两者都是「整数分 → 带 ¥ 的两位小数」，
 * 换算逻辑一模一样，另写一份迟早漂移。语义上的区别（价格 / 收入）
 * 不需要两套代码 —— 上下文（表头写着「收入」还是「价格」）已经说清了。
 */
export function formatRevenueLabel(cents: number | null | undefined): string {
  return formatPriceLabel(cents);
}

/**
 * 一段区间的结果。
 */
export interface IsoRange {
  /** 区间起点（含） */
  from: string;
  /** 区间终点（**不含**） */
  to: string;
}

/**
 * 「自然日」→ 带时区的 ISO 区间。
 *
 * ⚠️ **为什么需要这一步**：`<input type="date">` 交出来的是 `2026-01-01`
 * 这种**不带时区**的串，它被 `new Date()` 解析成 UTC 零点，而
 * `2026-01-01T00:00:00` 被解析成**本地**零点 —— 两者差一个时区偏移。
 * 报表的区间是左闭右开 `[from, to)`，混着两种解析会让「同一天」
 * 有时算成同一天、有时差 8 小时。
 *
 * ⚠️ **一律按 UTC 自然日算**：整个系统的时间都是 UTC
 * （数据库的 `now()`、订单的 `paidAt`、账单的 `paidAt`），
 * 报表的日界跟它们对齐才不会差 8 小时。
 *
 * ⚠️ **终点是「区间的结束时刻，不含」**：用户选 1 月 1 日到 1 月 31 日，
 * 转出来是 `[2026-01-01T00:00:00.000Z, 2026-02-01T00:00:00.000Z)` ——
 * 1 月 31 日整天都在里面，且与下一个月的区间严丝合缝（不重不漏）。
 */
export function toIsoRange(
  fromDate: string,
  toDate: string,
): IsoRange | { error: string } {
  const from = parseUtcDay(fromDate);
  if ('error' in from) return from;
  const to = parseUtcDay(toDate);
  if ('error' in to) return to;

  if (to.time < from.time) {
    return { error: '结束日期不能早于开始日期' };
  }

  return {
    from: from.iso,
    // ⚠️ **终点是次日零点**（区间右开）：结束日期那一整天要包含在区间里。
    to: new Date(to.time + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * 「抽佣比例（%）」的输入 → 基点（万分之）。
 *
 * ⚠️ **只接受最多两位小数的非负数**：`'5.555'`、`'-1'`、`'1e3'`、`'abc'`
 * 一律返回 null（调用方据此提示用户重填）——与 `lib/money.ts` 的
 * `yuanToCents` 同款纪律：**猜出来的费率比没有费率更危险**。
 *
 * ⚠️ **用正则而不是 `parseFloat`**：`parseFloat('5.5abc')` 会解析出 5.5，
 * `parseFloat('1e3')` 会解析出 1000 —— 超管敲错的东西被悄悄当成合法费率，
 * 而费率直接决定平台从每笔订单里抽多少。
 *
 * ⚠️ **必须取整**：`5.55 * 100` 的真值是 `555.0000000000001`，
 * 不取整会传出去一个非整数基点，后端的 `@IsInt()` 会 400，
 * 界面上只剩一句没头没尾的「校验失败」。
 *
 * @returns 基点；输入不合法时返回 null
 */
export function percentToBps(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const bps = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(bps) ? bps : null;
}

/**
 * `YYYY-MM-DD` → 那天的 UTC 零点。
 *
 * ⚠️ **必须回查年月日**：`Date.UTC(2026, 1, 30)`（2 月 30 日）会被静默
 * 滚成 3 月 2 日，不回查就等于放过一个不存在的日期。
 *
 * ⚠️ 两位数年份会被 `Date.UTC` 映射到 20 世纪（`26` → 1926），
 * 回查年份时自然被判成非法，不用额外处理。
 */
function parseUtcDay(
  value: string,
): { iso: string; time: number } | { error: string } {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) {
    return { error: `日期必须是 YYYY-MM-DD 格式（收到 ${value}）` };
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const time = Date.UTC(year, month - 1, day);

  const check = new Date(time);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { error: `日期不存在：${value}` };
  }

  return { iso: check.toISOString(), time };
}

// ============================================================
// 结算单（阶段 5g）
// ============================================================

/**
 * 结算单的状态。
 *
 * ⚠️ **必须与后端 Prisma 的 `SettlementStatus` 逐字一致**：
 * 写成 `CONFIRMED` 之外的拼法，界面上就是裸枚举。
 */
export type SettlementStatus = 'DRAFT' | 'CONFIRMED' | 'PAID';

/** 结算单的一行 */
export interface SettlementStatement {
  id: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  statementNo: string;
  /** 周期起点（含）。ISO 8601 */
  periodStart: string;
  /** 周期终点（不含）。ISO 8601 */
  periodEnd: string;
  /** 周期标识（`YYYY-MM`） */
  periodLabel: string;
  /** 抽佣毛额（整数分） */
  grossAmount: number;
  /** 退款冲回（整数分，负数） */
  reversalAmount: number;
  /** 净额（整数分，**可以是负数**） */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
  status: SettlementStatus;
  /** 确认时间。ISO 8601。null = 未确认 */
  confirmedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
}

/** 结算单详情（含明细行） */
export interface SettlementDetail extends SettlementStatement {
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: 'COMMISSION' | 'REVERSAL';
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
}

/** 列表接口的信封 */
export interface SettlementListResult {
  items: SettlementStatement[];
  total: number;
}

/** 生成接口的返回 */
export interface SettlementGenerateResult {
  items: SettlementStatement[];
  created: number;
  skipped: number;
  /**
   * 批量生成时**没能出单**的商家（其余商家已出单成功）。
   *
   * ⚠️ **后端在批量模式下不中断整批**：有冲突的商家没出单，
   * 其他商家的单据照样建好了 —— 所以这**不是失败**，必须单独提示。
   *
   * ⚠️ **可选**：后端某些路径不返回它（且测试里的 mock 数据也没有）。
   */
  conflicts?: Array<{ tenantId: string; message: string }>;
  /**
   * 被**复用**但与当期流水对不上的商家（笔数不一致 → 可能缺笔）。
   *
   * ⚠️ **后端只标记不改单据**（已 CONFIRMED 的单是冻结的），
   * 唯一的修正路径是用户手动「取消确认 → 重算」。
   *
   * ⚠️ **可选**：同上。
   */
  stale?: string[];
}

/** 结算单状态的中文文案 */
const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  DRAFT: '草稿',
  CONFIRMED: '已确认',
  PAID: '已出款',
};

/**
 * 结算单状态 → 中文文案。
 *
 * ⚠️ **未知状态回落到「未知状态」**：后端加了新状态而前端还没跟上时，
 * 显示笼统的兜底文案好过把裸枚举糊到界面上。
 */
export function describeSettlementStatus(
  status: SettlementStatus | string,
): string {
  return SETTLEMENT_STATUS_LABEL[status as SettlementStatus] ?? '未知状态';
}
