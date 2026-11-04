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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { PayoutStatus, UserRole } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PayoutService } from '../src/modules/billing/payout.service';

const RETRY_REASON = '批量重试：解密/渠道前置失败，已确认未打款';

function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnv();

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
