import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { PayoutService } from './payout.service';
import { ApplyPayoutDto } from './dto/apply-payout.dto';
import { PayoutListQueryDto } from './dto/payout-list-query.dto';

/**
 * 商家侧的出款接口。
 *
 * ⚠️ **只有 `MERCHANT_OWNER` 能申请/撤回**：出款是打钱，
 * 员工点了不该能把公司的钱打出去（护栏 P10）。
 *
 * ⚠️ **不单独挂 `@UseGuards(JwtAuthGuard)`**：`@Roles` 装饰器内部
 * 已经用 `UseGuards(JwtAuthGuard, RolesGuard)` 把认证与鉴权绑在同一次
 * UseGuards 里（见 `common/decorators/roles.decorator.ts`），
 * 这里再挂一次是重复注册。
 *
 * ⚠️ **路由顺序**：NestJS 按注册顺序匹配 →
 * `available-periods` 这条**静态路径必须声明在 `:id` 之前**，
 * 否则会被 `:id` 吃掉（`ParseUUIDPipe` 收到 "available-periods" → 400）。
 */
@ApiTags('merchant-payouts')
@Controller('merchant/payouts')
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Get('available-periods')
  @ApiOperation({ summary: '可申请的周期与各自的应结金额' })
  async availablePeriods() {
    return this.payouts.availablePeriods();
  }

  @Get()
  @ApiOperation({ summary: '我的出款单列表' })
  async list(@Query() query: PayoutListQueryDto) {
    // ⚠️ **`page` / `pageSize` 直接传，不用 `toIntOr`**：
    //    `PayoutListQueryDto` 上有 `@Type(() => Number)`，它们**已经是 number**
    //    （`toIntOr` 的签名是 `(value: string | undefined, ...)`，
    //    传 number 会类型报错）。缺省交给服务层的 `clampPagination` 处理。
    return this.payouts.listForTenant({
      status: query.status,
      period: query.period,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: '出款单详情' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.detailForTenant(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '申请出款（指定自然月）' })
  async apply(@Body() dto: ApplyPayoutDto) {
    return this.payouts.apply({ period: dto.period });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '撤回申请（仅待审批可撤）' })
  async cancel(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.cancel(id);
  }
}
