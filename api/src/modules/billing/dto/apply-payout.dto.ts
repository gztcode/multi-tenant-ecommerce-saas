import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * 申请出款的请求体。
 *
 * ⚠️ **请求体里没有任何金额字段**（护栏 P4）：应结金额全部由后端从
 * 货款流水与结算单算出来。前端能传金额的话，改一行前端就能改平台打给
 * 商家多少钱 —— 那不是「可被利用的漏洞」，那是把金额校验整个删掉。
 */
export class ApplyPayoutDto {
  @ApiProperty({
    description: '结算周期（自然月，UTC）。必须是 YYYY-MM',
    example: '2025-07',
  })
  @IsString()
  @Matches(/^(?!9999-)[1-9]\d{3}-(0[1-9]|1[0-2])$/, {
    message:
      '周期格式非法：必须是 YYYY-MM，年份在 1000 到 9998 之间（如 2025-07）',
  })
  period!: string;
}
