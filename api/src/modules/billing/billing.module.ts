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
import { CommissionService } from './commission.service';

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
 * ⚠️ **导出 `CommissionService`** —— 支付模块要靠它记抽佣流水
 *   （支付成功记抽佣、退款成功记冲回，两者都与订单状态流转同事务）。
 *   依赖方向同样是 `payment → billing`（单向）。
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
    CommissionService,
  ],
  exports: [
    PlanService,
    SubscriptionService,
    InvoiceService,
    QuotaService,
    CommissionService,
  ],
})
export class BillingModule {}
