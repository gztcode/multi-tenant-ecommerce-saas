import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PAYMENT_TIMEOUT_QUEUE } from '../../common/queue/queue.constants';
import { runForTenant } from '../../common/tenant/tenant-context';
import { OrderTimeoutJob, OrderTimeoutService } from './order-timeout.service';

/**
 * 支付超时释放的消费端（阶段 3 Task 6）。
 *
 * ⚠️ **必须重建租户上下文**：`AsyncLocalStorage` 的上下文只存在于当前
 * 异步调用链内，队列消费者是跨进程边界的——不显式重建的话，
 * 查租户作用域模型（Order / Sku）会抛 `TenantScopeError`。
 *
 * ⚠️ 任务里的 `tenantId` **必须来自可信源**——它由下单时后端签发，
 * 绝不能取自客户端提交的内容。否则「重建上下文」本身就成了越权通道。
 *
 * ⚠️ **消费端必须幂等**：BullMQ 是 at-least-once，任务可能在消费途中
 * 进程崩溃后被重新投递。幂等靠**条件更新**——重复投递时订单已经不是
 * `PENDING_PAYMENT`，条件更新受影响行数为 0，库存不会被加回第二次。
 */
@Processor(PAYMENT_TIMEOUT_QUEUE)
@Injectable()
export class OrderTimeoutWorker extends WorkerHost {
  private readonly logger = new Logger(OrderTimeoutWorker.name);

  constructor(private readonly timeout: OrderTimeoutService) {
    super();
  }

  async process(job: Job<OrderTimeoutJob>): Promise<void> {
    if (job.name !== 'release') {
      return;
    }
    const data = job.data;

    // ⚠️ **必须重建租户上下文**：队列消费是跨进程边界的，
    // AsyncLocalStorage 的上下文不跟着走。不重建的话查 Order/Sku
    // 会抛 TenantScopeError。
    await runForTenant(data.tenantId, async () => {
      const released = await this.timeout.releaseExpiredOrder(data.orderId);
      if (!released) {
        // 已支付 / 已取消 / 还没到支付期限——不是异常，正常跳过。
        this.logger.log(
          `超时释放未生效：订单 ${data.orderId}（已支付、已取消或未到支付期限）`,
        );
      }
    });
  }
}
