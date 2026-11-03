/**
 * 渠道描述符与能力声明（阶段 6a Task 1）。
 *
 * ## 为什么要单独一层「描述符」
 *
 * 渠道不再只是「一个 Map 里的实现」，它还要回答：
 * - 这个渠道生产环境能不能用（`devOnly`）
 * - 它支持哪些动作（能力门控：不支持的动作要**显式拒绝**，不能静默失效）
 * - 它一次调用愿意等多久（超时预算）
 *
 * 把这些放进描述符，注册表与后台下拉都读同一份事实，
 * 不会出现「后台能选、执行时却不支持」的错配。
 */

/** 渠道的用途分类 */
export type ChannelKind = 'PAYMENT' | 'PAYOUT';

/**
 * 渠道能力声明。
 *
 * ⚠️ **缺省一律按「不支持」处理**（fail-closed）：
 * 能力不是「没写就默认支持」，而是「写明才支持」。
 * 否则新增渠道时忘了声明，退款会被静默当成成功。
 */
export interface ChannelCapabilities {
  /** 能否在线退款 */
  refund: boolean;
  /** 退款是否异步：受理后要 `queryRefund` / 回调才能确认结果 */
  asyncRefund: boolean;
  /** 出款是否异步：`submit` 可能返回 `PROCESSING`，要 `queryPayout` 轮询 */
  asyncPayout: boolean;
  /** 能否按 `referenceNo` 查单（没有 `providerTxnId` 的存量单靠它核实） */
  queryByReferenceNo: boolean;
  /** 能否用已授权的支付方式直接扣款（自动续费） */
  authorizedCharge: boolean;
  /** 能否创建支付方式（绑卡 / 授权） */
  paymentMethod: boolean;
}

/** 一个渠道对外的完整描述（注册表、后台下拉、验收记录共用） */
export interface ChannelDescriptor {
  /** 渠道名（`payments.channel` / `payouts.payoutChannel` 里存的值） */
  channel: string;
  /** 服务提供方名 */
  provider: string;
  /** 用途分类 */
  kind: ChannelKind;
  /**
   * 只在非生产环境可用。
   *
   * ⚠️ 生产环境即使把它写进启用列表，也必须取不到 —— 这是「沙箱不上生产」的
   * 最后一道闸（启动校验是第二道，注册表是运行时那道）。
   */
  devOnly: boolean;
  /** 能力声明 */
  capabilities: ChannelCapabilities;
  /** 单次调用超时预算（毫秒） */
  timeoutMs: number;
}

/** 「全不支持」的能力基线：新增渠道没写的能力按这条算 */
export const NO_CAPABILITIES: ChannelCapabilities = {
  refund: false,
  asyncRefund: false,
  asyncPayout: false,
  queryByReferenceNo: false,
  authorizedCharge: false,
  paymentMethod: false,
};

/** 默认单次调用超时预算（毫秒） */
export const DEFAULT_CHANNEL_TIMEOUT_MS = 10_000;
