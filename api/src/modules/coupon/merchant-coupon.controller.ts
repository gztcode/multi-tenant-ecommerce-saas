import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CouponService } from './coupon.service';
import { PromotionService } from './promotion.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

/**
 * 商家侧的优惠券与活动接口。
 *
 * ⚠️ **路径是 `merchant/coupons` 而不是 `coupons`**——
 * 与 `merchant/orders` 同款理由：消费者侧与商家侧的鉴权方式根本不同，
 * 同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 */
@ApiTags('merchant-coupons')
@Controller('merchant/coupons')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantCouponController {
  constructor(private readonly couponService: CouponService) {}

  // ---------- 券 ----------

  @Get()
  @ApiOperation({ summary: '券列表' })
  list() {
    return this.couponService.listCoupons();
  }

  @Post()
  @ApiOperation({ summary: '创建券' })
  create(@Body() dto: CreateCouponDto) {
    return this.couponService.createCoupon(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '改券（暂停 / 启用 / 改面额）' })
  update(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.couponService.updateCoupon(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删券（软删）' })
  remove(@Param('id') id: string) {
    return this.couponService.deleteCoupon(id);
  }
}

/**
 * 商家侧的满减活动接口。
 *
 * ⚠️ **与券分成两个 controller**：路径不同（`merchant/promotions`），
 * 守卫相同。挂在同一个 controller 上会让路径前缀无法区分。
 *
 * ⚠️ 活动是「店铺级、自动生效」的优惠，与券「用户持有、手动使用」
 * 是两回事，前端入口与管理动作都不一样。
 */
@ApiTags('merchant-promotions')
@Controller('merchant/promotions')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantPromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Get()
  @ApiOperation({ summary: '活动列表' })
  list() {
    return this.promotionService.list();
  }

  @Post()
  @ApiOperation({ summary: '创建活动' })
  create(@Body() dto: CreatePromotionDto) {
    return this.promotionService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '改活动（暂停 / 启用 / 改减免额）' })
  update(@Param('id') id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotionService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删活动（软删）' })
  remove(@Param('id') id: string) {
    return this.promotionService.remove(id);
  }
}
