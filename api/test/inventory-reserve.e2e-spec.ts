import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { SkuStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { OrderInventoryService } from '../src/modules/order/inventory.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 库存预占的 e2e（阶段 3 Task 3）。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 4：行锁串行化——并发下单抢同一 SKU，库存只减一次
 * - 护栏 5：按 skuId 排序加锁——两个订单含两个 SKU 且顺序相反时不死锁
 * - 护栏 9：预占不足整单回滚，不留半截订单
 *
 * 另外覆盖设计 §5.2 的**流水双语义**：
 * `quantity` 是业务量与方向，`stockBefore`/`stockAfter` 是实际库存的变化。
 * DEDUCT 的 quantity=-qty 但库存不变——这是最容易看错的地方。
 *
 * ⚠️ 本 Task 还没有下单接口（Task 4 才补），所以这里**直接调服务**。
 * 并发用例靠 `Promise.all` 让两个调用**真的同时**进入加锁阶段——
 * 顺序 await 就不是并发了，测不到行锁。
 */

interface SkuBody {
  id: string;
  price: number;
}

interface SpecMatrixBody {
  skus: SkuBody[];
}

function specMatrixBody(response: { body: unknown }): SpecMatrixBody {
  return response.body as SpecMatrixBody;
}

describe('库存预占 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  let inventory: OrderInventoryService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
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
    inventory = app.get(OrderInventoryService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 在指定租户上下文里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  /**
   * 造一个已上架、已定价的商品，返回它的 SKU id。
   *
   * 走完整的商家接口（建商品 → 铺规格 → 定价 → 上架），
   * 这样 SKU 的归属与上架状态都是真的，不靠直接落库绕过业务规则。
   */
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
    const skuId = specMatrixBody(matrix).skus[0].id;

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

  /** 入库若干件（走库存调整接口，让流水也是真的） */
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

  /** 读某个 SKU 当前的库存 */
  async function readStock(tenantId: string, skuId: string): Promise<number> {
    return asTenant(tenantId, async () => {
      const sku = await prisma.sku.findFirst({ where: { id: skuId } });
      return sku?.stock ?? -1;
    });
  }

  /**
   * 读某个 SKU 当前的库存，**绕过软删过滤**。
   *
   * Prisma 扩展会自动给 Sku 加上 `deletedAt: null` 条件，
   * 所以软删的 SKU 用 findFirst 读不到（会返回 -1）。
   * 断言「软删的 SKU 库存没被动过」必须用原生 SQL 读。
   *
   * ⚠️ 原生 SQL 绕过扩展，租户条件要手写。
   */
  async function readStockIgnoringSoftDelete(
    tenantId: string,
    skuId: string,
  ): Promise<number> {
    const rows = await asTenant(tenantId, () =>
      prisma.$transaction(
        (tx) =>
          tx.$queryRaw<Array<{ stock: number }>>`
          SELECT stock FROM skus
          WHERE id = ${skuId} AND "tenantId" = ${tenantId}
        `,
      ),
    );
    return rows[0]?.stock ?? -1;
  }

  /** 读某个 SKU 的全部流水 */
  async function readMovements(tenantId: string, skuId: string) {
    return asTenant(tenantId, () =>
      prisma.inventoryMovement.findMany({
        where: { skuId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** 在租户上下文里调用预占 */
  function reserve(
    tenantId: string,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ) {
    return asTenant(tenantId, () => inventory.reserve(orderId, items));
  }

  /** 在租户上下文里释放预占 */
  function release(
    tenantId: string,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ) {
    return asTenant(tenantId, () =>
      prisma.$transaction((tx) => inventory.releaseInTx(tx, orderId, items)),
    );
  }

  /** 在租户上下文里确认售出 */
  function deduct(
    tenantId: string,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ) {
    return asTenant(tenantId, () =>
      prisma.$transaction((tx) => inventory.deductInTx(tx, orderId, items)),
    );
  }

  // ---- 护栏 4：行锁串行化 ----

  it('管理端同时调整库存时，下单不会误报 409：行锁让下单看到调整后的值', async () => {
    // 这条用例守的是设计 §5.1 的那句话：
    // 「行锁保证并发下单不会丢更新；stockVersion 保证管理端的人工调整
    //   不与下单互相覆盖。两者都要。」
    //
    // 做法：另开一个事务把 SKU 行锁住（模拟商家在管理端改了库存还没提交），
    // 同时发起下单。下单必须**排在行锁后面**，等管理端提交后再读——
    // 于是它读到的是调整后的库存与 stockVersion，预占照样成功。
    //
    // ⚠️ 没有 `FOR UPDATE` 时这条会失败：下单的读不排队，直接读到调整前的
    // 旧值（stock=10 / stockVersion=0），随后管理端提交把 stockVersion 推进到 1，
    // 下单的 updateMany 用旧版本号去写 → 受影响行数为 0 → 误报 409。
    // 「本来能买成的单子被管理端的一次入库打掉」是真实的线上故障。
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '管理与下单撞车的商品');
    await stockIn(merchant.token, skuId, 10);

    // 事务 X：锁住 SKU 行，改库存，推进 stockVersion，然后提交
    let xLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      xLocked = resolve;
    });
    let xRelease: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      xRelease = resolve;
    });

    const adminTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM skus
        WHERE id = ${skuId} AND "tenantId" = ${merchant.tenantId}
        FOR UPDATE
      `;
      xLocked();
      // 持锁不放，等下单请求发出并（在没有 FOR UPDATE 的实现里）读到旧值
      await release;
      await tx.$queryRaw`
        UPDATE skus SET stock = 20, "stockVersion" = "stockVersion" + 1
        WHERE id = ${skuId} AND "tenantId" = ${merchant.tenantId}
      `;
    });

    await locked;

    // 下单与「管理端提交」并发
    const reservePromise = reserve(merchant.tenantId, 'order-C', [
      { skuId, quantity: 3 },
    ]);
    // 让下单有机会发出它的数据库请求
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 管理端提交：库存 10 → 20，stockVersion 推进
    xRelease();
    await adminTx;

    // 有行锁 → 下单排在后面，读到 stock=20 / 新 stockVersion → 预占成功
    const movements = await reservePromise;
    expect(movements).toHaveLength(1);
    expect(movements[0].stockBefore).toBe(20);
    expect(movements[0].stockAfter).toBe(17);
    expect(movements[0].quantity).toBe(-3);

    expect(await readStock(merchant.tenantId, skuId)).toBe(17);
  });

  it('并发下单：两个订单抢同一 SKU，库存只减一次', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '抢手的商品');
    await stockIn(merchant.token, skuId, 1);

    // ⚠️ 必须**真的并发**：Promise.all 让两个调用同时进入加锁阶段。
    // 顺序 await 就串行了，测不到行锁。
    const results = await Promise.allSettled([
      reserve(merchant.tenantId, 'order-A', [{ skuId, quantity: 1 }]),
      reserve(merchant.tenantId, 'order-B', [{ skuId, quantity: 1 }]),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // 失败的必须是「库存不足」（409），不能是超时或未知错误
    const reason = failed[0].reason as {
      status?: number;
      message?: string;
    };
    expect(reason.status).toBe(409);
    expect(reason.message).toContain('库存不足');

    // ⚠️ 断言要查库，不能只看响应状态码：
    // 库存只该减一次，且只有一条 RESERVE 流水。
    expect(await readStock(merchant.tenantId, skuId)).toBe(0);

    const movements = await readMovements(merchant.tenantId, skuId);
    const reserveMovements = movements.filter((m) => m.type === 'RESERVE');
    expect(reserveMovements).toHaveLength(1);
    expect(reserveMovements[0].quantity).toBe(-1);
    expect(reserveMovements[0].stockBefore).toBe(1);
    expect(reserveMovements[0].stockAfter).toBe(0);
  });

  it('预占与管理端调整抢同一个 SKU：预占读到的是最新库存，不覆盖管理端的调整', async () => {
    // 阶段 2 的库存调整（管理端手工加减）也用 `stockVersion` 乐观锁，
    // 两边用的是同一套版本号约定。
    //
    // ⚠️ 这条断言的是**读到的值是最新的**：管理端入库 5 件之后，
    // 预占必须基于 15 而不是 10 来算，并且不能把管理端那笔入库覆盖掉。
    //
    // ⚠️ 诚实地说：它**抓不到**「预占侧删掉 stockVersion 条件」这个变异。
    // 在行锁还在的前提下，预占事务读到的 stockVersion 永远是最新的，
    // 那个条件是冗余的（详见 inventory.service.ts 里的注释）。
    // 它是纵深防御，不是这里的主防线。
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '与管理端撞车的商品');
    await stockIn(merchant.token, skuId, 10);

    // 管理端把库存从 10 改到 15，同时推进 stockVersion
    await stockIn(merchant.token, skuId, 5);

    const movements = await reserve(merchant.tenantId, 'order-V', [
      { skuId, quantity: 2 },
    ]);
    expect(movements).toHaveLength(1);
    // 预占读到的是**最新的**库存 15（不是 10），减 2 → 13
    expect(movements[0].stockBefore).toBe(15);
    expect(movements[0].stockAfter).toBe(13);
    expect(await readStock(merchant.tenantId, skuId)).toBe(13);

    // 账实对得上：三次改动（入库 10、入库 5、预占 2）各推一次版本号
    const sku = await asTenant(merchant.tenantId, async () => {
      const found = await prisma.sku.findFirst({ where: { id: skuId } });
      return found;
    });
    expect(sku?.stockVersion).toBe(3);
  });

  // ---- 护栏 5：按 skuId 排序加锁 ----
  it('加锁按 skuId 排序：两个订单含两个 SKU 且顺序相反，不死锁', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuA = await publishSku(merchant.token, '死锁测试商品 A');
    const skuB = await publishSku(merchant.token, '死锁测试商品 B');
    await stockIn(merchant.token, skuA, 10);
    await stockIn(merchant.token, skuB, 10);

    // 订单 A 的条目顺序是 [skuA, skuB]，订单 B 是 [skuB, skuA]——顺序相反。
    // 不排序加锁 → A 持有 skuA 的锁等 skuB、B 持有 skuB 的锁等 skuA → 死锁。
    // 排序后两个都拿到全局一致的加锁顺序，死锁不可能发生。
    const results = await Promise.allSettled([
      reserve(merchant.tenantId, 'order-A', [
        { skuId: skuA, quantity: 1 },
        { skuId: skuB, quantity: 1 },
      ]),
      reserve(merchant.tenantId, 'order-B', [
        { skuId: skuB, quantity: 1 },
        { skuId: skuA, quantity: 1 },
      ]),
    ]);

    // 两个订单都必须成功
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed).toHaveLength(0);

    // 查库确认两个 SKU 各被两个订单各减了 1（共 2），且各有两条 RESERVE 流水
    expect(await readStock(merchant.tenantId, skuA)).toBe(8);
    expect(await readStock(merchant.tenantId, skuB)).toBe(8);

    const movementsA = await readMovements(merchant.tenantId, skuA);
    const movementsB = await readMovements(merchant.tenantId, skuB);
    expect(movementsA.filter((m) => m.type === 'RESERVE')).toHaveLength(2);
    expect(movementsB.filter((m) => m.type === 'RESERVE')).toHaveLength(2);
  });

  // ---- 流水的双语义（设计 §5.2）----

  it('预占流水：quantity 是业务量，stock 是实际库存', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '流水语义商品');
    await stockIn(merchant.token, skuId, 10);

    // ---- RESERVE ----
    const reserveMovements = await reserve(merchant.tenantId, 'order-R', [
      { skuId, quantity: 5 },
    ]);
    expect(reserveMovements).toHaveLength(1);
    expect(reserveMovements[0].type).toBe('RESERVE');
    // quantity 是业务量与方向：预占 5 件记 -5
    expect(reserveMovements[0].quantity).toBe(-5);
    // stockBefore/After 是实际库存：预占真的把库存扣掉了 5
    expect(reserveMovements[0].stockBefore).toBe(10);
    expect(reserveMovements[0].stockAfter).toBe(5);
    expect(await readStock(merchant.tenantId, skuId)).toBe(5);

    // ---- DEDUCT（支付成功）----
    // ⚠️ DEDUCT 与 RELEASE 是**互斥**的两条路径：支付成功后订单就成交了，
    // 不会再走超时释放。所以它们必须**分属两个订单**——
    // 同一个订单先扣减再释放，在业务上根本不成立。
    const deductMovements = await deduct(merchant.tenantId, 'order-R', [
      { skuId, quantity: 5 },
    ]);
    expect(deductMovements).toHaveLength(1);
    expect(deductMovements[0].type).toBe('DEDUCT');
    // ⚠️ quantity 仍然是负的业务量（又卖出了 5 件）
    expect(deductMovements[0].quantity).toBe(-5);
    // ⚠️ 但**库存不变**——预占时已经扣过了，这里只标记成交
    expect(deductMovements[0].stockBefore).toBe(5);
    expect(deductMovements[0].stockAfter).toBe(5);
    expect(await readStock(merchant.tenantId, skuId)).toBe(5);

    // ---- RELEASE（取消 / 支付超时）----
    // 另一个订单：预占 5 件再释放
    await reserve(merchant.tenantId, 'order-R2', [{ skuId, quantity: 5 }]);
    expect(await readStock(merchant.tenantId, skuId)).toBe(0);

    const releaseMovements = await release(merchant.tenantId, 'order-R2', [
      { skuId, quantity: 5 },
    ]);
    expect(releaseMovements).toHaveLength(1);
    expect(releaseMovements[0].type).toBe('RELEASE');
    // 释放：业务量记 +5，库存还回去
    expect(releaseMovements[0].quantity).toBe(5);
    expect(releaseMovements[0].stockBefore).toBe(0);
    expect(releaseMovements[0].stockAfter).toBe(5);
    // 净结果：10 件里卖掉了 5 件，可售库存剩 5
    expect(await readStock(merchant.tenantId, skuId)).toBe(5);
  });

  it('已售出的货不能再释放：未冲抵预占量不足时被拒，库存不会凭空变多', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '售出后不可释放');
    await stockIn(merchant.token, skuId, 10);

    await reserve(merchant.tenantId, 'order-D', [{ skuId, quantity: 5 }]);
    await deduct(merchant.tenantId, 'order-D', [{ skuId, quantity: 5 }]);

    // 货已售出 → 该订单未冲抵的预占量是 0 → 再释放会被拒
    await expect(
      release(merchant.tenantId, 'order-D', [{ skuId, quantity: 5 }]),
    ).rejects.toThrow();

    // ⚠️ 不能只看「抛了错」——要查库确认库存没被凭空加回去
    expect(await readStock(merchant.tenantId, skuId)).toBe(5);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
  });

  it('预占流水的 operatorId 为空：预占是系统行为，没有人工操作人', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '无操作人的预占');
    await stockIn(merchant.token, skuId, 3);

    await reserve(merchant.tenantId, 'order-S', [{ skuId, quantity: 1 }]);

    const movements = await readMovements(merchant.tenantId, skuId);
    const reserveMovement = movements.find((m) => m.type === 'RESERVE');
    expect(reserveMovement).toBeDefined();
    // ⚠️ 不能填 'system' 这类假值——那会让「谁动了库存」失真
    expect(reserveMovement?.operatorId).toBeNull();

    // 对照：管理端的手工调整是有人操作的，operatorId 有值
    const adjustMovement = movements.find((m) => m.type === 'ADJUST_IN');
    expect(adjustMovement?.operatorId).toBeTruthy();
  });

  // ---- 护栏 9：预占不足整单回滚 ----

  it('库存不足时整单回滚，不留半截订单', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuA = await publishSku(merchant.token, '充足库存的商品');
    const skuB = await publishSku(merchant.token, '库存不足的商品');
    await stockIn(merchant.token, skuA, 10);
    await stockIn(merchant.token, skuB, 1);

    // 一个订单两个条目，第二个不够
    await expect(
      reserve(merchant.tenantId, 'order-RB', [
        { skuId: skuA, quantity: 2 },
        { skuId: skuB, quantity: 5 },
      ]),
    ).rejects.toMatchObject({ status: 409 });

    // ⚠️ 关键断言：**第一个条目也不能留下痕迹**。
    // 整单回滚 = skuA 的库存没动，也没有半截流水。
    expect(await readStock(merchant.tenantId, skuA)).toBe(10);
    expect(await readStock(merchant.tenantId, skuB)).toBe(1);

    const movementsA = await readMovements(merchant.tenantId, skuA);
    expect(movementsA.filter((m) => m.type === 'RESERVE')).toHaveLength(0);
    const movementsB = await readMovements(merchant.tenantId, skuB);
    expect(movementsB.filter((m) => m.type === 'RESERVE')).toHaveLength(0);
  });

  // ---- 跨租户 ----

  it('SKU 属于别的租户时不能被预占', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuOfA = await publishSku(a.token, 'A 店的商品');
    await stockIn(a.token, skuOfA, 10);

    // B 店去预占 A 店的 SKU
    await expect(
      reserve(b.tenantId, 'order-X', [{ skuId: skuOfA, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 404 });

    // A 店的库存没被动过
    expect(await readStock(a.tenantId, skuOfA)).toBe(10);
    const movements = await readMovements(a.tenantId, skuOfA);
    expect(movements.filter((m) => m.type === 'RESERVE')).toHaveLength(0);
  });

  it('已停用的 SKU 不能被预占', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '将被停用的商品');
    await stockIn(merchant.token, skuId, 10);

    await asTenant(merchant.tenantId, () =>
      prisma.sku.updateMany({
        where: { id: skuId },
        data: { status: SkuStatus.INACTIVE },
      }),
    );

    await expect(
      reserve(merchant.tenantId, 'order-IN', [{ skuId, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });

    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
  });

  it('已软删的 SKU 不能被预占', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '将被软删的商品');
    await stockIn(merchant.token, skuId, 10);

    await asTenant(merchant.tenantId, () =>
      prisma.sku.updateMany({
        where: { id: skuId },
        data: { deletedAt: new Date() },
      }),
    );

    await expect(
      reserve(merchant.tenantId, 'order-DEL', [{ skuId, quantity: 1 }]),
    ).rejects.toMatchObject({ status: 400 });

    expect(await readStockIgnoringSoftDelete(merchant.tenantId, skuId)).toBe(
      10,
    );
  });

  // ---- 释放的正确性：必须「确实预占过」 ----

  it('从未预占过的 SKU 不能被释放：否则库存会凭空变多', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '没被预占过的商品');
    await stockIn(merchant.token, skuId, 10);

    // ⚠️ 这条守的是「凭空造货」这个洞。
    // 流水与订单之间原本只有自由文本的 reason，没有任何数据层关联，
    // 于是「这些条目确实被预占过」无法在数据层验证：
    // 释放 5 件 → 库存 10 变 15，流水里多一条 RELEASE +5，
    // **stock 与流水的净变化是自洽的**，对账时看不出问题。
    await expect(
      release(merchant.tenantId, 'order-NEVER', [{ skuId, quantity: 5 }]),
    ).rejects.toMatchObject({ status: 409 });

    // ⚠️ 关键断言：库存一点没动，也没有留下流水。
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(0);
  });

  it('同一个订单重复释放：第二次被拒，库存只被加回一次', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '会被重复释放的商品');
    await stockIn(merchant.token, skuId, 10);

    await reserve(merchant.tenantId, 'order-DUP', [{ skuId, quantity: 5 }]);
    expect(await readStock(merchant.tenantId, skuId)).toBe(5);

    // 第一次释放：正常
    const first = await release(merchant.tenantId, 'order-DUP', [
      { skuId, quantity: 5 },
    ]);
    expect(first).toHaveLength(1);
    expect(first[0].quantity).toBe(5);
    expect(await readStock(merchant.tenantId, skuId)).toBe(10);

    // ⚠️ 第二次释放：预占量已经被冲抵掉了，必须被拒。
    // 没有这条校验的话库存会变成 15——货凭空多出来。
    await expect(
      release(merchant.tenantId, 'order-DUP', [{ skuId, quantity: 5 }]),
    ).rejects.toMatchObject({ status: 409 });

    expect(await readStock(merchant.tenantId, skuId)).toBe(10);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'RELEASE')).toHaveLength(1);
  });

  it('释放的数量超过尚未被冲抵的预占量时被拒', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '释放超量的商品');
    await stockIn(merchant.token, skuId, 10);

    await reserve(merchant.tenantId, 'order-OVER', [{ skuId, quantity: 3 }]);

    // 预占 3 件却要释放 5 件 → 超过预占量
    await expect(
      release(merchant.tenantId, 'order-OVER', [{ skuId, quantity: 5 }]),
    ).rejects.toMatchObject({ status: 409 });

    expect(await readStock(merchant.tenantId, skuId)).toBe(7);
  });

  it('确认售出的数量超过尚未被冲抵的预占量时被拒', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '扣减超量的商品');
    await stockIn(merchant.token, skuId, 10);

    await reserve(merchant.tenantId, 'order-OVR-DED', [{ skuId, quantity: 3 }]);

    // ⚠️ DEDUCT 的库存不变、只记流水，但它的 quantity = -qty 同样表示
    // 「又卖出了 qty 件」——超过预占量的话流水就自相矛盾了。
    await expect(
      deduct(merchant.tenantId, 'order-OVR-DED', [{ skuId, quantity: 5 }]),
    ).rejects.toMatchObject({ status: 409 });

    expect(await readStock(merchant.tenantId, skuId)).toBe(7);
    const movements = await readMovements(merchant.tenantId, skuId);
    expect(movements.filter((m) => m.type === 'DEDUCT')).toHaveLength(0);
  });

  it('释放时传负数量被拒：否则库存会被扣成负数', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '负数量释放的商品');
    await stockIn(merchant.token, skuId, 10);

    await reserve(merchant.tenantId, 'order-NEG', [{ skuId, quantity: 5 }]);

    // ⚠️ RELEASE 的 nextStock 是 stock + quantity，
    // 负数量会把库存**扣成负数**。writeMovements 之前没有 quantity >= 1 的检查。
    await expect(
      release(merchant.tenantId, 'order-NEG', [{ skuId, quantity: -100 }]),
    ).rejects.toMatchObject({ status: 400 });

    expect(await readStock(merchant.tenantId, skuId)).toBe(5);
  });

  it('同一次预占传重复 skuId：按合并后的数量校验库存', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重复条目的商品');
    await stockIn(merchant.token, skuId, 10);

    // ⚠️ 合并后语义是对的：同 SKU 两条各 1 件 = 要 2 件。
    // 之前会抛「库存已被他人修改，请重试」——数据上安全（事务回滚）
    // 但错误信号完全误导，且掩盖了真正的输入问题。
    const movements = await reserve(merchant.tenantId, 'order-DUPITEM', [
      { skuId, quantity: 1 },
      { skuId, quantity: 1 },
    ]);
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-2);
    expect(await readStock(merchant.tenantId, skuId)).toBe(8);
  });

  it('同一次预占传重复 skuId：合并后库存不够，报的是「库存不足」', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重复条目库存不足的商品');
    await stockIn(merchant.token, skuId, 1);

    // 合并后是 2 件 > 库存 1 件 → 错误信号必须是「库存不足」，
    // 不能是误导性的「库存已被他人修改，请重试」。
    const failure = await reserve(merchant.tenantId, 'order-DUPITEM2', [
      { skuId, quantity: 1 },
      { skuId, quantity: 1 },
    ]).catch((error: unknown) => error);

    const reason = failure as { status?: number; message?: string };
    expect(reason.status).toBe(409);
    expect(reason.message).toContain('库存不足');

    expect(await readStock(merchant.tenantId, skuId)).toBe(1);
  });

  it('预占流水记下 orderId：能按订单查到它的流水', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '带 orderId 的流水');
    await stockIn(merchant.token, skuId, 10);

    await reserve(merchant.tenantId, 'order-WITH-ID', [{ skuId, quantity: 5 }]);

    const movements = await readMovements(merchant.tenantId, skuId);
    const reserveMovement = movements.find((m) => m.type === 'RESERVE');
    expect(reserveMovement?.orderId).toBe('order-WITH-ID');
  });
});
