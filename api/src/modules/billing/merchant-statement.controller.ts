import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { Roles } from '../../common/decorators/roles.decorator';
import { MerchantStatementService } from './merchant-statement.service';

/**
 * 商家侧的对账单接口。
 *
 * ⚠️ **只有 `MERCHANT_OWNER` 能看**：对账单是**账目**（货款、佣金、应结），
 *    员工看得到就等于能拿公司的经营数据。
 *
 * ⚠️ **不单独挂 `@UseGuards(JwtAuthGuard)`**：`@Roles` 装饰器内部
 *    已经用 `UseGuards(JwtAuthGuard, RolesGuard)` 把认证与鉴权绑在同一次
 *    UseGuards 里（见 `common/decorators/roles.decorator.ts`），
 *    这里再挂一次是重复注册。
 *
 * ⚠️ **路由顺序**：NestJS 按注册顺序匹配 →
 *    静态路径要声明在 `:period` 之前。
 *    这里两条路由是 `/merchant/statements` 与 `/merchant/statements/:period`，
 *    **互不冲突**（`:period` 要的是 `YYYY-MM`，不可能撞上列表路径）。
 */
@ApiTags('merchant-statements')
@Controller('merchant/statements')
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantStatementController {
  constructor(private readonly statements: MerchantStatementService) {}

  @Get()
  @ApiOperation({ summary: '我的对账单列表（每一期的货款、佣金与应结）' })
  async list() {
    return this.statements.list();
  }

  @Get(':period')
  @ApiOperation({ summary: '某一期的对账单详情（含抽佣与货款明细）' })
  async detail(@Param('period') period: string) {
    return this.statements.detail(period);
  }
}
