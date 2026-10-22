import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 商品创建。
 *
 * 刻意不接受 tenantId / minPrice / version / publishedAt / deletedAt：
 * - tenantId 由租户扩展注入
 * - minPrice 是派生字段，由 SKU 价格推导（见 MinPriceService）
 * - version / publishedAt / deletedAt 由服务端维护
 *
 * ValidationPipe 开了 forbidNonWhitelisted，客户端多传这些字段直接 400。
 */
export class CreateProductDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: '经典圆领 T 恤' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 120,
    example: 'classic-tee',
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'URL 片段，租户内唯一（仅对未删除的商品生效）',
  })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字与连字符' })
  slug!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: '副标题，显示在详情页价格下方',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @ApiPropertyOptional({ description: '商品详情，支持纯文本与换行' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ nullable: true, description: '品类 id' })
  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { 材质: '纯棉', 产地: '浙江' },
    description:
      '描述性属性（材质、产地这类不决定 SKU 组合的参数）。仅用于详情页展示，不参与按属性筛选',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}
