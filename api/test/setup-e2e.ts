import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default function globalSetup(): void {
  // jest 不加载 .env，Prisma CLI 才加载。globalSetup 与测试进程都要自己读。
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      '缺少 DATABASE_URL_TEST 环境变量，e2e 测试无法运行。请在 api/.env 中配置它。',
    );
  }

  // 让后续的 PrismaClient 实例连到测试库而不是开发库
  process.env.DATABASE_URL = url;

  // ⚠️ **队列前缀要与运行环境分开**。
  //
  // BullMQ 的队列在 Redis 里按 `prefix` 分命名空间（默认 `bull`）。测试与
  // 本机跑着的 api 容器连的是**同一个 Redis**，用同一个前缀的话，
  // 容器里的 webhook worker 与超时 worker 会把测试投的任务抢走——
  // 它们连的是开发库， 于是报「订单不存在」，而测试这边的
  // `processedAt` 永远不被置上，表现为**随机的假失败**。
  //
  // 换个前缀就是两套独立的 key 空间，谁也抢不走谁的任务。
  // ⚠️ 必须在 AppModule 被加载**之前**设好：`BullModule.forRoot` 在模块
  // 求值时就读它。
  process.env.BULLMQ_PREFIX = 'bull-e2e';

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  // ⚠️ **每轮跑之前清空测试库**。
  //
  // 之前只 migrate + seed，测试库会跨轮次累积残留数据——上一轮留下的
  // 超期 PENDING 媒体行会让这一轮的「孤儿清理」用例数出不对的数量
  // （cleanupOrphans 是平台级扫描，会把别处留下的也算进去），
  // 表现为**连跑 8 轮有 3 轮各挂一条**，且挂的不是同一条。
  //
  // 清完再 seed，测试面对的永远是「只有种子数据」的干净库。
  truncateAllTables(url);

  // 测试库也要有种子数据：平台超管是登录接口的一个正式用例
  // （scope=PLATFORM 且 tenantId 为 null），缺了它该路径在 e2e 里根本无法执行。
  // seed.ts 自身幂等（先查重再插入），重复执行不会产生重复数据。
  execSync('npx prisma db seed', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}

/**
 * 清空测试库里的所有业务表。
 *
 * 用动态 SQL 而不是手写表名清单：新增表时忘了加进清单，
 * 残留数据就会再次变成偶发失败的来源——那正是这次要根治的问题。
 *
 * `_prisma_migrations` 排除在外：它记着已应用的迁移，清掉它等于
 * 让 Prisma 认为所有迁移都没跑过。
 */
function truncateAllTables(url: string): void {
  const sql = `
    DO $$
    DECLARE
      t text;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> '_prisma_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', t);
      END LOOP;
    END $$;
  `;

  execSync('npx prisma db execute --schema prisma/schema.prisma --stdin', {
    env: { ...process.env, DATABASE_URL: url },
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}
