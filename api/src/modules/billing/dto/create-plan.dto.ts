import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 创建套餐（平台超管）。
 *
 * ⚠️ **金额一律整数分**，费率用**基点**（万分之）。
 * ⚠️ **`features` 是功能开关**（`{ marketing: true }`）——
 * 缺省一律视为 false（保守）。
 * ⚠️ **不声明 `tenantId`**：`plans` 表刻意不带 tenantId（它是平台的数据，
 * 不是租户的数据），客户端传了会被 `forbidNonWhitelisted` 直接 400。
 */
export class CreatePlanDto {
  @ApiProperty({ description: '套餐代码（全局唯一）' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: '套餐名称' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ required: false, description: '套餐说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: '周期价格（整数分）。0 = 免费', example: 9900 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  price!: number;

  @ApiProperty({ description: '订阅周期（天）', example: 30 })
  @IsInt()
  @Min(1)
  @Max(365)
  periodDays!: number;

  @ApiProperty({ required: false, description: '试用期（天）。0 = 无试用' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;

  @ApiProperty({
    description: '抽佣比例（基点，万分之一）。500 = 5%',
    example: 500,
  })
  @IsInt()
  @Min(0)
  @Max(10_000)
  commissionBps!: number;

  @ApiProperty({ required: false, description: '商品数上限。不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxProducts?: number;

  @ApiProperty({ required: false, description: 'SKU 数上限。不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxSkus?: number;

  @ApiProperty({
    required: false,
    description: '店铺数上限。不填 = 不限',
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxStores?: number;

  @ApiPropertyOptional({
    description: '功能开关，如 `{ marketing: true }`。缺省视为 false',
    type: 'object',
    additionalProperties: { type: 'boolean' },
  })
  @IsOptional()
  @IsObject()
  features?: Record<string, boolean>;
}
