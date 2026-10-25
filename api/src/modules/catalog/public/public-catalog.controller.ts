import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { toIntOr } from '../../../common/http/pagination';
import { PublicCatalogService } from './public-catalog.service';

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
