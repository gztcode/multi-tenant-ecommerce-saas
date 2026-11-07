import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsMiddleware } from './metrics.middleware';

/**
 * 指标模块（阶段 11：可观测性）。
 *
 * ⚠️ **@Global**：`MetricsController` 要注入 `MetricsService`，横切基础设施
 *   不参与业务模块依赖图（与 QueueModule 同款待遇）。
 *
 * ⚠️ **MetricsMiddleware 而非拦截器**：Nest 的管道顺序是「守卫在拦截器
 *   之前」，守卫拒绝 401/403 时拦截器根本不会执行、请求完全不进指标；
 *   中间件在守卫之前运行，能统计到全部请求。中间件必须经 NestModule 的
 *   configure() 应用（见 app.module.ts），所以这里要注册成 provider。
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsMiddleware],
  exports: [MetricsService, MetricsMiddleware],
})
export class MetricsModule {}
