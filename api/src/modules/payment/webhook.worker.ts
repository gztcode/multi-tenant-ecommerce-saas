import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import { runForTenant } from '../../common/tenant/tenant-context';
import { PaymentService } from './payment.service';
import { NormalizedWebhookEvent } from './payment-provider.interface';

/** webhook 队列任务的数据 */
export interface PaymentWebhookJob {
  /** 订单所属租户 id（**从订单反查**，不是客户端提交的） */
  tenantId: string;
  eventId: string;
  provider: string;
  channel: string;
  providerTxnId: string;
  orderNo: string;
  amount: number;
  success: boolean;
}

/**
 * 支付回调的异步消费端。
 *
 * ⚠️ **必须重建租户上下文**：`AsyncLocalStorage` 的上下文只存在于当前
 * 异步调用链内，队列消费者是跨进程边界的——不显式重建的话，
 * 查租户作用域模型（Order / Payment）会抛 `TenantScopeError`。
 *
 * ⚠️ 任务里的 `tenantId` **必须来自可信源**——它由 webhook 端点从**订单反查**
 * 得到并签发，绝不能取自客户端提交的内容。否则「重建上下文」本身
 * 就成了越权通道。
 *
 * ⚠️ **事件行已经由 webhook 端点落库了**（验签之后才插的，R1）。
 * 消费端不再插一次——插了必然撞唯一索引。这里做的是业务流转：
 * 支付单转 SUCCESS → 订单转 PAID → 记 DEDUCT 流水。
 *
 * 消费端的幂等靠**状态流转的条件更新**（护栏 10）：BullMQ 是 at-least-once，
 * 任务可能在消费途中进程崩溃后被重新投递。条件更新保证重复投递不重复生效。
 */
@Processor(PAYMENT_WEBHOOK_QUEUE)
@Injectable()
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);

  constructor(private readonly paymentService: PaymentService) {
    super();
  }

  async process(job: Job<PaymentWebhookJob>): Promise<void> {
    if (job.name !== 'payment') {
      return;
    }
    const data = job.data;

    // ⚠️ **必须重建租户上下文**：队列消费是跨进程边界的，
    // AsyncLocalStorage 的上下文不跟着走。不重建的话查 Order/Payment
    // 会抛 TenantScopeError。
    await runForTenant(data.tenantId, async () => {
      const event: NormalizedWebhookEvent = {
        provider: data.provider,
        channel: data.channel,
        eventId: data.eventId,
        providerTxnId: data.providerTxnId,
        orderNo: data.orderNo,
        amount: data.amount,
        success: data.success,
      };

      // ⚠️ **第 2~5 步在同一个事务里**：订单转 PAID 与记 DEDUCT 流水分属
      // 两个事务的话，会出现「订单已支付但流水没记」的账目缺口。
      //
      // ⚠️ 任务里的 `tenantId` 是**可信源**——它由 webhook 端点从订单反查后
      // 签发。订单的查询在这个租户的作用域内做，租户不对就查不到订单，
      // 什么都不会发生（R14）。
      await this.paymentService.applyEvent(event, data.tenantId);
    });
  }
}
