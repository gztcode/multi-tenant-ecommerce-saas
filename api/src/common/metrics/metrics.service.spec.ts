import { MetricsService } from './metrics.service';

/**
 * MetricsService 的单元测试（阶段 11：可观测性）。
 *
 * 只测可断言的核心行为：HTTP RED 记录、卡单 gauge 的跨租户统计、
 * 队列轮询在 Redis 抖动时不炸。进程默认指标（collectDefaultMetrics）
 * 与 BullMQ 的对接不在此覆盖。
 */

/** 造一个带 `jobCountsOf` 的 QueueService 替身（队列名任意、计数相同） */
const makeQueueService = (counts: Record<string, number> | 'broken') =>
  ({
    jobCountsOf:
      counts === 'broken'
        ? jest.fn().mockRejectedValue(new Error('Redis down'))
        : jest.fn().mockResolvedValue(counts),
  }) as never;

const makePrisma = (paymentCount: number, payoutCount: number) =>
  ({
    payment: { count: jest.fn().mockResolvedValue(paymentCount) },
    payout: { count: jest.fn().mockResolvedValue(payoutCount) },
    // 卡单阈值的基准时刻改用库时钟（与应用时钟解耦，见 pollStuckWork 注释）
    databaseNow: jest.fn().mockResolvedValue(new Date('2026-11-11T00:00:00Z')),
  }) as never;

async function makeService(
  paymentCount = 0,
  payoutCount = 0,
  queueCounts: Record<string, number> = { waiting: 2, active: 1 },
): Promise<MetricsService> {
  const service = new MetricsService(
    makePrisma(paymentCount, payoutCount),
    makeQueueService(queueCounts),
  );
  await service.poll();
  return service;
}

describe('MetricsService', () => {
  it('recordHttpRequest 记录计数与耗时（路由模板作为 label）', async () => {
    const service = await makeService();

    service.recordHttpRequest('POST', '/api/v1/orders', 201, 0.123);
    service.recordHttpRequest('POST', '/api/v1/orders', 500, 0.5);

    const text = await service.registry.metrics();
    expect(text).toContain(
      'ecommerce_http_requests_total{method="POST",route="/api/v1/orders",status="201"} 1',
    );
    expect(text).toContain(
      'ecommerce_http_requests_total{method="POST",route="/api/v1/orders",status="500"} 1',
    );
    expect(text).toContain('ecommerce_http_request_duration_seconds');
  });

  it('⚠️ 卡单 gauge：REFUNDING / PROCESSING 超阈值的单数进指标', async () => {
    const service = await makeService(2, 1);

    const text = await service.registry.metrics();
    expect(text).toContain('ecommerce_payments_refunding_stuck 2');
    expect(text).toContain('ecommerce_payouts_processing_stuck 1');
  });

  it('⚠️ 卡单统计必须跨租户（count 调用不经过租户过滤即可用）', async () => {
    // MetricsService 的 poll() 把 count 包在 platformScope 里跑。
    // 这里没法直接断言 AsyncLocalStorage 的内容，退而断言：
    // 没有租户上下文时 count 也能被调用并返回（租户扩展在有上下文时
    // 会自动附加 tenantId——那套行为由 tenant-isolation e2e 守护）。
    const service = await makeService(0, 0);
    const text = await service.registry.metrics();
    expect(text).toContain('ecommerce_payments_refunding_stuck 0');
    expect(text).toContain('ecommerce_payouts_processing_stuck 0');
  });

  it('队列深度按 queue × state 展开', async () => {
    const service = await makeService(0, 0, { waiting: 7, failed: 3 });

    const text = await service.registry.metrics();
    expect(text).toContain(
      'ecommerce_queue_jobs{queue="payment-webhook",state="waiting"} 7',
    );
    expect(text).toContain(
      'ecommerce_queue_jobs{queue="payment-webhook",state="failed"} 3',
    );
  });

  it('⚠️ 队列抖动（jobCountsOf 拒绝）不炸轮询，本轮只缺队列指标', async () => {
    const service = new MetricsService(
      makePrisma(0, 0),
      makeQueueService('broken'),
    );

    await expect(service.poll()).resolves.toBeUndefined();
    const text = await service.registry.metrics();
    // gauge 的 HELP/TYPE 行恒存在；断言的是**样本行**（带 label）不存在
    expect(text).not.toMatch(/ecommerce_queue_jobs\{/);
  });
});
