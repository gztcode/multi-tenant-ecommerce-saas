import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 创建满减活动。
 *
 * ⚠️ **不声明 `status`**：新活动一律 ACTIVE，要暂停用 PATCH。
 * ⚠️ **不声明 `tenantId`**：租户由上下文推导。
 */
export class CreatePromotionDto {
  @ApiProperty({ description: '活动名称' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ required: false, description: '活动说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: '门槛（整数分），0 = 无门槛', example: 10_000 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  minAmount!: number;

  @ApiProperty({ description: '减免金额（整数分）', example: 2000 })
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  discountAmount!: number;

  @ApiProperty({ description: '生效开始时间（ISO 8601）' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ description: '生效结束时间（ISO 8601）' })
  @IsISO8601()
  endsAt!: string;
}
