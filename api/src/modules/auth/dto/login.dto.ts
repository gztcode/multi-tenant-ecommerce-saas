import {
  IsEmail,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum LoginScope {
  MERCHANT = 'MERCHANT',
  CUSTOMER = 'CUSTOMER',
  PLATFORM = 'PLATFORM',
}

export class LoginDto {
  @ApiProperty({
    format: 'email',
    maxLength: 160,
    example: 'merchant@example.test',
  })
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(160)
  email!: string;

  @ApiProperty({ minLength: 1, maxLength: 72, format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;

  // 必须显式声明登录入口（商家后台 / 店铺前台 / 平台后台）。
  // 同一个邮箱在不同租户下可能有各自的账号，不指明入口就无法确定要匹配哪一个；
  // 若靠角色猜，攻击者可以用 scope=CUSTOMER 试探出一个商家账号的登录态。
  //
  // 显式写 @ApiProperty 的作用是让文档里的枚举值与中文说明稳定可控。
  // 注意：它**不能**阻止 CLI 插件生成坏引用——插件读的是 TS 类型注解，
  // 不读装饰器。真正的处理见 nest-cli.json 里的插件配置注释。
  @ApiProperty({
    enum: LoginScope,
    enumName: 'LoginScope',
    description:
      '登录入口：MERCHANT 商家后台 / CUSTOMER 店铺前台 / PLATFORM 平台后台',
  })
  @IsEnum(LoginScope, {
    message: 'scope 必须是 MERCHANT / CUSTOMER / PLATFORM',
  })
  scope!: LoginScope;
}
