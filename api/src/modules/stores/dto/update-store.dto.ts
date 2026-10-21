import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 店铺设置更新（仅限当前租户自己的店铺）。
 *
 * 这里刻意**不接受** tenantId / slug / status：
 * - tenantId 由租户扩展在写入时强制注入，客户端传了也会被覆盖；
 * - slug 与 status 属于平台或后续任务管理的字段，不该由商家后台随意改。
 * ValidationPipe 开了 whitelist + forbidNonWhitelisted，多传的字段直接 400，
 * 不会静默落到 Prisma 的 data 上。
 */
export class UpdateStoreDto {
  // 用 @ApiPropertyOptional 而非 @ApiProperty：CLI 插件已被停用（见 nest-cli.json），
  // @IsOptional() 不会再被翻译成 OpenAPI 的 required:false，必须显式用可选装饰器。
  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 60,
    example: 'Acme 官方旗舰店',
    description: '店铺名称，不传则保持原值',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  // themeTokens 是店铺主题配置的 JSON 结构，键值由前端设计系统决定，
  // 在这里逐字段校验会把后端和设计系统绑死，只校验「是个对象」即可。
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { primary: '#1677ff', radius: 8 },
    description: '店铺主题 token 集合，键由前端设计系统决定，不传则保持原值',
  })
  @IsOptional()
  @IsObject()
  themeTokens?: Record<string, unknown>;
}
