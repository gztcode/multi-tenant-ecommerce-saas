import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { RenewalService } from './renewal.service';

/**
 * 续费扫描的消费端。
 *
 * ⚠️ **必须在平台作用域下跑**：扫描要跨租户。
 * 写操作由 `RenewalService` 内部用 `runForTenant` 切回租户作用域。
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 幂等靠「同一周期只能有一张账单」的唯一索引。
 */
@Processor(BILLING_QUEUE)
@Injectable()
export class RenewalWorker extends WorkerHost {
  constructor(private readonly renewal: RenewalService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'scan') {
      return;
    }
    await tenantContext.run(platformScope(), async () => {
      await this.renewal.scan();
    });
  }
}
