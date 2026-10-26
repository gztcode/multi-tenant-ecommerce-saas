import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 手动续费：发起订阅账单的支付。
 *
 * ⚠️ **不接受任何金额字段**（`amount` / `price`）：
 * 金额只从账单读。请求体里带金额字段会被 `forbidNonWhitelisted` 直接 400。
 */
export class PayInvoiceDto {
  @ApiProperty({
    required: false,
    description: '支付渠道名；不填用默认渠道',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  channel?: string;
}
