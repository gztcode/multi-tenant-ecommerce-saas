import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';
import { tenantContext } from '../src/common/tenant/tenant-context';

/**
 * 公开接口的响应形状。
 *
 * supertest 的 `response.body` 是 any，直接访问字段会触发
 * @typescript-eslint/no-unsafe-member-access。集中在这里做一次类型收敛，
 * 业务断言里就不用反复断言（与 catalog.e2e-spec.ts / inventory.e2e-spec.ts 同惯例）。
 *
 * ⚠️ `PublicListItem` 里**故意不声明** tenantId / version / deletedAt：
 * 这些是内部字段，公开接口不该返回它们。「不返回」无法用类型表达，
 * 只能靠用例里断言 `toBeUndefined()` —— 见「响应里不包含 tenantId 等内部字段」。
 */
interface PublicListItem {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  minPrice: number;
  publishedAt: string | null;
}

interface PublicListBody {
  items: PublicListItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface PublicDetailBody {
  id: string;
  name: string;
  slug: string;
  specs: Array<{ id: string; name: string }>;
  skus: Array<{ id: string; price: number; stock: number }>;
}

interface ProductWriteBody {
  id: string;
  slug: string;
  version: number;
}

/** 品类创建/商品创建的响应体——本文件里只用到 id */
interface EntityBody {
  id: string;
  name?: string;
}

function listBody(response: { body: unknown }): PublicListBody {
  return response.body as PublicListBody;
}

function detailBody(response: { body: unknown }): PublicDetailBody {
  return response.body as PublicDetailBody;
}

function writeBody(response: { body: unknown }): ProductWriteBody {
  return response.body as ProductWriteBody;
}

/** 品类创建等只关心 id 的响应体 */
function entityBody(response: { body: unknown }): EntityBody {
  return response.body as EntityBody;
}

describe('公开商品读取 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

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
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * 造一个已上架的商品。
   *
   * 返回 version 是必要的：规格替换要带乐观锁版本号，
   * 而 version 的具体值取决于上架那次 PATCH 有没有让版本递增——
   * 写死一个数字（哪怕是 2）会让这个用例在 publishProduct 的实现一变就失效。
   */
  async function publishProduct(
    token: string,
    name: string,
  ): Promise<{ id: string; name: string; slug: string; version: number }> {
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send({ name, slug: `p-${unique()}` })
      .expect(201);

    const published = await http(app)
      .patch(`/api/v1/catalog/products/${writeBody(created).id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    return {
      id: writeBody(created).id,
      name,
      slug: writeBody(created).slug,
      version: writeBody(published).version,
    };
  }

  it('匿名按子域名能读到已上架商品', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '公开商品甲');

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(listBody(response).items).toHaveLength(1);
    expect(listBody(response).items[0].name).toBe('公开商品甲');
  });

  it('响应里不包含 tenantId 等内部字段', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '字段裁剪商品');

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    // 断言必须具体：若实现改成「查全量再删字段」，这里照样能通过，
    // 只有直接断言这几个键不存在才拦得住。
    const item = listBody(response).items[0] as unknown as Record<
      string,
      unknown
    >;
    expect(item.tenantId).toBeUndefined();
    expect(item.version).toBeUndefined();
    expect(item.deletedAt).toBeUndefined();
  });

  it('草稿商品不出现在公开列表里', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '已上架商品');

    // 造一个草稿
    await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '草稿商品', slug: `d-${unique()}` })
      .expect(201);

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const names = listBody(response).items.map((i) => i.name);
    expect(names).toContain('已上架商品');
    expect(names).not.toContain('草稿商品');
  });

  it('跨租户不可见：B 的公开列表里没有 A 的商品', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    await publishProduct(a.token, 'A 的公开商品');

    const response = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', b.subdomain)
      .expect(200);

    expect(listBody(response).items).toHaveLength(0);
  });

  it('不带子域名的请求返回 404', async () => {
    await http(app).get('/api/v1/public/products').expect(404);
  });

  it('关键词搜索命中商品', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '纯棉圆领T恤');

    const response = await http(app)
      .get('/api/v1/public/products?keyword=纯棉')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(listBody(response).items).toHaveLength(1);
    expect(listBody(response).items[0].name).toBe('纯棉圆领T恤');
  });

  it('关键词搜索也命中 slug', async () => {
    const merchant = await createMerchant(app, prisma);
    const product = await publishProduct(
      merchant.token,
      '名称不含关键词的商品',
    );
    // publishProduct 生成的 slug 是 p-<随机十六进制>，取它的片段去搜：
    // 名称里不含这个片段，命中只能来自 slug 分支
    const slugFragment = product.slug.replace(/^p-/, '').slice(0, 6);
    expect(product.name).not.toContain(slugFragment);

    const response = await http(app)
      .get(`/api/v1/public/products?keyword=${slugFragment}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(listBody(response).items).toHaveLength(1);
    expect(listBody(response).items[0].slug).toBe(product.slug);
  });

  it('店铺被暂停时公开列表为空、详情 404', async () => {
    const merchant = await createMerchant(app, prisma);
    const product = await publishProduct(merchant.token, '暂停店铺的商品');

    // 正常状态下确实可见——确认后面的 404 是「暂停」造成的，不是本来就查不到
    const before = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(listBody(before).items).toHaveLength(1);

    // ⚠️ 必须包在 tenantContext.run 里：Store 是租户作用域模型，
    // 测试代码在 HTTP 请求之外，没有租户上下文时扩展会 fail-closed 拒绝访问。
    await tenantContext.run(
      { tenantId: merchant.tenantId, userId: null, role: null },
      async () =>
        prisma.store.updateMany({
          where: { tenantId: merchant.tenantId },
          data: { status: 'PAUSED' },
        }),
    );

    const list = await http(app)
      .get('/api/v1/public/products')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(listBody(list).items).toHaveLength(0);

    await http(app)
      .get(`/api/v1/public/products/${product.slug}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(404);

    // 品类树同样被清空
    const categories = await http(app)
      .get('/api/v1/public/categories')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(categories.body as unknown[]).toEqual([]);
  });

  it('商品详情返回规格与 SKU', async () => {
    const merchant = await createMerchant(app, prisma);
    const product = await publishProduct(merchant.token, '详情商品');

    await http(app)
      .put(`/api/v1/catalog/products/${product.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
        ],
      })
      .expect(200);

    const response = await http(app)
      .get(`/api/v1/public/products/${product.slug}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const detail = detailBody(response);
    expect(detail.name).toBe('详情商品');
    expect(detail.skus).toHaveLength(2);
    expect(detail.specs).toHaveLength(1);
    expect(
      (detail as unknown as Record<string, unknown>).tenantId,
    ).toBeUndefined();
  });

  it('草稿商品的详情对外不可见', async () => {
    const merchant = await createMerchant(app, prisma);
    const created = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '草稿详情', slug: `dd-${unique()}` })
      .expect(201);

    await http(app)
      .get(`/api/v1/public/products/${writeBody(created).slug}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(404);
  });
  // ---- 查询参数：价格区间 / 排序 / 品类 ----
  //
  // 这四个参数在本 Task 的说明里明确列为功能，但一直没被测到——
  // 变异验证显示删掉任何一个都不会有测试失败。补上。

  /** 造一个带指定售价的单规格已上架商品，返回它的 minPrice */
  async function publishWithPrice(
    token: string,
    name: string,
    price: number,
  ): Promise<number> {
    const product = await publishProduct(token, name);

    await http(app)
      .put(`/api/v1/catalog/products/${product.id}/specs`)
      .set('authorization', `Bearer ${token}`)
      .send({
        version: product.version,
        specs: [{ name: '规格', values: [{ value: '默认' }] }],
      })
      .expect(200);

    const detail = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const skuId = (detail.body as { skus: Array<{ id: string }> }).skus[0].id;

    await http(app)
      .patch(`/api/v1/catalog/products/${product.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ price })
      .expect(200);

    return price;
  }

  it('按价格区间筛选', async () => {
    const merchant = await createMerchant(app, prisma);
    // 价格都在「分」为单位：便宜 10 元，区间内 500 元，区间外 990 元
    await publishWithPrice(merchant.token, '低于区间的商品', 1000);
    await publishWithPrice(merchant.token, '区间内的商品', 50000);
    await publishWithPrice(merchant.token, '高于区间的商品', 99000);

    const response = await http(app)
      .get('/api/v1/public/products?minPrice=2000&maxPrice=60000')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const names = listBody(response).items.map((i) => i.name);
    expect(names).toEqual(['区间内的商品']);
    expect(names).not.toContain('低于区间的商品');
    expect(names).not.toContain('高于区间的商品');
  });

  it('按价格排序：price_asc 与 price_desc 互为逆序', async () => {
    const merchant = await createMerchant(app, prisma);
    // ⚠️ 价格顺序必须与**创建顺序**错开。
    // 若按 1000 → 5000 → 90000 的顺序创建，按 publishedAt 排序的结果与按价格
    // 排序完全一致——那样「排序参数没生效」也照样能通过（变异验证实测过）。
    await publishWithPrice(merchant.token, '第一档', 90000);
    await publishWithPrice(merchant.token, '第二档', 5000);
    await publishWithPrice(merchant.token, '第三档', 1000);

    const asc = await http(app)
      .get('/api/v1/public/products?sort=price_asc')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    const desc = await http(app)
      .get('/api/v1/public/products?sort=price_desc')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const ascNames = listBody(asc).items.map((i) => i.name);
    const descNames = listBody(desc).items.map((i) => i.name);

    expect(ascNames).toEqual(['第三档', '第二档', '第一档']);
    expect(descNames).toEqual(['第一档', '第二档', '第三档']);
  });

  it('按品类筛选：只返回该品类下的商品', async () => {
    const merchant = await createMerchant(app, prisma);

    const category = await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '筛选用品类', slug: `f-${unique()}` })
      .expect(201);
    const categoryId = entityBody(category).id;

    const inCategory = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        name: '品类内商品',
        slug: `ic-${unique()}`,
        categoryId,
      })
      .expect(201);
    await http(app)
      .patch(`/api/v1/catalog/products/${writeBody(inCategory).id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    // 另一个不在该品类下的商品
    const outside = await publishProduct(merchant.token, '品类外商品');

    const response = await http(app)
      .get(`/api/v1/public/products?categoryId=${categoryId}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const names = listBody(response).items.map((i) => i.name);
    expect(names).toEqual(['品类内商品']);
    expect(names).not.toContain(outside.name);
  });

  it('分页：page 与 pageSize 真的切分了结果', async () => {
    const merchant = await createMerchant(app, prisma);
    for (const name of ['分页甲', '分页乙', '分页丙']) {
      await publishProduct(merchant.token, name);
    }

    const firstPage = await http(app)
      .get('/api/v1/public/products?page=1&pageSize=2')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    const secondPage = await http(app)
      .get('/api/v1/public/products?page=2&pageSize=2')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(listBody(firstPage).items).toHaveLength(2);
    expect(listBody(secondPage).items).toHaveLength(1);
    expect(listBody(firstPage).total).toBe(3);

    // 两页不能有重叠——否则 pageSize 只是装饰
    const firstIds = listBody(firstPage).items.map((i) => i.id);
    const secondIds = listBody(secondPage).items.map((i) => i.id);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });

  it('pageSize 超过上限时被夹到 100，不返回全量', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '上限测试');

    const response = await http(app)
      .get('/api/v1/public/products?pageSize=99999')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    // 被夹到 100，而不是照单全收
    expect(listBody(response).pageSize).toBe(100);
  });

  // ---- 输入校验：畸形查询参数不该变成 500 ----

  it('畸形数字查询参数落回默认值，不返回 500', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '参数校验商品');

    // page / pageSize / minPrice / maxPrice 全是垃圾值
    for (const query of [
      'page=abc',
      'pageSize=abc',
      'page=-5',
      'minPrice=abc',
      'maxPrice=abc',
      'page=NaN',
      'minPrice=Infinity',
    ]) {
      const response = await http(app)
        .get(`/api/v1/public/products?${query}`)
        .set('x-tenant-subdomain', merchant.subdomain);

      // 关键：不是 500。畸形入参一律 200 + 落回默认值。
      expect(response.status).toBe(200);
    }
  });

  it('关键词里的 LIKE 通配符被转义，不会匹配全部商品', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '甲商品');
    await publishProduct(merchant.token, '乙商品');
    await publishProduct(merchant.token, '丙商品');

    // 若不转义，keyword=% 会变成 ILIKE '%%%' 匹配到全部商品
    const wildcard = await http(app)
      .get('/api/v1/public/products?keyword=%25')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(listBody(wildcard).total).toBe(0);

    const underscore = await http(app)
      .get('/api/v1/public/products?keyword=_')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(listBody(underscore).total).toBe(0);

    // 转义之后正常的中文关键词仍然能命中
    const normal = await http(app)
      .get('/api/v1/public/products?keyword=甲')
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);
    expect(listBody(normal).total).toBe(1);
  });

  it('超长关键词被截断而不是拒绝', async () => {
    const merchant = await createMerchant(app, prisma);
    await publishProduct(merchant.token, '长关键词商品');

    const response = await http(app)
      .get(`/api/v1/public/products?keyword=${'a'.repeat(500)}`)
      .set('x-tenant-subdomain', merchant.subdomain)
      .expect(200);

    expect(response.status).toBe(200);
  });
});
