import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReportService } from './report.service';
import { ReportQueryDto } from './dto/report-query.dto';

/**
 * 平台超管的订阅列表与收入报表。
 *
 * ⚠️ **路径带 `platform/` 前缀** —— 与阶段 5b 的 `platform/plans`
 * （`PlatformBillingController`）同款理由：消费者侧与平台侧的鉴权方式
 * 根本不同，同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：商家账号调这些接口要 403（护栏 M17）。
 * `@Roles` 装饰器自带 `JwtAuthGuard`，未登录得 401。
 */
@ApiTags('platform-billing')
@Controller('platform')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformReportController {
  constructor(private readonly reports: ReportService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: '跨租户的订阅列表' })
  async subscriptions() {
    return this.reports.listSubscriptions();
  }

  /**
   * 平台收入报表。
   *
   * ⚠️ **区间缺省是「最近 30 天」**：判定放在 service 层（用数据库的时钟），
   * DTO 只负责解析 —— 这样默认窗口与显式传入的窗口用同一个时钟来源。
   */
  @Get('reports')
  @ApiOperation({ summary: '平台收入报表（缺省最近 30 天）' })
  async report(@Query() query: ReportQueryDto) {
    // ⚠️ **DTO 的 `@IsDateString()` 已经挡掉了非法格式**（全局 ValidationPipe
    // 开了 whitelist + forbidNonWhitelisted + transform），
    // 所以这里拿到的都是合法的 ISO 字符串 —— `new Date()` 不会得到 Invalid Date。
    return this.reports.summary({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }
}
