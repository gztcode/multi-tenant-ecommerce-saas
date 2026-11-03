import { ServiceUnavailableException } from '@nestjs/common';
import {
  MOCK_SCENARIOS,
  startMockChannelServer,
  type MockChannelServer,
} from '../../../test/mock-channel-server';
import { SandboxPayoutProvider } from './sandbox-payout.provider';

/**
 * 沙箱出款渠道的单元测试（阶段 6b Task 11）。
 *
 * ⚠️ **不依赖外部网络**：每个套件自己起 `listen(0)` 的 mock 服务，
 *    在 `afterAll` 关闭；地址写进 `SANDBOX_CHANNEL_URL`。
 * ⚠️ 超时预算在测试里调小，避免真等 3 秒。
 */
describe('SandboxPayoutProvider', () => {
  let server: MockChannelServer;
  const originalUrl = process.env.SANDBOX_CHANNEL_URL;
  const originalAsync = process.env.SANDBOX_PAYOUT_ASYNC;

  const input = {
    referenceId: 'payout-a',
    referenceNo: 'PAY202511030000000001',
    amount: 8500,
    account: {
      accountName: '张三',
      bankName: '测试银行',
      accountNo: '6222000000000000',
    },
    attempt: 1,
  };

  beforeAll(async () => {
    server = await startMockChannelServer({
      scenario: 'success',
      processingDelayMs: 60,
      timeoutDelayMs: 500,
    });
    process.env.SANDBOX_CHANNEL_URL = server.url;
  });

  beforeEach(() => {
    server.setScenario('success');
    server.reset();
  });

  afterAll(async () => {
    if (originalUrl === undefined) {
      delete process.env.SANDBOX_CHANNEL_URL;
    } else {
      process.env.SANDBOX_CHANNEL_URL = originalUrl;
    }
    if (originalAsync === undefined) {
      delete process.env.SANDBOX_PAYOUT_ASYNC;
    } else {
      process.env.SANDBOX_PAYOUT_ASYNC = originalAsync;
    }
    await server.close();
  });

  it('能力声明：异步出款、可按 referenceNo 查询', () => {
    const provider = new SandboxPayoutProvider();

    expect(provider.channel).toBe('sandbox');
    expect(provider.provider).toBe('sandbox');
    expect(provider.devOnly).toBe(true);
    expect(provider.capabilities.asyncPayout).toBe(true);
    expect(provider.capabilities.queryByReferenceNo).toBe(true);
  });

  it('success 场景：submit 返回 SUCCESS 且金额一致', async () => {
    const provider = new SandboxPayoutProvider();

    const result = await provider.submit(input);

    expect(result.status).toBe('SUCCESS');
    expect(result.status === 'SUCCESS' && result.amount).toBe(8500);
    expect(server.calls.some((call) => call.path === '/payout')).toBe(true);
  });

  it('reject 场景：返回 FAILED + definitive=true（可安全重试）', async () => {
    server.setScenario('reject');
    const provider = new SandboxPayoutProvider();

    const result = await provider.submit(input);

    expect(result.status).toBe('FAILED');
    expect(result.status === 'FAILED' && result.definitive).toBe(true);
    expect(result.status === 'FAILED' && result.failureReason).toContain(
      '拒付',
    );
  });

  it('timeout 场景：HTTP 超时 → 抛异常（调用方按结果未知处理）', async () => {
    server.setScenario('timeout');
    // ⚠️ 超时预算调小到 100ms，避免用例真等几秒
    const provider = new SandboxPayoutProvider(100);

    await expect(provider.submit(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('amount_mismatch 场景：返回的金额与请求不同（留给调用方核对）', async () => {
    server.setScenario('amount_mismatch');
    const provider = new SandboxPayoutProvider();

    const result = await provider.submit(input);

    expect(result.status).toBe('SUCCESS');
    expect(result.status === 'SUCCESS' && result.amount).not.toBe(8500);
  });

  it('processing 场景：先返回 PROCESSING，随后 queryPayout 转 SUCCESS', async () => {
    server.setScenario('processing');
    const provider = new SandboxPayoutProvider();

    const submitResult = await provider.submit(input);
    expect(submitResult.status).toBe('PROCESSING');

    // 等 mock 侧的「处理中」时长过去
    await new Promise((resolve) => setTimeout(resolve, 120));

    const queryResult = await provider.queryPayout({
      referenceNo: input.referenceNo,
    });
    expect(queryResult.status).toBe('SUCCESS');
    expect(queryResult.amount).toBe(8500);
  });

  it('queryPayout 查无此单 → UNKNOWN（不是 FAILED）', async () => {
    const provider = new SandboxPayoutProvider();

    const result = await provider.queryPayout({ referenceNo: 'NOT-EXIST' });

    expect(result.status).toBe('UNKNOWN');
  });

  it('listPayouts 分页契约 A：每页给满 pageSize', async () => {
    const provider = new SandboxPayoutProvider();
    for (let index = 0; index < 3; index++) {
      await provider.submit({
        ...input,
        referenceId: `payout-list-${index}`,
        referenceNo: `PAY-LIST-${index}`,
        amount: 1000 + index,
      });
    }

    const records = await provider.listPayouts({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      page: 1,
      pageSize: 2,
    });

    expect(records).toHaveLength(2);
  });

  it('listPayouts 分页契约 B：NaN / Infinity 回落默认值，不返回空数组', async () => {
    const provider = new SandboxPayoutProvider();
    await provider.submit(input);

    const records = await provider.listPayouts({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      page: NaN,
      pageSize: Infinity,
    });

    expect(records.length).toBeGreaterThan(0);
  });

  it('未配置 SANDBOX_CHANNEL_URL → 抛 503（不是静默成功）', async () => {
    const saved = process.env.SANDBOX_CHANNEL_URL;
    delete process.env.SANDBOX_CHANNEL_URL;
    try {
      const provider = new SandboxPayoutProvider();
      await expect(provider.submit(input)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      process.env.SANDBOX_CHANNEL_URL = saved;
    }
  });

  it('场景名单覆盖五类剧本', () => {
    expect([...MOCK_SCENARIOS].sort()).toEqual(
      ['amount_mismatch', 'processing', 'reject', 'success', 'timeout'].sort(),
    );
  });
});
