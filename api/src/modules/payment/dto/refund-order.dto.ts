import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 退款。
 *
 * ⚠️ **不接受金额字段**——本阶段只支持**整单退款**（设计 §7.1），
 * 退款金额就是订单金额。接受金额字段的话，一半退款会让
 * 「退 1 分钱」把整单标成 REFUNDED。
 */
export class RefundOrderDto {
  @ApiProperty({ required: false, description: '退款原因' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
