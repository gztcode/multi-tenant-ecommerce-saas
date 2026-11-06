import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { MAX_PAGE_SIZE } from '../../../common/http/pagination';

/**
 * 库存流水列表的查询参数。
 *
 * ⚠️ **这里必须是 DTO，不能用裸 `@Query`**：裸 `@Query('page')` 拿到的是字符串，
 * `Number('abc')` = NaN，一路传到 Prisma 就是 500（审计 P2-5）。
 * 走 DTO 之后由 ValidationPipe 校验，畸形入参一律 400。
 */
export class InventoryMovementsQueryDto {
  @ApiPropertyOptional({ description: '按 SKU 筛选' })
  @IsOptional()
  @IsString()
  skuId?: string;

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
}
