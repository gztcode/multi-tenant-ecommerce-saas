import { ConflictException } from '@nestjs/common';
import { ReconciliationDiffType } from '@prisma/client';
import { PayoutVerificationService } from './payout-verification.service';
import type { PayoutProvider } from './payout-provider.interface';
import type { PayoutProviderRegistry } from './payout-provider.registry';

/**
 * 核实服务的单元测试（阶段 5m / 6a）。
 *
 * ⚠️ **三档结论各要一条** —— `PAID` / `FAILED` / `UNKNOWN`。
 *    `UNKNOWN` 这档最容易被漏测，而它恰恰是「宁可不做也不重复打款」的落点。
 *
 * ⚠️ **阶段 6a：按 `target.payoutChannel` 取渠道** ——
 *    与打款 worker 必须取到同一个渠道，否则「钱打到 A、核实查 B」= 重复打款。
 */

/**
 * 一只假的出款渠道。
 *
 * ⚠️ **刻意不写返回类型**：写成 `: PayoutProvider` 会把各方法推断成
 *    「方法签名」，eslint 的 `unbound-method` 规则就不许把 `provider.queryPayout`
 *    单独取出来断言；不写注解时推断成 `jest.Mock` **属性**，断言才合法
 *    （与 `payment.service.spec.ts` 同一做法）。
 *
 * ⚠️ **`status` 用 `as const`** —— 否则 `Promise.resolve({ status: 'UNKNOWN' })`
 *    会被推断成 `string`，不满足 `PayoutQueryResult` 的字面量联合类型。
 */
function fakeProvider(over: Partial<PayoutProvider> = {}) {
  return {
    channel: 'fake-payout',
    provider: 'fake-payout',
    capabilities: {
      refund: false,
      asyncRefund: false,
      asyncPayout: false,
      queryByReferenceNo: true,
      authorizedCharge: false,
      paymentMethod: false,
    },
    submit: jest.fn(),
    queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' as const })),
    listPayouts: jest.fn(() => Promise.resolve([])),
    ...over,
  };
}

/**
 * 假的出款渠道注册表（阶段 6a）。
 *
 * ⚠️ **按渠道名精确取实现**，未注册抛中文 409 —— 与真实注册表同口径。
 */
function fakeRegistry(providers: PayoutProvider[]) {
  const byChannel = new Map(providers.map((p) => [p.channel, p]));
  return {
    get: jest.fn((channel: string) => {
      const found = byChannel.get(channel);
      if (!found) {
        throw new ConflictException(`出款渠道 ${channel} 未注册`);
      }
      return found;
    }),
    resolveForPayout: jest.fn(),
    descriptor: jest.fn(() => null),
    list: jest.fn(() => []),
    registeredChannels: jest.fn(() => Array.from(byChannel.keys())),
  } as unknown as PayoutProviderRegistry & {
    get: jest.Mock;
    resolveForPayout: jest.Mock;
  };
}

/** 假的平台设置服务 —— 默认渠道可配置，默认 `fake-payout` */
function fakeSettings(channel = 'fake-payout') {
  return {
    getPayoutDefaultChannel: jest.fn(() =>
      Promise.resolve({ channel, source: 'DATABASE' as const }),
    ),
  };
}

/**
 * 造一个核实服务。
 *
 * ⚠️ **默认渠道与假 provider 同名** —— 老用例不传 `payoutChannel`，
 *    走平台默认渠道，行为与阶段 5m 一致。
 */
function makeService(
  options: {
    providers?: PayoutProvider[];
    findMany?: jest.Mock;
    defaultChannel?: string;
  } = {},
) {
  const registry = fakeRegistry(options.providers ?? [fakeProvider()]);
  const settings = fakeSettings(options.defaultChannel);
  const findMany =
    options.findMany ?? jest.fn(() => Promise.resolve([] as unknown[]));
  const service = new PayoutVerificationService(
    registry,
    { payoutReconciliationItem: { findMany } } as never,
    settings as never,
  );
  return { service, registry, settings, findMany };
}

const target = {
  id: 'payout-1',
  payoutNo: 'PAY1',
  payoutTxnId: null,
  payoutChannel: null as string | null,
};

/**
 * `payoutReconciliationItem.findMany` 的入参形状。
 *
 * ⚠️ **要显式声明** —— `jest.fn(() => ...)` 会把参数推断成**零参元组**，
 *    `mock.calls[0][0]` 就成了类型错误（而 jest 的 transform 不做完整类型检查，
 *    所以单测能跑过、`tsc --noEmit` 却会红）。
 */
type FindManyArgs = {
  where: { type: { in: ReconciliationDiffType[] } };
  orderBy: unknown;
};

describe('PayoutVerificationService', () => {
  it('第 1 层：渠道说 SUCCESS → PAID', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'SUCCESS', amount: 8500 }),
      ),
    });
    const { service } = makeService({ providers: [provider] });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('PAID');
    expect(verdict.source).toBe('REALTIME');
    expect(verdict.amount).toBe(8500);
  });

  it('第 1 层：渠道说 FAILED 且 definitive=true → FAILED', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'FAILED', definitive: true }),
      ),
    });
    const { service } = makeService({ providers: [provider] });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('FAILED');
    expect(verdict.source).toBe('REALTIME');
  });

  it('⚠️⚠️ 第 1 层：渠道说 FAILED 但 definitive=false → 不得当 FAILED（结果未知）', async () => {
    // ⚠️ **「结果未知」放行解卡 = 重复打款** —— 只有渠道**明确说没打**
    //    才能认定 FAILED；`definitive` 缺省也按未知处理（fail-closed）。
    const provider = fakeProvider({
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'FAILED', definitive: false }),
      ),
    });
    const { service } = makeService({ providers: [provider] });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 第 1 层：渠道说 FAILED 但没给 definitive → 同按未知处理', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'FAILED' })),
    });
    const { service } = makeService({ providers: [provider] });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 第 1 层查不到 → 降级查对账结果', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          // ⚠️ **真实行必带 `type`** —— 第 2 层按 type 白名单判定
          type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
          channelStatus: 'SUCCESS',
          channelTxnId: 'txn-9',
          channelAmount: 8500,
          channelPaidAt: new Date('2026-03-02T00:00:00.000Z'),
        },
      ]),
    );
    const { service } = makeService({ providers: [provider], findMany });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('PAID');
    expect(verdict.source).toBe('RECONCILIATION');
    expect(verdict.providerTxnId).toBe('txn-9');
  });

  it('⚠️ 渠道抛错 → 降级查对账结果（不是「渠道说没打」）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.reject(new Error('渠道不可用'))),
    });
    const { service } = makeService({ providers: [provider] });

    const verdict = await service.verify(target);

    // ⚠️ **绝不能是 FAILED** —— 渠道挂了就当「渠道说没打」→ 会放行解卡 → 重复打款
    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 问不出结论 → UNKNOWN（fail-closed）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const { service } = makeService({ providers: [provider] });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 核实用的是 referenceNo（payoutNo），不是 payoutTxnId', async () => {
    const queryPayout = jest.fn(() =>
      Promise.resolve({ status: 'FAILED' as const, definitive: true }),
    );
    const { service } = makeService({
      providers: [fakeProvider({ queryPayout })],
    });

    await service.verify(target);

    // ⚠️ **PROCESSING 的单没有 payoutTxnId** —— 只按交易号查 → 核实闸对它的
    //    全部对象都是死代码 → 解卡功能 100% 不可用
    expect(queryPayout).toHaveBeenCalledWith({ referenceNo: 'PAY1' });
  });

  it('⚠️⚠️ 按 target.payoutChannel 取渠道（与 worker 同一渠道），不取默认渠道', async () => {
    // ⚠️ **这是「两处取不同渠道 = 重复打款」的回归测试** ——
    //    打款走 A，核实却查默认渠道 B → B 说「没打」→ 放行解卡 → 重复打款。
    const providerA = fakeProvider({
      channel: 'channel-a',
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'FAILED', definitive: true }),
      ),
    });
    const providerB = fakeProvider({
      channel: 'channel-b',
      queryPayout: jest.fn(() => Promise.resolve({ status: 'SUCCESS' })),
    });
    const { service, registry } = makeService({
      providers: [providerB, providerA],
      // ⚠️ **平台默认故意设成 B** —— 若核实用了默认渠道就会得出相反结论
      defaultChannel: 'channel-b',
    });

    const verdict = await service.verify({
      ...target,
      payoutChannel: 'channel-a',
    });

    // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.get).toHaveBeenCalledWith('channel-a');
    expect(providerA.queryPayout).toHaveBeenCalled();
    expect(providerB.queryPayout).not.toHaveBeenCalled();
    // ⚠️ **结论来自 A**（A 说 FAILED），不是 B 的 SUCCESS
    expect(verdict.verdict).toBe('FAILED');
  });

  it('payoutChannel 为空 → 用平台默认渠道（存量单的前向兼容）', async () => {
    const provider = fakeProvider({
      channel: 'channel-b',
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'FAILED', definitive: true }),
      ),
    });
    const { service, settings } = makeService({
      providers: [provider],
      defaultChannel: 'channel-b',
    });

    const verdict = await service.verify(target);

    expect(settings.getPayoutDefaultChannel).toHaveBeenCalled();
    expect(verdict.verdict).toBe('FAILED');
  });

  it('⚠️ 平台默认渠道也没配（取不到渠道）→ 返回 null 走下一层，不抛', async () => {
    // ⚠️ **不抛** —— 抛出去会把「问不出结论」变成 500，
    //    而正确处置是 fail-closed（第 2/3 层）。
    const { service, settings } = makeService();
    settings.getPayoutDefaultChannel.mockRejectedValue(
      new ConflictException('平台未配置默认出款渠道'),
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️⚠️ F 类对账项（STATUS_MISMATCH）→ 不得据此产出 FAILED', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          // ⚠️ **F 类的语义是「渠道说 FAILED 但本地记 PAID」** ——
          //    说明渠道与本地记录**互相矛盾**，不能据此断定「这笔钱没打出去」
          type: ReconciliationDiffType.STATUS_MISMATCH,
          channelStatus: 'FAILED',
          channelTxnId: 'txn-3',
          channelAmount: 8500,
          channelPaidAt: null,
        },
      ]),
    );
    const { service } = makeService({ providers: [provider], findMany });

    const verdict = await service.verify(target);

    // ⚠️ **绝不能是 FAILED** —— 采信 F 类 → 一张本地误记为已付的单
    //    被当成「渠道明确拒付」→ 放行解卡 → 重复打款
    expect(verdict.verdict).not.toBe('FAILED');
    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ E 类对账项（channelStatus 为 null）→ UNKNOWN', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          type: ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
          // ⚠️ **E 类的 channelStatus 恒为 null** —— 「渠道查不到」≠「渠道说没打」
          channelStatus: null,
          channelTxnId: null,
          channelAmount: 8500,
          channelPaidAt: null,
        },
      ]),
    );
    const { service } = makeService({ providers: [provider], findMany });

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 查对账结果时按 type 白名单过滤（不得靠引擎口径兜底）', async () => {
    const findMany = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_args: FindManyArgs) => Promise.resolve([] as unknown[]),
    );
    const { service } = makeService({ findMany });

    await service.verify(target);

    // ⚠️ **白名单必须是显式的** —— 只靠「引擎不会给 PROCESSING 的单产 F 类」
    //    这条跨 Task 的隐式耦合，引擎一改口径就会静默放行
    const args = findMany.mock.calls[0][0];
    expect(args.where.type.in).toEqual([
      ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
      ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
      ReconciliationDiffType.AMOUNT_MISMATCH,
    ]);
    // ⚠️ **白名单里绝不能有 F 类** —— 它是唯一会带出 channelStatus='FAILED' 的类型
    expect(args.where.type.in).not.toContain(
      ReconciliationDiffType.STATUS_MISMATCH,
    );
  });

  it('⚠️ 查对账结果时有二级排序键（同一毫秒内写入的两行顺序要确定）', async () => {
    const findMany = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_args: FindManyArgs) => Promise.resolve([] as unknown[]),
    );
    const { service } = makeService({ findMany });

    await service.verify(target);

    // ⚠️ **只按 createdAt 排** → 同一毫秒内写入的两行 item 顺序不确定
    //    → 「最近一次对账结果」会随机命中其中一行 → 结论不稳定
    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
