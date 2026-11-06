import { UserRole } from '@prisma/client';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { InventoryService } from './inventory.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { InventoryMovementsQueryDto } from './dto/inventory-movements-query.dto';

@ApiTags('inventory')
@Controller('inventory')
@UseGuards(JwtAuthGuard)
// ⚠️ 商家管理端必须挂角色（审计 P1-1）：库存流水还含店主账号标识，
// 消费者令牌曾经能直接读（对抗验证实测）。
@Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('adjustments')
  @ApiOperation({ summary: '库存调整（入库 / 出库 / 盘点）' })
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: CurrentUserPayload) {
    return this.inventoryService.adjust(dto, user.userId);
  }

  @Get('movements')
  @ApiOperation({ summary: '库存流水列表' })
  // ⚠️ 查询参数走 DTO（而不是裸 `@Query`）：裸参数拿不到校验，
  // `page=abc` 会变成 NaN 传给 Prisma，直接 500（审计 P2-5）。
  movements(@Query() query: InventoryMovementsQueryDto) {
    return this.inventoryService.movements({
      skuId: query.skuId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('summary')
  @ApiOperation({ summary: '库存汇总' })
  @ApiQuery({ name: 'productId', required: true, type: String })
  summary(@Query('productId') productId: string) {
    return this.inventoryService.summary(productId);
  }
}
