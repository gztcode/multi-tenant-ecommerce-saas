import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { AuthModule } from './modules/auth/auth.module';
import { StoresModule } from './modules/stores/stores.module';
import { TenantsModule } from './modules/tenants/tenants.module';

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
  ],
})
export class AppModule {}
