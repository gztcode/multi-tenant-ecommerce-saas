/** 一条限流规则 */
export interface RateLimitRule {
  /** 窗口内允许的次数上限；计数达到它即视为超限 */
  max: number;
  /** 窗口长度（毫秒），从窗口内**第一次**计数起算 */
  windowMs: number;
}

/** 一条计数 */
interface CounterRecord {
  /** 窗口内累计的次数 */
  count: number;
  /** 计数归零的时刻（毫秒时间戳） */
  resetAt: number;
}

/** 每记多少次顺手清一次过期项（把清理成本摊平） */
const SWEEP_EVERY = 50;

/** 默认容量 —— 防「用一堆不存在的 key 把内存撑爆」 */
const DEFAULT_CAPACITY = 20_000;

export interface RateLimitCounterOptions {
  /** 注入时钟（毫秒时间戳），默认 `Date.now`；单测用它跨窗口 */
  now?: () => number;
  /** 最多同时记多少条，默认 20000 */
  capacity?: number;
}

/**
 * 进程内的固定窗口计数器（不依赖 Redis）。
 *
 * 语义：
 * - 窗口内第一次 `record` 起算，`windowMs` 后整条归零；
 * - `isLimited` 只看计数是否已达规则的 `max`，不写计数；
 * - 每个 key 独立计数，调用方负责把「维度」（账号 / IP / 动作）编进 key。
 *
 * ⚠️ **计数在进程内存里**：多副本部署时实际上限会按副本数放大。
 *    要上多副本得换成 Redis（`INCR` + `EXPIRE`），接口也要改成 async。
 */
export class RateLimitCounter {
  private readonly records = new Map<string, CounterRecord>();
  private readonly now: () => number;
  private readonly capacity: number;
  private sinceSweep = 0;

  constructor(options: RateLimitCounterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  /** 当前 key 是否已达上限 */
  isLimited(key: string, rule: RateLimitRule): boolean {
    const record = this.live(key);
    return record !== undefined && record.count >= rule.max;
  }

  /** 记一次，返回窗口内的累计次数 */
  record(key: string, rule: RateLimitRule): number {
    const record = this.live(key);
    if (record) {
      record.count += 1;
      return record.count;
    }

    this.sinceSweep += 1;
    if (this.sinceSweep >= SWEEP_EVERY) {
      this.sinceSweep = 0;
      this.sweep();
    }
    this.evictIfFull();
    this.records.set(key, {
      count: 1,
      resetAt: this.now() + rule.windowMs,
    });
    return 1;
  }

  /** 清掉某个 key 的计数 */
  reset(key: string): void {
    this.records.delete(key);
  }

  /** 当前记了多少条（用于诊断 / 单测容量上限） */
  get size(): number {
    return this.records.size;
  }

  /** 取一条**未过期**的计数；过期就顺手删掉 */
  private live(key: string): CounterRecord | undefined {
    const record = this.records.get(key);
    if (!record) {
      return undefined;
    }
    if (record.resetAt <= this.now()) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /** 记新 key 前腾位置：先清过期的，还满就丢最老的一条 */
  private evictIfFull(): void {
    if (this.records.size < this.capacity) {
      return;
    }
    this.sweep();
    if (this.records.size < this.capacity) {
      return;
    }
    // Map 按插入顺序迭代 → 第一个就是最老的
    const oldest = this.records.keys().next();
    if (!oldest.done) {
      this.records.delete(oldest.value);
    }
  }

  /** 清掉所有过期项 */
  private sweep(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.resetAt <= now) {
        this.records.delete(key);
      }
    }
  }
}
