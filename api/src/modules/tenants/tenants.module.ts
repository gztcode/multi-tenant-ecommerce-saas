import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { AuthModule } from '../auth/auth.module';

/**
 * 商家管理模块。
 *
 * 与 StoresModule 同理：TenantPrismaService 来自 @Global 的 TenancyModule，
 * AuthModule 提供 @Roles() 里挂的 JwtAuthGuard。
 *
 * 本模块的路由全部由类级 @Roles(PLATFORM_ADMIN) 保护，刻意**不导出** TenantsService：
 * 平台级能力不该被别的业务模块顺手 import 过去用，届时那些模块的调用方
 * 就不再受任何角色限制——访问控制必须落在路由这一层唯一可审计的地方。
 */
@Module({
  imports: [AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
