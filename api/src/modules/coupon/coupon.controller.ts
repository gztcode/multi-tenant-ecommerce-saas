import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { CouponService } from './coupon.service';
import { ClaimCouponDto } from './dto/claim-coupon.dto';

/**
 * 消费者侧的优惠券接口。
 *
 * ⚠️ **领券必须登录**：`coupon_claims` 记的是 customerId，
 * 游客领了也没地方记。所以这里挂 JwtAuthGuard（不是 OptionalJwtAuthGuard）。
 */
@ApiTags('coupons')
@Controller('coupons')
@UseGuards(JwtAuthGuard)
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Get('available')
  @ApiOperation({ summary: '当前可领取的券' })
  available() {
    return this.couponService.listAvailable();
  }

  @Get('mine')
  @ApiOperation({ summary: '我持有的券' })
  mine(@CurrentUser() user: CurrentUserPayload) {
    return this.couponService.listMine(user.userId);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '领取优惠券' })
  claim(@Body() dto: ClaimCouponDto, @CurrentUser() user: CurrentUserPayload) {
    return this.couponService.claim(dto, user.userId);
  }
}
