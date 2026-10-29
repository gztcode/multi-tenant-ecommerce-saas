import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { COMPENSATION_QUEUE } from '../../common/queue/queue.constants';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { CompensationService } from './compensation.service';

/**
 * 支付补偿扫描的消费端。
 *
 * ⚠️ **必须在平台作用域下跑**：扫描要跨租户。
 * 写操作由 `CompensationService` 内部用 `runForTenant` 切回租户作用域。
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 幂等靠「状态流转的条件更新」（订单 `PENDING_PAYMENT → CLOSED`、
 * 支付单 `PENDING → SUCCESS`），重复执行只有一个赢。
 */
@Processor(COMPENSATION_QUEUE)
@Injectable()
export class CompensationWorker extends WorkerHost {
  private readonly logger = new Logger(CompensationWorker.name);

  constructor(private readonly compensation: CompensationService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'compensate') {
      return;
    }
    await tenantContext.run(platformScope(), async () => {
      const events = await this.compensation.retryUnprocessedEvents();
      const orders = await this.compensation.releaseStuckOrders();
      // ⚠️ **每轮扫完输出一行汇总** —— 补偿是「平时没人看」的机制，
      // 不出声的话，扫出东西都不知道。
      this.logger.log(
        `支付补偿扫描完成：未处理事件 ${events.scanned} 条` +
          `（重投 ${events.requeued} 条、核对不通过 ${events.rejected} 条` +
          `、失败 ${events.failed} 条），` +
          `超时未释放订单 ${orders.scanned} 条（已释放 ${orders.released} 条` +
          `、失败 ${orders.failed} 条）`,
      );
    });
  }
}
