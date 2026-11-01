import { Injectable, OnModuleInit } from '@nestjs/common';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import {
  FAKE_PAYOUT_CHANNEL,
  isFakePayoutEnabled,
} from '../../common/payment/fake-payout.provider';

/**
 * 渠道对账的周期任务注册器（阶段 5m）。
 *
 * ⚠️ **假网关未启用时根本不注册这个周期任务** —— 而不是注册了让它每天失败。
 *    生产环境 `assertSecureConfig` 在 `FAKE_PAYOUT_ENABLED === 'true'` 时拒绝启动
 *    → 生产环境假网关必然不可用 → `listPayouts` 会抛错 →
 *    注册了就是**每天落一条 `FAILED` 任务**，对账列表变成「每天都失败」，比不做还糟。
 */
@Injectable()
export class PayoutReconcileScheduler implements OnModuleInit {
  constructor(private readonly queue: QueueService) {}

  async onModuleInit(): Promise<void> {
    if (!isFakePayoutEnabled()) {
      return;
    }
    await this.queue.addRepeating(
      PAYOUT_QUEUE,
      'reconcile',
      { channel: FAKE_PAYOUT_CHANNEL },
      24 * 60 * 60 * 1000,
      'payout-reconcile',
    );
  }
}
