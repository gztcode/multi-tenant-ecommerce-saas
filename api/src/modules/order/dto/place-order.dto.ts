import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 单个 SKU 的数量上限。
 *
 * 与加购的上限一致（`MAX_CART_QUANTITY`）。下单时**必须再校验一遍**：
 * 加购和下单之间可能隔了很久，中间的加购请求也可能是构造出来绕过加购接口的。
 */
export const MAX_ORDER_QUANTITY = 99;

/**
 * 一笔订单最多的条目行数。
 *
 * 防止构造超大订单（几百行）把下单事务拖垮。
 */
export const MAX_ORDER_LINES = 100;

/** 下单条目 */
export class PlaceOrderItemDto {
  @ApiProperty({ description: 'SKU id' })
  @IsString()
  skuId!: string;

  @ApiProperty({
    minimum: 1,
    maximum: MAX_ORDER_QUANTITY,
    description: `购买数量，上限 ${MAX_ORDER_QUANTITY}`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_QUANTITY)
  quantity!: number;
}

/**
 * 下单。
 *
 * ⚠️ **不接受任何价格字段**（`unitPrice` / `totalAmount` / `price`）：
 * 金额只从 SKU 读。请求体里带价格字段会被 `forbidNonWhitelisted` 直接 400。
 *
 * ⚠️ 也不接受 `tenantId`（租户扩展注入）、`customerId`（从登录身份推导）、
 * `orderNo`（服务端生成）。
 */
export class PlaceOrderDto {
  @ApiProperty({ description: '收货地址 id（取自地址簿）' })
  @IsString()
  addressId!: string;

  @ApiProperty({ type: [PlaceOrderItemDto], description: '购买的条目' })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => PlaceOrderItemDto)
  items!: PlaceOrderItemDto[];

  @ApiProperty({
    required: false,
    description: '幂等键：同一个键重复提交返回同一个订单',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  @ApiProperty({ required: false, description: '买家备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}
