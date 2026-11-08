import { HttpException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

import { GuestOrderController } from './guest-order.controller';
import type { OrderService } from './order.service';

/**
 * 游客订单查询的防爆破计数（阶段 11，issue #35）。
 *
 * ## 为什么这条用例必须存在
 *
 * 防爆破失败计数放在**进程内 Map** 里，而过期条目的清理**挂在查询路径上**：
 * `isBlocked()` 只在「同一个 key 被再次访问」时才删掉过期记录。
 * 于是攻击者只要一直用**不同的 orderNo** 打请求（每个都查不到 → 每个都记一条失败），
 * 这个 Map 就单调增长、永不回收 —— 未认证端点上的内存泄漏。
 *
 * 两条缺陷要分别钉住：
 * 1. **过期条目应被回收**：窗口过后，别人的请求不该让过期条目继续占着内存；
 * 2. **容量要有明确上界**：条目数不能超过配置的上限（超限淘汰最旧的）。
 *
 * ⚠️ 第 2 条不能只写「100 次失败后 size ≤ 上限」——上限远大于 100 时
 * 这条断言恒真，证明不了「超限会淘汰」。所以这里把上限调小，
 * 用超过上限的失败次数去压它。
 */

/** 控制器内部状态的最小投影（attempts 是 private，只在测试里读） */
interface AttemptRecord {
  count: number;
  firstAt: number;
}

interface InternalState {
  attempts: Map<string, AttemptRecord>;
}

function internalOf(controller: GuestOrderController): InternalState {
  return controller as unknown as InternalState;
}

/** 一个必然查不到订单的 OrderService 替身 */
function failingOrderService(): OrderService {
  return {
    guestLookup: jest.fn().mockResolvedValue(null),
  } as unknown as OrderService;
}

function requestFrom(ip: string): Request {
  return { ip } as unknown as Request;
}

/** 发一次必然失败的查询，返回抛出的异常 */
async function failLookup(
  controller: GuestOrderController,
  ip: string,
  orderNo: string,
): Promise<unknown> {
  try {
    await controller.lookup({ orderNo, phone: '13800000000' }, requestFrom(ip));
  } catch (error) {
    return error;
  }
  throw new Error('查询本应失败，但没有抛异常');
}

describe('GuestOrderController 防爆破计数（issue #35）', () => {
  const originalMaxEntries = process.env.GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES;

  afterEach(() => {
    if (originalMaxEntries === undefined) {
      delete process.env.GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES;
    } else {
      process.env.GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES = originalMaxEntries;
    }
  });

  it('⚠️ 过期条目会被回收：窗口过后，别的 key 的请求不该让它继续占着内存', async () => {
    const controller = new GuestOrderController(failingOrderService());
    const internal = internalOf(controller);

    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    // 第一个 key：失败，记一条
    await failLookup(controller, '203.0.113.1', 'GL-AAAA');
    expect(internal.attempts.size).toBe(1);

    // 时间前进 11 分钟（超过 10 分钟窗口）
    nowSpy.mockReturnValue(realNow + 11 * 60 * 1000);

    // 另一个 key 的请求：过期条目应当被顺手回收
    await failLookup(controller, '203.0.113.1', 'GL-BBBB');

    nowSpy.mockRestore();

    expect(internal.attempts.size).toBe(1);
  });

  it('⚠️ 容量有明确上界：超限后淘汰最旧的条目', async () => {
    process.env.GUEST_LOOKUP_MAX_ATTEMPT_ENTRIES = '5';
    const controller = new GuestOrderController(failingOrderService());
    const internal = internalOf(controller);

    for (let i = 0; i < 20; i += 1) {
      await failLookup(controller, '203.0.113.1', `GL-${i}`);
    }

    expect(internal.attempts.size).toBe(5);
    // 淘汰的是最旧的：留下的应该是最后 5 个
    expect([...internal.attempts.keys()]).toEqual([
      '203.0.113.1:GL-15',
      '203.0.113.1:GL-16',
      '203.0.113.1:GL-17',
      '203.0.113.1:GL-18',
      '203.0.113.1:GL-19',
    ]);
  });

  it('同一 key 失败 5 次后，第 6 次被熔断（429）', async () => {
    const controller = new GuestOrderController(failingOrderService());

    for (let i = 0; i < 5; i += 1) {
      const error = await failLookup(controller, '203.0.113.2', 'GL-CCCC');
      expect(error).toBeInstanceOf(NotFoundException);
    }

    const blocked = await failLookup(controller, '203.0.113.2', 'GL-CCCC');
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it('查询成功后计数清零', async () => {
    const orderService = {
      guestLookup: jest.fn().mockResolvedValue(null),
    } as unknown as OrderService;
    const controller = new GuestOrderController(orderService);
    const internal = internalOf(controller);

    await failLookup(controller, '203.0.113.3', 'GL-DDDD');
    expect(internal.attempts.size).toBe(1);

    (orderService.guestLookup as jest.Mock).mockResolvedValue({
      orderNo: 'GL-DDDD',
      status: 'PAID',
      totalAmount: 100,
      itemCount: 1,
      createdAt: new Date(),
      paidAt: null,
    });

    await controller.lookup(
      { orderNo: 'GL-DDDD', phone: '13800000000' },
      requestFrom('203.0.113.3'),
    );

    expect(internal.attempts.size).toBe(0);
  });
});
