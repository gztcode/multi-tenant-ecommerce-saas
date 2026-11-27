import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { PlanService } from './plan.service';
import { SubscriptionService } from './subscription.service';
import { InvoiceService } from './invoice.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { InvoiceListQueryDto } from './dto/invoice-list-query.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';

/**
 * 商家侧的计费接口。
 *
 * ⚠️ **订阅请求体只接受 `planId`**（护栏 M1 / M2 / M9）。
 */
@ApiTags('billing')
@Controller('billing')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)
export class BillingController {
  constructor(
    private readonly plans: PlanService,
    private readonly subscriptions: SubscriptionService,
    private readonly invoices: InvoiceService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: '可订阅的套餐列表' })
  async listPlans() {
    return this.plans.listActive();
  }

  @Get('subscription')
  @ApiOperation({ summary: '当前订阅' })
  async currentSubscription() {
    return this.subscriptions.current(this.subscriptions.currentTenantId());
  }

  @Get('invoices')
  @ApiOperation({ summary: '本店的账单列表（可按状态筛选）' })
  async listInvoices(@Query() query: InvoiceListQueryDto) {
    return this.invoices.list(
      this.subscriptions.currentTenantId(),
      query.status,
    );
  }

  /**
   * 作废账单（**保留记录**：状态置 `VOID`，不删行）。
   *
   * ⚠️ **路径用账单号而不是 id**：与同资源下的支付路由
   * （`POST billing/invoices/:number/pay`，在 payment 模块）保持同一标识；
   * 账单号本来就是对外凭证，商家页面上看到的就是它。
   *
   * ⚠️ **作废人取自登录态**，客户端只能传原因。
   */
  @Post('invoices/:number/void')
  @ApiOperation({ summary: '作废账单（保留记录）' })
  voidInvoice(
    @Param('number') number: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.invoices.voidInvoice({
      tenantId: this.subscriptions.currentTenantId(),
      number,
      voidedBy: user.userId,
      reason: dto.reason,
    });
  }

  @Post('subscription')
  @ApiOperation({ summary: '订阅一个套餐' })
  subscribe(@Body() dto: SubscribeDto) {
    return this.subscriptions.subscribe(dto.planId);
  }

  /**
   * 换套餐（**下个周期生效**）。
   *
   * ⚠️ **用 PATCH 而不是新增路径**：`subscription` 这一个资源，
   * `POST` 是开通、`PATCH` 是换套餐。
   *
   * ⚠️ **别把 `subscribe()` 的幂等语义改掉**（护栏 M4）：重复开通要返回
   * 旧订阅而不是插两行。「换套餐」是另一件事，走这里。
   */
  @Patch('subscription')
  @ApiOperation({ summary: '换套餐（下个周期生效）' })
  changePlan(@Body() dto: SubscribeDto) {
    return this.subscriptions.changePlan(dto.planId);
  }
}
