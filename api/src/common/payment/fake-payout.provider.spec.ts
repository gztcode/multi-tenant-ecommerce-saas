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

  it('queryPayout：按 referenceNo 查到真实状态（成功）', async () => {
    const provider = new FakePayoutProvider();
    await provider.execute(input);

    const result = await provider.queryPayout({
      referenceNo: input.referenceNo,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.amount).toBe(8500);
    expect(result.paidAt).toBeInstanceOf(Date);
  });

  it('queryPayout：按 providerTxnId 查到真实状态（失败）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    const failed = await provider.execute(input);

    const result = await provider.queryPayout({
      providerTxnId: failed.providerTxnId,
    });

    // ⚠️ **必须返回 FAILED 而不是 SUCCESS** —— 恒返回 SUCCESS 会让
    //    解卡核实闸永远放行 → 解卡重打功能全废
    expect(result.status).toBe('FAILED');
  });

  it('queryPayout：查不到 → UNKNOWN（不是 SUCCESS，也不是 FAILED）', async () => {
    const provider = new FakePayoutProvider();

    const result = await provider.queryPayout({ referenceNo: '不存在的单号' });

    // ⚠️ **「查不到」≠「渠道说没打」** —— 调用方据此进入下一层核实
    expect(result.status).toBe('UNKNOWN');
  });

  it('queryPayout：同一单多次尝试 → 返回最后一次的状态', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    await provider.execute(input);
    await provider.execute({ ...input, attempt: 2 });

    const result = await provider.queryPayout({
      referenceNo: input.referenceNo,
    });

    expect(result.status).toBe('SUCCESS');
  });

  it('queryPayout：重试后按旧交易号仍能查到那一次的状态', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    const first = await provider.execute(input); // 第一次：失败
    await provider.execute({ ...input, attempt: 2 }); // 第二次：成功

    // ⚠️ **按第一次的交易号查 → 仍是失败** —— 交易号锁定的是那一次尝试，
    //    不是「这张单当前的状态」。两个语义不能混。
    const result = await provider.queryPayout({
      providerTxnId: first.providerTxnId,
    });
    expect(result.status).toBe('FAILED');
  });

  it('queryPayout：两个键都传 → 交易号优先（精确键优于模糊键）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    const failed = await provider.execute(input); // 第一次：失败
    await provider.execute({ ...input, attempt: 2 }); // 第二次：成功

    // ⚠️ **交易号优先** —— 交易号是唯一且不可变的幂等键，
    //    referenceNo 是一对多（重试会产出多条）→ 精确键的结论更权威。
    const byBoth = await provider.queryPayout({
      providerTxnId: failed.providerTxnId,
      referenceNo: input.referenceNo,
    });
    expect(byBoth.status).toBe('FAILED');

    // ⚠️ **精确键查不到要回退到模糊键** —— 回退是加强，不是削弱
    const fallback = await provider.queryPayout({
      providerTxnId: '不存在的交易号',
      referenceNo: input.referenceNo,
    });
    expect(fallback.status).toBe('SUCCESS');
  });

  it('listPayouts：返回时间窗内的全部尝试（含失败那次）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    await provider.execute(input);
    await provider.execute({ ...input, attempt: 2 });

    const records = await provider.listPayouts({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });

    // ⚠️ **两条都要在** —— 少了失败那次，对账就测不出重试场景
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.status).sort()).toEqual(['FAILED', 'SUCCESS']);
    expect(records[0].referenceNo).toBe(input.referenceNo);
  });

  it('listPayouts：时间窗外的记录不返回（左闭右开）', async () => {
    const provider = new FakePayoutProvider();
    await provider.execute(input);

    const records = await provider.listPayouts({
      from: new Date(Date.now() + 60_000),
      to: new Date(Date.now() + 120_000),
    });

    expect(records).toHaveLength(0);
  });

  it('listPayouts：窗口边界是左闭右开（含起点、不含终点）', async () => {
    const provider = new FakePayoutProvider();
    await provider.execute(input);
    const executedAt = (
      await provider.queryPayout({
        referenceNo: input.referenceNo,
      })
    ).paidAt!;

    // ⚠️ **起点含** —— `executedAt` 恰好等于 from → 应该在结果里
    const includeStart = await provider.listPayouts({
      from: executedAt,
      to: new Date(executedAt.getTime() + 1000),
    });
    expect(includeStart).toHaveLength(1);

    // ⚠️ **终点不含** —— `executedAt` 恰好等于 to → 不应该在结果里
    const includeEnd = await provider.listPayouts({
      from: new Date(executedAt.getTime() - 1000),
      to: executedAt,
    });
    expect(includeEnd).toHaveLength(0);
  });

  it('listPayouts：网关未启用 → 抛错（不是返回空数组）', async () => {
    process.env.FAKE_PAYOUT_ENABLED = 'false';
    try {
      const provider = new FakePayoutProvider();

      // ⚠️ **返回空数组会被当成「渠道说这一笔没有」** → 全部本地已付单变 E 类
      await expect(
        provider.listPayouts({
          from: new Date(0),
          to: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      process.env.FAKE_PAYOUT_ENABLED = 'true';
    }
  });
});
