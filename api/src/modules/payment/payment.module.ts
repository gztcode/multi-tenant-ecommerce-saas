import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AuthModule } from '../auth/auth.module';
import { OrderModule } from '../order/order.module';
import { CouponModule } from '../coupon/coupon.module';
import { BillingModule } from '../billing/billing.module';
import { PaymentController } from './payment.controller';
import { WebhookController } from './webhook.controller';
import { FakePaymentController } from './fake-payment.controller';
import { SubscriptionPaymentController } from './subscription-payment.controller';
import { PaymentService } from './payment.service';
import { PaymentMethodService } from './payment-method.service';
import { RenewalService } from './renewal.service';
import { RenewalWorker } from './renewal.worker';
import { WebhookWorker } from './webhook.worker';
import { CompensationService } from './compensation.service';
import { CompensationWorker } from './compensation.worker';
import { FakePaymentProvider } from './fake-payment.provider';
import {
  SandboxPaymentProvider,
  isSandboxPaymentRegistrable,
} from './sandbox-payment.provider';
import { PayoutWorker } from './payout.worker';
import { PayoutScanScheduler } from './payout-scan.scheduler';
import { RefundScanScheduler } from './refund-scan.scheduler';
import { PayoutReconciliationResolver } from './payout-reconciliation-resolver.service';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutReconcileScheduler } from './payout-reconcile.scheduler';
import { PlatformPayoutReconciliationController } from './platform-payout-reconciliation.controller';
import { FakePayoutController } from './fake-payout.controller';
import { PaymentProvider } from './payment-provider.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PAYMENT_PROVIDER_LIST, PAYMENT_PROVIDERS } from './payment.constants';
import { PayoutProvidersModule } from '../../common/payment/payout-providers.module';

/**
 * 支付模块（阶段 3 Task 5）。
 *
 * ## 模块依赖方向：`payment` → `order`（单向）
 *
 * - payment 的 webhook 消费端要把订单转 `PAID` → 需要 order
 * - payment 的退款端点要转 `REFUNDED` → 需要 order
 * - **order 模块不依赖 payment 模块**（下单只锁 SKU、只算金额）
 *
 * 反过来（order import payment）会形成循环依赖：
 * 退款端点若放 order，order 要 import payment，而 payment 又要 import order
 * （流转订单）→ **循环依赖**。所以退款端点归 payment 模块，
 * order 只提供状态流转能力。
 *
 * ⚠️ **导入 CouponModule**（阶段 5a Task 5）：支付成功时要确认券的核销
 * （`RESERVED` → `USED`）。依赖方向是 `payment → coupon`（单向）——
 * `coupon` 模块**不**依赖 `payment` 也不依赖 `order`，
 * 所以 `payment → coupon`、`order → coupon`、`payment → order`
 * 三条边都不构成环。
 *
 * ⚠️ **导入 BillingModule**（阶段 5b Task 5）：订阅付款成功时要
 * 「账单付清 → 订阅期延长」，那是 billing 的 `InvoiceService` 的活。
 * 依赖方向是 `payment → billing`（单向）。
 *
 * ⚠️ **依赖图（阶段 5b 的铁律）**：
 * ```
 * payment  →  billing  →  （无）
 *    ↓          ↑
 *  order ────────┘
 * ```
 * ⚠️ **`billing` 模块绝对不能 import `payment`** —— 那就成了
 * `order → billing → payment → order` 的环，NestJS 启动直接报错。
 * 所以「凡是要碰支付渠道的事一律在 `payment` 模块里」：
 * 订阅付款的 webhook、建订阅支付单、自动扣款、支付方式的绑定 —— 全在 payment。
 * `billing` 只管「账目与权益」（套餐、订阅、账单、额度、报表）。
 *
 * ## 渠道注册
 *
 * ⚠️ 渠道表用 `Map` 而不是逐个注入具体的 provider 类：
 * 渠道是**可注册**的（将来接真渠道只要往 Map 里多放一个），
 * 而 `Map` 让「按渠道名找 provider」不需要 switch/if 链。
 */
@Module({
  imports: [
    AuthModule,
    OrderModule,
    CouponModule,
    BillingModule,
    // ⚠️ **出款渠道表与核实服务**（阶段 5m）——
    //    `@Global()` 模块，不产生模块依赖边（billing 也要用它）。
    PayoutProvidersModule,
    // ⚠️ **multipart**（阶段 5m）—— 本仓第一个文件上传的接口。
    //    MulterModule 提供 `FileInterceptor` 需要的 multer 实例。
    MulterModule.register({ limits: { fileSize: 5 * 1024 * 1024 } }),
  ],
  controllers: [
    PaymentController,
    WebhookController,
    FakePaymentController,
    SubscriptionPaymentController,
    FakePayoutController,
    // ⚠️ **渠道对账**（阶段 5m）
    PlatformPayoutReconciliationController,
  ],
  providers: [
    PaymentService,
    PaymentMethodService,
    RenewalService,
    RenewalWorker,
    WebhookWorker,
    CompensationService,
    CompensationWorker,
    FakePaymentProvider,
    SandboxPaymentProvider,
    // ⚠️ **出款执行消费端**（阶段 5h-2）：`PayoutExecutionService`
    //    来自 `BillingModule`（已导出），依赖方向 `payment → billing` 单向。
    PayoutWorker,
    // ⚠️ **出款兜底扫描的周期任务注册器**（阶段 5h-2）：
    //    `PayoutWorker` 只负责消费 `scan` job，没人往队列里投它的话
    //    `APPROVED` 救援路径就是死代码（审批后入队失败 → 单子永远停在已审批）。
    PayoutScanScheduler,
    // ⚠️ **退款核实扫描的周期任务注册器**（阶段 6c）：
    //    渠道回调会丢，没人扫的话 `REFUNDING` 的单永远没人核实。
    //    真正的活由 `WebhookWorker` 的 `refund-scan` 分支做。
    RefundScanScheduler,
    // ⚠️ **对账差异的处置**（阶段 5m Task 6）：A 类自动纠正 `PROCESSING → PAID`。
    //    B 类的人工处置在 billing 的 `PayoutExecutionService`（四道闸）。
    PayoutReconciliationResolver,
    // ⚠️ **渠道对账**（阶段 5m）：对账服务 + 定时任务注册器。
    //    ⚠️ `PayoutReconciliationResolver` 已在上面注册（Task 6）—— 不重复注册。
    PayoutReconciliationService,
    PayoutReconcileScheduler,
    {
      // ⚠️ 注册表要「一组实现」；Map 保留为兼容层。
      provide: PAYMENT_PROVIDER_LIST,
      useFactory: (
        fake: FakePaymentProvider,
        sandbox: SandboxPaymentProvider,
      ): PaymentProvider[] => [
        fake,
        // ⚠️ **沙箱只在非生产且配了 SANDBOX_CHANNEL_URL 时注册**（第二道保险）。
        ...(isSandboxPaymentRegistrable() ? [sandbox] : []),
      ],
      inject: [FakePaymentProvider, SandboxPaymentProvider],
    },
    PaymentProviderRegistry,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (list: PaymentProvider[]): Map<string, PaymentProvider> =>
        new Map(list.map((provider) => [provider.channel, provider])),
      inject: [PAYMENT_PROVIDER_LIST],
    },
  ],
  exports: [
    PaymentService,
    PaymentMethodService,
    RenewalService,
    PaymentProviderRegistry,
  ],
})
export class PaymentModule {}
