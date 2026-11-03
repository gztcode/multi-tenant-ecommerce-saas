import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 设置平台默认出款渠道的请求体。
 *
 * ⚠️ **只接受 `channel` 一个字段**（全局 `ValidationPipe` 开了
 *    `forbidNonWhitelisted`，多传字段直接被 400 拒掉）。
 *
 * ⚠️ **长度上限 40 与前端中转的白名单逐字对齐** —— 两边不一致的话，
 *    前端放行的值会在后端 400，界面上只剩一句没头没尾的校验失败。
 */
export class SetPayoutChannelDto {
  @ApiProperty({
    description: '出款渠道名（必须是已启用的出款渠道）',
    example: 'fake-payout',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  channel!: string;
}
