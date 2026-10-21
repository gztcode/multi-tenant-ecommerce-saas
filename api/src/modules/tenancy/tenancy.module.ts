import { Global, Module } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantContextInterceptor } from './tenant-context.interceptor';

/**
 * 租户基础设施模块（全局）。
 *
 * 这里同时托管 `TenantPrismaService`：它是整个隔离机制的载体，
 * 任何需要访问数据库的模块都依赖它。放在本模块而非 AppModule，
 * 是为了让 `TenantResolverService` 与拦截器在同一个模块里就能完成依赖注入，
 * 而不依赖调用方模块恰好也提供了同一个 provider——否则任何独立引入
 * TenancyModule 的模块都会遇到「Nest can't resolve dependencies of the
 * TenantResolverService (TenantPrismaService)」。
 *
 * 本模块是 @Global 的，`TenantPrismaService` 导出后全应用共享同一个实例，
 * 不会出现重复连接。
 */
@Global()
@Module({
  providers: [
    TenantPrismaService,
    TenantResolverService,
    TenantContextInterceptor,
  ],
  exports: [
    TenantPrismaService,
    TenantResolverService,
    TenantContextInterceptor,
  ],
})
export class TenancyModule {}
