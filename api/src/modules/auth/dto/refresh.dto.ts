import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshDto {
  // base64url 编码 30 字节 = 40 字符，40-200 的区间同时容纳长度与未来策略调整。
  @ApiProperty({
    format: 'password',
    minLength: 20,
    maxLength: 200,
    description: '登录接口返回的刷新令牌，用于换取新的访问令牌',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  refreshToken!: string;
}
