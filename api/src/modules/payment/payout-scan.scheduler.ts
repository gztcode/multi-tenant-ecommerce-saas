import { Injectable, OnModuleInit } from '@nestjs/common';
import { PAYOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/**
 * 出款兜底扫描的周期（毫秒）。5 分钟。
 *
 * ⚠️ **与后端兜底扫描的 10 分钟卡住阈值配套**：
 *    `PayoutExecutionService.scanStuck` 用 10 分钟判定「卡住」，
 *    每 5 分钟扫一次 → 一张卡住 10 分钟以上的单，最多再等 5 分钟就被捞出来。
 */
const PAYOUT_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 出款兜底扫描的**周期任务注册器**（阶段 5h-2）。
 *
 * ## 它补的是哪个洞
 *
 * `PayoutWorker` 实现了 `PAYOUT_QUEUE` 上 `scan` job 的**消费端**
 * （卡死告警 + `APPROVED` 救援），但**如果没有人往队列里投这个 job**，
 * 那条路径就是**死代码**：
 *
 * - 审批通过后要入队（`PayoutService.approve`）
 * - 那次入队失败（Redis 抖动）→ 出款单**永远停在 `APPROVED`**
 * - 商家看到「已审批」、平台看到「已审批」，**没有任何一方知道它没打出去**
 * - 货款流水还被占着（商家重新申请撞 `payout_entries` 唯一索引 → 500）
 *
 * 所以必须有**周期性**的兜底扫描把它捞出来重新入队。
 *
 * ## 为什么单独一个类
 *
 * ⚠️ **`PayoutWorker` 是消费端**，注册周期任务是**生产**侧的事 ——
 *    放在 worker 里会让「谁在干活」和「谁在派活」混在一起。
 *    形态照 `CompensationService`（支付补偿）与 `RenewalService`（账单扫描）：
 *    一个只负责注册的 `@Injectable`。
 *
 * ## 为什么 `onModuleInit` 里失败就让进程起不来
 *
 * ⚠️ **有意为之**（见 `queue.service.ts` 里 `withQueueTimeout` 上方的注释）：
 *    周期任务没注册意味着兜底不跑 —— 与其让一个「看起来正常、其实不干活」
 *    的进程跑着，不如快速失败（容器编排会重启它，Redis 恢复后自然就起来了）。
 */
@Injectable()
export class PayoutScanScheduler implements OnModuleInit {
  constructor(private readonly queue: QueueService) {}

  /**
   * 注册出款兜底扫描的周期性任务。
   *
   * ⚠️ **固定 jobSchedulerId**：`payout-scan`。BullMQ 的作业调度器按它去重，
   * 重复注册是覆盖而不是叠加 —— 否则每次重启应用都会多一个扫描任务。
   *
   * ⚠️ **job name 必须是 `'scan'`** —— 要与 `PayoutWorker.process` 里
   *    分支匹配的那个名字一致，否则消费端会直接返回、什么都不做。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      PAYOUT_QUEUE,
      'scan',
      {},
      PAYOUT_SCAN_INTERVAL_MS,
      'payout-scan',
    );
  }
}
