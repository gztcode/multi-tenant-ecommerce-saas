import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * 商家订阅一个套餐。
 *
 * ⚠️ **只接受 `planId`**（护栏 M1 / M2 / M9）：
 * 价格、周期、额度、抽佣费率一律从库里读。
 * 客户端多传一个 `price` 会被 `forbidNonWhitelisted` 直接 400；
 * 而更根本的问题是「客户端算的钱一律不信」。
 */
export class SubscribeDto {
  @ApiProperty({ description: '套餐 id' })
  @IsString()
  @MaxLength(64)
  planId!: string;
}
