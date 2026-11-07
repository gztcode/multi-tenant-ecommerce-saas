import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

/** 释放锁的 Lua 脚本：只删「自己的」锁（token 匹配），原子执行 */
const UNLOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then ' +
  'return redis.call("del", KEYS[1]) else return 0 end';

/** withLock 的返回值：acquired=false 表示没抢到锁（fn 未执行） */
export type LockOutcome<T> = { acquired: true; value: T } | { acquired: false };

/** 默认锁 TTL：周期任务单轮的最长合法执行时间（毫秒） */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 锁 key 的统一前缀，避免与其他 Redis key 冲突 */
const KEY_PREFIX = 'lock:';

/**
 * Redis 分布式锁（阶段 11：跨副本互斥）。
 *
 * ## 解决什么问题
 *
 * 单副本时 BullMQ 的 `jobSchedulerId` 去重 + 单消费者已经够用；
 * 但有两类真正的跨副本重复点：
 * 1. **进程内定时器**——media 孤儿清理是每个副本各自的 `setInterval`，
 *    N 个副本就清 N 遍（逐条 HEAD + updateMany，纯属浪费）；
 * 2. **兜底扫描的双保险**——对账/出款/退款扫描虽经队列单消费，
 *    但「同一时间只允许一个对账任务」在队列语义里并不严格
 *    （手动触发、队列重投等都可能让两轮并发），锁是最后一条防线。
 *
 * ## 语义（刻意从简）
 *
 * - **抢不到 = 跳过本轮**，不等待不重试——调用方都是周期任务，
 *   错过一轮没有损失，下一轮照来；
 * - **Redis 不可用 = 跳过本轮**（与 MetricsService 轮询同一哲学：
 *   观测/清理类旁路绝不拖垮业务），绝不抛出；
 * - token 用随机 UUID，释放走 Lua 比对删除——**绝不会误删别人的锁**
 *   （自己超时后，别人抢到了锁，自己回来时 token 不匹配，删不掉）。
 *
 * ## 边界
 *
 * - 不做续租（watchdog）：TTL 取「任务单轮的最长合法时间」，超时视为
 *   持有者已死。任务超过 TTL 会被另一副本并发执行——对幂等的扫描
 *   这是可接受的（扫描本身就是条件更新，天然防重）；
 * - key 自动加 `lock:` 前缀。
 */
@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly client: Redis;

  /** 显式注入仅用于单测；生产按 REDIS_URL 建（与 QueueModule 同源）。
   *  ⚠️ @Optional() 必须加：emitDecoratorMetadata 会把 ioredis 的 Redis
   *  类当成 DI 令牌去解析，不加的话 Nest 启动直接报无法解析依赖。 */
  constructor(@Optional() client?: Redis) {
    this.client =
      client ??
      new Redis(process.env.REDIS_URL ?? 'redis://localhost:16380', {
        // 锁操作是非阻塞短命令，不涉及 BullMQ 的阻塞读约束
        maxRetriesPerRequest: 2,
        // 连不上 Redis 时快速失败（由 withLock 捕获并跳过本轮）
        connectTimeout: 3000,
        retryStrategy: (times) => Math.min(times * 1000, 10_000),
        // ⚠️ 惰性连接：从不用锁的进程/测试实例就不开连接、不留句柄
        //（不设的话每个 AppModule 实例都常驻一条 Redis 连接）
        lazyConnect: true,
      });
    this.client.on('error', (error: Error) => {
      // ioredis 不挂 error 监听会把连接错误抛成 uncaughtException
      this.logger.warn(`锁客户端 Redis 连接异常：${error.message}`);
    });
  }

  /**
   * 抢锁执行。抢不到返回 `{ acquired: false }`，fn 不会被调用。
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { ttlMs?: number },
  ): Promise<LockOutcome<T>> {
    const fullKey = KEY_PREFIX + key;
    const token = RedisLockService.newToken();
    const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

    let acquired: string | null;
    try {
      // NX：不存在才设置；PX：毫秒级 TTL（过期自动释放，防持有者崩溃死锁）
      acquired = await this.client.set(fullKey, token, 'PX', ttlMs, 'NX');
    } catch (error) {
      this.logger.warn(
        `抢锁失败（Redis 不可用），跳过本轮：${key}：${
          error instanceof Error ? error.message : 'UnknownError'
        }`,
      );
      return { acquired: false };
    }

    if (acquired !== 'OK') {
      // 另一个副本正在跑——正常情况，debug 级即可
      return { acquired: false };
    }

    try {
      const value = await fn();
      return { acquired: true, value };
    } finally {
      // 无论 fn 成功失败都要释放；释放失败（Redis 抖动）无碍——
      // TTL 会兜底过期
      try {
        await this.client.eval(UNLOCK_SCRIPT, 1, fullKey, token);
      } catch {
        // 释放失败只可能出现在 Redis 不可用时，TTL 兜底
      }
    }
  }

  onModuleDestroy(): void {
    // 断开不等待：进程退出时锁靠 TTL 兜底
    void this.client.quit().catch(() => this.client.disconnect());
  }

  /** token 生成（单独抽出是为了测试可以固定值） */
  private static newToken(): string {
    return randomUUID();
  }
}
