import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
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

  return { service, orderService, commission, receipt };
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
    expect(claim.where).toMatchObject({
      status: PaymentStatus.SUCCESS,
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
      (arg: { where?: { status?: unknown } }) =>
        arg?.where?.status === PaymentStatus.SUCCESS
          ? [successPayment()]
          : [{ status: PaymentStatus.REFUNDING, refundAttemptCount: 1 }],
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
      (arg: { where?: { status?: unknown } }) =>
        arg?.where?.status === PaymentStatus.SUCCESS
          ? [successPayment()]
          : [{ status: PaymentStatus.SUCCESS, refundAttemptCount: 3 }],
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
