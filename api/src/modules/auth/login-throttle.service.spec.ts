import { HttpException, HttpStatus } from '@nestjs/common';
import { LoginThrottleService } from './login-throttle.service';

const KEY = 'CUSTOMER:a@example.com';

describe('LoginThrottleService（审计 P2-3）', () => {
  let throttle: LoginThrottleService;

  beforeEach(() => {
    throttle = new LoginThrottleService();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-05T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('失败次数没到上限 → 不拦', () => {
    for (let i = 0; i < 4; i += 1) {
      throttle.recordFailure(KEY);
    }

    expect(() => throttle.assertNotLocked(KEY)).not.toThrow();
  });

  it('失败 5 次 → 之后直接 429', () => {
    for (let i = 0; i < 5; i += 1) {
      throttle.recordFailure(KEY);
    }

    expect(() => throttle.assertNotLocked(KEY)).toThrow(HttpException);
    expect(() => throttle.assertNotLocked(KEY)).toThrow(/登录失败次数过多/);
    try {
      throttle.assertNotLocked(KEY);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it('换个账号 → 不受影响', () => {
    for (let i = 0; i < 5; i += 1) {
      throttle.recordFailure(KEY);
    }

    expect(() =>
      throttle.assertNotLocked('CUSTOMER:b@example.com'),
    ).not.toThrow();
  });

  it('登录成功（reset）→ 不再被拦', () => {
    for (let i = 0; i < 5; i += 1) {
      throttle.recordFailure(KEY);
    }
    throttle.reset(KEY);

    expect(() => throttle.assertNotLocked(KEY)).not.toThrow();
  });

  it('窗口过了 → 计数归零', () => {
    for (let i = 0; i < 5; i += 1) {
      throttle.recordFailure(KEY);
    }
    jest.setSystemTime(new Date('2026-11-05T00:20:00Z'));

    expect(() => throttle.assertNotLocked(KEY)).not.toThrow();
  });
});
