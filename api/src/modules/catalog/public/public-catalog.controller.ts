import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { PublicCatalogService } from './public-catalog.service';

/**
 * 把查询串安全地解析成整数。
 *
 * controller 的 `@Query('page') page?: string` 拿到的是裸字符串，而
 * `ValidationPipe` 只作用于带 DTO 的路由——公开列表这里没有 DTO，
 * 所以 `?page=abc` 会让 `Number()` 得到 NaN，一路传到 Prisma 变成
 * `skip: NaN`，整个查询抛错、接口返回 500。
 *
 * 公开接口面对的是全网匿名流量，把畸形入参变成 500 是最容易被拿来
 * 刷错误日志、触发告警的形态。这里统一收敛：解析失败就落回默认值。
 */
function toIntOr(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

@ApiTags('public-catalog')
@Controller('public')
export class PublicCatalogController {
  constructor(private readonly publicCatalog: PublicCatalogService) {}

  @Get('categories')
  @Public()
  @ApiOperation({ summary: '品类树（公开）' })
  categories() {
    return this.publicCatalog.categories();
  }

  @Get('products')
  @Public()
  @ApiOperation({ summary: '商品列表（公开）' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String })
  @ApiQuery({ name: 'minPrice', required: false, type: Number })
  @ApiQuery({ name: 'maxPrice', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['latest', 'price_asc', 'price_desc'],
  })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('sort') sort?: 'latest' | 'price_asc' | 'price_desc',
  ) {
    return this.publicCatalog.list({
      page: toIntOr(page, 1),
      pageSize: toIntOr(pageSize, 20),
      keyword,
      categoryId,
      minPrice: toIntOr(minPrice, undefined),
      maxPrice: toIntOr(maxPrice, undefined),
      sort,
    });
  }

  @Get('products/:slug')
  @Public()
  @ApiOperation({ summary: '商品详情（公开）' })
  productDetail(@Param('slug') slug: string) {
    return this.publicCatalog.productDetail(slug);
  }
}
