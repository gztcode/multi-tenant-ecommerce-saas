import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { SkuStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 购物车与地址簿的 e2e。
 *
 * 覆盖的护栏（编号体系见计划 §0.6）：
 * - 护栏 1：合并取 max 而不是累加
 * - 护栏 2：合并时重新校验 SKU 与上架状态、数量上限
 * - 护栏 3：合并接口幂等
 * - 护栏 19：地址簿默认地址唯一
 * - 护栏 20：地址的 customerId 归属当前租户
 */

// ---- 响应体的类型收敛 ----
//
// supertest 的 response.body 是 any，直接访问字段会触发
// @typescript-eslint/no-unsafe-member-access。集中在这里做一次收敛。

interface CartItemBody {
  id: string;
  skuId: string;
  quantity: number;
  /** 条目带上的展示信息：单价（整数分）与商品名 */
  sku: {
    id: string;
    price: number;
    product: {
      id: string;
      name: string;
    };
  };
}

interface CartBody {
  id: string;
  items: CartItemBody[];
}

interface AddressBody {
  id: string;
  receiver: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
}

interface AddressListBody {
  items: AddressBody[];
}

interface UserBody {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
}

interface TokenBody {
  accessToken: string;
  user: UserBody;
}

interface SkuBody {
  id: string;
  price: number;
}

interface SpecMatrixBody {
  skus: SkuBody[];
}

function cartBody(response: { body: unknown }): CartBody {
  return response.body as CartBody;
}

function addressBody(response: { body: unknown }): AddressBody {
  return response.body as AddressBody;
}

function addressListBody(response: { body: unknown }): AddressListBody {
  return response.body as AddressListBody;
}

function tokenBody(response: { body: unknown }): TokenBody {
  return response.body as TokenBody;
}

function specMatrixBody(response: { body: unknown }): SpecMatrixBody {
  return response.body as SpecMatrixBody;
}

describe('购物车与地址簿 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // ⚠️ 读取 cookie 必须有 cookie-parser 中间件：
    // Express 自带 res.cookies.set()（写），但 req.cookies（读）要靠它。
    // 少了它，游客的 cart_token 读不到，游客相关的用例会全挂。
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

  /** 在某个店铺注册一个消费者，返回令牌 */
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

  // ---- 游客购物车 ----

  it('游客加购：cookie 里的 token 标识购物车，同一店铺只有一个', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '游客加购的商品');

    const first = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 2 })
      .expect(201);

    const guestToken = first.headers['set-cookie'];
    expect(guestToken).toBeDefined();
    // cookie 必须是 HttpOnly + SameSite=Lax
    const cookieHeader = Array.isArray(guestToken)
      ? guestToken.join(';')
      : String(guestToken);
    expect(cookieHeader).toContain('cart_token=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Lax');

    // 带上 cookie 再加另一个 SKU
    const cookie = cookieHeader.split(';')[0];
    const second = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .send({ skuId, quantity: 1 })
      .expect(201);

    // 同一个游客购物车：同一条目数量累加，而不是新增一条
    expect(cartBody(second).items).toHaveLength(1);
    expect(cartBody(second).items[0].quantity).toBe(3);
    expect(cartBody(second).id).toBe(cartBody(first).id);
  });

  it('游客购物车按店铺分：A 店的车在 B 店看不到', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuA = await publishSku(a.token, 'A 店的商品');

    const added = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', a.subdomain)
      .send({ skuId: skuA, quantity: 1 })
      .expect(201);
    const cookieHeader = Array.isArray(added.headers['set-cookie'])
      ? added.headers['set-cookie'].join(';')
      : String(added.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    // 同一个 cookie 去 B 店，B 店的购物车是空的
    const inB = await http(app)
      .get('/api/v1/cart')
      .set('x-tenant-subdomain', b.subdomain)
      .set('cookie', cookie)
      .expect(200);
    expect(cartBody(inB).items).toHaveLength(0);

    // 回 A 店，还是原来那一条
    const inA = await http(app)
      .get('/api/v1/cart')
      .set('x-tenant-subdomain', a.subdomain)
      .set('cookie', cookie)
      .expect(200);
    expect(cartBody(inA).items).toHaveLength(1);
  });

  it('加购数量超过上限被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '限量的商品');

    const response = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 100000 })
      .expect(400);

    expect(response.status).toBe(400);

    // 「操作 → 断言报错」的用例要额外查一次库，确认数据真的没变
    const carts = await asTenant(merchant.tenantId, () =>
      prisma.cart.findMany({ include: { items: true } }),
    );
    const itemCount = carts.reduce((sum, cart) => sum + cart.items.length, 0);
    expect(itemCount).toBe(0);
  });

  it('跨租户不能引用别人的 SKU 加购', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const skuOfA = await publishSku(a.token, 'A 店的商品');

    const response = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', b.subdomain)
      .send({ skuId: skuOfA, quantity: 1 });

    // 拒绝（不能是 404 之外的成功，也不能是 500）
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    // 查库确认 B 店没有多出条目
    const carts = await asTenant(b.tenantId, () =>
      prisma.cart.findMany({ include: { items: true } }),
    );
    const itemCount = carts.reduce((sum, cart) => sum + cart.items.length, 0);
    expect(itemCount).toBe(0);
  });

  it('未上架的商品不能加购', async () => {
    const merchant = await createMerchant(app, prisma);
    // 建商品但不铺规格也不上架 → 没有可售 SKU
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '草稿商品', slug: `d-${unique()}` })
      .expect(201);
    const productId = (created.body as { id: string }).id;

    const matrix = await http(app)
      .put(`/api/v1/catalog/products/${productId}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: 1,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);
    const skuId = specMatrixBody(matrix).skus[0].id;

    const response = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 1 });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  // ---- 登录合并（护栏 1 / 2 / 3）----

  it('登录合并：同一 SKU 的数量取 max 而不是累加', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '合并的商品');
    const customer = await registerCustomer(merchant.subdomain);

    // 游客加 2 件
    const guest = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 2 })
      .expect(201);
    const cookieHeader = Array.isArray(guest.headers['set-cookie'])
      ? guest.headers['set-cookie'].join(';')
      : String(guest.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    // 账号里先有 3 件（游客加购之后、合并之前，用 token 直接加购）
    await http(app)
      .post('/api/v1/cart/items')
      .set('authorization', `Bearer ${customer.token}`)
      .send({ skuId, quantity: 3 })
      .expect(201);

    const merged = await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);

    // ⚠️ 断言值本身就是区分度：max → 3，累加 → 5。
    const items = cartBody(merged).items;
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(3);
  });

  it('合并时重新校验：游客车里已下架的商品被丢弃', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '待下架的商品');
    const customer = await registerCustomer(merchant.subdomain);

    // 游客加购
    const guest = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 2 })
      .expect(201);
    const cookieHeader = Array.isArray(guest.headers['set-cookie'])
      ? guest.headers['set-cookie'].join(';')
      : String(guest.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    // 商品被下架（PUBLISHED → UNPUBLISHED）
    const productId = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirst({ where: { id: skuId } });
      return sku?.productId ?? '';
    });
    await http(app)
      .patch(`/api/v1/catalog/products/${productId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'UNPUBLISHED' })
      .expect(200);

    const merged = await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);

    expect(cartBody(merged).items).toHaveLength(0);

    // ⚠️ 不能只断言总数——要额外查一次库确认那条真的不在购物车里
    const carts = await asTenant(merchant.tenantId, () =>
      prisma.cart.findMany({ include: { items: true } }),
    );
    const cartItemRows = carts.flatMap((cart) => cart.items);
    expect(cartItemRows.filter((item) => item.skuId === skuId)).toHaveLength(0);
  });

  it('合并是幂等的：游客车已不存在时，账号车的条目不被改动', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '账号车里的过期商品');
    const customer = await registerCustomer(merchant.subdomain);

    // 账号车里先加购，然后商品下架
    await http(app)
      .post('/api/v1/cart/items')
      .set('authorization', `Bearer ${customer.token}`)
      .send({ skuId, quantity: 2 })
      .expect(201);

    const productId = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirst({ where: { id: skuId } });
      return sku?.productId ?? '';
    });
    await http(app)
      .patch(`/api/v1/catalog/products/${productId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'UNPUBLISHED' })
      .expect(200);

    // 合并：没有游客车（没带 cookie）→ 幂等路径
    const merged = await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(merged.status).toBe(200);

    // ⚠️ **幂等重试必须是 no-op**——不能物理删除账号车里的条目。
    //
    // 这条断言守着一个具体的坑：合并若在「游客车分支之外」也清理账号车，
    // 那么「重试一次合并」就变成了破坏性操作——用户正常加购、只是恰好
    // 被商家下架了的商品会被删掉（CartItem 不走软删，删了就没了）。
    //
    // 所以这里查库断言那条**还在**，而不是只看响应。
    const cartItemRows = await asTenant(merchant.tenantId, async () => {
      const carts = await prisma.cart.findMany({ include: { items: true } });
      return carts.flatMap((cart) => cart.items);
    });
    expect(cartItemRows.filter((item) => item.skuId === skuId)).toHaveLength(1);
  });

  it('合并是幂等的：游客车已不存在时返回成功', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '幂等合并的商品');
    const customer = await registerCustomer(merchant.subdomain);

    // 游客加购后先合并一次（游客车被删掉）
    const guest = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 1 })
      .expect(201);
    const cookieHeader = Array.isArray(guest.headers['set-cookie'])
      ? guest.headers['set-cookie'].join(';')
      : String(guest.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);

    // 再合并一次：游客车已经没了，仍然要成功
    const again = await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);
    expect(cartBody(again).items).toHaveLength(1);
    expect(cartBody(again).items[0].quantity).toBe(1);
  });

  it('合并有条目数上限：超过上限的游客条目被丢弃', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '合并上限的商品');
    const customer = await registerCustomer(merchant.subdomain);

    // 游客加购第一条，拿到 cookie 与游客车
    const guest = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 1 })
      .expect(201);
    const cookieHeader = Array.isArray(guest.headers['set-cookie'])
      ? guest.headers['set-cookie'].join(';')
      : String(guest.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];
    // base64url 不含 '='，所以按第一个 '=' 切是安全的
    const guestToken = cookie.split('=')[1];

    const productId = await asTenant(merchant.tenantId, async () => {
      const sku = await prisma.sku.findFirst({ where: { id: skuId } });
      return sku?.productId ?? '';
    });

    // 再补 200 个可售 SKU，凑够 201 条游客条目（上限是 200）
    const extraSkuIds = await asTenant(merchant.tenantId, async () => {
      const created = await prisma.sku.createManyAndReturn({
        data: Array.from({ length: 200 }, (_, index) => ({
          tenantId: merchant.tenantId,
          productId,
          code: `BULK-${unique()}-${index}`,
          price: 1000,
          stock: 10,
          status: SkuStatus.ACTIVE,
        })),
        select: { id: true },
      });
      return created.map((sku) => sku.id);
    });

    await asTenant(merchant.tenantId, async () => {
      const cart = await prisma.cart.findFirst({ where: { guestToken } });
      if (!cart) {
        throw new Error('游客车不存在');
      }
      await prisma.cartItem.createMany({
        data: extraSkuIds.map((id) => ({
          tenantId: merchant.tenantId,
          cartId: cart.id,
          skuId: id,
          quantity: 1,
        })),
      });
    });

    await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);

    // 游客车 201 条，单次合并只处理 200 条 → 账号车里最多 200 条
    const accountItems = await asTenant(merchant.tenantId, async () => {
      const carts = await prisma.cart.findMany({
        where: { customerId: customer.userId },
        include: { items: true },
      });
      return carts.flatMap((cart) => cart.items);
    });
    expect(accountItems).toHaveLength(200);
  });

  it('合并后游客购物车被删除，cookie 被清掉', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '合并后清游客车');
    const customer = await registerCustomer(merchant.subdomain);

    const guest = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 1 })
      .expect(201);
    const cookieHeader = Array.isArray(guest.headers['set-cookie'])
      ? guest.headers['set-cookie'].join(';')
      : String(guest.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    await http(app)
      .post('/api/v1/cart/merge')
      .set('authorization', `Bearer ${customer.token}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);

    // 查库确认游客车真的没了
    const guestCarts = await asTenant(merchant.tenantId, () =>
      prisma.cart.findMany({ where: { guestToken: { not: null } } }),
    );
    expect(guestCarts).toHaveLength(0);
  });

  it('合并需要登录，游客调用被拒', async () => {
    const merchant = await createMerchant(app, prisma);

    const response = await http(app)
      .post('/api/v1/cart/merge')
      .set('x-tenant-subdomain', merchant.subdomain);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('购物车只对消费者开放：商家令牌被拒', async () => {
    const merchant = await createMerchant(app, prisma);

    // 购物车是消费者侧的资源。商家在前台逛自己的店时，
    // 若放行商家令牌，carts.customerId 会指向商家账号，
    // 于是商家在前台平白多出一台「消费者购物车」。
    const response = await http(app)
      .get('/api/v1/cart')
      .set('authorization', `Bearer ${merchant.token}`)
      .set('x-tenant-subdomain', merchant.subdomain);

    expect(response.status).toBe(403);
  });

  // ---- 购物车条目的改与删 ----

  it('改数量与删除条目', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '可改可删的商品');

    const added = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 2 })
      .expect(201);
    const itemId = cartBody(added).items[0].id;
    const cookieHeader = Array.isArray(added.headers['set-cookie'])
      ? added.headers['set-cookie'].join(';')
      : String(added.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    const patched = await http(app)
      .patch(`/api/v1/cart/items/${itemId}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .send({ quantity: 5 })
      .expect(200);
    expect(cartBody(patched).items[0].quantity).toBe(5);

    await http(app)
      .delete(`/api/v1/cart/items/${itemId}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(204);

    const after = await http(app)
      .get('/api/v1/cart')
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);
    expect(cartBody(after).items).toHaveLength(0);
  });

  it('购物车响应里带商品名与单价（购物车页要显示、要算合计金额）', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '重磅纯棉T恤', 12900);

    const added = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 2 })
      .expect(201);

    const item = cartBody(added).items[0];
    // SKU 与商品名
    expect(item.sku.id).toBe(skuId);
    expect(item.sku.product.name).toBe('重磅纯棉T恤');
    // 单价：整数分，与建档时一致
    expect(item.sku.price).toBe(12900);

    // 再读一次，形状一样（GET 与 POST 返回的是同一个 read() 的结果）
    const cookieHeader = Array.isArray(added.headers['set-cookie'])
      ? added.headers['set-cookie'].join(';')
      : String(added.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    const read = await http(app)
      .get('/api/v1/cart')
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);
    const readItem = cartBody(read).items[0];
    expect(readItem.sku.product.name).toBe('重磅纯棉T恤');
    expect(readItem.sku.price).toBe(12900);
  });

  it('清空购物车', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '清空用商品');

    const added = await http(app)
      .post('/api/v1/cart/items')
      .set('x-tenant-subdomain', merchant.subdomain)
      .send({ skuId, quantity: 2 })
      .expect(201);
    const cookieHeader = Array.isArray(added.headers['set-cookie'])
      ? added.headers['set-cookie'].join(';')
      : String(added.headers['set-cookie']);
    const cookie = cookieHeader.split(';')[0];

    await http(app)
      .delete('/api/v1/cart')
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(204);

    const after = await http(app)
      .get('/api/v1/cart')
      .set('x-tenant-subdomain', merchant.subdomain)
      .set('cookie', cookie)
      .expect(200);
    expect(cartBody(after).items).toHaveLength(0);
  });

  it('登录用户的购物车不带 cookie 也认得出来', async () => {
    const merchant = await createMerchant(app, prisma);
    const skuId = await publishSku(merchant.token, '登录加购的商品');
    const customer = await registerCustomer(merchant.subdomain);

    await http(app)
      .post('/api/v1/cart/items')
      .set('authorization', `Bearer ${customer.token}`)
      .send({ skuId, quantity: 2 })
      .expect(201);

    const cart = await http(app)
      .get('/api/v1/cart')
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(cartBody(cart).items).toHaveLength(1);
    expect(cartBody(cart).items[0].quantity).toBe(2);
  });

  // ---- 地址簿（护栏 19 / 20）----

  it('地址簿：新增、列出、修改、删除', async () => {
    const merchant = await createMerchant(app, prisma);
    const customer = await registerCustomer(merchant.subdomain);

    const created = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${customer.token}`)
      .send({
        receiver: '张三',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      })
      .expect(201);
    const addressId = addressBody(created).id;

    const list = await http(app)
      .get('/api/v1/addresses')
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(addressListBody(list).items).toHaveLength(1);

    await http(app)
      .patch(`/api/v1/addresses/${addressId}`)
      .set('authorization', `Bearer ${customer.token}`)
      .send({ receiver: '李四' })
      .expect(200);

    const updated = await http(app)
      .get('/api/v1/addresses')
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(addressListBody(updated).items[0].receiver).toBe('李四');

    await http(app)
      .delete(`/api/v1/addresses/${addressId}`)
      .set('authorization', `Bearer ${customer.token}`)
      .expect(204);

    const afterDelete = await http(app)
      .get('/api/v1/addresses')
      .set('authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(addressListBody(afterDelete).items).toHaveLength(0);
  });

  it('默认地址唯一：设第二个默认地址时旧的自动取消', async () => {
    const merchant = await createMerchant(app, prisma);
    const customer = await registerCustomer(merchant.subdomain);

    const first = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${customer.token}`)
      .send({
        receiver: '默认地址甲',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '甲地址',
        isDefault: true,
      })
      .expect(201);
    const firstId = addressBody(first).id;
    expect(addressBody(first).isDefault).toBe(true);

    const second = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${customer.token}`)
      .send({
        receiver: '默认地址乙',
        phone: '13800000001',
        province: '江苏省',
        city: '南京市',
        district: '鼓楼区',
        detail: '乙地址',
        isDefault: true,
      })
      .expect(201);
    const secondId = addressBody(second).id;

    // 查库确认：同一个消费者只有一条 isDefault = true
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.address.findMany({
        where: { customerId: customer.userId, isDefault: true },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(secondId);

    // 旧的那条被自动取消了默认
    const old = await asTenant(merchant.tenantId, () =>
      prisma.address.findMany({ where: { id: firstId } }),
    );
    expect(old[0].isDefault).toBe(false);
  });

  it('地址的 customerId 必须属于当前租户', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const customerOfA = await registerCustomer(a.subdomain);

    // ---- 攻击路径 1：请求体里带 customerId，想把地址挂到别人账号下 ----
    // DTO 不接受 customerId（forbidNonWhitelisted 直接 400），
    // 归属只能由服务端从登录身份推导。
    const withCustomerId = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${customerOfA.token}`)
      .set('x-tenant-subdomain', a.subdomain)
      .send({
        receiver: '跨租户',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '不该建成',
        customerId: customerOfA.userId,
      });
    expect(withCustomerId.status).toBe(400);

    // ---- 攻击路径 2：商家令牌建地址 ----
    // 商家不是消费者，地址不该挂在商家名下。
    const withMerchantToken = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${a.token}`)
      .set('x-tenant-subdomain', a.subdomain)
      .send({
        receiver: '商家',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '不该建成',
      });
    expect(withMerchantToken.status).toBeGreaterThanOrEqual(400);
    expect(withMerchantToken.status).toBeLessThan(500);

    // ---- 攻击路径 3：B 店上下文里查不到 A 店的消费者 ----
    // Address 刻意不声明 tenant 关系（外键不带 tenantId，数据库挡不住跨租户挂载），
    // 归属只能由 service 层显式校验。这里直接验证那道闸门：
    // 在 B 的租户上下文里按 A 的 customerId 查 User —— 扩展的 tenantId 过滤
    // 会让它查不到，于是 assertCustomerInTenant 必然拒绝。
    const foundInB = await asTenant(b.tenantId, () =>
      prisma.user.findFirst({
        where: { id: customerOfA.userId, role: 'CUSTOMER' },
      }),
    );
    expect(foundInB).toBeNull();

    const foundInA = await asTenant(a.tenantId, () =>
      prisma.user.findFirst({
        where: { id: customerOfA.userId, role: 'CUSTOMER' },
      }),
    );
    expect(foundInA).not.toBeNull();

    // 查库确认上面两次被拒的请求没有留下任何地址
    const rows = await asTenant(a.tenantId, () =>
      prisma.address.findMany({ where: { customerId: customerOfA.userId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('地址簿需要登录，匿名访问被拒', async () => {
    const merchant = await createMerchant(app, prisma);

    const response = await http(app)
      .get('/api/v1/addresses')
      .set('x-tenant-subdomain', merchant.subdomain);
    expect(response.status).toBe(401);
  });

  it('不能操作别的消费者的地址', async () => {
    const merchant = await createMerchant(app, prisma);
    const customerOne = await registerCustomer(merchant.subdomain);
    const customerTwo = await registerCustomer(merchant.subdomain);

    const created = await http(app)
      .post('/api/v1/addresses')
      .set('authorization', `Bearer ${customerOne.token}`)
      .send({
        receiver: '甲的地址',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '甲地址',
      })
      .expect(201);
    const addressId = addressBody(created).id;

    const response = await http(app)
      .patch(`/api/v1/addresses/${addressId}`)
      .set('authorization', `Bearer ${customerTwo.token}`)
      .send({ receiver: '被改了' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    // 查库确认地址没被改
    const rows = await asTenant(merchant.tenantId, () =>
      prisma.address.findMany({ where: { id: addressId } }),
    );
    expect(rows[0].receiver).toBe('甲的地址');
  });
});
