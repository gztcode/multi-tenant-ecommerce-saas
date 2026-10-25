import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 商家发货。
 *
 * 只接受快递单号——发货就是把订单从 `PAID` 转到 `SHIPPED`，
 * 金额、条目都不能改（要改得走退款重下）。
 */
export class ShipOrderDto {
  @ApiProperty({ description: '快递单号' })
  @IsString()
  @MaxLength(100)
  trackingNo!: string;

  @ApiProperty({ required: false, description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}
