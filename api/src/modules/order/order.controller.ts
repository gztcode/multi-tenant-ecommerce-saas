import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { OrderStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toIntOr } from '../../common/http/pagination';
import { OrderService } from './order.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { CART_COOKIE } from '../cart/cart.service';

/**
 * 消费者侧的订单接口。
 *
 * ⚠️ **挂 JwtAuthGuard（必须登录），不是 OptionalJwtAuthGuard。**
 *
 * 订单是「我的订单」这类**归属自己的资源**，匿名请求没有「我的订单」可言。
 * 更要紧的是：订单号**不是秘密**——它出现在支付回调、商家后台的搜索框、
 * 日志里。若允许游客按订单号读详情，服务层 `where` 里的归属条件就会退化成
 * 「本租户的任意订单」，匿名请求能读到别人的姓名、手机号、详细地址，
 * 甚至把别人的订单取消掉。
 *
 * 本阶段因此**不支持游客下单**（设计 §十三 遗留项 8 的取舍之一：
 * 「本阶段就要求游客下单前登录」）。购物车仍然支持游客——
 * 那是 `cart` 模块的事，与订单不同。
 *
 * ⚠️ **为什么与商家侧分成两个 controller**：两者的鉴权方式不同。
 * 消费者侧是「必须登录」，商家侧是「必须登录且是店主」。
 * 混在一个 controller 里就得逐个方法换守卫，容易漏掉某个方法。
 */
@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @ApiOperation({ summary: '下单（预占库存）' })
  async place(@Body() dto: PlaceOrderDto, @Req() request: Request) {
    const customerId = this.currentCustomerId(request);
    const guestToken = this.readGuestToken(request);
    return this.orderService.placeOrder(customerId, dto, guestToken);
  }

  @Get()
  @ApiOperation({ summary: '我的订单列表' })
  async list(
    @Req() request: Request,
    @Query('status') status?: OrderStatus,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.orderService.listConsumerOrders(
      this.currentCustomerId(request),
      {
        status,
        page: toIntOr(page, undefined),
        pageSize: toIntOr(pageSize, undefined),
      },
    );
  }

  @Get(':orderNo')
  @ApiOperation({ summary: '订单详情' })
  async detail(@Param('orderNo') orderNo: string, @Req() request: Request) {
    // ⚠️ 必须校验归属：不然换个消费者拿订单号就能看别人的订单
    // （订单号会出现在支付回调、商家后台的搜索框里，不是秘密）。
    return this.orderService.readConsumerOrder(
      orderNo,
      this.currentCustomerId(request),
    );
  }

  @Post(':orderNo/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '取消订单' })
  async cancel(@Param('orderNo') orderNo: string, @Req() request: Request) {
    await this.orderService.cancelOrder(
      orderNo,
      this.currentCustomerId(request),
    );
    return this.orderService.readOrderByNo(orderNo);
  }

  @Post(':orderNo/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '确认收货' })
  async confirm(@Param('orderNo') orderNo: string, @Req() request: Request) {
    await this.orderService.confirmReceipt(
      orderNo,
      this.currentCustomerId(request),
    );
    return this.orderService.readOrderByNo(orderNo);
  }

  /**
   * 当前登录消费者 id。
   *
   * ⚠️ 守卫已经保证登录过了，这里仍做一次校验：守卫是入口层的约定，
   * 缺了 user 时静默返回 null 会让下游的归属过滤整个失效
   * （`where: { orderNo, customerId: null }` 匹配不到任何行，
   * 或者更糟——被写成「不带 customerId 条件」）。
   */
  private currentCustomerId(request: Request): string {
    const user = (request as Request & { user?: { userId: string } }).user;
    if (!user?.userId) {
      throw new UnauthorizedException('订单操作需要登录');
    }
    return user.userId;
  }

  /**
   * 读 cookie 里的游客 token。
   *
   * 游客下单时要靠它定位游客购物车（下单后清掉已下单的条目）。
   */
  private readGuestToken(request: Request): string | null {
    const raw = (request as { cookies?: unknown }).cookies;
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const token = (raw as Record<string, unknown>)[CART_COOKIE];
    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}
