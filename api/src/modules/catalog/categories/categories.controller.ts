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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';

/**
 * 品类管理接口。
 *
 * 整个控制器都挂 JwtAuthGuard：品类是商家后台的写操作，不对外公开。
 * 注意租户隔离**不是**靠子域名 header，而是靠 JWT 里的 tenantId——
 * 子域名解析在管理端场景下没有意义，商家登录哪个账号就管哪个店铺。
 */
@ApiTags('categories')
@Controller('catalog/categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: '品类树' })
  tree() {
    return this.categoriesService.tree();
  }

  @Post()
  @ApiOperation({ summary: '创建品类' })
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新品类' })
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除品类（软删除）' })
  remove(@Param('id') id: string) {
    return this.categoriesService.remove(id);
  }
}
