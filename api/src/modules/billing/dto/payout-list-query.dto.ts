import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PayoutStatus } from '@prisma/client';

export class PayoutListQueryDto {
  @ApiProperty({ description: '按状态筛选', required: false })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @ApiProperty({ description: '按周期筛选（YYYY-MM）', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/, {
    message: '周期格式非法：必须是 YYYY-MM，年份在 1000 到 9998 之间',
  })
  period?: string;

  // ⚠️ **`page` / `pageSize` 用 `@Type(() => Number)` 转一下**：
  // query 参数全是字符串，不转的话 `@IsInt()` 永远不通过，
  // 而且服务层收的是 number（`clampPagination`）。
  // （与 5g 的 `SettlementListQueryDto` 同款。）
  @ApiProperty({ description: '页码（从 1 开始）', required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ description: '每页条数', required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // ⚠️ **上限要与 `common/http/pagination.ts` 的 `MAX_PAGE_SIZE` 一致**：
  //    服务层用 `clampPagination` 夹取，写大了也只会静默夹到 100 ——
  //    声明 200 而实际给 100，页面上的「本页已显示全部」就是骗人的。
  @Max(100)
  pageSize?: number;
}
