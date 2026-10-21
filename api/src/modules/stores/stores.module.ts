import { Module } from '@nestjs/common';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';
import { AuthModule } from '../auth/auth.module';

/**
 * 店铺模块。
 *
 * TenantPrismaService 由 @Global 的 TenancyModule 提供并导出，本模块不重复声明。
 * AuthModule 引入是为了拿到导出的 JwtAuthGuard（StoresController 在方法级用它），
 * JwtAuthGuard 同时在 AuthModule 的 providers 里注册，导出的也是同一个实例。
 */
@Module({
  imports: [AuthModule],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
