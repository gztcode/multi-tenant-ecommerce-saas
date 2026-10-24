import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 新增收货地址。
 *
 * ⚠️ **刻意不接受 customerId**：地址的归属者是当前登录的消费者，
 * 由服务端从租户上下文取。客户端传 customerId 只会打开一条
 * 「把地址挂到别人账号上」的路子（护栏 20）。
 */
export class CreateAddressDto {
  @ApiProperty({ minLength: 1, maxLength: 60, example: '张三' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  receiver!: string;

  @ApiProperty({ minLength: 5, maxLength: 20, example: '13800000000' })
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ minLength: 1, maxLength: 30, example: '浙江省' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  province!: string;

  @ApiProperty({ minLength: 1, maxLength: 30, example: '杭州市' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  city!: string;

  @ApiProperty({ minLength: 1, maxLength: 30, example: '西湖区' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  district!: string;

  @ApiProperty({ minLength: 1, maxLength: 200, example: '文一西路 100 号' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  detail!: string;

  @ApiPropertyOptional({
    default: false,
    description: '是否设为默认地址。同一消费者同时只能有一个默认地址',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
