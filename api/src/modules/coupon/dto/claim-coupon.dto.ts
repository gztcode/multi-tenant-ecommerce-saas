import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 领取优惠券。
 *
 * ⚠️ **只接受 `couponId` 或 `code`**——券的面额、门槛、有效期一律从库里读。
 * 客户端传 `discountAmount` / `value` / `minAmount` 会被
 * `forbidNonWhitelisted` 直接 400（M2）。
 *
 * ⚠️ **不接受 `scope` / `tenantId` / `customerId`**：
 * 作用域由服务端推导，租户与用户都由登录身份推导。
 */
export class ClaimCouponDto {
  @ApiProperty({ required: false, description: '券 id（与 code 二选一）' })
  @IsOptional()
  @IsString()
  couponId?: string;

  @ApiProperty({ required: false, description: '券码（与 couponId 二选一）' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ required: false, description: '领取张数，默认 1', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;
}
