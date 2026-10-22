import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 规格值的输入。
 *
 * ⚠️ **不要加 id 字段。** 规格值按 `(specId, value)` 的**文本**匹配，
 * 而不是按 id——传 id 进来只会给「把 A 商品的规格值挂到 B 商品上」开门，
 * 而文本匹配天然不会有这个问题。前端也不需要传 id。
 */
export class SpecValueInputDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: '红色' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  value!: string;
}

/** 规格维度的输入 */
export class SpecInputDto {
  @ApiProperty({ minLength: 1, maxLength: 40, example: '颜色' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  // ⚠️ 数组元素的类型要用 `type: () => [Xxx]` 声明，不能写 `items: Xxx`：
  // 后者的 items 类型是 SchemaObject | ReferenceObject，装不下 DTO 类本身，
  // 编译期就报 TS2322（`typeof Xxx` 与之不兼容）。`() => [Xxx]` 会被
  // Swagger 展开成「元素类型为 Xxx 的数组」，也是这个版本唯一能过编译的写法。
  @ApiProperty({ type: () => [SpecValueInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SpecValueInputDto)
  values!: SpecValueInputDto[];

  @ApiPropertyOptional({ default: 0, description: '维度展示顺序' })
  @IsOptional()
  @IsInt()
  sort?: number;
}

/**
 * 规格矩阵整体替换。
 *
 * 前端提交一份完整的规格结构，后端在一个事务里匹配既有 SKU、新增缺失的、
 * 删除多余的。增量接口会让前端自己算笛卡尔积再发一串请求，
 * 中途失败会留下「值删了但 SKU 还在」这类不一致状态。
 */
export class ReplaceSpecsDto {
  @ApiProperty({
    minimum: 1,
    description: '乐观锁版本号，与当前商品版本不一致时返回 409',
  })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({
    type: () => [SpecInputDto],
    maxItems: 2,
    description: '规格维度，最多 2 个',
  })
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => SpecInputDto)
  specs!: SpecInputDto[];
}
