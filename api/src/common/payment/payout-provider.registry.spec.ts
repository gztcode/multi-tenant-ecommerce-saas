import { ConflictException } from '@nestjs/common';
import type { PayoutProvider } from './payout-provider.interface';
import { PayoutProviderRegistry } from './payout-provider.registry';

/**
 * 出款渠道注册表的单元测试（阶段 6a Task 1）。
 *
 * ⚠️ 这里的用例覆盖的是**路由与闸门**，不是「能不能打款」：
 * ① 未注册 / 未启用的渠道必须中文 409，不能返回 `undefined`；
 * ② 生产环境即使注册了 `devOnly` 渠道也取不到，`list()` 也不返回；
 * ③ `resolveForPayout` 四条路径的优先级。
 */

const ALL = {
  refund: false,
  asyncRefund: false,
  asyncPayout: false,
  queryByReferenceNo: true,
  authorizedCharge: false,
  paymentMethod: false,
};

function provider(
  channel: string,
  over: Partial<PayoutProvider> = {},
): PayoutProvider {
  return {
    channel,
    provider: channel,
    capabilities: ALL,
    submit: jest.fn(),
    queryPayout: jest.fn(),
    listPayouts: jest.fn(),
    ...over,
  };
}

describe('PayoutProviderRegistry', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYOUT_ENABLED_CHANNELS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
    if (originalEnabled === undefined) {
      delete process.env.PAYOUT_ENABLED_CHANNELS;
    } else {
      process.env.PAYOUT_ENABLED_CHANNELS = originalEnabled;
    }
  });

  it('未注册的渠道 → 中文 409，而不是 undefined', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout';
    const registry = new PayoutProviderRegistry([provider('fake-payout')]);

    expect(() => registry.get('not-exist')).toThrow(ConflictException);
    expect(() => registry.get('not-exist')).toThrow(/未注册/);
  });

  it('已注册但未启用的渠道 → 中文 409', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout';
    const registry = new PayoutProviderRegistry([
      provider('fake-payout'),
      provider('other'),
    ]);

    expect(() => registry.get('other')).toThrow(ConflictException);
    expect(() => registry.get('other')).toThrow(/未启用/);
  });

  it('空渠道名 → 中文 409，提示未指定渠道', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout';
    const registry = new PayoutProviderRegistry([provider('fake-payout')]);

    expect(() => registry.get('')).toThrow(/未指定出款渠道/);
  });

  it('生产环境下 devOnly 渠道即使注册也取不到，list() 也不返回', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout,sandbox';
    const registry = new PayoutProviderRegistry([
      provider('fake-payout'),
      provider('sandbox', { devOnly: true }),
    ]);

    expect(() => registry.get('sandbox')).toThrow(/仅限非生产环境/);
    expect(registry.list().map((item) => item.channel)).toEqual([
      'fake-payout',
    ]);
  });

  it('非生产环境 devOnly 渠道默认不出现在 list()，显式要求才出现', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout,sandbox';
    const registry = new PayoutProviderRegistry([
      provider('fake-payout'),
      provider('sandbox', { devOnly: true }),
    ]);

    expect(registry.list().map((item) => item.channel)).toEqual([
      'fake-payout',
    ]);
    expect(
      registry.list({ includeDevOnly: true }).map((item) => item.channel),
    ).toEqual(['fake-payout', 'sandbox']);
  });

  it('list() 只返回已启用的渠道', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'fake-payout';
    const registry = new PayoutProviderRegistry([
      provider('fake-payout'),
      provider('other'),
    ]);

    expect(registry.list().map((item) => item.channel)).toEqual([
      'fake-payout',
    ]);
  });

  it('resolveForPayout：出款单已定渠道优先，忽略商家与平台配置', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a,b,c';
    const registry = new PayoutProviderRegistry([
      provider('a'),
      provider('b'),
      provider('c'),
    ]);

    const resolved = registry.resolveForPayout({
      payoutChannel: 'a',
      merchantChannel: 'b',
      platformChannel: 'c',
    });
    expect(resolved.channel).toBe('a');
  });

  it('resolveForPayout：出款单没定 → 商家配置', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a,b,c';
    const registry = new PayoutProviderRegistry([
      provider('a'),
      provider('b'),
      provider('c'),
    ]);

    const resolved = registry.resolveForPayout({
      payoutChannel: null,
      merchantChannel: 'b',
      platformChannel: 'c',
    });
    expect(resolved.channel).toBe('b');
  });

  it('resolveForPayout：商家没配 → 平台默认', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a,b,c';
    const registry = new PayoutProviderRegistry([
      provider('a'),
      provider('b'),
      provider('c'),
    ]);

    const resolved = registry.resolveForPayout({
      payoutChannel: null,
      merchantChannel: null,
      platformChannel: 'c',
    });
    expect(resolved.channel).toBe('c');
  });

  it('resolveForPayout：全都没有 → 中文 409，不猜', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a';
    const registry = new PayoutProviderRegistry([provider('a')]);

    expect(() =>
      registry.resolveForPayout({
        payoutChannel: null,
        merchantChannel: null,
        platformChannel: null,
      }),
    ).toThrow(/无法确定出款渠道/);
  });

  it('商家配置的渠道已停用 → 抛错，不静默回落到平台默认', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a';
    const registry = new PayoutProviderRegistry([provider('a'), provider('b')]);

    expect(() =>
      registry.resolveForPayout({
        payoutChannel: null,
        merchantChannel: 'b',
        platformChannel: 'a',
      }),
    ).toThrow(/未启用/);
  });

  it('同一渠道重复注册 → 构造时即失败', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a';
    expect(
      () => new PayoutProviderRegistry([provider('a'), provider('a')]),
    ).toThrow(/重复注册/);
  });

  it('descriptor() 补齐默认超时与能力', () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYOUT_ENABLED_CHANNELS = 'a';
    const registry = new PayoutProviderRegistry([provider('a')]);

    const descriptor = registry.descriptor('a');
    expect(descriptor).toMatchObject({
      channel: 'a',
      kind: 'PAYOUT',
      devOnly: false,
      timeoutMs: 10_000,
    });
    expect(registry.descriptor('missing')).toBeNull();
  });
});
