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
import { ReceiptService } from './receipt.service';
import { PlatformSettlementController } from './platform-settlement.controller';
import { SettlementService } from './settlement.service';
import { PayoutService } from './payout.service';
import { PayoutAccountService } from './payout-account.service';
import { PayoutCipherService } from './payout-cipher.service';
import { PayoutExecutionService } from './payout-execution.service';
import { PayoutEncryptionSelfCheck } from './payout-encryption-self-check.service';
import { PlatformPayoutController } from './platform-payout.controller';
import { MerchantPayoutController } from './merchant-payout.controller';
import { MerchantPayoutAccountController } from './merchant-payout-account.controller';
import { LedgerService } from './ledger.service';
import { MerchantStatementController } from './merchant-statement.controller';
import { MerchantStatementService } from './merchant-statement.service';

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
 * ⚠️ **导出 `SettlementService`** —— 结算单（阶段 5g）目前**只有平台侧**在用，
 *   导出是为了将来出款阶段（`PAID` 状态的流转）能复用它，
 *   依赖方向是 `payment → billing`（单向），与上面几条同款，不构成环。
 * ⚠️ **导出 `ReceiptService`** —— 商家应收货款流水（阶段 5h-1）与抽佣流水同款：
 *   支付成功记一笔货款、退款成功记一笔冲回，两者都与订单状态流转同事务。
 *   依赖方向同样是 `payment → billing`（单向），不构成环。
 */
@Module({
  imports: [AuthModule],
  controllers: [
    BillingController,
    PlatformBillingController,
    PlatformReportController,
    PlatformSettlementController,
    // 出款（阶段 5h-1）
    PlatformPayoutController,
    MerchantPayoutController,
    MerchantPayoutAccountController,
    // 商家对账单（阶段 5i）
    MerchantStatementController,
  ],
  providers: [
    PlanService,
    SubscriptionService,
    InvoiceService,
    QuotaService,
    ReportService,
    CommissionService,
    SettlementService,
    ReceiptService,
    // 出款（阶段 5h-1）
    PayoutService,
    PayoutAccountService,
    // 收款账户字段加密（阶段 5j）
    // ⚠️ **刻意不导出** —— 本阶段只有本模块用，保持最小面。
    //    worker 在 payment 模块是通过 `PayoutExecutionService` 间接拿到账号的。
    PayoutCipherService,
    // 出款执行（阶段 5h-2）
    PayoutExecutionService,
    // 账目加密自检（阶段 5k）
    PayoutEncryptionSelfCheck,
    // 账目按期聚合（阶段 5i）
    LedgerService,
    // 商家对账单（阶段 5i）
    MerchantStatementService,
  ],
  exports: [
    PlanService,
    SubscriptionService,
    InvoiceService,
    QuotaService,
    CommissionService,
    SettlementService,
    ReceiptService,
    // ⚠️ **导出 `PayoutExecutionService`** —— `payment` 模块的
    //    `PayoutWorker` 要靠它落状态（设计 §4.1）。
    //    依赖方向是 `payment → billing`（单向），不构成环。
    PayoutExecutionService,
    // ⚠️ **导出 `LedgerService`** —— 商家侧对账单（阶段 5i Task 5）
    //    要注入它做按期聚合（出款页与对账单共用同一份聚合）。
    LedgerService,
    // ⚠️ **导出 `PayoutEncryptionSelfCheck`** —— `main.ts` 要用
    //    `app.get()` 拿到它，在 `app.listen()` 之前跑自检。
    PayoutEncryptionSelfCheck,
  ],
})
export class BillingModule {}
