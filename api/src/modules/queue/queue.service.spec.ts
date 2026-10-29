import { ServiceUnavailableException } from '@nestjs/common';

import { QUEUE_OPERATION_TIMEOUT_MS, QueueService } from './queue.service';

/**
 * 队列投递的超时保护。
 *
 * ## 为什么这条用例必须存在
 *
 * BullMQ 覆盖了 ioredis 的 `retryStrategy` → **无限重试** → Redis 不可达时
 * `queue.add()` 返回的 Promise **永远不 settle**。
 * 没有超时包装的话，下单请求会永久挂住：订单已落库、响应一直转圈。
 *
 * 所以这里用一个「永远不 settle 的 Promise」当队列的替身：
 * 没有超时 → 测试**挂住**（jest 超时失败）；有超时 → 抛 503。
 */
describe('QueueService 的超时保护', () => {
  /** 永远不 settle 的 Promise——模拟 Redis 不可达 */
  const pending = () => new Promise<never>(() => {});

  function makeService() {
    const queue = {
      add: jest.fn(() => pending()),
      upsertJobScheduler: jest.fn(() => pending()),
    };
    // 六个队列参数用同一个替身即可——本用例只关心「会不会超时」
    return new QueueService(
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
    );
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('add 在队列不可达时抛 ServiceUnavailableException，而不是永远挂住', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const promise = service.add('payment-timeout', 'release', {}, 'job-1');
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await jest.advanceTimersByTimeAsync(QUEUE_OPERATION_TIMEOUT_MS);
    await assertion;
  });

  it('addDelayed 在队列不可达时同样抛 503', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const promise = service.addDelayed(
      'payment-timeout',
      'release',
      {},
      60_000,
      'job-2',
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await jest.advanceTimersByTimeAsync(QUEUE_OPERATION_TIMEOUT_MS);
    await assertion;
  });

  it('addRepeating 在队列不可达时同样抛 503', async () => {
    jest.useFakeTimers();
    const service = makeService();

    const promise = service.addRepeating(
      'billing',
      'scan',
      {},
      60_000,
      'billing-scan',
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    await jest.advanceTimersByTimeAsync(QUEUE_OPERATION_TIMEOUT_MS);
    await assertion;
  });

  it('队列正常时原样返回结果（超时包装不改变成功路径）', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
    const service = new QueueService(
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
    );

    await expect(
      service.add('payment-timeout', 'release', {}, 'job-1'),
    ).resolves.toBeUndefined();
  });

  it('队列报的普通错误原样抛出，不会被当成超时转成 503', async () => {
    const cause = new Error('redis 报错');
    const queue = {
      add: jest.fn().mockRejectedValue(cause),
      upsertJobScheduler: jest.fn().mockRejectedValue(cause),
    };
    const service = new QueueService(
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
    );

    const error = await service
      .add('payment-timeout', 'release', {}, 'job-1')
      .catch((e: unknown) => e);

    // 原样抛出：同一个错误对象，且不是 ServiceUnavailableException
    expect(error).toBe(cause);
    expect(error).not.toBeInstanceOf(ServiceUnavailableException);
  });
});

/**
 * `addWithOptions` 的 job 选项形状。
 *
 * ## 为什么这条用例必须存在
 *
 * 出款入队要 **`attempts: 1`**（BullMQ 自己的重试关掉，重试由出款单的
 * `attemptCount` + 退避控制）。如果哪天有人把 `...DEFAULT_JOB_OPTIONS`
 * 又 spread 回来 → `backoff` 跟着回来 → BullMQ 会在我们「退回 APPROVED
 * 等下次」之后**又立刻重跑同一个 job** → 3 次尝试在 1 秒内烧完。
 *
 * ⚠️ **e2e 抓不到这个**：它只断言最终状态，看不见「中间是不是重跑了几次」。
 * 所以这里直接断言 `queue.add` 的**第三个参数**（job options）的形状。
 */
describe('QueueService.addWithOptions 的 job 选项', () => {
  /** 能返回结果的队列替身——本组用例要断言 add 的入参 */
  function makeService() {
    const queue = {
      add: jest.fn(() => Promise.resolve({ id: '1' })),
      upsertJobScheduler: jest.fn(() => Promise.resolve(undefined)),
    };
    const service = new QueueService(
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
    );
    return { service, queue };
  }

  /** 取 add 的第三个参数（job options） */
  function optionsOf(queue: { add: jest.Mock }) {
    const call = queue.add.mock.calls[0] as unknown[] | undefined;
    expect(call).toBeDefined();
    return call?.[2] as Record<string, unknown>;
  }

  it('attempts: 1 → 不带 backoff，attempts 就是 1', async () => {
    const { service, queue } = makeService();

    await service.addWithOptions('payout', 'execute', {}, 'payout-1', {
      attempts: 1,
    });

    const options = optionsOf(queue);
    expect(options.attempts).toBe(1);
    // ⚠️ **核心断言**：有 backoff 就会绕过我们自己的退避，立刻重跑
    expect(options).not.toHaveProperty('backoff');
  });

  it('attempts 未传（默认）→ 带 backoff，attempts 是 3', async () => {
    const { service, queue } = makeService();

    await service.addWithOptions('payout', 'execute', {}, 'payout-2', {});

    const options = optionsOf(queue);
    expect(options.attempts).toBe(3);
    expect(options).toHaveProperty('backoff');
  });

  it('传了 delay → 带 delay 键；没传 → 不带 delay 键', async () => {
    const withDelay = makeService();
    await withDelay.service.addWithOptions(
      'payout',
      'execute',
      {},
      'payout-3',
      { attempts: 1, delay: 5_000 },
    );
    const options = optionsOf(withDelay.queue);
    expect(options).toHaveProperty('delay');
    expect(options.delay).toBe(5_000);
    // delay 不影响 attempts 的语义
    expect(options.attempts).toBe(1);
    expect(options).not.toHaveProperty('backoff');

    const withoutDelay = makeService();
    await withoutDelay.service.addWithOptions(
      'payout',
      'execute',
      {},
      'payout-4',
      { attempts: 1 },
    );
    expect(optionsOf(withoutDelay.queue)).not.toHaveProperty('delay');
  });

  it('removeOnComplete: true → 完成即删（否则同 jobId 永远不能再用）', async () => {
    // ⚠️ **BullMQ 默认把完成的 job 留在 `completed` 集合里** →
    //    队列一直涨，且**同一个 jobId 永远不能再用** → 重新入队被静默忽略。
    const withRemove = makeService();
    await withRemove.service.addWithOptions(
      'payout',
      'execute',
      {},
      'payout-5',
      { attempts: 1, removeOnComplete: true },
    );
    expect(optionsOf(withRemove.queue).removeOnComplete).toBe(true);

    // ⚠️ **没传 → 不带这个键**（不改变现有调用点的行为）
    const withoutRemove = makeService();
    await withoutRemove.service.addWithOptions(
      'payout',
      'execute',
      {},
      'payout-6',
      { attempts: 1 },
    );
    expect(optionsOf(withoutRemove.queue)).not.toHaveProperty(
      'removeOnComplete',
    );
  });
});
