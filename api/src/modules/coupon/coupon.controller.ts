import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { CouponService } from './coupon.service';
import { ClaimCouponDto } from './dto/claim-coupon.dto';
import { PreviewCouponDto } from './dto/preview-coupon.dto';

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
  @ApiOperation({ summary: '我持有的券（含每用户状态：是否已用、领了几张）' })
  mine(@CurrentUser() user: CurrentUserPayload) {
    return this.couponService.listMine(user.userId);
  }

  /**
   * 优惠预览。
   *
   * ⚠️ **返回的是「估算值」**（护栏 M17）：`originalAmount` 由客户端按购物车
   * 里的 SKU 价格算出来，只用于预览。下单时服务端会在锁住 SKU 之后
   * 按**实时价**重算，预览值不参与实付计算——页面要提示「以提交时为准」。
   */
  @Get('preview')
  @ApiOperation({
    summary: '优惠预览（估算值，下单时以服务端算出的为准）',
  })
  preview(
    @Query() query: PreviewCouponDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.couponService.preview(user.userId, query.originalAmount);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '领取优惠券' })
  claim(@Body() dto: ClaimCouponDto, @CurrentUser() user: CurrentUserPayload) {
    return this.couponService.claim(dto, user.userId);
  }
}
