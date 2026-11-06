import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ProductStatus } from '@prisma/client';

import { MAX_PAGE_SIZE } from '../../../common/http/pagination';

/**
 * 商品列表（管理端）的查询参数。
 *
 * ⚠️ **这里必须是 DTO，不能用裸 `@Query`**：裸 `@Query('page')` 拿到的是字符串，
 * `Number('abc')` = NaN，一路传到 Prisma 就是 500（审计 P2-5）。
 * 走 DTO 之后由 ValidationPipe 校验，畸形入参一律 400。
 */
export class ProductListQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（上限 100）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;

  @ApiPropertyOptional({ description: '按名称 / slug 模糊搜索' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '按品类筛选' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    description: '按状态筛选。缺省 = 全部状态',
    enum: ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'],
  })
  @IsOptional()
  // ⚠️ 枚举必须校验：Prisma 遇到非法枚举值是**抛错**（500），
  // 不是查不到就返回空列表。
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
