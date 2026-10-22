import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 本阶段支持的手动调整类型。
 *
 * RESERVE / RELEASE / DEDUCT 是计划 3（交易链路）用的，
 * 枚举里有位但本阶段不开放——它们的语义涉及「占用可用量」，
 * 与实际库存不是一回事。
 */
export const MANUAL_ADJUSTMENT_TYPES = [
  'ADJUST_IN',
  'ADJUST_OUT',
  'CHECK',
] as const;

export class AdjustStockDto {
  @ApiProperty({ description: 'SKU id' })
  @IsString()
  skuId!: string;

  @ApiProperty({
    enum: MANUAL_ADJUSTMENT_TYPES,
    description:
      'ADJUST_IN 入库（quantity 为增加量）；ADJUST_OUT 出库（quantity 为减少量）；CHECK 盘点（quantity 为盘点后的实际值）',
  })
  @IsIn(MANUAL_ADJUSTMENT_TYPES)
  type!: 'ADJUST_IN' | 'ADJUST_OUT' | 'CHECK';

  @ApiProperty({
    minimum: 0,
    description:
      '入库 / 出库填数量；盘点填盘点后的实际库存值。单位与库存一致（件）',
  })
  @IsInt()
  @Min(0)
  quantity!: number;

  @ApiPropertyOptional({ maxLength: 200, description: '调整原因' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
