import { Global, Module } from '@nestjs/common';
import { RedisLockService } from './redis-lock.service';

/**
 * 分布式锁模块（阶段 11：跨副本互斥）。
 *
 * ⚠️ **@Global**：锁的使用方分散在 media / payment 等模块，
 *   横切基础设施不参与业务模块依赖图（与 MetricsModule / QueueModule 同款）。
 */
@Global()
@Module({
  providers: [RedisLockService],
  exports: [RedisLockService],
})
export class LockModule {}
