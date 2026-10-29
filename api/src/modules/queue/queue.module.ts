import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import {
  AUTH_QUEUE,
  BILLING_QUEUE,
  COMPENSATION_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  PAYMENT_WEBHOOK_QUEUE,
  PAYOUT_QUEUE,
} from '../../common/queue/queue.constants';
import { QueueService } from './queue.service';

/**
 * 队列模块。
 *
 * ⚠️ 隐含依赖：`BullModule.forRoot` 的参数是在**模块装饰器求值时**（即本文件
 * 被 import 的那一刻）读取 `process.env.REDIS_URL`，不是应用启动时。
 *
 * 本项目没有注册 ConfigModule（约定：配置一律直读 process.env），
 * dev 流程 `nest start --watch` 也不加载 .env——dev 环境里的 .env 是被
 * `require('@prisma/client')` 内部的 dotenv 顺带加载的。
 * 因此这里依赖 `app.module.ts` 中 **TenancyModule 先于 QueueModule 被 import**：
 * TenancyModule → tenant-prisma.service → @prisma/client → dotenv 加载 .env。
 *
 * ⚠️ 谁把 QueueModule 挪到 app.module.ts 的首位（或新增一个更早被 import 的模块），
 * REDIS_URL 就会静默变成 undefined，落到下面的 fallback 值——
 * 在容器里那是个不存在的地址（容器应连 redis:6379），
 * 症状是「容器里队列连不通」，极难查。
 */
@Global()
@Module({
  imports: [
    BullModule.forRoot({
      // ⚠️ **前缀可配置，是为了把测试与运行环境分开。**
      //
      // BullMQ 的队列在 Redis 里按 `prefix` 分命名空间（默认 `bull`）。
      // 本机跑着的 api 容器与 e2e 测试连的是**同一个 Redis**——用同一个
      // 前缀的话，容器里的 worker 会把测试投的任务抢走（它连的是开发库，
      // 于是报「订单不存在」），测试这边的事件 `processedAt` 永远不被置上，
      // 表现为**随机的假失败**。
      //
      // e2e 在 test/setup-e2e.ts 里把 `BULLMQ_PREFIX` 设成 `bull-e2e`，
      // 两边就是两套独立的 key 空间。
      //
      // ⚠️ 这个值同样在**模块装饰器求值时**读取（与下面的 REDIS_URL 一样），
      // 所以环境变量必须在 AppModule 被 import 之前设好。
      prefix: process.env.BULLMQ_PREFIX ?? 'bull',
      connection: {
        url: process.env.REDIS_URL ?? 'redis://localhost:16380',
        // BullMQ 的 Worker 硬性要求：它内部用阻塞命令等待任务，
        // 连接在重连时抛错会中断阻塞读，表现为「worker 静默停摆」。
        // ioredis v6 的默认值已经是 20（不是旧版的 1），但 BullMQ 要求必须是 null，
        // 所以这里显式指定。
        maxRetriesPerRequest: null,
      },
    }),
    BullModule.registerQueue(
      { name: PAYMENT_TIMEOUT_QUEUE },
      { name: PAYMENT_WEBHOOK_QUEUE },
      { name: BILLING_QUEUE },
      { name: AUTH_QUEUE },
      { name: COMPENSATION_QUEUE },
      { name: PAYOUT_QUEUE },
    ),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
