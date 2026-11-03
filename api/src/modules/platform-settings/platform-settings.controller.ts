import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import { PlatformSettingService } from '../../common/platform-settings/platform-setting.service';
import { SetPayoutChannelDto } from './dto/set-payout-channel.dto';

/**
 * 平台默认出款渠道的设置接口（阶段 6a Task 4）。
 *
 * ⚠️ **控制器放 `modules/platform-settings/`，服务放 `common/platform-settings/`** ——
 *    服务要能被 `PayoutProvidersModule`（核实服务读平台默认渠道）注入而又不成环，
 *    所以服务在全局 `common` 模块里；控制器可以注入全局的
 *    `PayoutProviderRegistry` 来列出下拉选项。
 *
 * ⚠️ **全部 `PLATFORM_ADMIN`** —— 这是在改「平台往哪家渠道打钱」，不是商家能碰的。
 */
@ApiTags('platform-settings')
@Controller('platform/settings')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformSettingsController {
  constructor(
    private readonly settings: PlatformSettingService,
    private readonly payoutProviders: PayoutProviderRegistry,
  ) {}

  @Get('payout-channel')
  @ApiOperation({
    summary: '当前平台默认出款渠道及来源',
    description:
      '尚未配置时返回 `{ channel: null, source: "NONE" }`（不是 409）—— 设置页要靠这个 GET 渲染保存表单。',
  })
  async getPayoutChannel() {
    return this.settings.readPayoutDefaultChannel();
  }

  @Put('payout-channel')
  @ApiOperation({
    summary: '设置平台默认出款渠道',
    description:
      '只影响之后新创建的出款单；已审批 / 处理中的单按出款单自身记录的渠道走。',
  })
  async setPayoutChannel(@Body() dto: SetPayoutChannelDto) {
    return this.settings.setPayoutDefaultChannel(
      dto.channel,
      this.currentOperatorId(),
    );
  }

  /**
   * 可选出款渠道（下拉用）。
   *
   * ⚠️ **用注册表的 `list()`**：它默认过滤 `devOnly`，生产环境永远看不到 sandbox，
   *    也不会出现「选了却执行不了」的渠道。
   */
  @Get('payout-channels')
  @ApiOperation({ summary: '可选的出款渠道（下拉）' })
  listPayoutChannels() {
    return this.payoutProviders.list().map((descriptor) => ({
      channel: descriptor.channel,
      provider: descriptor.provider,
    }));
  }

  /** 取当前操作人（平台超管的用户 id），用于写 `updatedBy` 留痕 */
  private currentOperatorId(): string {
    const context = getTenantContext();
    if (!context.userId) {
      throw new BadRequestException('缺少用户上下文');
    }
    return context.userId;
  }
}
