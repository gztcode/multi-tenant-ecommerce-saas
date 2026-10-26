import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import type { OrderTimeoutJob } from '../src/modules/order/order-timeout.service';
import { OrderTimeoutWorker } from '../src/modules/order/order-timeout.worker';
import { PaymentService } from '../src/modules/payment/payment.service';
import { PAYMENT_TIMEOUT_QUEUE } from '../src/common/queue/queue.constants';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/** 假网关的共享密钥。测试里显式设置，确保与实现读到的是同一个值。 */
const FAKE_SECRET = 'test-fake-payment-secret-at-least-16-chars';

/**
 * 支付超时释放的 e2e（阶段 3 Task 6）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 10 / R5：状态流转用**条件更新**，并发下只有一个赢家
 * - 护栏 18 / R15：jobId 去重 + **消费端幂等**
 * - 护栏 15：条件更新与释放预占必须同生共死（原子性）
 *
 * ## 断言一律查库
 *
 * 「库存只被加回一次」不能只看响应状态码——必须查 `skus.stock`
 * 与 `inventory_movements` 里 RELEASE 流水行数。
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface OrderBody {
  id: string;
  orderNo: string;
  status: string;
  totalAmount: number;
  itemCount: number;
}

interface MovementRow {
  type: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  orderId: string | null;
}

interface OrderRow {
  id: string;
  orderNo: string;
  status: string;
  payExpiresAt: Date | null;
  closedAt: Date | null;
}

function orderBody(response: { body: unknown }): OrderBody {
  return response.body as OrderBody;
}

describe('支付超时释放 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let paymentService: PaymentService;
  let timeoutWorker: OrderTimeoutWorker;
  let timeoutQueue: Queue;

  beforeAll(async () => {
    // ⚠️ 假网关的开关与密钥必须在 AppModule 加载**之前**设好：
    // BullModule.forRoot 与 provider 的构造都在模块求值时发生。
    process.env.FAKE_PAYMENT_ENABLED = 'true';
    process.env.FAKE_PAYMENT_SECRET = FAKE_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
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
    timeoutWorker = app.get(OrderTimeoutWorker);
    timeoutQueue = app.get(getQueueToken(PAYMENT_TIMEOUT_QUEUE));
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
    const body = response.body as { accessToken: string; user: { id: string } };
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
      idempotencyKey?: string;
    },
  ) {
    return http(app)
      .post('/api/v1/orders')
      .set('authorization', `Bearer ${token}`)
      .send(payload);
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

  /** 读订单 */
  async function readOrder(
    tenantId: string,
    orderNo: string,
  ): Promise<OrderRow> {
    return asTenant(tenantId, async () => {
      const rows = await prisma.order.findMany({ where: { orderNo } });
      return rows[0];
    });
  }

  /**
   * 把订单的支付期限改到**过去**。
   *
   * 队列的 delayed job 不保证准时，所以超时释放**不能**只看队列的调度：
   * 订单自己的 `payExpiresAt` 也要判。测试里不能真的等 15 分钟，
   * 所以直接把期限改到过去，模拟「时间到了」。
   */
  async function expireOrder(tenantId: string, orderNo: string): Promise<void> {
    await asTenant(tenantId, () =>
      prisma.order.updateMany({
        where: { orderNo },
        data: { payExpiresAt: new Date(Date.now() - 60_000) },
      }),
    );
  }

  /** 造一个 worker 任务（worker 只读 name 与 data） */
  function timeoutJob(tenantId: string, orderId: string): Job<OrderTimeoutJob> {
    return {
      id: `test-${unique()}`,
      name: 'release',
      data: { tenantId, orderId },
    } as unknown as Job<OrderTimeoutJob>;
  }

  /** 下单 + 让订单到期，返回订单与 SKU */
  async function placeExpiredOrder(options?: {
    quantity?: number;
    stock?: number;
  }): Promise<{
    merchant: Awaited<ReturnType<typeof createMerchant>>;
    customerToken: string;
    skuId: string;
    order: OrderBody;
    orderId: string;
  }> {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '会超时的商品', 1000);
    await stockIn(merchant.token, skuId, options?.stock ?? 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: options?.quantity ?? 2 }],
    }).expect(201);
    const order = orderBody(placed);

    const row = await readOrder(merchant.tenantId, order.orderNo);
    await expireOrder(merchant.tenantId, order.orderNo);

    return {
      merchant,
      customerToken: customer.token,
      skuId,
      order,
      orderId: row.id,
    };
  }

  // ============================================================
  // 用例
  // ============================================================

  it('超时未支付：释放预占、订单转 CLOSED', async () => {
    const { merchant, skuId, order, orderId } = await placeExpiredOrder({
      quantity: 2,
    });

    // 下单后库存被预占（扣掉 2）
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);

    await timeoutWorker.process(timeoutJob(merchant.tenantId, orderId));

    // 订单转 CLOSED
    const row = await readOrder(merchant.tenantId, order.orderNo);
    expect(row.status).toBe('CLOSED');
    expect(row.closedAt).not.toBeNull();

    // ⚠️ 查库确认库存被还回去了（10，不是 8）
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);

    // ⚠️ 记一条 RELEASE 流水（quantity = +qty）
    const movements = await readMovements(merchant.tenantId, skuId);
    const releases = movements.filter((m) => m.type === 'RELEASE');
    expect(releases).toHaveLength(1);
    expect(releases[0].quantity).toBe(2);
    expect(releases[0].orderId).toBe(orderId);
  });

  it('没到支付期限的超时任务不动订单、不动库存', async () => {
    // ⚠️ 队列的 delayed job **不保证准时**，所以超时释放必须自己判
    // 订单的 payExpiresAt——否则提前触发的任务会把还在支付窗口内的订单关掉。
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '还没到期的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 2 }],
    }).expect(201);
    const order = orderBody(placed);
    const row = await readOrder(merchant.tenantId, order.orderNo);

    // ⚠️ 期限还在未来（没改）
    expect(row.payExpiresAt).not.toBeNull();
    expect(row.payExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    await timeoutWorker.process(timeoutJob(merchant.tenantId, row.id));

    // 订单不动
    const after = await readOrder(merchant.tenantId, order.orderNo);
    expect(after.status).toBe('PENDING_PAYMENT');
    expect(after.closedAt).toBeNull();

    // 库存不动
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
  });

  it('已支付的订单超时释放时不动库存', async () => {
    const { merchant, skuId, order, orderId } = await placeExpiredOrder({
      quantity: 2,
    });

    // 直接把订单推进到 PAID（模拟支付回调已经赢了条件更新）
    await asTenant(merchant.tenantId, () =>
      prisma.order.updateMany({
        where: { orderNo: order.orderNo },
        data: { status: 'PAID', paidAt: new Date() },
      }),
    );

    await timeoutWorker.process(timeoutJob(merchant.tenantId, orderId));

    // ⚠️ 状态不变
    const row = await readOrder(merchant.tenantId, order.orderNo);
    expect(row.status).toBe('PAID');
    expect(row.closedAt).toBeNull();

    // ⚠️ 查库确认库存没被还回去
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
  });

  it('超时任务与支付回调并发：只有一个生效', async () => {
    const { merchant, customerToken, skuId, order, orderId } =
      await placeExpiredOrder({
        quantity: 2,
      });

    // ⚠️ 先建一笔支付单：支付回调的流转要靠它
    // （`applyEventInTx` 按 orderId + channel 找支付单，找不到就不流转订单）。
    await http(app)
      .post(`/api/v1/orders/${order.orderNo}/pay`)
      .set('authorization', `Bearer ${customerToken}`)
      .expect(201);

    // ⚠️ 支付侧走**真实的支付流转**（`PaymentService.applyEvent`）：
    // 它里面是「条件更新转 PAID + 记 DEDUCT 流水」两件事。
    //
    // 用真实的支付路径而不是直接调 `orderService.transition`，
    // 是因为超卖的形态需要两边都动库存才看得出来：
    // 超时释放把库存**加回**，支付回调把订单转 **PAID**——
    // 结果是「订单已支付，但货又能卖了」。
    // 支付侧不记 DEDUCT 流水的话，这个形态就退化成「订单状态对不对」，
    // 抓不到真正的失效。
    //
    // 两边都从 PENDING_PAYMENT 出发，一个想转 PAID、一个想转 CLOSED。
    // 「先查后改」的写法会让两个都读到 PENDING_PAYMENT 然后都往下走。
    // 条件更新（where 带 status）让数据库保证只有一方能赢。
    const event = {
      provider: 'fake',
      channel: 'fake',
      eventId: `evt-${unique()}`,
      providerTxnId: `txn-${unique()}`,
      referenceNo: order.orderNo,
      amount: order.totalAmount,
      success: true,
    };

    await Promise.all([
      timeoutWorker.process(timeoutJob(merchant.tenantId, orderId)),
      paymentService.applyEvent(event, merchant.tenantId),
    ]);

    // ⚠️ 查库确认库存**没有既被加回又被扣**：
    // 超卖的形态是「订单 PAID，但库存被还回去」。
    const row = await readOrder(merchant.tenantId, order.orderNo);
    const movements = await readMovements(merchant.tenantId, skuId);
    const releases = movements.filter((m) => m.type === 'RELEASE');
    const deducts = movements.filter((m) => m.type === 'DEDUCT');

    if (row.status === 'PAID') {
      // 支付赢了：库存保持预占后的 8，没有 RELEASE
      expect(await readStock(merchant.tenantId, skuId)).toBe(8);
      expect(releases).toHaveLength(0);
      expect(deducts).toHaveLength(1);
    } else {
      // 超时释放赢了：库存还回 10，没有 DEDUCT
      expect(row.status).toBe('CLOSED');
      expect(await readStock(merchant.tenantId, skuId)).toBe(10);
      expect(deducts).toHaveLength(0);
      expect(releases).toHaveLength(1);
    }

    // ⚠️ **关键断言**：RELEASE 与 DEDUCT 至多有一个。
    // 两个都有 = 库存既被还回去又被记成售出（超卖）。
    expect(releases.length + deducts.length).toBeLessThanOrEqual(1);
  });

  it('同一个订单只排一个超时任务', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '只排一个任务的商品', 1000);
    await stockIn(merchant.token, skuId, 10);
    const customer = await registerCustomer(merchant.subdomain);
    const addressId = await createAddress(customer.token);
    const idempotencyKey = unique();

    const placed = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
      idempotencyKey,
    }).expect(201);
    const order = orderBody(placed);
    const row = await readOrder(merchant.tenantId, order.orderNo);

    // ⚠️ 用**同一个幂等键**再下一次单：返回的是同一笔订单。
    // 幂等快路径在下单事务之前就返回了，不会再排任务。
    const again = await placeOrder(customer.token, {
      addressId,
      items: [{ skuId, quantity: 1 }],
      idempotencyKey,
    }).expect(201);
    expect(orderBody(again).orderNo).toBe(order.orderNo);

    // ⚠️ 再用同一个 jobId 手动投一次（模拟重复投递）
    await timeoutQueue.add(
      'release',
      { tenantId: merchant.tenantId, orderId: row.id },
      { jobId: `timeout-${row.id}`, delay: 15 * 60 * 1000 },
    );

    // 队列里这个订单只有**一个**超时任务
    const jobs = await timeoutQueue.getJobs([
      'waiting',
      'active',
      'completed',
      'delayed',
      'failed',
    ]);
    const forOrder = jobs.filter(
      (job) =>
        (job.data as { orderId?: string }).orderId === row.id ||
        job.id === `timeout-${row.id}`,
    );
    expect(forOrder).toHaveLength(1);

    // ⚠️ 任务里必须带 tenantId——消费端要靠它重建租户上下文，
    // 查不到租户就什么都做不了。
    expect((forOrder[0].data as { tenantId?: string }).tenantId).toBe(
      merchant.tenantId,
    );
  });

  it('超时释放是原子的：释放失败时订单状态不能已经变成 CLOSED', async () => {
    // ⚠️ **这条是护栏 10b（超时侧的条件更新）的真正的那条用例。**
    //
    // 失败注入验证时发现：把 `releaseExpiredOrderInTx` 里的条件更新
    // 退化成「先查后改」（先 findFirst 读状态，再无条件 update），
    // **连跑 8 次测试都抓不住**——并发交错的窗口太窄了。
    //
    // 原因：那 8 次跑依赖「支付回调与超时释放恰好撞在一起」，
    // 撞上的概率很低；不撞的时候，退化的实现表现得完全正常。
    //
    // 所以这条用例**不靠竞态**：它直接造一个「释放必然失败」的订单，
    // 让释放这一步**确定地**失败，从而稳定地抓住退化。
    //
    // 失效形态（分成两个事务时）：订单先转成 CLOSED，释放预占再失败
    // （预占量对不上、锁超时……）。而超时释放任务看到状态不是
    // PENDING_PAYMENT 也不会再管它——那批库存就**永久卡在预占里**，
    // 再也回不到可售库存。
    const { merchant, skuId, order, orderId } = await placeExpiredOrder({
      quantity: 2,
    });

    // ⚠️ 先把预占「消耗掉」：记一条 DEDUCT 流水，
    // 该订单未冲抵的预占量变成 0 —— 之后的释放会因「预占量不足」被拒。
    //
    // 这模拟的是「释放这一步失败」的真实场景（预占量对不上、
    // 锁超时、数据库抖动……）。
    await asTenant(merchant.tenantId, () =>
      prisma.inventoryMovement.create({
        data: {
          tenantId: merchant.tenantId,
          skuId,
          type: 'DEDUCT',
          quantity: -2,
          stockBefore: 8,
          stockAfter: 8,
          orderId,
          reason: '测试：模拟预占已被消耗',
        },
      }),
    );

    // 触发超时释放（走 worker，与队列里那个任务同一条路径）
    //
    // ⚠️ 释放失败会**抛错**（预占量不足 → ConflictException），
    // 错误冒泡上来是对的：队列消费端要能感知到失败并重试/告警，
    // 而不是静默吞掉。这个事务会整体回滚。
    await expect(
      timeoutWorker.process(timeoutJob(merchant.tenantId, orderId)),
    ).rejects.toThrow(/预占量不足/);

    // ⚠️ **关键断言**：状态**不能**是 CLOSED。
    // 释放失败时订单必须还是 PENDING_PAYMENT。
    const row = await readOrder(merchant.tenantId, order.orderNo);
    expect(row.status).toBe('PENDING_PAYMENT');
    expect(row.closedAt).toBeNull();

    // ⚠️ 顺带核对：库存没被还回去，也没有 RELEASE 流水
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
  });

  it('消费端幂等：同一个任务被重复投递也只生效一次', async () => {
    const { merchant, skuId, order, orderId } = await placeExpiredOrder({
      quantity: 2,
    });

    // 第一次投递：正常关闭订单、释放预占
    await timeoutWorker.process(timeoutJob(merchant.tenantId, orderId));

    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
    const first = await readMovements(merchant.tenantId, skuId);
    expect(first.filter((m) => m.type === 'RELEASE')).toHaveLength(1);

    // ⚠️ 第二次投递（模拟消费途中崩溃后被重新投递）：
    // 必须**什么都不做**——库存不能被加回两次（不能是 12）。
    await timeoutWorker.process(timeoutJob(merchant.tenantId, orderId));

    // ⚠️ 查库确认库存只被加回一次
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
    const second = await readMovements(merchant.tenantId, skuId);
    expect(second.filter((m) => m.type === 'RELEASE')).toHaveLength(1);

    // 状态不变
    const row = await readOrder(merchant.tenantId, order.orderNo);
    expect(row.status).toBe('CLOSED');
  });
});
