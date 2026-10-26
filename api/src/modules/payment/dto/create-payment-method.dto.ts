import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';

/**
 * 绑定一个支付方式。
 *
 * ⚠️ **不接受 `token`** —— token 必须由渠道给（见 `PaymentMethodService`）。
 * 客户端传 token 的话，商家就能绑一个「不属于自己的」支付方式，
 * 续费时扣的是别人的钱。请求体里带 `token` 会被
 * `forbidNonWhitelisted` 直接 400。
 */
export class CreatePaymentMethodDto {
  @ApiProperty({ description: '支付方式类型：CARD / WECHAT / ALIPAY' })
  @IsIn(['CARD', 'WECHAT', 'ALIPAY'])
  type!: string;

  @ApiProperty({ description: '支付渠道名' })
  @IsString()
  @MaxLength(50)
  channel!: string;
}
