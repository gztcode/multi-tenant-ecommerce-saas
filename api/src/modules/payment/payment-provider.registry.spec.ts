import { ConflictException } from '@nestjs/common';
import type { PaymentProvider } from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';

/**
 * 支付渠道注册表的单元测试（阶段 6a Task 1）。
 *
 * ⚠️ 支付注册表**没有默认渠道** —— 「猜一个默认支付渠道」等于替用户决定付款方式。
 *    所以这里不测 `resolve`，只测「写错渠道名必须显式报错」。
 */

const ALL = {
  refund: true,
  asyncRefund: false,
  asyncPayout: false,
  queryByReferenceNo: false,
  authorizedCharge: true,
  paymentMethod: true,
};

function provider(
  channel: string,
  over: Partial<PaymentProvider> = {},
): PaymentProvider {
  return {
    channel,
    provider: channel,
    capabilities: ALL,
    createPayment: jest.fn(),
    queryPayment: jest.fn(),
    refund: jest.fn(),
    queryRefund: jest.fn(),
    chargeAuthorized: jest.fn(),
    createPaymentMethod: jest.fn(),
    parseWebhook: jest.fn(),
    ...over,
  };
}

describe('PaymentProviderRegistry', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
    if (originalEnabled === undefined) {
      delete process.env.PAYMENT_ENABLED_CHANNELS;
    } else {
      process.env.PAYMENT_ENABLED_CHANNELS = originalEnabled;
    }
  });

  it('未注册的渠道 → 中文 409', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
    const registry = new PaymentProviderRegistry([provider('fake')]);

    expect(() => registry.get('not-exist')).toThrow(ConflictException);
    expect(() => registry.get('not-exist')).toThrow(/未注册/);
  });

  it('未启用的渠道 → 中文 409', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
    const registry = new PaymentProviderRegistry([
      provider('fake'),
      provider('other'),
    ]);

    expect(() => registry.get('other')).toThrow(/未启用/);
  });

  it('生产环境下 devOnly 渠道取不到，list() 也不返回', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake,sandbox';
    const registry = new PaymentProviderRegistry([
      provider('fake'),
      provider('sandbox', { devOnly: true }),
    ]);

    expect(() => registry.get('sandbox')).toThrow(/仅限非生产环境/);
    expect(registry.list().map((item) => item.channel)).toEqual(['fake']);
  });

  it('list() 默认过滤 devOnly，显式要求才带上', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake,sandbox';
    const registry = new PaymentProviderRegistry([
      provider('fake'),
      provider('sandbox', { devOnly: true }),
    ]);

    expect(registry.list().map((item) => item.channel)).toEqual(['fake']);
    expect(
      registry.list({ includeDevOnly: true }).map((item) => item.channel),
    ).toEqual(['fake', 'sandbox']);
  });

  it('同一渠道重复注册 → 构造时即失败', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
    expect(
      () => new PaymentProviderRegistry([provider('fake'), provider('fake')]),
    ).toThrow(/重复注册/);
  });
});
