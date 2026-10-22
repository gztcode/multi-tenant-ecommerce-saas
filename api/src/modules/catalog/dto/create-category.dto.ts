import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 品类创建。
 *
 * 刻意不接受 tenantId：租户扩展在写入时强制注入，客户端传了也会被覆盖；
 * ValidationPipe 开了 forbidNonWhitelisted，多传的字段直接 400。
 */
export class CreateCategoryDto {
  @ApiProperty({ minLength: 1, maxLength: 60, example: '女装' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 60,
    example: 'women',
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'URL 片段，租户内唯一（仅对未删除的品类生效）',
  })
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字与连字符' })
  slug!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: '父品类 id，留空表示一级品类',
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ default: 0, description: '同级排序，数字小的靠前' })
  @IsOptional()
  @IsInt()
  sort?: number;
}
