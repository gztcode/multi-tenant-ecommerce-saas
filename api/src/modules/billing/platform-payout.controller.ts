import {
  BadRequestException,
  Body,
  Controller,
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
import { PayoutDecisionDto } from './dto/payout-decision.dto';
import { PayoutListQueryDto } from './dto/payout-list-query.dto';
import { PayoutManualActionDto } from './dto/payout-manual-action.dto';

/**
 * 平台侧的出款审批接口。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：审批出款 = 决定把哪笔钱打给谁，
 * 商家账号调这些接口要 403（护栏 P10）。
 *
 * ⚠️ **不用再加 `@UseGuards(JwtAuthGuard)`**：`@Roles` 装饰器**自带**
 * `JwtAuthGuard`（未登录得 401）—— 5g 的 `platform-settlement.controller.ts`
 * 就是这么写的，别多挂一层。
 */
@ApiTags('platform-payouts')
@Controller('platform')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Get('payouts')
  @ApiOperation({ summary: '出款单列表（跨商家）' })
  async list(@Query() query: PayoutListQueryDto) {
    // ⚠️ **`page` / `pageSize` 直接传，不用 `toIntOr`**：
    //    `PayoutListQueryDto` 上有 `@Type(() => Number)`，它们**已经是 number**
    //    （`toIntOr` 的签名是 `(value: string | undefined, ...)`，
    //    传 number 会类型报错）。缺省交给服务层的 `clampPagination` 处理。
    return this.payouts.listForPlatform({
      status: query.status,
      period: query.period,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: '出款单详情' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.detailForPlatform(id);
  }

  @Post('payouts/:id/approve')
  // ⚠️ **显式返回 200**：审批是**状态变更**，不是「创建了一个资源」。
  //    201 会被读成「新建成功」，而实际上只是把一张单据的状态改了。
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '审批通过（重算并锁定金额）' })
  async approve(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.approve(id);
  }

  @Post('payouts/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '审批拒绝（必须给原因）' })
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PayoutDecisionDto,
  ) {
    // ⚠️ **原因必填由服务层把关**：DTO 里 `reason` 是可选的
    //    （通过时不需要填），服务层 `reject` 会对空原因抛 400。
    return this.payouts.reject(id, dto.reason ?? '');
  }

  @Post('payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '人工重试（仅限「确定没打钱」的失败单）',
    description:
      '把一张失败的出款单重新放回打款队列。只允许钱确定没打出去的失败单' +
      '（收款账户不可用 / 打款前的校验没过）；钱可能已经打出去的单必须先核对渠道。',
  })
  async retry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PayoutManualActionDto,
  ) {
    return this.payouts.retry(id, dto.reason);
  }

  @Post('payouts/:id/unstick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '解除卡单（卡在「打款中」的单）',
    description:
      '把一张卡在 PROCESSING 的出款单转成失败（认定没打出去，结束这件事）' +
      '或转回已审批（重新打款 —— ⚠️ 可能重复打款，必须先核对渠道）。',
  })
  async unstick(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PayoutManualActionDto,
  ) {
    // ⚠️ **`to` 必填** —— 「转失败」与「重新打款」的后果完全不同，
    //    不能有默认值（默认「转失败」的话，运营漏传就会静默走错方向）
    if (!dto.to) {
      throw new BadRequestException('必须指定目标状态（FAILED 或 APPROVED）');
    }
    return this.payouts.unstick(id, { to: dto.to, reason: dto.reason });
  }
}
