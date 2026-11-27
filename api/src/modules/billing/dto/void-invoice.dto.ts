import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 作废账单。
 *
 * ⚠️ **只接受作废原因**：作废人取自登录态（`CurrentUser`），
 * 作废时刻取自数据库时钟 —— 都不许客户端传。
 */
export class VoidInvoiceDto {
  @ApiProperty({
    description: '作废原因（可选，最多 200 字）',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
