import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 品类更新。所有字段可选，不传的保持原值。
 *
 * 用展开运算逐字段构造 data 而不是 `...dto`：直接展开会把将来往 DTO 上
 * 加的字段一并灌进 data，无意中扩大写入面。
 *
 * ⚠️ 不允许改 slug。slug 参与 URL，改了会让旧链接失效，
 * 而阶段 2 不做重定向（设计文档 §十三 开放问题 2）。商品的 slug 同理。
 */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ description: '父品类 id，null 表示提到一级' })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @ApiPropertyOptional({ description: '同级排序' })
  @IsOptional()
  @IsInt()
  sort?: number;
}
