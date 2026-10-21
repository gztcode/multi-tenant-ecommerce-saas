import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// 单元测试也跑在测试库上，避免污染开发数据。
// setupFiles 在测试框架初始化前执行，早于 PrismaClient 被实例化，
// 所以这里的 DATABASE_URL 改写会生效。
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
