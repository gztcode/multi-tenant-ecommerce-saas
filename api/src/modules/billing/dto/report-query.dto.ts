import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/**
 * 平台报表的查询参数。
 *
 * ⚠️ **两个都可选**：缺省 = 「最近 30 天」。
 *
 * ⚠️ **刻意不在 DTO 里放默认值**：默认窗口要用**数据库的时钟**算
 * （护栏 M15 —— 多副本部署时各机器的时钟有偏差，边界时刻会摇摆），
 * 而 DTO 是在请求解析阶段构造的，那时拿不到数据库时钟。
 * 所以「缺省最近 30 天」的判定放在 service 层，
 * 让默认窗口与显式传入的窗口用**同一个时钟来源**。
 *
 * ⚠️ **区间是左闭右开 `[from, to)`**：同一笔订单在相邻两期里
 * 不会被重复计入，也不会漏计。
 */
export class ReportQueryDto {
  @ApiPropertyOptional({
    description: '区间起点（ISO 日期时间）。缺省 = 最近 30 天的起点',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: '区间终点（ISO 日期时间，不含）。缺省 = 现在',
    example: '2026-02-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}
