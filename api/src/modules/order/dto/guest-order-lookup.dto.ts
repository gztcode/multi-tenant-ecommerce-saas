import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 游客订单查询（阶段 11）。
 *
 * ⚠️ **双因子**：订单号 + 收货手机号必须同时匹配。订单号会出现在
 * 支付回调、日志等场所（不是秘密），手机号才是这里真正的那把钥匙；
 * 缺了第二因子，「匿名请求按订单号读他人订单」的老问题就回来了。
 */
export class GuestOrderLookupDto {
  @ApiProperty({ description: '订单号' })
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  orderNo!: string;

  @ApiProperty({ description: '下单时填写的收货手机号' })
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phone!: string;
}
