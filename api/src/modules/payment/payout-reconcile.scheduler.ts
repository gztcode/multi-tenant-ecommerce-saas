import { Injectable, OnModuleInit } from '@nestjs/common';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import {
  FAKE_PAYOUT_CHANNEL,
  isFakePayoutEnabled,
} from '../../common/payment/fake-payout.provider';

/**
 * 渠道对账的周期任务注册器（阶段 5m，阶段 6 审查修复）。
 *
 * ⚠️ **按渠道逐个注册**（不再是「只注册 `fake-payout`」）——
 *    第二家渠道（`sandbox` 等）实现了 `listPayouts` 就应该能自动对账，
 *    否则「按渠道隔离的对账」只在手工触发时成立。
 *
 * ⚠️ **假网关未启用时不注册它的周期任务** —— 而不是注册了让它每天失败。
 *    生产环境 `assertSecureConfig` 在 `FAKE_PAYOUT_ENABLED === 'true'` 时拒绝启动
 *    → 生产环境假网关必然不可用 → `listPayouts` 会抛错 →
 *    注册了就是**每天落一条 `FAILED` 任务**，对账列表变成「每天都失败」，比不做还糟。
 *
 * ⚠️ **每个渠道一个 jobId** —— `addRepeating` 的 jobId 决定「同一个任务
 *    不会重复注册」，渠道名进了 jobId → 各渠道互不覆盖。
 */
@Injectable()
export class PayoutReconcileScheduler implements OnModuleInit {
  constructor(
    private readonly queue: QueueService,
    private readonly registry: PayoutProviderRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    // ⚠️ **从注册表拿「已启用 + 非生产 devOnly」的渠道** ——
    //    `list()` 默认过滤 devOnly，生产环境永远看不到 sandbox。
    const channels = this.registry
      .list()
      .map((descriptor) => descriptor.channel)
      .filter((channel) => {
        // ⚠️ **假网关额外看它自己的开关** —— 它是安全边界。
        if (channel === FAKE_PAYOUT_CHANNEL && !isFakePayoutEnabled()) {
          return false;
        }
        return true;
      });

    if (channels.length === 0) {
      return;
    }

    for (const channel of channels) {
      await this.queue.addRepeating(
        PAYOUT_QUEUE,
        'reconcile',
        { channel },
        24 * 60 * 60 * 1000,
        `payout-reconcile-${channel}`,
      );
    }
  }
}
