import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** 同一账号在窗口内允许的失败次数 */
const MAX_FAILURES = 5;

/** 失败计数的窗口（毫秒）—— 到期归零，也用���锁定时长 */
const WINDOW_MS = 15 * 60 * 1000;

/** 进程内最多记多少个账号 —— 防「用一堆不存在的邮箱把内存撑爆」 */
const MAX_TRACKED_ACCOUNTS = 20_000;

/** 每记多少次失败顺手清一次过期项（把清理成本摊平） */
const SWEEP_EVERY = 50;

/** 一条失败计数 */
interface FailureRecord {
  /** 窗口内累计的失败次数 */
  count: number;
  /** 计数归零的时刻（毫秒时间戳） */
  resetAt: number;
}

/**
 * 登录失败限流（审计 P2-3）。
 *
 * ## 为什么按**账号**限，而不是按 IP
 *
 * 前端的登录走 NextAuth BFF：BFF 在**服务端**调本服务的 `/auth/login`，
 * 所以本服务看到的 IP 全是 BFF 容器的 IP ——
 * 按 IP 限会把所有用户一起限死，而真正要防的「一个账号被喷」反而拦不住。
 *
 * ## 局限（都写在明面上，别当成「已经防死了」）
 *
 * ⚠️ **计数在进程内存里**：多副本部署时上限按副本数放大
 *    （compose 现在只有 1 个 api 容器，nginx 上游也只有 1 个）。
 *    真要上多副本，把这里的计数挪到 Redis（`INCR` + `EXPIRE`）即可，
 *    对外的三个方法不用变。
 * ⚠️ **锁定是按账号的**：攻击者能拿它反过来锁掉正常用户
 *    （连错 5 次就锁 15 分钟）。这是账号级限流的固有代价，
 *    所以阈值与窗口都取得保守，避免误伤。
 */
@Injectable()
export class LoginThrottleService {
  private readonly failures = new Map<string, FailureRecord>();
  private sinceSweep = 0;

  /**
   * 账号已被锁住就抛 429。
   *
   * ⚠️ **锁住时不做密码校验**：argon2 是有意做慢的，
   *    继续校验等于把 CPU 送给攻击者。
   */
  assertNotLocked(key: string): void {
    const record = this.live(key);
    if (record && record.count >= MAX_FAILURES) {
      // ⚠️ `@nestjs/common` **没有** `TooManyRequestsException`，
      //    429 要自己用 `HttpException` + `HttpStatus.TOO_MANY_REQUESTS` 抛。
      throw new HttpException(
        `登录失败次数过多，请 ${Math.ceil(WINDOW_MS / 60_000)} 分钟后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** 记一次失败 */
  recordFailure(key: string): void {
    const record = this.live(key);
    if (record) {
      record.count += 1;
      return;
    }

    this.sinceSweep += 1;
    if (this.sinceSweep >= SWEEP_EVERY) {
      this.sinceSweep = 0;
      this.sweep();
    }
    this.evictIfFull();
    this.failures.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  }

  /** 登录成功 → 清掉计数（用户改对了密码就不该继续被限） */
  reset(key: string): void {
    this.failures.delete(key);
  }

  /** 取一条**未过期**的计数；过期就顺手删掉 */
  private live(key: string): FailureRecord | undefined {
    const record = this.failures.get(key);
    if (!record) {
      return undefined;
    }
    if (record.resetAt <= Date.now()) {
      this.failures.delete(key);
      return undefined;
    }
    return record;
  }

  /**
   * 记新账号前腾位置：先清过期的，还满就丢最老的一条。
   *
   * ⚠️ **必须有这个上限**：攻击者可以用一堆**不存在的**邮箱把 Map 撑爆
   *    （账号不存在时没有行可以落库，计数只能放在这里）。
   */
  private evictIfFull(): void {
    if (this.failures.size < MAX_TRACKED_ACCOUNTS) {
      return;
    }
    this.sweep();
    if (this.failures.size < MAX_TRACKED_ACCOUNTS) {
      return;
    }
    // Map 按插入顺序迭代 → 第一个就是最老的
    const oldest = this.failures.keys().next();
    if (!oldest.done) {
      this.failures.delete(oldest.value);
    }
  }

  /** 清掉所有过期项 */
  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.failures) {
      if (record.resetAt <= now) {
        this.failures.delete(key);
      }
    }
  }
}
