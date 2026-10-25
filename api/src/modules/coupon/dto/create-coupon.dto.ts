import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 创建优惠券。
 *
 * ⚠️ **不声明 `scope` 字段**（M7）：平台券只能由平台超管创建，
 * 而「当前用户是不是平台超管」是**服务端**从登录身份推导的，
 * 不是客户端能传的字段。客户端传 `scope` 会被
 * `forbidNonWhitelisted` 直接 400。
 *
 * ⚠️ **不声明 `claimedCount` / `reservedCount` / `usedCount`**：
 * 它们是服务端的计数，客户端传了就是伪造额度。
 *
 * ⚠️ **不声明 `type`**：本阶段只实现满减券（FIXED）。
 * 让客户端传 `type: 'PERCENT'` 的话，库里会躺着一张本阶段算不动的券
 * （引擎会静默跳过它，用户领了却用不了）。折扣券的实现留到将来的阶段，
 * 那时再放开这个字段。
 *
 * ⚠️ **不声明 `tenantId`**：租户由上下文推导。
 */
export class CreateCouponDto {
  @ApiProperty({ description: '券码（租户内唯一）' })
  @IsString()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ description: '券名称' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ required: false, description: '券说明' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: '面额（整数分）', example: 1000 })
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  value!: number;

  @ApiProperty({ description: '使用门槛（整数分），0 = 无门槛', example: 5000 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  minAmount!: number;

  @ApiProperty({ required: false, description: '每用户限领张数，不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  perUserLimit?: number;

  @ApiProperty({ required: false, description: '总发放上限，不填 = 不限' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  totalLimit?: number;

  @ApiProperty({ description: '生效开始时间（ISO 8601）' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ description: '生效结束时间（ISO 8601）' })
  @IsISO8601()
  endsAt!: string;
}
