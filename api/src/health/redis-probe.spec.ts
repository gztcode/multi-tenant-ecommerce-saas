import { EventEmitter } from 'node:events';

import { RedisProbe } from './redis-probe';

/**
 * Redis 探活的连接时序。
 *
 * ⚠️ **这里防的是一条真实踩过的坑**：`enableOfflineQueue: false` 的语义是
 * 「连接还没建立时，命令立刻失败」。而客户端是懒创建的——第一次探活时
 * 连接必然尚未建立，直接 `ping()` 会永远命中
 * 「Stream isn't writeable」→ **探活恒为 false，哪怕 Redis 好好的**。
 *
 * 这个 bug 在 mock 掉 RedisProbe 的单测里永远看不见，
 * 只能靠「先建连、再发命令」的时序来断言。
 */
describe('RedisProbe', () => {
  /**
   * 一个 ioredis 连接的最小替身。
   * 只需复现两件事：`status` 与 `ping()` 的行为。
   */
  class FakeRedis extends EventEmitter {
    status = 'connecting';
    pingCalls = 0;
    /** ping 之前连接是否已就绪——模拟「命令早于建连发出」 */
    failIfNotReady = true;

    ping(): Promise<string> {
      this.pingCalls += 1;
      if (this.failIfNotReady && this.status !== 'ready') {
        // ⚠️ **只表达语义，不硬编码 ioredis 的错误文案**：
        // `enableOfflineQueue: false` 的语义是「连接未就绪时命令立刻失败」。
        // 具体文案是 ioredis 内部实现，升级后可能变——测试不该依赖它。
        return Promise.reject(new Error('连接未就绪，命令被拒绝'));
      }
      return Promise.resolve('PONG');
    }

    disconnect(): void {
      this.status = 'end';
    }
  }

  function makeProbe(fake: FakeRedis): RedisProbe {
    const probe = new RedisProbe();
    // 注入替身，绕过真实的 ioredis 连接
    (probe as unknown as { client: FakeRedis }).client = fake;
    return probe;
  }

  it('连接未就绪时先等 ready 再 PING', async () => {
    const fake = new FakeRedis();
    const probe = makeProbe(fake);

    const pending = probe.check();

    // 探活发出后，ping 还没被调用——它在等连接就绪
    await new Promise((r) => setImmediate(r));
    expect(fake.pingCalls).toBe(0);

    fake.status = 'ready';
    fake.emit('ready');

    await expect(pending).resolves.toBe(true);
    expect(fake.pingCalls).toBe(1);
  });

  it('连接已就绪时直接 PING', async () => {
    const fake = new FakeRedis();
    fake.status = 'ready';
    const probe = makeProbe(fake);

    await expect(probe.check()).resolves.toBe(true);
    expect(fake.pingCalls).toBe(1);
  });

  it('连接失败时返回 false，而不是抛出去', async () => {
    const fake = new FakeRedis();
    const probe = makeProbe(fake);

    const pending = probe.check();
    await new Promise((r) => setImmediate(r));
    fake.emit('error', new Error('connect ECONNREFUSED'));

    await expect(pending).resolves.toBe(false);
  });

  it('PING 本身报错时返回 false', async () => {
    const fake = new FakeRedis();
    fake.status = 'ready';
    fake.failIfNotReady = false;
    const probe = makeProbe(fake);

    fake.ping = () => Promise.reject(new Error('Redis 挂了'));

    await expect(probe.check()).resolves.toBe(false);
  });
});
