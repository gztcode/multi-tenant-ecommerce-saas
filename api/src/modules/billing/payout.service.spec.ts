import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  PayoutKind,
  PayoutStatus,
  ReceiptType,
  SettlementStatus,
} from '@prisma/client';
import { validate } from 'class-validator';

import { tenantContext } from '../../common/tenant/tenant-context';
import { ApplyPayoutDto } from './dto/apply-payout.dto';
import { LedgerService } from './ledger.service';
import { PayoutService } from './payout.service';
import { PayoutCipherService } from './payout-cipher.service';

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
  kind?: PayoutKind;
  receiptAmount?: number;
  commissionAmount?: number;
  netAmount?: number;
  requestedAmount?: number;
  entryCount?: number;
  periodStart?: Date;
  statementId?: string | null;
  payoutChannel?: string | null;
  attemptCount?: number;
  failureReason?: string | null;
  snapshotAccountName?: string | null;
  snapshotBankName?: string | null;
  snapshotAccountNoCipher?: string | null;
  snapshotMaskedAccountNo?: string | null;
  snapshotEncryptionVersion?: number;
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
    // ⚠️ **出款类型**：正常单走 `computeAmounts`，补差单走独立口径
    kind: overrides.kind ?? PayoutKind.NORMAL,
    requestedAmount: overrides.requestedAmount ?? netAmount,
    requestedBy: 'user-a',
    approvedBy: null,
    rejectedReason: null,
    requestedAt: new Date('2025-08-01T00:00:00.000Z'),
    approvedAt: null,
    cancelledAt: null,
    // ⚠️ **执行字段**（阶段 5h-2）
    payoutChannel: overrides.payoutChannel ?? null,
    payoutTxnId: null,
    attemptCount: overrides.attemptCount ?? 0,
    failureReason: overrides.failureReason ?? null,
    processingAt: null,
    paidAt: null,
    failedAt: null,
    snapshotAccountName: overrides.snapshotAccountName ?? null,
    snapshotBankName: overrides.snapshotBankName ?? null,
    // ⚠️ **阶段 5j：快照里的账号是密文** —— 展示路径读的是预存的掩码串
    snapshotAccountNoCipher: overrides.snapshotAccountNoCipher ?? null,
    snapshotMaskedAccountNo: overrides.snapshotMaskedAccountNo ?? null,
    snapshotEncryptionVersion: overrides.snapshotEncryptionVersion ?? 0,
    createdAt: new Date('2025-08-01T00:00:00.000Z'),
    updatedAt: new Date('2025-08-01T00:00:00.000Z'),
  };
}

/**
 * 收款账户的形状（阶段 5j：账号是密文）。
 *
 * ⚠️ **版本 0 的行不是「已加密但版本号写 0」，而是「压根还没加密」**：
 *    迁移脚本是把旧列 `accountNo` **原地改名**成 `accountNoCipher` ——
 *    所以未迁移的行里，那一列装的是**明文账号**；
 *    而 `maskedAccountNo` 是迁移时新增的列，存量行全是**空串**。
 *    → 夹具必须照这个形状造，否则「版本 0」会被画成「已加密但版本号是 0」，
 *    将来加断言会被骗过去。
 */
function payoutAccount(
  overrides: {
    /** 加密版本（0 = 这行还没迁移加密，1 = 已加密） */
    encryptionVersion?: number;
    /** 账号明文（版本 1 时会被加密成密文存进夹具） */
    accountNo?: string;
  } = {},
) {
  const accountNo = overrides.accountNo ?? '6222000000000000';
  const encryptionVersion = overrides.encryptionVersion ?? 1;
  return {
    id: 'acct-a',
    tenantId: 'tenant-a',
    accountName: '张三',
    bankName: '测试银行',
    // ⚠️ **版本 0 → 那一列里是明文**（迁移是改名，不是加密）；
    //    版本 1 → 才是真密文。
    accountNoCipher:
      encryptionVersion === 0
        ? accountNo
        : new PayoutCipherService().encrypt(accountNo),
    // ⚠️ **掩码串是迁移时新加的列** → 存量行（版本 0）没有掩码，是空串。
    maskedAccountNo: encryptionVersion === 0 ? '' : '************0000',
    encryptionVersion,
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
  /**
   * **依次返回的出款单**（幂等检查要按 kind 查多次 → 需要不同的返回）。
   *
   * ⚠️ **顺序 = 服务层的查询顺序**：
   *    ① NORMAL 活跃单 → ② SUPPLEMENT 活跃单 → ③ `PAID` 的 NORMAL 单。
   *    配完之后 `options.payout` 不再生效。
   */
  payoutSequence?: Array<ReturnType<typeof payout> | null>;
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
  /**
   * **本单自己占用的** `payout_entries`（补差单重算用）。
   *
   * ⚠️ **与 `linkedRows` 分开配**：补差单的「本单口径」要分两次查
   *    （本单已占 / 其他单已占），两次的 `where` 形状不同 → 假 Prisma
   *    必须能按 `where` 区分，否则两个集合会混成同一个。
   *    未配置时**回落到 `linkedRows`**（保持 5h-1 的老行为）。
   */
  ownLinkedRows?: Array<{ entryId: string }>;
  /** **其他单占用的** `payout_entries`（补差单重算用） */
  otherLinkedRows?: Array<{ entryId: string }>;
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
      /**
       * ⚠️ **阶段 5i Task 6：批量聚合用的是 `findMany`** ——
       *    `LedgerService.aggregatePeriods` 一次查齐所有期的结算单。
       *    ⚠️ **只返回一张**（假 Prisma 不按 `where` 过滤）→ 够单测用了。
       */
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.statement === undefined
            ? [statement({})]
            : [options.statement],
        ),
      ),
    },
    // ⚠️ **阶段 5i Task 6：聚合要查抽佣流水与其关联行** ——
    //    这里恒返回空（单测不验「抽佣笔数」，那是 `LedgerService` 的单测职责）。
    settlementStatementEntry: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve([]),
      ),
    },
    commissionEntry: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve([]),
      ),
    },
    payout: {
      /**
       * ⚠️ **按调用顺序返回**（阶段 5h-2）：`apply` 现在要按 `kind` 查三次
       *    （NORMAL 活跃 → SUPPLEMENT 活跃 → `PAID` 的 NORMAL），
       *    配一个固定返回值根本区分不了这三种情况。
       */
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() => {
        const seq = options.payoutSequence;
        if (seq && seq.length > 0) {
          return Promise.resolve(seq.shift() ?? null);
        }
        return Promise.resolve(options.payout ?? null);
      }),
      /**
       * ⚠️ **阶段 5i Task 6：批量聚合用的是 `findMany`** ——
       *    `LedgerService.aggregatePeriods` 一次查齐所有期的出款单，
       *    靠 `status` 与 `kind` 自己分桶，不需要服务层再按 kind 逐个查。
       *    ⚠️ **不消费 `payoutSequence`**（那是 `findFirst` 的队列），
       *    这里只**读**它 —— 否则两次查询会互相抢数据。
       */
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() => {
        if (options.payoutSequence) {
          return Promise.resolve(
            options.payoutSequence.filter(
              (item): item is NonNullable<typeof item> => item !== null,
            ),
          );
        }
        return Promise.resolve(options.payouts ?? []);
      }),
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
      /**
       * ⚠️ **按 `where` 区分「本单已占」与「其他单已占」**：
       *    补差单重算要查两次 `payout_entries`，两次的 `where` 形状不同
       *    （一次 `payoutId: '<id>'`，一次 `payoutId: { not: '<id>' }`）。
       *    不区分的话两个集合会混成同一个 → 测不出「本单口径」。
       *    未配置对应的项时**回落到 `linkedRows`**（5h-1 的老行为）。
       *
       * ⚠️ **阶段 5i Task 6：聚合用的是 `payoutId: { in: [...] }`** ——
       *    那是「这些单占用了哪些流水」→ 与「其他单已占」同义但**不是同一集合**
       *    （聚合问的是全部出款单，不是「除本单以外」）。
       *    → 按 `in` / `not` 两个键区分。
       */
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>((args) => {
        const where = args?.where as
          { payoutId?: string | { not?: string; in?: string[] } } | undefined;
        if (where?.payoutId && typeof where.payoutId === 'object') {
          if (where.payoutId.in) {
            return Promise.resolve(options.linkedRows ?? []);
          }
          return Promise.resolve(options.otherLinkedRows ?? []);
        }
        if (where?.payoutId && typeof where.payoutId === 'string') {
          return Promise.resolve(
            options.ownLinkedRows ?? options.linkedRows ?? [],
          );
        }
        return Promise.resolve(options.linkedRows ?? []);
      }),
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
          create: jest.fn<Promise<unknown>, [args?: QueryArgs]>((args) => {
            if (options.createThrows) {
              return Promise.reject(uniqueViolation());
            }
            if (options.createdPayout) {
              return Promise.resolve(options.createdPayout);
            }
            // ⚠️ **回显建单时的 `kind` 与金额** —— 补差单建出来的单必须是
            //    SUPPLEMENT 且佣金为 0，固定返回默认值会让断言看着像「建了正常单」。
            const data = args?.data as
              | {
                  kind?: PayoutKind;
                  receiptAmount?: number;
                  commissionAmount?: number;
                  netAmount?: number;
                  entryCount?: number;
                }
              | undefined;
            return Promise.resolve(
              payout({
                kind: data?.kind,
                receiptAmount: data?.receiptAmount,
                commissionAmount: data?.commissionAmount,
                netAmount: data?.netAmount,
                entryCount: data?.entryCount,
              }),
            );
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

/**
 * 假的队列服务（只实现 `approve` 用到的那一个方法）。
 *
 * ⚠️ **默认参数**：`makeService` 的第二个参数有默认值 → 现有调用点
 *    不用改也能编译。
 */
function fakeQueues() {
  return {
    addWithOptions: jest.fn(() => Promise.resolve()),
  };
}

/**
 * 把假 Prisma 塞进服务（只用到 `as unknown as` 的一次性断言）。
 *
 * ⚠️ **阶段 5i Task 6：多注入一个 `LedgerService`** ——
 *    「可申请周期」列表改成走 `LedgerService.aggregatePeriods`（批量聚合）。
 *    这里**用同一只假 Prisma** 构造它 → 聚合看到的数据与老实现一致。
 */
function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  queues: ReturnType<typeof fakeQueues> = fakeQueues(),
): PayoutService {
  return new PayoutService(
    prisma as unknown as never,
    queues as unknown as never,
    new LedgerService(prisma as unknown as never),
  );
}

/** 在租户上下文里调用（服务层靠 `getTenantContext()` 取租户与用户） */
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: 'tenant-a', userId: 'user-a', role: null },
    async () => fn(),
  );
}

/**
 * ⚠️ **单元测试进程里没有 .env** —— `PayoutCipherService` 在构造时就要密钥，
 *    拿不到就直接抛错。所以这里显式设一个**测试用**密钥。
 */
const TEST_ENCRYPTION_KEY = 'test-payout-encryption-key-at-least-32-chars';

beforeAll(() => {
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

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
    // ⚠️ **阶段 5h-2：幂等前置查变成两次**（NORMAL 活跃 + SUPPLEMENT 活跃）
    //    —— 周期校验在这两次之后，所以这里只查了两次。
    //    （上面调了两次 `apply` → 2 × 2 = 4）
    expect(prisma.payout.findFirst).toHaveBeenCalledTimes(4);
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

    // ⚠️ **幂等前置查**：where 里只有周期、类型与状态，没有 tenantId
    expect(argsOf(prisma.payout.findFirst).where).toEqual({
      periodStart: new Date('2025-07-01T00:00:00.000Z'),
      // ⚠️ **必须带 kind**：部分唯一索引已是 `(tenantId, periodStart, kind)`
      //    三元组 → 查询不带 kind 就会把补差单也捞进来。
      kind: PayoutKind.NORMAL,
      status: {
        notIn: [
          PayoutStatus.REJECTED,
          PayoutStatus.CANCELLED,
          PayoutStatus.FAILED,
        ],
      },
    });
    // ⚠️ **收款账户查询**：没有 tenantId 条件
    expect(argsOf(prisma.merchantPayoutAccount.findFirst).where).toEqual({});
  });
});

describe('活跃出款单的判定：notIn 必须与索引的 WHERE 是同一个集合', () => {
  it('findActivePayout：排除 FAILED（失败的单不占位，该期能再来一次）', async () => {
    const prisma = fakePrisma({
      payout: payout({ status: PayoutStatus.FAILED }),
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    // ⚠️ **断言传给 Prisma 的 where**（假 Prisma 不按 where 过滤）：
    //    `status.notIn` 少了 FAILED → 索引认为不活跃、查询却认为活跃。
    const where = argsOf(prisma.payout.findFirst).where as {
      status: { notIn: string[] };
    };
    expect(where.status.notIn).toContain(PayoutStatus.FAILED);
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

    // ⚠️ **断言跑在事务客户端上**（阶段 5h-2）：状态更新与账户快照
    //    必须原子 → 审批的落库也在事务里。
    const updateCall = argsOf(prisma.tx()!.payout.updateMany);
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

    const updateCall = argsOf(prisma.tx()!.payout.updateMany);
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

describe('approve（阶段 5h-2）', () => {
  it('补差单审批时**不调 computeAmounts**：佣金恒为 0（护栏 X13）', async () => {
    const prisma = fakePrisma({
      payout: payout({ kind: PayoutKind.SUPPLEMENT }),
      // ⚠️ **结算单的 netAmount 是 2000** —— 若审批时误用 computeAmounts，
      //    补差单的佣金会被算成 2000、净额被扣掉
      statement: statement({ netAmount: 2000 }),
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      commissionAmount: number;
      netAmount: number;
      receiptAmount: number;
    };
    // ⚠️ **佣金恒为 0** —— 补差单不再扣佣（设计 §6.4 的不变量）
    expect(data.commissionAmount).toBe(0);
    expect(data.netAmount).toBe(data.receiptAmount);
    expect(data.netAmount).toBe(5000);
  });

  it('补差单的重算范围是「本单已占 ∪ 未被其他单占用的」（护栏 X16）', async () => {
    // ⚠️ **本单口径**：补差单在 `apply` 时已经占住了 r-1、r-2。
    //    若审批时用全局口径「未被任何单占用」，这两笔会被当成未纳入
    //    → 重算出的金额 ≈ 0 → 审批直接 409（或者更糟：金额错）。
    //
    //    r-3 被**别的单**占着 → 不该被算进补差单的金额。
    const prisma = fakePrisma({
      payout: payout({ kind: PayoutKind.SUPPLEMENT }),
      statement: statement({ netAmount: 2000 }),
      receipts: [
        receipt({ id: 'r-1', amount: 3000 }),
        receipt({ id: 'r-2', amount: 4000 }),
        receipt({ id: 'r-3', amount: 9000 }),
        receipt({ id: 'r-4', amount: 1000 }),
      ],
      ownLinkedRows: [{ entryId: 'r-1' }, { entryId: 'r-2' }],
      otherLinkedRows: [{ entryId: 'r-3' }],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      receiptAmount: number;
      netAmount: number;
      entryCount: number;
    };
    // ⚠️ **r-1 + r-2（本单已占）+ r-4（新进来的）**，不含 r-3
    expect(data.receiptAmount).toBe(3000 + 4000 + 1000);
    expect(data.netAmount).toBe(data.receiptAmount);
    // ⚠️ **entryCount 按补差那批重算**（不是整期的 4 条）
    expect(data.entryCount).toBe(3);
  });

  it('补差单查「其他单占用」时显式带了 tenantId 与 periodStart', async () => {
    // ⚠️ **`payout_entries` 不在租户白名单里** → 扩展不附加任何过滤
    //    → 这里查到的就是全局事实 → **必须自己带 tenantId 与 periodStart**。
    const prisma = fakePrisma({
      payout: payout({ kind: PayoutKind.SUPPLEMENT }),
      statement: statement({ netAmount: 2000 }),
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    // ⚠️ **断言第二次 `payoutEntry.findMany`**（第一次是「本单已占」）
    const calls = prisma.payoutEntry.findMany.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const otherWhere = (calls[1][0] as { where?: Record<string, unknown> })
      .where;
    expect(otherWhere?.payout).toEqual({
      tenantId: 'tenant-a',
      periodStart: new Date('2025-07-01T00:00:00.000Z'),
    });
    expect(otherWhere?.payoutId).toEqual({ not: 'payout-a' });
  });

  it('审批时把收款账户抄进快照（账号是密文，版本号跟着一起抄）', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      snapshotAccountName: string;
      snapshotBankName: string;
      snapshotAccountNoCipher: string;
      snapshotMaskedAccountNo: string;
      snapshotEncryptionVersion: number;
    };
    expect(data.snapshotAccountName).toBe('张三');
    expect(data.snapshotBankName).toBe('测试银行');
    // ⚠️ **快照里的是密文，不是明文**
    expect(data.snapshotAccountNoCipher).toBeDefined();
    expect(data.snapshotAccountNoCipher).not.toBe('6222000000000000');
    // ⚠️ **更强的断言**：密文解出来就是原文
    expect(
      new PayoutCipherService().decrypt(data.snapshotAccountNoCipher),
    ).toBe('6222000000000000');
    // ⚠️ **掩码串一起抄** —— 展示路径不解密，靠的就是它
    expect(data.snapshotMaskedAccountNo).toBe('************0000');
    // ⚠️ **版本号必须跟着密文一起抄** ——
    //    否则会出现「密文是新的、版本号是 0」的错配，
    //    worker 解密时会因为版本号不对而抛错。
    expect(data.snapshotEncryptionVersion).toBe(1);
  });

  it('审批时查收款账户要显式带 tenantId（平台作用域下扩展不附加）', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    expect(argsOf(prisma.merchantPayoutAccount.findFirst).where).toEqual({
      tenantId: 'tenant-a',
    });
  });

  it('审批时商家已删掉收款账户 → 409，不审批', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
      account: null,
    });
    const service = makeService(prisma);

    await expect(
      asPlatform(async () => {
        await service.approve('payout-a');
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // ⚠️ **没落库**：带着空快照往下走会让 worker 落 FAILED，
    //    等于让商家白等一轮
    expect(prisma.tx()).toBeNull();
  });

  it('审批成功后**入队**（事务提交之后）', async () => {
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
    });
    const queues = fakeQueues();
    const service = makeService(prisma, queues);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    expect(queues.addWithOptions).toHaveBeenCalled();
    const [queueName, jobName, data, jobId, opts] = queues.addWithOptions.mock
      .calls[0] as unknown as [
      string,
      string,
      { payoutId: string },
      string,
      { attempts: number },
    ];
    expect(queueName).toBe('payout');
    expect(jobName).toBe('execute');
    expect(data.payoutId).toBe('payout-a');
    expect(jobId).toContain('payout-a');
    // ⚠️ **attempts 必须是 1** —— BullMQ 自己的重试要关掉
    expect(opts.attempts).toBe(1);
  });

  it('⚠️ 入队失败不抛错：记 failureReason，审批照样成功', async () => {
    // ⚠️ **状态已经是 APPROVED 了**（事务已提交）→ 抛错会让审批人
    //    以为「审批失败」而重试 → 409 → 更困惑。
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
    });
    const queues = fakeQueues();
    queues.addWithOptions.mockRejectedValueOnce(new Error('Redis 连不上'));
    const service = makeService(prisma, queues);

    const view = await asPlatform(() => service.approve('payout-a'));

    expect(view.id).toBe('payout-a');
    // ⚠️ **记了失败原因** → 运营看得见；兜底扫描会重新入队
    expect(prisma.payout.updateMany).toHaveBeenCalledTimes(1);
    const data = argsOf(prisma.payout.updateMany).data as {
      failureReason: string;
    };
    expect(data.failureReason).toContain('打款任务提交失败');
    // ⚠️⚠️ **绝不能带原始异常消息** —— 那是 Redis 的连接细节
    //    （主机名、端口、连接错误）。内部原文只进日志。
    expect(data.failureReason).not.toContain('Redis 连不上');
    expect(data.failureReason).not.toContain('Redis');
  });

  it('⚠️ 审批时同步明细：deleteMany 必须先于 createMany', async () => {
    // ⚠️ **顺序错了会撞唯一索引** ——
    //    `payout_entries.entryId` 是**全局唯一索引**，
    //    不先删就插 → P2002 → 500。
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' }), receipt({ id: 'r-2' })],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const tx = prisma.tx();
    expect(tx).not.toBeNull();
    // ⚠️ **两次调用都要发生**（同步明细）
    expect(tx!.payoutEntry.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx!.payoutEntry.createMany).toHaveBeenCalledTimes(1);

    // ⚠️ **顺序断言** —— 用「mock 的调用序号」比较：
    //    `jest.fn` 的 `mock.invocationCallOrder` 是全局递增的调用序号。
    const deleteOrder = tx!.payoutEntry.deleteMany.mock.invocationCallOrder[0];
    const createOrder = tx!.payoutEntry.createMany.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('正常单也同步明细（不只是补差单）', async () => {
    // ⚠️ **两种 kind 都要同步** —— 审批锁定的范围就是这张单纳入的流水；
    //    审批**之后**才回填的流水不在锁定范围里，那些才该走补差单打。
    const prisma = fakePrisma({
      payout: payout({ kind: PayoutKind.NORMAL }),
      receipts: [receipt({ id: 'r-1' }), receipt({ id: 'r-2' })],
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const tx = prisma.tx();
    expect(tx).not.toBeNull();
    // ⚠️ **正常单也要删旧明细 + 插新明细**
    expect(tx!.payoutEntry.deleteMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout-a' },
    });
    expect(tx!.payoutEntry.createMany).toHaveBeenCalledTimes(1);
    const data = argsOf(tx!.payoutEntry.createMany).data as Array<{
      payoutId: string;
      entryId: string;
    }>;
    expect(data).toEqual([
      { payoutId: 'payout-a', entryId: 'r-1' },
      { payoutId: 'payout-a', entryId: 'r-2' },
    ]);
  });

  it('正常单对已 PAID 的结算单仍然 409（不许放宽 P3）', async () => {
    // ⚠️ **`allowPaid` 只给补差路径开** —— 放行正常单的话，
    //    正常单也能对已 PAID 的结算单重新算佣金，
    //    5h-1 的 P5 与 P6 会一起失效。
    const prisma = fakePrisma({
      payout: payout({ kind: PayoutKind.NORMAL }),
      statement: statement({ status: SettlementStatus.PAID }),
      receipts: [receipt({ id: 'r-1' })],
    });
    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('补差单对已 PAID 的结算单放行（结算单只作追溯凭证）', async () => {
    const prisma = fakePrisma({
      payout: payout({ kind: PayoutKind.SUPPLEMENT }),
      statement: statement({ status: SettlementStatus.PAID }),
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
    });
    const service = makeService(prisma);

    await asPlatform(() => service.approve('payout-a'));

    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      commissionAmount: number;
    };
    expect(data.commissionAmount).toBe(0);
  });
});

/**
 * 阶段 5j：快照抄的是「账户行里那份密文本身」。
 *
 * ⚠️ **为什么不能用「解出来 == 原文」代替「同一个字符串」**：
 *    重新加密（`encrypt(密文)`）会得到**另一串**密文，
 *    而把它解一次，拿到的是**原来那串密文**、不是账号明文 ——
 *    所以「解出来是原文」这条断言在「重新加密」的变异下**照样会挂**，
 *    但**换一种写法就蒙混过关**（例如把密文当明文再加密再解一次）。
 *    → 唯一能区分「复制」与「重新加密」的，是**字符串本身一模一样**。
 */
describe('账户快照：抄的是同一份密文（阶段 5j）', () => {
  it('apply 建单时抄的是账户行里那份密文本身（不是重新加密）', async () => {
    const account = payoutAccount();
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      account,
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    const data = argsOf(prisma.tx()!.payout.create).data as {
      snapshotAccountNoCipher: string;
    };
    // ⚠️ **同一个字符串**（不是「内容对得上」）——
    //    重新加密会因随机 iv 得到**完全不同的密文**。
    expect(data.snapshotAccountNoCipher).toBe(account.accountNoCipher);
  });

  it('approve 快照抄的也是账户行里那份密文本身（不是重新加密）', async () => {
    const account = payoutAccount();
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
      account,
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      snapshotAccountNoCipher: string;
    };
    // ⚠️ **同一个字符串** —— 「快照 = 审批那一刻的那一份」
    expect(data.snapshotAccountNoCipher).toBe(account.accountNoCipher);
  });

  it('apply 建单时版本号跟着账户行走（账户已迁移 → 快照也是 1）', async () => {
    // ⚠️ **版本号必须跟着密文一起抄** ——
    //    写死 0 会骗过后续的版本检查，
    //    造成「密文是新的、版本号说它是旧的」的错配。
    const account = payoutAccount({ encryptionVersion: 1 });
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      account,
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    const data = argsOf(prisma.tx()!.payout.create).data as {
      snapshotEncryptionVersion: number;
    };
    expect(data.snapshotEncryptionVersion).toBe(1);
  });

  it('approve 快照的版本号跟着账户行走（账户已迁移 → 快照也是 1）', async () => {
    const account = payoutAccount({ encryptionVersion: 1 });
    const prisma = fakePrisma({
      payout: payout({}),
      receipts: [receipt({ id: 'r-1' })],
      account,
    });
    const service = makeService(prisma);

    await asPlatform(async () => {
      await service.approve('payout-a');
    });

    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      snapshotEncryptionVersion: number;
    };
    expect(data.snapshotEncryptionVersion).toBe(1);
  });
});

/**
 * 阶段 5j：**写路径也要查加密版本**。
 *
 * ⚠️ **为什么这道闸是必须的**：账户行未迁移时（`encryptionVersion = 0`），
 *    `accountNoCipher` 列里装的是**明文账号**（迁移是给旧列改名，不是加密）。
 *    而快照是**复制**账户行里那一份 → 抄过去就是把明文抄进 `payouts` 表，
 *    等于在新表里第一次出现明文副本；
 *    而且打款时 `decryptVersioned` 必然抛错 → 出款单卡在 `PROCESSING` 反复重试。
 *    → 宁可在**建单/审批前**就拒掉，也不要造出一张注定打不出钱的单。
 */
describe('写路径闸：账户未完成加密迁移时不允许建单/审批（阶段 5j）', () => {
  it('apply 遇到未迁移的账户 → 400，且**没建任何单**', async () => {
    // ⚠️ **账户行里装的是明文**（版本 0 的真实形状）——
    //    如果这道闸漏了，这串明文就会被抄进 `payouts`。
    const account = payoutAccount({
      encryptionVersion: 0,
      accountNo: '6225880000000000',
    });
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      account,
    });
    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toThrow('migrate:payout-encryption');

    // ⚠️ **没建单**：闸必须在建单**之前** ——
    //    建完再拒等于明文已经落库了。
    expect(prisma.calls).not.toContain('$transaction');
    expect(prisma.tx()).toBeNull();
  });

  it('apply 遇到未迁移的账户 → 明文账号**没有**写进 payouts', async () => {
    const account = payoutAccount({
      encryptionVersion: 0,
      accountNo: '6225880000000000',
    });
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      account,
    });
    const service = makeService(prisma);

    await expect(
      asTenant(() => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(BadRequestException);

    // ⚠️ **建单根本没发生** → 不可能有明文落库。
    //    （`payout.create` 跑在事务客户端上，事务没开 → 客户端是 null）
    expect(prisma.tx()).toBeNull();
  });

  it('approve 遇到未迁移的账户 → 409，且**状态没变**', async () => {
    const account = payoutAccount({
      encryptionVersion: 0,
      accountNo: '6225880000000000',
    });
    const prisma = fakePrisma({
      payout: payout({ status: PayoutStatus.REQUESTED }),
      receipts: [receipt({ id: 'r-1' })],
      account,
    });
    const service = makeService(prisma);

    await expect(
      asPlatform(() => service.approve('payout-a')),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(asPlatform(() => service.approve('payout-a'))).rejects.toThrow(
      'migrate:payout-encryption',
    );

    // ⚠️ **没落库**：状态还停在 `REQUESTED`，
    //    没被改成 `APPROVED`（审批事务根本没开）。
    expect(prisma.tx()).toBeNull();
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });

  it('对照组：账户已迁移（版本 1）→ apply 正常建单', async () => {
    // ⚠️ **对照组**：证明上一条不是因为「别的什么原因失败」——
    //    同样的数据，只把版本号改成 1，就必须能建单。
    const account = payoutAccount({
      encryptionVersion: 1,
      accountNo: '6225880000000000',
    });
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
      payout: null,
      account,
    });
    const service = makeService(prisma);

    const view = await asTenant(() => service.apply({ period: '2025-07' }));

    expect(view.id).toBe('payout-a');
    expect(prisma.calls).toContain('$transaction');
    const data = argsOf(prisma.tx()!.payout.create).data as {
      snapshotAccountNoCipher: string;
      snapshotEncryptionVersion: number;
    };
    expect(data.snapshotEncryptionVersion).toBe(1);
    // ⚠️ **快照里是密文，不是明文**
    expect(data.snapshotAccountNoCipher).not.toBe('6225880000000000');
    expect(
      new PayoutCipherService().decrypt(data.snapshotAccountNoCipher),
    ).toBe('6225880000000000');
  });

  it('对照组：账户已迁移（版本 1）→ approve 正常审批', async () => {
    const account = payoutAccount({
      encryptionVersion: 1,
      accountNo: '6225880000000000',
    });
    const prisma = fakePrisma({
      payout: payout({ status: PayoutStatus.REQUESTED }),
      receipts: [receipt({ id: 'r-1' })],
      account,
    });
    const service = makeService(prisma);

    const view = await asPlatform(() => service.approve('payout-a'));

    expect(view.id).toBe('payout-a');
    const data = argsOf(prisma.tx()!.payout.updateMany).data as {
      status: string;
      snapshotEncryptionVersion: number;
    };
    // ⚠️ **状态确实被改成 `APPROVED`** ——
    //    ⚠️ `view.status` 不能用来断言这一点：假 Prisma 的
    //    `tx.payout.findFirst` 回读的是**配置里那张旧行**（还是 `REQUESTED`），
    //    所以只能看 `updateMany` 落库的 `data`。
    expect(data.status).toBe(PayoutStatus.APPROVED);
    expect(data.snapshotEncryptionVersion).toBe(1);
  });
});

describe('apply（阶段 5h-2：补差单）', () => {
  it('findActivePayout：带 kind 条件（索引是三元组，查询也必须是）', async () => {
    const prisma = fakePrisma({
      receipts: [receipt({ id: 'r-1' })],
      statement: statement({}),
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    // ⚠️ **断言传给 Prisma 的 where**（假 Prisma 不按 where 过滤）：
    //    索引是 `(tenantId, periodStart, kind)` 三元组，
    //    查询不带 kind → 「以为只查正常单、实际把补差单也捞进来」。
    const where = argsOf(prisma.payout.findFirst).where as {
      kind?: string;
    };
    expect(where.kind).toBe('NORMAL');
    // ⚠️ **第二次查是补差单** —— 两次的 kind 必须不同
    const secondWhere = (
      prisma.payout.findFirst.mock.calls[1][0] as { where?: { kind?: string } }
    ).where;
    expect(secondWhere?.kind).toBe('SUPPLEMENT');
  });

  it('该期正常单已 PAID 且有未纳入流水 → 建 SUPPLEMENT 单，佣金为 0', async () => {
    const prisma = fakePrisma({
      // ⚠️ **查询顺序**：① NORMAL 活跃单 → ② SUPPLEMENT 活跃单
      //    → ③ `PAID` 的 NORMAL 单
      payoutSequence: [
        null, // ① 没有活跃的正常单
        null, // ② 没有活跃的补差单
        payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
      ],
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
      statement: statement({ status: SettlementStatus.PAID, netAmount: 2000 }),
    });
    const service = makeService(prisma);

    const view = await asTenant(async () =>
      service.apply({ period: '2025-07' }),
    );

    expect(view.kind).toBe(PayoutKind.SUPPLEMENT);
    expect(view.commissionAmount).toBe(0);
    expect(view.netAmount).toBe(view.receiptAmount);
  });

  it('⚠️ 该期有**已 PAID** 的正常单 → ① 的幂等分支必须跳过它（补差路径可达）', async () => {
    const paidNormal = payout({
      status: PayoutStatus.PAID,
      kind: PayoutKind.NORMAL,
    });
    const prisma = fakePrisma({
      // ⚠️ **第一次查询（NORMAL 活跃单）就该返回那张已 PAID 的单** ——
      //    真实库里 `PAID` 的正常单**就是**活跃单（`notIn` 与部分唯一
      //    索引的 WHERE 一致，都不含 `PAID`）。
      //    ⚠️ 若 mock 成 `[null, ...]`，就造出了一个**数据库产生不了的
      //    状态** → 绿灯掩盖了「补差路径不可达」这个 bug。
      payoutSequence: [paidNormal, null, paidNormal],
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
      statement: statement({ status: SettlementStatus.PAID, netAmount: 2000 }),
    });
    const service = makeService(prisma);

    const view = await asTenant(async () =>
      service.apply({ period: '2025-07' }),
    );

    // ⚠️ **必须是补差单** —— 若返回的是那张已 PAID 的正常单，
    //    说明 ① 的幂等分支没有排除 PAID → 补差路径不可达。
    expect(view.kind).toBe(PayoutKind.SUPPLEMENT);
    expect(view.commissionAmount).toBe(0);
  });

  it('该期有活跃的 SUPPLEMENT 单 → 幂等返回它', async () => {
    const prisma = fakePrisma({
      payoutSequence: [
        null, // ① 没有活跃的正常单
        payout({ status: PayoutStatus.REQUESTED, kind: PayoutKind.SUPPLEMENT }),
      ],
    });
    const service = makeService(prisma);

    const view = await asTenant(async () =>
      service.apply({ period: '2025-07' }),
    );

    expect(view.kind).toBe(PayoutKind.SUPPLEMENT);
    expect(view.id).toBe('payout-a');
  });

  it('该期正常单是 FAILED → 走 NORMAL 路径（不误判成补差）', async () => {
    const prisma = fakePrisma({
      // ⚠️ **`FAILED` 的正常单不占位** → 前两次查询都查不到它
      payoutSequence: [null, null, null],
      receipts: [receipt({ id: 'r-1', amount: 10000 })],
      statement: statement({ netAmount: 2000 }),
    });
    const service = makeService(prisma);

    const view = await asTenant(async () =>
      service.apply({ period: '2025-07' }),
    );

    // ⚠️ **必须是 NORMAL** —— 误判成补差会让主体那部分永远打不出去
    expect(view.kind).toBe(PayoutKind.NORMAL);
    // ⚠️ **佣金照常扣**（结算单的 netAmount）
    expect(view.commissionAmount).toBe(2000);
  });

  it('补差金额 ≤ 0 → 400「该期没有可补差的货款」', async () => {
    const prisma = fakePrisma({
      payoutSequence: [null, null, payout({ status: PayoutStatus.PAID })],
      // ⚠️ **回填进来的是退款冲回流水**（负数）
      receipts: [receipt({ id: 'r-1', amount: -500 })],
    });
    const service = makeService(prisma);

    await expect(
      asTenant(async () => service.apply({ period: '2025-07' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('补差单查「已被占用」时显式带了 tenantId 与 periodStart', async () => {
    // ⚠️ **`payout_entries` 不在租户白名单里** → 扩展不附加任何过滤
    //    → 查出来的就是全局事实 → **必须显式带 tenantId 与 periodStart**。
    const prisma = fakePrisma({
      payoutSequence: [null, null, payout({ status: PayoutStatus.PAID })],
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
      statement: statement({ status: SettlementStatus.PAID }),
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    const call = argsOf(prisma.payoutEntry.findMany);
    expect(call.where?.payout).toEqual({
      tenantId: 'tenant-a',
      periodStart: new Date('2025-07-01T00:00:00.000Z'),
    });
  });

  it('补差单建单时 kind 落库为 SUPPLEMENT', async () => {
    const prisma = fakePrisma({
      payoutSequence: [null, null, payout({ status: PayoutStatus.PAID })],
      receipts: [receipt({ id: 'r-1', amount: 5000 })],
      statement: statement({ status: SettlementStatus.PAID }),
    });
    const service = makeService(prisma);

    await asTenant(async () => {
      await service.apply({ period: '2025-07' });
    });

    const data = argsOf(prisma.tx()!.payout.create).data as {
      kind: PayoutKind;
      commissionAmount: number;
    };
    expect(data.kind).toBe(PayoutKind.SUPPLEMENT);
    // ⚠️ **佣金恒为 0** —— 补差单不再扣佣（护栏 X13）
    expect(data.commissionAmount).toBe(0);
  });
});

describe('PayoutView：执行字段与账号脱敏（护栏 X14）', () => {
  it('完整账号绝不进 API 响应，只给脱敏版', async () => {
    // ⚠️ **走「建单」这条路**（`payoutSequence` 三次都返回 null → 走正常单路径），
    //    再用 `createdPayout` 指定建出来的那张单带执行字段与快照。
    //    ⚠️ 不能靠「① 幂等返回一张已 PAID 的单」来短路 ——
    //    `apply` 的 ① 现在会**跳过 `PAID` 的正常单**（否则补差路径不可达），
    //    短路不了就会一路走到「没有货款流水」抛 400。
    const created = payout({
      status: PayoutStatus.PAID,
      kind: PayoutKind.NORMAL,
      snapshotAccountName: '张三',
      snapshotBankName: '测试银行',
      snapshotAccountNoCipher: new PayoutCipherService().encrypt(
        '6222000000000000',
      ),
      snapshotMaskedAccountNo: '************0000',
      snapshotEncryptionVersion: 1,
      payoutChannel: 'fake-bank',
      attemptCount: 2,
      failureReason: null,
    });
    const prisma = fakePrisma({
      payoutSequence: [null, null, null],
      receipts: [receipt({ id: 'r-1', amount: 10000 })],
      createdPayout: created,
    });
    const service = makeService(prisma);

    const view = await asTenant(async () =>
      service.apply({ period: '2025-07' }),
    );

    expect(view.kind).toBe(PayoutKind.NORMAL);
    expect(view.payoutChannel).toBe('fake-bank');
    expect(view.attemptCount).toBe(2);
    expect(view.failureReason).toBeNull();
    expect(view.snapshotAccountName).toBe('张三');
    expect(view.snapshotBankName).toBe('测试银行');
    expect(view.maskedSnapshotAccountNo).toBe('************0000');
    // ⚠️ **完整账号一个字节都不能漏出去**
    expect(JSON.stringify(view)).not.toContain('6222000000000000');
    expect('snapshotAccountNo' in view).toBe(false);
    // ⚠️ **密文也不能漏出去** —— 密文虽然解不开，但它是「打款依据」的载体，
    //    泄出去等于把解密材料交出去（密钥轮换后旧密文依然可解）。
    expect('snapshotAccountNoCipher' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(
      created.snapshotAccountNoCipher as string,
    );
  });
});

describe('availablePeriods（阶段 5h-2）', () => {
  it('正常单已 PAID 且有未纳入流水 → supplementAvailable = true', async () => {
    const prisma = fakePrisma({
      payoutSequence: [
        payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
        null, // SUPPLEMENT 活跃单：没有
      ],
      receipts: [receipt({ id: 'r-1', amount: 10000 })],
      linkedRows: [{ entryId: 'r-taken' }],
      statement: statement({ status: SettlementStatus.PAID, netAmount: 2000 }),
    });
    const service = makeService(prisma);

    const views = await asTenant(async () => service.availablePeriods());

    expect(views).toHaveLength(1);
    expect(views[0].supplementAvailable).toBe(true);
    expect(views[0].supplementAmount).toBe(10000);
    // ⚠️ **整期金额的语义不变** —— 它是「这一期总共应结多少」
    expect(views[0].netAmount).toBe(8000);
  });

  it('没有活跃单 → appliedKind = null，supplementAvailable = false', async () => {
    const prisma = fakePrisma({
      payoutSequence: [null, null],
      receipts: [receipt({ id: 'r-1', amount: 10000 })],
    });
    const service = makeService(prisma);

    const views = await asTenant(async () => service.availablePeriods());

    expect(views[0].appliedKind).toBeNull();
    expect(views[0].alreadyApplied).toBe(false);
    expect(views[0].supplementAvailable).toBe(false);
    expect(views[0].supplementAmount).toBeNull();
  });

  it('有活跃的 SUPPLEMENT 单 → appliedKind = SUPPLEMENT', async () => {
    const prisma = fakePrisma({
      payoutSequence: [
        payout({ status: PayoutStatus.PAID, kind: PayoutKind.NORMAL }),
        payout({ status: PayoutStatus.REQUESTED, kind: PayoutKind.SUPPLEMENT }),
      ],
      receipts: [receipt({ id: 'r-1', amount: 10000 })],
    });
    const service = makeService(prisma);

    const views = await asTenant(async () => service.availablePeriods());

    expect(views[0].appliedKind).toBe(PayoutKind.SUPPLEMENT);
    // ⚠️ **补差单不允许再叠** → 不给补差入口
    expect(views[0].supplementAvailable).toBe(false);
  });

  it('正常单还在飞（REQUESTED）→ 不给补差入口（不能两张单同时在飞）', async () => {
    const prisma = fakePrisma({
      payoutSequence: [
        payout({ status: PayoutStatus.REQUESTED, kind: PayoutKind.NORMAL }),
        null,
      ],
      receipts: [receipt({ id: 'r-1', amount: 10000 })],
    });
    const service = makeService(prisma);

    const views = await asTenant(async () => service.availablePeriods());

    expect(views[0].appliedKind).toBe(PayoutKind.NORMAL);
    expect(views[0].supplementAvailable).toBe(false);
    expect(views[0].supplementAmount).toBeNull();
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
