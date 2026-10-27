import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AUTH_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';

/** 清理的间隔（1 小时） */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 宽限记录的定时清理。
 *
 * ⚠️ **为什么必须清理**：宽限记录里存的是新令牌的**密文**。
 * 客户端轮换之后就不会再用旧令牌，所以绝大多数行的密文**永远等不到**
 * 「有人来用它」的那一刻 —— 惰性清理根本不会触发。
 * 不清理的话，这一列会随着每次轮换不断增长。
 *
 * ⚠️ **清理用数据库时钟**：批量扫描的判定精度是「小时级」，
 * 几百毫秒的时钟偏差无影响；而用数据库的 `now()` 可以一条 UPDATE 搞定。
 * ⚠️ **但不能写裸 SQL** —— `TenantPrismaService` 刻意不暴露
 * `$queryRaw` / `$executeRaw`（原生 SQL 不经过租户扩展，
 * 放开就成了绕过隔离的后门）。所以调现成的 `databaseNow()` 拿时间戳，
 * 再交给 Prisma 的 `updateMany`。
 *
 * ⚠️ **判定「令牌是否在宽限期内」（秒级、决定放行与否）用应用时钟** ——
 * 那是 `AuthService` 的事，与这里的批量扫描职责不同。
 */
@Injectable()
export class TokenGraceService implements OnModuleInit {
  private readonly logger = new Logger(TokenGraceService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queue: QueueService,
  ) {}

  /**
   * 注册周期任务，并在启动时先清一次。
   *
   * ⚠️ **启动时清一次是兜底**：清理任务依赖 BullMQ worker，
   * 而 worker 可能没起来或挂了 —— 那密文就会一直留着。
   * 启动时清一次，保证「进程重启过之后一定是干净的」。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      AUTH_QUEUE,
      'cleanup',
      {},
      CLEANUP_INTERVAL_MS,
      // ⚠️ **固定 jobSchedulerId**：BullMQ 的作业调度器按它去重，
      // 重复注册是覆盖而不是叠加 —— 否则每次重启应用都会多一个任务。
      'token-grace-cleanup',
    );

    const cleared = await this.cleanup();
    if (cleared > 0) {
      this.logger.log(`启动时清理了 ${cleared} 条过期的宽限记录`);
    }
  }

  /**
   * 抹掉所有**已过宽限期**的记录上的密文。
   *
   * ⚠️ **只清列不删行**：`refresh_tokens` 的行在 `expiresAt` 过期后依然留着
   * （既有状况）。删行会让「令牌族」的审计线索断掉。
   *
   * @returns 抹掉的行数
   */
  async cleanup(): Promise<number> {
    const now = await this.prisma.databaseNow();

    // ⚠️ `RefreshToken` 不在 `TENANT_SCOPED_MODELS` 里，
    // 所以这个 updateMany 不带 tenantId 条件 —— 它本来就跨租户。
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        graceExpiresAt: { lt: now },
        rotatedToToken: { not: null },
      },
      data: { rotatedToToken: null },
    });

    return result.count;
  }
}
