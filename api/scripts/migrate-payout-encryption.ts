#!/usr/bin/env ts-node
/**
 * 阶段 5j 的存量数据迁移：把收款账户与出款单快照的明文账号换成密文。
 *
 * 用法（在 `api/` 目录下）：
 * ```
 * npm run migrate:payout-encryption            # 干跑，只报告
 * npm run migrate:payout-encryption -- --force # 真写
 * ```
 *
 * ⚠️ **本地与容器必须用同一把密钥**：
 *    脚本跑在 `npm run` 里，**不在 compose 的 environment 里** → 读不到
 *    compose 注入的 `PAYOUT_ACCOUNT_ENCRYPTION_KEY`，只能自己加载 `.env`。
 *    而密钥不一致是致命的：本地加密的数据，容器里的应用**永远解不开**
 *    （钱打不出去，且原文被覆盖后不可恢复）。
 *    所以 `.env` 里的密钥值必须与 `infra/docker-compose.yml` 里的**逐字一致**。
 *
 * ⚠️ **幂等判定靠版本列（`encryptionVersion = 0`），不靠「能不能解密」** ——
 *    「解不开」有两种完全不同的原因：还没加密、密钥配错。
 *    用启发式判断的话，密钥配错时会把所有行当成「明文」，
 *    **用错密钥加密并覆盖原文，而原文被覆盖后不可恢复**。
 *    版本号是写在数据里的事实，不依赖密钥。
 *
 * ⚠️ **首次迁移时密钥配错仍无解** —— 库里没有可参照的密文。
 *    所以脚本做三件事降低后果：① 自动建备份表 ② 打印密钥指纹供人工核对
 *    ③ 要求显式 `--force` 才写库。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

import {
  deriveFieldKey,
  decryptField,
  encryptField,
} from '../src/common/crypto/field-cipher';
import { maskAccountNo } from '../src/modules/billing/payout-account.service';

/**
 * 加载 `.env`。
 *
 * ⚠️ **用 Node 内置的 `process.loadEnvFile`**（Node 20.12+）而不是 `dotenv`：
 *    仓库里没有 `dotenv` 依赖，而 `process.loadEnvFile` 是内置的。
 *    文件不存在就跳过 —— 生产环境用真环境变量，不该因为没有 `.env` 就崩。
 * ⚠️ **是同步的** —— 必须放在读 `process.env` 之前。
 */
function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

const prisma = new PrismaClient();
const force = process.argv.includes('--force');

async function main(): Promise<void> {
  loadEnv();

  const secret = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY ?? '';
  if (secret.length < 32) {
    throw new Error(
      'PAYOUT_ACCOUNT_ENCRYPTION_KEY 未配置或长度不足 32 个字符 —— ' +
        '请先确认密钥再跑迁移。',
    );
  }
  const key = deriveFieldKey(secret);
  // ⚠️ **打印指纹供人工核对**：核对不上就别加 --force。
  console.log(
    `密钥指纹：${createHash('sha256').update(key).digest('hex').slice(0, 8)}`,
  );

  const accounts = await prisma.merchantPayoutAccount.findMany({
    where: { encryptionVersion: 0 },
  });
  const payouts = await prisma.payout.findMany({
    where: {
      snapshotEncryptionVersion: 0,
      snapshotAccountNoCipher: { not: null },
    },
  });

  console.log(
    `待迁移：账户 ${accounts.length} 行，出款单快照 ${payouts.length} 行`,
  );
  if (accounts.length === 0 && payouts.length === 0) {
    console.log('无需迁移。');
    return;
  }

  if (!force) {
    console.log('干跑模式。加 --force 才真正写库。');
    console.log(
      '建议：先备份数据库，再执行 `npm run migrate:payout-encryption -- --force`。',
    );
    return;
  }

  // ⚠️ **自动建备份表** —— 迁移出问题可从备份恢复。
  //    表名里的时间戳由脚本自己算出（`new Date()`），**不含任何外部输入**，
  //    所以下面用 `$executeRawUnsafe` 拼表名是安全的。
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "merchant_payout_accounts_backup_${stamp}" AS SELECT * FROM "merchant_payout_accounts"`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "payouts_backup_${stamp}" AS SELECT * FROM "payouts"`,
  );
  console.log(`已建备份表：*_backup_${stamp}`);

  await prisma.$transaction(async (tx) => {
    for (const account of accounts) {
      // ⚠️ **此刻 `accountNoCipher` 列里装的是明文** ——
      //    schema 改名后数据还在原处，只是列名变了。
      const plain = account.accountNoCipher;
      // ⚠️ **往返自检**：加密 → 解密 → 比对原文。
      //    自检不过就抛错 → 整个事务回滚 → 一行都不会被改坏。
      const cipher = encryptField(plain, key);
      if (decryptField(cipher, key) !== plain) {
        throw new Error('加密往返自检失败，已中止迁移');
      }
      await tx.merchantPayoutAccount.update({
        where: { id: account.id },
        data: {
          accountNoCipher: cipher,
          maskedAccountNo: maskAccountNo(plain),
          encryptionVersion: 1,
        },
      });
    }
    for (const payout of payouts) {
      if (!payout.snapshotAccountNoCipher) continue;
      const plain = payout.snapshotAccountNoCipher;
      const cipher = encryptField(plain, key);
      if (decryptField(cipher, key) !== plain) {
        throw new Error('加密往返自检失败，已中止迁移');
      }
      await tx.payout.update({
        where: { id: payout.id },
        data: {
          snapshotAccountNoCipher: cipher,
          snapshotMaskedAccountNo: maskAccountNo(plain),
          snapshotEncryptionVersion: 1,
        },
      });
    }
  });

  console.log(
    `迁移完成：账户 ${accounts.length} 行，出款单快照 ${payouts.length} 行`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('迁移失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
