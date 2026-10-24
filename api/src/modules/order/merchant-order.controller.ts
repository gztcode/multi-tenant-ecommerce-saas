import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrderStatus, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { toIntOr } from '../../common/http/pagination';
import { OrderService } from './order.service';
import { ShipOrderDto } from './dto/ship-order.dto';

/**
 * 商家侧的订单接口。
 *
 * ⚠️ **与消费者侧分成两个 controller**：两者的鉴权方式根本不同。
 * 这里整组挂 `JwtAuthGuard` + `@Roles(UserRole.MERCHANT_OWNER)`——
 * 订单是商家的经营数据，游客与普通消费者都不能看。
 *
 * 混在一个 controller 里就得逐个方法换守卫，漏一个就是越权。
 *
 * ⚠️ **路径是 `merchant/orders` 而不是 `orders`**：
 * 设计 §10.1 与 §10.2 都写了 `/api/v1/orders`，但两者是**不同的路由**——
 * 消费者侧要游客/消费者能进，商家侧要店主才能进。
 * 同一条路径上挂两套守卫，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**（商家会拿到消费者的响应，
 * 而 `OptionalJwtAuthGuard` 对商家令牌直接 403）。
 *
 * 所以这里按项目既有的「管理端接口带域名前缀」的约定
 * （对照 `catalog/products`、`inventory`）拆成 `merchant/orders`。
 *
 * ⚠️ **发货端点归 order 模块**：它不涉及支付能力，只是订单状态流转。
 * 退款端点归 payment 模块（它要用 `provider.refund()`）——
 * 模块依赖方向是单向的 `payment → order`。
 */
@ApiTags('merchant-orders')
@Controller('merchant/orders')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantOrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  @ApiOperation({ summary: '订单列表（按状态 / 时间筛选）' })
  async list(
    @Query('status') status?: OrderStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.orderService.listMerchantOrders({
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      page: toIntOr(page, undefined),
      pageSize: toIntOr(pageSize, undefined),
    });
  }

  @Get(':orderNo')
  @ApiOperation({ summary: '订单详情' })
  async detail(@Param('orderNo') orderNo: string) {
    return this.orderService.readOrderByNo(orderNo);
  }

  @Post(':orderNo/ship')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '发货（填快递单号）' })
  async ship(@Param('orderNo') orderNo: string, @Body() dto: ShipOrderDto) {
    await this.orderService.shipOrder(orderNo, dto.trackingNo);
    return this.orderService.readOrderByNo(orderNo);
  }
}
