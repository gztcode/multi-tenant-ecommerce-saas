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
 *    所以脚本做四件事降低后果：① 打印密钥指纹供人工核对 ② 要求显式 `--force` 才写库
 *    ③ 自动建备份表 ④ **迁移前、迁移后各跑一次解密自检**（审计 P2-A3）。
 *
 * ⚠️ **两次自检各自能抓什么、抓不到什么**（别高估）：
 *    · 迁移**前**：库里已有 `encryptionVersion = 1` 的行时，用当前密钥试解一行 ——
 *      解不开说明这把密钥不是系统正在用的那把，**直接中止、一行都不写**。
 *      挡住的是「已有密文用密钥 A、这次又拿密钥 B 加密一批」的混合密钥事故
 *      （5j 的失败注入 F11 实测过这种数据）。
 *    · 迁移**后**：再试解一次，确认刚写进库的密文用当前密钥解得开 ——
 *      「写坏了」当场暴露，不用等到下次重启的启动自检。
 *    · **全新库 + 首次迁移 + 密钥配错** 两次都拦不住：自己加密、自己解密永远自洽。
 *      这一档只能靠人工核对上面打印的密钥指纹，是 5j 设计里就承认的残余风险。
 *
 * ⚠️ **自检直接复用启动自检 `PayoutEncryptionSelfCheck`**，不另写一套判定 ——
 *    两套口径迟早会分叉，脚本说「通过」而容器起不来是最坏的结果。
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
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { maskAccountNo } from '../src/modules/billing/payout-account.service';
import { PayoutCipherService } from '../src/modules/billing/payout-cipher.service';
import { PayoutEncryptionSelfCheck } from '../src/modules/billing/payout-encryption-self-check.service';

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

/**
 * 自检用的客户端。
 *
 * ⚠️ **单独建一个租户扩展过的客户端，不复用上面的裸 `prisma`** ——
 *    这样自检走的是**与容器启动自检完全相同的代码路径**（平台作用域 + 租户扩展）。
 *    走裸客户端也能查到行，但那就不是「同一套口径」了。
 *
 * ⚠️ **惰性创建**：只有真正跑进 `main()` 才建，且必须在 `loadEnv()` 之后
 *    （`PayoutCipherService` 在构造时就要读密钥）。
 */
let selfCheckClient: TenantPrismaService | null = null;
let selfCheckService: PayoutEncryptionSelfCheck | null = null;

function selfCheck(): PayoutEncryptionSelfCheck {
  if (!selfCheckService) {
    selfCheckClient = new TenantPrismaService();
    selfCheckService = new PayoutEncryptionSelfCheck(
      selfCheckClient,
      new PayoutCipherService(),
    );
  }
  return selfCheckService;
}

/**
 * 跑一次启动自检那套解密校验，失败就换成「这个脚本该说的话」再抛。
 *
 * ⚠️ **只换文案，不换判定** —— 判定仍然完全由 `PayoutEncryptionSelfCheck` 决定，
 *    这样脚本与容器的结论永远一致。
 */
async function assertSelfCheckPasses(
  whatFailed: string,
  advice: string,
): Promise<void> {
  try {
    await selfCheck().check();
  } catch (error) {
    throw new Error(
      `${whatFailed}：${error instanceof Error ? error.message : String(error)} ` +
        advice,
    );
  }
}

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

  // ⚠️ **迁移前核对密钥**（审计 P2-A3）：库里已有密文时，用当前密钥试解一行。
  //    解不开说明这把密钥不是系统正在用的那把 —— 直接中止，**一行都不写**。
  //    干跑也跑这一步：密钥配错时干跑就该报出来，而不是等加了 --force 才发现。
  await assertSelfCheckPasses(
    '迁移前密钥核对失败：库里已有的密文用当前密钥解不开',
    '未写任何数据。请把 PAYOUT_ACCOUNT_ENCRYPTION_KEY 换成与 api 进程一致的那把' +
      '（本地 .env 与 infra/docker-compose.yml 必须逐字相同），' +
      '再核对其指纹是否与上面打印的一致。',
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

  // ⚠️ **迁移后立刻自检**（审计 P2-A3）——
  //    不要把「这批密文到底解不解得开」留给下次重启的启动自检：
  //    那时容器会直接起不来，而运维已经不知道该回滚什么了。
  //    这里失败会以非 0 退出码结束，并把备份表名写进错误文案。
  await assertSelfCheckPasses(
    '迁移后自检失败：库里的密文用当前密钥解不开',
    `请立即从备份表 *_backup_${stamp} 恢复，` +
      '并核对 PAYOUT_ACCOUNT_ENCRYPTION_KEY 是否与 api 进程使用的一致。',
  );

  console.log(
    `迁移完成：账户 ${accounts.length} 行，出款单快照 ${payouts.length} 行`,
  );
  console.log('迁移后自检通过：库中已有的密文可以用当前密钥解开。');
}

main()
  .catch((error: unknown) => {
    console.error('迁移失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 自检客户端是惰性创建的：没跑到那一步就是 null
    await selfCheckClient?.onModuleDestroy();
    await prisma.$disconnect();
  });
