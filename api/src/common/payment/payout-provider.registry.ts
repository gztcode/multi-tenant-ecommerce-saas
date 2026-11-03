/**
 * 出款渠道注册表（阶段 6a Task 1）。
 *
 * ## 它解决什么问题
 *
 * 阶段 5m 之前，「按渠道取出款实现」靠 `providers.values().next().value`
 * —— 也就是**取第一个**。只有一个假网关时看不出来；接第二家渠道起，
 * 「按 `payouts.payoutChannel` 路由」就成了必须品。
 *
 * 注册表把「渠道名 → 实现」的解析、启用校验、生产环境 `devOnly` 拦截
 * 收在一处，调用方只问 `get(channel)`。
 *
 * ## ⚠️ 注册表**不读数据库、不解析默认渠道**
 *
 * 平台默认渠道存在 `platform_settings`（DB 优先，环境变量兜底），
 * 那条规则属于 `PlatformSettingService`。注册表只接受调用方**已经解析好**的渠道名
 * —— 否则 `PayoutProvidersModule`（核实服务要读默认渠道）会与设置模块形成环。
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_CHANNEL_TIMEOUT_MS,
  NO_CAPABILITIES,
  type ChannelDescriptor,
} from '../channel/channel.types';
import {
  isChannelEnabled,
  isProduction,
  normalizeChannel,
} from '../channel/channel-config';
import type { PayoutProvider } from './payout-provider.interface';
import { PAYOUT_PROVIDER_LIST } from './payout.constants';

/**
 * 未注册渠道的报错文案。
 *
 * ⚠️ 用 409（`ConflictException`）而不是 500：这是「运营配置错了」，
 * 不是「服务坏了」。文案要带渠道名，否则运营不知道改哪个配置项。
 */
function unregisteredMessage(channel: string): string {
  return `出款渠道 ${channel} 未注册：请检查 PAYOUT_ENABLED_CHANNELS 与部署的渠道实现。`;
}

/** 已注册但未启用 */
function disabledMessage(channel: string): string {
  return `出款渠道 ${channel} 未启用：请检查 PAYOUT_ENABLED_CHANNELS。`;
}

/** 生产环境使用 devOnly 渠道 */
function devOnlyMessage(channel: string): string {
  return `出款渠道 ${channel} 仅限非生产环境使用。`;
}

@Injectable()
export class PayoutProviderRegistry {
  private readonly byChannel = new Map<string, PayoutProvider>();
  private readonly descriptors = new Map<string, ChannelDescriptor>();

  constructor(
    @Inject(PAYOUT_PROVIDER_LIST) providers: readonly PayoutProvider[],
  ) {
    for (const provider of providers) {
      const channel = normalizeChannel(provider.channel);
      if (this.byChannel.has(channel)) {
        // ⚠️ 同渠道注册两次 = 配置错误。静默覆盖会让「到底用的哪个实现」
        //    变成部署顺序问题，必须启动即失败。
        throw new Error(`出款渠道 ${channel} 被重复注册。`);
      }
      this.byChannel.set(channel, provider);
      this.descriptors.set(channel, {
        channel,
        provider: provider.provider,
        kind: 'PAYOUT',
        devOnly: provider.devOnly === true,
        capabilities: provider.capabilities ?? NO_CAPABILITIES,
        timeoutMs: provider.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS,
      });
    }
  }

  /**
   * 按渠道名取出款实现。
   *
   * 校验顺序：已注册 → 已启用 → 生产环境非 devOnly。
   * 任何一步不过都抛中文 409，**绝不返回 `undefined`** ——
   * `undefined` 会在调用点变成 `Cannot read properties of undefined`，
   * 运营看到的是一句天书。
   */
  get(channel: string): PayoutProvider {
    const key = normalizeChannel(channel ?? '');

    if (key.length === 0) {
      throw new ConflictException(
        '未指定出款渠道：请检查出款单的 payoutChannel 或平台默认渠道配置。',
      );
    }

    const provider = this.byChannel.get(key);
    if (!provider) {
      throw new ConflictException(unregisteredMessage(key));
    }

    if (!isChannelEnabled('PAYOUT', key)) {
      throw new ConflictException(disabledMessage(key));
    }

    if (isProduction() && this.descriptors.get(key)?.devOnly === true) {
      throw new ConflictException(devOnlyMessage(key));
    }

    return provider;
  }

  /**
   * 出款执行时解析渠道。
   *
   * 顺序（见设计 §4.4）：
   * 1. 出款单已定渠道 → 沿用（重试不换渠道）；
   * 2. 商家偏好渠道；
   * 3. 平台默认渠道（由调用方先解析 DB → env）；
   * 4. 都没有 → 抛中文 409，**不回落、不猜**。
   *
   * ⚠️ 商家配置了但渠道已停用 → 直接抛错，**不静默切到平台默认**：
   *    钱打到哪家必须是确定的，切换等于偷偷改收款路径。
   */
  resolveForPayout(input: {
    payoutChannel?: string | null;
    merchantChannel?: string | null;
    platformChannel?: string | null;
  }): PayoutProvider {
    const fixed = normalizeChannel(input.payoutChannel ?? '');
    if (fixed.length > 0) {
      return this.get(fixed);
    }

    const merchant = normalizeChannel(input.merchantChannel ?? '');
    if (merchant.length > 0) {
      return this.get(merchant);
    }

    const platform = normalizeChannel(input.platformChannel ?? '');
    if (platform.length > 0) {
      return this.get(platform);
    }

    throw new ConflictException(
      '无法确定出款渠道：商家未配置默认渠道，平台也未配置默认渠道。',
    );
  }

  /** 按渠道名取描述符（后台下拉、验收记录用）；未注册返回 `null` */
  descriptor(channel: string): ChannelDescriptor | null {
    return this.descriptors.get(normalizeChannel(channel ?? '')) ?? null;
  }

  /**
   * 可用渠道列表。
   *
   * ⚠️ 默认过滤 `devOnly`，且只返回「已启用」的渠道 —— 后台下拉不出现
   * 选了也执行不了的选项。生产环境永远看不到 `sandbox`。
   */
  list(options?: { includeDevOnly?: boolean }): ChannelDescriptor[] {
    const includeDevOnly = options?.includeDevOnly === true && !isProduction();
    return Array.from(this.descriptors.values()).filter(
      (descriptor) =>
        isChannelEnabled('PAYOUT', descriptor.channel) &&
        (includeDevOnly || !descriptor.devOnly),
    );
  }

  /**
   * 某渠道的单次调用超时预算（毫秒，阶段 6b Task 13）。
   *
   * - 已注册：取描述符里的 `timeoutMs`（provider 没写时注册表已回落默认值）；
   * - 未注册 / 空渠道名：`DEFAULT_CHANNEL_TIMEOUT_MS`。
   *
   * ⚠️ **不抛错** —— 这是预算查询，不是路由决策；对账服务对「取不到实现」
   *    已有自己的报错路径，这里再抛一次只会把真实原因盖掉。
   * ⚠️ **不改 `get` / `list` 的语义** —— 它们仍按「已注册 → 已启用 → 非生产 devOnly」校验。
   */
  timeoutMs(channel: string): number {
    const descriptor = this.descriptors.get(normalizeChannel(channel ?? ''));
    return descriptor?.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
  }

  /** 已注册的渠道名（含未启用，排查用） */
  registeredChannels(): string[] {
    return Array.from(this.byChannel.keys());
  }
}
