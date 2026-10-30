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
  /**
   * **可变**的流水集合（阶段 5j 缺笔检测用）。
   *
   * ⚠️ **为什么单独一份**：缺笔检测的本质是「结算单生成之后又进了新流水」，
   *    也就是**集合在两次调用之间变了**。`options.entries` 是静态的，
   *    改它要改 options 本身 → 改不到「两次调用看到不同数据」。
   */
  mutableEntries?: ReturnType<typeof entry>[];
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

  /**
   * 当前可见的流水集合。
   *
   * ⚠️ **`mutableEntries` 优先**：阶段 5j 的缺笔检测要测「两次调用之间
   *    流水集合变了」，静态的 `options.entries` 做不到这一点。
   */
  const visibleEntries = (): ReturnType<typeof entry>[] =>
    options.mutableEntries ?? options.entries ?? [];

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
      // ⚠️ **列表页用**：按 `where` 过滤（本 spec 只用到 `periodStart` 精确匹配）。
      findMany: jest.fn((args?: { where?: { periodStart?: Date } }) => {
        const rows = options.statements?.filter(Boolean) ?? [];
        const periodStart = args?.where?.periodStart;
        if (!periodStart) {
          return Promise.resolve(rows);
        }
        return Promise.resolve(
          rows.filter(
            (row) => row?.periodStart.getTime() === periodStart.getTime(),
          ),
        );
      }),
      count: jest.fn(() =>
        Promise.resolve((options.statements?.filter(Boolean) ?? []).length),
      ),
    },
    commissionEntry: {
      // ⚠️ **按 `where.tenantId` 过滤**：`entriesInPeriod` 是「某商家某期」的流水，
      //    假实现必须按租户分，否则「这家查不到流水」的分支永远走不到。
      findMany: jest.fn(
        (args?: {
          where?: {
            tenantId?: string | { in: string[] };
            occurredAt?: { gte?: Date; lt?: Date };
          };
        }) => {
          const rows = visibleEntries();
          const where = args?.where;
          let filtered = rows;
          if (where?.tenantId) {
            const ids =
              typeof where.tenantId === 'string'
                ? [where.tenantId]
                : where.tenantId.in;
            filtered = filtered.filter((row) => ids.includes(row.tenantId));
          }
          if (where?.occurredAt) {
            const { gte, lt } = where.occurredAt;
            filtered = filtered.filter((row) => {
              if (gte && row.occurredAt.getTime() < gte.getTime()) return false;
              if (lt && row.occurredAt.getTime() >= lt.getTime()) return false;
              return true;
            });
          }
          return Promise.resolve(filtered);
        },
      ),
      // ⚠️ **缺笔检测用**：当期真实流水笔数。
      count: jest.fn(
        (args?: {
          where?: {
            tenantId?: string | { in: string[] };
            occurredAt?: { gte?: Date; lt?: Date };
          };
        }) => {
          const where = args?.where;
          return Promise.resolve(
            visibleEntries().filter((row) => {
              if (where?.tenantId) {
                const ids =
                  typeof where.tenantId === 'string'
                    ? [where.tenantId]
                    : where.tenantId.in;
                if (!ids.includes(row.tenantId)) {
                  return false;
                }
              }
              if (where?.occurredAt) {
                const { gte, lt } = where.occurredAt;
                if (gte && row.occurredAt.getTime() < gte.getTime())
                  return false;
                if (lt && row.occurredAt.getTime() >= lt.getTime())
                  return false;
              }
              return true;
            }).length,
          );
        },
      ),
      // ⚠️ **批量模式用它找出「该期有流水的商家」**：
      //    没有它，批量分支根本走不到 `generateOne`。
      groupBy: jest.fn(() =>
        Promise.resolve(
          options.groupByTenants
            ? options.groupByTenants.map((tenantId) => ({ tenantId }))
            : visibleEntries().map((row) => ({
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
      // ⚠️ **列表 / 详情用**（`toViews` 批量查商家名）。
      findMany: jest.fn((args?: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in;
        const row = {
          id: 'tenant-a',
          name: '商家甲',
          subdomain: 'shop-a',
        };
        return Promise.resolve(ids && !ids.includes(row.id) ? [] : [row]);
      }),
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

describe('缺笔检测（阶段 5j）', () => {
  it('⚠️ 当期又进了新流水 → 该期缺笔，missingEntryCount > 0', async () => {
    // ⚠️ **缺笔的本质**：结算单生成之后，同一期又进了新流水
    //    （典型来源：跑了一次 `npm run backfill:commissions`）→
    //    结算单的 `entryCount` 与当期真实笔数对不上 →
    //    **平台少收了 / 商家少拿了钱**，却没人看得见。
    //
    // ⚠️ **用可变集合造这个时序**：结算单先存在（纳入 1 笔），
    //    随后流水集合变成 2 笔 → 差值就是缺笔数。
    const mutableEntries = [entry({ id: 'entry-1' })];

    const prisma = fakePrisma({
      mutableEntries,
      statement: statement({ entryCount: 1 }),
      // ⚠️ **第一次查不到既有单据** → 走「新建」分支；
      //    之后的查询都查得到那张单（详情页要用）。
      statements: [
        null,
        statement({ entryCount: 1 }),
        statement({ entryCount: 1 }),
      ],
    });

    const service = makeService(prisma);

    // ---- 生成结算单时：当期 1 笔 → 不缺笔 ----
    const result = await service.generate({
      period: '2024-06',
      tenantId: 'tenant-a',
    });
    expect(result.created).toBe(1);

    // ---- 随后往同一期补一笔抽佣流水 ----
    mutableEntries.push(
      entry({
        id: 'entry-2',
        occurredAt: new Date('2024-06-20T00:00:00.000Z'),
      }),
    );

    const view = await service.detail('stmt-a');
    // ⚠️ **当期真实 2 笔、结算单只纳入 1 笔 → 缺 1 笔**
    expect(view.missingEntryCount).toBe(1);
  });

  it('⚠️ 单张视图的缺笔数要按整期算（actualEntryCount 那一支）', async () => {
    // ⚠️ **为什么这条用例走 `generate` 而不是 `detail`**：
    //    `detail` / `list` 走的是 `toViews` 的**批量**路径
    //    （`missingEntryCounts`，一次查完再在内存里分桶）→
    //    **根本不经过 `actualEntryCount`**。
    //    `actualEntryCount` 只在**单张**视图（`toView` → `missingEntryCountOf`）
    //    里被调用，而 `generate` / `recalculate` / `confirm` / `unconfirm`
    //    返回的都是单张视图 → 这几个入口才驱动得到这一支。
    //
    // ⚠️ **为什么这一支必须有测试保护**：两条路径（批量 / 单张）**各写一份**
    //    缺笔算法 → 口径漂了没人知道。这里锁住「单张」这一支。
    //
    // ⚠️ **样本要铺开在整期里**（月初 + 月末）：
    //    若把周期窗口收窄成只有一天，月末那笔就查不到 →
    //    「当期真实笔数」被算小 → 缺笔数被算小 → 这条用例会挂。
    const prisma = fakePrisma({
      entries: [
        // ⚠️ **月初那笔**
        entry({
          id: 'entry-early',
          occurredAt: new Date('2024-06-02T00:00:00.000Z'),
        }),
        // ⚠️ **月末那笔**：窗口收窄成只有一天时，这笔就查不到了
        entry({
          id: 'entry-late',
          occurredAt: new Date('2024-06-25T00:00:00.000Z'),
        }),
      ],
      // ⚠️ **新建出来的结算单**：纳入 2 笔（当期真实也是 2 笔）→ 不缺笔
      statement: statement({ entryCount: 2 }),
      // ⚠️ **第一次查不到既有单据** → 走「新建」分支 → 返回单张视图
      statements: [null],
    });

    const service = makeService(prisma);

    const result = await service.generate({
      period: '2024-06',
      tenantId: 'tenant-a',
    });

    expect(result.created).toBe(1);
    expect(result.items).toHaveLength(1);
    // ⚠️ **当期真实 2 笔、纳入 2 笔 → 不缺笔**。
    //    若 `actualEntryCount` 的周期窗口被收窄成只有一天，
    //    「当期真实」会变成 0 笔 → 这里仍然是 0 → 这条断言就废了。
    //    → 所以下面还要补一笔当期流水再断言 1（见下一条用例）。
    expect(result.items[0].missingEntryCount).toBe(0);
    // ⚠️ **`actualEntryCount` 真的被调用了**（走的是 `count` 而不是 `findMany`）
    expect(prisma.commissionEntry.count).toHaveBeenCalled();
    // ⚠️ **查的区间必须覆盖整期** —— 不是只有第一天。
    //    这条断言直接锁住「周期窗口」这个参数：窗口收窄成一天 → 挂。
    const [countCall] = prisma.commissionEntry.count.mock.calls;
    expect(countCall?.[0]?.where?.occurredAt).toEqual({
      gte: new Date('2024-06-01T00:00:00.000Z'),
      lt: new Date('2024-07-01T00:00:00.000Z'),
    });
  });

  it('⚠️ 单张视图：当期又进了新流水 → 缺笔数是 1（actualEntryCount 那一支）', async () => {
    // ⚠️ **这条是上一条的「反面」**：上一条只断言「不缺笔」，
    //    万一 `actualEntryCount` **恒返回 0**，上一条照样绿
    //    （0 笔 − 2 笔 → 截断成 0）。
    //    → 必须有一条「真实笔数 > 纳入笔数」的用例，才能证明
    //    `actualEntryCount` **真的数到了**那几笔。
    //
    // ⚠️ **样本铺在整期里**：月初 1 笔 + 月末 1 笔（结算单纳入 1 笔）
    //    → 当期真实 2 笔 → 缺 1 笔。
    //    若周期窗口被收窄成只有一天，真实笔数会变成 1 → 缺 0 笔 → 挂。
    const prisma = fakePrisma({
      entries: [
        entry({
          id: 'entry-early',
          occurredAt: new Date('2024-06-02T00:00:00.000Z'),
        }),
        entry({
          id: 'entry-late',
          occurredAt: new Date('2024-06-25T00:00:00.000Z'),
        }),
      ],
      // ⚠️ **结算单只纳入 1 笔** → 当期真实 2 笔 → 缺 1 笔
      statement: statement({ entryCount: 1 }),
      statements: [null],
    });

    const service = makeService(prisma);

    const result = await service.generate({
      period: '2024-06',
      tenantId: 'tenant-a',
    });

    expect(result.created).toBe(1);
    expect(result.items).toHaveLength(1);
    // ⚠️ **缺 1 笔**：真实 2 笔（月初 + 月末）、纳入 1 笔
    expect(result.items[0].missingEntryCount).toBe(1);
  });

  it('⚠️ 没有缺笔时 missingEntryCount 是 0', async () => {
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statement: statement({ entryCount: 1 }),
      statements: [statement({ entryCount: 1 })],
    });

    const service = makeService(prisma);
    const view = await service.detail('stmt-a');

    expect(view.missingEntryCount).toBe(0);
  });

  it('⚠️ 缺笔时 canRecalculate 要看有没有出款单引用（P6 闸）', async () => {
    // ⚠️ **有出款单引用 → 不能靠「取消确认 → 重算」修正**：
    //    出款单的佣金金额是审批那一刻的快照，改了就与已批的单对不上。
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statement: statement({ entryCount: 1 }),
      statements: [statement({ entryCount: 1 })],
      referencedPayout: {
        id: 'payout-a',
        statementId: 'stmt-a',
        status: 'APPROVED',
      },
    });

    const service = makeService(prisma);
    const view = await service.detail('stmt-a');

    expect(view.canRecalculate).toBe(false);
  });

  it('⚠️ 没有出款单引用 → 可以靠「取消确认 → 重算」修正', async () => {
    const prisma = fakePrisma({
      entries: [entry({ id: 'entry-1' })],
      statement: statement({ entryCount: 1 }),
      statements: [statement({ entryCount: 1 })],
      referencedPayout: null,
    });

    const service = makeService(prisma);
    const view = await service.detail('stmt-a');

    expect(view.canRecalculate).toBe(true);
  });

  it('⚠️ 列表页的缺笔数要批量查（不能每行查一次）', async () => {
    // ⚠️ **列表最多 200 行** → 「每行查一次」就是 200 次额外查询。
    //    缺笔数必须**一次**查完再在内存里分桶。
    const prisma = fakePrisma({
      entries: [
        entry({
          id: 'entry-1',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-06-10T00:00:00.000Z'),
        }),
        entry({
          id: 'entry-2',
          tenantId: 'tenant-b',
          occurredAt: new Date('2024-06-10T00:00:00.000Z'),
        }),
      ],
      statements: [
        statement({ id: 'stmt-a', tenantId: 'tenant-a', entryCount: 1 }),
        statement({ id: 'stmt-b', tenantId: 'tenant-b', entryCount: 1 }),
      ],
    });

    const service = makeService(prisma);
    const result = await service.list({ page: 1, pageSize: 50 });

    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.missingEntryCount === 0)).toBe(
      true,
    );
    // ⚠️ **流水的查询不能是「每行一次」** —— 只查一次（区间取数）
    expect(prisma.commissionEntry.findMany).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 跨期流水按自己的 occurredAt 归期（不按账单的 periodStart 窗口）', async () => {
    // ⚠️ **归期是流水自己的 `occurredAt` 说了算** —— 不是账单的周期说了算。
    //    跨期回填的流水（6 月的订单、7 月退款）归期在 **7 月**，
    //    不能算进 6 月那一期的缺笔数里。
    //
    // ⚠️ **样本必须「落在查询区间内、但归期属于别的期」**：
    //    列表页一次查出的区间是 `min(periodStart)` 到 `max(periodEnd)`，
    //    7 月那笔**会被查出来** → 正是「查出来了但不能算进 6 月」这个场景。
    //    如果样本落在区间外，它在分组之前就被过滤掉了 → 这条用例没有牙齿。
    //
    // ⚠️ **账单周期被改宽（脏数据）时两种口径才会分叉**：
    //    结算单的 `periodEnd` 是数据库里的一个字段，手工改过就会比自然月宽
    //    （`settlement.service.ts` 里明确把「手工改过 periodEnd」列为
    //    要防的脏数据）。这时「按账单窗口算」会把 7 月那笔算进 6 月，
    //    「按流水自己的 `occurredAt` 算」则不会 —— 规格点名要后者。
    const prisma = fakePrisma({
      entries: [
        // ⚠️ **6 月的流水**：6 月那一期的真实笔数
        entry({
          id: 'entry-june',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-06-10T00:00:00.000Z'),
        }),
        // ⚠️ **跨期回填**：6 月的订单在 7 月退款 → 归期在 **7 月**
        entry({
          id: 'entry-july',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-07-20T00:00:00.000Z'),
        }),
      ],
      statements: [
        // ⚠️ **6 月那张单**：纳入 1 笔（就是 6 月那笔）。
        //    ⚠️ `periodEnd` 被手工改到了 7 月底 → 账单窗口比自然月宽，
        //    跨进了 7 月 → 「按窗口归期」与「按 occurredAt 归期」在这里分叉。
        statement({
          id: 'stmt-june',
          tenantId: 'tenant-a',
          entryCount: 1,
          periodStart: new Date('2024-06-01T00:00:00.000Z'),
          periodEnd: new Date('2024-07-31T00:00:00.000Z'),
        }),
      ],
    });

    const service = makeService(prisma);
    const result = await service.list({ page: 1, pageSize: 50 });

    const june = result.items.find((item) => item.id === 'stmt-june');
    expect(june).toBeDefined();

    // ⚠️ **6 月那期不缺笔**：当期真实流水就是纳入的那 1 笔。
    //    7 月那笔**不能算进 6 月**（它归期在 7 月）。
    expect(june?.missingEntryCount).toBe(0);
  });

  it('⚠️ periodEnd 被改宽时，单张路径与批量路径的缺笔数必须一致', async () => {
    // ⚠️ **这条锁的是「同一个口径在两条路径上分叉」的 bug**：
    //    平台端有**两条路径**算缺笔数 ——
    //      · 单张（`generate` / `recalculate` / `confirm` / `unconfirm`
    //        → `toView` → `missingEntryCountOf` → `actualEntryCount`）
    //      · 批量（`detail` / `list` → `toViews` → `missingEntryCounts`）
    //    两条路径**各写一份**缺笔算法 → 口径漂了没人知道。
    //
    // ⚠️ **分叉的触发条件是「`periodEnd` 被手工改宽」**：
    //    `periodEnd` 是数据库里的一个字段，可以被人手工改宽（脏数据）。
    //    改宽之后：
    //      · 单张路径若拿 `statement.periodEnd` 当上界 → 会把 7 月的流水
    //        算进 6 月这一期 → 报「缺 1 笔」；
    //      · 批量路径按每笔流水自己的 `occurredAt` 归期 → 7 月那笔归 7 月
    //        → 报「不缺笔」。
    //    → **同一张结算单，列表页说缺 1 笔、详情页说不缺笔** —— 超管
    //    看到两个互相矛盾的数字，根本不知道该信哪个。
    //
    // ⚠️ **修法是两条路径同源**：单张路径的上界改用
    //    「按周期标识反推出来的标准区间」（`resolveMonthlyPeriod`），
    //    不再用可被改宽的 `statement.periodEnd`。
    //
    // ⚠️ **样本**：6 月 1 笔 + 7 月 1 笔（7 月那笔落在改宽后的窗口内
    //    → 单张路径查得到它 → 正好是分叉的那个场景）；结算单纳入 1 笔。
    const prisma = fakePrisma({
      entries: [
        // ⚠️ **6 月的流水**：6 月那一期的真实笔数
        entry({
          id: 'entry-june',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-06-15T00:00:00.000Z'),
        }),
        // ⚠️ **7 月的流水**：归期在 7 月，**不该**算进 6 月这一期
        entry({
          id: 'entry-july',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-07-15T00:00:00.000Z'),
        }),
      ],
      // ⚠️ **两次查都要查得到这张脏单**：
      //    第一次给 `generate`（复用既有单 → 返回**单张**视图），
      //    第二次给 `detail`（走**批量**路径）。
      statements: [
        // ⚠️ **`periodEnd` 被手工改宽到 7 月底**（标准上界应是 2024-07-01）
        //    → 脏数据场景。
        statement({
          id: 'stmt-a',
          tenantId: 'tenant-a',
          entryCount: 1,
          periodStart: new Date('2024-06-01T00:00:00.000Z'),
          periodEnd: new Date('2024-07-31T00:00:00.000Z'),
        }),
        statement({
          id: 'stmt-a',
          tenantId: 'tenant-a',
          entryCount: 1,
          periodStart: new Date('2024-06-01T00:00:00.000Z'),
          periodEnd: new Date('2024-07-31T00:00:00.000Z'),
        }),
      ],
    });

    const service = makeService(prisma);

    // ---- 单张路径：`generate` 返回的单张视图 ----
    const result = await service.generate({
      period: '2024-06',
      tenantId: 'tenant-a',
    });
    expect(result.items).toHaveLength(1);
    const single = result.items[0].missingEntryCount;

    // ---- 批量路径：`detail` 走 `toViews` ----
    const detailView = await service.detail('stmt-a');
    const batch = detailView.missingEntryCount;

    // ⚠️ **6 月那期不缺笔**：当期真实流水就是纳入的那 1 笔。
    //    7 月那笔**不能算进 6 月**（它归期在 7 月）。
    expect(single).toBe(0);
    expect(batch).toBe(0);
    // ⚠️ **核心断言：两条路径必须给出同一个数** —— 这才是这条用例的牙齿。
    //    修之前：单张路径用改宽的 `periodEnd` 当上界 → 真实笔数算成 2、
    //    纳入 1 笔 → 缺 1 笔；批量路径算成 0 → 两条路径不等 → 这里挂。
    expect(single).toBe(batch);
  });

  it('⚠️ 跨期流水要算进它自己那一期（不能一笔都不算）', async () => {
    // ⚠️ **反过来的那一面**：跨期流水**要**算进它归期的那一期。
    //    只断言「不该算进 6 月」不够 —— 万一实现干脆一笔都不算，
    //    7 月那期真实有 2 笔（纳入 1 笔）却报「不缺笔」，缺笔就永远看不见了。
    const prisma = fakePrisma({
      entries: [
        entry({
          id: 'entry-june',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-06-10T00:00:00.000Z'),
        }),
        entry({
          id: 'entry-july',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-07-20T00:00:00.000Z'),
        }),
        // ⚠️ **7 月又进了一笔**：7 月真实 2 笔、结算单只纳入 1 笔 → 缺 1 笔
        entry({
          id: 'entry-july-late',
          tenantId: 'tenant-a',
          occurredAt: new Date('2024-07-28T00:00:00.000Z'),
        }),
      ],
      statements: [
        statement({
          id: 'stmt-june',
          tenantId: 'tenant-a',
          entryCount: 1,
          periodStart: new Date('2024-06-01T00:00:00.000Z'),
          periodEnd: new Date('2024-07-01T00:00:00.000Z'),
        }),
        statement({
          id: 'stmt-july',
          tenantId: 'tenant-a',
          entryCount: 1,
          periodStart: new Date('2024-07-01T00:00:00.000Z'),
          periodEnd: new Date('2024-08-01T00:00:00.000Z'),
        }),
      ],
    });

    const service = makeService(prisma);
    const result = await service.list({ page: 1, pageSize: 50 });

    const june = result.items.find((item) => item.id === 'stmt-june');
    const july = result.items.find((item) => item.id === 'stmt-july');
    expect(june).toBeDefined();
    expect(july).toBeDefined();

    // ⚠️ **6 月那期不缺笔**（7 月那两笔都不算进它）
    expect(june?.missingEntryCount).toBe(0);
    // ⚠️ **7 月那期缺 1 笔**（真实 2 笔、纳入 1 笔）
    expect(july?.missingEntryCount).toBe(1);
  });
});
