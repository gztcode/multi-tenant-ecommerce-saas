/**
 * 支付渠道注册表（阶段 6a Task 1）。
 *
 * 与 `PayoutProviderRegistry` 同构，但**没有默认渠道** ——
 * 支付必须由调用方显式给出渠道名（用户选了什么就付什么），
 * 「猜一个默认支付渠道」等于替用户决定付款方式。
 *
 * ⚠️ 校验顺序与出款一致：已注册 → 已启用 → 生产环境非 devOnly。
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_CHANNEL_TIMEOUT_MS,
  NO_CAPABILITIES,
  type ChannelDescriptor,
} from '../../common/channel/channel.types';
import {
  isChannelEnabled,
  isProduction,
  normalizeChannel,
} from '../../common/channel/channel-config';
import type { PaymentProvider } from './payment-provider.interface';
import { PAYMENT_PROVIDER_LIST } from './payment.constants';

function unregisteredMessage(channel: string): string {
  return `支付渠道 ${channel} 未注册：请检查 PAYMENT_ENABLED_CHANNELS 与部署的渠道实现。`;
}

function disabledMessage(channel: string): string {
  return `支付渠道 ${channel} 未启用：请检查 PAYMENT_ENABLED_CHANNELS。`;
}

function devOnlyMessage(channel: string): string {
  return `支付渠道 ${channel} 仅限非生产环境使用。`;
}

@Injectable()
export class PaymentProviderRegistry {
  private readonly byChannel = new Map<string, PaymentProvider>();
  private readonly descriptors = new Map<string, ChannelDescriptor>();

  constructor(
    @Inject(PAYMENT_PROVIDER_LIST) providers: readonly PaymentProvider[],
  ) {
    for (const provider of providers) {
      const channel = normalizeChannel(provider.channel);
      if (this.byChannel.has(channel)) {
        throw new Error(`支付渠道 ${channel} 被重复注册。`);
      }
      this.byChannel.set(channel, provider);
      this.descriptors.set(channel, {
        channel,
        provider: provider.provider,
        kind: 'PAYMENT',
        devOnly: provider.devOnly === true,
        capabilities: provider.capabilities ?? NO_CAPABILITIES,
        timeoutMs: provider.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS,
      });
    }
  }

  /** 按渠道名取支付实现；未注册 / 未启用 / 生产 devOnly → 中文 409 */
  get(channel: string): PaymentProvider {
    const key = normalizeChannel(channel ?? '');

    if (key.length === 0) {
      throw new ConflictException('未指定支付渠道。');
    }

    const provider = this.byChannel.get(key);
    if (!provider) {
      throw new ConflictException(unregisteredMessage(key));
    }

    if (!isChannelEnabled('PAYMENT', key)) {
      throw new ConflictException(disabledMessage(key));
    }

    if (isProduction() && this.descriptors.get(key)?.devOnly === true) {
      throw new ConflictException(devOnlyMessage(key));
    }

    return provider;
  }

  /** 按渠道名取描述符；未注册返回 `null` */
  descriptor(channel: string): ChannelDescriptor | null {
    return this.descriptors.get(normalizeChannel(channel ?? '')) ?? null;
  }

  /** 可用支付渠道（默认过滤 `devOnly` 与未启用） */
  list(options?: { includeDevOnly?: boolean }): ChannelDescriptor[] {
    const includeDevOnly = options?.includeDevOnly === true && !isProduction();
    return Array.from(this.descriptors.values()).filter(
      (descriptor) =>
        isChannelEnabled('PAYMENT', descriptor.channel) &&
        (includeDevOnly || !descriptor.devOnly),
    );
  }

  /** 已注册的渠道名（含未启用，排查用） */
  registeredChannels(): string[] {
    return Array.from(this.byChannel.keys());
  }
}
