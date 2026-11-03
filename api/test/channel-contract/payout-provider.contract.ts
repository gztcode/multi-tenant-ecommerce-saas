/**
 * 出款渠道共享契约（阶段 6b Task 12，设计 §8.3）。
 *
 * ## 它是什么
 *
 * 「任何出款渠道都必须满足的行为」写一次，对每个实现（`fake` / `sandbox` /
 * 将来的真渠道）各跑一遍。它是新渠道的**准入闸**：契约不过 = 不允许接入。
 *
 * ## 为什么失败注入由调用方提供
 *
 * 契约不知道某个渠道怎么造「明确拒付」「处理中」——
 * 假网关用进程内剧本（`armScenario`），沙箱用 mock 服务的场景开关（`setScenario`）。
 * 这两件事形状不同，所以契约只声明「我需要一次这样的失败」，由 spec 供给。
 *
 * ⚠️ **不要在契约里迁就实现** —— 契约要能抓出真实缺陷；
 *    确实不适用的单条用 `it.skip` 写清原因，而不是放宽断言。
 */
import { randomUUID } from 'node:crypto';
import type {
  PayoutExecuteInput,
  PayoutProvider,
} from '../../src/common/payment/payout-provider.interface';

export interface PayoutProviderContractOptions {
  /** 渠道名（只用于测试名与错误信息） */
  name: string;
  /** 每个用例拿到一个新实例，避免用例之间串状态 */
  createProvider: () => PayoutProvider;
  /**
   * 渠道是否支持异步出款。
   *
   * ⚠️ 必须与 `provider.capabilities.asyncPayout` 一致；为 `false` 时
   *    异步用例 `it.skip`（同步渠道提交即终态，没有「稍后查询出结论」这回事）。
   */
  supportsAsync: boolean;
  /** 让**下一次** `submit` 返回「渠道明确拒付」（`FAILED` + `definitive: true`） */
  injectDefinitiveFailure: (provider: PayoutProvider) => void | Promise<void>;
  /**
   * 让**下一次** `submit` 返回 `PROCESSING`，稍后由 `queryPayout` 给出终态。
   * ⚠️ 仅 `supportsAsync === true` 时必须提供。
   */
  injectProcessing?: (provider: PayoutProvider) => void | Promise<void>;
}

/** 一份典型的打款入参（金额用整数分） */
function samplePayoutInput(
  overrides: Partial<PayoutExecuteInput> = {},
): PayoutExecuteInput {
  return {
    referenceId: randomUUID(),
    referenceNo: `PAY${Date.now()}${Math.floor(Math.random() * 10_000)}`,
    amount: 8500,
    account: {
      accountName: '契约测试户名',
      bankName: '契约测试银行',
      accountNo: '6222000000000000',
    },
    attempt: 1,
    ...overrides,
  };
}

/** 覆盖「刚发生」到「一小时后」的时间窗（渠道侧流水都在窗内） */
function recentWindow(): { from: Date; to: Date } {
  return {
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 60 * 1000),
  };
}

/** 造 `count` 笔成功流水，返回它们的入参 */
async function seedSuccessfulPayouts(
  provider: PayoutProvider,
  count: number,
): Promise<PayoutExecuteInput[]> {
  const inputs: PayoutExecuteInput[] = [];
  for (let index = 0; index < count; index++) {
    const input = samplePayoutInput();
    const result = await provider.submit(input);
    // ⚠️ 造数必须真的成功，否则后面分页用例会拿「没流水」当过
    expect(result.status).toBe('SUCCESS');
    inputs.push(input);
  }
  return inputs;
}

/** 等一小会儿（沙箱的 `processing` 剧本要时间推进） */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑一轮出款契约（8 条 + 1 条异步）。
 *
 * @param options 渠道实例工厂与失败注入钩子
 */
export function runPayoutProviderContract(
  options: PayoutProviderContractOptions,
): void {
  describe(`出款渠道契约（${options.name}）`, () => {
    let provider: PayoutProvider;

    // ⚠️ **每个用例一个新实例** —— 渠道可能带进程内状态（幂等表、计数器），
    //    复用同一个实例会让前一个用例的造数影响后一个。
    beforeEach(() => {
      provider = options.createProvider();
    });

    it('submit 幂等：同 referenceId 两次提交不产生两条成功记录', async () => {
      const input = samplePayoutInput();

      const first = await provider.submit(input);
      const second = await provider.submit(input);

      expect(first.status).toBe('SUCCESS');
      expect(second.status).toBe('SUCCESS');
      // ⚠️ 同一笔单必须返回同一个渠道交易号 —— 换号意味着渠道侧多了一笔流水
      expect(first.status === 'SUCCESS' && first.providerTxnId).toBe(
        second.status === 'SUCCESS' && second.providerTxnId,
      );

      const records = await provider.listPayouts(recentWindow());
      const successForThis = records.filter(
        (record) =>
          record.referenceNo === input.referenceNo &&
          record.status.toUpperCase() === 'SUCCESS',
      );
      expect(successForThis).toHaveLength(1);
    });

    it('SUCCESS 必须带 amount 且与请求一致', async () => {
      const input = samplePayoutInput({ amount: 12_345 });

      const result = await provider.submit(input);

      expect(result.status).toBe('SUCCESS');
      if (result.status !== 'SUCCESS') {
        return;
      }
      expect(typeof result.amount).toBe('number');
      // ⚠️ 金额必须是「渠道实际打出去的钱」——不一致说明渠道侧打错了金额
      expect(result.amount).toBe(input.amount);
    });

    it('FAILED 必须带 definitive 布尔', async () => {
      await options.injectDefinitiveFailure(provider);

      const result = await provider.submit(samplePayoutInput());

      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') {
        return;
      }
      // ⚠️ **必须显式给布尔**：缺省会被调用方当成「结果未知」→ 不能自动重试。
      //    渠道明确拒付却漏了它，单子会卡到人工，资金效率白白损失。
      expect(typeof result.definitive).toBe('boolean');
      // ⚠️ 本用例注入的是「渠道明确拒付」，所以必须是 `true`（可安全重试）
      expect(result.definitive).toBe(true);
    });

    it('queryPayout 查无此单 → UNKNOWN', async () => {
      const result = await provider.queryPayout({
        referenceNo: `不存在的单号-${randomUUID()}`,
      });

      // ⚠️ **查不到 ≠ 渠道说没打** —— 只能回 UNKNOWN，不能回 FAILED
      expect(result.status).toBe('UNKNOWN');
    });

    it('queryPayout 绝不把 UNKNOWN 映射成 FAILED', async () => {
      // 三种「问不出结论」的查询：只有交易号、只有单号、两个都给但都不存在
      const queries = [
        { providerTxnId: `不存在的交易号-${randomUUID()}` },
        { referenceNo: `不存在的单号-${randomUUID()}` },
        {
          providerTxnId: `不存在的交易号-${randomUUID()}`,
          referenceNo: `不存在的单号-${randomUUID()}`,
        },
      ];

      for (const query of queries) {
        const result = await provider.queryPayout(query);
        // ⚠️ 把 UNKNOWN 当 FAILED 会让「钱可能已打出去」的单被重试成重复打款；
        //    即使实现回 FAILED，也**绝不能**带 definitive=true。
        if (result.status === 'FAILED') {
          expect(result.definitive).not.toBe(true);
        }
        expect(result.status).not.toBe('SUCCESS');
      }
    });

    it('listPayouts 契约 A：非末页必须给满 pageSize 条', async () => {
      // 4 条流水 + 每页 3 条 → 第 1 页必须给满 3 条，第 2 页剩 1 条
      await seedSuccessfulPayouts(provider, 4);
      const window = recentWindow();

      const firstPage = await provider.listPayouts({
        ...window,
        page: 1,
        pageSize: 3,
      });
      const secondPage = await provider.listPayouts({
        ...window,
        page: 2,
        pageSize: 3,
      });

      // ⚠️ **忽略 pageSize 的实现必须被测红**：调用方靠「本页不满」判断到底，
      //    渠道若把每页压小（或忽略参数给全量），第 1 页就不满 → 调用方提前收工
      //    → 静默只拿到一部分流水，对账结果全错且不报错。
      expect(firstPage).toHaveLength(3);
      expect(secondPage).toHaveLength(1);
    });

    it('listPayouts 契约 B：NaN / Infinity 回落默认值，不返回空数组', async () => {
      await seedSuccessfulPayouts(provider, 2);
      const window = recentWindow();

      const nanPage = await provider.listPayouts({
        ...window,
        page: Number.NaN,
        pageSize: Number.NaN,
      });
      const infinityPage = await provider.listPayouts({
        ...window,
        page: Number.POSITIVE_INFINITY,
        pageSize: Number.POSITIVE_INFINITY,
      });

      // ⚠️ **绝不能返回空数组**：调用方会把空数组当成「渠道说这段时间没有流水」
      //    → 所有本地已付单全变成对账差异（假告警）。
      expect(nanPage.length).toBeGreaterThan(0);
      expect(infinityPage.length).toBeGreaterThan(0);
      expect(nanPage).toHaveLength(2);
      expect(infinityPage).toHaveLength(2);
    });

    it('listPayouts 分页拼接：第 1 页 + 第 2 页 = 全量，不重不漏', async () => {
      await seedSuccessfulPayouts(provider, 5);
      const window = recentWindow();

      const all = await provider.listPayouts(window);
      const page1 = await provider.listPayouts({
        ...window,
        page: 1,
        pageSize: 2,
      });
      const page2 = await provider.listPayouts({
        ...window,
        page: 2,
        pageSize: 2,
      });
      const page3 = await provider.listPayouts({
        ...window,
        page: 3,
        pageSize: 2,
      });

      const paged = [...page1, ...page2, ...page3];
      const allIds = all.map((record) => record.providerTxnId).sort();
      const pagedIds = paged.map((record) => record.providerTxnId).sort();

      expect(paged).toHaveLength(all.length);
      // ⚠️ **不重**：拼出来的条数必须等于去重后的条数
      expect(new Set(pagedIds).size).toBe(pagedIds.length);
      // ⚠️ **不漏**：两次查询的是同一批流水
      expect(pagedIds).toEqual(allIds);
    });

    // ⚠️ **异步用例在同步渠道上跳过** —— `fake` 声明 `asyncPayout: false`，
    //    `submit` 必然给出终态，不存在「稍后查询出结论」这条路径。
    //    用 `it.skip` 而不是删掉：同一套契约要覆盖将来所有渠道。
    const asyncIt = options.supportsAsync ? it : it.skip;
    asyncIt(
      '异步：submit 返回 PROCESSING → queryPayout 最终给出结论',
      async () => {
        if (!options.injectProcessing) {
          throw new Error('supportsAsync 为 true 时必须提供 injectProcessing');
        }
        await options.injectProcessing(provider);
        const input = samplePayoutInput();

        const submitted = await provider.submit(input);
        expect(submitted.status).toBe('PROCESSING');

        // ⚠️ 轮询到终态为止；超时算失败（不能无限等）
        let queried = await provider.queryPayout({
          referenceNo: input.referenceNo,
        });
        const deadline = Date.now() + 3_000;
        while (queried.status === 'PROCESSING' && Date.now() < deadline) {
          await wait(50);
          queried = await provider.queryPayout({
            referenceNo: input.referenceNo,
          });
        }

        expect(queried.status).not.toBe('PROCESSING');
        expect(queried.status).toBe('SUCCESS');
        expect(queried.amount).toBe(input.amount);
      },
    );
  });
}
