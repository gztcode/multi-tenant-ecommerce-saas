import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';

/**
 * 单个 SKU 的加购数量上限。
 *
 * ⚠️ 上限是必要的：没有它，一次 `quantity: 999999` 就能让后续所有下单
 * 都失败（库存不足），但那单商品还是会占着购物车显示——
 * 用户的购物车被一条永远下单不成功的记录占着。
 */
export const MAX_CART_QUANTITY = 99;

/**
 * 加购。
 *
 * 不接受 tenantId / price / cartId：
 * - tenantId 由租户扩展注入
 * - 价格只从 SKU 读，绝不采信客户端传值（护栏 8 同款理由）
 * - cartId 由服务端按 (租户, 游客 token / 消费者) 推导
 */
export class AddCartItemDto {
  @ApiProperty({ description: 'SKU id' })
  @IsString()
  skuId!: string;

  @ApiProperty({
    minimum: 1,
    maximum: MAX_CART_QUANTITY,
    description: `加购数量，上限 ${MAX_CART_QUANTITY}`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_CART_QUANTITY)
  quantity!: number;
}
