import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import type { QueueService } from '../queue/queue.service';
import {
  REFUND_SCAN_INTERVAL_MS,
  REFUND_SCAN_JOB,
  RefundScanScheduler,
} from './refund-scan.scheduler';

/**
 * 退款核实扫描的周期任务注册器（阶段 6c Task 15）。
 *
 * ⚠️ **重点不是「注册了」，而是「注册对」**：
 *    队列名 / job 名 / jobSchedulerId 任何一个写错，消费端都不会接住，
 *    等于扫描根本没跑 —— 而单元测试照样是绿的。
 */
describe('RefundScanScheduler', () => {
  function build() {
    const queue = { addRepeating: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new RefundScanScheduler(queue as unknown as QueueService);
    return { queue, scheduler };
  }

  it('注册到 payment-webhook 队列，job 名与消费端一致', async () => {
    const { queue, scheduler } = build();

    await scheduler.onModuleInit();

    expect(queue.addRepeating).toHaveBeenCalledTimes(1);
    const [queueName, jobName] = queue.addRepeating.mock.calls[0] as [
      string,
      string,
    ];
    expect(queueName).toBe(PAYMENT_WEBHOOK_QUEUE);
    // ⚠️ 必须与 WebhookWorker 里 `job.name === REFUND_SCAN_JOB` 那个名字一致
    expect(jobName).toBe(REFUND_SCAN_JOB);
  });

  it('每 5 分钟一次，固定 jobSchedulerId（重启不叠加）', async () => {
    const { queue, scheduler } = build();

    await scheduler.onModuleInit();

    const args = queue.addRepeating.mock.calls[0] as [
      string,
      string,
      unknown,
      number,
      string,
    ];
    expect(args[3]).toBe(REFUND_SCAN_INTERVAL_MS);
    expect(args[3]).toBe(5 * 60 * 1000);
    expect(args[4]).toBe('payment-refund-scan');
  });

  it('注册失败 → 向上抛（周期任务没注册等于兜底不跑）', async () => {
    const { queue, scheduler } = build();
    queue.addRepeating.mockRejectedValue(new Error('Redis 不可达'));

    await expect(scheduler.onModuleInit()).rejects.toThrow(/Redis/);
  });
});
