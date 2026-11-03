import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import type { QueueService } from '../queue/queue.service';
import { FAKE_PAYOUT_CHANNEL } from '../../common/payment/fake-payout.provider';
import { PayoutReconcileScheduler } from './payout-reconcile.scheduler';

/**
 * 渠道对账周期任务注册器（阶段 6 审查修复）。
 *
 * ⚠️ **重点不是「注册了」，而是「注册对」**：
 *    队列名 / job 名 / jobSchedulerId 任何一个写错，消费端都不会接住，
 *    等于对账根本没跑 —— 而单元测试照样是绿的。
 *
 * ⚠️ **「按渠道逐个注册」是新口径** —— 原来只注册 `fake-payout`，
 *    第二家渠道实现了 `listPayouts` 却永远不会被自动对账。
 */
describe('PayoutReconcileScheduler', () => {
  let savedFakePayout: string | undefined;

  beforeEach(() => {
    savedFakePayout = process.env.FAKE_PAYOUT_ENABLED;
    // ⚠️ **默认开假网关开关** —— 它是「安全边界」，
    //    关掉时假网关的周期任务就不该注册（另有一个用例专门验这个）。
    process.env.FAKE_PAYOUT_ENABLED = 'true';
  });

  afterEach(() => {
    if (savedFakePayout === undefined) {
      delete process.env.FAKE_PAYOUT_ENABLED;
    } else {
      process.env.FAKE_PAYOUT_ENABLED = savedFakePayout;
    }
  });

  /** 造一个假的注册表（`list()` 返回这些渠道） */
  function fakeRegistry(channels: string[]) {
    return {
      list: jest.fn(() =>
        channels.map((channel) => ({
          channel,
          provider: channel,
          kind: 'PAYOUT' as const,
          devOnly: false,
          capabilities: {} as never,
          timeoutMs: 30_000,
        })),
      ),
    };
  }

  function build(channels: string[] = [FAKE_PAYOUT_CHANNEL]) {
    const queue = { addRepeating: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new PayoutReconcileScheduler(
      queue as unknown as QueueService,
      fakeRegistry(channels) as never,
    );
    return { queue, scheduler };
  }

  it('注册到 payout 队列，job 名与消费端一致', async () => {
    const { queue, scheduler } = build();

    await scheduler.onModuleInit();

    expect(queue.addRepeating).toHaveBeenCalledTimes(1);
    const [queueName, jobName] = queue.addRepeating.mock.calls[0] as [
      string,
      string,
    ];
    expect(queueName).toBe(PAYOUT_QUEUE);
    // ⚠️ 必须与 PayoutWorker 里 `job.name === 'reconcile'` 那个名字一致
    expect(jobName).toBe('reconcile');
  });

  it('⚠️ 每 24 小时一次，jobSchedulerId 带渠道名（各渠道互不覆盖）', async () => {
    const { queue, scheduler } = build(['channel-a', 'channel-b']);

    await scheduler.onModuleInit();

    expect(queue.addRepeating).toHaveBeenCalledTimes(2);
    const calls = queue.addRepeating.mock.calls as Array<
      [string, string, unknown, number, string]
    >;
    expect(calls[0][3]).toBe(24 * 60 * 60 * 1000);
    // ⚠️ **jobSchedulerId 必须不同** —— BullMQ 按它去重，
    //    两个渠道用同一个 id 的话第二个会覆盖第一个 → 只有一个渠道在对账。
    expect(calls[0][4]).toBe('payout-reconcile-channel-a');
    expect(calls[1][4]).toBe('payout-reconcile-channel-b');
  });

  it('⚠️ 每个渠道都带自己的 channel（消费端靠它决定对账哪家）', async () => {
    const { queue, scheduler } = build(['channel-a', 'channel-b']);

    await scheduler.onModuleInit();

    const calls = queue.addRepeating.mock.calls as Array<
      [string, string, { channel: string }]
    >;
    expect(calls[0][2]).toEqual({ channel: 'channel-a' });
    expect(calls[1][2]).toEqual({ channel: 'channel-b' });
  });

  it('⚠️ 假网关开关关掉 → 不注册它的周期任务（否则每天落一条 FAILED）', async () => {
    delete process.env.FAKE_PAYOUT_ENABLED;
    const { queue, scheduler } = build([FAKE_PAYOUT_CHANNEL, 'channel-b']);

    await scheduler.onModuleInit();

    // ⚠️ **只注册第二家渠道** —— 假网关没开关就不注册，
    //    注册了 `listPayouts` 会抛错 → 每天一条 FAILED 任务。
    expect(queue.addRepeating).toHaveBeenCalledTimes(1);
    const calls = queue.addRepeating.mock.calls as Array<
      [string, string, { channel: string }]
    >;
    expect(calls[0][2]).toEqual({ channel: 'channel-b' });
  });

  it('没有可对账的渠道 → 一个都不注册', async () => {
    const { queue, scheduler } = build([]);

    await scheduler.onModuleInit();

    expect(queue.addRepeating).not.toHaveBeenCalled();
  });

  it('注册失败 → 向上抛（周期任务没注册等于对账不跑）', async () => {
    const { queue, scheduler } = build();
    queue.addRepeating.mockRejectedValue(new Error('Redis 不可达'));

    await expect(scheduler.onModuleInit()).rejects.toThrow(/Redis/);
  });
});
