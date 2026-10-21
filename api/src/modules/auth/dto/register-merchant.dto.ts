import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  RESERVED_SUBDOMAINS,
  SUBDOMAIN_PATTERN,
} from '../../../common/tenant/tenant-models';

/**
 * 拒绝平台保留子域名。
 *
 * 刻意做成引用共享常量的自定义装饰器，而不是在服务层 if 判断：
 * 子域名格式已经有单一事实来源（SUBDOMAIN_PATTERN），保留名单也必须有同一个来源，
 * 否则新增基础设施保留名时容易只改一处，两侧漂移且**静默**——商家注册成功拿到
 * `admin` 子域名，将来基础设施把 `admin.platform.test` 指向超管后台即成接管。
 *
 * 校验错误信息刻意不区分「格式非法」与「是保留名」以外的信息，但这里属于注册期
 * 面向商家本人的表单提示，说清楚比含糊更有用；真正的防枚举侧信道在读取侧
 * （TenantResolverService 对保留字与不存在返回同一措辞），两处目标不同。
 */
export function IsNotReservedSubdomain(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isNotReservedSubdomain',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          return !RESERVED_SUBDOMAINS.has(value.trim().toLowerCase());
        },
        defaultMessage(args: ValidationArguments): string {
          const value = String(args.value).toLowerCase();
          return `子域名 ${value} 是平台保留字，请换一个`;
        },
      },
    });
  };
}

export class RegisterMerchantDto {
  @ApiProperty({
    format: 'email',
    maxLength: 160,
    example: 'merchant@example.test',
    description: '商家管理员邮箱，同一邮箱可作为后续子账号登录名',
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
  @MaxLength(72)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: '密码必须同时包含字母和数字',
  })
  password!: string;

  @ApiProperty({
    minLength: 2,
    maxLength: 60,
    example: '示例商户',
    description: '商户主体名称，展示在商家后台与账单抬头',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  merchantName!: string;

  // 格式引用公共常量：写入侧与读取侧必须用同一份正则，
  // 否则「注册时被拒的格式」仍能通过 Host 头进入子域名解析。
  @ApiProperty({
    minLength: 3,
    maxLength: 32,
    pattern: '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$',
    example: 'acme-shop',
    description:
      '店铺子域名，长度 3-32，只能包含小写字母、数字和连字符，且不能是平台保留字（注册时会被拒绝）',
  })
  @IsString()
  @Matches(SUBDOMAIN_PATTERN, {
    message: '子域名只能包含小写字母、数字和连字符，长度 3-32',
  })
  @IsNotReservedSubdomain({
    message: '该子域名是平台保留字，请换一个',
  })
  subdomain!: string;

  @ApiProperty({
    minLength: 2,
    maxLength: 60,
    example: 'Acme 官方旗舰店',
    description: '店铺名称，展示在店铺前台',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  storeName!: string;
}
