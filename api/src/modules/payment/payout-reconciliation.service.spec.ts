import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  PayoutOperationAction,
  ReconciliationDiffType,
  ReconciliationResolution,
  ReconciliationSeverity,
  ReconciliationSource,
} from '@prisma/client';
import { FAKE_PAYOUT_CHANNEL } from '../../common/payment/fake-payout.provider';
import { CHANNEL_LIST_PAGE_SIZE } from '../../common/payment/payout.constants';
import type {
  ChannelPayoutRecord,
  PayoutProvider,
} from '../../common/payment/payout-provider.interface';
import { PlatformSettingService } from '../../common/platform-settings/platform-setting.service';
import { PayoutReconciliationResolver } from './payout-reconciliation-resolver.service';
import {
  PayoutReconciliationService,
  RECONCILIATION_MAX_CHANNEL_RECORDS,
  RECONCILIATION_MAX_ITEMS,
  RECONCILIATION_MAX_PAGES,
  RECONCILIATION_PAGE_TIMEOUT_MS,
  reconciliationPageTimeoutMs,
  reconciliationTimeoutBudget,
} from './payout-reconciliation.service';
import type {
  ChannelAlert,
  ChannelAlertSink,
} from '../../common/channel/channel-alert';
import { TimeoutError } from '../../common/util/with-timeout';

/**
 * 阶段 6a Task 7：本文件的后半部分（渠道隔离、CSV 自动纠正闸、批量确认）。
 *
 * ⚠️ **与阶段 5m 那批测试共用上面的假 Prisma 工厂** —— 但假实现被有意扩展了
 *    （`payout` 按 `where` 过滤、`platformSetting` 表、`$transaction`、
 *    `payoutReconciliationItem.updateMany` 真改内存）。扩展的口径都是
 *    **真实 Prisma 的语义**：`where` 过滤、事务可重入（嵌套调用直接执行回调）。
 */

/** 一条本地出款单的最小形状（`loadLocalPayouts` 会 select 到的字段） */
interface FakePayoutRow {
  id: string;
  payoutNo: string;
  payoutTxnId: string | null;
  status: string;
  netAmount: number;
  receiptAmount: number | null;
  commissionAmount: number | null;
  entryCount: number;
  paidAt: Date | null;
  processingAt: Date | null;
  failedAt: Date | null;
  /** ⚠️ **渠道隔离的判据** —— `null` 是 5m 之前的存量单 */
  payoutChannel: string | null;
}

function makePayoutRow(over: Partial<FakePayoutRow> = {}): FakePayoutRow {
  const id = over.id ?? 'p-1';
  return {
    id,
    payoutNo: `PO-${id}`,
    payoutTxnId: null,
    status: 'PROCESSING',
    netAmount: 1000,
    receiptAmount: 1000,
    commissionAmount: 0,
    entryCount: 1,
    paidAt: null,
    processingAt: new Date('2026-03-01T08:00:00.000Z'),
    failedAt: null,
    payoutChannel: FAKE_PAYOUT_CHANNEL,
    ...over,
  };
}

/** 一条差异项的最小形状（渠道隔离与批量确认用例用） */
interface FakeReconcileItem extends FakeItem {
  type: ReconciliationDiffType;
  payoutId: string | null;
}

function makeReconcileItem(
  over: Partial<FakeReconcileItem> = {},
): FakeReconcileItem {
  return {
    ...makeItems(1, { id: 'i-1' })[0],
    id: 'i-1',
    reconciliationId: 'rec-1',
    type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
    payoutId: 'p-1',
    ...over,
  };
}

/**
 * 渠道对账服务的单元测试（阶段 5m 技术债）。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**，只实现本服务真正用到的那几个方法，
 *    但**语义要真**：`findMany` 会按 `where` 过滤、按 `take` 截断、
 *    `groupBy` 会真的按 `severity` 分组 —— 否则「实现写错了照样过」的用例
 *    就没有牙齿。
 *
 * ⚠️ **假 Prisma 故意不实现 `include`** —— `payoutReconciliation.findFirst`
 *    的 `include: { items: true }` 会把全部差异项捞进内存，
 *    假实现若支持它，「捞完再截断」的旧写法也能跑通 → 断言咬不住实现。
 */

/** 一条差异项的最小形状 */
interface FakeItem {
  id: string;
  reconciliationId: string;
  severity: ReconciliationSeverity;
  resolution: ReconciliationResolution;
  createdAt: Date;
  /** 阶段 6a：批量确认要按类型 / 关联单过滤 */
  type: ReconciliationDiffType;
  payoutId: string | null;
  /** 渠道流水号（自动纠正时写进留痕的 reason） */
  channelTxnId: string | null;
  note: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

/**
 * 造一批差异项。
 *
 * ⚠️ **故意让所有行的 `createdAt` 相同** —— 真实库里一批差异项是
 *    `createMany` 插进去的，`createdAt` 是 `@default(now())`
 *    → **同一批次的行就是同一个毫秒**。造递增的时间会让「只按 `createdAt`
 *    排序」看起来是确定的，从而**掩盖「缺少二级排序键」这个缺陷** ——
 *    这正是规格审查在这版实现上抓到的坑。
 */
function makeItems(
  count: number,
  overrides: Partial<FakeItem> = {},
): FakeItem[] {
  const createdAt = new Date(Date.UTC(2026, 2, 1, 0, 0, 0));
  return Array.from({ length: count }, (_, i) => ({
    // ⚠️ **补零** —— 二级排序键是 `id`，字符串比较时 `item-10` < `item-2`，
    //    补零后字典序与数值序一致。
    id: `item-${String(i).padStart(4, '0')}`,
    reconciliationId: 'rec-1',
    severity: ReconciliationSeverity.CRITICAL,
    resolution: ReconciliationResolution.PENDING,
    createdAt,
    type: ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
    payoutId: null,
    channelTxnId: null,
    note: null,
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  }));
}

/** `listPayouts` 的入参形状 */
type ListPayoutsArgs = {
  from: Date;
  to: Date;
  page?: number;
  pageSize?: number;
};

/** 一只最小可用的假 Prisma */
function fakePrisma(
  options: {
    /** 差异项表的全量数据 */
    items?: FakeItem[];
    /** 对账任务行 —— `null` 表示「查不到」 */
    reconciliation?: Record<string, unknown> | null;
    /** 本地出款单表 */
    payouts?: FakePayoutRow[];
    /** 平台默认渠道设置行（`undefined` = 没有行，回落环境变量） */
    defaultChannelSetting?: { key: string; value: unknown } | null;
    /** 各对账任务所属渠道（`supersedePreviousPending` 的渠道限定用） */
    reconciliationChannels?: Record<string, string>;
  } = {},
) {
  const items: FakeItem[] = options.items ? [...options.items] : [];
  const payouts: FakePayoutRow[] = options.payouts ? [...options.payouts] : [];
  const reconciliation =
    options.reconciliation === undefined
      ? { id: 'rec-1', channel: FAKE_PAYOUT_CHANNEL, status: 'COMPLETED' }
      : options.reconciliation;
  const reconciliationChannels = options.reconciliationChannels ?? {};
  const defaultChannelSetting = options.defaultChannelSetting;

  const prisma = {
    payoutReconciliation: {
      /**
       * ⚠️ **故意不处理 `include`** —— 见文件头注释。
       *    只按 `where.id` 返回任务本体。
       */
      findFirst: jest.fn<
        Promise<unknown>,
        [{ where?: { id?: string }; include?: unknown }]
      >((args) => {
        // ⚠️ **按 `where.id` 命中** —— 渠道隔离用例里有两个任务，
        //    返回错的那个会让「去重不跨渠道」的断言失去意义。
        if (
          args?.where?.id !== undefined &&
          (reconciliation as { id?: string } | null)?.id !== args.where.id
        ) {
          return Promise.resolve(null);
        }
        return Promise.resolve(reconciliation);
      }),
      create: jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>(
        (args) => Promise.resolve({ id: 'rec-1', ...args.data }),
      ),
      updateMany: jest.fn<
        Promise<{ count: number }>,
        [{ where?: unknown; data?: Record<string, unknown> }]
      >(() => Promise.resolve({ count: 1 })),
      findMany: jest.fn<Promise<never[]>, [unknown]>(() => Promise.resolve([])),
      count: jest.fn<Promise<number>, [unknown]>(() => Promise.resolve(0)),
    },
    payoutReconciliationItem: {
      findMany: jest.fn<
        Promise<FakeItem[]>,
        [
          {
            where?: { reconciliationId?: string; id?: { gt?: string } };
            orderBy?:
              | { createdAt?: 'asc' | 'desc' }
              | Array<{ createdAt?: 'asc' | 'desc' } | { id?: 'asc' | 'desc' }>;
            take?: number;
          },
        ]
      >((args) => {
        const matched = items.filter((i) => {
          if (
            args.where?.reconciliationId &&
            i.reconciliationId !== args.where.reconciliationId
          ) {
            return false;
          }
          // ⚠️ **FILTER 模式的游标** —— 真实 Prisma 写的是 `id: { gt: cursor }`
          const gt = args.where?.id?.gt;
          if (gt !== undefined && !(i.id > gt)) {
            return false;
          }
          return true;
        });
        // ⚠️ **按 `(createdAt, id)` 双键升序** —— 与实现的 `orderBy` 一致。
        //    真实库里同一批 `createMany` 的行 `createdAt` 完全相同，
        //    **决定顺序的其实是二级键 `id`**；假实现也要按它排，
        //    否则「删掉二级键」这种缺陷在假 Prisma 上根本暴露不出来。
        const sorted = [...matched].sort((a, b) => {
          const byTime = a.createdAt.getTime() - b.createdAt.getTime();
          return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
        });
        return Promise.resolve(
          args.take === undefined ? sorted : sorted.slice(0, args.take),
        );
      }),
      count: jest.fn<
        Promise<number>,
        [
          {
            where?: {
              reconciliationId?: string;
              resolution?: ReconciliationResolution;
              type?: ReconciliationDiffType;
              payoutId?: { not?: null };
            };
          },
        ]
      >((args) => {
        const rows = args?.where ?? {};
        return Promise.resolve(
          items.filter(
            (i) =>
              (!rows.reconciliationId ||
                i.reconciliationId === rows.reconciliationId) &&
              (!rows.resolution || i.resolution === rows.resolution) &&
              (!rows.type || i.type === rows.type) &&
              (rows.payoutId === undefined || i.payoutId !== null),
          ).length,
        );
      }),
      /**
       * ⚠️ **真的按 `severity` 分组** —— 并且按 `where.resolution` 过滤，
       *    这样「已处置的不该被算进去」才是被实现咬住的断言。
       */
      groupBy: jest.fn<
        Promise<
          Array<{ severity: ReconciliationSeverity; _count: { _all: number } }>
        >,
        [
          {
            by: string[];
            where?: { resolution?: ReconciliationResolution };
          },
        ]
      >((args) => {
        const matched = items.filter(
          (i) =>
            !args.where?.resolution || i.resolution === args.where.resolution,
        );
        const counts = new Map<ReconciliationSeverity, number>();
        for (const item of matched) {
          counts.set(item.severity, (counts.get(item.severity) ?? 0) + 1);
        }
        return Promise.resolve(
          [...counts.entries()].map(([severity, count]) => ({
            severity,
            _count: { _all: count },
          })),
        );
      }),
      createMany: jest.fn<
        Promise<{ count: number }>,
        [{ data?: Array<Record<string, unknown>> }]
      >((args) => {
        // ⚠️ **真的落进内存** —— 自动纠正成功后要断言「差异项变 RESOLVED」，
        //    假实现若吞掉数据，这条断言就永远是 0 命中。
        for (const row of args?.data ?? []) {
          items.push({
            ...makeItems(1, {
              id: `item-new-${items.length}`,
              reconciliationId: String(row.reconciliationId),
            })[0],
            type: row.type as ReconciliationDiffType,
            payoutId: (row.payoutId as string | null) ?? null,
            channelTxnId: (row.channelTxnId as string | null) ?? null,
            severity: row.severity as ReconciliationSeverity,
            note: (row.note as string | null) ?? null,
          });
        }
        return Promise.resolve({ count: args?.data?.length ?? 0 });
      }),
      updateMany: jest.fn<
        Promise<{ count: number }>,
        [
          {
            where?: {
              id?: string;
              reconciliationId?: string;
              resolution?: ReconciliationResolution;
              type?: ReconciliationDiffType;
              payoutId?: string | { not?: null };
              reconciliation?: { channel?: string };
            };
            data?: Record<string, unknown>;
          },
        ]
      >((args) => {
        let count = 0;
        for (const item of items) {
          const where = args.where ?? {};
          // ⚠️ **按 `where.id` 精确命中** —— 并发安全用例靠它
          //    （后到的人条件不成立 → `count: 0`）
          if (where.id !== undefined && item.id !== where.id) {
            continue;
          }
          if (
            where.reconciliationId !== undefined &&
            item.reconciliationId !== where.reconciliationId
          ) {
            continue;
          }
          if (
            where.resolution !== undefined &&
            item.resolution !== where.resolution
          ) {
            continue;
          }
          if (where.type !== undefined && item.type !== where.type) {
            continue;
          }
          if (where.payoutId !== undefined && item.payoutId === null) {
            continue;
          }
          if (
            where.reconciliation?.channel !== undefined &&
            reconciliationChannels[item.reconciliationId] !==
              where.reconciliation.channel
          ) {
            continue;
          }
          Object.assign(item, args.data);
          count += 1;
        }
        return Promise.resolve({ count });
      }),
      findFirst: jest.fn<Promise<null>, [unknown]>(() => Promise.resolve(null)),
    },
    payout: {
      findMany: jest.fn<
        Promise<FakePayoutRow[]>,
        [{ where?: Record<string, unknown> }]
      >((args) => {
        const matches = (
          row: FakePayoutRow,
          clause: Record<string, unknown>,
        ): boolean => {
          // ⚠️ **真的按 `payoutChannel` 过滤** —— 这是渠道隔离用例的牙齿：
          //    实现写错（漏了过滤）的话，渠道 B 的单会混进渠道 A 的比对结果。
          if ('payoutChannel' in clause) {
            const expected = clause.payoutChannel;
            // ⚠️ 真实实现用 `{ in: [channel, null] }` 把「本渠道 + 存量单」一次查出来
            const wanted = (
              expected as { in?: Array<string | null> } | undefined
            )?.in;
            if (wanted) {
              if (!wanted.includes(row.payoutChannel)) return false;
            } else if (Array.isArray(expected)) {
              if (!expected.includes(row.payoutChannel)) return false;
            } else if (row.payoutChannel !== expected) {
              return false;
            }
          }
          const and = clause.AND as Array<Record<string, unknown>> | undefined;
          if (and && !and.every((sub) => matches(row, sub))) {
            return false;
          }
          const or = clause.OR as Array<Record<string, unknown>> | undefined;
          if (or && !or.some((sub) => matches(row, sub))) {
            return false;
          }
          // ⚠️ **时间窗要真的逐条判** —— 否则「两家渠道同窗口互不进入对方
          //    比对结果」这条断言就咬不住实现。
          const checks: Array<[Date | null, unknown]> = [
            [row.paidAt, clause.paidAt],
            [row.processingAt, clause.processingAt],
            [row.failedAt, clause.failedAt],
          ];
          for (const [value, cond] of checks) {
            if (cond === undefined) continue;
            const range = cond as { gte?: Date; lt?: Date };
            if (
              !value ||
              value.getTime() < range.gte!.getTime() ||
              value.getTime() >= range.lt!.getTime()
            ) {
              return false;
            }
          }
          return true;
        };
        const where = args?.where ?? {};
        return Promise.resolve(payouts.filter((row) => matches(row, where)));
      }),
      /** 按 `id` 查单张（resolver 要读 `payoutChannel`） */
      findFirst: jest.fn<
        Promise<FakePayoutRow | null>,
        [{ where?: { id?: string }; select?: unknown }]
      >((args) =>
        Promise.resolve(
          payouts.find((row) => row.id === args.where?.id) ?? null,
        ),
      ),
      /**
       * ⚠️ **真的模拟条件更新** —— `where.id` 精确命中且 `where.status`
       *    匹配才返回 `count: 1`。这是「并发安全靠条件更新」的牙齿：
       *    两个人同时点确认，只有一个 `markPaid` 会命中。
       */
      updateMany: jest.fn<
        Promise<{ count: number }>,
        [
          {
            where?: { id?: string; status?: string };
            data?: Record<string, unknown>;
          },
        ]
      >((args) => {
        const hit = payouts.find(
          (row) =>
            (args.where?.id === undefined || row.id === args.where.id) &&
            (args.where?.status === undefined ||
              row.status === args.where.status),
        );
        if (!hit) return Promise.resolve({ count: 0 });
        Object.assign(hit, args.data);
        return Promise.resolve({ count: 1 });
      }),
    },
    payoutOperation: {
      create: jest.fn<Promise<{ id: string }>, [{ data: unknown }]>(() =>
        Promise.resolve({ id: 'op-1' }),
      ),
    },
    platformSetting: {
      findUnique: jest.fn<
        Promise<{ key: string; value: unknown } | null>,
        [{ where?: { key?: string } }]
      >(() => Promise.resolve(defaultChannelSetting ?? null)),
    },
    databaseNow: jest.fn<Promise<Date>, []>(() =>
      Promise.resolve(new Date('2026-03-08T00:00:00.000Z')),
    ),
    /**
     * ⚠️ **事务要真的执行回调**（不能只是返回 resolve）。
     *    回调在下面 `mockImplementation` 里注入 —— 不能在对象字面量里
     *    引用 `prisma` 自己，否则 TS 会把它推成 `any`。
     */
    $transaction: jest.fn(),
    /** ⚠️ 测试专用：暴露内存里的差异项，断言「哪些被改、哪些没被改」 */
    __items: items,
  };

  // ⚠️ **事务真的执行回调** —— resolver 的 `manualCorrectToPaid` 在
  //    `tenantContext.run(platformScope())` 里调 `markPaid`，而 `markPaid`
  //    自己包了一层 `$transaction`；假实现若不重入，内层调用根本不会落到
  //    `payout` 表上。
  prisma.$transaction.mockImplementation(
    (fn: (client: unknown) => Promise<unknown>) => fn(prisma),
  );

  return prisma;
}

/** 造一只假渠道（只有 `listPayouts` 有用） */
function fakeProvider(
  listPayouts: jest.Mock<Promise<ChannelPayoutRecord[]>, [ListPayoutsArgs]>,
): PayoutProvider {
  return {
    channel: FAKE_PAYOUT_CHANNEL,
    provider: 'fake-payout',
    capabilities: {
      refund: false,
      asyncRefund: false,
      asyncPayout: false,
      queryByReferenceNo: true,
      authorizedCharge: false,
      paymentMethod: false,
    },
    submit: jest.fn(),
    queryPayout: jest.fn(),
    listPayouts,
  };
}

/** 造一只「不返回任何流水」的假渠道（不碰渠道的用例用） */
function emptyProvider(): PayoutProvider {
  return fakeProvider(
    jest.fn<Promise<ChannelPayoutRecord[]>, [ListPayoutsArgs]>(() =>
      Promise.resolve([]),
    ),
  );
}

/**
 * 造一只真实的处置服务（阶段 6a Task 7 起，服务与处置共用同一层假 Prisma）。
 *
 * ⚠️ **不再用假 resolver** —— 「批量确认后差异项变 `RESOLVED`」「成功后留痕
 *    `RECONCILE_TO_PAID_BY_FILE`」这些断言必须由真实代码咬住；用 mock 的话，
 *    实现把 `updateMany` 的 `where` 写错也照样绿。
 */
function realResolver(prisma: unknown): PayoutReconciliationResolver {
  // ⚠️ `markPaid` 的实现在 billing（不在本任务改动范围），这里只复刻它的
  //    **条件更新语义**（`PROCESSING → PAID`，没命中返回 false）——
  //    否则并发与「已处置」两条路径的断言都会落空。
  const db = prisma as {
    payout: {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
  };
  const execution = {
    markPaid: (
      payoutId: string,
      input: { providerTxnId: string; channel: string; paidAt: Date },
    ) =>
      db.payout
        .updateMany({
          where: { id: payoutId, status: 'PROCESSING' },
          data: {
            status: 'PAID',
            paidAt: input.paidAt,
            payoutChannel: input.channel,
            payoutTxnId: input.providerTxnId,
          },
        })
        .then((result) => result.count > 0),
  };
  return new PayoutReconciliationResolver(execution as never, prisma as never);
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  provider: PayoutProvider,
  resolver: unknown = realResolver(prisma),
  alerts?: ChannelAlertSink,
): PayoutReconciliationService {
  const settings = new PlatformSettingService(prisma as unknown as never);
  return new PayoutReconciliationService(
    prisma as unknown as never,
    new Map<string, PayoutProvider>([[FAKE_PAYOUT_CHANNEL, provider]]),
    resolver as never,
    settings,
    // 注册表留空：单测走「provider 自己的 timeoutMs → 默认值」的兜底
    undefined,
    alerts,
  );
}

/** 造一条渠道流水 */
function channelRecord(
  over: Partial<ChannelPayoutRecord> = {},
): ChannelPayoutRecord {
  return {
    providerTxnId: 'txn-1',
    amount: 1000,
    status: 'SUCCESS',
    ...over,
  };
}

const FROM = new Date('2026-03-01T00:00:00.000Z');
const TO = new Date('2026-03-02T00:00:00.000Z');

beforeAll(() => {
  // ⚠️ **假网关的开关** —— `assertChannelAvailable` 靠它判断渠道可用
  process.env.FAKE_PAYOUT_ENABLED = 'true';
  // ⚠️ **阶段 6a**：`loadLocalPayouts` 要解析平台默认渠道（存量单的归属）。
  //    没有配置时 `getPayoutDefaultChannel` 抛 409 —— 那是生产上的正确行为，
  //    但会让每个不关心默认渠道的用例都挂掉。
  process.env.PAYOUT_ENABLED_CHANNELS = `${FAKE_PAYOUT_CHANNEL},alpha,beta,other`;
  process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = FAKE_PAYOUT_CHANNEL;
});

afterAll(() => {
  delete process.env.FAKE_PAYOUT_ENABLED;
  delete process.env.PAYOUT_ENABLED_CHANNELS;
  delete process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL;
});

describe('PayoutReconciliationService', () => {
  describe('summary', () => {
    it('只统计未处置的差异：2 CRITICAL / 3 WARNING / 1 INFO', async () => {
      const prisma = fakePrisma({
        items: [
          ...makeItems(2, { severity: ReconciliationSeverity.CRITICAL }),
          ...makeItems(3, { severity: ReconciliationSeverity.WARNING }),
          ...makeItems(1, { severity: ReconciliationSeverity.INFO }),
          // ⚠️ **已处置的不该被算进去** —— 这条是「RESOLVED」
          ...makeItems(1, {
            severity: ReconciliationSeverity.CRITICAL,
            resolution: ReconciliationResolution.RESOLVED,
          }),
        ],
      });
      const service = makeService(prisma, emptyProvider());

      const summary = await service.summary();

      expect(summary).toEqual({
        pendingCritical: 2,
        pendingWarning: 3,
        pendingInfo: 1,
      });
    });

    it('⚠️ 在数据库里聚合，不把全部未处置差异拉进内存', async () => {
      const prisma = fakePrisma({
        items: makeItems(3, { severity: ReconciliationSeverity.CRITICAL }),
      });
      const service = makeService(prisma, emptyProvider());

      await service.summary();

      expect(prisma.payoutReconciliationItem.groupBy).toHaveBeenCalledWith({
        by: ['severity'],
        where: { resolution: ReconciliationResolution.PENDING },
        _count: { _all: true },
      });
      // ⚠️ **不能走 `findMany`** —— 那就是把全表拉进内存数（阶段 5m 技术债）
      expect(prisma.payoutReconciliationItem.findMany).not.toHaveBeenCalled();
    });

    it('某一档没有差异时按 0 算，不把 undefined 漏进返回值', async () => {
      const prisma = fakePrisma({
        items: makeItems(1, { severity: ReconciliationSeverity.WARNING }),
      });
      const service = makeService(prisma, emptyProvider());

      const summary = await service.summary();

      expect(summary).toEqual({
        pendingCritical: 0,
        pendingWarning: 1,
        pendingInfo: 0,
      });
    });
  });

  describe('detail', () => {
    it('差异项不足上限时全部返回，且不标记截断', async () => {
      const prisma = fakePrisma({ items: makeItems(5) });
      const service = makeService(prisma, emptyProvider());

      const detail = (await service.detail('rec-1')) as {
        items: unknown[];
        itemsTotal: number;
        itemsTruncated: boolean;
      };

      expect(detail.items).toHaveLength(5);
      expect(detail.itemsTotal).toBe(5);
      expect(detail.itemsTruncated).toBe(false);
    });

    it('⚠️ 差异项超上限时在查询层截断，并报出真实总数', async () => {
      const prisma = fakePrisma({ items: makeItems(201) });
      const service = makeService(prisma, emptyProvider());

      const detail = (await service.detail('rec-1')) as {
        items: unknown[];
        itemsTotal: number;
        itemsTruncated: boolean;
      };

      expect(detail.items).toHaveLength(RECONCILIATION_MAX_ITEMS);
      expect(detail.itemsTotal).toBe(201);
      expect(detail.itemsTruncated).toBe(true);
    });

    it('⚠️ 差异项按 reconciliationId 限定，且带确定的排序', async () => {
      const prisma = fakePrisma({ items: makeItems(5) });
      const service = makeService(prisma, emptyProvider());

      await service.detail('rec-1');

      expect(prisma.payoutReconciliationItem.findMany).toHaveBeenCalledWith({
        where: { reconciliationId: 'rec-1' },
        // ⚠️ **双键** —— 同一批 `createMany` 的行 `createdAt` 相同，
        //    只按它排的话 `take` 截断选中哪 200 条是不确定的。
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: RECONCILIATION_MAX_ITEMS,
      });
      expect(prisma.payoutReconciliationItem.count).toHaveBeenCalledWith({
        where: { reconciliationId: 'rec-1' },
      });
    });

    it('⚠️ 第一个查询不把差异项一起捞出来（不许 include）', async () => {
      const prisma = fakePrisma({ items: makeItems(5) });
      const service = makeService(prisma, emptyProvider());

      await service.detail('rec-1');

      const args = prisma.payoutReconciliation.findFirst.mock.calls[0][0];
      // ⚠️ **`include: { items: true }` 就是「捞完再截断」** —— 必须没有
      expect(args.include).toBeUndefined();
    });

    it('查不到任务 → 抛 404', async () => {
      const prisma = fakePrisma({ reconciliation: null });
      const service = makeService(prisma, emptyProvider());

      await expect(service.detail('rec-404')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('拉渠道流水（循环翻页）', () => {
    it('⚠️ 按页拉取，拉不满就停；页码与每页条数都要传', async () => {
      const all = Array.from({ length: 1200 }, (_, i) =>
        channelRecord({ providerTxnId: `txn-${i}` }),
      );
      const listPayouts = jest.fn((args: ListPayoutsArgs) => {
        const start = ((args.page ?? 1) - 1) * CHANNEL_LIST_PAGE_SIZE;
        return Promise.resolve(
          all.slice(start, start + CHANNEL_LIST_PAGE_SIZE),
        );
      });
      const prisma = fakePrisma();
      const service = makeService(prisma, fakeProvider(listPayouts));

      await service.trigger({
        channel: FAKE_PAYOUT_CHANNEL,
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      // ⚠️ **1200 条 = 500 + 500 + 200** —— 第三页不满 → 停
      expect(listPayouts).toHaveBeenCalledTimes(3);
      expect(listPayouts.mock.calls.map((c) => c[0].page)).toEqual([1, 2, 3]);
      expect(listPayouts.mock.calls[0][0].pageSize).toBe(
        CHANNEL_LIST_PAGE_SIZE,
      );
      // ⚠️ **条数要真的落到任务上** —— `channelCount` 是拉到的流水数
      const data = prisma.payoutReconciliation.updateMany.mock.calls[0][0];
      expect(data?.data?.channelCount).toBe(1200);
    });

    it('⚠️ 翻页期间渠道侧数据变动造成的重复流水要去重', async () => {
      // ⚠️ **第二页与第一页重叠 200 条** —— 模拟「页边界漂移」
      const page1 = Array.from({ length: 500 }, (_, i) =>
        channelRecord({ providerTxnId: `txn-${i}` }),
      );
      const page2 = Array.from({ length: 500 }, (_, i) =>
        channelRecord({ providerTxnId: `txn-${i + 300}` }),
      );
      const page3 = Array.from({ length: 100 }, (_, i) =>
        channelRecord({ providerTxnId: `txn-${i + 800}` }),
      );
      const listPayouts = jest.fn((args: ListPayoutsArgs) => {
        if (args.page === 1) return Promise.resolve(page1);
        if (args.page === 2) return Promise.resolve(page2);
        return Promise.resolve(page3);
      });
      const prisma = fakePrisma();
      const service = makeService(prisma, fakeProvider(listPayouts));

      await service.trigger({
        channel: FAKE_PAYOUT_CHANNEL,
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      const data = prisma.payoutReconciliation.updateMany.mock.calls[0][0];
      // ⚠️ **1100 条原始流水 → 900 条去重后**（重复的 200 条被吃掉）
      expect(data?.data?.channelCount).toBe(900);
    });

    it('⚠️ providerTxnId 为空的记录不去重（否则会互相吞掉）', async () => {
      const page1 = Array.from({ length: 500 }, () =>
        channelRecord({ providerTxnId: '' }),
      );
      const listPayouts = jest.fn((args: ListPayoutsArgs) =>
        Promise.resolve(args.page === 1 ? page1 : []),
      );
      const prisma = fakePrisma();
      const service = makeService(prisma, fakeProvider(listPayouts));

      await service.trigger({
        channel: FAKE_PAYOUT_CHANNEL,
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      const data = prisma.payoutReconciliation.updateMany.mock.calls[0][0];
      // ⚠️ **500 条全部保留** —— 空串不是「同一笔流水」的标识
      expect(data?.data?.channelCount).toBe(500);
    });

    it('⚠️ 累计条数超上限 → 抛 409，文案与原来逐字一致', async () => {
      // ⚠️ **每页都返回满页** —— 模拟「provider 忽略分页参数、每页都返回全量」
      const listPayouts = jest.fn((args: ListPayoutsArgs) =>
        Promise.resolve(
          Array.from({ length: CHANNEL_LIST_PAGE_SIZE }, (_, i) =>
            channelRecord({ providerTxnId: `txn-${args.page}-${i}` }),
          ),
        ),
      );
      const prisma = fakePrisma();
      const service = makeService(prisma, fakeProvider(listPayouts));

      const error = await service
        .trigger({
          channel: FAKE_PAYOUT_CHANNEL,
          from: FROM,
          to: TO,
          operatorId: 'admin-1',
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      // ⚠️ **文案不能改** —— 运营与文档都按这句话理解
      expect((error as ConflictException).message).toBe(
        `渠道返回了 ${(RECONCILIATION_MAX_CHANNEL_RECORDS / CHANNEL_LIST_PAGE_SIZE + 1) * CHANNEL_LIST_PAGE_SIZE} 条流水，超过上限 ${RECONCILIATION_MAX_CHANNEL_RECORDS} 条，请缩小时间窗`,
      );
      // ⚠️ **它同时是死循环的保险丝** —— 不会无限翻页
      expect(listPayouts).toHaveBeenCalledTimes(
        RECONCILIATION_MAX_CHANNEL_RECORDS / CHANNEL_LIST_PAGE_SIZE + 1,
      );
    });
  });

  describe('阶段 6b：翻页超时预算', () => {
    /** 记录告警的假 sink（断言「超预算会告警」用） */
    function spySink(): { alerts: ChannelAlert[]; sink: ChannelAlertSink } {
      const alerts: ChannelAlert[] = [];
      return { alerts, sink: { alert: (event) => alerts.push(event) } };
    }

    it('预算 = 页数 × 单页超时：20 页 × 单页 2 秒不会再被 30 秒打断', () => {
      // ⚠️ **单页 2 秒是需求里的真渠道假设** —— 20 页要 40 秒，旧实现必超时
      const pageTimeoutMs = reconciliationPageTimeoutMs(undefined);
      expect(pageTimeoutMs).toBe(RECONCILIATION_PAGE_TIMEOUT_MS);

      const budgetMs = reconciliationTimeoutBudget(20, pageTimeoutMs);
      expect(budgetMs).toBe(20 * RECONCILIATION_PAGE_TIMEOUT_MS);
      expect(budgetMs).toBeGreaterThan(20 * 2_000);
    });

    it('渠道声明了更长的单页超时 → 尊重它；更短的 → 对账页仍用 30 秒', () => {
      expect(reconciliationPageTimeoutMs(45_000)).toBe(45_000);
      expect(reconciliationPageTimeoutMs(1_000)).toBe(
        RECONCILIATION_PAGE_TIMEOUT_MS,
      );
    });

    it('⚠️ 20 页 × 单页 2 秒的模拟渠道能正常跑完（旧实现 30 秒必超时）', async () => {
      jest.useFakeTimers();
      try {
        const fullPage = Array.from(
          { length: CHANNEL_LIST_PAGE_SIZE },
          (_, i) => channelRecord({ providerTxnId: `txn-${i}` }),
        );
        // ⚠️ **每页慢 2 秒**：前 20 页拿满、第 21 页空页结束
        const listPayouts = jest.fn(
          (args: ListPayoutsArgs) =>
            new Promise<ChannelPayoutRecord[]>((resolve) => {
              setTimeout(
                () => resolve((args.page ?? 1) <= 20 ? fullPage : []),
                2_000,
              );
            }),
        );
        const prisma = fakePrisma();
        const service = makeService(prisma, fakeProvider(listPayouts));

        const pending = service.trigger({
          channel: FAKE_PAYOUT_CHANNEL,
          from: FROM,
          to: TO,
          operatorId: 'admin-1',
        });

        // ⚠️ **只推进 50 秒**（约 21 页 × 2 秒），远小于 21 × 30 秒的预算
        await jest.advanceTimersByTimeAsync(50_000);
        const result = await pending;

        expect(result.status).toBe('COMPLETED');
        expect(listPayouts).toHaveBeenCalledTimes(21);
      } finally {
        jest.useRealTimers();
      }
    });

    it('⚠️ 超预算时抛与现有一致的中文错误，文案带渠道名与页数，并告警', async () => {
      jest.useFakeTimers();
      try {
        const { alerts, sink } = spySink();
        // ⚠️ **永远不返回** —— 逼出总预算超时
        const listPayouts = jest.fn<
          Promise<ChannelPayoutRecord[]>,
          [ListPayoutsArgs]
        >(() => new Promise<ChannelPayoutRecord[]>(() => {}));
        const prisma = fakePrisma();
        const service = makeService(
          prisma,
          fakeProvider(listPayouts),
          realResolver(prisma),
          sink,
        );

        const pending = service
          .trigger({
            channel: FAKE_PAYOUT_CHANNEL,
            from: FROM,
            to: TO,
            operatorId: 'admin-1',
          })
          .then(
            () => null,
            (error: unknown) => error,
          );

        const budgetMs =
          RECONCILIATION_MAX_PAGES * RECONCILIATION_PAGE_TIMEOUT_MS;
        await jest.advanceTimersByTimeAsync(budgetMs + 1);
        const error = await pending;

        // ⚠️ **仍是原来那个 `TimeoutError`**（不引入新错误类型）
        expect(error).toBeInstanceOf(TimeoutError);
        const message = (error as Error).message;
        expect(message).toContain('操作超时');
        expect(message).toContain(FAKE_PAYOUT_CHANNEL);
        expect(message).toContain(`${RECONCILIATION_MAX_PAGES} 页`);

        // ⚠️ **只多一条结构化告警，行为不变**
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          channel: FAKE_PAYOUT_CHANNEL,
          provider: 'fake-payout',
          operation: 'reconcile',
          definitive: false,
        });
        expect(typeof alerts[0].elapsedMs).toBe('number');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * ⚠️ **阶段 6a Task 7 的分水岭**：从这一批用例开始，`makeService` 默认装上
   *    **真实的 resolver**（而不是 mock）—— 渠道隔离、CSV 自动纠正闸、
   *    批量确认都靠它落库，mock 会让「where 写错」的缺陷静默通过。
   */
  describe('阶段 6a：对账渠道隔离', () => {
    /** 一条渠道流水（匹配到本地单的 `payoutNo`） */
    function matchedRecord(
      payoutNo: string,
      over: Partial<ChannelPayoutRecord> = {},
    ): ChannelPayoutRecord {
      return channelRecord({
        providerTxnId: `txn-${payoutNo}`,
        referenceNo: payoutNo,
        amount: 1000,
        status: 'SUCCESS',
        ...over,
      });
    }

    it('同一时间窗两家渠道的单互不进入对方的比对结果', async () => {
      const prisma = fakePrisma({
        payouts: [
          makePayoutRow({
            id: 'p-alpha',
            payoutChannel: 'alpha',
            status: 'PROCESSING',
            processingAt: new Date('2026-03-01T09:00:00.000Z'),
          }),
          makePayoutRow({
            id: 'p-beta',
            payoutChannel: 'beta',
            status: 'PROCESSING',
            processingAt: new Date('2026-03-01T09:00:00.000Z'),
          }),
        ],
        reconciliation: { id: 'rec-1', channel: 'alpha', status: 'COMPLETED' },
      });
      const service = makeService(prisma, emptyProvider());

      // 账单（CSV）里只有 alpha 那条单的流水
      await service.importRecords({
        channel: 'alpha',
        fileName: 'alpha.csv',
        columnMapping: '{}',
        records: [matchedRecord('PO-p-alpha')],
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      // ⚠️ **只载入了 alpha 的单** —— beta 的单既没进比对，也没被误判成 E 类
      const saved = prisma.payoutReconciliation.updateMany.mock.calls[0][0];
      expect(saved?.data?.localCount).toBe(1);
      const diffRows = prisma.payoutReconciliationItem.createMany.mock
        .calls[0][0] as { data: Array<{ payoutId?: string | null }> };
      expect(diffRows.data.some((d) => d.payoutId === 'p-beta')).toBe(false);
      // ⚠️ **渠道过滤要真的下推到查询**（不能取回来再在内存里筛）
      const query = prisma.payout.findMany.mock.calls[0][0] as {
        where?: unknown;
      };
      expect(JSON.stringify(query.where)).toContain('alpha');
    });

    it('渠道 A 的去重不把渠道 B 的同 (payoutId, type) PENDING 项标掉', async () => {
      const prisma = fakePrisma({
        payouts: [
          makePayoutRow({
            id: 'p-1',
            payoutChannel: 'alpha',
            status: 'PROCESSING',
          }),
        ],
        items: [
          makeReconcileItem({
            id: 'item-alpha',
            reconciliationId: 'rec-alpha',
            payoutId: 'p-1',
          }),
          makeReconcileItem({
            id: 'item-beta',
            reconciliationId: 'rec-beta',
            payoutId: 'p-1',
          }),
        ],
        reconciliation: {
          id: 'rec-1',
          channel: 'alpha',
          status: 'COMPLETED',
        },
        reconciliationChannels: {
          'rec-alpha': 'alpha',
          'rec-beta': 'beta',
          'rec-1': 'alpha',
        },
      });
      const service = makeService(prisma, emptyProvider());

      await service.importRecords({
        channel: 'alpha',
        fileName: 'alpha.csv',
        columnMapping: '{}',
        records: [matchedRecord('PO-p-1')],
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      // ⚠️ **同渠道（alpha）的历史 PENDING 项被取代**
      expect(
        prisma.__items.find((i) => i.id === 'item-alpha')?.resolution,
      ).toBe(ReconciliationResolution.IGNORED);
      // ⚠️ **别的渠道（beta）的同 (payoutId, type) PENDING 项必须原样保留**
      expect(prisma.__items.find((i) => i.id === 'item-beta')?.resolution).toBe(
        ReconciliationResolution.PENDING,
      );
      // ⚠️ **每一条去重更新都带渠道限定** —— 没有渠道限定就等于跨渠道误伤
      const supersedeCalls =
        prisma.payoutReconciliationItem.updateMany.mock.calls
          .map(
            (call) =>
              (
                call[0] as {
                  where?: {
                    payoutId?: string;
                    reconciliation?: { channel?: string };
                  };
                }
              ).where,
          )
          // ⚠️ 只挑**去重更新**（带关系过滤），不把 CSV 备注更新混进来
          .filter((where) => where?.reconciliation !== undefined);
      expect(supersedeCalls.length).toBeGreaterThan(0);
      for (const where of supersedeCalls) {
        expect(where?.reconciliation?.channel).toBe('alpha');
      }
    });

    it('payoutChannel = null 的存量单只在平台默认渠道里纳入', async () => {
      const legacy = makePayoutRow({
        id: 'p-legacy',
        payoutChannel: null,
        status: 'PAID',
        paidAt: new Date('2026-03-01T09:00:00.000Z'),
      });
      const prisma = fakePrisma({
        payouts: [legacy],
        defaultChannelSetting: {
          key: 'payout.platformDefaultChannel',
          value: { channel: FAKE_PAYOUT_CHANNEL },
        },
        reconciliation: {
          id: 'rec-1',
          channel: FAKE_PAYOUT_CHANNEL,
          source: ReconciliationSource.FILE,
          status: 'COMPLETED',
        },
      });
      const service = makeService(prisma, emptyProvider());

      // 平台默认渠道 → 存量单纳入
      await service.importRecords({
        channel: FAKE_PAYOUT_CHANNEL,
        fileName: 'default.csv',
        columnMapping: '{}',
        records: [],
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });
      const defaultRun =
        prisma.payoutReconciliation.updateMany.mock.calls[0][0];
      expect(defaultRun?.data?.localCount).toBe(1);

      // 非默认渠道 → 存量单不纳入
      await service.importRecords({
        channel: 'other',
        fileName: 'other.csv',
        columnMapping: '{}',
        records: [],
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });
      const otherRun = prisma.payoutReconciliation.updateMany.mock.calls[1][0];
      expect(otherRun?.data?.localCount).toBe(0);
    });
  });

  describe('阶段 6a：CSV 自动纠正闸', () => {
    it('CSV 来源的 A 类差异不自动改成 PAID，落 PENDING 人工项并留备注', async () => {
      const prisma = fakePrisma({
        payouts: [makePayoutRow({ id: 'p-1', status: 'PROCESSING' })],
        reconciliation: {
          id: 'rec-1',
          channel: FAKE_PAYOUT_CHANNEL,
          source: ReconciliationSource.FILE,
          status: 'COMPLETED',
        },
      });
      const service = makeService(prisma, emptyProvider());

      await service.importRecords({
        channel: FAKE_PAYOUT_CHANNEL,
        fileName: 'bill.csv',
        columnMapping: '{}',
        records: [
          channelRecord({
            providerTxnId: 'txn-1',
            referenceNo: 'PO-p-1',
            amount: 1000,
            status: 'SUCCESS',
          }),
        ],
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      // ⚠️ **出款单状态没动** —— CSV 是运营自己上传的，机器不替人改钱
      const payout = await prisma.payout.findFirst({ where: { id: 'p-1' } });
      expect(payout?.status).toBe('PROCESSING');
      // ⚠️ **没有写任何出款操作留痕**
      expect(prisma.payoutOperation.create).not.toHaveBeenCalled();
      // ⚠️ **差异项保持 PENDING，并写上「需人工确认」**
      const noteUpdate =
        prisma.payoutReconciliationItem.updateMany.mock.calls.find(
          (call) =>
            (call[0] as { data?: { note?: string } }).data?.note ===
            'CSV 来源需人工确认',
        );
      expect(noteUpdate).toBeDefined();
      expect(
        (noteUpdate![0] as { where?: { resolution?: string } }).where
          ?.resolution,
      ).toBe(ReconciliationResolution.PENDING);
    });

    it('API 来源的 A 类差异仍然自动纠正为 PAID（回归）', async () => {
      const prisma = fakePrisma({
        payouts: [makePayoutRow({ id: 'p-1', status: 'PROCESSING' })],
        reconciliation: {
          id: 'rec-1',
          channel: FAKE_PAYOUT_CHANNEL,
          source: ReconciliationSource.API,
          status: 'COMPLETED',
        },
      });
      const listPayouts = jest.fn<
        Promise<ChannelPayoutRecord[]>,
        [ListPayoutsArgs]
      >(() =>
        Promise.resolve([
          channelRecord({
            providerTxnId: 'txn-1',
            referenceNo: 'PO-p-1',
            amount: 1000,
            status: 'SUCCESS',
          }),
        ]),
      );
      const service = makeService(prisma, fakeProvider(listPayouts));

      await service.trigger({
        channel: FAKE_PAYOUT_CHANNEL,
        from: FROM,
        to: TO,
        operatorId: 'admin-1',
      });

      const payout = await prisma.payout.findFirst({ where: { id: 'p-1' } });
      expect(payout?.status).toBe('PAID');
      // ⚠️ **留痕用自动纠正的动作**（不是人工批量确认那个）
      const autoLog = prisma.payoutOperation.create.mock.calls[0][0] as {
        data: { action: string; operatorId: string };
      };
      expect(autoLog.data.action).toBe(PayoutOperationAction.RECONCILE_TO_PAID);
      expect(autoLog.data.operatorId).toBe('system:reconciliation');
    });
  });

  describe('阶段 6a：批量确认', () => {
    /** 造若干「可批量确认」的差异项：PENDING + A 类 + 有 payoutId */
    function actionableItems(count: number, prefix = 'item') {
      return Array.from({ length: count }, (_, i) => {
        const id = `${prefix}-${String(i).padStart(4, '0')}`;
        return makeReconcileItem({
          id,
          payoutId: `p-${String(i).padStart(4, '0')}`,
          channelTxnId: `txn-${i}`,
        });
      });
    }

    /** 造与差异项一一对应的本地单（都是 PROCESSING） */
    function processingPayouts(count: number) {
      return Array.from({ length: count }, (_, i) =>
        makePayoutRow({
          id: `p-${String(i).padStart(4, '0')}`,
          status: 'PROCESSING',
        }),
      );
    }

    function fileReconciliation(over: Record<string, unknown> = {}) {
      return {
        id: 'rec-1',
        channel: FAKE_PAYOUT_CHANNEL,
        source: ReconciliationSource.FILE,
        status: 'COMPLETED',
        ...over,
      };
    }

    it('IDS：3 条里 1 条已处置 → 2 成功 1 失败，成功项留痕 BY_FILE 并变 RESOLVED', async () => {
      const items = actionableItems(3);
      items[2].resolution = ReconciliationResolution.RESOLVED;
      const prisma = fakePrisma({
        items,
        payouts: processingPayouts(3),
        reconciliation: fileReconciliation(),
      });
      const service = makeService(prisma, emptyProvider());

      const result = await service.batchConfirm({
        reconciliationId: 'rec-1',
        mode: 'IDS',
        itemIds: items.map((i) => i.id),
        note: '运营核对账单后批量确认',
        operatorId: 'admin-1',
      });

      expect(result.succeeded).toEqual([items[0].id, items[1].id]);
      expect(result.failed.map((f) => f.id)).toEqual([items[2].id]);
      expect(result.nextCursor).toBeNull();
      // ⚠️ **成功项：出款单变 PAID + 差异项变 RESOLVED + 人工留痕**
      expect(
        (await prisma.payout.findFirst({ where: { id: 'p-0000' } }))?.status,
      ).toBe('PAID');
      const op = prisma.payoutOperation.create.mock.calls.find(
        (call) =>
          (call[0] as { data: { action: string } }).data.action ===
          PayoutOperationAction.RECONCILE_TO_PAID_BY_FILE,
      );
      expect(op).toBeDefined();
      const opData = (
        op![0] as { data: { operatorId: string; reason: string } }
      ).data;
      expect(opData.operatorId).toBe('admin-1');
      expect(opData.reason).toContain('运营核对账单后批量确认');
      // ⚠️ **已处置那条：出款单没被改，也没多留一条人工确认痕迹**
      expect(
        (await prisma.payout.findFirst({ where: { id: 'p-0002' } }))?.status,
      ).toBe('PROCESSING');
      const opForThird = prisma.payoutOperation.create.mock.calls.find(
        (call) =>
          (call[0] as { data: { payoutId: string } }).data.payoutId ===
          'p-0002',
      );
      expect(opForThird).toBeUndefined();
    });

    it('FILTER：250 条、limit=200 → 第一批 200 + 游标，第二批 50 + null，不重不漏', async () => {
      const items = actionableItems(250);
      const prisma = fakePrisma({
        items,
        payouts: processingPayouts(250),
        reconciliation: fileReconciliation(),
      });
      const service = makeService(prisma, emptyProvider());

      const first = await service.batchConfirm({
        reconciliationId: 'rec-1',
        mode: 'FILTER',
        limit: 200,
        note: '全选确认',
        operatorId: 'admin-1',
      });
      expect(first.succeeded).toHaveLength(200);
      expect(first.nextCursor).toBe(items[199].id);

      const second = await service.batchConfirm({
        reconciliationId: 'rec-1',
        mode: 'FILTER',
        cursor: first.nextCursor!,
        limit: 200,
        note: '全选确认',
        operatorId: 'admin-1',
      });
      expect(second.succeeded).toHaveLength(50);
      expect(second.nextCursor).toBeNull();

      const all = [...first.succeeded, ...second.succeeded];
      expect(new Set(all).size).toBe(250);
      expect(all.sort()).toEqual(items.map((i) => i.id).sort());
    });

    it('FILTER：批次里有失败项时游标仍然前进（避免同一条无限重试）', async () => {
      const items = actionableItems(3);
      // ⚠️ **失败项仍满足 FILTER 的固定条件**（PENDING + A 类 + 有 payoutId），
      //    但出款单已被别人改成 PAID → `markPaid` 条件更新不命中 → 计失败。
      //    （若用「已处置的差异项」当失败样本，它压根进不了 FILTER 的查询结果，
      //    测不到「失败项也占用游标」这件事。）
      const payouts = processingPayouts(3);
      payouts[1].status = 'PAID';
      const prisma = fakePrisma({
        items,
        payouts,
        reconciliation: fileReconciliation(),
      });
      const service = makeService(prisma, emptyProvider());

      const first = await service.batchConfirm({
        reconciliationId: 'rec-1',
        mode: 'FILTER',
        limit: 2,
        note: '分批确认',
        operatorId: 'admin-1',
      });
      // ⚠️ **失败项也计入本批、游标也越过它**
      expect(first.failed.map((f) => f.id)).toEqual([items[1].id]);
      expect(first.nextCursor).toBe(items[1].id);

      const second = await service.batchConfirm({
        reconciliationId: 'rec-1',
        mode: 'FILTER',
        cursor: first.nextCursor!,
        limit: 2,
        note: '分批确认',
        operatorId: 'admin-1',
      });
      expect(second.succeeded).toEqual([items[2].id]);
      expect(second.nextCursor).toBeNull();
    });

    it('非 FILE 任务 → 409，且不改任何出款单', async () => {
      const items = actionableItems(2);
      const prisma = fakePrisma({
        items,
        payouts: processingPayouts(2),
        reconciliation: fileReconciliation({
          source: ReconciliationSource.API,
        }),
      });
      const service = makeService(prisma, emptyProvider());

      const error = await service
        .batchConfirm({
          reconciliationId: 'rec-1',
          mode: 'IDS',
          itemIds: items.map((i) => i.id),
          note: '试图确认',
          operatorId: 'admin-1',
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        '只有账单文件导入的对账任务支持批量确认',
      );
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
      expect(prisma.payoutOperation.create).not.toHaveBeenCalled();
    });

    it('两个并发请求处理同一批 → 只有一方成功，另一方计失败，不重复改单', async () => {
      const items = actionableItems(2);
      const prisma = fakePrisma({
        items,
        payouts: processingPayouts(2),
        reconciliation: fileReconciliation(),
      });
      const service = makeService(prisma, emptyProvider());
      const input = {
        reconciliationId: 'rec-1',
        mode: 'IDS' as const,
        itemIds: items.map((i) => i.id),
        note: '并发确认',
        operatorId: 'admin-1',
      };

      const [a, b] = await Promise.all([
        service.batchConfirm(input),
        service.batchConfirm(input),
      ]);

      // ⚠️ **每条单只可能被纠正一次** —— 条件更新把 `PROCESSING → PAID`
      //    卡住，后到的一方 `markPaid` 返回 false → 计 `failed`。
      expect(a.succeeded.length + b.succeeded.length).toBe(2);
      expect(a.failed.length + b.failed.length).toBe(2);
      const paid = await Promise.all([
        prisma.payout.findFirst({ where: { id: 'p-0000' } }),
        prisma.payout.findFirst({ where: { id: 'p-0001' } }),
      ]);
      expect(paid.map((p) => p?.status)).toEqual(['PAID', 'PAID']);
    });

    it('详情接口返回 actionableCount（只数 PENDING + A 类 + 有 payoutId）', async () => {
      const prisma = fakePrisma({
        items: [
          ...actionableItems(2),
          makeReconcileItem({
            id: 'item-b',
            type: ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
            payoutId: 'p-0000',
          }),
          makeReconcileItem({ id: 'item-null', payoutId: null }),
          makeReconcileItem({
            id: 'item-resolved',
            payoutId: 'p-0000',
            resolution: ReconciliationResolution.RESOLVED,
          }),
        ],
        reconciliation: fileReconciliation(),
      });
      const service = makeService(prisma, emptyProvider());

      const detail = (await service.detail('rec-1')) as {
        actionableCount: number;
      };
      expect(detail.actionableCount).toBe(2);
    });
  });
});
