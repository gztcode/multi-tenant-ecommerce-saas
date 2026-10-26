import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CouponController } from './coupon.controller';
import { MerchantCouponController } from './merchant-coupon.controller';
import { MerchantPromotionController } from './merchant-coupon.controller';
import { PlatformCouponController } from './platform-coupon.controller';
import { CouponService } from './coupon.service';
import { CouponRedemptionService } from './coupon-redemption.service';
import { PromotionService } from './promotion.service';

/**
 * 营销模块（阶段 5a）。
 *
 * 券、领取、满减活动、优惠引擎。
 *
 * ⚠️ **导出 `CouponService` 与 `CouponRedemptionService`**：
 * Task 4 的下单流程要调 `computeForOrder` 与预占核销，
 * 模块依赖方向是 `order` → `coupon`（单向）——
 * 反过来（coupon import order）会造成循环依赖。
 */
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [
    CouponController,
    MerchantCouponController,
    MerchantPromotionController,
    PlatformCouponController,
  ],
  providers: [CouponService, CouponRedemptionService, PromotionService],
  exports: [CouponService, CouponRedemptionService, PromotionService],
})
export class CouponModule {}
