import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  AUTH_QUEUE,
  BILLING_QUEUE,
  COMPENSATION_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
} from '../../common/queue/queue.constants';
import { TimeoutError, withTimeout } from '../../common/util/with-timeout';

export type QueueName =
  | typeof PAYMENT_TIMEOUT_QUEUE
  | typeof PAYMENT_WEBHOOK_QUEUE
  | typeof BILLING_QUEUE
  | typeof AUTH_QUEUE
  | typeof COMPENSATION_QUEUE;

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
 * 队列投递超时（毫秒）。
 *
 * ⚠️ BullMQ 覆盖了 ioredis 的 `retryStrategy` → **无限退避重试** →
 * Redis 不可达时 `queue.add()` 的 Promise **永远不 settle**。
 * 不设超时的话，请求会永远挂住（订单已落库、响应一直转圈）。
 */
export const QUEUE_OPERATION_TIMEOUT_MS = 3_000;

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
    @InjectQueue(COMPENSATION_QUEUE) compensationQueue: Queue,
  ) {
    this.queues.set(PAYMENT_TIMEOUT_QUEUE, timeoutQueue);
    this.queues.set(PAYMENT_WEBHOOK_QUEUE, webhookQueue);
    this.queues.set(BILLING_QUEUE, billingQueue);
    this.queues.set(AUTH_QUEUE, authQueue);
    this.queues.set(COMPENSATION_QUEUE, compensationQueue);
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
    await this.withQueueTimeout(
      this.queueOf(queueName).add(jobName, data, {
        delay: delayMs,
        jobId,
        ...DEFAULT_JOB_OPTIONS,
      }),
      `${queueName}/${jobName}`,
    );
  }

  async add(
    queueName: QueueName,
    jobName: string,
    data: unknown,
    jobId: string,
  ): Promise<void> {
    await this.withQueueTimeout(
      this.queueOf(queueName).add(jobName, data, {
        jobId,
        ...DEFAULT_JOB_OPTIONS,
      }),
      `${queueName}/${jobName}`,
    );
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
    await this.withQueueTimeout(
      this.queueOf(queueName).upsertJobScheduler(
        jobSchedulerId,
        { every: everyMs },
        {
          name: jobName,
          data: data as never,
          opts: DEFAULT_JOB_OPTIONS,
        },
      ),
      `${queueName}/${jobName}`,
    );
  }

  /**
   * 给队列操作加超时。
   *
   * 超时 → `ServiceUnavailableException`（HTTP 503）。
   * ⚠️ **超时不会取消底层操作**：那个 `add()` 仍在跑，Redis 恢复后它可能
   * **还会成功入队**。调用方要按「超时后那个操作还算不算数」来决定怎么处理
   * （下单链路选择「失败不致命」，见 order.service.ts）。
   *
   * ⚠️ **在 `onModuleInit` 里调用会失败启动**：NestJS 的 `onModuleInit` 抛异常
   * 会让进程起不来。`addRepeating` 的两个调用点（token-grace.service.ts 的
   * 每小时清理、renewal.service.ts 的每日扫描）都在 `onModuleInit` 里 →
   * **Redis 在启动时不可达 = 进程 3 秒后报错退出**。
   *
   * 这是有意为之：周期任务没注册意味着账目与令牌清理都不跑，
   * 与其让一个「看起来正常、其实不干活」的进程跑着，不如快速失败。
   * 且它比「永远卡在 bootstrap、没有任何提示」更易恢复 ——
   * 容器编排会重启它，Redis 恢复后自然就起来了。
   */
  private async withQueueTimeout<T>(
    promise: Promise<T>,
    what: string,
  ): Promise<T> {
    try {
      return await withTimeout(promise, QUEUE_OPERATION_TIMEOUT_MS, what);
    } catch (cause) {
      if (cause instanceof TimeoutError) {
        throw new ServiceUnavailableException(`队列操作超时：${what}`);
      }
      throw cause;
    }
  }

  private queueOf(queueName: QueueName): Queue {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`队列不存在：${queueName}`);
    }
    return queue;
  }
}
