import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * 生成结算单的请求体。
 *
 * ⚠️ **请求体里没有任何金额字段**：结算单的金额**只从流水算**，
 * 客户端传什么都不作数（全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，
 * 多传的键直接 400）。
 *
 * ⚠️ **`period` 是 `YYYY-MM` 而不是 `from` / `to`**：
 * 月边界只由后端算一次，前端不需要知道月末是 30 号还是 31 号。
 */
export class CreateSettlementDto {
  @ApiProperty({
    description: '结算周期（自然月，UTC）。必须是 YYYY-MM',
    example: '2026-10',
  })
  @Matches(/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/, {
    message:
      '周期格式非法：必须是 YYYY-MM，年份在 1000 到 9998 之间（如 2026-10）',
  })
  period!: string;

  @ApiPropertyOptional({
    description: '指定商家。缺省 = 该期所有有流水的商家',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
