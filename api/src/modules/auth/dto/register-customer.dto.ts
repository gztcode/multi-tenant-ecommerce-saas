import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterCustomerDto {
  @ApiProperty({
    format: 'email',
    maxLength: 160,
    example: 'customer@example.test',
    description: '消费者邮箱，店铺前台登录名',
  })
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(160)
  email!: string;

  @ApiProperty({
    format: 'password',
    minLength: 8,
    maxLength: 72,
    description: '登录密码，8-72 位，且必须同时包含字母和数字',
  })
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  // 上限 72：argon2 本身无 72 字节截断问题，这里与商家注册保持一致，
  // 统一的长度上限避免两边策略漂移。
  @MaxLength(72)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: '密码必须同时包含字母和数字',
  })
  password!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 60,
    example: '小张',
    description: '昵称，展示在店铺前台的订单与评价处',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  displayName!: string;
}
