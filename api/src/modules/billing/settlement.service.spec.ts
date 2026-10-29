import { ConflictException, NotFoundException } from '@nestjs/common';
import { CommissionEntryType, SettlementStatus } from '@prisma/client';

import { SettlementService } from './settlement.service';

/**
 * 结算单服务的**分支级**单元测试。
 *
 * ⚠️ **为什么要有这一层**：有些分支在 e2e 里**没法稳定复现** ——
 *    典型的是 `recalculate` 的 P2002 兜底：它只在「事务外的预检查」与
 *    「事务里的 `createMany`」之间存在**真实并发窗口**时才触发。
 *    e2e 里造不出这个竞态，于是这条防线就只是「碰巧没被触发」。
 *
 *    这里用一只**手写的假 Prisma** 把竞态**确定性地**造出来：
 *    预检查返回「没被别人占着」，事务里的 `createMany` 抛 P2002 ——
 *    与真实竞态的形态完全一致。
 *
 * ⚠️ **断言要具体**：断言每个分支的确切结果（抛什么错、错到第几层），
 *    不是「抛了个东西」。
 */

/** 造一个 P2002（唯一约束冲突） */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

/** 一条流水的形状（只列服务层用得到的字段） */
function entry(overrides: {
  id: string;
  tenantId?: string;
  amount?: number;
  type?: CommissionEntryType;
  occurredAt?: Date;
}) {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId ?? 'tenant-a',
    orderId: 'order-a',
    orderNo: `ORD-${overrides.id}`,
    type: overrides.type ?? CommissionEntryType.COMMISSION,
    amount: overrides.amount ?? 100,
    rateBps: 500,
    baseAmount: 20000,
    occurredAt: overrides.occurredAt ?? new Date('2024-06-10T00:00:00.000Z'),
    createdAt: new Date('2024-06-10T00:00:00.000Z'),
  };
}

/** 一张结算单的形状 */
function statement(overrides: {
  id?: string;
  tenantId?: string;
  status?: SettlementStatus;
  entryCount?: number;
  periodStart?: Date;
  periodEnd?: Date;
}) {
  return {
    id: overrides.id ?? 'stmt-a',
    tenantId: overrides.tenantId ?? 'tenant-a',
    statementNo: 'STL2024060100000001',
    periodStart: overrides.periodStart ?? new Date('2024-06-01T00:00:00.000Z'),
    periodEnd: overrides.periodEnd ?? new Date('2024-07-01T00:00:00.000Z'),
    grossAmount: 100,
    reversalAmount: 0,
    netAmount: 100,
    entryCount: overrides.entryCount ?? 1,
    status: overrides.status ?? SettlementStatus.DRAFT,
    confirmedAt: null,
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    updatedAt: new Date('2024-06-01T00:00:00.000Z'),
  };
}

/**
 * 一只最小可用的假 Prisma。
 *
 * ⚠️ **只实现服务层真正用到的那几个方法**：多写一个就多一处
 *    「测试里的假实现与真实 Prisma 行为不一致」的风险。
 */
function fakePrisma(options: {
  /** 当期流水 */
  entries?: ReturnType<typeof entry>[];
  /** 结算单 */
  statement?: ReturnType<typeof statement>;
  /** 已经被别的单据占着的流水（`statementId` ≠ 本单） */
  linkedByOthers?: Array<{ entryId: string; statementId: string }>;
  /** 事务里的 `createMany` 要不要抛 P2002 */
  createManyThrows?: boolean;
  /** `updateMany` 影响多少行 */
  affectedCount?: number;
  /** `settlementStatementEntry.findMany` 的返回值 */
  linkedRows?: Array<{ entryId: string; statementId: string }>;
  /**
   * `settlementStatement.findFirst` 的返回值**序列**。
   *
   * ⚠️ **需要序列而不是单个值**：`unconfirm` 会查两次 ——
   *    第一次读「当前状态」（据此决定能不能取消确认），
   *    第二次读「改完之后的状态」（据此报错文案）。
   *    两次的值可以不同（并发下被别人改过）。
   */
  statements?: Array<ReturnType<typeof statement> | null>;
  /**
   * 批量模式下 `groupBy` 返回的商家 id 列表。
   *
   * ⚠️ **为什么需要单独配**：真实数据库里，`groupBy`（按 `occurredAt` 过滤）
   *    与 `entriesInPeriod`（按 `tenantId` + `occurredAt` 过滤）读的是同一批行，
   *    结果必然一致 —— 「商家进了 groupBy 却没有当期流水」**只可能**是
   *    两次查询之间的竞态（流水被删/改期）。
   *    e2e 造不出这个竞态，于是这里用手写假 Prisma **确定性地**造出来：
   *    `groupBy` 返回这家，`findMany` 查不到它的流水。
   */
  groupByTenants?: string[];
  /**
   * 引用了这张结算单的出款单（阶段 5h-1，护栏 P6）。
   *
   * ⚠️ **非空 → 取消确认被拒**：出款单的佣金金额是审批那一刻的快照，
   *    结算单被取消确认后重算 → 佣金变了 → 已批的出款单金额失真。
   *
   * ⚠️ **`statementId` 与 `status` 都要给**：假 Prisma 的 `payout.findFirst`
   *    按 `where` 过滤（否则闸的查询条件就完全没被测试保护）。
   */
  referencedPayout?: {
    id: string;
    statementId: string;
    status: string;
  } | null;
}) {
  const calls: string[] = [];
  let statementLookup = 0;

  const prisma = {
    calls,
    databaseNow: jest.fn(() =>
      Promise.resolve(new Date('2026-10-29T00:00:00.000Z')),
    ),
    settlementStatement: {
      findFirst: jest.fn(() => {
        statementLookup += 1;
        if (options.statements) {
          // ⚠️ **序列是「每次调用一轮」**：同一个用例里可能调用多次
          //    （断言消息与断言类型各调一次）→ 计数按轮重置，
          //    否则第二次调用会读到 `undefined` → 「结算单不存在」。
          const index = (statementLookup - 1) % options.statements.length;
          return Promise.resolve(options.statements[index] ?? null);
        }
        return Promise.resolve(options.statement ?? null);
      }),
      updateMany: jest.fn(() =>
        Promise.resolve({ count: options.affectedCount ?? 1 }),
      ),
    },
    commissionEntry: {
      // ⚠️ **按 `where.tenantId` 过滤**：`entriesInPeriod` 是「某商家某期」的流水，
      //    假实现必须按租户分，否则「这家查不到流水」的分支永远走不到。
      findMany: jest.fn((args?: { where?: { tenantId?: string } }) => {
        const rows = options.entries ?? [];
        const tenantId = args?.where?.tenantId;
        return Promise.resolve(
          tenantId ? rows.filter((row) => row.tenantId === tenantId) : rows,
        );
      }),
      // ⚠️ **批量模式用它找出「该期有流水的商家」**：
      //    没有它，批量分支根本走不到 `generateOne`。
      groupBy: jest.fn(() =>
        Promise.resolve(
          options.groupByTenants
            ? options.groupByTenants.map((tenantId) => ({ tenantId }))
            : (options.entries ?? []).map((row) => ({
                tenantId: row.tenantId,
              })),
        ),
      ),
    },
    settlementStatementEntry: {
      findMany: jest.fn(() => Promise.resolve(options.linkedRows ?? [])),
      deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
      createMany: jest.fn(() => {
        calls.push('createMany');
        if (options.createManyThrows) {
          return Promise.reject(uniqueViolation());
        }
        return Promise.resolve({ count: 1 });
      }),
    },
    // ⚠️ **出款单（阶段 5h-1）**：`unconfirm` 要先问一句
    //    「这张结算单有没有被出款单引用」—— 没有它，闸根本走不到。
    //
    //    ⚠️ **这个桩要按 `where` 过滤**：闸的全部语义就是那两条条件
    //    （`statementId` 匹配 + 状态不在终态里）。若桩无视 `where`，
    //    把生产代码里的 `statementId` 或 `status` 删掉，单测照样绿 ——
    //    闸的核心逻辑就完全没被测试保护。
    payout: {
      findFirst: jest.fn(
        (args?: {
          where?: { statementId?: string; status?: { notIn?: string[] } };
        }) => {
          const referenced = options.referencedPayout ?? null;
          if (!referenced) {
            return Promise.resolve(null);
          }
          const where = args?.where;
          if (
            where?.statementId !== undefined &&
            where.statementId !== referenced.statementId
          ) {
            return Promise.resolve(null);
          }
          const notIn = where?.status?.notIn;
          if (notIn && notIn.includes(referenced.status)) {
            return Promise.resolve(null);
          }
          return Promise.resolve(referenced);
        },
      ),
    },
    tenant: {
      findFirst: jest.fn(() =>
        Promise.resolve({ name: '商家甲', subdomain: 'shop-a' }),
      ),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      calls.push('$transaction');
      const tx = {
        settlementStatementEntry: {
          deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
          createMany: jest.fn(() => {
            calls.push('createMany');
            if (options.createManyThrows) {
              return Promise.reject(uniqueViolation());
            }
            return Promise.resolve({ count: 1 });
          }),
        },
        settlementStatement: {
          // ⚠️ **出单路径要它**：没有 `create` 的话「新建成功」那条分支
          //    在假 Prisma 里根本走不完（`create` 之后还要 `createMany` 明细）。
          create: jest.fn(() => Promise.resolve(options.statement ?? null)),
          updateMany: jest.fn(() =>
            Promise.resolve({ count: options.affectedCount ?? 1 }),
          ),
          findFirst: jest.fn(() => Promise.resolve(options.statement ?? null)),
        },
      };
      return fn(tx);
    }),
  };

  return prisma;
}

/** 把假 Prisma 塞进服务（只用到 `as unknown as` 的一次性断言） */
function makeService(prisma: ReturnType<typeof fakePrisma>): SettlementService {
  return new SettlementService(prisma as unknown as never);
}

describe('重算：P2002 不能逃逸成 500', () => {
  it('事务里的 createMany 撞 P2002 → 补跑预检查后抛 409', async () => {
    // ⚠️ **这就是竞态的形态**：事务外的预检查查不到冲突
    //    （`linkedRows` 为空 → `assertEntriesNotSettledByOthers` 放行），
    //    但事务里的 `createMany` 撞上了唯一索引。
    //
    //    修之前：P2002 一路冒到全局异常过滤器 → 500「服务器内部错误」。
    //    修之后：补跑一次预检查 → 409「这些流水已经被别的结算单结算过了」。
    //
    //    ⚠️ **补跑时的预检查返回的冲突行与事务内不同**：
    //    真实竞态里「事务外的查询」早于「别人抢先占住」，
    //    而「事务回滚后的补查」晚于它 —— 所以补查能看到冲突。
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statement: statement({}),
      // ⚠️ **事务里的 `createMany` 撞唯一索引**：
      //    这正是竞态发生的那一瞬 —— 事务外的预检查已经过去了。
      createManyThrows: true,
      // ⚠️ **第一次查（预检查）查不到，第二次查（补查）查得到**：
      //    用调用次数区分「预检查」与「补跑」。
      linkedRows: [],
    });
    let lookup = 0;
    prisma.settlementStatementEntry.findMany.mockImplementation(() => {
      lookup += 1;
      return Promise.resolve(
        lookup === 1 ? [] : [{ entryId: 'entry-1', statementId: 'stmt-other' }],
      );
    });

    const service = makeService(prisma);

    // ⚠️ **只调用一次**：`findMany` 的计数器按调用次数推进，
    //    调两次会让第二次的预检查直接查到冲突（走的是另一条路径）。
    let caught: unknown;
    try {
      await service.recalculate('stmt-a');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as Error).message).toContain('已经被别的结算单结算过了');

    // ⚠️ **事务确实跑过了**（不是「预检查就拦住了」）：
    //    否则这条用例证明不了「补跑预检查」这件事。
    expect(prisma.calls).toContain('createMany');
    // ⚠️ **预检查确实查了两次**：一次在事务前，一次在 P2002 之后
    expect(prisma.settlementStatementEntry.findMany).toHaveBeenCalledTimes(2);
  });

  it('P2002 但补跑预检查也没冲突 → 原样重抛（不伪装成「重复结算」）', async () => {
    // ⚠️ **撞的不是 `entryId` 时不能撒谎**：
    //    把别的故障说成「流水重复结算」，排查的人会去查错的东西。
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statement: statement({}),
      createManyThrows: true,
      linkedRows: [],
    });

    const service = makeService(prisma);

    let caught: unknown;
    try {
      await service.recalculate('stmt-a');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Unique constraint failed');
    // ⚠️ **不能是 ConflictException**（那会把真实原因掩盖掉）
    expect(caught).not.toBeInstanceOf(ConflictException);
  });
});

describe('重算：当期没有流水时不能抹成空单', () => {
  it('当期查不到流水 → 409，且不进入事务', async () => {
    const prisma = fakePrisma({
      entries: [],
      statement: statement({}),
    });

    const service = makeService(prisma);

    await expect(service.recalculate('stmt-a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.recalculate('stmt-a')).rejects.toThrow('已无抽佣流水');

    // ⚠️ **事务根本没跑**：跑了就意味着「先删了关联行再重建」——
    //    那样单据就被抹成 0/0/0 了。
    expect(prisma.calls).not.toContain('$transaction');
  });
});

describe('取消确认：必须检查 updateMany 的 affected.count', () => {
  it('affected.count = 0（并发下已被别人改过）→ 409', async () => {
    // ⚠️ **第一次读到 CONFIRMED**（够格取消确认），
    //    **第二次读到 PAID**（并发下已被别人改成已出款），
    //    而 `updateMany` 影响 0 行 —— 这正是原来那段代码会静默成功的场景。
    const prisma = fakePrisma({
      statements: [
        statement({ status: SettlementStatus.CONFIRMED }),
        statement({ status: SettlementStatus.PAID }),
      ],
      affectedCount: 0,
    });

    const service = makeService(prisma);

    await expect(service.unconfirm('stmt-a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // ⚠️ **消息里要带上实际状态**：
    //    「现在是 PAID」与「现在是 DRAFT」要能被区分开。
    await expect(service.unconfirm('stmt-a')).rejects.toThrow('PAID');
  });

  it('affected.count = 1 → 正常返回 DRAFT', async () => {
    const prisma = fakePrisma({
      statements: [
        statement({ status: SettlementStatus.CONFIRMED }),
        statement({ status: SettlementStatus.DRAFT }),
      ],
      affectedCount: 1,
    });

    const service = makeService(prisma);
    const view = await service.unconfirm('stmt-a');

    expect(view.status).toBe(SettlementStatus.DRAFT);
  });
});

describe('取消确认：已被出款单引用的结算单不能取消确认（护栏 P6）', () => {
  it('有出款单引用 → 409，且不进入更新', async () => {
    // ⚠️ **出款单的佣金金额是审批那一刻的快照**：
    //    结算单被取消确认后重算 → 佣金变了 → 已批的出款单金额失真
    //    → 平台打出去的钱与账对不上。
    const prisma = fakePrisma({
      statements: [statement({ status: SettlementStatus.CONFIRMED })],
      referencedPayout: {
        id: 'payout-a',
        statementId: 'stmt-a',
        status: 'APPROVED',
      },
    });

    const service = makeService(prisma);

    await expect(service.unconfirm('stmt-a')).rejects.toThrow('出款单');
    await expect(service.unconfirm('stmt-a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // ⚠️ **状态不能变**：闸要拦在更新之前
    expect(prisma.settlementStatement.updateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 闸的查询条件必须带 statementId 与状态过滤', async () => {
    // ⚠️ **闸的全部语义就是那两条条件**：
    //    「是不是这张结算单」+「这张单有没有打钱」。
    //    少一条 → 别的结算单的出款单会拦住本单，或已拒绝的单也拦住。
    const prisma = fakePrisma({
      statements: [statement({ status: SettlementStatus.CONFIRMED })],
      referencedPayout: {
        id: 'payout-a',
        statementId: 'stmt-a',
        status: 'APPROVED',
      },
    });

    const service = makeService(prisma);
    await expect(service.unconfirm('stmt-a')).rejects.toBeInstanceOf(
      ConflictException,
    );

    const [call] = prisma.payout.findFirst.mock.calls;
    expect(call).toBeDefined();
    expect(call?.[0]?.where).toEqual({
      statementId: 'stmt-a',
      status: { notIn: ['REJECTED', 'CANCELLED', 'FAILED'] },
    });
  });

  it('⚠️ 已拒绝 / 已撤回的出款单不拦（闸不能挡过头）', async () => {
    // ⚠️ **那两种状态没有打钱**，不构成「钱已经出去了」的事实
    //    → 不该拦住修正漏结的路径。
    const prisma = fakePrisma({
      // ⚠️ **两次读**：第一次读「当前状态」（据此决定能不能取消确认），
      //    第二次读「改完之后的状态」（据此返回视图）。
      statements: [
        statement({ status: SettlementStatus.CONFIRMED }),
        statement({ status: SettlementStatus.DRAFT }),
      ],
      referencedPayout: {
        id: 'payout-a',
        statementId: 'stmt-a',
        status: 'REJECTED',
      },
    });

    const service = makeService(prisma);
    const view = await service.unconfirm('stmt-a');

    expect(view.status).toBe(SettlementStatus.DRAFT);
  });
});

describe('批量生成：单个商家的冲突要收集起来', () => {
  it('一个商家冲突 → 其余商家照常出单，冲突进 conflicts', async () => {
    // ⚠️ **每个商家各自提交事务**：前一个商家已经落库了，
    //    中途抛 409 会让调用方**无从得知哪几张已生成**。
    //
    //    ⚠️ **`statements: [null]`**：`generateOne` 的「先查后插」查不到
    //    已有单据 → 走「取流水 → 查有没有被别人结算过」→ 撞上冲突。
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statements: [null],
      linkedRows: [{ entryId: 'entry-1', statementId: 'stmt-other' }],
    });

    const service = makeService(prisma);

    // 批量：没有 tenantId
    const result = await service.generate({ period: '2024-06' });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].tenantId).toBe('tenant-a');
    expect(result.conflicts[0].message).toContain('已经被结算过了');
    expect(result.created).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('显式点名商家而这家冲突 → 直接抛 409（不收集）', async () => {
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statements: [null],
      linkedRows: [{ entryId: 'entry-1', statementId: 'stmt-other' }],
    });

    const service = makeService(prisma);

    await expect(
      service.generate({ period: '2024-06', tenantId: 'tenant-a' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('批量生成：某个商家当期没有流水 → 必须记进 conflicts', () => {
  it('批量里某商家查不到流水 → 记进 conflicts，其余商家照常出单', async () => {
    // ⚠️ **为什么这条只能写在单元测试里**：
    //    真实数据库里，「商家进了 `groupBy` 却没有当期流水」**只可能**是
    //    两次查询之间的竞态（流水在 `groupBy` 之后被删/改期）。
    //    e2e 造不出这个竞态 —— 直接改数据库改的是**两次查询之前**的状态，
    //    `groupBy` 与 `entriesInPeriod` 读到的仍然是同一批行。
    //    于是这里用手写假 Prisma **确定性地**把它造出来：
    //    `groupBy` 返回两家，`findMany` 只查得到其中一家的流水。
    //
    // ⚠️ **修之前**：这家商家被**静默跳过** —— 不在 `items`、不在 `conflicts`、
    //    也不在 `stale` → 调用方看到少了一个商家，却**没有任何标记**，
    //    根本不会想到去查这家。
    const prisma = fakePrisma({
      // ⚠️ **两家**：一家有流水能出单，一家「有商家、无流水」。
      groupByTenants: ['tenant-a', 'tenant-b'],
      entries: [entry({ id: 'entry-a', tenantId: 'tenant-a' })],
      // ⚠️ **没有既有单据** → 走「新建」分支。
      statements: [null],
      // ⚠️ **新建出来的单据**（事务里 `create` 的返回值）。
      statement: statement({ tenantId: 'tenant-a' }),
    });

    const service = makeService(prisma);

    const result = await service.generate({ period: '2024-06' });

    // ⚠️ **没流水的这家必须出现在 conflicts 里**（这是本次要锁住的行为）
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].tenantId).toBe('tenant-b');
    // ⚠️ **消息要说清原因**：光有商家 id，排查的人不知道该去看什么
    expect(result.conflicts[0].message).toContain('2024-06');
    expect(result.conflicts[0].message).toContain('没有抽佣流水');

    // ⚠️ **其余商家照常出单**：不能因为一个商家没流水就中断整批
    expect(result.created).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].tenantId).toBe('tenant-a');
    // ⚠️ **没流水的这家不该有单据**
    expect(result.items.some((item) => item.tenantId === 'tenant-b')).toBe(
      false,
    );
    // ⚠️ **它也不该被标成「过时」**：过时说的是「有单但缺笔」，
    //    这家根本没有单 —— 两件事不能混
    expect(result.stale).toEqual([]);
  });

  it('显式点名而这家当期没有流水 → 仍然抛 404（不收集进 conflicts）', async () => {
    // ⚠️ **点名与批量是两套语义**：点名时调用方明确知道是哪一家 →
    //    直接抛 404 更直接，收集起来反而要他自己去列表里找。
    const prisma = fakePrisma({
      groupByTenants: ['tenant-b'],
      entries: [],
      statements: [null],
    });

    const service = makeService(prisma);

    await expect(
      service.generate({ period: '2024-06', tenantId: 'tenant-b' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.generate({ period: '2024-06', tenantId: 'tenant-b' }),
    ).rejects.toThrow('没有抽佣流水');
  });
});
