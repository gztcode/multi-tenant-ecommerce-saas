import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PayoutStatus, ReceiptType, SettlementStatus } from '@prisma/client';
import { validate } from 'class-validator';

import { tenantContext } from '../../common/tenant/tenant-context';
import { ApplyPayoutDto } from './dto/apply-payout.dto';
import { PayoutService } from './payout.service';

/**
 * 出款单服务的**分支级**单元测试。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**：每个方法的返回值由 `options` 配好，
 *    **它不按 `where` 过滤**（与 5g 的 `settlement.service.spec.ts` 同款）。
 *    代价是「查不到别家的单」这种行为在单测里测不出来 ——
 *    → **租户隔离（P9）靠「断言 service 层传的 where」来验**：
 *    ```ts
 *    expect(argsOf(fakePrisma.payout.findFirst).where).toEqual({ id: payoutId });
 *    ```
 *    ⚠️ **跨租户的实际行为（404/403）放到 e2e 验**（Task 8）——
 *    只有真实 Prisma 才会真的过滤。
 */

/** 造一个 P2002（唯一约束冲突） */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

/** 一条货款流水的形状 */
function receipt(overrides: {
  id: string;
  tenantId?: string;
  amount?: number;
  type?: ReceiptType;
  occurredAt?: Date;
}) {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId ?? 'tenant-a',
    orderId: `order-${overrides.id}`,
    orderNo: `ORD-${overrides.id}`,
    type: overrides.type ?? ReceiptType.SALE,
    amount: overrides.amount ?? 10000,
    occurredAt: overrides.occurredAt ?? new Date('2025-07-10T00:00:00.000Z'),
    createdAt: new Date('2025-07-10T00:00:00.000Z'),
    updatedAt: new Date('2025-07-10T00:00:00.000Z'),
  };
}

/** 一张结算单的形状 */
function statement(overrides: {
  id?: string;
  tenantId?: string;
  status?: SettlementStatus;
  netAmount?: number;
  periodStart?: Date;
}) {
  return {
    id: overrides.id ?? 'stmt-a',
    tenantId: overrides.tenantId ?? 'tenant-a',
    statementNo: 'STL2025070100000001',
    periodStart: overrides.periodStart ?? new Date('2025-07-01T00:00:00.000Z'),
    periodEnd: new Date('2025-08-01T00:00:00.000Z'),
    grossAmount: overrides.netAmount ?? 2000,
    reversalAmount: 0,
    netAmount: overrides.netAmount ?? 2000,
    entryCount: 1,
    status: overrides.status ?? SettlementStatus.CONFIRMED,
    confirmedAt: new Date('2025-08-01T00:00:00.000Z'),
    createdAt: new Date('2025-08-01T00:00:00.000Z'),
    updatedAt: new Date('2025-08-01T00:00:00.000Z'),
  };
}

/** 一张出款单的形状 */
function payout(overrides: {
  id?: string;
  tenantId?: string;
  status?: PayoutStatus;
  receiptAmount?: number;
  commissionAmount?: number;
  netAmount?: number;
  requestedAmount?: number;
  entryCount?: number;
  periodStart?: Date;
  statementId?: string | null;
}) {
  const receiptAmount = overrides.receiptAmount ?? 10000;
  const commissionAmount = overrides.commissionAmount ?? 2000;
  const netAmount = overrides.netAmount ?? receiptAmount - commissionAmount;
  return {
    id: overrides.id ?? 'payout-a',
    tenantId: overrides.tenantId ?? 'tenant-a',
    payoutNo: 'PAY202508010000000001',
    periodStart: overrides.periodStart ?? new Date('2025-07-01T00:00:00.000Z'),
    periodEnd: new Date('2025-08-01T00:00:00.000Z'),
    statementId:
      overrides.statementId === undefined ? 'stmt-a' : overrides.statementId,
    receiptAmount,
    commissionAmount,
    netAmount,
    entryCount: overrides.entryCount ?? 1,
    status: overrides.status ?? PayoutStatus.REQUESTED,
    requestedAmount: overrides.requestedAmount ?? netAmount,
    requestedBy: 'user-a',
    approvedBy: null,
    rejectedReason: null,
    requestedAt: new Date('2025-08-01T00:00:00.000Z'),
    approvedAt: null,
    cancelledAt: null,
    createdAt: new Date('2025-08-01T00:00:00.000Z'),
    updatedAt: new Date('2025-08-01T00:00:00.000Z'),
  };
}

/** 收款账户的形状 */
function payoutAccount() {
  return {
    id: 'acct-a',
    tenantId: 'tenant-a',
    accountName: '张三',
    bankName: '测试银行',
    accountNo: '6222000000000000',
    createdAt: new Date('2025-08-01T00:00:00.000Z'),
    updatedAt: new Date('2025-08-01T00:00:00.000Z'),
  };
}

/**
 * 假 Prisma 的查询参数（只要能读出 `where` 就够断言了）。
 *
 * ⚠️ **刻意宽松**：`where` 的具体形状随服务层的写法变，
 *    这里钉死它只会让每次改查询都要改类型。
 */
interface QueryArgs {
  where?: Record<string, unknown>;
  data?: unknown;
  select?: unknown;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

/**
 * 取某个 mock 的**第一次调用**的参数。
 *
 * ⚠️ **为什么要有这个 helper**：直接写 `mock.calls[0][0]` 在
 *    `strictNullChecks` 下会报「可能为 undefined」，而每处都写
 *    `!` 又太吵。这里集中一处断言「确实被调用过」——
 *    少调一次就该让测试挂掉，而不是静默跳过断言。
 */
function argsOf(mock: { mock: { calls: unknown[][] } }): QueryArgs {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return (call ?? [])[0] as QueryArgs;
}

/**
 * 一只最小可用的假 Prisma。
 *
 * ⚠️ **只实现服务层真正用到的那几个方法**：多写一个就多一处
 *    「测试里的假实现与真实 Prisma 行为不一致」的风险。
 */
function fakePrisma(options: {
  /** 当期货款流水 */
  receipts?: ReturnType<typeof receipt>[];
  /** 结算单 */
  statement?: ReturnType<typeof statement> | null;
  /** 已有的出款单（幂等检查） */
  payout?: ReturnType<typeof payout> | null;
  /** 出款单列表 */
  payouts?: ReturnType<typeof payout>[];
  /** 列表总数 */
  payoutCount?: number;
  /** 事务里 `create` 的返回值 */
  createdPayout?: ReturnType<typeof payout>;
  /** `updateMany` 影响多少行 */
  updateManyCount?: number;
  /** `payoutEntry.findMany` 的返回值 */
  linkedRows?: Array<{ entryId: string }>;
  /** 收款账户（null = 没填） */
  account?: ReturnType<typeof payoutAccount> | null;
  /** 事务里的 `create` 要不要抛 P2002 */
  createThrows?: boolean;
  /** 商家信息 */
  tenant?: { name: string; subdomain: string } | null;
}) {
  const calls: string[] = [];
  /**
   * 事务客户端（`$transaction` 的回调参数）。
   *
   * ⚠️ **暴露出来是为了能断言事务里的调用**：
   *    `payoutEntry.createMany` 跑在**事务客户端**上，不是 `this.prisma` 上 ——
   *    断言对象搞错就会「断言了一个从没被调用过的 mock」。
   */
  let tx: {
    payout: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
    payoutEntry: {
      createMany: jest.Mock;
      deleteMany: jest.Mock;
    };
  } | null = null;

  /**
   * ⚠️ **用 `jest.fn<返回值, 参数元组>()` 而不是 `jest.fn((_args) => ...)`**：
   *    后者会留下一个**没用到的参数**，本仓库的 eslint 没开
   *    `argsIgnorePattern` → 每个桩都要报 unused-vars。
   */
  const prisma = {
    calls,
    databaseNow: jest.fn(() =>
      Promise.resolve(new Date('2025-08-15T00:00:00.000Z')),
    ),
    merchantPayoutAccount: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.account === undefined ? payoutAccount() : options.account,
        ),
      ),
    },
    merchantReceipt: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.receipts ?? []),
      ),
    },
    settlementStatement: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.statement === undefined ? statement({}) : options.statement,
        ),
      ),
    },
    payout: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.payout ?? null),
      ),
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.payouts ?? []),
      ),
      count: jest.fn<Promise<number>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.payoutCount ?? 0),
      ),
      updateMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: options.updateManyCount ?? 1 }),
      ),
    },
    payoutEntry: {
      createMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(options.linkedRows ?? []),
      ),
    },
    tenant: {
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.tenant === undefined
            ? { name: '商家甲', subdomain: 'shop-a' }
            : options.tenant,
        ),
      ),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      calls.push('$transaction');
      tx = {
        payout: {
          create: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() => {
            if (options.createThrows) {
              return Promise.reject(uniqueViolation());
            }
            return Promise.resolve(options.createdPayout ?? payout({}));
          }),
          // ⚠️ **撤回与拒绝跑在事务里**（改状态 + 释放明细占用是两步，
          //    必须原子）→ 条件更新与回读都在事务客户端上。
          updateMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(
            () => Promise.resolve({ count: options.updateManyCount ?? 1 }),
          ),
          findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
            Promise.resolve(options.payout ?? null),
          ),
        },
        payoutEntry: {
          createMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(
            () => Promise.resolve({ count: 1 }),
          ),
          // ⚠️ **释放明细占用**：撤回/拒绝时删掉关联行，
          //    否则商家重新申请会撞 `payout_entries` 的唯一索引 → 500。
          deleteMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(
            () => Promise.resolve({ count: 1 }),
          ),
        },
      };
      return fn(tx);
    }),
  };

  return Object.assign(prisma, {
    /** 取事务客户端（断言事务里的调用用） */
    tx: () => tx,
  });
}

/** 把假 Prisma 塞进服务（只用到 `as unknown as` 的一次性断言） */
function makeService(prisma: ReturnType<typeof fakePrisma>): PayoutService {
  return new PayoutService(prisma as unknown as never);
}

/** 在租户上下文里调用（服务层靠 `getTenantContext()` 取租户与用户） */
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: 'tenant-a', userId: 'user-a', role: null },
    async () => fn(),
  );
}

/** 在平台上下文里调用 */
function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: null, userId: 'admin-a', role: 'PLATFORM_ADMIN' },
    async () => fn(),
  );
}

describe('申请出款：周期与金额的前置校验', () => {
  it('周期未结束 → 400，且没建任何单', async () => {
    // ⚠️ **周期内的流水还会变**：此时的数字不是凭证。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
    });

    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-09' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      asTenant(() => service.apply({ period: '2025-09' })),
    ).rejects.toThrow('尚未结束');

    // ⚠️ **没建任何单**：周期校验必须在建单之前
    expect(prisma.calls).not.toContain('$transaction');
    expect(prisma.payout.findFirst).toHaveBeenCalledTimes(2);
  });

  it('该期已有活跃出款单 → 幂等返回它，且不新建', async () => {
    // ⚠️ **商家重复提交是网络重试或手滑**：报错会让商家以为申请失败。
    const existing = payout({ id: 'payout-existing', netAmount: 8888 });
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: existing,
    });

    const service = makeService(prisma);

    const view = await asTenant(() => service.apply({ period: '2025-07' }));

    expect(view.id).toBe('payout-existing');
    expect(view.netAmount).toBe(8888);
    // ⚠️ **没有建单**：金额已锁定，不重算
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('没有货款流水 → 400', async () => {
    const prisma = fakePrisma({
      receipts: [],
      statement: statement({}),
      payout: null,
    });

    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('应结金额 ≤ 0 → 400（佣金比货款还多）', async () => {
    // ⚠️ **净额为 0 或负数时不能出款**：平台倒欠商家钱的情况
    //    不该由「申请出款」这条路走。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1', amount: 1000 })],
      statement: statement({ netAmount: 2000 }),
      payout: null,
    });

    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toThrow('没有应结金额');
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('结算单未 CONFIRMED → 409（不能拿草稿单当佣金依据）', async () => {
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({ status: SettlementStatus.DRAFT }),
      payout: null,
    });

    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('没有收款账户 → 400（不知道钱打给谁）', async () => {
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      account: null,
    });

    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toThrow('收款账户');
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('⚠️ 商家侧的查询不手写 tenantId（靠租户作用域扩展自动附加）', async () => {
    // ⚠️ **手写的那份是无效的**：`withMergedWhere` 是 `{...base, ...extra}`
    //    → 扩展附的 tenantId 会**覆盖**调用方写的同键值。
    //    所以手写既不构成漏洞，也不产生任何效果 —— 它只是噪声，
    //    而且**看起来像「这里自己保证了租户隔离」**，容易误导后来者。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
    });

    const service = makeService(prisma);
    await asTenant(() => service.apply({ period: '2025-07' }));

    // ⚠️ **幂等前置查**：where 里只有周期与状态，没有 tenantId
    expect(argsOf(prisma.payout.findFirst).where).toEqual({
      periodStart: new Date('2025-07-01T00:00:00.000Z'),
      status: { notIn: [PayoutStatus.REJECTED, PayoutStatus.CANCELLED] },
    });
    // ⚠️ **收款账户查询**：没有 tenantId 条件
    expect(argsOf(prisma.merchantPayoutAccount.findFirst).where).toEqual({});
  });
});

describe('申请出款：纳入的流水在申请时就固定下来（设计 D7）', () => {
  it('payoutEntry.createMany 的 data 就是当期那几笔流水的 id', async () => {
    const prisma = fakePrisma({
      receipts: [
        receipt({ id: 'r-1' }),
        receipt({ id: 'r-2' }),
        receipt({ id: 'r-3' }),
      ],
      statement: statement({}),
      payout: null,
      createdPayout: payout({ id: 'payout-new' }),
    });

    const service = makeService(prisma);
    await asTenant(() => service.apply({ period: '2025-07' }));

    // ⚠️ **断言事务客户端上的 mock**：`payoutEntry.createMany` 跑在
    //    事务里，不是 `this.prisma` 上。
    const tx = prisma.tx();
    expect(tx).not.toBeNull();
    const createManyArgs = argsOf(tx!.payoutEntry.createMany);
    expect(createManyArgs.data).toEqual([
      { payoutId: 'payout-new', entryId: 'r-1' },
      { payoutId: 'payout-new', entryId: 'r-2' },
      { payoutId: 'payout-new', entryId: 'r-3' },
    ]);
  });

  it('查流水时带了 tenantId（归属校验）', async () => {
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      createdPayout: payout({ id: 'payout-new' }),
    });

    const service = makeService(prisma);
    await asTenant(() => service.apply({ period: '2025-07' }));

    const call = argsOf(prisma.merchantReceipt.findMany);
    expect(call.where?.tenantId).toBe('tenant-a');
    // ⚠️ **归期区间要正确**：左闭右开，与结算单同口径
    expect(call.where?.occurredAt).toEqual({
      gte: new Date('2025-07-01T00:00:00.000Z'),
      lt: new Date('2025-08-01T00:00:00.000Z'),
    });
  });
});

describe('申请出款：并发撞唯一索引要幂等，不能变成 500', () => {
  it('事务里的 create 撞 P2002 → 重新查一次并返回对方建的那张', async () => {
    // ⚠️ **这就是竞态的形态**：前置查查不到活跃单，
    //    事务里的 `create` 撞上部分唯一索引 → P2002。
    //
    // 修之前：P2002 一路冒到全局异常过滤器 → 500「服务器内部错误」。
    // 修之后：重新查一次 → 幂等返回对方刚建的那张。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      createThrows: true,
    });
    // ⚠️ **第一次查（前置）查不到，第二次查（补查）查得到**
    let lookup = 0;
    prisma.payout.findFirst.mockImplementation(() => {
      lookup += 1;
      return Promise.resolve(
        lookup === 1 ? null : payout({ id: 'payout-raced' }),
      );
    });

    const service = makeService(prisma);

    const view = await asTenant(() => service.apply({ period: '2025-07' }));

    expect(view.id).toBe('payout-raced');
    expect(prisma.payout.findFirst).toHaveBeenCalledTimes(2);
  });

  it('P2002 但补查也查不到活跃单 → 原样重抛（不伪装成「重复申请」）', async () => {
    // ⚠️ **撞的不是活跃周期那条索引**（例如 `payoutNo` 撞了）时，
    //    不能把真实原因掩盖成「你已经申请过了」。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      createThrows: true,
    });

    const service = makeService(prisma);

    let caught: unknown;
    try {
      await asTenant(() => service.apply({ period: '2025-07' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Unique constraint failed');
    expect(caught).not.toBeInstanceOf(ConflictException);
  });
});

describe('审批：必须重算金额（护栏 P5）', () => {
  it('落库的 netAmount 是重算值，requestedAmount 保留申请时的预估', async () => {
    // ⚠️ **申请与审批之间可能又来了一笔流水**：
    //    申请时预估 8000，审批时重算 9000 —— 锁定的是**审批那一刻**的值。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1', amount: 11000 })],
      statement: statement({ netAmount: 2000 }),
      payout: payout({ netAmount: 8000, requestedAmount: 8000 }),
    });

    const service = makeService(prisma);

    await asPlatform(() => service.approve('payout-a'));

    const updateCall = argsOf(prisma.payout.updateMany);
    expect(updateCall.data).toMatchObject({
      netAmount: 9000,
      receiptAmount: 11000,
      commissionAmount: 2000,
    });
    // ⚠️ **requestedAmount 不动**：它记的是申请时的预估，留给审批人比对
    expect(
      (updateCall.data as Record<string, unknown>).requestedAmount,
    ).toBeUndefined();
  });

  it('updateMany 的 where 带 status: REQUESTED（条件更新，护栏 P7）', async () => {
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: payout({}),
    });

    const service = makeService(prisma);
    await asPlatform(() => service.approve('payout-a'));

    const updateCall = argsOf(prisma.payout.updateMany);
    expect(updateCall.where).toEqual({
      id: 'payout-a',
      status: PayoutStatus.REQUESTED,
    });
  });

  it('affected.count === 0 → 409（并发下已被别人审批）', async () => {
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: payout({}),
      updateManyCount: 0,
    });

    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('出款单不存在 → 404', async () => {
    const prisma = fakePrisma({
      receipts: [],
      statement: statement({}),
      payout: null,
    });

    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
    // ⚠️ **没落库**：单都不存在，不该有任何状态或金额被改
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 审批时结算单已不是 CONFIRMED → 409（护栏 P3）', async () => {
    // ⚠️ **申请之后结算单被取消确认了**（或被重算回草稿）——
    //    那一刻锁定的佣金就是拿草稿单算的 → 账不对，必须拒绝审批。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({ status: SettlementStatus.DRAFT }),
      payout: payout({}),
    });

    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
    // ⚠️ **没有落库**：状态不能变，金额也不能锁
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 审批时重算出的应结金额已非正数 → 409', async () => {
    // ⚠️ **申请与审批之间流水变了**（订单退款冲回占优）→
    //    重算得净额为负。若原样锁进 APPROVED，
    //    5h-2 的出款流程会**按这个负数给商家打款**。
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1', amount: 1000 })],
      statement: statement({ netAmount: 5000 }),
      payout: payout({}),
    });

    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
    // ⚠️ **没有落库**：负数不能被锁成 APPROVED
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 审批时重算已无货款流水 → 409', async () => {
    const prisma = fakePrisma({
      receipts: [],
      statement: statement({}),
      payout: payout({}),
    });

    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });
});

describe('可申请周期列表：不能因为某期结算单没确认就整个挂掉', () => {
  it('某期结算单未 CONFIRMED → 该期照常列出，带上 statementStatus', async () => {
    // ⚠️ **商家端的「申请出款」页靠这个列表选周期**。
    //    若在这里抛 409，商家连别的能申请的周期都看不到 —— 整页废掉。
    const prisma = fakePrisma({
      receipts: [
        receipt({
          id: 'r-1',
          amount: 10000,
          occurredAt: new Date('2025-07-10T00:00:00.000Z'),
        }),
      ],
      statement: statement({ status: SettlementStatus.DRAFT, netAmount: 2000 }),
      payout: null,
    });

    const service = makeService(prisma);

    const views = await asTenant(() => service.availablePeriods());

    expect(views).toHaveLength(1);
    expect(views[0].period).toBe('2025-07');
    // ⚠️ **状态要如实显示**：商家得知道这期还没确认
    expect(views[0].statementStatus).toBe(SettlementStatus.DRAFT);
    expect(views[0].receiptAmount).toBe(10000);
    expect(views[0].commissionAmount).toBe(2000);
    expect(views[0].netAmount).toBe(8000);
    expect(views[0].alreadyApplied).toBe(false);
  });

  it('周期还没结束 → 不列（流水还会变此时的数字不是凭证）', async () => {
    // ⚠️ **2025-09 的周期在 2025-08-15 还没结束** → 不能申请
    const prisma = fakePrisma({
      receipts: [
        receipt({
          id: 'r-1',
          occurredAt: new Date('2025-09-10T00:00:00.000Z'),
        }),
      ],
      statement: statement({}),
      payout: null,
    });

    const service = makeService(prisma);

    const views = await asTenant(() => service.availablePeriods());

    expect(views).toHaveLength(0);
  });
});

describe('审批：拒绝必须带原因', () => {
  it('没填原因 → 400', async () => {
    const prisma = fakePrisma({ payout: payout({}) });
    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.reject('payout-a', '   ')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      asPlatform(() => service.reject('payout-a', '   ')),
    ).rejects.toThrow('必须填写原因');
    // ⚠️ **没动数据库**
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });

  it('填了原因 → 落库并置为 REJECTED', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
    });
    const service = makeService(prisma);

    await asPlatform(() => service.reject('payout-a', '结算单尚未确认'));

    // ⚠️ **断言跑在事务客户端上**：拒绝是「改状态 + 释放明细占用」两步，
    //    必须原子 → 状态更新在事务里。
    const updateCall = argsOf(prisma.tx()!.payout.updateMany);
    expect(updateCall.data).toMatchObject({
      status: PayoutStatus.REJECTED,
      rejectedReason: '结算单尚未确认',
      // ⚠️ **审批时间与审批人同填**：填了人却没填时间，
      //    视图里会出现「审批人 admin-a / 审批时间 null」的矛盾组合。
      approvedBy: 'admin-a',
    });
    expect(
      (updateCall.data as Record<string, unknown>).approvedAt,
    ).toBeInstanceOf(Date);
    // ⚠️ **释放明细占用**：被拒的单没打钱，它占着的货款流水该放回去
    expect(prisma.tx()!.payoutEntry.deleteMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout-a' },
    });
  });

  it('affected.count === 0 → 409（不能重复审批）', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
      updateManyCount: 0,
    });
    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.reject('payout-a', '原因')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('出款单不存在 → 404（与 approve 对齐）', async () => {
    // ⚠️ **「单号写错了」与「单子已处理」要能区分开**：
    //    只靠 `updateMany` 的 `affected.count === 0` 的话，
    //    这两种情况是同一个 409 —— 排查时无从下手。
    const prisma = fakePrisma({ payout: null });
    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.reject('payout-missing', '原因')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('撤回：只能撤 REQUESTED（护栏 P7）', () => {
  it('affected.count === 0 → 409', async () => {
    const prisma = fakePrisma({
      payout: payout({ status: PayoutStatus.APPROVED }),
      updateManyCount: 0,
    });
    const service = makeService(prisma);

    await expect(
      asTenant(() => service.cancel('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(asTenant(() => service.cancel('payout-a'))).rejects.toThrow(
      'APPROVED',
    );
    // ⚠️ **撤回路径上的 P7 落点**：条件更新，where 必须带 status。
    //    少了它，与平台审批并发时两个更新都会成功 → 状态机被击穿。
    // ⚠️ **断言跑在事务客户端上**：撤回是「改状态 + 释放明细占用」两步。
    expect(argsOf(prisma.tx()!.payout.updateMany).where).toEqual({
      id: 'payout-a',
      status: PayoutStatus.REQUESTED,
    });
  });

  it('查单时的 where 里没有手写的 tenantId（靠租户作用域自动过滤，护栏 P9）', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
    });
    const service = makeService(prisma);

    await asTenant(() => service.cancel('payout-a'));

    const call = argsOf(prisma.payout.findFirst);
    // ⚠️ **只能有 id**：手写 tenantId 会被扩展附的条件**覆盖**
    //    （`withMergedWhere` 是 `{...base, ...extra}`，extra = 扩展的那份），
    //    所以手写既不生效也不构成漏洞 —— 它只是让人误以为
    //    「这里自己保证了租户隔离」，实际是扩展在做。
    expect(call.where).toEqual({ id: 'payout-a' });
    expect(call.where?.tenantId).toBeUndefined();
  });

  it('⚠️ 撤回要释放明细占用（否则重新申请会撞唯一索引 → 500）', async () => {
    // ⚠️ **`payout_entries.entryId` 是全局唯一索引**：
    //    撤回的这张单若还占着那些流水，商家重新申请同一周期时
    //    `createMany` 会撞索引 → P2002 → 500。
    //    撤回的单没打钱，那些流水本就该放回去。
    const prisma = fakePrisma({
      payout: payout({}),
    });
    const service = makeService(prisma);

    await asTenant(() => service.cancel('payout-a'));

    expect(prisma.tx()!.payoutEntry.deleteMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout-a' },
    });
  });

  it('查不到单 → 404', async () => {
    const prisma = fakePrisma({ payout: null });
    const service = makeService(prisma);

    await expect(
      asTenant(() => service.cancel('payout-missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('明细归属：查流水时必须带上 tenantId（护栏 P9）', () => {
  it('查明细流水时 where.tenantId 等于 payout.tenantId', async () => {
    const prisma = fakePrisma({
      payout: payout({ tenantId: 'tenant-a' }),
      linkedRows: [{ entryId: 'r-1' }],
      receipts: [receipt({ id: 'r-1', tenantId: 'tenant-a' })],
    });
    const service = makeService(prisma);

    const detail = await asTenant(() => service.detailForTenant('payout-a'));

    expect(detail.entries).toHaveLength(1);
    expect(detail.entries[0].orderNo).toBe('ORD-r-1');

    // ⚠️ **这是真正的归属校验**：`payout_entries` 不在租户白名单里，
    //    扩展不附加任何过滤 → 这里必须自己带 tenantId。
    const call = argsOf(prisma.merchantReceipt.findMany);
    expect(call.where?.tenantId).toBe('tenant-a');
    expect(call.where?.id).toEqual({ in: ['r-1'] });
  });

  it('别家的流水查不到 → 不显示给商家', async () => {
    const prisma = fakePrisma({
      payout: payout({ tenantId: 'tenant-a' }),
      linkedRows: [{ entryId: 'r-other' }],
      // ⚠️ **脏数据**：关联行指向了别家的流水
      receipts: [],
    });
    const service = makeService(prisma);

    const detail = await asTenant(() => service.detailForTenant('payout-a'));

    expect(detail.entries).toEqual([]);
  });
});

describe('申请出款的请求体（护栏 P4：金额一律后端算）', () => {
  it('⚠️ 带了金额字段 → 校验不过（DTO 里根本没有这个属性）', () => {
    const dto = new ApplyPayoutDto();
    // ⚠️ 客户端多传一个字段，服务端**不会**报错（class-validator 默认忽略未知键）
    //    —— 所以护栏不在 DTO，而在「service 只从流水与结算单取数」这一侧。
    //    这条断言的作用是把「DTO 没有金额属性」这件事钉死：
    //    将来有人往 DTO 上加 `amount`，这条会立刻挂。
    //
    // ⚠️ **唯一的自有属性就是 `period`**：本仓库的 `target` 是 ES2023 →
    //    `useDefineForClassFields` 默认为 true → `period!: string` 这类
    //    字段声明会被编译成**实例上的自有属性**（值 undefined），
    //    所以 `Object.keys()` 看到的是 `['period']` 而不是 `[]`。
    //    真正要钉死的是「金额属性一个都没有」。
    expect(Object.keys(dto)).toEqual(['period']);
    expect('amount' in dto).toBe(false);
    expect('netAmount' in dto).toBe(false);
    expect('commissionAmount' in dto).toBe(false);
  });

  it('周期格式非法 → 校验不过', async () => {
    const dto = new ApplyPayoutDto();
    dto.period = '2025-13';
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('周期合法 → 校验过', async () => {
    const dto = new ApplyPayoutDto();
    dto.period = '2025-07';
    expect(await validate(dto)).toHaveLength(0);
  });
});
