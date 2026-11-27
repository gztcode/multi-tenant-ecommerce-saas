import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { InvoiceStatus } from '@prisma/client';

/**
 * 账单列表的筛选条件。
 *
 * ⚠️ **`status` 不传就维持原行为**（最近 50 张，不分状态）：
 * 列表接口是既有页面的数据源，加筛选不能改变默认返回。
 */
export class InvoiceListQueryDto {
  @ApiProperty({ description: '按账单状态筛选', required: false })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;
}
