import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../../modules/tenancy/tenancy.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { FakePayoutProvider } from './fake-payout.provider';
import { PAYOUT_PROVIDER_LIST, PAYOUT_PROVIDERS } from './payout.constants';
import type { PayoutProvider } from './payout-provider.interface';
import { PayoutProviderRegistry } from './payout-provider.registry';
import { PAYOUT_VERIFICATION } from './payout-verification';
import { PayoutVerificationService } from './payout-verification.service';
import {
  SandboxPayoutProvider,
  isSandboxPayoutRegistrable,
} from './sandbox-payout.provider';

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
  // ⚠️ **阶段 6a：import 平台设置模块** —— 后续核实服务要注入
  //    `PlatformSettingService` 读「平台默认渠道」做兜底。
  //    `PlatformSettingsModule` 只依赖 `TenancyModule`、不 import 本模块，
  //    所以**不构成环**。
  imports: [TenancyModule, PlatformSettingsModule],
  providers: [
    FakePayoutProvider,
    {
      // ⚠️ **必须用工厂而不是类注册**（阶段 6b）：`SandboxPayoutProvider` 的
      //    构造函数收一个 `number`（单次 HTTP 超时预算，带默认值）。
      //    以类注册时 Nest 会反射构造参数，把 `Number` 当成一个待注入的
      //    provider → 启动直接报「Nest can't resolve dependencies of the
      //    SandboxPayoutProvider (?)」。用工厂则完全绕开反射。
      provide: SandboxPayoutProvider,
      useFactory: () => new SandboxPayoutProvider(),
    },
    {
      // ⚠️ 注册表要的是「一组实现」：它自己建索引、算描述符、做启用校验。
      provide: PAYOUT_PROVIDER_LIST,
      useFactory: (
        fake: FakePayoutProvider,
        sandbox: SandboxPayoutProvider,
      ): PayoutProvider[] => [
        fake,
        // ⚠️ **沙箱只在非生产且配了 SANDBOX_CHANNEL_URL 时注册**（第二道保险；
        //    第一道是启动校验与注册表的 devOnly 拦截）。没配地址就注册，
        //    会在运行期第一笔调用才炸。
        ...(isSandboxPayoutRegistrable() ? [sandbox] : []),
      ],
      inject: [FakePayoutProvider, SandboxPayoutProvider],
    },
    {
      // ⚠️ 兼容层：存量调用方仍按 Map 读渠道表；新代码只依赖注册表。
      provide: PAYOUT_PROVIDERS,
      useFactory: (list: PayoutProvider[]): Map<string, PayoutProvider> =>
        new Map(list.map((provider) => [provider.channel, provider])),
      inject: [PAYOUT_PROVIDER_LIST],
    },
    PayoutProviderRegistry,
    PayoutVerificationService,
    {
      provide: PAYOUT_VERIFICATION,
      useExisting: PayoutVerificationService,
    },
  ],
  exports: [
    FakePayoutProvider,
    PAYOUT_PROVIDER_LIST,
    PAYOUT_PROVIDERS,
    PayoutProviderRegistry,
    PAYOUT_VERIFICATION,
  ],
})
export class PayoutProvidersModule {}
