import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { AddressController } from './address.controller';
import { AddressService } from './address.service';

/**
 * 购物车与地址簿模块。
 *
 * 导入 AuthModule 是为了拿到 JwtAuthGuard 与 OptionalJwtAuthGuard 依赖的
 * Passport 策略（JwtStrategy 由 AuthModule 提供）。
 */
@Module({
  imports: [AuthModule],
  controllers: [CartController, AddressController],
  providers: [CartService, AddressService],
  // 导出服务：Task 4 的下单流程要用购物车（取条目、算金额、下单后清空）
  exports: [CartService, AddressService],
})
export class CartModule {}
