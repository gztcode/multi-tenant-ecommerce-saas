import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ProductStatus } from '@prisma/client';

/**
 * 商品更新。所有字段可选，不传的保持原值。
 *
 * 用展开运算逐字段构造 data 而不是 `...dto`（理由同 UpdateCategoryDto）：
 * 直接展开会把将来往 DTO 上加的字段一并灌进 data，无意中扩大写入面。
 *
 * ⚠️ 不允许改 slug（改了旧链接失效，阶段 2 不做重定向）。
 * ⚠️ 不允许直接改 minPrice（派生字段，由 SKU 价格推导）。
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @ApiPropertyOptional({ description: '商品详情' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: '品类 id，null 表示移出分类',
  })
  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({
    enum: ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'],
    description: '商品状态。首次转为 PUBLISHED 时写入 publishedAt',
  })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'UNPUBLISHED'])
  status?: ProductStatus;

  @ApiPropertyOptional({
    minimum: 1,
    description: '乐观锁版本号。必须传当前版本，服务端校验不匹配时返回 409',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
