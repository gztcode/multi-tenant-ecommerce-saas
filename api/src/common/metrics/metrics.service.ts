import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../tenant/tenant-context';
import {
  AUTH_QUEUE,
  BILLING_QUEUE,
  COMPENSATION_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
  PAYOUT_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../../modules/queue/queue.service';
import type { QueueName } from '../../modules/queue/queue.service';

/** 卡单判定阈值：处于中间态超过这么久就算「卡住」（毫秒） */
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

/** 后台 gauge 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 15_000;

/**
 * Prometheus 指标（阶段 11：可观测性）。
 *
 * ## 收录哪些指标、为什么不收别的
 *
 * - **HTTP RED**（率/错/耗时，按 method × 路由模板 × 状态码）：
 *   路由用 Express 的**路由模板**（`/api/v1/orders/:orderNo`）而不是原始 URL，
 *   否则每个订单号都是一个新 label 值，指标基数（cardinality）会爆炸。
 * - **队列深度**（六个 BullMQ 队列的 jobCounts）：webhook 消费积压、
 *   出款扫描积压是最先反映「系统慢了」的信号。
 *   经由 `QueueService`（全局导出）读取，而不是直接 `@InjectQueue`——
 *   队列注入令牌没有被 QueueModule 导出，模块外拿不到。
 * - **卡单 gauge**（REFUNDING / PROCESSING 超过 30 分钟的单数）：
 *   这是本系统资金安全的直接指标——正常情况下这两个数字应该恒为 0。
 *   轮询而不是事件递增：轮询天然自愈（进程重启、计数漂移都不会累积错）。
 * - **collectDefaultMetrics**：CPU / 内存 / event loop lag 等进程指标白送。
 *
 * ⚠️ **刻意不做 Prisma 逐查询计时**：`$on('query')` 事件要求把 query 级别
 *    日志打开，每条 SQL 多一次事件分发，热路径开销不小；HTTP 耗时已经
 *    包含了 DB 时间，慢查询兜底另有 `statement_timeout`（阶段 11 部署加固）。
 *    真需要 SQL 级观测时再开，做成显式开关。
 *
 * ## 后台轮询的租户上下文
 *
 * 卡单统计要跨所有租户 count——必须包在 `tenantContext.run(platformScope())`
 * 里跑，否则租户扩展会附加 tenantId 条件（当前没有上下文，直接抛错）。
 * 轮询是后台定时器，与请求的 AsyncLocalStorage 互不影响。
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  readonly registry = new Registry();

  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  private readonly queueDepth: Gauge<'queue' | 'state'>;
  private readonly stuckPayments: Gauge;
  private readonly stuckPayouts: Gauge;

  private readonly queueNames: QueueName[] = [
    PAYMENT_TIMEOUT_QUEUE,
    PAYMENT_WEBHOOK_QUEUE,
    BILLING_QUEUE,
    AUTH_QUEUE,
    COMPENSATION_QUEUE,
    PAYOUT_QUEUE,
  ];
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
  ) {
    this.httpRequests = new Counter({
      name: 'ecommerce_http_requests_total',
      help: 'HTTP 请求总数（route 是路由模板，非原始 URL）',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'ecommerce_http_request_duration_seconds',
      help: 'HTTP 请求耗时（秒）',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: 'ecommerce_queue_jobs',
      help: 'BullMQ 队列中各状态的任务数',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
    });
    this.stuckPayments = new Gauge({
      name: 'ecommerce_payments_refunding_stuck',
      help: 'REFUNDING 超过 30 分钟的支付单数（正常应为 0）',
      registers: [this.registry],
    });
    this.stuckPayouts = new Gauge({
      name: 'ecommerce_payouts_processing_stuck',
      help: 'PROCESSING 超过 30 分钟的出款单数（正常应为 0）',
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
    // unref：轮询定时器不阻止进程退出（graceful shutdown 时少一个牵挂）
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
    }
  }

  /** HTTP RED 的记录入口（MetricsInterceptor 在 res 'finish' 时调用） */
  recordHttpRequest(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  /** 后台轮询：队列深度 + 卡单数。任何一轮失败只跳过，绝不抛出 */
  async poll(): Promise<void> {
    await Promise.all([
      this.pollQueues(),
      this.pollStuckWork().catch(() => {
        // 库不可达时指标缺一轮比进程崩溃好
      }),
    ]);
  }

  private async pollQueues(): Promise<void> {
    await Promise.all(
      this.queueNames.map(async (name) => {
        try {
          const counts = await this.queues.jobCountsOf(name);
          for (const [state, value] of Object.entries(counts)) {
            this.queueDepth.set({ queue: name, state }, value);
          }
        } catch {
          // 连不上 Redis 时该队列的指标缺一轮
        }
      }),
    );
  }

  /** 卡单：跨租户统计，必须显式进 platform scope */
  private async pollStuckWork(): Promise<void> {
    // ⚠️ `updatedAt` 是库时钟写的（P2-15），阈值基准也要用库时钟，
    //    否则应用与数据库的时钟偏差会让「卡了多久」整体偏移。
    const now = await this.prisma.databaseNow();
    const threshold = new Date(now.getTime() - STUCK_THRESHOLD_MS);
    const stuckRefunding = await tenantContext.run(platformScope(), () =>
      this.prisma.payment.count({
        where: { status: 'REFUNDING', updatedAt: { lt: threshold } },
      }),
    );
    const stuckProcessing = await tenantContext.run(platformScope(), () =>
      this.prisma.payout.count({
        where: { status: 'PROCESSING', updatedAt: { lt: threshold } },
      }),
    );
    this.stuckPayments.set(stuckRefunding);
    this.stuckPayouts.set(stuckProcessing);
  }
}
