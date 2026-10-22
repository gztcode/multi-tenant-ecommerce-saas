import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../../common/tenant/tenant-context';

/**
 * 转义 LIKE 的通配符。
 *
 * Prisma 的 `contains` 生成 `ILIKE '%kw%'`，**不会**替我们转义 `%` 与 `_`。
 * 于是搜 `keyword=%` 就变成 `name ILIKE '%%%'`——等价于匹配全部已发布商品：
 * 既不是用户预期，`products_name_trgm` 的 GIN 索引在这种模式下也帮不上忙，
 * 直接退化成顺序扫描。
 *
 * PostgreSQL 的 LIKE 默认用反斜杠转义，所以这里给 `%` `_` `\` 前面各加一个。
 * 转义后中文照常命中——trgm 的三元组是按字符算的。
 *
 * ⚠️ 这**不是** SQL 注入防护：Prisma 的 `contains` 走参数化查询，注入面本来
 * 就没有。这里修的是「通配符语义 + 索引失效」。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** 搜索关键词的长度上限：超过后三元组索引的收益也趋近于零 */
const MAX_KEYWORD_LENGTH = 64;

/** 公开列表的每页条数上限 */
export const MAX_PUBLIC_PAGE_SIZE = 100;

/**
 * 公开商品读取。
 *
 * ⚠️ 本 service 里的每个方法都只能返回**公开数据**。
 *
 * 匿名请求的租户来自 `X-Tenant-Subdomain` 头或 Host 头，两者都可被伪造。
 * 这在本 service 里是无害的——商品本来就对所有人公开可见，
 * 伪造子域名只能看到那个店铺本来就公开的商品。
 *
 * 但这条安全性依赖于「公开路径上只有公开数据」这个不变量。
 * 将来若要在这里加「查本租户订单」之类的接口，就必须把它挪到需要认证的路径上，
 * 否则攻击者能用伪造的子域名头读到别人的数据。
 */
@Injectable()
export class PublicCatalogService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 店铺是否被暂停。
   *
   * 只有 `PAUSED` 才拦截——返回空列表而不是 404，避免泄露店铺的运营状态
   * （比如店铺被平台暂停了）。
   *
   * ⚠️ `DRAFT` **不拦截**：商家注册后店铺的初始状态就是 `DRAFT`
   * （`StoreStatus` 的 schema 默认值，注册流程没显式传 status），
   * 而阶段 2 没有「店铺上线」这道流程。若按「非 LIVE 即拦截」实现，
   * 公开接口会永远返回空列表——症状是「商品上架了但前台看不到」，
   * 很难往状态机上想。
   */
  private async isStorePaused(tenantId: string): Promise<boolean> {
    const store = await this.prisma.store.findFirst({
      where: { tenantId },
      select: { status: true },
    });
    return store?.status === 'PAUSED';
  }

  /** 公开的商品列表字段裁剪：不返回 tenantId / version / deletedAt 等内部字段 */
  private static readonly listSelect = {
    id: true,
    name: true,
    slug: true,
    subtitle: true,
    minPrice: true,
    publishedAt: true,
    category: { select: { id: true, name: true, slug: true } },
    media: {
      where: { media: { deletedAt: null } },
      orderBy: { sort: 'asc' },
      select: {
        sort: true,
        media: { select: { id: true, url: true, mime: true } },
      },
    },
  } satisfies Prisma.ProductSelect;

  async list(query: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    categoryId?: string;
    minPrice?: number;
    maxPrice?: number;
    sort?: 'latest' | 'price_asc' | 'price_desc';
  }) {
    const tenantId = this.currentTenantId();

    // 关键词截断到 64 字符：再长三元组索引也没有收益，而未转义的通配符
    // （见 escapeLike）能构造出任意长的模式串放大扫描代价。
    const keyword = query.keyword?.slice(0, MAX_KEYWORD_LENGTH);

    if (await this.isStorePaused(tenantId)) {
      return { items: [], total: 0, page: 1, pageSize: 20 };
    }

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PUBLIC_PAGE_SIZE,
      Math.max(1, query.pageSize ?? 20),
    );

    const where: Prisma.ProductWhereInput = {
      tenantId,
      status: 'PUBLISHED',
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.minPrice !== undefined || query.maxPrice !== undefined
        ? {
            minPrice: {
              ...(query.minPrice !== undefined ? { gte: query.minPrice } : {}),
              ...(query.maxPrice !== undefined ? { lte: query.maxPrice } : {}),
            },
          }
        : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: escapeLike(keyword), mode: 'insensitive' } },
              { slug: { contains: escapeLike(keyword), mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.ProductOrderByWithRelationInput =
      query.sort === 'price_asc'
        ? { minPrice: 'asc' }
        : query.sort === 'price_desc'
          ? { minPrice: 'desc' }
          : { publishedAt: 'desc' };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: PublicCatalogService.listSelect,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** 公开的品类树 */
  async categories() {
    const tenantId = this.currentTenantId();

    if (await this.isStorePaused(tenantId)) {
      return [];
    }

    const all = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
      select: { id: true, name: true, slug: true, parentId: true },
    });

    type CategoryNode = (typeof all)[number] & {
      children: CategoryNode[];
    };

    const byId = new Map<string, CategoryNode>();
    for (const row of all) {
      byId.set(row.id, { ...row, children: [] });
    }
    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /** 公开的商品详情 */
  async productDetail(slug: string) {
    const tenantId = this.currentTenantId();

    if (await this.isStorePaused(tenantId)) {
      throw new NotFoundException('商品不存在');
    }

    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'PUBLISHED' },
      select: {
        id: true,
        name: true,
        slug: true,
        subtitle: true,
        description: true,
        attributes: true,
        minPrice: true,
        publishedAt: true,
        category: { select: { id: true, name: true, slug: true } },
        // media 是 to-many 的 ProductMedia 列表，用关系条件过滤它关联的 Media
        media: {
          where: { media: { deletedAt: null } },
          orderBy: { sort: 'asc' },
          select: {
            sort: true,
            media: { select: { id: true, url: true, mime: true } },
          },
        },
        specs: {
          where: { deletedAt: null },
          orderBy: { sort: 'asc' },
          select: {
            id: true,
            name: true,
            sort: true,
            values: {
              where: { deletedAt: null },
              orderBy: { sort: 'asc' },
              select: { id: true, value: true, sort: true },
            },
          },
        },
        skus: {
          where: { deletedAt: null, status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            price: true,
            comparePrice: true,
            stock: true,
            specValues: { select: { valueId: true } },
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('商品不存在');
    }
    return product;
  }
}
