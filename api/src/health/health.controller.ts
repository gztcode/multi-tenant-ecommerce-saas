import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Skip } from '../common/decorators/skip.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @Skip()
  @ApiOperation({ summary: '存活探针' })
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
