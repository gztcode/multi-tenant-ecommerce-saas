import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { TimeoutError } from '../common/util/with-timeout';

/** 单次探活的超时（毫秒） */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Redis 探活。
 *
 * ## 为什么必须用**独立连接**，不能复用 BullMQ 的那个
 *
 * `queue.module.ts` 里 `BullModule.forRoot` 配的是 `maxRetriesPerRequest: null`
 * + BullMQ 默认的**无限退避重试**。那个实例在 Redis 挂掉时会把 `PING`
 * 排进离线队列里**永远不返回** —— 用它探活等于把探活本身也挂死
 * （正是本阶段要修的那个机制）。
 *
 * ## 连接参数的取舍
 *
 * - `enableOfflineQueue: false` —— 连接不可用时**立刻**失败，而不是把命令
 *   排进离线队列干等。这是「失败得快」的关键。
 * - `retryStrategy` **保留重试**（封顶 2 秒一次）—— 不能设成 `() => null`：
 *   那样连接一断就永久停止重连，Redis 恢复后探活再也回不来。
 * - `connectTimeout: 2000` —— 建连本身也要有上限。
 */
@Injectable()
export class RedisProbe implements OnModuleDestroy {
  private readonly logger = new Logger(RedisProbe.name);
  private client: Redis | null = null;

  /** Redis 不可达时返回 false（绝不抛出去） */
  async check(): Promise<boolean> {
    try {
      await this.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 等连接就绪后再 PING，**整体预算 2 秒**。
   *
   * ⚠️ **必须先等 `ready`**：`enableOfflineQueue: false` 的语义是
   * 「连接还没建立时，命令立刻失败而不是排进离线队列」。
   * 而客户端是懒创建的——第一次探活时连接必然尚未建立，
   * 直接 `ping()` 会永远命中「Stream isn't writeable」→ 探活恒为 false，
   * 哪怕 Redis 好好的。
   *
   * ⚠️ **超时路径必须摘掉监听器**：`once` 注册的监听器只有真的等到
   * `'ready'` / `'error'` 才会被消费掉。Redis 挂着不动时探活只会走超时分支
   * → 监听器留在连接上 → `/health` 每 10 秒轮询一次就泄漏 2 个 →
   * `MaxListenersExceededWarning` + 内存增长。
   *
   * ⚠️ **超时预算只有一份**：「等 ready」与「PING」共用同一个 2 秒定时器
   * （见 {@link waitUntilReady}），不要在外面再套一层同长的超时，
   * 否则总预算会变成 4 秒。
   */
  private async ping(): Promise<string> {
    const client = this.getClient();
    if (client.status !== 'ready') {
      await this.waitUntilReady(client);
    }
    return client.ping();
  }

  /**
   * 等连接就绪，最多等 {@link PROBE_TIMEOUT_MS} 毫秒。
   *
   * 超时抛 {@link TimeoutError}；**任何退出路径（含超时）都会摘掉 `ready` /
   * `error` 两个监听器**，避免探活反复轮询时在连接上堆积监听器。
   *
   * ⚠️ 这里**自己管定时器**而不用 {@link withTimeout}：
   * `withTimeout` 靠 `Promise.race` 实现，超时只是让调用方先拿到错误，
   * **底层那个 Promise 仍在跑** → 超时分支里的 `off()` 根本不会被执行
   * → 监听器照样泄漏。要让超时路径摘掉监听器，就必须把定时器握在自己手里。
   */
  private async waitUntilReady(client: Redis): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const onReady = () => {
      client.off('error', onError);
      resolveReady();
    };
    const onError = (err: Error) => {
      client.off('ready', onReady);
      rejectReady(err);
    };
    let resolveReady: () => void = () => undefined;
    let rejectReady: (err: Error) => void = () => undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;

        timer = setTimeout(() => {
          reject(new TimeoutError('Redis 连接就绪', PROBE_TIMEOUT_MS));
        }, PROBE_TIMEOUT_MS);

        client.once('ready', onReady);
        client.once('error', onError);

        // ⚠️ **防御性复查**：注册监听后回头看一眼 status。
        // ioredis v6 是同步设 status、异步发事件，所以竞态窗口实际为 0；
        // 但万一将来实现改了（先发事件再设 status），这里能兜住。
        if (client.status === 'ready') {
          client.off('ready', onReady);
          client.off('error', onError);
          resolve();
        }
      });
    } finally {
      // ⚠️ **所有退出路径都在这里摘监听器**——包括超时。
      // `once` 注册的监听器只有真的等到 `'ready'` / `'error'` 才会被消费，
      // 超时路径不摘掉就会一直挂在连接上（每轮探活泄漏 2 个）。
      client.off('ready', onReady);
      client.off('error', onError);
      if (timer) clearTimeout(timer);
    }
  }

  private getClient(): Redis {
    if (!this.client) {
      this.client = new Redis(
        process.env.REDIS_URL ?? 'redis://localhost:16380',
        {
          connectTimeout: PROBE_TIMEOUT_MS,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 200, 2_000),
        },
      );
      // ⚠️ 连接失败会抛 'error' 事件；不接住的话 Node 会把它当成
      // 未处理的异常 → 整个进程挂掉。探活失败只该让 /health 报 degraded。
      this.client.on('error', (err: Error) => {
        // 不抛：探活的结果由 check() 的返回值表达。
        // 但要留日志——否则 Redis 挂了容器只在 503 里看得到，排查时没有线索。
        this.logger.warn(`Redis 探活连接异常：${err.message}`);
      });
    }
    return this.client;
  }

  onModuleDestroy(): void {
    this.client?.disconnect();
  }
}
