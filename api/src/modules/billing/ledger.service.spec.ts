import { PayoutKind, PayoutStatus, SettlementStatus } from '@prisma/client';

import { LedgerService } from './ledger.service';

/**
 * 按期批量聚合的单测（阶段 5i · Task 4）。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `payout.service.spec.ts` 同款）：
 *    每个方法的返回值由 `options` 配好，**它不按 `where` 过滤**。
 *    代价是「查不到别家的单」这种行为在单测里测不出来 ——
 *    → **租户隔离靠「断言 service 层传的 where」来验**。
 */

/** 一个自然月 */
const PERIOD_2026_08 = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-09-01T00:00:00.000Z'),
};
const PERIOD_2026_07 = {
  from: new Date('2026-07-01T00:00:00.000Z'),
  to: new Date('2026-08-01T00:00:00.000Z'),
};

/** 假 Prisma 的查询参数（只要能读出 `where` 就够断言了） */
interface QueryArgs {
  where?: Record<string, unknown>;
  select?: unknown;
}

/**
 * 取某个 mock 的**第一次调用**的参数。
 *
 * ⚠️ **为什么要有这个 helper**：直接写 `mock.calls[0][0]` 在
 *    `strictNullChecks` 下会报「可能为 undefined」，而每处都写
 *    `!` 又太吵。这里集中一处断言「确实被调用过」。
 */
function argsOf(mock: { mock: { calls: unknown[][] } }): QueryArgs {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return (call ?? [])[0] as QueryArgs;
}

/** 一只最小可用的假 Prisma（只实现本服务用到的 6 个方法） */
function fakePrisma(
  options: {
    receipts?: Array<{
      id: string;
      amount: number;
      occurredAt: Date;
    }>;
    statements?: Array<{
      id: string;
      periodStart: Date;
      netAmount: number;
      status: SettlementStatus;
    }>;
    statementLinks?: Array<{ statementId: string; entryId: string }>;
    commissionEntries?: Array<{ id: string }>;
    payouts?: Array<{
      id: string;
      periodStart: Date;
      status: PayoutStatus;
      netAmount: number;
      kind: PayoutKind;
    }>;
    payoutLinks?: Array<{ payoutId: string; entryId: string }>;
  } = {},
) {
  const prisma = {
    merchantReceipt: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.receipts ?? []),
      ),
    },
    settlementStatement: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.statements ?? []),
      ),
    },
    settlementStatementEntry: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.statementLinks ?? []),
      ),
    },
    commissionEntry: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.commissionEntries ?? []),
      ),
    },
    payout: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.payouts ?? []),
      ),
    },
    payoutEntry: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.payoutLinks ?? []),
      ),
    },
  };
  return prisma;
}

/** 把假 Prisma 塞进服务 */
function makeService(prisma: ReturnType<typeof fakePrisma>): LedgerService {
  return new LedgerService(prisma as unknown as never);
}

/** 断言「每张表恰好查了一次」 */
function expectEachTableQueriedOnce(
  prisma: ReturnType<typeof fakePrisma>,
): void {
  expect(prisma.merchantReceipt.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.settlementStatement.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.settlementStatementEntry.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.commissionEntry.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.payout.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.payoutEntry.findMany).toHaveBeenCalledTimes(1);
}

describe('LedgerService（阶段 5i）', () => {
  it('⚠️ 无论多少期，查询次数是固定的（这是 L55 的解药）', async () => {
    // ⚠️ **3 期与 1 期的查询次数必须一样** ——
    //    阶段 5h-2 的 L55 就是「逐期循环、每期 3 次查询」的 N+1。
    //    商家侧对账单会再触发一次同样的 N+1 → 两边共用这一个服务。
    const prisma = fakePrisma();
    const service = makeService(prisma);

    await service.aggregatePeriods('tenant-1', [
      PERIOD_2026_08,
      PERIOD_2026_07,
      PERIOD_2026_08,
    ]);
    await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    // ⚠️ **两次调用加起来，每张表各 2 次**（每次调用各 1 次）
    expect(prisma.merchantReceipt.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.settlementStatement.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.settlementStatementEntry.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.commissionEntry.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.payout.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.payoutEntry.findMany).toHaveBeenCalledTimes(2);

    // ⚠️ **每次调用内部，每张表各只查一次** ——
    //    「第二次调用没有把第一次的次数翻倍」才是关键。
    expect(prisma.merchantReceipt.findMany).toHaveBeenCalledTimes(2);
  });

  it('⚠️ 一次调用内部：每张表恰好查一次（6 次，与期数无关）', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    await service.aggregatePeriods('tenant-1', [
      PERIOD_2026_08,
      PERIOD_2026_07,
      PERIOD_2026_08,
    ]);

    expectEachTableQueriedOnce(prisma);
  });

  it('货款按期分组', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          amount: 10000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
        {
          id: 'r-2',
          amount: 5000,
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        {
          id: 'r-3',
          amount: 7000,
          occurredAt: new Date('2026-07-05T00:00:00.000Z'),
        },
      ],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [
      PERIOD_2026_08,
      PERIOD_2026_07,
    ]);

    expect(result.get('2026-08')?.receiptAmount).toBe(15000);
    expect(result.get('2026-08')?.receiptCount).toBe(2);
    expect(result.get('2026-07')?.receiptAmount).toBe(7000);
    expect(result.get('2026-07')?.receiptCount).toBe(1);
  });

  it('⚠️ 货款冲回是负数 → 净额带符号（不是取绝对值）', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          amount: 10000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
        {
          id: 'r-2',
          amount: -3000,
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        },
      ],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    expect(result.get('2026-08')?.receiptAmount).toBe(7000);
  });

  it('⚠️ 没有结算单的期 → 佣金是 null（不是 0）', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    expect(result.get('2026-08')?.commissionAmount).toBeNull();
    expect(result.get('2026-08')?.statementStatus).toBeNull();
    expect(result.get('2026-08')?.statementId).toBeNull();
    expect(result.get('2026-08')?.commissionEntryCount).toBe(0);
  });

  it('有结算单的期 → 佣金取结算单的冻结值（带符号）', async () => {
    const prisma = fakePrisma({
      statements: [
        {
          id: 'stmt-a',
          periodStart: PERIOD_2026_08.from,
          netAmount: 1500,
          status: SettlementStatus.CONFIRMED,
        },
      ],
      statementLinks: [{ statementId: 'stmt-a', entryId: 'e-1' }],
      commissionEntries: [{ id: 'e-1' }],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    const amounts = result.get('2026-08');
    expect(amounts?.statementId).toBe('stmt-a');
    expect(amounts?.statementStatus).toBe(SettlementStatus.CONFIRMED);
    expect(amounts?.commissionAmount).toBe(1500);
    // ⚠️ **笔数按真实存在的流水行算**
    expect(amounts?.commissionEntryCount).toBe(1);
  });

  it('出款单按状态分桶：PAID 算已出款，REQUESTED 算在途', async () => {
    const prisma = fakePrisma({
      payouts: [
        {
          id: 'p-1',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.PAID,
          netAmount: 8500,
          kind: PayoutKind.NORMAL,
        },
        {
          id: 'p-2',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.REQUESTED,
          netAmount: 5000,
          kind: PayoutKind.SUPPLEMENT,
        },
      ],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    const amounts = result.get('2026-08');
    expect(amounts?.paidAmount).toBe(8500);
    expect(amounts?.inFlightAmount).toBe(5000);
    expect(amounts?.hasActiveNormal).toBe(true);
    expect(amounts?.normalPaid).toBe(true);
    expect(amounts?.hasActiveSupplement).toBe(true);
  });

  it('⚠️ REJECTED / CANCELLED / FAILED 的单既不算已出款也不算在途', async () => {
    const prisma = fakePrisma({
      payouts: [
        {
          id: 'p-1',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.REJECTED,
          netAmount: 1000,
          kind: PayoutKind.NORMAL,
        },
        {
          id: 'p-2',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.CANCELLED,
          netAmount: 2000,
          kind: PayoutKind.NORMAL,
        },
        {
          id: 'p-3',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.FAILED,
          netAmount: 3000,
          kind: PayoutKind.NORMAL,
        },
      ],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    const amounts = result.get('2026-08');
    expect(amounts?.paidAmount).toBe(0);
    expect(amounts?.inFlightAmount).toBe(0);
    // ⚠️ **失败的单不占位** → 这一期还能重新申请
    expect(amounts?.hasActiveNormal).toBe(false);
    expect(amounts?.normalPaid).toBe(false);
  });

  it('⚠️ 已被出款单占用的流水不再算「未纳入」', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'receipt-already-paid',
          amount: 10000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
        {
          id: 'receipt-new',
          amount: 5000,
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        },
      ],
      payoutLinks: [{ payoutId: 'p-1', entryId: 'receipt-already-paid' }],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    // ⚠️ **未纳入的只有新来的那笔 5000**
    expect(result.get('2026-08')?.supplementAmount).toBe(5000);
  });

  it('⚠️ 「已被占用」按 payout_entries 的实际行算，不按 entryCount 求和', async () => {
    // ⚠️ **被拒 / 撤回 / 失败的单已释放明细占用**，但它们的 `entryCount` 列
    //    仍是旧数字 —— 拿 `entryCount` 求和会把「已释放的流水」算成「已纳入」
    //    → 补差金额被凭空抹掉。
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          amount: 10000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
      payouts: [
        {
          id: 'p-1',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.REJECTED,
          netAmount: 10000,
          kind: PayoutKind.NORMAL,
        },
      ],
      // ⚠️ **没有 payout_entries 行** → 明细已释放 → 这笔货款仍是「未纳入」
      payoutLinks: [],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    expect(result.get('2026-08')?.supplementAmount).toBe(10000);
  });

  it('⚠️ 出款单按周期归期（不同期的单不串桶）', async () => {
    const prisma = fakePrisma({
      payouts: [
        {
          id: 'p-1',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.PAID,
          netAmount: 8500,
          kind: PayoutKind.NORMAL,
        },
        {
          id: 'p-2',
          periodStart: PERIOD_2026_07.from,
          status: PayoutStatus.PAID,
          netAmount: 3000,
          kind: PayoutKind.NORMAL,
        },
      ],
    });
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', [
      PERIOD_2026_08,
      PERIOD_2026_07,
    ]);

    expect(result.get('2026-08')?.paidAmount).toBe(8500);
    expect(result.get('2026-07')?.paidAmount).toBe(3000);
  });

  it('没有期 → 返回空 Map，且不查库', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    const result = await service.aggregatePeriods('tenant-1', []);

    expect(result.size).toBe(0);
    expect(prisma.merchantReceipt.findMany).not.toHaveBeenCalled();
  });

  it('⚠️ 两张关联表靠 id 列表限定归属（不带 tenantId 条件）', async () => {
    // ⚠️ **`settlement_statement_entries` 与 `payout_entries` 没有 tenantId**
    //    → 扩展不附加任何过滤 → 必须靠「该租户的结算单 / 出款单的 id」限定。
    const prisma = fakePrisma({
      statements: [
        {
          id: 'stmt-a',
          periodStart: PERIOD_2026_08.from,
          netAmount: 1500,
          status: SettlementStatus.CONFIRMED,
        },
      ],
      payouts: [
        {
          id: 'p-1',
          periodStart: PERIOD_2026_08.from,
          status: PayoutStatus.PAID,
          netAmount: 8500,
          kind: PayoutKind.NORMAL,
        },
      ],
    });
    const service = makeService(prisma);

    await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    expect(argsOf(prisma.settlementStatementEntry.findMany).where).toEqual({
      statementId: { in: ['stmt-a'] },
    });
    expect(argsOf(prisma.payoutEntry.findMany).where).toEqual({
      payoutId: { in: ['p-1'] },
    });
  });

  it('⚠️ 查关联表时 id 列表为空时也照样查（查询次数固定为 6）', async () => {
    // ⚠️ **不能因为「没有 id 就跳过查询」** ——
    //    那会让查询次数随数据量变化（有时 4 次、有时 6 次），
    //    「固定 6 次」的承诺就破了一半。
    const prisma = fakePrisma();
    const service = makeService(prisma);

    await service.aggregatePeriods('tenant-1', [PERIOD_2026_08]);

    expect(prisma.settlementStatementEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.payoutEntry.findMany).toHaveBeenCalledTimes(1);
    expect(argsOf(prisma.settlementStatementEntry.findMany).where).toEqual({
      statementId: { in: [] },
    });
    expect(argsOf(prisma.payoutEntry.findMany).where).toEqual({
      payoutId: { in: [] },
    });
  });

  it('⚠️ 查货款 / 结算单 / 出款单时区间覆盖所有期', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);

    await service.aggregatePeriods('tenant-1', [
      PERIOD_2026_07,
      PERIOD_2026_08,
    ]);

    // ⚠️ **左闭右开，与结算单/出款单同口径**
    expect(argsOf(prisma.merchantReceipt.findMany).where).toMatchObject({
      occurredAt: {
        gte: new Date('2026-07-01T00:00:00.000Z'),
        lt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    expect(argsOf(prisma.settlementStatement.findMany).where).toMatchObject({
      periodStart: {
        gte: new Date('2026-07-01T00:00:00.000Z'),
        lt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    expect(argsOf(prisma.payout.findMany).where).toMatchObject({
      periodStart: {
        gte: new Date('2026-07-01T00:00:00.000Z'),
        lt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
  });
});
