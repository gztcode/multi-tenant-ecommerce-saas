import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AUTH_QUEUE } from '../../common/queue/queue.constants';
import { TokenGraceService } from './token-grace.service';

/**
 * 宽限记录清理的消费端。
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once。
 * 这里的幂等靠「清理本身就是幂等的」（抹掉已抹掉的行不报错）。
 */
@Processor(AUTH_QUEUE)
@Injectable()
export class TokenGraceWorker extends WorkerHost {
  constructor(private readonly grace: TokenGraceService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'cleanup') {
      return;
    }
    await this.grace.cleanup();
  }
}
