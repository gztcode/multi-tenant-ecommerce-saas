import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../../modules/tenancy/tenancy.module';
import { FakePayoutProvider } from './fake-payout.provider';
import { PAYOUT_PROVIDERS } from './payout.constants';
import type { PayoutProvider } from './payout-provider.interface';
import { PAYOUT_VERIFICATION } from './payout-verification';
import { PayoutVerificationService } from './payout-verification.service';

/**
 * 出款渠道与出款核实的**全局模块**（阶段 5m）。
 *
 * ## 为什么必须是全局的
 *
 * `billing` 模块的 `PayoutService.unstick` 要做「渠道核实闸」（防重复打款），
 * 但 **`billing` 绝对不能 import `payment`** —— 那会成
 * `order → billing → payment → order` 的环，NestJS 启动直接报错
 * （见 `billing.module.ts` 顶部的模块注释）。
 *
 * → 把渠道表与核实服务放进一个 `@Global()` 模块 → **不产生模块依赖边**，
 *   billing 直接 `@Inject(PAYOUT_VERIFICATION)` 就能拿到。
 *
 * ## 依赖方向
 *
 * ```
 * common/payment/payout-providers.module.ts（@Global）
 *   ├─ FakePayoutProvider
 *   ├─ PAYOUT_PROVIDERS（渠道表）
 *   ├─ PayoutVerificationService（三层核实实现）
 *   └─ PAYOUT_VERIFICATION（契约 token，指向上面那个实现）
 *        ↓ 全局可见，任何模块都能注入
 *   billing/PayoutService、payment/PayoutVerificationService
 * ```
 *
 * ⚠️ **本模块 import `TenancyModule` 是安全的** —— `TenancyModule` 不 import
 *    任何模块，它只是把 `common/tenant` 里的服务注册成全局。
 *    不构成环。
 */
@Global()
@Module({
  imports: [TenancyModule],
  providers: [
    FakePayoutProvider,
    {
      provide: PAYOUT_PROVIDERS,
      useFactory: (fake: FakePayoutProvider): Map<string, PayoutProvider> => {
        const providers = new Map<string, PayoutProvider>();
        providers.set(fake.channel, fake);
        return providers;
      },
      inject: [FakePayoutProvider],
    },
    PayoutVerificationService,
    {
      provide: PAYOUT_VERIFICATION,
      useExisting: PayoutVerificationService,
    },
  ],
  exports: [FakePayoutProvider, PAYOUT_PROVIDERS, PAYOUT_VERIFICATION],
})
export class PayoutProvidersModule {}
