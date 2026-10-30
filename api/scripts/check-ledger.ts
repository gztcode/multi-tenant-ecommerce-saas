/**
 * 账目流水自检（阶段 5i Task 2）。
 *
 * ⚠️ **为什么要有这个脚本**：阶段 5i 要把平台收入报表的聚合源从 `orders` 换成
 * `commission_entries`。但 `commission_entries`（阶段 5e）与 `merchant_receipts`
 * （阶段 5h-1）都是**后加的表** —— 表建之前成交的历史订单**没有流水行**，
 * 要靠 `npm run backfill:ledger` 补齐。
 *
 * ⚠️ **改口径之后「忘了回填」的后果会从「看不出来」变成「历史收入显示 0」**：
 * 报表从流水表聚合，缺行的历史订单的收入就凭空消失了。
 * 所以切口径之前要有**一道只读的防线**：本脚本回答「历史订单的流水补齐了吗」，
 * 有缺口就以非 0 退出码结束。
 *
 * ⚠️ **只读**：本脚本只 `findMany`，不写任何表。跑多少遍都不会改数据。
 *
 * ⚠️ **判定口径必须与两个 `backfill()` 逐字一致**：
 * `shouldBackfillCommission` / `shouldBackfillReversal`（`commission.service.ts`）
 * 与 `shouldBackfillReceipt` / `shouldBackfillReceiptReversal`（`receipt.service.ts`）
 * 共同定义了「哪些订单**应该有**流水行」。判定规则与它们对不上，
 * 脚本就会把**本来就不该有流水行**的订单报成缺口 → 防线变成噪音（永远 exit 1）。
 *
 * 用法（在 `api/` 目录下）：
 * ```
 * npm run check:ledger
 * ```
 * 有缺口时退出码为 1（可接进 CI / 部署前置检查）。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { CommissionEntryType, OrderStatus, ReceiptType } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import {
  checkLedger,
  type LedgerCheckResult,
} from '../src/modules/billing/ledger-check';

/**
 * 加载 `.env`。
 *
 * ⚠️ **用 Node 内置的 `process.loadEnvFile`**（Node 20.12+）而不是 `dotenv`：
 * 仓库里没有 `dotenv` 依赖。文件不存在就跳过 —— 容器里的环境变量是直接注入的。
 */
function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

/**
 * 打印缺口明细（最多 20 条）。
 *
 * ⚠️ **只打前 20 条**：缺口可能有几百条，全打出来会把结论淹没在列表里。
 * 运维要看全量可以自己去查数据库。
 */
function printMissing(label: string, orderNos: string[]): void {
  if (orderNos.length === 0) {
    return;
  }
  console.log(`  ${label}（前 ${Math.min(20, orderNos.length)} 条）：`);
  for (const orderNo of orderNos.slice(0, 20)) {
    console.log(`    - ${orderNo}`);
  }
  if (orderNos.length > 20) {
    console.log(`    …… 另有 ${orderNos.length - 20} 条未列出`);
  }
}

async function main(): Promise<void> {
  loadEnv();

  const app = await NestFactory.createApplicationContext(AppModule, {
    // ⚠️ **不启 HTTP 服务**：这个脚本只需要应用上下文（拿 service），
    // 监听端口会和正在跑的服务抢 3000。
    //
    // ⚠️ **只留 error / warn**：这个脚本的**输出是给运维看的结论**，
    //    Nest 的 info 日志（二十多行「InstanceLoader ... initialized」）
    //    会把结论淹没在日志里。
    logger: ['error', 'warn'],
  });

  let result: LedgerCheckResult;
  try {
    const prisma = app.get(TenantPrismaService);

    // ⚠️ **必须走平台作用域**：账是平台看所有商家的账，
    // 不显式声明会只统计一个租户（静默少算，防线失效）。
    //
    // ⚠️ **回调必须是 async 函数**：Prisma 6 的 PrismaPromise 是 thenable
    // 而非原生 Promise，同步回调会让租户上下文在查询执行时丢失 →
    // **租户隔离静默失效**（不会抛错）。
    result = await tenantContext.run(platformScope(), async () => {
      // ⚠️ **只查 `paidAt` 非空的订单**：没付过钱的订单没有流水，
      // 与两个 `backfill()` 的取数口径逐字一致。
      const orders = await prisma.order.findMany({
        where: { paidAt: { not: null } },
        select: {
          id: true,
          orderNo: true,
          paidAt: true,
          refundedAt: true,
          status: true,
          commissionAmount: true,
          totalAmount: true,
        },
      });

      // ⚠️ **枚举用常量而不是字符串字面量**：字符串比较在枚举扩容时会静默漏掉
      // （`CommissionEntryType.COMMISSION` 才是权威值）。
      const commissionEntries = await prisma.commissionEntry.findMany({
        select: { orderId: true, type: true },
      });
      const receiptEntries = await prisma.merchantReceipt.findMany({
        select: { orderId: true, type: true },
      });

      return checkLedger({
        orders,
        commissionEntryOrderIds: commissionEntries
          .filter((e) => e.type === CommissionEntryType.COMMISSION)
          .map((e) => e.orderId),
        reversalEntryOrderIds: commissionEntries
          .filter((e) => e.type === CommissionEntryType.REVERSAL)
          .map((e) => e.orderId),
        receiptOrderIds: receiptEntries
          .filter((e) => e.type === ReceiptType.SALE)
          .map((e) => e.orderId),
        reversalReceiptOrderIds: receiptEntries
          .filter((e) => e.type === ReceiptType.SALE_REVERSAL)
          .map((e) => e.orderId),
      });
    });
  } finally {
    // ⚠️ **必须显式关闭应用**：Nest 的连接池（Prisma、Redis）会吊住进程。
    await app.close();
  }

  console.log('账目流水自检');
  console.log('──────────────────────────────');
  console.log(`缺抽佣流水：${result.commissionMissing.length} 单`);
  console.log(`缺冲回流水：${result.reversalMissing.length} 单`);
  console.log(`缺货款流水：${result.receiptMissing.length} 单`);
  console.log(
    `已退款但无退款时间（冲回永远无法归期）：${result.undatedRefundCount} 单`,
  );
  console.log('──────────────────────────────');

  if (result.hasGap) {
    printMissing('缺抽佣流水', result.commissionMissing);
    printMissing('缺冲回流水', result.reversalMissing);
    printMissing('缺货款流水', result.receiptMissing);
    console.log(
      '结论：❌ 流水不完整 —— 先跑 `npm run backfill:ledger`，不要切报表口径',
    );
    // ⚠️ **有缺口 → 退出码 1**：这道防线要能被 CI / 部署前置检查接住。
    process.exitCode = 1;
  } else {
    console.log('结论：✅ 流水完整');
    process.exitCode = 0;
  }

  // ⚠️ **显式退出**：连接池的关闭是异步的，`app.close()` 返回后
  // 底层 socket 可能还没完全释放 → 脚本跑完却不退出，CI 与运维都会卡住。
  // ⚠️ `process.exit(n)` 会**覆盖** `process.exitCode` → 必须传同一个值，
  // 否则有缺口时会被 `exit(0)` 抹平成 0，防线直接失效。
  process.exit(process.exitCode);
}

// ⚠️ **无条件执行**：本文件是**脚本入口**（由 `npm run check:ledger` 调用），
// 判定逻辑已经拆到 `src/modules/billing/ledger-check.ts` → 单测不 import 本文件，
// 所以这里不需要 `require.main === module` 守卫（import 就去连库了）。
void main();
