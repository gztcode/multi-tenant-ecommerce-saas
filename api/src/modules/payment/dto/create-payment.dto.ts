import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 发起支付。
 *
 * ⚠️ **不接受任何金额字段**（`amount` / `totalAmount` / `price`）：
 * 金额只从订单读。请求体里带金额字段会被 `forbidNonWhitelisted` 直接 400。
 *
 * ⚠️ 也不接受 `tenantId`（租户扩展注入）、`customerId`（从登录身份推导）。
 */
export class CreatePaymentDto {
  @ApiProperty({
    required: false,
    description: '支付渠道名；不填用默认渠道',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  channel?: string;
}
