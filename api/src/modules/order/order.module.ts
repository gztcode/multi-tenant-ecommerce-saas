import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CouponModule } from '../coupon/coupon.module';
import { BillingModule } from '../billing/billing.module';
import { OrderInventoryService } from './inventory.service';
import { OrderService } from './order.service';
import { OrderTimeoutService } from './order-timeout.service';
import { OrderTimeoutWorker } from './order-timeout.worker';
import { OrderController } from './order.controller';
import { MerchantOrderController } from './merchant-order.controller';

/**
 * 订单模块（阶段 3）。
 *
 * 包含四部分：
 * - `OrderInventoryService`（Task 3）：库存预占 / 售出 / 释放
 * - `OrderService` + 状态机（Task 4）：下单与状态流转
 * - `OrderTimeoutService` + `OrderTimeoutWorker`（Task 6）：支付超时释放
 * - 两个 controller：消费者侧（OptionalJwtAuthGuard）与商家侧（JwtAuthGuard）
 *
 * 导入 AuthModule 是为了拿到 JwtAuthGuard / OptionalJwtAuthGuard 依赖的
 * Passport 策略（JwtStrategy 由 AuthModule 提供）。
 * QueueModule 是 `@Global()`，QueueService 在任何模块里都能直接注入。
 *
 * ⚠️ **导入 CouponModule**（阶段 5a Task 4）：下单要调 `computeForOrder`
 * 与预占核销。模块依赖方向是 `order` → `coupon`（单向）——
 * 反过来（coupon import order）会造成循环依赖。
 *
 * 导出服务：
 * - `OrderService`：Task 5 的 payment 模块要调它把订单转 `PAID` / `REFUNDED`
 *   （依赖方向 `payment → order`，单向）
 * - `OrderInventoryService`：Task 5 的支付成功要调 `deductInTx` 确认售出
 * - `OrderTimeoutService`：阶段 5f Task 3 的支付补偿扫描要调
 *   `releaseExpiredOrder` 补释放「超时任务丢失」的订单（依赖方向仍是
 *   `payment → order`，单向）
 */
@Module({
  imports: [AuthModule, CouponModule, BillingModule],
  controllers: [OrderController, MerchantOrderController],
  providers: [
    OrderInventoryService,
    OrderService,
    OrderTimeoutService,
    OrderTimeoutWorker,
  ],
  exports: [OrderService, OrderInventoryService, OrderTimeoutService],
})
export class OrderModule {}
