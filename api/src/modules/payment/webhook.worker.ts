import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PaymentKind } from '@prisma/client';
import { PAYMENT_WEBHOOK_QUEUE } from '../../common/queue/queue.constants';
import { runForTenant } from '../../common/tenant/tenant-context';
import { PaymentService } from './payment.service';
import { REFUND_SCAN_JOB } from './refund-scan.scheduler';

/**
 * webhook 队列任务的数据。
 *
 * ⚠️ **消费端只信 `provider` / `eventId` / `tenantId`**（审计 P0-6 ③）：
 *    其余字段（金额、业务单号、成功与否、退款状态）**只是投递时的快照**，
 *    消费端一律以**事件行**为准 —— 队列内容是可以被拿到 Redis 写权限的人
 *    改写的，事件行才是验签端点落下的原文。
 */
export interface PaymentWebhookJob {
  /** 订单所属租户 id（**从订单反查**，不是客户端提交的） */
  tenantId: string;
  /**
   * 这笔是订单支付还是订阅支付。
   *
   * ⚠️ **必须带着走**：`referenceNo` 在订单路径是订单号、在订阅路径是账单号，
   * 消费端要靠它决定反查哪张业务单。少了它，订阅回调会被当成订单回调，
   * 查不到订单就**静默丢掉**——这笔续费的钱永远不流转。
   *
   * ⚠️ 由 **webhook 端点**写入（端点自己知道是哪个端点），
   * 不是渠道适配器猜的。
   *
   * ⚠️ 消费端**以事件行上的 `kind` 为准**（事件行也是端点写的），
   *    这一栏留着是为了排查时能看出任务是谁投的。
   */
  kind: PaymentKind;
  eventId: string;
  provider: string;
  channel: string;
  providerTxnId: string;
  /** 业务单号（订单号 / 账单号） */
  referenceNo: string;
  amount: number;
  success: boolean;
  /** 事件类型（阶段 6c）：缺省按 `PAYMENT` */
  eventType?: 'PAYMENT' | 'REFUND';
  /** 退款事件的渠道受理号 */
  refundTxnId?: string;
  /** 退款事件的渠道退款状态 */
  refundStatus?: 'SUCCESS' | 'FAILED' | 'PROCESSING';
  /** 退款失败是否确定（仅退款事件有意义） */
  definitive?: boolean;
}

/**
 * 支付回调的异步消费端。
 *
 * ⚠️ **必须重建租户上下文**：`AsyncLocalStorage` 的上下文只存在于当前
 * 异步调用链内，队列消费者是跨进程边界的——不显式重建的话，
 * 查租户作用域模型（Order / Payment）会抛 `TenantScopeError`。
 *
 * ⚠️ 任务里的 `tenantId` **只能当作用域提示**——它由 webhook 端点从**订单反查**
 * 得到并签发，绝不能取自客户端提交的内容。否则「重建上下文」本身
 * 就成了越权通道。事件内容则一律来自**事件行**（审计 P0-6 ③）。
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
    if (job.name === REFUND_SCAN_JOB) {
      // ⚠️ **退款扫描没有租户**：它是跨租户的，由 `scanRefunding`
      //    自己按每张单的租户重建上下文。
      const handled = await this.paymentService.scanRefunding();
      this.logger.debug(`退款扫描完成：本轮向渠道核实 ${handled} 张`);
      return;
    }
    if (job.name !== 'payment') {
      return;
    }
    const data = job.data;

    // ⚠️ **消费端复核事件行**（审计 P0-6 ③）：
    //    队列里的任务可以被拿到 Redis 写权限的人随意改写
    //    （金额、业务单号、租户都能改）。
    //    事件行是**验签端点**落库的 —— 行存在 = 这笔事件确实过了验签入口，
    //    行里的字段是当时的原文。**所以这里用行里的内容重建事件，
    //    不采信任务里的金额 / 业务单号。**
    //
    //    没有这张行 = 这个任务没经过验签端点 → **一律不生效**。
    const registered = await this.paymentService.loadRegisteredEvent(
      data.provider,
      data.eventId,
    );
    if (!registered) {
      this.logger.warn(
        `支付回调任务找不到对应的事件行（provider=${data.provider} ` +
          `eventId=${data.eventId}），不入账 —— 没经过验签端点登记的任务一律不生效。`,
      );
      return;
    }
    const { event, kind } = registered;

    // ⚠️ **必须重建租户上下文**：队列消费是跨进程边界的，
    // AsyncLocalStorage 的上下文不跟着走。不重建的话查 Order/Payment
    // 会抛 TenantScopeError。
    //
    // ⚠️ 任务里的 `tenantId` 只是**作用域提示**：事件内容来自事件行，
    //    订单的查询又在这个作用域内做 —— 租户不对就查不到订单，
    //    什么都不会发生（R14）。
    await runForTenant(data.tenantId, async () => {
      // ⚠️ **退款事件走退款状态机**：`PROCESSING` 不改状态，
      //    `SUCCESS` 才落 `REFUNDED`。
      if ((event.eventType ?? 'PAYMENT') === 'REFUND') {
        await this.paymentService.applyRefundEvent(event, data.tenantId);
        return;
      }

      // ⚠️ **第 2~5 步在同一个事务里**：订单转 PAID 与记 DEDUCT 流水分属
      // 两个事务的话，会出现「订单已支付但流水没记」的账目缺口。
      //
      // ⚠️ **`kind` 一路带下来**（取自事件行）：它决定 `applyEvent` 反查订单
      // 还是反查账单。少了它，订阅回调会被当成订单回调而查不到订单——
      // **静默丢掉**。
      await this.paymentService.applyEvent(event, data.tenantId, kind);
    });
  }
}
