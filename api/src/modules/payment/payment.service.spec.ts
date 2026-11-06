import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, PaymentKind, PaymentStatus } from '@prisma/client';
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
import { runForTenant } from '../../common/tenant/tenant-context';

/**
 * 支付服务的能力门控（阶段 6a Task 3）。
 *
 * ⚠️ 门控的意义是「不支持的动作**显式拒绝**，不能调下去再假装成功」——
 * 所以每条用例都同时断言两件事：**抛中文 409** 且 **渠道没被调用**。
 * 只断言异常的话，把门控放在渠道调用之后也能过，那就等于没测。
 */

/** 假渠道的能力：退款 / 自动扣款 / 绑卡都支持，异步退款不支持，其余不支持 */
const FAKE_CAPABILITIES: ChannelCapabilities = {
  refund: true,
  asyncRefund: false,
  asyncPayout: false,
  queryByReferenceNo: false,
  authorizedCharge: true,
  paymentMethod: true,
};

const TENANT_ID = 'tenant-a';

/** 一条已支付订单（`readOrderByNo` 从 `prisma.order.findMany` 里映射出来） */
function paidOrder() {
  return {
    id: 'order-1',
    orderNo: 'SO-1',
    status: OrderStatus.PAID,
    totalAmount: 1000,
    tenantId: TENANT_ID,
    commissionRate: 0,
    commissionAmount: 0,
    items: [],
  };
}

/** 该订单那笔已成功的支付单 */
function successPayment() {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    channel: 'fake',
    amount: 1000,
    status: PaymentStatus.SUCCESS,
  };
}

/**
 * 一只假的支付渠道。
 *
 * ⚠️ **刻意不写返回类型**：写成 `: PaymentProvider` 会把各方法推断成
 *    「方法签名」，eslint 的 `unbound-method` 规则就不许把 `fake.refund`
 *    单独取出来断言（那是对象方法，脱离 this 会被误用）；不写注解时
 *    推断成 `jest.Mock` **属性**，断言才合法（与 `payout-worker.spec.ts` 同一做法）。
 */
function provider(channel: string, capabilities: ChannelCapabilities) {
  return {
    channel,
    provider: channel,
    capabilities,
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
    payment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    invoice: { findFirst: jest.fn() },
    // ⚠️ `findFirst` 是退款落账时读「订单当前状态」用的
    //    （事务内判断该不该做订单级动作，审计 P0-3 / P1-3）
    order: { findMany: jest.fn(), findFirst: jest.fn() },
    paymentWebhookEvent: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    // ⚠️ 事务里的 `now()` 走 tx 的原生 SQL（不走租户扩展）
    $queryRaw: jest.fn(),
    databaseNow: jest.fn(),
  };
}

function buildService(
  providerInstance: PaymentProvider,
  prisma: ReturnType<typeof prismaMock>,
) {
  const orderService = { transitionInTx: jest.fn() };
  const inventory = { deductInTx: jest.fn() };
  const queue = { add: jest.fn() };
  const couponRedemption = { markUsedInTx: jest.fn() };
  const billingInvoices = { markInvoicePaid: jest.fn() };
  const commission = {
    recordCommissionInTx: jest.fn(),
    recordReversalInTx: jest.fn(),
  };
  const receipt = {
    recordReceiptInTx: jest.fn(),
    recordReceiptReversalInTx: jest.fn(),
  };

  const service = new PaymentService(
    prisma as unknown as TenantPrismaService,
    orderService as unknown as OrderService,
    inventory as unknown as OrderInventoryService,
    queue as unknown as QueueService,
    couponRedemption as unknown as CouponRedemptionService,
    billingInvoices as unknown as InvoiceService,
    commission as unknown as CommissionService,
    receipt as unknown as ReceiptService,
    new PaymentProviderRegistry([providerInstance]),
  );

  return { service, orderService, inventory, commission, receipt };
}

/** 捕获被抛出的异常（单次调用，不断言两次） */
async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出异常，但调用正常返回了');
}

describe('PaymentService 能力门控（阶段 6a）', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  beforeAll(() => {
    // 注册表按环境变量判定「已启用」：非生产没设变量时默认启用 `fake`
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

  describe('providerOf', () => {
    it('已注册且已启用的渠道 → 返回注册表里的那个实现', () => {
      const fake = provider('fake', FAKE_CAPABILITIES);
      const { service } = buildService(fake, prismaMock());

      expect(service.providerOf('fake')).toBe(fake);
    });

    it('未注册的渠道 → 中文 409（由注册表统一拒绝）', () => {
      const { service } = buildService(
        provider('fake', FAKE_CAPABILITIES),
        prismaMock(),
      );

      expect(() => service.providerOf('not-exist')).toThrow(ConflictException);
      expect(() => service.providerOf('not-exist')).toThrow(/未注册/);
    });
  });

  describe('退款', () => {
    it('capabilities.refund=false 的渠道 → 409，且渠道退款与本地闸门都未被调用', async () => {
      const fake = provider('fake', { ...FAKE_CAPABILITIES, refund: false });
      const prisma = prismaMock();
      const { service } = buildService(fake, prisma);
      prisma.order.findMany.mockResolvedValue([paidOrder()]);
      prisma.payment.findMany.mockResolvedValue([successPayment()]);

      const error = await catchError(() => service.refund('SO-1', '测试退款'));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(/当前渠道 fake 不支持在线退款/);
      // ⚠️ 门控必须在渠道调用与任何落库之前
      expect(fake.refund).toHaveBeenCalledTimes(0);
      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(0);
    });

    it('capabilities.refund=true 的渠道 → 正常调渠道退款（门控不误伤）', async () => {
      const fake = provider('fake', FAKE_CAPABILITIES);
      fake.refund.mockResolvedValue({ status: 'SUCCESS' });
      const prisma = prismaMock();
      const { service, orderService } = buildService(fake, prisma);
      prisma.order.findMany.mockResolvedValue([paidOrder()]);
      // 退款落账时会在事务内读一次订单的当前状态（判该不该做订单级动作）
      prisma.order.findFirst.mockResolvedValue({ status: OrderStatus.PAID });
      prisma.payment.findMany.mockResolvedValue([successPayment()]);
      // 抢闸门的条件更新命中
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.databaseNow.mockResolvedValue(new Date('2026-11-02T00:00:00Z'));
      prisma.$transaction.mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
      );
      // 订单流转的条件更新命中（否则会在事务里抛「订单当前状态不允许退款」）
      orderService.transitionInTx.mockResolvedValue(true);

      await expect(service.refund('SO-1', '测试退款')).resolves.toEqual({
        status: 'REFUNDED',
      });

      expect(fake.refund).toHaveBeenCalledTimes(1);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(1);
    });
  });

  describe('自动续费扣款', () => {
    it('capabilities.authorizedCharge=false 的渠道 → 409，且不建支付单、不调渠道', async () => {
      const fake = provider('fake', {
        ...FAKE_CAPABILITIES,
        authorizedCharge: false,
      });
      const prisma = prismaMock();
      const { service } = buildService(fake, prisma);

      const error = await catchError(() =>
        runForTenant(TENANT_ID, () =>
          service.chargeInvoice('INV-1', 'fake', 'token-1'),
        ),
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(
        /当前渠道 fake 不支持自动续费扣款/,
      );
      expect(fake.chargeAuthorized).toHaveBeenCalledTimes(0);
      // ⚠️ 门控在建支付单（落库）之前
      expect(prisma.payment.create).toHaveBeenCalledTimes(0);
      expect(prisma.invoice.findFirst).toHaveBeenCalledTimes(0);
    });
  });
});

/**
 * REFUNDING 状态机（阶段 6c Task 15）。
 *
 * ⚠️ 每条护栏都同时断言「状态对不对」与「副作用有没有发生」：
 *    只断言返回值的话，把 `PROCESSING` 当 `SUCCESS` 落 `REFUNDED` 也能过。
 */
describe('PaymentService 退款状态机（阶段 6c）', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  beforeAll(() => {
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

  /** 一个已就绪的服务 + 命中闸门的默认桩 */
  type UpdateCall = {
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  };

  /** 全部 `payment.updateMany` 调用的参数（类型化，避免 unsafe 访问） */
  function updateCalls(prisma: ReturnType<typeof prismaMock>): UpdateCall[] {
    return (
      prisma.payment.updateMany.mock.calls as unknown as Array<[UpdateCall]>
    ).map(([arg]) => arg);
  }

  function setup() {
    const fake = provider('fake', FAKE_CAPABILITIES);
    const prisma = prismaMock();
    const built = buildService(fake, prisma);
    prisma.order.findMany.mockResolvedValue([paidOrder()]);
    // ⚠️ 退款落账时会在事务内读一次订单的**当前状态**
    //    （判「该不该做订单级动作」）。默认是一张已付款的订单。
    prisma.order.findFirst.mockResolvedValue({ status: OrderStatus.PAID });
    prisma.payment.findMany.mockResolvedValue([successPayment()]);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.databaseNow.mockResolvedValue(new Date('2026-11-02T00:00:00Z'));
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    built.orderService.transitionInTx.mockResolvedValue(true);
    return { fake, prisma, ...built };
  }

  it('抢闸门写的是 SUCCESS → REFUNDING，并计一次预算', async () => {
    const { fake, prisma, service } = setup();
    fake.refund.mockResolvedValue({ status: 'SUCCESS', refundTxnId: 'rt-1' });

    await service.refund('SO-1', '测试退款');

    const claim = updateCalls(prisma)[0];
    // ⚠️ **闸门要能抢 `SUCCESS` 与 `NEEDS_REFUND` 两种**：
    //    后者是「钱收了但订单没接住」的支付单（审计 P0-3），正是商家要退的那笔。
    expect(claim.where).toMatchObject({
      status: { in: [PaymentStatus.SUCCESS, PaymentStatus.NEEDS_REFUND] },
      refundAttemptCount: { lt: 3 },
    });
    expect(claim.data?.status).toBe(PaymentStatus.REFUNDING);
    expect(claim.data?.refundAttemptCount).toEqual({ increment: 1 });
    expect(claim.data?.refundRequestedAt).toBeInstanceOf(Date);
    // ⚠️ **新一次尝试必须清掉上一次的受理号** —— 否则扫描 / 迟到回调会拿
    //    上一次的结论处置这一次的退款（可能重复退款）。
    expect(claim.data?.refundTxnId).toBeNull();
  });

  it('渠道回 PROCESSING → 保持 REFUNDING，订单不流转、不冲回', async () => {
    const { fake, prisma, service, orderService, commission, receipt } =
      setup();
    fake.refund.mockResolvedValue({
      status: 'PROCESSING',
      refundTxnId: 'rt-async',
    });

    await expect(service.refund('SO-1', '测试退款')).resolves.toEqual({
      status: 'REFUNDING',
    });

    for (const call of updateCalls(prisma)) {
      expect(call.data?.status).not.toBe(PaymentStatus.REFUNDED);
    }
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    expect(commission.recordReversalInTx).toHaveBeenCalledTimes(0);
    expect(receipt.recordReceiptReversalInTx).toHaveBeenCalledTimes(0);
    expect(
      updateCalls(prisma).some((call) => call.data?.refundTxnId === 'rt-async'),
    ).toBe(true);
  });

  it('⚠️ FAILED + definitive=true → 回退 SUCCESS 并报错（可重试）', async () => {
    const { fake, prisma, service, orderService } = setup();
    fake.refund.mockResolvedValue({
      status: 'FAILED',
      definitive: true,
      failureReason: '余额不足',
    });

    const error = await catchError(() => service.refund('SO-1', '测试退款'));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(
      updateCalls(prisma).some(
        (call) =>
          call.where?.status === PaymentStatus.REFUNDING &&
          call.data?.status === PaymentStatus.SUCCESS,
      ),
    ).toBe(true);
    // ⚠️ **回退时也要清掉受理号** —— 那个受理号已被渠道明确拒付，
    //    留着它下次异常时扫描会拿它去问，把旧结论当成本次结论。
    expect(
      updateCalls(prisma).some(
        (call) =>
          call.data?.status === PaymentStatus.SUCCESS &&
          call.data?.refundTxnId === null,
      ),
    ).toBe(true);
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
  });

  it('⚠️ FAILED + definitive=false → 保持 REFUNDING 并写可读原因（不回退）', async () => {
    const { fake, prisma, service } = setup();
    fake.refund.mockResolvedValue({
      status: 'FAILED',
      definitive: false,
      failureReason: '渠道超时',
    });

    await expect(service.refund('SO-1', '测试退款')).resolves.toEqual({
      status: 'REFUNDING',
    });

    expect(
      updateCalls(prisma).some(
        (call) => call.data?.status === PaymentStatus.SUCCESS,
      ),
    ).toBe(false);
    expect(
      updateCalls(prisma).some(
        (call) => call.data?.refundFailureReason === '渠道超时',
      ),
    ).toBe(true);
  });

  it('⚠️ 渠道抛异常 → 同样保持 REFUNDING（结果未知，回退就是允许重复退款）', async () => {
    const { fake, prisma, service } = setup();
    fake.refund.mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.refund('SO-1', '测试退款')).resolves.toEqual({
      status: 'REFUNDING',
    });
    expect(
      updateCalls(prisma).some(
        (call) => call.data?.status === PaymentStatus.SUCCESS,
      ),
    ).toBe(false);
  });

  it('⚠️ 并发两个退款请求 → 只有一个调渠道（断言渠道调用 1 次）', async () => {
    const { fake, prisma, service } = setup();
    fake.refund.mockResolvedValue({ status: 'SUCCESS', refundTxnId: 'rt-1' });
    prisma.payment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });
    prisma.payment.findMany.mockImplementation(
      (arg: { where?: { id?: unknown; status?: unknown } }) => {
        const where = arg?.where ?? {};
        // 抢闸门冲突时要按 id 回读那一笔的状态
        if (where.id !== undefined) {
          return [
            {
              id: 'payment-1',
              status: PaymentStatus.SUCCESS,
              refundAttemptCount: 1,
            },
          ];
        }
        // ⚠️ 候选查询用 `status: { in: [...] }`，
        //    「是否已在退款中」用 `status: REFUNDING`
        const status = where.status as { in?: unknown[] } | undefined;
        if (status && Array.isArray(status.in)) {
          return [successPayment()];
        }
        return [{ status: PaymentStatus.REFUNDING, refundAttemptCount: 1 }];
      },
    );

    const [first, second] = await Promise.allSettled([
      service.refund('SO-1', '退款 A'),
      service.refund('SO-1', '退款 B'),
    ]);

    expect(fake.refund).toHaveBeenCalledTimes(1);
    expect([first.status, second.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });

  it('⚠️ 重试预算已用尽 → 409 且不调渠道', async () => {
    const { fake, prisma, service } = setup();
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });
    prisma.payment.findMany.mockImplementation(
      (arg: { where?: { id?: unknown; status?: unknown } }) => {
        const where = arg?.where ?? {};
        // 抢闸门冲突时要按 id 回读那一笔的状态
        if (where.id !== undefined) {
          return [
            {
              id: 'payment-1',
              status: PaymentStatus.SUCCESS,
              refundAttemptCount: 3,
            },
          ];
        }
        const status = where.status as { in?: unknown[] } | undefined;
        if (status && Array.isArray(status.in)) {
          return [successPayment()];
        }
        return [];
      },
    );

    const error = await catchError(() => service.refund('SO-1', '测试退款'));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toMatch(/退款重试次数已达上限/);
    expect(fake.refund).toHaveBeenCalledTimes(0);
  });

  describe('退款事件应用', () => {
    function refundEvent(
      over: Record<string, unknown> = {},
    ): NormalizedWebhookEvent {
      return {
        provider: 'fake',
        channel: 'fake',
        eventId: 'rev-1',
        providerTxnId: '',
        referenceNo: 'SO-1',
        amount: 1000,
        success: true,
        eventType: 'REFUND',
        refundTxnId: 'rt-1',
        refundStatus: 'SUCCESS',
        ...over,
      };
    }

    function refundingRow() {
      return {
        id: 'payment-1',
        orderId: 'order-1',
        amount: 1000,
        status: PaymentStatus.REFUNDING,
      };
    }

    it('REFUNDING + 回调 SUCCESS → 落 REFUNDED、订单 REFUNDED、冲回各一条', async () => {
      const { prisma, service, orderService, commission, receipt } = setup();
      prisma.payment.findFirst.mockResolvedValue(refundingRow());

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(refundEvent(), TENANT_ID),
      );

      expect(
        updateCalls(prisma).some(
          (call) =>
            call.data?.status === PaymentStatus.REFUNDED &&
            call.where?.status === PaymentStatus.REFUNDING,
        ),
      ).toBe(true);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(1);
      expect(commission.recordReversalInTx).toHaveBeenCalledTimes(1);
      expect(receipt.recordReceiptReversalInTx).toHaveBeenCalledTimes(1);
      expect(prisma.paymentWebhookEvent.updateMany).toHaveBeenCalled();
    });

    it('REFUNDING + 回调 FAILED + definitive=true → 回退 SUCCESS', async () => {
      const { prisma, service, orderService } = setup();
      prisma.payment.findFirst.mockResolvedValue(refundingRow());

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(
          refundEvent({
            success: false,
            refundStatus: 'FAILED',
            definitive: true,
          }),
          TENANT_ID,
        ),
      );

      expect(
        updateCalls(prisma).some(
          (call) => call.data?.status === PaymentStatus.SUCCESS,
        ),
      ).toBe(true);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    });

    it('⚠️ 回调 FAILED + definitive=false（或无 definitive）→ 状态不变', async () => {
      const { prisma, service, orderService } = setup();
      prisma.payment.findFirst.mockResolvedValue(refundingRow());

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(
          refundEvent({
            success: false,
            refundStatus: 'FAILED',
            definitive: false,
          }),
          TENANT_ID,
        ),
      );
      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(
          refundEvent({
            eventId: 'rev-2',
            success: false,
            refundStatus: 'FAILED',
          }),
          TENANT_ID,
        ),
      );

      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(0);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    });

    it('⚠️ 回调 PROCESSING → 只记日志，一个字都不写', async () => {
      const { prisma, service } = setup();
      prisma.payment.findFirst.mockResolvedValue(refundingRow());

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(
          refundEvent({ success: false, refundStatus: 'PROCESSING' }),
          TENANT_ID,
        ),
      );

      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(0);
    });

    it('⚠️ 回调金额与实付额不符 → 拒绝落账', async () => {
      const { prisma, service, orderService } = setup();
      prisma.payment.findFirst.mockResolvedValue(refundingRow());

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(refundEvent({ amount: 1 }), TENANT_ID),
      );

      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(0);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    });

    it('⚠️ 受理号查不到但事件是 SUCCESS → 按订单号兜底并落 REFUNDED（不被吞掉）', async () => {
      const { prisma, service, orderService, commission } = setup();
      // 第一次按 `refundTxnId` 查：库里还没写受理号（异步受理时渠道才生成的）
      // 第二次按订单号查：能找到这张 REFUNDING 的单
      prisma.payment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...refundingRow(), refundTxnId: null });

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(
          refundEvent({ refundTxnId: 'rt-late' }),
          TENANT_ID,
        ),
      );

      expect(orderService.transitionInTx).toHaveBeenCalledTimes(1);
      expect(commission.recordReversalInTx).toHaveBeenCalledTimes(1);
      expect(
        updateCalls(prisma).some(
          (call) =>
            call.data?.status === PaymentStatus.REFUNDED &&
            call.data?.refundTxnId === 'rt-late',
        ),
      ).toBe(true);
    });

    it('⚠️ 受理号不一致（上一次尝试的迟到回调）→ 不处置这一次', async () => {
      const { prisma, service, orderService } = setup();
      prisma.payment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...refundingRow(), refundTxnId: 'rt-new' });

      await runForTenant(TENANT_ID, () =>
        service.applyRefundEvent(
          refundEvent({ refundTxnId: 'rt-stale' }),
          TENANT_ID,
        ),
      );

      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(0);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    });
  });

  describe('退款扫描 scanRefunding', () => {
    it('⚠️ 单轮最多处理 50 张（查询 take=50）', async () => {
      const { prisma, service } = setup();
      prisma.payment.findMany.mockImplementation(
        (arg: { take?: number; where?: { status?: unknown } }) => {
          if (arg?.where?.status !== PaymentStatus.REFUNDING) {
            return [paidOrder()];
          }
          return Array.from({ length: arg.take ?? 0 }, (_, i) => ({
            id: `p-${i}`,
            tenantId: TENANT_ID,
            orderId: `o-${i}`,
            refundTxnId: null,
          }));
        },
      );

      const handled = await service.scanRefunding();

      const scanCall = prisma.payment.findMany.mock.calls.find(
        ([arg]) =>
          (arg as { where?: { status?: unknown } }).where?.status ===
          PaymentStatus.REFUNDING,
      ) as [{ take: number }] | undefined;
      expect(scanCall?.[0].take).toBe(50);
      expect(handled).toBe(0);
    });

    it('⚠️ 没有 refundTxnId 的单不调渠道（断言 0 次）', async () => {
      const { fake, prisma, service } = setup();
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p-1', tenantId: TENANT_ID, orderId: 'o-1', refundTxnId: null },
      ]);

      await service.scanRefunding();

      expect(fake.queryRefund).toHaveBeenCalledTimes(0);
    });

    it('有受理号 → queryRefund；SUCCESS → 落 REFUNDED + 冲回', async () => {
      const { fake, prisma, service, orderService, commission } = setup();
      prisma.payment.findMany.mockImplementation(
        (arg: { where?: { status?: unknown } }) =>
          arg?.where?.status === PaymentStatus.REFUNDING
            ? [
                {
                  id: 'p-1',
                  tenantId: TENANT_ID,
                  orderId: 'o-1',
                  refundTxnId: 'rt-1',
                },
              ]
            : [paidOrder()],
      );
      prisma.payment.findFirst.mockResolvedValue({
        id: 'p-1',
        orderId: 'order-1',
        amount: 1000,
        status: PaymentStatus.REFUNDING,
        channel: 'fake',
        refundTxnId: 'rt-1',
      });
      fake.queryRefund.mockResolvedValue({ status: 'SUCCESS' });

      const handled = await service.scanRefunding();

      expect(fake.queryRefund).toHaveBeenCalledWith('rt-1');
      expect(handled).toBe(1);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(1);
      expect(commission.recordReversalInTx).toHaveBeenCalledTimes(1);
    });

    it('有受理号但渠道回 UNKNOWN → 状态不变、不冲回', async () => {
      const { fake, prisma, service, orderService } = setup();
      prisma.payment.findMany.mockImplementation(
        (arg: { where?: { status?: unknown } }) =>
          arg?.where?.status === PaymentStatus.REFUNDING
            ? [
                {
                  id: 'p-1',
                  tenantId: TENANT_ID,
                  orderId: 'o-1',
                  refundTxnId: 'rt-1',
                },
              ]
            : [paidOrder()],
      );
      prisma.payment.findFirst.mockResolvedValue({
        id: 'p-1',
        orderId: 'order-1',
        amount: 1000,
        status: PaymentStatus.REFUNDING,
        channel: 'fake',
        refundTxnId: 'rt-1',
      });
      fake.queryRefund.mockResolvedValue({ status: 'UNKNOWN' });

      await service.scanRefunding();

      expect(prisma.payment.updateMany).toHaveBeenCalledTimes(0);
      expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    });
  });
});

describe('渠道交易号绑定（阶段 8b）', () => {
  type AttachFn = (
    order: { id: string; orderNo: string },
    event: NormalizedWebhookEvent,
  ) => Promise<boolean>;

  function setupAttach() {
    const prisma = prismaMock();
    const { service } = buildService(
      provider('fake', FAKE_CAPABILITIES),
      prisma,
    );
    const attach = (
      service as unknown as { attachProviderTxnId: AttachFn }
    ).attachProviderTxnId.bind(service);
    return { prisma, attach };
  }

  function event(
    over: Partial<NormalizedWebhookEvent> = {},
  ): NormalizedWebhookEvent {
    return {
      provider: 'fake',
      channel: 'fake',
      eventId: 'evt-1',
      providerTxnId: 'txn-1',
      referenceNo: 'SO-1',
      amount: 1000,
      success: true,
      eventType: 'PAYMENT',
      ...over,
    };
  }

  it('写入时 where 带上 provider', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      attach({ id: 'order-1', orderNo: 'SO-1' }, event()),
    ).resolves.toBe(true);

    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'order-1',
          channel: 'fake',
          provider: 'fake',
          status: PaymentStatus.PENDING,
        }) as unknown,
      }),
    );
  });

  it('updateMany 命中 0 行 → 返回 false（不再静默成功）', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      attach({ id: 'order-1', orderNo: 'SO-1' }, event()),
    ).resolves.toBe(false);
  });

  it('provider 不匹配导致 0 行 → 返回 false', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      attach(
        { id: 'order-1', orderNo: 'SO-1' },
        event({ provider: 'sandbox', channel: 'fake' }),
      ),
    ).resolves.toBe(false);

    // 写入条件必须用事件里的 provider，而不是写死当前渠道
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: 'sandbox' }) as unknown,
      }),
    );
  });

  it('渠道交易已落到别的订单 → 返回 false 且不写库', async () => {
    const { prisma, attach } = setupAttach();
    prisma.payment.findFirst.mockResolvedValue({ id: 'payment-other' });

    await expect(
      attach({ id: 'order-1', orderNo: 'SO-1' }, event()),
    ).resolves.toBe(false);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * 支付事件应用（消费端复核，审计 P0-6）。
 *
 * ⚠️ **这里模拟的是「能写 Redis 的人」**：他可以改写队列任务里的金额。
 *    消费端必须**从订单反查应付金额**（②），并且**只认事件行**（③）。
 */
describe('支付事件应用（消费端复核，审计 P0-6）', () => {
  function paymentEvent(
    over: Partial<NormalizedWebhookEvent> = {},
  ): NormalizedWebhookEvent {
    return {
      provider: 'fake',
      channel: 'fake',
      eventId: 'evt-1',
      providerTxnId: 'txn-1',
      referenceNo: 'SO-1',
      amount: 1000,
      success: true,
      eventType: 'PAYMENT',
      ...over,
    };
  }

  function setupApply() {
    const prisma = prismaMock();
    const built = buildService(provider('fake', FAKE_CAPABILITIES), prisma);
    prisma.order.findMany.mockResolvedValue([paidOrder()]);
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([
      { now: new Date('2026-11-02T00:00:00Z') },
    ]);
    built.orderService.transitionInTx.mockResolvedValue(true);
    return { prisma, ...built };
  }

  it('金额与订单应付额不符 → 不流转（不进事务、不动支付单）', async () => {
    const { prisma, service, orderService } = setupApply();

    await service.applyEvent(paymentEvent({ amount: 1 }), TENANT_ID);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(orderService.transitionInTx).not.toHaveBeenCalled();
  });

  it('金额与订单应付额一致 → 正常流转（对照组）', async () => {
    const { prisma, service, orderService } = setupApply();

    await service.applyEvent(paymentEvent(), TENANT_ID);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(orderService.transitionInTx).toHaveBeenCalled();
  });

  describe('loadRegisteredEvent（复核事件行）', () => {
    it('没有这张事件行 → null（这个任务不生效）', async () => {
      const { prisma, service } = setupApply();
      prisma.paymentWebhookEvent.findFirst.mockResolvedValue(null);

      await expect(
        service.loadRegisteredEvent('fake', 'evt-1'),
      ).resolves.toBeNull();
    });

    it('有事件行 → 用**行里的内容**还原事件（金额取自行，不取任务）', async () => {
      const { prisma, service } = setupApply();
      prisma.paymentWebhookEvent.findFirst.mockResolvedValue({
        provider: 'fake',
        eventId: 'evt-1',
        providerTxnId: 'txn-1',
        kind: PaymentKind.ORDER,
        payload: {
          channel: 'fake',
          referenceNo: 'SO-1',
          amount: 1000,
          success: true,
        },
      });

      const loaded = await service.loadRegisteredEvent('fake', 'evt-1');

      expect(loaded?.event.amount).toBe(1000);
      expect(loaded?.event.referenceNo).toBe('SO-1');
      expect(loaded?.kind).toBe(PaymentKind.ORDER);
      // ⚠️ 只认「还没处理完」的行
      expect(prisma.paymentWebhookEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            provider: 'fake',
            eventId: 'evt-1',
            processedAt: null,
          }) as unknown,
        }),
      );
    });

    it('行里的 payload 结构不对 → null', async () => {
      const { prisma, service } = setupApply();
      prisma.paymentWebhookEvent.findFirst.mockResolvedValue({
        provider: 'fake',
        eventId: 'evt-1',
        providerTxnId: null,
        kind: PaymentKind.ORDER,
        payload: { channel: 'fake' },
      });

      await expect(
        service.loadRegisteredEvent('fake', 'evt-1'),
      ).resolves.toBeNull();
    });
  });
});

/**
 * 支付回调的状态机分流（2026-11-05 审计 P0-3 / P1-3）。
 *
 * ⚠️ **这里守的是「钱收了但订单没接住」**：
 *    渠道回调确认收款时，订单可能已经不是「待支付」
 *    （超时关闭 / 消费者取消 / 已被另一渠道先付掉）。
 *    这时钱**确实收了**，但它**没有结算进订单**——
 *    落成 `NEEDS_REFUND`（已收款待退款），让商家在系统内能把它退掉。
 *
 * ⚠️ **绝不回滚**：回滚会把「钱已经收了」这个事实抹掉，
 *    而事件又会被标记成已处理 → 补偿扫描再也救不回来。
 */
describe('支付回调分流：钱收了但订单没接住（审计 P0-3 / P1-3）', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  beforeAll(() => {
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

  /** 一笔已收款的支付单（钱确实收了） */
  function successPaymentRow() {
    return {
      id: 'payment-1',
      orderId: 'order-1',
      channel: 'fake',
      amount: 1000,
      status: PaymentStatus.SUCCESS,
    };
  }

  /**
   * 装好一个「订单接不住钱」的场景。
   *
   * @param orderStatus 订单当前的状态（回调到达时的真实状态）
   * @param paidCount   置 SUCCESS 那次条件更新命中了几行（1 = 新收款，0 = 重复投递）
   */
  function setupUnsettled(orderStatus: OrderStatus, paidCount: number) {
    const prisma = prismaMock();
    const built = buildService(provider('fake', FAKE_CAPABILITIES), prisma);
    prisma.order.findMany.mockResolvedValue([
      { ...paidOrder(), status: orderStatus },
    ]);
    // 事务内读订单的当前状态（判分流文案 + 「这单结没结算过」）
    prisma.order.findFirst.mockResolvedValue({ status: orderStatus });
    // ⚠️ 「找已收款的支付单」那次查询要命中；「渠道交易号是否冲突」那次要落空
    prisma.payment.findFirst.mockImplementation(
      (arg: { where?: { status?: unknown } }) =>
        arg?.where?.status === PaymentStatus.SUCCESS
          ? successPaymentRow()
          : null,
    );
    // 重复投递时那次「查已有支付单」要查到那笔 SUCCESS 的
    prisma.payment.findMany.mockResolvedValue([successPaymentRow()]);
    prisma.payment.updateMany.mockImplementation(
      (arg: { where?: { provider?: unknown; status?: unknown } }) => {
        // 绑定渠道交易号那次（事务外，带 provider）
        if (arg?.where?.provider !== undefined) {
          return { count: 1 };
        }
        // ⚠️ 置 SUCCESS 那次（事务内，只按 PENDING 过滤）
        if (arg?.where?.status === PaymentStatus.PENDING) {
          return { count: paidCount };
        }
        return { count: 1 };
      },
    );
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([
      { now: new Date('2026-11-02T00:00:00Z') },
    ]);
    // 订单接不住：条件更新抢不到
    built.orderService.transitionInTx.mockResolvedValue(false);
    return { prisma, ...built };
  }

  function event() {
    return {
      provider: 'fake',
      channel: 'fake',
      eventId: 'evt-1',
      providerTxnId: 'txn-1',
      referenceNo: 'SO-1',
      amount: 1000,
      success: true,
      eventType: 'PAYMENT',
    } satisfies NormalizedWebhookEvent;
  }

  /** 全部 `payment.updateMany` 调用的参数 */
  function updateCalls(prisma: ReturnType<typeof prismaMock>): Array<{
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }> {
    return (
      prisma.payment.updateMany.mock.calls as unknown as Array<
        [{ where?: Record<string, unknown>; data?: Record<string, unknown> }]
      >
    ).map(([arg]) => arg);
  }

  it('订单已超时关闭 + 本次新收款 → 支付单落「已收款待退款」', async () => {
    const { prisma, service } = setupUnsettled(OrderStatus.CLOSED, 1);

    await service.applyEvent(event(), TENANT_ID);

    expect(
      updateCalls(prisma).some(
        (call) =>
          call.data?.status === PaymentStatus.NEEDS_REFUND &&
          call.where?.status === PaymentStatus.SUCCESS,
      ),
    ).toBe(true);
  });

  it('⚠️ 订单已被消费者取消 + 本次新收款 → 同样落「已收款待退款」（审计要求覆盖 CANCELLED）', async () => {
    const { prisma, service } = setupUnsettled(OrderStatus.CANCELLED, 1);

    await service.applyEvent(event(), TENANT_ID);

    expect(
      updateCalls(prisma).some(
        (call) =>
          call.data?.status === PaymentStatus.NEEDS_REFUND &&
          call.where?.status === PaymentStatus.SUCCESS,
      ),
    ).toBe(true);
  });

  it('⚠️ 订单已被另一渠道付过 + 本次新收款 → 落「已收款待退款」（重复收款）', async () => {
    const { prisma, service } = setupUnsettled(OrderStatus.PAID, 1);

    await service.applyEvent(event(), TENANT_ID);

    expect(
      updateCalls(prisma).some(
        (call) =>
          call.data?.status === PaymentStatus.NEEDS_REFUND &&
          call.where?.status === PaymentStatus.SUCCESS,
      ),
    ).toBe(true);
  });

  it('⚠️ 订单没接住 → 一条流水都不能记（没结算过就没有可记的）', async () => {
    const { service, commission, receipt, inventory } = setupUnsettled(
      OrderStatus.CLOSED,
      1,
    );

    await service.applyEvent(event(), TENANT_ID);

    expect(commission.recordCommissionInTx).toHaveBeenCalledTimes(0);
    expect(receipt.recordReceiptInTx).toHaveBeenCalledTimes(0);
    expect(inventory.deductInTx).toHaveBeenCalledTimes(0);
  });

  it('⚠️ 重复投递（支付单已经是 SUCCESS）→ 不落「已收款待退款」（防误标）', async () => {
    const { prisma, service } = setupUnsettled(OrderStatus.PAID, 0);

    await service.applyEvent(event(), TENANT_ID);

    expect(
      updateCalls(prisma).some(
        (call) => call.data?.status === PaymentStatus.NEEDS_REFUND,
      ),
    ).toBe(false);
  });
});

/**
 * 退款路径（2026-11-05 审计 P0-3 补救出口 / P1-3 双渠道）。
 *
 * ⚠️ **这里守三件事**：
 * 1. **P0-3 的补救出口**：订单已关闭 / 已取消，但有一笔「已收款待退款」的钱
 *    → 商家在系统内能把它退掉（原来只能线下退款或改库）。
 * 2. **P1-3 的第二笔**：同一个订单被两个渠道各收了一笔
 *    → 整单退款要**两笔都退**，不能只退 `payments[0]`（那笔随机挑的）。
 * 3. **第二笔不再卡死**：订单已经是 `REFUNDED` 时退第二笔
 *    → 只落支付单 `REFUNDED`，**不抛异常**（抛了整笔回滚 → 这笔永远卡在 `REFUNDING`）。
 */
describe('退款路径：补救出口与双渠道（审计 P0-3 / P1-3）', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnabled = process.env.PAYMENT_ENABLED_CHANNELS;

  beforeAll(() => {
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

  function updateCalls(prisma: ReturnType<typeof prismaMock>): Array<{
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }> {
    return (
      prisma.payment.updateMany.mock.calls as unknown as Array<
        [{ where?: Record<string, unknown>; data?: Record<string, unknown> }]
      >
    ).map(([arg]) => arg);
  }

  function setupRefund(orderStatus: OrderStatus) {
    const fake = provider('fake', FAKE_CAPABILITIES);
    fake.refund.mockResolvedValue({ status: 'SUCCESS', refundTxnId: 'rt-1' });
    const prisma = prismaMock();
    const built = buildService(fake, prisma);
    prisma.order.findMany.mockResolvedValue([
      { ...paidOrder(), status: orderStatus },
    ]);
    prisma.order.findFirst.mockResolvedValue({ status: orderStatus });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.databaseNow.mockResolvedValue(new Date('2026-11-02T00:00:00Z'));
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    built.orderService.transitionInTx.mockResolvedValue(true);
    return { fake, prisma, ...built };
  }

  it('⚠️ 订单已关闭 + 一笔「已收款待退款」→ 钱退得回去，订单不动、也不记冲回', async () => {
    const { fake, prisma, service, orderService, commission, receipt } =
      setupRefund(OrderStatus.CLOSED);
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'payment-1',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.NEEDS_REFUND,
      },
    ]);

    await expect(service.refund('SO-1', '迟到扣款退回')).resolves.toEqual({
      status: 'REFUNDED',
    });

    expect(fake.refund).toHaveBeenCalledTimes(1);
    // ⚠️ **订单是终态，改不了、也不该改**（那单从没结算过，没有可冲回的流水）
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    expect(commission.recordReversalInTx).toHaveBeenCalledTimes(0);
    expect(receipt.recordReceiptReversalInTx).toHaveBeenCalledTimes(0);
    expect(
      updateCalls(prisma).some(
        (call) => call.data?.status === PaymentStatus.REFUNDED,
      ),
    ).toBe(true);
  });

  it('⚠️ 订单已被消费者取消 → 同样退得回去（审计要求覆盖 CANCELLED 路径）', async () => {
    const { fake, prisma, service, orderService } = setupRefund(
      OrderStatus.CANCELLED,
    );
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'payment-1',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.NEEDS_REFUND,
      },
    ]);

    await expect(service.refund('SO-1', '取消后到账退回')).resolves.toEqual({
      status: 'REFUNDED',
    });

    expect(fake.refund).toHaveBeenCalledTimes(1);
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
  });

  it('⚠️ 订单已付 + 两笔（结算款 + 另一渠道多收的那笔）→ 两笔都退，冲回只记一次', async () => {
    const { fake, prisma, service, orderService, commission, receipt } =
      setupRefund(OrderStatus.PAID);
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'payment-1',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.SUCCESS,
      },
      {
        id: 'payment-2',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.NEEDS_REFUND,
      },
    ]);
    // ⚠️ 事务内读订单当前状态：第一笔看到的是 PAID（还没退），
    //    第二笔看到的是 REFUNDED（第一笔已经提交）
    let reads = 0;
    prisma.order.findFirst.mockImplementation(() => {
      reads += 1;
      return Promise.resolve({
        status: reads === 1 ? OrderStatus.PAID : OrderStatus.REFUNDED,
      });
    });

    await expect(service.refund('SO-1', '整单退款')).resolves.toEqual({
      status: 'REFUNDED',
    });

    // ⚠️ **两笔都退**（只退 `payments[0]` 的话另一笔永远退不掉）
    expect(fake.refund).toHaveBeenCalledTimes(2);
    // ⚠️ **订单级动作只做一次**（第二笔看到订单已退款 → 跳过，不重复记冲回）
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(1);
    expect(commission.recordReversalInTx).toHaveBeenCalledTimes(1);
    expect(receipt.recordReceiptReversalInTx).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 订单已经被退过 → 第二笔只落 REFUNDED，不抛异常（不再卡死在 REFUNDING）', async () => {
    const { fake, prisma, service, orderService, commission } = setupRefund(
      OrderStatus.REFUNDED,
    );
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'payment-2',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.SUCCESS,
      },
    ]);

    await expect(service.refund('SO-1', '退残留的一笔')).resolves.toEqual({
      status: 'REFUNDED',
    });

    expect(fake.refund).toHaveBeenCalledTimes(1);
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(0);
    expect(commission.recordReversalInTx).toHaveBeenCalledTimes(0);
    expect(
      updateCalls(prisma).some(
        (call) => call.data?.status === PaymentStatus.REFUNDED,
      ),
    ).toBe(true);
  });

  it('⚠️ 订单还是已付状态但条件更新抢不到（并发）→ 不抛异常，只落 REFUNDED', async () => {
    // ⚠️ **这条分支正是 P1-3「第二笔永远卡在 REFUNDING」的根因**：
    //    老实现在这里抛 ConflictException → 整笔事务回滚 →
    //    支付单退回 REFUNDING → 这笔钱再也退不掉。
    const { fake, prisma, service, orderService, commission, receipt } =
      setupRefund(OrderStatus.PAID);
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'payment-2',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.SUCCESS,
      },
    ]);
    // 另一笔并发退款已经把这单退掉了 → 条件更新抢不到
    orderService.transitionInTx.mockResolvedValue(false);

    await expect(service.refund('SO-1', '整单退款')).resolves.toEqual({
      status: 'REFUNDED',
    });

    expect(fake.refund).toHaveBeenCalledTimes(1);
    // ⚠️ **不能抛**：抛了这笔就卡死在 REFUNDING
    expect(orderService.transitionInTx).toHaveBeenCalledTimes(1);
    // 订单级动作抢不到 → 不重复记冲回
    expect(commission.recordReversalInTx).toHaveBeenCalledTimes(0);
    expect(receipt.recordReceiptReversalInTx).toHaveBeenCalledTimes(0);
    // 但支付单确实退了
    expect(
      updateCalls(prisma).some(
        (call) => call.data?.status === PaymentStatus.REFUNDED,
      ),
    ).toBe(true);
  });

  it('⚠️ 没有可退款的支付单 → 409，且不调渠道', async () => {
    const { fake, prisma, service } = setupRefund(OrderStatus.PAID);
    prisma.payment.findMany.mockResolvedValue([]);

    const error = await catchError(() => service.refund('SO-1', '测试退款'));

    expect(error).toBeInstanceOf(ConflictException);
    expect(fake.refund).toHaveBeenCalledTimes(0);
  });

  it('⚠️ 已完成的订单 → 409（退货退款不在本阶段）', async () => {
    const { fake, prisma, service } = setupRefund(OrderStatus.COMPLETED);
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'payment-1',
        orderId: 'order-1',
        channel: 'fake',
        amount: 1000,
        status: PaymentStatus.SUCCESS,
      },
    ]);

    const error = await catchError(() => service.refund('SO-1', '测试退款'));

    expect(error).toBeInstanceOf(ConflictException);
    expect(fake.refund).toHaveBeenCalledTimes(0);
  });
});
