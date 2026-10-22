import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProductStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ProductsService } from './products.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { BatchProductsDto } from '../dto/batch-products.dto';
import { SetProductMediaDto } from '../dto/set-product-media.dto';
import { UpdateSkuDto } from '../dto/update-sku.dto';
import { ReplaceSpecsDto } from '../dto/replace-specs.dto';
import { SpecMatrixService } from '../specs/spec-matrix.service';

/**
 * 商品管理接口。
 *
 * 与品类控制器一样整组挂 JwtAuthGuard：商品是商家后台的写操作，不对外公开。
 * 对外的公开读取在 Task 8 另开一个不带鉴权的控制器。
 *
 * 租户隔离靠 JWT 里的 tenantId（由租户上下文拦截器取），不是靠子域名 header。
 */
@ApiTags('products')
@Controller('catalog/products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly specMatrix: SpecMatrixService,
  ) {}

  @Get()
  @ApiOperation({ summary: '商品列表（管理端）' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'],
  })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('categoryId') categoryId?: string,
    @Query('status') status?: ProductStatus,
  ) {
    return this.productsService.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      keyword,
      categoryId,
      status,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '商品详情（管理端，含规格与 SKU）' })
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: '创建商品' })
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新商品' })
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除商品（软删除）' })
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }

  @Put(':id/media')
  @ApiOperation({
    summary: '设置商品的媒体列表（整体替换，数组顺序即封面顺序）',
  })
  setMedia(@Param('id') id: string, @Body() dto: SetProductMediaDto) {
    return this.productsService.setMedia(id, dto.mediaIds);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '批量操作' })
  batch(@Body() dto: BatchProductsDto) {
    return this.productsService.batch(dto);
  }

  @Patch(':productId/skus/:skuId')
  @ApiOperation({ summary: '更新单个 SKU' })
  updateSku(
    @Param('productId') productId: string,
    @Param('skuId') skuId: string,
    @Body() dto: UpdateSkuDto,
  ) {
    return this.productsService.updateSku(productId, skuId, dto);
  }

  @Put(':productId/specs')
  @ApiOperation({ summary: '整体替换规格矩阵' })
  replaceSpecs(
    @Param('productId') productId: string,
    @Body() dto: ReplaceSpecsDto,
  ) {
    return this.specMatrix.replace(productId, dto);
  }
}
