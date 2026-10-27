import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { RedisProbe } from './redis-probe';

@Module({
  controllers: [HealthController],
  providers: [HealthService, RedisProbe],
})
export class HealthModule {}
