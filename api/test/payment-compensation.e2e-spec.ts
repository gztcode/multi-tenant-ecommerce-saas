import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { CompensationService } from '../src/modules/payment/compensation.service';
import { PaymentService } from '../src/modules/payment/payment.service';
import { platformScope, tenantContext } from '../src/common/tenant/tenant-context';
import { PAYMENT_WEBHOOK_QUEUE } from '../src/common/queue/queue.constants';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OrderStatus, PaymentKind } from '@prisma/client';
import { randomBytes } from 'node:crypto';

const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';
const unique = () => randomBytes(6).toString('hex');

describe('支付补偿扫描', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let compensation: CompensationService;
  let payments: PaymentService;
  let webhookQueue: Queue;

  beforeAll(async () => {
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();
    prisma = app.get(TenantPrismaService);
    compensation = app.get(CompensationService);
    payments = app.get(PaymentService);
    webhookQueue = app.get(getQueueToken(PAYMENT_WEBHOOK_QUEUE));
  });

  afterAll(async () => {
    await app.close();
    delete process.env.FAKE_PAYMENT_ENABLED;
    delete process.env.FAKE_PAYMENT_SECRET;
  });

  function platform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 造一个待支付的订单（直接落库，不走 HTTP） */
  async function makeOrder(opts: {
    tenantId: string;
    totalAmount?: number;
    payExpiresAt?: Date | null;
  }): Promise<{ id: string; orderNo: string; totalAmount: number }> {
    const totalAmount = opts.totalAmount ?? 10000;
    return platform(async () => {
      const created = await prisma.order.create({
        data: {
          tenantId: opts.tenantId,
          orderNo: `comp-${unique()}`,
          status: OrderStatus.PENDING_PAYMENT,
          totalAmount,
          itemCount: 1,
          receiverName: '测试',
          receiverPhone: '13800000000',
          province: '浙江省',
          city: '杭州市',
          district: '西湖区',
          detail: '文一西路 100 号',
          payExpiresAt: opts.payExpiresAt ?? null,
        },
      });
      return {
        id: created.id,
        orderNo: created.orderNo,
        totalAmount: created.totalAmount,
      };
    });
  }

  /** 造一条「未处理完」的事件行（processedAt 留 null） */
  async function makeUnprocessedEvent(opts: {
    eventId: string;
    referenceNo: string;
    amount: number;
    createdAt?: Date;
  }): Promise<void> {
    await platform(async () => {
      await prisma.paymentWebhookEvent.create({
        data: {
          provider: 'fake',
          eventId: opts.eventId,
          providerTxnId: `txn-${opts.eventId}`,
          kind: PaymentKind.ORDER,
          payload: {
            channel: 'fake',
            referenceNo: opts.referenceNo,
            amount: opts.amount,
            success: true,
          },
          createdAt: opts.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
        },
      });
    });
  }

  /** 从种子里找一个租户 */
  async function anyTenant(): Promise<string> {
    return platform(async () => {
      const stores = await prisma.store.findMany({ take: 1 });
      if (!stores[0]) throw new Error('没有可用的店铺（种子数据缺失）');
      return stores[0].id;
    });
  }

  it('扫描 A：未处理完的事件被重新入队（jobId 带轮次标记）', async () => {
    const tenantId = await anyTenant();
    const order = await makeOrder({ tenantId });
    await makeUnprocessedEvent({
      eventId: 'comp-a-1',
      referenceNo: order.orderNo,
      amount: order.totalAmount,
    });

    const result = await platform(() => compensation.retryUnprocessedEvents());
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const jobs = await webhookQueue.getJobs(['waiting', 'delayed']);
    const ours = jobs.filter((j) => j.id?.includes('comp-a-1'));
    expect(ours.length).toBeGreaterThanOrEqual(1);
    expect(ours[0].id).toContain('-comp-');
  });

  it('扫描 A：金额不符的事件不被重投', async () => {
    const tenantId = await anyTenant();
    const order = await makeOrder({ tenantId });
    await makeUnprocessedEvent({
      eventId: 'comp-a-bad',
      referenceNo: order.orderNo,
      amount: 1,
    });
    const result = await platform(() => compensation.retryUnprocessedEvents());
    expect(result.rejected).toBeGreaterThanOrEqual(1);
    const jobs = await webhookQueue.getJobs(['waiting', 'delayed']);
    const ours = jobs.filter((j) => j.id?.includes('comp-a-bad'));
    expect(ours.length).toBe(0);
  });

  it('扫描 A：刚落库（不够老）的事件不被扫到', async () => {
    const tenantId = await anyTenant();
    const order = await makeOrder({ tenantId });
    await makeUnprocessedEvent({
      eventId: 'comp-a-fresh',
      referenceNo: order.orderNo,
      amount: order.totalAmount,
      createdAt: new Date(),
    });
    await platform(() => compensation.retryUnprocessedEvents());
    const jobs = await webhookQueue.getJobs(['waiting', 'delayed']);
    const ours = jobs.filter((j) => j.id?.includes('comp-a-fresh'));
    expect(ours.length).toBe(0);
  });

  it('扫描 A：同一个事件用不同轮次的 jobId 能重复入队（不被 BullMQ 静默忽略）', async () => {
    const tenantId = await anyTenant();
    const order = await makeOrder({ tenantId });
    await makeUnprocessedEvent({
      eventId: 'comp-a-twice',
      referenceNo: order.orderNo,
      amount: order.totalAmount,
    });

    // ⚠️ **不能靠「扫两轮」来验这件事**：第一轮重投后 worker 就把事件消费掉了，
    //    `processedAt` 被置上 → 第二轮**本来就不该**再扫到它。
    //    要验的是「BullMQ 不会按 jobId 静默忽略补偿 job」，
    //    所以直接验「同一个事件、两个不同 jobId → 两个 job 都在」。
    //
    // ⚠️ **用 `getJob` 查而不是 `getJobs` 扫队列**：worker 消费得很快，
    //    job 会从 waiting/delayed 移走（但 hash 还在，`removeOnComplete` 默认 false）
    //    → 扫队列会不稳定。
    const event = {
      provider: 'fake',
      channel: 'fake',
      eventId: 'comp-a-twice',
      providerTxnId: 'txn-comp-a-twice',
      referenceNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    };
    await platform(() =>
      payments.enqueueWebhookEvent(
        event,
        tenantId,
        PaymentKind.ORDER,
        '-comp-round1',
      ),
    );
    await platform(() =>
      payments.enqueueWebhookEvent(
        event,
        tenantId,
        PaymentKind.ORDER,
        '-comp-round2',
      ),
    );

    const first = await webhookQueue.getJob(
      'webhook-fake-comp-a-twice-comp-round1',
    );
    const second = await webhookQueue.getJob(
      'webhook-fake-comp-a-twice-comp-round2',
    );
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    // ⚠️ **两个 jobId 必须不同** —— 相同的话第二个会被 BullMQ 静默忽略
    expect(first!.id).not.toBe(second!.id);
  });

  it('扫描 B：已过支付期限仍待支付的订单被释放', async () => {
    const tenantId = await anyTenant();
    const order = await makeOrder({
      tenantId,
      payExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const result = await platform(() => compensation.releaseStuckOrders());
    expect(result.released).toBeGreaterThanOrEqual(1);
    const after = await platform(async () => {
      const rows = await prisma.order.findMany({ where: { id: order.id } });
      return rows[0];
    });
    expect(after.status).toBe(OrderStatus.CLOSED);
  });

  it('扫描 B：还在支付期限内的订单不被释放', async () => {
    const tenantId = await anyTenant();
    const order = await makeOrder({
      tenantId,
      payExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await platform(() => compensation.releaseStuckOrders());
    const after = await platform(async () => {
      const rows = await prisma.order.findMany({ where: { id: order.id } });
      return rows[0];
    });
    expect(after.status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});
