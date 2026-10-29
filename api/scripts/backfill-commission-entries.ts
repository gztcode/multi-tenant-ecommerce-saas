/**
 * 回填历史订单的抽佣流水（阶段 5e）与货款流水（阶段 5h-1）。
 *
 * ⚠️ **什么时候需要跑**：抽佣流水表是阶段 5e 才建的，货款流水表是阶段 5h-1
 * 才建的，这两表建之前已经成交的订单都没有流水行。跑一次这个脚本，
 * 那些历史订单的抽佣、冲回、货款、货款冲回就补齐了，
 * 平台后台的「抽佣明细」「收入报表」与将来的出款才对得上。
 *
 * ⚠️ **幂等**：逐条「先查后插」（`findFirst` 判断后 `create`），
 * 跑第二遍不会产生第二行。
 * ⚠️ **刻意不用 `upsert`**：`CommissionEntry` / `MerchantReceipt` 都在租户作用域白名单里，
 * 扩展直接拒绝 `upsert`（where 只能按唯一字段，无法附加 tenantId 条件）。
 *
 * ⚠️ **副作用**：脚本用 `createApplicationContext(AppModule)` 建上下文，
 * 会一并注册 4 个 BullMQ 消费者（order-timeout / token-grace / webhook / renewal）
 * → 回填期间会真的消费队列任务。功能无害（`app.close()` 会清理），
 * 但与「只取一个 service」的意图有出入。
 *
 * ⚠️ **跨租户**：抽佣流水与货款流水都是平台看所有商家的账，所以回填跑在**平台作用域**下
 * （由各 service 的 `backfill()` 内部显式声明）。
 *
 * ⚠️ **两套回填分成两次调用**（不是一次扫两表）：两者的零额判定字段不同
 * （抽佣看 `commissionAmount`、货款看 `totalAmount`）—— 零额抽佣的订单
 * **有货款、无抽佣**，混在一起判定就会把货款漏掉。
 *
 * 用法（在 `api/` 目录下）：
 * ```
 * npm run backfill:ledger
 * ```
 * ⚠️ `backfill:commissions` 是它的转发别名 —— 运维的老命令名不用改，
 * 但**只有一份脚本**（两份脚本意味着两套逻辑要同步维护，早晚漂）。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { CommissionService } from '../src/modules/billing/commission.service';
import { ReceiptService } from '../src/modules/billing/receipt.service';

/**
 * 加载 `.env`。
 *
 * ⚠️ **用 Node 内置的 `process.loadEnvFile`**（Node 20.12+）而不是 `dotenv`：
 * 仓库里没有 `dotenv` 依赖，而 `process.loadEnvFile` 是内置的。
 * 文件不存在就跳过 —— 容器里的环境变量是直接注入的，本来就没有 `.env`。
 */
function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnv();

  const app = await NestFactory.createApplicationContext(AppModule, {
    // ⚠️ **不启 HTTP 服务**：这个脚本只需要应用上下文（拿 service），
    // 监听端口会和正在跑的服务抢 3000。
    logger: ['error', 'warn', 'log'],
  });

  try {
    const commission = app.get(CommissionService);
    const result = await commission.backfill();

    const receipt = app.get(ReceiptService);
    const receiptResult = await receipt.backfill();

    // ⚠️ **把计数打出来**：运维要看到「有多少历史退款被跳过了」
    // （5b 之前退的款没记时间 → 冲回无法归期）。静默跳过等于账对不上却没人知道。
    console.log('抽佣流水回填完成：');
    console.log(`  新建抽佣流水：${result.commissionCreated} 行`);
    console.log(`  新建冲回流水：${result.reversalCreated} 行`);
    console.log(`  跳过（抽佣额为 0）：${result.skippedZeroAmount} 单`);
    console.log(
      `  跳过（已退款但无退款时间，冲回无法归期）：${result.skippedUndatedRefund} 单`,
    );

    console.log('货款流水回填完成：');
    console.log(`  新建货款流水：${receiptResult.receiptCreated} 行`);
    console.log(`  新建货款冲回流水：${receiptResult.reversalCreated} 行`);
    console.log(`  跳过（货款额为 0）：${receiptResult.skippedZeroAmount} 单`);
    console.log(
      `  跳过（已退款但无退款时间，冲回无法归期）：${receiptResult.skippedUndatedRefund} 单`,
    );
  } finally {
    // ⚠️ **必须显式关闭应用**：Nest 的连接池（Prisma、Redis）会吊住进程，
    // 脚本跑完却不退出，CI 与运维都会卡住。
    await app.close();
  }

  // ⚠️ **`process.exit(0)`**：连接池的关闭是异步的，`app.close()` 返回后
  // 底层 socket 可能还没完全释放。显式退出保证脚本一定结束。
  process.exit(0);
}

void main();
