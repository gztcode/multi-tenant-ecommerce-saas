import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Skip } from '../decorators/skip.decorator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus 抓取端点（阶段 11：可观测性）。
 *
 * - 完整路径是 `/api/v1/metrics`（全局前缀 api/v1）；
 * - **必须带 @Skip()**：本端点不碰租户作用域模型，若建立租户上下文，
 *   匿名请求在解析子域名阶段就会被拒（Prometheus 抓取不带店铺 Host）；
 * - API 端口只绑回环/容器网，抓取端点暴露面与 `/health` 一致；
 *   将来上独立抓取网段时再考虑加网络层隔离或独立端口。
 */
@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Skip()
  @ApiOperation({ summary: 'Prometheus 抓取端点' })
  async metrics(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metricsService.registry.contentType);
    res.end(await this.metricsService.registry.metrics());
  }
}
