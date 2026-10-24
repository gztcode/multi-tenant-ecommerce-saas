import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_CART_QUANTITY } from './add-cart-item.dto';

/**
 * 改购物车条目的数量。
 *
 * 数量是**绝对值**而不是增量——「改成 3 件」比「再加 2 件」少一个
 * 歧义（再加 2 件在数量上限附近会失败，而改成 3 件语义明确）。
 */
export class UpdateCartItemDto {
  @ApiProperty({
    minimum: 1,
    maximum: MAX_CART_QUANTITY,
    description: `目标数量，上限 ${MAX_CART_QUANTITY}`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_CART_QUANTITY)
  quantity!: number;
}
