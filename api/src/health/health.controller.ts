import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Skip } from '../common/decorators/skip.decorator';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Skip()
  @ApiOperation({ summary: '存活探针' })
  async check(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.check();
    // ⚠️ **探活失败要用 503**：容器编排的 healthcheck 靠状态码判断，
    // 返回 200 会让「Redis 挂了」的容器继续被当成健康的。
    if (report.status === 'degraded') {
      res.status(503);
    }
    return report;
  }
}
