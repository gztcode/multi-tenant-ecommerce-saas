import { Module, OnModuleInit } from '@nestjs/common';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express } from 'express';
import { LoggingInterceptor } from './common/http/logging.interceptor';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { LockModule } from './common/lock/lock.module';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { MetricsMiddleware } from './common/metrics/metrics.middleware';
import { MetricsModule } from './common/metrics/metrics.module';
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
import { PlatformSettingsApiModule } from './modules/platform-settings/platform-settings.module';

// TenantPrismaService 由全局的 TenancyModule 提供并导出，
// 这里不再重复声明，避免出现两个实例（两个连接池）。
//
// 注意：RolesGuard 刻意**不**注册成 APP_GUARD。
// NestJS 的守卫顺序是 [...全局, ...类级, ...方法级]，全局守卫先于路由级
// @UseGuards(JwtAuthGuard) 执行，request.user 尚未填充，鉴权会失效。
// 改由 @Roles() 把守卫挂到方法元数据上，见 common/decorators/roles.decorator.ts。
@Module({
  imports: [
    MetricsModule,
    LockModule,
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
    // 平台默认渠道设置接口（阶段 6a Task 4）
    PlatformSettingsApiModule,
  ],
  // HTTP 访问日志拦截器 + 全局结构化日志服务。
  //
  // ⚠️ **必须注册成 provider**，main.ts 才能用 app.get() 拿它们——
  //    未注册的类 app.get() 会抛 UnknownElementException，而单测/e2e
  //    都不加载 main.ts，这个坑在 CI 里跑不出来（API 会在启动阶段死掉）。
  providers: [LoggingInterceptor, PinoLoggerService],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  /**
   * 只信任**一跳**代理（游客查单防爆破的 P1 修复）。
   *
   * ## 为什么要开
   *
   * 不开 `trust proxy` 时 Express **完全不采信** `x-forwarded-for`，
   * `req.ip` 恒等于 TCP 对端地址。生产上 api 的调用方是 Nginx 与
   * 三个 BFF 容器，于是 `req.ip` 恒为「网关 / BFF 容器的 IP」——
   * 防爆破计数按「来源 IP × 订单号」隔离就退化成了「按订单号全局封杀」，
   * 一个坏客户端就能把真实客户的查单入口锁死 10 分钟。
   *
   * ## 为什么是 1 而不是 true
   *
   * `true` = 信任**所有**代理，Express 会取 `x-forwarded-for` 的**最左**项，
   * 那正是客户端自己就能写的值 —— 限流立刻可被随手换 IP 绕过。
   * `1` = 只信任紧邻的那一跳，取 XFF 的**最右**项：它是代理层追加的
   * 真实 TCP 对端，客户端伪造的值只可能落在左侧。
   *
   * ## 前提
   *
   * - api 端口不对公网暴露（`infra/docker-compose.yml` 里绑 `127.0.0.1`），
   *   直连 api 的请求只能来自本机/容器网内的可信组件；
   * - 网关（`infra/nginx/templates/prod.conf.template`）用
   *   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`，
   *   追加在**右侧**，所以最右一项始终是真实对端。
   *
   * ## 为什么落在 AppModule 而不是 main.ts
   *
   * `main.ts` 只在生产启动时加载，**e2e 不加载它**——配置写在那里
   * 就不会被任何测试覆盖。这里的 `onModuleInit` 在 `app.init()` 阶段
   * 执行，早于第一个请求，且 e2e 与生产走同一条路径。
   */
  onModuleInit(): void {
    // ⚠️ HttpAdapterHost 上**没有** getInstance()——它只暴露 httpAdapter，
    //    getInstance() 是 AbstractHttpAdapter 上的方法。
    const expressApp = this.httpAdapterHost.httpAdapter.getInstance<Express>();
    expressApp.set('trust proxy', 1);
  }

  // 请求 ID 中间件（阶段 11）：在一切路由之前给每个请求挂 requestId，
  // LoggingInterceptor / AllExceptionsFilter 的日志都带它。
  // HTTP 指标中间件（阶段 11）：在守卫之前注册 res 'finish' 监听，
  // 守卫拒绝的 401/403 也能进指标（拦截器版本做不到，见 metrics.module 注释）。
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, MetricsMiddleware).forRoutes('*');
  }
}
