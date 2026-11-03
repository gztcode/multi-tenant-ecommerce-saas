import { Module } from '@nestjs/common';
import { PlatformSettingsModule } from '../../common/platform-settings/platform-settings.module';
import { PlatformSettingsController } from './platform-settings.controller';

/**
 * 平台设置接口模块（阶段 6a Task 4）。
 *
 * ⚠️ **只注册控制器**；服务由全局的 `PlatformSettingsModule` 提供。
 *    控制器注入的 `PayoutProviderRegistry` 来自全局的 `PayoutProvidersModule`，
 *    因此这里**不需要** import 它 —— 避免把 payment 模块拉进依赖图。
 *
 * ⚠️ **类名刻意加 `Api` 后缀**：`common/platform-settings/` 里已有同名模块
 *    （`PlatformSettingsModule`），两者分开命名，导入处不会看混。
 */
@Module({
  imports: [PlatformSettingsModule],
  controllers: [PlatformSettingsController],
})
export class PlatformSettingsApiModule {}
