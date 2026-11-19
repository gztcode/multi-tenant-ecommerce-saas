import { InvoiceStatus, PaymentKind, PaymentStatus } from '@prisma/client';

import { WebhookEventService } from './payment-webhook.service';
import type { NormalizedWebhookEvent } from './payment-provider.interface';

/**
 * 订阅付款回调 `applySubscriptionEvent` 的单测（审计批次 20 · payment-2）。
 *
 * 被测缺陷：旧实现「绝不碰支付单」，却在**另一个事务**里调 `markInvoicePaid`
 * 付清账单 —— 支付单永远停在 PENDING，且「支付单终态 + 发票付清 + 订阅期延长」
 * 不是同一事务，中途崩溃会留下「钱收了、服务没开」。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `cart.service.spec.ts` 同款）：
 * 每个方法的返回值由 `options` 配好，不按 `where` 过滤；
 * `findFirst` 例外 —— 靠 `where` 里带不带 `NOT` 区分「冲突检查」与「目标解析」。
 *
 * ⚠️ **$transaction 的假实现**：直接把 `tx`（另一个假 Prisma 片段）传给回调，
 * 于是「写入发生在事务里还是事务外」可以靠**断言调用落在 tx 还是顶层
 * prisma 上**来验；`billingInvoices` 的 `markInvoicePaidInTx` 用 stub 复刻
 * 「付清账单」的最小语义（走 `tx.invoice.updateMany`），从而能断言
 * 「发票付清确实发生在订阅支付单**同一个**事务里」。
 */

const TENANT = 'tenant-a';
const INVOICE_ID = 'inv-1';
const PAYMENT_ID = 'pay-1';

/** 假 Prisma 的查询参数（只要能读出 `where` / `data` 就够断言了） */
interface QueryArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/**
 * 取某个 mock 的第一次调用参数，顺便断言它确实被调用过
 * （避免 `mock.calls[0][0]` 在 strictNullChecks 下报「可能为 undefined」）。
 */
function argsOf(mock: { mock: { calls: unknown[][] } }): QueryArgs {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return (call ?? [])[0] as QueryArgs;
}

/** 订阅路径的假 Prisma 事务片段（写入断言都落在它身上） */
interface FakeTx {
  $queryRaw: jest.Mock<Promise<Array<{ now: Date }>>, []>;
  payment: {
    updateMany: jest.Mock<Promise<{ count: number }>, [args?: QueryArgs]>;
    findFirst: jest.Mock<Promise<unknown>, [args?: QueryArgs]>;
  };
  invoice: {
    updateMany: jest.Mock<Promise<{ count: number }>, [args?: QueryArgs]>;
  };
}

interface FakeOptions {
  /** 账单查不查得到 */
  invoiceFound?: boolean;
  /** 目标订阅支付单存不存在 */
  targetPayment?: boolean;
  /** 目标支付单当前状态 */
  targetPaymentStatus?: PaymentStatus;
  /** providerTxnId 是否已被别的支付单占用（冲突检查命中） */
  conflictingPayment?: boolean;
  /** 事务内「支付单转 SUCCESS」命中的行数（0 = 触发重读） */
  paidCount?: number;
  /** 重读时读出的支付单状态（paidCount === 0 时用） */
  rereadPaymentStatus?: PaymentStatus;
}

function fakePrisma(options: FakeOptions = {}) {
  const invoiceFound = options.invoiceFound ?? true;
  const targetPayment = options.targetPayment ?? true;
  const conflictingPayment = options.conflictingPayment ?? false;
  const paidCount = options.paidCount ?? 1;

  /** 事务内的假 Prisma 片段 */
  const tx: FakeTx = {
    $queryRaw: jest.fn<Promise<Array<{ now: Date }>>, []>(() =>
      Promise.resolve([{ now: new Date('2026-01-01T00:00:00.000Z') }]),
    ),
    payment: {
      updateMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: paidCount }),
      ),
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          options.rereadPaymentStatus != null
            ? { status: options.rereadPaymentStatus }
            : null,
        ),
      ),
    },
    invoice: {
      updateMany: jest.fn<Promise<{ count: number }>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
    },
  };

  const prisma = {
    invoice: {
      // ⚠️ 条件更新也归它管（旧实现失败分支走顶层，断言它「不被调用」来钉住
      // 「失败也要发生在事务里」）
      updateMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(
          invoiceFound
            ? {
                id: INVOICE_ID,
                tenantId: TENANT,
                number: 'INV-001',
                amount: 100,
                status: InvoiceStatus.OPEN,
                subscriptionId: 'sub-1',
              }
            : null,
        ),
      ),
    },
    payment: {
      // ⚠️ 一次 mock 服务两个查询：靠 where 里带不带 `NOT` 区分
      // 「目标订阅支付单解析」与「providerTxnId 冲突检查」。
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(
        (args?: QueryArgs) => {
          const hasNot = Object.prototype.hasOwnProperty.call(
            args?.where ?? {},
            'NOT',
          );
          if (hasNot) {
            return Promise.resolve(
              conflictingPayment ? { id: 'pay-other' } : null,
            );
          }
          return Promise.resolve(
            targetPayment
              ? {
                  id: PAYMENT_ID,
                  status: options.targetPaymentStatus ?? PaymentStatus.PENDING,
                }
              : null,
          );
        },
      ),
      // 顶层 attach 绑定渠道交易号（只配成功——失败场景有专门断言）
      updateMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
    },
    paymentWebhookEvent: {
      updateMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
    },
    databaseNow: jest.fn(() => new Date('2026-01-01T00:00:00.000Z')),
    $transaction: jest.fn<
      Promise<unknown>,
      [cb: (tx: unknown) => Promise<unknown>]
    >((cb) => cb(tx)),
  };

  return { prisma, tx };
}

/** `InvoiceService` 的最小 stub：只有订阅回调会用到的两个方法 */
interface BillingStub {
  markInvoicePaid: jest.Mock;
  markInvoicePaidInTx: jest.Mock;
}

function makeBillingStub(): BillingStub {
  return {
    // ⚠️ 旧缺陷实现调的是它 —— 所有用例都要断言「不被调用」
    markInvoicePaid: jest.fn().mockResolvedValue(true),
    // ⚠️ 复刻「付清账单」的最小语义：条件更新 OPEN/FAILED → PAID。
    //    走 tx 上的 updateMany，正是为了断言「付清发生在订阅支付单同一个事务里」。
    markInvoicePaidInTx: jest.fn(
      async (_tx: unknown, invoiceId: string): Promise<boolean> => {
        await (_tx as FakeTx).invoice.updateMany({
          where: {
            id: invoiceId,
            status: { in: [InvoiceStatus.OPEN, InvoiceStatus.FAILED] },
          },
          data: { status: InvoiceStatus.PAID },
        });
        return true;
      },
    ),
  };
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>['prisma'],
  billingInvoices: BillingStub,
) {
  // ⚠️ 构造函数的 9 个依赖，订阅路径只用到 prisma 与 billingInvoices
  return new WebhookEventService(
    prisma as unknown as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    billingInvoices as never,
    {} as never,
    {} as never,
  );
}

function makeEvent(
  overrides: Partial<NormalizedWebhookEvent> = {},
): NormalizedWebhookEvent {
  return {
    provider: 'fake',
    channel: 'fake',
    eventId: 'evt-sub-1',
    providerTxnId: 'txn-1',
    referenceNo: 'INV-001',
    amount: 100,
    success: true,
    ...overrides,
  };
}

describe('WebhookEventService 订阅续费回调（payment-2）', () => {
  it('成功回调：绑定渠道交易号，支付单置 SUCCESS，发票在同一事务内付清', async () => {
    const { prisma, tx } = fakePrisma();
    const billingStub = makeBillingStub();
    const service = makeService(prisma, billingStub);

    await service.applyEvent(makeEvent(), TENANT, PaymentKind.SUBSCRIPTION);

    // ① 事务外先绑定渠道交易号（attach 在业务事务之前），
    //    且 where 只有 { id, provider } —— 不能带 status:
    //    chargeInvoice 可能已把支付单推进 SUCCESS，回调还要能覆盖交易号。
    expect(prisma.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(argsOf(prisma.payment.updateMany)).toEqual({
      where: { id: PAYMENT_ID, provider: 'fake' },
      data: { providerTxnId: 'txn-1' },
    });

    // ② 只开一次事务，支付单条件更新置 SUCCESS
    //   （status ∈ {PENDING, FAILED}，防止「fail → succeed」竞态）
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(argsOf(tx.payment.updateMany)).toEqual({
      where: {
        id: PAYMENT_ID,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      },
      data: { status: PaymentStatus.SUCCESS },
    });

    // ③ 发票付清发生在**同一个事务**里（不是独立事务）
    expect(billingStub.markInvoicePaidInTx).toHaveBeenCalledTimes(1);
    expect(billingStub.markInvoicePaidInTx).toHaveBeenCalledWith(
      tx,
      INVOICE_ID,
    );
    expect(argsOf(tx.invoice.updateMany).data).toMatchObject({
      status: InvoiceStatus.PAID,
    });

    // ④ 旧的独立事务付清不被调用 —— 这正是本次修复的核心
    expect(billingStub.markInvoicePaid).not.toHaveBeenCalled();

    // ⑤ 事件标记已处理
    expect(prisma.paymentWebhookEvent.updateMany).toHaveBeenCalled();
  });

  it('失败回调：支付单与发票在同一事务里一起转 FAILED', async () => {
    const { prisma, tx } = fakePrisma();
    const billingStub = makeBillingStub();
    const service = makeService(prisma, billingStub);

    await service.applyEvent(
      makeEvent({ success: false }),
      TENANT,
      PaymentKind.SUBSCRIPTION,
    );

    // ① 一次事务：支付单只转 PENDING → FAILED（防止把 SUCCESS 翻转）
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(argsOf(tx.payment.updateMany)).toEqual({
      where: { id: PAYMENT_ID, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED },
    });
    // 发票 OPEN → FAILED 也在同一个事务里
    expect(argsOf(tx.invoice.updateMany)).toEqual({
      where: { id: INVOICE_ID, status: InvoiceStatus.OPEN },
      data: { status: InvoiceStatus.FAILED },
    });

    // ② 失败绝不付清
    expect(billingStub.markInvoicePaid).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaidInTx).not.toHaveBeenCalled();

    // ③ 旧实现走顶层 invoice.updateMany（事务外）—— 新实现必须在 tx 上
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('渠道交易号已被别的支付单占用 → 拒绝流转，不开事务，事件仍标记已处理', async () => {
    const { prisma } = fakePrisma({ conflictingPayment: true });
    const billingStub = makeBillingStub();
    const service = makeService(prisma, billingStub);

    await service.applyEvent(makeEvent(), TENANT, PaymentKind.SUBSCRIPTION);

    // 冲突命中 → 不写交易号、不开业务事务、不付发票
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaid).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaidInTx).not.toHaveBeenCalled();

    // 事件仍要标已处理 —— 否则队列会反复重投同一笔冲突事件
    expect(prisma.paymentWebhookEvent.updateMany).toHaveBeenCalled();
  });

  it('重复回调：支付单早已 SUCCESS → 不重复置位，发票照常付清（幂等）', async () => {
    const { prisma, tx } = fakePrisma({
      paidCount: 0,
      rereadPaymentStatus: PaymentStatus.SUCCESS,
    });
    const billingStub = makeBillingStub();
    const service = makeService(prisma, billingStub);

    await service.applyEvent(makeEvent(), TENANT, PaymentKind.SUBSCRIPTION);

    // 条件更新命中 0 行 → 重读支付单 → 已是 SUCCESS → 幂等继续
    expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.payment.findFirst).toHaveBeenCalledTimes(1);

    // 发票照常付清（条件更新本身幂等，不会延长两次周期）
    expect(billingStub.markInvoicePaidInTx).toHaveBeenCalledTimes(1);
    expect(billingStub.markInvoicePaidInTx).toHaveBeenCalledWith(
      tx,
      INVOICE_ID,
    );
    expect(argsOf(tx.invoice.updateMany).data).toMatchObject({
      status: InvoiceStatus.PAID,
    });
    expect(billingStub.markInvoicePaid).not.toHaveBeenCalled();
  });

  it('成功回调但账单下没有订阅支付单 → fail-closed：不付发票、不开事务', async () => {
    const { prisma } = fakePrisma({ targetPayment: false });
    const billingStub = makeBillingStub();
    const service = makeService(prisma, billingStub);

    await service.applyEvent(makeEvent(), TENANT, PaymentKind.SUBSCRIPTION);

    // 连支付单都没有 → 渠道交易无从核对，绝不付清账单
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaid).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaidInTx).not.toHaveBeenCalled();
    // 事件标记已处理（幂等：成功事件不该被重复投递）
    expect(prisma.paymentWebhookEvent.updateMany).toHaveBeenCalled();
  });

  it('失败回调且没有订阅支付单 → 发票仍转 FAILED，但必须在事务里', async () => {
    const { prisma, tx } = fakePrisma({ targetPayment: false });
    const billingStub = makeBillingStub();
    const service = makeService(prisma, billingStub);

    await service.applyEvent(
      makeEvent({ success: false }),
      TENANT,
      PaymentKind.SUBSCRIPTION,
    );

    // 没有支付单 → 不更新支付单，但发票 OPEN → FAILED 仍要落账
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    expect(argsOf(tx.invoice.updateMany)).toEqual({
      where: { id: INVOICE_ID, status: InvoiceStatus.OPEN },
      data: { status: InvoiceStatus.FAILED },
    });
    // ⚠️ FAILED 也必须写在事务里（顶层写 = 与支付单状态脱节的事务）
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaid).not.toHaveBeenCalled();
    expect(billingStub.markInvoicePaidInTx).not.toHaveBeenCalled();
  });
});
