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
 * # 已确认过「重复回填也不会重复出款」时，跳过活跃出款单的保护
 * npm run backfill:ledger -- --force
 * ```
 * ⚠️ `backfill:commissions` 是它的转发别名 —— 运维的老命令名不用改，
 * 但**只有一份脚本**（两份脚本意味着两套逻辑要同步维护，早晚漂）。
 */
import { NestFactory } from '@nestjs/core';

import { loadEnvFile } from '../src/common/config/load-env';

import { ActivePayoutsError } from '../src/modules/billing/backfill-guard';
import { CommissionService } from '../src/modules/billing/commission.service';
import { ReceiptService } from '../src/modules/billing/receipt.service';

async function main(): Promise<void> {
  // ⚠️ **必须先加载 `.env`，再 import 应用图**（顺序不能反）。
  //    静态 import 会被提升到文件顶部 → 应用图（含 `queue.module.ts`）
  //    在 `.env` 加载前就被求值 → `BullModule.forRoot` 定死了没有密码的
  //    Redis 地址 → `NOAUTH HELLO ...`。详见 `common/config/load-env.ts`。
  loadEnvFile();
  const force = process.argv.includes('--force');

  // ⚠️ **必须在这里（而不是文件顶部）加载应用图**：静态 import 会被提升到
  //    文件顶部，`.env` 还没加载就被求值 —— 见上面的说明。
  //
  //    用 `require()` 而不是 `await import()`：本目录的脚本由 ts-node 以
  //    **CommonJS** 运行（package.json 的 `--compiler-options '{"module":"CommonJS"}'`），
  //    而 `await import()` 在 `tsc --noEmit` 的 `nodenext` 解析下要求**带扩展名**
  //    的路径（`../src/app.module.js`）—— 那个路径在 CommonJS 运行期又找不到文件。
  //    `require()` 两边都成立：运行期在调用点求值（位置正确），类型上用
  //    `typeof import(...)` 拿到准确类型（无扩展名也能解析）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // ⚠️ **不启 HTTP 服务**：这个脚本只需要应用上下文（拿 service），
    // 监听端口会和正在跑的服务抢 3000。
    logger: ['error', 'warn', 'log'],
  });

  let exitCode = 0;

  try {
    const commission = app.get(CommissionService);
    const receipt = app.get(ReceiptService);

    try {
      const result = await commission.backfill({ force });
      const receiptResult = await receipt.backfill({ force });

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
      console.log(
        `  跳过（货款额为 0）：${receiptResult.skippedZeroAmount} 单`,
      );
      console.log(
        `  跳过（已退款但无退款时间，冲回无法归期）：${receiptResult.skippedUndatedRefund} 单`,
      );
    } catch (cause) {
      if (cause instanceof ActivePayoutsError) {
        console.error(cause.message);
        for (const payout of cause.payouts) {
          console.error(
            `  - ${payout.payoutNo} tenant=${payout.tenantId} ` +
              `${payout.periodStart.toISOString().slice(0, 7)} ${payout.kind} ${payout.status}`,
          );
        }
        console.error('确认要跳过着保护时：npm run backfill:ledger -- --force');
        exitCode = 1;
      } else {
        throw cause;
      }
    }
  } finally {
    // ⚠️ **必须显式关闭应用**：Nest 的连接池（Prisma、Redis）会吊住进程，
    // 脚本跑完却不退出，CI 与运维都会卡住。
    await app.close();
  }

  // ⚠️ **显式退出**：连接池的关闭是异步的，`app.close()` 返回后
  // 底层 socket 可能还没完全释放。显式退出保证脚本一定结束；
  // 有活跃出款单时退出码非零，CI / 运维能立刻发现。
  process.exit(exitCode);
}

void main();
