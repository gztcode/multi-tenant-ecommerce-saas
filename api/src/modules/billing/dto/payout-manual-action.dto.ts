import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 平台端人工操作出款单的请求体（阶段 5l）。
 *
 * ⚠️ **原因必填** —— 涉及钱的操作不能没有理由。
 *    理由会进 `payout_operations.reason`（留痕表）。
 */
export class PayoutManualActionDto {
  @ApiProperty({
    description: '操作原因（必填，会记进操作留痕）',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty({ message: '操作原因不能为空' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description:
      '解卡的目标状态：FAILED = 标记失败（认定没打出去）；APPROVED = 重新打款（⚠️ 可能重复打款）',
    enum: ['FAILED', 'APPROVED'],
  })
  // ⚠️ **`@IsOptional()` 不能少** —— 全局 `ValidationPipe` 没开
  //    `skipMissingProperties`（默认 false）→ 不加它的话，`@IsIn` 会拿
  //    `undefined` 也校验一遍 → **「重试」端点必然 400**
  //    （重试的请求体里根本没有 `to` 这个字段）。
  //    加了它之后：没传 `to` → 跳过校验（由控制器按端点各自的要求兜底）；
  //    传了但值不对 → `@IsIn` 照样拦。
  @IsOptional()
  @IsIn(['FAILED', 'APPROVED'])
  to?: 'FAILED' | 'APPROVED';
}
