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
 * ⚠️ **除了订单与流水表，还要查 `payments` 表**（2026-11-05 审计 P0-3 / P1-3）：
 * 「渠道回调到达时订单已超时关闭 / 已被取消 / 已被另一渠道先付掉」→
 * 钱收了但订单没结算；「同一订单两个渠道各收一笔」→ 重复收款。
 * 这两种资损在订单与流水表里**一个都看不出来**，只查那三张表会报
 * 「✅ 流水完整」然后 exit 0 → 防线形同虚设。
 *
 * 用法（在 `api/` 目录下）：
 * ```
 * npm run check:ledger
 * ```
 * 有缺口时退出码为 1（可接进 CI / 部署前置检查）。
 */
import { NestFactory } from '@nestjs/core';

import { loadEnvFile } from '../src/common/config/load-env';
import {
  CommissionEntryType,
  PaymentStatus,
  ReceiptType,
} from '@prisma/client';

import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import {
  checkLedger,
  type LedgerCheckResult,
  type LedgerPaymentIssue,
} from '../src/modules/billing/ledger-check';

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

/**
 * 金额换算成元（保留两位小数）。
 *
 * ⚠️ **库里一律存整数分**，换算只发生在展示层。
 */
function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * 打印支付单维度的差异明细（最多 20 条）。
 *
 * ⚠️ **必须把明细打出来**（订单号 / 支付单 id / 渠道 / 金额 / 状态）：
 * 只给一个计数，运维看到「差异 N 条」也不知道是哪几单、收了多少钱、
 * 走的是哪个渠道 → 这个自检就等于没做。
 */
function printPaymentIssues(label: string, issues: LedgerPaymentIssue[]): void {
  if (issues.length === 0) {
    return;
  }
  console.log(`  ${label}（前 ${Math.min(20, issues.length)} 条）：`);
  for (const issue of issues.slice(0, 20)) {
    // ⚠️ **订阅支付单没有订单号**（它的钱不进订单流水）→ 订单那栏要写清楚，
    // 不能打一个空的订单号让人以为查漏了。
    const orderPart =
      issue.orderNo === null
        ? '订阅支付单（无订单）'
        : `订单 ${issue.orderNo}（订单状态 ${issue.orderStatus}）`;
    console.log(
      `    - ${orderPart}｜支付单 ${issue.paymentId}｜渠道 ${issue.channel}` +
        `｜金额 ${yuan(issue.amount)} 元｜支付单状态 ${issue.paymentStatus}`,
    );
  }
  if (issues.length > 20) {
    console.log(`    …… 另有 ${issues.length - 20} 条未列出`);
  }
}

async function main(): Promise<void> {
  // ⚠️ **必须先加载 `.env`，再 import 应用图**（顺序不能反）。
  //
  //    `AppModule` 的 import 原本是**静态**的 → 被提升到文件顶部 → 整个应用图
  //    （含 `queue.module.ts`）在 `loadEnv()` 之前就被求值。
  //    而 `BullModule.forRoot` 的参数是**模块装饰器求值时**定死的，
  //    那时 `REDIS_URL` 还是 undefined → 落到不带密码的 fallback
  //    → 本机 Redis 开了 `requirepass` → `NOAUTH HELLO ...`。
  //
  //    改成**在 `loadEnvFile()` 之后才加载应用图**后，模块求值被推迟
  //    → `REDIS_URL` 有值 → 连得上。
  loadEnvFile();

  // ⚠️ **必须在这里（而不是文件顶部）加载应用图**：静态 import 会被提升到
  //    文件顶部，`.env` 还没加载就被求值 —— 见上面的说明。
  //
  //    用 `require()` 而不是 `await import()`：本目录的脚本由 ts-node 以
  //    **CommonJS** 运行（package.json 的 `--compiler-options '{"module":"CommonJS"}'`），
  //    而 `await import()` 在 `tsc --noEmit` 的 `nodenext` 解析下要求**带扩展名**
  //    的路径（`../src/app.module.js`）—— 那个路径在 CommonJS 运行期又找不到文件。
  //    `require()` 两边都成立：运行期在调用点求值（位置正确），类型上用
  //    `typeof import(...)` 拿到准确类型（无扩展名也能解析）。
  const { AppModule } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../src/app.module') as typeof import('../src/app.module');

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

      // ⚠️ **必须读 `payments` 表**（审计 P0-3 / P1-3）：
      // 「钱收了但订单没接住」与「同一订单重复收款」这两种资损，
      // **在 `orders` / 流水表里一个都看不出来** —— 前者订单压根没有流水行，
      // 后者两笔支付单都是 `SUCCESS`、看起来一切正常。
      //
      // ⚠️ **只取 `SUCCESS` 与 `NEEDS_REFUND` 两种状态**：判定只用这两种
      // （`PENDING` / `FAILED` / `CLOSED` / `REFUNDED` / `REFUNDING` 都不参与）。
      //
      // ⚠️ **带上订单号与订单状态**：判定「订单有没有接住这笔钱」要订单状态，
      // 而上面的 `orders` 只查了 `paidAt` 非空的订单 —— 超时关闭 / 已取消的订单
      // `paidAt` 是空的，压根不在那个结果里 → 必须在这里关联出来。
      const payments = await prisma.payment.findMany({
        where: {
          status: {
            in: [PaymentStatus.SUCCESS, PaymentStatus.NEEDS_REFUND],
          },
        },
        select: {
          id: true,
          orderId: true,
          channel: true,
          amount: true,
          status: true,
          // ⚠️ **订阅支付单的 `orderId` 为 null** → 这里关联出来就是 null，
          // 判定时按「不参与订单维度的判定」处理。
          order: { select: { orderNo: true, status: true } },
        },
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
        payments: payments.map((p) => ({
          id: p.id,
          orderId: p.orderId,
          orderNo: p.order?.orderNo ?? null,
          orderStatus: p.order?.status ?? null,
          channel: p.channel,
          amount: p.amount,
          status: p.status,
        })),
      });
    });
  } finally {
    // ⚠️ **必须显式关闭应用**：Nest 的连接池（Prisma、Redis）会吊住进程。
    await app.close();
  }

  console.log('账目流水自检');
  console.log('──────────────────────────────');
  console.log(`缺抽佣流水：${result.commissionMissing.length} 单`);
  console.log(`缺抽佣冲回流水：${result.reversalMissing.length} 单`);
  console.log(`缺货款流水：${result.receiptMissing.length} 单`);
  console.log(`缺货款冲回流水：${result.receiptReversalMissing.length} 单`);
  console.log(
    `已退款但无退款时间（抽佣侧冲回永远无法归期）：${result.undatedRefundCount} 单`,
  );
  console.log(
    `已退款但无退款时间（货款侧冲回永远无法归期）：` +
      `${result.undatedReceiptReversalCount} 单`,
  );
  console.log(`钱收了但订单没接住：${result.orphanSuccessPayments.length} 笔`);
  console.log(
    `重复收款（同一订单多笔成功支付）：${result.duplicateSuccessPayments.length} 笔`,
  );
  console.log(`已收款待退款：${result.needsRefundPayments.length} 笔`);
  console.log('──────────────────────────────');

  if (result.hasGap) {
    printMissing('缺抽佣流水', result.commissionMissing);
    printMissing('缺抽佣冲回流水', result.reversalMissing);
    printMissing('缺货款流水', result.receiptMissing);
    printMissing('缺货款冲回流水', result.receiptReversalMissing);
    printPaymentIssues(
      '钱收了但订单没接住（渠道已确认收款，订单没结算这笔钱）',
      result.orphanSuccessPayments,
    );
    printPaymentIssues(
      '重复收款（同一订单被收了多笔）',
      result.duplicateSuccessPayments,
    );
    printPaymentIssues('已收款待退款', result.needsRefundPayments);
    console.log(
      '结论：❌ 账目不完整 —— 流水缺口先跑 `npm run backfill:ledger`；' +
        '支付单缺口见上方明细，需人工处理（退钱 / 核销）',
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
