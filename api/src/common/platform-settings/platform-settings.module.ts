import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../../modules/tenancy/tenancy.module';
import { PlatformSettingService } from './platform-setting.service';

/**
 * 平台设置的**全局模块**（阶段 6a Task 4）。
 *
 * 只含 `PlatformSettingService`，不注册控制器 —— 控制器在
 * `modules/platform-settings/`，那里可以注入全局的 `PayoutProviderRegistry`
 * 来列出可选出款渠道。
 *
 * ⚠️ **必须是 `@Global()`**：`PayoutProvidersModule`（核实服务要读平台默认渠道）
 *    与本模块互相引用会成环；做成全局模块就不产生模块依赖边，
 *    任何模块直接 `@Inject`/构造函数注入 `PlatformSettingService` 即可。
 *
 * ⚠️ **只依赖 `TenancyModule`**（提供 `TenantPrismaService`），
 *    **绝不能** import 注册表或 `common/payment/*`。
 */
@Global()
@Module({
  imports: [TenancyModule],
  providers: [PlatformSettingService],
  exports: [PlatformSettingService],
})
export class PlatformSettingsModule {}
