import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoresModule } from './modules/stores/stores.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { MediaModule } from './modules/media/media.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ThemeModule } from './modules/theme/theme.module';
import { QueueModule } from './modules/queue/queue.module';
import { CartModule } from './modules/cart/cart.module';
import { OrderModule } from './modules/order/order.module';
import { PaymentModule } from './modules/payment/payment.module';
import { CouponModule } from './modules/coupon/coupon.module';
import { BillingModule } from './modules/billing/billing.module';

// TenantPrismaService 由全局的 TenancyModule 提供并导出，
// 这里不再重复声明，避免出现两个实例（两个连接池）。
//
// 注意：RolesGuard 刻意**不**注册成 APP_GUARD。
// NestJS 的守卫顺序是 [...全局, ...类级, ...方法级]，全局守卫先于路由级
// @UseGuards(JwtAuthGuard) 执行，request.user 尚未填充，鉴权会失效。
// 改由 @Roles() 把守卫挂到方法元数据上，见 common/decorators/roles.decorator.ts。
@Module({
  imports: [
    HealthModule,
    TenancyModule,
    AuthModule,
    StoresModule,
    TenantsModule,
    CatalogModule,
    MediaModule,
    InventoryModule,
    ThemeModule,
    QueueModule,
    CartModule,
    OrderModule,
    PaymentModule,
    CouponModule,
    BillingModule,
  ],
})
export class AppModule {}
