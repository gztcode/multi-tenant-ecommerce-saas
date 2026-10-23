import { Module } from '@nestjs/common';
import { ThemeController } from './theme.controller';
import { PublicThemeController } from './public-theme.controller';
import { ThemeService } from './theme.service';

@Module({
  controllers: [ThemeController, PublicThemeController],
  providers: [ThemeService],
  exports: [ThemeService],
})
export class ThemeModule {}
