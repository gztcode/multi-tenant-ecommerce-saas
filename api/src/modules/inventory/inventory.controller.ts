import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { InventoryService } from './inventory.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@ApiTags('inventory')
@Controller('inventory')
@UseGuards(JwtAuthGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('adjustments')
  @ApiOperation({ summary: '库存调整（入库 / 出库 / 盘点）' })
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: CurrentUserPayload) {
    return this.inventoryService.adjust(dto, user.userId);
  }

  @Get('movements')
  @ApiOperation({ summary: '库存流水列表' })
  @ApiQuery({ name: 'skuId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  movements(
    @Query('skuId') skuId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.inventoryService.movements({
      skuId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('summary')
  @ApiOperation({ summary: '库存汇总' })
  @ApiQuery({ name: 'productId', required: true, type: String })
  summary(@Query('productId') productId: string) {
    return this.inventoryService.summary(productId);
  }
}
