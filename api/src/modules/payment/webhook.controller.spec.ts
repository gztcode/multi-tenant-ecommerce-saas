import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import type { Request } from 'express';
import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { OrderService } from '../order/order.service';
import type { OrderInventoryService } from '../order/inventory.service';
import type { CouponRedemptionService } from '../coupon/coupon-redemption.service';
import type { InvoiceService } from '../billing/invoice.service';
import type { CommissionService } from '../billing/commission.service';
import type { ReceiptService } from '../billing/receipt.service';
import type { ChannelCapabilities } from '../../common/channel/channel.types';
import type {
  NormalizedWebhookEvent,
  PaymentProvider,
} from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PaymentService } from './payment.service';
import { WebhookController } from './webhook.controller';

/**
 * 回调路由走注册表（阶段 6a Task 3）。
 *
 * ⚠️ 两条不容妥协的性质：
 * 1. 未知 / 未启用 / 生产 devOnly 的渠道 → **404**，
 *    且 **`payment_webhook_events` 一个字都不写**（否则攻击者能拿随机
 *    渠道名往事件表里灌垃圾，甚至抢占 eventId 占位）。
 * 2. 「先验签、失败 401、不落库」的顺序不变（R1）。
 */

const FAKE_CAPABILITIES: ChannelCapabilities = {
  refund: true,
  asyncRefund: false,
  asyncPayout: false,
  queryByReferenceNo: false,
  authorizedCharge: true,
  paymentMethod: true,
};

const TENANT_ID = 'tenant-a';
const ORDER_NO = 'SO-1';
const AMOUNT = 1500;

/**
 * 一只假的支付渠道。
 *
 * ⚠️ **刻意不写返回类型**：写成 `: PaymentProvider` 会把各方法推断成
 *    「方法签名」，eslint 的 `unbound-method` 规则就不许单独取出来断言；
 *    不写注解时推断成 `jest.Mock` **属性**（与 `payout-worker.spec.ts` 同一做法）。
 */
function provider(channel: string) {
  return {
    channel,
    provider: channel,
    capabilities: FAKE_CAPABILITIES,
    createPayment: jest.fn(),
    queryPayment: jest.fn(),
    refund: jest.fn(),
    queryRefund: jest.fn(),
    chargeAuthorized: jest.fn(),
    createPaymentMethod: jest.fn(),
    parseWebhook: jest.fn(),
  };
}

function prismaMock() {
  return {
    payment: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    invoice: { findFirst: jest.fn() },
    order: { findMany: jest.fn() },
    paymentWebhookEvent: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    databaseNow: jest.fn(),
  };
}

function requestWithBody(raw: Buffer): RawBodyRequest<Request> {
  return { rawBody: raw, headers: {} } as unknown as RawBodyRequest<Request>;
}

function buildController(providers: PaymentProvider[]) {
  const prisma = prismaMock();
  const queue = { add: jest.fn() };
  const orderService = { transitionInTx: jest.fn() };
  const registry = new PaymentProviderRegistry(providers);

  const paymentService = new PaymentService(
    prisma as unknown as TenantPrismaService,
    orderService as unknown as OrderService,
    { deductInTx: jest.fn() } as unknown as OrderInventoryService,
    queue as unknown as QueueService,
    { markUsedInTx: jest.fn() } as unknown as CouponRedemptionService,
    { markInvoicePaid: jest.fn() } as unknown as InvoiceService,
    {
      recordCommissionInTx: jest.fn(),
      recordReversalInTx: jest.fn(),
    } as unknown as CommissionService,
    {
      recordReceiptInTx: jest.fn(),
      recordReceiptReversalInTx: jest.fn(),
    } as unknown as ReceiptService,
    registry,
  );

  const controller = new WebhookController(paymentService, registry);
  return { controller, prisma, queue };
}

function webhookEvent(over: Partial<NormalizedWebhookEvent> = {}) {
  return {
    provider: 'fake',
    channel: 'fake',
    eventId: 'evt-1',
    providerTxnId: 'txn-1',
    referenceNo: ORDER_NO,
    amount: AMOUNT,
    success: true,
    ...over,
  } satisfies NormalizedWebhookEvent;
}

describe('WebhookController 回调路由（阶段 6a）', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalEnabled === undefined) {
      delete process.env.PAYMENT_ENABLED_CHANNELS;
    } else {
      process.env.PAYMENT_ENABLED_CHANNELS = originalEnabled;
    }
  });

  it('未知渠道 → 404，且 payment_webhook_events 不写、不入队', async () => {
    const { controller, prisma, queue } = buildController([provider('fake')]);

    await expect(
      controller.payment('not-exist', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
    expect(queue.add).toHaveBeenCalledTimes(0);
  });

  it('已注册但未启用的渠道 → 404，且不落库', async () => {
    const { controller, prisma } = buildController([
      provider('fake'),
      provider('other'),
    ]);

    await expect(
      controller.payment('other', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
  });

  it('验签失败 → 401，且不落库（顺序不变）', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockImplementation(() => {
      throw new UnauthorizedException('支付回调签名不正确');
    });
    const { controller, prisma } = buildController([fake]);

    await expect(
      controller.payment('fake', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
  });

  it('请求体为空 → 400，且不落库', async () => {
    const { controller, prisma } = buildController([provider('fake')]);

    await expect(
      controller.payment('fake', { headers: {} } as RawBodyRequest<Request>),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
  });

  it('生产环境下 devOnly 的渠道 → 404，且不落库', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_ENABLED_CHANNELS = 'sandbox';
    const sandbox: PaymentProvider = {
      ...provider('sandbox'),
      devOnly: true,
    };
    const { controller, prisma } = buildController([sandbox]);

    await expect(
      controller.payment('sandbox', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
  });

  it('假网关的正常回调 → 200，写事件并入队', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockReturnValue(webhookEvent());
    const { controller, prisma, queue } = buildController([fake]);
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        orderNo: ORDER_NO,
        status: OrderStatus.PENDING_PAYMENT,
        totalAmount: AMOUNT,
        tenantId: TENANT_ID,
        commissionRate: 0,
        commissionAmount: 0,
        items: [],
      },
    ]);
    prisma.paymentWebhookEvent.create.mockResolvedValue({});

    const result = await controller.payment(
      'fake',
      requestWithBody(Buffer.from('{"eventId":"evt-1"}')),
    );

    expect(result).toEqual({ received: true, processed: true });
    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

/**
 * 回调事件类型分流（阶段 6c Task 15）。
 *
 * ⚠️ 三条不容妥协的性质：
 * 1. **未知 `eventType` → 400 且不落库**；
 * 2. 退款事件与支付事件**共用幂等表**（`provider + eventId`）；
 * 3. 缺省 `eventType` 按 `PAYMENT` 兼容存量渠道。
 */
describe('WebhookController 事件类型分流（阶段 6c）', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_ENABLED_CHANNELS = 'fake';
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalEnabled === undefined) {
      delete process.env.PAYMENT_ENABLED_CHANNELS;
    } else {
      process.env.PAYMENT_ENABLED_CHANNELS = originalEnabled;
    }
  });

  function refundEvent(
    over: Partial<NormalizedWebhookEvent> = {},
  ): NormalizedWebhookEvent {
    return {
      provider: 'fake',
      channel: 'fake',
      eventId: 'rev-1',
      providerTxnId: '',
      referenceNo: ORDER_NO,
      amount: AMOUNT,
      success: true,
      eventType: 'REFUND',
      refundTxnId: 'rt-1',
      refundStatus: 'SUCCESS',
      ...over,
    };
  }

  /** 订单反查的桩：金额与事件一致 */
  function stubOrder(prisma: ReturnType<typeof prismaMock>) {
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        orderNo: ORDER_NO,
        status: OrderStatus.PAID,
        totalAmount: AMOUNT,
        tenantId: TENANT_ID,
        commissionRate: 0,
        commissionAmount: 0,
        items: [],
      },
    ]);
    prisma.paymentWebhookEvent.create.mockResolvedValue({});
  }

  it('⚠️ 未知 eventType → 400，且 payment_webhook_events 不写、不入队', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockReturnValue(
      webhookEvent({ eventType: 'CHARGEBACK' as unknown as 'PAYMENT' }),
    );
    const { controller, prisma, queue } = buildController([fake]);
    stubOrder(prisma);

    await expect(
      controller.payment('fake', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
    expect(queue.add).toHaveBeenCalledTimes(0);
  });

  it('⚠️ 未知 eventType 时先验签：验签失败优先 401，同样不落库', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockImplementation(() => {
      throw new UnauthorizedException('支付回调签名不正确');
    });
    const { controller, prisma } = buildController([fake]);
    stubOrder(prisma);

    await expect(
      controller.payment('fake', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
  });

  it('缺省 eventType → 按 PAYMENT 处理（兼容存量渠道）', async () => {
    const fake = provider('fake');
    const legacy = webhookEvent();
    delete (legacy as { eventType?: unknown }).eventType;
    fake.parseWebhook.mockReturnValue(legacy);
    const { controller, prisma, queue } = buildController([fake]);
    stubOrder(prisma);

    const result = await controller.payment(
      'fake',
      requestWithBody(Buffer.from('{}')),
    );

    expect(result).toEqual({ received: true, processed: true });
    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('退款事件 → 落幂等表并把 eventType / 退款字段带进队列', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockReturnValue(refundEvent());
    const { controller, prisma, queue } = buildController([fake]);
    stubOrder(prisma);

    const result = await controller.payment(
      'fake',
      requestWithBody(Buffer.from('{}')),
    );

    expect(result).toEqual({ received: true, processed: true });
    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const job = (
      queue.add.mock.calls as unknown as Array<unknown[]>
    )[0][2] as Record<string, unknown>;
    expect(job.eventType).toBe('REFUND');
    expect(job.refundTxnId).toBe('rt-1');
    expect(job.refundStatus).toBe('SUCCESS');
  });

  it('退款事件金额不符 → 不落库、不入队（回 200）', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockReturnValue(refundEvent({ amount: 1 }));
    const { controller, prisma, queue } = buildController([fake]);
    stubOrder(prisma);

    const result = await controller.payment(
      'fake',
      requestWithBody(Buffer.from('{}')),
    );

    expect(result).toEqual({ received: true, processed: false });
    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
    expect(queue.add).toHaveBeenCalledTimes(0);
  });

  it('⚠️ 订阅端点收到退款事件 → 400，且不落库', async () => {
    const fake = provider('fake');
    fake.parseWebhook.mockReturnValue(refundEvent());
    const { controller, prisma } = buildController([fake]);
    stubOrder(prisma);

    await expect(
      controller.subscription('fake', requestWithBody(Buffer.from('{}'))),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.paymentWebhookEvent.create).toHaveBeenCalledTimes(0);
  });
});
