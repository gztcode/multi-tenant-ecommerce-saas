import { PayoutStatus, SettlementStatus } from '@prisma/client';

import { tenantContext } from '../../common/tenant/tenant-context';
import { LedgerService, type PeriodAmounts } from './ledger.service';
import { MerchantStatementService } from './merchant-statement.service';

/**
 * 商家对账单的服务层单测（阶段 5i · Task 5）。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `payout-account.service.spec.ts` 同款）：
 *    每个方法的返回值由 `options` 配好，**它不按 `where` 过滤**。
 *    代价是「查不到别家的单」这种行为在单测里测不出来 ——
 *    → **租户隔离靠「断言 service 层传的 where」来验**。
 *
 * ⚠️ **`LedgerService` 被 mock 掉**：本服务只做「聚合结果 → 商家视角」的换算，
 *    聚合本身的正确性由 `ledger.service.spec.ts` 负责 ——
 *    两边各测各的，不重复测同一件事。
 */

/** 「现在」：2026-09-15。2026-08 已结束，2026-09 还没结束 */
const NOW = new Date('2026-09-15T00:00:00.000Z');

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

/** 一期的聚合结果（可按需覆盖） */
function periodAmounts(overrides?: Partial<PeriodAmounts>): PeriodAmounts {
  return {
    receiptAmount: 0,
    receiptCount: 0,
    statementId: null,
    commissionAmount: null,
    statementStatus: null,
    commissionEntryCount: 0,
    paidAmount: 0,
    inFlightAmount: 0,
    hasActiveNormal: false,
    hasActiveSupplement: false,
    normalPaid: false,
    supplementAmount: 0,
    ...overrides,
  };
}

/** 一只最小可用的假 Prisma（只实现本服务用到的方法） */
function fakePrisma(
  options: {
    /** 列表页查「有哪些期」的流水（只用到 `occurredAt`） */
    periodReceipts?: Array<{ occurredAt: Date }>;
    /** 详情页的货款流水 */
    receipts?: Array<{
      id: string;
      orderNo: string;
      type: string;
      amount: number;
      occurredAt: Date;
    }>;
    /** 该租户该期的结算单 */
    statement?: { id: string } | null;
    /** 结算单纳入的抽佣流水关联 */
    statementLinks?: Array<{ entryId: string }>;
    /** 抽佣流水 */
    commissionEntries?: Array<{
      id: string;
      orderNo: string;
      type: string;
      baseAmount: number;
      rateBps: number;
      amount: number;
      occurredAt: Date;
    }>;
    /** 该租户该期的出款单 */
    payouts?: Array<{ id: string; status?: PayoutStatus }>;
    /** 出款单占用的货款流水 */
    payoutLinks?: Array<{ entryId: string; payoutId?: string }>;
  } = {},
) {
  const prisma = {
    databaseNow: jest.fn<Promise<Date>, []>(() => Promise.resolve(NOW)),
    merchantReceipt: {
      /**
       * ⚠️ **一次 mock 服务两个查询**（列表页的「有哪些期」与详情页的明细）：
       *    靠 `where.occurredAt` 区分 —— 列表页不按时间过滤（只 select
       *    `occurredAt`），详情页按区间过滤。
       */
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(
        (args?: QueryArgs) =>
          Promise.resolve(
            args?.where?.occurredAt === undefined
              ? (options.periodReceipts ?? [])
              : (options.receipts ?? []),
          ),
      ),
    },
    settlementStatement: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.statement === undefined
            ? { id: 'stmt-a' }
            : options.statement,
        ),
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

/**
 * 假 `LedgerService`：按期返回配好的聚合结果。
 *
 * ⚠️ **不 mock 整个类**（那要实现它的每个方法），只替换 `aggregatePeriods`。
 */
function fakeLedger(
  amountsByPeriod: Record<string, PeriodAmounts>,
): LedgerService {
  return {
    aggregatePeriods: jest.fn<Promise<Map<string, PeriodAmounts>>, unknown[]>(
      () => Promise.resolve(new Map(Object.entries(amountsByPeriod))),
    ),
  } as unknown as LedgerService;
}

/** 把假 Prisma 与假 Ledger 塞进服务 */
function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  ledger: LedgerService,
): MerchantStatementService {
  return new MerchantStatementService(prisma as unknown as never, ledger);
}

/** 在租户上下文里调用（服务层靠 `getTenantContext()` 取租户） */
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: 'tenant-a', userId: 'user-a', role: null },
    async () => fn(),
  );
}

describe('商家对账单：汇总口径', () => {
  it('应结 = 货款净额 − 佣金净额', async () => {
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-08-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 3,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 5000,
      }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    expect(views).toHaveLength(1);
    expect(views[0].receiptAmount).toBe(100000);
    expect(views[0].commissionAmount).toBe(5000);
    expect(views[0].payableAmount).toBe(95000);
  });

  it('待出款 = 应结 − 已出款 − 在途', async () => {
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-08-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 3,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 5000,
        paidAmount: 30000,
        inFlightAmount: 20000,
      }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    // 95000 − 30000 − 20000 = 45000
    expect(views[0].payableAmount).toBe(95000);
    expect(views[0].paidAmount).toBe(30000);
    expect(views[0].inFlightAmount).toBe(20000);
    expect(views[0].pendingAmount).toBe(45000);
  });

  it('⚠️ 超付时待出款是 0（不出现负数），且 overpaidAmount 单独给出', async () => {
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-08-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 3,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 5000,
        paidAmount: 120000,
      }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    expect(views[0].payableAmount).toBe(95000);
    // ⚠️ **待出款不能是负数** —— 商家看到「待出款 −25000 分」会以为系统算错了
    expect(views[0].pendingAmount).toBe(0);
    expect(views[0].overpaidAmount).toBe(25000);
  });

  it('⚠️ 没有结算单 → 佣金与应结都是 null，applicableKind 也是 null', async () => {
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-08-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 3,
        // ⚠️ **没有结算单** → 佣金未知
        statementId: null,
        statementStatus: null,
        commissionAmount: null,
      }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    expect(views[0].commissionAmount).toBeNull();
    expect(views[0].payableAmount).toBeNull();
    expect(views[0].pendingAmount).toBeNull();
    expect(views[0].overpaidAmount).toBe(0);
    expect(views[0].applicableKind).toBeNull();
    // ⚠️ **不能申请的原因照 `deriveApplicableKind` 的文案**
    expect(views[0].blockedReason).toBe('该期的结算单尚未生成');
  });

  it('⚠️ 当月（周期未结束）也要列出来，但不能申请出款', async () => {
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-09-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-09': periodAmounts({
        receiptAmount: 20000,
        receiptCount: 1,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 1000,
      }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    expect(views).toHaveLength(1);
    expect(views[0].period).toBe('2026-09');
    // ⚠️ **数字照给**（商家要看到「本月已经收了多少钱」）
    expect(views[0].receiptAmount).toBe(20000);
    expect(views[0].payableAmount).toBe(19000);
    // ⚠️ **但不能申请** —— 周期内的流水还会变
    expect(views[0].applicableKind).toBeNull();
    expect(views[0].blockedReason).toBe('该周期尚未结束');
  });

  it('⚠️ 不能申请出款的期（结算单未确认）也要列出来', async () => {
    // ⚠️ **商家需要看到「我这期有货款，但结算单还没确认」**，
    //    否则只能打电话问客服。
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-08-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 3,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.DRAFT,
        commissionAmount: 5000,
      }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    expect(views).toHaveLength(1);
    expect(views[0].applicableKind).toBeNull();
    expect(views[0].blockedReason).toBe('该期的结算单尚未确认');
  });

  it('期是倒序的（最新一期在最上面）', async () => {
    const prisma = fakePrisma({
      periodReceipts: [
        { occurredAt: new Date('2026-07-10T00:00:00.000Z') },
        { occurredAt: new Date('2026-08-10T00:00:00.000Z') },
        { occurredAt: new Date('2026-08-20T00:00:00.000Z') },
      ],
    });
    const ledger = fakeLedger({
      '2026-07': periodAmounts({ receiptAmount: 1000, receiptCount: 1 }),
      '2026-08': periodAmounts({ receiptAmount: 2000, receiptCount: 2 }),
    });
    const service = makeService(prisma, ledger);

    const views = await asTenant(() => service.list());

    expect(views.map((v) => v.period)).toEqual(['2026-08', '2026-07']);
  });
});

describe('商家对账单：明细', () => {
  it('抽佣明细带费率与计佣基数，货款明细标出出款状态', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          orderNo: 'ORD-1',
          type: 'SALE',
          amount: 100000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
        {
          id: 'r-2',
          orderNo: 'ORD-2',
          type: 'SALE',
          amount: 20000,
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        },
      ],
      statement: { id: 'stmt-a' },
      statementLinks: [{ entryId: 'e-1' }],
      commissionEntries: [
        {
          id: 'e-1',
          orderNo: 'ORD-1',
          type: 'COMMISSION',
          baseAmount: 100000,
          rateBps: 500,
          amount: 5000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
      payouts: [{ id: 'p-1', status: PayoutStatus.PAID }],
      payoutLinks: [{ entryId: 'r-1', payoutId: 'p-1' }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 120000,
        receiptCount: 2,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 5000,
        commissionEntryCount: 1,
      }),
    });
    const service = makeService(prisma, ledger);

    const detail = await asTenant(() => service.detail('2026-08'));

    expect(detail.commissionEntries).toHaveLength(1);
    expect(detail.commissionEntries[0].entryId).toBe('e-1');
    expect(detail.commissionEntries[0].orderNo).toBe('ORD-1');
    // ⚠️ **费率必须给出来** —— 商家要能核对「按百分之几抽的」
    expect(detail.commissionEntries[0].rateBps).toBe(500);
    expect(detail.commissionEntries[0].baseAmount).toBe(100000);
    expect(detail.commissionEntries[0].amount).toBe(5000);
    expect(detail.commissionEntries[0].occurredAt).toBe(
      '2026-08-10T00:00:00.000Z',
    );

    expect(detail.receiptEntries).toHaveLength(2);
    // ⚠️ **按发生时间倒序**：r-2 更新
    expect(detail.receiptEntries[0].entryId).toBe('r-2');
    // ⚠️ **没被任何出款单纳入 → null（未出款）**
    expect(detail.receiptEntries[0].payoutStatus).toBeNull();
    expect(detail.receiptEntries[1].entryId).toBe('r-1');
    // ⚠️ **已被 `PAID` 的出款单出过的要标成「已出款」**
    expect(detail.receiptEntries[1].payoutStatus).toBe('PAID');
  });

  it('⚠️ 在途的出款单 → 货款明细标「出款中」而不是「已出款」', async () => {
    // ⚠️ **这是三态改造的核心**：出款单还在途（申请了，钱还没打），
    //    明细却显示「已出款」→ 商家看到「已出款」却没收到钱就会来投诉。
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          orderNo: 'ORD-1',
          type: 'SALE',
          amount: 100000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
      statement: { id: 'stmt-a' },
      statementLinks: [],
      commissionEntries: [],
      // ⚠️ **在途**（`REQUESTED` / `APPROVED` / `PROCESSING` 三者同款）
      payouts: [{ id: 'p-1', status: PayoutStatus.REQUESTED }],
      payoutLinks: [{ entryId: 'r-1', payoutId: 'p-1' }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 1,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 0,
      }),
    });
    const service = makeService(prisma, ledger);

    const detail = await asTenant(() => service.detail('2026-08'));

    expect(detail.receiptEntries[0].payoutStatus).toBe('IN_FLIGHT');
    // ⚠️ **不能是「已出款」** —— 钱还没打
    expect(detail.receiptEntries[0].payoutStatus).not.toBe('PAID');
  });

  it('⚠️ DRAFT 的结算单不展示明细（未确认的结算单不是凭证）', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          orderNo: 'ORD-1',
          type: 'SALE',
          amount: 100000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
      statement: { id: 'stmt-a' },
      statementLinks: [{ entryId: 'e-1' }],
      commissionEntries: [
        {
          id: 'e-1',
          orderNo: 'ORD-1',
          type: 'COMMISSION',
          baseAmount: 100000,
          rateBps: 500,
          amount: 5000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 1,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.DRAFT,
        commissionAmount: 5000,
      }),
    });
    const service = makeService(prisma, ledger);

    const detail = await asTenant(() => service.detail('2026-08'));

    expect(detail.commissionEntries).toHaveLength(0);
    expect(prisma.settlementStatementEntry.findMany).not.toHaveBeenCalled();
  });

  it('⚠️ 抽佣明细加总与佣金净额对不上 → 抛错', async () => {
    // ⚠️ **明细与汇总来自两处不同的查询** → 不一致说明其中一边算错了 →
    //    宁可这个接口 500，也不要让商家加总发现差 1 分然后来投诉。
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          orderNo: 'ORD-1',
          type: 'SALE',
          amount: 100000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
      statement: { id: 'stmt-a' },
      statementLinks: [{ entryId: 'e-1' }],
      commissionEntries: [
        {
          id: 'e-1',
          orderNo: 'ORD-1',
          type: 'COMMISSION',
          baseAmount: 100000,
          rateBps: 500,
          // ⚠️ **明细是 4000，但佣金净额是 5000** → 对不上
          amount: 4000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 1,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 5000,
      }),
    });
    const service = makeService(prisma, ledger);

    await expect(asTenant(() => service.detail('2026-08'))).rejects.toThrow(
      /抽佣明细加总 4000 与佣金净额 5000 不一致/,
    );
  });

  it('⚠️ 货款明细加总与货款净额对不上 → 抛错', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          orderNo: 'ORD-1',
          type: 'SALE',
          // ⚠️ **明细是 90000，但货款净额是 100000** → 对不上
          amount: 90000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 100000,
        receiptCount: 1,
      }),
    });
    const service = makeService(prisma, ledger);

    await expect(asTenant(() => service.detail('2026-08'))).rejects.toThrow(
      /货款明细加总 90000 与货款净额 100000 不一致/,
    );
  });
});

describe('商家对账单：租户隔离', () => {
  it('⚠️ 商家侧的查询不手写 tenantId（靠租户作用域扩展自动附加）', async () => {
    const prisma = fakePrisma({
      periodReceipts: [{ occurredAt: new Date('2026-08-10T00:00:00.000Z') }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({ receiptAmount: 1000, receiptCount: 1 }),
    });
    const service = makeService(prisma, ledger);

    await asTenant(() => service.list());

    const call = argsOf(prisma.merchantReceipt.findMany);
    expect(call.where?.tenantId).toBeUndefined();
  });

  it('⚠️ 查关联表时先查该租户的结算单 / 出款单（归属凭证）', async () => {
    const prisma = fakePrisma({
      receipts: [
        {
          id: 'r-1',
          orderNo: 'ORD-1',
          type: 'SALE',
          amount: 1000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
      statement: { id: 'stmt-a' },
      payouts: [{ id: 'p-1' }],
    });
    const ledger = fakeLedger({
      '2026-08': periodAmounts({
        receiptAmount: 1000,
        receiptCount: 1,
        statementId: 'stmt-a',
        statementStatus: SettlementStatus.CONFIRMED,
        commissionAmount: 0,
      }),
    });
    const service = makeService(prisma, ledger);

    await asTenant(() => service.detail('2026-08'));

    // ⚠️ **`settlement_statement_entries` / `payout_entries` 没有 tenantId**
    //    → 必须靠「该租户的结算单 / 出款单的 id」限定归属。
    expect(argsOf(prisma.settlementStatementEntry.findMany).where).toEqual({
      statementId: 'stmt-a',
    });
    expect(argsOf(prisma.payoutEntry.findMany).where).toEqual({
      payoutId: { in: ['p-1'] },
    });
  });
});
