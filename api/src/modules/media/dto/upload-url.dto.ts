import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/** 允许的图片类型 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export class UploadUrlDto {
  @ApiProperty({ maxLength: 200, example: 'tee-front.jpg' })
  @IsString()
  @MaxLength(200)
  filename!: string;

  @ApiProperty({
    enum: ALLOWED_MIME_TYPES,
    example: 'image/jpeg',
    description: '图片类型，只接受白名单里的四种',
  })
  @IsString()
  mime!: string;

  // ⚠️ 这里**不写** @Max(上限)：上限由 MEDIA_MAX_SIZE 环境变量决定，
  // 而 class-validator 的装饰器在模块 import 时求值，那时 @nestjs/config
  // 还没加载 .env——写死一个数字就会与 service 里的判断形成两个真相源
  // （改环境变量不生效，或两边不一致）。
  // 上限的判定统一放在 MediaService 里，DTO 只管「是正整数」。
  @ApiProperty({
    minimum: 1,
    example: 204800,
    description: '文件字节数，上限由服务端的 MEDIA_MAX_SIZE 决定（默认 5MB）',
  })
  @IsInt()
  @Min(1)
  size!: number;
}
