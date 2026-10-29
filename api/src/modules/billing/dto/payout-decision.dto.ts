import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 审批出款的请求体。
 *
 * ⚠️ **只有拒绝时才需要填原因**（`reason` 可选）——
 * 通过时没什么好解释的，非要商家与超管都填一遍「同意」纯属噪声。
 */
export class PayoutDecisionDto {
  @ApiProperty({
    description: '拒绝原因。拒绝时必填（由 service 层校验）',
    required: false,
    example: '该期结算单尚未确认',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}
