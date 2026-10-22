import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { SkuStatus } from '@prisma/client';

/**
 * SKU 更新（价格、划线价、编码、启用状态）。
 *
 * 不含 stock：库存只能通过库存调整接口改，理由见设计文档 §四.8。
 */
export class UpdateSkuDto {
  @ApiPropertyOptional({ minimum: 0, description: '售价，单位：分' })
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ minimum: 0, description: '划线价，单位：分' })
  @IsOptional()
  @IsInt()
  @Min(0)
  comparePrice?: number;

  @ApiPropertyOptional({ maxLength: 64, description: '商家编码' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'INACTIVE'],
    description: 'INACTIVE 的 SKU 不参与 minPrice 计算，前台不可见',
  })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: SkuStatus;
}
