import { PayoutStatus } from '@prisma/client';
import { ActivePayoutsError, guardBackfill } from './backfill-guard';

function fakePrisma(payouts: unknown[]) {
  return {
    payout: {
      findMany: jest.fn().mockResolvedValue(payouts),
    },
  };
}

describe('回填闸', () => {
  it('存在活跃/已付款出款单 → 默认拒绝并带出清单', async () => {
    const prisma = fakePrisma([
      {
        tenantId: 'tenant-a',
        payoutNo: 'PO-1',
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-01T00:00:00.000Z'),
        kind: 'NORMAL',
        status: PayoutStatus.PAID,
      },
    ]);

    await expect(guardBackfill(prisma as never, false)).rejects.toBeInstanceOf(
      ActivePayoutsError,
    );
    expect(prisma.payout.findMany).toHaveBeenCalledTimes(1);

    // 终态失败单不能出现在「活跃」集合里
    const calls = prisma.payout.findMany.mock.calls as Array<
      [{ where: { status: { in: PayoutStatus[] } } }]
    >;
    const where = calls[0][0].where;
    expect(where.status.in).toEqual(
      expect.arrayContaining([PayoutStatus.PAID]),
    );
    expect(where.status.in).not.toContain(PayoutStatus.REJECTED);
    expect(where.status.in).not.toContain(PayoutStatus.CANCELLED);
    expect(where.status.in).not.toContain(PayoutStatus.FAILED);
  });

  it('--force → 不查询，直接放行', async () => {
    const prisma = fakePrisma([
      { tenantId: 'tenant-a', payoutNo: 'PO-1', status: PayoutStatus.PAID },
    ]);

    await expect(guardBackfill(prisma as never, true)).resolves.toBeUndefined();
    expect(prisma.payout.findMany).not.toHaveBeenCalled();
  });

  it('只有终态失败单 → 放行', async () => {
    const prisma = fakePrisma([]);

    await expect(
      guardBackfill(prisma as never, false),
    ).resolves.toBeUndefined();
  });
});
