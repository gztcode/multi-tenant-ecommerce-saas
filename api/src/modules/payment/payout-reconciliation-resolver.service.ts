import { Injectable, Logger } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import type { ReconcileDiff } from './payout-reconcile.engine';

/**
 * 对账差异的处置服务（阶段 5m）。
 *
 * ## 两条处置路径
 *
 * | 类型 | 处置 | 依据 |
 * |---|---|---|
 * | **A 类**（`CHANNEL_PENDING_LOCAL`） | **自动纠正** `PROCESSING → PAID` | 渠道是权威 |
 * | **B 类**（`CHANNEL_SUCCESS_LOCAL_FAILED`） | **人工处置** `FAILED → PAID`（走四道闸） | ⚠️ 机器不改一笔钱的状态 |
 *
 * ⚠️ **B 类**的实现在 billing 的 `PayoutExecutionService.confirmPaidAfterReconciliation`
 *    （它要改 `payouts` + `settlement_statements` + `payout_entries` 三张表，
 *    与 `markPaid` 同处一地才不会漏掉结算单联动）。
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
   * @returns 纠正成功的条数
   */
  async resolveAutoDiffs(
    diffs: ReconcileDiff[],
    reconciliationId: string,
  ): Promise<number> {
    let resolved = 0;
    for (const diff of diffs) {
      if (diff.type !== 'CHANNEL_PENDING_LOCAL' || !diff.payoutId) {
        continue;
      }
      const ok = await this.correctToPaid(diff, reconciliationId);
      if (ok) {
        resolved += 1;
      }
    }
    return resolved;
  }

  /**
   * A 类纠正：`PROCESSING → PAID`。
   *
   * ⚠️ **`paidAt` 用数据库时钟**，不是渠道时刻 —— `payouts.paidAt` 在正常流程里
   *    是 `databaseNow()`，混用两套时钟会让对账窗口筛选失真。
   *    渠道时刻只存在对账的 item 表与留痕的 reason 里。
   */
  private async correctToPaid(
    diff: ReconcileDiff,
    reconciliationId: string,
  ): Promise<boolean> {
    const payoutId = diff.payoutId!;
    return tenantContext.run(platformScope(), async () => {
      const paidAt = await this.prisma.databaseNow();
      const channel = await this.prisma.payout.findFirst({
        where: { id: payoutId },
        select: { payoutChannel: true },
      });
      const ok = await this.execution.markPaid(payoutId, {
        providerTxnId: diff.channelTxnId ?? '',
        channel: channel?.payoutChannel ?? 'fake-payout',
        paidAt,
      });
      if (!ok) {
        // ⚠️ **条件更新没命中** —— 状态已被改掉（worker 抢先落了 PAID）。
        //    **不报错**，但要留痕说明「为什么这张单没被对账纠正」。
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
            action: 'RECONCILE_TO_PAID',
            // ⚠️ **定时/自动纠正没有真人** → 用系统身份
            operatorId: 'system:reconciliation',
            reason: `渠道对账：渠道确认已打款，本地纠正为已付款（渠道流水号 ${diff.channelTxnId ?? '未知'}）`,
            fromStatus: PayoutStatus.PROCESSING,
            toStatus: PayoutStatus.PAID,
            reconciliationId,
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
      return true;
    });
  }
}
