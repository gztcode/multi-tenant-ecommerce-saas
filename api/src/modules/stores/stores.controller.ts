import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StoresService } from './stores.service';
import { UpdateStoreDto } from './dto/update-store.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Skip } from '../../common/decorators/skip.decorator';

/**
 * 店铺接口。
 *
 * 路径刻意用 `me` 而不是 `:id`：店铺的身份完全由 JWT 里的 tenantId 决定，
 * 客户端从不（也不该）提交店铺 id——一旦出现 `GET /stores/:id`，
 * 任何人只要改一下路径里的 id 就能读别人的店铺，越权防护全靠服务层兜。
 * 把 id 从协议里拿掉，越权通道在 API 契约层面就不存在。
 */
@ApiTags('stores')
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '当前租户的店铺' })
  findMine() {
    return this.storesService.findMine();
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '更新当前租户的店铺设置' })
  updateMine(@Body() dto: UpdateStoreDto) {
    return this.storesService.updateMine(dto);
  }

  // 公开接口：店铺前台在还没有任何登录态时也要能渲染店名与主题。
  // @Skip() 只跳过租户上下文解析（子域名来自路径参数，拦截器无从得知），
  // 与身份认证是两回事，这里确实不需要任何守卫。
  @Get('by-subdomain/:subdomain')
  @Skip()
  @ApiOperation({ summary: '按子域名查询店铺（公开）' })
  findBySubdomain(@Param('subdomain') subdomain: string) {
    return this.storesService.findBySubdomain(subdomain);
  }
}
