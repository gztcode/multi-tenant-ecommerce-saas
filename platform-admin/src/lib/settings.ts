import { apiFetchAuthed } from '@/lib/api-client';

/**
 * 平台设置（阶段 6a Task 4）的类型与服务端取数。
 *
 * ⚠️ **本文件只在服务端用**（`apiFetchAuthed` 内部 `await auth()`）：
 *    客户端组件**不能** import 它的函数，只允许 `import type` 取类型
 *    （类型导入在编译期被擦除，不会把服务端依赖带进浏览器包）。
 *
 * ⚠️ **渠道来源必须与后端逐字一致**：`'DATABASE' | 'ENV'` 写错一个字母，
 *    界面上就是裸枚举。
 */

/** 平台默认渠道的来源：后台配置 / 部署环境变量兜底 / 尚未配置 */
export type PayoutChannelSource = 'DATABASE' | 'ENV' | 'NONE';

/** 当前平台默认出款渠道及来源 */
export interface PayoutChannelSetting {
  /** `null` = 平台还没有配置默认渠道（此时仍然要渲染保存表单） */
  channel: string | null;
  source: PayoutChannelSource;
}

/** 可选的出款渠道（下拉用） */
export interface PayoutChannelOption {
  channel: string;
  provider: string;
}

/** 来源的中文文案 */
export const PAYOUT_CHANNEL_SOURCE_LABEL: Record<PayoutChannelSource, string> =
  {
    DATABASE: '后台配置',
    ENV: '部署环境变量兜底',
    // ⚠️ **必须与后端逐字一致**：后端「还没配」时返回 `source: 'NONE'`，
    //    漏了这个键界面会渲染成 `undefined`。
    NONE: '尚未配置',
  };

/** 读当前平台默认出款渠道（服务端） */
export async function fetchPayoutChannelSetting(): Promise<PayoutChannelSetting> {
  return apiFetchAuthed<PayoutChannelSetting>(
    '/platform/settings/payout-channel',
  );
}

/** 读可选出款渠道（服务端；后端已过滤未启用与 devOnly） */
export async function fetchPayoutChannelOptions(): Promise<
  PayoutChannelOption[]
> {
  return apiFetchAuthed<PayoutChannelOption[]>(
    '/platform/settings/payout-channels',
  );
}
