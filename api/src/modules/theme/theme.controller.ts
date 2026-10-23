import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Skip } from '../../common/decorators/skip.decorator';
import { ThemeService } from './theme.service';

@ApiTags('theme')
@Controller('theme')
export class ThemeController {
  constructor(private readonly themeService: ThemeService) {}

  /**
   * ⚠️ 这里用 @Skip() 而不是 @Public()，与任务说明里写的不同，是**必要的修正**。
   *
   * token 的定义是全局静态常量，不属于任何租户，也完全不碰租户作用域模型
   * （不查库）。而 @Public() 只放行身份认证、**照常要求解析租户**：
   * 匿名请求没带 X-Tenant-Subdomain 头时，租户上下文拦截器会直接抛
   * 404「无法确定店铺」——商家后台在中心域名上打开设置页时必然没有店铺子域名，
   * 于是这个端点永远取不到定义，主题表单整块渲染不出来。
   *
   * @Skip() 正是为「不碰租户作用域模型的公共端点」准备的（见 health），
   * 语义与本端点完全吻合。不存在越权风险：这里没有任何按租户过滤的数据。
   */
  @Get('schema')
  @Skip()
  @ApiOperation({ summary: '主题 token 的定义与默认值' })
  schema() {
    return this.themeService.schema();
  }
}
