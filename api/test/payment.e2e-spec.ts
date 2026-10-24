import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { PaymentService } from '../src/modules/payment/payment.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { assertSecureConfig } from '../src/common/config/assert-secure-config';
import { PAYMENT_WEBHOOK_QUEUE } from '../src/common/queue/queue.constants';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 支付抽象、本地假网关与 webhook 的 e2e（阶段 3 Task 5）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 11：webhook 验签后才落库（R1）
 * - 护栏 12：webhook 幂等（R2）
 * - 护栏 13：webhook 金额核对（R13）
 * - 护栏 14：webhook 不采信 tenantId（R14）
 * - 护栏 16：假网关生产拒绝启动（R3）
 * - 护栏 10：状态流转用条件更新（R5 的支付侧）
 * - 护栏 17：退款不回补库存
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface TokenBody {
  accessToken: string;
  user: { id: string; email: string; role: string; tenantId: string | null };
}

interface OrderBody {
  id: string;
  orderNo: string;
  customerId: string | null;
  status: string;
  totalAmount: number;
  itemCount: number;
  items: Array<{ skuId: string; quantity: number; unitPrice: number }>;
}

interface PayBody {
  paymentId: string;
  orderNo: string;
  amount: number;
  channel: string;
  provider: string;
  status: string;
  payUrl: string;
}

interface PaymentRow {
  id: string;
  status: string;
  amount: number;
  providerTxnId: string | null;
  channel: string;
  provider: string;
}

interface MovementRow {
  type: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  orderId: string | null;
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function orderBody(response: { body: unknown }): OrderBody {
  return response.body as OrderBody;
}

function payBody(response: { body: unknown }): PayBody {
  return response.body as PayBody;
}

/** 假网关的共享密钥。测试里显式设置，确保与实现读到的是同一个值。 */
const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';

/** 假网关的渠道名 */
const FAKE_CHANNEL = 'fake';

/** 假网关的 provider 名 */
const FAKE_PROVIDER = 'fake';

describe('支付与 webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let paymentService: PaymentService;
  let webhookQueue: Queue;

  beforeAll(async () => {
    // ⚠️ 假网关的开关与密钥必须在 AppModule 加载**之前**设好：
    // BullModule.forRoot 与 provider 的构造都在模块求值时发生。
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // ⚠️ `rawBody: true`：webhook 端点要拿**原始字节**验签。
    // 默认的 JSON body parser 会把请求流消费掉，那时拿不到了。
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
    paymentService = app.get(PaymentService);
    webhookQueue = app.get(getQueueToken(PAYMENT_WEBHOOK_QUEUE));
  });

  afterAll(async () => {
    await app.close();
    delete process.env.FAKE_PAYMENT_ENABLED;
    delete process.env.FAKE_PAYMENT_SECRET;
  });

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  // ============================================================
  // 夹具
  // ============================================================

  /** 造一个已上架、已定价的商品，返回它的 SKU id */
  async function publishSku(
    token: string,
    name: string,
    price = 1000,
  ): Promise<string> {
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send({ name, slug: `p-${unique()}` })
      .expect(201);
    const productId = (created.body as { id: string }).id;

    const matrix = await http(app)
      .put(`/api/v1/catalog/products/${productId}/specs`)
      .set('authorization', `Bearer ${token}`)
      .send({
        version: 1,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);
    const skuId = (matrix.body as { skus: Array<{ id: string }> }).skus[0].id;

    await http(app)
      .patch(`/api/v1/catalog/products/${productId}/skus/${skuId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ price })
      .expect(200);

    await http(app)
      .patch(`/api/v1/catalog/products/${productId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    return skuId;
  }

  async function stockIn(
    token: string,
    skuId: string,
    quantity: number,
  ): Promise<void> {
    await http(app)
      .post('/api/v1/inventory/adjustments')
      .set('authorization', `Bearer ${token}`)
      .send({ skuId, type: 'ADJUST_IN', quantity })
      .expect(201);
  }

  async function registerCustomer(
    subdomain: string,
  ): Promise<{ token: string; userId: string }> {
    const response = await http(app)
      .post('/api/v1/auth/register/customer')
      .set('x-tenant-subdomain', subdomain)
      .send({
        email: `customer-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '测试顾客',
      })
      .expect(201);
    const body = tokenBody(response);
    return { token: body.accessToken, userId: body.user.id };
  }

  async function createAddress(token: string): Promise<string> {
    const created = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${token}`)
      .send({
        receiver: '张三',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      })
      .expect(201);
    return (created.body as { id: string }).id;
  }

  /** 下单 */
  function placeOrder(
    token: string,
    payload: {
      addressId: string;
      items: Array<{ skuId: string; quantity: number }>;
    },
  ) {
    return http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${token}`)
      .send(payload);
  }

  /** 下单 + 发起支付，返回订单与支付单 */
  async function placeAndPay(
    merchantToken: string,
    customerToken: string,
    addressId: string,
    skuId: string,
    quantity = 1,
  ): Promise<{ order: OrderBody; payment: PayBody }> {
    const placed = await placeOrder(customerToken, {
      addressId,
      items: [{ skuId, quantity }],
    }).expect(201);
    const order = orderBody(placed);
    const paid = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customerToken}`)
      .expect(201);
    return { order, payment: payBody(paid) };
  }

  /** 读某个 SKU 当前的库存 */
  async function readStock(tenantId: string, skuId: string): Promise<number> {
    return asTenant(tenantId, async () => {
      const sku = await prisma.sku.findFirst({ where: { id: skuId } });
      return sku?.stock ?? -1;
    });
  }

  /** 读某个 SKU 的全部流水 */
  async function readMovements(
    tenantId: string,
    skuId: string,
  ): Promise<MovementRow[]> {
    return asTenant(tenantId, () =>
      prisma.inventoryMovement.findMany({
        where: { skuId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** 读订单（按订单号） */
  async function readOrder(
    tenantId: string,
    orderNo: string,
  ): Promise<OrderBody> {
    return asTenant(tenantId, async () => {
      const rows = await prisma.order.findMany({
        where: { orderNo },
        include: { items: true },
      });
      return rows[0];
    });
  }

  /** 读某订单的支付单 */
  async function readPayments(
    tenantId: string,
    orderId: string,
  ): Promise<PaymentRow[]> {
    return asTenant(tenantId, () =>
      prisma.payment.findMany({ where: { orderId } }),
    );
  }

  /** 读全部 webhook 事件行（这张表不带 tenantId，不受租户扩展影响） */
  async function readWebhookEvents(): Promise<
    Array<{ provider: string; eventId: string; processedAt: Date | null }>
  > {
    return prisma.paymentWebhookEvent.findMany();
  }

  /**
   * 数队列里某个 eventId 排了多少个任务。
   *
   * ⚠️ 这是「幂等闸」的可观测面：重复投递若过了闸，就会多排一个任务。
   * 只断言「事件表只有一行」是不够的——去掉闸门时事件表仍只有一行
   * （第一次插入成功，后两次撞唯一索引）。
   */
  async function countWebhookJobs(eventId: string): Promise<number> {
    const jobs = await webhookQueue.getJobs([
      'waiting',
      'active',
      'completed',
      'delayed',
      'failed',
    ]);
    return jobs.filter(
      (job) => (job.data as { eventId?: string }).eventId === eventId,
    ).length;
  }

  /**
   * 构造一个签过名的假网关回调体。
   *
   * ⚠️ **签名覆盖整个原始 body**（HMAC-SHA256，hex）。真实渠道也是对原始
   * 字节签名，所以「验签」验的是**原始字节**，不是解析后的字段——
   * 否则攻击者可以先改字段再重新算一个自洽的签名。
   */
  function signFakeWebhook(payload: Record<string, unknown>): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', FAKE_SECRET)
      .update(body)
      .digest('hex');
    return { body, signature };
  }

  /** 发一个假网关回调 */
  function postFakeWebhook(
    payload: Record<string, unknown>,
    options: { signature?: string | null } = {},
  ) {
    const { body, signature } = signFakeWebhook(payload);
    const request = http(app)
      .post(`/api/v1/webhooks/payment/${FAKE_CHANNEL}`)
      .set('content-type', 'application/json');
    const used =
      options.signature === undefined ? signature : options.signature;
    if (used !== null) {
      request.set('x-fake-signature', used);
    }
    return request.send(body);
  }

  /** 等队列里的 webhook 任务被消费完（轮询订单状态） */
  async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  // ============================================================
  // 发起支付
  // ============================================================

  it('发起支付：建支付单、金额取自订单、返回支付页面 URL', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '要支付的商品', 1500);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const order = orderBody(placed);

    const response = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(201);
    const payment = payBody(response);

    // ⚠️ **金额只从订单读**：1500 × 2 = 3000
    expect(payment.amount).toBe(3000);
    expect(payment.orderNo).toBe(order.orderNo);
    expect(payment.channel).toBe(FAKE_CHANNEL);
    expect(payment.provider).toBe(FAKE_PROVIDER);
    expect(payment.status).toBe('PENDING');
    // 支付页面 URL 指向假网关的页面端点
    expect(payment.payUrl).toContain(`/pay/fake/${payment.paymentId}`);

    // 查库确认支付单落库且金额一致
    const rows = await readPayments(merchant.tenantId, order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(3000);
    expect(rows[0].status).toBe('PENDING');
  });

  it('发起支付：请求体里带金额被拒（金额不可篡改）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '金额不可篡改', 1500);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const order = orderBody(placed);

    const response = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`)
      .send({ amount: 1 });
    expect(response.status).toBe(400);

    // 没有支付单落库
    const rows = await readPayments(merchant.tenantId, order.id);
    expect(rows).toHaveLength(0);
  });

  it('发起支付：必须登录', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '未登录不能支付', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const order = orderBody(placed);

    const response = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('x-tenant-subdomain', merchant.subdomain);
    expect(response.status).toBe(401);
  });

  it('发起支付：同一个订单同一渠道只能有一笔支付单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重复支付的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const order = orderBody(placed);

    const first = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(201);
    const second = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(201);

    // 两次返回**同一笔**支付单
    expect(payBody(second).paymentId).toBe(payBody(first).paymentId);

    // ⚠️ 查库确认只有一行
    const rows = await readPayments(merchant.tenantId, order.id);
    expect(rows).toHaveLength(1);
  });

  it('发起支付：订单不是 PENDING_PAYMENT 时被拒', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '已取消的订单', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const order = orderBody(placed);

    await http(app)
      .post(`/api/v1/orders/${order.orderNo}/cancel`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);

    const response = await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  // ============================================================
  // 护栏 11：验签后才落库（R1）
  // ============================================================

  it('未验签的 webhook 不会落库：伪造 eventId 占位后再来真的会被忽略', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '验签的订单', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    const eventId = `evt-${unique()}`;
    const payload = {
      eventId,
      providerTxnId: payment.paymentId,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    };

    // ---- 第一步：签名错误的请求（攻击者抢先占位）----
    const forged = await postFakeWebhook(payload, { signature: 'deadbeef' });
    expect(forged.status).toBe(401);

    // ⚠️ **关键断言**：库里不能有这一行。
    // 「先落库再验签」的实现会让这里有一行，
    // 于是后面真实的回调会被当成重复事件忽略——钱付了订单永不流转。
    const afterForged = await readWebhookEvents();
    expect(afterForged.filter((e) => e.eventId === eventId)).toHaveLength(0);

    // ---- 第二步：签名正确的请求（真实回调）----
    const genuine = await postFakeWebhook(payload);
    expect(genuine.status).toBe(200);

    // 此时应该**只有一行**（真实回调落的那行）
    const afterGenuine = await readWebhookEvents();
    expect(afterGenuine.filter((e) => e.eventId === eventId)).toHaveLength(1);

    // ---- 第三步：订单真的流转到 PAID ----
    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);
  });

  it('webhook 验签失败返回 401，且不写任何业务数据', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '签名错的订单', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    const response = await postFakeWebhook(
      {
        eventId: `evt-${unique()}`,
        providerTxnId: payment.paymentId,
        orderNo: order.orderNo,
        amount: order.totalAmount,
        success: true,
      },
      { signature: 'not-the-right-signature' },
    );
    expect(response.status).toBe(401);

    // 订单没被流转
    const rows = await readOrder(merchant.tenantId, order.orderNo);
    expect(rows.status).toBe('PENDING_PAYMENT');

    // 支付单还是 PENDING
    const payments = await readPayments(merchant.tenantId, order.id);
    expect(payments[0].status).toBe('PENDING');
  });

  it('webhook 缺少签名头返回 401', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '没签名的订单', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    const response = await postFakeWebhook(
      {
        eventId: `evt-${unique()}`,
        providerTxnId: payment.paymentId,
        orderNo: order.orderNo,
        amount: order.totalAmount,
        success: true,
      },
      { signature: null },
    );
    expect(response.status).toBe(401);

    const rows = await readOrder(merchant.tenantId, order.orderNo);
    expect(rows.status).toBe('PENDING_PAYMENT');
  });

  // ============================================================
  // 护栏 12：幂等（R2）
  // ============================================================

  it('同一事件重复到达只处理一次', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重复事件的订单', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
      2,
    );

    const eventId = `evt-${unique()}`;
    const payload = {
      eventId,
      providerTxnId: payment.paymentId,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    };

    // 第一次投递
    const first = await postFakeWebhook(payload);
    expect(first.status).toBe(200);
    expect(
      (first.body as { received: boolean; processed: boolean }).processed,
    ).toBe(true);

    // ⚠️ **等它处理完**再投重复的：事件行被打上 `processedAt` 之后，
    // 重复投递才真的被幂等闸挡下。
    //
    // 不等的话，第二次投递会看到「上次还没处理完」而**允许重试**——
    // 那是刻意的（否则一次瞬时故障就永久丢单：这笔支付再也不会被处理，
    // 而没人会去扫那张表找未处理的事件）。但那样这条断言就测不到
    // 「已处理的重复投递被挡下」这一档。
    const processed = await waitFor(async () => {
      const rows = await readWebhookEvents();
      const row = rows.find((e) => e.eventId === eventId);
      return row?.processedAt != null;
    });
    expect(processed).toBe(true);

    // 后两次是重复投递——必须在「落库 + 校验唯一键」那道闸就被挡下来
    const second = await postFakeWebhook(payload);
    expect(second.status).toBe(200);
    expect(
      (second.body as { received: boolean; processed: boolean }).processed,
    ).toBe(false);

    const third = await postFakeWebhook(payload);
    expect(third.status).toBe(200);
    expect(
      (third.body as { received: boolean; processed: boolean }).processed,
    ).toBe(false);

    // ⚠️ 事件表里只有一行
    const events = await readWebhookEvents();
    expect(events.filter((e) => e.eventId === eventId)).toHaveLength(1);

    // ⚠️ **只排了一个任务**——重复投递在闸门处就被挡住了，没有进队列。
    await waitFor(async () => (await countWebhookJobs(eventId)) >= 1);
    expect(await countWebhookJobs(eventId)).toBe(1);

    // ⚠️ 订单流转到 PAID，且**只记一条 DEDUCT 流水**
    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    const movements = await readMovements(merchant.tenantId, skuId);
    const deducts = movements.filter((m) => m.type === 'DEDUCT');
    expect(deducts).toHaveLength(1);
    expect(deducts[0].quantity).toBe(-2);
  });

  it('同一笔渠道交易打到两个订单：第二个订单不能被流转', async () => {
    // ⚠️ **这是 R2 真正的场景**：**不同的订单**，同一笔渠道交易。
    //
    // 事件表的 `(provider, eventId)` 唯一索引挡不住（eventId 不同），
    // 只能靠 `payments` 的 `(provider, providerTxnId)` 唯一索引与冲突检查。
    //
    // 不挡的后果有两种，都很糟：
    // 1. 第二个订单也转 PAID → **用户付一次钱，商家要发两次货**
    // 2. 让它以异常形式冒泡 → P2002 abort 整个事务，而队列默认不重试、
    //    webhook 早已返回 200 → **用户付了钱、订单永远卡在 PENDING_PAYMENT、
    //    库存永远被预占**
    const merchant = await createMerchant(app, prisma);
    const skuA = await publishSku(merchant.token, '串单的商品甲', 1000);
    const skuB = await publishSku(merchant.token, '串单的商品乙', 1000);
    await stockIn(merchant.token, skuA, 10);
    await stockIn(merchant.token, skuB, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const first = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuA,
    );
    const second = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuB,
    );

    const providerTxnId = `txn-${unique()}`;

    // 同一笔渠道交易，分别打到两个订单上
    for (const order of [first.order, second.order]) {
      const response = await postFakeWebhook({
        eventId: `evt-${unique()}`,
        providerTxnId,
        orderNo: order.orderNo,
        amount: order.totalAmount,
        success: true,
      });
      // ⚠️ **不能是 500**：异常一旦冒泡，事务 abort、订单不流转、
      // 而队列默认不重试、渠道也不会再投——那笔支付就永久丢了。
      expect(response.status).toBe(200);
    }

    // 第一个订单正常流转
    const firstPaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, first.order.orderNo);
      return rows.status === 'PAID';
    });
    expect(firstPaid).toBe(true);

    // ⚠️ 第二个订单**不能**跟着流转：那是同一笔渠道交易
    const secondRows = await readOrder(merchant.tenantId, second.order.orderNo);
    expect(secondRows.status).toBe('PENDING_PAYMENT');

    // 第二个订单的预占还在（没被错误地释放，也没被错误地确认售出）
    const movementsB = await readMovements(merchant.tenantId, skuB);
    expect(movementsB.filter((m) => m.type === 'DEDUCT')).toHaveLength(0);
    expect(movementsB.filter((m) => m.type === 'RESERVE')).toHaveLength(1);
  });

  it('同一笔渠道交易不会落成两条支付单（不同 eventId 重放）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重放交易的订单', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    const providerTxnId = `txn-${unique()}`;

    // ⚠️ **两个不同的 eventId**，带着**同一个 providerTxnId**——
    // 事件表的唯一索引挡不住，第 1 道防线失效。
    for (let i = 0; i < 2; i++) {
      const response = await postFakeWebhook({
        eventId: `evt-${unique()}`,
        providerTxnId,
        orderNo: order.orderNo,
        amount: order.totalAmount,
        success: true,
      });
      expect(response.status).toBe(200);
    }

    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    // ⚠️ 断言**行数**，不能只看响应状态码：
    // 同一笔渠道交易只能有一笔支付单。
    const rows = await readPayments(merchant.tenantId, order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerTxnId).toBe(providerTxnId);
  });

  // ============================================================
  // 护栏 13：金额核对（R13）
  // ============================================================

  it('支付金额与订单金额不一致时拒绝流转并告警', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '金额核对的订单', 10000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );
    expect(order.totalAmount).toBe(10000);

    // 回调金额只有 1 分
    const response = await postFakeWebhook({
      eventId: `evt-${unique()}`,
      providerTxnId: `txn-${unique()}`,
      orderNo: order.orderNo,
      amount: 1,
      success: true,
    });
    // 渠道回调本身是「收到了」的语义，回一个 200（不该让渠道无限重试），
    // 但**订单不流转**——这才是要害。
    expect(response.status).toBe(200);

    // ⚠️ 关键断言：订单**没有**转 PAID
    await new Promise((resolve) => setTimeout(resolve, 500));
    const rows = await readOrder(merchant.tenantId, order.orderNo);
    expect(rows.status).toBe('PENDING_PAYMENT');

    // 支付单也没转 SUCCESS
    const payments = await readPayments(merchant.tenantId, order.id);
    expect(payments[0].status).toBe('PENDING');

    // 库存没被确认售出
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'DEDUCT')).toHaveLength(0);
  });

  // ============================================================
  // 护栏 14：不采信 tenantId（R14）
  // ============================================================

  it('webhook 不采信请求体里的 tenantId', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuOfA = await publishSku(a.token, 'A 店的商品', 1000);
    await stockIn(a.token, skuOfA, 10);
    const customerOfA = await registerCustomer(a.subdomain);
    const addressOfA = await createAddress(customerOfA.token);

    const placed = await placeOrder(customerOfA.token, {
      addressId: addressOfA,
      items: [{ skuId: skuOfA, quantity: 1 }],
    }).expect(201);
    const order = orderBody(placed);

    await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customerOfA.token}`)
      .expect(201);

    // ⚠️ 请求体里**伪造** tenantId = B 店的租户
    const response = await postFakeWebhook({
      eventId: `evt-${unique()}`,
      providerTxnId: `txn-${unique()}`,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
      tenantId: b.tenantId,
    });
    expect(response.status).toBe(200);

    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(a.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    // ⚠️ **A 店的订单**转 PAID —— 租户是从订单反查的，
    // 不是从请求体里采信的。
    const orderInB = await asTenant(b.tenantId, async () => {
      const rows = await prisma.order.findMany({
        where: { orderNo: order.orderNo },
      });
      return rows;
    });
    expect(orderInB).toHaveLength(0);
  });

  it('webhook 消费端在错误的租户作用域里跑：订单转不动', async () => {
    // ⚠️ **这条是护栏 14 的真正的那条用例。**
    //
    // 上一条（"webhook 不采信请求体里的 tenantId"）守的是**入口**：
    // 请求体里伪造的 tenantId 不影响结果。但它守不住消费端——
    // 队列任务里的 tenantId 是**后端签发的**，入口那条用例碰不到它。
    //
    // 消费端的防线是：**在错误的租户作用域里，查不到订单、也改不动订单**。
    // 租户扩展的 `tenantId` 过滤 + 条件更新，两处一起把这个洞堵上。
    //
    // ⚠️ **为什么必须单独一条**：把消费端改成「按订单自己的租户流转」
    // （也就是不采信任务里的 tenantId，而是自己再反查一次）之后，
    // 上一条用例照样通过——因为入口的行为根本没变。
    // 只有这条能打中它。
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuId = await publishSku(a.token, 'A 店的商品', 1000);
    await stockIn(a.token, skuId, 10);
    const customer = await registerCustomer(a.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
    }).expect(201);
    const order = orderBody(placed);

    await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(201);

    const event = {
      provider: FAKE_PROVIDER,
      channel: FAKE_CHANNEL,
      eventId: `evt-${unique()}`,
      providerTxnId: `txn-${unique()}`,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    };

    // ⚠️ **用 B 店（错误的租户）跑一遍消费逻辑**。
    // 订单在 A 店，B 店的作用域里查不到它，也改不动它。
    await paymentService.applyEvent(event, b.tenantId);

    const rows = await readOrder(a.tenantId, order.orderNo);
    expect(rows.status).toBe('PENDING_PAYMENT');

    // ⚠️ **库存没被确认售出**：没有 DEDUCT 流水。
    const movements = await readMovements(a.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'DEDUCT')).toHaveLength(0);
    expect(await readStock(a.tenantId, skuId)).toBe(9);

    // ⚠️ **再用正确的租户跑一遍**：这次必须能流转。
    // 没有这一段，这条用例就只是「什么都没发生」的断言——
    // 消费端整个坏掉时它也会通过。
    await paymentService.applyEvent(event, a.tenantId);

    const after = await readOrder(a.tenantId, order.orderNo);
    expect(after.status).toBe('PAID');
    const afterMovements = await readMovements(a.tenantId, skuId);
    expect(afterMovements.filter((m) => m.type === 'DEDUCT')).toHaveLength(1);
  });

  // ============================================================
  // 支付成功：订单转 PAID + DEDUCT 流水 + 库存不变
  // ============================================================

  it('支付成功：订单转 PAID、流水记 DEDUCT、库存不再变', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '支付成功的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
      2,
    );

    // 下单预占后库存是 8
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);

    const response = await postFakeWebhook({
      eventId: `evt-${unique()}`,
      providerTxnId: payment.paymentId,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    });
    expect(response.status).toBe(200);

    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    // ⚠️ DEDUCT 流水：quantity = -qty 但 **stock 不变**
    // （预占时已经扣过了，这里只是把「预占」转成「已售」）
    const movements = await readMovements(merchant.tenantId, skuId);
    const deducts = movements.filter((m) => m.type === 'DEDUCT');
    expect(deducts).toHaveLength(1);
    expect(deducts[0].quantity).toBe(-2);
    expect(deducts[0].stockBefore).toBe(deducts[0].stockAfter);

    // 库存仍然是 8（没有二次扣减）
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);

    // 支付单转 SUCCESS
    const payments = await readPayments(merchant.tenantId, order.id);
    expect(payments[0].status).toBe('SUCCESS');
  });

  // ============================================================
  // 假网关的支付页面
  // ============================================================

  it('假网关的支付页面：渲染订单号与金额，点了「确认支付」订单转 PAID', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '假网关的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
      3,
    );

    // 页面无需登录
    const page = await http(app)
      .get(`/api/v1/pay/fake/${payment.paymentId}`)
      .expect(200);
    expect(page.text).toContain(order.orderNo);
    expect(page.text).toContain('3000');

    // 点「确认支付」
    const confirm = await http(app)
      .post(`/api/v1/pay/fake/${payment.paymentId}/confirm`)
      .expect(200);
    expect(confirm.status).toBe(200);

    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    const movements = await readMovements(merchant.tenantId, skuId);
    const deducts = movements.filter((m) => m.type === 'DEDUCT');
    expect(deducts).toHaveLength(1);
    expect(deducts[0].quantity).toBe(-3);
  });

  it('假网关的支付页面：「模拟支付失败」订单不流转', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '假失败的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    await http(app)
      .post(`/api/v1/pay/fake/${payment.paymentId}/fail`)
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const rows = await readOrder(merchant.tenantId, order.orderNo);
    expect(rows.status).toBe('PENDING_PAYMENT');

    // 支付单转 FAILED
    const payments = await readPayments(merchant.tenantId, order.id);
    expect(payments[0].status).toBe('FAILED');
  });

  // ============================================================
  // 退款
  // ============================================================

  it('退款不回补库存：货已发出，退的是钱不是库存', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退款的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order, payment } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
      2,
    );

    // 支付成功
    await postFakeWebhook({
      eventId: `evt-${unique()}`,
      providerTxnId: payment.paymentId,
      orderNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    });
    const becamePaid = await waitFor(async () => {
      const rows = await readOrder(merchant.tenantId, order.orderNo);
      return rows.status === 'PAID';
    });
    expect(becamePaid).toBe(true);

    // 发货
    await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/ship`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ trackingNo: 'SF123456' })
      .expect(201);

    const stockBefore = await readStock(merchant.tenantId, skuId);
    expect(stockBefore).toBe(8);

    // 退款
    await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: '客户不想要了' })
      .expect(201);

    // ⚠️ 订单转 REFUNDED
    const rows = await readOrder(merchant.tenantId, order.orderNo);
    expect(rows.status).toBe('REFUNDED');

    // ⚠️ 支付单转 REFUNDED
    const payments = await readPayments(merchant.tenantId, order.id);
    expect(payments[0].status).toBe('REFUNDED');

    // ⚠️ **关键断言**：库存与退款前**完全相同**，且不得出现 RELEASE 流水
    expect(await readStock(merchant.tenantId, skuId)).toBe(stockBefore);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
  });

  it('退款：只有店主能退', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '退款权限的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    // 消费者不能退款
    const response = await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${customer.token}`)
      .send({ reason: '我要退款' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('退款：未支付的订单不能退', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '没付款就退款', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const { order } = await placeAndPay(
      merchant.token,
      customer.token,
      addressId,
      skuId,
    );

    const response = await http(app)
      .post(`/api/v1/merchant/orders/${order.orderNo}/refund`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ reason: '测试' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  // ============================================================
  // 护栏 16：假网关生产禁用（R3）
  // ============================================================

  it('生产配置下假支付网关不可用', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousEnabled = process.env.FAKE_PAYMENT_ENABLED;
    const previousSecret = process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    // ⚠️ 换成**非占位符**的密钥：否则会先撞上「JWT_SECRET 是占位符」那条断言，
    // 测不到假网关这一条。
    process.env.JWT_SECRET = 'a-real-secret-for-this-assertion-only-32ch';

    try {
      expect(() => assertSecureConfig()).toThrow(/FAKE_PAYMENT_ENABLED/);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousEnabled === undefined) {
        delete process.env.FAKE_PAYMENT_ENABLED;
      } else {
        process.env.FAKE_PAYMENT_ENABLED = previousEnabled;
      }
      if (previousSecret === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = previousSecret;
      }
    }
  });

  it('未开启 FAKE_PAYMENT_ENABLED 时假网关端点 404', async () => {
    const previous = process.env.FAKE_PAYMENT_ENABLED;
    delete process.env.FAKE_PAYMENT_ENABLED;

    try {
      const response = await http(app).get('/api/v1/pay/fake/whatever-id');
      expect(response.status).toBe(404);
    } finally {
      process.env.FAKE_PAYMENT_ENABLED = previous;
    }
  });
});
