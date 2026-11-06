import type { Job } from 'bullmq';
import { PaymentKind } from '@prisma/client';
import { PaymentService } from './payment.service';
import type { NormalizedWebhookEvent } from './payment-provider.interface';
import { WebhookWorker, type PaymentWebhookJob } from './webhook.worker';

/**
 * 消费端复核（审计 P0-6 ③）。
 *
 * ⚠️ **这里的场景是「能写 Redis 的人」**：他可以往 `payment-webhook` 队列里
 *    塞任意任务（金额、业务单号、租户都能改）。
 *    消费端必须**只认事件行**——事件行是验签端点落库的，
 *    行存在 = 这笔事件确实过了验签入口。
 */
describe('WebhookWorker 消费端复核（审计 P0-6 ③）', () => {
  function setup() {
    const paymentService = {
      loadRegisteredEvent: jest.fn<
        Promise<{ event: NormalizedWebhookEvent; kind: PaymentKind } | null>,
        [string, string]
      >(),
      applyEvent: jest.fn<
        Promise<void>,
        [NormalizedWebhookEvent, string, PaymentKind]
      >(),
      applyRefundEvent: jest.fn<
        Promise<void>,
        [NormalizedWebhookEvent, string]
      >(),
      scanRefunding: jest.fn<Promise<number>, []>(),
    };
    const worker = new WebhookWorker(
      paymentService as unknown as PaymentService,
    );
    return { worker, paymentService };
  }

  function job(over: Partial<PaymentWebhookJob> = {}): Job<PaymentWebhookJob> {
    return {
      name: 'payment',
      data: {
        tenantId: 'tenant-a',
        kind: PaymentKind.ORDER,
        eventId: 'evt-1',
        provider: 'fake',
        channel: 'fake',
        providerTxnId: 'txn-1',
        referenceNo: 'SO-1',
        // ⚠️ 任务里的金额是**可被改写**的那一栏
        amount: 1,
        success: true,
        ...over,
      },
    } as unknown as Job<PaymentWebhookJob>;
  }

  it('⚠️ 任务没有对应的事件行 → 不入账（谁都不被调用）', async () => {
    const { worker, paymentService } = setup();
    paymentService.loadRegisteredEvent.mockResolvedValue(null);

    await worker.process(job());

    expect(paymentService.loadRegisteredEvent).toHaveBeenCalledWith(
      'fake',
      'evt-1',
    );
    expect(paymentService.applyEvent).not.toHaveBeenCalled();
    expect(paymentService.applyRefundEvent).not.toHaveBeenCalled();
  });

  it('⚠️ 有事件行 → 用**事件行里的金额**流转，不采信任务里的金额', async () => {
    const { worker, paymentService } = setup();
    paymentService.loadRegisteredEvent.mockResolvedValue({
      event: {
        provider: 'fake',
        channel: 'fake',
        eventId: 'evt-1',
        providerTxnId: 'txn-1',
        referenceNo: 'SO-1',
        amount: 1000,
        success: true,
      },
      kind: PaymentKind.ORDER,
    });

    await worker.process(job({ amount: 1 }));

    expect(paymentService.applyEvent).toHaveBeenCalledTimes(1);
    const [event, tenantId, kind] = paymentService.applyEvent.mock.calls[0];
    expect(event.amount).toBe(1000);
    expect(event.referenceNo).toBe('SO-1');
    expect(tenantId).toBe('tenant-a');
    expect(kind).toBe(PaymentKind.ORDER);
    expect(paymentService.applyRefundEvent).not.toHaveBeenCalled();
  });

  it('事件行是退款事件 → 走退款状态机（不查订单）', async () => {
    const { worker, paymentService } = setup();
    paymentService.loadRegisteredEvent.mockResolvedValue({
      event: {
        provider: 'fake',
        channel: 'fake',
        eventId: 'evt-1',
        providerTxnId: 'txn-1',
        referenceNo: 'SO-1',
        amount: 1000,
        success: true,
        eventType: 'REFUND',
        refundTxnId: 'rt-1',
        refundStatus: 'SUCCESS',
      },
      kind: PaymentKind.ORDER,
    });

    await worker.process(job({ eventType: 'REFUND' }));

    expect(paymentService.applyRefundEvent).toHaveBeenCalledTimes(1);
    expect(paymentService.applyEvent).not.toHaveBeenCalled();
  });

  it('`kind` 取自事件行（任务里的 kind 只是投递时的快照）', async () => {
    const { worker, paymentService } = setup();
    paymentService.loadRegisteredEvent.mockResolvedValue({
      event: {
        provider: 'fake',
        channel: 'fake',
        eventId: 'evt-1',
        providerTxnId: 'txn-1',
        referenceNo: 'INV-1',
        amount: 1000,
        success: true,
      },
      kind: PaymentKind.SUBSCRIPTION,
    });

    await worker.process(
      job({ kind: PaymentKind.ORDER, referenceNo: 'INV-1' }),
    );

    expect(paymentService.applyEvent.mock.calls[0][2]).toBe(
      PaymentKind.SUBSCRIPTION,
    );
  });
});
