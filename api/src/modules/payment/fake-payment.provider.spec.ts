import { FakePaymentProvider } from './fake-payment.provider';

/**
 * 假支付网关的退款剧本（阶段 6c Task 14）。
 *
 * ⚠️ **这里只验「剧本是否按声明生效」**：契约层（`test/channel-contract/`）
 *    验「任何渠道都必须满足的退款行为」，两边都要有。
 */
describe('FakePaymentProvider 退款剧本', () => {
  const originalEnabled = process.env.FAKE_PAYMENT_ENABLED;

  beforeAll(() => {
    process.env.FAKE_PAYMENT_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalEnabled === undefined) {
      delete process.env.FAKE_PAYMENT_ENABLED;
    } else {
      process.env.FAKE_PAYMENT_ENABLED = originalEnabled;
    }
  });

  it('默认：退款同步成功，并带受理号', async () => {
    const provider = new FakePaymentProvider();

    const result = await provider.refund('payment-a', 9900, '测试退款');

    expect(result.status).toBe('SUCCESS');
    expect(result.refundTxnId).toBeTruthy();
  });

  it('processing 剧本：先 PROCESSING，下一次查询返回 SUCCESS', async () => {
    // ⚠️ **「受理」不等于「已退款」** —— 第一跳必须是 PROCESSING
    const provider = new FakePaymentProvider();
    provider.armRefundScenario('processing');

    const first = await provider.refund('payment-a', 9900, '测试异步退款');
    expect(first.status).toBe('PROCESSING');
    expect(first.refundTxnId).toBeTruthy();

    const queried = await provider.queryRefund(first.refundTxnId!);
    expect(queried.status).toBe('SUCCESS');
  });

  it('reject 剧本：FAILED + definitive=true（渠道明确拒付，可重试）', async () => {
    const provider = new FakePaymentProvider();
    provider.armRefundScenario('reject');

    const result = await provider.refund('payment-a', 9900, '测试拒付');

    expect(result.status).toBe('FAILED');
    expect(result.status === 'FAILED' && result.definitive).toBe(true);
  });

  it('unknown 剧本：FAILED + definitive=false（结果未知，绝不可自动重试）', async () => {
    const provider = new FakePaymentProvider();
    provider.armRefundScenario('unknown');

    const result = await provider.refund('payment-a', 9900, '测试未知');

    expect(result.status).toBe('FAILED');
    expect(result.status === 'FAILED' && result.definitive).toBe(false);
  });

  it('剧本是一次性的：一单之后自动恢复默认成功', async () => {
    // ⚠️ 剧本残留会让后续用例莫名走进异步分支 —— 这是「显式、可断言」的底线
    const provider = new FakePaymentProvider();
    provider.armRefundScenario('reject');
    await provider.refund('payment-a', 9900, '第一单');

    const second = await provider.refund('payment-b', 9900, '第二单');

    expect(second.status).toBe('SUCCESS');
  });

  it('queryRefund：查无此单 → UNKNOWN（绝不冒充 FAILED）', async () => {
    const provider = new FakePaymentProvider();

    const result = await provider.queryRefund('不存在的退款单');

    expect(result.status).toBe('UNKNOWN');
  });

  it('开关没开：退款直接抛 503，不返回假成功', () => {
    process.env.FAKE_PAYMENT_ENABLED = 'false';
    const provider = new FakePaymentProvider();

    try {
      // ⚠️ 实现是**同步抛**（不是返回 rejected promise），所以用 `toThrow` 而不是
      //    `rejects` —— 后者在同步抛时会直接让用例失败，而不是断言到异常。
      expect(() => provider.refund('payment-a', 9900, '测试未启用')).toThrow(
        /未启用/,
      );
    } finally {
      process.env.FAKE_PAYMENT_ENABLED = 'true';
    }
  });
});
