import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { SettlementStatus } from '@prisma/client';

/**
 * 结算单列表的查询参数。
 *
 * ⚠️ **`page` / `pageSize` 用 `@Type(() => Number)` 转一下**：
 * query 参数全是字符串，不转的话 `@IsInt()` 永远不通过。
 */
export class SettlementListQueryDto {
  @ApiPropertyOptional({
    description: '结算周期（自然月，UTC）。缺省 = 全部周期',
    example: '2026-10',
  })
  @IsOptional()
  @Matches(/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/, {
    message:
      '周期格式非法：必须是 YYYY-MM，年份在 1000 到 9998 之间（如 2026-10）',
  })
  period?: string;

  @ApiPropertyOptional({
    description: '按状态筛选。缺省 = 全部状态',
    enum: ['DRAFT', 'CONFIRMED', 'PAID'],
  })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;

  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
