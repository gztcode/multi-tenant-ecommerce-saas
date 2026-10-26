import { Module } from '@nestjs/common';
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
import { FakePaymentProvider } from './fake-payment.provider';
import { PaymentProvider } from './payment-provider.interface';
import { PAYMENT_PROVIDERS } from './payment.constants';

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
  imports: [AuthModule, OrderModule, CouponModule, BillingModule],
  controllers: [
    PaymentController,
    WebhookController,
    FakePaymentController,
    SubscriptionPaymentController,
  ],
  providers: [
    PaymentService,
    PaymentMethodService,
    RenewalService,
    RenewalWorker,
    WebhookWorker,
    FakePaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (fake: FakePaymentProvider): Map<string, PaymentProvider> => {
        const providers = new Map<string, PaymentProvider>();
        providers.set(fake.channel, fake);
        return providers;
      },
      inject: [FakePaymentProvider],
    },
  ],
  exports: [PaymentService, PaymentMethodService, RenewalService],
})
export class PaymentModule {}
