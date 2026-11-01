import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  ReconciliationResolution,
  ReconciliationSeverity,
} from '@prisma/client';
import { FAKE_PAYOUT_CHANNEL } from '../../common/payment/fake-payout.provider';
import { CHANNEL_LIST_PAGE_SIZE } from '../../common/payment/payout.constants';
import type {
  ChannelPayoutRecord,
  PayoutProvider,
} from '../../common/payment/payout-provider.interface';
import {
  PayoutReconciliationService,
  RECONCILIATION_MAX_CHANNEL_RECORDS,
  RECONCILIATION_MAX_ITEMS,
} from './payout-reconciliation.service';

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
  } = {},
) {
  const items: FakeItem[] = options.items ? [...options.items] : [];
  const reconciliation =
    options.reconciliation === undefined
      ? { id: 'rec-1', channel: FAKE_PAYOUT_CHANNEL, status: 'COMPLETED' }
      : options.reconciliation;

  const prisma = {
    payoutReconciliation: {
      /**
       * ⚠️ **故意不处理 `include`** —— 见文件头注释。
       *    只按 `where.id` 返回任务本体。
       */
      findFirst: jest.fn<
        Promise<unknown>,
        [{ where?: { id?: string }; include?: unknown }]
      >(() => Promise.resolve(reconciliation)),
      create: jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>(
        (args) => Promise.resolve({ id: 'rec-1', ...args.data }),
      ),
      updateMany: jest.fn<
        Promise<{ count: number }>,
        [{ data?: { channelCount?: number } }]
      >(() => Promise.resolve({ count: 1 })),
      findMany: jest.fn<Promise<never[]>, [unknown]>(() => Promise.resolve([])),
      count: jest.fn<Promise<number>, [unknown]>(() => Promise.resolve(0)),
    },
    payoutReconciliationItem: {
      findMany: jest.fn<
        Promise<FakeItem[]>,
        [
          {
            where?: { reconciliationId?: string };
            orderBy?:
              | { createdAt?: 'asc' | 'desc' }
              | Array<{ createdAt?: 'asc' | 'desc' } | { id?: 'asc' | 'desc' }>;
            take?: number;
          },
        ]
      >((args) => {
        const matched = items.filter(
          (i) =>
            !args.where?.reconciliationId ||
            i.reconciliationId === args.where.reconciliationId,
        );
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
        [{ where?: { reconciliationId?: string } }]
      >((args) =>
        Promise.resolve(
          items.filter(
            (i) =>
              !args.where?.reconciliationId ||
              i.reconciliationId === args.where.reconciliationId,
          ).length,
        ),
      ),
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
      createMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
        Promise.resolve({ count: 0 }),
      ),
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
        Promise.resolve({ count: 0 }),
      ),
      findFirst: jest.fn<Promise<null>, [unknown]>(() => Promise.resolve(null)),
    },
    payout: {
      findMany: jest.fn<Promise<never[]>, [unknown]>(() => Promise.resolve([])),
    },
    databaseNow: jest.fn<Promise<Date>, []>(() =>
      Promise.resolve(new Date('2026-03-08T00:00:00.000Z')),
    ),
  };

  return prisma;
}

/** 造一只假渠道（只有 `listPayouts` 有用） */
function fakeProvider(
  listPayouts: jest.Mock<Promise<ChannelPayoutRecord[]>, [ListPayoutsArgs]>,
): PayoutProvider {
  return {
    channel: FAKE_PAYOUT_CHANNEL,
    provider: 'fake-payout',
    execute: jest.fn(),
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

/** 假处置服务（自动纠正在本文件里不是重点） */
function fakeResolver() {
  return { resolveAutoDiffs: jest.fn(() => Promise.resolve(0)) };
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  provider: PayoutProvider,
): PayoutReconciliationService {
  return new PayoutReconciliationService(
    prisma as unknown as never,
    new Map<string, PayoutProvider>([[FAKE_PAYOUT_CHANNEL, provider]]),
    fakeResolver() as unknown as never,
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
});

afterAll(() => {
  delete process.env.FAKE_PAYOUT_ENABLED;
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
});
