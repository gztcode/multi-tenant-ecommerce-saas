import { Injectable, Logger } from '@nestjs/common';

import { TenantPrismaService } from '../common/tenant/tenant-prisma.service';
import { TimeoutError, withTimeout } from '../common/util/with-timeout';
import { RedisProbe } from './redis-probe';

/** 单项探活的超时（毫秒） */
const PROBE_TIMEOUT_MS = 2_000;

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    redis: boolean;
    database: boolean;
  };
  timestamp: string;
}

/**
 * 健康检查的业务逻辑。
 *
 * ⚠️ **数据库探活用 `databaseNow()`**：它是 `TenantPrismaService` 唯一暴露的
 * 原生 SQL 入口（`SELECT now()`），不涉及任何租户数据、不需要 tenantId 条件，
 * 而且它天然就是一个「真的连上了数据库」的证明。
 * 刻意不用 `$queryRaw` —— 那被刻意屏蔽了（原生 SQL 不经过租户扩展，
 * 放开就成了绕过隔离的后门）。
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly redis: RedisProbe,
  ) {}

  async check(): Promise<HealthReport> {
    const [redis, database] = await Promise.all([
      this.redis.check(),
      this.checkDatabase(),
    ]);

    return {
      status: redis && database ? 'ok' : 'degraded',
      checks: { redis, database },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await withTimeout(
        this.prisma.databaseNow(),
        PROBE_TIMEOUT_MS,
        '数据库 SELECT now()',
      );
      return true;
    } catch (cause) {
      // ⚠️ **只把「超时」当成正常的降级**，其它异常是「探活自己坏了」——
      //    两者都返回 false 让 /health 报 degraded，但要留下日志区分。
      if (!(cause instanceof TimeoutError)) {
        this.logger.error('数据库探活失败', cause);
      }
      return false;
    }
  }
}
