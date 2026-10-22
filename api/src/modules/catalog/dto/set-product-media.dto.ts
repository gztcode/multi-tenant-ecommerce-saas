import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

/**
 * 设置商品的媒体列表（整体替换）。
 *
 * 数组顺序就是 sort——第一个是封面。
 *
 * 整体替换而不是增量接口，与规格矩阵同理：前端不需要自己算增量，
 * 后端在一个事务里做「校验归属 → 删掉不再引用的 → 补上新引用的 → 重排 sort」。
 */
export class SetProductMediaDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    maxItems: 20,
    example: ['media-id-1', 'media-id-2'],
    description: '媒体 id 的有序列表，第一个是封面',
  })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  mediaIds!: string[];
}
