import { BadRequestException } from '@nestjs/common';
import { CommissionEntryType } from '@prisma/client';
import {
  CommissionService,
  shouldBackfillCommission,
  shouldBackfillReversal,
} from './commission.service';

/**
 * 回填的判定规则（阶段 5e）。
 *
 * ⚠️ **断言要具体**：断言每个分支的确切判定结果，不是「返回了一个布尔值」。
 * 这两个纯函数是「回填」与「报表过滤」之间的**同一套口径**的载体 ——
 * 两者漂移了，流水表与报表的数字就对不上（对账 e2e 会红）。
 */
describe('回填的判定规则', () => {
  it('没付过钱 → 不回填抽佣', () => {
    expect(shouldBackfillCommission(null, 500)).toBe(false);
  });

  it('付过钱且金额非零 → 回填抽佣', () => {
    expect(
      shouldBackfillCommission(new Date('2026-01-01T00:00:00.000Z'), 500),
    ).toBe(true);
  });

  it('零额 → 不回填抽佣（免费套餐的费率是 0）', () => {
    expect(
      shouldBackfillCommission(new Date('2026-01-01T00:00:00.000Z'), 0),
    ).toBe(false);
  });

  it('没退款 → 不回填冲回', () => {
    expect(
      shouldBackfillReversal(false, new Date('2026-01-02T00:00:00.000Z'), 500),
    ).toBe(false);
  });

  it('已退款但 refundedAt 为 null → 不回填冲回（5b 之前退的款没记时间）', () => {
    expect(shouldBackfillReversal(true, null, 500)).toBe(false);
  });

  it('已退款且有 refundedAt → 回填冲回', () => {
    expect(
      shouldBackfillReversal(true, new Date('2026-01-02T00:00:00.000Z'), 500),
    ).toBe(true);
  });

  it('零额的已退款订单 → 不回填冲回', () => {
    expect(
      shouldBackfillReversal(true, new Date('2026-01-02T00:00:00.000Z'), 0),
    ).toBe(false);
  });
});

/**
 * 台账（ledger）的聚合与分页。
 *
 * ⚠️ **断言要具体**：groupBy 的 where 必须是**全区间**（byMerchant 是
 * 全区间汇总，不能只汇当前页）；分页夹取走 `clampPagination`。
 */
describe('台账的聚合与分页', () => {
  const from = new Date('2026-01-01T00:00:00.000Z');
  const to = new Date('2026-02-01T00:00:00.000Z');
  const rangeWhere = { occurredAt: { gte: from, lt: to } };

  const entry = {
    id: 'entry-1',
    tenantId: 'tenant-1',
    orderNo: 'ORD-1',
    type: CommissionEntryType.COMMISSION,
    amount: 500,
    rateBps: 500,
    baseAmount: 10000,
    occurredAt: new Date('2026-01-05T00:00:00.000Z'),
  };

  /** 只 mock ledger 用到的四个查询，其余模型 delegate 不该被碰到 */
  const makePrisma = () => ({
    commissionEntry: {
      findMany: jest.fn().mockResolvedValue([entry]),
      count: jest.fn().mockResolvedValue(23),
      groupBy: jest.fn().mockResolvedValue([
        {
          tenantId: 'tenant-1',
          type: CommissionEntryType.COMMISSION,
          _sum: { amount: 500 },
          _count: { _all: 1 },
        },
        {
          tenantId: 'tenant-1',
          type: CommissionEntryType.REVERSAL,
          _sum: { amount: -200 },
          _count: { _all: 1 },
        },
      ]),
    },
    tenant: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'tenant-1', name: '商家一', subdomain: 'merchant-one' },
      ]),
    },
  });

  it('page=2 / pageSize=10 → skip=10 / take=10，返回全区间 total', async () => {
    const prisma = makePrisma();
    const service = new CommissionService(prisma as never);

    const result = await service.ledger({ from, to, page: 2, pageSize: 10 });

    // ⚠️ **entries 只是其中一页**，而 total 是全区间的笔数
    expect(prisma.commissionEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: rangeWhere,
        orderBy: { occurredAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
    expect(result.total).toBe(23);
    expect(result.entries).toHaveLength(1);
  });

  it('byMerchant 来自 groupBy 的 _sum，且 where 是全区间（不受当前页影响）', async () => {
    const prisma = makePrisma();
    const service = new CommissionService(prisma as never);

    const result = await service.ledger({ from, to, page: 1, pageSize: 10 });

    // ⚠️ **groupBy 的 where 必须是全区间** —— 只汇当前页的话翻一页数字就变
    expect(prisma.commissionEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['tenantId', 'type'],
        where: rangeWhere,
        _sum: { amount: true },
      }),
    );
    // ⚠️ **按 type 拆开的组要并回一行**：净额 = 抽佣 500 + 冲回 -200，
    // 冲回笔数只数 REVERSAL 组
    expect(result.byMerchant).toHaveLength(1);
    expect(result.byMerchant[0].tenantId).toBe('tenant-1');
    expect(result.byMerchant[0].tenantName).toBe('商家一');
    expect(result.byMerchant[0].netAmount).toBe(300);
    expect(result.byMerchant[0].entryCount).toBe(2);
    expect(result.byMerchant[0].reversalCount).toBe(1);
  });

  it('from >= to 仍抛 BadRequestException', async () => {
    const service = new CommissionService(makePrisma() as never);

    await expect(
      service.ledger({ from: to, to: from }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
