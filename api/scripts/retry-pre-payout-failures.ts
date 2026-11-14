/**
 * 批量重试「确定未打款」的失败出款单（阶段 9）。
 *
 * ⚠️ **只选 `failedBeforePayout=true`**：这个标记意味着渠道从未被调用，
 *    钱确定没打出去。false 的单只能人工核对渠道，脚本绝不碰。
 *
 * ⚠️ **复用 `PayoutService.retry()`**：状态前置条件、事务、留痕、入队
 *    都在服务层，脚本不复制任何一条。
 *
 * ⚠️ **单条失败不中断整批**：一张单的状态可能在扫描后被别人改掉，
 *    整批中断会让其余可重试的单永远等不到处理。
 *
 * 用法（在 api/ 目录下）：
 *   npm run payout:retry-pre-payout
 */
import { NestFactory } from '@nestjs/core';

import { loadEnvFile } from '../src/common/config/load-env';
import { PayoutStatus, UserRole } from '@prisma/client';

import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PayoutService } from '../src/modules/billing/payout.service';

const RETRY_REASON = '批量重试：解密/渠道前置失败，已确认未打款';

async function main(): Promise<void> {
  // ⚠️ **必须先加载 `.env`，再 import 应用图**（顺序不能反）。
  //    静态 import 会被提升到文件顶部 → 应用图（含 `queue.module.ts`）
  //    在 `.env` 加载前就被求值 → `BullModule.forRoot` 定死了没有密码的
  //    Redis 地址 → `NOAUTH HELLO ...`。详见 `common/config/load-env.ts`。
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
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(TenantPrismaService);
    const payouts = app.get(PayoutService);

    const operator = await tenantContext.run(platformScope(), async () =>
      prisma.user.findFirst({
        where: { role: UserRole.PLATFORM_ADMIN },
        select: { id: true, email: true },
      }),
    );
    if (!operator) {
      throw new Error('找不到平台超管账号：批量重试需要操作人写 entry 留痕');
    }

    const targets = await tenantContext.run(platformScope(), async () =>
      prisma.payout.findMany({
        where: {
          status: PayoutStatus.FAILED,
          failedBeforePayout: true,
        },
        select: { id: true, payoutNo: true },
        orderBy: { requestedAt: 'asc' },
      }),
    );

    console.log(`操作人：${operator.email}`);
    console.log(`待重试：${targets.length} 张`);

    let succeeded = 0;
    let failed = 0;

    for (const target of targets) {
      try {
        await tenantContext.run(
          {
            tenantId: null,
            userId: operator.id,
            role: UserRole.PLATFORM_ADMIN,
          },
          () => payouts.retry(target.id, RETRY_REASON),
        );
        succeeded += 1;
        console.log(`  ✓ ${target.payoutNo}`);
      } catch (cause) {
        failed += 1;
        console.error(
          `  ✗ ${target.payoutNo}：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    console.log(`完成：成功 ${succeeded}，失败 ${failed}`);
  } finally {
    await app.close();
  }

  process.exit(0);
}

void main();
