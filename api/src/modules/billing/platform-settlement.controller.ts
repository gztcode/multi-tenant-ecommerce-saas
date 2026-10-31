import {
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
import { toIntOr } from '../../common/http/pagination';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { SettlementListQueryDto } from './dto/settlement-list-query.dto';
import { SettlementService } from './settlement.service';

/**
 * 平台超管的结算单。
 *
 * ⚠️ **路径带 `platform/` 前缀** —— 与 `PlatformReportController`、
 * `PlatformBillingController` 同款理由：消费者侧与平台侧的鉴权方式
 * 根本不同，同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：商家账号调这些接口要 403（护栏 S8）。
 * `@Roles` 装饰器自带 `JwtAuthGuard`，未登录得 401。
 */
@ApiTags('platform-settlement')
@Controller('platform')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformSettlementController {
  constructor(private readonly settlements: SettlementService) {}

  @Get('settlements')
  @ApiOperation({ summary: '结算单列表' })
  async list(@Query() query: SettlementListQueryDto) {
    return this.settlements.list({
      period: query.period,
      status: query.status,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Post('settlements')
  // ⚠️ **显式返回 200，而不是 `@Post` 的默认 201**：
  //    这个端点返回的是**一次批量操作的结果**（可能新建了 0 张、
  //    复用了 3 张、还可能有商家冲突），不是「一个被创建的资源」。
  //    201 会被读成「资源创建成功」，而实际上冲突的商家**没有出单** ——
  //    失败信息在 `conflicts` 里，状态码必须让调用方知道「有单生成了」。
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '生成结算单（缺省 = 该期所有有流水的商家）' })
  async generate(@Body() body: CreateSettlementDto) {
    return this.settlements.generate({
      period: body.period,
      tenantId: body.tenantId,
    });
  }

  @Get('settlements/:id')
  @ApiOperation({ summary: '结算单详情（含明细）' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.detail(id);
  }

  @Get('settlements/:id/entries')
  @ApiOperation({ summary: '结算单明细（分页）' })
  // ⚠️ **`page` / `pageSize` 用 `toIntOr` 转一下**：这里没有 DTO，
  //    `@Query('page')` 拿到的是裸字符串（`PayoutListQueryDto` 那套
  //    `@Type(() => Number)` 用不上），不转的话服务层会拿到 NaN。
  async entries(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.settlements.listEntries(id, {
      page: toIntOr(page, undefined),
      pageSize: toIntOr(pageSize, undefined),
    });
  }

  @Post('settlements/:id/confirm')
  @ApiOperation({ summary: '确认结算单（DRAFT → CONFIRMED，幂等）' })
  async confirm(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.confirm(id);
  }

  @Post('settlements/:id/unconfirm')
  @ApiOperation({ summary: '取消确认（CONFIRMED → DRAFT）' })
  async unconfirm(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.unconfirm(id);
  }

  @Post('settlements/:id/recalculate')
  @ApiOperation({ summary: '重算结算单（仅 DRAFT）' })
  async recalculate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.settlements.recalculate(id);
  }
}
