import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaymentService } from './payment.service';
import { PaymentMethodService } from './payment-method.service';
import { PayInvoiceDto } from './dto/pay-invoice.dto';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';

/**
 * 商家侧的订阅付款与支付方式。
 *
 * ⚠️ **控制器归 `payment` 模块**，不归 `billing` 模块 ——
 * 它要调渠道（`PaymentService.createInvoicePayment`）。`billing` 一旦
 * 依赖 `payment` 就与 `order → billing` 构成**模块依赖的环**
 * （`order → billing → payment → order`），NestJS 启动直接报错。
 *
 * ⚠️ **路径是 `billing/...` 而控制器住在 payment 模块**：
 * 这些接口在商家后台的「订阅」页里，与 `billing/plans`、
 * `billing/subscription` 是同一组页面。与 `billing` 模块里那个
 * `@Controller('billing')` 不冲突 —— 完整路径各不相同。
 *
 * ⚠️ **商家侧路径挂 `JwtAuthGuard` + `@Roles`**：绑支付方式、
 * 付账单都是「这个店铺」的操作，不是「这个消费者」的操作。
 */
@ApiTags('billing-payments')
@Controller('billing')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
export class SubscriptionPaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentMethods: PaymentMethodService,
  ) {}

  /**
   * 本店的支付方式列表。
   *
   * ⚠️ **响应里没有 `token`** —— 那是渠道给的扣款凭证，
   * 只能在服务端用（自动续费），不能发到浏览器。
   */
  @Get('payment-methods')
  @ApiOperation({ summary: '本店的支付方式' })
  async listPaymentMethods() {
    const tenantId = this.paymentService.currentTenantId();
    return this.paymentMethods.list(tenantId);
  }

  /**
   * 手动续费：建订阅账单的支付单并调渠道（跳页面付款）。
   *
   * ⚠️ **金额只从账单读**，请求体不接受任何金额字段。
   */
  @Post('invoices/:number/pay')
  @ApiOperation({ summary: '手动续费（建订阅支付单，返回支付页面 URL）' })
  async payInvoice(
    @Param('number') number: string,
    @Body() dto: PayInvoiceDto,
  ) {
    const channel = dto.channel ?? this.defaultChannel();
    return this.paymentService.createInvoicePayment(number, channel);
  }

  /**
   * 绑定支付方式（自动续费的前提）。
   *
   * ⚠️ **token 由渠道给**：请求体不接受 `token`。
   */
  @Post('payment-methods')
  @ApiOperation({ summary: '绑定支付方式' })
  async createPaymentMethod(@Body() dto: CreatePaymentMethodDto) {
    const tenantId = this.paymentService.currentTenantId();
    return this.paymentMethods.create(tenantId, dto.type, dto.channel);
  }

  /** 解绑支付方式 */
  @Delete('payment-methods/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '解绑支付方式' })
  async removePaymentMethod(@Param('id') id: string) {
    const tenantId = this.paymentService.currentTenantId();
    await this.paymentMethods.remove(tenantId, id);
    return { removed: true };
  }

  /** 设为默认支付方式（默认的只有一个） */
  @Post('payment-methods/:id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '设为默认支付方式' })
  async setDefaultPaymentMethod(@Param('id') id: string) {
    const tenantId = this.paymentService.currentTenantId();
    await this.paymentMethods.setDefault(tenantId, id);
    return { updated: true };
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
