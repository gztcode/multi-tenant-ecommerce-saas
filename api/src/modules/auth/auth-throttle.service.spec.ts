import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AuthThrottleService,
  LOGIN_ACCOUNT_RULE,
  NON_PRODUCTION_RULES,
  PRODUCTION_RULES,
} from './auth-throttle.service';

const IP_A = '203.0.113.10';
const IP_B = '198.51.100.20';
const ACCOUNT_A = 'CUSTOMER:a@example.com';
const ACCOUNT_B = 'CUSTOMER:b@example.com';
const T0 = new Date('2026-11-27T00:00:00Z').getTime();

function makeThrottle(production = true) {
  let now = T0;
  const service = new AuthThrottleService({ production, now: () => now });
  return {
    service,
    // 用箭头函数属性：`unbound-method` 不允许把对象方法解构出来单独用。
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function expect429(run: () => void, pattern: RegExp) {
  expect(run).toThrow(HttpException);
  expect(run).toThrow(pattern);
  try {
    run();
  } catch (error) {
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** 不该抛错的路径直接调用：抛了用例就红，不需要 `.not.toThrow()` */
function expectAllowed(run: () => void) {
  expect(() => run()).not.toThrow();
}

describe('AuthThrottleService：登录账号维度（原有行为保留）', () => {
  it('失败次数没到上限 → 不拦', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < LOGIN_ACCOUNT_RULE.max - 1; i += 1) {
      service.recordFailure(ACCOUNT_A);
    }

    expectAllowed(() => service.assertNotLocked(ACCOUNT_A));
  });

  it('失败到上限 → 之后直接 429', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < LOGIN_ACCOUNT_RULE.max; i += 1) {
      service.recordFailure(ACCOUNT_A);
    }

    expect429(() => service.assertNotLocked(ACCOUNT_A), /登录失败次数过多/);
  });

  it('登录成功（reset）→ 账号不再被拦', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < LOGIN_ACCOUNT_RULE.max; i += 1) {
      service.recordFailure(ACCOUNT_A);
    }
    service.reset(ACCOUNT_A);

    expectAllowed(() => service.assertNotLocked(ACCOUNT_A));
  });
});

describe('AuthThrottleService：登录 IP 维度（防密码喷洒）', () => {
  it('同一 IP 用不同账号失败到上限 → 换成从未失败过的新账号也被 429', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.loginIp.max; i += 1) {
      // 每次换一个账号：账号维度永远不到阈值，只有 IP 维度在涨
      service.recordFailure(`CUSTOMER:spray-${i}@example.com`, IP_A);
    }

    expect429(
      () => service.assertNotLocked(ACCOUNT_B, IP_A),
      /登录失败次数过多/,
    );
  });

  it('不同 IP 互不影响', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.loginIp.max; i += 1) {
      service.recordFailure(`CUSTOMER:spray-${i}@example.com`, IP_A);
    }

    expectAllowed(() => service.assertNotLocked(ACCOUNT_B, IP_B));
  });

  it('账号 reset 不会清掉 IP 计数（否则拿一个有效账号就能重置喷洒配额）', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.loginIp.max; i += 1) {
      service.recordFailure(
        i === 0 ? ACCOUNT_A : `CUSTOMER:spray-${i}@example.com`,
        IP_A,
      );
    }
    service.reset(ACCOUNT_A);

    // 账号维度已清零，IP 维度仍然命中
    expect429(
      () => service.assertNotLocked(ACCOUNT_A, IP_A),
      /登录失败次数过多/,
    );
  });

  it('账号维度与 IP 维度同时命中 → 仍然 429', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.loginIp.max; i += 1) {
      service.recordFailure(ACCOUNT_A, IP_A);
    }

    expect429(
      () => service.assertNotLocked(ACCOUNT_A, IP_A),
      /登录失败次数过多/,
    );
  });

  it('窗口过后 IP 计数归零', () => {
    const { service, advance } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.loginIp.max; i += 1) {
      service.recordFailure(`CUSTOMER:spray-${i}@example.com`, IP_A);
    }

    advance(PRODUCTION_RULES.loginIp.windowMs + 1);

    expectAllowed(() => service.assertNotLocked(ACCOUNT_B, IP_A));
  });

  it('拿不到 IP 时跳过 IP 维度（只按账号计）', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < LOGIN_ACCOUNT_RULE.max; i += 1) {
      service.recordFailure(ACCOUNT_A, undefined);
    }

    expect429(() => service.assertNotLocked(ACCOUNT_A), /登录失败次数过多/);
    expectAllowed(() => service.assertNotLocked(ACCOUNT_B));
  });
});

describe('AuthThrottleService：注册限流（IP × 动作）', () => {
  it('窗口内第 N 次注册后 → 第 N+1 次 429', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max; i += 1) {
      service.assertRegistrationAllowed('merchant', IP_A);
      service.recordRegistrationAttempt('merchant', IP_A);
    }

    expect429(
      () => service.assertRegistrationAllowed('merchant', IP_A),
      /注册请求过于频繁/,
    );
  });

  it('不同 IP 互不影响', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max; i += 1) {
      service.recordRegistrationAttempt('merchant', IP_A);
    }

    expectAllowed(() => service.assertRegistrationAllowed('merchant', IP_B));
  });

  it('不同动作互不影响：商家注册打满后，消费者注册仍可继续', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max; i += 1) {
      service.recordRegistrationAttempt('merchant', IP_A);
    }

    expectAllowed(() => service.assertRegistrationAllowed('customer', IP_A));
  });

  it('注册与登录互不影响：注册打满后，登录仍不拦', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max; i += 1) {
      service.recordRegistrationAttempt('merchant', IP_A);
    }

    expectAllowed(() => service.assertNotLocked(ACCOUNT_A, IP_A));
  });

  it('窗口过后注册计数归零', () => {
    const { service, advance } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max; i += 1) {
      service.recordRegistrationAttempt('merchant', IP_A);
    }

    advance(PRODUCTION_RULES.registerIp.windowMs + 1);

    expectAllowed(() => service.assertRegistrationAllowed('merchant', IP_A));
  });

  it('拿不到 IP 时不做注册限流（调用方无来源可归因）', () => {
    const { service } = makeThrottle();
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max + 5; i += 1) {
      service.assertRegistrationAllowed('merchant', undefined);
      service.recordRegistrationAttempt('merchant', undefined);
    }

    expectAllowed(() => service.assertRegistrationAllowed('merchant'));
  });
});

describe('AuthThrottleService：生产 / 非生产阈值', () => {
  it('非生产环境的登录 IP 阈值明显宽于生产（避免打挂本地 e2e）', () => {
    expect(NON_PRODUCTION_RULES.loginIp.max).toBeGreaterThan(
      PRODUCTION_RULES.loginIp.max,
    );
  });

  it('非生产环境的注册阈值明显宽于生产', () => {
    expect(NON_PRODUCTION_RULES.registerIp.max).toBeGreaterThan(
      PRODUCTION_RULES.registerIp.max,
    );
  });

  it('非生产环境：生产阈值次数的失败不会触发 429', () => {
    const { service } = makeThrottle(false);
    for (let i = 0; i < PRODUCTION_RULES.loginIp.max; i += 1) {
      service.recordFailure(`CUSTOMER:spray-${i}@example.com`, IP_A);
    }
    for (let i = 0; i < PRODUCTION_RULES.registerIp.max; i += 1) {
      service.recordRegistrationAttempt('merchant', IP_A);
    }

    expectAllowed(() => service.assertNotLocked(ACCOUNT_B, IP_A));
    expectAllowed(() => service.assertRegistrationAllowed('merchant', IP_A));
  });

  it('账号维度不受环境影响的默认阈值仍是 5 次 / 15 分钟', () => {
    expect(LOGIN_ACCOUNT_RULE).toEqual({ max: 5, windowMs: 15 * 60 * 1000 });
  });
});
