import { RedisLockService } from './redis-lock.service';

/**
 * RedisLockService 的单元测试（阶段 11：跨副本互斥）。
 *
 * 用 ioredis 替身（内存 Map 模拟 SET NX PX / Lua 释放）验证契约，
 * 不依赖真实 Redis（真实 Redis 的行为由 e2e 环境兜底）。
 */

/** 模拟 SET NX PX + 比对删除的最小 Redis 替身 */
class FakeRedis {
  /** key → { value, expiresAt } */
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  /** eval 调用记录（验证释放走的是比对删除） */
  evalCalls: Array<{ key: string; token: string }> = [];
  /** 置 true 时所有命令抛错（模拟 Redis 不可用） */
  broken = false;
  private now = 0;

  set(key: string, value: string, _mode: 'PX', ttlMs: number) {
    if (this.broken) return Promise.reject(new Error('Redis down'));
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > this.now) {
      return Promise.resolve(null); // NX 未命中
    }
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
    return Promise.resolve('OK');
  }

  eval(_script: string, _numKeys: number, key: string, token: string) {
    if (this.broken) return Promise.reject(new Error('Redis down'));
    this.evalCalls.push({ key, token });
    const existing = this.store.get(key);
    if (existing && existing.value === token) {
      this.store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }

  quit() {
    return Promise.resolve();
  }

  disconnect() {
    /* no-op */
  }

  on() {
    /* 监听器挂载点 */
  }
}

function makeService(redis: FakeRedis): RedisLockService {
  return new RedisLockService(redis as never);
}

describe('RedisLockService', () => {
  it('抢到锁 → fn 执行 → 释放（Lua 比对删除）', async () => {
    const redis = new FakeRedis();
    const lock = makeService(redis);

    const outcome = await lock.withLock('reconcile', () =>
      Promise.resolve('ran'),
    );

    expect(outcome).toEqual({ acquired: true, value: 'ran' });
    expect(redis.evalCalls).toHaveLength(1);
    expect(redis.evalCalls[0].key).toBe('lock:reconcile');
    // 释放后锁已不在
    expect(redis.store.has('lock:reconcile')).toBe(false);
  });

  it('⚠️ 锁被持有时返回 acquired:false，fn 不执行', async () => {
    const redis = new FakeRedis();
    const lock = makeService(redis);

    // 手动占住锁
    await redis.set('lock:reconcile', 'other-replica', 'PX', 60_000);
    let ran = false;
    const outcome = await lock.withLock('reconcile', () => {
      ran = true;
      return Promise.resolve('x');
    });

    expect(ran).toBe(false);
    expect(outcome).toEqual({ acquired: false });
  });

  it('⚠️ fn 抛异常也会释放锁（finally），异常原样抛出', async () => {
    const redis = new FakeRedis();
    const lock = makeService(redis);

    await expect(
      lock.withLock('scan', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(redis.store.has('lock:scan')).toBe(false);
  });

  it('⚠️ 不会误删别人的锁：自己超时后别人抢到，回来时 token 不匹配删不掉', async () => {
    const redis = new FakeRedis();
    const lock = makeService(redis);

    await lock.withLock('scan', async () => {
      // 模拟：持有期间 TTL 过期（键消失），另一副本随后抢到
      // （真实场景里 SET NX 只有在原键过期消失后才可能成功）
      redis.store.delete('lock:scan');
      await redis.set('lock:scan', 'other-replica', 'PX', 60_000);
    });

    // 释放调用执行了，但 token 不匹配 → 锁还在（别人的）
    expect(redis.store.get('lock:scan')?.value).toBe('other-replica');
  });

  it('⚠️ Redis 不可用 → acquired:false（跳过本轮），绝不抛出', async () => {
    const redis = new FakeRedis();
    redis.broken = true;
    const lock = makeService(redis);

    let ran = false;
    const outcome = await lock.withLock('scan', () => {
      ran = true;
      return Promise.resolve('x');
    });

    expect(ran).toBe(false);
    expect(outcome).toEqual({ acquired: false });
  });

  it('自定义 TTL 传给 SET（PX 毫秒）', async () => {
    const redis = new FakeRedis();
    const lock = makeService(redis);
    const spy = jest.spyOn(redis, 'set');

    await lock.withLock('slow-task', () => Promise.resolve(1), {
      ttlMs: 60_000,
    });

    expect(spy).toHaveBeenCalledWith(
      'lock:slow-task',
      expect.any(String),
      'PX',
      60_000,
      'NX',
    );
  });
});
