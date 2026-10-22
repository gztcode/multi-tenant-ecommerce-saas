import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** 批量操作的动作 */
export const BATCH_ACTIONS = [
  'PUBLISH',
  'UNPUBLISH',
  'DELETE',
  'SET_CATEGORY',
  'ADJUST_PRICE',
] as const;

export type BatchAction = (typeof BATCH_ACTIONS)[number];

/**
 * 批量操作。
 *
 * 单事务执行：要么全部生效，要么全部不生效。批量删除是软删除。
 */
export class BatchProductsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    maxItems: 200,
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({ enum: BATCH_ACTIONS })
  @IsIn(BATCH_ACTIONS)
  action!: BatchAction;

  @ApiPropertyOptional({ description: 'action=SET_CATEGORY 时必填' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    enum: ['SET', 'PERCENT'],
    description:
      'action=ADJUST_PRICE 时必填。SET 设为固定价，PERCENT 按百分比调整',
  })
  @IsOptional()
  @IsIn(['SET', 'PERCENT'])
  mode?: 'SET' | 'PERCENT';

  @ApiPropertyOptional({
    description:
      'action=ADJUST_PRICE 时必填。SET 模式为分（整数，非负）；' +
      'PERCENT 模式为百分比整数（10 表示 +10%，允许负值表示降价）',
  })
  @IsOptional()
  @IsInt()
  // PERCENT 允许负数（降价）；SET 模式非负由 service 层夹。两者共用一个字段，
  // 所以下限放在这里取最宽的合法集合（-100 表示打到 0）。
  @Min(-100)
  value?: number;
}
