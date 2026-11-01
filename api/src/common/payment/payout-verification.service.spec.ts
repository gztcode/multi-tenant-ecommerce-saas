import { ReconciliationDiffType } from '@prisma/client';
import { PayoutVerificationService } from './payout-verification.service';
import type { PayoutProvider } from './payout-provider.interface';

/**
 * 核实服务的单元测试（阶段 5m）。
 *
 * ⚠️ **三档结论各要一条** —— `PAID` / `FAILED` / `UNKNOWN`。
 *    `UNKNOWN` 这档最容易被漏测，而它恰恰是「宁可不做也不重复打款」的落点。
 */

function fakeProvider(over: Partial<PayoutProvider> = {}): PayoutProvider {
  return {
    channel: 'fake-payout',
    provider: 'fake-payout',
    execute: jest.fn(),
    queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    listPayouts: jest.fn(() => Promise.resolve([])),
    ...over,
  };
}

const target = {
  id: 'payout-1',
  payoutNo: 'PAY1',
  payoutTxnId: null,
};

/**
 * `payoutReconciliationItem.findMany` 的入参形状。
 *
 * ⚠️ **要显式声明** —— `jest.fn(() => ...)` 会把参数推断成**零参元组**，
 *    `mock.calls[0][0]` 就成了类型错误（而 jest 的 transform 不做完整类型检查，
 *    所以单测能跑过、`tsc --noEmit` 却会红）。
 */
type FindManyArgs = {
  where: { type: { in: ReconciliationDiffType[] } };
  orderBy: unknown;
};

describe('PayoutVerificationService', () => {
  it('第 1 层：渠道说 SUCCESS → PAID', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() =>
        Promise.resolve({ status: 'SUCCESS', amount: 8500 }),
      ),
    });
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      {
        payoutReconciliationItem: {
          findMany: jest.fn(() => Promise.resolve([])),
        },
      } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('PAID');
    expect(verdict.source).toBe('REALTIME');
    expect(verdict.amount).toBe(8500);
  });

  it('第 1 层：渠道说 FAILED → FAILED', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'FAILED' })),
    });
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      {
        payoutReconciliationItem: {
          findMany: jest.fn(() => Promise.resolve([])),
        },
      } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('FAILED');
    expect(verdict.source).toBe('REALTIME');
  });

  it('⚠️ 第 1 层查不到 → 降级查对账结果', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          // ⚠️ **真实行必带 `type`** —— 第 2 层按 type 白名单判定
          type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
          channelStatus: 'SUCCESS',
          channelTxnId: 'txn-9',
          channelAmount: 8500,
          channelPaidAt: new Date('2026-03-02T00:00:00.000Z'),
        },
      ]),
    );
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('PAID');
    expect(verdict.source).toBe('RECONCILIATION');
    expect(verdict.providerTxnId).toBe('txn-9');
  });

  it('⚠️ 渠道抛错 → 降级查对账结果（不是「渠道说没打」）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.reject(new Error('渠道不可用'))),
    });
    const findMany = jest.fn(() => Promise.resolve([]));
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    const verdict = await service.verify(target);

    // ⚠️ **绝不能是 FAILED** —— 渠道挂了就当「渠道说没打」→ 会放行解卡 → 重复打款
    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 问不出结论 → UNKNOWN（fail-closed）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      {
        payoutReconciliationItem: {
          findMany: jest.fn(() => Promise.resolve([])),
        },
      } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 核实用的是 referenceNo（payoutNo），不是 payoutTxnId', async () => {
    const queryPayout = jest.fn(() => Promise.resolve({ status: 'FAILED' }));
    const service = new PayoutVerificationService(
      new Map([['fake-payout', fakeProvider({ queryPayout })]]),
      {
        payoutReconciliationItem: {
          findMany: jest.fn(() => Promise.resolve([])),
        },
      } as never,
    );

    await service.verify(target);

    // ⚠️ **PROCESSING 的单没有 payoutTxnId** —— 只按交易号查 → 核实闸对它的
    //    全部对象都是死代码 → 解卡功能 100% 不可用
    expect(queryPayout).toHaveBeenCalledWith({ referenceNo: 'PAY1' });
  });

  it('⚠️⚠️ F 类对账项（STATUS_MISMATCH）→ 不得据此产出 FAILED', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          // ⚠️ **F 类的语义是「渠道说 FAILED 但本地记 PAID」** ——
          //    说明渠道与本地记录**互相矛盾**，不能据此断定「这笔钱没打出去」
          type: ReconciliationDiffType.STATUS_MISMATCH,
          channelStatus: 'FAILED',
          channelTxnId: 'txn-3',
          channelAmount: 8500,
          channelPaidAt: null,
        },
      ]),
    );
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    const verdict = await service.verify(target);

    // ⚠️ **绝不能是 FAILED** —— 采信 F 类 → 一张本地误记为已付的单
    //    被当成「渠道明确拒付」→ 放行解卡 → 重复打款
    expect(verdict.verdict).not.toBe('FAILED');
    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ E 类对账项（channelStatus 为 null）→ UNKNOWN', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(() =>
      Promise.resolve([
        {
          payoutId: 'payout-1',
          type: ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
          // ⚠️ **E 类的 channelStatus 恒为 null** —— 「渠道查不到」≠「渠道说没打」
          channelStatus: null,
          channelTxnId: null,
          channelAmount: 8500,
          channelPaidAt: null,
        },
      ]),
    );
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    const verdict = await service.verify(target);

    expect(verdict.verdict).toBe('UNKNOWN');
    expect(verdict.source).toBe('NONE');
  });

  it('⚠️ 查对账结果时按 type 白名单过滤（不得靠引擎口径兜底）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_args: FindManyArgs) => Promise.resolve([]),
    );
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    await service.verify(target);

    // ⚠️ **白名单必须是显式的** —— 只靠「引擎不会给 PROCESSING 的单产 F 类」
    //    这条跨 Task 的隐式耦合，引擎一改口径就会静默放行
    const args = findMany.mock.calls[0][0];
    expect(args.where.type.in).toEqual([
      ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
      ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
      ReconciliationDiffType.AMOUNT_MISMATCH,
    ]);
    // ⚠️ **白名单里绝不能有 F 类** —— 它是唯一会带出 channelStatus='FAILED' 的类型
    expect(args.where.type.in).not.toContain(
      ReconciliationDiffType.STATUS_MISMATCH,
    );
  });

  it('⚠️ 查对账结果时有二级排序键（同一毫秒内写入的两行顺序要确定）', async () => {
    const provider = fakeProvider({
      queryPayout: jest.fn(() => Promise.resolve({ status: 'UNKNOWN' })),
    });
    const findMany = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_args: FindManyArgs) => Promise.resolve([]),
    );
    const service = new PayoutVerificationService(
      new Map([['fake-payout', provider]]),
      { payoutReconciliationItem: { findMany } } as never,
    );

    await service.verify(target);

    // ⚠️ **只按 createdAt 排** → 同一毫秒内写入的两行 item 顺序不确定
    //    → 「最近一次对账结果」会随机命中其中一行 → 结论不稳定
    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
