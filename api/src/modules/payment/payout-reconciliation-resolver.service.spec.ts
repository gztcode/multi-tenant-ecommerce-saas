import { PayoutOperationAction } from '@prisma/client';
import type { PayoutExecutionService } from '../billing/payout-execution.service';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PayoutReconciliationResolver } from './payout-reconciliation-resolver.service';
import type { ReconcileDiff } from './payout-reconcile.engine';

/**
 * 对账差异处置服务（阶段 6a Task 7）。
 *
 * 锁住三件事：
 * 1. `manualCorrectToPaid` 与单条 / 批量共用同一条路径，留痕动作可传；
 * 2. 纠正成功后**差异项标 `RESOLVED`**（并写 `note` / `resolvedBy` / `resolvedAt`）；
 * 3. 任何一步失败都不算「成功」（否则客户端会以为已经处置，实际没改钱）。
 */

/** 一条 A 类差异的最小形状 */
function aDiff(over: Partial<ReconcileDiff> = {}): ReconcileDiff {
  return {
    type: 'CHANNEL_PENDING_LOCAL',
    severity: 'INFO',
    payoutId: 'p-1',
    channelTxnId: 'txn-1',
    channelReferenceNo: 'PO-1',
    channelAmount: 1000,
    channelStatus: 'SUCCESS',
    channelPaidAt: new Date('2026-03-01T09:00:00.000Z'),
    localAmount: 1000,
    localStatus: 'PROCESSING',
    ...over,
  };
}

function makeMocks(options: { markPaid?: boolean; itemHit?: boolean } = {}) {
  const execution = {
    markPaid: jest.fn<Promise<boolean>, [string, unknown]>(() =>
      Promise.resolve(options.markPaid === undefined ? true : options.markPaid),
    ),
  };
  const prisma = {
    databaseNow: jest.fn<Promise<Date>, []>(() =>
      Promise.resolve(new Date('2026-03-08T00:00:00.000Z')),
    ),
    payout: {
      findFirst: jest.fn<Promise<{ payoutChannel: string } | null>, [unknown]>(
        () => Promise.resolve({ payoutChannel: 'fake-payout' }),
      ),
    },
    payoutOperation: {
      create: jest.fn<Promise<{ id: string }>, [{ data: unknown }]>(() =>
        Promise.resolve({ id: 'op-1' }),
      ),
    },
    payoutReconciliationItem: {
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
        Promise.resolve({
          count: options.itemHit === undefined ? 1 : options.itemHit ? 1 : 0,
        }),
      ),
    },
  };
  const resolver = new PayoutReconciliationResolver(
    execution as unknown as PayoutExecutionService,
    prisma as unknown as TenantPrismaService,
  );
  return { resolver, execution, prisma };
}

describe('PayoutReconciliationResolver（阶段 6a）', () => {
  describe('manualCorrectToPaid', () => {
    it('纠正成功 → 出款单改成 PAID、按传入动作留痕、差异项标 RESOLVED 并写处置人', async () => {
      const { resolver, execution, prisma } = makeMocks();

      const ok = await resolver.manualCorrectToPaid({
        payoutId: 'p-1',
        channelTxnId: 'txn-1',
        action: PayoutOperationAction.RECONCILE_TO_PAID_BY_FILE,
        operatorId: 'admin-1',
        reason: '运营核对账单后确认',
        reconciliationId: 'rec-1',
        itemId: 'item-1',
        note: '账单已核对',
      });

      expect(ok).toBe(true);
      expect(execution.markPaid).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({
          providerTxnId: 'txn-1',
          channel: 'fake-payout',
        }),
      );
      // ⚠️ 取实参逐字段断言，而不是 `objectContaining` 包一层 ——
      //    嵌套的 `expect.objectContaining` 会让 lint 把它当成 `any` 赋值。
      const created = prisma.payoutOperation.create.mock.calls[0][0] as {
        data: {
          payoutId: string;
          action: string;
          operatorId: string;
          reason: string;
          reconciliationId: string | null;
        };
      };
      expect(created.data.payoutId).toBe('p-1');
      expect(created.data.action).toBe(
        PayoutOperationAction.RECONCILE_TO_PAID_BY_FILE,
      );
      expect(created.data.operatorId).toBe('admin-1');
      expect(created.data.reason).toContain('运营核对账单后确认');
      expect(created.data.reconciliationId).toBe('rec-1');
      // ⚠️ **差异项按「仍待处置」做条件更新** —— 并发时后到的一方不应覆盖
      expect(prisma.payoutReconciliationItem.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'item-1',
          reconciliationId: 'rec-1',
          resolution: 'PENDING',
        },
        data: {
          resolution: 'RESOLVED',
          note: '账单已核对',
          resolvedBy: 'admin-1',
          resolvedAt: new Date('2026-03-08T00:00:00.000Z'),
        },
      });
    });

    it('出款单已被别人改成 PAID（条件更新没命中）→ 返回 false，不写留痕、不动差异项', async () => {
      const { resolver, prisma } = makeMocks({ markPaid: false });

      const ok = await resolver.manualCorrectToPaid({
        payoutId: 'p-1',
        channelTxnId: null,
        action: PayoutOperationAction.RECONCILE_TO_PAID_BY_FILE,
        operatorId: 'admin-1',
        reason: '并发重试',
        reconciliationId: 'rec-1',
        itemId: 'item-1',
        note: '并发重试',
      });

      expect(ok).toBe(false);
      expect(prisma.payoutOperation.create).not.toHaveBeenCalled();
      expect(prisma.payoutReconciliationItem.updateMany).not.toHaveBeenCalled();
    });

    it('⚠️ 不传 itemId（自动纠正路径）时只改出款单与留痕，不碰差异项', async () => {
      const { resolver, prisma } = makeMocks();

      const ok = await resolver.manualCorrectToPaid({
        payoutId: 'p-1',
        channelTxnId: 'txn-1',
        action: PayoutOperationAction.RECONCILE_TO_PAID,
        operatorId: 'system:reconciliation',
        reason: '渠道对账自动纠正',
        reconciliationId: 'rec-1',
      });

      expect(ok).toBe(true);
      expect(prisma.payoutReconciliationItem.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveAutoDiffs', () => {
    it('API 来源 → 自动纠正 A 类（动作 RECONCILE_TO_PAID）', async () => {
      const { resolver, execution, prisma } = makeMocks();

      const resolved = await resolver.resolveAutoDiffs(
        [aDiff(), aDiff({ type: 'CHANNEL_SUCCESS_LOCAL_FAILED' })],
        'rec-1',
        'API',
      );

      // ⚠️ **B 类不在自动纠正范围** —— 机器不改一笔钱的状态
      expect(resolved).toBe(1);
      expect(execution.markPaid).toHaveBeenCalledTimes(1);
      expect(
        (
          prisma.payoutOperation.create.mock.calls[0][0] as {
            data: { action: string };
          }
        ).data.action,
      ).toBe(PayoutOperationAction.RECONCILE_TO_PAID);
    });

    it('FILE 来源 → 不改状态、不写留痕，A 类留 PENDING 并写「CSV 来源需人工确认」', async () => {
      const { resolver, execution, prisma } = makeMocks();

      const resolved = await resolver.resolveAutoDiffs(
        [aDiff()],
        'rec-1',
        'FILE',
      );

      expect(resolved).toBe(0);
      expect(execution.markPaid).not.toHaveBeenCalled();
      expect(prisma.payoutOperation.create).not.toHaveBeenCalled();
      expect(prisma.payoutReconciliationItem.updateMany).toHaveBeenCalledWith({
        where: {
          payoutId: 'p-1',
          type: 'CHANNEL_PENDING_LOCAL',
          reconciliationId: 'rec-1',
          resolution: 'PENDING',
        },
        data: { note: 'CSV 来源需人工确认' },
      });
    });
  });
});
