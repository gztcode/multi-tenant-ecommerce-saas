import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { CreateCouponDto } from './create-coupon.dto';

/**
 * 平台超管创建平台券。
 *
 * ⚠️ **仍然不声明 `scope`**（M7）：作用域由服务端按登录身份推导，
 * 平台超管创建的券一律 PLATFORM，客户端说了不算。
 *
 * ⚠️ **`tenantId` 是平台券的归属租户**：平台券要挂在某个租户名下，
 * 否则租户扩展的平台作用域写入要求显式指定 tenantId，写不进去。
 * 平台券的查询走平台作用域（跨租户）并限定 `scope = PLATFORM`，
 * 所以它对所有店铺生效。
 */
export class CreatePlatformCouponDto extends CreateCouponDto {
  @ApiProperty({ description: '平台券归属的租户 id' })
  @IsString()
  tenantId!: string;
}
