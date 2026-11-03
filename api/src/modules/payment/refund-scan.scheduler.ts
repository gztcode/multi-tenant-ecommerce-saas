import { Injectable, OnModuleInit } from '@nestjs/common';
import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/** 退款扫描的 job 名（`WebhookWorker` 按它分流） */
export const REFUND_SCAN_JOB = 'refund-scan';

/** 退款扫描周期（毫秒）：5 分钟 */
export const REFUND_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 退款核实扫描的**周期任务注册器**（阶段 6c）。
 *
 * ## 它补的是哪个洞
 *
 * 退款发起后落在 `REFUNDING`，结果要么由渠道回调推进，要么由扫描核实。
 * **回调会丢**（渠道重试耗尽、网络分区），没人扫的话这张单会永远停在
 * `REFUNDING`——钱到底退没退，本地永远不知道，商家也没法再发起。
 *
 * ## 为什么与 `PayoutScanScheduler` 同形
 *
 * 周期任务只负责「派活」（往队列投 job），真正的活由消费端
 * （`WebhookWorker` 的 `refund-scan` 分支 → `PaymentService.scanRefunding`）做：
 * - 周期任务里没有事务，进程挂了只会丢这一轮，不会留下半截状态；
 * - 多副本部署时 BullMQ 的作业调度器按 `jobSchedulerId` 去重，不会重复扫。
 *
 * ## 为什么 `onModuleInit` 里失败就让进程起不来
 *
 * ⚠️ **有意为之**（与 `PayoutScanScheduler` 一致）：扫描没注册意味着
 *    丢回调的退款单永远没人核实 —— 宁可快速失败让编排重启。
 */
@Injectable()
export class RefundScanScheduler implements OnModuleInit {
  constructor(private readonly queue: QueueService) {}

  /**
   * 注册退款扫描的周期性任务。
   *
   * ⚠️ **固定 `jobSchedulerId`**：`payment-refund-scan`。重复注册是覆盖
   *    而不是叠加，否则每次重启都会多一个扫描任务。
   *
   * ⚠️ **job name 必须是 `REFUND_SCAN_JOB`** —— 要与 `WebhookWorker.process`
   *    里分支匹配的那个名字一致，否则消费端会直接返回、什么都不做。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      PAYMENT_WEBHOOK_QUEUE,
      REFUND_SCAN_JOB,
      {},
      REFUND_SCAN_INTERVAL_MS,
      'payment-refund-scan',
    );
  }
}
