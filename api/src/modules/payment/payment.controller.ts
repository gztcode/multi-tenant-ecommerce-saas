import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundOrderDto } from './dto/refund-order.dto';

/**
 * 支付接口（消费者侧发起支付 + 商家侧退款）。
 *
 * ⚠️ **两个端点都归 payment 模块**：它们要用 `createPayment` / `refund`，
 * 而 order 模块**不**依赖 payment 模块（依赖方向单向：`payment → order`）。
 * 把退款端点放进 order 模块会形成循环依赖。
 */
@ApiTags('payments')
@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * 发起支付。
   *
   * ⚠️ **金额只从订单读**，请求体不接受任何金额字段。
   *
   * ⚠️ **挂 JwtAuthGuard（必须登录）**：订单是「我的订单」这类归属自己的资源，
   * 订单号不是秘密（它出现在支付回调、商家后台的搜索框里）。
   */
  @Post('orders/:orderNo/pay')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '发起支付（建支付单，返回支付页面 URL）' })
  async pay(
    @Param('orderNo') orderNo: string,
    @Body() dto: CreatePaymentDto,
    @Req() request: Request,
  ) {
    const customerId = this.requireCustomerId(request);
    const channel = dto.channel ?? this.defaultChannel();
    return this.paymentService.createPayment(orderNo, channel, customerId);
  }

  /**
   * 整单退款。
   *
   * ⚠️ **退款不回补库存**——货已经发出去了，退的是钱不是库存。
   * 「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
   * 这个取舍要在商家后台的文案里说明。
   *
   * ⚠️ **商家侧路径带 `merchant/` 前缀**：两侧鉴权方式不同，
   * 同一路径挂两套守卫时后注册的那套会被完全遮住（见 order 模块的注释）。
   */
  @Post('merchant/orders/:orderNo/refund')
  @Roles(UserRole.MERCHANT_OWNER)
  @ApiOperation({ summary: '整单退款（不回补库存）' })
  async refund(@Param('orderNo') orderNo: string, @Body() dto: RefundOrderDto) {
    await this.paymentService.refund(orderNo, dto.reason ?? '商家发起退款');
    return { refunded: true };
  }

  /**
   * 当前登录消费者 id。
   *
   * ⚠️ 守卫已经保证登录过了，这里仍做一次校验：守卫是入口层的约定，
   * 缺了 user 时静默返回 null 会让下游的归属过滤整个失效。
   */
  private requireCustomerId(request: Request): string {
    const user = (request as Request & { user?: { userId: string } }).user;
    if (!user?.userId) {
      throw new UnauthorizedException('支付操作需要登录');
    }
    return user.userId;
  }

  /** 默认渠道 */
  private defaultChannel(): string {
    const channels = this.paymentService.listChannels();
    const first = channels[0];
    if (!first) {
      throw new ServiceUnavailableException('没有可用的支付渠道');
    }
    return first;
  }
}
