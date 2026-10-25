import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrderModule } from '../order/order.module';
import { PaymentController } from './payment.controller';
import { WebhookController } from './webhook.controller';
import { FakePaymentController } from './fake-payment.controller';
import { PaymentService } from './payment.service';
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
 * ## 渠道注册
 *
 * ⚠️ 渠道表用 `Map` 而不是逐个注入具体的 provider 类：
 * 渠道是**可注册**的（将来接真渠道只要往 Map 里多放一个），
 * 而 `Map` 让「按渠道名找 provider」不需要 switch/if 链。
 */
@Module({
  imports: [AuthModule, OrderModule],
  controllers: [PaymentController, WebhookController, FakePaymentController],
  providers: [
    PaymentService,
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
  exports: [PaymentService],
})
export class PaymentModule {}
