import { ConflictException, Logger } from '@nestjs/common';
import {
  PAYOUT_MAX_ATTEMPTS,
  PayoutWorker,
  payoutRetryDelayMs,
} from './payout.worker';
import type { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';

/**
 * 出款 worker 的单元测试。
 *
 * ⚠️ **重点验三件事**：
 * ① 抢不到单 → **什么都不做**（不重试、不落 FAILED）
 * ② 渠道失败 → 退回 `APPROVED` 并**延迟重新入队**（不是靠 BullMQ 重试）
 * ③ 扫描 → `PROCESSING` 绝不重试，只有 `APPROVED` 被重新入队
 *
 * ⚠️ **阶段 6a 起按 `claim.channel` 路由** —— 注册表由 `fakeRegistry` 模拟，
 *    它按渠道名精确取实现（不再取「第一个」）。
 */

/**
 * 一只假的渠道。
 *
 * ⚠️ **`submit` 声明成「属性」而不是接口里的「方法」** ——
 *    eslint 的 `unbound-method` 规则不允许把对象方法单独取出来断言
 *    （`expect(provider.submit)`），断言要用属性形态的 mock。
 */
interface FakeProvider {
  calls: unknown[];
  channel: string;
  provider: string;
  capabilities: {
    refund: boolean;
    asyncRefund: boolean;
    asyncPayout: boolean;
    queryByReferenceNo: boolean;
    authorizedCharge: boolean;
    paymentMethod: boolean;
  };
  submit: jest.Mock;
  queryPayout: jest.Mock;
  listPayouts: jest.Mock;
}

function fakeProvider(result: {
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING';
  amount?: number;
  /** ⚠️ **只有 `FAILED` 有意义** —— 缺省按「结果未知」处理（保守方向） */
  definitive?: boolean;
  failureReason?: string;
  throws?: Error;
}): FakeProvider {
  const calls: unknown[] = [];
  return {
    calls,
    channel: 'fake-payout',
    provider: 'fake-payout',
    // 假渠道是同步出款，能力按「不支持异步」声明。
    capabilities: {
      refund: false,
      asyncRefund: false,
      asyncPayout: false,
      queryByReferenceNo: true,
      authorizedCharge: false,
      paymentMethod: false,
    },
    submit: jest.fn((input: unknown) => {
      calls.push(input);
      if (result.throws) {
        return Promise.reject(result.throws);
      }
      const base = {
        providerTxnId: 'txn-1',
        status: result.status,
        amount: result.amount ?? 8500,
        failureReason: result.failureReason,
      };
      if (result.status === 'FAILED') {
        return Promise.resolve({
          ...base,
          // ⚠️ **缺省 = 结果未知** —— 不能默认「可重试」
          definitive: result.definitive ?? false,
        });
      }
      return Promise.resolve(base);
    }),
    queryPayout: jest.fn(() => Promise.resolve({ status: 'SUCCESS' })),
    // ⚠️ **新增**（阶段 5m）：批量查单。默认返回空数组。
    listPayouts: jest.fn(() => Promise.resolve([])),
  };
}

/**
 * 假的出款渠道注册表（阶段 6a）。
 *
 * ⚠️ **按渠道名精确取实现** —— 与真实 `PayoutProviderRegistry.get` 同口径：
 *    未注册 / 未启用都抛中文 409。测试里「未启用」用 `disabled` 集合模拟。
 */
function fakeRegistry(
  provider?: FakeProvider,
  options: { disabled?: string[] } = {},
) {
  const byChannel = new Map<string, FakeProvider>();
  if (provider) {
    byChannel.set(provider.channel, provider);
  }
  const disabled = new Set(options.disabled ?? []);
  return {
    get: jest.fn((channel: string) => {
      const found = byChannel.get(channel);
      if (!found) {
        throw new ConflictException(`出款渠道 ${channel} 未注册`);
      }
      if (disabled.has(channel)) {
        throw new ConflictException(`出款渠道 ${channel} 未启用`);
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

/** 假的 execution service */
function fakeExecution(claim: unknown) {
  return {
    claimForExecution: jest.fn(() => Promise.resolve(claim)),
    markPaid: jest.fn(() => Promise.resolve(true)),
    markFailed: jest.fn(() => Promise.resolve(true)),
    // ⚠️ **记渠道名**（阶段 5m 技术债）—— worker 只调它，不自己写库。
    //    用例要断言「worker 确实调了它，且失败不阻断打款」。
    recordChannel: jest.fn<Promise<void>, [string, string]>(() =>
      Promise.resolve(),
    ),
    // ⚠️ **默认返回「本次」的 attemptCount = 1** —— 与真实实现一致
    //    （`scheduleRetry` 退回 `APPROVED` 时读回的是**当前**的计数）。
    //    ⚠️ **类型带 `| null`** —— 真实实现读不到行时返回 `null`（不重试）。
    scheduleRetry: jest.fn<Promise<number | null>, []>(() =>
      Promise.resolve(1),
    ),
    markStuckLogged: jest.fn(() => Promise.resolve(0)),
    scanStuck: jest.fn<
      Promise<Array<{ id: string; attemptCount: number }>>,
      []
    >(() => Promise.resolve([])),
  };
}

/** 假的队列服务 */
function fakeQueues() {
  return {
    addWithOptions: jest.fn(() => Promise.resolve()),
  };
}

/** 假的 Prisma（只需要 databaseNow） */
function fakePrisma() {
  return {
    databaseNow: jest.fn(() =>
      Promise.resolve(new Date('2025-08-20T00:00:00.000Z')),
    ),
  };
}

const claim = {
  attemptCount: 1,
  netAmount: 8500,
  payoutNo: 'PAY1',
  // ⚠️ **阶段 6a：抢单时就解析好了渠道** —— worker 只按它取实现
  channel: 'fake-payout' as string | null,
  channelError: null as string | null,
  account: {
    accountName: '张三',
    bankName: '测试银行',
    accountNo: '6222000000000000',
  },
};

describe('PayoutWorker', () => {
  it('抢不到单 → 什么都不做（不调渠道、不落状态）', async () => {
    const execution = fakeExecution(null);
    const provider = fakeProvider({ status: 'SUCCESS' });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.submit).not.toHaveBeenCalled();
    expect(execution.markPaid).not.toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('渠道成功 → markPaid，金额与请求一致', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 8500 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markPaid).toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
  });

  it('⚠️ payoutChannel 写的是「实际调用的那个渠道」', async () => {
    // ⚠️ **渠道必须一路带下来** —— `settle` 里自己再取一次的话，
    //    将来注册第二家渠道后两次取可能取到不同的渠道 → 渠道名写错。
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 8500 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markPaid.mock.calls[0] as unknown as [
      string,
      { channel: string },
    ];
    expect(call[1].channel).toBe('fake-payout');
  });

  it('⚠️ 调渠道前就调 execution.recordChannel 记下渠道名', async () => {
    // ⚠️ **必须在调渠道之前落** —— 原来只有 `markPaid` 才写 →
    //    卡在 `PROCESSING` 的单渠道名是 null → 将来「按渠道取 provider」定位不到。
    //
    // ⚠️ **worker 不自己写库** —— 写库的落点统一在
    //    `PayoutExecutionService.recordChannel`（worker 只调它）。
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 8500 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    // ⚠️ **记的是「实际调用的那个渠道」**
    expect(execution.recordChannel).toHaveBeenCalledWith(
      'payout-a',
      'fake-payout',
    );
    // ⚠️ **顺序也要咬住** —— 记渠道名必须发生在**调渠道之前**：
    //    渠道调完之后再写就晚了（那时 `PROCESSING` 的单仍然没有渠道名）。
    //    用 `mock.invocationCallOrder`（全局递增的调用序号）比较先后。
    const recordOrder = execution.recordChannel.mock.invocationCallOrder[0];
    const executeOrder = provider.submit.mock.invocationCallOrder[0];
    expect(recordOrder).toBeLessThan(executeOrder);
  });

  it('⚠️ 记渠道名失败 → 照样打款（辅助动作不能拖垮主流程）', async () => {
    // ⚠️ **DB 抖动时放弃打款 = 钱永远打不出去** ——
    //    单子卡在 `PROCESSING`，兜底扫描只告警、绝不重试，商家永远收不到钱。
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      const execution = fakeExecution(claim);
      const provider = fakeProvider({ status: 'SUCCESS', amount: 8500 });
      execution.recordChannel.mockRejectedValue(new Error('数据库抖动'));
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        fakeQueues() as unknown as never,
        fakeRegistry(provider),
      );

      await worker.process({
        name: 'execute',
        data: { payoutId: 'payout-a' },
      } as never);

      // ⚠️ **钱必须打出去**
      expect(provider.submit).toHaveBeenCalled();
      expect(execution.markPaid).toHaveBeenCalled();
      // ⚠️ **失败原因要进日志** —— 否则「渠道名没记上」这件事完全不可见
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('数据库抖动'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('⚠️ 渠道金额核对不通过 → markFailed（护栏 X3），且不自动重试', async () => {
    // ⚠️ **钱可能已按错误金额打出** —— 不能重试（设计 §6.2）。
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 9999 });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markFailed).toHaveBeenCalled();
    expect(execution.markPaid).not.toHaveBeenCalled();
    // ⚠️ **金额核对失败不进重试预算、不投重试 job**
    expect(execution.scheduleRetry).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('⚠️ 金额 ≤ 0 → 落 FAILED，不调渠道（护栏 X4）', async () => {
    const execution = fakeExecution({ ...claim, netAmount: 0 });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.submit).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();
  });

  it('⚠️ 解密失败（accountError）→ 落 FAILED，不调渠道，理由是业务口径', async () => {
    // ⚠️ **必须断言「根因进了日志」** —— 否则这个分支与 `checkGates`
    //    的「账户缺失」闸**无法区分**：两条路径写的 `failureReason`
    //    **完全相同**（设计 §二·2.3·②b 有意为之 —— 它们对商家是同一件事），
    //    分支唯一的独有行为就是「把根因写进日志」。
    //    没有这条断言，把整个分支删掉测试照样绿（失败注入 G2 实测过）。
    const logSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      const execution = fakeExecution({
        ...claim,
        account: null,
        accountError:
          '出款单的收款账号快照 尚未加密（版本 0），请先执行 `npm run migrate:payout-encryption` 再重试。',
      });
      const provider = fakeProvider({ status: 'SUCCESS' });
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        fakeQueues() as unknown as never,
        fakeRegistry(provider),
      );

      await worker.process({
        name: 'execute',
        data: { payoutId: 'payout-a' },
      } as never);

      // ⚠️ **钱绝不能打出去** —— 解密失败发生在调渠道之前
      expect(provider.submit).not.toHaveBeenCalled();
      expect(execution.markPaid).not.toHaveBeenCalled();
      expect(execution.markFailed).toHaveBeenCalled();

      const call = execution.markFailed.mock.calls[0] as unknown as [
        string,
        { reason: string },
      ];
      const reason = call[1].reason;
      // ⚠️ **界面文案必须是业务口径** —— 商家看到「密钥不匹配」会以为
      //    自己的银行账号被篡改了
      expect(reason).not.toContain('尚未加密');
      expect(reason).not.toContain('密钥不匹配');
      expect(reason).not.toContain('migrate:payout-encryption');
      // ⚠️ **文案要自证「没打钱」** —— 商家端对所有 FAILED 都会接一句
      //    「请联系平台确认出款情况」，不说清楚商家会以为钱可能已经打出去
      expect(reason).toContain('本次未打款');

      // ⚠️⚠️ **根因必须进日志** —— 这是「解密失败」与「快照为空」两条路径
      //    **唯一**的可观察差异。运营靠它区分「是没迁移」「是密钥错了」
      //    「是版本不匹配」—— 三者的处置方式完全不同。
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('收款账号快照不可用'),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('尚未加密'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('⚠️ 账户快照缺失 → 落 FAILED，不调渠道，理由是业务口径', async () => {
    // ⚠️ **这条路径与「解密失败」对商家是同一件事**（账户不可用 → 没打钱
    //    → 更新账户后重新申请），差异只在根因（日志里）。
    //    所以 `failureReason` **完全相同**是有意的。
    const execution = fakeExecution({ ...claim, account: null });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.submit).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { reason: string },
    ];
    // ⚠️ **不能是「收款账户快照缺失」** —— 商家会问「什么叫快照缺失」
    expect(call[1].reason).not.toContain('快照缺失');
    expect(call[1].reason).toContain('本次未打款');
  });

  it('⚠️ 打款前的失败 → 标记「确定没打」（可安全重试）', async () => {
    const execution = fakeExecution({
      ...claim,
      account: null,
      accountError: '出款单的收款账号快照 尚未加密（版本 0）',
    });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean },
    ];
    // ⚠️ **渠道从未被调用 → 钱确定没打出去** → 可安全重试
    expect(call[1].failedBeforePayout).toBe(true);
  });

  it('⚠️ 打款前的闸没过（金额异常）→ 标记「确定没打」（可安全重试）', async () => {
    const execution = fakeExecution({
      ...claim,
      netAmount: 0,
    });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean; reason: string },
    ];
    // ⚠️ **渠道从未被调用 → 钱确定没打出去** → 可安全重试
    expect(call[1].failedBeforePayout).toBe(true);
    // ⚠️ **顺带确认走的是「打款前的闸」这条路径**（不是别的分支）
    expect(call[1].reason).toContain('本次未打款');
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('⚠️ 打款前的闸没过（收款账户缺失）→ 标记「确定没打」（可安全重试）', async () => {
    // ⚠️ **没有 `accountError`** → 走的是 `checkGates` 的账户缺失闸，
    //    不是 5k 的解密失败分支（那条已有单独的用例）
    const execution = fakeExecution({
      ...claim,
      account: null,
    });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean; reason: string },
    ];
    expect(call[1].failedBeforePayout).toBe(true);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('⚠️ 注册两家渠道，payoutChannel=A → 只调 A，不调 B', async () => {
    // ⚠️ **这是「取第一个」的回归测试** —— 注册顺序 B 在前，
    //    若 worker 还取「第一个」，就会打到 B。
    const execution = fakeExecution({ ...claim, channel: 'channel-a' });
    const providerA = fakeProvider({ status: 'SUCCESS', amount: 8500 });
    providerA.channel = 'channel-a';
    const providerB = fakeProvider({ status: 'SUCCESS', amount: 8500 });
    providerB.channel = 'channel-b';
    const registry = fakeRegistry(providerB);
    (registry.get as jest.Mock).mockImplementation((channel: string) =>
      channel === 'channel-a' ? providerA : providerB,
    );
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      registry,
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.get).toHaveBeenCalledWith('channel-a');
    expect(providerA.submit).toHaveBeenCalled();
    expect(providerB.submit).not.toHaveBeenCalled();
    // ⚠️ **记录的渠道名是实际调用的那家**
    expect(execution.recordChannel).toHaveBeenCalledWith(
      'payout-a',
      'channel-a',
    );
    const call = execution.markPaid.mock.calls[0] as unknown as [
      string,
      { channel: string },
    ];
    expect(call[1].channel).toBe('channel-a');
  });

  it('⚠️ channelError → 落 FAILED（确定没打、可重试），记 warn，不调渠道', async () => {
    // ⚠️ **不能靠抛异常** —— 事务回滚后单子仍是 `APPROVED`，而 `markFailed`
    //    只接受 `PROCESSING` → 单子会永远卡在 `APPROVED`，兜底扫描每 5 分钟重投一次。
    //    → 抢单成功（已进 PROCESSING），由这里落 FAILED。
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const execution = fakeExecution({
        ...claim,
        channel: null,
        channelError:
          '出款渠道 disabled-a 未启用：请检查 PAYOUT_ENABLED_CHANNELS。',
      });
      const provider = fakeProvider({ status: 'SUCCESS' });
      const registry = fakeRegistry(provider);
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        fakeQueues() as unknown as never,
        registry,
      );

      await worker.process({
        name: 'execute',
        data: { payoutId: 'payout-a' },
      } as never);

      expect(provider.submit).not.toHaveBeenCalled();
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.get).not.toHaveBeenCalled();
      expect(execution.markPaid).not.toHaveBeenCalled();
      // ⚠️ **必须落 FAILED** —— 否则就是「卡在 APPROVED 被无限重投」
      expect(execution.markFailed).toHaveBeenCalledTimes(1);
      const call = execution.markFailed.mock.calls[0] as unknown as [
        string,
        { failedBeforePayout?: boolean; reason: string },
      ];
      // ⚠️ **渠道从未被调用** → 钱确定没打出去 → 可安全重试
      expect(call[1].failedBeforePayout).toBe(true);
      // ⚠️ **原因可读**（中文、带渠道名）
      expect(call[1].reason).toContain('disabled-a');
      // ⚠️ **根因进日志** —— 运营靠它知道改哪个配置项
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PAYOUT_ENABLED_CHANNELS'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('⚠️ channelError 先于 checkGates 处理（不会把原因盖成「账户缺失」）', async () => {
    const execution = fakeExecution({
      ...claim,
      channel: null,
      channelError: '出款渠道 x 未注册',
      account: null,
    });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { reason: string },
    ];
    expect(call[1].reason).toBe('出款渠道 x 未注册');
  });

  it('⚠️ claim.channel 为空（无 channelError）→ warn + 落 FAILED，不调渠道', async () => {
    // ⚠️ **正常路径不该走到这里**（`channelError` 会先拦住）——
    //    只有代码 bug 才会出现「抢到单却既没渠道也没错误」。
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const execution = fakeExecution({ ...claim, channel: null });
      const provider = fakeProvider({ status: 'SUCCESS' });
      const registry = fakeRegistry(provider);
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        fakeQueues() as unknown as never,
        registry,
      );

      await worker.process({
        name: 'execute',
        data: { payoutId: 'payout-a' },
      } as never);

      expect(provider.submit).not.toHaveBeenCalled();
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.get).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('没有可用的出款渠道'),
      );
      const call = execution.markFailed.mock.calls[0] as unknown as [
        string,
        { failedBeforePayout?: boolean; reason: string },
      ];
      expect(call[1].failedBeforePayout).toBe(true);
      expect(call[1].reason).toContain('没有可用的出款渠道');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('⚠️ 渠道未注册/已停用（registry.get 抛 409）→ 落 FAILED（确定没打、可重试）', async () => {
    // ⚠️ **落到 PROCESSING 的单被停用了渠道**（运营在审批后改了配置）——
    //    不能抛出去，否则单子停在 PROCESSING、钱没打、也没人重试。
    const execution = fakeExecution({ ...claim, channel: 'channel-a' });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const registry = fakeRegistry(provider, { disabled: ['channel-a'] });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      registry,
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.submit).not.toHaveBeenCalled();
    expect(execution.recordChannel).not.toHaveBeenCalled();
    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean; reason: string },
    ];
    expect(call[1].failedBeforePayout).toBe(true);
    expect(call[1].reason).toContain('channel-a');
  });

  it('⚠️ 渠道金额核对不通过 → 标记「可能已打」（不可重试）', async () => {
    const execution = fakeExecution(claim);
    // ⚠️ **渠道返回的金额与请求的不一致** → X3 拦截 → 落 FAILED
    const provider = fakeProvider({ status: 'SUCCESS', amount: 8501 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean; reason: string },
    ];
    // ⚠️ **渠道调过了（可能已打出去）→ 不能重试**
    expect(call[1].failedBeforePayout).toBe(false);
    expect(call[1].reason).toContain('金额核对不通过');
    // ⚠️ **这条最关键**：渠道确实被调用过 —— 若这里被改成 `true`，
    //    平台端的「重试」按钮就会出现在一张**可能已经打出去**的单上
    expect(provider.submit).toHaveBeenCalled();
  });

  it('渠道失败且未超上限 → 退回 APPROVED 并延迟重新入队', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      // ⚠️ **确定的失败** —— 渠道明确说没打 → 可以进重试预算
      definitive: true,
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.scheduleRetry).toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
    // ⚠️ **重新入队必须带 jobId 与 attempts: 1**
    const [queueName, jobName, data, jobId, opts] = queues.addWithOptions.mock
      .calls[0] as unknown as [
      string,
      string,
      { payoutId: string },
      string,
      { attempts: number; delay: number; removeOnComplete?: boolean },
    ];
    expect(queueName).toBe('payout');
    expect(jobName).toBe('execute');
    expect(data.payoutId).toBe('payout-a');
    // ⚠️⚠️ **jobId 必须是「下一次」的轮次**（本次 attemptCount = 1 → 下一轮 2）
    //    首次入队用的是 `payout-{id}-1` —— 用同一个 jobId 重新入队会被
    //    BullMQ **静默忽略** → 重试从未发生、单子永远停在 `APPROVED`。
    expect(jobId).toBe('payout-payout-a-2');
    expect(jobId).not.toBe('payout-payout-a-1');
    // ⚠️ **attempts 必须是 1** —— BullMQ 自己的重试要关掉
    expect(opts.attempts).toBe(1);
    expect(opts.delay).toBeGreaterThan(0);
    // ⚠️ **removeOnComplete** —— 完成的 job 留在 completed 集合里，
    //    同一个 jobId 就永远不能再用
    expect(opts.removeOnComplete).toBe(true);
  });

  it('⚠️ 第二次失败 → jobId 用第 3 轮，退避仍是「本次」的 2 倍', async () => {
    // ⚠️ **退避时长用「本次」次数、jobId 用「下一次」轮次** —— 两者不能混。
    const original = process.env.PAYOUT_RETRY_BASE_DELAY_MS;
    process.env.PAYOUT_RETRY_BASE_DELAY_MS = '1000';
    try {
      const execution = fakeExecution({ ...claim, attemptCount: 2 });
      // ⚠️ **`scheduleRetry` 返回「本次」的计数** = 2
      execution.scheduleRetry = jest.fn(() => Promise.resolve(2));
      const provider = fakeProvider({
        status: 'FAILED',
        // ⚠️ **确定的失败** —— 渠道明确说没打 → 可以进重试预算
        definitive: true,
        failureReason: '渠道超时',
      });
      const queues = fakeQueues();
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        queues as unknown as never,
        fakeRegistry(provider),
      );

      await worker.process({
        name: 'execute',
        data: { payoutId: 'payout-a' },
      } as never);

      const [, , , jobId, opts] = queues.addWithOptions.mock
        .calls[0] as unknown as [
        string,
        string,
        { payoutId: string },
        string,
        { delay: number },
      ];
      // ⚠️ **下一轮是第 3 次**
      expect(jobId).toBe('payout-payout-a-3');
      // ⚠️ **退避用「本次」的次数**（2×基数 = 2000ms），不是下一轮的 3 倍
      expect(opts.delay).toBe(2000);
    } finally {
      if (original === undefined) {
        delete process.env.PAYOUT_RETRY_BASE_DELAY_MS;
      } else {
        process.env.PAYOUT_RETRY_BASE_DELAY_MS = original;
      }
    }
  });

  it('scheduleRetry 返回 null（读不到行）→ 不重新入队', async () => {
    const execution = fakeExecution(claim);
    execution.scheduleRetry = jest.fn(() => Promise.resolve(null));
    const provider = fakeProvider({
      status: 'FAILED',
      // ⚠️ **确定的失败** —— 渠道明确说没打 → 可以进重试预算
      definitive: true,
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    // ⚠️ **读不到行就不重试** —— 返回 0 会让调用方算出 delay = 0
    //    并入队 `payout-{id}-0` → 立即重投、抢跑重试预算
    expect(queues.addWithOptions).not.toHaveBeenCalled();
    expect(execution.markFailed).not.toHaveBeenCalled();
  });

  it('渠道失败且达到上限 → 落 FAILED，不重新入队（护栏 X7）', async () => {
    const execution = fakeExecution({
      ...claim,
      attemptCount: PAYOUT_MAX_ATTEMPTS,
    });
    const provider = fakeProvider({
      status: 'FAILED',
      // ⚠️ **确定的失败** —— 渠道明确说没打 → 可以进重试预算
      definitive: true,
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markFailed).toHaveBeenCalled();
    expect(execution.scheduleRetry).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('⚠️ 渠道失败试满上限（definitive=true）→ 标记「确定没打」（可人工重试）', async () => {
    // ⚠️ **`definitive=true` 表示渠道明确说没打** —— 钱确定没出去
    //    → `failedBeforePayout=true`，平台端的「重试」按钮才会出现
    //    （设计 §6.2；阶段 6b 之前这里写的是 false）。
    const execution = fakeExecution({
      ...claim,
      attemptCount: PAYOUT_MAX_ATTEMPTS,
    });
    const provider = fakeProvider({
      status: 'FAILED',
      // ⚠️ **确定的失败** —— 渠道明确说没打 → 可以进重试预算
      definitive: true,
      failureReason: '渠道超时',
    });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean },
    ];
    expect(call[1].failedBeforePayout).toBe(true);
  });

  it('⚠️ 渠道抛异常（超时 / 网络）→ 按结果未知落 FAILED，不自动重试', async () => {
    // ⚠️ **抛异常 = 结果未知**（阶段 6b）—— 钱可能已经打出去。
    //    以前这里走 `scheduleRetry`，那会把一张可能已付款的单重投 → 重复打款。
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      throws: new Error('网络不通'),
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.scheduleRetry).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalledTimes(1);
    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean; reason: string },
    ];
    // ⚠️ **可能已打出去 → 不可重试**
    expect(call[1].failedBeforePayout).toBe(false);
    expect(call[1].reason).toContain('网络不通');
  });

  it('⚠️ FAILED + definitive=false → 落 FAILED，不自动重试（不可重试）', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      definitive: false,
      failureReason: '渠道超时，结果未知',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    // ⚠️ **不进重试预算、不重新入队**
    expect(execution.scheduleRetry).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalledTimes(1);
    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean; reason: string; providerTxnId?: string },
    ];
    expect(call[1].failedBeforePayout).toBe(false);
    expect(call[1].reason).toContain('结果未知');
    // ⚠️ **交易号要带下来** —— 人工核对 / 实时核实靠它
    expect(call[1].providerTxnId).toBe('txn-1');
  });

  it('⚠️ FAILED + definitive=true → 仍走现有重试预算（可安全重试）', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      definitive: true,
      failureReason: '渠道明确拒付',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    // ⚠️ **未超预算 → 退回 APPROVED 并投重试 job**（不是直接落 FAILED）
    expect(execution.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(execution.markFailed).not.toHaveBeenCalled();
    expect(queues.addWithOptions).toHaveBeenCalledTimes(1);
    const [, , data, jobId] = queues.addWithOptions.mock
      .calls[0] as unknown as [string, string, { payoutId: string }, string];
    expect(data.payoutId).toBe('payout-a');
    expect(jobId).toBe('payout-payout-a-2');
  });

  it('⚠️ FAILED + definitive=true → 有重试 job（未超预算时）', async () => {
    // ⚠️ **「确定失败」才允许进重试预算** —— 与 definitive=false 的对照组
    //    （那条断言 `queues.addWithOptions` 未被调用）。
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      definitive: true,
      failureReason: '渠道明确拒付',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(provider),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(queues.addWithOptions).toHaveBeenCalledTimes(1);
    expect(execution.markFailed).not.toHaveBeenCalled();
  });

  it('⚠️ PROCESSING → 保持 PROCESSING，不落 FAILED、不自动重试', async () => {
    // ⚠️ **`PROCESSING` 绝不能再当成失败**（设计 §6.2）——
    //    钱可能已打出去，落 FAILED 会把一张可能成功的单推进人工核对的坑；
    //    投重试 job 则会确定性地重复打款。
    //    → 状态保持 `PROCESSING`，交给 `scanStuck` 轮询。
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    try {
      const execution = fakeExecution(claim);
      const provider = fakeProvider({ status: 'PROCESSING' });
      const queues = fakeQueues();
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        queues as unknown as never,
        fakeRegistry(provider),
      );

      await worker.process({
        name: 'execute',
        data: { payoutId: 'payout-a' },
      } as never);

      // ⚠️ **状态机一个动作都不能有** —— 不落终态、不退回、不重新入队
      expect(execution.markPaid).not.toHaveBeenCalled();
      expect(execution.markFailed).not.toHaveBeenCalled();
      expect(execution.scheduleRetry).not.toHaveBeenCalled();
      expect(queues.addWithOptions).not.toHaveBeenCalled();
      // ⚠️ **记一条日志说明「交给 scanStuck 轮询」** —— 否则运营看到
      //    一张单停在 PROCESSING 无从判断是渠道慢还是 worker 漏了
      const logged = [
        ...warnSpy.mock.calls.map((c) => String(c[0])),
        ...logSpy.mock.calls.map((c) => String(c[0])),
      ].join('\n');
      expect(logged).toContain('PROCESSING');
      expect(logged).toContain('scanStuck');
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('未知 job name → 什么都不做', async () => {
    const execution = fakeExecution(claim);
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(),
    );

    await worker.process({ name: 'whatever', data: {} } as never);

    expect(execution.claimForExecution).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });
});

describe('PayoutWorker 的 scan', () => {
  it('APPROVED 卡死 → 重新入队，jobId 稳定（带 attempt 轮次）', async () => {
    const execution = fakeExecution(null);
    execution.scanStuck = jest.fn(() =>
      Promise.resolve([{ id: 'payout-b', attemptCount: 2 }]),
    );
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(),
    );

    await worker.process({ name: 'scan', data: {} } as never);

    expect(queues.addWithOptions).toHaveBeenCalledTimes(1);
    const [queueName, jobName, data, jobId, opts] = queues.addWithOptions.mock
      .calls[0] as unknown as [
      string,
      string,
      { payoutId: string },
      string,
      { attempts: number; removeOnComplete?: boolean },
    ];
    expect(queueName).toBe('payout');
    expect(jobName).toBe('execute');
    expect(data.payoutId).toBe('payout-b');
    // ⚠️ **jobId 必须稳定** —— 用 attemptCount 而不是时间戳
    expect(jobId).toBe('payout-payout-b-rescue-2');
    expect(opts.attempts).toBe(1);
    // ⚠️ **removeOnComplete** —— 同 jobId 的 job 完成后必须删掉，
    //    否则下一轮救援用同一个 jobId 会被静默忽略
    expect(opts.removeOnComplete).toBe(true);
  });

  it('⚠️ 没有可救援的单 → 不入队', async () => {
    const execution = fakeExecution(null);
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(),
    );

    await worker.process({ name: 'scan', data: {} } as never);

    expect(execution.scanStuck).toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('⚠️ PROCESSING 卡死绝不入队（由 scanStuck 保证，worker 只信它的返回）', async () => {
    // ⚠️ **worker 完全信任 `scanStuck` 的返回值** ——
    //    「`PROCESSING` 只告警不重试」的保证在 `scanStuck` 内部（那里只
    //    写 `stuckLoggedAt`，返回的只有 `APPROVED` 的单）。
    const execution = fakeExecution(null);
    execution.scanStuck = jest.fn(() => Promise.resolve([]));
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      fakeRegistry(),
    );

    await worker.process({ name: 'scan', data: {} } as never);

    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });
});

describe('对账任务消费端（阶段 6 审查修复）', () => {
  /** 假的对账服务 */
  function fakeReconciliation() {
    return {
      executeReconciliation: jest.fn(() =>
        Promise.resolve({
          id: 'rec-1',
          status: 'COMPLETED',
          diffCount: 0,
          matchedCount: 0,
        }),
      ),
      runScheduled: jest.fn(() => Promise.resolve()),
    };
  }

  it("'reconcile-run' job → 调 executeReconciliation（带任务 id 与渠道）", async () => {
    const reconciliation = fakeReconciliation();
    const worker = new PayoutWorker(
      fakeExecution(claim) as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(),
      reconciliation as unknown as never,
    );

    await worker.process({
      name: 'reconcile-run',
      data: { reconciliationId: 'rec-1', channel: 'fake-payout' },
    } as never);

    expect(reconciliation.executeReconciliation).toHaveBeenCalledWith({
      reconciliationId: 'rec-1',
      channel: 'fake-payout',
    });
  });

  it("'reconcile-run' job 缺参数 → 记 error 且不执行（不静默跳过）", async () => {
    const reconciliation = fakeReconciliation();
    const worker = new PayoutWorker(
      fakeExecution(claim) as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(),
      reconciliation as unknown as never,
    );

    await worker.process({
      name: 'reconcile-run',
      data: { channel: 'fake-payout' },
    } as never);

    // ⚠️ **缺任务 id 就是代码 bug** —— 静默跳过会让这笔对账永远停在 RUNNING
    expect(reconciliation.executeReconciliation).not.toHaveBeenCalled();
  });

  it('对账执行失败 → 记 error 但不抛出（不让 BullMQ 把它记成失败 job）', async () => {
    const reconciliation = fakeReconciliation();
    reconciliation.executeReconciliation.mockRejectedValue(
      new Error('渠道超时'),
    );
    const worker = new PayoutWorker(
      fakeExecution(claim) as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(),
      reconciliation as unknown as never,
    );

    await expect(
      worker.process({
        name: 'reconcile-run',
        data: { reconciliationId: 'rec-1', channel: 'fake-payout' },
      } as never),
    ).resolves.toBeUndefined();
  });
});

describe('payoutRetryDelayMs', () => {
  it('退避 = 基数 × 尝试次数（线性，不指数）', () => {
    const original = process.env.PAYOUT_RETRY_BASE_DELAY_MS;
    process.env.PAYOUT_RETRY_BASE_DELAY_MS = '1000';
    try {
      expect(payoutRetryDelayMs(1)).toBe(1000);
      expect(payoutRetryDelayMs(2)).toBe(2000);
      expect(payoutRetryDelayMs(3)).toBe(3000);
    } finally {
      if (original === undefined) {
        delete process.env.PAYOUT_RETRY_BASE_DELAY_MS;
      } else {
        process.env.PAYOUT_RETRY_BASE_DELAY_MS = original;
      }
    }
  });

  it('默认基数 30 秒', () => {
    const original = process.env.PAYOUT_RETRY_BASE_DELAY_MS;
    delete process.env.PAYOUT_RETRY_BASE_DELAY_MS;
    try {
      expect(payoutRetryDelayMs(1)).toBe(30000);
      expect(payoutRetryDelayMs(3)).toBe(90000);
    } finally {
      if (original !== undefined) {
        process.env.PAYOUT_RETRY_BASE_DELAY_MS = original;
      }
    }
  });
});

/**
 * 定时对账的分布式互斥（阶段 11）+ 抢不到锁时的行为。
 *
 * ⚠️ **这是设计取舍的显式记录，不是「测一个 bug 已被修复」**：
 *    `RedisLockService` 的语义是「抢不到 = 跳过本轮，不等待不重试」，
 *    对媒体清理这类旁路任务没有损失；但**定时对账是每天 24 小时一次、
 *    窗口按「昨天」算** —— 跳过的那一轮，那一天的对账就永久缺失了
 *    （下一轮的窗口已经是新的一天）。
 *
 *    下面的用例把「抢不到锁 → 直接返回、不触发对账」这个现状钉住：
 *    如果哪天改成「抢不到就退避重试」，这里会变红，提醒重新审视语义。
 */
describe('定时对账：抢不到分布式锁时的行为', () => {
  /** 只记录调用的假对账服务 */
  function fakeReconciliation() {
    return { runScheduled: jest.fn(() => Promise.resolve()) };
  }

  it('⚠️ 锁被别的副本持有 → 跳过本轮，不跑对账（当天窗口因此缺失）', async () => {
    const reconciliation = fakeReconciliation();
    const lock = {
      withLock: jest.fn(() => Promise.resolve({ acquired: false } as const)),
    };
    const worker = new PayoutWorker(
      fakeExecution(claim) as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(fakeProvider({ status: 'SUCCESS' })),
      reconciliation as unknown as never,
      lock as unknown as never,
    );

    await worker.process({
      name: 'reconcile',
      data: { channel: 'fake-payout' },
    } as never);

    // ⚠️ 现状：抢不到就什么都不做。BullMQ 视本轮为「成功」→ 不会重投。
    expect(reconciliation.runScheduled).toHaveBeenCalledTimes(0);
  });

  it('⚠️ 没有注入锁（单副本 / 测试）→ 直接跑，不跳过', async () => {
    const reconciliation = fakeReconciliation();
    const worker = new PayoutWorker(
      fakeExecution(claim) as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(fakeProvider({ status: 'SUCCESS' })),
      reconciliation as unknown as never,
    );

    await worker.process({
      name: 'reconcile',
      data: { channel: 'fake-payout' },
    } as never);

    expect(reconciliation.runScheduled).toHaveBeenCalledTimes(1);
  });

  it('抢到锁 → 正常跑对账', async () => {
    const reconciliation = fakeReconciliation();
    const lock = {
      withLock: jest.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
        return { acquired: true, value: undefined } as const;
      }),
    };
    const worker = new PayoutWorker(
      fakeExecution(claim) as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      fakeRegistry(fakeProvider({ status: 'SUCCESS' })),
      reconciliation as unknown as never,
      lock as unknown as never,
    );

    await worker.process({
      name: 'reconcile',
      data: { channel: 'fake-payout' },
    } as never);

    expect(reconciliation.runScheduled).toHaveBeenCalledTimes(1);
  });
});
