import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformReportController } from './platform-report.controller';
import { PlanService } from './plan.service';
import { SubscriptionService } from './subscription.service';
import { InvoiceService } from './invoice.service';
import { QuotaService } from './quota.service';
import { ReportService } from './report.service';

/**
 * 计费模块（阶段 5b）。
 *
 * ⚠️ **`billing` 模块不 import `payment`** —— 它一旦 import，
 * `order → billing → payment → order` 就成了环（NestJS 启动报错）。
 * ⚠️ **导出 `SubscriptionService`** —— 下单流程（Task 6）要调 `canAcceptOrders`，
 * 模块依赖方向是 `order → billing`（单向）。
 * ⚠️ **导出 `InvoiceService`** —— 支付模块（Task 5）要靠它把「账单付清」
 * 变成「订阅期延长」。依赖方向是 `payment → billing`（单向），
 * 与上面的 `order → billing` 一起不构成环。
 */
@Module({
  imports: [AuthModule],
  controllers: [
    BillingController,
    PlatformBillingController,
    PlatformReportController,
  ],
  providers: [
    PlanService,
    SubscriptionService,
    InvoiceService,
    QuotaService,
    ReportService,
  ],
  exports: [PlanService, SubscriptionService, InvoiceService, QuotaService],
})
export class BillingModule {}
