/**
 * 把待应用的迁移跑到**测试库**上。
 *
 * 单元测试也跑在测试库（见 setup-unit-env.ts），但它不像 e2e 的
 * globalSetup（setup-e2e.ts）那样自己跑迁移——缺了这一步，
 * 新环境上第一次 `npm test` 会以「表不存在」失败，而报错信息
 * 指向 Prisma 的 P2021，很难让人联想到「迁移没跑」。
 *
 * 在 `npm test` / `npm run test:cov` 前跑一次，两个入口就都自洽了。
 * e2e 不受影响——setup-e2e.ts 已经在做同样的事。
 *
 * 用 .mjs 而不是 .ts：省掉 ts-node 在 npm script 里的引号转义问题
 * （`--compiler-options {"module":"CommonJS"}` 会被 shell 剥掉引号）。
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    '缺少 DATABASE_URL_TEST 环境变量，单元测试无法运行。请在 api/.env 中配置它。',
  );
}

execSync('npx prisma migrate deploy', {
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
});
