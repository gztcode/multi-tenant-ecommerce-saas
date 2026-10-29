import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 设置收款账户的请求体。
 *
 * ⚠️ **没有 `tenantId`**：租户从 JWT 的上下文取，不接受客户端指定。
 */
export class SetPayoutAccountDto {
  @ApiProperty({ description: '开户人姓名', example: '张三' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  accountName!: string;

  @ApiProperty({ description: '开户行', example: '招商银行' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  bankName!: string;

  // ⚠️ **账号在「更新已有账户」时可空**：
  //    后端只返回**脱敏值**，商家改个开户人姓名时手里没有原账号可填
  //    → 留空表示「不修改这一项」。
  //    ⚠️ **首次设置时必填**（由 service 层校验）—— 没有账号不知道钱打给谁。
  @ApiProperty({
    description: '银行账号。留空表示不修改（首次设置时必填）',
    required: false,
    example: '6225880000000000',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  accountNo?: string;
}
