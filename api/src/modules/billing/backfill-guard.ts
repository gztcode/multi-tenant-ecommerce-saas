import { PayoutStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

/**
 * 「钱已经可能出去了」的出款状态。
 *
 * ⚠️ 只有 REJECTED / CANCELLED / FAILED 不算：它们没有把钱打出去。
 *    FAILED 仍然挂着 statementId，但失败不代表出款成功。
 */
const ACTIVE_PAYOUT_STATUSES = [
  PayoutStatus.REQUESTED,
  PayoutStatus.APPROVED,
  PayoutStatus.PROCESSING,
  PayoutStatus.PAID,
];

/** 一张阻止回填的出款单 */
export interface ActivePayoutPeriod {
  tenantId: string;
  payoutNo: string;
  periodStart: Date;
  periodEnd: Date;
  kind: string;
  status: PayoutStatus;
}

/** 有活跃出款单时抛出；调用方负责打印清单并非零退出。 */
export class ActivePayoutsError extends Error {
  constructor(readonly payouts: ActivePayoutPeriod[]) {
    super(
      `存在 ${payouts.length} 张未终结的出款单，拒绝对这些周期回填（重复回填 = 重复出款）。` +
        '确认要跳过着保护时使用 --force。',
    );
    this.name = 'ActivePayoutsError';
  }
}

/**
 * 回填前的闸。
 *
 * ⚠️ **必须在平台作用域下调用**：出款单是跨租户的，租户作用域只会看到一家。
 * ⚠️ **force 连查询都不做**：`--force` 是显式的运维决定，不需要再读一遍清单。
 */
export async function guardBackfill(
  prisma: TenantPrismaService,
  force: boolean,
): Promise<void> {
  if (force) {
    return;
  }

  const active = await prisma.payout.findMany({
    where: { status: { in: ACTIVE_PAYOUT_STATUSES } },
    select: {
      tenantId: true,
      payoutNo: true,
      periodStart: true,
      periodEnd: true,
      kind: true,
      status: true,
    },
    orderBy: { periodStart: 'asc' },
  });

  if (active.length > 0) {
    throw new ActivePayoutsError(active);
  }
}
