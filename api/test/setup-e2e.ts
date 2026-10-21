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

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  // 测试库也要有种子数据：平台超管是登录接口的一个正式用例
  // （scope=PLATFORM 且 tenantId 为 null），缺了它该路径在 e2e 里根本无法执行。
  // seed.ts 自身幂等（先查重再插入），重复执行不会产生重复数据。
  execSync('npx prisma db seed', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
