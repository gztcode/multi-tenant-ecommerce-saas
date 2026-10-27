import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  AUTH_QUEUE,
  BILLING_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
} from '../../common/queue/queue.constants';

export type QueueName =
  | typeof PAYMENT_TIMEOUT_QUEUE
  | typeof PAYMENT_WEBHOOK_QUEUE
  | typeof BILLING_QUEUE
  | typeof AUTH_QUEUE;

/**
 * 任务失败时的重试次数与退避策略。
 *
 * ⚠️ **BullMQ 的默认 `attempts` 是 0——即一次都不重试。**
 * 任务抛异常后就被标成 `failed` 躺进失败队列，没有人会去捞。
 * 而「任务失败」不等于「数据错了」：数据库死锁、锁等待超时、
 * 网络抖动这类**瞬时故障**重试一次就成了。
 *
 * 有了重试，事件行「上次没处理完」那条路径才有意义
 * （见 PaymentService.insertEvent：`processedAt` 为 null 时允许重新处理）。
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
};

/**
 * BullMQ 队列封装的**入队侧**。
 *
 * 队列实例由 `@nestjs/bullmq` 的 `BullModule` 注册（见 queue.module.ts），
 * 这里只负责「往队列里投递任务」，不负责连接管理——连接是 Nest 的事。
 *
 * ⚠️ `jobId` 的去重语义靠 BullMQ：同名的 jobId 不会重复入队。
 * 但**消费端仍要幂等**——任务可能在消费途中进程崩溃，重启后被重新投递。
 * 消费端的幂等靠**条件更新**（超时释放靠订单状态的条件更新，
 * webhook 消费靠支付单状态与订单状态的条件更新），不是靠唯一索引。
 */
@Injectable()
export class QueueService {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    @InjectQueue(PAYMENT_TIMEOUT_QUEUE) timeoutQueue: Queue,
    @InjectQueue(PAYMENT_WEBHOOK_QUEUE) webhookQueue: Queue,
    @InjectQueue(BILLING_QUEUE) billingQueue: Queue,
    @InjectQueue(AUTH_QUEUE) authQueue: Queue,
  ) {
    this.queues.set(PAYMENT_TIMEOUT_QUEUE, timeoutQueue);
    this.queues.set(PAYMENT_WEBHOOK_QUEUE, webhookQueue);
    this.queues.set(BILLING_QUEUE, billingQueue);
    this.queues.set(AUTH_QUEUE, authQueue);
  }

  /**
   * 投递一个延迟任务。
   *
   * @param jobId 幂等键——同名不会重复入队
   */
  async addDelayed(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    delayMs: number,
    jobId: string,
  ): Promise<void> {
    await this.queueOf(queueName).add(jobName, data, {
      delay: delayMs,
      jobId,
      ...DEFAULT_JOB_OPTIONS,
    });
  }

  async add(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    jobId: string,
  ): Promise<void> {
    await this.queueOf(queueName).add(jobName, data, {
      jobId,
      ...DEFAULT_JOB_OPTIONS,
    });
  }

  /**
   * 投递一个**周期性**任务。
   *
   * ⚠️ **固定 `jobSchedulerId` 是去重的关键**：BullMQ 的作业调度器按
   * `jobSchedulerId` 去重，重复注册是**覆盖**而不是**叠加** ——
   * 否则每次重启应用都会多一个扫描任务。
   *
   * ⚠️ **BullMQ v6 的 `Queue.add` 不再接受 `repeat` 选项**（类型上已被移除，
   * 官方要求改用 `upsertJobScheduler`）。这里用它而不是自己拼 jobId。
   */
  async addRepeating(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    everyMs: number,
    jobSchedulerId: string,
  ): Promise<void> {
    await this.queueOf(queueName).upsertJobScheduler(
      jobSchedulerId,
      { every: everyMs },
      {
        name: jobName,
        data: data as never,
        opts: DEFAULT_JOB_OPTIONS,
      },
    );
  }

  private queueOf(queueName: QueueName): Queue {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`队列不存在：${queueName}`);
    }
    return queue;
  }
}
