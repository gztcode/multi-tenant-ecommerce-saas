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
    // 五个队列参数用同一个替身即可——本用例只关心「会不会超时」
    return new QueueService(
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
    );

    const error = await service
      .add('payment-timeout', 'release', {}, 'job-1')
      .catch((e: unknown) => e);

    // 原样抛出：同一个错误对象，且不是 ServiceUnavailableException
    expect(error).toBe(cause);
    expect(error).not.toBeInstanceOf(ServiceUnavailableException);
  });
});
