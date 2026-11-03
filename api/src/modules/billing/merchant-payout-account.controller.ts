import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import { PayoutAccountService } from './payout-account.service';
import { SetPayoutAccountDto } from './dto/set-payout-account.dto';

/**
 * 商家侧的收款账户接口。
 *
 * ⚠️ **只有 `MERCHANT_OWNER` 能改**：收款账户是钱的去向，
 * 员工改了等于把公司账户改了。
 *
 * ⚠️ **不再单独挂 `@UseGuards(JwtAuthGuard)`**：`@Roles` 装饰器内部
 * 已经用 `UseGuards(JwtAuthGuard, RolesGuard)` 把认证与鉴权绑在**同一次**
 * UseGuards 里（见 `common/decorators/roles.decorator.ts` 的注释），
 * 这里再挂一次是重复注册。
 *
 * ⚠️ **控制器前缀是 `merchant` 而不是 `merchant/payout-account`**（阶段 6a）：
 *    渠道列表要挂在 `/merchant/payout-channels`（与账户同级），
 *    用 `merchant/payout-account` 当前缀会变成
 *    `/merchant/payout-account/payout-channels`。两条路径都在这里显式写全。
 */
@ApiTags('merchant-payout-account')
@Controller('merchant')
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantPayoutAccountController {
  constructor(
    private readonly accounts: PayoutAccountService,
    private readonly payoutProviders: PayoutProviderRegistry,
  ) {}

  @Get('payout-account')
  @ApiOperation({ summary: '当前商家的收款账户' })
  async get() {
    return this.accounts.get();
  }

  /**
   * 商家可选的出款渠道（账户页下拉用，阶段 6a Task 5）。
   *
   * ⚠️ **方法级 `@Roles` 覆盖类级的 `MERCHANT_OWNER`**：员工能看账户页，
   *    也应该能看出「钱会走哪家渠道」；**改**渠道仍只允许店主（方法级
   *    规则里也只放 `MERCHANT_OWNER`，见下面的 `set`）。
   * ⚠️ **用注册表的 `list()`**：它默认过滤 `devOnly`，生产环境永远看不到 sandbox。
   */
  @Get('payout-channels')
  @Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
  @ApiOperation({ summary: '商家可选的出款渠道（下拉）' })
  listPayoutChannels() {
    return {
      channels: this.payoutProviders.list().map((descriptor) => ({
        channel: descriptor.channel,
        provider: descriptor.provider,
      })),
    };
  }

  /**
   * ⚠️ **显式重挂 `@Roles(MERCHANT_OWNER)`**：本类与 `payout-channels` 同前缀，
   *    两个方法分别声明角色，避免「读渠道列表放开了员工，写账户却跟着放开」。
   */
  @Put('payout-account')
  @Roles(UserRole.MERCHANT_OWNER)
  @ApiOperation({ summary: '设置当前商家的收款账户（有则更新）' })
  async set(@Body() dto: SetPayoutAccountDto) {
    return this.accounts.set({
      accountName: dto.accountName.trim(),
      bankName: dto.bankName.trim(),
      // ⚠️ **账号可空**（更新时留空 = 不修改这一项），
      //    空值不要传成空串 —— 空串会把账号**清成空**。
      accountNo: dto.accountNo?.trim(),
      // ⚠️ **默认渠道三态**：`undefined` = 不修改；`''` = 清除；
      //    有值 = 设置。`?.trim()` 会保留空串（与 `accountNo` 的 `?.` 同款），
      //    service 层按「键在不在」区分，不要在这里把 `''` 变成 `undefined`。
      preferredChannel: dto.preferredChannel?.trim(),
    });
  }
}
