import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 修改收货地址。
 *
 * 全部字段可选：只传要改的部分。
 * 同样不接受 customerId（归属不可转移，护栏 20）。
 */
export class UpdateAddressDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  receiver?: string;

  @ApiPropertyOptional({ minLength: 5, maxLength: 20 })
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  province?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  city?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  district?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  detail?: string;

  @ApiPropertyOptional({
    description: '设为默认地址。同一消费者同时只能有一个默认地址',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
