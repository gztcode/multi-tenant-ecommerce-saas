import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CouponService } from './coupon.service';
import { CreatePlatformCouponDto } from './dto/create-platform-coupon.dto';

/**
 * 平台超管创建平台券的接口。
 *
 * ⚠️ **为什么单独一个 controller / 一条路径**：
 * 商家侧的 `merchant/coupons` 挂的是 `@Roles(MERCHANT_OWNER)`，
 * 平台超管进不去；而平台的券必须由超管创建（设计 M7）。
 * 两条路径各自挂各自的角色守卫，「谁能创建哪种券」由路径决定，
 * 不靠请求体里的字段决定。
 *
 * ⚠️ **`scope` 依然不在请求体里**（M7）：它由服务端按登录身份推导，
 * 平台超管创建的券一律 PLATFORM。客户端传 `scope` 会被
 * `forbidNonWhitelisted` 直接 400。
 */
@ApiTags('platform-coupons')
@Controller('platform/coupons')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformCouponController {
  constructor(private readonly couponService: CouponService) {}

  @Post()
  @ApiOperation({ summary: '创建平台券（平台超管）' })
  create(@Body() dto: CreatePlatformCouponDto) {
    return this.couponService.createPlatformCoupon(dto);
  }
}
