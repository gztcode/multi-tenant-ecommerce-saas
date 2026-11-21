import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { ProductsService } from '../src/modules/catalog/products/products.service';
import { CategoriesService } from '../src/modules/catalog/categories/categories.service';
import { SpecMatrixService } from '../src/modules/catalog/specs/spec-matrix.service';
import { CouponService } from '../src/modules/coupon/coupon.service';
import { PromotionService } from '../src/modules/coupon/promotion.service';
import { AddressService } from '../src/modules/cart/address.service';
import { MediaService } from '../src/modules/media/media.service';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 落库时刻必须用数据库时钟（P3-1）。
 *
 * 仓库的纪律是「落库时刻用 `prisma.databaseNow()`，不要用 `new Date()`」：
 * 应用进程与数据库服务器是两个时钟，一旦应用容器与数据库容器漂了几秒
 * （NTP 校正、休眠唤醒、宿主机迁移），落库时刻就会与库里其它时刻对不齐。
 *
 * ⚠️ **本文件不 mock 数据库时钟**：`SELECT now()` 是真查询，真连库。
 * 被冻住的只有**应用进程**的时钟（把全局 `Date` 换成冻到 2019 年的子类），
 * 于是「落库值」要么来自应用钟（2019 年）、要么来自数据库钟（真实时间），
 * 两者差 7 年——断言必然能区分开。
 *
 * 覆盖的是「真正落库」的 14 处 `new Date()`：
 *   - 商品：update 写 publishedAt / remove 软删商品与 SKU /
 *     batch(PUBLISH) 写 publishedAt / batch(DELETE) 软删商品与 SKU
 *   - 品类：remove 软删
 *   - 规格矩阵：整体替换时软删多余取值、多余维度、被删维度下的孤儿取值
 *   - 优惠券 / 活动 / 地址 / 媒体：remove 软删
 *
 * 软删的行用**裸 PrismaClient** 读：租户扩展会自动带上 `deletedAt: null`，
 * 软删掉的行在租户客户端眼里根本不存在。
 */

/** 落库时刻与数据库时钟的最大允许偏差（毫秒）。5 秒足够宽松，也足够敏感。 */
const CLOCK_TOLERANCE_MS = 5_000;

/** 应用进程被冻到的时刻：2019 年，与数据库钟（真实时间）差 7 年。 */
const FROZEN_APP_CLOCK = '2019-06-01T00:00:00.000Z';

describe('落库时刻用数据库时钟（P3-1）', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;
  /** 裸 PrismaClient：绕开租户扩展，读数据库时钟与软删行的真身 */
  let rawPrisma: PrismaClient;

  let products: ProductsService;
  let categories: CategoriesService;
  let specMatrix: SpecMatrixService;
  let coupons: CouponService;
  let promotions: PromotionService;
  let addresses: AddressService;
  let media: MediaService;

  let tenantId: string;

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
    products = app.get(ProductsService);
    categories = app.get(CategoriesService);
    specMatrix = app.get(SpecMatrixService);
    coupons = app.get(CouponService);
    promotions = app.get(PromotionService);
    addresses = app.get(AddressService);
    media = app.get(MediaService);

    rawPrisma = new PrismaClient();

    const merchant = await createMerchant(app, prisma);
    tenantId = merchant.tenantId;
  });

  afterAll(async () => {
    await rawPrisma.$disconnect();
    await app.close();
  });

  /**
   * 在指定租户的上下文里跑一段逻辑。
   *
   * ⚠️ 回调必须是 **async**：Prisma 6 的租户扩展在 SQL 执行那一刻才读
   * `tenantContext.getStore()`，同步回调不会跨 await 传播上下文，
   * 隔离会**静默失效**（不报错）。
   */
  function asTenant<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  /**
   * 把**应用进程**的时钟冻结到指定时刻。
   *
   * ⚠️ **为什么要冻**：本机上「数据库时钟」与「应用时钟」只差 1 毫秒，
   * 一条「落库时刻与 `SELECT now()` 差 5 秒内」的断言，用真时钟测**恒为真**——
   * 失败注入时把落库时刻换回 `new Date()`，测试**不会挂**（实测过）。
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

  /** 在被冻住的应用时钟下执行一段逻辑，结束后恢复真实时钟 */
  async function withFrozenAppClock<T>(fn: () => Promise<T>): Promise<T> {
    const restore = freezeAppClock(new Date(FROZEN_APP_CLOCK));
    try {
      return await fn();
    } finally {
      restore();
    }
  }

  /** 真查一次数据库时钟（不 mock） */
  async function databaseNow(): Promise<Date> {
    const rows = await rawPrisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT now() as now`;
    return rows[0].now;
  }

  /**
   * 断言落库时刻就是数据库时钟。
   *
   * 差值上限 5 秒：落库与读回之间隔着一次网络往返，差几毫秒是正常的；
   * 而应用时钟被冻到 2019 年后差值是 7 年（约 2.2e11 毫秒）——
   * 两个量级，判定结果必然不同。
   */
  async function expectDatabaseClock(
    label: string,
    persisted: Date | null,
  ): Promise<void> {
    expect(persisted).not.toBeNull();
    const dbNow = await databaseNow();
    const diffMs = Math.abs((persisted as Date).getTime() - dbNow.getTime());
    if (diffMs > CLOCK_TOLERANCE_MS) {
      throw new Error(
        `落库时刻不是数据库时钟：${label} 落库 ${(persisted as Date).toISOString()}，` +
          `SELECT now() = ${dbNow.toISOString()}，相差 ${diffMs} 毫秒` +
          `（上限 ${CLOCK_TOLERANCE_MS} 毫秒）`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 造数
  // ------------------------------------------------------------------

  async function seedProduct(name: string): Promise<string> {
    return asTenant(async () => {
      const product = await prisma.product.create({
        // as never：tenantId 由租户扩展注入，TS 不知道这回事
        data: { name, slug: `p-${unique()}` } as never,
      });
      return product.id;
    });
  }

  async function seedSku(productId: string): Promise<string> {
    return asTenant(async () => {
      const sku = await prisma.sku.create({
        data: { productId, price: 1000, stock: 10, status: 'ACTIVE' } as never,
      });
      return sku.id;
    });
  }

  // ------------------------------------------------------------------
  // 商品
  // ------------------------------------------------------------------

  it('商品首次上架：publishedAt 用数据库时钟', async () => {
    const productId = await seedProduct('上架商品');

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await products.update(productId, { status: 'PUBLISHED' });
      }),
    );

    const row = await rawPrisma.product.findUnique({
      where: { id: productId },
    });
    await expectDatabaseClock(
      'products.update 的 publishedAt',
      row?.publishedAt ?? null,
    );
  });

  it('商品软删：商品与 SKU 的 deletedAt 都用数据库时钟', async () => {
    const productId = await seedProduct('软删商品');
    const skuId = await seedSku(productId);

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await products.remove(productId);
      }),
    );

    const product = await rawPrisma.product.findUnique({
      where: { id: productId },
    });
    const sku = await rawPrisma.sku.findUnique({ where: { id: skuId } });
    await expectDatabaseClock(
      'products.remove 的商品 deletedAt',
      product?.deletedAt ?? null,
    );
    await expectDatabaseClock(
      'products.remove 的 SKU deletedAt',
      sku?.deletedAt ?? null,
    );
  });

  it('批量上架：publishedAt 用数据库时钟', async () => {
    const productId = await seedProduct('批量上架商品');

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await products.batch({ ids: [productId], action: 'PUBLISH' });
      }),
    );

    const row = await rawPrisma.product.findUnique({
      where: { id: productId },
    });
    await expectDatabaseClock(
      'products.batch(PUBLISH) 的 publishedAt',
      row?.publishedAt ?? null,
    );
  });

  it('批量删除：商品与 SKU 的 deletedAt 都用数据库时钟', async () => {
    const productId = await seedProduct('批量删除商品');
    const skuId = await seedSku(productId);

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await products.batch({ ids: [productId], action: 'DELETE' });
      }),
    );

    const product = await rawPrisma.product.findUnique({
      where: { id: productId },
    });
    const sku = await rawPrisma.sku.findUnique({ where: { id: skuId } });
    await expectDatabaseClock(
      'products.batch(DELETE) 的商品 deletedAt',
      product?.deletedAt ?? null,
    );
    await expectDatabaseClock(
      'products.batch(DELETE) 的 SKU deletedAt',
      sku?.deletedAt ?? null,
    );
  });

  // ------------------------------------------------------------------
  // 品类
  // ------------------------------------------------------------------

  it('品类软删：deletedAt 用数据库时钟', async () => {
    const categoryId = await asTenant(async () => {
      const category = await prisma.category.create({
        data: { name: '测试品类', slug: `c-${unique()}` } as never,
      });
      return category.id;
    });

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await categories.remove(categoryId);
      }),
    );

    const row = await rawPrisma.category.findUnique({
      where: { id: categoryId },
    });
    await expectDatabaseClock(
      'categories.remove 的 deletedAt',
      row?.deletedAt ?? null,
    );
  });

  // ------------------------------------------------------------------
  // 规格矩阵
  // ------------------------------------------------------------------

  it('规格矩阵整体替换：多余取值、多余维度、孤儿取值的 deletedAt 都用数据库时钟', async () => {
    const productId = await seedProduct('规格商品');

    // 既有结构：颜色（红色 / 蓝色）、尺码（M）
    const { colorValueId, sizeValueId, sizeSpecId } = await asTenant(
      async () => {
        const colorSpec = await prisma.productSpec.create({
          data: { productId, name: '颜色', sort: 0 } as never,
        });
        await prisma.productSpecValue.create({
          data: { specId: colorSpec.id, value: '红色', sort: 0 } as never,
        });
        const blue = await prisma.productSpecValue.create({
          data: { specId: colorSpec.id, value: '蓝色', sort: 1 } as never,
        });
        const sizeSpec = await prisma.productSpec.create({
          data: { productId, name: '尺码', sort: 1 } as never,
        });
        const m = await prisma.productSpecValue.create({
          data: { specId: sizeSpec.id, value: 'M', sort: 0 } as never,
        });
        return {
          colorValueId: blue.id,
          sizeValueId: m.id,
          sizeSpecId: sizeSpec.id,
        };
      },
    );

    const product = await rawPrisma.product.findUnique({
      where: { id: productId },
    });

    // 只保留「颜色：红色」→ 蓝色（多余取值）、尺码（多余维度）、
    // M（尺码被删后的孤儿取值）三行都要被软删
    await withFrozenAppClock(() =>
      asTenant(async () => {
        await specMatrix.replace(productId, {
          version: product?.version ?? 1,
          specs: [{ name: '颜色', values: [{ value: '红色' }] }],
        });
      }),
    );

    const staleValue = await rawPrisma.productSpecValue.findUnique({
      where: { id: colorValueId },
    });
    const staleSpec = await rawPrisma.productSpec.findUnique({
      where: { id: sizeSpecId },
    });
    const orphanValue = await rawPrisma.productSpecValue.findUnique({
      where: { id: sizeValueId },
    });

    await expectDatabaseClock(
      'spec-matrix.replace 的多余取值 deletedAt',
      staleValue?.deletedAt ?? null,
    );
    await expectDatabaseClock(
      'spec-matrix.replace 的多余维度 deletedAt',
      staleSpec?.deletedAt ?? null,
    );
    await expectDatabaseClock(
      'spec-matrix.replace 的孤儿取值 deletedAt',
      orphanValue?.deletedAt ?? null,
    );
  });

  // ------------------------------------------------------------------
  // 优惠券 / 活动 / 地址 / 媒体
  // ------------------------------------------------------------------

  it('优惠券软删：deletedAt 用数据库时钟', async () => {
    const couponId = await asTenant(async () => {
      const coupon = await prisma.coupon.create({
        data: {
          code: `C-${unique()}`,
          name: '测试券',
          type: 'FIXED',
          value: 500,
          minAmount: 0,
          scope: 'SHOP',
          status: 'ACTIVE',
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: new Date('2030-01-01T00:00:00.000Z'),
        } as never,
      });
      return coupon.id;
    });

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await coupons.deleteCoupon(couponId);
      }),
    );

    const row = await rawPrisma.coupon.findUnique({ where: { id: couponId } });
    await expectDatabaseClock(
      'coupon.deleteCoupon 的 deletedAt',
      row?.deletedAt ?? null,
    );
  });

  it('活动软删：deletedAt 用数据库时钟', async () => {
    const promotionId = await asTenant(async () => {
      const promotion = await prisma.promotion.create({
        data: {
          name: '测试活动',
          minAmount: 0,
          discountAmount: 500,
          status: 'ACTIVE',
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: new Date('2030-01-01T00:00:00.000Z'),
        } as never,
      });
      return promotion.id;
    });

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await promotions.remove(promotionId);
      }),
    );

    const row = await rawPrisma.promotion.findUnique({
      where: { id: promotionId },
    });
    await expectDatabaseClock(
      'promotion.remove 的 deletedAt',
      row?.deletedAt ?? null,
    );
  });

  it('地址软删：deletedAt 用数据库时钟', async () => {
    const customerId = `cust-${unique()}`;
    const addressId = await asTenant(async () => {
      const address = await prisma.address.create({
        data: {
          customerId,
          receiver: '张三',
          phone: '13800000000',
          province: '浙江省',
          city: '杭州市',
          district: '西湖区',
          detail: '文一西路 100 号',
          isDefault: false,
        } as never,
      });
      return address.id;
    });

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await addresses.remove(customerId, addressId);
      }),
    );

    const row = await rawPrisma.address.findUnique({
      where: { id: addressId },
    });
    await expectDatabaseClock(
      'address.remove 的 deletedAt',
      row?.deletedAt ?? null,
    );
  });

  it('媒体软删：deletedAt 用数据库时钟', async () => {
    const mediaId = await asTenant(async () => {
      const row = await prisma.media.create({
        data: {
          key: `t/${unique()}.jpg`,
          url: 'http://localhost:19000/ecommerce-media/t/x.jpg',
          mime: 'image/jpeg',
          size: 100,
          status: 'READY',
          uploadedBy: 'tester',
        } as never,
      });
      return row.id;
    });

    await withFrozenAppClock(() =>
      asTenant(async () => {
        await media.remove(mediaId);
      }),
    );

    const row = await rawPrisma.media.findUnique({ where: { id: mediaId } });
    await expectDatabaseClock(
      'media.remove 的 deletedAt',
      row?.deletedAt ?? null,
    );
  });
});
