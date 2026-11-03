import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import type { PayoutProvider } from '../../common/payment/payout-provider.interface';
import { SandboxPayoutProvider } from '../../common/payment/sandbox-payout.provider';
import {
  DEFAULT_MOCK_WEBHOOK_SECRET,
  startMockChannelServer,
  type MockChannelServer,
} from '../../../test/mock-channel-server';
import { PaymentProviderRegistry } from './payment-provider.registry';
import type { PaymentProvider } from './payment-provider.interface';
import {
  SANDBOX_SIGNATURE_HEADER,
  SandboxPaymentProvider,
  isSandboxPaymentRegistrable,
} from './sandbox-payment.provider';

/**
 * 沙箱支付渠道的单元测试（阶段 6b Task 11）。
 *
 * ⚠️ **不依赖外部网络**：mock 服务在 `beforeAll` 里 `listen(0)`，`afterAll` 关闭。
 * ⚠️ 用例会改写 `NODE_ENV` / `PAYMENT_ENABLED_CHANNELS`，全部在 `afterEach` 恢复。
 */
describe('SandboxPaymentProvider', () => {
  let server: MockChannelServer;
  const ENV_KEYS = [
    'SANDBOX_CHANNEL_URL',
    'SANDBOX_PAYMENT_SECRET',
    'NODE_ENV',
    'PAYMENT_ENABLED_CHANNELS',
    'PAYOUT_ENABLED_CHANNELS',
  ] as const;
  let saved: Record<string, string | undefined>;

  const input = {
    referenceId: 'payment-a',
    referenceNo: 'ORDER202511030000000001',
    amount: 9900,
    subject: '测试商品',
  };

  beforeAll(async () => {
    server = await startMockChannelServer({
      webhookSecret: DEFAULT_MOCK_WEBHOOK_SECRET,
    });
  });

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    server.setScenario('success');
    server.reset();
    process.env.SANDBOX_CHANNEL_URL = server.url;
    process.env.SANDBOX_PAYMENT_SECRET = DEFAULT_MOCK_WEBHOOK_SECRET;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it('能力声明：支持退款且退款为异步（阶段 6c）', () => {
    const provider = new SandboxPaymentProvider();

    expect(provider.channel).toBe('sandbox');
    expect(provider.devOnly).toBe(true);
    expect(provider.capabilities.refund).toBe(true);
    expect(provider.capabilities.asyncRefund).toBe(true);
  });

  it('createPayment 返回可用的支付页面 URL（真的走了 HTTP）', async () => {
    const provider = new SandboxPaymentProvider();

    const result = await provider.createPayment(input);

    expect(result.providerTxnId).toBeTruthy();
    expect(typeof result.payload.url).toBe('string');
    expect(result.payload.url).toContain(server.url);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(server.calls.some((call) => call.method === 'POST')).toBe(true);
  });

  it('createPaymentMethod 返回渠道给的 token', async () => {
    const provider = new SandboxPaymentProvider();

    const { token } = await provider.createPaymentMethod({ type: 'CARD' });

    expect(token).toMatch(/^mock-pm-/);
  });

  it('parseWebhook 验签失败 → 抛 UnauthorizedException', () => {
    const provider = new SandboxPaymentProvider();
    const body = Buffer.from(
      JSON.stringify({
        eventId: 'evt-1',
        providerTxnId: 'txn-1',
        referenceNo: 'ORDER-1',
        amount: 9900,
        success: true,
      }),
    );

    expect(() =>
      provider.parseWebhook(body, { [SANDBOX_SIGNATURE_HEADER]: 'bad' }),
    ).toThrow(UnauthorizedException);
  });

  it('parseWebhook 验签通过 → 返回归一化事件', () => {
    const provider = new SandboxPaymentProvider();
    const payload = {
      eventId: 'evt-1',
      providerTxnId: 'txn-1',
      referenceNo: 'ORDER-1',
      amount: 9900,
      success: true,
    };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', DEFAULT_MOCK_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    // ⚠️ 常量值相同 → 只写一个键（两个计算键字面量会被 TS 判为重复属性）
    const event = provider.parseWebhook(body, {
      [SANDBOX_SIGNATURE_HEADER]: signature,
    });

    expect(event).toEqual({
      provider: 'sandbox',
      channel: 'sandbox',
      eventId: 'evt-1',
      providerTxnId: 'txn-1',
      referenceNo: 'ORDER-1',
      amount: 9900,
      success: true,
      // ⚠️ 阶段 6c：归一化事件必须显式带 `eventType`，缺省按 `PAYMENT`
      eventType: 'PAYMENT',
    });
  });

  it('退款：success 剧本 → SUCCESS 且带受理号', async () => {
    server.setRefundScenario('success');
    const provider = new SandboxPaymentProvider();

    const result = await provider.refund('payment-a', 9900, '测试退款');

    expect(result.status).toBe('SUCCESS');
    expect(result.refundTxnId).toBeTruthy();
  });

  it('退款：processing 剧本 → 先 PROCESSING，queryRefund 最终 SUCCESS', async () => {
    // ⚠️ **绝不允许把「受理」当「已退款」** —— 第一跳必须是 PROCESSING，
    //    只有查询/回调确认成功才允许落 REFUNDED。
    server.setRefundScenario('processing');
    const provider = new SandboxPaymentProvider();

    const first = await provider.refund('payment-a', 9900, '测试异步退款');
    expect(first.status).toBe('PROCESSING');
    expect(first.refundTxnId).toBeTruthy();

    const final = await pollRefund(provider, first.refundTxnId!);
    expect(final.status).toBe('SUCCESS');
  });

  it('退款：reject 剧本 → FAILED + definitive=true（可安全重试）', async () => {
    server.setRefundScenario('reject');
    const provider = new SandboxPaymentProvider();

    const result = await provider.refund('payment-a', 9900, '测试拒付');

    expect(result.status).toBe('FAILED');
    expect(result.status === 'FAILED' && result.definitive).toBe(true);
    expect(result.status === 'FAILED' && result.failureReason).toBeTruthy();
  });

  it('退款：unknown 剧本 → FAILED + definitive=false（不可自动重试）', async () => {
    server.setRefundScenario('unknown');
    const provider = new SandboxPaymentProvider();

    const result = await provider.refund('payment-a', 9900, '测试未知');

    expect(result.status).toBe('FAILED');
    expect(result.status === 'FAILED' && result.definitive).toBe(false);
  });

  it('queryRefund：查无此单 → UNKNOWN（绝不冒充 FAILED）', async () => {
    const provider = new SandboxPaymentProvider();

    const result = await provider.queryRefund('不存在的退款单');

    expect(result.status).toBe('UNKNOWN');
  });

  it('注册开关：非生产 + 有地址才可注册，生产环境一律不可注册', () => {
    process.env.NODE_ENV = 'development';
    expect(isSandboxPaymentRegistrable()).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(isSandboxPaymentRegistrable()).toBe(false);

    process.env.NODE_ENV = 'development';
    delete process.env.SANDBOX_CHANNEL_URL;
    expect(isSandboxPaymentRegistrable()).toBe(false);
  });

  it('生产环境注册表取 sandbox → 409（沙箱不上生产）', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake,sandbox';
    const registry = new PaymentProviderRegistry([sandboxProvider()]);

    expect(() => registry.get('sandbox')).toThrow(/仅限非生产环境/);
  });

  it('出款注册表同样在生产环境拒绝 sandbox', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYOUT_ENABLED_CHANNELS = 'sandbox';
    const registry = new PayoutProviderRegistry([payoutSandboxProvider()]);

    expect(() => registry.get('sandbox')).toThrow(/仅限非生产环境/);
  });

  /** 构造一个最小可用的沙箱支付 provider（注册表只读属性） */
  function sandboxProvider(): PaymentProvider {
    return new SandboxPaymentProvider();
  }

  /** 真实沙箱出款 provider（注册表只读属性，不需桩对象） */
  function payoutSandboxProvider(): PayoutProvider {
    return new SandboxPayoutProvider();
  }
});

/**
 * 反复查询退款直到拿到终态。
 *
 * ⚠️ 沙箱的「处理中」有真实延迟（mock 默认 120ms），这里用**真实计时器**
 *    轮询；上限给足，避免慢机器上偶发红。
 */
async function pollRefund(
  provider: SandboxPaymentProvider,
  refundTxnId: string,
) {
  let latest = await provider.queryRefund(refundTxnId);
  for (let i = 0; i < 50 && latest.status === 'PROCESSING'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    latest = await provider.queryRefund(refundTxnId);
  }
  return latest;
}
