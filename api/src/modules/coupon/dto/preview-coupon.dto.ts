import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/**
 * 优惠预览的查询参数。
 *
 * ⚠️ **`originalAmount` 是客户端传的「估算值」**（前端用购物车里 SKU 的价格算出来的），
 * **只用于预览**。下单时服务端会在锁住 SKU 之后按**实时价**重算，
 * 预览值不参与实付计算（护栏 M17）。
 *
 * ⚠️ **金额一律整数分**：`@IsInt()` 拒绝小数。
 * 前端传 `12.5` 会被直接 400——浮点金额从这里就断掉源头。
 *
 * ⚠️ **`@Min(0)`**：负数金额没有意义（优惠不会把原价抬成负的）。
 */
export class PreviewCouponDto {
  @ApiProperty({
    description:
      '商品原价小计的**估算值**（整数分）。只用于预览，下单时按实时价重算。',
    minimum: 0,
    type: Number,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  originalAmount!: number;
}
