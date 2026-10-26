import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { TenantStatus, UserRole } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { TenantsService } from './tenants.service';
import { Roles } from '../../common/decorators/roles.decorator';

class UpdateTenantStatusDto {
  // 显式声明 enum，让文档里的取值与中文说明稳定可控（插件已停用，见 nest-cli.json）。
  @ApiProperty({
    enum: TenantStatus,
    enumName: 'TenantStatus',
    description:
      '目标状态：ACTIVE 正式启用 / SUSPENDED 已停用（停用后其签发的令牌立即失效）',
  })
  @IsEnum(TenantStatus, { message: 'status 必须是 ACTIVE / SUSPENDED' })
  status!: TenantStatus;
}

/**
 * 商家管理接口（平台超管专属）。
 *
 * @Roles 挂在**类**上：整个控制器只有超管能碰，逐个方法重复声明反而容易漏。
 * @Roles() 已经自带 UseGuards(JwtAuthGuard, RolesGuard)，
 * 未登录访问得到 401、角色不对得到 403，这里不要再叠一层 @UseGuards。
 */
@ApiTags('tenants')
@Roles(UserRole.PLATFORM_ADMIN)
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @ApiOperation({ summary: '商家列表（平台超管）' })
  list() {
    return this.tenantsService.list();
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '变更商家状态（平台超管）' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.tenantsService.updateStatus(id, dto.status);
  }
}
