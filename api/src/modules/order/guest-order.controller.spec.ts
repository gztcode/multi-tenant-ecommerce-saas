import { HttpException, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import type { Request } from 'express';

import { RedisLockService } from '../../common/lock/redis-lock.service';
import { GuestLookupThrottleService } from './guest-lookup-throttle.service';
import { GuestOrderController } from './guest-order.controller';
import type { OrderService } from './order.service';

/**
 * 游客订单查询的防爆破计数（P1 修复后）。
 *
 * ## 为什么改成断言 Redis
 *
 * 计数从「进程内 Map」迁到 Redis 之后，Map 的两条上界（时间回收 + 容量淘汰）
 * 随之消失——过期交给 TTL、容量交给 Redis 自己，**进程内不再有任何容器**，
 * issue #35 的内存泄漏入口结构性消失。所以这里不能再断言「Map 的 size」
 * （Map 已经不存在了），改成直接断言 **Redis 里的 key、值与 TTL**。
 *
 * ⚠️ **不许用 mock 把 Redis 糊弄过去**：要证明的恰恰是
 *    「INCR 原子 + 只在首次设 TTL + 过期后重新计数」，
 *    mock 掉 Redis 就等于把要验证的东西删了。
 *    跑这条用例需要可用的 Redis（`api/.env` 的 `REDIS_URL`，
 *    默认 `redis://localhost:16380`；CI 的 api job 已带 redis service）。
 *
 * ## 覆盖的用例
 *
 * 1. 同一来源对同一订单号失败 5 次后被熔断（429）；
 * 2. **不同来源互不影响**——P1 的核心：一个坏客户端不能锁死真实客户的查单入口；
 * 3. 查询成功后计数清零（Redis 里的 key 被删掉）；
 * 4. 窗口过期后重新计数（TTL ≈ 10 分钟；过期后从 1 重新数）。
 */

/** 本文件用到的订单号统一前缀，清理 Redis key 时只按它匹配，不误伤别人的 key */
const TEST_ORDER_PREFIX = 'GL-TEST-';

describe('GuestOrderController 防爆破计数（Redis 版）', () => {
  let redis: Redis;
  let controller: GuestOrderController;
  let guestLookup: jest.Mock;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:16380');
    try {
      await redis.ping();
    } catch (error) {
      throw new Error(
        `本用例需要可用的 Redis（${process.env.REDIS_URL ?? 'redis://localhost:16380'}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    guestLookup = jest.fn().mockResolvedValue(null);
    const lockService = new RedisLockService(redis);
    controller = new GuestOrderController(
      { guestLookup } as unknown as OrderService,
      new GuestLookupThrottleService(lockService),
    );
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(() => {
    guestLookup.mockReset().mockResolvedValue(null);
  });

  afterEach(async () => {
    // 只清本文件自己的 key（订单号前缀唯一），不碰 Redis 里的其他计数
    const keys = await redis.keys(
      `guestlookup:attempts:*${TEST_ORDER_PREFIX}*`,
    );
    if (keys.length > 0) await redis.del(...keys);
  });

  /** 找出本文件某个订单号对应的 Redis key（订单号只含字母数字与连字符，编码后不变） */
  async function keysOf(orderNo: string): Promise<string[]> {
    return redis.keys(`guestlookup:attempts:*${orderNo}`);
  }

  /** 一个必然查不到订单的查询，返回抛出的异常 */
  async function failLookup(ip: string, orderNo: string): Promise<unknown> {
    try {
      await controller.lookup({ orderNo, phone: '13800000000' }, {
        ip,
      } as unknown as Request);
    } catch (error) {
      return error;
    }
    throw new Error('查询本应失败，但没有抛异常');
  }

  it('同一来源对同一订单号失败 5 次后，第 6 次被熔断（429）', async () => {
    const orderNo = `${TEST_ORDER_PREFIX}BLOCK`;
    for (let i = 0; i < 5; i += 1) {
      const error = await failLookup('203.0.113.10', orderNo);
      expect(error).toBeInstanceOf(NotFoundException);
    }

    const blocked = await failLookup('203.0.113.10', orderNo);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);

    // Redis 侧：计数停在 5（熔断后不再累加）
    const keys = await keysOf(orderNo);
    expect(keys).toHaveLength(1);
    expect(await redis.get(keys[0])).toBe('5');
  });

  it('不同来源互不影响：一个来源被熔断，另一个来源仍能正常查单', async () => {
    const orderNo = `${TEST_ORDER_PREFIX}ISOLATION`;

    for (let i = 0; i < 5; i += 1) {
      await failLookup('203.0.113.11', orderNo);
    }
    const blocked = await failLookup('203.0.113.11', orderNo);
    expect((blocked as HttpException).getStatus()).toBe(429);

    // 另一个来源不受影响：第一次失败仍是 404「订单不存在或信息不匹配」
    const other = await failLookup('203.0.113.12', orderNo);
    expect(other).toBeInstanceOf(NotFoundException);
    expect((other as NotFoundException).getStatus()).toBe(404);
  });

  it('查询成功后计数清零（Redis 里的 key 被删掉）', async () => {
    const ip = '203.0.113.13';
    const orderNo = `${TEST_ORDER_PREFIX}RESET`;

    await failLookup(ip, orderNo);
    await failLookup(ip, orderNo);
    const keys = await keysOf(orderNo);
    expect(keys).toHaveLength(1);
    expect(await redis.get(keys[0])).toBe('2');

    guestLookup.mockResolvedValue({
      orderNo,
      status: 'PAID',
      totalAmount: 100,
      itemCount: 1,
      createdAt: new Date(),
      paidAt: null,
    });

    await controller.lookup({ orderNo, phone: '13800000000' }, {
      ip,
    } as unknown as Request);

    expect(await redis.exists(keys[0])).toBe(0);
  });

  it('窗口过期后重新计数（TTL 是生产的 10 分钟；过期后从 1 重新数）', async () => {
    const ip = '203.0.113.14';
    const orderNo = `${TEST_ORDER_PREFIX}EXPIRE`;

    for (let i = 0; i < 5; i += 1) {
      await failLookup(ip, orderNo);
    }
    const keys = await keysOf(orderNo);
    expect(keys).toHaveLength(1);
    const key = keys[0];

    // Redis 侧：TTL 存在，且就是生产的 10 分钟窗口
    // ⚠️ 不为了测试缩短生产常量——过期用「直接操纵 Redis 的 TTL」来模拟
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);

    // 模拟窗口走完
    await redis.pexpire(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 过期后不再是熔断状态
    const error = await failLookup(ip, orderNo);
    expect(error).toBeInstanceOf(NotFoundException);

    // Redis 侧：计数从 1 重新开始（新窗口的第一次失败）
    expect(await redis.get(key)).toBe('1');
  });
});
