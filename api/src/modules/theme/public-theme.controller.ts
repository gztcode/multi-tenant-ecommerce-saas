import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ThemeService } from './theme.service';

@ApiTags('public-theme')
@Controller('public/theme')
export class PublicThemeController {
  constructor(private readonly themeService: ThemeService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: '当前店铺生效的主题 token' })
  async current() {
    return { tokens: await this.themeService.current() };
  }
}
