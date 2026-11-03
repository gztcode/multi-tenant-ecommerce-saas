import { ServiceUnavailableException } from '@nestjs/common';
import {
  FAKE_PAYOUT_CHANNEL,
  FakePayoutProvider,
  isFakePayoutEnabled,
} from './fake-payout.provider';
import { CHANNEL_LIST_PAGE_SIZE } from './payout.constants';

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

  it('开关没开 → submit 抛 503（不是返回一个假成功）', async () => {
    process.env.FAKE_PAYOUT_ENABLED = 'false';
    const provider = new FakePayoutProvider();

    await expect(provider.submit(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('默认成功：返回 SUCCESS、渠道交易号与金额', async () => {
    const provider = new FakePayoutProvider();

    const result = await provider.submit(input);

    expect(result.status).toBe('SUCCESS');
    expect(result.providerTxnId).toBeTruthy();
    // ⚠️ **金额要原样带回** —— 护栏 X3 的渠道金额核对靠它
    expect(result.amount).toBe(8500);
  });

  it('⚠️ 同一 referenceId 重复 submit → 渠道侧幂等，不产生两条成功记录', async () => {
    const provider = new FakePayoutProvider();

    const first = await provider.submit(input);
    // ⚠️ **重放同一笔**（渠道重复投递 / worker 重复消费）
    const second = await provider.submit({ ...input, attempt: 2 });

    // ⚠️ **结论必须一致** —— 同一个渠道交易号、同一笔金额
    expect(second.status).toBe('SUCCESS');
    expect(second.providerTxnId).toBe(first.providerTxnId);
    expect(second.amount).toBe(first.amount);

    // ⚠️ **关键：渠道侧只有一条成功流水** —— 两条成功记录会变成对账里的
    //    D 类（渠道多一笔）假差异，还会让运营以为打了两次钱
    const records = await provider.listPayouts({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('SUCCESS');
  });

  it('⚠️ 失败的 referenceId 不挡重试（失败 = 钱没打出去）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ definitiveFailureTimes: 1 });

    const first = await provider.submit(input);
    expect(first.status).toBe('FAILED');

    // ⚠️ **失败后允许再次提交** —— 幂等只锁「已成功 / 处理中」，不锁失败
    const second = await provider.submit({ ...input, attempt: 2 });
    expect(second.status).toBe('SUCCESS');
    expect(second.providerTxnId).not.toBe(first.providerTxnId);
  });

  it('armScenario：接下来 N 次失败（结果未知，definitive=false），第 N+1 次成功', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 2 });

    const first = await provider.submit(input);
    expect(first).toHaveProperty('status', 'FAILED');
    // ⚠️ **结果未知** —— 不能据此自动重试（钱可能已经打出去）
    expect(first).toHaveProperty('definitive', false);
    expect(first).toHaveProperty(
      'failureReason',
      expect.stringContaining('第 1 次尝试'),
    );
    // ⚠️ **失败也要给渠道交易号**（真实渠道失败时也会给）
    expect(first).toHaveProperty(
      'providerTxnId',
      expect.stringContaining('fake-pay-'),
    );

    const second = await provider.submit({ ...input, attempt: 2 });
    expect(second).toHaveProperty('status', 'FAILED');
    expect(second).toHaveProperty('definitive', false);
    expect(second).toHaveProperty(
      'failureReason',
      expect.stringContaining('第 2 次尝试'),
    );

    const third = await provider.submit({ ...input, attempt: 3 });
    expect(third.status).toBe('SUCCESS');
    expect(provider.remainingFailures()).toBe(0);
  });

  it('armScenario：definitiveFailureTimes —— 确定的失败（definitive=true，可安全重试）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ definitiveFailureTimes: 2 });

    const first = await provider.submit(input);
    expect(first).toHaveProperty('status', 'FAILED');
    expect(first).toHaveProperty('definitive', true);
    expect(first).toHaveProperty(
      'failureReason',
      expect.stringContaining('第 1 次尝试'),
    );
    expect(first).toHaveProperty(
      'providerTxnId',
      expect.stringContaining('fake-pay-'),
    );

    const second = await provider.submit({ ...input, attempt: 2 });
    expect(second).toHaveProperty('status', 'FAILED');
    expect(second).toHaveProperty('definitive', true);
    expect(second).toHaveProperty(
      'failureReason',
      expect.stringContaining('第 2 次尝试'),
    );

    const third = await provider.submit({ ...input, attempt: 3 });
    expect(third.status).toBe('SUCCESS');
    expect(provider.remainingDefinitiveFailures()).toBe(0);
  });

  it('armScenario：两种失败剧本可叠加，各自的 definitive 各自正确', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ definitiveFailureTimes: 1, failTimes: 1 });

    // ⚠️ **确定的失败先出** —— 剧本是叠加的，不是二选一
    const first = await provider.submit(input);
    expect(first).toHaveProperty('status', 'FAILED');
    expect(first).toHaveProperty('definitive', true);

    // ⚠️ **接着是结果未知的失败** —— 两种语义不能混
    const second = await provider.submit({ ...input, attempt: 2 });
    expect(second).toHaveProperty('status', 'FAILED');
    expect(second).toHaveProperty('definitive', false);
  });

  it('armScenario：processingTimes —— 第一次返回 PROCESSING，随后 queryPayout 最终返回 SUCCESS', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ processingTimes: 1 });

    // ⚠️ **提交时只是「处理中」，不是成功**
    const first = await provider.submit(input);
    expect(first.status).toBe('PROCESSING');
    expect(first.amount).toBe(8500);
    expect(first.providerTxnId).toBeTruthy();

    // ⚠️ **轮询第一次就出结果**（异步渠道最终成功）
    const queried = await provider.queryPayout({
      providerTxnId: first.providerTxnId,
    });
    expect(queried.status).toBe('SUCCESS');
    expect(queried.amount).toBe(8500);
    expect(queried.paidAt).toBeInstanceOf(Date);

    // ⚠️ **之后再查保持稳定**，不会跳回 PROCESSING
    const again = await provider.queryPayout({
      providerTxnId: first.providerTxnId,
    });
    expect(again.status).toBe('SUCCESS');
  });

  it('queryPayout：PROCESSING 单已转成功 → paidAt 有值，再查不会回落', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ processingTimes: 1 });
    const first = await provider.submit(input);

    // ⚠️ **异步渠道的「最终状态」由轮询产出** —— 查一次就转成 SUCCESS
    const result = await provider.queryPayout({
      providerTxnId: first.providerTxnId,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.paidAt).toBeInstanceOf(Date);
  });

  it('armScenario：金额偏移只生效一次（用来造渠道金额核对不通过）', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 0, amountOffset: 1 });

    const first = await provider.submit(input);
    // ⚠️ **金额与请求不一致** —— worker 应当据此落 FAILED（护栏 X3）
    expect(first.status).toBe('SUCCESS');
    expect(first.amount).toBe(8501);

    // ⚠️ **偏移只生效一次** —— 下一笔（不同 referenceId）恢复成请求金额
    const second = await provider.submit({
      ...input,
      referenceId: 'payout-b',
      referenceNo: 'PAY202508010000000002',
    });
    expect(second.amount).toBe(8500);
  });

  it('失败路径：不应用金额偏移，也不消耗偏移', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1, amountOffset: 1 });

    const failed = await provider.submit(input);
    expect(failed.status).toBe('FAILED');
    // ⚠️ **失败时金额原样带回** —— 金额偏移只对成功路径有意义
    expect(failed.amount).toBe(8500);

    // ⚠️ **偏移没被消耗** —— 偏移是留给成功路径的
    const succeeded = await provider.submit({ ...input, attempt: 2 });
    expect(succeeded.status).toBe('SUCCESS');
    expect(succeeded.amount).toBe(8501);
  });

  it('armScenario：入参非有限数（NaN / Infinity）当作 0，不会静默吞掉失败剧本', async () => {
    const provider = new FakePayoutProvider();
    // ⚠️ **HTTP body 能原样传进来**（内联对象类型不过 ValidationPipe）
    provider.armScenario({
      failTimes: Number.NaN,
      definitiveFailureTimes: Number.NaN,
      processingTimes: Number.NaN,
    });

    const result = await provider.submit(input);
    // ⚠️ **NaN 被兜底成 0 → 不失败**（而不是「NaN 让 failTimes>0 恒假、
    //    看起来成功、实则剧本根本没生效」的那种假绿）
    expect(result.status).toBe('SUCCESS');
    expect(provider.remainingFailures()).toBe(0);
    expect(provider.remainingDefinitiveFailures()).toBe(0);

    const infinite = new FakePayoutProvider();
    infinite.armScenario({
      failTimes: Number.POSITIVE_INFINITY,
      definitiveFailureTimes: Number.POSITIVE_INFINITY,
      processingTimes: Number.POSITIVE_INFINITY,
    });
    expect(infinite.remainingFailures()).toBe(0);
    expect(infinite.remainingDefinitiveFailures()).toBe(0);
    await expect(infinite.submit(input)).resolves.toMatchObject({
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
    await provider.submit(input);

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
    const failed = await provider.submit(input);

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
    await provider.submit(input);
    await provider.submit({ ...input, attempt: 2 });

    const result = await provider.queryPayout({
      referenceNo: input.referenceNo,
    });

    expect(result.status).toBe('SUCCESS');
  });

  it('queryPayout：重试后按旧交易号仍能查到那一次的状态', async () => {
    const provider = new FakePayoutProvider();
    provider.armScenario({ failTimes: 1 });
    const first = await provider.submit(input); // 第一次：失败
    await provider.submit({ ...input, attempt: 2 }); // 第二次：成功

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
    const failed = await provider.submit(input); // 第一次：失败
    await provider.submit({ ...input, attempt: 2 }); // 第二次：成功

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
    await provider.submit(input);
    await provider.submit({ ...input, attempt: 2 });

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
    await provider.submit(input);

    const records = await provider.listPayouts({
      from: new Date(Date.now() + 60_000),
      to: new Date(Date.now() + 120_000),
    });

    expect(records).toHaveLength(0);
  });

  it('listPayouts：窗口边界是左闭右开（含起点、不含终点）', async () => {
    const provider = new FakePayoutProvider();
    await provider.submit(input);
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

  /**
   * 造 N 笔不同业务单号的流水（分页用例用）。
   *
   * ⚠️ **必须用不同的 `referenceNo`** —— 假网关按 `referenceNo` 分组存流水，
   *    同一单号的多条记录会落在同一个分组里，顺序断言就不稳。
   */
  const seedPayouts = async (
    provider: FakePayoutProvider,
    count: number,
  ): Promise<void> => {
    for (let i = 0; i < count; i++) {
      await provider.submit({
        ...input,
        referenceId: `payout-${i}`,
        referenceNo: `PAY20250801000000000${i}`,
        amount: 8500 + i,
      });
    }
  };

  /** 覆盖分页用的时间窗（宽松到必然包含所有记录） */
  const window = {
    from: new Date(Date.now() - 60_000),
    to: new Date(Date.now() + 60_000),
  };

  it('listPayouts：不传 page / pageSize → 返回窗口内全部记录（旧行为不变）', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts(window);

    // ⚠️ **回归保护** —— 旧调用方（核实服务、测试里的 mock）不传这两个参数，
    //    行为不能被分页改坏
    expect(records).toHaveLength(3);
  });

  it('listPayouts：page=1, pageSize=2 → 返回前 2 条', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({
      ...window,
      page: 1,
      pageSize: 2,
    });

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.referenceNo)).toEqual([
      'PAY202508010000000000',
      'PAY202508010000000001',
    ]);
  });

  it('listPayouts：page=2, pageSize=2 → 返回第 3、4 条（与第 1 页拼起来等于全量）', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 4);

    const firstPage = await provider.listPayouts({
      ...window,
      page: 1,
      pageSize: 2,
    });
    const secondPage = await provider.listPayouts({
      ...window,
      page: 2,
      pageSize: 2,
    });
    const all = await provider.listPayouts(window);

    expect(secondPage.map((r) => r.referenceNo)).toEqual([
      'PAY202508010000000002',
      'PAY202508010000000003',
    ]);
    // ⚠️ **翻页不能漏记录、不能重记录，顺序也不能乱** ——
    //    这是调用方「循环翻页直到翻空」能拿到全量的前提
    expect([...firstPage, ...secondPage]).toEqual(all);
  });

  it('listPayouts：页码超出范围 → 返回空数组（调用方据此停止翻页）', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({
      ...window,
      page: 3,
      pageSize: 2,
    });

    // ⚠️ **空数组是翻页的结束信号** —— 不能抛错，也不能返回最后一页
    expect(records).toEqual([]);
  });

  it('listPayouts：page=0 → 等价于 page=1（不是空数组）', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({
      ...window,
      page: 0,
      pageSize: 2,
    });

    // ⚠️ **防 `slice` 负下标** —— `page = 0` 会算出负的 start，
    //    `slice` 从末尾数 → 静默返回空数组 → 调用方以为「没流水了」
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.referenceNo)).toEqual([
      'PAY202508010000000000',
      'PAY202508010000000001',
    ]);
  });

  it('listPayouts：page=NaN → 等价于 page=1（不是空数组）', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({
      ...window,
      page: Number.NaN,
      pageSize: 2,
    });

    // ⚠️ **`Math.max(1, NaN)` 的结果仍然是 `NaN`** —— 不能指望它做下界保护。
    //    `start = NaN` → `slice(NaN, NaN)` 静默返回空数组 → 调用方以为
    //    「渠道说这个时间窗没有流水」→ 所有本地已付单全变成 E 类差异（假告警）。
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.referenceNo)).toEqual([
      'PAY202508010000000000',
      'PAY202508010000000001',
    ]);
  });

  it('listPayouts：pageSize=NaN → 回落到默认 500（窗口内不足则一次性返回全部）', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({
      ...window,
      page: 1,
      pageSize: Number.NaN,
    });

    expect(records).toHaveLength(3);
  });

  it('listPayouts：只传 page 不传 pageSize → 用默认 pageSize（500），不足则一次性返回全部', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({ ...window, page: 1 });

    expect(records).toHaveLength(3);
    expect(CHANNEL_LIST_PAGE_SIZE).toBe(500);
  });

  it('listPayouts：只传 pageSize 不传 page → 等价于 page=1，返回第一页', async () => {
    const provider = new FakePayoutProvider();
    await seedPayouts(provider, 3);

    const records = await provider.listPayouts({ ...window, pageSize: 2 });

    expect(records.map((r) => r.referenceNo)).toEqual([
      'PAY202508010000000000',
      'PAY202508010000000001',
    ]);
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
