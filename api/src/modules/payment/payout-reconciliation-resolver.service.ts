import { Injectable, Logger } from '@nestjs/common';
import {
  PayoutOperationAction,
  PayoutStatus,
  ReconciliationResolution,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import type { ReconcileDiff } from './payout-reconcile.engine';

/** 对账任务的数据来源（与 Prisma 的 `ReconciliationSource` 逐字一致） */
export type ReconciliationDiffSource = 'API' | 'FILE';

/**
 * CSV 来源的 A 类差异落在人工项上的备注。
 *
 * ⚠️ **与设计 §7.3 逐字一致** —— 运营看到这句话就知道「这条不是系统改的」。
 */
export const CSV_PENDING_NOTE = 'CSV 来源需人工确认';

/**
 * 对账差异的处置服务（阶段 5m，阶段 6a 扩充）。
 *
 * ## 三条处置路径
 *
 * | 类型 | 处置 | 依据 |
 * |---|---|---|
 * | **A 类**（`CHANNEL_PENDING_LOCAL`），API 来源 | **自动纠正** `PROCESSING → PAID` | 渠道是权威 |
 * | **A 类**，CSV 来源 | **人工确认** `PROCESSING → PAID`（单条 / 批量共用） | 账单是人传的，机器不替人改钱 |
 * | **B 类**（`CHANNEL_SUCCESS_LOCAL_FAILED`） | **人工处置** `FAILED → PAID`（走四道闸） | ⚠️ 机器不改一笔钱的状态 |
 *
 * ⚠️ **B 类**的实现在 billing 的 `PayoutExecutionService.confirmPaidAfterReconciliation`
 *    （它要改 `payouts` + `settlement_statements` + `payout_entries` 三张表，
 *    与 `markPaid` 同处一地才不会漏掉结算单联动）。
 *
 * ⚠️ **A 类纠正只有一条实现**（`manualCorrectToPaid`）：自动纠正、单条确认、
 *    批量确认都走它 —— 两条路径各写一份「改钱 + 留痕」必然漂。
 */
@Injectable()
export class PayoutReconciliationResolver {
  private readonly logger = new Logger(PayoutReconciliationResolver.name);

  constructor(
    private readonly execution: PayoutExecutionService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /**
   * 自动纠正 A 类差异。
   *
   * - `source === 'API'`：保持阶段 5m 的行为 —— 直接 `PROCESSING → PAID`。
   * - `source === 'FILE'`：**不自动改状态** —— CSV 是运营上传的账单，
   *   账单本身可能录错；把 A 类留成 `PENDING` 人工项并写明「需人工确认」，
   *   由运营逐条或批量确认（`manualCorrectToPaid`）。
   *
   * @returns 真正被纠正的条数（CSV 来源恒为 0）
   */
  async resolveAutoDiffs(
    diffs: ReconcileDiff[],
    reconciliationId: string,
    source: ReconciliationDiffSource,
  ): Promise<number> {
    const actionable = diffs.filter(
      (diff) => diff.type === 'CHANNEL_PENDING_LOCAL' && diff.payoutId,
    );
    if (source === 'FILE') {
      await this.markPendingRequiresManual(actionable, reconciliationId);
      return 0;
    }
    let resolved = 0;
    for (const diff of actionable) {
      const ok = await this.manualCorrectToPaid({
        payoutId: diff.payoutId!,
        channelTxnId: diff.channelTxnId,
        action: PayoutOperationAction.RECONCILE_TO_PAID,
        // ⚠️ **定时/自动纠正没有真人** → 用系统身份
        operatorId: 'system:reconciliation',
        reason: `渠道对账：渠道确认已打款，本地纠正为已付款（渠道流水号 ${diff.channelTxnId ?? '未知'}）`,
        reconciliationId,
      });
      if (ok) {
        resolved += 1;
      }
    }
    return resolved;
  }

  /**
   * A 类纠正：`PROCESSING → PAID`（单条 / 批量 / 自动纠正共用）。
   *
   * ⚠️ **`paidAt` 用数据库时钟**，不是渠道时刻 —— `payouts.paidAt` 在正常流程里
   *    是 `databaseNow()`，混用两套时钟会让对账窗口筛选失真。
   *    渠道时刻只存在对账的 item 表与留痕的 reason 里。
   *
   * ⚠️ **传了 `itemId` 才会把差异项标 `RESOLVED`** —— 自动纠正没有逐条
   *    `updateMany` 的上下文（只按 `(payoutId, type)` 能命中同渠道多条），
   *    人工确认才有明确的差异项 id。
   *
   * @returns 出款单是否真的被纠正（条件更新命中）
   */
  async manualCorrectToPaid(input: {
    payoutId: string;
    channelTxnId: string | null;
    action: PayoutOperationAction;
    operatorId: string;
    reason: string;
    reconciliationId: string;
    itemId?: string;
    /** 差异项的处置说明（不传时沿用 `reason`） */
    note?: string;
  }): Promise<boolean> {
    const { payoutId } = input;
    return tenantContext.run(platformScope(), async () => {
      const paidAt = await this.prisma.databaseNow();
      const channel = await this.prisma.payout.findFirst({
        where: { id: payoutId },
        select: { payoutChannel: true },
      });
      const ok = await this.execution.markPaid(payoutId, {
        providerTxnId: input.channelTxnId ?? '',
        channel: channel?.payoutChannel ?? 'fake-payout',
        paidAt,
      });
      if (!ok) {
        // ⚠️ **条件更新没命中** —— 状态已被改掉（worker 抢先落了 PAID，
        //    或另一位运营已经确认过）。**不报错**，由调用方计入失败。
        this.logger.warn(
          `对账纠正 ${payoutId} 未命中（状态已变，可能 worker 抢先落了 PAID）`,
        );
        return false;
      }
      // ⚠️ **留痕失败不能带倒状态变更** —— `markPaid` 已经是事务、状态已落库，
      //    这时抛错会让整轮对账中断，而「钱记成已付但单子没留痕」是最难查的一类问题。
      //    → 留痕单独兜住，失败只记日志（规格 §二·2.2 的「但要记日志」）。
      try {
        await this.prisma.payoutOperation.create({
          data: {
            payoutId,
            action: input.action,
            operatorId: input.operatorId,
            reason: input.reason,
            fromStatus: PayoutStatus.PROCESSING,
            toStatus: PayoutStatus.PAID,
            reconciliationId: input.reconciliationId,
          },
        });
      } catch (error) {
        // ⚠️ **状态已经是事实了** —— 纠正成功就是成功，不能因为留痕失败
        //    就把它算成「没纠正」（那会让对账任务反复重试同一张单）。
        this.logger.error(
          `对账纠正 ${payoutId} 成功但留痕失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (input.itemId) {
        // ⚠️ **差异项也按「仍待处置」做条件更新** —— 并发时后到的一方
        //    `markPaid` 已经失败了（早返回），这里再守一道是防「两处状态不一致」：
        //    差异项若已被别人处置掉，不覆盖别人的处置说明。
        await this.prisma.payoutReconciliationItem.updateMany({
          where: {
            id: input.itemId,
            reconciliationId: input.reconciliationId,
            resolution: ReconciliationResolution.PENDING,
          },
          data: {
            resolution: ReconciliationResolution.RESOLVED,
            note: input.note ?? input.reason,
            resolvedBy: input.operatorId,
            resolvedAt: paidAt,
          },
        });
      }
      return true;
    });
  }

  /**
   * CSV 来源：把 A 类差异留成 `PENDING` 人工项，并写明需要人工确认。
   *
   * ⚠️ **只改备注、不改状态** —— `resolution` 仍是 `PENDING`，
   *    `where` 里也带上它，避免把已经被别人处置掉的项备注覆盖掉。
   */
  private async markPendingRequiresManual(
    diffs: ReconcileDiff[],
    reconciliationId: string,
  ): Promise<void> {
    await tenantContext.run(platformScope(), async () => {
      for (const diff of diffs) {
        await this.prisma.payoutReconciliationItem.updateMany({
          where: {
            payoutId: diff.payoutId!,
            type: diff.type,
            reconciliationId,
            resolution: ReconciliationResolution.PENDING,
          },
          data: { note: CSV_PENDING_NOTE },
        });
      }
    });
  }
}
