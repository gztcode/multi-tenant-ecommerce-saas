import { ServiceUnavailableException } from '@nestjs/common';
import {
  FAKE_PAYOUT_CHANNEL,
  FakePayoutProvider,
  isFakePayoutEnabled,
} from './fake-payout.provider';

/**
 * 假出款网关的单元测试。
 *
 * ⚠️ **`process.env` 要在每个用例前后恢复** ——
 *    `isFakePayoutEnabled()` 直接读 env，不恢复会污染同文件的后续用例。
 */
describe('FakePayoutProvider', () => {
  const original = process.env.FAKE_PAYOUT_ENABLED;

  beforeEach(() => {
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYOUT_ENABLED = 'true';
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env.FAKE_PAYOUT_ENABLED;
    } else {
      process.env.FAKE_PAYOUT_ENABLED = original;
    }
  });

  const input = {
    referenceId: 'payout-a',
    referenceNo: 'PAY202508010000000001',
    amount: 8500,
    account: {
      accountName: '张三',
      bankName: '测试银行',
      accountNo: '6222000000000000',
    },
    attempt: 1,
  };

  it('开关没开 → execute 抛 503（不是返回一个假成功）', async () => {
    process.env.FAKE_PAYOUT_ENABLED = 'false';
    const provider = new FakePayoutProvider();

    await expect(provider.execute(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('默认成功：返回 SUCCESS、渠道交易号与金额', async () => {
    const provider = new FakePayoutProvider();

    const result = await provider.execute(input);

    expect(result.status).toBe('SUCCESS');
    expect(result.providerTxnId).toBeTruthy();
    // ⚠️ **金额要原样带回** —— 护栏 X3 的渠道金额核对靠它
    expect(result.amount).toBe(8500);
  });

  it('armScenario：接下来 N 次失败，第 N+1 次成功', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 2 });

    const first = await provider.execute(input);
    expect(first.status).toBe('FAILED');
    expect(first.failureReason).toContain('第 1 次尝试');
    // ⚠️ **失败也要给渠道交易号**（真实渠道失败时也会给）
    expect(first.providerTxnId).toBeTruthy();

    const second = await provider.execute({ ...input, attempt: 2 });
    expect(second.status).toBe('FAILED');
    expect(second.failureReason).toContain('第 2 次尝试');

    const third = await provider.execute({ ...input, attempt: 3 });
    expect(third.status).toBe('SUCCESS');
    expect(provider.remainingFailures()).toBe(0);
  });

  it('armScenario：金额偏移只生效一次（用来造渠道金额核对不通过）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 0, amountOffset: 1 });

    const first = await provider.execute(input);
    // ⚠️ **金额与请求不一致** —— worker 应当据此落 FAILED（护栏 X3）
    expect(first.status).toBe('SUCCESS');
    expect(first.amount).toBe(8501);

    // ⚠️ **偏移只生效一次** —— 第二次恢复成请求金额
    const second = await provider.execute(input);
    expect(second.amount).toBe(8500);
  });

  it('失败路径：不应用金额偏移，也不消耗偏移', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1, amountOffset: 1 });

    const failed = await provider.execute(input);
    expect(failed.status).toBe('FAILED');
    // ⚠️ **失败时金额原样带回** —— 金额偏移只对成功路径有意义
    expect(failed.amount).toBe(8500);

    // ⚠️ **偏移没被消耗** —— 偏移是留给成功路径的
    const succeeded = await provider.execute({ ...input, attempt: 2 });
    expect(succeeded.status).toBe('SUCCESS');
    expect(succeeded.amount).toBe(8501);
  });

  it('armScenario：入参非有限数（NaN / Infinity）当作 0，不会静默吞掉失败剧本', async () => {
    const provider = new FakePayoutProvider();
    // ⚠️ **HTTP body 能原样传进来**（内联对象类型不过 ValidationPipe）
    provider.armScenario({ failTimes: Number.NaN });

    const result = await provider.execute(input);
    // ⚠️ **NaN 被兜底成 0 → 不失败**（而不是「NaN 让 failTimes>0 恒假、
    //    看起来成功、实则剧本根本没生效」的那种假绿）
    expect(result.status).toBe('SUCCESS');
    expect(provider.remainingFailures()).toBe(0);

    const infinite = new FakePayoutProvider();
    infinite.armScenario({ failTimes: Number.POSITIVE_INFINITY });
    expect(infinite.remainingFailures()).toBe(0);
    await expect(infinite.execute(input)).resolves.toMatchObject({
      status: 'SUCCESS',
    });
  });

  it('isFakePayoutEnabled：读的是 FAKE_PAYOUT_ENABLED，与支付开关独立', () => {
    process.env.FAKE_PAYOUT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_ENABLED = 'false';
    expect(isFakePayoutEnabled()).toBe(true);

    process.env.FAKE_PAYOUT_ENABLED = 'false';
    expect(isFakePayoutEnabled()).toBe(false);
  });

  it('渠道名固定', () => {
    expect(new FakePayoutProvider().channel).toBe(FAKE_PAYOUT_CHANNEL);
  });
});
