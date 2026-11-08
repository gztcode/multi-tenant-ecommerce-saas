import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** 单个 SKU 的退货入库数量 */
export class ReturnItemDto {
  @ApiProperty({ description: 'SKU id（必须是该订单里的商品）' })
  @IsString()
  skuId!: string;

  @ApiProperty({ minimum: 1, description: '入库数量（件）' })
  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * 退货入库（阶段 11d）。
 *
 * ⚠️ **只有 REFUNDED 状态的订单能退**：货真退回来才入库。
 * 退款**不**自动回补库存是有意的取舍（见 README），这里是配套的手动入口。
 */
export class ReturnStockDto {
  @ApiProperty({ description: '订单 id（uuid，不是 orderNo）' })
  @IsString()
  orderId!: string;

  @ApiProperty({ type: [ReturnItemDto], description: '按 SKU 的入库明细' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  // ⚠️ 没有 @Type 的话 transform 模式下嵌套对象不会实例化成 DTO，
  // 嵌套校验会整段失败（400：skuId must be a string）。
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];

  @ApiPropertyOptional({
    maxLength: 200,
    description: '备注（如快递单号 / 退货原因）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
