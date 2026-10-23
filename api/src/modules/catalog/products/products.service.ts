import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Product,
  ProductMedia,
  ProductStatus,
  Sku,
} from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';
import { rethrowIfUniqueViolation } from '../../../common/errors/unique-constraint';
import { MinPriceService } from '../pricing/min-price.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { BatchProductsDto } from '../dto/batch-products.dto';
import { UpdateSkuDto } from '../dto/update-sku.dto';

/** 管理端列表的每页条数上限 */
export const MAX_PAGE_SIZE = 100;

/**
 * 按百分比调价（分 → 分），不足一分向上取整。
 *
 * ⚠️ 刻意**不用** `Math.ceil(price * (1 + percent / 100))`：那一步是浮点运算，
 * 而 IEEE754 的二进制表示无法精确表达 0.1、0.05 这类十进制小数。
 * 例如 3000 * (1 + 10/100) 的真实值是 3300.0000000000005，Math.ceil 会把它
 * 抬成 3301——一次「涨 10%」凭空多收了一分钱，而且**只在某些金额上发生**
 * （1000 * 1.1 恰好等于 1100），这种金额相关的诡异行为极难被测出来。
 *
 * 改成整数运算：先在整数域完成乘法（分 × 百分数），
 * 除以 100 时若有余数就 +1，全程不碰浮点，结果与「四舍五入到分」的语义一致。
 * 价格是分，商家对「涨 10%」的直觉是 33.00 元而不是 33.01 元。
 */
export function applyPercent(price: number, percent: number): number {
  const product = price * (100 + percent);
  const result = Math.floor(product / 100);
  const rounded = product % 100 === 0 ? result : result + 1;
  // ⛔ 不允许负价。percent 来自批量调价的请求体，merchant-admin 之外没有别的
  // 入口，但一旦传入 -150，一个 100 分的 SKU 就会变成 -50 写进库（Sku.price
  // 没有 check 约束），随后 minPrice 变负、公开列表的价格筛选与排序全乱。
  // 夹到 0 而不是抛错：商家点「降价 150%」得到 0 元，比报错更符合直觉。
  return Math.max(0, rounded);
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly minPrice: MinPriceService,
  ) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /** 管理端列表：分页 + 关键词 + 品类 + 状态筛选 */
  async list(query: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    categoryId?: string;
    status?: ProductStatus;
  }): Promise<{
    items: Product[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const tenantId = this.currentTenantId();
    const page = Math.max(1, query.page ?? 1);
    // pageSize 上限 100：否则 pageSize=99999 能把整个租户的商品拖出去
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.ProductWhereInput = {
      tenantId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { slug: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** 商品详情（含规格与 SKU）。规格在 Task 5 接入后才有数据。 */
  async findOne(id: string) {
    this.currentTenantId();
    // ⚠️ 三处 include 都要显式写 where —— 扩展的软删除过滤只作用于顶层查询，
    // 嵌套关联不会被自动过滤（include: { skus: true } 会把软删掉的 SKU 读出来）。
    // media 是 ProductMedia 列表（to-many），用它指向的 Media 的关系条件过滤。
    const product = await this.prisma.product.findFirst({
      where: { id },
      include: {
        skus: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        specs: {
          where: { deletedAt: null },
          orderBy: { sort: 'asc' },
          include: {
            values: { where: { deletedAt: null }, orderBy: { sort: 'asc' } },
          },
        },
        media: {
          where: { media: { deletedAt: null } },
          orderBy: { sort: 'asc' },
        },
      },
    });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    return product;
  }

  /**
   * 校验品类可用。
   *
   * ⚠️ 与品类的 parentId 同理：categoryId 只引用 Category.id，**不带 tenantId**，
   * 数据库层面挡不住跨租户挂载，而扩展只往 data 注入 tenantId、不校验被引用对象的归属。
   * 必须在这里显式查一次归属——用 findFirst（findUnique 会被扩展拒绝），
   * 扩展自动合并的 where.tenantId 就是那道闸门，别的租户的 id 查不到。
   */
  private async assertCategoryUsable(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId },
    });
    if (!category) {
      throw new BadRequestException('品类不存在');
    }
  }

  async create(dto: CreateProductDto): Promise<Product> {
    this.currentTenantId();

    // null 表示「不分类」，不需要校验归属；非 null 才要查
    if (dto.categoryId) {
      await this.assertCategoryUsable(dto.categoryId);
    }

    try {
      return await this.prisma.product.create({
        // as never 的理由同 CategoriesService.create：展开后 TS 推断出的是含
        // undefined 的可选属性，与 ProductCreateInput 对不齐；tenantId 由扩展注入。
        data: {
          name: dto.name,
          slug: dto.slug,
          ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.attributes !== undefined
            ? { attributes: dto.attributes }
            : {}),
        } as never,
      });
    } catch (error) {
      // 同租户内 slug 重复 → 409，而不是让 P2002 一路冒成 500。
      // 这个函数签名是 never，所以 catch 之后必然抛出，TS 也能据此
      // 判定 create 不会「隐式返回 undefined」。
      return rethrowIfUniqueViolation(error, '商品 slug');
    }
  }

  /**
   * 更新商品。
   *
   * 乐观锁：传了 version 就必须与当前版本一致，否则 409。
   * 不传 version 则跳过校验——**但这是有代价的**：并发编辑会静默覆盖。
   * 前端必须传（Task 11 的编辑页会带上）。
   */
  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    this.currentTenantId();
    const product = await this.prisma.product.findFirst({ where: { id } });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }

    if (dto.version !== undefined && dto.version !== product.version) {
      throw new ConflictException('商品已被他人修改，请刷新后重试');
    }

    // 上面的 version 比较只是**快速失败**，挡不住真正同时到达的两个请求：
    // 两者都读到 version=1、都通过校验，然后都写进去，后写覆盖先写。
    // 真正起作用的守卫在下面的 updateMany——把 version 放进 where，
    // 由数据库在写入那一刻做条件判断，受影响行数为 0 就说明
    // 在这两条语句之间有人改过它。
    //
    // 传了 version 就带上条件；没传（内部调用）则不加，维持原行为。
    const optimisticWhere =
      dto.version !== undefined ? { id, version: dto.version } : { id };

    if (dto.categoryId) {
      await this.assertCategoryUsable(dto.categoryId);
    }

    const nextStatus = dto.status ?? product.status;
    // 首次转为 PUBLISHED 时写入 publishedAt；再次上架保留原时间
    const publishedAt =
      nextStatus === 'PUBLISHED' && product.status !== 'PUBLISHED'
        ? new Date()
        : product.publishedAt;

    const affected = await this.prisma.product.updateMany({
      where: optimisticWhere,
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.attributes !== undefined ? { attributes: dto.attributes } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(publishedAt !== product.publishedAt ? { publishedAt } : {}),
        version: { increment: 1 },
      },
    });

    if (dto.version !== undefined && affected.count === 0) {
      throw new ConflictException('商品已被他人修改，请刷新后重试');
    }

    // 上面已经确认过商品存在，这里再查一次而不是复用旧对象：
    // update 之后 name / status / version / publishedAt 都可能变了。
    const updated = await this.prisma.product.findFirst({ where: { id } });
    if (!updated) {
      throw new NotFoundException('商品不存在');
    }
    return updated;
  }

  /** 软删除商品 */
  async remove(id: string): Promise<void> {
    this.currentTenantId();
    const product = await this.prisma.product.findFirst({ where: { id } });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    await this.prisma.product.updateMany({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * 设置商品的媒体列表（整体替换）。
   *
   * 校验两件事：
   * 1. 每个 mediaId 都属于当前租户——否则就是跨租户引用别人的文件；
   * 2. 每个 mediaId 都是 READY 状态——还没上传完的不能挂到商品上。
   *
   * 覆盖式替换：在事务里删掉不再被引用的 ProductMedia、补上新引用的、
   * 按传入顺序重排 sort。
   */
  async setMedia(
    productId: string,
    mediaIds: string[],
  ): Promise<ProductMedia[]> {
    const tenantId = this.currentTenantId();

    const product = await this.prisma.product.findFirst({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException('商品不存在');
    }

    if (mediaIds.length > 0) {
      const media = await this.prisma.media.findMany({
        where: { id: { in: mediaIds } },
      });
      const found = new Set(media.map((m) => m.id));
      const missing = mediaIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        // 找不到的要么不存在，要么属于别的租户——不区分，避免探测别的租户有没有这个 id
        throw new BadRequestException(
          `媒体不存在或不可用：${missing.join('、')}`,
        );
      }
      const notReady = media.filter((m) => m.status !== 'READY');
      if (notReady.length > 0) {
        throw new BadRequestException('有媒体还没上传完成，不能挂到商品上');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 删掉不再被引用的
      await tx.productMedia.deleteMany({
        where: { productId, mediaId: { notIn: mediaIds } },
      });

      // 补上新引用的（已存在的不动）
      for (const mediaId of mediaIds) {
        const existing = await tx.productMedia.findFirst({
          where: { productId, mediaId },
        });
        if (!existing) {
          await tx.productMedia.create({
            data: { tenantId, productId, mediaId },
          });
        }
      }

      // 按传入顺序重排 sort
      for (const [sort, mediaId] of mediaIds.entries()) {
        await tx.productMedia.updateMany({
          where: { productId, mediaId },
          data: { sort },
        });
      }

      return tx.productMedia.findMany({
        where: { productId },
        orderBy: { sort: 'asc' },
      });
    });
  }

  /**
   * 批量操作。
   *
   * 单事务：全部成功或全部不生效。批量删除是软删除。
   * 批量改价后重算受影响商品的 minPrice。
   */
  async batch(dto: BatchProductsDto): Promise<{ updated: number }> {
    const tenantId = this.currentTenantId();

    if (dto.action === 'SET_CATEGORY' && !dto.categoryId) {
      throw new BadRequestException('批量改分类必须指定 categoryId');
    }
    if (dto.action === 'ADJUST_PRICE') {
      if (!dto.mode || dto.value === undefined) {
        throw new BadRequestException('批量改价必须指定 mode 与 value');
      }
    }
    if (dto.action === 'SET_CATEGORY' && dto.categoryId) {
      await this.assertCategoryUsable(dto.categoryId);
    }

    return this.prisma.$transaction(async (tx) => {
      // ids 里可能混着别的租户的 id——扩展合并的 where.tenantId 会把它们滤掉，
      // 所以下面拿到的 products 只含本租户的商品，updated 也只数这些。
      const products = await tx.product.findMany({
        where: { id: { in: dto.ids } },
      });
      const productIds = products.map((p) => p.id);

      switch (dto.action) {
        case 'PUBLISH':
        case 'UNPUBLISH': {
          const status = dto.action === 'PUBLISH' ? 'PUBLISHED' : 'UNPUBLISHED';
          await tx.product.updateMany({
            where: { id: { in: productIds } },
            data: {
              status,
              ...(status === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
              version: { increment: 1 },
            },
          });
          break;
        }
        case 'DELETE': {
          await tx.product.updateMany({
            where: { id: { in: productIds } },
            data: { deletedAt: new Date() },
          });
          break;
        }
        case 'SET_CATEGORY': {
          await tx.product.updateMany({
            where: { id: { in: productIds } },
            data: { categoryId: dto.categoryId, version: { increment: 1 } },
          });
          break;
        }
        case 'ADJUST_PRICE': {
          const mode = dto.mode as 'SET' | 'PERCENT';
          const value = dto.value as number;
          const skus = await tx.sku.findMany({
            where: { productId: { in: productIds }, status: 'ACTIVE' },
          });
          for (const sku of skus) {
            const nextPrice =
              mode === 'SET' ? value : applyPercent(sku.price, value);
            await tx.sku.updateMany({
              where: { id: sku.id },
              data: { price: nextPrice },
            });
          }
          // 改价与重算最低价必须在同一事务内：否则会存在「价格已改、最低价还是旧值」
          // 的窗口，列表按价格排序与按价格筛选会给出互相矛盾的答案。
          await this.minPrice.recalculate(tx, tenantId, productIds);
          break;
        }
      }

      return { updated: productIds.length };
    });
  }

  /**
   * 更新单个 SKU 的价格、划线价、编码与启用状态。
   *
   * 单独一个接口而不是并进规格替换：改价是高频操作，替换规格是低频操作，
   * 混在一起会让「替换规格」意外覆盖商家刚改的价格。
   *
   * 价格改完要重算商品的 minPrice——两者在同一事务里，否则会存在
   * 「价格已改、最低价还是旧值」的窗口，列表按价格排序与筛选会自相矛盾。
   *
   * ⚠️ where 里带 productId：否则 A 商家拿自己的 token + B 商家的 skuId
   * 就能改别人商品的价格（skuId 是 uuid，但商品接口的 id 同样是可枚举的，
   * 隔离不能靠「猜不到」）。带上商品 id 后，越权请求会因为扩展合并的
   * where.tenantId 查不到记录而得到 404。
   *
   * ⚠️ 跨商品的 skuId（传了别的商品的 skuId 配本商品的 productId）同样落到
   * 这里：findFirst 带 productId 条件，查不到就是 404。
   */
  async updateSku(
    productId: string,
    skuId: string,
    dto: UpdateSkuDto,
  ): Promise<Sku> {
    const tenantId = this.currentTenantId();

    const sku = await this.prisma.sku.findFirst({
      where: { id: skuId, productId },
    });
    if (!sku) {
      throw new NotFoundException('SKU 不存在');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sku.updateMany({
        where: { id: skuId },
        data: {
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.comparePrice !== undefined
            ? { comparePrice: dto.comparePrice }
            : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
      });
      await this.minPrice.recalculate(tx, tenantId, [productId]);
    });

    return this.prisma.sku.findFirst({
      where: { id: skuId, productId },
    }) as Promise<Sku>;
  }
}
