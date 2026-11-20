import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';

import { RedisLockService } from '../../common/lock/redis-lock.service';

/** 每个客户端对每个订单号的最大连续失败次数 */
const MAX_ATTEMPTS = 5;

/** 失败计数窗口（毫秒） */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Redis 不可用时的**降级短路窗口**（毫秒）。
 *
 * 连接参数是 `connectTimeout: 3000` + `maxRetriesPerRequest: 2`，
 * 一次失败的命令最多要等好几秒。查单是面向用户的读接口，
 * 不能每个请求都陪着 Redis 一起等——所以一旦失败，
 * 接下来这段时间内**不再尝试** Redis，直接放行。
 */
const DEGRADED_COOLDOWN_MS = 30 * 1000;

/** Redis key 前缀，避免与 BullMQ / 锁的 key 撞车 */
const KEY_PREFIX = 'guestlookup:attempts:';

/**
 * 「计数 + 首次设 TTL」的原子脚本。
 *
 * ⚠️ **必须原子**：分开写 `INCR` 再 `EXPIRE`，两个请求交错时
 *    会出现「INCR 之后、EXPIRE 之前」另一个请求也 INCR 的窗口，
 *    极端情况下 key 会**永不过期**——那块计数就再也清不掉了。
 *    Lua 脚本在 Redis 里是原子的，天然没有这个窗口。
 * ⚠️ **只在 `INCR` 返回 1 时才设 TTL**：即「窗口从第一次失败起算」，
 *    与原先进程内实现的 `firstAt` 语义一致（窗口不滑动）。
 */
const INCR_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  'if count == 1 then',
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  'end',
  'return count',
].join('\n');

/**
 * 游客查单的防爆破计数器（阶段 11，P1 修复）。
 *
 * ## 要解决什么
 *
 * 猜 (orderNo, phone) 组合靠穷举手机号。这里的失败计数按
 * **「来源 IP × 订单号」**隔离：同一来源对同一订单号连续失败
 * `MAX_ATTEMPTS` 次后熔断 10 分钟，成功一次即清零。
 *
 * 修复前有两个致命问题：
 *
 * 1. **来源 IP 取错**：api 不开 `trust proxy` 时 Express 完全不采信
 *    `x-forwarded-for`，`req.ip` 恒等于 TCP 对端地址——生产上就是
 *    网关 / BFF 容器的 IP。于是所有来源共用一个计数桶，
 *    **一个坏客户端就能把真实客户的查单入口锁死 10 分钟**。
 *    （可信代理链在 `app.module.ts` 的 `onModuleInit` 里修。）
 * 2. **计数只在进程内**：多副本部署时各副本各数各的，
 *    既挡不住分布式穷举，也没有统一的过期回收。
 *
 * ## Redis 不可用怎么办（降级策略）
 *
 * **fail-open**：Redis 不可用 → 放行（不熔断）。
 *
 * 取舍：fail-closed 会在 Redis 抖动时把**所有**用户的查单一起锁死，
 * 那比失去防爆破保护更糟（查单是低价值、只读、无副作用的端点，
 * 网关层还有 `limit_req` 兜底）。但 fail-open 意味着**这段时间没有防爆破**，
 * 所以：
 * - 进入降级时打 `error` 日志（要能被告警看到）；
 * - 降级期间短路，不再反复连 Redis（避免把接口拖成几秒的慢请求）。
 */
@Injectable()
export class GuestLookupThrottleService {
  private readonly logger = new Logger(GuestLookupThrottleService.name);

  /** 降级短路截止时间戳（毫秒）；0 = 不在降级中 */
  private degradedUntil = 0;

  constructor(private readonly lockService: RedisLockService) {}

  /**
   * 这个来源对这个订单号是否已被熔断。
   *
   * Redis 不可用时返回 false（fail-open）。
   */
  async isBlocked(ip: string | undefined, orderNo: string): Promise<boolean> {
    const count = await this.readCount(ip, orderNo);
    if (count === null) return false;
    return count >= MAX_ATTEMPTS;
  }

  /** 记一次失败（查不到订单 / 手机号不匹配）。 */
  async recordFailure(ip: string | undefined, orderNo: string): Promise<void> {
    if (this.isDegraded()) return;
    try {
      await this.lockService.redis.eval(
        INCR_SCRIPT,
        1,
        this.buildKey(ip, orderNo),
        String(ATTEMPT_WINDOW_MS),
      );
    } catch (error) {
      this.markDegraded(error);
    }
  }

  /** 查单成功 → 清零该「来源 IP × 订单号」的失败计数。 */
  async reset(ip: string | undefined, orderNo: string): Promise<void> {
    if (this.isDegraded()) return;
    try {
      await this.lockService.redis.del(this.buildKey(ip, orderNo));
    } catch (error) {
      this.markDegraded(error);
    }
  }

  /**
   * 读当前失败次数。Redis 不可用 → null（调用方按 fail-open 处理）。
   */
  private async readCount(
    ip: string | undefined,
    orderNo: string,
  ): Promise<number | null> {
    if (this.isDegraded()) return null;
    try {
      const raw = await this.lockService.redis.get(this.buildKey(ip, orderNo));
      if (raw === null) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
      this.markDegraded(error);
      return null;
    }
  }

  /**
   * 拼 Redis key。
   *
   * 格式：`guestlookup:attempts:{ipLen}:{ip}:{encodedOrderNo}`
   *
   * - `{ipLen}` 是**长度前缀**：IPv6 的 `req.ip` 里带 `:`（如 `::ffff:127.0.0.1`），
   *   不带长度前缀就没法把「IP」和「订单号」切开；
   * - `{ip}` 已归一化（非法 IP 归到 `unknown` 桶）；
   * - `{encodedOrderNo}` 用 `encodeURIComponent` 编码：订单号是**攻击者可控**的
   *   自由文本（DTO 只限了长度 6~64，没限字符集），
   *   编码后 `:` 之类的字符不会破坏 key 的结构。
   */
  private buildKey(ip: string | undefined, orderNo: string): string {
    const normalized = this.normalizeIp(ip);
    return `${KEY_PREFIX}${normalized.length}:${normalized}:${encodeURIComponent(orderNo)}`;
  }

  /**
   * 归一化来源 IP。
   *
   * ⚠️ 非法 IP 一律归到 `unknown` 桶，**不做「原样当 IP 用」**：
   *    否则攻击者随手换一串字符串就能换一个计数桶，防爆破形同虚设。
   */
  private normalizeIp(ip: string | undefined): string {
    if (!ip) return 'unknown';
    const trimmed = ip.trim();
    if (trimmed.length === 0) return 'unknown';
    return isIP(trimmed) === 0 ? 'unknown' : trimmed;
  }

  private isDegraded(): boolean {
    return Date.now() < this.degradedUntil;
  }

  /** 进入降级：记 error 日志 + 短路一段时间 */
  private markDegraded(error: unknown): void {
    const message = error instanceof Error ? error.message : 'UnknownError';
    if (!this.isDegraded()) {
      this.logger.error(
        `游客查单防爆破计数不可用，已降级为放行（${DEGRADED_COOLDOWN_MS / 1000} 秒内不再尝试 Redis）：${message}`,
      );
    }
    this.degradedUntil = Date.now() + DEGRADED_COOLDOWN_MS;
  }
}
