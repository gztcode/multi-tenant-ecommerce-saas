import {
  PAYOUT_MAX_ATTEMPTS,
  PayoutWorker,
  payoutRetryDelayMs,
} from './payout.worker';
import type { PayoutProvider } from './payout-provider.interface';

/**
 * 出款 worker 的单元测试。
 *
 * ⚠️ **重点验三件事**：
 * ① 抢不到单 → **什么都不做**（不重试、不落 FAILED）
 * ② 渠道失败 → 退回 `APPROVED` 并**延迟重新入队**（不是靠 BullMQ 重试）
 * ③ 扫描 → `PROCESSING` 绝不重试，只有 `APPROVED` 被重新入队
 */

/**
 * 一只假的渠道。
 *
 * ⚠️ **`execute` 声明成「属性」而不是接口里的「方法」** ——
 *    eslint 的 `unbound-method` 规则不允许把对象方法单独取出来断言
 *    （`expect(provider.execute)`），断言要用属性形态的 mock。
 */
interface FakeProvider {
  calls: unknown[];
  channel: string;
  provider: string;
  execute: jest.Mock;
  queryPayout: jest.Mock;
}

function fakeProvider(result: {
  status: string;
  amount?: number;
  failureReason?: string;
  throws?: Error;
}): FakeProvider {
  const calls: unknown[] = [];
  return {
    calls,
    channel: 'fake-payout',
    provider: 'fake-payout',
    execute: jest.fn((input: unknown) => {
      calls.push(input);
      if (result.throws) {
        return Promise.reject(result.throws);
      }
      return Promise.resolve({
        providerTxnId: 'txn-1',
        status: result.status,
        amount: result.amount ?? 8500,
        failureReason: result.failureReason,
      });
    }),
    queryPayout: jest.fn(() => Promise.resolve({ status: 'SUCCESS' })),
  };
}

/** 假的 execution service */
function fakeExecution(claim: unknown) {
  return {
    claimForExecution: jest.fn(() => Promise.resolve(claim)),
    markPaid: jest.fn(() => Promise.resolve(true)),
    markFailed: jest.fn(() => Promise.resolve(true)),
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
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.execute).not.toHaveBeenCalled();
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
      new Map([['fake-payout', provider]]),
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
      new Map([['fake-payout', provider]]),
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

  it('⚠️ 渠道金额核对不通过 → markFailed（护栏 X3）', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({ status: 'SUCCESS', amount: 9999 });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markFailed).toHaveBeenCalled();
    expect(execution.markPaid).not.toHaveBeenCalled();
  });

  it('⚠️ 金额 ≤ 0 → 落 FAILED，不调渠道（护栏 X4）', async () => {
    const execution = fakeExecution({ ...claim, netAmount: 0 });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();
  });

  it('⚠️ 账户快照缺失 → 落 FAILED，不调渠道', async () => {
    const execution = fakeExecution({ ...claim, account: null });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();
  });

  it('渠道失败且未超上限 → 退回 APPROVED 并延迟重新入队', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map([['fake-payout', provider]]),
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
        failureReason: '渠道超时',
      });
      const queues = fakeQueues();
      const worker = new PayoutWorker(
        execution as unknown as never,
        fakePrisma() as unknown as never,
        queues as unknown as never,
        new Map([['fake-payout', provider]]),
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
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map([['fake-payout', provider]]),
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
      failureReason: '渠道超时',
    });
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.markFailed).toHaveBeenCalled();
    expect(execution.scheduleRetry).not.toHaveBeenCalled();
    expect(queues.addWithOptions).not.toHaveBeenCalled();
  });

  it('渠道抛异常 → 当成失败处理，不冒到 BullMQ', async () => {
    const execution = fakeExecution(claim);
    const provider = fakeProvider({
      status: 'FAILED',
      throws: new Error('网络不通'),
    });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    expect(execution.scheduleRetry).toHaveBeenCalled();
  });

  it('未知 job name → 什么都不做', async () => {
    const execution = fakeExecution(claim);
    const queues = fakeQueues();
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      queues as unknown as never,
      new Map<string, PayoutProvider>(),
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
      new Map<string, PayoutProvider>(),
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
      new Map<string, PayoutProvider>(),
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
      new Map<string, PayoutProvider>(),
    );

    await worker.process({ name: 'scan', data: {} } as never);

    expect(queues.addWithOptions).not.toHaveBeenCalled();
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
