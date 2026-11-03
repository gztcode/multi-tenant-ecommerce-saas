/**
 * 支付渠道契约：`fake` 与 `sandbox` 各跑一遍（阶段 6b Task 12）。
 *
 * ⚠️ **认证/落库不在契约层** —— 这里只验渠道本身（签名、幂等、能力门控），
 *    端到端的支付链路由 e2e 覆盖。
 */
import { createHmac } from 'node:crypto';
import {
  DEFAULT_MOCK_WEBHOOK_SECRET,
  startMockChannelServer,
  type MockChannelServer,
} from '../mock-channel-server';
import {
  FAKE_SIGNATURE_HEADER,
  FakePaymentProvider,
} from '../../src/modules/payment/fake-payment.provider';
import {
  SANDBOX_SIGNATURE_HEADER,
  SandboxPaymentProvider,
} from '../../src/modules/payment/sandbox-payment.provider';
import type { NormalizedWebhookEvent } from '../../src/modules/payment/payment-provider.interface';
import { runPaymentProviderContract } from './payment-provider.contract';

const FAKE_SECRET = 'contract-fake-payment-secret';

describe('支付渠道契约：fake', () => {
  const originalEnabled = process.env.FAKE_PAYMENT_ENABLED;
  const originalSecret = process.env.FAKE_PAYMENT_SECRET;

  beforeAll(() => {
    // ⚠️ 假网关默认关闭（安全边界），契约要跑通必须先显式打开
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;
  });

  afterAll(() => {
    if (originalEnabled === undefined) {
      delete process.env.FAKE_PAYMENT_ENABLED;
    } else {
      process.env.FAKE_PAYMENT_ENABLED = originalEnabled;
    }
    if (originalSecret === undefined) {
      delete process.env.FAKE_PAYMENT_SECRET;
    } else {
      process.env.FAKE_PAYMENT_SECRET = originalSecret;
    }
  });

  runPaymentProviderContract({
    name: 'fake',
    createProvider: () => new FakePaymentProvider(),
    // ⚠️ 假网关的报文用 `orderNo`（历史字段名），归一化后才叫 `referenceNo`
    buildWebhookRaw: (event: NormalizedWebhookEvent) =>
      Buffer.from(
        JSON.stringify({
          eventId: event.eventId,
          providerTxnId: event.providerTxnId,
          orderNo: event.referenceNo,
          amount: event.amount,
          success: event.success,
        }),
        'utf8',
      ),
    signWebhook: (rawBody: Buffer) => ({
      [FAKE_SIGNATURE_HEADER]: createHmac('sha256', FAKE_SECRET)
        .update(rawBody)
        .digest('hex'),
    }),
    // ⚠️ 假网关能演异步退款（`armRefundScenario`），所以要跑异步用例 ——
    //    跳过它等于让「asyncRefund=true」这个能力声明没人验。
    supportsAsyncRefund: true,
    armRefund: (provider, scenario) => {
      (provider as FakePaymentProvider).armRefundScenario(scenario);
    },
  });
});

describe('支付渠道契约：sandbox', () => {
  let server: MockChannelServer;
  const originalUrl = process.env.SANDBOX_CHANNEL_URL;
  const originalSecret = process.env.SANDBOX_PAYMENT_SECRET;

  beforeAll(async () => {
    server = await startMockChannelServer({ scenario: 'success' });
    process.env.SANDBOX_CHANNEL_URL = server.url;
    process.env.SANDBOX_PAYMENT_SECRET = DEFAULT_MOCK_WEBHOOK_SECRET;
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
    if (originalSecret === undefined) {
      delete process.env.SANDBOX_PAYMENT_SECRET;
    } else {
      process.env.SANDBOX_PAYMENT_SECRET = originalSecret;
    }
    await server.close();
  });

  runPaymentProviderContract({
    name: 'sandbox',
    createProvider: () => new SandboxPaymentProvider(),
    buildWebhookRaw: (event: NormalizedWebhookEvent) =>
      Buffer.from(
        JSON.stringify({
          eventId: event.eventId,
          providerTxnId: event.providerTxnId,
          referenceNo: event.referenceNo,
          amount: event.amount,
          success: event.success,
        }),
        'utf8',
      ),
    // ⚠️ 与 mock 渠道投递回调时的签名算法保持一致（HMAC-SHA256，覆盖原始字节）
    signWebhook: (rawBody: Buffer) => ({
      [SANDBOX_SIGNATURE_HEADER]: createHmac(
        'sha256',
        DEFAULT_MOCK_WEBHOOK_SECRET,
      )
        .update(rawBody)
        .digest('hex'),
    }),
    supportsAsyncRefund: true,
    // 剧本注入在 mock 服务侧：provider 只是 HTTP 客户端，无从「自己决定」
    armRefund: (_provider, scenario) => {
      server.setRefundScenario(scenario);
    },
  });
});
