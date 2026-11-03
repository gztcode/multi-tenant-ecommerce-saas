/**
 * 渠道启用的环境变量解析（阶段 6a Task 1）。
 *
 * ## 为什么单独一个文件
 *
 * 「哪些渠道被启用」有两个读者：
 * 1. 两个注册表（`PayoutProviderRegistry` / `PaymentProviderRegistry`）；
 * 2. 平台默认渠道的设置服务（写入前要校验渠道已启用）。
 *
 * 让设置服务去依赖注册表会形成
 * `PayoutProvidersModule`（要注入设置服务做核实兜底）↔ 设置模块 的环，
 * 所以把「纯环境变量解析」抽出来，两处共用同一份事实。
 *
 * ⚠️ **本文件不读数据库、不读默认渠道配置** —— 那些是 `PlatformSettingService` 的事。
 */
import type { ChannelKind } from './channel.types';

/**
 * 非生产环境的兜底启用列表。
 *
 * ⚠️ 两个用途的假网关**渠道名不同**（`fake` / `fake-payout`）——
 *    它们本来就是两个独立实现、两个独立开关（`FAKE_PAYMENT_ENABLED` /
 *    `FAKE_PAYOUT_ENABLED`），统一成一个名字反而会让人以为开一个就开了两个。
 */
const DEV_DEFAULT_CHANNELS: Record<ChannelKind, string> = {
  PAYMENT: 'fake',
  PAYOUT: 'fake-payout',
};

/** 每个用途对应的环境变量名 */
const ENABLED_ENV_KEY: Record<ChannelKind, string> = {
  PAYMENT: 'PAYMENT_ENABLED_CHANNELS',
  PAYOUT: 'PAYOUT_ENABLED_CHANNELS',
};

/**
 * **仅限非生产环境**的渠道名单（单一事实来源）。
 *
 * ⚠️ 这份名单有三处读者：启动校验（`assert-secure-config`）、平台默认渠道设置
 * （`PlatformSettingService` 写入前校验）、以及 provider 自身的 `devOnly` 标记。
 * 分散写三份必然漂移 —— 曾经出现过「启动校验拒绝、后台却能设成生产默认」。
 * 需要新增 devOnly 渠道时**只改这里**，同时给 provider 打 `devOnly: true`。
 */
const DEV_ONLY_CHANNELS: Record<ChannelKind, readonly string[]> = {
  PAYMENT: ['fake', 'sandbox'],
  PAYOUT: ['fake-payout', 'sandbox'],
};

/** 某渠道是否仅限非生产环境 */
export function isDevOnlyChannel(kind: ChannelKind, channel: string): boolean {
  return DEV_ONLY_CHANNELS[kind].includes(normalizeChannel(channel));
}

/** 某用途下所有 devOnly 渠道（启动校验报错时列名单用） */
export function devOnlyChannels(kind: ChannelKind): readonly string[] {
  return DEV_ONLY_CHANNELS[kind];
}

/** 当前是否是生产环境 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** 把渠道名归一化（去空白 + 小写），空值返回空串 */
export function normalizeChannel(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 某用途下已启用的渠道列表（去重、保持声明顺序）。
 *
 * - 环境变量未设置：非生产回落 `fake`；**生产返回空数组**（fail-closed，
 *   由 `assert-secure-config` 在启动时报错，而不是悄悄启用假渠道）。
 * - 环境变量设置为空串：与未设置同义。
 */
export function enabledChannels(kind: ChannelKind): string[] {
  const raw = process.env[ENABLED_ENV_KEY[kind]];
  const list = (raw ?? '')
    .split(',')
    .map(normalizeChannel)
    .filter((item) => item.length > 0);

  if (list.length === 0) {
    return isProduction() ? [] : [DEV_DEFAULT_CHANNELS[kind]];
  }

  return Array.from(new Set(list));
}

/** 某用途下某个渠道是否已启用 */
export function isChannelEnabled(kind: ChannelKind, channel: string): boolean {
  const target = normalizeChannel(channel);
  if (target.length === 0) {
    return false;
  }
  return enabledChannels(kind).includes(target);
}
