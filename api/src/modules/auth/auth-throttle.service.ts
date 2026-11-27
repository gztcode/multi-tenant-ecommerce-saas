import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import { RateLimitCounter, RateLimitRule } from './rate-limit-counter';

/** 同一账号在窗口内允许的登录失败次数（账号维度，防单账号爆破） */
export const LOGIN_ACCOUNT_RULE: RateLimitRule = {
  max: 5,
  windowMs: 15 * 60 * 1000,
};

/** 注册动作：商家注册与消费者注册分开计数 */
export type RegisterAction = 'merchant' | 'customer';

/** 按 IP 的维度：登录与注册各一份 */
export interface AuthThrottleRules {
  loginIp: RateLimitRule;
  registerIp: RateLimitRule;
}

/**
 * 生产环境的按 IP 阈值。
 *
 * - 登录 30 次失败 / 15 分钟：正常用户敲错几次密码够用，密码喷洒（同一 IP
 *   换大量账号只试少数几个密码）会被很快拦下；
 * - 注册 20 次 / 小时：一次 argon2 约 100ms CPU + 64MB 内存，不设限时
 *   单 IP 就能把进程打满。
 */
export const PRODUCTION_RULES: AuthThrottleRules = {
  loginIp: { max: 30, windowMs: 15 * 60 * 1000 },
  registerIp: { max: 20, windowMs: 60 * 60 * 1000 },
};

/**
 * 非生产环境的阈值：宽到本地开发与 e2e 基本不可能触发
 * （e2e 的注册调用最多的一个套件也只有几十次）。
 */
export const NON_PRODUCTION_RULES: AuthThrottleRules = {
  loginIp: { max: 3_000, windowMs: 15 * 60 * 1000 },
  registerIp: { max: 1_000, windowMs: 60 * 60 * 1000 },
};

/** 按环境挑规则：只有生产环境收紧 */
export function resolveThrottleRules(production: boolean): AuthThrottleRules {
  return production ? PRODUCTION_RULES : NON_PRODUCTION_RULES;
}

export interface AuthThrottleOptions {
  /** 是否生产环境；默认读 `process.env.NODE_ENV === 'production'` */
  production?: boolean;
  /** 注入时钟（毫秒时间戳），默认 `Date.now`；单测用它跨窗口 */
  now?: () => number;
  /** 直接给定规则（优先级最高，单测用） */
  rules?: AuthThrottleRules;
}

/** 账号维度的 key 前缀 —— 与 IP 维度分开，互相不会撞 key */
const ACCOUNT_PREFIX = 'acct:';
const LOGIN_IP_PREFIX = 'ip-login:';
const REGISTER_IP_PREFIX = 'ip-register:';

/** 判定超限时的提示；文案里带上窗口长度，用户知道等多久 */
function tooManyRequests(message: string, windowMs: number): HttpException {
  // ⚠️ `@nestjs/common` **没有** `TooManyRequestsException`，
  //    429 要自己用 `HttpException` + `HttpStatus.TOO_MANY_REQUESTS` 抛。
  return new HttpException(
    `${message}，请 ${Math.ceil(windowMs / 60_000)} 分钟后再试`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * 认证接口限流（安全审计 M2）。
 *
 * ## 现在按什么计数
 *
 * - **账号维度（登录）**：`scope:email`，5 次失败 / 15 分钟。防单账号爆破。
 *   登录成功会清掉它。
 * - **IP 维度（登录）**：同一个 IP 的失败次数，生产 30 次 / 15 分钟。
 *   防密码喷洒（换大量账号、每个只试几个密码）—— 这种攻击下账号维度
 *   永远到不了阈值。**登录成功不清 IP 计数**，否则攻击者拿一个自己的
 *   有效账号就能无限重置喷洒配额。
 * - **IP × 动作维度（注册）**：商家注册、消费者注册各 20 次 / 小时。
 *   注册路径进来就是 `argon2.hash`（约 100ms CPU + 64MB 内存），
 *   不限流等于把 CPU 和内存白送给攻击者。
 *
 * 任一维度命中即 429。
 *
 * ## 为什么现在能按 IP 限了
 *
 * 登录走 NextAuth BFF，BFF 在服务端调 `/auth/login`，本服务看到的对端是
 * BFF 容器。但 `app.module.ts` 设了 `trust proxy = 1`，`req.ip` 取的是
 * X-Forwarded-For 最右项，而 BFF（`storefront/src/lib/api-client.ts` 的
 * `currentClientIp()`）会把入站 XFF 最右项转发过来 —— 所以 `req.ip`
 * 是真实客户端 IP，按 IP 限流在生产可用。
 * 拿不到 IP 时（本地直连、单测）跳过 IP 维度，只按账号 / 动作计。
 *
 * ## 已知限制（都写在明面上，别当成「已经防死了」）
 *
 * ⚠️ **计数在进程内存里**：多副本部署时上限按副本数放大
 *    （compose 现在只有 1 个 api 容器，nginx 上游也只有 1 个）。
 *    真要上多副本，把 `RateLimitCounter` 换成 Redis（`INCR` + `EXPIRE`），
 *    本类的公开方法要一起改成 async，调用方跟着 `await` ——
 *    不变的只有限流语义本身。
 * ⚠️ **账号锁定能被反过来用**：攻击者连错 5 次就能锁掉某个正常用户
 *    15 分钟。这是账号级限流的固有代价，所以阈值取得保守。
 * ⚠️ **阈值在非生产环境放得很宽**（见 `NON_PRODUCTION_RULES`），
 *    不要拿本地环境验证限流效果。
 */
@Injectable()
export class AuthThrottleService {
  private readonly counter: RateLimitCounter;
  private readonly rules: AuthThrottleRules;

  constructor(@Optional() options: AuthThrottleOptions = {}) {
    const production =
      options.production ?? process.env.NODE_ENV === 'production';
    this.rules = options.rules ?? resolveThrottleRules(production);
    this.counter = new RateLimitCounter({ now: options.now });
  }

  /**
   * 登录前检查：账号或 IP 任一维度已达上限就抛 429。
   *
   * ⚠️ **锁住时不做密码校验**：argon2 是有意做慢的，
   *    继续校验等于把 CPU 送给攻击者。
   */
  assertNotLocked(accountKey: string, ip?: string): void {
    if (
      this.counter.isLimited(
        `${ACCOUNT_PREFIX}${accountKey}`,
        LOGIN_ACCOUNT_RULE,
      )
    ) {
      throw tooManyRequests('登录失败次数过多', LOGIN_ACCOUNT_RULE.windowMs);
    }
    if (
      ip &&
      this.counter.isLimited(`${LOGIN_IP_PREFIX}${ip}`, this.rules.loginIp)
    ) {
      throw tooManyRequests('登录失败次数过多', this.rules.loginIp.windowMs);
    }
  }

  /** 记一次登录失败（账号维度 + IP 维度） */
  recordFailure(accountKey: string, ip?: string): void {
    this.counter.record(`${ACCOUNT_PREFIX}${accountKey}`, LOGIN_ACCOUNT_RULE);
    if (ip) {
      this.counter.record(`${LOGIN_IP_PREFIX}${ip}`, this.rules.loginIp);
    }
  }

  /**
   * 登录成功 → 清掉**账号**维度计数。
   *
   * 故意不清 IP 维度：IP 计数记的是「这个来源的失败总量」，
   * 拿一个自己的有效账号登录成功不该能重置它。
   */
  reset(accountKey: string): void {
    this.counter.reset(`${ACCOUNT_PREFIX}${accountKey}`);
  }

  /** 注册前检查：该 IP 在该动作上是否已超限 */
  assertRegistrationAllowed(action: RegisterAction, ip?: string): void {
    if (!ip) {
      return;
    }
    if (
      this.counter.isLimited(
        `${REGISTER_IP_PREFIX}${action}:${ip}`,
        this.rules.registerIp,
      )
    ) {
      throw tooManyRequests('注册请求过于频繁', this.rules.registerIp.windowMs);
    }
  }

  /**
   * 记一次注册尝试。
   *
   * 记在密码哈希**之前**且成功的注册也计数：要防的是「单 IP 持续消耗
   * argon2」，注册成功同样花掉了 CPU 和内存。
   */
  recordRegistrationAttempt(action: RegisterAction, ip?: string): void {
    if (!ip) {
      return;
    }
    this.counter.record(
      `${REGISTER_IP_PREFIX}${action}:${ip}`,
      this.rules.registerIp,
    );
  }
}
