import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
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
 */
@ApiTags('merchant-payout-account')
@Controller('merchant/payout-account')
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantPayoutAccountController {
  constructor(private readonly accounts: PayoutAccountService) {}

  @Get()
  @ApiOperation({ summary: '当前商家的收款账户' })
  async get() {
    return this.accounts.get();
  }

  @Put()
  @ApiOperation({ summary: '设置当前商家的收款账户（有则更新）' })
  async set(@Body() dto: SetPayoutAccountDto) {
    return this.accounts.set({
      accountName: dto.accountName.trim(),
      bankName: dto.bankName.trim(),
      // ⚠️ **账号可空**（更新时留空 = 不修改这一项），
      //    空值不要传成空串 —— 空串会把账号**清成空**。
      accountNo: dto.accountNo?.trim(),
    });
  }
}
