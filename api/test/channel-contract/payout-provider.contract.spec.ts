/**
 * 出款渠道契约：`fake` 与 `sandbox` 各跑一遍（阶段 6b Task 12）。
 *
 * ⚠️ 失败注入形状不同，由各自的 spec 提供：
 *    - `fake`：进程内剧本 `armScenario`；
 *    - `sandbox`：mock 服务的场景开关 `setScenario`。
 */
import {
  startMockChannelServer,
  type MockChannelServer,
} from '../mock-channel-server';
import { FakePayoutProvider } from '../../src/common/payment/fake-payout.provider';
import { SandboxPayoutProvider } from '../../src/common/payment/sandbox-payout.provider';
import type { PayoutProvider } from '../../src/common/payment/payout-provider.interface';
import { runPayoutProviderContract } from './payout-provider.contract';

describe('出款渠道契约：fake', () => {
  const originalEnabled = process.env.FAKE_PAYOUT_ENABLED;

  beforeAll(() => {
    // ⚠️ 假出款网关默认关闭（安全边界），契约要跑通必须先显式打开
    process.env.FAKE_PAYOUT_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalEnabled === undefined) {
      delete process.env.FAKE_PAYOUT_ENABLED;
    } else {
      process.env.FAKE_PAYOUT_ENABLED = originalEnabled;
    }
  });

  runPayoutProviderContract({
    name: 'fake',
    createProvider: () => new FakePayoutProvider(),
    // ⚠️ 能力声明是同步 → 异步用例必须跳过（见契约文件的说明）
    supportsAsync: false,
    injectDefinitiveFailure: (provider: PayoutProvider) => {
      if (!(provider instanceof FakePayoutProvider)) {
        throw new Error('fake 契约拿到的是别的实现');
      }
      provider.armScenario({ definitiveFailureTimes: 1 });
    },
  });
});

describe('出款渠道契约：sandbox', () => {
  let server: MockChannelServer;
  const originalUrl = process.env.SANDBOX_CHANNEL_URL;

  beforeAll(async () => {
    server = await startMockChannelServer({
      scenario: 'success',
      processingDelayMs: 60,
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
    await server.close();
  });

  runPayoutProviderContract({
    name: 'sandbox',
    createProvider: () => new SandboxPayoutProvider(),
    // ⚠️ 沙箱能力声明 `asyncPayout: true`，异步用例必须真跑
    supportsAsync: true,
    injectDefinitiveFailure: () => {
      server.setScenario('reject');
    },
    injectProcessing: () => {
      server.setScenario('processing');
    },
  });
});
