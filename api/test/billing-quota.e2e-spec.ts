import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { ProductsService } from '../src/modules/catalog/products/products.service';
import { SubscriptionService } from '../src/modules/billing/subscription.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 下单接入抽佣快照、到期拦截与额度权限的 e2e（阶段 5b Task 6）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 M7：改套餐费率不影响已成交订单（抽佣快照在订单上）
 * - 护栏 M8：改套餐额度，已订阅的商家立刻按新额度判（额度实时读套餐）
 * - 护栏 M12：到期后不能再接新单，但商家后台仍可用
 * - 护栏 M13：额度超限必须拒绝
 * - 护栏 M14：功能开关不能被绕过
 * - 护栏 M15：到期判定用数据库的时钟，不用应用进程的时钟
 * - 护栏 M16：额度检查在 service 层，绕过 controller 也拦得住
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface TokenBody {
  accessToken: string;
  user: { id: string };
}

interface PlanBody {
  id: string;
  commissionBps: number;
}

interface OrderBody {
  orderNo: string;
  totalAmount: number;
  commissionRate: number;
  commissionAmount: number;
}

interface ErrorBody {
  message: string | string[];
}

/** 把错误响应里的 message 摊平成一段文本，便于断言包含某个关键词 */
function errorText(response: { body: unknown }): string {
  const message = (response.body as ErrorBody).message;
  return Array.isArray(message) ? message.join('; ') : message;
}

/** 假网关的共享密钥（与阶段 3 的支付 e2e 同款） */
const FAKE_SECRET = 'e2e-fake-payment-secret';

describe('下单接入抽佣、到期拦截与额度权限 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    // ⚠️ 假网关的开关与密钥必须在 AppModule 加载**之前**设好：
    // provider 的构造在模块求值时发生。
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

  /** 平台超管登录（种子里已有这个账号） */
  async function loginPlatformAdmin(): Promise<string> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    return (response.body as TokenBody).accessToken;
  }

  /** 平台超管建一个套餐 */
  async function createPlan(
    overrides: Record<string, unknown> = {},
  ): Promise<PlanBody> {
    const adminToken = await loginPlatformAdmin();
    const response = await http(app)
      .post('/api/v1/platform/plans')
      .set('authorization', `Bearer ${adminToken}`)
      .send({
        code: `P-${unique()}`,
        name: '测试套餐',
        price: 9900,
        periodDays: 30,
        trialDays: 0,
        commissionBps: 500,
        ...overrides,
      })
      .expect(201);
    return response.body as PlanBody;
  }

  /** 商家订阅一个套餐 */
  async function subscribe(
    merchantToken: string,
    tenantId: string,
    planId: string,
  ): Promise<void> {
    await http(app)
      .post('/api/v1/billing/subscription')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ planId })
      .expect(201);
  }

  /** 在指定店铺注册一个消费者 */
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
    const body = response.body as TokenBody;
    return { token: body.accessToken, userId: body.user.id };
  }

  /** 造一条收货地址，返回它的 id */
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

  /** 商家上架一个带规格与价格的商品，返回它的 skuId */
  async function publishSku(
    token: string,
    name: string,
    price = 10000,
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

  /** 商家补库存 */
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

  /** 把订阅的周期挪到过去（模拟「已到期但状态还没被改」） */
  async function expireSubscription(tenantId: string): Promise<void> {
    await asTenant(tenantId, () =>
      prisma.subscription.updateMany({
        where: { tenantId },
        data: {
          currentPeriodEnd: new Date(Date.now() - 86_400_000),
          trialEndsAt: null,
          status: 'ACTIVE',
        },
      }),
    );
  }

  /**
   * 消费者把订单付掉（走本地假网关）。
   *
   * ⚠️ **发货要求订单已是 PAID**（阶段 3 的状态机：PAID → SHIPPED），
   * 所以「到期后商家仍能发货」那条必须先把订单付掉。
   */
  async function payOrder(
    customerToken: string,
    orderNo: string,
  ): Promise<void> {
    const paid = await http(app)
      .post(`/api/v1/orders/${orderNo}/pay`)
      .set('authorization', `Bearer ${customerToken}`)
      .send({})
      .expect(201);
    const paymentId = (paid.body as { paymentId: string }).paymentId;

    await http(app).post(`/api/v1/pay/fake/${paymentId}/confirm`).expect(200);
  }

  // ============================================================
  // 抽佣快照（M7）
  // ============================================================

  describe('抽佣快照', () => {
    it('下单成功：订单上有费率与抽佣额的快照', async () => {
      const plan = await createPlan({ commissionBps: 500 });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const skuId = await publishSku(merchant.token, '抽佣的商品', 10000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      const response = await http(app)
        .post('/api/v1/orders')
        .set('authorization', `Bearer ${customer.token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({
          addressId,
          items: [{ skuId, quantity: 1 }],
          idempotencyKey: unique(),
        })
        .expect(201);

      const order = response.body as OrderBody;
      // ⚠️ 费率与抽佣额都是**下单这一刻**定的快照
      expect(order.commissionRate).toBe(500);
      // 实付 10000 × 5% = 500
      expect(order.commissionAmount).toBe(500);
      expect(order.totalAmount).toBe(10000);
    });

    it('M7：改套餐的费率 → 历史订单的抽佣快照不变', async () => {
      const plan = await createPlan({ commissionBps: 500 });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const skuId = await publishSku(merchant.token, '改费率前的商品', 10000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      const placed = await http(app)
        .post('/api/v1/orders')
        .set('authorization', `Bearer ${customer.token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({
          addressId,
          items: [{ skuId, quantity: 1 }],
          idempotencyKey: unique(),
        })
        .expect(201);
      const before = placed.body as OrderBody;
      expect(before.commissionAmount).toBe(500);

      // ⚠️ 平台超管把费率从 5% 改成 20%
      const adminToken = await loginPlatformAdmin();
      await http(app)
        .patch(`/api/v1/platform/plans/${plan.id}`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ commissionBps: 2000 })
        .expect(200);

      // ⚠️ **必须查库**：历史订单的抽佣快照不能变
      const rows = await asTenant(merchant.tenantId, () =>
        prisma.order.findMany({ where: { orderNo: before.orderNo } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].commissionRate).toBe(500);
      expect(rows[0].commissionAmount).toBe(500);
    });
  });

  // ============================================================
  // 到期拦截（M12）
  // ============================================================

  describe('到期拦截', () => {
    it('M12：订阅已到期 → 消费者侧下单被拒', async () => {
      const plan = await createPlan();
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const skuId = await publishSku(merchant.token, '到期的商品', 10000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      await expireSubscription(merchant.tenantId);

      const response = await http(app)
        .post('/api/v1/orders')
        .set('authorization', `Bearer ${customer.token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({
          addressId,
          items: [{ skuId, quantity: 1 }],
          idempotencyKey: unique(),
        })
        .expect(503);

      expect(errorText(response)).toContain('暂未开通服务');
    });

    it('M12：订阅已到期 → 商家后台仍可用（发货不报错）', async () => {
      const plan = await createPlan();
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const skuId = await publishSku(merchant.token, '到期后仍能发货', 10000);
      await stockIn(merchant.token, skuId, 10);
      const customer = await registerCustomer(merchant.subdomain);
      const addressId = await createAddress(customer.token);

      const placed = await http(app)
        .post('/api/v1/orders')
        .set('authorization', `Bearer ${customer.token}`)
        .set('x-tenant-subdomain', merchant.subdomain)
        .send({
          addressId,
          items: [{ skuId, quantity: 1 }],
          idempotencyKey: unique(),
        })
        .expect(201);
      const order = placed.body as OrderBody;

      // ⚠️ **先付掉**：发货要求订单已是 PAID（阶段 3 的状态机）
      await payOrder(customer.token, order.orderNo);

      await expireSubscription(merchant.tenantId);

      // ⚠️ **发货必须还能做** —— 把商家锁死等于坑商家，客诉会落到平台头上
      await http(app)
        .post(`/api/v1/merchant/orders/${order.orderNo}/ship`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ trackingNo: 'SF123' })
        .expect(201);
    });
  });

  // ============================================================
  // 额度（M13 / M8 / M16）
  // ============================================================

  describe('额度与功能权限', () => {
    it('M13：商品数达上限 → 建商品被拒，且提示升级套餐', async () => {
      const plan = await createPlan({ maxProducts: 1 });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      // 第一个商品：刚好到上限
      await publishSku(merchant.token, '第一个商品', 10000);

      const response = await http(app)
        .post('/api/v1/catalog/products')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '第二个商品', slug: `p-${unique()}` })
        .expect(409);

      expect(errorText(response)).toContain('最多 1 个商品');
      expect(errorText(response)).toContain('升级套餐');
    });

    it('M8：改套餐的额度 → 已订阅的商家立刻按新额度判', async () => {
      const plan = await createPlan({ maxProducts: 5 });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      // 上限 5 时能建
      await http(app)
        .post('/api/v1/catalog/products')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '额度内的商品', slug: `p-${unique()}` })
        .expect(201);

      // 平台把上限收紧到 0
      const adminToken = await loginPlatformAdmin();
      await http(app)
        .patch(`/api/v1/platform/plans/${plan.id}`)
        .set('authorization', `Bearer ${adminToken}`)
        .send({ maxProducts: 0 })
        .expect(200);

      // ⚠️ **额度是实时读的**：立刻按新额度判
      const response = await http(app)
        .post('/api/v1/catalog/products')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '超额的商品', slug: `p-${unique()}` })
        .expect(409);

      expect(errorText(response)).toContain('最多 0 个商品');
    });

    it('M16：绕过 controller 直接调 service，额度照样拦得住', async () => {
      const plan = await createPlan({ maxProducts: 0 });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const products = app.get(ProductsService);

      // ⚠️ **直接调 service**：绕过 controller 的校验管道，
      // service 层的额度检查必须自己把住（否则这条护栏就是摆设）。
      await expect(
        asTenant(merchant.tenantId, () =>
          products.create({ name: '绕过接口的商品', slug: `p-${unique()}` }),
        ),
      ).rejects.toThrow(/最多 0 个商品/);
    });

    it('M14：套餐不含营销功能 → 建券被拒', async () => {
      // ⚠️ `features` 里没有 marketing 键 = 没有这个功能（缺省是保守的 false）
      const plan = await createPlan({ features: {} });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const response = await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({
          code: `C-${unique()}`,
          name: '没有营销功能时建的券',
          value: 1000,
          minAmount: 0,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(403);

      expect(errorText(response)).toContain('不包含该功能');
      expect(errorText(response)).toContain('升级套餐');
    });

    it('套餐含营销功能 → 建券正常', async () => {
      const plan = await createPlan({ features: { marketing: true } });
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      await http(app)
        .post('/api/v1/merchant/coupons')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({
          code: `C-${unique()}`,
          name: '有营销功能时建的券',
          value: 1000,
          minAmount: 0,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);
    });
  });

  // ============================================================
  // M15：到期判定用数据库时钟
  // ============================================================

  describe('M15：到期判定用数据库时钟', () => {
    /**
     * 把**应用进程**的时钟冻结到指定时刻。
     *
     * ⚠️ **为什么要冻**：本机上「数据库时钟」与「应用时钟」只差 1 毫秒，
     * 一张「刚好过期 1 秒」的订阅，用哪个时钟判结果都一样——
     * 失败注入时把 `databaseNow()` 换成 `new Date()`，测试**不会挂**（实测过）。
     * 计划 §9.2 的 M15 条目已经预告了这个坑：
     * 「注入时要确保测试真的挂了——如果没挂，说明这条护栏没有测试覆盖」。
     * 冻到 2019 年之后，两个时钟差了 7 年，判定结果必然不同。
     *
     * ⚠️ **只替换 `Date`，不动定时器**：
     * `jest.useFakeTimers()` 会把 setTimeout 等也接管，
     * BullMQ 的 worker 会卡死。
     *
     * ⚠️ **静态成员要一并替换**（`now` / `parse` / `UTC`）：
     * BullMQ 的 `waitForRateLimit` 会调 `Date.now()`，
     * 少了它会在 app.close() 时抛 `Date.now is not a function`。
     */
    function freezeAppClock(at: Date): () => void {
      const RealDate = Date;
      const frozen = at.getTime();
      class FrozenDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(frozen);
          } else {
            // @ts-expect-error —— 透传给 Date 的构造签名（可变参数）
            super(...args);
          }
        }
        static now(): number {
          return frozen;
        }
        static parse(...args: unknown[]): number {
          return RealDate.parse(...(args as [string]));
        }
        static UTC(...args: unknown[]): number {
          return RealDate.UTC(...(args as [number]));
        }
      }
      (global as unknown as { Date: DateConstructor }).Date =
        FrozenDate as unknown as DateConstructor;
      return () => {
        (global as unknown as { Date: DateConstructor }).Date = RealDate;
      };
    }

    afterEach(() => {
      (global as unknown as { Date: DateConstructor }).Date = Date;
    });

    it('订阅已到期 → 不能接新单（判定用数据库的时钟，不是应用进程的时钟）', async () => {
      const plan = await createPlan();
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      // ⚠️ 把订阅的周期结束挪到 2019 年：
      //   - 数据库钟（真实时间 ~2026-10）落在周期**之后** → 已到期 → 不能接单
      //   - 应用钟（冻到 2019-01-15）落在周期**之前** → 还没到期 → 能接单
      // 两个时钟给出**不同**的结果，所以这条用例能区分实现用的是哪一个。
      await asTenant(merchant.tenantId, () =>
        prisma.subscription.updateMany({
          where: { tenantId: merchant.tenantId },
          data: {
            status: 'ACTIVE',
            trialEndsAt: null,
            currentPeriodEnd: new Date('2019-02-01T00:00:00.000Z'),
          },
        }),
      );

      const subscriptions = app.get(SubscriptionService);

      // ⚠️ **先把应用时钟冻到 2019 年**：此时「还没到期」
      const restore = freezeAppClock(new Date('2019-01-15T00:00:00.000Z'));
      try {
        // ⚠️ 直接调 service：这条护栏断言的正是「判定用的是哪一个时钟」
        // ⚠️ 必须在租户上下文里调：`Subscription` 是租户作用域模型，
        // 没有上下文时 prisma 扩展直接拒绝。
        const canAccept = await asTenant(merchant.tenantId, () =>
          subscriptions.canAcceptOrders(merchant.tenantId),
        );

        // 实现若用数据库钟 → 已到期 → false（符合预期）
        // 实现若用应用钟 → 还没到期 → true（本条用例挂掉，护栏生效）
        expect(canAccept).toBe(false);
      } finally {
        restore();
      }
    });

    it('订阅还没到期 → 能接新单（应用时钟冻到 2019 年也不影响）', async () => {
      const plan = await createPlan();
      const merchant = await createMerchant(app, prisma);
      await subscribe(merchant.token, merchant.tenantId, plan.id);

      const subscriptions = app.get(SubscriptionService);

      // ⚠️ 订阅是刚订的（周期在数据库钟的未来 ~30 天），
      // 无论用哪个时钟判都是「还没到期」→ 能接单。
      // 这条与上一条合起来，才能把「用数据库钟」与「用应用钟」两种实现区分开：
      // 只实现「已过期」分支的话，上一条会挂、这条照样过。
      const restore = freezeAppClock(new Date('2019-01-15T00:00:00.000Z'));
      try {
        const canAccept = await asTenant(merchant.tenantId, () =>
          subscriptions.canAcceptOrders(merchant.tenantId),
        );
        expect(canAccept).toBe(true);
      } finally {
        restore();
      }
    });
  });
});
