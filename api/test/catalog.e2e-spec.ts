import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

interface CategoryResponseBody {
  id: string;
  tenantId: string;
  parentId: string | null;
  name: string;
  slug: string;
  sort: number;
  deletedAt: string | null;
}

/** supertest 的 response.body 是 any，集中做一次类型收敛，业务代码里就不用断言 */
function categoryBody(response: { body: unknown }): CategoryResponseBody {
  return response.body as CategoryResponseBody;
}

/** 创建品类并返回解析后的响应体，省掉每个用例里的 as 断言 */
async function createCategory(
  app: INestApplication,
  token: string,
  payload: { name: string; slug: string; parentId?: string },
): Promise<CategoryResponseBody> {
  const response = await http(app)
    .post('/api/v1/catalog/categories')
    .set('authorization', `Bearer ${token}`)
    .send(payload)
    .expect(201);
  return categoryBody(response);
}

/** 树节点：品类本体加上递归的 children，够用来断言层级结构 */
type CategoryNode = CategoryResponseBody & { children: CategoryNode[] };

interface ProductResponseBody {
  id: string;
  tenantId: string;
  categoryId: string | null;
  name: string;
  slug: string;
  status: string;
  minPrice: number;
  version: number;
  publishedAt: string | null;
  deletedAt: string | null;
}

/** 商品详情的媒体关联行 */
interface ProductMediaRow {
  id: string;
  productId: string;
  mediaId: string;
  sort: number;
}

/** 列表响应：分页信封 */
interface ProductListBody {
  items: ProductResponseBody[];
  total: number;
  page: number;
  pageSize: number;
}

/** 批量操作响应 */
interface BatchResponseBody {
  updated: number;
}

/** 与 categoryBody 同理：supertest 的 body 是 any，收敛一次后业务代码里不必再断言 */
function productBody(response: { body: unknown }): ProductResponseBody {
  return response.body as ProductResponseBody;
}

function productListBody(response: { body: unknown }): ProductListBody {
  return response.body as ProductListBody;
}

function batchBody(response: { body: unknown }): BatchResponseBody {
  return response.body as BatchResponseBody;
}

/** 商品详情里挂着的媒体关联行 */
function mediaRows(response: { body: unknown }): ProductMediaRow[] {
  const product = response.body as { media?: ProductMediaRow[] };
  return product.media ?? [];
}

/** 规格矩阵替换接口的响应体（商品 + 规格维度与取值 + SKU 骨架） */
interface SpecMatrixResponseBody extends ProductResponseBody {
  specs: Array<{
    id: string;
    name: string;
    values: Array<{ id: string; value: string }>;
  }>;
  skus: Array<{
    id: string;
    price: number;
    status: string;
    specValues: Array<{ valueId: string }>;
  }>;
}

function specMatrixBody(response: { body: unknown }): SpecMatrixResponseBody {
  return response.body as SpecMatrixResponseBody;
}

/** 单个 SKU 更新接口的响应体 */
interface SkuResponseBody {
  id: string;
  price: number;
  status: string;
}

function skuBody(response: { body: unknown }): SkuResponseBody {
  return response.body as SkuResponseBody;
}

/**
 * 品类 (e2e)
 *
 * 这个套件要证明三件事：
 * 1. 层级深度限制真的生效——创建第 4 层会被 400 挡住；
 * 2. 租户隔离在品类上真的生效——别的商家的品类既看不见也改不动，
 *    拿它的 id 来挂子品类也会被拒（外键只引用 id，数据库层面挡不住跨租户挂载，
 *    必须由服务层查一次归属）；
 * 3. 删除是软删除——删掉的品类不再出现在树里，但记录仍在库里。
 */
describe('品类 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致
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

  it('创建一级品类', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await createCategory(app, merchant.token, {
      name: '女装',
      slug: `women-${unique()}`,
    });

    expect(created.name).toBe('女装');
    expect(created.parentId).toBeNull();
    expect(created.tenantId).toBe(merchant.tenantId);
    expect(created.deletedAt).toBeNull();
  });

  it('创建三级品类成功，创建第四级被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const level1 = await createCategory(app, merchant.token, {
      name: '一级',
      slug: `l1-${unique()}`,
    });

    const level2 = await createCategory(app, merchant.token, {
      name: '二级',
      slug: `l2-${unique()}`,
      parentId: level1.id,
    });

    const level3 = await createCategory(app, merchant.token, {
      name: '三级',
      slug: `l3-${unique()}`,
      parentId: level2.id,
    });

    await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '四级', slug: `l4-${unique()}`, parentId: level3.id })
      .expect(400);
  });

  it('跨租户不可见：别的商家的品类不在我的品类树里', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    await createCategory(app, a.token, {
      name: 'A 的品类',
      slug: `a-${unique()}`,
    });

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);

    expect(tree.body).toEqual([]);
  });

  it('跨租户不可改：改别人的品类返回 404', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const created = await createCategory(app, a.token, {
      name: 'A 的品类',
      slug: `a-${unique()}`,
    });

    await http(app)
      .patch(`/api/v1/catalog/categories/${created.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ name: '被篡改' })
      .expect(404);
  });

  it('把品类挂到别的租户的父品类下被拒绝', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const aCategory = await createCategory(app, a.token, {
      name: 'A 的父品类',
      slug: `ap-${unique()}`,
    });

    await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${b.token}`)
      .send({
        name: 'B 的子品类',
        slug: `bc-${unique()}`,
        parentId: aCategory.id,
      })
      .expect(400);
  });

  it('删除品类是软删除：删掉后不再出现在树里', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await createCategory(app, merchant.token, {
      name: '待删品类',
      slug: `del-${unique()}`,
    });

    await http(app)
      .delete(`/api/v1/catalog/categories/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(204);

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    expect(tree.body).toEqual([]);
  });

  it('有子品类的品类不能直接删', async () => {
    const merchant = await createMerchant(app, prisma);

    const parent = await createCategory(app, merchant.token, {
      name: '父品类',
      slug: `p-${unique()}`,
    });
    await createCategory(app, merchant.token, {
      name: '子品类',
      slug: `c-${unique()}`,
      parentId: parent.id,
    });

    await http(app)
      .delete(`/api/v1/catalog/categories/${parent.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(400);
  });

  it('品类不能挂到自己下面', async () => {
    const merchant = await createMerchant(app, prisma);

    const category = await createCategory(app, merchant.token, {
      name: '自己',
      slug: `self-${unique()}`,
    });

    await http(app)
      .patch(`/api/v1/catalog/categories/${category.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ parentId: category.id })
      .expect(400);
  });

  it('父品类留空 / 置 null 可以提到一级', async () => {
    const merchant = await createMerchant(app, prisma);

    const root = await createCategory(app, merchant.token, {
      name: '根',
      slug: `root-${unique()}`,
    });
    const child = await createCategory(app, merchant.token, {
      name: '孩子',
      slug: `kid-${unique()}`,
      parentId: root.id,
    });

    // 提到一级：树里应当出现两个根节点
    const updated = await http(app)
      .patch(`/api/v1/catalog/categories/${child.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ parentId: null })
      .expect(200);

    expect(categoryBody(updated).parentId).toBeNull();

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    expect(tree.body).toHaveLength(2);
    expect(
      (tree.body as CategoryResponseBody[]).map((node) => node.name).sort(),
    ).toEqual(['孩子', '根']);
  });

  it('改父节点同样校验深度：挂到第三级下面被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const level1 = await createCategory(app, merchant.token, {
      name: '一',
      slug: `d1-${unique()}`,
    });
    const level2 = await createCategory(app, merchant.token, {
      name: '二',
      slug: `d2-${unique()}`,
      parentId: level1.id,
    });
    const level3 = await createCategory(app, merchant.token, {
      name: '三',
      slug: `d3-${unique()}`,
      parentId: level2.id,
    });
    const other = await createCategory(app, merchant.token, {
      name: '另一个一级',
      slug: `do-${unique()}`,
    });

    // other 原本是一级，挂到 level3（第 3 层）下面就成了第 4 层，必须被拒。
    // 更新路径与创建路径走的是同一套深度校验，两处都要挡。
    await http(app)
      .patch(`/api/v1/catalog/categories/${other.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ parentId: level3.id })
      .expect(400);
  });

  it('带子树的品类被挂到同级父节点下被拒绝：子树会整体下沉超出层数上限', async () => {
    const merchant = await createMerchant(app, prisma);

    // A（一级）下有 B、C 两个二级，C 下面还有一个三级的 E。
    const a = await createCategory(app, merchant.token, {
      name: 'A',
      slug: `sa-${unique()}`,
    });
    const b = await createCategory(app, merchant.token, {
      name: 'B',
      slug: `sb-${unique()}`,
      parentId: a.id,
    });
    const c = await createCategory(app, merchant.token, {
      name: 'C',
      slug: `sc-${unique()}`,
      parentId: a.id,
    });
    const e = await createCategory(app, merchant.token, {
      name: 'E',
      slug: `se-${unique()}`,
      parentId: c.id,
    });

    // 新父 B 在第 2 层，depthOf(B)=2 < 3 单独看是合法的；
    // 但 C 会被移到第 3 层，它的孩子 E 就掉到第 4 层，超出上限。
    await http(app)
      .patch(`/api/v1/catalog/categories/${c.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ parentId: b.id })
      .expect(400);

    // 400 本身不能说明问题（可能来自别的校验），所以再查一次树确认结构没被动过：
    // C 仍挂在 A 下，E 仍是 C 的孩子，层级没有变化。
    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const nodes = tree.body as CategoryNode[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(a.id);
    const level2 = nodes[0].children;
    expect(level2.map((node) => node.id).sort()).toEqual([b.id, c.id].sort());
    const cNode = level2.find((node) => node.id === c.id);
    expect(cNode?.children.map((node) => node.id)).toEqual([e.id]);
  });

  it('品类不能挂到自己的子孙下面', async () => {
    const merchant = await createMerchant(app, prisma);

    const a = await createCategory(app, merchant.token, {
      name: '祖',
      slug: `cy-a-${unique()}`,
    });
    const b = await createCategory(app, merchant.token, {
      name: '父',
      slug: `cy-b-${unique()}`,
      parentId: a.id,
    });
    const c = await createCategory(app, merchant.token, {
      name: '子',
      slug: `cy-c-${unique()}`,
      parentId: b.id,
    });

    // 把 A 挂到 C（A 的孙子）下面会在库里形成环。
    // 这里必须断言错误文案本身：光断言 400 挡不住回归——环一旦形成，
    // 后面的子树高度递归撞上栈溢出，同样会返回 400，测试却照样是绿的。
    const rejected = await http(app)
      .patch(`/api/v1/catalog/categories/${a.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ parentId: c.id })
      .expect(400);

    expect((rejected.body as { message: string }).message).toContain(
      '品类不能挂到自己的子孙下面',
    );

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(tree.body).toHaveLength(1);
  });

  it('不带子节点的同级品类可以正常换父：不该误拒', async () => {
    const merchant = await createMerchant(app, prisma);

    const a = await createCategory(app, merchant.token, {
      name: 'A',
      slug: `ok-a-${unique()}`,
    });
    const b = await createCategory(app, merchant.token, {
      name: 'B',
      slug: `ok-b-${unique()}`,
      parentId: a.id,
    });
    const leaf = await createCategory(app, merchant.token, {
      name: '叶子',
      slug: `ok-leaf-${unique()}`,
      parentId: a.id,
    });

    // B 在第 2 层，叶子自身是 1 层，2 + 1 = 3 正好卡在上限，应当通过。
    await http(app)
      .patch(`/api/v1/catalog/categories/${leaf.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ parentId: b.id })
      .expect(200);

    const tree = await http(app)
      .get('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const nodes = tree.body as CategoryNode[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].children[0].id).toBe(b.id);
    expect(nodes[0].children[0].children.map((node) => node.id)).toEqual([
      leaf.id,
    ]);
  });

  it('不允许传 tenantId 以外的未知字段', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/catalog/categories')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        name: '越权写入',
        slug: `hack-${unique()}`,
        // 试图指定别的租户：ValidationPipe 的 forbidNonWhitelisted 直接 400，
        // 扩展注入的 tenantId 也不会被这个值影响
        tenantId: 'someone-else',
      })
      .expect(400);
  });

  it('不带 token 的请求被拒绝', async () => {
    await http(app).get('/api/v1/catalog/categories').expect(401);
  });
});

/**
 * 商品 (e2e)
 *
 * 这个套件要证明五件事：
 * 1. 创建出来的商品是草稿状态，minPrice 初始为 0，version 从 1 起；
 * 2. 租户隔离在商品上真的生效——别的商家既看不到也改不动；
 * 3. 上架会写 publishedAt，乐观锁在 version 不匹配时挡下写入；
 * 4. 删除是软删除，删掉的商品不再出现在列表里；
 * 5. 关联对象（媒体）跨租户不可引用，批量操作按租户圈定作用范围。
 *
 * 与品类套件共用同一个 beforeAll 之外的应用实例，所以这里单独起一个 describe。
 */
describe('商品 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致
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

  /** 建商品并返回解析后的响应体，省掉每个用例里的 as 断言 */
  async function createProduct(
    token: string,
    payload: { name: string; slug: string; categoryId?: string },
  ): Promise<ProductResponseBody> {
    const response = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    return productBody(response);
  }

  it('创建商品默认是草稿状态，minPrice 为 0', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await createProduct(merchant.token, {
      name: '经典圆领 T 恤',
      slug: `tee-${unique()}`,
    });

    expect(created.status).toBe('DRAFT');
    expect(created.minPrice).toBe(0);
    expect(created.version).toBe(1);
  });

  it('商品归属当前租户：别的租户看不到也改不了', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const created = await createProduct(a.token, {
      name: 'A 的商品',
      slug: `pa-${unique()}`,
    });

    await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(404);

    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ name: '被篡改' })
      .expect(404);

    // 404 不能自证是「隔离生效」而不是别的 404——回到 A 自己的视角看一眼，
    // 确认这条商品确实存在、名字也没被 B 改掉。
    const stillMine = await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(productBody(stillMine).name).toBe('A 的商品');
  });

  it('上架商品写入 publishedAt', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await createProduct(merchant.token, {
      name: '待上架商品',
      slug: `pub-${unique()}`,
    });
    expect(created.publishedAt).toBeNull();

    const published = await http(app)
      .patch(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    const body = productBody(published);
    expect(body.status).toBe('PUBLISHED');
    expect(body.publishedAt).toBeTruthy();

    // 重复上架保留原 publishedAt，不被刷新成新时间
    const again = await http(app)
      .patch(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'UNPUBLISHED' })
      .expect(200);
    expect(productBody(again).publishedAt).toBe(body.publishedAt);
  });

  it('乐观锁：version 不匹配时返回 409', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await createProduct(merchant.token, {
      name: '并发编辑商品',
      slug: `cc-${unique()}`,
    });

    // 第一次更新成功，version 递增
    const updated = await http(app)
      .patch(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '第一次改名', version: created.version })
      .expect(200);

    // version 必须真的递增了，否则这条用例测不到乐观锁
    const updatedBody = productBody(updated);
    expect(updatedBody.version).toBe(created.version + 1);
    expect(updatedBody.name).toBe('第一次改名');

    // 第二次用旧的 version，冲突
    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '第二次改名', version: created.version })
      .expect(409);

    // 409 不能自证是「乐观锁挡下了」而不是别的拒绝——查一次确认第二次的写入
    // 真的没生效（否则这条用例在「什么都不做」的实现下也会绿）。
    const afterConflict = await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(afterConflict).name).toBe('第一次改名');
    expect(productBody(afterConflict).version).toBe(created.version + 1);
  });

  it('删除商品是软删除：列表里不再出现', async () => {
    const merchant = await createMerchant(app, prisma);

    const created = await createProduct(merchant.token, {
      name: '待删商品',
      slug: `dp-${unique()}`,
    });

    await http(app)
      .delete(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(204);

    const list = await http(app)
      .get('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const ids = productListBody(list).items.map((i) => i.id);
    expect(ids).not.toContain(created.id);

    // 详情也应当查不到（软删掉的记录对租户不可见）
    await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(404);
  });

  it('设置商品媒体：跨租户的媒体不可引用', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    // ⚠️ 商品必须建在 B 名下，否则「B 引用 A 的媒体」会在商品那一层就 404，
    // 根本走不到媒体归属校验——那样这条用例就测不到它想测的东西。
    const product = await createProduct(b.token, {
      name: '媒体商品',
      slug: `md-${unique()}`,
    });

    // A 造一张 READY 的媒体
    const media = await tenantContext.run(
      { tenantId: a.tenantId, userId: null, role: null },
      async () =>
        prisma.media.create({
          // as never：tenantId 由租户扩展注入，TS 不知道这回事（与
          // CategoriesService.create 里的同一个处理同因）
          data: {
            key: `t/${Date.now()}.jpg`,
            url: 'http://localhost:19000/ecommerce-media/t/x.jpg',
            mime: 'image/jpeg',
            size: 100,
            status: 'READY',
            uploadedBy: 'tester',
          } as never,
        }),
    );

    // B 引用 A 的媒体 → 400
    await http(app)
      .put(`/api/v1/catalog/products/${product.id}/media`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ mediaIds: [media.id] })
      .expect(400);

    // 400 不能自证是「媒体不可用」而不是别的拒绝——查一次关联表确认真没写进去。
    // 不加这一步的话，只要 A、B 的商品里都没有媒体，断言就恒为真。
    const afterReject = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(mediaRows(afterReject)).toEqual([]);

    // A 自己引用自己的媒体 → 200，且真的挂上了
    const aProduct = await createProduct(a.token, {
      name: 'A 的媒体商品',
      slug: `md-a-${unique()}`,
    });

    const linked = await http(app)
      .put(`/api/v1/catalog/products/${aProduct.id}/media`)
      .set('authorization', `Bearer ${a.token}`)
      .send({ mediaIds: [media.id] })
      .expect(200);

    expect(linked.body).toHaveLength(1);
    expect((linked.body as ProductMediaRow[])[0].mediaId).toBe(media.id);
  });

  it('批量上下架', async () => {
    const merchant = await createMerchant(app, prisma);

    const a = await createProduct(merchant.token, {
      name: '批量商品 A',
      slug: `ba-${unique()}`,
    });

    const b = await createProduct(merchant.token, {
      name: '批量商品 B',
      slug: `bb-${unique()}`,
    });

    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        ids: [a.id, b.id],
        action: 'PUBLISH',
      })
      .expect(200);

    expect(batchBody(response).updated).toBe(2);

    // updated 本身不能自证「两条都改到了」——逐条查一次状态。
    // 只返回数量的话，「更新了 2 条但其中一条被别的租户抢走」也会照样通过。
    for (const id of [a.id, b.id]) {
      const detail = await http(app)
        .get(`/api/v1/catalog/products/${id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200);
      expect(productBody(detail).status).toBe('PUBLISHED');
    }
  });

  it('批量操作不跨租户：B 的批量请求碰不到 A 的商品', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const aProduct = await createProduct(a.token, {
      name: 'A 的商品',
      slug: `x-a-${unique()}`,
    });

    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${b.token}`)
      .send({ ids: [aProduct.id], action: 'PUBLISH' })
      .expect(200);

    // 只数本租户的商品：别的租户的 id 在这里查不到，不该被算作「已处理」
    expect(batchBody(response).updated).toBe(0);

    const unchanged = await http(app)
      .get(`/api/v1/catalog/products/${aProduct.id}`)
      .set('authorization', `Bearer ${a.token}`)
      .expect(200);
    expect(productBody(unchanged).status).toBe('DRAFT');
  });

  it('商品不能挂到别的租户的品类下', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const aCategory = await createCategory(app, a.token, {
      name: 'A 的品类',
      slug: `pc-${unique()}`,
    });

    // 创建时挡一次
    await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${b.token}`)
      .send({
        name: 'B 的商品',
        slug: `x-${unique()}`,
        categoryId: aCategory.id,
      })
      .expect(400);

    // 更新路径走的是另一处校验，两处都要挡
    const product = await createProduct(b.token, {
      name: 'B 的商品',
      slug: `x2-${unique()}`,
    });

    await http(app)
      .patch(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .send({ categoryId: aCategory.id })
      .expect(400);

    const afterReject = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);
    expect(productBody(afterReject).categoryId).toBeNull();
  });

  it('minPrice 由 SKU 价格推导：批量改价后同步刷新', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await createProduct(merchant.token, {
      name: '改价商品',
      slug: `ap-${unique()}`,
    });

    // 塞两个 ACTIVE SKU，价格故意一高一低：最低价应当取小的那个
    await tenantContext.run(
      { tenantId: merchant.tenantId, userId: null, role: null },
      async () => {
        for (const price of [5000, 3000]) {
          await prisma.sku.create({
            data: {
              productId: product.id,
              price,
              stock: 10,
              status: 'ACTIVE',
            } as never,
          });
        }
      },
    );

    // 先按 +10% 调整：3000 → 3300，5000 → 5500，最低价应当变成 3300。
    // 若 minPrice 没跟着重算，这里会读到 0 或 5000。
    const adjusted = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        ids: [product.id],
        action: 'ADJUST_PRICE',
        mode: 'PERCENT',
        value: 10,
      })
      .expect(200);
    expect(batchBody(adjusted).updated).toBe(1);

    const detail = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(detail).minPrice).toBe(3300);

    // 再按 SET 设为 1000，最低价应当变成 1000
    const set = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        ids: [product.id],
        action: 'ADJUST_PRICE',
        mode: 'SET',
        value: 1000,
      })
      .expect(200);
    expect(batchBody(set).updated).toBe(1);

    const after = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(after).minPrice).toBe(1000);
  });

  it('INACTIVE 与软删掉的 SKU 不参与 minPrice 计算', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await createProduct(merchant.token, {
      name: '规格过滤商品',
      slug: `sf-${unique()}`,
    });

    // 三个 SKU：ACTIVE 8000、INACTIVE 1（极低，若被算进去结果就是 1）、
    // ACTIVE 但软删掉的 2。三者都不该影响 minPrice。
    await tenantContext.run(
      { tenantId: merchant.tenantId, userId: null, role: null },
      async () => {
        const data = [
          { price: 8000, status: 'ACTIVE' as const },
          { price: 1, status: 'INACTIVE' as const },
          { price: 2, status: 'ACTIVE' as const, deletedAt: new Date() },
        ];
        for (const row of data) {
          await prisma.sku.create({
            data: { productId: product.id, stock: 1, ...row } as never,
          });
        }
      },
    );

    await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        ids: [product.id],
        action: 'ADJUST_PRICE',
        mode: 'PERCENT',
        value: 0,
      })
      .expect(200);

    const detail = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    // PERCENT 0 是原值不变，但仍会触发一次重算——正好用来检验重算的过滤条件。
    // 期望 8000：INACTIVE 的 1 与软删的 2 都被排除在外。
    expect(productBody(detail).minPrice).toBe(8000);

    // 详情里的 SKU 也必须滤掉软删的那条（include 的嵌套关联不走扩展的过滤）
    const product_detail = detail.body as { skus?: Array<{ price: number }> };
    expect((product_detail.skus ?? []).map((s) => s.price)).not.toContain(2);
  });

  it('重算 minPrice 的 SQL 不跨租户：别的租户的 SKU 不参与计算', async () => {
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);

    const product = await createProduct(b.token, {
      name: 'B 的商品',
      slug: `mt-${unique()}`,
    });

    // B 自己的 ACTIVE SKU，价格 8000
    await tenantContext.run(
      { tenantId: b.tenantId, userId: null, role: null },
      async () => {
        await prisma.sku.create({
          data: {
            productId: product.id,
            price: 8000,
            stock: 1,
            status: 'ACTIVE',
          } as never,
        });
      },
    );

    // ⚠️ 用原生 SQL 造一条「属于 A、却挂在 B 的商品下」的 ACTIVE SKU，价格 1。
    // 应用层造不出来——扩展只会把 tenantId 写成当前租户，而扩展也不管外键的
    // 归属。这正是需要租户条件兜底的场景：重算的子查询若不带 tenantId，
    // 这条价格 1 的 SKU 就会把 B 的商品最低价拉到 1。
    // 产品里同样的手法也覆盖了外层 p.tenantId 的那一道条件。
    const raw = new PrismaClient();
    try {
      await raw.$executeRawUnsafe(
        `INSERT INTO skus (id, "tenantId", "productId", price, stock, status, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 1, 1, 'ACTIVE', now(), now())`,
        a.tenantId,
        product.id,
      );
    } finally {
      await raw.$disconnect();
    }

    // PERCENT 0 不改任何价格，但会触发一次重算——正好用来检验子查询的过滤
    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${b.token}`)
      .send({
        ids: [product.id],
        action: 'ADJUST_PRICE',
        mode: 'PERCENT',
        value: 0,
      })
      .expect(200);
    expect(batchBody(response).updated).toBe(1);

    const detail = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${b.token}`)
      .expect(200);

    // 期望 8000：属于别的租户、挂在同一个 productId 下的价格 1 被排除在外
    expect(productBody(detail).minPrice).toBe(8000);
  });

  it('批量删除是软删除：单条删除接口也不再认它', async () => {
    const merchant = await createMerchant(app, prisma);

    const a = await createProduct(merchant.token, {
      name: '批量删 A',
      slug: `bd-a-${unique()}`,
    });
    const b = await createProduct(merchant.token, {
      name: '批量删 B',
      slug: `bd-b-${unique()}`,
    });

    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ ids: [a.id, b.id], action: 'DELETE' })
      .expect(200);
    expect(batchBody(response).updated).toBe(2);

    for (const id of [a.id, b.id]) {
      await http(app)
        .get(`/api/v1/catalog/products/${id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(404);
    }

    const list = await http(app)
      .get('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const ids = productListBody(list).items.map((i) => i.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it('批量改分类', async () => {
    const merchant = await createMerchant(app, prisma);

    const category = await createCategory(app, merchant.token, {
      name: '目标品类',
      slug: `bc-${unique()}`,
    });
    const product = await createProduct(merchant.token, {
      name: '待归类商品',
      slug: `bg-${unique()}`,
    });

    const response = await http(app)
      .post('/api/v1/catalog/products/batch')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        ids: [product.id],
        action: 'SET_CATEGORY',
        categoryId: category.id,
      })
      .expect(200);
    expect(batchBody(response).updated).toBe(1);

    const detail = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(detail).categoryId).toBe(category.id);
  });

  it('商品可以移出分类：categoryId 传 null', async () => {
    const merchant = await createMerchant(app, prisma);

    const category = await createCategory(app, merchant.token, {
      name: '临时品类',
      slug: `tc-${unique()}`,
    });
    const product = await createProduct(merchant.token, {
      name: '有分类的商品',
      slug: `wc-${unique()}`,
      categoryId: category.id,
    });
    expect(product.categoryId).toBe(category.id);

    const cleared = await http(app)
      .patch(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ categoryId: null })
      .expect(200);
    expect(productBody(cleared).categoryId).toBeNull();
  });

  it('不允许传 minPrice / tenantId 等服务端维护的字段', async () => {
    const merchant = await createMerchant(app, prisma);

    // minPrice 是派生字段，客户端不许直接写：否则商品列表的排序与价格区间筛选
    // 会被任意伪造，且与 SKU 的真实价格永久脱节。
    await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        name: '伪造价格',
        slug: `fp-${unique()}`,
        minPrice: 1,
      })
      .expect(400);

    await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        name: '越权写入',
        slug: `ft-${unique()}`,
        tenantId: 'someone-else',
      })
      .expect(400);

    // 更新路径同样不接受
    const product = await createProduct(merchant.token, {
      name: '正常商品',
      slug: `fn-${unique()}`,
    });

    await http(app)
      .patch(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ minPrice: 1 })
      .expect(400);

    // slug 也不许改（改了旧链接失效，阶段 2 不做重定向）
    await http(app)
      .patch(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ slug: `renamed-${unique()}` })
      .expect(400);

    const unchanged = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(unchanged).minPrice).toBe(0);
    expect(productBody(unchanged).slug).toBe(product.slug);
  });

  it('列表支持关键词与状态筛选', async () => {
    const merchant = await createMerchant(app, prisma);

    const keyword = `kw${unique()}`;
    const hit = await createProduct(merchant.token, {
      name: `匹配商品 ${keyword}`,
      slug: `hit-${unique()}`,
    });
    await createProduct(merchant.token, {
      name: '不相关的商品',
      slug: `miss-${unique()}`,
    });

    const list = await http(app)
      .get(`/api/v1/catalog/products?keyword=${keyword}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);

    const body = productListBody(list);
    expect(body.items.map((i) => i.id)).toEqual([hit.id]);

    // 状态筛选：只有 hit 被上架，DRAFT 的应当筛不出来
    await http(app)
      .patch(`/api/v1/catalog/products/${hit.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    const published = await http(app)
      .get('/api/v1/catalog/products?status=PUBLISHED')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productListBody(published).items.map((i) => i.id)).toEqual([hit.id]);

    const draft = await http(app)
      .get('/api/v1/catalog/products?status=DRAFT')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productListBody(draft).items.map((i) => i.id)).not.toContain(hit.id);
  });

  it('不带 token 的商品请求被拒绝', async () => {
    await http(app).get('/api/v1/catalog/products').expect(401);
  });
  it('并发编辑：两个同时到达的请求只有一个生效', async () => {
    const merchant = await createMerchant(app, prisma);
    const created = await createProduct(merchant.token, {
      name: '真并发商品',
      slug: `rc-${unique()}`,
    });

    // 两个请求**同时**发出，都带着 version=created.version。
    //
    // ⚠️ 这条用例与上面那条「version 不匹配时返回 409」测的是**不同的防线**：
    // 那条是串行的，第二次请求在 `update` 入口比较 version 时就被挡下，
    // 根本走不到 `updateMany`。而这里两个请求同时进到 update，
    // 都要靠 `updateMany` 的 where 里的 version 条件——
    // 那是唯一能挡住真并发的防线，删掉它上面那条照样绿。
    //
    // 失败注入实测过：去掉 where 里的 version 条件时，上面那条串行用例
    // 仍然全绿，只有这条会失败。
    const [first, second] = await Promise.all([
      http(app)
        .patch(`/api/v1/catalog/products/${created.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '并发改名甲', version: created.version }),
      http(app)
        .patch(`/api/v1/catalog/products/${created.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: '并发改名乙', version: created.version }),
    ]);

    // 乐观锁下：一个 200、一个 409，而不是「两个都成功，后写覆盖先写」
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    // 查库确认只生效了一次：version 只递增了 1，且 name 是胜出者的那个
    const after = await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const afterBody = productBody(after);

    expect(afterBody.version).toBe(created.version + 1);
    const winner = first.status === 200 ? '并发改名甲' : '并发改名乙';
    expect(afterBody.name).toBe(winner);
  });
});

/**
 * 规格矩阵 (e2e)
 *
 * 这个套件要证明六件事：
 * 1. 两个维度的取值按笛卡尔积生成 SKU 骨架，初始价格与库存都是 0；
 * 2. 整体替换是**按组合匹配**而非整体重建——已有 SKU 的价格被保留；
 * 3. 规格缩减时多余的 SKU 置 INACTIVE 而不是软删（历史库存流水不能丢）；
 * 4. 维度数与每维取值数超限时拒绝，且**没有任何数据被写进去**；
 * 5. 乐观锁生效：version 不匹配返回 409 且数据不变；
 * 6. 租户隔离在规格与 SKU 上真的生效，A 改不动 B 名下商品的规格。
 *
 * 单独起一个 describe：它要直接查库核对状态与 tenantId，不能与商品套件混在一起。
 */
describe('规格矩阵 (e2e)', () => {
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
   * 在指定租户的上下文里查库。
   *
   * 套件里的断言刻意**绕开接口**直接读表：接口返回里看不到软删掉的行、
   * 也看不到 INACTIVE 的 SKU，只看接口的话「多余的 SKU 被置为 INACTIVE 而不是
   * 软删」这条根本没法验证——软删的实现会让同样的断言通过，而它会毁掉历史流水。
   *
   * 必须走 `tenantContext.run` 的 async 回调：Prisma 6 的扩展在
   * `tenantContext.getStore()` 为空时直接拒绝访问租户作用域模型，
   * 而同步回调不会跨 await 传播上下文。
   */
  function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, userId: null, role: null }, async () =>
      fn(),
    );
  }

  it('规格矩阵生成笛卡尔积的 SKU', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '圆领 T 恤', slug: `tee-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const response = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
          { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
        ],
      })
      .expect(200);

    const body = specMatrixBody(response);

    // 2 × 2 = 4 个 SKU
    expect(body.skus).toHaveLength(4);
    expect(body.skus.map((s) => s.price)).toEqual([0, 0, 0, 0]);

    // 维度与取值也要落库，且都归属本租户
    expect(body.specs.map((s) => s.name)).toEqual(['颜色', '尺码']);
    expect(body.specs.flatMap((s) => s.values.map((v) => v.value))).toEqual([
      '红色',
      '蓝色',
      'M',
      'L',
    ]);

    // ⚠️ 事务里的 create 是否被扩展正确注入 tenantId，在这里查库验证。
    // 只看接口返回的 tenantId 不够——SKU 表上每一条都得是对的。
    await asTenant(merchant.tenantId, async () => {
      const skus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      expect(skus).toHaveLength(4);
      expect(new Set(skus.map((s) => s.tenantId))).toEqual(
        new Set([merchant.tenantId]),
      );
      const specValues = await prisma.productSpecValue.findMany({
        where: { spec: { productId: created.id } },
      });
      expect(specValues.every((v) => v.tenantId === merchant.tenantId)).toBe(
        true,
      );
      const skuSpecValues = await prisma.skuSpecValue.findMany({
        where: { sku: { productId: created.id } },
      });
      // 每个 SKU 挂两个值（颜色 + 尺码）
      expect(skuSpecValues).toHaveLength(8);
      expect(skuSpecValues.every((v) => v.tenantId === merchant.tenantId)).toBe(
        true,
      );
    });

    // 商品版本递增
    expect(body.version).toBe(created.version + 1);
  });

  it('规格替换后重算 minPrice', async () => {
    // 规格替换会改变「有哪些可售 SKU」，而 minPrice 是公开列表的价格筛选与
    // 价格排序直接读的字段。不重算的话前台展示的是过期价格——包括
    // 「显示一个已被置 INACTIVE 的 SKU 的价格」这种会直接引发客诉的情况。
    const merchant = await createMerchant(app, prisma);
    const created = productBody(
      await http(app)
        .post('/api/v1/catalog/products')
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ name: 'minPrice 重算商品', slug: `mp-${unique()}` })
        .expect(201),
    );

    // 建 2 个 SKU 并定价 8000 / 20000
    const first = specMatrixBody(
      await http(app)
        .put(`/api/v1/catalog/products/${created.id}/specs`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({
          version: created.version,
          specs: [
            { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
          ],
        })
        .expect(200),
    );

    for (const [i, sku] of first.skus.entries()) {
      await http(app)
        .patch(`/api/v1/catalog/products/${created.id}/skus/${sku.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({ price: i === 0 ? 8000 : 20000 })
        .expect(200);
    }

    const priced = productBody(
      await http(app)
        .get(`/api/v1/catalog/products/${created.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200),
    );
    expect(priced.minPrice).toBe(8000);

    // 缩规格到只剩「红色」——蓝色被置 INACTIVE，但红色还是 8000，最低价不变
    const second = specMatrixBody(
      await http(app)
        .put(`/api/v1/catalog/products/${created.id}/specs`)
        .set('authorization', `Bearer ${merchant.token}`)
        .send({
          version: priced.version,
          specs: [{ name: '颜色', values: [{ value: '红色' }] }],
        })
        .expect(200),
    );
    const afterShrink = productBody(
      await http(app)
        .get(`/api/v1/catalog/products/${created.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200),
    );
    expect(afterShrink.minPrice).toBe(8000);

    // ⚠️ 关键的一条：整体清空规格后没有任何 ACTIVE 的 SKU，
    // minPrice 必须归 0——不能卡在旧值上，否则商品对外显示一个
    // 买家根本买不到的价格。
    await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ version: second.version, specs: [] })
      .expect(200);

    const afterClear = productBody(
      await http(app)
        .get(`/api/v1/catalog/products/${created.id}`)
        .set('authorization', `Bearer ${merchant.token}`)
        .expect(200),
    );
    expect(afterClear.minPrice).toBe(0);
  });

  it('删掉的规格值再加回来是一条新记录且可见', async () => {
    // 这条用例守的是 SOFT_DELETE_MODELS 的完整性。
    //
    // ProductSpecValue 漏登记软删除名单时：顶层 findMany 不过滤 deletedAt，
    // 于是「删掉红色再加回红色」会命中已软删的旧行并复用它，
    // 而它的 deletedAt 仍是过去时间 —— 加回来的值在界面上依然不可见，
    // 规格值凭空消失。断言「是新 id」+「可见」两条，缺一不可。
    const merchant = await createMerchant(app, prisma);

    const created0 = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '规格值复活商品', slug: `sv-${unique()}` })
      .expect(201);
    const product = productBody(created0);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${product.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: product.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);
    const firstValueId = specMatrixBody(first).specs[0].values[0].id;

    // 换成蓝色 —— 红色被软删
    const second = await http(app)
      .put(`/api/v1/catalog/products/${product.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: specMatrixBody(first).version,
        specs: [{ name: '颜色', values: [{ value: '蓝色' }] }],
      })
      .expect(200);

    // 再换回红色
    const third = await http(app)
      .put(`/api/v1/catalog/products/${product.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: specMatrixBody(second).version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    const values = specMatrixBody(third).specs[0].values;
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe('红色');

    // 必须是**新** id：复用了旧行就说明扩展没过滤掉已软删的记录
    expect(values[0].id).not.toBe(firstValueId);

    // 而且必须真的可见（deletedAt 为空）——响应查得到不代表库里是活的
    const reloaded = await http(app)
      .get(`/api/v1/catalog/products/${product.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    const reloadedValues = specMatrixBody(reloaded).specs.flatMap((spec) =>
      spec.values.map((v) => v.value),
    );
    expect(reloadedValues).toEqual(['红色']);
  });

  it('整体替换时保留已有 SKU 的价格', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '保留价格商品', slug: `kp-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    const firstBody = specMatrixBody(first);
    const skuId = firstBody.skus[0].id;

    // 直接改这个 SKU 的价格
    const patched = await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 5900 })
      .expect(200);
    expect(skuBody(patched).price).toBe(5900);

    // 改价后立刻重算商品的 minPrice
    const afterPatch = await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(afterPatch).minPrice).toBe(5900);

    // 重新提交同样的规格，价格应当被保留
    const second = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: firstBody.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    const secondBody = specMatrixBody(second);
    expect(secondBody.skus).toHaveLength(1);
    expect(secondBody.skus[0].id).toBe(skuId);
    expect(secondBody.skus[0].price).toBe(5900);
  });

  it('增删取值时按组合匹配：未变的 SKU 保留、新组合新增', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '增量匹配商品', slug: `im-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
          { name: '尺码', values: [{ value: 'M' }] },
        ],
      })
      .expect(200);
    const firstBody = specMatrixBody(first);
    expect(firstBody.skus).toHaveLength(2);

    /**
     * 把 replace 的响应体展开成「组合文本 → SKU」的映射。
     *
     * SKU 上只挂着 valueId，要读出「红色/M」这样的可读组合，
     * 就得用同一个响应里的 specs 去把 valueId 翻回文本——
     * 否则断言只能对着 uuid 写，一改顺序就失效，也看不出匹配对不对。
     */
    const byCombo = (
      body: SpecMatrixResponseBody,
    ): Map<string, SpecMatrixResponseBody['skus'][number]> => {
      const valueText = new Map<string, string>();
      for (const spec of body.specs) {
        for (const value of spec.values) {
          valueText.set(value.id, value.value);
        }
      }
      return new Map(
        body.skus.map((sku) => [
          sku.specValues
            .map((sv) => valueText.get(sv.valueId))
            .sort()
            .join('/'),
          sku,
        ]),
      );
    };

    const before = byCombo(firstBody);
    expect([...before.keys()].sort()).toEqual(['M/红色', 'M/蓝色']);

    await http(app)
      .patch(
        `/api/v1/catalog/products/${created.id}/skus/${before.get('M/红色')!.id}`,
      )
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 1000 })
      .expect(200);
    await http(app)
      .patch(
        `/api/v1/catalog/products/${created.id}/skus/${before.get('M/蓝色')!.id}`,
      )
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 2000 })
      .expect(200);

    // 加一个尺码 L：M 的两条组合应当原样保留（id 与价格都不变），新增两条 L 的
    const second = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: firstBody.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
          { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
        ],
      })
      .expect(200);

    const secondBody = specMatrixBody(second);
    expect(secondBody.skus).toHaveLength(4);
    const after = byCombo(secondBody);
    expect([...after.keys()].sort()).toEqual([
      'L/红色',
      'L/蓝色',
      'M/红色',
      'M/蓝色',
    ]);
    // 老的两条 id 与价格都没动
    expect(after.get('M/红色')?.id).toBe(before.get('M/红色')?.id);
    expect(after.get('M/红色')?.price).toBe(1000);
    expect(after.get('M/蓝色')?.id).toBe(before.get('M/蓝色')?.id);
    expect(after.get('M/蓝色')?.price).toBe(2000);
    // 新增的两条价格为 0，且 id 是全新的
    expect(after.get('L/红色')?.price).toBe(0);
    expect(after.get('L/蓝色')?.price).toBe(0);
    expect(after.get('L/红色')?.id).not.toBe(after.get('M/红色')?.id);
    expect(after.get('L/蓝色')?.id).not.toBe(after.get('M/蓝色')?.id);
  });

  it('规格减少时多余的 SKU 置为 INACTIVE', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '缩减规格商品', slug: `rs-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
        ],
      })
      .expect(200);

    const firstBody = specMatrixBody(first);
    expect(firstBody.skus).toHaveLength(2);
    const [redId, blueId] = firstBody.skus.map((s) => s.id) as [string, string];

    // 「红色/M」保留价格，「蓝色/M」置 INACTIVE —— 顺带验证 INACTIVE 不计入 minPrice
    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${redId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 3300 })
      .expect(200);
    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${blueId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: 5500, status: 'INACTIVE' })
      .expect(200);

    const second = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: firstBody.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    // ⚠️ 断言返回只剩 1 条是恒真的——软删的 SKU 也不会出现在返回值里。
    // 必须查库确认那条多余 SKU **还在表里**、只是 status 变成 INACTIVE，
    // 否则「软删」这种实现也能让这个用例通过，而它会毁掉历史库存流水。
    await asTenant(merchant.tenantId, async () => {
      const dbSkus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      expect(dbSkus).toHaveLength(2);
      const blue = dbSkus.find((s) => s.id === blueId);
      expect(blue).toBeDefined();
      expect(blue?.status).toBe('INACTIVE');
      expect(blue?.deletedAt).toBeNull();
      expect(blue?.price).toBe(5500);
      // 保留下来的那条仍是 ACTIVE
      expect(dbSkus.find((s) => s.id === redId)?.status).toBe('ACTIVE');

      // 被删掉的规格值同样只是软删
      // ⚠️ 必须用**裸 PrismaClient**：ProductSpecValue 已登记进
      // SOFT_DELETE_MODELS，扩展会给它合并 deletedAt: null，
      // 于是已软删的行在扩展的 client 下根本查不到——用它数「库里还留着几条」
      // 只会数到存活的那几条。
      const raw = new PrismaClient();
      const dbValues = await raw.productSpecValue.findMany({
        where: { spec: { productId: created.id } },
      });
      expect(dbValues).toHaveLength(2);
      expect(dbValues.filter((v) => v.deletedAt !== null)).toHaveLength(1);
      expect(dbValues.find((v) => v.value === '红色')?.deletedAt).toBeNull();
    });

    // ⚠️ 响应里仍然有 2 条 SKU——INACTIVE 不等于被删掉，商品详情要展示它们，
    // 否则商家改了规格之后就在界面上「凭空丢了 SKU」，查不到它原来多少钱。
    // 前台不展示是 Task 8 公开接口只返 ACTIVE 的事。
    const secondBody = specMatrixBody(second);
    expect(secondBody.skus).toHaveLength(2);
    const statuses = new Map(secondBody.skus.map((s) => [s.id, s.status]));
    expect(statuses.get(redId)).toBe('ACTIVE');
    expect(statuses.get(blueId)).toBe('INACTIVE');
    // 但被软删的规格值不出现在响应里（include 上带了 deletedAt: null）
    expect(
      secondBody.specs.flatMap((s) => s.values.map((v) => v.value)),
    ).toEqual(['红色']);
  });

  it('规格数量超限被拒绝', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '超限商品', slug: `ol-${unique()}` })
      .expect(201);
    const created = productBody(product);

    // 3 个维度，超出上限 2
    await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }] },
          { name: '尺码', values: [{ value: 'M' }] },
          { name: '厚度', values: [{ value: '薄' }] },
        ],
      })
      .expect(400);

    // 只看 400 是恒真的（400 也可能来自别的原因），查库确认真的什么都没写
    await asTenant(merchant.tenantId, async () => {
      expect(
        await prisma.productSpec.count({
          where: { productId: created.id },
        }),
      ).toBe(0);
      expect(await prisma.sku.count({ where: { productId: created.id } })).toBe(
        0,
      );
    });
    // 商品版本也没有递增
    const unchanged = await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(unchanged).version).toBe(created.version);

    // 单维度取值超限（21 个）同样被拒
    await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [
          {
            name: '颜色',
            values: Array.from({ length: 21 }, (_, i) => ({
              value: `色${i}`,
            })),
          },
        ],
      })
      .expect(400);
    await asTenant(merchant.tenantId, async () => {
      expect(
        await prisma.productSpec.count({
          where: { productId: created.id },
        }),
      ).toBe(0);
    });
  });

  it('乐观锁：规格替换时 version 不匹配返回 409', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '并发规格商品', slug: `cs-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);

    // 用过期的那一版 version 再提交：商品已经被上面的请求推到 v2 了，
    // 这里拿的仍是创建时的 v1，必须被挡下
    await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [{ name: '颜色', values: [{ value: '蓝色' }] }],
      })
      .expect(409);
    expect(specMatrixBody(first).version).toBe(created.version + 1);

    // 查库确认冲突的那次请求真的什么都没写：规格值仍是「红色」，
    // 「蓝色」从未落库——否则 409 就只是个装饰性状态码
    await asTenant(merchant.tenantId, async () => {
      const rawValues = new PrismaClient();
      const values = await rawValues.productSpecValue.findMany({
        where: { spec: { productId: created.id } },
      });
      expect(values.map((v) => v.value)).toEqual(['红色']);
      const skus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      expect(skus).toHaveLength(1);
    });
    const after = await http(app)
      .get(`/api/v1/catalog/products/${created.id}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(200);
    expect(productBody(after).version).toBe(created.version + 1);
  });

  it('规格与 SKU 都受租户隔离约束', async () => {
    const owner = await createMerchant(app, prisma);
    const intruder = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${owner.token}`)
      .send({ name: '隔离商品', slug: `iso-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const specs = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${owner.token}`)
      .send({
        version: created.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);
    const specsBody = specMatrixBody(specs);
    const skuId = specsBody.skus[0].id;

    // 别的商家改不了这个商品的规格：商品查不到 → 404
    await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${intruder.token}`)
      .send({
        version: specsBody.version,
        specs: [{ name: '颜色', values: [{ value: '绿色' }] }],
      })
      .expect(404);

    // 别的商家也改不了这个商品的 SKU
    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${intruder.token}`)
      .send({ price: 1 })
      .expect(404);

    // 确认上面两次越权真的没有写进去
    await asTenant(owner.tenantId, async () => {
      const rawValues = new PrismaClient();
      const values = await rawValues.productSpecValue.findMany({
        where: { spec: { productId: created.id } },
      });
      expect(values.map((v) => v.value)).toEqual(['红色']);
      const skus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      expect(skus[0].price).toBe(0);
    });

    // ⚠️ 同租户跨商品：商家自己拿着 A 商品的路径 + B 商品的 skuId 改价，
    // 也必须被挡下。只靠扩展的 where.tenantId 挡不住这种组合——
    // 那个 SKU 在**本租户名下**，tenantId 条件会放行，是服务层的
    // where 里的 productId 在起作用。少写那一条这个请求就会 200。
    const other = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${owner.token}`)
      .send({ name: '同租户另一商品', slug: `oth-${unique()}` })
      .expect(201);
    const otherProduct = productBody(other);

    await http(app)
      .patch(`/api/v1/catalog/products/${otherProduct.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${owner.token}`)
      .send({ price: 1 })
      .expect(404);

    await asTenant(owner.tenantId, async () => {
      const skus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      // 越权请求没有把价格改成 1
      expect(skus[0].price).toBe(0);
    });
  });

  it('规格整体清空：维度与取值软删，多余 SKU 全部下架', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: '清空规格商品', slug: `clr-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const first = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [
          { name: '颜色', values: [{ value: '红色' }, { value: '蓝色' }] },
          { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
        ],
      })
      .expect(200);
    const firstBody = specMatrixBody(first);
    expect(firstBody.skus).toHaveLength(4);

    // 传空的 specs 把规格整体清空
    const cleared = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ version: firstBody.version, specs: [] })
      .expect(200);
    const clearedBody = specMatrixBody(cleared);

    // 维度与取值都不再出现在响应里
    expect(clearedBody.specs).toEqual([]);
    // 四个 SKU 全部下架，且**没有多出一条不挂规格值的 SKU**——
    // 笛卡尔积从空维度起算时如果按数学定义走，会产出一个空组合，
    // 那条 SKU 在界面上看不见却会污染列表与计数
    expect(clearedBody.skus).toHaveLength(4);
    expect(clearedBody.skus.every((s) => s.status === 'INACTIVE')).toBe(true);
    expect(clearedBody.skus.every((s) => s.specValues.length === 0)).toBe(
      false,
    );

    // 查库确认维度与取值确实是**软删**（记录还在，只是不再对外可见），
    // 而不是被物理删除——规格值上挂着 SKU 关联与历史库存流水的引用
    await asTenant(merchant.tenantId, async () => {
      const raw = new PrismaClient();
      const specs = await raw.productSpec.findMany({
        where: { productId: created.id },
      });
      expect(specs).toHaveLength(2);
      expect(specs.every((s) => s.deletedAt !== null)).toBe(true);
      const rawValues = new PrismaClient();
      const values = await rawValues.productSpecValue.findMany({
        where: { spec: { productId: created.id } },
      });
      expect(values).toHaveLength(4);
      expect(values.every((v) => v.deletedAt !== null)).toBe(true);

      // SKU 一条不多一条不少：清空规格不该凭空造出新 SKU
      const skus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      expect(skus).toHaveLength(4);
      expect(skus.every((s) => s.status === 'INACTIVE')).toBe(true);
    });

    // 商品版本继续递增
    expect(clearedBody.version).toBe(firstBody.version + 1);
  });

  it('SKU 更新会拒绝库存字段与非法状态', async () => {
    const merchant = await createMerchant(app, prisma);

    const product = await http(app)
      .post('/api/v1/catalog/products')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ name: 'SKU 参数校验', slug: `sv-${unique()}` })
      .expect(201);
    const created = productBody(product);

    const specs = await http(app)
      .put(`/api/v1/catalog/products/${created.id}/specs`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        version: created.version,
        specs: [{ name: '颜色', values: [{ value: '红色' }] }],
      })
      .expect(200);
    const skuId = specMatrixBody(specs).skus[0].id;

    // stock 只能通过库存调整接口改（带流水审计）
    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ stock: 10 })
      .expect(400);

    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ status: 'SOMETHING' })
      .expect(400);

    await http(app)
      .patch(`/api/v1/catalog/products/${created.id}/skus/${skuId}`)
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ price: -1 })
      .expect(400);

    // 三次拒绝之后价格与状态都还没变
    await asTenant(merchant.tenantId, async () => {
      const skus = await prisma.sku.findMany({
        where: { productId: created.id },
      });
      expect(skus[0].price).toBe(0);
      expect(skus[0].stock).toBe(0);
      expect(skus[0].status).toBe('ACTIVE');
    });
  });
});
