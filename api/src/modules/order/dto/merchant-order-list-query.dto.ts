import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { OrderStatus } from '@prisma/client';

import { MAX_PAGE_SIZE } from '../../../common/http/pagination';

/**
 * 商家订单列表的查询参数。
 *
 * ⚠️ **这里必须是 DTO，不能用裸 `@Query`**：裸 `@Query('from')` 拿到的是字符串，
 * `new Date('乱码')` = Invalid Date，传给 Prisma 就是 500（审计 P2-5）。
 * 走 DTO 之后由 ValidationPipe 校验，畸形入参一律 400。
 */
export class MerchantOrderListQueryDto {
  @ApiPropertyOptional({
    description: '按状态筛选。缺省 = 全部状态',
    enum: [
      'PENDING_PAYMENT',
      'PAID',
      'SHIPPED',
      'COMPLETED',
      'CANCELLED',
      'REFUNDED',
      'CLOSED',
    ],
  })
  @IsOptional()
  // ⚠️ 枚举必须校验：Prisma 遇到非法枚举值是**抛错**（500），
  // 不是查不到就返回空列表。
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({
    description: '按创建时间筛选（下界，ISO 8601）',
    type: String,
    format: 'date-time',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  // ⚠️ **用 `@Type(() => Date)` + `@IsDate()`，不用 `@IsDateString()`**：
  // `@IsDateString()` 只查「像不像 ISO 8601」，`20260101`、`2026-W01-1`
  // 都能过，但 `new Date()` 解析它们是 Invalid Date —— 500 的口子没堵上。
  // 先转成 Date 再查「是不是有效日期」，非法值一律 400。
  @Type(() => Date)
  @IsDate({
    message:
      'from 必须是合法的日期时间（ISO 8601，如 2026-01-01T00:00:00.000Z）',
  })
  from?: Date;

  @ApiPropertyOptional({
    description: '按创建时间筛选（上界，ISO 8601）',
    type: String,
    format: 'date-time',
    example: '2026-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({
    message: 'to 必须是合法的日期时间（ISO 8601，如 2026-12-31T23:59:59.999Z）',
  })
  to?: Date;

  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（上限 100）', example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}
